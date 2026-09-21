import type { FinancePageState } from "./controller";
import type { FinanceImportState } from "./import-workflow";
import type { FinanceImportRowError, FinanceDocumentInspection, FinanceImportMapping } from "./api";

export interface FinanceImportSelection {
  kind: "readonly" | "acquisition_cost" | "financial_fact";
  file: { name: string; size: number } | null;
  document?: FinanceDocumentInspection | null;
  mapping?: FinanceImportMapping;
}

const DOCUMENT_KIND_LABELS = { balance_sheet: "资产负债表", income_statement: "利润表", cash_flow_statement: "现金流量表", ledger: "明细账", unknown: "待确认区域" };
const DOCUMENT_UNCERTAINTY_LABELS: Readonly<Record<string, string>> = {
  currency_not_verified: "币种待确认",
  period_not_verified: "报表期间待确认",
  unit_not_verified: "金额单位待确认",
  formula_value_unknown: "部分公式没有可读取的结果",
  formula_cache_unverified: "公式缓存值尚未核对",
  cell_text_omitted: "部分较长单元格内容未展示",
  inspection_truncated: "资料较多，本次仅识别部分内容",
  region_kind_unknown: "这一区域的用途待确认",
  header_not_verified: "列标题含义待确认",
  document_regions_unverified: "资料区域划分待确认",
  document_structure_unverified: "文档结构尚待核对，可先阅读已提取文字",
  document_text_segmented: "较长文字已分段展示，原始位置保留",
  pdf_text_layout_unverified: "PDF 文字顺序与版面关系待核对",
  pdf_pages_without_text: "部分 PDF 页面未提取到文字，可先阅读其余页面",
  docx_main_document_only: "本次读取 DOCX 正文",
  docx_non_body_content_omitted: "页眉、页脚等正文外内容未读取",
  docx_nested_table_omitted: "嵌套表格内容未读取",
  docx_field_cache_unverified: "Word 域缓存内容仅读取，未重新计算",
  docx_table_merge_layout_unverified: "表格合并单元格关系待核对",
  model_context_truncated: "资料较多，AI 本次只读取了部分内容",
  model_output_invalid_json: "模型返回的内容不是有效 JSON",
  model_output_schema_shape: "模型返回的报告字段或结构不符合要求",
  model_output_source_reference: "模型使用了不存在、重复或不符合要求的来源引用",
  model_output_reference_or_quantity: "模型正文引用不完整，或包含未经原文引用的数字及单位",
  model_output_output_limits: "模型输出超出报告条数、长度或引用数量限制",
  source_cells_omitted: "批量资料较多，已按文件保留部分来源，其余内容未进入本次分析",
  batch_sources_selected: "本次来源为所选文件集合，未自动合并币种或期间"
};
function documentSourcePosition(cell: FinanceDocumentInspection["cells"][number]): string {
  if ("sheetName" in cell) return `${cell.sheetName} · 第 ${cell.row} 行第 ${cell.column} 列`;
  const position = "page" in cell ? `PDF · 第 ${cell.page} 页 · 第 ${cell.item} 项`
    : "paragraph" in cell ? `DOCX · 第 ${cell.paragraph} 段`
      : `DOCX · 第 ${cell.table} 个表格 · 第 ${cell.row} 行第 ${cell.column} 列`;
  return `${position}${"segment" in cell && typeof cell.segment === "number" ? ` · 片段 ${cell.segment}` : ""}`;
}
export function documentUncertaintyHints(values: readonly string[]): string {
  return [...new Set(values.map(value => {
    if (Object.prototype.hasOwnProperty.call(DOCUMENT_UNCERTAINTY_LABELS, value)) return DOCUMENT_UNCERTAINTY_LABELS[value];
    if (/[\p{Script=Han}]/u.test(value) && /^[\p{Script=Han}\p{N}\s，。；：、（）“”‘’！？《》—…·]+$/u.test(value)) return value;
    return "另有内容待核对，可先阅读已识别资料";
  }))].join("；");
}

