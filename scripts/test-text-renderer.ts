import type { Edge, Node } from "@xyflow/react";
import type { NodeData, TextContent } from "../lib/store";
import { copyComposerIsUsable, hasRenderableText, resolveTextRendererInputs } from "../lib/textRendererSources";
import { normalizeStyleComposition } from "../lib/styleComposition";
import { normalizeTextRenderingSettings } from "../lib/textRenderingSettings";
import { copyDraftMatchesSource, rawCopySignature } from "../lib/copyComposer";
import { familyKeyFromFontUrl, fontFamilyKey, isAppOwnedFontUrl, isBuiltInFontFamily } from "../lib/textFonts";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}
function node(id: string, type: string, data: Partial<NodeData>): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, status: "idle", ...data } };
}
function edge(source: string, target: string, targetHandle: string): Edge {
  return { id: `${source}-${target}-${targetHandle}`, source, target, targetHandle };
}

const text: TextContent = {
  eyebrow: "NEW", title: "Crystal keepsakes", subtitle: "", bullets: ["Premium K9 crystal"], cta: "Explore", fontFamily: "Arial", textColor: "#FFFFFF", accentColor: "#F59E0B", alignment: "left",
};

console.log("── Text Renderer sources ───────────────────────────────────");
const image = node("image", "generateNode", { imageUrl: "/generated/generated/image.png" });
const content = node("content", "textContentNode", { textContent: text });
const style = node("style", "styleProfileNode", { profileJson: JSON.stringify({ copy_space_preset: "left_half", copy_space: { x: 0, y: 0, width: 0.5, height: 1 } }) });
const renderer = node("renderer", "textRendererNode", {});
const resolved = resolveTextRendererInputs("renderer", [image, content, style, renderer], [edge("image", "renderer", "image"), edge("content", "renderer", "text"), edge("style", "renderer", "style")]);
assert(resolved.imageUrl === "/generated/generated/image.png", "renderer accepts app-owned generated image input");
assert(resolved.content?.title === "Crystal keepsakes" && resolved.content?.bullets[0] === "Premium K9 crystal", "renderer preserves structured text exactly");
assert(resolved.composition?.copySpace.width === 0.5, "renderer reads normalized copy-space composition");
assert(hasRenderableText(resolved.content), "non-empty content is renderable");
assert(!hasRenderableText({ ...text, eyebrow: "", title: "", subtitle: "", bullets: [], cta: "" }), "empty content is not renderable");
const proposed = node("proposed", "copyComposerNode", { refinedTextContent: { ...text, title: "Refined but unaccepted" }, copyAccepted: false });
const accepted = node("accepted", "copyComposerNode", { refinedTextContent: { ...text, title: "Accepted refinement" }, copyAccepted: true, copyAcceptedRawSignature: rawCopySignature(text), copySourceId: "content" });
const unacceptedResult = resolveTextRendererInputs("renderer", [image, proposed, style, renderer], [edge("image", "renderer", "image"), edge("proposed", "renderer", "text"), edge("style", "renderer", "style")]);
assert(unacceptedResult.content === undefined, "unaccepted Copy Composer proposals never reach the renderer");
const acceptedResult = resolveTextRendererInputs("renderer", [image, content, accepted, style, renderer], [edge("image", "renderer", "image"), edge("accepted", "renderer", "text"), edge("style", "renderer", "style")]);
assert(acceptedResult.content?.title === "Accepted refinement", "accepted Copy Composer copy reaches the renderer");

console.log("── Stale acceptance gate ────────────────────────────────────");
// An acceptance is only valid while the source it was derived from is unchanged.
const source = node("source", "textContentNode", { textContent: text });
const composer = node("composer", "copyComposerNode", {
  refinedTextContent: { ...text, title: "Accepted refinement" },
  copyAccepted: true,
  copyAcceptedRawSignature: rawCopySignature(text),
  copySourceId: "source",
});
const staleComposer = node("stale", "copyComposerNode", {
  refinedTextContent: { ...text, title: "Accepted refinement" },
  copyAccepted: true,
  copyAcceptedRawSignature: rawCopySignature({ ...text, title: "Different source" }),
  copySourceId: "source",
});
assert(copyComposerIsUsable(composer, [source]), "acceptance matching its source is usable");
assert(!copyComposerIsUsable(staleComposer, [source]), "acceptance from a changed source is stale and unusable");
const staleResult = resolveTextRendererInputs("renderer", [image, staleComposer, style, renderer], [edge("image", "renderer", "image"), edge("stale", "renderer", "text"), edge("style", "renderer", "style")]);
assert(staleResult.content === undefined, "stale accepted copy never reaches the renderer");
const missingSource = node("orphan", "copyComposerNode", {
  refinedTextContent: { ...text, title: "Accepted refinement" },
  copyAccepted: true,
  copyAcceptedRawSignature: rawCopySignature(text),
  copySourceId: "gone",
});
assert(!copyComposerIsUsable(missingSource, [source]), "acceptance whose source node is gone is unusable");
assert(copyDraftMatchesSource(text, rawCopySignature(text)), "current drafts can be approved");
assert(!copyDraftMatchesSource({ ...text, title: "Edited after drafting" }, rawCopySignature(text)), "stale drafts cannot be re-approved as current");
const requestComposition = normalizeStyleComposition(resolved.composition);
assert(requestComposition.copySpace.width === 0.5 && requestComposition.copySpace.x === 0, "renderer accepts its resolved camelCase composition contract");

console.log("── Text Rendering settings ─────────────────────────────────");
const normalized = normalizeTextRenderingSettings({ defaultTitleSize: 999, defaultBodySize: 1, defaultPadding: 2, defaultTextColor: "bad", outputFormat: "webp", defaultAlignment: "right" });
assert(normalized.defaultTitleSize === 240 && normalized.defaultBodySize === 12, "font-size defaults are bounded");
assert(normalized.defaultPadding === 0.25, "layout padding is bounded");
assert(normalized.defaultTextColor === "#FFFFFF" && normalized.outputFormat === "webp" && normalized.defaultAlignment === "right", "settings normalize allowed values and fallback invalid colors");

console.log("── Uploaded font URL contracts ─────────────────────────────");
assert(fontFamilyKey("Aurora Sans") === "aurora-sans", "font family keys are normalized deterministically");
assert(familyKeyFromFontUrl("/generated/fonts/aurora-sans/example.ttf") === "aurora-sans", "new uploaded font URLs expose their family key");
assert(fontFamilyKey("Aurora Sans") === fontFamilyKey("Aurora-Sans"), "font key normalization makes collisions explicit for descriptor binding");
assert(isBuiltInFontFamily(" arial "), "built-in font detection cannot be bypassed with case or whitespace");
assert(isAppOwnedFontUrl("/generated/fonts/aurora-sans/example.ttf"), "new nested local font URLs are app-owned");
assert(!isAppOwnedFontUrl("/generated/fonts/../../secret.ttf"), "font URLs cannot traverse generated storage");

if (failures) process.exit(1);
console.log("\nAll text renderer tests passed.");
