import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderRoiPage } from "./view";
import type { GrowthPerformanceResponse } from "./api";

const performance: GrowthPerformanceResponse = {
  query: { cohortId: "cohort-1", currency: "CNY", asOf: "2026-09-10T08:00:00.000Z", planId: null, closureVersionId: null, sliceKey: "all" },
  expectedRoiByCurrency: [{ currency: "CNY", status: "not_computable", reason: "missing_estimated_cost", formulaVersion: "expected-roi.v1", basis: "probability_weighted_gross_profit", costCoverageBps: 0, amountVisibility: "redacted" }],
  actualRoiByCurrency: [],
  cashByCurrency: [{
    currency: "CNY", amountVisibility: "redacted",
    coverage: { costCoverageBps: 0, marginCoverageBps: 0, cashCoverageBps: 0, attributionCoverageBps: 0 },
    contractRoas: { formulaVersion: "contract-roas.v1", status: "computed", valueBps: 12_345 },
    cashMultiple: { formulaVersion: "cash-multiple.v1", status: "not_available", reason: "zero_acquisition_cost" },
    collectionRate: { formulaVersion: "collection-rate.v1", status: "computed", valueBps: 0 }
  }],
  coverage: { costCoverageBps: 0, marginCoverageBps: 0, cashCoverageBps: 0, attributionCoverageBps: 0 },
  dataGaps: ["unverified_cost"],
  dataAsOf: "2026-09-10T08:00:00.000Z"
};
const { document } = parseHTML(renderRoiPage({ kind: "ready", cohorts: [], filters: null, performance }));
const text = document.textContent ?? document.documentElement.textContent ?? "";
assert.match(text, /12345 bps/u, "cash ratios must render the generated contract valueBps field");
assert.match(text, /0 bps/u, "a verified zero ratio remains visible");
assert.match(text, /暂不可计算/u);
assert.match(text, /缺少预计获客成本/u);
assert.match(text, /获客成本为零/u);
assert.doesNotMatch(text, /computed|not_computable|not_available|missing_estimated_cost|zero_acquisition_cost/u);

const failedQuery = renderRoiPage({ kind: "ready", cohorts: [], filters: null, performance: null, queryError: "stale_query" });
assert.match(failedQuery, /data-roi-filters/u);
assert.doesNotMatch(failedQuery, />\s*stale_query\s*</u);
