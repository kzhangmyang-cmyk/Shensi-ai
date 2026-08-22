import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAuthoritativeDiscoverySource
} from "./acquisition-authoritative-discovery-projection.js";
import {
  AUTHORITATIVE_DISCOVERY_MYSQL_SCHEMA_STATEMENTS
} from "./acquisition-authoritative-discovery-mysql-repository.js";

test("projection writer appends immutable rows and replays exact duplicates", async () => {
  const writer = new InMemoryAuthoritativeDiscoverySource();
  const workspace = Object.freeze({
    workspaceId: "workspace-a",
    kind: "team",
    bindingRevision: "fixture.v1",
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
  const rows = await writer.appendBatchFirst(workspace, [event]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.workspaceId, "workspace-a");
  assert.equal(rows[0]?.eventId, "event-1");
  const watermark = await writer.getWatermark("workspace-a", {
    platform: "douyin",
    cutoff: Object.freeze({
      workspaceId: "workspace-a",
      effectiveAsOf: "2026-08-09T00:00:00.000Z",
      temporalSequence: 1
    })
  });
  assert.equal(watermark.eventCount, 1);
  await assert.rejects(
    writer.getWatermark("workspace-b", {
      platform: "douyin",
      cutoff: Object.freeze({
        workspaceId: "workspace-a",
        effectiveAsOf: "2026-08-09T00:00:00.000Z",
        temporalSequence: 1
      })
    }),
    /sealed_cutoff_workspace_mismatch/
  );
});

test("discovery MySQL schema is idempotent DDL with uniqueness guards", () => {
  const ddl = AUTHORITATIVE_DISCOVERY_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS acquisition_authoritative_discoveries/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id, platform, event_id\)/u);
  assert.match(ddl, /idx_authoritative_discovery_page/u);
  assert.match(
    ddl,
    /CREATE TABLE IF NOT EXISTS acquisition_authoritative_discovery_source_guards/u
  );
});
