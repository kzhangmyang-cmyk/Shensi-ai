import type { VisualOcrResult } from "./ocr-port";
import type { OpaqueRectRedactionProofV1, PixelRect } from "./visual-pipeline";
import type { VisualCaptureRequest } from "./visual-capture-guard";

export interface VisualCaptureEvidence {
  mediaType: "image/webp";
  contentBase64: string;
  width: number;
  height: number;
  redactionProof: OpaqueRectRedactionProofV1;
  ocrResult: VisualOcrResult;
}

export interface VisualCaptureOwner {
  generation: number;
  sessionId: string;
  tabId: number;
  windowId: number;
}

export interface VisualCaptureAuthorization {
  request: VisualCaptureRequest;
  owner: VisualCaptureOwner;
}

export interface VisualCapturedScreenshot {
  readonly dataUrl: string;
  clear(): void;
}

export type VisualProcessCaptureMessage = Omit<VisualCaptureRequest, "kind"> & {
  kind: "visual_process_capture";
  runtimeEpoch: string;
  runtimeGeneration: number;
  screenshotDataUrl: string;
};

export interface VisualCaptureRuntimeDependencies {
  runtimeEpoch: string;
  authorize(request: unknown, senderTabId: number | null,
    expectedOwner: VisualCaptureOwner | null): Promise<VisualCaptureAuthorization | null>;
  ensureOffscreen(runtimeGeneration: number): Promise<void>;
  reserveOcrCall(request: VisualCaptureRequest): Promise<boolean>;
  captureVisibleTab(request: VisualCaptureRequest,
    owner: VisualCaptureOwner): Promise<VisualCapturedScreenshot>;
  processOffscreen(message: VisualProcessCaptureMessage): Promise<unknown>;
  validateEvidence(value: unknown, request: VisualCaptureRequest): Promise<VisualCaptureEvidence | null>;
  endOffscreenSession(endingGeneration: number): Promise<boolean>;
}

function sameOwner(left: VisualCaptureOwner, right: VisualCaptureOwner): boolean {
  return left.generation === right.generation && left.sessionId === right.sessionId
    && left.tabId === right.tabId && left.windowId === right.windowId;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function rect(value: unknown, width: number, height: number): value is PixelRect {
  return exact(value, ["x", "y", "width", "height"])
    && integer(value.x, 0, width - 1) && integer(value.y, 0, height - 1)
    && integer(value.width, 1, width) && integer(value.height, 1, height)
    && (value.x as number) + (value.width as number) <= width
    && (value.y as number) + (value.height as number) <= height;
}

function canonicalWebpBase64(value: unknown): value is string {
  if (!(typeof value === "string" && value.length >= 16 && value.length <= 349_528
    && value.startsWith("UklGR") && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/u.test(value)
    && Math.floor(value.length * 3 / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
      <= 262_144)) return false;
  try {
    const decoded = atob(value);
    if (decoded.length < 12 || decoded.slice(0, 4) !== "RIFF" || decoded.slice(8, 12) !== "WEBP") {
      return false;
    }
    const declared = decoded.charCodeAt(4) | (decoded.charCodeAt(5) << 8)
      | (decoded.charCodeAt(6) << 16) | (decoded.charCodeAt(7) << 24);
    return (declared >>> 0) + 8 === decoded.length;
  } catch {
    return false;
  }
}

function ocrResult(value: unknown, width: number, height: number): value is VisualOcrResult {
  if (!exact(value, ["text", "confidence", "words"])
    || typeof value.text !== "string" || value.text.length > 2_000
    || !finite(value.confidence, 0, 1) || !Array.isArray(value.words)
    || value.words.length > 500) return false;
  return value.words.every((word) => exact(word, ["text", "confidence", "bounds"])
    && typeof word.text === "string" && word.text.length >= 1 && word.text.length <= 200
    && finite(word.confidence, 0, 1) && rect(word.bounds, width, height));
}

export function parseVisualCaptureEvidence(value: unknown): VisualCaptureEvidence | null {
  if (!exact(value, [
    "mediaType", "contentBase64", "width", "height", "redactionProof", "ocrResult"
  ]) || value.mediaType !== "image/webp" || !canonicalWebpBase64(value.contentBase64)
    || !integer(value.width, 1, 8_192) || !integer(value.height, 1, 8_192)
    || (value.width as number) * (value.height as number) > 1_000_000
    || !exact(value.redactionProof, [
      "version", "maskColorRgba", "avatarBounds", "visibleRegions", "maskedRegions"
    ])) return null;
  const width = value.width as number;
  const height = value.height as number;
  const proof = value.redactionProof;
  if (proof.version !== "opaque-rect-v1" || !Array.isArray(proof.maskColorRgba)
    || proof.maskColorRgba.length !== 4
    || proof.maskColorRgba.some((channel, index) => channel !== [17, 61, 51, 255][index])
    || !(proof.avatarBounds === null || rect(proof.avatarBounds, width, height))
    || !Array.isArray(proof.visibleRegions) || proof.visibleRegions.length < 1
    || proof.visibleRegions.length > 20
    || !proof.visibleRegions.every((region) => rect(region, width, height))
    || !Array.isArray(proof.maskedRegions) || proof.maskedRegions.length < 1
    || proof.maskedRegions.length > 100
    || !proof.maskedRegions.every((region) => rect(region, width, height))
    || !ocrResult(value.ocrResult, width, height)) return null;
  let visiblePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (proof.visibleRegions.some((region) => x >= region.x && y >= region.y
        && x < region.x + region.width && y < region.y + region.height)) visiblePixels += 1;
    }
  }
  if (visiblePixels / (width * height) > 0.8) return null;
  return value as unknown as VisualCaptureEvidence;
}

