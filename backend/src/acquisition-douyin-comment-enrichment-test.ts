import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AcquisitionDouyinCommentEnrichmentService
} from "./acquisition-douyin-comment-enrichment.js";
import {
  InMemoryAcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events.js";
import {
  MysqlAcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events-mysql-repository.js";
import {
  DouyinPublicCommentProviderError,
  type DouyinPublicComment,
  type DouyinPublicCommentSamplePage
} from "./douyin-public-comment-provider.js";

const scope = {
  ownerId: "owner-enrichment",
  teamId: "team-enrichment",
  actorId: "worker-enrichment"
};

function comment(commentId: string): DouyinPublicComment {
  return {
    commentId,
    text: `采购 ${commentId}，请报价`,
    occurredAt: "2026-08-15T01:00:00.000Z",
    likeCount: 1,
    replyCount: 0,
    ipLabel: "广东",
    actor: {
      displayName: `用户 ${commentId}`,
      handle: null,
      secUid: `sec-${commentId}`
    }
  };
}

function page(input: {
  comments: DouyinPublicComment[];
  cursor: number | null;
  hasMore: boolean;
  requestedCount: number;
  artifact: string;
  transportRequestCount?: number;
}): DouyinPublicCommentSamplePage {
  return {
    comments: input.comments,
    nextCursor: input.cursor,
    hasMore: input.hasMore,
    reportedCommentCount: 20,
    capturedAt: "2026-08-15T02:00:00.000Z",
    rawArtifactHash: `sha256:${input.artifact.repeat(64)}`,
    providerId: "experimental_public_sample",
    providerVersion: "douyin-public-comment-provider-v1",
    coverage: "public_top_level_sample",
    metadata: {
      requestedCommentCount: input.requestedCount,
      returnedCommentCount: input.comments.length,
      duplicateCommentCount: 0,
      partial: false,
      cursorProgressed: true,
      ...(input.transportRequestCount === undefined ? {} : {
        transportRequestCount: input.transportRequestCount
      })
    },
    replyBodiesIncluded: false
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    scope,
    runId: "run-enrichment",
    shardId: "shard-enrichment",
    discoveryOperationId: null,
    sourceUrls: [
      "https://www.douyin.com/video/7536012345678900001",
      "https://www.douyin.com/video/7536012345678900002"
    ],
    candidateIds: [],
    policy: {
      enabled: true,
      maxVideosPerRun: 2,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 2
    },
    remainingBudget: {
      requests: 3,
      results: 5
    },
    signal: new AbortController().signal,
    ...overrides
  };
}

class FetchAttemptPool {
  readonly attempts = new Map<string, Record<string, unknown>>();

  private key(ownerId: unknown, teamId: unknown, attemptId: unknown) {
    return `${String(ownerId)}\u001f${String(teamId)}\u001f${String(attemptId)}`;
  }

  private async handle(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_fetch_attempts"
    )) {
      const key = this.key(values[1], values[2], values[0]);
      if (this.attempts.has(key)) return [{ affectedRows: 0 }, []];
      this.attempts.set(key, {
        attempt_id: values[0],
        owner_id: values[1],
        team_id: values[2],
        run_id: values[3],
        shard_id: values[4],
        discovery_operation_id: values[5],
        source_url: values[6],
        video_id: values[7],
        status: values[8],
        error_code: values[9],
        requested_count: values[10],
        returned_count: values[11],
        reported_comment_count: values[12],
        pages_fetched: values[13],
        started_at: values[14],
        completed_at: values[15],
        terminal_projection_json: null
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes(
      "FROM acquisition_douyin_comment_fetch_attempts"
    )) {
      const key = this.key(values[0], values[1], values[2]);
      const row = this.attempts.get(key);
      return [row ? [structuredClone(row)] : [], []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_douyin_comment_fetch_attempts"
    )) {
      const key = this.key(values[7], values[8], values[9]);
      const row = this.attempts.get(key);
      if (!row) return [{ affectedRows: 0 }, []];
      Object.assign(row, {
        status: values[0],
        error_code: values[1],
        returned_count: values[2],
        reported_comment_count: values[3],
        pages_fetched: values[4],
        terminal_projection_json: values[5],
        completed_at: values[6]
      });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  }

  query(sql: string, values: unknown[] = []) {
    return this.handle(sql, values);
  }

  async getConnection() {
    return {
      beginTransaction: async () => undefined,
      query: (sql: string, values: unknown[] = []) =>
        this.handle(sql, values),
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined
    };
  }
}

test("enrichment enforces video, page, comment, and remaining Run budgets", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const calls: Array<{ videoId: string; cursor: number; count: number }> = [];
  const ingested: Array<{ videoId: string; count: number }> = [];
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        calls.push({
          videoId: request.videoId,
          cursor: request.cursor,
          count: request.count
        });
        const offset = request.videoId.endsWith("1")
          ? request.cursor === 0 ? 0 : 2
          : 3;
        const returnedCount = request.videoId.endsWith("1")
          && request.cursor === 0 ? 2 : request.count;
        const comments = Array.from(
          { length: returnedCount },
          (_value, index) => comment(`c-${offset + index + 1}`)
        );
        return page({
          comments,
          cursor: request.cursor === 0 ? 1 : null,
          hasMore: request.videoId.endsWith("1")
            && request.cursor === 0,
          requestedCount: request.count,
          artifact: request.videoId.endsWith("1") ? "a" : "b"
        });
      }
    },
    ingestion: {
      async ingestSample(request) {
        ingested.push({
          videoId: request.videoId,
          count: request.page.comments.length
        });
        return {
          eventCount: request.page.comments.length,
          evidenceCount: request.page.comments.length,
          candidateIds: request.page.comments.map((item) =>
            item.commentId === "c-1" ? "candidate-existing"
              : `candidate-${item.commentId}`),
          unresolvedActorCount: 0,
          strongSignalCount: request.page.comments.length,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const result = await service.enrich(input({
    sourceUrls: [
      "https://www.douyin.com/video/7536012345678900001",
      "https://www.douyin.com/video/7536012345678900001",
      "https://example.com/not-douyin",
      "https://www.douyin.com/video/7536012345678900002",
      "https://www.douyin.com/video/7536012345678900003"
    ],
    candidateIds: ["candidate-existing"]
  }));

  assert.deepEqual(calls, [
    { videoId: "7536012345678900001", cursor: 0, count: 3 },
    { videoId: "7536012345678900001", cursor: 1, count: 1 },
    { videoId: "7536012345678900002", cursor: 0, count: 2 }
  ]);
  assert.deepEqual(ingested, [
    { videoId: "7536012345678900001", count: 2 },
    { videoId: "7536012345678900001", count: 1 },
    { videoId: "7536012345678900002", count: 2 }
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    videoCount: 2,
    pagesFetched: 3,
    commentsSampled: 5,
    eventCount: 5,
    evidenceCount: 5,
    candidateIds: [
      "candidate-c-2",
      "candidate-c-3",
      "candidate-c-4",
      "candidate-c-5"
    ],
    unresolvedActorCount: 0,
    strongSignalCount: 5,
    invalidCommentCount: 0,
    errors: [],
    usage: {
      requests: 3,
      results: 5,
      amountMinor: 0,
      durationSeconds: 0
    }
  });
  const attempts = await events.listFetchAttempts(
    scope,
    "run-enrichment",
    { limit: 10 }
  );
  assert.deepEqual(attempts.map((attempt) => ({
    videoId: attempt.videoId,
    status: attempt.status,
    returnedCount: attempt.returnedCount,
    pagesFetched: attempt.pagesFetched
  })), [
    {
      videoId: "7536012345678900001",
      status: "succeeded",
      returnedCount: 3,
      pagesFetched: 2
    },
    {
      videoId: "7536012345678900002",
      status: "succeeded",
      returnedCount: 2,
      pagesFetched: 1
    }
  ]);
});

test("one rate-limited or restricted video preserves other video results", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        if (request.videoId.endsWith("1")) {
          throw new DouyinPublicCommentProviderError("rate_limited");
        }
        if (request.videoId.endsWith("3")) {
          throw new DouyinPublicCommentProviderError("access_restricted");
        }
        return page({
          comments: [comment("survivor")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "c"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        return {
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-survivor"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const result = await service.enrich(input({
    sourceUrls: [
      "https://www.douyin.com/video/7536012345678900001",
      "https://www.douyin.com/video/7536012345678900002",
      "https://www.douyin.com/video/7536012345678900003"
    ],
    policy: {
      enabled: true,
      maxVideosPerRun: 3,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 3, results: 3 }
  }));

  assert.equal(result.status, "partial_success");
  assert.equal(result.commentsSampled, 1);
  assert.deepEqual(result.candidateIds, ["candidate-survivor"]);
  assert.deepEqual(result.errors.map((error) => ({
    videoId: error.videoId,
    code: error.code
  })), [
    { videoId: "7536012345678900001", code: "rate_limited" },
    { videoId: "7536012345678900003", code: "access_restricted" }
  ]);
  assert.deepEqual(result.usage, {
    requests: 3,
    results: 1,
    amountMinor: 0,
    durationSeconds: 0
  });
});

test("disabled policy and non-Douyin sources are safe no-ops", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  let calls = 0;
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample() {
        calls += 1;
        throw new Error("must not fetch");
      }
    },
    ingestion: {
      async ingestSample() {
        throw new Error("must not ingest");
      }
    }
  });

  const disabled = await service.enrich(input({
    policy: {
      enabled: false,
      maxVideosPerRun: 2,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 2
    }
  }));
  const unrelated = await service.enrich(input({
    sourceUrls: ["https://example.com/not-douyin"]
  }));

  assert.equal(disabled.status, "skipped");
  assert.equal(unrelated.status, "skipped");
  assert.deepEqual(disabled.usage, {
    requests: 0,
    results: 0,
    amountMinor: 0,
    durationSeconds: 0
  });
  assert.equal(calls, 0);
});

