import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  AcquisitionPlanRunRepository,
  AcquisitionPlanVersion,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-sessions.js";
import {
  AcquisitionVisualReaderService,
  AcquisitionVisualReaderServiceError,
  type VisualObservationSubmission
} from "./acquisition-visual-reader-service.js";

const NOW = "2026-08-15T01:00:00.000Z";
const SCOPE = { ownerId: "owner-service", teamId: "team-service", actorId: "owner-service" };
const REPOSITORY_SCOPE = { ownerId: SCOPE.ownerId, teamId: SCOPE.teamId };
const SECRET = "visual-reader-service-purpose-secret-at-least-32-bytes";

function digest(value: string | Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function run(overrides: Partial<AcquisitionRun> = {}): AcquisitionRun {
  return {
    id: "run-service",
    ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId,
    planId: "plan-service",
    planVersionId: "plan-version-service",
    planVersion: 1,
    planSnapshotHash: digest("plan"),
    parentRunId: null,
    status: "running",
    terminationIntent: null,
    revision: 1,
    etag: '"run-service:1"',
    budgetSnapshotId: "budget-service",
    budgetSnapshot: { billingCurrency: "CNY", maxRequests: 10, maxResults: 10, maxAmountMinor: 0, maxDurationSeconds: 120 },
    budgetSnapshotHash: digest("budget"),
    billingCurrency: "CNY",
    modelSnapshotRef: {
      jobSnapshotId: "job", connectionId: "connection", credentialVersion: 1,
      provider: "openai", model: "model", capabilitySnapshotHash: digest("capability"),
      promptVersion: "v1", schemaVersion: "v1", promptHash: digest("prompt"), schemaHash: digest("schema")
    },
    consumedBudget: { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 },
    evidenceCount: 0,
    reason: null,
    createdBy: SCOPE.actorId,
    createdAt: NOW,
    updatedBy: SCOPE.actorId,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  };
}

function version(overrides: Partial<AcquisitionPlanVersion> = {}): AcquisitionPlanVersion {
  return {
    id: "plan-version-service",
    planId: "plan-service",
    ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId,
    version: 1,
    payload: {
      targetPlatform: "douyin",
      douyinPublicCommentSample: { enabled: true, maxVideosPerRun: 4, maxCommentsPerVideo: 7, maxPagesPerVideo: 3 },
      name: "visual plan",
      objective: "read visible comments",
      icp: { industries: ["trade"], regions: ["CN"], organizationCriteria: ["fit"], individualCriteria: ["need"], exclusionRules: [] },
      subjectChannels: { organization: false, individual: true },
      providerConnections: [{ connectionId: "connection", providerId: "experimental_public_sample", kind: "content_fetch", status: "active", credentialVersion: 1 }],
      operations: [],
      budgetSnapshot: { billingCurrency: "CNY", maxRequests: 10, maxResults: 10, maxAmountMinor: 0, maxDurationSeconds: 120 },
      modelSnapshotRef: run().modelSnapshotRef,
      stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
    },
    payloadHash: digest("payload"),
    createdBy: SCOPE.actorId,
    createdAt: NOW,
    ...overrides
  };
}

function observation(overrides: Partial<VisualObservationSubmission> = {}): VisualObservationSubmission {
  const result: VisualObservationSubmission = {
    clientObservationKey: "client-observation-1",
    sourceUrl: "https://www.douyin.com/video/123456789",
    videoId: "123456789",
    visibleText: "  visible buyer need  ",
    domTextHash: digest("visible buyer need"),
    ocrTextHash: null,
    displayName: "public name",
    visibleTimeText: "1小时前",
    likeCount: 2,
    replyCount: 0,
    platformCommentId: null,
    publicProfileUrl: "https://www.douyin.com/user/secUidPublic",
    secUid: "secUidPublic",
    extractionMethod: "dom",
    fieldConfidences: { visibleText: 0.99, displayName: 0.95 },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    cardBounds: { x: 20, y: 30, width: 400, height: 120 },
    readerVersion: "reader.v1",
    capturedAt: "2026-08-15T01:00:01.000Z",
    redactedCrop: null,
    ...overrides
  };
  if (overrides.visibleText !== undefined && overrides.domTextHash === undefined) {
    result.domTextHash = digest(overrides.visibleText.trim());
  }
  return result;
}

function planRepository(runValue = run(), versionValue = version()) {
  return {
    async getRun(id: string) { return id === runValue.id ? structuredClone(runValue) : null; },
    async getPlanVersion(id: string) { return id === versionValue.id ? structuredClone(versionValue) : null; }
  } as Pick<AcquisitionPlanRunRepository, "getRun" | "getPlanVersion">;
}

function service(input: {
  run?: AcquisitionRun;
  version?: AcquisitionPlanVersion;
  onArtifactValidate?: () => void;
} = {}) {
  const repository = new InMemoryAcquisitionVisualReaderRepository({
    masterSecret: SECRET,
    now: () => NOW
  });
  return {
    repository,
    value: new AcquisitionVisualReaderService({
      repository,
      planRunRepository: planRepository(input.run ?? run(), input.version ?? version()),
      purposeSecret: SECRET,
      now: () => NOW,
      artifactValidator: {
        async validate(candidate: { bytes: Buffer }) {
          input.onArtifactValidate?.();
          return { bytes: candidate.bytes, width: 400, height: 120, maskedRegionCount: 1 };
        }
      }
    })
  };
}

function serviceError(code: string, status: number) {
  return (error: unknown) => error instanceof AcquisitionVisualReaderServiceError
    && error.code === code && error.status === status;
}

test("create derives immutable Run/Plan binding, limits, clocks and concurrent idempotency", async () => {
  const { value } = service();
  const [left, right] = await Promise.all([
    value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: true }, "raw-create-key"),
    value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: true }, "raw-create-key")
  ]);
  assert.equal([left, right].filter((item) => item.created).length, 1);
  assert.equal(left.session.sessionId, right.session.sessionId);
  assert.equal(left.session.sessionId.includes("raw-create-key"), false);
  assert.deepEqual(left.session.limits, {
    maxVideos: 4,
    maxCommentsPerVideo: 7,
    maxScrolls: 5,
    maxOcrCalls: 10,
    maxDurationMs: 120_000
  });
  assert.equal(left.session.planId, "plan-service");
  assert.equal(left.session.planVersionId, "plan-version-service");
  assert.equal(left.session.authorizedAt, NOW);
  assert.equal(left.session.expiresAt, "2026-08-15T01:02:00.000Z");

  await assert.rejects(
    value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, "raw-create-key"),
    serviceError("idempotency_conflict", 409)
  );

  const otherRun = run({ id: "run-service-other" });
  const other = await service({ run: otherRun }).value.createSession(
    SCOPE,
    { runId: otherRun.id, artifactUploadEnabled: true },
    "raw-create-key"
  );
  assert.notEqual(other.session.sessionId, left.session.sessionId);
});

