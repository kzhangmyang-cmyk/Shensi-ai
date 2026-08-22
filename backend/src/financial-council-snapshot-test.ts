import assert from "node:assert/strict";
import test from "node:test";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import {
  FinancialCouncilAuthorityReader,
  type FinancialCouncilVerifiedFactSource
} from "./financial-council-authority-reader.js";
import {
  FinancialSnapshotBuilder,
  validateFinancialSnapshot
} from "./financial-council-snapshot.js";
import {
  createGrowthAdvisorQueryService
} from "./growth-advisor-query.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";
import type { FinancialCouncilCreateInput } from "./growth-contract-types.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import { QuoteApprovalAsOfReader } from "./authoritative-quote-reader.js";

const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;
const RUN_ID = "council-run-1";

function workspace(
  capabilities: ActiveWorkspaceContext["capabilities"] = [
    "pricing.sensitive.read"
  ]
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "workspace-a",
    kind: "team",
    actorId: "admin-1",
    role: "admin",
    teamId: "all",
    capabilities: Object.freeze([...capabilities]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function command(context = workspace()): CommandContext {
  return Object.freeze({
    workspace: context,
    actorId: context.actorId,
    idempotencyKey: "financial-council-1",
    requestHash: HASH("a"),
    expectedRevision: null
  });
}

function businessReport(): BusinessReportInput {
  return {
    currency: "CNY",
    companyName: "Example Co",
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
      productLines: [
        {
          name: "B",
          revenueMinor: 2_000_000,
          costOfGoodsSoldMinor: 1_000_000,
          afterSalesCostMinor: 100_000,
          shippingCostMinor: 100_000,
          sellingExpenseMinor: 100_000,
          allocatedOverheadMinor: 100_000
        },
        {
          name: "A",
          revenueMinor: 1_000_000,
          costOfGoodsSoldMinor: 500_000,
          afterSalesCostMinor: 50_000,
          shippingCostMinor: 50_000,
          sellingExpenseMinor: 50_000,
          allocatedOverheadMinor: 50_000
        }
      ]
    },
    cashFlow: {
      period: "2026-08",
      openingCashMinor: 600_000,
      operatingInflowMinor: 4_500_000,
      operatingOutflowMinor: 3_900_000,
      investingNetMinor: 0,
      financingNetMinor: 200_000,
      receivables: [
        { customer: "B", amountMinor: 200_000, daysOutstanding: 20 },
        { customer: "A", amountMinor: 100_000, daysOutstanding: 10 }
      ],
      expectedInflowsNext30DaysMinor: 1_000_000,
      expectedOutflowsNext30DaysMinor: 1_300_000,
      expectedInflowsNext31To90DaysMinor: 2_000_000,
      expectedOutflowsNext31To90DaysMinor: 1_800_000
    }
  };
}

function input(report = businessReport()): FinancialCouncilCreateInput {
  return {
    currency: "CNY",
    dataAsOf: "2026-08-16T08:00:00.000Z",
    businessReport: report,
    policyVersionId: "policy-1"
  };
}

class CountingBarrier extends DefaultGrowthTemporalBarrier {
  sealCalls = 0;

  override async sealReadCutoff(
    context: ActiveWorkspaceContext,
    effectiveAsOf: string
  ) {
    this.sealCalls += 1;
    return super.sealReadCutoff(context, effectiveAsOf);
  }
}

function fact(): FinancialCouncilVerifiedFactSource {
  return {
    workspaceId: "workspace-a",
    entryId: "fact-1",
    sourceVersion: 1,
    factType: "payment_received",
    amountMinor: 500_000,
    netAmountMinor: 500_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-15T06:00:00.000Z",
    entryRecordedAt: "2026-08-15T07:00:00.000Z",
    verificationRevision: 2,
    verificationRecordedAt: "2026-08-15T08:00:00.000Z",
    snapshotHash: HASH("f")
  };
}

function currencyLimitedQuoteReader(): QuoteApprovalAsOfReader {
  const approvals = Array.from({ length: 101 }, (_, index) => ({
    id: index === 100 ? "approval-target" : `approval-foreign-${index}`,
    workspaceId: "workspace-a",
    quoteVersionId: index === 100 ? "quote-target" : `quote-foreign-${index}`,
    status: "pending" as const,
    approvalKind: "confirmation" as const,
    requiredCapabilities: ["quote.confirm"],
    triggeredRules: ["manager_confirmation"],
    pricingPolicyVersionId: "policy-1",
    policySnapshotHash: HASH("a"),
    capabilityRegistryVersion: "growth-capabilities.v1",
    submittedBy: "sales-1",
    submittedAt: `2026-08-15T07:00:00.${String(index).padStart(3, "0")}Z`,
    decidedBy: null,
    decidedAt: null,
    reason: null
  }));
  const versions = new Map(approvals.map((approval, index) => [
    approval.quoteVersionId,
    {
      id: approval.quoteVersionId,
      workspaceId: "workspace-a",
      quoteCaseId: `quote-case-${index}`,
      version: 1,
      lifecycleRevision: 4,
      versionKind: "formal" as const,
      sourceDraftVersionId: `draft-${index}`,
      probabilityAssessmentSnapshot: {
        id: `probability-${index}`,
        precision: "bps",
        closeProbabilityBps: 5_000
      },
      status: "submitted" as const,
      createdBy: "sales-1",
      createdAt: approval.submittedAt,
      effectiveAt: approval.submittedAt,
      recordedAt: approval.submittedAt,
      temporalSequence: index + 1,
      salesOwnerActorId: "sales-1",
      currency: index === 100 ? "CNY" : "USD",
      quotedAmountMinor: 1_000_000,
      estimatedGrossProfitMinor: 200_000,
      estimatedContributionMinor: 180_000,
      grossMarginBps: 2_000,
      commercialAmountHash: HASH("2"),
      expiresAt: null
    }
  ]));
  return new QuoteApprovalAsOfReader({
    async listApprovals() { return approvals; },
    async listApprovalEvents() { return []; },
    async listLifecycleEvents() { return []; },
    async getVersion(_workspaceId: string, versionId: string) {
      return versions.get(versionId) ?? null;
    }
  } as never);
}

function createHarness(options: {
  reverse?: boolean;
  incompleteRoi?: boolean;
  mixedApprovalCurrencies?: boolean;
  priorityCount?: number;
  approvalCount?: number;
  quoteApprovals?: Pick<QuoteApprovalAsOfReader, "listPendingAsOf">;
} = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-16T08:00:00.000Z"
  );
  const barrier = new CountingBarrier(transactions);
  const seen: GrowthSealedReadCutoff[] = [];
  const note = (cutoff: GrowthSealedReadCutoff) => {
    seen.push(cutoff);
    return cutoff;
  };
  const defaultCandidates = [
    {
      candidateId: "candidate-b", customerId: "customer-b", dealId: "deal-b",
      displayName: "B", priorityScoreBps: 8_000,
      qualificationDecisionId: "qualification-b",
      qualificationDecisionVersion: "v2", inputSnapshotHash: HASH("b")
    },
    {
      candidateId: "candidate-a", customerId: "customer-a", dealId: "deal-a",
      displayName: "A", priorityScoreBps: 9_000,
      qualificationDecisionId: "qualification-a",
      qualificationDecisionVersion: "v1", inputSnapshotHash: HASH("a")
    }
  ];
  const candidates = options.priorityCount === undefined
    ? defaultCandidates
    : Array.from({ length: options.priorityCount }, (_, index) => ({
        candidateId: `candidate-${String(index).padStart(3, "0")}`,
        customerId: `customer-${String(index).padStart(3, "0")}`,
        dealId: `deal-${String(index).padStart(3, "0")}`,
        displayName: `Candidate ${String(index).padStart(3, "0")}`,
        priorityScoreBps: 9_000,
        qualificationDecisionId:
          `qualification-${String(index).padStart(3, "0")}`,
        qualificationDecisionVersion: "v1",
        inputSnapshotHash: HASH("b")
      }));
  if (options.reverse) candidates.reverse();
  const approval = {
    quoteCaseId: "quote-case-1", quoteVersionId: "quote-1",
    approvalId: "approval-1", approvalKind: "confirmation" as const,
    requiredCapabilities: ["quote.confirm"], lifecycleRevision: 4,
    currency: "CNY", quotedAmountMinor: 1_000_000,
    estimatedGrossProfitMinor: 200_000,
    estimatedContributionMinor: 180_000, grossMarginBps: 2_000,
    probabilityAssessmentId: "probability-1", closeProbabilityBps: 5_000,
    commercialAmountHash: HASH("2"), salesOwnerActorId: "sales-1",
    submittedBy: "sales-1", submittedAt: "2026-08-15T07:00:00.000Z",
    expiresAt: null
  };
  const approvals = options.approvalCount === undefined
    ? options.mixedApprovalCurrencies ? [approval, {
        ...approval,
        quoteCaseId: "quote-case-usd",
        quoteVersionId: "quote-usd",
        approvalId: "approval-usd",
        currency: "USD"
      }] : [approval]
    : Array.from({ length: options.approvalCount }, (_, index) => ({
        ...approval,
        quoteCaseId: `quote-case-${String(index).padStart(3, "0")}`,
        quoteVersionId: `quote-${String(index).padStart(3, "0")}`,
        approvalId: `approval-${String(index).padStart(3, "0")}`
      }));
  if (options.reverse) approvals.reverse();
  const advisor = createGrowthAdvisorQueryService({
    temporalBarrier: barrier,
    workspaceSettings: {
      async getAt(_context, cutoff) {
        note(cutoff);
        return {
          timeZone: "Asia/Shanghai", revision: "settings-v1",
          recordedAt: "1970-01-01T00:00:00.000Z", eventSequence: 1
        };
      }
    } as never,
    visibility: {
      async resolveAt(_context, cutoff) {
        note(cutoff);
        return {
          scope: { kind: "workspace", workspaceId: "workspace-a" },
          subjectVisibility: {
            candidateIds: candidates.map((row) => row.candidateId),
            customerIds: candidates.map((row) => row.customerId),
            dealIds: candidates.map((row) => row.dealId), cohortIds: ["cohort-1"]
          },
          financialGapVisibility: {
            candidateIds: candidates.map((row) => row.candidateId),
            customerIds: candidates.map((row) => row.customerId),
            dealIds: candidates.map((row) => row.dealId), cohortIds: ["cohort-1"]
          },
          sourceSnapshotHash: HASH("1")
        };
      }
    } as never,
    priorityCandidates: {
      async listAsOf(_context, value) {
        note(value.cutoff);
        return candidates.slice(0, value.limit);
      }
    },
    quoteApprovals: options.quoteApprovals ?? {
      async listPendingAsOf(_context, value) {
        note(value.cutoff);
        return approvals.slice(0, value.limit);
      }
    },
    quoteVersions: {
      async getAt(_context, quoteVersionId, cutoff) {
        note(cutoff);
        return { quoteVersionId, lifecycleRevision: 4 } as never;
      }
    },
    performancePortfolio: {
      async listVisible(_context, value) {
        note(value.cutoff);
        return [{
          cohortId: "cohort-1",
          planId: null,
          performance: {
            cohortId: "cohort-1", currency: "CNY", planId: null,
            dataAsOf: value.cutoff.effectiveAsOf, memberIds: [],
            expectedRoiByCurrency: options.incompleteRoi ? [{
              currency: "CNY", status: "not_computable", reason: "cost_missing",
              roiBps: null, formulaVersion: "expected-gross-profit-roi.v1",
              quoteVersionIds: ["quote-1"], probabilityAssessmentIds: ["probability-1"],
              costEstimateIds: [], amountVisibility: "full",
              probabilityWeightedGrossProfitMinor: null,
              attributedEstimatedCostMinor: null
            }] : [{
              currency: "CNY", status: "computed", reason: null, roiBps: 4_000,
              formulaVersion: "expected-gross-profit-roi.v1",
              quoteVersionIds: ["quote-1"], probabilityAssessmentIds: ["probability-1"],
              costEstimateIds: ["cost-1"], amountVisibility: "full",
              probabilityWeightedGrossProfitMinor: 700_000,
              attributedEstimatedCostMinor: 500_000
            }],
            actualRoiByCurrency: options.incompleteRoi ? [{
              currency: "CNY", status: "not_computable",
              reason: "cash_reconciliation_incomplete",
              closureVersionId: "closure-1",
              closureAsOf: "2026-08-15T08:00:00.000Z",
              formulaVersion: "verified-gross-profit-roi.v1"
            }] : [{
              currency: "CNY", status: "computed", basis: "verified_gross_profit",
              roiBps: 3_000, costCoverageBps: 10_000, marginCoverageBps: 10_000,
              cashCoverageBps: 10_000, attributionCoverageBps: 10_000,
              closureVersionId: "closure-1", closureAsOf: "2026-08-15T08:00:00.000Z",
              formulaVersion: "verified-gross-profit-roi.v1",
              amountVisibility: "full", verifiedGrossProfitMinor: 650_000,
              verifiedAcquisitionCostMinor: 500_000
            }],
            cashByCurrency: [],
            coverage: {
              costCoverageBps: 10_000, marginCoverageBps: 10_000,
              cashCoverageBps: options.incompleteRoi ? 0 : 10_000,
              attributionCoverageBps: 10_000,
              gapCodes: options.incompleteRoi ? ["cash_incomplete"] : []
            },
            dataGaps: options.incompleteRoi ? ["cash_incomplete"] : [],
            closureVersionId: "closure-1", formulaVersion: "growth-performance.v1",
            calculationHash: HASH("3"), membershipSnapshotHash: HASH("4")
          }
        }];
      }
    },
    financialGaps: {
      async listForBindingsAt(_context, value) {
        note(value.cutoff);
        return [];
      }
    },
    recommendations: {
      async listAt(_context, value) {
        note(value.cutoff);
        return { items: [], nextCursor: null, hasMore: false };
      }
    },
    now: () => "2026-08-16T09:00:00.000Z"
  });
  const authority = new FinancialCouncilAuthorityReader({
    advisor,
    verifiedFacts: {
      async listVisibleAt(_context, value) {
        note(value.cutoff);
        return [fact()];
      }
    }
  });
  const builder = new FinancialSnapshotBuilder({
    cutoffIssuer: advisor,
    authority,
    businessAdvisor: createBusinessAdvisorService(),
    now: () => "2026-08-16T09:00:00.000Z"
  });
  return { advisor, authority, barrier, seen, builder };
}

