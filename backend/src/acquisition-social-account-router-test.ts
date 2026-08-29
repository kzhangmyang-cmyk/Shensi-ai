import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createGrowthCommercialCompositionForStore } from "./growth-commercial-composition.js";
import { createAcquisitionSocialAccountRouter } from "./acquisition-social-account-router.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { getStore } from "./store.js";

const JWT_SECRET = "social-account-router-test-secret-at-least-32-characters";

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

function cookie(cookiesHeader: string, name: string) {
  return cookiesHeader.split("; ").find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

test("production HTTP composition requires login and CSRF and resolves the authenticated workspace", async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = JWT_SECRET;
  const { app, installTestAcquisitionHttpRuntime } = await import("./server.js");
  const store = getStore();
  const addedUsers = [{ id: "social-user-a", name: "Social A", email: "social-a@example.test", password: "social-password", role: "admin", teamId: "social-workspace-a", avatar: "SA", status: "active", authVersion: 1 },
    { id: "social-user-b", name: "Social B", email: "social-b@example.test", password: "social-password", role: "admin", teamId: "social-workspace-b", avatar: "SB", status: "active", authVersion: 1 }] as const;
  store.users.push(...addedUsers as never);
  const production = createGrowthCommercialCompositionForStore({ store });
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway: {
    async createLoginSession() { return { sessionId: "upstream", state: "awaiting_scan" as const, qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async getLoginSession() { return { sessionId: "upstream", state: "active" as const, qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: `dyacct_${"a".repeat(64)}`, accountDisplayName: "Douyin", loginStateVersion: 1 }; },
    async disconnectLoginSession() {}
  }, idFactory: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });
  const acquisition = express.Router();
  acquisition.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({ service, requestIdFactory: () => "request" }));
  const uninstall = installTestAcquisitionHttpRuntime({ workspaceMiddleware: production.workspaceMiddleware, runtime: { handler: acquisition, async close() {} } });
  const server = await new Promise<import("node:http").Server>((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const login = async (email: string) => {
    const response = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "social-password" }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { csrfToken: string };
    const sessionCookies = cookies(response);
    assert.equal(cookie(sessionCookies, "gj_csrf"), body.csrfToken);
    return { cookies: sessionCookies, csrf: body.csrfToken };
  };
  try {
    const path = "/api/v1/acquisition/social-accounts/douyin/login-sessions";
    const anonymous = await request(path, { method: "POST", headers: { "Idempotency-Key": "anonymous" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(anonymous.status, 401);

    const userA = await login("social-a@example.test");
    const invalidCsrf = await request(path, { method: "POST", headers: { cookie: userA.cookies, "x-csrf-token": "invalid", "Idempotency-Key": "invalid-csrf" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(invalidCsrf.status, 403);

    const mutationHeaders = { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "create-key" };
    const first = await request(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ platform: "douyin" }) });
    const replay = await request(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ platform: "douyin" }) });
    const firstBody = await first.json() as { id: string };
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replay.json(), firstBody);

    const bound = await service.bindActiveSession({ workspaceId: "social-workspace-a" }, firstBody.id);
    const userB = await login("social-b@example.test");
    const foreign = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: { cookie: userB.cookies, "x-csrf-token": userB.csrf, "Idempotency-Key": "foreign-delete", "If-Match": bound.etag, "x-workspace": "social-workspace-a" } });
    assert.equal(foreign.status, 404);

    const stale = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "stale-delete", "If-Match": '"account-v999"' } });
    assert.equal(stale.status, 412);
    const deleteHeaders = { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "delete-key", "If-Match": bound.etag };
    const deleted = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: deleteHeaders });
    const deletedReplay = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: deleteHeaders });
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200);
    assert.equal(deletedReplay.status, 200);
    assert.equal(deletedReplay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await deletedReplay.json(), deletedBody);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await uninstall();
    for (const user of addedUsers) {
      const index = store.users.findIndex((candidate) => candidate.id === user.id);
      if (index >= 0) store.users.splice(index, 1);
    }
  }
});
