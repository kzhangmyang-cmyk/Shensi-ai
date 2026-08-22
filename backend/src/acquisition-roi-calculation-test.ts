import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActualRoiForClosure,
  calculateExpectedRoi,
  calculateContractRoas,
  calculateCashMultiple,
  calculateCollectionRate,
  type ClosureCalculationEvidence
} from "./acquisition-roi-calculation.js";
import { roundSignedHalfUpDiv } from "./growth-money.js";

const closureEvidence = (): ClosureCalculationEvidence => ({
  membershipSnapshotHash: `sha256:${"a".repeat(64)}`,
  attestationSetHash: `sha256:${"b".repeat(64)}`,
  factSetHash: `sha256:${"c".repeat(64)}`,
  costSetHash: `sha256:${"d".repeat(64)}`,
  allocationSetHash: `sha256:${"e".repeat(64)}`,
  settlementSetHash: `sha256:${"f".repeat(64)}`
});

test("expected ROI applies probability exactly once", () => {
  assert.deepEqual(calculateExpectedRoi({
    contributions: [{
      dealId: "deal-a",
      approvedGrossProfitMinor: 10000,
      closeProbabilityBps: 4000
    }],
    attributedEstimatedCostMinor: 1000,
    costCoverageBps: 10000
  }), {
    status: "computed",
    probabilityWeightedGrossProfitMinor: 4000,
    attributedEstimatedCostMinor: 1000,
    roiBps: 30000,
    formulaVersion: "expected-gross-profit-roi.v1"
  });
});

test("known attributed cost with no authoritative quote contribution is minus one hundred percent", () => {
  assert.deepEqual(calculateExpectedRoi({
    contributions: [],
    attributedEstimatedCostMinor: 1000,
    costCoverageBps: 10000
  }), {
    status: "computed",
    probabilityWeightedGrossProfitMinor: 0,
    attributedEstimatedCostMinor: 1000,
    roiBps: -10000,
    formulaVersion: "expected-gross-profit-roi.v1"
  });
  assert.deepEqual(calculateExpectedRoi({
    contributions: [],
    attributedEstimatedCostMinor: null,
    costCoverageBps: 10000
  }), {
    status: "not_computable",
    reason: "cost_missing",
    formulaVersion: "expected-gross-profit-roi.v1"
  });
});

test("expected ROI rounds each Deal independently before deterministic summation", () => {
  const heterogeneous = calculateExpectedRoi({
    contributions: [
      {
        dealId: "deal-b",
        approvedGrossProfitMinor: -2000,
        closeProbabilityBps: 2500
      },
      {
        dealId: "deal-a",
        approvedGrossProfitMinor: 10000,
        closeProbabilityBps: 4000
      }
    ],
    attributedEstimatedCostMinor: 1000,
    costCoverageBps: 10000
  });
  assert.deepEqual(heterogeneous, {
    status: "computed",
    probabilityWeightedGrossProfitMinor: 3500,
    attributedEstimatedCostMinor: 1000,
    roiBps: 25000,
    formulaVersion: "expected-gross-profit-roi.v1"
  });
  const signedTies = calculateExpectedRoi({
    contributions: [
      {
        dealId: "deal-a",
        approvedGrossProfitMinor: 1,
        closeProbabilityBps: 5000
      },
      {
        dealId: "deal-b",
        approvedGrossProfitMinor: -1,
        closeProbabilityBps: 5000
      }
    ],
    attributedEstimatedCostMinor: 2,
    costCoverageBps: 10000
  });
  assert.deepEqual(signedTies, {
    status: "computed",
    probabilityWeightedGrossProfitMinor: 0,
    attributedEstimatedCostMinor: 2,
    roiBps: -10000,
    formulaVersion: "expected-gross-profit-roi.v1"
  });
});

test("actual ROI uses verified gross profit and cost only during closure", () => {
  const values = {
    verifiedRevenueMinor: 100000,
    verifiedCogsMinor: 20000,
    verifiedRefundMinor: 5000,
    verifiedBadDebtMinor: 5000,
    verifiedAcquisitionCostMinor: 20000,
    allCoverageBps: 10000,
    cashReconciled: true
  };
  assert.deepEqual(calculateActualRoiForClosure({
    ...values,
    closureEvidence: closureEvidence()
  }), {
    status: "computed",
    verifiedGrossProfitMinor: 70000,
    verifiedAcquisitionCostMinor: 20000,
    roiBps: 25000,
    formulaVersion: "verified-gross-profit-roi.v1"
  });
  assert.throws(
    () => calculateActualRoiForClosure({ ...values, closureEvidence: null }),
    /actual_roi_requires_closure_evidence/
  );
});

