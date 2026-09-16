import assert from "node:assert/strict";
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "../lib/store";
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
const nodes = [image("a", "Product", "https://example.com/a.png"), image("b", "Style", "https://example.com/b.png"), agent, generator];
const agentEdges: Edge[] = [
  { id: "a-agent", source: "a", target: "agent", targetHandle: "references" },
  { id: "b-agent", source: "b", target: "agent", targetHandle: "references" },
];
const refs = resolveReferenceImages("agent", nodes, agentEdges, "references").references;
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
