import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryAcquisitionDouyinCommentEventRepository,
  type AppendDouyinCommentObservationInput
} from "./acquisition-douyin-comment-events.js";

const scopeA = { ownerId: "owner-a", teamId: "team-a" };
const scopeB = { ownerId: "owner-b", teamId: "team-b" };

function observation(
  overrides: Partial<AppendDouyinCommentObservationInput> = {}
): AppendDouyinCommentObservationInput {
  return {
    scope: scopeA,
    observationId: "observation-1",
    event: {
      eventId: "event-1",
      platform: "douyin",
      eventType: "comment",
      platformEventId: "cid-1",
      videoId: "video-1",
      parentCommentId: null,
      text: "原始公开评论",
      textHash: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-08-15T01:00:00.000Z",
      capturedAt: "2026-08-15T02:00:00.000Z",
      likeCount: 2,
      replyCount: 1,
      ipLabel: "上海",
      actor: {
        displayName: "公开用户",
        handle: "public-user",
        secUid: "sec-1"
      },
      sourceUrl: "https://www.douyin.com/video/123",
      coverage: "public_top_level_sample",
      accessStatus: "public_content",
      providerVersion: "douyin-public-comment-provider-v1",
      rawArtifactHash: `sha256:${"b".repeat(64)}`
    },
    ...overrides
  };
}

function ingestionSaga(sagaId = "saga-1") {
  return {
    sagaId,
    actorId: "worker-1",
    runId: "run-1",
    shardId: "shard-1",
    discoveryOperationId: "operation-1"
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("comment events are tenant-idempotent while every capture is observed", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();

  const first = await repository.appendObservation(observation());
  const replay = await repository.appendObservation(observation({
    observationId: "observation-2",
    event: {
      ...observation().event,
      capturedAt: "2026-08-15T03:00:00.000Z",
      likeCount: 7,
      replyCount: 3
    }
  }));
  const otherTenant = await repository.appendObservation(observation({
    scope: scopeB,
    observationId: "observation-b",
    event: {
      ...observation().event,
      eventId: "event-b"
    }
  }));

  assert.equal(first.eventCreated, true);
  assert.equal(replay.eventCreated, false);
  assert.equal(replay.event.eventId, "event-1");
  assert.equal(replay.observation.likeCount, 7);
  assert.equal(otherTenant.eventCreated, true);
  assert.equal(otherTenant.event.eventId, "event-b");
});

test("changed public text is flagged without overwriting the immutable event", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());

  const changed = await repository.appendObservation(observation({
    observationId: "observation-changed",
    event: {
      ...observation().event,
      text: "来源后来返回的文本",
      textHash: `sha256:${"c".repeat(64)}`,
      capturedAt: "2026-08-15T04:00:00.000Z",
      likeCount: 11,
      replyCount: 5
    }
  }));

  assert.equal(changed.contentChanged, true);
  assert.equal(changed.event.text, "原始公开评论");
  assert.equal(changed.event.textHash, `sha256:${"a".repeat(64)}`);
  assert.equal(changed.observation.observedTextHash, `sha256:${"c".repeat(64)}`);
});

test("content versions persist the first exact text and provider artifact for an event hash", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  const first = await repository.appendObservation({
    ...observation(),
    ingestionSaga: ingestionSaga(),
    event: {
      ...observation().event,
      text: "  预算 10 万，采购 20 套\n请报价  ",
      textHash: `sha256:${"c".repeat(64)}`
    }
  });
  const replay = await repository.appendObservation({
    ...observation({ observationId: "observation-2" }),
    ingestionSaga: ingestionSaga("saga-2"),
    event: {
      ...observation().event,
      text: "  预算 10 万，采购 20 套\n请报价  ",
      textHash: `sha256:${"c".repeat(64)}`,
      capturedAt: "2026-08-15T03:00:00.000Z",
      rawArtifactHash: `sha256:${"d".repeat(64)}`
    }
  });

  assert.deepEqual(first.contentVersion, {
    contentVersionId: first.contentVersion.contentVersionId,
    eventId: "event-1",
    textHash: `sha256:${"c".repeat(64)}`,
    observationId: "observation-1",
    text: "  预算 10 万，采购 20 套\n请报价  ",
    occurredAt: "2026-08-15T01:00:00.000Z",
    actor: {
      displayName: "公开用户",
      handle: "public-user",
      secUid: "sec-1"
    },
    sourceUrl: "https://www.douyin.com/video/123",
    platformEventId: "cid-1",
    providerVersion: "douyin-public-comment-provider-v1",
    coverage: "public_top_level_sample",
    rawArtifactHash: `sha256:${"b".repeat(64)}`
  });
  assert.deepEqual(replay.contentVersion, first.contentVersion);
  assert.equal(replay.observation.rawArtifactHash, `sha256:${"d".repeat(64)}`);
});

