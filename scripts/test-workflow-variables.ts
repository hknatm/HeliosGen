import {
  normalizeVariableKey,
  resolveWorkflowTemplate,
  serializeVariableValue,
} from "../lib/workflowVariables";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

assert(normalizeVariableKey("Product Name") === "product_name", "normalizes keys");
assert(normalizeVariableKey("SKU-Number") === "sku_number", "normalizes punctuation");
assert(serializeVariableValue({ type: "json", value: '{ "a": 1 }' }) === '{"a":1}', "serializes JSON deterministically");

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

if (failures) process.exit(1);
