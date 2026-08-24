import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAcquisitionSocialAccountRouter } from "./acquisition-social-account-router.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

test("router binds accounts to active workspace, replays creates, and returns 412 for stale deletion", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.activeWorkspace = Object.freeze({ workspaceId: req.header("x-workspace") ?? "workspace-a", kind: "team", actorId: "actor", role: "admin", teamId: "team", capabilities: [], capabilityRegistryVersion: "test" }) as never; next(); });
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway: {
    async createLoginSession() { return { sessionId: "upstream", state: "awaiting_scan" as const, qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async getLoginSession() { return { sessionId: "upstream", state: "active" as const, qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: "private", accountDisplayName: null, loginStateVersion: 1 }; }
  }, idFactory: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z" });
  app.use(createAcquisitionSocialAccountRouter({ service, requestIdFactory: () => "request" }));
  const server = await new Promise<import("node:http").Server>((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { "content-type": "application/json", "x-workspace": "workspace-a", ...init.headers } });
  try {
    const first = await request("/social-accounts/douyin/login-sessions", { method: "POST", headers: { "Idempotency-Key": "create-key" }, body: JSON.stringify({ platform: "douyin" }) });
    const replay = await request("/social-accounts/douyin/login-sessions", { method: "POST", headers: { "Idempotency-Key": "create-key" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const session = await first.json() as { id: string };
    const bound = await service.bindActiveSession({ workspaceId: "workspace-a" }, session.id);
    const foreign = await fetch(`http://127.0.0.1:${address.port}/social-accounts/${bound.id}`, { method: "DELETE", headers: { "Idempotency-Key": "delete-key", "If-Match": bound.etag, "x-workspace": "workspace-b" } });
    assert.equal(foreign.status, 404);
    const stale = await request(`/social-accounts/${bound.id}`, { method: "DELETE", headers: { "Idempotency-Key": "delete-key", "If-Match": '"account-v999"' } });
    assert.equal(stale.status, 412);
    const deleted = await request(`/social-accounts/${bound.id}`, { method: "DELETE", headers: { "Idempotency-Key": "delete-ok", "If-Match": bound.etag } });
    const deletedReplay = await request(`/social-accounts/${bound.id}`, { method: "DELETE", headers: { "Idempotency-Key": "delete-ok", "If-Match": bound.etag } });
    assert.equal(deleted.status, 200); assert.equal(deletedReplay.status, 200);
    assert.equal(deletedReplay.headers.get("idempotency-replayed"), "true");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
