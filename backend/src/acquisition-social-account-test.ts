import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";
import { InMemoryDesktopInstallationRepository } from "./acquisition-desktop-installation-repository.js";
import { InMemoryAcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";
import { desktopInstallationIdHash } from "./acquisition-desktop-installation.js";
import { AcquisitionDesktopInstallationService } from "./acquisition-desktop-installation-service.js";

const context = { workspaceId: "workspace-a" };
const otherWorkspace = { workspaceId: "workspace-b" };
const boundHandleA = `dyacct_${"a".repeat(64)}`;
const boundHandleB = `dyacct_${"b".repeat(64)}`;

const privateDesktopOutputKeys = new Set([
  "accountHandle",
  "deviceCredential",
  "deviceCredentialHash",
  "deviceIdHash",
  "deviceToken",
  "enrollmentToken",
  "enrollmentTokenHash",
  "executorDeviceIdHash",
  "installationId",
  "profileId",
  "profileKey",
  "upstreamProfileId",
  "upstreamProfileKey",
  "upstreamSessionId"
]);

function assertRecursivelyPrivateDesktopDataAbsent(label: string, value: unknown,
  privateValues: readonly string[]) {
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        assert.equal(privateDesktopOutputKeys.has(key), false,
          `${label} exposed private key ${path}.${key}`);
        visit(nested, `${path}.${key}`);
      }
      return;
    }
    if (typeof current === "string") {
      for (const privateValue of privateValues) {
        assert.equal(current.includes(privateValue), false,
          `${label} exposed private value at ${path}`);
      }
    }
  };
  visit(value, "$output");
}

class Gateway {
  createLoginSessionCalls = 0;
  createLoginSessionInputs: unknown[] = [];
  disconnectLoginSessionCalls = 0;
  interactionCalls: Array<{ sessionId: string; interaction: unknown }> = [];
  liveLoginSessionCalls: string[] = [];
  async createLoginSession(input?: unknown) {
    this.createLoginSessionCalls += 1;
    this.createLoginSessionInputs.push(input);
    return { sessionId: "session-a", state: "awaiting_scan" as const,
      qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z",
      qrStatus: "ready" as const,
      loginPage: null,
      interactionSurface: "external_window" as const,
      runtimeState: "running" as const,
      authState: "waiting_for_user" as const,
      taskState: "idle" as const,
      diagnostic: { code: "waiting_for_user", message: "Complete login in the external browser.",
        recoverable: true, occurredAt: "2026-08-24T00:00:00.000Z" },
      screenshotAvailable: false,
      qrAvailable: false,
      accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  }
  async getLoginSession() { return { sessionId: "session-a", state: "active" as const,
    qrImageDataUrl: null, qrStatus: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleA,
    loginPage: null, accountDisplayName: "Douyin", loginStateVersion: 1 }; }
  async interactLoginSession(sessionId: string, interaction: unknown) {
    this.interactionCalls.push({ sessionId, interaction });
    return { sessionId, state: "awaiting_scan" as const, qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: { imageDataUrl: "data:image/png;base64,cGFnZQ==", width: 1280, height: 720 },
      expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null,
      accountDisplayName: null, loginStateVersion: null };
  }
  async createLiveLoginSession(sessionId: string) {
    this.liveLoginSessionCalls.push(sessionId);
    return { token: "a".repeat(64), expiresAt: "2026-08-24T00:00:30.000Z" };
  }
  async disconnectLoginSession() { this.disconnectLoginSessionCalls += 1; }
}

test("creates a sanitized pending login session with a nullable login page and prevents cross-workspace binding", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "account-a", now: () => "2026-08-24T00:00:00.000Z" });
  const view = await service.createLoginSession(context, { platform: "douyin" });
  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(view.state, "awaiting_scan");
  assert.equal(view.qrStatus, "ready");
  assert.equal(view.loginPage, null,
    "a sidecar placeholder must remain a successful pending session while its login page is starting");
  assert.equal(view.account, null);
  assert.equal("accountHandle" in view, false);
  await assert.rejects(service.bindActiveSession(otherWorkspace, view.id), { code: "douyin_login_session_not_found" });
});

test("login creation derives a stable opaque per-workspace profile key and passes through desktop state", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(),
    gateway,
    idFactory: () => "desktop-public-session",
    now: () => "2026-08-24T00:00:00.000Z"
  });
  const view = await service.createLoginSession(context, { platform: "douyin" });
  const expectedAccountKey = createHash("sha256")
    .update(`douyin-profile:${context.workspaceId}`, "utf8")
    .digest("hex");

  assert.deepEqual(gateway.createLoginSessionInputs, [{ accountKey: expectedAccountKey }]);
  assert.match(expectedAccountKey, /^[0-9a-f]{64}$/u);
  assert.equal(expectedAccountKey.includes(context.workspaceId), false);
  assert.deepEqual({
    interactionSurface: view.interactionSurface,
    runtimeState: view.runtimeState,
    authState: view.authState,
    taskState: view.taskState,
    diagnostic: view.diagnostic,
    screenshotAvailable: view.screenshotAvailable,
    qrAvailable: view.qrAvailable
  }, {
    interactionSurface: "external_window",
    runtimeState: "running",
    authState: "waiting_for_user",
    taskState: "idle",
    diagnostic: {
      code: "waiting_for_user",
      message: "Complete login in the external browser.",
      recoverable: true,
      occurredAt: "2026-08-24T00:00:00.000Z"
    },
    screenshotAvailable: false,
    qrAvailable: false
  });
  const publicJson = JSON.stringify(view);
  assert.equal(publicJson.includes(expectedAccountKey), false,
    "the stable profile key must remain private to the backend/Sidecar boundary");
  assert.equal(publicJson.includes(context.workspaceId), false,
    "the login view must not acquire a new raw workspace field");
});

test("login interaction uses the workspace-bound upstream session and returns its page", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "public-session", now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  const result = await service.interactLoginSession(context, created.id, {
    type: "click", normalizedX: 0.25, normalizedY: 0.75
  });

  assert.deepEqual(gateway.interactionCalls, [{
    sessionId: "session-a",
    interaction: { type: "click", normalizedX: 0.25, normalizedY: 0.75 }
  }]);
  assert.equal(result.id, "public-session");
  assert.equal(result.loginPage?.width, 1280);
});

