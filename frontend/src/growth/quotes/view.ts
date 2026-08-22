import type {
  QuoteVersionRow,
  QuoteWorkbenchState
} from "./controller";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function versionRow(
  version: QuoteVersionRow
): string {
  const quoted = typeof version.quotedAmountMinor === "number"
    ? `<span>金额 ${version.quotedAmountMinor}</span>` : "";
  return `<li class="quote-version" data-version-id="${escapeHtml(version.id)}">
    <strong>v${version.version}</strong>
    <span>${escapeHtml(version.status)}
      · rev ${version.lifecycleRevision}</span>
    ${quoted}
  </li>`;
}

export function renderQuoteWorkbench(state: QuoteWorkbenchState): string {
  switch (state.kind) {
    case "loading_case":
      return `<section class="growth-panel"><p>正在加载报价…</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        ${escapeHtml(state.message)}</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        ${escapeHtml(state.message)}</p></section>`;
    case "hard_blocked":
      return `<section class="growth-panel"><p class="growth-error">
        报价无法成立（非正金额诊断）。</p></section>`;
    case "saving":
    case "submitting":
    case "publication_pending":
      return `<section class="growth-panel"><p>处理中…</p></section>`;
    case "publication_failed":
      return `<section class="growth-panel"><p class="growth-error">
        发布失败：${escapeHtml(state.errorCode)}</p></section>`;
    case "draft_saved":
    case "submitted":
      return `<section class="growth-panel">
        <p>已保存版本 ${escapeHtml(state.version.id)}</p>
        ${versionRow(state.version)}
      </section>`;
    case "editing":
    case "previewing":
    case "preview_ready": {
      const versions = "versions" in state
        ? state.versions.map(versionRow).join("") : "";
      const previewBlock = state.kind === "preview_ready"
        ? `<section class="quote-preview">
            <h3>报价预览</h3>
            <p>金额 ${state.preview.quotedAmountMinor ?? ""}</p>
            ${state.preview.grossMarginBps === null
              ? "<p>毛利率不可用</p>" : ""}
          </section>` : "";
      return `<section class="growth-panel quote-workbench">
        <h2>报价工作台</h2>
        <p>报价案例 ${escapeHtml(state.case.id)}</p>
        ${previewBlock}
        <h3>版本</h3>
        <ul>${versions || "<li>暂无版本</li>"}</ul>
      </section>`;
    }
  }
}
