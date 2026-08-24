import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionCrawlerJobRouter } from "./acquisition-crawler-job-router.js";
import { InMemoryAcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";

test("crawler status route is workspace-bound, closed and reads persisted Node state only", async () => {
  const repository = new InMemoryAcquisitionCrawlerJobRepository();
  await repository.createOrGet({
    id: "crawler-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
    policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
    accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"b".repeat(64)}`,
    localDate: "2026-08-24", trigger: "scheduled", dailyCandidateLimit: 5, keywords: ["pump"],
    limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
    createdAt: "2026-08-24T00:00:00.000Z"
  });
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: "user-1", teamId: "team-1" } as never;
    req.activeWorkspace = { workspaceId: "workspace-1", actorId: "user-1", teamId: "team-1" };
    next();
  });
  app.use(createAcquisitionCrawlerJobRouter({ repository, requestIdFactory: () => "request-1" }));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/runs/run-1/crawler-status`);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(await response.json()).sort(), [
      "attempt", "candidateBudgetLimit", "candidateBudgetUsed", "completedAt", "createdAt", "cursorPersisted",
      "lastErrorCode", "recordCount", "runId", "state", "updatedAt"
    ]);
    const unpublishedMutation = await fetch(`http://127.0.0.1:${address.port}/runs/run-1/crawler-status`, {
      method: "DELETE"
    });
    assert.equal(unpublishedMutation.status, 404);
  } finally { server.close(); }
});
