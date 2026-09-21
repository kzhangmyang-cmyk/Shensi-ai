import { createHash } from "node:crypto";
import type { PlatformExecutionAccess } from './platform-execution-access.js';

import { canonicalJsonStringify } from "./canonical-json.js";
import type { DesktopInstallationPrincipal } from "./acquisition-desktop-installation.js";
import type { AcquisitionDesktopInstallationService } from
  "./acquisition-desktop-installation-service.js";
import type { OutreachActionAuthority } from "./acquisition-outreach-action-authority.js";
import { classifyOutreachActionReceipt } from "./acquisition-outreach-action-worker.js";
import { desktopOutreachReceiptHash } from "./acquisition-outreach-target-url.js";
import type { AcquisitionDesktopOutreachRepository, DesktopOutreachAvailableAccount,
  DesktopOutreachClaimInput, DesktopOutreachClaimResult,
  DesktopOutreachClaimAuthoritySnapshot,
  DesktopOutreachCompletionResult, DesktopOutreachReceiptRepositoryInput,
  DesktopOutreachStartedRepositoryInput,
  DesktopOutreachReconciliationReceiptRepositoryInput,
  DesktopOutreachRecoveryResult,
  DesktopOutreachRecoveryJournalPhase } from
  "./acquisition-outreach-batch-repository.js";

export class AcquisitionDesktopOutreachSyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AcquisitionDesktopOutreachSyncError";
  }
}

export interface DesktopOutreachSyncClaimInput {
  processInstanceId: string;
  availableAccounts: readonly DesktopOutreachAvailableAccount[];
  idempotencyKey: string;
}

interface DesktopOutreachCompletionBase {
  processInstanceId: string;
  taskToken: string;
  leaseVersion: number;
  executorBindingGeneration: number;
  loginStateVersion: number;
  taskRequestHash: string;
  idempotencyKey: string;
}

export interface DesktopOutreachStartedInput extends DesktopOutreachCompletionBase {
  event: "started";
  occurredAt: string;
}

interface DesktopOutreachReceiptPayload {
  actionId: string;
  state: "succeeded" | "failed";
  platformReceiptReference: string | null;
  occurredAt: string;
  failureCode: string | null;
}

export interface DesktopOutreachReceiptInput extends DesktopOutreachCompletionBase {
  event: "receipt";
  reconciliation: false | true;
  receipt: DesktopOutreachReceiptPayload;
}

export type DesktopOutreachCompletionInput = DesktopOutreachStartedInput |
  DesktopOutreachReceiptInput;

