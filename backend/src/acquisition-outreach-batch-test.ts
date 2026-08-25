import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-repository.js";
import {
  AcquisitionOutreachBatchService,
  AcquisitionOutreachBatchError
} from "./acquisition-outreach-batch-service.js";
import { outreachBatchEtag } from "./acquisition-outreach-batch.js";
import { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";

const scope = { workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", actorId: "approver-1" };
const now = "2026-08-25T02:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;
const draftHash = `sha256:${"b".repeat(64)}`;

function fixture(options: { dailyLimit?: number; failActionInsertAt?: number } = {}) {
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    failActionInsertAt: options.failActionInsertAt
  });
  let candidateRevision = 1;
  let dnc = false;
  let accountVersion = 3;
  const service = new AcquisitionOutreachBatchService({
    repository,
    idFactory: (kind) => `${kind}-${crypto.randomUUID()}`,
    now: () => now,
    loadRunAuthority: async (requestedScope, runId) => {
      if (requestedScope.workspaceId !== scope.workspaceId || runId !== "run-1") return null;
      return {
        workspaceId: scope.workspaceId, runId, planId: "plan-1",
        planVersionId: "plan-version-2", planVersion: 2,
        planSnapshotHash: `sha256:${"1".repeat(64)}`,
        policyVersionId: "policy-9", policyHash: `sha256:${"2".repeat(64)}`,
        accountId: "account-1", accountLoginStateVersion: 3,
        dailyBudgetId: `sha256:${"3".repeat(64)}`, localDate: "2026-08-25",
        dailyCandidateLimit: options.dailyLimit ?? 50
      };
    },
    listRunCandidateIds: async () => ["candidate-1"],
    generateDraft: async (_requestedScope, candidateId) => ({
      candidateId, candidateRevision, evidenceHashes: [evidenceHash],
      comment: "看到你公开提到需要获客方案",
      directMessage: "根据你公开提到需要获客方案，如你愿意，可交流公开场景里的思路",
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-job-1",
      contentHash: draftHash
    }),
    loadCandidateAuthority: async (_requestedScope, candidateId) => ({
      candidateId, candidateRevision, evidenceHashes: [evidenceHash],
      evidenceText: ["需要获客方案"], publicActorKey: "actor-hash-1", doNotContact: dnc
    }),
    loadAccountAuthority: async () => ({
      accountId: "account-1", state: "active", loginStateVersion: accountVersion
    })
  });
  return {
    repository, service,
    setCandidateRevision: (value: number) => { candidateRevision = value; },
    setDnc: (value: boolean) => { dnc = value; },
    setAccountVersion: (value: number) => { accountVersion = value; }
  };
}

async function created(value = fixture()) {
  const result = await value.service.create(scope, "run-1", "create-key-0001", {
    candidateIds: ["candidate-1"]
  });
  return { value, batch: result.value };
}

