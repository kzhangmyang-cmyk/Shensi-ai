import { createHash, createHmac } from "node:crypto";
import type { PlatformExecutionAccess } from "./platform-execution-access.js";
import type {
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent,
  DouyinAutomationRunNowInput
} from "./acquisition-douyin-automation.js";
import type {
  AcquisitionDouyinAutomationScope
} from "./acquisition-douyin-automation-service.js";
import {
  assertNormalizedDouyinRecord,
  desktopCrawlerRequestHash,
  hashDesktopCrawlerCapability,
  type AcquisitionCrawlerActivity,
  type AcquisitionCrawlerJob,
  type AcquisitionCrawlerJobFence,
  type NormalizedDouyinRecord
} from "./acquisition-crawler-job.js";
import type {
  AcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-repository.js";
import type {
  AcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";
import { isBoundDouyinAccountHandle } from "./acquisition-social-account-service.js";

export interface AcquisitionDesktopSyncScope
extends AcquisitionDouyinAutomationScope {}

export interface DesktopCrawlerPageInput {
  leaseVersion: number;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  records: NormalizedDouyinRecord[];
  terminal?: {
    state: "succeeded" | "partial";
    failureCode: "crawl_interrupted_after_partial_results" | null;
    activity: AcquisitionCrawlerActivity;
  };
}

export interface AcquisitionDesktopSyncServiceOptions {
  executionAccess?: PlatformExecutionAccess;
  automation: {
    runNowDesktop(
      scope: AcquisitionDouyinAutomationScope,
      planId: string,
      idempotencyKey: string,
      input: DouyinAutomationRunNowInput
    ): Promise<{
      value: DouyinAutomationRunIntent;
      policy: DouyinAutomationPolicyVersion;
      replayed: boolean;
    }>;
  };
  crawlerJobs: AcquisitionCrawlerJobRepository;
  accounts: Pick<AcquisitionSocialAccountRepository, "findById">;
  taskTokenSecret: string;
  now?: () => string;
  leaseDurationMs?: number;
  ingestTerminalJob: (
    job: AcquisitionCrawlerJob,
    scope: AcquisitionDesktopSyncScope
  ) => Promise<void>;
  projectTerminalJob?: (
    job: AcquisitionCrawlerJob,
    scope: AcquisitionDesktopSyncScope
  ) => Promise<void>;
}

export class AcquisitionDesktopSyncError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "AcquisitionDesktopSyncError";
  }
}

function fail(status: number, code: string): never {
  throw new AcquisitionDesktopSyncError(status, code);
}

function boundedString(value: unknown, minimum: number, maximum: number,
  code: string): asserts value is string {
  if (typeof value !== "string" || value.length < minimum
    || value.length > maximum) fail(400, code);
}

function assertExactKeys(value: unknown, keys: readonly string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    fail(400, code);
  }
}

function milliseconds(value: string, code: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(500, code);
  return parsed;
}

function deterministicJobId(workspaceId: string, runId: string) {
  return `desktop-crawler-${createHash("sha256")
    .update(`${workspaceId}\u0000${runId}`, "utf8")
    .digest("hex").slice(0, 40)}`;
}

function taskToken(secret: string, workspaceId: string, jobId: string) {
  return createHmac("sha256", secret)
    .update(`desktop-crawler-capability\u0000${workspaceId}\u0000${jobId}`, "utf8")
    .digest("base64url");
}

function idempotencyKeyHash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function workerId(jobId: string) {
  return `desktop-${createHash("sha256").update(jobId, "utf8")
    .digest("hex").slice(0, 40)}`;
}

function publicJob(job: AcquisitionCrawlerJob) {
  return Object.freeze({
    jobId: job.id,
    runId: job.runId,
    state: job.state,
    leaseVersion: job.fencingToken,
    leaseExpiresAt: job.leaseExpiresAt,
    cursor: job.cursor,
    recordCount: job.recordCount,
    ingestionState: job.ingestionState,
    cloudDurable: job.ingestionState === "succeeded",
    acknowledgedAt: job.acknowledgedAt,
    activity: Object.freeze({ ...job.activity })
  });
}

