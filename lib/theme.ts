export type AppTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "aiui-theme";
export const THEME_CHANGED_EVENT = "aiui-theme-changed";
export const DEFAULT_THEME: AppTheme = "dark";

export function normalizeTheme(value: unknown): AppTheme {
  return value === "light" ? "light" : "dark";
}

export function loadTheme(): AppTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: AppTheme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: theme }));
  } catch { /* storage can be unavailable in restricted browsing modes */ }
}

export const THEME_BOOT_SCRIPT = `(() => { try { const t = localStorage.getItem("${THEME_STORAGE_KEY}") === "light" ? "light" : "dark"; const e = document.documentElement; e.dataset.theme = t; e.classList.toggle("dark", t === "dark"); e.style.colorScheme = t; } catch {} })();`;
