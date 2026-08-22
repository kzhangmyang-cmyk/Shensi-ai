import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { GROWTH_CATALOG_SERVICES } from "./growth-catalog-module.js";
import {
  GROWTH_PROBABILITY_ASSESSMENTS,
  createGrowthQuoteModule
} from "./growth-quote-module.js";

function registryWithDependencies() {
  const privateServices = createGrowthPrivateServiceRegistry();
  const transactions = new InMemoryGrowthTemporalTransactionRunner();
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  privateServices.provide(GROWTH_FOUNDATION_SERVICES, Object.freeze({
    httpIdempotency: {}, workspaceSettings: {}, workspaceContext: () => null,
    acquisitionWorkspace: { resolve: async () => null },
    commandContextFactory: () => { throw new Error("not used"); },
    temporalTransactions: transactions, temporalBarrier
  }) as never);
  privateServices.provide(GROWTH_CATALOG_SERVICES, Object.freeze({
    catalogItems: {}, pricingPolicies: {}, packageVersions: {},
    quoteCatalog: {}, commissionCatalogProjection: {}
  }) as never);
  return privateServices;
}

test("Quote installs after Foundation and Catalog and provides one assessment authority", async () => {
  const privateServices = registryWithDependencies();
  let created = 0;
  let closed = 0;
  const module = createGrowthQuoteModule({
    mode: "memory",
    resourceFactory(input) {
      created += 1;
      assert.ok(input.temporalTransactions);
      assert.ok(input.temporalBarrier);
      return {
        probabilityAssessments: {} as never,
        async close() { closed += 1; }
      };
    }
  });
  const handle = await module.install({
    router: express.Router(),
    toolPorts: createGrowthCommercialToolPorts(),
    privateServices
  });
  assert.equal(created, 1);
  assert.equal(
    privateServices.require(GROWTH_PROBABILITY_ASSESSMENTS),
    privateServices.require(GROWTH_PROBABILITY_ASSESSMENTS)
  );
  await handle.close();
  await handle.close();
  assert.equal(closed, 1);
});

test("Quote requires both dependency singletons before resource construction", async () => {
  for (const dependency of ["foundation", "catalog"] as const) {
    const complete = registryWithDependencies();
    const privateServices = {
      provide: complete.provide,
      get: complete.get,
      require(key: unknown) {
        if (dependency === "foundation" && key === GROWTH_FOUNDATION_SERVICES) {
          throw new Error("missing foundation");
        }
        if (dependency === "catalog" && key === GROWTH_CATALOG_SERVICES) {
          throw new Error("missing catalog");
        }
        return complete.require(key as never);
      }
    } as never;
    let created = false;
    await assert.rejects(createGrowthQuoteModule({
      mode: "memory",
      resourceFactory() {
        created = true;
        throw new Error("must not construct");
      }
    }).install({
      router: express.Router(),
      toolPorts: createGrowthCommercialToolPorts(),
      privateServices
    }), /missing/u);
    assert.equal(created, false);
  }
});
