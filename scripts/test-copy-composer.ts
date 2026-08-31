/**
 * Focused tests for the Copy Composer: strict structured-copy parsing,
 * "never invent" validation, and source resolution.
 *
 *   npx tsc -p scripts/tsconfig.test.json
 *   node scripts/.test-dist/scripts/test-copy-composer.js
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "../lib/store";
import {
  buildCopyComposerPrompt,
  hasRefinedCopy,
  mergeRefinedCopy,
  parseCopyJson,
  resolveCopyComposerInputs,
  validateRefinedCopy,
} from "../lib/copyComposer";

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

const RAW: TextContent = {
  eyebrow: "NEW",
  title: "Crystal keepsakes",
  subtitle: "A refined finishing touch",
  bullets: ["Premium K9 crystal", "Gift-ready box"],
  cta: "Explore the collection",
  fontFamily: "Georgia",
  textColor: "#123456",
  accentColor: "#F59E0B",
  alignment: "center",
};

console.log("── Strict structured-copy parsing ─────────────────────────");

const parsed = parseCopyJson('{"eyebrow":"NEW","title":"Crystal keepsakes","subtitle":"A refined finishing touch","bullets":["Premium K9 crystal","Gift-ready box"],"cta":"Explore the collection"}');
assert(!!parsed && parsed.title === "Crystal keepsakes", "parses a valid structured-copy object");
assert(!!parsed && parsed.bullets.length === 2 && parsed.bullets[0] === "Premium K9 crystal", "parses the bullets array");
assert(!!parsed && parsed.eyebrow === "NEW" && parsed.cta === "Explore the collection", "parses eyebrow and cta");

const fenced = parseCopyJson('```json\n{"eyebrow":"","title":"Hello","subtitle":"","bullets":[],"cta":""}\n```');
assert(!!fenced && fenced.title === "Hello", "strips optional markdown code fences");

assert(parseCopyJson("") === null, "empty string yields null");
assert(parseCopyJson("not json{") === null, "malformed JSON yields null");
assert(parseCopyJson('"just-a-string"') === null, "non-object JSON yields null");
assert(parseCopyJson("[1,2,3]") === null, "array JSON yields null");
assert(parseCopyJson("null") === null, "null JSON yields null");

const partial = parseCopyJson('{"title":"Only title"}');
assert(partial === null, "missing required copy keys are rejected");

const nonString = parseCopyJson('{"eyebrow":"","title":123,"subtitle":"","bullets":[1,"ok",null],"cta":""}');
assert(nonString === null, "non-string field values are rejected");
const extraKey = parseCopyJson('{"eyebrow":"","title":"Hello","subtitle":"","bullets":[],"cta":"","extra":"nope"}');
assert(extraKey === null, "unexpected model keys are rejected");
const oversized = parseCopyJson(JSON.stringify({ eyebrow: "", title: "x".repeat(600), subtitle: "", bullets: Array.from({ length: 8 }, () => "y".repeat(600)), cta: "" }));
assert(!!oversized && oversized.title.length === 500 && oversized.bullets.length === 5 && oversized.bullets.every((bullet) => bullet.length === 500),
  "oversized model output is bounded before it can reach node state");

console.log("── Merge preserves raw typography ─────────────────────────");

const merged = mergeRefinedCopy(RAW, { eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal", "Gift-ready box"], cta: "Explore the collection" });
assert(merged.fontFamily === "Georgia" && merged.textColor === "#123456" && merged.accentColor === "#F59E0B" && merged.alignment === "center",
  "merge preserves the raw text's font/color/alignment");
assert(merged.title === "Crystal keepsakes", "merge applies the refined copy fields");

console.log("── Never-invent validation ─────────────────────────────────");

const sameCount = validateRefinedCopy(RAW, { eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal", "Gift-ready box"], cta: "Explore the collection" });
assert(sameCount.ok && sameCount.warnings.length === 0, "same bullet count + same headline passes");

const addedBullet = validateRefinedCopy(RAW, { eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal", "Gift-ready box", "Invented 50% off claim"], cta: "Explore the collection" });
assert(!addedBullet.ok && addedBullet.warnings.some((w) => w.includes("bullet")), "added bullet beyond source is rejected");

const inventedTitle = validateRefinedCopy({ ...RAW, title: "" }, { eyebrow: "NEW", title: "Invented headline", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal"], cta: "Explore the collection" });
assert(!inventedTitle.ok && inventedTitle.warnings.some((w) => w.includes("title")), "added title where source had none is rejected");

const inventedEyebrow = validateRefinedCopy({ ...RAW, eyebrow: "" }, { eyebrow: "INVENTED", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal"], cta: "Explore the collection" });
assert(!inventedEyebrow.ok && inventedEyebrow.warnings.some((w) => w.includes("eyebrow")), "added eyebrow where source had none is rejected");
const removedCta = validateRefinedCopy(RAW, { eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "A refined finishing touch", bullets: ["Premium K9 crystal", "Gift-ready box"], cta: "" });
assert(!removedCta.ok && removedCta.warnings.some((w) => w.includes("CTA")), "removing source CTA is rejected");

console.log("── hasRefinedCopy ─────────────────────────────────────────");

assert(hasRefinedCopy(RAW) === true, "non-empty copy is renderable");
assert(hasRefinedCopy({ ...RAW, eyebrow: "", title: "", subtitle: "", bullets: [], cta: "" }) === false, "all-empty copy is not renderable");
assert(hasRefinedCopy(undefined) === false, "undefined copy is not renderable");

console.log("── Source resolution ───────────────────────────────────────");

const textNode = node("text-1", "textContentNode", { textContent: RAW });
const varNode = node("var-1", "variableNode", { variables: [{ id: "v1", key: "subject", value: "ceramic vase", type: "text" }] });
const brandNode = node("brand-1", "brandProfileNode", { variables: [{ id: "b1", key: "primary_color", value: "#2F6B5F", type: "color" }] });
const styleNode = node("style-1", "styleProfileNode", { profileJson: '{ "shot_type": "hero" }' });
const composer = node("composer-1", "copyComposerNode", {});

const inputs = resolveCopyComposerInputs("composer-1", [textNode, varNode, brandNode, styleNode, composer], [
  edge("e1", "text-1", "composer-1", "text"),
  edge("e2", "var-1", "composer-1", "variables"),
  edge("e3", "brand-1", "composer-1", "variables"),
  edge("e4", "style-1", "composer-1", "variables"),
]);
assert(!!inputs.raw && inputs.raw.title === "Crystal keepsakes", "resolves the connected Text Content raw copy");
assert(inputs.textSourceId === "text-1", "records the raw text source id");
assert(inputs.connectedValues.some((v) => v.key === "subject"), "resolves Variable values");
assert(inputs.connectedValues.some((v) => v.key === "brand.primary_color"), "resolves Brand Context values");
assert(!inputs.connectedValues.some((v) => v.key.startsWith("style.")), "Image Style Profile is excluded from Copy Composer context");

console.log("── Prompt body shape ──────────────────────────────────────");

const prompt = buildCopyComposerPrompt(inputs);
let promptParsed: unknown;
try { promptParsed = JSON.parse(prompt); } catch { promptParsed = null; }
assert(!!promptParsed && typeof promptParsed === "object" && !Array.isArray(promptParsed), "prompt body is valid JSON text alone");
const ctx = promptParsed as { raw?: TextContent; variables?: Record<string, string>; brand?: Record<string, string> };
assert(!!ctx.raw && ctx.raw.title === "Crystal keepsakes", "prompt carries the raw copy verbatim");
assert(ctx.variables?.subject === "ceramic vase", "prompt carries variables");
assert(ctx.brand?.primary_color === "#2F6B5F", "prompt carries brand context");
assert(!("style" in ctx), "prompt has no style section (Style Profiles excluded)");

console.log("── No raw text ────────────────────────────────────────────");

const noRaw = resolveCopyComposerInputs("composer-1", [varNode, composer], [edge("e2", "var-1", "composer-1", "variables")]);
assert(noRaw.raw === undefined, "no raw text when no Text Content is connected");

if (failures) process.exit(1);
console.log("\nAll copy composer tests passed.");
