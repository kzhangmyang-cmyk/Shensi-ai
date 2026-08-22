import { strict as assert } from "node:assert";
import {
  requestVisualCaptureFallback,
  resolveVisualCaptureResponse
} from "./visual-content-fallback";
import { isObservation, type VisualObservationSubmission } from "./protocol";

const observation: VisualObservationSubmission = {
  clientObservationKey: "dom:fixture",
  sourceUrl: "https://www.douyin.com/video/123",
  videoId: "123",
  visibleText: "需要报价 128.50 元",
  domTextHash: `sha256:${"1".repeat(64)}`,
  ocrTextHash: null,
  displayName: "公开昵称",
  visibleTimeText: "刚刚",
  likeCount: 2,
  replyCount: 0,
  platformCommentId: "456",
  publicProfileUrl: "https://www.douyin.com/user/secUid1",
  secUid: "secUid1",
  extractionMethod: "dom",
  fieldConfidences: { visibleText: 0.84, displayName: 0.96 },
  viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 600, y: 200, width: 400, height: 180 },
  readerVersion: "goodjob-visual-reader/1.0.0",
  capturedAt: "2026-08-16T00:00:00.000Z",
  redactedCrop: null
};

const response = {
  accepted: true,
  evidence: {
    mediaType: "image/webp",
    contentBase64: "UklGRgQAAABXRUJQ",
    width: 800,
    height: 360,
    redactionProof: {
      version: "opaque-rect-v1",
      maskColorRgba: [17, 61, 51, 255],
      avatarBounds: { x: 40, y: 40, width: 96, height: 96 },
      visibleRegions: [{ x: 180, y: 40, width: 480, height: 160 }],
      maskedRegions: [{ x: 0, y: 0, width: 180, height: 360 }]
    },
    ocrResult: {
      text: "需要报价 128.50 元",
      confidence: 0.98,
      words: []
    }
  }
};

{
  const resolved = await resolveVisualCaptureResponse({
    observation,
    domTextState: "truncated",
    response
  });
  if (!resolved) throw new Error("expected a resolved OCR observation");
  assert.equal(resolved.extractionMethod, "ocr");
  assert.equal(resolved.visibleText, "需要报价 128.50 元");
  assert.equal(resolved.displayName, null);
  assert.equal(resolved.platformCommentId, null);
  assert.equal(resolved.publicProfileUrl, null);
  assert.equal(resolved.secUid, null);
  assert.ok((resolved.fieldConfidences.visibleText ?? 1) < 0.85,
    "truncated DOM remains manual-review-only even when OCR agrees");
  assert.equal(resolved.redactedCrop?.contentBase64, "UklGRgQAAABXRUJQ");
}

const malformedRetained = await resolveVisualCaptureResponse({
  observation,
  domTextState: "truncated",
  response: { ...response, evidence: { ...response.evidence, displayName: "forbidden identity" } }
});
if (!malformedRetained) throw new Error("truncated DOM must survive malformed OCR evidence");
assert.equal(malformedRetained.visibleText, observation.visibleText);
assert.equal(malformedRetained.displayName, observation.displayName);
assert.equal(malformedRetained.redactedCrop, null);

{
  const retained = await resolveVisualCaptureResponse({
    observation,
    domTextState: "truncated",
    response: { accepted: false }
  });
  if (!retained) throw new Error("truncated DOM must survive unavailable OCR");
  assert.equal(retained.visibleText, observation.visibleText);
  assert.equal(retained.extractionMethod, "dom");
  assert.equal(retained.displayName, observation.displayName);
  assert.equal(retained.platformCommentId, observation.platformCommentId);
  assert.equal(retained.redactedCrop, null);
  assert.ok((retained.fieldConfidences.visibleText ?? 1) < 0.85);
}

{
  const retained = await resolveVisualCaptureResponse({
    observation,
    domTextState: "truncated",
    response: {
      ...response,
      evidence: { ...response.evidence, ocrResult: { text: "", confidence: 0, words: [] } }
    }
  });
  if (!retained) throw new Error("truncated DOM must survive empty OCR");
  assert.equal(retained.visibleText, observation.visibleText);
  assert.equal(retained.extractionMethod, "dom");
  assert.equal(retained.displayName, observation.displayName);
  assert.equal(retained.redactedCrop, null,
    "a DOM fallback cannot carry an OCR-only redacted crop");
  assert.equal(isObservation(retained), true,
    "the retained DOM fallback must pass the real bridge protocol parser");
  assert.ok((retained.fieldConfidences.visibleText ?? 1) < 0.85);
}

{
  const sendMessage = async (): Promise<unknown> => {
    throw new Error("runtime.sendMessage rejected");
  };
  const retained = await requestVisualCaptureFallback({
    observation,
    domTextState: "truncated",
    sendMessage
  });
  if (!retained) throw new Error("truncated DOM must survive capture transport rejection");
  assert.equal(retained.visibleText, observation.visibleText);
  assert.equal(retained.extractionMethod, "dom");
  assert.equal(retained.redactedCrop, null);
  assert.ok((retained.fieldConfidences.visibleText ?? 1) < 0.85);
  assert.equal(await requestVisualCaptureFallback({
    observation: { ...observation, visibleText: "" },
    domTextState: "missing",
    sendMessage
  }), null, "missing DOM remains null when capture transport rejects");
}

console.log("visual content fallback self-test passed");
