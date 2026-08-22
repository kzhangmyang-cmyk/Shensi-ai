import { strict as assert } from "node:assert";
import {
  createVisualCaptureRuntime,
  type VisualCapturedScreenshot,
  type VisualCaptureAuthorization,
  type VisualCaptureRuntimeDependencies
} from "./visual-capture-runtime";
import type { VisualCaptureRequest } from "./visual-capture-guard";

const request: VisualCaptureRequest = {
  kind: "visual_capture_request",
  sessionId: "session-capture",
  domTextState: "missing",
  viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  cardBounds: { x: 600, y: 200, width: 400, height: 180 },
  avatarBounds: { x: 620, y: 220, width: 48, height: 48 },
  regions: [{ kind: "body", bounds: { x: 690, y: 220, width: 240, height: 80 } }]
};
const owner = {
  generation: 7,
  sessionId: request.sessionId,
  tabId: 41,
  windowId: 8
};
const authorization: VisualCaptureAuthorization = { request, owner };

function capturedScreenshot(value: string, onClear: () => void = () => undefined): VisualCapturedScreenshot {
  let dataUrl = value;
  return {
    get dataUrl() { return dataUrl; },
    clear() {
      if (dataUrl === "") return;
      dataUrl = "";
      onClear();
    }
  };
}

const evidence = {
  mediaType: "image/webp" as const,
  contentBase64: "UklGRg==",
  width: 800,
  height: 360,
  redactionProof: {
    version: "opaque-rect-v1" as const,
    maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
    avatarBounds: { x: 40, y: 40, width: 96, height: 96 },
    visibleRegions: [{ x: 180, y: 40, width: 480, height: 160 }],
    maskedRegions: [{ x: 0, y: 0, width: 180, height: 360 }]
  },
  ocrResult: {
    text: "本地 OCR 可见正文",
    confidence: 0.96,
    words: [{
      text: "OCR",
      confidence: 0.98,
      bounds: { x: 180, y: 40, width: 80, height: 40 }
    }]
  }
};

function dependencies(overrides: Partial<VisualCaptureRuntimeDependencies> = {}) {
  const calls: string[] = [];
  let authorizations = 0;
  const deps: VisualCaptureRuntimeDependencies = {
    runtimeEpoch: "worker-epoch-0001",
    authorize: async (_request, _senderTabId, expectedOwner) => {
      authorizations += 1;
      calls.push(`authorize:${authorizations}`);
      assert.deepEqual(expectedOwner, expectedOwner === null ? null : owner);
      return authorization;
    },
    ensureOffscreen: async () => { calls.push("offscreen"); },
    reserveOcrCall: async () => { calls.push("reserve"); return true; },
    captureVisibleTab: async () => {
      calls.push("capture");
      return capturedScreenshot("data:image/png;base64,iVBORw0KGgo=");
    },
    processOffscreen: async (message) => {
      calls.push("process");
      assert.deepEqual(Object.keys(message).sort(), [
        "avatarBounds", "cardBounds", "domTextState", "kind", "regions", "runtimeEpoch",
        "runtimeGeneration", "screenshotDataUrl", "sessionId", "viewport"
      ]);
      assert.equal(message.runtimeGeneration, 0);
      assert.equal(message.runtimeEpoch, "worker-epoch-0001");
      assert.equal(message.kind, "visual_process_capture");
      return { accepted: true, evidence };
    },
    validateEvidence: async (value, boundRequest) => {
      calls.push("validate");
      assert.equal(boundRequest, request);
      return value === evidence ? evidence : null;
    },
    endOffscreenSession: async (endingGeneration) => {
      calls.push(`end:${endingGeneration}`);
      return true;
    },
    ...overrides
  };
  return { deps, calls };
}

{
  const { deps, calls } = dependencies();
  const runtime = createVisualCaptureRuntime(deps);
  const result = await runtime.handle(request, 41);
  assert.deepEqual(result, { accepted: true, evidence });
  assert.deepEqual(calls, [
    "authorize:1", "offscreen", "authorize:2", "reserve", "authorize:3", "capture",
    "authorize:4", "process", "authorize:5", "validate", "authorize:6"
  ], "authorization and immutable owner are rechecked around capture and offscreen processing");
  await runtime.endSession();
  assert.equal(calls.at(-1), "end:0");
}

