import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as visualSessionModule from "./acquisition-visual-reader-sessions.js";
import { AcquisitionDomainService } from "./acquisition-domain-service.js";
import { InMemoryAcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import {
  isSafeAcquisitionPublicActorKey,
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { createGrowthAcquisitionWorkspaceResolver } from "./growth-workspace-context.js";
import { InMemoryAcquisitionCandidateDirectory } from "./acquisition-tool-support-repositories.js";
import { AcquisitionIndividualSignalIngestionService } from "./acquisition-individual-signal-ingestion.js";
import { InMemoryAcquisitionDouyinCommentEventRepository } from "./acquisition-douyin-comment-events.js";
import { AcquisitionDouyinCommentIngestionService } from "./acquisition-douyin-comment-ingestion.js";
import {
  InMemoryAcquisitionDouyinCommentIngestionUnitOfWork,
  type AcquisitionDouyinCommentIngestionUnitOfWork
} from "./acquisition-douyin-comment-ingestion-unit-of-work.js";
import type {
  AcquisitionScope,
  DouyinVisualCommentObservationV1
} from "./acquisition-visual-reader-sessions.js";

const MASTER_SECRET =
  "task-7-visual-ingestion-test-secret-at-least-32-bytes";
const START = "2026-08-16T01:00:00.000Z";
const scope = { ownerId: "owner-visual-a", teamId: "team-visual-a" };

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function observation(
  id: string,
  overrides: Partial<DouyinVisualCommentObservationV1> = {}
): DouyinVisualCommentObservationV1 {
  const observationId = /^visual-observation:[a-f0-9]{64}$/u.test(id)
    ? id
    : `visual-observation:${digest(id).slice("sha256:".length)}`;
  const visibleText = overrides.visibleText ?? "我们正在采购 20 套，请报价";
  const extractionMethod = overrides.extractionMethod ?? "dom";
  return {
    observationId,
    sessionId: "visual-session-task-7",
    sourceUrl: "https://www.douyin.com/video/7536012345678909876",
    videoId: "7536012345678909876",
    visibleText,
    textHash: digest(visibleText),
    domTextHash: extractionMethod === "ocr" ? null : digest(visibleText),
    ocrTextHash: extractionMethod === "ocr" ? digest(visibleText) : null,
    displayName: "可见昵称",
    visibleTimeText: "2026-08-16T00:59:00.000Z",
    likeCount: 3,
    replyCount: 1,
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    extractionMethod,
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.96,
      visibleTimeText: 0.96,
      likeCount: 0.96,
      replyCount: 0.96
    },
    viewportHash: digest(`viewport:${observationId}`),
    cardBounds: { x: 10, y: 20, width: 400, height: 160 },
    redactedCropHash: null,
    readerVersion: "task-7-test-reader.v1",
    capturedAt: START,
    ...overrides
  };
}

function repository(now = START) {
  return new visualSessionModule.InMemoryAcquisitionVisualReaderRepository({
    masterSecret: MASTER_SECRET,
    now: () => now
  });
}

async function createSession(
  visualRepository: visualSessionModule.InMemoryAcquisitionVisualReaderRepository,
  selectedScope: AcquisitionScope = scope
) {
  await visualRepository.createSession({
    scope: selectedScope,
    sessionId: "visual-session-task-7",
    runId: "run-task-7",
    planId: "plan-task-7",
    planVersionId: "plan-version-task-7",
    artifactUploadEnabled: true,
    limits: {
      maxVideos: 2,
      maxCommentsPerVideo: 20,
      maxScrolls: 5,
      maxOcrCalls: 10,
      maxDurationMs: 120_000
    },
    createdAt: START,
    authorizedAt: START,
    expiresAt: "2026-08-16T01:02:00.000Z"
  });
}

test("shared manual-review predicate enforces the ruled DOM and OCR boundaries", () => {
  const predicate = (visualSessionModule as unknown as {
    visualObservationIsManualReviewOnly?: (
      value: DouyinVisualCommentObservationV1
    ) => boolean;
  }).visualObservationIsManualReviewOnly;
  assert.equal(typeof predicate, "function",
    "visualObservationIsManualReviewOnly must be the shared production predicate");

  const highDom = observation("visual-observation-high-dom");
  const lowDom = observation("visual-observation-low-dom", {
    fieldConfidences: { visibleText: 0.849 }
  });
  const highOcr = observation("visual-observation-high-ocr", {
    extractionMethod: "ocr",
    fieldConfidences: { visibleText: 0.9 },
    domTextHash: null,
    ocrTextHash: digest("我们正在采购 20 套，请报价")
  });
  const lowOcr = observation("visual-observation-low-ocr", {
    extractionMethod: "ocr",
    fieldConfidences: { visibleText: 0.899 },
    domTextHash: null,
    ocrTextHash: digest("我们正在采购 20 套，请报价")
  });
  const truncatedOcr = observation("visual-observation-truncated-ocr", {
    extractionMethod: "ocr",
    fieldConfidences: { visibleText: 0.99 },
    domTextHash: digest("截断 DOM"),
    ocrTextHash: digest("我们正在采购 20 套，请报价")
  });
  const equalSourceHashes = observation("visual-observation-equal-hashes", {
    domTextHash: digest("我们正在采购 20 套，请报价"),
    ocrTextHash: digest("我们正在采购 20 套，请报价")
  });
  const conflictingSourceHashes = observation(
    "visual-observation-conflicting-hashes",
    { ocrTextHash: digest("不同 OCR") }
  );

  assert.equal(predicate!(highDom), false);
  assert.equal(predicate!(lowDom), true);
  assert.equal(predicate!(highOcr), false);
  assert.equal(predicate!(lowOcr), true);
  assert.equal(predicate!(truncatedOcr), true);
  assert.equal(predicate!(equalSourceHashes), false);
  assert.equal(predicate!(conflictingSourceHashes), true);
  assert.equal(predicate!(observation("visual-observation-missing-display-confidence", {
    fieldConfidences: {
      visibleText: 0.99,
      visibleTimeText: 0.96,
      likeCount: 0.96,
      replyCount: 0.96
    }
  })), true);
  assert.equal(predicate!(observation("visual-observation-vision", {
    extractionMethod: "vision"
  })), true);

  for (const [field, value] of [
    ["displayName", "可见昵称"],
    ["visibleTimeText", "2026-08-16T00:59:00.000Z"],
    ["likeCount", 3],
    ["replyCount", 1],
    ["platformCommentId", "123456789"],
    ["publicProfileUrl", "https://www.douyin.com/user/verified-sec-uid"],
    ["secUid", "verified-sec-uid"]
  ] as const) {
    assert.equal(predicate!(observation(`visual-observation-low-${field}`, {
      [field]: value,
      fieldConfidences: { visibleText: 0.99, [field]: 0.849 }
    })), true, field);
  }
});

test("accepting a visual observation atomically queues one tenant-scoped ingestion item", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const acceptedObservation = observation("visual-observation-queued");
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: "visual-session-task-7",
    ingestionActorId: "actor-capture-task-7",
    observations: [{
      clientObservationKey: "client-observation-queued",
      observation: acceptedObservation
    }]
  } as Parameters<typeof visualRepository.appendObservationBatch>[0] & {
    ingestionActorId: string;
  });

  const workPort = visualRepository as unknown as {
    listRunIngestionWorkItems?: (
      selectedScope: AcquisitionScope,
      runId: string,
      options: { limit: number }
    ) => Promise<Array<Record<string, unknown>>>;
  };
  assert.equal(typeof workPort.listRunIngestionWorkItems, "function",
    "accepted observations need a durable work-item read boundary");
  const work = await workPort.listRunIngestionWorkItems!(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  assert.equal(work.length, 1);
  assert.deepEqual(work[0], {
    workItemId: `visual-ingestion:${acceptedObservation.observationId}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    actorId: "actor-capture-task-7",
    sessionId: "visual-session-task-7",
    runId: "run-task-7",
    observationId: acceptedObservation.observationId,
    artifactId: null,
    disposition: "automatic",
    status: "queued",
    attemptCount: 0,
    nextAttemptAt: START,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    evidenceId: null,
    platformEvidenceId: null,
    candidateId: null,
    createdAt: START,
    updatedAt: START,
    completedAt: null
  });

  assert.deepEqual(
    await workPort.listRunIngestionWorkItems!(
      { ownerId: "owner-other", teamId: scope.teamId },
      "run-task-7",
      { limit: 1_000 }
    ),
    []
  );

  const manual = observation("visual-observation-manual-disposition", {
    fieldConfidences: { visibleText: 0.80 }
  });
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: manual.sessionId,
    ingestionActorId: "actor-capture-task-7",
    observations: [{
      clientObservationKey: "client-manual-disposition",
      observation: manual
    }]
  });
  const allWork = await workPort.listRunIngestionWorkItems!(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  const manualWork = allWork.find((value) =>
    value.observationId === manual.observationId);
  assert.equal(manualWork?.status, "queued");
  assert.equal(manualWork?.disposition, "manual_review_only");
});

test("durable visual work claims are fair across tenants and retry with a lease", async () => {
  const now = { value: START };
  const visualRepository = new visualSessionModule
    .InMemoryAcquisitionVisualReaderRepository({
      masterSecret: MASTER_SECRET,
      now: () => now.value
    });
  const otherScope = { ownerId: "owner-visual-b", teamId: "team-visual-b" };
  await createSession(visualRepository, scope);
  await createSession(visualRepository, otherScope);
  for (const [selectedScope, id] of [
    [scope, "visual-observation-fair-a1"],
    [scope, "visual-observation-fair-a2"],
    [otherScope, "visual-observation-fair-b1"]
  ] as const) {
    await visualRepository.appendObservationBatch({
      scope: selectedScope,
      sessionId: "visual-session-task-7",
      ingestionActorId: `${selectedScope.ownerId}-actor`,
      observations: [{
        clientObservationKey: `client-${id}`,
        observation: observation(id)
      }]
    });
  }

  const workPort = visualRepository as unknown as {
    claimPendingIngestionWorkItems?: (input: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }) => Promise<Array<{
      workItem: Record<string, unknown>;
      observation: DouyinVisualCommentObservationV1;
    }>>;
    failIngestionWorkItem?: (
      selectedScope: AcquisitionScope,
      observationId: string,
      failure: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  };
  assert.equal(typeof workPort.claimPendingIngestionWorkItems, "function");
  assert.equal(typeof workPort.failIngestionWorkItem, "function");
  const claimed = await workPort.claimPendingIngestionWorkItems!({
    workerId: "visual-worker-1",
    now: START,
    leaseDurationMs: 30_000,
    limit: 2
  });
  assert.deepEqual(
    new Set(claimed.map(({ workItem }) =>
      `${workItem.ownerId}:${workItem.teamId}`)),
    new Set([
      `${scope.ownerId}:${scope.teamId}`,
      `${otherScope.ownerId}:${otherScope.teamId}`
    ])
  );
  assert.ok(claimed.every(({ workItem }) =>
    workItem.status === "running"
    && workItem.attemptCount === 1
    && workItem.leaseOwner === "visual-worker-1"
    && workItem.leaseExpiresAt === "2026-08-16T01:00:30.000Z"));

  const failed = claimed.find(({ workItem }) =>
    workItem.ownerId === scope.ownerId)!;
  const retry = await workPort.failIngestionWorkItem!(
    scope,
    failed.observation.observationId,
    {
      workerId: "visual-worker-1",
      leaseToken: failed.workItem.leaseToken,
      attemptCount: failed.workItem.attemptCount,
      failedAt: "2026-08-16T01:00:01.000Z",
      nextAttemptAt: "2026-08-16T01:00:02.000Z",
      errorCode: "RECOVERY_FAILED"
    }
  );
  assert.deepEqual({
    status: retry.status,
    leaseOwner: retry.leaseOwner,
    leaseExpiresAt: retry.leaseExpiresAt,
    lastErrorCode: retry.lastErrorCode,
    nextAttemptAt: retry.nextAttemptAt
  }, {
    status: "retry",
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: "RECOVERY_FAILED",
    nextAttemptAt: "2026-08-16T01:00:02.000Z"
  });

  now.value = "2026-08-16T01:00:01.500Z";
  const next = await workPort.claimPendingIngestionWorkItems!({
    workerId: "visual-worker-2",
    now: now.value,
    leaseDurationMs: 30_000,
    limit: 10
  });
  assert.equal(next.some(({ observation: item }) =>
    item.observationId === failed.observation.observationId), false);
});

test("visual work completion records only committed evidence and candidate facts", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const item = observation("visual-observation-complete");
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: item.sessionId,
    ingestionActorId: "actor-complete",
    observations: [{ clientObservationKey: "client-complete", observation: item }]
  });
  const workPort = visualRepository as unknown as {
    claimPendingIngestionWorkItems?: (input: Record<string, unknown>) => Promise<
      Array<{ workItem: Record<string, unknown> }>
    >;
    completeIngestionWorkItem?: (
      selectedScope: AcquisitionScope,
      observationId: string,
      result: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  };
  const [claimed] = await workPort.claimPendingIngestionWorkItems!({
    workerId: "visual-worker-complete",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(claimed?.workItem.status, "running");
  const completed = await workPort.completeIngestionWorkItem!(
    scope,
    item.observationId,
    {
      workerId: "visual-worker-complete",
      leaseToken: claimed!.workItem.leaseToken,
      attemptCount: claimed!.workItem.attemptCount,
      status: "succeeded",
      evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
      platformEvidenceId: null,
      candidateId: "candidate-visual-1",
      completedAt: "2026-08-16T01:00:01.000Z"
    }
  );
  assert.deepEqual({
    status: completed.status,
    evidenceId: completed.evidenceId,
    candidateId: completed.candidateId,
    completedAt: completed.completedAt,
    leaseOwner: completed.leaseOwner
  }, {
    status: "succeeded",
    evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
    candidateId: "candidate-visual-1",
    completedAt: "2026-08-16T01:00:01.000Z",
    leaseOwner: null
  });
});

test("limit-one recovery claims rotate fairly between persisted tenant histories", async () => {
  const visualRepository = repository();
  const otherScope = { ownerId: "owner-visual-b", teamId: "team-visual-b" };
  await createSession(visualRepository, scope);
  await createSession(visualRepository, otherScope);
  for (const [selectedScope, id] of [
    [scope, "visual-observation-rotation-a1"],
    [scope, "visual-observation-rotation-a2"],
    [otherScope, "visual-observation-rotation-b1"]
  ] as const) {
    await visualRepository.appendObservationBatch({
      scope: selectedScope,
      sessionId: "visual-session-task-7",
      ingestionActorId: `${selectedScope.ownerId}-actor`,
      observations: [{ clientObservationKey: `client-${id}`, observation: observation(id) }]
    });
  }
  const first = await visualRepository.claimPendingIngestionWorkItems({
    workerId: "visual-worker-rotation-1",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1
  });
  const second = await visualRepository.claimPendingIngestionWorkItems({
    workerId: "visual-worker-rotation-2",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(first[0]?.workItem.ownerId, scope.ownerId);
  assert.equal(second[0]?.workItem.ownerId, otherScope.ownerId);
});

test("visual work rejects stale leases, invalid completion times and forged result facts", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const automatic = observation("visual-observation-lease-guard");
  const manual = observation("visual-observation-manual-guard", {
    fieldConfidences: { visibleText: 0.80 }
  });
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: automatic.sessionId,
    ingestionActorId: "actor-lease-guard",
    observations: [
      { clientObservationKey: "client-lease-guard", observation: automatic },
      { clientObservationKey: "client-manual-guard", observation: manual }
    ]
  });
  const claims = await visualRepository.claimPendingIngestionWorkItems({
    workerId: "visual-worker-lease-guard",
    now: START,
    leaseDurationMs: 30_000,
    limit: 2
  });
  const automaticClaim = claims.find(({ observation }) =>
    observation.observationId === automatic.observationId)!;
  const manualClaim = claims.find(({ observation }) =>
    observation.observationId === manual.observationId)!;
  await assert.rejects(visualRepository.failIngestionWorkItem(
    scope,
    automatic.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: automaticClaim.workItem.leaseToken!,
      attemptCount: automaticClaim.workItem.attemptCount,
      failedAt: "2026-08-16T00:59:59.000Z",
      nextAttemptAt: START,
      errorCode: "RECOVERY_FAILED"
    }
  ));
  await assert.rejects(visualRepository.completeIngestionWorkItem(
    scope,
    automatic.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: automaticClaim.workItem.leaseToken!,
      attemptCount: automaticClaim.workItem.attemptCount,
      status: "succeeded",
      evidenceId: "caller-selected-evidence-id",
      platformEvidenceId: null,
      candidateId: null,
      completedAt: "2026-08-16T01:00:01.000Z"
    }
  ));
  await assert.rejects(visualRepository.completeIngestionWorkItem(
    scope,
    automatic.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: automaticClaim.workItem.leaseToken!,
      attemptCount: automaticClaim.workItem.attemptCount,
      status: "succeeded",
      evidenceId:
        `visual:${automatic.observationId}:evidence:${automatic.textHash}`,
      platformEvidenceId: "p".repeat(256),
      candidateId: null,
      completedAt: "2026-08-16T01:00:01.000Z"
    }
  ));
  await assert.rejects(visualRepository.completeIngestionWorkItem(
    scope,
    automatic.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: automaticClaim.workItem.leaseToken!,
      attemptCount: automaticClaim.workItem.attemptCount,
      status: "succeeded",
      evidenceId:
        `visual:${automatic.observationId}:evidence:${automatic.textHash}`,
      platformEvidenceId: null,
      candidateId: "c".repeat(121),
      completedAt: "2026-08-16T01:00:01.000Z"
    }
  ));
  await assert.rejects(visualRepository.completeIngestionWorkItem(
    scope,
    manual.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: manualClaim.workItem.leaseToken!,
      attemptCount: manualClaim.workItem.attemptCount,
      status: "manual_review_only",
      evidenceId: `visual:${manual.observationId}:evidence:${manual.textHash}`,
      platformEvidenceId: "platform-evidence-forbidden",
      candidateId: "candidate-forbidden",
      completedAt: "2026-08-16T01:00:01.000Z"
    }
  ));
  await assert.rejects(visualRepository.failIngestionWorkItem(
    scope,
    automatic.observationId,
    {
      workerId: "visual-worker-lease-guard",
      leaseToken: automaticClaim.workItem.leaseToken!,
      attemptCount: automaticClaim.workItem.attemptCount,
      failedAt: "2026-08-16T01:00:31.000Z",
      nextAttemptAt: "2026-08-16T01:00:32.000Z",
      errorCode: "RECOVERY_FAILED"
    }
  ));
});

test("same-worker reclaim never authorizes the prior visual lease result", async (context) => {
  for (const terminal of ["complete", "fail"] as const) {
    await context.test(`rejects prior ${terminal} without mutating the new lease`,
      async () => {
        const now = { value: START };
        const visualRepository = new visualSessionModule
          .InMemoryAcquisitionVisualReaderRepository({
            masterSecret: MASTER_SECRET,
            now: () => now.value
          });
        await createSession(visualRepository);
        const item = observation(`same-worker-reclaim-${terminal}`);
        await visualRepository.appendObservationBatch({
          scope,
          sessionId: item.sessionId,
          ingestionActorId: "actor-same-worker-reclaim",
          observations: [{
            clientObservationKey: `client-same-worker-reclaim-${terminal}`,
            observation: item
          }]
        });
        const [firstClaim] = await visualRepository
          .claimPendingIngestionWorkItems({
            workerId: "same-visual-worker",
            now: START,
            leaseDurationMs: 1_000,
            limit: 1
          });
        now.value = "2026-08-16T01:00:01.000Z";
        const [secondClaim] = await visualRepository
          .claimPendingIngestionWorkItems({
            workerId: "same-visual-worker",
            now: now.value,
            leaseDurationMs: 30_000,
            limit: 1
          });
        assert.equal(firstClaim?.workItem.attemptCount, 1);
        assert.equal(secondClaim?.workItem.attemptCount, 2);
        assert.match(firstClaim!.workItem.leaseToken!, /^[a-f0-9]{64}$/u);
        assert.match(secondClaim!.workItem.leaseToken!, /^[a-f0-9]{64}$/u);
        assert.notEqual(
          firstClaim?.workItem.leaseToken,
          secondClaim?.workItem.leaseToken
        );

        const oldResult = terminal === "complete"
          ? visualRepository.completeIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "same-visual-worker",
              leaseToken: firstClaim!.workItem.leaseToken!,
              attemptCount: firstClaim!.workItem.attemptCount,
              status: "succeeded",
              evidenceId:
                `visual:${item.observationId}:evidence:${item.textHash}`,
              platformEvidenceId: null,
              candidateId: null,
              completedAt: "2026-08-16T01:00:02.000Z"
            }
          )
          : visualRepository.failIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "same-visual-worker",
              leaseToken: firstClaim!.workItem.leaseToken!,
              attemptCount: firstClaim!.workItem.attemptCount,
              failedAt: "2026-08-16T01:00:02.000Z",
              nextAttemptAt: "2026-08-16T01:00:03.000Z",
              errorCode: "RECOVERY_FAILED"
            }
          );
        await assert.rejects(oldResult);
        const [unchanged] = await visualRepository.listRunIngestionWorkItems(
          scope,
          "run-task-7",
          { limit: 1 }
        );
        assert.deepEqual({
          status: unchanged?.status,
          attemptCount: unchanged?.attemptCount,
          leaseOwner: unchanged?.leaseOwner,
          leaseExpiresAt: unchanged?.leaseExpiresAt
        }, {
          status: "running",
          attemptCount: 2,
          leaseOwner: "same-visual-worker",
          leaseExpiresAt: "2026-08-16T01:00:31.000Z"
        });

        if (terminal === "complete") {
          const completed = await visualRepository.completeIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "same-visual-worker",
              leaseToken: secondClaim!.workItem.leaseToken!,
              attemptCount: secondClaim!.workItem.attemptCount,
              status: "succeeded",
              evidenceId:
                `visual:${item.observationId}:evidence:${item.textHash}`,
              platformEvidenceId: null,
              candidateId: null,
              completedAt: "2026-08-16T01:00:02.000Z"
            }
          );
          assert.equal(completed.status, "succeeded");
        } else {
          const failed = await visualRepository.failIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "same-visual-worker",
              leaseToken: secondClaim!.workItem.leaseToken!,
              attemptCount: secondClaim!.workItem.attemptCount,
              failedAt: "2026-08-16T01:00:02.000Z",
              nextAttemptAt: "2026-08-16T01:00:03.000Z",
              errorCode: "RECOVERY_FAILED"
            }
          );
          assert.equal(failed.status, "retry");
        }
      });
  }
});

test("visual lease results lose authority at the exact expiry instant", async (context) => {
  for (const terminal of ["complete", "fail"] as const) {
    await context.test(`rejects exact-expiry ${terminal} before reclaim`,
      async () => {
        const now = { value: START };
        const visualRepository = new visualSessionModule
          .InMemoryAcquisitionVisualReaderRepository({
            masterSecret: MASTER_SECRET,
            now: () => now.value
          });
        await createSession(visualRepository);
        const item = observation(`exact-expiry-${terminal}`);
        await visualRepository.appendObservationBatch({
          scope,
          sessionId: item.sessionId,
          ingestionActorId: "actor-exact-expiry",
          observations: [{
            clientObservationKey: `client-exact-expiry-${terminal}`,
            observation: item
          }]
        });
        const [firstClaim] = await visualRepository
          .claimPendingIngestionWorkItems({
            workerId: "exact-expiry-worker",
            now: START,
            leaseDurationMs: 1_000,
            limit: 1
          });
        now.value = "2026-08-16T01:00:01.000Z";

        const expiredResult = terminal === "complete"
          ? visualRepository.completeIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "exact-expiry-worker",
              leaseToken: firstClaim!.workItem.leaseToken!,
              attemptCount: firstClaim!.workItem.attemptCount,
              status: "succeeded",
              evidenceId:
                `visual:${item.observationId}:evidence:${item.textHash}`,
              platformEvidenceId: null,
              candidateId: null,
              completedAt: now.value
            }
          )
          : visualRepository.failIngestionWorkItem(
            scope,
            item.observationId,
            {
              workerId: "exact-expiry-worker",
              leaseToken: firstClaim!.workItem.leaseToken!,
              attemptCount: firstClaim!.workItem.attemptCount,
              failedAt: now.value,
              nextAttemptAt: "2026-08-16T01:00:02.000Z",
              errorCode: "RECOVERY_FAILED"
            }
          );
        await assert.rejects(expiredResult);
        const [unchanged] = await visualRepository.listRunIngestionWorkItems(
          scope,
          "run-task-7",
          { limit: 1 }
        );
        assert.deepEqual(unchanged, firstClaim!.workItem);

        const [reclaimed] = await visualRepository
          .claimPendingIngestionWorkItems({
            workerId: "exact-expiry-worker",
            now: now.value,
            leaseDurationMs: 30_000,
            limit: 1
          });
        assert.equal(reclaimed?.workItem.attemptCount, 2);
        assert.notEqual(reclaimed?.workItem.leaseToken,
          firstClaim?.workItem.leaseToken);
      });
  }
});

test("memory visual work closes attempt generation across every lifecycle boundary", async (context) => {
  const setup = async (id: string) => {
    const visualRepository = repository();
    await createSession(visualRepository);
    const item = observation(id);
    await visualRepository.appendObservationBatch({
      scope,
      sessionId: item.sessionId,
      ingestionActorId: "actor-attempt-lifecycle",
      observations: [{
        clientObservationKey: `client-${id}`,
        observation: item
      }]
    });
    const state = (visualRepository as unknown as {
      state: {
        ingestionWorkItems: Map<
          string,
          visualSessionModule.VisualIngestionWorkItem
        >;
      };
    }).state;
    const stored = [...state.ingestionWorkItems.values()][0]!;
    return { visualRepository, item, stored };
  };
  const terminalFacts = (
    item: DouyinVisualCommentObservationV1,
    status: "succeeded" | "manual_review_only"
  ) => ({
    status,
    disposition: status === "succeeded"
      ? "automatic" as const
      : "manual_review_only" as const,
    attemptCount: 0,
    nextAttemptAt: "2026-08-16T01:00:01.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
    platformEvidenceId: null,
    candidateId: null,
    updatedAt: "2026-08-16T01:00:01.000Z",
    completedAt: "2026-08-16T01:00:01.000Z"
  });

  await context.test("fresh queued attempt zero remains valid", async () => {
    const { visualRepository } = await setup("memory-attempt-queued-zero");
    const [queued] = await visualRepository.listRunIngestionWorkItems(
      scope, "run-task-7", { limit: 1 }
    );
    assert.equal(queued?.status, "queued");
    assert.equal(queued?.attemptCount, 0);
    assert.equal((await visualRepository.getRunIngestionWorkProjection(
      scope, "run-task-7"
    )).queuedCount, 1);
  });

  for (const status of ["succeeded", "manual_review_only"] as const) {
    await context.test(`list rejects ${status} attempt zero`, async () => {
      const { visualRepository, item, stored } = await setup(
        `memory-attempt-list-${status}`
      );
      Object.assign(stored, terminalFacts(item, status));
      await assert.rejects(visualRepository.listRunIngestionWorkItems(
        scope, "run-task-7", { limit: 1 }
      ));
    });
  }

  await context.test("projection rejects retry attempt zero", async () => {
    const { visualRepository, stored } = await setup(
      "memory-attempt-projection-retry"
    );
    Object.assign(stored, {
      status: "retry",
      attemptCount: 0,
      lastErrorCode: "RECOVERY_FAILED"
    });
    await assert.rejects(visualRepository.getRunIngestionWorkProjection(
      scope, "run-task-7"
    ));
  });

  await context.test("claim rejects retry attempt zero", async () => {
    const { visualRepository, stored } = await setup(
      "memory-attempt-claim-retry"
    );
    Object.assign(stored, {
      status: "retry",
      attemptCount: 0,
      lastErrorCode: "RECOVERY_FAILED"
    });
    await assert.rejects(visualRepository.claimPendingIngestionWorkItems({
      workerId: "attempt-lifecycle-worker",
      now: START,
      leaseDurationMs: 30_000,
      limit: 1
    }));
  });

  for (const boundary of ["complete", "fail"] as const) {
    await context.test(`${boundary} rejects running attempt zero`, async () => {
      const { visualRepository, item, stored } = await setup(
        `memory-attempt-${boundary}-running`
      );
      Object.assign(stored, {
        status: "running",
        attemptCount: 0,
        leaseOwner: "attempt-lifecycle-worker",
        leaseToken: "a".repeat(64),
        leaseExpiresAt: "2026-08-16T01:00:30.000Z"
      });
      const result = boundary === "complete"
        ? visualRepository.completeIngestionWorkItem(
          scope,
          item.observationId,
          {
            workerId: "attempt-lifecycle-worker",
            leaseToken: "a".repeat(64),
            attemptCount: 1,
            status: "succeeded",
            evidenceId:
              `visual:${item.observationId}:evidence:${item.textHash}`,
            platformEvidenceId: null,
            candidateId: null,
            completedAt: "2026-08-16T01:00:01.000Z"
          }
        )
        : visualRepository.failIngestionWorkItem(
          scope,
          item.observationId,
          {
            workerId: "attempt-lifecycle-worker",
            leaseToken: "a".repeat(64),
            attemptCount: 1,
            failedAt: "2026-08-16T01:00:01.000Z",
            nextAttemptAt: "2026-08-16T01:00:02.000Z",
            errorCode: "RECOVERY_FAILED"
          }
        );
      await assert.rejects(result);
    });
  }
});

test("Domain accepts only the exact literal authorized visual Evidence identity", async () => {
  const createDomain = () => new AcquisitionDomainService({
    repository: new InMemoryAcquisitionDomainRepository(),
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return {
          workspaceId: value.teamId,
          kind: "team" as const,
          bindingRevision: "task-7"
        };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-generated-should-not-win`,
    now: () => START
  });
  const domain = createDomain();
  const item = observation("visual-observation-evidence");
  const evidenceId = `visual:${item.observationId}:evidence:${item.textHash}`;
  const evidenceInput = {
    targetType: "individual_signal" as const,
    sourcePlatform: "douyin",
    sourceTitle: "Authorized visible comment observation",
    sourceSnippet: item.visibleText,
    publishedAt: item.visibleTimeText,
    locale: "zh-CN",
    rawArtifactHash: item.textHash,
    contentHash: item.textHash,
    provenance: {
      kind: "authorized_visual_observation" as const,
      sourceUrl: item.sourceUrl,
      observationId: item.observationId,
      sessionId: item.sessionId,
      extractionMethod: item.extractionMethod,
      visibleTextConfidence: item.fieldConfidences.visibleText,
      coverage: "authorized_visible_top_level_sample" as const,
      artifactId: null,
      domTextHash: item.domTextHash,
      ocrTextHash: item.ocrTextHash
    },
    accessStatus: "access_restricted" as const
  };
  const visualDomain = domain as unknown as {
    appendAuthorizedVisualEvidence?: (
      selectedScope: typeof scope & { actorId: string },
      input: typeof evidenceInput,
      literalEvidenceId: string,
      idempotencyKey: string
    ) => Promise<{ id: string }>;
  };
  assert.equal(typeof visualDomain.appendAuthorizedVisualEvidence, "function");
  const evidence = await visualDomain.appendAuthorizedVisualEvidence!(
    { ...scope, actorId: "visual-reader-actor" },
    evidenceInput,
    evidenceId,
    "visual-evidence-idempotency"
  );
  assert.equal(evidence.id, evidenceId);
  await assert.rejects(domain.appendEvidence(
    { ...scope, actorId: "visual-reader-actor" },
    evidenceInput,
    "generic-visual-evidence-forbidden"
  ));
  await assert.rejects(
    visualDomain.appendAuthorizedVisualEvidence!(
      { ...scope, actorId: "visual-reader-actor" },
      evidenceInput,
      "caller-selected-evidence-id",
      "visual-evidence-forgery"
    )
  );
  await assert.rejects(
    visualDomain.appendAuthorizedVisualEvidence!(
      { ...scope, actorId: "visual-reader-actor" },
      { ...evidenceInput, supersedesEvidenceId: evidenceId },
      evidenceId,
      "visual-evidence-supersedes-forbidden"
    )
  );
  for (const [name, mutated] of [
    ["content hash", { ...evidenceInput, contentHash: "garbage" }],
    ["raw hash", { ...evidenceInput, rawArtifactHash: "garbage" }],
    ["source URL", {
      ...evidenceInput,
      provenance: {
        ...evidenceInput.provenance,
        sourceUrl: "https://evil-douyin.com/video/7536012345678909876"
      }
    }],
    ["session ID", {
      ...evidenceInput,
      provenance: { ...evidenceInput.provenance, sessionId: " invalid" }
    }],
    ["artifact ID", {
      ...evidenceInput,
      provenance: { ...evidenceInput.provenance, artifactId: " invalid" }
    }],
    ["literal mismatch", {
      ...evidenceInput,
      contentHash: digest("different valid content")
    }]
  ] as const) {
    const isolatedDomain = createDomain() as unknown as typeof visualDomain;
    const mutatedEvidenceId = name === "literal mismatch"
      ? evidenceId
      : `visual:${mutated.provenance.observationId}`
        + `:evidence:${mutated.contentHash}`;
    await assert.rejects(
      isolatedDomain.appendAuthorizedVisualEvidence!(
        { ...scope, actorId: "visual-reader-actor" },
        mutated,
        mutatedEvidenceId,
        `visual-evidence-invalid-${name.replaceAll(" ", "-")}`
      ),
      undefined,
      name
    );
  }
});

