import path from "node:path";
import type { NextConfig } from "next";

const configuredMode = process.env.HELIOS_MODE;
if (configuredMode && configuredMode !== "local" && configuredMode !== "cloud") {
  throw new Error(`Invalid HELIOS_MODE "${configuredMode}". Use "local" or "cloud".`);
}

// Mode is intentionally fixed at build time because client components need to
// know whether Supabase auth is available. Legacy guest flags remain supported.
const usingLegacyLocalMode =
  !configuredMode &&
  (process.env.GUEST_MODE === "true" || process.env.NEXT_PUBLIC_GUEST_MODE === "true");
const heliosMode = configuredMode ?? (usingLegacyLocalMode ? "local" : "cloud");

if (usingLegacyLocalMode) {
  console.warn("[HeliosGen] GUEST_MODE is deprecated; use HELIOS_MODE=local.");
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_HELIOS_MODE: heliosMode,
    // Temporary compatibility for client code that still uses the old name.
    NEXT_PUBLIC_GUEST_MODE: heliosMode === "local" ? "true" : "false",
  },
  allowedDevOrigins: ["192.168.64.2"],
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    proxyClientMaxBodySize: '30mb',
  },
  serverExternalPackages: ["undici", "better-sqlite3"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.r2.dev" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "*.replicate.delivery" },
      { protocol: "https", hostname: "pbxt.replicate.delivery" },
      { protocol: "https", hostname: "*.replicate.com" },
      { protocol: "https", hostname: "*.aiquickdraw.com" },
    ],
  },
};

export default nextConfig;
