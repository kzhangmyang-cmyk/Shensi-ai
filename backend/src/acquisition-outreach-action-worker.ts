import { outreachContentHash, validOutreachTarget,
  type AcquisitionOutreachAction } from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";

const CLOSED_FAILURES = new Set([
  "action_unavailable", "action_rejected", "deadline_exceeded",
  "douyin_verification_required", "douyin_rate_limited",
  "douyin_account_warning", "douyin_account_identity_changed",
  "douyin_login_expired",
  "douyin_direct_message_unavailable",
  "douyin_action_control_missing", "douyin_action_control_ambiguous",
  "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous",
  "douyin_action_timeout"
]);

const DEFAULT_MANUAL_VERIFICATION_SECONDS = 120;
const MIN_MANUAL_VERIFICATION_SECONDS = 30;
const MAX_MANUAL_VERIFICATION_SECONDS = 300;
const ACTION_DEADLINE_OVERHEAD_MS = 30_000;
const ACTION_LEASE_OVERHEAD_MS = 30_000;

class OutreachActionFenceLost extends Error {
  constructor() { super("outreach_action_fence_lost"); }
}

export function douyinActionDeadlineMs(
  value: unknown = process.env.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS
) {
  const configured = value ?? DEFAULT_MANUAL_VERIFICATION_SECONDS;
  const seconds = typeof configured === "number"
    ? configured
    : typeof configured === "string" && /^[0-9]+$/u.test(configured)
      ? Number(configured) : Number.NaN;
  if (!Number.isSafeInteger(seconds)
    || seconds < MIN_MANUAL_VERIFICATION_SECONDS
    || seconds > MAX_MANUAL_VERIFICATION_SECONDS) {
    throw new TypeError(
      "manual verification seconds must be an integer between 30 and 300"
    );
  }
  return seconds * 1_000 + ACTION_DEADLINE_OVERHEAD_MS;
}

export interface OutreachActionExecutionRequest {
  actionId: string;
  accountHandle: string;
  loginStateVersion: number;
  kind: "comment" | "direct_message";
  targetPublicUrl: string;
  content: string;
  approvedContentHash: string;
  deadlineAt: string;
}

export interface OutreachActionExecutionReceipt {
  actionId: string;
  state: "succeeded" | "failed";
  platformReceiptReference: string | null;
  occurredAt: string;
  failureCode: string | null;
}

export type OutreachActionAuthority =
  | { accountHandle: string }
  | { failureCode: "approval_authority_changed" };

