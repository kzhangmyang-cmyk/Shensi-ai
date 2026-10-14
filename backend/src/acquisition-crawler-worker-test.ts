import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import { AcquisitionCrawlerWorker } from "./acquisition-crawler-worker.js";
import type { AcquisitionCrawlerJobInput } from "./acquisition-crawler-job.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";

const now = "2026-08-24T00:00:00.000Z";
const queuedActivity = {
  phase: "queued" as const, currentKeyword: null,
  browserMode: "headless" as const, sequence: 0
};
const completedActivity = {
  phase: "completed" as const, currentKeyword: null,
  browserMode: "headless" as const, sequence: 1
};
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

test("queued crawler pauses before browser execution when current entitlement is denied", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue(job.workspaceId, job.runId, now);
  let externalCalls = 0;
  const forbidden = async (): Promise<never> => { externalCalls++; throw new Error("unexpected browser call"); };
  const worker = new AcquisitionCrawlerWorker({ repository,
    gateway: { startCrawlJob: forbidden, getCrawlJob: forbidden, getCrawlResults: forbidden, cancelCrawlJob: forbidden },
    accounts: { async findById() { return { id: job.accountId, workspaceId: job.workspaceId, platform: "douyin",
      accountHandle: "private-handle", state: "active", loginStateVersion: 2 }; } },
    workerId: "worker-entitlement", now: () => now,
    executionAccess: async (workspaceId) => { assert.equal(workspaceId, job.workspaceId); return false; }
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(externalCalls, 0);
  const stored = await repository.findByRun(job.workspaceId, job.runId);
  assert.equal(stored?.state, "paused");
  assert.equal(stored?.lastErrorCode, "crawler_execution_forbidden");
  await worker.close();
});

test("worker resumes from persisted cursor and never acknowledges sidecar pages", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const cursors: Array<string | null> = [];
  const starts: unknown[] = [];
  const gateway = {
    async startCrawlJob(input: unknown) { starts.push(input); return {
      jobId: "crawler-1", state: "running" as const,
      recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
    }; },
    async getCrawlJob() { return {
      jobId: "crawler-1", state: "succeeded" as const,
      recordCount: 1, pageCount: 2, failureCode: null, activity: completedActivity
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

test("worker adopts a persisted terminal sidecar job after entitlement revocation without starting a new crawl", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  let starts = 0;
  const terminal = {
    jobId: "crawler-1",
    state: "partial" as const,
    recordCount: 305,
    pageCount: 1,
    failureCode: "crawl_interrupted_after_partial_results",
    activity: completedActivity
  };
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async findCrawlJob() { return terminal; },
      async startCrawlJob() {
        starts += 1;
        throw new Error("new crawl must not start");
      },
      async getCrawlJob() { return terminal; },
      async getCrawlResults() {
        return {
          jobId: "crawler-1",
          cursor: null,
          nextCursor: null,
          done: true,
          records: []
        };
      },
      async cancelCrawlJob() { throw new Error("not expected"); }
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "worker-adopt-terminal",
    executionAccess: async () => false,
    now: () => now
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal(starts, 0);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "partial");
  await worker.close();
});

test("worker persists validated sidecar activity before a zero-page poll", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet({ ...job, keywords: ["袜子"] });
  await repository.enqueue("workspace-1", "run-1", now);
  const activity = {
    phase: "queued" as const, currentKeyword: null,
    browserMode: "visible" as const, sequence: 0
  };
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null, activity
      }; },
      async getCrawlJob() { return {
        jobId: "crawler-1", state: "cancelled" as const,
        recordCount: 0, pageCount: 0, failureCode: null, activity
      }; },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-activity", now: () => now
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual((await repository.findByRun("workspace-1", "run-1"))?.activity, activity);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.activityObserved, true);
  await worker.close();
});

test("worker projects a cancelled crawler job to its authoritative run", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const projected: string[] = [];
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
      }; },
      async getCrawlJob() { return {
        jobId: "crawler-1", state: "cancelled" as const,
        recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
      }; },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "worker-cancelled-projection",
    now: () => now,
    async projectTerminalJob(terminalJob) {
      projected.push(`${terminalJob.runIds.join(",")}:${terminalJob.state}`);
    }
  });

  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(projected, ["run-1:cancelled"]);
  await worker.close();
});

