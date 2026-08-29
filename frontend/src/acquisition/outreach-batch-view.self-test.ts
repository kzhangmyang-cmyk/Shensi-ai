import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { createOutreachBatchController } from "./outreach-batch-controller";
import type { OutreachAction, OutreachBatch, OutreachBatchApi } from "./outreach-batch-api";
import type {
  OutreachBatchController,
  OutreachBatchState
} from "./outreach-batch-controller";
import {
  bindOutreachBatchActions,
  mountOutreachBatchView,
  renderOutreachBatchView
} from "./outreach-batch-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const directMessageApprovalState = (overrides: Partial<{
  directMessageDailyLimit: number;
  directMessageConfirmed: boolean;
  directMessageApprovalPhase: "idle" | "approving" | "pending";
  directMessagePendingCandidateIds: string[];
}> = {}) => ({
  directMessageDailyLimit: 20,
  directMessageConfirmed: false,
  directMessageApprovalPhase: "idle" as const,
  directMessagePendingCandidateIds: [] as string[],
  ...overrides
});
renderOutreachBatchView(host, {
  phase: "idle", batch: null, drafts: {}, actions: [], error: null,
  conflict: false, closed: false, ...directMessageApprovalState()
});
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
    publicProfileUrl: "https://www.douyin.com/user/actor-1",
    commentTargetPublicUrl: "https://www.douyin.com/video/video-1",
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

const { document: contextDocument } = parseHTML("<main id='context-mounted'></main>");
const contextMounted = contextDocument.querySelector<HTMLElement>("#context-mounted")!;
let contextSnapshot = {
  account: {
    id: "account-1",
    displayName: "测试账号",
    state: "active",
    loginStateVersion: 1
  },
  candidates: [{
    candidateId: "candidate-1",
    displayName: "候选人甲"
  }]
};
let notifyContext: () => void = () => undefined;
const unmountContext = mountOutreachBatchView(contextMounted, actionController, {
  context: () => contextSnapshot,
  subscribeContext(listener) {
    notifyContext = listener;
    return () => undefined;
  }
});
const contextTextarea = contextMounted.querySelector<HTMLTextAreaElement>(
  "[data-outreach-field=comment]"
)!;
notifyContext();
assert.equal(
  contextMounted.querySelector("[data-outreach-field=comment]") === contextTextarea,
  true,
  "an unchanged acquisition context must not rebuild an active editor"
);
contextSnapshot = {
  ...contextSnapshot,
  candidates: [{
    ...contextSnapshot.candidates[0]!,
    displayName: "候选人乙"
  }]
};
notifyContext();
assert.match(contextMounted.textContent ?? "", /候选人乙/u);
const contextTextareaAfterRelevantChange = contextMounted
  .querySelector<HTMLTextAreaElement>("[data-outreach-field=comment]")!;
contextSnapshot = {
  ...contextSnapshot,
  candidates: [
    ...contextSnapshot.candidates,
    { candidateId: "unrelated-candidate", displayName: "无关新候选人" }
  ]
};
notifyContext();
assert.equal(
  contextMounted.querySelector("[data-outreach-field=comment]")
    === contextTextareaAfterRelevantChange,
  true,
  "an unrelated acquisition candidate must not rebuild the approval editor"
);
unmountContext();

