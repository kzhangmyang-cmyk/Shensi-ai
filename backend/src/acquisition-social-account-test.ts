import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";

const context = { workspaceId: "workspace-a" };
const otherWorkspace = { workspaceId: "workspace-b" };

class Gateway {
  createLoginSessionCalls = 0;
  disconnectLoginSessionCalls = 0;
  async createLoginSession() {
    this.createLoginSessionCalls += 1;
    return { sessionId: "session-a", state: "awaiting_scan" as const,
      qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  }
  async getLoginSession() { return { sessionId: "session-a", state: "active" as const,
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: "private-handle",
    accountDisplayName: "Douyin", loginStateVersion: 1 }; }
  async disconnectLoginSession() { this.disconnectLoginSessionCalls += 1; }
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

test("coordinates concurrent create replays across service instances", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    entered();
    await gate;
    return { sessionId: "session-cross-process", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  };
  const firstService = new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => "session-cross-process", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });
  const restartedService = new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => "must-not-run", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });

  const first = firstService.createLoginSessionIdempotently(context, { platform: "douyin" }, "shared-key", "shared-hash");
  await started;
  const second = restartedService.createLoginSessionIdempotently(context, { platform: "douyin" }, "shared-key", "shared-hash");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.createLoginSessionCalls, 1);
  release();
  const [created, replayed] = await Promise.all([first, second]);
  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.view, created.view);
});

test("releases failed create work and reclaims crashed or expired reservations", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let now = "2026-08-24T00:00:00.000Z";
  let fail = true;
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    if (fail) throw new Error("upstream failed");
    return { sessionId: `upstream-${gateway.createLoginSessionCalls}`, state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:20:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  };
  const service = () => new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => `local-${gateway.createLoginSessionCalls}`, now: () => now, replayTtlMs: 1_000, replayLeaseMs: 100, pendingPollMs: 1 });

  await assert.rejects(service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash"), /upstream failed/u);
  fail = false;
  const recovered = await service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash");
  assert.equal(recovered.replayed, false);

  now = "2026-08-24T00:00:02.000Z";
  const expiredReplay = await service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash");
  assert.equal(expiredReplay.replayed, false);
  assert.equal(gateway.createLoginSessionCalls, 3);

  await repository.claimReplay({ workspaceId: context.workspaceId, operation: "create_douyin_login_session", key: "crashed-key", requestHash: "crashed-hash", attemptedAt: now, leaseOwner: "dead-process", leaseDurationMs: 100, replayExpiresAt: "2026-08-24T00:01:00.000Z" });
  now = "2026-08-24T00:00:02.101Z";
  const reclaimed = await service().createLoginSessionIdempotently(context, { platform: "douyin" }, "crashed-key", "crashed-hash");
  assert.equal(reclaimed.replayed, false);
});

test("disconnect leaves the ETag retryable across upstream and local transaction failures", async () => {
  class FailingRepository extends InMemoryAcquisitionSocialAccountRepository {
    failTransaction = true;
    override async disconnectAndCompleteReplay(...args: Parameters<InMemoryAcquisitionSocialAccountRepository["disconnectAndCompleteReplay"]>) {
      if (this.failTransaction) {
        this.failTransaction = false;
        throw new Error("transaction failed");
      }
      return super.disconnectAndCompleteReplay(...args);
    }
  }
  const repository = new FailingRepository();
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => "account-delete", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });
  const login = await service.createLoginSession(context, { platform: "douyin" });
  const account = await service.bindActiveSession(context, login.id);

  let upstreamFails = true;
  gateway.disconnectLoginSession = async () => {
    gateway.disconnectLoginSessionCalls += 1;
    if (upstreamFails) throw new Error("cleanup failed");
  };
  await assert.rejects(service.disconnectIdempotently(context, account.id, account.etag, "delete-upstream", "delete-hash"), /cleanup failed/u);
  assert.equal((await service.list(context)).items[0]?.etag, account.etag);
  upstreamFails = false;
  repository.failTransaction = false;
  const afterUpstreamRetry = await service.disconnectIdempotently(context, account.id, account.etag, "delete-upstream", "delete-hash");
  assert.equal(afterUpstreamRetry.view.state, "disconnected");

  const secondRepository = new FailingRepository();
  const secondGateway = new Gateway();
  const secondService = new AcquisitionSocialAccountService({ repository: secondRepository, gateway: secondGateway, idFactory: () => "account-delete-transaction", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });
  const secondLogin = await secondService.createLoginSession(context, { platform: "douyin" });
  const secondAccount = await secondService.bindActiveSession(context, secondLogin.id);
  await assert.rejects(secondService.disconnectIdempotently(context, secondAccount.id, secondAccount.etag, "delete-transaction", "delete-hash"), /transaction failed/u);
  assert.equal((await secondService.list(context)).items[0]?.etag, secondAccount.etag);
  const retried = await secondService.disconnectIdempotently(context, secondAccount.id, secondAccount.etag, "delete-transaction", "delete-hash");
  assert.equal(retried.view.state, "disconnected");
  assert.equal(secondGateway.disconnectLoginSessionCalls, 2);
});
