import { csrfFromCookie } from "./csrf";

export type VisualExtractionMethod = "dom" | "accessibility" | "ocr" | "vision";
export type VisualReaderSessionStatus =
  | "created"
  | "collecting"
  | "completed"
  | "partial_success"
  | "aborted"
  | "expired";
export type VisualReaderStableErrorCode =
  | "visual_reader_not_enabled"
  | "visual_reader_session_expired"
  | "visual_reader_budget_exhausted"
  | "visual_source_invalid"
  | "visual_observation_invalid"
  | "visual_artifact_invalid"
  | "visual_extraction_method_disabled"
  | "visual_extraction_low_confidence"
  | "visual_reader_user_takeover";

export interface VisualReaderLimits {
  maxVideos: number;
  maxCommentsPerVideo: number;
  maxScrolls: number;
  maxOcrCalls: number;
  maxDurationMs: number;
}

export interface VisualReaderUsage {
  videoCount: number;
  observationCount: number;
  scrollCount: number;
  ocrCallCount: number;
  domObservationCount: number;
  accessibilityObservationCount: number;
  ocrObservationCount: number;
  lowConfidenceObservationCount: number;
  artifactCount: number;
}

export interface VisualReaderOutcome extends Omit<VisualReaderUsage, "scrollCount" | "ocrCallCount"> {
  status: "completed" | "partial_success" | "aborted" | "expired";
  errorCodes: VisualReaderStableErrorCode[];
}

export interface VisualReaderSession {
  sessionId: string;
  runId: string;
  planId: string;
  planVersionId: string;
  platform: "douyin";
  coverage: "authorized_visible_top_level_sample";
  status: VisualReaderSessionStatus;
  artifactUploadEnabled: boolean;
  limits: VisualReaderLimits;
  usage: VisualReaderUsage;
  outcome: VisualReaderOutcome | null;
  lastErrorCode: VisualReaderStableErrorCode | null;
  createdAt: string;
  authorizedAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface VisualPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualRedactedCrop {
  mediaType: "image/webp";
  contentBase64: string;
  redactionProof: {
    version: "opaque-rect-v1";
    maskColorRgba: [17, 61, 51, 255];
    avatarBounds: VisualPixelRect | null;
    visibleRegions: VisualPixelRect[];
    maskedRegions: VisualPixelRect[];
  };
}

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
  extractionMethod: VisualExtractionMethod;
  fieldConfidences: Record<string, number>;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: VisualPixelRect;
  readerVersion: string;
  capturedAt: string;
  redactedCrop: VisualRedactedCrop | null;
}

export interface DouyinVisualCommentObservation {
  observationId: string;
  sessionId: string;
  sourceUrl: string;
  videoId: string;
  visibleText: string;
  textHash: string;
  domTextHash: string | null;
  ocrTextHash: string | null;
  displayName: string | null;
  visibleTimeText: string | null;
  likeCount: number | null;
  replyCount: number | null;
  platformCommentId: string | null;
  publicProfileUrl: string | null;
  secUid: string | null;
  extractionMethod: VisualExtractionMethod;
  fieldConfidences: Record<string, number>;
  viewportHash: string;
  cardBounds: VisualPixelRect;
  redactedCropHash: string | null;
  readerVersion: string;
  capturedAt: string;
}

export interface VisualObservationBatchResponse {
  session: VisualReaderSession;
  accepted: Array<{
    clientObservationKey: string;
    observation: DouyinVisualCommentObservation;
  }>;
  duplicates: string[];
}

