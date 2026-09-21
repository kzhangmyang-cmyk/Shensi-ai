import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { DouyinAutomationController, DouyinAutomationState } from "./douyin-automation-controller";
import type { DouyinCrawlerStatus } from "./douyin-automation-api";
import { mountDouyinAutomationView, renderDouyinAutomationView } from "./douyin-automation-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const draftPolicy = {
  keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }
};
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "", planStatus: null, account: null, loginSession: null,
  policy: null, draftPolicy, runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [],
  selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /连接抖音账号/u);
assert.doesNotMatch(host.textContent ?? "", /每日候选人/u);
assert.match(host.textContent ?? "", /手工关键词无需搜索 API 或 AI 模型/u);
assert.match(host.textContent ?? "", /AI 智能生成（可选）/u);
assert.match(host.textContent ?? "", /仅保存/u);
assert.match(host.textContent ?? "", /保存并立即运行/u);
assert.match(host.textContent ?? "", /请先连接抖音账号/u);
assert.match(host.textContent ?? "", /打开抖音登录页/u);
assert.ok(host.querySelector<HTMLInputElement>("[name=planName]"));
const stablePlanInput = host.querySelector<HTMLInputElement>("[name=planName]");
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "", planStatus: null, account: null, loginSession: null,
  policy: null, draftPolicy, runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [],
  selectedCandidateIds: [], error: null, suggestionError: null, closed: false,
  connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null }
});
assert.equal(host.querySelector("[name=planName]") === stablePlanInput, true,
  "connector status refresh must preserve the focused form node instead of replacing the host");
assert.doesNotMatch(host.innerHTML, /cookie|accountHandle|browserProfile/iu);

const connectedAccount = { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, displayName: "测试模拟账号", state: "active" as const, loginStateVersion: 1, revision: 1, etag: '"account:1"', lastValidatedAt: null, createdAt: "2026-08-25T09:30:00.000Z", updatedAt: "2026-08-25T09:30:00.000Z" };
const expiredAccount = { ...connectedAccount, state: "login_expired" as const };
const queuedRunIntent = { id: "intent-waiting-1", acquisitionRunId: "run-waiting-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now" as const, collectCreators: true, collectDemandComments: true, status: "queued" as const, reason: null, createdBy: "user-1", createdAt: "2026-08-25T09:30:00.000Z" };
renderDouyinAutomationView(host, {
  phase: "loading", planId: null, planName: "", planStatus: null,
  account: expiredAccount, loginSession: null, policy: null, draftPolicy,
  runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [],
  selectedCandidateIds: [], error: null, connectionPending: true,
  suggestionError: null, closed: false
});
const pendingReconnectButton = host.querySelector<HTMLButtonElement>(
  ".douyin-account-card [data-douyin-action=connect]"
);
assert.ok(pendingReconnectButton);
assert.equal(pendingReconnectButton.disabled, true,
  "a pending reconnect must disable its trigger");
assert.match(pendingReconnectButton.textContent ?? "", /正在打开/u,
  "a pending reconnect must expose visible progress");

const interactiveLoginState: DouyinAutomationState = {
  phase: "ready", planId: null, planName: "", planStatus: null,
  account: null,
  loginSession: {
    id: "login-interactive", platform: "douyin", state: "awaiting_scan",
    qrImageDataUrl: "data:image/png;base64,UVJDT0RFX01VU1RfTk9UX1JFTkRFUg==",
    qrStatus: "ready",
    failureCode: null,
    loginPage: {
      imageDataUrl: "data:image/png;base64,TE9HSU5fUEFHRQ==",
      width: 800,
      height: 400
    },
    expiresAt: "2026-08-25T10:30:00.000Z", account: null
  },
  policy: null, draftPolicy, runIntent: null, activeRunId: null,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null,
  interactionPending: false, suggestionError: null, closed: false
};
for (const state of ["awaiting_scan", "active"] as const) {
  renderDouyinAutomationView(host, {
    ...interactiveLoginState,
    account: state === "active" ? connectedAccount : null,
    loginSession: {
      ...interactiveLoginState.loginSession!,
      state,
      interactionSurface: "external_window",
      runtimeState: "stopped",
      authState: "authenticated",
      taskState: "completed",
      qrImageDataUrl: null,
      qrStatus: null,
      loginPage: null,
      account: state === "active" ? connectedAccount : null
    }
  });
  const externalLoginStatus = host.querySelector(".douyin-login-status")?.textContent ?? "";
  if (state === "awaiting_scan") {
    assert.match(externalLoginStatus, /正在绑定账号/u,
      "local authentication alone must still show the pending account synchronization");
    assert.doesNotMatch(externalLoginStatus, /登录已保存/u,
      "a pending login synchronization must not claim completion");
  } else {
    assert.match(externalLoginStatus, /登录已保存/u,
      "an active external login must tell the user that authentication was saved");
    assert.match(externalLoginStatus, /登录窗口已自动关闭/u,
      "an active external login must explain why its browser window disappeared");
    assert.doesNotMatch(externalLoginStatus, /正在绑定|设备已绑定/u,
      "completed login must neither look pending nor claim separate device binding succeeded");
  }
}
renderDouyinAutomationView(host, {
  ...interactiveLoginState,
  connectionPending: false,
  loginSession: { ...interactiveLoginState.loginSession!, loginPage: null, qrStatus: "opening" }
});
const loadingLoginDialog = host.querySelector<HTMLDialogElement>(".douyin-login-dialog");
assert.ok(loadingLoginDialog);
assert.match(loadingLoginDialog.textContent ?? "", /正在载入抖音登录页…/u,
  "a fast placeholder session must show an explicit page-loading state");
assert.match(loadingLoginDialog.textContent ?? "", /正在打开抖音登录页并生成二维码/u,
  "a placeholder must describe server startup rather than a page that does not exist");
assert.doesNotMatch(loadingLoginDialog.textContent ?? "", /登录页已打开/u,
  "a null login page must never claim that the page opened");
assert.equal(loadingLoginDialog.querySelector("[data-douyin-login-surface]"), null,
  "a null login page must not render an empty interaction surface");
const openingCreateSessionButton = loadingLoginDialog.querySelector<HTMLButtonElement>(
  "[data-douyin-action=create-session]"
);
assert.ok(openingCreateSessionButton);
assert.equal(openingCreateSessionButton.disabled, true,
  "an opening login session must not allow another bootstrap to be created");
