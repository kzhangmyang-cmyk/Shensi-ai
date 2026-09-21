import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AcquisitionCandidateIntelligenceOperation
} from "./acquisition-candidate-intelligence-operations.js";
import {
  AcquisitionCandidateIntelligenceRecoverySweeper
} from "./acquisition-candidate-intelligence-recovery-sweeper.js";

function operation(id: string): AcquisitionCandidateIntelligenceOperation {
  return {
    id,
    ownerId: `owner-${id}`,
    teamId: `team-${id}`,
    actorId: `actor-${id}`,
    candidateId: `candidate-${id}`,
    sessionId: `session-${id}`,
    identityFingerprint: `sha256:${"a".repeat(64)}`,
    status: "queued",
    currentStage: null,
    completedStages: [],
    skippedStages: [],
    research: null,
    qualification: null,
    battleCardId: null,
    failure: null,
    createdAt: "2026-08-07T02:00:00.000Z",
    startedAt: null,
    updatedAt: "2026-08-07T02:00:00.000Z",
    completedAt: null,
    failedAt: null
  };
}

test("start dispatches a bounded recovery batch and continues after one failure", async () => {
  const listedLimits: number[] = [];
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  const sweeper = new AcquisitionCandidateIntelligenceRecoverySweeper({
    service: {
      async listRecoverableOperations(options) {
        listedLimits.push(options.limit);
        return [operation("a"), operation("b")].slice(0, options.limit);
      }
    },
    async dispatch(scope, operationId) {
      dispatched.push(
        `${scope.ownerId}/${scope.teamId}/${scope.actorId}/${operationId}`
      );
      if (operationId === "a") throw new Error("dispatch failed");
    },
    batchSize: 2,
    intervalMs: 60_000,
    setTimer() {
      return { unref() {} };
    },
    clearTimer() {},
    onError(error) {
      errors.push(error);
    }
  });

  await sweeper.start();

  assert.deepEqual(listedLimits, [2]);
  assert.deepEqual(dispatched, [
    "owner-a/team-a/actor-a/a",
    "owner-b/team-b/actor-b/b"
  ]);
  assert.equal(errors.length, 1);
  await sweeper.stop();
});

test("periodic sweep does not overlap and stop cancels future dispatch", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  let listCalls = 0;
  let releaseDispatch!: () => void;
  const pendingDispatch = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatched: string[] = [];
  const sweeper = new AcquisitionCandidateIntelligenceRecoverySweeper({
    service: {
      async listRecoverableOperations() {
        listCalls += 1;
        return listCalls === 1 ? [operation("slow")] : [operation("later")];
      }
    },
    async dispatch(_scope, operationId) {
      dispatched.push(operationId);
      if (operationId === "slow") await pendingDispatch;
    },
    batchSize: 10,
    intervalMs: 1_000,
    setTimer(callback) {
      callbacks.push(callback);
      return { callback, unref() {} };
    },
    clearTimer(timer) {
      cleared.push(timer);
    }
  });

  const starting = sweeper.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, ["slow"]);
  assert.equal(callbacks.length, 0);

  releaseDispatch();
  await starting;
  assert.equal(callbacks.length, 1);
  callbacks.shift()!();
  await sweeper.whenIdle();
  assert.deepEqual(dispatched, ["slow", "later"]);

  assert.equal(callbacks.length, 1);
  await sweeper.stop();
  assert.equal(cleared.length, 1);
  callbacks[0]?.();
  await sweeper.whenIdle();
  assert.deepEqual(dispatched, ["slow", "later"]);
});
