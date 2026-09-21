import { randomBytes } from "node:crypto";
import {
  assertAcquisitionCrawlerActivity,
  assertAcquisitionCrawlerActivityForKeywords,
  assertCrawlerActivityObserved,
  assertCrawlerJobInput,
  assertTerminalCrawlerActivity,
  clearAcquisitionCrawlerIngestionErrorCode,
  defaultAcquisitionCrawlerActivity,
  normalizeAcquisitionCrawlerStoredErrorCode,
  assertNormalizedDouyinRecord,
  type AcquisitionCrawlerJob,
  type AcquisitionCrawlerJobClaim,
  type AcquisitionCrawlerJobFence,
  type AcquisitionCrawlerIngestionClaim,
  type AcquisitionCrawlerIngestionFence,
  type AcquisitionCrawlerJobInput,
  type NormalizedDouyinRecord,
  type PersistedNormalizedDouyinRecord
} from "./acquisition-crawler-job.js";

export interface PersistCrawlerPageInput {
  expectedCursor: string | null;
  nextCursor: string | null;
  records: NormalizedDouyinRecord[];
  done: boolean;
  terminalState?: "succeeded" | "partial";
  terminalErrorCode?: string | null;
  terminalActivity?: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity;
  now: string;
}

export interface PersistDesktopCrawlerPageInput extends PersistCrawlerPageInput {
  idempotencyKeyHash: string;
  requestHash: string;
}

export interface PersistDesktopCrawlerPageResult {
  job: AcquisitionCrawlerJob;
  replayed: boolean;
}

export interface AcquisitionCrawlerJobRepository {
  createOrGet(input: AcquisitionCrawlerJobInput): Promise<{ created: boolean; job: AcquisitionCrawlerJob }>;
  enqueue(workspaceId: string, runId: string, now: string): Promise<AcquisitionCrawlerJob | null>;
  findByRun(workspaceId: string, runId: string): Promise<AcquisitionCrawlerJob | null>;
  findById(workspaceId: string, jobId: string): Promise<AcquisitionCrawlerJob | null>;
  claimNext(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string): Promise<AcquisitionCrawlerJobClaim | null>;
  claimDesktop(workspaceId: string, jobId: string, taskTokenHash: string,
    workerId: string, now: string, leaseDurationMs: number): Promise<AcquisitionCrawlerJobClaim>;
  renew(fence: AcquisitionCrawlerJobFence, now: string, leaseDurationMs: number): Promise<AcquisitionCrawlerJob>;
  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput): Promise<AcquisitionCrawlerJob>;
  persistDesktopPage(fence: AcquisitionCrawlerJobFence,
    input: PersistDesktopCrawlerPageInput): Promise<PersistDesktopCrawlerPageResult>;
  updateActivity(fence: AcquisitionCrawlerJobFence, input: {
    activity: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity;
    now: string;
  }): Promise<AcquisitionCrawlerJob>;
  listRecords(jobId: string): Promise<PersistedNormalizedDouyinRecord[]>;
  requestCancel(workspaceId: string, runId: string, now: string): Promise<AcquisitionCrawlerJob | null>;
  completeCancelled(fence: AcquisitionCrawlerJobFence, now: string): Promise<AcquisitionCrawlerJob>;
  pause(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string): Promise<AcquisitionCrawlerJob>;
  fail(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string, retryable: boolean): Promise<AcquisitionCrawlerJob>;
  claimNextIngestion(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string): Promise<AcquisitionCrawlerIngestionClaim | null>;
  claimDesktopIngestion(workspaceId: string, jobId: string, taskTokenHash: string,
    workerId: string, now: string, leaseDurationMs: number): Promise<AcquisitionCrawlerIngestionClaim | null>;
  renewIngestion(fence: AcquisitionCrawlerIngestionFence, now: string, leaseDurationMs: number): Promise<AcquisitionCrawlerJob>;
  deferIngestionForAliasChange(fence: AcquisitionCrawlerIngestionFence, now: string): Promise<AcquisitionCrawlerJob>;
  completeIngestion(fence: AcquisitionCrawlerIngestionFence, ingestedAt: string, acknowledgedAt: string, now: string): Promise<AcquisitionCrawlerJob>;
  completeDesktopIngestion(fence: AcquisitionCrawlerIngestionFence,
    ingestedAt: string, now: string): Promise<AcquisitionCrawlerJob>;
  failIngestion(fence: AcquisitionCrawlerIngestionFence, errorCode: string, now: string): Promise<AcquisitionCrawlerJob>;
  cancelDesktop(workspaceId: string, jobId: string, taskTokenHash: string,
    fencingToken: number, now: string): Promise<AcquisitionCrawlerJob>;
  sweepExpired(now: string): Promise<number>;
}

