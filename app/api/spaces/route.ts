import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

/**
 * Local-only spaces persistence backed by the shared SQLite database.
 * In cloud mode these routes are intentionally unavailable (501) — cloud
 * keeps its existing direct Supabase paths in useSpaceSync.
 */

export async function GET() {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const { getSpaces } = await import("@/lib/guest/db");
  return NextResponse.json({ spaces: getSpaces() });
}

export async function DELETE(req: NextRequest) {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { deleteSpace } = await import("@/lib/guest/db");
  deleteSpace(id);
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  if (!IS_LOCAL_MODE) {
    return NextResponse.json({ error: "Not available in cloud mode" }, { status: 501 });
  }
  const body = await req.json().catch(() => null) as { spaces?: unknown } | null;
  const spaces = body?.spaces;
  if (!Array.isArray(spaces)) {
    return NextResponse.json({ error: "spaces must be an array" }, { status: 400 });
  }
  const { normalizeSpace, upsertSpaces } = await import("@/lib/guest/db");
  const normalized = spaces.map(normalizeSpace).filter((space): space is NonNullable<typeof space> => space !== null);
  if (spaces.length > 0 && normalized.length === 0) {
    return NextResponse.json({ error: "No valid spaces supplied" }, { status: 400 });
  }
  // This endpoint is merge-only. Deleting records absent from a whole-client
  // snapshot lets a stale browser origin erase workflows created elsewhere.
  // Workflow deletes should use an explicit, per-space endpoint when added.
  upsertSpaces(normalized);
  return NextResponse.json({ ok: true });
}
