import { strict as assert } from "node:assert";
import { AcquisitionHttpError } from "./douyin-automation-api";
import { createOutreachBatchController } from "./outreach-batch-controller";
import type { OutreachActionList } from "./outreach-batch-api";

let revision = 1;
const batch = () => ({ id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision, etag: `\"batch:${revision}\"`, state: "awaiting_approval" as const, candidates: [{ candidateId: "candidate-1", selected: true, candidateRevision: 1, evidenceHashes: ["hash"], publicProfileUrl: "https://www.douyin.com/user/actor-1", commentTargetPublicUrl: "https://www.douyin.com/video/video-1", draftRevision: revision, comment: "您好，看到您在了解获客方案。", commentHash: "hash", directMessage: "您好，可以为您提供一份方案参考。", directMessageHash: "hash", rationaleCodes: ["evidence_grounded" as const], modelSnapshotId: "model-1", sourceModelSnapshotId: "model-1", contentHash: "hash" }], batchHash: `hash-${revision}`, approvedBy: null, approvedAt: null, approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null, createdBy: "user-1", createdAt: new Date().toISOString(), updatedBy: "user-1", updatedAt: new Date().toISOString() });
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
assert.equal(controller.getState().directMessageDailyLimit, 50,
  "a new private-message review must start with the requested daily default of 50");
controller.setDirectMessageDailyLimit(20);
await controller.create("run-1", ["candidate-1"]);
assert.equal(controller.getState().directMessageDailyLimit, 50,
  "creating another batch must reset the edited private-message allowance to 50");
controller.editMessage("candidate-1", "directMessage", "您好，这是人工修订后的精确私信。");
await controller.saveRevision();
assert.equal(controller.getState().batch?.revision, 2);
assert.equal(controller.getState().batch?.candidates[0]?.draftRevision, 2);
controller.setDirectMessageDailyLimit(20);
await controller.load("batch-1");
assert.equal(controller.getState().directMessageDailyLimit, 50,
  "loading a batch starts a fresh review at 50 without carrying over an edited allowance");
controller.close();

{
  const stable = createOutreachBatchController({ api: {
    listBatches: async () => ({ items: [], nextCursor: null }),
    createBatch: async () => batch(),
    getBatch: async () => ({ ...batch(), state: "approved" as const }),
    updateBatch: async () => batch(),
    approveBatch: async () => ({ ...batch(), state: "approved" as const }),
    rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
    pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
    resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
    listActions: async () => ({ items: [] })
  }, pollDelayMs: 60_000 });
  await stable.load("batch-1");
  let renders = 0;
  const unsubscribe = stable.subscribe(() => { renders++; });
  const before = renders;
  await stable.refreshActions();
  assert.equal(renders, before,
    "unchanged receipt polling must not rebuild the page or clear native confirmation controls");
  unsubscribe();
  stable.close();
}

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
const awaitingTimers: Array<() => void> = [];
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
}, setTimer(callback) { awaitingTimers.push(callback); return 1 as unknown as ReturnType<typeof setTimeout>; }, clearTimer() {} });
await noDraftPoll.load("batch-1");
assert.equal(
  awaitingPollCalls,
  1,
  "an awaiting-comment batch must read its independently approved DM receipts on load"
);
assert.equal(awaitingTimers.length, 0,
  "an empty awaiting batch must not keep polling and disturb the editor");
noDraftPoll.close();

let projectionReloads = 0;
const projectionGate = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => {
    projectionReloads += 1;
    return batch();
  },
  updateBatch: async () => batch(),
  approveBatch: async () => {
    throw new AcquisitionHttpError(
      409,
      "outreach_candidate_projection_pending",
      "raw backend text must not replace the explicit waiting state"
    );
  },
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await projectionGate.load("batch-1");
assert.equal(projectionReloads, 1);
await projectionGate.approve();
assert.equal(projectionGate.getState().phase, "ready");
assert.equal(projectionGate.getState().batch?.state, "awaiting_approval");
assert.match(projectionGate.getState().error ?? "", /仍在采集.*当前不会排队真实评论或私信.*私信可.*单独确认/u);
assert.equal(
  projectionReloads,
  1,
  "a projection wait is not an ETag conflict and must not replace the reviewed batch"
);
assert.deepEqual(projectionGate.getState().actions, []);
projectionGate.close();

let dailyLimitBatchReads = 0;
const dailyLimitGate = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => {
    dailyLimitBatchReads += 1;
    return batch();
  },
  updateBatch: async () => batch(),
  approveBatch: async () => {
    throw new AcquisitionHttpError(
      409,
      "outreach_daily_limit_exhausted",
      "outreach_daily_limit_exhausted"
    );
  },
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await dailyLimitGate.load("batch-1");
await dailyLimitGate.approve();
assert.equal(
  dailyLimitBatchReads,
  1,
  "a daily candidate limit rejection is not a revision conflict"
);
assert.equal(dailyLimitGate.getState().conflict, false);
assert.equal(
  dailyLimitGate.getState().error,
  "outreach_daily_limit_exhausted"
);
assert.equal(dailyLimitGate.getState().batch?.state, "awaiting_approval");
dailyLimitGate.close();

