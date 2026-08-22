import { randomUUID } from "node:crypto";
import type express from "express";
import type mysql from "mysql2/promise";
import { CatalogService } from "./catalog-service.js";
import { PricingPolicyService } from "./pricing-policy-service.js";
import { PackageVersionService } from "./package-version-service.js";
import { QuoteCatalogReader } from "./quote-catalog-reader.js";
import {
  InMemoryCatalogRepository,
  type CatalogRepository
} from "./catalog-repository.js";
import {
  ensureCatalogMysqlSchema,
  MysqlCatalogRepository
} from "./catalog-mysql-repository.js";
import {
  CommissionCatalogProjection,
  type CommissionCatalogProjectionPort
} from "./commission-catalog-projection.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import {
  GROWTH_FOUNDATION_SERVICES,
  type GrowthFoundationServices
} from "./growth-foundation-module.js";
import type { GrowthTemporalBarrier, GrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";
import { createCatalogRouter, type CatalogRouterOptions } from "./catalog-router.js";

export interface GrowthCatalogServices {
  readonly catalogItems: CatalogService;
  readonly pricingPolicies: PricingPolicyService;
  readonly packageVersions: PackageVersionService;
  readonly quoteCatalog: QuoteCatalogReader;
  readonly commissionCatalogProjection: CommissionCatalogProjectionPort;
}

export const GROWTH_CATALOG_SERVICES =
  defineGrowthPrivateServiceKey<GrowthCatalogServices>(
    "growth-catalog-services"
  );

export interface GrowthCatalogResourceFactoryInput {
  mode: "memory" | "mysql";
  pool?: mysql.Pool;
  workspaceSettings: GrowthFoundationServices["workspaceSettings"];
  temporalTransactions: GrowthTemporalTransactionRunner;
  temporalBarrier: GrowthTemporalBarrier;
}

export interface GrowthCatalogResourceHandle {
  repository: CatalogRepository;
  close(): Promise<void>;
}

interface GrowthCatalogModuleHooks {
  idFactory?: (prefix: string) => string;
  resourceFactory?: (
    input: GrowthCatalogResourceFactoryInput
  ) => Promise<GrowthCatalogResourceHandle>;
  mountRouter?: (
    router: express.Router,
    catalogRouter: express.Router,
    options: CatalogRouterOptions
  ) => void;
}

export type GrowthCatalogModuleOptions = GrowthCatalogModuleHooks & (
  | { mode: "memory" }
  | { mode: "mysql"; pool: mysql.Pool }
);

async function createDefaultResources(
  options: GrowthCatalogModuleOptions,
  foundation: GrowthFoundationServices
): Promise<GrowthCatalogResourceHandle> {
  if (options.mode === "mysql") {
    await ensureCatalogMysqlSchema(options.pool);
    return {
      repository: new MysqlCatalogRepository(
        options.pool,
        foundation.temporalBarrier
      ),
      async close() {}
    };
  }
  return {
    repository: new InMemoryCatalogRepository({
      transactions: foundation.temporalTransactions,
      temporalBarrier: foundation.temporalBarrier
    }),
    async close() {}
  };
}

export function createGrowthCatalogModule(
  options: GrowthCatalogModuleOptions
): GrowthCommercialModule {
  let installed = false;
  return Object.freeze({
    name: "growth-catalog",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }): Promise<{ close(): Promise<void> }> {
      if (installed) throw new Error("DUPLICATE_GROWTH_CATALOG_INSTALL");
      installed = true;
      const foundation = input.privateServices.require(
        GROWTH_FOUNDATION_SERVICES
      );
      let resources: GrowthCatalogResourceHandle | null = null;
      let closePromise: Promise<void> | null = null;
      const close = () => {
        closePromise ??= resources?.close() ?? Promise.resolve();
        return closePromise;
      };
      try {
        resources = options.resourceFactory
          ? await options.resourceFactory({
              mode: options.mode,
              ...(options.mode === "mysql" ? { pool: options.pool } : {}),
              workspaceSettings: foundation.workspaceSettings,
              temporalTransactions: foundation.temporalTransactions,
              temporalBarrier: foundation.temporalBarrier
            })
          : await createDefaultResources(options, foundation);
        const catalogItems = new CatalogService({
          repository: resources.repository,
          idFactory: options.idFactory
            ?? ((prefix) => `${prefix}-${randomUUID()}`)
        });
        Object.freeze(catalogItems);
        const pricingPolicies = new PricingPolicyService({
          repository: resources.repository,
          idFactory: options.idFactory
            ?? ((prefix) => `${prefix}-${randomUUID()}`)
        });
        Object.freeze(pricingPolicies);
        const packageVersions = new PackageVersionService({
          repository: resources.repository,
          idFactory: options.idFactory
            ?? ((prefix) => `${prefix}-${randomUUID()}`)
        });
        Object.freeze(packageVersions);
        const quoteCatalog = new QuoteCatalogReader({
          repository: resources.repository
        });
        Object.freeze(quoteCatalog);
        const commissionCatalogProjection = new CommissionCatalogProjection({
          repository: resources.repository
        });
        Object.freeze(commissionCatalogProjection);
        const services = Object.freeze({
          catalogItems,
          pricingPolicies,
          packageVersions,
          quoteCatalog,
          commissionCatalogProjection
        }) satisfies GrowthCatalogServices;
        const routerOptions: CatalogRouterOptions = Object.freeze({
          catalogService: catalogItems,
          pricingPolicyService: pricingPolicies,
          packageVersionService: packageVersions,
          httpIdempotency: foundation.httpIdempotency,
          workspaceContext: foundation.workspaceContext,
          commandContextFactory: foundation.commandContextFactory
        });
        const catalogRouter = createCatalogRouter(routerOptions);
        input.privateServices.provide(GROWTH_CATALOG_SERVICES, services);
        (options.mountRouter ?? ((router, mounted) => {
          router.use("/api/v1/catalog", mounted);
        }))(input.router, catalogRouter, routerOptions);
        return Object.freeze({ close });
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    }
  });
}
