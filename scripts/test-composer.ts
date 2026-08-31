/**
 * Focused tests for the unified Style Profile JSON helpers and the shared
 * Prompt Composer source resolution (AI-only, JSON-only payload).
 *
 *   npx tsc -p scripts/tsconfig.test.json
 *   node scripts/.test-dist/scripts/test-composer.js
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "../lib/store";
import {
  defaultStyleProfileJson,
  fieldsToProfileJson,
  profileJsonToFields,
} from "../lib/profileNodes";
import {
  buildComposerContext,
  buildComposerPrompt,
  buildComposerTargetMedia,
  resolveComposerConnections,
  resolveComposerTemplate,
} from "../lib/composerSources";
import {
  COPY_SPACE_PRESETS,
  DEFAULT_STYLE_COMPOSITION,
  formatStyleProfileObject,
  readStyleComposition,
  writeStyleComposition,
} from "../lib/styleComposition";
import { textContentToPrompt } from "../lib/executor";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

function node(id: string, type: string, data: Partial<NodeData>): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, status: "idle", ...data } };
}
function edge(id: string, source: string, target: string, targetHandle: string): Edge {
  return { id, source, target, targetHandle, sourceHandle: undefined };
}

console.log("── Style Profile JSON helpers ─────────────────────────────");

const parsed = profileJsonToFields('{ "shot_type": "Product hero", "lighting": "soft", "accent": "#2F6B5F", "flags": ["minimal"] }');
assert(parsed.length === 4, "parses all JSON keys into fields");
const shot = parsed.find((f) => f.key === "shot_type");
assert(!!shot && shot.value === "Product hero" && shot.type === "text", "text value parsed");
const accent = parsed.find((f) => f.key === "accent");
assert(!!accent && accent.type === "color", "hex color detected as color");
const flags = parsed.find((f) => f.key === "flags");
assert(!!flags && flags.type === "json" && flags.value === '["minimal"]', "array stored as json string");

assert(profileJsonToFields("not json{").length === 0, "malformed JSON yields no fields");
assert(profileJsonToFields('"just-a-string"').length === 0, "non-object JSON yields no fields");
assert(profileJsonToFields('[1,2]').length === 0, "array JSON yields no fields");
assert(profileJsonToFields("{}").length === 0, "empty object yields no fields");

const normalized = profileJsonToFields('{ "Shot-Type!": "x", "_spacing": 1 }');
assert(normalized.some((f) => f.key === "shot_type"), "JSON keys are normalized to valid variable keys");

console.log("── Default serialization ───────────────────────────────────");

const defJson = defaultStyleProfileJson();
let defParsed: unknown;
try { defParsed = JSON.parse(defJson); } catch { defParsed = null; }
assert(defJson.trim().length > 0 && !!defParsed && typeof defParsed === "object" && !Array.isArray(defParsed),
  "default Style profile is a valid JSON object");
const defFields = profileJsonToFields(defJson);
assert(defFields.length > 0 && defFields.every((f) => !!(f.key && f.value)), "defaults round-trip to populated fields");

const again = fieldsToProfileJson(defFields);
assert(JSON.parse(again) !== undefined, "fields serialize back to valid JSON");
const againFields = profileJsonToFields(again);
assert(againFields.length === defFields.length, "serialize→parse round-trip preserves field count");

console.log("── Composition and copy space ──────────────────────────────");

const defaultProfile = JSON.parse(defJson) as Record<string, unknown>;
const defaultComposition = readStyleComposition(defaultProfile);
assert(defaultComposition.copySpacePreset === "left_two_thirds", "default profile reserves a left two-thirds copy area");
assert(defaultComposition.subjectAnchor === "right_third", "default profile anchors the subject on the right third");
assert(defaultComposition.copySpace.width > 0.65 && defaultComposition.copySpace.height === 1, "default copy area is normalized and ratio-independent");

const rightThird = COPY_SPACE_PRESETS.find((item) => item.id === "right_third")!;
const composedProfile = writeStyleComposition(defaultProfile, { copySpacePreset: "right_third", subjectAnchor: "left_third" });
const composed = readStyleComposition(composedProfile);
assert(composed.copySpace.x === rightThird.rect.x && composed.copySpace.width === rightThird.rect.width, "copy-space preset writes its deterministic normalized zone");
assert(composed.subjectAnchor === "left_third", "subject placement persists independently of copy space");
const customProfile = writeStyleComposition(composedProfile, { copySpacePreset: "custom", copySpace: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } });
const custom = readStyleComposition(customProfile);
assert(custom.copySpacePreset === "custom" && custom.copySpace.x === 0.1 && custom.copySpace.height === 0.6, "custom normalized composition zone round-trips");
const boundedProfile = writeStyleComposition(customProfile, { copySpacePreset: "custom", copySpace: { x: 1, y: 1, width: 0, height: 0 } });
const bounded = readStyleComposition(boundedProfile);
assert(bounded.copySpace.x < 1 && bounded.copySpace.y < 1 && bounded.copySpace.width >= 0.01 && bounded.copySpace.height >= 0.01, "composition bounds always retain a renderable copy zone");
assert(JSON.parse(formatStyleProfileObject(customProfile)) !== undefined, "composition editor serialization remains valid JSON");
assert(DEFAULT_STYLE_COMPOSITION.copySpaceAvoid.includes("generated text"), "default copy area forbids generated text");

console.log("── Style namespace resolution ──────────────────────────────");

const styleNode = node("style-1", "styleProfileNode", { profileJson: defJson });
const composer = node("composer-1", "promptComposerNode", {
  template: "{{style.shot_type}} with {{style.lighting}} on {{style.background}}.",
});
const nodes = [styleNode, composer];
const edges = [edge("e1", "style-1", "composer-1", "variables")];

const resolution = resolveComposerTemplate("composer-1", nodes, edges);
assert(resolution.connectedValues.every((v) => v.key.startsWith("style.")), "profile JSON tokens are namespaced style.*");

console.log("── JSON-only payload shape ─────────────────────────────────");

const context = buildComposerContext(resolution.connectedValues);
assert(typeof context === "object" && !Array.isArray(context), "context is a plain object");
assert(!!context.variables && !!context.style && !!context.brand, "context has variables/style/brand sections");
assert(Object.keys(context.style).length > 0, "style keys land under the style section");
assert(Object.keys(context.variables).length === 0 && Object.keys(context.brand).length === 0,
  "style-only sources do not leak into variables/brand");

const prompt = buildComposerPrompt(resolution.connectedValues);
let promptParsed: unknown;
try { promptParsed = JSON.parse(prompt); } catch { promptParsed = null; }
assert(!!promptParsed && typeof promptParsed === "object" && !Array.isArray(promptParsed),
  "prompt body is valid JSON text alone");
assert(!/Resolve the prompt template/i.test(prompt) && !/Template:/i.test(prompt) && !/Output only/i.test(prompt),
  "prompt body has no surrounding English instructions");
assert(prompt.includes('"shot_type"') && prompt.includes("Product hero shot"),
  "prompt body carries namespaced style values");

const imageTarget = node("image-target", "generateNode", { aspectRatio: "4:3" });
const targetedPrompt = buildComposerPrompt(resolution.connectedValues, buildComposerTargetMedia("composer-1", [styleNode, composer, imageTarget], [...edges, edge("out", "composer-1", "image-target", "prompt")]));
const targetedParsed = JSON.parse(targetedPrompt) as { target?: { type?: string; aspectRatio?: string } };
assert(targetedParsed.target?.type === "image" && targetedParsed.target.aspectRatio === "4:3", "Composer context carries the selected image target ratio");
const videoTarget = node("video-target", "videoGeneratorNode", { aspectRatio: "9:16" });
const videoTargeted = buildComposerTargetMedia("composer-1", [composer, videoTarget], [edge("video-out", "composer-1", "video-target", "prompt")]);
assert(videoTargeted?.type === "video" && videoTargeted.aspectRatio === "9:16", "Composer context carries video target metadata when wired");

console.log("── Deterministic text content ──────────────────────────────");
const textPrompt = textContentToPrompt({ eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal", "", "Gift-ready box"], cta: "Explore the collection", fontFamily: "Arial", textColor: "#FFFFFF", accentColor: "#F59E0B", alignment: "left" });
assert(textPrompt.includes("Title: Crystal keepsakes") && textPrompt.includes("Key points: Premium K9 crystal; Gift-ready box"), "Text Content serializes authored copy without rewriting it");
assert(!textPrompt.includes("good K9") && !textPrompt.includes("memorable gifting"), "Text Content never performs AI copy refinement");

console.log("── Namespaced structural context ──────────────────────────");

const brandNode = node("brand-1", "brandProfileNode", { variables: [{ id: "b1", key: "primary_color", value: "#2F6B5F", type: "color" }] });
const varNode = node("var-1", "variableNode", { variables: [{ id: "v1", key: "subject", value: "ceramic vase", type: "text" }] });
const mixedComposer = node("composer-mixed", "promptComposerNode", {});
const mixedNodes = [styleNode, brandNode, varNode, mixedComposer];
const mixedEdges = [
  edge("e1", "style-1", "composer-mixed", "variables"),
  edge("e2", "brand-1", "composer-mixed", "variables"),
  edge("e3", "var-1", "composer-mixed", "variables"),
];
const mixedConns = resolveComposerConnections("composer-mixed", mixedNodes, mixedEdges);
const mixedCtx = buildComposerContext(mixedConns);
assert(Object.keys(mixedCtx.variables).includes("subject") && mixedCtx.variables.subject === "ceramic vase",
  "variable values are direct/unprefixed under variables");
assert(Object.keys(mixedCtx.style).includes("shot_type"), "style keys under style");
assert(Object.keys(mixedCtx.brand).includes("primary_color") && mixedCtx.brand.primary_color === "#2F6B5F",
  "brand keys under brand");

console.log("── Duplicate / malformed rejection ─────────────────────────");

// Duplicate key across two sources must be excluded entirely (no silent overwrite).
const dupA = node("dup-a", "variableNode", { variables: [{ id: "a1", key: "subject", value: "first", type: "text" }] });
const dupB = node("dup-b", "variableNode", { variables: [{ id: "b1", key: "subject", value: "second", type: "text" }] });
const dupComposer = node("composer-dup", "promptComposerNode", {});
const dupConns = resolveComposerConnections("composer-dup", [dupA, dupB, dupComposer], [
  edge("da", "dup-a", "composer-dup", "variables"),
  edge("db", "dup-b", "composer-dup", "variables"),
]);
const dupCtx = buildComposerContext(dupConns);
assert(!("subject" in dupCtx.variables), "duplicate key is excluded entirely (no silent overwrite)");

// Empty/missing values are excluded.
const emptyNode = node("empty-1", "variableNode", { variables: [{ id: "e1", key: "empty_key", value: "   ", type: "text" }] });
const emptyComposer = node("composer-empty", "promptComposerNode", {});
const emptyCtx = buildComposerContext(resolveComposerConnections("composer-empty", [emptyNode, emptyComposer], [
  edge("ee", "empty-1", "composer-empty", "variables"),
]));
assert(!("empty_key" in emptyCtx.variables), "empty/missing value is excluded");

// Malformed profile JSON contributes no tokens (no crash).
const badStyle = node("style-bad", "styleProfileNode", { profileJson: "{ broken" });
const composerBad = node("composer-bad", "promptComposerNode", { template: "{{style.lighting}}" });
const badRes = resolveComposerTemplate("composer-bad", [badStyle, composerBad], [edge("eb", "style-bad", "composer-bad", "variables")]);
assert(badRes.connectedValues.length === 0, "malformed profile JSON contributes no tokens (no crash)");
const badCtx = buildComposerContext(badRes.connectedValues);
assert(Object.keys(badCtx.style).length === 0 && Object.keys(badCtx.variables).length === 0,
  "malformed profile yields empty context");

console.log("── No template dependency ──────────────────────────────────");

// The AI-only Composer must not depend on a template: a composer with no
// template still produces a valid JSON-only prompt from connected context.
const noTemplateComposer = node("composer-nt", "promptComposerNode", {});
const ntConns = resolveComposerConnections("composer-nt", [styleNode, noTemplateComposer], [edge("nt", "style-1", "composer-nt", "variables")]);
const ntPrompt = buildComposerPrompt(ntConns);
let ntParsed: unknown;
try { ntParsed = JSON.parse(ntPrompt); } catch { ntParsed = null; }
assert(!!ntParsed && typeof ntParsed === "object", "prompt builds from context alone with no template");
assert(!/{{/.test(ntPrompt), "no unresolved template tokens in the prompt body");

console.log("── VariableNode / legacy compatibility ────────────────────");

const legacyBrand = node("brand-1", "brandProfileNode", { variables: [{ id: "b1", key: "primary_color", value: "#2F6B5F", type: "color" }] });
const legacyComposer = node("composer-legacy", "promptComposerNode", { template: "brand color {{brand.primary_color}}" });
const legacyRes = resolveComposerTemplate("composer-legacy", [legacyBrand, legacyComposer], [edge("eb2", "brand-1", "composer-legacy", "variables")]);
assert(legacyRes.resolved.includes("#2F6B5F"), "legacy brand.* fields still resolve for saved spaces");
const legacyCtx = buildComposerContext(legacyRes.connectedValues);
assert(legacyCtx.brand.primary_color === "#2F6B5F", "legacy brand context still namespaced under brand");

if (failures) process.exit(1);
console.log("\nAll composer tests passed.");