const projectionUnavailable = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => {
    throw new AcquisitionHttpError(
      409,
      "outreach_candidate_projection_unavailable",
      "raw unavailable"
    );
  },
  getBatch: async () => batch(),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [] })
} });
await projectionUnavailable.create("run-1", ["candidate-1"]);
assert.equal(projectionUnavailable.getState().phase, "error");
assert.equal(projectionUnavailable.getState().batch, null);
assert.match(projectionUnavailable.getState().error ?? "", /重新运行采集/u);
projectionUnavailable.close();

const pollingAction = {
  id: "action-poll-1",
  workspaceId: "workspace-1",
  batchId: "batch-1",
  batchRevision: 1,
  candidateId: "candidate-1",
  accountId: "account-1",
  accountLoginStateVersion: 1,
  policyVersionId: "policy-1",
  localDate: "2026-08-25",
  kind: "comment" as const,
  sequence: 1 as const,
  status: "queued" as const,
  predecessorActionId: null,
  targetPublicUrl: "https://www.douyin.com/video/video-1",
  content: "冻结评论",
  contentHash: `sha256:${"1".repeat(64)}`,
  approvalHash: `sha256:${"2".repeat(64)}`,
  createdAt: "2026-08-25T02:00:00.000Z",
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
for (const initialStatus of ["failed", "queued"] as const) {
  const callbacks: Array<() => void> = [];
  const restoredDm = { ...pollingAction, kind: "direct_message" as const,
    authorizationVersion: 3 as const, status: initialStatus,
    targetPublicUrl: "https://www.douyin.com/user/actor-1",
    failureCode: initialStatus === "failed" ? "douyin_direct_message_unavailable" as const : null };
  let reads = 0;
  const forbiddenWrite = async (): Promise<never> => { throw new Error("load must not write"); };
  const restored = createOutreachBatchController({ api: {
    listBatches: async () => ({ items: [], nextCursor: null }),
    getBatch: async () => batch(),
    listActions: async () => {
      reads++;
      return { items: [{ ...restoredDm, status: reads === 1 ? initialStatus : "failed" as const }] };
    },
    createBatch: forbiddenWrite, updateBatch: forbiddenWrite,
    approveBatch: forbiddenWrite, rejectBatch: forbiddenWrite,
    pauseBatch: forbiddenWrite, resumeBatch: forbiddenWrite
  }, setTimer(callback) { callbacks.push(callback); return 1 as unknown as ReturnType<typeof setTimeout>; }, clearTimer() {} });
  await restored.load("batch-1");
  assert.equal(restored.getState().actions[0]?.status, initialStatus,
    "cold load must restore a v3 DM even when comments were never approved");
  assert.equal(restored.getState().directMessageConfirmed, false);
  assert.equal(callbacks.length, initialStatus === "queued" ? 1 : 0);
  if (initialStatus === "queued") {
    callbacks.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(restored.getState().actions[0]?.status, "failed");
    assert.equal(callbacks.length, 0, "terminal DM must stop follow-up polling");
  }
  restored.close();
}
let delayedActionPollCalls = 0;
const delayedPollCallbacks: Array<() => void> = [];
const delayedActionPoll = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => batch(),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => {
    delayedActionPollCalls += 1;
    if (delayedActionPollCalls <= 2) return { items: [] };
    if (delayedActionPollCalls === 3) return { items: [pollingAction] };
    return { items: [{
      ...pollingAction,
      status: "succeeded" as const,
      attemptCount: 1,
      platformReceiptReference: "douyin-comment:receipt-poll-1",
      occurredAt: "2026-08-25T02:01:00.000Z"
    }] };
  }
}, pollDelayMs: 1,
setTimer(callback) {
  delayedPollCallbacks.push(callback);
  return delayedPollCallbacks.length as unknown as ReturnType<typeof setTimeout>;
},
clearTimer() { /* controlled by this test */ }
});
await delayedActionPoll.load("batch-1");
assert.equal(delayedActionPollCalls, 1, "initial read sees no independently approved actions");
await delayedActionPoll.approve();
assert.equal(delayedActionPollCalls, 2);
assert.equal(delayedPollCallbacks.length, 1,
  "an empty action page must schedule another receipt poll");
delayedPollCallbacks.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(delayedActionPollCalls, 3);
assert.equal(delayedPollCallbacks.length, 1,
  "a queued action must keep receipt polling active");
delayedPollCallbacks.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(delayedActionPollCalls, 4,
  "an empty first action page after approval must not stop receipt polling");
assert.equal(delayedActionPoll.getState().actions[0]?.status, "succeeded");
delayedActionPoll.close();