test("worker requeues a paused sidecar job after preserving activity and restarts it on the next claim", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  let starts = 0;
  let pausedPolls = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() {
        starts += 1;
        return {
          jobId: "crawler-1", state: "running" as const,
          recordCount: 0, pageCount: 0, failureCode: null,
          activity: starts === 1
            ? { phase: "starting_browser" as const, currentKeyword: null,
              browserMode: "visible" as const, sequence: 1 }
            : { phase: "opening_douyin" as const, currentKeyword: null,
              browserMode: "visible" as const, sequence: 3 }
        };
      },
      async getCrawlJob() {
        if (starts === 1) {
          pausedPolls += 1;
          if (pausedPolls > 1) throw new Error("paused_status_polled_again");
          return {
            jobId: "crawler-1", state: "paused" as const,
            recordCount: 0, pageCount: 0, failureCode: null,
            activity: { phase: "searching" as const, currentKeyword: "pump",
              browserMode: "visible" as const, sequence: 2 }
          };
        }
        return {
          jobId: "crawler-1", state: "cancelled" as const,
          recordCount: 0, pageCount: 0, failureCode: null,
          activity: { phase: "opening_douyin" as const, currentKeyword: null,
            browserMode: "visible" as const, sequence: 3 }
        };
      },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-paused", now: () => now
  });

  assert.equal(await worker.runOnce(), true);
  const requeued = await repository.findByRun("workspace-1", "run-1");
  assert.equal(pausedPolls, 1);
  assert.equal(requeued?.state, "queued");
  assert.equal(requeued?.lastErrorCode, "mediacrawler_job_paused");
  assert.equal(requeued?.leaseToken, null);
  assert.equal(requeued?.activity.phase, "searching");
  assert.equal(await worker.runOnce(), true);
  assert.equal(starts, 2);
  await worker.close();
});

test("worker projects a failed sidecar job after its retry budget is exhausted", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet({ ...job, maxAttempts: 1 });
  await repository.enqueue("workspace-1", "run-1", now);
  const projected: string[] = [];
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
      }; },
      async getCrawlJob() { return {
        jobId: "crawler-1", state: "failed" as const,
        recordCount: 0, pageCount: 0,
        failureCode: "mediacrawler_job_failed", activity: queuedActivity
      }; },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const,
      loginStateVersion: 2
    }; } },
    workerId: "worker-failed-projection",
    now: () => now,
    async projectTerminalJob(terminalJob) {
      projected.push(`${terminalJob.runIds.join(",")}:${terminalJob.state}`);
    }
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "paused");
  assert.deepEqual(projected, ["run-1:paused"]);
  await worker.close();
});

test("worker keeps completed activity inside the terminal page transaction", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const originalPersistPage = repository.persistPage.bind(repository);
  let terminalInput: Parameters<typeof repository.persistPage>[1] | undefined;
  repository.persistPage = async (fence, input) => {
    terminalInput = input;
    throw new Error("terminal_page_write_failed");
  };
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "running" as const,
        recordCount: 0, pageCount: 0, failureCode: null,
        activity: { phase: "searching" as const, currentKeyword: "pump",
          browserMode: "visible" as const, sequence: 1 }
      }; },
      async getCrawlJob() { return {
        jobId: "crawler-1", state: "succeeded" as const,
        recordCount: 0, pageCount: 1, failureCode: null,
        activity: { phase: "completed" as const, currentKeyword: null,
          browserMode: "visible" as const, sequence: 2 }
      }; },
      async getCrawlResults() {
        return { jobId: "crawler-1", cursor: null, nextCursor: null,
          done: true, records: [] };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-terminal-atomic", now: () => now
  });

  try {
    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(terminalInput?.terminalActivity, {
      phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 2
    });
    const retried = await repository.findByRun("workspace-1", "run-1");
    assert.equal(retried?.state, "queued");
    assert.equal(retried?.activity.phase, "searching");
  } finally {
    repository.persistPage = originalPersistPage;
    await worker.close();
  }
});

test("worker keeps a terminal start snapshot out of a failed nonterminal retry", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { return {
        jobId: "crawler-1", state: "succeeded" as const,
        recordCount: 0, pageCount: 1, failureCode: null,
        activity: { phase: "completed" as const, currentKeyword: null,
          browserMode: "visible" as const, sequence: 1 }
      }; },
      async getCrawlJob() { throw new Error("terminal_replay_read_failed"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-terminal-start", now: () => now
  });

  assert.equal(await worker.runOnce(), true);
  const retried = await repository.findByRun("workspace-1", "run-1");
  assert.equal(retried?.state, "queued");
  assert.deepEqual(retried?.activity, queuedActivity);
  assert.equal(retried?.activityObserved, false);
  await worker.close();
});

