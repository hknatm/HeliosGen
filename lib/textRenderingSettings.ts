import type { TextAlignment } from "./store";

export type TextOutputFormat = "png" | "webp";

export interface TextRenderingSettings {
  defaultFontFamily: string;
  defaultTextColor: string;
  defaultAccentColor: string;
  defaultAlignment: TextAlignment;
  defaultTitleSize: number;
  defaultBodySize: number;
  defaultPadding: number;
  outputFormat: TextOutputFormat;
}

export const DEFAULT_TEXT_RENDERING_SETTINGS: TextRenderingSettings = {
  defaultFontFamily: "Arial",
  defaultTextColor: "#FFFFFF",
  defaultAccentColor: "#F59E0B",
  defaultAlignment: "left",
  defaultTitleSize: 72,
  defaultBodySize: 28,
  defaultPadding: 0.08,
  outputFormat: "png",
};

export const TEXT_RENDERING_SETTINGS_STORAGE_KEY = "aiui-text-rendering-settings";

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Accept only a small, renderable set of global text defaults. */
export function normalizeTextRenderingSettings(value: unknown): TextRenderingSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    defaultFontFamily: typeof input.defaultFontFamily === "string" && input.defaultFontFamily.trim()
      ? input.defaultFontFamily.trim().slice(0, 100)
      : DEFAULT_TEXT_RENDERING_SETTINGS.defaultFontFamily,
    defaultTextColor: isHex(input.defaultTextColor) ? input.defaultTextColor.toUpperCase() : DEFAULT_TEXT_RENDERING_SETTINGS.defaultTextColor,
    defaultAccentColor: isHex(input.defaultAccentColor) ? input.defaultAccentColor.toUpperCase() : DEFAULT_TEXT_RENDERING_SETTINGS.defaultAccentColor,
    defaultAlignment: input.defaultAlignment === "center" || input.defaultAlignment === "right" ? input.defaultAlignment : "left",
    defaultTitleSize: bounded(input.defaultTitleSize, DEFAULT_TEXT_RENDERING_SETTINGS.defaultTitleSize, 24, 240),
    defaultBodySize: bounded(input.defaultBodySize, DEFAULT_TEXT_RENDERING_SETTINGS.defaultBodySize, 12, 120),
    defaultPadding: (() => {
      const n = Number(input.defaultPadding);
      return Number.isFinite(n) ? Math.min(0.25, Math.max(0.02, n)) : DEFAULT_TEXT_RENDERING_SETTINGS.defaultPadding;
    })(),
    outputFormat: input.outputFormat === "webp" ? "webp" : "png",
  };
}

export function loadTextRenderingSettings(): TextRenderingSettings {
  if (typeof window === "undefined") return { ...DEFAULT_TEXT_RENDERING_SETTINGS };
  try {
    return normalizeTextRenderingSettings(JSON.parse(localStorage.getItem(TEXT_RENDERING_SETTINGS_STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_TEXT_RENDERING_SETTINGS };
  }
}

export function saveTextRenderingSettings(settings: TextRenderingSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TEXT_RENDERING_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeTextRenderingSettings(settings)));
    window.dispatchEvent(new CustomEvent("aiui-text-rendering-settings-changed"));
  } catch { /* browser storage unavailable */ }
}
