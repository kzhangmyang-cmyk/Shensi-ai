import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  InMemoryGrowthWorkspaceSettingsReader,
  InMemoryGrowthWorkspaceSettingsRepository
} from "./growth-workspace-settings.js";

function workspace(workspaceId: string): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "user-1",
    role: "admin",
    teamId: workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

async function sealedCutoff(context: ActiveWorkspaceContext, effectiveAsOf: string) {
  const runner = new InMemoryGrowthTemporalTransactionRunner(effectiveAsOf);
  return new DefaultGrowthTemporalBarrier(runner)
    .sealReadCutoff(context, effectiveAsOf);
}

test("workspace timezone comes only from trusted append-only server settings", async () => {
  const reader = new InMemoryGrowthWorkspaceSettingsReader({
    "team-a": [
      {
        timeZone: "Asia/Shanghai",
        revision: "settings-1",
        recordedAt: "2026-08-09T08:00:00.000Z",
        eventSequence: 1
      },
      {
        timeZone: "Asia/Hong_Kong",
        revision: "settings-2",
        recordedAt: "2026-08-09T09:00:00.000Z",
        eventSequence: 2
      }
    ]
  });
  const context = workspace("team-a");
  assert.equal((await reader.get(context)).revision, "settings-2");
  assert.deepEqual(
    await reader.getAt(
      context,
      await sealedCutoff(context, "2026-08-09T08:30:00.000Z")
    ),
    {
      timeZone: "Asia/Shanghai",
      revision: "settings-1",
      recordedAt: "2026-08-09T08:00:00.000Z",
      eventSequence: 1
    }
  );
  assert.throws(() => new InMemoryGrowthWorkspaceSettingsReader({
    "team-a": [{
      timeZone: "Not/AZone",
      revision: "settings-3",
      recordedAt: "2026-08-09T10:00:00.000Z",
      eventSequence: 3
    }]
  }), /invalid_workspace_time_zone/);
});

test("same-millisecond settings are ordered by event sequence without changing old cutoffs", async () => {
  const reader = new InMemoryGrowthWorkspaceSettingsReader({
    "team-a": [
      {
        timeZone: "Asia/Shanghai",
        revision: "settings-1",
        recordedAt: "2026-08-09T08:00:00.000Z",
        eventSequence: 1
      },
      {
        timeZone: "Asia/Hong_Kong",
        revision: "settings-2",
        recordedAt: "2026-08-09T08:00:00.000Z",
        eventSequence: 2
      }
    ]
  });
  const context = workspace("team-a");
  const cutoff = await sealedCutoff(context, "2026-08-09T08:00:00.000Z");
  assert.equal((await reader.getAt(context, cutoff)).revision, "settings-2");
  assert.deepEqual(await reader.get(context), await reader.getAt(context, cutoff));
});

test("missing workspace configuration uses the trusted deployment default", async () => {
  const reader = new InMemoryGrowthWorkspaceSettingsReader();
  assert.deepEqual(await reader.get(workspace("team-a")), {
    timeZone: "Asia/Shanghai",
    revision: "growth-workspace-settings.v1",
    recordedAt: "1970-01-01T00:00:00.000Z",
    eventSequence: 1
  });
});

test("getAt rejects a valid token issued for another workspace", async () => {
  const reader = new InMemoryGrowthWorkspaceSettingsReader();
  const token = await sealedCutoff(
    workspace("team-b"),
    "2026-08-09T08:00:00.000Z"
  );
  await assert.rejects(
    () => reader.getAt(workspace("team-a"), token),
    /growth_cutoff_workspace_mismatch/
  );
});

test("trusted memory settings appends use the workspace-global allocator during clock rollback", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T09:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(runner);
  const repository = new InMemoryGrowthWorkspaceSettingsRepository(
    runner,
    barrier
  );
  await repository.appendTrustedSettingsEvent("team-a", {
    timeZone: "Asia/Shanghai",
    revision: "settings-1"
  });
  runner.setDatabaseNow("2026-08-09T08:00:00.000Z");
  await repository.appendTrustedSettingsEvent("team-a", {
    timeZone: "Asia/Hong_Kong",
    revision: "settings-2"
  });
  const context = workspace("team-a");
  assert.equal((await repository.getAt(
    context,
    await barrier.sealReadCutoff(context, "2026-08-09T08:59:59.999Z")
  )).revision, "growth-workspace-settings.v1");
  assert.equal((await repository.getAt(
    context,
    await barrier.sealReadCutoff(context, "2026-08-09T09:00:00.000Z")
  )).revision, "settings-1");
  assert.equal((await repository.getAt(
    context,
    await barrier.sealReadCutoff(context, "2026-08-09T09:00:00.001Z")
  )).revision, "settings-2");
});
