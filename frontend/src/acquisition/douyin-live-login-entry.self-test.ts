import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { DouyinLoginSession } from "./douyin-automation-api";
import {
  mountRoutedDouyinLiveLogin,
  type DouyinRfbFactory
} from "./douyin-live-login-entry";

const expiresAt = new Date(Date.now() + 60_000).toISOString();
const session = (
  interactionSurface: "external_window" | "remote_canvas"
): DouyinLoginSession => ({
  id: "login-route-1",
  platform: "douyin",
  state: "awaiting_scan",
  interactionSurface,
  runtimeState: "running",
  authState: "waiting_for_user",
  taskState: "idle",
  diagnostic: null,
  screenshotAvailable: false,
  qrAvailable: false,
  qrImageDataUrl: null,
  qrStatus: null,
  loginPage: null,
  failureCode: null,
  expiresAt,
  account: null
});

const externalDocument = parseHTML("<main id='external'></main>").document;
const externalHost = externalDocument.querySelector<HTMLElement>("#external")!;
let externalLiveRequests = 0;
let externalRfbLoads = 0;
const unmountExternal = await mountRoutedDouyinLiveLogin(externalHost, {
  sessionId: "login-route-1",
  pageOrigin: "https://trial.shensi.example",
  api: {
    getLoginSession: async () => session("external_window"),
    createLiveLoginSession: async () => {
      externalLiveRequests += 1;
      throw new Error("external sessions must not request live login");
    }
  },
  loadRfbFactory: async () => {
    externalRfbLoads += 1;
    throw new Error("external sessions must not load noVNC");
  }
});
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(externalLiveRequests, 0,
  "a bookmarked external-window route must not call /live-sessions");
assert.equal(externalRfbLoads, 0,
  "a bookmarked external-window route must not load noVNC");
assert.match(externalHost.textContent ?? "", /外部浏览器/u);
unmountExternal();

const remoteDocument = parseHTML("<main id='remote'></main>").document;
const remoteHost = remoteDocument.querySelector<HTMLElement>("#remote")!;
let remoteLiveRequests = 0;
let remoteRfbLoads = 0;
const fakeRfb = {
  viewOnly: true,
  scaleViewport: false,
  resizeSession: false,
  focusOnClick: false,
  addEventListener() { /* test fixture */ },
  removeEventListener() { /* test fixture */ },
  disconnect() { /* test fixture */ }
};
const remoteFactory: DouyinRfbFactory = () => fakeRfb;
const unmountRemote = await mountRoutedDouyinLiveLogin(remoteHost, {
  sessionId: "login-route-1",
  pageOrigin: "https://trial.shensi.example",
  api: {
    getLoginSession: async () => session("remote_canvas"),
    createLiveLoginSession: async () => {
      remoteLiveRequests += 1;
      return {
        socketPath: "/douyin-live/token",
        expiresAt
      };
    }
  },
  loadRfbFactory: async () => {
    remoteRfbLoads += 1;
    return remoteFactory;
  }
});
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(remoteRfbLoads, 1,
  "remote canvas retains the lazy noVNC runtime");
assert.equal(remoteLiveRequests, 1,
  "remote canvas retains the live-session request");
unmountRemote();
