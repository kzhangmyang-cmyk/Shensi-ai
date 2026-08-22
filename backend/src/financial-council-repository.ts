import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import { canonicalBusinessReportInput } from "./business-advisor/domain.js";
import {
  FINANCIAL_COUNCIL_RUN_STATUSES,
  applyFinancialCouncilTransition,
  createFinancialCouncilRunEvent,
  financialCouncilAggregateHash,
  financialCouncilCanonicalJson,
  financialCouncilCanonicalHash,
  financialCouncilError,
  financialCouncilTransitionIsAllowed,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun,
  type FinancialCouncilRunEvent,
  type FinancialCouncilTransitionKind,
  type FinancialSnapshotRecord
} from "./financial-council-domain.js";
import {
  validateFinancialSnapshot,
  validateFinancialSnapshotForRun,
  type FinancialSnapshot
} from "./financial-council-snapshot.js";
import type {
  FinancialCouncilModelBinding,
  FinancialCouncilModelResult,
  FinancialCouncilRebutInput,
  FinancialCouncilRebutOutput
} from "./financial-council-model-port.js";
import type { FinancialCouncilAuditGraph } from
  "./financial-council-audit.js";
import {
  assertFinancialCouncilSpecialistResultAuthorized,
  type AuthorizedFinancialCouncilSpecialistResult
} from "./financial-council-finding-validator.js";
import { MODEL_PROVIDER_IDS } from "./model-providers/types.js";
import type {
  ConsensusReport,
  FinancialCouncilActionPortfolio,
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction,
  FinancialCouncilDataGap,
  FinancialCouncilFinding
} from "./growth-contract-types.js";
import { buildConsensus } from "./financial-council-consensus.js";
import { FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS } from
  "./financial-portfolio-constraints.js";
import type { GrowthTemporalTransactionRunner } from
  "./growth-temporal-barrier.js";
import {
  assertFinancialCouncilApprovalRecord,
  createFinancialCouncilDispatchOutboxRows,
  type FinancialCouncilApprovalRecord,
  type FinancialCouncilDispatchOutboxRow
} from "./financial-council-approval.js";
import {
  claimFinancialCouncilDispatchOperation,
  completeFinancialCouncilDispatchOperation,
  createFinancialCouncilDispatchOperation,
  failFinancialCouncilDispatchOperation,
  type ClaimFinancialCouncilDispatchOperationInput,
  type CompleteFinancialCouncilDispatchOperationInput,
  type FinancialCouncilDispatchLease,
  type FinancialCouncilDispatchOperation,
  type FinancialCouncilDispatchReceipt
} from "./financial-council-dispatch-operation.js";

export interface FinancialCouncilCommandResult<T> {
  readonly value: T;
  readonly replayed: boolean;
}

export interface FinancialCouncilPortfolioRevision {
  readonly revisionId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly revision: number;
  readonly baseRevision?: number;
  readonly commandKeyHash?: `sha256:${string}`;
  readonly commandRequestHash?: `sha256:${string}`;
  readonly operationsHash?: `sha256:${string}`;
  readonly runHash: `sha256:${string}`;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly auditHash: `sha256:${string}`;
  readonly policyVersionId: string;
  readonly policyHash: `sha256:${string}`;
  readonly consensusReportId: string;
  readonly candidateSetHash: `sha256:${string}`;
  readonly outputHash: `sha256:${string}`;
  readonly portfolios: readonly FinancialCouncilActionPortfolio[];
  readonly createdAt: string;
}

export interface CreateFinancialCouncilPortfolioRevisionInput
extends Omit<FinancialCouncilPortfolioRevision, "revisionId" | "outputHash"> {}

export interface PublishFinancialCouncilPortfolioRevisionInput {
  readonly revision: 1;
  readonly expectedOutputHash: `sha256:${string}`;
  readonly occurredAt: string;
}

export interface CommitFinancialCouncilPortfolioRevisionInput {
  readonly revision: FinancialCouncilPortfolioRevision;
}

export interface CommitFinancialCouncilApprovalDecisionInput {
  readonly approval: FinancialCouncilApprovalRecord;
  readonly outbox: readonly FinancialCouncilDispatchOutboxRow[];
  readonly verifiedTemporalSequence: number;
}

export interface FinancialCouncilDispatchAction {
  readonly operation: FinancialCouncilDispatchOperation;
  readonly action: FinancialCouncilCandidateAction;
}

export function financialCouncilPortfolioCommandKeyHash(
  command: CommandContext
): `sha256:${string}` {
  return financialCouncilCanonicalHash({
    workspaceId: command.workspace.workspaceId,
    actorId: command.actorId,
    idempotencyKeyHash: growthHttpIdempotencyKeyHash(command.idempotencyKey)
  });
}

export function financialCouncilOptimizationRunHash(
  rawRun: FinancialCouncilRun
): `sha256:${string}` {
  const run = immutableFinancialCouncilInput(rawRun);
  assertFinancialCouncilRunValue(run);
  return financialCouncilCanonicalHash({
    workspaceId: run.workspaceId,
    runId: run.runId,
    creationKeyHash: run.creationKeyHash,
    requestHash: run.requestHash,
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    businessReport: run.businessReport,
    policyVersionId: run.policyVersionId,
    snapshotId: run.snapshotId,
    snapshotHash: run.snapshotHash,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt
  });
}

export function createFinancialCouncilPortfolioRevision(
  rawInput: CreateFinancialCouncilPortfolioRevisionInput
): FinancialCouncilPortfolioRevision {
  try {
    const input = immutableFinancialCouncilInput(rawInput);
    exactObject(input, ["workspaceId", "runId", "revision",
      ...(input.revision === 1 ? [] : ["baseRevision", "commandKeyHash",
        "commandRequestHash", "operationsHash"]), "runHash",
      "snapshotId", "snapshotHash", "auditHash", "policyVersionId",
      "policyHash", "consensusReportId", "candidateSetHash", "portfolios",
      "createdAt"]);
    identifier(input.workspaceId);
    identifier(input.runId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      inputInvalid();
    }
    if (input.revision > 1) {
      if (!Number.isSafeInteger(input.baseRevision)
        || input.baseRevision !== input.revision - 1) inputInvalid();
      hash(input.commandKeyHash);
      hash(input.commandRequestHash);
      hash(input.operationsHash);
    }
    hash(input.runHash);
    identifier(input.snapshotId);
    hash(input.snapshotHash);
    hash(input.auditHash);
    policyVersionId(input.policyVersionId);
    hash(input.policyHash);
    hash(input.consensusReportId);
    hash(input.candidateSetHash);
    timestamp(input.createdAt);
    assertFinancialCouncilPortfolios(
      input.portfolios, input.runId, input.revision
    );
    const outputHash = financialCouncilCanonicalHash(input.portfolios);
    const preimage = { ...input, outputHash };
    return immutableFinancialCouncilValue({
      revisionId: financialCouncilCanonicalHash(preimage),
      ...preimage
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_council_portfolio_invalid") throw error;
    throw financialCouncilError("financial_council_portfolio_invalid");
  }
}

export function selectFinancialCouncilOptimizationCandidates(
  consensus: ConsensusReport,
  results: readonly FinancialCouncilSpecialistResult[]
): readonly FinancialCouncilCandidateAction[] {
  const stableConsensus = immutableFinancialCouncilInput(consensus);
  const stableResults = immutableFinancialCouncilInput(results);
  const allowed = new Set([
    ...stableConsensus.acceptedFindings.map((finding) => finding.findingId),
    ...stableConsensus.minorityFindings.map((finding) => finding.findingId)
  ]);
  const actions = stableResults
    .filter((result) => result.runId === stableConsensus.runId
      && result.phase === "analyze")
    .flatMap((result) => result.actions)
    .filter((action) => action.sourceFindingIds.length > 0
      && action.sourceFindingIds.every((findingId) => allowed.has(findingId)))
    .sort((left, right) => utf8ByteCompare(left.actionId, right.actionId));
  if (actions.some((action, index) => index > 0
    && action.actionId === actions[index - 1]!.actionId)) {
    throw financialCouncilError("financial_council_portfolio_invalid");
  }
  return Object.freeze(actions);
}

export interface StoreFrozenFinancialSnapshotInput {
  readonly runId: string;
  readonly snapshot: FinancialSnapshotRecord;
  readonly occurredAt: string;
}

export interface TransitionFinancialCouncilRunInput {
  readonly runId: string;
  readonly kind: FinancialCouncilTransitionKind;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
}

export interface FinancialCouncilAnalysisLease {
  readonly workspaceId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface FinancialCouncilAnalysisControl {
  readonly workspaceId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly teamId: string;
  readonly lease: FinancialCouncilAnalysisLease | null;
  readonly createdAt: string;
}

export interface ClaimFinancialCouncilAnalysisRunInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface FinancialCouncilAnalysisGap {
  readonly workspaceId: string;
  readonly runId: string;
  readonly role: FinancialCouncilAgentRole;
  readonly code: "specialist_unavailable" | "tax_input_missing";
  readonly detail: null;
  readonly createdAt: string;
  readonly gapHash: `sha256:${string}`;
}

export interface FinancialCouncilLeaseWrite {
  readonly lease: FinancialCouncilAnalysisLease;
  readonly completedAt: string;
}

export interface CreateAndFreezeFinancialCouncilRunInput {
  readonly aggregate: FinancialCouncilRun;
  readonly snapshot: FinancialSnapshotRecord;
  readonly occurredAt: string;
}

export interface ListRunnableFinancialCouncilRunsInput {
  readonly after: {
    readonly workspaceId: string;
    readonly runId: string;
  } | null;
  readonly limit: number;
}

export type FinancialCouncilSpecialistPhase = "analyze" | "rebut";

export interface VerifiedFinancialCouncilRunSnapshot {
  readonly run: FinancialCouncilRun;
  readonly snapshot: FinancialSnapshot;
}

export interface FinancialCouncilSpecialistResult {
  readonly resultId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly role: FinancialCouncilAgentRole;
  readonly phase: FinancialCouncilSpecialistPhase;
  readonly attempt: number;
  readonly outputHash: `sha256:${string}`;
  readonly modelBinding: FinancialCouncilModelBinding;
  readonly repaired: boolean;
  readonly providerRequestId: string | null;
  readonly findings: readonly FinancialCouncilFinding[];
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly createdAt: string;
  readonly resultHash: `sha256:${string}`;
}

export type FinancialCouncilFindingDispositionStatus =
  | "unresolved" | "upheld" | "revised" | "withdrawn";

export interface FinancialCouncilFindingDisposition {
  readonly workspaceId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly graphId: `sha256:${string}`;
  readonly findingId: string;
  readonly role: FinancialCouncilAgentRole;
  readonly status: FinancialCouncilFindingDispositionStatus;
  readonly blockingConflictIds: readonly `sha256:${string}`[];
  readonly updatedAt: string;
  readonly dispositionHash: `sha256:${string}`;
}

export interface FinancialCouncilRebuttalAttempt {
  readonly attemptId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly graphId: `sha256:${string}`;
  readonly role: FinancialCouncilAgentRole;
  readonly round: 1;
  readonly edgeId: `sha256:${string}`;
  readonly targetFindingId: string;
  readonly inputHash: `sha256:${string}`;
  readonly input: FinancialCouncilRebutInput;
  readonly status: "reserved" | "completed";
  readonly result: FinancialCouncilModelResult<FinancialCouncilRebutOutput>
    | null;
  readonly outputHash: `sha256:${string}` | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly attemptHash: `sha256:${string}`;
}

export interface InitialFinancialCouncilFindingDisposition {
  readonly findingId: string;
  readonly role: FinancialCouncilAgentRole;
  readonly status: "unresolved";
  readonly blockingConflictIds: readonly `sha256:${string}`[];
}

export interface CompleteFinancialCouncilRebuttalInput {
  readonly attemptId: `sha256:${string}`;
  readonly inputHash: `sha256:${string}`;
  readonly result: FinancialCouncilModelResult<FinancialCouncilRebutOutput>;
  readonly completedAt: string;
  readonly disposition: {
    readonly status: Exclude<FinancialCouncilFindingDispositionStatus,
    "unresolved">;
    readonly blockingConflictIds: readonly `sha256:${string}`[];
  };
}

export interface FinancialCouncilRepository {
  createAndFreezeRun(
    command: CommandContext,
    input: CreateAndFreezeFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
  createRun(
    command: CommandContext,
    aggregate: FinancialCouncilRun
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
  findFrozenRunByCreationKey(
    context: ActiveWorkspaceContext,
    creationKeyHash: string,
    requestHash: string
  ): Promise<FinancialCouncilRun | null>;
  findRun(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilRun | null>;
  getVerifiedRunSnapshot(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<VerifiedFinancialCouncilRunSnapshot | null>;
  listEvents(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilRunEvent[]>;
  storeFrozenSnapshot(
    command: CommandContext,
    input: StoreFrozenFinancialSnapshotInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
  transitionRun(
    command: CommandContext,
    input: TransitionFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
  listRunnableRuns(
    input: ListRunnableFinancialCouncilRunsInput
  ): Promise<readonly FinancialCouncilRun[]>;
  getAnalysisControl(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilAnalysisControl | null>;
  claimAnalysisRun(
    input: ClaimFinancialCouncilAnalysisRunInput
  ): Promise<FinancialCouncilAnalysisLease | null>;
  releaseAnalysisLease(
    lease: FinancialCouncilAnalysisLease,
    releasedAt: string
  ): Promise<void>;
  transitionRunWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: Omit<TransitionFinancialCouncilRunInput, "runId">
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
  listRecoverableAnalysisRuns(
    now: string,
    limit: number
  ): Promise<readonly FinancialCouncilRun[]>;
  storeAnalysisGap(
    lease: FinancialCouncilAnalysisLease,
    gap: FinancialCouncilAnalysisGap
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAnalysisGap>>;
  listAnalysisGaps(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilAnalysisGap[]>;
  storeSpecialistResult(
    context: ActiveWorkspaceContext,
    result: AuthorizedFinancialCouncilSpecialistResult,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<
  AuthorizedFinancialCouncilSpecialistResult>>;
  getSpecialistResult(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole,
    phase: FinancialCouncilSpecialistPhase
  ): Promise<FinancialCouncilSpecialistResult | null>;
  listSpecialistResults(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilSpecialistResult[]>;
  storeAuditGraph(
    context: ActiveWorkspaceContext,
    graph: FinancialCouncilAuditGraph,
    dispositions: readonly InitialFinancialCouncilFindingDisposition[],
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAuditGraph>>;
  getAuditGraph(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilAuditGraph | null>;
  reserveRebuttalAttempt(
    context: ActiveWorkspaceContext,
    attempt: FinancialCouncilRebuttalAttempt,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>>;
  getRebuttalAttempt(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole,
    round: number
  ): Promise<FinancialCouncilRebuttalAttempt | null>;
  listRebuttalAttempts(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilRebuttalAttempt[]>;
  completeRebuttalAttempt(
    context: ActiveWorkspaceContext,
    input: CompleteFinancialCouncilRebuttalInput,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>>;
  listFindingDispositions(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilFindingDisposition[]>;
  storeConsensus(
    context: ActiveWorkspaceContext,
    consensus: ConsensusReport,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<ConsensusReport>>;
  getConsensus(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<ConsensusReport | null>;
  storePortfolioRevision(
    revision: FinancialCouncilPortfolioRevision,
    write: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>>;
  getPortfolioRevision(
    context: ActiveWorkspaceContext,
    runId: string,
    revision: number
  ): Promise<FinancialCouncilPortfolioRevision | null>;
  commitPortfolioRevision(
    command: CommandContext,
    input: CommitFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>>;
  commitApprovalDecision(
    command: CommandContext,
    input: CommitFinancialCouncilApprovalDecisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilApprovalRecord>>;
  getApproval(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    approvalId: string
  ): Promise<FinancialCouncilApprovalRecord | null>;
  listDispatchOutbox(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    runId: string
  ): Promise<readonly FinancialCouncilDispatchOutboxRow[]>;
  claimDispatchOperation(input: ClaimFinancialCouncilDispatchOperationInput & {
    readonly workspaceId: string; readonly dispatchId: string;
  }): Promise<FinancialCouncilDispatchLease | null>;
  getDispatchOperation(context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string): Promise<FinancialCouncilDispatchOperation | null>;
  loadDispatchAction(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string
  ): Promise<FinancialCouncilDispatchAction>;
  completeDispatchOperation(lease: FinancialCouncilDispatchLease,
    receipt: FinancialCouncilDispatchReceipt, completedAt: string): Promise<void>;
  failDispatchOperation(lease: FinancialCouncilDispatchLease, input: {
    readonly errorCode: string; readonly retryable: boolean; readonly completedAt: string;
  }): Promise<void>;
  listRecoverableDispatches(now: string, limit: number): Promise<readonly {
    workspaceId: string; dispatchId: `sha256:${string}`;
  }[]>;
  publishPortfolioRevisionWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: PublishFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>>;
}

interface StoredSpecialistFinding {
  readonly role: FinancialCouncilAgentRole;
  readonly phase: FinancialCouncilSpecialistPhase;
  readonly value: FinancialCouncilFinding;
}

interface StoredSpecialistAction {
  readonly role: FinancialCouncilAgentRole;
  readonly phase: FinancialCouncilSpecialistPhase;
  readonly value: FinancialCouncilCandidateAction;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const TRANSITION_KINDS = new Set<string>(
  FINANCIAL_COUNCIL_RUN_STATUSES.filter((status) => status !== "created")
);
const SPECIALIST_ROLES = new Set<string>([
  "finance", "profit", "cost", "cashflow", "tax"
]);
const SPECIALIST_PHASES = new Set<string>(["analyze", "rebut"]);
const SPECIALIST_ACTION_KINDS = new Set<string>([
  "collect_receivable", "review_loss_product_pricing",
  "reduce_cost_anomaly", "prepare_cash_reserve_budget",
  "complete_financial_data", "schedule_tax_review"
]);

export function financialCouncilActionEditIsSafe(
  original: FinancialCouncilCandidateAction,
  edited: FinancialCouncilCandidateAction
): boolean {
  const { ownerRole: _originalOwner, durationDays: _originalDuration,
    ...originalProtected } = original;
  const { ownerRole: _editedOwner, durationDays: _editedDuration,
    ...editedProtected } = edited;
  return Number.isSafeInteger(edited.durationDays)
    && edited.durationDays >= 1 && edited.durationDays <= 365
    && SPECIALIST_ROLES.has(edited.ownerRole)
    && financialCouncilCanonicalJson(originalProtected)
      === financialCouncilCanonicalJson(editedProtected);
}
const SPECIALIST_ACTION_RULES = Object.freeze({
  collect_receivable: {
    role: "cashflow", explanation: "collect_receivable_hypothesis",
    formulaVersion: "eligible-overdue-receivable.v1", durationDays: 30,
    confidenceBps: 7_500, subject: "optional", impact: "cash"
  },
  review_loss_product_pricing: {
    role: "profit", explanation: "review_loss_product_pricing_hypothesis",
    formulaVersion: "loss-product-pricing-gap.v1", durationDays: 14,
    confidenceBps: 7_000, subject: "optional", impact: "profit"
  },
  reduce_cost_anomaly: {
    role: "cost", explanation: "reduce_cost_anomaly_hypothesis",
    formulaVersion: "verified-avoidable-cost.v1", durationDays: 30,
    confidenceBps: 6_500, subject: "null", impact: "profit"
  },
  prepare_cash_reserve_budget: {
    role: "cashflow", explanation: "prepare_cash_reserve_budget_hypothesis",
    formulaVersion: "cash-shortfall.v1", durationDays: 7,
    confidenceBps: 8_000, subject: "null", impact: "negative_cash"
  },
  complete_financial_data: {
    role: "finance", explanation: "complete_financial_data_hypothesis",
    formulaVersion: "financial-data-gaps.v1", durationDays: 14,
    confidenceBps: 9_000, subject: "null", impact: "risk"
  },
  schedule_tax_review: {
    role: "tax", explanation: "税务风险筛查动作；需专业人员复核",
    formulaVersion: "tax-risk.v1", durationDays: 14,
    confidenceBps: 6_000, subject: "null", impact: "risk"
  }
} as const);
const MODEL_PROVIDERS = new Set<string>(MODEL_PROVIDER_IDS);

function inputInvalid(): never {
  throw financialCouncilError("financial_council_input_invalid");
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) inputInvalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) inputInvalid();
  const keys = ownKeys as string[];
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) =>
      !required.includes(key) && !optional.includes(key))) inputInvalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) inputInvalid();
  }
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    inputInvalid();
  }
}

function hash(value: unknown): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !HASH.test(value)) inputInvalid();
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") inputInvalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    inputInvalid();
  }
}

function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) inputInvalid();
}

function stringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) inputInvalid();
  for (const item of value) identifier(item);
}

function specialInvalid(): never {
  throw financialCouncilError("financial_council_specialist_result_invalid");
}

function specialExact(
  value: unknown,
  required: readonly string[]
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    specialInvalid();
  }
  const keys = Reflect.ownKeys(value) as string[];
  if (keys.length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key))) specialInvalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) specialInvalid();
  }
}

function specialId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value
    || value.length < 1 || value.length > 255) specialInvalid();
}

function specialHash(value: unknown): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !HASH.test(value)) specialInvalid();
}

function specialTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") specialInvalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    specialInvalid();
  }
}

function specialInteger(
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER
): asserts value is number {
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum || Number(value) > maximum) specialInvalid();
}