export interface VisualReaderApi {
  createSession(
    input: { runId: string; artifactUploadEnabled: boolean },
    idempotencyKey: string
  ): Promise<VisualReaderSession>;
  getSession(sessionId: string): Promise<VisualReaderSession>;
  appendObservationBatch(
    sessionId: string,
    input: { observations: VisualObservationSubmission[] },
    idempotencyKey: string
  ): Promise<VisualObservationBatchResponse>;
  completeSession(
    sessionId: string,
    input: {
      status: "completed" | "partial_success";
      errorCodes: VisualReaderStableErrorCode[];
    },
    idempotencyKey: string
  ): Promise<VisualReaderSession>;
  abortSession(
    sessionId: string,
    input: { reasonCode: "user_requested" | "visual_reader_user_takeover" },
    idempotencyKey: string
  ): Promise<VisualReaderSession>;
  getArtifact(artifactId: string): Promise<{
    mediaType: "image/webp";
    content: ArrayBuffer;
  }>;
}

export interface VisualReaderApiOptions {
  cookie?: string;
  cookieSource?: () => string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const VIDEO_ID = /^[1-9][0-9]{0,31}$/u;
const PROFILE_URL = /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}\/?$/u;
const SOURCE_URL = /^https:\/\/www\.douyin\.com\/video\/([1-9][0-9]{0,31})\/?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FIELD_CONFIDENCE_KEYS = new Set([
  "visibleText",
  "displayName",
  "visibleTimeText",
  "likeCount",
  "replyCount",
  "platformCommentId",
  "publicProfileUrl",
  "secUid"
]);
const STABLE_ERROR_CODES = new Set<VisualReaderStableErrorCode>([
  "visual_reader_not_enabled",
  "visual_reader_session_expired",
  "visual_reader_budget_exhausted",
  "visual_source_invalid",
  "visual_observation_invalid",
  "visual_artifact_invalid",
  "visual_extraction_method_disabled",
  "visual_extraction_low_confidence",
  "visual_reader_user_takeover"
]);
const SAFE_ERROR_MESSAGES: Readonly<Record<VisualReaderStableErrorCode, string>> = {
  visual_reader_not_enabled: "当前运行未启用授权视觉读取",
  visual_reader_session_expired: "视觉读取会话已过期，请重新授权",
  visual_reader_budget_exhausted: "视觉读取会话已达到服务端限额",
  visual_source_invalid: "当前页面不是可读取的抖音视频页面",
  visual_observation_invalid: "视觉读取数据未通过安全校验",
  visual_artifact_invalid: "遮挡后的评论卡裁剪未通过安全校验",
  visual_extraction_method_disabled: "当前提取方式未获授权",
  visual_extraction_low_confidence: "可见文字置信度不足，已安全停止",
  visual_reader_user_takeover: "用户已接管页面，视觉读取已停止"
};

export class VisualReaderApiError extends Error {
  constructor(
    readonly code: VisualReaderStableErrorCode | "visual_reader_request_failed",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "VisualReaderApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function nullableText(value: unknown, maximum = 255): value is string | null {
  return value === null
    || (typeof value === "string" && value.length >= 1 && value.length <= maximum && /\S/u.test(value));
}

function dateTime(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value;
}

function idempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("幂等键格式无效");
  }
  return normalized;
}

function parseErrorCode(value: unknown): VisualReaderStableErrorCode | null {
  return typeof value === "string" && STABLE_ERROR_CODES.has(value as VisualReaderStableErrorCode)
    ? value as VisualReaderStableErrorCode
    : null;
}

function validStableErrorCodes(value: unknown): value is VisualReaderStableErrorCode[] {
  return Array.isArray(value)
    && value.length <= 9
    && new Set(value).size === value.length
    && value.every((item) => parseErrorCode(item) !== null);
}

function validLimits(value: unknown): value is VisualReaderLimits {
  return exactKeys(value, [
    "maxVideos", "maxCommentsPerVideo", "maxScrolls", "maxOcrCalls", "maxDurationMs"
  ])
    && integer(value.maxVideos, 1, 10)
    && integer(value.maxCommentsPerVideo, 1, 30)
    && integer(value.maxScrolls, 0, 5)
    && integer(value.maxOcrCalls, 0, 10)
    && integer(value.maxDurationMs, 1, 120_000);
}

