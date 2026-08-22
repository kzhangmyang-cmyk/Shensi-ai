import assert from "node:assert/strict";
import { test } from "node:test";
import XLSX from "xlsx-js-style";
import type { DiscoveryEvidenceInput } from "./acquisition-domain.js";
import {
  AcquisitionDiscoveryOperationError,
  AcquisitionDiscoveryOperationService,
  ControlledPublicContentFetcher,
  InMemoryAcquisitionDiscoveryOperationRepository,
  type AcquisitionContentFetchCommentExecution
} from "./acquisition-discovery-operations.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import type {
  AcquisitionDouyinCommentEnrichmentPort
} from "./acquisition-douyin-comment-enrichment.js";

process.env.NODE_ENV = "test";

const NOW = "2026-07-24T08:00:00.000Z";
const scope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "user-a"
};

function evidenceSink(onAppend?: (count: number) => void) {
  const appended: Array<{
    scope: typeof scope;
    input: DiscoveryEvidenceInput;
    idempotencyKey: string;
  }> = [];
  return {
    appended,
    port: {
      async appendEvidence(
        actualScope: typeof scope,
        input: DiscoveryEvidenceInput,
        idempotencyKey: string
      ) {
        appended.push({
          scope: structuredClone(actualScope),
          input: structuredClone(input),
          idempotencyKey
        });
        onAppend?.(appended.length);
        return {
          ...input,
          id: `evidence-${appended.length}`,
          ownerId: actualScope.ownerId,
          teamId: actualScope.teamId,
          supersedesEvidenceId: input.supersedesEvidenceId ?? null,
          fetchedAt: NOW
        };
      }
    }
  };
}

function serviceFixture(input: {
  fetch?: (sourceUrl: string) => Promise<{
    finalUrl: string;
    status: "succeeded" | "access_restricted";
    accessStatus: "public_content" | "access_restricted";
    httpStatus: number;
    contentType: string;
    title: string;
    text: string;
    rawArtifactHash: string;
    contentHash: string;
  }>;
  onEvidenceAppend?: (count: number) => void;
  commentEnrichment?: AcquisitionDouyinCommentEnrichmentPort;
} = {}) {
  const sink = evidenceSink(input.onEvidenceAppend);
  const repository =
    new InMemoryAcquisitionDiscoveryOperationRepository();
  const service = new AcquisitionDiscoveryOperationService({
    repository,
    evidence: sink.port,
    fetcher: {
      fetch: input.fetch ?? (async (sourceUrl) => ({
        finalUrl: sourceUrl,
        status: "succeeded",
        accessStatus: "public_content",
        httpStatus: 200,
        contentType: "text/html; charset=utf-8",
        title: "公开采购需求",
        text: "某制造企业正在公开寻找 CRM 与获客系统供应商。",
        rawArtifactHash: `sha256:${"a".repeat(64)}`,
        contentHash: `sha256:${"b".repeat(64)}`
      }))
    },
    commentEnrichment: input.commentEnrichment,
    masterSecret:
      "goodjob-discovery-operation-test-secret-at-least-32-bytes",
    idFactory: (prefix) => `${prefix}-${repository.size(prefix) + 1}`,
    now: () => NOW
  });
  return { service, repository, sink };
}

const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function simpleXlsxBuffer() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["标题", "摘要"],
    ["公开商机", "客户正在寻找 CRM"]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "线索");
  return Buffer.from(XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  }) as Buffer);
}

function zipEocdOffset(buffer: Buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset)
      === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("test XLSX has no EOCD");
}

function zipCentralEntries(buffer: Buffer) {
  const eocd = zipEocdOffset(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: Array<{
    offset: number;
    localOffset: number;
    name: string;
  }> = [];
  for (let index = 0; index < totalEntries; index += 1) {
    assert.equal(
      buffer.readUInt32LE(offset),
      ZIP_CENTRAL_DIRECTORY_SIGNATURE
    );
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      offset,
      localOffset: buffer.readUInt32LE(offset + 42),
      name: buffer.subarray(
        offset + 46,
        offset + 46 + nameLength
      ).toString("utf8")
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function replaceCentralEntryName(
  source: Buffer,
  currentName: string,
  dangerousName: string
) {
  assert.equal(
    Buffer.byteLength(dangerousName),
    Buffer.byteLength(currentName)
  );
  const buffer = Buffer.from(source);
  const entry = zipCentralEntries(buffer)
    .find((candidate) => candidate.name === currentName);
  assert.ok(entry);
  buffer.write(dangerousName, entry.offset + 46, "utf8");
  return buffer;
}

async function assertRejectedXlsx(
  content: Buffer,
  idempotencyKey: string,
  code: "IMPORT_ARTIFACT_INVALID" | "IMPORT_LIMIT_EXCEEDED"
) {
  const fixture = serviceFixture();
  const created = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "不安全.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    idempotencyKey
  );
  await assert.rejects(
    fixture.service.executeImportOperation(scope, created.id),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === code
      && error.message === code
  );
  const failed = await fixture.service.getImportOperation(
    scope,
    created.id
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, code);
  assert.equal(fixture.sink.appended.length, 0);
}

test("content fetch operation is idempotent, tenant scoped, and appends public evidence", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/public-opportunity",
      subjectChannel: "organization"
    },
    "fetch-key-1"
  );
  assert.equal(created.status, "queued");
  assert.equal(created.ownerId, scope.ownerId);
  assert.deepEqual(created.evidenceIds, []);

  const duplicate = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/public-opportunity",
      subjectChannel: "organization"
    },
    "fetch-key-1"
  );
  assert.equal(duplicate.id, created.id);

  await assert.rejects(
    fixture.service.createContentFetchOperation(
      scope,
      {
        sourceUrl: "https://example.com/different",
        subjectChannel: "organization"
      },
      "fetch-key-1"
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );

  const completed = await fixture.service.executeContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.accessStatus, "public_content");
  assert.equal(completed.evidenceCount, 1);
  assert.deepEqual(completed.evidenceIds, ["evidence-1"]);
  assert.match(completed.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.sink.appended.length, 1);
  assert.deepEqual(
    fixture.sink.appended[0]?.input.provenance,
    {
      kind: "user_submitted_url",
      sourceUrl: "https://example.com/public-opportunity",
      submittedBy: scope.actorId
    }
  );

  const replay = await fixture.service.executeContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(replay.status, "succeeded");
  assert.equal(fixture.sink.appended.length, 1);

  await assert.rejects(
    fixture.service.getContentFetchOperation(
      { ...scope, ownerId: "owner-b" },
      created.id
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "RESOURCE_NOT_FOUND"
  );
});

