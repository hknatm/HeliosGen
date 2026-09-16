import assert from "node:assert/strict";
import { callbackOutputUrls } from "../lib/callbackPayload";

const a = "https://cdn.example.com/a.png";
const b = "https://cdn.example.com/b.png";

assert.deepEqual(callbackOutputUrls({ resultJson: JSON.stringify({ resultUrls: [a, b] }) }), [a, b]);
assert.deepEqual(callbackOutputUrls({ resultJson: { resultUrl: a } }), [a]);
assert.deepEqual(callbackOutputUrls({ resultJson: JSON.stringify([a, b]) }), [a, b]);
assert.deepEqual(callbackOutputUrls({ resultJson: a }), [a]);
assert.deepEqual(callbackOutputUrls({ output: [{ url: a }, { fileUrl: b }] }), [a, b]);
assert.deepEqual(callbackOutputUrls({ videoUrl: a }), [a]);
assert.deepEqual(callbackOutputUrls({ resultJson: "http://insecure.example/a.png" }), []);
assert.deepEqual(callbackOutputUrls({ resultJson: "not json or a URL" }), []);
assert.deepEqual(callbackOutputUrls({ resultJson: "not json or a URL", videoUrl: a }), [a]);
assert.deepEqual(callbackOutputUrls({ resultJson: { data: { imageUrls: [a, a] } } }), [a]);

console.log("PASS: callback result URL variants normalize safely");
