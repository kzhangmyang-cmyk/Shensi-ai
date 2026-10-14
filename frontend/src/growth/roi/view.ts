import type { RoiPageState } from "./controller";
import type {
  ActualRoiCurrencyView,
  CashCurrencyView,
  ExpectedRoiCurrencyView,
  GrowthPerformanceResponse
} from "./api";
import { renderRoiTabList, roiTabPanelAttributes } from "./tabs";
import { roiReasonLabel, roiRequestMessage, roiStatusLabel } from "./labels";

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

function localDateTimeParts(value: string | Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    millisecond: date.getMilliseconds()
  };
}

function padded(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function toLocalDateTimeInput(value: string | Date): string {
  const date = localDateTimeParts(value);
  if (!date) return "";
  return `${date.year}-${padded(date.month)}-${padded(date.day)}`
    + `T${padded(date.hour)}:${padded(date.minute)}:${padded(date.second)}`
    + `.${padded(date.millisecond, 3)}`;
}

/**
 * Keeps the visible date compact and independent of the browser's native
 * date-control locale. The associated native editor continues to retain the
 * exact second and millisecond value.
 */
export function formatRoiAsOfSummary(value: string | Date): string {
  const date = localDateTimeParts(value);
  if (!date) return "时间待确认";
  return `${date.year}年${padded(date.month)}月${padded(date.day)}日`
    + ` ${padded(date.hour)}:${padded(date.minute)}`;
}

export function formatRoiAsOfPrecision(value: string | Date): string {
  const date = localDateTimeParts(value);
  if (!date) return "时间待确认";
  return `${formatRoiAsOfSummary(value)}:${padded(date.second)}`
    + `.${padded(date.millisecond, 3)}`;
}

function expectedRow(view: ExpectedRoiCurrencyView): string {
  const redacted = "amountVisibility" in view
    && view.amountVisibility === "redacted";
  const roiBps = "roiBps" in view ? view.roiBps : null;
  const percentage = roiBps === null ? "不可用" : `${roiBps} bps`;
  return `<li class="roi-expected">
    <strong>预计 ROI</strong>
    <span>${roiStatusLabel(view.status)} · ${percentage}</span>
    ${redacted ? `<span>详细金额已脱敏</span>` : ""}
    ${view.status === "not_computable" && view.reason
      ? `<button data-action="roi-data-gap" data-reason="${escapeHtml(view.reason)}">
          ${escapeHtml(roiReasonLabel(view.reason))} · 查看数据缺口</button>` : ""}
  </li>`;
}

function actualRow(view: ActualRoiCurrencyView): string {
  if (view.status === "not_computable") {
    return `<li class="roi-actual">
      <strong>已关账实际 ROI</strong>
      <span>${escapeHtml(roiReasonLabel(view.reason))}</span>
      <button data-action="roi-data-gap"
        data-reason="${escapeHtml(view.reason)}">查看数据缺口</button>
    </li>`;
  }
  const redacted = view.amountVisibility === "redacted";
  return `<li class="roi-actual">
    <strong>已关账实际 ROI</strong>
    <span>${view.roiBps} bps</span>
    ${redacted ? `<span>详细金额已脱敏</span>` : ""}
    <span>结账版本 ${escapeHtml(view.closureVersionId)}</span>
    <span>${escapeHtml(view.formulaVersion)}</span>
  </li>`;
}

function cashRow(view: CashCurrencyView): string {
  const redacted = "amountVisibility" in view
    && view.amountVisibility === "redacted";
  const ratio = (value: CashCurrencyView["contractRoas"] | CashCurrencyView["cashMultiple"] | CashCurrencyView["collectionRate"]) =>
    `${roiStatusLabel(value.status)} · ${value.status === "computed"
      ? `${value.valueBps} bps` : escapeHtml(roiReasonLabel(value.reason))}`;
  return `<li class="roi-cash">
    <strong>现金流</strong>
    <span>合同 ROAS：${ratio(view.contractRoas)}</span>
    <span>现金倍数：${ratio(view.cashMultiple)}</span>
    <span>回款率：${ratio(view.collectionRate)}</span>
    ${redacted ? `<span>详细金额已脱敏</span>` : ""}
  </li>`;
}

function performanceBlock(performance: GrowthPerformanceResponse): string {
  const expected = (performance.expectedRoiByCurrency ?? [])
    .map(expectedRow).join("");
  const actual = (performance.actualRoiByCurrency ?? [])
    .map(actualRow).join("");
  const cash = (performance.cashByCurrency ?? []).map(cashRow).join("");
  const computedActual = (performance.actualRoiByCurrency ?? [])
    .find((row) => row.status === "computed");
  const evidence = computedActual
    ? computedActual as unknown as {
        closureVersionId: string;
        formulaVersion: string;
        calculationHash: string;
        membershipSnapshotHash?: string;
        dataAsOf: string;
        coverage: {
          costCoverageBps: number;
          marginCoverageBps: number;
          cashCoverageBps: number;
          attributionCoverageBps: number;
        };
      }
    : null;
  const closure = evidence
    ? `<li>结账版本 ${escapeHtml(evidence.closureVersionId)}</li>`
    : "<li>无已发布闭包</li>";
  const queryRecord = performance.query as unknown as Record<string, unknown>;
  const formula = evidence
    ? `<li>公式 ${escapeHtml(evidence.formulaVersion)}</li>`
    : `<li>公式 ${escapeHtml(String(queryRecord.formulaVersion ?? ""))}</li>`;
  const calculationHash = evidence
    ? `<li>计算哈希 ${escapeHtml(evidence.calculationHash)}</li>`
    : `<li>计算哈希 ${escapeHtml(String(queryRecord.calculationHash ?? ""))}</li>`;
  const membership = evidence
    ? `<li>成员快照 ${escapeHtml(evidence.membershipSnapshotHash ?? "无")}</li>`
    : "<li>成员快照 无</li>";
  const coverage = evidence?.coverage ?? performance.coverage;
  return `<div class="roi-results roi-analysis-grid">
    <div class="roi-tab-panels">
    <section class="roi-region roi-expected-region" ${roiTabPanelAttributes("expected")}>
      <h3>预计 ROI</h3>
      <ul>${expected || "<li>无预计数据</li>"}</ul>
    </section>
    <section class="roi-region roi-actual-region" ${roiTabPanelAttributes("actual")}>
      <h3>已关账实际 ROI</h3>
      <ul>${actual || "<li>无实际数据</li>"}</ul>
    </section>
    <section class="roi-region roi-cash-region" ${roiTabPanelAttributes("cash")}>
      <h3>现金流</h3>
      <ul>${cash || "<li>无现金流数据</li>"}</ul>
    </section>
    </div>
    <section class="roi-evidence">
      <h3>计算依据</h3>
      <ul>
        ${closure}
        ${formula}
        ${calculationHash}
        <li>数据截至 ${escapeHtml(businessDateTime(performance.dataAsOf))}</li>
        ${membership}
        <li>成本覆盖 ${coverage.costCoverageBps} bps</li>
        <li>毛利覆盖 ${coverage.marginCoverageBps} bps</li>
        <li>现金覆盖 ${coverage.cashCoverageBps} bps</li>
        <li>归因覆盖 ${coverage.attributionCoverageBps} bps</li>
      </ul>
    </section>
  </div>`;
}

function metricGuide(): string {
  return `<section class="roi-metric-guide" id="roi-data-explanation" tabindex="-1" aria-label="ROI 口径说明"><h3>口径说明</h3><div class="roi-metric-guide-head"><span>指标</span><span>说明</span></div><dl>
    <div><dt>预计 ROI</dt><dd>基于预计收益与投入</dd></div>
    <div><dt>实际 ROI</dt><dd>使用已关账业务数据</dd></div>
    <div><dt>现金回收</dt><dd>使用已核对回款</dd></div>
  </dl><p><i class="ph ph-info" aria-hidden="true"></i> 未准备好的数据会明确标注。</p></section>`;
}

function cohortLabel(value: unknown): string {
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name : String(record.id ?? "未命名获客批次");
  return name;
}

function filterBlock(state: Extract<RoiPageState, { kind: "ready" }>): string {
  const selectedCohort = state.filters?.cohortId ?? state.cohorts[0]?.id ?? "";
  const selectedCurrency = state.filters?.currency ?? "CNY";
  const asOf = toLocalDateTimeInput(state.filters?.asOf ?? new Date());
  const asOfSummary = formatRoiAsOfSummary(asOf);
  const asOfPrecision = formatRoiAsOfPrecision(asOf);
  return `<form class="roi-filters" data-roi-filters>
    <label>获客批次
      <select data-roi-cohort required>
        ${state.cohorts.length === 0 ? `<option value="">暂无可用批次</option>` : state.cohorts.map((cohort) => `<option value="${escapeHtml(cohort.id)}" ${cohort.id === selectedCohort ? "selected" : ""}>${escapeHtml(cohortLabel(cohort))}</option>`).join("")}
      </select>
    </label>
    <label>币种
      <select data-roi-currency>
        ${["CNY", "USD", "EUR"].map((currency) => `<option value="${currency}" ${currency === selectedCurrency ? "selected" : ""}>${currency}</option>`).join("")}
      </select>
    </label>
    <details class="roi-as-of-field" data-roi-as-of-field>
      <summary data-roi-as-of-summary-action aria-label="数据截至 ${escapeHtml(asOfPrecision)}，展开可调整精确时间">
        <span class="roi-as-of-label">数据截至</span>
        <time class="roi-as-of-summary-value" data-roi-as-of-summary datetime="${escapeHtml(asOf)}" title="${escapeHtml(asOfPrecision)}">${escapeHtml(asOfSummary)}</time>
        <span class="roi-as-of-disclosure" aria-hidden="true">调整</span>
        <i class="ph ph-caret-down" aria-hidden="true"></i>
      </summary>
      <div class="roi-as-of-editor">
        <label for="roi-as-of-input">精确时间</label>
        <input id="roi-as-of-input" type="datetime-local" data-roi-as-of value="${escapeHtml(asOf)}" step="0.001" required aria-describedby="roi-as-of-help">
        <p id="roi-as-of-help">按本机时区查询，可精确到毫秒。</p>
        <span class="sr-only" data-roi-as-of-precision>当前精确截止时间：${escapeHtml(asOfPrecision)}</span>
      </div>
    </details>
    <button type="submit" data-roi-action="query" ${selectedCohort ? "" : "disabled"}>查询真实 ROI</button>
  </form>`;
}

function pendingBasisCards(state: Extract<RoiPageState, { kind: "ready" }>): string {
  const status = state.cohorts.length > 0 ? "等待查询" : "待选择批次";
  return `<section class="roi-evidence" aria-label="ROI 计算依据"><h3>计算依据</h3><div class="roi-basis-cards" role="list">
    <article role="listitem"><span>获客成本</span><small><i class="ph ph-circle" aria-hidden="true"></i>${status}</small></article>
    <article role="listitem"><span>关联商机</span><small><i class="ph ph-circle" aria-hidden="true"></i>${status}</small></article>
    <article role="listitem"><span>已核对回款</span><small><i class="ph ph-circle" aria-hidden="true"></i>${status}</small></article>
  </div><a href="#growth/finance">查看财务资料</a></section>`;
}

export function renderRoiPage(state: RoiPageState): string {
  switch (state.kind) {
    case "loading":
      return `<section class="growth-panel"><p>正在加载 ROI…</p></section>`;
    case "forbidden":
      return `<section class="growth-panel"><p class="growth-forbidden">
        当前工作区无权读取增长绩效。</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        ${escapeHtml(roiRequestMessage(state.message))}</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        ${escapeHtml(roiRequestMessage(state.message))}</p></section>`;
    case "ready":
      {
        const analysis = state.performance
          ? performanceBlock(state.performance)
          : `<div class="roi-results roi-results-placeholder roi-analysis-grid" aria-label="ROI 分析结构">
              <div class="roi-tab-panels">
                <section class="roi-region roi-expected-region" ${roiTabPanelAttributes("expected")}><i class="ph ph-chart-line-up" aria-hidden="true"></i><h3>${state.cohorts.length > 0 ? "选择范围后查询" : "完成获客运行后查看投入产出"}</h3><p>${state.cohorts.length > 0 ? "选择获客批次、币种和截止时间后生成分析。" : "系统将按所选批次和币种计算，并标出缺失的数据。"}</p></section>
                <section class="roi-region roi-actual-region" ${roiTabPanelAttributes("actual")}><h3>已关账实际 ROI</h3><p>暂无已关账结果</p></section>
                <section class="roi-region roi-cash-region" ${roiTabPanelAttributes("cash")}><h3>现金回收</h3><p>暂无现金回收数据</p></section>
              </div>
              ${pendingBasisCards(state)}
            </div>`;
      return `<section class="growth-panel roi-page">
        <div class="roi-page-anchor-row"><a class="roi-data-explanation-link" href="#growth/roi" data-roi-action="data-explanation" aria-controls="roi-data-explanation"><i class="ph ph-info" aria-hidden="true"></i>数据说明</a></div>
        ${filterBlock(state)}
        ${state.queryPending ? `<p role="status">正在查询 ROI…</p>` : ""}
        ${state.queryError ? `<p class="growth-error" role="alert">${escapeHtml(roiRequestMessage(state.queryError))}</p>` : ""}
        ${state.cohorts.length === 0 ? `<div class="roi-cohort-notice"><i class="ph ph-info" aria-hidden="true"></i><span>当前没有可分析批次</span><a href="#acquisition">前往获客中心</a></div>` : ""}
        <section class="roi-analysis-shell" aria-label="ROI 分析">
          ${renderRoiTabList()}
          ${analysis}
        </section>
        ${metricGuide()}
      </section>`;
      }
  }
}
