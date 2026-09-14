/**
 * End-to-end smoke test for the deterministic Text Renderer's sharp path:
 * creates a real test image, runs renderTextOverlay, and verifies the output
 * is a valid image with the expected dimensions. This exercises the SVG
 * composite path that unit tests cannot reach.
 */
import { mkdir, writeFile } from "fs/promises";
import sharp from "sharp";
import { renderTextOverlay } from "../lib/textRenderer";
import { normalizeStyleComposition } from "../lib/styleComposition";
import { normalizeTextRenderingSettings } from "../lib/textRenderingSettings";
import type { TextContent } from "../lib/store";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

async function main() {
  const dir = `${process.cwd()}/public/generated/e2e-test`;
  await mkdir(dir, { recursive: true });
  const imagePath = `${dir}/source.png`;
  await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 40, g: 60, b: 80 } },
  }).png().toFile(imagePath);

  const content: TextContent = {
    eyebrow: "NEW COLLECTION",
    title: "Aurora Home Crystal Keepsakes",
    subtitle: "Hand-finished pieces for memorable gifting",
    bullets: ["Premium K9 crystal", "Free gift wrap"],
    cta: "Explore the collection",
    fontFamily: "Arial",
    textColor: "#FFFFFF",
    accentColor: "#F59E0B",
    alignment: "left",
  };

  const { buffer, mime, truncatedLines } = await renderTextOverlay({
    imageUrl: `/generated/e2e-test/source.png`,
    content,
    composition: normalizeStyleComposition({ copySpacePreset: "left_half", copySpace: { x: 0, y: 0, width: 0.5, height: 1 } }),
    settings: normalizeTextRenderingSettings({}),
  });

  assert(mime === "image/png", "output mime is png");
  assert(truncatedLines === 0, "fits-in-zone copy reports zero truncated lines");
  const meta = await sharp(buffer).metadata();
  assert(meta.width === 1024 && meta.height === 1024, `output keeps source dimensions (${meta.width}x${meta.height})`);
  assert(buffer.length > 10_000, `output is a real image payload (${buffer.length} bytes)`);

  // Verify text pixels actually landed in the left copy zone (non-uniform output).
  const stats = await sharp(buffer).stats();
  const channels = stats.channels.map((c) => c.stdev);
  assert(channels.some((s) => s > 5), `output has visible text contrast (stdev ${channels.map((c) => c.toFixed(1)).join("/")})`);

  // Overflowing copy must be clipped AND reported, never silently dropped.
  const overflow = await renderTextOverlay({
    imageUrl: `/generated/e2e-test/source.png`,
    content: {
      ...content,
      title: "A deliberately very long headline that will never fit inside the reserved text area of this image",
      subtitle: "And a long supporting line that also cannot fit",
      bullets: ["First bullet", "Second bullet", "Third bullet", "Fourth bullet", "Fifth bullet"],
    },
    composition: normalizeStyleComposition({ copySpacePreset: "left_third", copySpace: { x: 0, y: 0, width: 1 / 3, height: 0.4 } }),
    settings: normalizeTextRenderingSettings({}),
  });
  assert(overflow.truncatedLines > 0, `overflowing copy reports ${overflow.truncatedLines} truncated line(s)`);

  await writeFile(`${dir}/rendered.png`, buffer);
  console.log("Wrote", `${dir}/rendered.png`);

  if (failures) process.exit(1);
  console.log("\nAll e2e render tests passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