assert.doesNotMatch(
  host.querySelector(".douyin-account-card [data-douyin-action=connect]")?.textContent ?? "",
  /正在打开/u,
  "the account button must stop showing pending after the placeholder response"
);
for (const qrStatus of [
  "ready",
  "expired",
  "network_error",
  "verification_required",
  null
] as const) {
  renderDouyinAutomationView(host, {
    ...interactiveLoginState,
    connectionPending: false,
    loginSession: {
      ...interactiveLoginState.loginSession!,
      loginPage: null,
      qrStatus
    }
  });
  const unavailableCompatibilityCapture = host.querySelector<HTMLDialogElement>(
    ".douyin-login-dialog"
  );
  assert.ok(unavailableCompatibilityCapture);
  assert.match(
    unavailableCompatibilityCapture.textContent ?? "",
    /兼容截图暂不可用，可继续使用安全登录窗口\/二维码状态/u,
    `${String(qrStatus)} without a compatibility screenshot must keep the live login path available`
  );
  assert.doesNotMatch(
    unavailableCompatibilityCapture.textContent ?? "",
    /正在载入抖音登录页|登录已失效/u,
    `${String(qrStatus)} without a compatibility screenshot must not look like startup or an expired login`
  );
}
const loginInteractions: unknown[] = [];
let loginReconnectCalls = 0;
let loginCancelCalls = 0;
const loginTeardownOrder: string[] = [];
let loginStateListener: ((state: DouyinAutomationState) => void) | null = null;
let embeddedLiveMountCalls = 0;
let embeddedLiveUnmountCalls = 0;
const interactiveLoginController = {
  getState: () => interactiveLoginState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    loginStateListener = listener;
    listener(interactiveLoginState);
    return () => undefined;
  },
  connect: async () => { loginReconnectCalls += 1; },
  cancelLogin: async () => {
    loginCancelCalls += 1;
    loginTeardownOrder.push("delete-start");
  },
  interactLogin: async (input: unknown) => { loginInteractions.push(input); }
} as unknown as DouyinAutomationController;
const unmountInteractiveLogin = mountDouyinAutomationView(
  host,
  interactiveLoginController,
  () => undefined,
  {
    mountLiveLogin(target, sessionId) {
      embeddedLiveMountCalls += 1;
      assert.equal(sessionId, "login-interactive");
      target.textContent = `RFB ${sessionId}`;
      return () => {
        embeddedLiveUnmountCalls += 1;
        loginTeardownOrder.push("rfb-disconnect");
      };
    }
  }
);
const loginDialog = host.querySelector<HTMLDialogElement>(".douyin-login-dialog");
assert.ok(loginDialog, "an awaiting login session must render the interactive login dialog");
const embeddedLiveLogin = loginDialog.querySelector<HTMLElement>(
  "[data-douyin-embedded-live-login]"
);
assert.ok(embeddedLiveLogin,
  "the acquisition dialog must embed the real RFB login surface as its primary flow");
assert.match(embeddedLiveLogin.textContent ?? "", /RFB login-interactive/u);
assert.equal(embeddedLiveMountCalls, 1);
assert.equal(loginDialog.querySelector("iframe"), null,
  "the real login surface must not be embedded through a regular iframe");
const liveLoginLink = loginDialog.querySelector<HTMLAnchorElement>("[data-douyin-live-login]");
assert.ok(liveLoginLink, "an awaiting session must retain a new-tab fallback");
assert.equal(liveLoginLink.getAttribute("href"),
  "#douyin-live-login?sessionId=login-interactive");
assert.equal(liveLoginLink.getAttribute("target"), "_blank");
assert.match(liveLoginLink.getAttribute("rel") ?? "", /noopener/u);
assert.match(liveLoginLink.textContent ?? "", /新标签页.*备用/u);
assert.equal(liveLoginLink.classList.contains("primary"), false,
  "the new-tab fallback must not be styled as the primary login action");
const legacyLoginFallback = loginDialog.querySelector<HTMLDetailsElement>(
  "[data-douyin-login-fallback]"
);
assert.ok(legacyLoginFallback, "the screenshot controls must remain available as a fallback");
assert.equal(legacyLoginFallback.hasAttribute("open"), false,
  "the misleading screenshot controls must not be the default login surface");
assert.match(loginDialog.textContent ?? "", /二维码已就绪，请使用抖音 App 扫码/u,
  "the login dialog must describe QR readiness from qrStatus rather than RFB connectivity");
assert.doesNotMatch(loginDialog.textContent ?? "", /生成二维码/u);
assert.match(loginDialog.textContent ?? "", /刷新二维码/u,
  "the real window must explain that its Douyin page is directly interactive");
assert.equal(loginDialog.querySelector('img[alt="抖音登录页面实时画面"]')?.getAttribute("src"),
  "data:image/png;base64,TE9HSU5fUEFHRQ==");
assert.equal(loginDialog.querySelector('img[alt="可使用抖音 App 扫描的登录二维码"]')?.getAttribute("src"),
  "data:image/png;base64,UVJDT0RFX01VU1RfTk9UX1JFTkRFUg==",
  "a ready QR must remain directly scannable even if the remote browser is obstructed");
const refreshQrButton = loginDialog.querySelector<HTMLButtonElement>("[data-douyin-action=refresh-qr]");
assert.ok(refreshQrButton, "an interactive login page must expose an explicit QR refresh action");
assert.match(refreshQrButton.textContent ?? "", /刷新二维码/u);
const createSessionButton = loginDialog.querySelector<HTMLButtonElement>("[data-douyin-action=create-session]");
assert.ok(createSessionButton, "a fresh session action must be separate from QR and RFB recovery");
assert.match(createSessionButton.textContent ?? "", /创建新登录会话/u);
refreshQrButton.click();
await Promise.resolve();
assert.deepEqual(loginInteractions.pop(), { type: "refresh_qr" },
  "refreshing a QR must use the semantic interaction rather than a guessed canvas coordinate");
const loginSurface = loginDialog.querySelector<HTMLElement>("[data-douyin-login-surface]");
assert.ok(loginSurface);
assert.equal(loginSurface.getAttribute("tabindex"), "0",
  "the live login page must be keyboard focusable");
