import {
  isVisualObservationSubmission,
  type VisualObservationSubmission,
  type VisualReaderLimits,
  type VisualReaderStableErrorCode
} from "./visual-reader-api";

export const VISUAL_READER_BRIDGE_VERSION = "goodjob.visual-reader.bridge.v1" as const;

export type VisualReaderBridgeAvailability = "probing" | "ready" | "unavailable";

export type VisualReaderPageCommand =
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "probe";
      channelNonce: string;
    }
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "start";
      channelNonce: string;
      sessionId: string;
      limits: VisualReaderLimits;
      artifactUploadEnabled: boolean;
    }
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "acknowledge_batch";
      channelNonce: string;
      sessionId: string;
      batchId: string;
    }
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "abort";
      channelNonce: string;
      sessionId: string;
    };

export type VisualReaderExtensionEvent =
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "ready";
      channelNonce: string;
      extensionVersion: string;
    }
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "observation_batch";
      channelNonce: string;
      sessionId: string;
      batchId: string;
      observations: VisualObservationSubmission[];
    }
  | {
      version: typeof VISUAL_READER_BRIDGE_VERSION;
      type: "terminal";
      channelNonce: string;
      sessionId: string;
      status: "completed" | "partial_success" | "aborted";
      errorCodes: VisualReaderStableErrorCode[];
    };