function specialIds(value: unknown, minimum = 0): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) {
    specialInvalid();
  }
  for (const item of value) specialId(item);
  if (new Set(value).size !== value.length) specialInvalid();
}

function assertSpecialistEvidence(value: unknown): void {
  specialExact(value, ["source", "sourceId", "contentHash"]);
  if (!["crm", "quote", "financial_fact", "acquisition_cost", "roi",
    "business_report"].includes(String(value.source))) specialInvalid();
  specialId(value.sourceId);
  specialHash(value.contentHash);
}

function assertSpecialistGap(value: unknown): void {
  specialExact(value, ["code", "source", "sourceId", "description"]);
  if (!["unverified_cost", "unverified_financial_fact", "missing_cogs",
    "unmatched_payment", "missing_commercial_binding",
    "import_requires_review"].includes(String(value.code))
    || !["crm", "quote", "financial_fact", "acquisition_cost", "roi",
      "business_report"].includes(String(value.source))) specialInvalid();
  if (value.sourceId !== null) specialId(value.sourceId);
  specialId(value.description);
}

function assertSpecialistFinding(
  value: unknown,
  outer: Pick<FinancialCouncilSpecialistResult,
  "runId" | "snapshotId" | "role">
): asserts value is FinancialCouncilFinding {
  specialExact(value, ["findingId", "runId", "snapshotId", "agentRole",
    "conclusion", "evidenceRefs", "formulaRef", "confidenceBps", "severity",
    "assumptions", "missingData", "candidateActionIds"]);
  specialId(value.findingId);
  if (value.runId !== outer.runId || value.snapshotId !== outer.snapshotId
    || value.agentRole !== outer.role) specialInvalid();
  specialId(value.conclusion);
  if (value.conclusion !== (outer.role === "tax"
    ? "税务风险需专业人员复核" : "risk_hypothesis")) specialInvalid();
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1
    || value.evidenceRefs.length > 100) specialInvalid();
  for (const ref of value.evidenceRefs) assertSpecialistEvidence(ref);
  if (value.formulaRef !== null) {
    specialExact(value.formulaRef,
      ["formulaVersion", "inputHash", "resultHash"]);
    specialId(value.formulaRef.formulaVersion);
    specialHash(value.formulaRef.inputHash);
    specialHash(value.formulaRef.resultHash);
  }
  specialInteger(value.confidenceBps, 0, 10_000);
  if (!["info", "warning", "critical"].includes(String(value.severity))) {
    specialInvalid();
  }
  specialIds(value.assumptions);
  if (outer.role === "tax" && value.assumptions.length !== 0) specialInvalid();
  if (!Array.isArray(value.missingData) || value.missingData.length > 100) {
    specialInvalid();
  }
  for (const gap of value.missingData) assertSpecialistGap(gap);
  specialIds(value.candidateActionIds);
}

function assertScenario(
  value: unknown,
  bps: boolean
): void {
  specialExact(value, ["conservative", "base", "optimistic"]);
  for (const key of ["conservative", "base", "optimistic"] as const) {
    specialInteger(value[key], bps ? 0 : Number.MIN_SAFE_INTEGER,
      bps ? 10_000 : Number.MAX_SAFE_INTEGER);
  }
  if (Number(value.conservative) > Number(value.base)
    || Number(value.base) > Number(value.optimistic)) specialInvalid();
}

function assertSpecialistAction(
  value: unknown,
  outer: Pick<FinancialCouncilSpecialistResult, "role">,
  findingsById: ReadonlyMap<string, FinancialCouncilFinding>
): asserts value is FinancialCouncilCandidateAction {
  specialExact(value, ["actionId", "kind", "sourceFindingIds", "ownerRole",
    "subjectRef", "explanation", "durationDays", "prerequisites",
    "mutuallyExclusiveWith", "cashImpact", "profitImpact",
    "riskReductionBps", "budgetCostMinor", "capacityUnits", "confidenceBps",
    "requiredCapabilities", "requiresHumanApproval"]);
  specialHash(value.actionId);
  if (!SPECIALIST_ACTION_KINDS.has(String(value.kind))) specialInvalid();
  const rule = SPECIALIST_ACTION_RULES[
    value.kind as keyof typeof SPECIALIST_ACTION_RULES
  ];
  if (!rule || value.ownerRole !== outer.role || value.ownerRole !== rule.role) {
    specialInvalid();
  }
  specialIds(value.sourceFindingIds, 1);
  const sourceFindings = value.sourceFindingIds.map((id) => {
    const finding = findingsById.get(id);
    if (!finding?.formulaRef
      || finding.formulaRef.formulaVersion !== rule.formulaVersion) {
      return specialInvalid();
    }
    return finding;
  });
  if (value.subjectRef !== null) specialId(value.subjectRef);
  if (rule.subject === "null" && value.subjectRef !== null) specialInvalid();
  specialId(value.explanation);
  if (value.explanation !== rule.explanation) specialInvalid();
  specialInteger(value.durationDays, 0);
  if (value.durationDays !== rule.durationDays) specialInvalid();
  specialIds(value.prerequisites);
  specialIds(value.mutuallyExclusiveWith);
  const formulaPrerequisites = new Set(sourceFindings.map((finding) =>
    `formula:${finding.formulaRef!.formulaVersion}:`
      + `${finding.formulaRef!.inputHash}:${finding.formulaRef!.resultHash}`));
  if (formulaPrerequisites.size !== 1 || value.prerequisites.length !== 1
    || !formulaPrerequisites.has(value.prerequisites[0]!)
    || value.mutuallyExclusiveWith.length !== 0) specialInvalid();
  assertScenario(value.cashImpact, false);
  assertScenario(value.profitImpact, false);
  assertScenario(value.riskReductionBps, true);
  specialInteger(value.budgetCostMinor, 0);
  specialInteger(value.capacityUnits, 0);
  specialInteger(value.confidenceBps, 0, 10_000);
  specialIds(value.requiredCapabilities);
  if (value.budgetCostMinor !== 0 || value.capacityUnits !== 1
    || value.confidenceBps !== rule.confidenceBps
    || value.requiredCapabilities.length !== 0
    || value.requiresHumanApproval !== true) specialInvalid();
  const cash = Object.values(value.cashImpact as Record<string, number>);
  const profit = Object.values(value.profitImpact as Record<string, number>);
  const risk = Object.values(value.riskReductionBps as Record<string, number>);
  const zero = (values: readonly number[]) => values.every((item) => item === 0);
  if ((rule.impact === "cash"
      && (!zero(profit) || !zero(risk) || cash.some((item) => item < 0)))
    || (rule.impact === "profit"
      && (!zero(cash) || !zero(risk) || profit.some((item) => item < 0)))
    || (rule.impact === "negative_cash"
      && (!zero(profit) || !zero(risk) || cash.some((item) => item > 0)))
    || (rule.impact === "risk" && (!zero(cash) || !zero(profit)))) {
    specialInvalid();
  }
}

function assertModelBinding(
  value: unknown,
  outer: Pick<FinancialCouncilSpecialistResult,
  "runId" | "snapshotId" | "snapshotHash" | "role" | "phase" | "attempt">
): asserts value is FinancialCouncilModelBinding {
  specialExact(value, ["jobId", "runId", "snapshotId", "snapshotHash",
    "role", "phase", "attempt", "connectionId", "credentialVersion",
    "provider", "model", "capabilitySnapshotHash", "baseUrlFingerprint",
    "promptVersion", "schemaVersion", "contentHash", "promptHash",
    "schemaHash"]);
  for (const key of ["jobId", "connectionId", "model", "baseUrlFingerprint",
    "promptVersion", "schemaVersion"] as const) specialId(value[key]);
  for (const key of ["snapshotHash", "capabilitySnapshotHash", "contentHash",
    "promptHash", "schemaHash"] as const) specialHash(value[key]);
  specialInteger(value.credentialVersion, 1);
  if (!MODEL_PROVIDERS.has(String(value.provider))
    || value.runId !== outer.runId || value.snapshotId !== outer.snapshotId
    || value.snapshotHash !== outer.snapshotHash || value.role !== outer.role
    || value.phase !== outer.phase || value.attempt !== outer.attempt
    || value.jobId !== `financial-council:${outer.runId}:${outer.role}:`
      + `${outer.phase}:${outer.attempt}`) specialInvalid();
}

