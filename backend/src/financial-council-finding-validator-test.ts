import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import {
  FinancialFindingValidator
} from "./financial-council-finding-validator.js";
import {
  builderSnapshotFixture,
  repositoryRunFixture
} from "./financial-council-repository-contract-test.js";
import type {
  FinancialCouncilAnalyzeOutput
} from "./financial-council-model-port.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";
import { validateFinancialCouncilSpecialistResult } from
  "./financial-council-repository.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function report(): BusinessReportInput {
  return {
    currency: "CNY", companyName: "Validator Co", period: "2026-08",
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
      receivables: [{ customer: "Customer A", amountMinor: 1_000_000,
        daysOutstanding: 120 }],
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
      invoiceIssues: ["发票异常"], revenueRecognitionIssues: [],
      costAuthenticityIssues: [], payrollIssues: [], equityIssues: []
    }
  };
}

async function validator(now = "2026-08-16T09:00:00.000Z") {
  const rawRun = repositoryRunFixture({
    businessReport: report(), policyVersionId: "policy-v1"
  });
  const record = await builderSnapshotFixture(rawRun, [Object.freeze({
    entryId: "payment-fact-1",
    sourceVersion: 1,
    factType: "payment_received" as const,
    currency: "CNY",
    businessOccurredAt: "2026-08-14T08:00:00.000Z",
    entryRecordedAt: "2026-08-14T08:01:00.000Z",
    verificationRevision: 1,
    verificationRecordedAt: "2026-08-14T08:02:00.000Z",
    snapshotHash: HASH,
    amountVisibility: "redacted" as const
  })]);
  const run = Object.freeze({
    ...rawRun,
    status: "snapshot_frozen" as const,
    revision: 2,
    snapshotId: record.snapshotId,
    snapshotHash: record.snapshotHash,
    updatedAt: record.createdAt
  });
  return new FinancialFindingValidator({
    run,
    snapshot: record.snapshot,
    formulaPolicy: {
      formulaPolicyVersion: "financial-council-formula-policy.v1",
      minimumProductMarginBps: 1_000,
      minimumCashReserveMinor: 900_000
    },
    actionPolicy: {
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
    },
    now: () => now
  });
}

function outputFor(
  projection: ReturnType<FinancialFindingValidator["project"]>,
  overrides: Record<string, unknown> = {}
): FinancialCouncilAnalyzeOutput {
  return {
    findingDrafts: [{
      findingId: projection.allowlist.findingIds[0]!,
      conclusion: projection.role === "tax"
        ? "税务风险需专业人员复核"
        : "risk_hypothesis",
      evidenceRefs: [projection.allowlist.evidenceRefIds[0]!],
      formulaRef: projection.allowlist.formulaRefIds[0] ?? null,
      confidenceBps: 8_000,
      severity: "warning",
      assumptions: [],
      missingDataRefs: [],
      ...overrides
    }],
    actionHypotheses: []
  } as FinancialCouncilAnalyzeOutput;
}

function formulaRow(
  projection: ReturnType<FinancialFindingValidator["project"]>,
  formulaId: string
) {
  const data = projection.businessData as {
    formulas: Array<{
      refId: string;
      formulaId: string;
      evidenceRefIds: string[];
    }>;
  };
  return data.formulas.find((formula) => formula.formulaId === formulaId)!;
}

function rejected(code: string) {
  return (error: unknown) => (error as { code?: unknown }).code === code;
}

test("validator accepts a role-owned finding and projects action money on server", async () => {
  const service = await validator();
  const projection = service.project("cashflow");
  const findingId = projection.allowlist.findingIds[0]!;
  const receivable = formulaRow(projection, "eligible_overdue_receivable");
  const output = outputFor(projection, {
    formulaRef: receivable.refId,
    evidenceRefs: [receivable.evidenceRefIds[0]!]
  });
  output.actionHypotheses = [{
    kind: "collect_receivable",
    sourceFindingIds: [findingId],
    subjectRef: "Customer A",
    explanation: "collect_receivable_hypothesis"
  }];

  const validated = service.validate("cashflow", output);

  assert.deepEqual(validated.actions[0]!.cashImpact, {
    conservative: 300_000, base: 500_000, optimistic: 700_000
  });
  assert.deepEqual(validated.findings[0]!.candidateActionIds,
    [validated.actions[0]!.actionId]);
});