test("create hides missing/cross-tenant Runs and rejects disabled, non-Douyin, and terminal Runs", async () => {
  const crossTenant = run({ ownerId: "other-owner" });
  await assert.rejects(
    service({ run: crossTenant }).value.createSession(SCOPE, { runId: crossTenant.id, artifactUploadEnabled: false }, "key"),
    serviceError("resource_not_found", 404)
  );
  await assert.rejects(
    service({ version: version({ payload: { ...version().payload, douyinPublicCommentSample: { ...version().payload.douyinPublicCommentSample!, enabled: false } } }) }).value
      .createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, "key"),
    serviceError("visual_reader_not_enabled", 409)
  );
  await assert.rejects(
    service({ version: version({ payload: { ...version().payload, targetPlatform: "web" } }) }).value
      .createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, "key"),
    serviceError("visual_reader_not_enabled", 409)
  );
  await assert.rejects(
    service({ run: run({ status: "succeeded", completedAt: NOW }) }).value
      .createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, "key"),
    serviceError("visual_reader_not_enabled", 409)
  );
});

test("batch enforces dynamic source/profile equality and disables vision before persistence", async () => {
  for (const [candidate, code] of [
    [observation({ videoId: "999999999" }), "visual_source_invalid"],
    [observation({ secUid: "otherSecUid" }), "visual_observation_invalid"],
    [observation({ domTextHash: digest("different DOM text") }), "visual_observation_invalid"],
    [observation({
      extractionMethod: "ocr",
      ocrTextHash: digest("different OCR text"),
      platformCommentId: null,
      publicProfileUrl: null,
      secUid: null
    }), "visual_observation_invalid"],
    [observation({ extractionMethod: "vision" }), "visual_extraction_method_disabled"]
  ] as const) {
    const { value, repository } = service();
    const created = await value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, `create-${code}`);
    await assert.rejects(value.appendObservationBatch(
      SCOPE,
      created.session.sessionId,
      { observations: [candidate] },
      `batch-${code}`
    ), serviceError(code, 400));
    assert.deepEqual(await repository.listRunObservations(REPOSITORY_SCOPE, "run-service", { limit: 10 }), []);
  }
});

