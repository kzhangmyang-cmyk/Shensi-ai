import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-repository.js";
import {
  AcquisitionOutreachBatchService,
  AcquisitionOutreachBatchError
} from "./acquisition-outreach-batch-service.js";
import {
  outreachBatchEtag,
  validOutreachTarget,
  type AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";

const scope = { workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", actorId: "approver-1" };
const now = "2026-08-25T02:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;
const draftHash = `sha256:${"b".repeat(64)}`;

function fixture(options: {
  dailyLimit?: number;
  failActionInsertAt?: number;
  douyinOutreachActionsEnabled?: boolean;
  commentTargetPublicUrl?: string;
  publicProfileUrl?: string;
  reconcileAction?: (input: {
    actionId: string; accountHandle: string; loginStateVersion: number;
    kind: "comment" | "direct_message"; targetPublicUrl: string;
    content: string; approvedContentHash: string; deadlineAt: string;
  }) => Promise<{ actionId: string; state: "succeeded" | "failed";
    platformReceiptReference: string | null; occurredAt: string;
    failureCode: string | null }>;
} = {}) {
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    failActionInsertAt: options.failActionInsertAt
  });
  let candidateRevision = 1;
  let dnc = false;
  let accountVersion = 3;
  let accountState = "active";
  let commentTargetPublicUrl = options.commentTargetPublicUrl
    ?? "https://www.douyin.com/video/video-1";
  const service = new AcquisitionOutreachBatchService({
    repository,
    douyinOutreachActionsEnabled:
      options.douyinOutreachActionsEnabled ?? true,
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
      , publicProfileUrl: options.publicProfileUrl
        ?? "https://www.douyin.com/user/actor-1",
      commentTargetPublicUrl
    }),
    loadAccountAuthority: async () => ({
      accountId: "account-1", state: accountState, loginStateVersion: accountVersion,
      accountHandle: "private-handle"
    }),
    reconcileAction: options.reconcileAction
  });
  return {
    repository, service,
    setCandidateRevision: (value: number) => { candidateRevision = value; },
    setDnc: (value: boolean) => { dnc = value; },
    setAccountVersion: (value: number) => { accountVersion = value; },
    setAccountState: (value: string) => { accountState = value; },
    setCommentTargetPublicUrl: (value: string) => { commentTargetPublicUrl = value; }
  };
}

async function created(value = fixture()) {
  const result = await value.service.create(scope, "run-1", "create-key-0001", {
    candidateIds: ["candidate-1"]
  });
  return { value, batch: result.value };
}

