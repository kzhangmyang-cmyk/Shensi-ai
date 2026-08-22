import type { DemoOpportunity, DemoState, OpportunityStage } from "./demo-types";
import { escapeHtml, formatMoney, formatRelativeTime } from "./demo-ui";

const stages: Array<{ id: OpportunityStage; label: string }> = [
  { id: "new", label: "新商机" },
  { id: "qualified", label: "需求确认" },
  { id: "quoted", label: "已报价" },
  { id: "negotiating", label: "谈判中" },
  { id: "won", label: "已成交" },
  { id: "lost", label: "已流失" }
];
const movableStages = stages.filter((stage) => stage.id !== "won" && stage.id !== "lost");

export const lossReasons = ["预算延期", "需求取消", "选择其他供应商", "无法联系"] as const;

export function isOpportunityStage(value: string | undefined): value is OpportunityStage {
  return stages.some((stage) => stage.id === value);
}

export function getConversionMetrics(state: DemoState): {
  totalCount: number;
  totalAmount: number;
  expectedAmount: number;
  pendingQuoteCount: number;
  wonCount: number;
  receivableAmount: number;
} {
  const totalAmount = state.opportunities.reduce((sum, opportunity) => sum + opportunity.amount, 0);
  const expectedAmount = state.opportunities.reduce((sum, opportunity) => sum + opportunity.amount * opportunity.probability / 100, 0);
  const pendingQuoteCount = state.opportunities.filter((opportunity) => opportunity.stage === "new" || opportunity.stage === "qualified").length;
  const won = state.opportunities.filter((opportunity) => opportunity.stage === "won");
  return {
    totalCount: state.opportunities.length,
    totalAmount,
    expectedAmount,
    pendingQuoteCount,
    wonCount: won.length,
    receivableAmount: won.reduce((sum, opportunity) => sum + opportunity.amount, 0)
  };
}

function stageLabel(stage: string): string {
  return stages.find((item) => item.id === stage)?.label ?? "未知阶段";
}

function customerName(state: DemoState, opportunity: DemoOpportunity): string {
  return state.customers.find((customer) => customer.id === opportunity.customerId)?.name ?? "未知客户";
}

function quoteLabel(opportunity: DemoOpportunity): string {
  if (!Number.isFinite(opportunity.quoteAmount)) return "尚未创建报价";
  const sent = opportunity.quoteSentAt ? "已发送" : "待发送";
  return `${formatMoney(opportunity.quoteAmount ?? 0)} · ${sent}`;
}

function renderOpportunityCard(state: DemoState, opportunity: DemoOpportunity): string {
  const terminalClass = opportunity.stage === "won" ? " won" : opportunity.stage === "lost" ? " lost" : "";
  const selectedClass = opportunity.id === state.selectedOpportunityId ? " selected" : "";
  const draggable = opportunity.stage !== "won" && opportunity.stage !== "lost";
  return `<button type="button" class="demo-opportunity-card${terminalClass}${selectedClass}" draggable="${draggable}" data-demo-action="select-opportunity" data-opportunity-id="${escapeHtml(opportunity.id)}" aria-label="查看${escapeHtml(customerName(state, opportunity))}的${escapeHtml(opportunity.title)}">
    <span class="demo-opportunity-card-top"><b>${escapeHtml(customerName(state, opportunity))}</b>${opportunity.stage === "lost" ? '<i class="demo-lost-dot" aria-label="已流失"></i>' : ""}</span>
    <strong>${escapeHtml(opportunity.title)}</strong>
    <span class="demo-opportunity-amount">${formatMoney(opportunity.amount)}</span>
    <span class="demo-opportunity-meta"><span>概率 ${escapeHtml(String(opportunity.probability))}%</span><span>${escapeHtml(opportunity.source)}</span></span>
    <small>下一步：${escapeHtml(opportunity.nextAction)}</small>
  </button>`;
}

function renderBoard(state: DemoState): string {
  return `<section class="demo-conversion-board-wrap" aria-label="商机阶段看板">
    <div class="demo-conversion-board">
      ${stages.map((stage) => {
        const opportunities = state.opportunities.filter((opportunity) => opportunity.stage === stage.id);
        return `<section class="demo-stage-lane stage-${stage.id}" data-opportunity-stage="${stage.id}" aria-label="${stage.label}">
          <header><span>${stage.label}</span><b>${opportunities.length}</b></header>
          <div class="demo-stage-cards">${opportunities.length ? opportunities.map((opportunity) => renderOpportunityCard(state, opportunity)).join("") : '<p class="demo-stage-empty">暂无商机</p>'}</div>
        </section>`;
      }).join("")}
    </div>
  </section>`;
}

