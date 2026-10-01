import assert from "node:assert/strict";
import { LISTING_SLOTS } from "../lib/listing/etsySlots";
import type { Node } from "@xyflow/react";
import type { NodeData } from "../lib/store";
import { directReferences } from "../lib/referenceBundle";
import { listingSignature, initialSlotStates, parseSkipReply, slotSkipReason, slotSystemPrompt, slotUserPrompt } from "../lib/listing/etsyFlow";

assert.equal(LISTING_SLOTS.length, 10);
assert.deepEqual(LISTING_SLOTS.map((s) => s.id), [1,2,3,4,5,6,7,8,9,10]);
const refs = [{ name: "Product" }];
let states = initialSlotStates([{ key: "material", value: "crystal" }], refs);
assert.deepEqual(states.filter((s) => s.status === "skipped").map((s) => s.id), [4, 8, 9, 10]);
const rich = [
  { key: "dimensions", value: "10 x 15 cm" },
  { key: "options", value: "small, large" },
  { key: "turnaround", value: "3 days" },
];
states = initialSlotStates(rich, [...refs, { name: "Customer photo" }]);
assert.equal(states.filter((s) => s.status === "skipped").length, 0);
assert.ok(slotSkipReason(LISTING_SLOTS[8], [{ key: "options", value: "single" }], refs));
assert.equal(parseSkipReply("SKIP no data"), "no data");
assert.equal(parseSkipReply("A studio shot"), null);
assert.match(slotSystemPrompt(LISTING_SLOTS[0]), /SLOT 1: Studio hero/);
const user = slotUserPrompt(LISTING_SLOTS[1], rich, "a glass block", refs, [{ id: 1, status: "done", prompt: "hero prompt" }]);
assert.match(user, /Slot 1: hero prompt/);
const r1 = [{ url: "a", name: "P" }];
const sig = listingSignature(rich, r1, "gpt-5-2", null);
assert.equal(sig, listingSignature(rich, r1, "gpt-5-2", null));
assert.notEqual(sig, listingSignature([...rich, { key: "x", value: "y" }], r1, "gpt-5-2", null));
assert.notEqual(sig, listingSignature(rich, [{ url: "b", name: "P" }], "gpt-5-2", null));
console.log("listing ok");

// Per-slot prompt override replaces only the slot instruction; shared rules stay.
{
  const custom = slotSystemPrompt(LISTING_SLOTS[1], "MY CUSTOM SLOT TWO");
  assert.match(custom, /MY CUSTOM SLOT TWO/);
  assert.match(custom, /SLOT 2: Dark dramatic hero/);
  assert.ok(!custom.includes(LISTING_SLOTS[1].instruction));
  assert.ok(custom.includes(slotSystemPrompt(LISTING_SLOTS[1]).split("\n\n## SLOT")[0]));
  assert.equal(slotSystemPrompt(LISTING_SLOTS[1], "  "), slotSystemPrompt(LISTING_SLOTS[1]));
  const base = listingSignature(rich, r1, "gpt-5-2", null);
  assert.notEqual(base, listingSignature(rich, r1, "gpt-5-2", null, { 2: "x" }));
  assert.equal(base, listingSignature(rich, r1, "gpt-5-2", null, {}));
}
console.log("listing prompts ok");

// IMAGES output: finished slots only, in slot order.
{
  const node: Node<NodeData> = { id: "L", type: "listingSetNode", position: { x: 0, y: 0 }, data: { label: "Listing", listingSlots: [
    { id: 3, status: "done", imageUrl: "https://x/3.png" },
    { id: 1, status: "done", imageUrl: "https://x/1.png" },
    { id: 2, status: "error" },
    { id: 4, status: "skipped" },
    { id: 5, status: "done" },
  ] } };
  const out = directReferences(node, "imagesOut");
  assert.deepEqual(out.map((r) => r.url), ["https://x/1.png", "https://x/3.png"]);
  assert.equal(out[0].name, "Listing image 1");
  assert.deepEqual(directReferences({ ...node, data: { label: "Listing" } }, "imagesOut"), []);
}
console.log("listing output ok");
