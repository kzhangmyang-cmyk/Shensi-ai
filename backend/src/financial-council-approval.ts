import type { FinancialCouncilPortfolioKind } from
  "./growth-contract-types.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { FinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import type { FinancialCouncilSourceVerifier } from
  "./financial-council-source-verifier.js";
import {
  GROWTH_CAPABILITIES,
  requireGrowthCapabilities,
  type GrowthCapability
} from "./growth-capabilities.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";

export interface CreateFinancialCouncilApprovalRecordInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly approvedActionIds: readonly string[];
  readonly approvedActionHashes: readonly {
    readonly actionId: string;
    readonly actionHash: `sha256:${string}`;
  }[];
  readonly requiredCapabilities: readonly string[];
  readonly approverId: string;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly policyVersionId: string;
  readonly policyHash: `sha256:${string}`;
  readonly sourceSetHash: `sha256:${string}`;
  readonly commandKeyHash: `sha256:${string}`;
  readonly commandRequestHash: `sha256:${string}`;
  readonly status: "approved" | "rejected";
  readonly reason: string | null;
  readonly approvedAt: string;
}

export interface FinancialCouncilApprovalRecord
extends CreateFinancialCouncilApprovalRecordInput {
  readonly approvalId: `sha256:${string}`;
  readonly approvalHash: `sha256:${string}`;
}

export interface FinancialCouncilDispatchOutboxRow {
  readonly dispatchId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly approvalId: `sha256:${string}`;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly actionId: string;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly actionHash: `sha256:${string}`;
  readonly resultHash: `sha256:${string}`;
  readonly status: "queued";
  readonly attempt: 0;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const KINDS = new Set(["cash_first", "growth_first", "balanced"]);

function invalid(code = "financial_council_approval_invalid"): never {
  throw financialCouncilError(code);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value !== "";
}

function hash(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && HASH.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function createFinancialCouncilApprovalRecord(
  rawInput: CreateFinancialCouncilApprovalRecordInput
): FinancialCouncilApprovalRecord {
  const input = immutableFinancialCouncilInput(rawInput);
  const keys = Object.keys(input);
  const expected = ["workspaceId", "runId", "portfolioRevision",
    "portfolioKind", "approvedActionIds", "approvedActionHashes",
    "requiredCapabilities",
    "approverId", "portfolioOutputHash", "snapshotId", "snapshotHash",
    "policyVersionId", "policyHash", "sourceSetHash", "commandKeyHash",
    "commandRequestHash", "status", "reason", "approvedAt"];
  if (keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(input, key))
    || keys.some((key) => !expected.includes(key))
    || !nonempty(input.workspaceId) || !nonempty(input.runId)
    || !Number.isSafeInteger(input.portfolioRevision)
    || input.portfolioRevision < 1 || !KINDS.has(input.portfolioKind)
    || !Array.isArray(input.approvedActionIds)
    || !Array.isArray(input.approvedActionHashes)
    || !Array.isArray(input.requiredCapabilities)
    || !input.approvedActionIds.every(nonempty)
    || !input.approvedActionHashes.every((row) => nonempty(row.actionId)
      && hash(row.actionHash))
    || input.approvedActionHashes.length !== input.approvedActionIds.length
    || input.approvedActionHashes.some((row, index) =>
      row.actionId !== input.approvedActionIds[index])
    || !input.requiredCapabilities.every(nonempty)
    || new Set(input.approvedActionIds).size !== input.approvedActionIds.length
    || new Set(input.requiredCapabilities).size
      !== input.requiredCapabilities.length
    || !nonempty(input.approverId) || !nonempty(input.snapshotId)
    || !nonempty(input.policyVersionId)
    || ![input.portfolioOutputHash, input.snapshotHash, input.policyHash,
      input.sourceSetHash, input.commandKeyHash,
      input.commandRequestHash].every(hash)
    || !["approved", "rejected"].includes(input.status)
    || (input.reason !== null && !nonempty(input.reason))
    || !timestamp(input.approvedAt)
    || (input.status === "approved" && input.approvedActionIds.length === 0)
    || (input.status === "rejected" && (input.approvedActionIds.length !== 0
      || input.approvedActionHashes.length !== 0))) {
    invalid();
  }
  const approvalId = financialCouncilCanonicalHash({
    workspaceId: input.workspaceId,
    runId: input.runId,
    portfolioRevision: input.portfolioRevision,
    portfolioKind: input.portfolioKind,
    status: input.status,
    commandKeyHash: input.commandKeyHash
  });
  const preimage = { approvalId, ...input };
  return immutableFinancialCouncilValue({
    ...preimage,
    approvalHash: financialCouncilCanonicalHash(preimage)
  });
}

export function assertFinancialCouncilApprovalRecord(
  value: unknown
): asserts value is FinancialCouncilApprovalRecord {
  if (!value || typeof value !== "object") invalid();
  const { approvalId, approvalHash, ...input } = value as
    FinancialCouncilApprovalRecord;
  const rebuilt = createFinancialCouncilApprovalRecord(input);
  if (approvalId !== rebuilt.approvalId || approvalHash !== rebuilt.approvalHash) {
    invalid();
  }
}

export function createFinancialCouncilDispatchOutboxRows(
  rawApproval: FinancialCouncilApprovalRecord
): readonly FinancialCouncilDispatchOutboxRow[] {
  assertFinancialCouncilApprovalRecord(rawApproval);
  if (rawApproval.status === "rejected") return Object.freeze([]);
  return immutableFinancialCouncilValue(rawApproval.approvedActionHashes.map(
    ({ actionId, actionHash }) => ({
      dispatchId: financialCouncilCanonicalHash({
        approvalId: rawApproval.approvalId, actionId
      }),
      workspaceId: rawApproval.workspaceId,
      runId: rawApproval.runId,
      approvalId: rawApproval.approvalId,
      approvalHash: rawApproval.approvalHash,
      portfolioRevision: rawApproval.portfolioRevision,
      portfolioKind: rawApproval.portfolioKind,
      actionId,
      portfolioOutputHash: rawApproval.portfolioOutputHash,
      actionHash,
      resultHash: financialCouncilCanonicalHash({
        approvalHash: rawApproval.approvalHash,
        portfolioOutputHash: rawApproval.portfolioOutputHash,
        actionHash
      }),
      status: "queued" as const,
      attempt: 0 as const,
      createdAt: rawApproval.approvedAt,
      updatedAt: rawApproval.approvedAt
    })
  ));
}

export interface FinancialCouncilApprovalProof {
  readonly approvalId: `sha256:${string}`;
  readonly approvalHash: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly actionId: string;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly snapshotHash: `sha256:${string}`;
  readonly policyHash: `sha256:${string}`;
  readonly approvedAt: string;
  readonly approverId: string;
}

export interface FinancialCouncilApprovalProofRepository {
  getApproval(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    approvalId: string
  ): Promise<FinancialCouncilApprovalRecord | null>;
}

export class FinancialCouncilApprovalProofIssuer {
  readonly #issued = new WeakSet<object>();

