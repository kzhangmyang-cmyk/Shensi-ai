import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import {
  buildFinancialFormulaCatalog,
  validateFinancialFormulaResult,
  type FinancialFormulaCatalog,
  type FinancialFormulaCatalogPolicy,
  type FinancialFormulaResult,
  type FinancialFormulaUnit
} from "./financial-council-formulas.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import { FinancialSnapshotBuilder } from "./financial-council-snapshot.js";
import {
  createFinancialActionProjectionPolicy,
  parseActionHypothesis,
  projectCandidateAction,
  type FinancialActionProjectionPolicy,
  type FinancialActionProjectionPolicyInput
} from "./financial-council-action-projector.js";

const SNAPSHOT_ID = "snapshot-1";
const SNAPSHOT_HASH = `sha256:${"a".repeat(64)}` as const;
const EVIDENCE_HASH = `sha256:${"b".repeat(64)}` as const;
const ACTION_COEFFICIENTS = Object.freeze({
  actionCoefficientVersion: "financial-council-actions.v1",
  costRealizationBps: {
    conservative: 2_500, base: 5_000, optimistic: 7_500
  },
  dataRiskReductionBps: {
    conservative: 500, base: 1_000, optimistic: 1_500
  },
  taxRiskReductionBps: {
    conservative: 1_000, base: 2_000, optimistic: 3_000
  }
});
const FORMULA_POLICY: FinancialFormulaCatalogPolicy = Object.freeze({
  formulaPolicyVersion: "financial-council-formula-policy.v1",
  minimumProductMarginBps: 1_000,
  minimumCashReserveMinor: 900_000
});
const DATA_AS_OF = "2026-08-16T08:00:00.000Z";

function businessReport(): BusinessReportInput {
  return {
    currency: "CNY",
    companyName: "Projection Co",
    period: "2026-08",
    balanceSheet: {
      period: "2026-08", cashMinor: 800_000,
      receivablesMinor: 1_200_000, inventoryMinor: 900_000,
      otherCurrentAssetsMinor: 100_000, nonCurrentAssetsMinor: 500_000,
      currentLiabilitiesMinor: 1_000_000, nonCurrentLiabilitiesMinor: 300_000,
      accountsPayableMinor: 700_000
    },
    incomeStatement: {
      period: "2026-08", revenueMinor: 5_000_000,
      costOfGoodsSoldMinor: 3_000_000, operatingExpensesMinor: 1_000_000,
      interestExpenseMinor: 50_000, taxExpenseMinor: 60_000,
      productLines: [{
        name: "Loss Product", revenueMinor: 1_000_000,
        costOfGoodsSoldMinor: 700_000, afterSalesCostMinor: 100_000,
        shippingCostMinor: 100_000, sellingExpenseMinor: 100_000,
        allocatedOverheadMinor: 100_000
      }],
      customers: [{
        name: "Customer A", revenueMinor: 1_000_000,
        grossProfitMinor: 250_000, serviceCostMinor: 50_000,
        paymentDays: 120, outstandingReceivableMinor: 1_000_000
      }]
    },
    cashFlow: {
      period: "2026-08", openingCashMinor: 600_000,
      operatingInflowMinor: 4_500_000, operatingOutflowMinor: 3_900_000,
      investingNetMinor: 0, financingNetMinor: -400_000,
      receivables: [
        { customer: "Customer A", amountMinor: 1_000_000,
          daysOutstanding: 120 },
        { customer: "Customer B", amountMinor: 200_000,
          daysOutstanding: 30 }
      ],
      expectedInflowsNext30DaysMinor: 100_000,
      expectedOutflowsNext30DaysMinor: 500_000,
      expectedInflowsNext31To90DaysMinor: 800_000,
      expectedOutflowsNext31To90DaysMinor: 300_000
    },
    costDetail: {
      materialCostRateBps: 4_200, previousMaterialCostRateBps: 3_500,
      laborCostMinor: 400_000, rawMaterialCostMinor: 2_100_000,
      salesCommissionRateBps: 500, fixedOverheadMinor: 300_000
    },
    taxRisk: {
      invoiceIssues: ["发票抬头异常"], revenueRecognitionIssues: [],
      costAuthenticityIssues: [], payrollIssues: [], equityIssues: []
    }
  };
}

let trustedCatalogPromise: Promise<FinancialFormulaCatalog> | undefined;

