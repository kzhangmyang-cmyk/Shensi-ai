import sharp from "sharp";

const MASK = Object.freeze([17, 61, 51, 255] as const);
const MAX_PIXELS = 1_000_000;

export interface VisualArtifactPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface VisualArtifactRedactionProof {
  version: "opaque-rect-v1";
  maskColorRgba: [17, 61, 51, 255];
  avatarBounds: VisualArtifactPixelRect | null;
  visibleRegions: VisualArtifactPixelRect[];
  maskedRegions: VisualArtifactPixelRect[];
}

export interface ValidateVisualArtifactInput {
  bytes: Buffer;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  cardBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  redactionProof: VisualArtifactRedactionProof;
}

export interface ValidatedVisualArtifact {
  bytes: Buffer;
  width: number;
  height: number;
  maskedRegionCount: number;
}

export class AcquisitionVisualArtifactValidationError extends Error {
  readonly code = "visual_artifact_invalid";
  readonly status = 400;

  constructor() {
    super("Redacted visual artifact failed validation");
    this.name = "AcquisitionVisualArtifactValidationError";
  }
}

function fail(): never {
  throw new AcquisitionVisualArtifactValidationError();
}

function finiteInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function validViewportAndBounds(input: ValidateVisualArtifactInput) {
  const { viewport, cardBounds } = input;
  if (!viewport || typeof viewport !== "object"
    || !Number.isSafeInteger(viewport.width)
    || !Number.isSafeInteger(viewport.height)
    || viewport.width < 1 || viewport.width > 8_192
    || viewport.height < 1 || viewport.height > 8_192
    || !finiteInRange(viewport.deviceScaleFactor, 0.5, 8)
    || !cardBounds || typeof cardBounds !== "object"
    || !finiteInRange(cardBounds.x, 0, 8_192)
    || !finiteInRange(cardBounds.y, 0, 8_192)
    || !finiteInRange(cardBounds.width, Number.EPSILON, 8_192)
    || !finiteInRange(cardBounds.height, Number.EPSILON, 8_192)
    || cardBounds.x + cardBounds.width > viewport.width
    || cardBounds.y + cardBounds.height > viewport.height) fail();
  const width = Math.round(cardBounds.width * viewport.deviceScaleFactor);
  const height = Math.round(cardBounds.height * viewport.deviceScaleFactor);
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) fail();
  return { width, height };
}

function validRect(rect: unknown, width: number, height: number):
rect is VisualArtifactPixelRect {
  if (!rect || typeof rect !== "object" || Array.isArray(rect)) return false;
  if (Object.keys(rect).length !== 4
    || !Object.hasOwn(rect, "x")
    || !Object.hasOwn(rect, "y")
    || !Object.hasOwn(rect, "width")
    || !Object.hasOwn(rect, "height")) return false;
  const value = rect as VisualArtifactPixelRect;
  return Number.isSafeInteger(value.x) && value.x >= 0
    && Number.isSafeInteger(value.y) && value.y >= 0
    && Number.isSafeInteger(value.width) && value.width >= 1
    && Number.isSafeInteger(value.height) && value.height >= 1
    && value.x + value.width <= width
    && value.y + value.height <= height;
}

function inRect(x: number, y: number, rect: VisualArtifactPixelRect) {
  return x >= rect.x && y >= rect.y
    && x < rect.x + rect.width && y < rect.y + rect.height;
}