Object.defineProperty(loginSurface, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250 })
});
const emitInteractiveLoginState = loginStateListener as unknown as ((state: DouyinAutomationState) => void) | null;
assert.ok(emitInteractiveLoginState);
const loginPointerDown = new document.defaultView!.Event("pointerdown", { bubbles: true, cancelable: true });
Object.defineProperties(loginPointerDown, {
  pointerId: { value: 7 },
  button: { value: 0 },
  isPrimary: { value: true },
  clientX: { value: 180 },
  clientY: { value: 100 }
});
loginSurface.dispatchEvent(loginPointerDown);
emitInteractiveLoginState({
  ...interactiveLoginState,
  loginSession: {
    ...interactiveLoginState.loginSession!,
    loginPage: {
      ...interactiveLoginState.loginSession!.loginPage!,
      imageDataUrl: "data:image/png;base64,TE9HSU5fUEFHRV9QT0xMRUQ="
    }
  }
});
const rerenderedLoginSurface = host.querySelector<HTMLElement>("[data-douyin-login-surface]");
assert.ok(rerenderedLoginSurface);
assert.equal(rerenderedLoginSurface === loginSurface, true,
  "a polling frame preserves the live login surface");
assert.equal(
  host.querySelector<HTMLElement>("[data-douyin-embedded-live-login]"),
  embeddedLiveLogin,
  "polling renders for the same session must preserve the mounted RFB host"
);
assert.equal(embeddedLiveMountCalls, 1,
  "polling renders for the same session must not create a duplicate RFB connection");
const loginPointerUp = new document.defaultView!.Event("pointerup", { bubbles: true, cancelable: true });
Object.defineProperties(loginPointerUp, {
  pointerId: { value: 7 },
  button: { value: 0 },
  isPrimary: { value: true },
  clientX: { value: 180 },
  clientY: { value: 100 }
});
rerenderedLoginSurface.dispatchEvent(loginPointerUp);
await Promise.resolve();
assert.deepEqual(loginInteractions, [
  { type: "click", normalizedX: 0.2, normalizedY: 0.25 }
], "a pointer gesture must survive a polling render between press and release");
const synthesizedLoginClick = new document.defaultView!.Event("click", { bubbles: true, cancelable: true });
Object.defineProperties(synthesizedLoginClick, {
  clientX: { value: 180 },
  clientY: { value: 100 }
});
rerenderedLoginSurface.dispatchEvent(synthesizedLoginClick);
assert.equal(loginInteractions.length, 1,
  "the click synthesized after pointerup must not send a duplicate interaction");
await new Promise((resolve) => setTimeout(resolve, 0));
const dragPointerDown = new document.defaultView!.Event("pointerdown", { bubbles: true, cancelable: true });
Object.defineProperties(dragPointerDown, {
  pointerId: { value: 8 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 180 }, clientY: { value: 100 }
});
rerenderedLoginSurface.dispatchEvent(dragPointerDown);
const dragPointerUp = new document.defaultView!.Event("pointerup", { bubbles: true, cancelable: true });
Object.defineProperties(dragPointerUp, {
  pointerId: { value: 8 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 220 }, clientY: { value: 140 }
});
rerenderedLoginSurface.dispatchEvent(dragPointerUp);
assert.equal(loginInteractions.length, 1,
  "dragging over the remote page must not be mistaken for a click");
const loginClick = new document.defaultView!.Event("click", { bubbles: true, cancelable: true });
Object.defineProperties(loginClick, {
  clientX: { value: 200 },
  clientY: { value: 200 }
});
rerenderedLoginSurface.dispatchEvent(loginClick);
const loginCharacter = new document.defaultView!.Event("keydown", { bubbles: true, cancelable: true });
Object.defineProperty(loginCharacter, "key", { value: "袜" });
rerenderedLoginSurface.dispatchEvent(loginCharacter);
const loginEnter = new document.defaultView!.Event("keydown", { bubbles: true, cancelable: true });
Object.defineProperty(loginEnter, "key", { value: "Enter" });
rerenderedLoginSurface.dispatchEvent(loginEnter);
const loginWheel = new document.defaultView!.Event("wheel", { bubbles: true, cancelable: true });
Object.defineProperties(loginWheel, {
  deltaX: { value: 100 },
  deltaY: { value: -50 }
});
rerenderedLoginSurface.dispatchEvent(loginWheel);
await Promise.resolve();
assert.deepEqual(loginInteractions, [
  { type: "click", normalizedX: 0.2, normalizedY: 0.25 },
  { type: "click", normalizedX: 0.25, normalizedY: 0.75 },
  { type: "text", text: "袜" },
  { type: "key", key: "Enter" },
  { type: "scroll", deltaX: 0.25, deltaY: -0.25 }
], "pointer, keyboard, and wheel input must use the closed normalized interaction contract");
emitInteractiveLoginState({ ...interactiveLoginState, interactionPending: true });
const pendingLoginSurface = host.querySelector<HTMLElement>("[data-douyin-login-surface]");
assert.ok(pendingLoginSurface);
Object.defineProperty(pendingLoginSurface, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250 })
});
const pendingPointerDown = new document.defaultView!.Event("pointerdown", {
  bubbles: true, cancelable: true
});
Object.defineProperties(pendingPointerDown, {
  pointerId: { value: 10 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 300 }, clientY: { value: 150 }
});
pendingLoginSurface.dispatchEvent(pendingPointerDown);
const pendingPointerUp = new document.defaultView!.Event("pointerup", {
  bubbles: true, cancelable: true
});
Object.defineProperties(pendingPointerUp, {
  pointerId: { value: 10 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 300 }, clientY: { value: 150 }
});
pendingLoginSurface.dispatchEvent(pendingPointerUp);
const pendingSynthesizedClick = new document.defaultView!.Event("click", {
  bubbles: true, cancelable: true
});
Object.defineProperties(pendingSynthesizedClick, {
  clientX: { value: 300 }, clientY: { value: 150 }
});
pendingLoginSurface.dispatchEvent(pendingSynthesizedClick);
const pendingWheel = new document.defaultView!.Event("wheel", {
  bubbles: true, cancelable: true
});
Object.defineProperties(pendingWheel, {
  deltaX: { value: 80 }, deltaY: { value: 40 }
});
pendingLoginSurface.dispatchEvent(pendingWheel);
const pendingCharacter = new document.defaultView!.Event("keydown", {
  bubbles: true, cancelable: true
});
Object.defineProperty(pendingCharacter, "key", { value: "补" });
pendingLoginSurface.dispatchEvent(pendingCharacter);
await Promise.resolve();
assert.deepEqual(loginInteractions, [
  { type: "click", normalizedX: 0.2, normalizedY: 0.25 },
  { type: "click", normalizedX: 0.25, normalizedY: 0.75 },
  { type: "text", text: "袜" },
  { type: "key", key: "Enter" },
  { type: "scroll", deltaX: 0.25, deltaY: -0.25 },
  { type: "text", text: "补" }
], "a pending login interaction must ignore another mouse click and wheel while preserving text entry");
await new Promise((resolve) => setTimeout(resolve, 0));
emitInteractiveLoginState({ ...interactiveLoginState, interactionPending: false });
const refreshButtonBeforePoll = host.querySelector<HTMLButtonElement>(
  ".douyin-login-dialog [data-douyin-action=create-session]"
);
assert.ok(refreshButtonBeforePoll);
const refreshPointerDown = new document.defaultView!.Event("pointerdown", { bubbles: true, cancelable: true });
Object.defineProperties(refreshPointerDown, {
  pointerId: { value: 9 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 300 }, clientY: { value: 300 }
});
refreshButtonBeforePoll.dispatchEvent(refreshPointerDown);
emitInteractiveLoginState({
  ...interactiveLoginState,
  loginSession: {
    ...interactiveLoginState.loginSession!,
    loginPage: {
      ...interactiveLoginState.loginSession!.loginPage!,
      imageDataUrl: "data:image/png;base64,TE9HSU5fUEFHRV9SRUZSRVNIRUQ="
    }
  }
});
const refreshButtonAfterPoll = host.querySelector<HTMLButtonElement>(
  ".douyin-login-dialog [data-douyin-action=create-session]"
);
assert.ok(refreshButtonAfterPoll);
assert.equal(refreshButtonAfterPoll === refreshButtonBeforePoll, true);
const refreshPointerUp = new document.defaultView!.Event("pointerup", { bubbles: true, cancelable: true });
Object.defineProperties(refreshPointerUp, {
  pointerId: { value: 9 }, button: { value: 0 }, isPrimary: { value: true },
  clientX: { value: 300 }, clientY: { value: 300 }
});
refreshButtonAfterPoll.dispatchEvent(refreshPointerUp);
await Promise.resolve();
assert.equal(loginReconnectCalls, 1,
  "the stable refresh fallback must survive a polling render");