test("pending ingestion sagas stay out of Run projections until atomic link commit", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  const appended = await repository.appendObservation({
    ...observation(),
    ingestionSaga: ingestionSaga()
  });

  assert.equal(appended.ingestionSaga?.status, "pending");
  assert.equal((await repository.listPendingIngestionSagas({ limit: 10 })).length, 1);
  assert.deepEqual(
    await repository.listRunCommentSignals(scopeA, "run-1", { limit: 50 }),
    []
  );
  assert.equal((await repository.getRunCommentSummary(scopeA, "run-1"))
    .linkedEventCount, 0);

  await repository.commitIngestionSaga(scopeA, "saga-1", {
    candidateId: "candidate-1",
    evidenceId: "evidence-1"
  });
  assert.equal((await repository.listPendingIngestionSagas({ limit: 10 })).length, 0);
  assert.equal((await repository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  )).length, 1);
});

test("concurrent conflicting saga commits choose exactly one immutable result", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation({
    ...observation(),
    ingestionSaga: ingestionSaga("saga-race")
  });

  const settled = await Promise.allSettled([
    repository.commitIngestionSaga(scopeA, "saga-race", {
      candidateId: "candidate-a",
      evidenceId: "evidence-a"
    }),
    repository.commitIngestionSaga(scopeA, "saga-race", {
      candidateId: "candidate-b",
      evidenceId: "evidence-b"
    })
  ]);

  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  const committed = await repository.getIngestionSaga(scopeA, "saga-race");
  assert.equal(committed?.saga.status, "committed");
  const [signal] = await repository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 10 }
  );
  assert.equal(signal?.link.candidateId, committed?.saga.candidateId);
  assert.equal(signal?.link.evidenceId, committed?.saga.evidenceId);
});

