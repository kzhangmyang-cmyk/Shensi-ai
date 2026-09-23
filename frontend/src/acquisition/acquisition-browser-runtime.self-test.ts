import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import {
  AcquisitionHttpError,
  createDouyinAutomationApi,
  type DouyinAutomationApi,
  type DouyinCrawlerStatus,
  type DouyinDesktopSyncApi,
  type DouyinLoginSession
} from "./douyin-automation-api";
import { createAcquisitionBrowserRuntimes } from "./acquisition-browser-runtime";
import type { DouyinCollectionStatus, DouyinLoginStatus, ShensiDesktopApi } from "../desktop/desktop-bridge";
import { createDouyinAutomationController } from "./douyin-automation-controller";
import { installDesktopRuntime } from "../desktop/desktop-runtime";
import type {
  DouyinAutomationController,
  DouyinAutomationState
} from "./douyin-automation-controller";
import {
  mountDouyinAutomationView,
  renderDouyinAutomationView
} from "./douyin-automation-view";

const now = "2026-09-02T08:00:00.000Z";
const expiresAt = "2026-09-02T08:10:00.000Z";
const diagnostic = {
  code: "waiting_for_user",
  message: "External browser is ready for manual login.",
  recoverable: true,
  occurredAt: now
};
const desktopLoginPayload = {
  id: "desktop-login-1",
  platform: "douyin",
  state: "awaiting_scan",
  interactionSurface: "external_window",
  runtimeState: "running",
  authState: "waiting_for_user",
  taskState: "idle",
  diagnostic,
  screenshotAvailable: false,
  qrAvailable: false,
  qrImageDataUrl: null,
  qrStatus: null,
  loginPage: null,
  failureCode: null,
  expiresAt,
  account: null
} as const;

