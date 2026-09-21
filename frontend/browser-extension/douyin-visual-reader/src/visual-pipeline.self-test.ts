import { strict as assert } from "node:assert";
import {
  MASK_COLOR_RGBA,
  canonicalOcrReadingOrder,
  characterRecall,
  filterOcrResultToBodyRegions,
  redactCommentCard,
  restrictRasterToRegions,
  resolveObservationWithVisualFallback,
  type RasterImage,
  type RedactedCapture
} from "./visual-pipeline";
import type { VisualOcrPort } from "./ocr-port";

function raster(width: number, height: number): RasterImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 17 + y * 3) % 256;
      pixels[offset + 1] = (x * 5 + y * 29) % 256;
      pixels[offset + 2] = (x * 11 + y * 7) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function pixel(image: RasterImage, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.pixels.slice(offset, offset + 4));
}

function inside(rect: { x: number; y: number; width: number; height: number }, x: number, y: number) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

{
  const source = raster(12, 8);
  const result = redactCommentCard({
    screenshot: source,
    viewport: { width: 6, height: 4, deviceScaleFactor: 2 },
    cardBounds: { x: -1, y: 1, width: 6, height: 4 },
    avatarBounds: { x: 0.25, y: 1.25, width: 1, height: 1 },
    visibleRegions: [
      { x: 1.5, y: 1.25, width: 2.5, height: 1 },
      { x: 1.5, y: 2.5, width: 1.5, height: 0.5 }
    ]
  });

  assert.deepEqual(result.cardBounds, { x: 0, y: 1, width: 5, height: 3 });
  assert.equal(result.image.width, 10);
  assert.equal(result.image.height, 6);
  assert.deepEqual(result.redactionProof.maskColorRgba, MASK_COLOR_RGBA);
  assert.deepEqual(result.redactionProof.avatarBounds, { x: 0, y: 0, width: 3, height: 3 });
  assert.deepEqual(result.redactionProof.visibleRegions, [
    { x: 3, y: 0, width: 5, height: 3 },
    { x: 3, y: 3, width: 3, height: 1 }
  ]);

  for (let y = 0; y < result.image.height; y += 1) {
    for (let x = 0; x < result.image.width; x += 1) {
      const visible = result.redactionProof.visibleRegions.some((rect) => inside(rect, x, y));
      const avatar = result.redactionProof.avatarBounds !== null
        && inside(result.redactionProof.avatarBounds, x, y);
      if (!visible || avatar) assert.deepEqual(pixel(result.image, x, y), MASK_COLOR_RGBA);
    }
  }
  assert.notDeepEqual(pixel(result.image, 4, 1), MASK_COLOR_RGBA);
  assert.ok(result.redactionProof.maskedRegions.length >= 1);
  assert.ok(result.redactionProof.maskedRegions.length <= 100);
}

for (const avatarStyle of ["circle", "square"] as const) {
  const source = raster(8, 8);
  if (avatarStyle === "circle") {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if ((x - 1.5) ** 2 + (y - 1.5) ** 2 > 2.25) continue;
        const offset = (y * source.width + x) * 4;
        source.pixels.set([240, 10, 10, 255], offset);
      }
    }
  }
  const result = redactCommentCard({
    screenshot: source,
    viewport: { width: 8, height: 8, deviceScaleFactor: 1 },
    cardBounds: { x: 0, y: 0, width: 8, height: 8 },
    avatarBounds: { x: 0, y: 0, width: 4, height: 4 },
    visibleRegions: [{ x: 3, y: 0, width: 5, height: 6 }]
  });
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      assert.deepEqual(pixel(result.image, x, y), MASK_COLOR_RGBA, `${avatarStyle}:${x},${y}`);
    }
  }
}

assert.throws(() => redactCommentCard({
  screenshot: raster(10, 10),
  viewport: { width: 10, height: 10, deviceScaleFactor: 1 },
  cardBounds: { x: 0, y: 0, width: 10, height: 10 },
  avatarBounds: null,
  visibleRegions: [{ x: 0, y: 0, width: 9, height: 9 }]
}), /visible area/i);

assert.equal(characterRecall("中文报价 128.50 元 😊", "中文报价128.50元😊"), 1);
assert.ok(characterRecall("中文报价 128.50 元", "中文 128.50 元") < 0.9);

