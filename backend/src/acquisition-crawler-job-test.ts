import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-repository.js";
import type { AcquisitionCrawlerJobInput } from "./acquisition-crawler-job.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";

const at = (second: number) => `2026-08-24T00:00:${String(second).padStart(2, "0")}.000Z`;

function input(overrides: Partial<AcquisitionCrawlerJobInput> = {}): AcquisitionCrawlerJobInput {
  return {
    id: "crawler-1", workspaceId: "workspace-1", runId: "run-1",
    planId: "plan-1", policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
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

test("daily scheduled and run-now creation deduplicates to one budget and maps both runs", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const scheduled = await repository.createOrGet(input());
  const runNow = await repository.createOrGet(input({ id: "crawler-2", runId: "run-2", trigger: "run_now" }));

  assert.equal(scheduled.created, true);
  assert.equal(runNow.created, false);
  assert.equal(runNow.job.id, scheduled.job.id);
  assert.equal((await repository.findByRun("workspace-1", "run-2"))?.id, scheduled.job.id);
});

test("a run alias cannot be remapped to another daily job", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.createOrGet(input({
    id: "crawler-2", runId: "run-2", localDate: "2026-08-25"
  }));

  await assert.rejects(repository.createOrGet(input({
    id: "crawler-3", runId: "run-1", localDate: "2026-08-25"
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
    recordId: "comment-1", kind: "comment" as const,
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "Buyer",
    publicProfileUrl: null, textExcerpt: "need pump", sourceKeyword: "pump",
    observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);
  const committed = await repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: "opaque-1", records: [record], done: false, now: at(2)
  });
  assert.equal(committed.cursor, "opaque-1");
  assert.equal((await repository.listRecords("crawler-1")).length, 1);
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
    expectedCursor: "opaque-B", nextCursor: null, records: [], done: true, now: at(4)
  })).state, "succeeded");
});

test("persist rejects a well-shaped but tampered normalized content hash", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 5_000);
  assert.ok(claim);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, done: true, now: at(2), records: [{
      recordId: "video-1", kind: "video", canonicalUrl: "https://www.douyin.com/video/1",
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

  await repository.createOrGet(input());
  await repository.enqueue("workspace-1", "run-1", at(0));
  const claim = await repository.claimNext("worker-A", at(1), 5_000);
  assert.ok(claim);
  const record = {
    recordId: "r".repeat(256), kind: "video" as const,
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "Maker",
    publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
    observedAt: at(1), contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);
  await assert.rejects(repository.persistPage(claim.fence, {
    expectedCursor: null, nextCursor: null, done: true, now: at(2), records: [record]
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
        canonicalUrl: kind === "creator"
          ? "https://www.douyin.com/user/1"
          : "https://www.douyin.com/video/1",
        publicDisplayName: "Maker",
        publicProfileUrl: kind === "creator" ? "https://www.douyin.com/user/1" : null,
        textExcerpt: "pump", sourceKeyword: "pump", observedAt: at(1), contentHash: ""
      };
      record.contentHash = normalizedDouyinContentHash(record);
      return record;
    });
    await repository.persistPage(claim.fence, {
      expectedCursor: null, nextCursor: null, done: true, now: at(2), records
    });
    assert.deepEqual((await repository.listRecords(jobId)).map((record) => record.kind), expected);
  }
});
