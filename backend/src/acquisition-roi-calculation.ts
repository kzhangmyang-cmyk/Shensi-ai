import {
  roundSignedHalfUpDiv,
  safeSignedInteger
} from "./growth-money.js";

export interface ClosureCalculationEvidence {
  membershipSnapshotHash: string;
  attestationSetHash: string;
  factSetHash: string;
  costSetHash: string;
  allocationSetHash: string;
  settlementSetHash: string;
}

export interface ClosedActualRoiInput {
  verifiedRevenueMinor: number;
  verifiedCogsMinor: number;
  verifiedRefundMinor: number;
  verifiedBadDebtMinor: number;
  verifiedAcquisitionCostMinor: number;
  allCoverageBps: number;
  cashReconciled: boolean;
  closureEvidence: ClosureCalculationEvidence | null;
}

export type RoiGapCode =
  | "cost_missing"
  | "cost_not_closed"
  | "gross_profit_unverified"
  | "cash_reconciliation_incomplete"
  | "attribution_incomplete"
  | "multi_currency_without_fx"
  | "zero_estimated_cost"
  | "zero_cost"
  | "query_truncated"
  | "cohort_not_closed";

export type ExpectedRoiResult =
  | {
      status: "computed";
      probabilityWeightedGrossProfitMinor: number;
      attributedEstimatedCostMinor: number;
      roiBps: number;
      formulaVersion: "expected-gross-profit-roi.v1";
    }
  | {
      status: "not_computable";
      reason: "cost_missing" | "attribution_incomplete" | "zero_estimated_cost";
      formulaVersion: "expected-gross-profit-roi.v1";
    };

export interface ExpectedRoiContributionInput {
  dealId: string;
  approvedGrossProfitMinor: number;
  closeProbabilityBps: number;
}

export type ClosedActualRoiResult =
  | {
      status: "computed";
      verifiedGrossProfitMinor: number;
      verifiedAcquisitionCostMinor: number;
      roiBps: number;
      formulaVersion: "verified-gross-profit-roi.v1";
    }
  | {
      status: "not_computable";
      reason: RoiGapCode;
      formulaVersion: "verified-gross-profit-roi.v1";
    };

export class RoiCalculationError extends Error {
  constructor(
    readonly code: string,
    readonly field?: string
  ) {
    super(code);
    this.name = "RoiCalculationError";
  }
}

const requireClosureEvidence = (
  evidence: ClosureCalculationEvidence | null
): void => {
  if (evidence === null
    || Object.values(evidence).some(
      (value) => !/^sha256:[a-f0-9]{64}$/u.test(value)
    )) {
    throw new Error("actual_roi_requires_closure_evidence");
  }
};

const requireUnsignedRoiMinor = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RoiCalculationError("roi_input_invalid", field);
  }
};

const requireSignedRoiInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value)) {
    throw new RoiCalculationError("roi_input_invalid", field);
  }
};

const requireRoiBps = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RoiCalculationError("roi_input_invalid", field);
  }
};

export function calculateExpectedRoi(input: {
  contributions: ExpectedRoiContributionInput[];
  attributedEstimatedCostMinor: number | null;
  costCoverageBps: number;
}): ExpectedRoiResult {
  if (input.attributedEstimatedCostMinor === null) {
    return {
      status: "not_computable",
      reason: "cost_missing",
      formulaVersion: "expected-gross-profit-roi.v1"
    };
  }
  requireUnsignedRoiMinor(
    input.attributedEstimatedCostMinor, "attributedEstimatedCostMinor"
  );
  requireRoiBps(input.costCoverageBps, "costCoverageBps");
  if (input.costCoverageBps !== 10_000) {
    return {
      status: "not_computable",
      reason: "attribution_incomplete",
      formulaVersion: "expected-gross-profit-roi.v1"
    };
  }
  if (input.attributedEstimatedCostMinor === 0) {
    return {
      status: "not_computable",
      reason: "zero_estimated_cost",
      formulaVersion: "expected-gross-profit-roi.v1"
    };
  }
  const ordered = [...input.contributions].sort((left, right) =>
    left.dealId < right.dealId ? -1 : left.dealId > right.dealId ? 1 : 0);
  const seen = new Set<string>();
  let weighted = 0n;
  for (const contribution of ordered) {
    if (seen.has(contribution.dealId)) {
      throw new Error("duplicate_expected_roi_deal");
    }
    seen.add(contribution.dealId);
    requireSignedRoiInteger(
      contribution.approvedGrossProfitMinor, "approvedGrossProfitMinor"
    );
    requireRoiBps(contribution.closeProbabilityBps, "closeProbabilityBps");
    weighted += roundSignedHalfUpDiv(
      BigInt(contribution.approvedGrossProfitMinor)
        * BigInt(contribution.closeProbabilityBps),
      10_000n
    );
  }
  const roi = roundSignedHalfUpDiv(
    (weighted - BigInt(input.attributedEstimatedCostMinor)) * 10_000n,
    BigInt(input.attributedEstimatedCostMinor)
  );
  return {
    status: "computed",
    probabilityWeightedGrossProfitMinor: safeSignedInteger(
      weighted, "probabilityWeightedGrossProfitMinor"
    ),
    attributedEstimatedCostMinor: input.attributedEstimatedCostMinor,
    roiBps: safeSignedInteger(roi, "roiBps"),
    formulaVersion: "expected-gross-profit-roi.v1"
  };
}