assert.deepEqual(filterOcrResultToBodyRegions({
  text: "想了解报价 刚刚 点赞500",
  confidence: 0.98,
  words: [
    { text: "想了解报价", confidence: 0.98, bounds: { x: 10, y: 10, width: 80, height: 20 } },
    { text: "刚刚", confidence: 0.99, bounds: { x: 10, y: 60, width: 30, height: 15 } },
    { text: "点赞500", confidence: 0.99, bounds: { x: 60, y: 60, width: 50, height: 15 } },
    { text: "越界金额188.50", confidence: 0.99, bounds: { x: 85, y: 15, width: 40, height: 15 } }
  ]
}, [{ x: 5, y: 5, width: 100, height: 35 }]), {
  text: "想了解报价",
  confidence: 0.98,
  words: [{ text: "想了解报价", confidence: 0.98, bounds: { x: 10, y: 10, width: 80, height: 20 } }]
}, "metadata and partially out-of-body words cannot contribute text or numbers");

assert.equal(filterOcrResultToBodyRegions({
  text: "中文报价 128.50 元",
  confidence: 0.94,
  words: [
    { text: "中", confidence: 0.94, bounds: { x: 10, y: 10, width: 20, height: 30 } },
    { text: "文报价", confidence: 0.94, bounds: { x: 35, y: 10, width: 60, height: 30 } },
    { text: "元", confidence: 0.94, bounds: { x: 180, y: 12, width: 20, height: 28 } },
    { text: "128.50", confidence: 0.94, bounds: { x: 105, y: 14, width: 65, height: 24 } }
  ]
}, [{ x: 0, y: 0, width: 220, height: 50 }]).text, "中 文报价 128.50 元",
"minor baseline jitter on one visual line cannot move a currency label before its amount");

assert.deepEqual(canonicalOcrReadingOrder([
  { text: "right", confidence: 0.99, bounds: { x: 80, y: 10, width: 20, height: 20 } },
  { text: "left", confidence: 0.99, bounds: { x: 10, y: 29, width: 20, height: 20 } },
  { text: "next", confidence: 0.99, bounds: { x: 10, y: 60, width: 20, height: 20 } }
]).map((word) => word.text), ["left", "right", "next"],
"even one-pixel vertical overlap forms a visual line before sorting that line by x");

{
  const source = raster(4, 1);
  const restricted = restrictRasterToRegions(source,
    [{ x: 0, y: 0, width: 4, height: 1 }],
    [{ x: 2, y: 0, width: 2, height: 1 }]);
  assert.notDeepEqual(pixel(restricted, 1, 0), MASK_COLOR_RGBA);
  assert.deepEqual(pixel(restricted, 2, 0), MASK_COLOR_RGBA,
    "metadata overlap is subtracted from the body OCR raster");
  assert.deepEqual(filterOcrResultToBodyRegions({
    text: "正文 点赞500",
    confidence: 0.99,
    words: [
      { text: "正文", confidence: 0.99, bounds: { x: 10, y: 10, width: 30, height: 15 } },
      { text: "点赞500", confidence: 0.99, bounds: { x: 65, y: 10, width: 30, height: 15 } }
    ]
  }, [{ x: 0, y: 0, width: 100, height: 40 }],
  [{ x: 60, y: 0, width: 40, height: 40 }]), {
    text: "正文",
    confidence: 0.99,
    words: [{ text: "正文", confidence: 0.99, bounds: { x: 10, y: 10, width: 30, height: 15 } }]
  }, "a word intersecting metadata cannot be reconstructed as body text");
}

const baseObservation = {
  clientObservationKey: "dom:fixture",
  sourceUrl: "https://www.douyin.com/video/123",
  videoId: "123",
  visibleText: "DOM 可见正文",
  domTextHash: `sha256:${"1".repeat(64)}`,
  ocrTextHash: null,
  displayName: "公开昵称",
  visibleTimeText: "刚刚",
  likeCount: 12,
  replyCount: 1,
  platformCommentId: "456",
  publicProfileUrl: "https://www.douyin.com/user/secUid1",
  secUid: "secUid1",
  extractionMethod: "dom" as const,
  fieldConfidences: { visibleText: 0.99, displayName: 0.96 },
  viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
  cardBounds: { x: 10, y: 20, width: 80, height: 50 },
  readerVersion: "goodjob-visual-reader/1.0.0",
  capturedAt: "2026-08-16T00:00:00.000Z",
  redactedCrop: null
};

const proof = {
  version: "opaque-rect-v1" as const,
  maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
  avatarBounds: { x: 0, y: 0, width: 8, height: 8 },
  visibleRegions: [{ x: 10, y: 10, width: 30, height: 10 }],
  maskedRegions: [{ x: 0, y: 0, width: 10, height: 50 }]
};
const capture: RedactedCapture = {
  mediaType: "image/webp",
  bytes: new Uint8Array([82, 73, 70, 70]),
  width: 80,
  height: 50,
  contentBase64: "UklGRg==",
  redactionProof: proof
};

