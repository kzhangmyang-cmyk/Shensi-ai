import { strict as assert } from "node:assert";
import { BRIDGE_VERSION } from "./protocol";

type Listener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown;

let listener: Listener | null = null;
let releaseSelectedTab: ((value: unknown) => void) | null = null;
let deferSelectedTab = false;
let deferGoodJobEvent = false;
let releaseGoodJobEvent: ((value: unknown) => void) | null = null;
let deferReaderAck = false;
let releaseReaderAck: ((value: unknown) => void) | null = null;
let deferredReaderAckMessage: unknown = null;
let deferReaderStart = false;
let releaseReaderStart: ((value: unknown) => void) | null = null;
let selectedTabReads = 0;
let windowFocusUpdates = 0;
let tabActivationUpdates = 0;
let scriptExecutions = 0;
const stored: { visualReaderSession?: unknown } = {};
const passiveListener = { addListener() { return undefined; } };

(globalThis as typeof globalThis & { chrome: unknown }).chrome = {
  runtime: {
    onMessage: { addListener(value: Listener) { listener = value; } },
    sendMessage: async () => ({ accepted: true }),
    getManifest: () => ({ version: "1.0.0" })
  },
  offscreen: {
    hasDocument: async () => false,
    closeDocument: async () => undefined,
    createDocument: async () => undefined
  },
  storage: {
    session: {
      async get() { return { ...stored }; },
      async set(value: { visualReaderSession?: unknown }) {
        stored.visualReaderSession = structuredClone(value.visualReaderSession);
      },
      async remove() { delete stored.visualReaderSession; }
    }
  },
  tabs: {
    async get(tabId: number) {
      selectedTabReads += 1;
      if (deferSelectedTab) {
        deferSelectedTab = false;
        return new Promise((resolve) => { releaseSelectedTab = resolve; });
      }
      return {
        id: tabId,
        windowId: 7,
        url: "https://www.douyin.com/video/123",
        active: true
      };
    },
    async update() {
      tabActivationUpdates += 1;
      return undefined;
    },
    async query() { return []; },
    async sendMessage(_tabId: number, message: unknown) {
      const kind = message && typeof message === "object" && !Array.isArray(message)
        ? (message as { kind?: unknown }).kind : null;
      if (kind === "goodjob_extension_event" && deferGoodJobEvent) {
        deferGoodJobEvent = false;
        return new Promise((resolve) => { releaseGoodJobEvent = resolve; });
      }
      if (kind === "visual_reader_ack" && deferReaderAck) {
        deferReaderAck = false;
        deferredReaderAckMessage = structuredClone(message);
        return new Promise((resolve) => { releaseReaderAck = resolve; });
      }
      if (kind === "visual_reader_start" && deferReaderStart) {
        deferReaderStart = false;
        return new Promise((resolve) => { releaseReaderStart = resolve; });
      }
      return { accepted: true };
    },
    captureVisibleTab: async () => "data:image/png;base64,unused",
    onActivated: passiveListener,
    onUpdated: passiveListener,
    onReplaced: passiveListener,
    onRemoved: passiveListener
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async getLastFocused() { return { id: 7 }; },
    async update() {
      windowFocusUpdates += 1;
      return undefined;
    },
    onFocusChanged: passiveListener
  },
  scripting: {
    async executeScript() {
      scriptExecutions += 1;
      return [];
    }
  }
};

await import("./service-worker");

const originalDateNow = Date.now;
let currentTime = originalDateNow();
Date.now = () => currentTime;

