import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { AcquisitionHttpError } from "./douyin-automation-api";
import { mountDouyinLiveLoginPage, type DouyinLiveRfb } from "./douyin-live-login";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const events = new Map<string, Set<EventListener>>();
let disconnected = false;
let connectedUrl = "";
const fakeRfb: DouyinLiveRfb = {
  viewOnly: true,
  scaleViewport: false,
  resizeSession: false,
  focusOnClick: false,
  addEventListener(type, listener) {
    const listeners = events.get(type) ?? new Set<EventListener>();
    listeners.add(listener as EventListener);
    events.set(type, listeners);
  },
  removeEventListener(type, listener) {
    events.get(type)?.delete(listener as EventListener);
  },
  disconnect() { disconnected = true; }
};

const unmount = await mountDouyinLiveLoginPage(host, {
  sessionId: "login/1",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession(sessionId) {
      assert.equal(sessionId, "login/1");
      return {
        socketPath: "/douyin-live/token-1",
        expiresAt: "2026-08-25T10:00:00.000Z"
      };
    }
  },
  createRfb(target, url) {
    assert.equal(target.getAttribute("data-douyin-live-screen"), "");
    target.innerHTML = "<canvas data-stale-frame></canvas>";
    connectedUrl = url;
    return fakeRfb;
  }
});

assert.equal(connectedUrl, "wss://trial.shensi.example/douyin-live/token-1");
assert.equal(fakeRfb.viewOnly, false);
assert.equal(fakeRfb.scaleViewport, true);
assert.equal(fakeRfb.resizeSession, true);
assert.equal(fakeRfb.focusOnClick, true);
events.get("connect")?.forEach((listener) => listener(new document.defaultView!.Event("connect")));
assert.match(host.textContent ?? "", /远程画面已连接/u);
assert.doesNotMatch(host.textContent ?? "", /二维码已就绪/u,
  "an RFB connection must never be presented as QR readiness");
assert.match(host.querySelector("[data-douyin-live-reconnect]")?.textContent ?? "", /重新连接画面/u,
  "RFB recovery must have a distinct screen-only label");
events.get("disconnect")?.forEach((listener) => listener(new document.defaultView!.Event("disconnect")));
assert.equal(host.querySelector("[data-stale-frame]"), null,
  "an RFB disconnect must remove its stale last frame");
unmount();
assert.equal(disconnected, true);

const pendingDocument = parseHTML("<main id='pending-host'></main>").document;
const pendingHost = pendingDocument.querySelector<HTMLElement>("#pending-host")!;
let finishPendingLiveSession!: (value: {
  socketPath: string;
  expiresAt: string;
}) => void;
const pendingLiveSession = new Promise<{
  socketPath: string;
  expiresAt: string;
}>((resolve) => { finishPendingLiveSession = resolve; });
const pendingSignals: AbortSignal[] = [];
let pendingLiveSessionAttempts = 0;
let staleRfbCreations = 0;
const pendingCleanups: Array<() => void> = [];
void mountDouyinLiveLoginPage(pendingHost, {
  sessionId: "login-pending",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession(_sessionId, signal) {
      pendingLiveSessionAttempts += 1;
      if (signal) pendingSignals.push(signal);
      return pendingLiveSession;
    }
  },
  createRfb() {
    staleRfbCreations += 1;
    return fakeRfb;
  }
}).then((cleanup) => { pendingCleanups.push(cleanup); });
await Promise.resolve();
await Promise.resolve();
assert.equal(pendingCleanups.length, 1,
  "mount must expose cleanup before the first live-session request settles");
const pendingReconnect = pendingHost.querySelector<HTMLButtonElement>(
  "[data-douyin-live-reconnect]"
)!;
pendingReconnect.click();
pendingReconnect.click();
assert.equal(pendingLiveSessionAttempts, 1,
  "double reconnect while a live-session request is pending must reuse one request");
pendingCleanups[0]!();
assert.equal(pendingSignals[0]?.aborted, true,
  "unmount must abort an in-flight live-session request");
finishPendingLiveSession({
  socketPath: "/douyin-live/stale-token",
  expiresAt: "2026-08-25T10:00:00.000Z"
});
await Promise.resolve();
await Promise.resolve();
assert.equal(staleRfbCreations, 0,
  "a late response from an unmounted session must not create or replace an RFB client");

