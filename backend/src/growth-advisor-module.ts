import type express from "express";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry,
  type GrowthPrivateServiceKey
} from "./growth-commercial-private-services.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import type { GrowthQuoteAuthorityReaders } from "./growth-quote-module.js";
import { GROWTH_QUOTE_AUTHORITY_READERS } from "./growth-quote-module.js";
import type { GrowthFinanceServices } from "./growth-finance-module.js";
import { GROWTH_FINANCE_SERVICES } from "./growth-finance-module.js";
import type { GrowthRoiServices } from "./growth-roi-module.js";
import { GROWTH_ROI_SERVICES } from "./growth-roi-module.js";
import type {
  GrowthAdvisorQueryService
} from "./growth-advisor-query.js";
import {
  createGrowthAdvisorQueryService,
  DefaultAdvisorVisibilityResolver,
  DefaultPriorityCandidateReader
} from "./growth-advisor-query.js";
import {
  AdvisorRecommendationService,
  AdvisorRecommendationAuthorizer,
  DefaultAdvisorReferenceVerifier
} from "./advisor-recommendation-service.js";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  DefaultAdvisorRecommendationExpirySweeper,
  type AdvisorRecommendationExpirySweeper
} from "./advisor-recommendation-expiry-sweeper.js";
import {
  AdvisorActionDispatcher,
  type AdvisorActionToolPorts
} from "./advisor-action-dispatcher.js";
import {
  InMemoryAdvisorActionOperationRepository
} from "./advisor-action-operation-repository.js";
import {
  AdvisorActionRecoverySweeper,
  type AdvisorActionRecoveryAuthorizer
} from "./advisor-action-recovery-sweeper.js";
import {
  InMemoryAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import {
  createGrowthAdvisorRouter
} from "./growth-advisor-router.js";
import {
  capabilitiesForHumanRole
} from "./growth-capabilities.js";
import {
  createGrowthWorkspaceMemberAssignabilityReader
} from "./growth-workspace-member-assignability.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";
import type {
  AdvisorActionOperation
} from "./advisor-action-operation.js";
import { assertGrowthAsOfNotFuture } from "./growth-as-of.js";

function registerGrowthAdvisorToolHandlers(input: {
  toolPorts: GrowthCommercialToolPorts;
  resources: GrowthAdvisorResources;
  foundation: GrowthFoundationServices;
  finance: GrowthFinanceServices;
  roi: GrowthRoiServices;
  visibility: DefaultAdvisorVisibilityResolver | undefined;
}): void {
  const now = () => new Date().toISOString();
  input.toolPorts.register(
    "get_growth_performance",
    async (raw, command) => {
      const value = raw as {
        currency: string;
        asOf: string;
        planId?: string | null;
        cohortId?: string;
      };
      const effectiveAsOf = assertGrowthAsOfNotFuture(
        value.asOf, now(), 1_000
      );
      const cutoff = await input.foundation.temporalBarrier.sealReadCutoff(
        command.workspace, effectiveAsOf
      );
      if (!value.cohortId) {
        return Object.freeze({
          cohortId: null,
          currency: value.currency,
          planId: value.planId ?? null,
          dataAsOf: cutoff.effectiveAsOf,
          expectedRoiByCurrency: Object.freeze([]),
          actualRoiByCurrency: Object.freeze([]),
          cashByCurrency: Object.freeze([]),
          dataGaps: Object.freeze([]),
          formulaVersion: "growth-performance.v1"
        });
      }
      return input.roi.growthPerformance.getAt(
        command.workspace,
        {
          cohortId: value.cohortId,
          currency: value.currency,
          planId: value.planId ?? null,
          closureVersionId: null
        },
        cutoff
      );
    }
  );
  input.toolPorts.register(
    "list_financial_data_gaps",
    async (raw, command) => {
      const value = raw as { currency: string; asOf: string; limit?: number };
      const effectiveAsOf = assertGrowthAsOfNotFuture(
        value.asOf, now(), 1_000
      );
      const cutoff = await input.foundation.temporalBarrier.sealReadCutoff(
        command.workspace, effectiveAsOf
      );
      if (!input.visibility) {
        throw new Error("advisor_visibility_resolver_required");
      }
      const visibility = await input.visibility.resolveAt(
        command.workspace, cutoff
      );
      return input.finance.financialGaps.listForBindingsAt(
        command.workspace,
        {
          visibility: visibility.financialGapVisibility,
          currency: value.currency,
          cutoff,
          limit: value.limit ?? 100
        }
      );
    }
  );
  input.toolPorts.register(
    "create_advisor_recommendation",
    async (raw, command) => {
      const value = raw as Parameters<
        AdvisorRecommendationService["create"]
      >[1];
      return input.resources.recommendations.create(command, value);
    }
  );
  input.toolPorts.register(
    "create_sales_todo",
    async (raw, command) => {
      const value = raw as { customerId: string; dueAt: string };
      if (!command.workspace.capabilities.includes("catalog.read")) {
        throw Object.assign(new Error("advisor_todo_forbidden"), {
          code: "advisor_todo_forbidden"
        });
      }
      return Object.freeze({
        kind: "sales_todo",
        id: `sales-todo-${command.workspace.workspaceId}-${value.customerId}`,
        customerId: value.customerId,
        dueAt: value.dueAt,
        createdBy: command.actorId,
        createdAt: now()
      });
    }
  );
  input.toolPorts.register(
    "record_recommendation_outcome",
    async (raw, command) => {
      const value = raw as {
        recommendationId: string;
        recommendationRevision: number;
      };
      const child: CommandContext = Object.freeze({
        ...command,
        expectedRevision: value.recommendationRevision
      });
      return input.resources.dispatcher.dispatch(
        child, value.recommendationId
      );
    }
  );
}

export interface GrowthAdvisorServices {
  readonly today: GrowthAdvisorQueryService;
  readonly recommendations: AdvisorRecommendationService;
  readonly dispatcher: AdvisorActionDispatcher;
}

export interface GrowthAdvisorResources extends GrowthAdvisorServices {
  readonly recommendationExpiry: AdvisorRecommendationExpirySweeper;
  readonly actionRecovery: AdvisorActionRecoverySweeper;
  closeAdvisorResources(): Promise<void>;
}

export interface GrowthAdvisorModuleOptions {
  createResources(input: {
    foundation: GrowthFoundationServices;
    quote: GrowthQuoteAuthorityReaders;
    finance: GrowthFinanceServices;
    roi: GrowthRoiServices;
    toolPorts: GrowthCommercialToolPorts;
  }): Promise<GrowthAdvisorResources>;
}

export const GROWTH_ADVISOR_SERVICES:
GrowthPrivateServiceKey<GrowthAdvisorServices> =
  defineGrowthPrivateServiceKey<GrowthAdvisorServices>(
    "growth-advisor-services"
  );

function closeStack() {
  const closers: Array<() => Promise<void>> = [];
  let closed = false;
  return {
    register(closer: () => Promise<void>): void {
      closers.push(closer);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const closer of [...closers].reverse()) {
        await closer().catch(() => undefined);
      }
    }
  };
}

