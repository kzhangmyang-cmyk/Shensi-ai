import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderFinancePage } from "./view";
import type { FinancePageState } from "./controller";
import type { AcquisitionCostEstimate, FinanceImportRowError, FinanceDocumentInspection } from "./api";

const ready: Extract<FinancePageState, { kind: "ready" }> = {
  kind: "ready",
  costEntries: [],
  costEstimates: [{
    id: "estimate-1",
    workspaceId: "ws-1",
    status: "active",
    currency: "CNY",
    amountMinor: 20_000,
    createdAt: "2026-08-09T08:00:00.000Z"
  } as unknown as AcquisitionCostEstimate],
  facts: [{
    id: "fact-1",
    workspaceId: "ws-1",
    factType: "payment_received",
    amountMinor: 100_000,
    currency: "CNY",
    status: "verified",
    revision: 3,
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    quoteVersionId: "quote-v1",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    recordedAt: "2026-08-09T08:00:00.000Z",
    createdBy: "manager-1",
    sourceIdentityRoot: "source-1",
    sourceRef: null,
    sourceVersion: 1,
    externalId: null,
    evidenceHash: `sha256:${"a".repeat(64)}`,
    correctionGroupId: null,
    correctsFactId: null,
    commercialAmountHash: null,
    commercialBindingSnapshot: null,
    attributionSnapshot: null,
    dealAuthorityRevision: null,
    provenance: "manual_verified"
  }],
  importState: { kind: "idle" },
  canVerify: true
};

