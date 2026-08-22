import { randomBytes } from "node:crypto";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import {
  FINANCIAL_COUNCIL_SPECIALIST_ROLES
} from "./financial-council-specialists.js";
import type {
  FinancialCouncilAnalysisGap,
  FinancialCouncilAnalysisLease,
  FinancialCouncilRepository
} from "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { FinancialCouncilAgentRole } from "./growth-contract-types.js";
import {
  buildCanonicalFinancialCouncilAuditGraph,
  selectFinancialCouncilRebuttalTargets
} from "./financial-council-audit.js";
import {
  loadVerifiedFinancialCouncilSpecialistResults,
  type FinancialCouncilSpecialistCoordinator,
  type FinancialCouncilSpecialistCoordinatorOptions
} from "./financial-council-specialists.js";
import type { FinancialCouncilRebuttalCoordinator } from
  "./financial-council-rebuttal.js";

const CRITICAL_ROLES = new Set<FinancialCouncilAgentRole>([
  "finance", "cashflow"
]);

export interface FinancialCouncilRoleInspection {
  readonly available: boolean;
  readonly gapCode?: "tax_input_missing";
  readonly hardConstraintDependency?: boolean;
  readonly actionDependency?: boolean;
}

export interface FinancialCouncilAnalysisPipeline {
  inspectRole(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole
  ): Promise<FinancialCouncilRoleInspection>;
  analyzeRole(input: {
    readonly context: ActiveWorkspaceContext;
    readonly runId: string;
    readonly role: FinancialCouncilAgentRole;
    readonly lease: FinancialCouncilAnalysisLease;
  }): Promise<void>;
  audit(input: {
    readonly context: ActiveWorkspaceContext;
    readonly runId: string;
    readonly lease: FinancialCouncilAnalysisLease;
  }): Promise<void>;
}

export interface FinancialCouncilAnalysisWorkerLike {
  wake(run: Pick<FinancialCouncilRun, "workspaceId" | "runId">): Promise<void>;
  close(): Promise<void>;
}

export interface FinancialCouncilAnalysisWorkerOptions {
  readonly repository: FinancialCouncilRepository;
  readonly pipeline: FinancialCouncilAnalysisPipeline;
  readonly workerId: string;
  readonly now?: () => string;
  readonly leaseDurationMs?: number;
  readonly roleTimeoutMs?: number;
  readonly leaseTokenFactory?: () => string;
  readonly logger?: { error(event: Readonly<Record<string, unknown>>): void };
}

