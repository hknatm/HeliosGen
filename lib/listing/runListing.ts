import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "../store";
import { profileSourceFieldsFor } from "../composerSources";
import { serializeVariableValue } from "../workflowVariables";
import { streamAssistantText } from "../vision";
import type { ReferenceImage } from "../referenceBundle";
import { LISTING_SLOTS } from "./etsySlots";
import {
  parseSkipReply, slotSystemPrompt, slotUserPrompt,
  type ListingFact, type ListingSlotState,
} from "./etsyFlow";

export interface ListingImageSettings { model: string; aspectRatio: string; quality: string }

const SPEC_SOURCES = new Set(["variableNode", "brandProfileNode", "styleProfileNode"]);

/** Parse "key: value" lines typed on the node itself. */
export function parseFactLines(text: string): ListingFact[] {
  return text.split("\n").flatMap((line) => {
    const i = line.indexOf(":");
    if (i <= 0) return line.trim() ? [{ key: "note", value: line.trim() }] : [];
    return [{ key: line.slice(0, i).trim().toLowerCase().replace(/\s+/g, "_"), value: line.slice(i + 1).trim() }];
  }).filter((fact) => fact.value);
}

/** Facts from connected spec nodes plus the on-node notes. */
export function resolveListingFacts(nodeId: string, nodes: Node<NodeData>[], edges: Edge[]): ListingFact[] {
  const facts: ListingFact[] = [];
  for (const edge of edges) {
    if (edge.target !== nodeId || edge.targetHandle !== "specs") continue;
    const source = nodes.find((n) => n.id === edge.source);
    if (!source || !SPEC_SOURCES.has(source.type ?? "")) continue;
    for (const field of profileSourceFieldsFor(source)) {
      const value = serializeVariableValue(field).trim();
      if (field.key && value) facts.push({ key: field.key, value });
    }
  }
  const node = nodes.find((n) => n.id === nodeId);
  facts.push(...parseFactLines(typeof node?.data.listingNotes === "string" ? node.data.listingNotes : ""));
  return facts;
}

/** Image model settings come from a connected Image node. */
export function resolveListingImageSettings(nodeId: string, nodes: Node<NodeData>[], edges: Edge[]): ListingImageSettings | null {
  const edge = edges.find((e) => e.target === nodeId && e.targetHandle === "settings");
  const source = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  if (!source || source.type !== "generateNode") return null;
  return {
    model: (source.data.model as string | undefined) ?? "nano-banana-2",
    aspectRatio: (source.data.aspectRatio as string | undefined) ?? "1:1",
    quality: (source.data.quality as string | undefined) ?? "1k",
  };
}

const NORMALIZE_SYSTEM = "You describe product photos for a listing prompt writer. Describe only what is visible: shape, proportions, artwork, colours, material look, base and any visible text. 60 words at most. Plain text only.";

export async function describeProductPhoto(model: string, references: ReferenceImage[], headers: HeadersInit, signal?: AbortSignal): Promise<string> {
  if (!references.length) return "";
  return streamAssistantText({
    model, references, headers, signal,
    systemPrompt: NORMALIZE_SYSTEM,
    prompt: `Describe the product in Reference 1.\n\n${references.map((r, i) => `Reference ${i + 1} — ${r.name}`).join("\n")}`,
  });
}

export interface WriteResult { prompt?: string; skipReason?: string }

export async function writeSlotPrompt(args: {
  slotId: number; model: string; facts: ListingFact[]; description: string;
  references: ReferenceImage[]; states: ListingSlotState[]; headers: HeadersInit; signal?: AbortSignal;
}): Promise<WriteResult> {
  const slot = LISTING_SLOTS.find((s) => s.id === args.slotId)!;
  const text = await streamAssistantText({
    model: args.model, headers: args.headers, signal: args.signal,
    systemPrompt: slotSystemPrompt(slot),
    prompt: slotUserPrompt(slot, args.facts, args.description, args.references, args.states),
  });
  const skip = parseSkipReply(text);
  return skip ? { skipReason: skip } : { prompt: text };
}

/** Submits one image job and polls until done. Returns the image URL. */
export async function generateSlotImage(args: {
  prompt: string; imageUrls: string[]; settings: ListingImageSettings; headers: HeadersInit; signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch("/api/generate", {
    method: "POST", headers: args.headers, signal: args.signal,
    body: JSON.stringify({ prompt: args.prompt, imageUrls: args.imageUrls, model: args.settings.model, aspectRatio: args.settings.aspectRatio, quality: args.settings.quality }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Image request failed");
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const poll = await fetch(`/api/job-status?taskId=${data.taskId}`, { signal: args.signal });
    const result = await poll.json();
    if (result.status === "done" && result.imageUrl) return result.imageUrl as string;
    if (result.status === "error") throw new Error(result.error ?? "Generation failed");
  }
  throw new Error("Timed out waiting for the image");
}
