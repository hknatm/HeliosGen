/**
 * Focused connectability/helper tests: the executor's typed input resolution
 * (AI Agent output feeds generators with a normal prompt; legacy Composer and
 * Text Content still resolve), and the Text Overlay's legacy input resolution.
 *
 *   npx tsc -p scripts/tsconfig.test.json
 *   node .test-dist/scripts/test-connectivity.js
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "../lib/store";
import { resolveInputs } from "../lib/executor";
import { buildComposerPrompt, resolveComposerConnections } from "../lib/composerSources";
import { resolveTextRendererContent, resolveTextRendererInputs } from "../lib/textRendererSources";
import { rawCopySignature } from "../lib/copyComposer";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

function node(id: string, type: string, data: Partial<NodeData>): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, status: "idle", ...data } };
}
function edge(id: string, source: string, target: string, targetHandle?: string, sourceHandle?: string | undefined): Edge {
  return { id, source, target, targetHandle: targetHandle ?? undefined, sourceHandle };
}

const RAW: TextContent = {
  eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch",
  bullets: ["Premium K9 crystal"], cta: "Explore the collection",
  fontFamily: "Georgia", textColor: "#123456", accentColor: "#F59E0B", alignment: "center",
};

console.log("── AI Agent (assistantNode) output feeds a generator prompt ──");
const agent = node("agent-1", "assistantNode", { outputText: "A crystal vase on a marble plinth, soft studio light" });
const gen = node("gen-1", "generateNode", {});
const inputs = resolveInputs("gen-1", [agent, gen], [edge("e1", "agent-1", "gen-1", "prompt")]);
assert(inputs.prompt === "A crystal vase on a marble plinth, soft studio light", "assistantNode output resolves as the generator prompt");
const promptSource = node("prompt-1", "promptNode", { prompt: "A connected source prompt" });
const connectedAgent = node("agent-2", "assistantNode", {});
const agentInputs = resolveInputs("agent-2", [promptSource, connectedAgent], [edge("e-agent", "prompt-1", "agent-2", "prompt")]);
assert(agentInputs.prompt === "A connected source prompt", "AI Agent accepts a connected prompt source");

const contextVariable = node("variable-context", "variableNode", { variableKey: "material", variableValue: "K9 crystal" });
const contextOnlyInputs = resolveInputs("agent-2", [contextVariable, connectedAgent], [edge("e-context", "variable-context", "agent-2", "variables", "dataOut")]);
assert(contextOnlyInputs.prompt === undefined, "AI Agent context input does not leak a Variable value into its prompt handle");
const contextValues = resolveComposerConnections("agent-2", [contextVariable, connectedAgent], [edge("e-context", "variable-context", "agent-2", "variables", "dataOut")]);
const combinedAgentPrompt = JSON.parse(buildComposerPrompt(contextValues, undefined, "A connected source prompt\n\nAdd elegant lighting"));
assert(combinedAgentPrompt.request === "A connected source prompt\n\nAdd elegant lighting", "structured AI Agent prompt preserves connected and local authored text in JSON");
assert(combinedAgentPrompt.variables.material === "K9 crystal", "structured AI Agent prompt keeps connected context typed");

console.log("── Legacy prompt sources still resolve (load-only workflows) ──");
const composer = node("composer-1", "promptComposerNode", { resolvedPrompt: "COMPOSED NATIVE PROMPT" });
const gen2 = node("gen-2", "generateNode", {});
const composerIn = resolveInputs("gen-2", [composer, gen2], [edge("e2", "composer-1", "gen-2", "prompt")]);
assert(composerIn.prompt === "COMPOSED NATIVE PROMPT", "legacy promptComposerNode resolvedPrompt still feeds generators");

const textNode = node("text-1", "textContentNode", { textContent: RAW });
const gen3 = node("gen-3", "generateNode", {});
const textIn = resolveInputs("gen-3", [textNode, gen3], [edge("e3", "text-1", "gen-3", "prompt")]);
assert(!!textIn.prompt && textIn.prompt.includes("Crystal keepsakes"), "legacy textContentNode resolves to generator prompt text");

console.log("── Typed image input resolution ─────────────────────────────");
const srcImage = node("img-1", "generateNode", { imageUrl: "https://cdn/helios.png" });
const gen4 = node("gen-4", "generateNode", {});
const imgIn = resolveInputs("gen-4", [srcImage, gen4], [edge("e4", "img-1", "gen-4", "image")]);
assert(imgIn.imageUrls.length === 1 && imgIn.imageUrls[0] === "https://cdn/helios.png", "image handle carries one image URL");

console.log("── Text Overlay legacy input resolution (saved workflows) ───");
const styleNode = node("style-1", "styleProfileNode", { profileJson: JSON.stringify({ copy_space: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 } }) });
const renderer = node("renderer-1", "textRendererNode", {});
const overlayIn = resolveTextRendererInputs("renderer-1", [textNode, styleNode, renderer], [
  edge("e5", "text-1", "renderer-1", "text"),
  edge("e6", "style-1", "renderer-1", "style"),
]);
assert(overlayIn.content?.title === "Crystal keepsakes", "legacy Text Content resolves into the renderer content");
assert(!!overlayIn.composition, "legacy Image Style Profile resolves the text-area composition");
assert(overlayIn.imageUrl === undefined, "no image connected → imageUrl undefined");

const ownOverlay = node("renderer-own", "textRendererNode", { textContent: RAW });
const ownOverlayIn = resolveTextRendererInputs("renderer-own", [styleNode, ownOverlay], [edge("e7", "style-1", "renderer-own", "style")]);
assert(ownOverlayIn.content?.title === "Crystal keepsakes", "Text Overlay exposes its inline copy to pipeline execution");

const refinedLegacy: TextContent = { ...RAW, title: "Refined crystal keepsakes" };
const acceptedOverlay = node("renderer-accepted", "textRendererNode", {
  copyAccepted: true,
  copyAcceptedRawSignature: rawCopySignature(RAW),
  refinedTextContent: refinedLegacy,
});
assert(resolveTextRendererContent(overlayIn, acceptedOverlay.data)?.title === "Refined crystal keepsakes", "accepted AI copy renders for a legacy connected Text Content source");
const staleOverlay = node("renderer-stale", "textRendererNode", {
  copyAccepted: true,
  copyAcceptedRawSignature: rawCopySignature({ ...RAW, title: "Old title" }),
  refinedTextContent: refinedLegacy,
});
assert(resolveTextRendererContent(overlayIn, staleOverlay.data)?.title === "Crystal keepsakes", "stale accepted AI copy falls back to current authored content");

if (failures) process.exit(1);
console.log("\nAll connectivity tests passed.");
