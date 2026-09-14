/**
 * Single, reusable editable AI Agent system prompt.
 *
 * Settings exposes ONE editable prompt ("AI Agent") that all AI surfaces reuse
 * (chat, Quick Assist, Assistant/AI Agent node, workflow run rewrites).
 *
 * Task-specific visual-composer and structured-copy output contracts are NOT
 * editable Settings prompts. They are code-owned internal instructions in this
 * file and are appended to the agent prompt at call time by the nodes that
 * need them (Prompt Composer / AI Agent-with-context and the Text Overlay's AI
 * refinement).
 *
 * Legacy stored prompts: a user's previously saved single "chat" prompt is
 * reused as the agent prompt on migration. The old per-surface keys
 * (assistantNode / workflowRun / promptComposer / copyComposer) remain fallback
 * candidates for installations that did not customize the former chat prompt.
 * They are no longer editable and their output contracts now live in code.
 */

export type SystemPromptId = "agent";

/** The single reusable editable prompt shared by every AI surface. */
export const DEFAULT_AGENT_PROMPT = `You are HeliosGen's creative production assistant. Follow the user's request and any task-specific output contract. Preserve supplied facts and intent, make the result clear and useful, and never invent unsupported claims. Return only the requested output unless the user asks for an explanation.`;

export const DEFAULT_SYSTEM_PROMPTS: Record<SystemPromptId, string> = {
  agent: DEFAULT_AGENT_PROMPT,
};

/** Internal, code-owned visual-composer output contract (not shown in Settings). */
export const COMPOSER_OUTPUT_CONTRACT = `You are composing ONE final, polished, ready-to-use native-language visual prompt for an image or video generation model.

You will receive a single JSON object containing structured context:
- "variables": direct/unprefixed key-value pairs from connected Variable nodes
- "style": key-value pairs from a connected Image Style Profile
- "brand": key-value pairs from a connected Brand Context
- optional "target": the exact media type and aspect ratio selected by the connected Image or Video node

Rules:
- Use every concrete value from the context when it is relevant (colors, lighting, background, visual rules, brand voice).
- Treat composition, subject placement, copy space, and copy-area avoidance as visual direction. Translate them into natural model language; never echo JSON keys, coordinates, object notation, or implementation instructions.
- If a target is present, adapt framing and composition to its media type and aspect ratio.
- When a copy space is specified, clearly ask for it to remain clean, low-detail, unobstructed, and free of generated typography. It is reserved for a later deterministic overlay.
- Add helpful, model-friendly visual detail consistent with the stated context, but never invent product facts, claims, text content, or visual requirements not supported by the context.
- Respect any "avoid" rules in the context — never re-insert what should be avoided.
- Keep the final prompt concise but highly descriptive.
- OUTPUT ONLY the final prompt. No explanations, no preambles, no markdown, no quotes, no JSON.`;

/** Internal, code-owned structured-copy output contract (not shown in Settings). */
export const COPY_OUTPUT_CONTRACT = `You are a copy editor for advertising and marketing assets.

You will receive a single JSON object containing:
- "raw": the exact authored copy (eyebrow, title, subtitle, bullets, cta)
- "variables": optional key-value pairs from connected Variable nodes
- "brand": optional key-value pairs from a connected Brand Context node

Rules:
- NEVER invent facts, claims, numbers, prices, dates, testimonials, or product attributes that are not present in the raw copy or context.
- You may rephrase, tighten, and polish the provided copy for clarity and impact, but you must preserve its meaning and never add unsupported claims.
- Use brand voice and tone from the brand context when present.
- Use variable values only where they naturally fit the copy; never fabricate values.
- Keep the same number of bullet points as the raw copy (or fewer — never more).
- Do not add a title or eyebrow where the source had none.
- Output ONLY a single JSON object with exactly these keys (all strings; bullets is an array of strings):
  {"eyebrow": "...", "title": "...", "subtitle": "...", "bullets": ["..."], "cta": "..."}
- No text outside the JSON object. No markdown, no code fences, no explanations.`;