export class AcquisitionDesktopSyncService {
  private readonly executionAccess: PlatformExecutionAccess;
  private readonly automation: AcquisitionDesktopSyncServiceOptions["automation"];
  private readonly crawlerJobs: AcquisitionCrawlerJobRepository;
  private readonly accounts: AcquisitionDesktopSyncServiceOptions["accounts"];
  private readonly secret: string;
  private readonly now: () => string;
  private readonly leaseDurationMs: number;
  private readonly ingestTerminalJob: AcquisitionDesktopSyncServiceOptions["ingestTerminalJob"];
  private readonly projectTerminalJob: AcquisitionDesktopSyncServiceOptions["projectTerminalJob"];

  constructor(options: AcquisitionDesktopSyncServiceOptions) {
    this.executionAccess = options.executionAccess ?? (async () => true);
    boundedString(options.taskTokenSecret, 32, 512,
      "invalid_desktop_task_token_secret");
    if (!Number.isSafeInteger(options.leaseDurationMs ?? 30_000)
      || (options.leaseDurationMs ?? 30_000) < 1
      || (options.leaseDurationMs ?? 30_000) > 300_000) {
      throw new TypeError("invalid_desktop_crawler_lease_duration");
    }
    this.automation = options.automation;
    this.crawlerJobs = options.crawlerJobs;
    this.accounts = options.accounts;
    this.secret = options.taskTokenSecret;
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.ingestTerminalJob = options.ingestTerminalJob;
    this.projectTerminalJob = options.projectTerminalJob;
  }

  private capability(workspaceId: string, jobId: string, provided?: string) {
    const token = provided ?? taskToken(this.secret, workspaceId, jobId);
    boundedString(token, 32, 512, "invalid_desktop_task_token");
    return { token, hash: hashDesktopCrawlerCapability(token) };
  }

