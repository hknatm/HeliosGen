import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

/**
 * Local-only chat session persistence backed by the shared SQLite database.
 * In cloud mode these routes are intentionally unavailable (501) — cloud
 * keeps its existing direct Supabase paths in chatSessionStore.
 */

export async function GET() {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const { getChatSessions } = await import("@/lib/guest/db");
  return NextResponse.json({ sessions: getChatSessions() });
}

export async function POST(req: NextRequest) {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const body = await req.json().catch(() => null) as { session?: unknown } | null;
  const session = body?.session;
  if (!session || typeof session !== "object") {
    return NextResponse.json({ error: "session is required" }, { status: 400 });
  }
  const { upsertChatSession, normalizeChatSession } = await import("@/lib/guest/db");
  const normalized = normalizeChatSession(session);
  if (!normalized) {
    return NextResponse.json({ error: "Invalid session payload" }, { status: 400 });
  }
  upsertChatSession(normalized);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const { deleteChatSession } = await import("@/lib/guest/db");
  deleteChatSession(id);
  return NextResponse.json({ ok: true });
}