function validUsage(value: unknown): value is VisualReaderUsage {
  return exactKeys(value, [
    "videoCount", "observationCount", "scrollCount", "ocrCallCount",
    "domObservationCount", "accessibilityObservationCount", "ocrObservationCount",
    "lowConfidenceObservationCount", "artifactCount"
  ])
    && integer(value.videoCount, 0, 10)
    && integer(value.observationCount, 0, 300)
    && integer(value.scrollCount, 0, 5)
    && integer(value.ocrCallCount, 0, 10)
    && integer(value.domObservationCount, 0, 300)
    && integer(value.accessibilityObservationCount, 0, 300)
    && integer(value.ocrObservationCount, 0, 300)
    && integer(value.lowConfidenceObservationCount, 0, 300)
    && integer(value.artifactCount, 0, 300);
}

function validOutcome(value: unknown): value is VisualReaderOutcome {
  return exactKeys(value, [
    "status", "videoCount", "observationCount", "domObservationCount",
    "accessibilityObservationCount", "ocrObservationCount",
    "lowConfidenceObservationCount", "artifactCount", "errorCodes"
  ])
    && ["completed", "partial_success", "aborted", "expired"].includes(String(value.status))
    && integer(value.videoCount, 0, 10)
    && integer(value.observationCount, 0, 300)
    && integer(value.domObservationCount, 0, 300)
    && integer(value.accessibilityObservationCount, 0, 300)
    && integer(value.ocrObservationCount, 0, 300)
    && integer(value.lowConfidenceObservationCount, 0, 300)
    && integer(value.artifactCount, 0, 300)
    && validStableErrorCodes(value.errorCodes);
}

export function parseVisualReaderSession(value: unknown): VisualReaderSession {
  const required = [
    "sessionId", "runId", "planId", "planVersionId", "platform", "coverage",
    "status", "artifactUploadEnabled", "limits", "usage", "outcome",
    "lastErrorCode", "createdAt", "authorizedAt", "updatedAt", "expiresAt",
    "completedAt"
  ] as const;
  const terminal = new Set(["completed", "partial_success", "aborted", "expired"]);
  if (!exactKeys(value, required)
    || typeof value.sessionId !== "string" || !IDENTIFIER.test(value.sessionId)
    || typeof value.runId !== "string" || !IDENTIFIER.test(value.runId)
    || typeof value.planId !== "string" || !IDENTIFIER.test(value.planId)
    || typeof value.planVersionId !== "string" || !IDENTIFIER.test(value.planVersionId)
    || value.platform !== "douyin"
    || value.coverage !== "authorized_visible_top_level_sample"
    || !["created", "collecting", ...terminal].includes(String(value.status))
    || typeof value.artifactUploadEnabled !== "boolean"
    || !validLimits(value.limits)
    || !validUsage(value.usage)
    || !(value.lastErrorCode === null || parseErrorCode(value.lastErrorCode))
    || !dateTime(value.createdAt)
    || !dateTime(value.authorizedAt)
    || !dateTime(value.updatedAt)
    || !dateTime(value.expiresAt)) {
    throw new Error("服务端返回了无效的视觉读取会话");
  }
  const isTerminal = terminal.has(String(value.status));
  if ((isTerminal && (!validOutcome(value.outcome)
      || value.outcome.status !== value.status
      || !dateTime(value.completedAt)))
    || (!isTerminal && (value.outcome !== null || value.completedAt !== null))) {
    throw new Error("服务端返回了无效的视觉读取会话");
  }
  return value as unknown as VisualReaderSession;
}

function validRect(value: unknown, integerOnly = false): value is VisualPixelRect {
  if (!exactKeys(value, ["x", "y", "width", "height"])) return false;
  const check = integerOnly ? integer : finite;
  return check(value.x, 0, 8192)
    && check(value.y, 0, 8192)
    && check(value.width, Number.MIN_VALUE, 8192)
    && check(value.height, Number.MIN_VALUE, 8192);
}

function validBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 349_528 || value.length % 4 !== 0) {
    return false;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/u.test(value);
}

function rectCoveredByUnion(target: VisualPixelRect, masks: VisualPixelRect[]): boolean {
  const targetRight = target.x + target.width;
  const targetBottom = target.y + target.height;
  const xEdges = new Set([target.x, targetRight]);
  for (const mask of masks) {
    const left = Math.max(target.x, mask.x);
    const right = Math.min(targetRight, mask.x + mask.width);
    if (left < right) {
      xEdges.add(left);
      xEdges.add(right);
    }
  }
  const sortedX = [...xEdges].sort((left, right) => left - right);
  for (let index = 0; index < sortedX.length - 1; index += 1) {
    const left = sortedX[index];
    const right = sortedX[index + 1];
    if (left === undefined || right === undefined || left >= right) continue;
    const yIntervals = masks
      .filter((mask) => mask.x <= left && mask.x + mask.width >= right)
      .map((mask) => [
        Math.max(target.y, mask.y),
        Math.min(targetBottom, mask.y + mask.height)
      ] as const)
      .filter(([top, bottom]) => top < bottom)
      .sort(([leftTop], [rightTop]) => leftTop - rightTop);
    let coveredTo = target.y;
    for (const [top, bottom] of yIntervals) {
      if (top > coveredTo) break;
      coveredTo = Math.max(coveredTo, bottom);
      if (coveredTo >= targetBottom) break;
    }
    if (coveredTo < targetBottom) return false;
  }
  return true;
}

function validRedactedCrop(value: unknown): value is VisualRedactedCrop {
  if (!exactKeys(value, ["mediaType", "contentBase64", "redactionProof"])
    || value.mediaType !== "image/webp"
    || !validBase64(value.contentBase64)
    || !exactKeys(value.redactionProof, [
      "version", "maskColorRgba", "avatarBounds", "visibleRegions", "maskedRegions"
    ])) return false;
  const proof = value.redactionProof;
  if (proof.version !== "opaque-rect-v1"
    || !Array.isArray(proof.maskColorRgba)
    || proof.maskColorRgba.length !== 4
    || !proof.maskColorRgba.every((item, index) => item === [17, 61, 51, 255][index])
    || !Array.isArray(proof.visibleRegions)
    || proof.visibleRegions.length < 1
    || proof.visibleRegions.length > 20
    || !proof.visibleRegions.every((rect) => validRect(rect, true))
    || !Array.isArray(proof.maskedRegions)
    || proof.maskedRegions.length < 1
    || proof.maskedRegions.length > 100) return false;
  const maskedRegions = proof.maskedRegions.filter(
    (rect): rect is VisualPixelRect => validRect(rect, true)
  );
  if (maskedRegions.length !== proof.maskedRegions.length) return false;
  if (proof.avatarBounds === null) return true;
  return validRect(proof.avatarBounds, true)
    && rectCoveredByUnion(proof.avatarBounds, maskedRegions);
}

