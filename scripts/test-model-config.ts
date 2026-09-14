import { IMAGE_MODELS } from "../lib/modelConfig";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

for (const [id, apiStem] of [
  ["gpt-image-2-5-flare", "gpt-image-2-5-flare"],
  ["gpt-image-2-5-sunburst", "gpt-image-2-5-sunburst"],
] as const) {
  const model = IMAGE_MODELS.find((item) => item.id === id);
  assert(!!model, `${id} is registered`);
  assert(model?.apiId === `${apiStem}-image-to-image`, `${id} uses the upstream image-to-image API id`);
  assert(model?.textOnlyApiId === `${apiStem}-text-to-image`, `${id} uses the upstream text-to-image API id`);
  assert(model?.maxImages === 16, `${id} supports 16 reference images`);
  assert(model?.ratios.includes("21:9") === true && model.ratios.includes("8:9") === true, `${id} exposes the upstream extended ratios`);
  assert(model?.apiInput.qualityOptions?.join(",") === "1k,2k,4k", `${id} exposes 1K/2K/4K quality`);
}

if (failures) process.exit(1);
console.log("\nAll model config tests passed.");
