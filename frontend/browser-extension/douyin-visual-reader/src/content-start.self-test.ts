import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { BRIDGE_VERSION, type ExtensionEvent } from "./protocol";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (value: unknown) => void
) => unknown;

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for content lifecycle state");
    await new Promise<void>((resolve) => originalSetTimeout(resolve, 5));
  }
}

function contentDocument(seed: number): Document {
  const { document } = parseHTML(`<!doctype html><html><body>
    <main role="region" aria-label="当前视频">
      <section role="feed" aria-label="评论">
        <article role="article" id="comment-${seed}" data-seed="${seed}">
          <p aria-label="评论内容">comment ${seed}</p>
        </article>
      </section>
    </main>
  </body></html>`);
  for (const element of Array.from(document.querySelectorAll("*"))) {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 10, width: 200, height: 80 })
    });
  }
  const feed = document.querySelector('[role="feed"]');
  const card = document.querySelector('[role="article"]');
  const body = document.querySelector('[aria-label="评论内容"]');
  assert.ok(feed && card && body);
  let scroll = 0;
  Object.defineProperty(feed, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(feed, "scrollBy", {
    configurable: true,
    value: () => {
      scroll += 1;
      card.id = `comment-${seed + scroll}`;
      body.textContent = `comment ${seed + scroll}`;
    }
  });
  return document;
}

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalAddEventListener = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
const originalInnerWidth = Object.getOwnPropertyDescriptor(globalThis, "innerWidth");
const originalInnerHeight = Object.getOwnPropertyDescriptor(globalThis, "innerHeight");
const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
const originalSetTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
const originalDateNow = Date.now;
let clock = 0;
let listener: RuntimeListener | null = null;
const attempts: ExtensionEvent[] = [];
let sourceUrl = "https://www.douyin.com/video/123";
let advanceClockDuringSourceSetup = true;
let sourceSetupReads = 0;
let activeDocument: Document | { querySelectorAll(): never[] } = { querySelectorAll: () => [] };
const contentTimers = new Set<ReturnType<typeof setTimeout>>();
type DeferredAttempt = {
  mode: "resolve" | "reject" | "timeout";
  count: number;
  resolve: ((value: { accepted: boolean }) => void) | null;
  reject: ((error: Error) => void) | null;
};
const deferredAttempts = new Map<string, DeferredAttempt>();
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };

