import {
  isValidHexColor,
  normalizeHexColor,
  normalizeVariableKey,
  resolveWorkflowTemplate,
  serializeVariableValue,
} from "../lib/workflowVariables";
import { profileTokenPrefix } from "../lib/profileNodes";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

assert(normalizeVariableKey("Product Name") === "product_name", "normalizes keys");
assert(normalizeVariableKey("SKU-Number") === "sku_number", "normalizes punctuation");
assert(serializeVariableValue({ type: "json", value: '{ "a": 1 }' }) === '{"a":1}', "serializes JSON deterministically");
assert(normalizeHexColor("#2f6") === "#22FF66", "expands and normalizes short hex colors");
assert(normalizeHexColor("#2f6b5f") === "#2F6B5F", "normalizes full hex colors");
assert(isValidHexColor("#2F6B5F") && !isValidHexColor("green"), "validates hex colors");

const resolved = resolveWorkflowTemplate(
  "Photo of {{product_name}} in {{color}} for {{missing}}.",
  [
    { key: "product_name", value: "Cedar chair", sourceId: "data-1", sourceLabel: "Product" },
    { key: "color", value: "Walnut", sourceId: "data-1", sourceLabel: "Product" },
  ],
);
assert(resolved.resolved === "Photo of Cedar chair in Walnut for {{missing}}.", "resolves known keys only");
assert(resolved.missingKeys.length === 1 && resolved.missingKeys[0] === "missing", "reports missing key");

const duplicate = resolveWorkflowTemplate("{{product_name}}", [
  { key: "product_name", value: "First", sourceId: "a", sourceLabel: "A" },
  { key: "product_name", value: "Second", sourceId: "b", sourceLabel: "B" },
]);
assert(duplicate.resolved === "{{product_name}}", "does not silently resolve duplicates");
assert(duplicate.duplicateKeys[0] === "product_name", "reports duplicate key");

const brand = resolveWorkflowTemplate("{{brand.primary_color}} / {{brand.lighting}}", [
  { key: "brand.primary_color", value: "#2F6B5F", sourceId: "brand-1", sourceLabel: "Brand" },
  { key: "brand.lighting", value: "Soft daylight", sourceId: "brand-1", sourceLabel: "Brand" },
]);
assert(brand.resolved === "#2F6B5F / Soft daylight", "resolves namespaced brand tokens");

const style = resolveWorkflowTemplate(
  "{{style.shot_type}} with {{style.lighting}} lighting",
  [
    { key: "style.shot_type", value: "Product hero shot", sourceId: "style-1", sourceLabel: "Style" },
    { key: "style.lighting", value: "soft key + fill", sourceId: "style-1", sourceLabel: "Style" },
  ],
);
assert(style.resolved === "Product hero shot with soft key + fill lighting", "resolves namespaced style tokens");

// Namespace collision safety: brand.* and style.* share field names but must
// not interfere with each other, and unprefixed variables must not collide
// with either namespace.
const crossNs = resolveWorkflowTemplate(
  "{{brand.primary_color}} | {{style.primary_color}} | {{primary_color}}",
  [
    { key: "brand.primary_color", value: "#2F6B5F", sourceId: "brand-1", sourceLabel: "Brand" },
    { key: "style.primary_color", value: "#38BDF8", sourceId: "style-1", sourceLabel: "Style" },
    { key: "primary_color", value: "#F59E0B", sourceId: "var-1", sourceLabel: "Variable" },
  ],
);
assert(crossNs.resolved === "#2F6B5F | #38BDF8 | #F59E0B", "isolates same-named keys across namespaces");
assert(crossNs.missingKeys.length === 0 && crossNs.duplicateKeys.length === 0, "no false collisions across namespaces");

const dupeStyled = resolveWorkflowTemplate("{{style.lighting}}", [
  { key: "style.lighting", value: "key", sourceId: "a", sourceLabel: "A" },
  { key: "style.lighting", value: "fill", sourceId: "b", sourceLabel: "B" },
]);
assert(dupeStyled.resolved === "{{style.lighting}}", "flags duplicate namespaced style tokens");
assert(dupeStyled.duplicateKeys[0] === "style.lighting", "reports duplicate namespaced style key");

assert(profileTokenPrefix("brandProfileNode") === "brand.", "brand profile token prefix is brand.");
assert(profileTokenPrefix("styleProfileNode") === "style.", "style profile token prefix is style.");
assert(profileTokenPrefix("variableNode") === "", "variable nodes stay unprefixed");

if (failures) process.exit(1);