const parsedDesktopSession = await createDouyinAutomationApi(
  async () => new Response(JSON.stringify(desktopLoginPayload), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
).getLoginSession("desktop-login-1");
assert.deepEqual(
  {
    interactionSurface: parsedDesktopSession.interactionSurface,
    runtimeState: parsedDesktopSession.runtimeState,
    authState: parsedDesktopSession.authState,
    taskState: parsedDesktopSession.taskState,
    diagnostic: parsedDesktopSession.diagnostic,
    screenshotAvailable: parsedDesktopSession.screenshotAvailable,
    qrAvailable: parsedDesktopSession.qrAvailable,
    qrImageDataUrl: parsedDesktopSession.qrImageDataUrl,
    loginPage: parsedDesktopSession.loginPage
  },
  {
    interactionSurface: "external_window",
    runtimeState: "running",
    authState: "waiting_for_user",
    taskState: "idle",
    diagnostic,
    screenshotAvailable: false,
    qrAvailable: false,
    qrImageDataUrl: null,
    loginPage: null
  },
  "the public client must preserve the split desktop runtime state without requiring a QR or screenshot"
);

const draftPolicy = {
  keywords: [],
  schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: {
    maxVideos: 30,
    maxCommentsPerVideo: 50,
    maxPagesPerVideo: 3,
    maxDurationSeconds: 3_600
  }
};

function automationState(loginSession: DouyinLoginSession): DouyinAutomationState {
  return {
    phase: "ready",
    planId: null,
    planName: "",
    planStatus: null,
    account: null,
    loginSession,
    policy: null,
    draftPolicy,
    runIntent: null,
    activeRunId: null,
    crawlerStatus: null,
    candidates: [],
    selectedCandidateIds: [],
    error: null,
    connectionPending: false,
    interactionPending: false,
    suggestionError: null,
    closed: false
  };
}

function controllerFor(
  state: DouyinAutomationState,
  calls: { confirm: number; cancel: number; restart?: number }
): DouyinAutomationController {
  return {
    getState: () => state,
    subscribe(listener: (next: DouyinAutomationState) => void) {
      listener(state);
      return () => undefined;
    },
    confirmLogin: async () => { calls.confirm += 1; },
    cancelLogin: async () => { calls.cancel += 1; },
    restartConnector: async () => { calls.restart = (calls.restart ?? 0) + 1; }
  } as unknown as DouyinAutomationController;
}

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const desktopSession = desktopLoginPayload as unknown as DouyinLoginSession;

let handoffCalls = 0;
let pendingHandoffActions = false;
let statusSubscriber: (() => void) | null = null;
const bindingUiRuntime = {
  bridge: null,
  outreachStatus: () => ({ state: "unbound" as const, diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" as const }),
  enrollmentError: () => null, bindingError: () => null, bindingPending: () => false,
  bindingStatus: () => ({ accountId: "account-1", executorMode: "desktop" as const, bindingGeneration: 2, leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: pendingHandoffActions }),
  subscribeOutreach: (listener: () => void) => { statusSubscriber = listener; return () => { statusSubscriber = null; }; },
  bindDesktopAccount: async (handoff: boolean) => { if (handoff) handoffCalls += 1; },
  prepareLocalAccountBinding: async () => undefined,
  synchronizeWorkspace: async () => undefined,
  accountId: () => "workspace-desktop"
};
const unmountBindingUi = mountDouyinAutomationView(host, controllerFor(automationState(desktopSession), { confirm: 0, cancel: 0 }), () => undefined, { desktopRuntime: bindingUiRuntime });
assert.match(host.textContent ?? "", /本机尚未绑定该抖音账号/u,
  "the existing account card must display the Main status without replacing the workspace");
const handoffButton = host.querySelector<HTMLButtonElement>("[data-desktop-binding-action=handoff]")!;
assert.ok(handoffButton);
assert.equal(handoffButton.disabled, true, "handoff requires an explicit independent confirmation");
const handoffCheck = host.querySelector<HTMLInputElement>("[data-desktop-handoff-confirm]")!;
handoffCheck.checked = true;
handoffCheck.dispatchEvent(new document.defaultView!.Event("change", { bubbles: true }));
assert.equal(handoffButton.disabled, false);
handoffButton.click();
assert.equal(handoffCalls, 1);
pendingHandoffActions = true;
(statusSubscriber as (() => void) | null)?.();
assert.equal(host.querySelector<HTMLButtonElement>("[data-desktop-binding-action=handoff]")?.disabled, true,
  "unresolved actions must disable handoff even after confirmation");
unmountBindingUi();
assert.equal(statusSubscriber, null);

renderDouyinAutomationView(host, automationState(desktopSession));
{
  const expiredHost = document.createElement("div");
  renderDouyinAutomationView(expiredHost, automationState({ ...desktopSession,
    state: "login_expired", runtimeState: "starting" }));
  assert.match(expiredHost.textContent ?? "", /登录会话已过期/u);
  assert.doesNotMatch(expiredHost.textContent ?? "", /正在打开外部浏览器/u);
}
assert.match(
  host.textContent ?? "",
  /已打开外部浏览器，请在浏览器中完成登录/u,
  "desktop login must make the real interaction surface explicit even when QR and screenshots are unavailable"
);
assert.equal(host.querySelector("[data-douyin-live-login-slot]"), null);
assert.equal(host.querySelector("[data-douyin-live-login]"), null);
assert.equal(host.querySelector("[data-douyin-login-surface]"), null);
assert.ok(host.querySelector("[data-douyin-action=confirm-login]"),
  "desktop login must offer an explicit re-check action");
assert.ok(host.querySelector("[data-douyin-action=cancel-login]"),
  "desktop login must offer an explicit cancel action");

let liveSessionRequests = 0;
let remoteCanvasMounts = 0;
const desktopCalls = { confirm: 0, cancel: 0 };
const unmountDesktop = mountDouyinAutomationView(
  host,
  controllerFor(automationState(desktopSession), desktopCalls),
  () => undefined,
  {
    mountLiveLogin() {
      liveSessionRequests += 1;
      remoteCanvasMounts += 1;
      return () => undefined;
    }
  }
);
assert.equal(liveSessionRequests, 0,
  "external_window must never enter the /live-sessions/noVNC mounting path");
assert.equal(remoteCanvasMounts, 0,
  "external_window must never mount a noVNC canvas");
host.querySelector<HTMLButtonElement>("[data-douyin-action=confirm-login]")?.click();
host.querySelector<HTMLButtonElement>("[data-douyin-action=cancel-login]")?.click();
await Promise.resolve();
assert.equal(desktopCalls.confirm, 1,
  "re-check must call the controller confirmation path exactly once");
assert.equal(desktopCalls.cancel, 1,
  "cancel must invalidate the current login session exactly once");
unmountDesktop();

const connectorCalls = { confirm: 0, cancel: 0, restart: 0 };
const connectorState: DouyinAutomationState = {
  ...automationState(desktopSession),
  connectorStatus: {
    state: "crashed",
    protocolVersion: null,
    diagnostic: {
      code: "connector_exited",
      message: "Local connector exited unexpectedly.",
      recoverable: true,
      occurredAt: now
    }
  }
};
const unmountConnector = mountDouyinAutomationView(
  host,
  controllerFor(connectorState, connectorCalls),
  () => undefined
);
assert.match(host.textContent ?? "", /本地连接器已停止/u,
  "a crashed desktop connector must have deterministic recovery copy");
host.querySelector<HTMLButtonElement>("[data-douyin-action=restart-connector]")?.click();
await Promise.resolve();
assert.equal(connectorCalls.restart, 1,
  "the connector recovery action must invoke the desktop restart boundary exactly once");
unmountConnector();

const remoteSession = {
  ...desktopLoginPayload,
  id: "remote-login-1",
  interactionSurface: "remote_canvas",
  authState: "logged_out",
  screenshotAvailable: true,
  qrAvailable: true,
  qrImageDataUrl: "data:image/png;base64,UVJDT0RF",
  qrStatus: "ready",
  loginPage: {
    imageDataUrl: "data:image/png;base64,UEFHRQ==",
    width: 1280,
    height: 720
  }
} as unknown as DouyinLoginSession;
const remoteCalls = { confirm: 0, cancel: 0 };
const unmountRemote = mountDouyinAutomationView(
  host,
  controllerFor(automationState(remoteSession), remoteCalls),
  () => undefined,
  {
    mountLiveLogin(target, sessionId) {
      remoteCanvasMounts += 1;
      assert.equal(sessionId, "remote-login-1");
      target.textContent = "remote canvas";
      return () => undefined;
    }
  }
);
assert.equal(remoteCanvasMounts, 1,
  "remote_canvas must retain the existing noVNC compatibility path");
assert.ok(host.querySelector("[data-douyin-embedded-live-login]"));
unmountRemote();

const { runtimeState: _runtimeState, ...missingRuntimeState } = desktopLoginPayload;
await assert.rejects(
  createDouyinAutomationApi(
    async () => new Response(JSON.stringify(missingRuntimeState), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  ).getLoginSession("desktop-login-1"),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.code === "malformed_response",
  "a mixed legacy status must not silently replace the split runtime/auth/task contract"
);

const runtimeModulePath = "./acquisition-browser-runtime";
const runtimeModule = await import(runtimeModulePath) as Record<string, unknown>;
assert.equal(typeof runtimeModule.LocalDesktopBrowserRuntime, "function",
  "the runtime adapter must expose a dedicated local desktop implementation");
assert.equal(typeof runtimeModule.RemoteBrowserRuntime, "function",
  "the runtime adapter must preserve a dedicated remote implementation");

const apiLoginCalls: string[] = [];
const runtimeApi = {
  createLoginSession: async (key: string) => {
    apiLoginCalls.push(key);
    return remoteSession;
  },
  getLoginSession: async () => remoteSession,
  cancelLoginSession: async () => undefined,
  runNow: async () => { throw new Error("not used"); }
} as unknown as DouyinAutomationApi;
const webRuntimes = createAcquisitionBrowserRuntimes(runtimeApi);
await webRuntimes.forSession(null).startLogin("web-login");
assert.deepEqual(apiLoginCalls, ["web-login"], "web initial login must remain API-backed remote");
assert.equal(webRuntimes.forSession(desktopSession).kind, "remote",
  "without a trusted preload bridge, even an external-window payload must stay on the Web API path");

let desktopStarts = 0;
let activeLogin = 0;
let resolveOldStatus!: (status: DouyinLoginStatus) => void;
const loginStatus = (id: string): DouyinLoginStatus => ({
  sessionId: id, state: "awaiting_scan", interactionSurface: "external_window",
  runtimeState: "running", authState: "waiting_for_user", taskState: "idle",
  diagnostic: null, expiresAt, accountHandle: null, accountDisplayName: null,
  loginStateVersion: null, failureCode: null
});
const desktopBridge = {
  startDouyinLogin: async (accountId: string) => {
    assert.equal(accountId, "workspace-desktop");
    desktopStarts += 1;
    activeLogin += 1;
    return loginStatus(`local-login-${activeLogin}`);
  },
  getDouyinLoginStatus: async (id: string) => id === "local-login-1"
    ? new Promise((resolve) => { resolveOldStatus = resolve; }) : loginStatus(id),
  confirmDouyinLogin: async (id: string) => loginStatus(id),
  cancelDouyinLogin: async () => undefined
} as unknown as ShensiDesktopApi;
const desktopRuntimes = createAcquisitionBrowserRuntimes(runtimeApi, {
  desktopBridge, accountId: () => "workspace-desktop"
});
const desktopRuntime = desktopRuntimes.forSession(null);
const [firstDesktop, duplicateDesktop] = await Promise.all([
  desktopRuntime.startLogin("ignored-1"), desktopRuntime.startLogin("ignored-2")
]);
assert.equal(desktopStarts, 1, "repeated desktop connect must start one local login");
assert.equal(firstDesktop.id, "local-login-1");
assert.equal(duplicateDesktop.id, "local-login-1");
assert.equal(firstDesktop.interactionSurface, "external_window");
assert.equal(firstDesktop.loginPage, null);
assert.equal(firstDesktop.qrImageDataUrl, null);
assert.deepEqual(apiLoginCalls, ["web-login"], "desktop initial connect must never call the remote login API");

const stalePoll = desktopRuntime.getStatus("local-login-1");
await Promise.resolve();
await desktopRuntime.cancelLogin("local-login-1");
const replacement = await desktopRuntime.startLogin("ignored-3");
resolveOldStatus(loginStatus("local-login-1"));
await assert.rejects(stalePoll, (error: unknown) => error instanceof DOMException
  && error.name === "AbortError", "a stale local status must not overwrite a replacement generation");
assert.equal(replacement.id, "local-login-2");

const identityMismatchCancels: string[] = [];
const mismatchedBridge = {
  ...desktopBridge,
  startDouyinLogin: async () => loginStatus("expected-login"),
  getDouyinLoginStatus: async () => loginStatus("wrong-login"),
  confirmDouyinLogin: async () => loginStatus("wrong-confirm"),
  cancelDouyinLogin: async (id: string) => { identityMismatchCancels.push(id); }
} as unknown as ShensiDesktopApi;
const mismatchedRuntime = createAcquisitionBrowserRuntimes(runtimeApi, {
  desktopBridge: mismatchedBridge, accountId: "workspace-desktop"
}).forSession(null);
const expectedSession = await mismatchedRuntime.startLogin("identity-start");
await assert.rejects(mismatchedRuntime.getStatus(expectedSession.id), /desktop_login_session_mismatch/u);
await assert.rejects(mismatchedRuntime.confirmLogin(expectedSession.id), /desktop_login_session_mismatch/u);
assert.deepEqual(identityMismatchCancels, ["wrong-login", "wrong-confirm"],
  "mismatched bridge identities must be cancelled and rejected before projection");

let resolveLateStart!: (status: DouyinLoginStatus) => void;
const lateCancelled: string[] = [];
const lateStartBridge = {
  ...desktopBridge,
  startDouyinLogin: async () => new Promise<DouyinLoginStatus>((resolve) => {
    resolveLateStart = resolve;
  }),
  cancelDouyinLogin: async (id: string) => { lateCancelled.push(id); }
} as unknown as ShensiDesktopApi;
const lateRuntime = createAcquisitionBrowserRuntimes(runtimeApi, {
  desktopBridge: lateStartBridge,
  accountId: "workspace-desktop"
}).forSession(null);
const lateAborter = new AbortController();
const lateStart = lateRuntime.startLogin("ignored-late", lateAborter.signal);
lateAborter.abort();
resolveLateStart(loginStatus("late-local-login"));
await assert.rejects(lateStart, (error: unknown) => error instanceof DOMException
  && error.name === "AbortError");
await Promise.resolve();
assert.deepEqual(lateCancelled, ["late-local-login"],
  "an aborted desktop create must cancel the late local session instead of orphaning Chrome");

const activeLoginStatus = (id: string): DouyinLoginStatus => ({
  ...loginStatus(id), state: "active", authState: "authenticated",
  accountHandle: `dyacct_${"a".repeat(64)}`,
  accountDisplayName: "桌面抖音账号", loginStateVersion: 7
});
const cloudAccount = {
  id: "account-1", workspaceId: "workspace-desktop", platform: "douyin" as const,
  displayName: "桌面抖音账号", state: "active" as const, loginStateVersion: 7,
  revision: 1, etag: '"account-v1"', lastValidatedAt: now,
  createdAt: now, updatedAt: now
};
{
  const connectedHost = document.createElement("div");
  renderDouyinAutomationView(connectedHost, { ...automationState(desktopSession),
    account: cloudAccount, connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } });
  assert.equal(connectedHost.querySelector('[data-douyin-action="connect"]')?.textContent, "更新抖音登录",
    "an existing account can verify its platform login without a destructive disconnect");
}
let completionAttempts = 0;
const completionKeys: string[] = [];
const completionApi = {
  ...runtimeApi,
  completeDesktopLogin: async (_input: unknown, key: string) => {
    completionAttempts += 1;
    completionKeys.push(key);
    if (completionAttempts === 1) throw new Error("temporary_cloud_failure");
    return cloudAccount;
  }
} as unknown as DouyinAutomationApi & DouyinDesktopSyncApi;
const completionBridge = {
  ...desktopBridge,
  startDouyinLogin: async () => loginStatus("completion-login"),
  confirmDouyinLogin: async () => activeLoginStatus("completion-login")
} as unknown as ShensiDesktopApi;
const completedBindings: unknown[] = [];
const completionRuntime = createAcquisitionBrowserRuntimes(completionApi, {
  desktopBridge: completionBridge, accountId: "workspace-desktop",
  onLocalAccount: async (account, local) => { completedBindings.push([account.id, local.loginStateVersion]); }
}).forSession(null);
await completionRuntime.startLogin("desktop-login-completion-key");
await assert.rejects(completionRuntime.confirmLogin("completion-login"),
  /temporary_cloud_failure/u);
const completedLogin = await completionRuntime.confirmLogin("completion-login");
assert.deepEqual(completedBindings, [[cloudAccount.id, cloudAccount.loginStateVersion]],
  "device binding must only observe a successful centrally validated account completion");
assert.deepEqual(completedLogin.account, cloudAccount,
  "an active local identity must be published before the controller sees an active account");
assert.deepEqual(completionKeys,
  ["desktop-login-completion-key", "desktop-login-completion-key"],
  "desktop login completion retries must retain one idempotency identity");

{
  let starts = 0;
  let resolveCompletion!: (account: typeof cloudAccount) => void;
  let completionStarted!: () => void;
  const pendingCompletion = new Promise<typeof cloudAccount>((resolve) => { resolveCompletion = resolve; });
  const completionRequested = new Promise<void>((resolve) => { completionStarted = resolve; });
  const keys: string[] = [];
  const cancelled: string[] = [];
  const published: string[] = [];
  const runtime = createAcquisitionBrowserRuntimes({ ...runtimeApi,
    ...{ completeDesktopLogin: async (_input: unknown, key: string) => {
      keys.push(key);
      if (key === "owned-before-disconnect") { completionStarted(); return pendingCompletion; }
      return cloudAccount;
    } }
  }, { accountId: "workspace-desktop", desktopBridge: { ...desktopBridge,
    startDouyinLogin: async () => ++starts === 1 ? activeLoginStatus("owned-1") : loginStatus("owned-2"),
    confirmDouyinLogin: async (id: string) => activeLoginStatus(id),
    cancelDouyinLogin: async (id: string) => { cancelled.push(id); }
  }, onLocalAccount: async (_account, local) => { published.push(local.sessionId); } }).desktop;
  const oldStart = runtime.startLogin("owned-before-disconnect");
  const staleRejected = assert.rejects(oldStart, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  await completionRequested;
  await runtime.cancelCurrentLogin();
  assert.equal((await runtime.startLogin("owned-after-disconnect")).id, "owned-2",
    "disconnect must release an old start flight while its cloud completion is pending");
  resolveCompletion(cloudAccount);
  await staleRejected;
  assert.deepEqual(published, [], "a late old completion must not bind or publish the disconnected login");
  assert.deepEqual(cancelled, ["owned-1"]);
  await runtime.confirmLogin("owned-2");
  assert.deepEqual(published, ["owned-2"]);
  assert.deepEqual(keys, ["owned-before-disconnect", "owned-after-disconnect"]);
}

for (const retryVia of ["cancel", "reconnect"] as const) {
  let starts = 0;
  let cancelAttempts = 0;
  const cancelled: string[] = [];
  const keys: string[] = [];
  const runtime = createAcquisitionBrowserRuntimes({ ...runtimeApi,
    ...{ completeDesktopLogin: async (_input: unknown, key: string) => { keys.push(key); return cloudAccount; } }
  }, { accountId: "workspace-desktop", desktopBridge: { ...desktopBridge,
    startDouyinLogin: async () => ++starts === 1 ? activeLoginStatus("retry-owned-1") : loginStatus("retry-owned-2"),
    getDouyinLoginStatus: async (id: string) => activeLoginStatus(id),
    cancelDouyinLogin: async (id: string) => {
      cancelled.push(id);
      if (++cancelAttempts <= (retryVia === "reconnect" ? 2 : 1)) throw Error("cancel_fixture_failed");
    }
  } }).desktop;
  await runtime.startLogin("retry-before-disconnect");
  await assert.rejects(runtime.cancelCurrentLogin(), /cancel_fixture_failed/u);
  if (retryVia === "cancel") {
    await runtime.cancelCurrentLogin();
  } else {
    await assert.rejects(runtime.startLogin("retry-still-blocked"), /cancel_fixture_failed/u);
    assert.equal(starts, 1, "a failed cancellation retry must not launch or reuse a login");
  }
  assert.equal((await runtime.startLogin("retry-after-disconnect")).id, "retry-owned-2");
  assert.deepEqual(cancelled, Array(cancelAttempts).fill("retry-owned-1"),
    "every cancellation retry must retain the original handle");
  assert.deepEqual(keys, ["retry-before-disconnect"], "cancel failure must not replay the old cloud completion");
}

{
  let finishOpening!: (status: DouyinLoginStatus) => void;
  const opening = new Promise<DouyinLoginStatus>((resolve) => { finishOpening = resolve; });
  let starts = 0;
  const cancelled: string[] = [];
  const runtime = createAcquisitionBrowserRuntimes(runtimeApi, { accountId: "workspace-desktop",
    desktopBridge: { ...desktopBridge,
      startDouyinLogin: async () => ++starts === 1 ? opening : loginStatus("captured-open-2"),
      cancelDouyinLogin: async (id: string) => { cancelled.push(id); }
    }
  }).desktop;
  const oldStart = runtime.startLogin("captured-open-old");
  const rejected = assert.rejects(oldStart, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  const cancelOld = runtime.captureLoginCancellation();
  const cancellation = cancelOld();
  const newStart = runtime.startLogin("captured-open-new");
  assert.equal(starts, 1, "a new login waits until the captured pending request can be cancelled");
  finishOpening(loginStatus("captured-open-1"));
  await cancellation;
  await rejected;
  assert.equal((await newStart).id, "captured-open-2");
  await cancelOld();
  assert.deepEqual(cancelled, ["captured-open-1"], "repeating an old cancellation must not cancel the new owner");
}

for (const terminal of ["expired", "failed"] as const) {
  let starts = 0;
  let reads = 0;
  const runtime = createAcquisitionBrowserRuntimes(runtimeApi, {
    accountId: "workspace-desktop",
    desktopBridge: { ...desktopBridge,
      startDouyinLogin: async () => ({ ...loginStatus(`terminal-${++starts}`),
        state: starts === 1 ? terminal : "awaiting_scan" }),
      getDouyinLoginStatus: async () => { reads++; throw Error("desktop_login_session_unavailable"); }
    }
  }).desktop;
  assert.equal((await runtime.startLogin("terminal-first")).state, "login_expired");
  assert.equal((await runtime.startLogin("terminal-reopen")).id, "terminal-2",
    `${terminal} sessions must not block an explicit fresh login`);
  assert.equal(starts, 2);
  assert.equal(reads, 0, "a terminal session has already lost Main authority");
}

for (const missing of ["desktop_login_session_unavailable",
  "Error invoking remote method 'shensi:desktop:get-douyin-login-status': Error: desktop_login_session_unavailable"]) {
  let starts = 0;
  const runtime = createAcquisitionBrowserRuntimes(runtimeApi, {
    accountId: "workspace-desktop",
    desktopBridge: { ...desktopBridge,
      startDouyinLogin: async () => loginStatus(`missing-${++starts}`),
      getDouyinLoginStatus: async () => { throw Error(missing); }
    }
  }).desktop;
  await runtime.startLogin("before-connector-reset");
  const [reopened, duplicate] = await Promise.all([
    runtime.startLogin("after-connector-reset"), runtime.startLogin("duplicate-reopen")
  ]);
  assert.equal(reopened.id, "missing-2");
  assert.equal(duplicate.id, "missing-2");
  assert.equal(starts, 2, "explicit reopen recovers once without duplicate launches");
}

{
  let starts = 0;
  let failure = "desktop_login_session_unavailable";
  const runtime = createAcquisitionBrowserRuntimes(runtimeApi, {
    accountId: "workspace-desktop",
    desktopBridge: { ...desktopBridge,
      startDouyinLogin: async () => loginStatus(`poll-${++starts}`),
      getDouyinLoginStatus: async () => { throw Error(failure); }
    }
  }).desktop;
  await runtime.startLogin("before-missing-poll");
  await assert.rejects(runtime.getStatus("poll-1"), /desktop_login_session_unavailable/u);
  assert.equal(starts, 1, "a background status failure cannot open a browser");
  await runtime.startLogin("explicit-after-missing-poll");
  failure = "desktop_login_operation_failed";
  await assert.rejects(runtime.startLogin("generic-failure"), /desktop_login_operation_failed/u);
  assert.equal(starts, 2, "ordinary IPC failures must not be swallowed as missing sessions");
}

const collectionRun = {
  id: "intent-desktop-1", acquisitionRunId: "run-desktop-1",
  workspaceId: "workspace-desktop", planId: "plan-desktop-1",
  planVersionId: "plan-version-1", planVersion: 1,
  planSnapshotHash: `sha256:${"1".repeat(64)}`,
  policyVersionId: "policy-1", policyHash: `sha256:${"2".repeat(64)}`,
  accountId: "account-1", accountLoginStateVersion: 7,
  dailyBudgetId: `sha256:${"3".repeat(64)}`, localDate: "2026-09-02",
  trigger: "run_now" as const, collectCreators: true,
  collectDemandComments: true, status: "queued" as const, reason: null,
  createdBy: "owner-1", createdAt: now
};
const collectionTask = {
  taskId: "desktop-job-1", loginStateVersion: 7, keywords: ["工业除尘"],
  maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3,
  collectCreators: true, collectDemandComments: true,
  deadlineAt: "2026-09-02T09:00:00.000Z"
};
const taskToken = "opaque-desktop-task-capability-1234567890";
const jobResource = (overrides: Record<string, unknown> = {}) => ({
  jobId: collectionTask.taskId, runId: collectionRun.acquisitionRunId,
  state: "running" as const, leaseVersion: 1,
  leaseExpiresAt: "2026-09-02T08:01:00.000Z", cursor: null,
  recordCount: 0, ingestionState: null, cloudDurable: false,
  acknowledgedAt: null,
  activity: { phase: "queued" as const, currentKeyword: null,
    browserMode: "visible" as const, sequence: 1 },
  ...overrides
});
const terminalCollection = {
  taskId: collectionTask.taskId, state: "succeeded" as const,
  createdAt: now, updatedAt: now, completedAt: now, acknowledgedAt: null,
  recordCount: 1, pageCount: 1, failureCode: null,
  activity: { phase: "completed" as const, currentKeyword: null,
    browserMode: "visible" as const, sequence: 9 }
};
const collectionPage = {
  taskId: collectionTask.taskId, cursor: null, nextCursor: null, done: true,
  records: [{ recordId: "record-1", kind: "comment" as const,
    actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/7350000000000000001",
    publicDisplayName: "公开客户",
    publicProfileUrl: "https://www.douyin.com/user/customer-1",
    textExcerpt: "正在找除尘设备", sourceKeyword: "工业除尘",
    observedAt: now, contentHash: `sha256:${"4".repeat(64)}` }]
};
const syncOrder: string[] = [];
let prepareCount = 0;
let uploadCount = 0;
let acknowledgeDone!: () => void;
const acknowledged = new Promise<void>((resolve) => { acknowledgeDone = resolve; });
const collectionApi = {
  ...runtimeApi,
  prepareDesktopRun: async () => {
    syncOrder.push("prepare"); prepareCount += 1;
    return { run: collectionRun, taskToken, task: collectionTask };
  },
  claimDesktopJob: async () => { syncOrder.push("claim"); return jobResource(); },
  renewDesktopJob: async () => { syncOrder.push("renew"); return jobResource(); },
  uploadDesktopPage: async () => {
    uploadCount += 1; syncOrder.push(`upload-${uploadCount}`);
    if (uploadCount === 1) throw new Error("temporary_upload_failure");
    return { ...jobResource({ state: "succeeded", cursor: null }), replayed: false };
  },
  completeDesktopJob: async () => {
    syncOrder.push("complete");
    return jobResource({ state: "succeeded", ingestionState: "succeeded",
      cloudDurable: true, acknowledgedAt: now,
      activity: terminalCollection.activity });
  },
  cancelDesktopJob: async () => jobResource({ state: "cancelled" })
} as unknown as DouyinAutomationApi & DouyinDesktopSyncApi;
const collectionBridge = {
  ...desktopBridge,
  startDouyinCollection: async (_accountId: string, task: typeof collectionTask) => {
    syncOrder.push("local-start"); assert.equal(task.taskId, collectionTask.taskId);
    return { ...terminalCollection, state: "queued" as const, completedAt: null,
      recordCount: 0, pageCount: 0,
      activity: { ...terminalCollection.activity, phase: "queued" as const, sequence: 1 } };
  },
  getDouyinCollectionStatus: async () => {
    syncOrder.push("local-status"); return terminalCollection;
  },
  getDouyinCollectionResults: async () => {
    syncOrder.push("local-page"); return collectionPage;
  },
  acknowledgeDouyinCollection: async () => {
    syncOrder.push("local-ack"); acknowledgeDone();
  },
  cancelDouyinCollection: async () => undefined
} as unknown as ShensiDesktopApi;
const collectionRuntime = createAcquisitionBrowserRuntimes(collectionApi, {
  desktopBridge: collectionBridge, accountId: "workspace-desktop"
}).forSession(null);
const [startedRun, duplicateRun] = await Promise.all([
  collectionRuntime.startCollection(collectionRun.planId, "desktop-run-key"),
  collectionRuntime.startCollection(collectionRun.planId, "desktop-run-key")
]);
assert.equal(startedRun.id, collectionRun.id);
assert.equal(duplicateRun.id, collectionRun.id);
assert.equal(prepareCount, 1, "same desktop run identity must be single-flight");
await acknowledged;
assert.deepEqual(syncOrder, ["prepare", "local-start", "claim", "local-status",
  "renew", "local-page", "upload-1", "upload-2", "complete", "local-ack"],
"local acknowledgement must happen only after durable cloud completion");

const renewedIdentityLocalCancels: string[] = [];
{
  let pages = 0;
  let uploadedPages = 0;
  let acknowledge!: () => void;
  const done = new Promise<void>((resolve) => { acknowledge = resolve; });
  const runtime = createAcquisitionBrowserRuntimes({
    ...collectionApi,
    uploadDesktopPage: async () => { uploadedPages++; return { ...jobResource(), replayed: false }; }
  }, {
    accountId: "workspace-desktop",
    desktopBridge: { ...collectionBridge,
      getDouyinCollectionResults: async (_taskId: string, cursor?: string) => {
        assert.equal(cursor ?? null, pages === 0 ? null : `page-${pages}`);
        pages++;
        return { ...collectionPage, cursor: cursor ?? null,
          nextCursor: pages === 180 ? null : `page-${pages}`, done: pages === 180 };
      },
      acknowledgeDouyinCollection: async () => { acknowledge(); }
    }
  }).desktop;
  await runtime.startCollection(collectionRun.planId, "many-result-pages");
  await Promise.race([done, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error("result pagination did not finish")), 3000);
    done.then(() => clearTimeout(timeout));
  })]);
  assert.equal(uploadedPages, 180, "result pages must not be capped by the 90 video-page search budget");
}
const renewedIdentityCloudCancels: Array<{ jobId: string; leaseVersion: number }> = [];
const renewedIdentityApi = {
  ...collectionApi,
  prepareDesktopRun: async () => ({ run: collectionRun, taskToken, task: collectionTask }),
  claimDesktopJob: async () => jobResource(),
  renewDesktopJob: async () => jobResource({ jobId: "wrong-cloud-job" }),
  cancelDesktopJob: async (jobId: string, _token: string, leaseVersion: number) => {
    renewedIdentityCloudCancels.push({ jobId, leaseVersion });
    return jobResource({ state: "cancelled" });
  }
} as unknown as DouyinAutomationApi & DouyinDesktopSyncApi;
const renewedIdentityBridge = {
  ...collectionBridge,
  startDouyinCollection: async () => ({
    ...terminalCollection,
    state: "running" as const,
    completedAt: null,
    recordCount: 0,
    pageCount: 0,
    activity: {
      phase: "collecting_comments" as const,
      currentKeyword: "工业除尘",
      browserMode: "visible" as const,
      sequence: 4
    }
  }),
  getDouyinCollectionStatus: async () => ({
    ...terminalCollection,
    state: "running" as const,
    completedAt: null,
    recordCount: 0,
    pageCount: 0,
    activity: {
      phase: "collecting_comments" as const,
      currentKeyword: "工业除尘",
      browserMode: "visible" as const,
      sequence: 4
    }
  }),
  cancelDouyinCollection: async (taskId: string) => {
    renewedIdentityLocalCancels.push(taskId);
  }
} as unknown as ShensiDesktopApi;
const renewedIdentityRuntime = createAcquisitionBrowserRuntimes(renewedIdentityApi, {
  desktopBridge: renewedIdentityBridge,
  accountId: "workspace-desktop"
}).forSession(null);
await renewedIdentityRuntime.startCollection(
  collectionRun.planId, "renewed-identity-mismatch-key"
);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(renewedIdentityLocalCancels, [collectionTask.taskId],
  "a renewed cloud identity mismatch must cancel the local collection");
assert.deepEqual(renewedIdentityCloudCancels,
  [{ jobId: collectionTask.taskId, leaseVersion: 1 }],
  "a renewed cloud identity mismatch must fail closed at the cloud boundary");

const mismatchCancels: string[] = [];
const mismatchCloudCancels: Array<{ jobId: string; leaseVersion: number }> = [];
const mismatchApi = {
  ...collectionApi,
  prepareDesktopRun: async () => ({ run: collectionRun, taskToken, task: collectionTask }),
  cancelDesktopJob: async (jobId: string, _token: string, leaseVersion: number) => {
    mismatchCloudCancels.push({ jobId, leaseVersion });
    return jobResource({ state: "cancelled" });
  }
} as unknown as DouyinAutomationApi & DouyinDesktopSyncApi;
const mismatchCollectionBridge = {
  ...collectionBridge,
  startDouyinCollection: async () => ({ ...terminalCollection, taskId: "wrong-job" }),
  cancelDouyinCollection: async (taskId: string) => { mismatchCancels.push(taskId); }
} as unknown as ShensiDesktopApi;
const mismatchCollectionRuntime = createAcquisitionBrowserRuntimes(mismatchApi, {
  desktopBridge: mismatchCollectionBridge, accountId: "workspace-desktop"
}).forSession(null);
await assert.rejects(
  mismatchCollectionRuntime.startCollection(collectionRun.planId, "mismatch-run-key"),
  /desktop_collection_task_mismatch/u
);
assert.deepEqual(new Set(mismatchCancels), new Set(["wrong-job", "desktop-job-1"]));
assert.deepEqual(mismatchCloudCancels,
  [{ jobId: "desktop-job-1", leaseVersion: 0 }],
  "a local task mismatch must fail closed on both local and cloud boundaries");

let resolveLatePrepare!: (value: { run: typeof collectionRun;
  taskToken: string; task: typeof collectionTask }) => void;
const lateCloudCancels: number[] = [];
const lateCollectionApi = {
  ...collectionApi,
  prepareDesktopRun: async () => new Promise((resolve) => { resolveLatePrepare = resolve; }),
  cancelDesktopJob: async (_jobId: string, _token: string, leaseVersion: number) => {
    lateCloudCancels.push(leaseVersion);
    return jobResource({ state: "cancelled" });
  }
} as unknown as DouyinAutomationApi & DouyinDesktopSyncApi;
const lateCollectionStarts: string[] = [];
const lateCollectionBridge = {
  ...collectionBridge,
  startDouyinCollection: async () => {
    lateCollectionStarts.push("started"); return terminalCollection;
  }
} as unknown as ShensiDesktopApi;
const lateCollectionRuntime = createAcquisitionBrowserRuntimes(lateCollectionApi, {
  desktopBridge: lateCollectionBridge, accountId: "workspace-desktop"
}).forSession(null);
const lateCollectionAborter = new AbortController();
const lateCollectionStart = lateCollectionRuntime.startCollection(
  collectionRun.planId, "late-run-key", lateCollectionAborter.signal
);
await Promise.resolve();
lateCollectionAborter.abort();
resolveLatePrepare({ run: collectionRun, taskToken, task: collectionTask });
await assert.rejects(lateCollectionStart, (error: unknown) => error instanceof DOMException
  && error.name === "AbortError");
assert.deepEqual(lateCollectionStarts, [],
  "a late prepare response must not start a stale local collection");

// Local observations must not be confused with the Backend's persisted counts.
const liveCollection: DouyinCollectionStatus = {
  ...terminalCollection, state: "running", completedAt: null,
  recordCount: 300, pageCount: 12,
  activity: { phase: "collecting_comments", currentKeyword: "工业除尘",
    browserMode: "visible", sequence: 4 }
};
let releaseProgressRenew!: (value: ReturnType<typeof jobResource>) => void;
const progressRenew = new Promise<ReturnType<typeof jobResource>>((resolve) => {
  releaseProgressRenew = resolve;
});
const progressApi = {
  ...collectionApi,
  renewDesktopJob: async () => progressRenew
};
const progressBridge = {
  ...collectionBridge,
  controlDouyinCollection: async (taskId: string, action: "pause" | "resume" | "stop") => {
    assert.equal(taskId, collectionTask.taskId);
    return { ...liveCollection, controlState: action === "pause" ? "paused" as const : action === "resume" ? "running" as const : "stopping" as const };
  },
  getDouyinCollectionStatus: async () => liveCollection
};
let progressWorkspace = "workspace-desktop";
const progressRuntime = createAcquisitionBrowserRuntimes(progressApi, {
  desktopBridge: progressBridge, accountId: () => progressWorkspace
}).desktop;
const progressAborter = new AbortController();
await progressRuntime.startCollection(collectionRun.planId, "progress-key", progressAborter.signal);
assert.deepEqual(progressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId), liveCollection);
assert.equal(progressRuntime.getCollectionStatusForRun("other-run"), null);
for (const [action, expected] of [["pause", "paused"], ["resume", "running"], ["stop", "stopping"]] as const) {
  await progressRuntime.controlCollectionForRun(collectionRun.acquisitionRunId, action);
  assert.equal(progressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId)?.controlState, expected);
}
await assert.rejects(progressRuntime.controlCollectionForRun("other-run", "pause"));
progressWorkspace = "other-workspace";
assert.equal(progressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId), null,
  "a workspace switch must hide the previous workspace's local observation");
