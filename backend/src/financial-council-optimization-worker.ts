import { randomBytes } from "node:crypto";
import {
  optimizeFinancialActions,
  type FinancialActionPortfolio,
  type FinancialActionOptimizerInput
} from "./financial-action-optimizer.js";
import { buildConsensus } from "./financial-council-consensus.js";
import {
  synthesizeFinancialCfoNarrative,
  type FinancialCfoNarrativePort
} from "./financial-council-cfo.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilCanonicalJson,
  financialCouncilError,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import type {
  FinancialCfoFindingProjection,
  FinancialCfoNarrativeInput
} from "./financial-council-model-port.js";
import type { FinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import type { FinancialSnapshot } from "./financial-council-snapshot.js";
import {
  createFinancialCouncilPortfolioRevision,
  financialCouncilOptimizationRunHash,
  selectFinancialCouncilOptimizationCandidates,
  type FinancialCouncilAnalysisLease,
  type FinancialCouncilPortfolioRevision,
  type FinancialCouncilRepository
} from "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type {
  ConsensusReport,
  FinancialCouncilActionPortfolio,
  FinancialCouncilCandidateAction,
  FinancialCouncilFinding
} from "./growth-contract-types.js";

export interface FinancialCouncilOptimizationWorkerLike {
  wake(run: Pick<FinancialCouncilRun, "workspaceId" | "runId">): Promise<void>;
  close(): Promise<void>;
}

export class FinancialCouncilPipelineWorker
implements FinancialCouncilOptimizationWorkerLike {
  readonly #active = new Map<string, Promise<void>>();
  #closed = false;

  constructor(private readonly stages: {
    readonly analysis: FinancialCouncilOptimizationWorkerLike;
    readonly optimization: FinancialCouncilOptimizationWorkerLike;
  }) {
    if (!stages?.analysis || !stages?.optimization) {
      throw new TypeError("invalid_financial_council_pipeline_worker");
    }
  }

  wake(run: Pick<FinancialCouncilRun, "workspaceId" | "runId">): Promise<void> {
    if (this.#closed) return Promise.reject(financialCouncilError(
      "financial_council_worker_closed"
    ));
    const key = `${run.workspaceId}\u0000${run.runId}`;
    const existing = this.#active.get(key);
    if (existing) return existing;
    const active = (async () => {
      await this.stages.analysis.wake(run);
      await this.stages.optimization.wake(run);
    })().finally(() => this.#active.delete(key));
    this.#active.set(key, active);
    return active;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#active.values()]);
    await this.stages.optimization.close();
    await this.stages.analysis.close();
  }
}

export interface FinancialCouncilOptimizationWorkerOptions {
  readonly repository: FinancialCouncilRepository;
  readonly policyRepository: FinancialCouncilPolicyRepository;
  readonly cfo: FinancialCfoNarrativePort;
  readonly workerId: string;
  readonly now?: () => string;
  readonly leaseDurationMs?: number;
  readonly leaseTokenFactory?: () => string;
  readonly optimize?: typeof optimizeFinancialActions;
}

