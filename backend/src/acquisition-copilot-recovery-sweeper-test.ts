import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionCopilotRecoverySweeper
} from "./acquisition-copilot-recovery-sweeper.js";

const SCOPE = {
  ownerId: "owner-recovery",
  teamId: "team-recovery",
  actorId: "actor-recovery"
};

test("periodic sweeps recover tasks that become eligible after startup", async () => {
  let now = Date.parse("2026-07-24T00:00:00.000Z");
  let recoveryCalls = 0;
  const dispatched: string[] = [];
  const timers: Array<() => void> = [];
  const service = {
    async recoverInterruptedTasks() {
      recoveryCalls += 1;
      return recoveryCalls === 1
        ? []
        : [{
            id: "task-expired-after-startup",
            ...SCOPE
          }];
    },
    async claimTaskDispatch() {
      return true;
    },
    async markDispatchFailed() {
      throw new Error("must not be called");
    }
  };
  const sweeper = new AcquisitionCopilotRecoverySweeper({
    service,
    dispatchTask: async (_scope, taskId) => {
      dispatched.push(taskId);
    },
    intervalMs: 60_000,
    staleRunningMs: 10 * 60_000,
    nowMs: () => now,
    setTimer(callback) {
      timers.push(callback);
      return { unref() {} };
    },
    clearTimer() {}
  });

  await sweeper.start();
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(dispatched, []);
  assert.equal(timers.length, 1);

  now += 60_000;
  timers.shift()!();
  await sweeper.whenIdle();

  assert.equal(recoveryCalls, 2);
  assert.deepEqual(dispatched, ["task-expired-after-startup"]);
  assert.equal(timers.length, 1, "the next sweep must be scheduled");
  await sweeper.close();
});

test("sweeper does not overlap, reports failures, and stops scheduling on close", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timers: Array<() => void> = [];
  const failures: unknown[] = [];
  let calls = 0;
  const sweeper = new AcquisitionCopilotRecoverySweeper({
    service: {
      async recoverInterruptedTasks() {
        calls += 1;
        if (calls === 1) await gate;
        throw new Error("temporary database failure");
      },
      async claimTaskDispatch() {
        return false;
      },
      async markDispatchFailed() {}
    },
    async dispatchTask() {},
    intervalMs: 10_000,
    nowMs: () => Date.parse("2026-07-24T00:00:00.000Z"),
    setTimer(callback) {
      timers.push(callback);
      return { unref() {} };
    },
    clearTimer() {},
    onError(error) {
      failures.push(error);
    }
  });

  const start = sweeper.start();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.length, 0);
  release();
  await start;
  assert.equal(failures.length, 1);
  assert.equal(timers.length, 1);

  const scheduled = timers.shift()!;
  const close = sweeper.close();
  scheduled();
  await close;
  await sweeper.whenIdle();
  assert.equal(calls, 1, "closed sweepers must ignore pending timer callbacks");
  assert.equal(timers.length, 0);
});

test("a synchronous dispatch rejection is durably marked failed", async () => {
  const marked: Array<{ taskId: string; errorCode: string }> = [];
  const sweeper = new AcquisitionCopilotRecoverySweeper({
    service: {
      async recoverInterruptedTasks() {
        return [{ id: "task-sync-failure", ...SCOPE }];
      },
      async claimTaskDispatch() {
        return true;
      },
      async markDispatchFailed(_scope, taskId, errorCode) {
        marked.push({ taskId, errorCode });
      }
    },
    dispatchTask() {
      throw new Error("application is closing");
    },
    intervalMs: 60_000
  });

  await sweeper.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(marked, [{
    taskId: "task-sync-failure",
    errorCode: "COPILOT_DISPATCH_FAILED"
  }]);
  await sweeper.close();
});