progressWorkspace = "workspace-desktop";
progressAborter.abort();
assert.equal(progressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId), null,
  "cancelled observations must disappear immediately, before asynchronous cleanup");
releaseProgressRenew(jobResource());

let resolveLateProgress!: (value: DouyinCollectionStatus) => void;
const lateProgress = new Promise<DouyinCollectionStatus>((resolve) => { resolveLateProgress = resolve; });
const lateProgressRuntime = createAcquisitionBrowserRuntimes(progressApi, {
  desktopBridge: { ...progressBridge, getDouyinCollectionStatus: async () => lateProgress },
  accountId: "workspace-desktop"
}).desktop;
const lateProgressAborter = new AbortController();
await lateProgressRuntime.startCollection(collectionRun.planId, "late-progress", lateProgressAborter.signal);
lateProgressAborter.abort();
resolveLateProgress(liveCollection);
await Promise.resolve();
assert.equal(lateProgressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId), null,
  "a late IPC result must not restore cancelled progress");

const failedProgressRuntime = createAcquisitionBrowserRuntimes({
  ...progressApi,
  renewDesktopJob: async () => { throw new Error("isolated_renew_failure"); }
}, { desktopBridge: progressBridge, accountId: "workspace-desktop" }).desktop;
const failedProgressAborter = new AbortController();
await failedProgressRuntime.startCollection(collectionRun.planId, "failed-progress", failedProgressAborter.signal);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(failedProgressRuntime.getCollectionStatusForRun(collectionRun.acquisitionRunId), null,
  "stopped synchronization must not keep advertising stale local activity as live");