export function calculateActualRoiForClosure(
  input: ClosedActualRoiInput
): ClosedActualRoiResult {
  requireClosureEvidence(input.closureEvidence);
  requireUnsignedRoiMinor(input.verifiedRevenueMinor, "verifiedRevenueMinor");
  requireUnsignedRoiMinor(input.verifiedCogsMinor, "verifiedCogsMinor");
  requireUnsignedRoiMinor(input.verifiedRefundMinor, "verifiedRefundMinor");
  requireUnsignedRoiMinor(
    input.verifiedBadDebtMinor, "verifiedBadDebtMinor"
  );
  requireUnsignedRoiMinor(
    input.verifiedAcquisitionCostMinor, "verifiedAcquisitionCostMinor"
  );
  requireRoiBps(input.allCoverageBps, "allCoverageBps");
  if (!input.cashReconciled) {
    return {
      status: "not_computable",
      reason: "cash_reconciliation_incomplete",
      formulaVersion: "verified-gross-profit-roi.v1"
    };
  }
  if (input.allCoverageBps !== 10_000) {
    return {
      status: "not_computable",
      reason: "attribution_incomplete",
      formulaVersion: "verified-gross-profit-roi.v1"
    };
  }
  if (input.verifiedAcquisitionCostMinor === 0) {
    return {
      status: "not_computable",
      reason: "zero_cost",
      formulaVersion: "verified-gross-profit-roi.v1"
    };
  }
  const grossProfit = BigInt(input.verifiedRevenueMinor)
    - BigInt(input.verifiedCogsMinor)
    - BigInt(input.verifiedRefundMinor)
    - BigInt(input.verifiedBadDebtMinor);
  const roi = roundSignedHalfUpDiv(
    (grossProfit - BigInt(input.verifiedAcquisitionCostMinor)) * 10_000n,
    BigInt(input.verifiedAcquisitionCostMinor)
  );
  return {
    status: "computed",
    verifiedGrossProfitMinor: safeSignedInteger(
      grossProfit, "verifiedGrossProfitMinor"
    ),
    verifiedAcquisitionCostMinor: input.verifiedAcquisitionCostMinor,
    roiBps: safeSignedInteger(roi, "roiBps"),
    formulaVersion: "verified-gross-profit-roi.v1"
  };
}

export type RatioResult =
  | {
      status: "computed";
      bps: number;
      formulaVersion: "contract-roas.v1" | "cash-multiple.v1"
        | "collection-rate.v1";
    }
  | {
      status: "not_available";
      reason: "zero_cost" | "zero_contract_amount";
      formulaVersion: "contract-roas.v1" | "cash-multiple.v1"
        | "collection-rate.v1";
    };

export function calculateContractRoas(input: {
  verifiedContractWonMinor: number;
  verifiedAcquisitionCostMinor: number;
}): RatioResult {
  requireUnsignedRoiMinor(input.verifiedContractWonMinor, "verifiedContractWonMinor");
  requireUnsignedRoiMinor(
    input.verifiedAcquisitionCostMinor, "verifiedAcquisitionCostMinor"
  );
  if (input.verifiedAcquisitionCostMinor === 0) {
    return {
      status: "not_available",
      reason: "zero_cost",
      formulaVersion: "contract-roas.v1"
    };
  }
  const bps = roundSignedHalfUpDiv(
    BigInt(input.verifiedContractWonMinor) * 10_000n,
    BigInt(input.verifiedAcquisitionCostMinor)
  );
  return {
    status: "computed",
    bps: safeSignedInteger(bps, "contractRoasBps"),
    formulaVersion: "contract-roas.v1"
  };
}

export function calculateCashMultiple(input: {
  allocatedPaymentMinor: number;
  verifiedAcquisitionCostMinor: number;
}): RatioResult {
  requireUnsignedRoiMinor(input.allocatedPaymentMinor, "allocatedPaymentMinor");
  requireUnsignedRoiMinor(
    input.verifiedAcquisitionCostMinor, "verifiedAcquisitionCostMinor"
  );
  if (input.verifiedAcquisitionCostMinor === 0) {
    return {
      status: "not_available",
      reason: "zero_cost",
      formulaVersion: "cash-multiple.v1"
    };
  }
  const bps = roundSignedHalfUpDiv(
    BigInt(input.allocatedPaymentMinor) * 10_000n,
    BigInt(input.verifiedAcquisitionCostMinor)
  );
  return {
    status: "computed",
    bps: safeSignedInteger(bps, "cashMultipleBps"),
    formulaVersion: "cash-multiple.v1"
  };
}

export function calculateCollectionRate(input: {
  allocatedPaymentMinor: number;
  verifiedContractWonMinor: number;
}): RatioResult {
  requireUnsignedRoiMinor(input.allocatedPaymentMinor, "allocatedPaymentMinor");
  requireUnsignedRoiMinor(
    input.verifiedContractWonMinor, "verifiedContractWonMinor"
  );
  if (input.verifiedContractWonMinor === 0) {
    return {
      status: "not_available",
      reason: "zero_contract_amount",
      formulaVersion: "collection-rate.v1"
    };
  }
  const bps = roundSignedHalfUpDiv(
    BigInt(input.allocatedPaymentMinor) * 10_000n,
    BigInt(input.verifiedContractWonMinor)
  );
  return {
    status: "computed",
    bps: safeSignedInteger(bps, "collectionRateBps"),
    formulaVersion: "collection-rate.v1"
  };
}
