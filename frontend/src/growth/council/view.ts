import type { components } from "../../generated/growth-advisor-quote-roi";
import type { FinancialCouncilControllerState } from "./controller";
import { BUSINESS_AGENT_TEAM } from "../agents/agents";
import { renderReportBody } from "./report";

type PortfolioKind = "balanced" | "cash_first" | "growth_first";
type Portfolio = components["schemas"]["FinancialCouncilRun_ActionPortfolio"];
type Action = components["schemas"]["FinancialCouncilRun_CandidateAction"];
type Finding = components["schemas"]["FinancialCouncilRun_FinancialFinding"];
type EditOperation = components["schemas"]["FinancialCouncilRun_FinancialPortfolioEditOperation"];

const SPECIALISTS: ReadonlyArray<{ readonly role: Finding["agentRole"]; readonly label: string }> = [
  { role: "finance", label: "财务" },
  { role: "profit", label: "利润" },
  { role: "cost", label: "成本" },
  { role: "cashflow", label: "现金流" },
  { role: "tax", label: "税务" }
];

const PORTFOLIO_LABELS: Readonly<Record<PortfolioKind, string>> = {
  balanced: "均衡组合",
  cash_first: "现金优先组合",
  growth_first: "增长优先组合"
};

export interface FinancialCouncilViewOptions {
  readonly capabilities: readonly string[];
  readonly canCreate?: boolean;
  readonly packageReady?: boolean;
  readonly createBlockedReason?: string;
  readonly canExportPdf?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function businessDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(timestamp));
}

function councilStatus(value: string): string {
  const labels: Record<string, string> = {
    not_connected: "尚未运行",
    snapshot_frozen: "资料已冻结",
    running: "分析中",
    awaiting_approval: "待人工审批",
    approved: "已批准",
    rejected: "已拒绝",
    completed: "已完成",
    stale: "已过期",
    expired: "已失效",
    not_computable: "暂不可计算",
    analyzing: "专项分析中", auditing: "交叉审阅中", synthesizing: "CFO 汇总中",
    optimizing: "组合计算中", failed: "运行失败"
  };
  return labels[value] ?? value;
}

function formatMinor(value: number, currency: string): string {
  const digits = new Intl.NumberFormat("zh-CN", {
    style: "currency", currency, currencyDisplay: "code"
  }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency", currency, currencyDisplay: "code"
  }).format(value / 10 ** digits);
}

function actionLabel(kind: Action["kind"]): string {
  const labels: Record<Action["kind"], string> = {
    collect_receivable: "催收应收款",
    review_loss_product_pricing: "复核低毛利产品定价",
    reduce_cost_anomaly: "处理成本异常",
    prepare_cash_reserve_budget: "准备现金储备预算",
    complete_financial_data: "补全财务数据",
    schedule_tax_review: "安排税务复核"
  };
  return labels[kind];
}

function findPortfolio(
  state: FinancialCouncilControllerState
): Portfolio | null {
  const kind = state.selectedPortfolioKind;
  return kind && state.run
    ? state.run.portfolios.find((portfolio) => portfolio.kind === kind) ?? null
    : null;
}

function operationFor(
  state: FinancialCouncilControllerState,
  actionId: string
): Extract<EditOperation, { kind: "replace_action_parameters" }> | null {
  const operation = state.editDraft?.operations.find((item) =>
    item.kind === "replace_action_parameters" && item.actionId === actionId);
  return operation?.kind === "replace_action_parameters" ? operation : null;
}

function missingReportData(run: NonNullable<FinancialCouncilControllerState["run"]>): string[] {
  const report = run.businessReport;
  const gaps: string[] = [];
  if (!report.cashFlow) gaps.push("现金流明细缺失");
  if (!report.costDetail) gaps.push("成本明细缺失");
  if (!report.taxRisk) gaps.push("税务风险输入缺失");
  return gaps;
}