  private fence(jobId: string, tokenHash: string,
    fencingToken: number): AcquisitionCrawlerJobFence {
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      fail(409, "stale_desktop_crawler_lease");
    }
    return {
      jobId,
      workerId: workerId(jobId),
      leaseToken: tokenHash.slice("sha256:".length),
      fencingToken
    };
  }

  private async assertAccountAuthority(job: AcquisitionCrawlerJob) {
    const account = await this.accounts.findById(job.workspaceId, job.accountId);
    if (!account || account.workspaceId !== job.workspaceId
      || account.id !== job.accountId || account.platform !== "douyin"
      || account.state !== "active"
      || !isBoundDouyinAccountHandle(account.accountHandle)
      || account.loginStateVersion !== job.accountLoginStateVersion) {
      fail(409, "desktop_crawler_account_binding_changed");
    }
  }

  private async job(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string) {
    boundedString(jobId, 1, 255, "invalid_desktop_crawler_job_id");
    const capability = this.capability(scope.workspaceId, jobId, providedToken);
    const job = await this.crawlerJobs.findById(scope.workspaceId, jobId);
    if (!job || job.executionTarget !== "desktop") {
      fail(404, "desktop_crawler_job_not_found");
    }
    if (job.desktopTaskTokenHash !== capability.hash) {
      fail(403, "desktop_crawler_capability_mismatch");
    }
    return { job, capability };
  }

  async prepareRun(scope: AcquisitionDesktopSyncScope, planId: string,
    idempotencyKey: string, input: DouyinAutomationRunNowInput) {
    await this.assertExecutionAccess(scope.workspaceId);
    boundedString(idempotencyKey?.trim(), 8, 200, "invalid_idempotency_key");
    const result = await this.automation.runNowDesktop(
      scope, planId, idempotencyKey.trim(), input
    );
    const { value: run, policy } = result;
    if (run.workspaceId !== scope.workspaceId
      || run.planId !== planId
      || run.policyVersionId !== policy.id
      || run.policyHash !== policy.policyHash
      || run.accountId !== policy.accountId
      || run.accountLoginStateVersion !== policy.accountLoginStateVersion) {
      fail(409, "desktop_automation_binding_conflict");
    }
    const jobId = deterministicJobId(scope.workspaceId, run.acquisitionRunId);
    const capability = this.capability(scope.workspaceId, jobId);
    const created = await this.crawlerJobs.createOrGet({
      id: jobId,
      workspaceId: run.workspaceId,
      runId: run.acquisitionRunId,
      automationIntentId: run.id,
      planId: run.planId,
      planVersionId: run.planVersionId,
      planSnapshotHash: run.planSnapshotHash,
      policyVersionId: run.policyVersionId,
      policyHash: run.policyHash,
      accountId: run.accountId,
      accountLoginStateVersion: run.accountLoginStateVersion,
      dailyBudgetId: run.dailyBudgetId,
      localDate: run.localDate,
      trigger: run.trigger,
      dailyCandidateLimit: policy.dailyCandidateLimit,
      keywords: [...policy.keywords],
      collectCreators: run.collectCreators,
      collectDemandComments: run.collectDemandComments,
      limits: { ...policy.limits },
      createdAt: run.createdAt,
      maxAttempts: 1,
      executionTarget: "desktop",
      desktopTaskTokenHash: capability.hash
    });
    if (created.job.id !== jobId
      || created.job.executionTarget !== "desktop"
      || created.job.desktopTaskTokenHash !== capability.hash) {
      fail(409, "desktop_crawler_job_binding_conflict");
    }
    await this.assertAccountAuthority(created.job);
    const queued = await this.crawlerJobs.enqueue(
      run.workspaceId, run.acquisitionRunId, this.now()
    );
    if (!queued || queued.id !== jobId) {
      fail(409, "desktop_crawler_job_binding_conflict");
    }
    const deadlineAt = new Date(
      milliseconds(run.createdAt, "invalid_desktop_run_clock")
        + policy.limits.maxDurationSeconds * 1_000
    ).toISOString();
    return Object.freeze({
      run,
      taskToken: capability.token,
      task: Object.freeze({
        taskId: jobId,
        loginStateVersion: run.accountLoginStateVersion,
        keywords: [...policy.keywords],
        maxVideos: policy.limits.maxVideos,
        ...(policy.limits.maxComments === undefined ? {} : { maxComments: policy.limits.maxComments }),
        maxCommentsPerVideo: policy.limits.maxCommentsPerVideo,
        maxPagesPerVideo: policy.limits.maxPagesPerVideo,
        collectCreators: run.collectCreators,
        collectDemandComments: run.collectDemandComments,
        deadlineAt
      })
    });
  }

  async claim(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string) {
    const current = await this.job(scope, jobId, providedToken);
    await this.assertAccountAuthority(current.job);
    await this.assertExecutionAccess(scope.workspaceId);
    const claim = await this.crawlerJobs.claimDesktop(
      scope.workspaceId,
      jobId,
      current.capability.hash,
      workerId(jobId),
      this.now(),
      this.leaseDurationMs
    );
    return publicJob(claim.job);
  }

  async renew(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string, leaseVersion: number) {
    const current = await this.job(scope, jobId, providedToken);
    await this.assertAccountAuthority(current.job);
    await this.assertExecutionAccess(scope.workspaceId);
    return publicJob(await this.crawlerJobs.renew(
      this.fence(jobId, current.capability.hash, leaseVersion),
      this.now(),
      this.leaseDurationMs
    ));
  }

  private async assertExecutionAccess(workspaceId: string) {
    if (!await this.executionAccess(workspaceId, this.now()).catch(() => false)) {
      fail(403, "crawler_execution_forbidden");
    }
  }

  private assertPage(input: DesktopCrawlerPageInput) {
    assertExactKeys(input, ["leaseVersion", "cursor", "nextCursor", "done",
      "records", ...(input.terminal === undefined ? [] : ["terminal"])],
    "invalid_desktop_crawler_page");
    if (!Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1
      || (input.cursor !== null && typeof input.cursor !== "string")
      || (input.nextCursor !== null && typeof input.nextCursor !== "string")
      || typeof input.done !== "boolean" || !Array.isArray(input.records)
      || input.records.length > 200
      || (input.done !== (input.terminal !== undefined))) {
      fail(400, "invalid_desktop_crawler_page");
    }
    input.records.forEach(assertNormalizedDouyinRecord);
    if (!input.terminal) return;
    assertExactKeys(input.terminal, ["state", "failureCode", "activity"],
      "invalid_desktop_crawler_terminal");
    const { state, failureCode, activity } = input.terminal;
    if (!activity || activity.phase !== "completed"
      || activity.currentKeyword !== null
      || activity.browserMode !== "visible"
      || !Number.isSafeInteger(activity.sequence) || activity.sequence < 0
      || !["succeeded", "partial"].includes(state)
      || (state === "succeeded" && failureCode !== null)
      || (state === "partial"
        && failureCode !== "crawl_interrupted_after_partial_results")) {
      fail(400, "invalid_desktop_crawler_terminal");
    }
  }

  async uploadPage(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string, idempotencyKey: string,
    input: DesktopCrawlerPageInput) {
    boundedString(idempotencyKey?.trim(), 8, 200, "invalid_idempotency_key");
    this.assertPage(input);
    const current = await this.job(scope, jobId, providedToken);
    await this.assertAccountAuthority(current.job);
    const terminal = input.terminal;
    const page = {
      expectedCursor: input.cursor,
      nextCursor: input.nextCursor,
      records: input.records,
      done: input.done,
      ...(terminal ? {
        terminalState: terminal.state,
        terminalErrorCode: terminal.failureCode,
        terminalActivity: terminal.activity
      } : {})
    };
    const persisted = await this.crawlerJobs.persistDesktopPage(
      this.fence(jobId, current.capability.hash, input.leaseVersion),
      {
        ...page,
        now: this.now(),
        idempotencyKeyHash: idempotencyKeyHash(idempotencyKey.trim()),
        requestHash: desktopCrawlerRequestHash(page)
      }
    );
    return Object.freeze({ ...publicJob(persisted.job), replayed: persisted.replayed });
  }

  async complete(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string) {
    const current = await this.job(scope, jobId, providedToken);
    await this.assertAccountAuthority(current.job);
    if (current.job.ingestionState === "succeeded") {
      return publicJob(current.job);
    }
    const claim = await this.crawlerJobs.claimDesktopIngestion(
      scope.workspaceId,
      jobId,
      current.capability.hash,
      workerId(jobId),
      this.now(),
      this.leaseDurationMs
    );
    if (!claim) {
      const durable = await this.crawlerJobs.findById(scope.workspaceId, jobId);
      if (durable?.ingestionState === "succeeded") return publicJob(durable);
      fail(409, "desktop_crawler_job_not_completable");
    }
    const durableAt = this.now();
    let renewal: Promise<AcquisitionCrawlerJob> | null = null;
    let leaseFailure: unknown = null;
    const renewIngestionLease = () => {
      if (renewal) return renewal;
      const pending = this.crawlerJobs.renewIngestion(
        claim.fence, this.now(), this.leaseDurationMs
      );
      renewal = pending;
      void pending.then(
        () => {
          if (renewal === pending) renewal = null;
        },
        (error) => {
          leaseFailure ??= error;
          if (renewal === pending) renewal = null;
        }
      );
      return pending;
    };
    const ensureCurrentGeneration = async () => {
      if (leaseFailure) throw leaseFailure;
      const persisted = await renewIngestionLease();
      if (leaseFailure) throw leaseFailure;
      if (persisted.aliasGeneration !== claim.fence.aliasGeneration) {
        await this.crawlerJobs.deferIngestionForAliasChange(
          claim.fence, this.now()
        );
        return false;
      }
      return true;
    };
    const heartbeat = setInterval(() => {
      if (!leaseFailure) void renewIngestionLease();
    }, Math.max(1, Math.floor(this.leaseDurationMs / 3)));
    heartbeat.unref();
    try {
      await this.ingestTerminalJob(claim.job, scope);
      if (!await ensureCurrentGeneration()) {
        fail(409, "desktop_crawler_alias_generation_changed");
      }
      clearInterval(heartbeat);
      return publicJob(await this.crawlerJobs.completeDesktopIngestion(
        claim.fence, durableAt, this.now()
      ));
    } catch (error) {
      if (error instanceof AcquisitionDesktopSyncError) throw error;
      await this.crawlerJobs.failIngestion(
        claim.fence, "crawler_ingestion_failed", this.now()
      ).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
      const pendingRenewal = renewal as Promise<AcquisitionCrawlerJob> | null;
      if (pendingRenewal) await pendingRenewal.catch(() => undefined);
    }
  }

  async cancel(scope: AcquisitionDesktopSyncScope, jobId: string,
    providedToken: string, leaseVersion: number) {
    const current = await this.job(scope, jobId, providedToken);
    if (!Number.isSafeInteger(leaseVersion) || leaseVersion < 0) {
      fail(409, "stale_desktop_crawler_lease");
    }
    const cancelled = await this.crawlerJobs.cancelDesktop(
      scope.workspaceId,
      jobId,
      current.capability.hash,
      leaseVersion,
      this.now()
    );
    await this.projectTerminalJob?.(cancelled, scope);
    return publicJob(cancelled);
  }
}
