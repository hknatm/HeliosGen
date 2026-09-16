export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { getAzureToken } from "@/lib/getAzureKey";
import { customModelName, customProviderHeaders, customProviderUrl, isCustomModelId } from "@/lib/customProvider";
import { ensureR2 } from "@/lib/r2";
import { GUEST_MODE } from "@/lib/guestMode";
import { uploadReferenceImagesToKie } from "@/lib/kieReferenceUpload";
import { MAX_AGENT_REFERENCES, MULTIMODAL_AGENT_MODEL, type ReferenceImage } from "@/lib/referenceBundle";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image_url"; image_url: { url: string } };
type MessageContent = string | Array<TextContent | ImageContent>;

interface Message {
  role: "user" | "assistant" | "system";
  content: MessageContent;
}

function textContent(content: MessageContent): string {
  return typeof content === "string"
    ? content
    : content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n\n");
}

// Models that use OpenAI-compatible chat/completions endpoint
const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  "gemini-3-flash":  "https://api.kie.ai/gemini-3-flash/v1/chat/completions",
  "gemini-3.1-pro":  "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions",
  "gpt-5-2":         "https://api.kie.ai/gpt-5-2/v1/chat/completions",
};

const AZURE_API_VERSION = "2024-04-01-preview";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    messages?: Message[];
    prompt?: string;
    systemPrompt?: string;
    model?: string;
    azureEndpoint?: string;
    azureDeployment?: string;
    azureModelName?: string;
    customProvider?: { baseUrl?: string; apiKey?: string };
    references?: ReferenceImage[];
  };

  const model = body.model ?? "claude-sonnet-4-6";
  if (Array.isArray(body.references) && body.references.length > MAX_AGENT_REFERENCES) {
    return new Response(JSON.stringify({ error: `A maximum of ${MAX_AGENT_REFERENCES} reference images is supported.` }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  const references = Array.isArray(body.references)
    ? body.references
      .filter((reference) => reference && typeof reference.url === "string" && reference.url.trim())
      .map((reference) => ({
        ...reference,
        name: typeof reference.name === "string" ? reference.name.trim().slice(0, 80) : "",
        usageNote: typeof reference.usageNote === "string" ? reference.usageNote.trim().slice(0, 500) : "",
        url: reference.url.trim(),
      }))
    : [];
  if (Array.isArray(body.references) && references.length !== body.references.length) {
    return new Response(JSON.stringify({ error: "Every reference image must include a valid URL." }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  if (references.length > 0 && model !== MULTIMODAL_AGENT_MODEL) {
    return new Response(JSON.stringify({ error: `Connected reference images require ${MULTIMODAL_AGENT_MODEL}.` }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  let messages: Message[];

  if (body.messages && body.messages.length > 0) {
    messages = body.messages;
  } else if (body.prompt?.trim()) {
    messages = [];
    if (body.systemPrompt?.trim()) {
      // Send the configured system prompt as a true role:"system" message so
      // it is honoured as system policy by OpenAI-compatible and Anthropic
      // endpoints alike — never smuggled in as a user turn.
      messages.push({ role: "system", content: body.systemPrompt.trim() });
    }
    messages.push({ role: "user", content: body.prompt.trim() });
  } else {
    return new Response(JSON.stringify({ error: "messages or prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Custom OpenAI-compatible provider ─────────────────────────────────────
  if (isCustomModelId(model)) {
    let url: string;
    try {
      url = customProviderUrl(body.customProvider?.baseUrl ?? "", "/chat/completions");
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid custom provider URL." }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const upstream = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: customProviderHeaders(body.customProvider?.apiKey),
      body: JSON.stringify({ model: customModelName(model), messages, stream: true }),
      signal: req.signal,
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: await upstream.text() }), {
        status: upstream.status, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive", "X-Accel-Buffering": "no",
      },
    });
  }

  // ── Azure Auto (model-router) ──────────────────────────────────────────────
  if (model === "azure-auto") {
    const azureKey = await getAzureToken(req);
    if (!azureKey) {
      return new Response(
        JSON.stringify({ error: "No Azure API key configured. Add one in Settings." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    // Normalise: strip trailing slashes and any /openai suffix users may have pasted
    const endpoint = (body.azureEndpoint ?? "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/openai$/i, "");
    const deployment  = (body.azureDeployment || "auto-model").trim();
    const modelName   = (body.azureModelName  || "model-router").trim();
    if (!endpoint) {
      return new Response(
        JSON.stringify({ error: "Azure base URL not configured. Add it in Settings → API Keys." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
    console.log("[azure-auto] POST", url.replace(/api-version=.*/, "api-version=…"));
    const upstream = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "api-key": azureKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true,
        max_tokens: 8192,
        temperature: 0.7,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
      }),
      signal: req.signal,
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      // Extract human-readable message from Azure error envelope
      let errorMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        errorMsg = parsed?.error?.message ?? parsed?.message ?? errText;
      } catch { /* use raw text */ }
      console.error("[azure-auto] upstream error", upstream.status, errorMsg);
      return new Response(
        JSON.stringify({ error: `Azure ${upstream.status}: ${errorMsg}` }),
        { status: upstream.status, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache, no-transform",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ── Kie.ai models ─────────────────────────────────────────────────────────
  const apiKey = await getKieToken(req);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "No Kie.ai API key configured. Add one in Settings." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const openaiEndpoint = OPENAI_COMPAT_ENDPOINTS[model];

  if (references.length > 0) {
    let durableUrls: string[];
    let providerUrls: string[];
    try {
      durableUrls = await Promise.all(references.map((reference) => ensureR2(reference.url, "references")));
      providerUrls = GUEST_MODE ? await uploadReferenceImagesToKie(durableUrls, apiKey) : durableUrls;
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Reference images could not be prepared." }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
    const promptText = messages.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n\n");
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: promptText }];
    references.forEach((reference, index) => {
      content.push({
        type: "text",
        text: `Reference ${index + 1} — ${reference.name || `Image ${index + 1}`}\nUsage: ${reference.usageNote || "Use only as directed by the request."}`,
      });
      content.push({ type: "image_url", image_url: { url: providerUrls[index] } });
    });
    const userIndex = messages.findIndex((message) => message.role === "user");
    messages = messages.filter((message) => message.role !== "user");
    messages.splice(userIndex < 0 ? messages.length : Math.min(userIndex, messages.length), 0, { role: "user", content });
  }

  const claudeSystemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const claudeMessages = messages.filter((message) => message.role !== "system");

  const upstream = openaiEndpoint
    ? await fetch(openaiEndpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages.map((message) => ({
            role: message.role,
            content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
          })),
          stream: true,
        }),
        signal: req.signal,
      })
    : await fetch("https://api.kie.ai/claude/v1/messages", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...(claudeSystemPrompt ? { system: claudeSystemPrompt } : {}),
          messages: claudeMessages,
          stream: true,
          thinkingFlag: true,
          max_tokens: 4096,
        }),
        signal: req.signal,
      });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({ error: errText }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type":       "text/event-stream",
      "Cache-Control":      "no-cache, no-transform",
      "Connection":         "keep-alive",
      "X-Accel-Buffering":  "no",
    },
  });
}
