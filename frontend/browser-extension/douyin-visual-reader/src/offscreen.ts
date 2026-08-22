import { createTesseractOcrPort } from "./tesseract-ocr";
import {
  filterOcrResultToBodyRegions,
  redactCommentCard,
  restrictRasterToRegions,
  type RasterImage
} from "./visual-pipeline";
import type { VisualCaptureRequest } from "./visual-capture-guard";
import { assertLosslessRedactedWebp } from "./webp-redaction-policy";
import {
  createOffscreenCaptureLifecycle,
  createSensitiveResourceScope,
  runPreparedOcr
} from "./offscreen-lifecycle";

declare const chrome: any;

const ocr = createTesseractOcrPort({ assetBaseUrl: chrome.runtime.getURL("ocr") });
const captureLifecycle = createOffscreenCaptureLifecycle();

function canvas(width: number, height: number): HTMLCanvasElement {
  const value = document.createElement("canvas");
  value.width = width;
  value.height = height;
  return value;
}

function loadImageFromDataUrl(image: HTMLImageElement, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("screenshot decode failed"));
    image.src = value;
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function toWebp(target: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => target.toBlob((blob) => {
    if (!blob || blob.type !== "image/webp") reject(new Error("WebP encode failed"));
    else resolve(blob);
  }, "image/webp", quality));
}

async function encodeWithinLimit(image: RasterImage,
  resources: ReturnType<typeof createSensitiveResourceScope>,
  requireActive: () => void): Promise<Uint8Array> {
  const target = resources.track(canvas(image.width, image.height), (value) => {
    value.width = 1;
    value.height = 1;
  });
  const context = target.getContext("2d", { alpha: true });
  if (!context) throw new Error("canvas unavailable");
  const canvasPixels = resources.track(new Uint8ClampedArray(image.pixels.length),
    (value) => value.fill(0));
  canvasPixels.set(image.pixels);
  context.putImageData(new ImageData(canvasPixels, image.width, image.height), 0, 0);
  let decodedCanvas: HTMLCanvasElement | null = null;
  let decodedPixels: Uint8ClampedArray | null = null;
  let bitmap: ImageBitmap | null = null;
  let bytes: Uint8Array | null = null;
  let completed = false;
  try {
    const blob = await toWebp(target, 1);
    requireActive();
    bytes = resources.track(new Uint8Array(await blob.arrayBuffer()), (value) => value.fill(0));
    requireActive();
    bitmap = resources.track(await createImageBitmap(blob), (value) => value.close());
    requireActive();
    if (bitmap.width !== image.width || bitmap.height !== image.height) {
      throw new Error("redacted WebP dimensions changed");
    }
    decodedCanvas = resources.track(canvas(image.width, image.height), (value) => {
      value.width = 1;
      value.height = 1;
    });
    const decodedContext = decodedCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!decodedContext) throw new Error("canvas unavailable");
    decodedContext.drawImage(bitmap, 0, 0);
    decodedPixels = resources.track(
      decodedContext.getImageData(0, 0, image.width, image.height).data,
      (value) => value.fill(0)
    );
    assertLosslessRedactedWebp({
      encodedByteLength: bytes.byteLength,
      original: image.pixels,
      decoded: decodedPixels
    });
    requireActive();
    completed = true;
    return bytes;
  } finally {
    if (decodedPixels) resources.dispose(decodedPixels);
    decodedPixels = null;
    if (bitmap) resources.dispose(bitmap);
    bitmap = null;
    if (decodedCanvas) resources.dispose(decodedCanvas);
    decodedCanvas = null;
    resources.dispose(canvasPixels);
    resources.dispose(target);
    if (!completed && bytes) resources.dispose(bytes);
  }
}

