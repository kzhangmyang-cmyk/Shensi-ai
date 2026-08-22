import type { BusinessReportInput } from "./business-advisor/domain.js";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import {
  validateFinancialCouncilAuthoritySnapshot,
  type FinancialCouncilAuthoritySnapshot
} from "./financial-council-authority-reader.js";
import {
  DefaultFinancialCouncilAnalysisPipeline,
  FinancialCouncilAnalysisWorker
} from "./financial-council-analysis-worker.js";
import {
  financialCouncilCanonicalHash,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import type {
  FinancialCfoNarrativeInput,
  FinancialCfoNarrativeOutput,
  FinancialCouncilAnalyzeInput,
  FinancialCouncilAnalyzeOutput,
  FinancialCouncilModelPort,
  FinancialCouncilModelResult,
  FinancialCouncilRebutInput,
  FinancialCouncilRebutOutput
} from "./financial-council-model-port.js";
import {
  FinancialCouncilOptimizationWorker,
  FinancialCouncilPipelineWorker
} from "./financial-council-optimization-worker.js";
import { InMemoryFinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import type { FinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import { FinancialCouncilRebuttalCoordinator } from
  "./financial-council-rebuttal.js";
import { createFinancialCouncilDispatchRuntime } from
  "./financial-council-dispatch-runtime.js";
import { InMemoryFinancialCouncilDraftRepository } from
  "./financial-council-draft-repository.js";
import type { FinancialCouncilDraftRepository } from
  "./financial-council-draft-repository.js";
import {
  InMemoryFinancialCouncilRepository,
  type FinancialCouncilRepository
} from "./financial-council-repository.js";
import { FinancialCouncilService } from "./financial-council-service.js";
import { FinancialSnapshotBuilder } from "./financial-council-snapshot.js";
import { FinancialCouncilSourceVerifier } from
  "./financial-council-source-verifier.js";
import { FinancialCouncilSpecialistCoordinator } from
  "./financial-council-specialists.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from
  "./growth-workspace-context.js";

export const FINANCIAL_COUNCIL_INTEGRATION_WORKSPACE = "council-e2e";
export const FINANCIAL_COUNCIL_INTEGRATION_ACTOR = "council-admin";
export const FINANCIAL_COUNCIL_INTEGRATION_AS_OF =
  "2026-08-16T08:00:00.000Z";

const HASH = (value: unknown) => financialCouncilCanonicalHash(value);

export function financialCouncilIntegrationWorkspace():
ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: FINANCIAL_COUNCIL_INTEGRATION_WORKSPACE,
    kind: "team",
    actorId: FINANCIAL_COUNCIL_INTEGRATION_ACTOR,
    role: "admin",
    teamId: FINANCIAL_COUNCIL_INTEGRATION_WORKSPACE,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

let commandSequence = 0;
export function financialCouncilIntegrationCommand(
  label: string,
  expectedRevision: number | null
): CommandContext {
  commandSequence += 1;
  const key = `${label}-${commandSequence}`;
  const workspace = financialCouncilIntegrationWorkspace();
  return Object.freeze({
    workspace,
    actorId: workspace.actorId,
    idempotencyKey: key,
    requestHash: HASH({ label, commandSequence }),
    expectedRevision
  });
}

export function completeFinancialCouncilIntegrationReport():
BusinessReportInput {
  return Object.freeze({
    currency: "CNY",
    companyName: "Council Vertical Co",
    period: "2026-08",
    balanceSheet: Object.freeze({
      period: "2026-08", cashMinor: 800_000,
      receivablesMinor: 1_200_000, inventoryMinor: 900_000,
      otherCurrentAssetsMinor: 100_000, nonCurrentAssetsMinor: 500_000,
      currentLiabilitiesMinor: 1_000_000, nonCurrentLiabilitiesMinor: 300_000,
      accountsPayableMinor: 700_000
    }),
    incomeStatement: Object.freeze({
      period: "2026-08", revenueMinor: 5_000_000,
      costOfGoodsSoldMinor: 3_000_000, operatingExpensesMinor: 1_000_000,
      interestExpenseMinor: 50_000, taxExpenseMinor: 60_000,
      productLines: Object.freeze([Object.freeze({
        name: "Loss Product", revenueMinor: 1_000_000,
        costOfGoodsSoldMinor: 700_000, afterSalesCostMinor: 100_000,
        shippingCostMinor: 100_000, sellingExpenseMinor: 100_000,
        allocatedOverheadMinor: 100_000
      })]),
      customers: Object.freeze([Object.freeze({
        name: "Customer A", revenueMinor: 1_000_000,
        grossProfitMinor: 250_000, serviceCostMinor: 50_000,
        paymentDays: 120, outstandingReceivableMinor: 1_000_000
      })])
    }),
    cashFlow: Object.freeze({
      period: "2026-08", openingCashMinor: 600_000,
      operatingInflowMinor: 4_500_000, operatingOutflowMinor: 3_900_000,
      investingNetMinor: 0, financingNetMinor: -400_000,
      receivables: Object.freeze([Object.freeze({
        customer: "Customer A", amountMinor: 1_000_000,
        daysOutstanding: 120
      })]),
      expectedInflowsNext30DaysMinor: 100_000,
      expectedOutflowsNext30DaysMinor: 500_000,
      expectedInflowsNext31To90DaysMinor: 800_000,
      expectedOutflowsNext31To90DaysMinor: 300_000
    }),
    costDetail: Object.freeze({
      materialCostRateBps: 4_200, previousMaterialCostRateBps: 3_500,
      laborCostMinor: 400_000, rawMaterialCostMinor: 2_100_000,
      salesCommissionRateBps: 500, fixedOverheadMinor: 300_000
    }),
    taxRisk: Object.freeze({
      invoiceIssues: Object.freeze(["发票抬头异常"]),
      revenueRecognitionIssues: Object.freeze([]),
      costAuthenticityIssues: Object.freeze([]),
      payrollIssues: Object.freeze([]), equityIssues: Object.freeze([])
    })
  });
}

function authorityAt(
  dataAsOf: string,
  workspaceId = FINANCIAL_COUNCIL_INTEGRATION_WORKSPACE
): FinancialCouncilAuthoritySnapshot {
  const projection = Object.freeze({
    workspaceId,
    currency: "CNY",
    dataAsOf,
    projectionLevel: "full" as const,
    priorityCustomers: Object.freeze([Object.freeze({
      candidateId: "candidate-1", customerId: "customer-1",
      dealId: "deal-1", displayName: "CRM Customer",
      priorityScoreBps: 9_000,
      qualificationDecisionId: "qualification-1",
      qualificationDecisionVersion: "v1",
      inputSnapshotHash: HASH("qualification")
    })]),
    pendingQuoteApprovals: Object.freeze([Object.freeze({
      quoteCaseId: "quote-case-1", quoteVersionId: "quote-1",
      approvalId: "quote-approval-1", approvalKind: "confirmation" as const,
      requiredCapabilities: Object.freeze(["quote.confirm"]),
      quoteVersionRevision: 4, currency: "CNY",
      quotedAmountMinor: 1_000_000,
      estimatedGrossProfitMinor: 200_000,
      estimatedContributionMinor: 180_000, grossMarginBps: 2_000,
      submittedAt: "2026-08-15T07:00:00.000Z", expiresAt: null
    })]),
    verifiedFinancialFacts: Object.freeze([Object.freeze({
      entryId: "fact-cogs-1", sourceVersion: 1,
      factType: "cogs_recognized" as const, currency: "CNY",
      businessOccurredAt: "2026-08-15T06:00:00.000Z",
      entryRecordedAt: "2026-08-15T07:00:00.000Z",
      verificationRevision: 2,
      verificationRecordedAt: "2026-08-15T08:00:00.000Z",
      snapshotHash: HASH("fact-cogs"), amountVisibility: "full" as const,
      amountMinor: 700_000, netAmountMinor: 700_000
    }), Object.freeze({
      entryId: "fact-payment-1", sourceVersion: 1,
      factType: "payment_received" as const, currency: "CNY",
      businessOccurredAt: "2026-08-15T06:00:00.000Z",
      entryRecordedAt: "2026-08-15T07:00:00.000Z",
      verificationRevision: 2,
      verificationRecordedAt: "2026-08-15T08:00:00.000Z",
      snapshotHash: HASH("fact-payment"), amountVisibility: "full" as const,
      amountMinor: 500_000, netAmountMinor: 500_000
    })]),
    expectedRoi: Object.freeze([Object.freeze({
      cohortId: "cohort-1", planId: null, currency: "CNY",
      status: "computed" as const, reason: null, roiBps: 4_000,
      formulaVersion: "expected-gross-profit-roi.v1",
      quoteVersionIds: Object.freeze(["quote-1"]),
      probabilityAssessmentIds: Object.freeze(["probability-1"]),
      costEstimateIds: Object.freeze(["cost-1"]),
      amountVisibility: "full" as const,
      probabilityWeightedGrossProfitMinor: 700_000,
      attributedEstimatedCostMinor: 500_000
    })]),
    actualRoi: Object.freeze([Object.freeze({
      cohortId: "cohort-1", planId: null, currency: "CNY",
      status: "computed" as const, basis: "verified_gross_profit" as const,
      roiBps: 3_000, costCoverageBps: 10_000,
      marginCoverageBps: 10_000, cashCoverageBps: 10_000,
      attributionCoverageBps: 10_000, closureVersionId: "closure-1",
      closureAsOf: "2026-08-15T08:00:00.000Z",
      formulaVersion: "verified-gross-profit-roi.v1",
      amountVisibility: "full" as const,
      verifiedGrossProfitMinor: 650_000,
      verifiedAcquisitionCostMinor: 500_000
    })]),
    dataGaps: Object.freeze([])
  });
  return validateFinancialCouncilAuthoritySnapshot(Object.freeze({
    ...projection,
    sourceSnapshotHash: HASH(projection)
  }));
}

type FormulaProjection = {
  readonly refId: string;
  readonly formulaId: string;
  readonly evidenceRefIds: readonly string[];
  readonly value: unknown;
};

function formula(input: FinancialCouncilAnalyzeInput, formulaId: string):
FormulaProjection {
  const row = (input.businessData as {
    formulas: readonly FormulaProjection[];
  }).formulas.find((candidate) => candidate.formulaId === formulaId);
  if (!row) throw new Error(`missing integration formula:${formulaId}`);
  return row;
}

function firstFormulaSubject(projected: FormulaProjection): string | null {
  const value = projected.value as {
    readonly bySubject?: readonly { readonly subjectRef?: unknown }[];
  };
  const subject = value.bySubject?.[0]?.subjectRef;
  return typeof subject === "string" && subject.length > 0 ? subject : null;
}

function modelResult<Value>(
  phase: "analyze" | "rebut",
  input: FinancialCouncilAnalyzeInput | FinancialCouncilRebutInput,
  value: Value
): FinancialCouncilModelResult<Value> {
  const content = phase === "analyze"
    ? buildFinancialCouncilModelContent("analyze",
        input as FinancialCouncilAnalyzeInput)
    : buildFinancialCouncilModelContent("rebut",
        input as FinancialCouncilRebutInput);
  return Object.freeze({
    value,
    binding: Object.freeze({
      jobId: `financial-council:${input.runId}:${input.role}:${phase}:1`,
      runId: input.runId, snapshotId: input.snapshotId,
      snapshotHash: input.snapshotHash, role: input.role, phase, attempt: 1,
      connectionId: "deterministic-integration-model", credentialVersion: 1,
      provider: "openai" as const, model: "deterministic-council-v1",
      capabilitySnapshotHash: HASH("integration-capability"),
      baseUrlFingerprint: "test-only-no-network",
      promptVersion: content.promptVersion,
      schemaVersion: content.schemaVersion,
      contentHash: content.contentHash,
      promptHash: content.promptHash,
      schemaHash: content.schemaHash
    }),
    repaired: false,
    providerRequestId: null
  });
}

export class DeterministicFinancialCouncilModelPort
implements FinancialCouncilModelPort {
  constructor(private readonly delayMs = 0) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new TypeError("invalid_financial_council_model_delay");
    }
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  async analyze(input: FinancialCouncilAnalyzeInput):
  Promise<FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>> {
    await this.delay();
    const specs = input.role === "cashflow"
      ? [{ formulaId: "eligible_overdue_receivable",
          action: "collect_receivable" as const },
        { formulaId: "cash_shortfall",
          action: "prepare_cash_reserve_budget" as const }]
      : input.role === "profit"
        ? [{ formulaId: "loss_product_pricing_gap",
            action: "review_loss_product_pricing" as const }]
        : input.role === "cost"
          ? [{ formulaId: "verified_avoidable_cost",
              action: "reduce_cost_anomaly" as const }]
          : input.role === "tax"
            ? [{ formulaId: "tax_risk",
                action: "schedule_tax_review" as const }]
            : [{ formulaId: "financial_indicators", action: null }];
    const findingDrafts = specs.map((spec, index) => {
      const projected = formula(input, spec.formulaId);
      return Object.freeze({
        findingId: input.allowlist.findingIds[index]!,
        conclusion: input.role === "tax"
          ? "税务风险需专业人员复核" : "risk_hypothesis",
        evidenceRefs: Object.freeze([projected.evidenceRefIds[0]
          ?? input.allowlist.evidenceRefIds[0]!]),
        formulaRef: projected.refId, confidenceBps: 8_000,
        severity: "warning" as const,
        assumptions: Object.freeze([]), missingDataRefs: Object.freeze([])
      });
    });
    const explanations = {
      collect_receivable: "collect_receivable_hypothesis",
      prepare_cash_reserve_budget: "prepare_cash_reserve_budget_hypothesis",
      review_loss_product_pricing: "review_loss_product_pricing_hypothesis",
      reduce_cost_anomaly: "reduce_cost_anomaly_hypothesis",
      schedule_tax_review: "税务风险需专业人员复核"
    } as const;
    const actionHypotheses = specs.flatMap((spec, index) => spec.action
      ? [Object.freeze({
          kind: spec.action,
          sourceFindingIds: Object.freeze([findingDrafts[index]!.findingId]),
          subjectRef: spec.action === "review_loss_product_pricing"
            ? firstFormulaSubject(formula(input, spec.formulaId)) : null,
          explanation: explanations[spec.action]
        })] : []);
    return modelResult("analyze", input, Object.freeze({
      findingDrafts: Object.freeze(findingDrafts),
      actionHypotheses: Object.freeze(actionHypotheses)
    }));
  }

  async rebut(input: FinancialCouncilRebutInput):
  Promise<FinancialCouncilModelResult<FinancialCouncilRebutOutput>> {
    await this.delay();
    return modelResult("rebut", input, Object.freeze({
      decision: "uphold" as const,
      findingId: input.targetFindingId,
      evidenceRefs: Object.freeze([input.allowlist.evidenceRefIds[0]!]),
      replacement: null,
      explanation: "risk preference remains material"
    }));
  }

  async synthesize(input: FinancialCfoNarrativeInput):
  Promise<FinancialCfoNarrativeOutput> {
    return Object.freeze({
      overallDiagnosis: "Prioritize cash protection and verified margins.",
      priorityFindingIds: Object.freeze(input.acceptedFindings
        .slice(0, 2).map((row) => row.findingId)),
      minorityFindingIds: Object.freeze(input.minorityFindings
        .map((row) => row.findingId)),
      riskNotes: Object.freeze(input.unresolvedConflicts.length
        ? ["An unresolved risk preference remains visible."] : [])
    });
  }
}

export interface FinancialCouncilIntegrationFixture {
  readonly repository: FinancialCouncilRepository;
  readonly policyRepository: FinancialCouncilPolicyRepository;
  readonly service: FinancialCouncilService;
  readonly pipeline: FinancialCouncilPipelineWorker;
  readonly dispatch: ReturnType<typeof createFinancialCouncilDispatchRuntime>;
  readonly drafts: FinancialCouncilDraftRepository;
  authorityReadHash(): `sha256:${string}`;
  close(): Promise<void>;
}

export async function createFinancialCouncilIntegrationFixture(options: {
  repository?: FinancialCouncilRepository;
  policyRepository?: FinancialCouncilPolicyRepository;
  draftRepository?: FinancialCouncilDraftRepository;
  workspaceId?: string;
  autoWake?: boolean;
  modelDelayMs?: number;
  formulaMinimumCashReserveMinor?: number;
  logger?: { error(event: Readonly<Record<string, unknown>>): void };
} = {}): Promise<FinancialCouncilIntegrationFixture> {
  const repository = options.repository
    ?? new InMemoryFinancialCouncilRepository();
  const policyRepository = options.policyRepository
    ?? new InMemoryFinancialCouncilPolicyRepository();
  const workspaceId = options.workspaceId
    ?? FINANCIAL_COUNCIL_INTEGRATION_WORKSPACE;
  const now = () => "2026-08-16T08:10:00.000Z";
  const cutoffIssuer = Object.freeze({
    async sealTodayCutoff(
      context: ActiveWorkspaceContext,
      effectiveAsOf: string
    ) {
      return Object.freeze({
        workspaceId: context.workspaceId,
        effectiveAsOf,
        temporalSequence: 0
      }) as never;
    }
  });
  const authority = Object.freeze({
    async readAt(_context: ActiveWorkspaceContext, input: {
      cutoff: { effectiveAsOf: string };
    }) {
      return authorityAt(input.cutoff.effectiveAsOf, workspaceId);
    }
  });
  const snapshotBuilder = new FinancialSnapshotBuilder({
    cutoffIssuer,
    authority: authority as never,
    businessAdvisor: createBusinessAdvisorService(),
    now
  });
  const sourceVerifier = new FinancialCouncilSourceVerifier({
    cutoffIssuer,
    authority: authority as never,
    workspaceResolver: {
      async resolve(scope: { readonly ownerId: string;
        readonly teamId: string | null }) {
        return Object.freeze({
          workspaceId,
          kind: "team" as const,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          bindingRevision: "integration-workspace-v1"
        });
      }
    } as never,
    now
  });
  const model = new DeterministicFinancialCouncilModelPort(
    options.modelDelayMs ?? 0
  );
  const resolvePolicy = async () => Object.freeze({
    formulaPolicy: Object.freeze({
      formulaPolicyVersion: "financial-council-formula-policy.v1" as const,
      minimumProductMarginBps: 1_000,
      minimumCashReserveMinor:
        options.formulaMinimumCashReserveMinor ?? 900_000
    }),
    actionPolicy: Object.freeze({
      actionCoefficientVersion: "financial-council-actions.v1" as const,
      costRealizationBps: Object.freeze({
        conservative: 2_500, base: 5_000, optimistic: 7_500
      }),
      dataRiskReductionBps: Object.freeze({
        conservative: 500, base: 1_000, optimistic: 1_500
      }),
      taxRiskReductionBps: Object.freeze({
        conservative: 1_000, base: 2_000, optimistic: 3_000
      })
    })
  });
  const specialists = new FinancialCouncilSpecialistCoordinator({
    repository, model, resolvePolicy, now
  });
  const rebuttals = new FinancialCouncilRebuttalCoordinator({
    repository, model, now, validateOutput: (_role, output) => output
  });
  const analysis = new FinancialCouncilAnalysisWorker({
    repository,
    pipeline: new DefaultFinancialCouncilAnalysisPipeline({
      repository, specialists, rebuttals, resolvePolicy, now
    }),
    workerId: "council-integration-analysis", now,
    leaseTokenFactory: () => "1".repeat(64),
    logger: options.logger
  });
  const optimization = new FinancialCouncilOptimizationWorker({
    repository, policyRepository, cfo: model,
    workerId: "council-integration-optimizer", now,
    leaseTokenFactory: () => "2".repeat(64)
  });
  const pipeline = new FinancialCouncilPipelineWorker({
    analysis, optimization
  });
  const drafts = options.draftRepository
    ?? new InMemoryFinancialCouncilDraftRepository();
  const dispatch = createFinancialCouncilDispatchRuntime({
    repository, drafts,
    workerId: "council-integration-dispatch", now,
    leaseTokenFactory: () => "3".repeat(64)
  });
  const service = new FinancialCouncilService({
    repository, policyRepository, snapshotBuilder, sourceVerifier, now,
    advisoryWake: options.autoWake ? pipeline : undefined
  });
  return Object.freeze({
    repository, policyRepository, service, pipeline, dispatch, drafts,
    authorityReadHash() {
      return HASH(authorityAt(FINANCIAL_COUNCIL_INTEGRATION_AS_OF, workspaceId));
    },
    async close() {
      await dispatch.close();
      await pipeline.close();
    }
  });
}

export async function advanceFinancialCouncilToApproval(
  fixture: FinancialCouncilIntegrationFixture
): Promise<FinancialCouncilRun> {
  const workspace = financialCouncilIntegrationWorkspace();
  const initialPolicy = await fixture.service.getPolicy(workspace);
  const policy = await fixture.service.updatePolicy(
    financialCouncilIntegrationCommand("policy", initialPolicy.revision),
    financialCouncilIntegrationPolicyInput()
  );
  const created = await fixture.service.createRun(
    financialCouncilIntegrationCommand("create", null),
    {
      currency: "CNY", dataAsOf: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
      businessReport: completeFinancialCouncilIntegrationReport(),
      policyVersionId: policy.value.policyVersionId
    }
  );
  await fixture.pipeline.wake(created.value);
  return fixture.service.getRun(workspace, created.value.runId);
}

export function financialCouncilIntegrationPolicyInput() {
  return Object.freeze({
    currency: "CNY" as const,
    balancedWeightsBps: Object.freeze({
      cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000
    }),
    minimumCashReserveMinor: 0, dueDebtMinor: 0,
    necessaryOutflowMinor: 0, budgetLimitMinor: 1_000_000_000,
    capacityLimitUnits: 10_000, durationLimitDays: 365,
    minimumActionConfidenceBps: 6_000,
    actionCoefficientVersion: "financial-council-actions.v1"
  });
}
