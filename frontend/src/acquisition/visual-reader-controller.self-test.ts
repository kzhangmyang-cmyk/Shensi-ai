import { strict as assert } from "node:assert";
import type {
  VisualObservationBatchResponse,
  VisualObservationSubmission,
  VisualReaderApi,
  VisualReaderSession,
  VisualReaderStableErrorCode
} from "./visual-reader-api";
import type {
  VisualReaderBridge,
  VisualReaderBridgeHandlers,
  VisualReaderExtensionEvent
} from "./visual-reader-bridge";
import {
  createVisualReaderController,
  defaultVisualReaderKey,
  type AuthorizedVisualReaderProjection
} from "./visual-reader-controller";

const timestamp = "2026-08-15T08:00:00.000Z";

function session(overrides: Partial<VisualReaderSession> = {}): VisualReaderSession {
  return {
    sessionId: "visual-session-1",
    runId: "run-1",
    planId: "plan-1",
    planVersionId: "plan-version-1",
    platform: "douyin",
    coverage: "authorized_visible_top_level_sample",
    status: "collecting",
    artifactUploadEnabled: true,
    limits: {
      maxVideos: 10,
      maxCommentsPerVideo: 30,
      maxScrolls: 5,
      maxOcrCalls: 10,
      maxDurationMs: 120_000
    },
    usage: {
      videoCount: 1,
      observationCount: 1,
      scrollCount: 1,
      ocrCallCount: 0,
      domObservationCount: 1,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0
    },
    outcome: null,
    lastErrorCode: null,
    createdAt: timestamp,
    authorizedAt: timestamp,
    updatedAt: timestamp,
    expiresAt: "2026-08-15T08:02:00.000Z",
    completedAt: null,
    ...overrides
  };
}

function terminalSession(
  status: "completed" | "partial_success" | "aborted"
): VisualReaderSession {
  return session({
    status,
    completedAt: "2026-08-15T08:01:00.000Z",
    outcome: {
      status,
      videoCount: 1,
      observationCount: 1,
      domObservationCount: 1,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0,
      errorCodes: status === "partial_success"
        ? ["visual_extraction_low_confidence"]
        : []
    }
  });
}

function observation(
  key = "client-observation-1",
  overrides: Partial<VisualObservationSubmission> = {}
): VisualObservationSubmission {
  return {
    clientObservationKey: key,
    sourceUrl: "https://www.douyin.com/video/123456789",
    videoId: "123456789",
    visibleText: "想了解企业获客方案",
    domTextHash: `sha256:${"1".repeat(64)}`,
    ocrTextHash: null,
    displayName: "林经理",
    visibleTimeText: "1小时前",
    likeCount: 2,
    replyCount: 0,
    platformCommentId: "987654321",
    publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
    secUid: "MS4wLjABAAAA",
    extractionMethod: "dom",
    fieldConfidences: { visibleText: 0.99 },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    cardBounds: { x: 720, y: 220, width: 520, height: 140 },
    readerVersion: "goodjob-visual-reader/1.0.0",
    capturedAt: timestamp,
    redactedCrop: null,
    ...overrides
  };
}

function crop() {
  return {
    mediaType: "image/webp" as const,
    contentBase64: "AAAA",
    redactionProof: {
      version: "opaque-rect-v1" as const,
      maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
      avatarBounds: { x: 0, y: 0, width: 20, height: 20 },
      visibleRegions: [{ x: 24, y: 0, width: 200, height: 60 }],
      maskedRegions: [{ x: 0, y: 0, width: 20, height: 20 }]
    }
  };
}