export interface VisualReaderWindowPort {
  addEventListener(type: "message", listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: "message", listener: EventListenerOrEventListenerObject): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface VisualReaderBridgeHandlers {
  onAvailability(value: VisualReaderBridgeAvailability): void;
  onEvent(event: VisualReaderExtensionEvent): void;
}

export interface VisualReaderBridge {
  readonly channelNonce: string;
  connect(handlers: VisualReaderBridgeHandlers): void;
  startSession(
    sessionId: string,
    limits: VisualReaderLimits,
    artifactUploadEnabled: boolean
  ): void;
  acknowledgeBatch(sessionId: string, batchId: string): void;
  abortSession(sessionId: string): void;
  destroy(): void;
}

export interface VisualReaderBridgeOptions {
  windowPort?: VisualReaderWindowPort;
  origin?: string;
  randomValues?: (bytes: Uint8Array) => Uint8Array;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  probeTimeoutMs?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const VERSION_TEXT = /^[^\u0000-\u001f\u007f]{1,100}$/u;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, required: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(required);
  return keys.length === required.length
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function validLimits(value: unknown): value is VisualReaderLimits {
  if (!exactKeys(value, [
    "maxVideos", "maxCommentsPerVideo", "maxScrolls", "maxOcrCalls", "maxDurationMs"
  ])) return false;
  const boundedInteger = (candidate: unknown, minimum: number, maximum: number) =>
    Number.isSafeInteger(candidate)
    && (candidate as number) >= minimum
    && (candidate as number) <= maximum;
  return boundedInteger(value.maxVideos, 1, 10)
    && boundedInteger(value.maxCommentsPerVideo, 1, 30)
    && boundedInteger(value.maxScrolls, 0, 5)
    && boundedInteger(value.maxOcrCalls, 0, 10)
    && boundedInteger(value.maxDurationMs, 1, 120_000);
}

function requiredIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${label}格式无效`);
  return value;
}

function incomingEvent(
  value: unknown,
  channelNonce: string,
  activeSessionId: string | null
): VisualReaderExtensionEvent | null {
  if (!isPlainRecord(value)
    || value.version !== VISUAL_READER_BRIDGE_VERSION
    || value.channelNonce !== channelNonce
    || typeof value.type !== "string") return null;
  if (value.type === "ready") {
    return exactKeys(value, ["version", "type", "channelNonce", "extensionVersion"])
      && typeof value.extensionVersion === "string"
      && VERSION_TEXT.test(value.extensionVersion)
      ? value as unknown as VisualReaderExtensionEvent
      : null;
  }
  if (value.type === "observation_batch") {
    if (!activeSessionId
      || !exactKeys(value, [
        "version", "type", "channelNonce", "sessionId", "batchId", "observations"
      ])
      || value.sessionId !== activeSessionId
      || typeof value.batchId !== "string" || !IDENTIFIER.test(value.batchId)
      || !Array.isArray(value.observations)
      || value.observations.length < 1 || value.observations.length > 20
      || !value.observations.every((item) => isVisualObservationSubmission(item, false))
      || value.observations.filter((item) => item.redactedCrop !== null).length > 5) return null;
    return value as unknown as VisualReaderExtensionEvent;
  }
  if (value.type === "terminal") {
    if (!activeSessionId
      || !exactKeys(value, [
        "version", "type", "channelNonce", "sessionId", "status", "errorCodes"
      ])
      || value.sessionId !== activeSessionId
      || !["completed", "partial_success", "aborted"].includes(String(value.status))
      || !Array.isArray(value.errorCodes)
      || value.errorCodes.length > 9
      || new Set(value.errorCodes).size !== value.errorCodes.length
      || !value.errorCodes.every((code) => STABLE_ERROR_CODES.has(code as VisualReaderStableErrorCode))) {
      return null;
    }
    return value as unknown as VisualReaderExtensionEvent;
  }
  return null;
}

function browserWindowPort(): VisualReaderWindowPort {
  if (typeof window !== "undefined") return window;
  return {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {}
  };
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin;
}

function secureRandomValues(bytes: Uint8Array): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("当前浏览器无法创建安全的视觉读取通道");
  }
  return globalThis.crypto.getRandomValues(bytes);
}

function nonceFrom(randomValues: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = randomValues(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("视觉读取通道随机数无效");
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createVisualReaderBridge(
  options: VisualReaderBridgeOptions = {}
): VisualReaderBridge {
  const windowPort = options.windowPort ?? browserWindowPort();
  const origin = options.origin ?? browserOrigin();
  const randomValues = options.randomValues ?? secureRandomValues;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancelTimeout = options.cancelTimeout
    ?? ((handle: unknown) => globalThis.clearTimeout(
      handle as ReturnType<typeof globalThis.setTimeout>
    ));
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
    && (options.probeTimeoutMs ?? 0) > 0
    ? options.probeTimeoutMs as number
    : 1_500;
  const channelNonce = nonceFrom(randomValues);
  let handlers: VisualReaderBridgeHandlers | null = null;
  let activeSessionId: string | null = null;
  let timeoutHandle: unknown = null;
  let connected = false;
  let destroyed = false;

  function send(command: VisualReaderPageCommand): void {
    if (destroyed) return;
    windowPort.postMessage(command, origin);
  }

  function cancelProbeTimeout(): void {
    if (timeoutHandle !== null) cancelTimeout(timeoutHandle);
    timeoutHandle = null;
  }

  function onMessage(rawEvent: Event): void {
    const event = rawEvent as MessageEvent;
    if (destroyed || event.source !== windowPort || event.origin !== origin) return;
    const parsed = incomingEvent(event.data, channelNonce, activeSessionId);
    if (!parsed) return;
    if (parsed.type === "ready") {
      cancelProbeTimeout();
      handlers?.onAvailability("ready");
    }
    handlers?.onEvent(parsed);
  }

  return {
    channelNonce,
    connect(nextHandlers) {
      if (destroyed) throw new Error("视觉读取通道已关闭");
      handlers = nextHandlers;
      if (!connected) {
        connected = true;
        windowPort.addEventListener("message", onMessage as EventListener);
      }
      handlers.onAvailability("probing");
      send({ version: VISUAL_READER_BRIDGE_VERSION, type: "probe", channelNonce });
      cancelProbeTimeout();
      timeoutHandle = scheduleTimeout(() => {
        timeoutHandle = null;
        if (!destroyed) handlers?.onAvailability("unavailable");
      }, probeTimeoutMs);
    },
    startSession(sessionId, limits, artifactUploadEnabled) {
      const id = requiredIdentifier(sessionId, "会话 ID");
      if (!validLimits(limits)) throw new Error("视觉读取限额无效");
      if (typeof artifactUploadEnabled !== "boolean") {
        throw new Error("视觉读取制品授权无效");
      }
      activeSessionId = id;
      send({
        version: VISUAL_READER_BRIDGE_VERSION,
        type: "start",
        channelNonce,
        sessionId: id,
        limits: { ...limits },
        artifactUploadEnabled
      });
    },
    acknowledgeBatch(sessionId, batchId) {
      const session = requiredIdentifier(sessionId, "会话 ID");
      const batch = requiredIdentifier(batchId, "批次 ID");
      if (session !== activeSessionId) throw new Error("视觉读取会话已更换");
      send({
        version: VISUAL_READER_BRIDGE_VERSION,
        type: "acknowledge_batch",
        channelNonce,
        sessionId: session,
        batchId: batch
      });
    },
    abortSession(sessionId) {
      const session = requiredIdentifier(sessionId, "会话 ID");
      if (session !== activeSessionId) throw new Error("视觉读取会话已更换");
      send({
        version: VISUAL_READER_BRIDGE_VERSION,
        type: "abort",
        channelNonce,
        sessionId: session
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelProbeTimeout();
      if (connected) windowPort.removeEventListener("message", onMessage as EventListener);
      connected = false;
      handlers = null;
      activeSessionId = null;
    }
  };
}