test("leased recovery skips poison fairly and concurrent claimers never overlap", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  for (const [index, sagaId] of ["saga-poison", "saga-healthy"].entries()) {
    await repository.appendObservation({
      ...observation({ observationId: `observation-lease-${index}` }),
      event: {
        ...observation().event,
        eventId: `event-lease-${index}`,
        platformEventId: `cid-lease-${index}`,
        capturedAt: `2026-08-15T02:00:0${index}.000Z`
      },
      ingestionSaga: ingestionSaga(sagaId)
    });
  }

  const [poison] = await repository.claimPendingIngestionSagas({
    workerId: "worker-a",
    now: "2026-08-15T02:01:00.000Z",
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(poison?.saga.sagaId, "saga-poison");
  await repository.failIngestionSaga(scopeA, "saga-poison", {
    workerId: "worker-a",
    failedAt: "2026-08-15T02:01:00.000Z",
    nextAttemptAt: "2026-08-15T02:02:00.000Z",
    errorCode: "RECOVERY_FAILED"
  });
  const [healthy] = await repository.claimPendingIngestionSagas({
    workerId: "worker-b",
    now: "2026-08-15T02:01:00.000Z",
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(healthy?.saga.sagaId, "saga-healthy");
  assert.equal(poison?.saga.lastErrorCode, null);

  const concurrent = await Promise.all([
    repository.claimPendingIngestionSagas({
      workerId: "worker-c",
      now: "2026-08-15T02:03:00.000Z",
      leaseDurationMs: 30_000,
      limit: 1
    }),
    repository.claimPendingIngestionSagas({
      workerId: "worker-d",
      now: "2026-08-15T02:03:00.000Z",
      leaseDurationMs: 30_000,
      limit: 1
    })
  ]);
  const ids = concurrent.flat().map((item) => item.saga.sagaId);
  assert.equal(new Set(ids).size, ids.length);
});

test("standalone event mutations wait for a failing snapshot transaction", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());
  await repository.startFetchAttempt({
    scope: scopeA,
    attemptId: "attempt-existing",
    runId: "run-existing",
    shardId: null,
    discoveryOperationId: null,
    sourceUrl: "https://www.douyin.com/video/123",
    videoId: "123",
    requestedCount: 10,
    startedAt: "2026-08-15T02:00:00.000Z"
  });
  const entered = deferred();
  const release = deferred();
  const failing = repository.transaction(async () => {
    await repository.appendObservation({
      ...observation({ observationId: "observation-doomed" }),
      event: {
        ...observation().event,
        eventId: "event-doomed",
        platformEventId: "cid-doomed"
      },
      ingestionSaga: ingestionSaga("saga-doomed")
    });
    entered.resolve();
    await release.promise;
    throw new Error("ROLLBACK_SNAPSHOT");
  });
  await entered.promise;

  const settled: string[] = [];
  const concurrent = [
    repository.appendObservation({
      ...observation({ observationId: "observation-concurrent" }),
      event: {
        ...observation().event,
        eventId: "event-concurrent",
        platformEventId: "cid-concurrent"
      },
      ingestionSaga: {
        ...ingestionSaga("saga-concurrent"),
        runId: "run-concurrent"
      }
    }).then(() => { settled.push("append"); }),
    repository.linkEvent({
      scope: scopeA,
      eventId: "event-1",
      observationId: "observation-1",
      runId: "run-concurrent",
      shardId: null,
      discoveryOperationId: null,
      candidateId: null,
      evidenceId: null
    }).then(() => { settled.push("link"); }),
    repository.startFetchAttempt({
      scope: scopeA,
      attemptId: "attempt-concurrent",
      runId: "run-concurrent",
      shardId: null,
      discoveryOperationId: null,
      sourceUrl: "https://www.douyin.com/video/123",
      videoId: "123",
      requestedCount: 5,
      startedAt: "2026-08-15T02:01:00.000Z"
    }).then(() => { settled.push("start"); }),
    repository.finishFetchAttempt(scopeA, "attempt-existing", {
      status: "succeeded",
      errorCode: null,
      returnedCount: 4,
      reportedCommentCount: 4,
      pagesFetched: 1,
      completedAt: "2026-08-15T02:01:00.000Z"
    }).then(() => { settled.push("finish"); })
  ];
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeRollback = [...settled].sort();
  release.resolve();
  await assert.rejects(failing, /ROLLBACK_SNAPSHOT/u);
  await Promise.all(concurrent);

  assert.deepEqual(
    settledBeforeRollback,
    [],
    "standalone mutations must queue behind the active snapshot"
  );
  assert.equal(await repository.getIngestionSaga(scopeA, "saga-doomed"), null);
  assert.equal(
    (await repository.getIngestionSaga(scopeA, "saga-concurrent"))
      ?.saga.status,
    "pending"
  );
  assert.equal((await repository.listRunCommentSignals(
    scopeA,
    "run-concurrent",
    { limit: 10 }
  )).length, 1);
  const attempts = await repository.listFetchAttempts(
    scopeA,
    "run-concurrent",
    { limit: 10 }
  );
  assert.equal(attempts[0]?.attemptId, "attempt-concurrent");
  assert.equal((await repository.listFetchAttempts(
    scopeA,
    "run-existing",
    { limit: 10 }
  ))[0]?.status, "succeeded");
});

test("a failing event snapshot waits for a standalone mutation already in flight", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  const survivor = repository.appendObservation({
    ...observation({ observationId: "observation-first" }),
    event: {
      ...observation().event,
      eventId: "event-first",
      platformEventId: "cid-first"
    },
    ingestionSaga: ingestionSaga("saga-first")
  });
  const failing = repository.transaction(async () => {
    assert.equal(
      (await repository.getIngestionSaga(scopeA, "saga-first"))?.saga.status,
      "pending",
      "the later snapshot must start after the standalone append commits"
    );
    await repository.appendObservation({
      ...observation({ observationId: "observation-later-doomed" }),
      event: {
        ...observation().event,
        eventId: "event-later-doomed",
        platformEventId: "cid-later-doomed"
      },
      ingestionSaga: ingestionSaga("saga-later-doomed")
    });
    throw new Error("ROLLBACK_LATER_SNAPSHOT");
  });

  await survivor;
  await assert.rejects(failing, /ROLLBACK_LATER_SNAPSHOT/u);
  assert.equal(
    (await repository.getIngestionSaga(scopeA, "saga-first"))?.saga.status,
    "pending"
  );
  assert.equal(
    await repository.getIngestionSaga(scopeA, "saga-later-doomed"),
    null
  );
});