export function validateFinancialCouncilSpecialistResult(
  raw: unknown
): FinancialCouncilSpecialistResult {
  try {
    const stable = immutableFinancialCouncilInput(raw) as unknown;
    specialExact(stable, ["resultId", "workspaceId", "runId", "snapshotId",
      "snapshotHash", "role", "phase", "attempt", "outputHash",
      "modelBinding", "repaired", "providerRequestId", "findings", "actions",
      "createdAt", "resultHash"]);
    specialHash(stable.resultId);
    specialId(stable.workspaceId);
    specialId(stable.runId);
    specialId(stable.snapshotId);
    specialHash(stable.snapshotHash);
    if (!SPECIALIST_ROLES.has(String(stable.role))
      || !SPECIALIST_PHASES.has(String(stable.phase))) specialInvalid();
    specialInteger(stable.attempt, 1, 100);
    specialHash(stable.outputHash);
    specialTimestamp(stable.createdAt);
    if (typeof stable.repaired !== "boolean") specialInvalid();
    if (stable.providerRequestId !== null) specialId(stable.providerRequestId);
    const result = stable as unknown as FinancialCouncilSpecialistResult;
    assertModelBinding(result.modelBinding, result);
    if (!Array.isArray(result.findings) || result.findings.length < 1
      || result.findings.length > 24) specialInvalid();
    const findingsById = new Map<string, FinancialCouncilFinding>();
    for (const finding of result.findings) {
      assertSpecialistFinding(finding, result);
      if (findingsById.has(finding.findingId)) specialInvalid();
      findingsById.set(finding.findingId, finding);
    }
    if (!Array.isArray(result.actions) || result.actions.length > 24) {
      specialInvalid();
    }
    const actionIds = new Set<string>();
    for (const action of result.actions) {
      assertSpecialistAction(action, result, findingsById);
      if (actionIds.has(action.actionId)) specialInvalid();
      actionIds.add(action.actionId);
    }
    for (const finding of result.findings) {
      if (finding.candidateActionIds.some((id: string) => !actionIds.has(id))) {
        specialInvalid();
      }
      const expected = result.actions.filter((action) =>
        action.sourceFindingIds.includes(finding.findingId))
        .map((action) => action.actionId).sort();
      if (financialCouncilCanonicalJson(expected)
        !== financialCouncilCanonicalJson(finding.candidateActionIds)) {
        specialInvalid();
      }
    }
    const { resultHash, ...preimage } = result;
    specialHash(resultHash);
    if (financialCouncilCanonicalHash(preimage) !== resultHash) specialInvalid();
    return immutableFinancialCouncilValue(result);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_council_specialist_result_invalid") throw error;
    return specialInvalid();
  }
}

function assertWorkspace(value: unknown): void {
  exactObject(value, ["workspaceId", "kind", "actorId", "role", "teamId",
    "capabilities", "capabilityRegistryVersion"]);
  identifier(value.workspaceId);
  if (value.kind !== "team" && value.kind !== "personal") inputInvalid();
  identifier(value.actorId);
  identifier(value.role);
  identifier(value.teamId);
  stringArray(value.capabilities);
  identifier(value.capabilityRegistryVersion);
}

function assertCommand(
  value: unknown,
  revision: "null" | "required"
): asserts value is CommandContext {
  exactObject(value, ["workspace", "actorId", "idempotencyKey", "requestHash",
    "expectedRevision"]);
  assertWorkspace(value.workspace);
  identifier(value.actorId);
  identifier(value.idempotencyKey);
  hash(value.requestHash);
  if (revision === "null") {
    if (value.expectedRevision !== null) inputInvalid();
  } else if (!Number.isSafeInteger(value.expectedRevision)
    || Number(value.expectedRevision) < 1) inputInvalid();
}

function assertCanonicalBusinessReport(value: unknown):
asserts value is FinancialCouncilRun["businessReport"] {
  try {
    const canonical = canonicalBusinessReportInput(
      value as FinancialCouncilRun["businessReport"]
    );
    if (financialCouncilCanonicalJson(canonical)
      !== financialCouncilCanonicalJson(value)) inputInvalid();
  } catch {
    inputInvalid();
  }
}

function policyVersionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === ""
    || [...value].length > 255) inputInvalid();
}

function assertFinancialCouncilPortfolios(
  value: unknown,
  runId: string,
  revision: number
): asserts value is readonly FinancialCouncilActionPortfolio[] {
  if (!Array.isArray(value) || value.length !== 3) inputInvalid();
  const kinds = ["balanced", "cash_first", "growth_first"] as const;
  for (let index = 0; index < kinds.length; index += 1) {
    const portfolio = value[index];
    exactObject(portfolio, ["portfolioId", "runId", "revision", "kind",
      "actionIds", "actions", "hardConstraints", "objectiveScoreBps",
      "scenarioForecast", "sensitivityAnalysis", "rejectedActions",
      "requiredApprovalCapabilities", "expiresAt", "createdAt"]);
    identifier(portfolio.portfolioId);
    if (portfolio.runId !== runId || portfolio.revision !== revision
      || portfolio.kind !== kinds[index]) inputInvalid();
    const actionIds = portfolio.actionIds;
    stringArray(actionIds);
    if (new Set(actionIds).size !== actionIds.length
      || [...actionIds].sort(utf8ByteCompare).some((id, position) =>
        id !== actionIds[position])) inputInvalid();
    if (!Array.isArray(portfolio.actions)
      || portfolio.actions.length !== actionIds.length
      || portfolio.actions.some((action, position) =>
        !action || typeof action !== "object" || Array.isArray(action)
        || (action as FinancialCouncilCandidateAction).actionId
          !== actionIds[position])) inputInvalid();
    if (!Array.isArray(portfolio.hardConstraints)
      || portfolio.hardConstraints.length
        !== FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS.length) inputInvalid();
    for (let constraintIndex = 0;
      constraintIndex < portfolio.hardConstraints.length;
      constraintIndex += 1) {
      const result = portfolio.hardConstraints[constraintIndex];
      exactObject(result, ["code", "satisfied", "reason"]);
      if (result.code
          !== FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS[constraintIndex]
        || typeof result.satisfied !== "boolean"
        || (result.reason !== null && (typeof result.reason !== "string"
          || !result.reason))) inputInvalid();
    }
    integer(portfolio.objectiveScoreBps);
    if (portfolio.objectiveScoreBps < 0
      || portfolio.objectiveScoreBps > 10_000) inputInvalid();
    exactObject(portfolio.scenarioForecast,
      ["cashImpact", "profitImpact", "riskReductionBps"]);
    assertScenario(portfolio.scenarioForecast.cashImpact, false);
    assertScenario(portfolio.scenarioForecast.profitImpact, false);
    assertScenario(portfolio.scenarioForecast.riskReductionBps, true);
    if (!Array.isArray(portfolio.sensitivityAnalysis)) inputInvalid();
    for (const row of portfolio.sensitivityAnalysis) {
      exactObject(row, ["factor", "impactBps"]);
      identifier(row.factor);
      integer(row.impactBps);
      if (row.impactBps < -10_000 || row.impactBps > 10_000) inputInvalid();
    }
    if (!Array.isArray(portfolio.rejectedActions)) inputInvalid();
    for (const row of portfolio.rejectedActions) {
      exactObject(row, ["actionId", "reasonCode", "reason"]);
      identifier(row.actionId);
      identifier(row.reasonCode);
      identifier(row.reason);
    }
    stringArray(portfolio.requiredApprovalCapabilities);
    timestamp(portfolio.expiresAt);
    timestamp(portfolio.createdAt);
  }
}

const RUN_KEYS = ["runId", "workspaceId", "creationKeyHash", "requestHash",
  "currency", "status", "revision", "dataAsOf", "businessReport",
  "policyVersionId", "snapshotId", "snapshotHash", "consensusReport",
  "portfolios", "latestPortfolioRevision", "approval", "createdAt",
  "updatedAt", "expiresAt"] as const;

function assertPublicApproval(value: unknown, run: FinancialCouncilRun): void {
  exactObject(value, ["approvalId", "runId", "portfolioRevision", "status",
    "portfolioKind", "approvedActionIds", "requiredCapabilities", "reason", "approvedAt"]);
  identifier(value.approvalId);
  identifier(value.runId);
  integer(value.portfolioRevision);
  if (value.portfolioKind !== "cash_first" && value.portfolioKind !== "growth_first"
    && value.portfolioKind !== "balanced") inputInvalid();
  if (value.runId !== run.runId
    || value.portfolioRevision !== run.latestPortfolioRevision
    || (value.status !== "approved" && value.status !== "rejected")
    || value.status !== run.status) inputInvalid();
  stringArray(value.approvedActionIds);
  stringArray(value.requiredCapabilities);
  if (value.reason !== null && (typeof value.reason !== "string" || !value.reason.trim())) {
    inputInvalid();
  }
  timestamp(value.approvedAt);
  if ((value.status === "approved" && value.approvedActionIds.length === 0)
    || (value.status === "rejected" && value.approvedActionIds.length !== 0)) {
    inputInvalid();
  }
}

export function assertFinancialCouncilRunValue(value: unknown):
asserts value is FinancialCouncilRun {
  financialCouncilCanonicalJson(value);
  exactObject(value, RUN_KEYS);
  identifier(value.runId);
  identifier(value.workspaceId);
  hash(value.creationKeyHash);
  hash(value.requestHash);
  if (value.currency !== "CNY" && value.currency !== "USD") inputInvalid();
  if (!FINANCIAL_COUNCIL_RUN_STATUSES.includes(
    value.status as FinancialCouncilRun["status"])) inputInvalid();
  integer(value.revision);
  if (value.revision < 1) inputInvalid();
  timestamp(value.dataAsOf);
  assertCanonicalBusinessReport(value.businessReport);
  if (value.businessReport.currency !== value.currency) inputInvalid();
  policyVersionId(value.policyVersionId);
  if (value.snapshotId !== null) identifier(value.snapshotId);
  if (value.snapshotHash !== null) hash(value.snapshotHash);
  if ((value.snapshotId === null) !== (value.snapshotHash === null)) inputInvalid();
  const latestPortfolioRevision = value.latestPortfolioRevision;
  const published = latestPortfolioRevision !== null;
  if (!published) {
    if (value.consensusReport !== null || !Array.isArray(value.portfolios)
      || value.portfolios.length !== 0 || value.approval !== null) inputInvalid();
  } else {
    if (!Number.isSafeInteger(latestPortfolioRevision)
      || Number(latestPortfolioRevision) < 1 || value.consensusReport === null
      || !["awaiting_approval", "approved", "rejected", "stale", "expired"]
        .includes(String(value.status))) inputInvalid();
    assertFinancialCouncilPortfolios(value.portfolios, value.runId,
      Number(latestPortfolioRevision));
    if (value.status === "approved" || value.status === "rejected") {
      if (value.approval === null) inputInvalid();
      assertPublicApproval(value.approval,
        value as unknown as FinancialCouncilRun);
    } else if (value.approval !== null) inputInvalid();
  }
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  timestamp(value.expiresAt);
}

export function assertFinancialSnapshotRecordValue(value: unknown):
asserts value is FinancialSnapshotRecord {
  exactObject(value, ["snapshotId", "runId", "workspaceId", "snapshotHash",
    "snapshot", "createdAt"]);
  identifier(value.snapshotId);
  identifier(value.runId);
  identifier(value.workspaceId);
  hash(value.snapshotHash);
  timestamp(value.createdAt);
  const snapshot = validateFinancialSnapshot(value.snapshot);
  const nestedHash = snapshot.snapshotHash;
  const { snapshotHash: _snapshotHash, ...preimage } = snapshot;
  if (snapshot.snapshotId !== value.snapshotId
    || snapshot.runId !== value.runId
    || snapshot.workspaceId !== value.workspaceId
    || nestedHash !== value.snapshotHash
    || financialCouncilCanonicalHash(preimage) !== value.snapshotHash) {
    inputInvalid();
  }
}

function historyIntegrity(): never {
  throw financialCouncilError("financial_council_integrity");
}

function assertFinancialCouncilRunEventValue(
  value: unknown
): asserts value is FinancialCouncilRunEvent {
  exactObject(value, ["eventId", "runId", "workspaceId", "revision",
    "fromStatus", "toStatus", "reasonCode", "occurredAt", "actorId",
    "aggregateSnapshotHash", "aggregateSnapshot"]);
  identifier(value.eventId);
  identifier(value.runId);
  identifier(value.workspaceId);
  integer(value.revision);
  if (value.fromStatus !== null
    && !FINANCIAL_COUNCIL_RUN_STATUSES.includes(
      value.fromStatus as FinancialCouncilRun["status"]
    )) inputInvalid();
  if (!FINANCIAL_COUNCIL_RUN_STATUSES.includes(
    value.toStatus as FinancialCouncilRun["status"]
  )) inputInvalid();
  if (value.reasonCode !== null
    && (typeof value.reasonCode !== "string" || value.reasonCode.length < 1
      || value.reasonCode.length > 200)) inputInvalid();
  timestamp(value.occurredAt);
  identifier(value.actorId);
  hash(value.aggregateSnapshotHash);
  assertFinancialCouncilRunValue(value.aggregateSnapshot);
}

export function assertFinancialCouncilRunHistory(
  run: FinancialCouncilRun,
  events: readonly FinancialCouncilRunEvent[],
  fail: () => never = historyIntegrity
): void {
  try {
    assertFinancialCouncilRunValue(run);
    for (const event of events) assertFinancialCouncilRunEventValue(event);
  } catch {
    fail();
  }
  if (events.length === 0) fail();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const previous = events[index - 1];
    if (event.eventId !== `${run.runId}:${index + 1}`
      || event.runId !== run.runId || event.workspaceId !== run.workspaceId
      || event.revision !== index + 1
      || event.aggregateSnapshot.runId !== run.runId
      || event.aggregateSnapshot.workspaceId !== run.workspaceId
      || event.aggregateSnapshot.revision !== event.revision
      || event.aggregateSnapshot.status !== event.toStatus
      || event.aggregateSnapshot.updatedAt !== event.occurredAt
      || event.aggregateSnapshotHash
        !== financialCouncilAggregateHash(event.aggregateSnapshot)
      || (index === 0 && (event.toStatus !== "created"
        || event.fromStatus !== null
        || event.aggregateSnapshot.createdAt !== event.occurredAt))
      || (previous && (event.fromStatus !== previous.toStatus
        || event.toStatus === "created"
        || !financialCouncilTransitionIsAllowed(
          previous.toStatus,
          event.toStatus as FinancialCouncilTransitionKind
        )))) fail();
    if (previous) {
      const transitionBase = event.toStatus === "snapshot_frozen"
        ? immutableFinancialCouncilValue({
            ...previous.aggregateSnapshot,
            snapshotId: event.aggregateSnapshot.snapshotId,
            snapshotHash: event.aggregateSnapshot.snapshotHash
          })
        : event.toStatus === "awaiting_approval"
          ? immutableFinancialCouncilValue({
              ...previous.aggregateSnapshot,
              consensusReport: event.aggregateSnapshot.consensusReport,
              portfolios: event.aggregateSnapshot.portfolios,
              latestPortfolioRevision:
                event.aggregateSnapshot.latestPortfolioRevision
            })
        : event.toStatus === "approved" || event.toStatus === "rejected"
          ? immutableFinancialCouncilValue({
              ...previous.aggregateSnapshot,
              portfolios: event.aggregateSnapshot.portfolios,
              latestPortfolioRevision:
                event.aggregateSnapshot.latestPortfolioRevision,
              approval: event.aggregateSnapshot.approval
            })
        : previous.aggregateSnapshot;
      const expected = applyFinancialCouncilTransition(transitionBase, {
        kind: event.toStatus as FinancialCouncilTransitionKind,
        occurredAt: event.occurredAt,
        actorId: event.actorId
      });
      if (financialCouncilCanonicalJson(expected)
          !== financialCouncilCanonicalJson(event.aggregateSnapshot)
        || (["snapshot_frozen", "awaiting_approval"].includes(event.toStatus)
          && event.actorId !== previous.actorId)) fail();
    }
  }
  const latest = events.at(-1)!;
  if (financialCouncilCanonicalJson(latest.aggregateSnapshot)
      !== financialCouncilCanonicalJson(run)
    || latest.aggregateSnapshotHash !== financialCouncilAggregateHash(run)
    || latest.revision !== run.revision || latest.toStatus !== run.status) {
    fail();
  }
}