function documentPreview(document: FinanceDocumentInspection, canReadWithModel: boolean): string {
  const modelLabels = { not_requested: "尚未请求 AI 阅读", consent_required: "需要点击下方按钮授权 AI 阅读", completed: "AI 阅读已完成（只读，未核对入账）", unavailable: "AI 服务暂不可用，仍可核对下方原始资料", invalid_output: "AI 返回内容未通过校验，未作为分析依据" };
  return `<section aria-label="只读资料预览"><h4>${escapeHtml(document.fileName)}</h4>
    <p role="status">${escapeHtml(modelLabels[document.modelStatus])}</p>
    <div class="finance-import-form"><button type="button" data-action="read-finance-document" ${canReadWithModel ? "" : "disabled"}>让 AI 读取这份资料</button></div>
    <p>点击后会将这份资料交由已配置模型读取，并用于本工作区的顾问文字和语音追问；不会写入账本。</p>
    ${canReadWithModel ? "" : "<p>当前账号可只读识别文件；AI 阅读需要财务委员会运行权限。</p>"}
    ${document.selectedForConversation ? '<p>这份只读资料已选作追问来源。<a href="#agents">向智能体追问</a></p><button type="button" data-action="clear-finance-document-selection">取消当前资料，使用已确认报表</button>' : ""}
    <p>原文件只读识别，不等于已验证报表或入账成功。</p>
    <p>${document.missingStatements.length ? `尚未识别：${document.missingStatements.map(kind => DOCUMENT_KIND_LABELS[kind]).join("、")}。可先阅读现有资料，不必补齐三表。` : "已识别三类报表，仍需人工核对其期间与内容。"}</p>
    <ul>${document.regions.map(region => `<li>${escapeHtml(region.sheetName)} · ${DOCUMENT_KIND_LABELS[region.kind]} · 第 ${region.startRow}–${region.endRow} 行${region.uncertain.length ? ` · ${escapeHtml(documentUncertaintyHints(region.uncertain))}` : ""}</li>`).join("")}</ul>
    ${document.uncertain.length ? `<p>待确认：${escapeHtml(documentUncertaintyHints(document.uncertain))}</p>` : ""}
    <details><summary>原始来源预览（${document.cells.length} 条已返回内容）</summary><div class="finance-table-wrap"><table><thead><tr><th>来源</th><th>原文</th></tr></thead><tbody>${document.cells.slice(0, 30).map(cell => `<tr data-finance-source-ref="${escapeHtml(cell.sourceRef)}"><td>${escapeHtml(documentSourcePosition(cell))}<small>${escapeHtml(cell.sourceRef)}</small></td><td>${escapeHtml(cell.text)}${"valueStatus" in cell && cell.valueStatus === "cached_formula" ? "<small>公式缓存值，未重新计算或验证</small>" : ""}</td></tr>`).join("")}</tbody></table></div>${document.cells.length > 30 ? "<p>这里只展示前 30 条内容，不能视为完整资料。</p>" : ""}</details>
    ${document.observations.length ? `<h4>AI 阅读摘要</h4><ul>${document.observations.map(item => `<li>${escapeHtml(item.text)}<small> 依据：${escapeHtml(item.sourceRefs.join("、"))}</small></li>`).join("")}</ul>` : ""}
  </section>`;
}

function mappingFields(selection: FinanceImportSelection | undefined): string {
  if (!selection || selection.kind === "readonly") return "";
  const headers = [...new Set((selection.document?.regions ?? []).flatMap(region =>
    (selection.document?.cells ?? []).filter(cell => "sheetName" in cell && cell.sheetName === region.sheetName && cell.row === region.headerRow).map(cell => cell.text)).filter(Boolean))];
  const fields = selection.kind === "acquisition_cost" ? ["externalId", "category", "amount", "currency", "businessOccurredAt", "provenance"] : ["externalId", "factType", "amount", "currency", "businessOccurredAt", "provenance"];
  return `<details><summary>核对列含义（可选）</summary><p>选择原表中对应的列；币种、日期不设置默认值。留空时由服务端按原表头识别，歧义需核对后重试。</p><datalist id="financeColumnNames">${headers.map(header => `<option value="${escapeHtml(header)}"></option>`).join("")}</datalist>${fields.map(field => `<label>${IMPORT_FIELD_LABELS[field]}<input data-finance-mapping="${field}" list="financeColumnNames" value="${escapeHtml(selection.mapping?.[field] ?? "")}" placeholder="原表列名"></label>`).join("")}</details>`;
}

