/**
 * GET /api/download?url=<encoded-url>&filename=<name>
 *
 * Server-side proxy that fetches the asset and returns it with
 * Content-Disposition: attachment so the browser saves it to disk.
 * Only allowed origins are proxied.
 */
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { basename } from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE } from "@/lib/guestMode";
import { generatedAssetContentType, generatedAssetPathFromUrl } from "@/lib/localGeneratedAsset";

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

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const filename = req.nextUrl.searchParams.get("filename") ?? "download";

  if (!url) return new NextResponse("Missing url", { status: 400 });
  if (!isAllowed(url, req.nextUrl.origin)) return new NextResponse("Forbidden", { status: 403 });

  const localPath = localGeneratedPath(url, req.nextUrl.origin);
  const safeFilename = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "download";
  if (localPath) {
    const filePath = generatedAssetPathFromUrl(localPath);
    if (!filePath) return new NextResponse("Not found", { status: 404 });
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return new NextResponse("Not found", { status: 404 });
      const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
      return new NextResponse(body, {
        headers: {
          "Content-Type": generatedAssetContentType(basename(filePath)),
          "Content-Length": String(info.size),
          "Content-Disposition": `attachment; filename="${safeFilename}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") console.error("[download] local file read failed:", error);
      return new NextResponse("Not found", { status: 404 });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  } catch {
    return new NextResponse("Fetch failed", { status: 502 });
  }

  if (!upstream.ok) {
    return new NextResponse("Upstream error", { status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-store",
    },
  });
}