interface State {
  jobs: Map<string, AcquisitionCrawlerJob>;
  daily: Map<string, string>;
  runs: Map<string, string>;
  intents: Map<string, string>;
  pairs: Map<string, string>;
  records: Map<string, PersistedNormalizedDouyinRecord[]>;
  desktopPageReplays: Map<string, {
    requestHash: string;
    job: AcquisitionCrawlerJob;
  }>;
}

function clone<T>(value: T): T { return structuredClone(value); }
function milliseconds(value: string, code = "invalid_crawler_clock") {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(code);
  return parsed;
}
function dailyKey(value: Pick<AcquisitionCrawlerJobInput,
  "workspaceId" | "planId" | "policyVersionId" | "localDate" | "executionTarget">) {
  return `${value.workspaceId}\u0000${value.planId}\u0000${value.policyVersionId}\u0000${value.localDate}\u0000${value.executionTarget ?? "server"}`;
}
function runKey(workspaceId: string, runId: string) { return `${workspaceId}\u0000${runId}`; }
function aliasPairKey(workspaceId: string, runId: string, automationIntentId: string) {
  return `${workspaceId}\u0000${runId}\u0000${automationIntentId}`;
}
function desktopLeaseToken(taskTokenHash: string) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(taskTokenHash)) {
    throw new TypeError("invalid_desktop_crawler_capability");
  }
  return taskTokenHash.slice("sha256:".length);
}
function ingestionAttemptLimit(job: AcquisitionCrawlerJob) {
  return job.executionTarget === "desktop" ? 3 : job.maxAttempts;
}
function clearLease(job: AcquisitionCrawlerJob) {
  job.leaseWorkerId = null; job.leaseToken = null; job.leaseExpiresAt = null;
}
function clearIngestionLease(job: AcquisitionCrawlerJob) {
  job.ingestionLeaseWorkerId = null;
  job.ingestionLeaseToken = null;
  job.ingestionLeaseExpiresAt = null;
}
function sameActivity(
  left: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity,
  right: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity
) {
  return left.phase === right.phase
    && left.currentKeyword === right.currentKeyword
    && left.browserMode === right.browserMode;
}
function applyActivity(
  job: AcquisitionCrawlerJob,
  activity: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity,
  now: string
) {
  assertAcquisitionCrawlerActivityForKeywords(job.activity, job.keywords);
  assertCrawlerActivityObserved(job.activityObserved);
  assertAcquisitionCrawlerActivityForKeywords(activity, job.keywords);
  if (!job.activityObserved) {
    job.activity = structuredClone(activity);
    job.activityObserved = true;
    job.updatedAt = now;
    return;
  }
  if (activity.sequence < job.activity.sequence) {
    throw new Error("crawler_activity_sequence_regressed");
  }
  if (activity.sequence === job.activity.sequence) {
    if (!sameActivity(activity, job.activity)) {
      throw new Error("crawler_activity_sequence_conflict");
    }
    return;
  }
  if (sameActivity(activity, job.activity)) {
    throw new Error("crawler_activity_sequence_without_change");
  }
  job.activity = structuredClone(activity);
  job.updatedAt = now;
}

export class InMemoryAcquisitionCrawlerJobRepository implements AcquisitionCrawlerJobRepository {
  private state: State = {
    jobs: new Map(), daily: new Map(), runs: new Map(), intents: new Map(),
    pairs: new Map(), records: new Map(), desktopPageReplays: new Map()
  };
  private tail: Promise<void> = Promise.resolve();

