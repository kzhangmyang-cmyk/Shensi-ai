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
const stableTimelineState: OutreachBatchState = {
  phase: "idle", batch: null, drafts: {}, actions: [], error: null, conflict: false, closed: false,
  directMessageDailyLimit: 20, directMessageConfirmed: false, directMessageApprovalPhase: "idle", directMessagePendingCandidateIds: []
};
renderOutreachBatchView(host, stableTimelineState);
const stableTimeline = host.firstElementChild;
renderOutreachBatchView(host, { ...stableTimelineState, error: "desktop_offline" });
assert.equal(host.firstElementChild === stableTimeline, true, "action status refresh must not replace the entire batch host");
renderOutreachBatchView(host, stableTimelineState, { desktopStatus: {
  state: "offline", diagnostic: "central_unreachable", currentActionKind: null,
  updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown"
} });
assert.match(host.textContent ?? "", /中心服务离线，未领取新动作/u,
  "shared acquisition/conversation batch surface must show sanitized Main status");
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
for (const limits of [
  { count: 50, dailyCandidateLimit: 50, dailyRemainingLimit: 50 },
  { count: 5, dailyCandidateLimit: 5, dailyRemainingLimit: 3 }
]) {
  const commentBatch: OutreachBatch = {
    ...batch(),
    dailyCandidateLimit: limits.dailyCandidateLimit,
    dailyRemainingLimit: limits.dailyRemainingLimit,
    candidates: Array.from({ length: limits.count }, (_, index) => ({
      ...batch().candidates[0]!, candidateId: `candidate-${index + 1}`
    }))
  };
  renderOutreachBatchView(host, {
    ...stableTimelineState, phase: "ready", batch: commentBatch
  }, { surface: "comments" });
  assert.equal(host.querySelectorAll(".outreach-editor [data-outreach-field=comment]").length,
    limits.count, "comment review must render every persisted candidate, including all 50 in a new batch");
  assert.ok(host.querySelector(`[data-outreach-candidate-id="candidate-${limits.count}"][data-outreach-field=comment]`));
  const summary = host.querySelector(".outreach-summary")!;
  assert.equal(summary.querySelectorAll("strong")[2]?.textContent,
    `${limits.dailyRemainingLimit} / ${limits.dailyCandidateLimit}`,
    "comment review must keep the server batch allowance, including a historical 3 / 5, instead of applying new defaults");
  assert.match(summary.textContent ?? "", /本批次剩余\s*\/\s*上限/u);
  assert.match(host.textContent ?? "", /本批次上限沿用创建时的采集运行/u);
}
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

const passivePollErrorState: OutreachBatchState = {
  phase: "error",
  batch: batch(),
  drafts: {
    "candidate-1": { comment: "原始精确评论", directMessage: "原始精确私信" }
  },
  actions: [],
  error: "动作状态暂时不可用",
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
};
let passivePollListener: ((state: OutreachBatchState) => void) | null = null;
const passivePollController = {
  getState: () => passivePollErrorState,
  subscribe(listener: (state: OutreachBatchState) => void) {
    passivePollListener = listener;
    return () => undefined;
  }
} as unknown as OutreachBatchController;
const passiveHtmlElementPrototype = document.defaultView!.HTMLElement.prototype;
const originalPassiveFocus = passiveHtmlElementPrototype.focus;
let passiveAlertFocusCalls = 0;
passiveHtmlElementPrototype.focus = function focus(options?: FocusOptions) {
  if (this.matches("[role=alert]")) passiveAlertFocusCalls += 1;
  originalPassiveFocus.call(this, options);
};
let unmountPassivePoll: (() => void) | null = null;
try {
  unmountPassivePoll = mountOutreachBatchView(
    host,
    passivePollController
  );
  const emitPassivePoll = passivePollListener as unknown as (
    state: OutreachBatchState
  ) => void;
  assert.ok(emitPassivePoll);
  emitPassivePoll(passivePollErrorState);
  assert.equal(passiveAlertFocusCalls, 0,
    "a passive action poll must not focus an alert and move the user's scroll position");
} finally {
  unmountPassivePoll?.();
  passiveHtmlElementPrototype.focus = originalPassiveFocus;
}

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
assert.equal(host.querySelector("[data-outreach-field=directMessage]"), null,
  "the comment surface must not render the former combined private-message step");
