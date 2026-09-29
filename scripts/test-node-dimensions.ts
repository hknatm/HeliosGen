import assert from "node:assert/strict";
import { persistFinalNodeResize } from "../lib/nodeDimensions";

const nodes = [
  { id: "resized", width: 320, height: 240, style: { width: 320, height: 240, borderRadius: 8 } },
  { id: "untouched", width: 280, height: 200, style: { width: 280, height: 200 } },
];
const changes = [
  { id: "resized", type: "dimensions", resizing: false, dimensions: { width: 512, height: 384 } },
  { id: "untouched", type: "dimensions", dimensions: { width: 300, height: 220 } },
  { id: "resized", type: "dimensions", resizing: true, dimensions: { width: 500, height: 380 } },
];

const result = persistFinalNodeResize(nodes, changes);
assert.equal(result[0].width, 512, "committed resize is stored as node width");
assert.equal(result[0].height, 384, "committed resize is stored as node height");
assert.deepEqual(result[0].style, { width: 512, height: 384, borderRadius: 8 }, "committed size is serialized in node style without dropping other styles");
assert.equal(result[1], nodes[1], "auto-measurements are not promoted to persistent sizes");
assert.equal(nodes[0].width, 320, "original node state is not mutated");
assert.equal(persistFinalNodeResize(nodes, [{ id: "resized", type: "dimensions", resizing: false, dimensions: { width: 0, height: 0 } }]), nodes, "invalid final dimensions are ignored");

console.log("node dimension persistence tests passed");