test("explicit direct content fetch persists its bounded enrichment intent with creation", async () => {
  const fixture = serviceFixture({
    commentEnrichment: {
      async enrich() {
        throw new Error("not dispatched during create");
      }
    }
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900001",
      subjectChannel: "individual"
    },
    "direct-intent-is-durable",
    { queueStandaloneCommentEnrichment: true }
  );
  const stored = await fixture.repository.getContentFetchOperation(
    scope,
    created.id
  );

  assert.equal(created.commentSampleSummary, null);
  assert.equal("commentEnrichmentExecutions" in created, false);
  assert.equal("requestSemanticsVersion" in created, false);
  assert.equal(stored?.commentEnrichmentExecutions?.length, 1);
  assert.deepEqual(
    stored?.commentEnrichmentExecutions?.[0]?.remainingBudget,
    { requests: 3, results: 30 }
  );
  assert.equal(
    stored?.commentEnrichmentExecutions?.[0]?.contextKey,
    "direct"
  );
});

test("failed base fetch terminally settles its caller comment execution", async () => {
  let enrichmentCalls = 0;
  const fixture = serviceFixture({
    fetch: async () => {
      throw new Error("base transport failed");
    },
    commentEnrichment: {
      async enrich() {
        enrichmentCalls += 1;
        throw new Error("comment enrichment must not run");
      }
    }
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900991",
      subjectChannel: "individual"
    },
    "failed-base-settles-comment",
    { queueStandaloneCommentEnrichment: true }
  );

  await assert.rejects(
    fixture.service.executeContentFetchOperation(scope, created.id),
    /base transport failed/u
  );
  const stored = await fixture.repository.getContentFetchOperation(
    scope,
    created.id
  );
  const execution = stored?.commentEnrichmentExecutions?.[0] as
    | (AcquisitionContentFetchCommentExecution & { status: string })
    | undefined;
  assert.equal(execution?.status, "failed");
  assert.equal(execution?.summary, null);
  assert.equal(execution?.lastErrorCode, "BASE_CONTENT_FETCH_FAILED");
  assert.equal(execution?.completedAt, NOW);
  assert.equal(execution?.leaseToken, null);
  assert.equal(enrichmentCalls, 0);
  assert.equal((await fixture.repository.listRecoverableOperations({
    now: "2026-07-24T09:00:00.000Z",
    staleRunningBefore: "2026-07-24T08:30:00.000Z",
    limit: 10
  })).some((item) => item.executionId === execution?.executionId), false);
});

test("standalone comment intent is immutable idempotency input in both directions", async () => {
  for (const [first, replay] of [[true, false], [false, true]] as const) {
    const fixture = serviceFixture();
    await fixture.service.createContentFetchOperation(
      scope,
      {
        sourceUrl: "https://www.douyin.com/video/7536012345678900992",
        subjectChannel: "individual"
      },
      `standalone-intent-${String(first)}`,
      { queueStandaloneCommentEnrichment: first }
    );
    await assert.rejects(
      fixture.service.createContentFetchOperation(
        scope,
        {
          sourceUrl: "https://www.douyin.com/video/7536012345678900992",
          subjectChannel: "individual"
        },
        `standalone-intent-${String(first)}`,
        { queueStandaloneCommentEnrichment: replay }
      ),
      (error: unknown) =>
        error instanceof AcquisitionDiscoveryOperationError
        && error.code === "IDEMPOTENCY_CONFLICT"
    );
  }
});

test("memory repository rejects a 1001st comment execution without changing the operation", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900993",
      subjectChannel: "individual"
    },
    "execution-limit-seed"
  );
  const seed = await fixture.repository.getContentFetchOperation(
    scope,
    created.id
  );
  assert.ok(seed);
  const template: AcquisitionContentFetchCommentExecution = {
    executionId: "comment-enrichment:seed",
    contextKey: "run:seed:seed",
    runId: "seed",
    shardId: "seed",
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  };
  const fullRepository =
    new InMemoryAcquisitionDiscoveryOperationRepository();
  await fullRepository.createContentFetchOperation({
    ...seed,
    id: "fetch-execution-limit",
    idempotencyKeyHash: "execution-limit-hash",
    commentEnrichmentExecutions: Array.from(
      { length: 1_000 },
      (_unused, index) => ({
        ...template,
        executionId: `comment-enrichment:seed-${index}`,
        contextKey: `run:seed-${index}:seed-${index}`,
        runId: `seed-${index}`,
        shardId: `seed-${index}`
      })
    )
  });
  await assert.rejects(
    fullRepository.putContentFetchCommentExecution(
      scope,
      "fetch-execution-limit",
      {
        ...template,
        executionId: "comment-enrichment:overflow",
        contextKey: "run:overflow:overflow",
        runId: "overflow",
        shardId: "overflow"
      }
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "INVALID_REQUEST"
  );
  assert.equal((await fullRepository.getContentFetchOperation(
    scope,
    "fetch-execution-limit"
  ))?.commentEnrichmentExecutions?.length, 1_000);
});

