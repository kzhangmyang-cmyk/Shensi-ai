import { strict as assert } from "node:assert";
import {
  createVisualReaderApi,
  VisualReaderApiError,
  type VisualObservationSubmission,
  type VisualReaderSession
} from "./visual-reader-api";

const timestamp = "2026-08-15T08:00:00.000Z";

function session(overrides: Partial<VisualReaderSession> = {}): VisualReaderSession {
  return {
    sessionId: "visual-session-1",
    runId: "run-1",
    planId: "plan-1",
    planVersionId: "plan-version-1",
    platform: "douyin",
    coverage: "authorized_visible_top_level_sample",
    status: "created",
    artifactUploadEnabled: true,
    limits: {
      maxVideos: 10,
      maxCommentsPerVideo: 30,
      maxScrolls: 5,
      maxOcrCalls: 10,
      maxDurationMs: 120_000
    },
    usage: {
      videoCount: 0,
      observationCount: 0,
      scrollCount: 0,
      ocrCallCount: 0,
      domObservationCount: 0,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0
    },
    outcome: null,
    lastErrorCode: null,
    createdAt: timestamp,
    authorizedAt: timestamp,
    updatedAt: timestamp,
    expiresAt: "2026-08-15T08:02:00.000Z",
    completedAt: null,
    ...overrides
  };
}

const observation: VisualObservationSubmission = {
  clientObservationKey: "client-observation-1",
  sourceUrl: "https://www.douyin.com/video/123456789",
  videoId: "123456789",
  visibleText: "想了解企业获客方案",
  domTextHash: `sha256:${"1".repeat(64)}`,
  ocrTextHash: null,
  displayName: "林经理",
  visibleTimeText: "1小时前",
  likeCount: 2,
  replyCount: 0,
  platformCommentId: "987654321",
  publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
  secUid: "MS4wLjABAAAA",
  extractionMethod: "dom",
  fieldConfidences: { visibleText: 0.99, platformCommentId: 0.98 },
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  cardBounds: { x: 720, y: 220, width: 520, height: 140 },
  readerVersion: "goodjob-visual-reader/1.0.0",
  capturedAt: timestamp,
  redactedCrop: null
};

function ocrObservation(
  clientObservationKey: string,
  maskedRegions: Array<{ x: number; y: number; width: number; height: number }>
): VisualObservationSubmission {
  return {
    ...observation,
    clientObservationKey,
    domTextHash: null,
    ocrTextHash: `sha256:${"2".repeat(64)}`,
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    extractionMethod: "ocr",
    fieldConfidences: { visibleText: 0.94 },
    redactedCrop: {
      mediaType: "image/webp",
      contentBase64: "AAAA",
      redactionProof: {
        version: "opaque-rect-v1",
        maskColorRgba: [17, 61, 51, 255],
        avatarBounds: { x: 0, y: 0, width: 4, height: 2 },
        visibleRegions: [{ x: 4, y: 0, width: 4, height: 2 }],
        maskedRegions
      }
    }
  };
}

const minimalWebp = new Uint8Array([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80
]);

{
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const path = String(input);
    if (path === "/api/v1/acquisition/visual-reader-artifacts/artifact-1") {
      return new Response(minimalWebp, {
        headers: { "Content-Type": "image/webp" }
      });
    }
    if (path.endsWith("/observations:batch")) {
      return Response.json({
        session: session({ status: "collecting" }),
        accepted: [],
        duplicates: []
      });
    }
    if (path.endsWith(":complete")) {
      return Response.json(session({
        status: "completed",
        completedAt: "2026-08-15T08:01:00.000Z",
        outcome: {
          status: "completed",
          videoCount: 0,
          observationCount: 0,
          domObservationCount: 0,
          accessibilityObservationCount: 0,
          ocrObservationCount: 0,
          lowConfidenceObservationCount: 0,
          artifactCount: 0,
          errorCodes: []
        }
      }));
    }
    if (path.endsWith(":abort")) {
      return Response.json(session({
        status: "aborted",
        completedAt: "2026-08-15T08:01:00.000Z",
        outcome: {
          status: "aborted",
          videoCount: 0,
          observationCount: 0,
          domObservationCount: 0,
          accessibilityObservationCount: 0,
          ocrObservationCount: 0,
          lowConfidenceObservationCount: 0,
          artifactCount: 0,
          errorCodes: []
        }
      }));
    }
    return Response.json(session(), { status: path.endsWith("sessions") ? 201 : 200 });
  };
  const api = createVisualReaderApi(fetchImpl, { cookie: "gj_csrf=csrf%20token" });

  await api.createSession({ runId: "run-1", artifactUploadEnabled: true }, "create-key-1");
  await api.getSession("visual-session-1");
  await api.appendObservationBatch(
    "visual-session-1",
    { observations: [observation] },
    "batch-key-1"
  );
  await api.completeSession(
    "visual-session-1",
    { status: "completed", errorCodes: [] },
    "complete-key-1"
  );
  await api.abortSession(
    "visual-session-1",
    { reasonCode: "user_requested" },
    "abort-key-1"
  );
  const artifact = await api.getArtifact("artifact-1");

  assert.deepEqual(calls.map((call) => call.input), [
    "/api/v1/acquisition/visual-reader-sessions",
    "/api/v1/acquisition/visual-reader-sessions/visual-session-1",
    "/api/v1/acquisition/visual-reader-sessions/visual-session-1/observations:batch",
    "/api/v1/acquisition/visual-reader-sessions/visual-session-1:complete",
    "/api/v1/acquisition/visual-reader-sessions/visual-session-1:abort",
    "/api/v1/acquisition/visual-reader-artifacts/artifact-1"
  ]);
  for (const call of calls) {
    assert.equal(call.init?.credentials, "same-origin");
  }
  assert.equal(new Headers(calls[0]?.init?.headers).get("X-CSRF-Token"), "csrf token");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), "create-key-1");
  assert.equal(new Headers(calls[2]?.init?.headers).get("Idempotency-Key"), "batch-key-1");
  assert.equal(new Headers(calls[3]?.init?.headers).get("Idempotency-Key"), "complete-key-1");
  assert.equal(new Headers(calls[4]?.init?.headers).get("Idempotency-Key"), "abort-key-1");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    runId: "run-1",
    artifactUploadEnabled: true
  });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    observations: [observation]
  });
  assert.equal(artifact.mediaType, "image/webp");
  assert.equal(artifact.content.byteLength, minimalWebp.byteLength);
}