test("visual identity keys reuse the resolver but remain isolated without verification", () => {
  const visualObservationId = `visual-observation:${"a".repeat(64)}`;
  const verified = resolveAcquisitionPublicIdentity({
    ...scope,
    provider: "experimental_public_sample",
    sourceUrl: "https://www.douyin.com/user/verified-sec-uid",
    sourceType: "profile",
    subject: {
      kind: "individual",
      publicActorKey: "douyin:sec_uid:verified-sec-uid",
      publicProfileUrl: "https://www.douyin.com/user/verified-sec-uid",
      sourcePlatform: "douyin"
    }
  });
  const unmergeable = resolveAcquisitionPublicIdentity({
    ...scope,
    provider: "experimental_public_sample",
    sourceUrl: "https://www.douyin.com/video/7536012345678909876",
    sourceType: "video",
    subject: {
      kind: "individual",
      publicActorKey: `unmergeable:douyin:visual:${visualObservationId}`,
      publicProfileUrl: "https://www.douyin.com/video/7536012345678909876",
      sourcePlatform: "douyin"
    }
  });
  assert.equal(verified.status, "resolved");
  assert.equal(verified.basis, "provider_public_actor");
  assert.equal(isSafeAcquisitionPublicActorKey(
    `unmergeable:douyin:visual:${visualObservationId}`
  ), true);
  assert.equal(isSafeAcquisitionPublicActorKey(
    "unmergeable:douyin:visual:caller-selected-observation"
  ), false);
  assert.equal(unmergeable.status, "needs_research");
  assert.notEqual(unmergeable.dedupeKey, verified.dedupeKey);
  const otherUnmergeable = resolveAcquisitionPublicIdentity({
    ...scope,
    provider: "experimental_public_sample",
    sourceUrl: "https://www.douyin.com/video/7536012345678909876",
    sourceType: "video",
    subject: {
      kind: "individual",
      publicActorKey:
        `unmergeable:douyin:visual:visual-observation:${"b".repeat(64)}`,
      publicProfileUrl: "https://www.douyin.com/video/7536012345678909876",
      sourcePlatform: "douyin"
    }
  });
  assert.notEqual(unmergeable.dedupeKey, otherUnmergeable.dedupeKey);
});

