import type express from "express";
import type mysql from "mysql2/promise";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import {
  FoundationRoiCommandExecutor,
  type RoiCommandExecutor
} from "./growth-roi-command-executor.js";
import {
  DefaultAcquisitionCohortService
} from "./acquisition-cohort.js";
import {
  InMemoryAcquisitionCohortRepository,
  type AcquisitionCohortRepository
} from "./acquisition-cohort-repository.js";
import type {
  AuthoritativeDiscoveryProjectionWriter,
  AuthoritativeDiscoverySource
} from "./acquisition-authoritative-discovery-projection.js";
import {
  MysqlAuthoritativeDiscoveryProjectionRepository,
  ensureAuthoritativeDiscoveryMysqlSchema
} from "./acquisition-authoritative-discovery-mysql-repository.js";
import { InMemoryAuthoritativeDiscoverySource } from "./acquisition-authoritative-discovery-projection.js";
import {
  DefaultAcquisitionGrowthPerformanceQueryService,
  type GrowthPerformanceDataSource,
  type GrowthPerformanceQueryPage
} from "./acquisition-growth-performance-query.js";
import {
  createAcquisitionGrowthPerformanceRouter
} from "./acquisition-growth-performance-router.js";
import {
  InMemoryRoiClosureRepository
} from "./acquisition-roi-closure-repository.js";
import type {
  RoiClosureVersion
} from "./acquisition-roi-closure.js";
import {
  RoiClosureEvidenceReader,
  type RoiClosureEvidenceSealedReader
} from "./roi-closure-evidence-reader.js";

export interface GrowthRoiAcquisitionIntegrations {
  authoritativeDiscoveryProjectionWriter: AuthoritativeDiscoveryProjectionWriter;
}

export const GROWTH_ROI_ACQUISITION_INTEGRATIONS:
GrowthPrivateServiceKey<GrowthRoiAcquisitionIntegrations> =
  defineGrowthPrivateServiceKey<GrowthRoiAcquisitionIntegrations>(
    "growth-roi-acquisition-integrations"
  );

export interface GrowthRoiDiscoveryServices {
  commandExecutor: RoiCommandExecutor;
  authoritativeDiscoveries: AuthoritativeDiscoverySource;
  acquisitionIntegrations: GrowthRoiAcquisitionIntegrations;
  cohorts: AcquisitionCohortRepository;
  cohortService: DefaultAcquisitionCohortService;
  growthPerformance: DefaultAcquisitionGrowthPerformanceQueryService;
}

export interface GrowthRoiServices {
  readonly growthPerformance: DefaultAcquisitionGrowthPerformanceQueryService;
  readonly closureEvidence: RoiClosureEvidenceSealedReader;
}

export const GROWTH_ROI_SERVICES =
  defineGrowthPrivateServiceKey<GrowthRoiServices>("growth-roi-services");

export const GROWTH_ROI_DISCOVERY_SERVICES:
GrowthPrivateServiceKey<GrowthRoiDiscoveryServices> =
  defineGrowthPrivateServiceKey<GrowthRoiDiscoveryServices>(
    "growth-roi-discovery-services"
  );

export type GrowthRoiModuleOptions = {
  now?: () => string;
} & (
  | { mode: "memory" }
  | { mode: "mysql"; pool: mysql.Pool }
);

export function createGrowthRoiModule(
  options: GrowthRoiModuleOptions
): GrowthCommercialModule {
  let installed = false;
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    name: "growth-roi",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }): Promise<{ close(): Promise<void> }> {
      if (installed) throw new Error("DUPLICATE_GROWTH_ROI_INSTALL");
      installed = true;
      try {
        const foundation = input.privateServices.require(
          GROWTH_FOUNDATION_SERVICES
        );
        let projection: AuthoritativeDiscoveryProjectionWriter
          & AuthoritativeDiscoverySource;
        let cohortRepository: AcquisitionCohortRepository;
        if (options.mode === "mysql") {
          await ensureAuthoritativeDiscoveryMysqlSchema(options.pool);
          const mysqlProjection =
            new MysqlAuthoritativeDiscoveryProjectionRepository(
              options.pool, foundation.temporalBarrier
            );
          projection = mysqlProjection;
          cohortRepository = new InMemoryAcquisitionCohortRepository(
            foundation.temporalTransactions,
            foundation.temporalBarrier
          );
        } else {
          projection = new InMemoryAuthoritativeDiscoverySource();
          cohortRepository = new InMemoryAcquisitionCohortRepository(
            foundation.temporalTransactions,
            foundation.temporalBarrier
          );
        }
        const commandExecutor = new FoundationRoiCommandExecutor({
          foundation,
          now: options.now
        });
        const cohortService = new DefaultAcquisitionCohortService({
          repository: cohortRepository,
          foundation,
          commandExecutor,
          discoveries: projection,
          now: options.now
        });
        const closureRepository = new InMemoryRoiClosureRepository();
        const performanceSource: GrowthPerformanceDataSource = {
          async listCohortMembersAsOf(
            workspaceId,
            cohortId,
            planId,
            cutoff
          ): Promise<GrowthPerformanceQueryPage<any>> {
            const rows = (await cohortRepository.listMembersAt(
              workspaceId, cohortId, cutoff
            )).filter((member) =>
              planId === null || member.firstPlanId === planId);
            return { rows, truncated: false };
          },
          async listCohortMemberSourcesAsOf(
            _workspaceId,
            _cohortMemberIds,
            _cutoff
          ) {
            return { rows: [], truncated: false };
          },
          async selectPublishedClosure() {
            return null;
          },
          async getExactPublishedClosure() {
            return null;
          },
          async readMaterializedSnapshot() {
            return null;
          }
        };
        const growthPerformance =
          new DefaultAcquisitionGrowthPerformanceQueryService(
            performanceSource,
            {
              async listQuoteContributions() {
                return [];
              }
            }
          );
        input.privateServices.provide(GROWTH_ROI_ACQUISITION_INTEGRATIONS,
          Object.freeze({
            authoritativeDiscoveryProjectionWriter: projection
          }));
        input.privateServices.provide(GROWTH_ROI_DISCOVERY_SERVICES,
          Object.freeze({
            commandExecutor,
            authoritativeDiscoveries: projection,
            acquisitionIntegrations: Object.freeze({
              authoritativeDiscoveryProjectionWriter: projection
            }),
            cohorts: cohortRepository,
            cohortService,
            growthPerformance
          }));
        input.privateServices.provide(GROWTH_ROI_SERVICES,
          Object.freeze({
            growthPerformance,
            closureEvidence: new RoiClosureEvidenceReader(closureRepository)
          }));
        input.router.use(createAcquisitionGrowthPerformanceRouter({
          queryService: growthPerformance,
          workspaceContext: foundation.workspaceContext,
          temporalBarrier: foundation.temporalBarrier,
          now: options.now
        }));
        return Object.freeze({
          close: () => closePromise ??= Promise.resolve()
        });
      } catch (error) {
        throw error;
      }
    }
  });
}
