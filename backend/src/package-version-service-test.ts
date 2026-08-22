import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogItem, PricingPolicyVersion } from "./catalog-domain.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import {
  PackageVersionService,
  calculateFrozenComponentUnitCost
} from "./package-version-service.js";
import { PricingPolicyService } from "./pricing-policy-service.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";

const NOW = "2026-08-09T08:00:00.000Z";
const END = "2026-09-09T08:00:00.000Z";

function workspace(workspaceId = "team-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "admin-1",
    role: "admin",
    teamId: workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function adminCommand(overrides: Partial<CommandContext> = {}): CommandContext {
  return Object.freeze({
    workspace: workspace(),
    actorId: "admin-1",
    idempotencyKey: `package-command-${Math.random()}`,
    requestHash: `sha256:${"a".repeat(64)}`,
    expectedRevision: null,
    ...overrides
  });
}

function item(id: string, type: CatalogItem["type"]): CatalogItem {
  return {
    id, workspaceId: "team-a", type, code: id.toUpperCase(), name: id,
    description: null, unit: "unit", status: "active", revision: 1,
    createdBy: "admin-1", createdAt: NOW, updatedAt: NOW
  };
}

function policy(
  id: string,
  catalogItemId: string,
  overrides: Partial<PricingPolicyVersion> = {}
): PricingPolicyVersion {
  return {
    id, workspaceId: "team-a", catalogItemId, version: 1,
    packageVersionId: null, currency: "CNY", listUnitPriceMinor: 10_000,
    unitStandardCostMinor: 2_000, defaultOrderDeliveryCostMinor: 0,
    defaultOrderSalesCostMinor: 0, defaultOrderServiceCostMinor: 0,
    absoluteFloorUnitPriceMinor: 8_000, standardDiscountLimitBps: 1_000,
    absoluteDiscountLimitBps: 2_000, targetGrossMarginBps: 3_000,
    absoluteMinimumGrossMarginBps: 1_000, standardPaymentTermDays: 30,
    absolutePaymentTermDays: 60,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 5_000,
      manualEscalationEnabled: true
    },
    surchargePolicies: [], giftPolicies: [], validFrom: NOW, validTo: END,
    status: "active", source: "native",
    capabilityRegistryVersion: "growth-capabilities.v1", revision: 2,
    createdBy: "admin-1", createdAt: NOW,
    ...overrides
  };
}

async function fixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({ transactions, temporalBarrier });
  await repository.appendCatalogItem(item("package-a", "package"));
  await repository.appendCatalogItem(item("service-a", "service"));
  await repository.appendPricingPolicyVersion(policy("component-policy-a", "service-a"));
  let sequence = 0;
  const packageVersions = new PackageVersionService({
    repository,
    idFactory: () => `package-version-${++sequence}`
  });
  const pricingPolicies = new PricingPolicyService({
    repository,
    idFactory: () => `pricing-policy-${++sequence}`
  });
  return { repository, packageVersions, pricingPolicies };
}

function packagePricingInput(packageVersionId: string, totalCost = 5_000) {
  const base = policy("ignored", "package-a", {
    packageVersionId,
    status: "draft",
    revision: 1,
    unitStandardCostMinor: totalCost,
    defaultOrderServiceCostMinor: 600,
    validTo: "2026-10-09T08:00:00.000Z"
  });
  const {
    id: _id, workspaceId: _workspaceId, version: _version, status: _status,
    source: _source, capabilityRegistryVersion: _registry, revision: _revision,
    createdBy: _createdBy, createdAt: _createdAt, ...input
  } = base;
  return input;
}

test("fractional component quantity uses deterministic half-up minor-unit rounding", () => {
  assert.equal(calculateFrozenComponentUnitCost([
    { unitStandardCostMinor: 2_001, quantityMicros: 1_500_000 },
    { unitStandardCostMinor: 999, quantityMicros: 500_000 }
  ]), 3_502);
  assert.throws(() => calculateFrozenComponentUnitCost([
    { unitStandardCostMinor: Number.MAX_SAFE_INTEGER, quantityMicros: 2_000_000 }
  ]), (error: unknown) => (error as { code?: string }).code === "package_cost_out_of_range");
});

test("package drafts reject empty, duplicate, invalid quantity, and non-package parents", async () => {
  const state = await fixture();
  const base = {
    currency: "CNY", validFrom: NOW, validTo: END,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy-a",
      quantityMicros: 1_000_000
    }]
  };
  for (const [input, code] of [
    [{ ...base, components: [] }, "package_components_required"],
    [{ ...base, components: [...base.components, ...base.components] }, "duplicate_package_component"],
    [{ ...base, components: [{ ...base.components[0]!, quantityMicros: 0 }] }, "invalid_package_component_quantity"]
  ] as const) {
    await assert.rejects(
      state.packageVersions.createDraft(adminCommand(), "package-a", input),
      (error: unknown) => (error as { code?: string }).code === code
    );
  }
  await assert.rejects(
    state.packageVersions.createDraft(adminCommand(), "service-a", base),
    (error: unknown) => (error as { code?: string }).code
      === "invalid_package_catalog_item"
  );
});