function findingList(findings: readonly Finding[]): string {
  if (findings.length === 0) return "<li>暂无服务端投影的结论。</li>";
  return findings.map((finding) => `<li>
    <strong>${escapeHtml(finding.conclusion)}</strong>
    <span>${escapeHtml(finding.severity)} · ${finding.confidenceBps} bps</span>
    <small>依据：${finding.evidenceRefs.map(ref => `${escapeHtml(ref.source)} / ${escapeHtml(ref.sourceId)}`).join("；") || "尚无可用依据"}</small>
    ${finding.missingData.length > 0
      ? `<span>数据缺口：${finding.missingData.map((gap) => escapeHtml(gap.description)).join("；")}</span>`
      : ""}
  </li>`).join("");
}

function specialistCards(state: FinancialCouncilControllerState): string {
  const findings = state.run?.consensusReport?.acceptedFindings ?? [];
  return SPECIALISTS.map(({ role, label }) => {
    const cardFindings = state.collaboration?.roles.find(item => item.role === role)?.findings
      ?? findings.filter((finding) => finding.agentRole === role);
    return `<section class="council-specialist-card" aria-labelledby="council-specialist-${role}">
      <h4 id="council-specialist-${role}">${label}专家</h4>
      <ul>${findingList(cardFindings)}</ul>
      ${role === "tax" ? `<p class="council-disclaimer">税务相关内容须由具备资质的专业人士复核，不构成税务意见。</p>` : ""}
    </section>`;
  }).join("");
}

function auditSection(state: FinancialCouncilControllerState): string {
  const report = state.run?.consensusReport;
  const conflicts = report?.unresolvedConflicts ?? [];
  const minority = report?.minorityFindings ?? [];
  const rejected = report?.rejectedFindings ?? [];
  return `<section class="council-section" aria-labelledby="council-audit-heading">
    <h3 id="council-audit-heading">审计与异议</h3>
    <ul>${(state.collaboration?.reviews ?? []).map(review => `<li><strong>${escapeHtml(BUSINESS_AGENT_TEAM.find(a => a.id === review.role)?.name ?? review.role)}</strong>
      · 第 ${review.round} 轮 · ${escapeHtml(({ pending: "待复议", upheld: "保留意见", revised: "已修订", withdrawn: "已撤回" })[review.state])}
      <p>${escapeHtml(review.summary)}</p><small>依据 ${escapeHtml(review.findingId)} ↔ ${escapeHtml(review.peerFindingId)}</small></li>`).join("")}</ul>
    <section><h4>未解决冲突</h4><ul>${conflicts.length > 0
      ? conflicts.map((conflict) => `<li>${escapeHtml(conflict.type)}：${escapeHtml(conflict.findingIds.join("、"))}</li>`).join("")
      : "<li>暂无未解决冲突。</li>"}</ul></section>
    <section><h4>复议保留</h4><ul>${minority.length > 0
      ? findingList(minority) : "<li>暂无少数意见。</li>"}</ul></section>
    <section><h4>被拒绝意见</h4><ul>${rejected.length > 0
      ? findingList(rejected) : "<li>暂无被拒绝意见。</li>"}</ul></section>
  </section>`;
}

function cfoSection(state: FinancialCouncilControllerState): string {
  const run = state.run!;
  const report = run.consensusReport;
  const gaps = [...(report?.dataGaps ?? [])];
  const missing = missingReportData(run);
  const unavailable: Partial<Record<typeof run.status, string>> = {
    failed: "本次分析失败，未生成 CFO 诊断。",
    not_computable: "资料不足，当前无法生成可计算的 CFO 诊断。请补全下方数据缺口。",
    stale: "资料已变更，本次诊断不再有效。请基于最新资料重新分析。",
    expired: "本次分析已失效，未生成可用的 CFO 诊断。",
    rejected: "本次分析已被拒绝，未生成可用的 CFO 诊断。",
    approved: "本次分析已批准，但尚无可展示的 CFO 诊断记录。"
  };
  return `<section class="council-section" aria-labelledby="council-cfo-heading">
    <h3 id="council-cfo-heading">CFO 诊断与数据缺口</h3>
    <p>${report ? escapeHtml(report.overallDiagnosis) : unavailable[run.status] ?? "诊断仍在生成中。"}</p>
    ${run.status === "not_computable" ? "<p class=\"council-status council-status-blocked\">当前结果不可计算。</p>" : ""}
    <h4>数据缺口</h4>
    <ul>${[
      ...gaps.map((gap) => `<li>${escapeHtml(gap.description)}（${escapeHtml(gap.code)}）</li>`),
      ...missing.map((gap) => `<li>${escapeHtml(gap)}</li>`)
    ].join("") || "<li>无服务端报告的数据缺口。</li>"}</ul>
  </section>`;
}

