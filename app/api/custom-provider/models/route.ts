import { NextRequest, NextResponse } from "next/server";
import { customProviderHeaders, customProviderUrl } from "@/lib/customProvider";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { baseUrl?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  let modelsUrl: string;
  try {
    modelsUrl = customProviderUrl(body.baseUrl ?? "", "/models");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid custom provider URL." },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(modelsUrl, {
      method: "GET",
      headers: customProviderHeaders(body.apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Provider returned ${upstream.status}: ${raw.slice(0, 500) || "Unknown error"}` },
        { status: 502 },
      );
    }

    let payload: {
      data?: Array<{
        id?: unknown;
        vision?: unknown;
        capabilities?: unknown;
        input_modalities?: unknown;
        architecture?: unknown;
      }>;
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return NextResponse.json({ error: "Provider returned invalid JSON from /models." }, { status: 502 });
    }

    const models = Array.from(new Map(
      (payload.data ?? [])
        .map((model) => {
          const id = typeof model.id === "string" ? model.id.trim() : "";
          if (!id) return null;
          const capabilities = model.capabilities && typeof model.capabilities === "object"
            ? model.capabilities as Record<string, unknown>
            : undefined;
          const architecture = model.architecture && typeof model.architecture === "object"
            ? model.architecture as Record<string, unknown>
            : undefined;
          const modalities = Array.isArray(model.input_modalities)
            ? model.input_modalities
            : Array.isArray(capabilities?.input_modalities)
              ? capabilities.input_modalities
              : Array.isArray(capabilities?.modalities)
                ? capabilities.modalities
                : Array.isArray(architecture?.input_modalities)
                  ? architecture.input_modalities
                  : [];
          const vision = model.vision === true || capabilities?.vision === true || capabilities?.supports_vision === true ||
            modalities.some((item) => typeof item === "string" && /image|vision/i.test(item));
          return [id, { id, ...(vision ? { vision: true } : {}) }] as const;
        })
        .filter((entry): entry is readonly [string, { id: string; vision?: boolean }] => entry !== null),
    ).values()).sort((a, b) => a.id.localeCompare(b.id));

    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach custom provider.";
    return NextResponse.json({ error: `Unable to load models: ${message}` }, { status: 502 });
  }
}
