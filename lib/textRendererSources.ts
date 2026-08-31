import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "./store";
import { parseStyleProfileObject, readStyleComposition, type StyleComposition } from "./styleComposition";

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

/** Resolve only the deliberately typed inputs of a future deterministic text renderer. */
export function resolveTextRendererInputs(
  rendererId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
): TextRendererInputs {
  const inputs: TextRendererInputs = {};
  for (const edge of edges.filter((item) => item.target === rendererId)) {
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) continue;
    if (edge.targetHandle === "image" && (source.type === "generateNode" || source.type === "imageInputNode" || source.type === "textRendererNode")) {
      inputs.imageUrl = imageFromNode(source);
    }
    if (edge.targetHandle === "text" && source.type === "textContentNode") {
      const content = validTextContent(source.data.textContent);
      if (content) {
        inputs.content = content;
        inputs.textSourceId = source.id;
      }
    }
    // Copy Composer exposes its refined copy ONLY after the user explicitly
    // accepts it. Unaccepted proposals never reach the Text Renderer.
    if (edge.targetHandle === "text" && source.type === "copyComposerNode" && source.data.copyAccepted === true) {
      const content = validTextContent(source.data.refinedTextContent);
      if (content) {
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

export function hasRenderableText(content: TextContent | undefined): boolean {
  if (!content) return false;
  return [content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets].some((value) => value.trim().length > 0);
}