test("creation persists Task 6 values as immutable candidate revision 1 and freezes run authority", async () => {
  const { batch } = await created();
  assert.equal(batch.revision, 1);
  assert.equal(batch.state, "awaiting_approval");
  assert.equal(batch.policyVersionId, "policy-9");
  assert.equal(batch.dailyCandidateLimit, 50);
  assert.equal(batch.dailyRemainingLimit, 50);
  assert.equal(batch.candidates[0]?.draftRevision, 1);
  assert.equal(batch.candidates[0]?.comment, "看到你公开提到需要获客方案");
  assert.equal(batch.candidates[0]?.sourceModelSnapshotId, "model-job-1");
  assert.match(batch.batchHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(batch.etag, outreachBatchEtag(batch.id, 1));
});

test("PUT removes candidates and valid human edits create batch and draft revision 2", async () => {
  const { value, batch } = await created();
  const edited = await value.service.put(scope, batch.id, batch.etag, "put-key-0001", {
    candidates: [{
      candidateId: "candidate-1", selected: true,
      comment: "需要获客方案，期待交流",
      directMessage: "看到你公开提到需要获客方案，方便的话，可交流公开场景里的思路"
    }]
  });
  assert.equal(edited.value.revision, 2);
  assert.equal(edited.value.candidates[0]?.draftRevision, 2);
  assert.equal(edited.value.candidates[0]?.modelSnapshotId, "model-job-1");
  assert.equal(edited.value.candidates[0]?.sourceModelSnapshotId, "model-job-1");
  await assert.rejects(
    value.service.put(scope, batch.id, edited.value.etag, "put-key-0002", { candidates: [] }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_empty"
  );
});

test("approval rejects stale revisions, replays an exact command, and conflicts on changed semantics", async () => {
  const { value, batch } = await created();
  await assert.rejects(
    value.service.approve(scope, batch.id, '"outreach-batch:stale:1"', "approve-key-0001", {
      revision: 1, batchHash: batch.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_stale"
  );
  const command = { revision: 1, batchHash: batch.batchHash, confirm: true as const };
  const approved = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", command);
  const replay = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", command);
  assert.equal(approved.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, approved.value);
  await assert.rejects(
    value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", { ...command, batchHash: `sha256:${"9".repeat(64)}` }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_idempotency_conflict"
  );
});

test("approval creates an ordered queued comment and blocked direct message with exact frozen contents", async () => {
  const { value, batch } = await created();
  const approved = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0002", {
    revision: 1, batchHash: batch.batchHash, confirm: true
  });
  assert.notEqual(approved.value.etag, batch.etag);
  const actions = await value.service.actions(scope, batch.id);
  assert.deepEqual(actions.map(({ kind, sequence, status }) => ({ kind, sequence, status })), [
    { kind: "comment", sequence: 1, status: "queued" },
    { kind: "direct_message", sequence: 2, status: "blocked_by_predecessor" }
  ]);
  assert.equal(actions[0]?.content, batch.candidates[0]?.comment);
  assert.equal(actions[1]?.content, batch.candidates[0]?.directMessage);
});

test("the selected policy limit is authoritative and remaining allowance is shared by account and local date", async () => {
  const value = fixture({ dailyLimit: 1 });
  const first = await value.service.create(scope, "run-1", "create-limit-1", { candidateIds: ["candidate-1"] });
  await value.service.approve(scope, first.value.id, first.value.etag, "approve-limit-1", {
    revision: 1, batchHash: first.value.batchHash, confirm: true
  });
  const second = await value.service.create(scope, "run-1", "create-limit-2", { candidateIds: ["candidate-1"] });
  assert.equal(second.value.dailyRemainingLimit, 0);
  await assert.rejects(
    value.service.approve(scope, second.value.id, second.value.etag, "approve-limit-2", {
      revision: 1, batchHash: second.value.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_daily_limit_exhausted"
  );
});

test("approval rechecks DNC, candidate revision/evidence, and account login authority", async () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => value.setDnc(true),
    (value: ReturnType<typeof fixture>) => value.setCandidateRevision(2),
    (value: ReturnType<typeof fixture>) => value.setAccountVersion(4)
  ]) {
    const { value, batch } = await created();
    mutate(value);
    await assert.rejects(
      value.service.approve(scope, batch.id, batch.etag, `approve-recheck-${crypto.randomUUID()}`, {
        revision: 1, batchHash: batch.batchHash, confirm: true
      }),
      (error: unknown) => error instanceof AcquisitionOutreachBatchError
        && ["candidate_evidence_invalid", "douyin_login_expired"].includes(error.code)
    );
    assert.equal((await value.service.actions(scope, batch.id)).length, 0);
  }
});

test("cross-workspace access is rejected and two approvers produce one winner", async () => {
  const { value, batch } = await created();
  await assert.rejects(
    value.service.get({ ...scope, workspaceId: "workspace-2" }, batch.id),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_not_found"
  );
  const command = { revision: 1, batchHash: batch.batchHash, confirm: true as const };
  const outcomes = await Promise.allSettled([
    value.service.approve(scope, batch.id, batch.etag, "approver-race-1", command),
    value.service.approve({ ...scope, actorId: "approver-2" }, batch.id, batch.etag, "approver-race-2", command)
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await value.service.actions(scope, batch.id)).length, 2);
});

test("memory approval is failure-atomic when the second action insert fails", async () => {
  const { value, batch } = await created(fixture({ failActionInsertAt: 2 }));
  await assert.rejects(value.service.approve(scope, batch.id, batch.etag, "approve-fail-2", {
    revision: 1, batchHash: batch.batchHash, confirm: true
  }), /test_action_insert_failure/u);
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
});

test("memory batch transaction shares a reentrant authority coordinator with DNC writers", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions: coordinator });
  const ordering: string[] = [];
  const completed = coordinator.transaction(async () => {
    ordering.push("outer");
    await coordinator.transaction(() => { ordering.push("nested-authority"); });
    await repository.remaining("workspace-1", "account-1", "2026-08-25", 50);
  });
  await assert.doesNotReject(Promise.race([
    completed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("memory_authority_deadlock")), 100))
  ]));
  assert.deepEqual(ordering, ["outer", "nested-authority"]);
});

test("rejection and approved pause/resume are revision-bound state transitions", async () => {
  const first = await created();
  const rejected = await first.value.service.reject(scope, first.batch.id, first.batch.etag, "reject-key-1", { reason: "not suitable" });
  assert.equal(rejected.value.state, "rejected");
  const second = await created();
  const approved = await second.value.service.approve(scope, second.batch.id, second.batch.etag, "approve-state-1", {
    revision: 1, batchHash: second.batch.batchHash, confirm: true
  });
  const paused = await second.value.service.pause(scope, second.batch.id, approved.value.etag, "pause-key-1", { reason: "operator review" });
  assert.equal(paused.value.state, "paused");
  assert.notEqual(paused.value.etag, approved.value.etag);
  await assert.rejects(
    second.value.service.resume(scope, second.batch.id, approved.value.etag,
      "resume-stale-key-1", {}),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_batch_stale"
  );
  const resumed = await second.value.service.resume(scope, second.batch.id, paused.value.etag, "resume-key-1", {});
  assert.equal(resumed.value.state, "approved");
  assert.notEqual(resumed.value.etag, paused.value.etag);
});
