/**
 * Focused tests for the single reusable AI Agent system prompt:
 * one editable prompt reused by all AI surfaces, code-owned composer/copy
 * contracts, and legacy stored prompt migration.
 *
 *   npx tsc -p scripts/tsconfig.test.json
 *   node .test-dist/scripts/test-system-prompt.js
 */
let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

// In a Node environment `window` is undefined, so loadSystemPrompts falls back
// to the default — which is exactly the behaviour non-migrated users see until
// Settings is opened. Test the pure contracts first.
async function main() {
  const mod = await import("../lib/systemPrompt");
  const {
    DEFAULT_AGENT_PROMPT,
    COMPOSER_OUTPUT_CONTRACT,
    COPY_OUTPUT_CONTRACT,
    getSystemPrompt,
    buildAgentSystemPrompt,
    loadSystemPrompts,
    saveSystemPrompts,
    resetSystemPrompts,
  } = mod;

  console.log("── Single editable AI Agent prompt (no browser) ─────────────");
  assert(getSystemPrompt("agent") === DEFAULT_AGENT_PROMPT, "getSystemPrompt('agent') returns the default agent prompt without a browser");
  assert(!!DEFAULT_AGENT_PROMPT.trim(), "the agent default prompt is non-empty");
  assert(!!COMPOSER_OUTPUT_CONTRACT.trim(), "the visual-composer output contract is non-empty (code-owned)");
  assert(!!COPY_OUTPUT_CONTRACT.trim(), "the structured-copy output contract is non-empty (code-owned)");

  console.log("── buildAgentSystemPrompt combines agent + code-owned contract ──");
  const combined = buildAgentSystemPrompt(COMPOSER_OUTPUT_CONTRACT);
  assert(combined.includes(DEFAULT_AGENT_PROMPT), "combined prompt embeds the agent prompt");
  assert(combined.includes("final prompt"), "combined prompt includes the composer contract");
  assert(buildAgentSystemPrompt() === DEFAULT_AGENT_PROMPT, "no contract → agent prompt only");

  console.log("── Legacy stored-prompt migration ───────────────────────────");
  // Fake a browser so loadSystemPrompts reads localStorage. Provide only the
  // old stored keys to prove sensible legacy migration into the single agent.
  class FakeStorage {
    private map = new Map<string, string>();
    getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
    setItem(k: string, v: string) { this.map.set(k, String(v)); }
    removeItem(k: string) { this.map.delete(k); }
  }
  const storage = new FakeStorage();
  (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: () => {} } as unknown as Window;
  (globalThis as unknown as { localStorage?: unknown }).localStorage = storage as unknown as Storage;
  (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent = class { constructor(type: string) { void type; } } as unknown as typeof CustomEvent;

  storage.setItem("aiui-system-prompts", JSON.stringify({ chat: "LEGACY-CHAT-VALUE" }));
  const migrated = loadSystemPrompts();
  assert(migrated.agent === "LEGACY-CHAT-VALUE", "legacy 'chat' stored prompt migrates into the single agent prompt");
  assert(Object.keys(migrated).length === 1, "only the single agent prompt is exposed (no per-surface keys)");

  storage.setItem("aiui-system-prompts", JSON.stringify({
    chat: "You are an elite AI prompt crafter specialized in image and video generation prompts.\n\nOLD DEFAULT",
    assistantNode: "MY-CUSTOM-ASSISTANT",
  }));
  assert(loadSystemPrompts().agent === "MY-CUSTOM-ASSISTANT", "a customized legacy AI prompt is not masked by the old default chat prompt");

  storage.setItem("aiui-system-prompts", JSON.stringify({ agent: "EXPLICIT-AGENT", chat: "LEGACY-CHAT-VALUE" }));
  assert(loadSystemPrompts().agent === "EXPLICIT-AGENT", "an explicitly saved agent prompt wins over every legacy key");

  const noPrior = loadSystemPrompts();
  // Remove legacy then reload to confirm default fallback.
  storage.removeItem("aiui-system-prompts");
  const afterReset = loadSystemPrompts();
  assert(afterReset.agent === DEFAULT_AGENT_PROMPT, "cleared storage falls back to the default agent prompt");

  // saveSystemPrompts writes only the agent key.
  saveSystemPrompts({ agent: "MY-CUSTOM-AGENT" });
  const saved = JSON.parse(storage.getItem("aiui-system-prompts") || "{}");
  assert(saved.agent === "MY-CUSTOM-AGENT", "saveSystemPrompts persists the single agent key");
  assert(Object.keys(saved).length === 1, "saveSystemPrompts writes only one key");

  resetSystemPrompts();
  assert(storage.getItem("aiui-system-prompts") === null, "resetSystemPrompts clears storage");

  // (noPrior is intentionally referenced to keep TS happy about the variable)
  void noPrior;

  if (failures) process.exit(1);
  console.log("\nAll system prompt tests passed.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
