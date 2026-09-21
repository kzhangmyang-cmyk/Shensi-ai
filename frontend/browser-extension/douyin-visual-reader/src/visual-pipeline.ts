import type {
  VisualOcrCrop,
  VisualOcrPort,
  VisualOcrResult,
  VisualOcrWord
} from "./ocr-port";

export const MASK_COLOR_RGBA = Object.freeze([17, 61, 51, 255] as const);

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RasterImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface OpaqueRectRedactionProofV1 {
  version: "opaque-rect-v1";
  maskColorRgba: [17, 61, 51, 255];
  avatarBounds: PixelRect | null;
  visibleRegions: PixelRect[];
  maskedRegions: PixelRect[];
}

export interface RedactedCapture extends VisualOcrCrop {
  contentBase64: string;
  redactionProof: OpaqueRectRedactionProofV1;
}

export interface VisualPipelineObservation {
  clientObservationKey: string;
  sourceUrl: string;
  videoId: string;
  visibleText: string;
  domTextHash: string | null;
  ocrTextHash: string | null;
  displayName: string | null;
  visibleTimeText: string | null;
  likeCount: number | null;
  replyCount: number | null;
  platformCommentId: string | null;
  publicProfileUrl: string | null;
  secUid: string | null;
  extractionMethod: "dom" | "accessibility" | "ocr" | "vision";
  fieldConfidences: Record<string, number>;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: PixelRect;
  readerVersion: string;
  capturedAt: string;
  redactedCrop: {
    mediaType: "image/webp";
    contentBase64: string;
    redactionProof: OpaqueRectRedactionProofV1;
  } | null;
}

function finiteRect(rect: PixelRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function intersect(rect: PixelRect, bounds: PixelRect): PixelRect | null {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function toCropPixels(rect: PixelRect, card: PixelRect, scale: number,
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

function inRect(rect: PixelRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y
    && x < rect.x + rect.width && y < rect.y + rect.height;
}

function maskedRectangles(width: number, height: number, visible: PixelRect[]): PixelRect[] {
  const yEdges = [...new Set([0, height, ...visible.flatMap((rect) => [rect.y, rect.y + rect.height])])]
    .filter((value) => value >= 0 && value <= height)
    .sort((left, right) => left - right);
  const rectangles: PixelRect[] = [];
  for (let index = 0; index < yEdges.length - 1; index += 1) {
    const top = yEdges[index];
    const bottom = yEdges[index + 1];
    if (bottom <= top) continue;
    const intervals = visible
      .filter((rect) => rect.y < bottom && rect.y + rect.height > top)
      .map((rect) => [rect.x, rect.x + rect.width] as const)
      .sort((left, right) => left[0] - right[0]);
    let cursor = 0;
    for (const [left, right] of intervals) {
      if (left > cursor) rectangles.push({ x: cursor, y: top, width: left - cursor, height: bottom - top });
      cursor = Math.max(cursor, right);
    }
    if (cursor < width) rectangles.push({ x: cursor, y: top, width: width - cursor, height: bottom - top });
  }
  const merged: PixelRect[] = [];
  for (const rect of rectangles) {
    const previous = merged.at(-1);
    if (previous && previous.x === rect.x && previous.width === rect.width
      && previous.y + previous.height === rect.y) previous.height += rect.height;
    else merged.push({ ...rect });
  }
  if (merged.length < 1 || merged.length > 100) {
    throw new Error("masked region proof exceeds safe bounds");
  }
  return merged;
}

function validateRaster(image: RasterImage): void {
  if (!Number.isSafeInteger(image.width) || image.width < 1
    || !Number.isSafeInteger(image.height) || image.height < 1
    || !(image.pixels instanceof Uint8ClampedArray)
    || image.pixels.length !== image.width * image.height * 4) {
    throw new Error("invalid screenshot raster");
  }
}

export function redactCommentCard(input: {
  screenshot: RasterImage;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: PixelRect;
  avatarBounds: PixelRect | null;
  visibleRegions: PixelRect[];
}): {
  image: RasterImage;
  cardBounds: PixelRect;
  regionMappings: Array<{ sourceIndex: number; bounds: PixelRect }>;
  redactionProof: OpaqueRectRedactionProofV1;
} {
  validateRaster(input.screenshot);
  const { viewport } = input;
  if (!Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0
    || !Number.isFinite(viewport.deviceScaleFactor)
    || viewport.deviceScaleFactor < 0.5 || viewport.deviceScaleFactor > 8
    || !finiteRect(input.cardBounds)) throw new Error("invalid viewport geometry");
  const viewportRect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const card = intersect(input.cardBounds, viewportRect);
  if (!card) throw new Error("comment card is outside viewport");
  const width = Math.round(card.width * viewport.deviceScaleFactor);
  const height = Math.round(card.height * viewport.deviceScaleFactor);
  if (width < 1 || height < 1 || width * height > 1_000_000) {
    throw new Error("comment card crop exceeds safe bounds");
  }
  if (!Array.isArray(input.visibleRegions) || input.visibleRegions.length < 1
    || input.visibleRegions.length > 20 || input.visibleRegions.some((rect) => !finiteRect(rect))) {
    throw new Error("invalid visible regions");
  }
  const regionMappings = input.visibleRegions.flatMap((rect, sourceIndex) => {
    const converted = toCropPixels(rect, card, viewport.deviceScaleFactor, width, height);
    return converted ? [{ sourceIndex, bounds: converted }] : [];
  });
  const visibleRegions = regionMappings.map((mapping) => mapping.bounds);
  if (visibleRegions.length < 1) throw new Error("no visible text regions in crop");
  let unionPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (visibleRegions.some((rect) => inRect(rect, x, y))) unionPixels += 1;
    }
  }
  if (unionPixels / (width * height) > 0.8) throw new Error("visible area exceeds 80 percent");
  const avatarBounds = input.avatarBounds === null
    ? null
    : toCropPixels(input.avatarBounds, card, viewport.deviceScaleFactor, width, height);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(MASK_COLOR_RGBA, offset);
  const sourceScaleX = input.screenshot.width / viewport.width;
  const sourceScaleY = input.screenshot.height / viewport.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const visible = visibleRegions.some((rect) => inRect(rect, x, y));
      const avatar = avatarBounds !== null && inRect(avatarBounds, x, y);
      if (!visible || avatar) continue;
      const cssX = card.x + (x + 0.5) / viewport.deviceScaleFactor;
      const cssY = card.y + (y + 0.5) / viewport.deviceScaleFactor;
      const sourceX = Math.max(0, Math.min(input.screenshot.width - 1, Math.floor(cssX * sourceScaleX)));
      const sourceY = Math.max(0, Math.min(input.screenshot.height - 1, Math.floor(cssY * sourceScaleY)));
      const sourceOffset = (sourceY * input.screenshot.width + sourceX) * 4;
      pixels.set(input.screenshot.pixels.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
    }
  }
  return {
    image: { width, height, pixels },
    cardBounds: card,
    regionMappings,
    redactionProof: {
      version: "opaque-rect-v1",
      maskColorRgba: [...MASK_COLOR_RGBA],
      avatarBounds,
      visibleRegions,
      maskedRegions: maskedRectangles(width, height, visibleRegions)
    }
  };
}