{
  let releaseValidation: (() => void) | null = null;
  const { deps } = dependencies({
    validateEvidence: async () => {
      await new Promise<void>((resolve) => { releaseValidation = resolve; });
      return evidence;
    }
  });
  const runtime = createVisualCaptureRuntime(deps);
  const pending = runtime.handle(request, 41);
  while (!releaseValidation) await Promise.resolve();
  await runtime.endSession();
  const finish = releaseValidation as (() => void) | null;
  if (!finish) throw new Error("missing deferred validator resolver");
  finish();
  assert.deepEqual(await pending, { accepted: false },
    "session end during asynchronous raster validation rejects stale evidence");
}

{
  let authorizations = 0;
  const replacement = { ...authorization, owner: { ...owner, generation: owner.generation + 1 } };
  const { deps } = dependencies({
    authorize: async () => {
      authorizations += 1;
      return authorizations < 6 ? authorization : replacement;
    }
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false },
    "owner replacement during raster validation rejects prior-owner evidence");
}

for (const [name, overrides] of [
  ["not authorized", { authorize: async () => null }],
  ["budget race", {
    authorize: (() => {
      let calls = 0;
      return async () => (++calls === 1 ? authorization : null);
    })()
  }],
  ["focus race after reservation", {
    authorize: (() => {
      let calls = 0;
      return async () => (++calls < 3 ? authorization : null);
    })()
  }],
  ["reservation rejected", { reserveOcrCall: async () => false }]
] as const) {
  let captures = 0;
  const { deps } = dependencies({
    ...overrides,
    captureVisibleTab: async () => {
      captures += 1;
      return capturedScreenshot("data:image/png;base64,forbidden");
    }
  });
  const result = await createVisualCaptureRuntime(deps).handle(request, 41);
  assert.deepEqual(result, { accepted: false }, name);
  assert.equal(captures, 0, `${name} never captures`);
}

{
  let authorizations = 0;
  let processes = 0;
  const { deps } = dependencies({
    authorize: async () => {
      authorizations += 1;
      return authorizations < 4 ? authorization : null;
    },
    processOffscreen: async () => { processes += 1; return { accepted: true, evidence }; }
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false });
  assert.equal(processes, 0,
    "authorization revoked while captureVisibleTab is pending drops raw capture before offscreen");
}

{
  let authorizations = 0;
  let processes = 0;
  const replacement = { ...authorization, owner: { ...owner, generation: owner.generation + 1 } };
  const { deps } = dependencies({
    authorize: async () => {
      authorizations += 1;
      return authorizations < 4 ? authorization : replacement;
    },
    processOffscreen: async () => { processes += 1; return { accepted: true, evidence }; }
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false });
  assert.equal(processes, 0, "a replacement owner cannot receive the prior owner's screenshot");
}

{
  let authorizations = 0;
  const { deps } = dependencies({
    authorize: async () => {
      authorizations += 1;
      return authorizations < 5 ? authorization : null;
    }
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false },
    "authorization revoked during OCR rejects evidence before content release");
}

{
  let releaseProcess: ((value: unknown) => void) | null = null;
  let ended = 0;
  const { deps } = dependencies({
    processOffscreen: () => new Promise((resolve) => { releaseProcess = resolve; }),
    endOffscreenSession: async () => { ended += 1; return true; }
  });
  const runtime = createVisualCaptureRuntime(deps);
  const pending = runtime.handle(request, 41);
  while (!releaseProcess) await Promise.resolve();
  assert.equal(await runtime.endSession(), true,
    "endSession terminates OCR out-of-band instead of waiting behind the capture queue");
  assert.equal(ended, 1);
  const finish = releaseProcess as ((value: unknown) => void) | null;
  if (!finish) throw new Error("missing deferred offscreen resolver");
  finish({ accepted: true, evidence });
  assert.deepEqual(await pending, { accepted: false },
    "an in-flight owner cannot release evidence after session end");
}

