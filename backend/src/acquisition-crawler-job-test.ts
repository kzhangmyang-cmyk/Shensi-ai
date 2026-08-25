import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-repository.js";
import type { AcquisitionCrawlerJobInput } from "./acquisition-crawler-job.js";
import {
  assertAcquisitionCrawlerActivity,
  assertNormalizedDouyinRecord,
  crawlerStatus,
  normalizedDouyinContentHash
} from "./acquisition-crawler-job.js";

const at = (second: number) => `2026-08-24T00:00:${String(second).padStart(2, "0")}.000Z`;
const completedActivity = {
  phase: "completed" as const, currentKeyword: null,
  browserMode: "visible" as const, sequence: 9
};

function input(overrides: Partial<AcquisitionCrawlerJobInput> = {}): AcquisitionCrawlerJobInput {
  return {
    id: "crawler-1", workspaceId: "workspace-1", runId: "run-1",
    automationIntentId: "intent-1", planId: "plan-1",
    planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
    policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
    accountId: "account-1", accountLoginStateVersion: 4,
    dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24",
    trigger: "scheduled", dailyCandidateLimit: 2,
    keywords: ["pump"], collectCreators: true, collectDemandComments: true,
    limits: { maxVideos: 2, maxCommentsPerVideo: 2, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
    createdAt: at(0), ...overrides
  };
}

test("jobs persist scheduled before an idempotent enqueue and claim", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const created = await repository.createOrGet(input());
  assert.equal(created.job.state, "scheduled");
  assert.equal(await repository.claimNext("worker-A", at(1), 1_000), null);

  assert.equal((await repository.enqueue("workspace-1", "run-1", at(1)))?.state, "queued");
  assert.equal((await repository.enqueue("workspace-1", "run-1", at(1)))?.state, "queued");
  assert.equal((await repository.claimNext("worker-A", at(2), 1_000))?.job.state, "running");
});

test("fenced activity snapshots advance only for frozen keywords and higher sequences", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input({ keywords: ["袜子", "服装"] }));
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);

  await repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "袜子",
      browserMode: "visible", sequence: 2
    },
    now: at(2)
  });
  assert.equal(
    (await repository.findByRun("workspace-1", "run-1"))?.activity.currentKeyword,
    "袜子"
  );
  const idempotent = await repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "袜子",
      browserMode: "visible", sequence: 2
    },
    now: at(3)
  });
  assert.equal(idempotent.updatedAt, at(2));
  const reorderedReplay = await repository.updateActivity(claim.fence, {
    activity: {
      sequence: 2, browserMode: "visible", currentKeyword: "袜子",
      phase: "searching"
    },
    now: at(4)
  });
  assert.equal(reorderedReplay.updatedAt, at(2));
  await assert.rejects(repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "服装",
      browserMode: "visible", sequence: 1
    },
    now: at(5)
  }), /crawler_activity_sequence_regressed/u);
  await assert.rejects(repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "服装",
      browserMode: "visible", sequence: 2
    },
    now: at(5)
  }), /crawler_activity_sequence_conflict/u);
  await assert.rejects(repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "鞋子",
      browserMode: "visible", sequence: 3
    },
    now: at(5)
  }), /invalid_crawler_activity/u);
  await assert.rejects(repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "袜子",
      browserMode: "visible", sequence: 3
    },
    now: at(5)
  }), /crawler_activity_sequence_without_change/u);
});

test("crawler activity bounds non-null keywords by Unicode codepoint", () => {
  const atLimit = "𠮷".repeat(100);
  assert.doesNotThrow(() => assertAcquisitionCrawlerActivity({
    phase: "searching", currentKeyword: atLimit,
    browserMode: "visible", sequence: 1
  }));
  assert.doesNotThrow(() => assertAcquisitionCrawlerActivity({
    phase: "queued", currentKeyword: null,
    browserMode: "headless", sequence: 0
  }));
  assert.throws(() => assertAcquisitionCrawlerActivity({
    phase: "searching", currentKeyword: "𠮷".repeat(101),
    browserMode: "visible", sequence: 1
  }), /invalid_crawler_activity/u);
});

