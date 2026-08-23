import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialCouncilModelRoutingPolicyVersion,
  type FinancialCouncilModelRoutingPolicyInput,
  type FinancialCouncilModelRoutingPolicyVersion
} from "./financial-council-model-routing.js";
import type {
  FinancialCouncilModelRoutingRepository,
  PutFinancialCouncilModelRoutingPolicyCommand
} from "./financial-council-model-routing-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: unknown })?.code === code;
}

export function routingWorkspace(
  workspaceId = "team-1",
  actorId = "admin-1"
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId, kind: "team" as const, actorId,
    role: "admin" as const, teamId: workspaceId,
    capabilities: Object.freeze([]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

export function routingPolicyInput(): FinancialCouncilModelRoutingPolicyInput {
  const role = () => ({ mode: "auto" as const,
    primaryConnectionId: null, fallbackConnectionIds: Object.freeze([]),
    preferenceWeightBps: 0 });
  return {
    roles: { cfo: role(), finance: role(), profit: role(), cost: role(),
      cashflow: role(), tax: role() },
    maxRunBudgetMinor: 100_000,
    maxRoleBudgetMinor: 30_000,
    requestTimeoutMs: 60_000
  };
}

export function routingPolicyVersion(
  workspaceId = "team-1",
  revision = 1,
  overrides: Partial<FinancialCouncilModelRoutingPolicyVersion> = {}
) {
  return createFinancialCouncilModelRoutingPolicyVersion({
    policyVersionId: `routing-policy-${revision}`,
    workspaceId,
    revision,
    status: "active",
    input: routingPolicyInput(),
    createdBy: "admin-1",
    createdAt: `2026-08-23T09:0${revision}:00.000Z`,
    ...overrides
  });
}

export function routingPutCommand(input: {
  workspaceId?: string;
  actorId?: string;
  key?: string;
  requestHash?: string;
  expectedRevision?: number | null;
} = {}): PutFinancialCouncilModelRoutingPolicyCommand {
  const workspace = routingWorkspace(input.workspaceId, input.actorId);
  return Object.freeze({
    workspace,
    actorId: workspace.actorId,
    idempotencyKey: input.key ?? "routing-key-1",
    requestHash: input.requestHash ?? `sha256:${"b".repeat(64)}`,
    expectedRevision: input.expectedRevision === undefined
      ? null : input.expectedRevision
  });
}

export function registerFinancialCouncilModelRoutingRepositoryContract(
  name: string,
  factory: () => FinancialCouncilModelRoutingRepository | Promise<
    FinancialCouncilModelRoutingRepository
  >
) {
  test(`${name}: no current policy and revision-1 creation`, async () => {
    const repository = await factory();
    assert.equal(await repository.getCurrent(routingWorkspace()), null);
    const value = routingPolicyVersion();
    const created = await repository.put(routingPutCommand(), value);
    assert.equal(created.replayed, false);
    assert.deepEqual(created.value, value);
    assert.deepEqual(await repository.getCurrent(routingWorkspace()), value);
  });

  test(`${name}: exact replay wins before optimistic revision checks`, async () => {
    const repository = await factory();
    const value = routingPolicyVersion();
    const first = await repository.put(routingPutCommand(), value);
    const replay = await repository.put(routingPutCommand({
      expectedRevision: 99
    }), routingPolicyVersion("team-1", 9));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, first.value);
  });

  test(`${name}: changed idempotent request conflicts without moving current`,
    async () => {
      const repository = await factory();
      const first = routingPolicyVersion();
      await repository.put(routingPutCommand(), first);
      await assert.rejects(repository.put(routingPutCommand({
        requestHash: `sha256:${"c".repeat(64)}`,
        expectedRevision: 1
      }), routingPolicyVersion("team-1", 2)),
      hasCode("financial_council_model_routing_idempotency_conflict"));
      assert.deepEqual(await repository.getCurrent(routingWorkspace()), first);
    });

  test(`${name}: one If-Match contender wins and historical status supersedes`,
    async () => {
      const repository = await factory();
      await repository.put(routingPutCommand(), routingPolicyVersion());
      const results = await Promise.allSettled([
        repository.put(routingPutCommand({ key: "winner-a",
          requestHash: `sha256:${"d".repeat(64)}`, expectedRevision: 1 }),
        routingPolicyVersion("team-1", 2, { policyVersionId: "route-a" })),
        repository.put(routingPutCommand({ key: "winner-b",
          requestHash: `sha256:${"e".repeat(64)}`, expectedRevision: 1 }),
        routingPolicyVersion("team-1", 2, { policyVersionId: "route-b" }))
      ]);
      assert.equal(results.filter((item) => item.status === "fulfilled").length,
        1);
      const rejected = results.find((item) => item.status === "rejected") as
        PromiseRejectedResult;
      assert.equal(hasCode("financial_council_model_routing_revision_conflict")(
        rejected.reason), true);
      const historical = await repository.getVersion(
        routingWorkspace(), "routing-policy-1"
      );
      assert.equal(historical?.status, "superseded");
      assert.equal((await repository.getCurrent(routingWorkspace()))?.status,
        "active");
    });

  test(`${name}: workspace isolation and historical lookup are exact`, async () => {
    const repository = await factory();
    const one = routingPolicyVersion("team-1");
    const two = routingPolicyVersion("team-2", 1, {
      policyVersionId: "routing-policy-team-2", createdBy: "admin-2"
    });
    await repository.put(routingPutCommand(), one);
    await repository.put(routingPutCommand({ workspaceId: "team-2",
      actorId: "admin-2" }), two);
    assert.deepEqual(await repository.getCurrent(routingWorkspace("team-1")),
      one);
    assert.deepEqual(await repository.getCurrent(routingWorkspace(
      "team-2", "admin-2")), two);
    assert.equal(await repository.getVersion(routingWorkspace("team-2",
      "admin-2"), one.policyVersionId), null);
  });

  test(`${name}: open JSON and hash mismatch reject without partial state`,
    async () => {
      const repository = await factory();
      const open = { ...routingPolicyVersion(), unexpected: true } as never;
      await assert.rejects(repository.put(routingPutCommand(), open),
        hasCode("financial_council_model_routing_integrity"));
      const changed = { ...routingPolicyVersion(),
        maxRunBudgetMinor: 200_000 } as FinancialCouncilModelRoutingPolicyVersion;
      await assert.rejects(repository.put(routingPutCommand({ key: "hash" }),
        changed), hasCode("financial_council_model_routing_integrity"));
      assert.equal(await repository.getCurrent(routingWorkspace()), null);
    });

  test(`${name}: failed stale write leaves the stable current pointer`,
    async () => {
      const repository = await factory();
      const first = routingPolicyVersion();
      await repository.put(routingPutCommand(), first);
      await assert.rejects(repository.put(routingPutCommand({ key: "stale",
        requestHash: `sha256:${"f".repeat(64)}`, expectedRevision: 0 }),
      routingPolicyVersion("team-1", 2)),
      hasCode("financial_council_model_routing_revision_conflict"));
      assert.deepEqual(await repository.getCurrent(routingWorkspace()), first);
    });
}