test("an AbortSignal prevents every later provider request", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const abort = new AbortController();
  let calls = 0;
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        calls += 1;
        abort.abort(new DOMException("cancelled", "AbortError"));
        return page({
          comments: [comment("abort")],
          cursor: 1,
          hasMore: true,
          requestedCount: request.count,
          artifact: "d"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        throw new Error("aborted page must not ingest");
      }
    },
    now: () => "2026-08-15T02:00:00.000Z"
  });

  await assert.rejects(
    service.enrich(input({ signal: abort.signal })),
    (error: unknown) => error instanceof DOMException
      && error.name === "AbortError"
  );
  assert.equal(calls, 1);
});

test("sampled invalid comments still consume the bounded result budget", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  let calls = 0;
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        calls += 1;
        return page({
          comments: [comment("invalid-1"), comment("invalid-2"), comment("invalid-3")],
          cursor: 1,
          hasMore: true,
          requestedCount: request.count,
          artifact: "e"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        return {
          eventCount: 0,
          evidenceCount: 0,
          candidateIds: [],
          unresolvedActorCount: 0,
          strongSignalCount: 0,
          invalidCommentCount: 3
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z"
  });

  const result = await service.enrich(input({
    remainingBudget: { requests: 2, results: 3 }
  }));

  assert.equal(calls, 1);
  assert.equal(result.commentsSampled, 3);
  assert.equal(result.eventCount, 0);
  assert.equal(result.invalidCommentCount, 3);
  assert.equal(result.usage.results, 3);
  assert.equal(result.status, "succeeded");
});

