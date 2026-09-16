import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { hashBuffer, lookupAssetHash, storeAssetHash } from "./assetCache";
import { GUEST_MODE } from "./guestMode";
import { stripMetadata } from "./mediaMetadata";
import * as localStore from "./guest/localStorage";
import { fetchRemoteMedia } from "./remoteMedia";

let _s3: S3Client | null = null;

function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _s3;
}

function cdnUrl(key: string): string {
  return `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
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

/** Upload a Buffer to R2 (or local disk in guest mode) and return the public URL. */
export async function uploadBuffer(
  buffer: Buffer,
  contentType: string,
  folder: string,
  options: { deduplicate?: boolean } = {},
): Promise<string> {
  if (GUEST_MODE) return localStore.uploadBuffer(buffer, contentType, folder, options);
  buffer = await stripMetadata(buffer, contentType);
  const deduplicate = options.deduplicate !== false;
  const hash = hashBuffer(buffer);
  if (deduplicate) {
    const cached = await lookupAssetHash(hash);
    if (cached) return cached;
  }

  const key = `${folder}/${randomUUID()}.${ext(contentType)}`;
  const url = cdnUrl(key);

  await getS3().send(
    new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME!,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    })
  );

  // Store hash and wait for it
  if (deduplicate) {
    try {
      await storeAssetHash(hash, url, contentType, buffer.byteLength);
    } catch (err) {
      console.error("[r2] Failed to store asset hash:", err);
    }
  }

  return url;
}

/** Fetch a remote URL, upload to R2 (or local disk in guest mode), return URL. */
export async function mirrorToR2(sourceUrl: string, folder: string): Promise<string> {
  if (GUEST_MODE) return localStore.mirrorToStorage(sourceUrl, folder);
  const { buffer, contentType } = await fetchRemoteMedia(sourceUrl, {
    maxBytes: folder === "videos" ? 200 * 1024 * 1024 : 30 * 1024 * 1024,
    totalTimeoutMs: folder === "videos" ? 180_000 : 120_000,
  });
  return uploadBuffer(buffer, contentType, folder);
}

/** Upload a base64 data URL to R2 (or local disk in guest mode), return URL. */
export async function uploadDataUrl(dataUrl: string, folder: string): Promise<string> {
  if (GUEST_MODE) return localStore.uploadDataUrl(dataUrl, folder);
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("uploadDataUrl: not a valid data URL");
  const contentType = m[1];
  const buf = Buffer.from(m[2], "base64");
  return uploadBuffer(buf, contentType, folder);
}

/** Resolve any URL to a stored URL (R2 or local disk in guest mode). */
export async function ensureR2(url: string, folder: string): Promise<string> {
  if (GUEST_MODE) return localStore.ensureStorage(url, folder);
  const cdnBase = process.env.R2_PUBLIC_URL ?? "";
  if (url.startsWith("data:"))        return uploadDataUrl(url, folder);
  if (cdnBase && url.startsWith(cdnBase)) return url;
  return mirrorToR2(url, folder);
}