  constructor(private readonly repository:
  FinancialCouncilApprovalProofRepository) {
    if (typeof repository?.getApproval !== "function") {
      throw new Error("invalid_financial_council_approval_proof_issuer");
    }
  }

  async issue(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly actionId: string;
  }): Promise<FinancialCouncilApprovalProof> {
    const stable = immutableFinancialCouncilInput(input);
    if (!nonempty(stable.workspaceId) || !nonempty(stable.runId)
      || !hash(stable.approvalId) || !nonempty(stable.actionId)) invalid(
        "financial_council_approval_proof_invalid");
    const approval = await this.repository.getApproval(
      { workspaceId: stable.workspaceId }, stable.approvalId
    );
    if (!approval) invalid("financial_council_approval_proof_invalid");
    assertFinancialCouncilApprovalRecord(approval);
    if (approval.workspaceId !== stable.workspaceId
      || approval.runId !== stable.runId || approval.status !== "approved"
      || !approval.approvedActionIds.includes(stable.actionId)) {
      invalid("financial_council_approval_proof_invalid");
    }
    const proof = immutableFinancialCouncilValue({
      approvalId: approval.approvalId,
      approvalHash: approval.approvalHash,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      portfolioRevision: approval.portfolioRevision,
      portfolioKind: approval.portfolioKind,
      actionId: stable.actionId,
      portfolioOutputHash: approval.portfolioOutputHash,
      snapshotHash: approval.snapshotHash,
      policyHash: approval.policyHash,
      approvedAt: approval.approvedAt,
      approverId: approval.approverId
    });
    this.#issued.add(proof);
    return proof;
  }