test("validator binds formula evidence and action sources to one trusted basis", async () => {
  const service = await validator();
  const projection = service.project("cashflow");
  const receivable = formulaRow(projection, "eligible_overdue_receivable");
  const shortfall = formulaRow(projection, "cash_shortfall");
  const unrelatedFactEvidence = (projection.businessData as {
    evidence: Array<{ refId: string; source: string }>;
  }).evidence.find((row) => row.source === "financial_fact")!.refId;
  const unrelatedEvidence = outputFor(projection, {
    formulaRef: receivable.refId,
    evidenceRefs: [unrelatedFactEvidence]
  });
  const wrongFormulaAction = outputFor(projection, {
    formulaRef: shortfall.refId,
    evidenceRefs: [shortfall.evidenceRefIds[0]!]
  });
  wrongFormulaAction.actionHypotheses = [{
    kind: "collect_receivable",
    sourceFindingIds: [wrongFormulaAction.findingDrafts[0]!.findingId],
    subjectRef: "Customer A",
    explanation: "collect_receivable_hypothesis"
  }];

  assert.throws(() => service.validate("cashflow", unrelatedEvidence),
    rejected("financial_finding_invalid"));
  assert.throws(() => service.validate("cashflow", wrongFormulaAction),
    rejected("financial_finding_invalid"));
});

test("validator fails closed on cross-snapshot refs and hidden amount or impact", async () => {
  const service = await validator();
  const projection = service.project("cashflow");
  for (const output of [
    outputFor(projection, { formulaRef: `formula:${"f".repeat(64)}` }),
    outputFor(projection, { amountMinor: 999_999 }),
    {
      ...outputFor(projection),
      actionHypotheses: [{
        kind: "collect_receivable",
        sourceFindingIds: [projection.allowlist.findingIds[0]!],
        subjectRef: "Customer A",
        explanation: "collect_receivable_hypothesis",
        cashImpact: { base: 999_999 }
      }]
    }
  ]) {
    assert.throws(() => service.validate("cashflow", output),
      rejected("financial_finding_invalid"));
  }
});

test("validator rejects unauthorized evidence, subject, role action and confidence", async () => {
  const service = await validator();
  const projection = service.project("profit");
  const findingId = projection.allowlist.findingIds[0]!;
  for (const output of [
    outputFor(projection, { evidenceRefs: ["evidence:foreign"] }),
    outputFor(projection, { confidenceBps: 10_001 }),
    {
      ...outputFor(projection),
      actionHypotheses: [{
        kind: "review_loss_product_pricing",
        sourceFindingIds: [findingId],
        subjectRef: "Foreign Product",
        explanation: "review_loss_product_pricing_hypothesis"
      }]
    },
    {
      ...outputFor(projection),
      actionHypotheses: [{
        kind: "collect_receivable",
        sourceFindingIds: [findingId],
        subjectRef: "Loss Product",
        explanation: "collect_receivable_hypothesis"
      }]
    }
  ]) {
    assert.throws(() => service.validate("profit", output),
      rejected("financial_finding_invalid"));
  }
});

test("tax validation rejects compliance or filing claims and missing closed assumptions", async () => {
  const service = await validator();
  const projection = service.project("tax");
  for (const output of [
    outputFor(projection, { conclusion: "已合规" }),
    outputFor(projection, { assumptions: ["可以直接申报"] }),
    (() => {
      const output = structuredClone(outputFor(projection)) as unknown as {
        findingDrafts: Array<Record<string, unknown>>
      };
      delete output.findingDrafts[0]!.assumptions;
      return output;
    })()
  ]) {
    assert.throws(() => service.validate("tax", output),
      rejected("financial_finding_invalid"));
  }
});

