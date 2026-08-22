import assert from "node:assert/strict";
import test from "node:test";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import { normalizeBusinessReport } from "./business-advisor/domain.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  financialCouncilAggregateHash,
  financialCouncilCanonicalHash,
  type FinancialCouncilRun,
  type FinancialSnapshotRecord
} from "./financial-council-domain.js";
import type {
  FinancialCouncilRepository,
  FinancialCouncilSpecialistPhase,
  FinancialCouncilSpecialistResult
} from "./financial-council-repository.js";
import {
  createFinancialCouncilPortfolioRevision,
  financialCouncilPortfolioCommandKeyHash,
  financialCouncilOptimizationRunHash
} from "./financial-council-repository.js";
import type {
  ConsensusReport,
  FinancialCouncilAgentRole,
  FinancialCouncilDataGap
} from "./growth-contract-types.js";
import type { FinancialCouncilVerifiedFactView } from
  "./financial-council-authority-reader.js";
import { FinancialSnapshotBuilder } from "./financial-council-snapshot.js";
import {
  FinancialFindingValidator,
  type AuthorizedFinancialCouncilSpecialistResult
} from "./financial-council-finding-validator.js";
import { buildCanonicalFinancialCouncilAuditGraph } from
  "./financial-council-audit.js";
import { FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS } from
  "./financial-portfolio-constraints.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import { buildConsensus } from "./financial-council-consensus.js";

const T0 = "2026-08-16T08:00:00.000Z";
export const T1 = "2026-08-16T08:01:00.000Z";
const T2 = "2026-08-16T08:02:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

export function repositoryRunFixture(
  overrides: Partial<FinancialCouncilRun> = {}
): FinancialCouncilRun {
  return Object.freeze({
    runId: "council-run-1",
    workspaceId: "ws-1",
    creationKeyHash: SHA_A,
    requestHash: SHA_B,
    currency: "CNY",
    status: "created",
    revision: 1,
    dataAsOf: "2026-08-15T00:00:00.000Z",
    businessReport: Object.freeze({
      currency: "CNY",
      companyName: "示例公司",
      period: "2026-07",
      balanceSheet: Object.freeze({
        period: "2026-07",
        cashMinor: 100_000,
        receivablesMinor: 20_000,
        inventoryMinor: 10_000,
        otherCurrentAssetsMinor: 5_000,
        nonCurrentAssetsMinor: 80_000,
        currentLiabilitiesMinor: 30_000,
        nonCurrentLiabilitiesMinor: 40_000,
        accountsPayableMinor: 12_000
      }),
      incomeStatement: Object.freeze({
        period: "2026-07",
        revenueMinor: 150_000,
        costOfGoodsSoldMinor: 70_000,
        operatingExpensesMinor: 30_000,
        interestExpenseMinor: 2_000,
        taxExpenseMinor: 5_000
      })
    }),
    policyVersionId: "policy-v1",
    snapshotId: null,
    snapshotHash: null,
    consensusReport: null,
    portfolios: Object.freeze([]),
    latestPortfolioRevision: null,
    approval: null,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: "2026-08-17T08:00:00.000Z",
    ...overrides
  });
}

export function workspace(workspaceId = "ws-1"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "manager-1",
    role: "manager",
    teamId: workspaceId,
    capabilities: Object.freeze([]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

export function command(
  key: string,
  workspaceId = "ws-1",
  expectedRevision: number | null = null,
  requestHash = `sha256:${"b".repeat(64)}`
): CommandContext {
  return Object.freeze({
    workspace: workspace(workspaceId),
    actorId: "manager-1",
    idempotencyKey: key,
    requestHash,
    expectedRevision
  });
}

export function snapshotFixture(
  run: FinancialCouncilRun,
  overrides: Partial<FinancialSnapshotRecord> = {}
): FinancialSnapshotRecord {
  const authorityProjection = Object.freeze({
    workspaceId: run.workspaceId,
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    projectionLevel: "redacted" as const,
    priorityCustomers: Object.freeze([]),
    pendingQuoteApprovals: Object.freeze([]),
    verifiedFinancialFacts: Object.freeze([]),
    expectedRoi: Object.freeze([]),
    actualRoi: Object.freeze([]),
    dataGaps: Object.freeze([])
  });
  const authorityHash = financialCouncilCanonicalHash(authorityProjection);
  const reportInputHash = financialCouncilCanonicalHash(run.businessReport);
  const identity = Object.freeze({
    runId: run.runId,
    workspaceId: run.workspaceId,
    dataAsOf: run.dataAsOf,
    currency: run.currency,
    report: Object.freeze(normalizeBusinessReport(run.businessReport)),
    reportInputHash,
    authority: Object.freeze({
      ...authorityProjection,
      sourceSnapshotHash: authorityHash
    }),
    formulaInputs: Object.freeze({
      indicators: Object.freeze({
        grossMarginBps: 5_333, netMarginBps: 2_867, roeBps: 2_966,
        roaBps: 2_000, debtRatioBps: 3_256, currentRatioBps: 45_000,
        quickRatioBps: 41_667, receivableTurnover: 7.5,
        inventoryTurnover: 7, interestCoverage: 25, receivableDays: 49,
        cashCoverageMonths: 15, cashCollectionRatioBps: 0,
        cashProfitRatioBps: 0, revenueMinor: 150_000,
        netProfitMinor: 43_000
      }),
      products: Object.freeze([]), customers: Object.freeze([]),
      cashflow: Object.freeze({
        status: "not_computable", reason: "cash_flow_missing"
      }),
      cost: Object.freeze({
        status: "not_computable", reason: "cost_detail_missing"
      }),
      tax: Object.freeze({
        status: "not_computable", reason: "tax_risk_missing"
      })
    }),
    dataGaps: Object.freeze([Object.freeze({
      code: "import_requires_review" as const,
      source: "business_report" as const,
      sourceId: null,
      description: "cash_flow_missing"
    }), Object.freeze({
      code: "import_requires_review" as const,
      source: "roi" as const,
      sourceId: null,
      description: "actual_roi_missing"
    }), Object.freeze({
      code: "import_requires_review" as const,
      source: "roi" as const,
      sourceId: null,
      description: "expected_roi_missing"
    })]),
    sourceRefs: Object.freeze([Object.freeze({
      kind: "business_report" as const,
      sourceId: "business-report",
      version: 1,
      contentHash: reportInputHash
    }), Object.freeze({
      kind: "crm" as const,
      sourceId: "growth-advisor-today",
      version: 1,
      contentHash: authorityHash
    })])
  });
  const snapshotId = financialCouncilCanonicalHash(identity);
  const preimage = Object.freeze({ snapshotId, ...identity });
  const hash = financialCouncilCanonicalHash(preimage);
  const snapshot = Object.freeze({ ...preimage, snapshotHash: hash });
  return Object.freeze({
    snapshotId,
    runId: run.runId,
    workspaceId: run.workspaceId,
    snapshotHash: hash,
    snapshot,
    createdAt: T1,
    ...overrides
  });
}

export async function builderSnapshotFixture(
  run: FinancialCouncilRun,
  verifiedFinancialFacts: readonly FinancialCouncilVerifiedFactView[] = []
): Promise<FinancialSnapshotRecord> {
  const authorityProjection = Object.freeze({
    workspaceId: run.workspaceId,
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    projectionLevel: "redacted" as const,
    priorityCustomers: Object.freeze([]),
    pendingQuoteApprovals: Object.freeze([]),
    verifiedFinancialFacts: Object.freeze([...verifiedFinancialFacts]),
    expectedRoi: Object.freeze([]),
    actualRoi: Object.freeze([]),
    dataGaps: Object.freeze([])
  });
  const authority = Object.freeze({
    ...authorityProjection,
    sourceSnapshotHash: financialCouncilCanonicalHash(authorityProjection)
  });
  const builder = new FinancialSnapshotBuilder({
    cutoffIssuer: {
      async sealTodayCutoff(context, effectiveAsOf) {
        return Object.freeze({
          workspaceId: context.workspaceId,
          effectiveAsOf,
          temporalSequence: 1
        }) as never;
      }
    },
    authority: { async readAt() { return authority; } },
    businessAdvisor: createBusinessAdvisorService(),
    now: () => "2026-08-16T09:00:00.000Z"
  });
  const snapshot = await builder.freeze(command(
    `builder-${run.runId}`, run.workspaceId, null, run.requestHash
  ), run.runId, {
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    businessReport: run.businessReport,
    policyVersionId: run.policyVersionId
  });
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    runId: run.runId,
    workspaceId: run.workspaceId,
    snapshotHash: snapshot.snapshotHash,
    snapshot: snapshot as unknown as Readonly<Record<string, unknown>>,
    createdAt: T1
  });
}

