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
    async startCrawlJob(input: unknown) { starts.push(input); return { jobId: "crawler-1", state: "running" as const }; },
    async getCrawlJob() { return { jobId: "crawler-1", state: "succeeded" as const }; },
    async getCrawlResults(_jobId: string, cursor: string | null) {
      cursors.push(cursor);
      if (cursor === null) {
        const record = {
        recordId: "video-1", kind: "video" as const, canonicalUrl: "https://www.douyin.com/video/1",
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
    async startCrawlJob() { return { jobId: "crawler-1", state: "running" as const }; },
    async getCrawlJob() { return { jobId: "crawler-1", state: "succeeded" as const }; },
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
