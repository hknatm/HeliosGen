/**
 * Ratio-independent composition and copy-space helpers for Image Style Profile.
 *
 * Coordinates are normalized (0–1), so the authored layout applies equally to
 * square, landscape, and portrait generation targets. Pixels are deliberately
 * not stored here: the output media node owns its final ratio and dimensions.
 */
export type CopySpacePreset =
  | "left_third"
  | "left_half"
  | "left_two_thirds"
  | "right_third"
  | "right_half"
  | "right_two_thirds"
  | "top_band"
  | "bottom_band"
  | "custom";

export type SubjectAnchor = "left_third" | "center" | "right_third";
export type SubjectScale = "small" | "medium" | "large";

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StyleComposition {
  subjectAnchor: SubjectAnchor;
  subjectScale: SubjectScale;
  copySpacePreset: CopySpacePreset;
  copySpace: NormalizedRect;
  copySpaceBackground: string;
  copySpaceContrast: "light" | "dark" | "high";
  copySpaceAvoid: string[];
}

export const COPY_SPACE_PRESETS: Array<{ id: CopySpacePreset; label: string; rect: NormalizedRect }> = [
  { id: "left_third", label: "Left third", rect: { x: 0, y: 0, width: 1 / 3, height: 1 } },
  { id: "left_half", label: "Left half", rect: { x: 0, y: 0, width: 1 / 2, height: 1 } },
  { id: "left_two_thirds", label: "Left two-thirds", rect: { x: 0, y: 0, width: 2 / 3, height: 1 } },
  { id: "right_third", label: "Right third", rect: { x: 2 / 3, y: 0, width: 1 / 3, height: 1 } },
  { id: "right_half", label: "Right half", rect: { x: 1 / 2, y: 0, width: 1 / 2, height: 1 } },
  { id: "right_two_thirds", label: "Right two-thirds", rect: { x: 1 / 3, y: 0, width: 2 / 3, height: 1 } },
  { id: "top_band", label: "Top band", rect: { x: 0, y: 0, width: 1, height: 1 / 3 } },
  { id: "bottom_band", label: "Bottom band", rect: { x: 0, y: 2 / 3, width: 1, height: 1 / 3 } },
];

export const DEFAULT_STYLE_COMPOSITION: StyleComposition = {
  subjectAnchor: "right_third",
  subjectScale: "medium",
  copySpacePreset: "left_two_thirds",
  copySpace: { x: 0, y: 0, width: 2 / 3, height: 1 },
  copySpaceBackground: "Clean, low-detail, softly lit negative space",
  copySpaceContrast: "high",
  copySpaceAvoid: ["objects", "shadows", "decor", "generated text"],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function normalizeRect(value: unknown, fallback: NormalizedRect): NormalizedRect {
  if (!isObject(value)) return { ...fallback };
  // Keep every authored rect renderable: a zone must retain at least 1% width
  // and height, so x/y cannot reach the far edge of the normalized canvas.
  const x = Math.min(0.99, boundedNumber(value.x, fallback.x));
  const y = Math.min(0.99, boundedNumber(value.y, fallback.y));
  const width = Math.min(1 - x, Math.max(0.01, boundedNumber(value.width, fallback.width)));
  const height = Math.min(1 - y, Math.max(0.01, boundedNumber(value.height, fallback.height)));
  return { x, y, width, height };
}

function isPreset(value: unknown): value is CopySpacePreset {
  return value === "left_third" || value === "left_half" || value === "left_two_thirds" ||
    value === "right_third" || value === "right_half" || value === "right_two_thirds" ||
    value === "top_band" || value === "bottom_band" || value === "custom";
}

function isSubjectAnchor(value: unknown): value is SubjectAnchor {
  return value === "left_third" || value === "center" || value === "right_third";
}

function isSubjectScale(value: unknown): value is SubjectScale {
  return value === "small" || value === "medium" || value === "large";
}

/** Read a resilient composition contract from arbitrary Style Profile JSON. */
export function readStyleComposition(profile: Record<string, unknown>): StyleComposition {
  const preset = isPreset(profile.copy_space_preset) ? profile.copy_space_preset : DEFAULT_STYLE_COMPOSITION.copySpacePreset;
  const presetRect = COPY_SPACE_PRESETS.find((item) => item.id === preset)?.rect ?? DEFAULT_STYLE_COMPOSITION.copySpace;
  const avoid = Array.isArray(profile.copy_space_avoid)
    ? profile.copy_space_avoid.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : DEFAULT_STYLE_COMPOSITION.copySpaceAvoid;
  const contrast = profile.copy_space_contrast === "light" || profile.copy_space_contrast === "dark" || profile.copy_space_contrast === "high"
    ? profile.copy_space_contrast
    : DEFAULT_STYLE_COMPOSITION.copySpaceContrast;

  return {
    subjectAnchor: isSubjectAnchor(profile.subject_anchor) ? profile.subject_anchor : DEFAULT_STYLE_COMPOSITION.subjectAnchor,
    subjectScale: isSubjectScale(profile.subject_scale) ? profile.subject_scale : DEFAULT_STYLE_COMPOSITION.subjectScale,
    copySpacePreset: preset,
    copySpace: normalizeRect(profile.copy_space, presetRect),
    copySpaceBackground: typeof profile.copy_space_background === "string" && profile.copy_space_background.trim()
      ? profile.copy_space_background
      : DEFAULT_STYLE_COMPOSITION.copySpaceBackground,
    copySpaceContrast: contrast,
    copySpaceAvoid: avoid.length ? avoid : [...DEFAULT_STYLE_COMPOSITION.copySpaceAvoid],
  };
}

/** Merge an edited composition into a Style Profile without touching other style fields. */
export function writeStyleComposition(
  profile: Record<string, unknown>,
  patch: Partial<StyleComposition>,
): Record<string, unknown> {
  const current = readStyleComposition(profile);
  const next = { ...current, ...patch };
  const presetRect = patch.copySpacePreset && patch.copySpacePreset !== "custom"
    ? COPY_SPACE_PRESETS.find((item) => item.id === patch.copySpacePreset)?.rect
    : undefined;
  const copySpace = normalizeRect(patch.copySpace ?? presetRect ?? current.copySpace, current.copySpace);

  return {
    ...profile,
    subject_anchor: next.subjectAnchor,
    subject_scale: next.subjectScale,
    copy_space_preset: next.copySpacePreset,
    copy_space: copySpace,
    copy_space_background: next.copySpaceBackground,
    copy_space_contrast: next.copySpaceContrast,
    copy_space_avoid: next.copySpaceAvoid.filter((item) => item.trim()),
  };
}

/** Parse an editable JSON profile as a root object; malformed content remains untouched. */
export function parseStyleProfileObject(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatStyleProfileObject(profile: Record<string, unknown>): string {
  return JSON.stringify(profile, null, 2);
}