function projection(sessionId = "visual-session-1"): AuthorizedVisualReaderProjection {
  return {
    sessionId,
    coverage: "authorized_visible_top_level_sample",
    status: "collecting",
    usage: session().usage,
    lastErrorCode: null,
    visualSteps: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class FakeBridge implements VisualReaderBridge {
  readonly channelNonce = "a".repeat(64);
  handlers: VisualReaderBridgeHandlers | null = null;
  readonly starts: Array<{
    sessionId: string;
    limits: VisualReaderSession["limits"];
    artifactUploadEnabled: boolean;
  }> = [];
  readonly acknowledgements: Array<{ sessionId: string; batchId: string }> = [];
  readonly aborts: string[] = [];
  destroyed = false;

  connect(handlers: VisualReaderBridgeHandlers): void {
    this.handlers = handlers;
    handlers.onAvailability("probing");
  }

  ready(): void {
    this.handlers?.onAvailability("ready");
    this.emit({
      version: "goodjob.visual-reader.bridge.v1",
      type: "ready",
      channelNonce: this.channelNonce,
      extensionVersion: "1.0.0"
    });
  }

  unavailable(): void {
    this.handlers?.onAvailability("unavailable");
  }

  emit(event: VisualReaderExtensionEvent): void {
    this.handlers?.onEvent(event);
  }

  startSession(
    sessionId: string,
    limits: VisualReaderSession["limits"],
    artifactUploadEnabled: boolean
  ): void {
    this.starts.push({ sessionId, limits, artifactUploadEnabled });
  }

  acknowledgeBatch(sessionId: string, batchId: string): void {
    this.acknowledgements.push({ sessionId, batchId });
  }

  abortSession(sessionId: string): void {
    this.aborts.push(sessionId);
  }

  destroy(): void {
    this.destroyed = true;
    this.handlers = null;
  }
}

class OrderedBridge extends FakeBridge {
  constructor(private readonly order: string[]) {
    super();
  }

  override acknowledgeBatch(sessionId: string, batchId: string): void {
    this.order.push("ACK");
    super.acknowledgeBatch(sessionId, batchId);
  }
}

function batchEvent(
  observations: VisualObservationSubmission[],
  batchId = "batch-1"
): VisualReaderExtensionEvent {
  return {
    version: "goodjob.visual-reader.bridge.v1",
    type: "observation_batch",
    channelNonce: "a".repeat(64),
    sessionId: "visual-session-1",
    batchId,
    observations
  };
}

{
  const bridge = new FakeBridge();
  let sessionReads = 0;
  const api = {
    async getSession() {
      sessionReads += 1;
      return session();
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "key-1"
  });

  await controller.open({ planId: "plan-1", runId: "run-1", projection: undefined });
  assert.equal(sessionReads, 0, "legacy presentations without the optional field stay compatible");
  assert.equal(controller.getState().extensionStatus, "probing");
  bridge.unavailable();
  assert.equal(controller.getState().extensionStatus, "unavailable");
  assert.match(controller.getState().message ?? "", /未检测到/u);
  controller.close();
  assert.equal(bridge.destroyed, true);
}

{
  const bridge = new FakeBridge();
  const api = {
    async getSession() {
      return session();
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "key-1"
  });

  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  assert.equal(controller.getState().session?.sessionId, "visual-session-1");
  assert.equal(bridge.starts.length, 0, "a recovered session waits for an authenticated ready event");
  bridge.ready();
  assert.equal(bridge.starts[0]?.sessionId, "visual-session-1");
  assert.deepEqual(bridge.starts[0]?.limits, session().limits);
  assert.equal(bridge.starts[0]?.artifactUploadEnabled, true);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const created = session({ status: "created", usage: { ...session().usage, observationCount: 0 } });
  const api = {
    async createSession(input: unknown, key: string) {
      assert.deepEqual(input, { runId: "run-1", artifactUploadEnabled: true });
      assert.equal(key, "authorize-key");
      return created;
    },
    async getSession() {
      return created;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "authorize-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1" });
  await assert.rejects(() => controller.authorize(), /浏览器读取器/u);
  bridge.ready();
  await controller.authorize();
  assert.equal(controller.getState().session?.sessionId, "visual-session-1");
  assert.equal(bridge.starts.at(-1)?.sessionId, "visual-session-1");
  assert.equal(bridge.starts.at(-1)?.artifactUploadEnabled, true);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const append = deferred<VisualObservationBatchResponse>();
  const batchKeys: string[] = [];
  const refreshes: string[] = [];
  let attempts = 0;
  const api = {
    async getSession() {
      return session();
    },
    appendObservationBatch(_sessionId: string, _input: unknown, key: string) {
      attempts += 1;
      batchKeys.push(key);
      if (attempts === 1) return append.promise;
      return Promise.resolve({ session: session(), accepted: [], duplicates: [] });
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "stable-batch-key",
    onRequestPresentationRefresh: () => refreshes.push("refresh")
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit(batchEvent([observation()]));
  assert.equal(bridge.acknowledgements.length, 0, "the client queue is not cleared before persistence");
  assert.doesNotMatch(controller.getState().message ?? "", /已保存/u);
  append.reject(new TypeError("network unavailable"));
  await assert.rejects(() => controller.whenIdle(), /network unavailable/);
  assert.equal(bridge.acknowledgements.length, 0, "API failure never acknowledges the batch");
  assert.match(controller.getState().error ?? "", /网络|network/u);

  bridge.emit(batchEvent([observation()]));
  await controller.whenIdle();
  assert.deepEqual(batchKeys, ["stable-batch-key", "stable-batch-key"]);
  assert.deepEqual(bridge.acknowledgements, [{
    sessionId: "visual-session-1",
    batchId: "batch-1"
  }]);
  assert.match(controller.getState().message ?? "", /已保存/u);
  assert.deepEqual(refreshes, ["refresh"]);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const submitted: VisualObservationSubmission[][] = [];
  const api = {
    async getSession() {
      return session({ artifactUploadEnabled: false });
    },
    async appendObservationBatch(
      _sessionId: string,
      input: { observations: VisualObservationSubmission[] }
    ) {
      submitted.push(input.observations);
      return { session: session({ artifactUploadEnabled: false }), accepted: [], duplicates: [] };
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "batch-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  assert.equal(bridge.starts[0]?.artifactUploadEnabled, false);
  bridge.emit(batchEvent([observation("crop-observation", { redactedCrop: crop() })]));
  await controller.whenIdle();
  assert.equal(submitted[0]?.[0]?.redactedCrop, null, "artifact-off mode strips every crop before API submission");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  let appendCalls = 0;
  const api = {
    async getSession() {
      return session();
    },
    async appendObservationBatch() {
      appendCalls += 1;
      return { session: session(), accepted: [], duplicates: [] };
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({ api, bridgeFactory: () => bridge });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit(batchEvent(Array.from({ length: 21 }, (_, index) => observation(`client-${index}`))));
  await controller.whenIdle();
  assert.equal(appendCalls, 0, "controller rechecks limits even when a bridge implementation is faulty");
  assert.match(controller.getState().error ?? "", /超过/u);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const complete = deferred<VisualReaderSession>();
  const refreshes: string[] = [];
  const api = {
    async getSession() {
      return session();
    },
    completeSession() {
      return complete.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "complete-key",
    onRequestPresentationRefresh: () => refreshes.push("refresh")
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit({
    version: "goodjob.visual-reader.bridge.v1",
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "completed",
    errorCodes: []
  });
  assert.equal(controller.getState().session?.status, "collecting", "extension terminal is not a success fact");
  complete.resolve(terminalSession("completed"));
  await controller.whenIdle();
  assert.equal(controller.getState().session?.status, "completed");
  assert.deepEqual(refreshes, ["refresh"]);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const completeCalls: Array<{ status: string; errorCodes: string[] }> = [];
  let abortCalls = 0;
  const api = {
    async getSession() {
      return session();
    },
    async completeSession(
      _sessionId: string,
      input: { status: "completed" | "partial_success"; errorCodes: VisualReaderStableErrorCode[] }
    ) {
      completeCalls.push({ status: input.status, errorCodes: [...input.errorCodes] });
      return session({
        status: "partial_success",
        completedAt: "2026-08-15T08:01:00.000Z",
        lastErrorCode: "visual_reader_session_expired",
        outcome: {
          status: "partial_success",
          videoCount: 1,
          observationCount: 1,
          domObservationCount: 1,
          accessibilityObservationCount: 0,
          ocrObservationCount: 0,
          lowConfidenceObservationCount: 0,
          artifactCount: 0,
          errorCodes: ["visual_reader_session_expired"]
        }
      });
    },
    async abortSession() {
      abortCalls += 1;
      return terminalSession("aborted");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "restart-expiry-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit({
    version: "goodjob.visual-reader.bridge.v1",
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "partial_success",
    errorCodes: ["visual_reader_session_expired"]
  });
  await controller.whenIdle();
  assert.deepEqual(completeCalls, [{
    status: "partial_success",
    errorCodes: ["visual_reader_session_expired"]
  }], "restart expiry persists through the complete endpoint with its stable error");
  assert.equal(abortCalls, 0, "restart expiry never invokes the user-takeover abort endpoint");
  assert.equal(controller.getState().session?.status, "partial_success");
  assert.equal(controller.getState().session?.lastErrorCode, "visual_reader_session_expired");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const abort = deferred<VisualReaderSession>();
  let abortReason: unknown;
  const api = {
    async getSession() {
      return session();
    },
    abortSession(_sessionId: string, input: unknown) {
      abortReason = input;
      return abort.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "abort-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  const stopping = controller.stop();
  assert.deepEqual(bridge.aborts, ["visual-session-1"]);
  assert.equal(controller.getState().session?.status, "collecting");
  abort.resolve(terminalSession("aborted"));
  await stopping;
  assert.deepEqual(abortReason, { reasonCode: "user_requested" });
  assert.equal(controller.getState().session?.status, "aborted");
  controller.close();
  assert.deepEqual(bridge.aborts, ["visual-session-1"], "page close does not abort the server session");
}

{
  const bridges: FakeBridge[] = [];
  const keys: string[] = [];
  let keySequence = 0;
  let attempts = 0;
  const api = {
    async createSession(_input: unknown, key: string) {
      attempts += 1;
      keys.push(key);
      if (attempts === 1) throw new TypeError("network unavailable");
      return session({ status: "created" });
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => {
      const bridge = new FakeBridge();
      bridges.push(bridge);
      return bridge;
    },
    keyFactory: () => `semantic-key-${++keySequence}`
  });
  await controller.open({ planId: "plan-1", runId: "run-1" });
  bridges.at(-1)?.ready();
  await assert.rejects(() => controller.authorize(), /network unavailable/u);
  await controller.authorize();
  assert.deepEqual(keys.slice(0, 2), ["semantic-key-1", "semantic-key-1"],
    "an authorize retry reuses the same semantic key after a network failure");

  controller.close();
  await controller.open({ planId: "plan-1", runId: "run-1" });
  bridges.at(-1)?.ready();
  await controller.authorize();
  assert.equal(keys[2], "semantic-key-2",
    "a successful authorize followed by a new lifecycle gets a fresh key");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const calls: Array<{ input: unknown; key: string }> = [];
  let keySequence = 0;
  const api = {
    async createSession(input: unknown, key: string) {
      calls.push({ input, key });
      if (calls.length === 1) throw new TypeError("network unavailable");
      return session({ status: "created", artifactUploadEnabled: false });
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => `artifact-key-${++keySequence}`
  });
  await controller.open({ planId: "plan-1", runId: "run-1" });
  bridge.ready();
  await assert.rejects(() => controller.authorize(), /network unavailable/u);
  controller.setArtifactUploadEnabled(false);
  await controller.authorize();
  assert.notEqual(calls[0]?.key, calls[1]?.key,
    "changing the artifact policy changes authorize semantics and its key");
  assert.deepEqual(calls.map((call) => call.input), [
    { runId: "run-1", artifactUploadEnabled: true },
    { runId: "run-1", artifactUploadEnabled: false }
  ]);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const abortKeys: string[] = [];
  let keySequence = 0;
  let attempts = 0;
  const api = {
    async getSession() {
      return session();
    },
    async abortSession(_sessionId: string, _input: unknown, key: string) {
      attempts += 1;
      abortKeys.push(key);
      if (attempts === 1) throw new TypeError("network unavailable");
      return terminalSession("aborted");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => `stop-key-${++keySequence}`
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  await assert.rejects(() => controller.stop(), /network unavailable/u);
  await controller.stop();
  assert.deepEqual(abortKeys, ["stop-key-1", "stop-key-1"],
    "a user stop retry reuses its semantic key");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const completeCalls: Array<{ status: string; errorCodes: string[]; key: string }> = [];
  let keySequence = 0;
  const api = {
    async getSession() {
      return session();
    },
    async completeSession(
      _sessionId: string,
      input: { status: string; errorCodes: string[] },
      key: string
    ) {
      completeCalls.push({ ...input, key });
      throw new TypeError("network unavailable");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => `terminal-key-${++keySequence}`
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  const terminals: Array<{
    status: "completed" | "partial_success";
    errorCodes: VisualReaderStableErrorCode[];
  }> = [
    { status: "completed", errorCodes: [] },
    { status: "completed", errorCodes: [] },
    { status: "partial_success" as const, errorCodes: ["visual_extraction_low_confidence"] },
    { status: "partial_success" as const, errorCodes: ["visual_artifact_invalid"] }
  ];
  for (const terminal of terminals) {
    bridge.emit({
      version: "goodjob.visual-reader.bridge.v1",
      type: "terminal",
      channelNonce: bridge.channelNonce,
      sessionId: "visual-session-1",
      ...terminal
    });
    await assert.rejects(() => controller.whenIdle(), /network unavailable/u);
  }
  assert.equal(completeCalls[0]?.key, completeCalls[1]?.key,
    "an identical terminal retry reuses its semantic key");
  assert.notEqual(completeCalls[1]?.key, completeCalls[2]?.key,
    "a different terminal status changes the semantic key");
  assert.notEqual(completeCalls[2]?.key, completeCalls[3]?.key,
    "different terminal error codes change the semantic key");
  controller.destroy();
}

{
  assert.throws(() => defaultVisualReaderKey(null), /安全随机|crypto/u,
    "missing browser crypto fails closed without mutating the aggregate self-test process");
}

{
  const order: string[] = [];
  const bridge = new OrderedBridge(order);
  const append = deferred<VisualObservationBatchResponse>();
  const complete = deferred<VisualReaderSession>();
  const api = {
    async getSession() {
      return session();
    },
    appendObservationBatch() {
      order.push("append-start");
      return append.promise.then((value) => {
        order.push("append-resolve");
        return value;
      });
    },
    completeSession() {
      order.push("complete-start");
      return complete.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "ordered-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit(batchEvent([observation()]));
  bridge.emit({
    version: "goodjob.visual-reader.bridge.v1",
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "completed",
    errorCodes: []
  });
  assert.deepEqual(order, ["append-start"],
    "terminal persistence must not start while a prior batch is pending");
  const idle = controller.whenIdle();
  let idleSettled = false;
  void idle.finally(() => { idleSettled = true; });
  append.resolve({ session: session(), accepted: [], duplicates: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["append-start", "append-resolve", "ACK", "complete-start"]);
  assert.equal(idleSettled, false, "whenIdle covers the entire ordered queue");
  complete.resolve(terminalSession("completed"));
  await idle;
  assert.equal(idleSettled, true);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const older = deferred<VisualReaderSession>();
  const newest = deferred<VisualReaderSession>();
  let reads = 0;
  const api = {
    getSession() {
      reads += 1;
      return reads === 1 ? older.promise : newest.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({ api, bridgeFactory: () => bridge });
  await controller.open({ planId: "plan-1", runId: "run-1" });
  const olderReconcile = controller.reconcile(projection());
  const newestReconcile = controller.reconcile({
    ...projection(),
    status: "completed"
  });
  newest.resolve(terminalSession("completed"));
  await newestReconcile;
  older.resolve(session({ status: "collecting" }));
  await olderReconcile;
  assert.equal(controller.getState().session?.status, "completed",
    "an older reconcile response cannot overwrite the newest terminal session");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const lateActive = deferred<VisualReaderSession>();
  let reads = 0;
  const api = {
    getSession() {
      reads += 1;
      return reads === 1 ? Promise.resolve(session()) : lateActive.promise;
    },
    async completeSession() {
      return terminalSession("completed");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "terminal-before-get-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  const reconciling = controller.reconcile(projection());
  bridge.emit({
    version: "goodjob.visual-reader.bridge.v1",
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "completed",
    errorCodes: []
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.getState().session?.status, "completed");
  lateActive.resolve(session({ status: "collecting" }));
  await reconciling;
  await controller.whenIdle();
  assert.equal(controller.getState().session?.status, "completed",
    "a late active GET cannot downgrade an already confirmed terminal session");
  controller.destroy();
}

{
  const bridges: FakeBridge[] = [];
  const append = deferred<VisualObservationBatchResponse>();
  const loadS2 = deferred<VisualReaderSession>();
  const api = {
    getSession(sessionId: string) {
      return sessionId === "visual-session-1"
        ? Promise.resolve(session())
        : loadS2.promise;
    },
    appendObservationBatch() {
      return append.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => {
      const bridge = new FakeBridge();
      bridges.push(bridge);
      return bridge;
    },
    keyFactory: () => "session-switch-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  const s1Bridge = bridges[0]!;
  s1Bridge.ready();
  s1Bridge.emit(batchEvent([observation()]));

  const switching = controller.reconcile(projection("visual-session-2"));
  assert.equal(controller.getState().session, null,
    "a projection session switch clears the old session before the new GET returns");
  assert.equal(s1Bridge.destroyed, true, "a session switch invalidates the old bridge nonce lifecycle");
  assert.equal(bridges.length, 2, "a session switch creates a fresh bridge");

  append.resolve({ session: session(), accepted: [], duplicates: [] });
  loadS2.resolve(session({ sessionId: "visual-session-2" }));
  await switching;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(s1Bridge.acknowledgements.length, 0,
    "an old-session batch response cannot acknowledge after the projection switches");
  assert.equal(controller.getState().session?.sessionId, "visual-session-2");
  assert.doesNotMatch(controller.getState().message ?? "", /已保存/u);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  let appendCalls = 0;
  let completeCalls = 0;
  const api = {
    async getSession() {
      return session();
    },
    async appendObservationBatch() {
      appendCalls += 1;
      if (appendCalls === 1) throw new TypeError("batch network failure");
      return { session: session(), accepted: [], duplicates: [] };
    },
    async completeSession() {
      completeCalls += 1;
      return terminalSession("completed");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "blocked-queue-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  const event = batchEvent([observation()]);
  bridge.emit(event);
  bridge.emit({
    version: "goodjob.visual-reader.bridge.v1",
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "completed",
    errorCodes: []
  });
  await assert.rejects(() => controller.whenIdle(), /batch network failure/u);
  assert.equal(completeCalls, 0, "a failed batch blocks the queued terminal write");
  assert.equal(bridge.acknowledgements.length, 0);

  bridge.emit(event);
  await controller.whenIdle();
  assert.equal(appendCalls, 2);
  assert.equal(bridge.acknowledgements.length, 1,
    "the retried batch is acknowledged only after persistence succeeds");
  assert.equal(completeCalls, 1, "the retained terminal continues after the batch retry");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const append = deferred<VisualObservationBatchResponse>();
  let abortCalls = 0;
  const api = {
    async getSession() {
      return session();
    },
    appendObservationBatch() {
      return append.promise;
    },
    async abortSession() {
      abortCalls += 1;
      return terminalSession("aborted");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "failed-batch-stop-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit(batchEvent([observation()]));
  append.reject(new TypeError("batch offline"));
  await assert.rejects(() => controller.whenIdle(), /batch offline/u);

  let stopError: unknown = null;
  await controller.stop().catch((error: unknown) => { stopError = error; });
  assert.equal(stopError, null, "stop discards a failed batch instead of returning its error");
  assert.equal(abortCalls, 1, "stop starts a fresh server abort after a failed batch");
  assert.equal(controller.getState().busy, false);
  assert.equal(controller.getState().session?.status, "aborted");
  assert.equal(bridge.acknowledgements.length, 0, "a discarded failed batch is never acknowledged");
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const append = deferred<VisualObservationBatchResponse>();
  let abortCalls = 0;
  const api = {
    async getSession() {
      return session();
    },
    appendObservationBatch() {
      return append.promise;
    },
    async abortSession() {
      abortCalls += 1;
      return terminalSession("aborted");
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => "pending-batch-stop-key"
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();
  bridge.emit(batchEvent([observation()]));

  const stopping = controller.stop();
  assert.equal(abortCalls, 1, "stop does not wait for a pending batch before server abort");
  await stopping;
  append.resolve({ session: session(), accepted: [], duplicates: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bridge.acknowledgements.length, 0, "a late discarded batch response is never acknowledged");
  assert.equal(controller.getState().session?.status, "aborted");
  assert.doesNotMatch(controller.getState().message ?? "", /已保存/u);
  controller.destroy();
}

{
  const bridge = new FakeBridge();
  const firstAbort = deferred<VisualReaderSession>();
  const secondAbort = deferred<VisualReaderSession>();
  const abortKeys: string[] = [];
  let keySequence = 0;
  const api = {
    async getSession() {
      return session();
    },
    abortSession(_sessionId: string, _input: unknown, key: string) {
      abortKeys.push(key);
      return abortKeys.length === 1 ? firstAbort.promise : secondAbort.promise;
    }
  } as unknown as VisualReaderApi;
  const controller = createVisualReaderController({
    api,
    bridgeFactory: () => bridge,
    keyFactory: () => `deferred-stop-key-${++keySequence}`
  });
  await controller.open({ planId: "plan-1", runId: "run-1", projection: projection() });
  bridge.ready();

  const firstStopping = controller.stop();
  firstAbort.reject(new TypeError("abort offline"));
  await assert.rejects(() => firstStopping, /abort offline/u);
  assert.equal(controller.getState().busy, false, "a failed server abort restores the stop control");

  const secondStopping = controller.stop();
  secondAbort.resolve(terminalSession("aborted"));
  await secondStopping;
  assert.deepEqual(abortKeys, ["deferred-stop-key-1", "deferred-stop-key-1"],
    "a server abort retry keeps the same stop semantic key");
  assert.equal(controller.getState().busy, false);
  assert.equal(controller.getState().session?.status, "aborted");
  controller.destroy();
}
