import assert from "node:assert/strict";
import test from "node:test";
import {
  executeModelConnectionWriteIdempotently,
  requireModelConnectionIdempotencyKey
} from "./model-providers/idempotency.js";
import {
  clearPersistedModelAppendBatches
} from "./model-providers/pending-appends.js";
import type {
  ModelConnectionIdempotencyRecord
} from "./model-providers/types.js";

function idempotencyRecord(
  teamId: string
): ModelConnectionIdempotencyRecord {
  return {
    ownerId: "owner-shared",
    teamId,
    idempotencyKeyHash: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    responseStatus: 200,
    responseBody: { teamId },
    createdAt: "2026-07-24T00:00:00.000Z"
  };
}

test("failed persistence leaves no phantom replay or business mutation", async () => {
  const records: ModelConnectionIdempotencyRecord[] = [];
  const pending: ModelConnectionIdempotencyRecord[] = [];
  const mutations: string[] = [];
  let shouldFail = true;
  const store = {
    modelConnectionIdempotencyRecords: records,
    pendingModelConnectionIdempotencyRecords: pending,
    async persist() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("injected persistence failure");
      }
    }
  };
  const request = {
    ownerId: "owner_1",
    teamId: "team_1",
    idempotencyKey: "retry-after-failure",
    method: "POST",
    path: "/api/v1/ai/connections",
    body: { provider: "openai", model: "gpt-test" }
  };
  const mutate = async () => {
    mutations.push("connection_1");
    return {
      status: 200,
      body: { id: "connection_1" },
      rollback() {
        mutations.pop();
      }
    };
  };

  await assert.rejects(
    executeModelConnectionWriteIdempotently(store, request, mutate),
    /injected persistence failure/
  );
  assert.deepEqual(mutations, []);
  assert.deepEqual(records, []);
  assert.deepEqual(pending, []);

  const retry = await executeModelConnectionWriteIdempotently(
    store,
    request,
    mutate
  );
  assert.equal(retry.replayed, false);
  assert.deepEqual(mutations, ["connection_1"]);
  assert.equal(records.length, 1);

  const replay = await executeModelConnectionWriteIdempotently(
    store,
    request,
    async () => {
      throw new Error("replay must not run the mutation");
    }
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, retry.body);
  assert.deepEqual(mutations, ["connection_1"]);
});

test("Idempotency-Key accepts 200 characters and rejects 201", () => {
  assert.equal(
    requireModelConnectionIdempotencyKey("k".repeat(200)).length,
    200
  );
  assert.throws(
    () => requireModelConnectionIdempotencyKey("k".repeat(201)),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "idempotency_key_invalid"
      );
      assert.equal((error as { status?: number }).status, 400);
      return true;
    }
  );
});

test("model connection writes mutate inside the store persistence queue", async () => {
  const records: ModelConnectionIdempotencyRecord[] = [];
  const pending: ModelConnectionIdempotencyRecord[] = [];
  let insidePersistenceQueue = false;
  let directPersistCalls = 0;
  let mutationCalls = 0;
  const store = {
    modelConnectionIdempotencyRecords: records,
    pendingModelConnectionIdempotencyRecords: pending,
    async persist() {
      directPersistCalls += 1;
    },
    async persistAsyncMutation<T>(
      mutation: () => Promise<{
        value: T;
        rollback(): void | Promise<void>;
      }>
    ) {
      insidePersistenceQueue = true;
      const applied = await mutation();
      insidePersistenceQueue = false;
      return applied.value;
    }
  };

  const result = await executeModelConnectionWriteIdempotently(
    store,
    {
      ownerId: "owner-serialized",
      teamId: "team-serialized",
      idempotencyKey: "serialized-model-write",
      method: "POST",
      path: "/api/v1/ai/connections",
      body: { provider: "zhipu", model: "glm-4.5" }
    },
    async () => {
      assert.equal(
        insidePersistenceQueue,
        true,
        "business mutation must begin after entering the shared store queue"
      );
      mutationCalls += 1;
      return {
        status: 200,
        body: { id: "connection-serialized" }
      };
    }
  );

  assert.equal(result.replayed, false);
  assert.equal(mutationCalls, 1);
  assert.equal(directPersistCalls, 0);
  assert.equal(records.length, 1);
  assert.equal(pending.length, 1);
});

test("the same owner can reuse an idempotency key independently per team", async () => {
  const records: ModelConnectionIdempotencyRecord[] = [];
  const pending: ModelConnectionIdempotencyRecord[] = [];
  const store = {
    modelConnectionIdempotencyRecords: records,
    pendingModelConnectionIdempotencyRecords: pending,
    async persist() {}
  };
  let mutationCalls = 0;
  const request = {
    ownerId: "owner-shared",
    idempotencyKey: "same-key-in-two-teams",
    method: "POST",
    path: "/api/v1/ai/connections",
    body: { provider: "openai", model: "gpt-test" }
  };

  const teamA = await executeModelConnectionWriteIdempotently(
    store,
    { ...request, teamId: "team-a" },
    async () => {
      mutationCalls += 1;
      return {
        status: 200,
        body: { id: "connection-team-a" }
      };
    }
  );
  const teamB = await executeModelConnectionWriteIdempotently(
    store,
    { ...request, teamId: "team-b" },
    async () => {
      mutationCalls += 1;
      return {
        status: 200,
        body: { id: "connection-team-b" }
      };
    }
  );

  assert.equal(teamA.replayed, false);
  assert.equal(teamB.replayed, false);
  assert.equal(mutationCalls, 2);
  assert.deepEqual(
    records.map((item) => item.teamId).sort(),
    ["team-a", "team-b"]
  );
});

test("clearing a persisted idempotency append keeps another team's key", () => {
  const teamA = idempotencyRecord("team-a");
  const teamB = idempotencyRecord("team-b");
  const live = {
    pendingModelCredentialVersions: [],
    pendingModelConnectionActivationEvents: [],
    pendingAiJobModelSnapshots: [],
    pendingModelConnectionIdempotencyRecords: [teamA, teamB],
    pendingModelCallRecords: []
  };

  clearPersistedModelAppendBatches(live, {
    ...live,
    pendingModelConnectionIdempotencyRecords: [teamA]
  });

  assert.deepEqual(
    live.pendingModelConnectionIdempotencyRecords,
    [teamB]
  );
});