{
  let captures = 0;
  let ocrCalls = 0;
  const ocr: VisualOcrPort = {
    async recognize() {
      ocrCalls += 1;
      throw new Error("complete DOM must not reach OCR");
    }
  };
  const result = await resolveObservationWithVisualFallback({
    observation: baseObservation,
    artifactUploadEnabled: true,
    domTextState: "complete",
    capture: async () => { captures += 1; return capture; },
    ocr
  });
  assert.equal(captures, 0);
  assert.equal(ocrCalls, 0);
  assert.equal(result.observation, baseObservation);
  assert.equal(result.manualReviewOnly, false);
  assert.equal(result.domTextHash, baseObservation.domTextHash);
  assert.equal(result.ocrTextHash, baseObservation.ocrTextHash);
}

{
  let captures = 0;
  let ocrCalls = 0;
  const result = await resolveObservationWithVisualFallback({
    observation: { ...baseObservation, visibleText: "" },
    artifactUploadEnabled: false,
    domTextState: "missing",
    capture: async () => { captures += 1; return capture; },
    ocr: { async recognize() { ocrCalls += 1; throw new Error("disabled"); } }
  });
  assert.equal(captures, 0);
  assert.equal(ocrCalls, 0);
  assert.equal(result.observation, null);
  assert.equal(result.manualReviewOnly, true);
}

{
  let captures = 0;
  const result = await resolveObservationWithVisualFallback({
    observation: { ...baseObservation, fieldConfidences: { visibleText: 0.99 } },
    artifactUploadEnabled: false,
    domTextState: "truncated",
    capture: async () => { captures += 1; return capture; },
    ocr: { async recognize() { throw new Error("disabled"); } }
  });
  assert.equal(captures, 0);
  assert.equal(result.observation?.visibleText, baseObservation.visibleText);
  assert.ok((result.observation?.fieldConfidences.visibleText ?? 1) < 0.85);
  assert.equal(result.observation?.domTextHash, baseObservation.domTextHash);
  assert.equal(result.manualReviewOnly, true);
}

{
  const result = await resolveObservationWithVisualFallback({
    observation: { ...baseObservation, visibleText: "" },
    artifactUploadEnabled: true,
    domTextState: "missing",
    capture: async () => capture,
    ocr: {
      async recognize(_crop, languages) {
        assert.deepEqual(languages, ["chi_sim", "eng"]);
        return {
          text: "想了解报价 128.50 元 😊",
          confidence: 0.96,
          words: [{ text: "报价", confidence: 0.98, bounds: { x: 10, y: 10, width: 20, height: 8 } }]
        };
      }
    }
  });
  const observation = result.observation;
  if (!observation) throw new Error("expected OCR fallback observation");
  assert.equal(observation.extractionMethod, "ocr");
  assert.equal(observation.visibleText, "想了解报价 128.50 元 😊");
  assert.equal(observation.displayName, null);
  assert.equal(observation.platformCommentId, null);
  assert.equal(observation.publicProfileUrl, null);
  assert.equal(observation.secUid, null);
  assert.deepEqual(observation.redactedCrop, {
    mediaType: "image/webp",
    contentBase64: "UklGRg==",
    redactionProof: proof
  });
  assert.equal(result.manualReviewOnly, false);
  assert.match(result.ocrTextHash ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.domTextHash, null);
  assert.equal(observation.ocrTextHash, result.ocrTextHash);
  assert.equal(observation.domTextHash, result.domTextHash);
}

for (const testCase of [
  { name: "low confidence", text: "需要报价 128.50 元", confidence: 0.72 },
  { name: "low recall", text: "需要报 128.50 元", confidence: 0.96 },
  { name: "money conflict", text: "需要报价 188.50 元", confidence: 0.99 },
  { name: "text conflict", text: "完全不同的内容", confidence: 0.99 }
]) {
  const result = await resolveObservationWithVisualFallback({
    observation: { ...baseObservation, visibleText: "需要报价 128.50 元" },
    artifactUploadEnabled: true,
    domTextState: "truncated",
    capture: async () => capture,
    ocr: { async recognize() { return { text: testCase.text, confidence: testCase.confidence, words: [] }; } }
  });
  const observation = result.observation;
  if (!observation) throw new Error(`expected OCR observation: ${testCase.name}`);
  assert.equal(result.manualReviewOnly, true, testCase.name);
  assert.ok((observation.fieldConfidences.visibleText ?? 1) < 0.85, testCase.name);
  assert.equal(observation.visibleText, testCase.text, testCase.name);
  assert.match(result.domTextHash ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.ocrTextHash ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(observation.domTextHash, result.domTextHash, testCase.name);
  assert.equal(observation.ocrTextHash, result.ocrTextHash, testCase.name);
}

console.log("visual pipeline self-test passed");