export function isVisualObservationSubmission(
  value: unknown,
  allowVision = true
): value is VisualObservationSubmission {
  const required = [
    "clientObservationKey", "sourceUrl", "videoId", "visibleText", "domTextHash", "ocrTextHash", "displayName",
    "visibleTimeText", "likeCount", "replyCount", "platformCommentId",
    "publicProfileUrl", "secUid", "extractionMethod", "fieldConfidences",
    "viewport", "cardBounds", "readerVersion", "capturedAt", "redactedCrop"
  ] as const;
  if (!exactKeys(value, required)
    || typeof value.clientObservationKey !== "string" || !IDENTIFIER.test(value.clientObservationKey)
    || typeof value.sourceUrl !== "string"
    || typeof value.videoId !== "string" || !VIDEO_ID.test(value.videoId)
    || typeof value.visibleText !== "string" || value.visibleText.length < 1
    || value.visibleText.length > 2_000 || !/\S/u.test(value.visibleText)
    || !(value.domTextHash === null
      || (typeof value.domTextHash === "string" && DIGEST.test(value.domTextHash)))
    || !(value.ocrTextHash === null
      || (typeof value.ocrTextHash === "string" && DIGEST.test(value.ocrTextHash)))
    || !nullableText(value.displayName)
    || !nullableText(value.visibleTimeText)
    || !(value.likeCount === null || integer(value.likeCount, 0, 2_147_483_647))
    || !(value.replyCount === null || integer(value.replyCount, 0, 2_147_483_647))
    || !(value.platformCommentId === null
      || (typeof value.platformCommentId === "string" && VIDEO_ID.test(value.platformCommentId)))
    || !(value.publicProfileUrl === null
      || (typeof value.publicProfileUrl === "string" && PROFILE_URL.test(value.publicProfileUrl)))
    || !(value.secUid === null
      || (typeof value.secUid === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.secUid)))
    || !["dom", "accessibility", "ocr", ...(allowVision ? ["vision"] : [])].includes(String(value.extractionMethod))
    || !exactKeys(value.viewport, ["width", "height", "deviceScaleFactor"])
    || !integer(value.viewport.width, 1, 8192)
    || !integer(value.viewport.height, 1, 8192)
    || !finite(value.viewport.deviceScaleFactor, 0.5, 8)
    || !validRect(value.cardBounds)
    || typeof value.readerVersion !== "string" || value.readerVersion.length < 1
    || value.readerVersion.length > 100 || !/\S/u.test(value.readerVersion)
    || !dateTime(value.capturedAt)
    || !(value.redactedCrop === null || validRedactedCrop(value.redactedCrop))) return false;
  const sourceVideo = SOURCE_URL.exec(value.sourceUrl)?.[1];
  if (sourceVideo !== value.videoId || !isRecord(value.fieldConfidences)) return false;
  const fieldConfidences = value.fieldConfidences as Record<string, unknown>;
  const confidenceKeys = Object.keys(fieldConfidences);
  if (!confidenceKeys.includes("visibleText")
    || confidenceKeys.some((key) => !FIELD_CONFIDENCE_KEYS.has(key))
    || confidenceKeys.some((key) => !finite(fieldConfidences[key], 0, 1))) return false;
  if ((value.extractionMethod === "dom" || value.extractionMethod === "accessibility")
    && value.domTextHash === null) return false;
  if (value.extractionMethod === "ocr"
    && (value.ocrTextHash === null || value.platformCommentId !== null || value.publicProfileUrl !== null
      || value.secUid !== null || value.redactedCrop === null)) return false;
  if (value.publicProfileUrl !== null && value.secUid !== null) {
    const profileKey = value.publicProfileUrl.match(/\/user\/([^/]+)\/?$/u)?.[1];
    if (profileKey !== value.secUid) return false;
  }
  return true;
}

export function parseVisualObservationBatch(
  value: unknown,
  expectedSessionId: string
): VisualObservationBatchResponse {
  if (!exactKeys(value, ["session", "accepted", "duplicates"])) {
    throw new Error("服务端返回了无效的视觉观察批次");
  }
  const parsedSession = parseVisualReaderSession(value.session);
  if (parsedSession.sessionId !== expectedSessionId
    || !Array.isArray(value.accepted) || value.accepted.length > 20
    || !Array.isArray(value.duplicates) || value.duplicates.length > 20
    || new Set(value.duplicates).size !== value.duplicates.length
    || value.duplicates.some((key) => typeof key !== "string" || !IDENTIFIER.test(key))) {
    throw new Error("服务端返回了无效的视觉观察批次");
  }
  for (const accepted of value.accepted) {
    if (!exactKeys(accepted, ["clientObservationKey", "observation"])
      || typeof accepted.clientObservationKey !== "string"
      || !IDENTIFIER.test(accepted.clientObservationKey)
      || !validNormalizedObservation(accepted.observation, expectedSessionId)) {
      throw new Error("服务端返回了无效的视觉观察批次");
    }
  }
  return value as unknown as VisualObservationBatchResponse;
}

