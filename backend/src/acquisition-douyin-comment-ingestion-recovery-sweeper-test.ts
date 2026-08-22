import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionDouyinCommentIngestionRecoverySweeper
} from "./acquisition-douyin-comment-ingestion-recovery-sweeper.js";

test("comment ingestion recovery starts immediately, isolates errors, and closes", async () => {
  const timers: Array<() => void> = [];
  const failures: unknown[] = [];
  let calls = 0;
  const sweeper = new AcquisitionDouyinCommentIngestionRecoverySweeper({
    service: {
      async recoverPendingIngestionSagas() {
        calls += 1;
        if (calls === 1) throw new Error("temporary repository outage");
        return 0;
      }
    },
    intervalMs: 1_000,
    batchSize: 1,
    setTimer(callback) {
      timers.push(callback);
      return { unref() {} };
    },
    clearTimer() {},
    onError(error) {
      failures.push(error);
    }
  });

  await sweeper.start();
  assert.equal(calls, 1, "startup must run the first recovery sweep");
  assert.equal(failures.length, 1, "a failed sweep must not fail startup");
  assert.equal(timers.length, 1);

  (timers.shift()!)();
  await sweeper.whenIdle();
  assert.equal(calls, 2, "later sweeps must continue after an isolated failure");
  assert.equal(timers.length, 1);

  const scheduled = timers.shift()!;
  await sweeper.close();
  scheduled();
  await sweeper.whenIdle();
  assert.equal(calls, 2, "closed sweepers must ignore scheduled callbacks");
});