export function resignSnapshotRecord(
  record: FinancialSnapshotRecord,
  mutate: (snapshot: Record<string, unknown>) => Record<string, unknown>
): FinancialSnapshotRecord {
  const { snapshotHash: _oldHash, ...oldPreimage } = record.snapshot;
  const preimage = mutate(structuredClone(oldPreimage));
  const snapshotHash = financialCouncilCanonicalHash(preimage);
  const snapshot = Object.freeze({ ...preimage, snapshotHash });
  return Object.freeze({
    ...record,
    snapshotId: String(snapshot.snapshotId),
    runId: String(snapshot.runId),
    workspaceId: String(snapshot.workspaceId),
    snapshotHash,
    snapshot
  });
}

export function specialistResultFixture(
  run: FinancialCouncilRun,
  snapshot: FinancialSnapshotRecord,
  role: FinancialCouncilAgentRole = "finance",
  overrides: Partial<FinancialCouncilSpecialistResult> = {},
  phase: FinancialCouncilSpecialistPhase = "analyze"
): FinancialCouncilSpecialistResult {
  const findingId = `finding:${financialCouncilCanonicalHash({
    runId: run.runId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    role,
    slot: 1
  })}`;
  const outputHash = financialCouncilCanonicalHash({ role, phase, findingId });
  const modelJobId = `financial-council:${run.runId}:${role}:${phase}:1`;
  const resultId = financialCouncilCanonicalHash({
    workspaceId: run.workspaceId,
    runId: run.runId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    role,
    phase,
    attempt: 1,
    outputHash,
    modelJobId
  });
  const preimage = {
    resultId,
    workspaceId: run.workspaceId,
    runId: run.runId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    role,
    phase,
    attempt: 1,
    outputHash,
    modelBinding: {
      jobId: modelJobId,
      runId: run.runId,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      role,
      phase,
      attempt: 1,
      connectionId: "connection-1",
      credentialVersion: 1,
      provider: "openai" as const,
      model: "gpt-test",
      capabilitySnapshotHash: SHA_A,
      baseUrlFingerprint: "official-endpoint",
      promptVersion: `financial-council-${role}-${phase}.v1`,
      schemaVersion: "financial-council-specialist-output.v1",
      contentHash: SHA_A,
      promptHash: SHA_A,
      schemaHash: SHA_A
    },
    repaired: false,
    providerRequestId: null,
    findings: [{
      findingId,
      runId: run.runId,
      snapshotId: snapshot.snapshotId,
      agentRole: role,
      conclusion: role === "tax"
        ? "税务风险需专业人员复核" : "risk_hypothesis",
      evidenceRefs: [{
        source: "business_report" as const,
        sourceId: "business-report",
        contentHash: (snapshot.snapshot as {
          reportInputHash: `sha256:${string}`
        }).reportInputHash
      }],
      formulaRef: null,
      confidenceBps: 8_000,
      severity: "warning" as const,
      assumptions: [],
      missingData: [],
      candidateActionIds: []
    }],
    actions: [],
    createdAt: T2,
    ...overrides
  };
  const { resultHash: _ignored, ...stable } = preimage as typeof preimage & {
    resultHash?: `sha256:${string}`
  };
  return Object.freeze({
    ...stable,
    resultHash: financialCouncilCanonicalHash(stable)
  }) as FinancialCouncilSpecialistResult;
}

export function authorizeSpecialistResultFixture(
  run: FinancialCouncilRun,
  snapshot: FinancialSnapshotRecord,
  result: FinancialCouncilSpecialistResult = specialistResultFixture(
    run, snapshot
  )
): AuthorizedFinancialCouncilSpecialistResult {
  return fixtureFindingValidator(run, snapshot)
    .authorizeSpecialistResult(result);
}

function fixtureFindingValidator(
  run: FinancialCouncilRun,
  snapshot: FinancialSnapshotRecord
): FinancialFindingValidator {
  return new FinancialFindingValidator({
    run,
    snapshot: snapshot.snapshot,
    formulaPolicy: {
      formulaPolicyVersion: "financial-council-formula-policy.v1",
      minimumProductMarginBps: 1_000,
      minimumCashReserveMinor: 90_000
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
    now: () => T2
  });
}

export function authorizedSpecialistActionResultFixture(
  run: FinancialCouncilRun,
  snapshot: FinancialSnapshotRecord
): AuthorizedFinancialCouncilSpecialistResult {
  const validator = fixtureFindingValidator(run, snapshot);
  const projection = validator.project("finance");
  const formula = (projection.businessData as {
    formulas: Array<{
      refId: string;
      formulaId: string;
      evidenceRefIds: string[];
    }>;
  }).formulas.find((candidate) =>
    candidate.formulaId === "financial_data_gaps")!;
  const findingId = projection.allowlist.findingIds[0]!;
  const validated = validator.validate("finance", {
    findingDrafts: [{
      findingId,
      conclusion: "risk_hypothesis",
      evidenceRefs: [formula.evidenceRefIds[0]!],
      formulaRef: formula.refId,
      confidenceBps: 8_000,
      severity: "warning",
      assumptions: [],
      missingDataRefs: []
    }],
    actionHypotheses: [{
      kind: "complete_financial_data",
      sourceFindingIds: [findingId],
      subjectRef: null,
      explanation: "complete_financial_data_hypothesis"
    }]
  });
  const base = specialistResultFixture(run, snapshot);
  const resultId = financialCouncilCanonicalHash({
    workspaceId: run.workspaceId,
    runId: run.runId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    role: "finance",
    phase: "analyze",
    attempt: 1,
    outputHash: validated.outputHash,
    modelJobId: base.modelBinding.jobId
  });
  const { resultHash: _old, ...basePreimage } = base;
  const preimage = {
    ...basePreimage,
    resultId,
    outputHash: validated.outputHash,
    findings: validated.findings,
    actions: validated.actions
  };
  return validator.authorizeSpecialistResult({
    ...preimage,
    resultHash: financialCouncilCanonicalHash(preimage)
  });
}

function snapshotWithId(
  run: FinancialCouncilRun,
  _snapshotId: string
): FinancialSnapshotRecord {
  return snapshotFixture(run);
}

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: unknown }).code === code;
}

