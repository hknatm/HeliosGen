"use client";

import { useEffect, useRef } from "react";
import { useChatSessionStore } from "./chatSessionStore";
import { useWorkflowStore } from "./store";
import { loadTheme, normalizeTheme, saveTheme } from "./theme";
import { REFERENCE_PRESETS_CHANGED_EVENT, REFERENCE_PRESETS_STORAGE_KEY } from "./referencePresets";

/**
 * Focused settings sync helper for local mode.
 *
 * Localhost and ngrok are different browser origins, so localStorage is not
 * shared between them. This module hydrates ordinary (non-secret) settings
 * from the shared SQLite-backed /api/app-settings route and pushes local
 * changes back, giving eventual last-write-wins across origins.
 *
 * Secrets (e.g. the Kie API key) are intentionally NOT synced here — they stay
 * server-side in the guest DB.
 */

export const IS_LOCAL_CLIENT =
  process.env.NEXT_PUBLIC_HELIOS_MODE === "local" ||
  process.env.NEXT_PUBLIC_GUEST_MODE === "true";

// Logical setting key → localStorage key for the simple JSON settings.
const LOCAL_STORAGE_KEYS: Record<string, string> = {
  customProviderConfig: "aiui-custom-provider-config",
  customProviderModels: "aiui-custom-provider-models",
  systemPrompts: "aiui-system-prompts",
  referencePresets: REFERENCE_PRESETS_STORAGE_KEY,
  modelProviders: "aiui-model-providers",
  textFonts: "aiui-text-fonts",
  textRenderingSettings: "aiui-text-rendering-settings",
  theme: "aiui-theme",
};

function readLocal(key: string): unknown {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEYS[key]);
    if (!raw) return undefined;
    if (key === "theme") return raw;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEYS[key], key === "theme" ? String(value) : JSON.stringify(value));
    // A same-window localStorage write does not emit the browser `storage`
    // event. Notify active pickers/panels so server-hydrated settings become
    // visible immediately on a new origin (for example, an ngrok URL).
    const eventByKey: Partial<Record<string, string>> = {
      customProviderConfig: "aiui-custom-provider-config-changed",
      customProviderModels: "aiui-custom-provider-models-changed",
      systemPrompts: "aiui-system-prompts-changed",
      referencePresets: REFERENCE_PRESETS_CHANGED_EVENT,
      modelProviders: "aiui-providers-changed",
      textFonts: "aiui-text-fonts-changed",
      textRenderingSettings: "aiui-text-rendering-settings-changed",
      theme: "aiui-theme-changed",
    };
    const event = eventByKey[key];
    if (event) window.dispatchEvent(new CustomEvent(event));
  } catch { /* noop */ }
}

function readPreferredModel(): unknown {
  return useChatSessionStore.getState().preferredModel;
}

function writePreferredModel(value: unknown) {
  if (typeof value === "string") useChatSessionStore.getState().setPreferredModel(value);
}

function readWorkflowUi(): unknown {
  const s = useWorkflowStore.getState();
  return {
    sidebarCollapsed: s.sidebarCollapsed,
    debugMode: s.debugMode,
    nodeDefaults: s.nodeDefaults,
    lastNodeSize: s.lastNodeSize,
  };
}

function writeWorkflowUi(value: unknown) {
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof o.sidebarCollapsed === "boolean") patch.sidebarCollapsed = o.sidebarCollapsed;
  if (typeof o.debugMode === "boolean") patch.debugMode = o.debugMode;
  if (o.nodeDefaults && typeof o.nodeDefaults === "object") patch.nodeDefaults = o.nodeDefaults;
  if (o.lastNodeSize && typeof o.lastNodeSize === "object") patch.lastNodeSize = o.lastNodeSize;
  useWorkflowStore.setState(patch as unknown as Parameters<typeof useWorkflowStore.setState>[0]);
}

interface SettingAccessor {
  read: () => unknown;
  write: (value: unknown) => void;
  isEmpty: (value: unknown) => boolean;
}

