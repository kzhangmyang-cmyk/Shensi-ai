import type { OutreachBatchController, OutreachBatchState } from "./outreach-batch-controller";

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const actionLabel: Record<string, string> = { comment: "公开评论", direct_message: "私信" };
const actionState: Record<string, string> = { queued: "已排队", blocked_by_predecessor: "等待评论回执", executing: "执行中", succeeded: "已送达", failed: "执行失败", risk_paused: "风险暂停" };
const batchState: Record<string, string> = { awaiting_approval: "待人工审批", approved: "已批准执行", rejected: "已拒绝", paused: "已暂停" };
const localDirectMessageDirtyCopy =
  "本地私信草稿已修改，请重新核对并进行独立确认；无需保存为批次新修订。";
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
  douyin_login_expired: "抖音登录已失效，请重新扫码",
  douyin_direct_message_unavailable: "当前目标暂不支持私信",
  douyin_action_control_missing: "未找到唯一可用的抖音操作控件",
  douyin_action_control_ambiguous: "抖音页面出现多个操作控件，已安全停止",
  douyin_action_content_mismatch: "页面回读文案与审批文案不一致",
  douyin_action_receipt_ambiguous:
    "评论可能已提交但未取得唯一回执；不会自动重发，可在抖音核对后只读核验",
  douyin_action_timeout: "等待抖音回执超时，动作已冻结"
};
const errorLabel: Record<string, string> = {
  outreach_candidate_projection_pending:
    "候选数据仍在采集中或等待最终入库。完成后再确认；当前不会排队真实评论或私信。评论成功后可再独立确认私信。",
  outreach_candidate_projection_unavailable:
    "本次采集没有形成可审批的最终候选数据，请重新运行采集后再生成评论批次。",
  outreach_actions_disabled: "服务器尚未开启真实抖音评论与私信，请联系管理员启用后重试",
  outreach_internal_error: "评论批次处理失败，请刷新页面后重试",
  outreach_batch_conflict: "批次已被更新，请重新核对当前修订",
  outreach_daily_limit_exhausted:
    "该候选人今天已进入过真实评论动作，或当日额度已用完；请选择另一位候选人，或明天重新生成批次",
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
}

export interface OutreachBatchAccountViewContext {
  id: string;
  displayName: string | null;
  state: string;
  loginStateVersion: number | null;
}