test("snapshot seals once and every reader receives the same cutoff", async () => {
  const harness = createHarness();
  const snapshot = await harness.builder.freeze(command(), RUN_ID, input());
  assert.equal(harness.barrier.sealCalls, 1);
  assert.equal(harness.seen.length > 2, true);
  assert.equal(new Set(harness.seen).size, 1);
  assert.equal(snapshot.dataAsOf, "2026-08-16T08:00:00.000Z");
  assert.equal(snapshot.runId, RUN_ID);
  assert.match(snapshot.snapshotId, /^sha256:[0-9a-f]{64}$/u);
  assert.match(snapshot.reportInputHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(snapshot.snapshotHash, /^sha256:[0-9a-f]{64}$/u);
  const { snapshotHash: _snapshotHash, ...preimage } = snapshot;
  assert.equal(snapshot.snapshotHash, financialCouncilCanonicalHash(preimage));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.authority.expectedRoi), true);
  assert.equal(Object.isFrozen(snapshot.formulaInputs.indicators), true);
  assert.deepEqual(snapshot.sourceRefs.map((ref) => [ref.kind, ref.sourceId]),
    [...snapshot.sourceRefs]
      .sort((left, right) => left.kind.localeCompare(right.kind)
        || left.sourceId.localeCompare(right.sourceId))
      .map((ref) => [ref.kind, ref.sourceId]));
});