export class DefaultFinancialCouncilAnalysisPipeline
implements FinancialCouncilAnalysisPipeline {
  constructor(private readonly options: {
    readonly repository: FinancialCouncilRepository;
    readonly specialists: FinancialCouncilSpecialistCoordinator;
    readonly rebuttals: FinancialCouncilRebuttalCoordinator;
    readonly resolvePolicy: FinancialCouncilSpecialistCoordinatorOptions[
      "resolvePolicy"];
    readonly now: () => string;
  }) {}

  inspectRole(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole
  ): Promise<FinancialCouncilRoleInspection> {
    return this.options.specialists.inspectRole(context, runId, role);
  }

  async analyzeRole(input: {
    readonly context: ActiveWorkspaceContext;
    readonly runId: string;
    readonly role: FinancialCouncilAgentRole;
    readonly lease: FinancialCouncilAnalysisLease;
  }): Promise<void> {
    await this.options.specialists.runRole(
      input.context, input.runId, input.role,
      { lease: input.lease, completedAt: this.options.now() }
    );
  }

  async audit(input: {
    readonly context: ActiveWorkspaceContext;
    readonly runId: string;
    readonly lease: FinancialCouncilAnalysisLease;
  }): Promise<void> {
    const results = await loadVerifiedFinancialCouncilSpecialistResults({
      repository: this.options.repository,
      context: input.context,
      runId: input.runId,
      resolvePolicy: this.options.resolvePolicy,
      now: this.options.now
    });
    const gaps = await this.options.repository.listAnalysisGaps(
      input.context, input.runId
    );
    const roles = new Set(results.filter((result) => result.phase === "analyze")
      .map((result) => result.role));
    if (!roles.has("finance") || !roles.has("cashflow")
      || results.filter((result) => result.phase === "analyze").length
        + gaps.length !== 5) {
      throw financialCouncilError("financial_council_audit_invalid");
    }
    const analyze = results.filter((result) => result.phase === "analyze");
    const first = analyze[0]!;
    const computed = buildCanonicalFinancialCouncilAuditGraph({
      workspaceId: first.workspaceId,
      runId: first.runId,
      snapshotId: first.snapshotId,
      snapshotHash: first.snapshotHash,
      facts: analyze.flatMap((result) => result.findings.map((finding) => ({
        finding,
        actions: result.actions.filter((action) =>
          action.sourceFindingIds.includes(finding.findingId))
      })))
    });
    const existing = await this.options.repository.getAuditGraph(
      input.context, input.runId
    );
    const graph = existing ?? (await this.options.repository.storeAuditGraph(
      input.context,
      computed,
      analyze.flatMap((result) => result.findings.map((finding) => ({
        findingId: finding.findingId,
        role: result.role,
        status: "unresolved" as const,
        blockingConflictIds: computed.edges.filter((edge) =>
          edge.findingIds.includes(finding.findingId)).map((edge) => edge.edgeId)
      }))),
      { lease: input.lease, completedAt: this.options.now() }
    )).value;
    if (existing && existing.graphHash !== computed.graphHash) {
      throw financialCouncilError("financial_council_audit_conflict");
    }
    const findings = analyze.flatMap((result) => result.findings);
    const byId = new Map(findings.map((finding) =>
      [finding.findingId, finding] as const));
    const targets = selectFinancialCouncilRebuttalTargets(graph,
      findings.map((finding) => ({
        findingId: finding.findingId, role: finding.agentRole
      })));
    for (const target of targets) {
      const originalFinding = byId.get(target.findingId);
      const peerFinding = byId.get(target.peerFindingId);
      if (!originalFinding || !peerFinding) {
        throw financialCouncilError("financial_council_audit_invalid");
      }
      const baseInput = await this.options.specialists.rebuttalBaseInput(
        input.context, input.runId, target.role, target.findingId
      );
      await this.options.rebuttals.run({
        context: input.context, graph, target, originalFinding, peerFinding,
        baseInput
      }, { lease: input.lease, completedAt: this.options.now() });
    }
  }
}

function context(control: {
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

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let handle: NodeJS.Timeout;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(Object.assign(
      new Error("financial_council_model_timeout"), {
        code: "financial_council_model_timeout", retryable: true
      }
    )), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(handle));
}