export function restrictRasterToRegions(image: RasterImage, regions: PixelRect[],
  excludedRegions: PixelRect[] = []): RasterImage {
  validateRaster(image);
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 20
    || regions.some((region) => !finiteRect(region)) || !Array.isArray(excludedRegions)
    || excludedRegions.length > 20
    || excludedRegions.some((region) => !finiteRect(region))) {
    throw new Error("invalid OCR body regions");
  }
  const pixels = new Uint8ClampedArray(image.pixels);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (regions.some((region) => inRect(region, x, y))
        && !excludedRegions.some((region) => inRect(region, x, y))) continue;
      pixels.set(MASK_COLOR_RGBA, (y * image.width + x) * 4);
    }
  }
  return { width: image.width, height: image.height, pixels };
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

export function canonicalOcrReadingOrder(words: VisualOcrWord[]): VisualOcrWord[] {
  const lines: Array<{ top: number; bottom: number; words: VisualOcrWord[] }> = [];
  for (const word of [...words].sort((left, right) => left.bounds.y - right.bounds.y
    || left.bounds.x - right.bounds.x)) {
    const top = word.bounds.y;
    const bottom = word.bounds.y + word.bounds.height;
    const line = lines.find((candidate) => {
      const overlap = Math.min(candidate.bottom, bottom) - Math.max(candidate.top, top);
      return overlap > 0;
    });
    if (line) {
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
      line.words.push(word);
    } else {
      lines.push({ top, bottom, words: [word] });
    }
  }
  return lines.sort((left, right) => left.top - right.top)
    .flatMap((line) => line.words.sort((left, right) => left.bounds.x - right.bounds.x));
}

export function filterOcrResultToBodyRegions(result: VisualOcrResult,
  bodyRegions: PixelRect[], excludedRegions: PixelRect[] = []): VisualOcrResult {
  const words = canonicalOcrReadingOrder(result.words.filter((word) => bodyRegions.some(
    (region) => contains(region, word.bounds)
  ) && !excludedRegions.some((region) => overlaps(region, word.bounds))));
  return {
    text: words.map((word) => word.text).join(" ").normalize("NFC").trim(),
    confidence: words.length > 0
      ? Math.min(result.confidence, ...words.map((word) => word.confidence))
      : 0,
    words
  };
}

function normalizedCharacters(value: string): string[] {
  return Array.from(value.normalize("NFC").toLocaleLowerCase("zh-CN")).filter((character) => !/\s/u.test(character));
}