test("persisted snapshot rejects re-signed impossible provenance", async () => {
  const snapshot = await createHarness().builder.freeze(
    command(), RUN_ID, input()
  );
  const resign = (changed: Record<string, unknown>) => {
    const { snapshotHash: _ignored, ...preimage } = changed;
    return { ...preimage, snapshotHash: financialCouncilCanonicalHash(preimage) };
  };
  const invalid = [
    resign({ ...snapshot, reportInputHash: "not-a-hash" }),
    resign({
      ...snapshot,
      dataGaps: [{
        code: "unknown_gap", source: "prompt", sourceId: "x",
        description: "forged"
      }]
    }),
    resign({
      ...snapshot,
      sourceRefs: snapshot.sourceRefs.map((ref, index) => index === 0
        ? { ...ref, kind: "prompt", contentHash: "not-a-hash" }
        : ref)
    }),
    resign({
      ...snapshot,
      sourceRefs: [snapshot.sourceRefs[0], snapshot.sourceRefs[0],
        ...snapshot.sourceRefs.slice(1)]
    }),
    resign({ ...snapshot, sourceRefs: [...snapshot.sourceRefs].reverse() })
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => validateFinancialSnapshot(candidate),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_council_input_invalid"
    );
  }
});

test("future dataAsOf is rejected before sealing or reading", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.builder.freeze(command(), RUN_ID, {
      ...input(), dataAsOf: "2026-08-16T12:00:00.000Z"
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "invalid_as_of"
  );
  assert.equal(harness.barrier.sealCalls, 0);
  assert.equal(harness.seen.length, 0);
});