function progressSection(state: FinancialCouncilControllerState): string {
  const labels = { waiting: "等待中", running: "进行中", completed: "已完成", missing_data: "缺少资料", failed: "失败", degraded: "降级结果" };
  const phases = { analysis: "专项分析", review: "交叉审阅", synthesis: "CFO 汇总", run: "运行" };
  return `<section class="council-section" aria-labelledby="council-progress-heading">
    <h3 id="council-progress-heading">六角色进度</h3>
    <p>五专项依次分析 → 一轮交叉审阅 → CFO 汇总。税务意见需要人工复核；缺少依据的指标暂不可计算。</p>
    <div class="council-role-progress">${BUSINESS_AGENT_TEAM.map(agent => {
      const role = state.collaboration?.roles.find(item => item.role === agent.id);
      return `<article data-council-role="${agent.id}" data-role-state="${role?.state ?? "waiting"}">
        <img src="${agent.avatarSrc}" alt="" width="42" height="42"><h4>${agent.name}</h4>
        <p>${role ? labels[role.state] : "状态待同步"}</p><span>${role ? phases[role.phase] : "等待协作记录"}</span>
        <small>${escapeHtml(role?.message ?? "")}</small>
        ${role?.reasonCode ? `<small>${escapeHtml(role.reasonCode)}</small>` : ""}
      </article>`;
    }).join("")}</div>
    <details data-council-detail="timeline"><summary>协作时间线 · ${state.collaboration?.events.length ?? state.events?.items.length ?? 0} 条记录</summary>
      <ol class="council-timeline">${state.collaboration?.events.map(event => `<li><time>${escapeHtml(businessDateTime(event.occurredAt))}</time>
        <strong>${escapeHtml(BUSINESS_AGENT_TEAM.find(a => a.id === event.role)?.name ?? "委员会")} · ${phases[event.phase]} · ${labels[event.state]}</strong>
        <p>${escapeHtml(event.message)}</p><small>${event.findingIds.map(escapeHtml).join("、")}</small></li>`).join("")
        ?? state.events?.items.map(event => `<li>${escapeHtml(businessDateTime(event.occurredAt))} · ${escapeHtml(councilStatus(event.toStatus))}</li>`).join("") ?? ""}</ol>
    </details>
  </section>`;
}

function historySection(state: FinancialCouncilControllerState): string {
  return `<details class="council-history" data-council-detail="history"><summary>最近分析记录</summary>
    <ul>${state.history?.items.map(item => `<li><button type="button" data-council-action="open-history" data-run-id="${escapeHtml(item.runId)}" ${item.runId === state.run?.runId ? 'aria-current="true"' : ""}>
      ${escapeHtml(businessDateTime(item.createdAt))} · ${escapeHtml(councilStatus(item.status))}</button></li>`).join("") || "<li>暂无记录</li>"}</ul>
    ${state.history?.hasMore ? '<button type="button" data-council-action="more-history">加载更早记录</button>' : ""}</details>`;
}

function portfolioComparison(state: FinancialCouncilControllerState): string {
  const run = state.run!;
  const byKind = new Map(run.portfolios.map((portfolio) => [portfolio.kind, portfolio]));
  return `<section class="council-section" aria-labelledby="council-portfolios-heading">
    <h3 id="council-portfolios-heading">组合比较</h3>
    <fieldset class="council-portfolio-picker"><legend>选择组合</legend><div class="council-metric-grid">
      ${(Object.keys(PORTFOLIO_LABELS) as PortfolioKind[]).map((kind) => {
        const portfolio = byKind.get(kind);
        const selected = state.selectedPortfolioKind === kind;
        return `<label class="council-portfolio-option">
          <input type="radio" name="council-portfolio" value="${kind}"
            data-council-action="select-portfolio" ${selected ? "checked" : ""}
            ${portfolio ? "" : "disabled"}>
          <span><strong>${PORTFOLIO_LABELS[kind]}</strong>
          ${portfolio
            ? `目标 ${portfolio.objectiveScoreBps} bps · 版本 ${portfolio.revision}`
            : "服务端尚未提供可行组合"}</span>
        </label>`;
      }).join("")}
    </div></fieldset>
  </section>`;
}

