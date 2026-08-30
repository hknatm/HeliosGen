/**
 * Shared Prompt Composer source/token resolution.
 *
 * Both the PromptComposerNode UI and the WorkflowCanvas "Run All" flow resolve
 * a composer's connected sources through these pure helpers, so canvas runs and
 * the on-canvas preview always agree.
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
 * Resolve the deterministic template for a composer node. The returned
 * `resolved` value is the deterministic output used in template mode and the
 * fallback when AI mode fails.
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
 * Build the prompt sent to the assistant model in AI mode. It carries the
 * deterministic template plus the resolved structured context (Variables,
 * legacy Brand, Style JSON) so the model composes deterministically-aware text.
 */
export function buildComposerPrompt(
  connectedValues: ResolvedWorkflowVariable[],
  resolved: string,
  template: string,
): string {
  const context = JSON.stringify(
    { variables: connectedValues.map((v) => ({ key: v.key, value: v.value })) },
    null,
    2,
  );
  return [
    "Resolve the prompt template below into a final, ready-to-use prompt for an image/video model.",
    "",
    "Structured variable context:",
    context,
    "",
    "Template:",
    template,
    "",
    "Resolved template with substitutions already applied (use this as the base):",
    resolved,
    "",
    "Output only the final prompt. Do not include explanations or markdown.",
  ].join("\n");
}