function dispatch(message: unknown, sender: unknown = {}): Promise<unknown> {
  const active = listener;
  if (!active) throw new Error("service worker listener was not installed");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("service worker response timeout")), 2_000);
    active(message, sender, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

const limits = {
  maxVideos: 1,
  maxCommentsPerVideo: 10,
  maxScrolls: 1,
  maxOcrCalls: 1,
  maxDurationMs: 60_000
};
const origin = "http://127.0.0.1:5191";
const start = (sessionId: string, nonce: string, artifactUploadEnabled = true) => dispatch({
  kind: "goodjob_page_command",
  origin,
  command: {
    version: BRIDGE_VERSION,
    type: "start",
    channelNonce: nonce,
    sessionId,
    limits,
    artifactUploadEnabled
  }
}, { tab: { id: 10 }, origin });

type PopupSnapshot = {
  confirmationToken: string | null;
  session: {
    sessionId: string;
    artifactUploadEnabled: boolean;
    status: string;
    usage: { observationCount: number };
  } | null;
};

async function popupSnapshot(): Promise<PopupSnapshot> {
  return await dispatch({ kind: "popup_snapshot" }) as PopupSnapshot;
}

async function popupConfirm(confirmationToken: string): Promise<unknown> {
  return dispatch({
    kind: "popup_confirm",
    confirmationToken,
    tab: { id: 20, windowId: 7, url: "https://www.douyin.com/video/123" }
  });
}

function requireToken(snapshot: PopupSnapshot): string {
  if (typeof snapshot.confirmationToken !== "string") throw new Error("missing popup confirmation token");
  assert.match(snapshot.confirmationToken, /^[0-9a-f]{48}$/u,
    "popup confirmation is an opaque random-looking token rather than embedded session state");
  return snapshot.confirmationToken;
}

assert.deepEqual(await start("old-session", "a".repeat(64)), { accepted: true });
const oldToken = requireToken(await popupSnapshot());
deferSelectedTab = true;
const oldConfirmation = popupConfirm(oldToken);
while (!releaseSelectedTab) await Promise.resolve();

assert.deepEqual(await start("replacement-session", "b".repeat(64)), { accepted: true });
const release = releaseSelectedTab as ((value: unknown) => void) | null;
if (!release) throw new Error("missing deferred selected-tab resolver");
release({ id: 20, windowId: 7, url: "https://www.douyin.com/video/123", active: true });
assert.deepEqual(await oldConfirmation, { accepted: false },
  "a popup confirmation pending in tabs.get cannot bind the replacement coordinator");

const snapshot = await popupSnapshot();
assert.equal(snapshot.session?.sessionId, "replacement-session");
assert.equal(snapshot.session?.status, "authorized",
  "the replacement remains unbound after a stale popup confirmation settles");
assert.deepEqual(await popupConfirm(oldToken), { accepted: false },
  "an old popup click after a different-session replacement cannot bind the current coordinator");

const sameSessionToken = requireToken(snapshot);
assert.deepEqual(await start("replacement-session", "c".repeat(64)), { accepted: true });
assert.deepEqual(await popupConfirm(sameSessionToken), { accepted: false },
  "a same-session replacement invalidates the old popup token even when artifact mode is unchanged");
const sameSessionSnapshot = await popupSnapshot();
assert.equal(sameSessionSnapshot.session?.sessionId, "replacement-session");
assert.equal(sameSessionSnapshot.session?.artifactUploadEnabled, true);

const artifactModeToken = requireToken(sameSessionSnapshot);
assert.deepEqual(await start("replacement-session", "7".repeat(64), false), { accepted: true });
assert.deepEqual(await popupConfirm(artifactModeToken), { accepted: false },
  "a replacement that flips artifact mode invalidates the old popup token");
const textOnlySnapshot = await popupSnapshot();
assert.equal(textOnlySnapshot.session?.sessionId, "replacement-session");
assert.equal(textOnlySnapshot.session?.artifactUploadEnabled, false);
assert.equal(textOnlySnapshot.session?.status, "authorized");

releaseSelectedTab = null;
deferSelectedTab = true;
const abortedConfirmation = popupConfirm(requireToken(textOnlySnapshot));
while (!releaseSelectedTab) await Promise.resolve();
assert.deepEqual(await dispatch({ kind: "popup_abort" }), { accepted: true });
const releaseAborted = releaseSelectedTab as ((value: unknown) => void) | null;
if (!releaseAborted) throw new Error("missing aborted selected-tab resolver");
releaseAborted({ id: 20, windowId: 7, url: "https://www.douyin.com/video/123", active: true });
assert.deepEqual(await abortedConfirmation, { accepted: false },
  "popup abort synchronously invalidates a confirmation pending in tabs.get");

assert.deepEqual(await start("expiry-session", "9".repeat(64)), { accepted: true });
const expiringToken = requireToken(await popupSnapshot());
assert.deepEqual(await dispatch({
  kind: "popup_confirm",
  confirmationToken: expiringToken,
  tab: { id: 20, windowId: 7, url: "https://www.douyin.com/video/123" },
  unexpected: true
}), { accepted: false }, "popup confirmation is a closed message");
const sideEffectsBeforeExpiry = {
  selectedTabReads,
  windowFocusUpdates,
  tabActivationUpdates,
  scriptExecutions
};
currentTime += 30_000;
assert.deepEqual(await popupConfirm(expiringToken), { accepted: false },
  "a popup confirmation token expires before any tab or window side effect can run");
assert.deepEqual({ selectedTabReads, windowFocusUpdates, tabActivationUpdates, scriptExecutions },
  sideEffectsBeforeExpiry, "an expired token is rejected before all browser side effects");
assert.equal((await popupSnapshot()).session?.status, "authorized");
assert.deepEqual(await dispatch({ kind: "popup_abort" }), { accepted: true });

assert.deepEqual(await start("expiry-during-start", "8".repeat(64)), { accepted: true });
deferReaderStart = true;
const expiringStart = popupConfirm(requireToken(await popupSnapshot()));
while (!releaseReaderStart) await Promise.resolve();
currentTime += 30_001;
const releaseExpiredStart = releaseReaderStart as ((value: unknown) => void) | null;
if (!releaseExpiredStart) throw new Error("missing deferred reader start resolver");
releaseExpiredStart({ accepted: true });
assert.deepEqual(await expiringStart, { accepted: false });
assert.equal((await popupSnapshot()).session, null,
  "a token expiring while content start is pending aborts the half-started session");

const observation = (key: string) => ({
  clientObservationKey: key,
  sourceUrl: "https://www.douyin.com/video/123",
  videoId: "123",
  visibleText: "当前可见采购需求",
  domTextHash: `sha256:${"0".repeat(64)}`,
  ocrTextHash: null,
  displayName: null,
  visibleTimeText: null,
  likeCount: null,
  replyCount: null,
  platformCommentId: null,
  publicProfileUrl: null,
  secUid: null,
  extractionMethod: "dom",
  fieldConfidences: { visibleText: 0.99 },
  viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 600, y: 200, width: 400, height: 180 },
  readerVersion: "goodjob-visual-reader/1.0.0",
  capturedAt: "2026-08-16T00:00:00.000Z",
  redactedCrop: null
});