export function characterRecall(expected: string, actual: string): number {
  const source = normalizedCharacters(expected);
  const candidate = normalizedCharacters(actual);
  if (source.length === 0) return candidate.length === 0 ? 1 : 0;
  const previous = new Uint16Array(candidate.length + 1);
  for (const sourceCharacter of source) {
    const current = new Uint16Array(candidate.length + 1);
    for (let index = 0; index < candidate.length; index += 1) {
      current[index + 1] = sourceCharacter === candidate[index]
        ? previous[index] + 1
        : Math.max(previous[index + 1], current[index]);
    }
    previous.set(current);
  }
  return previous[candidate.length] / source.length;
}

function numericTokens(value: string): string[] {
  return value.normalize("NFC").match(/(?:¥|￥|\$|USD|CNY)?\s*[0-9]+(?:[.,][0-9]+)*/giu)
    ?.map((token) => token.replace(/\s/gu, "").toUpperCase()) ?? [];
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validOcr(result: VisualOcrResult): boolean {
  return typeof result.text === "string" && Number.isFinite(result.confidence)
    && result.confidence >= 0 && result.confidence <= 1 && Array.isArray(result.words);
}

export async function resolveObservationWithVisualFallback(input: {
  observation: VisualPipelineObservation;
  artifactUploadEnabled: boolean;
  domTextState: "complete" | "missing" | "truncated";
  capture(): Promise<RedactedCapture>;
  ocr: VisualOcrPort;
}): Promise<{
  observation: VisualPipelineObservation | null;
  manualReviewOnly: boolean;
  domTextHash: string | null;
  ocrTextHash: string | null;
}> {
  if (input.domTextState === "complete") {
    return {
      observation: input.observation,
      manualReviewOnly: false,
      domTextHash: input.observation.domTextHash,
      ocrTextHash: input.observation.ocrTextHash
    };
  }
  if (!input.artifactUploadEnabled) {
    if (input.domTextState === "truncated") {
      return {
        observation: {
          ...input.observation,
          fieldConfidences: {
            ...input.observation.fieldConfidences,
            visibleText: Math.min(0.84, input.observation.fieldConfidences.visibleText ?? 0.84)
          },
          redactedCrop: null
        },
        manualReviewOnly: true,
        domTextHash: input.observation.domTextHash,
        ocrTextHash: input.observation.ocrTextHash
      };
    }
    return { observation: null, manualReviewOnly: true, domTextHash: null, ocrTextHash: null };
  }
  const capture = await input.capture();
  if (capture.mediaType !== "image/webp" || capture.bytes.byteLength < 1
    || capture.bytes.byteLength > 262_144 || capture.width < 1 || capture.height < 1) {
    throw new Error("redacted crop exceeds safe bounds");
  }
  const recognized = await input.ocr.recognize(capture, ["chi_sim", "eng"]);
  if (!validOcr(recognized)) throw new Error("invalid OCR result");
  const text = recognized.text.normalize("NFC").trim();
  if (!text || text.length > 2_000) {
    return { observation: null, manualReviewOnly: true, domTextHash: null, ocrTextHash: null };
  }
  const domText = input.observation.visibleText.normalize("NFC").trim();
  const recall = domText ? characterRecall(domText, text) : 1;
  const numbersAgree = !domText
    || JSON.stringify(numericTokens(domText)) === JSON.stringify(numericTokens(text));
  const manualReviewOnly = input.domTextState === "truncated"
    || recognized.confidence < 0.9 || recall < 0.9 || !numbersAgree;
  const domTextHash = domText ? await sha256(domText) : null;
  const ocrTextHash = await sha256(text);
  const clientDigest = await sha256(JSON.stringify({
    sourceUrl: input.observation.sourceUrl,
    cardBounds: input.observation.cardBounds,
    domTextHash,
    ocrTextHash
  }));
  const fieldConfidences = { ...input.observation.fieldConfidences };
  delete fieldConfidences.displayName;
  delete fieldConfidences.platformCommentId;
  delete fieldConfidences.publicProfileUrl;
  delete fieldConfidences.secUid;
  fieldConfidences.visibleText = manualReviewOnly
    ? Math.min(0.84, recognized.confidence)
    : recognized.confidence;
  return {
    observation: {
      ...input.observation,
      clientObservationKey: `ocr:${clientDigest.slice("sha256:".length)}`,
      visibleText: text,
      domTextHash,
      ocrTextHash,
      displayName: null,
      platformCommentId: null,
      publicProfileUrl: null,
      secUid: null,
      extractionMethod: "ocr",
      fieldConfidences,
      redactedCrop: {
        mediaType: "image/webp",
        contentBase64: capture.contentBase64,
        redactionProof: capture.redactionProof
      }
    },
    manualReviewOnly,
    domTextHash,
    ocrTextHash
  };
}
