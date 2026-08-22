import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import {
  InMemoryFinancialCouncilRepository
} from "./financial-council-repository.js";
import {
  command,
  repositoryRunFixture,
  builderSnapshotFixture,
  T1,
  workspace
} from "./financial-council-repository-contract-test.js";
import type {
  FinancialCouncilAnalyzeInput,
  FinancialCouncilModelPort,
  FinancialCouncilModelResult
} from "./financial-council-model-port.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";
import {
  FinancialCouncilSpecialistCoordinator,
  FINANCIAL_COUNCIL_SPECIALIST_ROLES
} from "./financial-council-specialists.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function verifiedFacts() {
  const types = [
    "bad_debt_written_off", "cogs_recognized", "contract_won",
    "payment_received", "refund", "revenue_recognized"
  ] as const;
  return types.map((factType, index) => Object.freeze({
    entryId: `fact-${index + 1}`,
    sourceVersion: 1,
    factType,
    currency: "CNY",
    businessOccurredAt: "2026-08-14T08:00:00.000Z",
    entryRecordedAt: "2026-08-14T08:01:00.000Z",
    verificationRevision: 1,
    verificationRecordedAt: "2026-08-14T08:02:00.000Z",
    snapshotHash: HASH,
    amountVisibility: "redacted" as const
  }));
}