const html = renderFinancePage(ready);
const documentFixture: FinanceDocumentInspection = {
  documentId: 'doc-1', fileName: '中文原表.xlsx', fileHash: `sha256:${'a'.repeat(64)}`, expiresAt: '2026-09-11T00:00:00Z',
  classification: 'financial_statements', selectedForConversation: false, modelStatus: 'not_requested',
  missingStatements: ['cash_flow_statement'], uncertain: ['期间待确认'], observations: [],
  regions: [{ regionId: 'r1', sheetName: '利润', kind: 'income_statement', startRow: 2, endRow: 15, headerRow: 2, sourceRefs: ['利润!R2C1'], uncertain: [] }],
  cells: [{ sourceRef: '利润!R2C1', sheetName: '利润', row: 2, column: 1, text: '<原始收入>', valueStatus: 'cached_formula' }]
};
{
  const rendered = renderFinancePage({ ...ready, importState: { kind: 'document_ready', document: {
    ...documentFixture, fileName: '原报告.pdf', classification: 'unknown', regions: [], uncertain: ['document_structure_unverified'],
    cells: [{ sourceRef: 'pdf:3:2', page: 3, item: 2, text: 'PDF 原文' },
      { sourceRef: 'docx:p:5', paragraph: 5, text: '段落原文' },
      { sourceRef: 'docx:t:2:4:3', table: 2, row: 4, column: 3, text: '<表格原文>' }]
  } } }, { kind: 'readonly', file: { name: '原报告.pdf', size: 100 } });
  const doc = parseHTML(`<html><body>${rendered}</body></html>`).document;
  assert.match(doc.querySelector('[data-finance-source-ref="pdf:3:2"]')?.textContent ?? '', /PDF.*第 3 页.*第 2 项.*PDF 原文/s);
  assert.match(doc.querySelector('[data-finance-source-ref="docx:p:5"]')?.textContent ?? '', /第 5 段.*段落原文/s);
  assert.match(doc.querySelector('[data-finance-source-ref="docx:t:2:4:3"]')?.textContent ?? '', /第 2 个表格.*第 4 行第 3 列.*<表格原文>/s);
  assert.match(doc.body.textContent ?? '', /文档结构尚待核对/);
  assert.doesNotMatch(doc.body.textContent ?? '', /undefined|document_structure_unverified/);
  assert.equal(doc.querySelector('[data-finance-import-file]')?.getAttribute('accept'), '.csv,.xls,.xlsx,.pdf,.docx');
  assert.match(doc.body.textContent ?? '', /扫描件.*OCR/s);
}
// Public document/region uncertainty is readable guidance, never machine codes.
{
  const parts: FinanceDocumentInspection['cells'] = [
    { sourceRef: 'pdf:3:2:s:2', page: 3, item: 2, segment: 2, startOffset: 500, endOffset: 1000, text: '原文第二片段' },
    { sourceRef: 'docx:p:5:s:3', paragraph: 5, segment: 3, startOffset: 1000, endOffset: 1200, text: '段落第三片段' },
    { sourceRef: 'docx:t:2:4:3:s:2', table: 2, row: 4, column: 3, segment: 2, startOffset: 500, endOffset: 900, text: '表格第二片段' }
  ];
  const doc = parseHTML(`<html><body>${renderFinancePage({ ...ready, importState: { kind: 'document_ready', document: { ...documentFixture, regions: [], cells: parts } } })}</body></html>`).document;
  assert.match(doc.querySelector('[data-finance-source-ref="pdf:3:2:s:2"]')?.textContent ?? '', /第 3 页.*第 2 项.*片段 2.*原文第二片段/s);
  assert.match(doc.querySelector('[data-finance-source-ref="docx:p:5:s:3"]')?.textContent ?? '', /第 5 段.*片段 3.*段落第三片段/s);
  assert.match(doc.querySelector('[data-finance-source-ref="docx:t:2:4:3:s:2"]')?.textContent ?? '', /第 2 个表格.*第 4 行第 3 列.*片段 2.*表格第二片段/s);
  assert.equal(doc.querySelector('[aria-label="只读资料预览"] details')?.hasAttribute('open'), false);
}
for (const [code, label] of [
  ['currency_not_verified', '币种待确认'],
  ['period_not_verified', '报表期间待确认'],
  ['unit_not_verified', '金额单位待确认'],
  ['formula_value_unknown', '部分公式没有可读取的结果'],
  ['formula_cache_unverified', '公式缓存值尚未核对'],
  ['cell_text_omitted', '部分较长单元格内容未展示'],
  ['inspection_truncated', '资料较多，本次仅识别部分内容'],
  ['region_kind_unknown', '这一区域的用途待确认'],
  ['header_not_verified', '列标题含义待确认'],
  ['document_regions_unverified', '资料区域划分待确认'],
  ['model_context_truncated', '资料较多，AI 本次只读取了部分内容'],
  ['document_text_segmented', '较长文字已分段展示，原始位置保留'],
  ['pdf_text_layout_unverified', 'PDF 文字顺序与版面关系待核对'],
  ['pdf_pages_without_text', '部分 PDF 页面未提取到文字，可先阅读其余页面'],
  ['docx_main_document_only', '本次读取 DOCX 正文'],
  ['docx_non_body_content_omitted', '页眉、页脚等正文外内容未读取'],
  ['docx_nested_table_omitted', '嵌套表格内容未读取'],
  ['docx_field_cache_unverified', 'Word 域缓存内容仅读取，未重新计算'],
  ['docx_table_merge_layout_unverified', '表格合并单元格关系待核对']
]) {
  const doc = parseHTML(`<html><body>${renderFinancePage({ ...ready, importState: { kind: 'document_ready', document: {
    ...documentFixture, uncertain: [code!], regions: [{ ...documentFixture.regions[0]!, uncertain: [code!] }]
  } } })}</body></html>`).document;
  const preview = doc.querySelector('[aria-label="只读资料预览"]')!;
  assert.ok(preview.querySelector('ul > li')?.textContent?.includes(label!), `${code} must have a readable region hint`);
  assert.ok([...preview.querySelectorAll('p')].some(p => p.textContent?.startsWith('待确认：') && p.textContent.includes(label!)), `${code} must have a readable document hint`);
  assert.equal(preview.textContent?.includes(code!), false);
  assert.equal(preview.querySelector('[data-action="read-finance-document"]')?.hasAttribute('disabled'), false, 'uncertainty must not block reading');
}
{
  const doc = parseHTML(`<html><body>${renderFinancePage({ ...ready, importState: { kind: 'document_ready', document: {
    ...documentFixture, uncertain: ['future_internal_code', 'constructor', '期间待确认'],
    regions: [{ ...documentFixture.regions[0]!, uncertain: ['unrecognized_private_code', '<img src=x onerror=alert(1)>', '列标题需要核对'] }]
  } } })}</body></html>`).document;
  const preview = doc.querySelector('[aria-label="只读资料预览"]')!;
  assert.doesNotMatch(preview.textContent ?? '', /future_internal_code|constructor|unrecognized_private_code|onerror/);
  assert.match(preview.textContent ?? '', /另有内容待核对，可先阅读已识别资料/);
  assert.match(preview.textContent ?? '', /期间待确认/);
  assert.match(preview.textContent ?? '', /列标题需要核对/);
  assert.equal(preview.querySelector('img'), null);
}
{
  const doc = parseHTML(`<html><body>${renderFinancePage({ ...ready, canImport: false, importState: { kind: 'document_ready', document: documentFixture } }, { kind: 'readonly', file: { name: '中文原表.xlsx', size: 100 } })}</body></html>`).document;
  assert.match(doc.body.textContent ?? '', /利润表/);
  assert.match(doc.body.textContent ?? '', /现金流量表/);
  assert.match(doc.body.textContent ?? '', /缓存.*未重新计算/s);
  assert.equal(doc.querySelector('[data-finance-source-ref]')?.textContent?.includes('<原始收入>'), true);
  assert.equal(doc.querySelector('原始收入'), null);
  assert.equal(doc.querySelector('[data-action="read-finance-document"]')?.textContent?.trim(), '让 AI 读取这份资料');
  assert.equal(doc.querySelector('[data-action="commit-finance-import"]'), null);
  assert.equal(doc.querySelector('option[value="acquisition_cost"]'), null);
  const preview = doc.querySelector('[aria-label="只读资料预览"]')!;
  assert.equal(preview.querySelector('details')?.hasAttribute('open'), false, 'source cells should be available without overwhelming the summary');
  assert.equal(preview.querySelector('button, details')?.getAttribute('data-action'), 'read-finance-document', 'the main AI read action must precede source details');
  assert.equal(preview.querySelectorAll('[data-action="read-finance-document"]').length, 1);
}
{
  const unavailable = parseHTML(`<html><body>${renderFinancePage({ ...ready, canReadWithModel: false, importState: { kind: 'document_ready', document: { ...documentFixture, modelStatus: 'unavailable' } } })}</body></html>`).document;
  assert.match(unavailable.body.textContent ?? '', /AI 服务暂不可用/);
  assert.doesNotMatch(unavailable.body.textContent ?? '', /AI 阅读已完成/);
  assert.equal(unavailable.querySelector('[data-action="read-finance-document"]')?.hasAttribute('disabled'), true);
  assert.match(unavailable.body.textContent ?? '', /财务委员会运行权限/);
}
{
  const doc = parseHTML(`<html><body>${html}</body></html>`).document;
  assert.equal(doc.querySelector('[data-finance-import-kind] option[selected]')?.getAttribute('value'), 'readonly', 'default file purpose must be readonly, not cost ingestion');
  assert.match(doc.body.textContent ?? '', /只读识别/);
  assert.doesNotMatch(doc.querySelector('.finance-import')?.textContent ?? '', /知情按钮|逐行校验字段|核对预览后再写入/);
}

