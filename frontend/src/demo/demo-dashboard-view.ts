import type { DemoModule, DemoState, Platform } from "./demo-types";
import { escapeHtml, formatMoney } from "./demo-ui";

const ACTIVE_STAGES = new Set(["new", "qualified", "quoted", "negotiating"]);
const STAGE_LABELS: Record<string, string> = {
  new: "新建",
  qualified: "已确认",
  quoted: "已报价",
  negotiating: "谈判中",
  won: "已成交",
  lost: "已流失"
};
const PRIORITY_ORDER = { "高": 0, "中": 1, "低": 2 } as const;

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftMonths(date: Date, amount: number): Date {
  const shifted = new Date(date);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + amount);
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted;
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function compactMoney(value: number): string {
  if (value >= 10_000) return `¥${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`;
  return formatMoney(value);
}

function previousStageRate(value: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(value / previous * 1000) / 10;
}

function moduleEntity(module: DemoModule): "conversation" | "customer" | "opportunity" | null {
  if (module === "conversations") return "conversation";
  if (module === "private-domain") return "customer";
  if (module === "conversion") return "opportunity";
  return null;
}

function openModuleAttributes(module: DemoModule, relatedId?: string): string {
  const entity = moduleEntity(module);
  return `data-demo-action="open-module" data-demo-module="${module}"${entity && relatedId
    ? ` data-demo-entity-type="${entity}" data-demo-entity-id="${escapeHtml(relatedId)}"`
    : ""}`;
}

export function buildDashboardModel(state: DemoState, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = shiftMonths(end, -3);
  const compareStart = shiftMonths(start, -3);
  const compareEnd = addDays(start, -1);
  const activeOpportunities = state.opportunities.filter((item) => ACTIVE_STAGES.has(item.stage));
  const qualifiedConversations = state.conversations.filter((item) => item.intent !== "低").length;
  const pipelineAmount = state.opportunities.reduce((sum, item) => sum + item.amount, 0);
  const quoteAmount = state.opportunities.reduce((sum, item) => sum + (item.quoteAmount ?? 0), 0);
  const wonAmount = state.opportunities.filter((item) => item.stage === "won").reduce((sum, item) => sum + item.amount, 0);
  const funnelValues = [
    { label: "全部会话", value: state.conversations.length, module: "acquisition" as const },
    { label: "中高意向", value: qualifiedConversations, module: "conversations" as const },
    { label: "私域客户", value: state.customers.length, module: "private-domain" as const },
    { label: "形成商机", value: state.opportunities.length, module: "conversion" as const },
    { label: "成交商机", value: state.opportunities.filter((item) => item.stage === "won").length, module: "conversion" as const }
  ];
  const funnel = funnelValues.map((item, index) => ({
    ...item,
    previousStageRate: previousStageRate(item.value, index === 0 ? null : funnelValues[index - 1]!.value)
  }));

  const channelMap = new Map<Platform, number>();
  for (const opportunity of state.opportunities) {
    channelMap.set(opportunity.source, (channelMap.get(opportunity.source) ?? 0) + opportunity.amount);
  }
  const channelAmounts = [...channelMap.entries()]
    .map(([channel, amount]) => ({ channel, amount, share: pipelineAmount ? Math.round(amount / pipelineAmount * 1000) / 10 : 0 }))
    .sort((a, b) => b.amount - a.amount);

  const bucketStarts = [start, shiftMonths(start, 1), shiftMonths(start, 2)];
  const bucketEnds = [addDays(bucketStarts[1]!, -1), addDays(bucketStarts[2]!, -1), end];
  const timeline = bucketStarts.map((bucketStart, index) => {
    const bucketEnd = bucketEnds[index]!;
    const includes = (iso: string | undefined) => {
      if (!iso) return false;
      const timestamp = Date.parse(iso);
      return Number.isFinite(timestamp) && timestamp >= bucketStart.getTime()
        && timestamp < addDays(bucketEnd, 1).getTime();
    };
    const opportunities = state.opportunities.filter((item) => includes(item.updatedAt));
    return {
      label: `${dateOnly(bucketStart).slice(5)}—${dateOnly(bucketEnd).slice(5)}`,
      opportunityAmount: opportunities.reduce((sum, item) => sum + item.amount, 0),
      quoteAmount: state.opportunities.filter((item) => includes(item.quoteSentAt)).reduce((sum, item) => sum + (item.quoteAmount ?? 0), 0),
      wonAmount: opportunities.filter((item) => item.stage === "won").reduce((sum, item) => sum + item.amount, 0),
      conversations: state.conversations.filter((item) => includes(item.updatedAt)).length,
      customers: state.customers.filter((item) => includes(item.lastContactAt)).length,
      opportunities: opportunities.length
    };
  });

  return {
    period: { start: dateOnly(start), end: dateOnly(end), compareStart: dateOnly(compareStart), compareEnd: dateOnly(compareEnd) },
    totalConversations: state.conversations.length,
    qualifiedConversations,
    activeOpportunities: activeOpportunities.length,
    pipelineAmount,
    quoteAmount,
    wonAmount,
    receiptsAvailable: false as const,
    funnel,
    channelAmounts,
    timeline,
    tasks: state.tasks.filter((item) => !item.done).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]),
    attentionConversations: state.conversations.filter((item) => item.mode === "manual" || item.mode === "paused"),
    unquotedOpportunities: activeOpportunities.filter((item) => item.quoteAmount === undefined),
    highPriorityTasks: state.tasks.filter((item) => !item.done && item.priority === "高")
  };
}