function completeReport(): BusinessReportInput {
  return {
    currency: "CNY",
    companyName: "Specialist Co",
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
        name: "Current Customer", revenueMinor: 500_000,
        grossProfitMinor: 150_000, serviceCostMinor: 20_000,
        paymentDays: 10, outstandingReceivableMinor: 50_000
      }, {
        name: "Customer A", revenueMinor: 1_000_000,
        grossProfitMinor: 250_000, serviceCostMinor: 50_000,
        paymentDays: 120, outstandingReceivableMinor: 1_000_000
      }]
    },
    cashFlow: {
      period: "2026-08", openingCashMinor: 600_000,
      operatingInflowMinor: 4_500_000, operatingOutflowMinor: 3_900_000,
      investingNetMinor: 0, financingNetMinor: -400_000,
      receivables: [{
        customer: "Current Customer", amountMinor: 50_000,
        daysOutstanding: 10
      }, {
        customer: "Customer A", amountMinor: 1_000_000,
        daysOutstanding: 120
      }],
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

function policies() {
  return {
    formulaPolicy: {
      formulaPolicyVersion: "financial-council-formula-policy.v1" as const,
      minimumProductMarginBps: 1_000,
      minimumCashReserveMinor: 900_000
    },
    actionPolicy: {
      actionCoefficientVersion: "financial-council-actions.v1" as const,
      costRealizationBps: {
        conservative: 2_500, base: 5_000, optimistic: 7_500
      },
      dataRiskReductionBps: {
        conservative: 500, base: 1_000, optimistic: 1_500
      },
      taxRiskReductionBps: {
        conservative: 1_000, base: 2_000, optimistic: 3_000
      }
    }
  };
}

class RecordingModel implements FinancialCouncilModelPort {
  readonly calls: FinancialCouncilAnalyzeInput[] = [];

  async analyze(input: FinancialCouncilAnalyzeInput) {
    this.calls.push(structuredClone(input));
    const findingId = input.allowlist.findingIds[0]!;
    const formula = (input.businessData as {
      formulas: Array<{ refId: string; evidenceRefIds: string[] }>;
    }).formulas[0];
    return this.result(input, {
      findingDrafts: [{
        findingId,
        conclusion: input.role === "tax"
          ? "税务风险需专业人员复核"
          : "risk_hypothesis",
        evidenceRefs: [formula?.evidenceRefIds[0]
          ?? input.allowlist.evidenceRefIds[0]!],
        formulaRef: formula?.refId ?? null,
        confidenceBps: 8_000,
        severity: "warning" as const,
        assumptions: [],
        missingDataRefs: []
      }],
      actionHypotheses: []
    });
  }

  async rebut(): Promise<never> {
    throw new Error("unexpected rebuttal");
  }

  private result<Value>(
    input: FinancialCouncilAnalyzeInput,
    value: Value
  ): FinancialCouncilModelResult<Value> {
    const content = buildFinancialCouncilModelContent("analyze", input);
    return {
      value,
      binding: {
        jobId: `financial-council:${input.runId}:${input.role}:analyze:1`,
        runId: input.runId,
        snapshotId: input.snapshotId,
        snapshotHash: input.snapshotHash,
        role: input.role,
        phase: "analyze",
        attempt: 1,
        connectionId: "connection-1",
        credentialVersion: 1,
        provider: "openai",
        model: "gpt-test",
        capabilitySnapshotHash: HASH,
        baseUrlFingerprint: "official-endpoint",
        promptVersion: content.promptVersion,
        schemaVersion: content.schemaVersion,
        contentHash: content.contentHash,
        promptHash: content.promptHash,
        schemaHash: content.schemaHash
      },
      repaired: false,
      providerRequestId: null
    };
  }
}

async function setup() {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture({
    businessReport: completeReport(),
    policyVersionId: "specialist-policy-v1"
  });
  const snapshot = await builderSnapshotFixture(aggregate, verifiedFacts());
  const run = (await repository.createAndFreezeRun(command("specialists"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  return { repository, run, snapshot };
}

test("all five specialists receive one verified snapshot without peer prose", async () => {
  const { repository, run, snapshot } = await setup();
  const model = new RecordingModel();
  const council = new FinancialCouncilSpecialistCoordinator({
    repository,
    model,
    resolvePolicy: async (policyVersionId) => {
      assert.equal(policyVersionId, "specialist-policy-v1");
      return policies();
    },
    now: () => "2026-08-16T09:00:00.000Z"
  });

  const results = await council.runSpecialists(workspace(), run.runId);

  assert.deepEqual(model.calls.map((call) => call.role),
    FINANCIAL_COUNCIL_SPECIALIST_ROLES);
  assert.equal(model.calls.length, 5);
  assert.equal(model.calls.every((call) =>
    call.runId === run.runId
      && call.snapshotId === snapshot.snapshotId
      && call.snapshotHash === snapshot.snapshotHash), true);
  assert.equal(model.calls.every((call) =>
    !JSON.stringify(call.businessData).includes("peerFindings")), true);
  assert.deepEqual(results.map((result) => result.role),
    FINANCIAL_COUNCIL_SPECIALIST_ROLES);
  assert.equal(results.every((result) =>
    result.snapshotHash === snapshot.snapshotHash), true);
});

test("role projections expose only their formula and action manifests", async () => {
  const { repository, run } = await setup();
  const model = new RecordingModel();
  const council = new FinancialCouncilSpecialistCoordinator({
    repository, model,
    resolvePolicy: async () => policies(),
    now: () => "2026-08-16T09:00:00.000Z"
  });

  await council.runSpecialists(workspace(), run.runId);

  const manifests = Object.fromEntries(model.calls.map((call) => {
    const data = call.businessData as {
      manifest: { formulaIds: string[]; actionKinds: string[] }
    };
    return [call.role, data.manifest];
  }));
  assert.deepEqual(manifests, {
    finance: {
      formulaIds: ["financial_data_gaps", "financial_indicators"],
      actionKinds: ["complete_financial_data"]
    },
    profit: {
      formulaIds: ["customer_true_profit", "loss_product_pricing_gap",
        "product_true_profit"],
      actionKinds: ["review_loss_product_pricing"]
    },
    cost: {
      formulaIds: ["cost_analysis", "verified_avoidable_cost"],
      actionKinds: ["reduce_cost_anomaly"]
    },
    cashflow: {
      formulaIds: ["cash_shortfall", "cashflow_forecast",
        "eligible_overdue_receivable"],
      actionKinds: ["collect_receivable", "prepare_cash_reserve_budget"]
    },
    tax: {
      formulaIds: ["tax_risk"],
      actionKinds: ["schedule_tax_review"]
    }
  });
  const cashflow = model.calls.find((call) => call.role === "cashflow")!;
  const cashSlice = (cashflow.businessData as {
    slice: { receivableSubjects: string[] }
  }).slice;
  assert.deepEqual(cashSlice.receivableSubjects, cashflow.allowlist.subjectRefs);
  assert.deepEqual(cashSlice.receivableSubjects, ["Customer A"]);
  const factTypes = (role: string) => {
    const call = model.calls.find((candidate) => candidate.role === role)!;
    const slice = (call.businessData as {
      slice: { verifiedFinancialFacts?: Array<{ factType: string }> }
    }).slice;
    return slice.verifiedFinancialFacts?.map((fact) => fact.factType);
  };
  assert.deepEqual(factTypes("finance"), [
    "bad_debt_written_off", "cogs_recognized", "contract_won",
    "payment_received", "refund", "revenue_recognized"
  ]);
  assert.deepEqual(factTypes("cost"), ["cogs_recognized"]);
  assert.deepEqual(factTypes("cashflow"), [
    "bad_debt_written_off", "payment_received", "refund"
  ]);
  assert.equal(factTypes("profit"), undefined);
  assert.equal(factTypes("tax"), undefined);
  const factEvidenceIds = (role: string) => {
    const call = model.calls.find((candidate) => candidate.role === role)!;
    return (call.businessData as {
      evidence: Array<{ source: string; sourceId: string }>;
    }).evidence.filter((ref) => ref.source === "financial_fact")
      .map((ref) => ref.sourceId);
  };
  assert.deepEqual(factEvidenceIds("finance"), [
    "fact-1", "fact-2", "fact-3", "fact-4", "fact-5", "fact-6"
  ]);
  assert.deepEqual(factEvidenceIds("cost"), ["fact-2"]);
  assert.deepEqual(factEvidenceIds("cashflow"), [
    "fact-1", "fact-4", "fact-5"
  ]);
  assert.deepEqual(factEvidenceIds("tax"), []);
});

test("specialist coordinator rejects a model binding with changed content identity", async () => {
  const { repository, run } = await setup();
  const recorded = new RecordingModel();
  const model: FinancialCouncilModelPort = {
    async analyze(input) {
      const result = await recorded.analyze(input);
      return {
        ...result,
        binding: {
          ...result.binding,
          contentHash: `sha256:${"f".repeat(64)}`
        }
      };
    },
    async rebut(input) { return recorded.rebut(input); }
  };
  const council = new FinancialCouncilSpecialistCoordinator({
    repository, model,
    resolvePolicy: async () => policies(),
    now: () => "2026-08-16T09:00:00.000Z"
  });

  await assert.rejects(
    council.runSpecialists(workspace(), run.runId),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_specialist_binding_invalid"
  );
  assert.deepEqual(await repository.listSpecialistResults(
    workspace(), run.runId
  ), []);
});

test("recovery replays five durable results without another model call", async () => {
  const { repository, run } = await setup();
  const model = new RecordingModel();
  let policyReads = 0;
  const council = new FinancialCouncilSpecialistCoordinator({
    repository, model,
    resolvePolicy: async () => {
      policyReads += 1;
      return policies();
    },
    now: () => "2026-08-16T09:00:00.000Z"
  });
  const first = await council.runSpecialists(workspace(), run.runId);

  const replay = await council.runSpecialists(workspace(), run.runId);

  assert.deepEqual(replay, first);
  assert.equal(model.calls.length, 5);
  assert.equal(policyReads, 2);
});

test("recovery rejects a fully rehashed persisted result with foreign evidence", async () => {
  const { repository, run } = await setup();
  const model = new RecordingModel();
  const council = new FinancialCouncilSpecialistCoordinator({
    repository, model,
    resolvePolicy: async () => policies(),
    now: () => "2026-08-16T09:00:00.000Z"
  });
  await council.runSpecialists(workspace(), run.runId);

  const state = (repository as unknown as {
    state: {
      specialistResults: Map<string, Record<string, unknown>>;
      specialistFindings: Map<string, {
        role: string;
        phase: string;
        value: Record<string, unknown>;
      }>;
    };
  }).state;
  const [resultKey, stored] = [...state.specialistResults]
    .find(([, candidate]) => candidate.role === "finance")!;
  const finding = structuredClone(
    (stored.findings as Array<Record<string, unknown>>)[0]!
  );
  finding.evidenceRefs = [{
    ...(finding.evidenceRefs as Array<Record<string, unknown>>)[0]!,
    sourceId: "foreign-business-report"
  }];
  const { resultHash: _oldHash, ...preimage } = {
    ...structuredClone(stored), findings: [finding]
  };
  state.specialistResults.set(resultKey, Object.freeze({
    ...preimage,
    resultHash: financialCouncilCanonicalHash(preimage)
  }));
  const [findingKey, storedFinding] = [...state.specialistFindings]
    .find(([, candidate]) => candidate.role === "finance")!;
  state.specialistFindings.set(findingKey, Object.freeze({
    ...storedFinding, value: Object.freeze(finding)
  }));

  await assert.rejects(
    council.runSpecialists(workspace(), run.runId),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_finding_invalid"
  );
  assert.equal(model.calls.length, 5);
});

test("a fifth-role failure cannot hide the durable cash hard-constraint slice", async () => {
  const { repository, run } = await setup();
  const recorded = new RecordingModel();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model: FinancialCouncilModelPort = {
    async analyze(input) {
      if (input.role === "tax") {
        recorded.calls.push(structuredClone(input));
        throw new Error("tax unavailable");
      }
      await gate;
      return recorded.analyze(input);
    },
    async rebut(input) { return recorded.rebut(input); }
  };
  const council = new FinancialCouncilSpecialistCoordinator({
    repository, model,
    resolvePolicy: async () => policies(),
    now: () => "2026-08-16T09:00:00.000Z"
  });

  const execution = council.runSpecialists(workspace(), run.runId);
  let failure: unknown;
  const outcome = execution.then(() => "resolved" as const, (error) => {
    failure = error;
    return "rejected" as const;
  });
  const early = await Promise.race([
    outcome,
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))
  ]);
  release();
  assert.equal(await outcome, "rejected");

  assert.equal(early, "pending");
  assert.match(String((failure as Error).message), /tax unavailable/u);

  const cashCall = recorded.calls.find((call) => call.role === "cashflow")!;
  const data = cashCall.businessData as {
    manifest: { formulaIds: string[] }
  };
  assert.equal(data.manifest.formulaIds.includes("cash_shortfall"), true);
  assert.equal((await repository.getSpecialistResult(
    workspace(), run.runId, "cashflow", "analyze"
  ))?.role, "cashflow");
  assert.equal((await repository.listSpecialistResults(
    workspace(), run.runId
  )).length, 4);
});
