export const REFERENCE_PRESETS_STORAGE_KEY = "aiui-reference-presets";
export const REFERENCE_PRESETS_CHANGED_EVENT = "aiui-reference-presets-changed";
export const MAX_REFERENCE_PRESETS = 100;

export interface ReferenceMetadataPreset {
  id: string;
  label: string;
  name: string;
  usageNote: string;
}

export interface ReferencePresetSettings {
  version: 1;
  presets: ReferenceMetadataPreset[];
}

export const DEFAULT_REFERENCE_PRESET_SETTINGS: ReferencePresetSettings = {
  version: 1,
  presets: [],
};

export function normalizeReferencePresetSettings(value: unknown): ReferencePresetSettings {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const input = Array.isArray(object.presets) ? object.presets : [];
  const ids = new Set<string>();
  const presets = input.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim().slice(0, 80) : "";
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
    const usageNote = typeof item.usageNote === "string" ? item.usageNote.trim().slice(0, 500) : "";
    if (!id || ids.has(id) || !label || !name) return [];
    ids.add(id);
    return [{ id, label, name, usageNote }];
  }).slice(0, MAX_REFERENCE_PRESETS);
  return { version: 1, presets };
}

export function loadReferencePresetSettings(): ReferencePresetSettings {
  if (typeof window === "undefined") return { ...DEFAULT_REFERENCE_PRESET_SETTINGS, presets: [] };
  try {
    return normalizeReferencePresetSettings(JSON.parse(localStorage.getItem(REFERENCE_PRESETS_STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_REFERENCE_PRESET_SETTINGS, presets: [] };
  }
}

export function saveReferencePresetSettings(value: ReferencePresetSettings): ReferencePresetSettings {
  const normalized = normalizeReferencePresetSettings(value);
  if (typeof window === "undefined") return normalized;
  localStorage.setItem(REFERENCE_PRESETS_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(REFERENCE_PRESETS_CHANGED_EVENT));
  return normalized;
}

/** Replace a linked preset in place, or append a new preset for custom metadata. */
export function upsertReferencePreset(
  settings: ReferencePresetSettings,
  preset: ReferenceMetadataPreset,
): { settings: ReferencePresetSettings; updated: boolean } {
  const index = settings.presets.findIndex((item) => item.id === preset.id);
  if (index < 0) {
    return {
      settings: normalizeReferencePresetSettings({ ...settings, presets: [...settings.presets, preset] }),
      updated: false,
    };
  }
  const presets = settings.presets.map((item, itemIndex) => itemIndex === index ? preset : item);
  return { settings: normalizeReferencePresetSettings({ ...settings, presets }), updated: true };
}
