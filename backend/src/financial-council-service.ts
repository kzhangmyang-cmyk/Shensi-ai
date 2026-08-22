import type {
  FinancialCouncilCreateInput,
  FinancialCouncilPolicyInput
} from "./growth-contract-types.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun,
  type FinancialCouncilRunEvent,
  type FinancialSnapshotRecord
} from "./financial-council-domain.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import {
  createDefaultFinancialCouncilPolicy,
  createFinancialCouncilPolicyVersion,
  normalizeFinancialCouncilPolicyInput
} from "./financial-council-policy.js";
import type { FinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import type {
  FinancialSnapshot,
  FinancialSnapshotBuilder
} from "./financial-council-snapshot.js";
import {
  FinancialPortfolioRevisionService,
  type ReviseFinancialPortfolioInput
} from "./financial-portfolio-revision.js";
import {
  FinancialCouncilApprovalService,
  type FinancialCouncilApprovalCommandInput,
  type FinancialCouncilRejectionCommandInput
} from "./financial-council-approval.js";
import type { FinancialCouncilSourceVerifier } from
  "./financial-council-source-verifier.js";
import type { FinancialCouncilPortfolioRevision } from
  "./financial-council-repository.js";
import type { FinancialCouncilApprovalRecord } from
  "./financial-council-approval.js";
import type { FinancialCouncilDispatchOperationStatus } from
  "./financial-council-dispatch-operation.js";

export interface FinancialCouncilWakeSink {
  wake(run: FinancialCouncilRun): Promise<void>;
}

export interface FinancialCouncilServiceDependencies {
  readonly repository: FinancialCouncilRepository;
  readonly policyRepository?: FinancialCouncilPolicyRepository;
  readonly snapshotBuilder: Pick<FinancialSnapshotBuilder, "freeze">;
  readonly advisoryWake?: FinancialCouncilWakeSink;
  readonly sourceVerifier?: FinancialCouncilSourceVerifier;
  readonly onAdvisoryWakeError?: (
    error: unknown,
    run: FinancialCouncilRun
  ) => void | Promise<void>;
  readonly now?: () => string;
}

const TRUSTED_FINANCIAL_COUNCIL_SERVICES = new WeakSet<object>();

export function isFinancialCouncilService(
  value: unknown
): value is FinancialCouncilService {
  return !!value && typeof value === "object"
    && TRUSTED_FINANCIAL_COUNCIL_SERVICES.has(value);
}

function authorize(context: ActiveWorkspaceContext): void {
  if (!context || !context.workspaceId?.trim()
    || context.workspaceId === "all" || !context.actorId?.trim()) {
    throw financialCouncilError("financial_council_context_invalid");
  }
  requireGrowthCapabilities(context, ["finance.council.run"]);
}

function instant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw financialCouncilError("financial_council_timestamp_invalid");
  }
  return value;
}

function requestHash(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw financialCouncilError("financial_council_context_invalid");
  }
  return value as `sha256:${string}`;
}

function publicRun(run: FinancialCouncilRun): FinancialCouncilRun {
  if (run.status === "created" || run.revision < 2
    || run.snapshotId === null || run.snapshotHash === null) {
    throw financialCouncilError("financial_council_integrity");
  }
  return run;
}

export class FinancialCouncilService {
  private readonly now: () => string;
  private readonly portfolioRevisions: FinancialPortfolioRevisionService | null;
  private readonly approvals: FinancialCouncilApprovalService | null;

  constructor(private readonly dependencies: FinancialCouncilServiceDependencies) {
    const repository = dependencies?.repository;
    if (!repository || !["createAndFreezeRun", "createRun",
      "findFrozenRunByCreationKey", "findRun", "listEvents",
      "storeFrozenSnapshot", "transitionRun", "listRunnableRuns"].every(
      (key) => typeof Reflect.get(repository, key) === "function"
    ) || typeof dependencies.snapshotBuilder?.freeze !== "function"
      || (dependencies.policyRepository !== undefined
        && !["findActive", "findVersion", "getOrCreateActive",
          "createVersion"].every((key) => typeof Reflect.get(
          dependencies.policyRepository!, key
        ) === "function"))
      || (dependencies.advisoryWake !== undefined
        && typeof dependencies.advisoryWake.wake !== "function")) {
      throw new Error("invalid_financial_council_service");
    }
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.portfolioRevisions = dependencies.policyRepository
      ? new FinancialPortfolioRevisionService({
          repository: dependencies.repository,
          policyRepository: dependencies.policyRepository,
          now: this.now
        }) : null;
    this.approvals = dependencies.policyRepository && dependencies.sourceVerifier
      ? new FinancialCouncilApprovalService({
          repository: dependencies.repository,
          policyRepository: dependencies.policyRepository,
          sourceVerifier: dependencies.sourceVerifier,
          now: this.now
        }) : null;
    TRUSTED_FINANCIAL_COUNCIL_SERVICES.add(this);
  }

