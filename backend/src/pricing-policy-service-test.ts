import assert from "node:assert/strict";
import test from "node:test";
import type { PricingPolicyVersion } from "./catalog-domain.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import {
  capabilitiesForHumanRole,
  type GrowthCapability
} from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  PricingPolicyService,
  projectPricingPolicy,
  requiredCapabilitiesForPolicy,
  type PricingPolicyDraftInput
} from "./pricing-policy-service.js";

const NOW = "2026-08-09T08:00:00.000Z";
const LATER = "2026-09-09T08:00:00.000Z";

function salesContext(): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "team-a",
    kind: "team",
    actorId: "sales-1",
    role: "sales",
    teamId: "team-a",
    capabilities: capabilitiesForHumanRole("sales"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function managerContext(): ActiveWorkspaceContext {
  return Object.freeze({
    ...salesContext(),
    actorId: "manager-1",
    role: "manager",
    capabilities: capabilitiesForHumanRole("manager")
  });
}

function adminCommand(overrides: Partial<CommandContext> = {}): CommandContext {
  return Object.freeze({
    workspace: Object.freeze({
      ...managerContext(),
      actorId: "admin-1",
      role: "admin" as const,
      capabilities: capabilitiesForHumanRole("admin")
    }),
    actorId: "admin-1",
    idempotencyKey: "pricing-command-1",
    requestHash: "sha256:pricing-command-1",
    expectedRevision: null,
    ...overrides
  });
}

function draftInput(
  overrides: Partial<PricingPolicyDraftInput> = {}
): PricingPolicyDraftInput {
  return {
    catalogItemId: "catalog-item-1",
    packageVersionId: null,
    currency: "CNY",
    listUnitPriceMinor: 12_000,
    unitStandardCostMinor: 8_000,
    defaultOrderDeliveryCostMinor: 100,
    defaultOrderSalesCostMinor: 200,
    defaultOrderServiceCostMinor: 300,
    absoluteFloorUnitPriceMinor: 10_000,
    standardDiscountLimitBps: 500,
    absoluteDiscountLimitBps: 1_000,
    targetGrossMarginBps: 3_000,
    absoluteMinimumGrossMarginBps: 1_500,
    standardPaymentTermDays: 30,
    absolutePaymentTermDays: 60,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 6_000,
      manualEscalationEnabled: true
    },
    surchargePolicies: [{
      kind: "delivery",
      condition: "express",
      fixedAmountMinor: 500,
      unitAmountMinor: 0
    }],
    giftPolicies: [{
      catalogItemId: "gift-item-1",
      unitStandardCostMinor: 100,
      standardQuantityMicros: 1_000_000,
      absoluteQuantityMicros: 2_000_000,
      standardCostLimitMinor: 100,
      absoluteCostLimitMinor: 200
    }],
    validFrom: NOW,
    validTo: LATER,
    ...overrides
  };
}

function policy(
  overrides: Partial<PricingPolicyVersion> = {}
): PricingPolicyVersion {
  return {
    id: "policy-1",
    workspaceId: "team-a",
    version: 1,
    status: "draft",
    source: "native",
    capabilityRegistryVersion: "growth-capabilities.v1",
    revision: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    ...draftInput(),
    ...overrides
  };
}

async function pricingFixture(options: Readonly<{
  status?: PricingPolicyVersion["status"];
  existingActiveWindow?: readonly [string, string | null];
  requiredCapability?: GrowthCapability | "quote.exception.unknown.approve";
  itemType?: "product" | "service" | "package";
  packageVersion?: "active" | "draft" | "retired" | "missing";
  capabilityRegistryVersion?: string;
}> = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({ transactions, temporalBarrier });
  await repository.appendCatalogItem({
    id: "catalog-item-1",
    workspaceId: "team-a",
    type: options.itemType ?? "service",
    code: "SVC-1",
    name: "Service",
    description: null,
    unit: "case",
    status: "active",
    revision: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW
  });
  await repository.appendCatalogItem({
    id: "gift-item-1",
    workspaceId: "team-a",
    type: "product",
    code: "GIFT-1",
    name: "Gift",
    description: null,
    unit: "piece",
    status: "active",
    revision: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW
  });
  if (options.packageVersion && options.packageVersion !== "missing") {
    await repository.appendPackageVersion({
      id: "package-version-1",
      workspaceId: "team-a",
      packageCatalogItemId: "catalog-item-1",
      version: 1,
      currency: "CNY",
      status: options.packageVersion,
      validFrom: NOW,
      validTo: LATER,
      revision: 1,
      createdBy: "admin-1",
      createdAt: NOW,
      updatedAt: NOW
    });
  }
  const approvalThresholds = options.requiredCapability === undefined
    ? draftInput().approvalThresholds
    : {
        ...draftInput().approvalThresholds,
        discountCapability: options.requiredCapability
      };
  await repository.appendPricingPolicyVersion(policy({
    status: options.status ?? "draft",
    packageVersionId: options.itemType === "package" ? "package-version-1" : null,
    capabilityRegistryVersion: options.capabilityRegistryVersion
      ?? "growth-capabilities.v1",
    approvalThresholds: approvalThresholds as PricingPolicyVersion["approvalThresholds"]
  }));
  if (options.existingActiveWindow) {
    await repository.appendPricingPolicyVersion(policy({
      id: "policy-existing",
      version: 2,
      status: "active",
      validFrom: options.existingActiveWindow[0],
      validTo: options.existingActiveWindow[1]
    }));
  }
  let nextId = 1;
  const service = new PricingPolicyService({
    repository,
    idFactory: () => `policy-created-${nextId++}`
  });
  return { repository, service };
}