try {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        onMessage: {
          addListener(value: RuntimeListener) { listener = value; }
        },
        async sendMessage(message: { kind?: unknown; event?: ExtensionEvent }) {
          if (message.kind === "douyin_reader_event" && message.event) {
            attempts.push(structuredClone(message.event));
            const deferred = deferredAttempts.get(message.event.channelNonce);
            if (deferred) {
              deferred.count += 1;
              if (deferred.count === 1) {
                if (deferred.mode === "timeout") return new Promise(() => undefined);
                return new Promise<{ accepted: boolean }>((resolve, reject) => {
                  deferred.resolve = resolve;
                  deferred.reject = reject;
                });
              }
            }
          }
          return { accepted: true };
        }
      }
    }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    get: () => activeDocument
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      get href() {
        sourceSetupReads += 1;
        if (advanceClockDuringSourceSetup) clock = 1;
        return sourceUrl;
      }
    }
  });
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: () => undefined
  });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1_440 });
  Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2 });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      let handle: ReturnType<typeof setTimeout>;
      handle = originalSetTimeout(() => {
        contentTimers.delete(handle);
        callback(...args);
      }, delay);
      contentTimers.add(handle);
      return handle;
    }
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (handle: ReturnType<typeof setTimeout>) => {
      contentTimers.delete(handle);
      originalClearTimeout(handle);
    }
  });
  process.on("unhandledRejection", onUnhandledRejection);
  Date.now = () => clock;

  await import("./douyin-content");
  assert.ok(listener, "content script installs its runtime start listener");

  let response: unknown = null;
  const invoke = listener as RuntimeListener;
  invoke({
    kind: "visual_reader_start",
    sessionId: "minimum-duration-content-start",
    limits: {
      maxVideos: 1,
      maxCommentsPerVideo: 30,
      maxScrolls: 5,
      maxOcrCalls: 0,
      maxDurationMs: 1
    },
    artifactUploadEnabled: false,
    channelNonce: "0".repeat(64)
  }, null, (value) => { response = value; });

  assert.deepEqual(response, { accepted: true });
  await flush();
  assert.equal(sourceSetupReads, 0,
    "an empty work window queues terminal before source setup can consume the session");
  assert.equal(attempts.length, 1,
    "a legal minimum-duration start initiates its budget terminal before setup consumes the session");
  assert.deepEqual(attempts[0], {
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "0".repeat(64),
    sessionId: "minimum-duration-content-start",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });

  attempts.length = 0;
  clock = 0;
  sourceUrl = "https://www.douyin.com/not-a-video";
  advanceClockDuringSourceSetup = false;
  response = null;
  invoke({
    kind: "visual_reader_start",
    sessionId: "invalid-source-fallback",
    limits: {
      maxVideos: 1,
      maxCommentsPerVideo: 30,
      maxScrolls: 5,
      maxOcrCalls: 0,
      maxDurationMs: 100
    },
    artifactUploadEnabled: false,
    channelNonce: "1".repeat(64)
  }, null, (value) => { response = value; });

  assert.deepEqual(response, { accepted: true });
  await flush();
  assert.deepEqual(attempts, [{
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "1".repeat(64),
    sessionId: "invalid-source-fallback",
    status: "partial_success",
    errorCodes: ["visual_source_invalid"]
  }], "a setup failure emits one fallback terminal");
  await flush();
  assert.equal(attempts.length, 1, "fallback settlement cannot duplicate its terminal");

  attempts.length = 0;
  clock = 0;
  sourceUrl = "https://www.douyin.com/video/501";
  activeDocument = contentDocument(501);
  const replacementLimits = {
    maxVideos: 1,
    maxCommentsPerVideo: 3,
    maxScrolls: 5,
    maxOcrCalls: 0,
    maxDurationMs: 1_500
  };
  const replacementSessionId = "same-session-ack-owner";
  const oldOwnerNonce = "8".repeat(64);
  const newOwnerNonce = "9".repeat(64);
  response = null;
  invoke({
    kind: "visual_reader_start",
    sessionId: replacementSessionId,
    limits: replacementLimits,
    artifactUploadEnabled: false,
    channelNonce: oldOwnerNonce
  }, null, (value) => { response = value; });
  assert.deepEqual(response, { accepted: true });
  await waitFor(() => attempts.some((event) => event.type === "observation_batch"
    && event.channelNonce === oldOwnerNonce && event.batchId === "batch-1"));

  sourceUrl = "https://www.douyin.com/video/502";
  activeDocument = contentDocument(502);
  response = null;
  invoke({
    kind: "visual_reader_start",
    sessionId: replacementSessionId,
    limits: replacementLimits,
    artifactUploadEnabled: false,
    channelNonce: newOwnerNonce
  }, null, (value) => { response = value; });
  assert.deepEqual(response, { accepted: true });
  await waitFor(() => attempts.some((event) => event.type === "observation_batch"
    && event.channelNonce === newOwnerNonce && event.batchId === "batch-1"));

  response = null;
  invoke({
    kind: "visual_reader_ack",
    channelNonce: oldOwnerNonce,
    sessionId: replacementSessionId,
    batchId: "batch-1"
  }, null, (value) => { response = value; });
  assert.deepEqual(response, { accepted: false },
    "a delayed ACK from an old same-session lifecycle is rejected explicitly");

  response = null;
  invoke({
    kind: "visual_reader_ack",
    channelNonce: newOwnerNonce,
    sessionId: replacementSessionId,
    batchId: "batch-1"
  }, null, (value) => { response = value; });
  await waitFor(() => response !== null);
  assert.deepEqual(response, { accepted: true },
    "rejecting the old owner keeps the replacement batch pending for its current ACK");
  response = null;
  invoke({
    kind: "visual_reader_abort",
    sessionId: replacementSessionId
  }, null, (value) => { response = value; });
  assert.deepEqual(response, { accepted: true });
  await waitFor(() => attempts.some((event) => event.type === "terminal"
    && event.channelNonce === newOwnerNonce && event.status === "aborted"));

  async function verifyStaleFallbackCannotOwnRestart(input: {
    oldSessionId: string;
    newSessionId: string;
    oldNonce: string;
    newNonce: string;
    mode: DeferredAttempt["mode"];
    seed: number;
  }): Promise<void> {
    attempts.length = 0;
    clock = 0;
    sourceUrl = "https://www.douyin.com/not-a-video";
    activeDocument = { querySelectorAll: () => [] };
    const deferred: DeferredAttempt = {
      mode: input.mode,
      count: 0,
      resolve: null,
      reject: null
    };
    deferredAttempts.set(input.oldNonce, deferred);

    let response: unknown = null;
    invoke({
      kind: "visual_reader_start",
      sessionId: input.oldSessionId,
      limits: {
        maxVideos: 1,
        maxCommentsPerVideo: 3,
        maxScrolls: 5,
        maxOcrCalls: 0,
        maxDurationMs: 1_500
      },
      artifactUploadEnabled: false,
      channelNonce: input.oldNonce
    }, null, (value) => { response = value; });
    assert.deepEqual(response, { accepted: true });
    await waitFor(() => deferred.count === 1);

    sourceUrl = `https://www.douyin.com/video/${input.seed}`;
    activeDocument = contentDocument(input.seed);
    response = null;
    invoke({
      kind: "visual_reader_start",
      sessionId: input.newSessionId,
      limits: {
        maxVideos: 1,
        maxCommentsPerVideo: 3,
        maxScrolls: 5,
        maxOcrCalls: 0,
        maxDurationMs: 1_500
      },
      artifactUploadEnabled: false,
      channelNonce: input.newNonce
    }, null, (value) => { response = value; });
    assert.deepEqual(response, { accepted: true });
    await waitFor(() => attempts.some((event) => event.type === "observation_batch"
      && event.channelNonce === input.newNonce && event.batchId === "batch-1"));

    response = null;
    invoke({
      kind: "visual_reader_ack",
      channelNonce: input.newNonce,
      sessionId: input.newSessionId,
      batchId: "batch-1"
    }, null, (value) => { response = value; });
    await waitFor(() => response !== null);
    assert.deepEqual(response, { accepted: true }, "the replacement reader owns ACK routing before stale cleanup");
    await waitFor(() => attempts.some((event) => event.type === "observation_batch"
      && event.channelNonce === input.newNonce && event.batchId === "batch-2"));

    if (input.mode === "resolve") deferred.resolve?.({ accepted: true });
    else if (input.mode === "reject") deferred.reject?.(new Error("stale fallback rejected"));
    await waitFor(() => input.mode === "resolve" ? deferred.count === 1 : deferred.count === 2, 1_300);
    await flush();

    response = null;
    invoke({
      kind: "visual_reader_ack",
      channelNonce: input.newNonce,
      sessionId: input.newSessionId,
      batchId: "batch-2"
    }, null, (value) => { response = value; });
    await flush();
    const replacementAck = response;
    if (replacementAck === null) {
      await new Promise<void>((resolve) => originalSetTimeout(resolve, 1_300));
    } else {
      response = null;
      invoke({
        kind: "visual_reader_abort",
        sessionId: input.newSessionId
      }, null, (value) => { response = value; });
      assert.deepEqual(response, { accepted: true }, "stale cleanup cannot remove replacement abort routing");
      await waitFor(() => attempts.some((event) => event.type === "terminal"
        && event.channelNonce === input.newNonce && event.status === "aborted"));
      await waitFor(() => contentTimers.size === 0);
    }
    assert.deepEqual(replacementAck, { accepted: true },
      "stale fallback settlement cannot remove the replacement reader's ACK routing");
    assert.equal(deferred.count, input.mode === "resolve" ? 1 : 2,
      "fallback completion is bounded to the expected exact terminal attempts");
    deferredAttempts.delete(input.oldNonce);
  }

  await verifyStaleFallbackCannotOwnRestart({
    oldSessionId: "stale-resolve",
    newSessionId: "replacement-after-resolve",
    oldNonce: "2".repeat(64),
    newNonce: "3".repeat(64),
    mode: "resolve",
    seed: 201
  });
  await verifyStaleFallbackCannotOwnRestart({
    oldSessionId: "same-session-restart",
    newSessionId: "same-session-restart",
    oldNonce: "4".repeat(64),
    newNonce: "5".repeat(64),
    mode: "reject",
    seed: 301
  });
  await verifyStaleFallbackCannotOwnRestart({
    oldSessionId: "stale-timeout",
    newSessionId: "replacement-after-timeout",
    oldNonce: "6".repeat(64),
    newNonce: "7".repeat(64),
    mode: "timeout",
    seed: 401
  });
  assert.deepEqual(unhandledRejections, [], "fallback ownership failures create no unhandled rejection");
  assert.equal(contentTimers.size, 0, "all current and stale lifecycle timers are cleared");
} finally {
  process.off("unhandledRejection", onUnhandledRejection);
  Date.now = originalDateNow;
  for (const [name, descriptor] of [
    ["chrome", originalChrome],
    ["document", originalDocument],
    ["location", originalLocation],
    ["addEventListener", originalAddEventListener],
    ["innerWidth", originalInnerWidth],
    ["innerHeight", originalInnerHeight],
    ["devicePixelRatio", originalDevicePixelRatio],
    ["setTimeout", originalSetTimeoutDescriptor],
    ["clearTimeout", originalClearTimeoutDescriptor]
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  Reflect.deleteProperty(globalThis, "__goodjobDouyinVisualReaderInstalledV1");
}

console.log("douyin content start self-test passed");