function amountBars(model: ReturnType<typeof buildDashboardModel>): string {
  const maximum = Math.max(1, ...model.timeline.flatMap((item) => [item.opportunityAmount, item.quoteAmount, item.wonAmount]));
  return model.timeline.map((item) => `<div class="demo-erp-bar-group">
    <div class="demo-erp-bars" aria-label="${item.label}">
      <span class="is-pipeline" style="--bar:${item.opportunityAmount / maximum * 100}%" title="商机 ${formatMoney(item.opportunityAmount)}"></span>
      <span class="is-quote" style="--bar:${item.quoteAmount / maximum * 100}%" title="报价 ${formatMoney(item.quoteAmount)}"></span>
      <span class="is-won" style="--bar:${item.wonAmount / maximum * 100}%" title="成交 ${formatMoney(item.wonAmount)}"></span>
    </div><small>${item.label}</small>
  </div>`).join("");
}

function countBars(model: ReturnType<typeof buildDashboardModel>): string {
  const maximum = Math.max(1, ...model.timeline.flatMap((item) => [item.conversations, item.customers, item.opportunities]));
  return model.timeline.map((item) => `<div class="demo-erp-bar-group">
    <div class="demo-erp-bars" aria-label="${item.label}">
      <span class="is-conversation" style="--bar:${item.conversations / maximum * 100}%" title="会话 ${item.conversations}"></span>
      <span class="is-customer" style="--bar:${item.customers / maximum * 100}%" title="客户 ${item.customers}"></span>
      <span class="is-opportunity" style="--bar:${item.opportunities / maximum * 100}%" title="商机 ${item.opportunities}"></span>
    </div><small>${item.label}</small>
  </div>`).join("");
}

function attentionItem(label: string, detail: string, module: DemoModule, relatedId?: string): string {
  return `<button type="button" class="demo-erp-attention-item" ${openModuleAttributes(module, relatedId)}><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small><i class="ph ph-arrow-right" aria-hidden="true"></i></button>`;
}