let resolveOlderPoll!: (value: OutreachActionList) => void;
const olderPoll = new Promise<OutreachActionList>((resolve) => {
  resolveOlderPoll = resolve;
});
let reversedPollCalls = 0;
const reversedPollCallbacks: Array<() => void> = [];
const succeededPollingAction = {
  ...pollingAction,
  status: "succeeded" as const,
  attemptCount: 1,
  platformReceiptReference: "douyin-comment:receipt-latest",
  occurredAt: "2026-08-25T02:01:00.000Z"
};
const reversedPoll = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => ({ ...batch(), state: "approved" as const }),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => {
    reversedPollCalls += 1;
    return reversedPollCalls === 1
      ? olderPoll
      : { items: [succeededPollingAction] };
  }
}, setTimer(callback) {
  reversedPollCallbacks.push(callback);
  return reversedPollCallbacks.length as unknown as ReturnType<typeof setTimeout>;
}, clearTimer() { /* controlled by this test */ }
});
await reversedPoll.load("batch-1");
await reversedPoll.refreshActions();
assert.equal(reversedPoll.getState().actions[0]?.status, "succeeded");
resolveOlderPoll({ items: [pollingAction] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  reversedPoll.getState().actions[0]?.status,
  "succeeded",
  "an older poll response must not overwrite a newer terminal receipt"
);
assert.equal(
  reversedPollCallbacks.length,
  0,
  "an obsolete queued response must not start another polling chain"
);
reversedPoll.close();

let recoveringPollCalls = 0;
const recoveringPoll = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => ({ ...batch(), state: "approved" as const }),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => {
    recoveringPollCalls += 1;
    if (recoveringPollCalls === 1) throw new Error("temporary receipt read failure");
    return { items: [succeededPollingAction] };
  }
} });
await recoveringPoll.load("batch-1");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(recoveringPoll.getState().phase, "error");
assert.match(recoveringPoll.getState().error ?? "", /temporary receipt read failure/u);
await recoveringPoll.refreshActions();
assert.equal(
  recoveringPoll.getState().phase,
  "ready",
  "a successful manual receipt refresh must clear a prior polling error"
);
assert.equal(recoveringPoll.getState().error, null);
assert.equal(recoveringPoll.getState().actions[0]?.status, "succeeded");
recoveringPoll.close();

let automaticRecoveryCalls = 0;
const automaticRecoveryCallbacks: Array<() => void> = [];
const automaticRecoveryPoll = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => batch(),
  getBatch: async () => ({ ...batch(), state: "approved" as const }),
  updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }),
  resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => {
    automaticRecoveryCalls += 1;
    if (automaticRecoveryCalls === 1) throw new Error("transient tunnel failure");
    return { items: [succeededPollingAction] };
  }
}, pollDelayMs: 1, setTimer(callback) {
  automaticRecoveryCallbacks.push(callback);
  return automaticRecoveryCallbacks.length as unknown as ReturnType<typeof setTimeout>;
}, clearTimer() { /* controlled by this test */ }
});
await automaticRecoveryPoll.load("batch-1");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(automaticRecoveryPoll.getState().phase, "error");
assert.equal(automaticRecoveryCallbacks.length, 1);
automaticRecoveryCallbacks.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  automaticRecoveryPoll.getState().phase,
  "ready",
  "receipt polling must recover automatically from a transient read failure"
);
assert.equal(automaticRecoveryPoll.getState().error, null);
assert.equal(automaticRecoveryPoll.getState().actions[0]?.status, "succeeded");
assert.equal(automaticRecoveryCallbacks.length, 0);
automaticRecoveryPoll.close();

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

const desktopAuditAction = { ...reconciliationAction, executionTarget: "desktop" as const, status: "reconciliation_required" as const };
let desktopAuditRequests = 0;
const desktopAuditController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }), createBatch: async () => batch(),
  getBatch: async () => ({ ...batch(), state: "approved" as const }), updateBatch: async () => batch(),
  approveBatch: async () => ({ ...batch(), state: "approved" as const }),
  rejectBatch: async () => ({ ...batch(), state: "rejected" as const }),
  pauseBatch: async () => ({ ...batch(), state: "paused" as const }), resumeBatch: async () => ({ ...batch(), state: "approved" as const }),
  listActions: async () => ({ items: [desktopAuditAction] }),
  reconcileAction: async () => { desktopAuditRequests += 1; return desktopAuditAction; }
} });
await desktopAuditController.load("batch-1");
await desktopAuditController.refreshActions();
await desktopAuditController.reconcileAction(desktopAuditAction.id);
assert.equal(desktopAuditRequests, 1, "desktop uncertainty allows the existing explicit human audit request");
assert.equal(desktopAuditController.getState().actions[0]?.status, "reconciliation_required",
  "an audit-only response must never fabricate a successful platform receipt");
assert.equal(desktopAuditController.getState().phase, "ready");
assert.match(desktopAuditController.getState().recoveryNotice ?? "", /等待只读对账/u);
desktopAuditController.close();

