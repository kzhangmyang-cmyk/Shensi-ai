import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionVisualArtifactValidationError,
  AcquisitionVisualArtifactValidator
} from "./acquisition-visual-artifact-validator.js";

const MASK = [17, 61, 51, 255] as const;

type Rect = { x: number; y: number; width: number; height: number };

async function syntheticWebp(input: {
  width?: number;
  height?: number;
  visible?: Rect[];
  outsidePixel?: [number, number, number, number];
  pages?: number;
  withMetadata?: boolean;
}) {
  const sharp = (await import("sharp")).default;
  const width = input.width ?? 10;
  const height = input.height ?? 10;
  const visible = input.visible ?? [{ x: 2, y: 2, width: 5, height: 5 }];
  const bytes = Buffer.alloc(width * height * 4);
  const inRect = (x: number, y: number, rect: Rect) =>
    x >= rect.x && y >= rect.y
    && x < rect.x + rect.width && y < rect.y + rect.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const pixel = visible.some((rect) => inRect(x, y, rect))
        ? [230, 220, 200, 255]
        : input.outsidePixel ?? MASK;
      bytes.set(pixel, offset);
    }
  }
  let pipeline = sharp(bytes, {
    raw: { width, height, channels: 4 },
    limitInputPixels: 1_000_000
  });
  if (input.withMetadata) pipeline = pipeline.withMetadata({ orientation: 1 });
  if ((input.pages ?? 1) > 1) {
    const twoFrameGif = Buffer.from(
      "47494638396101000100800000000000ffffff21f904000a000000"
      + "2c000000000100010000020244010021f904000a0000002c000000"
      + "00010001000002024c01003b",
      "hex"
    );
    return sharp(twoFrameGif, {
      animated: true,
      limitInputPixels: 1_000_000
    }).resize(width, height, { kernel: "nearest" })
      .webp({ lossless: true }).toBuffer();
  }
  return pipeline.webp({ lossless: true }).toBuffer();
}

function proof(overrides: Partial<{
  version: string;
  maskColorRgba: number[];
  avatarBounds: Rect | null;
  visibleRegions: Rect[];
  maskedRegions: Rect[];
}> = {}) {
  return {
    version: "opaque-rect-v1",
    maskColorRgba: [...MASK],
    avatarBounds: { x: 0, y: 0, width: 2, height: 2 },
    visibleRegions: [{ x: 2, y: 2, width: 5, height: 5 }],
    maskedRegions: [{ x: 0, y: 0, width: 2, height: 2 }],
    ...overrides
  };
}

function rejectsArtifact(error: unknown) {
  return error instanceof AcquisitionVisualArtifactValidationError
    && error.code === "visual_artifact_invalid";
}

test("validator accepts one metadata-free WebP whose proof matches every pixel", async () => {
  const bytes = await syntheticWebp({});
  const result = await new AcquisitionVisualArtifactValidator().validate({
    bytes,
    viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
    cardBounds: { x: 10, y: 10, width: 10, height: 10 },
    redactionProof: proof()
  });
  assert.deepEqual(result, {
    bytes,
    width: 10,
    height: 10,
    maskedRegionCount: 1
  });
});

test("validator rejects any unmasked pixel outside the visible-region union", async () => {
  const bytes = await syntheticWebp({ outsidePixel: [1, 2, 3, 255] });
  await assert.rejects(new AcquisitionVisualArtifactValidator().validate({
    bytes,
    viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
    cardBounds: { x: 10, y: 10, width: 10, height: 10 },
    redactionProof: proof()
  }), rejectsArtifact);
});

test("validator rejects avatar and declared masked pixels even inside a visible region", async () => {
  const bytes = await syntheticWebp({
    visible: [{ x: 0, y: 0, width: 8, height: 8 }]
  });
  await assert.rejects(new AcquisitionVisualArtifactValidator().validate({
    bytes,
    viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
    cardBounds: { x: 10, y: 10, width: 10, height: 10 },
    redactionProof: proof({
      visibleRegions: [{ x: 0, y: 0, width: 8, height: 8 }],
      avatarBounds: { x: 0, y: 0, width: 2, height: 2 },
      maskedRegions: [{ x: 6, y: 6, width: 2, height: 2 }]
    })
  }), rejectsArtifact);
});

test("validator computes overlapping visible coverage as a union and caps it at 80 percent", async () => {
  const bytes = await syntheticWebp({
    visible: [{ x: 0, y: 0, width: 9, height: 9 }]
  });
  await assert.rejects(new AcquisitionVisualArtifactValidator().validate({
    bytes,
    viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
    cardBounds: { x: 10, y: 10, width: 10, height: 10 },
    redactionProof: proof({
      avatarBounds: null,
      visibleRegions: [
        { x: 0, y: 0, width: 6, height: 9 },
        { x: 3, y: 0, width: 6, height: 9 }
      ],
      maskedRegions: [{ x: 9, y: 0, width: 1, height: 10 }]
    })
  }), rejectsArtifact);
});

test("validator rejects non-Buffer input, wrong dimensions, bad rectangles, metadata and non-WebP", async () => {
  const validator = new AcquisitionVisualArtifactValidator();
  const bytes = await syntheticWebp({});
  const invalid = [
    { bytes: bytes.toString("base64"), cardBounds: { x: 10, y: 10, width: 10, height: 10 }, redactionProof: proof() },
    { bytes, cardBounds: { x: 10, y: 10, width: 9, height: 10 }, redactionProof: proof() },
    { bytes, cardBounds: { x: 10, y: 10, width: 10, height: 10 }, redactionProof: proof({ visibleRegions: [{ x: 9, y: 9, width: 2, height: 2 }] }) },
    { bytes: Buffer.from("not a webp"), cardBounds: { x: 10, y: 10, width: 10, height: 10 }, redactionProof: proof() },
    { bytes: await syntheticWebp({ withMetadata: true }), cardBounds: { x: 10, y: 10, width: 10, height: 10 }, redactionProof: proof() },
    { bytes: await syntheticWebp({ pages: 2 }), cardBounds: { x: 10, y: 10, width: 10, height: 10 }, redactionProof: proof() }
  ];
  for (const candidate of invalid) {
    await assert.rejects(validator.validate({
      ...candidate,
      viewport: { width: 100, height: 100, deviceScaleFactor: 1 }
    } as never), rejectsArtifact);
  }
});