async function processCapture(message: VisualCaptureRequest & {
  runtimeEpoch: string;
  runtimeGeneration: number;
  screenshotDataUrl: string;
}) {
  let screenshotDataUrl: string | null = message.screenshotDataUrl;
  let sourceImage: HTMLImageElement | null = null;
  let sourceCanvas: HTMLCanvasElement | null = null;
  let screenshot: RasterImage | null = null;
  let redactedPixels: Uint8ClampedArray | null = null;
  let ocrPixels: Uint8ClampedArray | null = null;
  let lifecycleToken: symbol | null = null;
  let rawReleased = false;
  const resources = createSensitiveResourceScope();
  const releaseDecodedRaw = () => {
    screenshot?.pixels.fill(0);
    screenshot = null;
    screenshotDataUrl = null;
    if (sourceImage) sourceImage.src = "";
    sourceImage = null;
    if (sourceCanvas) {
      sourceCanvas.width = 1;
      sourceCanvas.height = 1;
    }
    sourceCanvas = null;
    message.screenshotDataUrl = "";
  };
  const releaseRaw = () => {
    if (rawReleased) return;
    rawReleased = true;
    releaseDecodedRaw();
    redactedPixels?.fill(0);
    redactedPixels = null;
    ocrPixels?.fill(0);
    ocrPixels = null;
    resources.disposeAll();
    if (lifecycleToken) captureLifecycle.finish(lifecycleToken);
    lifecycleToken = null;
  };
  lifecycleToken = captureLifecycle.begin(message.runtimeEpoch, message.runtimeGeneration, releaseRaw);
  if (!lifecycleToken) {
    releaseRaw();
    throw new Error("capture generation ended");
  }
  const requireActive = () => {
    if (!lifecycleToken || !captureLifecycle.active(lifecycleToken)) {
      throw new Error("capture generation ended");
    }
  };
  return runPreparedOcr({
    prepare: async () => {
      requireActive();
      if (typeof screenshotDataUrl !== "string"
        || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(screenshotDataUrl)
        || screenshotDataUrl.length > 50_000_000) throw new Error("invalid screenshot transport");
      sourceImage = new Image();
      const decodedImage = loadImageFromDataUrl(sourceImage, screenshotDataUrl);
      screenshotDataUrl = null;
      message.screenshotDataUrl = "";
      await decodedImage;
      requireActive();
      sourceCanvas = canvas(sourceImage.naturalWidth, sourceImage.naturalHeight);
      const context = sourceCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
      if (!context) throw new Error("canvas unavailable");
      context.drawImage(sourceImage, 0, 0);
      const decoded = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      screenshot = { width: decoded.width, height: decoded.height, pixels: decoded.data };
      const redacted = redactCommentCard({
        screenshot,
        viewport: message.viewport,
        cardBounds: message.cardBounds,
        avatarBounds: message.avatarBounds,
        visibleRegions: message.regions.map((region) => region.bounds)
      });
      redactedPixels = redacted.image.pixels;
      const bodyRegions = redacted.regionMappings.flatMap((mapping) => (
        message.regions[mapping.sourceIndex]?.kind === "body" ? [mapping.bounds] : []
      ));
      const metadataRegions = redacted.regionMappings.flatMap((mapping) => (
        message.regions[mapping.sourceIndex]?.kind === "metadata" ? [mapping.bounds] : []
      ));
      if (bodyRegions.length < 1) throw new Error("missing OCR body region");
      const ocrImage = restrictRasterToRegions(redacted.image, bodyRegions, metadataRegions);
      ocrPixels = ocrImage.pixels;
      releaseDecodedRaw();
      requireActive();
      const [bytes, ocrBytes] = await Promise.all([
        encodeWithinLimit(redacted.image, resources, requireActive),
        encodeWithinLimit(ocrImage, resources, requireActive)
      ]);
      if (!lifecycleToken || !captureLifecycle.active(lifecycleToken)) {
        throw new Error("capture generation ended");
      }
      resources.transfer(bytes);
      resources.transfer(ocrBytes);
      return {
        bytes,
        ocrBytes,
        width: redacted.image.width,
        height: redacted.image.height,
        bodyRegions,
        metadataRegions,
        redactionProof: redacted.redactionProof
      };
    },
    releaseRaw,
    recognize: async (prepared) => {
      const result = await ocr.recognize({
        mediaType: "image/webp",
        bytes: prepared.ocrBytes,
        width: prepared.width,
        height: prepared.height
      }, ["chi_sim", "eng"]);
      return {
        mediaType: "image/webp" as const,
        contentBase64: base64(prepared.bytes),
        width: prepared.width,
        height: prepared.height,
        redactionProof: prepared.redactionProof,
        ocrResult: filterOcrResultToBodyRegions(result, prepared.bodyRegions,
          prepared.metadataRegions)
      };
    },
    releasePrepared: (prepared) => {
      prepared.bytes.fill(0);
      prepared.ocrBytes.fill(0);
    }
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender: any,
  sendResponse: (value: unknown) => void) => {
  if (sender?.id !== chrome.runtime.id || !message || typeof message !== "object") return;
  const value = message as Record<string, unknown>;
  if (value.kind === "visual_ocr_sync_generation" && Object.keys(value).length === 3
    && typeof value.runtimeEpoch === "string"
    && Number.isSafeInteger(value.runtimeGeneration) && (value.runtimeGeneration as number) >= 0) {
    sendResponse({ accepted: captureLifecycle.synchronize(value.runtimeEpoch,
      value.runtimeGeneration as number) });
    return false;
  }
  if (value.kind === "visual_ocr_end_session" && Object.keys(value).length === 3
    && typeof value.runtimeEpoch === "string"
    && Number.isSafeInteger(value.runtimeGeneration) && (value.runtimeGeneration as number) >= 0) {
    if (!captureLifecycle.end(value.runtimeEpoch, value.runtimeGeneration as number)) {
      sendResponse({ accepted: false });
      return false;
    }
    void ocr.endSession().then(() => sendResponse({ accepted: true }),
      () => sendResponse({ accepted: false }));
    return true;
  }
  if (value.kind !== "visual_process_capture" || Object.keys(value).length !== 10
    || typeof value.runtimeEpoch !== "string"
    || !Number.isSafeInteger(value.runtimeGeneration)
    || (value.runtimeGeneration as number) < 0) return;
  void processCapture({ ...value, kind: "visual_capture_request" } as unknown as VisualCaptureRequest & {
    runtimeEpoch: string;
    runtimeGeneration: number;
    screenshotDataUrl: string;
  }).then((evidence) => sendResponse({ accepted: true, evidence }),
    () => sendResponse({ accepted: false }));
  return true;
});
