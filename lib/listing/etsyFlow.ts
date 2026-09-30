import { LISTING_SHARED_RULES, LISTING_SLOTS, type ListingSkipRule, type ListingSlot } from "./etsySlots";

export interface ListingFact { key: string; value: string }
export interface ListingRef { name: string; usageNote?: string }
export type ListingSlotStatus = "idle" | "running" | "done" | "skipped" | "error";
export interface ListingSlotState {
  id: number;
  status: ListingSlotStatus;
  prompt?: string;
  note?: string;
  imageUrl?: string;
}

const KEY_HINTS: Record<Exclude<ListingSkipRule, "customerPhoto">, RegExp> = {
  measurements: /dimension|measure|size|height|width|length|weight|cm|inch/i,
  options: /option|variant|choice|finish|base|color|shape/i,
  turnaround: /turnaround|production|processing|lead|ship|delivery/i,
};

function itemCount(value: string): number {
  return value.split(/[\n,;|/]|\bor\b/i).map((part) => part.trim()).filter(Boolean).length;
}

/** Deterministic skip check. Returns a reason when the slot cannot be done honestly, else null. */
export function slotSkipReason(slot: ListingSlot, facts: ListingFact[], refs: ListingRef[]): string | null {
  if (!slot.requires) return null;
  if (slot.requires === "customerPhoto") {
    const found = refs.some((ref) => /customer|original|client/i.test(`${ref.name} ${ref.usageNote ?? ""}`));
    return found ? null : slot.skipReason ?? "Missing input";
  }
  const hint = KEY_HINTS[slot.requires];
  const matches = facts.filter((fact) => hint.test(fact.key) && fact.value.trim());
  if (slot.requires === "options") {
    return matches.some((fact) => /option|variant|choice/i.test(fact.key) && itemCount(fact.value) >= 2)
      ? null
      : slot.skipReason ?? "Missing input";
  }
  return matches.length > 0 ? null : slot.skipReason ?? "Missing input";
}

export function factsToText(facts: ListingFact[]): string {
  return facts.filter((fact) => fact.value.trim()).map((fact) => `${fact.key}: ${fact.value.trim()}`).join("\n");
}

export function initialSlotStates(facts: ListingFact[], refs: ListingRef[], previous: ListingSlotState[] = []): ListingSlotState[] {
  return LISTING_SLOTS.map((slot) => {
    const reason = slotSkipReason(slot, facts, refs);
    if (reason) return { id: slot.id, status: "skipped" as const, note: reason };
    const old = previous.find((item) => item.id === slot.id);
    return old && old.status !== "skipped" && old.status !== "running" ? old : { id: slot.id, status: "idle" as const };
  });
}

export function slotSystemPrompt(slot: ListingSlot): string {
  return `${LISTING_SHARED_RULES}\n\n## SLOT ${slot.id}: ${slot.name}\n\n${slot.instruction}`;
}

const PRIOR_CAP = 500;

export function slotUserPrompt(slot: ListingSlot, facts: ListingFact[], description: string, refs: ListingRef[], states: ListingSlotState[]): string {
  const prior = states
    .filter((state) => state.id < slot.id && state.status === "done" && state.prompt)
    .map((state) => `Slot ${state.id}: ${state.prompt!.replace(/\s+/g, " ").slice(0, PRIOR_CAP)}`);
  return [
    `Product facts:\n${factsToText(facts) || "(none given)"}`,
    description ? `Product photo description:\n${description}` : "",
    refs.length
      ? ["Attached images, in order:", ...refs.map((ref, i) => `Image ${i + 1} — ${ref.name}${ref.usageNote ? ` (${ref.usageNote})` : ""}`)].join("\n")
      : "",
    prior.length ? `Prompts already written for earlier slots:\n${prior.join("\n")}` : "",
    `Write the prompt for slot ${slot.id} (${slot.name}) now.`,
  ].filter(Boolean).join("\n\n");
}

/** The model may answer SKIP as a fallback. Returns the reason, or null when it wrote a prompt. */
export function parseSkipReply(text: string): string | null {
  const match = text.trim().match(/^SKIP\b[\s:\-—.]*([\s\S]*)$/i);
  return match ? (match[1].trim() || "Skipped by the writer") : null;
}

/** Stable signature of everything that shapes the generated images. */
export function listingSignature(facts: ListingFact[], refs: Array<{ url: string; name: string; usageNote?: string }>, model: string, image: { model: string; aspectRatio: string; quality: string } | null): string {
  const body = JSON.stringify({
    f: facts.map((f) => [f.key, f.value]),
    r: refs.map((r) => [r.url, r.name, r.usageNote ?? ""]),
    m: model,
    i: image ? [image.model, image.aspectRatio, image.quality] : null,
  });
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return `${body.length}:${(h >>> 0).toString(36)}`;
}
