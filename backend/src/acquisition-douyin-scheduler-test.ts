import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionDouyinScheduler } from "./acquisition-douyin-scheduler.js";
import { InMemoryAcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";

test("scheduler uses policy timezone/local time and deduplicates repeated ticks", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  const persistedRunIds: string[] = [];
  const scheduler = new AcquisitionDouyinScheduler({
    repository,
    runIntents: {
      async create(_policy, run) {
        persistedRunIds.push(run.id);
        return { ...run, id: "persisted-run-1" };
      }
    },
    policies: { async listScheduled() { return [{
      workspaceId: "workspace-1", planId: "plan-1", planVersionId: "plan-version-1", planVersion: 1,
      planSnapshotHash: `sha256:${"d".repeat(64)}`, policyVersionId: "policy-1",
      policyHash: `sha256:${"a".repeat(64)}`, accountId: "account-1", accountLoginStateVersion: 2,
      createdBy: "user-1", keywords: ["pump"], dailyCandidateLimit: 5,
      schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" },
      limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 }
    }]; } },
    idFactory: (prefix) => `${prefix}-1`, now: () => "2026-08-24T01:30:00.000Z"
  });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(await scheduler.tick(), 0);
  assert.deepEqual(persistedRunIds, ["douyin-run-1", "douyin-run-1"]);
  const stored = await repository.findByRun("workspace-1", "persisted-run-1");
  assert.equal(stored?.localDate, "2026-08-24");
  assert.equal(stored?.trigger, "scheduled");
});
