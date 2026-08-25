import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import { AcquisitionCrawlerWorker } from "./acquisition-crawler-worker.js";
import type { AcquisitionCrawlerJobInput } from "./acquisition-crawler-job.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";

const now = "2026-08-24T00:00:00.000Z";
const job: AcquisitionCrawlerJobInput = {
  id: "crawler-1", workspaceId: "workspace-1", runId: "run-1",
  automationIntentId: "intent-1", planId: "plan-1",
  planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
  policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
  accountId: "account-1", accountLoginStateVersion: 2,
  dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24", trigger: "run_now",
  dailyCandidateLimit: 10, keywords: ["pump"],
  collectCreators: true, collectDemandComments: false,
  limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 }, createdAt: now
};

test("worker resumes from persisted cursor and never acknowledges sidecar pages", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const cursors: Array<string | null> = [];
  const starts: unknown[] = [];
  const gateway = {
    async startCrawlJob(input: unknown) { starts.push(input); return {
      jobId: "crawler-1", state: "running" as const,
      recordCount: 0, pageCount: 0, failureCode: null
    }; },
    async getCrawlJob() { return {
      jobId: "crawler-1", state: "succeeded" as const,
      recordCount: 1, pageCount: 2, failureCode: null
    }; },
    async getCrawlResults(_jobId: string, cursor: string | null) {
      cursors.push(cursor);
      if (cursor === null) {
        const record = {
        recordId: "video-1", kind: "video" as const, actorKind: null,
        canonicalUrl: "https://www.douyin.com/video/1",
        publicDisplayName: "Maker", publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
        observedAt: now, contentHash: ""
        };
        record.contentHash = normalizedDouyinContentHash(record);
        return { jobId: "crawler-1", cursor: null, nextCursor: "opaque-1", done: false, records: [record] };
      }
      return { jobId: "crawler-1", cursor: "opaque-1", nextCursor: null, done: true, records: [] };
    },
    async cancelCrawlJob() { throw new Error("not expected"); }
  };
  const worker = new AcquisitionCrawlerWorker({
    repository, gateway, accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } }, workerId: "worker-A", now: () => now
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(cursors, [null, "opaque-1"]);
  assert.equal((starts[0] as { collectCreators: boolean }).collectCreators, true);
  assert.equal((starts[0] as { collectDemandComments: boolean }).collectDemandComments, false);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "succeeded");
  await worker.close();
});

test("claims stay bounded-fair across workspaces", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const workspaceA1 = { ...job, id: "crawler-a1", runId: "run-a1",
    automationIntentId: "intent-a1", planId: "plan-a1" };
  const workspaceA2 = { ...job, id: "crawler-a2", runId: "run-a2",
    automationIntentId: "intent-a2", planId: "plan-a2",
    createdAt: "2026-08-24T00:00:01.000Z" };
  const workspaceB = { ...job, id: "crawler-b", workspaceId: "workspace-2",
    runId: "run-b", automationIntentId: "intent-b", planId: "plan-b",
    createdAt: "2026-08-24T00:00:02.000Z" };
  for (const input of [workspaceA1, workspaceA2, workspaceB]) {
    await repository.createOrGet(input);
    await repository.enqueue(input.workspaceId, input.runId, now);
  }
  const first = await repository.claimNext("fair-worker", now, 30_000);
  assert.equal(first?.job.id, "crawler-a1");
  const second = await repository.claimNext(
    "fair-worker", now, 30_000, first?.job.workspaceId
  );
  assert.equal(second?.job.id, "crawler-b");
});

test("worker alternates crawl and ingestion lanes under sustained crawl load", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const terminal = { ...job, id: "crawler-terminal", workspaceId: "workspace-2",
    runId: "run-terminal", automationIntentId: "intent-terminal",
    planId: "plan-terminal" };
  await repository.createOrGet(terminal);
  await repository.enqueue(terminal.workspaceId, terminal.runId, now);
  const terminalClaim = await repository.claimNext("setup-worker", now, 30_000);
  assert.ok(terminalClaim);
  await repository.persistPage(terminalClaim.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true, now
  });
  for (const input of [
    { ...job, id: "crawler-load-1", runId: "run-load-1",
      automationIntentId: "intent-load-1", planId: "plan-load-1" },
    { ...job, id: "crawler-load-2", runId: "run-load-2",
      automationIntentId: "intent-load-2", planId: "plan-load-2" }
  ]) {
    await repository.createOrGet(input);
    await repository.enqueue(input.workspaceId, input.runId, now);
  }
  const order: string[] = [];
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob(input) {
        order.push(`crawl:${input.jobId}`);
        return { jobId: input.jobId, state: "running" as const,
          recordCount: 0, pageCount: 0, failureCode: null };
      },
      async getCrawlJob(jobId) {
        return { jobId, state: "succeeded" as const,
          recordCount: 0, pageCount: 1, failureCode: null };
      },
      async getCrawlResults(jobId, cursor) {
        return { jobId, cursor, nextCursor: null, done: true, records: [] };
      },
      async acknowledgeCrawlJob(jobId) {
        order.push(`ack:${jobId}`);
        return { jobId, acknowledgedAt: now };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById(workspaceId) { return {
      id: "account-1", workspaceId, platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "fair-worker",
    now: () => now,
    async ingestTerminalJob(job) { order.push(`ingest:${job.id}`); }
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(order, [
    "crawl:crawler-load-1",
    "ingest:crawler-terminal",
    "ack:crawler-terminal"
  ]);
  await worker.close();
});

test("worker rejects a changed private account binding before sidecar start", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  let starts = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: { async startCrawlJob() { starts++; throw new Error("not expected"); }, async getCrawlJob() { throw new Error("not expected"); }, async getCrawlResults() { throw new Error("not expected"); }, async cancelCrawlJob() {} },
    accounts: { async findById() { return { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, accountHandle: null, state: "disconnected" as const, loginStateVersion: null }; } },
    workerId: "worker-A", now: () => now
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(starts, 0);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "paused");
  await worker.close();
});