assert.match(host.textContent ?? "", /6 \/ 300/u);
assert.match(host.textContent ?? "", /确认后服务器只会排队执行本批次真实评论/u);
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
for (const [status, copy] of [["queued", "等待桌面应用领取"], ["claimed", "桌面应用已领取"], ["executing", "正在通过本机抖音执行"], ["reconciliation_required", "等待只读对账，绝不会自动重发"], ["succeeded", "平台回执已确认"]] as const) {
  renderOutreachBatchView(host, { ...reconciliationState, actions: [{ ...riskPausedAction, executionTarget: "desktop", status, failureCode: null }] });
  assert.ok(host.textContent?.includes(copy), `desktop ${status} should expose its persisted action phase`);
}
renderOutreachBatchView(host, {
  ...reconciliationState,
  actions: [{ ...riskPausedAction, kind: "direct_message", status: "failed", authorizationVersion: 3,
    executionTarget: "desktop", failureCode: "douyin_direct_message_unavailable",
    targetPublicUrl: "https://www.douyin.com/user/actor-1" }]
}, {
  surface: "direct_messages",
  desktopStatus: { state: "idle", diagnostic: null, currentActionKind: null,
    updatedAt: null, pendingReconciliationCount: 0, ownership: "this_device" }
});
assert.match(host.textContent ?? "", /私信发送失败/u);
assert.match(host.textContent ?? "", /执行器已就绪/u);
assert.doesNotMatch(host.textContent ?? "", /等待桌面应用领取|当前目标暂不支持私信/u,
  "a terminal DM and idle executor must not imply queueing or blame the recipient without platform evidence");