function discoveryBatch(input: {
  id: string; workspaceId: string; runId: string; candidateId: string; createdAt: string;
}): AcquisitionOutreachBatch {
  return {
    id: input.id, workspaceId: input.workspaceId, runId: input.runId,
    planId: "plan-discovery", planVersionId: "plan-version-discovery", planVersion: 1,
    planSnapshotHash: `sha256:${"d".repeat(64)}`, policyVersionId: "policy-discovery",
    policyHash: `sha256:${"e".repeat(64)}`, accountId: "account-discovery",
    accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"f".repeat(64)}`,
    localDate: "2026-08-27", dailyCandidateLimit: 9, dailyRemainingLimit: 9,
    revision: 1, etag: outreachBatchEtag(input.id, 1), state: "awaiting_approval",
    candidates: [{ candidateId: input.candidateId, selected: true, candidateRevision: 1,
      evidenceHashes: [`sha256:${"a".repeat(64)}`], evidenceText: ["公开线索"],
      publicActorKey: "actor-discovery", publicProfileUrl: "https://www.douyin.com/user/discovery",
      commentTargetPublicUrl: "https://www.douyin.com/video/discovery", draftRevision: 1,
      comment: "公开评论", commentHash: `sha256:${"b".repeat(64)}`,
      directMessage: "公开私信", directMessageHash: `sha256:${"c".repeat(64)}`,
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-discovery",
      sourceModelSnapshotId: "model-discovery", contentHash: `sha256:${"0".repeat(64)}` }],
    batchHash: `sha256:${"1".repeat(64)}`, approvedBy: null, approvedAt: null,
    approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
    pauseReason: null, createdBy: "creator-discovery", createdAt: input.createdAt,
    updatedBy: "creator-discovery", updatedAt: input.createdAt
  };
}

test("candidate-scoped discovery returns only current heads in descending keyset pages", async () => {
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const batches = [
    discoveryBatch({ id: "batch-page-a", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T03:00:00.000Z" }),
    discoveryBatch({ id: "batch-page-z", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T04:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-workspace", workspaceId: "workspace-2", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T05:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-run", workspaceId: "workspace-1", runId: "run-2", candidateId: "candidate-1", createdAt: "2026-08-27T06:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-candidate", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-2", createdAt: "2026-08-27T07:00:00.000Z" })
  ];
  for (const batch of batches) await repository.create({ workspaceId: batch.workspaceId,
    operation: `create:${batch.id}`, idempotencyKey: `key:${batch.id}`,
    requestHash: `sha256:${batch.id.padEnd(64, "0").slice(0, 64)}`, batch });
  const revised = await repository.replace({ workspaceId: "workspace-1", batchId: "batch-page-a",
    ifMatch: outreachBatchEtag("batch-page-a", 1), operation: "put", idempotencyKey: "key:revision",
    requestHash: `sha256:${"2".repeat(64)}`, build: (current) => ({ ...current, revision: 2,
      etag: outreachBatchEtag(current.id, 2), updatedAt: "2026-08-27T08:00:00.000Z" }) });
  assert.equal(revised.kind, "created");

  const firstPage = await repository.listByRunCandidate({
    workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", limit: 1, after: null
  });
  assert.deepEqual(firstPage.items.map((batch) => batch.id), ["batch-page-z"]);
  assert.ok(firstPage.next);
  const secondPage = await repository.listByRunCandidate({
    workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", limit: 1, after: firstPage.next
  });
  assert.deepEqual(secondPage.items.map((batch) => batch.id), ["batch-page-a"]);
  assert.equal(secondPage.items[0]?.revision, 2);
  assert.equal(secondPage.next, null);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
});

test("candidate discovery recalculates remaining allowance and removes private evidence fields", async () => {
  const value = fixture({ dailyLimit: 3 });
  const batch = await value.service.create(scope, "run-1", "create-discovery-public", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, batch.value.id, batch.value.etag, "approve-discovery-public", {
    revision: 1, batchHash: batch.value.batchHash, confirm: true
  });

  const publicPage = await value.service.listByRunCandidate(scope, {
    runId: "run-1", candidateId: "candidate-1", limit: 4, after: null
  });
  assert.equal(publicPage.items.length, 1);
  assert.equal(publicPage.items[0]?.dailyRemainingLimit, 2);
  const candidate = publicPage.items[0]?.candidates[0] as Record<string, unknown>;
  assert.equal(candidate.evidenceText, undefined);
  assert.equal(candidate.publicActorKey, undefined);
  assert.equal(candidate.publicProfileUrl, undefined);
  assert.equal(candidate.commentTargetPublicUrl, undefined);
});

test("candidate discovery normalizes an offset anchor before repository keyset lookup", async () => {
  const value = fixture();
  let receivedAnchor: { createdAt: string; batchId: string } | null = null;
  const list = value.repository.listByRunCandidate.bind(value.repository);
  value.repository.listByRunCandidate = async (input) => {
    receivedAnchor = input.after;
    return list(input);
  };

  await value.service.listByRunCandidate(scope, {
    runId: "run-1", candidateId: "candidate-1", limit: 1,
    after: { createdAt: "2026-08-25T11:00:00+08:00", batchId: "batch-offset-anchor" }
  });
  assert.deepEqual(receivedAnchor, {
    createdAt: "2026-08-25T03:00:00.000Z", batchId: "batch-offset-anchor"
  });
});

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

test("PUT rejects a canonical target that drifted from the frozen candidate", async () => {
  const { value, batch } = await created();
  value.setCommentTargetPublicUrl("https://www.douyin.com/video/video-2");

  await assert.rejects(
    value.service.put(scope, batch.id, batch.etag, "put-target-drift", {
      candidates: [{
        candidateId: "candidate-1", selected: true,
        comment: batch.candidates[0]!.comment,
        directMessage: batch.candidates[0]!.directMessage
      }]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "candidate_evidence_invalid"
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

test("manual reconciliation proves an uncertain action read-only and never requeues it", async () => {
  const reconciliationCalls: string[] = [];
  const value = fixture({
    reconcileAction: async (input) => {
      reconciliationCalls.push(input.actionId);
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:reconciled-123",
        occurredAt: "2026-08-25T02:05:00.000Z",
        failureCode: null
      };
    }
  });
  const created = await value.service.create(scope, "run-1", "create-reconcile", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, created.value.id, created.value.etag,
    "approve-reconcile", {
      revision: created.value.revision,
      batchHash: created.value.batchHash,
      confirm: true
    });
  const claim = await value.repository.claimNextAction({
    workerId: "worker-reconcile",
    now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(claim);
  await value.repository.completeActionFailure(
    claim.fence,
    "douyin_action_receipt_ambiguous",
    "2026-08-25T02:04:00.000Z"
  );
  value.setAccountState("risk_paused");

  const reconciled = await value.service.reconcileAction(
    scope,
    created.value.id,
    claim.action.id,
    {
      batchRevision: claim.action.batchRevision,
      approvalHash: claim.action.approvalHash,
      contentHash: claim.action.contentHash,
      confirm: true
    }
  );

  assert.equal(reconciled.status, "succeeded");
  assert.equal(reconciled.platformReceiptReference,
    "douyin-comment:reconciled-123");
  assert.deepEqual(reconciliationCalls, [claim.action.id]);
  const actions = await value.service.actions(scope, created.value.id);
  assert.deepEqual(actions.map((action) => action.status), [
    "succeeded", "risk_paused"
  ]);
  assert.equal(await value.repository.claimNextAction({
    workerId: "worker-must-not-resend",
    now: "2026-08-25T02:10:00.000Z",
    leaseDurationMs: 180_000
  }), null);
});

test("manual reconciliation rejects disconnected or stale account authority before sidecar", async () => {
  let calls = 0;
  const value = fixture({
    reconcileAction: async (input) => {
      calls += 1;
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:must-not-be-used",
        occurredAt: now,
        failureCode: null
      };
    }
  });
  const created = await value.service.create(scope, "run-1", "create-reconcile-authority", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, created.value.id, created.value.etag,
    "approve-reconcile-authority", {
      revision: created.value.revision,
      batchHash: created.value.batchHash,
      confirm: true
    });
  const claim = await value.repository.claimNextAction({
    workerId: "worker-reconcile-authority",
    now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(claim);
  await value.repository.completeActionFailure(
    claim.fence,
    "douyin_action_timeout",
    "2026-08-25T02:04:00.000Z"
  );
  const command = {
    batchRevision: claim.action.batchRevision,
    approvalHash: claim.action.approvalHash,
    contentHash: claim.action.contentHash,
    confirm: true as const
  };

  value.setAccountState("disconnected");
  await assert.rejects(value.service.reconcileAction(
    scope, created.value.id, claim.action.id, command
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "douyin_login_expired");

  value.setAccountState("risk_paused");
  value.setAccountVersion(4);
  await assert.rejects(value.service.reconcileAction(
    scope, created.value.id, claim.action.id, command
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "douyin_login_expired");
  assert.equal(calls, 0);
});

test("manual reconciliation fails closed before sidecar unless authority is exact and uncertain", async () => {
  let calls = 0;
  const { value, batch } = await created(fixture({
    reconcileAction: async (input) => {
      calls += 1;
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:must-not-be-used",
        occurredAt: now,
        failureCode: null
      };
    }
  }));
  await value.service.approve(scope, batch.id, batch.etag,
    "approve-reconcile-reject", {
      revision: batch.revision,
      batchHash: batch.batchHash,
      confirm: true
    });
  const [action] = await value.service.actions(scope, batch.id);
  assert.ok(action);

  await assert.rejects(value.service.reconcileAction(
    scope,
    batch.id,
    action.id,
    {
      batchRevision: action.batchRevision,
      approvalHash: action.approvalHash,
      contentHash: action.contentHash,
      confirm: true
    }
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_action_reconciliation_unavailable");
  assert.equal(calls, 0);
});

test("final approval fails closed before persisting actions when outreach is disabled", async () => {
  const { value, batch } = await created(fixture({
    douyinOutreachActionsEnabled: false
  }));

  await assert.rejects(
    value.service.approve(
      scope,
      batch.id,
      batch.etag,
      "approve-disabled",
      { revision: 1, batchHash: batch.batchHash, confirm: true }
    ),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_actions_disabled"
      && error.status === 503
  );
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
});

test("creation rejects a candidate without an exact Douyin video comment target", async () => {
  const value = fixture({
    commentTargetPublicUrl: "https://www.douyin.com/user/actor-1"
  });

  await assert.rejects(
    value.service.create(scope, "run-1", "create-invalid-target", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_comment_target_invalid"
  );
});

test("outreach target validation accepts only byte-canonical public Douyin URLs", () => {
  assert.equal(
    validOutreachTarget(
      "comment",
      "https://www.douyin.com/video/AbC_123-xyz"
    ),
    true
  );
  assert.equal(
    validOutreachTarget(
      "direct_message",
      "https://www.douyin.com/user/MS4wLjAB_creator-1"
    ),
    true
  );
  for (const [kind, target] of [
    ["comment", "https://user@www.douyin.com/video/123"],
    ["comment", "https://www.douyin.com:443/video/123"],
    ["comment", "https://WWW.douyin.com/video/123"],
    ["comment", "https://www.douyin.com/video/123?share=1"],
    ["comment", "https://www.douyin.com/video/123#comment"],
    ["comment", "https://www.douyin.com/video/123/"],
    ["direct_message", "https://www.douyin.com/user/actor?from=video"],
    ["direct_message", "https://www.douyin.com/%75ser/actor"],
    ["direct_message", "https://www.douyin.com/user/actor/"],
    ["direct_message", "https://www.douyin.com/video/123"]
  ] as const) {
    assert.equal(
      validOutreachTarget(kind, target),
      false,
      `${kind} must reject non-canonical target ${target}`
    );
  }
});

test("creation rejects a candidate without an exact Douyin profile message target", async () => {
  const value = fixture({
    publicProfileUrl: "https://www.douyin.com/video/video-1"
  });

  await assert.rejects(
    value.service.create(scope, "run-1", "create-invalid-profile", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_direct_message_target_invalid"
  );
});

test("approval rechecks the exact Douyin video comment target before queuing actions", async () => {
  const { value, batch } = await created();
  value.setCommentTargetPublicUrl("https://www.douyin.com/user/actor-1");

  await assert.rejects(
    value.service.approve(scope, batch.id, batch.etag, "approve-invalid-target", {
      revision: 1, batchHash: batch.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_comment_target_invalid"
  );
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
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