test("pure DOM may omit a crop but OCR fails closed without its redaction proof", async () => {
  const { value } = service();
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: true },
    "create-method-crop"
  );
  const dom = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [observation({ clientObservationKey: "dom-no-crop" })] },
    "dom-no-crop"
  );
  assert.equal(dom.response.accepted.length, 1);
  await assert.rejects(value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [observation({
      clientObservationKey: "ocr-no-crop",
      extractionMethod: "ocr",
      ocrTextHash: digest("visible buyer need"),
      fieldConfidences: { visibleText: 0.95 },
      platformCommentId: null,
      publicProfileUrl: null,
      secUid: null,
      redactedCrop: null
    })] },
    "ocr-no-crop"
  ), serviceError("visual_artifact_invalid", 400));
});

test("OCR cannot assert DOM-only comment or public-profile identity", async () => {
  const crop = {
    mediaType: "image/webp" as const,
    contentBase64: Buffer.from("redacted-ocr-crop").toString("base64"),
    redactionProof: {
      version: "opaque-rect-v1" as const,
      maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
      avatarBounds: null,
      visibleRegions: [{ x: 1, y: 1, width: 10, height: 10 }],
      maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
    }
  };
  for (const identity of [
    { platformCommentId: "123456789" },
    { publicProfileUrl: "https://www.douyin.com/user/ocrClaim" },
    { secUid: "ocrClaim" }
  ]) {
    const { value, repository } = service();
    const created = await value.createSession(
      SCOPE,
      { runId: "run-service", artifactUploadEnabled: true },
      `create-ocr-identity-${Object.keys(identity)[0]}`
    );
    await assert.rejects(value.appendObservationBatch(
      SCOPE,
      created.session.sessionId,
      {
        observations: [observation({
          clientObservationKey: `ocr-identity-${Object.keys(identity)[0]}`,
          extractionMethod: "ocr",
          ocrTextHash: digest("visible buyer need"),
          fieldConfidences: { visibleText: 0.95 },
          platformCommentId: null,
          publicProfileUrl: null,
          secUid: null,
          redactedCrop: crop,
          ...identity
        })]
      },
      `ocr-identity-${Object.keys(identity)[0]}`
    ), serviceError("visual_observation_invalid", 400));
    assert.deepEqual(await repository.listRunObservations(
      REPOSITORY_SCOPE,
      "run-service",
      { limit: 10 }
    ), []);
  }

  const { value } = service();
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: true },
    "create-valid-ocr"
  );
  const accepted = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    {
      observations: [observation({
        clientObservationKey: "valid-ocr",
        extractionMethod: "ocr",
        ocrTextHash: digest("visible buyer need"),
        fieldConfidences: { visibleText: 0.95 },
        platformCommentId: null,
        publicProfileUrl: null,
        secUid: null,
        redactedCrop: crop
      })]
    },
    "valid-ocr"
  );
  assert.equal(accepted.response.accepted.length, 1);
});

test("batch normalizes server-owned IDs and hashes and durably binds the header request", async () => {
  const { value, repository } = service();
  const created = await value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: false }, "create-batch");
  const submission = observation();
  const first = await value.appendObservationBatch(SCOPE, created.session.sessionId, {
    observations: [submission]
  }, "raw-batch-key");
  assert.equal(first.replayed, false);
  assert.deepEqual(Object.keys(first.response).sort(), ["accepted", "duplicates", "session"]);
  assert.equal(first.response.accepted[0]?.observation.visibleText, "visible buyer need");
  assert.equal(first.response.accepted[0]?.observation.textHash, digest("visible buyer need"));
  assert.equal(first.response.accepted[0]?.observation.sessionId, created.session.sessionId);
  assert.match(first.response.accepted[0]?.observation.observationId ?? "", /^visual-observation:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(first.response).includes("raw-batch-key"), false);

  const replay = await value.appendObservationBatch(SCOPE, created.session.sessionId, {
    observations: [structuredClone(submission)]
  }, "raw-batch-key");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);

  await assert.rejects(value.appendObservationBatch(SCOPE, created.session.sessionId, {
    observations: [observation({ visibleText: "different request" })]
  }, "raw-batch-key"), serviceError("idempotency_conflict", 409));
  assert.equal((await repository.getSession(REPOSITORY_SCOPE, created.session.sessionId))?.usage.observationCount, 1);
});

