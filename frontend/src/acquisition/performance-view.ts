import type { AcquisitionPerformanceDto } from "./performance-api";

export type AcquisitionPerformanceViewState = {
  status: "loading" | "ready" | "empty" | "unauthorized" | "error";
  data: AcquisitionPerformanceDto | null;
  error?: string;
  aiInterpretation: string | null;
  aiStatus: "idle" | "loading" | "ready" | "error";
  aiError?: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function money(currency: string, minor: number) {
  return `${escapeHtml(currency)} ${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function factList(
  title: string,
  facts: AcquisitionPerformanceDto["briefingFacts"]["headlines"]
) {
  return `
    <section>
      <h4>${escapeHtml(title)}</h4>
      ${facts.length ? `<ul>${facts.map((item) => `
        <li>
          <span>${escapeHtml(item.text)}</span>
          <small>metricId: ${escapeHtml(item.metricId)}</small>
          <details><summary>查看证据</summary><code>${escapeHtml(item.evidenceRefs.join(", ") || "暂无证据引用")}</code></details>
        </li>
      `).join("")}</ul>` : "<p>暂无相关事实。</p>"}
    </section>
  `;
}
export function renderAcquisitionPerformance(
  state: AcquisitionPerformanceViewState
) {
  if (state.status === "loading") {
    return `<div class="replica-performance-state" role="status">正在读取真实经营结果，不会用演示数字替代…</div>`;
  }
  if (state.status === "unauthorized") {
    return `<div class="replica-performance-state is-error" role="alert">请先登录后查看真实经营结果。</div>`;
  }
  if (state.status === "error") {
    return `<div class="replica-performance-state is-error" role="alert">${escapeHtml(state.error || "真实经营接口不可用")}</div>`;
  }
  if (!state.data || state.status === "empty") {
    return `<div class="replica-performance-state" role="status">当前时间范围没有真实获客经营数据。</div>`;
  }
  const data = state.data;
  const cards = [
    ["发现候选", data.counts.discovered],
    ["高意向", data.counts.highIntent],
    ["转 CRM", data.counts.converted],
    ["成交", data.counts.won]
  ];
  const funnel = [
    ["发现", data.counts.discovered, null],
    ["高意向", data.counts.highIntent, data.rates.highIntentRate],
    ["批准", data.counts.approved, data.rates.approvalRate],
    ["转 CRM", data.counts.converted, data.rates.crmConversionRate],
    ["联系", data.counts.contacted, data.rates.contactRate],
    ["报价", data.counts.quoted, data.rates.quoteRate],
    ["成交", data.counts.won, data.rates.winRate]
  ] as const;
  const ai = state.aiStatus === "loading"
    ? "正在生成 AI 解读…"
    : state.aiStatus === "ready" && state.aiInterpretation
      ? escapeHtml(state.aiInterpretation)
      : state.aiStatus === "error"
        ? `AI 解读暂不可用：${escapeHtml(state.aiError || "模型调用失败")}。上方确定性事实仍然有效。`
        : "尚未生成 AI 解读；确定性事实已可用。";
  return `
    <div class="replica-performance-summary">
      ${cards.map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("")}
    </div>
    <div class="replica-performance-grid">
      <section class="replica-performance-funnel">
        <h3>经营漏斗</h3>
        ${funnel.map(([label, value, rate]) => `<div><span>${label}</span><strong>${value}</strong><small>${percent(rate)}</small></div>`).join("")}
      </section>
      <section class="replica-performance-money">
        <h3>分币种经营金额</h3>
        ${data.valuesByCurrency.length ? data.valuesByCurrency.map((item) => `
          <article>
            <strong>${escapeHtml(item.currency)}</strong>
            <span>预计管道 ${money(item.currency, item.estimatedPipelineMinor)}</span>
            <span>已报价 ${money(item.currency, item.quotedMinor)}</span>
            <span>成交合同额 ${money(item.currency, item.wonContractMinor)}</span>
          </article>
        `).join("") : "<p>暂无可展示金额。</p>"}
        <p class="replica-performance-cost">已记录 API/执行成本：${data.cost.status === "available" && data.cost.currency !== null && data.cost.executionCostMinor !== null
          ? money(data.cost.currency, data.cost.executionCostMinor)
          : "存在多币种，不能合并"}</p>
        <p class="replica-performance-gap"><strong>ROI 暂不可计算</strong>：缺少完整渠道成本、财务核销或可验证毛利。</p>
      </section>
      <section class="replica-performance-quality">
        <h3>数据质量与缺口</h3>
        ${data.dataQuality.truncated
          ? '<strong role="status">结果已按安全上限截断，当前指标仅代表已展示的有界数据。</strong>'
          : ""}
        <span>归因缺失 ${data.dataQuality.missingAttribution}</span>
        <span>财务数据缺失 ${data.dataQuality.missingFinancial}</span>
        <span>最近对账 ${data.dataQuality.lastReconciledAt ? escapeHtml(data.dataQuality.lastReconciledAt) : "尚无"}</span>
      </section>
    </div>
    <div class="replica-performance-briefing">
      <header><div><span>老板简报</span><h3>事实、AI 解读与数据缺口</h3></div><button type="button" data-performance-action="generate">生成今日经营简报</button></header>
      <div class="replica-performance-facts">
        ${factList("确定性事实", data.briefingFacts.headlines)}
        ${factList("主要风险", data.briefingFacts.risks)}
        ${factList("建议动作", data.briefingFacts.actions)}
      </div>
      <section class="replica-performance-ai"><h4>AI 解读</h4><p>${ai}</p></section>
    </div>
  `;
}
