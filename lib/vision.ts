/**
 * Vision Assessment — analyse connected images with a vision-capable model.
 *
 * Presets are code-owned (structured data, not giant prompts). The node only
 * decides *what to assess*; transport reuses /api/assistant reference handling.
 */
import { customModelSupportsVision, loadCustomProviderConfig } from "./customProvider";
import { MULTIMODAL_AGENT_MODEL, type ReferenceImage } from "./referenceBundle";

export type VisionPresetId = "describe" | "quality" | "defects" | "style" | "brief" | "ocr";
export type VisionOutputMode = "text" | "json";

export const VISION_PRESETS: Array<{ id: VisionPresetId; label: string; instruction: string }> = [
  { id: "describe", label: "Describe", instruction: "Describe each image accurately: subject, setting, composition, lighting, colours and notable details." },
  { id: "quality", label: "Critique quality", instruction: "Critique technical and aesthetic quality: sharpness, exposure, colour, composition, artefacts and overall polish. Give a score from 1 to 10 for each image." },
  { id: "defects", label: "Detect defects", instruction: "Look for defects: distorted anatomy or hands, warped text, extra or missing objects, broken perspective, compression or generation artefacts. List each defect with its location, or state clearly that none were found." },
  { id: "style", label: "Extract style", instruction: "Extract the visual style as reusable art direction: palette, lighting, materials, camera, composition, mood and texture. Do not describe the specific subject." },
  { id: "brief", label: "Check against brief", instruction: "Assess whether each image satisfies the brief provided by the user. List what matches, what is missing or wrong, and give a clear pass or fail verdict." },
  { id: "ocr", label: "Read text", instruction: "Transcribe all visible text exactly as written, preserving line breaks and reading order. Mark unreadable parts as [unclear]." },
];

export const VISION_TEXT_CONTRACT = `You are a precise visual analyst. Base every statement only on what is visible in the attached images. Never invent details. When several images are attached, refer to them as Reference 1, Reference 2, and so on, matching the order given. Return only the assessment, without preamble.`;

export const VISION_JSON_CONTRACT = `${VISION_TEXT_CONTRACT}

Return ONLY one valid JSON object, with no markdown fences and no commentary, using exactly this shape:
{"summary": string, "score": number (1-10), "pass": boolean, "findings": [{"reference": number, "severity": "info"|"minor"|"major", "note": string}]}`;

export function visionPreset(id: unknown) {
  return VISION_PRESETS.find((preset) => preset.id === id) ?? VISION_PRESETS[0];
}

export function buildVisionUserPrompt(presetId: unknown, question: string, connectedText: string, references: ReferenceImage[]): string {
  const preset = visionPreset(presetId);
  const brief = [connectedText.trim(), question.trim()].filter(Boolean).join("\n\n");
  return [
    `Task: ${preset.instruction}`,
    brief ? `${preset.id === "brief" ? "Brief" : "Additional instructions"}:\n${brief}` : "",
    references.length
      ? ["Attached images, in order:", ...references.map((reference, index) => `Reference ${index + 1} — ${reference.name}${reference.usageNote ? ` (${reference.usageNote.replace(/\s+/g, " ")})` : ""}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
}

export function visionModelReady(model: string): boolean {
  return model === MULTIMODAL_AGENT_MODEL || customModelSupportsVision(model);
}

/** Strip optional markdown fences and validate model JSON; returns pretty JSON or throws. */
export function normalizeVisionJson(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The vision model did not return a JSON object. Try again or switch to text output.");
  try {
    return JSON.stringify(JSON.parse(cleaned.slice(start, end + 1)), null, 2);
  } catch {
    throw new Error("The vision model returned invalid JSON. Try again or switch to text output.");
  }
}

export interface VisionRunInput {
  model: string;
  presetId: unknown;
  outputMode: VisionOutputMode;
  question: string;
  connectedText: string;
  references: ReferenceImage[];
  headers: HeadersInit;
  signal?: AbortSignal;
  onDelta?: (accumulated: string) => void;
}

/** Streams a vision assessment through /api/assistant and returns the final text. */
export async function runVisionAssessment(input: VisionRunInput): Promise<string> {
  if (!input.references.length) throw new Error("Connect at least one image to assess.");
  if (!visionModelReady(input.model)) throw new Error("Select GPT 5.2 · Vision or a custom model marked Vision.");

  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      prompt: buildVisionUserPrompt(input.presetId, input.question, input.connectedText, input.references),
      model: input.model,
      references: input.references,
      systemPrompt: input.outputMode === "json" ? VISION_JSON_CONTRACT : VISION_TEXT_CONTRACT,
      ...(input.model.startsWith("custom:") ? { customProvider: { ...loadCustomProviderConfig(), vision: true } } : {}),
    }),
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Assessment failed" }));
    throw new Error(err.error ?? "Assessment failed");
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let terminal = false;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { terminal = true; break outer; }
      let parsed: {
        type?: string;
        error?: { message?: string };
        delta?: { type?: string; text?: string };
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };
      try { parsed = JSON.parse(payload) as typeof parsed; } catch { continue; }
      if (parsed.type === "error" || parsed.error) throw new Error(parsed.error?.message ?? "The AI provider stream failed.");
      if (parsed.type === "message_stop" || parsed.choices?.[0]?.finish_reason) terminal = true;
      const delta =
        (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" ? parsed.delta.text : null) ??
        parsed.choices?.[0]?.delta?.content ?? "";
      if (delta) { accumulated += delta; input.onDelta?.(accumulated); }
    }
  }
  if (!terminal) throw new Error("The assessment ended before completion. Please try again.");
  if (!accumulated.trim()) throw new Error("The vision model returned no text. Please try again.");
  return input.outputMode === "json" ? normalizeVisionJson(accumulated) : accumulated.trim();
}
