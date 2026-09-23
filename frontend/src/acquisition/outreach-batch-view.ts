import type { OutreachBatchController, OutreachBatchState } from "./outreach-batch-controller";
import { outreachActionCopy, desktopOutreachCopy, getInstalledDesktopRuntime } from "../desktop/desktop-runtime";
import type { DesktopOutreachCoordinatorView } from "../desktop/desktop-bridge";
import { patchStableView } from "../desktop/stable-view";

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const actionLabel: Record<string, string> = { comment: "公开评论", direct_message: "私信" };
const actionState: Record<string, string> = { queued: "已排队", blocked_by_predecessor: "等待评论回执", executing: "执行中", succeeded: "已送达", failed: "执行失败", risk_paused: "风险暂停" };
const batchState: Record<string, string> = { awaiting_approval: "待人工审批", approved: "已批准执行", rejected: "已拒绝", paused: "已暂停" };
const localDirectMessageDirtyCopy =
  "私信草稿已更新，请重新预览并确认。";
const failureLabel: Record<string, string> = {
  action_unavailable: "平台暂时无法执行该动作",
  action_rejected: "平台拒绝了该动作",
  approval_authority_changed: "审批后的授权依据已变化，本动作未执行",
  predecessor_failed: "公开评论未成功，已取消后续私信",
  account_risk_paused: "发送账号已风险暂停，本动作未执行",
  deadline_exceeded: "执行超过安全时限",
  douyin_verification_required: "需要在抖音窗口手动完成验证",
  douyin_rate_limited: "抖音触发频率限制，批次已暂停",
  douyin_account_warning: "抖音账号出现风险提示，批次已暂停",
  douyin_account_identity_changed: "当前抖音账号与审批账号不一致，已暂停且未继续操作",
  douyin_login_expired: "抖音登录已失效，请重新连接登录",
  douyin_direct_message_unavailable: "私信执行未完成，未确认具体原因；请查看技术信息并检查本机执行日志",
  douyin_action_control_missing: "未找到唯一可用的抖音操作控件",
  douyin_action_control_ambiguous: "抖音页面出现多个操作控件，已安全停止",
  douyin_action_content_mismatch: "页面回读文案与审批文案不一致",
  douyin_action_receipt_ambiguous:
    "评论可能已提交但未取得唯一回执；不会自动重发，可在抖音核对后只读核验",
  douyin_action_timeout: "等待抖音回执超时，动作已冻结"
};
const errorLabel: Record<string, string> = {
  douyin_desktop_executor_invalid:
    "桌面执行绑定已失效或不可用。请进入管理账号，点击“重新检测本机登录”，再点击“重新绑定本机账号”；恢复就绪后重新核对并确认新任务。",
  outreach_candidate_projection_pending:
    "候选数据仍在采集中或等待最终入库。完成后再确认；当前不会排队真实评论或私信。私信可在候选人与当前发送账号就绪后单独确认。",
  outreach_candidate_projection_unavailable:
    "本次采集没有形成可审批的最终候选数据，请重新运行采集后再生成评论批次。",
  outreach_actions_disabled: "服务器尚未开启真实抖音评论与私信，请联系管理员启用后重试",
  outreach_internal_error: "评论批次处理失败，请刷新页面后重试",
  outreach_batch_conflict: "批次已被更新，请重新核对当前修订",
  outreach_daily_limit_exhausted:
    "该候选人今天已进入过真实评论动作，或当日额度已用完；请选择另一位候选人，或明天重新生成批次",
  outreach_action_recovery_stale:
    "评论队列状态已变化，请刷新后重新核对再恢复",
  precondition_failed: "批次版本已变化，请重新核对后再确认"
};
const reconcilableFailure = (value: string | null) => [
  "action_unavailable", "douyin_action_timeout",
  "douyin_action_receipt_ambiguous"
].includes(value ?? "");
const exactDouyinVideoUrl = (value: string | undefined): value is string =>
  typeof value === "string"
  && /^https:\/\/www\.douyin\.com\/video\/[A-Za-z0-9_-]{1,300}$/u.test(value);
const exactDouyinProfileUrl = (value: string | undefined): value is string =>
  typeof value === "string"
  && /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]{1,300}$/u.test(value);

export interface OutreachBatchCandidateViewContext {
  candidateId: string;
  displayName: string;
  evidenceExcerpt?: string;
  evidenceSourceUrl?: string;
}

export interface OutreachBatchAccountViewContext {
  id: string;
  displayName: string | null;
  state: string;
  loginStateVersion: number | null;
}

export interface OutreachBatchViewContext {
  surface?: "comments" | "direct_messages" | "history";
  desktopStatus?: DesktopOutreachCoordinatorView | null;
  account?: OutreachBatchAccountViewContext | null;
  candidates?: readonly OutreachBatchCandidateViewContext[];
  /** A real conversation with one recipient can use the denser private-message header. */
  compactDirectMessage?: boolean;
}

export interface OutreachBatchMountOptions {
  context?: () => OutreachBatchViewContext;
  subscribeContext?: (listener: () => void) => () => void;
}

