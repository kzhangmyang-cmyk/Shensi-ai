import { strict as assert } from "node:assert";
import { createVisualCaptureAuthorizationResolver } from "./visual-capture-authorization";
import type { VisualCaptureRequest } from "./visual-capture-guard";
import type { VisualReaderRuntimeSnapshot } from "./session-coordinator";

const request: VisualCaptureRequest = {
  kind: "visual_capture_request",
  sessionId: "authorization-session",
  domTextState: "missing",
  viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 600, y: 200, width: 400, height: 180 },
  avatarBounds: null,
  regions: [{ kind: "body", bounds: { x: 690, y: 220, width: 240, height: 80 } }]
};

function snapshot(status: VisualReaderRuntimeSnapshot["status"] = "reading"):
VisualReaderRuntimeSnapshot {
  return {
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
    status,
    pendingBatchId: null
  };
}

function coordinator(state: VisualReaderRuntimeSnapshot) {
  return { snapshot: () => ({ ...state, limits: { ...state.limits }, usage: { ...state.usage } }) };
}

const tab = {
  id: 41,
  windowId: 8,
  active: true,
  url: "https://www.douyin.com/video/123"
};

{
  const current = coordinator(snapshot());
  const authorize = createVisualCaptureAuthorizationResolver({
    getCoordinator: () => current,
    getGeneration: () => 7,
    getTab: async () => tab,
    getFocusedWindowId: async () => 8
  });
  const result = await authorize(request, 41, null);
  assert.deepEqual(result?.owner, {
    generation: 7,
    sessionId: request.sessionId,
    tabId: 41,
    windowId: 8
  });
}

{
  let generation = 7;
  let current = coordinator(snapshot());
  let releaseTab: (() => void) | null = null;
  const authorize = createVisualCaptureAuthorizationResolver({
    getCoordinator: () => current,
    getGeneration: () => generation,
    getTab: async () => {
      await new Promise<void>((resolve) => { releaseTab = resolve; });
      return tab;
    },
    getFocusedWindowId: async () => 8
  });
  const pending = authorize(request, 41, null);
  while (!releaseTab) await Promise.resolve();
  generation += 1;
  current = coordinator(snapshot("aborted"));
  const finish = releaseTab as (() => void) | null;
  if (!finish) throw new Error("missing deferred tab resolver");
  finish();
  assert.equal(await pending, null,
    "authorization cannot revive after coordinator replacement during tab/focus reads");
}

{
  const mutable = snapshot();
  const current = coordinator(mutable);
  let releaseTab: (() => void) | null = null;
  const authorize = createVisualCaptureAuthorizationResolver({
    getCoordinator: () => current,
    getGeneration: () => 7,
    getTab: async () => {
      await new Promise<void>((resolve) => { releaseTab = resolve; });
      return tab;
    },
    getFocusedWindowId: async () => 8
  });
  const pending = authorize(request, 41, null);
  while (!releaseTab) await Promise.resolve();
  mutable.status = "aborted";
  const finish = releaseTab as (() => void) | null;
  if (!finish) throw new Error("missing deferred status resolver");
  finish();
  assert.equal(await pending, null,
    "authorization rechecks current reading status after asynchronous tab/focus reads");
}

console.log("visual capture authorization self-test passed");
