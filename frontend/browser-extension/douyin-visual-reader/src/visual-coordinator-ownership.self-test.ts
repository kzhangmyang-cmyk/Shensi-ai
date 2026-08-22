import { strict as assert } from "node:assert";
import { invalidateCoordinatorOwnership } from "./visual-coordinator-ownership";
import { createVisualCaptureAuthorizationResolver } from "./visual-capture-authorization";
import type { VisualCaptureRequest } from "./visual-capture-guard";
import type { VisualReaderRuntimeSnapshot } from "./session-coordinator";

const request: VisualCaptureRequest = {
  kind: "visual_capture_request",
  sessionId: "revoked-session",
  domTextState: "missing",
  viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
  cardBounds: { x: 10, y: 10, width: 80, height: 60 },
  avatarBounds: null,
  regions: [{ kind: "body", bounds: { x: 20, y: 20, width: 50, height: 30 } }]
};
const snapshot: VisualReaderRuntimeSnapshot = {
  sessionId: request.sessionId,
  goodJobTabId: 9,
  douyinTabId: 41,
  douyinWindowId: 8,
  douyinSourceUrl: "https://www.douyin.com/video/123",
  limits: {
    maxVideos: 1,
    maxCommentsPerVideo: 20,
    maxScrolls: 2,
    maxOcrCalls: 3,
    maxDurationMs: 30_000
  },
  usage: { observationCount: 0, scrollCount: 0, ocrCallCount: 0 },
  artifactUploadEnabled: true,
  channelNonceHash: `sha256:${"1".repeat(64)}`,
  status: "reading",
  pendingBatchId: null
};
const coordinator = { snapshot: () => snapshot };
const ownership: { current: typeof coordinator | null; generation: number } = {
  current: coordinator,
  generation: 7
};
const target = invalidateCoordinatorOwnership(ownership);
assert.equal(target, coordinator);
assert.equal(ownership.current, null,
  "stop/takeover synchronously removes the active coordinator before abort awaits");
assert.equal(ownership.generation, 8);

let tabReads = 0;
const authorize = createVisualCaptureAuthorizationResolver({
  getCoordinator: () => ownership.current,
  getGeneration: () => ownership.generation,
  getTab: async () => { tabReads += 1; return null; },
  getFocusedWindowId: async () => 8
});
assert.equal(await authorize(request, 41, null), null,
  "an invalidated coordinator cannot authorize a fresh runtime generation while abort is pending");
assert.equal(tabReads, 0, "revocation fails before any asynchronous tab read");

console.log("visual coordinator ownership self-test passed");