const approvedDirectMessageBatch = {
  ...batch(),
  state: "approved" as const,
  approvedBy: "operator-1",
  approvedAt: "2026-08-25T02:00:00.000Z",
  approvalHash: `sha256:${"a".repeat(64)}`,
  candidates: [
    {
      ...batch().candidates[0]!,
      commentHash: `sha256:${"b".repeat(64)}`,
      directMessage: "候选人一私信"
    },
    {
      ...batch().candidates[0]!,
      candidateId: "candidate-2",
      publicProfileUrl: "https://www.douyin.com/user/actor-2",
      commentTargetPublicUrl: "https://www.douyin.com/video/video-2",
      comment: "候选人二公开评论",
      commentHash: `sha256:${"c".repeat(64)}`,
      directMessage: "候选人二私信",
      directMessageHash: `sha256:${"d".repeat(64)}`,
      contentHash: `sha256:${"e".repeat(64)}`
    }
  ]
};
const succeededComment = {
  ...pollingAction,
  id: "action-comment-succeeded",
  batchRevision: approvedDirectMessageBatch.revision,
  candidateId: "candidate-1",
  status: "succeeded" as const,
  content: approvedDirectMessageBatch.candidates[0]!.comment,
  contentHash: approvedDirectMessageBatch.candidates[0]!.commentHash,
  approvalHash: approvedDirectMessageBatch.approvalHash!,
  attemptCount: 1,
  platformReceiptReference: "douyin-comment:receipt-dm-unlock",
  occurredAt: "2026-08-25T02:01:00.000Z"
};
const queuedSecondComment = {
  ...pollingAction,
  id: "action-comment-queued",
  batchRevision: approvedDirectMessageBatch.revision,
  candidateId: "candidate-2",
  targetPublicUrl: "https://www.douyin.com/video/video-2",
  content: approvedDirectMessageBatch.candidates[1]!.comment,
  contentHash: approvedDirectMessageBatch.candidates[1]!.commentHash,
  approvalHash: approvedDirectMessageBatch.approvalHash!
};
const succeededSecondComment = {
  ...queuedSecondComment,
  id: "action-comment-second-succeeded",
  status: "succeeded" as const,
  attemptCount: 1,
  platformReceiptReference: "douyin-comment:receipt-second",
  occurredAt: "2026-08-25T02:02:00.000Z"
};

const independentDirectMessageCalls: Array<{
  accountLoginStateVersion: number;
  candidates: Array<{ candidateId: string; directMessage: string }>;
}> = [];
for (const [label, commentActions] of [
  ["no comment", []],
  ["queued comment", [queuedSecondComment]],
  ["failed comment", [{
    ...queuedSecondComment,
    status: "failed" as const,
    attemptCount: 1,
    occurredAt: "2026-08-25T02:03:00.000Z",
    failureCode: "action_rejected" as const
  }]],
  ["uncertain comment", [{
    ...queuedSecondComment,
    status: "reconciliation_required" as const,
    attemptCount: 1,
    occurredAt: "2026-08-25T02:03:00.000Z",
    failureCode: "douyin_action_receipt_ambiguous" as const
  }]]
] as const) {
  const controller = createOutreachBatchController({
    api: {
      listBatches: async () => ({ items: [], nextCursor: null }),
      createBatch: async () => approvedDirectMessageBatch,
      getBatch: async () => ({
        ...approvedDirectMessageBatch,
        state: "awaiting_approval" as const,
        approvedBy: null,
        approvedAt: null,
        approvalHash: null
      }),
      updateBatch: async () => approvedDirectMessageBatch,
      approveBatch: async () => approvedDirectMessageBatch,
      rejectBatch: async () => approvedDirectMessageBatch,
      pauseBatch: async () => approvedDirectMessageBatch,
      resumeBatch: async () => approvedDirectMessageBatch,
      listActions: async () => ({ items: [...commentActions] })
    },
    currentSender: () => ({
      accountId: "account-1",
      accountLoginStateVersion: 8
    })
  });
  await controller.load("batch-1");
  await controller.refreshActions();
  controller.setDirectMessageConfirmed(true);
  assert.equal(controller.getState().directMessageConfirmed, true,
    `${label} must not gate independent DM confirmation`);
  controller.close();
}
let independentSenderVersion = 8;
const independentDirectMessageController = createOutreachBatchController({
  api: {
    listBatches: async () => ({ items: [], nextCursor: null }),
    createBatch: async () => approvedDirectMessageBatch,
    getBatch: async () => ({
      ...approvedDirectMessageBatch,
      state: "awaiting_approval" as const,
      approvedBy: null,
      approvedAt: null,
      approvalHash: null,
      accountLoginStateVersion: 7
    }),
    updateBatch: async () => approvedDirectMessageBatch,
    approveBatch: async () => approvedDirectMessageBatch,
    approveDirectMessages: async (_batchId, body) => {
      independentDirectMessageCalls.push({
        accountLoginStateVersion: body.accountLoginStateVersion,
        candidates: body.candidates
      });
      return {
        ...approvedDirectMessageBatch,
        state: "awaiting_approval" as const,
        approvedBy: null,
        approvedAt: null,
        approvalHash: null,
        accountLoginStateVersion: 7
      };
    },
    rejectBatch: async () => approvedDirectMessageBatch,
    pauseBatch: async () => approvedDirectMessageBatch,
    resumeBatch: async () => approvedDirectMessageBatch,
    listActions: async () => ({ items: [queuedSecondComment] })
  },
  currentSender: () => ({
    accountId: "account-1",
    accountLoginStateVersion: independentSenderVersion
  }),
  pollDelayMs: 60_000
});
await independentDirectMessageController.load("batch-1");
await independentDirectMessageController.refreshActions();
independentDirectMessageController.setDirectMessageCandidateSelected(
  "candidate-2",
  false
);
independentDirectMessageController.editMessage(
  "candidate-1",
  "directMessage",
  "无需评论即可单独批准的私信"
);
independentDirectMessageController.setDirectMessageConfirmed(true);
assert.equal(independentDirectMessageController.getState().directMessageConfirmed,
  true, "an awaiting-comment batch with no successful comment may confirm DM independently");