test("daily scheduled and run-now creation deduplicates to one budget and maps both runs", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const scheduled = await repository.createOrGet(input());
  const runNow = await repository.createOrGet(input({
    id: "crawler-2", runId: "run-2", automationIntentId: "intent-2",
    trigger: "run_now"
  }));

  assert.equal(scheduled.created, true);
  assert.equal(runNow.created, false);
  assert.equal(runNow.job.id, scheduled.job.id);
  assert.equal((await repository.findByRun("workspace-1", "run-2"))?.id, scheduled.job.id);
});

test("a run alias cannot be remapped to another daily job", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.createOrGet(input({
    id: "crawler-2", runId: "run-2", automationIntentId: "intent-2",
    localDate: "2026-08-25"
  }));

  await assert.rejects(repository.createOrGet(input({
    id: "crawler-3", runId: "run-1", automationIntentId: "intent-3",
    localDate: "2026-08-25"
  })), /crawler_job_identity_conflict/u);
  assert.equal((await repository.findByRun("workspace-1", "run-1"))?.id, "crawler-1");
});

test("leases use random 64-hex fences and reject exact expiry plus same-worker ABA", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const first = await repository.claimNext("worker-A", at(1), 1_000);
  assert.ok(first);
  assert.match(first.fence.leaseToken, /^[0-9a-f]{64}$/u);

  await assert.rejects(
    repository.renew(first.fence, at(2), 1_000),
    /stale_crawler_job_fence/u
  );
  assert.equal(await repository.sweepExpired(at(2)), 1);
  const second = await repository.claimNext("worker-A", at(3), 1_000);
  assert.ok(second);
  assert.notEqual(second.fence.leaseToken, first.fence.leaseToken);
  assert.ok(second.fence.fencingToken > first.fence.fencingToken);
  await assert.rejects(
    repository.renew(first.fence, at(3), 1_000),
    /stale_crawler_job_fence/u
  );
});

test("cursor and normalized records commit atomically, reject replay order and late cancellation", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 5_000);
  assert.ok(claim);
  const record = {
    recordId: "comment-1", kind: "comment" as const, actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "Buyer",
    publicProfileUrl: "https://www.douyin.com/user/commenter-1",
    textExcerpt: "need pump", sourceKeyword: "pump",
    observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);
  const committed = await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-1", records: [record], done: false, now: at(2)
  });
  assert.equal(committed.cursor, "opaque-1");
  const persisted = await repository.listRecords("crawler-1");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.pageCursor, null);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-2", records: [], done: false, now: at(2)
  }), /crawler_cursor_conflict/u);
  await repository.requestCancel("workspace-1", "run-1", at(3));
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: "opaque-1", nextCursor: null, records: [], done: true, now: at(3)
  }), /crawler_job_cancelled/u);
});

test("cursor history rejects cycles and terminal non-null cursors", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);
  await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-A", records: [], done: false, now: at(2)
  });
  await repository.persistPage(claim.fence, {
    expectedCursor: "opaque-A", nextCursor: "opaque-B", records: [], done: false, now: at(3)
  });
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: "opaque-B", nextCursor: "opaque-A", records: [], done: false, now: at(4)
  }), /crawler_cursor_cycle/u);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: "opaque-B", nextCursor: "opaque-C", records: [], done: true, now: at(4)
  }), /invalid_crawler_next_cursor/u);
  assert.equal((await repository.persistPage(claim.fence, {
    expectedCursor: "opaque-B", nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now: at(4)
  })).state, "succeeded");
});

test("terminal partial metadata preserves records and the bounded sidecar error", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);
  const record = {
    recordId: "creator-partial", kind: "creator" as const,
    actorKind: "creator" as const,
    canonicalUrl: "https://www.douyin.com/user/creator-partial",
    publicDisplayName: "Maker",
    publicProfileUrl: "https://www.douyin.com/user/creator-partial",
    textExcerpt: "pump", sourceKeyword: "pump", observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);

  const terminal = await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, records: [record], done: true,
    terminalState: "partial",
    terminalErrorCode: "crawl_interrupted_after_partial_results",
    terminalActivity: completedActivity,
    now: at(2)
  });

  assert.equal(terminal.state, "partial");
  assert.equal(terminal.lastErrorCode, "crawl_interrupted_after_partial_results");
  assert.equal(terminal.recordCount, 1);
  assert.equal(terminal.ingestionState, "pending");
  assert.equal((await repository.listRecords("crawler-1")).length, 1);
});