test("an explicit standalone Douyin link persists bounded comment enrichment without a Run", async () => {
  const enrichmentCalls: Parameters<
    AcquisitionDouyinCommentEnrichmentPort["enrich"]
  >[0][] = [];
  const fixture = serviceFixture({
    fetch: async (sourceUrl) => ({
      finalUrl: sourceUrl,
      status: "succeeded",
      accessStatus: "public_content",
      httpStatus: 200,
      contentType: "text/html",
      title: "抖音公开视频",
      text: "公开视频原页证据",
      rawArtifactHash: `sha256:${"e".repeat(64)}`,
      contentHash: `sha256:${"f".repeat(64)}`
    }),
    commentEnrichment: {
      async enrich(input) {
        enrichmentCalls.push(input);
        return {
          status: "succeeded",
          videoCount: 1,
          pagesFetched: 1,
          commentsSampled: 2,
          eventCount: 2,
          evidenceCount: 2,
          candidateIds: ["candidate-comment-a", "candidate-comment-b"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0,
          errors: [],
          usage: {
            requests: 1,
            results: 2,
            amountMinor: 0,
            durationSeconds: 1
          }
        };
      }
    }
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl:
        "https://www.douyin.com/video/7536012345678900001",
      subjectChannel: "individual"
    },
    "standalone-douyin-comment-enrichment"
  );

  const completed = await fixture.service.executeContentFetchOperation(
    scope,
    created.id
  );

  assert.equal(enrichmentCalls.length, 1);
  assert.equal(enrichmentCalls[0]!.signal.aborted, false);
  assert.deepEqual({ ...enrichmentCalls[0], signal: undefined }, {
    scope,
    runId: null,
    shardId: null,
    discoveryOperationId: created.id,
    sourceUrls: [
      "https://www.douyin.com/video/7536012345678900001"
    ],
    candidateIds: [],
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 30,
      maxPagesPerVideo: 3
    },
    remainingBudget: { requests: 3, results: 30 },
    signal: undefined
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.evidenceCount, 1);
  assert.deepEqual(completed.candidateIds, [
    "candidate-comment-a",
    "candidate-comment-b"
  ]);
  assert.equal(completed.candidateCount, 2);
  assert.deepEqual(completed.commentSampleSummary, {
    status: "succeeded",
    videoCount: 1,
    pagesFetched: 1,
    commentsSampled: 2,
    eventCount: 2,
    evidenceCount: 2,
    candidateIds: ["candidate-comment-a", "candidate-comment-b"],
    unresolvedActorCount: 1,
    strongSignalCount: 1,
    invalidCommentCount: 0,
    errors: [],
    usage: {
      requests: 1,
      results: 2,
      amountMinor: 0,
      durationSeconds: 1
    }
  });
  const replay = await fixture.service.executeContentFetchOperation(
    scope,
    created.id
  );
  assert.deepEqual(replay.commentSampleSummary, completed.commentSampleSummary);
  assert.equal(enrichmentCalls.length, 1);
});

test("terminal and concurrent content fetch callers keep direct and Run enrichment contexts separate", async () => {
  const enrichmentCalls: Array<{
    runId: string | null;
    shardId: string | null;
    policy: unknown;
    remainingBudget: unknown;
  }> = [];
  const fixture = serviceFixture({
    fetch: async (sourceUrl) => ({
      finalUrl: sourceUrl,
      status: "succeeded",
      accessStatus: "public_content",
      httpStatus: 200,
      contentType: "text/html",
      title: "抖音公开视频",
      text: "公开视频原页证据",
      rawArtifactHash: `sha256:${"7".repeat(64)}`,
      contentHash: `sha256:${"6".repeat(64)}`
    }),
    commentEnrichment: {
      async enrich(enrichmentInput) {
        enrichmentCalls.push({
          runId: enrichmentInput.runId,
          shardId: enrichmentInput.shardId,
          policy: enrichmentInput.policy,
          remainingBudget: enrichmentInput.remainingBudget
        });
        const suffix = enrichmentInput.runId ?? "direct";
        return {
          status: "succeeded",
          videoCount: 1,
          pagesFetched: 1,
          commentsSampled: 1,
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: [`candidate-${suffix}`],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0,
          errors: [],
          usage: {
            requests: 1,
            results: 1,
            amountMinor: 0,
            durationSeconds: 0
          }
        };
      }
    }
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900001",
      subjectChannel: "individual"
    },
    "caller-context-isolation"
  );
  const runContext = {
    runId: "run-isolated",
    shardId: "shard-isolated",
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 4,
      maxPagesPerVideo: 2
    },
    remainingBudget: { requests: 3, results: 5 }
  };

  const [direct, run] = await Promise.all([
    fixture.service.executeContentFetchOperation(scope, created.id),
    fixture.service.executeContentFetchOperation(
      scope,
      created.id,
      new AbortController().signal,
      runContext
    )
  ]);

  assert.deepEqual(enrichmentCalls, [{
    runId: null,
    shardId: null,
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 30,
      maxPagesPerVideo: 3
    },
    remainingBudget: { requests: 3, results: 30 }
  }, {
    runId: "run-isolated",
    shardId: "shard-isolated",
    policy: runContext.policy,
    remainingBudget: { requests: 2, results: 4 }
  }]);
  assert.deepEqual(direct.commentSampleSummary?.candidateIds, [
    "candidate-direct"
  ]);
  assert.deepEqual(run.commentSampleSummary?.candidateIds, [
    "candidate-run-isolated"
  ]);

  const reverseCreated = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900002",
      subjectChannel: "individual"
    },
    "caller-context-isolation-run-first"
  );
  const reverseContext = {
    ...runContext,
    runId: "run-first",
    shardId: "shard-first"
  };
  const [runFirst, directSecond] = await Promise.all([
    fixture.service.executeContentFetchOperation(
      scope,
      reverseCreated.id,
      new AbortController().signal,
      reverseContext
    ),
    fixture.service.executeContentFetchOperation(scope, reverseCreated.id)
  ]);
  assert.deepEqual(runFirst.commentSampleSummary?.candidateIds, [
    "candidate-run-first"
  ]);
  assert.deepEqual(directSecond.commentSampleSummary?.candidateIds, [
    "candidate-direct"
  ]);

  const terminalCreated = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900003",
      subjectChannel: "individual"
    },
    "caller-context-isolation-terminal-direct"
  );
  await fixture.service.executeContentFetchOperation(
    scope,
    terminalCreated.id
  );
  const terminalRun = await fixture.service.executeContentFetchOperation(
    scope,
    terminalCreated.id,
    new AbortController().signal,
    {
      ...runContext,
      runId: "run-after-terminal-direct",
      shardId: "shard-after-terminal-direct"
    }
  );
  assert.deepEqual(terminalRun.commentSampleSummary?.candidateIds, [
    "candidate-run-after-terminal-direct"
  ]);
  assert.equal(enrichmentCalls.length, 6);
});

