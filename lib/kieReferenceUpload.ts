import { fetchRemoteMedia } from "./remoteMedia";

const KIE_FILE_UPLOAD = "https://kieai.redpandaai.co/api/file-stream-upload";

function referenceImageType(buffer: Buffer, sourceUrl: string): { mime: string; extension: string } {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", extension: "png" };
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", extension: "jpg" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", extension: "webp" };
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return { mime: "image/gif", extension: "gif" };
  throw new Error(`Reference image must be a JPEG, PNG, WebP, or GIF file (${new URL(sourceUrl).pathname}).`);
}

async function uploadOnce(sourceUrl: string, apiKey: string, index: number): Promise<string> {
  const { buffer } = await fetchRemoteMedia(sourceUrl, { maxBytes: 30 * 1024 * 1024, totalTimeoutMs: 60_000 });
  const { mime, extension } = referenceImageType(buffer, sourceUrl);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), `reference-${index + 1}.${extension}`);
  form.append("uploadPath", "heliosgen/references");

  const response = await fetch(KIE_FILE_UPLOAD, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let payload: { success?: boolean; msg?: string; data?: { downloadUrl?: string; fileUrl?: string } } = {};
  try { payload = JSON.parse(raw) as typeof payload; } catch { /* report concise raw response below */ }
  const uploadedUrl = payload.data?.downloadUrl ?? payload.data?.fileUrl;
  if (!response.ok || payload.success === false || !uploadedUrl) {
    throw new Error(`Kie reference upload failed: ${payload.msg || raw.slice(0, 300) || `HTTP ${response.status}`}`);
  }
  const parsed = new URL(uploadedUrl);
  if (parsed.protocol !== "https:") throw new Error("Kie reference upload returned an invalid URL.");
  return parsed.toString();
}

async function uploadWithRetry(sourceUrl: string, apiKey: string, index: number): Promise<string> {
  try {
    return await uploadOnce(sourceUrl, apiKey, index);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return uploadOnce(sourceUrl, apiKey, index);
  }
}

export async function uploadReferenceImagesToKie(urls: string[], apiKey: string): Promise<string[]> {
  const results = new Array<string>(urls.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      results[index] = await uploadWithRetry(urls[index], apiKey, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, () => worker()));
  return results;
}