function renderInspector(state: DemoState, opportunity: DemoOpportunity): string {
  const customer = state.customers.find((item) => item.id === opportunity.customerId);
  return `<section class="demo-panel demo-conversion-inspector">
    <header><div><span class="demo-status">本地演示商机</span><h3>${escapeHtml(opportunity.title)}</h3><p>${escapeHtml(customer?.name ?? "未知客户")} · ${escapeHtml(opportunity.source)} · ${escapeHtml(stageLabel(opportunity.stage))}</p></div><strong>${formatMoney(opportunity.amount)}</strong></header>
    <div class="demo-analysis-block"><b>需求摘要</b><p>${escapeHtml(customer?.needSummary ?? "暂无关联客户需求摘要")}</p></div>
    <div class="demo-conversion-detail-grid"><div><b>当前报价</b><span>${quoteLabel(opportunity)}</span></div><div><b>当前概率</b><span>${escapeHtml(String(opportunity.probability))}%</span></div></div>
    <form class="demo-conversion-form" data-demo-action="create-quote" data-opportunity-id="${escapeHtml(opportunity.id)}"><label>创建报价<input name="quote-amount" type="number" min="100" step="100" inputmode="decimal" value="${escapeHtml(String(opportunity.quoteAmount ?? opportunity.amount))}"></label><button type="submit">创建报价</button></form>
    <div class="demo-quote-actions"><button type="button" data-demo-action="mark-quote-sent" data-opportunity-id="${escapeHtml(opportunity.id)}" ${opportunity.quoteAmount ? "" : "disabled"}>标记报价已发送</button>${opportunity.quoteSentAt ? `<small>已于 ${escapeHtml(formatRelativeTime(opportunity.quoteSentAt))} 发送</small>` : ""}</div>
    <form class="demo-conversion-form demo-probability-form" data-demo-action="update-opportunity" data-opportunity-id="${escapeHtml(opportunity.id)}"><label>商机金额<input name="opportunity-amount" type="number" min="100" step="100" inputmode="decimal" value="${escapeHtml(String(opportunity.amount))}"></label><label>成交概率<input name="opportunity-probability" type="number" min="0" max="100" step="5" value="${escapeHtml(String(opportunity.probability))}"></label><label>下一步行动<input name="opportunity-next-action" maxlength="40" value="${escapeHtml(opportunity.nextAction)}"></label><button type="submit">更新商机</button></form>
    <div class="demo-stage-controls" role="group" aria-label="移动商机阶段"><b>普通阶段推进</b><div>${movableStages.map((stage) => `<button type="button" data-demo-action="move-opportunity" data-opportunity-id="${escapeHtml(opportunity.id)}" data-opportunity-stage="${stage.id}" ${opportunity.stage === stage.id || opportunity.stage === "won" || opportunity.stage === "lost" ? "disabled" : ""}>${stage.label}</button>`).join("")}</div></div>
    <div class="demo-close-actions"><button type="button" class="demo-primary" data-demo-action="close-won" data-opportunity-id="${escapeHtml(opportunity.id)}" ${opportunity.stage === "won" ? "disabled" : ""}>标记模拟成交</button><form data-demo-action="close-lost" data-opportunity-id="${escapeHtml(opportunity.id)}"><label>流失原因<select name="loss-reason"><option value="" ${opportunity.lossReason ? "" : "selected"}>请选择流失原因</option>${lossReasons.map((reason) => `<option value="${reason}" ${opportunity.lossReason === reason ? "selected" : ""}>${reason}</option>`).join("")}</select></label><button type="submit" ${opportunity.stage === "lost" ? "disabled" : ""}>标记流失</button></form></div>
  </section>`;
}

export function renderConversionView(state: DemoState, main: HTMLElement, inspector: HTMLElement): void {
  const conversionMetrics = getConversionMetrics(state);
  const metrics = [
    { label: "商机总数", value: String(conversionMetrics.totalCount), hint: "当前全部商机" },
    { label: "商机总金额", value: formatMoney(conversionMetrics.totalAmount), hint: "预计合同金额" },
    { label: "预计成交", value: formatMoney(conversionMetrics.expectedAmount), hint: "按当前概率加权" },
    { label: "待报价", value: String(conversionMetrics.pendingQuoteCount), hint: "新商机与需求确认" },
    { label: "已成交", value: String(conversionMetrics.wonCount), hint: "已标记模拟成交" },
    { label: "待回款", value: formatMoney(conversionMetrics.receivableAmount), hint: "演示估算" }
  ];
  const selected = state.opportunities.find((opportunity) => opportunity.id === state.selectedOpportunityId) ?? state.opportunities[0];

  main.innerHTML = `<section class="demo-conversion" aria-label="成交工作台">
    <header class="demo-conversion-header"><div><span class="demo-status">成交工作台</span><h2>把每次推进，变成可追踪的成交</h2><p>普通阶段可按钮或拖动推进；拖入已成交会按 100% 概率关闭，流失须在右侧明确选择原因。所有内容仅更新本地演示数据。</p></div></header>
    <div class="demo-conversion-metrics">${metrics.map((metric) => `<article><span>${metric.label}</span><strong>${metric.value}</strong><small>${metric.hint}</small></article>`).join("")}</div>
    ${renderBoard(state)}
  </section>`;
  inspector.innerHTML = selected ? renderInspector(state, selected) : '<section class="demo-panel demo-empty"><h2>暂无商机</h2><p>请先在私域客户池创建一条演示商机。</p></section>';
}