test("a persisted Run enrichment survives base completion and restart without caller replay", async () => {
  const repository = new InMemoryAcquisitionDiscoveryOperationRepository();
  const sink = evidenceSink();
  const runContext = {
    runId: "run-restart",
    shardId: "shard-restart",
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 4,
      maxPagesPerVideo: 2
    },
    remainingBudget: { requests: 3, results: 5 }
  };
  const common = {
    repository,
    evidence: sink.port,
    fetcher: {
      async fetch(sourceUrl: string) {
        return {
          finalUrl: sourceUrl,
          status: "succeeded" as const,
          accessStatus: "public_content" as const,
          httpStatus: 200,
          contentType: "text/html",
          title: "抖音公开视频",
          text: "公开原页证据",
          rawArtifactHash: `sha256:${"2".repeat(64)}`,
          contentHash: `sha256:${"1".repeat(64)}`
        };
      }
    },
    masterSecret:
      "goodjob-discovery-restart-test-secret-at-least-32-bytes",
    idFactory: (prefix: string) => `${prefix}-${repository.size(prefix) + 1}`,
    now: () => "2026-08-15T04:00:00.000Z"
  };
  const crashing = new AcquisitionDiscoveryOperationService({
    ...common,
    commentEnrichment: {
      async enrich() {
        throw new Error("CRASH_AFTER_BASE_BEFORE_COMMENT_RESULT");
      }
    }
  });
  const created = await crashing.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900001",
      subjectChannel: "individual"
    },
    "run-enrichment-restart"
  );
  await assert.rejects(
    crashing.executeContentFetchOperation(
      scope,
      created.id,
      new AbortController().signal,
      runContext
    ),
    /CRASH_AFTER_BASE_BEFORE_COMMENT_RESULT/
  );
  const afterCrash = await crashing.getContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(afterCrash.status, "succeeded");
  assert.equal(afterCrash.commentSampleSummary, null);

  const recoveredInputs: Parameters<
    AcquisitionDouyinCommentEnrichmentPort["enrich"]
  >[0][] = [];
  const restarted = new AcquisitionDiscoveryOperationService({
    ...common,
    now: () => "2026-08-15T04:10:00.000Z",
    commentEnrichment: {
      async enrich(enrichmentInput) {
        recoveredInputs.push(enrichmentInput);
        return {
          status: "succeeded",
          videoCount: 1,
          pagesFetched: 1,
          commentsSampled: 1,
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-recovered-run"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0,
          errors: [],
          usage: {
            requests: 1,
            results: 1,
            amountMinor: 0,
            durationSeconds: 0
          }
        };
      }
    }
  });
  const recovery = restarted as AcquisitionDiscoveryOperationService & {
    recoverContentFetchOperation(
      actualScope: typeof scope,
      operationId: string
    ): Promise<unknown>;
  };
  await recovery.recoverContentFetchOperation(scope, created.id);
  assert.equal(recoveredInputs.length, 1);
  assert.deepEqual({ ...recoveredInputs[0], signal: undefined }, {
    scope,
    runId: "run-restart",
    shardId: "shard-restart",
    discoveryOperationId: created.id,
    sourceUrls: [
      "https://www.douyin.com/video/7536012345678900001"
    ],
    candidateIds: [],
    policy: runContext.policy,
    remainingBudget: { requests: 2, results: 4 },
    signal: undefined
  });
  const publicOperation = await restarted.getContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(publicOperation.commentSampleSummary, null);
  assert.doesNotMatch(
    JSON.stringify(publicOperation),
    /lease|policy|remainingBudget|commentEnrichmentExecutions/u
  );
  const replay = await restarted.executeContentFetchOperation(
    scope,
    created.id,
    new AbortController().signal,
    runContext
  );
  assert.deepEqual(replay.commentSampleSummary?.candidateIds, [
    "candidate-recovered-run"
  ]);
  assert.equal(recoveredInputs.length, 1);
});

test("content fetch operation listing is tenant scoped, limited, and newest first", async () => {
  const fixture = serviceFixture();
  const first = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/first",
      subjectChannel: "organization"
    },
    "fetch-list-key-1"
  );
  await fixture.service.createContentFetchOperation(
    {
      ownerId: "owner-b",
      teamId: scope.teamId,
      actorId: "user-b"
    },
    {
      sourceUrl: "https://example.com/foreign",
      subjectChannel: "organization"
    },
    "fetch-list-key-foreign"
  );
  const latest = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/latest",
      subjectChannel: "individual"
    },
    "fetch-list-key-2"
  );

  const listed = await fixture.service.listContentFetchOperations(
    scope,
    { limit: 1 }
  );

  assert.deepEqual(listed.map((operation) => operation.id), [latest.id]);
  assert.notEqual(listed[0]?.id, first.id);
  assert.equal(listed[0]?.ownerId, scope.ownerId);
  assert.equal(
    "idempotencyKeyHash" in (listed[0] ?? {}),
    false
  );
});