test("live login is workspace-bound and exposes only a same-origin socket path", async () => {
  const gateway = new Gateway();
  const createLoginSession = gateway.createLoginSession.bind(gateway);
  gateway.createLoginSession = async (input?: unknown) => ({
    ...await createLoginSession(input), interactionSurface: "remote_canvas" as const
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "public-live-session", now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  await assert.rejects(service.createLiveLoginSession(otherWorkspace, created.id), {
    code: "douyin_login_session_not_found"
  });
  assert.deepEqual(await service.createLiveLoginSession(context, created.id), {
    socketPath: `/douyin-live/${"a".repeat(64)}`,
    expiresAt: "2026-08-24T00:00:30.000Z"
  });
  assert.deepEqual(gateway.liveLoginSessionCalls, ["session-a"]);
});

test("external-window login rejects live canvas creation without calling MediaCrawler", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "public-external-session",
    now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  await assert.rejects(service.createLiveLoginSession(context, created.id), {
    code: "douyin_live_login_unavailable"
  });
  assert.deepEqual(gateway.liveLoginSessionCalls, []);
});

test("expired login sessions reject interactions before calling MediaCrawler", async () => {
  const gateway = new Gateway();
  let now = "2026-08-24T00:00:00.000Z";
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "expiring-session", now: () => now
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });
  now = "2026-08-24T00:02:00.000Z";

  await assert.rejects(service.interactLoginSession(context, created.id, {
    type: "key", key: "Enter"
  }), { code: "douyin_login_session_expired" });
  assert.equal(gateway.interactionCalls.length, 0);
});

test("a failed login session exposes its safe failure code", async () => {
  const gateway = new Gateway();
  gateway.getLoginSession = async () => ({
    sessionId: "session-a", state: "failed" as const,
    qrImageDataUrl: null, qrStatus: null, loginPage: null,
    failureCode: "douyin_login_ui_unsupported" as const,
    expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null,
    accountDisplayName: null, loginStateVersion: null
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "failed-session", now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  const failed = await service.getLoginSession(context, created.id);

  assert.equal(failed.state, "login_expired");
  assert.equal(failed.failureCode, "douyin_login_ui_unsupported");
});

test("the first upstream expiry poll returns a closed expired QR state", async () => {
  const gateway = new Gateway();
  gateway.getLoginSession = async () => ({
    sessionId: "session-a", state: "expired" as const,
    qrImageDataUrl: null, qrStatus: "expired" as const, loginPage: null,
    failureCode: null,
    expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null,
    accountDisplayName: null, loginStateVersion: null
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "expired-session", now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  const expired = await service.getLoginSession(context, created.id);

  assert.equal(expired.state, "login_expired");
  assert.equal(expired.qrStatus, "expired");
});

test("cancelling a login session is workspace-bound and removes its local mapping", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({
    repository, gateway, idFactory: () => "cancel-session",
    now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  await assert.rejects(service.cancelLoginSession(otherWorkspace, created.id), {
    code: "douyin_login_session_not_found"
  });
  assert.equal(gateway.disconnectLoginSessionCalls, 0);
  await repository.saveLoginSession({
    id: created.id,
    workspaceId: otherWorkspace.workspaceId,
    upstreamId: "other-workspace-upstream",
    expiresAt: "2026-08-24T00:05:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z"
  });

  await service.cancelLoginSession(context, created.id);

  assert.equal(gateway.disconnectLoginSessionCalls, 1);
  assert.equal(await repository.findLoginSession(context.workspaceId, created.id), null);
  assert.equal(
    (await repository.findLoginSession(otherWorkspace.workspaceId, created.id))?.upstreamId,
    "other-workspace-upstream"
  );
  await assert.rejects(service.getLoginSession(context, created.id), {
    code: "douyin_login_session_not_found"
  });
});

test("an interaction that completes login binds the exact active account", async () => {
  const gateway = new Gateway();
  gateway.interactLoginSession = async (sessionId: string, interaction: unknown) => {
    gateway.interactionCalls.push({ sessionId, interaction });
    return { sessionId, state: "active" as const, qrImageDataUrl: null,
      qrStatus: null,
      loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: boundHandleA, accountDisplayName: "已登录抖音账号",
      loginStateVersion: 1 };
  };
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: (() => { let index = 0; return () => `active-${++index}`; })(),
    now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  const result = await service.interactLoginSession(context, created.id, {
    type: "key", key: "Enter"
  });

  assert.equal(result.state, "active");
  assert.equal(result.account?.displayName, "已登录抖音账号");
  assert.equal(result.account?.workspaceId, context.workspaceId);
});

test("login interaction cannot cross workspace or accept another upstream session", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "workspace-session", now: () => "2026-08-24T00:00:00.000Z"
  });
  const created = await service.createLoginSession(context, { platform: "douyin" });

  await assert.rejects(service.interactLoginSession(otherWorkspace, created.id, {
    type: "key", key: "Tab"
  }), { code: "douyin_login_session_not_found" });
  assert.equal(gateway.interactionCalls.length, 0);

  gateway.interactLoginSession = async () => ({
    sessionId: "another-upstream", state: "awaiting_scan" as const,
    qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
    expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null,
    accountDisplayName: null, loginStateVersion: null
  });
  await assert.rejects(service.interactLoginSession(context, created.id, {
    type: "key", key: "Tab"
  }), { code: "douyin_login_session_not_active" });
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
  gateway.getLoginSession = async () => ({ sessionId: "session-b", state: "active" as const, qrImageDataUrl: null, qrStatus: null,
    loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleB, accountDisplayName: "另一账号", loginStateVersion: 2 });
  gateway.createLoginSession = async () => ({ ...(await new Gateway().createLoginSession()), sessionId: "session-b" });
  const second = await service.createLoginSession(context, { platform: "douyin" });
  await assert.rejects(service.bindActiveSession(context, second.id), { code: "douyin_active_account_conflict" });
});

test("a newer valid login replaces an invalid legacy active identity", async () => {
  const gateway = new Gateway();
  gateway.getLoginSession = async () => ({ sessionId: "session-v2", state: "active" as const,
    qrImageDataUrl: null, qrStatus: null, loginPage: null, expiresAt: "2026-08-24T00:02:00.000Z", accountHandle: boundHandleA,
    accountDisplayName: "已验证账号", loginStateVersion: 2 });
  gateway.createLoginSession = async () => ({ ...(await new Gateway().createLoginSession()), sessionId: "session-v2" });
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
    qrImageDataUrl: null, qrStatus: null, loginPage: null, expiresAt: "2026-08-24T00:02:00.000Z", accountHandle: boundHandleA,
    accountDisplayName: "Douyin 新昵称", loginStateVersion: 2 });
  gateway.createLoginSession = async () => ({ ...(await new Gateway().createLoginSession()), sessionId: "session-reconnect" });
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
      qrImageDataUrl: null, qrStatus: null, loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z",
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
  assert.deepEqual(gateway.createLoginSessionInputs, [{
    accountKey: createHash("sha256")
      .update(`douyin-profile:${context.workspaceId}`, "utf8")
      .digest("hex")
  }]);
  await assert.rejects(restarted.createLoginSessionIdempotently(context, { platform: "douyin" }, "key", "different"), { code: "idempotency_key_conflict" });
});

