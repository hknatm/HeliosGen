// Runs every compiled test suite in .test-dist/scripts; exits non-zero if any fail.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dir = new URL("../.test-dist/scripts/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^test-.*\.js$/.test(f)).sort();
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, [new URL(file, dir).pathname], { stdio: "pipe", encoding: "utf8" });
  if (r.status === 0) console.log(`ok   ${file}`);
  else { failed++; console.log(`FAIL ${file}\n${r.stdout}${r.stderr}`); }
}
console.log(failed ? `${failed} of ${files.length} suites failed` : `${files.length} suites passed`);
process.exit(failed ? 1 : 0);
