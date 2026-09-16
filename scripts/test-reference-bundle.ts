import assert from "node:assert/strict";
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "../lib/store";
import { persistedNodeData } from "../lib/referencePersistence";
import { resolveInputs } from "../lib/executor";
import {
  numberedReferencePrompt,
  resolveAgentSignature,
  resolveReferenceImages,
  validateAgentGenerationPackage,
} from "../lib/referenceBundle";

const image = (id: string, name: string, url: string): Node<NodeData> => ({
  id, type: "imageInputNode", position: { x: 0, y: 0 },
  data: { label: id, referenceName: name, referenceUsage: `${name} only`, r2Url: url },
});
const agent: Node<NodeData> = { id: "agent", type: "assistantNode", position: { x: 0, y: 0 }, data: { label: "AI AGENT", localPrompt: "Compose", model: "gpt-5-2" } };
const generator: Node<NodeData> = { id: "gen", type: "generateNode", position: { x: 0, y: 0 }, data: { label: "Image Generator" } };
const multi: Node<NodeData> = {
  id: "multi", type: "imageInputNode", position: { x: 0, y: 0 }, data: {
    label: "References",
    referenceImages: [
      { id: "one", r2Url: "https://example.com/one.png", name: "Subject", usageNote: "Preserve", status: "ready" },
      { id: "two", r2Url: "https://example.com/two.png", name: "Style", usageNote: "Lighting only", status: "ready" },
    ],
  },
};
const nodes = [image("a", "Product", "https://example.com/a.png"), image("b", "Style", "https://example.com/b.png"), multi, agent, generator];
const agentEdges: Edge[] = [
  { id: "a-agent", source: "a", target: "agent", targetHandle: "references" },
  { id: "b-agent", source: "b", target: "agent", targetHandle: "references" },
];
const refs = resolveReferenceImages("agent", nodes, agentEdges, "references").references;
const multiRefs = resolveReferenceImages("agent", nodes, [{ id: "multi-agent", source: "multi", target: "agent", targetHandle: "references" }], "references").references;
assert.deepEqual(multiRefs.map((ref) => ref.name), ["Subject", "Style"]);
assert.deepEqual(multiRefs.map((ref) => ref.url), ["https://example.com/one.png", "https://example.com/two.png"]);
const expandedInputs = resolveInputs("gen", [multi, generator], [{ id: "multi-gen", source: "multi", target: "gen", targetHandle: "image" }]);
assert.deepEqual(expandedInputs.imageUrls, ["https://example.com/one.png", "https://example.com/two.png"]);
assert.deepEqual(expandedInputs.imageNodeLabels, ["Subject", "Style"]);

const tooManyNode: Node<NodeData> = {
  id: "too-many", type: "imageInputNode", position: { x: 0, y: 0 }, data: {
    label: "Too many",
    referenceImages: Array.from({ length: 17 }, (_, index) => ({ id: String(index), r2Url: `https://example.com/${index}.png`, name: `Ref ${index}`, usageNote: "", status: "ready" })),
  },
};
const tooMany = resolveReferenceImages("agent", [tooManyNode, agent], [{ id: "too-many-edge", source: "too-many", target: "agent", targetHandle: "references" }], "references");
assert.match(tooMany.error ?? "", /maximum of 16/i);
assert.deepEqual(tooMany.references, []);

const uploadingNode: Node<NodeData> = {
  id: "uploading", type: "imageInputNode", position: { x: 0, y: 0 }, data: {
    label: "Uploading", referenceImages: [{ id: "pending", inputImage: "blob:temporary", name: "Pending", usageNote: "", status: "uploading" }],
  },
};
const pending = resolveReferenceImages("agent", [uploadingNode, agent], [{ id: "pending-edge", source: "uploading", target: "agent", targetHandle: "references" }], "references");
assert.match(pending.error ?? "", /finish uploading/i);
const persisted = persistedNodeData(uploadingNode.data);
assert.equal(persisted.referenceImages?.[0].inputImage, undefined);
assert.equal(persisted.referenceImages?.[0].status, "error");
assert.match(persisted.referenceImages?.[0].error ?? "", /interrupted/i);
assert.equal(persistedNodeData(multi.data).referenceImages?.[0].r2Url, "https://example.com/one.png");
const interruptedReplacement = persistedNodeData({
  label: "References",
  referenceImages: [{ id: "product", inputImage: "blob:replacement", r2Url: "https://example.com/old.png", name: "Product", usageNote: "Preserve", status: "uploading" }],
});
assert.equal(interruptedReplacement.referenceImages?.[0].r2Url, "https://example.com/old.png");
assert.equal(interruptedReplacement.referenceImages?.[0].status, "ready");
assert.match(interruptedReplacement.referenceImages?.[0].error ?? "", /previous image was kept/i);
assert.deepEqual(refs.map((ref) => ref.name), ["Product", "Style"]);
assert.match(numberedReferencePrompt(refs), /Reference 1 — Product/);
assert.match(numberedReferencePrompt(refs), /Reference 2 — Style/);
const signature = resolveAgentSignature("agent", nodes, agentEdges, refs);
const outputText = "Use Reference 1 as product and Reference 2 for style.";
agent.data.outputText = outputText;
agent.data.agentInputSignature = signature;
agent.data.referencePackage = { prompt: outputText, references: refs, signature };
const pairedEdges: Edge[] = [
  ...agentEdges,
  { id: "prompt", source: "agent", sourceHandle: "textOut", target: "gen", targetHandle: "prompt" },
  { id: "refs", source: "agent", sourceHandle: "refsOut", target: "gen", targetHandle: "image" },
];
assert.equal(validateAgentGenerationPackage("gen", nodes, pairedEdges).error, undefined);
assert.match(validateAgentGenerationPackage("gen", nodes, [...agentEdges, pairedEdges[2]]).error ?? "", /REFERENCES/);
const bundled = resolveReferenceImages("gen", nodes, pairedEdges, "image");
assert.deepEqual(bundled.references.map((ref) => ref.url), ["https://example.com/a.png", "https://example.com/b.png"]);
nodes[0].data.referenceUsage = "changed";
assert.match(resolveReferenceImages("gen", nodes, pairedEdges, "image").error ?? "", /changed/);

console.log("reference bundle tests passed");