function selectedDetail(state: FinancialCouncilControllerState): string {
  const portfolio = findPortfolio(state);
  if (!portfolio) return `<section class="council-section" aria-labelledby="council-selected-heading">
    <h3 id="council-selected-heading">已选组合详情</h3><p>请选择一个服务端投影的组合。</p></section>`;
  const money = (label: string, values: { conservative: number; base: number; optimistic: number }) =>
    `<li><strong>${label}</strong>：保守 ${formatMinor(values.conservative, state.run!.currency)}；基准 ${formatMinor(values.base, state.run!.currency)}；乐观 ${formatMinor(values.optimistic, state.run!.currency)}</li>`;
  return `<section class="council-section" aria-labelledby="council-selected-heading">
    <h3 id="council-selected-heading">已选组合详情</h3>
    <p>${PORTFOLIO_LABELS[portfolio.kind]} · 目标 ${portfolio.objectiveScoreBps} bps</p>
    <h4>服务端动作</h4><ul>${portfolio.actions.map((action) => `<li>
      <strong>${escapeHtml(actionLabel(action.kind))}</strong> · ${escapeHtml(action.explanation)}
      <span>负责人 ${escapeHtml(action.ownerRole)} · ${action.durationDays} 天</span>
    </li>`).join("") || "<li>该组合没有可执行动作。</li>"}</ul>
    <h4>服务端情景</h4><ul>
      ${money("现金影响", portfolio.scenarioForecast.cashImpact)}
      ${money("利润影响", portfolio.scenarioForecast.profitImpact)}
      <li><strong>风险降低</strong>：保守 ${portfolio.scenarioForecast.riskReductionBps.conservative} bps；基准 ${portfolio.scenarioForecast.riskReductionBps.base} bps；乐观 ${portfolio.scenarioForecast.riskReductionBps.optimistic} bps</li>
    </ul>
    <h4>敏感性</h4><ul>${portfolio.sensitivityAnalysis.map((row) => `<li>${escapeHtml(row.factor)}：${row.impactBps} bps</li>`).join("") || "<li>暂无敏感性结果。</li>"}</ul>
    <h4>未选动作及原因</h4><ul>${portfolio.rejectedActions.map((row) => `<li>${escapeHtml(row.actionId)}：${escapeHtml(row.reason)}</li>`).join("") || "<li>无。</li>"}</ul>
  </section>`;
}

function blockers(state: FinancialCouncilControllerState, options: FinancialCouncilViewOptions): string[] {
  const run = state.run;
  const portfolio = findPortfolio(state);
  if (!run || !portfolio) return ["请选择服务端投影的组合后再审批。"];
  const entries = portfolio.hardConstraints
    .filter((constraint) => !constraint.satisfied)
    .map((constraint) => constraint.reason ?? constraint.code);
  if (portfolio.actionIds.length === 0) entries.push("组合没有可执行动作。");
  const granted = new Set(options.capabilities);
  if (portfolio.requiredApprovalCapabilities.some((capability) => !granted.has(capability))) {
    entries.push("无权批准该组合。");
  }
  if (run.status === "stale" || run.status === "expired") {
    entries.push("该运行已过期或数据已失效。");
  }
  if (run.status === "not_computable") entries.push("当前结果不可计算。");
  if (run.status !== "awaiting_approval") entries.push(`当前状态 ${run.status} 不可审批。`);
  return entries;
}

function blockerSection(blockerReasons: readonly string[]): string {
  return `<section class="council-blockers" aria-labelledby="council-blockers-heading">
    <h3 id="council-blockers-heading">现金与合规阻塞项</h3>
    <ul>${blockerReasons.length > 0
      ? blockerReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")
      : "<li>服务端未投影现金或合规阻塞项。</li>"}</ul>
  </section>`;
}

