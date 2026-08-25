import type { DouyinAutomationController, DouyinAutomationState } from "./douyin-automation-controller";
import type { DouyinPolicyInput, DouyinRunCandidate } from "./douyin-automation-api";

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const stateLabel: Record<string, string> = { awaiting_scan: "等待扫码", active: "已连接", login_expired: "登录已失效", risk_paused: "风险暂停", disconnected: "未连接" };
const runLabel: Record<string, string> = { scheduled: "已排期", queued: "排队中", running: "采集中", succeeded: "已完成", partial: "部分完成", paused: "已安全暂停", cancelled: "已取消", failed: "采集失败" };

function candidateKind(candidate: DouyinRunCandidate): string {
  return /comment/iu.test(candidate.status) ? "需求评论者" : /creator/iu.test(candidate.status) ? "内容创作者" : "公开候选人";
}

export function renderDouyinAutomationView(host: HTMLElement, state: DouyinAutomationState): void {
  const policy = state.policy;
  const account = state.account;
  const session = state.loginSession;
  const status = state.crawlerStatus;
  const selected = new Set(state.selectedCandidateIds);
  const inspector = state.candidates.find((candidate) => selected.has(candidate.id)) ?? state.candidates[0] ?? null;
  const keywordInputs = (policy?.keywords ?? []).map((keyword, index) => `<label class="douyin-keyword"><span class="sr-only">关键词 ${index + 1}</span><input data-douyin-keyword value="${escape(keyword)}" maxlength="100"><button type="button" data-douyin-action="remove-keyword" aria-label="删除关键词 ${escape(keyword)}">×</button></label>`).join("");
  host.innerHTML = `
    <section class="douyin-control-stack" aria-label="抖音自动获客控制台" data-phase="${state.phase}">
      <header class="douyin-control-hero">
        <div><span class="douyin-eyebrow">AUTOMATIC ACQUISITION</span><h2>抖音自动获客</h2><p>服务器定时采集公开内容，每个外联批次都需要人工确认。</p></div>
        <span class="douyin-live-pill ${account?.state === "active" ? "is-live" : ""}">${escape(account ? stateLabel[account.state] ?? account.state : "未连接")}</span>
      </header>
      ${state.error ? `<div class="douyin-alert" role="alert" tabindex="-1">${escape(state.error)}${state.phase === "error" ? `<button type="button" data-douyin-action="retry">重试</button>` : ""}</div>` : ""}
      <div class="douyin-setup-grid">
        <article class="douyin-panel douyin-account-card">
          <div class="douyin-panel-title"><span class="douyin-step">01</span><div><h3>抖音账号</h3><p>一个工作区连接一个专用账号</p></div></div>
          ${account ? `<div class="douyin-account-identity"><span class="douyin-account-mark">抖</span><div><strong>${escape(account.displayName ?? "已连接抖音账号")}</strong><span>状态：${escape(stateLabel[account.state] ?? account.state)}</span><small>最近校验 ${account.lastValidatedAt ? escape(new Date(account.lastValidatedAt).toLocaleString("zh-CN", { hour12: false })) : "待校验"}</small></div></div>` : `<div class="douyin-empty"><strong>连接抖音账号</strong><p>扫码后即可设置自动采集。凭据不会返回浏览器。</p></div>`}
          <div class="douyin-actions">${account && account.state === "active" ? `<button type="button" class="secondary" data-douyin-action="disconnect">断开连接</button>` : `<button type="button" class="primary" data-douyin-action="connect">${account ? "重新连接" : "扫码连接"}</button>`}</div>
        </article>
        <article class="douyin-panel douyin-policy-card">
          <div class="douyin-panel-title"><span class="douyin-step">02</span><div><h3>自动采集计划</h3><p>关键词、本地时间与每日上限均可编辑</p></div></div>
          <form data-douyin-policy-form>
            <div class="douyin-field-head"><label>可编辑关键词</label><button type="button" class="text-button" data-douyin-action="suggest" ${!policy ? "disabled" : ""}>智能生成</button></div>
            <div class="douyin-keywords" data-douyin-keywords>${keywordInputs}<label class="douyin-keyword is-new"><span class="sr-only">新关键词</span><input name="newKeyword" data-douyin-new-keyword placeholder="+添加关键词" maxlength="100"></label></div>
            <div class="douyin-form-grid">
              <label><span>每日时间</span><input name="localTime" type="time" value="${escape(policy?.schedule.localTime ?? "09:30")}" required></label>
              <label><span>时区</span><select name="timeZone"><option value="Asia/Shanghai" ${(policy?.schedule.timeZone ?? "Asia/Shanghai") === "Asia/Shanghai" ? "selected" : ""}>Asia/Shanghai (UTC+8)</option><option value="Asia/Hong_Kong" ${policy?.schedule.timeZone === "Asia/Hong_Kong" ? "selected" : ""}>Asia/Hong_Kong (UTC+8)</option><option value="UTC" ${policy?.schedule.timeZone === "UTC" ? "selected" : ""}>UTC</option></select></label>
              <label><span>每日候选人 <small>建议 50</small></span><input name="dailyCandidateLimit" type="number" min="1" max="200" value="${policy?.dailyCandidateLimit ?? 50}" required></label>
            </div>
            <div class="douyin-checks"><label><input name="scheduleEnabled" type="checkbox" ${policy?.schedule.enabled ? "checked" : ""}> 启用每日定时</label><label><input name="collectCreators" type="checkbox" ${policy?.collectCreators !== false ? "checked" : ""}> 采集创作者</label><label><input name="collectDemandComments" type="checkbox" ${policy?.collectDemandComments !== false ? "checked" : ""}> 采集需求评论</label></div>
            <div class="douyin-actions"><button type="submit" class="secondary" ${!policy || state.phase === "saving" ? "disabled" : ""}>保存并启用</button><button type="button" class="primary" data-douyin-action="run-now" ${!account || account.state !== "active" || !policy || state.phase === "running" ? "disabled" : ""}>立即运行</button></div>
          </form>
        </article>
      </div>
      <article class="douyin-panel douyin-run-panel">
        <div class="douyin-panel-title"><span class="douyin-step">03</span><div><h3>实时采集</h3><p>${status ? escape(runLabel[status.state] ?? status.state) : "保存计划后可立即运行"}</p></div></div>
        ${status ? `<div class="douyin-run-metrics"><div><span>公开记录</span><strong>${status.recordCount}</strong></div><div><span>已发现候选人</span><strong>${status.candidateBudgetUsed}</strong></div><div><span>每日预算</span><strong>${status.candidateBudgetLimit}</strong></div><div><span>采集进度</span><strong>${Math.min(100, Math.round(status.candidateBudgetUsed / Math.max(1, status.candidateBudgetLimit) * 100))}%</strong></div></div>${status.lastErrorCode ? `<p class="douyin-safe-reason" role="status">安全暂停原因：${escape(status.lastErrorCode)}</p>` : ""}` : `<div class="douyin-empty"><strong>暂无采集运行</strong><p>系统不会用演示数据替代服务器状态。</p></div>`}
      </article>
      <article class="douyin-panel douyin-candidates-panel">
        <div class="douyin-panel-title"><span class="douyin-step">04</span><div><h3>候选人与证据</h3><p>选中后生成待审批批次；取消选中即排除，不执行联系。</p></div></div>
        ${state.candidates.length ? `<div class="douyin-candidate-workspace"><div class="douyin-candidate-table" role="listbox" aria-label="候选人列表">${state.candidates.map((candidate, index) => `<label class="douyin-candidate-row ${inspector?.id === candidate.id ? "is-active" : ""}" role="option" aria-selected="${selected.has(candidate.id)}" tabindex="${index === 0 ? 0 : -1}" data-candidate-index="${index}"><input type="checkbox" data-douyin-candidate data-candidate-index="${index}" ${selected.has(candidate.id) ? "checked" : ""}><span class="douyin-candidate-kind">${candidateKind(candidate)}</span><strong>${escape(candidate.displayName)}</strong><span>${escape(candidate.evidence.excerpt.slice(0, 70))}</span><em>${selected.has(candidate.id) ? "已选中" : "排除本批次"}</em></label>`).join("")}</div>${inspector ? `<aside class="douyin-evidence-inspector" aria-label="证据查看器"><span class="douyin-eyebrow">EVIDENCE</span><h4>${escape(inspector.displayName)}</h4><p>${escape(inspector.evidence.excerpt)}</p><a href="${escape(inspector.evidence.sourceUrl)}" target="_blank" rel="noreferrer">查看公开来源</a><small>仅展示服务器保存的公开证据摘要；永久不联系身份已由服务器过滤。</small></aside>` : ""}</div><div class="douyin-actions"><span>已选 ${state.selectedCandidateIds.length} 人</span><button type="button" class="primary" data-douyin-action="create-batch" ${state.selectedCandidateIds.length === 0 ? "disabled" : ""}>生成待审批批次</button></div>` : `<div class="douyin-empty"><strong>${status?.state === "running" ? "正在发现候选人" : "暂无候选人"}</strong><p>${status?.state === "partial" ? "本次为部分结果，已保留可用公开证据。" : "运行自动采集后，创作者与需求评论者将显示在这里。"}</p></div>`}
      </article>
      ${session ? `<dialog class="douyin-qr-dialog" open aria-labelledby="douyinQrTitle"><div><span class="douyin-eyebrow">SECURE QR LOGIN</span><h3 id="douyinQrTitle">${session.state === "awaiting_scan" ? "请使用抖音扫码" : session.state === "active" ? "账号已连接" : "二维码已过期"}</h3>${session.qrImageDataUrl ? `<img src="${escape(session.qrImageDataUrl)}" alt="抖音登录二维码">` : ""}<p>${session.state === "awaiting_scan" ? `二维码有效至 ${escape(new Date(session.expiresAt).toLocaleTimeString("zh-CN", { hour12: false }))}` : escape(stateLabel[session.state] ?? session.state)}</p><div class="douyin-actions">${session.state === "login_expired" ? `<button type="button" class="primary" data-douyin-action="connect">重新生成</button>` : ""}<button type="button" class="secondary" data-douyin-action="close-qr">关闭</button></div></div></dialog>` : ""}
    </section>`;
}