function previewErrors(errors: FinanceImportRowError[], acceptedRows = 0): Document {
  return parseHTML(`<html><body>${renderFinancePage({ ...ready, importState: { kind: "preview_ready", preview: {
    previewId: "preview-1", kind: "financial_fact", totalRows: 100, acceptedRows,
    rejectedRows: 100 - acceptedRows, expiresAt: "2026-09-10T00:00:00Z", errors
  } } })}</body></html>`).document;
}

// Repeated row errors must become distinct field/reason groups, not a 291-item wall.
{
  const errors: FinanceImportRowError[] = Array.from({ length: 97 }, (_, index) =>
    ["amount", "currency", "businessOccurredAt"].map(field => ({ rowNumber: index + 1,
      code: "required_field_missing" as const, field, message: "server-internal-secret" }))).flat();
  const doc = previewErrors(errors);
  const groups = [...doc.querySelectorAll('.finance-import-errors > li')];
  assert.equal(groups.length, 3);
  assert.match(groups[0]!.textContent ?? "", /金额.*97 行/s);
  assert.match(groups[1]!.textContent ?? "", /币种.*97 行/s);
  assert.match(groups[2]!.textContent ?? "", /业务发生时间.*97 行/s);
  assert.match(groups[0]!.textContent ?? "", /1、2、3、4、5/);
  assert.doesNotMatch(groups[0]!.textContent ?? "", /6、7、8/);
  assert.match(doc.body.textContent ?? "", /接受 0/);
  assert.equal(doc.querySelector('[data-action="commit-finance-import"]')?.hasAttribute('disabled'), true);
  assert.doesNotMatch(doc.body.textContent ?? "", /server-internal-secret/);
}

