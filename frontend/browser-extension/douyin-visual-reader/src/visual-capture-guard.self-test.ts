import { strict as assert } from "node:assert";
import { authorizeVisualCapture } from "./visual-capture-guard";

const request = {
  kind: "visual_capture_request" as const,
  sessionId: "session-1",
  domTextState: "truncated" as const,
  viewport: { width: 1_000, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 100, y: 100, width: 500, height: 180 },
  avatarBounds: { x: 112, y: 116, width: 48, height: 48 },
  regions: [
    { kind: "body" as const, bounds: { x: 180, y: 116, width: 350, height: 88 } },
    { kind: "metadata" as const, bounds: { x: 180, y: 214, width: 180, height: 24 } }
  ]
};
const snapshot = {
  sessionId: "session-1",
  status: "reading" as const,
  artifactUploadEnabled: true,
  douyinTabId: 7,
  douyinWindowId: 9,
  douyinSourceUrl: "https://www.douyin.com/video/123",
  limits: { maxOcrCalls: 10 },
  usage: { ocrCallCount: 2 }
};
const tab = {
  id: 7,
  windowId: 9,
  active: true,
  url: "https://www.douyin.com/video/123"
};

assert.deepEqual(authorizeVisualCapture({
  request,
  senderTabId: 7,
  snapshot,
  tab,
  focusedWindowId: 9
}), request);

for (const [name, overrides] of Object.entries({
  "artifact disabled": { snapshot: { ...snapshot, artifactUploadEnabled: false } },
  "complete DOM": { request: { ...request, domTextState: "complete" } },
  "budget exhausted": { snapshot: { ...snapshot, usage: { ocrCallCount: 10 } } },
  "wrong sender": { senderTabId: 8 },
  "wrong session": { request: { ...request, sessionId: "session-2" } },
  "inactive tab": { tab: { ...tab, active: false } },
  "wrong window": { tab: { ...tab, windowId: 10 } },
  "focus departed": { focusedWindowId: 10 },
  "url changed": { tab: { ...tab, url: "https://www.douyin.com/video/124" } },
  "non canonical url": { tab: { ...tab, url: "https://www.douyin.com/video/123?x=1" } }
})) {
  assert.equal(authorizeVisualCapture({
    request,
    senderTabId: 7,
    snapshot,
    tab,
    focusedWindowId: 9,
    ...overrides
  } as any), null, name);
}

assert.equal(authorizeVisualCapture({
  request: { ...request, regions: Array.from({ length: 21 }, () => request.regions[0]) },
  senderTabId: 7,
  snapshot,
  tab,
  focusedWindowId: 9
}), null);

assert.equal(authorizeVisualCapture({
  request: { ...request, unexpectedText: "must never cross the capture boundary" } as any,
  senderTabId: 7,
  snapshot,
  tab,
  focusedWindowId: 9
}), null);

console.log("visual capture guard self-test passed");
