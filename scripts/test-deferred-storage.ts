import assert from "node:assert/strict";
import type { StorageValue } from "zustand/middleware";

class FakeStorage {
  writes: Array<{ name: string; value: string }> = [];
  values = new Map<string, string>();
  getItem(name: string) { return this.values.get(name) ?? null; }
  setItem(name: string, value: string) {
    this.writes.push({ name, value });
    this.values.set(name, value);
  }
  removeItem(name: string) { this.values.delete(name); }
}

const fakeStorage = new FakeStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = fakeStorage as unknown as Storage;
(globalThis as unknown as { window: Window }).window = { addEventListener: () => {} } as unknown as Window;
(globalThis as unknown as { document: Document }).document = { addEventListener: () => {}, visibilityState: "visible" } as unknown as Document;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deferredJSONStorage, flushPersistWrites } = require("../lib/store") as typeof import("../lib/store");
const storage = deferredJSONStorage<{ count: number }>();
const first: StorageValue<{ count: number }> = { state: { count: 1 } };
const latest: StorageValue<{ count: number }> = { state: { count: 2 } };

storage.setItem("workflow", first);
storage.setItem("workflow", latest);
assert.equal(fakeStorage.writes.length, 0, "rapid updates do not synchronously write localStorage");
assert.deepEqual(storage.getItem("workflow"), latest, "pending state is readable before it flushes");

flushPersistWrites();
assert.equal(fakeStorage.writes.length, 1, "a burst coalesces into one durable write");
assert.deepEqual(JSON.parse(fakeStorage.writes[0].value), latest, "the durable write contains the newest state");

storage.setItem("removed", first);
storage.removeItem("removed");
flushPersistWrites();
assert.equal(fakeStorage.values.has("removed"), false, "remove cancels a pending write");

console.log("deferred storage tests passed");
