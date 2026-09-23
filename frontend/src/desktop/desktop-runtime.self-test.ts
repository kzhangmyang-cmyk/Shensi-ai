import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { startAppEntry } from "../app-entry";
import * as runtimeModule from "./desktop-runtime";
import { connectorCopy, createDesktopRuntimeState, installDesktopRuntime } from "./desktop-runtime";
import type { ConnectorStatus, ShensiDesktopApi } from "./desktop-bridge";
import { createDesktopEnrollmentApi } from "./desktop-enrollment-api";
import { mountDesktopAccountStatus } from "./desktop-account-status-view";

for (const existingMode of ["desktop", null] as const) {
  const { document, window } = parseHTML('<html><body><div id="host"><div class="douyin-account-card"></div></div></body></html>');
  let checks = 0;
  let logins = 0;
  let binds = 0;
  let records = 0;
  const runtime = createDesktopRuntimeState({ ...completeBridge(),
    checkDouyinLogin: async () => { checks++; return { accountHandle: `dyacct_${"a".repeat(64)}`,
      accountDisplayName: "hkko", loginStateVersion: 7 }; },
    startDouyinLogin: async () => { logins++; throw Error("not a login request"); },
    recordDesktopBinding: async () => { records++; return { recorded: true }; }
  }, { body: { dataset: { sessionWorkspaceId: "workspace-7" } } }, {
    enroll: async () => { throw Error("already enrolled"); },
    getBinding: async () => ({ accountId: "social-1", executorMode: existingMode, bindingGeneration: existingMode ? 2 : 0,
      leaseExpiresAt: existingMode ? "2026-01-01T00:00:00Z" : null, ownedByInstallation: existingMode !== null, hasUnresolvedActions: true }),
    bind: async (accountId, input) => {
      binds++; assert.equal(accountId, "social-1"); assert.equal(input.loginStateVersion, 7);
      assert.equal(input.expectedBindingGeneration, existingMode ? 2 : 0); assert.equal(input.handoff, false);
      return { accountId, executorMode: "desktop", bindingGeneration: existingMode ? 2 : 1,
        leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(), ownedByInstallation: true };
    }
  });
  await runtime.synchronizeWorkspace("workspace-7");
  const account = { id: "social-1", workspaceId: "workspace-7", state: "active" as const, loginStateVersion: 7 };
  let currentAccount: typeof account | null = account;
  const host = document.getElementById("host")!;
  const mounted = mountDesktopAccountStatus(host, runtime, () => currentAccount);
  mounted.render();
  const check = host.querySelector<HTMLButtonElement>('[data-desktop-binding-action="check-login"]');
  assert.ok(check, "login check must not dispatch the connect action");
  check.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(checks, 1);
  assert.equal(logins, 0);
  assert.equal(binds, 0, "checking restores the binding control but cannot renew or send");
  assert.equal(records, 0);
  assert.match(host.textContent ?? "", /hkko.*7/);
  const bind = host.querySelector<HTMLButtonElement>('[data-desktop-binding-action="bind"]');
  assert.ok(bind, "cold-start login check must restore the same-device binding button");
  assert.equal(bind.hasAttribute("disabled"), false, "same-device renewal and initial unbound login must remain recoverable without resolving old receipts");
  bind.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(binds, 1); assert.equal(records, 1); assert.equal(logins, 0);
  await assert.rejects(runtime.prepareLocalAccountBinding({ ...account, workspaceId: "other" },
    { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 7 }));
  await assert.rejects(runtime.prepareLocalAccountBinding(account,
    { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 8 }));
  currentAccount = null;
  mounted.render();
  assert.doesNotMatch(host.textContent ?? "", /hkko.*7/u,
    "disconnect within the same workspace must clear the prior account check message");
  mounted.dispose(); runtime.dispose();
}

