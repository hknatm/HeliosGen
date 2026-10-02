// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM PROVIDER — helpers for a custom OpenAI-compatible proxy endpoint.
//
// Backend-facing helpers (customProviderUrl / customProviderHeaders /
// isCustomModelId / customModelName) are used by the API routes. Client-side
// helpers (config + synced model list persistence) are used by the Settings UI
// and any future backend/UI integration.
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomProviderRequestConfig {
  baseUrl?: string;
  apiKey?: string;
  /** Explicit capability opt-in; model names are not reliable capability metadata. */
  vision?: boolean;
}

/* ─── Backend-facing helpers ───────────────────────────────────────────────── */

/** Builds a full URL for the given path on the custom provider base URL. */
export function customProviderUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Custom provider base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid custom provider base URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Custom provider base URL must use http or https.");
  }
  return `${trimmed}${path}`;
}

/** Headers for upstream requests to the custom provider. */
export function customProviderHeaders(apiKey?: string): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

/** True when the model id refers to a custom-provider model ("custom:" prefix). */
export function customModelId(model: string): string {
  return `custom:${model}`;
}

export function isCustomModelId(model: string): boolean {
  return typeof model === "string" && model.startsWith("custom:") && model.length > "custom:".length;
}

/** Strips the "custom:" prefix to get the upstream model name. */
export function customModelName(model: string): string {
  return isCustomModelId(model) ? model.slice("custom:".length) : model;
}

/* ─── Client-side config + synced model list ───────────────────────────────── */

export interface CustomProviderConfig {
  /** Human-readable endpoint name (rename). */
  name: string;
  /** Base URL of the OpenAI-compatible proxy. */
  baseUrl: string;
  /** Optional API key — empty string is accepted. */
  apiKey: string;
}

export interface CustomProviderModel {
  /** Model id as reported by the proxy. */
  id: string;
  /** Display name (falls back to id when the proxy omits it). */
  name: string;
  /** Whether the model is enabled for use in chat/assistant surfaces. */
  enabled: boolean;
  /** User-confirmed support for OpenAI-compatible image_url message parts. */
  vision: boolean;
  /** Provider URL for which the capability was confirmed. */
  providerBaseUrl: string;
}

const CONFIG_KEY = "aiui-custom-provider-config";
const MODELS_KEY = "aiui-custom-provider-models";

export const DEFAULT_CUSTOM_PROVIDER_CONFIG: CustomProviderConfig = {
  name: "",
  baseUrl: "",
  apiKey: "",
};

export function loadCustomProviderConfig(): CustomProviderConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CUSTOM_PROVIDER_CONFIG };
    const parsed = JSON.parse(raw) as Partial<CustomProviderConfig>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return { ...DEFAULT_CUSTOM_PROVIDER_CONFIG };
  }
}

export function saveCustomProviderConfig(config: CustomProviderConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent("aiui-custom-provider-config-changed"));
  } catch { /* noop */ }
}

export function loadCustomProviderModels(): CustomProviderModel[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is Record<string, unknown> => !!m && typeof m.id === "string")
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === "string" ? m.name : (m.id as string),
        // Existing models default to enabled. Legacy chat/image fields are
        // dropped — they were dead classification data.
        enabled: m.enabled === undefined ? true : m.enabled === true,
        vision: m.vision === true,
        providerBaseUrl: typeof m.providerBaseUrl === "string" ? m.providerBaseUrl.trim().replace(/\/+$/, "") : "",
      }));
  } catch {
    return [];
  }
}

export function saveCustomProviderModels(models: CustomProviderModel[]) {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
    window.dispatchEvent(new CustomEvent("aiui-custom-provider-models-changed"));
  } catch { /* noop */ }
}

export function getCustomProviderModel(id: string): CustomProviderModel | undefined {
  return loadCustomProviderModels().find((m) => m.id === id);
}

/** Persists the enabled state for a single model, leaving the rest untouched. */
export function setCustomProviderModelEnabled(id: string, enabled: boolean) {
  const models = loadCustomProviderModels();
  const idx = models.findIndex((m) => m.id === id);
  if (idx === -1) return;
  models[idx] = { ...models[idx], enabled };
  saveCustomProviderModels(models);
}

export function setCustomProviderModelVision(id: string, vision: boolean) {
  const models = loadCustomProviderModels();
  const idx = models.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const providerBaseUrl = loadCustomProviderConfig().baseUrl.trim().replace(/\/+$/, "");
  models[idx] = { ...models[idx], vision, providerBaseUrl };
  saveCustomProviderModels(models);
}

export function customModelSupportsVision(model: string): boolean {
  if (!isCustomModelId(model)) return false;
  const configuredBaseUrl = loadCustomProviderConfig().baseUrl.trim().replace(/\/+$/, "");
  const configuredModel = getCustomProviderModel(customModelName(model));
  return configuredModel?.vision === true && !!configuredBaseUrl && configuredModel.providerBaseUrl === configuredBaseUrl;
}

/** Response shape expected from the /api/custom-provider/models route. */
export interface CustomProviderModelDescriptor {
  id: string;
  /** Optional capability advertised by an OpenAI-compatible /models response. */
  vision?: boolean;
}

export interface CustomProviderModelsResponse {
  models: Array<string | CustomProviderModelDescriptor>;
}

/**
 * Calls the same-origin /api/custom-provider/models endpoint with the entered
 * config and returns the synced model list (unclassified — the caller decides
 * how to persist them).
 */
export async function syncCustomProviderModels(
  config: CustomProviderConfig,
): Promise<CustomProviderModel[]> {
  const res = await fetch("/api/custom-provider/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
  });
  if (!res.ok) {
    let message = `Sync failed (${res.status})`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d?.error) message = d.error;
    } catch { /* ignore non-JSON error body */ }
    throw new Error(message);
  }

  const data = (await res.json()) as CustomProviderModelsResponse;
  const models = Array.isArray(data?.models)
    ? data.models
      .map((model): CustomProviderModelDescriptor | null => {
        if (typeof model === "string" && model.trim()) return { id: model.trim() };
        if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()) return null;
        return { id: model.id.trim(), vision: model.vision === true };
      })
      .filter((model): model is CustomProviderModelDescriptor => model !== null)
    : [];
  // Preserve the enabled state and explicit capability of unchanged ids across
  // a re-sync. Provider-advertised vision is also accepted, because many
  // OpenAI-compatible /models endpoints expose input_modalities/capabilities.
  const providerBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const existing = new Map(loadCustomProviderModels().map((m) => [m.id, m]));
  return models.map((descriptor) => {
    const previous = existing.get(descriptor.id);
    const sameProvider = previous?.providerBaseUrl === providerBaseUrl;
    return {
      id: descriptor.id,
      name: descriptor.id,
      enabled: previous?.enabled ?? true,
      vision: descriptor.vision === true || (sameProvider && previous?.vision === true),
      providerBaseUrl,
    };
  });
}
