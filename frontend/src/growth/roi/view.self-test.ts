import { strict as assert } from "node:assert";
import { renderRoiPage } from "./view";
import type { RoiPageState } from "./controller";
import type { GrowthPerformanceResponse } from "./api";

const baseCoverage = {
  costCoverageBps: 8_000,
  marginCoverageBps: 9_000,
  cashCoverageBps: 7_000,
  attributionCoverageBps: 10_000,
  gapCodes: [] as string[]
};

const notComputablePerformance = {
  query: {
    cohortId: "cohort-1",
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z",
    planId: null,
    closureVersionId: null,
    sliceKey: "all"
  },
  expectedRoiByCurrency: [{
    currency: "CNY",
    status: "not_computable",
    reason: "cost_missing",
    formulaVersion: "expected-roi.v1",
    basis: "probability_weighted_gross_profit",
    costCoverageBps: 0,
    amountVisibility: "redacted"
  }],
  actualRoiByCurrency: [{
    currency: "CNY",
    status: "not_computable",
    reason: "cash_reconciliation_incomplete",
    closureVersionId: null,
    closureAsOf: null,
    formulaVersion: "actual-roi.v1"
  }],
  cashByCurrency: [],
  coverage: { ...baseCoverage, gapCodes: ["cash_reconciliation_incomplete"] },
  dataGaps: ["cash_reconciliation_incomplete"],
  dataAsOf: "2026-08-09T08:00:00.000Z"
} as unknown as GrowthPerformanceResponse;

const notComputable: RoiPageState = {
  kind: "ready",
  cohorts: [],
  filters: null,
  performance: notComputablePerformance
};

const gapHtml = renderRoiPage(notComputable);
assert.equal(gapHtml.includes("预计 ROI（planned）"), true);
assert.equal(gapHtml.includes("已关账实际 ROI（verified closed result）"), true);
assert.equal(gapHtml.includes("cash_reconciliation_incomplete"), true);
assert.equal(gapHtml.includes("data-action=\"roi-data-gap\""), true);
assert.equal(gapHtml.includes("详细金额已脱敏"), true);
assert.equal(gapHtml.includes("合同 ROAS"), false);

const computedPerformance = {
  query: {
    cohortId: "cohort-1",
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z",
    planId: null,
    closureVersionId: "closure-1",
    sliceKey: "all"
  },
  expectedRoiByCurrency: [],
  actualRoiByCurrency: [{
    currency: "CNY",
    status: "computed",
    basis: "verified_gross_profit",
    roiBps: 10_000,
    coverage: baseCoverage,
    closureVersionId: "closure-1",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    formulaVersion: "actual-roi.v1",
    membershipSnapshotHash: `sha256:${"b".repeat(64)}`,
    calculationHash: `sha256:${"a".repeat(64)}`,
    sliceKey: "all",
    amountVisibility: "full",
    verifiedGrossProfitMinor: 1_000_000,
    verifiedAcquisitionCostMinor: 500_000
  }],
  cashByCurrency: [{
    currency: "CNY",
    status: "complete",
    contractRoas: {
      formulaVersion: "contract-roas.v1",
      status: "computed",
      resultBps: 2_000
    },
    cashMultiple: {
      formulaVersion: "cash-multiple.v1",
      status: "computed",
      resultBps: 1_000
    },
    collectionRate: {
      formulaVersion: "collection-rate.v1",
      status: "computed",
      resultBps: 8_000
    },
    amountVisibility: "full",
    verifiedContractWonMinor: 1_000_000,
    verifiedAcquisitionCostMinor: 500_000,
    allocatedPaymentMinor: 100,
    allocatedRefundMinor: 20,
    allocatedBadDebtMinor: 0,
    netCashMinor: 80
  }],
  coverage: baseCoverage,
  dataGaps: [],
  dataAsOf: "2026-08-09T08:00:00.000Z"
} as unknown as GrowthPerformanceResponse;

const computed: RoiPageState = {
  kind: "ready",
  cohorts: [],
  filters: null,
  performance: computedPerformance
};

const computedHtml = renderRoiPage(computed);
assert.equal(computedHtml.includes("closure-1"), true);
assert.equal(computedHtml.includes("actual-roi.v1"), true);
assert.equal(computedHtml.includes(`sha256:${"a".repeat(64)}`), true);
assert.equal(computedHtml.includes("8000 bps"), true);
assert.equal(computedHtml.includes("合同 ROAS"), true);
assert.equal(computedHtml.includes("现金倍数"), true);
assert.equal(computedHtml.includes("回款率"), true);

const redactedPerformance = {
  ...computedPerformance,
  actualRoiByCurrency: [{
    currency: "CNY",
    status: "computed",
    basis: "verified_gross_profit",
    roiBps: 10_000,
    coverage: baseCoverage,
    closureVersionId: "closure-1",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    formulaVersion: "actual-roi.v1",
    membershipSnapshotHash: `sha256:${"b".repeat(64)}`,
    calculationHash: `sha256:${"a".repeat(64)}`,
    sliceKey: "all",
    amountVisibility: "redacted"
  }],
  cashByCurrency: [{
    currency: "CNY",
    status: "complete",
    contractRoas: {
      formulaVersion: "contract-roas.v1",
      status: "computed",
      resultBps: 2_000
    },
    cashMultiple: {
      formulaVersion: "cash-multiple.v1",
      status: "computed",
      resultBps: 1_000
    },
    collectionRate: {
      formulaVersion: "collection-rate.v1",
      status: "computed",
      resultBps: 8_000
    },
    amountVisibility: "redacted"
  }]
} as unknown as GrowthPerformanceResponse;

const redactedHtml = renderRoiPage({
  kind: "ready",
  cohorts: [],
  filters: null,
  performance: redactedPerformance
});
assert.equal(redactedHtml.includes("详细金额已脱敏"), true);
assert.equal(redactedHtml.includes("1000000"), false);
assert.equal(redactedHtml.includes("500000"), false);
