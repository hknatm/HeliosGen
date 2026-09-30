import assert from "node:assert/strict";
import { LISTING_SLOTS } from "../lib/listing/etsySlots";
import { initialSlotStates, parseSkipReply, slotSkipReason, slotSystemPrompt, slotUserPrompt } from "../lib/listing/etsyFlow";

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
console.log("listing ok");