  private transaction<T>(work: (state: State) => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const state = clone(this.state);
      const value = await work(state);
      this.state = state;
      return clone(value);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async snapshot() { await this.tail; return clone(this.state); }

  createOrGet(input: AcquisitionCrawlerJobInput) {
    assertCrawlerJobInput(input);
    return this.transaction((state) => {
      const identity = dailyKey(input);
      const existingId = state.daily.get(identity);
      if (existingId) {
        const mappedId = state.runs.get(runKey(input.workspaceId, input.runId));
        const intentMappedId = state.intents.get(runKey(
          input.workspaceId,
          input.automationIntentId
        ));
        const pairId = state.pairs.get(aliasPairKey(
          input.workspaceId,
          input.runId,
          input.automationIntentId
        ));
        if ((mappedId && mappedId !== existingId)
          || (intentMappedId && intentMappedId !== existingId)
          || (pairId && pairId !== existingId)) {
          throw new Error("crawler_job_identity_conflict");
        }
        const existing = state.jobs.get(existingId)!;
        if (existing.planVersionId !== input.planVersionId
          || existing.planSnapshotHash !== input.planSnapshotHash
          || existing.policyHash !== input.policyHash
          || existing.accountId !== input.accountId
          || existing.accountLoginStateVersion
            !== input.accountLoginStateVersion
          || existing.dailyBudgetId !== input.dailyBudgetId
          || existing.executionTarget !== (input.executionTarget ?? "server")
          || existing.desktopTaskTokenHash !== (input.desktopTaskTokenHash ?? null)) {
          throw new Error("crawler_job_binding_conflict");
        }
        const exactReplay = mappedId === existingId
          && intentMappedId === existingId
          && pairId === existingId
          && existing.runIds.includes(input.runId)
          && existing.automationIntentIds.includes(input.automationIntentId);
        if (exactReplay) return { created: false, job: existing };
        if (mappedId || intentMappedId || pairId
          || existing.runIds.includes(input.runId)
          || existing.automationIntentIds.includes(input.automationIntentId)) {
          throw new Error("crawler_job_identity_conflict");
        }
        existing.runIds.push(input.runId);
        existing.automationIntentIds.push(input.automationIntentId);
        existing.aliasGeneration += 1;
        existing.ingestionAttempt = 0;
        if (existing.ingestionState !== "running"
          && ["succeeded", "partial"].includes(existing.state)) {
          existing.ingestionState = "pending";
        }
        state.runs.set(runKey(input.workspaceId, input.runId), existing.id);
        state.intents.set(
          runKey(input.workspaceId, input.automationIntentId),
          existing.id
        );
        state.pairs.set(aliasPairKey(
          input.workspaceId,
          input.runId,
          input.automationIntentId
        ), existing.id);
        return { created: false, job: existing };
      }
      if (state.jobs.has(input.id)
        || state.runs.has(runKey(input.workspaceId, input.runId))
        || state.intents.has(runKey(input.workspaceId, input.automationIntentId))
        || state.pairs.has(aliasPairKey(
          input.workspaceId,
          input.runId,
          input.automationIntentId
        ))) {
        throw new Error("crawler_job_identity_conflict");
      }
      const job: AcquisitionCrawlerJob = {
        ...clone(input), executionTarget: input.executionTarget ?? "server",
        desktopTaskTokenHash: input.desktopTaskTokenHash ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        state: "scheduled", runIds: [input.runId],
        automationIntentIds: [input.automationIntentId], attempt: 0, cursor: null,
        cursorHistory: [],
        recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: null, cancelRequestedAt: null,
        lastErrorCode: null, leaseWorkerId: null, leaseToken: null,
        leaseExpiresAt: null, fencingToken: 0, updatedAt: input.createdAt,
        completedAt: null, ingestionState: null, ingestionAttempt: 0,
        ingestionLeaseWorkerId: null, ingestionLeaseToken: null,
        ingestionLeaseExpiresAt: null, ingestionFencingToken: 0,
        aliasGeneration: 1, projectedAliasGeneration: 0,
        ingestedAt: null, acknowledgedAt: null,
        activity: structuredClone(defaultAcquisitionCrawlerActivity),
        activityObserved: false
      };
      state.jobs.set(job.id, job); state.daily.set(identity, job.id);
      state.runs.set(runKey(job.workspaceId, job.runId), job.id);
      state.intents.set(
        runKey(job.workspaceId, job.automationIntentId),
        job.id
      );
      state.pairs.set(aliasPairKey(
        job.workspaceId,
        job.runId,
        job.automationIntentId
      ), job.id);
      state.records.set(job.id, []);
      return { created: true, job };
    });
  }

  enqueue(workspaceId: string, runId: string, now: string) {
    milliseconds(now);
    return this.transaction((state) => {
      const id = state.runs.get(runKey(workspaceId, runId));
      const job = id ? state.jobs.get(id) : null;
      if (!job) return null;
      if (job.state === "scheduled") {
        job.state = "queued";
        job.updatedAt = now;
      }
      return job;
    });
  }

  async findByRun(workspaceId: string, runId: string) {
    const state = await this.snapshot();
    const id = state.runs.get(runKey(workspaceId, runId));
    return id ? state.jobs.get(id) ?? null : null;
  }

  async findById(workspaceId: string, jobId: string) {
    const job = (await this.snapshot()).jobs.get(jobId) ?? null;
    return job?.workspaceId === workspaceId ? job : null;
  }

  claimNext(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string) {
    const at = milliseconds(now);
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_lease");
    }
    return this.transaction<AcquisitionCrawlerJobClaim | null>((state) => {
      const job = [...state.jobs.values()].filter((value) =>
        value.state === "queued" && value.executionTarget === "server")
        .sort((left, right) => {
          const workspacePreference = Number(left.workspaceId === avoidWorkspaceId)
            - Number(right.workspaceId === avoidWorkspaceId);
          return workspacePreference || left.createdAt.localeCompare(right.createdAt)
            || left.id.localeCompare(right.id);
        })[0];
      if (!job) return null;
      job.state = "running"; job.attempt += 1; job.fencingToken += 1;
      job.leaseWorkerId = workerId; job.leaseToken = randomBytes(32).toString("hex");
      job.leaseExpiresAt = new Date(at + leaseDurationMs).toISOString(); job.updatedAt = now;
      return { job, fence: { jobId: job.id, workerId, leaseToken: job.leaseToken, fencingToken: job.fencingToken } };
    });
  }

