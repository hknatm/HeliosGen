import { access, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import { lookupAssetHash, storeAssetHash } from "./db";
import { stripMetadata } from "../mediaMetadata";
import { providerAssetUrl } from "../localAuth";
import { fetchRemoteMedia } from "../remoteMedia";
import { generatedAssetPathFromUrl } from "../localGeneratedAsset";

const GENERATED_DIR = join(process.cwd(), "public", "generated");

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function ext(contentType: string): string {
  if (contentType.includes("mp4"))  return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("png"))  return "png";
  if (contentType.includes("gif"))  return "gif";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("woff2")) return "woff2";
  if (contentType.includes("woff")) return "woff";
  if (contentType.includes("otf")) return "otf";
  if (contentType.includes("ttf")) return "ttf";
  return "jpg";
}

export async function uploadBuffer(
  buffer: Buffer,
  contentType: string,
  folder: string,
  options: { deduplicate?: boolean } = {},
): Promise<string> {
  buffer = await stripMetadata(buffer, contentType);
  const deduplicate = options.deduplicate !== false;
  const hash = hashBuffer(buffer);
  if (deduplicate) {
    const cached = lookupAssetHash(hash);
    const cachedPath = cached ? generatedAssetPathFromUrl(cached) : null;
    if (cachedPath) {
      try {
        await access(cachedPath);
        return cached!;
      } catch {
        console.warn("[local/asset-cache] Ignoring missing cached file:", cached);
      }
    }
  }

  await mkdir(join(GENERATED_DIR, folder), { recursive: true });
  const filename = `${randomUUID()}.${ext(contentType)}`;
  await writeFile(join(GENERATED_DIR, folder, filename), buffer);
  const url = `/generated/${folder}/${filename}`;

  if (deduplicate) storeAssetHash(hash, url, contentType, buffer.byteLength);
  return url;
}

export async function mirrorToStorage(url: string, folder: string): Promise<string> {
  const { buffer, contentType } = await fetchRemoteMedia(url, {
    maxBytes: folder === "videos" ? 200 * 1024 * 1024 : 30 * 1024 * 1024,
    totalTimeoutMs: folder === "videos" ? 180_000 : 120_000,
  });
  return uploadBuffer(buffer, contentType, folder);
}

export async function uploadDataUrl(dataUrl: string, folder: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("Not a valid data URL");
  return uploadBuffer(Buffer.from(m[2], "base64"), m[1], folder);
}

/** Kie.ai fetches this over the internet, so a bare "/generated/..." path
 *  won't resolve — prefix it with the public callback URL only for the
 *  outbound provider request. Stored results always remain same-origin paths. */
function toPublicUrl(path: string, base = process.env.CALLBACK_BASE_URL?.replace(/\/$/, "")): string {
  if (!base || !path.startsWith("/")) return path;
  return providerAssetUrl(path, base);
}

export async function ensureStorage(url: string, folder: string): Promise<string> {
  const base = process.env.CALLBACK_BASE_URL?.replace(/\/$/, "");
  const stored = url.startsWith("data:")
    ? await uploadDataUrl(url, folder)
    : url.startsWith("/generated/")
    ? url
    : base && url.startsWith(`${base}/generated/`)
    ? new URL(url).pathname
    : await mirrorToStorage(url, folder);

  return toPublicUrl(stored, base);
}