test("persisted high-confidence visual work creates literal Evidence then a needs-research candidate", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const item = observation(`visual-observation:${"c".repeat(64)}`);
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: item.sessionId,
    ingestionActorId: "visual-reader-service-actor",
    observations: [{
      clientObservationKey: "client-service-nickname",
      observation: item
    }]
  });
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  let id = 0;
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return {
          workspaceId: value.teamId,
          kind: "team" as const,
          bindingRevision: "task-7"
        };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-visual-${++id}`,
    now: () => "2026-08-16T01:00:01.000Z"
  });
  const individualSignals = new AcquisitionIndividualSignalIngestionService({
    domain,
    candidateDirectory: new InMemoryAcquisitionCandidateDirectory({
      now: () => "2026-08-16T01:00:01.000Z"
    })
  });
  const ingestionModule = await import("./acquisition-visual-comment-ingestion.js");
  const service = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    unitOfWork: { transaction: <T>(work: () => Promise<T>) => work() },
    workerId: "visual-ingestion-worker",
    now: () => "2026-08-16T01:00:01.000Z"
  });
  assert.equal(await service.recoverPendingVisualIngestionWorkItems({ limit: 10 }), 1);
  const [work] = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  const evidenceId = `visual:${item.observationId}:evidence:${item.textHash}`;
  assert.equal(work?.status, "succeeded");
  assert.equal(work?.evidenceId, evidenceId);
  assert.equal(work?.platformEvidenceId, null);
  assert.ok(work?.candidateId);
  const evidence = await domain.getEvidence(
    { ...scope, actorId: "visual-reader-service-actor" },
    evidenceId
  );
  assert.equal(evidence.provenance.kind, "authorized_visual_observation");
  const candidate = await domain.getCandidate(
    { ...scope, actorId: "visual-reader-service-actor" },
    work!.candidateId!
  );
  assert.equal(candidate.status, "needs_research");
  assert.deepEqual(candidate.evidenceIds, [evidenceId]);
});

test("manual and noise observations stay Evidence-only while verified secUid signals merge", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const manual = observation(`visual-observation:${"d".repeat(64)}`, {
    fieldConfidences: { visibleText: 0.80 }
  });
  const noise = observation(`visual-observation:${"e".repeat(64)}`, {
    visibleText: "哈哈哈哈",
    textHash: digest("哈哈哈哈"),
    domTextHash: digest("哈哈哈哈")
  });
  const verifiedIdentity = {
    displayName: "公开昵称",
    publicProfileUrl: "https://www.douyin.com/user/verified-visual-actor",
    secUid: "verified-visual-actor",
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.99,
      visibleTimeText: 0.99,
      likeCount: 0.99,
      replyCount: 0.99,
      publicProfileUrl: 0.99,
      secUid: 0.99
    }
  } as const;
  const verifiedOne = observation(`visual-observation:${"f".repeat(64)}`, {
    ...verifiedIdentity,
    visibleText: "想咨询一下解决方案",
    textHash: digest("想咨询一下解决方案"),
    domTextHash: digest("想咨询一下解决方案")
  });
  const verifiedTwo = observation(`visual-observation:${"1".repeat(64)}`, {
    ...verifiedIdentity,
    visibleText: "正在采购 20 套，请报价",
    textHash: digest("正在采购 20 套，请报价"),
    domTextHash: digest("正在采购 20 套，请报价")
  });
  const vision = observation(`visual-observation:${"2".repeat(64)}`, {
    extractionMethod: "vision"
  });
  const negative = observation(`visual-observation:${"3".repeat(64)}`, {
    visibleText: "不需要，请勿联系",
    textHash: digest("不需要，请勿联系"),
    domTextHash: digest("不需要，请勿联系")
  });
  const weakVerifiedIdentity = observation(
    `visual-observation:${"4".repeat(64)}`,
    {
      displayName: "公开昵称",
      publicProfileUrl: "https://www.douyin.com/user/verified-visual-actor",
      secUid: "verified-visual-actor",
      fieldConfidences: { visibleText: 0.99 }
    }
  );
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: manual.sessionId,
    ingestionActorId: "visual-reader-service-actor",
    observations: [
      manual, noise, verifiedOne, verifiedTwo, vision, negative,
      weakVerifiedIdentity
    ].map((item) => ({
      clientObservationKey: `client-${item.observationId}`,
      observation: item
    }))
  });
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  let id = 0;
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return { workspaceId: value.teamId, kind: "team" as const,
          bindingRevision: "task-7" };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-visual-matrix-${++id}`,
    now: () => "2026-08-16T01:00:01.000Z"
  });
  const individualSignals = new AcquisitionIndividualSignalIngestionService({
    domain,
    candidateDirectory: new InMemoryAcquisitionCandidateDirectory({
      now: () => "2026-08-16T01:00:01.000Z"
    })
  });
  const ingestionModule = await import("./acquisition-visual-comment-ingestion.js");
  const service = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    unitOfWork: { transaction: <T>(work: () => Promise<T>) => work() },
    workerId: "visual-matrix-worker",
    now: () => "2026-08-16T01:00:01.000Z"
  });
  assert.equal(await service.recoverPendingVisualIngestionWorkItems({ limit: 10 }), 7);
  const work = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  const byObservation = new Map(work.map((value) => [value.observationId, value]));
  assert.equal(byObservation.get(manual.observationId)?.status,
    "manual_review_only");
  assert.equal(byObservation.get(manual.observationId)?.candidateId, null);
  assert.equal(byObservation.get(noise.observationId)?.status, "succeeded");
  assert.equal(byObservation.get(noise.observationId)?.candidateId, null);
  assert.equal(byObservation.get(vision.observationId)?.status, "retry");
  assert.equal(byObservation.get(vision.observationId)?.evidenceId, null);
  assert.ok(byObservation.get(verifiedOne.observationId)?.candidateId);
  assert.equal(
    byObservation.get(verifiedOne.observationId)?.candidateId,
    byObservation.get(verifiedTwo.observationId)?.candidateId
  );
  assert.equal(byObservation.get(weakVerifiedIdentity.observationId)?.status,
    "manual_review_only");
  assert.equal(byObservation.get(weakVerifiedIdentity.observationId)?.candidateId,
    null);
  assert.equal(byObservation.get(negative.observationId)?.status, "succeeded");
  const manualEvidence = await domain.getEvidence(
    { ...scope, actorId: "visual-reader-service-actor" },
    byObservation.get(manual.observationId)!.evidenceId!
  );
  assert.equal(manualEvidence.provenance.kind,
    "authorized_visual_observation");
  if (manualEvidence.provenance.kind === "authorized_visual_observation") {
    assert.equal(manualEvidence.provenance.extractionMethod, "dom");
  }
  const candidate = await domain.getCandidate(
    { ...scope, actorId: "visual-reader-service-actor" },
    byObservation.get(verifiedOne.observationId)!.candidateId!
  );
  assert.equal(candidate.status, "normalized");
  assert.deepEqual(new Set(candidate.evidenceIds), new Set([
    byObservation.get(verifiedOne.observationId)!.evidenceId!,
    byObservation.get(verifiedTwo.observationId)!.evidenceId!
  ]));
  const negativeCandidate = await domain.getCandidate(
    { ...scope, actorId: "visual-reader-service-actor" },
    byObservation.get(negative.observationId)!.candidateId!
  );
  assert.equal(negativeCandidate.status, "do_not_contact");
});