test("missing cash flow and incomplete ROI become closed gaps", async () => {
  const harness = createHarness({ incompleteRoi: true });
  const report = businessReport();
  delete report.cashFlow;
  const snapshot = await harness.builder.freeze(command(), RUN_ID, input(report));
  assert.deepEqual(snapshot.dataGaps.map((gap) => [gap.source, gap.code]), [
    ["business_report", "import_requires_review"],
    ["roi", "import_requires_review"],
    ["roi", "import_requires_review"]
  ]);
  assert.equal(snapshot.dataGaps.every((gap) => Object.isFrozen(gap)), true);
});

test("missing optional report sections never become zero-valued formula facts", async () => {
  const harness = createHarness({ incompleteRoi: true });
  const report = businessReport();
  delete report.cashFlow;
  delete report.costDetail;
  delete report.taxRisk;

  const snapshot = await harness.builder.freeze(command(), RUN_ID, input(report));

  assert.deepEqual(snapshot.formulaInputs.cashflow, {
    status: "not_computable",
    reason: "cash_flow_missing"
  });
  assert.equal("next30DaysNetMinor" in snapshot.formulaInputs.cashflow, false);
  assert.equal("projectedClosingCash90DaysMinor" in snapshot.formulaInputs.cashflow, false);
  assert.deepEqual(snapshot.formulaInputs.cost, {
    status: "not_computable",
    reason: "cost_detail_missing"
  });
  assert.equal("materialCostRateBps" in snapshot.formulaInputs.cost, false);
  assert.deepEqual(snapshot.formulaInputs.tax, {
    status: "not_computable",
    reason: "tax_risk_missing"
  });
  assert.equal("redCount" in snapshot.formulaInputs.tax, false);
  assert.equal(Object.isFrozen(snapshot.formulaInputs.cashflow), true);
});

