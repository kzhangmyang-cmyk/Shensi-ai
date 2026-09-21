export const BRIDGE_VERSION = "goodjob.visual-reader.bridge.v1" as const;
export const READER_VERSION = "goodjob-visual-reader/1.0.0" as const;

export interface VisualReaderLimits {
  maxVideos: number;
  maxCommentsPerVideo: number;
  maxScrolls: number;
  maxOcrCalls: number;
  maxDurationMs: number;
}

export type StableErrorCode =
  | "visual_reader_not_enabled"
  | "visual_reader_session_expired"
  | "visual_reader_budget_exhausted"
  | "visual_source_invalid"
  | "visual_observation_invalid"
  | "visual_artifact_invalid"
  | "visual_extraction_method_disabled"
  | "visual_extraction_low_confidence"
  | "visual_reader_user_takeover";

export interface VisualObservationSubmission {
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
  extractionMethod: "dom" | "accessibility" | "ocr";
  fieldConfidences: Record<string, number>;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: { x: number; y: number; width: number; height: number };
  readerVersion: string;
  capturedAt: string;
  redactedCrop: {
    mediaType: "image/webp";
    contentBase64: string;
    redactionProof: {
      version: "opaque-rect-v1";
      maskColorRgba: [17, 61, 51, 255];
      avatarBounds: { x: number; y: number; width: number; height: number } | null;
      visibleRegions: Array<{ x: number; y: number; width: number; height: number }>;
      maskedRegions: Array<{ x: number; y: number; width: number; height: number }>;
    };
  } | null;
}

export type PageCommand =
  | { version: typeof BRIDGE_VERSION; type: "probe"; channelNonce: string }
  | {
      version: typeof BRIDGE_VERSION;
      type: "start";
      channelNonce: string;
      sessionId: string;
      limits: VisualReaderLimits;
      artifactUploadEnabled: boolean;
    }
  | {
      version: typeof BRIDGE_VERSION;
      type: "acknowledge_batch";
      channelNonce: string;
      sessionId: string;
      batchId: string;
    }
  | {
      version: typeof BRIDGE_VERSION;
      type: "abort";
      channelNonce: string;
      sessionId: string;
    };

export type ExtensionEvent =
  | {
      version: typeof BRIDGE_VERSION;
      type: "ready";
      channelNonce: string;
      extensionVersion: string;
    }
  | {
      version: typeof BRIDGE_VERSION;
      type: "observation_batch";
      channelNonce: string;
      sessionId: string;
      batchId: string;
      observations: VisualObservationSubmission[];
    }
  | {
      version: typeof BRIDGE_VERSION;
      type: "terminal";
      channelNonce: string;
      sessionId: string;
      status: "completed" | "partial_success" | "aborted";
      errorCodes: StableErrorCode[];
    };

export interface VisualReaderAckMessage {
  kind: "visual_reader_ack";
  channelNonce: string;
  sessionId: string;
  batchId: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
const VERSION = /^(?=.{1,100}$)(?=.*\S)[^\u0000-\u001f\u007f]+$/u;
const SOURCE = /^https:\/\/www\.douyin\.com\/video\/([1-9][0-9]{0,31})\/?$/u;
const VIDEO_ID = /^[1-9][0-9]{0,31}$/u;
const SEC_UID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const PROFILE = /^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})\/?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ERROR_CODES = new Set<StableErrorCode>([
  "visual_reader_not_enabled", "visual_reader_session_expired",
  "visual_reader_budget_exhausted", "visual_source_invalid",
  "visual_observation_invalid", "visual_artifact_invalid",
  "visual_extraction_method_disabled", "visual_extraction_low_confidence",
  "visual_reader_user_takeover"
]);
const CONFIDENCE_KEYS = new Set([
  "visibleText", "displayName", "visibleTimeText", "likeCount", "replyCount",
  "platformCommentId", "publicProfileUrl", "secUid"
]);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function limits(value: unknown): value is VisualReaderLimits {
  return exact(value, ["maxVideos", "maxCommentsPerVideo", "maxScrolls", "maxOcrCalls", "maxDurationMs"])
    && integer(value.maxVideos, 1, 10)
    && integer(value.maxCommentsPerVideo, 1, 30)
    && integer(value.maxScrolls, 0, 5)
    && integer(value.maxOcrCalls, 0, 10)
    && integer(value.maxDurationMs, 1, 120_000);
}