const SETTINGS: Record<string, SettingAccessor> = {
  customProviderConfig: {
    read: () => readLocal("customProviderConfig"),
    write: (v) => writeLocal("customProviderConfig", v),
    isEmpty: (v) => !v || typeof v !== "object" || !(v as { baseUrl?: unknown }).baseUrl,
  },
  customProviderModels: {
    read: () => readLocal("customProviderModels"),
    write: (v) => writeLocal("customProviderModels", v),
    isEmpty: (v) => !Array.isArray(v) || v.length === 0,
  },
  systemPrompts: {
    read: () => readLocal("systemPrompts"),
    write: (v) => writeLocal("systemPrompts", v),
    isEmpty: (v) => !v || typeof v !== "object",
  },
  referencePresets: {
    read: () => readLocal("referencePresets"),
    write: (v) => writeLocal("referencePresets", v),
    isEmpty: (v) => !v || typeof v !== "object" || !Array.isArray((v as { presets?: unknown }).presets),
  },
  modelProviders: {
    read: () => readLocal("modelProviders"),
    write: (v) => writeLocal("modelProviders", v),
    isEmpty: (v) => !v || typeof v !== "object" || Object.keys(v as object).length === 0,
  },
  textFonts: {
    read: () => readLocal("textFonts"),
    write: (v) => writeLocal("textFonts", v),
    isEmpty: (v) => !Array.isArray(v),
  },
  textRenderingSettings: {
    read: () => readLocal("textRenderingSettings"),
    write: (v) => writeLocal("textRenderingSettings", v),
    isEmpty: (v) => !v || typeof v !== "object",
  },
  theme: {
    read: loadTheme,
    write: (v) => saveTheme(normalizeTheme(v)),
    isEmpty: (v) => v !== "dark" && v !== "light",
  },
  preferredTextModel: {
    read: readPreferredModel,
    write: writePreferredModel,
    isEmpty: (v) => typeof v !== "string" || v.length === 0,
  },
  workflowUi: {
    read: readWorkflowUi,
    write: writeWorkflowUi,
    isEmpty: (v) => !v || typeof v !== "object",
  },
};

const SETTING_KEYS = Object.keys(SETTINGS);

async function pushSetting(key: string) {
  const value = SETTINGS[key].read();
  if (value === undefined || value === null || SETTINGS[key].isEmpty(value)) return;
  try {
    await fetch("/api/app-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { [key]: value } }),
    });
  } catch { /* offline / transient — ignore */ }
}

/**
 * Hydrates local settings from the server. Server values are authoritative and
 * overwrite local ones; when the server has no value but the browser does, the
 * local value is seeded to the server once.
 */
async function hydrateSettings() {
  let res: Response;
  try {
    res = await fetch("/api/app-settings");
  } catch {
    return;
  }
  if (!res.ok) return;
  const data = (await res.json().catch(() => null)) as { settings?: Record<string, unknown> } | null;
  const server = data?.settings ?? {};
  const toPush: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const serverValue = server[key];
    const localValue = SETTINGS[key].read();
    if (serverValue !== undefined && serverValue !== null) {
      SETTINGS[key].write(serverValue);
    } else if (localValue !== undefined && localValue !== null && !SETTINGS[key].isEmpty(localValue)) {
      toPush[key] = localValue;
    }
  }
  if (Object.keys(toPush).length > 0) {
    try {
      await fetch("/api/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: toPush }),
      });
    } catch { /* ignore */ }
  }
}

/**
 * Runs once on mount (local mode only): hydrates settings from the server and
 * pushes local changes back as they happen.
 */
export function useSettingsSync() {
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!IS_LOCAL_CLIENT) return;
    let cancelled = false;

    (async () => {
      await hydrateSettings();
      if (!cancelled) hydratedRef.current = true;
    })();

    const eventMap: [string, string][] = [
      ["aiui-custom-provider-config-changed", "customProviderConfig"],
      ["aiui-custom-provider-models-changed", "customProviderModels"],
      ["aiui-system-prompts-changed", "systemPrompts"],
      [REFERENCE_PRESETS_CHANGED_EVENT, "referencePresets"],
      ["aiui-providers-changed", "modelProviders"],
      ["aiui-text-fonts-changed", "textFonts"],
      ["aiui-text-rendering-settings-changed", "textRenderingSettings"],
      ["aiui-theme-changed", "theme"],
    ];
    const handlers = eventMap.map(([evt, key]) => {
      const handler = () => { if (hydratedRef.current) pushSetting(key); };
      window.addEventListener(evt, handler);
      return [evt, handler] as const;
    });

    const unsubChat = useChatSessionStore.subscribe((s, prev) => {
      if (hydratedRef.current && s.preferredModel !== prev.preferredModel) pushSetting("preferredTextModel");
    });
    const unsubWorkflow = useWorkflowStore.subscribe((s, prev) => {
      if (!hydratedRef.current) return;
      if (
        s.sidebarCollapsed !== prev.sidebarCollapsed ||
        s.debugMode !== prev.debugMode ||
        s.nodeDefaults !== prev.nodeDefaults ||
        s.lastNodeSize !== prev.lastNodeSize
      ) {
        pushSetting("workflowUi");
      }
    });

    return () => {
      cancelled = true;
      handlers.forEach(([evt, handler]) => window.removeEventListener(evt, handler));
      unsubChat();
      unsubWorkflow();
    };
  }, []);
}
