import assert from "node:assert/strict";
import test from "node:test";
import type { CommandContext } from "./growth-command-context.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import {
  CatalogService,
  type CatalogItemInput
} from "./catalog-service.js";

const NOW = "2026-08-09T08:00:00.000Z";

function workspace(
  workspaceId = "team-a",
  capabilities: ActiveWorkspaceContext["capabilities"] = ["catalog.read"]
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "user-1",
    role: capabilities.includes("catalog.manage") ? "admin" : "sales",
    teamId: workspaceId,
    capabilities: Object.freeze([...capabilities]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function command(
  activeWorkspace = workspace("team-a", ["catalog.read", "catalog.manage"]),
  overrides: Partial<CommandContext> = {}
): CommandContext {
  return Object.freeze({
    workspace: activeWorkspace,
    actorId: activeWorkspace.actorId,
    idempotencyKey: "catalog-command-0001",
    requestHash: `sha256:${"a".repeat(64)}`,
    expectedRevision: null,
    ...overrides
  });
}

const input: CatalogItemInput = {
  type: "service",
  code: "svc-001",
  name: "诊断服务",
  description: null,
  unit: "次"
};

function catalogFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({
    transactions,
    temporalBarrier
  });
  let id = 0;
  const service = new CatalogService({
    repository,
    idFactory: () => `catalog-item-${++id}`
  });
  return { repository, service, transactions, temporalBarrier };
}

test("sales can read catalog items but cannot manage them", async () => {
  const state = catalogFixture();
  await state.repository.appendCatalogItem({
    id: "item-1",
    workspaceId: "team-a",
    type: "service",
    code: "SVC-000",
    name: "已发布服务",
    description: null,
    unit: "次",
    status: "active",
    revision: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW
  });

  const page = await state.service.list(workspace(), {
    cursor: null,
    limit: 20,
    sort: "updatedAt"
  });
  assert.equal(page.items.length, 1);
  assert.equal("createdBy" in page.items[0]!, false);
  assert.equal(page.items[0]!.description, null);
  await assert.rejects(
    state.service.create(command(workspace()), input),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden"
  );
});

test("create normalizes a tenant code and duplicate code is workspace scoped", async () => {
  const state = catalogFixture();
  const teamA = command();
  const created = await state.service.create(teamA, input);
  assert.equal(created.code, "SVC-001");
  assert.equal(created.description, null);
  assert.equal("createdBy" in created, false);

  await assert.rejects(
    state.service.create(command(teamA.workspace, {
      idempotencyKey: "catalog-command-0002",
      requestHash: `sha256:${"b".repeat(64)}`
    }), { ...input, name: "重复编码" }),
    (error: unknown) => (error as { code?: string }).code === "catalog_code_conflict"
  );

  const teamB = command(workspace("team-b", ["catalog.read", "catalog.manage"]), {
    idempotencyKey: "catalog-command-team-b",
    requestHash: `sha256:${"c".repeat(64)}`
  });
  const other = await state.service.create(teamB, input);
  assert.equal(other.workspaceId, "team-b");
  assert.equal(other.code, "SVC-001");
});

test("list probes one row past the page and keeps deterministic cursor order", async () => {
  const state = catalogFixture();
  for (const [index, code] of ["B", "A", "C"].entries()) {
    await state.repository.appendCatalogItem({
      id: `item-${index}`,
      workspaceId: "team-a",
      type: "product",
      code,
      name: `Item ${code}`,
      description: null,
      unit: "pcs",
      status: "active",
      revision: 1,
      createdBy: "admin-1",
      createdAt: NOW,
      updatedAt: NOW
    });
  }
  const first = await state.service.list(workspace(), {
    cursor: null,
    limit: 2,
    sort: "code"
  });
  assert.deepEqual(first.items.map((item) => item.code), ["A", "B"]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextAfter);
  const second = await state.service.list(workspace(), {
    cursor: first.nextAfter,
    limit: 2,
    sort: "code"
  });
  assert.deepEqual(second.items.map((item) => item.code), ["C"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextAfter, null);
});

test("maximum-size pages still probe beyond the repository limit", async () => {
  const state = catalogFixture();
  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await state.repository.appendCatalogItem({
      id: `maximum-${suffix}`,
      workspaceId: "team-a",
      type: "product",
      code: `MAX-${suffix}`,
      name: `Maximum ${suffix}`,
      description: null,
      unit: "pcs",
      status: "active",
      revision: 1,
      createdBy: "admin-1",
      createdAt: NOW,
      updatedAt: NOW
    });
  }
  const page = await state.service.list(workspace(), {
    cursor: null,
    limit: 100,
    sort: "code"
  });
  assert.equal(page.items.length, 100);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextAfter);
});

test("only active items can be patched or retired", async () => {
  const state = catalogFixture();
  const created = await state.service.create(command(), input);
  const retired = await state.service.retire(command(undefined, {
    idempotencyKey: "catalog-retire-0001",
    requestHash: `sha256:${"d".repeat(64)}`,
    expectedRevision: created.revision
  }), created.id);
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);
  await assert.rejects(
    state.service.update(command(undefined, {
      idempotencyKey: "catalog-update-retired",
      requestHash: `sha256:${"e".repeat(64)}`,
      expectedRevision: retired.revision
    }), created.id, { name: "不可编辑" }),
    (error: unknown) => (error as { code?: string }).code === "catalog_item_retired"
  );
});
