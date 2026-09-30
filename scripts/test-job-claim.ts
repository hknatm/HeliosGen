import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "helios-claim-")));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { jobStore } = require("../lib/jobStore") as typeof import("../lib/jobStore");

assert.equal(jobStore.claim("missing"), false, "unknown task cannot be claimed");
jobStore.set("a", { status: "pending", type: "image" });
assert.equal(jobStore.claim("a"), true, "first claim wins");
assert.equal(jobStore.claim("a"), false, "second concurrent claim is refused");
assert.equal(jobStore.claim("a", 0), true, "a stale claim can be retaken");
jobStore.set("a", { status: "done", imageUrl: "x" });
assert.equal(jobStore.claim("a"), false, "settled task cannot be claimed");
jobStore.set("b", { status: "pending" });
assert.equal(jobStore.claim("b"), true);
const job = jobStore.get("b");
assert.ok(job && job.status === "pending");
jobStore.set("b", { ...job, claimedAt: undefined });
assert.equal(jobStore.claim("b"), true, "claim released after a failed save can be retaken");
console.log("job claim ok");