test("validator rejects future snapshots, unknown actions, and cross-role formula refs", async () => {
  await assert.rejects(
    validator("2026-08-14T00:00:00.000Z"),
    rejected("financial_finding_invalid")
  );
  const service = await validator();
  const cashflow = service.project("cashflow");
  const profit = service.project("profit");
  assert.throws(() => service.validate("cashflow", outputFor(cashflow, {
    formulaRef: profit.allowlist.formulaRefIds[0]
  })), rejected("financial_finding_invalid"));
  const unknown = {
    ...outputFor(cashflow),
    actionHypotheses: [{
      kind: "wire_funds_now",
      sourceFindingIds: [cashflow.allowlist.findingIds[0]],
      subjectRef: null,
      explanation: "wire_funds_now"
    }]
  };
  assert.throws(() => service.validate("cashflow", unknown),
    rejected("financial_finding_invalid"));
});

test("validator rejects duplicate projected action identities", async () => {
  const service = await validator();
  const projection = service.project("cashflow");
  const action = {
    kind: "collect_receivable" as const,
    sourceFindingIds: [projection.allowlist.findingIds[0]!],
    subjectRef: "Customer A",
    explanation: "collect_receivable_hypothesis"
  };
  const output = {
    ...outputFor(projection),
    actionHypotheses: [action, structuredClone(action)]
  };

  assert.throws(() => service.validate("cashflow", output),
    rejected("financial_finding_invalid"));
});

test("validator reauthorizes the server-owned tax action projection", async () => {
  const service = await validator();
  const projection = service.project("tax");
  const formula = formulaRow(projection, "tax_risk");
  const findingId = projection.allowlist.findingIds[0]!;
  const output = outputFor(projection, {
    formulaRef: formula.refId,
    evidenceRefs: [formula.evidenceRefIds[0]!]
  });
  output.actionHypotheses = [{
    kind: "schedule_tax_review",
    sourceFindingIds: [findingId],
    subjectRef: null,
    explanation: "税务风险需专业人员复核"
  }];
  const validated = service.validate("tax", output);
  const snapshotBinding = (projection.businessData as {
    snapshot: {
      workspaceId: string;
      runId: string;
      snapshotId: string;
      snapshotHash: `sha256:${string}`;
    };
  }).snapshot;
  const identity = {
    workspaceId: snapshotBinding.workspaceId,
    runId: snapshotBinding.runId,
    snapshotId: snapshotBinding.snapshotId,
    snapshotHash: snapshotBinding.snapshotHash
  };
  const jobId = `financial-council:${identity.runId}:tax:analyze:1`;
  const resultId = financialCouncilCanonicalHash({
    ...identity,
    role: "tax",
    phase: "analyze",
    attempt: 1,
    outputHash: validated.outputHash,
    modelJobId: jobId
  });
  const preimage = {
    resultId,
    ...identity,
    role: "tax" as const,
    phase: "analyze" as const,
    attempt: 1,
    outputHash: validated.outputHash,
    modelBinding: {
      jobId,
      runId: identity.runId,
      snapshotId: identity.snapshotId,
      snapshotHash: identity.snapshotHash,
      role: "tax" as const,
      phase: "analyze" as const,
      attempt: 1,
      connectionId: "connection-1",
      credentialVersion: 1,
      provider: "openai" as const,
      model: "gpt-test",
      capabilitySnapshotHash: HASH,
      baseUrlFingerprint: "official-endpoint",
      promptVersion: "financial-council-tax-analyze.v1",
      schemaVersion: "financial-council-specialist-output.v1",
      contentHash: HASH,
      promptHash: HASH,
      schemaHash: HASH
    },
    repaired: false,
    providerRequestId: null,
    findings: validated.findings,
    actions: validated.actions,
    createdAt: "2026-08-16T09:00:00.000Z"
  };

  const result = {
    ...preimage,
    resultHash: financialCouncilCanonicalHash(preimage)
  };
  assert.doesNotThrow(() => validateFinancialCouncilSpecialistResult(result));
  assert.doesNotThrow(() => service.authorizeSpecialistResult(result));
  assert.equal(validated.actions[0]!.explanation,
    "税务风险筛查动作；需专业人员复核");
});
