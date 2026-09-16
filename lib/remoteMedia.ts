import http from "node:http";
import https from "node:https";

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;

export interface RemoteMedia {
  buffer: Buffer;
  contentType: string;
}

export function fetchRemoteMedia(
  sourceUrl: string,
  options: { maxBytes?: number; timeoutMs?: number; totalTimeoutMs?: number; maxRedirects?: number; startedAt?: number } = {},
): Promise<RemoteMedia> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;
  const startedAt = options.startedAt ?? Date.now();

  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error("Too many redirects"));
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return reject(new Error("Invalid remote media URL"));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return reject(new Error("Remote media URL must use HTTP or HTTPS"));
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.get(parsed, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const redirect = new URL(response.headers.location, parsed).toString();
        fetchRemoteMedia(redirect, { maxBytes, timeoutMs, totalTimeoutMs, maxRedirects: maxRedirects - 1, startedAt })
          .then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status} fetching remote media`));
        return;
      }

      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy(new Error(`Remote media exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > maxBytes) {
          response.destroy(new Error(`Remote media exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: response.headers["content-type"] ?? "application/octet-stream",
      }));
      response.on("error", reject);
    });

    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      request.destroy(new Error("Remote media fetch exceeded total timeout"));
      return;
    }
    const totalTimer = setTimeout(() => request.destroy(new Error("Remote media fetch exceeded total timeout")), remaining);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Remote media fetch timed out")));
    request.on("close", () => clearTimeout(totalTimer));
    request.on("error", reject);
  });
}