test("run projections use the latest observation and remain tenant isolated", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());
  await repository.linkEvent({
    scope: scopeA,
    eventId: "event-1",
    observationId: "observation-1",
    runId: "run-1",
    shardId: "shard-1",
    discoveryOperationId: null,
    candidateId: null,
    evidenceId: null
  });
  await repository.appendObservation(observation({
    observationId: "observation-2",
    event: {
      ...observation().event,
      capturedAt: "2026-08-15T03:00:00.000Z",
      likeCount: 9,
      replyCount: 4
    }
  }));
  await repository.linkEvent({
    scope: scopeA,
    eventId: "event-1",
    observationId: "observation-2",
    runId: "run-1",
    shardId: "shard-1",
    discoveryOperationId: null,
    candidateId: null,
    evidenceId: null
  });

  const signals = await repository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.latestObservation.likeCount, 9);
  assert.equal(signals[0]?.latestObservation.replyCount, 4);
  assert.deepEqual(
    await repository.listRunCommentSignals(scopeB, "run-1", { limit: 50 }),
    []
  );
  assert.deepEqual(await repository.getRunCommentSummary(scopeB, "run-1"), {
    linkedEventCount: 0,
    observationCount: 0,
    fetchAttemptCount: 0,
    discoveredVideoCount: 0,
    returnedCommentCount: 0,
    validDemandSignalCount: 0,
    unresolvedActorCount: 0,
    strongSignalCount: 0
  });
});

test("missing platform comment ids fail closed before creating an event", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await assert.rejects(
    repository.appendObservation(observation({
      event: { ...observation().event, platformEventId: "" }
    })),
    /ACQUISITION_DOUYIN_COMMENT_INVALID_EVENT/
  );
  assert.deepEqual(
    await repository.listRunCommentSignals(scopeA, "run-1", { limit: 50 }),
    []
  );
});

test("fetch attempts and event links have replay-safe lifecycles", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());
  const linkInput = {
    scope: scopeA,
    eventId: "event-1",
    observationId: "observation-1",
    runId: "run-1",
    shardId: null,
    discoveryOperationId: null,
    candidateId: null,
    evidenceId: null
  };
  assert.equal((await repository.linkEvent(linkInput)).created, true);
  assert.equal((await repository.linkEvent(linkInput)).created, false);

  const start = {
    scope: scopeA,
    attemptId: "attempt-1",
    runId: "run-1",
    shardId: null,
    discoveryOperationId: null,
    sourceUrl: "https://www.douyin.com/video/123",
    videoId: "123",
    requestedCount: 20,
    startedAt: "2026-08-15T01:00:00.000Z"
  };
  assert.equal((await repository.startFetchAttempt(start)).created, true);
  assert.equal((await repository.startFetchAttempt(start)).created, false);
  const terminal = {
    status: "partial_success" as const,
    errorCode: "rate_limited",
    returnedCount: 7,
    reportedCommentCount: 30,
    pagesFetched: 1,
    completedAt: "2026-08-15T01:00:05.000Z"
  };
  await repository.finishFetchAttempt(scopeA, "attempt-1", terminal);
  await repository.finishFetchAttempt(scopeA, "attempt-1", terminal);
  await assert.rejects(
    repository.finishFetchAttempt(scopeA, "attempt-1", {
      ...terminal,
      returnedCount: 8
    }),
    /FETCH_ATTEMPT_CONFLICT/
  );
  assert.deepEqual(
    (await repository.listFetchAttempts(scopeA, "run-1", { limit: 50 }))[0],
    {
      attemptId: "attempt-1",
      runId: "run-1",
      shardId: null,
      discoveryOperationId: null,
      sourceUrl: "https://www.douyin.com/video/123",
      videoId: "123",
      requestedCount: 20,
      startedAt: "2026-08-15T01:00:00.000Z",
      ...terminal
    }
  );
  const summary = await repository.getRunCommentSummary(scopeA, "run-1");
  assert.equal(summary.linkedEventCount, 1);
  assert.equal(summary.fetchAttemptCount, 1);
  assert.equal(summary.returnedCommentCount, 7);
});

