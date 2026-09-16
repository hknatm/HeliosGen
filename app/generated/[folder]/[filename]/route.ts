import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { GUEST_MODE } from "@/lib/guestMode";
import { generatedAssetContentType, resolveGeneratedAssetPath } from "@/lib/localGeneratedAsset";

export const dynamic = "force-dynamic";

type GeneratedAssetContext = {
  params: Promise<{ folder: string; filename: string }>;
};

type ByteRange = { start: number; end: number };

function parseByteRange(value: string | null, size: number): ByteRange | null | "invalid" {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size === 0) return "invalid";

  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveGeneratedAsset(
  request: Request,
  context: GeneratedAssetContext,
  headOnly: boolean,
) {
  if (!GUEST_MODE) return new NextResponse("Not found", { status: 404 });

  const { folder, filename } = await context.params;
  const filePath = resolveGeneratedAssetPath(folder, filename);
  if (!filePath) return new NextResponse("Not found", { status: 404 });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new NextResponse("Not found", { status: 404 });

    const range = parseByteRange(request.headers.get("range"), info.size);
    if (range === "invalid") {
      return new NextResponse(null, {
        status: 416,
        headers: { "Cache-Control": "private, no-store", "Content-Range": `bytes */${info.size}` },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);
    const contentLength = info.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Length": String(contentLength),
      "Content-Type": generatedAssetContentType(filename),
      "X-Content-Type-Options": "nosniff",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    const status = range ? 206 : 200;
    if (headOnly || info.size === 0) return new NextResponse(null, { status, headers });

    const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
    return new NextResponse(body, { status, headers });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") console.error("[generated-asset] read failed:", error);
    return new NextResponse("Not found", { status: 404 });
  }
}

export async function GET(request: Request, context: GeneratedAssetContext) {
  return serveGeneratedAsset(request, context, false);
}

export async function HEAD(request: Request, context: GeneratedAssetContext) {
  return serveGeneratedAsset(request, context, true);
}
