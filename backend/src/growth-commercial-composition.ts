import type express from "express";
import mysql from "mysql2/promise";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import type {
  GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import {
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { GrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver,
  createGrowthWorkspaceMiddleware,
  type GrowthAcquisitionWorkspaceResolver,
  type GrowthWorkspaceDirectory
} from "./growth-workspace-context.js";
import { GROWTH_FOUNDATION_SERVICES, createGrowthFoundationModule } from "./growth-foundation-module.js";
import {
  GROWTH_CATALOG_SERVICES,
  createGrowthCatalogModule
} from "./growth-catalog-module.js";
import type {
  CommissionCatalogProjectionPort
} from "./commission-catalog-projection.js";
import type { CrmStore } from "./store.js";
import {
  GROWTH_QUOTE_ACQUISITION_INTEGRATIONS,
  createGrowthQuoteModule,
  type GrowthQuoteTrustedAuthority
} from "./growth-quote-module.js";
import type { ProbabilityAssessmentWriter } from "./probability-assessment.js";
import type { QuoteProjectedDocumentAuthorityValidator } from "./commercial-authority-guard.js";
import { createGrowthWorkspaceMemberAssignabilityReader } from "./growth-workspace-member-assignability.js";
import { resolveTrustedAcquisitionDealBinding } from "./acquisition-deal-binding.js";
import type { AcquisitionCandidate } from "./acquisition-domain.js";
import { createGrowthFinanceModule } from "./growth-finance-module.js";
import { createGrowthRoiModule } from "./growth-roi-module.js";
import { GROWTH_ROI_ACQUISITION_INTEGRATIONS } from "./growth-roi-module.js";
import {
  createGrowthAdvisorModule,
  createGrowthAdvisorResources
} from "./growth-advisor-module.js";
import { createGrowthFinancialCouncilModule } from
  "./growth-financial-council-module.js";
import {
  CurrentFinanceImportRecoveryAuthorizer
} from "./finance-import-worker.js";
import { GrowthHttpError } from "./growth-command-context.js";

export interface GrowthCommercialModule {
  readonly name: string;
  install(input: {
    router: express.Router;
    toolPorts: GrowthCommercialToolPorts;
    privateServices: GrowthPrivateServiceRegistry;
  }): Promise<{ close(): Promise<void> }>;
}

export interface GrowthCommercialComposition<TIntegrations extends object> {
  modules: readonly GrowthCommercialModule[];
  projectIntegrations(
    privateServices: GrowthPrivateServiceRegistry
  ): TIntegrations;
}

export interface GrowthCommercialCompositionDependencies {
  acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver;
  temporalBarrier?: GrowthTemporalBarrier;
  /** Foundation resource owners installed before future business modules. */
  modules?: readonly GrowthCommercialModule[];
}

export function createGrowthMysqlPool(
  databaseUrl: string,
  createPool: typeof mysql.createPool = mysql.createPool
): mysql.Pool {
  return createPool({
    uri: databaseUrl,
    connectionLimit: 4,
    namedPlaceholders: true,
    timezone: "Z",
    dateStrings: true
  });
}

export interface GrowthAcquisitionIntegrations {
  acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver;
  temporalBarrier: GrowthTemporalBarrier;
  temporalTransactions: GrowthTemporalTransactionRunner;
  commissionCatalogProjection: CommissionCatalogProjectionPort;
  probabilityAssessments: ProbabilityAssessmentWriter;
  quoteProjectedDocumentAuthority: QuoteProjectedDocumentAuthorityValidator;
  authoritativeDiscoveryProjectionWriter: import(
    "./acquisition-authoritative-discovery-projection.js"
  ).AuthoritativeDiscoveryProjectionWriter;
}

export function createGrowthCommercialComposition(
  dependencies: GrowthCommercialCompositionDependencies
): GrowthCommercialComposition<GrowthAcquisitionIntegrations> {
  if (!dependencies?.acquisitionWorkspace) {
    throw new Error("MISSING_GROWTH_ACQUISITION_WORKSPACE");
  }
  if (!dependencies.temporalBarrier && !(dependencies.modules?.length)) {
    throw new Error("MISSING_GROWTH_TEMPORAL_BARRIER");
  }
  const foundation = Object.freeze({ ...dependencies });
  return Object.freeze({
    modules: Object.freeze([
      ...(dependencies.modules ?? [])
    ]) as readonly GrowthCommercialModule[],
    projectIntegrations(privateServices: GrowthPrivateServiceRegistry) {
      const services = privateServices.get(GROWTH_FOUNDATION_SERVICES);
      const catalog = privateServices.require(GROWTH_CATALOG_SERVICES);
      const quoteAcquisition = privateServices.require(
        GROWTH_QUOTE_ACQUISITION_INTEGRATIONS
      );
      const roiIntegration = privateServices.require(
        GROWTH_ROI_ACQUISITION_INTEGRATIONS
      );
      if (!Object.isFrozen(roiIntegration)
        || typeof roiIntegration.authoritativeDiscoveryProjectionWriter
          ?.appendBatchFirst !== "function") {
        throw new Error("invalid_growth_roi_acquisition_integrations");
      }
      if (!Object.isFrozen(quoteAcquisition)
        || !quoteAcquisition.probabilityAssessments
        || typeof quoteAcquisition.probabilityAssessments
          .recordFromQualification !== "function"
        || !quoteAcquisition.quoteProjectedDocumentAuthority
        || typeof quoteAcquisition.quoteProjectedDocumentAuthority
          .assertAuthorized !== "function") {
        throw new Error("invalid_growth_quote_acquisition_integrations");
      }
      const acquisitionWorkspace = services?.acquisitionWorkspace
        ?? foundation.acquisitionWorkspace;
      const temporalBarrier = services?.temporalBarrier
        ?? foundation.temporalBarrier;
      if (!temporalBarrier) throw new Error("MISSING_GROWTH_FOUNDATION_SERVICES");
      const temporalTransactions = services?.temporalTransactions;
      if (!temporalTransactions) {
        throw new Error("MISSING_GROWTH_FOUNDATION_SERVICES");
      }
      return Object.freeze({
        acquisitionWorkspace,
        temporalBarrier,
        temporalTransactions,
        commissionCatalogProjection: catalog.commissionCatalogProjection,
        probabilityAssessments: quoteAcquisition.probabilityAssessments,
        quoteProjectedDocumentAuthority:
          quoteAcquisition.quoteProjectedDocumentAuthority,
        authoritativeDiscoveryProjectionWriter:
          roiIntegration.authoritativeDiscoveryProjectionWriter
      });
    }
  });
}

export function createGrowthCommercialCompositionForStore(options: {
  store: Pick<CrmStore, "mode" | "users"> & Partial<Pick<CrmStore,
    "acquisitionCustomerHandoffs" | "leads" | "customers" | "deals">>;
  findCandidate?: (
    workspaceId: string,
    candidateId: string
  ) => Promise<Pick<AcquisitionCandidate,
    "id" | "ownerId" | "teamId" | "version"> | null>;
  databaseUrl?: string;
  createMysqlPool?: typeof mysql.createPool;
}): {
  composition: GrowthCommercialComposition<GrowthAcquisitionIntegrations>;
  workspaceMiddleware: express.RequestHandler;
} {
  const workspaceDirectory: GrowthWorkspaceDirectory = {
    async canAccess(user, workspaceId) {
      return user.role === "super_admin" && options.store.users.some(
        (candidate) => candidate.status === "active"
          && candidate.teamId === workspaceId
      );
    }
  };
  const acquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      const user = options.store.users.find((candidate) =>
        candidate.status === "active"
        && candidate.id === scope.ownerId
        && candidate.teamId === scope.teamId
      );
      if (!user || scope.teamId === "all") return null;
      return {
        workspaceId: scope.teamId,
        kind: "team" as const,
        bindingRevision: `crm-user-auth:${user.authVersion ?? 1}`
      };
    }
  });
  const acquisitionCustomerHandoffs =
    options.store.acquisitionCustomerHandoffs ?? [];
  const leads = options.store.leads ?? [];
  const customers = options.store.customers ?? [];
  const deals = options.store.deals ?? [];
  const findCandidate = options.findCandidate ?? (async () => null);
  const trustedAuthority: GrowthQuoteTrustedAuthority = {
    assignments: createGrowthWorkspaceMemberAssignabilityReader({
      members: () => options.store.users
    }),
    subjects: Object.freeze({
      async resolve(
        context: import("./growth-workspace-context.js").ActiveWorkspaceContext,
        requested: { candidateId?: string; customerId?: string; dealId?: string }
      ) {
        if (requested.dealId) {
          const trusted = resolveTrustedAcquisitionDealBinding({
            acquisitionCustomerHandoffs,
            leads
          }, { dealId: requested.dealId });
          if (!trusted || trusted.handoff.teamId !== context.workspaceId
            || (requested.candidateId
              && requested.candidateId !== trusted.handoff.candidateId)
            || (requested.customerId
              && requested.customerId !== trusted.handoff.customerId)
            || customers.filter((row) => row.id === trusted.handoff.customerId
              && row.teamId === context.workspaceId).length !== 1
            || deals.filter((row) => row.id === requested.dealId
              && row.customerId === trusted.handoff.customerId
              && row.teamId === context.workspaceId).length !== 1
            || !(await findCandidate(context.workspaceId,
              trusted.handoff.candidateId))) return null;
          return {
            candidateId: trusted.handoff.candidateId,
            customerId: trusted.handoff.customerId,
            dealId: requested.dealId
          };
        }
        const candidate = requested.candidateId
          ? await findCandidate(context.workspaceId, requested.candidateId)
          : null;
        if (requested.candidateId && !candidate) return null;
        const customer = requested.customerId
          ? customers.filter((row) => row.id === requested.customerId
            && row.teamId === context.workspaceId)
          : [];
        if (requested.customerId && customer.length !== 1) return null;
        if (candidate && customer[0]
          && candidate.ownerId !== customer[0].ownerId) return null;
        return {
          candidateId: candidate?.id ?? null,
          customerId: customer[0]?.id ?? null,
          dealId: null
        };
      }
    }),
    commercialBindings: {
      acquisitionCustomerHandoffs,
      leads,
      customers,
      deals,
      findCandidate
    }
  };
  const quoteStore = Array.isArray((options.store as Partial<CrmStore>)
    .tradeDocuments)
    && Array.isArray((options.store as Partial<CrmStore>).dealEvents)
    && typeof (options.store as Partial<CrmStore>)
      .mutateAuthoritativeQuoteProjection === "function"
    ? options.store as CrmStore : undefined;
  const modules: GrowthCommercialModule[] = [];
  let financePool: mysql.Pool | undefined;
  if (options.store.mode === "mysql") {
    const databaseUrl = options.databaseUrl?.trim();
    if (!databaseUrl) throw new Error("GROWTH_DATABASE_URL_REQUIRED");
    const pool = createGrowthMysqlPool(databaseUrl, options.createMysqlPool);
    financePool = pool;
    modules.push(createGrowthFoundationModule({
      mode: "mysql", pool, acquisitionWorkspace, closePool: () => pool.end()
    }));
    modules.push(createGrowthCatalogModule({ mode: "mysql", pool }));
    modules.push(createGrowthQuoteModule({
      mode: "mysql", pool, trustedAuthority, store: quoteStore
    }));
  } else {
    modules.push(createGrowthFoundationModule({ mode: "memory", acquisitionWorkspace }));
    modules.push(createGrowthCatalogModule({ mode: "memory" }));
    modules.push(createGrowthQuoteModule({ mode: "memory", trustedAuthority,
      store: quoteStore }));
  }
  const financeModuleOptions = financePool
    ? {
        mode: "mysql" as const,
        pool: financePool
      }
    : {
        mode: "memory" as const
      };
  modules.push(createGrowthFinanceModule({
    ...financeModuleOptions,
    processWorkerId: `finance-worker-${process.pid}`,
    recoveryAuthorizer: new CurrentFinanceImportRecoveryAuthorizer(
      async (workspaceId, actorId) => {
        const user = options.store.users.find((candidate) =>
          candidate.status === "active"
          && candidate.id === actorId
          && candidate.teamId === workspaceId);
        if (!user) {
          throw new GrowthHttpError(
            403, "finance_import_authority_mismatch"
          );
        }
        return Object.freeze({
          workspaceId,
          kind: "team" as const,
          actorId,
          role: "admin" as const,
          teamId: workspaceId,
          capabilities: Object.freeze([
            "ledger.pending.create" as const,
            "ledger.verify" as const
          ]),
          capabilityRegistryVersion: "growth-capabilities.v1"
        });
      }
    )
  }));
  modules.push(createGrowthRoiModule(
    financePool
      ? { mode: "mysql", pool: financePool }
      : { mode: "memory" }
  ));
  modules.push(createGrowthAdvisorModule({
    createResources: createGrowthAdvisorResources
  }));
  modules.push(createGrowthFinancialCouncilModule(
    financePool
      ? { mode: "mysql", pool: financePool,
          modelStore: options.store as CrmStore }
      : { mode: "memory", modelStore: options.store as CrmStore }
  ));
  return Object.freeze({
    composition: createGrowthCommercialComposition({
      acquisitionWorkspace,
      modules
    }),
    workspaceMiddleware: createGrowthWorkspaceMiddleware(workspaceDirectory)
  });
}