  verify(value: unknown): FinancialCouncilApprovalProof {
    if (!value || typeof value !== "object" || !this.#issued.has(value)) {
      invalid("financial_council_approval_proof_invalid");
    }
    return value as FinancialCouncilApprovalProof;
  }
}

export interface FinancialCouncilApprovalCommandInput {
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
}

export interface FinancialCouncilRejectionCommandInput
extends FinancialCouncilApprovalCommandInput {
  readonly reason: string;
}

export interface FinancialCouncilApprovalServiceDependencies {
  readonly repository: FinancialCouncilRepository;
  readonly policyRepository: FinancialCouncilPolicyRepository;
  readonly sourceVerifier: FinancialCouncilSourceVerifier;
  readonly now?: () => string;
}

function validateDecisionInput(
  raw: unknown,
  rejecting: boolean
): FinancialCouncilApprovalCommandInput | FinancialCouncilRejectionCommandInput {
  const input = immutableFinancialCouncilInput(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const keys = Object.keys(input);
  const expected = rejecting
    ? ["runId", "portfolioRevision", "portfolioKind", "reason"]
    : ["runId", "portfolioRevision", "portfolioKind"];
  const row = input as Record<string, unknown>;
  if (keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(row, key))
    || keys.some((key) => !expected.includes(key))
    || !nonempty(row.runId) || !Number.isSafeInteger(row.portfolioRevision)
    || Number(row.portfolioRevision) < 1
    || typeof row.portfolioKind !== "string"
    || !KINDS.has(row.portfolioKind)
    || (rejecting && !nonempty(row.reason))) invalid();
  return input as FinancialCouncilApprovalCommandInput
    | FinancialCouncilRejectionCommandInput;
}

function approvalCommandKeyHash(command: CommandContext): `sha256:${string}` {
  return financialCouncilCanonicalHash({
    workspaceId: command.workspace.workspaceId,
    actorId: command.actorId,
    idempotencyKeyHash: growthHttpIdempotencyKeyHash(command.idempotencyKey)
  });
}

function exactCapabilities(values: readonly string[]): readonly GrowthCapability[] {
  const registry = new Set<string>(GROWTH_CAPABILITIES);
  if (values.some((value) => !registry.has(value))) invalid();
  return values as readonly GrowthCapability[];
}

export class FinancialCouncilApprovalService {
  readonly #now: () => string;

