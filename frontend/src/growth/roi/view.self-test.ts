import { strict as assert } from "node:assert";
import {
  formatRoiAsOfPrecision,
  formatRoiAsOfSummary,
  renderRoiPage,
  toLocalDateTimeInput
} from "./view";
import type { RoiPageState } from "./controller";
import type { GrowthPerformanceResponse } from "./api";

const baseCoverage = {
  costCoverageBps: 8_000,
  marginCoverageBps: 9_000,
  cashCoverageBps: 7_000,
  attributionCoverageBps: 10_000,
  gapCodes: [] as string[]
};

const selectorHtml = renderRoiPage({
  kind: "ready",
  cohorts: [{
    id: "cohort-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    name: "工业除尘获客",
    status: "active",
    revision: 1,
    definition: {},
    membershipVersion: 1,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  } as never],
  filters: null,
  performance: null
});
assert.match(selectorHtml, /data-roi-cohort/u);
assert.match(selectorHtml, /工业除尘获客/u);
assert.match(selectorHtml, /data-roi-action="query"/u);
assert.match(selectorHtml, /获客批次/u);
assert.doesNotMatch(selectorHtml, /获客 cohort/u);
const localFixture = new Date("2026-08-09T08:07:04.321Z");
const expectedLocal = `${localFixture.getFullYear()}-${String(localFixture.getMonth() + 1).padStart(2, "0")}-${String(localFixture.getDate()).padStart(2, "0")}T${String(localFixture.getHours()).padStart(2, "0")}:${String(localFixture.getMinutes()).padStart(2, "0")}:${String(localFixture.getSeconds()).padStart(2, "0")}.${String(localFixture.getMilliseconds()).padStart(3, "0")}`;
const expectedCompactDate = `${localFixture.getFullYear()}年${String(localFixture.getMonth() + 1).padStart(2, "0")}月${String(localFixture.getDate()).padStart(2, "0")}日 ${String(localFixture.getHours()).padStart(2, "0")}:${String(localFixture.getMinutes()).padStart(2, "0")}`;
assert.equal(toLocalDateTimeInput(localFixture), expectedLocal);
assert.equal(new Date(toLocalDateTimeInput(localFixture)).toISOString(), localFixture.toISOString());
assert.equal(formatRoiAsOfSummary(localFixture), expectedCompactDate);
assert.equal(formatRoiAsOfPrecision(localFixture), `${expectedCompactDate}:${String(localFixture.getSeconds()).padStart(2, "0")}.${String(localFixture.getMilliseconds()).padStart(3, "0")}`);
assert.equal(toLocalDateTimeInput("not-a-date"), "");
assert.equal(formatRoiAsOfSummary("not-a-date"), "时间待确认");

const preciseSelectorHtml = renderRoiPage({
  kind: "ready",
  cohorts: [{
    id: "cohort-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    name: "工业除尘获客",
    status: "active",
    revision: 1,
    definition: {},
    membershipVersion: 1,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  } as never],
  filters: {
    cohortId: "cohort-1",
    currency: "CNY",
    asOf: localFixture.toISOString()
  },
  performance: null
});
assert.match(preciseSelectorHtml, /<details class="roi-as-of-field"/u);
assert.match(preciseSelectorHtml, /data-roi-as-of-summary/u);
assert.match(preciseSelectorHtml, new RegExp(`>${expectedCompactDate}<`, "u"));
assert.match(preciseSelectorHtml, new RegExp(`value="${expectedLocal}"`, "u"));
assert.match(preciseSelectorHtml, /step="0\.001"/u);
assert.match(preciseSelectorHtml, /按本机时区查询，可精确到毫秒。/u);

const emptyHtml = renderRoiPage({
  kind: "ready",
  cohorts: [],
  filters: null,
  performance: null
});
assert.match(emptyHtml, /data-roi-cohort/u);
assert.match(emptyHtml, /<option value="">暂无可用批次<\/option>/u);
assert.match(emptyHtml, /预计 ROI/u);
assert.match(emptyHtml, /已关账实际 ROI/u);
assert.match(emptyHtml, /现金回收/u);
assert.match(emptyHtml, /前往获客中心/u);
assert.match(emptyHtml, /计算依据/u);
assert.match(emptyHtml, /roi-basis-cards/u);
assert.match(emptyHtml, /获客成本/u);
assert.match(emptyHtml, /关联商机/u);
assert.match(emptyHtml, /已核对回款/u);
assert.match(emptyHtml, /口径说明/u);
assert.match(emptyHtml, /roi-data-explanation-link/u);
assert.match(emptyHtml, /href="#growth\/roi"/u);
assert.match(emptyHtml, /data-roi-action="data-explanation"/u);
assert.match(emptyHtml, /aria-controls="roi-data-explanation"/u);
assert.match(emptyHtml, /data-roi-tab="expected"/u);
assert.match(emptyHtml, /class="roi-analysis-shell"/u);
assert.match(emptyHtml, /role="tablist"[^>]+aria-orientation="horizontal"/u);
assert.match(emptyHtml, /id="roi-tab-expected"[^>]+aria-controls="roi-panel-expected"[^>]+tabindex="0"/u);
assert.match(emptyHtml, /id="roi-tab-actual"[^>]+aria-controls="roi-panel-actual"[^>]+tabindex="-1"/u);
assert.match(emptyHtml, /id="roi-tab-cash"[^>]+aria-controls="roi-panel-cash"[^>]+tabindex="-1"/u);
assert.match(emptyHtml, /id="roi-panel-expected" role="tabpanel" aria-labelledby="roi-tab-expected"/u);
assert.match(emptyHtml, /id="roi-panel-actual" role="tabpanel" aria-labelledby="roi-tab-actual"/u);
assert.match(emptyHtml, /id="roi-panel-cash" role="tabpanel" aria-labelledby="roi-tab-cash"/u);
assert.match(emptyHtml, /class="roi-metric-guide-head"><span>指标<\/span><span>说明<\/span>/u);
assert.equal(emptyHtml.indexOf("roi-view-tabs") > emptyHtml.indexOf("roi-analysis-shell"), true);

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
assert.equal(gapHtml.includes("预计 ROI"), true);
assert.equal(gapHtml.includes("已关账实际 ROI"), true);
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
      valueBps: 2_000
    },
    cashMultiple: {
      formulaVersion: "cash-multiple.v1",
      status: "computed",
      valueBps: 1_000
    },
    collectionRate: {
      formulaVersion: "collection-rate.v1",
      status: "computed",
      valueBps: 8_000
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
assert.equal(computedHtml.includes("data-roi-filters"), true);
assert.equal(computedHtml.includes("roi-analysis-shell"), true);
assert.equal(computedHtml.includes("roi-view-tabs"), true);
assert.equal(computedHtml.includes("roi-panel-actual"), true);
assert.equal(computedHtml.includes("aria-labelledby=\"roi-tab-cash\""), true);
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
      valueBps: 2_000
    },
    cashMultiple: {
      formulaVersion: "cash-multiple.v1",
      status: "computed",
      valueBps: 1_000
    },
    collectionRate: {
      formulaVersion: "collection-rate.v1",
      status: "computed",
      valueBps: 8_000
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
