import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

/**
 * Local-only generic non-secret app settings (key/value JSON) backed by the
 * shared SQLite database. Used to share ordinary cross-origin settings
 * (custom provider config/models, system prompts, preferred text model,
 * model providers, workflow UI prefs) between localhost and ngrok origins.
 * Secrets (e.g. the Kie API key) are intentionally NOT stored here.
 */

export async function GET() {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const { getAppSettings } = await import("@/lib/guest/db");
  return NextResponse.json({ settings: getAppSettings() });
}

export async function PUT(req: NextRequest) {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const body = await req.json().catch(() => null) as { settings?: unknown } | null;
  const settings = body?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
  }
  const { setAppSettings } = await import("@/lib/guest/db");
  setAppSettings(settings as Record<string, unknown>);
  return NextResponse.json({ ok: true });
}
