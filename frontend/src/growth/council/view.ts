import type { components } from "../../generated/growth-advisor-quote-roi";
import type { FinancialCouncilControllerState } from "./controller";

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
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
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
    ${finding.missingData.length > 0
      ? `<span>数据缺口：${finding.missingData.map((gap) => escapeHtml(gap.description)).join("；")}</span>`
      : ""}
  </li>`).join("");
}

function specialistCards(state: FinancialCouncilControllerState): string {
  const findings = state.run?.consensusReport?.acceptedFindings ?? [];
  return SPECIALISTS.map(({ role, label }) => {
    const cardFindings = findings.filter((finding) => finding.agentRole === role);
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
  return `<section class="council-section" aria-labelledby="council-cfo-heading">
    <h3 id="council-cfo-heading">CFO 诊断与数据缺口</h3>
    <p>${report ? escapeHtml(report.overallDiagnosis) : "诊断仍在生成中。"}</p>
    ${run.status === "not_computable" ? "<p class=\"council-status council-status-blocked\">当前结果不可计算。</p>" : ""}
    <h4>数据缺口</h4>
    <ul>${[
      ...gaps.map((gap) => `<li>${escapeHtml(gap.description)}（${escapeHtml(gap.code)}）</li>`),
      ...missing.map((gap) => `<li>${escapeHtml(gap)}</li>`)
    ].join("") || "<li>无服务端报告的数据缺口。</li>"}</ul>
  </section>`;
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

export function renderFinancialCouncilWorkbench(
  state: FinancialCouncilControllerState,
  options: FinancialCouncilViewOptions
): string {
  if (!state.run) {
    const message = state.error
      ? escapeHtml(state.error)
      : state.busy === "loading" ? "正在加载财务委员会运行…" : "请打开一个财务委员会运行。";
    return `<section class="growth-panel council-workbench" aria-live="polite">
      <p class="${state.error ? "growth-error" : ""}">${message}</p>
      ${options.canCreate ? `<section class="council-create" aria-labelledby="council-create-heading">
        <h2 id="council-create-heading">创建财务委员会运行</h2>
        <p>将使用当前已验证的 Business report 创建运行；不会在浏览器存储、URL 或页面中展示完整报表。</p>
        <label for="council-data-as-of">数据截至时间</label>
        <input id="council-data-as-of" type="datetime-local" data-council-data-as-of required>
        <button type="button" data-council-action="create" ${state.busy ? "disabled" : ""}>创建运行</button>
        <p data-council-create-feedback aria-live="polite"></p>
      </section>` : ""}
    </section>`;
  }
  const run = state.run;
  const blockerReasons = blockers(state, options);
  return `<main class="growth-panel council-workbench" aria-labelledby="council-title">
    <p class="council-live-region" aria-live="polite">${state.error ? escapeHtml(state.error) : state.busy ? "处理中…" : ""}</p>
    <section class="council-section council-summary" aria-labelledby="council-title">
      <h2 id="council-title">财务委员会工作台</h2>
      <h3>运行摘要</h3>
      <p>状态 <strong>${escapeHtml(run.status)}</strong> · dataAsOf ${escapeHtml(run.dataAsOf)} · revision ${run.revision}</p>
      ${run.status === "stale" ? "<p class=\"council-status council-status-blocked\">该运行已过期或数据已失效。</p>" : ""}
    </section>
    <section class="council-section" aria-labelledby="council-specialists-heading">
      <h3 id="council-specialists-heading">专家结论</h3><div class="council-specialist-grid">${specialistCards(state)}</div>
    </section>
    ${auditSection(state)}
    ${cfoSection(state)}
    ${portfolioComparison(state)}
    ${selectedDetail(state)}
    ${blockerSection(blockerReasons)}
    ${editSection(state)}
    ${approvalSection(state, blockerReasons)}
    ${dispatchSection(state)}
  </main>`;
}