refreshButtonAfterPoll.dispatchEvent(new document.defaultView!.Event("click", {
  bubbles: true, cancelable: true
}));
assert.equal(loginReconnectCalls, 1,
  "the click synthesized after the refresh pointer gesture must not request a duplicate session");
const currentLoginDialog = host.querySelector<HTMLDialogElement>(".douyin-login-dialog");
assert.ok(currentLoginDialog);
Object.defineProperty(currentLoginDialog, "close", {
  value: () => currentLoginDialog.removeAttribute("open")
});
host.querySelector<HTMLButtonElement>("[data-douyin-action=close-login]")?.click();
await Promise.resolve();
assert.equal(loginReconnectCalls, 1, "closing the dialog must not create another login session");
assert.equal(loginCancelCalls, 1,
  "closing the dialog must cancel the server login session");
assert.equal(embeddedLiveUnmountCalls, 1,
  "closing the login dialog must dispose its embedded RFB connection");
assert.deepEqual(loginTeardownOrder, ["rfb-disconnect", "delete-start"],
  "closing the login dialog must disconnect RFB before starting the server DELETE");
assert.equal(currentLoginDialog.hasAttribute("open"), false,
  "closing the dialog must only hide the current frontend surface");
emitInteractiveLoginState({ ...interactiveLoginState, interactionPending: true });
assert.equal(
  host.querySelector<HTMLDialogElement>(".douyin-login-dialog")?.hasAttribute("open"),
  false,
  "polling updates must not reopen a login dialog the user closed"
);
unmountInteractiveLogin();

for (const [qrStatus, expectedCopy] of [
  ["opening", /正在打开抖音登录页并生成二维码/u],
  ["expired", /二维码已失效，请点击“刷新二维码”/u],
  ["network_error", /二维码请求失败，请检查网络后重试/u],
  ["verification_required", /抖音要求完成安全验证/u],
  [null, /正在读取二维码状态/u]
] as const) {
  renderDouyinAutomationView(host, {
    ...interactiveLoginState,
    loginSession: { ...interactiveLoginState.loginSession!, qrStatus }
  });
  assert.match(host.querySelector(".douyin-login-dialog")?.textContent ?? "", expectedCopy,
    `qrStatus ${String(qrStatus)} must have precise user-facing copy`);
  if (qrStatus === "expired" || qrStatus === "network_error") {
    assert.equal(host.querySelector('img[alt="可使用抖音 App 扫描的登录二维码"]'), null,
      `${qrStatus} must not display a stale QR payload`);
  }
}

let scannedStateListener: ((state: DouyinAutomationState) => void) | null = null;
let scannedLiveUnmountCalls = 0;
const scannedLoginController = {
  getState: () => interactiveLoginState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    scannedStateListener = listener;
    listener(interactiveLoginState);
    return () => undefined;
  },
  connect: async () => undefined,
  cancelLogin: async () => undefined,
  interactLogin: async () => undefined
} as unknown as DouyinAutomationController;
const unmountScannedLogin = mountDouyinAutomationView(
  host,
  scannedLoginController,
  () => undefined,
  {
    mountLiveLogin() {
      return () => { scannedLiveUnmountCalls += 1; };
    }
  }
);
await Promise.resolve();
const emitScannedState = scannedStateListener as unknown as (
  (state: DouyinAutomationState) => void
) | null;
assert.ok(emitScannedState);
emitScannedState({
  ...interactiveLoginState,
  account: connectedAccount,
  loginSession: {
    ...interactiveLoginState.loginSession!,
    state: "active",
    qrImageDataUrl: null,
    loginPage: null,
    account: connectedAccount
  }
});
assert.equal(host.querySelector("[data-douyin-embedded-live-login]"), null,
  "a confirmed scan must remove the embedded login surface");
assert.equal(scannedLiveUnmountCalls, 1,
  "a confirmed scan must dispose the RFB connection after account binding");
assert.match(host.textContent ?? "", /测试模拟账号/u,
  "the account returned by login polling must become the connected account view");
unmountScannedLogin();
assert.equal(scannedLiveUnmountCalls, 1,
  "view cleanup must not disconnect an already disposed RFB twice");

for (const [failureCode, expectedCopy] of [
  ["douyin_login_ui_unsupported", /当前抖音登录页暂不受支持/u],
  ["douyin_verification_required", /抖音要求完成安全验证/u],
  ["douyin_login_page_unavailable", /无法读取抖音登录页面/u],
  ["douyin_login_page_not_allowed", /抖音登录页面拒绝访问/u],
  ["douyin_browser_unavailable", /安全登录环境暂时不可用/u],
  ["douyin_browser_command_timeout", /登录页响应超时/u],
  ["douyin_login_open_failed", /抖音登录页打开失败/u]
] as const) {
  renderDouyinAutomationView(host, {
    ...interactiveLoginState,
    loginSession: {
      ...interactiveLoginState.loginSession!,
      loginPage: null,
      failureCode
    }
  });
  assert.match(host.querySelector(".douyin-login-dialog")?.textContent ?? "", expectedCopy,
    `${failureCode} must render actionable localized copy`);
}
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "工业需求计划", planStatus: null,
  account: connectedAccount, loginSession: null, policy: null, draftPolicy,
  runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [],
  error: null, suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /至少添加 1 个关键词/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);

renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "工业需求计划", planStatus: null,
  account: connectedAccount,
  loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["工业除尘"] }, runIntent: null, activeRunId: null,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null,
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /尚未保存/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-only]")?.disabled, false);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, false);

renderDouyinAutomationView(host, {
  phase: "error", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: queuedRunIntent, activeRunId: queuedRunIntent.acquisitionRunId,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: "状态读取超时",
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /已提交采集，等待服务器返回首次观测状态/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);
assert.ok(host.querySelector<HTMLElement>(".douyin-run-panel [role=status][aria-live=polite][aria-atomic=true]"));

renderDouyinAutomationView(host, {
  phase: "error", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: queuedRunIntent, activeRunId: queuedRunIntent.acquisitionRunId,
  crawlerStatus: {
    runId: "run-old", state: "succeeded", attempt: 1, cursorPersisted: true,
    recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "ready",
    lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z",
    updatedAt: "2026-08-25T09:31:00.000Z", completedAt: "2026-08-25T09:31:00.000Z",
    activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 5 }
  },
  candidates: [], selectedCandidateIds: [], error: "状态读取超时", suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /已提交采集，等待服务器返回首次观测状态/u);
assert.doesNotMatch(host.textContent ?? "", /采集完成/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);

renderDouyinAutomationView(host, {
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent: null,
  activeRunId: "run-live-1",
  crawlerStatus: {
    runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true,
    recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "pending",
    lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z",
    updatedAt: "2026-08-25T09:31:00.000Z", completedAt: null,
    activity: {
      phase: "collecting_comments", currentKeyword: "袜子",
      browserMode: "visible", sequence: 4
    }
  },
  candidates: [{
    id: "candidate-live-1", status: "comment_candidate", displayName: "袜子采购用户",
    evidence: { sourceUrl: "https://www.douyin.com/video/live-1", excerpt: "公开评论中询问袜子批发" }
  }],
  selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});
const candidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(host.textContent ?? "", /采集中/u);
assert.match(host.textContent ?? "", /可视窗口已打开/u);
assert.match(host.textContent ?? "", /正在采集评论/u);
assert.match(host.textContent ?? "", /当前关键词：袜子/u);
assert.ok(host.querySelector<HTMLElement>(".douyin-run-live-activity[role=status][aria-live=polite][aria-atomic=true]"));
assert.match(host.textContent ?? "", /第 1 次尝试/u);
assert.doesNotMatch(host.textContent ?? "", /历史额度|采集候选上限/u);
assert.doesNotMatch(host.textContent ?? "", /采集进度|%/u);
assert.ok(candidatePanel.querySelector(".douyin-candidate-workspace"));
assert.equal(candidatePanel.querySelectorAll(".douyin-candidate-row").length, 1);
assert.match(candidatePanel.textContent ?? "", /袜子采购用户/u);
assert.match(candidatePanel.textContent ?? "", /公开评论中询问袜子批发/u);
assert.doesNotMatch(candidatePanel.textContent ?? "", /正在发现候选人|暂无候选人/u);

const candidateEvidenceState: DouyinAutomationState = {
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: null,
  activeRunId: "run-live-1", crawlerStatus: {
    runId: "run-live-1", state: "succeeded", attempt: 1, cursorPersisted: true,
    recordCount: 2, candidateBudgetUsed: 2, candidateBudgetLimit: 50,
    candidateProjectionState: "ready", lastErrorCode: null,
    createdAt: "2026-08-25T09:30:00.000Z", updatedAt: "2026-08-25T09:31:00.000Z",
    completedAt: "2026-08-25T09:31:00.000Z",
    activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 5 }
  }, candidates: [{
    id: "candidate-profile-1", status: "creator_candidate", displayName: "内容创作者",
    evidence: { sourceUrl: "https://www.douyin.com/user/creator-1", excerpt: "公开主页资料" }
  }, {
    id: "candidate-comment-1", status: "comment_candidate", displayName: "需求评论者",
    evidence: { sourceUrl: "https://www.douyin.com/video/video-1", excerpt: "公开评论需求" }
  }], selectedCandidateIds: [], error: null, suggestionError: null, closed: false
};
renderDouyinAutomationView(host, candidateEvidenceState);
const candidateInputs = host.querySelectorAll<HTMLInputElement>("[data-douyin-candidate]");
assert.equal(candidateInputs[0]?.disabled, true);
assert.equal(candidateInputs[1]?.disabled, false);
assert.match(host.querySelectorAll<HTMLElement>(".douyin-candidate-row")[0]?.textContent ?? "",
  /缺少可评论视频/u);
assert.match(host.querySelectorAll<HTMLElement>(".douyin-candidate-row")[0]?.textContent ?? "",
  /仅查看/u);
assert.match(host.querySelectorAll<HTMLElement>(".douyin-candidate-row")[1]?.textContent ?? "",
  /可评论/u);
assert.match(host.querySelectorAll<HTMLElement>(".douyin-candidate-row")[1]?.textContent ?? "",
  /未加入本批次/u);

const inspectableEvidenceState: DouyinAutomationState = {
  ...candidateEvidenceState,
  candidates: [...candidateEvidenceState.candidates].reverse()
};
const inspectableEvidenceController = {
  getState: () => inspectableEvidenceState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(inspectableEvidenceState);
    return () => undefined;
  },
  toggleCandidate() {
    throw new Error("viewing evidence must not toggle outreach selection");
  }
} as unknown as DouyinAutomationController;
const candidateDetailRequests: unknown[] = [];
const captureCandidateDetailRequest = (event: Event) => {
  candidateDetailRequests.push((event as CustomEvent).detail);
};
document.addEventListener("goodjob:acquisition-detail-open-requested", captureCandidateDetailRequest);
let privateDomainEntryBatchCalls = 0;
const unmountInspectableEvidence = mountDouyinAutomationView(
  host,
  inspectableEvidenceController,
  () => { privateDomainEntryBatchCalls += 1; }
);
assert.deepEqual(candidateDetailRequests, [],
  "mounting candidate evidence must not open details or start a private-domain workflow");