export function assertFinancialCouncilCreateMutation(
  command: unknown,
  aggregate: unknown
): asserts aggregate is FinancialCouncilRun {
  assertCommand(command, "null");
  assertFinancialCouncilRunValue(aggregate);
  if (aggregate.workspaceId !== command.workspace.workspaceId
    || aggregate.requestHash !== command.requestHash
    || aggregate.status !== "created" || aggregate.revision !== 1
    || aggregate.snapshotId !== null || aggregate.snapshotHash !== null
    || aggregate.createdAt !== aggregate.updatedAt) inputInvalid();
}

export function assertFinancialCouncilStoreSnapshotMutation(
  command: unknown,
  input: unknown
): asserts input is StoreFrozenFinancialSnapshotInput {
  assertCommand(command, "required");
  exactObject(input, ["runId", "snapshot", "occurredAt"]);
  identifier(input.runId);
  timestamp(input.occurredAt);
  assertFinancialSnapshotRecordValue(input.snapshot);
}

export function assertFinancialCouncilTransitionMutation(
  command: unknown,
  input: unknown
): asserts input is TransitionFinancialCouncilRunInput {
  assertCommand(command, "required");
  exactObject(input, ["runId", "kind", "occurredAt", "reasonCode"]);
  identifier(input.runId);
  if (typeof input.kind !== "string" || !TRANSITION_KINDS.has(input.kind)) {
    inputInvalid();
  }
  timestamp(input.occurredAt);
  if (input.reasonCode !== null
    && (typeof input.reasonCode !== "string" || input.reasonCode.length < 1
      || input.reasonCode.length > 200)) inputInvalid();
}

export function validateFinancialCouncilCreateMutation(
  command: unknown,
  aggregate: unknown
): { readonly command: CommandContext; readonly aggregate: FinancialCouncilRun } {
  const stableCommand = immutableFinancialCouncilInput(command);
  const stableAggregate = immutableFinancialCouncilInput(aggregate);
  assertFinancialCouncilCreateMutation(stableCommand, stableAggregate);
  return {
    command: stableCommand as CommandContext,
    aggregate: stableAggregate
  };
}

export function validateFinancialCouncilStoreSnapshotMutation(
  command: unknown,
  input: unknown
): {
  readonly command: CommandContext;
  readonly input: StoreFrozenFinancialSnapshotInput;
} {
  const stableCommand = immutableFinancialCouncilInput(command);
  const stableInput = immutableFinancialCouncilInput(input);
  assertFinancialCouncilStoreSnapshotMutation(stableCommand, stableInput);
  return { command: stableCommand as CommandContext, input: stableInput };
}

export function validateFinancialCouncilTransitionMutation(
  command: unknown,
  input: unknown
): {
  readonly command: CommandContext;
  readonly input: TransitionFinancialCouncilRunInput;
} {
  const stableCommand = immutableFinancialCouncilInput(command);
  const stableInput = immutableFinancialCouncilInput(input);
  assertFinancialCouncilTransitionMutation(stableCommand, stableInput);
  return { command: stableCommand as CommandContext, input: stableInput };
}

export function validateFinancialCouncilCreateAndFreezeMutation(
  command: unknown,
  input: unknown
): {
  readonly command: CommandContext;
  readonly input: CreateAndFreezeFinancialCouncilRunInput;
} {
  const stableCommand = immutableFinancialCouncilInput(command);
  const stableInput = immutableFinancialCouncilInput(input);
  exactObject(stableInput, ["aggregate", "snapshot", "occurredAt"]);
  assertFinancialCouncilCreateMutation(stableCommand, stableInput.aggregate);
  assertFinancialSnapshotRecordValue(stableInput.snapshot);
  timestamp(stableInput.occurredAt);
  assertFinancialSnapshotRecord(stableInput.aggregate, stableInput.snapshot);
  if (stableInput.snapshot.createdAt !== stableInput.occurredAt) inputInvalid();
  return {
    command: stableCommand as CommandContext,
    input: stableInput as unknown as CreateAndFreezeFinancialCouncilRunInput
  };
}

export function validateListRunnableFinancialCouncilRunsInput(
  input: unknown
): ListRunnableFinancialCouncilRunsInput {
  const stable = immutableFinancialCouncilInput(input);
  exactObject(stable, ["after", "limit"]);
  if (stable.after !== null) {
    exactObject(stable.after, ["workspaceId", "runId"]);
    identifier(stable.after.workspaceId);
    identifier(stable.after.runId);
  }
  if (!Number.isSafeInteger(stable.limit)
    || Number(stable.limit) < 1 || Number(stable.limit) > 100) inputInvalid();
  return stable as unknown as ListRunnableFinancialCouncilRunsInput;
}

function key(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}

function exactRevision(command: CommandContext): number {
  return command.expectedRevision as number;
}

export function assertFinancialSnapshotRecord(
  aggregate: FinancialCouncilRun,
  record: FinancialSnapshotRecord
): void {
  validateFinancialSnapshotForRun(record.snapshot, aggregate);
  const { snapshotHash: _snapshotHash, ...preimage } = record.snapshot;
  if (record.workspaceId !== aggregate.workspaceId
    || record.runId !== aggregate.runId
    || record.snapshot.snapshotId !== record.snapshotId
    || record.snapshot.runId !== record.runId
    || record.snapshot.workspaceId !== record.workspaceId
    || record.snapshot.snapshotHash !== record.snapshotHash
    || financialCouncilCanonicalHash(preimage) !== record.snapshotHash) {
    inputInvalid();
  }
}

export function assertFinancialSnapshotFreezeTime(
  record: FinancialSnapshotRecord,
  events: readonly FinancialCouncilRunEvent[],
  fail: () => never = historyIntegrity
): void {
  const frozenEvents = events.filter((event) =>
    event.toStatus === "snapshot_frozen");
  if (frozenEvents.length !== 1
    || frozenEvents[0]!.occurredAt !== record.createdAt) fail();
}

export function validateFinancialCouncilConsensusReport(
  rawConsensus: unknown,
  expected: {
    readonly graph: FinancialCouncilAuditGraph;
    readonly findings: readonly FinancialCouncilFinding[];
    readonly dispositions: readonly FinancialCouncilFindingDisposition[];
    readonly dataGaps: readonly FinancialCouncilDataGap[];
    readonly earliestCreatedAt: string;
    readonly expiresAt: string;
  }
): ConsensusReport {
  try {
    const consensus = immutableFinancialCouncilInput(rawConsensus) as unknown as
      ConsensusReport;
    exactObject(consensus, ["reportId", "runId", "snapshotId",
      "acceptedFindings", "minorityFindings", "rejectedFindings",
      "unresolvedConflicts", "dataGaps", "overallDiagnosis",
      "inputVersionHash", "createdAt"]);
    const { reportId, ...preimage } = consensus;
    hash(reportId);
    timestamp(consensus.createdAt);
    if (reportId !== financialCouncilCanonicalHash(preimage)
      || typeof consensus.overallDiagnosis !== "string"
      || consensus.overallDiagnosis.length < 1
      || consensus.overallDiagnosis.length > 2_000
      || consensus.runId !== expected.graph.runId
      || consensus.snapshotId !== expected.graph.snapshotId
      || consensus.inputVersionHash !== expected.graph.graphHash
      || Date.parse(consensus.createdAt) < Date.parse(expected.earliestCreatedAt)
      || Date.parse(consensus.createdAt) > Date.parse(expected.expiresAt)) {
      inputInvalid();
    }
    const deterministic = buildConsensus({ graph: expected.graph,
      findings: expected.findings, dispositions: expected.dispositions,
      dataGaps: expected.dataGaps, createdAt: consensus.createdAt });
    for (const field of ["runId", "snapshotId", "acceptedFindings",
      "minorityFindings", "rejectedFindings", "unresolvedConflicts",
      "dataGaps", "inputVersionHash", "createdAt"] as const) {
      if (financialCouncilCanonicalJson(consensus[field])
        !== financialCouncilCanonicalJson(deterministic[field])) inputInvalid();
    }
    const allowed = new Set([
      ...consensus.acceptedFindings.map((row) => row.findingId),
      ...consensus.minorityFindings.map((row) => row.findingId),
      ...consensus.unresolvedConflicts.flatMap((row) => row.findingIds)
    ]);
    if (allowed.size > 0
      && !consensus.overallDiagnosis.split(/\n\s*\n/u)
        .every((paragraph) => [...allowed].some((findingId) =>
          paragraph.includes(`[${findingId}]`)))) inputInvalid();
    return immutableFinancialCouncilValue(consensus);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_council_consensus_invalid") throw error;
    throw financialCouncilError("financial_council_consensus_invalid");
  }
}

