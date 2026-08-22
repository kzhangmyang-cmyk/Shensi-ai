import type { VisualCaptureRequest } from "./visual-capture-guard";
import {
  parseVisualCaptureEvidence,
  type VisualCaptureEvidence
} from "./visual-capture-runtime";
import {
  MASK_COLOR_RGBA,
  canonicalOcrReadingOrder,
  type PixelRect,
  type RasterImage
} from "./visual-pipeline";

export type WebpDecoder = (bytes: Uint8Array) => Promise<RasterImage>;

function inside(rect: PixelRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function contains(outer: PixelRect, inner: PixelRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function overlaps(left: PixelRect, right: PixelRect): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

function intersect(rect: PixelRect, bounds: PixelRect): PixelRect | null {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function cropRect(rect: PixelRect, card: PixelRect, scale: number,
  width: number, height: number): PixelRect | null {
  const clipped = intersect(rect, card);
  if (!clipped) return null;
  const left = Math.max(0, Math.floor((clipped.x - card.x) * scale));
  const top = Math.max(0, Math.floor((clipped.y - card.y) * scale));
  const right = Math.min(width, Math.ceil((clipped.x + clipped.width - card.x) * scale));
  const bottom = Math.min(height, Math.ceil((clipped.y + clipped.height - card.y) * scale));
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function exactRects(left: PixelRect[], right: PixelRect[]): boolean {
  return left.length === right.length && left.every((rect, index) => {
    const expected = right[index];
    return expected !== undefined && rect.x === expected.x && rect.y === expected.y
      && rect.width === expected.width && rect.height === expected.height;
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function decodeInServiceWorker(bytes: Uint8Array): Promise<RasterImage> {
  const blob = new Blob([bytes.slice().buffer], { type: "image/webp" });
  let bitmap: ImageBitmap | null = await createImageBitmap(blob);
  let target: OffscreenCanvas | null = new OffscreenCanvas(bitmap.width, bitmap.height);
  try {
    const context = target.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("service worker WebP canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    const decoded = context.getImageData(0, 0, target.width, target.height);
    return { width: decoded.width, height: decoded.height, pixels: decoded.data };
  } finally {
    bitmap.close();
    bitmap = null;
    target.width = 1;
    target.height = 1;
    target = null;
  }
}

export async function validateVisualCaptureEvidence(value: unknown, request: VisualCaptureRequest,
  decode: WebpDecoder = decodeInServiceWorker): Promise<VisualCaptureEvidence | null> {
  const evidence = parseVisualCaptureEvidence(value);
  if (!evidence) return null;
  const viewport = { x: 0, y: 0, width: request.viewport.width, height: request.viewport.height };
  const card = intersect(request.cardBounds, viewport);
  if (!card) return null;
  const width = Math.round(card.width * request.viewport.deviceScaleFactor);
  const height = Math.round(card.height * request.viewport.deviceScaleFactor);
  if (evidence.width !== width || evidence.height !== height || width * height > 1_000_000) return null;
  const mappings = request.regions.flatMap((region) => {
    const bounds = cropRect(region.bounds, card, request.viewport.deviceScaleFactor, width, height);
    return bounds ? [{ kind: region.kind, bounds }] : [];
  });
  const expectedVisible = mappings.map((mapping) => mapping.bounds);
  const bodyRegions = mappings.filter((mapping) => mapping.kind === "body")
    .map((mapping) => mapping.bounds);
  const metadataRegions = mappings.filter((mapping) => mapping.kind === "metadata")
    .map((mapping) => mapping.bounds);
  const expectedAvatar = request.avatarBounds === null ? null
    : cropRect(request.avatarBounds, card, request.viewport.deviceScaleFactor, width, height);
  const proof = evidence.redactionProof;
  if (!exactRects(proof.visibleRegions, expectedVisible)
    || JSON.stringify(proof.avatarBounds) !== JSON.stringify(expectedAvatar)
    || bodyRegions.length < 1) return null;
  const orderedWords = canonicalOcrReadingOrder(evidence.ocrResult.words);
  if (orderedWords.some((word) => !bodyRegions.some((region) => contains(region, word.bounds))
    || metadataRegions.some((region) => overlaps(region, word.bounds)))
    || evidence.ocrResult.text !== orderedWords.map((word) => word.text).join(" ").normalize("NFC").trim()) {
    return null;
  }
  let bytes: Uint8Array | null = null;
  let raster: RasterImage | null = null;
  try {
    bytes = decodeBase64(evidence.contentBase64);
    raster = await decode(bytes);
    if (raster.width !== width || raster.height !== height
      || raster.pixels.length !== width * height * 4) return null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const visible = expectedVisible.some((region) => inside(region, x, y));
        const avatar = expectedAvatar !== null && inside(expectedAvatar, x, y);
        const declaredMasked = proof.maskedRegions.some((region) => inside(region, x, y));
        if (declaredMasked !== !visible) return null;
        const offset = (y * width + x) * 4;
        if (raster.pixels[offset + 3] !== 255) return null;
        if ((!visible || avatar) && MASK_COLOR_RGBA.some((channel, index) => (
          raster!.pixels[offset + index] !== channel
        ))) return null;
      }
    }
    return evidence;
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
    raster?.pixels.fill(0);
    bytes = null;
    raster = null;
  }
}
