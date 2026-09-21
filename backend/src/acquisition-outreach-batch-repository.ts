import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PlatformExecutionAccess } from './platform-execution-access.js';
import type {
  AcquisitionOutreachAction,
  AcquisitionOutreachActionExecutionTarget,
  AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  outreachIndependentDirectMessageApprovalHash, validOutreachTarget } from "./acquisition-outreach-batch.js";
import type { AcquisitionMemoryTransactionCoordinator,
  AcquisitionMemoryTransactionToken } from "./acquisition-memory-transaction-coordinator.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { localDateInTimeZone } from "./acquisition-douyin-automation.js";
import { resolveTenantBusinessInstant } from "./tenant-time.js";
import { canonicalizeDouyinOutreachTargetUrl, desktopOutreachRequestHash } from
  "./acquisition-outreach-target-url.js";
import { desktopOutreachReceiptHash } from "./acquisition-outreach-target-url.js";
import { classifyOutreachActionReceipt } from "./acquisition-outreach-action-worker.js";
import type { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import type { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";

export type OutreachRepositoryResult<T> =
  | { kind: "created"; value: T }
  | { kind: "replay"; value: T }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "stale" };

export interface OutreachBatchListAnchor {
  createdAt: string;
  batchId: string;
}

export interface OutreachBatchRepositoryPage {
  items: AcquisitionOutreachBatch[];
  next: OutreachBatchListAnchor | null;
}

export interface AcquisitionOutreachBatchRepository {
  find(workspaceId: string, batchId: string): Promise<AcquisitionOutreachBatch | null>;
  listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: OutreachBatchListAnchor | null }): Promise<OutreachBatchRepositoryPage>;
  create(input: { workspaceId: string; operation: string; idempotencyKey: string;
    requestHash: string; batch: AcquisitionOutreachBatch }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  replace(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  approve(input: { workspaceId: string; batchId: string; ifMatch: string;
    idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch, remaining: number): Promise<{
      batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
    }>;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    accountLoginStateVersion?: number;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }>;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  transition(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  listActions(workspaceId: string, batchId: string): Promise<AcquisitionOutreachAction[] | null>;
  remaining(workspaceId: string, accountId: string, localDate: string,
    dailyLimit: number): Promise<number>;
  claimNextAction(input: OutreachActionClaimInput): Promise<OutreachActionClaim | null>;
  claimNextDesktopAction(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer):
    Promise<DesktopOutreachClaimResult>;
  listNonTerminalServerActions(input: { workspaceId: string; limit: number }):
    Promise<NonTerminalServerOutreachActions>;
  completeActionSuccess(fence: OutreachActionFence,
    receipt: OutreachActionSuccessReceipt): Promise<boolean>;
  completeActionFailure(fence: OutreachActionFence, failureCode: string,
    occurredAt: string): Promise<{ completed: boolean; accountPaused: boolean }>;
  completeActionRetry(fence: OutreachActionFence, failureCode: "douyin_profile_busy" | "platform_execution_denied",
    occurredAt: string): Promise<boolean>;
  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }): Promise<boolean>;
  actionExecutionGate(workspaceId: string, batchId: string):
    Promise<OutreachActionExecutionGate | null>;
  recoverAccountActions(input: {
    workspaceId: string; batchId: string; batchRevision: number;
    ifMatch: string;
    accountLoginStateVersion: number; pendingActionIds: readonly string[];
    acknowledgedUncertainActionIds: readonly string[];
    actorId: string; reason: string; recoveredAt: string;
    operation: string; idempotencyKey: string; requestHash: string;
  }): Promise<OutreachRepositoryResult<OutreachActionAccountRecovery>>;
  recordDesktopReconciliation(input: DesktopOutreachHumanReconciliationInput):
    Promise<DesktopOutreachHumanReconciliationResult>;
  recoverExpiredActionClaims(now: string): Promise<number>;
}

export type OutreachUncertainActionFailureCode = "action_unavailable" |
  "douyin_action_timeout" | "douyin_action_receipt_ambiguous";

export interface OutreachActionExecutionGate {
  accountId: string;
  accountLoginStateVersion: number;
  riskPaused: boolean;
  pendingActionIds: string[];
  unresolvedActions: Array<{
    actionId: string;
    failureCode: OutreachUncertainActionFailureCode;
  }>;
}

export interface OutreachActionAccountRecovery extends OutreachActionExecutionGate {
  enabledActionIds: string[];
  acknowledgedUncertainActionIds: string[];
  recoveredBy: string;
  recoveredAt: string;
}

export interface DesktopOutreachHumanReconciliationRequest {
  requestedByUserId: string;
  requestedAt: string;
  expectedExecutionLeaseVersion: number;
}
export interface DesktopOutreachHumanReconciliationInput {
  workspaceId: string;
  batchId: string;
  actionId: string;
  batchRevision: number;
  approvalHash: string;
  contentHash: string;
  requestedByUserId: string;
  requestedAt: string;
  operation: "request_desktop_action_reconciliation";
  idempotencyKey: string;
  requestHash: string;
}
export type DesktopOutreachHumanReconciliationResult =
  | { kind: "created" | "replay"; value: AcquisitionOutreachAction & {
      reconciliationRequest: DesktopOutreachHumanReconciliationRequest } }
  | { kind: "conflict" | "not_found" | "stale" };

export interface OutreachActionFence {
  actionId: string; workerId: string; leaseToken: string; fencingToken: number;
}
export interface OutreachActionClaimInput {
  workerId: string; now: string; leaseDurationMs: number;
  executionTarget: AcquisitionOutreachActionExecutionTarget;
}
export interface OutreachActionClaim {
  action: AcquisitionOutreachAction;
  fence: OutreachActionFence;
  claimedAt: string;
  leaseExpiresAt: string;
}
export interface OutreachActionSuccessReceipt {
  platformReceiptReference: string; occurredAt: string;
}

export interface DesktopOutreachAvailableAccount {
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  bindingGeneration: number;
}
export interface DesktopOutreachClaimAuthorityAccount {
  id: string;
  workspaceId: string;
  state: string;
  accountHandle: string | null;
  displayName: string | null;
  loginStateVersion: number | null;
  executorMode: string | null;
  executorDeviceIdHash: string | null;
  executorBindingGeneration: number;
  executorLeaseExpiresAt: string | null;
}
export interface DesktopOutreachClaimAuthoritySnapshot {
  readonly action: Readonly<AcquisitionOutreachAction>;
  readonly batch: Readonly<AcquisitionOutreachBatch>;
  readonly siblings: readonly Readonly<AcquisitionOutreachAction>[];
  readonly predecessor: Readonly<AcquisitionOutreachAction> | null;
  readonly account: Readonly<DesktopOutreachClaimAuthorityAccount>;
}
export type DesktopOutreachClaimAuthorityDecision =
  | { accountHandle: string }
  | { failureCode: "approval_authority_changed" }
  | null;
export type DesktopOutreachClaimAuthorizer = (
  snapshot: DesktopOutreachClaimAuthoritySnapshot
) => Promise<DesktopOutreachClaimAuthorityDecision>;
export interface DesktopOutreachClaimInput {
  workspaceId: string;
  deviceIdHash: string;
  processInstanceIdHash: string;
  availableAccounts: readonly DesktopOutreachAvailableAccount[];
  idempotencyKeyHash: string;
  claimRequestHash: string;
  now: string;
  actionDeadlineAt: string;
  leaseDurationMs: number;
}
export interface DesktopOutreachActionFence extends OutreachActionFence {
  workspaceId: string;
  deviceIdHash: string;
  processInstanceIdHash: string;
  executorBindingGeneration: number;
  taskTokenHash: string;
  taskRequestHash: string;
  platformWriteAttemptCount: 0;
}
export interface DesktopOutreachActionTask {
  actionId: string;
  workspaceId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  executorBindingGeneration: number;
  kind: "comment" | "direct_message";
  canonicalTargetPublicUrl: string;
  content: string;
  approvedContentHash: string;
  taskRequestHash: string;
  deadlineAt: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  predecessorReceipt: string | null;
}
export type DesktopOutreachClaimResult =
  | { kind: "claimed"; task: DesktopOutreachActionTask; taskToken: string;
      fence: DesktopOutreachActionFence; serverTime: string; replayed: boolean }
  | { kind: "empty"; serverTime: string; retryAfterMs: number; replayed: boolean };

export type DesktopOutreachCompletionState = "executing" | "succeeded" | "failed" |
  "queued" | "risk_paused" | "reconciliation_required";
export interface DesktopOutreachCompletionResult {
  actionId: string;
  state: DesktopOutreachCompletionState;
  replayed: boolean;
  accountPaused: boolean;
  occurredAt: string;
}
interface DesktopOutreachCompletionFenceInput {
  workspaceId: string;
  actionId: string;
  deviceIdHash: string;
  processInstanceIdHash: string;
  taskTokenHash: string;
  leaseVersion: number;
  executorBindingGeneration: number;
  loginStateVersion: number;
  taskRequestHash: string;
  idempotencyKeyHash: string;
  requestHash: string;
  occurredAt: string;
  now: string;
}
export interface DesktopOutreachStartedRepositoryInput
  extends DesktopOutreachCompletionFenceInput {}
export interface DesktopOutreachReceiptRepositoryInput
  extends DesktopOutreachCompletionFenceInput {
  reconciliation: false;
  receipt: {
    actionId: string;
    state: "succeeded" | "failed";
    platformReceiptReference: string | null;
    occurredAt: string;
    failureCode: string | null;
  };
  receiptHash: string;
  stateEffect: Exclude<DesktopOutreachCompletionState, "executing">;
}
export interface DesktopOutreachReconciliationReceiptRepositoryInput
  extends DesktopOutreachCompletionFenceInput {
  reconciliation: true;
  receipt: {
    actionId: string;
    state: "succeeded" | "failed";
    platformReceiptReference: string | null;
    occurredAt: string;
    failureCode: null | "action_unavailable" | "douyin_action_receipt_ambiguous";
  };
  receiptHash: string;
  stateEffect: "succeeded" | "reconciliation_required";
}

export interface AcquisitionDesktopOutreachRepository {
  claimDesktopHumanReconciliation?(input: DesktopOutreachClaimInput):
    Promise<(Extract<DesktopOutreachRecoveryResult, { kind: "reconcile" }> & { serverTime: string }) |
      Extract<DesktopOutreachClaimResult, { kind: "empty" }> | null>;
  claimNextDesktopAction(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer):
    Promise<DesktopOutreachClaimResult>;
  markDesktopActionStarted(input: DesktopOutreachStartedRepositoryInput):
    Promise<DesktopOutreachCompletionResult>;
  completeDesktopAction(input: DesktopOutreachReceiptRepositoryInput):
    Promise<DesktopOutreachCompletionResult>;
  completeDesktopReconciliation(
    input: DesktopOutreachReconciliationReceiptRepositoryInput):
    Promise<DesktopOutreachCompletionResult>;
  recoverDesktopAction(input: DesktopOutreachRecoveryRepositoryInput):
    Promise<DesktopOutreachRecoveryResult>;
}

export type DesktopOutreachRecoveryJournalPhase = "claimed" | "central_started" |
  "sidecar_completed";
export interface DesktopOutreachRecoveryRepositoryInput {
  /** Server-discovered human request only; never accepted from the device wire. */
  humanRequestKey?: string;
  humanClaimRequestHash?: string;
  workspaceId: string;
  actionId: string;
  deviceIdHash: string;
  processInstanceIdHash: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  bindingGeneration: number;
  originalLeaseVersion: number;
  taskRequestHash: string;
  journalPhase: DesktopOutreachRecoveryJournalPhase;
  receiptHash: string | null;
  idempotencyKeyHash: string;
  requestHash: string;
  now: string;
  recoveryLeaseExpiresAt: string;
}
export interface DesktopOutreachReconciliationTask {
  actionId: string;
  workspaceId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  /** Current same-account login used only to observe an immutable older attempt. */
  observationLoginStateVersion?: number;
  executorBindingGeneration: number;
  kind: "comment" | "direct_message";
  canonicalTargetPublicUrl: string;
  content: string;
  approvedContentHash: string;
  deadlineAt: string;
  taskRequestHash: string;
  leaseVersion: number;
  originalLeaseVersion: number;
  reconciliationGeneration: number;
  capability: "reconcile_only";
}
export type DesktopOutreachRecoveryResult =
  | { kind: "waiting"; retryAfterMs: number; replayed: boolean }
  | { kind: "released"; actionId: string; taskRequestHash: string;
      originalLeaseVersion: number; replayed: boolean }
  | { kind: "terminal"; status: string; receiptHash: string; replayed: boolean }
  | { kind: "not_authorized"; replayed: boolean }
  | { kind: "reconcile"; replayed: boolean; taskToken: string;
      task: DesktopOutreachReconciliationTask };

