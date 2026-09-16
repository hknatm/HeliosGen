import { join, resolve, sep } from "path";

const GENERATED_DIR = resolve(process.cwd(), "public", "generated");
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveGeneratedAssetPath(folder: string, filename: string): string | null {
  if (!SAFE_SEGMENT.test(folder) || !SAFE_SEGMENT.test(filename)) return null;

  const candidate = resolve(join(GENERATED_DIR, folder, filename));
  return candidate.startsWith(`${GENERATED_DIR}${sep}`) ? candidate : null;
}

export function generatedAssetPathFromUrl(value: string): string | null {
  let pathname = value;
  if (!pathname.startsWith("/")) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const match = decoded.match(/^\/generated\/([^/]+)\/([^/]+)$/);
  return match ? resolveGeneratedAssetPath(match[1], match[2]) : null;
}

export function generatedAssetContentType(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    woff2: "font/woff2",
    woff: "font/woff",
    otf: "font/otf",
    ttf: "font/ttf",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}
