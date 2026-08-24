import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionRunCandidatesRouter } from "./acquisition-run-candidates-router.js";

test("run candidates route scopes candidates and rejects a cursor reused with a different filter", async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "owner", teamId: "team" }; req.activeWorkspace = { workspaceId: "workspace", actorId: "owner", teamId: "team" }; next(); });
  app.use(createAcquisitionRunCandidatesRouter({
    repository: { async list(workspaceId, runId) { assert.equal(workspaceId, "workspace"); assert.equal(runId, "run-1"); return [{ id: "candidate-1", status: "needs_research", displayName: "公开用户", evidence: { sourceUrl: "https://www.douyin.com/video/1", excerpt: "公开需求" } }, { id: "candidate-2", status: "needs_research", displayName: "公开用户二", evidence: { sourceUrl: "https://www.douyin.com/video/2", excerpt: "公开需求二" } }, { id: "candidate-dnc", status: "do_not_contact", displayName: "拒绝联系", evidence: { sourceUrl: "https://www.douyin.com/video/3", excerpt: "勿扰" } }]; } },
    cursorSecret: "run-candidates-router-test-secret-at-least-32-bytes"
  }));
  const server = app.listen(0);
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1/acquisition/runs/run-1/candidates`;
    const first = await fetch(`${base}?limit=1`);
    assert.equal(first.status, 200);
    const firstJson = await first.json() as { items: Array<{ id: string }>; nextCursor: string };
    assert.equal(firstJson.items[0]?.id, "candidate-1");
    assert.equal(firstJson.items.some((item) => item.id === "candidate-dnc"), false);
    assert.ok(firstJson.nextCursor);
    const reused = await fetch(`${base}?status=qualified&cursor=${encodeURIComponent(firstJson.nextCursor)}`);
    assert.equal(reused.status, 400);
  } finally { server.close(); }
});
