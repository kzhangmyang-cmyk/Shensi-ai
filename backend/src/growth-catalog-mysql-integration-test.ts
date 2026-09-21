import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogItem, PricingPolicyVersion } from "./catalog-domain.js";
import { PackageVersionService } from "./package-version-service.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  requireGrowthCatalogMysqlTestAdminUrl,
  withGrowthCatalogMysqlTestDatabase
} from "./growth-catalog-mysql-test-support.js";

requireGrowthCatalogMysqlTestAdminUrl();

const START = "2026-08-09T08:00:00.000Z";
const END = "2026-09-09T08:00:00.000Z";

function workspace(): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "team-a", kind: "team", actorId: "mysql-admin",
    role: "admin", teamId: "team-a",
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

let commandSequence = 0;
function command(expectedRevision: number | null = null): CommandContext {
  commandSequence += 1;
  return Object.freeze({
    workspace: workspace(), actorId: "mysql-admin",
    idempotencyKey: "mysql-catalog-" + commandSequence,
    requestHash: "sha256:" + String(commandSequence).padStart(64, "0"),
    expectedRevision
  });
}

function item(id: string, type: CatalogItem["type"]): CatalogItem {
  return {
    id, workspaceId: "team-a", type, code: id, name: id, description: null,
    unit: "unit", status: "active", revision: 1, createdBy: "mysql-admin",
    createdAt: START, updatedAt: START
  };
}

function componentPolicy(): PricingPolicyVersion {
  return {
    id: "component-policy", workspaceId: "team-a", catalogItemId: "component",
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
    surchargePolicies: [], giftPolicies: [], validFrom: START, validTo: END,
    status: "active", source: "native",
    capabilityRegistryVersion: "growth-capabilities.v1", revision: 2,
    createdBy: "mysql-admin", createdAt: START
  };
}

test("real MySQL serializes package activation and same-revision patch", async () => {
  await withGrowthCatalogMysqlTestDatabase(async ({
    databaseName, pool, connectionA, connectionB, repository
  }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    await repository.appendCatalogItem(item("package-a", "package"));
    await repository.appendCatalogItem(item("component", "service"));
    await repository.appendPricingPolicyVersion(componentPolicy());
    let id = 0;
    const service = new PackageVersionService({
      repository, idFactory: () => "package-version-" + ++id
    });
    const input = {
      currency: "CNY", validFrom: START, validTo: END,
      components: [{
        componentCatalogItemId: "component",
        componentPricingPolicyVersionId: "component-policy",
        quantityMicros: 1_000_000
      }]
    };
    const [first, second] = await Promise.all([
      service.createDraft(command(1), "package-a", input),
      service.createDraft(command(1), "package-a", input)
    ]);
    const activation = await Promise.all([
      service.activate(command(1), first.id),
      service.activate(command(1), second.id)
    ].map((pending) => pending.then(() => "ok", (error) => String(error.code))));
    assert.deepEqual(activation.sort(), ["ok", "package_window_overlap"]);

    const third = await service.createDraft(command(1), "package-a", {
      ...input, validFrom: END, validTo: null
    });
    const patch = await Promise.all([
      service.updateDraft(command(1), third.id, {
        ...input, validFrom: END, validTo: null
      }),
      service.updateDraft(command(1), third.id, {
        ...input, validFrom: END, validTo: null
      })
    ].map((pending) => pending.then(() => "ok", (error) => String(error.code))));
    assert.deepEqual(patch.sort(), ["ok", "revision_conflict"]);

    const [guardRows] = await pool.query(
      "SELECT workspace_id FROM catalog_package_graph_guards WHERE workspace_id = ?",
      ["team-a"]
    );
    assert.equal((guardRows as unknown[]).length, 1);
    const [tailRows] = await pool.query(
      "SELECT temporal_sequence FROM growth_workspace_temporal_barriers WHERE workspace_id = ?",
      ["team-a"]
    );
    assert.ok(Number((tailRows as Array<Record<string, unknown>>)[0]
      ?.temporal_sequence) > 0);
    console.log("MYSQL_INTEGRATION_EXECUTED:growth-catalog:" + databaseName);
  });
});
