import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import {
  buildFinancialFormulaCatalog,
  validateFinancialFormulaResult,
  type FinancialFormulaCatalogPolicy
} from "./financial-council-formulas.js";
import {
  FinancialSnapshotBuilder,
  type FinancialSnapshot
} from "./financial-council-snapshot.js";

const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;
const DATA_AS_OF = "2026-08-16T08:00:00.000Z";
const POLICY: FinancialFormulaCatalogPolicy = Object.freeze({
  formulaPolicyVersion: "financial-council-formula-policy.v1",
  minimumProductMarginBps: 1_000,
  minimumCashReserveMinor: 900_000
});

function report(): BusinessReportInput {
  return {
    currency: "CNY",
    companyName: "Formula Co",
    period: "2026-08",
    balanceSheet: {
      period: "2026-08",
      cashMinor: 800_000,
      receivablesMinor: 1_200_000,
      inventoryMinor: 900_000,
      otherCurrentAssetsMinor: 100_000,
      nonCurrentAssetsMinor: 500_000,
      currentLiabilitiesMinor: 1_000_000,
      nonCurrentLiabilitiesMinor: 300_000,
      accountsPayableMinor: 700_000
    },
    incomeStatement: {
      period: "2026-08",
      revenueMinor: 5_000_000,
      costOfGoodsSoldMinor: 3_000_000,
      operatingExpensesMinor: 1_000_000,
      interestExpenseMinor: 50_000,
      taxExpenseMinor: 60_000,
      productLines: [{
        name: "Loss Product",
        revenueMinor: 1_000_000,
        costOfGoodsSoldMinor: 700_000,
        afterSalesCostMinor: 100_000,
        shippingCostMinor: 100_000,
        sellingExpenseMinor: 100_000,
        allocatedOverheadMinor: 100_000
      }],
      customers: [{
        name: "Customer A",
        revenueMinor: 1_000_000,
        grossProfitMinor: 250_000,
        serviceCostMinor: 50_000,
        paymentDays: 120,
        outstandingReceivableMinor: 1_000_000
      }]
    },
    cashFlow: {
      period: "2026-08",
      openingCashMinor: 600_000,
      operatingInflowMinor: 4_500_000,
      operatingOutflowMinor: 3_900_000,
      investingNetMinor: 0,
      financingNetMinor: -400_000,
      receivables: [
        { customer: "Customer A", amountMinor: 1_000_000, daysOutstanding: 120 },
        { customer: "Customer B", amountMinor: 200_000, daysOutstanding: 30 }
      ],
      expectedInflowsNext30DaysMinor: 100_000,
      expectedOutflowsNext30DaysMinor: 500_000,
      expectedInflowsNext31To90DaysMinor: 800_000,
      expectedOutflowsNext31To90DaysMinor: 300_000
    },
    costDetail: {
      materialCostRateBps: 4_200,
      previousMaterialCostRateBps: 3_500,
      laborCostMinor: 400_000,
      rawMaterialCostMinor: 2_100_000,
      salesCommissionRateBps: 500,
      fixedOverheadMinor: 300_000
    },
    taxRisk: {
      invoiceIssues: ["发票抬头异常"],
      revenueRecognitionIssues: [],
      costAuthenticityIssues: [],
      payrollIssues: [],
      equityIssues: []
    }
  };
}

