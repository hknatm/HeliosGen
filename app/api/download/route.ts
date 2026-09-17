/**
 * GET /api/download?url=<encoded-url>&filename=<name>
 *
 * Server-side proxy that fetches the asset and returns it with
 * Content-Disposition: attachment so the browser saves it to disk.
 * Only allowed origins are proxied.
 */
import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE } from "@/lib/guestMode";

const ALLOWED_ORIGINS = [
  process.env.R2_PUBLIC_URL ?? "",
  "https://cdn.kie.ai",
  "https://api.kie.ai",
  "https://replicate.delivery",
  "https://pbxt.replicate.delivery",
].filter(Boolean).map((o) => o.replace(/\/$/, ""));

function localGeneratedPath(url: string, requestOrigin: string): string | null {
  if (!GUEST_MODE) return null;
  try {
    const resolved = new URL(url, requestOrigin);
    if (resolved.origin !== requestOrigin || !resolved.pathname.startsWith("/generated/")) return null;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

function isAllowed(url: string, requestOrigin: string): boolean {
  if (localGeneratedPath(url, requestOrigin)) return true;
  return ALLOWED_ORIGINS.some((origin) => url === origin || url.startsWith(`${origin}/`));
}

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const filename = req.nextUrl.searchParams.get("filename") ?? "download";

  if (!url) return new NextResponse("Missing url", { status: 400 });
  if (!isAllowed(url, req.nextUrl.origin)) return new NextResponse("Forbidden", { status: 403 });

  const localPath = localGeneratedPath(url, req.nextUrl.origin);
  const fetchUrl = localPath ? new URL(localPath, req.nextUrl.origin).toString() : url;
  const providerToken = req.cookies.get("helios_owner_session")?.value;
  const headers = localPath && providerToken
    ? { Cookie: `helios_owner_session=${encodeURIComponent(providerToken)}` }
    : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(180_000) });
  } catch {
    return new NextResponse("Fetch failed", { status: 502 });
  }

  if (!upstream.ok) {
    return new NextResponse("Upstream error", { status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const safeFilename = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "download";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-store",
    },
  });
}
