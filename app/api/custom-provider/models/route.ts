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

    let payload: { data?: Array<{ id?: unknown }> };
    try {
      payload = JSON.parse(raw) as { data?: Array<{ id?: unknown }> };
    } catch {
      return NextResponse.json({ error: "Provider returned invalid JSON from /models." }, { status: 502 });
    }

    const models = Array.from(new Set(
      (payload.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
    )).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach custom provider.";
    return NextResponse.json({ error: `Unable to load models: ${message}` }, { status: 502 });
  }
}