async function freeze(
  businessReport: BusinessReportInput,
  options: {
    readonly unverifiedCost?: boolean;
    readonly manyEvidenceRefs?: boolean;
  } = {}
): Promise<FinancialSnapshot> {
  const authorityDataGaps = options.manyEvidenceRefs
    ? Array.from({ length: 99 }, (_, index) => ({
        code: "import_requires_review" as const,
        sourceType: "finance_import" as const,
        sourceId: `import-${String(index).padStart(2, "0")}`,
        sourceSnapshotHash: HASH("c"),
        cohortId: null,
        currency: "CNY",
        asOf: DATA_AS_OF
      }))
    : options.unverifiedCost ? [{
        code: "unverified_cost" as const,
        sourceType: "cost_entry" as const,
        sourceId: "cost-1",
        sourceSnapshotHash: HASH("c"),
        cohortId: null,
        currency: "CNY",
        asOf: DATA_AS_OF
      }] : [];
  const authorityProjection = {
    workspaceId: "workspace-a",
    currency: "CNY",
    dataAsOf: DATA_AS_OF,
    projectionLevel: "full" as const,
    priorityCustomers: [],
    pendingQuoteApprovals: [],
    verifiedFinancialFacts: [],
    expectedRoi: [],
    actualRoi: [],
    dataGaps: authorityDataGaps
  };
  const authority = Object.freeze({
    ...authorityProjection,
    sourceSnapshotHash: financialCouncilCanonicalHash(authorityProjection)
  });
  const builder = new FinancialSnapshotBuilder({
    cutoffIssuer: {
      async sealTodayCutoff() {
        return { effectiveAsOf: DATA_AS_OF } as never;
      }
    },
    authority: {
      async readAt() { return authority; }
    },
    businessAdvisor: createBusinessAdvisorService(),
    now: () => "2026-08-16T09:00:00.000Z"
  });
  return builder.freeze({
    workspace: {
      workspaceId: "workspace-a", kind: "team", actorId: "admin-1",
      role: "admin", teamId: "all",
      capabilities: ["pricing.sensitive.read"],
      capabilityRegistryVersion: "growth-capabilities.v1"
    },
    actorId: "admin-1", idempotencyKey: "formula-1",
    requestHash: HASH("r"), expectedRevision: null
  }, "run-1", {
    currency: "CNY", dataAsOf: DATA_AS_OF,
    businessReport, policyVersionId: "policy-1"
  });
}

function resultById(
  catalog: Awaited<ReturnType<typeof buildFinancialFormulaCatalog>>,
  formulaId: string
) {
  return catalog.formulaResults.find((result) => result.formulaId === formulaId);
}

test("formula replay is deterministic and bound to snapshot evidence", async () => {
  const firstReport = report();
  const secondReport = structuredClone(firstReport);
  secondReport.cashFlow!.receivables!.reverse();
  const firstSnapshot = await freeze(firstReport);
  const secondSnapshot = await freeze(secondReport);

  const first = buildFinancialFormulaCatalog({
    snapshot: firstSnapshot, businessReport: firstReport, policy: POLICY
  });
  const second = buildFinancialFormulaCatalog({
    snapshot: secondSnapshot, businessReport: secondReport, policy: POLICY
  });

  assert.deepEqual(first, second);
  assert.equal(first.dataGaps.length, 0);
  assert.equal(first.formulaResults.length, 11);
  for (const formula of first.formulaResults) {
    assert.equal(formula.snapshotId, firstSnapshot.snapshotId);
    assert.equal(formula.snapshotHash, firstSnapshot.snapshotHash);
    assert.equal(formula.currency, "CNY");
    assert.match(formula.inputHash, /^sha256:[0-9a-f]{64}$/u);
    assert.match(formula.resultHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(formula.evidenceRefs.some(
      (ref) => ref.source === "business_report"
        && ref.contentHash === firstSnapshot.reportInputHash
    ), true);
  }
});

test("hostile null throws normalize to the stable formula error", async () => {
  const businessReport = report();
  const snapshot = await freeze(businessReport);
  const formulaResult = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  }).formulaResults[0]!;
  const originalStructuredClone = globalThis.structuredClone;
  globalThis.structuredClone = (() => { throw null; }) as typeof structuredClone;
  try {
    assert.throws(
      () => validateFinancialFormulaResult(formulaResult),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_formula_input_invalid"
    );
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }
});

test("catalog accepts the snapshot canonical order for multiple warnings and tax findings", async () => {
  const businessReport = report();
  businessReport.cashFlow!.expectedOutflowsNext30DaysMinor = 2_000_000;
  businessReport.taxRisk!.payrollIssues = ["薪酬证据不完整"];
  const snapshot = await freeze(businessReport);

  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });

  assert.equal(resultById(catalog, "cashflow_forecast") !== undefined, true);
  assert.equal(resultById(catalog, "tax_risk") !== undefined, true);
});

