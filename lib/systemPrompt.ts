/**
 * Reusable AI Agent system prompts.
 *
 * Settings owns one global default plus named presets. Chat, Quick Assist, and
 * legacy AI surfaces continue to use the global default. Each AI Agent node may
 * select a preset; task-specific output contracts remain code-owned here.
 */

export type SystemPromptId = "agent";

export interface SystemPromptPreset {
  id: string;
  name: string;
  tags: string[];
  content: string;
}

export interface SystemPromptSettings {
  version: 2;
  agent: string;
  presets: SystemPromptPreset[];
}

export const DEFAULT_AGENT_PROMPT = `You are HeliosGen's creative production assistant. Follow the user's request and any task-specific output contract. Preserve supplied facts and intent, make the result clear and useful, and never invent unsupported claims. Return only the requested output unless the user asks for an explanation.`;

export const DEFAULT_SYSTEM_PROMPTS: Record<SystemPromptId, string> = {
  agent: DEFAULT_AGENT_PROMPT,
};

export const DEFAULT_SYSTEM_PROMPT_SETTINGS: SystemPromptSettings = {
  version: 2,
  agent: DEFAULT_AGENT_PROMPT,
  presets: [],
};

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
const LEGACY_KEYS = ["chat", "assistantNode", "workflowRun", "promptComposer", "copyComposer"] as const;
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

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function normalizePresets(value: unknown): SystemPromptPreset[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!id || ids.has(id) || !name || !content) return [];
    ids.add(id);
    return [{ id, name: name.slice(0, 80), tags: normalizeTags(item.tags), content }];
  }).slice(0, 100);
}

export function normalizeSystemPromptSettings(value: unknown): SystemPromptSettings {
  const stored = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<string, unknown>>
    : {};
  let agent = typeof stored.agent === "string" && stored.agent.trim() ? stored.agent.trim() : undefined;
  if (!agent) {
    const legacyValues = LEGACY_KEYS.flatMap((key) => {
      const legacyValue = stored[key];
      return typeof legacyValue === "string" && legacyValue.trim() ? [{ key, value: legacyValue.trim() }] : [];
    });
    agent = legacyValues.find(({ key, value: legacyValue }) => !isLegacyDefault(key, legacyValue))?.value
      ?? legacyValues.find(({ key }) => key === "chat")?.value
      ?? legacyValues[0]?.value;
  }
  return {
    version: 2,
    agent: agent ?? DEFAULT_AGENT_PROMPT,
    presets: normalizePresets(stored.presets),
  };
}

export function loadSystemPromptSettings(): SystemPromptSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SYSTEM_PROMPT_SETTINGS, presets: [] };
  try {
    return normalizeSystemPromptSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_SYSTEM_PROMPT_SETTINGS, presets: [] };
  }
}

export function loadSystemPrompts(): Record<SystemPromptId, string> {
  return { agent: loadSystemPromptSettings().agent };
}

export function getSystemPrompt(id: SystemPromptId = "agent"): string {
  return loadSystemPrompts()[id];
}

export function buildAgentSystemPrompt(contract?: string, basePrompt = getSystemPrompt("agent")): string {
  const base = basePrompt.trim() || DEFAULT_AGENT_PROMPT;
  if (!contract?.trim()) return base;
  return `${base}\n\n${contract.trim()}`;
}

export function resolveAgentSystemPrompt(presetId?: string, contract?: string): string {
  const settings = loadSystemPromptSettings();
  const base = presetId ? settings.presets.find((preset) => preset.id === presetId)?.content : undefined;
  return buildAgentSystemPrompt(contract, base ?? settings.agent);
}

export function findSystemPromptPreset(presetId?: string): SystemPromptPreset | undefined {
  return presetId ? loadSystemPromptSettings().presets.find((preset) => preset.id === presetId) : undefined;
}

export function saveSystemPromptSettings(settings: SystemPromptSettings): void {
  try {
    const normalized = normalizeSystemPromptSettings(settings);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent("aiui-system-prompts-changed"));
  } catch { /* noop */ }
}

export function saveSystemPrompts(prompts: Record<SystemPromptId, string>): void {
  const current = loadSystemPromptSettings();
  saveSystemPromptSettings({ ...current, agent: typeof prompts.agent === "string" ? prompts.agent : "" });
}

export function resetSystemPrompts(): void {
  const current = loadSystemPromptSettings();
  saveSystemPromptSettings({ ...current, agent: DEFAULT_AGENT_PROMPT });
}

/** @deprecated Prefer getSystemPrompt("agent") in client components. */
export const SYSTEM_PROMPT = DEFAULT_AGENT_PROMPT;