test("worker stores a closed code instead of a credential-bearing crawl exception", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("token=top-secret-crawl-token"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { return {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const,
      accountHandle: "private-handle", state: "active" as const, loginStateVersion: 2
    }; } },
    workerId: "worker-public-error", now: () => now
  });

  assert.equal(await worker.runOnce(), true);
  const retried = await repository.findByRun("workspace-1", "run-1");
  assert.equal(retried?.lastErrorCode, "crawler_worker_failed");
  assert.doesNotMatch(retried?.lastErrorCode ?? "", /top-secret/u);
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
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now
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
          recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity };
      },
      async getCrawlJob(jobId) {
        return { jobId, state: "succeeded" as const,
          recordCount: 0, pageCount: 1, failureCode: null, activity: completedActivity };
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
  const projected: string[] = [];
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: { async startCrawlJob() { starts++; throw new Error("not expected"); }, async getCrawlJob() { throw new Error("not expected"); }, async getCrawlResults() { throw new Error("not expected"); }, async cancelCrawlJob() {} },
    accounts: { async findById() { return { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, accountHandle: null, state: "disconnected" as const, loginStateVersion: null }; } },
    workerId: "worker-A", now: () => now,
    async projectTerminalJob(terminalJob) {
      projected.push(`${terminalJob.runIds.join(",")}:${terminalJob.state}`);
    }
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(starts, 0);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "paused");
  assert.deepEqual(projected, ["run-1:paused"]);
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
      recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
    }; },
    async getCrawlJob() { return {
      jobId: "crawler-1", state: "succeeded" as const,
      recordCount: 0, pageCount: 1, failureCode: null, activity: completedActivity
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
  const completed = await repository.findByRun("workspace-1", "run-1");
  assert.equal(completed?.ingestionState, "succeeded");
  assert.equal(completed?.lastErrorCode, null);
  await worker.close();
});

test("worker stores a closed code instead of a credential-bearing ingestion exception", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const crawl = await repository.claimNext("setup-worker", now, 10_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now
  });
  let acknowledgements = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("not expected"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async acknowledgeCrawlJob() {
        acknowledgements += 1;
        return { jobId: "crawler-1", acknowledgedAt: now };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { throw new Error("not expected"); } },
    workerId: "worker-ingestion-public-error", now: () => now,
    async ingestTerminalJob() { throw new Error("password=top-secret-ingestion-password"); }
  });

  assert.equal(await worker.runOnce(), true);
  const retried = await repository.findByRun("workspace-1", "run-1");
  assert.equal(acknowledgements, 0);
  assert.equal(retried?.ingestionState, "pending");
  assert.equal(retried?.lastErrorCode, "crawler_ingestion_failed");
  assert.doesNotMatch(retried?.lastErrorCode ?? "", /top-secret/u);
  await worker.close();
});

test("worker does not acknowledge terminal ingestion after its lease was swept", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const crawl = await repository.claimNext("setup-worker", now, 10_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now
  });
  let clock = "2026-08-24T00:00:01.000Z";
  let beginIngestion!: () => void;
  const began = new Promise<void>((resolve) => { beginIngestion = resolve; });
  let releaseIngestion!: () => void;
  const blockedIngestion = new Promise<void>((resolve) => { releaseIngestion = resolve; });
  let acknowledgements = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("not expected"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async acknowledgeCrawlJob() {
        acknowledgements += 1;
        return { jobId: "crawler-1", acknowledgedAt: clock };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { throw new Error("not expected"); } },
    workerId: "worker-ingestion-stale", now: () => clock,
    leaseDurationMs: 1_000,
    async ingestTerminalJob() {
      beginIngestion();
      await blockedIngestion;
    }
  });

  const execution = worker.runOnce();
  await began;
  clock = "2026-08-24T00:00:03.000Z";
  assert.equal(await repository.sweepExpired(clock), 1);
  releaseIngestion();
  assert.equal(await execution, true);
  const recovered = await repository.findByRun("workspace-1", "run-1");
  assert.equal(acknowledgements, 0);
  assert.equal(recovered?.ingestionState, "pending");
  await worker.close();
});

test("worker defers a changed alias generation before acknowledging terminal ingestion", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const crawl = await repository.claimNext("setup-worker", now, 10_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now
  });
  let beginIngestion!: () => void;
  const began = new Promise<void>((resolve) => { beginIngestion = resolve; });
  let releaseIngestion!: () => void;
  const blockedIngestion = new Promise<void>((resolve) => { releaseIngestion = resolve; });
  let first = true;
  const projectedRunIds: string[][] = [];
  let acknowledgements = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("not expected"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async acknowledgeCrawlJob() {
        acknowledgements += 1;
        return { jobId: "crawler-1", acknowledgedAt: now };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { throw new Error("not expected"); } },
    workerId: "worker-ingestion-alias", now: () => now,
    async ingestTerminalJob(terminalJob) {
      projectedRunIds.push([...terminalJob.runIds]);
      if (first) {
        first = false;
        beginIngestion();
        await blockedIngestion;
      }
    }
  });

  const execution = worker.runOnce();
  await began;
  const attached = await repository.createOrGet({
    ...job, id: "crawler-2", runId: "run-2", automationIntentId: "intent-2"
  });
  assert.equal(attached.job.ingestionState, "running");
  assert.equal(await repository.claimNextIngestion("other-ingester", now, 10_000), null);
  releaseIngestion();
  assert.equal(await execution, true);
  assert.equal(acknowledgements, 0);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "pending");

  assert.equal(await worker.runOnce(), true);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(projectedRunIds, [["run-1"], ["run-1", "run-2"]]);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "succeeded");
  await worker.close();
});

