import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  recommendationFixture
} from "./advisor-recommendation-domain-test.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace = (workspaceId = "ws-1"): ActiveWorkspaceContext =>
  Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "manager-1",
    role: "manager",
    teamId: workspaceId,
    capabilities: Object.freeze(["roi.close"]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });

function command(
  key: string,
  workspaceId = "ws-1",
  expectedRevision: number | null = null
): CommandContext {
  return Object.freeze({
    workspace: workspace(workspaceId),
    actorId: "manager-1",
    idempotencyKey: key,
    requestHash: canonicalGrowthRequestHash({ key, workspaceId }),
    expectedRevision
  });
}

function createRepository(
  initial: ReturnType<typeof recommendationFixture>[] = [],
  options: { now?: string } = {}
) {
  return new InMemoryAdvisorRecommendationRepository(initial, {
    now: options.now
  });
}

test("same generation key returns one recommendation and cross-workspace references fail closed", async () => {
  const repository = createRepository();
  const aggregate = recommendationFixture({
    workspaceId: "ws-1",
    generationIdempotencyKey: "generation-1"
  });
  const first = await repository.create(
    command("request-a"), aggregate
  );
  const replay = await repository.create(
    command("request-b"), aggregate
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(await repository.findById(workspace("ws-2"), aggregate.id), null);
  await assert.rejects(
    repository.create(command("request-c"), {
      ...aggregate,
      inputSnapshotHash: `sha256:${"f".repeat(64)}`
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "advisor_generation_conflict"
  );
});

test("historical list is reduced by recorded event revision", async () => {
  const repository = createRepository([], { now: "2026-08-09T08:00:00.000Z" });
  const created = recommendationFixture({
    workspaceId: "ws-1",
    createdAt: "2026-08-09T08:00:00.000Z"
  });
  await repository.create(command("create-history"), created);
  repository.setNow("2026-08-09T09:00:00.000Z");
  await repository.transition(command("accept-history", "ws-1", 1), {
    recommendationId: created.id,
    kind: "accept",
    reason: null
  });
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:30:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const before = await repository.listAt(workspace("ws-1"), {
    status: ["proposed"],
    cutoff: await barrier.sealReadCutoff(
      workspace("ws-1"), "2026-08-09T08:30:00.000Z"
    ),
    limit: 100,
    cursor: null
  });
  assert.deepEqual(
    before.items.map((row) => [row.id, row.status, row.revision]),
    [[created.id, "proposed", 1]]
  );
});

test("later recommendation transitions cannot backdate an old as-of when the clock rolls back", async () => {
  const repository = createRepository([], {
    now: "2026-08-09T09:00:00.000Z"
  });
  const created = await repository.create(
    command("create-clock"),
    recommendationFixture({ status: "proposed" })
  );
  repository.setNow("2026-08-09T08:00:00.000Z");
  await repository.transition(
    command("accept-clock", "ws-1", created.value.revision),
    { recommendationId: created.value.id, kind: "accept", reason: null }
  );
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T09:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const before = await repository.listAt(workspace("ws-1"), {
    status: ["proposed"],
    cutoff: await barrier.sealReadCutoff(
      workspace("ws-1"), "2026-08-09T09:00:00.000Z"
    ),
    limit: 100,
    cursor: null
  });
  assert.equal(before.items[0]?.status, "proposed");
  const atBoundary = await repository.listAt(workspace("ws-1"), {
    status: ["accepted"],
    cutoff: await barrier.sealReadCutoff(
      workspace("ws-1"), "2026-08-09T09:00:00.001Z"
    ),
    limit: 100,
    cursor: null
  });
  assert.equal(atBoundary.items[0]?.status, "accepted");
});