export function createVisualCaptureRuntime(dependencies: VisualCaptureRuntimeDependencies): {
  handle(request: unknown, senderTabId: number | null): Promise<
    { accepted: true; evidence: VisualCaptureEvidence } | { accepted: false }
  >;
  endSession(): Promise<boolean>;
} {
  let runtimeGeneration = 0;
  interface GenerationState {
    generation: number;
    queue: Promise<void>;
    screenshots: Set<VisualCapturedScreenshot>;
  }
  let currentGeneration: GenerationState = {
    generation: runtimeGeneration,
    queue: Promise.resolve(),
    screenshots: new Set()
  };

  function releaseScreenshot(state: GenerationState, screenshot: VisualCapturedScreenshot): void {
    if (!state.screenshots.delete(screenshot)) return;
    try { screenshot.clear(); } catch { /* continue invalidating the generation */ }
  }

  async function run(request: unknown, senderTabId: number | null, state: GenerationState): Promise<
    { accepted: true; evidence: VisualCaptureEvidence } | { accepted: false }
  > {
    const expectedGeneration = state.generation;
    let screenshot: VisualCapturedScreenshot | null = null;
    try {
      const initial = await dependencies.authorize(request, senderTabId, null);
      if (!initial || runtimeGeneration !== expectedGeneration) return { accepted: false };
      const owner = initial.owner;
      await dependencies.ensureOffscreen(expectedGeneration);
      const reserved = await dependencies.authorize(request, senderTabId, owner);
      if (!reserved || !sameOwner(owner, reserved.owner) || runtimeGeneration !== expectedGeneration
        || !await dependencies.reserveOcrCall(reserved.request)) return { accepted: false };
      const authorizedForCapture = await dependencies.authorize(request, senderTabId, owner);
      if (!authorizedForCapture || !sameOwner(owner, authorizedForCapture.owner)
        || runtimeGeneration !== expectedGeneration) return { accepted: false };
      screenshot = await dependencies.captureVisibleTab(authorizedForCapture.request, owner);
      state.screenshots.add(screenshot);
      if (runtimeGeneration !== expectedGeneration
        || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(screenshot.dataUrl)
        || screenshot.dataUrl.length > 50_000_000) return { accepted: false };
      const authorizedForOffscreen = await dependencies.authorize(request, senderTabId, owner);
      if (!authorizedForOffscreen || !sameOwner(owner, authorizedForOffscreen.owner)
        || runtimeGeneration !== expectedGeneration) return { accepted: false };
      const processMessage: VisualProcessCaptureMessage = {
        ...authorizedForOffscreen.request,
        kind: "visual_process_capture",
        runtimeEpoch: dependencies.runtimeEpoch,
        runtimeGeneration: expectedGeneration,
        screenshotDataUrl: screenshot.dataUrl
      };
      let processing: Promise<unknown>;
      try {
        processing = dependencies.processOffscreen(processMessage);
      } finally {
        processMessage.screenshotDataUrl = "";
      }
      releaseScreenshot(state, screenshot);
      screenshot = null;
      const response = await processing;
      const authorizedForRelease = await dependencies.authorize(request, senderTabId, owner);
      if (!authorizedForRelease || !sameOwner(owner, authorizedForRelease.owner)
        || runtimeGeneration !== expectedGeneration) return { accepted: false };
      if (!exact(response, ["accepted", "evidence"]) || response.accepted !== true) {
        return { accepted: false };
      }
      const evidence = await dependencies.validateEvidence(response.evidence,
        authorizedForRelease.request);
      if (!evidence || runtimeGeneration !== expectedGeneration) return { accepted: false };
      const authorizedAfterValidation = await dependencies.authorize(request, senderTabId, owner);
      return authorizedAfterValidation && sameOwner(owner, authorizedAfterValidation.owner)
        && runtimeGeneration === expectedGeneration
        ? { accepted: true, evidence }
        : { accepted: false };
    } catch {
      return { accepted: false };
    } finally {
      if (screenshot) releaseScreenshot(state, screenshot);
      screenshot = null;
    }
  }

  return {
    handle(request, senderTabId) {
      const state = currentGeneration;
      const result = state.queue.then(() => run(request, senderTabId, state));
      state.queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async endSession() {
      const endingState = currentGeneration;
      const endingGeneration = endingState.generation;
      runtimeGeneration += 1;
      currentGeneration = {
        generation: runtimeGeneration,
        queue: Promise.resolve(),
        screenshots: new Set()
      };
      for (const screenshot of [...endingState.screenshots]) {
        releaseScreenshot(endingState, screenshot);
      }
      return dependencies.endOffscreenSession(endingGeneration).catch(() => false);
    }
  };
}