assert.match(host.textContent ?? "", /私信执行未完成，未确认具体原因/u);
assert.match(host.textContent ?? "", /douyin_direct_message_unavailable/u,
  "the stored failure code remains available without rewriting the receipt");
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
assert.match(host.textContent ?? "", /候选数据仍在采集.*当前不会排队真实评论或私信.*私信可.*单独确认/u);
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
  surface: "direct_messages" as const,
  account: {
    id: "account-1",
    displayName: "真实复核账号",
    state: "active",
    loginStateVersion: 1
  },
  candidates: [{ candidateId: "candidate-1", displayName: "候选人甲" }]
};
const defaultLimitReviewState: OutreachBatchState = { ...directMessageReviewState };
delete defaultLimitReviewState.directMessageDailyLimit;
for (const compactDirectMessage of [false, true]) {
  renderOutreachBatchView(host, defaultLimitReviewState, {
    ...boundAccountContext, compactDirectMessage
  });
  const defaultLimitInput = host.querySelector<HTMLInputElement>("[data-outreach-direct-message-limit]");
  assert.equal(defaultLimitInput?.value, "50",
    "an absent review allowance must render the requested daily default of 50");
  assert.equal(defaultLimitInput?.getAttribute("min"), "1");
  assert.equal(defaultLimitInput?.getAttribute("max"), "100");
  assert.equal(host.querySelector("[data-outreach-direct-message-configured]")?.textContent, "50 条");
}
renderOutreachBatchView(host, directMessageReviewState, {
  ...boundAccountContext,
  compactDirectMessage: true
});
const compactDirectMessageCompose = host.querySelector<HTMLElement>(
  "[data-outreach-direct-message-compose]"
)!;
assert.equal(compactDirectMessageCompose.classList.contains("is-compact-single-recipient"), true);
assert.equal(compactDirectMessageCompose.querySelector(
  ".outreach-direct-message-header-summary [data-outreach-direct-message-limit]"
)?.getAttribute("value"), "20");
assert.equal(compactDirectMessageCompose.querySelector(
  ".outreach-direct-message-controls.is-compact-single-recipient .outreach-direct-message-preview"
)?.hasAttribute("open"), false,
"the compact one-recipient layout keeps the review confirmation explicit before a queue action");
const pendingRecoveryAction: OutreachAction = {
  ...riskPausedAction,
  id: "action-comment-recovery",
  batchRevision: approvedBatch.revision,
  accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
  status: "queued",
  content: approvedBatch.candidates[0]!.comment,
  contentHash: approvedBatch.candidates[0]!.commentHash,
  approvalHash: approvedBatch.approvalHash!,
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
let recoveryViewState: OutreachBatchState = {
  phase: "ready",
  batch: approvedBatch,
  drafts: {},
  actions: [pendingRecoveryAction],
  executionGate: {
    accountId: approvedBatch.accountId,
    accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
    riskPaused: true,
    pendingActionIds: [pendingRecoveryAction.id],
    unresolvedActions: [{
      actionId: "action-uncertain-history",
      failureCode: "douyin_action_receipt_ambiguous"
    }]
  },
  recoveryConfirmed: false,
  recoveryNotice: null,
  error: null,
  conflict: false,
  closed: false,
  ...directMessageApprovalState()
};
renderOutreachBatchView(host, recoveryViewState, {
  ...boundAccountContext,
  surface: "comments"
});
assert.match(host.textContent ?? "", /发送账号已风险暂停/u);
assert.match(host.textContent ?? "", /当前批次 1 条公开评论尚未开始/u);
assert.match(host.textContent ?? "", /1 条历史结果待确认.*不会重发/u);
assert.doesNotMatch(host.textContent ?? "", /等待服务器状态更新/u);
assert.match(host.textContent ?? "", /账号风险暂停，动作尚未开始/u);
const recoveryConfirm = host.querySelector<HTMLInputElement>(
  "[data-outreach-recovery-confirm]"
)!;
const recoveryButton = host.querySelector<HTMLButtonElement>(
  "[data-outreach-action=recover-account]"
)!;
assert.equal(recoveryButton.disabled, true);
let recoveryViewCalls = 0;
const recoveryViewController = {
  getState: () => recoveryViewState,
  setRecoveryConfirmed(value: boolean) {
    recoveryViewState = { ...recoveryViewState, recoveryConfirmed: value };
  },
  async recoverAccountActions() { recoveryViewCalls += 1; }
} as unknown as OutreachBatchController;
const unbindRecovery = bindOutreachBatchActions(host, recoveryViewController);
recoveryButton.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(recoveryViewCalls, 0,
  "risk recovery must not run before the page confirmation");
recoveryConfirm.checked = true;
recoveryConfirm.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.equal(recoveryButton.disabled, false);
recoveryButton.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(recoveryViewCalls, 1);
assert.equal(recoveryConfirm.checked, false);
assert.equal(recoveryButton.disabled, true);
unbindRecovery();

renderOutreachBatchView(
  host,
  directMessageReviewState,
  boundAccountContext
);
const compactDirectMessageFlow = host.querySelector<HTMLElement>(
  "[data-outreach-direct-message-compose]"
);
assert.ok(compactDirectMessageFlow,
  "the batch must reveal an independent private-message confirmation flow");
assert.equal(host.querySelector("[data-outreach-field=comment]"), null,
  "the private-message surface must never render comment approval controls");
assert.match(compactDirectMessageFlow?.textContent ?? "", /本次已选择\s*1 人/u);
assert.match(compactDirectMessageFlow?.textContent ?? "", /当前设置上限\s*20 条/u);
assert.doesNotMatch(compactDirectMessageFlow?.textContent ?? "", /今日剩余/u,
  "batch-local actions must not be presented as authoritative account-wide quota");
assert.match(compactDirectMessageFlow?.textContent ?? "", /发送私信/u);
assert.match(compactDirectMessageFlow?.textContent ?? "", /确认并排队私信/u);
assert.match(compactDirectMessageFlow?.textContent ?? "", /预览并确认私信/u);
assert.match(compactDirectMessageFlow?.querySelector(
  "[data-outreach-direct-message-preview-content=candidate-1]"
)?.textContent ?? "", /原始精确私信/u);
assert.equal(
  compactDirectMessageFlow?.querySelectorAll(
    "[data-outreach-direct-message-confirm]"
  ).length,
  1,
  "the compact flow must expose exactly one explicit human confirmation"
);
assert.equal(
  host.querySelector(".outreach-editor [data-outreach-field=directMessage]"),
  null,
  "private-message drafts must not be repeated inside the comment review cards"
);
const receiptDisclosure = host.querySelector<HTMLDetailsElement>(
  "details[data-outreach-receipts]"
);
assert.ok(receiptDisclosure, "send details and receipts must use one disclosure");
assert.equal(receiptDisclosure?.hasAttribute("open"), false,
  "send details and receipts must be collapsed by default");
const directMessageDraft = host.querySelector<HTMLElement>(
  "[data-outreach-direct-message-state=editable]"
);
assert.ok(directMessageDraft,
  "a current successful comment receipt must unlock one compact private-message draft");
assert.match(compactDirectMessageFlow?.textContent ?? "", /查看公开主页/u,
  "the independent private-message review must show the exact recipient profile");
const unlockedDirectMessage = directMessageDraft
  ?.querySelector<HTMLTextAreaElement>("[data-outreach-field=directMessage]");
assert.equal(unlockedDirectMessage?.disabled, false);
assert.equal(unlockedDirectMessage?.getAttribute("maxlength"), "800");
assert.match(directMessageDraft?.textContent ?? "", /6 \/ 800/u);
const dailyLimit = host.querySelector<HTMLInputElement>(
  "[data-outreach-direct-message-limit]"
);
assert.equal(dailyLimit?.value, "20");
assert.equal(dailyLimit?.getAttribute("min"), "1");
assert.equal(dailyLimit?.getAttribute("max"), "100");
assert.match(host.textContent ?? "", /确认并排队私信/u);
assert.match(host.textContent ?? "", /无需先发表评论/u);
assert.equal(
  host.querySelector("[data-outreach-confirm]"),
  null,
  "the comment confirmation must not be reused after comment approval"
);

renderOutreachBatchView(host, directMessageReviewState, {
  ...boundAccountContext,
  account: { ...boundAccountContext.account!, loginStateVersion: 8 }
});
assert.equal(
  host.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-confirm]"
  )?.disabled,
  false,
  "the current active sender version may authorize DM even when the batch froze an older login"
);

