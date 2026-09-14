import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "./store";
import { parseStyleProfileObject, readStyleComposition, type StyleComposition } from "./styleComposition";
import { hasRefinedCopy, rawCopySignature } from "./copyComposer";
import type { TextRenderingSettings } from "./textRenderingSettings";

export interface TextRendererInputs {
  imageUrl?: string;
  content?: TextContent;
  composition?: StyleComposition;
  textSourceId?: string;
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
    fontFamily: typeof input.fontFamily === "string" ? input.fontFamily as TextContent["fontFamily"] : "Arial",
    textColor: typeof input.textColor === "string" ? input.textColor : "#FFFFFF",
    accentColor: typeof input.accentColor === "string" ? input.accentColor : "#F59E0B",
    alignment: input.alignment === "center" || input.alignment === "right" ? input.alignment : "left",
  };
}

function imageFromNode(node: Node<NodeData>): string | undefined {
  const value = node.data.imageUrl ?? node.data.r2Url ?? node.data.inputImage;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function resolveTextRendererContent(inputs: TextRendererInputs, data: NodeData): TextContent | undefined {
  const refined = data.refinedTextContent as TextContent | undefined;
  if (
    data.copyAccepted === true &&
    refined &&
    data.copyAcceptedRawSignature === rawCopySignature(inputs.content) &&
    hasRefinedCopy(refined)
  ) return refined;
  return inputs.content;
}

/** Resolve only the deliberately typed inputs of a future deterministic text renderer. */
export function resolveTextRendererInputs(
  rendererId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): TextRendererInputs {
  const renderer = nodes.find((node) => node.id === rendererId);
  const ownContent = validTextContent(renderer?.data.textContent);
  const inputs: TextRendererInputs = {
    ...(ownContent && hasRenderableText(ownContent) ? { content: ownContent, textSourceId: rendererId } : {}),
  };
  for (const edge of edges.filter((item) => item.target === rendererId)) {
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) continue;
    if (edge.targetHandle === "image" && (source.type === "generateNode" || source.type === "imageInputNode" || source.type === "textRendererNode")) {
      inputs.imageUrl = imageFromNode(source);
    }
    if (edge.targetHandle === "text" && source.type === "textContentNode") {
      const content = validTextContent(source.data.textContent);
      if (!inputs.content && content) {
        inputs.content = content;
        inputs.textSourceId = source.id;
      }
    }
    // Copy Composer exposes its refined copy ONLY after the user explicitly
    // accepts it AND the accepted copy still matches its source. Unaccepted or
    // stale proposals never reach the Text Renderer.
    if (edge.targetHandle === "text" && source.type === "copyComposerNode" && copyComposerIsUsable(source, nodes)) {
      const content = validTextContent(source.data.refinedTextContent);
      if (!inputs.content && content) {
        inputs.content = content;
        inputs.textSourceId = source.id;
      }
    }
    if (edge.targetHandle === "style" && source.type === "styleProfileNode") {
      const profile = parseStyleProfileObject(typeof source.data.profileJson === "string" ? source.data.profileJson : "");
      if (profile) inputs.composition = readStyleComposition(profile);
    }
  }
  return inputs;
}

/**
 * True when a Copy Composer node's accepted copy is still valid: it was
 * explicitly accepted AND its source signature still matches the connected
 * Text Content node it was derived from. Stale acceptances (source edited
 * after approval) are treated as unaccepted so they never reach the renderer.
 */
export function copyComposerIsUsable(source: Node<NodeData>, nodes: Node<NodeData>[]): boolean {
  if (source.data.copyAccepted !== true) return false;
  const acceptedSig = source.data.copyAcceptedRawSignature;
  const sourceId = source.data.copySourceId;
  if (typeof acceptedSig !== "string" || typeof sourceId !== "string") return false;
  const rawSource = nodes.find((node) => node.id === sourceId);
  const raw = rawSource ? validTextContent(rawSource.data.textContent) : undefined;
  return !!raw && rawCopySignature(raw) === acceptedSig;
}

/** Stable signature of everything the renderer composites — used to flag stale results. */
export function rendererInputSignature(
  inputs: TextRendererInputs,
  settings: TextRenderingSettings,
  fontUrl?: string,
  fontFamilyKey?: string,
): string {
  if (!inputs.imageUrl || !inputs.content || !inputs.composition) return "";
  return JSON.stringify({
    imageUrl: inputs.imageUrl,
    content: inputs.content,
    composition: inputs.composition,
    settings,
    fontUrl: fontUrl ?? null,
    fontFamilyKey: fontFamilyKey ?? null,
  });
}

export function hasRenderableText(content: TextContent | undefined): boolean {
  if (!content) return false;
  return [content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets].some((value) => value.trim().length > 0);
}
