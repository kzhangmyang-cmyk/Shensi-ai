import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionOutreachBatchRouter } from "./acquisition-outreach-batch-router.js";

async function appRequest(input: { capabilities?: string[]; workspaceId?: string; headers?: Record<string, string>; body?: unknown; path?: string; method?: string }) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "owner-1", teamId: "team-1" } as never;
    req.activeWorkspace = { workspaceId: input.workspaceId ?? "workspace-1", actorId: "owner-1", teamId: "team-1",
      capabilities: input.capabilities ?? ["acquisition.outreach.approve"] } as never;
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionOutreachBatchRouter({
    service: {
      async create() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:1"' } }; },
      async get() { return { id: "batch-1", etag: '"outreach-batch:batch-1:1"' }; },
      async put() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async approve() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async reject() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async pause() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async resume() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:3"' } }; },
      async actions() { return []; },
      async listByRunCandidate(_scope, query) {
        const anchor = { createdAt: "2026-08-27T06:05:04.000Z", batchId: "batch-1" };
        return {
          items: [{
            id: query.after ? `after-${query.after.batchId}` : `limit-${query.limit}`,
            candidates: [{ candidateId: query.candidateId }]
          }],
          next: query.after ? null : anchor
        };
      }
    } as never,
    cursorSecret: "outreach-batch-router-test-secret-at-least-32-bytes",
    requestIdFactory: () => "request-batch-test"
  }));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const response = await fetch(`http://127.0.0.1:${address.port}${input.path ?? "/api/v1/acquisition/runs/run-1/outreach-batches"}`, {
      method: input.method ?? "POST", headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: ["GET", "HEAD"].includes(input.method ?? "POST") ? undefined : JSON.stringify(input.body ?? { candidateIds: ["candidate-1"] })
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON 404 proves a missing route during RED */ }
    return { response, json };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("candidate-scoped batch discovery requires filters, capability, and a limit from 1 through 50", async () => {
  for (const path of [
    "/api/v1/acquisition/outreach-batches?candidateId=candidate-1",
    "/api/v1/acquisition/outreach-batches?runId=run-1",
    "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&unexpected=true"
  ]) {
    const result = await appRequest({ method: "GET", path });
    assert.equal(result.response.status, 400);
    assert.equal(result.json.code, "invalid_request");
  }

  const forbidden = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1",
    capabilities: []
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.json.code, "capability_forbidden");

  const page = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1"
  });
  assert.equal(page.response.status, 200);
  assert.equal((page.json.items as Array<{ id: string }>)[0]?.id, "limit-20");
  assert.equal(typeof page.json.nextCursor, "string");
  for (const privateField of ["evidenceText", "publicActorKey", "publicProfileUrl", "commentTargetPublicUrl"]) {
    assert.equal(JSON.stringify(page.json).includes(privateField), false);
  }

  const maximum = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=50"
  });
  assert.equal(maximum.response.status, 200);
  assert.equal((maximum.json.items as Array<{ id: string }>)[0]?.id, "limit-50");
  const tooLarge = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=51"
  });
  assert.equal(tooLarge.response.status, 400);
  assert.equal(tooLarge.json.code, "invalid_request");
});

test("batch discovery cursor is signed and bound to workspace, run, and candidate", async () => {
  const first = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=1"
  });
  assert.equal(first.response.status, 200);
  const cursor = String(first.json.nextCursor);
  const valid = await appRequest({
    method: "GET",
    path: `/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=1&cursor=${encodeURIComponent(cursor)}`
  });
  assert.equal(valid.response.status, 200);
  assert.equal((valid.json.items as Array<{ id: string }>)[0]?.id, "after-batch-1");
  assert.equal(valid.json.nextCursor, null);

  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  const attempts = [
    { workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", cursor: tampered },
    { workspaceId: "workspace-1", runId: "run-2", candidateId: "candidate-1", cursor },
    { workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-2", cursor },
    { workspaceId: "workspace-2", runId: "run-1", candidateId: "candidate-1", cursor }
  ];
  for (const attempt of attempts) {
    const result = await appRequest({
      method: "GET",
      workspaceId: attempt.workspaceId,
      path: `/api/v1/acquisition/outreach-batches?runId=${attempt.runId}&candidateId=${attempt.candidateId}&limit=1&cursor=${encodeURIComponent(attempt.cursor)}`
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.json.code, "invalid_cursor");
  }
});

test("batch mutations require capability, Idempotency-Key, and If-Match where revision-bound", async () => {
  const forbidden = await appRequest({ capabilities: [] });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.json.code, "capability_forbidden");
  const missingKey = await appRequest({});
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.json.code, "invalid_idempotency_key");
  const missingMatch = await appRequest({ path: "/api/v1/acquisition/outreach-batches/batch-1/approve", headers: { "Idempotency-Key": "approval-key-1" }, body: { revision: 1, batchHash: `sha256:${"a".repeat(64)}`, confirm: true } });
  assert.equal(missingMatch.response.status, 428);
  assert.equal(missingMatch.json.code, "if_match_required");
});

test("public routes publish ETag and reject closed-schema additions", async () => {
  const created = await appRequest({ headers: { "Idempotency-Key": "create-key-1" } });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("etag"), '"outreach-batch:batch-1:1"');
  const invalid = await appRequest({ headers: { "Idempotency-Key": "create-key-2" }, body: { candidateIds: ["candidate-1"], workspaceId: "forged" } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.code, "invalid_request");
  const read = await appRequest({ method: "GET", path: "/api/v1/acquisition/outreach-batches/batch-1" });
  assert.equal(read.response.status, 200);
  assert.equal(read.response.headers.get("etag"), '"outreach-batch:batch-1:1"');
});
