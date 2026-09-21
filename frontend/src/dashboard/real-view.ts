import { escapeHtml } from "../demo/demo-ui";
import type { DashboardHistoryPeriod, RealDashboardSummary } from "./real-api";

export interface RealDashboardViewState {
  status: "loading" | "ready" | "error";
  summary: RealDashboardSummary | null;
  error: string | null;
  period: DashboardHistoryPeriod;
}

function number(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "—";
}

function decimal(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "—";
}

function moneyRows(rows: Array<{ currency: string; amount: number }>): string {
  return rows.length
    ? rows.map((row) => `<span>${escapeHtml(row.currency)} ${number(row.amount)}</span>`).join(" · ")
    : "—";
}

function adjacentRate(current: number, previous: number | undefined): string {
  if (previous === undefined) return "起点";
  if (!previous) return "较上一阶段 —";
  return `较上一阶段 ${Math.round(current / previous * 1000) / 10}%`;
}

function updatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "更新时间未提供";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function unavailableMetric(label: string, module: string) {
  return { label, value: "—", note: "暂无可用汇总", module };
}

function statusView(state: RealDashboardViewState, main: HTMLElement, inspector: HTMLElement): boolean {
  if (state.status === "ready" && state.summary) return false;
  if (state.status === "loading") {
    main.innerHTML = `<section class="demo-panel real-dashboard-state" aria-live="polite"><span class="demo-chip">真实数据</span><h2>正在读取真实经营数据…</h2><p>数据将按当前登录账号的权限范围展示。</p></section>`;
  } else {
    main.innerHTML = `<section class="demo-panel real-dashboard-state" role="alert"><span class="demo-chip">读取失败</span><h2>真实经营数据暂时不可用</h2><p>${escapeHtml(state.error ?? "dashboard_request_failed")}</p><button type="button" class="demo-primary" data-real-dashboard-action="retry">重试</button></section>`;
  }
  inspector.innerHTML = `<section class="demo-panel demo-dashboard-inspector"><h3>数据口径</h3><p>不会用本地演示数据填充真实账号页面。</p></section>`;
  return true;
}

const SOURCE_COLORS = ["#18ed78", "#09b8c9", "#f0a44b", "#9a7cff", "#ed6969", "#6dc7ff"];

function amountTrend(summary: RealDashboardSummary): string {
  const currencies = [...new Set(summary.history.buckets.flatMap((bucket) =>
    bucket.expectedAmounts.map((row) => row.currency)))];
  const currency = currencies[0] ?? null;
  return `<div class="real-dashboard-trend-visual${currency ? "" : " is-empty"}">
    <div class="real-dashboard-chart-legend"><span class="is-forecast">预计成交</span><span class="is-receipt">已确认回款·待接入</span></div>
    <canvas class="real-dashboard-trend-canvas" width="720" height="250" aria-label="${escapeHtml(summary.history.label)}预计成交金额趋势"></canvas>
    <div class="real-dashboard-chart-axis">${summary.history.buckets.map((bucket) => `<span>${escapeHtml(bucket.label)}</span>`).join("") || "<span>期间待生成</span>"}</div>
    ${currency ? `<small>币种：${escapeHtml(currency)}·只显示已有预计成交数据</small>` : `<p>本周期暂无可绘制的预计成交金额</p>`}
  </div>`;
}