export class FinancialCouncilAnalysisWorker
implements FinancialCouncilAnalysisWorkerLike {
  readonly #active = new Map<string, Promise<void>>();
  readonly #now: () => string;
  readonly #leaseDurationMs: number;
  readonly #roleTimeoutMs: number;
  readonly #leaseTokenFactory: () => string;
  #closed = false;

  constructor(private readonly options: FinancialCouncilAnalysisWorkerOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
    this.#roleTimeoutMs = options.roleTimeoutMs ?? 60_000;
    this.#leaseTokenFactory = options.leaseTokenFactory
      ?? (() => randomBytes(32).toString("hex"));
    if (!options.repository || !options.pipeline || !options.workerId.trim()
      || !Number.isSafeInteger(this.#leaseDurationMs)
      || this.#leaseDurationMs < 1
      || !Number.isSafeInteger(this.#roleTimeoutMs)
      || this.#roleTimeoutMs < 1 || this.#roleTimeoutMs > 60_000) {
      throw new TypeError("invalid_financial_council_analysis_worker");
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
    const token = this.#leaseTokenFactory();
    const lease = await this.options.repository.claimAnalysisRun({
      workspaceId: requested.workspaceId,
      runId: requested.runId,
      workerId: this.options.workerId,
      leaseToken: token,
      claimedAt,
      leaseExpiresAt: new Date(Date.parse(claimedAt)
        + this.#leaseDurationMs).toISOString()
    });
    if (!lease) return;
    const control = await this.options.repository.getAnalysisControl({
      workspaceId: requested.workspaceId, kind: "team", actorId: "worker",
      role: "admin", teamId: requested.workspaceId, capabilities: [],
      capabilityRegistryVersion: "growth-capabilities.v1"
    }, requested.runId);
    if (!control) throw financialCouncilError("financial_council_integrity");
    const workerContext = context(control);
    try {
      let run = await this.options.repository.findRun(
        workerContext, requested.runId
      );
      if (!run) throw financialCouncilError("financial_council_run_not_found");
      if (run.status === "snapshot_frozen") {
        run = (await this.options.repository.transitionRunWithLease(lease, {
          kind: "analyzing", occurredAt: this.#now(), reasonCode: null
        })).value;
      }
      if (run.status === "analyzing") {
        const completed = await this.#analyze(workerContext, lease);
        if (!completed) return;
        run = (await this.options.repository.transitionRunWithLease(lease, {
          kind: "auditing", occurredAt: this.#now(), reasonCode: null
        })).value;
      }
      if (run.status === "auditing") {
        await this.options.pipeline.audit({
          context: workerContext, runId: run.runId, lease
        });
        await this.options.repository.transitionRunWithLease(lease, {
          kind: "synthesizing", occurredAt: this.#now(), reasonCode: null
        });
      }
    } finally {
      await this.options.repository.releaseAnalysisLease(
        lease, this.#now()
      ).catch(() => undefined);
    }
  }

  async #analyze(
    workerContext: ActiveWorkspaceContext,
    lease: FinancialCouncilAnalysisLease
  ): Promise<boolean> {
    const gaps = await this.options.repository.listAnalysisGaps(
      workerContext, lease.runId
    );
    for (const role of FINANCIAL_COUNCIL_SPECIALIST_ROLES) {
      if (gaps.some((gap) => gap.role === role)) continue;
      const inspection = await this.options.pipeline.inspectRole(
        workerContext, lease.runId, role
      );
      if (!inspection.available) {
        if (CRITICAL_ROLES.has(role)
          || inspection.hardConstraintDependency !== false
          || inspection.actionDependency !== false) {
          await this.#notComputable(lease, role, inspection.gapCode
            ?? "specialist_unavailable");
          return false;
        }
        await this.#gap(lease, role, inspection.gapCode
          ?? "specialist_unavailable");
        continue;
      }
      try {
        await this.#callRole(workerContext, lease, role);
      } catch (error) {
        if (CRITICAL_ROLES.has(role)
          || inspection.hardConstraintDependency !== false
          || inspection.actionDependency !== false) {
          await this.#notComputable(lease, role, "specialist_unavailable");
          this.#log(role, error);
          return false;
        }
        await this.#gap(lease, role, "specialist_unavailable");
        this.#log(role, error);
      }
    }
    return true;
  }

  async #callRole(
    workerContext: ActiveWorkspaceContext,
    lease: FinancialCouncilAnalysisLease,
    role: FinancialCouncilAgentRole
  ): Promise<void> {
    let failure: unknown;
    for (let transportAttempt = 0; transportAttempt < 2; transportAttempt += 1) {
      try {
        await timeout(this.options.pipeline.analyzeRole({
          context: workerContext, runId: lease.runId, role, lease
        }), this.#roleTimeoutMs);
        return;
      } catch (error) {
        failure = error;
        if (!(error as { retryable?: unknown } | null)?.retryable) break;
      }
    }
    throw failure;
  }

  async #gap(
    lease: FinancialCouncilAnalysisLease,
    role: FinancialCouncilAgentRole,
    code: FinancialCouncilAnalysisGap["code"]
  ): Promise<void> {
    const createdAt = this.#now();
    const preimage = {
      workspaceId: lease.workspaceId, runId: lease.runId, role,
      code, detail: null, createdAt
    } as const;
    await this.options.repository.storeAnalysisGap(lease, {
      ...preimage, gapHash: financialCouncilCanonicalHash(preimage)
    });
  }

  async #notComputable(
    lease: FinancialCouncilAnalysisLease,
    role: FinancialCouncilAgentRole,
    code: string
  ): Promise<void> {
    await this.options.repository.transitionRunWithLease(lease, {
      kind: "not_computable",
      occurredAt: this.#now(),
      reasonCode: `${role}:${code}`
    });
  }

  #log(role: FinancialCouncilAgentRole, error: unknown): void {
    this.options.logger?.error(Object.freeze({
      event: "financial_council_role_failed",
      role,
      code: typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : "financial_council_role_failed"
    }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#active.values()]);
  }
}
