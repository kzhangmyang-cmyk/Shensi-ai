import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrowthAdvisorQueryService,
  DefaultAdvisorVisibilityResolver,
  DefaultPriorityCandidateReader,
  type AdvisorCandidateEvidenceAsOfReader,
  type AdvisorPerformancePortfolioReader,
  type AdvisorVisibilityResolver,
  type GrowthAdvisorSealedQueryService,
  type GrowthAdvisorTodayView,
  type PendingQuoteApprovalView,
  type PriorityCandidateReader,
  type PriorityCustomerView
} from "./growth-advisor-query.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthWorkspaceSettings } from "./growth-workspace-settings.js";
import type {
  FinancialDataGap,
  FinancialDataGapVisibilityKeys
} from "./financial-data-gap-reader.js";
import type { GrowthPerformanceDto } from "./acquisition-growth-performance-query.js";
import type { AdvisorRecommendation } from "./advisor-recommendation-domain.js";
import {
  qualificationAuthorityEventFixture
} from "./growth-advisor-candidate-authority-projection-test.js";
import {
  InMemoryAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import type {
  CohortBindingVisibilityRow,
  QuoteBindingVisibilityRow
} from "./growth-advisor-query.js";

const WS_1 = "ws-1";
const WS_2 = "ws-2";

export function advisorContext(
  workspaceId: string,
  capabilities: readonly string[] = [],
  overrides: Partial<ActiveWorkspaceContext> = {}
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: overrides.actorId ?? "manager-1",
    role: overrides.role ?? "manager",
    teamId: overrides.teamId ?? workspaceId,
    capabilities: Object.freeze([...capabilities]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function financialGap(
  overrides: Partial<FinancialDataGap> = {}
): FinancialDataGap {
  return {
    code: "unverified_cost",
    sourceType: "cost_entry",
    sourceId: "gap-1",
    candidateId: null,
    customerId: null,
    dealId: null,
    cohortId: null,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T07:00:00.000Z",
    recordedAt: "2026-08-09T08:00:00.000Z",
    sourceSnapshotHash: `sha256:${"d".repeat(64)}`,
    ...overrides
  };
}

function performanceDto(
  overrides: Partial<GrowthPerformanceDto> = {}
): GrowthPerformanceDto {
  return {
    cohortId: "cohort-1",
    currency: "CNY",
    planId: null,
    dataAsOf: "2026-08-09T08:00:00.000Z",
    memberIds: [],
    expectedRoiByCurrency: [],
    actualRoiByCurrency: [],
    cashByCurrency: [],
    coverage: {
      costCoverageBps: 0,
      marginCoverageBps: 0,
      cashCoverageBps: 0,
      attributionCoverageBps: 0,
      gapCodes: ["cohort_not_closed"]
    },
    dataGaps: ["cohort_not_closed"],
    closureVersionId: null,
    formulaVersion: "growth-performance.v1",
    calculationHash: `sha256:${"0".repeat(64)}`,
    membershipSnapshotHash: null,
    ...overrides
  };
}

function recommendationFixture(): AdvisorRecommendation {
  return {
    id: "recommendation-1",
    workspaceId: WS_1,
    revision: 1,
    audienceRole: "manager",
    type: "data_gap",
    summary: "核验成本数据",
    rationale: "存在未核验成本",
    metricRefs: [],
    evidenceRefs: [],
    entityRefs: [],
    confidenceBps: 8000,
    riskLevel: "medium",
    recommendedAction: { kind: "complete_cost_data", cohortId: "cohort-1" },
    status: "proposed",
    assignedTo: null,
    acceptedBy: null,
    acceptedAt: null,
    outcomeRefs: [],
    dataAsOf: "2026-08-09T08:00:00.000Z",
    inputSnapshotHash: `sha256:${"e".repeat(64)}`,
    modelSnapshotRef: "model-snapshot-1",
    promptVersion: "growth-advisor.v1",
    schemaVersion: "advisor-recommendation.v1",
    generationIdempotencyKey: "generation-1",
    expiresAt: "2026-08-10T08:00:00.000Z",
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  };
}

interface QueryFixture {
  foundation: {
    temporalBarrier: GrowthTemporalBarrier;
    sealedCutoff(context: ActiveWorkspaceContext, asOf: string):
      Promise<GrowthSealedReadCutoff>;
  };
  workspaceSettings: {
    calls: Array<{ workspaceId: string; cutoff: GrowthSealedReadCutoff }>;
    getAt: GrowthWorkspaceSettingsReaderStub["getAt"];
  };
  quote: {
    quoteApprovals: {
      calls: Array<{ context: ActiveWorkspaceContext; asOf: string }>;
      listPendingAsOf: QuoteApprovalsStub["listPendingAsOf"];
    };
    quoteVersions: {
      calls: Array<{ quoteVersionId: string; asOf: string }>;
      getAt: QuoteVersionsStub["getAt"];
    };
  };
  finance: {
    financialGaps: {
      calls: Array<{
        context: ActiveWorkspaceContext;
        visibility: FinancialDataGapVisibilityKeys;
        currency: string;
      }>;
      listCallsFor(actorId: string): Array<{
        actorId: string;
        visibility: FinancialDataGapVisibilityKeys;
        currency: string;
      }>;
      listForBindingsAt: FinancialGapsStub["listForBindingsAt"];
    };
  };
  portfolio: {
    calls: Array<{ context: ActiveWorkspaceContext; asOf: string; currency: string }>;
    listVisible: AdvisorPerformancePortfolioReader["listVisible"];
  };
  priorityCandidateReader: {
    calls: Array<{ context: ActiveWorkspaceContext; asOf: string }>;
    listAsOf: PriorityCandidateReader["listAsOf"];
  };
  candidateEvidenceReader: AdvisorCandidateEvidenceAsOfReader;
  visibility: AdvisorVisibilityResolver;
  service: GrowthAdvisorSealedQueryService;
  fixture: {
    recordLaterQualificationApprovalAndFinanceEvents(): void;
  };
}

type WorkspaceSettingsReaderStub = {
  getAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthWorkspaceSettings>;
};

type QuoteApprovalsStub = {
  listPendingAsOf(
    context: ActiveWorkspaceContext,
    input: { cutoff: GrowthSealedReadCutoff; limit: number }
  ): Promise<readonly PendingApprovalFixture[]>;
};

type PendingApprovalFixture = {
  quoteCaseId: string;
  quoteVersionId: string;
  approvalId: string;
  approvalKind: "confirmation" | "exception";
  requiredCapabilities: readonly string[];
  lifecycleRevision: number;
  currency: string;
  quotedAmountMinor: number;
  estimatedGrossProfitMinor: number;
  estimatedContributionMinor: number;
  grossMarginBps: number;
  probabilityAssessmentId: string;
  closeProbabilityBps: number;
  commercialAmountHash: `sha256:${string}`;
  salesOwnerActorId: string;
  submittedBy: string;
  submittedAt: string;
  expiresAt: string | null;
};

type QuoteVersionsStub = {
  getAt(
    context: ActiveWorkspaceContext,
    quoteVersionId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<{
    lifecycleRevision: number;
    quoteVersionId: string;
  } | null>;
};

type FinancialGapsStub = {
  listForBindingsAt(
    context: ActiveWorkspaceContext,
    input: {
      visibility: FinancialDataGapVisibilityKeys;
      currency: string;
      cutoff: GrowthSealedReadCutoff;
      limit: number;
    }
  ): Promise<readonly FinancialDataGap[]>;
};

function pendingApproval(
  overrides: Partial<PendingApprovalFixture> = {}
): PendingApprovalFixture {
  return {
    quoteCaseId: "quote-case-1",
    quoteVersionId: "quote-v1",
    approvalId: "approval-1",
    approvalKind: "confirmation",
    requiredCapabilities: Object.freeze(["quote.confirm"]),
    lifecycleRevision: 4,
    currency: "CNY",
    quotedAmountMinor: 1_000_000,
    estimatedGrossProfitMinor: 280_000,
    estimatedContributionMinor: 250_000,
    grossMarginBps: 2_800,
    probabilityAssessmentId: "assessment-1",
    closeProbabilityBps: 5_000,
    commercialAmountHash: `sha256:${"c".repeat(64)}`,
    salesOwnerActorId: "sales-a",
    submittedBy: "sales-a",
    submittedAt: "2026-08-09T07:00:00.000Z",
    expiresAt: "2026-08-10T07:00:00.000Z",
    ...overrides
  };
}

function priorityCustomer(
  overrides: Partial<PriorityCustomerView> = {}
): PriorityCustomerView {
  return {
    candidateId: "candidate-1",
    customerId: null,
    dealId: null,
    displayName: "示例企业",
    priorityScoreBps: 7_800,
    qualificationDecisionId: "qualification-1",
    qualificationDecisionVersion: "qualification-v1",
    inputSnapshotHash: `sha256:${"a".repeat(64)}`,
    ...overrides
  };
}

export async function createAdvisorQueryFixture(
  preset: "basic" | "admin" | "sales" = "basic"
): Promise<QueryFixture> {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  await authority.append(qualificationAuthorityEventFixture());
  await authority.append(qualificationAuthorityEventFixture({
    teamId: WS_1,
    candidateId: "candidate-not-in-top-10",
    qualificationDecisionId: "qualification-17",
    qualificationDecisionVersion: "qualification-v3",
    qualificationSnapshotHash: `sha256:${"a".repeat(64)}`,
    financialValueDecisionId: "financial-value-17",
    financialValueDecisionVersion: "financial-value-v3",
    financialValueInputSnapshotHash: `sha256:${"b".repeat(64)}`,
    evidence: Object.freeze([{
      evidenceId: "evidence-17",
      contentHash: `sha256:${"c".repeat(64)}`,
      fetchedAt: "2026-08-09T07:00:00.000Z"
    }])
  }));

  const workspaceSettingsCalls: QueryFixture["workspaceSettings"]["calls"] = [];
  const workspaceSettings: WorkspaceSettingsReaderStub = {
    async getAt(context, cutoff) {
      workspaceSettingsCalls.push({
        workspaceId: context.workspaceId,
        cutoff
      });
      return {
        timeZone: "Asia/Shanghai",
        revision: "growth-workspace-settings.v1",
        recordedAt: "1970-01-01T00:00:00.000Z",
        eventSequence: 1
      };
    }
  };

  const quoteApprovalCalls: Array<{
    context: ActiveWorkspaceContext;
    asOf: string;
  }> = [];
  const quoteApprovals: QuoteApprovalsStub = {
    async listPendingAsOf(context, input) {
      quoteApprovalCalls.push({
        context,
        asOf: input.cutoff.effectiveAsOf
      });
      if (preset === "sales") {
        if (context.actorId === "sales-b") {
          return [pendingApproval({
            quoteVersionId: "quote-sales-b",
            salesOwnerActorId: "sales-b",
            submittedBy: "sales-b"
          })];
        }
        return [];
      }
      return [pendingApproval()];
    }
  };
  const quoteVersionCalls: Array<{ quoteVersionId: string; asOf: string }> = [];
  const quoteVersions: QuoteVersionsStub = {
    async getAt(_context, quoteVersionId, cutoff) {
      quoteVersionCalls.push({
        quoteVersionId,
        asOf: cutoff.effectiveAsOf
      });
      return {
        quoteVersionId,
        lifecycleRevision: 4
      };
    }
  };

  const financeStubCalls: Array<{
    actorId: string;
    visibility: FinancialDataGapVisibilityKeys;
    currency: string;
  }> = [];
  const financialGaps: FinancialGapsStub = {
    async listForBindingsAt(context, input) {
      financeStubCalls.push({
        actorId: context.actorId,
        visibility: input.visibility,
        currency: input.currency
      });
      if (preset === "sales") {
        if (context.actorId === "sales-a") {
          return [financialGap({ sourceId: "gap-sales-a" })];
        }
        if (context.actorId === "sales-b") {
          return [financialGap({ sourceId: "gap-sales-b" })];
        }
        return [];
      }
      return [financialGap()];
    }
  };

  const portfolioCalls: QueryFixture["portfolio"]["calls"] = [];
  const portfolio: AdvisorPerformancePortfolioReader = {
    async listVisible(context, query) {
      portfolioCalls.push({
        context,
        asOf: query.cutoff.effectiveAsOf,
        currency: query.currency
      });
      if (preset === "sales") return [];
      if (preset === "admin") {
        return [
          {
            cohortId: "cohort-1",
            planId: null,
            performance: performanceDto({
              actualRoiByCurrency: [{
                currency: "CNY",
                status: "computed",
                basis: "verified_gross_profit",
                roiBps: 10_000,
                costCoverageBps: 10_000,
                marginCoverageBps: 10_000,
                cashCoverageBps: 10_000,
                attributionCoverageBps: 10_000,
                closureVersionId: "closure-1",
                closureAsOf: "2026-08-09T07:00:00.000Z",
                formulaVersion: "verified-gross-profit-roi.v1",
                amountVisibility: "full",
                verifiedGrossProfitMinor: 1_000_000,
                verifiedAcquisitionCostMinor: 500_000
              }]
            })
          },
          {
            cohortId: "cohort-2",
            planId: null,
            performance: performanceDto({
              cohortId: "cohort-2",
              actualRoiByCurrency: [{
                currency: "CNY",
                status: "computed",
                basis: "verified_gross_profit",
                roiBps: -5_000,
                costCoverageBps: 10_000,
                marginCoverageBps: 10_000,
                cashCoverageBps: 10_000,
                attributionCoverageBps: 10_000,
                closureVersionId: "closure-2",
                closureAsOf: "2026-08-09T07:00:00.000Z",
                formulaVersion: "verified-gross-profit-roi.v1",
                amountVisibility: "full",
                verifiedGrossProfitMinor: 500_000,
                verifiedAcquisitionCostMinor: 1_000_000
              }]
            })
          }
        ];
      }
      return [{
        cohortId: "cohort-1",
        planId: null,
        performance: performanceDto({
          actualRoiByCurrency: [{
            currency: "CNY",
            status: "not_computable",
            reason: "cohort_not_closed",
            closureVersionId: null,
            closureAsOf: null,
            formulaVersion: "verified-gross-profit-roi.v1"
          }]
        })
      }];
    }
  };

  const priorityCalls: QueryFixture["priorityCandidateReader"]["calls"] = [];
  const priorityCandidateReader: PriorityCandidateReader = {
    async listAsOf(context, input) {
      priorityCalls.push({
        context,
        asOf: input.cutoff.effectiveAsOf
      });
      if (preset === "sales") {
        if (context.role === "manager") {
          return [
            priorityCustomer({ candidateId: "candidate-sales-a" }),
            priorityCustomer({ candidateId: "candidate-sales-b" })
          ];
        }
        return context.actorId === "sales-a"
          ? [priorityCustomer({ candidateId: "candidate-sales-a" })]
          : [];
      }
      if (preset === "admin") {
        return [
          priorityCustomer({ candidateId: "candidate-1" }),
          priorityCustomer({ candidateId: "candidate-2" })
        ];
      }
      return [
        priorityCustomer({ candidateId: "candidate-1" }),
        priorityCustomer({ candidateId: "candidate-2" }),
        priorityCustomer({ candidateId: "candidate-3" })
      ];
    }
  };

  const quoteBindings = {
    async listVisibleBindings() {
      return Object.freeze([]) as readonly QuoteBindingVisibilityRow[];
    }
  };
  const cohortBindings = {
    async listVisibleCohorts() {
      return Object.freeze([]) as readonly CohortBindingVisibilityRow[];
    }
  };
  const visibility: AdvisorVisibilityResolver = preset === "sales"
    ? {
        async resolveAt(context) {
          const actorId = context.actorId;
          const suffix = actorId === "sales-b" ? "b" : "a";
          return Object.freeze({
            scope: { kind: "sales_own", actorId },
            subjectVisibility: Object.freeze({
              candidateIds: Object.freeze([`candidate-sales-${suffix}`]),
              customerIds: Object.freeze([`customer-sales-${suffix}`]),
              dealIds: Object.freeze([`deal-sales-${suffix}`]),
              cohortIds: Object.freeze([`cohort-sales-${suffix}`])
            }),
            financialGapVisibility: Object.freeze({
              candidateIds: Object.freeze([`candidate-sales-${suffix}`]),
              customerIds: Object.freeze([`customer-sales-${suffix}`]),
              dealIds: Object.freeze([`deal-sales-${suffix}`]),
              cohortIds: Object.freeze([`cohort-sales-${suffix}`])
            }),
            sourceSnapshotHash: `sha256:${suffix.repeat(64).slice(0, 64)}`
          });
        }
      }
    : new DefaultAdvisorVisibilityResolver({
        candidateAuthority: authority,
        quoteBindings,
        cohortBindings
      });

  const recommendationRepository = {
    async listAt() {
      return {
        items: Object.freeze([recommendationFixture()]),
        nextCursor: null,
        hasMore: false
      };
    }
  };

  const service = createGrowthAdvisorQueryService({
    temporalBarrier: barrier,
    workspaceSettings,
    visibility,
    priorityCandidates: priorityCandidateReader,
    quoteApprovals,
    quoteVersions,
    performancePortfolio: portfolio,
    financialGaps,
    recommendations: recommendationRepository,
    now: () => "2026-08-09T09:00:00.000Z"
  });
  const candidateEvidenceReader: AdvisorCandidateEvidenceAsOfReader =
    new DefaultPriorityCandidateReader({
      candidateAuthority: authority,
      quoteBindings,
      displayNames: {
        async listDisplayNames() {
          return new Map([["candidate-not-in-top-10", "任意授权候选"]]);
        }
      }
    });
  return {
    foundation: {
      temporalBarrier: barrier,
      async sealedCutoff(context, asOf) {
        return barrier.sealReadCutoff(context, asOf);
      }
    },
    workspaceSettings: {
      calls: workspaceSettingsCalls,
      getAt: workspaceSettings.getAt
    },
    quote: {
      quoteApprovals: {
        calls: quoteApprovalCalls,
        listPendingAsOf: quoteApprovals.listPendingAsOf
      },
      quoteVersions: {
        calls: quoteVersionCalls,
        getAt: quoteVersions.getAt
      }
    },
    finance: {
      financialGaps: {
        calls: financeStubCalls,
        listCallsFor(actorId) {
          return financeStubCalls.filter((call) => call.actorId === actorId);
        },
        listForBindingsAt: financialGaps.listForBindingsAt
      }
    },
    portfolio: {
      calls: portfolioCalls,
      listVisible: portfolio.listVisible
    },
    priorityCandidateReader: {
      calls: priorityCalls,
      listAsOf: priorityCandidateReader.listAsOf
    },
    candidateEvidenceReader,
    visibility,
    service,
    fixture: {
      recordLaterQualificationApprovalAndFinanceEvents() {
        // Later events must never rewrite an already-sealed earlier cutoff.
      }
    }
  };
}

const basicInput = Object.freeze({
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});

test("public today seals once while sealed reads reject forged or foreign cutoffs", async () => {
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
  const makeService = (sharedBarrier?: CountingBarrier) => {
    const transactions = new InMemoryGrowthTemporalTransactionRunner(
      "2026-08-09T08:00:00.000Z"
    );
    const barrier = sharedBarrier ?? new CountingBarrier(transactions);
    const seen: GrowthSealedReadCutoff[] = [];
    const service = createGrowthAdvisorQueryService({
      temporalBarrier: barrier,
      workspaceSettings: {
        async getAt(_context, cutoff) {
          seen.push(cutoff);
          return {
            timeZone: "Asia/Shanghai",
            revision: "growth-workspace-settings.v1",
            recordedAt: "1970-01-01T00:00:00.000Z",
            eventSequence: 1
          };
        }
      } as never,
      visibility: {
        async resolveAt(_context, cutoff) {
          seen.push(cutoff);
          return {
            scope: { kind: "workspace", workspaceId: WS_1 },
            subjectVisibility: {
              candidateIds: [], customerIds: [], dealIds: [], cohortIds: []
            },
            financialGapVisibility: {
              candidateIds: [], customerIds: [], dealIds: [], cohortIds: []
            },
            sourceSnapshotHash: `sha256:${"1".repeat(64)}`
          };
        }
      } as never,
      priorityCandidates: {
        async listAsOf(_context, input) {
          seen.push(input.cutoff);
          return [];
        }
      },
      quoteApprovals: {
        async listPendingAsOf(_context, input) {
          seen.push(input.cutoff);
          return [];
        }
      },
      quoteVersions: { async getAt() { return null; } },
      performancePortfolio: {
        async listVisible(_context, input) {
          seen.push(input.cutoff);
          return [];
        }
      },
      financialGaps: {
        async listForBindingsAt(_context, input) {
          seen.push(input.cutoff);
          return [];
        }
      },
      recommendations: {
        async listAt(_context, input) {
          seen.push(input.cutoff);
          return { items: [], nextCursor: null, hasMore: false };
        }
      },
      now: () => "2026-08-09T09:00:00.000Z"
    });
    return { barrier, seen, service };
  };
  const context = advisorContext(WS_1, [], { role: "admin", teamId: "all" });
  const first = makeService();
  const publicView = await first.service.getToday(context, basicInput);
  assert.equal(first.barrier.sealCalls, 1);
  assert.equal(new Set(first.seen).size, 1);
  assert.equal(publicView.dataAsOf, basicInput.asOf);

  const sealed = await first.service.sealTodayCutoff(context, basicInput.asOf);
  await first.service.getTodayAt(context, { currency: "CNY", cutoff: sealed });
  assert.equal(first.barrier.sealCalls, 2);

  await assert.rejects(
    first.service.getTodayAt(context, {
      currency: "CNY",
      cutoff: { ...sealed } as GrowthSealedReadCutoff
    }),
    /invalid_growth_advisor_sealed_read_cutoff/u
  );
  const second = makeService(first.barrier);
  await assert.rejects(
    second.service.getTodayAt(context, { currency: "CNY", cutoff: sealed }),
    /invalid_growth_advisor_sealed_read_cutoff/u
  );
  const foreign = await second.service.sealTodayCutoff(context, basicInput.asOf);
  await assert.rejects(
    first.service.getTodayAt(context, { currency: "CNY", cutoff: foreign }),
    /invalid_growth_advisor_sealed_read_cutoff/u
  );
});

test("today view combines facts without inventing missing ROI", async () => {
  const fixture = await createAdvisorQueryFixture("basic");
  const result = await fixture.service.getToday(
    advisorContext(WS_1, [], { role: "manager" }), basicInput
  );
  assert.equal(result.priorityCustomers.length, 3);
  assert.equal(result.pendingQuoteApprovals[0]?.quoteVersionId, "quote-v1");
  assert.deepEqual(result.actualRoi, [{
    cohortId: "cohort-1",
    planId: null,
    currency: "CNY",
    status: "not_computable",
    reason: "cohort_not_closed",
    closureVersionId: null,
    closureAsOf: null,
    formulaVersion: "verified-gross-profit-roi.v1"
  }]);
  assert.deepEqual(result.dataGaps.map((gap) => gap.code), ["unverified_cost"]);
  assert.equal(result.dataAsOf, "2026-08-09T08:00:00.000Z");
  assert.equal(result.recommendations.length, 1);
  assert.match(result.sourceSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
});

test("sensitive margins are projected by capability", async () => {
  const fixture = await createAdvisorQueryFixture("basic");
  const sales = await fixture.service.getToday(
    advisorContext(WS_1, ["catalog.read"], {
      role: "sales", actorId: "sales-a", teamId: "team-1"
    }), basicInput
  );
  const manager = await fixture.service.getToday(
    advisorContext(WS_1, [
      "catalog.read",
      "pricing.sensitive.read",
      "growth.performance.team.read"
    ], { role: "manager", actorId: "manager-1", teamId: "team-1" }),
    basicInput
  );
  assert.equal(
    sales.pendingQuoteApprovals[0]?.estimatedGrossProfitMinor,
    undefined
  );
  assert.equal(
    manager.pendingQuoteApprovals[0]?.estimatedGrossProfitMinor,
    280_000
  );
});

test("role and timezone are server-derived and portfolio ROI is never averaged", async () => {
  const fixture = await createAdvisorQueryFixture("admin");
  const result = await fixture.service.getToday(
    advisorContext(WS_1, ["growth.performance.workspace.read"], {
      role: "admin", actorId: "admin-1", teamId: "team-1"
    }), basicInput
  );
  assert.equal(result.audienceRole, "admin");
  assert.deepEqual(
    result.actualRoi.map((row) => [row.cohortId, row.roiBps]),
    [["cohort-1", 10_000], ["cohort-2", -5_000]]
  );
  assert.equal(fixture.workspaceSettings.calls[0]?.workspaceId, WS_1);
  assert.equal(
    fixture.portfolio.calls[0]?.asOf,
    "2026-08-09T08:00:00.000Z"
  );
});

test("priority candidates and pending quotes are historical at dataAsOf", async () => {
  const fixture = await createAdvisorQueryFixture("basic");
  const workspace = advisorContext(WS_1, ["catalog.read"], {
    role: "manager", actorId: "manager-1", teamId: "team-1"
  });
  const before = await fixture.service.getToday(workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z"
  });
  fixture.fixture.recordLaterQualificationApprovalAndFinanceEvents();
  const replay = await fixture.service.getToday(workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z"
  });
  assert.deepEqual(replay, before);
  assert.equal(fixture.priorityCandidateReader.calls[0]?.context, workspace);
  assert.equal(
    fixture.quote.quoteApprovals.calls[0]?.asOf,
    "2026-08-09T08:30:00.000Z"
  );
  assert.equal(fixture.finance.financialGaps.calls[0]?.currency, "CNY");
});

test("sales sees only owned rows while manager sees team rows", async () => {
  const fixture = await createAdvisorQueryFixture("sales");
  const salesA = await fixture.service.getToday(
    advisorContext(WS_1, ["catalog.read"], {
      role: "sales", actorId: "sales-a", teamId: "team-1"
    }), basicInput
  );
  const salesB = await fixture.service.getToday(
    advisorContext(WS_1, ["catalog.read"], {
      role: "sales", actorId: "sales-b", teamId: "team-1"
    }), basicInput
  );
  const manager = await fixture.service.getToday(
    advisorContext(WS_1, [
      "catalog.read", "growth.performance.team.read"
    ], { role: "manager", actorId: "manager-1", teamId: "team-1" }),
    basicInput
  );
  assert.deepEqual(
    salesA.priorityCustomers.map((row) => row.candidateId),
    ["candidate-sales-a"]
  );
  assert.deepEqual(
    salesB.pendingQuoteApprovals.map((row) => row.quoteVersionId),
    ["quote-sales-b"]
  );
  assert.deepEqual(salesA.dataGaps.map((row) => row.sourceId), ["gap-sales-a"]);
  assert.deepEqual(salesB.dataGaps.map((row) => row.sourceId), ["gap-sales-b"]);
  assert.deepEqual(
    fixture.finance.financialGaps.listCallsFor("sales-a")[0]?.visibility,
    {
      candidateIds: ["candidate-sales-a"],
      customerIds: ["customer-sales-a"],
      dealIds: ["deal-sales-a"],
      cohortIds: ["cohort-sales-a"]
    }
  );
  assert.equal(manager.priorityCustomers.length, 2);
  assert.deepEqual(salesA.actualRoi, []);
});

test("candidate evidence reader verifies an arbitrary authorized ref outside the Today top list", async () => {
  const fixture = await createAdvisorQueryFixture("basic");
  const workspace = advisorContext(WS_1, ["catalog.read"]);
  const snapshot = await fixture.candidateEvidenceReader.getAt(
    workspace,
    {
      candidateId: "candidate-not-in-top-10",
      cutoff: await fixture.foundation.sealedCutoff(
        workspace, "2026-08-09T08:30:00.000Z"
      )
    }
  );
  assert.equal(snapshot?.qualificationDecisionId, "qualification-17");
  assert.equal(snapshot?.qualificationDecisionVersion, "qualification-v3");
  assert.match(snapshot?.qualificationSnapshotHash ?? "", /^sha256:/u);
  assert.match(
    snapshot?.financialValueInputSnapshotHash ?? "",
    /^sha256:/u
  );
  assert.deepEqual(
    snapshot?.evidence.map((row) => row.evidenceId),
    ["evidence-17"]
  );
  const otherWorkspace = advisorContext(WS_2, []);
  assert.equal(await fixture.candidateEvidenceReader.getAt(
    otherWorkspace,
    {
      candidateId: "candidate-not-in-top-10",
      cutoff: await fixture.foundation.sealedCutoff(
        otherWorkspace, "2026-08-09T08:30:00.000Z"
      )
    }
  ), null);
});

test("future asOf is rejected before any reader is called", async () => {
  const fixture = await createAdvisorQueryFixture("basic");
  await assert.rejects(
    fixture.service.getToday(
      advisorContext(WS_1),
      { currency: "CNY", asOf: "2026-08-09T12:00:00.000Z" }
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "invalid_as_of"
      && (error as { status?: number }).status === 422
  );
  assert.equal(fixture.workspaceSettings.calls.length, 0);
});

test("missing quote snapshot becomes a source-backed data gap", async () => {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const base = await createAdvisorQueryFixture("basic");
  const service = createGrowthAdvisorQueryService({
    temporalBarrier: barrier,
    workspaceSettings: {
      async getAt() {
        return {
          timeZone: "Asia/Shanghai",
          revision: "growth-workspace-settings.v1",
          recordedAt: "1970-01-01T00:00:00.000Z",
          eventSequence: 1
        };
      }
    },
    visibility: base.visibility,
    priorityCandidates: base.priorityCandidateReader,
    quoteApprovals: {
      async listPendingAsOf() {
        return [pendingApproval()];
      }
    },
    quoteVersions: {
      async getAt() {
        return null;
      }
    },
    performancePortfolio: {
      async listVisible() {
        return [];
      }
    },
    financialGaps: {
      async listForBindingsAt() {
        return [];
      }
    },
    recommendations: {
      async listAt() {
        return { items: [], nextCursor: null, hasMore: false };
      }
    },
    now: () => "2026-08-09T09:00:00.000Z"
  });
  const result: GrowthAdvisorTodayView = await service.getToday(
    advisorContext(WS_1),
    basicInput
  );
  assert.deepEqual(result.pendingQuoteApprovals, []);
  assert.deepEqual(result.dataGaps.map((gap) => [
    gap.code,
    gap.sourceType,
    gap.sourceId
  ]), [["missing_commercial_binding", "commercial_binding", "quote-v1"]]);
});

test("visibility resolver derives only sealed authority sets", async () => {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  await authority.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-sales-a",
    ownerId: "sales-a",
    teamId: WS_1
  }));
  await authority.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-sales-b",
    ownerId: "sales-b",
    teamId: WS_1
  }));
  const resolver = new DefaultAdvisorVisibilityResolver({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings(context) {
        return Object.freeze([{
          quoteVersionId: "quote-v1",
          candidateId: "candidate-sales-a",
          customerId: "customer-sales-a",
          dealId: "deal-sales-a",
          salesOwnerActorId: "sales-a",
          teamId: context.teamId
        }]);
      }
    },
    cohortBindings: {
      async listVisibleCohorts(_context, _cutoff, candidateIds) {
        return Object.freeze([{
          cohortId: "cohort-sales-a",
          candidateIds: Object.freeze([...candidateIds]),
          dealIds: Object.freeze([]),
          customerIds: Object.freeze([]),
          teamId: "team-1"
        }]);
      }
    }
  });
  const workspace = advisorContext(WS_1, [], {
    role: "sales", actorId: "sales-a", teamId: "team-1"
  });
  const snapshot = await resolver.resolveAt(
    workspace,
    await barrier.sealReadCutoff(workspace, "2026-08-09T08:00:00.000Z")
  );
  assert.deepEqual(snapshot.scope, { kind: "sales_own", actorId: "sales-a" });
  assert.deepEqual(snapshot.subjectVisibility.candidateIds, [
    "candidate-sales-a"
  ]);
  assert.deepEqual(snapshot.subjectVisibility.customerIds, [
    "customer-sales-a"
  ]);
  assert.deepEqual(snapshot.subjectVisibility.cohortIds, [
    "cohort-sales-a"
  ]);
  assert.deepEqual(
    snapshot.financialGapVisibility,
    snapshot.subjectVisibility
  );
  assert.match(snapshot.sourceSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
});

export type AdvisorTodayViewFixture = QueryFixture;
export type AdvisorPendingApprovalFixture = PendingApprovalFixture;