// Legacy null fields cannot be relabelled as a guessed missing amount/date column.
{
  const doc = previewErrors([
    { rowNumber: 2, code: "required_field_missing", field: null, message: "amount missing" },
    { rowNumber: 2, code: "required_field_missing", field: null, message: "currency missing" },
    { rowNumber: 3, code: "required_field_missing", field: null, message: "private" }
  ], 2);
  const groups = [...doc.querySelectorAll('.finance-import-errors > li')];
  assert.equal(groups.length, 1);
  assert.match(groups[0]!.textContent ?? "", /未明确字段.*2 行/s);
  assert.doesNotMatch(groups[0]!.textContent ?? "", /金额|币种|amount|currency/);
  assert.equal(doc.querySelector('[data-action="commit-finance-import"]')?.hasAttribute('disabled'), false);
}

// Unknown backend strings must not leak through the fallback renderer.
{
  const doc = previewErrors([{ rowNumber: 1, code: "new-code-secret", field: "token-private", message: "Authorization: sensitive-value" } as unknown as FinanceImportRowError]);
  assert.doesNotMatch(doc.body.textContent ?? "", /sensitive-value|token-private|new-code-secret/);
  assert.match(doc.querySelector('.finance-import-errors')?.textContent ?? "", /需要核对/);
}

// Distinct causes stay separate, but the first screen remains bounded.
{
  const errors = ["amount", "currency", "category", "factType", "externalId"].flatMap(field =>
    (["required_field_missing", "row_identity_conflict"] as const).map(code => ({ field, code, rowNumber: 1, message: "ignored" })));
  const doc = previewErrors(errors);
  assert.equal(doc.querySelectorAll('.finance-import-errors > li').length, 8);
  assert.match(doc.body.textContent ?? "", /汇总为 10 类问题/);
  assert.match(doc.body.textContent ?? "", /另有 2 类问题/);
}
assert.equal(html.includes("财务经营"), true);
assert.equal(html.includes("fact-1"), true);
assert.equal(html.includes("data-action=\"correct-fact\""), false);
assert.match(html, /finance-readonly-action[^>]*>只读<\/span>/u);
assert.equal(html.includes("estimate-1"), true);
assert.equal(html.includes("growth-command-strip"), true);
assert.match(html, /finance-kpi-rail/u);
assert.equal(html.includes("finance-ledger-table"), true);
assert.match(html, /<th>类型<\/th><th>金额<\/th><th>币种<\/th><th>状态<\/th><th>关联单据<\/th><th>操作<\/th>/u);
assert.match(html, /finance-ledger-count[^>]*>1 条</u);
assert.match(html, />回款<\/strong>/u);
assert.match(html, />1,000\.00<\/td>/u);
assert.match(html, />已核对<\/span>/u);
assert.doesNotMatch(html, />verified<\/td>/u);
assert.match(html, /data-finance-tab="facts"/u);
assert.match(html, /data-finance-tab="estimates"/u);
assert.match(html, /role="tab"[^>]+data-finance-tab="facts"/u);
assert.match(html, /role="tab"[^>]+data-finance-tab="estimates"/u);
assert.match(html, /data-finance-status-filter/u);
assert.match(html, /data-finance-panel="facts"/u);
assert.match(html, /data-finance-panel="estimates" hidden/u);
assert.match(html, /data-finance-import-form/u);
assert.match(html, /data-finance-import-file/u);
assert.match(html, /只读识别/u);
assert.match(renderFinancePage(ready, { kind: 'financial_fact', file: null }), /预览导入/u);
assert.match(html, /资料读取步骤/u);
assert.match(html, /或将文件拖拽到此处/u);
assert.match(html, /预览不会写入账本/u);
assert.match(html, /待导入/u);
assert.doesNotMatch(html, />idle</u);
assert.match(html, /finance-operations-layout/u);
assert.equal(html.includes("<script>"), false);

const emptyHtml = renderFinancePage({
  ...ready,
  facts: [],
  costEntries: [],
  costEstimates: []
});
assert.match(emptyHtml, /finance-estimate-summary is-empty/u);
assert.match(emptyHtml, /finance-ledger-column has-empty-estimate/u,
  "a zero-estimate ledger should opt into the balanced sparse-data layout");
assert.match(emptyHtml, /finance-import is-idle/u,
  "the idle import workflow should opt into its centered sparse-data surface");
assert.match(emptyHtml, /暂无成本估算/u);
assert.match(emptyHtml, /colspan="6"/u);

const pendingFacts: FinancePageState = {
  ...ready,
  facts: [{
    ...ready.facts[0]!,
    status: "pending"
  }]
};
assert.equal(
  renderFinancePage(pendingFacts).includes("data-action=\"correct-fact\""),
  false
);
assert.match(renderFinancePage(pendingFacts), /data-finance-status="pending"/u);

assert.equal(
  renderFinancePage({ kind: "forbidden" }).includes("无权"),
  true
);
