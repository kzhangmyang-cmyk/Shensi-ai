import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { createOutreachBatchController } from "./outreach-batch-controller";
import type { OutreachAction, OutreachBatch, OutreachBatchApi } from "./outreach-batch-api";
import type { OutreachBatchController } from "./outreach-batch-controller";
import {
  bindOutreachBatchActions,
  mountOutreachBatchView,
  renderOutreachBatchView
} from "./outreach-batch-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
renderOutreachBatchView(host, { phase: "idle", batch: null, drafts: {}, actions: [], error: null, conflict: false, closed: false });
assert.match(host.textContent ?? "", /选择候选人后生成待审批批次/u);
assert.doesNotMatch(host.innerHTML, /accountHandle|cookie|leaseToken/iu);

let revision = 1;
const batch = (state: OutreachBatch["state"] = "awaiting_approval"): OutreachBatch => ({
  id: "batch-1",
  workspaceId: "workspace-1",
  runId: "run-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  planVersion: 1,
  planSnapshotHash: `sha256:${"0".repeat(64)}`,
  policyVersionId: "policy-version-1",
  policyHash: `sha256:${"1".repeat(64)}`,
  accountId: "account-1",
  accountLoginStateVersion: 1,
  dailyBudgetId: `sha256:${"2".repeat(64)}`,
  localDate: "2026-08-27",
  dailyCandidateLimit: 20,
  dailyRemainingLimit: 19,
  revision,
  etag: `"batch:${revision}"`,
  state,
  candidates: [{
    candidateId: "candidate-1",
    selected: true,
    candidateRevision: 1,
    evidenceHashes: [`sha256:${"3".repeat(64)}`],
    draftRevision: revision,
    comment: "原始精确评论",
    commentHash: `sha256:${"4".repeat(64)}`,
    directMessage: "原始精确私信",
    directMessageHash: `sha256:${"5".repeat(64)}`,
    rationaleCodes: ["evidence_grounded"],
    modelSnapshotId: "model-snapshot-1",
    sourceModelSnapshotId: "source-model-snapshot-1",
    contentHash: `sha256:${"6".repeat(64)}`
  }],
  batchHash: `sha256:${"7".repeat(64)}`,
  approvedBy: null,
  approvedAt: null,
  approvalHash: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  pauseReason: null,
  createdBy: "operator-1",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedBy: "operator-1",
  updatedAt: "2026-08-27T00:00:00.000Z"
});
const api: OutreachBatchApi = {
  async listBatches() { return { items: [], nextCursor: null }; },
  async createBatch() { return batch(); },
  async getBatch() { return batch(); },
  async updateBatch(_batchId, candidates) {
    revision += 1;
    return {
      ...batch(),
      candidates: batch().candidates.map((candidate) => ({
        ...candidate,
        comment: candidates[0]?.comment ?? candidate.comment,
        directMessage: candidates[0]?.directMessage ?? candidate.directMessage
      }))
    };
  },
  async approveBatch() { return batch("approved"); },
  async rejectBatch() { return batch("rejected"); },
  async pauseBatch() { return batch("paused"); },
  async resumeBatch() { return batch("approved"); },
  async listActions() { return { items: [] }; }
};
const actionController = createOutreachBatchController({ api, pollDelayMs: 1 });
await actionController.load("batch-1");

const { document: mountedDocument, window: mountedWindow } = parseHTML(
  "<main id='mounted'></main>"
);
const mounted = mountedDocument.querySelector<HTMLElement>("#mounted")!;
const unmount = mountOutreachBatchView(mounted, actionController);
const mountedTextarea = mounted.querySelector<HTMLTextAreaElement>(
  "[data-outreach-field=comment]"
)!;
mountedTextarea.value = "连续输入不会重建编辑器";
mountedTextarea.dispatchEvent(new mountedWindow.Event("input", { bubbles: true }));
assert.equal(
  mounted.querySelector("[data-outreach-field=comment]"),
  mountedTextarea,
  "native input must preserve the same textarea node for focus and IME composition"
);
unmount();

renderOutreachBatchView(host, {
  phase: "saving",
  batch: batch(),
  drafts: {
    "candidate-1": { comment: "原始精确评论", directMessage: "原始精确私信" }
  },
  actions: [],
  error: null,
  conflict: false,
  closed: false
});
assert.equal(
  host.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
  true,
  "a pending command must disable editors"
);
assert.ok(
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .every((button) => button.disabled),
  "a pending command must disable all command buttons"
);

