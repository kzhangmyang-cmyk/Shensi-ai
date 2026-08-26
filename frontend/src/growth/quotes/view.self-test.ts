import { strict as assert } from "node:assert";
import { renderQuoteWorkbench } from "./view";
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
    dealId: null
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

const emptySelectionHtml = renderQuoteWorkbench({
  kind: "case_selection",
  cases: []
});
assert.equal(emptySelectionHtml.includes("当前还没有可打开的报价案例"), true);
assert.equal(emptySelectionHtml.includes("quote_case_required"), false);

const selectableCasesHtml = renderQuoteWorkbench({
  kind: "case_selection",
  cases: [{
    id: "case/1", revision: 4, status: "open", candidateId: "candidate-1",
    customerId: null, dealId: null
  }]
});
assert.equal(selectableCasesHtml.includes("#growth/quotes?case=case%2F1"), true);
assert.equal(selectableCasesHtml.includes("打开报价案例"), true);

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
  }).includes("非正金额"),
  true
);