test("internal ingestion failures are not disguised as provider access errors", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const failure = new Error("storage unavailable");
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        return page({
          comments: [comment("internal-failure")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "f"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        throw failure;
      }
    },
    now: () => "2026-08-15T02:00:00.000Z"
  });

  await assert.rejects(service.enrich(input()), (error) => error === failure);
  const attempts = await events.listFetchAttempts(
    scope,
    "run-enrichment",
    { limit: 10 }
  );
  assert.equal(attempts[0]?.status, "failed");
  assert.equal(attempts[0]?.errorCode, "ENRICHMENT_PIPELINE_FAILED");
});

test("exact Run replay reuses the first fetch-attempt clock and remains idempotent", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const instants = [
    "2026-08-15T02:00:00.000Z",
    "2026-08-15T02:10:00.000Z",
    "2026-08-15T02:20:00.000Z",
    "2026-08-15T02:30:00.000Z"
  ];
  let providerCalls = 0;
  let ingestionCalls = 0;
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        providerCalls += 1;
        return page({
          comments: [comment("replay-comment")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "9"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        ingestionCalls += 1;
        return {
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-replay"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0
        };
      }
    },
    now: () => instants.shift() ?? "2026-08-15T02:30:00.000Z",
    nowMs: () => 1_000
  });

  const first = await service.enrich(input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900001"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 }
  }));
  const replay = await service.enrich(input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900001"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 }
  }));

  assert.deepEqual(replay, first);
  assert.equal(providerCalls, 1);
  assert.equal(ingestionCalls, 1);
  assert.equal((await events.listFetchAttempts(
    scope,
    "run-enrichment",
    { limit: 10 }
  )).length, 1);
});

test("mysql restart replays the first terminal projection without provider or ingestion", async () => {
  const pool = new FetchAttemptPool();
  let providerCalls = 0;
  let ingestionCalls = 0;
  const createService = () => new AcquisitionDouyinCommentEnrichmentService({
    events: new MysqlAcquisitionDouyinCommentEventRepository(pool as never),
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        providerCalls += 1;
        return page({
          comments: [comment(`mysql-first-${providerCalls}`)],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "8",
          transportRequestCount: 1
        });
      }
    },
    ingestion: {
      async ingestSample(request) {
        ingestionCalls += 1;
        return {
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: [`candidate-${request.page.comments[0]?.commentId}`],
          unresolvedActorCount: 0,
          strongSignalCount: 1,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });
  const replayInput = input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900001"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 }
  });

  const first = await createService().enrich(replayInput);
  const replay = await createService().enrich(replayInput);

  assert.deepEqual(replay, first);
  assert.equal(providerCalls, 1);
  assert.equal(ingestionCalls, 1);
  assert.equal(pool.attempts.size, 1);

  const foreign = await createService().enrich({
    ...replayInput,
    scope: { ...scope, ownerId: "owner-enrichment-foreign" }
  });
  assert.equal(providerCalls, 2);
  assert.equal(ingestionCalls, 2);
  assert.equal(pool.attempts.size, 2);
  assert.notDeepEqual(foreign.candidateIds, first.candidateIds);
});