test("failure before visual completion rolls back Domain facts and restart resumes persisted work", async () => {
  const now = { value: "2026-08-16T01:00:01.000Z" };
  const visualRepository = new visualSessionModule
    .InMemoryAcquisitionVisualReaderRepository({
      masterSecret: MASTER_SECRET,
      now: () => now.value
    });
  await createSession(visualRepository);
  const artifactBytes = Buffer.from("masked-local-visual-fixture");
  const artifactHash = digest(artifactBytes.toString());
  const item = observation(`visual-observation:${"5".repeat(64)}`, {
    redactedCropHash: artifactHash
  });
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: item.sessionId,
    ingestionActorId: "visual-atomic-actor",
    observations: [{
      clientObservationKey: "client-atomic",
      observation: item,
      artifact: {
        artifactId: "visual-artifact-atomic",
        observationId: item.observationId,
        mediaType: "image/webp",
        plaintext: artifactBytes,
        plaintextHash: artifactHash,
        byteLength: artifactBytes.byteLength,
        width: 320,
        height: 120,
        maskedRegionCount: 1,
        createdAt: START,
        expiresAt: "2026-08-16T01:01:00.000Z"
      }
    }]
  });
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const candidateDirectory = new InMemoryAcquisitionCandidateDirectory({
    now: () => now.value
  });
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  let id = 0;
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return { workspaceId: value.teamId, kind: "team" as const,
          bindingRevision: "task-7" };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-visual-atomic-${++id}`,
    now: () => now.value
  });
  const individualSignals = new AcquisitionIndividualSignalIngestionService({
    domain,
    candidateDirectory
  });
  const unitOfWork = Reflect.construct(
    InMemoryAcquisitionDouyinCommentIngestionUnitOfWork,
    [domainRepository, events, candidateDirectory, visualRepository]
  ) as AcquisitionDouyinCommentIngestionUnitOfWork;
  const ingestionModule = await import("./acquisition-visual-comment-ingestion.js");
  let failOnce = true;
  const failing = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    unitOfWork,
    workerId: "visual-atomic-worker",
    now: () => now.value,
    failureInjector: async (stage: string) => {
      if (stage === "after_candidate" && failOnce) {
        failOnce = false;
        throw new Error("SIMULATED_VISUAL_ATOMIC_FAILURE");
      }
    }
  } as ConstructorParameters<
    typeof ingestionModule.AcquisitionVisualCommentIngestionService
  >[0]);
  assert.equal(await Promise.race([
    failing.recoverPendingVisualIngestionWorkItems({ limit: 1 }),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("VISUAL_TRANSACTION_SELF_DEADLOCK")),
      100
    ))
  ]), 1);
  const literalEvidenceId = `visual:${item.observationId}:evidence:${item.textHash}`;
  await assert.rejects(domain.getEvidence(
    { ...scope, actorId: "visual-atomic-actor" },
    literalEvidenceId
  ));
  assert.deepEqual((await domainRepository.listCandidates(scope, {
    limit: 100
  })).items, []);
  let [work] = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  assert.equal(work?.status, "retry");
  assert.equal(work?.evidenceId, null);
  assert.equal(work?.candidateId, null);

  now.value = "2026-08-16T01:00:03.000Z";
  const restarted = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    unitOfWork,
    workerId: "visual-atomic-worker-restarted",
    now: () => now.value
  });
  assert.equal(await restarted.recoverPendingVisualIngestionWorkItems({ limit: 1 }), 1);
  [work] = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  assert.equal(work?.status, "succeeded");
  assert.equal(work?.evidenceId, literalEvidenceId);
  assert.ok(work?.candidateId);
});

test("verified public promotion reuses one public saga and merges both Evidence facts without a second visual signal", async () => {
  const now = { value: "2026-08-16T01:00:01.000Z" };
  const visualRepository = repository();
  await createSession(visualRepository);
  const item = observation(`visual-observation:${"6".repeat(64)}`, {
    visibleText: "不需要，请勿联系",
    platformCommentId: "6001",
    displayName: "公开昵称",
    publicProfileUrl: "https://www.douyin.com/user/verified-public-actor",
    secUid: "verified-public-actor",
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.99,
      visibleTimeText: 0.99,
      likeCount: 0.99,
      replyCount: 0.99,
      platformCommentId: 0.99,
      publicProfileUrl: 0.99,
      secUid: 0.99
    }
  });
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: item.sessionId,
    ingestionActorId: "visual-promotion-actor",
    observations: [{
      clientObservationKey: "client-verified-promotion",
      observation: item
    }]
  });
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const candidateDirectory = new InMemoryAcquisitionCandidateDirectory({
    now: () => now.value
  });
  let id = 0;
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return { workspaceId: value.teamId, kind: "team" as const,
          bindingRevision: "task-7" };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-visual-promotion-${++id}`,
    now: () => now.value
  });
  const baseSignals = new AcquisitionIndividualSignalIngestionService({
    domain,
    candidateDirectory
  });
  let signalCalls = 0;
  const individualSignals = {
    async ingest(input: Parameters<typeof baseSignals.ingest>[0]) {
      signalCalls += 1;
      return baseSignals.ingest(input);
    }
  };
  const unitOfWork = new InMemoryAcquisitionDouyinCommentIngestionUnitOfWork(
    domainRepository,
    events,
    candidateDirectory,
    visualRepository
  );
  const publicIngestion = new AcquisitionDouyinCommentIngestionService({
    events,
    domain,
    individualSignals,
    unitOfWork,
    now: () => now.value
  });
  let publicCalls = 0;
  const ingestionModule = await import("./acquisition-visual-comment-ingestion.js");
  const service = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    publicCommentIngestion: {
      async ingestSample(...args: Parameters<typeof publicIngestion.ingestSample>) {
        publicCalls += 1;
        return publicIngestion.ingestSample(...args);
      }
    },
    unitOfWork,
    workerId: "visual-promotion-worker",
    now: () => now.value
  } as ConstructorParameters<
    typeof ingestionModule.AcquisitionVisualCommentIngestionService
  >[0]);

  assert.equal(await service.recoverPendingVisualIngestionWorkItems({ limit: 1 }), 1);
  assert.equal(publicCalls, 1);
  assert.equal(signalCalls, 1,
    "the public ingestion owns the only demand-signal merge");
  const [work] = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  assert.equal(work?.status, "succeeded");
  assert.ok(work?.candidateId);
  assert.ok(work?.platformEvidenceId);
  assert.notEqual(work?.platformEvidenceId, work?.evidenceId);
  const candidate = await domain.getCandidate(
    { ...scope, actorId: "visual-promotion-actor" },
    work!.candidateId!
  );
  assert.equal(candidate.status, "do_not_contact",
    "a newly promoted negative identity must remain suppressive");
  assert.deepEqual(new Set(candidate.evidenceIds), new Set([
    work!.evidenceId!,
    work!.platformEvidenceId!
  ]));
  const evidenceKinds = await Promise.all(candidate.evidenceIds.map(async (id) =>
    (await domain.getEvidence(
      { ...scope, actorId: "visual-promotion-actor" },
      id
    )).provenance.kind
  ));
  assert.deepEqual(new Set(evidenceKinds), new Set([
    "authorized_visual_observation",
    "platform_public_event"
  ]));
  assert.equal((await events.getRunCommentPresentationProjection(
    { ...scope, actorId: "visual-promotion-actor" },
    "run-task-7"
  )).linkedEventCount, 1);

  assert.equal(await service.recoverPendingVisualIngestionWorkItems({ limit: 1 }), 0);
  assert.equal(publicCalls, 1);
  assert.equal(signalCalls, 1);
});

