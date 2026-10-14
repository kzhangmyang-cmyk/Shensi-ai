import { strict as assert } from "node:assert";
import test from "node:test";
import { DESKTOP_CHANNELS } from "../src/shared/contracts.ts";
import { registerDesktopIpc as registerIpc, type DesktopIpcOptions } from "../src/main/desktop-ipc.ts";
const trustedFrame = { url: "http://127.0.0.1:45678/" };
const trustedSender = { mainFrame: trustedFrame, send() {}, isDestroyed: () => false };
const trustedEvent = { sender: trustedSender, senderFrame: trustedFrame };
const registerDesktopIpc = (options: Omit<DesktopIpcOptions, "authorizedSender"> & Partial<Pick<DesktopIpcOptions, "authorizedSender">>) =>
  registerIpc({ authorizedSender: () => trustedSender, ...options });
import type { DesktopOutreachCoordinatorView } from "../src/shared/contracts.ts";

test("collection control validates actions and forwards the same task without starting another", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: string[] = [];
  const registration = registerDesktopIpc({ localOrigin: trustedFrame.url,
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: () => {} },
    manager: { client: { controlDouyinCollection: async (id: string, action: string) => { calls.push(`${id}:${action}`); return { taskId: id }; } } },
    appVersion: () => "test", openLogsDirectory: async () => {}, runtimeInfo: () => { throw Error("unused"); } });
  try {
    const handler = handlers.get(DESKTOP_CHANNELS.controlDouyinCollection)!;
    for (const action of ["pause", "resume", "stop"]) await handler(trustedEvent, { taskId: "same-job", action });
    assert.deepEqual(calls, ["same-job:pause", "same-job:resume", "same-job:stop"]);
    await assert.rejects(handler(trustedEvent, { taskId: "same-job", action: "restart" }));
    assert.equal(calls.length, 3);
  } finally { registration.dispose(); }
});

test("checking a persisted local login never creates a login session and restores collection identity", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let logins = 0;
  const handle = `dyacct_${"a".repeat(64)}`;
  const registration = registerDesktopIpc({ localOrigin: trustedFrame.url,
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: () => {} },
    manager: { client: {
      startDouyinLogin: async () => { logins++; throw Error("must not relogin"); },
      resolveDouyinIdentity: async (accountKey: string) => ({ accountKey, accountHandle: handle,
        accountDisplayName: "hkko", loginStateVersion: 7, profileAvailable: true }),
      startDouyinCollection: async (account: string) => ({ account })
    } }, appVersion: () => "test", openLogsDirectory: async () => {},
    runtimeInfo: () => { throw Error("unused"); } });
  const check = handlers.get("shensi:desktop:check-douyin-login");
  const coldCollected = await handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
    accountId: "workspace", task: { taskId: "cold-task", loginStateVersion: 7, keywords: ["除尘"],
      maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: false,
      collectDemandComments: true, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.deepEqual(coldCollected, { account: handle });
  assert.equal(typeof check, "function", "a check needs a read-only IPC operation");
  assert.deepEqual(await check!(trustedEvent, { accountId: "workspace" }), {
    accountHandle: handle, accountDisplayName: "hkko", loginStateVersion: 7 });
  assert.equal(logins, 0);
  const collected = await handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
    accountId: "workspace", task: { taskId: "task-1", loginStateVersion: 7, keywords: ["除尘"],
      maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true,
      collectDemandComments: true, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.deepEqual(collected, { account: handle });
  registration.dispose();
});

