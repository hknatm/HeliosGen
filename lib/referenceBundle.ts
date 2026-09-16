import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "./store";
import { buildComposerPrompt, resolveComposerConnections } from "./composerSources";
import { COMPOSER_OUTPUT_CONTRACT, resolveAgentSystemPrompt } from "./systemPrompt";

export const MAX_AGENT_REFERENCES = 16;
export const MULTIMODAL_AGENT_MODEL = "gpt-5-2";

export interface ReferenceImage {
  id: string;
  sourceNodeId: string;
  name: string;
  usageNote: string;
  url: string;
}

export interface AgentReferencePackage {
  prompt: string;
  references: ReferenceImage[];
  signature: string;
}

const FRAME_OUT_HANDLES = new Set(["startFrameOut", "endFrameOut", "imagePickOut"]);

function imageUrl(source: Node<NodeData>, sourceHandle?: string | null): string | undefined {
  if (FRAME_OUT_HANDLES.has(sourceHandle ?? "")) {
    if (sourceHandle === "startFrameOut") return source.data.eagerStartFrameUrl as string | undefined;
    if (sourceHandle === "endFrameOut") return source.data.eagerEndFrameUrl as string | undefined;
    return source.data.capturedFrameUrl as string | undefined;
  }
  return (source.data.capturedFrameUrl ?? source.data.r2Url ?? source.data.inputImage ?? source.data.imageUrl) as string | undefined;
}

export function referenceName(source: Node<NodeData>): string {
  const authored = typeof source.data.referenceName === "string" ? source.data.referenceName.trim() : "";
  return authored || String(source.data.label ?? "Reference image");
}

export function directReference(source: Node<NodeData>, sourceHandle?: string | null): ReferenceImage | null {
  const url = imageUrl(source, sourceHandle);
  if (!url) return null;
  return {
    id: `${source.id}:${sourceHandle ?? "image"}`,
    sourceNodeId: source.id,
    name: referenceName(source),
    usageNote: typeof source.data.referenceUsage === "string" ? source.data.referenceUsage.trim() : "",
    url,
  };
}

export function resolveReferenceImages(
  nodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
  targetHandle: "references" | "image",
): { references: ReferenceImage[]; error?: string; packageSignature?: string } {
  const incoming = edges.filter((edge) => edge.target === nodeId && edge.targetHandle === targetHandle);
  const direct: ReferenceImage[] = [];
  let packaged: AgentReferencePackage | undefined;

  for (const edge of incoming) {
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) continue;

    if (source.type === "assistantNode" && edge.sourceHandle === "refsOut") {
      if (packaged || direct.length > 0 || incoming.length > 1) {
        return { references: [], error: "Use either one AI Agent reference bundle or direct reference images, not both." };
      }
      const candidate = source.data.referencePackage as AgentReferencePackage | undefined;
      if (!candidate?.signature || !Array.isArray(candidate.references) || !String(source.data.outputText ?? "").trim()) {
        return { references: [], error: "Run the connected AI Agent before using its references." };
      }
      const sourceReferences = resolveReferenceImages(source.id, nodes, edges, "references");
      if (sourceReferences.error) return { references: [], error: sourceReferences.error };
      const current = resolveAgentSignature(source.id, nodes, edges, sourceReferences.references);
      if (candidate.signature !== current) {
        return { references: [], error: "The AI Agent prompt or references changed. Run the Agent again before generating." };
      }
      packaged = candidate;
      continue;
    }

    if (source.type === "assistantNode") {
      return { references: [], error: "Connect the AI Agent REFERENCES output, not its PROMPT output, to image references." };
    }
    const ref = directReference(source, edge.sourceHandle);
    if (ref) direct.push(ref);
  }

  if (packaged) return { references: packaged.references.slice(0, MAX_AGENT_REFERENCES), packageSignature: packaged.signature };
  return { references: direct.slice(0, MAX_AGENT_REFERENCES) };
}

function textContentPrompt(content: TextContent | undefined): string {
  if (!content) return "";
  const parts = [content.eyebrow, content.title, content.subtitle, ...(content.bullets ?? []), content.cta];
  return parts.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean).join("\n");
}

