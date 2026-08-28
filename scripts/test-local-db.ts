/**
 * Small standalone test for the local-only persistence layer added to
 * lib/guest/db.ts (spaces, chat sessions, generic app settings).
 *
 * Runs against a throwaway SQLite DB in a temp dir so the real data/ DB is
 * never touched. Compile with scripts/tsconfig.test.json then run with node.
 *
 *   npx tsc -p scripts/tsconfig.test.json
 *   node scripts/.test-dist/scripts/test-local-db.js
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "heliosgen-db-test-"));
  process.chdir(tmp);

  // Dynamic import so the module computes DATA_DIR from the temp cwd.
  const db = await import("../lib/guest/db");

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log("  PASS:", msg);
  } else {
    console.error("  FAIL:", msg);
    failures++;
  }
}

console.log("── Spaces ──────────────────────────────────────────────");
db.upsertSpaces([
  { id: "s1", name: "Space 1", data: { nodes: [], edges: [] }, is_public: false, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
  { id: "s2", name: "Space 2", data: { nodes: [{ id: "n1" }] }, is_public: true, created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" },
]);
let spaces = db.getSpaces();
assert(spaces.length === 2, "upsertSpaces inserts 2 spaces");
assert(spaces.find((s) => s.id === "s2")?.is_public === true, "is_public round-trips");
assert(Array.isArray((spaces.find((s) => s.id === "s2")?.data as { nodes?: unknown[] })?.nodes), "data JSON round-trips");

// Invalid rows are skipped, valid ones still inserted.
db.upsertSpaces([
  { id: 123 } as unknown,
  { id: "s3", name: "ok", data: {}, is_public: false, created_at: "x", updated_at: "x" },
]);
spaces = db.getSpaces();
assert(spaces.length === 3, "invalid space row skipped, valid added");

db.deleteSpaces(["s3"]);
spaces = db.getSpaces();
assert(spaces.length === 2 && !spaces.some((s) => s.id === "s3"), "deleteSpaces removes requested ids only");

console.log("── Chat sessions ───────────────────────────────────────");
db.upsertChatSession({ id: "c1", title: "Chat 1", messages: [{ role: "user", content: "hi" }], model: "m1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" });
db.upsertChatSession({ id: "c1", title: "Chat 1 updated", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], model: "m1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" });
let chats = db.getChatSessions();
assert(chats.length === 1, "upsertChatSession upserts by id");
assert((chats[0].messages as unknown[]).length === 2, "messages round-trip");
assert(chats[0].title === "Chat 1 updated", "title updated on upsert");

// Malformed messages are filtered out.
db.upsertChatSession({ id: "c2", title: "Bad", messages: [{ role: "user", content: "ok" }, { role: "system", content: "x" }, "nope"], model: "m1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" });
chats = db.getChatSessions();
const c2 = chats.find((c) => c.id === "c2");
assert((c2?.messages as unknown[]).length === 1, "malformed messages filtered");

db.deleteChatSession("c1");
assert(db.getChatSessions().length === 1, "deleteChatSession removes one");

console.log("── App settings ─────────────────────────────────────────");
db.setAppSettings({ customProviderConfig: { baseUrl: "http://x" }, systemPrompts: { chat: "hello" } });
let settings = db.getAppSettings();
assert((settings.customProviderConfig as { baseUrl?: string })?.baseUrl === "http://x", "app settings round-trip");
assert((settings.systemPrompts as { chat?: string })?.chat === "hello", "nested app settings round-trip");

db.setAppSettings({ customProviderConfig: { baseUrl: "http://y" } });
settings = db.getAppSettings();
assert((settings.customProviderConfig as { baseUrl?: string })?.baseUrl === "http://y", "app settings update");
assert((settings.systemPrompts as { chat?: string })?.chat === "hello", "partial update preserves other keys");

  rmSync(tmp, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll local-db tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