export class InMemoryFinancialCouncilRepository
implements FinancialCouncilRepository {
  constructor(private readonly temporalTransactions?:
  GrowthTemporalTransactionRunner) {}

  private state = {
    runs: new Map<string, FinancialCouncilRun>(),
    events: new Map<string, FinancialCouncilRunEvent[]>(),
    snapshots: new Map<string, FinancialSnapshotRecord>(),
    creationKeys: new Map<string, string>(),
    specialistResults: new Map<string, FinancialCouncilSpecialistResult>(),
    specialistFindings: new Map<string, StoredSpecialistFinding>(),
    specialistActions: new Map<string, StoredSpecialistAction>(),
    auditGraphs: new Map<string, FinancialCouncilAuditGraph>(),
    rebuttalAttempts: new Map<string, FinancialCouncilRebuttalAttempt>(),
    findingDispositions: new Map<string, FinancialCouncilFindingDisposition>(),
    consensusReports: new Map<string, ConsensusReport>(),
    portfolioRevisions: new Map<string, FinancialCouncilPortfolioRevision>(),
    approvals: new Map<string, FinancialCouncilApprovalRecord>(),
    dispatchOutbox: new Map<string, FinancialCouncilDispatchOutboxRow>(),
    dispatchOperations: new Map<string, FinancialCouncilDispatchOperation>(),
    dispatchReceipts: new Map<string, FinancialCouncilDispatchReceipt>(),
    analysisControls: new Map<string, FinancialCouncilAnalysisControl>(),
    analysisGaps: new Map<string, FinancialCouncilAnalysisGap>()
  };

  private get runs() { return this.state.runs; }
  private get events() { return this.state.events; }
  private get snapshots() { return this.state.snapshots; }
  private get creationKeys() { return this.state.creationKeys; }
  private get specialistResults() { return this.state.specialistResults; }
  private get specialistFindings() { return this.state.specialistFindings; }
  private get specialistActions() { return this.state.specialistActions; }
  private get auditGraphs() { return this.state.auditGraphs; }
  private get rebuttalAttempts() { return this.state.rebuttalAttempts; }
  private get findingDispositions() { return this.state.findingDispositions; }
  private get consensusReports() { return this.state.consensusReports; }
  private get portfolioRevisions() { return this.state.portfolioRevisions; }
  private get approvals() { return this.state.approvals; }
  private get dispatchOutbox() { return this.state.dispatchOutbox; }
  private get dispatchOperations() { return this.state.dispatchOperations; }
  private get dispatchReceipts() { return this.state.dispatchReceipts; }
  private get analysisControls() { return this.state.analysisControls; }
  private get analysisGaps() { return this.state.analysisGaps; }

  async createAndFreezeRun(
    command: CommandContext,
    input: CreateAndFreezeFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilCreateAndFreezeMutation(
      command, input
    ));
    const { aggregate, snapshot, occurredAt } = input;
    const creationKey = key(aggregate.workspaceId, aggregate.creationKeyHash);
    const existing = this.readFrozenRunByCreationKey(
      command.workspace, aggregate.creationKeyHash, aggregate.requestHash
    );
    if (existing) {
      return { value: existing, replayed: true };
    }
    const aggregateKey = key(aggregate.workspaceId, aggregate.runId);
    const snapshotKey = key(aggregate.workspaceId, snapshot.snapshotId);
    if (this.runs.has(aggregateKey)) {
      throw financialCouncilError("financial_council_run_conflict");
    }
    if (this.snapshots.has(snapshotKey)) {
      throw financialCouncilError("financial_council_snapshot_conflict");
    }
    const created = immutableFinancialCouncilValue(aggregate);
    const withSnapshot = immutableFinancialCouncilValue({
      ...created,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash
    });
    const frozen = applyFinancialCouncilTransition(withSnapshot, {
      kind: "snapshot_frozen", occurredAt, actorId: command.actorId
    });
    const createdEvent = createFinancialCouncilRunEvent(created, {
      fromStatus: null, reasonCode: null,
      occurredAt: created.createdAt, actorId: command.actorId
    });
    const frozenEvent = createFinancialCouncilRunEvent(frozen, {
      fromStatus: "created", reasonCode: null,
      occurredAt, actorId: command.actorId
    });
    const nextState = {
      runs: new Map(this.runs),
      events: new Map(this.events),
      snapshots: new Map(this.snapshots),
      creationKeys: new Map(this.creationKeys),
      specialistResults: new Map(this.specialistResults),
      specialistFindings: new Map(this.specialistFindings),
      specialistActions: new Map(this.specialistActions),
      auditGraphs: new Map(this.auditGraphs),
      rebuttalAttempts: new Map(this.rebuttalAttempts),
      findingDispositions: new Map(this.findingDispositions),
      consensusReports: new Map(this.consensusReports),
      portfolioRevisions: new Map(this.portfolioRevisions),
      approvals: new Map(this.approvals),
      dispatchOutbox: new Map(this.dispatchOutbox),
      dispatchOperations: new Map(this.dispatchOperations),
      dispatchReceipts: new Map(this.dispatchReceipts),
      analysisControls: new Map(this.analysisControls),
      analysisGaps: new Map(this.analysisGaps)
    };
    nextState.runs.set(aggregateKey, frozen);
    nextState.events.set(aggregateKey, [createdEvent, frozenEvent]);
    nextState.snapshots.set(
      snapshotKey, immutableFinancialCouncilValue(snapshot)
    );
    nextState.creationKeys.set(creationKey, frozen.runId);
    nextState.analysisControls.set(aggregateKey,
      immutableFinancialCouncilValue({
        workspaceId: frozen.workspaceId,
        runId: frozen.runId,
        ownerId: command.actorId,
        teamId: command.workspace.teamId,
        lease: null,
        createdAt: occurredAt
      }));
    this.state = nextState;
    return { value: frozen, replayed: false };
  }

  async findFrozenRunByCreationKey(
    context: ActiveWorkspaceContext,
    creationKeyHash: string,
    requestHash: string
  ): Promise<FinancialCouncilRun | null> {
    return this.readFrozenRunByCreationKey(
      context, creationKeyHash, requestHash
    );
  }

  private readFrozenRunByCreationKey(
    context: ActiveWorkspaceContext,
    creationKeyHash: string,
    requestHash: string
  ): FinancialCouncilRun | null {
    hash(creationKeyHash);
    hash(requestHash);
    const existingId = this.creationKeys.get(key(
      context.workspaceId, creationKeyHash
    ));
    if (!existingId) return null;
    const existing = this.runs.get(key(context.workspaceId, existingId));
    if (!existing) throw financialCouncilError("financial_council_integrity");
    if (existing.requestHash !== requestHash) {
      throw financialCouncilError("financial_council_idempotency_conflict");
    }
    if (existing.status === "created" || existing.revision < 2
      || existing.snapshotId === null || existing.snapshotHash === null) {
      historyIntegrity();
    }
    this.assertStoredRun(existing);
    return existing;
  }

  async createRun(
    command: CommandContext,
    aggregate: FinancialCouncilRun
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, aggregate } = validateFinancialCouncilCreateMutation(
      command, aggregate
    ));
    const creationKey = key(aggregate.workspaceId, aggregate.creationKeyHash);
    const existingId = this.creationKeys.get(creationKey);
    if (existingId) {
      const existing = this.runs.get(key(aggregate.workspaceId, existingId));
      if (!existing) {
        throw financialCouncilError("financial_council_integrity");
      }
      this.assertStoredRun(existing);
      if (existing.requestHash !== aggregate.requestHash) {
        throw financialCouncilError("financial_council_idempotency_conflict");
      }
      return { value: existing, replayed: true };
    }
    const aggregateKey = key(aggregate.workspaceId, aggregate.runId);
    if (this.runs.has(aggregateKey)) {
      throw financialCouncilError("financial_council_run_conflict");
    }
    const stored = immutableFinancialCouncilValue(aggregate);
    const event = createFinancialCouncilRunEvent(stored, {
      fromStatus: null,
      reasonCode: null,
      occurredAt: stored.createdAt,
      actorId: command.actorId
    });
    this.runs.set(aggregateKey, stored);
    this.creationKeys.set(creationKey, stored.runId);
    this.events.set(aggregateKey, [event]);
    this.analysisControls.set(aggregateKey, immutableFinancialCouncilValue({
      workspaceId: stored.workspaceId,
      runId: stored.runId,
      ownerId: command.actorId,
      teamId: command.workspace.teamId,
      lease: null,
      createdAt: stored.createdAt
    }));
    return { value: stored, replayed: false };
  }

  async findRun(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilRun | null> {
    const run = this.runs.get(key(context.workspaceId, runId)) ?? null;
    if (run) this.assertStoredRun(run);
    return run;
  }

  async getVerifiedRunSnapshot(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<VerifiedFinancialCouncilRunSnapshot | null> {
    const run = this.runs.get(key(context.workspaceId, runId)) ?? null;
    if (!run) return null;
    this.assertStoredRun(run);
    if (run.snapshotId === null) historyIntegrity();
    const record = this.snapshots.get(key(run.workspaceId, run.snapshotId));
    if (!record) historyIntegrity();
    return immutableFinancialCouncilValue({
      run,
      snapshot: validateFinancialSnapshotForRun(record.snapshot, run)
    });
  }

  async listEvents(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilRunEvent[]> {
    const run = this.runs.get(key(context.workspaceId, runId));
    const events = this.events.get(key(context.workspaceId, runId)) ?? [];
    if (!run) {
      if (events.length) historyIntegrity();
      return Object.freeze([]);
    }
    this.assertStoredRun(run);
    return Object.freeze([...events]);
  }

  async storeFrozenSnapshot(
    command: CommandContext,
    input: StoreFrozenFinancialSnapshotInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilStoreSnapshotMutation(
      command, input
    ));
    const expectedRevision = exactRevision(command);
    const aggregateKey = key(command.workspace.workspaceId, input.runId);
    const current = this.runs.get(aggregateKey);
    if (!current) {
      throw financialCouncilError("financial_council_run_not_found");
    }
    if (current.revision !== expectedRevision) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
    assertFinancialSnapshotRecord(current, input.snapshot);
    if (current.snapshotId !== null) {
      throw financialCouncilError("financial_council_snapshot_conflict");
    }
    if (this.snapshots.has(key(current.workspaceId, input.snapshot.snapshotId))) {
      throw financialCouncilError("financial_council_snapshot_conflict");
    }
    const withSnapshot = immutableFinancialCouncilValue({
      ...current,
      snapshotId: input.snapshot.snapshotId,
      snapshotHash: input.snapshot.snapshotHash
    });
    const next = applyFinancialCouncilTransition(withSnapshot, {
      kind: "snapshot_frozen",
      occurredAt: input.occurredAt,
      actorId: command.actorId
    });
    const event = createFinancialCouncilRunEvent(next, {
      fromStatus: current.status,
      reasonCode: null,
      occurredAt: input.occurredAt,
      actorId: command.actorId
    });
    this.snapshots.set(
      key(current.workspaceId, input.snapshot.snapshotId),
      immutableFinancialCouncilValue(input.snapshot)
    );
    this.runs.set(aggregateKey, next);
    this.events.get(aggregateKey)!.push(event);
    return { value: next, replayed: false };
  }

  async transitionRun(
    command: CommandContext,
    input: TransitionFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilTransitionMutation(
      command, input
    ));
    if (input.kind === "snapshot_frozen") {
      throw financialCouncilError("financial_council_transition_invalid");
    }
    const expectedRevision = exactRevision(command);
    const aggregateKey = key(command.workspace.workspaceId, input.runId);
    const current = this.runs.get(aggregateKey);
    if (!current) {
      throw financialCouncilError("financial_council_run_not_found");
    }
    if (current.revision !== expectedRevision) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
    const next = applyFinancialCouncilTransition(current, {
      kind: input.kind,
      occurredAt: input.occurredAt,
      actorId: command.actorId
    });
    const event = createFinancialCouncilRunEvent(next, {
      fromStatus: current.status,
      reasonCode: input.reasonCode,
      occurredAt: input.occurredAt,
      actorId: command.actorId
    });
    this.runs.set(aggregateKey, next);
    this.events.get(aggregateKey)!.push(event);
    return { value: next, replayed: false };
  }

  async listRunnableRuns(
    input: ListRunnableFinancialCouncilRunsInput
  ): Promise<readonly FinancialCouncilRun[]> {
    input = validateListRunnableFinancialCouncilRunsInput(input);
    const runs = [...this.runs.values()];
    for (const run of runs) this.assertStoredRun(run);
    return Object.freeze(runs
      .filter((run) => run.status === "snapshot_frozen"
        && (input.after === null
          || utf8ByteCompare(run.workspaceId, input.after.workspaceId) > 0
          || (run.workspaceId === input.after.workspaceId
            && utf8ByteCompare(run.runId, input.after.runId) > 0)))
      .sort((left, right) => utf8ByteCompare(
        left.workspaceId, right.workspaceId
      ) || utf8ByteCompare(left.runId, right.runId))
      .slice(0, input.limit));
  }

  async getAnalysisControl(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilAnalysisControl | null> {
    return this.analysisControls.get(key(context.workspaceId, runId)) ?? null;
  }

  async claimAnalysisRun(
    input: ClaimFinancialCouncilAnalysisRunInput
  ): Promise<FinancialCouncilAnalysisLease | null> {
    const controlKey = key(input.workspaceId, input.runId);
    const control = this.analysisControls.get(controlKey);
    const run = this.runs.get(controlKey);
    if (!control || !run) return null;
    if (!/^[0-9a-f]{64}$/u.test(input.leaseToken)
      || !input.workerId.trim()
      || Date.parse(input.leaseExpiresAt) <= Date.parse(input.claimedAt)) {
      throw financialCouncilError("financial_council_lease_invalid");
    }
    if (!["snapshot_frozen", "analyzing", "auditing", "synthesizing",
      "optimizing"].includes(run.status)) return null;
    if (control.lease
      && Date.parse(control.lease.leaseExpiresAt) > Date.parse(input.claimedAt)) {
      return null;
    }
    const lease = immutableFinancialCouncilValue({
      ...input,
      attempt: (control.lease?.attempt ?? 0) + 1
    });
    this.analysisControls.set(controlKey, immutableFinancialCouncilValue({
      ...control, lease
    }));
    return lease;
  }

  private requireLiveAnalysisLease(
    lease: FinancialCouncilAnalysisLease,
    completedAt: string
  ): FinancialCouncilAnalysisControl {
    const control = this.analysisControls.get(key(
      lease.workspaceId, lease.runId
    ));
    const current = control?.lease;
    if (!control || !current
      || current.workerId !== lease.workerId
      || current.leaseToken !== lease.leaseToken
      || current.attempt !== lease.attempt
      || current.claimedAt !== lease.claimedAt
      || current.leaseExpiresAt !== lease.leaseExpiresAt
      || Date.parse(completedAt) >= Date.parse(current.leaseExpiresAt)) {
      throw financialCouncilError("financial_council_lease_stale");
    }
    return control;
  }

  async releaseAnalysisLease(
    lease: FinancialCouncilAnalysisLease,
    releasedAt: string
  ): Promise<void> {
    const control = this.requireLiveAnalysisLease(lease, releasedAt);
    this.analysisControls.set(key(lease.workspaceId, lease.runId),
      immutableFinancialCouncilValue({ ...control, lease: null }));
  }

  async transitionRunWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: Omit<TransitionFinancialCouncilRunInput, "runId">
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    const control = this.requireLiveAnalysisLease(lease, input.occurredAt);
    const aggregateKey = key(lease.workspaceId, lease.runId);
    const current = this.runs.get(aggregateKey);
    if (!current) throw financialCouncilError("financial_council_run_not_found");
    const next = applyFinancialCouncilTransition(current, {
      kind: input.kind,
      occurredAt: input.occurredAt,
      actorId: control.ownerId
    });
    const event = createFinancialCouncilRunEvent(next, {
      fromStatus: current.status,
      reasonCode: input.reasonCode,
      occurredAt: input.occurredAt,
      actorId: control.ownerId
    });
    this.runs.set(aggregateKey, next);
    this.events.get(aggregateKey)!.push(event);
    return { value: next, replayed: false };
  }

  async listRecoverableAnalysisRuns(
    now: string,
    limit: number
  ): Promise<readonly FinancialCouncilRun[]> {
    const at = Date.parse(now);
    return Object.freeze([...this.runs.values()].filter((run) => {
      if (!["snapshot_frozen", "analyzing", "auditing", "synthesizing",
        "optimizing"]
        .includes(run.status)) return false;
      const control = this.analysisControls.get(key(run.workspaceId, run.runId));
      return !!control && (!control.lease
        || Date.parse(control.lease.leaseExpiresAt) <= at);
    }).sort((a, b) => utf8ByteCompare(a.workspaceId, b.workspaceId)
      || utf8ByteCompare(a.runId, b.runId)).slice(0, limit));
  }

  async storeAnalysisGap(
    lease: FinancialCouncilAnalysisLease,
    gap: FinancialCouncilAnalysisGap
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAnalysisGap>> {
    this.requireLiveAnalysisLease(lease, gap.createdAt);
    if (gap.workspaceId !== lease.workspaceId || gap.runId !== lease.runId
      || !["profit", "cost", "tax"].includes(gap.role)
      || !["specialist_unavailable", "tax_input_missing"].includes(gap.code)
      || gap.detail !== null
      || gap.gapHash !== financialCouncilCanonicalHash({
        workspaceId: gap.workspaceId, runId: gap.runId, role: gap.role,
        code: gap.code, detail: gap.detail, createdAt: gap.createdAt
      })) throw financialCouncilError("financial_council_analysis_gap_invalid");
    const gapKey = key(gap.workspaceId, `${gap.runId}\u0000${gap.role}`);
    const existing = this.analysisGaps.get(gapKey);
    if (existing) {
      if (financialCouncilCanonicalJson(existing)
        !== financialCouncilCanonicalJson(gap)) {
        throw financialCouncilError("financial_council_analysis_gap_conflict");
      }
      return { value: existing, replayed: true };
    }
    const stored = immutableFinancialCouncilValue(gap);
    this.analysisGaps.set(gapKey, stored);
    return { value: stored, replayed: false };
  }

  async listAnalysisGaps(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilAnalysisGap[]> {
    return Object.freeze([...this.analysisGaps.values()].filter((gap) =>
      gap.workspaceId === context.workspaceId && gap.runId === runId)
      .sort((a, b) => utf8ByteCompare(a.role, b.role)));
  }

  async storeSpecialistResult(
    context: ActiveWorkspaceContext,
    rawResult: AuthorizedFinancialCouncilSpecialistResult,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<
  AuthorizedFinancialCouncilSpecialistResult>> {
    if (write) this.requireLiveAnalysisLease(write.lease, write.completedAt);
    assertFinancialCouncilSpecialistResultAuthorized(rawResult);
    const result = validateFinancialCouncilSpecialistResult(rawResult);
    if (result.workspaceId !== context.workspaceId) specialInvalid();
    const verified = await this.getVerifiedRunSnapshot(context, result.runId);
    if (!verified) {
      throw financialCouncilError("financial_council_run_not_found");
    }
    if (verified.snapshot.snapshotId !== result.snapshotId
      || verified.snapshot.snapshotHash !== result.snapshotHash
      || Date.parse(result.createdAt) < Date.parse(verified.run.updatedAt)
      || Date.parse(result.createdAt) > Date.parse(verified.run.expiresAt)
      || Date.parse(result.createdAt) > Date.now() + 1_000) {
      specialInvalid();
    }
    const resultKey = specialistKey(result.workspaceId, result.runId,
      result.role, result.phase);
    const existing = this.specialistResults.get(resultKey);
    if (existing) {
      const parsed = this.assertStoredSpecialistResult(existing);
      if (financialCouncilCanonicalJson(parsed)
        !== financialCouncilCanonicalJson(result)) {
        throw financialCouncilError("financial_council_specialist_conflict");
      }
      return { value: rawResult, replayed: true };
    }
    if ([...this.specialistResults.values()].some((candidate) =>
      candidate.workspaceId === result.workspaceId
      && candidate.resultId === result.resultId)) {
      throw financialCouncilError("financial_council_specialist_conflict");
    }
    const nextState = {
      runs: new Map(this.runs),
      events: new Map(this.events),
      snapshots: new Map(this.snapshots),
      creationKeys: new Map(this.creationKeys),
      specialistResults: new Map(this.specialistResults),
      specialistFindings: new Map(this.specialistFindings),
      specialistActions: new Map(this.specialistActions),
      auditGraphs: new Map(this.auditGraphs),
      rebuttalAttempts: new Map(this.rebuttalAttempts),
      findingDispositions: new Map(this.findingDispositions),
      consensusReports: new Map(this.consensusReports),
      portfolioRevisions: new Map(this.portfolioRevisions),
      approvals: new Map(this.approvals),
      dispatchOutbox: new Map(this.dispatchOutbox),
      dispatchOperations: new Map(this.dispatchOperations),
      dispatchReceipts: new Map(this.dispatchReceipts),
      analysisControls: new Map(this.analysisControls),
      analysisGaps: new Map(this.analysisGaps)
    };
    for (const finding of result.findings) {
      const findingKey = key(result.workspaceId,
        `${result.runId}\u0000${result.role}\u0000${result.phase}`
          + `\u0000${finding.findingId}`);
      if (nextState.specialistFindings.has(findingKey)) {
        throw financialCouncilError("financial_council_specialist_conflict");
      }
      nextState.specialistFindings.set(findingKey, Object.freeze({
        role: result.role, phase: result.phase, value: finding
      }));
    }
    for (const action of result.actions) {
      const actionKey = key(result.workspaceId,
        `${result.runId}\u0000${result.role}\u0000${result.phase}`
          + `\u0000${action.actionId}`);
      if (nextState.specialistActions.has(actionKey)) {
        throw financialCouncilError("financial_council_specialist_conflict");
      }
      nextState.specialistActions.set(actionKey, Object.freeze({
        role: result.role, phase: result.phase, value: action
      }));
    }
    nextState.specialistResults.set(resultKey, result);
    this.state = nextState;
    return { value: rawResult, replayed: false };
  }

  async getSpecialistResult(
    context: ActiveWorkspaceContext,
    runId: string,
    rawRole: FinancialCouncilAgentRole,
    rawPhase: FinancialCouncilSpecialistPhase
  ): Promise<FinancialCouncilSpecialistResult | null> {
    if (!SPECIALIST_ROLES.has(rawRole) || !SPECIALIST_PHASES.has(rawPhase)) {
      specialInvalid();
    }
    const result = this.specialistResults.get(specialistKey(
      context.workspaceId, runId, rawRole, rawPhase
    )) ?? null;
    if (!result) return null;
    const parsed = this.assertStoredSpecialistResult(result);
    if (parsed.workspaceId !== context.workspaceId || parsed.runId !== runId
      || parsed.role !== rawRole || parsed.phase !== rawPhase) {
      historyIntegrity();
    }
    const verified = await this.getVerifiedRunSnapshot(context, runId);
    if (!verified || parsed.snapshotId !== verified.snapshot.snapshotId
      || parsed.snapshotHash !== verified.snapshot.snapshotHash) {
      historyIntegrity();
    }
    return parsed;
  }

  async listSpecialistResults(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilSpecialistResult[]> {
    const verified = await this.getVerifiedRunSnapshot(context, runId);
    const prefix = `${context.workspaceId}\u0000${runId}\u0000`;
    if (!verified) {
      if ([...this.specialistResults].some(([storedKey, result]) =>
        storedKey.startsWith(prefix)
        || (result.workspaceId === context.workspaceId
          && result.runId === runId))) {
        historyIntegrity();
      }
      return Object.freeze([]);
    }
    const results = [...this.specialistResults]
      .filter(([storedKey, result]) => storedKey.startsWith(prefix)
        || (result.workspaceId === context.workspaceId
          && result.runId === runId))
      .map(([storedKey, result]) => {
        const parsed = this.assertStoredSpecialistResult(result);
        if (storedKey !== specialistKey(parsed.workspaceId, parsed.runId,
          parsed.role, parsed.phase)) historyIntegrity();
        return parsed;
      })
      .sort((left, right) => compareSpecialist(left, right));
    for (const result of results) {
      if (result.snapshotId !== verified.snapshot.snapshotId
        || result.snapshotHash !== verified.snapshot.snapshotHash) {
        historyIntegrity();
      }
    }
    return Object.freeze(results);
  }

  async storeAuditGraph(
    context: ActiveWorkspaceContext,
    rawGraph: FinancialCouncilAuditGraph,
    rawDispositions: readonly InitialFinancialCouncilFindingDisposition[],
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAuditGraph>> {
    if (write) this.requireLiveAnalysisLease(write.lease, write.completedAt);
    const graph = immutableFinancialCouncilInput(rawGraph);
    const dispositions = immutableFinancialCouncilInput(rawDispositions);
    try {
      exactObject(graph, ["graphId", "workspaceId", "runId", "snapshotId",
        "snapshotHash", "edges", "graphHash"]);
      if (!Array.isArray(graph.edges)) inputInvalid();
      for (const edge of graph.edges) {
        exactObject(edge, ["edgeId", "kind", "findingIds", "sharedRefs",
          "status", "validatorReason"]);
      }
      for (const item of dispositions) {
        exactObject(item, ["findingId", "role", "status",
          "blockingConflictIds"]);
      }
    } catch {
      throw financialCouncilError("financial_council_audit_invalid");
    }
    const verified = await this.getVerifiedRunSnapshot(context, graph.runId);
    const expectedHash = financialCouncilCanonicalHash({
      workspaceId: graph.workspaceId, runId: graph.runId,
      snapshotId: graph.snapshotId, snapshotHash: graph.snapshotHash,
      edges: graph.edges
    });
    if (!verified || graph.workspaceId !== context.workspaceId
      || graph.snapshotId !== verified.snapshot.snapshotId
      || graph.snapshotHash !== verified.snapshot.snapshotHash
      || graph.graphId !== expectedHash || graph.graphHash !== expectedHash
      || new Set(dispositions.map((item) => item.findingId)).size
        !== dispositions.length
      || dispositions.some((item) => item.status !== "unresolved"
        || !SPECIALIST_ROLES.has(item.role)
        || item.blockingConflictIds.some((id) => !graph.edges.some((edge) =>
          edge.edgeId === id && edge.findingIds.includes(item.findingId))))) {
      throw financialCouncilError("financial_council_audit_invalid");
    }
    const graphKey = key(context.workspaceId, graph.runId);
    const existing = this.auditGraphs.get(graphKey);
    if (existing) {
      if (financialCouncilCanonicalJson(existing)
          !== financialCouncilCanonicalJson(graph)
        || financialCouncilCanonicalJson([...this.findingDispositions.values()]
          .filter((item) => item.workspaceId === context.workspaceId
            && item.runId === graph.runId)
          .map((item) => ({ findingId: item.findingId, role: item.role,
            status: "unresolved", blockingConflictIds:
              item.blockingConflictIds }))
          .sort((left, right) => utf8ByteCompare(
            left.findingId, right.findingId
          ))) !== financialCouncilCanonicalJson([...dispositions]
          .sort((left, right) => utf8ByteCompare(
            left.findingId, right.findingId
          )))) {
        throw financialCouncilError("financial_council_audit_conflict");
      }
      return { value: existing, replayed: true };
    }
    const nextGraphs = new Map(this.auditGraphs);
    const nextDispositions = new Map(this.findingDispositions);
    nextGraphs.set(graphKey, graph);
    for (const item of dispositions) {
      const stable = {
        workspaceId: context.workspaceId, runId: graph.runId,
        snapshotId: graph.snapshotId, snapshotHash: graph.snapshotHash,
        graphId: graph.graphId, findingId: item.findingId, role: item.role,
        status: item.status, blockingConflictIds: [...item.blockingConflictIds]
          .sort(utf8ByteCompare), updatedAt: verified.run.updatedAt
      };
      nextDispositions.set(dispositionKey(context.workspaceId, graph.runId,
        item.findingId), immutableFinancialCouncilValue({ ...stable,
        dispositionHash: financialCouncilCanonicalHash(stable) }));
    }
    this.state = { ...this.state, auditGraphs: nextGraphs,
      findingDispositions: nextDispositions };
    return { value: graph, replayed: false };
  }

  async getAuditGraph(context: ActiveWorkspaceContext, runId: string):
  Promise<FinancialCouncilAuditGraph | null> {
    const graph = this.auditGraphs.get(key(context.workspaceId, runId)) ?? null;
    return graph;
  }

  async reserveRebuttalAttempt(
    context: ActiveWorkspaceContext,
    rawAttempt: FinancialCouncilRebuttalAttempt,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>> {
    if (write) this.requireLiveAnalysisLease(write.lease, write.completedAt);
    const attempt = immutableFinancialCouncilInput(rawAttempt);
    try {
      exactObject(attempt, ["attemptId", "workspaceId", "runId",
        "snapshotId", "snapshotHash", "graphId", "role", "round",
        "edgeId", "targetFindingId", "inputHash", "input", "status",
        "result", "outputHash", "createdAt", "completedAt", "attemptHash"]);
      exactObject(attempt.input, ["ownerId", "teamId", "runId",
        "snapshotId", "snapshotHash", "role", "attempt", "allowlist",
        "businessData", "targetFindingId", "conflictData"]);
      exactObject(attempt.input.allowlist, ["evidenceRefIds", "formulaRefIds",
        "findingIds", "subjectRefs", "dataGapRefs"]);
    } catch {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const graph = await this.getAuditGraph(context, attempt.runId);
    const stable = { ...attempt, attemptHash: undefined };
    delete (stable as { attemptHash?: unknown }).attemptHash;
    if (!graph || attempt.workspaceId !== context.workspaceId
      || attempt.snapshotId !== graph.snapshotId
      || attempt.snapshotHash !== graph.snapshotHash
      || attempt.graphId !== graph.graphId || attempt.round !== 1
      || attempt.status !== "reserved" || attempt.result !== null
      || attempt.outputHash !== null || attempt.completedAt !== null
      || attempt.role !== attempt.input.role
      || attempt.runId !== attempt.input.runId
      || attempt.snapshotId !== attempt.input.snapshotId
      || attempt.snapshotHash !== attempt.input.snapshotHash
      || attempt.targetFindingId !== attempt.input.targetFindingId
      || attempt.input.attempt !== 1
      || attempt.inputHash !== financialCouncilCanonicalHash(attempt.input)
      || attempt.attemptHash !== financialCouncilCanonicalHash(stable)
      || !graph.edges.some((item) => item.edgeId === attempt.edgeId
        && item.findingIds.includes(attempt.targetFindingId))) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const attemptKey = rebuttalKey(context.workspaceId, attempt.runId,
      attempt.role, attempt.round);
    const existing = this.rebuttalAttempts.get(attemptKey);
    if (existing) {
      if (existing.inputHash !== attempt.inputHash
        || existing.attemptId !== attempt.attemptId
        || existing.edgeId !== attempt.edgeId) {
        throw financialCouncilError("financial_council_rebuttal_conflict");
      }
      return { value: existing, replayed: true };
    }
    const next = new Map(this.rebuttalAttempts);
    next.set(attemptKey, attempt);
    this.state = { ...this.state, rebuttalAttempts: next };
    return { value: attempt, replayed: false };
  }

  async getRebuttalAttempt(
    context: ActiveWorkspaceContext, runId: string,
    role: FinancialCouncilAgentRole, round: number
  ): Promise<FinancialCouncilRebuttalAttempt | null> {
    if (!SPECIALIST_ROLES.has(role) || round !== 1) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    return this.rebuttalAttempts.get(rebuttalKey(
      context.workspaceId, runId, role, round
    )) ?? null;
  }

  async listRebuttalAttempts(context: ActiveWorkspaceContext, runId: string):
  Promise<readonly FinancialCouncilRebuttalAttempt[]> {
    return Object.freeze([...this.rebuttalAttempts.values()].filter((item) =>
      item.workspaceId === context.workspaceId && item.runId === runId)
      .sort((left, right) => utf8ByteCompare(left.role, right.role)));
  }

  async completeRebuttalAttempt(
    context: ActiveWorkspaceContext,
    rawInput: CompleteFinancialCouncilRebuttalInput,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>> {
    if (write) this.requireLiveAnalysisLease(write.lease, write.completedAt);
    const input = immutableFinancialCouncilInput(rawInput);
    const entry = [...this.rebuttalAttempts.entries()].find(([, item]) =>
      item.workspaceId === context.workspaceId
        && item.attemptId === input.attemptId);
    if (!entry || entry[1].inputHash !== input.inputHash) {
      throw financialCouncilError("financial_council_rebuttal_conflict");
    }
    const [attemptKey, current] = entry;
    const outputHash = financialCouncilCanonicalHash(input.result.value);
    if (current.status === "completed") {
      if (current.outputHash !== outputHash
        || financialCouncilCanonicalJson(current.result)
          !== financialCouncilCanonicalJson(input.result)) {
        throw financialCouncilError("financial_council_rebuttal_conflict");
      }
      return { value: current, replayed: true };
    }
    if (input.result.binding.jobId
        !== `financial-council:${current.runId}:${current.role}:rebut:1`
      || input.result.binding.contentHash !== rebuttalContentHash(current.input)
      || input.result.binding.runId !== current.runId
      || input.result.binding.snapshotId !== current.snapshotId
      || input.result.binding.snapshotHash !== current.snapshotHash
      || input.result.binding.role !== current.role
      || input.result.binding.phase !== "rebut"
      || input.result.binding.attempt !== 1
      || input.result.value.findingId !== current.targetFindingId) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const stable = { ...current, status: "completed" as const,
      result: input.result, outputHash, completedAt: input.completedAt };
    const { attemptHash: _oldHash, ...preimage } = stable;
    const completed = immutableFinancialCouncilValue({ ...preimage,
      attemptHash: financialCouncilCanonicalHash(preimage) });
    const dispositionKeyValue = dispositionKey(context.workspaceId,
      current.runId, current.targetFindingId);
    const disposition = this.findingDispositions.get(dispositionKeyValue);
    if (!disposition || disposition.graphId !== current.graphId) {
      throw financialCouncilError("financial_council_integrity");
    }
    const expectedStatus = input.result.value.decision === "withdraw"
      ? "withdrawn" : input.result.value.decision === "revise"
        ? "revised" : "upheld";
    const expectedBlocking = input.result.value.decision === "withdraw" ? []
      : input.result.value.decision === "revise"
        ? disposition.blockingConflictIds.filter((id) => id !== current.edgeId)
        : [...disposition.blockingConflictIds];
    if (input.disposition.status !== expectedStatus
      || financialCouncilCanonicalJson([...input.disposition.blockingConflictIds]
        .sort(utf8ByteCompare)) !== financialCouncilCanonicalJson(
        expectedBlocking.sort(utf8ByteCompare))) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const dispositionStable = { ...disposition,
      status: input.disposition.status,
      blockingConflictIds: [...input.disposition.blockingConflictIds]
        .sort(utf8ByteCompare), updatedAt: input.completedAt };
    const { dispositionHash: _oldDispositionHash, ...dispositionPreimage }
      = dispositionStable;
    const nextAttempts = new Map(this.rebuttalAttempts);
    const nextDispositions = new Map(this.findingDispositions);
    nextAttempts.set(attemptKey, completed);
    nextDispositions.set(dispositionKeyValue, immutableFinancialCouncilValue({
      ...dispositionPreimage,
      dispositionHash: financialCouncilCanonicalHash(dispositionPreimage)
    }));
    this.state = { ...this.state, rebuttalAttempts: nextAttempts,
      findingDispositions: nextDispositions };
    return { value: completed, replayed: false };
  }

  async listFindingDispositions(
    context: ActiveWorkspaceContext, runId: string
  ): Promise<readonly FinancialCouncilFindingDisposition[]> {
    return Object.freeze([...this.findingDispositions.values()].filter((item) =>
      item.workspaceId === context.workspaceId && item.runId === runId)
      .sort((left, right) => utf8ByteCompare(
        left.findingId, right.findingId
      )));
  }

  async storeConsensus(
    context: ActiveWorkspaceContext,
    rawConsensus: ConsensusReport,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<ConsensusReport>> {
    const consensus = immutableFinancialCouncilInput(rawConsensus);
    if (write) {
      this.requireLiveAnalysisLease(write.lease, write.completedAt);
      if (write.lease.workspaceId !== context.workspaceId
        || write.lease.runId !== consensus.runId) {
        throw financialCouncilError("financial_council_lease_stale");
      }
    }
    await this.assertStoredConsensus(context, consensus, false);
    const consensusKey = key(context.workspaceId, consensus.runId);
    const existing = this.consensusReports.get(consensusKey);
    if (existing) {
      await this.assertStoredConsensus(context, existing, true);
      if (financialCouncilCanonicalJson(existing)
        !== financialCouncilCanonicalJson(consensus)) {
        throw financialCouncilError("financial_council_consensus_conflict");
      }
      return { value: existing, replayed: true };
    }
    const next = new Map(this.consensusReports);
    next.set(consensusKey, immutableFinancialCouncilValue(consensus));
    this.state = { ...this.state, consensusReports: next };
    return { value: consensus, replayed: false };
  }

  async getConsensus(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<ConsensusReport | null> {
    const consensus = this.consensusReports.get(
      key(context.workspaceId, runId)
    ) ?? null;
    if (consensus) await this.assertStoredConsensus(context, consensus, true);
    return consensus;
  }

  async storePortfolioRevision(
    rawRevision: FinancialCouncilPortfolioRevision,
    write: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>> {
    const revision = immutableFinancialCouncilInput(rawRevision);
    this.requireLiveAnalysisLease(write.lease, write.completedAt);
    if (revision.workspaceId !== write.lease.workspaceId
      || revision.runId !== write.lease.runId) {
      throw financialCouncilError("financial_council_lease_stale");
    }
    const run = this.runs.get(key(write.lease.workspaceId, write.lease.runId));
    if (!run || run.status !== "optimizing") {
      throw financialCouncilError("financial_council_portfolio_state_invalid");
    }
    await this.assertStoredPortfolioRevision(revision, false);
    const revisionKey = portfolioKey(
      revision.workspaceId, revision.runId, revision.revision
    );
    const existing = this.portfolioRevisions.get(revisionKey);
    if (existing) {
      await this.assertStoredPortfolioRevision(existing, true);
      if (financialCouncilCanonicalJson(existing)
        !== financialCouncilCanonicalJson(revision)) {
        throw financialCouncilError("financial_council_portfolio_conflict");
      }
      return { value: existing, replayed: true };
    }
    const next = new Map(this.portfolioRevisions);
    next.set(revisionKey, immutableFinancialCouncilValue(revision));
    this.state = { ...this.state, portfolioRevisions: next };
    return { value: revision, replayed: false };
  }

  async getPortfolioRevision(
    context: ActiveWorkspaceContext,
    runId: string,
    revision: number
  ): Promise<FinancialCouncilPortfolioRevision | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) inputInvalid();
    const stored = this.portfolioRevisions.get(portfolioKey(
      context.workspaceId, runId, revision
    )) ?? null;
    if (stored) await this.assertStoredPortfolioRevision(stored, true);
    return stored;
  }

  async commitPortfolioRevision(
    command: CommandContext,
    rawInput: CommitFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>> {
    assertCommand(command, "required");
    const revision = immutableFinancialCouncilInput(rawInput?.revision);
    if (revision.workspaceId !== command.workspace.workspaceId
      || command.actorId !== command.workspace.actorId
      || revision.commandRequestHash !== command.requestHash
      || revision.commandKeyHash
        !== financialCouncilPortfolioCommandKeyHash(command)) inputInvalid();
    const aggregateKey = key(revision.workspaceId, revision.runId);
    const run = this.runs.get(aggregateKey);
    if (!run) throw financialCouncilError("financial_council_run_not_found");
    if (run.status !== "awaiting_approval") {
      throw financialCouncilError("financial_council_portfolio_state_invalid");
    }
    const targetKey = portfolioKey(revision.workspaceId, revision.runId,
      revision.revision);
    const existing = this.portfolioRevisions.get(targetKey);
    if (existing) {
      await this.assertStoredPortfolioRevision(existing, true);
      if (existing.commandKeyHash === revision.commandKeyHash
        && existing.commandRequestHash === revision.commandRequestHash
        && financialCouncilCanonicalJson(existing)
          === financialCouncilCanonicalJson(revision)) {
        return { value: existing, replayed: true };
      }
      if (existing.commandKeyHash === revision.commandKeyHash) {
        throw financialCouncilError("financial_council_idempotency_conflict");
      }
      throw financialCouncilError("financial_council_portfolio_conflict");
    }
    if (run.revision !== command.expectedRevision) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
    if (run.latestPortfolioRevision !== revision.baseRevision) {
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    await this.assertStoredPortfolioRevision(revision, false);
    const concurrent = this.portfolioRevisions.get(targetKey);
    if (concurrent) {
      if (concurrent.commandKeyHash === revision.commandKeyHash
        && concurrent.commandRequestHash === revision.commandRequestHash
        && financialCouncilCanonicalJson(concurrent)
          === financialCouncilCanonicalJson(revision)) {
        return { value: concurrent, replayed: true };
      }
      if (concurrent.commandKeyHash === revision.commandKeyHash) {
        throw financialCouncilError("financial_council_idempotency_conflict");
      }
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    if (this.runs.get(aggregateKey)?.latestPortfolioRevision
      !== revision.baseRevision) {
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    const revisions = new Map(this.portfolioRevisions);
    const runs = new Map(this.runs);
    revisions.set(targetKey, immutableFinancialCouncilValue(revision));
    runs.set(aggregateKey, immutableFinancialCouncilValue({
      ...run, portfolios: revision.portfolios,
      latestPortfolioRevision: revision.revision
    }));
    this.state = { ...this.state, portfolioRevisions: revisions, runs };
    return { value: revision, replayed: false };
  }

  async commitApprovalDecision(
    command: CommandContext,
    rawInput: CommitFinancialCouncilApprovalDecisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilApprovalRecord>> {
    command = immutableFinancialCouncilInput(command);
    const input = immutableFinancialCouncilInput(rawInput);
    assertFinancialCouncilApprovalRecord(input.approval);
    if (!Number.isSafeInteger(input.verifiedTemporalSequence)
      || input.verifiedTemporalSequence < 0
      || command.actorId !== command.workspace.actorId
      || command.workspace.workspaceId !== input.approval.workspaceId
      || command.requestHash !== input.approval.commandRequestHash
      || financialCouncilPortfolioCommandKeyHash(command)
        !== input.approval.commandKeyHash) inputInvalid();
    const expectedOutbox = createFinancialCouncilDispatchOutboxRows(
      input.approval
    );
    if (financialCouncilCanonicalJson(expectedOutbox)
      !== financialCouncilCanonicalJson(input.outbox)) inputInvalid();
    return this.withApprovalFence(input.approval.workspaceId,
      input.verifiedTemporalSequence, async () => {
    const aggregateKey = key(input.approval.workspaceId, input.approval.runId);
    const current = this.runs.get(aggregateKey);
    if (!current) throw financialCouncilError("financial_council_run_not_found");
    const existing = [...this.approvals.values()].find((row) =>
      row.workspaceId === input.approval.workspaceId
      && row.runId === input.approval.runId);
    if (existing) {
      assertFinancialCouncilApprovalRecord(existing);
      if (existing.commandKeyHash === input.approval.commandKeyHash
        && existing.commandRequestHash === input.approval.commandRequestHash) {
        return { value: existing, replayed: true };
      }
      if (existing.commandKeyHash === input.approval.commandKeyHash) {
        throw financialCouncilError("financial_council_idempotency_conflict");
      }
      throw financialCouncilError("financial_council_approval_conflict");
    }
    if (current.status !== "awaiting_approval") {
      throw financialCouncilError("financial_council_approval_state_invalid");
    }
    if (current.revision !== command.expectedRevision) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
    if (current.latestPortfolioRevision !== input.approval.portfolioRevision) {
      throw financialCouncilError(
        "financial_council_portfolio_revision_conflict"
      );
    }
    const revision = this.portfolioRevisions.get(portfolioKey(
      current.workspaceId, current.runId, input.approval.portfolioRevision
    ));
    if (!revision) {
      throw financialCouncilError("financial_council_portfolio_not_found");
    }
    await this.assertStoredPortfolioRevision(revision, true);
    const portfolio = revision.portfolios.find((row) =>
      row.kind === input.approval.portfolioKind);
    if (!portfolio
      || input.approval.portfolioOutputHash
        !== financialCouncilCanonicalHash(portfolio)
      || input.approval.snapshotId !== revision.snapshotId
      || input.approval.snapshotHash !== revision.snapshotHash
      || input.approval.policyVersionId !== revision.policyVersionId
      || input.approval.policyHash !== revision.policyHash
      || (input.approval.status === "approved"
        && (financialCouncilCanonicalJson(input.approval.approvedActionIds)
          !== financialCouncilCanonicalJson(portfolio.actionIds)
          || financialCouncilCanonicalJson(input.approval.approvedActionHashes)
            !== financialCouncilCanonicalJson(portfolio.actions.map(
              (action) => ({ actionId: action.actionId,
                actionHash: financialCouncilCanonicalHash(action) })))
          || portfolio.actionIds.length === 0
          || portfolio.hardConstraints.some((row) => !row.satisfied)))) {
      throw financialCouncilError("financial_council_approval_invalid");
    }
    const expectedCapabilities = [...new Set([
      "finance.council.approve", ...portfolio.requiredApprovalCapabilities
    ])];
    if (financialCouncilCanonicalJson(input.approval.requiredCapabilities)
      !== financialCouncilCanonicalJson(expectedCapabilities)) {
      throw financialCouncilError("financial_council_approval_invalid");
    }
    const publicApproval = immutableFinancialCouncilValue({
      approvalId: input.approval.approvalId,
      runId: input.approval.runId,
      portfolioRevision: input.approval.portfolioRevision,
      portfolioKind: input.approval.portfolioKind,
      status: input.approval.status,
      approvedActionIds: input.approval.approvedActionIds,
      requiredCapabilities: input.approval.requiredCapabilities,
      reason: input.approval.reason,
      approvedAt: input.approval.approvedAt
    });
    const withApproval = immutableFinancialCouncilValue({
      ...current, approval: publicApproval
    });
    const next = applyFinancialCouncilTransition(withApproval, {
      kind: input.approval.status,
      occurredAt: input.approval.approvedAt,
      actorId: input.approval.approverId
    });
    const event = createFinancialCouncilRunEvent(next, {
      fromStatus: current.status,
      reasonCode: input.approval.reason,
      occurredAt: input.approval.approvedAt,
      actorId: input.approval.approverId
    });
    const runs = new Map(this.runs);
    const events = new Map(this.events);
    const approvals = new Map(this.approvals);
    const dispatchOutbox = new Map(this.dispatchOutbox);
    runs.set(aggregateKey, next);
    events.set(aggregateKey, [...(events.get(aggregateKey) ?? []), event]);
    approvals.set(key(input.approval.workspaceId, input.approval.approvalId),
      immutableFinancialCouncilValue(input.approval));
    for (const row of input.outbox) {
      const rowKey = key(row.workspaceId, row.dispatchId);
      if (dispatchOutbox.has(rowKey)) {
        throw financialCouncilError("financial_council_dispatch_conflict");
      }
      dispatchOutbox.set(rowKey, immutableFinancialCouncilValue(row));
    }
    this.state = { ...this.state, runs, events, approvals, dispatchOutbox };
    return { value: input.approval, replayed: false };
    });
  }

  private async withApprovalFence<T>(
    workspaceId: string,
    expectedSequence: number,
    work: () => Promise<T>
  ): Promise<T> {
    if (!this.temporalTransactions) return work();
    return this.temporalTransactions.run(async (transaction) => {
      const tail = await transaction.lockWorkspaceTemporalBarrierForUpdate(
        workspaceId
      );
      if (tail.temporalSequence !== expectedSequence) {
        throw financialCouncilError("financial_council_source_stale");
      }
      return work();
    });
  }

  async getApproval(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    approvalId: string
  ): Promise<FinancialCouncilApprovalRecord | null> {
    const approval = this.approvals.get(key(context.workspaceId, approvalId))
      ?? null;
    if (approval) assertFinancialCouncilApprovalRecord(approval);
    return approval;
  }

  async listDispatchOutbox(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    runId: string
  ): Promise<readonly FinancialCouncilDispatchOutboxRow[]> {
    return Object.freeze([...this.dispatchOutbox.values()].filter((row) =>
      row.workspaceId === context.workspaceId && row.runId === runId)
      .sort((left, right) => utf8ByteCompare(left.actionId, right.actionId)));
  }

  private dispatchSeed(workspaceId: string, dispatchId: string): FinancialCouncilDispatchOutboxRow {
    const outbox = this.dispatchOutbox.get(key(workspaceId, dispatchId));
    if (!outbox) throw financialCouncilError("financial_council_dispatch_not_found");
    const approval = this.approvals.get(key(workspaceId, outbox.approvalId));
    const run = this.runs.get(key(workspaceId, outbox.runId));
    if (!approval || !run || approval.status !== "approved" || run.status !== "approved"
      || approval.approvalHash !== outbox.approvalHash
      || !approval.approvedActionIds.includes(outbox.actionId)) {
      throw financialCouncilError("financial_council_dispatch_stale");
    }
    return outbox;
  }

  async claimDispatchOperation(input: ClaimFinancialCouncilDispatchOperationInput & {
    readonly workspaceId: string; readonly dispatchId: string;
  }): Promise<FinancialCouncilDispatchLease | null> {
    const seed = this.dispatchSeed(input.workspaceId, input.dispatchId);
    const operationKey = key(seed.workspaceId, seed.dispatchId);
    const current = this.dispatchOperations.get(operationKey)
      ?? createFinancialCouncilDispatchOperation({
        dispatchId: seed.dispatchId, workspaceId: seed.workspaceId,
        runId: seed.runId, approvalId: seed.approvalId,
        approvalHash: seed.approvalHash, portfolioRevision: seed.portfolioRevision,
        portfolioKind: seed.portfolioKind, actionId: seed.actionId,
        actionHash: seed.actionHash, resultHash: seed.resultHash,
        portfolioOutputHash: seed.portfolioOutputHash, createdAt: seed.createdAt
      });
    const claimed = claimFinancialCouncilDispatchOperation(current, input);
    if (!claimed) return null;
    const operations = new Map(this.dispatchOperations);
    operations.set(operationKey, claimed.operation);
    this.state = { ...this.state, dispatchOperations: operations };
    return claimed.lease;
  }

  async getDispatchOperation(context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string): Promise<FinancialCouncilDispatchOperation | null> {
    return this.dispatchOperations.get(key(context.workspaceId, dispatchId)) ?? null;
  }

  async loadDispatchAction(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string
  ): Promise<FinancialCouncilDispatchAction> {
    const seed = this.dispatchSeed(context.workspaceId, dispatchId);
    const operation = this.dispatchOperations.get(
      key(context.workspaceId, dispatchId)
    );
    const revision = this.portfolioRevisions.get(portfolioKey(
      seed.workspaceId, seed.runId, seed.portfolioRevision
    ));
    if (!operation || !revision) {
      throw financialCouncilError("financial_council_dispatch_stale");
    }
    await this.assertStoredPortfolioRevision(revision, true);
    const portfolio = revision.portfolios.find((row) =>
      row.kind === seed.portfolioKind
    );
    const action = portfolio?.actions.find((row) =>
      row.actionId === seed.actionId
    );
    if (!portfolio || !action
      || financialCouncilCanonicalHash(portfolio) !== seed.portfolioOutputHash
      || financialCouncilCanonicalHash(action) !== seed.actionHash
      || operation.dispatchId !== seed.dispatchId
      || operation.workspaceId !== seed.workspaceId
      || operation.runId !== seed.runId
      || operation.approvalId !== seed.approvalId
      || operation.approvalHash !== seed.approvalHash
      || operation.portfolioRevision !== seed.portfolioRevision
      || operation.portfolioKind !== seed.portfolioKind
      || operation.actionId !== seed.actionId
      || operation.actionHash !== seed.actionHash
      || operation.resultHash !== seed.resultHash
      || operation.portfolioOutputHash !== seed.portfolioOutputHash) {
      throw financialCouncilError("financial_council_dispatch_stale");
    }
    return immutableFinancialCouncilValue({ operation, action });
  }

  async completeDispatchOperation(lease: FinancialCouncilDispatchLease,
    receipt: FinancialCouncilDispatchReceipt, completedAt: string): Promise<void> {
    const operationKey = key(lease.workspaceId, lease.dispatchId);
    const current = this.dispatchOperations.get(operationKey);
    if (!current || receipt.dispatchId !== current.dispatchId
      || receipt.workspaceId !== current.workspaceId
      || receipt.dispatchHash !== current.dispatchHash) {
      throw financialCouncilError("financial_council_dispatch_receipt_invalid");
    }
    const next = completeFinancialCouncilDispatchOperation(current, {
      workerId: lease.workerId, leaseToken: lease.leaseToken, attempt: lease.attempt,
      completedAt, receiptId: receipt.receiptId
    });
    const operations = new Map(this.dispatchOperations);
    const receipts = new Map(this.dispatchReceipts);
    operations.set(operationKey, next);
    receipts.set(operationKey, immutableFinancialCouncilValue(receipt));
    this.state = { ...this.state, dispatchOperations: operations, dispatchReceipts: receipts };
  }

  async failDispatchOperation(lease: FinancialCouncilDispatchLease, input: {
    readonly errorCode: string; readonly retryable: boolean; readonly completedAt: string;
  }): Promise<void> {
    const operationKey = key(lease.workspaceId, lease.dispatchId);
    const current = this.dispatchOperations.get(operationKey);
    if (!current) throw financialCouncilError("financial_council_dispatch_not_found");
    const next = failFinancialCouncilDispatchOperation(current, {
      workerId: lease.workerId, leaseToken: lease.leaseToken, attempt: lease.attempt,
      ...input
    });
    const operations = new Map(this.dispatchOperations);
    operations.set(operationKey, next);
    this.state = { ...this.state, dispatchOperations: operations };
  }

  async listRecoverableDispatches(now: string, limit: number): Promise<readonly {
    workspaceId: string; dispatchId: `sha256:${string}`;
  }[]> {
    const at = Date.parse(now);
    return Object.freeze([...this.dispatchOutbox.values()].filter((seed) => {
      const operation = this.dispatchOperations.get(key(seed.workspaceId, seed.dispatchId));
      return !operation || operation.status === "queued" || operation.status === "retry"
        || (operation.status === "running" && operation.leaseExpiresAt !== null
          && Date.parse(operation.leaseExpiresAt) <= at);
    }).sort((a, b) => utf8ByteCompare(a.workspaceId, b.workspaceId)
      || utf8ByteCompare(a.dispatchId, b.dispatchId)).slice(0, limit)
      .map((row) => Object.freeze({ workspaceId: row.workspaceId,
        dispatchId: row.dispatchId })));
  }

  async publishPortfolioRevisionWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: PublishFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    const stable = immutableFinancialCouncilInput(input);
    this.requireLiveAnalysisLease(lease, stable.occurredAt);
    if (stable.revision !== 1 || !HASH.test(stable.expectedOutputHash)) {
      throw financialCouncilError("financial_council_portfolio_invalid");
    }
    const aggregateKey = key(lease.workspaceId, lease.runId);
    const current = this.runs.get(aggregateKey);
    if (!current || current.status !== "optimizing") {
      throw financialCouncilError("financial_council_portfolio_state_invalid");
    }
    const revision = this.portfolioRevisions.get(portfolioKey(
      lease.workspaceId, lease.runId, stable.revision
    ));
    if (!revision) {
      throw financialCouncilError("financial_council_portfolio_not_found");
    }
    await this.assertStoredPortfolioRevision(revision, true);
    if (revision.outputHash !== stable.expectedOutputHash) {
      throw financialCouncilError("financial_council_portfolio_integrity");
    }
    const consensus = this.consensusReports.get(
      key(lease.workspaceId, lease.runId)
    );
    if (!consensus || consensus.reportId !== revision.consensusReportId) {
      historyIntegrity();
    }
    const withPortfolio = immutableFinancialCouncilValue({
      ...current,
      consensusReport: consensus,
      portfolios: revision.portfolios,
      latestPortfolioRevision: revision.revision
    });
    const next = applyFinancialCouncilTransition(withPortfolio, {
      kind: "awaiting_approval",
      occurredAt: stable.occurredAt,
      actorId: this.analysisControls.get(aggregateKey)!.ownerId
    });
    const event = createFinancialCouncilRunEvent(next, {
      fromStatus: current.status,
      reasonCode: null,
      occurredAt: stable.occurredAt,
      actorId: this.analysisControls.get(aggregateKey)!.ownerId
    });
    const runs = new Map(this.runs);
    const events = new Map(this.events);
    runs.set(aggregateKey, next);
    events.set(aggregateKey, [...(events.get(aggregateKey) ?? []), event]);
    this.state = { ...this.state, runs, events };
    return { value: next, replayed: false };
  }

  private optimizationCandidates(
    runId: string,
    consensus: ConsensusReport
  ): readonly FinancialCouncilCandidateAction[] {
    return selectFinancialCouncilOptimizationCandidates(consensus,
      [...this.specialistResults.values()].filter((result) =>
        result.runId === runId));
  }

  private async assertStoredPortfolioRevision(
    revision: FinancialCouncilPortfolioRevision,
    stored: boolean
  ): Promise<void> {
    try {
      const { revisionId, outputHash, ...input } =
        immutableFinancialCouncilInput(revision);
      const rebuilt = createFinancialCouncilPortfolioRevision(input);
      if (financialCouncilCanonicalJson(rebuilt)
        !== financialCouncilCanonicalJson(revision)) inputInvalid();
      const run = this.runs.get(key(revision.workspaceId, revision.runId));
      const consensus = this.consensusReports.get(
        key(revision.workspaceId, revision.runId)
      );
      const graph = this.auditGraphs.get(key(
        revision.workspaceId, revision.runId
      ));
      if (!run || !consensus || !graph
        || revision.runHash !== financialCouncilOptimizationRunHash(run)
        || revision.snapshotId !== run.snapshotId
        || revision.snapshotHash !== run.snapshotHash
        || revision.auditHash !== graph.graphHash
        || revision.policyVersionId !== run.policyVersionId
        || revision.consensusReportId !== consensus.reportId
        || revision.candidateSetHash !== financialCouncilCanonicalHash(
          this.optimizationCandidates(run.runId, consensus))
        || Date.parse(revision.createdAt) < Date.parse(consensus.createdAt)
        || Date.parse(revision.createdAt) > Date.parse(run.expiresAt)
        || revisionId !== rebuilt.revisionId
        || outputHash !== rebuilt.outputHash) inputInvalid();
      const candidates = new Map(this.optimizationCandidates(
        run.runId, consensus
      ).map((action) => [action.actionId, action]));
      for (const portfolio of revision.portfolios) {
        for (const action of portfolio.actions) {
          const original = candidates.get(action.actionId);
          if (!original || !financialCouncilActionEditIsSafe(original, action)) {
            inputInvalid();
          }
        }
      }
    } catch (error) {
      if (stored) historyIntegrity();
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "financial_council_portfolio_invalid") throw error;
      throw financialCouncilError("financial_council_portfolio_invalid");
    }
  }

  private async assertStoredConsensus(
    context: ActiveWorkspaceContext,
    consensus: ConsensusReport,
    stored: boolean
  ): Promise<void> {
    try {
      const graph = await this.getAuditGraph(context, consensus.runId);
      const verified = await this.getVerifiedRunSnapshot(
        context, consensus.runId
      );
      const dispositions = await this.listFindingDispositions(
        context, consensus.runId
      );
      const results = await this.listSpecialistResults(
        context, consensus.runId
      );
      const findings = results.filter((result) => result.phase === "analyze")
        .flatMap((result) => result.findings);
      const snapshotRecord = verified && this.snapshots.get(key(
        context.workspaceId, verified.run.snapshotId!
      ));
      if (!graph || !verified || !snapshotRecord) inputInvalid();
      validateFinancialCouncilConsensusReport(consensus, {
        graph, findings, dispositions, dataGaps: verified.snapshot.dataGaps,
        earliestCreatedAt: snapshotRecord.createdAt,
        expiresAt: verified.run.expiresAt
      });
    } catch (error) {
      if (stored) historyIntegrity();
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "financial_council_consensus_invalid"
        || code === "financial_council_input_invalid") {
        throw financialCouncilError("financial_council_consensus_invalid");
      }
      if (code) throw error;
      throw financialCouncilError("financial_council_consensus_invalid");
    }
  }

  private assertStoredSpecialistResult(
    raw: FinancialCouncilSpecialistResult
  ): FinancialCouncilSpecialistResult {
    try {
      const result = validateFinancialCouncilSpecialistResult(raw);
      const prefix = `${result.workspaceId}\u0000${result.runId}\u0000`
        + `${result.role}\u0000${result.phase}\u0000`;
      const storedFindings = [...this.specialistFindings]
        .filter(([storedKey]) => storedKey.startsWith(prefix))
        .map(([, stored]) => stored.value);
      const storedActions = [...this.specialistActions]
        .filter(([storedKey]) => storedKey.startsWith(prefix))
        .map(([, stored]) => stored.value);
      if (financialCouncilCanonicalJson(storedFindings.sort((left, right) =>
          utf8ByteCompare(left.findingId, right.findingId)))
          !== financialCouncilCanonicalJson([...result.findings]
            .sort((left, right) => utf8ByteCompare(
              left.findingId, right.findingId
            )))
        || financialCouncilCanonicalJson(storedActions.sort((left, right) =>
          utf8ByteCompare(left.actionId, right.actionId)))
          !== financialCouncilCanonicalJson([...result.actions]
            .sort((left, right) => utf8ByteCompare(
              left.actionId, right.actionId
            )))) historyIntegrity();
      return result;
    } catch {
      historyIntegrity();
    }
  }

  private assertStoredRun(run: FinancialCouncilRun): void {
    const aggregateKey = key(run.workspaceId, run.runId);
    const events = this.events.get(aggregateKey) ?? [];
    const eventRun = events.at(-1)?.aggregateSnapshot;
    const isEditedPortfolioOverlay = eventRun?.status === "awaiting_approval"
      && run.status === "awaiting_approval"
      && eventRun.revision === run.revision
      && (run.latestPortfolioRevision ?? 0)
        > (eventRun.latestPortfolioRevision ?? 0);
    assertFinancialCouncilRunHistory(
      isEditedPortfolioOverlay ? eventRun : run, events
    );
    let snapshotRecord: FinancialSnapshotRecord | null = null;
    if (run.snapshotId !== null) {
      const snapshot = this.snapshots.get(key(run.workspaceId, run.snapshotId));
      if (!snapshot) historyIntegrity();
      try {
        assertFinancialSnapshotRecordValue(snapshot);
        assertFinancialSnapshotRecord(run, snapshot);
        assertFinancialSnapshotFreezeTime(snapshot, events);
      } catch {
        historyIntegrity();
      }
      snapshotRecord = snapshot;
    } else if (run.status !== "created") {
      historyIntegrity();
    }
    if (run.latestPortfolioRevision !== null) {
      const revision = this.portfolioRevisions.get(portfolioKey(
        run.workspaceId, run.runId, run.latestPortfolioRevision
      ));
      const consensus = this.consensusReports.get(key(
        run.workspaceId, run.runId
      ));
      if (!revision || !consensus
        || revision.outputHash !== financialCouncilCanonicalHash(
          revision.portfolios)
        || revision.consensusReportId !== consensus.reportId
        || financialCouncilCanonicalJson(run.consensusReport)
          !== financialCouncilCanonicalJson(consensus)
        || financialCouncilCanonicalJson(run.portfolios)
          !== financialCouncilCanonicalJson(revision.portfolios)) {
        historyIntegrity();
      }
      const graph = this.auditGraphs.get(key(run.workspaceId, run.runId));
      if (!graph || !snapshotRecord) historyIntegrity();
      const results = [...this.specialistResults.values()].filter((result) =>
        result.workspaceId === run.workspaceId && result.runId === run.runId)
        .map((result) => this.assertStoredSpecialistResult(result));
      const dispositions = [...this.findingDispositions.values()]
        .filter((item) => item.workspaceId === run.workspaceId
          && item.runId === run.runId);
      try {
        validateFinancialCouncilConsensusReport(consensus, {
          graph,
          findings: results.filter((result) => result.phase === "analyze")
            .flatMap((result) => result.findings),
          dispositions,
          dataGaps: validateFinancialSnapshotForRun(
            snapshotRecord.snapshot, run
          ).dataGaps,
          earliestCreatedAt: snapshotRecord.createdAt,
          expiresAt: run.expiresAt
        });
      } catch {
        historyIntegrity();
      }
    }
  }
}

function specialistKey(
  workspaceId: string,
  runId: string,
  role: FinancialCouncilAgentRole,
  phase: FinancialCouncilSpecialistPhase
): string {
  return `${workspaceId}\u0000${runId}\u0000${role}\u0000${phase}`;
}

function rebuttalKey(
  workspaceId: string,
  runId: string,
  role: FinancialCouncilAgentRole,
  round: number
): string {
  return `${workspaceId}\u0000${runId}\u0000${role}\u0000${round}`;
}

function dispositionKey(
  workspaceId: string,
  runId: string,
  findingId: string
): string {
  return `${workspaceId}\u0000${runId}\u0000${findingId}`;
}

function portfolioKey(
  workspaceId: string,
  runId: string,
  revision: number
): string {
  return `${workspaceId}\u0000${runId}\u0000${revision}`;
}

function rebuttalContentHash(input: FinancialCouncilRebutInput):
`sha256:${string}` {
  return financialCouncilCanonicalHash({
    allowlist: input.allowlist,
    businessData: input.businessData,
    targetFindingId: input.targetFindingId,
    conflictData: input.conflictData
  });
}

function compareSpecialist(
  left: FinancialCouncilSpecialistResult,
  right: FinancialCouncilSpecialistResult
): number {
  const roleOrder = ["finance", "profit", "cost", "cashflow", "tax"];
  return roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role)
    || left.phase.localeCompare(right.phase);
}

function utf8ByteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