export class AcquisitionOutreachActionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly actionDeadlineMs: number;
  private readonly leaseDurationMs: number;

  constructor(private readonly options: {
    repository: AcquisitionOutreachBatchRepository;
    workerId: string;
    now(): string;
    accountAuthority(action: AcquisitionOutreachAction): Promise<OutreachActionAuthority | null>;
    execute(input: OutreachActionExecutionRequest): Promise<OutreachActionExecutionReceipt>;
    pauseAccount(workspaceId: string, accountId: string,
      loginStateVersion: number, occurredAt: string): Promise<void>;
    leaseDurationMs?: number;
    actionDeadlineMs?: number;
    intervalMs?: number;
  }) {
    this.actionDeadlineMs = options.actionDeadlineMs ?? douyinActionDeadlineMs();
    if (!Number.isSafeInteger(this.actionDeadlineMs)
      || this.actionDeadlineMs <= 0) {
      throw new TypeError("action deadline must be a positive integer");
    }
    const minimumLeaseDurationMs = this.actionDeadlineMs + ACTION_LEASE_OVERHEAD_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? minimumLeaseDurationMs;
    if (!Number.isSafeInteger(minimumLeaseDurationMs)
      || !Number.isSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs < minimumLeaseDurationMs) {
      throw new TypeError(
        `action lease must be an integer of at least ${minimumLeaseDurationMs} milliseconds`
      );
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.closed) return false;
    const claimedAt = this.options.now();
    const claim = await this.options.repository.claimNextAction({
      workerId: this.options.workerId, now: claimedAt,
      leaseDurationMs: this.leaseDurationMs
    });
    if (!claim) return false;
    const action = claim.action;
    let failureCode: string | null = null;
    try {
      if (action.kind === "direct_message" && (action.authorizationVersion !== 2
        || typeof action.approvedBy !== "string" || !action.approvedBy
        || typeof action.approvedAt !== "string"
        || !Number.isFinite(Date.parse(action.approvedAt))
        || !Number.isSafeInteger(action.directMessageDailyLimit)
        || action.directMessageDailyLimit! < 1 || action.directMessageDailyLimit! > 100
        || !Number.isSafeInteger(action.directMessageDailyOrdinal)
        || action.directMessageDailyOrdinal! < 1
        || action.directMessageDailyOrdinal! > action.directMessageDailyLimit!)) {
        failureCode = "douyin_direct_message_unavailable";
      } else if (outreachContentHash(action.content) !== action.contentHash
        || !validOutreachTarget(action.kind, action.targetPublicUrl)) {
        failureCode = "action_rejected";
      }
      const authority = failureCode ? null : await this.options.accountAuthority(action);
      if (!failureCode) {
        if (!authority) failureCode = "douyin_login_expired";
        else if ("failureCode" in authority) failureCode = authority.failureCode;
        else if (!authority.accountHandle) failureCode = "douyin_login_expired";
      }
      if (failureCode) {
        const failureAt = new Date(Math.max(Date.parse(this.options.now()),
          Date.parse(claim.claimedAt))).toISOString();
        const result = await this.options.repository.completeActionFailure(
          claim.fence, failureCode, failureAt);
        if (!result.completed) throw new OutreachActionFenceLost();
        if (result.accountPaused) await this.options.pauseAccount(action.workspaceId, action.accountId,
          action.accountLoginStateVersion, failureAt);
        return true;
      }
      const started = Date.parse(claimedAt);
      const deadlineAt = new Date(started + this.actionDeadlineMs).toISOString();
      const receipt = await this.options.execute({
        actionId: action.id,
        accountHandle: authority && "accountHandle" in authority
          ? authority.accountHandle : "",
        loginStateVersion: action.accountLoginStateVersion, kind: action.kind,
        targetPublicUrl: action.targetPublicUrl, content: action.content,
        approvedContentHash: action.contentHash, deadlineAt
      });
      if (receipt.actionId !== action.id || !Number.isFinite(Date.parse(receipt.occurredAt))) {
        failureCode = "douyin_action_receipt_ambiguous";
      } else if (receipt.state === "succeeded") {
        if (!receipt.platformReceiptReference
          || receipt.platformReceiptReference.length > 255 || receipt.failureCode !== null) {
          failureCode = "douyin_action_receipt_ambiguous";
        } else {
          const completed = await this.options.repository.completeActionSuccess(claim.fence, {
            platformReceiptReference: receipt.platformReceiptReference,
            occurredAt: new Date(Math.max(Date.parse(this.options.now()),
              Date.parse(claim.claimedAt))).toISOString()
          });
          if (!completed) throw new OutreachActionFenceLost();
          return true;
        }
      } else {
        if (receipt.failureCode === "douyin_profile_busy") {
          const retryAt = new Date(Math.max(Date.parse(this.options.now()),
            Date.parse(claim.claimedAt))).toISOString();
          const released = await this.options.repository.completeActionRetry(
            claim.fence, "douyin_profile_busy", retryAt);
          if (!released) throw new OutreachActionFenceLost();
          return true;
        }
        failureCode = receipt.failureCode && CLOSED_FAILURES.has(receipt.failureCode)
          ? receipt.failureCode : "action_rejected";
      }
    } catch (error) {
      if (error instanceof OutreachActionFenceLost) throw error;
      failureCode = "action_unavailable";
    }
    const failureAt = new Date(Math.max(Date.parse(this.options.now()),
      Date.parse(claim.claimedAt))).toISOString();
    const result = await this.options.repository.completeActionFailure(
      claim.fence, failureCode ?? "action_rejected", failureAt);
    if (!result.completed) throw new OutreachActionFenceLost();
    if (result.accountPaused) await this.options.pauseAccount(action.workspaceId, action.accountId,
      action.accountLoginStateVersion, failureAt);
    return true;
  }

  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      this.running = this.running.then(() => this.runOnce()).catch(() => undefined);
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 1_000);
    this.timer.unref();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