function editSection(state: FinancialCouncilControllerState): string {
  const portfolio = findPortfolio(state);
  if (!portfolio || !state.run) return `<section class="council-section" aria-labelledby="council-edit-heading">
    <h3 id="council-edit-heading">编辑并重新优化</h3><p>选择组合后可编辑草稿。</p></section>`;
  return `<section class="council-section" aria-labelledby="council-edit-heading">
    <h3 id="council-edit-heading">编辑并重新优化</h3>
    <p>编辑只形成重新优化草稿；新 totals 仅在服务端返回新 revision 后显示。到期日不属于该合同，不能编辑或持久化。</p>
    <ul class="council-edit-list">${portfolio.actions.map((action) => {
      const replacement = operationFor(state, action.actionId);
      const owner = replacement?.parameters.ownerRole ?? action.ownerRole;
      const duration = replacement?.parameters.durationDays ?? action.durationDays;
      return `<li data-action-id="${escapeHtml(action.actionId)}">
        <strong>${escapeHtml(actionLabel(action.kind))}</strong>
        <label>负责人 <select data-council-action="replace-action-parameters" data-action-id="${escapeHtml(action.actionId)}" data-field="ownerRole">
          ${SPECIALISTS.map((specialist) => `<option value="${specialist.role}" ${owner === specialist.role ? "selected" : ""}>${specialist.label}</option>`).join("")}
        </select></label>
        <label>持续天数 <input type="number" min="0" step="1" value="${duration}" data-council-action="replace-action-parameters" data-action-id="${escapeHtml(action.actionId)}" data-field="durationDays"></label>
        <button type="button" data-council-action="remove-action" data-action-id="${escapeHtml(action.actionId)}">移除</button>
        <button type="button" data-council-action="restore-action" data-action-id="${escapeHtml(action.actionId)}">恢复</button>
      </li>`;
    }).join("")}</ul>
    <button type="button" data-council-action="revise" ${state.busy ? "disabled" : ""}>提交重新优化</button>
  </section>`;
}

function approvalSection(
  state: FinancialCouncilControllerState,
  blockerReasons: readonly string[]
): string {
  const disabled = blockerReasons.length > 0 || state.busy !== null || !state.run?.latestPortfolioRevision;
  return `<section class="council-section council-approval" aria-labelledby="council-approval-heading">
    <h3 id="council-approval-heading">人工审批</h3>
    <p>确认后只创建草稿和待办，不执行任何财务动作。</p>
    <label for="council-rejection-reason">拒绝理由</label>
    <textarea id="council-rejection-reason" data-council-rejection-reason rows="3"></textarea>
    <div class="council-button-row">
      <button type="button" data-council-action="approve" ${disabled ? "disabled" : ""}>批准并创建草稿/待办</button>
      <button type="button" data-council-action="reject" ${state.busy ? "disabled" : ""}>拒绝</button>
    </div>
  </section>`;
}

function dispatchSection(state: FinancialCouncilControllerState): string {
  const dispatches = state.dispatches?.items ?? [];
  return `<section class="council-section" aria-labelledby="council-dispatch-heading">
    <h3 id="council-dispatch-heading">派发回执</h3>
    <ul>${dispatches.map((dispatch) => `<li>
      ${escapeHtml(dispatch.actionId)} · ${escapeHtml(dispatch.status)}
      ${dispatch.receiptId ? `· 回执 ${escapeHtml(dispatch.receiptId)}` : ""}
      ${dispatch.lastErrorCode ? `· ${escapeHtml(dispatch.lastErrorCode)}` : ""}
    </li>`).join("") || "<li>审批后将显示服务端派发回执。</li>"}</ul>
  </section>`;
}

function reportExportSection(state: FinancialCouncilControllerState, canExportPdf = false): string {
  const available = Boolean(state.collaboration && state.run?.runId === state.collaboration.runId);
  return `<section class="council-section" aria-label="报告与导出"><h3>报告与导出</h3>
    <p>${available ? '导出当前已加载的报告；历史报告可在分析历史中打开。'
      : state.error ? '报告尚未加载成功，请重试或打开已有分析历史。' : '当前尚无已生成报告，请先分析资料，或在分析历史中打开已有报告。'}</p>
    <div class="council-button-row"><button type="button" data-council-action="download-html" ${available ? '' : 'disabled'}>下载 HTML 报告</button>
    <button type="button" data-council-action="download-pdf" ${available && canExportPdf ? '' : 'disabled'}>导出 PDF</button>
    ${!canExportPdf ? '<small>PDF 导出需在桌面应用中使用。</small>' : ''}<span data-council-export-feedback aria-live="polite"></span></div></section>`;
}

