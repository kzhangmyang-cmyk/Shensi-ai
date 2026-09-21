import type { AdvisorHomeState } from "./controller";
import type {
  AdvisorRecommendation,
  FinancialDataGapView,
  PendingQuoteApprovalView,
  PriorityCustomerView
} from "./api";

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

function recommendationStatus(value: AdvisorRecommendation["status"]): string {
  return value === "proposed" ? "待决策"
    : value === "accepted" ? "已接受"
      : value === "ignored" ? "已忽略"
        : "已完成";
}

function riskLevelLabel(value: AdvisorRecommendation["riskLevel"]): string {
  return value === "critical" ? "紧急"
    : value === "high" ? "高风险"
      : value === "medium" ? "中风险"
        : "低风险";
}

function confidenceLabel(value: number): string {
  const percentage = Math.max(0, Math.min(100, value / 100));
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(percentage)}% 可信程度`;
}

const evidenceKindLabels: Readonly<Record<string, string>> = {
  growth_performance: "经营表现",
  quote_preview: "报价测算",
  priority_score: "客户优先级",
  financial_data_gap: "财务缺口",
  candidate_evidence: "客户证据",
  quote_version: "报价版本",
  ledger_entry: "财务台账",
  roi_snapshot: "ROI 结果",
  customer: "客户资料",
  deal: "商机资料",
  closure_version: "关账版本"
};

function evidenceKindLabel(value: string): string {
  return evidenceKindLabels[value] ?? "其他依据";
}

function actionLabel(action: AdvisorRecommendation["recommendedAction"]): string {
  switch (action.kind) {
    case "open_candidate":
      return "打开候选";
    case "create_quote_draft":
      return "创建报价草稿";
    case "create_quote_approval_task":
      return "创建报价审批任务";
    case "create_sales_todo":
      return "创建销售待办";
    case "complete_cost_data":
      return "补全成本数据";
    case "complete_financial_fact":
      return "补全财务事实";
  }
}

function priorityRow(row: PriorityCustomerView): string {
  return `<li class="advisor-priority">
    <strong>${escapeHtml(row.displayName)}</strong>
    <span>${row.priorityScoreBps} bps</span>
    <span>${escapeHtml(row.qualificationDecisionVersion)}</span>
  </li>`;
}

function approvalRow(row: PendingQuoteApprovalView): string {
  return `<li class="advisor-approval">
    <strong>${escapeHtml(row.quoteVersionId)}</strong>
    <span>${escapeHtml(row.approvalKind)}</span>
    <span>提交 ${escapeHtml(row.submittedAt)}</span>
  </li>`;
}

function gapRow(row: FinancialDataGapView): string {
  return `<li class="advisor-gap">
    <span>${escapeHtml(row.code)}</span>
    <span>${escapeHtml(row.sourceId)}</span>
    <button data-action="gap-navigate" data-source="${escapeHtml(row.sourceType)}"
      data-id="${escapeHtml(row.sourceId)}">补全</button>
  </li>`;
}

function recommendationRow(
  recommendation: AdvisorRecommendation,
  decidingId: string | null
): string {
  const refs = [
    ...recommendation.metricRefs.map((ref) => ref.kind),
    ...recommendation.evidenceRefs.map((ref) => ref.kind),
    ...recommendation.entityRefs.map((ref) => ref.kind)
  ];
  const refSummary = [...new Set(refs)].map(evidenceKindLabel).map(escapeHtml).join("、");
  const controls = recommendation.status === "proposed"
    ? `<button data-action="accept" data-id="${escapeHtml(recommendation.id)}"
        data-revision="${recommendation.revision}"
        ${decidingId === recommendation.id ? "disabled" : ""}>接受</button>
       <button data-action="ignore" data-id="${escapeHtml(recommendation.id)}"
        data-revision="${recommendation.revision}"
        ${decidingId === recommendation.id ? "disabled" : ""}>忽略</button>`
    : recommendation.status === "accepted"
      ? `<button data-action="complete" data-id="${escapeHtml(recommendation.id)}"
          data-revision="${recommendation.revision}"
          ${decidingId === recommendation.id ? "disabled" : ""}>完成</button>`
      : "";
  return `<li class="advisor-recommendation" data-recommendation-id="${escapeHtml(recommendation.id)}">
    <div><span class="advisor-priority-level">${riskLevelLabel(recommendation.riskLevel)}</span>
      <small>${confidenceLabel(recommendation.confidenceBps)}</small></div>
    <div><strong>${escapeHtml(recommendation.summary)}</strong>
      <p>${escapeHtml(recommendation.rationale)}</p></div>
    <div><span>${refSummary || "暂无引用"}</span>
      <small>截至 ${escapeHtml(businessDateTime(recommendation.dataAsOf))}</small></div>
    <div><span>${escapeHtml(actionLabel(recommendation.recommendedAction))}</span>
      <small>${recommendationStatus(recommendation.status)}</small></div>
    <div class="advisor-row-actions">${controls}</div>
  </li>`;
}

export function renderAdvisorHome(state: AdvisorHomeState): string {
  switch (state.kind) {
    case "loading":
      return `<section class="growth-panel advisor-home advisor-home-state"><p>正在加载今日经营视图…</p></section>`;
    case "forbidden":
      return `<section class="growth-panel advisor-home advisor-home-state"><p class="growth-forbidden">
        当前工作区无权访问增长参谋。</p></section>`;
    case "error":
      return `<section class="growth-panel advisor-home advisor-home-state"><p class="growth-error">
        ${escapeHtml(state.message)}</p></section>`;
    case "conflict":
      return `<section class="growth-panel advisor-home advisor-home-state"><p class="growth-conflict">
        ${escapeHtml(state.message)}</p></section>`;
    case "ready": {
      const today = state.today;
      const priorities = (today.priorityCustomers ?? [])
        .map(priorityRow).join("");
      const approvals = (today.pendingQuoteApprovals ?? [])
        .map(approvalRow).join("");
      const gaps = (today.financialDataGaps ?? []).map(gapRow).join("");
      const recommendations = (today.recommendations ?? [])
        .map((row) => recommendationRow(row, state.decidingId))
        .join("");
      const roiSummary = (today.expectedRoi ?? []).map((row) =>
        `<li>预计 ${escapeHtml(row.cohortId)}：${row.roiBps ?? "不可用"} bps</li>`)
        .join("") + (today.actualRoi ?? []).map((row) =>
          `<li>实际 ${escapeHtml(row.cohortId)}：${row.roiBps ?? "不可用"} bps</li>`)
        .join("");
      const hasBusinessData = Boolean(
        today.priorityCustomers?.length
        || today.pendingQuoteApprovals?.length
        || today.expectedRoi?.length
        || today.actualRoi?.length
      );
      const dataGapStatus = today.financialDataGaps?.length
        ? "待核对"
        : hasBusinessData ? "无" : "待准备";
      const dataGapTone = today.financialDataGaps?.length
        ? "needs-review"
        : hasBusinessData ? "ready" : "needs-data";
      return `<section class="growth-panel advisor-home">
        <div class="advisor-data-rail" aria-label="增长顾问当前工作量">
          <div><span>数据范围</span><strong>当前工作区</strong></div>
          <div><span>客户</span><strong>${today.priorityCustomers?.length ?? 0}</strong></div>
          <div><span>待审批报价</span><strong>${today.pendingQuoteApprovals?.length ?? 0}</strong></div>
          <div><span>数据缺口</span><strong class="advisor-data-gap-status advisor-data-gap-status--${dataGapTone}" data-advisor-data-gap-status>${dataGapStatus}</strong></div>
        </div>
        <div class="advisor-workbench">
          <div class="advisor-main-column">
          <section class="advisor-priority-table" aria-labelledby="advisor-priority-title">
            <header><div><h3 id="advisor-priority-title">今日优先事项</h3></div>
              <div class="advisor-table-tools"><small>数据截至 ${escapeHtml(businessDateTime(today.dataAsOf))}</small><button type="button" data-action="advisor-refresh" aria-label="刷新增长顾问"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>刷新</button></div></header>
            <div class="advisor-priority-grid"><div class="advisor-priority-head" aria-hidden="true"><span>优先级</span><span>事项</span><span>依据</span><span>下一步</span><span>操作</span></div>
            <ul>${recommendations || `<li class="advisor-priority-empty"><span class="advisor-empty-mark" aria-hidden="true"><i class="ph ph-clipboard-text"></i></span><strong>暂无可生成的经营建议</strong><span>添加客户或财务资料后，这里会显示有依据的优先事项。</span><a href="#growth/catalog">去客户目录</a></li>`}</ul></div>
          </section>
          <section class="advisor-business-summary">
            <header><span>经营摘要</span></header>
            <div><article><h3><i class="ph ph-users-three" aria-hidden="true"></i><span>客户跟进</span></h3><ul>${priorities || "<li>暂无客户</li>"}</ul><a href="#growth/catalog">查看客户目录</a></article>
            <article><h3><i class="ph ph-file-text" aria-hidden="true"></i><span>报价审批</span></h3><ul>${approvals || "<li>暂无待审批报价</li>"}</ul><a href="#growth/quotes">打开报价工作台</a></article>
            <article><h3><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>投入产出</span></h3><ul>${roiSummary || "<li>暂无可分析批次</li>"}</ul><a href="#growth/roi">查看 ROI</a></article>
            <article><h3><i class="ph ph-wallet" aria-hidden="true"></i><span>财务资料</span></h3><ul>${gaps || "<li>尚未导入</li>"}</ul><a href="#growth/finance">打开财务经营</a></article></div>
          </section>
          </div>
          <aside class="advisor-basis" aria-label="建议依据与起步步骤">
            <section><h3>建议依据</h3><dl>
              <div><dt><i class="ph ph-users-three" aria-hidden="true"></i><span>客户资料</span></dt><dd><i class="advisor-evidence-state" aria-hidden="true"></i>${today.priorityCustomers?.length ? `${today.priorityCustomers.length} 项` : "待准备"}</dd></div>
              <div><dt><i class="ph ph-file-text" aria-hidden="true"></i><span>报价信息</span></dt><dd><i class="advisor-evidence-state" aria-hidden="true"></i>${today.pendingQuoteApprovals?.length ? `${today.pendingQuoteApprovals.length} 项` : "待准备"}</dd></div>
              <div><dt><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>财务数据</span></dt><dd><i class="advisor-evidence-state" aria-hidden="true"></i>${today.financialDataGaps?.length ? "待核对" : "待准备"}</dd></div>
            </dl></section>
            <section><h3>如何开始</h3><ol><li><span class="advisor-step-index">01</span><span><b>准备业务资料</b><small>添加客户、报价与财务资料，完善经营基础。</small></span></li><li><span class="advisor-step-index">02</span><span><b>生成经营建议</b><small>系统将基于真实数据生成有依据的优先事项。</small></span></li><li><span class="advisor-step-index">03</span><span><b>核对后执行</b><small>你核对建议并分配任务，跟进执行结果。</small></span></li></ol><p>${state.aiUnavailable ? "暂时无法生成解读" : escapeHtml(state.explanation || "建议经你核对后执行。")}</p></section>
          </aside>
        </div>
      </section>`;
    }
  }
}