independentSenderVersion = 9;
independentDirectMessageController.refreshDirectMessageSender();
assert.equal(independentDirectMessageController.getState().directMessageConfirmed,
  false, "a live sender login-version change must revoke consent");
independentDirectMessageController.setDirectMessageConfirmed(true);
await independentDirectMessageController.approveDirectMessages();
assert.deepEqual(independentDirectMessageCalls, [{
  accountLoginStateVersion: 9,
  candidates: [{
    candidateId: "candidate-1",
    directMessage: "无需评论即可单独批准的私信"
  }]
}], "independent DM approval must send only the exact selected recipients under the current sender");
assert.equal(independentDirectMessageController.getState().batch?.state,
  "awaiting_approval", "DM approval must not implicitly approve comments");
assert.equal(independentDirectMessageController.getState().directMessageApprovalPhase,
  "pending", "unchanged awaiting batch responses remain pending until v3 actions appear");
independentDirectMessageController.close();

const directMessageApprovalCalls: Array<{
  body: {
    batchRevision: number;
    batchHash: string;
    accountLoginStateVersion: number;
    dailyLimit: number;
    candidates: Array<{ candidateId: string; directMessage: string }>;
    confirm: true;
  };
  etag: string;
  key: string;
}> = [];
const directMessageController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, body, etag, key) => {
    directMessageApprovalCalls.push({ body, etag, key });
    return approvedDirectMessageBatch;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => ({ ...approvedDirectMessageBatch, state: "paused" as const }),
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({ items: [succeededComment, queuedSecondComment] })
}, pollDelayMs: 60_000 });
await directMessageController.load("batch-1");
await directMessageController.refreshActions();
assert.equal(directMessageController.getState().directMessageDailyLimit, 50,
  "private-message approval must default to a separate daily limit of 50");
directMessageController.setDirectMessageConfirmed(true);
directMessageController.editMessage(
  "candidate-1",
  "directMessage",
  "候选人一人工修订私信"
);
assert.equal(directMessageController.getState().directMessageConfirmed, false,
  "editing an unlocked private message must clear its separate confirmation");
const candidateTwoBefore = directMessageController.getState()
  .drafts["candidate-2"]?.directMessage;
directMessageController.editMessage(
  "candidate-2",
  "directMessage",
  "尚未成功评论的候选人不得编辑"
);
assert.equal(
  directMessageController.getState().drafts["candidate-2"]?.directMessage,
  "尚未成功评论的候选人不得编辑",
  "a queued comment must not lock the independent private-message editor"
);
assert.notEqual(candidateTwoBefore, "尚未成功评论的候选人不得编辑");
directMessageController.setDirectMessageCandidateSelected("candidate-2", false);
directMessageController.setDirectMessageConfirmed(true);
directMessageController.setDirectMessageDailyLimit(1);
assert.equal(directMessageController.getState().directMessageConfirmed, false,
  "changing the private-message limit must clear confirmation");
directMessageController.setDirectMessageConfirmed(true);
await directMessageController.approveDirectMessages();
assert.equal(directMessageApprovalCalls.length, 1);
assert.deepEqual(directMessageApprovalCalls[0]?.body, {
  batchRevision: approvedDirectMessageBatch.revision,
  batchHash: approvedDirectMessageBatch.batchHash,
  accountLoginStateVersion: approvedDirectMessageBatch.accountLoginStateVersion,
  dailyLimit: 1,
  candidates: [{
    candidateId: "candidate-1",
    directMessage: "候选人一人工修订私信"
  }],
  confirm: true
});
assert.equal(directMessageApprovalCalls[0]?.etag, approvedDirectMessageBatch.etag);
assert.equal(
  directMessageController.getState().directMessageApprovalPhase,
  "pending",
  "an unchanged approval response must remain fenced until actions are observed"
);
directMessageController.close();

