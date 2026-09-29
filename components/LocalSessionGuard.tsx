"use client";

import { useEffect } from "react";

const LOGIN_PATH = "/login";
const SESSION_STATUS_INTERVAL_MS = 15_000;

function redirectToLogin() {
  if (window.location.pathname === LOGIN_PATH) return;
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`);
}

/** Redirect local-mode browser API calls as soon as the owner session expires. */
export default function LocalSessionGuard() {
  useEffect(() => {
    let stopped = false;
    let expiryTimer: number | undefined;
    const originalFetch = window.fetch;

    const scheduleExpiryCheck = (expiresAt: number) => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      // The session is fixed-lived and is not renewed. Redirect locally at the
      // signed expiry even if the status request happens while the tab is offline.
      expiryTimer = window.setTimeout(redirectToLogin, Math.max(0, expiresAt - Date.now() + 100));
    };

    const checkSession = async () => {
      try {
        const response = await originalFetch("/api/auth/local-status", { cache: "no-store" });
        if (!stopped && response.ok) {
          const status = await response.json() as { authenticated?: boolean; expiresAt?: number | null };
          if (status.authenticated !== true || typeof status.expiresAt !== "number") {
            redirectToLogin();
          } else {
            scheduleExpiryCheck(status.expiresAt);
          }
        }
      } catch {
        // A transient status request failure must not log the owner out.
      }
    };

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const request = args[0];
      const url = typeof request === "string"
        ? new URL(request, window.location.href)
        : request instanceof URL
          ? request
          : new URL(request.url, window.location.href);
      if (response.status === 401 && url.origin === window.location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/auth/local-status") {
        redirectToLogin();
      }
      return response;
    };

    void checkSession();
    const interval = window.setInterval(checkSession, SESSION_STATUS_INTERVAL_MS);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void checkSession(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