test("terminal page commits completed activity, terminal state, and lease release atomically", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);
  await repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "pump", browserMode: "visible", sequence: 8
    },
    now: at(2)
  });

  const terminal = await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: completedActivity, now: at(3)
  });
  assert.equal(terminal.state, "succeeded");
  assert.deepEqual(terminal.activity, completedActivity);
  assert.equal(terminal.ingestionState, "pending");
  assert.equal(terminal.leaseToken, null);
});

test("invalid terminal activity rolls back the page and preserves the fenced running job", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);
  await repository.updateActivity(claim.fence, {
    activity: {
      phase: "searching", currentKeyword: "pump", browserMode: "visible", sequence: 1
    },
    now: at(2)
  });
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: {
      phase: "finalizing", currentKeyword: "pump", browserMode: "visible", sequence: 2
    },
    now: at(3)
  }), /invalid_crawler_terminal_activity/u);
  const running = await repository.findByRun("workspace-1", "run-1");
  assert.equal(running?.state, "running");
  assert.equal(running?.leaseToken, claim.fence.leaseToken);
  assert.equal(running?.recordCount, 0);
  assert.equal(running?.activity.phase, "searching");
});

test("terminal metadata is rejected on a nonterminal page", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);

  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-A", records: [], done: false,
    terminalState: "partial",
    terminalErrorCode: "crawl_interrupted_after_partial_results",
    now: at(2)
  }), /invalid_crawler_terminal_metadata/u);
});

test("candidate budget truncation on an early page survives the final empty page", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input({ dailyCandidateLimit: 1 }));
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 10_000);
  assert.ok(claim);
  const records = ["creator-one", "creator-two"].map((recordId) => {
    const record = {
      recordId, kind: "creator" as const, actorKind: "creator" as const,
      canonicalUrl: `https://www.douyin.com/user/${recordId}`,
      publicDisplayName: recordId,
      publicProfileUrl: `https://www.douyin.com/user/${recordId}`,
      textExcerpt: "pump", sourceKeyword: "pump", observedAt: at(1), contentHash: ""
    };
    record.contentHash = normalizedDouyinContentHash(record);
    return record;
  });
  const first = await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-A", records, done: false, now: at(2)
  });
  assert.equal(first.lastErrorCode, "crawler_candidate_budget_exhausted");

  const terminal = await repository.persistPage(claim.fence, {
    expectedCursor: "opaque-A", nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: completedActivity, now: at(3)
  });
  assert.equal(terminal.state, "partial");
  assert.equal(terminal.lastErrorCode, "crawler_candidate_budget_exhausted");
});

test("persist rejects a well-shaped but tampered normalized content hash", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 5_000);
  assert.ok(claim);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, done: true,
    terminalActivity: completedActivity, now: at(2), records: [{
      recordId: "video-1", kind: "video", canonicalUrl: "https://www.douyin.com/video/1",
      actorKind: null,
      publicDisplayName: "Maker", publicProfileUrl: null, textExcerpt: "changed",
      sourceKeyword: "pump", observedAt: at(1), contentHash: `sha256:${"c".repeat(64)}`
    }]
  }), /normalized_douyin_content_hash_mismatch/u);
});

test("job and record persistence reject values beyond frozen storage bounds", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  assert.throws(() => repository.createOrGet(input({
    id: "x".repeat(256),
    limits: { maxVideos: 201, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 }
  })), /invalid_crawler_job_input/u);
  assert.throws(() => repository.createOrGet(input({ maxAttempts: 0 })), /invalid_crawler_job_input/u);
  assert.throws(() => repository.createOrGet(input({
    runId: "r".repeat(161)
  })), /invalid_crawler_job_input/u);

  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 5_000);
  assert.ok(claim);
  const record = {
    recordId: "r".repeat(256), kind: "video" as const, actorKind: null,
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "Maker",
    publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
    observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, done: true,
    terminalActivity: completedActivity, now: at(2), records: [record]
  }), /invalid_normalized_douyin_record/u);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "界".repeat(200), done: false,
    now: at(2), records: []
  }), /invalid_crawler_next_cursor/u);
});