test("fresh and replayed batches share the ruled manual-review predicate", async () => {
  const { value } = service();
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: true },
    "create-manual-predicate"
  );
  const bytes = Buffer.from("validated-redacted-webp");
  const crop = {
    mediaType: "image/webp" as const,
    contentBase64: bytes.toString("base64"),
    redactionProof: {
      version: "opaque-rect-v1" as const,
      maskColorRgba: [17, 61, 51, 255] as [number, number, number, number],
      avatarBounds: null,
      visibleRegions: [{ x: 1, y: 1, width: 10, height: 10 }],
      maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
    }
  };
  const ocr = (clientObservationKey: string, visibleText: string,
    confidence: number, domTextHash: string | null) => observation({
    clientObservationKey,
    visibleText,
    extractionMethod: "ocr",
    fieldConfidences: { visibleText: confidence },
    domTextHash,
    ocrTextHash: digest(visibleText),
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    redactedCrop: crop
  });
  const body = { observations: [
    observation({
      clientObservationKey: "manual-missing-confidence",
      visibleText: "missing metadata confidence",
      fieldConfidences: { visibleText: 0.99 }
    }),
    observation({
      clientObservationKey: "manual-conflicting-hashes",
      visibleText: "conflicting source hashes",
      ocrTextHash: digest("different OCR text")
    }),
    ocr("manual-low-ocr", "low OCR confidence", 0.89, null),
    ocr("manual-truncated-ocr", "truncated OCR source", 0.95,
      digest("truncated DOM text"))
  ] };
  const fresh = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    body,
    "manual-predicate-batch"
  );
  assert.equal(fresh.replayed, false);
  assert.deepEqual(new Set(fresh.manualReviewOnlyObservationIds), new Set(
    fresh.response.accepted.map(({ observation: item }) => item.observationId)
  ));
  const replay = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    structuredClone(body),
    "manual-predicate-batch"
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.manualReviewOnlyObservationIds,
    fresh.manualReviewOnlyObservationIds);
});

test("capturedAt must stay inside authorization and crop bytes become only a hashed artifact fact", async () => {
  let validationCalls = 0;
  const { value, repository } = service({
    onArtifactValidate: () => { validationCalls += 1; }
  });
  const created = await value.createSession(SCOPE, { runId: "run-service", artifactUploadEnabled: true }, "create-artifact");
  await assert.rejects(value.appendObservationBatch(SCOPE, created.session.sessionId, {
    observations: [observation({ capturedAt: "2026-08-15T01:02:00.001Z" })]
  }, "captured-outside"), serviceError("visual_observation_invalid", 400));

  const bytes = Buffer.from("validated-redacted-webp");
  const cropSubmission = observation({
    clientObservationKey: "crop-observation",
    redactedCrop: {
      mediaType: "image/webp",
      contentBase64: bytes.toString("base64"),
      redactionProof: {
        version: "opaque-rect-v1",
        maskColorRgba: [17, 61, 51, 255],
        avatarBounds: null,
        visibleRegions: [{ x: 1, y: 1, width: 10, height: 10 }],
        maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
      }
    }
  });
  const appended = await value.appendObservationBatch(SCOPE, created.session.sessionId, {
    observations: [cropSubmission]
  }, "crop-batch");
  const replay = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [structuredClone(cropSubmission)] },
    "crop-batch"
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, appended.response);
  assert.equal(validationCalls, 1, "exact replay must skip artifact validation");
  const normalized = appended.response.accepted[0]?.observation;
  assert.equal(normalized?.redactedCropHash, digest(bytes));
  assert.equal(normalized?.domTextHash, cropSubmission.domTextHash);
  assert.equal(normalized?.ocrTextHash, cropSubmission.ocrTextHash);
  assert.equal(JSON.stringify(appended.response).includes(bytes.toString("base64")), false);
  const artifactId = `visual-artifact:${normalized?.observationId.split(":")[1]}`;
  assert.deepEqual((await repository.getArtifact(REPOSITORY_SCOPE, artifactId))?.plaintext, bytes);
});

