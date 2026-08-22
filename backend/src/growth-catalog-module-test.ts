import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import "./auth.js";
import type { CatalogRepository } from "./catalog-repository.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import {
  GROWTH_CATALOG_SERVICES,
  createGrowthCatalogModule,
  type GrowthCatalogModuleOptions
} from "./growth-catalog-module.js";
import {
  createGrowthCommercialApplication,
  createGrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import {
  createGrowthPrivateServiceRegistry,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import {
  GROWTH_FOUNDATION_SERVICES,
  type GrowthFoundationServices
} from "./growth-foundation-module.js";
import {
  InMemoryGrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";

function foundation(): GrowthFoundationServices {
  const temporalTransactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const temporalBarrier = new DefaultGrowthTemporalBarrier(temporalTransactions);
  const workspaceContext: GrowthFoundationServices["workspaceContext"] = (req) => {
    if (!req.activeWorkspace) throw new Error("workspace_required");
    return req.activeWorkspace;
  };
  return Object.freeze({
    httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
    workspaceSettings: {
      getAt: async () => ({ timezone: "Asia/Shanghai" })
    } as never,
    workspaceContext,
    acquisitionWorkspace: { resolve: async () => null } as never,
    temporalTransactions,
    temporalBarrier,
    commandContextFactory: commandContextFromRequest
  });
}

function installedRegistry(foundationServices: GrowthFoundationServices) {
  const privateServices = createGrowthPrivateServiceRegistry();
  privateServices.provide(GROWTH_FOUNDATION_SERVICES, foundationServices);
  return privateServices;
}

test("Catalog module wires the exact Foundation singletons into one shared graph", async () => {
  const ports = foundation();
  const privateServices = installedRegistry(ports);
  const captured: Record<string, unknown> = {};
  let closeCount = 0;
  const module = createGrowthCatalogModule({
    mode: "memory",
    idFactory: () => "catalog-item-1",
    async resourceFactory(input) {
      captured.resourceInput = input;
      return {
        repository: new InMemoryCatalogRepository({
          transactions: input.temporalTransactions,
          temporalBarrier: input.temporalBarrier
        }),
        async close() { closeCount += 1; }
      };
    },
    mountRouter(router, catalogRouter, options) {
      captured.mountRouter = router;
      captured.catalogRouter = catalogRouter;
      captured.routerOptions = options;
      router.use("/api/v1/catalog", catalogRouter);
    }
  });
  const router = express.Router();
  const handle = await module.install({
    router,
    toolPorts: createGrowthCommercialToolPorts(),
    privateServices
  });
  const services = privateServices.require(GROWTH_CATALOG_SERVICES);
  const resourceInput = captured.resourceInput as {
    temporalTransactions: unknown;
    temporalBarrier: unknown;
  };
  const routerOptions = captured.routerOptions as {
    catalogService: unknown;
    pricingPolicyService: unknown;
    packageVersionService: unknown;
    httpIdempotency: unknown;
    workspaceContext: unknown;
    commandContextFactory: unknown;
  };
  assert.equal(resourceInput.temporalTransactions, ports.temporalTransactions);
  assert.equal(resourceInput.temporalBarrier, ports.temporalBarrier);
  assert.equal(routerOptions.httpIdempotency, ports.httpIdempotency);
  assert.equal(routerOptions.workspaceContext, ports.workspaceContext);
  assert.equal(routerOptions.commandContextFactory, ports.commandContextFactory);
  assert.equal(routerOptions.catalogService, services.catalogItems);
  assert.equal(routerOptions.pricingPolicyService, services.pricingPolicies);
  assert.equal(routerOptions.packageVersionService, services.packageVersions);
  assert.deepEqual(Object.keys(services).sort(), [
    "catalogItems", "commissionCatalogProjection", "packageVersions",
    "pricingPolicies", "quoteCatalog"
  ]);
  assert.equal(Object.isFrozen(services), true);
  assert.equal(Object.isFrozen(services.catalogItems), true);
  assert.equal(Object.isFrozen(services.pricingPolicies), true);
  assert.equal(Object.isFrozen(services.packageVersions), true);
  assert.equal(Object.isFrozen(services.quoteCatalog), true);
  assert.equal(Object.isFrozen(services.commissionCatalogProjection), true);
  const serviceRepository = (services.catalogItems as unknown as {
    options: { repository: CatalogRepository }
  }).options.repository;
  const projectionRepository = (services.commissionCatalogProjection as unknown as {
    options: { repository: CatalogRepository }
  }).options.repository;
  const pricingRepository = (services.pricingPolicies as unknown as {
    options: { repository: CatalogRepository }
  }).options.repository;
  const packageRepository = (services.packageVersions as unknown as {
    options: { repository: CatalogRepository }
  }).options.repository;
  const quoteRepository = (services.quoteCatalog as unknown as {
    options: { repository: CatalogRepository }
  }).options.repository;
  assert.equal(serviceRepository, projectionRepository);
  assert.equal(serviceRepository, pricingRepository);
  assert.equal(serviceRepository, packageRepository);
  assert.equal(serviceRepository, quoteRepository);
  await handle.close();
  await handle.close();
  assert.equal(closeCount, 1);
  await assert.rejects(
    module.install({
      router,
      toolPorts: createGrowthCommercialToolPorts(),
      privateServices
    }),
    /DUPLICATE_GROWTH_CATALOG_INSTALL/u
  );
});

test("Catalog module closes current resources when provide or mount fails", async () => {
  for (const failure of ["provide", "mount"] as const) {
    const ports = foundation();
    let closeCount = 0;
    const module = createGrowthCatalogModule({
      mode: "memory",
      async resourceFactory(input) {
        return {
          repository: new InMemoryCatalogRepository({
            transactions: input.temporalTransactions,
            temporalBarrier: input.temporalBarrier
          }),
          async close() { closeCount += 1; }
        };
      },
      mountRouter(router, catalogRouter) {
        if (failure === "mount") throw new Error("mount failed");
        router.use("/api/v1/catalog", catalogRouter);
      }
    });
    const privateServices = {
      provide(key, value) {
        if (failure === "provide") throw new Error("provide failed");
        void [key, value];
      },
      require(key) {
        if (key === GROWTH_FOUNDATION_SERVICES) return ports;
        throw new Error("missing");
      },
      get() { return null; }
    } as GrowthPrivateServiceRegistry;
    await assert.rejects(module.install({
      router: express.Router(),
      toolPorts: createGrowthCommercialToolPorts(),
      privateServices
    }), new RegExp(`${failure} failed`, "u"));
    assert.equal(closeCount, 1);
  }
});

test("Catalog install failures close current resources then prior module handles", async () => {
  for (const failure of ["provide", "mount"] as const) {
    const ports = foundation();
    const events: string[] = [];
    const catalog = createGrowthCatalogModule({
      mode: "memory",
      async resourceFactory(input) {
        return {
          repository: new InMemoryCatalogRepository({
            transactions: input.temporalTransactions,
            temporalBarrier: input.temporalBarrier
          }),
          async close() { events.push("catalog-close"); }
        };
      },
      mountRouter(router, catalogRouter) {
        if (failure === "mount") throw new Error("mount failed");
        router.use("/api/v1/catalog", catalogRouter);
      }
    });
    const prior = {
      name: "growth-foundation",
      async install(input: {
        privateServices: GrowthPrivateServiceRegistry;
      }) {
        input.privateServices.provide(GROWTH_FOUNDATION_SERVICES, ports);
        return {
          async close() { events.push("foundation-close"); }
        };
      }
    };
    const createPrivateServices = failure === "provide" ? () => {
      const base = createGrowthPrivateServiceRegistry();
      return Object.freeze({
        provide<T>(key: Parameters<GrowthPrivateServiceRegistry["provide"]>[0], value: T) {
          if (key === GROWTH_CATALOG_SERVICES) throw new Error("provide failed");
          base.provide(key, value);
        },
        require: base.require,
        get: base.get
      }) as GrowthPrivateServiceRegistry;
    } : undefined;
    await assert.rejects(createGrowthCommercialApplication({
      manifest: loadGrowthContractRelease().manifest,
      requireAuth: ((_req, _res, next) => next()) as express.RequestHandler,
      workspaceMiddleware: ((_req, _res, next) => next()) as express.RequestHandler,
      enabledFeatures: () => ["catalog"],
      composition: {
        modules: [prior as never, catalog],
        projectIntegrations() { throw new Error("must not project"); }
      },
      createPrivateServices
    }), new RegExp(`${failure} failed`, "u"));
    assert.deepEqual(events, ["catalog-close", "foundation-close"]);
  }
});

const strictMemoryOptions: GrowthCatalogModuleOptions = { mode: "memory" };
const invalidWorkspaceOptions: GrowthCatalogModuleOptions = {
  mode: "memory",
  // @ts-expect-error Foundation workspace identity cannot be replaced by Catalog options
  workspaceContext: () => { throw new Error("lookalike"); }
};
const invalidTemporalOptions: GrowthCatalogModuleOptions = {
  mode: "memory",
  // @ts-expect-error Foundation temporal authority cannot be replaced by Catalog options
  temporalBarrier: {}
};
void [strictMemoryOptions, invalidWorkspaceOptions, invalidTemporalOptions];

test("Catalog module options reject request-context and temporal lookalikes", () => {
  execFileSync(fileURLToPath(new URL(
    "../../node_modules/.bin/tsc",
    import.meta.url
  )), [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--esModuleInterop",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    fileURLToPath(import.meta.url)
  ], { stdio: "pipe" });
});