test("snapshot identity ignores caller and authority array order", async () => {
  const leftHarness = createHarness();
  const rightHarness = createHarness({ reverse: true });
  const leftReport = businessReport();
  const rightReport = structuredClone(leftReport);
  rightReport.incomeStatement.productLines!.reverse();
  rightReport.cashFlow!.receivables!.reverse();
  const left = await leftHarness.builder.freeze(
    command(), RUN_ID, input(leftReport)
  );
  const right = await rightHarness.builder.freeze(
    command(), RUN_ID, input(rightReport)
  );
  assert.equal(left.reportInputHash, right.reportInputHash);
  assert.equal(left.snapshotId, right.snapshotId);
  assert.equal(left.snapshotHash, right.snapshotHash);
  assert.deepEqual(left, right);
});

test("non-JSON report input fails closed instead of entering a canonical hash", async () => {
  const harness = createHarness();
  const report = businessReport();
  report.balanceSheet.cashMinor = Number.NaN;
  await assert.rejects(
    harness.builder.freeze(command(), RUN_ID, input(report)),
    (error: unknown) =>
      (error as { code?: string }).code === "financial_council_input_invalid"
  );
  assert.equal(harness.barrier.sealCalls, 0);
});

test("snapshot rejects duplicate source identities instead of silently deduplicating", async () => {
  const harness = createHarness();
  const builder = new FinancialSnapshotBuilder({
    cutoffIssuer: harness.advisor,
    authority: {
      async readAt(context, value) {
        const authority = await harness.authority.readAt(context, value);
        return {
          ...authority,
          priorityCustomers: [
            ...authority.priorityCustomers,
            authority.priorityCustomers[0]!
          ]
        };
      }
    },
    businessAdvisor: createBusinessAdvisorService(),
    now: () => "2026-08-16T09:00:00.000Z"
  });

  await assert.rejects(
    builder.freeze(command(), RUN_ID, input()),
    /financial_council_authority_invalid/u
  );
});

