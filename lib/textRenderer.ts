import { readFile } from "fs/promises";
import sharp from "sharp";
import type { TextContent } from "./store";
import type { StyleComposition } from "./styleComposition";
import type { TextRenderingSettings } from "./textRenderingSettings";
import { fontFormatFromUrl } from "./textFonts";

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const LOCAL_GENERATED_PATH = /^\/generated\/([a-z0-9_-]+)(?:\/([a-z0-9][a-z0-9-]{0,79}))?\/([a-z0-9-]+\.(?:png|jpe?g|webp|gif|ttf|otf|woff2?))$/i;

function xml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function cssString(value: string): string { return value.replace(/["'<>\\\n\r]/g, ""); }
function validHex(value: unknown, fallback: string): string { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; }

function appOwnedPath(url: string, folder?: string): string | null {
  const pathname = url.split(/[?#]/, 1)[0];
  const match = LOCAL_GENERATED_PATH.exec(pathname);
  if (!match || (folder && match[1] !== folder)) return null;
  // Every path segment is strictly allowlisted above, so this cannot escape
  // public/generated even though the filename originates from an asset URL.
  const [, resolvedFolder, subfolder, filename] = match;
  return `${process.cwd()}/public/generated/${resolvedFolder}${subfolder ? `/${subfolder}` : ""}/${filename}`;
}

function isR2Asset(url: string): boolean {
  const base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  return !!base && url.startsWith(`${base}/`);
}

async function ownedBuffer(url: string, folder?: string): Promise<Buffer> {
  const local = appOwnedPath(url, folder);
  if (local) return readFile(local);
  if (!isR2Asset(url)) throw new Error("Source asset must be stored by HeliosGen");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Unable to load stored asset");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > MAX_SOURCE_BYTES) throw new Error("Source asset exceeds 30 MB");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_SOURCE_BYTES) throw new Error("Source asset exceeds 30 MB");
  return buffer;
}

function lineElements(lines: string[], x: number, startY: number, fontSize: number, lineHeight: number, fill: string, anchor: string, weight = 400): string {
  return lines.map((line, index) => `<text x="${x}" y="${startY + index * lineHeight}" fill="${fill}" font-size="${fontSize}" font-weight="${weight}" text-anchor="${anchor}">${xml(line)}</text>`).join("");
}

function wrap(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) { lines.push(current); current = word; }
    else current = candidate;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return lines;
}

export interface TextRenderRequest {
  imageUrl: string;
  content: TextContent;
  composition: StyleComposition;
  settings: TextRenderingSettings;
  fontUrl?: string;
}

export interface TextRenderResult {
  buffer: Buffer;
  mime: string;
  /** Number of text lines dropped because they did not fit the reserved copy zone. */
  truncatedLines: number;
}

/** Render a constrained, deterministic SVG text overlay with Sharp. */
export async function renderTextOverlay(input: TextRenderRequest): Promise<TextRenderResult> {
  const image = await ownedBuffer(input.imageUrl);
  const source = sharp(image).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Unable to read image dimensions");
  const width = metadata.width;
  const height = metadata.height;
  const zone = input.composition.copySpace;
  const padding = Math.round(Math.min(width, height) * input.settings.defaultPadding);
  const x = Math.round(zone.x * width) + padding;
  const y = Math.round(zone.y * height) + padding;
  const zoneBottom = Math.max(y, Math.round((zone.y + zone.height) * height) - padding);
  const zoneWidth = Math.max(1, Math.round(zone.width * width) - padding * 2);
  const titleSize = Math.min(input.settings.defaultTitleSize, Math.round(height * 0.13));
  const bodySize = Math.min(input.settings.defaultBodySize, Math.round(height * 0.055));
  const alignment = input.content.alignment ?? input.settings.defaultAlignment;
  const anchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
  const textX = alignment === "center" ? x + zoneWidth / 2 : alignment === "right" ? x + zoneWidth : x;
  const family = cssString(input.content.fontFamily || input.settings.defaultFontFamily);
  const textColor = validHex(input.content.textColor, input.settings.defaultTextColor);
  const accentColor = validHex(input.content.accentColor, input.settings.defaultAccentColor);
  const maxTitleChars = Math.max(10, Math.floor(zoneWidth / Math.max(1, titleSize * 0.55)));
  const maxBodyChars = Math.max(16, Math.floor(zoneWidth / Math.max(1, bodySize * 0.52)));
  let cursor = y + titleSize;
  let truncatedLines = 0;
  const pieces: string[] = [];
  const addLines = (lines: string[], size: number, lineHeight: number, fill: string, weight = 400, gap = 0) => {
    const visibleLines = lines.filter((_, index) => cursor + index * lineHeight <= zoneBottom);
    if (visibleLines.length) pieces.push(lineElements(visibleLines, textX, cursor, size, lineHeight, fill, anchor, weight));
    // Lines that do not fit the reserved zone are dropped, not stretched or
    // reflowed — and the caller is told exactly how many so the UI can warn.
    truncatedLines += lines.length - visibleLines.length;
    cursor += lines.length * lineHeight + gap;
  };
  if (input.content.eyebrow.trim()) addLines(wrap(input.content.eyebrow, maxBodyChars, 1), Math.round(bodySize * 0.72), bodySize, accentColor, 700, Math.round(bodySize * 0.8));
  if (input.content.title.trim()) addLines(wrap(input.content.title, maxTitleChars, 3), titleSize, Math.round(titleSize * 1.08), textColor, 700, Math.round(bodySize * 0.6));
  if (input.content.subtitle.trim()) addLines(wrap(input.content.subtitle, maxBodyChars, 3), bodySize, Math.round(bodySize * 1.4), textColor, 400, Math.round(bodySize * 0.5));
  for (const bullet of input.content.bullets.slice(0, 5)) {
    if (bullet.trim()) addLines(wrap(`• ${bullet}`, maxBodyChars, 2), Math.round(bodySize * 0.9), Math.round(bodySize * 1.3), textColor);
  }
  if (input.content.cta.trim()) {
    if (cursor + Math.round(bodySize * 0.5) <= zoneBottom) {
      cursor += Math.round(bodySize * 0.5);
      addLines(wrap(input.content.cta, maxBodyChars, 1), bodySize, bodySize, accentColor, 700);
    } else {
      truncatedLines += 1;
    }
  }
  // Sharp/librsvg resolves embedded data reliably across local and R2-backed
  // deployments; never let user-controlled SVG fetch a URL itself.
  const format = input.fontUrl ? fontFormatFromUrl(input.fontUrl) : undefined;
  const fontMime = format === "woff2" ? "font/woff2" : format === "woff" ? "font/woff" : format === "otf" ? "font/otf" : "font/ttf";
  const svgFormat = format === "woff2" ? "woff2" : format === "woff" ? "woff" : format === "otf" ? "opentype" : "truetype";
  const fontFace = input.fontUrl && format
    ? `@font-face{font-family:'${family}';src:url(data:${fontMime};base64,${(await ownedBuffer(input.fontUrl, "fonts")).toString("base64")}) format('${svgFormat}');}`
    : "";
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><style>${fontFace}text{font-family:'${family}',Arial,sans-serif;}</style>${pieces.join("")}</svg>`;
  const composed = source.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  return input.settings.outputFormat === "webp"
    ? { buffer: await composed.webp({ quality: 92 }).toBuffer(), mime: "image/webp", truncatedLines }
    : { buffer: await composed.png().toBuffer(), mime: "image/png", truncatedLines };
}