test("reserves a create key before upstream work so concurrent calls issue one QR session", async () => {
  const gateway = new Gateway();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  gateway.createLoginSession = async () => { gateway.createLoginSessionCalls += 1; await gate; return { sessionId: "session-a", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", qrStatus: "ready", loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; };
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
    return { sessionId: "session-cross-process", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", qrStatus: "ready", loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null };
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

test("reuses one unexpired awaiting login session across different idempotency keys in a workspace", async () => {
  const gateway = new Gateway();
  gateway.getLoginSession = async (sessionId?: string) => ({
    sessionId: sessionId ?? "session-a",
    state: "awaiting_scan" as const,
    qrImageDataUrl: null,
    qrStatus: "opening" as const,
    loginPage: null,
    expiresAt: "2026-08-24T00:01:00.000Z",
    accountHandle: null,
    accountDisplayName: null,
    loginStateVersion: null
  });
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = () => new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `workspace-session-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });

  const first = await service().createLoginSessionIdempotently(
    context, { platform: "douyin" }, "first-browser-key", "hash"
  );
  const refreshed = await service().createLoginSessionIdempotently(
    context, { platform: "douyin" }, "second-browser-key", "hash"
  );

  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(refreshed.view.id, first.view.id);
  assert.equal(refreshed.replayed, false);
  assert.equal(refreshed.headers["Idempotency-Replayed"], "true");
  assert.equal(refreshed.view.state, "awaiting_scan");
  assert.equal(refreshed.view.qrStatus, "opening");
});

test("does not publish a cancelled login session when cancellation finishes during the upstream reuse check", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `cancel-race-upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  let releaseUpstreamCheck!: () => void;
  let upstreamCheckStarted!: () => void;
  const upstreamCheckGate = new Promise<void>((resolve) => {
    releaseUpstreamCheck = resolve;
  });
  const upstreamCheckEntered = new Promise<void>((resolve) => {
    upstreamCheckStarted = resolve;
  });
  gateway.getLoginSession = async (sessionId?: string) => {
    upstreamCheckStarted();
    await upstreamCheckGate;
    return {
      sessionId: sessionId ?? "missing",
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `cancel-race-public-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-race-first", "hash"
  );
  const replacementPromise = service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-race-second", "hash"
  );
  await upstreamCheckEntered;
  await service.cancelLoginSession(context, first.view.id);
  assert.equal(await repository.findLoginSession(
    context.workspaceId, first.view.id
  ), null);
  releaseUpstreamCheck();

  const replacement = await replacementPromise;

  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.notEqual(replacement.view.id, first.view.id);
  assert.equal(replacement.view.id, "cancel-race-public-2");
});

test("marks a login session cancelling before the remote disconnect can publish an old reuse", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `begin-cancel-upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  const disconnectEntered = new Promise<void>((resolve) => {
    disconnectStarted = resolve;
  });
  gateway.disconnectLoginSession = async () => {
    gateway.disconnectLoginSessionCalls += 1;
    disconnectStarted();
    await disconnectGate;
  };
  let reuseChecks = 0;
  gateway.getLoginSession = async (sessionId?: string) => {
    reuseChecks += 1;
    return {
      sessionId: sessionId ?? "missing",
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `begin-cancel-public-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "begin-cancel-first", "hash"
  );
  const cancellation = service.cancelLoginSession(context, first.view.id);
  await disconnectEntered;
  const replacementPromise = service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "begin-cancel-second", "hash"
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseDisconnect();

  const [replacement] = await Promise.all([replacementPromise, cancellation]);

  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.equal(reuseChecks, 0);
  assert.notEqual(replacement.view.id, first.view.id);
  assert.equal(replacement.view.id, "begin-cancel-public-2");
  assert.equal(await repository.findLoginSession(
    context.workspaceId, first.view.id
  ), null);
});

test("an in-flight reuse cannot survive pre-disconnect cancellation or delete its replacement", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `combined-race-upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  let releaseReuseGet!: () => void;
  let reuseGetStarted!: () => void;
  const reuseGetGate = new Promise<void>((resolve) => {
    releaseReuseGet = resolve;
  });
  const reuseGetEntered = new Promise<void>((resolve) => {
    reuseGetStarted = resolve;
  });
  let getCalls = 0;
  gateway.getLoginSession = async (sessionId?: string) => {
    getCalls += 1;
    if (getCalls === 1) {
      reuseGetStarted();
      await reuseGetGate;
    }
    return {
      sessionId: sessionId ?? "missing",
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  const disconnectEntered = new Promise<void>((resolve) => {
    disconnectStarted = resolve;
  });
  gateway.disconnectLoginSession = async () => {
    gateway.disconnectLoginSessionCalls += 1;
    disconnectStarted();
    await disconnectGate;
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `combined-race-public-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "combined-race-first", "hash"
  );
  const replacementPromise = service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "combined-race-second", "hash"
  );
  await reuseGetEntered;
  const cancellation = service.cancelLoginSession(context, first.view.id);
  await disconnectEntered;
  releaseReuseGet();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(gateway.createLoginSessionCalls, 1);
  releaseDisconnect();
  await cancellation;
  const replacement = await replacementPromise;
  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.notEqual(replacement.view.id, first.view.id);

  const reusedReplacement = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "combined-race-third", "hash"
  );

  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.equal(reusedReplacement.view.id, replacement.view.id);
  assert.equal(await repository.findLoginSession(
    context.workspaceId, first.view.id
  ), null);
  assert.equal((await repository.findLoginSession(
    context.workspaceId, replacement.view.id
  ))?.upstreamId, "combined-race-upstream-2");
});

test("a failed remote cancel restores the old id as the reusable workspace opening", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `cancel-retry-upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  gateway.getLoginSession = async (sessionId?: string) => ({
    sessionId: sessionId ?? "missing",
    state: "awaiting_scan" as const,
    qrImageDataUrl: null,
    qrStatus: "opening" as const,
    loginPage: null,
    expiresAt: "2026-08-24T00:01:00.000Z",
    accountHandle: null,
    accountDisplayName: null,
    loginStateVersion: null
  });
  let failDisconnect = true;
  gateway.disconnectLoginSession = async () => {
    gateway.disconnectLoginSessionCalls += 1;
    if (failDisconnect) throw new Error("disconnect_failed");
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `cancel-retry-public-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-retry-first", "hash"
  );

  await assert.rejects(service.cancelLoginSession(context, first.view.id),
    /disconnect_failed/u);
  assert.equal((await repository.findLoginSession(
    context.workspaceId, first.view.id
  ))?.upstreamId, "cancel-retry-upstream-1");

  const replacement = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-retry-second", "hash"
  );
  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(replacement.view.id, first.view.id);

  failDisconnect = false;
  await service.cancelLoginSession(context, first.view.id);
  assert.equal(await repository.findLoginSession(
    context.workspaceId, first.view.id
  ), null);
  const reusedReplacement = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-retry-third", "hash"
  );

  assert.equal(gateway.disconnectLoginSessionCalls, 2);
  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.notEqual(reusedReplacement.view.id, replacement.view.id);
});

test("keeps pending login session reuse isolated by workspace", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `workspace-session-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z"
  });

  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "workspace-a-key", "hash"
  );
  const second = await service.createLoginSessionIdempotently(
    otherWorkspace, { platform: "douyin" }, "workspace-b-key", "hash"
  );

  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.notEqual(second.view.id, first.view.id);
});

test("allows a new login session after the workspace session expires or becomes terminal", async () => {
  for (const condition of ["expired", "terminal"] as const) {
    const gateway = new Gateway();
    gateway.createLoginSession = async () => {
      gateway.createLoginSessionCalls += 1;
      return {
        sessionId: `upstream-${condition}-${gateway.createLoginSessionCalls}`,
        state: "awaiting_scan" as const,
        qrImageDataUrl: null,
        qrStatus: "opening" as const,
        loginPage: null,
        expiresAt: condition === "expired"
          ? "2026-08-24T00:00:01.000Z"
          : "2026-08-24T00:10:00.000Z",
        accountHandle: null,
        accountDisplayName: null,
        loginStateVersion: null
      };
    };
    gateway.getLoginSession = async (sessionId?: string) => ({
      sessionId: sessionId ?? "missing",
      state: "failed" as const,
      qrImageDataUrl: null,
      qrStatus: "network_error" as const,
      loginPage: null,
      failureCode: "douyin_login_open_failed" as const,
      expiresAt: "2026-08-24T00:10:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    });
    const repository = new InMemoryAcquisitionSocialAccountRepository();
    let now = "2026-08-24T00:00:00.000Z";
    let nextId = 0;
    const service = new AcquisitionSocialAccountService({
      repository,
      gateway,
      idFactory: () => `${condition}-session-${++nextId}`,
      now: () => now,
      pendingPollMs: 1
    });
    const first = await service.createLoginSessionIdempotently(
      context, { platform: "douyin" }, `${condition}-first-key`, "hash"
    );
    if (condition === "expired") now = "2026-08-24T00:00:02.000Z";

    const replacement = await service.createLoginSessionIdempotently(
      context, { platform: "douyin" }, `${condition}-second-key`, "hash"
    );

    assert.equal(gateway.createLoginSessionCalls, 2, condition);
    assert.notEqual(replacement.view.id, first.view.id, condition);
  }
});

test("allows a new login session when the upstream has already removed the prior session", async () => {
  const gateway = new Gateway();
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    return {
      sessionId: `removed-upstream-${gateway.createLoginSessionCalls}`,
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:10:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `removed-session-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z"
  });
  await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "removed-first-key", "hash"
  );
  gateway.getLoginSession = async () => {
    throw Object.assign(new Error("douyin_login_session_expired"), {
      code: "douyin_login_session_expired"
    });
  };

  const replacement = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "removed-second-key", "hash"
  );

  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.equal(replacement.view.id, "removed-session-2");
});

test("cancelling the current workspace opening releases it for reconnect", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway,
    idFactory: () => `cancel-reconnect-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z"
  });
  const first = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-reconnect-first", "hash"
  );

  await service.cancelLoginSession(context, first.view.id);
  assert.equal(await repository.findLoginSession(
    context.workspaceId, first.view.id
  ), null);
  const immediatelyAvailable = await repository.claimLoginOpening({
    workspaceId: context.workspaceId,
    attemptedAt: "2026-08-24T00:00:00.000Z",
    leaseOwner: "after-cancel",
    leaseDurationMs: 1_000
  });
  assert.equal(immediatelyAvailable.kind, "claimed");
  assert.equal(immediatelyAvailable.kind === "claimed"
    ? immediatelyAvailable.fencingToken : null, 1,
  "cancel removes the attached opening instead of leaving an orphan to reclaim");
  if (immediatelyAvailable.kind === "claimed") {
    await repository.releaseLoginOpening(immediatelyAvailable);
  }
  const reconnected = await service.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "cancel-reconnect-second", "hash"
  );

  assert.equal(gateway.disconnectLoginSessionCalls, 1);
  assert.equal(gateway.createLoginSessionCalls, 2);
  assert.notEqual(reconnected.view.id, first.view.id);
});

test("a late active GET cannot bind after concurrent DELETE fenced the login session", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: () => "late-active-account", now: () => "2026-08-24T00:00:00.000Z" });
  const created = await service.createLoginSession(context, { platform: "douyin" });
  let resolveGet!: (value: Awaited<ReturnType<Gateway["getLoginSession"]>>) => void;
  gateway.getLoginSession = async () => new Promise((resolve) => { resolveGet = resolve; });
  let releaseDelete!: () => void;
  gateway.disconnectLoginSession = async () => new Promise<void>((resolve) => { releaseDelete = resolve; });
  const lateGet = service.getLoginSession(context, created.id);
  await Promise.resolve();
  const deleting = service.cancelLoginSession(context, created.id);
  await Promise.resolve();
  resolveGet({ sessionId: "session-a", state: "active", qrImageDataUrl: null,
    qrStatus: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleA,
    loginPage: null, accountDisplayName: "Douyin", loginStateVersion: 1 });
  await assert.rejects(lateGet, { code: "douyin_login_session_not_active" });
  assert.equal(await repository.findByWorkspaceAndPlatform(context.workspaceId, "douyin"), null);
  releaseDelete();
  await deleting;
});

test("an identical already-active fast path still honors a deleted login-session fence", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: () => "identical-active", now: () => "2026-08-24T00:00:00.000Z" });
  const created = await service.createLoginSession(context, { platform: "douyin" });
  await service.bindActiveSession(context, created.id);
  let resolveGet!: (value: Awaited<ReturnType<Gateway["getLoginSession"]>>) => void;
  gateway.getLoginSession = async () => new Promise((resolve) => { resolveGet = resolve; });
  let releaseDelete!: () => void;
  gateway.disconnectLoginSession = async () => new Promise<void>((resolve) => { releaseDelete = resolve; });
  const lateGet = service.getLoginSession(context, created.id);
  await Promise.resolve();
  const deleting = service.cancelLoginSession(context, created.id);
  await Promise.resolve();
  resolveGet({ sessionId: "session-a", state: "active", qrImageDataUrl: null,
    qrStatus: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: boundHandleA,
    loginPage: null, accountDisplayName: "Douyin", loginStateVersion: 1 });
  await assert.rejects(lateGet, {
    code: "douyin_login_session_not_active"
  });
  releaseDelete();
  await deleting;
});

test("repository rejects a login-session fence whose upstream id does not match", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.saveLoginSession({ id: "public-session", workspaceId: context.workspaceId,
    upstreamId: "expected-upstream", expiresAt: "2026-08-24T00:01:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z" });
  const result = await repository.bindActiveFromLoginSession(context.workspaceId, "public-session",
    "wrong-upstream", { id: "candidate", workspaceId: context.workspaceId, platform: "douyin",
      accountHandle: boundHandleA, upstreamSessionId: "wrong-upstream", displayName: "Douyin",
      state: "active", loginStateVersion: 1, loginStateVersionHighWater: 1,
      revision: 1, etag: '"account-v1"', lastValidatedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  assert.equal(result, "login_session_stale");
});

test("a failed remote DELETE restores the fenced login session for retry", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({ repository, gateway,
    idFactory: () => "restore-delete-account", now: () => "2026-08-24T00:00:00.000Z" });
  const created = await service.createLoginSession(context, { platform: "douyin" });
  gateway.disconnectLoginSession = async () => { throw new Error("remote unavailable"); };
  await assert.rejects(service.cancelLoginSession(context, created.id), /remote unavailable/u);
  assert.equal((await repository.findLoginSession(context.workspaceId, created.id))?.id, created.id);
  const restoredOpening = await repository.claimLoginOpening({ workspaceId: context.workspaceId,
    attemptedAt: "2026-08-24T00:00:00.000Z", leaseOwner: "ordinary-reconnect",
    leaseDurationMs: 1_000 });
  assert.equal(restoredOpening.kind, "existing");
  assert.equal(restoredOpening.kind === "existing" ? restoredOpening.session.id : null, created.id,
    "restoring the opening prevents an ordinary reconnect from claiming a second session");
});

test("memory cancellation fence blocks create until successful completion", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.saveLoginSession({ id: "cancelled", workspaceId: context.workspaceId,
    upstreamId: "upstream", expiresAt: "2026-08-24T00:01:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z" });
  const fence = await repository.beginLoginSessionCancellation(context.workspaceId,
    "cancelled", "cancel-owner", "2026-08-24T00:01:00.000Z", "2026-08-24T00:00:00.000Z");
  assert.notEqual(fence, "login_session_stale");
  assert.equal((await repository.claimLoginOpening({ workspaceId: context.workspaceId,
    attemptedAt: "2026-08-24T00:00:01.000Z", leaseOwner: "creator",
    leaseDurationMs: 1_000 })).kind, "pending");
  assert.equal(fence === "login_session_stale" ? false
    : await repository.completeLoginSessionCancellation(fence, "cancelled"), true);
});

test("memory failed cancellation restores only its own fence", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.saveLoginSession({ id: "restored", workspaceId: context.workspaceId,
    upstreamId: "upstream", expiresAt: "2026-08-24T00:01:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z" });
  const fence = await repository.beginLoginSessionCancellation(context.workspaceId,
    "restored", "cancel-owner", "2026-08-24T00:01:00.000Z", "2026-08-24T00:00:00.000Z");
  assert.notEqual(fence, "login_session_stale");
  assert.equal(fence === "login_session_stale" ? false
    : await repository.restoreLoginSessionCancellation(fence, "restored", "2026-08-24T00:00:02.000Z"), true);
  assert.equal((await repository.claimLoginOpening({ workspaceId: context.workspaceId,
    attemptedAt: "2026-08-24T00:00:03.000Z", leaseOwner: "creator",
    leaseDurationMs: 1_000 })).kind, "existing");
  assert.equal(fence === "login_session_stale" ? true
    : await repository.completeLoginSessionCancellation({ ...fence, fencingToken: fence.fencingToken - 1 }, "restored"), false,
  "an older cancellation fence cannot delete the restored session");
});

test("different keys racing in one workspace cannot start two upstream login sessions", async () => {
  const gateway = new Gateway();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    entered();
    await gate;
    return {
      sessionId: "different-key-upstream",
      state: "awaiting_scan" as const,
      qrImageDataUrl: null,
      qrStatus: "opening" as const,
      loginPage: null,
      expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null,
      accountDisplayName: null,
      loginStateVersion: null
    };
  };
  gateway.getLoginSession = async () => ({
    sessionId: "different-key-upstream",
    state: "awaiting_scan" as const,
    qrImageDataUrl: null,
    qrStatus: "opening" as const,
    loginPage: null,
    expiresAt: "2026-08-24T00:01:00.000Z",
    accountHandle: null,
    accountDisplayName: null,
    loginStateVersion: null
  });
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const firstService = new AcquisitionSocialAccountService({
    repository, gateway, idFactory: () => "different-key-public", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1
  });
  const secondService = new AcquisitionSocialAccountService({
    repository, gateway, idFactory: () => "must-not-create", now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1
  });

  const first = firstService.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "concurrent-first-key", "hash"
  );
  await started;
  const second = secondService.createLoginSessionIdempotently(
    context, { platform: "douyin" }, "concurrent-second-key", "hash"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.createLoginSessionCalls, 1);
  release();

  const [created, reused] = await Promise.all([first, second]);
  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(reused.view.id, created.view.id);
});