function validNormalizedObservation(value: unknown, sessionId: string): value is DouyinVisualCommentObservation {
  const required = [
    "observationId", "sessionId", "sourceUrl", "videoId", "visibleText", "textHash", "domTextHash", "ocrTextHash",
    "displayName", "visibleTimeText", "likeCount", "replyCount", "platformCommentId",
    "publicProfileUrl", "secUid", "extractionMethod", "fieldConfidences", "viewportHash",
    "cardBounds", "redactedCropHash", "readerVersion", "capturedAt"
  ] as const;
  if (!exactKeys(value, required)) return false;
  const submission = {
    clientObservationKey: "server-normalized",
    sourceUrl: value.sourceUrl,
    videoId: value.videoId,
    visibleText: value.visibleText,
    domTextHash: value.domTextHash,
    ocrTextHash: value.ocrTextHash,
    displayName: value.displayName,
    visibleTimeText: value.visibleTimeText,
    likeCount: value.likeCount,
    replyCount: value.replyCount,
    platformCommentId: value.platformCommentId,
    publicProfileUrl: value.publicProfileUrl,
    secUid: value.secUid,
    extractionMethod: value.extractionMethod,
    fieldConfidences: value.fieldConfidences,
    viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
    cardBounds: value.cardBounds,
    readerVersion: value.readerVersion,
    capturedAt: value.capturedAt,
    redactedCrop: value.extractionMethod === "ocr" ? {
      mediaType: "image/webp",
      contentBase64: "AAAA",
      redactionProof: {
        version: "opaque-rect-v1",
        maskColorRgba: [17, 61, 51, 255],
        avatarBounds: null,
        visibleRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
        maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
      }
    } : null
  };
  return typeof value.observationId === "string" && IDENTIFIER.test(value.observationId)
    && value.sessionId === sessionId
    && typeof value.textHash === "string" && DIGEST.test(value.textHash)
    && (value.domTextHash === null
      || (typeof value.domTextHash === "string" && DIGEST.test(value.domTextHash)))
    && (value.ocrTextHash === null
      || (typeof value.ocrTextHash === "string" && DIGEST.test(value.ocrTextHash)))
    && typeof value.viewportHash === "string" && DIGEST.test(value.viewportHash)
    && (value.redactedCropHash === null
      || (typeof value.redactedCropHash === "string" && DIGEST.test(value.redactedCropHash)))
    && isVisualObservationSubmission(submission);
}

function validObservationBatchInput(value: unknown): value is { observations: VisualObservationSubmission[] } {
  return exactKeys(value, ["observations"])
    && Array.isArray(value.observations)
    && value.observations.length >= 1
    && value.observations.length <= 20
    && value.observations.every((observation) => isVisualObservationSubmission(observation))
    && value.observations.filter((observation) => observation.redactedCrop !== null).length <= 5;
}

function defaultCookieSource(): string {
  return typeof document === "undefined" ? "" : document.cookie;
}

function pathSegment(value: string, label: string): string {
  return encodeURIComponent(identifier(value, label));
}

function validWebp(content: ArrayBuffer): boolean {
  if (content.byteLength < 12) return false;
  const bytes = new Uint8Array(content);
  const riff = [82, 73, 70, 70];
  const webp = [87, 69, 66, 80];
  if (!riff.every((byte, index) => bytes[index] === byte)
    || !webp.every((byte, index) => bytes[index + 8] === byte)) return false;
  return new DataView(content).getUint32(4, true) + 8 === content.byteLength;
}

