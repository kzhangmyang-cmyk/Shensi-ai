import type { RoiPageState } from "./controller";
import type {
  ActualRoiCurrencyView,
  CashCurrencyView,
  ExpectedRoiCurrencyView,
  GrowthPerformanceResponse
} from "./api";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function expectedRow(view: ExpectedRoiCurrencyView): string {
  const redacted = "amountVisibility" in view
    && view.amountVisibility === "redacted";
  const roiBps = "roiBps" in view ? view.roiBps : null;
  const percentage = roiBps === null ? "不可用" : `${roiBps} bps`;
  return `<li class="roi-expected">
    <strong>预计 ROI</strong>
    <span>${escapeHtml(view.status)} · ${percentage}</span>
    ${redacted ? `<span>详细金额已脱敏</span>` : ""}
    ${view.status === "not_computable" && view.reason
      ? `<button data-action="roi-data-gap" data-reason="${escapeHtml(view.reason)}">
          查看数据缺口</button>` : ""}
  </li>`;
}

function actualRow(view: ActualRoiCurrencyView): string {
  if (view.status === "not_computable") {
    return `<li class="roi-actual">
      <strong>已关账实际 ROI</strong>
      <span>${escapeHtml(view.reason)}</span>
      <button data-action="roi-data-gap"
        data-reason="${escapeHtml(view.reason)}">查看数据缺口</button>
    </li>`;
  }
  const redacted = view.amountVisibility === "redacted";
  return `<li class="roi-actual">
    <strong>已关账实际 ROI</strong>
    <span>${view.roiBps} bps</span>
    ${redacted ? `<span>详细金额已脱敏</span>` : ""}
    <span>closure ${escapeHtml(view.closureVersionId)}</span>
    <span>${escapeHtml(view.formulaVersion)}</span>
  </li>`;
}

function cashRow(view: CashCurrencyView): string {
  const redacted = "amountVisibility" in view
    && view.amountVisibility === "redacted";
  const ratio = (value: unknown) => {
    if (value && typeof value === "object"
      && "status" in value) {
      const record = value as {
        status?: string;
        resultBps?: number | null;
        reason?: string | null;
      };
      return `${escapeHtml(record.status ?? "")} ${
        record.resultBps === null || record.resultBps === undefined
          ? record.reason ?? "" : `${record.resultBps} bps`}`;
    }
    return "";
  };
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
    ? `<li>closure ${escapeHtml(evidence.closureVersionId)}</li>`
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
  return `<section class="growth-panel roi-page">
    <h2>增长 ROI</h2>
    <section class="roi-region roi-expected-region">
      <h3>预计 ROI（planned）</h3>
      <ul>${expected || "<li>无预计数据</li>"}</ul>
    </section>
    <section class="roi-region roi-actual-region">
      <h3>已关账实际 ROI（verified closed result）</h3>
      <ul>${actual || "<li>无实际数据</li>"}</ul>
    </section>
    <section class="roi-region roi-cash-region">
      <h3>现金流</h3>
      <ul>${cash || "<li>无现金流数据</li>"}</ul>
    </section>
    <section class="roi-evidence">
      <h3>闭包证据</h3>
      <ul>
        ${closure}
        ${formula}
        ${calculationHash}
        <li>dataAsOf ${escapeHtml(performance.dataAsOf)}</li>
        ${membership}
        <li>成本覆盖 ${coverage.costCoverageBps} bps</li>
        <li>毛利覆盖 ${coverage.marginCoverageBps} bps</li>
        <li>现金覆盖 ${coverage.cashCoverageBps} bps</li>
        <li>归因覆盖 ${coverage.attributionCoverageBps} bps</li>
      </ul>
    </section>
  </section>`;
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
        ${escapeHtml(state.message)}</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        ${escapeHtml(state.message)}</p></section>`;
    case "ready":
      if (!state.performance) {
        return `<section class="growth-panel"><p>
          请选择 cohort 与币种后查询。</p></section>`;
      }
      return performanceBlock(state.performance);
  }
}