export function resolveAgentAuthoredPrompt(nodeId: string, nodes: Node<NodeData>[], edges: Edge[]): string {
  const node = nodes.find((item) => item.id === nodeId);
  const local = typeof node?.data.localPrompt === "string" ? node.data.localPrompt.trim() : "";
  const promptEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === "prompt");
  const source = promptEdge ? nodes.find((item) => item.id === promptEdge.source) : undefined;
  let connected = "";
  if (source?.type === "promptNode") connected = String(source.data.prompt ?? "").trim();
  else if (source?.type === "assistantNode") connected = String(source.data.outputText ?? "").trim();
  else if (source?.type === "variableNode") connected = String(source.data.variableValue ?? "").trim();
  else if (source?.type === "promptComposerNode") connected = String(source.data.resolvedPrompt ?? source.data.prompt ?? "").trim();
  else if (source?.type === "textContentNode") connected = textContentPrompt(source.data.textContent as TextContent | undefined);
  return [connected, local].filter(Boolean).join("\n\n");
}

export function resolveAgentRequestPrompt(nodeId: string, nodes: Node<NodeData>[], edges: Edge[]): string {
  const authored = resolveAgentAuthoredPrompt(nodeId, nodes, edges);
  const values = resolveComposerConnections(nodeId, nodes, edges);
  return values.length ? buildComposerPrompt(values, undefined, authored) : authored;
}

export function resolveAgentSignature(nodeId: string, nodes: Node<NodeData>[], edges: Edge[], references: ReferenceImage[]): string {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const values = resolveComposerConnections(nodeId, nodes, edges);
  const systemPromptId = typeof node?.data.systemPromptId === "string" ? node.data.systemPromptId : undefined;
  return buildAgentInputSignature({
    prompt: resolveAgentRequestPrompt(nodeId, nodes, edges),
    model: String(node?.data.model ?? "claude-sonnet-4-6"),
    systemPrompt: resolveAgentSystemPrompt(systemPromptId, values.length ? COMPOSER_OUTPUT_CONTRACT : undefined),
    references,
  });
}

export function buildAgentInputSignature(input: {
  prompt: string;
  model: string;
  systemPrompt?: string;
  references: ReferenceImage[];
}): string {
  return JSON.stringify({
    prompt: input.prompt.trim(),
    model: input.model,
    systemPrompt: input.systemPrompt ?? "",
    references: input.references.map(({ id, sourceNodeId, name, usageNote, url }) => ({ id, sourceNodeId, name, usageNote, url })),
  });
}

export function validateAgentGenerationPackage(
  generatorNodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): { error?: string; packageSignature?: string } {
  const promptEdge = edges.find((edge) => edge.target === generatorNodeId && edge.targetHandle === "prompt");
  const refsEdge = edges.find((edge) => edge.target === generatorNodeId && edge.targetHandle === "image" && edge.sourceHandle === "refsOut");
  const promptSource = promptEdge ? nodes.find((node) => node.id === promptEdge.source) : undefined;

  if (refsEdge) {
    if (!promptEdge || promptEdge.source !== refsEdge.source || promptSource?.type !== "assistantNode") {
      return { error: "Connect both PROMPT and REFERENCES from the same AI Agent." };
    }
    const packageValue = promptSource.data.referencePackage as AgentReferencePackage | undefined;
    if (!packageValue?.signature || packageValue.prompt !== promptSource.data.outputText) {
      return { error: "Run the connected AI Agent again before generating." };
    }
    return { packageSignature: packageValue.signature };
  }

  const promptPackage = promptSource?.type === "assistantNode"
    ? promptSource.data.referencePackage as AgentReferencePackage | undefined
    : undefined;
  if (promptPackage?.references.length) {
    return { error: "Connect the AI Agent REFERENCES output together with its PROMPT output." };
  }
  if (promptSource?.type === "assistantNode" && String(promptSource.data.outputText ?? "").trim() && !promptPackage) {
    return { error: "Run the connected AI Agent again before generating." };
  }
  const directImageEdges = edges.filter((edge) => edge.target === generatorNodeId && edge.targetHandle === "image");
  if (directImageEdges.some((edge) => nodes.find((node) => node.id === edge.source)?.type === "assistantNode")) {
    return { error: "The AI Agent reference bundle is unavailable. Run the Agent again." };
  }
  return {};
}

export function numberedReferencePrompt(references: ReferenceImage[]): string {
  if (!references.length) return "";
  return [
    "Reference contract (the attached images appear in exactly this order):",
    ...references.map((reference, index) =>
      `Reference ${index + 1} — ${reference.name}${reference.usageNote ? `\nUsage: ${reference.usageNote}` : ""}`,
    ),
    "In the final image-generation prompt, refer to these inputs only as Reference 1, Reference 2, and so on. Preserve that numbering exactly. Explain what each reference contributes and what must not be copied when the usage note limits its role.",
  ].join("\n\n");
}