test("get, complete, abort and terminal batch replay are scoped and exact", async () => {
  const completedService = service();
  const completedCreated = await completedService.value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: false },
    "create-complete"
  );
  const batch = await completedService.value.appendObservationBatch(
    SCOPE,
    completedCreated.session.sessionId,
    { observations: [observation({ clientObservationKey: "terminal-replay" })] },
    "terminal-replay"
  );
  const completed = await completedService.value.completeSession(
    SCOPE,
    completedCreated.session.sessionId,
    { status: "completed", errorCodes: [] }
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(await completedService.value.getSession(
    SCOPE,
    completedCreated.session.sessionId
  ), completed);
  assert.deepEqual(await completedService.value.completeSession(
    SCOPE,
    completedCreated.session.sessionId,
    { status: "completed", errorCodes: [] }
  ), completed);
  await assert.rejects(completedService.value.completeSession(
    SCOPE,
    completedCreated.session.sessionId,
    { status: "partial_success", errorCodes: ["visual_extraction_low_confidence"] }
  ), serviceError("idempotency_conflict", 409));
  const terminalReplay = await completedService.value.appendObservationBatch(
    SCOPE,
    completedCreated.session.sessionId,
    { observations: [observation({ clientObservationKey: "terminal-replay" })] },
    "terminal-replay"
  );
  assert.equal(terminalReplay.replayed, true);
  assert.deepEqual(terminalReplay.response, batch.response);
  await assert.rejects(completedService.value.appendObservationBatch(
    SCOPE,
    completedCreated.session.sessionId,
    { observations: [observation({ clientObservationKey: "terminal-new" })] },
    "terminal-new"
  ), serviceError("visual_reader_terminal", 409));

  const abortedService = service();
  const abortedCreated = await abortedService.value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: false },
    "create-abort"
  );
  const aborted = await abortedService.value.abortSession(
    SCOPE,
    abortedCreated.session.sessionId,
    { reasonCode: "visual_reader_user_takeover" }
  );
  assert.equal(aborted.status, "aborted");
  assert.deepEqual(aborted.outcome?.errorCodes, ["visual_reader_user_takeover"]);
  assert.deepEqual(await abortedService.value.abortSession(
    SCOPE,
    abortedCreated.session.sessionId,
    { reasonCode: "visual_reader_user_takeover" }
  ), aborted);
  await assert.rejects(abortedService.value.getSession(
    { ...SCOPE, ownerId: "other-owner" },
    abortedCreated.session.sessionId
  ), serviceError("resource_not_found", 404));
});

test("artifact reads are tenant isolated and expired artifacts are absent", async () => {
  const { value, repository } = service();
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: true },
    "artifact-scope"
  );
  const bytes = Buffer.from("scoped-redacted-webp");
  const appended = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [observation({
      clientObservationKey: "artifact-scope",
      redactedCrop: {
        mediaType: "image/webp",
        contentBase64: bytes.toString("base64"),
        redactionProof: {
          version: "opaque-rect-v1",
          maskColorRgba: [17, 61, 51, 255],
          avatarBounds: null,
          visibleRegions: [{ x: 1, y: 1, width: 10, height: 10 }],
          maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
        }
      }
    })] },
    "artifact-scope"
  );
  const observationId = appended.response.accepted[0]!.observation.observationId;
  const artifactId = `visual-artifact:${observationId.split(":")[1]}`;
  assert.deepEqual((await value.getArtifact(SCOPE, artifactId)).plaintext, bytes);
  await assert.rejects(value.getArtifact(
    { ...SCOPE, teamId: "other-team" },
    artifactId
  ), serviceError("resource_not_found", 404));
  await repository.deleteExpiredArtifacts({
    before: "2026-09-15T00:00:00.000Z",
    limit: 10
  });
  await assert.rejects(value.getArtifact(SCOPE, artifactId),
    serviceError("resource_not_found", 404));
});

