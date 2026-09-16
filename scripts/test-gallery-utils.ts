import assert from "node:assert/strict";
import { normalizeAssetSrc } from "../lib/assetSrc";

assert.equal(
  normalizeAssetSrc("https://cdn.example.com/generated/image.png", false),
  "https://cdn.example.com/generated/image.png",
  "cloud CDN assets must retain their absolute origin",
);
assert.equal(
  normalizeAssetSrc("https://cdn.example.com/images/image.png", false),
  "https://cdn.example.com/images/image.png",
);
console.log("PASS: cloud asset URLs retain their CDN origin");

assert.equal(
  normalizeAssetSrc("https://old-helios.example/generated/image.png?token=abc", true),
  "/generated/image.png?token=abc",
  "local generated assets should follow the current app origin",
);
assert.equal(normalizeAssetSrc("/generated/image.png", true), "/generated/image.png");
console.log("PASS: local generated asset URLs follow the current origin");