function leadSourceChart(summary: RealDashboardSummary): string {
  const raw = summary.history.leadSources;
  if (!raw.length) {
    return `<div class="real-dashboard-source-layout is-empty"><div class="real-dashboard-source-ring"><span><b>—</b><small>新增线索</small></span></div><div class="real-dashboard-source-legend"><div><i></i><span>暂无可归因来源</span><b>—</b><small>—</small></div></div></div><p class="real-dashboard-source-empty">新线索产生后，这里会按真实来源显示占比。</p>`;
  }
  const visible = raw.length <= SOURCE_COLORS.length
    ? raw
    : [
        ...raw.slice(0, SOURCE_COLORS.length - 1),
        {
          source: "其他",
          count: raw.slice(SOURCE_COLORS.length - 1).reduce((sum, item) => sum + item.count, 0),
          share: raw.slice(SOURCE_COLORS.length - 1).reduce((sum, item) => sum + item.share, 0)
        }
      ];
  let cursor = 0;
  const slices = visible.map((item, index) => {
    const start = cursor;
    cursor = Math.min(100, cursor + item.share);
    return `${SOURCE_COLORS[index]} ${start}% ${cursor}%`;
  }).join(",");
  const total = visible.reduce((sum, item) => sum + item.count, 0);
  return `<div class="real-dashboard-source-layout"><div class="real-dashboard-source-ring" style="--source-ring:conic-gradient(${slices})"><span><b>${number(total)}</b><small>新增线索</small></span></div><div class="real-dashboard-source-legend">${visible.map((item, index) => `<div><i style="--source-color:${SOURCE_COLORS[index]}"></i><span>${escapeHtml(item.source)}</span><b>${number(item.count)}</b><small>${decimal(item.share)}%</small></div>`).join("")}</div></div><div class="real-dashboard-lead-trend">${summary.history.buckets.map((bucket) => `<span><small>${escapeHtml(bucket.label)}</small><b>${number(bucket.newLeads)}</b></span>`).join("")}</div>`;
}

function funnelView(
  stages: RealDashboardSummary["leadFunnel"]["stages"]
): string {
  if (!stages.some((item) => item.count > 0)) {
    return `<div class="real-dashboard-funnel-empty"><strong>暂无可判断的转化数据</strong><span>公开线索完成核对并进入业务流程后，这里会按真实记录展示转化。</span></div>`;
  }
  return `<div class="real-dashboard-funnel-stack">${stages.map((item, index, rows) =>
    `<button type="button" style="--funnel-inset:${index * 6}%" data-demo-action="open-module" data-demo-module="${index < 2 ? "acquisition" : index === 2 ? "private-domain" : "conversion"}"><span>${escapeHtml(item.label)}</span><strong>${number(item.count)}</strong><small>${adjacentRate(item.count, rows[index - 1]?.count)}</small></button>`
  ).join("")}</div>`;
}