function repairContext(operation: AdvisorActionOperation): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: operation.workspaceId,
    kind: "team",
    actorId: operation.requestingActorId,
    role: "admin",
    teamId: operation.workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function executionContext(operation: AdvisorActionOperation): CommandContext {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: operation.workspaceId,
      kind: "team",
      actorId: operation.requestingActorId,
      role: "manager",
      teamId: operation.workspaceId,
      capabilities: capabilitiesForHumanRole("manager"),
      capabilityRegistryVersion: "growth-capabilities.v1"
    }),
    actorId: operation.requestingActorId,
    idempotencyKey: `advisor-action:${operation.stableActionHash}`,
    requestHash: `sha256:${operation.stableActionHash.slice(7)}`,
    expectedRevision: operation.recommendationRevision
  });
}

export async function createGrowthAdvisorResources(input: {
  foundation: GrowthFoundationServices;
  quote: GrowthQuoteAuthorityReaders;
  finance: GrowthFinanceServices;
  roi: GrowthRoiServices;
  toolPorts: GrowthCommercialToolPorts;
}): Promise<GrowthAdvisorResources> {
  const stack = closeStack();
  const temporalTransactions = input.foundation.temporalTransactions;
  const temporalBarrier = input.foundation.temporalBarrier;
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    temporalTransactions,
    temporalBarrier
  });
  const recommendations = new InMemoryAdvisorRecommendationRepository(
    [], { temporalTransactions, temporalBarrier }
  );
  const actionOperations =
    new InMemoryAdvisorActionOperationRepository({
      temporalTransactions,
      temporalBarrier
    });
  const assignability =
    createGrowthWorkspaceMemberAssignabilityReader({
      members: () => []
    });
  const visibility = new DefaultAdvisorVisibilityResolver({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([]);
      }
    },
    cohortBindings: {
      async listVisibleCohorts() {
        return Object.freeze([]);
      }
    }
  });
  const candidateEvidence = new DefaultPriorityCandidateReader({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([]);
      }
    },
    displayNames: {
      async listDisplayNames() {
        return new Map();
      }
    }
  });
  const verifier = new DefaultAdvisorReferenceVerifier({
    candidateEvidence,
    quote: {
      previews: input.quote.quotePreviews,
      quoteVersions: input.quote.quoteVersions,
      dealAuthoritativeQuotes: input.quote.dealAuthoritativeQuotes
    },
    finance: {
      verifiedAsOf: input.finance.verifiedAsOf,
      financialGaps: input.finance.financialGaps
    },
    roi: {
      growthPerformance: input.roi.growthPerformance,
      closureEvidence: input.roi.closureEvidence
    }
  });
  const authorizer = new AdvisorRecommendationAuthorizer(assignability);
  const recommendationService = new AdvisorRecommendationService({
    repository: recommendations,
    visibility,
    verifier,
    temporalBarrier,
    assignability,
    actionOperations
  });
  const toolPorts: AdvisorActionToolPorts = input.toolPorts;
  const dispatcher = new AdvisorActionDispatcher({
    repository: actionOperations,
    recommendations,
    authorizer,
    toolPorts,
    salesTodoHandler: {
      async probeByStableActionHash() {
        return null;
      },
      async execute() {
        throw new Error("advisor_sales_todo_handler_required");
      }
    }
  });
  const recoveryAuthorizer: AdvisorActionRecoveryAuthorizer = {
    async authorizeProbe(operation) {
      return repairContext(operation);
    },
    async authorizeExecution(operation) {
      return executionContext(operation);
    }
  };
  const recommendationExpiry = new DefaultAdvisorRecommendationExpirySweeper({
    repository: recommendations,
    command(context) {
      return Object.freeze({
        workspace: Object.freeze({
          workspaceId: context.workspaceId,
          kind: "team",
          actorId: context.actorId,
          role: "admin",
          teamId: context.workspaceId,
          capabilities: capabilitiesForHumanRole("admin"),
          capabilityRegistryVersion: "growth-capabilities.v1"
        }),
        actorId: context.actorId,
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
        expectedRevision: null
      });
    },
    now: () => Date.now(),
    onError: () => undefined
  });
  const actionRecovery = new AdvisorActionRecoverySweeper({
    repository: actionOperations,
    authorizer: recoveryAuthorizer,
    salesTodoHandler: {
      async probeByStableActionHash() {
        return null;
      },
      async execute() {
        throw new Error("advisor_sales_todo_handler_required");
      }
    }
  });
  stack.register(async () => {
    await actionRecovery.close();
    await recommendationExpiry.close();
  });
  return Object.freeze({
    visibility,
    today: createGrowthAdvisorQueryService({
      temporalBarrier,
      workspaceSettings: input.foundation.workspaceSettings,
      visibility,
      priorityCandidates: candidateEvidence,
      quoteApprovals: input.quote.quoteApprovals,
      quoteVersions: input.quote.quoteVersions,
      performancePortfolio: {
        async listVisible() {
          return Object.freeze([]);
        }
      },
      financialGaps: input.finance.financialGaps,
      recommendations
    }),
    recommendations: recommendationService,
    dispatcher,
    recommendationExpiry,
    actionRecovery,
    closeAdvisorResources: () => stack.close()
  });
}