renderOutreachBatchView(host, {
  ...directMessageReviewState,
  actions: [{
    ...successfulCommentForDirectMessage,
    platformReceiptReference: null
  }]
}, boundAccountContext);
assert.ok(host.querySelector("[data-outreach-direct-message-compose]"));
assert.ok(host.querySelector("[data-outreach-field=directMessage]"),
  "a non-verifiable comment result must not hide independent private-message controls");

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
assert.match(host.textContent ?? "", /私信草稿已更新/u);
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
    approvalPhase === "approving" ? /正在提交私信确认/u : /私信已确认，等待发送结果/u
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
for (const [status, label, summary] of [
  ["queued", "已排队", "私信发送中"],
  ["executing", "执行中", "私信发送中"],
  ["succeeded", "已送达", "私信发送完成"],
  ["failed", "执行失败", "私信发送失败"],
  ["risk_paused", "风险暂停", "私信发送失败"]
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
  assert.match(
    host.querySelector("[data-outreach-direct-message-compose]")?.textContent
      ?? "",
    new RegExp(summary, "u"),
    "private-message outcomes must be summarized in readable Chinese"
  );
  assert.equal(
    host.querySelector("[data-outreach-action=approve-direct-messages]"),
    null,
    "any existing private-message action must prevent reapproval"
  );
}

renderOutreachBatchView(host, {
  ...directMessageReviewState,
  actions: [{
    ...directMessageActionBase,
    status: "reconciliation_required",
    executionTarget: "desktop",
    attemptCount: 1,
    failureCode: "douyin_action_receipt_ambiguous",
    occurredAt: "2026-08-27T00:04:00.000Z"
  }]
}, boundAccountContext);
assert.match(host.querySelector("[data-outreach-direct-message-compose]")
  ?.textContent ?? "", /私信结果待确认.*不会自动重发/u);
assert.doesNotMatch(host.querySelector("[data-outreach-direct-message-compose]")
  ?.textContent ?? "", /正在排队或执行/u);

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
assert.equal(host.querySelector("[data-outreach-field=comment]"), null,
  "the private-message surface must not render comment editing state");
assert.match(
  host.querySelector("[data-outreach-direct-message-compose]")?.textContent
    ?? "",
  /私信发送中/u,
  "queued private messages must display one compact flow status"
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

const secondDirectMessageAction: OutreachAction = {
  ...directMessageActionBase,
  id: "action-direct-message-v2-second",
  candidateId: "candidate-2",
  sequence: 2,
  predecessorActionId: successfulSecondViewComment.id,
  targetPublicUrl: secondViewCandidate.publicProfileUrl,
  content: secondViewCandidate.directMessage,
  contentHash: secondViewCandidate.directMessageHash,
  directMessageDailyOrdinal: 2,
  status: "failed",
  failureCode: "action_rejected",
  occurredAt: "2026-08-27T00:05:00.000Z"
};
renderOutreachBatchView(host, {
  ...directMessageReviewState,
  batch: twoCandidateBatch,
  actions: [successfulCommentForDirectMessage, successfulSecondViewComment, {
    ...directMessageActionBase,
    status: "succeeded",
    platformReceiptReference: "douyin-message:receipt-v2",
    occurredAt: "2026-08-27T00:04:00.000Z"
  }, secondDirectMessageAction]
}, boundAccountContext);
assert.match(
  host.querySelector("[data-outreach-direct-message-compose]")?.textContent
    ?? "",
  /部分私信发送未完成.*1 条已送达，1 条未完成/u,
  "mixed private-message outcomes must have one readable partial-success summary"
);

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
}, { surface: "history" });
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
assert.equal(host.querySelector("[data-outreach-field]"), null,
  "the history surface must be receipt-only");
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
  ".outreach-direct-message-draft"
)!;
const editedDirectMessageDraft = directMessageTextarea
  .closest<HTMLElement>("[data-outreach-direct-message-state]")!;
