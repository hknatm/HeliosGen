import { NextRequest, NextResponse } from "next/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";
import {
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_MAX_AGE_SECONDS,
  createLocalSession,
  localAuthConfigured,
  safeNextPath,
  verifyLocalPassword,
} from "@/lib/localAuth";
import { clearLoginFailures, loginRateLimit, recordLoginFailure } from "@/lib/localLoginRateLimit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!IS_LOCAL_MODE) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!localAuthConfigured()) {
    return NextResponse.json({ error: "Local authentication is not configured on the server." }, { status: 503 });
  }

  const limit = loginRateLimit(request);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: { password?: unknown; next?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!await verifyLocalPassword(password)) {
    const retryAfter = recordLoginFailure(request);
    return NextResponse.json(
      { error: retryAfter ? "Too many attempts. Try again later." : "Invalid password." },
      { status: retryAfter ? 429 : 401, headers: { "Cache-Control": "no-store", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
    );
  }

  clearLoginFailures(request);
  const response = NextResponse.json(
    { ok: true, redirectTo: safeNextPath(body.next) },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(LOCAL_SESSION_COOKIE, createLocalSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: LOCAL_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