test("releases failed create work and reclaims crashed or expired reservations", async () => {
  const gateway = new Gateway();
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let now = "2026-08-24T00:00:00.000Z";
  let fail = true;
  gateway.createLoginSession = async () => {
    gateway.createLoginSessionCalls += 1;
    if (fail) throw new Error("upstream failed");
    return { sessionId: `upstream-${gateway.createLoginSessionCalls}`, state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,cXI=", qrStatus: "ready", loginPage: null, expiresAt: "2026-08-24T00:20:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  };
  gateway.getLoginSession = async (sessionId?: string) => ({
    sessionId: sessionId ?? `upstream-${gateway.createLoginSessionCalls}`,
    state: "awaiting_scan" as const,
    qrImageDataUrl: null,
    qrStatus: "opening" as const,
    loginPage: null,
    expiresAt: "2026-08-24T00:20:00.000Z",
    accountHandle: null,
    accountDisplayName: null,
    loginStateVersion: null
  });
  const service = () => new AcquisitionSocialAccountService({ repository, gateway, idFactory: () => `local-${gateway.createLoginSessionCalls}`, now: () => now, replayTtlMs: 1_000, replayLeaseMs: 100, pendingPollMs: 1 });

  await assert.rejects(service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash"), /upstream failed/u);
  fail = false;
  const recovered = await service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash");
  assert.equal(recovered.replayed, false);

  now = "2026-08-24T00:00:02.000Z";
  const expiredReplay = await service().createLoginSessionIdempotently(context, { platform: "douyin" }, "failure-key", "hash");
  assert.equal(expiredReplay.replayed, false);
  assert.equal(gateway.createLoginSessionCalls, 2);

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

test("desktop login completion binds only the bounded public identity and replays exactly", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway: new Gateway(),
    idFactory: () => "desktop-account",
    now: () => "2026-09-03T04:00:00.000Z",
    leaseOwnerFactory: () => "desktop-login-owner"
  });
  const input = {
    accountHandle: boundHandleA,
    displayName: "  Desktop Douyin  ",
    loginStateVersion: 7
  };

  const first = await service.completeDesktopLogin(
    context, input, "desktop-login-key", "desktop-login-request-hash"
  );
  const replay = await service.completeDesktopLogin(
    context, input, "desktop-login-key", "desktop-login-request-hash"
  );
  const listed = await service.list(context);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.view, first.view);
  assert.equal(first.view.displayName, "Desktop Douyin");
  assert.equal(first.view.loginStateVersion, 7);
  const serialized = JSON.stringify(first.view);
  assert.equal(serialized.includes(boundHandleA), false);
  assert.equal(serialized.includes("upstreamSessionId"), false);
  const upstreamProfileKey = createHash("sha256")
    .update(`douyin-profile:${context.workspaceId}`, "utf8")
    .digest("hex");
  for (const [label, output] of [["completeDesktopLogin", first],
    ["completeDesktopLogin replay", replay], ["list", listed]] as const) {
    assertRecursivelyPrivateDesktopDataAbsent(label, output,
      [boundHandleA, "session-a", upstreamProfileKey]);
  }
});