export function createGrowthAdvisorModule(
  options: GrowthAdvisorModuleOptions
): GrowthCommercialModule {
  let installed = false;
  let closed = false;
  return Object.freeze({
    name: "growth-advisor",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }): Promise<{ close(): Promise<void> }> {
      if (installed) throw new Error("GROWTH_ADVISOR_MODULE_ALREADY_INSTALLED");
      installed = true;
      const { privateServices, router, toolPorts } = input;
      let foundation: GrowthFoundationServices;
      let quote: GrowthQuoteAuthorityReaders;
      let finance: GrowthFinanceServices;
      let roi: GrowthRoiServices;
      try {
        foundation = privateServices.require(GROWTH_FOUNDATION_SERVICES);
      } catch {
        throw Object.assign(
          new Error("MISSING_GROWTH_PRIVATE_SERVICE"),
          { code: "MISSING_GROWTH_PRIVATE_SERVICE" }
        );
      }
      try {
        quote = privateServices.require(GROWTH_QUOTE_AUTHORITY_READERS);
      } catch {
        throw Object.assign(
          new Error("MISSING_GROWTH_PRIVATE_SERVICE"),
          { code: "MISSING_GROWTH_PRIVATE_SERVICE" }
        );
      }
      try {
        finance = privateServices.require(GROWTH_FINANCE_SERVICES);
      } catch {
        throw Object.assign(
          new Error("MISSING_GROWTH_PRIVATE_SERVICE"),
          { code: "MISSING_GROWTH_PRIVATE_SERVICE" }
        );
      }
      try {
        roi = privateServices.require(GROWTH_ROI_SERVICES);
      } catch {
        throw Object.assign(
          new Error("MISSING_GROWTH_PRIVATE_SERVICE"),
          { code: "MISSING_GROWTH_PRIVATE_SERVICE" }
        );
      }
      let resources: GrowthAdvisorResources | null = null;
      try {
        resources = await options.createResources({
          foundation, quote, finance, roi, toolPorts
        });
        const services: GrowthAdvisorServices = Object.freeze({
          today: resources.today,
          recommendations: resources.recommendations,
          dispatcher: resources.dispatcher
        });
        privateServices.provide(GROWTH_ADVISOR_SERVICES, services);
        registerGrowthAdvisorToolHandlers({
          toolPorts,
          resources,
          foundation,
          finance,
          roi,
          visibility: (resources as {
            visibility?: DefaultAdvisorVisibilityResolver;
          }).visibility
        });
        router.use(
          "/api/v1/acquisition/advisor",
          createGrowthAdvisorRouter({
            today: services.today,
            recommendations: services.recommendations,
            workspaceContext: foundation.workspaceContext,
            commandContextFactory: foundation.commandContextFactory,
            httpIdempotency: foundation.httpIdempotency
          })
        );
        resources.recommendationExpiry.start();
        resources.actionRecovery.start();
        return {
          close: () => {
            if (closed) return Promise.resolve();
            closed = true;
            return resources!.closeAdvisorResources();
          }
        };
      } catch (error) {
        if (resources !== null) {
          await resources.closeAdvisorResources().catch(() => undefined);
        }
        throw error;
      }
    }
  });
}
