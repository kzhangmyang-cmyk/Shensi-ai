import { strict as assert } from "node:assert";
import {
  BRIDGE_VERSION,
  isObservation,
  parseExtensionEvent,
  parsePageCommand,
  parseVisualReaderAck
} from "./protocol";
import { isVisualObservationSubmission } from "../../../src/acquisition/visual-reader-api";

const nonce = "a".repeat(64);
const limits = {
  maxVideos: 10,
  maxCommentsPerVideo: 30,
  maxScrolls: 5,
  maxOcrCalls: 10,
  maxDurationMs: 120_000
};

const visualReaderAck = {
  kind: "visual_reader_ack",
  channelNonce: nonce,
  sessionId: "visual-session-1",
  batchId: "batch-1"
} as const;
assert.deepEqual(parseVisualReaderAck(visualReaderAck), visualReaderAck);
assert.equal(parseVisualReaderAck({ ...visualReaderAck, extra: true }), null,
  "the service-worker-to-content ACK is a closed message");
assert.equal(parseVisualReaderAck({ ...visualReaderAck, channelNonce: "old-owner" }), null,
  "ACK lifecycle ownership requires the exact in-memory nonce shape");

for (const command of [
  { version: BRIDGE_VERSION, type: "probe", channelNonce: nonce },
  {
    version: BRIDGE_VERSION,
    type: "start",
    channelNonce: nonce,
    sessionId: "visual-session-1",
    limits,
    artifactUploadEnabled: false
  },
  {
    version: BRIDGE_VERSION,
    type: "acknowledge_batch",
    channelNonce: nonce,
    sessionId: "visual-session-1",
    batchId: "batch-1"
  },
  {
    version: BRIDGE_VERSION,
    type: "abort",
    channelNonce: nonce,
    sessionId: "visual-session-1"
  }
] as const) {
  assert.deepEqual(parsePageCommand(command, "http://127.0.0.1:5191"), command);
  assert.equal(parsePageCommand({ ...command, extra: true }, "http://127.0.0.1:5191"), null);
  assert.equal(parsePageCommand(JSON.stringify(command), "http://127.0.0.1:5191"), null);
}

assert.equal(parsePageCommand({
  version: BRIDGE_VERSION,
  type: "start",
  channelNonce: nonce,
  sessionId: "visual-session-1",
  limits: { ...limits, maxScrolls: 6 },
  artifactUploadEnabled: false
}, "http://127.0.0.1:5191"), null);

const ready = {
  version: BRIDGE_VERSION,
  type: "ready",
  channelNonce: nonce,
  extensionVersion: "1.0.0"
} as const;
assert.deepEqual(parseExtensionEvent(ready), ready);
assert.equal(parseExtensionEvent({ ...ready, channelNonce: "raw-nonce-not-64" }), null);
assert.deepEqual(parseExtensionEvent({
  version: BRIDGE_VERSION,
  type: "terminal",
  channelNonce: nonce,
  sessionId: "visual-session-1",
  status: "aborted",
  errorCodes: ["visual_reader_user_takeover"]
}), {
  version: BRIDGE_VERSION,
  type: "terminal",
  channelNonce: nonce,
  sessionId: "visual-session-1",
  status: "aborted",
  errorCodes: ["visual_reader_user_takeover"]
});
assert.equal(parseExtensionEvent({ ...ready, cookie: "secret" }), null);

const validObservation = {
  clientObservationKey: `dom:${"1".repeat(64)}`,
  sourceUrl: "https://www.douyin.com/video/123456789",
  videoId: "123456789",
  visibleText: "正".repeat(2_000),
  domTextHash: `sha256:${"1".repeat(64)}`,
  ocrTextHash: null,
  displayName: "林经理",
  visibleTimeText: "1小时前",
  likeCount: 12,
  replyCount: 3,
  platformCommentId: "987654321",
  publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
  secUid: "MS4wLjABAAAA",
  extractionMethod: "dom",
  fieldConfidences: { visibleText: 0.99 },
  viewport: { width: 8192, height: 8192, deviceScaleFactor: 2 },
  cardBounds: { x: 0, y: 0, width: 8192, height: 8192 },
  readerVersion: "goodjob-visual-reader/1.0.0",
  capturedAt: "2026-08-15T08:00:00.000Z",
  redactedCrop: null
} as const;

assert.equal(isVisualObservationSubmission(validObservation, false), true);
assert.equal(isObservation(validObservation), true, "2,000 visible characters are accepted across both layers");

const validOcrObservation = {
  ...validObservation,
  clientObservationKey: `ocr:${"2".repeat(64)}`,
  visibleText: "中文报价 128.50 元",
  domTextHash: null,
  ocrTextHash: `sha256:${"2".repeat(64)}`,
  displayName: null,
  platformCommentId: null,
  publicProfileUrl: null,
  secUid: null,
  extractionMethod: "ocr" as const,
  fieldConfidences: { visibleText: 0.94 },
  redactedCrop: {
    mediaType: "image/webp" as const,
    contentBase64: "UklGRg==",
    redactionProof: {
      version: "opaque-rect-v1" as const,
      maskColorRgba: [17, 61, 51, 255],
      avatarBounds: { x: 0, y: 0, width: 8, height: 8 },
      visibleRegions: [{ x: 10, y: 2, width: 40, height: 12 }],
      maskedRegions: [{ x: 0, y: 0, width: 10, height: 20 }]
    }
  }
};
assert.equal(isVisualObservationSubmission(validOcrObservation, false), true);
assert.equal(isObservation(validOcrObservation), true,
  "extension protocol carries only a strict opaque-rect OCR crop");
assert.equal(isObservation({ ...validOcrObservation, platformCommentId: "987654321" }), false,
  "OCR cannot invent a platform comment identity");

const invalidContractCases: Array<[string, unknown]> = [
  ["missing DOM text hash", (({ domTextHash: _removed, ...rest }) => rest)(validObservation)],
  ["null OCR text hash", { ...validOcrObservation, ocrTextHash: null }],
  ["uppercase OCR text hash", { ...validOcrObservation, ocrTextHash: `sha256:${"A".repeat(64)}` }],
  ["2,001 visible characters", { ...validObservation, visibleText: "正".repeat(2_001) }],
  ["whitespace-only visible text", { ...validObservation, visibleText: "   " }],
  ["missing visibleText confidence", { ...validObservation, fieldConfidences: {} }],
  ["viewport beyond 8,192", {
    ...validObservation,
    viewport: { ...validObservation.viewport, width: 8193 }
  }],
  ["bounds beyond 8,192", {
    ...validObservation,
    cardBounds: { ...validObservation.cardBounds, x: 8193 }
  }],
  ["non-public comment ID", { ...validObservation, platformCommentId: "comment-private" }],
  ["invalid secUid", { ...validObservation, secUid: "bad uid" }],
  ["profile/secUid mismatch", { ...validObservation, secUid: "different" }],
  ["count beyond signed int", { ...validObservation, likeCount: 2_147_483_648 }],
  ["whitespace-only reader version", { ...validObservation, readerVersion: "   " }]
];

for (const [name, candidate] of invalidContractCases) {
  assert.equal(isVisualObservationSubmission(candidate, false), false, `${name} is rejected by Task 4`);
  assert.equal(isObservation(candidate), false, `${name} is rejected by the extension protocol`);
}

console.log("douyin visual reader protocol self-test passed");