let frozenIntentActions = [succeededComment, queuedSecondComment];
const frozenIntentCalls: Array<Array<{ candidateId: string }>> = [];
const frozenIntentController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, body) => {
    frozenIntentCalls.push(body.candidates);
    return approvedDirectMessageBatch;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({ items: frozenIntentActions })
}, pollDelayMs: 60_000 });
await frozenIntentController.load("batch-1");
await frozenIntentController.refreshActions();
frozenIntentController.setDirectMessageConfirmed(true);
assert.equal(frozenIntentController.getState().directMessageConfirmed, true);
const replacedFirstReceipt = {
  ...succeededComment,
  id: "action-comment-succeeded-reconciled",
  platformReceiptReference: "douyin-comment:receipt-reconciled"
};
frozenIntentActions = [replacedFirstReceipt, queuedSecondComment];
await frozenIntentController.refreshActions();
assert.equal(
  frozenIntentController.getState().directMessageConfirmed,
  true,
  "comment receipt changes must not invalidate independent DM confirmation"
);
await frozenIntentController.approveDirectMessages();
assert.equal(frozenIntentCalls.length, 1);
assert.equal(
  frozenIntentController.getState().directMessageConfirmed,
  false,
  "submitted DM approval clears its confirmation while awaiting server actions"
);
assert.deepEqual(frozenIntentCalls[0], [
  { candidateId: "candidate-1", directMessage: "候选人一私信" },
  { candidateId: "candidate-2", directMessage: "候选人二私信" }
]);
frozenIntentController.close();

const historicalFirstDirectMessage = {
  ...succeededComment,
  id: "action-direct-message-historical-first",
  kind: "direct_message" as const,
  sequence: 2 as const,
  status: "blocked_by_predecessor" as const,
  predecessorActionId: succeededComment.id,
  targetPublicUrl: approvedDirectMessageBatch.candidates[0]!.publicProfileUrl,
  content: approvedDirectMessageBatch.candidates[0]!.directMessage,
  contentHash: approvedDirectMessageBatch.candidates[0]!.directMessageHash,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
const remainingCandidateCalls: Array<Array<{ candidateId: string; directMessage: string }>> = [];
const remainingCandidateController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, body) => {
    remainingCandidateCalls.push(body.candidates);
    return approvedDirectMessageBatch;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({
    items: [succeededComment, historicalFirstDirectMessage,
      succeededSecondComment]
  })
} });
await remainingCandidateController.load("batch-1");
await remainingCandidateController.refreshActions();
remainingCandidateController.editMessage(
  "candidate-2",
  "directMessage",
  "候选人二后续独立批准私信"
);
remainingCandidateController.setDirectMessageConfirmed(true);
await remainingCandidateController.approveDirectMessages();
assert.deepEqual(remainingCandidateCalls, [[{
  candidateId: "candidate-2",
  directMessage: "候选人二后续独立批准私信"
}]], "an existing historical DM must exclude only its own candidate");
remainingCandidateController.close();

const conflictBatch = {
  ...approvedDirectMessageBatch,
  revision: approvedDirectMessageBatch.revision + 1,
  etag: '"batch:dm-conflict-reloaded"',
  batchHash: `sha256:${"1".repeat(64)}`,
  approvalHash: `sha256:${"2".repeat(64)}`,
  candidates: approvedDirectMessageBatch.candidates.map((candidate, index) => ({
    ...candidate,
    draftRevision: approvedDirectMessageBatch.revision + 1,
    commentHash: `sha256:${String(index + 3).repeat(64)}`
  }))
};
const conflictCurrentAction = {
  ...succeededComment,
  id: "action-comment-current-after-conflict",
  batchRevision: conflictBatch.revision,
  content: conflictBatch.candidates[0]!.comment,
  contentHash: conflictBatch.candidates[0]!.commentHash,
  approvalHash: conflictBatch.approvalHash!,
  platformReceiptReference: "douyin-comment:receipt-current-authority"
};
let conflictBatchReads = 0;
const directMessageConflictController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => {
    conflictBatchReads += 1;
    return conflictBatchReads === 1
      ? approvedDirectMessageBatch
      : conflictBatch;
  },
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async () => {
    throw new AcquisitionHttpError(412, "precondition_failed", "stale DM authority");
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({
    items: conflictBatchReads > 1
      ? [conflictCurrentAction]
      : [succeededComment]
  })
} });
await directMessageConflictController.load("batch-1");
await directMessageConflictController.refreshActions();
directMessageConflictController.setDirectMessageConfirmed(true);
await directMessageConflictController.approveDirectMessages();
assert.equal(conflictBatchReads, 2,
  "DM 409/412 must reload the current batch authority");
assert.equal(directMessageConflictController.getState().batch?.revision,
  conflictBatch.revision);
assert.equal(directMessageConflictController.getState().actions[0]?.id,
  conflictCurrentAction.id,
  "DM conflict reload must also refresh current server actions");
assert.equal(directMessageConflictController.getState().conflict, true);
assert.equal(
  directMessageConflictController.getState().error,
  null,
  "one real revision conflict must render one conflict notice"
);
assert.equal(directMessageConflictController.getState().directMessageConfirmed,
  false);
directMessageConflictController.close();

