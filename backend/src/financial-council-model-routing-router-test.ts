import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createFinancialCouncilModelRoutingRouter } from
  "./financial-council-model-routing-router.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { InMemoryGrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import { workspace } from "./financial-council-repository-contract-test.js";

const NOW = "2026-08-23T08:00:00.000Z";
const role = { mode: "auto", primaryConnectionId: null,
  fallbackConnectionIds: [], preferenceWeightBps: 0 };
const policy = { policyVersionId: "routing-1", workspaceId: "ws-1", revision: 1,
  status: "active", roles: { cfo: role, finance: role, profit: role,
    cost: role, cashflow: role, tax: role }, maxRunBudgetMinor: 10_000,
  maxRoleBudgetMinor: 1_000, requestTimeoutMs: 30_000,
  policyHash: `sha256:${"a".repeat(64)}`, createdBy: "manager-1", createdAt: NOW };

async function listen(capabilities: readonly string[] = [
  "finance.council.run", "finance.council.policy.manage"
]) {
  let puts = 0;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.activeWorkspace = Object.freeze({
    ...workspace(), role: "admin", capabilities: Object.freeze(capabilities)
  }) as never; next(); });
  app.use("/api/v1/finance/council-model-routing-policy",
    createFinancialCouncilModelRoutingRouter({
      service: {
        async getCurrent() { return policy; },
        async getVersion() { return policy; },
        async preview() { return []; },
        async put() { puts += 1; return { value: policy, replayed: puts > 1 }; }
      } as never,
      workspaceContext(req) { return req.activeWorkspace!; },
      commandContextFactory: commandContextFromRequest,
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
      now: () => NOW
    }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve);
    server.once("error", reject); });
  const port = (server.address() as AddressInfo).port;
  return { puts, async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { response, body: await response.json() };
  }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("routing GET returns ETag and preview accepts only an empty closed body", async () => {
  const server = await listen();
  try {
    const get = await server.request(
      "/api/v1/finance/council-model-routing-policy");
    assert.equal(get.response.status, 200);
    assert.equal(get.response.headers.get("etag"),
      '"financial-council-model-routing-policy:ws-1:1"');
    assert.equal("workspaceId" in get.body, false);
    const preview = (body: unknown, key?: string) => server.request(
      "/api/v1/finance/council-model-routing-policy/preview", {
        method: "POST", headers: { "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}) },
        body: JSON.stringify(body)
      });
    assert.equal((await preview({}, "preview-1")).response.status, 200);
    assert.equal((await preview({ connectionId: "browser-choice" },
      "preview-2")).response.status, 422);
    assert.equal((await preview({})).response.status, 400);
  } finally { await server.close(); }
});

test("routing PUT requires manage capability, idempotency and If-Match", async () => {
  const allowed = await listen();
  const denied = await listen(["finance.council.run"]);
  const request = (server: Awaited<ReturnType<typeof listen>>,
    headers: Record<string, string>) => server.request(
      "/api/v1/finance/council-model-routing-policy", { method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ roles: policy.roles, maxRunBudgetMinor: 10_000,
          maxRoleBudgetMinor: 1_000, requestTimeoutMs: 30_000 }) });
  try {
    assert.equal((await request(allowed, { "Idempotency-Key": "put-1" }))
      .response.status, 428);
    assert.equal((await request(allowed, { "If-Match":
      '"financial-council-model-routing-policy:ws-1:1"' })).response.status, 400);
    assert.equal((await request(denied, { "Idempotency-Key": "put-2",
      "If-Match": '"financial-council-model-routing-policy:ws-1:1"' }))
      .response.status, 403);
    assert.equal((await request(allowed, { "Idempotency-Key": "put-first",
      "If-Match": "*" })).response.status, 200);
  } finally { await Promise.all([allowed.close(), denied.close()]); }
});
