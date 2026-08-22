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
  const refSummary = [...new Set(refs)].map(escapeHtml).join(", ");
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
    <strong>${escapeHtml(recommendation.summary)}</strong>
    <p>${escapeHtml(recommendation.rationale)}</p>
    <span>${recommendation.confidenceBps} bps · ${escapeHtml(recommendation.riskLevel)}</span>
    <span>dataAsOf ${escapeHtml(recommendation.dataAsOf)}</span>
    <span>引用 ${refSummary || "无"}</span>
    <span>动作：${escapeHtml(actionLabel(recommendation.recommendedAction))}</span>
    <span>状态 ${escapeHtml(recommendation.status)}</span>
    ${controls}
  </li>`;
}

export function renderAdvisorHome(state: AdvisorHomeState): string {
  switch (state.kind) {
    case "loading":
      return `<section class="growth-panel"><p>正在加载今日经营视图…</p></section>`;
    case "forbidden":
      return `<section class="growth-panel"><p class="growth-forbidden">
        当前工作区无权访问增长参谋。</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        ${escapeHtml(state.message)}</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
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
      return `<section class="growth-panel advisor-home">
        <h2>增长参谋</h2>
        <section class="advisor-explanation">
          <h3>今日结论</h3>
          ${state.aiUnavailable
            ? `<p class="growth-conflict">ai_explanation_unavailable</p>`
            : `<p>${escapeHtml(state.explanation || "暂无模型结论")}</p>`}
          <p>dataAsOf ${escapeHtml(today.dataAsOf)}</p>
        </section>
        <section class="advisor-region">
          <h3>优先客户</h3>
          <ul>${priorities || "<li>暂无优先客户</li>"}</ul>
        </section>
        <section class="advisor-region">
          <h3>待审批报价</h3>
          <ul>${approvals || "<li>暂无待审批报价</li>"}</ul>
        </section>
        <section class="advisor-region">
          <h3>ROI 摘要</h3>
          <ul>${roiSummary || "<li>暂无 ROI</li>"}</ul>
        </section>
        <section class="advisor-region">
          <h3>数据缺口</h3>
          <ul>${gaps || "<li>暂无数据缺口</li>"}</ul>
        </section>
        <section class="advisor-region">
          <h3>建议</h3>
          <ul>${recommendations || "<li>暂无建议</li>"}</ul>
        </section>
      </section>`;
    }
  }
}