test("a persisted-login check cannot restore collection authority after its account session is cancelled", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let resolveIdentity!: (identity: unknown) => void;
  const pendingIdentity = new Promise((resolve) => { resolveIdentity = resolve; });
  const oldIdentity = { accountKey: "a".repeat(64), accountHandle: `dyacct_${"a".repeat(64)}`,
    accountDisplayName: "旧账号", loginStateVersion: 7, profileAvailable: true };
  let starts = 0;
  const registration = registerDesktopIpc({ localOrigin: trustedFrame.url,
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler() {} },
    manager: { client: {
      startDouyinLogin: async () => ({ sessionId: `login-${++starts}`, state: "active",
        interactionSurface: "external_window", runtimeState: "stopped", authState: "authenticated",
        taskState: "completed", diagnostic: null, expiresAt: "2099-01-01T00:00:00.000Z",
        accountHandle: starts === 1 ? oldIdentity.accountHandle : `dyacct_${"b".repeat(64)}`,
        accountDisplayName: starts === 1 ? "旧账号" : "新账号", loginStateVersion: starts === 1 ? 7 : 8,
        failureCode: null }),
      resolveDouyinIdentity: async () => pendingIdentity,
      cancelDouyinLogin: async () => undefined,
      startDouyinCollection: async (account: string) => ({ account })
    } }, appVersion: () => "test", openLogsDirectory: async () => undefined,
    runtimeInfo: () => { throw Error("unused"); } });
  const collect = (loginStateVersion: number) => handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
    accountId: "workspace", task: { taskId: "task-1", loginStateVersion, keywords: ["除尘"],
      maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true,
      collectDemandComments: true, deadlineAt: "2099-01-01T00:00:00.000Z" } });
  try {
    await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
    const checked = handlers.get(DESKTOP_CHANNELS.checkDouyinLogin)!(trustedEvent, { accountId: "workspace" });
    await handlers.get(DESKTOP_CHANNELS.cancelDouyinLogin)!(trustedEvent, { sessionId: "login-1" });
    resolveIdentity(oldIdentity);
    await assert.rejects(checked, /desktop_login_identity_unavailable/u);
    await assert.rejects(collect(7), /desktop_login_identity_unavailable/u);
    await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
    assert.deepEqual(await collect(8), { account: `dyacct_${"b".repeat(64)}` },
      "a fresh explicit login can restore collection authority after cancellation");
  } finally { registration.dispose(); }
});

for (const channel of [DESKTOP_CHANNELS.checkDouyinLogin,
  DESKTOP_CHANNELS.getDouyinLoginStatus, DESKTOP_CHANNELS.confirmDouyinLogin]) {
  for (const result of ["active", "failed", "error"] as const) {
    test(`${channel} late ${result} result cannot replace or erase a fresh login identity`, async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      let settle!: () => void;
      const pending = new Promise((resolve, reject) => { settle = () => result === "error"
        ? reject(Error("old_detection_failed")) : resolve({ ...login("old-login", 7), state: result }); });
      const login = (sessionId: string, version: number) => ({ sessionId, state: "active",
        interactionSurface: "external_window", runtimeState: "stopped", authState: "authenticated",
        taskState: "completed", diagnostic: null, expiresAt: "2099-01-01T00:00:00.000Z",
        accountKey: "a".repeat(64), accountHandle: `dyacct_${String(version).repeat(64)}`,
        accountDisplayName: "隔离账号", loginStateVersion: version, profileAvailable: true, failureCode: null });
      let starts = 0;
      const registration = registerDesktopIpc({ localOrigin: trustedFrame.url,
        ipcMain: { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler() {} },
        manager: { client: {
          startDouyinLogin: async () => ++starts === 1 ? login("old-login", 7) : login("new-login", 8),
          resolveDouyinIdentity: async () => pending,
          getDouyinLoginStatus: async () => pending,
          confirmDouyinLogin: async () => pending,
          startDouyinCollection: async (account: string) => ({ account })
        } }, appVersion: () => "test", openLogsDirectory: async () => undefined,
        runtimeInfo: () => { throw Error("unused"); } });
      try {
        await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
        const late = handlers.get(channel)!(trustedEvent, channel === DESKTOP_CHANNELS.checkDouyinLogin
          ? { accountId: "workspace" } : { sessionId: "old-login" });
        await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
        settle();
        await assert.rejects(late);
        assert.deepEqual(await handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
          accountId: "workspace", task: { taskId: "task-1", loginStateVersion: 8, keywords: ["除尘"],
            maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true,
            collectDemandComments: true, deadlineAt: "2099-01-01T00:00:00.000Z" }
        }), { account: `dyacct_${"8".repeat(64)}` });
      } finally { registration.dispose(); }
    });
  }
}

