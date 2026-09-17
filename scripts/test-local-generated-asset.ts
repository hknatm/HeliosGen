import assert from "node:assert/strict";
import { generatedAssetContentType, generatedAssetPathFromUrl, resolveGeneratedAssetPath } from "../lib/localGeneratedAsset";

const expected = resolveGeneratedAssetPath("images", "example.png");
assert.ok(expected?.replace(/\\/g, "/").endsWith("/public/generated/images/example.png"));
assert.equal(generatedAssetPathFromUrl("/generated/images/example.png"), expected);
assert.equal(generatedAssetPathFromUrl("/generated/images/example.png?token=x&cache=1"), expected);
assert.equal(generatedAssetPathFromUrl("https://example.test/generated/images/example.png?token=x"), expected);
assert.equal(resolveGeneratedAssetPath("..", "secret.png"), null);
assert.equal(resolveGeneratedAssetPath("images", "../secret.png"), null);
assert.equal(generatedAssetPathFromUrl("/generated/images/%2e%2e%2fsecret.png"), null);
assert.equal(generatedAssetPathFromUrl("/api/settings"), null);
assert.equal(generatedAssetContentType("result.PNG"), "image/png");
assert.equal(generatedAssetContentType("clip.mp4"), "video/mp4");
assert.equal(generatedAssetContentType("unknown.bin"), "application/octet-stream");

console.log("local generated asset tests passed");