test("action bases use integer formulas from the canonical report", async () => {
  const businessReport = report();
  const snapshot = await freeze(businessReport);
  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });

  assert.deepEqual(resultById(catalog, "eligible_overdue_receivable")?.value, {
    totalMinor: 1_000_000,
    bySubject: [{ subjectRef: "Customer A", amountMinor: 1_000_000 }]
  });
  assert.deepEqual(resultById(catalog, "loss_product_pricing_gap")?.value, {
    totalMinor: 200_000,
    minimumMarginBps: 1_000,
    bySubject: [{
      subjectRef: "Loss Product",
      revenueMinor: 1_000_000,
      currentTrueProfitMinor: -100_000,
      targetProfitMinor: 100_000,
      gapMinor: 200_000
    }]
  });
  assert.deepEqual(resultById(catalog, "verified_avoidable_cost")?.value, {
    basisMinor: 350_000,
    materialRateChangeBps: 700
  });
  assert.deepEqual(resultById(catalog, "cash_shortfall")?.value, {
    next30DaysMinor: 500_000,
    next90DaysMinor: 0
  });
});

test("duplicate product names form one unambiguous action subject basis", async () => {
  const businessReport = report();
  businessReport.incomeStatement.productLines!.push({
    name: "Loss Product",
    revenueMinor: 500_000,
    costOfGoodsSoldMinor: 350_000,
    afterSalesCostMinor: 50_000,
    shippingCostMinor: 50_000,
    sellingExpenseMinor: 50_000,
    allocatedOverheadMinor: 50_000
  });
  const snapshot = await freeze(businessReport);
  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });

  assert.deepEqual(resultById(catalog, "loss_product_pricing_gap")?.value, {
    totalMinor: 300_000,
    minimumMarginBps: 1_000,
    bySubject: [{
      subjectRef: "Loss Product",
      revenueMinor: 1_500_000,
      currentTrueProfitMinor: -150_000,
      targetProfitMinor: 150_000,
      gapMinor: 300_000
    }]
  });
});

test("missing required sections become formula data gaps instead of zero facts", async () => {
  const businessReport = report();
  delete businessReport.cashFlow;
  delete businessReport.costDetail;
  delete businessReport.taxRisk;
  delete businessReport.incomeStatement.productLines;
  const snapshot = await freeze(businessReport);

  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });
  const missing = new Set(catalog.dataGaps.map((gap) => gap.formulaId));

  for (const formulaId of [
    "product_true_profit", "cashflow_forecast",
    "cost_analysis", "tax_risk", "eligible_overdue_receivable",
    "loss_product_pricing_gap", "verified_avoidable_cost", "cash_shortfall"
  ]) {
    assert.equal(missing.has(formulaId), true, formulaId);
    assert.equal(resultById(catalog, formulaId), undefined);
  }
  assert.deepEqual(resultById(catalog, "financial_data_gaps")?.value, {
    count: 6
  });
});

test("unverified cost cannot become an avoidable-cost money basis", async () => {
  const businessReport = report();
  const snapshot = await freeze(businessReport, { unverifiedCost: true });
  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });

  assert.equal(resultById(catalog, "verified_avoidable_cost"), undefined);
  assert.equal(catalog.dataGaps.some((gap) =>
    gap.formulaId === "verified_avoidable_cost"
      && gap.dataGap.code === "unverified_cost"), true);
});

test("valid aggregate evidence above one hundred refs remains computable", async () => {
  const businessReport = report();
  const snapshot = await freeze(businessReport, { manyEvidenceRefs: true });
  assert.equal(snapshot.sourceRefs.length, 101);

  const catalog = buildFinancialFormulaCatalog({
    snapshot, businessReport, policy: POLICY
  });

  assert.equal(
    resultById(catalog, "financial_data_gaps")?.evidenceRefs.length,
    101
  );
});

test("mismatched report, currency, snapshot hash and unsafe policy fail closed", async () => {
  const businessReport = report();
  const snapshot = await freeze(businessReport);
  const changedReport = structuredClone(businessReport);
  changedReport.balanceSheet.cashMinor += 1;
  const invalidSnapshot = { ...snapshot, snapshotHash: HASH("x") };

  for (const input of [
    { snapshot, businessReport: changedReport, policy: POLICY },
    { snapshot, businessReport: { ...businessReport, currency: "USD" }, policy: POLICY },
    { snapshot: invalidSnapshot, businessReport, policy: POLICY },
    {
      snapshot, businessReport,
      policy: { ...POLICY, minimumCashReserveMinor: Number.MAX_SAFE_INTEGER + 1 }
    }
  ]) {
    assert.throws(
      () => buildFinancialFormulaCatalog(input as never),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_formula_input_invalid"
    );
  }
});
