import assert from "node:assert/strict";
import test from "node:test";
import type {
  AcquisitionDouyinIdentityResolutionOperation
} from "./acquisition-douyin-identity-resolution-operations.js";
import {
  AcquisitionDouyinIdentityResolutionRecoverySweeper
} from "./acquisition-douyin-identity-resolution-recovery-sweeper.js";

function operation(id: string): AcquisitionDouyinIdentityResolutionOperation {
  return {
    id,
    ownerId: `owner-${id}`,
    teamId: `team-${id}`,
    actorId: `actor-${id}`,
    candidateId: `candidate-${id}`,
    candidateVersion: 3,
    sourceEvidenceFingerprint: `sha256:${"a".repeat(64)}`,
    searchConnections: [{
      connectionId: "search-connection-1",
      providerId: "baidu-search",
      kind: "search",
      status: "active",
      credentialVersion: 1
    }],
    planSessionId: "acquisition-plan:run-1",
    status: id === "expired" ? "running" : "queued",
    currentStage: id === "expired" ? "independent_search" : null,
    outcome: null,
    retryable: false,
    canonicalProfileUrl: null,
    profileCandidates: [],
    evidence: [],
    intelligenceOperationId: null,
    createdAt: "2026-08-08T02:00:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z",
    completedAt: null
  };
}

test("start dispatches queued and expired operations and isolates one dispatch failure", async () => {
  const listedLimits: number[] = [];
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  const sweeper = new AcquisitionDouyinIdentityResolutionRecoverySweeper({
    service: {
      async listRecoverableOperations(options) {
        listedLimits.push(options.limit);
        return [operation("queued"), operation("expired")];
      }
    },
    async dispatch(scope, operationId) {
      dispatched.push(
        `${scope.ownerId}/${scope.teamId}/${scope.actorId}/${operationId}`
      );
      if (operationId === "queued") throw new Error("dispatch failed");
    },
    intervalMs: 1_000,
    batchSize: 100,
    setTimer() {
      return { unref() {} };
    },
    clearTimer() {},
    onError(error) {
      errors.push(error);
    }
  });

  await sweeper.start();

  assert.deepEqual(listedLimits, [100]);
  assert.deepEqual(dispatched, [
    "owner-queued/team-queued/actor-queued/queued",
    "owner-expired/team-expired/actor-expired/expired"
  ]);
  assert.equal(errors.length, 1);
  await sweeper.stop();
});

test("periodic sweeps never overlap and stop waits for the active sweep", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  let listCalls = 0;
  let releaseDispatch!: () => void;
  const pendingDispatch = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatched: string[] = [];
  const sweeper = new AcquisitionDouyinIdentityResolutionRecoverySweeper({
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

  const stopping = sweeper.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseDispatch();
  await Promise.all([starting, stopping]);
  assert.equal(stopped, true);
  assert.equal(callbacks.length, 0);
  assert.equal(cleared.length, 0);
  assert.deepEqual(dispatched, ["slow"]);
});

test("constructor rejects unbounded interval and batch settings", () => {
  const base = {
    service: {
      async listRecoverableOperations() {
        return [];
      }
    },
    async dispatch() {}
  };

  assert.throws(
    () => new AcquisitionDouyinIdentityResolutionRecoverySweeper({
      ...base,
      intervalMs: 999
    }),
    /intervalMs must be between 1000 and 86400000/u
  );
  assert.throws(
    () => new AcquisitionDouyinIdentityResolutionRecoverySweeper({
      ...base,
      batchSize: 101
    }),
    /batchSize must be between 1 and 100/u
  );
});
