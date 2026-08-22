import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionVisualReaderRecoverySweeper
} from "./acquisition-visual-reader-recovery-sweeper.js";

test("visual recovery owns an independent immediate interval and redacted close lifecycle", async () => {
  const timers: Array<() => void> = [];
  const diagnostics: unknown[] = [];
  let calls = 0;
  const sweeper = new AcquisitionVisualReaderRecoverySweeper({
    service: {
      async recoverPendingVisualIngestionWorkItems() {
        calls += 1;
        if (calls === 1) {
          throw new Error("secret observation text and visible nickname");
        }
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
    onError(diagnostic) {
      diagnostics.push(diagnostic);
    }
  });

  await sweeper.start();
  assert.equal(calls, 1);
  assert.deepEqual(diagnostics, [{
    code: "VISUAL_INGESTION_RECOVERY_SWEEP_FAILED"
  }]);
  assert.equal(JSON.stringify(diagnostics).includes("nickname"), false);
  assert.equal(timers.length, 1);

  timers.shift()!();
  await sweeper.whenIdle();
  assert.equal(calls, 2);
  assert.equal(timers.length, 1);

  const scheduled = timers.shift()!;
  await sweeper.close();
  scheduled();
  await sweeper.whenIdle();
  assert.equal(calls, 2);
  await assert.rejects(sweeper.start(), /VISUAL_INGESTION_RECOVERY_SWEEPER_CLOSED/u);
});