test("persistence filters both asymmetric frozen collection policies", async () => {
  for (const [suffix, collectCreators, collectDemandComments, expected] of [
    ["creators", true, false, ["video", "creator"]],
    ["comments", false, true, ["video", "comment"]]
  ] as const) {
    const repository = new InMemoryAcquisitionCrawlerJobRepository();
    const runId = `run-${suffix}`;
    const jobId = `crawler-${suffix}`;
    await repository.createOrGet(input({
      id: jobId, runId, collectCreators, collectDemandComments
    }));
    await repository.enqueue("workspace-1", runId, at(0));
    const claim = await repository.claimNext("worker-A", at(1), 5_000);
    assert.ok(claim);
    const records = (["video", "creator", "comment"] as const).map((kind) => {
      const record = {
        recordId: `${kind}-1`, kind,
        actorKind: kind === "creator" ? "creator" as const
          : kind === "comment" ? "commenter" as const : null,
        canonicalUrl: kind === "creator"
          ? "https://www.douyin.com/user/1"
          : "https://www.douyin.com/video/1",
        publicDisplayName: "Maker",
        publicProfileUrl: kind === "video" ? null
          : `https://www.douyin.com/user/${kind}-1`,
        textExcerpt: "pump", sourceKeyword: "pump", observedAt: at(1), contentHash: ""
      };
      record.contentHash = normalizedDouyinContentHash(record);
      return record;
    });
    await repository.persistPage(claim.fence, {
      expectedCursor: null, nextCursor: null, done: true,
      terminalActivity: completedActivity, now: at(2), records
    });
    assert.deepEqual((await repository.listRecords(jobId)).map((record) => record.kind), expected);
  }
});

test("normalization rejects root Douyin actor identities", () => {
  const record = {
    recordId: "comment-root", kind: "comment" as const,
    actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/1",
    publicDisplayName: "Unknown", publicProfileUrl: "https://www.douyin.com/",
    textExcerpt: "勿扰", sourceKeyword: "pump", observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);
  assert.throws(() => assertNormalizedDouyinRecord(record), /invalid_normalized_douyin_record/u);
});

test("late same-day alias requeues projection without recrawling or duplicating records", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const crawl = await repository.claimNext("crawler", at(1), 10_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now: at(2)
  });
  const ingestion = await repository.claimNextIngestion("ingester", at(3), 10_000);
  assert.ok(ingestion);
  await repository.completeIngestion(ingestion.fence, at(3), at(3), at(3));

  const attached = await repository.createOrGet(input({
    id: "crawler-2", runId: "run-2", automationIntentId: "intent-2",
    trigger: "run_now"
  }));
  assert.equal(attached.created, false);
  assert.equal(attached.job.state, "succeeded");
  assert.equal(attached.job.ingestionState, "pending");
  assert.equal((await repository.listRecords(attached.job.id)).length, 0);
});

test("terminal ingestion claims are fenced, single-winner, and restart recoverable", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const crawl = await repository.claimNext("crawler-A", at(1), 5_000);
  assert.ok(crawl);
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalActivity: completedActivity, now: at(2)
  });

  const [winner, loser] = await Promise.all([
    repository.claimNextIngestion("ingestion-A", at(3), 1_000),
    repository.claimNextIngestion("ingestion-B", at(3), 1_000)
  ]);
  assert.equal([winner, loser].filter(Boolean).length, 1);
  const claim = winner ?? loser;
  assert.ok(claim);
  await repository.sweepExpired(at(5));
  await assert.rejects(repository.completeIngestion(
    claim.fence, at(4), at(4), at(5)
  ), /stale_crawler_ingestion_fence/u);

  const restarted = await repository.claimNextIngestion("ingestion-C", at(6), 5_000);
  assert.ok(restarted);
  const completed = await repository.completeIngestion(
    restarted.fence,
    at(7),
    at(8),
    at(8)
  );
  assert.equal(completed.ingestionState, "succeeded");
  assert.equal(completed.ingestedAt, at(7));
  assert.equal(completed.acknowledgedAt, at(8));
  assert.equal(await repository.claimNextIngestion("ingestion-D", at(9), 1_000), null);
});

