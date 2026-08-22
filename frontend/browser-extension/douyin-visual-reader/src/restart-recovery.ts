import {
  BRIDGE_VERSION,
  canonicalDouyinVideoUrl,
  type ExtensionEvent
} from "./protocol";
import type { VisualReaderPersistedState } from "./session-coordinator";

type RecoveryMessage = { kind: "goodjob_reader_unavailable" | "visual_reader_unavailable"; sessionId: string };

export interface RestartRecoveryDependencies {
  load(): Promise<unknown>;
  clear(): Promise<void>;
  notifyGoodJob(tabId: number, message: RecoveryMessage): Promise<void>;
  notifyDouyin(tabId: number, message: RecoveryMessage): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && keys.every((key) => key in value)
    && actual.every((key) => allowed.has(key));
}

export function matchesUnavailableSession(
  value: unknown,
  kind: RecoveryMessage["kind"],
  expectedSessionId: string | null
): value is RecoveryMessage {
  return expectedSessionId !== null && exact(value, ["kind", "sessionId"])
    && value.kind === kind && value.sessionId === expectedSessionId;
}

export function goodJobRecoveryTerminalFromMemory(
  value: unknown,
  memory: { sessionId: string | null; channelNonce: string | null }
): Extract<ExtensionEvent, { type: "terminal" }> | null {
  if (!matchesUnavailableSession(value, "goodjob_reader_unavailable", memory.sessionId)
    || memory.sessionId === null || memory.channelNonce === null
    || !/^[0-9a-f]{64}$/u.test(memory.channelNonce)) return null;
  return {
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: memory.channelNonce,
    sessionId: memory.sessionId,
    status: "partial_success",
    errorCodes: ["visual_reader_session_expired"]
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validLimits(value: unknown): value is VisualReaderPersistedState["limits"] {
  return exact(value, ["maxVideos", "maxCommentsPerVideo", "maxScrolls", "maxOcrCalls", "maxDurationMs"])
    && integer(value.maxVideos, 1, 10)
    && integer(value.maxCommentsPerVideo, 1, 30)
    && integer(value.maxScrolls, 0, 5)
    && integer(value.maxOcrCalls, 0, 10)
    && integer(value.maxDurationMs, 1, 120_000);
}

function validUsage(
  value: unknown,
  limits: VisualReaderPersistedState["limits"]
): value is VisualReaderPersistedState["usage"] {
  return exact(value, ["observationCount", "scrollCount", "ocrCallCount"])
    && integer(value.observationCount, 0, limits.maxCommentsPerVideo)
    && integer(value.scrollCount, 0, limits.maxScrolls)
    && value.ocrCallCount === 0;
}

function validPersistedState(value: unknown): value is VisualReaderPersistedState {
  if (!exact(value, [
    "sessionId", "goodJobTabId", "douyinTabId", "douyinWindowId", "douyinSourceUrl",
    "limits", "usage", "artifactUploadEnabled", "channelNonceHash", "status"
  ]) || typeof value.sessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.sessionId)
    || !positiveTabId(value.goodJobTabId)
    || !(value.douyinTabId === null || positiveTabId(value.douyinTabId))
    || !(value.douyinWindowId === null || nonNegativeInteger(value.douyinWindowId))
    || !(value.douyinSourceUrl === null || (typeof value.douyinSourceUrl === "string"
      && canonicalDouyinVideoUrl(value.douyinSourceUrl)?.sourceUrl === value.douyinSourceUrl))
    || typeof value.artifactUploadEnabled !== "boolean"
    || typeof value.channelNonceHash !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(value.channelNonceHash)
    || !["authorized", "reading", "completed", "partial_success", "aborted"].includes(String(value.status))
    || !validLimits(value.limits) || !validUsage(value.usage, value.limits)) return false;
  const readingBinding = value.status === "reading";
  return readingBinding
    ? value.douyinTabId !== null && value.douyinWindowId !== null && value.douyinSourceUrl !== null
    : value.status === "authorized"
      ? value.douyinTabId === null && value.douyinWindowId === null && value.douyinSourceUrl === null
      : true;
}

export async function recoverOrphanedVisualReaderSession(
  dependencies: RestartRecoveryDependencies
): Promise<"none" | "invalid_session_cleared" | "terminal_session_cleared" | "active_session_failed_closed"> {
  const raw = await dependencies.load();
  if (raw === null || raw === undefined) return "none";
  await dependencies.clear();
  if (!validPersistedState(raw)) return "invalid_session_cleared";
  if (["completed", "partial_success", "aborted"].includes(raw.status)) {
    return "terminal_session_cleared";
  }
  const notifications: Array<Promise<void>> = [dependencies.notifyGoodJob(raw.goodJobTabId, {
    kind: "goodjob_reader_unavailable",
    sessionId: raw.sessionId
  })];
  if (raw.status === "reading" && raw.douyinTabId !== null) {
    notifications.push(dependencies.notifyDouyin(raw.douyinTabId, {
      kind: "visual_reader_unavailable",
      sessionId: raw.sessionId
    }));
  }
  await Promise.allSettled(notifications);
  return "active_session_failed_closed";
}