  private policyRepository(): FinancialCouncilPolicyRepository {
    const repository = this.dependencies.policyRepository;
    if (!repository) throw financialCouncilError(
      "financial_council_policy_integrity"
    );
    return repository;
  }

  async getPolicy(context: ActiveWorkspaceContext) {
    authorize(context);
    const createdAt = instant(this.now());
    return this.policyRepository().getOrCreateActive(
      context,
      createDefaultFinancialCouncilPolicy(context.workspaceId, createdAt)
    );
  }

  async getPolicyVersion(
    context: ActiveWorkspaceContext,
    policyVersionId: string
  ) {
    authorize(context);
    if (typeof policyVersionId !== "string" || !policyVersionId.trim()
      || [...policyVersionId].length > 255) {
      throw financialCouncilError("financial_council_policy_input_invalid");
    }
    const policy = await this.policyRepository().findVersion(
      context, policyVersionId
    );
    if (!policy) throw financialCouncilError(
      "financial_council_policy_not_found"
    );
    return policy;
  }

  async updatePolicy(
    command: CommandContext,
    rawInput: FinancialCouncilPolicyInput
  ) {
    authorize(command?.workspace);
    requireGrowthCapabilities(command.workspace,
      ["finance.council.policy.manage"]);
    if (command.actorId !== command.workspace.actorId) {
      throw financialCouncilError("financial_council_policy_context_invalid");
    }
    const input = normalizeFinancialCouncilPolicyInput(rawInput);
    const active = await this.getPolicy(command.workspace);
    const createdAt = instant(this.now());
    const policyVersionId = `financial-council-policy:${
      financialCouncilCanonicalHash({
        workspaceId: command.workspace.workspaceId,
        version: active.version + 1,
        input
      })}`;
    const policy = createFinancialCouncilPolicyVersion({
      policyVersionId,
      workspaceId: command.workspace.workspaceId,
      version: active.version + 1,
      revision: active.revision + 1,
      input,
      createdAt
    });
    return this.policyRepository().createVersion(command, policy);
  }

  async createRun(
    command: CommandContext,
    rawInput: FinancialCouncilCreateInput
  ) {
    authorize(command?.workspace);
    if (command.actorId !== command.workspace.actorId
      || command.expectedRevision !== null) {
      throw financialCouncilError("financial_council_context_invalid");
    }
    const input = immutableFinancialCouncilInput(rawInput);
    const idempotencyKeyHash = growthHttpIdempotencyKeyHash(
      command.idempotencyKey
    );
    const tenantScopedIdempotencyHash = financialCouncilCanonicalHash({
      workspaceId: command.workspace.workspaceId,
      ownerId: command.actorId,
      teamId: command.workspace.teamId,
      idempotencyKeyHash
    });
    const runId = `financial-council:create:${tenantScopedIdempotencyHash}`;
    const creationKeyHash = financialCouncilCanonicalHash(runId);
    const canonicalRequestHash = requestHash(command.requestHash);
    const replay = await this.dependencies.repository
      .findFrozenRunByCreationKey(
        command.workspace, creationKeyHash, canonicalRequestHash
      );
    if (replay) return { value: publicRun(replay), replayed: true };
    await this.getPolicy(command.workspace);
    const selectedPolicy = await this.getPolicyVersion(
      command.workspace, input.policyVersionId
    );
    if (selectedPolicy.currency !== input.currency) {
      throw financialCouncilError("financial_council_policy_currency_mismatch");
    }
    const createdAt = instant(this.now());
    const snapshot = await this.dependencies.snapshotBuilder.freeze(
      command, runId, input
    );
    const aggregate = immutableFinancialCouncilValue({
      runId,
      workspaceId: command.workspace.workspaceId,
      creationKeyHash,
      requestHash: canonicalRequestHash,
      currency: input.currency,
      status: "created" as const,
      revision: 1,
      dataAsOf: snapshot.dataAsOf,
      businessReport: input.businessReport,
      policyVersionId: input.policyVersionId,
      snapshotId: null,
      snapshotHash: null,
      consensusReport: null,
      portfolios: Object.freeze([]),
      latestPortfolioRevision: null,
      approval: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString()
    } satisfies FinancialCouncilRun);
    const record = immutableFinancialCouncilValue({
      snapshotId: snapshot.snapshotId,
      runId,
      workspaceId: command.workspace.workspaceId,
      snapshotHash: snapshot.snapshotHash,
      snapshot: snapshot as unknown as Readonly<Record<string, unknown>>,
      createdAt
    } satisfies FinancialSnapshotRecord);
    const result = await this.dependencies.repository.createAndFreezeRun(
      command,
      { aggregate, snapshot: record, occurredAt: createdAt }
    );
    publicRun(result.value);
    if (!result.replayed && this.dependencies.advisoryWake) {
      void Promise.resolve()
        .then(() => this.dependencies.advisoryWake!.wake(result.value))
        .catch((error) => {
          void Promise.resolve()
            .then(() => this.dependencies.onAdvisoryWakeError?.(
              error, result.value
            ))
            .catch(() => undefined);
        });
    }
    return result;
  }