export function createVisualReaderApi(
  fetchImpl: typeof fetch = fetch,
  options: VisualReaderApiOptions = {}
): VisualReaderApi {
  const cookieSource = options.cookieSource
    ?? (options.cookie === undefined ? defaultCookieSource : () => options.cookie ?? "");

  async function requestJson(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => VisualReaderSession | VisualObservationBatchResponse
  ) {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", csrfFromCookie(cookieSource()));
    }
    const response = await fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      headers
    });
    const body = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      const envelope = isRecord(body) ? body : {};
      const nested = isRecord(envelope.error) ? envelope.error : {};
      const code = parseErrorCode(nested.code) ?? parseErrorCode(envelope.code);
      throw new VisualReaderApiError(
        code ?? "visual_reader_request_failed",
        code ? SAFE_ERROR_MESSAGES[code] : `视觉读取请求失败（HTTP ${response.status}）`,
        response.status
      );
    }
    return parse(body);
  }

  function post(
    path: string,
    body: unknown,
    key: string,
    parse: (value: unknown) => VisualReaderSession | VisualObservationBatchResponse
  ) {
    return requestJson(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey(key) },
      body: JSON.stringify(body)
    }, parse);
  }

  return {
    async createSession(input, key) {
      if (!exactKeys(input, ["runId", "artifactUploadEnabled"])
        || typeof input.artifactUploadEnabled !== "boolean") {
        throw new Error("视觉读取授权请求无效");
      }
      identifier(input.runId, "运行 ID");
      return await post(
        "/api/v1/acquisition/visual-reader-sessions",
        input,
        key,
        parseVisualReaderSession
      ) as VisualReaderSession;
    },
    async getSession(sessionId) {
      return await requestJson(
        `/api/v1/acquisition/visual-reader-sessions/${pathSegment(sessionId, "会话 ID")}`,
        { method: "GET" },
        parseVisualReaderSession
      ) as VisualReaderSession;
    },
    async appendObservationBatch(sessionId, input, key) {
      const id = identifier(sessionId, "会话 ID");
      if (!validObservationBatchInput(input)) {
        throw new Error("视觉观察批次无效");
      }
      return await post(
        `/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(id)}/observations:batch`,
        input,
        key,
        (value) => parseVisualObservationBatch(value, id)
      ) as VisualObservationBatchResponse;
    },
    async completeSession(sessionId, input, key) {
      const id = identifier(sessionId, "会话 ID");
      if (!exactKeys(input, ["status", "errorCodes"])
        || !["completed", "partial_success"].includes(input.status)
        || !validStableErrorCodes(input.errorCodes)) {
        throw new Error("视觉读取完成请求无效");
      }
      return await post(
        `/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(id)}:complete`,
        input,
        key,
        parseVisualReaderSession
      ) as VisualReaderSession;
    },
    async abortSession(sessionId, input, key) {
      const id = identifier(sessionId, "会话 ID");
      if (!exactKeys(input, ["reasonCode"])
        || !["user_requested", "visual_reader_user_takeover"].includes(input.reasonCode)) {
        throw new Error("视觉读取中止请求无效");
      }
      return await post(
        `/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(id)}:abort`,
        input,
        key,
        parseVisualReaderSession
      ) as VisualReaderSession;
    },
    async getArtifact(artifactId) {
      const response = await fetchImpl(
        `/api/v1/acquisition/visual-reader-artifacts/${pathSegment(artifactId, "制品 ID")}`,
        {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "image/webp" }
        }
      );
      if (!response.ok) {
        throw new VisualReaderApiError(
          "visual_reader_request_failed",
          `视觉读取制品请求失败（HTTP ${response.status}）`,
          response.status
        );
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "image/webp") {
        throw new Error("服务端返回了无效的视觉读取制品");
      }
      const content = await response.arrayBuffer();
      if (!validWebp(content)) throw new Error("服务端返回了无效的视觉读取制品");
      return { mediaType: "image/webp", content };
    }
  };
}
