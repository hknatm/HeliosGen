import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";
import { LOCAL_SESSION_COOKIE, localAuthConfigured, localSessionExpiresAt } from "@/lib/localAuth";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (!IS_LOCAL_MODE) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const configured = localAuthConfigured();
  const expiresAt = configured
    ? localSessionExpiresAt(request.cookies.get(LOCAL_SESSION_COOKIE)?.value)
    : null;
  return NextResponse.json(
    { authenticated: expiresAt !== null, expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
