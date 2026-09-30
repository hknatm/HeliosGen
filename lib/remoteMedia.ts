import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isNonPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ip = mapped ? mapped[1] : address.toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0))
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff");
  }
  return true;
}

/** dns.lookup that refuses non-public results, so the checked address is the one connected to. */
const publicOnlyLookup = ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((entry) => isNonPublicAddress(entry.address))) {
      return callback(Object.assign(new Error("Remote media host is not a public address"), { code: "EACCES" }));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}) as unknown as net.LookupFunction;

export interface RemoteMedia {
  buffer: Buffer;
  contentType: string;
}

export function fetchRemoteMedia(
  sourceUrl: string,
  options: { maxBytes?: number; timeoutMs?: number; totalTimeoutMs?: number; maxRedirects?: number; startedAt?: number; publicOnly?: boolean } = {},
): Promise<RemoteMedia> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;
  const startedAt = options.startedAt ?? Date.now();
  const publicOnly = options.publicOnly === true;

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

    if (publicOnly && (parsed.protocol !== "https:" || parsed.username || parsed.password || (net.isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && isNonPublicAddress(parsed.hostname.replace(/^\[|\]$/g, ""))))) {
      return reject(new Error("Remote media must be a public HTTPS URL"));
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.get(parsed, publicOnly ? { lookup: publicOnlyLookup } : {}, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const redirect = new URL(response.headers.location, parsed).toString();
        fetchRemoteMedia(redirect, { maxBytes, timeoutMs, totalTimeoutMs, maxRedirects: maxRedirects - 1, startedAt, publicOnly })
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