test("incomplete or manual visual facts never construct a public comment event", async () => {
  const visualRepository = repository();
  await createSession(visualRepository);
  const promotable = {
    platformCommentId: "7001",
    displayName: "公开昵称",
    publicProfileUrl: "https://www.douyin.com/user/verified-blocker",
    secUid: "verified-blocker",
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.99,
      visibleTimeText: 0.99,
      likeCount: 0.99,
      replyCount: 0.99,
      platformCommentId: 0.99,
      publicProfileUrl: 0.99,
      secUid: 0.99
    }
  } as const;
  const blockers: Array<Partial<DouyinVisualCommentObservationV1>> = [
    { platformCommentId: null },
    { publicProfileUrl: "https://www.douyin.com/user/different-public-key" },
    { secUid: null },
    { visibleTimeText: null },
    { likeCount: null },
    { replyCount: null },
    { fieldConfidences: { ...promotable.fieldConfidences, secUid: 0.84 } },
    { fieldConfidences: { ...promotable.fieldConfidences, visibleText: 0.84 } },
    {
      displayName: null,
      fieldConfidences: {
        visibleText: 0.99,
        visibleTimeText: 0.99,
        likeCount: 0.99,
        replyCount: 0.99,
        platformCommentId: 0.99,
        publicProfileUrl: 0.99,
        secUid: 0.99
      }
    },
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678909999",
      videoId: "7536012345678909876"
    }
  ];
  const identitySuffixes = [
    "7", "8", "9", "a", "b", "c", "d", "e", "f", "0"
  ];
  const items = blockers.map((blocked, index) => observation(
    `visual-observation:${identitySuffixes[index]!.repeat(64)}`,
    { ...promotable, ...blocked }
  ));
  await visualRepository.appendObservationBatch({
    scope,
    sessionId: "visual-session-task-7",
    ingestionActorId: "visual-promotion-blocker-actor",
    observations: items.map((item) => ({
      clientObservationKey: `client-blocker-${item.observationId}`,
      observation: item
    }))
  });
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const candidateDirectory = new InMemoryAcquisitionCandidateDirectory({
    now: () => "2026-08-16T01:00:01.000Z"
  });
  let id = 0;
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: { async createLead() { throw new Error("not used"); } },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(value) {
        return { workspaceId: value.teamId, kind: "team" as const,
          bindingRevision: "task-7" };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-visual-blocker-${++id}`,
    now: () => "2026-08-16T01:00:01.000Z"
  });
  const individualSignals = new AcquisitionIndividualSignalIngestionService({
    domain,
    candidateDirectory
  });
  let publicCalls = 0;
  const ingestionModule = await import("./acquisition-visual-comment-ingestion.js");
  const service = new ingestionModule.AcquisitionVisualCommentIngestionService({
    visualRepository,
    domain,
    individualSignals,
    publicCommentIngestion: {
      async ingestSample() {
        publicCalls += 1;
        throw new Error("PUBLIC_PROMOTION_MUST_BE_BLOCKED");
      }
    },
    unitOfWork: { transaction: <T>(work: () => Promise<T>) => work() },
    workerId: "visual-promotion-blocker-worker",
    now: () => "2026-08-16T01:00:01.000Z"
  } as ConstructorParameters<
    typeof ingestionModule.AcquisitionVisualCommentIngestionService
  >[0]);
  assert.equal(await service.recoverPendingVisualIngestionWorkItems({ limit: 20 }),
    blockers.length);
  assert.equal(publicCalls, 0);
  const completed = await visualRepository.listRunIngestionWorkItems(
    scope,
    "run-task-7",
    { limit: 1_000 }
  );
  const candidateFor = (item: DouyinVisualCommentObservationV1) =>
    completed.find((work) => work.observationId === item.observationId)
      ?.candidateId;
  assert.ok(candidateFor(items[0]!));
  assert.equal(candidateFor(items[8]!), candidateFor(items[0]!),
    "secUid and its matching profile remain the identity proof without a name");
});