  async getRun(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilRun> {
    authorize(context);
    if (typeof runId !== "string" || !runId.trim() || runId.length > 255) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const run = await this.dependencies.repository.findRun(context, runId);
    if (!run) throw financialCouncilError("financial_council_run_not_found");
    return publicRun(run);
  }

  async revisePortfolio(
    command: CommandContext,
    input: ReviseFinancialPortfolioInput
  ) {
    authorize(command?.workspace);
    if (!this.portfolioRevisions) {
      throw financialCouncilError("financial_council_policy_integrity");
    }
    return this.portfolioRevisions.revisePortfolio(command, input);
  }

  async approve(
    command: CommandContext,
    input: FinancialCouncilApprovalCommandInput
  ) {
    if (!this.approvals) throw financialCouncilError(
      "financial_council_approval_integrity"
    );
    return this.approvals.approve(command, input);
  }

  async reject(
    command: CommandContext,
    input: FinancialCouncilRejectionCommandInput
  ) {
    if (!this.approvals) throw financialCouncilError(
      "financial_council_approval_integrity"
    );
    return this.approvals.reject(command, input);
  }

  async getPortfolioRevision(
    context: ActiveWorkspaceContext,
    runId: string,
    revision: number
  ): Promise<FinancialCouncilPortfolioRevision> {
    await this.getRun(context, runId);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const result = await this.dependencies.repository.getPortfolioRevision(
      context, runId, revision
    );
    if (!result) throw financialCouncilError("financial_council_portfolio_not_found");
    return result;
  }

  async getApproval(
    context: ActiveWorkspaceContext,
    approvalId: string
  ): Promise<FinancialCouncilApprovalRecord> {
    if (typeof approvalId !== "string" || !approvalId.trim()) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const approval = await this.dependencies.repository.getApproval(
      context, approvalId
    );
    if (!approval) throw financialCouncilError("financial_council_run_not_found");
    return approval;
  }

  async listDispatches(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilPublicDispatchView[]> {
    await this.getRun(context, runId);
    const outbox = await this.dependencies.repository.listDispatchOutbox(
      context, runId
    );
    return Object.freeze(await Promise.all(outbox.map(async (row) => {
      const operation = await this.dependencies.repository.getDispatchOperation(
        context, row.dispatchId
      );
      return Object.freeze({
        dispatchId: row.dispatchId,
        runId: row.runId,
        approvalId: row.approvalId,
        portfolioRevision: row.portfolioRevision,
        portfolioKind: row.portfolioKind,
        actionId: row.actionId,
        status: operation?.status ?? row.status,
        attempt: operation?.attempt ?? row.attempt,
        receiptId: operation?.receiptId ?? null,
        lastErrorCode: operation?.lastErrorCode ?? null,
        createdAt: operation?.createdAt ?? row.createdAt,
        updatedAt: operation?.updatedAt ?? row.updatedAt
      });
    })));
  }

  async listEvents(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilRunEvent[]> {
    await this.getRun(context, runId);
    return this.dependencies.repository.listEvents(context, runId);
  }
}

export interface FinancialCouncilPublicDispatchView {
  readonly dispatchId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly portfolioRevision: number;
  readonly portfolioKind: "balanced" | "cash_first" | "growth_first";
  readonly actionId: string;
  readonly status: FinancialCouncilDispatchOperationStatus;
  readonly attempt: number;
  readonly receiptId: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type { FinancialSnapshot };
