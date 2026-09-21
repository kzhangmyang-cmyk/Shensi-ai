import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AcquisitionContentFetchOperation,
  AcquisitionDiscoveryOperationService,
  AcquisitionImportOperation
} from "./acquisition-discovery-operations.js";
import {
  AcquisitionContentFetchShardProcessor,
  AcquisitionDiscoveryShardProcessorError,
  AcquisitionImportRowsShardProcessor
} from "./acquisition-discovery-shard-processors.js";
import {
  ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS
} from "./acquisition-discovery-providers.js";
import type {
  AcquisitionOperationShard,
  AcquisitionPlanRunRepository,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";

const scope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "acquisition-worker"
};

const modelSnapshotRef = {
  jobSnapshotId: "job-1",
  connectionId: "model-1",
  credentialVersion: 1,
  provider: "moonshot",
  model: "kimi-k2",
  capabilitySnapshotHash: "capability-1",
  promptVersion: "prompt-1",
  schemaVersion: "schema-1",
  promptHash: "prompt-hash-1",
  schemaHash: "schema-hash-1"
};

const run: AcquisitionRun = {
  id: "run-1",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  planId: "plan-1",
  planVersionId: "version-1",
  planVersion: 1,
  planSnapshotHash: "plan-hash-1",
  parentRunId: null,
  status: "running",
  terminationIntent: null,
  revision: 1,
  etag: "\"run-1:1\"",
  budgetSnapshotId: "budget-1",
  budgetSnapshot: {
    maxRequests: 20,
    maxResults: 100,
    maxAmountMinor: 10_000,
    maxDurationSeconds: 300,
    billingCurrency: "CNY"
  },
  budgetSnapshotHash: "budget-hash-1",
  billingCurrency: "CNY",
  modelSnapshotRef,
  consumedBudget: {
    requests: 0,
    results: 0,
    amountMinor: 0,
    durationSeconds: 0
  },
  evidenceCount: 0,
  reason: null,
  createdBy: scope.actorId,
  createdAt: "2026-07-24T08:00:00.000Z",
  updatedBy: scope.actorId,
  updatedAt: "2026-07-24T08:00:00.000Z",
  completedAt: null
};

