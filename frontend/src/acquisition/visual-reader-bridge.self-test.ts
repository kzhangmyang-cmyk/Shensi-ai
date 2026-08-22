import { strict as assert } from "node:assert";
import {
  createVisualReaderBridge,
  VISUAL_READER_BRIDGE_VERSION,
  type VisualReaderExtensionEvent,
  type VisualReaderWindowPort
} from "./visual-reader-bridge";
import type {
  VisualObservationSubmission,
  VisualReaderLimits
} from "./visual-reader-api";

type Listener = EventListenerOrEventListenerObject;

class FakeWindowPort implements VisualReaderWindowPort {
  readonly sent: Array<{ message: unknown; targetOrigin: string }> = [];
  private readonly listeners = new Set<Listener>();

  addEventListener(type: "message", listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: "message", listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: unknown, targetOrigin: string): void {
    this.sent.push({ message, targetOrigin });
  }

  emit(input: { source?: unknown; origin?: string; data: unknown }): void {
    const event = {
      source: input.source ?? this,
      origin: input.origin ?? "http://127.0.0.1:5191",
      data: input.data
    } as MessageEvent;
    for (const listener of this.listeners) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

class ManualTimeouts {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  schedule = (callback: () => void): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle === "number") this.callbacks.delete(handle);
  };

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("没有待执行的超时任务");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

const limits: VisualReaderLimits = {
  maxVideos: 10,
  maxCommentsPerVideo: 30,
  maxScrolls: 5,
  maxOcrCalls: 10,
  maxDurationMs: 120_000
};

function observation(
  key: string,
  overrides: Partial<VisualObservationSubmission> = {}
): VisualObservationSubmission {
  return {
    clientObservationKey: key,
    sourceUrl: "https://www.douyin.com/video/123456789",
    videoId: "123456789",
    visibleText: "正在寻找可以长期合作的获客方案",
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
    fieldConfidences: { visibleText: 0.99, platformCommentId: 0.98 },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    cardBounds: { x: 720, y: 220, width: 520, height: 140 },
    readerVersion: "goodjob-visual-reader/1.0.0",
    capturedAt: "2026-08-15T08:00:00.000Z",
    redactedCrop: null,
    ...overrides
  };
}

function redactedCrop() {
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

{
  const port = new FakeWindowPort();
  const timeouts = new ManualTimeouts();
  const availability: string[] = [];
  const received: VisualReaderExtensionEvent[] = [];
  let fill = 0;
  const bridge = createVisualReaderBridge({
    windowPort: port,
    origin: "http://127.0.0.1:5191",
    randomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = fill++;
      return bytes;
    },
    scheduleTimeout: timeouts.schedule,
    cancelTimeout: timeouts.cancel,
    probeTimeoutMs: 1_200
  });

  assert.equal(bridge.channelNonce.length, 64, "nonce must contain 32 random bytes");
  assert.equal(
    bridge.channelNonce,
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  );

  bridge.connect({
    onAvailability: (value) => availability.push(value),
    onEvent: (event) => received.push(event)
  });
  assert.deepEqual(availability, ["probing"]);
  assert.deepEqual(port.sent[0], {
    targetOrigin: "http://127.0.0.1:5191",
    message: {
      version: VISUAL_READER_BRIDGE_VERSION,
      type: "probe",
      channelNonce: bridge.channelNonce
    }
  });

  const ready = {
    version: VISUAL_READER_BRIDGE_VERSION,
    type: "ready",
    channelNonce: bridge.channelNonce,
    extensionVersion: "1.0.0"
  };
  port.emit({ origin: "https://evil.example", data: ready });
  port.emit({ source: {}, data: ready });
  port.emit({ data: { ...ready, channelNonce: "old-nonce" } });
  port.emit({ data: JSON.stringify(ready) });
  port.emit({ data: { ...ready, extra: true } });
  port.emit({ data: { ...ready, extensionVersion: new Blob(["1.0.0"]) } });
  port.emit({ data: { ...ready, extensionVersion: () => "1.0.0" } });
  assert.deepEqual(availability, ["probing"]);
  assert.equal(received.length, 0);

  port.emit({ data: ready });
  assert.deepEqual(availability, ["probing", "ready"]);
  assert.equal(received[0]?.type, "ready");

  bridge.startSession("visual-session-1", limits, false);
  assert.deepEqual(port.sent.at(-1), {
    targetOrigin: "http://127.0.0.1:5191",
    message: {
      version: VISUAL_READER_BRIDGE_VERSION,
      type: "start",
      channelNonce: bridge.channelNonce,
      sessionId: "visual-session-1",
      limits,
      artifactUploadEnabled: false
    }
  });

  const validBatch = {
    version: VISUAL_READER_BRIDGE_VERSION,
    type: "observation_batch",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    batchId: "batch-1",
    observations: [observation("client-observation-1")]
  };
  port.emit({ data: { ...validBatch, sessionId: "visual-session-old" } });
  port.emit({ data: { ...validBatch, observations: Array.from({ length: 21 }, (_, index) => observation(`client-${index}`)) } });
  port.emit({ data: {
    ...validBatch,
    observations: Array.from({ length: 6 }, (_, index) => observation(`crop-${index}`, {
      redactedCrop: redactedCrop()
    }))
  } });
  port.emit({ data: {
    ...validBatch,
    observations: [{ ...observation("unknown-field"), cookie: "secret" }]
  } });
  port.emit({ data: validBatch });
  assert.equal(received.length, 2, "only the ready and valid current-session batch are delivered");
  assert.equal(received[1]?.type, "observation_batch");

  bridge.acknowledgeBatch("visual-session-1", "batch-1");
  assert.deepEqual(port.sent.at(-1), {
    targetOrigin: "http://127.0.0.1:5191",
    message: {
      version: VISUAL_READER_BRIDGE_VERSION,
      type: "acknowledge_batch",
      channelNonce: bridge.channelNonce,
      sessionId: "visual-session-1",
      batchId: "batch-1"
    }
  });

  const terminal = {
    version: VISUAL_READER_BRIDGE_VERSION,
    type: "terminal",
    channelNonce: bridge.channelNonce,
    sessionId: "visual-session-1",
    status: "partial_success",
    errorCodes: ["visual_extraction_low_confidence"]
  };
  port.emit({ data: terminal });
  assert.equal(received.at(-1)?.type, "terminal");

  bridge.abortSession("visual-session-1");
  assert.equal((port.sent.at(-1)?.message as { type?: string }).type, "abort");
  bridge.destroy();
  port.emit({ data: validBatch });
  assert.equal(received.length, 3, "destroy removes the listener");
}

{
  const port = new FakeWindowPort();
  const timeouts = new ManualTimeouts();
  const availability: string[] = [];
  const bridge = createVisualReaderBridge({
    windowPort: port,
    origin: "http://127.0.0.1:5191",
    randomValues(bytes) {
      bytes.fill(255);
      return bytes;
    },
    scheduleTimeout: timeouts.schedule,
    cancelTimeout: timeouts.cancel
  });
  bridge.connect({
    onAvailability: (value) => availability.push(value),
    onEvent: () => undefined
  });
  timeouts.runNext();
  assert.deepEqual(availability, ["probing", "unavailable"]);
}
