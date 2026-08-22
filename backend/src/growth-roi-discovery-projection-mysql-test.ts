import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  ensureAuthoritativeDiscoveryMysqlSchema,
  MysqlAuthoritativeDiscoveryProjectionRepository
} from "./acquisition-authoritative-discovery-mysql-repository.js";
import { DefaultGrowthTemporalBarrier } from "./growth-temporal-barrier.js";

test("MySQL discovery projection appends atomically and pages by source record time", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await ensureAuthoritativeDiscoveryMysqlSchema(fixture.pool);
    const writer = new MysqlAuthoritativeDiscoveryProjectionRepository(
      fixture.pool, fixture.foundation.temporalBarrier
    );
    const workspace = Object.freeze({
      workspaceId: "workspace-a",
      kind: "team",
      bindingRevision: "mysql.v1",
      ownerId: "sales-a",
      teamId: "workspace-a"
    });
    const event = Object.freeze({
      eventId: "event-1",
      platform: "douyin",
      candidateId: "candidate-1",
      ownerId: "sales-a",
      discoveredAt: "2026-08-01T00:00:00.000Z",
      material: Object.freeze({
        kind: "individual",
        platform: "douyin",
        publicActorKey:
          "public:douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        canonicalProfileUrl: null
      }),
      attribution: Object.freeze({
        attributionVersion: "acquisition-run.v1",
        runId: "run-1",
        planId: "plan-1",
        planVersionId: "plan-version-1",
        planVersion: 1,
        planSnapshotHash: `sha256:${"a".repeat(64)}`,
        discoveredEventId: "event-1",
        discoveredAt: "2026-08-01T00:00:00.000Z",
        shardId: "shard-1",
        operationId: "operation-1",
        connectionId: "connection-1",
        providerId: "provider-1",
        evidenceIds: ["evidence-1"],
        providerIds: ["provider-1"],
        queryIds: ["query-1"],
        strategyVersion: "strategy-1",
        qualificationDecisionId: "decision-1",
        decisionVersion: "decision-v1",
        decisionSnapshotHash: `sha256:${"b".repeat(64)}`
      }),
      origin: "acquisition_run",
      payloadHash: `sha256:${"c".repeat(64)}`
    });
    const appended = await writer.appendBatchFirst(workspace, [event]);
    assert.equal(appended.length, 1);
    const cutoff = await new DefaultGrowthTemporalBarrier(
      fixture.foundation.temporalTransactions
    ).sealReadCutoff(
      fixture.workspaceContext("workspace-a"),
      "2026-08-09T00:00:00.000Z"
    );
    const page = await writer.listDiscoveries("workspace-a", {
      platform: "douyin",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-08T00:00:00.000Z",
      cutoff,
      after: null,
      limit: 10
    });
    assert.equal(page.items.length, 1);
    const watermark = await writer.getWatermark("workspace-a", {
      platform: "douyin",
      cutoff
    });
    assert.equal(watermark.eventCount, 1);
  });
});
