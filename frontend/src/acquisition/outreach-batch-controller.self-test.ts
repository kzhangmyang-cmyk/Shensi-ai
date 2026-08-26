import { strict as assert } from "node:assert";
import { AcquisitionHttpError } from "./douyin-automation-api";
import { createOutreachBatchController } from "./outreach-batch-controller";

let revision = 1;
const batch = () => ({ id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision, etag: `\"batch:${revision}\"`, state: "awaiting_approval" as const, candidates: [{ candidateId: "candidate-1", selected: true, candidateRevision: 1, evidenceHashes: ["hash"], draftRevision: revision, comment: "您好，看到您在了解获客方案。", commentHash: "hash", directMessage: "您好，可以为您提供一份方案参考。", directMessageHash: "hash", rationaleCodes: ["evidence_grounded" as const], modelSnapshotId: "model-1", sourceModelSnapshotId: "model-1", contentHash: "hash" }], batchHash: `hash-${revision}`, approvedBy: null, approvedAt: null, approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null, createdBy: "user-1", createdAt: new Date().toISOString(), updatedBy: "user-1", updatedAt: new Date().toISOString() });
const controller = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(), getBatch: async () => batch(),
  updateBatch: async () => { revision += 1; return batch(); },
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
}, pollDelayMs: 1 });
await controller.create("run-1", ["candidate-1"]);
controller.editMessage("candidate-1", "directMessage", "您好，这是人工修订后的精确私信。");
await controller.saveRevision();
assert.equal(controller.getState().batch?.revision, 2);
assert.equal(controller.getState().batch?.candidates[0]?.draftRevision, 2);
controller.close();

let releaseSave!: (value: ReturnType<typeof batch>) => void;
const pendingSave = new Promise<ReturnType<typeof batch>>((resolve) => {
  releaseSave = resolve;
});
let approvalCalls = 0;
const serialized = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => batch(),
  updateBatch: async () => pendingSave,
  approveBatch: async () => {
    approvalCalls += 1;
    return { ...batch(), state: "approved" as const };
  },
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await serialized.load("batch-1");
let editNotifications = 0;
const unsubscribeEdits = serialized.subscribe(() => { editNotifications += 1; });
const notificationsBeforeEdit = editNotifications;
serialized.editMessage("candidate-1", "comment", "页面上尚未保存的精确评论");
assert.equal(
  editNotifications,
  notificationsBeforeEdit,
  "native keystrokes must not trigger an innerHTML render subscription"
);
unsubscribeEdits();
await serialized.approve();
assert.equal(approvalCalls, 0, "an unsaved visible draft must never approve the old revision");
assert.match(serialized.getState().error ?? "", /先保存/u);

const save = serialized.saveRevision();
assert.equal(serialized.getState().phase, "saving");
await serialized.approve();
assert.equal(approvalCalls, 0, "approval must stay serialized behind a pending save");
releaseSave({
  ...batch(),
  revision: 3,
  etag: '"batch:3"',
  batchHash: "hash-3",
  candidates: batch().candidates.map((candidate) => ({
    ...candidate,
    draftRevision: 3,
    comment: "页面上尚未保存的精确评论"
  }))
});
await save;
assert.equal(serialized.getState().batch?.revision, 3);
serialized.close();

let awaitingPollCalls = 0;
const noDraftPoll = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => batch(),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => {
    awaitingPollCalls += 1;
    return { items: [] };
  }
} });
await noDraftPoll.load("batch-1");
assert.equal(
  awaitingPollCalls,
  0,
  "an awaiting-approval editor must not be replaced by an asynchronous poll emit"
);
noDraftPoll.close();

let adoptionApprovalCalls = 0;
const clearBeforeAdopt = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => batch(),
  updateBatch: async (_id, candidates) => ({
    ...batch(),
    revision: 4,
    etag: '"batch:4"',
    batchHash: "hash-4",
    candidates: batch().candidates.map((candidate) => ({
      ...candidate,
      comment: candidates[0]?.comment ?? candidate.comment
    }))
  }),
  approveBatch: async () => {
    adoptionApprovalCalls += 1;
    return { ...batch(), state: "approved" as const };
  },
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await clearBeforeAdopt.load("batch-1");
clearBeforeAdopt.editMessage("candidate-1", "comment", "adopt 后立即审批");
let triggered = false;
const unsubscribeAdopt = clearBeforeAdopt.subscribe((next) => {
  if (!triggered && next.phase === "ready" && next.batch?.revision === 4) {
    triggered = true;
    void clearBeforeAdopt.approve();
  }
});
await clearBeforeAdopt.saveRevision();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  adoptionApprovalCalls,
  1,
  "the ready notification must not race a still-set command lock"
);
unsubscribeAdopt();
clearBeforeAdopt.close();

