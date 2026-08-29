import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";

const context = { workspaceId: "workspace-a" };
const otherWorkspace = { workspaceId: "workspace-b" };
const boundHandleA = `dyacct_${"a".repeat(64)}`;
const boundHandleB = `dyacct_${"b".repeat(64)}`;

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
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleA,
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
  assert.equal("loginStateVersionHighWater" in active, false);
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
    expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleB, accountDisplayName: "另一账号", loginStateVersion: 2 });
  const second = await service.createLoginSession(context, { platform: "douyin" });
  await assert.rejects(service.bindActiveSession(context, second.id), { code: "douyin_active_account_conflict" });
});

test("a newer valid login replaces an invalid legacy active identity", async () => {
  const gateway = new Gateway();
  gateway.getLoginSession = async () => ({ sessionId: "session-v2", state: "active" as const,
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:02:00.000Z", accountHandle: boundHandleA,
    accountDisplayName: "已验证账号", loginStateVersion: 2 });
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.upsert({
    id: "legacy-account", workspaceId: context.workspaceId, platform: "douyin",
    accountHandle: "legacy-random-handle", upstreamSessionId: "legacy-session",
    displayName: null, state: "active", loginStateVersion: 1,
    loginStateVersionHighWater: 1, revision: 3, etag: '"account-v3"',
    lastValidatedAt: "2026-08-23T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z"
  });
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: () => "new-login", now: () => "2026-08-24T00:00:00.000Z" });
  const login = await service.createLoginSession(context, { platform: "douyin" });

  const active = await service.bindActiveSession(context, login.id);

  assert.equal(active.id, "legacy-account");
  assert.equal(active.state, "active");
  assert.equal(active.displayName, "已验证账号");
  assert.equal(active.loginStateVersion, 2);
  assert.equal(active.revision, 4);
});

test("an equal-version valid login cannot replace an invalid legacy active identity", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.upsert({
    id: "legacy-account", workspaceId: context.workspaceId, platform: "douyin",
    accountHandle: "legacy-random-handle", upstreamSessionId: "legacy-session",
    displayName: null, state: "active", loginStateVersion: 1,
    loginStateVersionHighWater: 1, revision: 3, etag: '"account-v3"',
    lastValidatedAt: "2026-08-23T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z"
  });
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: () => "equal-version-login", now: () => "2026-08-24T00:00:00.000Z" });
  const login = await service.createLoginSession(context, { platform: "douyin" });

  await assert.rejects(service.bindActiveSession(context, login.id), {
    code: "douyin_login_session_not_active"
  });

  const stored = await repository.findByWorkspaceAndPlatform(context.workspaceId, "douyin");
  assert.equal(stored?.id, "legacy-account");
  assert.equal(stored?.accountHandle, "legacy-random-handle");
  assert.equal(stored?.loginStateVersionHighWater, 1);
  assert.equal(stored?.revision, 3);
});

test("same bound account reconnect advances login authority and upstream session", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: (() => { let n = 0; return () => `account-${++n}`; })(),
    now: (() => { let n = 0; return () => `2026-08-24T00:00:0${n++}.000Z`; })() });
  const firstLogin = await service.createLoginSession(context, { platform: "douyin" });
  const first = await service.bindActiveSession(context, firstLogin.id);
  gateway.getLoginSession = async () => ({ sessionId: "session-reconnect", state: "active" as const,
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:02:00.000Z", accountHandle: boundHandleA,
    accountDisplayName: "Douyin 新昵称", loginStateVersion: 2 });
  const secondLogin = await service.createLoginSession(context, { platform: "douyin" });

  const reconnected = await service.bindActiveSession(context, secondLogin.id);
  const stored = await repository.findById(context.workspaceId, first.id);

  assert.equal(reconnected.id, first.id);
  assert.equal(reconnected.loginStateVersion, 2);
  assert.equal(reconnected.displayName, "Douyin 新昵称");
  assert.equal(reconnected.revision, first.revision + 1);
  assert.equal(stored?.upstreamSessionId, "session-reconnect");
  assert.equal(stored?.accountHandle, boundHandleA);
});