const { document: actionDocument, window } = parseHTML("<main id='root'><div id='child'></div></main>");
const root = actionDocument.querySelector<HTMLElement>("#root")!;
const unbind = bindOutreachBatchActions(root, actionController);
root.innerHTML = `<div id="child"><textarea data-outreach-index="0" data-outreach-field="comment">人工修订评论</textarea></div>`;
const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(actionController.getState().drafts["candidate-1"]?.comment, "人工修订评论");

root.innerHTML = `<div id="child"><input type="checkbox" data-outreach-confirm><button type="button" data-outreach-action="save">保存</button><button type="button" data-outreach-action="approve" disabled>审批</button></div>`;
const confirmation = root.querySelector<HTMLInputElement>("[data-outreach-confirm]")!;
const approve = root.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")!;
approve.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  actionController.getState().batch?.state,
  "awaiting_approval",
  "approval must be rejected until the user review checkbox is checked"
);

confirmation.checked = true;
confirmation.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.equal(
  approve.disabled,
  true,
  "confirmation must stay disabled while the visible draft is unsaved"
);

root.innerHTML = `<div><textarea data-outreach-index="0" data-outreach-field="comment">再次修改</textarea><input type="checkbox" data-outreach-confirm checked><button type="button" data-outreach-action="approve">审批</button></div>`;
const changedDraft = root.querySelector<HTMLTextAreaElement>("textarea")!;
const changedConfirmation = root.querySelector<HTMLInputElement>("[data-outreach-confirm]")!;
const changedApprove = root.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")!;
changedDraft.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(changedConfirmation.checked, false);
assert.equal(changedApprove.disabled, true);

root.innerHTML = `<div><button type="button" data-outreach-action="save">保存</button><input type="checkbox" data-outreach-confirm><button type="button" data-outreach-action="approve" disabled>审批</button></div>`;
root.querySelector<HTMLButtonElement>("[data-outreach-action=save]")!
  .dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(actionController.getState().batch?.revision, 2);
assert.equal(actionController.getState().batch?.candidates[0]?.comment, "再次修改");

const finalConfirmation = root.querySelector<HTMLInputElement>("[data-outreach-confirm]")!;
const finalApprove = root.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")!;
finalConfirmation.checked = true;
finalConfirmation.dispatchEvent(new window.Event("change", { bubbles: true }));
finalApprove.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(actionController.getState().batch?.state, "approved");

unbind();
actionController.close();

const riskPausedAction: OutreachAction = {
  id: "action-risk-1", workspaceId: "workspace-1", batchId: "batch-1",
  batchRevision: 2, candidateId: "candidate-1", accountId: "account-1",
  accountLoginStateVersion: 1, policyVersionId: "policy-version-1",
  localDate: "2026-08-27", kind: "comment", sequence: 1,
  status: "risk_paused", predecessorActionId: null,
  targetPublicUrl: "https://www.douyin.com/video/video-1",
  content: "冻结评论", contentHash: `sha256:${"8".repeat(64)}`,
  approvalHash: `sha256:${"9".repeat(64)}`,
  createdAt: "2026-08-27T00:00:00.000Z", attemptCount: 1,
  platformReceiptReference: null, occurredAt: null,
  failureCode: "douyin_action_receipt_ambiguous"
};
const reconciliationState = {
  phase: "ready" as const,
  batch: batch("approved"), drafts: {}, actions: [riskPausedAction],
  error: null, conflict: false, closed: false
};
renderOutreachBatchView(host, reconciliationState);
assert.match(host.textContent ?? "", /只读核验平台回执/u);
assert.match(host.textContent ?? "", /不会重新评论或私信/u);
let viewReconciliationCalls = 0;
const viewController = {
  getState: () => reconciliationState,
  reconcileAction: async (actionId: string) => {
    assert.equal(actionId, riskPausedAction.id);
    viewReconciliationCalls += 1;
  }
} as OutreachBatchController;
const unbindReconciliation = bindOutreachBatchActions(host, viewController);
const reconcileButton = host.querySelector<HTMLButtonElement>(
  "[data-outreach-action=reconcile]"
)!;
reconcileButton.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(viewReconciliationCalls, 0,
  "read-only reconciliation still requires an explicit page confirmation");
const reconcileConfirmation = host.querySelector<HTMLInputElement>(
  "[data-outreach-reconcile-confirm]"
)!;
reconcileConfirmation.checked = true;
reconcileConfirmation.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.equal(reconcileButton.disabled, false);
reconcileButton.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(viewReconciliationCalls, 1);
assert.equal(reconcileConfirmation.checked, false);
assert.equal(reconcileButton.disabled, true);
unbindReconciliation();
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-view" }));