export interface OutreachBatchViewContext {
  account?: OutreachBatchAccountViewContext | null;
  candidates?: readonly OutreachBatchCandidateViewContext[];
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
      candidate.displayName.trim()
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
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

function renderError(value: string): string {
  const normalized = value.trim();
  const friendly = errorLabel[normalized]
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

function hasCurrentCommentReceipt(
  state: OutreachBatchState,
  candidate: BatchCandidate
) {
  const batch = state.batch;
  if (!batch || batch.state !== "approved" || !batch.approvalHash) return null;
  return state.actions.find((action) => action.kind === "comment"
    && action.batchId === batch.id
    && action.candidateId === candidate.candidateId
    && action.batchRevision === batch.revision
    && action.contentHash === candidate.commentHash
    && action.approvalHash === batch.approvalHash
    && action.status === "succeeded"
    && Boolean(action.platformReceiptReference?.trim())) ?? null;
}

function directMessageActionFor(
  state: OutreachBatchState,
  candidateId: string
) {
  return state.actions.find((action) => action.kind === "direct_message"
    && action.candidateId === candidateId) ?? null;
}

export function renderOutreachBatchView(
  host: HTMLElement,
  state: OutreachBatchState,
  context: OutreachBatchViewContext = {}
): void {
  const batch = state.batch;
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
  const directMessageCandidates = batch?.candidates.filter((candidate) =>
    candidate.selected
    && hasCurrentCommentReceipt(state, candidate)
    && !directMessageActionFor(state, candidate.candidateId)) ?? [];
  const directMessageDailyLimit = state.directMessageDailyLimit ?? 20;
  const directMessageConfirmed = state.directMessageConfirmed ?? false;
  const directMessageApprovalPhase = state.directMessageApprovalPhase ?? "idle";
  const directMessagePendingCandidateIds = state.directMessagePendingCandidateIds
    ?? [];
  const directMessageLimitValid = Number.isInteger(
    directMessageDailyLimit
  ) && directMessageDailyLimit >= 1
    && directMessageDailyLimit <= 100;
  const directMessagesValid = directMessageCandidates.every((candidate) => {
    const value = draftFor(state, candidate).directMessage;
    return value.trim().length >= 1 && value.length <= 800;
  });
  const directMessageCountFits = directMessageLimitValid
    && directMessageCandidates.length <= directMessageDailyLimit;
  const directMessageApprovalBusy = directMessageApprovalPhase !== "idle";
  const directMessageApprovalContextReady = accountMatchesBatch
    && directMessageCandidates.length > 0
    && !busy
    && !directMessageApprovalBusy;
  const directMessageApprovalReady = directMessageApprovalContextReady
    && directMessageCountFits
    && directMessagesValid;
  host.innerHTML = `<section class="douyin-panel outreach-workspace" aria-label="批次审批与执行回执">
    <div class="douyin-panel-title"><span class="douyin-step">05</span><div><h3>人工审批与执行时间线</h3><p>公开评论与真实私信分两次确认；每次只授权页面中明确列出的动作。</p></div></div>
    ${state.error ? renderError(state.error) : ""}
    ${state.conflict ? `<p class="douyin-conflict" role="status">批次已更新为最新修订，请重新检查精确文案后再确认。</p>` : ""}
    ${!batch ? `<div class="douyin-empty"><strong>选择候选人后生成待审批批次</strong><p>批次会冻结证据、模型来源与当日限额。</p></div>` : `<div class="outreach-summary"><div><span>批次状态</span><strong>${escape(batchState[batch.state] ?? batch.state)}</strong></div><div><span>选中候选人</span><strong>${batch.candidates.filter((candidate) => candidate.selected).length}</strong></div><div><span>今日剩余限额</span><strong>${batch.dailyRemainingLimit} / ${batch.dailyCandidateLimit}</strong></div><div><span>预计最短时长</span><strong>${Math.ceil(batch.candidates.filter((candidate) => candidate.selected).length * 4)} 分钟</strong></div></div>
      <section class="outreach-account-review" aria-label="本批次发送账号"><div><span>本批次发送账号</span><strong>${escape(accountReviewLabel)}</strong></div><div><span>账号标识</span><code>${escape(batch.accountId)}</code></div><div><span>登录状态版本</span><strong>v${batch.accountLoginStateVersion}</strong></div></section>
      ${batch.state === "awaiting_approval" && !reviewContextReady ? `<div class="outreach-review-blocker" role="status"><strong>暂不能最终确认</strong><p>${accountMatchesBatch ? "批次中的公开评论目标或候选人公开主页不完整，请刷新批次后重试。" : context.account && !accountHasBoundIdentity ? "当前抖音连接没有可核对的真实账号名称，请重新扫码连接后再生成审批批次。" : "请先恢复与本批次账号标识、登录版本完全一致的有效抖音连接。"}</p></div>` : ""}
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
        const commentReceipt = hasCurrentCommentReceipt(state, candidate);
        const directMessageAction = directMessageActionFor(
          state,
          candidate.candidateId
        );
        const historicalDirectMessage = directMessageAction
          && directMessageAction.authorizationVersion !== 2;
        const directMessageDirty = draft.directMessage !== candidate.directMessage;
        const pendingForCandidate = directMessagePendingCandidateIds
          .includes(candidate.candidateId);
        const showDirtyHint = batch.state === "approved"
          ? directMessageDirty && !directMessageAction && !pendingForCandidate
          : dirty;
        const directMessageState = historicalDirectMessage
          ? "historical"
          : directMessageAction
            ? directMessageAction.status
            : pendingForCandidate
              ? directMessageApprovalPhase
              : commentReceipt && accountMatchesBatch
                ? directMessageDirty ? "dirty" : "editable"
                : "locked";
        const directMessageEditable = ["editable", "dirty"].includes(
          directMessageState
        ) && !busy;
        const directMessageValue = directMessageAction?.content
          ?? draft.directMessage;
        const directMessageStatus = historicalDirectMessage
          ? "这是历史私信动作，仅保留只读记录；服务器不会领取或发送这条私信。"
          : directMessageAction
            ? `真实私信${actionState[directMessageAction.status] ?? directMessageAction.status}，以服务器动作回执为准。`
            : directMessageState === "approving"
              ? "正在提交私信授权，请勿重复操作。"
              : directMessageState === "pending"
                ? "授权已提交，正在等待服务器私信动作。"
                : commentReceipt
                  ? accountMatchesBatch
                    ? directMessageDirty
                      ? localDirectMessageDirtyCopy
                      : `评论成功回执：${commentReceipt.platformReceiptReference}`
                    : "请恢复与本批次完全一致的抖音账号后再复核私信。"
                  : batch.state === "awaiting_approval"
                    ? "私信尚未解锁。第一次确认仅排队公开评论；评论成功后可再独立复核并确认私信。"
                    : "等待本候选人的公开评论成功回执，当前不会发送私信。";
        return `<article class="outreach-editor"><header><span>${String(index + 1).padStart(2, "0")}</span><div><h4>${escape(candidateContext?.displayName?.trim() || `候选人 ${index + 1}`)}</h4><p>文案修订 ${candidate.draftRevision}（来源模型保持不变）</p></div></header><div class="outreach-target"><span>本次公开评论目标</span>${target ? `<a data-outreach-target="${escape(candidate.candidateId)}" href="${escape(target)}" target="_blank" rel="noopener noreferrer">打开抖音目标视频</a><code>${escape(target)}</code>` : `<p>批次缺少可验证的精确抖音视频，不能最终确认。</p>`}<span>候选人公开主页（只读）</span>${profile ? `<a data-outreach-profile="${escape(candidate.candidateId)}" href="${escape(profile)}" target="_blank" rel="noopener noreferrer">打开抖音公开主页</a><code>${escape(profile)}</code>` : `<p>批次缺少可验证的精确抖音主页，不能最终确认。</p>`}</div><label><span>精确公开评论 <em data-outreach-counter="${escape(candidate.candidateId)}:comment">${draft.comment.length} / 300</em></span><textarea data-outreach-index="${index}" data-outreach-candidate-id="${escape(candidate.candidateId)}" data-outreach-field="comment" rows="3" maxlength="300" ${editorDisabled ? "disabled" : ""}>${escape(draft.comment)}</textarea></label><fieldset class="outreach-direct-message-review is-${escape(directMessageState)}" data-outreach-direct-message-state="${escape(directMessageState)}" ${directMessageEditable ? "" : "disabled"}><legend>真实私信复核</legend>${profile ? `<div class="outreach-direct-message-target"><span>本次真实私信目标</span><a data-outreach-direct-message-target="${escape(candidate.candidateId)}" href="${escape(profile)}" target="_blank" rel="noopener noreferrer">打开候选人抖音公开主页</a><code>${escape(profile)}</code></div>` : ""}<label><span>精确私信 <em data-outreach-counter="${escape(candidate.candidateId)}:directMessage">${directMessageValue.length} / 800</em></span><textarea data-outreach-index="${index}" data-outreach-candidate-id="${escape(candidate.candidateId)}" data-outreach-field="directMessage" rows="4" maxlength="800" ${directMessageEditable ? "" : "disabled aria-disabled=\"true\" readonly"}>${escape(directMessageValue)}</textarea></label><small class="outreach-direct-message-status">${escape(directMessageStatus)}</small></fieldset><small>已绑定 ${candidate.evidenceHashes.length} 条证据 · 需要人工复核</small><p class="outreach-dirty" data-outreach-dirty="${escape(candidate.candidateId)}" ${showDirtyHint ? "" : "hidden"}>${escape(batch.state === "approved" ? localDirectMessageDirtyCopy : "草稿尚未保存；保存新修订后才能最终确认。")}</p></article>`;
      }).join("")}</div>
      ${batch.state === "approved" && (directMessageCandidates.length > 0 || directMessageApprovalBusy) ? `<fieldset class="outreach-direct-message-approval" data-outreach-direct-message-approval><legend>真实私信独立确认</legend><div class="outreach-direct-message-approval-copy"><strong>${directMessageApprovalPhase === "approving" ? "正在提交私信授权" : directMessageApprovalPhase === "pending" ? "等待服务器私信动作" : "评论成功后，再确认真实私信"}</strong><p>本次包含 ${directMessageCandidates.length} 位具备当前评论成功回执的候选人；不会自动截断名单。</p>${!directMessageCountFits ? `<p class="outreach-direct-message-limit-error" role="status">当前 ${directMessageCandidates.length} 位候选人超过每日上限，请提高上限或稍后重新生成批次。</p>` : ""}</div><label class="outreach-direct-message-limit"><span>每日真实私信上限</span><input type="number" min="1" max="100" step="1" value="${escape(String(directMessageDailyLimit))}" data-outreach-direct-message-limit ${directMessageApprovalBusy ? "disabled" : ""}></label><label class="outreach-confirm"><input type="checkbox" data-outreach-direct-message-confirm data-outreach-direct-message-context-ready="${directMessageApprovalContextReady}" data-outreach-direct-message-ready="${directMessageApprovalReady}" ${directMessageConfirmed ? "checked" : ""} ${directMessageApprovalReady ? "" : "disabled"}> 我已核对候选人公开主页与精确私信，并单独授权排队执行</label><div class="douyin-actions"><button type="button" class="primary" data-outreach-action="approve-direct-messages" ${directMessageConfirmed && directMessageApprovalReady ? "" : "disabled"}>确认并排队真实私信</button></div></fieldset>` : ""}
      <div class="outreach-approval-bar">${batch.state === "awaiting_approval" ? `<div class="outreach-approval-copy"><strong>这是第一次真实平台操作确认</strong><p>确认后服务器只会排队执行本批次真实评论；不会同时授权或发送私信。</p><label class="outreach-confirm"><input type="checkbox" data-outreach-confirm data-outreach-review-ready="${reviewContextReady}" ${busy || hasDirtyDraft || !reviewContextReady ? "disabled" : ""}> 我已核对发送账号、目标视频与精确评论，并授权排队执行</label></div><div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="save" ${busy ? "disabled" : ""}>保存为新修订</button><button type="button" class="primary" data-outreach-action="approve" disabled>确认并排队真实评论</button></div>` : `<div><strong>${escape(batchState[batch.state] ?? batch.state)}</strong><p>评论与私信均以服务器动作回执为准。</p></div><div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="${batch.state === "paused" ? "resume" : "pause"}" ${busy ? "disabled" : ""}>${batch.state === "paused" ? "恢复批次" : "暂停批次"}</button><button type="button" class="secondary" data-outreach-action="refresh" ${busy ? "disabled" : ""}>刷新回执</button></div>`}</div>
      <div class="outreach-timeline" aria-live="polite"><h4>动作回执</h4>${state.actions.length ? state.actions.map((action) => {
        const failure = action.failureCode
          ? failureLabel[action.failureCode] ?? "平台动作安全失败"
          : null;
        const historicalDirectMessage = action.kind === "direct_message"
          && action.authorizationVersion !== 2;
        const receiptNeedsConfirmation = action.failureCode
          === "douyin_action_receipt_ambiguous";
        const kindLabel = historicalDirectMessage
          ? "历史私信（只读）"
          : action.kind === "direct_message"
            ? "真实私信"
            : actionLabel[action.kind] ?? action.kind;
        const stateLabel = receiptNeedsConfirmation
          ? "结果待确认"
          : historicalDirectMessage
          ? (["succeeded", "failed"].includes(action.status)
              ? `历史${actionState[action.status] ?? action.status}` : "已停用")
          : actionState[action.status] ?? action.status;
        return `<article class="outreach-action is-${action.status}"><span>${action.sequence}</span><div><strong>${escape(kindLabel)} · ${escape(stateLabel)}</strong><p>${action.platformReceiptReference ? `平台回执：${escape(action.platformReceiptReference)}` : failure ? `运行提示：${escape(failure)}` : historicalDirectMessage ? "服务器不会领取或发送这条私信。" : "等待服务器状态更新"}</p><a class="outreach-action-target" href="${escape(action.targetPublicUrl)}" target="_blank" rel="noopener noreferrer">查看本动作目标</a>${action.failureCode ? technicalDetail(action.failureCode) : ""}<small>尝试 ${action.attemptCount ?? 0} 次${action.occurredAt ? ` · ${escape(new Date(action.occurredAt).toLocaleString("zh-CN", { hour12: false }))}` : ""}</small>${action.status === "risk_paused" && reconcilableFailure(action.failureCode) && !historicalDirectMessage ? `<div class="outreach-reconciliation"><label><input type="checkbox" data-outreach-reconcile-confirm="${escape(action.id)}" ${busy ? "disabled" : ""}> 我已在抖音页面核实该动作的本人回执</label><button type="button" class="secondary" data-outreach-action="reconcile" data-outreach-action-id="${escape(action.id)}" disabled>只读核验平台回执</button><p>仅检查已有回执，不会重新评论或私信；无法唯一证明时继续冻结。</p></div>` : ""}</div></article>`;
      }).join("") : `<p>审批后将显示真实评论的服务器回执；只有评论成功后经第二次确认，才会创建真实私信动作。</p>`}</div>`}
  </section>`;
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
      syncDirectMessageApprovalControls();
      return;
    }
    const target = event.target as HTMLTextAreaElement | null;
    if (!target) return;
    const candidate = controller.getState().batch?.candidates[
      Number(target.dataset.outreachIndex)
    ];
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
        syncDirectMessageApprovalControls();
        const directMessageDirty = target.value !== candidate.directMessage;
        const fieldset = target.closest<HTMLFieldSetElement>(
          "[data-outreach-direct-message-state]"
        );
        if (fieldset) {
          fieldset.dataset.outreachDirectMessageState = directMessageDirty
            ? "dirty"
            : "editable";
          fieldset.classList.toggle("is-dirty", directMessageDirty);
          fieldset.classList.toggle("is-editable", !directMessageDirty);
          const status = fieldset.querySelector<HTMLElement>(
            ".outreach-direct-message-status"
          );
          const receipt = hasCurrentCommentReceipt(nextState, candidate)
            ?.platformReceiptReference;
          if (status) status.textContent = directMessageDirty
            ? localDirectMessageDirtyCopy
            : receipt
              ? `评论成功回执：${receipt}`
              : "等待本候选人的公开评论成功回执，当前不会发送私信。";
        }
      }
    }
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
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
    host.querySelector<HTMLElement>("[role=alert]")?.focus();
  });
  const refreshContext = () => {
    const next = options.context?.() ?? {};
    const nextFingerprint = contextFingerprint(next, state);
    if (nextFingerprint === renderedContextFingerprint) return;
    context = next;
    renderedContextFingerprint = nextFingerprint;
    render();
  };
  const unsubscribeContext = options.subscribeContext?.(refreshContext)
    ?? (() => undefined);
  const unbind = bindOutreachBatchActions(host, controller);
  return () => {
    unsubscribe();
    unsubscribeContext();
    unbind();
  };
}