test("expired discovery leases are taken over with fencing while live leases are preserved", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/recoverable-opportunity",
      subjectChannel: "organization"
    },
    "fetch-lease-key"
  );
  const first = await fixture.repository.claimContentFetchOperation(
    scope,
    created.id,
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      claimedAt: "2026-07-24T08:00:00.000Z",
      leaseExpiresAt: "2026-07-24T08:10:00.000Z",
      staleRunningBefore: "2026-07-24T07:50:00.000Z"
    }
  );
  assert.equal(first.claimed, true);

  const liveLease = await fixture.repository.claimContentFetchOperation(
    scope,
    created.id,
    {
      leaseOwner: "worker-b",
      leaseToken: "lease-b-live",
      claimedAt: "2026-07-24T08:05:00.000Z",
      leaseExpiresAt: "2026-07-24T08:15:00.000Z",
      staleRunningBefore: "2026-07-24T07:55:00.000Z"
    }
  );
  assert.equal(liveLease.claimed, false);
  assert.equal(liveLease.operation?.leaseToken, "lease-a");

  const takeover = await fixture.repository.claimContentFetchOperation(
    scope,
    created.id,
    {
      leaseOwner: "worker-b",
      leaseToken: "lease-b",
      claimedAt: "2026-07-24T08:11:00.000Z",
      leaseExpiresAt: "2026-07-24T08:21:00.000Z",
      staleRunningBefore: "2026-07-24T08:01:00.000Z"
    }
  );
  assert.equal(takeover.claimed, true);
  assert.equal(takeover.operation?.leaseToken, "lease-b");

  await assert.rejects(
    fixture.repository.putContentFetchOperation({
      ...first.operation!,
      status: "succeeded",
      completedAt: "2026-07-24T08:12:00.000Z"
    }, "lease-a"),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
      && error.message === "OPERATION_LEASE_LOST"
  );
  const current = await fixture.repository.getContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(current?.status, "running");
  assert.equal(current?.leaseToken, "lease-b");
});

test("recovery listing spans tenants, is bounded and excludes live or terminal work", async () => {
  const fixture = serviceFixture();
  const foreignScope = {
    ownerId: "owner-b",
    teamId: "team-b",
    actorId: "user-b"
  };
  const expired = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/expired",
      subjectChannel: "organization"
    },
    "fetch-recovery-expired"
  );
  const queued = await fixture.service.createContentFetchOperation(
    foreignScope,
    {
      sourceUrl: "https://example.com/queued",
      subjectChannel: "individual"
    },
    "fetch-recovery-queued"
  );
  const live = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/live",
      subjectChannel: "organization"
    },
    "fetch-recovery-live"
  );
  await fixture.repository.claimContentFetchOperation(scope, expired.id, {
    leaseOwner: "old-worker",
    leaseToken: "expired-token",
    claimedAt: "2026-07-24T07:00:00.000Z",
    leaseExpiresAt: "2026-07-24T07:10:00.000Z",
    staleRunningBefore: "2026-07-24T06:50:00.000Z"
  });
  await fixture.repository.claimContentFetchOperation(scope, live.id, {
    leaseOwner: "live-worker",
    leaseToken: "live-token",
    claimedAt: "2026-07-24T07:55:00.000Z",
    leaseExpiresAt: "2026-07-24T08:10:00.000Z",
    staleRunningBefore: "2026-07-24T07:45:00.000Z"
  });

  const recoverable =
    await fixture.repository.listRecoverableOperations({
      now: "2026-07-24T08:00:00.000Z",
      staleRunningBefore: "2026-07-24T07:45:00.000Z",
      limit: 2
    });

  assert.deepEqual(
    recoverable.map((operation) => operation.id),
    [expired.id, queued.id]
  );
  assert.deepEqual(
    recoverable.map((operation) => operation.ownerId),
    [scope.ownerId, foreignScope.ownerId]
  );
  assert.equal(
    recoverable.some((operation) => operation.id === live.id),
    false
  );
});

