import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommissionProductCatalogLink,
  PricingPolicyVersion
} from "./catalog-domain.js";
import type { CatalogRepository } from "./catalog-repository.js";
import {
  CommissionCatalogProjection,
  type CommissionProductPatch
} from "./commission-catalog-projection.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommissionProduct } from "./types.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  applyLegacyCommissionProductPatch,
  LegacyCommissionCatalogBridge
} from "./server.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";

const NOW = "2026-08-09T08:00:00.000Z";

function context(workspaceId = "team-a"): ActiveWorkspaceContext {
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

function superAdminContext(workspaceId = "team-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "super-admin-1",
    role: "super_admin",
    teamId: "all",
    capabilities: capabilitiesForHumanRole("super_admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function product(overrides: Partial<CommissionProduct> = {}): CommissionProduct {
  return {
    id: "commission-product-1",
    catalogItemId: "catalog-item-1",
    catalogMigrationStatus: "migrated",
    name: "Legacy product",
    category: "hardware",
    model: "GJ-1",
    currency: "CNY",
    defaultPrice: 1,
    costPrice: 0.5,
    status: "active",
    remark: "legacy",
    ownerId: "admin-1",
    teamId: "team-a",
    updatedAt: NOW,
    ...overrides
  };
}

function policy(overrides: Partial<PricingPolicyVersion> = {}): PricingPolicyVersion {
  return {
    id: "pricing-policy-1",
    workspaceId: "team-a",
    catalogItemId: "catalog-item-1",
    version: 1,
    packageVersionId: null,
    currency: "USD",
    listUnitPriceMinor: 12_345,
    unitStandardCostMinor: 6_789,
    defaultOrderDeliveryCostMinor: 0,
    defaultOrderSalesCostMinor: 0,
    defaultOrderServiceCostMinor: 0,
    absoluteFloorUnitPriceMinor: 6_789,
    standardDiscountLimitBps: 0,
    absoluteDiscountLimitBps: 0,
    targetGrossMarginBps: 0,
    absoluteMinimumGrossMarginBps: 0,
    standardPaymentTermDays: 0,
    absolutePaymentTermDays: 0,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 0,
      manualEscalationEnabled: false
    },
    surchargePolicies: [],
    giftPolicies: [],
    validFrom: NOW,
    validTo: null,
    status: "active",
    source: "legacy_commission_product",
    capabilityRegistryVersion: "growth-capabilities.v1",
    revision: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    ...overrides
  };
}

function projectionFixture(overrides: {
  link?: CommissionProductCatalogLink | null;
  policy?: PricingPolicyVersion | null;
} = {}) {
  const link = overrides.link === undefined ? {
    workspaceId: "team-a",
    commissionProductId: "commission-product-1",
    catalogItemId: "catalog-item-1",
    pricingPolicyVersionId: "pricing-policy-1",
    migratedAt: NOW
  } satisfies CommissionProductCatalogLink : overrides.link;
  const linkedPolicy = overrides.policy === undefined ? policy() : overrides.policy;
  const repository = {
    async findCommissionProductLink(workspaceId: string, productId: string) {
      return link?.workspaceId === workspaceId
        && link.commissionProductId === productId ? link : null;
    },
    async findPricingPolicyVersion(workspaceId: string, id: string) {
      return linkedPolicy?.workspaceId === workspaceId
        && linkedPolicy.id === id ? linkedPolicy : null;
    }
  } as Pick<CatalogRepository,
    "findCommissionProductLink" | "findPricingPolicyVersion">;
  return { repository, projection: new CommissionCatalogProjection({ repository }) };
}

test("migrated Commission product projects exact linked policy money", async () => {
  const state = projectionFixture();
  const projected = await state.projection.projectProduct(context(), product());
  assert.equal(projected.defaultPrice, 123.45);
  assert.equal(projected.costPrice, 67.89);
  assert.equal(projected.currency, "USD");
  assert.equal(projected.name, "Legacy product");
});

test("migrated money and currency are read-only while noncommercial patches remain allowed", async () => {
  const state = projectionFixture();
  for (const patch of [
    { defaultPrice: 1 },
    { costPrice: 1 },
    { currency: "CNY" },
    Object.assign(Object.create(null), { defaultPrice: undefined })
  ] as CommissionProductPatch[]) {
    await assert.rejects(
      state.projection.assertCommercialPatchAllowed(
        context(), "commission-product-1", patch
      ),
      (error: unknown) =>
        (error as { code?: string; status?: number }).code
          === "catalog_projection_read_only"
        && (error as { status?: number }).status === 409
    );
  }
  await state.projection.assertCommercialPatchAllowed(
    context(),
    "commission-product-1",
    { name: "Renamed", remark: "allowed" }
  );
});

test("projection rejects cross-workspace or mismatched linked policy authority", async () => {
  const crossWorkspace = projectionFixture({
    policy: policy({ workspaceId: "team-b" })
  });
  await assert.rejects(
    crossWorkspace.projection.projectProduct(context(), product()),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
  await assert.rejects(
    crossWorkspace.projection.assertCommercialPatchAllowed(
      context(), "commission-product-1", { name: "must not mutate" }
    ),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
  const mismatched = projectionFixture({
    policy: policy({ catalogItemId: "catalog-item-other" })
  });
  await assert.rejects(
    mismatched.projection.projectProduct(context(), product()),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
});

test("projection rejects a super-admin product workspace mismatch before following its link", async () => {
  let linkReads = 0;
  const repository = {
    async findCommissionProductLink() {
      linkReads += 1;
      return null;
    },
    async findPricingPolicyVersion() {
      throw new Error("policy must not be read");
    }
  } as Pick<CatalogRepository,
    "findCommissionProductLink" | "findPricingPolicyVersion">;
  const projection = new CommissionCatalogProjection({ repository });
  await assert.rejects(
    projection.projectProduct(
      superAdminContext("team-a"),
      product({ teamId: "team-b" })
    ),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code
        === "catalog_projection_inconsistent"
      && (error as { status?: number }).status === 409
  );
  assert.equal(linkReads, 0);
});

test("unlinked legacy products are unchanged and marked migrated products fail closed", async () => {
  const state = projectionFixture({ link: null, policy: null });
  const legacy = product({
    catalogItemId: undefined,
    catalogMigrationStatus: undefined
  });
  assert.equal(await state.projection.projectProduct(context(), legacy), legacy);
  await state.projection.assertCommercialPatchAllowed(
    context(), legacy.id, { defaultPrice: 2 }
  );
  await assert.rejects(
    state.projection.projectProduct(context(), product()),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
});

test("projection taxonomy separates corrupt authority from unavailable dependencies", async () => {
  const invalidMinor = projectionFixture({ policy: policy({ currency: "ZZZ" }) });
  await assert.rejects(
    invalidMinor.projection.projectProduct(context(), product()),
    (error: unknown) =>
      (error as { code?: string; status?: number; retryable?: boolean }).code
        === "catalog_projection_inconsistent"
      && (error as { status?: number }).status === 409
      && (error as { retryable?: boolean }).retryable === false
  );
  const corruptPolicyRepository = {
    async findCommissionProductLink() {
      return {
        workspaceId: "team-a",
        commissionProductId: "commission-product-1",
        catalogItemId: "catalog-item-1",
        pricingPolicyVersionId: "pricing-policy-1",
        migratedAt: NOW
      } satisfies CommissionProductCatalogLink;
    },
    async findPricingPolicyVersion() {
      throw Object.assign(new Error("invalid_pricing_policy_version"), {
        code: "invalid_pricing_policy_version"
      });
    }
  } as Pick<CatalogRepository,
    "findCommissionProductLink" | "findPricingPolicyVersion">;
  const corruptPolicyProjection = new CommissionCatalogProjection({
    repository: corruptPolicyRepository
  });
  await assert.rejects(
    corruptPolicyProjection.projectProduct(context(), product()),
    (error: unknown) =>
      (error as { code?: string; status?: number; retryable?: boolean }).code
        === "catalog_projection_inconsistent"
      && (error as { status?: number }).status === 409
      && (error as { retryable?: boolean }).retryable === false
  );
  const unavailableRepository = {
    async findCommissionProductLink() {
      throw new Error("database unavailable");
    },
    async findPricingPolicyVersion() {
      return null;
    }
  } as Pick<CatalogRepository,
    "findCommissionProductLink" | "findPricingPolicyVersion">;
  const unavailableProjection = new CommissionCatalogProjection({
    repository: unavailableRepository
  });
  await assert.rejects(
    unavailableProjection.projectProduct(context(), product()),
    (error: unknown) =>
      (error as { code?: string; status?: number; retryable?: boolean }).code
        === "catalog_projection_unavailable"
      && (error as { status?: number }).status === 503
      && (error as { retryable?: boolean }).retryable === true
  );
});

async function invokeMiddleware(
  middleware: RequestHandler,
  req: Request
): Promise<void> {
  await new Promise<void>((resolve, reject) => middleware(
    req,
    {} as Response,
    ((error?: unknown) => error ? reject(error) : resolve()) as NextFunction
  ));
}

test("late-bound Commission bridge passes the exact trusted workspace to projection", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const trusted = context();
  let middlewareCalls = 0;
  let projectedContext: ActiveWorkspaceContext | undefined;
  const workspaceMiddleware: RequestHandler = (req, _res, next) => {
    middlewareCalls += 1;
    req.activeWorkspace = trusted;
    next();
  };
  const projection = {
    async projectProduct(active: ActiveWorkspaceContext, value: CommissionProduct) {
      projectedContext = active;
      return value;
    },
    async assertCommercialPatchAllowed(active: ActiveWorkspaceContext) {
      projectedContext = active;
    }
  };
  const uninstall = bridge.install({
    workspaceMiddleware,
    commissionCatalogProjection: projection
  });
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  const current = product();
  assert.deepEqual(await bridge.projectProducts(req, [current]), [current]);
  await bridge.assertCommercialPatchAllowed(req, current, { name: "Renamed" });
  assert.equal(middlewareCalls, 1);
  assert.equal(projectedContext, trusted);
  uninstall();
  assert.equal(await bridge.projectProducts(req, [
    product({ catalogItemId: undefined, catalogMigrationStatus: undefined })
  ]).then((items) => items.length), 1);
});

test("installed bridge scopes super-admin candidates to the exact trusted workspace", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const trusted = superAdminContext("team-a");
  bridge.install({
    workspaceMiddleware(req, _res, next) {
      req.activeWorkspace = trusted;
      next();
    },
    commissionCatalogProjection: {
      async projectProduct(_context, value) {
        return value;
      },
      async assertCommercialPatchAllowed() {}
    }
  });
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  const sameIdWrongWorkspace = product({ teamId: "team-b" });
  const selectedWorkspace = product({ teamId: "team-a", name: "Selected" });
  assert.deepEqual(
    bridge.scopeProducts(req, [sameIdWrongWorkspace, selectedWorkspace]),
    [selectedWorkspace]
  );
});

test("late-bound Commission bridge fails closed for marked products when unavailable", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  await assert.rejects(
    bridge.projectProducts(req, [product()]),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code
        === "catalog_projection_unavailable"
      && (error as { status?: number }).status === 503
  );
  await assert.rejects(
    bridge.assertCommercialPatchAllowed(req, product(), { name: "blocked" }),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_unavailable"
  );
});

test("installed bridge validates a marked projection before allowing any mutation", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const state = projectionFixture({ link: null, policy: null });
  const trusted = context();
  bridge.install({
    workspaceMiddleware(req, _res, next) {
      req.activeWorkspace = trusted;
      next();
    },
    commissionCatalogProjection: state.projection
  });
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  await assert.rejects(
    bridge.assertCommercialPatchAllowed(req, product(), { name: "must not persist" }),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
});

test("legacy patch completes final projection before mutating or persisting", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const trusted = context();
  let projectionCalls = 0;
  bridge.install({
    workspaceMiddleware(req, _res, next) {
      req.activeWorkspace = trusted;
      next();
    },
    commissionCatalogProjection: {
      async projectProduct(_context, value) {
        projectionCalls += 1;
        if (projectionCalls === 2) {
          throw Object.assign(new Error("authority changed"), {
            code: "catalog_projection_inconsistent",
            status: 409
          });
        }
        return value;
      },
      async assertCommercialPatchAllowed() {}
    }
  });
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  const current = product();
  const before = structuredClone(current);
  let persistCalls = 0;
  await assert.rejects(
    applyLegacyCommissionProductPatch({
      bridge,
      req,
      product: current,
      patch: { name: "Must not persist" },
      updatedAt: "2026-08-09T09:00:00.000Z",
      persist: async () => { persistCalls += 1; }
    }),
    (error: unknown) => (error as { code?: string }).code
      === "catalog_projection_inconsistent"
  );
  assert.deepEqual(current, before);
  assert.equal(persistCalls, 0);
});

test("legacy patch persists only after projection and returns that validated projection", async () => {
  const bridge = new LegacyCommissionCatalogBridge();
  const trusted = context();
  const events: string[] = [];
  const validatedProjection = Object.freeze(product({
    name: "Renamed",
    currency: "USD",
    defaultPrice: 123.45,
    costPrice: 67.89,
    updatedAt: "2026-08-09T09:00:00.000Z"
  }));
  let projectionCalls = 0;
  bridge.install({
    workspaceMiddleware(req, _res, next) {
      req.activeWorkspace = trusted;
      next();
    },
    commissionCatalogProjection: {
      async projectProduct(_context, value) {
        projectionCalls += 1;
        events.push(`project-${projectionCalls}`);
        return projectionCalls === 2 ? validatedProjection : value;
      },
      async assertCommercialPatchAllowed() {
        events.push("assert-patch");
      }
    }
  });
  const req = {} as Request;
  await invokeMiddleware(bridge.middleware(), req);
  const current = product();
  const result = await applyLegacyCommissionProductPatch({
    bridge,
    req,
    product: current,
    patch: { name: "Renamed" },
    updatedAt: "2026-08-09T09:00:00.000Z",
    persist: async () => { events.push("persist"); }
  });
  assert.equal(result, validatedProjection);
  assert.equal(current.name, "Renamed");
  assert.deepEqual(events, ["project-1", "assert-patch", "project-2", "persist"]);
});
