import { canonicalDouyinVideoUrl } from "./protocol";
import type { PixelRect } from "./visual-pipeline";

export interface VisualCaptureRequest {
  kind: "visual_capture_request";
  sessionId: string;
  domTextState: "missing" | "truncated";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: PixelRect;
  avatarBounds: PixelRect | null;
  regions: Array<{ kind: "body" | "metadata"; bounds: PixelRect }>;
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

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function rect(value: unknown): value is PixelRect {
  return exact(value, ["x", "y", "width", "height"])
    && finite(value.x, -8_192, 8_192) && finite(value.y, -8_192, 8_192)
    && finite(value.width, Number.EPSILON, 8_192)
    && finite(value.height, Number.EPSILON, 8_192);
}

function request(value: unknown): value is VisualCaptureRequest {
  return exact(value, [
    "kind", "sessionId", "domTextState", "viewport", "cardBounds", "avatarBounds", "regions"
  ]) && value.kind === "visual_capture_request"
    && typeof value.sessionId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.sessionId)
    && ["missing", "truncated"].includes(String(value.domTextState))
    && exact(value.viewport, ["width", "height", "deviceScaleFactor"])
    && Number.isSafeInteger(value.viewport.width) && (value.viewport.width as number) >= 1
    && (value.viewport.width as number) <= 8_192
    && Number.isSafeInteger(value.viewport.height) && (value.viewport.height as number) >= 1
    && (value.viewport.height as number) <= 8_192
    && finite(value.viewport.deviceScaleFactor, 0.5, 8)
    && rect(value.cardBounds)
    && (value.avatarBounds === null || rect(value.avatarBounds))
    && Array.isArray(value.regions) && value.regions.length >= 1 && value.regions.length <= 20
    && value.regions.some((region) => exact(region, ["kind", "bounds"]) && region.kind === "body")
    && value.regions.every((region) => exact(region, ["kind", "bounds"])
      && ["body", "metadata"].includes(String(region.kind)) && rect(region.bounds));
}

export function authorizeVisualCapture(input: {
  request: unknown;
  senderTabId: number | null;
  snapshot: {
    sessionId: string;
    status: string;
    artifactUploadEnabled: boolean;
    douyinTabId: number | null;
    douyinWindowId: number | null;
    douyinSourceUrl: string | null;
    limits: { maxOcrCalls: number };
    usage: { ocrCallCount: number };
  } | null;
  tab: { id?: number; windowId?: number; active?: boolean; url?: string } | null;
  focusedWindowId: number | null;
}): VisualCaptureRequest | null {
  if (!request(input.request) || !input.snapshot || !input.tab) return null;
  const { snapshot, tab } = input;
  if (snapshot.status !== "reading" || snapshot.artifactUploadEnabled !== true
    || input.request.sessionId !== snapshot.sessionId
    || !Number.isSafeInteger(input.senderTabId)
    || input.senderTabId !== snapshot.douyinTabId
    || tab.id !== snapshot.douyinTabId || tab.windowId !== snapshot.douyinWindowId
    || tab.active !== true || input.focusedWindowId !== snapshot.douyinWindowId
    || snapshot.usage.ocrCallCount >= snapshot.limits.maxOcrCalls
    || typeof tab.url !== "string" || tab.url !== snapshot.douyinSourceUrl
    || canonicalDouyinVideoUrl(tab.url)?.sourceUrl !== tab.url) return null;
  const viewport = input.request.viewport;
  const left = Math.max(0, input.request.cardBounds.x);
  const top = Math.max(0, input.request.cardBounds.y);
  const right = Math.min(viewport.width, input.request.cardBounds.x + input.request.cardBounds.width);
  const bottom = Math.min(viewport.height, input.request.cardBounds.y + input.request.cardBounds.height);
  if (right <= left || bottom <= top
    || Math.round((right - left) * viewport.deviceScaleFactor)
      * Math.round((bottom - top) * viewport.deviceScaleFactor) > 1_000_000) return null;
  return input.request;
}
