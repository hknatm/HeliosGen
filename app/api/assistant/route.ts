export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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

/** Keep reverse proxies from treating a quiet model stream as an idle request. */
function streamingResponse(body: ReadableStream<Uint8Array> | null): Response {
  if (!body) return new Response(null, { status: 502 });
  const reader = body.getReader();
  const keepalive = new TextEncoder().encode(": keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (!closed) controller.enqueue(keepalive);
      }, 15_000);
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          closed = true;
          if (timer) clearInterval(timer);
          controller.close();
        } catch (error) {
          closed = true;
          if (timer) clearInterval(timer);
          controller.error(error);
        }
      })();
    },
    async cancel(reason) {
      closed = true;
      if (timer) clearInterval(timer);
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Models that use OpenAI-compatible chat/completions endpoint
const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  "gemini-3-flash":  "https://api.kie.ai/gemini-3-flash/v1/chat/completions",
  "gemini-3.1-pro":  "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions",
  "gpt-5-2":         "https://api.kie.ai/gpt-5-2/v1/chat/completions",
};

const AZURE_API_VERSION = "2024-04-01-preview";

interface AssistantBody {
  messages?: Message[];
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureModelName?: string;
  customProvider?: { baseUrl?: string; apiKey?: string; vision?: boolean };
  references?: ReferenceImage[];
}

function sseError(message: string): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", error: { message } })}\n\n`);
}

/**
 * Requests with reference images do slow work before the provider answers (asset
 * preparation, temporary uploads, time to first byte). Reverse proxies answer 504 when
 * nothing is sent for that long, so open the event stream immediately, keep it alive, and
 * report any failure as an in-stream error event. Text-only requests keep plain HTTP errors.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as AssistantBody;
  if (!Array.isArray(body.references) || body.references.length === 0) return handle(req, body);

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => { closed = true; if (timer) clearInterval(timer); };
      timer = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 10_000);
      controller.enqueue(encoder.encode(": preparing\n\n"));
      void (async () => {
        try {
          const response = await handle(req, body);
          const isStream = response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream");
          if (!isStream || !response.body) {
            let message = "The assistant request failed.";
            try { const j = JSON.parse(await response.text()); message = j.error ?? message; } catch { /* keep default */ }
            controller.enqueue(sseError(typeof message === "string" ? message : JSON.stringify(message)));
          } else {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!closed) controller.enqueue(value);
            }
          }
        } catch (error) {
          if (!closed) controller.enqueue(sseError(error instanceof Error ? error.message : "The assistant request failed."));
        } finally {
          stop();
          try { controller.close(); } catch { /* already closed */ }
        }
      })();
    },
    cancel() { closed = true; if (timer) clearInterval(timer); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handle(req: NextRequest, body: AssistantBody): Promise<Response> {
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
  const customVision = isCustomModelId(model) && body.customProvider?.vision === true;
  if (references.length > 0 && model !== MULTIMODAL_AGENT_MODEL && !customVision) {
    return new Response(JSON.stringify({ error: `Connected reference images require ${MULTIMODAL_AGENT_MODEL} or a vision-enabled custom model.` }), {
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

  // Resolve durable provider-access URLs before choosing the upstream adapter.
  // Kie additionally requires its temporary upload service; custom providers
  // receive the signed/public durable URLs through standard image_url parts.
  let durableReferenceUrls: string[] = [];
  if (references.length > 0) {
    // Reference nodes already persist app-owned assets. Do not let this route
    // mirror arbitrary caller-supplied URLs, which would expand its SSRF surface.
    const appOrigin = req.nextUrl.origin;
    const r2Origin = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
    const appOwned = references.every((reference) => {
      try {
        const resolved = new URL(reference.url, appOrigin);
        const relativeGenerated = reference.url.startsWith("/generated/");
        const sameOriginGenerated = resolved.origin === appOrigin && resolved.pathname.startsWith("/generated/");
        const r2Asset = !!r2Origin && (reference.url === r2Origin || reference.url.startsWith(`${r2Origin}/`));
        return relativeGenerated || sameOriginGenerated || r2Asset;
      } catch {
        return false;
      }
    });
    if (!appOwned) {
      return new Response(JSON.stringify({ error: "Reference images must be uploaded to HeliosGen before AI analysis." }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    try {
      durableReferenceUrls = await Promise.all(references.map((reference) => ensureR2(reference.url, "references")));
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Reference images could not be prepared." }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
    if (isCustomModelId(model) && durableReferenceUrls.some((url) => !/^https:\/\//i.test(url))) {
      return new Response(JSON.stringify({ error: "Custom vision models require CALLBACK_BASE_URL so reference images have public HTTPS URLs." }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
  }

  const withReferenceContent = (sourceMessages: Message[], urls: string[]): Message[] => {
    if (!references.length) return sourceMessages;
    const promptText = sourceMessages.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n\n");
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: promptText }];
    references.forEach((reference, index) => {
      content.push({
        type: "text",
        text: `Reference ${index + 1} — ${reference.name || `Image ${index + 1}`}\nUsage: ${reference.usageNote || "Use only as directed by the request."}`,
      });
      content.push({ type: "image_url", image_url: { url: urls[index] } });
    });
    const userIndex = sourceMessages.findIndex((message) => message.role === "user");
    const next = sourceMessages.filter((message) => message.role !== "user");
    next.splice(userIndex < 0 ? next.length : Math.min(userIndex, next.length), 0, { role: "user", content });
    return next;
  };

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
      body: JSON.stringify({ model: customModelName(model), messages: withReferenceContent(messages, durableReferenceUrls), stream: true }),
      signal: req.signal,
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: await upstream.text() }), {
        status: upstream.status, headers: { "Content-Type": "application/json" },
      });
    }
    return streamingResponse(upstream.body);
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
    return streamingResponse(upstream.body);
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
    try {
      const providerUrls = GUEST_MODE ? await uploadReferenceImagesToKie(durableReferenceUrls, apiKey) : durableReferenceUrls;
      messages = withReferenceContent(messages, providerUrls);
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Reference images could not be prepared." }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
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

  return streamingResponse(upstream.body);
}