export function renderDashboardView(
  state: DemoState,
  main: HTMLElement,
  inspector: HTMLElement,
  now = new Date()
): void {
  const model = buildDashboardModel(state, now);
  const metrics = [
    { label: "中高意向会话", value: String(model.qualifiedConversations), note: `共 ${model.totalConversations} 条会话`, module: "conversations" as const },
    { label: "私域客户", value: String(state.customers.length), note: "已沉淀客户", module: "private-domain" as const },
    { label: "进行中商机", value: String(model.activeOpportunities), note: `全部 ${state.opportunities.length} 个`, module: "conversion" as const },
    { label: "商机总额", value: compactMoney(model.pipelineAmount), note: "按商机原始金额", module: "conversion" as const },
    { label: "报价金额", value: compactMoney(model.quoteAmount), note: "已建立报价", module: "conversion" as const },
    { label: "已确认回款", value: "—", note: "回款数据未接入", module: "conversion" as const }
  ];
  const maximumChannel = Math.max(1, ...model.channelAmounts.map((item) => item.amount));

  main.innerHTML = `<section class="demo-dashboard demo-erp-dashboard" aria-label="自动营销总览">
    <header class="demo-dashboard-header demo-erp-header">
      <div><span class="demo-status">预览 · 待接入</span><h2>自动营销经营总览</h2><p>${model.period.start} ~ ${model.period.end} · 对比 ${model.period.compareStart} ~ ${model.period.compareEnd}</p></div>
      <div class="demo-erp-source"><span>数据口径</span><strong>本地演示数据概览</strong><small>仅汇总当前 DemoState，不代表真实经营结果</small></div>
    </header>

    <section class="demo-metric-rail demo-erp-metric-rail" aria-label="经营指标">
      ${metrics.map((metric) => `<button type="button" class="demo-dashboard-metric" ${openModuleAttributes(metric.module)}><span>${metric.label}</span><strong>${metric.value}</strong><small>${metric.note}</small></button>`).join("")}
    </section>

    <div class="demo-dashboard-columns demo-erp-chart-grid">
      <section class="demo-panel demo-erp-chart-panel"><div class="demo-section-heading"><div><span class="demo-chip">金额</span><h3>商机 / 报价 / 成交金额趋势</h3></div><small>CNY · 仅展示已存在数据</small></div><div class="demo-erp-legend"><span class="is-pipeline">商机</span><span class="is-quote">报价</span><span class="is-won">成交</span></div><div class="demo-erp-bars-chart">${amountBars(model)}</div></section>
      <section class="demo-panel demo-erp-chart-panel"><div class="demo-section-heading"><div><span class="demo-chip">数量</span><h3>会话 / 客户 / 商机数量趋势</h3></div><small>与金额口径分开</small></div><div class="demo-erp-legend"><span class="is-conversation">会话</span><span class="is-customer">客户</span><span class="is-opportunity">商机</span></div><div class="demo-erp-bars-chart">${countBars(model)}</div></section>
    </div>

    <div class="demo-dashboard-columns demo-erp-analysis-grid">
      <section class="demo-panel demo-funnel-panel"><div class="demo-section-heading"><div><span class="demo-chip">转化</span><h3>客户转化漏斗</h3></div><small>每一比例均以上一阶段为分母</small></div><div class="demo-funnel demo-erp-funnel">${model.funnel.map((item, index) => `<button type="button" class="demo-funnel-item" ${openModuleAttributes(item.module)}><span class="demo-funnel-step">0${index + 1}</span><b>${item.value}</b><span>${item.label}</span><small>${index === 0 ? "起点" : item.previousStageRate === null ? "较上一阶段 —" : `较上一阶段 ${item.previousStageRate}%`}</small></button>`).join("")}</div></section>
      <section class="demo-panel demo-erp-channel-panel"><div class="demo-section-heading"><div><span class="demo-chip">渠道</span><h3>商机金额来源</h3></div><small>总额 ${formatMoney(model.pipelineAmount)}</small></div><div class="demo-erp-channel-list">${model.channelAmounts.map((item) => `<div><span><b>${item.channel}</b><small>${item.share}%</small></span><i><em style="--share:${item.amount / maximumChannel * 100}%"></em></i><strong>${compactMoney(item.amount)}</strong></div>`).join("")}</div></section>
    </div>

    <section class="demo-panel demo-erp-task-panel"><div class="demo-section-heading"><div><span class="demo-chip">待办</span><h3>当前未完成任务</h3></div><small>${model.tasks.length} 项 · 按优先级排序</small></div><div class="demo-erp-table" role="table" aria-label="当前未完成任务"><div class="demo-erp-table-head" role="row"><span>优先级</span><span>任务</span><span>模块</span><span>截止时间</span><span>状态</span></div>${model.tasks.map((task) => `<button type="button" role="row" ${openModuleAttributes(task.module, task.relatedId)}><span class="priority-${task.priority}">${task.priority}</span><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.module)}</span><time>${task.dueAt ? escapeHtml(task.dueAt.slice(0, 16).replace("T", " ")) : "未设置"}</time><small>待处理</small></button>`).join("")}</div></section>
  </section>`;

  const attention = [
    ...model.highPriorityTasks.map((task) => attentionItem(task.title, "高优先级待办", task.module, task.relatedId)),
    ...model.attentionConversations.map((conversation) => attentionItem(conversation.customerName, conversation.mode === "paused" ? "会话已暂停" : "人工接管中", "conversations", conversation.id)),
    ...model.unquotedOpportunities.map((opportunity) => attentionItem(opportunity.title, `${STAGE_LABELS[opportunity.stage]} · 尚未建立报价`, "conversion", opportunity.id))
  ];
  inspector.innerHTML = `<section class="demo-panel demo-dashboard-inspector demo-erp-inspector"><span class="demo-chip">经营异常</span><h3>需要人工关注</h3><p>仅列出当前数据中可确定的待处理项，不生成虚构审批。</p><div class="demo-erp-attention-list">${attention.length ? attention.join("") : '<div class="demo-empty">当前没有可确定的异常项</div>'}</div><div class="demo-inspector-note"><b>回款数据未接入</b><span>回款 KPI 显示“—”，不用报价或商机金额替代。</span></div></section>`;
}
