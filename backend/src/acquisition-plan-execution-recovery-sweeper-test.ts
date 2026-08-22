import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionPlanExecutionRecoverySweeper
} from "./acquisition-plan-execution-recovery-sweeper.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("starts immediately and schedules periodic execution-intent recovery", async () => {
  const actors: string[] = [];
  const timers: Array<() => void> = [];
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents(actorId) {
        actors.push(actorId);
        return 0;
      }
    },
    intervalMs: 1_000,
    setTimer(callback) {
      timers.push(callback);
      return { unref() {} };
    },
    clearTimer() {}
  });

  await sweeper.start();
  assert.deepEqual(actors, ["acquisition-plan-execution-recovery"]);
  assert.equal(timers.length, 1);

  timers.shift()!();
  await sweeper.whenIdle();
  assert.deepEqual(actors, [
    "acquisition-plan-execution-recovery",
    "acquisition-plan-execution-recovery"
  ]);
  assert.equal(timers.length, 1);

  await sweeper.close();
});

test("never overlaps execution-intent recovery sweeps", async () => {
  const timers: Array<() => void> = [];
  const activeSweep = deferred<number>();
  let calls = 0;
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        calls += 1;
        if (calls === 2) return activeSweep.promise;
        return 0;
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
  const scheduled = timers.shift()!;
  scheduled();
  scheduled();
  await Promise.resolve();

  assert.equal(calls, 2);
  activeSweep.resolve(1);
  await sweeper.whenIdle();
  await sweeper.close();
});

test("reports a failed sweep and continues scheduling recovery", async () => {
  const timers: Array<() => void> = [];
  const failures: unknown[] = [];
  let calls = 0;
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        calls += 1;
        if (calls === 2) throw new Error("temporary recovery failure");
        return 0;
      }
    },
    intervalMs: 1_000,
    setTimer(callback) {
      timers.push(callback);
      return {};
    },
    clearTimer() {},
    onError(error) {
      failures.push(error);
    }
  });

  await sweeper.start();
  timers.shift()!();
  await sweeper.whenIdle();

  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /temporary recovery failure/u);
  assert.equal(timers.length, 1);

  timers.shift()!();
  await sweeper.whenIdle();
  assert.equal(calls, 3);
  await sweeper.close();
});

test("start reports and propagates an initial recovery failure", async () => {
  const failures: unknown[] = [];
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        throw new Error("initial plan recovery failure");
      }
    },
    intervalMs: 1_000,
    onError(error) {
      failures.push(error);
    }
  });

  await assert.rejects(
    sweeper.start(),
    /initial plan recovery failure/u
  );
  assert.equal(failures.length, 1);
  await sweeper.close();
});

test("close waits for an in-flight sweep and is idempotent", async () => {
  const activeSweep = deferred<number>();
  let calls = 0;
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        calls += 1;
        return activeSweep.promise;
      }
    },
    intervalMs: 1_000
  });

  const starting = sweeper.start();
  await Promise.resolve();
  assert.equal(calls, 1);

  let closed = false;
  const closing = sweeper.close().then(() => {
    closed = true;
  });
  const closingAgain = sweeper.close();
  await Promise.resolve();
  assert.equal(closed, false);

  activeSweep.resolve(0);
  await Promise.all([starting, closing, closingAgain]);
  assert.equal(closed, true);
  await sweeper.close();
});

test("start is idempotent and rejects after close", async () => {
  let calls = 0;
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        calls += 1;
        return 0;
      }
    },
    intervalMs: 1_000
  });

  await sweeper.start();
  await sweeper.start();
  assert.equal(calls, 1);

  await sweeper.close();
  await assert.rejects(
    sweeper.start(),
    /ACQUISITION_PLAN_EXECUTION_RECOVERY_SWEEPER_CLOSED/u
  );
});

test("validates the periodic recovery interval", () => {
  const service = {
    async recoverExecutionIntents() {
      return 0;
    }
  };
  for (const intervalMs of [999, 86_400_001, 1_000.5]) {
    assert.throws(
      () => new AcquisitionPlanExecutionRecoverySweeper({
        service,
        intervalMs
      }),
      /intervalMs/u
    );
  }
});

test("close cancels a pending timer and ignores its stale callback", async () => {
  const timers: Array<() => void> = [];
  let cleared = 0;
  let calls = 0;
  const sweeper = new AcquisitionPlanExecutionRecoverySweeper({
    service: {
      async recoverExecutionIntents() {
        calls += 1;
        return 0;
      }
    },
    intervalMs: 1_000,
    setTimer(callback) {
      timers.push(callback);
      return {};
    },
    clearTimer() {
      cleared += 1;
    }
  });

  await sweeper.start();
  const staleCallback = timers.shift()!;
  await sweeper.close();
  await sweeper.close();
  staleCallback();
  await Promise.resolve();

  assert.equal(cleared, 1);
  assert.equal(calls, 1);
  assert.equal(timers.length, 0);
});