const occurredAt = "2026-09-03T00:00:00.000Z";
assert.equal(typeof runtimeModule.desktopOutreachCopy, "function", "acquisition and conversations need one status presenter");
for (const [state, expected] of [
  ["unenrolled", "未注册此设备"], ["unbound", "本机尚未绑定该抖音账号"],
  ["idle", "桌面执行器已就绪"], ["claimed", "桌面应用已领取"],
  ["executing", "正在通过本机抖音执行"], ["reconciling", "等待只读对账，绝不会自动重发"],
  ["risk_paused", "风险暂停"], ["offline", "中心服务离线，未领取新动作"]
] as const) {
  assert.equal(runtimeModule.desktopOutreachCopy({ state, diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" }), expected);
}

assert.equal(typeof (createDesktopRuntimeState(null, { body: { dataset: {} } }) as unknown as Record<string, unknown>).synchronizeWorkspace,
  "function", "authenticated workspace lifecycle must enroll through Main and clear on logout");

const workspaceCalls: unknown[] = [];
let outreachListener: ((value: unknown) => void) | null = null;
let outreachUnsubscribes = 0;
const workspaceBridge = {
  ...completeBridge(),
  setDesktopWorkspace: async (value: unknown) => { workspaceCalls.push(["workspace", value]); },
  getDesktopInstallationInfo: async () => ({ installationId: "a".repeat(43), protocolVersion: 1 as const, registeredWorkspaceIds: [] }),
  registerDesktopInstallation: async (value: { workspaceId: string; enrollmentToken: string }) => {
    workspaceCalls.push(["register", value]); return { workspaceId: value.workspaceId, registered: true as const };
  },
  getDesktopOutreachStatus: async () => ({ state: "unenrolled", diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unregistered" }),
  onDesktopOutreachStatusChanged: (listener: (value: unknown) => void) => {
    outreachListener = listener; return () => { outreachUnsubscribes += 1; };
  }
};
const workspaceRuntime = createDesktopRuntimeState(workspaceBridge as never,
  { body: { dataset: {} } }, {
    enroll: async (input: unknown) => {
      workspaceCalls.push(["enroll", input]);
      return { enrollmentToken: "b".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    }
  } as never);
workspaceRuntime.start();
await workspaceRuntime.synchronizeWorkspace("workspace-7");
await workspaceRuntime.synchronizeWorkspace("workspace-7");
assert.deepEqual(workspaceCalls, [
  ["workspace", { workspaceId: "workspace-7" }],
  ["enroll", { protocolVersion: 1, installationId: "a".repeat(43) }],
  ["register", { workspaceId: "workspace-7", enrollmentToken: "b".repeat(43) }]
], "bootstrap must set Main workspace before one session enrollment and forward only the one-time token");
await workspaceRuntime.synchronizeWorkspace(null);
assert.deepEqual(workspaceCalls[workspaceCalls.length - 1], ["workspace", { workspaceId: null }]);
const callsBeforeDispose = workspaceCalls.length;
workspaceRuntime.dispose();
assert.equal(workspaceCalls.length, callsBeforeDispose, "renderer dispose must not clear Main workspace");
assert.equal(outreachUnsubscribes, 1);
assert.ok(outreachListener);

const bindingRecords: unknown[] = [];
const bindingRuntime = createDesktopRuntimeState({ ...completeBridge(),
  recordDesktopBinding: async (input) => { bindingRecords.push(input); return { recorded: true }; }
}, { body: { dataset: { sessionWorkspaceId: "workspace-7" } } }, {
  enroll: async () => { throw new Error("already registered"); },
  getBinding: async () => ({ accountId: "social-1", executorMode: null, bindingGeneration: 0, leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: false }),
  bind: async (accountId, input) => {
    assert.equal(accountId, "social-1");
    assert.equal(input.expectedBindingGeneration, 0);
    assert.equal(input.handoff, false);
    return { accountId, executorMode: "desktop", bindingGeneration: 1, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(), ownedByInstallation: true };
  }
});
await bindingRuntime.synchronizeWorkspace("workspace-7");
assert.equal(typeof bindingRuntime.acceptLocalAccount, "function", "central account success must trigger the exact real-account binding");
await bindingRuntime.acceptLocalAccount({ id: "social-1", workspaceId: "workspace-7", state: "active", loginStateVersion: 3 }, { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 3 });
assert.deepEqual(bindingRecords, [{ workspaceId: "workspace-7", accountId: "social-1", bindingGeneration: 1 }],
  "Main binding record must use the centrally returned social account ID, never the workspace Profile key");
bindingRecords.length = 0;
await Promise.all([1, 2].map(() => bindingRuntime.acceptLocalAccount({ id: "social-1", workspaceId: "workspace-7", state: "active", loginStateVersion: 3 }, { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 3 })));
assert.equal(bindingRecords.length, 1, "concurrent observations of the same local login must deduplicate without invalidating the successful binding");
bindingRuntime.dispose();

const publicApiCalls: Array<{ url: string; init?: RequestInit }> = [];
for (const [code, expected] of [
  ["desktop_client_build_not_admitted", /应用版本与后台允许的版本不一致/u],
  ["desktop_client_migration_locked", /后台暂未开放桌面连接/u]
] as const) {
  const rejected = createDesktopRuntimeState(workspaceBridge as never,
    { body: { dataset: {} } }, { enroll: async () => { throw new Error(code); } } as never);
  await assert.rejects(rejected.synchronizeWorkspace("workspace-7"));
  assert.match(rejected.enrollmentError() ?? "", expected,
    "build admission failure must not be mislabeled as missing device registration");
  rejected.dispose();
}

const enrollmentApi = createDesktopEnrollmentApi({ cookieSource: () => "gj_csrf=csrf%2Dvalue", fetchImpl: async (url, init) => {
  publicApiCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({ enrollmentToken: "b".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
} });
await enrollmentApi.enroll({ protocolVersion: 1, installationId: "a".repeat(43) });
assert.equal(publicApiCalls[0]?.url, "/api/v1/acquisition/desktop-installations/enrollments");
assert.equal(publicApiCalls[0]?.init?.credentials, "same-origin");
assert.equal(new Headers(publicApiCalls[0]?.init?.headers).get("x-csrf-token"), "csrf-value");
assert.equal(new Headers(publicApiCalls[0]?.init?.headers).has("x-shensi-desktop-device-token"), false);

let bindingPostCalls = 0;
let pendingActions = false;
let conflictMode: "desktop" | "server" = "desktop";
const conflictRuntime = createDesktopRuntimeState({ ...completeBridge(), recordDesktopBinding: async () => { throw new Error("must not record"); } },
  { body: { dataset: { sessionWorkspaceId: "workspace-7" } } }, {
    enroll: async () => { throw new Error("already registered"); },
    getBinding: async () => ({ accountId: "social-conflict", executorMode: conflictMode, bindingGeneration: 3, leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: pendingActions }),
    bind: async () => { bindingPostCalls += 1; throw new Error("blocked"); }
  });
await conflictRuntime.synchronizeWorkspace("workspace-7");
await conflictRuntime.acceptLocalAccount({ id: "social-conflict", workspaceId: "workspace-7", state: "active", loginStateVersion: 3 }, { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 3 });
assert.equal(bindingPostCalls, 0, "a conflicting device never silently hands off");
pendingActions = true;
await conflictRuntime.bindDesktopAccount(true);
assert.equal(bindingPostCalls, 0, "fresh central unresolved actions block even an explicitly confirmed handoff");
conflictMode = "server";
await conflictRuntime.bindDesktopAccount(false);
assert.equal(bindingPostCalls, 0, "legacy server pending actions must be resolved before desktop migration");
assert.equal(conflictRuntime.bindingError(), "存在旧版服务器待执行动作，切换前需先处理");
conflictRuntime.dispose();

let releaseOldBinding!: () => void;
const switchPosts: string[] = [];
const switchRecords: string[] = [];
const switchBindingRuntime = createDesktopRuntimeState({ ...completeBridge(),
  getDesktopInstallationInfo: async () => ({ installationId: "a".repeat(43), protocolVersion: 1, registeredWorkspaceIds: ["workspace-a", "workspace-b"] }),
  recordDesktopBinding: async (input) => { switchRecords.push(input.accountId); return { recorded: true }; }
}, { body: { dataset: {} } }, {
  enroll: async () => { throw new Error("already registered"); },
  async getBinding(accountId) {
    if (accountId === "social-a") await new Promise<void>((resolve) => { releaseOldBinding = resolve; });
    return { accountId, executorMode: null, bindingGeneration: 0, leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: false };
  },
  async bind(accountId) { switchPosts.push(accountId); return { accountId, executorMode: "desktop", bindingGeneration: 1, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(), ownedByInstallation: true }; }
});
await switchBindingRuntime.synchronizeWorkspace("workspace-a");
const oldBinding = switchBindingRuntime.acceptLocalAccount({ id: "social-a", workspaceId: "workspace-a", state: "active", loginStateVersion: 3 }, { accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 3 });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
await switchBindingRuntime.synchronizeWorkspace("workspace-b");
const newBinding = switchBindingRuntime.acceptLocalAccount({ id: "social-b", workspaceId: "workspace-b", state: "active", loginStateVersion: 3 }, { accountHandle: `dyacct_${"b".repeat(64)}`, loginStateVersion: 3 });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(switchPosts, ["social-b"], "a new workspace must not deduplicate its binding against the old workspace's pending flight");
releaseOldBinding();
await Promise.all([oldBinding, newBinding]);
assert.deepEqual(switchRecords, ["social-b"], "a late old binding must not publish authority into the new workspace");
switchBindingRuntime.dispose();

const offlineView = { state: "offline" as const, diagnostic: "central_unreachable" as const, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" as const };
const reloadRuntime = createDesktopRuntimeState({ ...completeBridge(), getDesktopOutreachStatus: async () => offlineView }, { body: { dataset: { sessionWorkspaceId: "workspace-7" } } });
reloadRuntime.start();
await Promise.resolve();
assert.equal(reloadRuntime.outreachStatus()?.state, "offline");
await reloadRuntime.synchronizeWorkspace("workspace-7");
assert.equal(reloadRuntime.outreachStatus()?.state, "offline",
  "renderer reload must refresh status even when Main deduplicates workspace and emits no event");
reloadRuntime.dispose();

assert.deepEqual(connectorCopy({ state: "starting", protocolVersion: null, diagnostic: null }), {
  title: "正在启动本地连接器", action: null
});
assert.deepEqual(connectorCopy({ state: "ready", protocolVersion: 1, diagnostic: null }), {
  title: "本地连接器已就绪", action: null
});
assert.deepEqual(connectorCopy({ state: "crashed", protocolVersion: null, diagnostic: { code: "sidecar_exit", message: "stopped", recoverable: true, occurredAt } }), {
  title: "本地连接器已停止", action: "重新启动"
});
assert.deepEqual(connectorCopy({ state: "stopped", protocolVersion: null, diagnostic: null }), {
  title: "本地连接器未运行", action: "启动连接器"
});

const documentLike: { body: { dataset: DOMStringMap } } = {
  body: { dataset: { sessionWorkspaceId: " workspace-7 " } }
};
assert.equal(createDesktopRuntimeState(null, documentLike).accountId(), null);
const bridge = {} as never;
assert.equal(createDesktopRuntimeState(bridge, documentLike).accountId(), "workspace-7",
  "desktop account identity must come from the authenticated workspace dataset");
documentLike.body.dataset.sessionWorkspaceId = "";
assert.equal(createDesktopRuntimeState(bridge, documentLike).accountId(), null);

const connectorStatus = (state: ConnectorStatus["state"]): ConnectorStatus => ({
  state, protocolVersion: state === "ready" ? 1 : null, diagnostic: null
});
let resolveSnapshot!: (status: ConnectorStatus) => void;
let subscribed: ((status: ConnectorStatus) => void) | null = null;
let unsubscribeCount = 0;
const lifecycleBridge = {
  getConnectorStatus: () => new Promise<ConnectorStatus>((resolve) => { resolveSnapshot = resolve; }),
  restartConnector: async () => connectorStatus("ready"),
  onConnectorStatus(listener: (next: ConnectorStatus) => void) {
    subscribed = listener;
    return () => { unsubscribeCount += 1; };
  }
} as unknown as ShensiDesktopApi;
const lifecycle = createDesktopRuntimeState(lifecycleBridge, documentLike);
const observed: ConnectorStatus["state"][] = [];
lifecycle.subscribe((next) => observed.push(next.state));
lifecycle.start();
(subscribed as ((status: ConnectorStatus) => void) | null)?.(connectorStatus("ready"));
resolveSnapshot(connectorStatus("crashed"));
await Promise.resolve();
assert.deepEqual(observed, ["ready"], "a late initial snapshot must not overwrite a newer event");
lifecycle.dispose();
assert.equal(unsubscribeCount, 1, "disposing must unsubscribe the preload listener exactly once");

let restartResolve!: (status: ConnectorStatus) => void;
const restartListeners: Array<(status: ConnectorStatus) => void> = [];
const restartBridge = {
  ...completeBridge(),
  getConnectorStatus: async () => connectorStatus("ready"),
  restartConnector: () => new Promise<ConnectorStatus>((resolve) => { restartResolve = resolve; }),
  onConnectorStatus(listener: (next: ConnectorStatus) => void) {
    restartListeners.push(listener);
    return () => undefined;
  }
};
const restartRuntime = createDesktopRuntimeState(restartBridge, documentLike);
restartRuntime.start();
await Promise.resolve();
const restartFlight = restartRuntime.restartConnector();
restartListeners[0]?.(connectorStatus("crashed"));
restartListeners[1]?.(connectorStatus("stopped"));
restartResolve(connectorStatus("ready"));
await restartFlight;
assert.equal(restartRuntime.connectorStatus()?.state, "stopped",
  "restart must ignore an old subscription and must not overwrite a newer event with its late result");
restartRuntime.dispose();

let firstListener: ((status: ConnectorStatus) => void) | null = null;
let secondListener: ((status: ConnectorStatus) => void) | null = null;
let installs = 0;
const reinstallBridge = {
  ...completeBridge(),
  getConnectorStatus: async () => connectorStatus("ready"),
  onConnectorStatus(listener: (next: ConnectorStatus) => void) {
    installs += 1;
    if (installs === 1) firstListener = listener;
    else secondListener = listener;
    return () => { unsubscribeCount += 1; };
  }
} as unknown as ShensiDesktopApi;
const firstRuntime = installDesktopRuntime({ shensiDesktop: reinstallBridge }, documentLike);
const secondRuntime = installDesktopRuntime({ shensiDesktop: reinstallBridge }, documentLike);
assert.notEqual(firstRuntime, secondRuntime);
assert.equal(installs, 2);
(firstListener as ((status: ConnectorStatus) => void) | null)?.(connectorStatus("crashed"));
(secondListener as ((status: ConnectorStatus) => void) | null)?.(connectorStatus("ready"));
await Promise.resolve();
assert.equal(secondRuntime.connectorStatus()?.state, "ready",
  "a disposed runtime must not publish stale connector events into its replacement");
secondRuntime.dispose();

const parsed = parseHTML("<html><body class='is-authenticated' data-session-workspace-id='workspace-7'></body></html>");
let remoteEntryLoads = 0;
const entryWorkspaces: Array<string | null> = [];
await startAppEntry({
  windowLike: {
    shensiDesktop: { ...completeBridge(), setDesktopWorkspace: async ({ workspaceId }) => { entryWorkspaces.push(workspaceId); } },
    location: { hash: "#douyin-live-login?sessionId=remote-1" }
  },
  documentLike: parsed.document,
  createSession: () => ({ start: async () => undefined }),
  loadLiveLogin: async () => {
    remoteEntryLoads += 1;
    return { startDouyinLiveLoginPage: async () => undefined };
  }
});
assert.equal(remoteEntryLoads, 0,
  "desktop legacy hashes must be gated before importing the remote API/RFB entry");
assert.match(parsed.document.body.textContent ?? "", /返回抖音获客/u);
assert.deepEqual(entryWorkspaces, ["workspace-7"], "normal authenticated bootstrap must activate the Main workspace");
const logoutEvent = parsed.document.createEvent("CustomEvent");
logoutEvent.initCustomEvent("goodjob:auth-state-changed", false, false, { authenticated: false });
parsed.document.dispatchEvent(logoutEvent);
await Promise.resolve();
assert.deepEqual(entryWorkspaces, ["workspace-7", null], "session logout must clear Main workspace");

const webParsed = parseHTML("<html><body class='is-authenticated'></body></html>");
let webRemoteStarts = 0;
await startAppEntry({
  windowLike: { location: { hash: "#douyin-live-login?sessionId=web-remote-1" } },
  documentLike: webParsed.document,
  createSession: () => ({ start: async () => undefined }),
  loadLiveLogin: async () => ({
    startDouyinLiveLoginPage: async (sessionId: string) => {
      assert.equal(sessionId, "web-remote-1");
      webRemoteStarts += 1;
    }
  })
});
assert.equal(webRemoteStarts, 1, "the existing Web legacy remote-canvas route must remain unchanged");

const timeoutParsed = parseHTML("<html><body></body></html>");
let startupAttempts = 0;
let destroyedStartupSessions = 0;
await startAppEntry({
  windowLike: { location: { hash: "#dashboard" } },
  documentLike: timeoutParsed.document,
  startup: { enabled: true, minimumDurationMs: 0, timeoutMs: 1 },
  createSession: () => {
    startupAttempts += 1;
    const attempt = startupAttempts;
    return {
      start: () => attempt === 1 ? new Promise<void>(() => undefined) : Promise.resolve(),
      destroy: () => { destroyedStartupSessions += 1; }
    };
  }
});
assert.equal(timeoutParsed.document.querySelector("[data-startup-splash]")?.classList.contains("is-failed"), true,
  "a hung desktop bootstrap must become a recoverable startup state");
timeoutParsed.document.querySelector<HTMLButtonElement>("[data-startup-retry]")?.click();
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(startupAttempts, 2, "startup retry must create a fresh session instead of reusing the hung controller");
assert.equal(destroyedStartupSessions, 1, "the hung session must be fenced before retry");
assert.equal(timeoutParsed.document.querySelector("[data-startup-splash]")?.classList.contains("is-ready"), true);

const workspaceTimeoutParsed = parseHTML("<html><body class='is-authenticated' data-session-workspace-id='workspace-hung'></body></html>");
let workspaceSessionDestroyed = 0;
let releaseWorkspaceSync!: () => void;
await startAppEntry({
  windowLike: {
    location: { hash: "#dashboard" },
    shensiDesktop: {
      ...completeBridge(),
      setDesktopWorkspace: () => new Promise<void>((resolve) => { releaseWorkspaceSync = resolve; })
    }
  },
  documentLike: workspaceTimeoutParsed.document,
  startup: { enabled: true, minimumDurationMs: 0, timeoutMs: 1 },
  createSession: () => ({
    start: async () => undefined,
    destroy: () => { workspaceSessionDestroyed += 1; }
  })
});
assert.equal(workspaceTimeoutParsed.document.querySelector("[data-startup-splash]")?.classList.contains("is-failed"), true,
  "workspace synchronization must share the bounded startup deadline");
assert.equal(workspaceSessionDestroyed, 1);
releaseWorkspaceSync();
await Promise.resolve();

function completeBridge(): ShensiDesktopApi {
  return {
    getDesktopInstallationInfo: async () => ({ installationId: "a".repeat(43), protocolVersion: 1, registeredWorkspaceIds: ["workspace-7"] }),
    registerDesktopInstallation: async ({ workspaceId }) => ({ workspaceId, registered: true }),
    recordDesktopBinding: async () => ({ recorded: true }),
    setDesktopWorkspace: async () => undefined,
    getDesktopOutreachStatus: async () => ({ state: "disabled", diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" }),
    onDesktopOutreachStatusChanged: () => () => undefined,
    getRuntimeInfo: async () => ({} as never),
    getConnectorStatus: async () => connectorStatus("ready"),
    restartConnector: async () => connectorStatus("ready"),
    startDouyinLogin: async () => ({} as never),
    checkDouyinLogin: async () => ({} as never),
    getDouyinLoginStatus: async () => ({} as never),
    confirmDouyinLogin: async () => ({} as never),
    cancelDouyinLogin: async () => undefined,
    startDouyinCollection: async () => ({} as never),
    getDouyinCollectionStatus: async () => ({} as never),
    getDouyinCollectionResults: async () => ({} as never),
    acknowledgeDouyinCollection: async () => undefined,
    cancelDouyinCollection: async () => undefined,
    openLogsDirectory: async () => undefined,
    getAppVersion: async () => "test",
    onConnectorStatus: () => () => undefined
  };
}

console.log(JSON.stringify({ ok: true, suite: "desktop-runtime" }));
