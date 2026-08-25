import { strict as assert } from "node:assert";
import { createOutreachBatchController } from "./outreach-batch-controller";

let revision = 1;
const batch = () => ({ id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision, etag: `\"batch:${revision}\"`, state: "awaiting_approval" as const, candidates: [{ candidateId: "candidate-1", selected: true, candidateRevision: 1, evidenceHashes: ["hash"], draftRevision: revision, comment: "您好，看到您在了解获客方案。", commentHash: "hash", directMessage: "您好，可以为您提供一份方案参考。", directMessageHash: "hash", rationaleCodes: ["evidence_grounded" as const], modelSnapshotId: "model-1", sourceModelSnapshotId: "model-1", contentHash: "hash" }], batchHash: `hash-${revision}`, approvedBy: null, approvedAt: null, approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null, createdBy: "user-1", createdAt: new Date().toISOString(), updatedBy: "user-1", updatedAt: new Date().toISOString() });
const controller = createOutreachBatchController({ api: {
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
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-controller" }));
