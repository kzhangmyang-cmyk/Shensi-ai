import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionLeadConversionRecoverySweeper
} from "./acquisition-lead-conversion-recovery-sweeper.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("starts immediately, runs periodically, and never overlaps sweeps", async () => {
  const calls: number[] = [];
  const timers: Array<() => void> = [];
  let sequence = 0;
  const secondSweep = deferred<{
    inspected: number;
    completed: number;
    failed: number;
  }>();
  const sweeper = new AcquisitionLeadConversionRecoverySweeper({
    service: {
      async runOnce() {
        sequence += 1;
        calls.push(sequence);
        if (sequence === 2) return secondSweep.promise;
        return { inspected: 0, completed: 0, failed: 0 };
      }
    },
    intervalMs: 1_000,
    setTimer(callback) {
      timers.push(callback);
      return {};
    },
    clearTimer() {}
  });

  await sweeper.start();
  assert.deepEqual(calls, [1]);
  assert.equal(timers.length, 1);

  timers[0]!();
  timers[0]!();
  await Promise.resolve();
  assert.deepEqual(calls, [1, 2]);

  secondSweep.resolve({ inspected: 1, completed: 1, failed: 0 });
  await sweeper.whenIdle();
  assert.equal(timers.length, 2);
  await sweeper.close();
});

test("close cancels the timer and waits for an in-flight sweep", async () => {
  const sweep = deferred<{
    inspected: number;
    completed: number;
    failed: number;
  }>();
  let cleared = 0;
  let started = 0;
  const sweeper = new AcquisitionLeadConversionRecoverySweeper({
    service: {
      async runOnce() {
        started += 1;
        return sweep.promise;
      }
    },
    intervalMs: 1_000,
    setTimer() {
      return {};
    },
    clearTimer() {
      cleared += 1;
    }
  });

  const starting = sweeper.start();
  await Promise.resolve();
  assert.equal(started, 1);
  let closed = false;
  const closing = sweeper.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);

  sweep.resolve({ inspected: 0, completed: 0, failed: 0 });
  await Promise.all([starting, closing]);
  assert.equal(closed, true);
  assert.equal(cleared, 0);
});

test("validates interval and batch size", () => {
  assert.throws(
    () => new AcquisitionLeadConversionRecoverySweeper({
      service: {
        async runOnce() {
          return { inspected: 0, completed: 0, failed: 0 };
        }
      },
      intervalMs: 999
    }),
    /intervalMs/
  );
  assert.throws(
    () => new AcquisitionLeadConversionRecoverySweeper({
      service: {
        async runOnce() {
          return { inspected: 0, completed: 0, failed: 0 };
        }
      },
      batchSize: 501
    }),
    /batchSize/
  );
});