  constructor(private readonly dependencies:
  FinancialCouncilApprovalServiceDependencies) {
    if (typeof dependencies?.repository?.commitApprovalDecision !== "function"
      || typeof dependencies?.policyRepository?.findActive !== "function"
      || typeof dependencies?.sourceVerifier?.verifyCurrentSources
        !== "function") {
      throw new Error("invalid_financial_council_approval_service");
    }
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  approve(command: CommandContext, input: FinancialCouncilApprovalCommandInput) {
    return this.decide(command, input, "approved");
  }

  reject(command: CommandContext, input: FinancialCouncilRejectionCommandInput) {
    return this.decide(command, input, "rejected");
  }

  private async decide(
    rawCommand: CommandContext,
    rawInput: FinancialCouncilApprovalCommandInput
      | FinancialCouncilRejectionCommandInput,
    status: "approved" | "rejected"
  ) {
    const command = immutableFinancialCouncilInput(rawCommand);
    const input = validateDecisionInput(rawInput, status === "rejected");
    if (!command?.workspace || command.actorId !== command.workspace.actorId
      || command.expectedRevision === null) invalid();
    requireGrowthCapabilities(command.workspace, ["finance.council.approve"]);
    const verified = await this.dependencies.repository.getVerifiedRunSnapshot(
      command.workspace, input.runId
    );
    if (!verified) throw financialCouncilError(
      "financial_council_run_not_found"
    );
    const existingPublic = verified.run.approval;
    if (existingPublic) {
      const existing = await this.dependencies.repository.getApproval(
        command.workspace, existingPublic.approvalId
      );
      if (existing?.commandKeyHash === approvalCommandKeyHash(command)) {
        if (existing.commandRequestHash !== command.requestHash) {
          throw financialCouncilError("financial_council_idempotency_conflict");
        }
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_approval_conflict");
    }
    const { run, snapshot } = verified;
    if (run.status !== "awaiting_approval") throw financialCouncilError(
      "financial_council_approval_state_invalid"
    );
    if (run.revision !== command.expectedRevision) throw financialCouncilError(
      "financial_council_revision_conflict"
    );
    if (run.latestPortfolioRevision !== input.portfolioRevision) {
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    const revision = await this.dependencies.repository.getPortfolioRevision(
      command.workspace, run.runId, input.portfolioRevision
    );
    if (!revision) throw financialCouncilError(
      "financial_council_portfolio_not_found"
    );
    const portfolio = revision.portfolios.find((row) =>
      row.kind === input.portfolioKind);
    if (!portfolio) throw financialCouncilError(
      "financial_council_portfolio_not_found"
    );
    const required = Object.freeze([...new Set([
      "finance.council.approve", ...portfolio.requiredApprovalCapabilities
    ])]);
    requireGrowthCapabilities(command.workspace, exactCapabilities(required));
    const approvedAt = this.#now();
    if (!timestamp(approvedAt) || Date.parse(approvedAt) > Date.parse(run.expiresAt)
      || Date.parse(approvedAt) > Date.parse(portfolio.expiresAt)
      || (status === "approved" && (portfolio.actions.length === 0
        || portfolio.hardConstraints.some((row) => !row.satisfied)))) {
      throw financialCouncilError("financial_council_approval_invalid");
    }
    const activePolicy = await this.dependencies.policyRepository.findActive(
      command.workspace
    );
    if (!activePolicy || activePolicy.policyVersionId !== revision.policyVersionId
      || activePolicy.policyHash !== revision.policyHash) {
      await this.markStale(command, run.runId, "policy_changed");
      throw financialCouncilError("financial_council_policy_stale");
    }
    const control = await this.dependencies.repository.getAnalysisControl(
      command.workspace, run.runId
    );
    if (!control) throw financialCouncilError("financial_council_integrity");
    let sources;
    try {
      sources = await this.dependencies.sourceVerifier.verifyCurrentSources(
        command.workspace, snapshot, {
          workspaceId: run.workspaceId,
          ownerId: control.ownerId,
          teamId: control.teamId
        }
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "financial_council_source_stale"
        || code === "financial_council_workspace_stale") {
        await this.markStale(command, run.runId, String(code));
      }
      throw error;
    }
    const approval = createFinancialCouncilApprovalRecord({
      workspaceId: run.workspaceId,
      runId: run.runId,
      portfolioRevision: input.portfolioRevision,
      portfolioKind: input.portfolioKind,
      approvedActionIds: status === "approved"
        ? portfolio.actionIds : Object.freeze([]),
      approvedActionHashes: status === "approved"
        ? portfolio.actions.map((action) => ({
            actionId: action.actionId,
            actionHash: financialCouncilCanonicalHash(action)
          })) : Object.freeze([]),
      requiredCapabilities: required,
      approverId: command.actorId,
      portfolioOutputHash: financialCouncilCanonicalHash(portfolio),
      snapshotId: revision.snapshotId,
      snapshotHash: revision.snapshotHash,
      policyVersionId: revision.policyVersionId,
      policyHash: revision.policyHash,
      sourceSetHash: sources.sourceSetHash,
      commandKeyHash: approvalCommandKeyHash(command),
      commandRequestHash: command.requestHash as `sha256:${string}`,
      status,
      reason: status === "rejected"
        ? (input as FinancialCouncilRejectionCommandInput).reason : null,
      approvedAt
    });
    return this.dependencies.repository.commitApprovalDecision(command, {
      approval,
      outbox: createFinancialCouncilDispatchOutboxRows(approval),
      verifiedTemporalSequence: sources.temporalSequence
    });
  }

  private async markStale(
    command: CommandContext,
    runId: string,
    reasonCode: string
  ) {
    try {
      await this.dependencies.repository.transitionRun(command, {
        runId,
        kind: "stale",
        occurredAt: this.#now(),
        reasonCode
      });
    } catch {
      // A concurrent terminal decision wins; the original stale error is stable.
    }
  }
}
