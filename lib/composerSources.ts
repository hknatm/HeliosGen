/**
 * Shared Prompt Composer source resolution.
 *
 * The Prompt Composer is AI-only: it composes a final image/video prompt from
 * ONLY (a) the Settings → Text Prompts → Prompt Composer system message and
 * (b) the structured connected context (Variables / Style Profile / legacy
 * Brand key-value JSON). No hard-coded natural-language task or prompt-template
 * instructions are injected into the user prompt.
 *
 * The prompt body sent to /api/assistant is a deterministic JSON object built
 * only from connected source values. Legacy `template` data is kept readable as
 * compatibility data but is never rendered or used for new AI composition.
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "./store";
import { isProfileNode, profileJsonToFields, profileTokenPrefix } from "./profileNodes";
import {
  isValidVariableKey,
  resolveWorkflowTemplate,
  serializeVariableValue,
  type ResolvedWorkflowVariable,
  type WorkflowVariableField,
} from "./workflowVariables";

/** Legacy single-field sources (old Variable nodes stored a single key/value). */
function legacyField(source: Node<NodeData>): WorkflowVariableField[] {
  if (typeof source.data.variableKey !== "string" || !source.data.variableKey) return [];
  return [{
    id: `${source.id}-legacy`,
    key: source.data.variableKey,
    value: String(source.data.variableValue ?? ""),
    type: (source.data.variableType ?? "text") as WorkflowVariableField["type"],
  }];
}

/** Resolve the structured field rows exposed by a source node (variables editor, JSON profile, or legacy). */
export function profileSourceFieldsFor(source: Node<NodeData>): WorkflowVariableField[] {
  if (Array.isArray(source.data.variables) && source.data.variables.length > 0) {
    return source.data.variables as WorkflowVariableField[];
  }
  // JSON-first Style profiles: derive tokens from profileJson rather than variables.
  if (isProfileNode(source.type) && typeof source.data.profileJson === "string" && source.data.profileJson.trim()) {
    const parsed = profileJsonToFields(source.data.profileJson);
    if (parsed.length) return parsed;
  }
  return legacyField(source);
}

/**
 * Resolve all variables feeding a composer node as namespaced tokens
 * (`style.*` / `brand.*` for profile sources, unprefixed for Variable nodes).
 */
export function resolveComposerConnections(
  composerNodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
  targetHandle = "variables",
): ResolvedWorkflowVariable[] {
  const incoming = edges.filter((e) => e.target === composerNodeId && e.targetHandle === targetHandle);
  return incoming.flatMap((edge): ResolvedWorkflowVariable[] => {
    const source = nodes.find((n) => n.id === edge.source);
    if (!source || (source.type !== "variableNode" && !isProfileNode(source.type))) return [];
    const fields = profileSourceFieldsFor(source);
    const prefix = profileTokenPrefix(source.type);
    return fields
      .filter((field) => isValidVariableKey(field.key))
      .map((field) => ({
        key: `${prefix}${field.key}`,
        value: serializeVariableValue(field),
        sourceId: source.id,
        sourceLabel: String(source.data.label ?? (prefix ? "Profile" : "Variables")),
      }));
  });
}

export interface ComposerResolution {
  template: string;
  resolved: string;
  missingKeys: string[];
  duplicateKeys: string[];
  connectedValues: ResolvedWorkflowVariable[];
}

/**
 * Resolve the deterministic template for a composer node. Kept for legacy
 * compatibility only — the AI-only Composer does not use the resolved template
 * for new composition. The returned `connectedValues` feed the structured JSON
 * context sent to the model.
 */
export function resolveComposerTemplate(
  composerNodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): ComposerResolution {
  const connectedValues = resolveComposerConnections(composerNodeId, nodes, edges);
  const node = nodes.find((n) => n.id === composerNodeId);
  const template = typeof node?.data.template === "string"
    ? node.data.template
    : String(node?.data.prompt ?? "");
  const t = resolveWorkflowTemplate(template, connectedValues);
  return {
    template,
    resolved: t.resolved,
    missingKeys: t.missingKeys,
    duplicateKeys: t.duplicateKeys,
    connectedValues,
  };
}

/**
 * Structured, namespaced context object built ONLY from connected source values.
 *
 * Semantic hierarchy:
 *   - `variables` — direct/unprefixed values from Variable nodes
 *   - `style`     — keys from a connected Image Style Profile (style.*)
 *   - `brand`     — keys from a connected Brand Context (brand.*)
 *
 * Duplicate keys (same key from more than one source) and empty/missing values
 * are excluded so malformed or ambiguous data never silently resolves/overwrites.
 */
export interface ComposerContext {
  variables: Record<string, string>;
  style: Record<string, string>;
  brand: Record<string, string>;
}

/** Technical output metadata from a directly connected media target.
 * It is authored by the image/video node, not guessed by the Composer. */
export interface ComposerTargetMedia {
  type: "image" | "video";
  aspectRatio: string;
}

export function buildComposerContext(connectedValues: ResolvedWorkflowVariable[]): ComposerContext {
  const context: ComposerContext = { variables: {}, style: {}, brand: {} };
  const counts = new Map<string, number>();
  for (const v of connectedValues) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
  const duplicate = new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));

  for (const v of connectedValues) {
    if (duplicate.has(v.key)) continue;          // ambiguous — exclude entirely
    if (!v.value || !v.value.trim()) continue;   // missing/empty — exclude
    if (v.key.startsWith("style.")) context.style[v.key.slice("style.".length)] = v.value;
    else if (v.key.startsWith("brand.")) context.brand[v.key.slice("brand.".length)] = v.value;
    else context.variables[v.key] = v.value;
  }
  return context;
}

/**
 * Build the prompt body sent to the assistant model. It is JSON text alone —
 * no surrounding English instructions. The model's role/task/output rules come
 * exclusively from the Settings → Text Prompts → Prompt Composer system message.
 */
export function buildComposerTargetMedia(
  composerNodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): ComposerTargetMedia | undefined {
  const targetEdge = edges.find((edge) =>
    edge.source === composerNodeId && edge.targetHandle === "prompt" &&
    (nodes.find((node) => node.id === edge.target)?.type === "generateNode" ||
      nodes.find((node) => node.id === edge.target)?.type === "videoGeneratorNode"),
  );
  if (!targetEdge) return undefined;
  const target = nodes.find((node) => node.id === targetEdge.target);
  if (!target) return undefined;
  return {
    type: target.type === "videoGeneratorNode" ? "video" : "image",
    aspectRatio: typeof target.data.aspectRatio === "string" ? target.data.aspectRatio : target.type === "videoGeneratorNode" ? "16:9" : "1:1",
  };
}

export function buildComposerPrompt(
  connectedValues: ResolvedWorkflowVariable[],
  target?: ComposerTargetMedia,
): string {
  const context: ComposerContext & { target?: ComposerTargetMedia } = buildComposerContext(connectedValues);
  if (target) context.target = target;
  return JSON.stringify(context, null, 2);
}