const boundaryCalls: number[] = [];
const boundaryController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, body) => {
    boundaryCalls.push(body.dailyLimit);
    return approvedDirectMessageBatch;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({ items: [succeededComment] })
} });
await boundaryController.load("batch-1");
await boundaryController.refreshActions();
for (const invalidLimit of [0, 101, 1.5]) {
  boundaryController.setDirectMessageDailyLimit(invalidLimit);
  boundaryController.setDirectMessageConfirmed(true);
  await boundaryController.approveDirectMessages();
}
assert.deepEqual(boundaryCalls, [], "limits outside the closed integer range 1..100 must not cross the API boundary");
boundaryController.setDirectMessageDailyLimit(100);
boundaryController.setDirectMessageConfirmed(true);
await boundaryController.approveDirectMessages();
assert.deepEqual(boundaryCalls, [100], "the inclusive upper private-message limit must be accepted");
boundaryController.close();

const retryKeys: string[] = [];
const retryController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, _body, _etag, key) => {
    retryKeys.push(key);
    throw new Error("temporary direct-message approval failure");
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({ items: [succeededComment] })
} });
await retryController.load("batch-1");
await retryController.refreshActions();
retryController.setDirectMessageConfirmed(true);
await retryController.approveDirectMessages();
retryController.setDirectMessageConfirmed(true);
await retryController.approveDirectMessages();
assert.equal(retryKeys[0], retryKeys[1],
  "an identical failed intent must reuse its idempotency key");
retryController.editMessage("candidate-1", "directMessage", "修订后的新意图");
retryController.setDirectMessageConfirmed(true);
await retryController.approveDirectMessages();
assert.notEqual(retryKeys[1], retryKeys[2],
  "changing an authorized message must create a new idempotency authority");
retryController.close();

let releaseDirectMessageApproval!: (value: typeof approvedDirectMessageBatch) => void;
const pendingDirectMessageApproval = new Promise<typeof approvedDirectMessageBatch>((resolve) => {
  releaseDirectMessageApproval = resolve;
});
let doubleClickCalls = 0;
let defaultApprovalDailyLimit: number | undefined;
const queuedDirectMessage = {
  ...succeededComment,
  id: "action-direct-message-v2",
  kind: "direct_message" as const,
  sequence: 2 as const,
  status: "queued" as const,
  predecessorActionId: succeededComment.id,
  targetPublicUrl: approvedDirectMessageBatch.candidates[0]!.publicProfileUrl,
  content: approvedDirectMessageBatch.candidates[0]!.directMessage,
  contentHash: `sha256:${"f".repeat(64)}`,
  approvalHash: `sha256:${"0".repeat(64)}`,
  authorizationVersion: 2 as const,
  approvedBy: "operator-1",
  approvedAt: "2026-08-25T02:02:00.000Z",
  directMessageDailyLimit: 20,
  directMessageDailyOrdinal: 1,
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null
};
const doubleClickController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async (_batchId, command) => {
    doubleClickCalls += 1;
    defaultApprovalDailyLimit = command.dailyLimit;
    return pendingDirectMessageApproval;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({
    items: doubleClickCalls > 0
      ? [succeededComment, queuedDirectMessage]
      : [succeededComment]
  })
} });
await doubleClickController.load("batch-1");
await doubleClickController.refreshActions();
doubleClickController.setDirectMessageCandidateSelected("candidate-2", false);
doubleClickController.setDirectMessageConfirmed(true);
const firstApproval = doubleClickController.approveDirectMessages();
const duplicateApproval = doubleClickController.approveDirectMessages();
assert.equal(doubleClickCalls, 1, "double click must submit one approval command");
assert.equal(defaultApprovalDailyLimit, 50,
  "a newly confirmed private-message approval must send the default 50 allowance to the server");
releaseDirectMessageApproval(approvedDirectMessageBatch);
await Promise.all([firstApproval, duplicateApproval]);
assert.equal(
  doubleClickController.getState().actions.find((action) =>
    action.kind === "direct_message")?.authorizationVersion,
  2,
  "the server action list, not the unchanged batch response, is final authority"
);
assert.equal(doubleClickController.getState().actions.find((action) =>
  action.kind === "direct_message")?.directMessageDailyLimit, 20,
  "a historical approved action must keep its frozen daily limit of 20 despite the new review default");
assert.equal(doubleClickController.getState().directMessageApprovalPhase, "idle");
doubleClickController.close();