{
  let retainedMessage: { screenshotDataUrl: string } | null = null;
  let releaseProcess: ((value: unknown) => void) | null = null;
  const { deps } = dependencies({
    processOffscreen: (message) => {
      retainedMessage = message;
      return new Promise((resolve) => { releaseProcess = resolve; });
    }
  });
  const runtime = createVisualCaptureRuntime(deps);
  const pending = runtime.handle(request, 41);
  while (!releaseProcess) await Promise.resolve();
  const retained = retainedMessage as { screenshotDataUrl: string } | null;
  if (!retained) throw new Error("missing retained process message");
  assert.equal(retained.screenshotDataUrl, "",
    "the service worker drops its process-message PNG reference immediately after synchronous cloning");
  await runtime.endSession();
  const finish = releaseProcess as ((value: unknown) => void) | null;
  if (!finish) throw new Error("missing retained-message resolver");
  finish({ accepted: false, evidence: null });
  await pending;
}

{
  let authorizationCalls = 0;
  let releaseAuthorization: (() => void) | null = null;
  let clears = 0;
  const sensitiveScreenshot = capturedScreenshot("data:image/png;base64,iVBORw0KGgo=", () => {
    clears += 1;
  });
  const { deps } = dependencies({
    authorize: async () => {
      authorizationCalls += 1;
      if (authorizationCalls === 4) {
        await new Promise<void>((resolve) => { releaseAuthorization = resolve; });
      }
      return authorization;
    },
    captureVisibleTab: async () => sensitiveScreenshot
  });
  const runtime = createVisualCaptureRuntime(deps);
  const pending = runtime.handle(request, 41);
  while (!releaseAuthorization) await Promise.resolve();
  const ending = runtime.endSession();
  assert.equal(clears, 1,
    "end synchronously clears a service-worker PNG holder during post-capture authorization");
  const finish = releaseAuthorization as (() => void) | null;
  if (!finish) throw new Error("missing deferred authorization resolver");
  finish();
  await ending;
  assert.deepEqual(await pending, { accepted: false });
}

{
  let thrownMessage: { screenshotDataUrl: string } | null = null;
  const { deps } = dependencies({
    processOffscreen: (message) => {
      thrownMessage = message;
      throw new Error("synchronous sendMessage failure");
    }
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false });
  const retained = thrownMessage as { screenshotDataUrl: string } | null;
  if (!retained) throw new Error("missing thrown process message");
  assert.equal(retained.screenshotDataUrl, "",
    "a synchronous sendMessage failure still clears the message PNG reference");
}

{
  let processCalls = 0;
  let releaseFirst: ((value: unknown) => void) | null = null;
  const { deps } = dependencies({
    processOffscreen: () => {
      processCalls += 1;
      if (processCalls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve({ accepted: true, evidence });
    }
  });
  const runtime = createVisualCaptureRuntime(deps);
  const stale = runtime.handle(request, 41);
  while (!releaseFirst) await Promise.resolve();
  await runtime.endSession();
  const replacement = runtime.handle(request, 41);
  for (let index = 0; index < 20 && processCalls < 2; index += 1) await Promise.resolve();
  assert.equal(processCalls, 2,
    "a replacement generation has a fresh queue and does not wait for an old hung offscreen call");
  assert.deepEqual(await replacement, { accepted: true, evidence });
  const finish = releaseFirst as ((value: unknown) => void) | null;
  if (!finish) throw new Error("missing old-generation resolver");
  finish({ accepted: true, evidence });
  assert.deepEqual(await stale, { accepted: false });
}

{
  let active = 0;
  let maximum = 0;
  const { deps } = dependencies({
    processOffscreen: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { accepted: true, evidence };
    }
  });
  const runtime = createVisualCaptureRuntime(deps);
  await Promise.all([runtime.handle(request, 41), runtime.handle(request, 41)]);
  assert.equal(maximum, 1, "capture/OCR ownership is serialized per service worker");
}

{
  const { deps } = dependencies({
    processOffscreen: async () => ({
      accepted: true,
      evidence: { ...evidence, contentBase64: "raw comment text must not pass" }
    }),
    validateEvidence: async () => null
  });
  assert.deepEqual(await createVisualCaptureRuntime(deps).handle(request, 41), { accepted: false },
    "the service worker rejects malformed offscreen evidence before content sees it");
}

console.log("visual capture runtime self-test passed");
