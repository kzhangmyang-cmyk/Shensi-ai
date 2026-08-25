import { randomBytes } from "node:crypto";
import {
  assertAcquisitionCrawlerActivity,
  assertCrawlerJobInput,
  defaultAcquisitionCrawlerActivity,
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
  now: string;
}

export interface AcquisitionCrawlerJobRepository {
  createOrGet(input: AcquisitionCrawlerJobInput): Promise<{ created: boolean; job: AcquisitionCrawlerJob }>;
  enqueue(workspaceId: string, runId: string, now: string): Promise<AcquisitionCrawlerJob | null>;
  findByRun(workspaceId: string, runId: string): Promise<AcquisitionCrawlerJob | null>;
  claimNext(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string): Promise<AcquisitionCrawlerJobClaim | null>;
  renew(fence: AcquisitionCrawlerJobFence, now: string, leaseDurationMs: number): Promise<AcquisitionCrawlerJob>;
  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput): Promise<AcquisitionCrawlerJob>;
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
  completeIngestion(fence: AcquisitionCrawlerIngestionFence, ingestedAt: string, acknowledgedAt: string, now: string): Promise<AcquisitionCrawlerJob>;
  failIngestion(fence: AcquisitionCrawlerIngestionFence, errorCode: string, now: string): Promise<AcquisitionCrawlerJob>;
  sweepExpired(now: string): Promise<number>;
}

interface State {
  jobs: Map<string, AcquisitionCrawlerJob>;
  daily: Map<string, string>;
  runs: Map<string, string>;
  intents: Map<string, string>;
  records: Map<string, PersistedNormalizedDouyinRecord[]>;
}

function clone<T>(value: T): T { return structuredClone(value); }
function milliseconds(value: string, code = "invalid_crawler_clock") {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(code);
  return parsed;
}
function dailyKey(value: Pick<AcquisitionCrawlerJobInput, "workspaceId" | "planId" | "policyVersionId" | "localDate">) {
  return `${value.workspaceId}\u0000${value.planId}\u0000${value.policyVersionId}\u0000${value.localDate}`;
}
function runKey(workspaceId: string, runId: string) { return `${workspaceId}\u0000${runId}`; }
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

