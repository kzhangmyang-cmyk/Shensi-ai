import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionDesktopSyncService
} from "./acquisition-desktop-sync.js";
import {
  normalizedDouyinContentHash,
  type NormalizedDouyinRecord
} from "./acquisition-crawler-job.js";
import {
  InMemoryAcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-repository.js";
import {
  ingestDouyinCrawlerPage,
  type DouyinCrawlerEvidenceStore
} from "./acquisition-douyin-crawler-ingestion.js";
import {
  InMemoryAcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";

const NOW = "2026-09-03T04:00:00.000Z";
const accountHandle = `dyacct_${"a".repeat(64)}`;
const scope = {
  workspaceId: "workspace-a",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "owner-a"
};

const run = Object.freeze({
  id: "douyin-run-1",
  acquisitionRunId: "acquisition-run-1",
  workspaceId: scope.workspaceId,
  planId: "plan-1",
  planVersionId: "plan-version-1",
  planVersion: 1,
  planSnapshotHash: "plan-snapshot-1",
  policyVersionId: "policy-1",
  policyHash: `sha256:${"b".repeat(64)}`,
  accountId: "account-1",
  accountLoginStateVersion: 7,
  dailyBudgetId: `sha256:${"c".repeat(64)}`,
  localDate: "2026-09-03",
  trigger: "run_now" as const,
  collectCreators: true,
  collectDemandComments: true,
  status: "queued" as const,
  reason: "本机采集",
  createdBy: scope.actorId,
  createdAt: NOW
});

const policy = Object.freeze({
  id: "policy-1",
  source: "version" as const,
  workspaceId: scope.workspaceId,
  planId: run.planId,
  planVersionId: run.planVersionId,
  planVersion: 1,
  planSnapshotHash: run.planSnapshotHash,
  accountId: run.accountId,
  accountLoginStateVersion: 7,
  version: 1,
  revision: 1,
  etag: '"policy-v1"',
  policyHash: run.policyHash,
  keywords: ["工业除尘"],
  schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: {
    maxVideos: 30,
    maxComments: 100,
    maxCommentsPerVideo: 50,
    maxPagesPerVideo: 3,
    maxDurationSeconds: 3_600
  },
  createdBy: scope.actorId,
  createdAt: NOW
});

function candidateRecord(): NormalizedDouyinRecord {
  const content = {
    recordId: "comment-1",
    kind: "comment" as const,
    actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/7350000000000000001",
    publicDisplayName: "公开客户",
    publicProfileUrl: "https://www.douyin.com/user/customer_1",
    textExcerpt: "工厂正在寻找除尘设备，想咨询报价和交付周期。",
    sourceKeyword: "工业除尘"
  };
  return {
    ...content,
    observedAt: NOW,
    contentHash: normalizedDouyinContentHash(content)
  };
}

function evidenceStore(): DouyinCrawlerEvidenceStore & {
  candidates: Array<{ id: string; displayName: string }>;
} {
  const evidence: any[] = [];
  const candidates: any[] = [];
  return {
    candidates,
    async findEvidenceByContentHash(_workspaceId, contentHash) {
      return evidence.find((item) => item.contentHash === contentHash) ?? null;
    },
    async findLatestEvidenceByRecord() { return null; },
    async appendEvidence(item) { evidence.push(item); return item; },
    async findCandidateBySubjectKey(_workspaceId, subjectStableKey) {
      return candidates.find((item) => item.subjectStableKey === subjectStableKey) ?? null;
    },
    async saveCandidate(item) {
      candidates.push(item);
      return item;
    },
    async hasDoNotContact() { return false; },
    async retainDoNotContact() {}
  };
}

async function fixture(options: {
  executionAccess?: () => Promise<boolean>;
  failIngestionAttempts?: number;
  beforeIngestion?: () => Promise<void>;
  now?: () => string;
  leaseDurationMs?: number;
} = {}) {
  const crawlerJobs = new InMemoryAcquisitionCrawlerJobRepository();
  const accounts = new InMemoryAcquisitionSocialAccountRepository();
  await accounts.upsert({
    id: run.accountId,
    workspaceId: scope.workspaceId,
    platform: "douyin",
    accountHandle,
    upstreamSessionId: null,
    displayName: "Desktop Douyin",
    state: "active",
    loginStateVersion: 7,
    loginStateVersionHighWater: 7,
    revision: 1,
    etag: '"account-v1"',
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  const projection = evidenceStore();
  let remoteAcknowledgements = 0;
  let ingestionAttempts = 0;
  const service = new AcquisitionDesktopSyncService({
    executionAccess: options.executionAccess,
    automation: {
      async runNowDesktop() {
        return { value: run, policy, replayed: false };
      }
    },
    crawlerJobs,
    accounts,
    taskTokenSecret: "task-secret-that-is-at-least-thirty-two-characters",
    now: options.now ?? (() => NOW),
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    async ingestTerminalJob(job) {
      ingestionAttempts += 1;
      if (ingestionAttempts <= (options.failIngestionAttempts ?? 0)) {
        throw new Error("temporary_desktop_ingestion_failure");
      }
      await options.beforeIngestion?.();
      await ingestDouyinCrawlerPage({
        crawlerJobs,
        repository: projection,
        workspaceId: job.workspaceId,
        runId: job.runId,
        now: () => NOW
      });
    }
  });
  return {
    service,
    crawlerJobs,
    accounts,
    projection,
    ingestionAttempts: () => ingestionAttempts,
    remoteAcknowledgements: () => remoteAcknowledgements
  };
}

test("desktop prepare creates an exact-claim-only job and returns no private persistence", async () => {
  const value = await fixture();
  const prepared = await value.service.prepareRun(
    scope, "plan-1", "desktop-run-key-1", { reason: "本机采集" }
  );

  assert.deepEqual(prepared.run, run);
  assert.equal(prepared.task.loginStateVersion, 7);
  assert.equal(prepared.task.maxComments, 100);
  assert.equal(prepared.task.keywords[0], "工业除尘");
  assert.match(prepared.taskToken, /^[A-Za-z0-9_-]{32,200}$/u);
  assert.equal(await value.crawlerJobs.claimNext("server-worker", NOW, 30_000), null);
  const stored = await value.crawlerJobs.findById(scope.workspaceId, prepared.task.taskId);
  assert.equal(stored?.executionTarget, "desktop");
  assert.equal(stored?.maxAttempts, 1);
  assert.equal(stored?.dailyCandidateLimit, 50);
  assert.equal(JSON.stringify(stored).includes(prepared.taskToken), false);
  assert.equal(JSON.stringify(prepared.run).includes(prepared.taskToken), false);
});

test("desktop entitlement revocation blocks queued claim and lease renewal", async () => {
  let allowed = true;
  const value = await fixture({ executionAccess: async () => allowed });
  const prepared = await value.service.prepareRun(scope, "plan-1", "desktop-entitlement-1", { reason: "synthetic" });
  allowed = false;
  await assert.rejects(value.service.claim(scope, prepared.task.taskId, prepared.taskToken), /crawler_execution_forbidden/);
  allowed = true;
  const claimed = await value.service.claim(scope, prepared.task.taskId, prepared.taskToken);
  allowed = false;
  await assert.rejects(value.service.renew(scope, prepared.task.taskId, prepared.taskToken, claimed.leaseVersion), /crawler_execution_forbidden/);
});

test("desktop cloud completion retries ingestion independently of one crawl attempt", async () => {
  let allowed = true;
  const value = await fixture({ failIngestionAttempts: 1, executionAccess: async () => allowed });
  const prepared = await value.service.prepareRun(
    scope, "plan-1", "desktop-run-key-4", { reason: "本机采集" }
  );
  const claimed = await value.service.claim(
    scope, prepared.task.taskId, prepared.taskToken
  );
  allowed = false; // Revocation cannot discard already collected terminal pages.
  await value.service.uploadPage(
    scope, prepared.task.taskId, prepared.taskToken,
    "desktop-page-key-4", {
      leaseVersion: claimed.leaseVersion,
      cursor: null,
      nextCursor: null,
      done: true,
      records: [candidateRecord()],
      terminal: {
        state: "succeeded",
        failureCode: null,
        activity: {
          phase: "completed", currentKeyword: null,
          browserMode: "visible", sequence: 9
        }
      }
    }
  );
  await assert.rejects(
    value.service.complete(scope, prepared.task.taskId, prepared.taskToken),
    /temporary_desktop_ingestion_failure/u
  );
  const durable = await value.service.complete(
    scope, prepared.task.taskId, prepared.taskToken
  );
  assert.equal(durable.cloudDurable, true);
  assert.equal(durable.acknowledgedAt, null,
    "cloud durability must not impersonate the later local sidecar acknowledgement");
  assert.equal(value.ingestionAttempts(), 2);
  assert.equal(value.projection.candidates.length, 1);
});

test("desktop cloud completion renews its ingestion lease while projection is blocked", async () => {
  let clock = Date.parse(NOW);
  let releaseIngestion!: () => void;
  let ingestionStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseIngestion = resolve; });
  const started = new Promise<void>((resolve) => { ingestionStarted = resolve; });
  const value = await fixture({
    now: () => new Date(clock++).toISOString(),
    leaseDurationMs: 30,
    beforeIngestion: async () => {
      ingestionStarted();
      await blocked;
    }
  });
  const prepared = await value.service.prepareRun(
    scope, "plan-1", "desktop-run-key-heartbeat", { reason: "本机采集" }
  );
  const claimed = await value.service.claim(
    scope, prepared.task.taskId, prepared.taskToken
  );
  await value.service.uploadPage(
    scope, prepared.task.taskId, prepared.taskToken,
    "desktop-page-key-heartbeat", {
      leaseVersion: claimed.leaseVersion,
      cursor: null,
      nextCursor: null,
      done: true,
      records: [candidateRecord()],
      terminal: {
        state: "succeeded",
        failureCode: null,
        activity: {
          phase: "completed", currentKeyword: null,
          browserMode: "visible", sequence: 9
        }
      }
    }
  );

  const completion = value.service.complete(
    scope, prepared.task.taskId, prepared.taskToken
  );
  await started;
  const initial = await value.crawlerJobs.findById(
    scope.workspaceId, prepared.task.taskId
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const duringProjection = await value.crawlerJobs.findById(
    scope.workspaceId, prepared.task.taskId
  );
  releaseIngestion();
  await completion;

  assert.ok(initial?.ingestionLeaseExpiresAt);
  assert.ok(duringProjection?.ingestionLeaseExpiresAt);
  assert.ok(Date.parse(duringProjection.ingestionLeaseExpiresAt)
    > Date.parse(initial.ingestionLeaseExpiresAt),
  "a long projection must renew the exact ingestion fence before it expires");
});

test("desktop upload replays exactly, rejects changed content, and reaches candidate projection", async () => {
  const value = await fixture();
  const prepared = await value.service.prepareRun(
    scope, "plan-1", "desktop-run-key-2", { reason: "本机采集" }
  );
  await assert.rejects(value.service.claim(
    { ...scope, workspaceId: "workspace-b" },
    prepared.task.taskId,
    prepared.taskToken
  ), /desktop_crawler_job_not_found/u);
  await assert.rejects(value.service.claim(
    scope,
    prepared.task.taskId,
    "wrong-task-capability-that-is-long-enough"
  ), /desktop_crawler_capability_mismatch/u);

  const claimed = await value.service.claim(
    scope, prepared.task.taskId, prepared.taskToken
  );
  const page = {
    leaseVersion: claimed.leaseVersion,
    cursor: null,
    nextCursor: null,
    done: true,
    records: [candidateRecord()],
    terminal: {
      state: "succeeded" as const,
      failureCode: null,
      activity: {
        phase: "completed" as const,
        currentKeyword: null,
        browserMode: "visible" as const,
        sequence: 9
      }
    }
  };
  const first = await value.service.uploadPage(
    scope, prepared.task.taskId, prepared.taskToken,
    "desktop-page-key-1", page
  );
  const replay = await value.service.uploadPage(
    scope, prepared.task.taskId, prepared.taskToken,
    "desktop-page-key-1", page
  );
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  await assert.rejects(value.service.uploadPage(
    scope, prepared.task.taskId, prepared.taskToken,
    "desktop-page-key-1", {
      ...page,
      records: [{ ...candidateRecord(), textExcerpt: "changed" }]
    }
  ), /desktop_crawler_page_replay_conflict|normalized_douyin_content_hash_mismatch/u);

  const completed = await value.service.complete(
    scope, prepared.task.taskId, prepared.taskToken
  );
  assert.equal(completed.cloudDurable, true);
  assert.equal(completed.state, "succeeded");
  assert.equal(value.projection.candidates.length, 1);
  assert.equal(value.projection.candidates[0]?.displayName, "公开客户");
  assert.equal(value.remoteAcknowledgements(), 0);
});

test("desktop synchronization fails closed on stale login authority and cancellation fences", async () => {
  const value = await fixture();
  const prepared = await value.service.prepareRun(
    scope, "plan-1", "desktop-run-key-3", { reason: "本机采集" }
  );
  const claimed = await value.service.claim(
    scope, prepared.task.taskId, prepared.taskToken
  );
  const current = await value.accounts.findById(scope.workspaceId, run.accountId);
  assert.ok(current);
  await value.accounts.bindActive({
    ...current,
    loginStateVersion: 8,
    loginStateVersionHighWater: 8
  });
  await assert.rejects(value.service.renew(
    scope, prepared.task.taskId, prepared.taskToken, claimed.leaseVersion
  ), /desktop_crawler_account_binding_changed/u);
  const cancelled = await value.service.cancel(
    scope, prepared.task.taskId, prepared.taskToken, claimed.leaseVersion
  );
  assert.equal(cancelled.state, "cancelled");
});