function contextFingerprint(
  context: OutreachBatchViewContext,
  state: OutreachBatchState
): string {
  const relevantCandidateIds = new Set(
    state.batch?.candidates.map((candidate) => candidate.candidateId) ?? []
  );
  const candidates = [...(context.candidates ?? [])]
    .filter((candidate) => relevantCandidateIds.has(candidate.candidateId))
    .map((candidate) => [
      candidate.candidateId,
      candidate.displayName.trim(),
      candidate.evidenceExcerpt?.trim() ?? null,
      candidate.evidenceSourceUrl ?? null
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return JSON.stringify([
    context.surface ?? "comments",
    context.compactDirectMessage === true,
    context.account ? [
      context.account.id,
      context.account.displayName?.trim() || null,
      context.account.state,
      context.account.loginStateVersion
    ] : null,
    candidates
  ]);
}

function technicalDetail(code: string): string {
  return `<details class="outreach-technical"><summary>技术信息</summary><code>${escape(code)}</code></details>`;
}

function renderError(value: string, desktop = false): string {
  const normalized = value.trim();
  const friendly = desktop && normalized === "outreach_actions_disabled"
    ? "当前桌面发送尚未启用，请启用桌面执行服务后重试。"
    : errorLabel[normalized]
    ?? (/HTTP 500/iu.test(normalized) ? "服务器处理评论批次时出错，请刷新后重试" : normalized);
  return `<div class="douyin-alert" role="alert" tabindex="-1"><strong>${escape(friendly)}</strong>${friendly === normalized ? "" : technicalDetail(normalized)}</div>`;
}

type BatchCandidate = NonNullable<OutreachBatchState["batch"]>["candidates"][number];

function draftFor(state: OutreachBatchState, candidate: BatchCandidate) {
  return state.drafts[candidate.candidateId] ?? {
    comment: candidate.comment,
    directMessage: candidate.directMessage
  };
}

function draftIsDirty(state: OutreachBatchState, candidate: BatchCandidate): boolean {
  const draft = draftFor(state, candidate);
  return draft.comment !== candidate.comment
    || draft.directMessage !== candidate.directMessage;
}

function directMessageActionFor(
  state: OutreachBatchState,
  candidateId: string
) {
  return state.actions.find((action) => action.kind === "direct_message"
    && action.candidateId === candidateId) ?? null;
}

function directMessageFlowCopy(
  phase: NonNullable<OutreachBatchState["directMessageApprovalPhase"]>,
  actions: readonly ReturnType<typeof directMessageActionFor>[]
): { title: string; detail: string; tone: string } {
  if (phase === "approving") return {
    title: "正在提交私信确认",
    detail: "已锁定本次草稿，请勿重复操作。",
    tone: "pending"
  };
  if (phase === "pending") return {
    title: "私信已确认，等待发送结果",
    detail: "服务器正在更新动作状态。",
    tone: "pending"
  };
  const current = actions.filter((action): action is NonNullable<typeof action> =>
    Boolean(action));
  const succeeded = current.filter((action) => action.status === "succeeded").length;
  const failed = current.filter((action) =>
    action.status === "failed" || action.status === "risk_paused").length;
  const uncertain = current.filter((action) =>
    action.status === "reconciliation_required").length;
  const active = current.length - succeeded - failed - uncertain;
  if (succeeded > 0 && failed > 0) return {
    title: "部分私信发送未完成",
    detail: `${succeeded} 条已送达，${failed} 条未完成，可展开回执查看原因。`,
    tone: "failed"
  };
  if (failed > 0 && active === 0) return {
    title: "私信发送失败",
    detail: `${failed} 条私信未送达，可展开回执查看原因。`,
    tone: "failed"
  };
  if (uncertain > 0) return {
    title: "私信结果待确认",
    detail: `${uncertain} 条私信结果尚不确定，不会自动重发；请在发送记录中核对。`,
    tone: "failed"
  };
  if (active > 0) return {
    title: "私信发送中",
    detail: `${active} 条私信正在排队或执行。`,
    tone: "pending"
  };
  if (succeeded > 0) return {
    title: "私信发送完成",
    detail: `${succeeded} 条私信已获得平台送达回执。`,
    tone: "succeeded"
  };
  return {
    title: "发送私信",
    detail: "选择精确收件人并逐条核对正文；私信可独立发送，无需先评论。",
    tone: "ready"
  };
}

export function renderOutreachBatchView(
  host: HTMLElement,
  state: OutreachBatchState,
  context: OutreachBatchViewContext = {}
): void {
  const batch = state.batch;
  const surface = context.surface ?? "comments";
  const showComments = surface === "comments";
  const showDirectMessages = surface === "direct_messages";
  const visibleActions = surface === "history"
    ? state.actions
    : state.actions.filter((action) => action.kind === (showComments ? "comment" : "direct_message"));
  const busy = ["loading", "saving", "approving"].includes(state.phase);
  const editorDisabled = busy || batch?.state !== "awaiting_approval";
  const contextByCandidate = new Map((context.candidates ?? []).map((candidate) => [
    candidate.candidateId,
    candidate
  ]));
  const hasDirtyDraft = Boolean(batch?.candidates.some((candidate) =>
    draftIsDirty(state, candidate)));
  const accountHasBoundIdentity = Boolean(context.account?.displayName?.trim());
  const accountMatchesBatch = Boolean(batch && context.account
    && context.account.id === batch.accountId
    && context.account.loginStateVersion === batch.accountLoginStateVersion
    && context.account.state === "active"
    && accountHasBoundIdentity);
  const selectedCandidates = batch?.candidates.filter((candidate) => candidate.selected) ?? [];
  const frozenTargetsReady = selectedCandidates.length > 0
    && selectedCandidates.every((candidate) =>
      exactDouyinVideoUrl(candidate.commentTargetPublicUrl)
      && exactDouyinProfileUrl(candidate.publicProfileUrl));
  const reviewContextReady = accountMatchesBatch && frozenTargetsReady;
  const accountReviewLabel = accountMatchesBatch
    ? context.account!.displayName!.trim()
    : context.account
      ? accountHasBoundIdentity
        ? "当前连接账号与本批次不匹配"
        : "当前抖音连接未完成账号身份绑定"
      : "批次账号信息待恢复";
  const executionGate = state.executionGate ?? null;
  const recoveryPendingActions = executionGate?.pendingActionIds.map((id) =>
    state.actions.find((action) => action.id === id)) ?? [];
  const recoveryContextReady = Boolean(batch
    && batch.state === "approved"
    && batch.approvalHash
    && executionGate?.riskPaused
    && executionGate.accountId === batch.accountId
    && executionGate.accountLoginStateVersion === batch.accountLoginStateVersion
    && accountMatchesBatch
    && recoveryPendingActions.length > 0
    && recoveryPendingActions.every((action) => action
      && action.kind === "comment"
      && action.batchId === batch.id
      && action.batchRevision === batch.revision
      && action.accountId === batch.accountId
      && action.accountLoginStateVersion === batch.accountLoginStateVersion
      && action.approvalHash === batch.approvalHash
      && action.attemptCount === 0
      && (action.status === "queued" || (action.status === "risk_paused"
        && action.failureCode === "account_risk_paused"))));
  const recoveryConfirmed = state.recoveryConfirmed ?? false;
  const scopedCandidateIds = context.candidates?.length
    ? new Set(context.candidates.map((candidate) => candidate.candidateId))
    : null;
  const directMessageCandidates = batch?.candidates.filter((candidate) =>
    (!scopedCandidateIds || scopedCandidateIds.has(candidate.candidateId))
    && !directMessageActionFor(state, candidate.candidateId)) ?? [];
  const directMessageSelectedCandidateIds = state.directMessageSelectedCandidateIds
    ?? directMessageCandidates.filter((candidate) => candidate.selected)
      .map((candidate) => candidate.candidateId);
  const selectedDirectMessageCandidates = directMessageCandidates.filter(
    (candidate) => directMessageSelectedCandidateIds.includes(candidate.candidateId));
  const directMessageDailyLimit = state.directMessageDailyLimit ?? 50;
  const directMessageConfirmed = state.directMessageConfirmed ?? false;
  const directMessageApprovalPhase = state.directMessageApprovalPhase ?? "idle";
  const directMessagePendingCandidateIds = state.directMessagePendingCandidateIds
    ?? [];
  const currentDirectMessageActions = state.actions.filter((action) =>
    action.kind === "direct_message"
    && (action.authorizationVersion === 2 || action.authorizationVersion === 3)
    && action.batchId === batch?.id);
  const directMessageSendableCount = selectedDirectMessageCandidates.length;
  const directMessageLimitValid = Number.isInteger(
    directMessageDailyLimit
  ) && directMessageDailyLimit >= 1
    && directMessageDailyLimit <= 100;
  const directMessagesValid = selectedDirectMessageCandidates.every((candidate) => {
    const value = draftFor(state, candidate).directMessage;
    return value.trim().length >= 1 && value.length <= 800;
  });
  const directMessageCountFits = directMessageLimitValid
    && selectedDirectMessageCandidates.length > 0
    && selectedDirectMessageCandidates.length <= directMessageDailyLimit;
  const directMessageApprovalBusy = directMessageApprovalPhase !== "idle";
  const currentSenderReady = Boolean(context.account
    && context.account.id === batch?.accountId
    && context.account.state === "active"
    && accountHasBoundIdentity
    && Number.isInteger(context.account.loginStateVersion)
    && (context.account.loginStateVersion ?? 0) >= 1);
  const directMessageApprovalContextReady = currentSenderReady
    && directMessageCandidates.length > 0
    && !busy
    && !directMessageApprovalBusy;
  const directMessageApprovalReady = directMessageApprovalContextReady
    && directMessageCountFits
    && directMessagesValid;
  const directMessageFlow = directMessageFlowCopy(
    directMessageApprovalPhase,
    directMessageCandidates.length > 0 ? [] : currentDirectMessageActions
  );
  const showDirectMessageFlow = Boolean(batch
    && ["awaiting_approval", "approved"].includes(batch.state))
    && (directMessageCandidates.length > 0
      || directMessageApprovalBusy
      || currentDirectMessageActions.length > 0);
  const compactSingleDirectMessage = showDirectMessages
    && context.compactDirectMessage === true
    && directMessageCandidates.length === 1;
  const directMessageAccountName = context.account?.displayName?.trim() || "未连接";
  const directMessageLimitInput = `<input type="number" min="1" max="100" step="1" value="${escape(String(directMessageDailyLimit))}" data-outreach-direct-message-limit ${directMessageApprovalBusy ? "disabled" : ""}>`;
  const directMessageHeader = compactSingleDirectMessage ? `<div class="outreach-direct-message-compose-header is-compact-single-recipient"><div class="outreach-direct-message-header-copy"><span class="outreach-direct-message-eyebrow">私信独立授权</span><h4>${escape(directMessageFlow.title)}</h4><p class="outreach-direct-message-status" role="status">${escape(directMessageFlow.detail)}</p></div><div class="outreach-direct-message-header-summary" aria-label="私信确认摘要"><div data-outreach-direct-message-account-summary><span>发送账号</span><strong>${escape(directMessageAccountName)}</strong></div><div><span>已选收件人</span><strong data-outreach-direct-message-sendable>${directMessageSendableCount} 人</strong></div><label class="outreach-direct-message-limit"><span>每日上限</span>${directMessageLimitInput}<strong data-outreach-direct-message-configured>${directMessageDailyLimit} 条</strong></label></div></div>` : `<div class="outreach-direct-message-compose-header"><div><span class="outreach-direct-message-eyebrow">私信独立授权</span><h4>${escape(directMessageFlow.title)}</h4><p class="outreach-direct-message-status" role="status">${escape(directMessageFlow.detail)}</p><p data-outreach-direct-message-account-summary>当前发送账号：<strong>${escape(directMessageAccountName)}</strong></p></div>${directMessageCandidates.length > 0 ? `<div class="outreach-direct-message-metrics"><div><span>本次已选择</span><strong data-outreach-direct-message-sendable>${directMessageSendableCount} 人</strong></div><div><span>当前设置上限</span><strong data-outreach-direct-message-configured>${directMessageDailyLimit} 条</strong></div></div>` : ""}</div>`;
  const directMessageConfirmation = `<div class="outreach-direct-message-confirmation"><p><strong>发送账号：</strong>${escape(directMessageAccountName)}</p><p><strong>精确收件人：</strong>${selectedDirectMessageCandidates.map((candidate) => escape(contextByCandidate.get(candidate.candidateId)?.displayName?.trim() || candidate.candidateId)).join("、") || "尚未选择"}</p>${selectedDirectMessageCandidates.map((candidate) => `<blockquote data-outreach-direct-message-preview-content="${escape(candidate.candidateId)}">${escape(draftFor(state, candidate).directMessage)}</blockquote>`).join("")}<p>发送数量须在当日剩余额度内。</p>${!directMessageCountFits ? `<p class="outreach-direct-message-limit-error" role="status">本次 ${selectedDirectMessageCandidates.length} 位候选人超过设置上限，或尚未选择收件人，请调整后再确认。</p>` : ""}<label class="outreach-confirm"><input type="checkbox" data-outreach-direct-message-confirm data-outreach-direct-message-context-ready="${directMessageApprovalContextReady}" data-outreach-direct-message-ready="${directMessageApprovalReady}" ${directMessageConfirmed ? "checked" : ""} ${directMessageApprovalReady ? "" : "disabled"}> 我已核对当前发送账号、精确收件人和私信正文，并单独授权本次发送</label><button type="button" class="primary" data-outreach-action="approve-direct-messages" ${directMessageConfirmed && directMessageApprovalReady ? "" : "disabled"}>确认并排队私信</button></div>`;
  const directMessagePreview = `<details class="outreach-direct-message-preview"><summary>预览并确认私信</summary>${directMessageConfirmation}</details>`;
  const directMessageDrafts = directMessageCandidates.map((candidate) => {
    const index = batch?.candidates.findIndex((item) =>
      item.candidateId === candidate.candidateId) ?? -1;
    const candidateContext = contextByCandidate.get(candidate.candidateId);
    const draft = draftFor(state, candidate);
    const dirty = draft.directMessage !== candidate.directMessage;
    const candidatePending = directMessagePendingCandidateIds.includes(candidate.candidateId);
    const locked = directMessageApprovalBusy || candidatePending;
    const itemState = locked ? directMessageApprovalPhase : dirty ? "dirty" : "editable";
    const status = locked
      ? "本次草稿已锁定，正在等待服务器更新。"
      : !currentSenderReady
        ? "请连接并核对当前发送账号后再确认。"
        : dirty ? localDirectMessageDirtyCopy : "可编辑并核对这条私信正文；无需先发表评论。";
    const selected = directMessageSelectedCandidateIds.includes(candidate.candidateId);
    const evidence = candidateContext?.evidenceExcerpt?.trim();
    return `<article class="outreach-direct-message-draft is-${escape(itemState)}" data-view-key="dm-draft:${escape(candidate.candidateId)}" data-outreach-direct-message-state="${escape(itemState)}"><header><label><input type="checkbox" data-outreach-direct-message-candidate="${escape(candidate.candidateId)}" ${selected ? "checked" : ""} ${locked ? "disabled" : ""}> <strong>${escape(candidateContext?.displayName?.trim() || `候选人 ${index + 1}`)}</strong></label><a href="${escape(candidate.publicProfileUrl)}" target="_blank" rel="noopener noreferrer">查看公开主页</a></header>${evidence ? `<details><summary>公开证据</summary><p>${escape(evidence)}</p>${candidateContext?.evidenceSourceUrl ? `<a href="${escape(candidateContext.evidenceSourceUrl)}" target="_blank" rel="noopener noreferrer">打开公开来源</a>` : ""}</details>` : ""}<label><span>私信正文 <em data-outreach-counter="${escape(candidate.candidateId)}:directMessage">${draft.directMessage.length} / 800</em></span><textarea data-outreach-candidate-id="${escape(candidate.candidateId)}" data-outreach-field="directMessage" rows="3" maxlength="800" ${locked || !selected ? "disabled" : ""}>${escape(draft.directMessage)}</textarea></label><p class="outreach-direct-message-status">${escape(status)}</p></article>`;
  }).join("");
  const directMessageControls = directMessageCandidates.length > 0
    ? `<div class="outreach-direct-message-controls${compactSingleDirectMessage ? " is-compact-single-recipient" : ""}">${compactSingleDirectMessage ? "" : `<label class="outreach-direct-message-limit"><span>每日私信上限（1–100）</span>${directMessageLimitInput}</label>`}${directMessagePreview}</div>`
    : "";
  const directMessageCompose = showDirectMessages && showDirectMessageFlow && batch ? `<section class="outreach-direct-message-compose is-${escape(directMessageFlow.tone)}${compactSingleDirectMessage ? " is-compact-single-recipient" : ""}" data-outreach-direct-message-compose aria-label="私信二次确认">
    ${directMessageHeader}
    ${directMessageCandidates.length > 0 ? `<div class="outreach-direct-message-drafts">${directMessageDrafts}</div>${directMessageControls}` : ""}
  </section>` : "";
  const desktopStatus = context.desktopStatus === undefined ? getInstalledDesktopRuntime()?.outreachStatus() : context.desktopStatus;
  const legacyPending = desktopStatus !== undefined && state.actions.some((action) => action.executionTarget !== "desktop"
    && ["queued", "blocked_by_predecessor", "executing"].includes(action.status));
  patchStableView(host, `<section class="douyin-panel outreach-workspace" aria-label="批次审批与执行回执">
    ${showComments ? '<div class="douyin-panel-title"><span class="douyin-step">05</span><div><h3>公开评论审批</h3><p>只核对并授权公开评论，不会批准或排队私信。</p></div></div>' : surface === "history" ? '<div class="douyin-panel-title"><div><h3>发送记录</h3><p>按服务器回执独立展示评论与私信结果。</p></div></div>' : ""}
    ${desktopStatus !== undefined ? `<p class="douyin-inline-status" role="status" data-outreach-desktop-status>${escape(desktopOutreachCopy(desktopStatus))}</p>` : ""}
    ${legacyPending ? `<p class="douyin-inline-status is-warning">存在旧版服务器待执行动作，切换前需先处理</p>` : ""}
    ${state.error ? renderError(state.error, desktopStatus !== undefined) : ""}
    ${state.conflict ? `<p class="douyin-conflict" role="status">批次已更新为最新修订，请重新检查精确文案后再确认。</p>` : ""}
    ${state.recoveryNotice ? `<p class="douyin-conflict" role="status">${escape(state.recoveryNotice)}</p>` : ""}
    ${!batch ? `<div class="douyin-empty"><strong>选择候选人后生成待审批批次</strong><p>批次会冻结证据、模型来源与当日限额。</p></div>` : `${showComments ? `<div class="outreach-summary"><div><span>批次状态</span><strong>${escape(batchState[batch.state] ?? batch.state)}</strong></div><div><span>选中候选人</span><strong>${batch.candidates.filter((candidate) => candidate.selected).length}</strong></div><div><span>本批次剩余 / 上限</span><strong>${batch.dailyRemainingLimit} / ${batch.dailyCandidateLimit}</strong></div><div><span>预计最短时长</span><strong>${Math.ceil(batch.candidates.filter((candidate) => candidate.selected).length * 4)} 分钟</strong></div></div>
      <p class="douyin-inline-status">本批次上限沿用创建时的采集运行；新计划额度仅对后续新运行及新批次生效。</p>
      <section class="outreach-account-review" aria-label="本批次发送账号"><div><span>本批次发送账号</span><strong>${escape(accountReviewLabel)}</strong></div><div><span>账号标识</span><code>${escape(batch.accountId)}</code></div><div><span>登录状态版本</span><strong>v${batch.accountLoginStateVersion}</strong></div></section>
      ${batch.state === "awaiting_approval" && !reviewContextReady ? `<div class="outreach-review-blocker" role="status"><strong>暂不能最终确认</strong><p>${accountMatchesBatch ? "批次中的公开评论目标或候选人公开主页不完整，请刷新批次后重试。" : context.account && !accountHasBoundIdentity ? "当前抖音连接没有可核对的真实账号名称，请重新连接登录后再生成审批批次。" : "请先恢复与本批次账号标识、登录版本完全一致的有效抖音连接。"}</p></div>` : ""}
      ${executionGate?.riskPaused ? `<section class="outreach-review-blocker" role="alert" aria-label="抖音评论队列恢复" data-outreach-recovery><strong>发送账号已风险暂停</strong><p>当前批次 ${executionGate.pendingActionIds.length} 条公开评论尚未开始；恢复前服务器不会领取。</p><p>${executionGate.unresolvedActions.length} 条历史结果待确认，它们会继续冻结且不会重发。</p>${!accountMatchesBatch ? `<p>请先恢复与本批次账号和登录版本完全一致的抖音连接。</p>` : ""}<label class="outreach-confirm"><input type="checkbox" data-outreach-recovery-confirm data-outreach-recovery-ready="${recoveryContextReady}" ${recoveryConfirmed ? "checked" : ""} ${busy || !recoveryContextReady ? "disabled" : ""}> 我已在抖音核对账号、验证提示与历史动作，确认仅恢复当前批次中列出的未执行公开评论</label><div class="douyin-actions"><button type="button" class="primary" data-outreach-action="recover-account" ${recoveryConfirmed && recoveryContextReady && !busy ? "" : "disabled"}>确认并恢复当前批次评论</button></div></section>` : ""}
      <div class="outreach-editor-list">${batch.candidates.map((candidate, index) => {
        const candidateContext = contextByCandidate.get(candidate.candidateId);
        const draft = draftFor(state, candidate);
        const dirty = draftIsDirty(state, candidate);
        const target = exactDouyinVideoUrl(candidate.commentTargetPublicUrl)
          ? candidate.commentTargetPublicUrl
          : null;
        const profile = exactDouyinProfileUrl(candidate.publicProfileUrl)
          ? candidate.publicProfileUrl
          : null;
        const showDirtyHint = batch.state === "awaiting_approval" && dirty;
        return `<article class="outreach-editor"><header><span>${String(index + 1).padStart(2, "0")}</span><div><h4>${escape(candidateContext?.displayName?.trim() || `候选人 ${index + 1}`)}</h4><p>文案修订 ${candidate.draftRevision}（来源模型保持不变）</p></div></header><div class="outreach-target"><span>本次公开评论目标</span>${target ? `<a data-outreach-target="${escape(candidate.candidateId)}" href="${escape(target)}" target="_blank" rel="noopener noreferrer">打开抖音目标视频</a><code>${escape(target)}</code>` : `<p>批次缺少可验证的精确抖音视频，不能最终确认。</p>`}<span>候选人公开主页（只读）</span>${profile ? `<a data-outreach-profile="${escape(candidate.candidateId)}" href="${escape(profile)}" target="_blank" rel="noopener noreferrer">打开抖音公开主页</a><code>${escape(profile)}</code>` : `<p>批次缺少可验证的精确抖音主页，不能最终确认。</p>`}</div><label><span>精确公开评论 <em data-outreach-counter="${escape(candidate.candidateId)}:comment">${draft.comment.length} / 300</em></span><textarea data-outreach-index="${index}" data-outreach-candidate-id="${escape(candidate.candidateId)}" data-outreach-field="comment" rows="3" maxlength="300" ${editorDisabled ? "disabled" : ""}>${escape(draft.comment)}</textarea></label><small>已绑定 ${candidate.evidenceHashes.length} 条证据 · 需要人工复核</small><p class="outreach-dirty" data-outreach-dirty="${escape(candidate.candidateId)}" ${showDirtyHint ? "" : "hidden"}>草稿尚未保存；保存新修订后才能最终确认。</p></article>`;
      }).join("")}</div>
      <div class="outreach-approval-bar">${batch.state === "awaiting_approval" ? `<div class="outreach-approval-copy"><strong>这是第一次真实平台操作确认</strong><p>确认后服务器只会排队执行本批次真实评论；不会同时授权或发送私信。</p><label class="outreach-confirm"><input type="checkbox" data-outreach-confirm data-outreach-review-ready="${reviewContextReady}" ${busy || hasDirtyDraft || !reviewContextReady ? "disabled" : ""}> 我已核对发送账号、目标视频与精确评论，并授权排队执行</label></div><div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="save" ${busy ? "disabled" : ""}>保存为新修订</button><button type="button" class="primary" data-outreach-action="approve" disabled>确认并排队真实评论</button></div>` : `<div><strong>${escape(batchState[batch.state] ?? batch.state)}</strong><p>评论与私信均以服务器动作回执为准。</p></div><div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="${batch.state === "paused" ? "resume" : "pause"}" ${busy ? "disabled" : ""}>${batch.state === "paused" ? "恢复批次" : "暂停批次"}</button><button type="button" class="secondary" data-outreach-action="refresh" ${busy ? "disabled" : ""}>刷新回执</button></div>`}</div>
      ` : ""}${directMessageCompose}
      <details class="outreach-timeline" data-outreach-receipts><summary><span>发送详情与回执</span><strong>${visibleActions.length} 项</strong></summary><div class="outreach-timeline-body" aria-live="polite">${visibleActions.length ? visibleActions.map((action) => {
        const failure = action.failureCode
          ? failureLabel[action.failureCode] ?? "平台动作安全失败"
          : null;
        const historicalDirectMessage = action.kind === "direct_message"
          && action.authorizationVersion !== 2
          && action.authorizationVersion !== 3;
        const receiptNeedsConfirmation = action.executionTarget !== "desktop" && action.failureCode
          === "douyin_action_receipt_ambiguous";
        const gatedPending = Boolean(executionGate?.riskPaused
          && executionGate.pendingActionIds.includes(action.id));
        const kindLabel = historicalDirectMessage
          ? "历史私信（只读）"
          : action.kind === "direct_message"
            ? "真实私信"
            : actionLabel[action.kind] ?? action.kind;
        const stateLabel = receiptNeedsConfirmation
          ? "结果待确认"
          : gatedPending
            ? "已排队 · 等待人工恢复"
          : historicalDirectMessage
          ? (["succeeded", "failed"].includes(action.status)
              ? `历史${actionState[action.status] ?? action.status}` : "已停用")
          : outreachActionCopy(action);
        const statusCopy = gatedPending
          ? "账号风险暂停，动作尚未开始；恢复前不会执行。"
          : action.platformReceiptReference
            ? `平台回执：${escape(action.platformReceiptReference)}${action.kind === "comment" ? "；仅证明已取得该动作回执，不代表评论持续公开可见，请打开本动作目标核对。" : ""}`
            : failure
              ? `运行提示：${escape(failure)}`
              : historicalDirectMessage
                ? "服务器不会领取或发送这条私信。"
                : action.status === "queued" ? "已确认排队，尚未执行；同账号前序任务及平台等待可能延后领取，请勿重复提交。"
                : action.executionTarget === "desktop" ? "以中心保存的本机执行回执为准" : "等待服务器状态更新";
        return `<article class="outreach-action is-${gatedPending ? "risk_paused" : action.status}"><span>${action.sequence}</span><div><strong>${escape(kindLabel)} · ${escape(stateLabel)}</strong><p>${statusCopy}</p><a class="outreach-action-target" href="${escape(action.targetPublicUrl)}" target="_blank" rel="noopener noreferrer">查看本动作目标</a>${action.failureCode ? technicalDetail(action.failureCode) : ""}<small>尝试 ${action.attemptCount ?? 0} 次${action.occurredAt ? ` · ${escape(new Date(action.occurredAt).toLocaleString("zh-CN", { hour12: false }))}` : ""}</small>${(action.status === "risk_paused" || (action.executionTarget === "desktop" && action.status === "reconciliation_required")) && reconcilableFailure(action.failureCode) && !historicalDirectMessage ? `<div class="outreach-reconciliation"><label><input type="checkbox" data-outreach-reconcile-confirm="${escape(action.id)}" ${busy ? "disabled" : ""}> 我已在抖音页面核实该动作的本人回执</label><button type="button" class="secondary" data-outreach-action="reconcile" data-outreach-action-id="${escape(action.id)}" disabled>${action.executionTarget === "desktop" ? "提交只读对账请求" : "只读核验平台回执"}</button><p>仅检查已有回执，不会重新评论或私信；无法唯一证明时继续冻结。</p></div>` : ""}</div></article>`;
      }).join("") : `<p>${showComments ? "确认公开评论" : showDirectMessages ? "确认私信" : "完成发送"}后，将在这里显示服务器动作状态与平台回执。</p>`}</div></details>`}
  </section>`);
}

export function bindOutreachBatchActions(
  eventRoot: HTMLElement,
  controller: OutreachBatchController
): () => void {
  const syncDirectMessageApprovalControls = () => {
    const confirmation = eventRoot.querySelector<HTMLInputElement>(
      "[data-outreach-direct-message-confirm]"
    );
    const approve = eventRoot.querySelector<HTMLButtonElement>(
      "[data-outreach-action=approve-direct-messages]"
    );
    const limitInput = eventRoot.querySelector<HTMLInputElement>(
      "[data-outreach-direct-message-limit]"
    );
    if (!confirmation || !approve || !limitInput) return;
    const limit = Number(limitInput.value);
    const messages = [...eventRoot.querySelectorAll<HTMLTextAreaElement>(
      "[data-outreach-field=directMessage]:not([disabled])"
    )];
    const ready = confirmation.dataset.outreachDirectMessageContextReady
        === "true"
      && Number.isInteger(limit) && limit >= 1 && limit <= 100
      && messages.length > 0 && messages.length <= limit
      && messages.every((message) => message.value.trim().length >= 1
        && message.value.length <= 800);
    confirmation.dataset.outreachDirectMessageReady = String(ready);
    confirmation.disabled = !ready;
    if (!ready) {
      confirmation.checked = false;
      controller.setDirectMessageConfirmed(false);
    }
    confirmation.checked = ready
      && controller.getState().directMessageConfirmed === true;
    approve.disabled = !ready || !confirmation.checked
      || controller.getState().directMessageConfirmed !== true;
  };
  const input = (event: Event) => {
    const inputTarget = event.target as HTMLInputElement | null;
    if (inputTarget?.matches("[data-outreach-direct-message-limit]")) {
      const parsedLimit = Number(inputTarget.value);
      controller.setDirectMessageDailyLimit(parsedLimit);
      const configured = eventRoot.querySelector<HTMLElement>(
        "[data-outreach-direct-message-configured]"
      );
      if (configured) configured.textContent = Number.isInteger(parsedLimit)
        ? `${parsedLimit} 条`
        : "—";
      syncDirectMessageApprovalControls();
      return;
    }
    const target = event.target as HTMLTextAreaElement | null;
    if (!target) return;
    const candidate = target.dataset.outreachCandidateId
      ? controller.getState().batch?.candidates.find((item) =>
        item.candidateId === target.dataset.outreachCandidateId)
      : controller.getState().batch?.candidates[Number(target.dataset.outreachIndex)];
    const field = target.dataset.outreachField;
    if (candidate && (field === "comment" || field === "directMessage")) {
      const maximum = field === "comment" ? 300 : 800;
      if (field === "comment" && target.value.length > maximum) {
        target.value = target.value.slice(0, maximum);
      }
      controller.editMessage(candidate.candidateId, field, target.value);
      const counterKey = `${candidate.candidateId}:${field}`;
      const counter = [...eventRoot.querySelectorAll<HTMLElement>("[data-outreach-counter]")]
        .find((item) => item.dataset.outreachCounter === counterKey);
      if (counter) counter.textContent = `${target.value.length} / ${maximum}`;
      const nextState = controller.getState();
      const dirty = draftIsDirty(nextState, candidate);
      const dirtyHint = [...eventRoot.querySelectorAll<HTMLElement>("[data-outreach-dirty]")]
        .find((item) => item.dataset.outreachDirty === candidate.candidateId);
      if (dirtyHint) {
        dirtyHint.hidden = !dirty;
        if (field === "directMessage"
          && nextState.batch?.state === "approved") {
          dirtyHint.textContent = localDirectMessageDirtyCopy;
        }
      }
      const confirmation = eventRoot.querySelector<HTMLInputElement>(
        "[data-outreach-confirm]"
      );
      if (confirmation) {
        confirmation.checked = false;
        confirmation.disabled = confirmation.dataset.outreachReviewReady !== "true"
          || Boolean(nextState.batch?.candidates.some((item) =>
            draftIsDirty(nextState, item)));
      }
      const approve = eventRoot.querySelector<HTMLButtonElement>(
        "[data-outreach-action=approve]"
      );
      if (approve) approve.disabled = true;
      if (field === "directMessage") {
        const preview = [...eventRoot.querySelectorAll<HTMLElement>(
          "[data-outreach-direct-message-preview-content]"
        )].find((item) => item.dataset.outreachDirectMessagePreviewContent
          === candidate.candidateId);
        if (preview) preview.textContent = target.value;
        syncDirectMessageApprovalControls();
        const directMessageDirty = target.value !== candidate.directMessage;
        const draftItem = target.closest<HTMLElement>(
          "[data-outreach-direct-message-state]"
        );
        if (draftItem) {
          draftItem.dataset.outreachDirectMessageState = directMessageDirty
            ? "dirty"
            : "editable";
          draftItem.classList.toggle("is-dirty", directMessageDirty);
          draftItem.classList.toggle("is-editable", !directMessageDirty);
          const status = draftItem.querySelector<HTMLElement>(
            ".outreach-direct-message-status"
          );
          if (status) status.textContent = directMessageDirty
            ? localDirectMessageDirtyCopy
            : "可编辑并核对这条私信正文；无需先发表评论。";
        }
      }
    }
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.matches("[data-outreach-direct-message-candidate]")) {
      const candidateId = target.dataset.outreachDirectMessageCandidate;
      if (candidateId) controller.setDirectMessageCandidateSelected(
        candidateId,
        target.checked
      );
      syncDirectMessageApprovalControls();
      return;
    }
    if (target?.matches("[data-outreach-recovery-confirm]")) {
      controller.setRecoveryConfirmed(target.checked);
      target.checked = controller.getState().recoveryConfirmed === true;
      const button = eventRoot.querySelector<HTMLButtonElement>(
        "[data-outreach-action=recover-account]"
      );
      if (button) button.disabled = !target.checked
        || target.dataset.outreachRecoveryReady !== "true"
        || ["loading", "saving", "approving"].includes(
          controller.getState().phase
        );
      return;
    }
    if (target?.matches("[data-outreach-reconcile-confirm]")) {
      const actionId = target.dataset.outreachReconcileConfirm;
      const button = [...eventRoot.querySelectorAll<HTMLButtonElement>(
        "[data-outreach-action=reconcile]"
      )].find((candidate) => candidate.dataset.outreachActionId === actionId);
      if (button) button.disabled = !target.checked
        || ["loading", "saving", "approving"].includes(
          controller.getState().phase
        );
      return;
    }
    if (target?.matches("[data-outreach-direct-message-confirm]")) {
      controller.setDirectMessageConfirmed(target.checked);
      target.checked = controller.getState().directMessageConfirmed === true;
      syncDirectMessageApprovalControls();
      return;
    }
    if (!target?.matches("[data-outreach-confirm]")) return;
    const button = eventRoot.querySelector<HTMLButtonElement>(
      "[data-outreach-action=approve]"
    );
    const state = controller.getState();
    const dirty = Boolean(state.batch?.candidates.some((candidate) =>
      draftIsDirty(state, candidate)));
    if (button) button.disabled = !target.checked || dirty
      || target.dataset.outreachReviewReady !== "true"
      || ["loading", "saving", "approving"].includes(state.phase);
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-outreach-action]"
    );
    if (!target || !eventRoot.contains(target)) return;
    if (["loading", "saving", "approving"].includes(
      controller.getState().phase
    ) || (controller.getState().directMessageApprovalPhase ?? "idle") === "approving") return;
    const action = target.dataset.outreachAction;
    if (action === "save") void controller.saveRevision();
    else if (action === "approve") {
      const confirmation = eventRoot.querySelector<HTMLInputElement>(
        "[data-outreach-confirm]"
      );
      if (!confirmation?.checked) return;
      void controller.approve();
    }
    else if (action === "pause") void controller.pause();
    else if (action === "resume") void controller.resume();
    else if (action === "refresh") void controller.refreshActions();
    else if (action === "recover-account") {
      const confirmation = eventRoot.querySelector<HTMLInputElement>(
        "[data-outreach-recovery-confirm]"
      );
      if (!confirmation?.checked
        || confirmation.dataset.outreachRecoveryReady !== "true"
        || controller.getState().recoveryConfirmed !== true) return;
      const recovery = controller.recoverAccountActions();
      confirmation.checked = false;
      target.setAttribute("disabled", "");
      void recovery;
    }
    else if (action === "approve-direct-messages") {
      const confirmation = eventRoot.querySelector<HTMLInputElement>(
        "[data-outreach-direct-message-confirm]"
      );
      if (!confirmation?.checked
        || confirmation.dataset.outreachDirectMessageReady !== "true"
        || controller.getState().directMessageConfirmed !== true) return;
      target.setAttribute("disabled", "");
      void controller.approveDirectMessages();
    }
    else if (action === "reconcile") {
      const actionId = target.dataset.outreachActionId;
      const confirmation = [...eventRoot.querySelectorAll<HTMLInputElement>(
        "[data-outreach-reconcile-confirm]"
      )].find((candidate) =>
        candidate.dataset.outreachReconcileConfirm === actionId);
      if (!actionId || !confirmation?.checked) return;
      confirmation.checked = false;
      target.setAttribute("disabled", "");
      void controller.reconcileAction(actionId);
    }
  };
  eventRoot.addEventListener("input", input);
  eventRoot.addEventListener("change", change);
  eventRoot.addEventListener("click", click);
  return () => {
    eventRoot.removeEventListener("input", input);
    eventRoot.removeEventListener("change", change);
    eventRoot.removeEventListener("click", click);
  };
}

