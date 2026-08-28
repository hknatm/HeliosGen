// ─────────────────────────────────────────────────────────────────────────────
// PROVIDERS — single source of truth for per-model backend selection
// (Kie.ai / Codex CLI), shared by the Settings modal, the workflow GenerateNode,
// and the gallery generation composer.
// ─────────────────────────────────────────────────────────────────────────────
import { IMAGE_MODELS } from "@/lib/modelConfig";

export const PROVIDERS = [
  { id: "kie",   label: "Kie.ai" },
  { id: "codex", label: "Codex CLI" },
] as const;

// Keep the legacy Azure value readable from existing browser storage while no
// longer exposing it as a selectable provider in this fork.
export type ProviderId = (typeof PROVIDERS)[number]["id"] | "azure";

const STORAGE_KEY = "aiui-model-providers";

export function loadModelProviders(): Record<string, ProviderId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, ProviderId> : {};
    return Object.fromEntries(Object.entries(parsed).map(([modelId, provider]) => [
      modelId,
      provider === "azure" ? "kie" : provider,
    ])) as Record<string, ProviderId>;
  } catch {
    return {};
  }
}

export function saveModelProviders(map: Record<string, ProviderId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent("aiui-providers-changed"));
  } catch { /* noop */ }
}

export function getModelProvider(modelId: string): ProviderId {
  const provider = loadModelProviders()[modelId];
  return provider === "azure" ? "kie" : (provider ?? "kie");
}

/** Persists the backend for a single model, leaving the others untouched. */
export function setModelProvider(modelId: string, provider: ProviderId) {
  const map = loadModelProviders();
  saveModelProviders({ ...map, [modelId]: provider });
}

/** Image models that can use the server's Codex CLI backend. */
const MULTI_PROVIDER_MODEL_IDS = new Set(
  IMAGE_MODELS.filter((m) => m.id === "gpt-image-2").map((m) => m.id),
);

export function modelHasProviderChoice(modelId: string): boolean {
  return MULTI_PROVIDER_MODEL_IDS.has(modelId);
}
