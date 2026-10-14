import { strict as assert } from "node:assert";
import { matchesQuoteCaseFilter, renderQuoteWorkbench } from "./view";
import type { QuoteWorkbenchState } from "./controller";
import type { QuotePreviewResult } from "./api";

const editing: QuoteWorkbenchState = {
  kind: "editing",
  case: {
    id: "case-1",
    revision: 4,
    status: "open",
    candidateId: "candidate-1",
    customerId: null,
    dealId: null,
    authorityKind: null
  },
  versions: Object.freeze([{
    id: "quote-v1",
    version: 1,
    status: "draft",
    lifecycleRevision: 1,
    quotedAmountMinor: 1_000_000
  }])
};

const html = renderQuoteWorkbench(editing);
assert.equal(html.includes("报价工作台"), true);
assert.equal(html.includes("quote-v1"), true);
assert.equal(html.includes("<script>"), false);
assert.equal(html.includes("growth-command-strip"), true);

const editableHtml = renderQuoteWorkbench(editing, {
  items: [{ id: "catalog-1", name: "除尘设备" }],
  policies: [{ id: "policy-1", currency: "CNY", listUnitPriceMinor: 120_000 }],
  canDraft: true,
  canApprove: true
});
assert.match(editableHtml, /data-quote-preview-form/u);
assert.match(editableHtml, /生成报价预览/u);
assert.match(editableHtml, /提交审批/u);

const customerDraftHtml = renderQuoteWorkbench({
  ...editing,
  case: {
    ...editing.case,
    candidateId: null,
    customerId: "customer-1",
    dealId: null,
    authorityKind: null
  }
}, {
  items: [{ id: "catalog-1", name: "除尘设备" }],
  policies: [{ id: "policy-1", currency: "CNY", listUnitPriceMinor: 120_000 }],
  canDraft: true,
  canApprove: true
});
assert.doesNotMatch(customerDraftHtml, />提交审批</u);
assert.match(customerDraftHtml, /待完成商机评估/u);

const crmAssessmentHtml = renderQuoteWorkbench({
  kind: "assessment_required",
  customerId: "customer-1",
  dealId: "deal-1",
  assignedTo: "sales-a"
});
assert.match(crmAssessmentHtml, /data-quote-assessment-form/u);
assert.match(crmAssessmentHtml, /需求已确认/u);
assert.match(crmAssessmentHtml, /预算已确认/u);
assert.match(crmAssessmentHtml, /决策人已确认/u);
assert.match(crmAssessmentHtml, /成交概率/u);
assert.match(crmAssessmentHtml, /评估依据/u);

const ordinaryDealHtml = renderQuoteWorkbench({
  ...editing,
  case: {
    ...editing.case,
    candidateId: null,
    customerId: "customer-1",
    dealId: "deal-1",
    authorityKind: "crm"
  }
}, {
  items: [{ id: "catalog-1", name: "除尘设备" }],
  policies: [{ id: "policy-1", currency: "CNY", listUnitPriceMinor: 120_000 }],
  canDraft: true,
  canApprove: true
});
assert.match(ordinaryDealHtml, />提交审批</u);

const emptySelectionHtml = renderQuoteWorkbench({
  kind: "case_selection",
  cases: []
});
assert.equal(emptySelectionHtml.includes("暂无报价案例"), true);
assert.equal(emptySelectionHtml.includes("报价案例"), true);
assert.equal(emptySelectionHtml.includes("报价前准备"), true);
assert.equal(emptySelectionHtml.includes("标准流程"), true);
assert.equal(emptySelectionHtml.includes("data-quote-list-query"), true);
assert.equal(emptySelectionHtml.includes("客户 / 商机"), true);
assert.equal(emptySelectionHtml.includes("<span>状态</span>"), true);
assert.doesNotMatch(emptySelectionHtml, /<h3>全部报价/u);
assert.doesNotMatch(
  emptySelectionHtml,
  /data-quote-list-filter="all">全部报价\s*<b>/u,
  "status tabs remain filters; the list summary is the single source of counts"
);
assert.match(
  emptySelectionHtml,
  /<strong>全部报价 0<\/strong><span>· 进行中 0 · 已关闭 0 · 已取消 0<\/span>/u,
  "the real list summary retains the server-projected counts"
);
assert.match(emptySelectionHtml, /<details class="quote-history" open>/u);
assert.equal(emptySelectionHtml.includes("quote_case_required"), false);

const selectableCasesHtml = renderQuoteWorkbench({
  kind: "case_selection",
  cases: [{
    id: "case/1", revision: 4, status: "open", candidateId: "candidate-1",
    customerId: null, dealId: null, authorityKind: null
  }]
});
assert.equal(selectableCasesHtml.includes("#growth/quotes?case=case%2F1"), true);
assert.equal(selectableCasesHtml.includes("继续报价"), true);

const lifecycleCasesHtml = renderQuoteWorkbench({
  kind: "case_selection",
  cases: ["open", "closed", "cancelled"].map((status, index) => ({
    id: `case-${index}`, revision: 1, status, candidateId: null,
    customerId: `customer-${index}`, dealId: null, authorityKind: null
  }))
});
assert.match(lifecycleCasesHtml, /进行中 1 · 已关闭 1 · 已取消 1/u,
  "case summaries count the persisted case lifecycle, not quote-version approval states");
for (const status of ["open", "closed", "cancelled"]) {
  assert.ok(lifecycleCasesHtml.includes(`data-quote-list-filter="${status}"`));
  assert.equal(matchesQuoteCaseFilter(status, status, "Customer-A", "customer"), true);
  assert.equal(matchesQuoteCaseFilter(status, "all", "Customer-A", "  A  "), true);
  assert.equal(matchesQuoteCaseFilter(status, status, "Customer-A", "not-found"), false);
}
assert.equal(matchesQuoteCaseFilter("open", "closed", "Customer-A", ""), false);
assert.equal(matchesQuoteCaseFilter("closed", "cancelled", "Customer-A", ""), false);

assert.equal(
  renderQuoteWorkbench({ kind: "conflict", message: "revision_conflict" })
    .includes("revision_conflict"),
  true
);
assert.equal(
  renderQuoteWorkbench({
    kind: "hard_blocked",
    diagnostic: {
      amountState: "non_positive_diagnostic",
      diagnosticNetProductAmountMinor: 0,
      diagnosticQuotedAmountMinor: -100,
      grossMarginBps: null,
      gate: {
        status: "hard_blocked",
        reasons: ["net_product_amount_not_positive"],
        requiredCapabilities: []
      }
    } as unknown as Extract<
      QuotePreviewResult,
      { amountState: "non_positive_diagnostic" }
    >
  }).includes("最终金额不大于零"),
  true
);