function shard(
  overrides: Partial<AcquisitionOperationShard> = {}
): AcquisitionOperationShard {
  return {
    id: "shard-1",
    runId: run.id,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    operationId: "operation-1",
    parentShardId: null,
    subjectChannel: "organization",
    kind: "content_fetch",
    connection: {
      ...ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch
    },
    query: null,
    sourceRef: "https://example.com/opportunity",
    status: "running",
    budgetSnapshotId: "budget-1",
    allocatedBudget: {
      requests: 1,
      results: 10,
      amountMinor: 0,
      durationSeconds: 60
    },
    consumedBudget: {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    },
    modelSnapshotRef,
    evidenceCount: 0,
    revision: 2,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

function fetchOperation(
  overrides: Partial<AcquisitionContentFetchOperation> = {}
): AcquisitionContentFetchOperation {
  return {
    id: "fetch-1",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    actorId: scope.actorId,
    sourceUrl: "https://example.com/opportunity",
    finalUrl: "https://example.com/opportunity",
    subjectChannel: "organization",
    status: "succeeded",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html",
    title: "采购需求",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["evidence-1"],
    candidateCount: 0,
    candidateIds: [],
    commentSampleSummary: null,
    errorCode: null,
    createdAt: "2026-07-24T08:00:00.000Z",
    startedAt: "2026-07-24T08:00:00.000Z",
    completedAt: "2026-07-24T08:00:01.000Z",
    ...overrides
  };
}

function importOperation(
  overrides: Partial<AcquisitionImportOperation> = {}
): AcquisitionImportOperation {
  return {
    id: "import-1",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    actorId: scope.actorId,
    fileName: "leads.csv",
    mediaType: "text/csv",
    subjectChannel: "organization",
    artifactHash: `sha256:${"c".repeat(64)}`,
    status: "partial_success",
    rowCount: 4,
    acceptedRowCount: 3,
    evidenceCount: 3,
    evidenceIds: ["evidence-1", "evidence-2", "evidence-3"],
    candidateCount: 0,
    candidateIds: [],
    errorRows: [{
      sheetName: "CSV",
      rowNumber: 4,
      code: "IMPORT_ARTIFACT_INVALID",
      message: "摘要为空"
    }],
    errorCode: null,
    createdAt: "2026-07-24T08:00:00.000Z",
    startedAt: "2026-07-24T08:00:00.000Z",
    completedAt: "2026-07-24T08:00:02.000Z",
    ...overrides
  };
}

test("content fetch shard creates a deterministic operation and reports measured evidence", async () => {
  const calls: unknown[] = [];
  const service = {
    async createContentFetchOperation(
      actualScope: typeof scope,
      input: unknown,
      idempotencyKey: string
    ) {
      calls.push(["create", actualScope, input, idempotencyKey]);
      return fetchOperation({
        id: "fetch-created",
        status: "queued",
        accessStatus: null,
        evidenceCount: 0
      });
    },
    async executeContentFetchOperation(
      actualScope: typeof scope,
      id: string
    ) {
      calls.push(["execute", actualScope, id]);
      return fetchOperation({ id });
    }
  } as unknown as AcquisitionDiscoveryOperationService;
  let clock = 1_000;
  const processor = new AcquisitionContentFetchShardProcessor({
    operations: service,
    nowMs: () => {
      clock += 500;
      return clock;
    }
  });
  const result = await processor.process({
    scope,
    run,
    shard: shard(),
    dispatchKey: "dispatch-1",
    signal: new AbortController().signal
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidenceCount, 1);
  assert.deepEqual(result.usage, {
    requests: 1,
    results: 1,
    amountMinor: 0,
    durationSeconds: 1
  });
  assert.deepEqual(calls[0], [
    "create",
    scope,
    {
      sourceUrl: "https://example.com/opportunity",
      subjectChannel: "organization"
    },
    "plan-fetch:run-1:shard-1:plan-hash-1"
  ]);
  assert.deepEqual(calls[1], [
    "execute",
    scope,
    "fetch-created"
  ]);
});

test("content fetch shard can resume an existing operation and preserves access-restricted truth", async () => {
  const calls: unknown[] = [];
  const service = {
    async getContentFetchOperation(
      actualScope: typeof scope,
      id: string
    ) {
      calls.push(["get", actualScope, id]);
      return fetchOperation({
        id,
        status: "queued",
        accessStatus: null,
        evidenceCount: 0
      });
    },
    async executeContentFetchOperation(
      actualScope: typeof scope,
      id: string
    ) {
      calls.push(["execute", actualScope, id]);
      return fetchOperation({
        id,
        status: "access_restricted",
        accessStatus: "access_restricted"
      });
    }
  } as unknown as AcquisitionDiscoveryOperationService;
  const processor = new AcquisitionContentFetchShardProcessor({
    operations: service,
    nowMs: () => 1_000
  });
  const result = await processor.process({
    scope,
    run,
    shard: shard({ sourceRef: "fetch://fetch-existing" }),
    dispatchKey: "dispatch-2",
    signal: new AbortController().signal
  });
  assert.equal(result.status, "partial_success");
  assert.equal(result.evidenceCount, 1);
  assert.deepEqual(calls[0], [
    "get",
    scope,
    "fetch-existing"
  ]);
});

test("import shard executes only a tenant-owned import artifact and maps partial rows", async () => {
  const calls: unknown[] = [];
  const service = {
    async getImportOperation(
      actualScope: typeof scope,
      id: string
    ) {
      calls.push(["get", actualScope, id]);
      return importOperation({
        id,
        status: "queued",
        rowCount: 0,
        acceptedRowCount: 0,
        errorRows: []
      });
    },
    async executeImportOperation(
      actualScope: typeof scope,
      id: string,
      signal: AbortSignal,
      options: { maxRows: number }
    ) {
      calls.push(["execute", actualScope, id, signal.aborted, options]);
      return importOperation({ id });
    }
  } as unknown as AcquisitionDiscoveryOperationService;
  let clock = 1_000;
  const processor = new AcquisitionImportRowsShardProcessor({
    operations: service,
    nowMs: () => {
      clock += 1_000;
      return clock;
    }
  });
  const importShard = shard({
    kind: "import_rows",
    sourceRef: "import://import-existing",
    connection: {
      ...ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.import
    },
    allocatedBudget: {
      requests: 1,
      results: 5,
      amountMinor: 0,
      durationSeconds: 60
    }
  });
  const signal = new AbortController().signal;
  const result = await processor.process({
    scope,
    run,
    shard: importShard,
    dispatchKey: "dispatch-3",
    signal
  });
  assert.equal(result.status, "partial_success");
  assert.equal(result.evidenceCount, 3);
  assert.deepEqual(result.usage, {
    requests: 1,
    results: 3,
    amountMinor: 0,
    durationSeconds: 1
  });
  assert.deepEqual(calls[1], [
    "execute",
    scope,
    "import-existing",
    false,
    { maxRows: 5 }
  ]);
});

test("discovery processors reject mismatched connection kinds and unsafe import references", async () => {
  const service = {} as AcquisitionDiscoveryOperationService;
  const fetchProcessor = new AcquisitionContentFetchShardProcessor({
    operations: service
  });
  await assert.rejects(
    fetchProcessor.process({
      scope,
      run,
      shard: shard({
        connection: {
          connectionId: "wrong",
          providerId: "wrong",
          kind: "search",
          status: "active",
          credentialVersion: 1
        }
      }),
      dispatchKey: "dispatch-4",
      signal: new AbortController().signal
    }),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryShardProcessorError
      && error.code === "INVALID_CONTENT_FETCH_SHARD"
  );

  const importProcessor = new AcquisitionImportRowsShardProcessor({
    operations: service
  });
  await assert.rejects(
    importProcessor.process({
      scope,
      run,
      shard: shard({
        kind: "import_rows",
        sourceRef: "file:///tmp/private.csv",
        connection: {
          ...ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.import
        }
      }),
      dispatchKey: "dispatch-5",
      signal: new AbortController().signal
    }),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryShardProcessorError
      && error.code === "INVALID_IMPORT_SHARD"
  );
});

test("content fetch enriches before processing deduped candidates with persisted usage", async () => {
  const order: string[] = [];
  const policy = {
    enabled: true,
    maxVideosPerRun: 1,
    maxCommentsPerVideo: 5,
    maxPagesPerVideo: 2
  };
  const service = {
    async createContentFetchOperation() {
      return fetchOperation({
        id: "fetch-comment-run",
        status: "queued",
        accessStatus: null,
        evidenceCount: 0,
        evidenceIds: []
      });
    },
    async executeContentFetchOperation(
      _scope: typeof scope,
      id: string,
      signal: AbortSignal,
      context: unknown
    ) {
      order.push("comments");
      assert.equal(signal.aborted, false);
      assert.deepEqual(context, {
        runId: "run-1",
        shardId: "shard-1",
        policy,
        remainingBudget: { requests: 4, results: 10 }
      });
      return fetchOperation({
        id,
        status: "partial_success",
        candidateCount: 2,
        candidateIds: ["candidate-original", "candidate-comment"],
        errorCode: "rate_limited",
        commentSampleSummary: {
          status: "partial_success",
          videoCount: 1,
          pagesFetched: 2,
          commentsSampled: 2,
          eventCount: 2,
          evidenceCount: 2,
          candidateIds: ["candidate-comment"],
          unresolvedActorCount: 1,
          strongSignalCount: 1,
          invalidCommentCount: 0,
          errors: [{
            sourceUrl:
              "https://www.douyin.com/video/7536012345678900001",
            videoId: "7536012345678900001",
            code: "rate_limited"
          }],
          usage: {
            requests: 2,
            results: 2,
            amountMinor: 0,
            durationSeconds: 1
          }
        }
      });
    }
  } as unknown as AcquisitionDiscoveryOperationService;
  const planRunRepository = {
    async getPlanVersion(id: string) {
      assert.equal(id, run.planVersionId);
      return {
        id,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        payload: { douyinPublicCommentSample: policy }
      };
    }
  } as unknown as Pick<AcquisitionPlanRunRepository, "getPlanVersion">;
  let clock = 0;
  const processor = new AcquisitionContentFetchShardProcessor({
    operations: service,
    planRunRepository,
    candidatePipeline: {
      async process(input) {
        order.push("pipeline");
        assert.deepEqual(input.candidateIds, [
          "candidate-original",
          "candidate-comment"
        ]);
        return {
          processedCandidateIds: [...input.candidateIds],
          battleCardCandidateIds: [],
          failures: []
        };
      }
    },
    nowMs: () => {
      clock += 1_000;
      return clock;
    }
  });

  const result = await processor.process({
    scope,
    run,
    shard: shard({
      sourceRef:
        "https://www.douyin.com/video/7536012345678900001",
      allocatedBudget: {
        requests: 4,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }),
    dispatchKey: "dispatch-comments",
    signal: new AbortController().signal
  });

  assert.deepEqual(order, ["comments", "pipeline"]);
  assert.equal(result.status, "partial_success");
  assert.equal(result.evidenceCount, 3);
  assert.deepEqual(result.usage, {
    requests: 3,
    results: 3,
    amountMinor: 0,
    durationSeconds: 1
  });
  assert.deepEqual(result.presentation?.candidateIds, [
    "candidate-original",
    "candidate-comment"
  ]);
  assert.deepEqual(result.presentation?.processedCandidateIds, [
    "candidate-original",
    "candidate-comment"
  ]);
  assert.equal(result.presentation?.acceptedResultCount, 3);
  assert.equal(result.presentation?.failedResultCount, 1);
});
