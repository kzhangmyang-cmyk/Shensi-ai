import type { FinancePageState } from "./controller";
import type { FinanceImportState } from "./import-workflow";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function factRow(fact: {
  id: string;
  factType: string;
  status: string;
  amountMinor: number;
  currency: string;
  revision: number;
  dealId: string | null;
  quoteVersionId: string | null;
}): string {
  const authority = fact.dealId || fact.quoteVersionId
    ? `<span>绑定 ${escapeHtml(fact.dealId ?? fact.quoteVersionId ?? "")}</span>`
    : "";
  const editControl = fact.status === "verified"
    ? "" : `<button data-action="correct-fact" data-id="${escapeHtml(fact.id)}"
        data-etag="${escapeHtml(`"${fact.revision}"`)}">更正</button>`;
  return `<li class="finance-fact" data-fact-id="${escapeHtml(fact.id)}">
    <strong>${escapeHtml(fact.factType)}</strong>
    <span>${escapeHtml(fact.status)}</span>
    <span>${fact.amountMinor} ${escapeHtml(fact.currency)}</span>
    ${authority}
    ${editControl}
  </li>`;
}

function estimateRow(estimate: {
  id: string;
  status: string;
  currency?: string;
  amountMinor?: number;
}): string {
  return `<li class="finance-estimate" data-estimate-id="${escapeHtml(estimate.id)}">
    <strong>估算</strong>
    <span>${escapeHtml(estimate.status)}</span>
    ${estimate.currency ? `<span>${escapeHtml(estimate.currency)}</span>` : ""}
    ${typeof estimate.amountMinor === "number"
      ? `<span>${estimate.amountMinor}</span>` : ""}
  </li>`;
}

function importBlock(state: FinanceImportState): string {
  switch (state.kind) {
    case "idle":
      return `<section class="finance-import"><p>未开始导入。</p></section>`;
    case "uploading":
    case "committing":
    case "polling":
      return `<section class="finance-import"><p>导入处理中…</p></section>`;
    case "preview_ready":
      return `<section class="finance-import">
        <p>预览：共 ${state.preview.totalRows} 行，
          接受 ${state.preview.acceptedRows}，
          拒绝 ${state.preview.rejectedRows}。</p>
        ${state.preview.errors.length > 0
          ? `<p class="growth-conflict">含行级错误，请下载错误明细。</p>` : ""}
      </section>`;
    case "partial_success":
      return `<section class="finance-import"><p class="growth-conflict">
        导入部分成功：${state.operation.acceptedRows}/${state.operation.totalRows}
        行。</p></section>`;
    case "succeeded":
      return `<section class="finance-import">
        <p>导入成功：${state.operation.acceptedRows} 行。</p></section>`;
    case "failed":
      return `<section class="finance-import">
        <p class="growth-error">导入失败：${escapeHtml(state.message)}</p>
      </section>`;
  }
}

export function renderFinancePage(state: FinancePageState): string {
  switch (state.kind) {
    case "loading":
      return `<section class="growth-panel"><p>正在加载财务账本…</p></section>`;
    case "forbidden":
      return `<section class="growth-panel"><p class="growth-forbidden">
        当前工作区无权访问财务账本。</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        ${escapeHtml(state.message)}</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        ${escapeHtml(state.message)}</p></section>`;
    case "ready": {
      const facts = state.facts.map((fact) => factRow(
        fact as unknown as {
          id: string;
          factType: string;
          status: string;
          amountMinor: number;
          currency: string;
          revision: number;
          dealId: string | null;
          quoteVersionId: string | null;
        }
      )).join("");
      const estimates = state.costEstimates.map(estimateRow).join("");
      return `<section class="growth-panel finance-page">
        <h2>财务账本</h2>
        ${importBlock(state.importState)}
        <h3>财务事实</h3>
        <ul>${facts || "<li>暂无财务事实</li>"}</ul>
        <h3>成本估算</h3>
        <ul>${estimates || "<li>暂无成本估算</li>"}</ul>
      </section>`;
    }
  }
}
