import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogItem, PricingPolicyVersion } from "./catalog-domain.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import { PackageVersionService } from "./package-version-service.js";
import { PricingPolicyService } from "./pricing-policy-service.js";
import { QuoteCatalogReader } from "./quote-catalog-reader.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const START = "2026-08-01T00:00:00.000Z";
const PACKAGE_END = "2026-08-10T00:00:00.000Z";
const POLICY_END = "2026-09-01T00:00:00.000Z";

function workspace(): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "team-a", kind: "team", actorId: "admin-1", role: "admin",
    teamId: "team-a", capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

let commandNumber = 0;
function command(expectedRevision: number | null = null): CommandContext {
  commandNumber += 1;
  return Object.freeze({
    workspace: workspace(), actorId: "admin-1",
    idempotencyKey: `quote-reader-${commandNumber}`,
    requestHash: `sha256:${String(commandNumber).padStart(64, "0")}`,
    expectedRevision
  });
}

function item(id: string, type: CatalogItem["type"]): CatalogItem {
  return {
    id, workspaceId: "team-a", type, code: id, name: id, description: null,
    unit: "unit", status: "active", revision: 1, createdBy: "admin-1",
    createdAt: START, updatedAt: START
  };
}

function componentPolicy(): PricingPolicyVersion {
  return {
    id: "component-policy", workspaceId: "team-a", catalogItemId: "service-a",
    version: 1, packageVersionId: null, currency: "CNY",
    listUnitPriceMinor: 5_000, unitStandardCostMinor: 1_000,
    defaultOrderDeliveryCostMinor: 0, defaultOrderSalesCostMinor: 0,
    defaultOrderServiceCostMinor: 0, absoluteFloorUnitPriceMinor: 4_000,
    standardDiscountLimitBps: 1_000, absoluteDiscountLimitBps: 2_000,
    targetGrossMarginBps: 3_000, absoluteMinimumGrossMarginBps: 1_000,
    standardPaymentTermDays: 30, absolutePaymentTermDays: 60,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 5_000, manualEscalationEnabled: true
    },
    surchargePolicies: [], giftPolicies: [], validFrom: START,
    validTo: POLICY_END, status: "active", source: "native",
    capabilityRegistryVersion: "growth-capabilities.v1", revision: 2,
    createdBy: "admin-1", createdAt: START
  };
}

async function quoteFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(START);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({ transactions, temporalBarrier });
  await repository.appendCatalogItem(item("package-a", "package"));
  await repository.appendCatalogItem(item("service-a", "service"));
  await repository.appendPricingPolicyVersion(componentPolicy());
  let id = 0;
  const packages = new PackageVersionService({
    repository, idFactory: () => `package-version-${++id}`
  });
  const pricing = new PricingPolicyService({
    repository, idFactory: () => `package-policy-${++id}`
  });
  const draft = await packages.createDraft(command(), "package-a", {
    currency: "CNY", validFrom: START, validTo: PACKAGE_END,
    components: [{
      componentCatalogItemId: "service-a",
      componentPricingPolicyVersionId: "component-policy",
      quantityMicros: 1_000_000
    }]
  });
  const active = await packages.activate(command(1), draft.id);
  const source = componentPolicy();
  const policyDraft = await pricing.createDraft(command(), {
    catalogItemId: "package-a", packageVersionId: active.id, currency: "CNY",
    listUnitPriceMinor: 10_000, unitStandardCostMinor: 2_000,
    defaultOrderDeliveryCostMinor: 0, defaultOrderSalesCostMinor: 0,
    defaultOrderServiceCostMinor: 200, absoluteFloorUnitPriceMinor: 8_000,
    standardDiscountLimitBps: 1_000, absoluteDiscountLimitBps: 2_000,
    targetGrossMarginBps: 3_000, absoluteMinimumGrossMarginBps: 1_000,
    standardPaymentTermDays: 30, absolutePaymentTermDays: 60,
    approvalThresholds: source.approvalThresholds,
    surchargePolicies: [], giftPolicies: [], validFrom: START, validTo: POLICY_END
  });
  const policy = await pricing.activate(command(1), policyDraft.id);
  return {
    repository, active, policy,
    reader: new QuoteCatalogReader({ repository })
  };
}

test("quote effectiveAt is checked against the exact package half-open window", async () => {
  const state = await quoteFixture();
  const inside = await state.reader.resolveAt(workspace(), {
    catalogItemId: "package-a",
    pricingPolicyVersionId: state.policy.id,
    effectiveAt: "2026-08-09T23:59:59.999Z"
  });
  assert.equal(inside.packageVersion?.id, state.active.id);
  assert.equal(inside.packageCostSnapshot?.packageVersionId, state.active.id);
  await assert.rejects(() => state.reader.resolveAt(workspace(), {
    catalogItemId: "package-a",
    pricingPolicyVersionId: state.policy.id,
    effectiveAt: PACKAGE_END
  }), (error: unknown) => (error as { code?: string }).code
    === "package_version_not_effective");
});

test("quote lookup rejects a mismatched or missing frozen package snapshot", async () => {
  const state = await quoteFixture();
  const reader = new QuoteCatalogReader({
    repository: {
      ...state.repository,
      findCatalogItem: state.repository.findCatalogItem.bind(state.repository),
      findPricingPolicyVersion:
        state.repository.findPricingPolicyVersion.bind(state.repository),
      findPackageVersion: state.repository.findPackageVersion.bind(state.repository),
      findPackageCostSnapshot: async () => null
    } as InMemoryCatalogRepository
  });
  await assert.rejects(() => reader.resolveAt(workspace(), {
    catalogItemId: "package-a", pricingPolicyVersionId: state.policy.id,
    effectiveAt: START
  }), (error: unknown) => (error as { code?: string }).code
    === "package_version_not_effective");
});
