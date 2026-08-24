import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";

const context = { workspaceId: "workspace-a" };
const otherWorkspace = { workspaceId: "workspace-b" };

class Gateway {
  createLoginSessionCalls = 0;
  async createLoginSession() {
    this.createLoginSessionCalls += 1;
    return { sessionId: "session-a", state: "awaiting_scan" as const,
      qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  }
  async getLoginSession() { return { sessionId: "session-a", state: "active" as const,
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: "private-handle",
    accountDisplayName: "Douyin", loginStateVersion: 1 }; }
}

test("creates a sanitized QR login session and prevents cross-workspace binding", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "account-a", now: () => "2026-08-24T00:00:00.000Z" });
  const view = await service.createLoginSession(context, { platform: "douyin" });
  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(view.state, "awaiting_scan");
  assert.equal("accountHandle" in view, false);
  await assert.rejects(service.bindActiveSession(otherWorkspace, view.id), { code: "douyin_login_session_not_found" });
});

test("binds exactly once, replaces the active account, and disconnects safely", async () => {
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway: new Gateway(),
    idFactory: (() => { let n = 0; return () => `account-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z" });
  const session = await service.createLoginSession(context, { platform: "douyin" });
  const active = await service.bindActiveSession(context, session.id);
  assert.equal(active.state, "active");
  assert.equal("accountHandle" in active, false);
  const replay = await service.bindActiveSession(context, session.id);
  assert.deepEqual(replay, active);
  const disconnected = await service.disconnect(context, active.id, active.etag);
  assert.equal(disconnected.state, "disconnected");
  assert.equal((await service.list(context)).items[0]?.state, "disconnected");
});

test("rejects a different active handle instead of silently replacing it", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: (() => { let n = 0; return () => `account-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z" });
  const first = await service.createLoginSession(context, { platform: "douyin" });
  await service.bindActiveSession(context, first.id);
  gateway.getLoginSession = async () => ({ sessionId: "session-b", state: "active" as const, qrImageDataUrl: null,
    expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: "another-private-handle", accountDisplayName: null, loginStateVersion: 1 });
  const second = await service.createLoginSession(context, { platform: "douyin" });
  await assert.rejects(service.bindActiveSession(context, second.id), { code: "douyin_active_account_conflict" });
});

test("persists an exact create-session replay by workspace and semantic hash", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => "session-replay", now: () => "2026-08-24T00:00:00.000Z" });
  const first = await service.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "hash");
  const restarted = new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => "different", now: () => "2026-08-24T00:00:00.000Z" });
  const replay = await restarted.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "hash");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.view, first.view);
  assert.equal(gateway.createLoginSessionCalls, 1);
  await assert.rejects(restarted.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "different"), { code: "idempotency_key_conflict" });
});

test("reserves a create key before upstream work so concurrent calls issue one QR session", async () => {
  const gateway = new Gateway();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  gateway.createLoginSession = async () => { gateway.createLoginSessionCalls += 1; await gate; return { sessionId: "session-a", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; };
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway, idFactory: () => "session", now: () => "2026-08-24T00:00:00.000Z" });
  const first = service.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "hash");
  const second = service.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "hash");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.createLoginSessionCalls, 1);
  release();
  const [created, replayed] = await Promise.all([first, second]);
  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
});