const retryDocument = parseHTML("<main id='retry-host'></main>").document;
const retryHost = retryDocument.querySelector<HTMLElement>("#retry-host")!;
const retryCallbacks: Array<() => void> = [];
let liveSessionAttempts = 0;
let retryRfbCreations = 0;
const retryRfb: DouyinLiveRfb = {
  viewOnly: true,
  scaleViewport: false,
  resizeSession: false,
  focusOnClick: false,
  addEventListener() { /* no-op fixture */ },
  removeEventListener() { /* no-op fixture */ },
  disconnect() { /* no-op fixture */ }
};
const unmountRetry = await mountDouyinLiveLoginPage(retryHost, {
  sessionId: "login-starting",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession() {
      liveSessionAttempts += 1;
      throw new AcquisitionHttpError(503, "mediacrawler_unavailable", "sidecar unavailable");
    }
  },
  createRfb() {
    retryRfbCreations += 1;
    return retryRfb;
  },
  retryDelayMs: 250,
  setTimer: ((callback: () => void, delay?: number) => {
    assert.equal(delay, 250);
    retryCallbacks.push(callback);
    return retryCallbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
assert.match(retryHost.textContent ?? "", /登录服务暂时不可用/u,
  "an unavailable sidecar must surface a terminal failure");
assert.equal(retryCallbacks.length, 0,
  "a generic 503 must not be mistaken for a context that is still starting");
assert.equal(retryRfbCreations, 0);
assert.equal(liveSessionAttempts, 1);
unmountRetry();

const controlledRetryDocument = parseHTML("<main id='controlled-retry-host'></main>").document;
const controlledRetryHost = controlledRetryDocument.querySelector<HTMLElement>(
  "#controlled-retry-host"
)!;
const controlledRetryCallbacks: Array<() => void> = [];
let controlledRetryAttempts = 0;
let controlledRetryRfbCreations = 0;
const unmountControlledRetry = await mountDouyinLiveLoginPage(controlledRetryHost, {
  sessionId: "login-controlled-retry",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession() {
      controlledRetryAttempts += 1;
      if (controlledRetryAttempts === 1) {
        throw new AcquisitionHttpError(
          409,
          "douyin_login_session_not_ready",
          "context is starting"
        );
      }
      return {
        socketPath: "/douyin-live/controlled-token",
        expiresAt: "2026-08-25T10:00:00.000Z"
      };
    }
  },
  createRfb() {
    controlledRetryRfbCreations += 1;
    return retryRfb;
  },
  retryDelayMs: 250,
  setTimer: ((callback: () => void, delay?: number) => {
    assert.equal(delay, 250);
    controlledRetryCallbacks.push(callback);
    return controlledRetryCallbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await Promise.resolve();
assert.equal(controlledRetryAttempts, 1);
assert.equal(controlledRetryCallbacks.length, 1,
  "a not-ready live context must schedule exactly one retry");
const controlledReconnect = controlledRetryHost.querySelector<HTMLButtonElement>(
  "[data-douyin-live-reconnect]"
)!;
controlledReconnect.click();
controlledReconnect.click();
await Promise.resolve();
assert.equal(controlledRetryAttempts, 1,
  "manual reconnect clicks must not bypass an already scheduled not-ready retry");
assert.equal(controlledRetryCallbacks.length, 1,
  "manual reconnect clicks must not add parallel retry timers");
controlledRetryCallbacks[0]?.();
await Promise.resolve();
await Promise.resolve();
assert.equal(controlledRetryAttempts, 2,
  "the scheduled retry must make one new live-session request");
assert.equal(controlledRetryRfbCreations, 1,
  "the successful retry must create one RFB client for the current session");
unmountControlledRetry();

const cancelledRetryDocument = parseHTML("<main id='cancelled-retry-host'></main>").document;
const cancelledRetryHost = cancelledRetryDocument.querySelector<HTMLElement>(
  "#cancelled-retry-host"
)!;
const cancelledRetryCallbacks: Array<() => void> = [];
const clearedRetryHandles: Array<ReturnType<typeof setTimeout>> = [];
let cancelledRetryAttempts = 0;
const unmountCancelledRetry = await mountDouyinLiveLoginPage(cancelledRetryHost, {
  sessionId: "login-cancelled-retry",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession() {
      cancelledRetryAttempts += 1;
      throw new AcquisitionHttpError(
        409,
        "douyin_login_session_not_ready",
        "context is starting"
      );
    }
  },
  createRfb() { return retryRfb; },
  setTimer: ((callback: () => void) => {
    cancelledRetryCallbacks.push(callback);
    return 41 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: ((handle: ReturnType<typeof setTimeout>) => {
    clearedRetryHandles.push(handle);
  }) as typeof clearTimeout
});
await Promise.resolve();
assert.equal(cancelledRetryCallbacks.length, 1);
unmountCancelledRetry();
assert.deepEqual(clearedRetryHandles, [41],
  "unmount must clear the pending not-ready retry timer");
cancelledRetryCallbacks[0]?.();
await Promise.resolve();
assert.equal(cancelledRetryAttempts, 1,
  "a cleared retry callback must not update or request after unmount");

const expiredDocument = parseHTML("<main id='expired-host'></main>").document;
const expiredHost = expiredDocument.querySelector<HTMLElement>("#expired-host")!;
let expiredRetrySchedules = 0;
const unmountExpired = await mountDouyinLiveLoginPage(expiredHost, {
  sessionId: "login-expired",
  pageOrigin: "https://trial.shensi.example",
  api: {
    async createLiveLoginSession() {
      throw new AcquisitionHttpError(
        410,
        "douyin_login_session_expired",
        "login expired"
      );
    }
  },
  createRfb() { return retryRfb; },
  setTimer: ((callback: () => void) => {
    expiredRetrySchedules += 1;
    return callback as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
assert.match(expiredHost.textContent ?? "", /连接失败/u,
  "an expired login session must expose a terminal connection failure");
assert.equal(expiredRetrySchedules, 0,
  "an expired login session must not retry forever");
unmountExpired();

console.log(JSON.stringify({ ok: true, suite: "douyin-live-login" }));
