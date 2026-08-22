import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionDiscoveryOperationService,
  InMemoryAcquisitionDiscoveryOperationRepository
} from "./acquisition-discovery-operations.js";
import type {
  AcquisitionDouyinCommentEnrichmentPort
} from "./acquisition-douyin-comment-enrichment.js";
import {
  AcquisitionDiscoveryRecoverySweeper
} from "./acquisition-discovery-recovery-sweeper.js";

const MASTER_SECRET =
  "discovery-recovery-test-master-secret-at-least-32-bytes";
const SCOPE = {
  ownerId: "owner-recovery",
  teamId: "team-recovery",
  actorId: "actor-recovery"
};

function fixture(options: {
  commentEnrichment?: AcquisitionDouyinCommentEnrichmentPort;
  publicFetch?: boolean;
} = {}) {
  let now = Date.parse("2026-07-24T08:00:00.000Z");
  const repository =
    new InMemoryAcquisitionDiscoveryOperationRepository();
  const service = new AcquisitionDiscoveryOperationService({
    repository,
    evidence: {
      async appendEvidence(scope, input) {
        return {
          ...input,
          id: "evidence-recovery",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          supersedesEvidenceId: input.supersedesEvidenceId ?? null,
          fetchedAt: new Date(now).toISOString()
        };
      }
    },
    fetcher: {
      async fetch(sourceUrl) {
        return {
          finalUrl: sourceUrl,
          status: options.publicFetch ? "succeeded" : "access_restricted",
          accessStatus: options.publicFetch
            ? "public_content"
            : "access_restricted",
          httpStatus: options.publicFetch ? 200 : 403,
          contentType: "text/html",
          title: "",
          text: "",
          rawArtifactHash: `sha256:${"a".repeat(64)}`,
          contentHash: `sha256:${"b".repeat(64)}`
        };
      }
    },
    commentEnrichment: options.commentEnrichment,
    masterSecret: MASTER_SECRET,
    workerId: "recovery-worker",
    idFactory: (prefix) => `${prefix}-${repository.size(prefix) + 1}`,
    leaseTokenFactory: () => "recovery-lease",
    now: () => new Date(now).toISOString()
  });
  return {
    repository,
    service,
    now: () => now,
    advance(ms: number) {
      now += ms;
    }
  };
}

test("startup recovery executes queued work and preserves access-restricted truth", async () => {
  const state = fixture();
  const queued = await state.service.createContentFetchOperation(
    SCOPE,
    {
      sourceUrl: "https://example.com/recovery-restricted",
      subjectChannel: "organization"
    },
    "recovery-startup-key"
  );
  const queuedImport = await state.service.createImportOperation(
    SCOPE,
    {
      fileName: "startup-recovery.csv",
      mediaType: "text/csv",
      content: new TextEncoder().encode(
        "标题,摘要\r\n恢复导入,应用启动后恢复此前排队的客户授权导入"
      ),
      subjectChannel: "organization",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要"
      }
    },
    "recovery-startup-import-key"
  );
  const dispatched: string[] = [];
  const sweeper = new AcquisitionDiscoveryRecoverySweeper({
    service: state.service,
    dispatchContentFetchOperation: async (scope, operationId) => {
      dispatched.push(`fetch:${operationId}`);
      await state.service.executeContentFetchOperation(scope, operationId);
    },
    async dispatchImportOperation(scope, operationId) {
      dispatched.push(`import:${operationId}`);
      await state.service.executeImportOperation(scope, operationId);
    },
    intervalMs: 60_000,
    staleRunningMs: 10 * 60_000,
    nowMs: state.now
  });

  await sweeper.start();
  const completed = await state.service.getContentFetchOperation(
    SCOPE,
    queued.id
  );
  const completedImport = await state.service.getImportOperation(
    SCOPE,
    queuedImport.id
  );

  assert.deepEqual(dispatched.sort(), [
    `fetch:${queued.id}`,
    `import:${queuedImport.id}`
  ].sort());
  assert.equal(completed.status, "access_restricted");
  assert.equal(completed.accessStatus, "access_restricted");
  assert.equal(completedImport.status, "succeeded");
  assert.equal(completedImport.acceptedRowCount, 1);
  await sweeper.close();
});