export function renderFinancialCouncilWorkbench(
  state: FinancialCouncilControllerState,
  options: FinancialCouncilViewOptions
): string {
  if (!state.run) {
    const message = state.error
      ? escapeHtml(state.error)
      : state.busy === "loading" ? "正在加载财务委员会运行…" : "";
    return `<section class="growth-panel council-workbench" aria-live="polite">
      <p class="sr-only">上传资产负债表、利润表和现金流量表，由 CFO 与五个专业角色生成可审批的经营组合。</p>
      <ol class="council-entry-steps" aria-label="财务委员会流程">
        <li class="active"><b aria-hidden="true">1</b><span>准备资料</span><i class="council-step-connector" aria-hidden="true"></i></li><li><b aria-hidden="true">2</b><span>专项分析</span><i class="council-step-connector" aria-hidden="true"></i></li><li><b aria-hidden="true">3</b><span>汇总审阅</span><i class="council-step-connector" aria-hidden="true"></i></li><li><b aria-hidden="true">4</b><span>确认建议</span></li>
      </ol>
      ${message ? `<p class="council-entry-status ${state.error ? "growth-error" : ""}">${message}</p>` : ""}
      ${reportExportSection(state, options.canExportPdf)}
      <div class="council-onboarding-grid">
        <div class="council-onboarding-main">
          <section class="council-preparation" aria-labelledby="council-preparation-title">
            <header><h3 id="council-preparation-title">正式三表专项分析（可选）</h3><p>通用企业资料可在上方直接分析并导出报告，无需凑齐三表。以下校验仅用于正式三表计算与经营组合。</p></header>
            <div class="council-preparation-table" role="table">
              <div class="head" role="row"><span>资料</span><span>状态</span><span>下一步</span></div>
            ${[["ph-file-xls", "资产负债表"], ["ph-chart-bar", "利润表"], ["ph-wave-sine", "现金流量表"]].map(([icon, label]) => `<div role="row"><span class="council-statement-name"><i class="ph ${icon}" aria-hidden="true"></i>${label}</span><span class="pending">● ${options.packageReady ? "已确认" : "待准备"}</span><a href="#agents">先到经营总管准备</a></div>`).join("")}
            </div>
            <div class="council-preparation-actions"><a class="growth-primary-link" href="#agents">打开经营总管</a><span>在经营总管完成资料导入、使用同意和模型设置。</span></div>
          </section>
          <section class="council-participants" aria-labelledby="council-participants-title"><h3 id="council-participants-title">参与角色</h3><div>
            ${[["ph-user", "经营总管"], ["ph-chart-pie-slice", "财务分析"], ["ph-trend-up", "利润分析"], ["ph-tag", "成本分析"], ["ph-money", "现金流分析"], ["ph-shield-check", "税务健康"]].map(([icon, label]) => `<article><i class="council-role-icon ph ${icon}" aria-hidden="true"></i><span>${label}<small>待分析</small></span></article>`).join("")}
          </div></section>
          ${historySection(state)}
        </div>
        <aside class="council-review" aria-label="本次审阅"><h3>本次审阅</h3><dl>
          <div><dt>工作区</dt><dd>当前工作区</dd></div><div><dt>资料状态</dt><dd class="pending">● 待准备</dd></div><div><dt>分析状态</dt><dd>● 未开始</dd></div><div><dt>人工确认</dt><dd class="pending">● 待分析</dd></div>
        </dl><p>完成分析后，你可以查看各角色的依据与建议。</p>
        ${options.canCreate ? `<span class="sr-only">完整报表不会显示在地址栏或页面正文中。</span>${options.packageReady ? "<p>已确认报表与模型已就绪。</p>" : '<label for="council-data-as-of">数据截至时间</label><input id="council-data-as-of" type="datetime-local" data-council-data-as-of required>'}<button type="button" data-council-action="create" ${state.busy ? "disabled" : ""}>开始三表专项分析</button><p data-council-create-feedback aria-live="polite"></p>` : `<button type="button" disabled><i class="ph ph-lock" aria-hidden="true"></i>开始三表专项分析</button><p>${escapeHtml(options.createBlockedReason ?? "请先确认三张报表并完成模型配置。")}</p><a class="growth-primary-link" href="#agents">补全分析资料与模型设置</a>`}
        ${state.error ? '<button type="button" data-council-action="retry">重新加载</button>' : ""}
        <details open><summary>查看资料要求</summary><div class="council-requirements">
          <p><b>资产负债表</b><br>需包含资产、负债、所有者权益各明细项目；提供最新一期及上年同期对比数据。</p>
          <p><b>利润表</b><br>需包含营业收入、成本、费用、利润等明细项目；提供最新一期及上年同期对比数据。</p>
          <p><b>现金流量表</b><br>需包含经营、投资、筹资活动现金流明细；提供最新一期及上年同期对比数据。</p>
          <p>正式三表导入支持Excel（.xlsx）；上方通用资料分析支持CSV、XLSX、文字PDF、DOCX，不要求三表齐全。币种按原始资料核对。</p>
        </div></details>
      </aside></div>
    </section>`;
  }
  const run = state.run;
  const blockerReasons = blockers(state, options);
  return `<main class="growth-panel council-workbench" aria-labelledby="council-title">
    <p class="council-live-region" aria-live="polite">${state.error ? escapeHtml(state.error) : state.busy ? "处理中…" : ""}</p>
    ${state.error ? '<button type="button" data-council-action="retry">重试未加载的信息</button>' : ""}
    ${historySection(state)}
    ${reportExportSection(state, options.canExportPdf)}
    <section class="council-section council-summary" aria-labelledby="council-title">
      <h2 id="council-title">财务委员会工作台</h2>
      ${options.canCreate && options.packageReady ? '<button type="button" data-council-action="create">使用已确认资料开始新分析</button>' : ""}
      <h3>运行摘要</h3>
      <p>状态 <strong>${escapeHtml(councilStatus(run.status))}</strong> · 数据截至 ${escapeHtml(businessDateTime(run.dataAsOf))} · 修订 ${run.revision}</p>
      ${run.status === "stale" ? "<p class=\"council-status council-status-blocked\">该运行已过期或数据已失效。</p>" : ""}
    </section>
    <div class="growth-command-strip council-command-strip" aria-label="财务委员会运行概览">
      <article><span>运行状态</span><strong>${escapeHtml(councilStatus(run.status))}</strong><small>修订 ${run.revision}</small></article>
      <article><span>候选组合</span><strong>${run.portfolios.length}</strong><small>平衡 / 现金 / 增长</small></article>
      <article><span>策略修订</span><strong>${run.latestPortfolioRevision ?? "—"}</strong><small>当前有效版本</small></article>
      <article><span>审批状态</span><strong>${run.approval ? escapeHtml(run.approval.status) : "待处理"}</strong><small>只创建草稿和待办</small></article>
    </div>
    ${state.collaboration && state.collaboration.revision !== run.revision ? `<p class="council-status" role="status">当前显示修订 ${state.collaboration.revision} 的协作记录与报告；运行已到修订 ${run.revision}，${state.collaborationUpdating ? "正在更新。" : '尚未同步。<button type="button" data-council-action="retry">重新同步</button>'}</p>` : ""}
    ${progressSection(state)}
    <section class="council-section" aria-labelledby="council-specialists-heading">
      <h3 id="council-specialists-heading">专家结论 · 原始分析</h3><p>各专项的首轮结论；复议后的修订与保留意见见下方审计与异议。</p><div class="council-specialist-grid">${specialistCards(state)}</div>
    </section>
    ${auditSection(state)}
    ${cfoSection(state)}
    ${state.collaboration ? `<section class="council-section">${renderReportBody(state.collaboration.report)}</section>` : ""}
    ${portfolioComparison(state)}
    ${selectedDetail(state)}
    ${blockerSection(blockerReasons)}
    ${editSection(state)}
    ${approvalSection(state, blockerReasons)}
    ${dispatchSection(state)}
  </main>`;
}