test("non-sensitive authority filters mixed-currency approvals inside production query", async () => {
  const harness = createHarness({ mixedApprovalCurrencies: true });

  const snapshot = await harness.builder.freeze(
    command(workspace([])), RUN_ID, input()
  );

  assert.deepEqual(
    snapshot.authority.pendingQuoteApprovals.map((row) => row.quoteVersionId),
    ["quote-1"]
  );
  assert.equal(snapshot.authority.pendingQuoteApprovals[0]?.currency, undefined);
});

test("snapshot authority retains a target quote behind one hundred foreign currencies", async () => {
  const harness = createHarness({ quoteApprovals: currencyLimitedQuoteReader() });
  const snapshot = await harness.builder.freeze(
    command(), RUN_ID, input()
  );
  assert.deepEqual(
    snapshot.authority.pendingQuoteApprovals.map((row) => row.quoteVersionId),
    ["quote-target"]
  );
});

test("internal authority keeps 11 priorities and 51 approvals while public Today stays 10 and 50", async () => {
  const forward = createHarness({ priorityCount: 11, approvalCount: 51 });
  const publicView = await forward.advisor.getToday(workspace([]), {
    currency: "CNY", asOf: "2026-08-16T08:00:00.000Z"
  });
  assert.equal(publicView.priorityCustomers.length, 10);
  assert.equal(publicView.pendingQuoteApprovals.length, 50);
  assert.equal(publicView.priorityCustomers[0]?.candidateId, "candidate-000");
  assert.equal(publicView.priorityCustomers.at(-1)?.candidateId, "candidate-009");
  assert.equal(publicView.pendingQuoteApprovals[0]?.quoteVersionId, "quote-000");
  assert.equal(publicView.pendingQuoteApprovals.at(-1)?.quoteVersionId, "quote-049");
  assert.equal(publicView.pendingQuoteApprovals[0]?.currency, undefined);

  const snapshot = await forward.builder.freeze(
    command(workspace([])), RUN_ID, input()
  );
  assert.equal(snapshot.authority.priorityCustomers.length, 11);
  assert.equal(snapshot.authority.pendingQuoteApprovals.length, 51);

  const reverse = await createHarness({
    priorityCount: 11, approvalCount: 51, reverse: true
  }).builder.freeze(command(workspace([])), RUN_ID, input());
  assert.deepEqual(snapshot.authority.priorityCustomers,
    reverse.authority.priorityCustomers);
  assert.deepEqual(snapshot.authority.pendingQuoteApprovals,
    reverse.authority.pendingQuoteApprovals);
  assert.equal(snapshot.authority.sourceSnapshotHash,
    reverse.authority.sourceSnapshotHash);
  assert.equal(snapshot.snapshotHash, reverse.snapshotHash);
});

test("internal authority fails closed when priority or approval probes reach 100", async () => {
  for (const count of [100, 101]) {
    await assert.rejects(
      createHarness({ priorityCount: count }).builder.freeze(
        command(), RUN_ID, input()
      ),
      /financial_council_authority_query_truncated/u
    );
    await assert.rejects(
      createHarness({ approvalCount: count }).builder.freeze(
        command(), RUN_ID, input()
      ),
      /financial_council_authority_query_truncated/u
    );
  }
});

test("snapshot identity is bound to the target run and rejects invalid run IDs", async () => {
  const left = await createHarness().builder.freeze(
    command(), "council-run-left", input()
  );
  const right = await createHarness().builder.freeze(
    command(), "council-run-right", input()
  );
  assert.notEqual(left.snapshotId, right.snapshotId);
  assert.notEqual(left.snapshotHash, right.snapshotHash);
  await assert.rejects(
    createHarness().builder.freeze(command(), "", input()),
    /financial_council_input_invalid/u
  );
});