function trustedCatalog(): Promise<FinancialFormulaCatalog> {
  trustedCatalogPromise ??= (async () => {
    const report = businessReport();
    const authorityProjection = {
      workspaceId: "workspace-a", currency: "CNY", dataAsOf: DATA_AS_OF,
      projectionLevel: "full" as const, priorityCustomers: [],
      pendingQuoteApprovals: [], verifiedFinancialFacts: [], expectedRoi: [],
      actualRoi: [], dataGaps: []
    };
    const authority = Object.freeze({
      ...authorityProjection,
      sourceSnapshotHash: financialCouncilCanonicalHash(authorityProjection)
    });
    const snapshot = await new FinancialSnapshotBuilder({
      cutoffIssuer: {
        async sealTodayCutoff() {
          return { effectiveAsOf: DATA_AS_OF } as never;
        }
      },
      authority: { async readAt() { return authority; } },
      businessAdvisor: createBusinessAdvisorService(),
      now: () => "2026-08-16T09:00:00.000Z"
    }).freeze({
      workspace: {
        workspaceId: "workspace-a", kind: "team", actorId: "admin-1",
        role: "admin", teamId: "all",
        capabilities: ["pricing.sensitive.read"],
        capabilityRegistryVersion: "growth-capabilities.v1"
      },
      actorId: "admin-1", idempotencyKey: "projection-1",
      requestHash: `sha256:${"r".repeat(64)}`, expectedRevision: null
    }, "run-1", {
      currency: "CNY", dataAsOf: DATA_AS_OF, businessReport: report,
      policyVersionId: "policy-1"
    });
    return buildFinancialFormulaCatalog({
      snapshot, businessReport: report, policy: FORMULA_POLICY
    });
  })();
  return trustedCatalogPromise;
}

async function trustedFormula(formulaId: string): Promise<FinancialFormulaResult> {
  const formulaResult = (await trustedCatalog()).formulaResults.find(
    (candidate) => candidate.formulaId === formulaId
  );
  assert.ok(formulaResult, formulaId);
  return formulaResult;
}

function formula(
  formulaId: string,
  formulaVersion: string,
  value: unknown,
  unit: FinancialFormulaUnit = "minor"
): FinancialFormulaResult {
  const input = { source: "test-fixture" };
  const evidenceRefs = [{
    source: "business_report" as const,
    sourceId: "business-report",
    contentHash: EVIDENCE_HASH
  }];
  const inputHash = financialCouncilCanonicalHash({
    formulaId,
    formulaVersion,
    snapshotId: SNAPSHOT_ID,
    snapshotHash: SNAPSHOT_HASH,
    currency: "CNY",
    input,
    evidenceRefs
  });
  const preimage = {
    formulaId,
    formulaVersion,
    snapshotId: SNAPSHOT_ID,
    snapshotHash: SNAPSHOT_HASH,
    currency: "CNY",
    inputHash,
    value,
    unit,
    evidenceRefs
  };
  return Object.freeze({
    ...preimage,
    resultHash: financialCouncilCanonicalHash(preimage)
  });
}

function policyInput(
  formulas: readonly FinancialFormulaResult[]
): FinancialActionProjectionPolicyInput {
  const formulaResult = formulas[0];
  assert.ok(formulaResult);
  return Object.freeze({
    ...ACTION_COEFFICIENTS,
    snapshotId: formulaResult.snapshotId,
    snapshotHash: formulaResult.snapshotHash,
    currency: formulaResult.currency as "CNY" | "USD"
  });
}

function trustedProjectionPolicy(
  formulas: readonly FinancialFormulaResult[]
): FinancialActionProjectionPolicy {
  return createFinancialActionProjectionPolicy(policyInput(formulas), formulas);
}

function untrustedProjectionPolicy(
  formulas: readonly FinancialFormulaResult[]
): FinancialActionProjectionPolicy {
  return Object.freeze({
    ...policyInput(formulas),
    trustedFormulaRefs: formulas.map((formulaResult) => Object.freeze({
      formulaId: formulaResult.formulaId,
      formulaVersion: formulaResult.formulaVersion,
      inputHash: formulaResult.inputHash,
      resultHash: formulaResult.resultHash,
      unit: formulaResult.unit,
      evidenceHash: financialCouncilCanonicalHash(formulaResult.evidenceRefs)
    })).sort((left, right) => left.formulaId.localeCompare(right.formulaId))
  } as FinancialActionProjectionPolicy);
}

function rehashFormula(
  source: FinancialFormulaResult,
  patch: Partial<Omit<FinancialFormulaResult, "resultHash">>
): FinancialFormulaResult {
  const { resultHash: _discarded, ...sourcePreimage } = source;
  const preimage = { ...sourcePreimage, ...patch };
  return Object.freeze({
    ...preimage,
    resultHash: financialCouncilCanonicalHash(preimage)
  });
}