  claimDesktop(workspaceId: string, jobId: string, taskTokenHash: string,
    workerId: string, now: string, leaseDurationMs: number) {
    const instant = milliseconds(now);
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_lease");
    }
    const leaseToken = desktopLeaseToken(taskTokenHash);
    return this.transaction<AcquisitionCrawlerJobClaim>((state) => {
      const job = state.jobs.get(jobId);
      if (!job || job.workspaceId !== workspaceId || job.executionTarget !== "desktop") {
        throw new Error("desktop_crawler_job_not_found");
      }
      if (job.desktopTaskTokenHash !== taskTokenHash) {
        throw new Error("desktop_crawler_capability_mismatch");
      }
      if (job.state === "running" && job.leaseWorkerId === workerId
        && job.leaseToken === leaseToken && job.leaseExpiresAt
        && instant < milliseconds(job.leaseExpiresAt)) {
        return { job, fence: { jobId, workerId, leaseToken,
          fencingToken: job.fencingToken } };
      }
      if (job.state !== "queued" || job.attempt >= 1) {
        throw new Error("desktop_crawler_job_not_claimable");
      }
      job.state = "running";
      job.attempt = 1;
      job.fencingToken += 1;
      job.leaseWorkerId = workerId;
      job.leaseToken = leaseToken;
      job.leaseExpiresAt = new Date(instant + leaseDurationMs).toISOString();
      job.updatedAt = now;
      return { job, fence: { jobId, workerId, leaseToken,
        fencingToken: job.fencingToken } };
    });
  }

  private fenced(state: State, fence: AcquisitionCrawlerJobFence, now: string) {
    const job = state.jobs.get(fence.jobId);
    if (!job || job.state !== "running" || job.leaseWorkerId !== fence.workerId
      || job.leaseToken !== fence.leaseToken || job.fencingToken !== fence.fencingToken
      || !job.leaseExpiresAt || milliseconds(now) >= milliseconds(job.leaseExpiresAt)) {
      throw new Error("stale_crawler_job_fence");
    }
    return job;
  }

  renew(fence: AcquisitionCrawlerJobFence, now: string, leaseDurationMs: number) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) throw new TypeError("invalid_crawler_lease");
    return this.transaction((state) => {
      const job = this.fenced(state, fence, now);
      job.leaseExpiresAt = new Date(milliseconds(now) + leaseDurationMs).toISOString();
      job.updatedAt = now; return job;
    });
  }

  updateActivity(fence: AcquisitionCrawlerJobFence, input: {
    activity: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity;
    now: string;
  }) {
    milliseconds(input.now);
    assertAcquisitionCrawlerActivity(input.activity);
    return this.transaction((state) => {
      const job = this.fenced(state, fence, input.now);
      applyActivity(job, input.activity, input.now);
      return job;
    });
  }

  private persistPageInState(
    state: State,
    job: AcquisitionCrawlerJob,
    input: PersistCrawlerPageInput
  ) {
    if (job.cancelRequestedAt) throw new Error("crawler_job_cancelled");
    if (job.cursor !== input.expectedCursor) throw new Error("crawler_cursor_conflict");
    if (input.records.length > 200) throw new TypeError("crawler_page_record_limit_exceeded");
    if ((input.done && input.nextCursor !== null)
      || (!input.done && (!input.nextCursor || input.nextCursor === input.expectedCursor))
      || (input.nextCursor !== null && Buffer.byteLength(input.nextCursor, "utf8") > 512)) {
      throw new TypeError("invalid_crawler_next_cursor");
    }
    const hasTerminalMetadata = input.terminalState !== undefined
      || input.terminalErrorCode !== undefined
      || input.terminalActivity !== undefined;
    if ((!input.done && hasTerminalMetadata)
      || (input.terminalState !== undefined
        && !["succeeded", "partial"].includes(input.terminalState))
      || (input.terminalErrorCode !== undefined
        && input.terminalErrorCode !== null
        && input.terminalErrorCode !== "crawl_interrupted_after_partial_results")
      || (input.terminalState === "partial"
        && input.terminalErrorCode !== "crawl_interrupted_after_partial_results")
      || (input.done && input.terminalState !== "partial"
        && input.terminalErrorCode != null)) {
      throw new TypeError("invalid_crawler_terminal_metadata");
    }
    if (input.done) assertTerminalCrawlerActivity(input.terminalActivity);
    if (input.nextCursor !== null && job.cursorHistory.includes(input.nextCursor)) {
      throw new Error("crawler_cursor_cycle");
    }
    input.records.forEach(assertNormalizedDouyinRecord);
    const stored = state.records.get(job.id)!;
    const identities = new Set(stored.map((record) => record.recordId));
    job.candidateBudgetLimit = null;
    for (const record of input.records) {
      if ((record.kind === "creator" && !job.collectCreators)
        || (record.kind === "comment" && !job.collectDemandComments)) continue;
      const candidate = record.kind !== "video";
      if (identities.has(record.recordId)) continue;
      stored.push({ ...clone(record), pageCursor: input.expectedCursor });
      identities.add(record.recordId);
      job.recordCount += 1;
      if (candidate) job.candidateBudgetUsed += 1;
    }
    job.cursor = input.nextCursor;
    if (input.nextCursor !== null) job.cursorHistory.push(input.nextCursor);
    job.updatedAt = input.now;
    if (input.done) {
      assertTerminalCrawlerActivity(input.terminalActivity);
      applyActivity(job, input.terminalActivity, input.now);
      const sidecarPartial = input.terminalState === "partial";
      const budgetExhausted = job.lastErrorCode
        === "crawler_candidate_budget_exhausted";
      job.state = sidecarPartial || budgetExhausted ? "partial" : "succeeded";
      job.lastErrorCode = sidecarPartial
        ? normalizeAcquisitionCrawlerStoredErrorCode(
          input.terminalErrorCode,
          "mediacrawler_partial"
        )
        : budgetExhausted ? "crawler_candidate_budget_exhausted" : null;
      job.completedAt = input.now;
      if (job.ingestionState !== "succeeded") job.ingestionState = "pending";
      clearLease(job);
    }
    return job;
  }

  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput) {
    return this.transaction((state) => this.persistPageInState(
      state,
      this.fenced(state, fence, input.now),
      input
    ));
  }

  persistDesktopPage(fence: AcquisitionCrawlerJobFence,
    input: PersistDesktopCrawlerPageInput) {
    return this.transaction<PersistDesktopCrawlerPageResult>((state) => {
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.idempotencyKeyHash)
        || !/^sha256:[0-9a-f]{64}$/u.test(input.requestHash)) {
        throw new TypeError("invalid_desktop_crawler_page_replay");
      }
      const replayKey = `${fence.jobId}\u0000${input.idempotencyKeyHash}`;
      const replay = state.desktopPageReplays.get(replayKey);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new Error("desktop_crawler_page_replay_conflict");
        }
        return { job: replay.job, replayed: true };
      }
      const job = this.fenced(state, fence, input.now);
      if (job.executionTarget !== "desktop"
        || desktopLeaseToken(job.desktopTaskTokenHash ?? "") !== fence.leaseToken) {
        throw new Error("desktop_crawler_capability_mismatch");
      }
      const saved = this.persistPageInState(state, job, input);
      state.desktopPageReplays.set(replayKey, {
        requestHash: input.requestHash,
        job: clone(saved)
      });
      return { job: saved, replayed: false };
    });
  }

  async listRecords(jobId: string) { return (await this.snapshot()).records.get(jobId) ?? []; }

  requestCancel(workspaceId: string, runId: string, now: string) {
    return this.transaction((state) => {
      const id = state.runs.get(runKey(workspaceId, runId));
      const job = id ? state.jobs.get(id) : null;
      if (!job) return null;
      if (["succeeded", "partial", "cancelled", "failed"].includes(job.state)) return job;
      job.cancelRequestedAt = now; job.updatedAt = now;
      if (job.state !== "running") { job.state = "cancelled"; job.completedAt = now; clearLease(job); }
      return job;
    });
  }

  completeCancelled(fence: AcquisitionCrawlerJobFence, now: string) {
    return this.transaction((state) => {
      const job = this.fenced(state, fence, now);
      if (!job.cancelRequestedAt) throw new Error("crawler_cancel_not_requested");
      job.state = "cancelled"; job.updatedAt = now; job.completedAt = now; clearLease(job); return job;
    });
  }

  pause(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string) {
    return this.transaction((state) => {
      const job = this.fenced(state, fence, now);
      job.state = "paused";
      job.lastErrorCode = normalizeAcquisitionCrawlerStoredErrorCode(
        errorCode,
        "crawler_worker_failed"
      );
      job.updatedAt = now; clearLease(job); return job;
    });
  }

  fail(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string, retryable: boolean) {
    return this.transaction((state) => {
      const job = this.fenced(state, fence, now);
      job.lastErrorCode = normalizeAcquisitionCrawlerStoredErrorCode(
        errorCode,
        "crawler_worker_failed"
      );
      job.updatedAt = now; clearLease(job);
      if (retryable && job.attempt < job.maxAttempts) job.state = "queued";
      else { job.state = retryable ? "paused" : "failed"; job.completedAt = retryable ? null : now; }
      return job;
    });
  }

  claimNextIngestion(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string) {
    const instant = milliseconds(now);
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_ingestion_lease");
    }
    return this.transaction<AcquisitionCrawlerIngestionClaim | null>((state) => {
      const job = [...state.jobs.values()]
        .filter((value) => ["succeeded", "partial"].includes(value.state)
          && value.executionTarget === "server"
          && value.ingestionState === "pending")
        .sort((left, right) => {
          const workspacePreference = Number(left.workspaceId === avoidWorkspaceId)
            - Number(right.workspaceId === avoidWorkspaceId);
          return workspacePreference || left.completedAt!.localeCompare(right.completedAt!)
            || left.id.localeCompare(right.id);
        })[0];
      if (!job) return null;
      job.ingestionState = "running";
      job.ingestionAttempt += 1;
      job.ingestionFencingToken += 1;
      job.ingestionLeaseWorkerId = workerId;
      job.ingestionLeaseToken = randomBytes(32).toString("hex");
      job.ingestionLeaseExpiresAt = new Date(instant + leaseDurationMs).toISOString();
      job.updatedAt = now;
      return {
        job,
        fence: {
          jobId: job.id,
          workerId,
          leaseToken: job.ingestionLeaseToken,
          fencingToken: job.ingestionFencingToken,
          aliasGeneration: job.aliasGeneration
        }
      };
    });
  }

  claimDesktopIngestion(workspaceId: string, jobId: string,
    taskTokenHash: string, workerId: string, now: string,
    leaseDurationMs: number) {
    const instant = milliseconds(now);
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_ingestion_lease");
    }
    return this.transaction<AcquisitionCrawlerIngestionClaim | null>((state) => {
      const job = state.jobs.get(jobId);
      if (!job || job.workspaceId !== workspaceId || job.executionTarget !== "desktop") {
        throw new Error("desktop_crawler_job_not_found");
      }
      if (job.desktopTaskTokenHash !== taskTokenHash) {
        throw new Error("desktop_crawler_capability_mismatch");
      }
      if (job.ingestionState === "succeeded") return null;
      if (!["succeeded", "partial"].includes(job.state)
        || job.ingestionState !== "pending") {
        throw new Error("desktop_crawler_job_not_completable");
      }
      job.ingestionState = "running";
      job.ingestionAttempt += 1;
      job.ingestionFencingToken += 1;
      job.ingestionLeaseWorkerId = workerId;
      job.ingestionLeaseToken = desktopLeaseToken(taskTokenHash);
      job.ingestionLeaseExpiresAt = new Date(instant + leaseDurationMs).toISOString();
      job.updatedAt = now;
      return { job, fence: { jobId, workerId,
        leaseToken: desktopLeaseToken(taskTokenHash),
        fencingToken: job.ingestionFencingToken,
        aliasGeneration: job.aliasGeneration } };
    });
  }

  private fencedIngestion(
    state: State,
    fence: AcquisitionCrawlerIngestionFence,
    now: string
  ) {
    const job = state.jobs.get(fence.jobId);
    if (!job || job.ingestionState !== "running"
      || job.ingestionLeaseWorkerId !== fence.workerId
      || job.ingestionLeaseToken !== fence.leaseToken
      || job.ingestionFencingToken !== fence.fencingToken
      || !Number.isSafeInteger(fence.aliasGeneration)
      || fence.aliasGeneration < 1
      || fence.aliasGeneration > job.aliasGeneration
      || !job.ingestionLeaseExpiresAt
      || milliseconds(now) >= milliseconds(job.ingestionLeaseExpiresAt)) {
      throw new Error("stale_crawler_ingestion_fence");
    }
    return job;
  }

  renewIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    now: string,
    leaseDurationMs: number
  ) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_ingestion_lease");
    }
    return this.transaction((state) => {
      const job = this.fencedIngestion(state, fence, now);
      job.ingestionLeaseExpiresAt = new Date(
        milliseconds(now) + leaseDurationMs
      ).toISOString();
      job.updatedAt = now;
      return job;
    });
  }

  deferIngestionForAliasChange(
    fence: AcquisitionCrawlerIngestionFence,
    now: string
  ) {
    return this.transaction((state) => {
      const job = this.fencedIngestion(state, fence, now);
      if (job.aliasGeneration === fence.aliasGeneration) {
        throw new Error("crawler_ingestion_generation_current");
      }
      job.ingestionState = "pending";
      job.updatedAt = now;
      clearIngestionLease(job);
      return job;
    });
  }

  completeIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    ingestedAt: string,
    acknowledgedAt: string,
    now: string
  ) {
    return this.transaction((state) => {
      const job = this.fencedIngestion(state, fence, now);
      milliseconds(ingestedAt);
      milliseconds(acknowledgedAt);
      if (job.aliasGeneration !== fence.aliasGeneration) {
        job.ingestionState = "pending";
        job.updatedAt = now;
        clearIngestionLease(job);
        return job;
      }
      job.ingestionState = "succeeded";
      job.projectedAliasGeneration = job.aliasGeneration;
      job.ingestedAt = ingestedAt;
      job.acknowledgedAt = acknowledgedAt;
      job.lastErrorCode = clearAcquisitionCrawlerIngestionErrorCode(
        job.lastErrorCode
      );
      job.updatedAt = now;
      clearIngestionLease(job);
      return job;
    });
  }

  completeDesktopIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    ingestedAt: string,
    now: string
  ) {
    return this.transaction((state) => {
      const job = this.fencedIngestion(state, fence, now);
      milliseconds(ingestedAt);
      if (job.executionTarget !== "desktop") {
        throw new Error("desktop_crawler_execution_target_mismatch");
      }
      if (job.aliasGeneration !== fence.aliasGeneration) {
        job.ingestionState = "pending";
        job.updatedAt = now;
        clearIngestionLease(job);
        return job;
      }
      job.ingestionState = "succeeded";
      job.projectedAliasGeneration = job.aliasGeneration;
      job.ingestedAt = ingestedAt;
      job.acknowledgedAt = null;
      job.lastErrorCode = clearAcquisitionCrawlerIngestionErrorCode(
        job.lastErrorCode
      );
      job.updatedAt = now;
      clearIngestionLease(job);
      return job;
    });
  }

  failIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    errorCode: string,
    now: string
  ) {
    return this.transaction((state) => {
      const job = this.fencedIngestion(state, fence, now);
      job.ingestionState = job.aliasGeneration !== fence.aliasGeneration
        ? "pending" : job.ingestionAttempt < ingestionAttemptLimit(job)
        ? "pending" : "failed";
      job.lastErrorCode = normalizeAcquisitionCrawlerStoredErrorCode(
        errorCode,
        "crawler_ingestion_failed"
      );
      job.updatedAt = now;
      clearIngestionLease(job);
      return job;
    });
  }

  cancelDesktop(workspaceId: string, jobId: string, taskTokenHash: string,
    fencingToken: number, now: string) {
    return this.transaction((state) => {
      milliseconds(now);
      const job = state.jobs.get(jobId);
      if (!job || job.workspaceId !== workspaceId || job.executionTarget !== "desktop") {
        throw new Error("desktop_crawler_job_not_found");
      }
      if (job.desktopTaskTokenHash !== taskTokenHash) {
        throw new Error("desktop_crawler_capability_mismatch");
      }
      if (["succeeded", "partial", "cancelled", "failed"].includes(job.state)) {
        return job;
      }
      if (job.state === "running" && job.fencingToken !== fencingToken) {
        throw new Error("stale_crawler_job_fence");
      }
      job.cancelRequestedAt = now;
      job.updatedAt = now;
      job.state = "cancelled";
      job.completedAt = now;
      clearLease(job);
      return job;
    });
  }

  sweepExpired(now: string) {
    return this.transaction((state) => {
      const at = milliseconds(now); let count = 0;
      for (const job of state.jobs.values()) {
        if (job.state !== "running" || !job.leaseExpiresAt || at < milliseconds(job.leaseExpiresAt)) continue;
        job.state = job.cancelRequestedAt ? "cancelled"
          : job.executionTarget === "desktop" ? "paused"
          : job.attempt < job.maxAttempts ? "queued" : "paused";
        if (job.state === "cancelled") job.completedAt = now;
        job.lastErrorCode = job.state === "cancelled" ? null : "crawler_lease_expired";
        job.updatedAt = now; clearLease(job); count += 1;
      }
      for (const job of state.jobs.values()) {
        if (job.ingestionState !== "running" || !job.ingestionLeaseExpiresAt
          || at < milliseconds(job.ingestionLeaseExpiresAt)) continue;
        job.ingestionState = job.ingestionAttempt < ingestionAttemptLimit(job)
          ? "pending" : "failed";
        job.lastErrorCode = "crawler_ingestion_lease_expired";
        job.updatedAt = now;
        clearIngestionLease(job);
        count += 1;
      }
      return count;
    });
  }
}
