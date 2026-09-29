import assert from "node:assert/strict";
import {
  customModelId,
  customModelSupportsVision,
  loadCustomProviderModels,
  saveCustomProviderModels,
  setCustomProviderModelVision,
  syncCustomProviderModels,
} from "../lib/customProvider";

const storage = new Map<string, string>();
let changed = 0;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
} as Storage;
(globalThis as unknown as { window: Window }).window = { dispatchEvent: () => { changed++; } } as unknown as Window;
(globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = class { constructor(type: string) { void type; } } as unknown as typeof CustomEvent;

storage.set("aiui-custom-provider-config", JSON.stringify({ name: "Test", baseUrl: "https://provider.example/v1", apiKey: "" }));
saveCustomProviderModels([
  { id: "luna-5.6", name: "Luna 5.6", enabled: true, vision: false, providerBaseUrl: "https://provider.example/v1" },
  { id: "deepseek-4.1-flash", name: "DeepSeek 4.1 Flash", enabled: true, vision: true, providerBaseUrl: "https://provider.example/v1" },
]);
assert.equal(customModelSupportsVision(customModelId("luna-5.6")), false);
assert.equal(customModelSupportsVision(customModelId("deepseek-4.1-flash")), true);
setCustomProviderModelVision("luna-5.6", true);
assert.equal(customModelSupportsVision(customModelId("luna-5.6")), true, "vision capability is explicitly configurable per custom model");
assert.equal(changed >= 2, true);
storage.set("aiui-custom-provider-models", JSON.stringify([{ id: "legacy-model", name: "Legacy", enabled: false }]));
const legacy = loadCustomProviderModels()[0];
assert.equal(legacy.vision, false, "legacy custom models migrate to text-only");
assert.equal(legacy.providerBaseUrl, "", "legacy capabilities are not trusted for the current provider");
// Restore the capability fixtures used by the sync-preservation assertions.
saveCustomProviderModels([
  { id: "luna-5.6", name: "Luna 5.6", enabled: true, vision: true, providerBaseUrl: "https://provider.example/v1" },
  { id: "deepseek-4.1-flash", name: "DeepSeek 4.1 Flash", enabled: true, vision: true, providerBaseUrl: "https://provider.example/v1" },
]);

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [{ id: "luna-5.6", vision: true }, "new-text-model"] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const synced = await syncCustomProviderModels({ name: "Test", baseUrl: "https://provider.example/v1", apiKey: "" });
  globalThis.fetch = originalFetch;
  assert.equal(synced.find((model) => model.id === "luna-5.6")?.vision, true, "model sync accepts provider-advertised vision capability");
  assert.equal(synced.find((model) => model.id === "new-text-model")?.vision, false, "new custom models default to text-only");
  assert.equal(synced.every((model) => model.providerBaseUrl === "https://provider.example/v1"), true, "capabilities are scoped to the configured provider URL");
  assert.equal(loadCustomProviderModels().length, 2);
  console.log("custom provider tests passed");
}

void main();