const IMPORT_ROW_ERROR_LABELS: Record<FinanceImportRowError["code"], string> = {
  spreadsheet_formula_forbidden: "含公式，请改为已核对的数值",
  verified_import_forbidden: "不能直接导入已核对状态，请使用待核对状态",
  required_field_missing: "缺少必填字段，请检查表头和数据",
  money_invalid: "金额格式无效",
  currency_invalid: "币种无效，请填写标准币种代码，例如 CNY",
  business_time_invalid: "业务发生时间无效",
  commercial_binding_invalid: "商机与报价的关联依据无效",
  row_identity_conflict: "记录标识与已有数据冲突",
  financial_fact_conflict: "财务事实与已有记录冲突",
  financial_fact_amount_invalid: "财务事实金额无效",
  amount_out_of_range: "金额超出支持范围"
};

const IMPORT_FIELD_LABELS: Readonly<Record<string, string>> = {
  externalId: "记录编号", category: "费用类别", amount: "金额", currency: "币种",
  businessOccurredAt: "业务发生时间", provenance: "数据来源", status: "核对状态",
  factType: "财务事项类型", revenue: "收入", grossProfit: "毛利",
  candidateId: "线索关联", customerId: "客户关联", dealId: "商机关联", quoteVersionId: "报价关联"
};

const IMPORT_ERROR_FIXES: Readonly<Record<FinanceImportRowError["code"], string>> = {
  spreadsheet_formula_forbidden: "请将公式转换为已核对的实际值后重新预览。",
  verified_import_forbidden: "请使用待核对状态，入账后的核对另行完成。",
  required_field_missing: "请核对原表对应列的含义及必填值；未识别到列与单元格留空都需确认，不必先改成技术模板。",
  money_invalid: "请核对金额列及金额格式，使用如 1234.56 的数字值。",
  currency_invalid: "请确认实际币种，例如人民币对应 CNY，不要将未知币种当作默认值。",
  business_time_invalid: "请核对实际业务日期及时间格式，避免将报表标题或汇总行识别为日期。",
  commercial_binding_invalid: "请核对所关联的客户、商机或报价是否正确。",
  row_identity_conflict: "请核对记录编号及是否已导入，避免重复写入。",
  financial_fact_conflict: "请核对已有财务记录与本次数据是否重复或矛盾。",
  financial_fact_amount_invalid: "请核对收入、毛利及金额之间的关系。",
  amount_out_of_range: "请核对金额单位与数值是否有误，不要截断或舍弃超限部分。"
};