test("sales projection cannot observe cost floor or detailed margin", async () => {
  const state = await pricingFixture({ status: "active" });
  const sales = await state.service.get(salesContext(), "policy-1");
  assert.equal(sales.amountVisibility, "redacted");
  assert.equal("unitStandardCostMinor" in sales, false);
  assert.equal("absoluteFloorUnitPriceMinor" in sales, false);
  assert.equal("absoluteMinimumGrossMarginBps" in sales, false);
  assert.equal("approvalThresholds" in sales, false);
  assert.equal("giftPolicies" in sales, false);
  assert.equal("capabilityRegistryVersion" in sales, false);
  const manager = await state.service.get(managerContext(), "policy-1");
  assert.equal(manager.amountVisibility, "full");
  assert.equal(manager.unitStandardCostMinor, 8_000);
  assert.equal(manager.absoluteFloorUnitPriceMinor, 10_000);
  assert.equal("capabilityRegistryVersion" in manager, false);
});

test("projection is decided from the capabilities supplied for the current read", () => {
  const stored = policy({ status: "active" });
  const full = projectPricingPolicy(stored, ["pricing.sensitive.read"]);
  const redacted = projectPricingPolicy(stored, []);
  assert.equal(full.amountVisibility, "full");
  assert.equal(redacted.amountVisibility, "redacted");
  assert.equal("unitStandardCostMinor" in redacted, false);
});

test("closed approval mapping returns exactly the six registered capabilities", () => {
  assert.deepEqual(requiredCapabilitiesForPolicy(policy()), [
    "quote.exception.discount.approve",
    "quote.exception.margin.approve",
    "quote.exception.payment_terms.approve",
    "quote.exception.gift.approve",
    "quote.exception.credit.approve",
    "quote.exception.manual.approve"
  ]);
  assert.throws(() => requiredCapabilitiesForPolicy(policy({
    approvalThresholds: {
      ...draftInput().approvalThresholds,
      discountCapability: "quote.confirm"
    }
  })), (error: unknown) =>
    (error as { code?: string }).code === "invalid_approval_rule");
});

test("draft validation rejects unsafe amounts, malformed currency, BPS overflow, and empty windows", async () => {
  const mutations: Array<readonly [Partial<PricingPolicyDraftInput>, string]> = [
    [{ listUnitPriceMinor: 0 }, "invalid_pricing_policy"],
    [{ unitStandardCostMinor: Number.MAX_SAFE_INTEGER + 1 }, "invalid_pricing_policy"],
    [{ currency: "cny" }, "invalid_pricing_policy"],
    [{ standardDiscountLimitBps: 10_001 }, "invalid_pricing_policy"],
    [{ absoluteMinimumGrossMarginBps: 10_000 }, "invalid_pricing_policy"],
    [{ validTo: NOW }, "invalid_pricing_policy_window"]
  ];
  for (const [change, code] of mutations) {
    const state = await pricingFixture();
    await assert.rejects(
      state.service.createDraft(adminCommand({
        idempotencyKey: `invalid-${Object.keys(change)[0]}`
      }), draftInput(change)),
      (error: unknown) => (error as { code?: string }).code === code
    );
  }
});

test("draft windows accept released RFC3339 offsets and persist canonical instants", async () => {
  const state = await pricingFixture();
  const created = await state.service.createDraft(
    adminCommand({ idempotencyKey: "offset-window" }),
    draftInput({
      validFrom: "2026-08-09T16:00:00.000+08:00",
      validTo: "2026-09-09T16:00:00.000+08:00"
    })
  );
  assert.equal(created.validFrom, NOW);
  assert.equal(created.validTo, LATER);
});