function validateProof(
  proof: unknown,
  width: number,
  height: number
): VisualArtifactRedactionProof {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || Object.keys(proof).length !== 5
    || !Object.hasOwn(proof, "version")
    || !Object.hasOwn(proof, "maskColorRgba")
    || !Object.hasOwn(proof, "avatarBounds")
    || !Object.hasOwn(proof, "visibleRegions")
    || !Object.hasOwn(proof, "maskedRegions")) fail();
  const value = proof as VisualArtifactRedactionProof;
  if (value.version !== "opaque-rect-v1"
    || !Array.isArray(value.maskColorRgba)
    || value.maskColorRgba.length !== 4
    || value.maskColorRgba.some((channel, index) => channel !== MASK[index])
    || (value.avatarBounds !== null
      && !validRect(value.avatarBounds, width, height))
    || !Array.isArray(value.visibleRegions)
    || value.visibleRegions.length < 1
    || value.visibleRegions.length > 20
    || value.visibleRegions.some((rect) => !validRect(rect, width, height))
    || !Array.isArray(value.maskedRegions)
    || value.maskedRegions.length < 1
    || value.maskedRegions.length > 100
    || value.maskedRegions.some((rect) => !validRect(rect, width, height))) {
    fail();
  }
  return value;
}

function isMaskPixel(pixels: Buffer, offset: number) {
  return pixels[offset] === MASK[0]
    && pixels[offset + 1] === MASK[1]
    && pixels[offset + 2] === MASK[2]
    && pixels[offset + 3] === MASK[3];
}

function validatePixels(
  pixels: Buffer,
  width: number,
  height: number,
  proof: VisualArtifactRedactionProof
) {
  let visibleUnionPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const visible = proof.visibleRegions.some((rect) => inRect(x, y, rect));
      if (visible) visibleUnionPixels += 1;
      const explicitlyMasked = proof.maskedRegions.some(
        (rect) => inRect(x, y, rect)
      );
      const avatar = proof.avatarBounds !== null
        && inRect(x, y, proof.avatarBounds);
      if ((!visible || explicitlyMasked || avatar)
        && !isMaskPixel(pixels, (y * width + x) * 4)) fail();
    }
  }
  if (visibleUnionPixels / (width * height) > 0.8) fail();
}

export class AcquisitionVisualArtifactValidator {
  async validate(input: ValidateVisualArtifactInput):
  Promise<ValidatedVisualArtifact> {
    if (!input || typeof input !== "object" || !Buffer.isBuffer(input.bytes)
      || input.bytes.byteLength < 1 || input.bytes.byteLength > 262_144) fail();
    const expected = validViewportAndBounds(input);
    try {
      const metadata = await sharp(input.bytes, {
        failOn: "warning",
        limitInputPixels: MAX_PIXELS,
        limitInputChannels: 4,
        pages: 1,
        page: 0,
        sequentialRead: true,
        unlimited: false
      }).metadata();
      if (metadata.format !== "webp"
        || metadata.width !== expected.width
        || metadata.height !== expected.height
        || (metadata.pages ?? 1) !== 1
        || metadata.pageHeight !== undefined
        || metadata.loop !== undefined
        || metadata.delay !== undefined
        || metadata.orientation !== undefined
        || metadata.hasProfile
        || metadata.exif !== undefined
        || metadata.icc !== undefined
        || metadata.iptc !== undefined
        || metadata.xmp !== undefined
        || metadata.xmpAsString !== undefined
        || metadata.tifftagPhotoshop !== undefined) fail();
      const proof = validateProof(
        input.redactionProof,
        expected.width,
        expected.height
      );
      const decoded = await sharp(input.bytes, {
        failOn: "warning",
        limitInputPixels: MAX_PIXELS,
        limitInputChannels: 4,
        pages: 1,
        page: 0,
        sequentialRead: true,
        unlimited: false
      }).toColourspace("srgb").ensureAlpha().raw().toBuffer({
        resolveWithObject: true
      });
      if (decoded.info.width !== expected.width
        || decoded.info.height !== expected.height
        || decoded.info.channels !== 4
        || decoded.data.byteLength !== expected.width * expected.height * 4) {
        fail();
      }
      validatePixels(
        decoded.data,
        expected.width,
        expected.height,
        proof
      );
      return {
        bytes: input.bytes,
        width: expected.width,
        height: expected.height,
        maskedRegionCount: proof.maskedRegions.length
      };
    } catch (error) {
      if (error instanceof AcquisitionVisualArtifactValidationError) {
        throw error;
      }
      fail();
    }
  }
}
