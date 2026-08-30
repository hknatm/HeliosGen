/**
 * Focused tests for the unified Style Profile JSON helpers and the shared
 * Prompt Composer source/token resolution.
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
  buildComposerPrompt,
  resolveComposerConnections,
  resolveComposerTemplate,
} from "../lib/composerSources";

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

console.log("── Style namespace resolution ──────────────────────────────");

const styleNode = node("style-1", "styleProfileNode", { profileJson: defJson });
const composer = node("composer-1", "promptComposerNode", {
  template: "{{style.shot_type}} with {{style.lighting}} on {{style.background}}.",
});
const nodes = [styleNode, composer];
const edges = [edge("e1", "style-1", "composer-1", "variables")];

const resolution = resolveComposerTemplate("composer-1", nodes, edges);
assert(resolution.connectedValues.every((v) => v.key.startsWith("style.")), "profile JSON tokens are namespaced style.*");
const styleResolved = resolveComposerTemplate("composer-1", nodes, edges);
assert(!/{{/.test(styleResolved.resolved), "deterministic resolution removes all placeholders");
assert(styleResolved.resolved.includes("Product hero shot"), "style.shot_type substituted");
assert(styleResolved.resolved.includes("Clean studio sweep"), "style.background substituted");
assert(styleResolved.missingKeys.length === 0 && styleResolved.duplicateKeys.length === 0,
  "no missing/duplicate keys for valid style JSON");

console.log("── Malformed JSON safety ───────────────────────────────────");

const badStyle = node("style-bad", "styleProfileNode", { profileJson: "{ broken" });
const composerBad = node("composer-bad", "promptComposerNode", { template: "{{style.lighting}}" });
const badRes = resolveComposerTemplate("composer-bad", [badStyle, composerBad], [edge("eb", "style-bad", "composer-bad", "variables")]);
assert(badRes.connectedValues.length === 0, "malformed profile JSON contributes no tokens (no crash)");
assert((badRes.missingKeys as string[]).includes("style.lighting"), "missing style token still reported safely");

const conns = resolveComposerConnections("composer-bad", [badStyle], []);
assert(conns.length === 0, "resolveComposerConnections safe with malformed profile");

console.log("── Composer context build ──────────────────────────────────");

const contextPrompt = buildComposerPrompt(styleResolved.connectedValues, styleResolved.resolved, "{{style.shot_type}} template");
assert(contextPrompt.includes("style.shot_type"), "context includes namespaced key");
assert(contextPrompt.includes("Product hero shot"), "context includes resolved value");
assert(contextPrompt.includes("OUTPUT ONLY") || /output only the final prompt/i.test(contextPrompt),
  "prompt instructs final-only output");

console.log("── VariableNode / legacy compatibility ────────────────────");

const legacyBrand = node("brand-1", "brandProfileNode", { variables: [{ id: "b1", key: "primary_color", value: "#2F6B5F", type: "color" }] });
const legacyComposer = node("composer-legacy", "promptComposerNode", { template: "brand color {{brand.primary_color}}" });
const legacyRes = resolveComposerTemplate("composer-legacy", [legacyBrand, legacyComposer], [edge("eb2", "brand-1", "composer-legacy", "variables")]);
assert(legacyRes.resolved.includes("#2F6B5F"), "legacy brand.* fields still resolve for saved spaces");

if (failures) process.exit(1);
console.log("\nAll composer tests passed.");
