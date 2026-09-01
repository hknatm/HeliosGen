/**
 * Shared Copy Composer source resolution + strict structured-copy parsing.
 *
 * The Copy Composer is AI-only: it refines the exact authored copy from a
 * connected Text Content node (plus optional Variables / Brand Context) into a
 * strict structured JSON object. It never invents factual claims — the model is
 * instructed to only rephrase/polish the provided raw copy, and the parser only
 * accepts the exact JSON keys the model is allowed to emit.
 *
 * The raw text is preserved verbatim on the node (`rawTextContent`) for review.
 * Only copy the user explicitly accepts (`copyAccepted === true`) is exposed to
 * a downstream Text Renderer via `refinedTextContent`.
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "./store";
import { profileTokenPrefix } from "./profileNodes";
import { buildComposerContext, profileSourceFieldsFor } from "./composerSources";
import {
  isValidVariableKey,
  serializeVariableValue,
  type ResolvedWorkflowVariable,
} from "./workflowVariables";

/** The exact copy fields the model is allowed to emit (no font/color/alignment). */
export interface RefinedCopyFields {
  eyebrow: string;
  title: string;
  subtitle: string;
  bullets: string[];
  cta: string;
}

const MAX_COPY_FIELD_LENGTH = 500;
const MAX_COPY_BULLETS = 5;

export interface CopyComposerInputs {
  /** The exact authored copy from the connected Text Content node. */
  raw?: TextContent;
  textSourceId?: string;
  /** Optional Variables / Brand Context values (namespaced tokens). */
  connectedValues: ResolvedWorkflowVariable[];
}

function validTextContent(value: unknown): TextContent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<TextContent>;
  if (!Array.isArray(input.bullets)) return undefined;
  return {
    eyebrow: typeof input.eyebrow === "string" ? input.eyebrow : "",
    title: typeof input.title === "string" ? input.title : "",
    subtitle: typeof input.subtitle === "string" ? input.subtitle : "",
    bullets: input.bullets.filter((item): item is string => typeof item === "string"),
    cta: typeof input.cta === "string" ? input.cta : "",
    fontFamily: typeof input.fontFamily === "string" ? input.fontFamily : "Arial",
    textColor: typeof input.textColor === "string" ? input.textColor : "#FFFFFF",
    accentColor: typeof input.accentColor === "string" ? input.accentColor : "#F59E0B",
    alignment: input.alignment === "center" || input.alignment === "right" ? input.alignment : "left",
  };
}

/**
 * Resolve the Copy Composer's deliberately typed inputs:
 *   - `text` handle: exactly one Text Content node (required)
 *   - `variables` handle: Variable nodes + Brand Context nodes (optional)
 * Image Style Profiles are intentionally excluded — the Copy Composer refines
 * copy, it does not consume visual style direction.
 */
export function resolveCopyComposerInputs(
  composerId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): CopyComposerInputs {
  const connectedValues: ResolvedWorkflowVariable[] = [];
  let raw: TextContent | undefined;
  let textSourceId: string | undefined;

  for (const edge of edges.filter((e) => e.target === composerId)) {
    const source = nodes.find((n) => n.id === edge.source);
    if (!source) continue;

    if (edge.targetHandle === "text" && source.type === "textContentNode") {
      const content = validTextContent(source.data.textContent);
      if (content) {
        raw = content;
        textSourceId = source.id;
      }
    }

    if (
      edge.targetHandle === "variables" &&
      (source.type === "variableNode" || source.type === "brandProfileNode")
    ) {
      const fields = profileSourceFieldsFor(source);
      const prefix = profileTokenPrefix(source.type);
      for (const field of fields) {
        if (!isValidVariableKey(field.key)) continue;
        connectedValues.push({
          key: `${prefix}${field.key}`,
          value: serializeVariableValue(field),
          sourceId: source.id,
          sourceLabel: String(source.data.label ?? (prefix ? "Profile" : "Variables")),
        });
      }
    }
  }

  return { raw, textSourceId, connectedValues };
}

/** Structured context object built ONLY from connected source values. */
export interface CopyComposerContext {
  raw: TextContent;
  variables: Record<string, string>;
  brand: Record<string, string>;
}