function rect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return exact(value, ["x", "y", "width", "height"])
    && finite(value.x, 0, 8192) && finite(value.y, 0, 8192)
    && finite(value.width, Number.MIN_VALUE, 8192)
    && finite(value.height, Number.MIN_VALUE, 8192);
}

function nullableText(value: unknown, maximum = 255): value is string | null {
  return value === null || (typeof value === "string" && value.length >= 1
    && value.length <= maximum && /\S/u.test(value));
}

function integerRect(value: unknown): boolean {
  return exact(value, ["x", "y", "width", "height"])
    && integer(value.x, 0, 8192) && integer(value.y, 0, 8192)
    && integer(value.width, 1, 8192) && integer(value.height, 1, 8192);
}

function canonicalBase64(value: unknown): value is string {
  return typeof value === "string" && value.length >= 4 && value.length <= 349_528
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/u.test(value);
}

function redactedCrop(value: unknown): boolean {
  if (!exact(value, ["mediaType", "contentBase64", "redactionProof"])
    || value.mediaType !== "image/webp" || !canonicalBase64(value.contentBase64)
    || !exact(value.redactionProof, [
      "version", "maskColorRgba", "avatarBounds", "visibleRegions", "maskedRegions"
    ])) return false;
  const proof = value.redactionProof;
  return proof.version === "opaque-rect-v1"
    && Array.isArray(proof.maskColorRgba)
    && proof.maskColorRgba.length === 4
    && proof.maskColorRgba.every((channel, index) => channel === [17, 61, 51, 255][index])
    && (proof.avatarBounds === null || integerRect(proof.avatarBounds))
    && Array.isArray(proof.visibleRegions) && proof.visibleRegions.length >= 1
    && proof.visibleRegions.length <= 20 && proof.visibleRegions.every(integerRect)
    && Array.isArray(proof.maskedRegions) && proof.maskedRegions.length >= 1
    && proof.maskedRegions.length <= 100 && proof.maskedRegions.every(integerRect);
}

export function isObservation(value: unknown): value is VisualObservationSubmission {
  if (!exact(value, [
    "clientObservationKey", "sourceUrl", "videoId", "visibleText", "domTextHash", "ocrTextHash", "displayName",
    "visibleTimeText", "likeCount", "replyCount", "platformCommentId", "publicProfileUrl",
    "secUid", "extractionMethod", "fieldConfidences", "viewport", "cardBounds",
    "readerVersion", "capturedAt", "redactedCrop"
  ])) return false;
  const source = typeof value.sourceUrl === "string" ? SOURCE.exec(value.sourceUrl) : null;
  const confidences = record(value.fieldConfidences) ? value.fieldConfidences : null;
  if (!source || source[1] !== value.videoId || typeof value.visibleText !== "string"
    || value.visibleText.length < 1 || value.visibleText.length > 2_000 || !/\S/u.test(value.visibleText)
    || !(value.domTextHash === null || (typeof value.domTextHash === "string" && DIGEST.test(value.domTextHash)))
    || !(value.ocrTextHash === null || (typeof value.ocrTextHash === "string" && DIGEST.test(value.ocrTextHash)))
    || typeof value.clientObservationKey !== "string" || !IDENTIFIER.test(value.clientObservationKey)
    || !nullableText(value.displayName) || !nullableText(value.visibleTimeText)
    || !(value.likeCount === null || integer(value.likeCount, 0, 2_147_483_647))
    || !(value.replyCount === null || integer(value.replyCount, 0, 2_147_483_647))
    || !(value.platformCommentId === null
      || (typeof value.platformCommentId === "string" && VIDEO_ID.test(value.platformCommentId)))
    || !(value.publicProfileUrl === null || (typeof value.publicProfileUrl === "string" && PROFILE.test(value.publicProfileUrl)))
    || !(value.secUid === null || (typeof value.secUid === "string" && SEC_UID.test(value.secUid)))
    || !["dom", "accessibility", "ocr"].includes(String(value.extractionMethod))
    || confidences === null
    || Object.keys(confidences).some((key) => !CONFIDENCE_KEYS.has(key)
      || !finite(confidences[key], 0, 1))
    || !exact(value.viewport, ["width", "height", "deviceScaleFactor"])
    || !integer(value.viewport.width, 1, 8192)
    || !integer(value.viewport.height, 1, 8192)
    || !finite(value.viewport.deviceScaleFactor, 0.5, 8)
    || !rect(value.cardBounds)
    || typeof value.readerVersion !== "string" || !VERSION.test(value.readerVersion)
    || typeof value.capturedAt !== "string" || value.capturedAt.length > 64
    || !Number.isFinite(Date.parse(value.capturedAt))
    || !(value.redactedCrop === null || redactedCrop(value.redactedCrop))) return false;
  if (!Object.prototype.hasOwnProperty.call(confidences, "visibleText")) return false;
  if ((value.extractionMethod === "dom" || value.extractionMethod === "accessibility")
    && value.domTextHash === null) return false;
  if (value.extractionMethod === "ocr"
    && (value.ocrTextHash === null || value.platformCommentId !== null || value.publicProfileUrl !== null
      || value.secUid !== null || value.redactedCrop === null)) return false;
  if (value.extractionMethod !== "ocr" && value.redactedCrop !== null) return false;
  if (value.publicProfileUrl !== null && value.secUid !== null
    && PROFILE.exec(value.publicProfileUrl)?.[1] !== value.secUid) return false;
  return true;
}