renderOutreachBatchView(host, {
  phase: "saving",
  batch: batch(),
  drafts: {
    "candidate-1": { comment: "原始精确评论", directMessage: "原始精确私信" }
  },
  actions: [],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
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

renderOutreachBatchView(host, {
  phase: "ready",
  batch: batch(),
  drafts: {
    "candidate-1": { comment: "原始精确评论", directMessage: "原始精确私信" }
  },
  actions: [],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
}, {
  account: {
    id: "account-1",
    displayName: "测试模拟账号",
    state: "active",
    loginStateVersion: 1
  },
  candidates: [{
    candidateId: "candidate-1",
    displayName: "袜子采购用户"
  }]
});
assert.match(host.textContent ?? "", /待人工审批/u);
assert.doesNotMatch(host.textContent ?? "", /awaiting_approval/u);
assert.match(host.textContent ?? "", /测试模拟账号/u);
assert.match(host.textContent ?? "", /account-1/u);
assert.match(host.textContent ?? "", /袜子采购用户/u);
assert.equal(
  host.querySelector<HTMLAnchorElement>("[data-outreach-target=candidate-1]")?.href,
  "https://www.douyin.com/video/video-1"
);
assert.equal(
  host.querySelector<HTMLAnchorElement>("[data-outreach-profile=candidate-1]")?.href,
  "https://www.douyin.com/user/actor-1"
);
assert.equal(
  host.querySelector<HTMLTextAreaElement>("[data-outreach-field=comment]")
    ?.getAttribute("maxlength"),
  "300"
);
assert.equal(
  host.querySelector<HTMLTextAreaElement>("[data-outreach-field=directMessage]")
    ?.disabled,
  true,
  "the retained direct-message draft must be read-only while sending is unavailable"
);
assert.match(host.textContent ?? "", /6 \/ 300/u);
assert.match(host.textContent ?? "", /确认后服务器只会排队执行本批次真实评论/u);
assert.match(host.textContent ?? "", /私信尚未解锁.*评论成功后可再独立复核并确认私信/u);
assert.doesNotMatch(host.textContent ?? "", /至少等待 180 秒后.*私信/u);
assert.match(host.textContent ?? "", /确认并排队真实评论/u);
assert.equal(
  host.querySelector<HTMLInputElement>("[data-outreach-confirm]")?.disabled,
  false
);

renderOutreachBatchView(host, {
  phase: "ready",
  batch: batch(),
  drafts: {},
  actions: [],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
}, {
  account: {
    id: "account-1",
    displayName: "   ",
    state: "active",
    loginStateVersion: 1
  }
});
assert.match(host.textContent ?? "", /没有可核对的真实账号名称/u);
assert.equal(
  host.querySelector<HTMLInputElement>("[data-outreach-confirm]")?.disabled,
  true,
  "an unnamed active account must not authorize a real comment"
);
assert.equal(
  host.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")?.disabled,
  true,
  "an unnamed active account must keep final approval disabled"
);

renderOutreachBatchView(host, {
  phase: "ready",
  batch: batch(),
  drafts: {},
  actions: [],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
}, {
  account: {
    id: "another-account",
    displayName: "错误账号",
    state: "active",
    loginStateVersion: 1
  }
});
assert.match(host.textContent ?? "", /当前连接账号与本批次不匹配/u);
assert.match(host.textContent ?? "", /暂不能最终确认/u);
assert.equal(
  host.querySelector<HTMLInputElement>("[data-outreach-confirm]")?.disabled,
  true
);

renderOutreachBatchView(host, {
  phase: "ready",
  batch: batch(),
  drafts: {
    "candidate-1": { comment: "尚未保存的评论", directMessage: "原始精确私信" }
  },
  actions: [],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
});
assert.match(host.textContent ?? "", /草稿尚未保存/u);
assert.equal(
  host.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")
    ?.disabled,
  true
);

const { document: actionDocument, window } = parseHTML("<main id='root'><div id='child'></div></main>");
const root = actionDocument.querySelector<HTMLElement>("#root")!;
const unbind = bindOutreachBatchActions(root, actionController);
root.innerHTML = `<div id="child"><textarea data-outreach-index="0" data-outreach-field="comment">人工修订评论</textarea></div>`;
const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(actionController.getState().drafts["candidate-1"]?.comment, "人工修订评论");

root.innerHTML = `<div id="child"><input type="checkbox" data-outreach-confirm data-outreach-review-ready="true"><button type="button" data-outreach-action="save">保存</button><button type="button" data-outreach-action="approve" disabled>审批</button></div>`;
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

root.innerHTML = `<div><textarea data-outreach-index="0" data-outreach-field="comment">再次修改</textarea><input type="checkbox" data-outreach-confirm data-outreach-review-ready="true" checked><button type="button" data-outreach-action="approve">审批</button></div>`;
const changedDraft = root.querySelector<HTMLTextAreaElement>("textarea")!;
const changedConfirmation = root.querySelector<HTMLInputElement>("[data-outreach-confirm]")!;
const changedApprove = root.querySelector<HTMLButtonElement>("[data-outreach-action=approve]")!;
changedDraft.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(changedConfirmation.checked, false);
assert.equal(changedApprove.disabled, true);

root.innerHTML = `<div><button type="button" data-outreach-action="save">保存</button><input type="checkbox" data-outreach-confirm data-outreach-review-ready="true"><button type="button" data-outreach-action="approve" disabled>审批</button></div>`;
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
  platformReceiptReference: null, occurredAt: "2026-08-27T00:01:00.000Z",
  failureCode: "douyin_action_receipt_ambiguous"
};
const reconciliationState = {
  phase: "ready" as const,
  batch: batch("approved"), drafts: {}, actions: [riskPausedAction],
  error: null, conflict: false, closed: false,
  ...directMessageApprovalState()
};
renderOutreachBatchView(host, {
  ...reconciliationState,
  error: "outreach_actions_disabled",
  actions: [{
    ...riskPausedAction,
    failureCode: "douyin_verification_required"
  }]
});
assert.match(host.textContent ?? "", /服务器尚未开启真实抖音评论/u);
assert.match(host.textContent ?? "", /需要在抖音窗口手动完成验证/u);
assert.equal(
  host.querySelector<HTMLAnchorElement>(".outreach-action-target")?.href,
  riskPausedAction.targetPublicUrl
);
assert.equal(
  host.querySelector(".outreach-technical code")?.textContent,
  "outreach_actions_disabled"
);
renderOutreachBatchView(host, {
  ...reconciliationState,
  batch: batch("awaiting_approval"),
  error: "outreach_candidate_projection_pending"
});
assert.match(host.textContent ?? "", /候选数据仍在采集.*当前不会排队真实评论或私信.*评论成功后可再独立确认私信/u);
assert.equal(
  host.querySelector(".outreach-technical code")?.textContent,
  "outreach_candidate_projection_pending"
);
renderOutreachBatchView(host, {
  ...reconciliationState,
  batch: batch("awaiting_approval"),
  error: "outreach_daily_limit_exhausted"
});
assert.match(
  host.textContent ?? "",
  /该候选人今天已进入过真实评论动作.*请选择另一位候选人/u
);
assert.equal(
  host.querySelector(".outreach-technical code")?.textContent,
  "outreach_daily_limit_exhausted"
);
renderOutreachBatchView(host, {
  ...reconciliationState,
  actions: [{ ...riskPausedAction, failureCode: "account_risk_paused" }]
});
assert.match(host.textContent ?? "", /发送账号已风险暂停，本动作未执行/u);
renderOutreachBatchView(host, {
  ...reconciliationState,
  actions: [{
    ...riskPausedAction,
    status: "failed",
    failureCode: "approval_authority_changed"
  }]
});
assert.match(host.textContent ?? "", /审批后的授权依据已变化，本动作未执行/u);
renderOutreachBatchView(host, reconciliationState);
const ambiguousReceiptAction = host.querySelector<HTMLElement>(".outreach-action");
assert.equal(
  ambiguousReceiptAction?.querySelector("strong")?.textContent,
  "公开评论 · 结果待确认"
);
assert.match(
  ambiguousReceiptAction?.querySelector("p")?.textContent ?? "",
  /评论可能已提交但未取得唯一回执；不会自动重发，可在抖音核对后只读核验/u
);
assert.match(host.textContent ?? "", /只读核验平台回执/u);
assert.match(host.textContent ?? "", /不会重新评论或私信/u);

const approvedBatch: OutreachBatch = {
  ...batch("approved"),
  approvedBy: "operator-1",
  approvedAt: "2026-08-27T00:01:00.000Z",
  approvalHash: `sha256:${"8".repeat(64)}`
};
const successfulCommentForDirectMessage: OutreachAction = {
  ...riskPausedAction,
  id: "action-comment-dm-unlock",
  batchRevision: approvedBatch.revision,
  status: "succeeded",
  content: approvedBatch.candidates[0]!.comment,
  contentHash: approvedBatch.candidates[0]!.commentHash,
  approvalHash: approvedBatch.approvalHash!,
  attemptCount: 1,
  platformReceiptReference: "douyin-comment:receipt-dm-unlock",
  occurredAt: "2026-08-27T00:02:00.000Z",
  failureCode: null
};
const directMessageReviewState = {
  phase: "ready" as const,
  batch: approvedBatch,
  drafts: {
    "candidate-1": {
      comment: approvedBatch.candidates[0]!.comment,
      directMessage: approvedBatch.candidates[0]!.directMessage
    }
  },
  actions: [successfulCommentForDirectMessage],
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
};
const boundAccountContext = {
  account: {
    id: "account-1",
    displayName: "真实复核账号",
    state: "active",
    loginStateVersion: 1
  },
  candidates: [{ candidateId: "candidate-1", displayName: "候选人甲" }]
};
renderOutreachBatchView(
  host,
  directMessageReviewState,
  boundAccountContext
);
const directMessageFieldset = host.querySelector<HTMLFieldSetElement>(
  "fieldset[data-outreach-direct-message-state=editable]"
);
assert.ok(directMessageFieldset,
  "a current successful comment receipt must unlock a semantic private-message fieldset");
assert.match(directMessageFieldset?.querySelector("legend")?.textContent ?? "", /真实私信复核/u);
assert.equal(
  directMessageFieldset?.querySelector<HTMLAnchorElement>(
    "[data-outreach-direct-message-target=candidate-1]"
  )?.href,
  approvedBatch.candidates[0]!.publicProfileUrl,
  "the second confirmation must show the exact frozen public profile target"
);
const unlockedDirectMessage = directMessageFieldset
  ?.querySelector<HTMLTextAreaElement>("[data-outreach-field=directMessage]");
assert.equal(unlockedDirectMessage?.disabled, false);
assert.equal(unlockedDirectMessage?.getAttribute("maxlength"), "800");
assert.match(directMessageFieldset?.textContent ?? "", /6 \/ 800/u);
const dailyLimit = host.querySelector<HTMLInputElement>(
  "[data-outreach-direct-message-limit]"
);
assert.equal(dailyLimit?.value, "20");
assert.equal(dailyLimit?.getAttribute("min"), "1");
assert.equal(dailyLimit?.getAttribute("max"), "100");
assert.ok(host.querySelector("fieldset[data-outreach-direct-message-approval] legend"));
assert.match(host.textContent ?? "", /确认并排队真实私信/u);
assert.match(host.textContent ?? "", /评论成功回执/u);
assert.equal(
  host.querySelector("[data-outreach-confirm]"),
  null,
  "the comment confirmation must not be reused after comment approval"
);

renderOutreachBatchView(host, {
  ...directMessageReviewState,
  actions: [{
    ...successfulCommentForDirectMessage,
    platformReceiptReference: null
  }]
}, boundAccountContext);
assert.ok(host.querySelector(
  "fieldset[data-outreach-direct-message-state=locked][disabled]"
));
assert.match(host.textContent ?? "", /等待本候选人的公开评论成功回执/u);

renderOutreachBatchView(host, {
  ...directMessageReviewState,
  drafts: {
    "candidate-1": {
      comment: approvedBatch.candidates[0]!.comment,
      directMessage: "已修订但尚未独立确认的私信"
    }
  },
  directMessageConfirmed: true
}, boundAccountContext);
assert.equal(
  host.querySelector("[data-outreach-direct-message-state=dirty]") !== null,
  true
);
assert.match(host.textContent ?? "", /私信草稿已修改/u);
assert.equal(
  host.querySelector<HTMLInputElement>("[data-outreach-direct-message-confirm]")
    ?.hasAttribute("checked"),
  true
);

for (const approvalPhase of ["approving", "pending"] as const) {
  renderOutreachBatchView(host, {
    ...directMessageReviewState,
    directMessageApprovalPhase: approvalPhase,
    directMessagePendingCandidateIds: ["candidate-1"]
  }, boundAccountContext);
  assert.match(
    host.textContent ?? "",
    approvalPhase === "approving" ? /正在提交私信授权/u : /等待服务器私信动作/u
  );
  assert.equal(
    host.querySelector<HTMLButtonElement>(
      "[data-outreach-action=approve-direct-messages]"
    )?.disabled,
    true
  );
}

const directMessageActionBase: OutreachAction = {
  ...successfulCommentForDirectMessage,
  id: "action-direct-message-v2",
  kind: "direct_message",
  sequence: 2,
  status: "queued",
  predecessorActionId: successfulCommentForDirectMessage.id,
  targetPublicUrl: approvedBatch.candidates[0]!.publicProfileUrl,
  content: approvedBatch.candidates[0]!.directMessage,
  contentHash: `sha256:${"a".repeat(64)}`,
  approvalHash: `sha256:${"b".repeat(64)}`,
  authorizationVersion: 2,
  approvedBy: "operator-1",
  approvedAt: "2026-08-27T00:03:00.000Z",
  directMessageDailyLimit: 20,
  directMessageDailyOrdinal: 1,
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
for (const [status, label] of [
  ["queued", "已排队"],
  ["executing", "执行中"],
  ["succeeded", "已送达"],
  ["failed", "执行失败"],
  ["risk_paused", "风险暂停"]
] as const) {
  const terminalFailure = status === "failed" || status === "risk_paused";
  renderOutreachBatchView(host, {
    ...directMessageReviewState,
    actions: [successfulCommentForDirectMessage, {
      ...directMessageActionBase,
      status,
      platformReceiptReference: status === "succeeded"
        ? "douyin-message:receipt-v2"
        : null,
      occurredAt: ["succeeded", "failed", "risk_paused"].includes(status)
        ? "2026-08-27T00:04:00.000Z"
        : null,
      failureCode: terminalFailure ? "action_rejected" : null
    }]
  }, boundAccountContext);
  assert.match(host.textContent ?? "", new RegExp(`真实私信.*${label}`, "u"));
  assert.equal(
    host.querySelector("[data-outreach-action=approve-direct-messages]"),
    null,
    "any existing private-message action must prevent reapproval"
  );
}

renderOutreachBatchView(host, {
  ...directMessageReviewState,
  drafts: {
    "candidate-1": {
      comment: approvedBatch.candidates[0]!.comment,
      directMessage: "已由私信动作冻结的人工修订文案"
    }
  },
  actions: [successfulCommentForDirectMessage, {
    ...directMessageActionBase,
    content: "已由私信动作冻结的人工修订文案"
  }]
}, boundAccountContext);
const queuedDirectMessageDirtyHint = host.querySelector<HTMLElement>(
  "[data-outreach-dirty=candidate-1]"
);
assert.equal(queuedDirectMessageDirtyHint?.hidden, true,
  "a queued private-message action must replace the local dirty hint with server state");
assert.match(
  host.querySelector(
    "[data-outreach-direct-message-state=queued] .outreach-direct-message-status"
  )?.textContent ?? "",
  /真实私信已排队/u,
  "queued private messages must display their server action state"
);

const secondViewCandidate = {
  ...approvedBatch.candidates[0]!,
  candidateId: "candidate-2",
  publicProfileUrl: "https://www.douyin.com/user/actor-2",
  commentTargetPublicUrl: "https://www.douyin.com/video/video-2",
  comment: "候选人二公开评论",
  commentHash: `sha256:${"c".repeat(64)}`,
  directMessage: "候选人二精确私信",
  directMessageHash: `sha256:${"d".repeat(64)}`,
  contentHash: `sha256:${"e".repeat(64)}`
};
const twoCandidateBatch: OutreachBatch = {
  ...approvedBatch,
  candidates: [approvedBatch.candidates[0]!, secondViewCandidate]
};
const successfulSecondViewComment: OutreachAction = {
  ...successfulCommentForDirectMessage,
  id: "action-comment-second-view",
  candidateId: "candidate-2",
  targetPublicUrl: secondViewCandidate.commentTargetPublicUrl,
  content: secondViewCandidate.comment,
  contentHash: secondViewCandidate.commentHash,
  platformReceiptReference: "douyin-comment:receipt-second-view"
};
renderOutreachBatchView(host, {
  ...directMessageReviewState,
  batch: twoCandidateBatch,
  drafts: {
    "candidate-1": {
      comment: approvedBatch.candidates[0]!.comment,
      directMessage: approvedBatch.candidates[0]!.directMessage
    },
    "candidate-2": {
      comment: secondViewCandidate.comment,
      directMessage: secondViewCandidate.directMessage
    }
  },
  actions: [successfulCommentForDirectMessage, directMessageActionBase,
    successfulSecondViewComment]
}, {
  ...boundAccountContext,
  candidates: [
    { candidateId: "candidate-1", displayName: "候选人甲" },
    { candidateId: "candidate-2", displayName: "候选人乙" }
  ]
});
assert.ok(host.querySelector(
  "[data-outreach-candidate-id=candidate-2][data-outreach-field=directMessage]:not([disabled])"
), "an existing DM must not lock another newly eligible candidate");
assert.ok(host.querySelector("[data-outreach-action=approve-direct-messages]"),
  "the remaining eligible candidate must retain its separate approval CTA");

const historicalDirectMessageAction: OutreachAction = {
  ...riskPausedAction,
  id: "action-history-dm-1",
  kind: "direct_message",
  sequence: 2,
  status: "blocked_by_predecessor",
  predecessorActionId: riskPausedAction.id,
  targetPublicUrl: "https://www.douyin.com/user/actor-1",
  content: "历史批次私信草稿",
  contentHash: `sha256:${"7".repeat(64)}`,
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
renderOutreachBatchView(host, {
  ...reconciliationState,
  actions: [historicalDirectMessageAction]
});
assert.match(host.textContent ?? "", /历史私信（只读） · 已停用/u);
assert.match(host.textContent ?? "", /服务器不会领取或发送这条私信/u);
assert.equal(
  host.querySelector<HTMLAnchorElement>(".outreach-action-target")?.href,
  historicalDirectMessageAction.targetPublicUrl,
  "historical direct-message actions remain readable"
);
assert.equal(
  host.querySelector("[data-outreach-action=approve-direct-messages]"),
  null,
  "a historical direct-message row remains readable but can never be reapproved"
);
renderOutreachBatchView(host, reconciliationState);
let viewReconciliationCalls = 0;
const viewController = {
  getState: () => reconciliationState,
  reconcileAction: async (actionId: string) => {
    assert.equal(actionId, riskPausedAction.id);
    viewReconciliationCalls += 1;
  }
} as unknown as OutreachBatchController;
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

const directMessageBindingInitialState: OutreachBatchState = {
  ...directMessageReviewState,
  batch: twoCandidateBatch,
  drafts: {
    "candidate-1": {
      comment: approvedBatch.candidates[0]!.comment,
      directMessage: approvedBatch.candidates[0]!.directMessage
    },
    "candidate-2": {
      comment: secondViewCandidate.comment,
      directMessage: secondViewCandidate.directMessage
    }
  },
  actions: [successfulCommentForDirectMessage, successfulSecondViewComment]
};
renderOutreachBatchView(host, directMessageBindingInitialState, {
  ...boundAccountContext,
  candidates: [
    { candidateId: "candidate-1", displayName: "候选人甲" },
    { candidateId: "candidate-2", displayName: "候选人乙" }
  ]
});
let editedDirectMessage = "";
let changedDirectMessageLimit = 20;
let changedDirectMessageConfirmation = false;
let directMessageApprovalClicks = 0;
let directMessageBindingState: OutreachBatchState = directMessageBindingInitialState;
const directMessageViewController = {
  getState: () => directMessageBindingState,
  editMessage: (candidateId: string, field: "comment" | "directMessage", value: string) => {
    if (field === "directMessage") {
      editedDirectMessage = value;
      directMessageBindingState = {
        ...directMessageBindingState,
        drafts: {
          ...directMessageBindingState.drafts,
          [candidateId]: {
            ...directMessageBindingState.drafts[candidateId]!,
            directMessage: value
          }
        },
        directMessageConfirmed: false
      };
    }
  },
  setDirectMessageDailyLimit: (value: number) => {
    changedDirectMessageLimit = value;
    directMessageBindingState = {
      ...directMessageBindingState,
      directMessageDailyLimit: value,
      directMessageConfirmed: false
    };
  },
  setDirectMessageConfirmed: (value: boolean) => {
    changedDirectMessageConfirmation = value;
    directMessageBindingState = {
      ...directMessageBindingState,
      directMessageConfirmed: value
    };
  },
  approveDirectMessages: async () => {
    directMessageApprovalClicks += 1;
  }
} as unknown as OutreachBatchController;
const unbindDirectMessage = bindOutreachBatchActions(
  host,
  directMessageViewController
);
const directMessageTextarea = host.querySelector<HTMLTextAreaElement>(
  "[data-outreach-candidate-id=candidate-1][data-outreach-field=directMessage]"
)!;
const editedDirectMessageCard = directMessageTextarea.closest<HTMLElement>(
  ".outreach-editor"
)!;
const editedDirectMessageFieldset = directMessageTextarea
  .closest<HTMLFieldSetElement>("[data-outreach-direct-message-state]")!;
const untouchedDirectMessageFieldset = host.querySelector<HTMLFieldSetElement>(
  "[data-outreach-candidate-id=candidate-2][data-outreach-field=directMessage]"
)!.closest<HTMLFieldSetElement>("[data-outreach-direct-message-state]")!;
const directMessageConfirmation = host.querySelector<HTMLInputElement>(
  "[data-outreach-direct-message-confirm]"
)!;
const directMessageApprovalButton = host.querySelector<HTMLButtonElement>(
  "[data-outreach-action=approve-direct-messages]"
)!;
directMessageConfirmation.checked = true;
directMessageConfirmation.dispatchEvent(new window.Event("change", {
  bubbles: true
}));
assert.equal(changedDirectMessageConfirmation, true);
assert.equal(directMessageApprovalButton.disabled, false);
directMessageTextarea.value = "编辑后必须清除二次确认";
directMessageTextarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(editedDirectMessage, "编辑后必须清除二次确认");
assert.equal(directMessageConfirmation.checked, false);
assert.equal(directMessageApprovalButton.disabled, true);
assert.equal(editedDirectMessageFieldset.classList.contains("is-dirty"), true,
  "the edited private-message card must immediately enter the dirty visual state");
assert.equal(editedDirectMessageFieldset.classList.contains("is-editable"), false);
assert.equal(editedDirectMessageFieldset.dataset.outreachDirectMessageState, "dirty");
assert.match(
  editedDirectMessageFieldset.querySelector(
    ".outreach-direct-message-status"
  )?.textContent ?? "",
  /本地私信草稿已修改.*重新核对.*独立确认/u
);
assert.match(editedDirectMessageCard.textContent ?? "", /无需保存为批次新修订/u);
assert.doesNotMatch(editedDirectMessageCard.textContent ?? "", /保存新修订后才能最终确认/u);
assert.equal(untouchedDirectMessageFieldset.classList.contains("is-editable"), true);
assert.equal(untouchedDirectMessageFieldset.classList.contains("is-dirty"), false,
  "editing one private-message draft must not mark another candidate dirty");
const overlongDirectMessage = "长".repeat(801);
directMessageTextarea.value = overlongDirectMessage;
directMessageTextarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(editedDirectMessage, overlongDirectMessage,
  "the controller must receive the exact over-limit text without truncation");
assert.equal(directMessageTextarea.value, overlongDirectMessage);
assert.equal(directMessageConfirmation.disabled, true,
  "an over-800 message must disable confirmation in the current DOM");
directMessageTextarea.value = "";
directMessageTextarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(editedDirectMessage, "");
assert.equal(directMessageConfirmation.disabled, true,
  "an empty message must not expose an enabled confirmation control");
directMessageTextarea.value = "恢复为有效精确私信";
directMessageTextarea.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(directMessageConfirmation.disabled, false);
const directMessageLimitInput = host.querySelector<HTMLInputElement>(
  "[data-outreach-direct-message-limit]"
)!;
directMessageLimitInput.value = "0";
directMessageLimitInput.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(changedDirectMessageLimit, 0);
assert.equal(directMessageConfirmation.checked, false);
assert.equal(directMessageConfirmation.disabled, true,
  "an invalid limit must disable confirmation rather than leave a no-op CTA");
directMessageLimitInput.value = "100";
directMessageLimitInput.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(changedDirectMessageLimit, 100);
assert.equal(directMessageConfirmation.disabled, false);
directMessageConfirmation.checked = true;
directMessageConfirmation.dispatchEvent(new window.Event("change", {
  bubbles: true
}));
directMessageApprovalButton.dispatchEvent(new window.Event("click", {
  bubbles: true
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(directMessageApprovalClicks, 1);
unbindDirectMessage();
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-view" }));
