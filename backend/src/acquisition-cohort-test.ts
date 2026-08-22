import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionCohortRepository } from "./acquisition-cohort-repository.js";
import {
  cohortCommandContext,
  cohortServiceFixture,
  discoverySource,
  fixtureWatermark,
  lateRecordedDiscoveryFixture,
  sealedCutoff
} from "./growth-roi-test-fixtures.js";

const ACTOR_KEY =
  "public:douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("first authoritative discovery owns membership and later discoveries become sources", async () => {
  const discoveries = discoverySource([
    {
      eventId: "event-1",
      candidateId: "candidate-1",
      ownerId: "sales-a",
      discoveredAt: "2026-08-01T01:00:00.000Z",
      recordedAt: "2026-08-01T01:00:01.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-a"
    },
    {
      eventId: "event-2",
      candidateId: "candidate-2",
      ownerId: "sales-b",
      discoveredAt: "2026-08-02T01:00:00.000Z",
      recordedAt: "2026-08-02T01:00:01.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-b"
    }
  ]);
  const fixture = cohortServiceFixture({
    repository: new InMemoryAcquisitionCohortRepository(),
    discoveries: discoveries as never
  });
  const service = fixture.service;
  const context = cohortCommandContext("workspace-a", "admin-a");
  const created = await service.create(context, {
    platform: "douyin",
    cohortFrom: "2026-08-01T00:00:00.000Z",
    cohortTo: "2026-08-08T00:00:00.000Z",
    definitionVersion: "weekly.v1",
    firstTouchRuleVersion: "first-authoritative-discovery.v1"
  });
  const cutoff = await sealedCutoff(
    context.workspace, "2026-08-09T00:00:00.000Z"
  );
  const result = await fixture.closureCatchUp.ensureForClosure(
    context,
    {
      closureOperationId: "close-operation-1",
      cohortId: created.id,
      cutoff
    }
  );
  const members = await service.listMembersAt(
    context.workspace, created.id, cutoff
  );
  assert.deepEqual(result, {
    inserted: 1,
    reassigned: 0,
    aliased: 1,
    unassignable: 0,
    complete: true,
    sourceWatermark: fixtureWatermark("event-2", 2)
  });
  assert.equal(members[0]?.firstPlanId, "plan-a");
  assert.equal(members[0]?.sources.length, 2);
  assert.equal(
    discoveries.listCalls.every((call) => call.cutoff === cutoff),
    true
  );
  assert.equal(discoveries.watermarkCalls[0]?.cutoff, cutoff);
  await assert.rejects(
    fixture.closureCatchUp.ensureForClosure(context, {
      closureOperationId: "close-operation-1",
      cohortId: created.id,
      cutoff: await sealedCutoff(
        cohortCommandContext("workspace-b", "admin-b").workspace,
        "2026-08-09T00:00:00.000Z"
      )
    }),
    /sealed_cutoff_workspace_mismatch/
  );
});

test("late-recorded backfill before the discovery-time cursor is still captured", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    initial: [{
      eventId: "event-2",
      candidateId: "candidate-event-2",
      ownerId: "sales-a",
      discoveredAt: "2026-08-02T00:00:00.000Z",
      recordedAt: "2026-08-02T01:00:00.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-a"
    }],
    late: [{
      eventId: "event-1",
      candidateId: "candidate-event-1",
      ownerId: "sales-a",
      discoveredAt: "2026-08-01T00:00:00.000Z",
      recordedAt: "2026-08-03T01:00:00.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-a"
    }]
  });
  await fixture.createCohorts();
  await fixture.catchUp("2026-08-02T23:59:59.999Z");
  await fixture.appendLateRows();
  await fixture.catchUp("2026-08-03T23:59:59.999Z");
  assert.deepEqual(
    (await fixture.listSources()).map((source) => source.candidateId).sort(),
    ["candidate-event-1", "candidate-event-2"]
  );
});