test("absolute commercial limits cannot be weaker than standard thresholds", async () => {
  const mutations: Partial<PricingPolicyDraftInput>[] = [
    { absoluteFloorUnitPriceMinor: 11_500 },
    { absoluteDiscountLimitBps: 499 },
    { absoluteMinimumGrossMarginBps: 3_001 },
    { absolutePaymentTermDays: 29 },
    { giftPolicies: [{
      ...draftInput().giftPolicies[0],
      absoluteQuantityMicros: 999_999
    }] },
    { giftPolicies: [{
      ...draftInput().giftPolicies[0],
      absoluteCostLimitMinor: 99
    }] }
  ];
  for (const [index, change] of mutations.entries()) {
    const state = await pricingFixture();
    await assert.rejects(
      state.service.createDraft(adminCommand({
        idempotencyKey: `weak-absolute-${index}`
      }), draftInput(change)),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_pricing_policy_limits"
    );
  }
});

test("activation rejects overlap and a non-closed approval capability mapping", async () => {
  const state = await pricingFixture({ existingActiveWindow: [NOW, null] });
  await assert.rejects(
    state.service.activate(adminCommand({ expectedRevision: 1 }), "policy-1"),
    (error: unknown) => (error as { code?: string }).code === "pricing_window_overlap"
  );
  const invalid = await pricingFixture({ requiredCapability: "quote.confirm" });
  await assert.rejects(
    invalid.service.activate(adminCommand({ expectedRevision: 1 }), "policy-1"),
    (error: unknown) => (error as { code?: string }).code === "invalid_approval_rule"
  );
});

test("half-open adjacent policy windows do not overlap", async () => {
  const state = await pricingFixture({ existingActiveWindow: [LATER, null] });
  const activated = await state.service.activate(
    adminCommand({ expectedRevision: 1 }),
    "policy-1"
  );
  assert.equal(activated.status, "active");
  assert.equal(activated.revision, 2);
});

test("activation records the current closed capability registry version", async () => {
  const state = await pricingFixture({ capabilityRegistryVersion: "legacy.v0" });
  await state.service.activate(adminCommand({ expectedRevision: 1 }), "policy-1");
  const stored = await state.repository.findPricingPolicyVersion("team-a", "policy-1");
  assert.equal(stored!.capabilityRegistryVersion, "growth-capabilities.v1");
});

test("package pricing requires its exact active package version", async () => {
  for (const packageVersion of ["missing", "draft", "retired"] as const) {
    const state = await pricingFixture({
      itemType: "package",
      packageVersion
    });
    await assert.rejects(
      state.service.activate(adminCommand({ expectedRevision: 1 }), "policy-1"),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_package_version_reference"
    );
  }
  const valid = await pricingFixture({ itemType: "package", packageVersion: "active" });
  const activated = await valid.service.activate(
    adminCommand({ expectedRevision: 1 }), "policy-1"
  );
  assert.equal(activated.status, "active");
});

test("draft creation appends a version while active and retired commercial rows stay immutable", async () => {
  const state = await pricingFixture({ status: "active" });
  const retired = await state.service.retire(
    adminCommand({ expectedRevision: 1 }), "policy-1"
  );
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);
  assert.equal(retired.listUnitPriceMinor, 12_000);
  const created = await state.service.createDraft(
    adminCommand({ idempotencyKey: "new-version" }),
    draftInput({ listUnitPriceMinor: 13_000 })
  );
  assert.equal(created.status, "draft");
  assert.equal(created.version, 2);
  assert.equal(created.listUnitPriceMinor, 13_000);
  assert.equal((await state.repository.findPricingPolicyVersion(
    "team-a", "policy-1"
  ))!.listUnitPriceMinor, 12_000);
});

test("pricing cursor list detects a next page at the released maximum limit", async () => {
  const state = await pricingFixture();
  for (let version = 2; version <= 101; version += 1) {
    await state.repository.appendPricingPolicyVersion(policy({
      id: `policy-${String(version).padStart(3, "0")}`,
      version
    }));
  }
  const first = await state.service.list(managerContext(), {
    cursor: null,
    limit: 100,
    sort: "code"
  });
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.notEqual(first.nextAfter, null);
  const second = await state.service.list(managerContext(), {
    cursor: first.nextAfter,
    limit: 100,
    sort: "code"
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
});