for (const [channel, oldState] of [
  [DESKTOP_CHANNELS.cancelDouyinLogin, "awaiting_scan"],
  [DESKTOP_CHANNELS.getDouyinLoginStatus, "active"],
  [DESKTOP_CHANNELS.getDouyinLoginStatus, "failed"],
  [DESKTOP_CHANNELS.confirmDouyinLogin, "active"],
  [DESKTOP_CHANNELS.confirmDouyinLogin, "failed"]
] as const) {
  test(`${channel} for a superseded session (${oldState}) cannot revoke or replace the current login`, async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const cancelled: string[] = [];
    const active = { sessionId: "new-login", state: "active", interactionSurface: "external_window",
      runtimeState: "stopped", authState: "authenticated", taskState: "completed", diagnostic: null,
      expiresAt: "2099-01-01T00:00:00.000Z", accountHandle: `dyacct_${"8".repeat(64)}`,
      accountDisplayName: "新账号", loginStateVersion: 8, failureCode: null };
    const old = { ...active, sessionId: "old-login", state: oldState,
      accountHandle: oldState === "active" ? `dyacct_${"7".repeat(64)}` : null,
      accountDisplayName: oldState === "active" ? "旧账号" : null,
      loginStateVersion: oldState === "active" ? 7 : null };
    let starts = 0;
    const registration = registerDesktopIpc({ localOrigin: trustedFrame.url,
      ipcMain: { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler() {} },
      manager: { client: {
        startDouyinLogin: async () => ++starts === 1 ? { ...old, state: "awaiting_scan",
          runtimeState: "running", authState: "waiting_for_user", taskState: "idle",
          accountHandle: null, accountDisplayName: null, loginStateVersion: null } : active,
        cancelDouyinLogin: async (sessionId: string) => { cancelled.push(sessionId); },
        getDouyinLoginStatus: async () => old,
        confirmDouyinLogin: async () => old,
        startDouyinCollection: async (account: string) => ({ account })
      } }, appVersion: () => "test", openLogsDirectory: async () => undefined,
      runtimeInfo: () => { throw Error("unused"); } });
    try {
      await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
      await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace" });
      const late = handlers.get(channel)!(trustedEvent, { sessionId: "old-login" });
      if (channel === DESKTOP_CHANNELS.cancelDouyinLogin) {
        await late;
        assert.deepEqual(cancelled, ["old-login"], "cleanup still forwards the exact superseded session ID");
      } else await assert.rejects(late, /desktop_login_session_unavailable/u);
      assert.deepEqual(await handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
        accountId: "workspace", task: { taskId: "task-1", loginStateVersion: 8, keywords: ["除尘"],
          maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true,
          collectDemandComments: true, deadlineAt: "2099-01-01T00:00:00.000Z" }
      }), { account: active.accountHandle });
    } finally { registration.dispose(); }
  });
}

