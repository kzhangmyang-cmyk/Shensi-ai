import type { OutreachBatchController, OutreachBatchState } from "./outreach-batch-controller";

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const actionLabel: Record<string, string> = { comment: "公开评论", direct_message: "私信" };
const actionState: Record<string, string> = { queued: "已排队", blocked_by_predecessor: "等待评论回执", executing: "执行中", succeeded: "已送达", failed: "执行失败", risk_paused: "风险暂停" };
const reconcilableFailure = (value: string | null) => [
  "action_unavailable", "douyin_action_timeout",
  "douyin_action_receipt_ambiguous"
].includes(value ?? "");

export function renderOutreachBatchView(host: HTMLElement, state: OutreachBatchState): void {
  const batch = state.batch;
  const busy = ["loading", "saving", "approving"].includes(state.phase);
  const editorDisabled = busy || batch?.state !== "awaiting_approval";
  host.innerHTML = `<section class="douyin-panel outreach-workspace" aria-label="批次审批与执行回执">
    <div class="douyin-panel-title"><span class="douyin-step">05</span><div><h3>人工审批与执行时间线</h3><p>审批前可编辑精确评论与私信；审批本身不会在浏览器中执行抖音动作。</p></div></div>
    ${state.error ? `<div class="douyin-alert" role="alert" tabindex="-1">${escape(state.error)}</div>` : ""}
    ${state.conflict ? `<p class="douyin-conflict" role="status">修订冲突已刷新，请重新检查精确文案。</p>` : ""}
    ${!batch ? `<div class="douyin-empty"><strong>选择候选人后生成待审批批次</strong><p>批次会冻结证据、模型来源与当日限额。</p></div>` : `<div class="outreach-summary"><div><span>批次状态</span><strong>${escape(batch.state)}</strong></div><div><span>选中候选人</span><strong>${batch.candidates.filter((candidate) => candidate.selected).length}</strong></div><div><span>今日剩余限额</span><strong>${batch.dailyRemainingLimit} / ${batch.dailyCandidateLimit}</strong></div><div><span>预计最短时长</span><strong>${Math.ceil(batch.candidates.filter((candidate) => candidate.selected).length * 4)} 分钟</strong></div></div>
      <div class="outreach-editor-list">${batch.candidates.map((candidate, index) => `<article class="outreach-editor"><header><span>${String(index + 1).padStart(2, "0")}</span><div><h4>候选人 ${index + 1}</h4><p>文案修订 ${candidate.draftRevision}（来源模型保持不变）</p></div></header><label><span>精确公开评论</span><textarea data-outreach-index="${index}" data-outreach-field="comment" rows="3" ${editorDisabled ? "disabled" : ""}>${escape(state.drafts[candidate.candidateId]?.comment ?? candidate.comment)}</textarea></label><label><span>精确私信</span><textarea data-outreach-index="${index}" data-outreach-field="directMessage" rows="4" ${editorDisabled ? "disabled" : ""}>${escape(state.drafts[candidate.candidateId]?.directMessage ?? candidate.directMessage)}</textarea></label><small>已绑定 ${candidate.evidenceHashes.length} 条证据 · 需要人工复核</small></article>`).join("")}</div>
      <div class="outreach-approval-bar">${batch.state === "awaiting_approval" ? `<label class="outreach-confirm"><input type="checkbox" data-outreach-confirm ${busy ? "disabled" : ""}> 我已逐条核对评论、私信与剩余限额</label><div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="save" ${busy ? "disabled" : ""}>保存为新修订</button><button type="button" class="primary" data-outreach-action="approve" disabled>确认审批并排队</button></div>` : `<div class="douyin-actions"><button type="button" class="secondary" data-outreach-action="${batch.state === "paused" ? "resume" : "pause"}" ${busy ? "disabled" : ""}>${batch.state === "paused" ? "恢复批次" : "暂停批次"}</button><button type="button" class="secondary" data-outreach-action="refresh" ${busy ? "disabled" : ""}>刷新回执</button></div>`}</div>
      <div class="outreach-timeline" aria-live="polite"><h4>动作回执</h4>${state.actions.length ? state.actions.map((action) => `<article class="outreach-action is-${action.status}"><span>${action.sequence}</span><div><strong>${escape(actionLabel[action.kind] ?? action.kind)} · ${escape(actionState[action.status] ?? action.status)}</strong><p>${action.platformReceiptReference ? `平台回执：${escape(action.platformReceiptReference)}` : action.failureCode ? `安全失败：${escape(action.failureCode)}` : "等待服务器状态更新"}</p><small>尝试 ${action.attemptCount} 次${action.occurredAt ? ` · ${escape(new Date(action.occurredAt).toLocaleString("zh-CN", { hour12: false }))}` : ""}</small>${action.status === "risk_paused" && reconcilableFailure(action.failureCode) ? `<div class="outreach-reconciliation"><label><input type="checkbox" data-outreach-reconcile-confirm="${escape(action.id)}" ${busy ? "disabled" : ""}> 我已在抖音页面核实该动作的本人回执</label><button type="button" class="secondary" data-outreach-action="reconcile" data-outreach-action-id="${escape(action.id)}" disabled>只读核验平台回执</button><p>仅检查已有回执，不会重新评论或私信；无法唯一证明时继续冻结。</p></div>` : ""}</div></article>`).join("") : `<p>审批后将显示评论→等待→私信的服务器回执。</p>`}</div>`}
  </section>`;
}

export function bindOutreachBatchActions(
  eventRoot: HTMLElement,
  controller: OutreachBatchController
): () => void {
  const input = (event: Event) => {
    const target = event.target as HTMLTextAreaElement | null;
    if (!target) return;
    const candidate = controller.getState().batch?.candidates[
      Number(target.dataset.outreachIndex)
    ];
    const field = target.dataset.outreachField;
    if (candidate && (field === "comment" || field === "directMessage")) {
      controller.editMessage(candidate.candidateId, field, target.value);
      const confirmation = eventRoot.querySelector<HTMLInputElement>(
        "[data-outreach-confirm]"
      );
      if (confirmation) confirmation.checked = false;
      const approve = eventRoot.querySelector<HTMLButtonElement>(
        "[data-outreach-action=approve]"
      );
      if (approve) approve.disabled = true;
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
    if (!target?.matches("[data-outreach-confirm]")) return;
    const button = eventRoot.querySelector<HTMLButtonElement>(
      "[data-outreach-action=approve]"
    );
    const state = controller.getState();
    const dirty = Boolean(state.batch?.candidates.some((candidate) => {
      const draft = state.drafts[candidate.candidateId];
      return draft && (draft.comment !== candidate.comment
        || draft.directMessage !== candidate.directMessage);
    }));
    if (button) button.disabled = !target.checked || dirty
      || ["loading", "saving", "approving"].includes(state.phase);
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-outreach-action]"
    );
    if (!target || !eventRoot.contains(target)) return;
    if (["loading", "saving", "approving"].includes(
      controller.getState().phase
    )) return;
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

export function mountOutreachBatchView(host: HTMLElement, controller: OutreachBatchController): () => void {
  const unsubscribe = controller.subscribe((state) => {
    renderOutreachBatchView(host, state);
    host.querySelector<HTMLElement>("[role=alert]")?.focus();
  });
  const unbind = bindOutreachBatchActions(host, controller);
  return () => {
    unsubscribe();
    unbind();
  };
}