export interface DesktopOutreachReconcileInput {
  version: 1;
  processInstanceId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  bindingGeneration: number;
  originalLeaseVersion: number;
  taskRequestHash: string;
  journalPhase: DesktopOutreachRecoveryJournalPhase;
  receiptHash?: string;
  idempotencyKey: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const BARE_HASH = /^[a-f0-9]{64}$/u;
const ACCOUNT_HANDLE = /^dyacct_[a-f0-9]{64}$/u;
const RECEIPT_FAILURE_CODES = new Set([
  "action_unavailable", "action_rejected", "deadline_exceeded",
  "douyin_verification_required", "douyin_rate_limited",
  "douyin_account_warning", "douyin_account_identity_changed",
  "douyin_login_expired", "douyin_direct_message_unavailable",
  "douyin_action_control_missing", "douyin_action_control_ambiguous",
  "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous",
  "douyin_action_timeout", "douyin_profile_busy"
]);

function fail(code: string): never { throw new AcquisitionDesktopOutreachSyncError(code); }
function hash(domain: string, value: string) {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
}
function secretHash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function exactKeys(value: unknown, keys: readonly string[]) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => key in value));
}
function validId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validIdempotencyKey(value: unknown) {
  return typeof value === "string" && value.length >= 8 && value.length <= 200
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validAccount(value: unknown): value is DesktopOutreachAvailableAccount {
  const keys = ["accountId", "accountHandle", "loginStateVersion", "bindingGeneration"];
  if (!exactKeys(value, keys)) return false;
  const account = value as DesktopOutreachAvailableAccount;
  return validId(account.accountId) && ACCOUNT_HANDLE.test(account.accountHandle)
    && Number.isSafeInteger(account.loginStateVersion) && account.loginStateVersion >= 1
    && Number.isSafeInteger(account.bindingGeneration) && account.bindingGeneration >= 1;
}

function validateCompletion(actionId: string, input: DesktopOutreachCompletionInput) {
  if (!validId(actionId)) fail("invalid_desktop_outreach_completion");
  const baseKeys = ["event", "processInstanceId", "taskToken", "leaseVersion",
    "executorBindingGeneration", "loginStateVersion", "taskRequestHash",
    "idempotencyKey"];
  const eventKeys = input?.event === "started" ? [...baseKeys, "occurredAt"]
    : [...baseKeys, "reconciliation", "receipt"];
  if (!exactKeys(input, eventKeys) || !TOKEN.test(input.processInstanceId)
    || !TOKEN.test(input.taskToken) || !Number.isSafeInteger(input.leaseVersion)
    || input.leaseVersion < 1 || !Number.isSafeInteger(input.executorBindingGeneration)
    || input.executorBindingGeneration < 1 || !Number.isSafeInteger(input.loginStateVersion)
    || input.loginStateVersion < 1 || !BARE_HASH.test(input.taskRequestHash)
    || !validIdempotencyKey(input.idempotencyKey)) {
    fail("invalid_desktop_outreach_completion");
  }
  if (input.event === "started") {
    if (!exactTimestamp(input.occurredAt)) fail("invalid_desktop_outreach_completion");
    return;
  }
  const receiptKeys = ["actionId", "state", "platformReceiptReference", "occurredAt",
    "failureCode"];
  if ((input.reconciliation !== false && input.reconciliation !== true)
    || !exactKeys(input.receipt, receiptKeys)
    || input.receipt.actionId !== actionId || !exactTimestamp(input.receipt.occurredAt)
    || (input.receipt.state !== "succeeded" && input.receipt.state !== "failed")
    || (input.receipt.state === "succeeded"
      ? typeof input.receipt.platformReceiptReference !== "string"
        || input.receipt.platformReceiptReference.length < 1
        || input.receipt.platformReceiptReference.length > 255
        || input.receipt.failureCode !== null
      : input.receipt.platformReceiptReference !== null
        || typeof input.receipt.failureCode !== "string"
        || input.receipt.failureCode.length < 1 || input.receipt.failureCode.length > 80
        || !RECEIPT_FAILURE_CODES.has(input.receipt.failureCode))
    || (input.reconciliation === true
      && input.receipt.state === "failed"
      && input.receipt.failureCode !== "action_unavailable"
      && input.receipt.failureCode !== "douyin_action_receipt_ambiguous")) {
    fail("invalid_desktop_outreach_completion");
  }
}

function sanitizeRepositoryFailure(error: unknown): never {
  const code = error instanceof AcquisitionDesktopOutreachSyncError ? error.code
    : (error as { message?: unknown } | null)?.message;
  if (code === "desktop_action_replay_conflict"
    || code === "desktop_outreach_completion_not_authorized"
    || code === "desktop_outreach_completion_stale"
    || code === "desktop_outreach_start_expired") fail(code);
  fail("desktop_outreach_completion_stale");
}

function sanitizeClaimFailure(error: unknown): never {
  const code = error instanceof AcquisitionDesktopOutreachSyncError ? error.code
    : (error as { message?: unknown } | null)?.message;
  if (code === "desktop_outreach_claim_not_authorized"
    || code === "desktop_outreach_claim_idempotency_conflict") fail(code);
  fail("desktop_outreach_claim_not_authorized");
}

export class AcquisitionDesktopOutreachSync {
  constructor(private readonly options: {
    repository: AcquisitionDesktopOutreachRepository;
    platformExecutionAccess?: PlatformExecutionAccess;
    installationService: Pick<AcquisitionDesktopInstallationService,
      "renewDesktopExecutor">;
    authority: { resolve(snapshot: DesktopOutreachClaimAuthoritySnapshot,
      actorId: string): Promise<OutreachActionAuthority | null> };
    now(): string;
    actionDeadlineMs: number;
    leaseDurationMs: number;
  }) {
    if (!Number.isSafeInteger(options.actionDeadlineMs)
      || options.actionDeadlineMs < 60_000 || options.actionDeadlineMs > 330_000
      || options.leaseDurationMs !== options.actionDeadlineMs + 30_000) {
      throw new TypeError("invalid_desktop_outreach_sync_timing");
    }
  }

  async claim(principal: DesktopInstallationPrincipal,
    input: DesktopOutreachSyncClaimInput): Promise<DesktopOutreachClaimResult |
      (Extract<DesktopOutreachRecoveryResult, { kind: "reconcile" }> & { serverTime: string })> {
    const keys = ["processInstanceId", "availableAccounts", "idempotencyKey"];
    if (!exactKeys(input, keys) || !TOKEN.test(input.processInstanceId)
      || !validIdempotencyKey(input.idempotencyKey)
      || !Array.isArray(input.availableAccounts) || input.availableAccounts.length < 1
      || input.availableAccounts.some((account) => !validAccount(account))
      || new Set(input.availableAccounts.map((account) => account.accountId)).size
        !== input.availableAccounts.length) fail("invalid_desktop_outreach_claim");
    const now = this.options.now();
    if (!exactTimestamp(now)) fail("invalid_desktop_outreach_claim");
    try {
      await this.options.installationService.renewDesktopExecutor(principal,
        input.availableAccounts, now);
    } catch { fail("desktop_outreach_claim_not_authorized"); }
    const processInstanceIdHash = secretHash(input.processInstanceId);
    const canonicalClaim = { available_accounts: input.availableAccounts.map((account) => ({
      account_handle: account.accountHandle, account_id: account.accountId,
      binding_generation: account.bindingGeneration,
      login_state_version: account.loginStateVersion
    })), process_instance_id_hash: processInstanceIdHash, workspace_id: principal.workspaceId };
    const repositoryInput: DesktopOutreachClaimInput = {
      workspaceId: principal.workspaceId, deviceIdHash: principal.deviceIdHash,
      processInstanceIdHash, availableAccounts: input.availableAccounts,
      idempotencyKeyHash: hash("shensi-desktop-outreach-claim-idempotency",
        input.idempotencyKey),
      claimRequestHash: hash("shensi-desktop-outreach-claim-request",
        canonicalJsonStringify(canonicalClaim)), now,
      actionDeadlineAt: new Date(Date.parse(now) + this.options.actionDeadlineMs).toISOString(),
      leaseDurationMs: this.options.leaseDurationMs
    };
    try {
      const humanRequest = await this.options.repository.claimDesktopHumanReconciliation?.(repositoryInput);
      if (humanRequest) return humanRequest;
      if (this.options.platformExecutionAccess
        && !await this.options.platformExecutionAccess(principal.workspaceId, this.options.now())) {
        return { kind: 'empty', serverTime: now, retryAfterMs: 3_000, replayed: false };
      }
      return await this.options.repository.claimNextDesktopAction(repositoryInput,
        async (snapshot) => {
          try {
            return await this.options.authority.resolve(snapshot, principal.userId);
          } catch {
            return null;
          }
        });
    } catch (error) {
      sanitizeClaimFailure(error);
    }
  }

  async reconcile(principal: DesktopInstallationPrincipal, actionId: string,
    input: DesktopOutreachReconcileInput): Promise<DesktopOutreachRecoveryResult> {
    const baseKeys = ["version", "processInstanceId", "accountId", "accountHandle",
      "loginStateVersion", "bindingGeneration", "originalLeaseVersion",
      "taskRequestHash", "journalPhase", "idempotencyKey"];
    const keys = input?.journalPhase === "sidecar_completed"
      ? [...baseKeys, "receiptHash"] : baseKeys;
    if (!validId(actionId) || !exactKeys(input, keys) || input.version !== 1
      || !TOKEN.test(input.processInstanceId) || !validId(input.accountId)
      || !ACCOUNT_HANDLE.test(input.accountHandle)
      || !Number.isSafeInteger(input.loginStateVersion) || input.loginStateVersion < 1
      || !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 1
      || !Number.isSafeInteger(input.originalLeaseVersion)
      || input.originalLeaseVersion < 1 || !BARE_HASH.test(input.taskRequestHash)
      || (input.journalPhase !== "claimed" && input.journalPhase !== "central_started"
        && input.journalPhase !== "sidecar_completed")
      || (input.journalPhase === "sidecar_completed"
        ? !BARE_HASH.test(input.receiptHash ?? "") : "receiptHash" in input)
      || !validIdempotencyKey(input.idempotencyKey)) {
      fail("invalid_desktop_outreach_reconcile");
    }
    const now = this.options.now();
    if (!exactTimestamp(now)) fail("invalid_desktop_outreach_reconcile");
    const recoveryLeaseExpiresAt = new Date(Date.parse(now)
      + this.options.actionDeadlineMs).toISOString();
    const processInstanceIdHash = secretHash(input.processInstanceId);
    const requestMaterial = {
      version: input.version, workspace_id: principal.workspaceId, action_id: actionId,
      process_instance_id_hash: processInstanceIdHash, account_id: input.accountId,
      account_handle: input.accountHandle, login_state_version: input.loginStateVersion,
      binding_generation: input.bindingGeneration,
      original_lease_version: input.originalLeaseVersion,
      task_request_hash: input.taskRequestHash, journal_phase: input.journalPhase,
      receipt_hash: input.journalPhase === "sidecar_completed" ? input.receiptHash : null
    };
    try {
      return await this.options.repository.recoverDesktopAction({
        workspaceId: principal.workspaceId, actionId,
        deviceIdHash: principal.deviceIdHash, processInstanceIdHash,
        accountId: input.accountId, accountHandle: input.accountHandle,
        loginStateVersion: input.loginStateVersion,
        bindingGeneration: input.bindingGeneration,
        originalLeaseVersion: input.originalLeaseVersion,
        taskRequestHash: input.taskRequestHash, journalPhase: input.journalPhase,
        receiptHash: input.journalPhase === "sidecar_completed" ? input.receiptHash! : null,
        idempotencyKeyHash: hash("shensi-desktop-outreach-recovery-idempotency",
          input.idempotencyKey),
        requestHash: hash("shensi-desktop-outreach-recovery-request",
          canonicalJsonStringify(requestMaterial)), now, recoveryLeaseExpiresAt
      });
    } catch (error) {
      if ((error as { message?: unknown } | null)?.message
        === "desktop_action_replay_conflict") fail("desktop_action_replay_conflict");
      return { kind: "not_authorized", replayed: false };
    }
  }

  async complete(principal: DesktopInstallationPrincipal, actionId: string,
    input: DesktopOutreachCompletionInput): Promise<DesktopOutreachCompletionResult> {
    validateCompletion(actionId, input);
    const now = this.options.now();
    if (!exactTimestamp(now)) fail("invalid_desktop_outreach_completion");
    const completionOperation = input.event === "receipt" && input.reconciliation
      ? "reconciliation-receipt" : input.event;
    const common = { workspaceId: principal.workspaceId, actionId,
      deviceIdHash: principal.deviceIdHash,
      processInstanceIdHash: secretHash(input.processInstanceId),
      taskTokenHash: secretHash(input.taskToken), leaseVersion: input.leaseVersion,
      executorBindingGeneration: input.executorBindingGeneration,
      loginStateVersion: input.loginStateVersion, taskRequestHash: input.taskRequestHash,
      idempotencyKeyHash: hash(`shensi-desktop-outreach-${completionOperation}-idempotency`,
        input.idempotencyKey), now };
    try {
      if (input.event === "started") {
        if (this.options.platformExecutionAccess
          && !await this.options.platformExecutionAccess(principal.workspaceId, this.options.now())) {
          fail('desktop_outreach_completion_not_authorized');
        }
        const requestHash = hash("shensi-desktop-outreach-started-request",
          canonicalJsonStringify({ ...common, occurredAt: input.occurredAt,
            idempotencyKeyHash: undefined, now: undefined }));
        return await this.options.repository.markDesktopActionStarted({ ...common,
          requestHash, occurredAt: input.occurredAt });
      }
      const receiptHash = desktopOutreachReceiptHash({
        action_id: input.receipt.actionId, failure_code: input.receipt.failureCode,
        occurred_at: input.receipt.occurredAt,
        platform_receipt_reference: input.receipt.platformReceiptReference,
        state: input.receipt.state
      }).hash;
      const requestHash = hash(input.reconciliation
        ? "shensi-desktop-outreach-reconciliation-receipt-request"
        : "shensi-desktop-outreach-receipt-request",
        canonicalJsonStringify({ ...common, reconciliation: input.reconciliation,
          receipt: input.receipt, idempotencyKeyHash: undefined, now: undefined }));
      const classification = classifyOutreachActionReceipt({ executionTarget: "desktop",
        executionPhase: input.receipt.failureCode === "douyin_profile_busy"
          ? "started_pre_journal" : "started_post_journal",
        receiptState: input.receipt.state, failureCode: input.receipt.failureCode });
      if (input.reconciliation) {
        const reconciliationInput: DesktopOutreachReconciliationReceiptRepositoryInput = {
          ...common, requestHash, occurredAt: input.receipt.occurredAt,
          reconciliation: true,
          receipt: input.receipt as DesktopOutreachReconciliationReceiptRepositoryInput["receipt"],
          receiptHash, stateEffect: classification.stateEffect as
            DesktopOutreachReconciliationReceiptRepositoryInput["stateEffect"]
        };
        return await this.options.repository
          .completeDesktopReconciliation(reconciliationInput);
      }
      const receiptInput: DesktopOutreachReceiptRepositoryInput = { ...common,
        requestHash, occurredAt: input.receipt.occurredAt, reconciliation: false,
        receipt: input.receipt, receiptHash, stateEffect: classification.stateEffect };
      return await this.options.repository.completeDesktopAction(receiptInput);
    } catch (error) { sanitizeRepositoryFailure(error); }
  }
}