const STORAGE_KEY = "aiui-system-prompts";

/** Legacy storage keys that were once individually editable (now consolidated). */
const LEGACY_KEYS = ["chat", "assistantNode", "workflowRun", "promptComposer", "copyComposer"] as const;

// Exact short legacy defaults. A default chat value must not mask a customized
// Assistant/Workflow prompt during migration. The former long chat/composer
// defaults are detected by their stable opening text below.
const LEGACY_DEFAULTS: Partial<Record<(typeof LEGACY_KEYS)[number], string>> = {
  assistantNode: "You are a senior prompt engineer specializing in optimizing prompts for clarity, precision, and effectiveness. Your task is to take an existing user prompt and rewrite it to improve its structure, specificity, and performance for an AI model. Preserve the original intent while enhancing wording, removing ambiguity, and adding useful detail where appropriate. Do not change the task itself. Output only the improved prompt. Do not include any explanations, comments, formatting markers, or quotation marks.",
  workflowRun: "You are an expert prompt engineer. Rewrite the user's prompt to be clearer, more specific, and more effective for an AI model. Output only the improved prompt — no explanation, no preamble, no quotes, no commentary of any kind.",
};

function isLegacyDefault(key: (typeof LEGACY_KEYS)[number], value: string): boolean {
  if (LEGACY_DEFAULTS[key] === value) return true;
  if (key === "chat") return value.startsWith("You are an elite AI prompt crafter specialized in image and video generation prompts.");
  if (key === "promptComposer") return value.startsWith("You are an expert prompt composer for AI image and video generation.");
  if (key === "copyComposer") return value.startsWith("You are an expert copy editor for advertising and marketing assets.");
  return false;
}

export function loadSystemPrompts(): Record<SystemPromptId, string> {
  if (typeof window === "undefined") return { ...DEFAULT_SYSTEM_PROMPTS };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Record<string, unknown>>;
    // Explicitly saved agent prompt wins. Otherwise prefer the first customized
    // legacy value, falling back to chat only when all stored values are defaults.
    let agent = (typeof stored.agent === "string" && stored.agent.trim())
      ? stored.agent.trim()
      : undefined;
    if (!agent) {
      const legacyValues = LEGACY_KEYS.flatMap((key) => {
        const value = stored[key];
        return typeof value === "string" && value.trim() ? [{ key, value: value.trim() }] : [];
      });
      agent = legacyValues.find(({ key, value }) => !isLegacyDefault(key, value))?.value
        ?? legacyValues.find(({ key }) => key === "chat")?.value
        ?? legacyValues[0]?.value;
    }
    return { agent: agent ?? DEFAULT_AGENT_PROMPT };
  } catch {
    return { ...DEFAULT_SYSTEM_PROMPTS };
  }
}

export function getSystemPrompt(id: SystemPromptId = "agent"): string {
  return loadSystemPrompts()[id];
}

/**
 * Combine the reusable editable agent prompt with a code-owned task contract.
 * Used by visual-composer and structured-copy surfaces so their output
 * contracts stay internal (in code) while still reusing the agent prompt.
 */
export function buildAgentSystemPrompt(contract?: string): string {
  const agent = getSystemPrompt("agent");
  if (!contract || !contract.trim()) return agent;
  return `${agent}\n\n${contract.trim()}`;
}

export function saveSystemPrompts(prompts: Record<SystemPromptId, string>): void {
  try {
    const next: Record<string, string> = {
      agent: typeof prompts.agent === "string" ? prompts.agent : "",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("aiui-system-prompts-changed"));
  } catch { /* noop */ }
}

export function resetSystemPrompts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("aiui-system-prompts-changed"));
  } catch { /* noop */ }
}

/** @deprecated Prefer getSystemPrompt("agent") in client components. */
export const SYSTEM_PROMPT = DEFAULT_AGENT_PROMPT;
