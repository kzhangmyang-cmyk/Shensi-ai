import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  assertGrowthTemporalBarrier,
  assertGrowthSealedReadCutoff,
  withGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff,
  type GrowthTemporalTransaction
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

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

test("allocateAppend locks the workspace barrier before reading the database clock", async () => {
  const calls: string[] = [];
  let tail = {
    lastRecordedAt: "2026-08-09T08:00:00.000Z",
    temporalSequence: 4
  };
  const tx: GrowthTemporalTransaction = {
    async lockWorkspaceTemporalBarrierForUpdate(workspaceId) {
      calls.push(`lock:${workspaceId}`);
      return tail;
    },
    async currentTimestamp3() {
      calls.push("now");
      return "2026-08-09T07:00:00.000Z";
    },
    async saveWorkspaceTemporalBarrier(workspaceId, expectedSequence, next) {
      calls.push(`save:${workspaceId}:${expectedSequence}`);
      tail = { ...next };
    }
  };
  const barrier = new DefaultGrowthTemporalBarrier({
    async run(work) { return work(tx); }
  });
  assert.deepEqual(await barrier.allocateAppend(tx, "workspace-a"), {
    recordedAt: "2026-08-09T08:00:00.001Z",
    temporalSequence: 5
  });
  assert.deepEqual(await barrier.allocateAppend(tx, "workspace-a"), {
    recordedAt: "2026-08-09T08:00:00.002Z",
    temporalSequence: 6
  });
  assert.deepEqual(calls, [
    "lock:workspace-a", "now", "save:workspace-a:4",
    "lock:workspace-a", "now", "save:workspace-a:5"
  ]);
});

test("a sealed cutoff waits for prior writers and fences every later append", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T07:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(runner);
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerAllocated!: () => void;
  const allocated = new Promise<void>((resolve) => { writerAllocated = resolve; });
  const priorWriter = runner.run(async (tx) => {
    await barrier.allocateAppend(tx, "workspace-a");
    writerAllocated();
    await writerRelease;
  });
  await allocated;
  const sealing = barrier.sealReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z"
  );
  let settled = false;
  void sealing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseWriter();
  await priorWriter;
  const sealed = await sealing;
  assert.equal(sealed.effectiveAsOf, "2026-08-09T08:00:00.000Z");
  runner.setDatabaseNow("2026-08-09T06:00:00.000Z");
  const later = await runner.run((tx) => barrier.allocateAppend(tx, "workspace-a"));
  assert.equal(later.recordedAt, "2026-08-09T08:00:00.001Z");
});

test("sealed cutoff provenance and exact workspace identity are enforced", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(runner);
  const token = await barrier.sealReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z"
  );
  assert.equal(assertGrowthSealedReadCutoff(token, "workspace-a"), token);
  assert.throws(
    () => assertGrowthSealedReadCutoff(token, "workspace-b"),
    /growth_cutoff_workspace_mismatch/
  );
  const forged = Object.freeze({
    workspaceId: "workspace-a",
    effectiveAsOf: "2026-08-09T08:00:00.000Z",
    temporalSequence: 1
  }) as GrowthSealedReadCutoff;
  assert.throws(
    () => assertGrowthSealedReadCutoff(forged, "workspace-a"),
    /invalid_growth_sealed_read_cutoff/
  );
  for (const copied of [
    { ...token },
    JSON.parse(JSON.stringify(token)) as object
  ]) {
    assert.throws(
      () => assertGrowthSealedReadCutoff(
        copied as GrowthSealedReadCutoff,
        "workspace-a"
      ),
      /invalid_growth_sealed_read_cutoff/
    );
  }
});

test("only Foundation-issued temporal barriers have provenance", () => {
  const barrier = new DefaultGrowthTemporalBarrier(
    new InMemoryGrowthTemporalTransactionRunner()
  );
  assert.equal(assertGrowthTemporalBarrier(barrier), barrier);
  assert.throws(
    () => assertGrowthTemporalBarrier(Object.freeze({
      allocateAppend: barrier.allocateAppend.bind(barrier),
      sealReadCutoff: barrier.sealReadCutoff.bind(barrier)
    })),
    /invalid_growth_temporal_barrier/u
  );
});

test("one public boundary seals once and passes the identical token to every reader", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const delegate = new DefaultGrowthTemporalBarrier(runner);
  let seals = 0;
  const barrier = {
    allocateAppend: delegate.allocateAppend.bind(delegate),
    async sealReadCutoff(context: ActiveWorkspaceContext, effectiveAsOf: string) {
      seals += 1;
      return delegate.sealReadCutoff(context, effectiveAsOf);
    }
  };
  const seen: GrowthSealedReadCutoff[] = [];
  const result = await withGrowthSealedReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z",
    barrier,
    async (cutoff) => {
      seen.push(cutoff);
      await Promise.resolve();
      seen.push(cutoff);
      return cutoff.effectiveAsOf;
    }
  );
  assert.equal(result, "2026-08-09T08:00:00.000Z");
  assert.equal(seals, 1);
  assert.equal(seen[0], seen[1]);
});

test("repeated seals do not put temporal sequence into business identity", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(runner);
  const first = await barrier.sealReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z"
  );
  const second = await barrier.sealReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z"
  );
  assert.ok(second.temporalSequence > first.temporalSequence);
  assert.equal(first.effectiveAsOf, second.effectiveAsOf);
});
