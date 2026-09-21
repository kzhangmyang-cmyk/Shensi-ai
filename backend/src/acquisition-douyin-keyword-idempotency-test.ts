import assert from "node:assert/strict";
import test from "node:test";
import { executeModelConnectionWriteIdempotently } from "./model-providers/idempotency.js";
import { createSerializedTaskQueue } from "./mysql-store.js";
import type { ModelConnectionIdempotencyRecord } from "./model-providers/types.js";

const command = {
  ownerId: "keyword-owner", teamId: "keyword-team", idempotencyKey: "keyword-serialized-0001",
  method: "POST", path: "/api/v1/acquisition/plans/plan-a/automation/keyword-suggestions",
  body: { planId: "plan-a", planRevision: "r1" }
};
const resultPersistence = { persistenceScope: "result" as const };

function serializedStore() {
  const enqueue = createSerializedTaskQueue();
  let durable: ModelConnectionIdempotencyRecord[] = [];
  let failResultWrite = false;
  const store = {
    modelConnectionIdempotencyRecords: [] as ModelConnectionIdempotencyRecord[],
    pendingModelConnectionIdempotencyRecords: [] as ModelConnectionIdempotencyRecord[],
    readBarrier: () => enqueue(async () => undefined),
    persist: () => enqueue(async () => undefined),
    persistAsyncMutation<T>(mutation: () => Promise<{ value: T; rollback(): void | Promise<void> }>) {
      return enqueue(async () => {
        const applied = await mutation();
        try {
          if (failResultWrite) throw new Error("result persistence failed");
          durable = structuredClone(store.modelConnectionIdempotencyRecords);
          return applied.value;
        } catch (error) {
          await applied.rollback();
          throw error;
        }
      });
    }
  };
  return { store, durable: () => durable, failResultWrite(value: boolean) { failResultWrite = value; } };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("model command blocked the persistence queue")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

test("keyword command persists its snapshot without queue reentry and replays concurrent requests", async () => {
  const { store, durable } = serializedStore();
  let calls = 0;
  let markModelStarted!: () => void;
  let finishModel!: () => void;
  const started = new Promise<void>(resolve => { markModelStarted = resolve; });
  const modelGate = new Promise<void>(resolve => { finishModel = resolve; });
  const operation = async () => {
    await store.readBarrier();
    await store.persist();
    calls++;
    markModelStarted();
    await modelGate;
    try {
      return { status: 200, body: { keywords: ["郑州租车"], modelSnapshotId: "snapshot-1" } };
    } finally { await store.persist(); }
  };
  const first = executeModelConnectionWriteIdempotently(store, command, operation, resultPersistence);
  const duplicate = executeModelConnectionWriteIdempotently(store, command, operation, resultPersistence);
  try {
    await bounded(started);
    await bounded(store.readBarrier());
  } finally { finishModel(); }
  const [created, replay] = await bounded(Promise.all([first, duplicate]));
  assert.equal(calls, 1);
  assert.equal(created.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, { keywords: ["郑州租车"], modelSnapshotId: "snapshot-1" });
  assert.equal(durable().length, 1);
  await assert.rejects(executeModelConnectionWriteIdempotently(store,
    { ...command, body: { ...command.body, planRevision: "r2" } }, operation, resultPersistence),
    (error: unknown) => (error as { code?: string }).code === "idempotency_key_conflict");
  assert.equal(calls, 1);
  await bounded(store.persist());
});

test("failed keyword result persistence leaves no phantom replay and allows a retry", async () => {
  const fixture = serializedStore();
  let calls = 0;
  const operation = async () => {
    calls++;
    return { status: 200, body: { keywords: ["租车"], modelSnapshotId: `snapshot-${calls}` } };
  };
  fixture.failResultWrite(true);
  await assert.rejects(bounded(executeModelConnectionWriteIdempotently(
    fixture.store, command, operation, resultPersistence)), /result persistence failed/);
  assert.deepEqual(fixture.store.modelConnectionIdempotencyRecords, []);
  assert.deepEqual(fixture.store.pendingModelConnectionIdempotencyRecords, []);
  assert.deepEqual(fixture.durable(), []);
  fixture.failResultWrite(false);
  const retry = await bounded(executeModelConnectionWriteIdempotently(
    fixture.store, command, operation, resultPersistence));
  assert.equal(retry.replayed, false);
  assert.equal(calls, 2);
  assert.equal(fixture.durable().length, 1);
  await bounded(fixture.store.readBarrier());
});

test("failed keyword model work releases the command and persistence queues", async () => {
  const { store, durable } = serializedStore();
  await assert.rejects(bounded(executeModelConnectionWriteIdempotently(store, command, async () => {
    await store.persist();
    try { throw new Error("model unavailable"); }
    finally { await store.persist(); }
  }, resultPersistence)), /model unavailable/);
  assert.deepEqual(durable(), []);
  assert.deepEqual(store.modelConnectionIdempotencyRecords, []);
  await bounded(store.readBarrier());
  const retry = await bounded(executeModelConnectionWriteIdempotently(store, command,
    async () => ({ status: 200, body: { keywords: ["租车"], modelSnapshotId: "snapshot-retry" } }),
    resultPersistence));
  assert.equal(retry.replayed, false);
});

test("durably replays a tenant scoped semantic keyword command without duplicate model work", async () => {
  const records: any[] = []; const store = { modelConnectionIdempotencyRecords: records, pendingModelConnectionIdempotencyRecords: [] as any[], async persist() {} };
  let calls = 0;
  const request = { ownerId: "owner", teamId: "team", idempotencyKey: "keyword-0001", method: "POST", path: "/api/v1/acquisition/plans/plan-a/automation/keyword-suggestions", body: { operation: "douyin_keyword_suggestions", workspaceId: "workspace-a", planId: "plan-a", planRevision: "r1" } };
  const first = await executeModelConnectionWriteIdempotently(store, request, async () => ({ status: 200, body: { keywords: ["工厂获客"], modelSnapshotId: `snapshot-${++calls}` } }));
  assert.equal(first.replayed, false);
  const restarted = { ...store, pendingModelConnectionIdempotencyRecords: [] as any[] };
  const replay = await executeModelConnectionWriteIdempotently(restarted, request, async () => ({ status: 200, body: { keywords: ["不应调用"], modelSnapshotId: `snapshot-${++calls}` } }));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(calls, 1);
  await assert.rejects(executeModelConnectionWriteIdempotently(restarted, { ...request, body: { ...request.body, planRevision: "r2" } }, async () => ({ status: 200, body: {} })), (error: any) => error.code === "idempotency_key_conflict");
});