test("crawler status maps terminal projection readiness without exposing internal activity state", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input({ maxAttempts: 1 }));
  const scheduled = await repository.findByRun("workspace-1", "run-1");
  assert.equal(crawlerStatus(scheduled!, "run-1").candidateProjectionState, "pending");
  await repository.enqueue("workspace-1", "run-1", at(0));
  const queued = await repository.findByRun("workspace-1", "run-1");
  assert.equal(crawlerStatus(queued!, "run-1").candidateProjectionState, "pending");
  const crawl = await repository.claimNext("crawler", at(1), 10_000);
  assert.ok(crawl);
  assert.equal(crawlerStatus(crawl.job, "run-1").candidateProjectionState, "pending");
  await repository.persistPage(crawl.fence, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: completedActivity, now: at(2)
  });
  const pending = await repository.findByRun("workspace-1", "run-1");
  const pendingStatus = crawlerStatus(pending!, "run-1");
  assert.equal(pendingStatus.candidateProjectionState, "pending");
  assert.deepEqual(Object.keys(pendingStatus.activity).sort(), [
    "browserMode", "currentKeyword", "phase", "sequence"
  ]);
  for (const privateField of [
    "activityObserved", "ingestionState", "ingestionAttempt",
    "ingestionLeaseWorkerId", "ingestionLeaseToken",
    "ingestionLeaseExpiresAt", "ingestionFencingToken", "ingestedAt",
    "acknowledgedAt"
  ]) {
    assert.equal(privateField in pendingStatus, false, privateField);
  }
  const ingestion = await repository.claimNextIngestion("ingester", at(3), 10_000);
  assert.ok(ingestion);
  await repository.completeIngestion(ingestion.fence, at(3), at(3), at(3));
  const ready = await repository.findByRun("workspace-1", "run-1");
  assert.equal(crawlerStatus(ready!, "run-1").candidateProjectionState, "ready");

  for (const state of ["succeeded", "partial"] as const) {
    for (const ingestionState of [null, "pending", "running"] as const) {
      assert.equal(
        crawlerStatus({ ...ready!, state, ingestionState }, "run-1")
          .candidateProjectionState,
        "pending",
        `${state}:${String(ingestionState)}`
      );
    }
    assert.equal(
      crawlerStatus({ ...ready!, state, ingestionState: "succeeded" }, "run-1")
        .candidateProjectionState,
      "ready"
    );
    assert.equal(
      crawlerStatus({ ...ready!, state, ingestionState: "failed" }, "run-1")
        .candidateProjectionState,
      "failed"
    );
  }
  for (const state of ["paused", "cancelled", "failed"] as const) {
    assert.equal(crawlerStatus({ ...ready!, state }, "run-1").candidateProjectionState, "ready");
  }
});

test("crawler status rejects and never clones corrupt persisted activity", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  const job = (await repository.findByRun("workspace-1", "run-1"))!;
  (job.activity as unknown as { browserProfile: string }).browserProfile = "/private/profile";
  assert.throws(() => crawlerStatus(job, "run-1"), /invalid_crawler_activity/u);
  assert.throws(() => crawlerStatus({
    ...job,
    activity: completedActivity,
    activityObserved: "false" as never
  }, "run-1"), /invalid_crawler_activity_observation/u);
});

test("crawler status projects only frozen, bounded activity keywords", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  const job = (await repository.findByRun("workspace-1", "run-1"))!;
  const valid = {
    ...job,
    activity: {
      phase: "searching" as const, currentKeyword: "pump",
      browserMode: "visible" as const, sequence: 1
    },
    activityObserved: true
  };
  assert.deepEqual(crawlerStatus(valid, "run-1").activity, valid.activity);
  assert.doesNotThrow(() => crawlerStatus({
    ...valid,
    activity: { ...valid.activity, currentKeyword: null }
  }, "run-1"));
  for (const currentKeyword of ["unapproved", "𠮷".repeat(101)]) {
    assert.throws(() => crawlerStatus({
      ...valid,
      activity: { ...valid.activity, currentKeyword }
    }, "run-1"), /invalid_crawler_activity/u);
  }
});