test("concurrent overlapping package activation has one winner and active versions are immutable", async () => {
  const state = await fixture();
  const input = {
    currency: "CNY", validFrom: NOW, validTo: END,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy-a",
      quantityMicros: 1_000_000
    }]
  };
  const first = await state.packageVersions.createDraft(adminCommand(), "package-a", input);
  const second = await state.packageVersions.createDraft(adminCommand(), "package-a", input);
  const outcomes = await Promise.all([
    state.packageVersions.activate(adminCommand({ expectedRevision: 1 }), first.id),
    state.packageVersions.activate(adminCommand({ expectedRevision: 1 }), second.id)
  ].map((pending) => pending.then(() => "ok", (error) => error.code)));
  assert.deepEqual(outcomes.sort(), ["ok", "package_window_overlap"]);
  const active = outcomes[0] === "ok" ? first : second;
  await assert.rejects(
    state.packageVersions.updateDraft(
      adminCommand({ expectedRevision: 2 }), active.id, input
    ),
    (error: unknown) => (error as { code?: string }).code
      === "package_version_immutable"
  );
});

test("direct package cycles are rejected without activating the draft", async () => {
  const state = await fixture();
  const selfPolicy = policy("self-policy", "package-a", {
    packageVersionId: "package-version-1"
  });
  await state.repository.appendPricingPolicyVersion(selfPolicy);
  const created = await state.repository.createPackageVersionDraft({
    workspaceId: "team-a", id: "package-version-1",
    packageCatalogItemId: "package-a", currency: "CNY",
    validFrom: NOW, validTo: END,
    components: [{
      componentCatalogItemId: "package-a",
      componentPricingPolicyVersionId: "self-policy",
      quantityMicros: 1_000_000
    }], actorId: "admin-1", idempotencyKey: "seed-cycle",
    requestHash: `sha256:${"b".repeat(64)}`
  });
  assert.equal(created.kind, "ok");
  if (created.kind !== "ok") throw new Error("seed_failed");
  const draft = created.value;
  await assert.rejects(
    state.packageVersions.activate(adminCommand({ expectedRevision: 1 }), draft.id),
    (error: unknown) => (error as { code?: string }).code === "package_cycle"
  );
  assert.equal((await state.repository.findPackageVersion("team-a", draft.id))!.status, "draft");
});

test("package policy activation freezes exact components and declared total cost", async () => {
  const state = await fixture();
  const draft = await state.packageVersions.createDraft(adminCommand(), "package-a", {
    currency: "CNY", validFrom: NOW, validTo: END,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy-a",
      quantityMicros: 1_500_000
    }]
  });
  const active = await state.packageVersions.activate(
    adminCommand({ expectedRevision: 1 }), draft.id
  );
  const pricingDraft = await state.pricingPolicies.createDraft(
    adminCommand(), packagePricingInput(active.id)
  );
  const pricing = await state.pricingPolicies.activate(
    adminCommand({ expectedRevision: 1 }), pricingDraft.id
  );
  assert.equal(pricing.amountVisibility, "full");
  if (pricing.amountVisibility !== "full") throw new Error("full_projection_required");
  assert.equal(pricing.unitStandardCostMinor, 5_000);
  assert.equal(pricing.defaultOrderServiceCostMinor, 600);
  const snapshot = await state.repository.findPackageCostSnapshot(
    "team-a", pricing.id
  );
  assert.deepEqual(snapshot && {
    packageVersionId: snapshot.packageVersionId,
    componentUnitStandardCostMinor: snapshot.componentUnitStandardCostMinor,
    packageOwnUnitServiceCostMinor: snapshot.packageOwnUnitServiceCostMinor,
    totalUnitStandardCostMinor: snapshot.totalUnitStandardCostMinor,
    components: snapshot.components
  }, {
    packageVersionId: active.id,
    componentUnitStandardCostMinor: 3_000,
    packageOwnUnitServiceCostMinor: 2_000,
    totalUnitStandardCostMinor: 5_000,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy-a",
      quantityMicros: 1_500_000,
      unitStandardCostMinor: 2_000,
      extendedStandardCostMinor: 3_000
    }]
  });
  assert.match(snapshot!.componentSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
});

test("package policy rejects a declared total below the locked frozen components", async () => {
  const state = await fixture();
  const draft = await state.packageVersions.createDraft(adminCommand(), "package-a", {
    currency: "CNY", validFrom: NOW, validTo: END,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy-a",
      quantityMicros: 2_000_000
    }]
  });
  const active = await state.packageVersions.activate(
    adminCommand({ expectedRevision: 1 }), draft.id
  );
  const pricingDraft = await state.pricingPolicies.createDraft(
    adminCommand(), packagePricingInput(active.id, 3_999)
  );
  await assert.rejects(
    state.pricingPolicies.activate(
      adminCommand({ expectedRevision: 1 }), pricingDraft.id
    ),
    (error: unknown) => (error as { code?: string }).code
      === "package_total_cost_below_component_cost"
  );
  assert.equal(await state.repository.findPackageCostSnapshot(
    "team-a", pricingDraft.id
  ), null);
});
