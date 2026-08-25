import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionOutreachBatchRouter } from "./acquisition-outreach-batch-router.js";

async function appRequest(input: { capabilities?: string[]; headers?: Record<string, string>; body?: unknown; path?: string; method?: string }) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "owner-1", teamId: "team-1" } as never;
    req.activeWorkspace = { workspaceId: "workspace-1", actorId: "owner-1", teamId: "team-1",
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
      async actions() { return []; }
    } as never,
    requestIdFactory: () => "request-batch-test"
  }));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const response = await fetch(`http://127.0.0.1:${address.port}${input.path ?? "/api/v1/acquisition/runs/run-1/outreach-batches"}`, {
      method: input.method ?? "POST", headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: ["GET", "HEAD"].includes(input.method ?? "POST") ? undefined : JSON.stringify(input.body ?? { candidateIds: ["candidate-1"] })
    });
    return { response, json: await response.json() as Record<string, unknown> };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

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
