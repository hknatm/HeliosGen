import assert from "node:assert/strict";
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "../lib/store";
import { buildPipelineWaves, resolveInputs } from "../lib/executor";
import { resolveReferenceImages } from "../lib/referenceBundle";
import { buildVisionUserPrompt, normalizeVisionJson, visionPreset, VISION_PRESETS } from "../lib/vision";

const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
} as Storage;

// presets
assert.equal(visionPreset("nope").id, "describe", "unknown preset falls back");
assert.equal(new Set(VISION_PRESETS.map((p) => p.id)).size, VISION_PRESETS.length);

// prompt keeps image order and the brief
const refs = [
  { id: "a", sourceNodeId: "n", name: "Hero", usageNote: "main\nsubject", url: "https://x/a.png" },
  { id: "b", sourceNodeId: "n", name: "Logo", usageNote: "", url: "https://x/b.png" },
];
const prompt = buildVisionUserPrompt("brief", " make it blue ", "connected text", refs);
assert.match(prompt, /Brief:\nconnected text\n\nmake it blue/);
assert.ok(prompt.indexOf("Reference 1 — Hero (main subject)") < prompt.indexOf("Reference 2 — Logo"));
assert.doesNotMatch(buildVisionUserPrompt("describe", "", "", []), /Attached images/);

// JSON normalisation
assert.equal(JSON.parse(normalizeVisionJson('```json\n{"pass":true}\n```')).pass, true);
assert.equal(JSON.parse(normalizeVisionJson('Sure! {"score":7} done')).score, 7);
assert.throws(() => normalizeVisionJson("no json here"), /JSON object/);
assert.throws(() => normalizeVisionJson("{bad json}"), /invalid JSON/);

// graph: images -> vision -> agent prompt, and pipeline ordering
const node = (id: string, type: string, data: Partial<NodeData> = {}): Node<NodeData> =>
  ({ id, type, position: { x: 0, y: 0 }, data: data as NodeData }) as Node<NodeData>;
const nodes = [
  node("img", "imageInputNode", { referenceImages: [{ id: "1", name: "Shot", usageNote: "", r2Url: "https://x/shot.png", status: "done" }] as never }),
  node("vis", "visionNode", { outputText: "Looks sharp." }),
  node("agent", "assistantNode"),
];
const edges: Edge[] = [
  { id: "e1", source: "img", target: "vis", targetHandle: "references" },
  { id: "e2", source: "vis", sourceHandle: "textOut", target: "agent", targetHandle: "prompt" },
];
const resolved = resolveReferenceImages("vis", nodes, edges, "references");
assert.equal(resolved.references.length, 1);
assert.equal(resolved.references[0].url, "https://x/shot.png");
assert.equal(resolveInputs("agent", nodes, edges).prompt, "Looks sharp.");
assert.deepEqual(buildPipelineWaves(nodes, edges), [["vis"], ["agent"]]);

console.log("vision tests passed");