function hypothesis(kind: string, subjectRef: string | null = null) {
  return parseActionHypothesis({
    kind,
    sourceFindingIds: ["finding-1"],
    subjectRef,
    explanation: "Use the verified formula basis"
  });
}

test("model hypothesis cannot supply scenario money or BPS", () => {
  for (const extra of [
    { cashImpact: { base: 999_999_999 } },
    { profitImpactMinor: 999_999_999 },
    { confidenceBps: 10_000 },
    { costRealizationBps: 10_000 }
  ]) {
    assert.throws(
      () => parseActionHypothesis({
        kind: "collect_receivable",
        sourceFindingIds: ["finding-1"],
        subjectRef: null,
        explanation: "Collect the overdue balance",
        ...extra
      }),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_action_hypothesis_invalid"
    );
  }
});

test("hypothesis parser rejects unknown kinds, duplicate refs and open shapes", () => {
  const invalid = [
    {
      kind: "wire_money", sourceFindingIds: ["finding-1"],
      subjectRef: null, explanation: "unknown"
    },
    {
      kind: "collect_receivable", sourceFindingIds: ["finding-1", "finding-1"],
      subjectRef: null, explanation: "duplicate"
    },
    {
      kind: "collect_receivable", sourceFindingIds: ["finding-1"],
      subjectRef: null, explanation: "open", tool: "write"
    }
  ];
  for (const value of invalid) {
    assert.throws(() => parseActionHypothesis(value), /financial_action_hypothesis_invalid/u);
  }
});

test("hostile null throws normalize to stable action errors", () => {
  const originalStructuredClone = globalThis.structuredClone;
  globalThis.structuredClone = (() => { throw null; }) as typeof structuredClone;
  try {
    assert.throws(
      () => parseActionHypothesis({
        kind: "collect_receivable",
        sourceFindingIds: ["finding-1"],
        subjectRef: null,
        explanation: "Collect"
      }),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_action_hypothesis_invalid"
    );
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }
});

test("receivable scenarios are derived from the frozen formula basis", async () => {
  const formulas = [await trustedFormula("eligible_overdue_receivable")];
  const action = projectCandidateAction(
    hypothesis("collect_receivable"),
    formulas,
    trustedProjectionPolicy(formulas)
  );

  assert.deepEqual(action.cashImpact, {
    conservative: 300_000, base: 500_000, optimistic: 700_000
  });
  assert.deepEqual(action.profitImpact, {
    conservative: 0, base: 0, optimistic: 0
  });
});

test("loss-product pricing uses only the selected policy-margin gap", async () => {
  const formulas = [await trustedFormula("loss_product_pricing_gap")];
  const action = projectCandidateAction(
    hypothesis("review_loss_product_pricing", "Loss Product"),
    formulas,
    trustedProjectionPolicy(formulas)
  );

  assert.deepEqual(action.profitImpact, {
    conservative: 100_000, base: 150_000, optimistic: 200_000
  });
  assert.deepEqual(action.cashImpact, {
    conservative: 0, base: 0, optimistic: 0
  });
});

test("cost anomaly realization is bounded by policy coefficients", async () => {
  const formulas = [await trustedFormula("verified_avoidable_cost")];
  const action = projectCandidateAction(
    hypothesis("reduce_cost_anomaly"),
    formulas,
    trustedProjectionPolicy(formulas)
  );

  assert.deepEqual(action.profitImpact, {
    conservative: 87_500, base: 175_000, optimistic: 262_500
  });
});

test("cash reserve action exposes shortfall only and never invents funding", async () => {
  const formulas = [await trustedFormula("cash_shortfall")];
  const action = projectCandidateAction(
    hypothesis("prepare_cash_reserve_budget"),
    formulas,
    trustedProjectionPolicy(formulas)
  );

  assert.deepEqual(action.cashImpact, {
    conservative: -500_000, base: 0, optimistic: 0
  });
  assert.deepEqual(action.profitImpact, {
    conservative: 0, base: 0, optimistic: 0
  });
});

