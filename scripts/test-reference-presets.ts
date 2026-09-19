import assert from "node:assert/strict";
import {
  deleteReferencePreset,
  loadReferencePresetSettings,
  normalizeReferencePresetSettings,
  REFERENCE_PRESETS_CHANGED_EVENT,
  REFERENCE_PRESETS_STORAGE_KEY,
  saveReferencePresetSettings,
  upsertReferencePreset,
} from "../lib/referencePresets";
import { replacementDraft, replacementFailurePatch } from "../lib/referenceImageState";

const normalized = normalizeReferencePresetSettings({
  presets: [
    { id: "product", label: "  Main product  ", name: " Product ", usageNote: " Preserve exact packaging. " },
    { id: "product", label: "Duplicate", name: "Duplicate", usageNote: "ignored" },
    { id: "missing-name", label: "Missing", name: "", usageNote: "ignored" },
    null,
  ],
});
assert.equal(normalized.version, 1);
assert.equal(normalized.presets.length, 1);
assert.deepEqual(normalized.presets[0], {
  id: "product",
  label: "Main product",
  name: "Product",
  usageNote: "Preserve exact packaging.",
});

const capped = normalizeReferencePresetSettings({
  presets: Array.from({ length: 110 }, (_, index) => ({
    id: `preset-${index}`,
    label: `Preset ${index}`,
    name: "Product",
    usageNote: "Use as product.",
  })),
});
assert.equal(capped.presets.length, 100);

const updatedPreset = upsertReferencePreset(normalized, {
  id: "product",
  label: "Hero product",
  name: "Hero product",
  usageNote: "Preserve the new packaging.",
});
assert.equal(updatedPreset.updated, true);
assert.equal(updatedPreset.settings.presets.length, 1, "updating a selected preset does not create a duplicate");
assert.deepEqual(updatedPreset.settings.presets[0], {
  id: "product",
  label: "Hero product",
  name: "Hero product",
  usageNote: "Preserve the new packaging.",
});

const addedPreset = upsertReferencePreset(normalized, {
  id: "background",
  label: "Background",
  name: "Background",
  usageNote: "Use for atmosphere only.",
});
assert.equal(addedPreset.updated, false);
assert.equal(addedPreset.settings.presets.length, 2, "custom metadata creates a new preset");

const deletedPreset = deleteReferencePreset(addedPreset.settings, "product");
assert.equal(deletedPreset.presets.length, 1, "deleting a preset removes only the selected preset");
assert.equal(deletedPreset.presets[0]?.id, "background");
assert.deepEqual(deleteReferencePreset(deletedPreset, "missing"), deletedPreset, "deleting an unknown preset is a no-op");

const previous = {
  id: "product-image",
  inputImage: "https://cdn.example.com/old.png",
  r2Url: "https://cdn.example.com/old.png",
  name: "Product",
  usageNote: "Preserve packaging",
  presetId: "product",
  status: "ready" as const,
};
const draft = replacementDraft(previous, previous.id, "blob:new", "new-file");
assert.equal(draft.r2Url, previous.r2Url, "replacement keeps the prior durable URL until the new upload succeeds");
assert.equal(draft.inputImage, "blob:new");
assert.equal(draft.name, "Product");
assert.equal(draft.usageNote, "Preserve packaging");
assert.equal(draft.presetId, "product");
assert.deepEqual(replacementFailurePatch(previous, "network failed"), {
  inputImage: previous.r2Url,
  r2Url: previous.r2Url,
  status: "ready",
  error: "Replacement failed: network failed",
});
assert.deepEqual(replacementFailurePatch({ ...previous, r2Url: undefined }, "network failed"), {
  inputImage: previous.inputImage,
  r2Url: undefined,
  status: "ready",
  error: "Replacement failed: network failed",
});
assert.equal(replacementFailurePatch(undefined, "network failed").status, "error");

const storage = new Map<string, string>();
let dispatched = "";
(globalThis as unknown as { window: unknown }).window = { dispatchEvent: (event: { type?: string }) => { dispatched = event.type ?? ""; } };
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
};
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class { type: string; constructor(type: string) { this.type = type; } };
const saved = saveReferencePresetSettings({ version: 1, presets: [{ id: "product", label: "Product", name: "Product", usageNote: "Preserve" }] });
assert.equal(saved.presets.length, 1);
assert.equal(dispatched, REFERENCE_PRESETS_CHANGED_EVENT);
assert.equal(loadReferencePresetSettings().presets[0]?.name, "Product");
storage.set(REFERENCE_PRESETS_STORAGE_KEY, "not json");
assert.deepEqual(loadReferencePresetSettings().presets, []);

console.log("reference preset tests passed");