test("later runs cannot change an earlier run comment snapshot", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());
  await repository.linkEvent({
    scope: scopeA,
    eventId: "event-1",
    observationId: "observation-1",
    runId: "run-1",
    shardId: null,
    discoveryOperationId: null,
    candidateId: null,
    evidenceId: null
  });
  await repository.appendObservation(observation({
    observationId: "observation-2",
    event: {
      ...observation().event,
      capturedAt: "2026-08-15T05:00:00.000Z",
      likeCount: 99,
      replyCount: 42
    }
  }));
  await repository.linkEvent({
    scope: scopeA,
    eventId: "event-1",
    observationId: "observation-2",
    runId: "run-2",
    shardId: null,
    discoveryOperationId: null,
    candidateId: null,
    evidenceId: null
  });

  const run1 = await repository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );
  const run2 = await repository.listRunCommentSignals(
    scopeA,
    "run-2",
    { limit: 50 }
  );
  assert.equal(run1[0]?.latestObservation.observationId, "observation-1");
  assert.equal(run1[0]?.latestObservation.likeCount, 2);
  assert.equal(run2[0]?.latestObservation.observationId, "observation-2");
  assert.equal((await repository.getRunCommentSummary(scopeA, "run-1"))
    .observationCount, 1);
});

test("fetch lifecycle rejects invalid counters before mutating state", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await assert.rejects(
    repository.startFetchAttempt({
      scope: scopeA,
      attemptId: "attempt-invalid",
      runId: null,
      shardId: null,
      discoveryOperationId: null,
      sourceUrl: "https://www.douyin.com/video/123",
      videoId: "123",
      requestedCount: -1,
      startedAt: "2026-08-15T01:00:00.000Z"
    }),
    /INVALID_FETCH_ATTEMPT/
  );
});

test("instants canonicalize to UTC milliseconds before replay comparison", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  const offset = observation({
    event: {
      ...observation().event,
      occurredAt: "2026-08-15T08:30:00.987654+08:00",
      capturedAt: "2026-08-15T09:00:00.123456+08:00"
    }
  });
  const first = await repository.appendObservation(offset);
  assert.equal(first.event.occurredAt, "2026-08-15T00:30:00.987Z");
  assert.equal(first.observation.capturedAt, "2026-08-15T01:00:00.123Z");

  const replay = await repository.appendObservation({
    ...offset,
    event: {
      ...offset.event,
      occurredAt: "2026-08-15T00:30:00.987Z",
      capturedAt: "2026-08-15T01:00:00.123Z"
    }
  });
  assert.equal(replay.eventCreated, false);
  assert.equal(replay.observation.observationId, "observation-1");

  const started = await repository.startFetchAttempt({
    scope: scopeA,
    attemptId: "attempt-offset",
    runId: "run-offset",
    shardId: null,
    discoveryOperationId: null,
    sourceUrl: "https://www.douyin.com/video/123",
    videoId: "123",
    requestedCount: 1,
    startedAt: "2026-08-15T09:00:00.123999+08:00"
  });
  assert.equal(started.attempt.startedAt, "2026-08-15T01:00:00.123Z");
});

test("observation id conflicts cannot leave a linkable event orphan", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  await repository.appendObservation(observation());
  const secondEvent = {
    ...observation().event,
    eventId: "event-2",
    platformEventId: "cid-2",
    videoId: "video-2"
  };
  await assert.rejects(
    repository.appendObservation(observation({
      observationId: "observation-1",
      event: secondEvent
    })),
    /OBSERVATION_ID_CONFLICT/
  );

  const retried = await repository.appendObservation(observation({
    observationId: "observation-2",
    event: secondEvent
  }));
  assert.equal(retried.eventCreated, true);
});

test("fetch attempt reads are deterministically bounded", async () => {
  const repository = new InMemoryAcquisitionDouyinCommentEventRepository();
  for (const [attemptId, startedAt] of [
    ["attempt-3", "2026-08-15T03:00:00.000Z"],
    ["attempt-2", "2026-08-15T02:00:00.000Z"],
    ["attempt-1", "2026-08-15T01:00:00.000Z"]
  ]) {
    await repository.startFetchAttempt({
      scope: scopeA,
      attemptId,
      runId: "run-bounded",
      shardId: null,
      discoveryOperationId: null,
      sourceUrl: "https://www.douyin.com/video/123",
      videoId: "123",
      requestedCount: 1,
      startedAt
    });
  }
  assert.deepEqual(
    (await repository.listFetchAttempts(
      scopeA,
      "run-bounded",
      { limit: 2 }
    )).map((attempt) => attempt.attemptId),
    ["attempt-1", "attempt-2"]
  );
  await assert.rejects(
    repository.listFetchAttempts(scopeA, "run-bounded", { limit: 0 }),
    /INVALID_LIMIT/
  );
});