let conflictApprovalCalls = 0;
const latestConflictBatch = {
  ...batch(),
  revision: 5,
  etag: '"batch:5"',
  batchHash: "hash-5",
  candidates: batch().candidates.map((candidate) => ({
    ...candidate,
    draftRevision: 5
  }))
};
const clearBeforeConflictAdopt = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => latestConflictBatch,
  getBatch: async () => latestConflictBatch,
  updateBatch: async () => {
    throw new AcquisitionHttpError(412, "precondition_failed", "stale");
  },
  approveBatch: async () => {
    conflictApprovalCalls += 1;
    return { ...latestConflictBatch, state: "approved" as const };
  },
  rejectBatch: async () => ({ ...latestConflictBatch, state: "rejected" as const }),
  pauseBatch: async () => ({ ...latestConflictBatch, state: "paused" as const }),
  resumeBatch: async () => ({ ...latestConflictBatch, state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await clearBeforeConflictAdopt.load("batch-1");
clearBeforeConflictAdopt.editMessage("candidate-1", "comment", "will conflict");
let conflictCommandStarted = false;
let conflictFollowupTriggered = false;
const unsubscribeConflictAdopt = clearBeforeConflictAdopt.subscribe((next) => {
  if (next.phase === "saving") conflictCommandStarted = true;
  if (conflictCommandStarted && !conflictFollowupTriggered
    && next.phase === "ready" && next.batch?.revision === 5) {
    conflictFollowupTriggered = true;
    void clearBeforeConflictAdopt.approve();
  }
});
await clearBeforeConflictAdopt.saveRevision();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  conflictApprovalCalls,
  1,
  "conflict adoption must clear the command lock before publishing ready"
);
unsubscribeConflictAdopt();
clearBeforeConflictAdopt.close();

const reconciliationAction = {
  id: "action-reconcile-1",
  workspaceId: "workspace-1",
  batchId: "batch-1",
  batchRevision: 2,
  candidateId: "candidate-1",
  accountId: "account-1",
  accountLoginStateVersion: 1,
  policyVersionId: "policy-1",
  localDate: "2026-08-25",
  kind: "comment" as const,
  sequence: 1 as const,
  status: "risk_paused" as const,
  predecessorActionId: null,
  targetPublicUrl: "https://www.douyin.com/video/video-1",
  content: "冻结评论",
  contentHash: `sha256:${"1".repeat(64)}`,
  approvalHash: `sha256:${"2".repeat(64)}`,
  createdAt: "2026-08-25T02:00:00.000Z",
  attemptCount: 1,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: "douyin_action_timeout" as const
};
let reconciliationCalls = 0;
const reconciliationController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => ({ ...batch(), state: "approved" as const }),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [reconciliationAction] }),
  reconcileAction: async (_batchId, authority) => {
    reconciliationCalls += 1;
    assert.deepEqual(authority, {
      id: reconciliationAction.id,
      batchRevision: reconciliationAction.batchRevision,
      approvalHash: reconciliationAction.approvalHash,
      contentHash: reconciliationAction.contentHash
    });
    return {
      ...reconciliationAction,
      status: "succeeded" as const,
      platformReceiptReference: "douyin-comment:receipt-1",
      occurredAt: "2026-08-25T02:05:00.000Z",
      failureCode: null
    };
  }
} });
await reconciliationController.load("batch-1");
await reconciliationController.refreshActions();
await reconciliationController.reconcileAction(reconciliationAction.id);
assert.equal(reconciliationCalls, 1);
assert.equal(reconciliationController.getState().actions[0]?.status, "succeeded");
assert.equal(reconciliationController.getState().phase, "ready");
reconciliationController.close();
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-controller" }));