export function assertValidDesktopOutreachClaimInput(input: DesktopOutreachClaimInput) {
  const exactKeys = ["workspaceId", "deviceIdHash", "processInstanceIdHash",
    "availableAccounts", "idempotencyKeyHash", "claimRequestHash", "now",
    "actionDeadlineAt", "leaseDurationMs"];
  const timestamp = (value: unknown) => {
    if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  };
  const accountKeys = ["accountId", "accountHandle", "loginStateVersion",
    "bindingGeneration"];
  const now = Date.parse(input?.now); const deadline = Date.parse(input?.actionDeadlineAt);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== exactKeys.length
    || exactKeys.some((key) => !(key in input))
    || typeof input.workspaceId !== "string" || !input.workspaceId
    || input.workspaceId.length > 255
    || !/^sha256:[0-9a-f]{64}$/u.test(input.deviceIdHash)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.processInstanceIdHash)
    || !/^[0-9a-f]{64}$/u.test(input.idempotencyKeyHash)
    || !/^[0-9a-f]{64}$/u.test(input.claimRequestHash)
    || !timestamp(input.now) || !timestamp(input.actionDeadlineAt)
    || !Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 90_000 || input.leaseDurationMs > 360_000
    || deadline < now + 60_000 || deadline > now + 330_000
    || deadline + 30_000 !== now + input.leaseDurationMs
    || !Array.isArray(input.availableAccounts) || input.availableAccounts.length < 1
    || input.availableAccounts.some((account) => !account
      || typeof account !== "object" || Array.isArray(account)
      || Object.keys(account).length !== accountKeys.length
      || accountKeys.some((key) => !(key in account))
      || typeof account.accountId !== "string" || !account.accountId
      || account.accountId.length > 255
      || !/^dyacct_[0-9a-f]{64}$/u.test(account.accountHandle)
      || !Number.isSafeInteger(account.loginStateVersion)
      || account.loginStateVersion < 1
      || !Number.isSafeInteger(account.bindingGeneration)
      || account.bindingGeneration < 1)
    || new Set(input.availableAccounts.map((account) => account.accountId)).size
      !== input.availableAccounts.length) {
    throw new TypeError("invalid_desktop_outreach_claim");
  }
  return { now, deadline };
}

export function issueDesktopOutreachTaskToken(key: Uint8Array,
  task: DesktopOutreachActionTask,
  fence: Pick<DesktopOutreachActionFence, "workspaceId" | "deviceIdHash" |
    "processInstanceIdHash" | "fencingToken" | "executorBindingGeneration" |
    "taskRequestHash">) {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error("desktop_outreach_task_token_key_unavailable");
  }
  return createHmac("sha256", key).update([
    "shensi-desktop-outreach-task-v1", fence.workspaceId, fence.deviceIdHash,
    fence.processInstanceIdHash, task.actionId, String(fence.fencingToken),
    String(fence.executorBindingGeneration), fence.taskRequestHash
  ].join("\0"), "utf8").digest("base64url");
}

export interface NonTerminalServerOutreachActionSummary {
  actionId: string;
  batchId: string;
  accountId: string;
  status: "queued" | "blocked_by_predecessor" | "claimed" | "executing"
    | "reconciliation_required";
  createdAt: string;
}
export interface NonTerminalServerOutreachActions {
  count: number;
  items: NonTerminalServerOutreachActionSummary[];
}

interface Replay { requestHash: string; value: AcquisitionOutreachBatch; }
interface State {
  batches: Map<string, AcquisitionOutreachBatch[]>;
  actions: Map<string, AcquisitionOutreachAction[]>;
  replays: Map<string, Replay>;
  dailyCandidates: Set<string>;
  actionRuntime: Map<string, { workerId: string | null; leaseToken: string | null;
    fencingToken: number; leaseExpiresAt: string | null; claimedAt: string | null;
    nextEligibleAt: string | null; attemptCount: number }>;
  accounts: Map<string, { nextEligibleAt: string | null; consecutiveFailures: number;
    paused: boolean }>;
  directMessageClaims: Array<{ workspaceId: string; accountId: string;
    localDate: string; actionId: string; fencingToken: number }>;
  recoveryReplays: Map<string, { requestHash: string;
    value: OutreachActionAccountRecovery }>;
  recoveryAudit: OutreachActionAccountRecovery[];
  desktopClaimReplays: Map<string, { claimRequestHash: string;
    response: Omit<Extract<DesktopOutreachClaimResult, { kind: "claimed" }>,
      "taskToken" | "replayed"> | Omit<Extract<DesktopOutreachClaimResult,
        { kind: "empty" }>, "replayed"> }>;
  desktopAttempts: Array<{ actionId: string; fencingToken: number;
    taskTokenHash: string; taskRequestHash: string; deviceIdHash: string;
    processInstanceIdHash: string; executorBindingGeneration: number;
    deadlineAt: string;
    platformWriteAttemptCount: 0 | 1;
    startedAt: string | null;
    startedRequestHash: string | null;
    startedResponse: DesktopOutreachCompletionResult | null;
    receiptHash: string | null;
    receiptRequestHash: string | null;
    receiptOperation: "original" | "reconciliation" | null;
    receiptJson: {
      actionId: string;
      state: "succeeded" | "failed";
      platformReceiptReference: string | null;
      occurredAt: string;
      failureCode: string | null;
    } | null;
    receiptResponse: DesktopOutreachCompletionResult | null;
    outcome: DesktopOutreachCompletionState | null;
    recoveryGeneration: number;
    recoveryProcessInstanceIdHash: string | null;
    recoveryTaskTokenHash: string | null;
    recoveryLeaseExpiresAt: string | null }>;
  desktopCompletionReplays: Map<string, { requestHash: string;
    response: DesktopOutreachCompletionResult }>;
  desktopRecoveryReplays: Map<string, { requestHash: string;
    response: Exclude<DesktopOutreachRecoveryResult, { kind: "reconcile" }> |
      Omit<Extract<DesktopOutreachRecoveryResult, { kind: "reconcile" }>,
        "taskToken" | "replayed"> }>;
  desktopHumanReconciliationReplays: Map<string, { requestHash: string;
    value: AcquisitionOutreachAction & {
      reconciliationRequest: DesktopOutreachHumanReconciliationRequest } }>;
  desktopHumanReconciliationAudit: Array<Omit<DesktopOutreachHumanReconciliationInput,
    "idempotencyKey"> & {
    idempotencyKeyHash: string;
    expectedExecutionLeaseVersion: number;
  }>;
}
function clone<T>(value: T): T { return structuredClone(value); }
function completedUncertainDesktopComment(state: State, other: AcquisitionOutreachAction, now: string) {
  const runtime = state.actionRuntime.get(other.id);
  const attempt = state.desktopAttempts.find(value => value.actionId === other.id
    && value.fencingToken === runtime?.fencingToken);
  return other.executionTarget === "desktop" && !!attempt?.receiptResponse
    && !!attempt.receiptJson && !!attempt.receiptHash
    && runtime?.workerId === null && runtime.leaseToken === null && runtime.leaseExpiresAt === null
    && (!attempt.recoveryLeaseExpiresAt || Date.parse(attempt.recoveryLeaseExpiresAt) <= Date.parse(now));
}

export function outreachActionBlocksAccountLane(next: AcquisitionOutreachAction,
  other: AcquisitionOutreachAction, previousExecutionSettled: boolean) {
  if (other.id === next.id || other.workspaceId !== next.workspaceId || other.accountId !== next.accountId) return false;
  if (other.status === "claimed" || other.status === "executing") return true;
  if (other.status !== "reconciliation_required") return false;
  // Preserve the uncertain write forever, but do not make its missing receipt a
  // dependency of a separately confirmed DM after the old execution is settled.
  return !(next.kind === "direct_message" && next.authorizationVersion === 3
    && other.kind === "comment" && previousExecutionSettled);
}
function persistDesktopAttemptReceipt(
  attempt: State["desktopAttempts"][number],
  input: DesktopOutreachReceiptRepositoryInput |
    DesktopOutreachReconciliationReceiptRepositoryInput,
  response: DesktopOutreachCompletionResult
) {
  attempt.receiptHash = input.receiptHash;
  attempt.receiptRequestHash = input.requestHash;
  attempt.receiptOperation = input.reconciliation ? "reconciliation" : "original";
  attempt.receiptJson = clone({
    actionId: input.receipt.actionId,
    state: input.receipt.state,
    platformReceiptReference: input.receipt.platformReceiptReference,
    occurredAt: input.receipt.occurredAt,
    failureCode: input.receipt.failureCode
  });
  attempt.receiptResponse = clone(response);
  attempt.outcome = response.state;
}
function matchesPersistedDesktopAttemptReceipt(
  attempt: State["desktopAttempts"][number],
  input: DesktopOutreachReceiptRepositoryInput |
    DesktopOutreachReconciliationReceiptRepositoryInput
) {
  const receipt = attempt.receiptJson;
  const operation = input.reconciliation ? "reconciliation" : "original";
  const requestMatchesOperation = attempt.receiptOperation === operation
    ? attempt.receiptRequestHash === input.requestHash
    : attempt.receiptOperation !== null;
  return requestMatchesOperation && attempt.receiptHash === input.receiptHash
    && Boolean(receipt)
    && receipt!.actionId === input.receipt.actionId
    && receipt!.state === input.receipt.state
    && receipt!.platformReceiptReference === input.receipt.platformReceiptReference
    && receipt!.occurredAt === input.receipt.occurredAt
    && receipt!.failureCode === input.receipt.failureCode;
}
function replayKey(workspaceId: string, operation: string, key: string) {
  return `${workspaceId}\u0000${operation}\u0000${createHash("sha256").update(key).digest("hex")}`;
}
function batchKey(workspaceId: string, batchId: string) { return `${workspaceId}\u0000${batchId}`; }
function dailyPrefix(workspaceId: string, accountId: string, localDate: string) {
  return `${workspaceId}\u0000${accountId}\u0000${localDate}\u0000`;
}

