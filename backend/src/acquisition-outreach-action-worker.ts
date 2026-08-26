import { outreachContentHash, type AcquisitionOutreachAction } from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";

const CLOSED_FAILURES = new Set([
  "action_unavailable", "action_rejected", "deadline_exceeded",
  "douyin_verification_required", "douyin_rate_limited",
  "douyin_account_warning", "douyin_login_expired",
  "douyin_action_control_missing", "douyin_action_control_ambiguous",
  "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous",
  "douyin_action_timeout"
]);

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

function validTarget(action: AcquisitionOutreachAction) {
  try {
    const url = new URL(action.targetPublicUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.douyin.com"
      || url.port || url.search || url.hash) return false;
    return action.kind === "comment"
      ? /^\/video\/[A-Za-z0-9_-]{1,300}$/u.test(url.pathname)
      : /^\/user\/[A-Za-z0-9_-]{1,300}$/u.test(url.pathname);
  } catch { return false; }
}

export class AcquisitionOutreachActionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: {
    repository: AcquisitionOutreachBatchRepository;
    workerId: string;
    now(): string;
    accountAuthority(action: AcquisitionOutreachAction): Promise<{ accountHandle: string } | null>;
    execute(input: OutreachActionExecutionRequest): Promise<OutreachActionExecutionReceipt>;
    pauseAccount(workspaceId: string, accountId: string,
      loginStateVersion: number, occurredAt: string): Promise<void>;
    leaseDurationMs?: number;
    actionDeadlineMs?: number;
    intervalMs?: number;
  }) {}

  async runOnce(): Promise<boolean> {
    if (this.closed) return false;
    const claimedAt = this.options.now();
    const claim = await this.options.repository.claimNextAction({
      workerId: this.options.workerId, now: claimedAt,
      leaseDurationMs: this.options.leaseDurationMs ?? 30_000
    });
    if (!claim) return false;
    const action = claim.action;
    let failureCode: string | null = null;
    try {
      if (outreachContentHash(action.content) !== action.contentHash || !validTarget(action)) {
        failureCode = "action_rejected";
      }
      const authority = failureCode ? null : await this.options.accountAuthority(action);
      if (!failureCode && (!authority || !authority.accountHandle)) {
        failureCode = "douyin_login_expired";
      }
      if (failureCode) {
        const failureAt = new Date(Math.max(Date.parse(this.options.now()),
          Date.parse(claim.claimedAt))).toISOString();
        const result = await this.options.repository.completeActionFailure(
          claim.fence, failureCode, failureAt);
        if (result.accountPaused) await this.options.pauseAccount(action.workspaceId, action.accountId,
          action.accountLoginStateVersion, failureAt);
        return true;
      }
      const started = Date.parse(claimedAt);
      const deadlineAt = new Date(started + (this.options.actionDeadlineMs ?? 25_000)).toISOString();
      const receipt = await this.options.execute({
        actionId: action.id, accountHandle: authority!.accountHandle,
        loginStateVersion: action.accountLoginStateVersion, kind: action.kind,
        targetPublicUrl: action.targetPublicUrl, content: action.content,
        approvedContentHash: action.contentHash, deadlineAt
      });
      if (receipt.actionId !== action.id || !Number.isFinite(Date.parse(receipt.occurredAt))) {
        failureCode = "action_rejected";
      } else if (receipt.state === "succeeded") {
        if (!receipt.platformReceiptReference
          || receipt.platformReceiptReference.length > 255 || receipt.failureCode !== null) {
          failureCode = "action_rejected";
        } else {
          await this.options.repository.completeActionSuccess(claim.fence, {
            platformReceiptReference: receipt.platformReceiptReference,
            occurredAt: new Date(Math.max(Date.parse(this.options.now()),
              Date.parse(claim.claimedAt))).toISOString()
          });
          return true;
        }
      } else {
        failureCode = receipt.failureCode && CLOSED_FAILURES.has(receipt.failureCode)
          ? receipt.failureCode : "action_rejected";
      }
    } catch {
      failureCode = "action_unavailable";
    }
    const failureAt = new Date(Math.max(Date.parse(this.options.now()),
      Date.parse(claim.claimedAt))).toISOString();
    const result = await this.options.repository.completeActionFailure(
      claim.fence, failureCode ?? "action_rejected", failureAt);
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
