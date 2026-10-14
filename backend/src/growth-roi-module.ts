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
import { GROWTH_QUOTE_AUTHORITY_READERS } from "./growth-quote-module.js";
import { GROWTH_FINANCE_SERVICES } from "./growth-finance-module.js";
import { safeSignedInteger } from "./growth-money.js";
import { DefaultFinancialSourceReportService, type FinancialSourceReportService } from "./financial-source-report.js";
import { createFinancialSourceReportRouter } from "./financial-source-report-router.js";
import { RoiClosureService } from "./acquisition-roi-closure.js";
import { RoiClosureInputReader } from "./roi-closure-input-reader.js";
import { RoiClosureRuntimeReader } from "./roi-closure-runtime-reader.js";
import { MysqlVerifiedFinancialLedgerSealedReader } from "./financial-ledger-as-of-mysql-reader.js";
import { ensureFinancialSettlementMysqlSchema, MysqlFinancialSettlementRepository } from "./financial-settlement-allocation-mysql-repository.js";
import { CashSettlementAllocationService, type CashSettlementFactReader } from "./financial-settlement-allocation.js";
import { createCashSettlementAllocationRouter } from "./financial-settlement-allocation-router.js";
import { createRoiClosureRouter } from "./acquisition-roi-closure-router.js";
import { createAttributionAllocationRouter } from "./acquisition-attribution-allocation-router.js";
import { AttributionAllocationService, type AttributionSourceAmountReader } from "./acquisition-attribution-allocation.js";
import { MysqlFinancialLedgerRepository } from "./financial-ledger-mysql-repository.js";
import { RepositoryAcquisitionCostEstimateSealedReader } from "./acquisition-cost-estimate-as-of-reader.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { ensureAttributionAllocationMysqlSchema, MysqlAttributionAllocationRepository } from "./acquisition-attribution-allocation-mysql-repository.js";
import {
  FoundationRoiCommandExecutor,
  type RoiCommandExecutor
} from "./growth-roi-command-executor.js";
import {
  DefaultAcquisitionCohortService
} from "./acquisition-cohort.js";
import {
  createAcquisitionCohortRouter
} from "./acquisition-cohort-router.js";
import {
  InMemoryAcquisitionCohortRepository,
  type AcquisitionCohortRepository
} from "./acquisition-cohort-repository.js";
import { MysqlAcquisitionCohortRepository, ensureAcquisitionCohortMysqlSchema } from "./acquisition-cohort-mysql-repository.js";
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
import { ensureRoiClosureMysqlSchema, MysqlRoiClosureRepository } from "./acquisition-roi-closure-mysql-repository.js";
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
  readonly sourceReports: FinancialSourceReportService;
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
          await ensureAcquisitionCohortMysqlSchema(options.pool);
          const mysqlProjection =
            new MysqlAuthoritativeDiscoveryProjectionRepository(
              options.pool, foundation.temporalBarrier
            );
          projection = mysqlProjection;
          cohortRepository = new MysqlAcquisitionCohortRepository(
            options.pool,
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
        if (options.mode === "mysql") await ensureAttributionAllocationMysqlSchema(options.pool);
        const sourceReports = new DefaultFinancialSourceReportService({
          commandExecutor, now: options.now,
          repository: options.mode === "mysql"
            ? new MysqlAttributionAllocationRepository(options.pool, foundation.temporalBarrier)
            : undefined
        });
        const cohortService = new DefaultAcquisitionCohortService({
          repository: cohortRepository,
          foundation,
          commandExecutor,
          discoveries: projection,
          now: options.now
        });
        if (options.mode === "mysql") await ensureRoiClosureMysqlSchema(options.pool);
        const closureRepository = options.mode === "mysql"
          ? new MysqlRoiClosureRepository(options.pool, foundation.temporalBarrier)
          : new InMemoryRoiClosureRepository();
        if(options.mode==="mysql") {
          await ensureFinancialSettlementMysqlSchema(options.pool);
          const attribution=new MysqlAttributionAllocationRepository(options.pool,foundation.temporalBarrier);
          const ledgerRepository=new MysqlFinancialLedgerRepository(options.pool);
          const verified=new MysqlVerifiedFinancialLedgerSealedReader(options.pool);
          const readAmount:AttributionSourceAmountReader["requireEffectiveAmountMinor"]=async(workspace,type,id)=>{
            const now=(options.now??(()=>new Date().toISOString()))();
            const cutoff=await foundation.temporalBarrier.sealReadCutoff(workspace,now);
            if(type==="source_report") {
              const report=await attribution.getReport(workspace.workspaceId,id);
              if(report && report.createdAt<=cutoff.effectiveAsOf) return report.declaredTotalMinor;
            } else if(type==="cost_estimate") {
              const estimate=await ledgerRepository.getCostEstimate(workspace.workspaceId,id);
              if(estimate) {
                const active=await new RepositoryAcquisitionCostEstimateSealedReader(ledgerRepository).getActiveAt(cutoff,estimate);
                if(active?.id===id) return active.amountMinor;
              }
            } else {
              const raw=type==="cost_entry"?await ledgerRepository.getCostEntry(workspace.workspaceId,id):await ledgerRepository.getFinancialFact(workspace.workspaceId,id);
              if(raw) {
                const row=await verified.getVerifiedAt(cutoff,{ledgerType:type==="cost_entry"?"cost":"financial",entryId:id,currency:raw.currency});
                if(row) return row.netAmountMinor;
              }
            }
            throw new GrowthHttpError(422,"allocation_source_unverified");
          };
          const allocationService=new AttributionAllocationService({repository:attribution,foundation,commandExecutor,
            sources:{requireEffectiveAmountMinor:readAmount},now:options.now});
          input.router.use(createAttributionAllocationRouter({service:allocationService,workspaceContext:foundation.workspaceContext,
            async validate(workspace,draft) {
              await readAmount(workspace,draft.sourceType,draft.sourceId);
              const cutoff=await foundation.temporalBarrier.sealReadCutoff(workspace,(options.now??(()=>new Date().toISOString()))());
              for(const item of draft.items) {
                await cohortRepository.requireActive(workspace.workspaceId,item.cohortId);
                const members=await cohortRepository.listMembersAt(workspace.workspaceId,item.cohortId,cutoff);
                if(item.candidateId!==null && !members.some(m=>m.primaryCandidateId===item.candidateId || m.sources.some(s=>s.candidateId===item.candidateId))) throw new GrowthHttpError(422,"allocation_target_invalid");
                for(const ref of item.evidenceRefs) {
                  let valid=false;
                  if(ref.kind==="cohort_member") valid=members.some(m=>m.id===ref.cohortMemberId);
                  if(ref.kind==="source_report") valid=(await attribution.getReport(workspace.workspaceId,ref.sourceReportId))?.reportHash===ref.reportHash;
                  if(ref.kind==="commercial_binding") {
                    const fact=await ledgerRepository.getFinancialFact(workspace.workspaceId,draft.sourceId);
                    valid=draft.sourceType==="financial_fact" && fact?.dealId===ref.dealId && fact.commercialBindingSnapshot?.bindingHash===ref.bindingHash;
                  }
                  if(ref.kind==="ledger_source") {
                    const raw=ref.ledgerType==="cost"?await ledgerRepository.getCostEntry(workspace.workspaceId,ref.ledgerEntryId):await ledgerRepository.getFinancialFact(workspace.workspaceId,ref.ledgerEntryId);
                    if(raw) valid=(await verified.getVerifiedAt(cutoff,{ledgerType:ref.ledgerType,entryId:ref.ledgerEntryId,currency:raw.currency}))?.evidenceHash===ref.evidenceHash;
                  }
                  if(!valid) throw new GrowthHttpError(422,"allocation_evidence_invalid");
                }
              }
            }
          }));
          const settlement=new MysqlFinancialSettlementRepository(options.pool,foundation.temporalBarrier);
          const facts:CashSettlementFactReader={async requireFact(workspace,id) {
            const raw=await ledgerRepository.getFinancialFact(workspace.workspaceId,id);
            const cutoff=await foundation.temporalBarrier.sealReadCutoff(workspace,(options.now??(()=>new Date().toISOString()))());
            const row=raw?await verified.getVerifiedAt(cutoff,{ledgerType:"financial",entryId:id,currency:raw.currency}):null;
            if(!raw || !row || !raw.dealId || !raw.quoteVersionId || !raw.commercialBindingSnapshot) throw new GrowthHttpError(422,"settlement_fact_unverified");
            return {id:raw.id,factType:raw.factType,dealId:raw.dealId,quoteVersionId:raw.quoteVersionId,
              amountMinor:row.netAmountMinor,currency:raw.currency,commercialBindingSnapshot:raw.commercialBindingSnapshot};
          }};
          input.router.use(createCashSettlementAllocationRouter({repository:settlement,facts,workspaceContext:foundation.workspaceContext,
            service:new CashSettlementAllocationService({repository:settlement,foundation,commandExecutor,facts,now:options.now})}));
          const inputs=new RoiClosureInputReader({
            ledger:new MysqlVerifiedFinancialLedgerSealedReader(options.pool),reports:attribution,attribution,
            settlement
          });
          const service=new RoiClosureService({repository:closureRepository,foundation,commandExecutor,
            reader:new RoiClosureRuntimeReader({inputs,cohorts:cohortRepository}),now:options.now});
          input.router.use(createRoiClosureRouter({service,foundation,now:options.now}));
        }
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
            workspaceId,
            cohortMemberIds,
            cutoff
          ) {
            const ids = new Set(cohortMemberIds);
            const rows = (await cohortRepository.listMemberSources(workspaceId)).filter(row =>
              ids.has(row.cohortMemberId) && row.sourceRecordedAt <= cutoff.effectiveAsOf
              && row.sourceTemporalSequence <= cutoff.temporalSequence
              && row.projectionRecordedAt <= cutoff.effectiveAsOf
              && row.projectionTemporalSequence <= cutoff.temporalSequence
            );
            return { rows, truncated: false };
          },
          async selectPublishedClosure(workspaceId, cohortId, currency, cutoff) {
            const closure = await closureRepository.selectPublishedVersionAt(
              workspaceId, cohortId, currency, cutoff
            );
            return closure ? {closure, truncated:false} : null;
          },
          async getExactPublishedClosure(workspaceId, cohortId, currency, versionId, cutoff) {
            const closure = await closureRepository.selectPublishedVersionAt(
              workspaceId, cohortId, currency, cutoff, versionId
            );
            return closure ? {closure, truncated:false} : null;
          },
          async readMaterializedSnapshot(workspaceId, versionId, sliceKey) {
            return (await closureRepository.listSnapshots(workspaceId, versionId))
              .find(snapshot => snapshot.sliceKey === sliceKey) ?? null;
          }
        };
        const growthPerformance =
          new DefaultAcquisitionGrowthPerformanceQueryService(
            performanceSource,
            {
              async readEstimatedCost(_context, query, cutoff) {
                const reader = input.privateServices.get(GROWTH_FINANCE_SERVICES)?.costEstimates;
                if (!reader) return null;
                const estimates = await reader.listActiveForCohortAt(cutoff, query);
                if (estimates.length === 0) return null;
                return {
                  amountMinor: safeSignedInteger(estimates.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n), "estimatedCost"),
                  estimateIds: estimates.map(row => row.id).sort()
                };
              },
              async listQuoteContributions(context, candidateIds, currency, cutoff) {
                const authority = input.privateServices.get(GROWTH_QUOTE_AUTHORITY_READERS);
                if (!authority) return [];
                const rows = await authority.authoritativeContributions.listContributionsAsOf(
                  context, {candidateIds, currency, cutoff}
                );
                return rows.map(row => ({
                  dealId: row.dealId, approvedGrossProfitMinor: row.approvedQuoteGrossProfitMinor,
                  closeProbabilityBps: row.closeProbabilityBps, quoteVersionId: row.quoteVersionId,
                  probabilityAssessmentId: row.probabilityAssessmentId
                }));
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
            closureEvidence: new RoiClosureEvidenceReader(closureRepository),
            sourceReports
          }));
        input.router.use(createAcquisitionGrowthPerformanceRouter({
          queryService: growthPerformance,
          workspaceContext: foundation.workspaceContext,
          temporalBarrier: foundation.temporalBarrier,
          now: options.now
        }));
        input.router.use(createAcquisitionCohortRouter({
          repository: cohortRepository,
          service: cohortService,
          workspaceContext: foundation.workspaceContext
        }));
        input.router.use(createFinancialSourceReportRouter({service:sourceReports,workspaceContext:foundation.workspaceContext}));
        return Object.freeze({
          close: () => closePromise ??= Promise.resolve()
        });
      } catch (error) {
        throw error;
      }
    }
  });
}