test("desktop login completion rejects changed replays, stale versions, and active handle swaps", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let id = 0;
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway: new Gateway(),
    idFactory: () => `desktop-account-${++id}`,
    now: () => "2026-09-03T04:00:00.000Z",
    leaseOwnerFactory: () => `desktop-login-owner-${id}`
  });
  await service.completeDesktopLogin(context, {
    accountHandle: boundHandleA,
    displayName: "Desktop Douyin",
    loginStateVersion: 7
  }, "desktop-login-key", "desktop-login-request-hash");

  await assert.rejects(service.completeDesktopLogin(context, {
    accountHandle: boundHandleA,
    displayName: "Changed",
    loginStateVersion: 8
  }, "desktop-login-key", "changed-request-hash"), {
    code: "idempotency_key_conflict"
  });
  await assert.rejects(service.completeDesktopLogin(context, {
    accountHandle: boundHandleA,
    displayName: "Desktop Douyin",
    loginStateVersion: 6
  }, "stale-desktop-login-key", "stale-request-hash"), {
    code: "douyin_login_state_stale"
  });
  await assert.rejects(service.completeDesktopLogin(context, {
    accountHandle: boundHandleB,
    displayName: "Different Account",
    loginStateVersion: 8
  }, "conflicting-desktop-login-key", "conflicting-request-hash"), {
    code: "douyin_active_account_conflict"
  });
});