{
  let fetchCount = 0;
  const api = createVisualReaderApi(async () => {
    fetchCount += 1;
    return Response.json({
      session: session({ status: "collecting" }),
      accepted: [],
      duplicates: []
    });
  }, { cookie: "gj_csrf=csrf" });
  const unionCovered = ocrObservation("ocr-union-covered", [
    { x: 0, y: 0, width: 2, height: 2 },
    { x: 2, y: 0, width: 2, height: 2 }
  ]);
  await api.appendObservationBatch(
    "visual-session-1",
    { observations: [unionCovered] },
    "union-covered"
  );
  assert.equal(fetchCount, 1, "a geometric union may fully cover the avatar");

  const gapInMask = ocrObservation("ocr-mask-gap", [
    { x: 0, y: 0, width: 1, height: 2 },
    { x: 2, y: 0, width: 2, height: 2 }
  ]);
  await assert.rejects(
    () => api.appendObservationBatch(
      "visual-session-1",
      { observations: [gapInMask] },
      "mask-gap"
    ),
    /视觉观察批次无效/u
  );
  assert.equal(fetchCount, 1, "an uncovered avatar must be rejected before fetch");

  const sixCrops = Array.from({ length: 6 }, (_, index) => ocrObservation(
    `ocr-crop-${index}`,
    [{ x: 0, y: 0, width: 4, height: 2 }]
  ));
  await assert.rejects(
    () => api.appendObservationBatch(
      "visual-session-1",
      { observations: sixCrops },
      "six-crops"
    ),
    /视觉观察批次无效/u
  );
  assert.equal(fetchCount, 1, "more than five crops must be rejected before fetch");

  const browserConfigured = Object.assign({}, unionCovered, {
    browserConfig: "BROWSER_CONFIG_SENTINEL"
  });
  await assert.rejects(
    () => api.appendObservationBatch(
      "visual-session-1",
      { observations: [browserConfigured] },
      "browser-config"
    ),
    /视觉观察批次无效/u
  );
  assert.equal(fetchCount, 1, "undeclared browser configuration must be rejected before fetch");
}

{
  for (const [name, contentType, bytes] of [
    ["wrong MIME", "application/octet-stream", minimalWebp],
    ["spoofed WebP", "image/webp", new Uint8Array([
      82, 73, 70, 70, 4, 0, 0, 0, 70, 65, 75, 69
    ])],
    ["wrong RIFF length", "image/webp", new Uint8Array([
      82, 73, 70, 70, 99, 0, 0, 0, 87, 69, 66, 80
    ])]
  ] as const) {
    const api = createVisualReaderApi(async () => new Response(bytes, {
      headers: { "Content-Type": contentType }
    }), { cookie: "gj_csrf=csrf" });
    await assert.rejects(
      () => api.getArtifact("artifact-1"),
      /服务端返回了无效的视觉读取制品/u,
      name
    );
  }
}

{
  const batchKeys: string[] = [];
  let attempts = 0;
  const api = createVisualReaderApi(async (_input, init) => {
    batchKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    attempts += 1;
    if (attempts === 1) throw new TypeError("network unavailable");
    return Response.json({
      session: session({ status: "collecting" }),
      accepted: [],
      duplicates: [observation.clientObservationKey]
    });
  }, { cookie: "gj_csrf=csrf" });

  await assert.rejects(
    () => api.appendObservationBatch(
      "visual-session-1",
      { observations: [observation] },
      "stable-batch-key"
    ),
    /network unavailable/
  );
  await api.appendObservationBatch(
    "visual-session-1",
    { observations: [observation] },
    "stable-batch-key"
  );
  assert.deepEqual(batchKeys, ["stable-batch-key", "stable-batch-key"]);
}

{
  const api = createVisualReaderApi(async () => Response.json({
    error: {
      code: "visual_observation_invalid",
      message: "rejected <script>raw client input</script>"
    }
  }, { status: 422 }), { cookie: "gj_csrf=csrf" });
  await assert.rejects(
    () => api.createSession({ runId: "run-1", artifactUploadEnabled: false }, "create-key"),
    (error: unknown) => {
      assert.ok(error instanceof VisualReaderApiError);
      assert.equal(error.code, "visual_observation_invalid");
      assert.equal(error.message, "视觉读取数据未通过安全校验");
      assert.doesNotMatch(error.message, /script|raw client input/u);
      return true;
    }
  );
}

{
  const api = createVisualReaderApi(async () => Response.json({
    ...session(),
    internalCiphertext: "must-not-be-accepted"
  }), { cookie: "gj_csrf=csrf" });
  await assert.rejects(
    () => api.getSession("visual-session-1"),
    /服务端返回了无效的视觉读取会话/u
  );
}
