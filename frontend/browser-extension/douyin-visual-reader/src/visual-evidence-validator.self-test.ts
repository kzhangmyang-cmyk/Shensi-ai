import { strict as assert } from "node:assert";
import { validateVisualCaptureEvidence } from "./visual-evidence-validator";
import type { VisualCaptureRequest } from "./visual-capture-guard";
import { MASK_COLOR_RGBA } from "./visual-pipeline";

const request: VisualCaptureRequest = {
  kind: "visual_capture_request",
  sessionId: "validator-session",
  domTextState: "missing",
  viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 600, y: 200, width: 400, height: 180 },
  avatarBounds: { x: 620, y: 220, width: 48, height: 48 },
  regions: [
    { kind: "body", bounds: { x: 690, y: 220, width: 240, height: 80 } }
  ]
};

const pixels = new Uint8ClampedArray(800 * 360 * 4);
for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(MASK_COLOR_RGBA, offset);
for (let y = 40; y < 200; y += 1) {
  for (let x = 180; x < 660; x += 1) pixels.set([220, 220, 220, 255], (y * 800 + x) * 4);
}
for (let y = 40; y < 136; y += 1) {
  for (let x = 40; x < 136; x += 1) pixels.set(MASK_COLOR_RGBA, (y * 800 + x) * 4);
}

const riff = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
const evidence = {
  mediaType: "image/webp" as const,
  contentBase64: Buffer.from(riff).toString("base64"),
  width: 800,
  height: 360,
  redactionProof: {
    version: "opaque-rect-v1" as const,
    maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
    avatarBounds: { x: 40, y: 40, width: 96, height: 96 },
    visibleRegions: [{ x: 180, y: 40, width: 480, height: 160 }],
    maskedRegions: [
      { x: 0, y: 0, width: 800, height: 40 },
      { x: 0, y: 40, width: 180, height: 160 },
      { x: 660, y: 40, width: 140, height: 160 },
      { x: 0, y: 200, width: 800, height: 160 }
    ]
  },
  ocrResult: {
    text: "正文报价 128.50",
    confidence: 0.96,
    words: [
      { text: "正文报价", confidence: 0.96, bounds: { x: 200, y: 60, width: 100, height: 30 } },
      { text: "128.50", confidence: 0.97, bounds: { x: 320, y: 60, width: 80, height: 30 } }
    ]
  }
};

const decode = async () => ({ width: 800, height: 360, pixels: new Uint8ClampedArray(pixels) });
assert.deepEqual(await validateVisualCaptureEvidence(evidence, request, decode), evidence);

const baselineJitterEvidence = {
  ...evidence,
  ocrResult: {
    ...evidence.ocrResult,
    words: [
      { ...evidence.ocrResult.words[0], bounds: { x: 200, y: 89, width: 100, height: 30 } },
      { ...evidence.ocrResult.words[1], bounds: { x: 320, y: 60, width: 80, height: 30 } }
    ]
  }
};
assert.deepEqual(await validateVisualCaptureEvidence(baselineJitterEvidence, request, decode),
  baselineJitterEvidence,
  "service validation shares the offscreen line grouping so baseline jitter keeps x reading order");

assert.equal(await validateVisualCaptureEvidence({ ...evidence, contentBase64: "UklGRg==" }, request,
  async () => { throw new Error("malformed RIFF must fail before decode"); }), null,
"a short RIFF prefix is not a WebP");

assert.equal(await validateVisualCaptureEvidence({
  ...evidence,
  redactionProof: {
    ...evidence.redactionProof,
    visibleRegions: [{ x: 181, y: 40, width: 479, height: 160 }]
  }
}, request, decode), null, "proof geometry must be derived from the authorized request");

{
  const tampered = new Uint8ClampedArray(pixels);
  tampered[0] = 18;
  assert.equal(await validateVisualCaptureEvidence(evidence, request,
    async () => ({ width: 800, height: 360, pixels: tampered })), null,
  "every required mask pixel must retain the exact fixed color");
}

{
  const translucent = new Uint8ClampedArray(pixels);
  translucent[(60 * 800 + 300) * 4 + 3] = 254;
  assert.equal(await validateVisualCaptureEvidence(evidence, request,
    async () => ({ width: 800, height: 360, pixels: translucent })), null,
  "decoded redacted WebP must be fully opaque");
}

assert.equal(await validateVisualCaptureEvidence({
  ...evidence,
  ocrResult: {
    ...evidence.ocrResult,
    text: "正文报价 128.50 点赞500",
    words: [...evidence.ocrResult.words, {
      text: "点赞500", confidence: 0.99, bounds: { x: 700, y: 220, width: 70, height: 20 }
    }]
  }
}, request, decode), null, "OCR words outside body regions cannot cross the service-worker boundary");

{
  const overlapRequest: VisualCaptureRequest = {
    ...request,
    regions: [
      ...request.regions,
      { kind: "metadata", bounds: { x: 850, y: 220, width: 80, height: 80 } }
    ]
  };
  const overlapEvidence = {
    ...evidence,
    redactionProof: {
      ...evidence.redactionProof,
      visibleRegions: [
        ...evidence.redactionProof.visibleRegions,
        { x: 500, y: 40, width: 160, height: 160 }
      ]
    },
    ocrResult: {
      text: "正文报价 128.50 点赞500",
      confidence: 0.99,
      words: [...evidence.ocrResult.words, {
        text: "点赞500", confidence: 0.99, bounds: { x: 520, y: 60, width: 100, height: 30 }
      }]
    }
  };
  assert.equal(await validateVisualCaptureEvidence(overlapEvidence, overlapRequest, decode), null,
    "a word intersecting metadata is rejected even when it is fully contained by body");
}

console.log("visual evidence validator self-test passed");
