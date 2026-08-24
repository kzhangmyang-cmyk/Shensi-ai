import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionDouyinKeywordRouter } from "./acquisition-douyin-keyword-router.js";

test("keyword route derives scope server-side and accepts no caller model or workspace authority", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "owner", teamId: "team" } as any; req.activeWorkspace = { workspaceId: "workspace", actorId: "owner", teamId: "team" } as any; next(); });
  app.use(createAcquisitionDouyinKeywordRouter({ service: { async generate(scope, planId) { return { keywords: ["工厂获客"], modelSnapshotId: "snapshot", scope, planId }; } } as any }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const value = app.listen(0, () => resolve(value)); });
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/plans/plan-1/automation/keyword-suggestions`;
    const forged = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "keyword-0001" }, body: JSON.stringify({ workspaceId: "forged", modelSnapshotId: "forged" }) });
    assert.equal(forged.status, 400);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "keyword-0001" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { keywords: ["工厂获客"], modelSnapshotId: "snapshot" });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