test("comment execution recovery is tenant scoped, leased once, and backs off poison work", async () => {
  const fixture = serviceFixture();
  const poison = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900101",
      subjectChannel: "individual"
    },
    "comment-recovery-poison"
  );
  const healthy = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900102",
      subjectChannel: "individual"
    },
    "comment-recovery-healthy"
  );
  await Promise.all([
    fixture.service.executeContentFetchOperation(scope, poison.id),
    fixture.service.executeContentFetchOperation(scope, healthy.id)
  ]);
  const execution = (
    operationId: string
  ): AcquisitionContentFetchCommentExecution => ({
    executionId: `comment-execution:${operationId}`,
    contextKey: `run:run-${operationId}:shard-${operationId}`,
    runId: `run-${operationId}`,
    shardId: `shard-${operationId}`,
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 3 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  });
  const poisonExecution = execution(poison.id);
  const healthyExecution = execution(healthy.id);
  await fixture.repository.putContentFetchCommentExecution(
    scope,
    poison.id,
    poisonExecution
  );
  await fixture.repository.putContentFetchCommentExecution(
    scope,
    healthy.id,
    healthyExecution
  );
  await assert.rejects(
    fixture.repository.putContentFetchCommentExecution(
      { ownerId: "foreign", teamId: scope.teamId },
      poison.id,
      poisonExecution
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "RESOURCE_NOT_FOUND"
  );

  const claim = (worker: string) =>
    fixture.repository.claimContentFetchCommentExecution(
      scope,
      poison.id,
      poisonExecution.executionId,
      {
        leaseOwner: worker,
        leaseToken: `lease-${worker}`,
        claimedAt: NOW,
        leaseExpiresAt: "2026-07-24T08:10:00.000Z",
        staleRunningBefore: "2026-07-24T07:50:00.000Z"
      }
    );
  const claims = await Promise.all([claim("a"), claim("b")]);
  assert.equal(claims.filter((result) => result.claimed).length, 1);
  const winner = claims.find((result) => result.claimed)!;
  await fixture.repository.failContentFetchCommentExecution(
    scope,
    poison.id,
    poisonExecution.executionId,
    winner.execution!.leaseToken!,
    NOW
  );

  const next = await fixture.repository.listRecoverableOperations({
    now: NOW,
    staleRunningBefore: "2026-07-24T07:50:00.000Z",
    limit: 1
  });
  assert.deepEqual(next.map((item) => [item.kind, item.id]), [[
    "content_fetch_comment_enrichment",
    healthy.id
  ]]);
  const storedPoison = await fixture.repository.getContentFetchOperation(
    scope,
    poison.id
  );
  assert.equal(
    storedPoison?.commentEnrichmentExecutions?.[0]?.lastErrorCode,
    "COMMENT_ENRICHMENT_FAILED"
  );
  assert.equal(
    storedPoison?.commentEnrichmentExecutions?.[0]?.nextAttemptAt,
    "2026-07-24T08:00:02.000Z"
  );
});

test("access restricted content is recorded honestly and never presented as fetched content", async () => {
  const fixture = serviceFixture({
    fetch: async (sourceUrl) => ({
      finalUrl: sourceUrl,
      status: "access_restricted",
      accessStatus: "access_restricted",
      httpStatus: 403,
      contentType: "text/html",
      title: "",
      text: "",
      rawArtifactHash: `sha256:${"c".repeat(64)}`,
      contentHash: `sha256:${"d".repeat(64)}`
    })
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/login-required",
      subjectChannel: "individual"
    },
    "fetch-key-restricted"
  );
  const completed = await fixture.service.executeContentFetchOperation(
    scope,
    created.id
  );
  assert.equal(completed.status, "access_restricted");
  assert.equal(completed.accessStatus, "access_restricted");
  assert.equal(completed.evidenceCount, 1);
  assert.equal(
    fixture.sink.appended[0]?.input.accessStatus,
    "access_restricted"
  );
  assert.match(
    fixture.sink.appended[0]?.input.sourceSnippet ?? "",
    /限制访问/
  );
});

test("unexpected fetch failures persist the content-fetch fallback code", async () => {
  const fixture = serviceFixture({
    fetch: async () => {
      throw new Error("unexpected upstream failure");
    }
  });
  const created = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/unavailable",
      subjectChannel: "organization"
    },
    "fetch-key-unexpected-failure"
  );

  await assert.rejects(
    fixture.service.executeContentFetchOperation(scope, created.id)
  );
  const failed = await fixture.service.getContentFetchOperation(
    scope,
    created.id
  );

  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "CONTENT_FETCH_FAILED");
});

test("import operation accepts raw bytes and lists only the newest tenant records", async () => {
  const fixture = serviceFixture();
  const csv = new TextEncoder().encode(
    "标题,摘要\r\n公开商机,客户正在寻找 CRM"
  );
  const first = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "first.csv",
      mediaType: "text/csv",
      content: csv,
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    "import-list-key-1"
  );
  await fixture.service.createImportOperation(
    {
      ownerId: "owner-b",
      teamId: scope.teamId,
      actorId: "user-b"
    },
    {
      fileName: "foreign.csv",
      mediaType: "text/csv",
      content: csv,
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    "import-list-key-foreign"
  );
  const latest = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "latest.csv",
      mediaType: "text/csv",
      content: csv,
      subjectChannel: "individual",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    "import-list-key-2"
  );

  const listed = await fixture.service.listImportOperations(
    scope,
    { limit: 1 }
  );

  assert.deepEqual(listed.map((operation) => operation.id), [latest.id]);
  assert.notEqual(listed[0]?.id, first.id);
  assert.equal(listed[0]?.ownerId, scope.ownerId);
  assert.equal("artifactCiphertext" in (listed[0] ?? {}), false);
  assert.equal("columnMapping" in (listed[0] ?? {}), false);
});

test("CSV import preserves artifact and row provenance with partial row errors", async () => {
  const fixture = serviceFixture();
  const csv = [
    "\ufeff标题,摘要,平台,链接,时间,语言",
    "\"采购 CRM\",\"希望本月比较三家供应商\",百度,https://example.cn/a,2026-07-20T00:00:00.000Z,zh-CN",
    "\"缺少摘要\",,百度,https://example.cn/b,,zh-CN",
    "\"带逗号的标题\",\"预算约 10 万, 要求私有化\",官网,https://example.cn/c,,zh-CN"
  ].join("\r\n");
  const created = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "公开商机.csv",
      mediaType: "text/csv",
      contentBase64: Buffer.from(csv).toString("base64"),
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourcePlatform: "平台",
        sourceUrl: "链接",
        publishedAt: "时间",
        locale: "语言"
      }
    },
    "import-key-csv"
  );
  assert.equal(created.status, "queued");
  assert.match(created.artifactHash, /^sha256:[a-f0-9]{64}$/);

  const completed = await fixture.service.executeImportOperation(
    scope,
    created.id
  );
  assert.equal(completed.status, "partial_success");
  assert.equal(completed.rowCount, 3);
  assert.equal(completed.acceptedRowCount, 2);
  assert.equal(completed.errorRows.length, 1);
  assert.equal(completed.errorRows[0]?.rowNumber, 3);
  assert.equal(fixture.sink.appended.length, 2);
  assert.deepEqual(
    fixture.sink.appended[1]?.input.provenance,
    {
      kind: "import_artifact_row",
      importBatchId: created.id,
      artifactHash: created.artifactHash,
      sheetName: "CSV",
      rowNumber: 4,
      sourceUrl: "https://example.cn/c"
    }
  );
  assert.match(
    fixture.sink.appended[1]?.input.sourceSnippet ?? "",
    /预算约 10 万, 要求私有化/
  );

  const replay = await fixture.service.executeImportOperation(
    scope,
    created.id
  );
  assert.equal(replay.acceptedRowCount, 2);
  assert.equal(fixture.sink.appended.length, 2);
});