export class InMemoryAcquisitionCrawlerJobRepository implements AcquisitionCrawlerJobRepository {
  private state: State = { jobs: new Map(), daily: new Map(), runs: new Map(), intents: new Map(), records: new Map() };
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
        if (mappedId && mappedId !== existingId) {
          throw new Error("crawler_job_identity_conflict");
        }
        if (intentMappedId && intentMappedId !== existingId) {
          throw new Error("crawler_job_identity_conflict");
        }
        const existing = state.jobs.get(existingId)!;
        if (existing.planVersionId !== input.planVersionId
          || existing.planSnapshotHash !== input.planSnapshotHash
          || existing.policyHash !== input.policyHash
          || existing.accountId !== input.accountId
          || existing.accountLoginStateVersion
            !== input.accountLoginStateVersion
          || existing.dailyBudgetId !== input.dailyBudgetId) {
          throw new Error("crawler_job_binding_conflict");
        }
        if (!existing.runIds.includes(input.runId)) existing.runIds.push(input.runId);
        if (!existing.automationIntentIds.includes(input.automationIntentId)) {
          existing.automationIntentIds.push(input.automationIntentId);
        }
        if (existing.ingestionState === "succeeded") {
          existing.ingestionState = "pending";
          existing.ingestedAt = null;
        }
        state.runs.set(runKey(input.workspaceId, input.runId), existing.id);
        state.intents.set(
          runKey(input.workspaceId, input.automationIntentId),
          existing.id
        );
        return { created: false, job: existing };
      }
      if (state.jobs.has(input.id)
        || state.runs.has(runKey(input.workspaceId, input.runId))
        || state.intents.has(runKey(input.workspaceId, input.automationIntentId))) {
        throw new Error("crawler_job_identity_conflict");
      }
      const job: AcquisitionCrawlerJob = {
        ...clone(input), maxAttempts: input.maxAttempts ?? 3,
        state: "scheduled", runIds: [input.runId],
        automationIntentIds: [input.automationIntentId], attempt: 0, cursor: null,
        cursorHistory: [],
        recordCount: 0, candidateBudgetUsed: 0, cancelRequestedAt: null,
        lastErrorCode: null, leaseWorkerId: null, leaseToken: null,
        leaseExpiresAt: null, fencingToken: 0, updatedAt: input.createdAt,
        completedAt: null, ingestionState: null, ingestionAttempt: 0,
        ingestionLeaseWorkerId: null, ingestionLeaseToken: null,
        ingestionLeaseExpiresAt: null, ingestionFencingToken: 0,
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

  claimNext(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string) {
    const at = milliseconds(now);
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_lease");
    }
    return this.transaction<AcquisitionCrawlerJobClaim | null>((state) => {
      const job = [...state.jobs.values()].filter((value) => value.state === "queued")
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
      if (input.activity.currentKeyword !== null
        && !job.keywords.includes(input.activity.currentKeyword)) {
        throw new TypeError("invalid_crawler_activity");
      }
      if (!job.activityObserved) {
        job.activity = structuredClone(input.activity);
        job.activityObserved = true;
        job.updatedAt = input.now;
        return job;
      }
      if (input.activity.sequence < job.activity.sequence) {
        throw new Error("crawler_activity_sequence_regressed");
      }
      if (input.activity.sequence === job.activity.sequence) {
        if (!sameActivity(input.activity, job.activity)) {
          throw new Error("crawler_activity_sequence_conflict");
        }
        return job;
      }
      if (sameActivity(input.activity, job.activity)) {
        throw new Error("crawler_activity_sequence_without_change");
      }
      job.activity = structuredClone(input.activity);
      job.updatedAt = input.now;
      return job;
    });
  }

  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput) {
    return this.transaction((state) => {
      const job = this.fenced(state, fence, input.now);
      if (job.cancelRequestedAt) throw new Error("crawler_job_cancelled");
      if (job.cursor !== input.expectedCursor) throw new Error("crawler_cursor_conflict");
      if ((input.done && input.nextCursor !== null)
        || (!input.done && (!input.nextCursor || input.nextCursor === input.expectedCursor))
        || (input.nextCursor !== null && Buffer.byteLength(input.nextCursor, "utf8") > 512)) {
        throw new TypeError("invalid_crawler_next_cursor");
      }
      const hasTerminalMetadata = input.terminalState !== undefined
        || input.terminalErrorCode !== undefined;
      if ((!input.done && hasTerminalMetadata)
        || (input.terminalState !== undefined
          && !["succeeded", "partial"].includes(input.terminalState))
        || (input.terminalErrorCode !== undefined
          && input.terminalErrorCode !== null
          && !/^[a-z0-9_]{1,100}$/u.test(input.terminalErrorCode))
        || (input.done && input.terminalState !== "partial"
          && input.terminalErrorCode != null)) {
        throw new TypeError("invalid_crawler_terminal_metadata");
      }
      if (input.nextCursor !== null && job.cursorHistory.includes(input.nextCursor)) {
        throw new Error("crawler_cursor_cycle");
      }
      input.records.forEach(assertNormalizedDouyinRecord);
      const stored = state.records.get(job.id)!;
      const identities = new Set(stored.map((record) => record.recordId));
      let dropped = false;
      for (const record of input.records) {
        if ((record.kind === "creator" && !job.collectCreators)
          || (record.kind === "comment" && !job.collectDemandComments)) continue;
        const candidate = record.kind !== "video";
        if (identities.has(record.recordId)) continue;
        if (candidate && job.candidateBudgetUsed >= job.dailyCandidateLimit) { dropped = true; continue; }
        stored.push({ ...clone(record), pageCursor: input.expectedCursor });
        identities.add(record.recordId);
        job.recordCount += 1;
        if (candidate) job.candidateBudgetUsed += 1;
      }
      if (dropped) job.lastErrorCode = "crawler_candidate_budget_exhausted";
      job.cursor = input.nextCursor;
      if (input.nextCursor !== null) job.cursorHistory.push(input.nextCursor);
      job.updatedAt = input.now;
      if (input.done) {
        const sidecarPartial = input.terminalState === "partial";
        const budgetExhausted = job.lastErrorCode
          === "crawler_candidate_budget_exhausted";
        job.state = sidecarPartial || budgetExhausted ? "partial" : "succeeded";
        job.lastErrorCode = sidecarPartial
          ? input.terminalErrorCode ?? "mediacrawler_partial"
          : budgetExhausted ? "crawler_candidate_budget_exhausted" : null;
        job.completedAt = input.now;
        if (job.ingestionState !== "succeeded") job.ingestionState = "pending";
        clearLease(job);
      }
      return job;
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
      job.state = "paused"; job.lastErrorCode = errorCode; job.updatedAt = now; clearLease(job); return job;
    });
  }

  fail(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string, retryable: boolean) {
    return this.transaction((state) => {
      const job = this.fenced(state, fence, now);
      job.lastErrorCode = errorCode; job.updatedAt = now; clearLease(job);
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
          fencingToken: job.ingestionFencingToken
        }
      };
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
      || !job.ingestionLeaseExpiresAt
      || milliseconds(now) >= milliseconds(job.ingestionLeaseExpiresAt)) {
      throw new Error("stale_crawler_ingestion_fence");
    }
    return job;
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
      job.ingestionState = "succeeded";
      job.ingestedAt = ingestedAt;
      job.acknowledgedAt = acknowledgedAt;
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
      job.ingestionState = job.ingestionAttempt < job.maxAttempts
        ? "pending" : "failed";
      job.lastErrorCode = errorCode.slice(0, 100);
      job.updatedAt = now;
      clearIngestionLease(job);
      return job;
    });
  }

  sweepExpired(now: string) {
    return this.transaction((state) => {
      const at = milliseconds(now); let count = 0;
      for (const job of state.jobs.values()) {
        if (job.state !== "running" || !job.leaseExpiresAt || at < milliseconds(job.leaseExpiresAt)) continue;
        job.state = job.cancelRequestedAt ? "cancelled" : job.attempt < job.maxAttempts ? "queued" : "paused";
        if (job.state === "cancelled") job.completedAt = now;
        job.lastErrorCode = job.state === "cancelled" ? null : "crawler_lease_expired";
        job.updatedAt = now; clearLease(job); count += 1;
      }
      for (const job of state.jobs.values()) {
        if (job.ingestionState !== "running" || !job.ingestionLeaseExpiresAt
          || at < milliseconds(job.ingestionLeaseExpiresAt)) continue;
        job.ingestionState = job.ingestionAttempt < job.maxAttempts
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