test("transport retries consume the real request budget reported by the provider", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const budgets: number[] = [];
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        budgets.push((request as typeof request & {
          transportRequestBudget: number;
        }).transportRequestBudget);
        return page({
          comments: [comment("transport-budget")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "8",
          transportRequestCount: 3
        });
      }
    },
    ingestion: {
      async ingestSample() {
        return {
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-transport-budget"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const result = await service.enrich(input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900001"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 3, results: 1 }
  }));

  assert.deepEqual(budgets, [3]);
  assert.equal(result.usage.requests, 3);
});

test("post-response validation does not count one HTTP request twice", async () => {
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events: new InMemoryAcquisitionDouyinCommentEventRepository(),
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        return page({
          comments: [comment("over-limit-1"), comment("over-limit-2")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "3",
          transportRequestCount: 1
        });
      }
    },
    ingestion: {
      async ingestSample() {
        throw new Error("invalid page must not reach ingestion");
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const result = await service.enrich(input({
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 3, results: 1 }
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.errors[0]?.code, "source_payload_invalid");
  assert.equal(result.usage.requests, 1);
});

test("cross-page duplicate comments and cursor loops stay local to one enrichment call", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const cursors: number[] = [];
  const ingestedCommentIds: string[][] = [];
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        cursors.push(request.cursor);
        return request.cursor === 0
          ? page({
              comments: [comment("cid-local-1")],
              cursor: 1,
              hasMore: true,
              requestedCount: request.count,
              artifact: "5"
            })
          : page({
              comments: [
                comment("cid-local-1"),
                comment("cid-local-2")
              ],
              cursor: 0,
              hasMore: true,
              requestedCount: request.count,
              artifact: "4"
            });
      }
    },
    ingestion: {
      async ingestSample(request) {
        ingestedCommentIds.push(request.page.comments.map((item) =>
          item.commentId));
        return {
          eventCount: request.page.comments.length,
          evidenceCount: request.page.comments.length,
          candidateIds: request.page.comments.map((item) =>
            `candidate-${item.commentId}`),
          unresolvedActorCount: request.page.comments.length,
          strongSignalCount: request.page.comments.length,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const result = await service.enrich(input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900001"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 10,
      maxPagesPerVideo: 5
    },
    remainingBudget: { requests: 5, results: 10 }
  }));

  assert.deepEqual(cursors, [0, 1]);
  assert.deepEqual(ingestedCommentIds, [
    ["cid-local-1"],
    ["cid-local-2"]
  ]);
  assert.equal(result.commentsSampled, 2);
  assert.deepEqual(result.candidateIds, [
    "candidate-cid-local-1",
    "candidate-cid-local-2"
  ]);
});

test("no-public-comments is explanatory empty coverage rather than a failed video", async () => {
  const events = new InMemoryAcquisitionDouyinCommentEventRepository();
  const service = new AcquisitionDouyinCommentEnrichmentService({
    events,
    provider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(request) {
        if (request.videoId.endsWith("2")) {
          throw new DouyinPublicCommentProviderError("no_public_comments");
        }
        return page({
          comments: [comment("cid-covered")],
          cursor: null,
          hasMore: false,
          requestedCount: request.count,
          artifact: "3"
        });
      }
    },
    ingestion: {
      async ingestSample() {
        return {
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-covered"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0
        };
      }
    },
    now: () => "2026-08-15T02:00:00.000Z",
    nowMs: () => 1_000
  });

  const mixed = await service.enrich(input({
    policy: {
      enabled: true,
      maxVideosPerRun: 2,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 2, results: 2 }
  }));
  assert.equal(mixed.status, "succeeded");
  assert.deepEqual(mixed.errors.map((error) => error.code), [
    "no_public_comments"
  ]);

  const empty = await service.enrich(input({
    sourceUrls: ["https://www.douyin.com/video/7536012345678900002"],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 }
  }));
  assert.equal(empty.status, "succeeded_empty");
  assert.deepEqual(empty.errors.map((error) => error.code), [
    "no_public_comments"
  ]);
});