test("cancelled import preserves evidence formed before the abort", async () => {
  const abortController = new AbortController();
  const fixture = serviceFixture({
    onEvidenceAppend(count) {
      if (count === 1) abortController.abort();
    }
  });
  const csv = [
    "标题,摘要",
    "第一条公开信号,已形成证据后取消任务",
    "第二条公开信号,取消后不应继续导入"
  ].join("\r\n");
  const created = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "取消保留证据.csv",
      mediaType: "text/csv",
      content: Buffer.from(csv),
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    "import-cancel-preserves-evidence"
  );

  await assert.rejects(
    fixture.service.executeImportOperation(
      scope,
      created.id,
      abortController.signal
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "ABORTED"
  );

  const failed = await fixture.service.getImportOperation(scope, created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.acceptedRowCount, 1);
  assert.equal(failed.evidenceCount, 1);
  assert.deepEqual(failed.evidenceIds, ["evidence-1"]);
  assert.equal(fixture.sink.appended.length, 1);
});

test("imported source URLs must satisfy the same public HTTPS boundary as fetched URLs", async () => {
  const fixture = serviceFixture();
  const csv = [
    "标题,摘要,链接",
    "公开线索,可保留的公开来源,https://public.example.cn/opportunity",
    "HTTP 链接,不允许明文链接,http://public.example.cn/plain",
    "内网链接,不允许内网地址,https://127.0.0.1/private",
    "带凭据链接,不允许 URL 凭据,https://user:pass@public.example.cn/private",
    "带密钥链接,不允许敏感查询参数,https://public.example.cn/path?api_key=secret"
  ].join("\r\n");
  const created = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "公开链接边界.csv",
      mediaType: "text/csv",
      content: Buffer.from(csv),
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourceUrl: "链接"
      }
    },
    "import-public-url-boundary"
  );

  const completed = await fixture.service.executeImportOperation(
    scope,
    created.id
  );

  assert.equal(completed.status, "partial_success");
  assert.equal(completed.rowCount, 5);
  assert.equal(completed.acceptedRowCount, 1);
  assert.equal(completed.evidenceCount, 1);
  assert.equal(completed.errorRows.length, 4);
  assert.deepEqual(
    fixture.sink.appended.map((item) =>
      item.input.provenance.kind === "import_artifact_row"
        ? item.input.provenance.sourceUrl
        : null),
    ["https://public.example.cn/opportunity"]
  );
});

test("XLSX import reads bounded worksheets and keeps sheet provenance", async () => {
  const fixture = serviceFixture();
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["标题", "摘要", "平台", "语言"],
    ["寻找获客系统", "连锁门店计划近期采购", "客户授权表", "zh-CN"]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "线索");
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  }) as Buffer;

  const created = await fixture.service.createImportOperation(
    scope,
    {
      fileName: "公开商机.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentBase64: buffer.toString("base64"),
      subjectChannel: "individual",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourcePlatform: "平台",
        locale: "语言"
      }
    },
    "import-key-xlsx"
  );
  const completed = await fixture.service.executeImportOperation(
    scope,
    created.id
  );
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.rowCount, 1);
  assert.equal(completed.acceptedRowCount, 1);
  assert.deepEqual(
    fixture.sink.appended[0]?.input.provenance,
    {
      kind: "import_artifact_row",
      importBatchId: created.id,
      artifactHash: created.artifactHash,
      sheetName: "线索",
      rowNumber: 2
    }
  );
  assert.equal(
    fixture.sink.appended[0]?.input.targetType,
    "individual_signal"
  );
});

test("controlled content fetcher blocks unsafe URLs and parses bounded public HTML", async () => {
  const fetcher = new ControlledPublicContentFetcher({
    maxResponseBytes: 32 * 1024,
    timeoutMs: 1_000
  });
  await assert.rejects(
    fetcher.fetch("http://example.com/plain-http"),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "UNSAFE_SOURCE_URL"
  );
  await assert.rejects(
    fetcher.fetch("https://127.0.0.1/private"),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "UNSAFE_SOURCE_URL"
  );

  setProviderHttpTestTransport(async () => new Response(
    "<html><head><title>公开 商机</title><style>hidden</style></head>"
      + "<body><script>secret()</script><h1>采购需求</h1>"
      + "<p>需要对比 AI 获客系统。</p></body></html>",
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    }
  ));
  try {
    const result = await fetcher.fetch(
      "https://public.example.com/opportunity"
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.title, "公开 商机");
    assert.match(result.text, /采购需求/);
    assert.doesNotMatch(result.text, /secret/);
    assert.match(result.rawArtifactHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.contentHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    setProviderHttpTestTransport(null);
  }
});

