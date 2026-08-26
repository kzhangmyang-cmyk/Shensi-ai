import { strict as assert } from "node:assert";
import {
  LAST_OUTREACH_BATCH_KEY,
  createOutreachBatchSelectionStore
} from "./outreach-batch-selection";

function storageFixture(options: { fail?: boolean } = {}) {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  const removals: string[] = [];
  return {
    values,
    writes,
    removals,
    getItem(key: string) {
      if (options.fail) throw new Error("storage unavailable");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.fail) throw new Error("storage unavailable");
      values.set(key, value);
      writes.push({ key, value });
    },
    removeItem(key: string) {
      if (options.fail) throw new Error("storage unavailable");
      values.delete(key);
      removals.push(key);
    }
  };
}

const unavailable = createOutreachBatchSelectionStore(storageFixture({ fail: true }));
assert.equal(unavailable.read(), null, "storage read failures must fail closed");
assert.doesNotThrow(() => unavailable.remember("batch-private"));
assert.doesNotThrow(() => unavailable.clear());

const storage = storageFixture();
const selection = createOutreachBatchSelectionStore(storage);
const broadcasts: Array<string | null> = [];
const unsubscribe = selection.subscribe((batchId) => broadcasts.push(batchId));

selection.remember("   ");
assert.deepEqual(storage.writes, [], "blank batch ids must not be persisted");
assert.deepEqual(broadcasts, [], "blank batch ids must not be broadcast");

selection.remember("batch-1");
assert.equal(selection.read(), "batch-1");
assert.deepEqual(storage.writes, [{ key: LAST_OUTREACH_BATCH_KEY, value: "batch-1" }]);
assert.deepEqual(broadcasts, ["batch-1"]);

selection.clear();
assert.equal(selection.read(), null);
assert.deepEqual(storage.removals, [LAST_OUTREACH_BATCH_KEY]);
assert.deepEqual(broadcasts, ["batch-1", null]);

unsubscribe();
selection.remember("batch-2");
assert.deepEqual(broadcasts, ["batch-1", null], "unsubscribe must stop broadcasts");

console.log(JSON.stringify({ ok: true, suite: "outreach-batch-selection" }));