test("desktop executor binding is fenced, leased for exactly 90 seconds, and hash-free", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const actions = new InMemoryAcquisitionOutreachBatchRepository({
    memoryTransactions: coordinator
  });
  const repository = new InMemoryAcquisitionSocialAccountRepository(coordinator);
  const installations = new InMemoryDesktopInstallationRepository({
    memoryTransactions: coordinator,
    socialAccounts: repository,
    outreachActions: actions
  });
  const installationA = "A".repeat(43);
  const installationB = "B".repeat(43);
  for (const [installationId, suffix] of [[installationA, "a"], [installationB, "b"]]) {
    const deviceIdHash = desktopInstallationIdHash(installationId);
    await installations.createEnrollment({
      workspaceId: "workspace-a", userId: "user-a", teamId: "team-a",
      deviceIdHash, protocolVersion: 1,
      enrollmentTokenHash: `sha256:${suffix.repeat(64)}`,
      idempotencyKeyHash: suffix.repeat(64), requestHash: suffix.repeat(64),
      expiresAt: "2026-09-04T00:01:00.000Z", createdAt: "2026-09-04T00:00:00.000Z",
      consumedAt: null
    });
    await installations.consumeEnrollment({ deviceIdHash,
      enrollmentTokenHash: `sha256:${suffix.repeat(64)}`,
      deviceCredentialHash: `sha256:${suffix.repeat(64)}`,
      protocolVersion: 1, consumedAt: "2026-09-04T00:00:01.000Z" });
  }
  await repository.upsert({
    id: "account-a", workspaceId: "workspace-a", platform: "douyin",
    accountHandle: boundHandleA, upstreamSessionId: null, displayName: "Douyin",
    state: "active", loginStateVersion: 7, loginStateVersionHighWater: 7,
    executorMode: null, executorDeviceIdHash: null,
    executorBindingGeneration: 0, executorLeaseExpiresAt: null,
    revision: 1, etag: '"account-v1"', lastValidatedAt: "2026-09-04T00:00:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z"
  });
  const service = new AcquisitionDesktopInstallationService({ repository: installations,
    secret: "task-3-secret-material-is-at-least-32-bytes-long",
    isActiveMembership: async () => true,
    now: () => "2026-09-04T00:00:10.000Z" });
  const bindingInput = (installationId: string, expectedGeneration: number,
    handoff: boolean) => ({ accountHandle: boundHandleA, loginStateVersion: 7,
    installationId, expectedGeneration, handoff });
  const bindingScope = { workspaceId: "workspace-a", userId: "user-a", teamId: "team-a" };

  const first = await service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationA, 0, false), "binding-key-a", "a".repeat(64));
  assert.deepEqual(first, { accountId: "account-a", executorMode: "desktop",
    bindingGeneration: 1, leaseExpiresAt: "2026-09-04T00:01:40.000Z",
    ownedByInstallation: true });
  const firstStored = await repository.findById("workspace-a", "account-a");
  assert.deepEqual({ revision: firstStored?.revision, etag: firstStored?.etag }, {
    revision: 2, etag: '"account-v2"'
  }, "Memory binding must bump the same revision/etag fence as MySQL");
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("deviceIdHash"), false);
  assert.equal(serialized.includes(installationA), false);
  await assert.rejects(service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationB, 1, false), "binding-key-b", "b".repeat(64)), {
    code: "desktop_executor_handoff_required"
  });
  const replayed = await new AcquisitionDesktopInstallationService({
    repository: installations,
    secret: "task-3-secret-material-is-at-least-32-bytes-long",
    isActiveMembership: async () => true,
    now: () => "2026-09-04T00:00:30.000Z"
  }).bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationA, 0, false), "binding-key-a", "a".repeat(64));
  assert.deepEqual(replayed, first, "durable replay must retain the original lease");
  await assert.rejects(service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationA, 1, false), "binding-key-a", "c".repeat(64)), {
    code: "idempotency_key_conflict"
  });
  await assert.rejects(service.bindDesktopExecutor(bindingScope, "another-account",
    bindingInput(installationA, 1, false), "binding-key-a", "9".repeat(64)), {
    code: "idempotency_key_conflict"
  }, "binding replay scope is workspace + operation + key, not account");
  const renewed = await service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationA, 1, false), "binding-key-renew", "d".repeat(64));
  assert.equal(renewed.bindingGeneration, 1);
  const [handoffOutcome, staleRenewOutcome] = await Promise.allSettled([
    service.bindDesktopExecutor(bindingScope, "account-a",
      bindingInput(installationB, 1, true), "binding-key-handoff", "e".repeat(64)),
    service.renewDesktopExecutor({ workspaceId: "workspace-a", userId: "user-a",
      teamId: "team-a", deviceIdHash: desktopInstallationIdHash(installationA),
      protocolVersion: 1 }, [{ accountId: "account-a", accountHandle: boundHandleA,
      loginStateVersion: 7, bindingGeneration: 1 }], "2026-09-04T00:00:20.000Z")
  ]);
  assert.equal(handoffOutcome.status, "fulfilled");
  assert.equal(staleRenewOutcome.status, "rejected");
  if (handoffOutcome.status !== "fulfilled") throw handoffOutcome.reason;
  const handedOff = handoffOutcome.value;
  assert.equal(handedOff.bindingGeneration, 2);
  await assert.rejects(service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationA, 1, true), "binding-key-stale", "f".repeat(64)), {
    code: "desktop_executor_generation_stale"
  });
  const renewedBindings = await service.renewDesktopExecutor({ workspaceId: "workspace-a",
    userId: "user-a", teamId: "team-a",
    deviceIdHash: desktopInstallationIdHash(installationB), protocolVersion: 1 }, [{
      accountId: "account-a", accountHandle: boundHandleA,
      loginStateVersion: 7, bindingGeneration: 2
    }], "2026-09-04T00:00:20.000Z");
  assert.equal(renewedBindings[0]?.leaseExpiresAt, "2026-09-04T00:01:50.000Z");
  assert.equal(renewedBindings[0]?.bindingGeneration, 2);
  for (const [label, output] of [["bind", first], ["bind replay", replayed],
    ["bind renewal", renewed], ["handoff", handedOff],
    ["renew", renewedBindings]] as const) {
    assertRecursivelyPrivateDesktopDataAbsent(label, output, [
      installationA,
      installationB,
      desktopInstallationIdHash(installationA),
      desktopInstallationIdHash(installationB),
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      boundHandleA
    ]);
  }
  const beforeRevoke = await repository.findById("workspace-a", "account-a");
  const [revokeOutcome, staleBindOutcome] = await Promise.allSettled([
    service.revoke(bindingScope, installationB),
    service.bindDesktopExecutor(bindingScope, "account-a",
      bindingInput(installationB, 2, false), "binding-after-revoke-race",
      "8".repeat(64))
  ]);
  assert.deepEqual(revokeOutcome, { status: "fulfilled", value: true });
  assert.equal(staleBindOutcome.status, "rejected");
  const invalidated = await repository.findById("workspace-a", "account-a");
  assert.deepEqual({ mode: invalidated?.executorMode,
    device: invalidated?.executorDeviceIdHash,
    generation: invalidated?.executorBindingGeneration,
    lease: invalidated?.executorLeaseExpiresAt,
    revision: invalidated?.revision, etag: invalidated?.etag }, {
    mode: "desktop", device: desktopInstallationIdHash(installationB),
    generation: 3, lease: "2026-09-04T00:00:10.000Z",
    revision: (beforeRevoke?.revision ?? 0) + 1,
    etag: `"account-v${(beforeRevoke?.revision ?? 0) + 1}"`
  });
  await installations.createEnrollment({ workspaceId: "workspace-a", userId: "user-a",
    teamId: "team-a", deviceIdHash: desktopInstallationIdHash(installationB),
    protocolVersion: 1, enrollmentTokenHash: `sha256:${"c".repeat(64)}`,
    idempotencyKeyHash: "c".repeat(64), requestHash: "c".repeat(64),
    expiresAt: "2026-09-04T00:01:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z", consumedAt: null });
  await installations.consumeEnrollment({
    deviceIdHash: desktopInstallationIdHash(installationB),
    enrollmentTokenHash: `sha256:${"c".repeat(64)}`,
    deviceCredentialHash: `sha256:${"d".repeat(64)}`, protocolVersion: 1,
    consumedAt: "2026-09-04T00:00:01.000Z" });
  const rebound = await service.bindDesktopExecutor(bindingScope, "account-a",
    bindingInput(installationB, 3, false), "binding-after-reenroll",
    "7".repeat(64));
  assert.equal(rebound.bindingGeneration, 3,
    "re-enrollment cannot recreate generation 1 or revive an old claim");
  const beforeDisconnect = (await repository.findById("workspace-a", "account-a"))!;
  await repository.disconnect("workspace-a", "account-a", beforeDisconnect.etag, "2026-09-04T00:00:30.000Z");
  const disconnected = (await repository.findById("workspace-a", "account-a"))!;
  assert.equal(disconnected.executorBindingGeneration, 0);
  assert.equal(disconnected.executorBindingGenerationHighWater, 3);
  await repository.bindActive({ ...disconnected, state: "active", accountHandle: boundHandleA,
    loginStateVersion: 8, loginStateVersionHighWater: 8 });
  const afterReconnect = await service.bindDesktopExecutor(bindingScope, "account-a",
    { ...bindingInput(installationB, 0, false), loginStateVersion: 8 }, "binding-after-disconnect", "9".repeat(64));
  assert.equal(afterReconnect.bindingGeneration, 4, "disconnect/relogin must exceed the retained desktop generation");
});