failedProgressAborter.abort();

const controllerBridge: ShensiDesktopApi = {
  ...progressBridge,
  checkDouyinLogin: async () => { throw new Error("unused"); },
  getDesktopInstallationInfo: async () => { throw new Error("unused"); },
  registerDesktopInstallation: async () => { throw new Error("unused"); },
  recordDesktopBinding: async () => ({ recorded: true }),
  setDesktopWorkspace: async () => undefined,
  getDesktopOutreachStatus: async () => ({ state: "disabled", diagnostic: null,
    currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" }),
  onDesktopOutreachStatusChanged: () => () => undefined,
  getRuntimeInfo: async () => { throw new Error("unused"); },
  getConnectorStatus: async () => ({ state: "ready", protocolVersion: 1, diagnostic: null }),
  restartConnector: async () => { throw new Error("unused"); },
  openLogsDirectory: async () => undefined,
  getAppVersion: async () => "test",
  onConnectorStatus: () => () => undefined
};
for (const entry of ["open", "poll", "confirm"] as const) {
  let rejected = true;
  let starts = 0;
  let timers = 0;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const admissionRuntime = installDesktopRuntime({ shensiDesktop: { ...controllerBridge,
    getDesktopInstallationInfo: async () => ({ installationId: "a".repeat(43), protocolVersion: 1, registeredWorkspaceIds: ["workspace-desktop"] }),
    startDouyinLogin: async () => { starts++; return { ...(entry === "open" ? activeLoginStatus("admission") : loginStatus("admission")), expiresAt: expiry }; },
    getDouyinLoginStatus: async () => ({ ...(entry === "confirm" ? loginStatus("admission") : activeLoginStatus("admission")), expiresAt: expiry }),
    confirmDouyinLogin: async () => ({ ...activeLoginStatus("admission"), expiresAt: expiry })
  } }, { body: { dataset: { sessionWorkspaceId: "workspace-desktop" } } });
  await admissionRuntime.synchronizeWorkspace("workspace-desktop");
  const admissionApi: DouyinAutomationApi & Pick<DouyinDesktopSyncApi, "completeDesktopLogin"> = { ...runtimeApi,
    completeDesktopLogin: async () => {
      if (rejected) throw new AcquisitionHttpError(409, "desktop_client_build_not_admitted", "desktop_client_build_not_admitted");
      return cloudAccount;
    }
  };
  const admissionController = createDouyinAutomationController({ api: admissionApi,
  setTimer: (() => { timers++; return 0; }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout });
  await admissionController.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (entry === "confirm") { timers = 0; await admissionController.confirmLogin(); }
  assert.match(admissionController.getState().error ?? "", /应用版本与后台允许的版本不一致/u);
  assert.equal(admissionController.getState().loginSession?.authState, "authenticated");
  assert.equal(admissionController.getState().loginSession?.state, "awaiting_scan", "local auth is not a completed product connection");
  assert.equal(admissionController.getState().account, null);
  assert.equal(timers, 0, "deterministic admission rejection must stop automatic retries");
  rejected = false;
  await admissionController.confirmLogin();
  assert.equal(admissionController.getState().account?.id, cloudAccount.id);
  assert.equal(starts, 1, "recovery reuses the authenticated browser session");
  admissionController.close();
}

installDesktopRuntime({ shensiDesktop: controllerBridge }, {
  body: { dataset: { sessionWorkspaceId: "workspace-desktop" } }
});
let persistedStatus: DouyinCrawlerStatus = {
  runId: collectionRun.acquisitionRunId, state: "running" as const,
  attempt: 1, cursorPersisted: false, recordCount: 0,
  candidateBudgetUsed: 0, candidateBudgetLimit: 5, candidateProjectionState: "pending" as const,
  lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null,
  activity: { phase: "queued" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 0 }
};
const createProgressController = () => createDouyinAutomationController({
  api: { ...progressApi,
    listAccounts: async () => ({ items: [] }),
    getAutomation: async () => null as never,
    getCrawlerStatus: async () => persistedStatus,
    listRunCandidates: async () => ({ items: [], nextCursor: null }) },
  setTimer: (() => 0) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
const progressController = createProgressController();
await progressController.load(collectionRun.planId, "工业除尘");
await progressController.runNow();
assert.equal(progressController.getState().localCrawlerStatus?.recordCount, 300,
  "controller polling must publish the matching local observation");
assert.equal(progressController.getState().crawlerStatus?.recordCount, 0,
  "the local count must never overwrite the Backend's durable count");
persistedStatus = { ...persistedStatus, state: "partial", recordCount: 38,
  candidateBudgetUsed: 5, candidateProjectionState: "ready", completedAt: now,
  lastErrorCode: "crawler_candidate_budget_exhausted",
  activity: { phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 5 }
};
await progressController.refreshRun();
assert.equal(progressController.getState().localCrawlerStatus, null,
  "a Backend terminal result takes precedence over cached local progress");
await progressController.load("another-plan", "另一计划");
assert.equal(progressController.getState().localCrawlerStatus, null);
progressController.close();

for (const { failCloud, openReplacement } of [
  { failCloud: false, openReplacement: false },
  { failCloud: true, openReplacement: false },
  { failCloud: false, openReplacement: true }
]) {
  const cancelled: string[] = [];
  const confirmed = new Set<string>();
  let starts = 0;
  let retireOld = false;
  let finishDisconnect!: () => void;
  let failDisconnect!: (error: Error) => void;
  const pendingDisconnect = new Promise<void>((resolve, reject) => { finishDisconnect = resolve; failDisconnect = reject; });
  const installed = installDesktopRuntime({ shensiDesktop: { ...controllerBridge,
    startDouyinLogin: async () => ({ ...loginStatus(`route-exit-${++starts}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    getDouyinLoginStatus: async (id: string) => retireOld && id === "route-exit-1"
      ? { ...loginStatus(id), state: "expired" }
      : confirmed.has(id) ? activeLoginStatus(id) : new Promise<DouyinLoginStatus>(() => {}),
    confirmDouyinLogin: async (id: string) => { confirmed.add(id); return activeLoginStatus(id); },
    cancelDouyinLogin: async (id: string) => { cancelled.push(id); }
  } }, { body: { dataset: { sessionWorkspaceId: "workspace-desktop" } } });
  await installed.synchronizeWorkspace("workspace-desktop").catch(() => undefined);
  const controller = createDouyinAutomationController({ api: { ...runtimeApi,
    ...{ completeDesktopLogin: async () => cloudAccount },
    listAccounts: async () => ({ items: [cloudAccount] }),
    disconnectAccount: async () => pendingDisconnect
  }, setTimer: (() => 0) as unknown as typeof setTimeout, clearTimer: (() => undefined) as typeof clearTimeout });
  await controller.load(null);
  await controller.connect();
  await controller.confirmLogin();
  const disconnect = controller.disconnect();
  controller.abort();
  await controller.load(null);
  if (openReplacement) {
    retireOld = true;
    await controller.connect();
    assert.equal(controller.getState().loginSession?.id, "route-exit-2");
  }
  if (failCloud) failDisconnect(Error("cloud_disconnect_fixture_failed"));
  else finishDisconnect();
  await disconnect;
  assert.deepEqual(cancelled, failCloud || openReplacement ? [] : ["route-exit-1"],
    "successful cloud disconnect must release its captured login after the route generation changes");
  if (openReplacement) {
    await controller.confirmLogin();
    assert.equal(controller.getState().loginSession?.id, "route-exit-2");
    assert.equal(controller.getState().loginSession?.state, "active",
      "late old cloud success must not clear or invalidate a newer login");
  }
  if (failCloud) {
    await controller.connect();
    assert.equal(starts, 1, "late cloud failure must preserve the previous local login");
    assert.equal(controller.getState().loginSession?.id, "route-exit-1");
  }
  controller.close();
}

for (const { disconnectFails, loggedIn, routeReentry } of [
  { disconnectFails: false, loggedIn: false, routeReentry: false },
  { disconnectFails: false, loggedIn: true, routeReentry: false },
  { disconnectFails: true, loggedIn: false, routeReentry: false },
  { disconnectFails: false, loggedIn: true, routeReentry: true },
  { disconnectFails: true, loggedIn: true, routeReentry: true }
]) {
  const cancelled: string[] = [];
  const confirmed = new Set<string>();
  const completionKeys: string[] = [];
  let starts = 0;
  let resolvePoll!: (status: DouyinLoginStatus) => void;
  const installed = installDesktopRuntime({ shensiDesktop: { ...controllerBridge,
    startDouyinLogin: async () => ({ ...loginStatus(`disconnect-${++starts}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    getDouyinLoginStatus: async (id: string) => confirmed.has(id) ? activeLoginStatus(id)
      : new Promise<DouyinLoginStatus>((resolve) => { resolvePoll = resolve; }),
    confirmDouyinLogin: async (id: string) => { confirmed.add(id); return activeLoginStatus(id); },
    cancelDouyinLogin: async (id: string) => { cancelled.push(id); confirmed.delete(id); }
  } }, { body: { dataset: { sessionWorkspaceId: "workspace-desktop" } } });
  await installed.synchronizeWorkspace("workspace-desktop").catch(() => undefined);
  const policy = { ...draftPolicy, keywords: ["郑州网约车租赁"] };
  const reconnectController = createDouyinAutomationController({ api: {
    ...runtimeApi,
    ...{ completeDesktopLogin: async (_input: unknown, key: string) => { completionKeys.push(key); return cloudAccount; } },
    listAccounts: async () => ({ items: [cloudAccount] }),
    getAutomation: async () => policy as never,
    disconnectAccount: async () => { if (disconnectFails) throw Error("disconnect_fixture_failed"); }
  }, setTimer: (() => 0) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout });
  await reconnectController.load("plan-reconnect", "郑州");
  await reconnectController.connect();
  if (loggedIn) {
    await reconnectController.confirmLogin();
    assert.equal(reconnectController.getState().loginSession?.state, "active");
  }
  const resolveOldPoll = resolvePoll;
  if (routeReentry) {
    reconnectController.abort();
    assert.equal(reconnectController.getState().loginSession, null);
    assert.deepEqual(cancelled, [], "leaving the route must not disconnect an authenticated account");
    await reconnectController.load("plan-reconnect", "郑州");
    assert.equal(reconnectController.getState().account?.state, "active");
    assert.equal(reconnectController.getState().loginSession, null);
  }
  await reconnectController.disconnect();
  assert.equal(reconnectController.getState().account?.id ?? null,
    disconnectFails ? cloudAccount.id : null, "failed disconnect must retain the account");
  assert.deepEqual(cancelled, disconnectFails ? [] : ["disconnect-1"],
    "successful disconnect must release the local login session before reopening");
  assert.equal(reconnectController.getState().planName, "郑州");
  assert.deepEqual(reconnectController.getState().draftPolicy.keywords, ["郑州网约车租赁"]);
  if (!disconnectFails) {
    await reconnectController.connect();
    assert.equal(starts, 2);
    assert.equal(reconnectController.getState().loginSession?.id, "disconnect-2");
  }
  resolveOldPoll(activeLoginStatus("disconnect-1"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!disconnectFails) assert.equal(reconnectController.getState().account, null,
    "a late old poll cannot restore the disconnected account");
  if (!disconnectFails && loggedIn) {
    assert.equal(completionKeys.length, 1, "reconnect must not republish the old active login");
    await reconnectController.confirmLogin();
    assert.equal(completionKeys.length, 2);
    assert.notEqual(completionKeys[0], completionKeys[1], "a new login must have a new completion key");
  }
  if (disconnectFails && loggedIn) {
    await reconnectController.connect();
    assert.equal(starts, 1, "failed cloud disconnect must retain the runtime's current login");
    assert.equal(reconnectController.getState().loginSession?.id, "disconnect-1");
    assert.deepEqual(cancelled, []);
    assert.equal(completionKeys[0], completionKeys[1], "the retained login keeps its completion identity");
  }
  reconnectController.close();
}

{
  let starts = 0;
  let timers = 0;
  installDesktopRuntime({ shensiDesktop: { ...controllerBridge,
    startDouyinLogin: async () => ({ ...loginStatus(`unavailable-poll-${++starts}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    getDouyinLoginStatus: async () => { throw Error("desktop_login_session_unavailable"); }
  } }, { body: { dataset: { sessionWorkspaceId: "workspace-desktop" } } });
  const stoppedPollController = createDouyinAutomationController({ api: runtimeApi,
    setTimer: (() => { timers++; return 0; }) as unknown as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout });
  await stoppedPollController.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stoppedPollController.getState().loginSession?.state, "login_expired");
  assert.equal(timers, 0, "Main session absence is terminal, not an infinite polling failure");
  assert.equal(starts, 1, "poll failure cannot automatically reopen the browser");
  await stoppedPollController.connect();
  assert.equal(starts, 2, "the expired presentation must allow an explicit reconnect");
  stoppedPollController.close();
}

installDesktopRuntime({ shensiDesktop: controllerBridge }, {
  body: { dataset: { sessionWorkspaceId: "workspace-desktop" } }
});
persistedStatus = { ...persistedStatus, state: "running", candidateProjectionState: "pending",
  recordCount: 0, completedAt: null, lastErrorCode: null };
for (const reset of ["abort", "close"] as const) {
  const resettingController = createProgressController();
  await resettingController.load(collectionRun.planId, "工业除尘");
  await resettingController.runNow();
  assert.equal(resettingController.getState().localCrawlerStatus?.recordCount, 300);
  resettingController[reset]();
  assert.equal(resettingController.getState().localCrawlerStatus, null,
    `${reset} must clear the copied UI observation as well as cancelling the runtime`);
  resettingController.close();
}
installDesktopRuntime({}, { body: { dataset: {} } });
assert.deepEqual(lateCloudCancels, [0],
  "a late prepared cloud job must be cancelled with its unclaimed generation");

console.log(JSON.stringify({ ok: true, suite: "acquisition-browser-runtime" }));