test("data completion and tax review always have zero direct money impact", async () => {
  const dataFormulas = [await trustedFormula("financial_data_gaps")];
  const dataAction = projectCandidateAction(
    hypothesis("complete_financial_data"),
    dataFormulas,
    trustedProjectionPolicy(dataFormulas)
  );
  const taxFormulas = [await trustedFormula("tax_risk")];
  const taxAction = projectCandidateAction(
    parseActionHypothesis({
      kind: "schedule_tax_review",
      sourceFindingIds: ["finding-tax"],
      subjectRef: null,
      explanation: "Review invoice evidence"
    }),
    taxFormulas,
    trustedProjectionPolicy(taxFormulas)
  );
  const sameTaxAction = projectCandidateAction(
    parseActionHypothesis({
      kind: "schedule_tax_review",
      sourceFindingIds: ["finding-tax"],
      subjectRef: null,
      explanation: "Inspect payroll evidence"
    }),
    taxFormulas,
    trustedProjectionPolicy(taxFormulas)
  );

  for (const action of [dataAction, taxAction]) {
    assert.deepEqual(action.cashImpact, {
      conservative: 0, base: 0, optimistic: 0
    });
    assert.deepEqual(action.profitImpact, {
      conservative: 0, base: 0, optimistic: 0
    });
  }
  assert.deepEqual(dataAction.riskReductionBps,
    ACTION_COEFFICIENTS.dataRiskReductionBps);
  assert.deepEqual(taxAction.riskReductionBps,
    ACTION_COEFFICIENTS.taxRiskReductionBps);
  assert.equal(taxAction.explanation, "税务风险筛查动作；需专业人员复核");
  assert.equal(sameTaxAction.actionId, taxAction.actionId);
});

test("tax hypothesis cannot claim compliance, avoidance or filing authority", () => {
  for (const explanation of [
    "已合规", "制定避税方案", "代为申报", "不需专业人员复核",
    "无需\n专业人员复核", "制定税收规避方案", "可自行申报"
  ]) {
    assert.throws(
      () => parseActionHypothesis({
        kind: "schedule_tax_review",
        sourceFindingIds: ["finding-tax"],
        subjectRef: null,
        explanation
      }),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_action_hypothesis_invalid"
    );
  }
});

test("missing, forged, cross-snapshot and wrong-currency formula results fail closed", async () => {
  const valid = await trustedFormula("eligible_overdue_receivable");
  const forged = { ...valid, value: { totalMinor: 9_000_000, bySubject: [] } };
  const crossSnapshot = rehashFormula(valid, {
    snapshotId: "snapshot-2",
    snapshotHash: `sha256:${"c".repeat(64)}`,
  });
  const wrongCurrency = rehashFormula(valid, { currency: "USD" });
  const trustedPolicy = trustedProjectionPolicy([valid]);

  for (const formulas of [[], [forged], [crossSnapshot], [wrongCurrency]]) {
    assert.throws(
      () => projectCandidateAction(
        hypothesis("collect_receivable"), formulas as never, trustedPolicy
      ),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_action_projection_invalid"
    );
  }
});

test("self-consistent forged formula and policy lookalikes lack provenance", async () => {
  const trusted = await trustedFormula("eligible_overdue_receivable");
  const forged = rehashFormula(trusted, {
    value: {
      totalMinor: 9_000_000_000_000_000,
      bySubject: [{
        subjectRef: "Customer A", amountMinor: 9_000_000_000_000_000
      }]
    }
  });
  const replayed = structuredClone(trusted);
  const policy = trustedProjectionPolicy([trusted]);

  assert.doesNotThrow(() => projectCandidateAction(
    hypothesis("collect_receivable"), [trusted], policy
  ));
  for (const [formulas, candidatePolicy] of [
    [[forged], policy],
    [[forged], untrustedProjectionPolicy([forged])],
    [[replayed], policy]
  ] as const) {
    assert.throws(
      () => projectCandidateAction(
        hypothesis("collect_receivable"), formulas, candidatePolicy
      ),
      /financial_action_projection_invalid/u
    );
  }
  assert.throws(
    () => createFinancialActionProjectionPolicy(
      policyInput([forged]), [forged]
    ),
    /financial_action_projection_invalid/u
  );
  assert.throws(
    () => createFinancialActionProjectionPolicy(
      policyInput([replayed]), [replayed]
    ),
    /financial_action_projection_invalid/u
  );
});

test("unsafe formula money and invalid policy BPS fail closed", async () => {
  const unsafeFormula = formula(
    "eligible_overdue_receivable",
    "eligible-overdue-receivable.v1",
    {
      totalMinor: Number.MAX_SAFE_INTEGER + 1,
      bySubject: []
    },
    "structured"
  );
  assert.throws(
    () => validateFinancialFormulaResult(unsafeFormula),
    /financial_formula_input_invalid/u
  );
  const formulas = [await trustedFormula("verified_avoidable_cost")];
  assert.throws(
    () => createFinancialActionProjectionPolicy(
      {
        ...policyInput(formulas),
        costRealizationBps: {
          conservative: 2_500, base: 5_000, optimistic: 10_001
        }
      },
      formulas
    ),
    /financial_action_projection_invalid/u
  );
});