test("worker keeps one ingestion owner alive through domain projection and acknowledgement", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const clock = () => new Date().toISOString();
  await repository.createOrGet({ ...job, createdAt: clock() });
  await repository.enqueue("workspace-1", "run-1", clock());
  const crawl = await repository.claimNext("setup-worker", clock(), 1_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now: clock()
  });
  const originalRenew = (repository as unknown as {
    renewIngestion?: (...args: unknown[]) => Promise<unknown>;
  }).renewIngestion;
  let activeRenewals = 0;
  let maximumConcurrentRenewals = 0;
  let renewals = 0;
  (repository as unknown as {
    renewIngestion: (...args: unknown[]) => Promise<unknown>;
  }).renewIngestion = async (...args) => {
    activeRenewals += 1;
    maximumConcurrentRenewals = Math.max(maximumConcurrentRenewals, activeRenewals);
    renewals += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    try {
      return await originalRenew!.call(repository, ...args);
    } finally {
      activeRenewals -= 1;
    }
  };
  let acknowledgements = 0;
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("not expected"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async acknowledgeCrawlJob() {
        acknowledgements += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        return { jobId: "crawler-1", acknowledgedAt: clock() };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { throw new Error("not expected"); } },
    workerId: "worker-ingestion-heartbeat", now: clock, leaseDurationMs: 60,
    async ingestTerminalJob() {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    }
  });

  try {
    assert.equal(await worker.runOnce(), true);
    assert.equal(acknowledgements, 1);
    assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "succeeded");
    assert.ok(renewals >= 3);
    assert.equal(maximumConcurrentRenewals, 1);
  } finally {
    if (originalRenew) {
      (repository as unknown as { renewIngestion: unknown }).renewIngestion = originalRenew;
    }
    await worker.close();
  }
});

test("worker leaves a new alias pending when it arrives during sidecar acknowledgement", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(job);
  await repository.enqueue("workspace-1", "run-1", now);
  const crawl = await repository.claimNext("setup-worker", now, 10_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now
  });
  let beginAcknowledgement!: () => void;
  const acknowledgementBegan = new Promise<void>((resolve) => { beginAcknowledgement = resolve; });
  let releaseAcknowledgement!: () => void;
  const blockedAcknowledgement = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
  const worker = new AcquisitionCrawlerWorker({
    repository,
    gateway: {
      async startCrawlJob() { throw new Error("not expected"); },
      async getCrawlJob() { throw new Error("not expected"); },
      async getCrawlResults() { throw new Error("not expected"); },
      async acknowledgeCrawlJob() {
        beginAcknowledgement();
        await blockedAcknowledgement;
        return { jobId: "crawler-1", acknowledgedAt: now };
      },
      async cancelCrawlJob() {}
    },
    accounts: { async findById() { throw new Error("not expected"); } },
    workerId: "worker-ingestion-ack-alias", now: () => now,
    async ingestTerminalJob() {}
  });

  const execution = worker.runOnce();
  await acknowledgementBegan;
  await repository.createOrGet({
    ...job, id: "crawler-2", runId: "run-2", automationIntentId: "intent-2"
  });
  releaseAcknowledgement();
  assert.equal(await execution, true);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.ingestionState, "pending");
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
        recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity };
    },
    async getCrawlJob() {
      statusCalls += 1;
      if (statusCalls === 1) {
        return { jobId: "crawler-1", state: "running" as const,
          recordCount: 1, pageCount: 1, failureCode: null, activity: queuedActivity };
      }
      await terminalGate;
      return { jobId: "crawler-1", state: "partial" as const,
        recordCount: 1, pageCount: 2,
        failureCode: "crawl_interrupted_after_partial_results", activity: completedActivity };
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
        recordCount: 0, pageCount: 0, failureCode: null, activity: queuedActivity
      }; },
      async getCrawlJob() {
        statusCalls += 1;
        return statusCalls === 1
          ? { jobId: "crawler-1", state: "running" as const,
            recordCount: 0, pageCount: 1, failureCode: null, activity: queuedActivity }
          : { jobId: "crawler-1", state: "succeeded" as const,
            recordCount: 0, pageCount: 2, failureCode: null, activity: completedActivity };
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