test("expected and actual ROI preserve negative results with signed rounding", () => {
  const expected = calculateExpectedRoi({
    contributions: [{
      dealId: "deal-a",
      approvedGrossProfitMinor: 0,
      closeProbabilityBps: 10_000
    }],
    attributedEstimatedCostMinor: 3,
    costCoverageBps: 10_000
  });
  assert.equal(expected.status, "computed");
  if (expected.status !== "computed") throw new Error("expected_computed_roi");
  assert.equal(expected.roiBps, -10_000);
  assert.equal(roundSignedHalfUpDiv(1n, 2n), 1n);
  assert.equal(roundSignedHalfUpDiv(-1n, 2n), -1n);
  assert.deepEqual(calculateActualRoiForClosure({
    verifiedRevenueMinor: 50,
    verifiedCogsMinor: 80,
    verifiedRefundMinor: 0,
    verifiedBadDebtMinor: 0,
    verifiedAcquisitionCostMinor: 20,
    allCoverageBps: 10_000,
    cashReconciled: true,
    closureEvidence: closureEvidence()
  }), {
    status: "computed",
    verifiedGrossProfitMinor: -30,
    verifiedAcquisitionCostMinor: 20,
    roiBps: -25_000,
    formulaVersion: "verified-gross-profit-roi.v1"
  });
  for (const invalid of [
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"g".repeat(64)}`
  ]) {
    assert.throws(
      () => calculateActualRoiForClosure({
        verifiedRevenueMinor: 1,
        verifiedCogsMinor: 0,
        verifiedRefundMinor: 0,
        verifiedBadDebtMinor: 0,
        verifiedAcquisitionCostMinor: 1,
        allCoverageBps: 10_000,
        cashReconciled: true,
        closureEvidence: {
          ...closureEvidence(),
          factSetHash: invalid as `sha256:${string}`
        }
      }),
      /actual_roi_requires_closure_evidence/
    );
  }
});

test("ROI rejects unsafe, negative unsigned, and out-of-range BPS before BigInt conversion", () => {
  for (const invalid of [
    () => calculateExpectedRoi({
      contributions: [],
      attributedEstimatedCostMinor: -1,
      costCoverageBps: 10_000
    }),
    () => calculateExpectedRoi({
      contributions: [{
        dealId: "deal-a",
        approvedGrossProfitMinor: 1,
        closeProbabilityBps: 10_001
      }],
      attributedEstimatedCostMinor: 1,
      costCoverageBps: 10_000
    }),
    () => calculateExpectedRoi({
      contributions: [{
        dealId: "deal-a",
        approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER + 1,
        closeProbabilityBps: 1
      }],
      attributedEstimatedCostMinor: 1,
      costCoverageBps: 10_000
    }),
    () => calculateActualRoiForClosure({
      verifiedRevenueMinor: -1,
      verifiedCogsMinor: 0,
      verifiedRefundMinor: 0,
      verifiedBadDebtMinor: 0,
      verifiedAcquisitionCostMinor: 1,
      allCoverageBps: 10_000,
      cashReconciled: true,
      closureEvidence: closureEvidence()
    }),
    () => calculateActualRoiForClosure({
      verifiedRevenueMinor: 1,
      verifiedCogsMinor: 0,
      verifiedRefundMinor: 0,
      verifiedBadDebtMinor: 0,
      verifiedAcquisitionCostMinor: 1,
      allCoverageBps: -1,
      cashReconciled: true,
      closureEvidence: closureEvidence()
    })
  ]) assert.throws(invalid, /roi_input_invalid/);
  assert.throws(() => calculateExpectedRoi({
    contributions: [
      {
        dealId: "deal-a",
        approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER,
        closeProbabilityBps: 10_000
      },
      {
        dealId: "deal-b",
        approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER,
        closeProbabilityBps: 10_000
      }
    ],
    attributedEstimatedCostMinor: 1,
    costCoverageBps: 10_000
  }), (error: unknown) =>
    (error as { code?: string }).code === "amount_out_of_range");
});

test("contract ROAS, cash multiple, and collection rate remain separate fixed-point ratios", () => {
  assert.deepEqual(calculateContractRoas({
    verifiedContractWonMinor: 1000,
    verifiedAcquisitionCostMinor: 200
  }), {
    status: "computed",
    bps: 50_000,
    formulaVersion: "contract-roas.v1"
  });
  assert.deepEqual(calculateCashMultiple({
    allocatedPaymentMinor: 900,
    verifiedAcquisitionCostMinor: 200
  }), {
    status: "computed",
    bps: 45_000,
    formulaVersion: "cash-multiple.v1"
  });
  assert.deepEqual(calculateCollectionRate({
    allocatedPaymentMinor: 900,
    verifiedContractWonMinor: 1000
  }), {
    status: "computed",
    bps: 9_000,
    formulaVersion: "collection-rate.v1"
  });
  assert.deepEqual(calculateContractRoas({
    verifiedContractWonMinor: 1000,
    verifiedAcquisitionCostMinor: 0
  }), {
    status: "not_available",
    reason: "zero_cost",
    formulaVersion: "contract-roas.v1"
  });
  assert.deepEqual(calculateCollectionRate({
    allocatedPaymentMinor: 0,
    verifiedContractWonMinor: 0
  }), {
    status: "not_available",
    reason: "zero_contract_amount",
    formulaVersion: "collection-rate.v1"
  });
});