const inspectableRows = host.querySelectorAll<HTMLElement>(".douyin-candidate-row");
assert.equal(host.querySelector<HTMLElement>(".douyin-evidence-inspector h4")?.textContent, "需求评论者");
inspectableRows[1]?.querySelector<HTMLElement>("strong")?.click();
assert.equal(host.querySelector<HTMLElement>(".douyin-evidence-inspector h4")?.textContent, "内容创作者",
  "clicking a profile-only candidate must inspect its evidence without selecting it");
assert.equal(host.querySelectorAll("[data-douyin-candidate]:checked").length, 0);
assert.deepEqual(candidateDetailRequests, [],
  "inspecting a profile must remain passive until the explicit private-domain entry is clicked");
const profilePrivateDomainEntry = host.querySelector<HTMLButtonElement>("[data-douyin-action=review-candidate]");
assert.ok(profilePrivateDomainEntry, "the selected candidate must expose the existing review/private-domain entry");
assert.equal(profilePrivateDomainEntry.disabled, false,
  "private-domain review must not require a commentable video or a successful outreach action");
profilePrivateDomainEntry.click();
assert.deepEqual(candidateDetailRequests, [{
  mode: "candidates", planId: "plan-1", candidateId: "candidate-profile-1",
  candidateRunId: "run-live-1"
}]);
const inspectWithKeyboard = new document.defaultView!.Event("keydown", { bubbles: true });
Object.defineProperty(inspectWithKeyboard, "key", { value: "Enter" });
host.querySelectorAll<HTMLElement>(".douyin-candidate-row")[0]?.dispatchEvent(inspectWithKeyboard);
assert.equal(host.querySelector<HTMLElement>(".douyin-evidence-inspector h4")?.textContent, "需求评论者",
  "Enter on a candidate row must inspect its evidence");
assert.equal(host.querySelectorAll("[data-douyin-candidate]:checked").length, 0);
assert.equal(candidateDetailRequests.length, 1,
  "keyboard inspection must not implicitly open candidate review");
host.querySelector<HTMLButtonElement>("[data-douyin-action=review-candidate]")!.click();
assert.deepEqual(candidateDetailRequests[1], {
  mode: "candidates", planId: "plan-1", candidateId: "candidate-comment-1",
  candidateRunId: "run-live-1"
}, "the explicit entry must follow the currently inspected candidate");
assert.equal(privateDomainEntryBatchCalls, 0,
  "opening candidate review must not create an outreach batch");
unmountInspectableEvidence();
document.removeEventListener("goodjob:acquisition-detail-open-requested", captureCandidateDetailRequest);

const queuedStatus: DouyinCrawlerStatus = {
  runId: "run-queued-1", state: "queued" as const, attempt: 0, cursorPersisted: false,
  recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: 50, candidateProjectionState: "pending" as const,
  lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z", updatedAt: "2026-08-25T09:30:00.000Z", completedAt: null,
  activity: { phase: "queued" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 0 }
};
const observedState = (crawlerStatus: DouyinCrawlerStatus, error: string | null = null) => ({
  phase: "ready" as const, planId: "plan-1", planName: "袜子获客计划", planStatus: "approved" as const,
  account: connectedAccount, loginSession: null, policy: null, draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent: { ...queuedRunIntent, acquisitionRunId: crawlerStatus.runId }, activeRunId: crawlerStatus.runId, crawlerStatus, candidates: [], selectedCandidateIds: [], error, suggestionError: null, closed: false
});
const queuedPlaceholderState = (runIntent = queuedRunIntent): DouyinAutomationState => ({
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null, draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent, activeRunId: runIntent.acquisitionRunId, crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});

const savedQuotaPolicy: NonNullable<DouyinAutomationState["policy"]> = {
  ...draftPolicy, id: "policy-50", source: "version", workspaceId: "workspace-1", planId: "plan-1",
  planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", accountId: "account-1",
  accountLoginStateVersion: 1, version: 2, revision: 2, etag: '"policy:2"', policyHash: "hash-50",
  createdBy: "user-1", createdAt: "2026-09-10T00:00:00.000Z"
};
renderDouyinAutomationView(host, {
  ...observedState({ ...queuedStatus, state: "partial", candidateBudgetUsed: 5, candidateBudgetLimit: 5,
    candidateProjectionState: "ready", completedAt: "2026-09-05T15:02:05.000Z" }),
  policy: savedQuotaPolicy,
  // An unsaved input must not pretend that the persisted plan already changed.
  draftPolicy: { ...draftPolicy, dailyCandidateLimit: 99 }
});
assert.doesNotMatch(host.textContent ?? "", /历史额度|采集候选上限/u);
assert.equal(host.querySelector('[name="dailyCandidateLimit"]'), null);
renderDouyinAutomationView(host, observedState({ ...queuedStatus, candidateBudgetLimit: null }));
assert.doesNotMatch(host.textContent ?? "", /历史额度|采集候选上限/u);
renderDouyinAutomationView(host, queuedPlaceholderState());
renderDouyinAutomationView(host, observedState({ ...queuedStatus, state: "cancelled" }));
assert.doesNotMatch(host.querySelector(".douyin-run-observation")?.textContent ?? "", /排队中|等待浏览器启动/u);
assert.match(host.querySelector(".douyin-run-observation")?.textContent ?? "", /已取消|已停止/u);
renderDouyinAutomationView(host, queuedPlaceholderState());
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "the first pre-status run announcement may be polite");
renderDouyinAutomationView(host, queuedPlaceholderState());
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "off", "the same pre-status run must not repeat its announcement");
renderDouyinAutomationView(host, observedState({ ...queuedStatus, runId: queuedRunIntent.acquisitionRunId }));
const nextQueuedIntent = { ...queuedRunIntent, id: "intent-waiting-2", acquisitionRunId: "run-waiting-2" };
renderDouyinAutomationView(host, queuedPlaceholderState(nextQueuedIntent));
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "a new run must announce after status reset");
renderDouyinAutomationView(host, { ...queuedPlaceholderState(nextQueuedIntent), runIntent: null });
renderDouyinAutomationView(host, queuedPlaceholderState(nextQueuedIntent));
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "clearing the run intent must reset a later queued announcement");
renderDouyinAutomationView(host, observedState(queuedStatus));
const firstObservation = host.querySelector<HTMLElement>(".douyin-run-live-activity")!;
assert.match(firstObservation.textContent ?? "", /等待浏览器启动/u);
assert.doesNotMatch(firstObservation.textContent ?? "", /后台浏览器运行中/u);
assert.equal(firstObservation.getAttribute("aria-live"), "polite", "a new queued sequence may announce once");
assert.equal(firstObservation.querySelector("time"), null, "timestamps must remain outside the live region");
renderDouyinAutomationView(host, observedState({ ...queuedStatus, updatedAt: "2026-08-25T09:31:00.000Z" }));
const timestampRefresh = host.querySelector<HTMLElement>(".douyin-run-live-activity")!;
assert.equal(timestampRefresh.getAttribute("aria-live"), "off", "timestamp-only rerenders must not repeat the activity announcement");
assert.match(host.textContent ?? "", /更新于/u);