test("login-version change fences a desktop binding once and disconnect clears it privately", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await repository.upsert({ id: "bound-account", workspaceId: context.workspaceId,
    platform: "douyin", accountHandle: boundHandleA, upstreamSessionId: null,
    displayName: "Douyin", state: "active", loginStateVersion: 7,
    loginStateVersionHighWater: 7, executorMode: "desktop",
    executorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    executorBindingGeneration: 4,
    executorLeaseExpiresAt: "2026-09-04T00:01:30.000Z", revision: 1,
    etag: '"account-v1"', lastValidatedAt: "2026-09-04T00:00:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" });
  const service = new AcquisitionSocialAccountService({ repository,
    gateway: new Gateway(), now: () => "2026-09-04T00:00:10.000Z" });

  const login = await service.completeDesktopLogin(context, {
    accountHandle: boundHandleA, displayName: "Douyin", loginStateVersion: 8
  }, "login-version-key", "login-version-request");
  const fenced = await repository.findById(context.workspaceId, "bound-account");
  assert.equal(fenced?.executorBindingGeneration, 5);
  assert.equal(JSON.stringify(login).includes("executorDeviceIdHash"), false);
  await service.disconnect(context, "bound-account", login.view.etag);
  const disconnected = await repository.findById(context.workspaceId, "bound-account");
  assert.deepEqual({ mode: disconnected?.executorMode,
    generation: disconnected?.executorBindingGeneration,
    lease: disconnected?.executorLeaseExpiresAt }, {
    mode: null, generation: 0, lease: null
  });
});