test("batch is all-or-nothing and enforces 20 observations, five crops, and decoded aggregate", async () => {
  const roomyVersion = version({
    payload: {
      ...version().payload,
      douyinPublicCommentSample: {
        enabled: true,
        maxVideosPerRun: 10,
        maxCommentsPerVideo: 30,
        maxPagesPerVideo: 3
      }
    }
  });
  const { value, repository } = service({ version: roomyVersion });
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: true },
    "batch-bounds"
  );
  await assert.rejects(value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    {
      observations: [
        observation({
          clientObservationKey: "atomic-valid",
          visibleText: "atomic valid"
        }),
        observation({
          clientObservationKey: "atomic-invalid",
          videoId: "999999999"
        })
      ]
    },
    "atomic-invalid"
  ), serviceError("visual_source_invalid", 400));
  assert.deepEqual(await repository.listRunObservations(
    REPOSITORY_SCOPE,
    "run-service",
    { limit: 100 }
  ), []);

  await assert.rejects(value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    {
      observations: Array.from({ length: 21 }, (_, index) => observation({
        clientObservationKey: `too-many-${index}`,
        visibleText: `too many ${index}`
      }))
    },
    "too-many"
  ), serviceError("visual_observation_invalid", 400));

  const maxCrop = Buffer.alloc(262_144);
  const redactedCrop = {
    mediaType: "image/webp" as const,
    contentBase64: maxCrop.toString("base64"),
    redactionProof: {
      version: "opaque-rect-v1" as const,
      maskColorRgba: [17, 61, 51, 255] as [17, 61, 51, 255],
      avatarBounds: null,
      visibleRegions: [{ x: 1, y: 1, width: 10, height: 10 }],
      maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
    }
  };
  await assert.rejects(value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    {
      observations: Array.from({ length: 6 }, (_, index) => observation({
        clientObservationKey: `six-crops-${index}`,
        visibleText: `six crops ${index}`,
        redactedCrop
      }))
    },
    "six-crops"
  ), serviceError("payload_too_large", 413));

  const accepted = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    {
      observations: Array.from({ length: 20 }, (_, index) => observation({
        clientObservationKey: `max-batch-${index}`,
        visibleText: `max batch ${index}`,
        redactedCrop: index < 5 ? redactedCrop : null
      }))
    },
    "max-batch"
  );
  assert.equal(accepted.response.accepted.length, 20);
  assert.equal(accepted.response.session.usage.artifactCount, 5);
  assert.equal(accepted.response.session.usage.observationCount, 20);
});

test("each accepted batch consumes one bounded capture cycle while replays do not", async () => {
  const { value, repository } = service();
  const created = await value.createSession(
    SCOPE,
    { runId: "run-service", artifactUploadEnabled: false },
    "create-capture-cycles"
  );
  const submissions = Array.from({ length: 6 }, (_, index) => observation({
    clientObservationKey: `capture-cycle-${index + 1}`,
    visibleText: `visible capture cycle ${index + 1}`
  }));

  for (let index = 0; index < 5; index += 1) {
    const result = await value.appendObservationBatch(
      SCOPE,
      created.session.sessionId,
      { observations: [submissions[index]!] },
      `capture-cycle-request-${index + 1}`
    );
    assert.equal(result.response.session.usage.scrollCount, index + 1);
  }

  const exactReplay = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [structuredClone(submissions[4]!)] },
    "capture-cycle-request-5"
  );
  assert.equal(exactReplay.replayed, true);
  assert.equal(exactReplay.response.session.usage.scrollCount, 5);

  const duplicate = await value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [structuredClone(submissions[4]!)] },
    "capture-cycle-duplicate-request"
  );
  assert.deepEqual(duplicate.response.accepted, []);
  assert.deepEqual(duplicate.response.duplicates, ["capture-cycle-5"]);
  assert.equal(duplicate.response.session.usage.scrollCount, 5);

  await assert.rejects(value.appendObservationBatch(
    SCOPE,
    created.session.sessionId,
    { observations: [submissions[5]!] },
    "capture-cycle-request-6"
  ), serviceError("visual_reader_budget_exhausted", 409));
  const stored = await repository.getSession(
    REPOSITORY_SCOPE,
    created.session.sessionId
  );
  assert.equal(stored?.usage.scrollCount, 5);
  assert.equal(stored?.usage.observationCount, 5);
});