function importErrorSummary(errors: readonly FinanceImportRowError[]): string {
  const groups = new Map<string, { field: string; reason: string; fix: string; rows: Set<number> }>();
  for (const error of errors) {
    const knownField = typeof error.field === "string" && Object.prototype.hasOwnProperty.call(IMPORT_FIELD_LABELS, error.field);
    const knownReason = Object.prototype.hasOwnProperty.call(IMPORT_ROW_ERROR_LABELS, error.code);
    const field = knownField ? IMPORT_FIELD_LABELS[error.field!]! : "未明确字段";
    const key = JSON.stringify([error.field, error.code]);
    let group = groups.get(key);
    if (!group) {
      group = {
        field,
        reason: knownReason ? IMPORT_ROW_ERROR_LABELS[error.code] : "数据需要核对",
        fix: knownReason ? IMPORT_ERROR_FIXES[error.code] : "服务端未提供可展示的具体原因，请核对原表或联系管理员。",
        rows: new Set()
      };
      groups.set(key, group);
    }
    group.rows.add(error.rowNumber);
  }
  const all = [...groups.values()];
  return `<p>按字段和原因汇总为 ${all.length} 类问题。同一行可能涉及多类问题，行数不相加。</p>
    <ul class="finance-import-errors">${all.slice(0, 8).map(group => {
      const rows = [...group.rows].sort((a, b) => a - b);
      return `<li><strong>${escapeHtml(group.field)}：${escapeHtml(group.reason)}</strong>
        <p>影响 ${rows.length} 行；数据行号 ${rows.slice(0, 5).join("、")}${rows.length > 5 ? " 等" : ""}。</p>
        <p>${escapeHtml(group.fix)}</p></li>`;
    }).join("")}</ul>${all.length > 8 ? `<p>另有 ${all.length - 8} 类问题，先处理上述问题后重新预览。</p>` : ""}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const FACT_TYPE_LABELS: Record<string, string> = {
  contract_won: "合同赢单",
  payment_received: "回款",
  revenue_recognized: "收入确认",
  cogs_recognized: "销售成本确认",
  refund: "退款",
  bad_debt_written_off: "坏账核销"
};

const COST_CATEGORY_LABELS: Record<string, string> = {
  api: "API 调用",
  media: "媒体投放",
  content: "内容制作",
  agency: "代理服务",
  operation: "运营支出"
};

const FINANCE_STATUS_LABELS: Record<string, string> = {
  pending: "待核对",
  verified: "已核对",
  rejected: "已拒绝",
  reversed: "已冲销",
  draft: "草稿",
  active: "已启用",
  superseded: "已替代"
};

const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  wechat: "微信",
  weibo: "微博",
  xiaohongshu: "小红书"
};

function presentationLabel(value: string, labels: Readonly<Record<string, string>>): string {
  return labels[value] ?? value;
}

function formatAmountMinor(amountMinor: number | undefined, currency: string | undefined): string {
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) return "—";
  let digits = 2;
  if (currency) {
    try {
      digits = new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency,
        currencyDisplay: "code"
      }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      return new Intl.NumberFormat("zh-CN").format(amountMinor);
    }
  }
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format((amountMinor ?? 0) / 10 ** digits);
}

function financeStatus(status: string): string {
  return `<span class="finance-status">${escapeHtml(
    presentationLabel(status, FINANCE_STATUS_LABELS)
  )}</span>`;
}

function readonlyAction(): string {
  return '<span class="finance-readonly-action" title="当前记录暂无可用操作">只读</span>';
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
  const authority = fact.dealId
    ? `<span class="finance-linked-document">商机 ${escapeHtml(fact.dealId)}</span>`
    : fact.quoteVersionId
      ? `<span class="finance-linked-document">报价单 ${escapeHtml(fact.quoteVersionId)}</span>`
      : "未关联";
  return `<tr class="finance-fact" data-fact-id="${escapeHtml(fact.id)}" data-finance-status="${escapeHtml(fact.status)}">
    <td><strong>${escapeHtml(presentationLabel(fact.factType, FACT_TYPE_LABELS))}</strong></td>
    <td class="finance-amount">${formatAmountMinor(fact.amountMinor, fact.currency)}</td>
    <td class="finance-currency">${escapeHtml(fact.currency)}</td>
    <td>${financeStatus(fact.status)}</td>
    <td>${authority}</td>
    <td>${readonlyAction()}</td>
  </tr>`;
}

function costEntryRow(entry: {
  id: string;
  category: string;
  platform: string;
  status: string;
  amountMinor: number;
  currency: string;
}): string {
  return `<tr class="finance-fact" data-cost-entry-id="${escapeHtml(entry.id)}" data-finance-status="${escapeHtml(entry.status)}">
    <td><strong>${escapeHtml(presentationLabel(entry.category, COST_CATEGORY_LABELS))}</strong></td>
    <td class="finance-amount">${formatAmountMinor(entry.amountMinor, entry.currency)}</td>
    <td class="finance-currency">${escapeHtml(entry.currency)}</td>
    <td>${financeStatus(entry.status)}</td>
    <td>${escapeHtml(presentationLabel(entry.platform, PLATFORM_LABELS))}</td>
    <td>${readonlyAction()}</td>
  </tr>`;
}

function estimateRow(estimate: {
  id: string;
  status: string;
  currency?: string;
  amountMinor?: number;
}): string {
  return `<tr class="finance-estimate" data-estimate-id="${escapeHtml(estimate.id)}" data-finance-status="${escapeHtml(estimate.status)}">
    <td><strong>获客成本估算</strong></td>
    <td class="finance-amount">${formatAmountMinor(estimate.amountMinor, estimate.currency)}${estimate.currency ? `<small class="finance-currency">${escapeHtml(estimate.currency)}</small>` : ""}</td>
    <td>${financeStatus(estimate.status)}</td>
  </tr>`;
}

function importBlock(state: FinanceImportState, selection?: FinanceImportSelection, canImport = true, canReadWithModel = true): string {
  const readonly = !selection || selection.kind === "readonly";
  const busy = state.kind === "uploading"
    || state.kind === "inspecting"
    || state.kind === "committing"
    || state.kind === "polling";
  const form = `<form class="finance-import-form" data-finance-import-form novalidate aria-busy="${busy}">
    <label>处理方式（可选）
      <select name="kind" data-finance-import-kind ${busy ? "disabled" : ""}>
        <option value="readonly" ${!selection || selection.kind === "readonly" ? "selected" : ""}>只读识别（不入账）</option>
        ${canImport ? `<option value="acquisition_cost" ${selection?.kind === "acquisition_cost" ? "selected" : ""}>获客成本明细 · 核对后入账</option>
        <option value="financial_fact" ${selection?.kind === "financial_fact" ? "selected" : ""}>财务事实</option>` : ""}
      </select>
    </label>
    <label class="finance-file-picker">
      <span>数据文件</span>
      <span class="finance-file-button"><i class="ph ph-file-arrow-up" aria-hidden="true"></i> 选择文件</span>
      <input id="financeImportFile" type="file" multiple accept="${readonly ? ".csv,.xls,.xlsx,.pdf,.docx" : ".csv,.xlsx"}" data-finance-import-file aria-describedby="financeImportSelection" ${busy && state.kind !== "inspecting" ? "disabled" : ""}>
    </label>
    <label class="finance-dropzone" for="financeImportFile" data-finance-import-dropzone>
      <i class="ph ph-file" aria-hidden="true"></i>
      <strong>选择文件</strong>
      <span>或将文件拖拽到此处</span>
      <small>${readonly ? "CSV、XLS、XLSX、文字 PDF、DOCX" : "CSV、XLSX"} · 最大 5 MB</small>
    </label>
    <p id="financeImportSelection" data-finance-import-selection role="status">${selection?.file
      ? `已选择：${escapeHtml(selection.file.name)} · ${Math.max(1, Math.ceil(selection.file.size / 1024))} KB`
      : "尚未选择文件"}</p>
    ${canImport ? mappingFields(selection) : ""}
    <button type="submit" ${busy ? "disabled" : ""}>${!selection || selection.kind === "readonly" ? "只读识别" : "预览导入"}</button>
    ${selection?.file ? '<button type="button" data-action="cancel-finance-document">取消并清除本页文件</button>' : ""}
  </form>`;
  const heading = `<header class="finance-import-heading"><h3>${readonly ? "读取资料" : "导入数据"}</h3>
    <ol aria-label="${readonly ? "资料读取步骤" : "导入步骤"}"><li class="is-active"><b>01</b> 选择${readonly ? "资料" : "文件"}</li><li><b>02</b> ${readonly ? "识别内容" : "预览核对"}</li><li><b>03</b> ${readonly ? "向智能体提问" : "确认写入"}</li></ol></header>`;
  const notes = `<details class="finance-import-notes" open><summary>${readonly ? "资料读取说明" : "导入说明"}</summary>
    ${readonly ? "" : '<p><i class="ph ph-file-text" aria-hidden="true"></i> 逐行校验字段</p>'}
    <p><i class="ph ph-eye" aria-hidden="true"></i> 预览不会写入账本</p>
    <p>支持中文原表，选择后先只读识别，不要求三表齐全，也不会自动写入账本。点击「让 AI 读取这份资料」后可向智能体询问这份资料。</p>
    ${readonly ? "<p>PDF/DOCX 仅提取可读取文字，扫描件或纯图片请先 OCR；加密文件请解除密码。旧版 DOC 请另存为 DOCX。PDF/DOCX 不用于账本导入。</p>" : ""}
    <p>需要正式三表分析时，可到<a href="#agents">智能体中心 → 准备财务分析</a>核对资料。</p></details>`;
  switch (state.kind) {
    case "document_ready":
      return `<section class="finance-import">${heading}${form}${documentPreview(state.document, canReadWithModel)}${notes}</section>`;
    case "inspecting":
      return `<section class="finance-import">${heading}${form}<p role="status">${state.readWithModel ? "正在请求 AI 阅读…" : "正在只读识别原文件…"}</p>${selection?.document ? documentPreview(selection.document, canReadWithModel) : ""}${notes}</section>`;
    case "idle":
      return `<section class="finance-import is-idle">
        ${heading}${form}<p class="finance-import-boundary"><i class="ph ph-shield-check" aria-hidden="true"></i> ${readonly ? "只读资料，不写入账本" : "核对预览后再写入"}</p>${notes}
      </section>`;
    case "uploading":
    case "committing":
    case "polling":
      return `<section class="finance-import">
        ${heading}${form}<p role="status">${state.kind === "uploading" ? "正在读取文件并生成导入预览…" : "正在写入已确认的记录，请稍候…"}</p>${notes}
      </section>`;
    case "preview_ready":
      return `<section class="finance-import">
        ${heading}${form}
        <p role="status">预览：共 ${state.preview.totalRows} 行，
          接受 ${state.preview.acceptedRows}，
          拒绝 ${state.preview.rejectedRows}。</p>
        ${state.preview.errors.length > 0
          ? `<p class="growth-conflict">请修正以下数据；确认时只写入接受的 ${state.preview.acceptedRows} 行。</p>
            ${importErrorSummary(state.preview.errors)}` : ""}
        ${state.preview.totalRows === 0 ? "<p class=\"growth-conflict\">文件没有可导入的数据行，请检查表头下方是否包含明细。</p>" : ""}
        <button type="button" data-action="commit-finance-import"
          data-finance-import-preview-id="${escapeHtml(state.preview.previewId)}"
          ${state.preview.acceptedRows === 0 || !canImport ? "disabled" : ""}>
          确认并写入账本
        </button>${notes}
      </section>`;
    case "partial_success":
      return `<section class="finance-import">${heading}<p class="growth-conflict">
        导入部分成功：${state.operation.acceptedRows}/${state.operation.totalRows}
        行。</p>${form}${notes}</section>`;
    case "succeeded":
      return `<section class="finance-import">${heading}
        <p>导入成功：${state.operation.acceptedRows} 行。</p>${form}${notes}</section>`;
    case "failed":
      return `<section class="finance-import">${heading}
        <p class="growth-error" role="alert">${readonly ? "资料读取未完成" : "导入失败"}：${escapeHtml(state.message)}</p>
        ${form}${selection?.document ? documentPreview(selection.document, canReadWithModel) : ""}${notes}</section>`;
  }
}

function importStateLabel(kind: FinanceImportState["kind"]): string {
  const labels: Record<FinanceImportState["kind"], string> = {
    idle: "待导入",
    inspecting: "只读识别中",
    document_ready: "只读资料",
    uploading: "上传中",
    preview_ready: "待确认",
    committing: "写入中",
    polling: "处理中",
    partial_success: "部分完成",
    succeeded: "已完成",
    failed: "失败"
  };
  return labels[kind];
}

export function renderFinancePage(state: FinancePageState, selection?: FinanceImportSelection): string {
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
      const costEntries = state.costEntries.map((entry) => costEntryRow(entry as unknown as {
        id: string; category: string; platform: string; status: string; amountMinor: number; currency: string;
      })).join("");
      const estimates = state.costEstimates.map(estimateRow).join("");
      const hasEmptyEstimate = !estimates;
      const ledgerCount = state.facts.length + state.costEntries.length;
      const estimateSummary = estimates
        ? `<section class="finance-estimate-summary" aria-label="成本估算摘要"><header><h3>成本估算</h3><small>${state.costEstimates.length} 条</small></header>
              <div class="finance-table-wrap"><table><thead><tr><th>类型</th><th>估算金额</th><th>状态</th></tr></thead><tbody>${estimates}</tbody></table></div>
            </section>`
        : `<section class="finance-estimate-summary is-empty" aria-label="成本估算摘要"><header><h3>成本估算</h3><small>0 条</small></header>
              <p class="finance-summary-empty"><strong>暂无成本估算</strong><span>导入或审批预算后在此显示。</span></p>
            </section>`;
      return `<section class="growth-panel finance-page">
        <h2 class="sr-only">财务经营</h2>
        <div class="growth-command-strip finance-kpi-rail" aria-label="财务经营概览">
          <article class="finance-kpi"><span>财务事实</span><strong>${ledgerCount}</strong></article>
          <article class="finance-kpi"><span><i class="ph ph-circle" aria-hidden="true"></i> 待核对</span><strong>${state.facts.filter((fact) => fact.status !== "verified").length + state.costEntries.filter((entry) => entry.status !== "verified").length}</strong></article>
          <article class="finance-kpi"><span><i class="ph ph-circle" aria-hidden="true"></i> 成本估算</span><strong>${state.costEstimates.length}</strong></article>
          <article class="finance-kpi"><span>导入状态</span><strong>${importStateLabel(state.importState.kind)}</strong></article>
        </div>
        <div class="finance-operations-layout">
          <div class="finance-ledger-column${hasEmptyEstimate ? " has-empty-estimate" : ""}">
            <section class="finance-ledger-table" aria-label="财务经营数据">
              <div class="finance-ledger-table-head">
                <div class="finance-ledger-tabs" role="tablist" aria-label="财务数据类型"><button type="button" role="tab" class="is-active" data-finance-tab="facts" aria-selected="true" aria-controls="financeFactsPanel">财务事实</button><button type="button" role="tab" data-finance-tab="estimates" aria-selected="false" aria-controls="financeEstimatesPanel">成本估算</button></div>
                <div class="finance-ledger-controls"><label><span class="sr-only">状态筛选</span><select data-finance-status-filter><option value="all">全部状态</option><option value="verified">已核对</option><option value="pending">待核对</option></select></label><span class="finance-ledger-count" aria-live="polite">${ledgerCount} 条</span></div>
              </div>
              <div id="financeFactsPanel" class="finance-table-wrap" role="tabpanel" data-finance-panel="facts"><table><thead><tr><th>类型</th><th>金额</th><th>币种</th><th>状态</th><th>关联单据</th><th>操作</th></tr></thead><tbody>
                ${facts}${costEntries}${facts || costEntries ? "" : '<tr class="finance-table-empty"><td colspan="6"><strong>暂无财务事实</strong><span>从右侧导入 CSV 或 XLSX，预览通过后再写入台账。</span></td></tr>'}
              </tbody></table></div>
              <div id="financeEstimatesPanel" class="finance-table-wrap" role="tabpanel" data-finance-panel="estimates" hidden><table><thead><tr><th>类型</th><th>估算金额</th><th>状态</th></tr></thead><tbody>
                ${estimates || '<tr class="finance-table-empty"><td colspan="3"><strong>暂无成本估算</strong><span>成本估算与已核对事实分开保留。</span></td></tr>'}
              </tbody></table></div>
            </section>
            ${estimateSummary}
          </div>
          <details class="finance-structured-import" ${state.importState.kind !== 'idle' ? 'open' : ''}><summary>结构化入账与字段映射（可选）</summary>
          ${importBlock(state.importState, selection, state.canImport !== false, state.canReadWithModel !== false)}</details>
        </div>
      </section>`;
    }
  }
}