test("content fetch operation rejects secret-bearing query parameter names before persistence", async () => {
  const fixture = serviceFixture();
  const unsafeUrls = [
    "https://example.com/public?api_key=secret",
    "https://example.com/public?Api-Key=secret",
    "https://example.com/public?access.token=secret",
    "https://example.com/public?client_secret=secret",
    "https://example.com/public?secret-key=secret",
    "https://example.com/public?password=secret",
    "https://example.com/public?password_hint=secret",
    "https://example.com/public?X-Amz-Signature=secret",
    "https://example.com/public?credential=secret",
    "https://example.com/public?credential-id=secret"
  ];

  for (const [index, sourceUrl] of unsafeUrls.entries()) {
    await assert.rejects(
      fixture.service.createContentFetchOperation(
        scope,
        {
          sourceUrl,
          subjectChannel: "organization"
        },
        `secret-query-${index}`
      ),
      (error: unknown) =>
        error instanceof AcquisitionDiscoveryOperationError
        && error.code === "UNSAFE_SOURCE_URL"
        && error.message === "UNSAFE_SOURCE_URL"
    );
  }

  assert.equal(fixture.repository.size("fetch"), 0);
  const safe = await fixture.service.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://example.com/public?page=2&industry=crm",
      subjectChannel: "organization"
    },
    "safe-query"
  );
  assert.equal(safe.status, "queued");
});

test("controlled content fetcher requests identity encoding and rejects compressed responses", async () => {
  const fetcher = new ControlledPublicContentFetcher({
    maxResponseBytes: 32 * 1024,
    timeoutMs: 1_000
  });
  let observedAcceptEncoding = "";
  setProviderHttpTestTransport(async (_url, init) => {
    observedAcceptEncoding =
      new Headers(init.headers).get("accept-encoding") ?? "";
    return new Response("<html><body>compressed</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip"
      }
    });
  });
  try {
    await assert.rejects(
      fetcher.fetch("https://public.example.com/compressed"),
      (error: unknown) =>
        error instanceof AcquisitionDiscoveryOperationError
        && error.code === "CONTENT_FETCH_FAILED"
        && error.message === "CONTENT_FETCH_FAILED"
    );
    assert.equal(observedAcceptEncoding, "identity");
  } finally {
    setProviderHttpTestTransport(null);
  }
});

test("XLSX import rejects excessive total uncompressed bytes from the central directory", async () => {
  const buffer = simpleXlsxBuffer();
  const entry = zipCentralEntries(buffer)[0]!;
  buffer.writeUInt32LE(26 * 1024 * 1024, entry.offset + 24);

  await assertRejectedXlsx(
    buffer,
    "xlsx-total-uncompressed-limit",
    "IMPORT_LIMIT_EXCEEDED"
  );
});

test("XLSX import rejects central-directory compression ratios above 100", async () => {
  const buffer = simpleXlsxBuffer();
  const entry = zipCentralEntries(buffer)
    .find((candidate) => {
      const compressed = buffer.readUInt32LE(candidate.offset + 20);
      return compressed > 0 && compressed < 10_000;
    });
  assert.ok(entry);
  const compressed = buffer.readUInt32LE(entry.offset + 20);
  buffer.writeUInt32LE(compressed * 101, entry.offset + 24);

  await assertRejectedXlsx(
    buffer,
    "xlsx-ratio-limit",
    "IMPORT_LIMIT_EXCEEDED"
  );
});

test("XLSX import rejects archives claiming more than 2000 entries", async () => {
  const buffer = simpleXlsxBuffer();
  const eocd = zipEocdOffset(buffer);
  buffer.writeUInt16LE(2_001, eocd + 8);
  buffer.writeUInt16LE(2_001, eocd + 10);

  await assertRejectedXlsx(
    buffer,
    "xlsx-entry-limit",
    "IMPORT_LIMIT_EXCEEDED"
  );
});

test("XLSX import rejects ZIP64 and encrypted central-directory entries", async () => {
  const zip64 = simpleXlsxBuffer();
  const zip64Entry = zipCentralEntries(zip64)[0]!;
  assert.equal(
    zip64.readUInt32LE(zip64Entry.localOffset),
    ZIP_LOCAL_FILE_SIGNATURE
  );
  zip64.writeUInt16LE(45, zip64Entry.offset + 6);
  zip64.writeUInt16LE(45, zip64Entry.localOffset + 4);
  await assertRejectedXlsx(
    zip64,
    "xlsx-zip64",
    "IMPORT_ARTIFACT_INVALID"
  );

  const encrypted = simpleXlsxBuffer();
  const encryptedEntry = zipCentralEntries(encrypted)[0]!;
  encrypted.writeUInt16LE(
    encrypted.readUInt16LE(encryptedEntry.offset + 8) | 0x0001,
    encryptedEntry.offset + 8
  );
  encrypted.writeUInt16LE(
    encrypted.readUInt16LE(encryptedEntry.localOffset + 6) | 0x0001,
    encryptedEntry.localOffset + 6
  );
  await assertRejectedXlsx(
    encrypted,
    "xlsx-encrypted",
    "IMPORT_ARTIFACT_INVALID"
  );
});

test("XLSX import rejects macro and external-link package entries", async () => {
  const macro = replaceCentralEntryName(
    simpleXlsxBuffer(),
    "docProps/core.xml",
    "xl/vbaProject.bin"
  );
  await assertRejectedXlsx(
    macro,
    "xlsx-macro",
    "IMPORT_ARTIFACT_INVALID"
  );

  const externalLink = replaceCentralEntryName(
    simpleXlsxBuffer(),
    "xl/theme/theme1.xml",
    "xl/externalLinks/a1"
  );
  await assertRejectedXlsx(
    externalLink,
    "xlsx-external-link",
    "IMPORT_ARTIFACT_INVALID"
  );
});

test("XLSX import rejects malformed central-directory boundaries", async () => {
  const buffer = simpleXlsxBuffer();
  const eocd = zipEocdOffset(buffer);
  buffer.writeUInt32LE(
    buffer.readUInt32LE(eocd + 12) + 1,
    eocd + 12
  );

  await assertRejectedXlsx(
    buffer,
    "xlsx-malformed-central-directory",
    "IMPORT_ARTIFACT_INVALID"
  );
});