export async function storedConsensusFixture(
  repository: FinancialCouncilRepository,
  runOverrides: Partial<FinancialCouncilRun> = {}
): Promise<{
  readonly report: ConsensusReport;
  readonly findingId: string;
  readonly first: { readonly value: ConsensusReport; readonly replayed: boolean };
}> {
  const aggregate = repositoryRunFixture(runOverrides);
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("consensus"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  const result = authorizeSpecialistResultFixture(run, snapshot);
  await repository.storeSpecialistResult(workspace(), result);
  const graph = buildCanonicalFinancialCouncilAuditGraph({
    workspaceId: run.workspaceId, runId: run.runId,
    snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    facts: result.findings.map((finding) => ({ finding, actions: [] }))
  });
  const initial = result.findings.map((finding) => ({
    findingId: finding.findingId, role: finding.agentRole,
    status: "unresolved" as const, blockingConflictIds: []
  }));
  await repository.storeAuditGraph(workspace(), graph, initial);
  const dispositions = await repository.listFindingDispositions(
    workspace(), run.runId
  );
  const report = buildConsensus({
    graph, findings: result.findings, dispositions,
    dataGaps: snapshot.snapshot.dataGaps as readonly FinancialCouncilDataGap[],
    createdAt: T2
  });
  const first = await repository.storeConsensus(workspace(), report);
  return { report, findingId: result.findings[0]!.findingId, first };
}

function emptyPortfolio(
  runId: string,
  kind: "balanced" | "cash_first" | "growth_first"
) {
  return Object.freeze({
    portfolioId: financialCouncilCanonicalHash({ runId, revision: 1, kind }),
    runId,
    revision: 1,
    kind,
    actionIds: Object.freeze([]),
    actions: Object.freeze([]),
    hardConstraints: Object.freeze(
      FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS.map((code) => Object.freeze({
        code,
        satisfied: false,
        reason: "no_feasible_nonempty_portfolio"
      }))
    ),
    objectiveScoreBps: 0,
    scenarioForecast: Object.freeze({
      cashImpact: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
      profitImpact: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
      riskReductionBps: Object.freeze({ conservative: 0, base: 0,
        optimistic: 0 })
    }),
    sensitivityAnalysis: Object.freeze([]),
    rejectedActions: Object.freeze([]),
    requiredApprovalCapabilities: Object.freeze([]),
    expiresAt: "2026-08-17T08:00:00.000Z",
    createdAt: "2026-08-16T08:06:00.000Z"
  });
}

function actionablePortfolio(
  runId: string,
  kind: "balanced" | "cash_first" | "growth_first",
  action: ReturnType<typeof authorizedSpecialistActionResultFixture>["actions"][number]
) {
  return Object.freeze({
    ...emptyPortfolio(runId, kind),
    actionIds: Object.freeze([action.actionId]),
    actions: Object.freeze([action]),
    hardConstraints: Object.freeze(
      FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS.map((code) => Object.freeze({
        code, satisfied: true, reason: null
      }))
    ),
    objectiveScoreBps: 1_000,
    requiredApprovalCapabilities: action.requiredCapabilities
  });
}

export async function storedActionPortfolioRevisionFixture(
  repository: FinancialCouncilRepository
) {
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  let run = (await repository.createAndFreezeRun(command("approval-seed"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  const result = authorizedSpecialistActionResultFixture(run, snapshot);
  await repository.storeSpecialistResult(workspace(), result);
  const graph = buildCanonicalFinancialCouncilAuditGraph({
    workspaceId: run.workspaceId, runId: run.runId,
    snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    facts: result.findings.map((finding) => ({ finding,
      actions: result.actions.filter((action) =>
        action.sourceFindingIds.includes(finding.findingId)) }))
  });
  await repository.storeAuditGraph(workspace(), graph,
    result.findings.map((finding) => ({
      findingId: finding.findingId, role: finding.agentRole,
      status: "unresolved" as const, blockingConflictIds: []
    })));
  const report = buildConsensus({
    graph,
    findings: result.findings,
    dispositions: await repository.listFindingDispositions(
      workspace(), run.runId
    ),
    dataGaps: snapshot.snapshot.dataGaps as readonly FinancialCouncilDataGap[],
    createdAt: T2
  });
  await repository.storeConsensus(workspace(), report);
  const lease = (await repository.claimAnalysisRun({
    workspaceId: run.workspaceId,
    runId: run.runId,
    workerId: "approval-fixture-worker",
    leaseToken: "9".repeat(64),
    claimedAt: "2026-08-16T08:02:00.000Z",
    leaseExpiresAt: "2026-08-16T08:20:00.000Z"
  }))!;
  for (const [kind, occurredAt] of [
    ["analyzing", "2026-08-16T08:03:00.000Z"],
    ["auditing", "2026-08-16T08:04:00.000Z"],
    ["synthesizing", "2026-08-16T08:05:00.000Z"],
    ["optimizing", "2026-08-16T08:06:00.000Z"]
  ] as const) {
    run = (await repository.transitionRunWithLease(lease, {
      kind, occurredAt, reasonCode: null
    })).value;
  }
  const action = result.actions[0]!;
  const portfolios = Object.freeze([
    actionablePortfolio(run.runId, "balanced", action),
    actionablePortfolio(run.runId, "cash_first", action),
    actionablePortfolio(run.runId, "growth_first", action)
  ]);
  const revision = createFinancialCouncilPortfolioRevision({
    workspaceId: run.workspaceId,
    runId: run.runId,
    revision: 1,
    runHash: financialCouncilOptimizationRunHash(run),
    snapshotId: run.snapshotId!,
    snapshotHash: run.snapshotHash!,
    auditHash: graph.graphHash,
    policyVersionId: run.policyVersionId,
    policyHash: `sha256:${"7".repeat(64)}`,
    consensusReportId: report.reportId,
    candidateSetHash: financialCouncilCanonicalHash([action]),
    portfolios,
    createdAt: "2026-08-16T08:06:00.000Z"
  });
  await repository.storePortfolioRevision(revision, {
    lease, completedAt: "2026-08-16T08:06:00.000Z"
  });
  run = (await repository.publishPortfolioRevisionWithLease(lease, {
    revision: 1,
    expectedOutputHash: revision.outputHash,
    occurredAt: "2026-08-16T08:07:00.000Z"
  })).value;
  return { run, revision, snapshot, action };
}

export async function storedPortfolioRevisionFixture(
  repository: FinancialCouncilRepository,
  options: { readonly policyVersionId?: string } = {}
) {
  const { report } = await storedConsensusFixture(repository, options);
  const context = workspace();
  let run = (await repository.findRun(context, report.runId))!;
  const lease = (await repository.claimAnalysisRun({
    workspaceId: run.workspaceId,
    runId: run.runId,
    workerId: "optimizer-worker",
    leaseToken: "8".repeat(64),
    claimedAt: "2026-08-16T08:02:00.000Z",
    leaseExpiresAt: "2026-08-16T08:20:00.000Z"
  }))!;
  for (const [kind, occurredAt] of [
    ["analyzing", "2026-08-16T08:03:00.000Z"],
    ["auditing", "2026-08-16T08:04:00.000Z"],
    ["synthesizing", "2026-08-16T08:05:00.000Z"],
    ["optimizing", "2026-08-16T08:06:00.000Z"]
  ] as const) {
    run = (await repository.transitionRunWithLease(lease, {
      kind, occurredAt, reasonCode: null
    })).value;
  }
  const graph = (await repository.getAuditGraph(context, run.runId))!;
  const portfolios = Object.freeze([
    emptyPortfolio(run.runId, "balanced"),
    emptyPortfolio(run.runId, "cash_first"),
    emptyPortfolio(run.runId, "growth_first")
  ]);
  const input = {
    workspaceId: run.workspaceId,
    runId: run.runId,
    revision: 1,
    runHash: financialCouncilOptimizationRunHash(run),
    snapshotId: run.snapshotId!,
    snapshotHash: run.snapshotHash!,
    auditHash: graph.graphHash,
    policyVersionId: run.policyVersionId,
    policyHash: `sha256:${"7".repeat(64)}` as const,
    consensusReportId: report.reportId,
    candidateSetHash: financialCouncilCanonicalHash([]),
    portfolios,
    createdAt: "2026-08-16T08:06:00.000Z"
  } as const;
  const revision = createFinancialCouncilPortfolioRevision(input);
  const stored = await repository.storePortfolioRevision(revision, {
    lease, completedAt: "2026-08-16T08:06:00.000Z"
  });
  return { report, run, lease, revision, stored, input };
}

export function registerFinancialCouncilRepositoryContract(
  label: string,
  createRepository: () => Promise<FinancialCouncilRepository>
    | FinancialCouncilRepository
): void {
  test(`${label}: audit graph and initial dispositions commit atomically`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("audit"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const result = authorizeSpecialistResultFixture(run, snapshot);
    const graph = buildCanonicalFinancialCouncilAuditGraph({
      workspaceId: run.workspaceId, runId: run.runId,
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
      facts: result.findings.map((finding) => ({ finding,
        actions: result.actions.filter((action) =>
          action.sourceFindingIds.includes(finding.findingId)) }))
    });
    const initial = result.findings.map((finding) => ({
      findingId: finding.findingId, role: finding.agentRole,
      status: "unresolved" as const, blockingConflictIds: []
    }));

    const stored = await repository.storeAuditGraph(workspace(), graph, initial);
    const replay = await repository.storeAuditGraph(workspace(), graph, initial);

    assert.equal(stored.replayed, false);
    assert.equal(replay.replayed, true);
    await assert.rejects(repository.storeAuditGraph(workspace(), graph, [
      ...initial, { findingId: "changed-finding", role: "tax",
        status: "unresolved", blockingConflictIds: [] }
    ]), hasCode("financial_council_audit_conflict"));
    assert.deepEqual(await repository.getAuditGraph(
      workspace(), run.runId
    ), graph);
    assert.deepEqual((await repository.listFindingDispositions(
      workspace(), run.runId
    )).map((item) => [item.findingId, item.status]),
    [[result.findings[0]!.findingId, "unresolved"]]);
  });

  test(`${label}: canonical consensus replays by run snapshot and audit hash`, async () => {
    const repository = await createRepository();
    const { report, findingId, first } = await storedConsensusFixture(repository);
    const replay = await repository.storeConsensus(workspace(), report);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(await repository.getConsensus(
      workspace(), report.runId
    ), report);
    assert.equal(await repository.getConsensus(
      workspace("ws-2"), report.runId
    ), null);
    const changed = { ...report, overallDiagnosis:
      `${report.overallDiagnosis} [${findingId}]` };
    const { reportId: _old, ...preimage } = changed;
    await assert.rejects(repository.storeConsensus(workspace(), {
      ...preimage, reportId: financialCouncilCanonicalHash(preimage)
    }), hasCode("financial_council_consensus_conflict"));
  });

  test(`${label}: portfolio revision one binds every immutable optimizer input and replays exactly`, async () => {
    const repository = await createRepository();
    const { report, revision, stored, lease, input } =
      await storedPortfolioRevisionFixture(repository);
    const replay = await repository.storePortfolioRevision(revision, {
      lease, completedAt: "2026-08-16T08:06:30.000Z"
    });

    assert.equal(stored.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(await repository.getConsensus(
      workspace(), revision.runId
    ), report);
    assert.deepEqual(await repository.getPortfolioRevision(
      workspace(), revision.runId, 1
    ), revision);
    assert.equal(await repository.getPortfolioRevision(
      workspace("ws-2"), revision.runId, 1
    ), null);
    const changed = createFinancialCouncilPortfolioRevision({
      ...input, policyHash: `sha256:${"6".repeat(64)}`
    });
    await assert.rejects(repository.storePortfolioRevision(changed, {
      lease, completedAt: "2026-08-16T08:06:30.000Z"
    }),
      hasCode("financial_council_portfolio_conflict"));
  });

  test(`${label}: fenced publish attaches revision one and advances optimizing to awaiting approval`, async () => {
    const repository = await createRepository();
    const { report, lease, revision } = await storedPortfolioRevisionFixture(
      repository
    );

    const published = await repository.publishPortfolioRevisionWithLease(
      lease, {
        revision: 1,
        expectedOutputHash: revision.outputHash,
        occurredAt: "2026-08-16T08:07:00.000Z"
      }
    );

    assert.equal(published.value.status, "awaiting_approval");
    assert.equal(published.value.latestPortfolioRevision, 1);
    assert.deepEqual(published.value.consensusReport, report);
    assert.deepEqual(published.value.portfolios, revision.portfolios);
    assert.equal(published.value.revision, 7);
  });

  test(`${label}: edited portfolio revisions commit atomically and replay exactly`, async () => {
    const repository = await createRepository();
    const { lease, revision: first, input } =
      await storedPortfolioRevisionFixture(repository);
    const published = await repository.publishPortfolioRevisionWithLease(
      lease, { revision: 1, expectedOutputHash: first.outputHash,
        occurredAt: "2026-08-16T08:07:00.000Z" }
    );
    const requestHash = `sha256:${"3".repeat(64)}` as const;
    const operationsHash = `sha256:${"5".repeat(64)}` as const;
    const portfolios = first.portfolios.map((portfolio) => ({
      ...portfolio,
      portfolioId: financialCouncilCanonicalHash({
        prior: portfolio.portfolioId, revision: 2
      }),
      revision: 2,
      createdAt: "2026-08-16T08:08:00.000Z"
    }));
    const editCommand = command("edit-key", "ws-1",
      published.value.revision, requestHash);
    const commandKeyHash = financialCouncilPortfolioCommandKeyHash(editCommand);
    const second = createFinancialCouncilPortfolioRevision({
      ...input,
      revision: 2,
      baseRevision: 1,
      commandKeyHash,
      commandRequestHash: requestHash,
      operationsHash,
      portfolios,
      createdAt: "2026-08-16T08:08:00.000Z"
    });
    const committed = await repository.commitPortfolioRevision(editCommand, {
      revision: second
    });
    const replayed = await repository.commitPortfolioRevision(editCommand, {
      revision: second
    });

    assert.equal(committed.replayed, false);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(await repository.getPortfolioRevision(
      workspace(), first.runId, 2
    ), second);
    assert.equal((await repository.findRun(
      workspace(), first.runId
    ))!.latestPortfolioRevision, 2);
  });

  test(`${label}: stale or replaced optimization lease cannot store or publish`, async () => {
    const repository = await createRepository();
    const { report, lease, revision } =
      await storedPortfolioRevisionFixture(repository);
    const stale = hasCode("financial_council_lease_stale");

    await assert.rejects(repository.storeConsensus(workspace("ws-2"), report, {
      lease, completedAt: "2026-08-16T08:06:30.000Z"
    }), stale);
    await assert.rejects(repository.storeConsensus(workspace(), report, {
      lease, completedAt: lease.leaseExpiresAt
    }), stale);
    await assert.rejects(repository.storePortfolioRevision(revision, {
      lease, completedAt: lease.leaseExpiresAt
    }), stale);
    await assert.rejects(repository.publishPortfolioRevisionWithLease(lease, {
      revision: 1,
      expectedOutputHash: revision.outputHash,
      occurredAt: lease.leaseExpiresAt
    }), stale);
  });

  test(`${label}: synthesizing and optimizing runs are recoverable after lease release`, async () => {
    for (const target of ["synthesizing", "optimizing"] as const) {
      const repository = await createRepository();
      const aggregate = repositoryRunFixture({ runId: `recover-${target}` });
      const run = (await repository.createAndFreezeRun(command(
        `recover-${target}`
      ), {
        aggregate,
        snapshot: snapshotFixture(aggregate),
        occurredAt: T1
      })).value;
      const lease = (await repository.claimAnalysisRun({
        workspaceId: run.workspaceId,
        runId: run.runId,
        workerId: "worker-a",
        leaseToken: "5".repeat(64),
        claimedAt: "2026-08-16T08:02:00.000Z",
        leaseExpiresAt: "2026-08-16T08:20:00.000Z"
      }))!;
      const path = target === "synthesizing"
        ? ["analyzing", "auditing", "synthesizing"] as const
        : ["analyzing", "auditing", "synthesizing", "optimizing"] as const;
      for (let index = 0; index < path.length; index += 1) {
        await repository.transitionRunWithLease(lease, {
          kind: path[index]!,
          occurredAt: `2026-08-16T08:0${index + 3}:00.000Z`,
          reasonCode: null
        });
      }
      await repository.releaseAnalysisLease(
        lease, "2026-08-16T08:10:00.000Z"
      );

      assert.deepEqual((await repository.listRecoverableAnalysisRuns(
        "2026-08-16T08:11:00.000Z", 10
      )).map((candidate) => candidate.runId), [run.runId]);
      assert.ok(await repository.claimAnalysisRun({
        workspaceId: run.workspaceId,
        runId: run.runId,
        workerId: "worker-b",
        leaseToken: "6".repeat(64),
        claimedAt: "2026-08-16T08:11:00.000Z",
        leaseExpiresAt: "2026-08-16T08:30:00.000Z"
      }));
    }
  });

  test(`${label}: round-one rebuttal reserves before completion and replays exactly`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("rebut-store"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const base = authorizeSpecialistResultFixture(run, snapshot);
    const original = base.findings[0]!;
    const peer = { ...original, findingId: "finding-peer", agentRole: "profit" as const,
      formulaRef: { formulaVersion: "ratio.v1",
        inputHash: SHA_A, resultHash: SHA_B } };
    const own = { ...original, formulaRef: { formulaVersion: "ratio.v1",
      inputHash: SHA_A, resultHash: `sha256:${"c".repeat(64)}` as const } };
    const graph = buildCanonicalFinancialCouncilAuditGraph({
      workspaceId: run.workspaceId, runId: run.runId,
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
      facts: [{ finding: own, actions: [] }, { finding: peer, actions: [] }]
    });
    await repository.storeAuditGraph(workspace(), graph, [
      { findingId: own.findingId, role: own.agentRole, status: "unresolved",
        blockingConflictIds: [graph.edges[0]!.edgeId] },
      { findingId: peer.findingId, role: peer.agentRole, status: "unresolved",
        blockingConflictIds: [graph.edges[0]!.edgeId] }
    ]);
    const modelInput = {
      ownerId: "owner-1", teamId: "ws-1", runId: run.runId,
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
      role: "finance" as const, attempt: 1,
      allowlist: { evidenceRefIds: [], formulaRefIds: [],
        findingIds: [own.findingId], subjectRefs: [], dataGapRefs: [] },
      businessData: {}, targetFindingId: own.findingId,
      conflictData: { edgeId: graph.edges[0]!.edgeId }
    };
    const identity = { workspaceId: run.workspaceId, runId: run.runId,
      graphId: graph.graphId, role: "finance" as const, round: 1 as const,
      edgeId: graph.edges[0]!.edgeId, targetFindingId: own.findingId };
    const reservationPreimage = {
      attemptId: financialCouncilCanonicalHash(identity), ...identity,
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
      inputHash: financialCouncilCanonicalHash(modelInput), input: modelInput,
      status: "reserved" as const, result: null, outputHash: null,
      createdAt: T2, completedAt: null
    };
    const reservation = { ...reservationPreimage,
      attemptHash: financialCouncilCanonicalHash(reservationPreimage) };
    assert.equal((await repository.reserveRebuttalAttempt(
      workspace(), reservation
    )).replayed, false);
    assert.equal((await repository.reserveRebuttalAttempt(
      workspace(), reservation
    )).replayed, true);

    const value = { decision: "withdraw" as const,
      findingId: own.findingId, evidenceRefs: [], replacement: null,
      explanation: "finding_rebuttal" };
    const content = buildFinancialCouncilModelContent("rebut", modelInput);
    const result = { value, repaired: false, providerRequestId: null,
      binding: { jobId: content.jobId,
        runId: run.runId, snapshotId: snapshot.snapshotId,
        snapshotHash: snapshot.snapshotHash, role: "finance" as const,
        phase: "rebut" as const, attempt: 1, connectionId: "connection-1",
        credentialVersion: 1, provider: "openai" as const, model: "gpt-test",
        capabilitySnapshotHash: SHA_A, baseUrlFingerprint: "official",
        promptVersion: "financial-council-finance-rebut.v1",
        schemaVersion: "financial-council-specialist-output.v1",
        contentHash: content.contentHash, promptHash: content.promptHash,
        schemaHash: content.schemaHash } };
    const completion = { attemptId: reservation.attemptId,
      inputHash: reservation.inputHash, result, completedAt: T2,
      disposition: { status: "withdrawn" as const, blockingConflictIds: [] } };
    await assert.rejects(repository.completeRebuttalAttempt(workspace(), {
      ...completion, result: { ...result, binding: { ...result.binding,
        contentHash: SHA_A } }
    }), hasCode("financial_council_rebuttal_invalid"));
    assert.equal((await repository.completeRebuttalAttempt(
      workspace(), completion
    )).replayed, false);
    assert.equal((await repository.completeRebuttalAttempt(
      workspace(), completion
    )).replayed, true);
    await assert.rejects(repository.completeRebuttalAttempt(workspace(), {
      ...completion, result: { ...result, value: { ...value,
        decision: "uphold" as const } }
    }), hasCode("financial_council_rebuttal_conflict"));
    assert.equal((await repository.listRebuttalAttempts(
      workspace(), run.runId
    )).length, 1);
    assert.equal((await repository.listFindingDispositions(
      workspace(), run.runId
    )).find((item) => item.findingId === own.findingId)?.status, "withdrawn");
  });

  test(`${label}: verified snapshot read returns one run-bound aggregate`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("verified"), {
      aggregate, snapshot, occurredAt: T1
    })).value;

    const verified = await repository.getVerifiedRunSnapshot(
      workspace(), run.runId
    );

    assert.equal(verified?.run.runId, run.runId);
    assert.equal(verified?.snapshot.snapshotId, snapshot.snapshotId);
    assert.equal(verified?.snapshot.snapshotHash, snapshot.snapshotHash);
    assert.equal(await repository.getVerifiedRunSnapshot(
      workspace("ws-2"), run.runId
    ), null);
  });

  test(`${label}: a fully rehashed direct specialist DTO has no store authority`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command(
      "untrusted-specialist-dto"
    ), { aggregate, snapshot, occurredAt: T1 })).value;
    const forged = specialistResultFixture(run, snapshot);

    await assert.rejects(
      repository.storeSpecialistResult(workspace(), forged),
      hasCode("financial_council_specialist_result_invalid")
    );
    assert.deepEqual(await repository.listSpecialistResults(
      workspace(), run.runId
    ), []);
  });

  test(`${label}: specialist results replay exactly and five roles bind one snapshot`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("specialist"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const roles = ["finance", "profit", "cost", "cashflow", "tax"] as const;
    for (const role of roles) {
      const result = authorizeSpecialistResultFixture(
        run, snapshot, specialistResultFixture(run, snapshot, role)
      );
      const first = await repository.storeSpecialistResult(
        workspace(), result
      );
      const replay = await repository.storeSpecialistResult(
        workspace(), result
      );
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.value, first.value);
    }
    const listed = await repository.listSpecialistResults(
      workspace(), run.runId
    );
    assert.deepEqual(listed.map((result) => result.role), roles);
    assert.equal(new Set(listed.map((result) => result.snapshotHash)).size, 1);
    assert.equal((await repository.getSpecialistResult(
      workspace(), run.runId, "cashflow", "analyze"
    ))?.role, "cashflow");
  });

  test(`${label}: analyze and rebut child records stay phase isolated`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("phases"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const analyze = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot)
    );
    const rebut = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(
        run, snapshot, "finance", {}, "rebut"
      )
    );

    await repository.storeSpecialistResult(workspace(), analyze);
    await repository.storeSpecialistResult(workspace(), rebut);

    assert.deepEqual(await repository.getSpecialistResult(
      workspace(), run.runId, "finance", "analyze"
    ), analyze);
    assert.deepEqual(await repository.getSpecialistResult(
      workspace(), run.runId, "finance", "rebut"
    ), rebut);
  });

  test(`${label}: altered specialist replay conflicts without partial visibility`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("changed"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const original = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot)
    );
    await repository.storeSpecialistResult(workspace(), original);
    const changed = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot, "finance", {
        repaired: true
      })
    );

    await assert.rejects(
      repository.storeSpecialistResult(workspace(), changed),
      hasCode("financial_council_specialist_conflict")
    );
    const listed = await repository.listSpecialistResults(
      workspace(), run.runId
    );
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], original);
  });

  test(`${label}: validator-issued specialist result identities are role unique`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("result-id"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const finance = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot, "finance")
    );
    const profit = authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot, "profit")
    );

    await repository.storeSpecialistResult(workspace(), finance);
    await repository.storeSpecialistResult(workspace(), profit);
    assert.notEqual(finance.resultId, profit.resultId);
    assert.deepEqual((await repository.listSpecialistResults(
      workspace(), run.runId
    )).map((result) => result.resultId), [finance.resultId, profit.resultId]);
  });

  test(`${label}: specialist parser rejects open and cross-snapshot records`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("closed"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const base = specialistResultFixture(run, snapshot);
    const open = { ...base, hiddenMoneyMinor: 999_999 };
    const nested = structuredClone(base) as unknown as {
      findings: Array<Record<string, unknown>>;
      resultHash: string;
    };
    nested.findings[0]!.hidden = true;
    const { resultHash: _old, ...nestedPreimage } = nested;
    nested.resultHash = financialCouncilCanonicalHash(nestedPreimage);
    const crossSnapshot = specialistResultFixture(run, snapshot, "finance", {
      snapshotHash: SHA_A
    });
    const crossRole = structuredClone(base) as unknown as {
      findings: Array<Record<string, unknown>>;
      resultHash: string;
    };
    crossRole.findings[0]!.agentRole = "profit";
    const { resultHash: _roleHash, ...crossRolePreimage } = crossRole;
    crossRole.resultHash = financialCouncilCanonicalHash(crossRolePreimage);
    const crossRun = structuredClone(base) as unknown as {
      actions: Array<Record<string, unknown>>;
      findings: Array<Record<string, unknown>>;
      resultHash: string;
    };
    const actionId = `sha256:${"d".repeat(64)}`;
    crossRun.actions = [{
      actionId,
      kind: "complete_financial_data",
      sourceFindingIds: ["finding-from-another-run"],
      ownerRole: "finance",
      subjectRef: null,
      explanation: "complete_financial_data_hypothesis",
      durationDays: 14,
      prerequisites: ["formula:test"],
      mutuallyExclusiveWith: [],
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 500, base: 1_000, optimistic: 1_500 },
      budgetCostMinor: 0,
      capacityUnits: 1,
      confidenceBps: 9_000,
      requiredCapabilities: [],
      requiresHumanApproval: true
    }];
    crossRun.findings[0]!.candidateActionIds = [actionId];
    const { resultHash: _crossRunHash, ...crossRunPreimage } = crossRun;
    crossRun.resultHash = financialCouncilCanonicalHash(crossRunPreimage);
    for (const invalid of [open, nested, crossSnapshot, crossRole, crossRun]) {
      await assert.rejects(
        repository.storeSpecialistResult(
          workspace(), invalid as FinancialCouncilSpecialistResult
        ),
        hasCode("financial_council_specialist_result_invalid")
      );
    }
    await assert.rejects(
      repository.storeSpecialistResult(workspace("ws-2"), base),
      hasCode("financial_council_specialist_result_invalid")
    );
    assert.deepEqual(await repository.listSpecialistResults(
      workspace(), run.runId
    ), []);
  });

  test(`${label}: specialist parser rejects a forged cross-role tax action`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("forged-action"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const base = specialistResultFixture(run, snapshot, "finance");
    const actionId = financialCouncilCanonicalHash({ forgedTaxAction: true });
    const findings = [{
      ...base.findings[0]!, candidateActionIds: [actionId]
    }];
    const actions = [{
      actionId,
      kind: "schedule_tax_review" as const,
      sourceFindingIds: [findings[0]!.findingId],
      ownerRole: "finance" as const,
      subjectRef: null,
      explanation: "已合规，可直接申报",
      durationDays: 14,
      prerequisites: ["formula:forged"],
      mutuallyExclusiveWith: [],
      cashImpact: { conservative: 1, base: 2, optimistic: 3 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 1_000, base: 2_000, optimistic: 3_000 },
      budgetCostMinor: 0,
      capacityUnits: 1,
      confidenceBps: 6_000,
      requiredCapabilities: [],
      requiresHumanApproval: true as const
    }];
    const { resultHash: _old, ...oldPreimage } = base;
    const preimage = { ...oldPreimage, findings, actions };
    const forged = {
      ...preimage, resultHash: financialCouncilCanonicalHash(preimage)
    } as FinancialCouncilSpecialistResult;

    await assert.rejects(
      repository.storeSpecialistResult(workspace(), forged),
      hasCode("financial_council_specialist_result_invalid")
    );
    assert.deepEqual(await repository.listSpecialistResults(
      workspace(), run.runId
    ), []);
  });

  test(`${label}: specialist persistence rejects future creation time`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture({
      expiresAt: "9999-12-31T23:59:59.999Z"
    });
    const snapshot = snapshotFixture(aggregate);
    const run = (await repository.createAndFreezeRun(command("future-result"), {
      aggregate, snapshot, occurredAt: T1
    })).value;
    const future = specialistResultFixture(run, snapshot, "finance", {
      createdAt: "9999-12-31T23:59:58.000Z"
    });

    await assert.rejects(
      repository.storeSpecialistResult(workspace(), future),
      hasCode("financial_council_specialist_result_invalid")
    );
    assert.deepEqual(await repository.listSpecialistResults(
      workspace(), run.runId
    ), []);
  });

  test(`${label}: run validation uses canonical report and policy boundaries`, async () => {
    const acceptedRepository = await createRepository();
    const accepted = repositoryRunFixture({
      policyVersionId: "💰".repeat(255),
      businessReport: {
        ...repositoryRunFixture().businessReport,
        companyName: "💰".repeat(4_000)
      }
    });
    await assert.doesNotReject(acceptedRepository.createRun(
      command("canonical-boundary"), accepted
    ));

    const invalid = [
      repositoryRunFixture({
        businessReport: {
          ...repositoryRunFixture().businessReport,
          companyName: "💰".repeat(4_001)
        }
      }),
      repositoryRunFixture({
        businessReport: {
          ...repositoryRunFixture().businessReport,
          balanceSheet: {
            ...repositoryRunFixture().businessReport.balanceSheet,
            cashMinor: -1
          }
        }
      }),
      repositoryRunFixture({
        businessReport: {
          ...repositoryRunFixture().businessReport,
          incomeStatement: {
            ...repositoryRunFixture().businessReport.incomeStatement,
            customers: Array.from({ length: 101 }, (_, index) => ({
              name: `customer-${index}`,
              revenueMinor: 1,
              grossProfitMinor: 0,
              serviceCostMinor: 0,
              paymentDays: 0,
              outstandingReceivableMinor: 0
            }))
          }
        }
      }),
      repositoryRunFixture({
        businessReport: {
          ...repositoryRunFixture().businessReport,
          costDetail: {
            materialCostRateBps: 10_001,
            laborCostMinor: 0,
            rawMaterialCostMinor: 0,
            salesCommissionRateBps: 0,
            fixedOverheadMinor: 0
          }
        }
      }),
      repositoryRunFixture({ policyVersionId: "💰".repeat(256) })
    ];
    for (const [index, run] of invalid.entries()) {
      const repository = await createRepository();
      await assert.rejects(
        repository.createRun(command(`canonical-invalid-${index}`), run),
        hasCode("financial_council_input_invalid")
      );
    }
  });

  test(`${label}: compound create rejects re-signed run-bound provenance`, async () => {
    const mutations = [
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        reportInputHash: `sha256:${"e".repeat(64)}`,
        sourceRefs: (snapshot.sourceRefs as Array<Record<string, unknown>>)
          .map((row) => row.kind === "business_report"
            ? { ...row, contentHash: `sha256:${"e".repeat(64)}` }
            : row)
      }),
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        report: {
          ...(snapshot.report as Record<string, unknown>),
          grossProfitMinor: Number(
            (snapshot.report as Record<string, unknown>).grossProfitMinor
          ) + 1
        }
      }),
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        formulaInputs: {
          ...(snapshot.formulaInputs as Record<string, unknown>),
          indicators: {
            ...((snapshot.formulaInputs as Record<string, unknown>)
              .indicators as Record<string, unknown>),
            revenueMinor: 1
          }
        }
      }),
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        dataGaps: []
      }),
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        snapshotId: `sha256:${"f".repeat(64)}`
      })
    ];
    for (const [index, mutate] of mutations.entries()) {
      const repository = await createRepository();
      const aggregate = repositoryRunFixture({
        runId: `provenance-run-${index}`,
        creationKeyHash: `sha256:${(index + 1).toString(16).repeat(64)}`,
        requestHash: `sha256:${(index + 9).toString(16).repeat(64)}`
      });
      const record = resignSnapshotRecord(
        await builderSnapshotFixture(aggregate), mutate
      );
      await assert.rejects(repository.createAndFreezeRun(command(
        `provenance-${index}`, "ws-1", null, aggregate.requestHash
      ), {
        aggregate,
        snapshot: record,
        occurredAt: T1
      }), hasCode("financial_council_input_invalid"));
    }
  });

  test(`${label}: compound create freezes atomically and exact replay is inert`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    const first = await repository.createAndFreezeRun(command("create"), {
      aggregate,
      snapshot,
      occurredAt: T1
    });
    const replay = await repository.createAndFreezeRun(
      command("replay", "ws-1", null, aggregate.requestHash),
      {
        aggregate: repositoryRunFixture({ runId: "ignored-replay-run" }),
        snapshot: snapshotFixture(repositoryRunFixture({
          runId: "ignored-replay-run"
        })),
        occurredAt: T1
      }
    );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, first.value);
    assert.deepEqual(
      [first.value.status, first.value.revision, first.value.snapshotId],
      ["snapshot_frozen", 2, snapshot.snapshotId]
    );
    assert.deepEqual(
      (await repository.listEvents(workspace(), aggregate.runId))
        .map((event) => [event.revision, event.toStatus]),
      [[1, "created"], [2, "snapshot_frozen"]]
    );
  });

  test(`${label}: exact compound replay returns the verified progressed aggregate`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = snapshotFixture(aggregate);
    await repository.createAndFreezeRun(command("progress-create"), {
      aggregate, snapshot, occurredAt: T1
    });
    const progressed = (await repository.transitionRun(
      command("progress", "ws-1", 2), {
        runId: aggregate.runId,
        kind: "analyzing",
        occurredAt: T2,
        reasonCode: null
      }
    )).value;
    const replayAggregate = repositoryRunFixture({ runId: "ignored-progress" });
    const replay = await repository.createAndFreezeRun(command(
      "progress-replay", "ws-1", null, aggregate.requestHash
    ), {
      aggregate: replayAggregate,
      snapshot: snapshotFixture(replayAggregate),
      occurredAt: T1
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, progressed);
    assert.deepEqual(
      (await repository.listEvents(workspace(), aggregate.runId))
        .map((event) => event.revision),
      [1, 2, 3]
    );
    await assert.rejects(repository.createAndFreezeRun(command(
      "progress-conflict", "ws-1", null, SHA_A
    ), {
      aggregate: repositoryRunFixture({
        runId: "changed-progress", requestHash: SHA_A
      }),
      snapshot: snapshotFixture(repositoryRunFixture({
        runId: "changed-progress", requestHash: SHA_A
      })),
      occurredAt: T1
    }), hasCode("financial_council_idempotency_conflict"));
  });

  test(`${label}: compound create conflict and invalid snapshot leave zero visible writes`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const valid = snapshotFixture(aggregate);
    const tamperedSnapshot = {
      ...valid.snapshot,
      runId: "another-run"
    };
    await assert.rejects(repository.createAndFreezeRun(command("invalid"), {
      aggregate,
      snapshot: {
        ...valid,
        snapshot: tamperedSnapshot
      },
      occurredAt: T1
    }), hasCode("financial_council_input_invalid"));
    assert.equal(await repository.findRun(workspace(), aggregate.runId), null);
    assert.deepEqual(await repository.listEvents(workspace(), aggregate.runId), []);

    await repository.createAndFreezeRun(command("first"), {
      aggregate,
      snapshot: valid,
      occurredAt: T1
    });
    const changedHash = `sha256:${"c".repeat(64)}` as const;
    const changed = repositoryRunFixture({
      runId: "changed-run",
      requestHash: changedHash
    });
    await assert.rejects(repository.createAndFreezeRun(
      command("changed", "ws-1", null, changedHash),
      {
        aggregate: changed,
        snapshot: snapshotFixture(changed),
        occurredAt: T1
      }
    ), hasCode("financial_council_idempotency_conflict"));
    assert.equal(await repository.findRun(workspace(), changed.runId), null);
    assert.deepEqual(await repository.listEvents(workspace(), changed.runId), []);
  });

  test(`${label}: concurrent compound create has one writer and one exact replay`, async () => {
    const repository = await createRepository();
    const aggregate = repositoryRunFixture();
    const attempts = await Promise.all([
      repository.createAndFreezeRun(command("first"), {
        aggregate,
        snapshot: snapshotFixture(aggregate),
        occurredAt: T1
      }),
      repository.createAndFreezeRun(command("second"), {
        aggregate: repositoryRunFixture({ runId: "loser-run" }),
        snapshot: snapshotFixture(repositoryRunFixture({ runId: "loser-run" })),
        occurredAt: T1
      })
    ]);
    assert.deepEqual(attempts.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(new Set(attempts.map((result) => result.value.runId)).size, 1);
    assert.equal((await repository.listEvents(
      workspace(), aggregate.runId
    )).length, 2);
    assert.equal(await repository.findRun(workspace(), "loser-run"), null);
  });

  test(`${label}: runnable enumeration is bounded, deterministic and status closed`, async () => {
    const repository = await createRepository();
    for (const [index, runId] of ["run-b", "run-a", "run-c"].entries()) {
      const requestHash = `sha256:${String(index + 1).repeat(64)}` as const;
      const creationKeyHash = `sha256:${String(index + 4).repeat(64)}` as const;
      const aggregate = repositoryRunFixture({
        runId, requestHash, creationKeyHash,
        createdAt: `2026-08-16T08:00:0${index}.000Z`,
        updatedAt: `2026-08-16T08:00:0${index}.000Z`
      });
      await repository.createAndFreezeRun(
        command(`create-${runId}`, "ws-1", null, requestHash),
        {
          aggregate,
          snapshot: snapshotWithId(aggregate, `snapshot-${runId}`),
          occurredAt: T1
        }
      );
    }
    await repository.transitionRun(command("advance-b", "ws-1", 2), {
      runId: "run-b", kind: "analyzing", occurredAt: T2, reasonCode: null
    });
    const crossWorkspace = repositoryRunFixture({
      workspaceId: "ws-2",
      runId: "run-a",
      requestHash: `sha256:${"8".repeat(64)}`,
      creationKeyHash: `sha256:${"9".repeat(64)}`
    });
    await repository.createAndFreezeRun(
      command("create-cross", "ws-2", null, crossWorkspace.requestHash),
      {
        aggregate: crossWorkspace,
        snapshot: snapshotWithId(crossWorkspace, "snapshot-cross"),
        occurredAt: T1
      }
    );
    const first = await repository.listRunnableRuns({ after: null, limit: 2 });
    const second = await repository.listRunnableRuns({
      after: {
        workspaceId: first.at(-1)!.workspaceId,
        runId: first.at(-1)!.runId
      },
      limit: 2
    });
    assert.deepEqual(first.map((run) => [run.workspaceId, run.runId]), [
      ["ws-1", "run-a"], ["ws-1", "run-c"]
    ]);
    assert.deepEqual(second.map((run) => [run.workspaceId, run.runId]), [
      ["ws-2", "run-a"]
    ]);
    await assert.rejects(
      repository.listRunnableRuns({ after: null, limit: 0 }),
      hasCode("financial_council_input_invalid")
    );
  });

  test(`${label}: composite cursor uses UTF-8 byte order without skipping`, async () => {
    const repository = await createRepository();
    const identities = [
      ["a", "a"], ["B", "z"], ["B", "A"], ["é", "run"], ["中", "run"],
      ["\u{10000}", "run"], ["\uE000", "run"]
    ] as const;
    for (const [index, [workspaceId, runId]] of identities.entries()) {
      const aggregate = repositoryRunFixture({
        workspaceId,
        runId,
        creationKeyHash: `sha256:${index.toString(16).repeat(64)}`,
        requestHash: `sha256:${(index + 8).toString(16).repeat(64)}`
      });
      await repository.createAndFreezeRun(command(
        `code-unit-${index}`, workspaceId, null, aggregate.requestHash
      ), {
        aggregate,
        snapshot: snapshotWithId(aggregate, `snapshot-${index}`),
        occurredAt: T1
      });
    }
    const seen: Array<readonly [string, string]> = [];
    let after: { workspaceId: string; runId: string } | null = null;
    for (;;) {
      const page = await repository.listRunnableRuns({ after, limit: 1 });
      if (page.length === 0) break;
      const run = page[0]!;
      seen.push([run.workspaceId, run.runId]);
      after = { workspaceId: run.workspaceId, runId: run.runId };
    }
    assert.deepEqual(seen, [
      ["B", "A"], ["B", "z"], ["a", "a"], ["é", "run"], ["中", "run"],
      ["\uE000", "run"], ["\u{10000}", "run"]
    ]);
  });

  test(`${label}: re-signed open or nested-open snapshots are rejected`, async () => {
    const repository = await createRepository();
    for (const [index, mutate] of [
      (snapshot: Record<string, unknown>) => ({ ...snapshot, hidden: true }),
      (snapshot: Record<string, unknown>) => ({
        ...snapshot,
        authority: { ...(snapshot.authority as object), hidden: true }
      })
    ].entries()) {
      const aggregate = repositoryRunFixture({
        runId: `open-snapshot-${index}`,
        creationKeyHash: `sha256:${(index + 5).toString(16).repeat(64)}`,
        requestHash: `sha256:${(index + 7).toString(16).repeat(64)}`
      });
      const base = snapshotWithId(aggregate, `open-snapshot-id-${index}`);
      const { snapshotHash: _old, ...identity } = base.snapshot;
      const changed = mutate(identity);
      const snapshotHash = financialCouncilCanonicalHash(changed);
      await assert.rejects(repository.createAndFreezeRun(command(
        `open-${index}`, "ws-1", null, aggregate.requestHash
      ), {
        aggregate,
        snapshot: {
          ...base,
          snapshotHash,
          snapshot: { ...changed, snapshotHash }
        },
        occurredAt: T1
      }), hasCode("financial_council_input_invalid"));
    }
  });

  test(`${label}: duplicate create replays exactly and isolates workspaces`, async () => {
    const repository = await createRepository();
    const initial = repositoryRunFixture();
    const first = await repository.createRun(command("create-1"), initial);
    const replay = await repository.createRun(
      command("create-replay", "ws-1", null, initial.requestHash),
      repositoryRunFixture({ runId: "ignored-replay-id" })
    );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, first.value);
    assert.equal(await repository.findRun(workspace("ws-2"), initial.runId), null);
    assert.deepEqual(
      await repository.listEvents(workspace("ws-2"), initial.runId), []
    );
  });

  test(`${label}: changed request under the creation key is a stable conflict`, async () => {
    const repository = await createRepository();
    const initial = repositoryRunFixture();
    await repository.createRun(command("create-1"), initial);
    await assert.rejects(repository.createRun(
      command("changed", "ws-1", null, `sha256:${"c".repeat(64)}`),
      repositoryRunFixture({ requestHash: `sha256:${"c".repeat(64)}` })
    ), hasCode("financial_council_idempotency_conflict"));
  });

  test(`${label}: a concurrent transition has one revision winner`, async () => {
    const repository = await createRepository();
    const created = (await repository.createRun(
      command("create-1"), repositoryRunFixture()
    )).value;
    const snapshot = snapshotFixture(created);
    const frozen = await repository.storeFrozenSnapshot(
      command("freeze", "ws-1", 1),
      { runId: created.runId, snapshot, occurredAt: T1 }
    );
    const attempts = await Promise.allSettled([
      repository.transitionRun(command("advance-a", "ws-1", 2), {
        runId: created.runId,
        kind: "analyzing",
        occurredAt: T2,
        reasonCode: null
      }),
      repository.transitionRun(command("advance-b", "ws-1", 2), {
        runId: created.runId,
        kind: "analyzing",
        occurredAt: T2,
        reasonCode: null
      })
    ]);
    assert.equal(frozen.value.revision, 2);
    assert.equal(attempts.filter((row) => row.status === "fulfilled").length, 1);
    const rejected = attempts.find((row) => row.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    assert.equal(
      (rejected as PromiseRejectedResult).reason.code,
      "financial_council_revision_conflict"
    );
  });

  test(`${label}: event revisions are contiguous and hash canonical snapshots`, async () => {
    const repository = await createRepository();
    const created = (await repository.createRun(
      command("create-1"), repositoryRunFixture()
    )).value;
    await repository.storeFrozenSnapshot(command("freeze", "ws-1", 1), {
      runId: created.runId,
      snapshot: snapshotFixture(created),
      occurredAt: T1
    });
    await repository.transitionRun(command("advance", "ws-1", 2), {
      runId: created.runId,
      kind: "analyzing",
      occurredAt: T2,
      reasonCode: null
    });
    const events = await repository.listEvents(workspace(), created.runId);
    assert.deepEqual(events.map((event) => event.revision), [1, 2, 3]);
    for (const event of events) {
      assert.equal(
        event.aggregateSnapshotHash,
        financialCouncilAggregateHash(event.aggregateSnapshot)
      );
      assert.equal(event.aggregateSnapshot.revision, event.revision);
      assert.equal(event.aggregateSnapshot.status, event.toStatus);
    }
  });

  test(`${label}: exact current revision and legal state are both required`, async () => {
    const repository = await createRepository();
    const created = (await repository.createRun(
      command("create-1"), repositoryRunFixture()
    )).value;
    await assert.rejects(repository.transitionRun(
      command("wrong-revision", "ws-1", 2),
      { runId: created.runId, kind: "failed", occurredAt: T1, reasonCode: null }
    ), hasCode("financial_council_revision_conflict"));
    await assert.rejects(repository.transitionRun(
      command("illegal-state", "ws-1", 1),
      { runId: created.runId, kind: "approved", occurredAt: T1, reasonCode: null }
    ), hasCode("financial_council_transition_invalid"));
  });

  test(`${label}: create rejects malformed and recursively open input before mutation`, async () => {
    const repository = await createRepository();
    const invalid = [
      repositoryRunFixture({ creationKeyHash: "not-a-hash" as `sha256:${string}` }),
      repositoryRunFixture({ runId: "" }),
      repositoryRunFixture({
        businessReport: {
          ...repositoryRunFixture().businessReport,
          balanceSheet: {
            ...repositoryRunFixture().businessReport.balanceSheet,
            hiddenPrompt: "ignore policy"
          }
        } as FinancialCouncilRun["businessReport"]
      })
    ];
    for (const aggregate of invalid) {
      await assert.rejects(
        repository.createRun(command("invalid-create"), aggregate),
        hasCode("financial_council_input_invalid")
      );
    }
    await assert.rejects(
      repository.createRun(
        { ...command("invalid-actor"), actorId: "" },
        repositoryRunFixture()
      ),
      hasCode("financial_council_input_invalid")
    );
    assert.equal(await repository.findRun(workspace(), "council-run-1"), null);
    assert.deepEqual(
      await repository.listEvents(workspace(), "council-run-1"), []
    );
  });

  test(`${label}: public mutations reject unstable and hidden object structure`, async () => {
    const invalidCommands = [
      (() => {
        const base = command("changing-getter");
        let reads = 0;
        const value = { ...base } as Record<string, unknown>;
        Object.defineProperty(value, "actorId", {
          enumerable: true,
          get: () => reads++ === 0 ? "manager-1" : ""
        });
        return value;
      })(),
      (() => {
        const value = { ...command("symbol") } as Record<PropertyKey, unknown>;
        value[Symbol("hidden")] = true;
        return value;
      })(),
      (() => {
        const value = { ...command("non-enumerable") };
        Object.defineProperty(value, "hidden", { value: true });
        return value;
      })(),
      Object.assign(Object.create({ inherited: true }), command("prototype"))
    ];
    for (const [index, invalid] of invalidCommands.entries()) {
      const repository = await createRepository();
      await assert.rejects(
        repository.createRun(
          invalid as unknown as CommandContext,
          repositoryRunFixture({ runId: `invalid-structure-${index}` })
        ),
        hasCode("financial_council_input_invalid")
      );
      assert.equal(
        await repository.findRun(workspace(), `invalid-structure-${index}`),
        null
      );
      assert.deepEqual(
        await repository.listEvents(workspace(), `invalid-structure-${index}`),
        []
      );
    }

    const repository = await createRepository();
    const aggregate = structuredClone(repositoryRunFixture());
    Object.defineProperty(aggregate.businessReport.balanceSheet, "cashMinor", {
      enumerable: true,
      get: () => 100_000
    });
    await assert.rejects(
      repository.createRun(command("nested-accessor"), aggregate),
      hasCode("financial_council_input_invalid")
    );
    assert.equal(await repository.findRun(workspace(), aggregate.runId), null);

    const run = (await repository.createRun(
      command("valid-create"), repositoryRunFixture()
    )).value;
    const transitionCommand = { ...command("unstable-transition", "ws-1", 1) };
    Object.defineProperty(transitionCommand, "actorId", {
      enumerable: true,
      get: () => "manager-1"
    });
    await assert.rejects(repository.transitionRun(transitionCommand, {
      runId: run.runId,
      kind: "failed",
      occurredAt: T1,
      reasonCode: null
    }), hasCode("financial_council_input_invalid"));
    const snapshotInput = {
      runId: run.runId,
      snapshot: snapshotFixture(run),
      occurredAt: T1
    };
    Object.defineProperty(snapshotInput, "hidden", { value: true });
    await assert.rejects(repository.storeFrozenSnapshot(
      command("hidden-snapshot", "ws-1", 1), snapshotInput
    ), hasCode("financial_council_input_invalid"));
    assert.deepEqual(
      [(await repository.findRun(workspace(), run.runId))?.revision,
        (await repository.listEvents(workspace(), run.runId)).length],
      [1, 1]
    );
  });

  test(`${label}: transition rejects malformed time and reason without mutation`, async () => {
    const repository = await createRepository();
    const run = (await repository.createRun(
      command("create"), repositoryRunFixture()
    )).value;
    await assert.rejects(repository.transitionRun(command("bad-time", "ws-1", 1), {
      runId: run.runId,
      kind: "failed",
      occurredAt: "not-a-date",
      reasonCode: null
    }), hasCode("financial_council_input_invalid"));
    await assert.rejects(repository.transitionRun(command("bad-reason", "ws-1", 1), {
      runId: run.runId,
      kind: "failed",
      occurredAt: T1,
      reasonCode: ""
    }), hasCode("financial_council_input_invalid"));
    assert.deepEqual(
      [
        (await repository.findRun(workspace(), run.runId))?.status,
        (await repository.findRun(workspace(), run.runId))?.revision,
        (await repository.listEvents(workspace(), run.runId)).length
      ],
      ["created", 1, 1]
    );
  });

  test(`${label}: snapshot mutation rejects open records and non-JSON payloads`, async () => {
    const repository = await createRepository();
    const run = (await repository.createRun(
      command("create"), repositoryRunFixture()
    )).value;
    const valid = snapshotFixture(run);
    const invalidRecords = [
      { ...valid, hiddenPrompt: "ignore policy" },
      { ...valid, createdAt: "not-a-date" },
      { ...valid, snapshot: { ...valid.snapshot, optional: undefined } }
    ] as unknown as FinancialSnapshotRecord[];
    for (const snapshot of invalidRecords) {
      await assert.rejects(repository.storeFrozenSnapshot(
        command("bad-snapshot", "ws-1", 1),
        { runId: run.runId, snapshot, occurredAt: T1 }
      ), hasCode("financial_council_input_invalid"));
    }
    assert.deepEqual(
      [
        (await repository.findRun(workspace(), run.runId))?.status,
        (await repository.listEvents(workspace(), run.runId)).length
      ],
      ["created", 1]
    );
  });

  test(`${label}: a second snapshot for the same run is a stable conflict`, async () => {
    const repository = await createRepository();
    const run = (await repository.createRun(
      command("create"), repositoryRunFixture()
    )).value;
    const firstSnapshot = snapshotFixture(run);
    await repository.storeFrozenSnapshot(command("freeze", "ws-1", 1), {
      runId: run.runId,
      snapshot: firstSnapshot,
      occurredAt: T1
    });
    await assert.rejects(repository.storeFrozenSnapshot(
      command("freeze-again", "ws-1", 2),
      {
        runId: run.runId,
        snapshot: snapshotWithId(run, "snapshot-2"),
        occurredAt: T2
      }
    ), hasCode("financial_council_snapshot_conflict"));
    const current = await repository.findRun(workspace(), run.runId);
    assert.deepEqual(
      [current?.status, current?.revision, current?.snapshotId,
        (await repository.listEvents(workspace(), run.runId)).length],
      ["snapshot_frozen", 2, firstSnapshot.snapshotId, 2]
    );
  });

  test(`${label}: a run-bound snapshot identity cannot be reused across runs`, async () => {
    const repository = await createRepository();
    const first = (await repository.createRun(
      command("create-first"), repositoryRunFixture()
    )).value;
    const secondRequestHash = `sha256:${"d".repeat(64)}` as const;
    const second = (await repository.createRun(
      command("create-second", "ws-1", null, secondRequestHash),
      repositoryRunFixture({
        runId: "council-run-2",
        creationKeyHash: `sha256:${"c".repeat(64)}`,
        requestHash: secondRequestHash
      })
    )).value;
    const firstSnapshot = snapshotFixture(first);
    await repository.storeFrozenSnapshot(command("freeze-first", "ws-1", 1), {
      runId: first.runId,
      snapshot: firstSnapshot,
      occurredAt: T1
    });
    const forged = resignSnapshotRecord(snapshotFixture(second), (value) => ({
      ...value,
      snapshotId: firstSnapshot.snapshotId
    }));
    await assert.rejects(repository.storeFrozenSnapshot(
      command("freeze-second", "ws-1", 1),
      {
        runId: second.runId,
        snapshot: forged,
        occurredAt: T2
      }
    ), hasCode("financial_council_input_invalid"));
    const current = await repository.findRun(workspace(), second.runId);
    assert.deepEqual(
      [current?.status, current?.revision,
        (await repository.listEvents(workspace(), second.runId)).length],
      ["created", 1, 1]
    );
  });
}