const untouchedDirectMessageDraft = host.querySelector<HTMLTextAreaElement>(
  "[data-outreach-candidate-id=candidate-2][data-outreach-field=directMessage]"
)!.closest<HTMLElement>("[data-outreach-direct-message-state]")!;
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
assert.equal(host.querySelector(
  '[data-outreach-direct-message-preview-content="candidate-1"]'
)?.textContent, "编辑后必须清除二次确认",
"the confirmation preview must immediately reflect the edited exact body without a rerender");
assert.equal(host.querySelector(
  '[data-outreach-direct-message-preview-content="candidate-2"]'
)?.textContent, directMessageBindingInitialState.batch!.candidates[1].directMessage,
"editing a message must not change another recipient's preview");
assert.equal(directMessageConfirmation.checked, false);
assert.equal(directMessageApprovalButton.disabled, true);
assert.equal(editedDirectMessageDraft.classList.contains("is-dirty"), true,
  "the edited private-message card must immediately enter the dirty visual state");
assert.equal(editedDirectMessageDraft.classList.contains("is-editable"), false);
assert.equal(editedDirectMessageDraft.dataset.outreachDirectMessageState, "dirty");
assert.match(
  editedDirectMessageDraft.querySelector(
    ".outreach-direct-message-status"
  )?.textContent ?? "",
  /私信草稿已更新.*重新预览并确认/u
);
assert.match(editedDirectMessageCard.textContent ?? "", /重新预览并确认/u);
assert.doesNotMatch(editedDirectMessageCard.textContent ?? "", /保存新修订后才能最终确认/u);
assert.equal(untouchedDirectMessageDraft.classList.contains("is-editable"), true);
assert.equal(untouchedDirectMessageDraft.classList.contains("is-dirty"), false,
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
assert.equal(host.querySelector(
  '[data-outreach-direct-message-preview-content="candidate-1"]'
)?.textContent, "", "clearing the body must also clear its confirmation preview");
assert.equal(directMessageConfirmation.disabled, true,
  "an empty message must not expose an enabled confirmation control");
directMessageTextarea.value = "恢复为有效精确私信 <b>纯文本</b>";
directMessageTextarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const restoredPreview = host.querySelector(
  '[data-outreach-direct-message-preview-content="candidate-1"]'
)!;
assert.equal(restoredPreview.textContent, directMessageTextarea.value);
assert.equal(restoredPreview.querySelector("b"), null,
  "exact message previews must display markup literally, never interpret HTML");
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