const localCrawlerStatus = {
  taskId: "desktop-job-live", state: "running" as const,
  createdAt: queuedStatus.createdAt, updatedAt: "2026-08-25T09:31:00.000Z",
  completedAt: null, acknowledgedAt: null, recordCount: 300, pageCount: 12, failureCode: null,
  activity: { phase: "collecting_comments" as const, currentKeyword: "工业除尘",
    browserMode: "visible" as const, sequence: 4 }
};
renderDouyinAutomationView(host, { ...observedState(queuedStatus), localCrawlerStatus });
assert.match(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /正在采集评论.*可视窗口已打开.*工业除尘/u);
assert.match(host.querySelector(".douyin-run-metrics")?.textContent ?? "", /本机公开记录300.*已入库公开记录0/u);
assert.equal(host.querySelector<HTMLInputElement>("[name=maxComments]")?.value, "100");
renderDouyinAutomationView(host, { ...observedState(queuedStatus), localCrawlerStatus: {
  ...localCrawlerStatus, commentCount: 80, commentTarget: 100
} });
assert.match(host.querySelector(".douyin-run-metrics")?.textContent ?? "", /本机已保存去重评论80 \/ 100/u);
assert.doesNotMatch(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /等待浏览器启动/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true,
  "local observations must not unlock another run");
for (const controlState of ["running", "pausing", "paused", "stopping"] as const) {
  renderDouyinAutomationView(host, { ...observedState(queuedStatus), localCrawlerStatus: {
    ...localCrawlerStatus, controlState
  } });
  const resume = host.querySelector<HTMLButtonElement>("[data-douyin-action=resume-collection]");
  assert.equal(Boolean(resume), controlState === "paused");
  const stop = host.querySelector<HTMLButtonElement>("[data-douyin-action=stop-collection]");
  assert.equal(stop?.disabled, controlState === "stopping");
  assert.match(host.textContent ?? "", /暂停时间不计入采集时长/u);
}
renderDouyinAutomationView(host, { ...observedState(queuedStatus), localCrawlerStatus: {
  ...localCrawlerStatus, state: "succeeded", completedAt: localCrawlerStatus.updatedAt,
  activity: { ...localCrawlerStatus.activity, phase: "completed", currentKeyword: null, sequence: 5 }
} });
assert.match(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /本机采集结束，等待结果入库/u);
assert.doesNotMatch(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /可视窗口已打开/u);
renderDouyinAutomationView(host, { ...observedState({ ...queuedStatus, state: "partial",
  recordCount: 38, candidateProjectionState: "ready" }), localCrawlerStatus });
assert.doesNotMatch(host.querySelector(".douyin-run-metrics")?.textContent ?? "", /本机已采集/u);
assert.match(host.querySelector(".douyin-run-metrics")?.textContent ?? "", /公开记录38/u);
renderDouyinAutomationView(host, observedState({ ...queuedStatus, state: "partial",
  recordCount: 38, candidateProjectionState: "ready",
  activity: { phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 5 }
}));
assert.match(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /浏览器采集已结束/u);
assert.doesNotMatch(host.querySelector(".douyin-run-live-activity")?.textContent ?? "", /可视窗口已打开|等待分配关键词/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "succeeded", candidateProjectionState: "pending",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
const pendingCandidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(pendingCandidatePanel.textContent ?? "", /正在整理候选人/u);
assert.doesNotMatch(pendingCandidatePanel.textContent ?? "", /暂无候选人/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "running", candidateProjectionState: "pending",
  activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 2 }
}));
const runningCandidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(runningCandidatePanel.textContent ?? "", /正在发现候选人/u);
assert.doesNotMatch(runningCandidatePanel.textContent ?? "", /公开记录已保存|正在整理候选人/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "partial", candidateProjectionState: "ready", lastErrorCode: "mediacrawler_partial",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
assert.match(host.textContent ?? "", /采集已部分完成，请检查公开记录后再继续/u);
assert.doesNotMatch(host.textContent ?? "", /mediacrawler_partial/u);
renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "failed", candidateProjectionState: "failed", lastErrorCode: "unrecognized_internal_fault",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 2 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
assert.match(host.textContent ?? "", /采集遇到问题，请稍后重试或联系管理员/u);
assert.doesNotMatch(host.textContent ?? "", /unrecognized_internal_fault/u);

const ingestionErrorStatus: DouyinCrawlerStatus = {
  ...queuedStatus, state: "failed", candidateProjectionState: "failed", lastErrorCode: "crawler_ingestion_failed",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 3 }, completedAt: "2026-08-25T09:31:00.000Z"
};
renderDouyinAutomationView(host, observedState(ingestionErrorStatus));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "polite", "a newly appearing ingestion error must announce");
renderDouyinAutomationView(host, observedState({ ...ingestionErrorStatus, updatedAt: "2026-08-25T09:32:00.000Z" }));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "off", "timestamp-only rerenders must not repeat the same error");
renderDouyinAutomationView(host, observedState({ ...ingestionErrorStatus, lastErrorCode: null }));
assert.equal(host.querySelector(".douyin-safe-reason"), null);
renderDouyinAutomationView(host, observedState(ingestionErrorStatus));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "polite", "an error must announce again after it was cleared");

const recoveredCandidate = {
  id: "candidate-recovered-1",
  status: "comment_candidate",
  displayName: "恢复后的袜子采购用户",
  evidence: {
    sourceUrl: "https://www.douyin.com/video/recovered-1",
    excerpt: "公开评论中询问袜子批发"
  }
};
const recoveredViewState = {
  ...observedState({
    ...queuedStatus,
    runId: "run-recovered",
    state: "partial",
    candidateProjectionState: "ready",
    lastErrorCode: "mediacrawler_partial",
    activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 },
    completedAt: "2026-08-25T09:31:00.000Z"
  }),
  activeRunId: "run-recovered",
  runIntent: null,
  candidates: [recoveredCandidate],
  selectedCandidateIds: [recoveredCandidate.id]
} as DouyinAutomationState & { activeRunId: string };
const recoveredViewController = {
  getState: () => recoveredViewState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(recoveredViewState);
    return () => undefined;
  }
} as unknown as DouyinAutomationController;
let recoveredBatch: { runId: string; candidateIds: string[] } | null = null;
const unmountRecoveredView = mountDouyinAutomationView(
  host,
  recoveredViewController,
  (runId, candidateIds) => { recoveredBatch = { runId, candidateIds }; }
);
const recoveredBatchButton = host.querySelector<HTMLButtonElement>("[data-douyin-action=create-batch]");
assert.ok(recoveredBatchButton, "a restored candidate selection must expose the batch action");
recoveredBatchButton.click();
assert.deepEqual(
  recoveredBatch,
  { runId: "run-recovered", candidateIds: ["candidate-recovered-1"] },
  "a restored run must create an approval batch without requiring a transient run intent"
);
unmountRecoveredView();

