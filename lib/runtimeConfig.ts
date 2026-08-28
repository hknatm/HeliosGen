export type HeliosMode = "local" | "cloud";

// next.config.ts always supplies NEXT_PUBLIC_HELIOS_MODE to both bundles.
// HELIOS_MODE is only a fallback for direct server-side/test imports.
const configuredMode = process.env.NEXT_PUBLIC_HELIOS_MODE || process.env.HELIOS_MODE;
const legacyLocalMode =
  process.env.NEXT_PUBLIC_GUEST_MODE === "true" || process.env.GUEST_MODE === "true";

function isHeliosMode(value: string | undefined): value is HeliosMode {
  return value === "local" || value === "cloud";
}

if (configuredMode && !isHeliosMode(configuredMode)) {
  throw new Error(
    `Invalid Helios mode "${configuredMode}". Set HELIOS_MODE to "local" or "cloud".`,
  );
}

/**
 * The deployment mode is selected when the application is built.
 *
 * `GUEST_MODE` and `NEXT_PUBLIC_GUEST_MODE` remain supported as legacy aliases
 * so existing self-hosted installations continue to start in local mode.
 */
export const HELIOS_MODE: HeliosMode = isHeliosMode(configuredMode)
  ? configuredMode
  : legacyLocalMode
    ? "local"
    : "cloud";

export const IS_LOCAL_MODE = HELIOS_MODE === "local";
export const IS_CLOUD_MODE = HELIOS_MODE === "cloud";

export const RUNTIME_CONFIG = Object.freeze({
  mode: HELIOS_MODE,
  singleUser: IS_LOCAL_MODE,
  database: IS_LOCAL_MODE ? "local" : "supabase",
  mediaStorage: IS_LOCAL_MODE ? "local-disk" : "r2",
} as const);