test("failed memory binding rolls back account and replay then its shared queue recovers", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const accounts = new InMemoryAcquisitionSocialAccountRepository(coordinator);
  const actions = new InMemoryAcquisitionOutreachBatchRepository({
    memoryTransactions: coordinator
  });
  const installations = new InMemoryDesktopInstallationRepository({
    memoryTransactions: coordinator, socialAccounts: accounts, outreachActions: actions,
    failBindingWriteAt: 1
  });
  const installationId = "C".repeat(43);
  const deviceIdHash = desktopInstallationIdHash(installationId);
  await installations.createEnrollment({ workspaceId: context.workspaceId,
    userId: "user-a", teamId: "team-a", deviceIdHash, protocolVersion: 1,
    enrollmentTokenHash: `sha256:${"a".repeat(64)}`,
    idempotencyKeyHash: "a".repeat(64), requestHash: "a".repeat(64),
    expiresAt: "2026-09-04T00:01:00.000Z", createdAt: "2026-09-04T00:00:00.000Z",
    consumedAt: null });
  await installations.consumeEnrollment({ deviceIdHash,
    enrollmentTokenHash: `sha256:${"a".repeat(64)}`,
    deviceCredentialHash: `sha256:${"b".repeat(64)}`, protocolVersion: 1,
    consumedAt: "2026-09-04T00:00:01.000Z" });
  await accounts.upsert({ id: "failure-account", workspaceId: context.workspaceId,
    platform: "douyin", accountHandle: boundHandleA, upstreamSessionId: null,
    displayName: "Douyin", state: "active", loginStateVersion: 1,
    loginStateVersionHighWater: 1, executorMode: null, executorDeviceIdHash: null,
    executorBindingGeneration: 0, executorLeaseExpiresAt: null, revision: 1,
    etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" });
  const service = new AcquisitionDesktopInstallationService({ repository: installations,
    secret: "task-3-secret-material-is-at-least-32-bytes-long",
    isActiveMembership: async () => true, now: () => "2026-09-04T00:00:10.000Z" });
  const command = { accountHandle: boundHandleA, loginStateVersion: 1,
    installationId, expectedGeneration: 0, handoff: false };

  await assert.rejects(service.bindDesktopExecutor({ workspaceId: context.workspaceId,
    userId: "user-a", teamId: "team-a" }, "failure-account", command,
  "failure-binding-key", "a".repeat(64)), { code: "desktop_executor_binding_unavailable" });
  assert.equal((await accounts.findById(context.workspaceId, "failure-account"))
    ?.executorBindingGeneration, 0);
  const recovered = await service.bindDesktopExecutor({ workspaceId: context.workspaceId,
    userId: "user-a", teamId: "team-a" }, "failure-account", command,
  "failure-binding-key", "a".repeat(64));
  assert.equal(recovered.bindingGeneration, 1);
});

test("memory active binds derive executor fencing from the latest locked account", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const repository = new InMemoryAcquisitionSocialAccountRepository(coordinator);
  const deviceA = `sha256:${"a".repeat(64)}`;
  const deviceB = `sha256:${"b".repeat(64)}`;
  const base = { id: "race-account", workspaceId: context.workspaceId,
    platform: "douyin" as const, accountHandle: boundHandleA,
    upstreamSessionId: null, displayName: "Douyin", state: "active" as const,
    loginStateVersion: 7, loginStateVersionHighWater: 7,
    executorMode: "desktop" as const, executorDeviceIdHash: deviceA,
    executorBindingGeneration: 4,
    executorLeaseExpiresAt: "2026-09-04T00:02:00.000Z", revision: 4,
    etag: '"account-v4"', lastValidatedAt: "2026-09-04T00:00:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z" };
  await repository.upsert(base);
  const staleCandidate = { ...base, loginStateVersion: 8,
    loginStateVersionHighWater: 8, executorBindingGeneration: 5,
    revision: 5, etag: '"account-v5"', updatedAt: "2026-09-04T00:00:10.000Z" };
  await coordinator.transaction((token) => {
    repository.setDesktopExecutorBindingRecord(token, { ...base,
      executorDeviceIdHash: deviceB, executorBindingGeneration: 5,
      revision: 5, etag: '"account-v5"', updatedAt: "2026-09-04T00:00:05.000Z" });
  });

  const saved = await repository.bindActive(staleCandidate);

  assert.notEqual(saved, "active_handle_conflict");
  if (saved === "active_handle_conflict") throw new Error("unexpected conflict");
  assert.deepEqual({ device: saved.executorDeviceIdHash,
    generation: saved.executorBindingGeneration,
    lease: saved.executorLeaseExpiresAt, revision: saved.revision }, {
    device: deviceB, generation: 6,
    lease: "2026-09-04T00:02:00.000Z", revision: 6
  });
});