test("a late earlier discovery appends ownership into the adjacent earlier cohort", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    cohorts: [
      {
        id: "cohort-early",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z"
      },
      {
        id: "cohort-late",
        from: "2026-08-08T00:00:00.000Z",
        to: "2026-08-15T00:00:00.000Z"
      }
    ],
    initial: [{
      eventId: "event-late-window",
      candidateId: "candidate-late",
      ownerId: "sales-a",
      discoveredAt: "2026-08-09T00:00:00.000Z",
      recordedAt: "2026-08-09T01:00:00.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-a"
    }],
    late: [{
      eventId: "event-early-window",
      candidateId: "candidate-early",
      ownerId: "sales-a",
      discoveredAt: "2026-08-07T00:00:00.000Z",
      recordedAt: "2026-08-10T01:00:00.000Z",
      actorKey: ACTOR_KEY,
      planId: "plan-a"
    }]
  });
  await fixture.createCohorts();
  const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
  await fixture.catchUpCohort("cohort-late", oldCutoff);
  const oldLate = await fixture.listMembersAt("cohort-late", oldCutoff);
  await fixture.appendLateRows();
  const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");
  const reassignment = await fixture.catchUpCohort("cohort-early", newCutoff);

  assert.equal(reassignment.reassigned, 1);
  assert.deepEqual(
    (await fixture.listMembersAt("cohort-late", oldCutoff))
      .map((row) => row.id),
    oldLate.map((row) => row.id)
  );
  assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
  assert.deepEqual(
    (await fixture.listMembersAt("cohort-early", newCutoff))
      .map((row) => row.firstEventId),
    ["event-early-window"]
  );
  assert.deepEqual(
    (await fixture.listOwnershipVersions())
      .map((row) => [row.cohortId, row.appendRevision, row.becameHead]),
    [
      ["cohort-late", 1, true],
      ["cohort-early", 2, true]
    ]
  );
});

test("reverse cohort catch-up preserves the old cutoff and ignores cache projection time", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    cohorts: [
      {
        id: "cohort-early",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z"
      },
      {
        id: "cohort-late",
        from: "2026-08-08T00:00:00.000Z",
        to: "2026-08-15T00:00:00.000Z"
      }
    ],
    initial: [
      {
        eventId: "event-late-window",
        candidateId: "candidate-late",
        ownerId: "sales-a",
        discoveredAt: "2026-08-09T00:00:00.000Z",
        recordedAt: "2026-08-09T01:00:00.000Z",
        actorKey: ACTOR_KEY,
        planId: "plan-a"
      },
      {
        eventId: "event-early-window",
        candidateId: "candidate-early",
        ownerId: "sales-a",
        discoveredAt: "2026-08-07T00:00:00.000Z",
        recordedAt: "2026-08-10T01:00:00.000Z",
        actorKey: ACTOR_KEY,
        planId: "plan-a"
      }
    ],
    projectOnlyAfterSeal: true
  });
  await fixture.createCohorts();
  const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
  await fixture.catchUpCohort(
    "cohort-early", await fixture.seal("2026-08-10T23:59:59.999Z")
  );
  await fixture.catchUpCohort(
    "cohort-late", await fixture.seal("2026-08-10T23:59:59.999Z")
  );
  const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");

  assert.deepEqual(
    (await fixture.listMembersAt("cohort-late", oldCutoff))
      .map((row) => row.firstEventId),
    ["event-late-window"]
  );
  assert.equal((await fixture.listMembersAt("cohort-early", oldCutoff)).length, 0);
  assert.deepEqual(
    (await fixture.listMembersAt("cohort-early", newCutoff))
      .map((row) => row.firstEventId),
    ["event-early-window"]
  );
  assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
  assert.equal(
    (await fixture.listOwnershipVersions()).every(
      (row) => row.projectionRecordedAt > oldCutoff.effectiveAsOf
    ),
    true
  );
  assert.deepEqual(
    (await fixture.listOwnershipVersions())
      .map((row) => row.eventId).sort(),
    ["event-early-window", "event-late-window"]
  );
});
