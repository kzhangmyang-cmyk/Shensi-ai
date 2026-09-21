import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { growthInstantMilliseconds } from "./growth-as-of.js";
import { withGrowthFoundationMysqlTestDatabase } from "./growth-foundation-mysql-test-support.js";
import { MysqlGrowthTemporalTransaction, growthMysqlInstant } from "./growth-temporal-barrier-mysql-repository.js";
import {
  ensureGrowthHttpIdempotencyMysqlSchema,
  MysqlGrowthHttpIdempotencyRepository,
  type GrowthHttpIdempotencyMysqlSource
} from "./growth-http-idempotency-mysql-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

function workspace(workspaceId: string): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "mysql-user",
    role: "admin",
    teamId: workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function pinnedIdempotencySource(
  connection: Pick<mysql.PoolConnection,
    "beginTransaction" | "commit" | "rollback" | "query">,
  pool: Pick<mysql.Pool, "query">
): GrowthHttpIdempotencyMysqlSource {
  return {
    getConnection: async () => ({
      beginTransaction: () => connection.beginTransaction(),
      commit: () => connection.commit(),
      rollback: () => connection.rollback(),
      query: connection.query.bind(connection),
      release: () => undefined
    }) as never,
    query: pool.query.bind(pool) as never
  };
}

test("real MySQL foundation globally fences writes and preserves settings history", async () => {
  await withGrowthFoundationMysqlTestDatabase(async ({
    pool,
    connectionA,
    connectionB,
    barrier,
    settings
  }) => {
    await pool.query(
      `CREATE TABLE growth_foundation_test_events (
        workspace_id VARCHAR(191) NOT NULL,
        stream_id VARCHAR(191) NOT NULL,
        recorded_at DATETIME(3) NOT NULL,
        PRIMARY KEY (workspace_id, stream_id)
      ) ENGINE=InnoDB`
    );
    await connectionA.beginTransaction();
    const priorStamp = await barrier.allocateAppend(
      new MysqlGrowthTemporalTransaction(connectionA),
      "workspace-a"
    );
    await connectionA.query(
      `INSERT INTO growth_foundation_test_events (
        workspace_id, stream_id, recorded_at
      ) VALUES (?, ?, ?)`,
      [
        "workspace-a",
        "prior-stream",
        priorStamp.recordedAt.slice(0, 23).replace("T", " ")
      ]
    );
    const effectiveAsOf = new Date(
      growthInstantMilliseconds(priorStamp.recordedAt) + 100
    ).toISOString();
    const sealing = barrier.sealReadCutoff(
      workspace("workspace-a"),
      effectiveAsOf
    );
    let settled = false;
    void sealing.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "seal must wait for the earlier row-lock owner");
    await connectionA.commit();
    const token = await sealing;
    const readAtCutoff = async () => {
      const [rows] = await connectionB.query(
        `SELECT stream_id
         FROM growth_foundation_test_events
         WHERE workspace_id = ? AND recorded_at <= ?
         ORDER BY stream_id`,
        [
          "workspace-a",
          token.effectiveAsOf.slice(0, 23).replace("T", " ")
        ]
      );
      return (rows as Array<Record<string, unknown>>)
        .map((row) => String(row.stream_id));
    };
    const beforeLaterAppend = await readAtCutoff();
    assert.deepEqual(beforeLaterAppend, ["prior-stream"]);

    await connectionA.beginTransaction();
    const laterStamp = await barrier.allocateAppend(
      new MysqlGrowthTemporalTransaction(connectionA),
      "workspace-a"
    );
    assert.ok(laterStamp.recordedAt > token.effectiveAsOf);
    await connectionA.query(
      `INSERT INTO growth_foundation_test_events (
        workspace_id, stream_id, recorded_at
      ) VALUES (?, ?, ?)`,
      [
        "workspace-a",
        "later-new-stream",
        laterStamp.recordedAt.slice(0, 23).replace("T", " ")
      ]
    );
    await connectionA.commit();
    assert.deepEqual(await readAtCutoff(), beforeLaterAppend);

    await settings.appendTrustedSettingsEvent("workspace-a", {
      timeZone: "Asia/Shanghai",
      revision: "settings-1"
    });
    const first = await settings.get(workspace("workspace-a"));
    const historical = await barrier.sealReadCutoff(
      workspace("workspace-a"),
      first.recordedAt
    );
    await settings.appendTrustedSettingsEvent("workspace-a", {
      timeZone: "Asia/Hong_Kong",
      revision: "settings-2"
    });
    assert.equal(
      (await settings.getAt(workspace("workspace-a"), historical)).revision,
      "settings-1"
    );

    const [rows] = await connectionB.query(
      `SELECT last_recorded_at, temporal_sequence
       FROM growth_workspace_temporal_barriers
       WHERE workspace_id = ?`,
      ["workspace-a"]
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    assert.ok(row);
    assert.ok(growthMysqlInstant(row.last_recorded_at) > token.effectiveAsOf);
    assert.ok(Number(row.temporal_sequence) > token.temporalSequence);

    await ensureGrowthHttpIdempotencyMysqlSchema(pool);
    const input = {
      workspaceId: "workspace-a", actorId: "mysql-user", method: "POST",
      canonicalPath: "/api/v1/quotes/cases", key: "mysql-foundation-key-0001",
      requestHash: `sha256:${"a".repeat(64)}`,
      attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "connection-a", leaseDurationMs: 1_000
    };
    const [firstReservation, concurrentReservation] = await Promise.all([
      new MysqlGrowthHttpIdempotencyRepository(
        pinnedIdempotencySource(connectionA, pool), () => "connection-a-claim"
      ).reserve(input),
      new MysqlGrowthHttpIdempotencyRepository(
        pinnedIdempotencySource(connectionB, pool), () => "connection-b-claim"
      ).reserve({ ...input, leaseOwner: "connection-b" })
    ]);
    const winner = [firstReservation, concurrentReservation]
      .find((reservation) => reservation.kind === "claimed");
    const inProgress = [firstReservation, concurrentReservation]
      .find((reservation) => reservation.kind === "in_progress");
    assert.equal(winner?.kind, "claimed");
    assert.equal(inProgress?.kind, "in_progress");
    if (!winner || winner.kind !== "claimed") throw new Error("expected_idempotency_claim");
    const idempotency = new MysqlGrowthHttpIdempotencyRepository(pool);
    const reclaimed = await idempotency.reserve({ ...input, leaseOwner: "connection-b", attemptedAt: "2026-08-09T08:00:01.001Z" });
    assert.equal(reclaimed.kind, "claimed");
    if (reclaimed.kind !== "claimed") throw new Error("expected_idempotency_reclaim");
    assert.ok(reclaimed.fencingToken > winner.fencingToken);
    await assert.rejects(() => idempotency.complete(winner.reservationId, winner.leaseOwner, winner.fencingToken, { resourceId: "stale", operationId: null }), /stale_idempotency_fence/u);
    await idempotency.complete(reclaimed.reservationId, reclaimed.leaseOwner, reclaimed.fencingToken, { resourceId: "resource-1", operationId: null });
    assert.deepEqual(await idempotency.reserve({ ...input, leaseOwner: "connection-a", attemptedAt: "2026-08-09T08:00:02.000Z" }), { kind: "replay", resourceId: "resource-1", operationId: null });
  });
  console.log("GROWTH_REAL_MYSQL foundation connections=2 tests=4");
});