const historicalViewState: DouyinAutomationState = {
  ...recoveredViewState,
  crawlerStatus: null,
  historicalRun: true,
  error: null
};
renderDouyinAutomationView(host, historicalViewState);
assert.match(host.textContent ?? "", /历史采集结果/u);
assert.match(host.textContent ?? "", /已载入保存的候选人与公开证据/u);
assert.doesNotMatch(host.textContent ?? "", /暂无采集运行|crawler_status_not_found/u);

let batchCreationCalls = 0;
let finishBatchCreation!: () => void;
const pendingBatchCreation = new Promise<void>((resolve) => {
  finishBatchCreation = resolve;
});
const unmountSerializedBatchCreation = mountDouyinAutomationView(
  host,
  recoveredViewController,
  async () => {
    batchCreationCalls += 1;
    await pendingBatchCreation;
  }
);
const serializedBatchButton = host.querySelector<HTMLButtonElement>(
  "[data-douyin-action=create-batch]"
)!;
serializedBatchButton.click();
serializedBatchButton.click();
assert.equal(batchCreationCalls, 1,
  "rapid repeated clicks must create only one approval batch");
assert.equal(serializedBatchButton.disabled, true,
  "batch creation must disable its trigger while the request is pending");
assert.match(serializedBatchButton.textContent ?? "", /正在生成/u);
finishBatchCreation();
await pendingBatchCreation;
await Promise.resolve();
assert.equal(
  host.querySelector<HTMLButtonElement>("[data-douyin-action=create-batch]")?.disabled,
  false,
  "the batch action must recover after creation settles"
);
unmountSerializedBatchCreation();

const recoveredStatusErrorState: DouyinAutomationState = {
  ...recoveredViewState,
  phase: "error",
  crawlerStatus: null,
  candidates: [],
  selectedCandidateIds: [],
  error: "状态暂时不可用"
};
let recoveredReloadArgs: [string | null, string | undefined, string | null | undefined] | null = null;
let recoveredRefreshCalls = 0;
let recoveredReconnectCalls = 0;
const recoveredRetryController = {
  getState: () => recoveredStatusErrorState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(recoveredStatusErrorState);
    return () => undefined;
  },
  load: async (planId: string | null, planName?: string, latestRunId?: string | null) => {
    recoveredReloadArgs = [planId, planName, latestRunId];
  },
  connect: async () => { recoveredReconnectCalls += 1; },
  refreshRun: async () => { recoveredRefreshCalls += 1; }
} as unknown as DouyinAutomationController;
const unmountRecoveredRetry = mountDouyinAutomationView(host, recoveredRetryController, () => undefined);
assert.equal(
  host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled,
  true,
  "a restored run without an observed status must keep direct launch disabled"
);
host.querySelector<HTMLButtonElement>("[data-douyin-action=retry]")?.click();
await Promise.resolve();
assert.deepEqual(
  recoveredReloadArgs,
  ["plan-1", "袜子获客计划", "run-recovered"],
  "retry must reload account, policy, and the restored run together"
);
assert.equal(recoveredRefreshCalls, 0);
assert.equal(recoveredReconnectCalls, 0,
  "ordinary load errors must keep the existing load retry action");
unmountRecoveredRetry();

const reconnectErrorState = {
  ...recoveredStatusErrorState,
  account: null,
  loginSession: null,
  activeRunId: null,
  error: "抖音登录服务暂时不可用，请稍后重新打开登录页。",
  errorRetry: "reconnect"
} as DouyinAutomationState;
let loginErrorReconnectCalls = 0;
let loginReloadCalls = 0;
const reconnectRetryController = {
  getState: () => reconnectErrorState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(reconnectErrorState);
    return () => undefined;
  },
  connect: async () => { loginErrorReconnectCalls += 1; },
  load: async () => { loginReloadCalls += 1; }
} as unknown as DouyinAutomationController;
const unmountReconnectRetry = mountDouyinAutomationView(
  host,
  reconnectRetryController,
  () => undefined
);
const reconnectButton = host.querySelector<HTMLButtonElement>(
  ".douyin-alert [data-douyin-action=connect]"
);
assert.ok(reconnectButton,
  "a login server error must offer an explicit reconnect action");
assert.match(reconnectButton.textContent ?? "", /重新打开登录页/u);
reconnectButton.click();
await Promise.resolve();
assert.equal(loginErrorReconnectCalls, 1);
assert.equal(loginReloadCalls, 0,
  "a login error retry must create a new login session instead of reloading plans");
unmountReconnectRetry();

let passiveErrorListener: ((state: DouyinAutomationState) => void) | null = null;
const passiveErrorController = {
  getState: () => recoveredStatusErrorState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    passiveErrorListener = listener;
    return () => undefined;
  }
} as unknown as DouyinAutomationController;
const htmlElementPrototype = document.defaultView!.HTMLElement.prototype;
const originalFocus = htmlElementPrototype.focus;
let passiveAlertFocusCalls = 0;
htmlElementPrototype.focus = function focus(options?: FocusOptions) {
  if (this.matches("[role=alert]")) passiveAlertFocusCalls += 1;
  originalFocus.call(this, options);
};
let unmountPassiveError: (() => void) | null = null;
try {
  unmountPassiveError = mountDouyinAutomationView(
    host,
    passiveErrorController,
    () => undefined
  );
  const emitPassiveError = passiveErrorListener as unknown as (
    state: DouyinAutomationState
  ) => void;
  assert.ok(emitPassiveError);
  emitPassiveError(recoveredStatusErrorState);
  assert.equal(passiveAlertFocusCalls, 0,
    "a passive controller refresh must not focus an alert and move the user's scroll position");
} finally {
  unmountPassiveError?.();
  htmlElementPrototype.focus = originalFocus;
}
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-view" }));