test("outreach IPC owns the exact top frame, closes schemas, sanitizes failures and disposes events without stopping Main", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: unknown[] = [];
  const frame = { url: "http://127.0.0.1:45678/" };
  let sender: any = { mainFrame: frame, send: (...args: unknown[]) => sent.push(args), isDestroyed: () => false };
  let listener: ((view: DesktopOutreachCoordinatorView) => void) | undefined;
  let calls = 0; let unsubscribed = 0;
  const view: DesktopOutreachCoordinatorView = { state: "executing", diagnostic: null, currentActionKind: "comment",
    updatedAt: null, pendingReconciliationCount: 0, ownership: "this_device" };
  const registration = registerDesktopIpc({ localOrigin: "http://127.0.0.1:45678", authorizedSender: () => sender,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    manager: { onStatus: () => () => undefined }, appVersion: () => "test", openLogsDirectory: async () => undefined,
    runtimeInfo: () => { throw new Error("unused"); },
    outreach: {
      getDesktopInstallationInfo: async () => { calls++; return { installationId: "I".repeat(43), protocolVersion: 1, registeredWorkspaceIds: [] }; },
      registerDesktopInstallation: async () => { throw Error("SECRET_CREDENTIAL"); },
      recordDesktopBinding: async () => ({ recorded: true }), setDesktopWorkspace: async () => undefined,
      getDesktopOutreachStatus: async () => view,
      onDesktopOutreachStatusChanged: (callback) => { listener = callback; return () => { unsubscribed++; }; }
    }
  });
  const read = handlers.get(DESKTOP_CHANNELS.getDesktopInstallationInfo)!;
  for (const event of [{ sender, senderFrame: { ...frame } }, { sender: {}, senderFrame: frame }, { sender, senderFrame: null }])
    await assert.rejects(read(event), /sender/);
  await assert.rejects(read({ sender, senderFrame: frame }, {}));
  assert.equal(calls, 0);
  assert.equal((await read({ sender, senderFrame: frame })).protocolVersion, 1);
  await assert.rejects(handlers.get(DESKTOP_CHANNELS.registerDesktopInstallation)!({ sender, senderFrame: frame },
    { workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) }), (error: Error) => !error.message.includes("SECRET"));
  listener!(view); assert.equal(sent.length, 1);
  frame.url = "https://outside.example/";
  await assert.rejects(read({ sender, senderFrame: frame }), /sender/);
  listener!(view); assert.equal(sent.length, 1);
  sender = undefined;
  await assert.rejects(read({ sender, senderFrame: frame }), /sender/);
  listener!(view); assert.equal(sent.length, 1);
  registration.dispose(); registration.dispose();
  assert.equal(unsubscribed, 1); assert.equal(handlers.size, 0);
  listener!(view); assert.equal(sent.length, 1);
  await assert.rejects(read({ sender, senderFrame: frame }), /disposed|sender/);
});

test("IPC rejects an invalid sender and invalid payload before touching the sidecar", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let starts = 0;
  const registration = registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    manager: { getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }), restart: async () => ({ state: "ready", protocolVersion: 1, diagnostic: null }), client: { startDouyinLogin: async () => { starts += 1; return {}; } }, onStatus: () => () => undefined },
    appVersion: () => "0.1.0",
    openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } })
  });
  const start = handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!;
  await assert.rejects(Promise.resolve(start({ senderFrame: { url: "https://outside.example" } }, { accountId: "workspace" })), /sender/u);
  await assert.rejects(Promise.resolve(start({ senderFrame: { url: "not a URL" } }, { accountId: "workspace" })), /sender/u);
  await assert.rejects(Promise.resolve(start(trustedEvent, { accountId: "" })), /accountId/u);
  assert.equal(starts, 0);
  registration.dispose();
  assert.equal(handlers.size, 0);
});

test("IPC deduplicates an in-flight desktop login and hashes the workspace identity", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolveLogin!: (value: { sessionId: string }) => void;
  const pending = new Promise<{ sessionId: string }>((resolve) => { resolveLogin = resolve; });
  const accountKeys: string[] = [];
  registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
    manager: { getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }), restart: async () => ({ state: "ready", protocolVersion: 1, diagnostic: null }), client: { startDouyinLogin: async (key: string) => { accountKeys.push(key); return pending; } }, onStatus: () => () => undefined },
    appVersion: () => "0.1.0", openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } })
  });
  const start = handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!;
  const event = trustedEvent;
  const first = start(event, { accountId: "workspace-a" });
  const second = start(event, { accountId: "workspace-a" });
  resolveLogin({ sessionId: "local-1" });
  assert.deepEqual(await Promise.all([first, second]), [{ sessionId: "local-1" }, { sessionId: "local-1" }]);
  assert.equal(accountKeys.length, 1);
  assert.match(accountKeys[0]!, /^[a-f0-9]{64}$/u);
});