export function buildCopyComposerContext(inputs: CopyComposerInputs): CopyComposerContext {
  const context = buildComposerContext(inputs.connectedValues);
  return {
    raw: inputs.raw ?? {
      eyebrow: "", title: "", subtitle: "", bullets: [], cta: "",
      fontFamily: "Arial", textColor: "#FFFFFF", accentColor: "#F59E0B", alignment: "left",
    },
    variables: context.variables,
    brand: context.brand,
  };
}

/** The prompt body sent to the assistant model — JSON text alone. */
export function buildCopyComposerPrompt(inputs: CopyComposerInputs): string {
  return JSON.stringify(buildCopyComposerContext(inputs), null, 2);
}

/**
 * Parse the model's strict structured-copy JSON. Accepts optional markdown code
 * fences. Returns null for any non-object / malformed payload so a garbled
 * model response can never leak downstream.
 */
export function parseCopyJson(raw: string): RefinedCopyFields | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const expectedKeys = ["eyebrow", "title", "subtitle", "bullets", "cta"];
  if (Object.keys(obj).length !== expectedKeys.length || !expectedKeys.every((key) => key in obj)) return null;
  if (
    typeof obj.eyebrow !== "string" ||
    typeof obj.title !== "string" ||
    typeof obj.subtitle !== "string" ||
    typeof obj.cta !== "string" ||
    !Array.isArray(obj.bullets) ||
    !obj.bullets.every((bullet) => typeof bullet === "string")
  ) return null;
  return {
    eyebrow: obj.eyebrow.slice(0, MAX_COPY_FIELD_LENGTH),
    title: obj.title.slice(0, MAX_COPY_FIELD_LENGTH),
    subtitle: obj.subtitle.slice(0, MAX_COPY_FIELD_LENGTH),
    bullets: obj.bullets.slice(0, MAX_COPY_BULLETS).map((bullet) => bullet.slice(0, MAX_COPY_FIELD_LENGTH)),
    cta: obj.cta.slice(0, MAX_COPY_FIELD_LENGTH),
  };
}

/** Merge the model's copy fields onto the raw text, preserving its typography. */
export function mergeRefinedCopy(raw: TextContent, refined: RefinedCopyFields): TextContent {
  return {
    ...raw,
    eyebrow: refined.eyebrow,
    title: refined.title,
    subtitle: refined.subtitle,
    bullets: refined.bullets,
    cta: refined.cta,
  };
}

export function hasRefinedCopy(content: TextContent | undefined): boolean {
  if (!content) return false;
  return [content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets]
    .some((value) => value.trim().length > 0);
}

export interface CopyValidation {
  ok: boolean;
  warnings: string[];
}

/**
 * Bounded "never invent" guard. Rejects structural additions the model is not
 * allowed to make: more bullets than the source, or a headline/eyebrow where
 * the source had none. Wording-level polish is intentionally not policed here
 * (that is the system prompt's job) — this blocks clear fabrication.
 */
export function validateRefinedCopy(
  raw: TextContent | undefined,
  refined: RefinedCopyFields,
): CopyValidation {
  const warnings: string[] = [];
  if (raw) {
    const rawBullets = raw.bullets.filter((b) => b.trim()).length;
    const refinedBullets = refined.bullets.filter((b) => b.trim()).length;
    if (refinedBullets > rawBullets) {
      warnings.push(`Refined text adds ${refinedBullets - rawBullets} bullet(s) beyond the ${rawBullets} in the source.`);
    }
    const guardedFields: Array<[keyof Pick<RefinedCopyFields, "eyebrow" | "title" | "subtitle" | "cta">, string]> = [
      ["eyebrow", "eyebrow"], ["title", "title"], ["subtitle", "subtitle"], ["cta", "CTA"],
    ];
    for (const [field, label] of guardedFields) {
      if (!raw[field].trim() && refined[field].trim()) warnings.push(`Refined text adds a ${label} where the source had none.`);
      if (raw[field].trim() && !refined[field].trim()) warnings.push(`Refined text removes the source ${label}.`);
    }
  }
  return { ok: warnings.length === 0, warnings };
}
