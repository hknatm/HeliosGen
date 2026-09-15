import { applyTheme, DEFAULT_THEME, loadTheme, normalizeTheme, saveTheme, THEME_BOOT_SCRIPT, THEME_CHANGED_EVENT } from "../lib/theme";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

function main() {
  assert(normalizeTheme("light") === "light", "normalizes light");
  assert(normalizeTheme("dark") === "dark", "normalizes dark");
  assert(normalizeTheme("system") === DEFAULT_THEME, "invalid themes fall back to dark");
  assert(loadTheme() === DEFAULT_THEME, "server-side theme defaults to dark");

  const classes = new Set<string>();
  const events: string[] = [];
  const storage = new FakeStorage();
  const root = { dataset: {} as Record<string, string>, classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); } }, style: {} as Record<string, string> };
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
  (globalThis as unknown as { document: Document }).document = { documentElement: root } as unknown as Document;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = class { type: string; constructor(type: string) { this.type = type; } } as unknown as typeof CustomEvent;
  (globalThis as unknown as { window: Window }).window = { dispatchEvent(event: Event) { events.push(event.type); return true; } } as unknown as Window;

  applyTheme("light");
  assert(root.dataset.theme === "light" && !classes.has("dark") && root.style.colorScheme === "light", "applyTheme sets the light DOM state");
  saveTheme("dark");
  assert(storage.getItem("aiui-theme") === "dark", "saveTheme persists the raw theme value");
  assert(loadTheme() === "dark", "loadTheme reads the persisted theme value");
  assert(root.dataset.theme === "dark" && classes.has("dark") && root.style.colorScheme === "dark", "saveTheme applies the dark DOM state");
  assert(events.includes(THEME_CHANGED_EVENT), "saveTheme notifies same-window listeners");
  assert(THEME_BOOT_SCRIPT.includes("aiui-theme") && THEME_BOOT_SCRIPT.includes("dataset.theme") && THEME_BOOT_SCRIPT.includes("colorScheme"), "boot script applies the same persisted theme state before hydration");

  if (failures) process.exit(1);
  console.log("\nAll theme tests passed.");
}

main();