export function mountDouyinAutomationView(host: HTMLElement, controller: DouyinAutomationController, onCreateBatch: (runId: string, candidateIds: string[]) => void): () => void {
  let state = controller.getState();
  const unsubscribe = controller.subscribe((next) => { state = next; renderDouyinAutomationView(host, state); host.querySelector<HTMLElement>("[role=alert]")?.focus(); });
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-douyin-action]"); if (!target) return;
    const action = target.dataset.douyinAction;
    if (action === "connect") void controller.connect();
    else if (action === "disconnect") void controller.disconnect();
    else if (action === "suggest") void controller.suggestKeywords();
    else if (action === "run-now") void controller.runNow();
    else if (action === "retry" && state.planId) void controller.load(state.planId);
    else if (action === "close-qr") { host.querySelector<HTMLDialogElement>(".douyin-qr-dialog")?.close(); host.querySelector<HTMLElement>("[data-douyin-action=connect]")?.focus(); }
    else if (action === "remove-keyword") target.closest(".douyin-keyword")?.remove();
    else if (action === "create-batch" && state.runIntent) onCreateBatch(state.runIntent.acquisitionRunId, state.selectedCandidateIds);
  };
  const change = (event: Event) => { const target = event.target as HTMLInputElement | null; if (!target?.matches("[data-douyin-candidate]")) return; const candidate = state.candidates[Number(target.dataset.candidateIndex)]; if (candidate) controller.toggleCandidate(candidate.id); };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement; if (!form.matches("[data-douyin-policy-form]") || !state.policy) return; event.preventDefault();
    const data = new FormData(form); const newKeyword = String(data.get("newKeyword") ?? "").trim();
    const keywordInputs = [...form.querySelectorAll<HTMLInputElement>("[data-douyin-keyword]")].map((input) => input.value.trim()).filter(Boolean);
    const input: DouyinPolicyInput = { keywords: [...new Set([...keywordInputs, ...(newKeyword ? [newKeyword] : [])])], schedule: { enabled: data.get("scheduleEnabled") === "on", localTime: String(data.get("localTime")), timeZone: String(data.get("timeZone")) }, dailyCandidateLimit: Number(data.get("dailyCandidateLimit")), collectCreators: data.get("collectCreators") === "on", collectDemandComments: data.get("collectDemandComments") === "on", limits: { ...state.policy.limits } };
    void controller.savePolicy(input);
  };
  const keydown = (event: KeyboardEvent) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".douyin-candidate-row"); if (!row || !["ArrowDown", "ArrowUp", " "].includes(event.key)) return; event.preventDefault();
    if (event.key === " ") { const candidate = state.candidates[Number(row.dataset.candidateIndex)]; if (candidate) controller.toggleCandidate(candidate.id); return; }
    const rows = [...host.querySelectorAll<HTMLElement>(".douyin-candidate-row")]; const index = rows.indexOf(row); const next = rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]; next?.focus();
  };
  host.addEventListener("click", click); host.addEventListener("change", change); host.addEventListener("submit", submit); host.addEventListener("keydown", keydown);
  return () => { unsubscribe(); host.removeEventListener("click", click); host.removeEventListener("change", change); host.removeEventListener("submit", submit); host.removeEventListener("keydown", keydown); };
}