export function mountOutreachBatchView(
  host: HTMLElement,
  controller: OutreachBatchController,
  options: OutreachBatchMountOptions = {}
): () => void {
  let state = controller.getState();
  let context = options.context?.() ?? {};
  let renderedContextFingerprint = contextFingerprint(context, state);
  const render = () => renderOutreachBatchView(
    host,
    state,
    context
  );
  const unsubscribe = controller.subscribe((next) => {
    state = next;
    context = options.context?.() ?? {};
    renderedContextFingerprint = contextFingerprint(context, state);
    render();
  });
  const refreshContext = () => {
    const next = options.context?.() ?? {};
    const nextFingerprint = contextFingerprint(next, state);
    if (nextFingerprint === renderedContextFingerprint) return;
    context = next;
    renderedContextFingerprint = nextFingerprint;
    const senderBefore = controller.getState().directMessageSender;
    controller.refreshDirectMessageSender();
    if (controller.getState().directMessageSender !== senderBefore) return;
    render();
  };
  const unsubscribeContext = options.subscribeContext?.(refreshContext)
    ?? (() => undefined);
  const desktop = getInstalledDesktopRuntime();
  const unsubscribeDesktop = desktop?.subscribeOutreach(() => {
    const status = host.querySelector<HTMLElement>("[data-outreach-desktop-status]");
    if (status) status.textContent = desktopOutreachCopy(desktop.outreachStatus());
  }) ?? (() => undefined);
  const unbind = bindOutreachBatchActions(host, controller);
  return () => {
    unsubscribe();
    unsubscribeContext();
    unsubscribeDesktop();
    unbind();
  };
}