test("IPC round-trips a Sidecar URL-safe session token that begins with underscore", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const token = "_6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V";
  const calls: string[] = [];
  registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
    manager: {
      getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }),
      restart: async () => ({}), onStatus: () => () => undefined,
      client: {
        startDouyinLogin: async () => ({ sessionId: token, state: "awaiting_scan" }),
        getDouyinLoginStatus: async (sessionId: string) => {
          calls.push(`get:${sessionId}`);
          return { sessionId, state: "awaiting_scan" };
        },
        confirmDouyinLogin: async (sessionId: string) => {
          calls.push(`confirm:${sessionId}`);
          return { sessionId, state: "awaiting_scan" };
        },
        cancelDouyinLogin: async (sessionId: string) => { calls.push(`cancel:${sessionId}`); },
      },
    },
    appVersion: () => "0.1.0", openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } }),
  });
  const event = trustedEvent;
  const started = await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(event, { accountId: "workspace-a" });
  assert.equal((started as { sessionId: string }).sessionId, token);
  await handlers.get(DESKTOP_CHANNELS.getDouyinLoginStatus)!(event, { sessionId: token });
  await handlers.get(DESKTOP_CHANNELS.confirmDouyinLogin)!(event, { sessionId: token });
  await handlers.get(DESKTOP_CHANNELS.cancelDouyinLogin)!(event, { sessionId: token });
  assert.deepEqual(calls, [`get:${token}`, `confirm:${token}`, `cancel:${token}`]);
});

test("IPC retains the active private account handle only in Main and clears it on terminal login state", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>(); let received: unknown[] = [];
  registerDesktopIpc({ localOrigin: "http://127.0.0.1:45678", ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} }, manager: { getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }), restart: async () => ({}), onStatus: () => () => undefined, client: { startDouyinLogin: async () => ({ sessionId: "s1", state: "active", accountHandle: "private-handle", loginStateVersion: 7 }), getDouyinLoginStatus: async () => ({ sessionId: "s1", state: "expired", accountHandle: null, loginStateVersion: null }), startDouyinCollection: async (...args: unknown[]) => { received = args; return {}; } } }, appVersion: () => "0.1.0", openLogsDirectory: async () => undefined, runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } }) });
  const event = trustedEvent; await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(event, { accountId: "workspace-a" });
  const task = { taskId: "task-1", loginStateVersion: 7, keywords: ["x"], maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true, collectDemandComments: true, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  await handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(event, { accountId: "workspace-a", task }); assert.equal(received[0], "private-handle");
  await handlers.get(DESKTOP_CHANNELS.getDouyinLoginStatus)!(event, { sessionId: "s1" });
  await assert.rejects(Promise.resolve(handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(event, { accountId: "workspace-a", task })), /identity/u);
  await assert.rejects(Promise.resolve(handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(event, { accountId: "workspace-a", task: { ...task, loginStateVersion: 8 } })), /identity/u);
});

test("IPC rejects a Sidecar login response for a different session", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
    manager: {
      getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }),
      restart: async () => ({}), onStatus: () => () => undefined,
      client: {
        startDouyinLogin: async () => ({ sessionId: "s1", state: "awaiting_scan" }),
        getDouyinLoginStatus: async () => ({ sessionId: "other-session", state: "active", accountHandle: "wrong-handle", loginStateVersion: 9 })
      }
    },
    appVersion: () => "0.1.0", openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } })
  });
  const event = trustedEvent;
  await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(event, { accountId: "workspace-a" });
  await assert.rejects(
    Promise.resolve(handlers.get(DESKTOP_CHANNELS.getDouyinLoginStatus)!(event, { sessionId: "s1" })),
    /desktop_login_session_mismatch/u
  );
});

test("IPC rejects a late login response from a previous connector generation", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let statusListener: ((status: { state: string }) => void) | undefined;
  let resolveLogin!: (value: unknown) => void;
  const pending = new Promise((resolve) => { resolveLogin = resolve; });
  const sidecarClient = { startDouyinLogin: async () => pending };
  registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
    manager: {
      getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }),
      restart: async () => ({}), client: sidecarClient,
      onStatus: (listener: (status: { state: string }) => void) => {
        statusListener = listener;
        return () => undefined;
      },
    },
    appVersion: () => "0.1.0", openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } })
  });
  const event = trustedEvent;
  const login = handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(event, { accountId: "workspace-a" });
  await Promise.resolve();
  statusListener?.({ state: "starting" });
  resolveLogin({ sessionId: "stale-session", state: "active", accountHandle: "stale", loginStateVersion: 4 });
  await assert.rejects(Promise.resolve(login), /connector_generation_stale/u);
});