test("periodic recovery ignores terminal operations and dispatches newly queued work once", async () => {
  const state = fixture();
  const callbacks: Array<() => void> = [];
  const dispatched: string[] = [];
  const sweeper = new AcquisitionDiscoveryRecoverySweeper({
    service: state.service,
    dispatchContentFetchOperation: async (scope, operationId) => {
      dispatched.push(operationId);
      await state.service.executeContentFetchOperation(scope, operationId);
    },
    async dispatchImportOperation() {
      throw new Error("unexpected import");
    },
    intervalMs: 60_000,
    nowMs: state.now,
    setTimer(callback) {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimer() {}
  });
  await sweeper.start();
  const queued = await state.service.createContentFetchOperation(
    SCOPE,
    {
      sourceUrl: "https://example.com/recovery-periodic",
      subjectChannel: "organization"
    },
    "recovery-periodic-key"
  );

  callbacks.shift()!();
  await sweeper.whenIdle();
  assert.deepEqual(dispatched, [queued.id]);

  state.advance(60_000);
  callbacks.shift()!();
  await sweeper.whenIdle();
  assert.deepEqual(
    dispatched,
    [queued.id],
    "terminal operations must not be dispatched again"
  );
  await sweeper.close();
});

test("a backed-off poison comment execution cannot starve later tenant work", async () => {
  const attempts: string[] = [];
  const state = fixture({
    publicFetch: true,
    commentEnrichment: {
      async enrich(input) {
        const sourceUrl = input.sourceUrls[0]!;
        attempts.push(sourceUrl);
        if (sourceUrl.endsWith("0101")) {
          throw new Error("private comment secUid must never be persisted");
        }
        return {
          status: "succeeded",
          videoCount: 1,
          pagesFetched: 1,
          commentsSampled: 1,
          eventCount: 1,
          evidenceCount: 1,
          candidateIds: ["candidate-healthy"],
          unresolvedActorCount: 0,
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
  const poison = await state.service.createContentFetchOperation(
    SCOPE,
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900101",
      subjectChannel: "individual"
    },
    "sweeper-poison",
    { queueStandaloneCommentEnrichment: true }
  );
  const healthy = await state.service.createContentFetchOperation(
    {
      ownerId: "owner-healthy",
      teamId: "team-healthy",
      actorId: "actor-healthy"
    },
    {
      sourceUrl: "https://www.douyin.com/video/7536012345678900102",
      subjectChannel: "individual"
    },
    "sweeper-healthy",
    { queueStandaloneCommentEnrichment: true }
  );
  const callbacks: Array<() => void> = [];
  const sweeper = new AcquisitionDiscoveryRecoverySweeper({
    service: state.service,
    dispatchContentFetchOperation: (scope, operationId, executionId) =>
      state.service.recoverContentFetchOperation(
        scope,
        operationId,
        executionId
      ),
    async dispatchImportOperation() {
      throw new Error("unexpected import");
    },
    batchSize: 1,
    intervalMs: 60_000,
    nowMs: state.now,
    setTimer(callback) {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimer() {}
  });

  await sweeper.start();
  const poisonPublic = await state.service.getContentFetchOperation(
    SCOPE,
    poison.id
  );
  assert.equal(poisonPublic.status, "succeeded");
  assert.equal(poisonPublic.commentSampleSummary, null);
  assert.equal("commentEnrichmentExecutions" in poisonPublic, false);

  callbacks.shift()!();
  await sweeper.whenIdle();
  const healthyPublic = await state.service.getContentFetchOperation(
    {
      ownerId: "owner-healthy",
      teamId: "team-healthy",
      actorId: "actor-healthy"
    },
    healthy.id
  );
  assert.deepEqual(healthyPublic.candidateIds, ["candidate-healthy"]);
  assert.deepEqual(attempts, [
    "https://www.douyin.com/video/7536012345678900101",
    "https://www.douyin.com/video/7536012345678900102"
  ]);
  await sweeper.close();
});