const readerBatch = (sessionId: string, nonce: string, batchId: string, key: string) => dispatch({
  kind: "douyin_reader_event",
  event: {
    version: BRIDGE_VERSION,
    type: "observation_batch",
    channelNonce: nonce,
    sessionId,
    batchId,
    observations: [observation(key)]
  }
}, { tab: { id: 20 } });

assert.deepEqual(await start("batch-old", "d".repeat(64)), { accepted: true });
assert.deepEqual(await popupConfirm(requireToken(await popupSnapshot())), { accepted: true });
deferGoodJobEvent = true;
const oldBatch = readerBatch("batch-old", "d".repeat(64), "old-batch", "dom:old");
while (!releaseGoodJobEvent) await Promise.resolve();

assert.deepEqual(await start("batch-new", "e".repeat(64)), { accepted: true });
assert.deepEqual(await popupConfirm(requireToken(await popupSnapshot())), { accepted: true });
const releaseOldBatch = releaseGoodJobEvent as ((value: unknown) => void) | null;
if (!releaseOldBatch) throw new Error("missing deferred GoodJob event resolver");
releaseOldBatch({ accepted: true });
assert.deepEqual(await oldBatch, { accepted: false },
  "a forwarded batch cannot report success after its coordinator is replaced");
const afterOldBatch = await popupSnapshot();
assert.equal(afterOldBatch.session?.usage.observationCount, 0,
  "an old forwarded batch cannot increment replacement usage");

assert.deepEqual(await readerBatch("batch-new", "e".repeat(64), "shared-batch", "dom:new-1"),
  { accepted: true });
deferReaderAck = true;
const oldAck = dispatch({
  kind: "goodjob_page_command",
  origin,
  command: {
    version: BRIDGE_VERSION,
    type: "acknowledge_batch",
    channelNonce: "e".repeat(64),
    sessionId: "batch-new",
    batchId: "shared-batch"
  }
}, { tab: { id: 10 }, origin });
while (!releaseReaderAck) await Promise.resolve();
assert.deepEqual(deferredReaderAckMessage, {
  kind: "visual_reader_ack",
  channelNonce: "e".repeat(64),
  sessionId: "batch-new",
  batchId: "shared-batch"
}, "service worker binds ACK delivery to the captured lifecycle owner");

assert.deepEqual(await start("batch-new", "f".repeat(64), false), { accepted: true });
assert.deepEqual(await popupConfirm(requireToken(await popupSnapshot())), { accepted: true });
assert.deepEqual(await readerBatch("batch-new", "f".repeat(64), "shared-batch", "dom:new-2"),
  { accepted: true });
const releaseOldAck = releaseReaderAck as ((value: unknown) => void) | null;
if (!releaseOldAck) throw new Error("missing deferred reader ACK resolver");
releaseOldAck({ accepted: true });
assert.deepEqual(await oldAck, { accepted: false },
  "a late ACK cannot commit against a same-session replacement coordinator");
assert.deepEqual(await readerBatch("batch-new", "f".repeat(64), "other-batch", "dom:new-3"),
  { accepted: false }, "the replacement pending batch remains owned after an old ACK resolves");

delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
Date.now = originalDateNow;

console.log("service-worker popup confirmation self-test passed");