for (const channel of [DESKTOP_CHANNELS.getDouyinLoginStatus, DESKTOP_CHANNELS.confirmDouyinLogin]) {
  test(`${channel} cannot restore a cancelled session or its collection identity from a late response`, async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    let completePoll!: (status: unknown) => void;
    const pending = new Promise((resolve) => { completePoll = resolve; });
    const oldLogin = {
      sessionId: "cancelled-login", state: "active", interactionSurface: "external_window",
      runtimeState: "stopped", authState: "authenticated", taskState: "completed",
      diagnostic: null, expiresAt: "2099-01-01T00:00:00.000Z",
      accountHandle: "old-account-handle", accountDisplayName: "隔离账号",
      loginStateVersion: 8, failureCode: null
    };
    let starts = 0;
    let collections = 0;
    const registration = registerDesktopIpc({
      localOrigin: trustedFrame.url,
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
      manager: { client: {
        startDouyinLogin: async () => ++starts === 1 ? oldLogin : {
          ...oldLogin, sessionId: "replacement-login", state: "awaiting_scan",
          runtimeState: "running", authState: "waiting_for_user", taskState: "idle",
          accountHandle: null, accountDisplayName: null, loginStateVersion: null
        },
        getDouyinLoginStatus: async () => pending,
        confirmDouyinLogin: async () => pending,
        cancelDouyinLogin: async () => undefined,
        startDouyinCollection: async () => { collections++; return {}; }
      } },
      appVersion: () => "test", openLogsDirectory: async () => undefined,
      runtimeInfo: () => { throw Error("unused"); }
    });
    try {
      await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace-a" });
      const poll = handlers.get(channel)!(trustedEvent, { sessionId: "cancelled-login" });
      await handlers.get(DESKTOP_CHANNELS.cancelDouyinLogin)!(trustedEvent, { sessionId: "cancelled-login" });
      await handlers.get(DESKTOP_CHANNELS.startDouyinLogin)!(trustedEvent, { accountId: "workspace-a" });
      completePoll(oldLogin);
      await assert.rejects(poll, /desktop_login_session_unavailable/u);
      await assert.rejects(handlers.get(DESKTOP_CHANNELS.getDouyinLoginStatus)!(trustedEvent,
        { sessionId: "cancelled-login" }), /desktop_login_session_unavailable/u);
      await assert.rejects(handlers.get(DESKTOP_CHANNELS.startDouyinCollection)!(trustedEvent, {
        accountId: "workspace-a", task: { taskId: "task-1", loginStateVersion: 8,
          keywords: ["郑州网约车租赁"], maxVideos: 1, maxCommentsPerVideo: 1,
          maxPagesPerVideo: 1, collectCreators: true, collectDemandComments: true,
          deadlineAt: "2099-01-01T00:00:00.000Z" }
      }), /desktop_login_identity_unavailable/u);
      assert.equal(collections, 0);
    } finally { registration.dispose(); }
  });
}

test("IPC acknowledges a bounded task through the narrow Sidecar method", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const acknowledged: string[] = [];
  registerDesktopIpc({
    localOrigin: "http://127.0.0.1:45678",
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler() {} },
    manager: {
      getStatus: () => ({ state: "ready", protocolVersion: 1, diagnostic: null }),
      restart: async () => ({}), onStatus: () => () => undefined,
      client: { acknowledgeDouyinCollection: async (taskId: string) => { acknowledged.push(taskId); } }
    },
    appVersion: () => "0.1.0", openLogsDirectory: async () => undefined,
    runtimeInfo: () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } })
  });
  const event = trustedEvent;
  await handlers.get(DESKTOP_CHANNELS.acknowledgeDouyinCollection)!(event, { taskId: "task-1" });
  assert.deepEqual(acknowledged, ["task-1"]);
});