test("repository derives every newer same-account revision inside its transaction", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const base = {
    id: "account-stable", workspaceId: context.workspaceId, platform: "douyin" as const,
    accountHandle: boundHandleA, upstreamSessionId: "session-v1", displayName: "Douyin",
    state: "active" as const, loginStateVersion: 1, loginStateVersionHighWater: 1, revision: 1,
    etag: '"account-v1"', lastValidatedAt: "2026-08-24T00:00:01.000Z",
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:01.000Z"
  };
  await repository.upsert(base);
  const staleRevision = (version: number) => ({ ...base,
    id: `stale-candidate-${version}`, upstreamSessionId: `session-v${version}`,
    loginStateVersion: version, loginStateVersionHighWater: version,
    revision: 2, etag: '"account-v2"',
    updatedAt: `2026-08-24T00:00:0${version}.000Z`
  });

  const [second, third] = await Promise.all([
    repository.bindActive(staleRevision(2)),
    repository.bindActive(staleRevision(3))
  ]);
  const stored = await repository.findByWorkspaceAndPlatform(context.workspaceId, "douyin");

  assert.notEqual(second, "active_handle_conflict");
  assert.notEqual(third, "active_handle_conflict");
  assert.equal(second !== "active_handle_conflict" ? second.revision : null, 2);
  assert.equal(third !== "active_handle_conflict" ? third.revision : null, 3);
  assert.equal(stored?.id, "account-stable");
  assert.equal(stored?.loginStateVersion, 3);
  assert.equal(stored?.revision, 3);
  assert.equal(stored?.etag, '"account-v3"');
  const staleUpsert = await repository.upsert({ ...base,
    upstreamSessionId: "session-stale", revision: 1, etag: '"account-v1"' });
  assert.equal(staleUpsert.loginStateVersion, 3);
  assert.equal(staleUpsert.loginStateVersionHighWater, 3);
  assert.equal((await repository.findById(context.workspaceId, "account-stable"))?.revision, 3);
  assert.equal(await repository.disconnect(context.workspaceId, "account-stable", '"account-v2"',
    "2026-08-24T00:00:04.000Z"), null);
  assert.equal((await repository.findById(context.workspaceId, "account-stable"))?.state, "active");
});

test("an old login session cannot resurrect a disconnected or risk-paused account", async () => {
  for (const terminalState of ["disconnected", "risk_paused"] as const) {
    const gateway = new Gateway();
    const repository = new InMemoryAcquisitionSocialAccountRepository();
    const service = new AcquisitionSocialAccountService({ repository, gateway,
      idFactory: (() => { let n = 0; return () => `account-${terminalState}-${++n}`; })(),
      now: () => "2026-08-24T00:00:00.000Z" });
    const login = await service.createLoginSession(context, { platform: "douyin" });
    const active = await service.bindActiveSession(context, login.id);
    if (terminalState === "disconnected") {
      await service.disconnect(context, active.id, active.etag);
    } else {
      const current = await repository.findById(context.workspaceId, active.id);
      if (!current) throw new Error("active account missing");
      if (!current.accountHandle || !current.loginStateVersion) {
        throw new Error("active account identity missing");
      }
      await repository.pauseActiveAccount(context.workspaceId, current.id, {
        accountHandle: current.accountHandle,
        loginStateVersion: current.loginStateVersion,
        revision: current.revision,
        etag: current.etag
      }, "2026-08-24T00:00:01.000Z");
    }
    const oldSession = await service.createLoginSession(context, { platform: "douyin" });

    await assert.rejects(service.bindActiveSession(context, oldSession.id), {
      code: "douyin_login_session_not_active"
    });
    assert.equal((await repository.findById(context.workspaceId, active.id))?.state, terminalState);
    assert.equal((await repository.findById(context.workspaceId, active.id))
      ?.loginStateVersionHighWater, 1);
  }
});

test("risk pause is an exact identity CAS and cannot roll back a concurrent reconnect", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const base = {
    id: "account-cas", workspaceId: context.workspaceId, platform: "douyin" as const,
    accountHandle: boundHandleA, upstreamSessionId: "session-v1", displayName: "Douyin",
    state: "active" as const, loginStateVersion: 1, loginStateVersionHighWater: 1, revision: 1,
    etag: '"account-v1"', lastValidatedAt: "2026-08-24T00:00:01.000Z",
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:01.000Z"
  };
  await repository.upsert(base);
  const oldIdentity = { accountHandle: boundHandleA, loginStateVersion: 1,
    revision: 1, etag: '"account-v1"' };
  await repository.bindActive({ ...base, upstreamSessionId: "session-v2",
    loginStateVersion: 2, loginStateVersionHighWater: 2,
    revision: 2, etag: '"account-v2"' });

  const paused = await (repository as unknown as {
    pauseActiveAccount(workspaceId: string, id: string, identity: typeof oldIdentity,
      updatedAt: string): Promise<unknown>;
  }).pauseActiveAccount(context.workspaceId, base.id, oldIdentity,
    "2026-08-24T00:00:03.000Z");

  assert.equal(paused, null);
  const stored = await repository.findById(context.workspaceId, base.id);
  assert.equal(stored?.state, "active");
  assert.equal(stored?.loginStateVersion, 2);
  assert.equal(stored?.revision, 2);
});

test("active upstream identity must be hashed-bound and have a real nickname", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "account-invalid", now: () => "2026-08-24T00:00:00.000Z"
  });
  const login = await service.createLoginSession(context, { platform: "douyin" });

  for (const invalid of [
    { accountHandle: "legacy-random-handle", accountDisplayName: "旧账号" },
    { accountHandle: boundHandleA, accountDisplayName: null },
    { accountHandle: boundHandleA, accountDisplayName: "   " }
  ]) {
    gateway.getLoginSession = async () => ({ sessionId: "session-invalid", state: "active" as const,
      qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z",
      loginStateVersion: 1, ...invalid });
    await assert.rejects(service.bindActiveSession(context, login.id), {
      code: "douyin_login_session_not_active"
    });
    assert.equal((await service.getLoginSession(context, login.id)).state, "login_expired");
  }
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