function nextCalendarDate(localDate: string) {
  const value = new Date(`${localDate}T12:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) throw new TypeError("invalid_outreach_local_date");
  return new Date(value.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function outreachLocalDay(instant: string, timeZone: string) {
  return localDateInTimeZone(instant, timeZone);
}

export function outreachLocalDayUtcBounds(instant: string, timeZone: string) {
  const localDate = outreachLocalDay(instant, timeZone);
  const start = resolveTenantBusinessInstant(localDate, timeZone);
  const end = resolveTenantBusinessInstant(nextCalendarDate(localDate), timeZone);
  if (!start || !end) throw new TypeError("invalid_outreach_local_day");
  return { localDate, start, end };
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

export function frozenOutreachAuthorityClone<T>(value: T): T {
  const result = structuredClone(value);
  deepFreeze(result);
  return result;
}

export function validFrozenDirectMessageSuccessorAuthority(
  action: AcquisitionOutreachAction,
  batch: AcquisitionOutreachBatch, predecessor: AcquisitionOutreachAction | undefined) {
  if (typeof batch.timeZone !== "string" || !batch.timeZone.trim()) return false;
  let approvedLocalDate: string;
  try {
    approvedLocalDate = outreachLocalDay(String(action.approvedAt), batch.timeZone);
  } catch {
    return false;
  }
  if (action.kind !== "direct_message" || action.authorizationVersion !== 2
    || action.sequence !== 2 || batch.state !== "approved"
    || batch.id !== action.batchId || batch.workspaceId !== action.workspaceId
    || batch.revision !== action.batchRevision || batch.accountId !== action.accountId
    || batch.accountLoginStateVersion !== action.accountLoginStateVersion
    || batch.policyVersionId !== action.policyVersionId
    || approvedLocalDate !== action.localDate || !batch.approvalHash
    || typeof action.approvedBy !== "string" || !action.approvedBy
    || typeof action.approvedAt !== "string"
    || !Number.isFinite(Date.parse(action.approvedAt))
    || !Number.isSafeInteger(action.directMessageDailyLimit)
    || action.directMessageDailyLimit! < 1 || action.directMessageDailyLimit! > 100
    || !Number.isSafeInteger(action.directMessageDailyOrdinal)
    || action.directMessageDailyOrdinal! < 1
    || action.directMessageDailyOrdinal! > action.directMessageDailyLimit!
    || outreachContentHash(action.content) !== action.contentHash
    || !validOutreachTarget("direct_message", action.targetPublicUrl)
    || !predecessor || predecessor.id !== action.predecessorActionId
    || predecessor.kind !== "comment" || predecessor.sequence !== 1
    || predecessor.workspaceId !== action.workspaceId
    || predecessor.batchId !== action.batchId
    || predecessor.batchRevision !== action.batchRevision
    || predecessor.candidateId !== action.candidateId
    || predecessor.accountId !== action.accountId
    || predecessor.approvalHash !== batch.approvalHash
    || typeof predecessor.platformReceiptReference !== "string"
    || !predecessor.platformReceiptReference
    || predecessor.platformReceiptReference.length > 255) return false;
  return action.approvalHash === outreachDirectMessageApprovalHash({
    authorizationVersion: 2, batchId: batch.id, batchRevision: batch.revision,
    batchHash: batch.batchHash, commentApprovalHash: batch.approvalHash,
    candidateId: action.candidateId, accountId: action.accountId,
    accountLoginStateVersion: action.accountLoginStateVersion,
    targetPublicUrl: action.targetPublicUrl, directMessage: action.content,
    directMessageHash: action.contentHash,
    predecessorActionId: predecessor.id,
    predecessorReceiptReference: predecessor.platformReceiptReference,
    dailyLimit: action.directMessageDailyLimit!,
    dailyOrdinal: action.directMessageDailyOrdinal!,
    approvedBy: action.approvedBy, approvedAt: action.approvedAt
  });
}

export function validDirectMessageClaimAuthority(action: AcquisitionOutreachAction,
  batch: AcquisitionOutreachBatch, predecessor: AcquisitionOutreachAction | undefined) {
  if (action.authorizationVersion === 3) return validIndependentDirectMessageAuthority(action, batch);
  return predecessor?.status === "succeeded"
    && validFrozenDirectMessageSuccessorAuthority(action, batch, predecessor);
}

export function validIndependentDirectMessageAuthority(action: AcquisitionOutreachAction,
  batch: AcquisitionOutreachBatch) {
  if (action.kind !== "direct_message" || action.authorizationVersion !== 3
    || action.sequence !== 2 || action.predecessorActionId !== null
    || !["awaiting_approval", "approved"].includes(batch.state)
    || action.workspaceId !== batch.workspaceId || action.batchId !== batch.id
    || action.batchRevision !== batch.revision || action.accountId !== batch.accountId
    || !Number.isSafeInteger(action.accountLoginStateVersion)
    || action.accountLoginStateVersion < batch.accountLoginStateVersion
    || action.policyVersionId !== batch.policyVersionId
    || !action.approvedBy || !action.approvedAt || !Number.isFinite(Date.parse(action.approvedAt))
    || !Number.isSafeInteger(action.directMessageDailyLimit)
    || action.directMessageDailyLimit! < 1 || action.directMessageDailyLimit! > 100
    || !Number.isSafeInteger(action.directMessageDailyOrdinal)
    || action.directMessageDailyOrdinal! < 1
    || action.directMessageDailyOrdinal! > action.directMessageDailyLimit!
    || !action.content.trim() || action.content.length > 800
    || outreachContentHash(action.content) !== action.contentHash
    || !validOutreachTarget("direct_message", action.targetPublicUrl)
    || !batch.candidates.some(candidate => candidate.selected
      && candidate.candidateId === action.candidateId
      && candidate.publicProfileUrl === action.targetPublicUrl)) return false;
  try {
    if (!batch.timeZone || outreachLocalDay(action.approvedAt, batch.timeZone) !== action.localDate) return false;
  } catch { return false; }
  return action.approvalHash === outreachIndependentDirectMessageApprovalHash({
    authorizationVersion: 3, batchId: batch.id, batchRevision: batch.revision,
    batchHash: batch.batchHash, candidateId: action.candidateId,
    accountId: action.accountId, accountLoginStateVersion: action.accountLoginStateVersion,
    targetPublicUrl: action.targetPublicUrl, directMessage: action.content,
    directMessageHash: action.contentHash, dailyLimit: action.directMessageDailyLimit!,
    dailyOrdinal: action.directMessageDailyOrdinal!, approvedBy: action.approvedBy,
    approvedAt: action.approvedAt
  });
}

export function validDirectMessageApprovalAction(input: {
  action: AcquisitionOutreachAction;
  batch: AcquisitionOutreachBatch;
  predecessor?: AcquisitionOutreachAction;
  accountLoginStateVersion?: number;
  candidateId: string;
  directMessage: string;
  dailyLimit: number;
  dailyOrdinal: number;
  dailyLocalDate: string;
  approvedBy: string;
  approvedAt: string;
}) {
  const { action, batch, predecessor } = input;
  const candidate = batch.candidates.find((value) => value.selected
    && value.candidateId === input.candidateId);
  return typeof action.id === "string" && action.id.length > 0 && action.id.length <= 255
    && action.workspaceId === batch.workspaceId
    && action.batchId === batch.id && action.batchRevision === batch.revision
    && action.accountId === batch.accountId
    && action.accountLoginStateVersion === (input.accountLoginStateVersion ?? batch.accountLoginStateVersion)
    && action.policyVersionId === batch.policyVersionId
    && action.localDate === input.dailyLocalDate
    && action.kind === "direct_message" && action.sequence === 2
    && action.status === "queued"
    && action.predecessorActionId === (input.accountLoginStateVersion === undefined ? predecessor?.id : null)
    && action.candidateId === input.candidateId
    && Boolean(candidate) && action.targetPublicUrl === candidate!.publicProfileUrl
    && action.content === input.directMessage
    && action.contentHash === outreachContentHash(input.directMessage)
    && action.authorizationVersion === (input.accountLoginStateVersion === undefined ? 2 : 3)
    && action.approvedBy === input.approvedBy && action.approvedAt === input.approvedAt
    && action.directMessageDailyLimit === input.dailyLimit
    && action.directMessageDailyOrdinal === input.dailyOrdinal
    && action.createdAt === input.approvedAt
    && validDirectMessageClaimAuthority(action, batch, predecessor);
}

export class InMemoryAcquisitionOutreachBatchRepository
implements AcquisitionOutreachBatchRepository {
  private state: State = { batches: new Map(), actions: new Map(), replays: new Map(),
    dailyCandidates: new Set(), actionRuntime: new Map(), accounts: new Map(),
    directMessageClaims: [], recoveryReplays: new Map(), recoveryAudit: [],
    desktopClaimReplays: new Map(), desktopAttempts: [],
    desktopCompletionReplays: new Map(), desktopRecoveryReplays: new Map(),
    desktopHumanReconciliationReplays: new Map(),
    desktopHumanReconciliationAudit: [] };
  private tail: Promise<void> = Promise.resolve();
  private desktopClaimWriteCount = 0;
  readonly memoryTransactions: AcquisitionMemoryTransactionCoordinator | null;
  constructor(private readonly testing: { failActionInsertAt?: number;
    platformExecutionAccess?: PlatformExecutionAccess;
    failDirectMessageActionInsertAt?: number;
    memoryTransactions?: AcquisitionMemoryTransactionCoordinator;
    memoryDomainTransactions?: Pick<AcquisitionDomainRepository, "transaction">;
    socialAccounts?: InMemoryAcquisitionSocialAccountRepository;
    desktopInstallations?: InMemoryDesktopInstallationRepository;
    desktopTaskTokenKey?: Uint8Array;
    failDesktopClaimWriteAt?: number } = {}) {
    this.memoryTransactions = testing.memoryTransactions ?? null;
  }

  private desktopTaskToken(task: DesktopOutreachActionTask,
    fence: Omit<DesktopOutreachActionFence, "taskTokenHash" | "leaseToken">) {
    const key = this.testing.desktopTaskTokenKey;
    if (!key || key.byteLength < 32) {
      throw new Error("desktop_outreach_task_token_key_unavailable");
    }
    return issueDesktopOutreachTaskToken(key, task, fence);
  }

  private desktopReconciliationToken(task: DesktopOutreachReconciliationTask,
    input: Pick<DesktopOutreachRecoveryRepositoryInput, "workspaceId" |
      "deviceIdHash" | "processInstanceIdHash">) {
    const key = this.testing.desktopTaskTokenKey;
    if (!key || key.byteLength < 32) {
      throw new Error("desktop_outreach_task_token_key_unavailable");
    }
    return createHmac("sha256", key).update([
      "shensi-desktop-outreach-reconcile-only-v1", input.workspaceId,
      input.deviceIdHash, input.processInstanceIdHash, task.actionId,
      task.accountId, task.accountHandle, String(task.loginStateVersion),
      String(task.executorBindingGeneration),
      String(task.originalLeaseVersion), String(task.reconciliationGeneration),
      task.taskRequestHash, task.deadlineAt
    ].join("\0"), "utf8").digest("base64url");
  }

  hasDesktopAuthorityBundle(socialAccounts: InMemoryAcquisitionSocialAccountRepository,
    desktopInstallations: InMemoryDesktopInstallationRepository): boolean {
    return this.testing.socialAccounts === socialAccounts
      && this.testing.desktopInstallations === desktopInstallations
      && socialAccounts.memoryTransactions === this.memoryTransactions
      && desktopInstallations.memoryTransactions === this.memoryTransactions;
  }

  private desktopClaimInput(input: DesktopOutreachClaimInput) {
    return assertValidDesktopOutreachClaimInput(input);
  }

  private transaction<T>(work: (draft: State,
    token: AcquisitionMemoryTransactionToken | null) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const draft = clone(this.state);
      const execute = (token: AcquisitionMemoryTransactionToken | null = null) =>
        work(draft, token);
      const coordinated = () => this.testing.memoryTransactions
        ? this.testing.memoryTransactions.transaction((token) => execute(token))
        : execute();
      const value = await (this.testing.memoryDomainTransactions
        ? this.testing.memoryDomainTransactions.transaction(async () => coordinated())
        : coordinated());
      this.state = draft;
      return clone(value);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async snapshot() { await this.tail; return clone(this.state); }

  hasUnresolvedAccountActions(token: AcquisitionMemoryTransactionToken,
    workspaceId: string, accountId: string) {
    if (!this.testing.memoryTransactions) {
      throw new Error("acquisition_memory_transaction_boundary_required");
    }
    this.testing.memoryTransactions.assertOwns(token);
    const unresolved = new Set(["claimed", "executing", "reconciliation_required"]);
    return [...this.state.actions.values()].flat().some((action) =>
      action.workspaceId === workspaceId && action.accountId === accountId
      && unresolved.has(action.status));
  }
  private replay(state: State, workspaceId: string, operation: string,
    idempotencyKey: string, requestHash: string): OutreachRepositoryResult<AcquisitionOutreachBatch> | null {
    const existing = state.replays.get(replayKey(workspaceId, operation, idempotencyKey));
    if (!existing) return null;
    return existing.requestHash === requestHash
      ? { kind: "replay", value: existing.value } : { kind: "conflict" };
  }
  private recordReplay(state: State, input: { workspaceId: string; operation: string;
    idempotencyKey: string; requestHash: string }, value: AcquisitionOutreachBatch) {
    state.replays.set(replayKey(input.workspaceId, input.operation, input.idempotencyKey), {
      requestHash: input.requestHash, value: clone(value)
    });
  }
  private current(state: State, workspaceId: string, batchId: string) {
    return state.batches.get(batchKey(workspaceId, batchId))?.at(-1) ?? null;
  }
  private remainingIn(state: State, workspaceId: string, accountId: string,
    localDate: string, limit: number) {
    const prefix = dailyPrefix(workspaceId, accountId, localDate);
    return Math.max(0, limit - [...state.dailyCandidates].filter((key) => key.startsWith(prefix)).length);
  }

  async find(workspaceId: string, batchId: string) {
    return this.current(await this.snapshot(), workspaceId, batchId);
  }
  async listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: OutreachBatchListAnchor | null }) {
    const batches = [...(await this.snapshot()).batches.values()].map((revisions) => revisions.at(-1)!)
      .filter((batch) => batch.workspaceId === input.workspaceId && batch.runId === input.runId
        && batch.candidates.some((candidate) => candidate.candidateId === input.candidateId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id));
    const after = input.after;
    const eligible = after ? batches.filter((batch) => batch.createdAt < after.createdAt
      || (batch.createdAt === after.createdAt && batch.id < after.batchId)) : batches;
    const window = eligible.slice(0, input.limit + 1);
    const items = window.slice(0, input.limit);
    const last = items.at(-1);
    return { items, next: window.length > input.limit && last
      ? { createdAt: last.createdAt, batchId: last.id } : null };
  }
  create(input: { workspaceId: string; operation: string; idempotencyKey: string;
    requestHash: string; batch: AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>((state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const key = batchKey(input.workspaceId, input.batch.id);
      if (state.batches.has(key)) return { kind: "conflict" };
      state.batches.set(key, [clone(input.batch)]); state.actions.set(key, []);
      this.recordReplay(state, input, input.batch);
      return { kind: "created", value: input.batch };
    });
  }
  replace(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const next = await input.build(clone(current));
      state.batches.get(batchKey(input.workspaceId, input.batchId))!.push(clone(next));
      this.recordReplay(state, input, next);
      return { kind: "created", value: next };
    });
  }
  approve(input: { workspaceId: string; batchId: string; ifMatch: string;
    idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch, remaining: number): Promise<{ batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[] }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const replay = this.replay(state, input.workspaceId, "approve", input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const remaining = this.remainingIn(state, current.workspaceId, current.accountId, current.localDate, current.dailyCandidateLimit);
      const built = await input.build(clone(current), remaining);
      let inserted = 0;
      for (const action of built.actions) {
        inserted += 1;
        if (this.testing.failActionInsertAt === inserted) throw new Error("test_action_insert_failure");
      }
      const selected = built.batch.candidates.filter((candidate) => candidate.selected);
      for (const candidate of selected) {
        const key = `${dailyPrefix(current.workspaceId, current.accountId, current.localDate)}${candidate.candidateId}`;
        if (state.dailyCandidates.has(key)) throw new Error("outreach_candidate_already_approved_today");
        state.dailyCandidates.add(key);
      }
      const key = batchKey(input.workspaceId, input.batchId);
      state.batches.get(key)!.splice(-1, 1, clone(built.batch));
      state.actions.set(key, clone(built.actions));
      for (const action of built.actions) state.actionRuntime.set(action.id, {
        workerId: null, leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
        claimedAt: null, nextEligibleAt: null, attemptCount: 0
      });
      this.recordReplay(state, { ...input, operation: "approve" }, built.batch);
      return { kind: "created", value: built.batch };
    });
  }
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    accountLoginStateVersion?: number;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const operation = "approve_direct_messages";
      const replay = this.replay(state, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      const independent = input.accountLoginStateVersion !== undefined;
      if (current.etag !== input.ifMatch || !(current.state === "approved"
        || (independent && current.state === "awaiting_approval"))) {
        return { kind: "stale" };
      }
      const allActions = [...state.actions.values()].flat();
      const batchActions = state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? [];
      const predecessors = independent ? [] : input.candidates.map(({ candidateId }) => batchActions.find((action) =>
        action.workspaceId === current.workspaceId && action.batchId === current.id
        && action.batchRevision === current.revision && action.accountId === current.accountId
        && action.candidateId === candidateId && action.kind === "comment"
        && action.status === "succeeded" && action.approvalHash === current.approvalHash
        && typeof action.platformReceiptReference === "string"
        && action.platformReceiptReference.length > 0));
      if (predecessors.some((action) => !action)) {
        throw new Error("outreach_comment_receipt_required");
      }
      const dailyLocalDate = outreachLocalDay(input.approvedAt, current.timeZone);
      if (input.candidates.some(({ candidateId }) => allActions.some((action) =>
        action.workspaceId === current.workspaceId && action.candidateId === candidateId
        && action.kind === "direct_message"
        && ((action.batchId === current.id && action.batchRevision === current.revision)
          || (action.accountId === current.accountId
            && action.localDate === dailyLocalDate))))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const used = allActions.filter((action) => action.workspaceId === current.workspaceId
        && action.accountId === current.accountId && action.localDate === dailyLocalDate
        && action.kind === "direct_message").length;
      const ordinals = input.candidates.map((_, index) => used + index + 1);
      if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1
        || input.dailyLimit > 100 || ordinals.at(-1)! > input.dailyLimit) {
        throw new Error("outreach_direct_message_daily_limit_exhausted");
      }
      const authorityBatch = clone(current);
      const authorityPredecessors = clone(predecessors as AcquisitionOutreachAction[]);
      const built = await input.build(frozenOutreachAuthorityClone(authorityBatch),
        frozenOutreachAuthorityClone(authorityPredecessors),
        Object.freeze([...ordinals]), dailyLocalDate);
      if (built.batch.id !== authorityBatch.id
        || built.batch.revision !== authorityBatch.revision
        || built.batch.etag !== authorityBatch.etag
        || built.actions.length !== input.candidates.length
        || new Set(built.actions.map((action) => action.id)).size !== built.actions.length
        || built.actions.some((action, index) => !validDirectMessageApprovalAction({
          action, batch: authorityBatch, predecessor: authorityPredecessors[index]!,
          accountLoginStateVersion: input.accountLoginStateVersion,
          candidateId: input.candidates[index]!.candidateId,
          directMessage: input.candidates[index]!.directMessage,
          dailyLimit: input.dailyLimit, dailyOrdinal: ordinals[index]!,
          dailyLocalDate,
          approvedBy: input.approvedBy, approvedAt: input.approvedAt
        }))) {
        throw new Error("outreach_direct_message_authority_invalid");
      }
      let inserted = 0;
      for (const action of built.actions) {
        inserted += 1;
        if (this.testing.failDirectMessageActionInsertAt === inserted) {
          throw new Error("test_action_insert_failure");
        }
        batchActions.push(clone(action));
        state.actionRuntime.set(action.id, {
          workerId: null, leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0
        });
      }
      state.actions.set(batchKey(input.workspaceId, input.batchId), batchActions);
      this.recordReplay(state, { ...input, operation }, current);
      return { kind: "created", value: current };
    });
  }
  transition(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>((state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch) return { kind: "stale" };
      const next = input.build(clone(current));
      state.batches.get(batchKey(input.workspaceId, input.batchId))!.splice(-1, 1, clone(next));
      this.recordReplay(state, input, next);
      return { kind: "created", value: next };
    });
  }
  async listActions(workspaceId: string, batchId: string) {
    const state = await this.snapshot(); const key = batchKey(workspaceId, batchId);
    if (!state.batches.has(key)) return null;
    return (state.actions.get(key) ?? []).map((action) => ({ ...action,
      attemptCount: state.actionRuntime.get(action.id)?.attemptCount ?? 0,
      platformReceiptReference: action.platformReceiptReference ?? null,
      occurredAt: action.occurredAt ?? null,
      failureCode: action.failureCode ?? null
    }));
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    return this.remainingIn(await this.snapshot(), workspaceId, accountId, localDate, dailyLimit);
  }

  async listNonTerminalServerActions(input: { workspaceId: string; limit: number }) {
    if (!input.workspaceId || !Number.isSafeInteger(input.limit)
      || input.limit < 1 || input.limit > 100) {
      throw new TypeError("invalid_non_terminal_server_action_query");
    }
    const statuses = new Set(["queued", "blocked_by_predecessor", "claimed",
      "executing", "reconciliation_required"]);
    const actions = [...(await this.snapshot()).actions.values()].flat()
      .filter((action) => action.workspaceId === input.workspaceId
        && (action.executionTarget ?? "server") === "server"
        && statuses.has(action.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id));
    return { count: actions.length, items: actions.slice(0, input.limit).map((action) => ({
      actionId: action.id, batchId: action.batchId, accountId: action.accountId,
      status: action.status as NonTerminalServerOutreachActionSummary["status"],
      createdAt: action.createdAt
    })) };
  }

  claimNextAction(input: OutreachActionClaimInput) {
    return this.transaction<OutreachActionClaim | null>(async (state) => {
      const at = Date.parse(input.now);
      if (!Number.isFinite(at) || !Number.isSafeInteger(input.leaseDurationMs)
        || input.leaseDurationMs < 1) throw new TypeError("invalid_outreach_action_claim");
      const actions = [...state.actions.values()].flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      for (const action of actions) {
        if ((action.executionTarget ?? "server") !== (input.executionTarget ?? "server")) {
          continue;
        }
        if (action.status !== "queued" && action.status !== "blocked_by_predecessor") continue;
        if (this.testing.platformExecutionAccess
          && !await this.testing.platformExecutionAccess(action.workspaceId, input.now)) continue;
        const batch = this.current(state, action.workspaceId, action.batchId);
        if (!batch) continue;
        if (action.kind === "comment") {
          if (batch.state !== "approved" || batch.revision !== action.batchRevision
            || batch.approvalHash !== action.approvalHash) continue;
          const approvedToday = [...state.dailyCandidates].filter((key) => key.startsWith(
            dailyPrefix(action.workspaceId, action.accountId, action.localDate))).length;
          if (approvedToday > batch.dailyCandidateLimit) continue;
        } else {
          const predecessor = actions.find((candidate) => candidate.id === action.predecessorActionId);
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)) continue;
          let claimLocalDate: string;
          try { claimLocalDate = outreachLocalDay(input.now, batch.timeZone); }
          catch { continue; }
          const used = state.directMessageClaims.filter((claim) =>
            claim.workspaceId === action.workspaceId && claim.accountId === action.accountId
            && claim.localDate === claimLocalDate).length;
          if (used >= action.directMessageDailyLimit!) continue;
        }
        const accountKey = `${action.workspaceId}\u0000${action.accountId}`;
        const account = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        if (account.paused || (account.nextEligibleAt
          && Date.parse(account.nextEligibleAt) > at)) continue;
        const accountBusy = actions.some(other => outreachActionBlocksAccountLane(action, other,
          completedUncertainDesktopComment(state, other, input.now)));
        if (accountBusy) continue;
        const runtime = state.actionRuntime.get(action.id) ?? { workerId: null,
          leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0 };
        const leaseToken = randomBytes(32).toString("hex");
        runtime.workerId = input.workerId; runtime.leaseToken = leaseToken;
        runtime.fencingToken += 1; runtime.claimedAt = input.now;
        runtime.leaseExpiresAt = new Date(at + input.leaseDurationMs).toISOString();
        runtime.attemptCount += 1;
        state.actionRuntime.set(action.id, runtime);
        if (action.kind === "direct_message") state.directMessageClaims.push({
          workspaceId: action.workspaceId, accountId: action.accountId,
          localDate: outreachLocalDay(input.now, batch.timeZone), actionId: action.id,
          fencingToken: runtime.fencingToken
        });
        action.status = "executing";
        account.nextEligibleAt = new Date(at
          + (action.kind === "direct_message" ? 0 : 60_000)).toISOString();
        state.accounts.set(accountKey, account);
        return { action: clone(action), claimedAt: input.now,
          leaseExpiresAt: runtime.leaseExpiresAt,
          fence: { actionId: action.id, workerId: input.workerId, leaseToken,
            fencingToken: runtime.fencingToken } };
      }
      return null;
    });
  }

  claimNextDesktopAction(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer) {
    if (typeof authorize !== "function") {
      throw new TypeError("desktop_outreach_claim_authorizer_required");
    }
    return this.desktopClaim(input, authorize);
  }

  private desktopClaim(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer) {
    this.desktopClaimInput(input);
    return this.transaction<DesktopOutreachClaimResult>(async (state, token) => {
      if (this.testing.platformExecutionAccess
        && !await this.testing.platformExecutionAccess(input.workspaceId, input.now)) {
        return { kind: 'empty', serverTime: input.now, retryAfterMs: 3_000, replayed: false };
      }
      const social = this.testing.socialAccounts;
      const installations = this.testing.desktopInstallations;
      if (!token || !social || !installations || !this.testing.memoryTransactions
        || social.memoryTransactions !== this.testing.memoryTransactions
        || installations.memoryTransactions !== this.testing.memoryTransactions) {
        throw new Error("acquisition_memory_transaction_boundary_required");
      }
      const replayKeyValue = `${input.workspaceId}\0claim_desktop_outreach_action\0${input.idempotencyKeyHash}`;
      const installation = installations.getActiveInstallationRecord(token,
        input.workspaceId, input.deviceIdHash);
      const empty = (): DesktopOutreachClaimResult => {
        const response = { kind: "empty" as const, serverTime: input.now,
          retryAfterMs: 3_000 };
        state.desktopClaimReplays.set(replayKeyValue, {
          claimRequestHash: input.claimRequestHash, response: clone(response)
        });
        return { ...response, replayed: false };
      };
      const at = Date.parse(input.now);
      const validBindings = new Map<string, {
        available: DesktopOutreachAvailableAccount;
        account: DesktopOutreachClaimAuthorityAccount;
      }>();
      if (installation) for (const available of input.availableAccounts) {
        const account = social.getDesktopExecutorBindingRecord(token,
          input.workspaceId, available.accountId);
        if (account?.state === "active"
          && account.accountHandle === available.accountHandle
          && account.loginStateVersion === available.loginStateVersion
          && account.executorMode === "desktop"
          && account.executorDeviceIdHash === input.deviceIdHash
          && account.executorBindingGeneration === available.bindingGeneration
          && account.executorLeaseExpiresAt
          && at < Date.parse(account.executorLeaseExpiresAt)) {
          validBindings.set(available.accountId, { available, account: {
            id: account.id, workspaceId: account.workspaceId, state: account.state,
            accountHandle: account.accountHandle, displayName: account.displayName,
            loginStateVersion: account.loginStateVersion,
            executorMode: account.executorMode,
            executorDeviceIdHash: account.executorDeviceIdHash,
            executorBindingGeneration: account.executorBindingGeneration,
            executorLeaseExpiresAt: account.executorLeaseExpiresAt
          } });
        }
      }
      if (!installation || validBindings.size !== input.availableAccounts.length) {
        throw new Error("desktop_outreach_claim_not_authorized");
      }
      const actions = [...state.actions.values()].flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      const authorizeLocked = async (action: AcquisitionOutreachAction,
        batch: AcquisitionOutreachBatch,
        predecessor: AcquisitionOutreachAction | undefined,
        binding: { available: DesktopOutreachAvailableAccount;
          account: DesktopOutreachClaimAuthorityAccount }) => {
        const snapshot = frozenOutreachAuthorityClone<DesktopOutreachClaimAuthoritySnapshot>({
          action, batch,
          siblings: actions.filter((candidate) => candidate.workspaceId === action.workspaceId
            && candidate.batchId === action.batchId)
            .sort((left, right) => left.id.localeCompare(right.id)),
          predecessor: predecessor ?? null,
          account: binding.account
        });
        const authority = await authorize(snapshot);
        if (this.testing.platformExecutionAccess
          && !await this.testing.platformExecutionAccess(input.workspaceId, input.now)) {
          throw new Error('desktop_outreach_claim_not_authorized');
        }
        if (!authority || "failureCode" in authority
          || authority.accountHandle !== binding.available.accountHandle
          || authority.accountHandle !== binding.account.accountHandle) {
          throw new Error("desktop_outreach_claim_not_authorized");
        }
      };
      const replay = state.desktopClaimReplays.get(replayKeyValue);
      if (replay) {
        if (replay.claimRequestHash !== input.claimRequestHash) {
          throw new Error("desktop_outreach_claim_idempotency_conflict");
        }
        const replayResponse = replay.response;
        if (replayResponse.kind === "empty") {
          return { ...clone(replayResponse), replayed: true };
        }
        const binding = validBindings.get(replayResponse.task.accountId);
        if (!binding
          || binding.available.accountHandle !== replayResponse.task.accountHandle
          || binding.available.loginStateVersion !== replayResponse.task.loginStateVersion
          || binding.available.bindingGeneration
            !== replayResponse.task.executorBindingGeneration) {
          throw new Error("desktop_outreach_claim_not_authorized");
        }
        const currentAction = actions.find((action) =>
          action.workspaceId === input.workspaceId
          && action.id === replayResponse.task.actionId);
        const runtime = state.actionRuntime.get(replayResponse.task.actionId);
        const attempt = state.desktopAttempts.find((candidate) =>
          candidate.actionId === replayResponse.task.actionId
          && candidate.fencingToken === replayResponse.fence.fencingToken);
        let replayCanonicalTarget: string | undefined;
        let expectedTaskRequestHash: string | undefined;
        if (currentAction) {
          try {
            replayCanonicalTarget = canonicalizeDouyinOutreachTargetUrl(
              currentAction.kind, currentAction.targetPublicUrl);
            expectedTaskRequestHash = desktopOutreachRequestHash({
              account_handle: binding.available.accountHandle, action_id: currentAction.id,
              approved_content_hash: currentAction.contentHash,
              canonical_target_public_url: replayCanonicalTarget,
              content: currentAction.content, kind: currentAction.kind,
              login_state_version: currentAction.accountLoginStateVersion
            }).hash;
          } catch { replayCanonicalTarget = undefined; }
        }
        if (!currentAction || currentAction.status !== "claimed"
          || currentAction.executionTarget !== "desktop"
          || currentAction.accountId !== replayResponse.task.accountId
          || currentAction.accountLoginStateVersion
            !== replayResponse.task.loginStateVersion
          || currentAction.kind !== replayResponse.task.kind
          || currentAction.content !== replayResponse.task.content
          || currentAction.contentHash !== replayResponse.task.approvedContentHash
          || replayCanonicalTarget !== currentAction.targetPublicUrl
          || replayCanonicalTarget !== replayResponse.task.canonicalTargetPublicUrl
          || expectedTaskRequestHash !== replayResponse.task.taskRequestHash
          || replayResponse.task.workspaceId !== input.workspaceId
          || replayResponse.fence.workspaceId !== input.workspaceId
          || !runtime || runtime.workerId !== input.processInstanceIdHash
          || runtime.leaseToken !== replayResponse.fence.leaseToken
          || runtime.fencingToken !== replayResponse.fence.fencingToken
          || runtime.leaseExpiresAt !== replayResponse.task.leaseExpiresAt
          || !attempt || attempt.deviceIdHash !== input.deviceIdHash
          || attempt.processInstanceIdHash !== input.processInstanceIdHash
          || attempt.executorBindingGeneration !== binding.available.bindingGeneration
          || attempt.taskRequestHash !== replayResponse.task.taskRequestHash
          || attempt.taskTokenHash !== replayResponse.fence.taskTokenHash
          || attempt.platformWriteAttemptCount !== 0) {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        const replayBatch = this.current(state, currentAction.workspaceId,
          currentAction.batchId);
        if (!replayBatch) throw new Error("desktop_outreach_claim_replay_invalid");
        const replayPredecessor = actions.find((candidate) =>
          candidate.id === currentAction.predecessorActionId);
        await authorizeLocked(currentAction, replayBatch, replayPredecessor, binding);
        const taskToken = this.desktopTaskToken(replayResponse.task,
          replayResponse.fence);
        if (`sha256:${createHash("sha256").update(taskToken).digest("hex")}`
          !== replayResponse.fence.taskTokenHash) {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        return { ...clone(replayResponse), taskToken, replayed: true };
      }
      for (const action of actions) {
        if (action.workspaceId !== input.workspaceId
          || action.executionTarget !== "desktop"
          || (action.status !== "queued" && action.status !== "blocked_by_predecessor")) {
          continue;
        }
        const binding = validBindings.get(action.accountId);
        if (!binding) continue;
        const available = binding.available;
        if (action.accountLoginStateVersion !== available.loginStateVersion) continue;
        const batch = this.current(state, action.workspaceId, action.batchId);
        const independent = action.kind === "direct_message" && action.authorizationVersion === 3;
        if (!batch || !(batch.state === "approved" || (independent && batch.state === "awaiting_approval"))
          || batch.revision !== action.batchRevision
          || batch.accountId !== action.accountId
          || (!independent && batch.accountLoginStateVersion !== action.accountLoginStateVersion)) continue;
        const frozen = batch.candidates.find((candidate) =>
          candidate.candidateId === action.candidateId);
        if (!frozen || outreachContentHash(action.content) !== action.contentHash) continue;
        let canonicalTarget: string;
        try {
          canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
            action.targetPublicUrl);
        } catch { continue; }
        if (canonicalTarget !== action.targetPublicUrl) continue;
        let predecessor: AcquisitionOutreachAction | undefined;
        if (action.kind === "comment") {
          if (batch.approvalHash !== action.approvalHash
            || frozen.commentHash !== action.contentHash
            || frozen.commentTargetPublicUrl !== action.targetPublicUrl) continue;
        } else {
          predecessor = actions.find((candidate) =>
            candidate.id === action.predecessorActionId);
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)
            || (!independent && frozen.directMessageHash !== action.contentHash)
            || frozen.publicProfileUrl !== action.targetPublicUrl) continue;
        }
        const accountKey = `${action.workspaceId}\0${action.accountId}`;
        const executionAccount = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        if (executionAccount.paused || (executionAccount.nextEligibleAt
          && Date.parse(executionAccount.nextEligibleAt) > at)) continue;
        if (actions.some(other => outreachActionBlocksAccountLane(action, other,
          completedUncertainDesktopComment(state, other, input.now)))) {
          continue;
        }
        if (action.kind === "direct_message") {
          let claimLocalDate: string;
          try { claimLocalDate = outreachLocalDay(input.now, batch.timeZone); }
          catch { continue; }
          const used = state.directMessageClaims.filter((claim) =>
            claim.workspaceId === action.workspaceId
            && claim.accountId === action.accountId
            && claim.localDate === claimLocalDate).length;
          if (used >= action.directMessageDailyLimit!) continue;
        } else {
          const approvedToday = [...state.dailyCandidates].filter((key) =>
            key.startsWith(dailyPrefix(action.workspaceId, action.accountId,
              action.localDate))).length;
          if (approvedToday > batch.dailyCandidateLimit) continue;
        }
        await authorizeLocked(action, batch, predecessor, binding);
        const runtime = state.actionRuntime.get(action.id) ?? { workerId: null,
          leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0 };
        const fencingToken = runtime.fencingToken + 1;
        const leaseExpiresAt = new Date(at + input.leaseDurationMs).toISOString();
        const taskRequestHash = desktopOutreachRequestHash({
          account_handle: available.accountHandle, action_id: action.id,
          approved_content_hash: action.contentHash,
          canonical_target_public_url: canonicalTarget, content: action.content,
          kind: action.kind, login_state_version: action.accountLoginStateVersion
        }).hash;
        const task: DesktopOutreachActionTask = Object.freeze({ actionId: action.id,
          workspaceId: action.workspaceId, accountId: action.accountId,
          accountHandle: available.accountHandle,
          loginStateVersion: action.accountLoginStateVersion,
          executorBindingGeneration: available.bindingGeneration, kind: action.kind,
          canonicalTargetPublicUrl: canonicalTarget, content: action.content,
          approvedContentHash: action.contentHash, taskRequestHash,
          deadlineAt: input.actionDeadlineAt, leaseVersion: fencingToken,
          leaseExpiresAt, predecessorReceipt:
            predecessor?.platformReceiptReference ?? null });
        const unsignedFence = { actionId: action.id,
          workerId: input.processInstanceIdHash, fencingToken,
          workspaceId: action.workspaceId, deviceIdHash: input.deviceIdHash,
          processInstanceIdHash: input.processInstanceIdHash,
          executorBindingGeneration: available.bindingGeneration,
          taskRequestHash, platformWriteAttemptCount: 0 as const };
        const taskToken = this.desktopTaskToken(task, unsignedFence as
          Omit<DesktopOutreachActionFence, "taskTokenHash" | "leaseToken">);
        const taskTokenHash = `sha256:${createHash("sha256")
          .update(taskToken).digest("hex")}`;
        const fence: DesktopOutreachActionFence = Object.freeze({ ...unsignedFence,
          leaseToken: taskTokenHash.slice("sha256:".length), taskTokenHash });
        this.desktopClaimWriteCount += 1;
        if (this.testing.failDesktopClaimWriteAt === this.desktopClaimWriteCount) {
          throw new Error("desktop_outreach_claim_write_failed");
        }
        action.status = "claimed";
        runtime.workerId = input.processInstanceIdHash;
        runtime.leaseToken = fence.leaseToken;
        runtime.fencingToken = fencingToken; runtime.claimedAt = input.now;
        runtime.leaseExpiresAt = leaseExpiresAt; runtime.attemptCount += 1;
        state.actionRuntime.set(action.id, runtime);
        executionAccount.nextEligibleAt = new Date(at
          + (action.kind === "direct_message" ? 0 : 60_000)).toISOString();
        state.accounts.set(accountKey, executionAccount);
        if (action.kind === "direct_message") state.directMessageClaims.push({
          workspaceId: action.workspaceId, accountId: action.accountId,
          localDate: outreachLocalDay(input.now, batch.timeZone), actionId: action.id,
          fencingToken
        });
        state.desktopAttempts.push({ actionId: action.id, fencingToken,
          taskTokenHash, taskRequestHash, deviceIdHash: input.deviceIdHash,
          processInstanceIdHash: input.processInstanceIdHash,
          executorBindingGeneration: available.bindingGeneration,
          deadlineAt: input.actionDeadlineAt,
          platformWriteAttemptCount: 0, startedAt: null, startedRequestHash: null,
          startedResponse: null, receiptHash: null, receiptRequestHash: null,
          receiptOperation: null,
          receiptJson: null, receiptResponse: null, outcome: null, recoveryGeneration: 0,
          recoveryProcessInstanceIdHash: null, recoveryTaskTokenHash: null,
          recoveryLeaseExpiresAt: null });
        const response = { kind: "claimed" as const, task, fence,
          serverTime: input.now };
        state.desktopClaimReplays.set(replayKeyValue, {
          claimRequestHash: input.claimRequestHash, response: clone(response)
        });
        return { ...response, taskToken, replayed: false };
      }
      return empty();
    });
  }

  private desktopCompletionAuthority(state: State,
    token: AcquisitionMemoryTransactionToken | null,
    input: DesktopOutreachCompletionFenceInput) {
    const social = this.testing.socialAccounts;
    const installations = this.testing.desktopInstallations;
    if (!token || !social || !installations || !this.testing.memoryTransactions
      || social.memoryTransactions !== this.testing.memoryTransactions
      || installations.memoryTransactions !== this.testing.memoryTransactions) {
      throw new Error("acquisition_memory_transaction_boundary_required");
    }
    const installation = installations.getActiveInstallationRecord(token,
      input.workspaceId, input.deviceIdHash);
    if (!installation) throw new Error("desktop_outreach_completion_not_authorized");
    const action = [...state.actions.values()].flat().find((candidate) =>
      candidate.workspaceId === input.workspaceId && candidate.id === input.actionId);
    if (!action || action.executionTarget !== "desktop") {
      throw new Error("desktop_outreach_completion_stale");
    }
    const account = social.getDesktopExecutorBindingRecord(token,
      input.workspaceId, action.accountId);
    if (!account || account.state !== "active" || account.executorMode !== "desktop"
      || account.executorDeviceIdHash !== input.deviceIdHash
      || account.executorBindingGeneration !== input.executorBindingGeneration
      || account.loginStateVersion !== input.loginStateVersion
      || !account.executorLeaseExpiresAt) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    const recoveryAttempt = state.desktopAttempts.find((candidate) =>
      candidate.actionId === input.actionId
      && candidate.recoveryProcessInstanceIdHash === input.processInstanceIdHash
      && candidate.recoveryTaskTokenHash === input.taskTokenHash);
    if (recoveryAttempt) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    const attempt = state.desktopAttempts.find((candidate) =>
      candidate.actionId === input.actionId && candidate.fencingToken === input.leaseVersion);
    const runtime = state.actionRuntime.get(input.actionId);
    let canonicalTarget: string;
    let expectedTaskRequestHash: string;
    try {
      canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
        action.targetPublicUrl);
      expectedTaskRequestHash = desktopOutreachRequestHash({
        account_handle: account.accountHandle ?? "", action_id: action.id,
        approved_content_hash: action.contentHash,
        canonical_target_public_url: canonicalTarget, content: action.content,
        kind: action.kind, login_state_version: action.accountLoginStateVersion
      }).hash;
    } catch {
      throw new Error("desktop_outreach_completion_stale");
    }
    if (!attempt || attempt.deviceIdHash !== input.deviceIdHash
      || attempt.processInstanceIdHash !== input.processInstanceIdHash
      || attempt.taskTokenHash !== input.taskTokenHash
      || attempt.executorBindingGeneration !== input.executorBindingGeneration
      || attempt.taskRequestHash !== input.taskRequestHash
      || action.accountLoginStateVersion !== input.loginStateVersion
      || canonicalTarget !== action.targetPublicUrl
      || expectedTaskRequestHash !== input.taskRequestHash) {
      throw new Error("desktop_outreach_completion_stale");
    }
    return { action, account, attempt, runtime };
  }

  private desktopReconciliationCompletionAuthority(state: State,
    token: AcquisitionMemoryTransactionToken | null,
    input: DesktopOutreachReconciliationReceiptRepositoryInput) {
    const social = this.testing.socialAccounts;
    const installations = this.testing.desktopInstallations;
    if (!token || !social || !installations || !this.testing.memoryTransactions
      || social.memoryTransactions !== this.testing.memoryTransactions
      || installations.memoryTransactions !== this.testing.memoryTransactions) {
      throw new Error("acquisition_memory_transaction_boundary_required");
    }
    const installation = installations.getActiveInstallationRecord(token,
      input.workspaceId, input.deviceIdHash);
    if (!installation) throw new Error("desktop_outreach_completion_not_authorized");
    const action = [...state.actions.values()].flat().find((candidate) =>
      candidate.workspaceId === input.workspaceId && candidate.id === input.actionId);
    if (!action || action.executionTarget !== "desktop") {
      throw new Error("desktop_outreach_completion_stale");
    }
    const account = social.getDesktopExecutorBindingRecord(token,
      input.workspaceId, action.accountId);
    if (!account || account.state !== "active" || account.executorMode !== "desktop"
      || account.executorDeviceIdHash !== input.deviceIdHash
      || account.executorBindingGeneration !== input.executorBindingGeneration
      || account.loginStateVersion !== input.loginStateVersion
      || !account.executorLeaseExpiresAt) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    const attempt = state.desktopAttempts.find((candidate) =>
      candidate.actionId === input.actionId
      && candidate.recoveryGeneration === input.leaseVersion
      && candidate.recoveryProcessInstanceIdHash === input.processInstanceIdHash
      && candidate.recoveryTaskTokenHash === input.taskTokenHash);
    let canonicalTarget: string;
    let expectedTaskRequestHash: string;
    let expectedRecoveryTaskTokenHash: string | null = null;
    try {
      canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
        action.targetPublicUrl);
      expectedTaskRequestHash = desktopOutreachRequestHash({
        account_handle: account.accountHandle ?? "", action_id: action.id,
        approved_content_hash: action.contentHash,
        canonical_target_public_url: canonicalTarget, content: action.content,
        kind: action.kind, login_state_version: action.accountLoginStateVersion
      }).hash;
      if (attempt?.recoveryLeaseExpiresAt) {
        const token = this.desktopReconciliationToken({
          actionId: action.id, workspaceId: action.workspaceId,
          accountId: action.accountId, accountHandle: account.accountHandle ?? "",
          loginStateVersion: action.accountLoginStateVersion,
          executorBindingGeneration: input.executorBindingGeneration,
          kind: action.kind, canonicalTargetPublicUrl: canonicalTarget,
          content: action.content, approvedContentHash: action.contentHash,
          deadlineAt: attempt.recoveryLeaseExpiresAt,
          taskRequestHash: input.taskRequestHash,
          leaseVersion: attempt.recoveryGeneration,
          originalLeaseVersion: attempt.fencingToken,
          reconciliationGeneration: attempt.recoveryGeneration,
          capability: "reconcile_only"
        }, input);
        expectedRecoveryTaskTokenHash = `sha256:${createHash("sha256")
          .update(token).digest("hex")}`;
      }
    } catch {
      throw new Error("desktop_outreach_completion_stale");
    }
    if (!attempt || attempt.platformWriteAttemptCount !== 1
      || !attempt.startedResponse || attempt.recoveryGeneration < 1
      || attempt.deviceIdHash !== input.deviceIdHash
      || attempt.executorBindingGeneration !== input.executorBindingGeneration
      || attempt.taskRequestHash !== input.taskRequestHash
      || expectedRecoveryTaskTokenHash !== input.taskTokenHash
      || action.accountLoginStateVersion !== input.loginStateVersion
      || canonicalTarget !== action.targetPublicUrl
      || expectedTaskRequestHash !== input.taskRequestHash) {
      throw new Error("desktop_outreach_completion_stale");
    }
    return { action, account, attempt, runtime: state.actionRuntime.get(input.actionId) };
  }

  markDesktopActionStarted(input: DesktopOutreachStartedRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>(async (state, token) => {
      if (this.testing.platformExecutionAccess
        && !await this.testing.platformExecutionAccess(input.workspaceId, input.now)) {
        throw new Error('desktop_outreach_completion_not_authorized');
      }
      const { action, account, attempt, runtime } = this.desktopCompletionAuthority(state, token, input);
      const key = `${input.workspaceId}\0desktop_outreach_started\0${input.idempotencyKeyHash}`;
      const replay = state.desktopCompletionReplays.get(key);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        return { ...clone(replay.response), replayed: true };
      }
      if (attempt.startedResponse) {
        if (attempt.startedRequestHash !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = { ...clone(attempt.startedResponse), replayed: true };
        state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
          response: clone(attempt.startedResponse) });
        return response;
      }
      if (Date.parse(input.now) >= Date.parse(runtime?.leaseExpiresAt ?? "")) {
        throw new Error("desktop_outreach_start_expired");
      }
      if (Date.parse(input.now) >= Date.parse(account.executorLeaseExpiresAt ?? "")) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if (action.status !== "claimed" || !runtime
        || runtime.workerId !== input.processInstanceIdHash
        || runtime.leaseToken !== input.taskTokenHash.slice("sha256:".length)
        || runtime.fencingToken !== input.leaseVersion
        || attempt.platformWriteAttemptCount !== 0) {
        throw new Error("desktop_outreach_completion_stale");
      }
      action.status = "executing";
      attempt.platformWriteAttemptCount = 1;
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state: "executing", replayed: false, accountPaused: false,
        occurredAt: input.occurredAt };
      attempt.startedAt = input.occurredAt;
      attempt.startedRequestHash = input.requestHash;
      attempt.startedResponse = clone(response);
      state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
        response: clone(response) });
      return response;
    });
  }

  completeDesktopAction(input: DesktopOutreachReceiptRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>((state, token) => {
      const { action, account, attempt, runtime } =
        this.desktopCompletionAuthority(state, token, input);
      const expectedReceiptHash = desktopOutreachReceiptHash({
        action_id: input.receipt.actionId, failure_code: input.receipt.failureCode,
        occurred_at: input.receipt.occurredAt,
        platform_receipt_reference: input.receipt.platformReceiptReference,
        state: input.receipt.state
      }).hash;
      const classification = classifyOutreachActionReceipt({ executionTarget: "desktop",
        executionPhase: input.receipt.failureCode === "douyin_profile_busy"
          ? "started_pre_journal" : "started_post_journal",
        receiptState: input.receipt.state, failureCode: input.receipt.failureCode });
      if (expectedReceiptHash !== input.receiptHash
        || classification.stateEffect !== input.stateEffect) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const key = `${input.workspaceId}\0desktop_outreach_receipt\0${input.idempotencyKeyHash}`;
      const replay = state.desktopCompletionReplays.get(key);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        return { ...clone(replay.response), replayed: true };
      }
      if (attempt.receiptResponse) {
        if (!matchesPersistedDesktopAttemptReceipt(attempt, input)) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = { ...clone(attempt.receiptResponse), replayed: true };
        state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
          response: clone(attempt.receiptResponse) });
        return response;
      }
      if (Date.parse(input.now) >= Date.parse(account.executorLeaseExpiresAt ?? "")) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      const liveExecution = action.status === "executing" && runtime
        && runtime.workerId === input.processInstanceIdHash
        && runtime.leaseToken === input.taskTokenHash.slice("sha256:".length)
        && runtime.fencingToken === input.leaseVersion;
      const exactLateOriginal = action.status === "reconciliation_required" && runtime
        && runtime.workerId === null && runtime.leaseToken === null
        && runtime.leaseExpiresAt === null
        && runtime.fencingToken === input.leaseVersion
        && Date.parse(input.now) < Date.parse(account.executorLeaseExpiresAt!)
        && attempt.platformWriteAttemptCount === 1
        && attempt.startedRequestHash !== null && attempt.startedResponse !== null
        && attempt.receiptHash === null && attempt.receiptRequestHash === null
        && attempt.receiptResponse === null;
      if (input.receipt.actionId !== action.id
        || (!liveExecution && !exactLateOriginal)
        || attempt.platformWriteAttemptCount !== 1 || !attempt.startedResponse) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const frozenPredecessorAuthority = clone(action);
      action.status = classification.stateEffect;
      action.platformReceiptReference = classification.stateEffect === "succeeded"
        ? input.receipt.platformReceiptReference : null;
      action.failureCode = classification.stateEffect === "succeeded"
        || classification.stateEffect === "queued" ? null : input.receipt.failureCode;
      action.occurredAt = input.receipt.occurredAt;
      let accountPaused = false;
      if (classification.stateEffect === "risk_paused") {
        const accountKey = `${action.workspaceId}\0${action.accountId}`;
        const executionAccount = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        executionAccount.paused = true;
        state.accounts.set(accountKey, executionAccount);
        accountPaused = true;
      }
      if (classification.stateEffect === "queued") {
        attempt.platformWriteAttemptCount = 0;
        state.directMessageClaims = state.directMessageClaims.filter((claim) =>
          claim.actionId !== action.id || claim.fencingToken !== input.leaseVersion);
      }
      if (classification.stateEffect === "failed" && action.kind === "comment") {
        const batch = this.current(state, action.workspaceId, action.batchId);
        for (const candidate of [...state.actions.values()].flat()) {
          if (candidate.status === "blocked_by_predecessor" && batch
            && validFrozenDirectMessageSuccessorAuthority(candidate, batch,
              frozenPredecessorAuthority)) {
            candidate.status = "failed";
            candidate.failureCode = "predecessor_failed";
            candidate.occurredAt = input.receipt.occurredAt;
            candidate.platformReceiptReference = null;
          }
        }
      }
      if (classification.stateEffect === "succeeded" && action.kind === "comment") {
        const batch = this.current(state, action.workspaceId, action.batchId);
        for (const candidate of [...state.actions.values()].flat()) {
          if (candidate.workspaceId === action.workspaceId
            && candidate.batchId === action.batchId
            && candidate.accountId === action.accountId
            && candidate.predecessorActionId === action.id
            && candidate.kind === "direct_message"
            && candidate.status === "blocked_by_predecessor"
            && batch && validDirectMessageClaimAuthority(candidate, batch, action)) {
            candidate.status = "queued";
          }
        }
      }
      runtime.workerId = null;
      runtime.leaseToken = null;
      runtime.leaseExpiresAt = null;
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state: classification.stateEffect, replayed: false, accountPaused,
        occurredAt: input.receipt.occurredAt };
      persistDesktopAttemptReceipt(attempt, input, response);
      state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
        response: clone(response) });
      return response;
    });
  }

  completeDesktopReconciliation(
    input: DesktopOutreachReconciliationReceiptRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>((state, token) => {
      const { action, account, attempt, runtime } =
        this.desktopReconciliationCompletionAuthority(state, token, input);
      const expectedReceiptHash = desktopOutreachReceiptHash({
        action_id: input.receipt.actionId, failure_code: input.receipt.failureCode,
        occurred_at: input.receipt.occurredAt,
        platform_receipt_reference: input.receipt.platformReceiptReference,
        state: input.receipt.state
      }).hash;
      const classification = classifyOutreachActionReceipt({ executionTarget: "desktop",
        executionPhase: "started_post_journal", receiptState: input.receipt.state,
        failureCode: input.receipt.failureCode });
      if (expectedReceiptHash !== input.receiptHash
        || classification.stateEffect !== input.stateEffect
        || (input.receipt.state === "succeeded"
          ? input.receipt.failureCode !== null
          : input.receipt.failureCode !== "action_unavailable")) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const key = `${input.workspaceId}\0desktop_outreach_reconciliation_receipt\0${input.idempotencyKeyHash}`;
      const replay = state.desktopCompletionReplays.get(key);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        return { ...clone(replay.response), replayed: true };
      }
      if (attempt.receiptResponse) {
        if (!matchesPersistedDesktopAttemptReceipt(attempt, input)) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = { ...clone(attempt.receiptResponse), replayed: true };
        state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
          response: clone(attempt.receiptResponse) });
        return response;
      }
      if (!attempt.recoveryLeaseExpiresAt
        || Date.parse(input.now) >= Date.parse(attempt.recoveryLeaseExpiresAt)) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if (Date.parse(input.now) >= Date.parse(account.executorLeaseExpiresAt ?? "")) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if ((action.status !== "executing"
          && action.status !== "reconciliation_required")
        || input.receipt.actionId !== action.id) {
        throw new Error("desktop_outreach_completion_stale");
      }
      action.status = classification.stateEffect;
      action.platformReceiptReference = classification.stateEffect === "succeeded"
        ? input.receipt.platformReceiptReference : null;
      action.failureCode = classification.stateEffect === "succeeded"
        ? null : input.receipt.failureCode;
      action.occurredAt = input.receipt.occurredAt;
      if (classification.stateEffect === "succeeded" && action.kind === "comment") {
        const batch = this.current(state, action.workspaceId, action.batchId);
        for (const candidate of [...state.actions.values()].flat()) {
          if (candidate.workspaceId === action.workspaceId
            && candidate.batchId === action.batchId
            && candidate.accountId === action.accountId
            && candidate.predecessorActionId === action.id
            && candidate.kind === "direct_message"
            && candidate.status === "blocked_by_predecessor"
            && batch && validDirectMessageClaimAuthority(candidate, batch, action)) {
            candidate.status = "queued";
          }
        }
      }
      if (runtime) {
        runtime.workerId = null;
        runtime.leaseToken = null;
        runtime.leaseExpiresAt = null;
      }
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state: classification.stateEffect, replayed: false, accountPaused: false,
        occurredAt: input.receipt.occurredAt };
      persistDesktopAttemptReceipt(attempt, input, response);
      state.desktopCompletionReplays.set(key, { requestHash: input.requestHash,
        response: clone(response) });
      return response;
    });
  }

  recoverDesktopAction(input: DesktopOutreachRecoveryRepositoryInput) {
    return this.transaction<DesktopOutreachRecoveryResult>((state, token) => {
      const social = this.testing.socialAccounts;
      const installations = this.testing.desktopInstallations;
      const notAuthorized = (): DesktopOutreachRecoveryResult => ({
        kind: "not_authorized", replayed: false
      });
      if (!token || !social || !installations || !this.testing.memoryTransactions
        || social.memoryTransactions !== this.testing.memoryTransactions
        || installations.memoryTransactions !== this.testing.memoryTransactions) {
        throw new Error("acquisition_memory_transaction_boundary_required");
      }
      const installation = installations.getActiveInstallationRecord(token,
        input.workspaceId, input.deviceIdHash);
      if (!installation) return notAuthorized();
      const account = social.getDesktopExecutorBindingRecord(token,
        input.workspaceId, input.accountId);
      if (!account || account.state !== "active" || account.executorMode !== "desktop"
        || account.executorDeviceIdHash !== input.deviceIdHash
        || account.accountHandle !== input.accountHandle
        || account.loginStateVersion !== input.loginStateVersion
        || account.executorBindingGeneration !== input.bindingGeneration
        || !account.executorLeaseExpiresAt
        || Date.parse(input.now) >= Date.parse(account.executorLeaseExpiresAt)) {
        return notAuthorized();
      }
      const action = [...state.actions.values()].flat().find((candidate) =>
        candidate.workspaceId === input.workspaceId && candidate.id === input.actionId);
      if (!action || action.executionTarget !== "desktop"
        || action.accountId !== input.accountId
        || action.accountLoginStateVersion !== input.loginStateVersion) {
        return notAuthorized();
      }
      const attempt = state.desktopAttempts.find((candidate) =>
        candidate.actionId === input.actionId
        && candidate.fencingToken === input.originalLeaseVersion);
      const runtime = state.actionRuntime.get(input.actionId);
      if (!attempt || attempt.deviceIdHash !== input.deviceIdHash
        || attempt.executorBindingGeneration !== input.bindingGeneration
        || attempt.taskRequestHash !== input.taskRequestHash
        || attempt.processInstanceIdHash === input.processInstanceIdHash) {
        return notAuthorized();
      }
      let canonicalTarget: string;
      let expectedTaskRequestHash: string;
      try {
        canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
          action.targetPublicUrl);
        expectedTaskRequestHash = desktopOutreachRequestHash({
          account_handle: input.accountHandle, action_id: action.id,
          approved_content_hash: action.contentHash,
          canonical_target_public_url: canonicalTarget, content: action.content,
          kind: action.kind, login_state_version: action.accountLoginStateVersion
        }).hash;
      } catch { return notAuthorized(); }
      if (canonicalTarget !== action.targetPublicUrl
        || expectedTaskRequestHash !== input.taskRequestHash) return notAuthorized();
      const currentOriginalFence = Boolean(runtime
        && runtime.fencingToken === input.originalLeaseVersion
        && attempt.deviceIdHash === input.deviceIdHash
        && attempt.executorBindingGeneration === input.bindingGeneration
        && attempt.taskRequestHash === input.taskRequestHash);
      const currentOriginalActiveClaim = currentOriginalFence
        && runtime!.workerId === attempt.processInstanceIdHash
        && runtime!.leaseToken === attempt.taskTokenHash.slice("sha256:".length);
      const neverStarted = attempt.platformWriteAttemptCount === 0
        && attempt.startedAt === null && attempt.startedRequestHash === null
        && attempt.startedResponse === null && attempt.receiptHash === null
        && attempt.receiptRequestHash === null && attempt.receiptOperation === null
        && attempt.receiptJson === null && attempt.receiptResponse === null
        && attempt.outcome === null;
      const originalClaimRevoked = Boolean(runtime
        && (runtime.fencingToken > input.originalLeaseVersion
          || (currentOriginalFence && action.status === "queued"
            && runtime.workerId === null && runtime.leaseToken === null
            && runtime.leaseExpiresAt === null)));
      const canReleaseUnstarted = input.journalPhase === "claimed"
        && neverStarted && originalClaimRevoked;
      const centrallyStarted = attempt.platformWriteAttemptCount === 1
        && attempt.startedAt !== null && attempt.startedRequestHash !== null
        && attempt.startedResponse?.actionId === action.id
        && attempt.startedResponse.state === "executing";

      const replayKeyValue = `${input.workspaceId}\0desktop_outreach_recovery\0${input.idempotencyKeyHash}`;
      const replay = state.desktopRecoveryReplays.get(replayKeyValue);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        if (replay.response.kind === "waiting"
          && (!currentOriginalActiveClaim || action.status !== "claimed"
            || attempt.platformWriteAttemptCount !== 0)) {
          return notAuthorized();
        }
        if (replay.response.kind === "released" && (!canReleaseUnstarted
          || replay.response.actionId !== action.id
          || replay.response.taskRequestHash !== input.taskRequestHash
          || replay.response.originalLeaseVersion !== input.originalLeaseVersion)) {
          return notAuthorized();
        }
        if (replay.response.kind !== "reconcile") {
          return { ...clone(replay.response), replayed: true };
        }
        const taskToken = this.desktopReconciliationToken(replay.response.task, input);
        if (attempt.recoveryProcessInstanceIdHash !== input.processInstanceIdHash
          || attempt.recoveryGeneration
            !== replay.response.task.reconciliationGeneration
          || attempt.recoveryTaskTokenHash
            !== `sha256:${createHash("sha256").update(taskToken).digest("hex")}`
          || replay.response.task.workspaceId !== action.workspaceId
          || replay.response.task.kind !== action.kind
          || replay.response.task.canonicalTargetPublicUrl !== canonicalTarget
          || replay.response.task.content !== action.content
          || replay.response.task.approvedContentHash !== action.contentHash
          || replay.response.task.deadlineAt !== attempt.recoveryLeaseExpiresAt
          || !currentOriginalFence) {
          return notAuthorized();
        }
        return { ...clone(replay.response), taskToken, replayed: true };
      }

      if (attempt.receiptHash && attempt.receiptResponse) {
        if (input.journalPhase === "sidecar_completed"
          && input.receiptHash !== attempt.receiptHash) return notAuthorized();
        const response = { kind: "terminal" as const,
          status: attempt.receiptResponse.state, receiptHash: attempt.receiptHash,
          replayed: false };
        state.desktopRecoveryReplays.set(replayKeyValue, {
          requestHash: input.requestHash, response: clone(response)
        });
        return response;
      }
      if (input.journalPhase === "claimed" && !centrallyStarted) {
        if (canReleaseUnstarted) {
          const response = { kind: "released" as const, actionId: action.id,
            taskRequestHash: input.taskRequestHash,
            originalLeaseVersion: input.originalLeaseVersion, replayed: false };
          state.desktopRecoveryReplays.set(replayKeyValue, {
            requestHash: input.requestHash, response: clone(response)
          });
          return response;
        }
        if (!currentOriginalActiveClaim || action.status !== "claimed"
          || attempt.platformWriteAttemptCount !== 0) {
          return notAuthorized();
        }
        const response = { kind: "waiting" as const, retryAfterMs: 3_000,
          replayed: false };
        state.desktopRecoveryReplays.set(replayKeyValue, {
          requestHash: input.requestHash, response: clone(response)
        });
        return response;
      }
      if (!currentOriginalFence || !centrallyStarted
        || (action.status !== "executing"
          && action.status !== "reconciliation_required")) return notAuthorized();

      if ([...state.actions.values()].flat().some(other => other.id !== action.id
        && other.workspaceId === action.workspaceId && other.accountId === action.accountId
        && ["claimed", "executing"].includes(other.status))) return notAuthorized();

      const reconciliationGeneration = attempt.recoveryGeneration + 1;
      const task: DesktopOutreachReconciliationTask = Object.freeze({
        actionId: action.id, workspaceId: action.workspaceId,
        accountId: action.accountId,
        accountHandle: input.accountHandle,
        loginStateVersion: action.accountLoginStateVersion,
        executorBindingGeneration: input.bindingGeneration,
        kind: action.kind, canonicalTargetPublicUrl: canonicalTarget,
        content: action.content, approvedContentHash: action.contentHash,
        deadlineAt: input.recoveryLeaseExpiresAt,
        taskRequestHash: input.taskRequestHash,
        leaseVersion: reconciliationGeneration,
        originalLeaseVersion: input.originalLeaseVersion,
        reconciliationGeneration, capability: "reconcile_only"
      });
      const taskToken = this.desktopReconciliationToken(task, input);
      attempt.recoveryGeneration = reconciliationGeneration;
      attempt.recoveryProcessInstanceIdHash = input.processInstanceIdHash;
      attempt.recoveryTaskTokenHash = `sha256:${createHash("sha256")
        .update(taskToken).digest("hex")}`;
      attempt.recoveryLeaseExpiresAt = input.recoveryLeaseExpiresAt;
      const stored = { kind: "reconcile" as const, task };
      state.desktopRecoveryReplays.set(replayKeyValue, {
        requestHash: input.requestHash, response: clone(stored)
      });
      return { ...stored, taskToken, replayed: false };
    });
  }

  completeActionSuccess(fence: OutreachActionFence, receipt: OutreachActionSuccessReceipt) {
    return this.transaction<boolean>((state) => {
      const located = [...state.actions.values()].flat().find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return false;
      located.status = "succeeded";
      located.platformReceiptReference = receipt.platformReceiptReference;
      located.occurredAt = receipt.occurredAt; located.failureCode = null;
      const batch = this.current(state, located.workspaceId, located.batchId);
      for (const candidate of [...state.actions.values()].flat()) {
        if (candidate.predecessorActionId === located.id
          && candidate.status === "blocked_by_predecessor"
          && batch && validDirectMessageClaimAuthority(candidate, batch, located)) {
          candidate.status = "queued";
        }
      }
      runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
      const accountKey = `${located.workspaceId}\u0000${located.accountId}`;
      const account = state.accounts.get(accountKey)!; account.consecutiveFailures = 0;
      return true;
    });
  }

  completeActionFailure(fence: OutreachActionFence, failureCode: string, occurredAt: string) {
    return this.transaction<{ completed: boolean; accountPaused: boolean }>((state) => {
      const actions = [...state.actions.values()].flat();
      const located = actions.find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return { completed: false, accountPaused: false };
      const frozenPredecessorAuthority = clone(located);
      const uncertainExternalWrite = ["action_unavailable", "douyin_action_timeout",
        "douyin_action_receipt_ambiguous"].includes(failureCode);
      located.status = uncertainExternalWrite ? "risk_paused" : "failed";
      located.failureCode = failureCode;
      located.occurredAt = occurredAt; located.platformReceiptReference = null;
      const batch = this.current(state, located.workspaceId, located.batchId);
      if (!uncertainExternalWrite) for (const action of actions) {
        if (action.status === "blocked_by_predecessor" && batch
          && validFrozenDirectMessageSuccessorAuthority(action, batch,
            frozenPredecessorAuthority)) {
          action.status = "failed";
          action.failureCode = "predecessor_failed";
          action.occurredAt = occurredAt;
          action.platformReceiptReference = null;
        }
      }
      runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
      const accountKey = `${located.workspaceId}\u0000${located.accountId}`;
      const account = state.accounts.get(accountKey)!;
      account.consecutiveFailures += 1;
      const immediatePause = ["douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_account_identity_changed",
        "douyin_login_expired", "action_unavailable",
        "douyin_action_timeout", "douyin_action_receipt_ambiguous"].includes(failureCode);
      account.paused = immediatePause || account.consecutiveFailures >= 3;
      if (account.paused) for (const action of actions) {
        if (action.workspaceId === located.workspaceId && action.accountId === located.accountId
          && ["queued", "blocked_by_predecessor"].includes(action.status)) {
          action.status = "risk_paused";
          action.failureCode = "account_risk_paused";
          action.occurredAt = occurredAt;
          action.platformReceiptReference = null;
        }
      }
      return { completed: true, accountPaused: account.paused };
    });
  }

  completeActionRetry(fence: OutreachActionFence,
    _failureCode: "douyin_profile_busy" | "platform_execution_denied", _occurredAt: string) {
    return this.transaction<boolean>((state) => {
      const located = [...state.actions.values()].flat()
        .find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId
        || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return false;
      located.status = "queued";
      located.failureCode = null;
      located.occurredAt = null;
      located.platformReceiptReference = null;
      state.directMessageClaims = state.directMessageClaims.filter((claim) =>
        claim.actionId !== located.id || claim.fencingToken !== fence.fencingToken);
      runtime.workerId = null;
      runtime.leaseToken = null;
      runtime.leaseExpiresAt = null;
      return true;
    });
  }

  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }) {
    return this.transaction<boolean>((state) => {
      const located = (state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? [])
        .find((action) => action.id === input.actionId);
      if (!located || located.status !== "risk_paused"
        || located.failureCode !== input.expectedFailureCode) return false;
      located.status = "succeeded";
      located.failureCode = null;
      located.platformReceiptReference = input.receipt.platformReceiptReference;
      located.occurredAt = input.receipt.occurredAt;
      const runtime = state.actionRuntime.get(located.id);
      if (runtime) {
        runtime.workerId = null;
        runtime.leaseToken = null;
        runtime.leaseExpiresAt = null;
      }
      return true;
    });
  }

  private executionGateIn(state: State, workspaceId: string, batchId: string) {
    const batch = this.current(state, workspaceId, batchId);
    if (!batch) return null;
    const actions = [...state.actions.values()].flat();
    const pendingActionIds = (state.actions.get(batchKey(workspaceId, batchId)) ?? [])
      .filter((action) => {
        const runtime = state.actionRuntime.get(action.id);
        return batch.state === "approved" && action.kind === "comment"
          && action.accountId === batch.accountId
          && action.accountLoginStateVersion === batch.accountLoginStateVersion
          && action.batchRevision === batch.revision
          && action.approvalHash === batch.approvalHash
          && (runtime?.attemptCount ?? 0) === 0
          && (action.status === "queued" || (action.status === "risk_paused"
            && action.failureCode === "account_risk_paused"));
      })
      .map((action) => action.id)
      .sort();
    const uncertain = new Set<OutreachUncertainActionFailureCode>([
      "action_unavailable", "douyin_action_timeout",
      "douyin_action_receipt_ambiguous"
    ]);
    const unresolvedActions = actions
      .filter((action) => action.workspaceId === workspaceId
        && action.accountId === batch.accountId
        && action.status === "risk_paused"
        && uncertain.has(action.failureCode as OutreachUncertainActionFailureCode))
      .map((action) => ({ actionId: action.id,
        failureCode: action.failureCode as OutreachUncertainActionFailureCode }))
      .sort((left, right) => left.actionId.localeCompare(right.actionId));
    const account = state.accounts.get(`${workspaceId}\u0000${batch.accountId}`);
    return {
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      riskPaused: account?.paused ?? false,
      pendingActionIds,
      unresolvedActions
    } satisfies OutreachActionExecutionGate;
  }

  async actionExecutionGate(workspaceId: string, batchId: string) {
    return this.executionGateIn(await this.snapshot(), workspaceId, batchId);
  }

  recoverAccountActions(input: {
    workspaceId: string; batchId: string; batchRevision: number;
    ifMatch: string;
    accountLoginStateVersion: number; pendingActionIds: readonly string[];
    acknowledgedUncertainActionIds: readonly string[];
    actorId: string; reason: string; recoveredAt: string;
    operation: string; idempotencyKey: string; requestHash: string;
  }) {
    return this.transaction<OutreachRepositoryResult<OutreachActionAccountRecovery>>((state) => {
      const replayKeyValue = replayKey(input.workspaceId,
        `${input.operation}:${input.batchId}`, input.idempotencyKey);
      const replay = state.recoveryReplays.get(replayKeyValue);
      if (replay) return replay.requestHash === input.requestHash
        ? { kind: "replay", value: replay.value }
        : { kind: "conflict" };
      const batch = this.current(state, input.workspaceId, input.batchId);
      if (!batch) return { kind: "not_found" };
      if (batch.state !== "approved" || batch.etag !== input.ifMatch
        || batch.revision !== input.batchRevision
        || batch.accountLoginStateVersion !== input.accountLoginStateVersion) {
        return { kind: "stale" };
      }
      const before = this.executionGateIn(state, input.workspaceId, input.batchId)!;
      const expectedPending = [...input.pendingActionIds].sort();
      const expectedUncertain = [...input.acknowledgedUncertainActionIds].sort();
      if (!before.riskPaused
        || JSON.stringify(before.pendingActionIds) !== JSON.stringify(expectedPending)
        || JSON.stringify(before.unresolvedActions.map((action) => action.actionId))
          !== JSON.stringify(expectedUncertain)
        || [...state.actions.values()].flat().some((action) =>
          action.workspaceId === input.workspaceId
          && action.accountId === batch.accountId && action.status === "executing")
        || [...state.actions.values()].flat().some((action) =>
          action.workspaceId === input.workspaceId
          && action.accountId === batch.accountId
          && action.batchId !== input.batchId
          && ["queued", "blocked_by_predecessor"].includes(action.status))) {
        return { kind: "stale" };
      }
      const targetIds = new Set(expectedPending);
      for (const action of state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? []) {
        if (!targetIds.has(action.id)) continue;
        if (action.status === "risk_paused"
          && action.failureCode === "account_risk_paused") {
          action.status = "queued";
          action.failureCode = null;
          action.occurredAt = null;
          action.platformReceiptReference = null;
        }
      }
      const account = state.accounts.get(`${input.workspaceId}\u0000${batch.accountId}`);
      if (!account) return { kind: "stale" };
      account.paused = false;
      account.consecutiveFailures = 0;
      const after = this.executionGateIn(state, input.workspaceId, input.batchId)!;
      const value: OutreachActionAccountRecovery = {
        ...after,
        enabledActionIds: expectedPending,
        acknowledgedUncertainActionIds: expectedUncertain,
        recoveredBy: input.actorId,
        recoveredAt: input.recoveredAt
      };
      state.recoveryAudit.push(clone(value));
      state.recoveryReplays.set(replayKeyValue, {
        requestHash: input.requestHash,
        value: clone(value)
      });
      return { kind: "created", value };
    });
  }

  recordDesktopReconciliation(input: DesktopOutreachHumanReconciliationInput) {
    const keys = ["workspaceId", "batchId", "actionId", "batchRevision",
      "approvalHash", "contentHash", "requestedByUserId", "requestedAt",
      "operation", "idempotencyKey", "requestHash"];
    const validId = (value: unknown) => typeof value === "string"
      && value.length > 0 && value.length <= 255
      && !/[\u0000-\u001f\u007f]/u.test(value);
    const validTimestamp = (value: unknown) => {
      if (typeof value !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
      const at = Date.parse(value);
      return Number.isFinite(at) && new Date(at).toISOString() === value;
    };
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== keys.length
      || keys.some((key) => !(key in input))
      || !validId(input.workspaceId) || !validId(input.batchId)
      || !validId(input.actionId) || !validId(input.requestedByUserId)
      || !Number.isSafeInteger(input.batchRevision) || input.batchRevision < 1
      || !/^sha256:[a-f0-9]{64}$/u.test(input.approvalHash)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.contentHash)
      || !validTimestamp(input.requestedAt)
      || input.operation !== "request_desktop_action_reconciliation"
      || typeof input.idempotencyKey !== "string"
      || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200
      || /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.requestHash)) {
      throw new TypeError("invalid_desktop_outreach_reconciliation_request");
    }
    return this.transaction<DesktopOutreachHumanReconciliationResult>((state) => {
      const idempotencyKeyHash = createHash("sha256").update(
        `shensi-desktop-human-reconciliation-idempotency\0${input.idempotencyKey}`,
        "utf8").digest("hex");
      const replayKeyValue = `${input.workspaceId}\0${input.operation}\0${idempotencyKeyHash}`;
      const replay = state.desktopHumanReconciliationReplays.get(replayKeyValue);
      if (replay) {
        const request = replay.value.reconciliationRequest;
        const sameLogicalRequest = replay.requestHash === input.requestHash
          && replay.value.workspaceId === input.workspaceId
          && replay.value.batchId === input.batchId
          && replay.value.id === input.actionId
          && replay.value.batchRevision === input.batchRevision
          && replay.value.approvalHash === input.approvalHash
          && replay.value.contentHash === input.contentHash
          && request.requestedByUserId === input.requestedByUserId;
        return sameLogicalRequest
          ? { kind: "replay", value: clone(replay.value) }
          : { kind: "conflict" };
      }
      const currentBatch = this.current(state, input.workspaceId, input.batchId);
      const action = (state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? [])
        .find((candidate) => candidate.id === input.actionId);
      if (!currentBatch || !action) return { kind: "not_found" };
      if (action.executionTarget !== "desktop"
        || action.status !== "reconciliation_required"
        || currentBatch.workspaceId !== input.workspaceId
        || currentBatch.id !== input.batchId
        || currentBatch.revision !== input.batchRevision
        || currentBatch.approvalHash !== input.approvalHash
        || action.workspaceId !== input.workspaceId || action.batchId !== input.batchId
        || action.batchRevision !== input.batchRevision
        || action.approvalHash !== input.approvalHash
        || action.contentHash !== input.contentHash) return { kind: "stale" };
      const attempt = state.desktopAttempts
        .filter((candidate) => candidate.actionId === action.id)
        .sort((left, right) => right.fencingToken - left.fencingToken)[0];
      if (!attempt || attempt.platformWriteAttemptCount !== 1) {
        return { kind: "stale" };
      }
      const reconciliationRequest: DesktopOutreachHumanReconciliationRequest = {
        requestedByUserId: input.requestedByUserId,
        requestedAt: input.requestedAt,
        expectedExecutionLeaseVersion: attempt.fencingToken
      };
      const value = { ...clone(action), reconciliationRequest };
      state.desktopHumanReconciliationAudit.push({
        workspaceId: input.workspaceId, batchId: input.batchId,
        actionId: input.actionId, batchRevision: input.batchRevision,
        approvalHash: input.approvalHash, contentHash: input.contentHash,
        requestedByUserId: input.requestedByUserId, requestedAt: input.requestedAt,
        operation: input.operation, requestHash: input.requestHash,
        idempotencyKeyHash, expectedExecutionLeaseVersion: attempt.fencingToken
      });
      state.desktopHumanReconciliationReplays.set(replayKeyValue, {
        requestHash: input.requestHash, value: clone(value)
      });
      return { kind: "created", value };
    });
  }

  recoverExpiredActionClaims(now: string) {
    return this.transaction<number>((state) => {
      const at = Date.parse(now); let recovered = 0;
      for (const action of [...state.actions.values()].flat()) {
        const runtime = state.actionRuntime.get(action.id);
        if (!runtime?.leaseExpiresAt
          || Date.parse(runtime.leaseExpiresAt) > at) continue;
        if (action.executionTarget === "desktop"
          && (action.status === "claimed" || action.status === "executing")) {
          const attempt = state.desktopAttempts.find((candidate) =>
            candidate.actionId === action.id
            && candidate.fencingToken === runtime.fencingToken);
          if (!attempt) continue;
          if (action.status === "claimed"
            && attempt.platformWriteAttemptCount === 0) {
            action.status = "queued";
            action.failureCode = null;
            action.occurredAt = null;
            action.platformReceiptReference = null;
            state.directMessageClaims = state.directMessageClaims.filter((claim) =>
              claim.actionId !== action.id
              || claim.fencingToken !== runtime.fencingToken);
          } else if (action.status === "executing"
            || attempt.platformWriteAttemptCount === 1) {
            action.status = "reconciliation_required";
            action.failureCode = "douyin_action_receipt_ambiguous";
            action.occurredAt = now;
            action.platformReceiptReference = null;
          } else {
            continue;
          }
          runtime.workerId = null;
          runtime.leaseToken = null;
          runtime.leaseExpiresAt = null;
          recovered += 1;
          continue;
        }
        if (action.executionTarget === "desktop" || action.status !== "executing") {
          continue;
        }
        action.status = "risk_paused";
        action.failureCode = "douyin_action_receipt_ambiguous";
        action.occurredAt = now;
        action.platformReceiptReference = null;
        runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
        const accountKey = `${action.workspaceId}\u0000${action.accountId}`;
        const account = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        account.paused = true;
        state.accounts.set(accountKey, account);
        for (const related of [...state.actions.values()].flat()) {
          if (related.workspaceId === action.workspaceId
            && related.accountId === action.accountId
            && ["queued", "blocked_by_predecessor"].includes(related.status)) {
            related.status = "risk_paused";
            related.failureCode = "account_risk_paused";
            related.occurredAt = now;
            related.platformReceiptReference = null;
          }
        }
        recovered += 1;
      }
      return recovered;
    });
  }
}