export function parseVisualReaderAck(value: unknown): VisualReaderAckMessage | null {
  return exact(value, ["kind", "channelNonce", "sessionId", "batchId"])
    && value.kind === "visual_reader_ack"
    && typeof value.channelNonce === "string" && NONCE.test(value.channelNonce)
    && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
    && typeof value.batchId === "string" && IDENTIFIER.test(value.batchId)
    ? value as unknown as VisualReaderAckMessage : null;
}

export function parsePageCommand(value: unknown, expectedOrigin: string): PageCommand | null {
  if (!record(value) || value.version !== BRIDGE_VERSION || typeof value.type !== "string"
    || typeof value.channelNonce !== "string" || !NONCE.test(value.channelNonce)
    || !/^https?:\/\/[^/]+$/u.test(expectedOrigin)) return null;
  if (value.type === "probe") {
    return exact(value, ["version", "type", "channelNonce"]) ? value as PageCommand : null;
  }
  if (value.type === "start") {
    return exact(value, ["version", "type", "channelNonce", "sessionId", "limits", "artifactUploadEnabled"])
      && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
      && limits(value.limits) && typeof value.artifactUploadEnabled === "boolean"
      ? value as PageCommand : null;
  }
  if (value.type === "acknowledge_batch") {
    return exact(value, ["version", "type", "channelNonce", "sessionId", "batchId"])
      && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
      && typeof value.batchId === "string" && IDENTIFIER.test(value.batchId)
      ? value as PageCommand : null;
  }
  if (value.type === "abort") {
    return exact(value, ["version", "type", "channelNonce", "sessionId"])
      && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
      ? value as PageCommand : null;
  }
  return null;
}

export function parseExtensionEvent(value: unknown): ExtensionEvent | null {
  if (!record(value) || value.version !== BRIDGE_VERSION || typeof value.type !== "string"
    || typeof value.channelNonce !== "string" || !NONCE.test(value.channelNonce)) return null;
  if (value.type === "ready") {
    return exact(value, ["version", "type", "channelNonce", "extensionVersion"])
      && typeof value.extensionVersion === "string" && VERSION.test(value.extensionVersion)
      ? value as ExtensionEvent : null;
  }
  if (value.type === "observation_batch") {
    return exact(value, ["version", "type", "channelNonce", "sessionId", "batchId", "observations"])
      && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
      && typeof value.batchId === "string" && IDENTIFIER.test(value.batchId)
      && Array.isArray(value.observations) && value.observations.length >= 1
      && value.observations.length <= 20 && value.observations.every(isObservation)
      ? value as ExtensionEvent : null;
  }
  if (value.type === "terminal") {
    return exact(value, ["version", "type", "channelNonce", "sessionId", "status", "errorCodes"])
      && typeof value.sessionId === "string" && IDENTIFIER.test(value.sessionId)
      && ["completed", "partial_success", "aborted"].includes(String(value.status))
      && Array.isArray(value.errorCodes) && value.errorCodes.length <= 9
      && new Set(value.errorCodes).size === value.errorCodes.length
      && value.errorCodes.every((code) => ERROR_CODES.has(code as StableErrorCode))
      ? value as ExtensionEvent : null;
  }
  return null;
}

export function canonicalDouyinVideoUrl(value: string): { sourceUrl: string; videoId: string } | null {
  const match = SOURCE.exec(value);
  if (!match) return null;
  return { sourceUrl: `https://www.douyin.com/video/${match[1]}`, videoId: match[1] };
}
