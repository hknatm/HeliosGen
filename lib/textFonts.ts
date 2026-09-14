export const TEXT_FONTS_STORAGE_KEY = "aiui-text-fonts";
export const TEXT_FONTS_CHANGED_EVENT = "aiui-text-fonts-changed";

export interface TextFont {
  id: string;
  family: string;
  familyKey: string;
  url: string;
  format: "ttf" | "otf" | "woff" | "woff2";
  source: "uploaded";
  createdAt: number;
}

export const BUILT_IN_TEXT_FONTS = ["Arial", "Helvetica", "Georgia", "Times New Roman"] as const;
const FONT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function parseFont(value: unknown): TextFont | null {
  if (!value || typeof value !== "object") return null;
  const font = value as Record<string, unknown>;
  if (
    typeof font.id !== "string" || !FONT_ID_PATTERN.test(font.id) ||
    typeof font.family !== "string" || !font.family.trim() || font.family.length > 100 ||
    typeof font.url !== "string" || !isAppOwnedFontUrl(font.url) ||
    (font.format !== "ttf" && font.format !== "otf" && font.format !== "woff" && font.format !== "woff2") ||
    typeof font.createdAt !== "number" || !Number.isFinite(font.createdAt)
  ) return null;
  const family = font.family.trim();
  // Older locally saved descriptors lack familyKey; they remain selectable but
  // do not become renderable until re-uploaded through the bound URL format.
  const familyKey = typeof font.familyKey === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(font.familyKey)
    ? font.familyKey
    : "";
  return { id: font.id, family, familyKey, url: font.url, format: font.format, source: "uploaded", createdAt: font.createdAt };
}

export function isAppOwnedFontUrl(url: string): boolean {
  // New uploads encode a normalized family key in the folder so the rendering
  // route can verify the selected family without trusting a client descriptor.
  // Keep the former single-segment form readable for existing saved settings.
  const fontPath = /^\/generated\/fonts\/(?:[a-z0-9][a-z0-9-]{0,79}\/)?[a-z0-9-]+\.(ttf|otf|woff|woff2)$/i;
  if (fontPath.test(url)) return true;
  try {
    const parsed = new URL(url);
    if (!/^\/fonts\/(?:[a-z0-9][a-z0-9-]{0,79}\/)?[a-z0-9-]+\.(ttf|otf|woff|woff2)$/i.test(parsed.pathname)) return false;
    // Cloud deployments only expose R2_PUBLIC_URL on the server. Browser code
    // may retain a valid uploaded-font descriptor without knowing that origin;
    // the rendering route always performs the strict server-side origin check.
    if (typeof window !== "undefined") return parsed.protocol === "https:";
    const base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    return !!base && url.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

export function loadTextFonts(): TextFont[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(TEXT_FONTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.map(parseFont).filter((font): font is TextFont => !!font && !seen.has(font.id) && (seen.add(font.id), true));
  } catch {
    return [];
  }
}

export function saveTextFonts(fonts: TextFont[]): void {
  if (typeof window === "undefined") return;
  try {
    const clean = fonts.map(parseFont).filter((font): font is TextFont => !!font);
    localStorage.setItem(TEXT_FONTS_STORAGE_KEY, JSON.stringify(clean));
    window.dispatchEvent(new CustomEvent(TEXT_FONTS_CHANGED_EVENT));
  } catch { /* browser storage unavailable */ }
}

export function fontOptions(fonts = loadTextFonts()): string[] {
  return [...BUILT_IN_TEXT_FONTS, ...fonts.map((font) => font.family)].filter((family, index, all) => all.indexOf(family) === index);
}

export function resolveTextFont(fonts: TextFont[], family: string): TextFont | undefined {
  return fonts.find((font) => font.family === family);
}

export function fontFormatFromUrl(url: string): TextFont["format"] | undefined {
  const lower = url.split(/[?#]/, 1)[0].toLowerCase();
  if (lower.endsWith(".ttf")) return "ttf";
  if (lower.endsWith(".otf")) return "otf";
  if (lower.endsWith(".woff")) return "woff";
  if (lower.endsWith(".woff2")) return "woff2";
  return undefined;
}

/** Produce the ASCII URL key used to bind an uploaded font to its display family. */
export function fontFamilyKey(family: string): string | null {
  const key = family
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return key || null;
}

/** Read the normalized family key embedded in a newly uploaded font URL. */
export function familyKeyFromFontUrl(url: string): string | null {
  const pathname = url.split(/[?#]/, 1)[0];
  const match = /\/fonts\/([a-z0-9][a-z0-9-]{0,79})\/[a-z0-9-]+\.(?:ttf|otf|woff|woff2)$/i.exec(pathname);
  return match ? match[1].toLowerCase() : null;
}

export function isBuiltInFontFamily(family: string): boolean {
  const familyKey = fontFamilyKey(family);
  return !!familyKey && BUILT_IN_TEXT_FONTS.some((builtIn) => fontFamilyKey(builtIn) === familyKey);
}
