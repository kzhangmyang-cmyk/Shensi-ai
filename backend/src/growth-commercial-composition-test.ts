import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type {
  GrowthTemporalBarrier,
  GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type {
  GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import { createGrowthCommercialApplication } from "./growth-commercial-application.js";
import {
  createGrowthCommercialComposition,
  createGrowthCommercialCompositionForStore
} from "./growth-commercial-composition.js";
import { growthMysqlInstant } from "./growth-temporal-barrier-mysql-repository.js";
import {
  GROWTH_CATALOG_SERVICES,
  type GrowthCatalogServices
} from "./growth-catalog-module.js";
import type { CommissionCatalogProjectionPort } from "./commission-catalog-projection.js";
import {
  GROWTH_QUOTE_ACQUISITION_INTEGRATIONS
} from "./growth-quote-module.js";
import {
  GROWTH_ROI_ACQUISITION_INTEGRATIONS
} from "./growth-roi-module.js";
import {
  GROWTH_FOUNDATION_SERVICES
} from "./growth-foundation-module.js";

function roiIntegration() {
  return Object.freeze({
    authoritativeDiscoveryProjectionWriter: Object.freeze({
      async appendBatchFirst() { return []; }
    })
  });
}

function foundationPorts() {
  const acquisitionWorkspace = Object.freeze({
    resolve: async () => null
  }) as GrowthAcquisitionWorkspaceResolver;
  const temporalBarrier = Object.freeze({
    allocateAppend: async () => ({
      recordedAt: "2026-08-09T08:00:00.000Z",
      temporalSequence: 1
    }),
    sealReadCutoff: async () => {
      throw new Error("not used");
    }
  }) as GrowthTemporalBarrier;
  const temporalTransactions = Object.freeze({
    run: async () => {
      throw new Error("not used");
    }
  }) as GrowthTemporalTransactionRunner;
  return {
    acquisitionWorkspace,
    temporalBarrier,
    temporalTransactions
  };
}

function catalogProjection(): CommissionCatalogProjectionPort {
  return Object.freeze({
    async projectProduct(_context, product) { return product; },
    async assertCommercialPatchAllowed() {}
  });
}

function registryWithCatalog(
  commissionCatalogProjection: CommissionCatalogProjectionPort,
  foundation: ReturnType<typeof foundationPorts> = foundationPorts()
) {
  const registry = createGrowthPrivateServiceRegistry();
  registry.provide(GROWTH_FOUNDATION_SERVICES, Object.freeze({
    httpIdempotency: Object.freeze({}) as never,
    workspaceSettings: Object.freeze({}) as never,
    workspaceContext: Object.freeze({}) as never,
    acquisitionWorkspace: foundation.acquisitionWorkspace,
    temporalTransactions: foundation.temporalTransactions,
    temporalBarrier: foundation.temporalBarrier,
    commandContextFactory: Object.freeze({}) as never
  }) as never);
  registry.provide(GROWTH_CATALOG_SERVICES, Object.freeze({
    catalogItems: {} as GrowthCatalogServices["catalogItems"],
    commissionCatalogProjection
  }));
  registry.provide(GROWTH_QUOTE_ACQUISITION_INTEGRATIONS, Object.freeze({
    probabilityAssessments: Object.freeze({
      async recordFromQualification() { throw new Error("unused"); }
    }),
    quoteProjectedDocumentAuthority: Object.freeze({
      async assertAuthorized() { throw new Error("unused"); }
    })
  }) as never);
  registry.provide(GROWTH_ROI_ACQUISITION_INTEGRATIONS, roiIntegration());
  return registry;
}

test("composition projects exact reference-identical Quote acquisition ports", () => {
  const foundation = foundationPorts();
  const commissionCatalogProjection = catalogProjection();
  const composition = createGrowthCommercialComposition(foundation);
  const registry = registryWithCatalog(commissionCatalogProjection, foundation);
  const privateIntegration = registry.require(
    GROWTH_QUOTE_ACQUISITION_INTEGRATIONS
  );
  const integrations = composition.projectIntegrations(registry);
  assert.deepEqual(composition.modules, []);
  assert.equal(integrations.acquisitionWorkspace, foundation.acquisitionWorkspace);
  assert.equal(integrations.temporalBarrier, foundation.temporalBarrier);
  assert.equal(
    integrations.temporalTransactions,
    foundation.temporalTransactions
  );
  assert.equal(
    integrations.commissionCatalogProjection,
    commissionCatalogProjection
  );
  assert.strictEqual(integrations.probabilityAssessments,
    privateIntegration.probabilityAssessments);
  assert.strictEqual(integrations.quoteProjectedDocumentAuthority,
    privateIntegration.quoteProjectedDocumentAuthority);
  assert.equal(Object.isFrozen(privateIntegration), true);
  assert.equal(Object.isFrozen(integrations), true);
});

test("composition rejects a missing Quote acquisition integration", () => {
  const foundation = foundationPorts();
  const registry = createGrowthPrivateServiceRegistry();
  registry.provide(GROWTH_CATALOG_SERVICES, Object.freeze({
    catalogItems: {} as GrowthCatalogServices["catalogItems"],
    commissionCatalogProjection: catalogProjection()
  }));
  registry.provide(GROWTH_ROI_ACQUISITION_INTEGRATIONS, roiIntegration());
  assert.throws(() => createGrowthCommercialComposition(foundation)
    .projectIntegrations(registry), /growth-quote-acquisition-integrations/u);
});

test("composition rejects a partial Quote acquisition integration", () => {
  const foundation = foundationPorts();
  const registry = createGrowthPrivateServiceRegistry();
  registry.provide(GROWTH_CATALOG_SERVICES, Object.freeze({
    catalogItems: {} as GrowthCatalogServices["catalogItems"],
    commissionCatalogProjection: catalogProjection()
  }));
  registry.provide(GROWTH_QUOTE_ACQUISITION_INTEGRATIONS,
    Object.freeze({ probabilityAssessments: Object.freeze({}) }) as never);
  registry.provide(GROWTH_ROI_ACQUISITION_INTEGRATIONS, roiIntegration());
  assert.throws(() => createGrowthCommercialComposition(foundation)
    .projectIntegrations(registry), /growth_quote_acquisition_integrations/u);
});

test("composition rejects missing Foundation ports before publication", () => {
  const foundation = foundationPorts();
  assert.throws(
    () => createGrowthCommercialComposition({
      acquisitionWorkspace: foundation.acquisitionWorkspace
    } as never),
    /MISSING_GROWTH_TEMPORAL_BARRIER/u
  );
  assert.throws(
    () => createGrowthCommercialComposition({
      temporalBarrier: foundation.temporalBarrier
    } as never),
    /MISSING_GROWTH_ACQUISITION_WORKSPACE/u
  );
});

test("composition factories preserve isolated Foundation identities", () => {
  const first = foundationPorts();
  const second = foundationPorts();
  const firstCatalog = catalogProjection();
  const secondCatalog = catalogProjection();
  const firstProjection = createGrowthCommercialComposition(first)
    .projectIntegrations(registryWithCatalog(firstCatalog, first));
  const secondProjection = createGrowthCommercialComposition(second)
    .projectIntegrations(registryWithCatalog(secondCatalog, second));
  assert.notEqual(firstProjection.acquisitionWorkspace, secondProjection.acquisitionWorkspace);
  assert.notEqual(firstProjection.temporalBarrier, secondProjection.temporalBarrier);
  assert.notEqual(
    firstProjection.commissionCatalogProjection,
    secondProjection.commissionCatalogProjection
  );
});

test("production memory composition installs the council after Advisor", async () => {
  const production = createGrowthCommercialCompositionForStore({
    store: {
      mode: "memory",
      users: [{
        id: "owner-1",
        name: "Owner",
        email: "owner@example.com",
        password: "hash",
        role: "sales",
        teamId: "workspace-1",
        avatar: "",
        status: "active",
        authVersion: 3
      }]
    }
  });
  assert.deepEqual(
    production.composition.modules.map((module) => module.name),
    [
      "growth-foundation",
      "growth-catalog",
      "growth-quote",
      "growth-finance",
      "growth-roi",
      "growth-advisor",
      "growth-financial-council"
    ]
  );
  const runtime = await createGrowthCommercialApplication({
    manifest: { name: "growth-advisor-quote-roi", contractVersion: "1.0.0", contractHash: `sha256:${"a".repeat(64)}`, openapiVersion: "3.1.0" },
    requireAuth: ((_req, _res, next) => next()) as express.RequestHandler,
    workspaceMiddleware: ((_req, _res, next) => next()) as express.RequestHandler,
    enabledFeatures: () => [], composition: production.composition
  });
  try {
    const resolved = await runtime.integrations.acquisitionWorkspace.resolve({ ownerId: "owner-1", teamId: "workspace-1" });
    assert.equal(resolved?.workspaceId, "workspace-1");
    assert.equal(resolved?.bindingRevision, "crm-user-auth:3");
    assert.equal(
      typeof runtime.integrations.commissionCatalogProjection.projectProduct,
      "function"
    );
  } finally {
    await runtime.close();
  }
});

test("production MySQL composition pins DATETIME values to UTC strings", () => {
  let captured: Record<string, unknown> | undefined;
  const production = createGrowthCommercialCompositionForStore({
    store: { mode: "mysql", users: [] },
    databaseUrl: "mysql://user:password@localhost:3306/growth",
    createMysqlPool: (options) => {
      captured = options as Record<string, unknown>;
      return { end: async () => undefined } as never;
    }
  });
  assert.equal(production.composition.modules[0]?.name, "growth-foundation");
  assert.equal(production.composition.modules[1]?.name, "growth-catalog");
  assert.deepEqual(captured, {
    uri: "mysql://user:password@localhost:3306/growth",
    connectionLimit: 4,
    namedPlaceholders: true,
    timezone: "Z",
    dateStrings: true
  });
  assert.equal(growthMysqlInstant("2026-08-09 08:00:30.000"), "2026-08-09T08:00:30.000Z");
});