test("worker recovers terminal ingestion and acknowledges only after domain persistence", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const order: string[] = [];
  let failFirstIngestion = true;
  const gateway = {
    async startCrawlJob() { return {
      jobId: "crawler-1", state: "running" as const,
      recordCount: 0, pageCount: 0, failureCode: null
    }; },
    async getCrawlJob() { return {
      jobId: "crawler-1", state: "succeeded" as const,
      recordCount: 0, pageCount: 1, failureCode: null
    }; },
    async getCrawlResults() {
      return { jobId: "crawler-1", cursor: null, nextCursor: null, done: true, records: [] };
    },
    async acknowledgeCrawlJob() {
      order.push("acknowledge");
      return { jobId: "crawler-1", acknowledgedAt: now };
    },
    async cancelCrawlJob() {}
  };
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway,
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-ingestion",
    now: () => now,
    async ingestTerminalJob() {
      order.push("persist-domain");
      if (failFirstIngestion) {
        failFirstIngestion = false;
        throw new Error("injected_ingestion_failure");
      }
    }
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "pending");
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(order, ["persist-domain"]);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "pending");
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(order, ["persist-domain", "persist-domain", "acknowledge"]);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "succeeded");
  await worker.close();
});

test("worker projects immutable pages before terminal status and preserves sidecar partial", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  let resolveLiveProjection!: () => void;
  const liveProjection = new Promise<void>((resolve) => { resolveLiveProjection = resolve; });
  let statusCalls = 0;
  const creator = {
    recordId: "creator-live", kind: "creator" as const,
    actorKind: "creator" as const,
    canonicalUrl: "https://www.douyin.com/user/creator-live",
    publicDisplayName: "Live maker",
    publicProfileUrl: "https://www.douyin.com/user/creator-live",
    textExcerpt: "need pump", sourceKeyword: "pump", observedAt: now,
    contentHash: ""
  };
  creator.contentHash = normalizedDouyinContentHash(creator);
  const gateway = {
    async startCrawlJob() {
      return { jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null };
    },
    async getCrawlJob() {
      statusCalls += 1;
      if (statusCalls === 1) {
        return { jobId: "crawler-1", state: "running" as const,
          recordCount: 1, pageCount: 1, failureCode: null };
      }
      await terminalGate;
      return { jobId: "crawler-1", state: "partial" as const,
        recordCount: 1, pageCount: 2,
        failureCode: "crawl_interrupted_after_partial_results" };
    },
    async getCrawlResults(_jobId: string, cursor: string | null) {
      return cursor === null
        ? { jobId: "crawler-1", cursor: null, nextCursor: "opaque-live",
          done: false, records: [creator] }
        : { jobId: "crawler-1", cursor: "opaque-live", nextCursor: null,
          done: true, records: [] };
    },
    async cancelCrawlJob() {}
  };
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway,
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "worker-live",
    now: () => now,
    pollIntervalMs: 1,
    async ingestAvailableJob(liveJob) {
      assert.equal(liveJob.state, "running");
      resolveLiveProjection();
    }
  });
  const execution = worker.runOnce();
  try {
    await Promise.race([
      liveProjection,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("live_projection_not_observed")), 200
      ))
    ]);
    const running = await repository.findByRun("workspace-1", "run-1");
    assert.equal(running?.state, "running");
    assert.equal(running?.recordCount, 1);
  } finally {
    releaseTerminal();
  }
  assert.equal(await execution, true);
  const terminal = await repository.findByRun("workspace-1", "run-1");
  assert.equal(terminal?.state, "partial");
  assert.equal(terminal?.lastErrorCode, "crawl_interrupted_after_partial_results");
  assert.equal(terminal?.recordCount, 1);
  await worker.close();
});

test("a live projection failure does not discard persisted crawl pages", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  let statusCalls = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null
      }; },
      async getCrawlJob() {
        statusCalls += 1;
        return statusCalls === 1
          ? { jobId: "crawler-1", state: "running" as const,
            recordCount: 0, pageCount: 1, failureCode: null }
          : { jobId: "crawler-1", state: "succeeded" as const,
            recordCount: 0, pageCount: 2, failureCode: null };
      },
      async getCrawlResults(jobId, cursor) {
        return cursor === null
          ? { jobId, cursor, nextCursor: "opaque-live", done: false, records: [] }
          : { jobId, cursor, nextCursor: null, done: true, records: [] };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "worker-live-failure",
    now: () => now,
    pollIntervalMs: 1,
    async ingestAvailableJob() { throw new Error("injected_live_projection_failure"); }
  });

  assert.equal(await worker.runOnce(), true);
  const terminal = await repository.findByRun("workspace-1", "run-1");
  assert.equal(terminal?.state, "succeeded");
  assert.equal(terminal?.cursorHistory.length, 1);
  assert.equal(terminal?.ingestionState, "pending");
  await worker.close();
});