function workerContext(control: {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly teamId: string;
}): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: control.workspaceId,
    kind: "team" as const,
    actorId: control.ownerId,
    role: "admin",
    teamId: control.teamId,
    capabilities: Object.freeze([]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function findingProjection(
  finding: FinancialCouncilFinding
): FinancialCfoFindingProjection {
  return Object.freeze({
    findingId: finding.findingId,
    agentRole: finding.agentRole,
    conclusion: finding.conclusion,
    severity: finding.severity,
    evidenceRefIds: Object.freeze(finding.evidenceRefs.map((reference) =>
      reference.sourceId).sort(compareUtf8)),
    formulaRefId: finding.formulaRef === null ? null
      : financialCouncilCanonicalHash(finding.formulaRef)
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function cfoInput(input: {
  readonly control: { readonly ownerId: string; readonly teamId: string };
  readonly run: FinancialCouncilRun;
  readonly consensus: ConsensusReport;
  readonly auditHash: `sha256:${string}`;
}): FinancialCfoNarrativeInput {
  return immutableFinancialCouncilValue({
    ownerId: input.control.ownerId,
    teamId: input.control.teamId,
    runId: input.run.runId,
    snapshotId: input.run.snapshotId!,
    snapshotHash: input.run.snapshotHash!,
    auditHash: input.auditHash,
    attempt: 1,
    acceptedFindings: input.consensus.acceptedFindings.map(findingProjection),
    minorityFindings: input.consensus.minorityFindings.map(findingProjection),
    rejectedFindingIds: input.consensus.rejectedFindings
      .map((finding) => finding.findingId).sort(compareUtf8),
    unresolvedConflicts: input.consensus.unresolvedConflicts.filter(
      (conflict): conflict is typeof conflict & { readonly status: "unresolved" } =>
        conflict.status === "unresolved"
    ),
    dataGapRefs: input.consensus.dataGaps.map((gap) =>
      financialCouncilCanonicalHash(gap)).sort(compareUtf8)
  });
}

function withNarrative(
  consensus: ConsensusReport,
  overallDiagnosis: string
): ConsensusReport {
  const { reportId: _oldReportId, ...base } = consensus;
  const preimage = immutableFinancialCouncilValue({
    ...base,
    overallDiagnosis
  });
  return immutableFinancialCouncilValue({
    reportId: financialCouncilCanonicalHash(preimage),
    ...preimage
  });
}

function closingCash(snapshot: FinancialSnapshot): number {
  const value = snapshot.report.closingCashMinor;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw financialCouncilError("financial_council_optimization_input_invalid");
  }
  return Number(value);
}

function boundedBps(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw financialCouncilError("financial_council_optimization_input_invalid");
  }
  return Math.max(0, Math.min(10_000, value));
}

function boundedSignedBps(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw financialCouncilError("financial_council_optimization_input_invalid");
  }
  return Math.max(-10_000, Math.min(10_000, value));
}

export function projectFinancialActionPortfolios(input: {
  readonly run: FinancialCouncilRun;
  readonly rows: readonly FinancialActionPortfolio[];
  readonly createdAt: string;
  readonly revision?: number;
}): readonly FinancialCouncilActionPortfolio[] {
  const revision = input.revision ?? 1;
  return immutableFinancialCouncilValue(input.rows.map((row) => {
    const hardConstraints = row.hardConstraints.map((result) => ({
      code: result.kind,
      satisfied: result.status === "satisfied",
      reason: result.reason
    }));
    const actionIds = [...row.actionIds].sort(compareUtf8);
    const actionsById = new Map(row.actions.map((action) =>
      [action.actionId, action] as const));
    const actions = actionIds.map((actionId) => actionsById.get(actionId)!);
    const preimage = {
      optimizerPortfolioId: row.portfolioId,
      runId: input.run.runId,
      revision,
      kind: row.kind,
      actionIds,
      hardConstraints,
      objectiveScoreBps: boundedBps(row.objectiveScoreBps),
      scenarioForecast: row.scenarioForecast,
      createdAt: input.createdAt
    };
    return {
      portfolioId: financialCouncilCanonicalHash(preimage),
      runId: input.run.runId,
      revision,
      kind: row.kind,
      actionIds,
      actions,
      hardConstraints,
      objectiveScoreBps: boundedBps(row.objectiveScoreBps),
      scenarioForecast: row.scenarioForecast,
      sensitivityAnalysis: row.sensitivityAnalysis.map((result) => ({
        factor: result.factor,
        impactBps: boundedSignedBps(result.impactBps)
      })),
      rejectedActions: row.rejectedActions,
      requiredApprovalCapabilities: [...row.requiredApprovalCapabilities]
        .sort(compareUtf8),
      expiresAt: input.run.expiresAt,
      createdAt: input.createdAt
    };
  }));
}

export function createFinancialActionOptimizerInput(input: {
  readonly run: FinancialCouncilRun;
  readonly snapshot: FinancialSnapshot;
  readonly consensus: ConsensusReport;
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly policy: Parameters<typeof optimizeFinancialActions>[0]["policy"];
}): FinancialActionOptimizerInput {
  const dataGaps = (input.snapshot.dataGaps ?? []) as readonly unknown[];
  return immutableFinancialCouncilValue({
    snapshot: {
      runId: input.run.runId,
      snapshotId: input.run.snapshotId!,
      workspaceId: input.run.workspaceId,
      snapshotHash: input.run.snapshotHash!,
      currency: input.run.currency,
      report: { closingCashMinor: closingCash(input.snapshot) },
      dataGaps,
      grantedCapabilities: [],
      satisfiedPrerequisiteIds: []
    },
    consensus: input.consensus,
    actions: input.actions,
    policy: input.policy
  });
}

function integrityFailure(error: unknown): boolean {
  return ["financial_council_integrity", "financial_council_portfolio_integrity",
    "financial_council_portfolio_conflict"].includes(String(
    (error as { code?: unknown } | null)?.code
  ));
}

export class FinancialCouncilOptimizationWorker
implements FinancialCouncilOptimizationWorkerLike {
  readonly #active = new Map<string, Promise<void>>();
  readonly #now: () => string;
  readonly #leaseDurationMs: number;
  readonly #leaseTokenFactory: () => string;
  readonly #optimize: typeof optimizeFinancialActions;
  #closed = false;

  constructor(private readonly options: FinancialCouncilOptimizationWorkerOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
    this.#leaseTokenFactory = options.leaseTokenFactory
      ?? (() => randomBytes(32).toString("hex"));
    this.#optimize = options.optimize ?? optimizeFinancialActions;
    if (!options.repository || !options.policyRepository || !options.cfo
      || !options.workerId.trim() || !Number.isSafeInteger(this.#leaseDurationMs)
      || this.#leaseDurationMs < 1) {
      throw new TypeError("invalid_financial_council_optimization_worker");
    }
  }

  wake(run: Pick<FinancialCouncilRun, "workspaceId" | "runId">): Promise<void> {
    if (this.#closed) return Promise.reject(financialCouncilError(
      "financial_council_worker_closed"
    ));
    const key = `${run.workspaceId}\u0000${run.runId}`;
    const existing = this.#active.get(key);
    if (existing) return existing;
    const active = this.#execute(run).finally(() => this.#active.delete(key));
    this.#active.set(key, active);
    return active;
  }

  async #execute(
    requested: Pick<FinancialCouncilRun, "workspaceId" | "runId">
  ): Promise<void> {
    const claimedAt = this.#now();
    const lease = await this.options.repository.claimAnalysisRun({
      workspaceId: requested.workspaceId,
      runId: requested.runId,
      workerId: this.options.workerId,
      leaseToken: this.#leaseTokenFactory(),
      claimedAt,
      leaseExpiresAt: new Date(Date.parse(claimedAt)
        + this.#leaseDurationMs).toISOString()
    });
    if (!lease) return;
    try {
      await this.#runWithLease(lease);
    } catch (error) {
      if (!integrityFailure(error)) throw error;
      await this.options.repository.transitionRunWithLease(lease, {
        kind: "failed",
        occurredAt: this.#now(),
        reasonCode: "portfolio_replay_mismatch"
      });
    } finally {
      await this.options.repository.releaseAnalysisLease(
        lease, this.#now()
      ).catch(() => undefined);
    }
  }

  async #runWithLease(lease: FinancialCouncilAnalysisLease): Promise<void> {
    const control = await this.options.repository.getAnalysisControl({
      workspaceId: lease.workspaceId,
      kind: "team",
      actorId: "worker",
      role: "admin",
      teamId: lease.workspaceId,
      capabilities: [],
      capabilityRegistryVersion: "growth-capabilities.v1"
    }, lease.runId);
    if (!control) throw financialCouncilError("financial_council_integrity");
    const context = workerContext(control);
    let verified = await this.options.repository.getVerifiedRunSnapshot(
      context, lease.runId
    );
    if (!verified) throw financialCouncilError("financial_council_integrity");
    let run = verified.run;
    if (run.status !== "synthesizing" && run.status !== "optimizing") return;
    const graph = await this.options.repository.getAuditGraph(context, run.runId);
    const results = await this.options.repository.listSpecialistResults(
      context, run.runId
    );
    const dispositions = await this.options.repository.listFindingDispositions(
      context, run.runId
    );
    if (!graph) throw financialCouncilError("financial_council_integrity");
    let consensus = await this.options.repository.getConsensus(
      context, run.runId
    );
    if (run.status === "synthesizing") {
      if (!consensus) {
        const deterministic = buildConsensus({
          graph,
          findings: results.filter((result) => result.phase === "analyze")
            .flatMap((result) => result.findings),
          dispositions,
          dataGaps: verified.snapshot.dataGaps,
          createdAt: this.#now()
        });
        const narrative = await synthesizeFinancialCfoNarrative(
          this.options.cfo,
          cfoInput({ control, run, consensus: deterministic,
            auditHash: graph.graphHash })
        );
        consensus = withNarrative(deterministic, narrative.overallDiagnosis);
        await this.options.repository.storeConsensus(context, consensus, {
          lease,
          completedAt: this.#now()
        });
      }
      run = (await this.options.repository.transitionRunWithLease(lease, {
        kind: "optimizing",
        occurredAt: this.#now(),
        reasonCode: null
      })).value;
      verified = (await this.options.repository.getVerifiedRunSnapshot(
        context, run.runId
      ))!;
    }
    if (!consensus) throw financialCouncilError("financial_council_integrity");
    const policy = await this.options.policyRepository.findVersion(
      context, run.policyVersionId
    );
    if (!policy || policy.policyVersionId !== run.policyVersionId) {
      await this.options.repository.transitionRunWithLease(lease, {
        kind: "not_computable",
        occurredAt: this.#now(),
        reasonCode: "optimization_policy_unavailable"
      });
      return;
    }
    const actions = selectFinancialCouncilOptimizationCandidates(
      consensus, results
    );
    const rows = this.#optimize(createFinancialActionOptimizerInput({
      run,
      snapshot: verified.snapshot,
      consensus,
      actions,
      policy
    }));
    if (rows.some((row) => row.status === "not_computable")) {
      const reason = rows.find((row) => row.reasonCode)?.reasonCode
        ?? "optimization_input_invalid";
      await this.options.repository.transitionRunWithLease(lease, {
        kind: "not_computable",
        occurredAt: this.#now(),
        reasonCode: reason
      });
      return;
    }
    const existing = await this.options.repository.getPortfolioRevision(
      context, run.runId, 1
    );
    const createdAt = existing?.createdAt ?? this.#now();
    const portfolios = projectFinancialActionPortfolios({ run, rows, createdAt });
    const revision = createFinancialCouncilPortfolioRevision({
      workspaceId: run.workspaceId,
      runId: run.runId,
      revision: 1,
      runHash: financialCouncilOptimizationRunHash(run),
      snapshotId: run.snapshotId!,
      snapshotHash: run.snapshotHash!,
      auditHash: graph.graphHash,
      policyVersionId: policy.policyVersionId,
      policyHash: policy.policyHash,
      consensusReportId: consensus.reportId,
      candidateSetHash: financialCouncilCanonicalHash(actions),
      portfolios,
      createdAt
    });
    if (existing && financialCouncilCanonicalJson(existing)
      !== financialCouncilCanonicalJson(revision)) {
      throw financialCouncilError("financial_council_portfolio_integrity");
    }
    await this.options.repository.storePortfolioRevision(revision, {
      lease,
      completedAt: this.#now()
    });
    await this.options.repository.publishPortfolioRevisionWithLease(lease, {
      revision: 1,
      expectedOutputHash: revision.outputHash,
      occurredAt: this.#now()
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#active.values()]);
  }
}