let overConfiguredLimitCalls = 0;
const overConfiguredLimitController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => approvedDirectMessageBatch,
  getBatch: async () => approvedDirectMessageBatch,
  updateBatch: async () => approvedDirectMessageBatch,
  approveBatch: async () => approvedDirectMessageBatch,
  approveDirectMessages: async () => {
    overConfiguredLimitCalls += 1;
    return approvedDirectMessageBatch;
  },
  rejectBatch: async () => approvedDirectMessageBatch,
  pauseBatch: async () => approvedDirectMessageBatch,
  resumeBatch: async () => approvedDirectMessageBatch,
  listActions: async () => ({
    items: [succeededComment, succeededSecondComment]
  })
} });
await overConfiguredLimitController.load("batch-1");
await overConfiguredLimitController.refreshActions();
overConfiguredLimitController.setDirectMessageDailyLimit(1);
overConfiguredLimitController.setDirectMessageConfirmed(true);
assert.equal(
  overConfiguredLimitController.getState().directMessageConfirmed,
  false,
  "a visible candidate count over the configured limit must keep confirmation closed"
);
await overConfiguredLimitController.approveDirectMessages();
assert.equal(overConfiguredLimitCalls, 0,
  "an over-limit visible candidate set must not cross the approval API boundary");
overConfiguredLimitController.close();

const recoveryBatch = {
  ...batch(),
  state: "approved" as const,
  approvedBy: "operator-1",
  approvedAt: "2026-08-25T02:00:00.000Z",
  approvalHash: `sha256:${"a".repeat(64)}`
};
const recoveryAction = {
  ...pollingAction,
  batchRevision: recoveryBatch.revision,
  accountLoginStateVersion: recoveryBatch.accountLoginStateVersion,
  approvalHash: recoveryBatch.approvalHash!,
  status: "queued" as const
};
const pausedExecutionGate = {
  accountId: recoveryBatch.accountId,
  accountLoginStateVersion: recoveryBatch.accountLoginStateVersion,
  riskPaused: true,
  pendingActionIds: [recoveryAction.id],
  unresolvedActions: [{
    actionId: "action-uncertain-history",
    failureCode: "douyin_action_receipt_ambiguous" as const
  }]
};
const recoveredExecutionGate = {
  ...pausedExecutionGate,
  riskPaused: false
};
const recoveryTimers: Array<() => void> = [];
const recoveryCommands: Array<{
  batchId: string;
  input: {
    batchRevision: number;
    accountLoginStateVersion: number;
    pendingActionIds: string[];
    acknowledgedUncertainActionIds: string[];
    reason: string;
    confirm: true;
  };
  etag: string;
}> = [];
let recoveryActionReads = 0;
const recoveryController = createOutreachBatchController({ api: {
  listBatches: async () => ({ items: [], nextCursor: null }),
  createBatch: async () => recoveryBatch,
  getBatch: async () => recoveryBatch,
  updateBatch: async () => recoveryBatch,
  approveBatch: async () => recoveryBatch,
  rejectBatch: async () => recoveryBatch,
  pauseBatch: async () => recoveryBatch,
  resumeBatch: async () => recoveryBatch,
  listActions: async () => {
    recoveryActionReads += 1;
    return {
      items: [recoveryAction],
      executionGate: recoveryActionReads === 1
        ? pausedExecutionGate
        : recoveredExecutionGate
    };
  },
  recoverAccountActions: async (batchId, input, etag) => {
    recoveryCommands.push({ batchId, input, etag });
    return {
      ...recoveredExecutionGate,
      enabledActionIds: [recoveryAction.id],
      acknowledgedUncertainActionIds: ["action-uncertain-history"],
      recoveredBy: "operator-1",
      recoveredAt: "2026-08-25T02:04:00.000Z"
    };
  }
}, setTimer(callback) {
  recoveryTimers.push(callback);
  return recoveryTimers.length as unknown as ReturnType<typeof setTimeout>;
}, clearTimer() { /* controlled by this test */ } });
await recoveryController.load(recoveryBatch.id);
assert.equal(recoveryController.getState().executionGate?.riskPaused, true);
assert.equal(recoveryTimers.length, 0,
  "a risk-paused account gate must not keep polling an inert queued action");
await recoveryController.recoverAccountActions();
assert.equal(recoveryCommands.length, 0,
  "account recovery must require an explicit second confirmation");
recoveryController.setRecoveryConfirmed(true);
const firstRecovery = recoveryController.recoverAccountActions();
const duplicateRecovery = recoveryController.recoverAccountActions();
await Promise.all([firstRecovery, duplicateRecovery]);
assert.equal(recoveryCommands.length, 1,
  "a double click must submit one account recovery command");
assert.deepEqual(recoveryCommands[0], {
  batchId: recoveryBatch.id,
  input: {
    batchRevision: recoveryBatch.revision,
    accountLoginStateVersion: recoveryBatch.accountLoginStateVersion,
    pendingActionIds: [recoveryAction.id],
    acknowledgedUncertainActionIds: ["action-uncertain-history"],
    reason: "人工已核对账号与历史回执，仅恢复当前批次安全评论",
    confirm: true
  },
  etag: recoveryBatch.etag
});
assert.equal(recoveryController.getState().executionGate?.riskPaused, false);
assert.equal(recoveryController.getState().recoveryConfirmed, false);
assert.match(recoveryController.getState().recoveryNotice ?? "", /已恢复 1 条公开评论/u);
assert.equal(recoveryActionReads, 2,
  "successful recovery must immediately refresh actions and resume polling");
recoveryController.close();
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-controller" }));