function drawTrendChart(main: HTMLElement, summary: RealDashboardSummary): void {
  const canvas = main.querySelector<HTMLCanvasElement>(".real-dashboard-trend-canvas");
  const context = canvas?.getContext?.("2d");
  if (!canvas || !context) return;
  const buckets = summary.history.buckets;
  const currency = buckets.flatMap((bucket) => bucket.expectedAmounts)[0]?.currency;
  const values = currency
    ? buckets.map((bucket) => bucket.expectedAmounts.find((row) => row.currency === currency)?.amount ?? 0)
    : [];
  const width = canvas.width;
  const height = canvas.height;
  const left = 46;
  const right = 14;
  const top = 18;
  const bottom = 20;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "rgba(229,238,233,.12)";
  context.lineWidth = 1;
  context.font = "20px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = "rgba(229,238,233,.52)";
  context.textAlign = "right";
  for (let index = 0; index <= 4; index += 1) {
    const y = top + ((height - top - bottom) / 4) * index;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
  }
  if (!values.length) {
    context.textAlign = "center";
    context.fillText("暂无可绘制数据", width / 2, height / 2 + 6);
    return;
  }
  const maximum = Math.max(1, ...values);
  context.strokeStyle = "#18ed78";
  context.fillStyle = "#18ed78";
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  values.forEach((value, index) => {
    const x = values.length === 1 ? width / 2 : left + (width - left - right) * index / (values.length - 1);
    const y = height - bottom - (height - top - bottom) * value / maximum;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  values.forEach((value, index) => {
    const x = values.length === 1 ? width / 2 : left + (width - left - right) * index / (values.length - 1);
    const y = height - bottom - (height - top - bottom) * value / maximum;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
  });
}

export function renderRealDashboardView(
  state: RealDashboardViewState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  if (statusView(state, main, inspector)) return;
  const summary = state.summary!;
  const activeDeals = summary.pipelineHealth.reduce((sum, item) => sum + item.count, 0);
  const serialFunnel = summary.leadFunnel.stages.filter((item) =>
    item.key === "entered" || item.key === "valid" || item.key === "customer" || item.key === "deal");
  const metrics: Array<{
    label: string;
    value: string;
    note: string;
    module: string;
    valueClass?: string;
  }> = [
    { label: "可见客户", value: number(summary.metrics.customers), note: `${summary.metrics.riskCustomers} 个风险客户`, module: "private-domain" },
    { label: "本人待办", value: number(summary.metrics.todos), note: `${summary.metrics.overdueTodos} 个高优先级`, module: "private-domain" },
    { label: "活跃商机", value: number(activeDeals), note: "排除成交与丢单", module: "conversion" },
    {
      label: "商机预测金额",
      value: moneyRows(summary.metrics.forecastAmounts),
      note: "按币种分别汇总",
      module: "conversion",
      valueClass: "is-multi-currency"
    },
    unavailableMetric("报价金额", "conversion"),
    unavailableMetric("已确认回款", "conversion")
  ];

  main.innerHTML = `<section class="demo-dashboard demo-erp-dashboard real-dashboard" aria-label="真实经营总览">
    <header class="real-dashboard-contextbar">
      <div><span class="demo-status is-live">真实经营数据</span><p>${escapeHtml(summary.history.start)} — ${escapeHtml(summary.history.end)} · ${escapeHtml(summary.scope)}</p></div>
      <nav class="real-dashboard-period-filter" aria-label="经营数据周期"><button type="button" data-real-dashboard-period="3m" aria-pressed="${state.period === "3m"}">近三个月</button><button type="button" data-real-dashboard-period="month" aria-pressed="${state.period === "month"}">本月</button></nav>
      <div class="real-dashboard-source-note"><span>${escapeHtml(summary.scopeLabels.business)} / ${escapeHtml(summary.scopeLabels.todos)}</span><small>更新于 ${escapeHtml(updatedAt(summary.updatedAt))}</small></div>
    </header>

    <section class="demo-metric-rail demo-erp-metric-rail" aria-label="真实经营指标">
      ${metrics.map((metric) => `<button type="button" class="demo-dashboard-metric" data-demo-action="open-module" data-demo-module="${metric.module}"><span>${metric.label}</span><strong${metric.valueClass ? ` class="${metric.valueClass}"` : ""}>${metric.value}</strong><small>${metric.note}</small></button>`).join("")}
    </section>

    <div class="real-dashboard-analysis-grid">
      <section class="demo-panel real-dashboard-analysis-panel is-trend"><div class="demo-section-heading"><div><span class="demo-chip">趋势</span><h3>预计成交 / 回款趋势</h3></div><small>${escapeHtml(summary.history.label)}·币种分开</small></div>${amountTrend(summary)}</section>
      <section class="demo-panel real-dashboard-analysis-panel is-funnel"><div class="demo-section-heading"><div><span class="demo-chip">转化</span><h3>获客到商机漏斗</h3></div><small>待清洗 ${number(summary.leadFunnel.stages.find((item) => item.key === "pending")?.count ?? 0)} 条</small></div>${funnelView(serialFunnel)}</section>
      <section class="demo-panel real-dashboard-analysis-panel is-source"><div class="demo-section-heading"><div><span class="demo-chip">渠道</span><h3>渠道贡献（线索数量）</h3></div><small>不代表金额贡献</small></div>${leadSourceChart(summary)}</section>
    </div>

    <section data-dashboard-todos tabindex="-1" aria-label="今日待办" class="demo-panel demo-erp-task-panel${summary.schedule.length ? " has-schedule" : " is-empty"}"><div class="demo-section-heading"><div><span class="demo-chip">节奏</span><h3>今日待办</h3></div><small>${summary.schedule.length} 项·${escapeHtml(summary.scopeLabels.todos)}</small></div><div class="demo-erp-table" role="table" aria-label="当前日程与待办"><div class="demo-erp-table-head" role="row"><span>时间</span><span>事项</span><span>客户 / 关联</span><span>负责人</span><span>状态</span><span>操作</span></div><div class="real-dashboard-task-rows" role="rowgroup">${summary.schedule.length ? summary.schedule.map((item) => `<button type="button" role="row" data-demo-action="open-module" data-demo-module="private-domain"><time>${escapeHtml(item.time)}</time><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.subtitle)}</span><span>本人</span><span class="is-${escapeHtml(item.tone)}">${item.tone === "red" ? "高优先级" : item.tone === "amber" ? "即将到期" : "待处理"}</span><small>查看</small></button>`).join("") : '<div class="demo-empty">当前没有待办</div>'}</div><footer class="real-dashboard-task-footer"><span>共 ${number(summary.schedule.length)} 项</span><a href="#private-domain">查看全部待办 <i class="ph ph-arrow-right" aria-hidden="true"></i></a></footer></div></section>
  </section>`;

  drawTrendChart(main, summary);

  const priorities = summary.priorityTasks.map((task) => `<button type="button" class="demo-erp-attention-item" data-private-domain-customer-id="${escapeHtml(task.customerId)}"><span>${escapeHtml(task.title)} <b>${number(task.score)}</b></span><small>${escapeHtml(task.action)} · ${escapeHtml(task.badge)}</small><i class="ph ph-arrow-right" aria-hidden="true"></i></button>`).join("");
  const hasBusinessData = summary.metrics.customers > 0 || activeDeals > 0
    || summary.schedule.length > 0 || summary.priorityTasks.length > 0;
  inspector.innerHTML = `<section class="demo-panel demo-dashboard-inspector demo-erp-inspector real-dashboard-inspector${hasBusinessData ? "" : " is-empty"}">
    <header><span class="demo-chip">今日经营简报</span><small>${escapeHtml(updatedAt(summary.updatedAt))}</small></header>
    <div class="real-dashboard-inspector-lead"><h3>${hasBusinessData ? escapeHtml(summary.briefing.title) : "暂无可判断的经营数据"}</h3><p>${hasBusinessData ? escapeHtml(summary.briefing.description) : "当前工作区尚无客户、活跃商机或待办，因此不判断风险高低。"}</p></div>
    <section class="real-dashboard-inspector-group"><div><span>待办事项</span><b>${number(summary.metrics.todos)}</b></div>${summary.schedule.length ? summary.schedule.slice(0, 3).map((item) => `<button type="button" data-demo-action="open-module" data-demo-module="private-domain"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.time)}·${escapeHtml(item.subtitle)}</small></button>`).join("") : "<p>当前没有待办</p>"}</section>
    <section class="real-dashboard-inspector-group"><div><span>重点关注</span><b>${number(summary.priorityTasks.length)}</b></div><div class="demo-erp-attention-list">${priorities || "<p>当前没有确定的优先商机</p>"}</div></section>
    <section class="real-dashboard-inspector-group"><div><span>数据口径</span></div><p>${escapeHtml(summary.scopeLabels.business)} / ${escapeHtml(summary.scopeLabels.todos)}</p><small>${hasBusinessData ? `${number(summary.metrics.riskCustomers)} 个风险客户·可推进 ${number(summary.briefing.closableDeals)} 个商机` : "等待真实业务数据"}</small></section>
    ${hasBusinessData ? `<div class="real-dashboard-briefing"><span>${escapeHtml(summary.briefing.basis)}</span><strong>${escapeHtml(summary.briefing.action)}</strong><small>${escapeHtml(summary.briefing.impact)}</small></div>` : ""}
    <a class="demo-primary" href="${hasBusinessData ? "#private-domain" : "#acquisition"}">${hasBusinessData ? "查看客户跟进" : "前往获客中心"}</a>
  </section>`;
}
