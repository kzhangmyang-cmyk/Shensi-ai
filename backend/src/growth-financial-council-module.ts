import type express from "express";
import type mysql from "mysql2/promise";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import { FinancialCouncilAuthorityReader } from
  "./financial-council-authority-reader.js";
import type { FinancialCouncilRun } from "./financial-council-domain.js";
import { MysqlFinancialCouncilRepository,
  ensureFinancialCouncilMysqlSchema } from
  "./financial-council-mysql-repository.js";
import {
  InMemoryFinancialCouncilRepository,
  type FinancialCouncilRepository
} from "./financial-council-repository.js";
import { createFinancialCouncilRouter } from "./financial-council-router.js";
import { createFinancialCouncilPolicyRouter } from
  "./financial-council-router.js";
import { InMemoryFinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import {
  MysqlFinancialCouncilPolicyRepository,
  ensureFinancialCouncilPolicyMysqlSchema
} from "./financial-council-policy-mysql-repository.js";
import { ensureFinancialCouncilDraftMysqlSchema } from
  "./financial-council-draft-mysql-repository.js";
import { MysqlFinancialCouncilDraftRepository } from
  "./financial-council-draft-mysql-repository.js";
import { InMemoryFinancialCouncilDraftRepository } from
  "./financial-council-draft-repository.js";
import { createFinancialCouncilDispatchRuntime } from
  "./financial-council-dispatch-runtime.js";
import {
  FinancialCouncilService,
  isFinancialCouncilService,
  type FinancialCouncilWakeSink
} from "./financial-council-service.js";
import { FinancialSnapshotBuilder } from "./financial-council-snapshot.js";
import { FinancialCouncilSourceVerifier } from
  "./financial-council-source-verifier.js";
import type { GrowthAdvisorSealedQueryService } from
  "./growth-advisor-query.js";
import { GROWTH_ADVISOR_SERVICES } from "./growth-advisor-module.js";
import type { GrowthCommercialModule } from
  "./growth-commercial-composition.js";
import type { GrowthCommercialToolPorts } from
  "./growth-commercial-application.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import {
  GROWTH_FINANCE_SERVICES,
  type GrowthFinanceServices
} from "./growth-finance-module.js";
import {
  GROWTH_FOUNDATION_SERVICES,
  type GrowthFoundationServices
} from "./growth-foundation-module.js";
import type { WorkspaceVerifiedFinancialLedgerSealedReader } from
  "./financial-ledger-as-of-reader.js";
import { RepositoryVerifiedFinancialLedgerSealedReader } from
  "./financial-ledger-as-of-reader.js";
import { MysqlVerifiedFinancialLedgerSealedReader } from
  "./financial-ledger-as-of-mysql-reader.js";
import { ActiveModelGatewayFinancialCouncilModelPort } from
  "./financial-council-model-gateway.js";
import type { DurableModelRuntimeStore } from "./model-providers/runtime.js";
import { FinancialCouncilSpecialistCoordinator } from
  "./financial-council-specialists.js";
import { FinancialCouncilRebuttalCoordinator } from
  "./financial-council-rebuttal.js";
import {
  DefaultFinancialCouncilAnalysisPipeline,
  FinancialCouncilAnalysisWorker
} from "./financial-council-analysis-worker.js";
import { FinancialCouncilRecoverySweeper } from
  "./financial-council-recovery-sweeper.js";
import {
  FinancialCouncilOptimizationWorker,
  FinancialCouncilPipelineWorker
} from "./financial-council-optimization-worker.js";

export interface GrowthFinancialCouncilServices {
  readonly service: FinancialCouncilService;
}

export interface GrowthFinancialCouncilResources
extends GrowthFinancialCouncilServices {
  readonly relay: Pick<FinancialCouncilWakeRelay, "start" | "sweep" | "close">;
  closeFinancialCouncilResources(): Promise<void>;
}

export const GROWTH_FINANCIAL_COUNCIL_SERVICES:
GrowthPrivateServiceKey<GrowthFinancialCouncilServices> =
  defineGrowthPrivateServiceKey<GrowthFinancialCouncilServices>(
    "growth-financial-council-services"
  );

export interface FinancialCouncilWakeRelayDependencies {
  readonly repository: Pick<FinancialCouncilRepository, "listRunnableRuns">;
  readonly sink: FinancialCouncilWakeSink;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly deliveryTimeoutMs?: number;
  readonly scheduleTimeout?: (
    callback: () => void, milliseconds: number
  ) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
  readonly onError?: (
    error: unknown, runId: string | null
  ) => void | Promise<void>;
}

const TRUSTED_FINANCIAL_COUNCIL_RELAYS = new WeakSet<object>();

export function isFinancialCouncilWakeRelay(
  value: unknown
): value is FinancialCouncilWakeRelay {
  return !!value && typeof value === "object"
    && TRUSTED_FINANCIAL_COUNCIL_RELAYS.has(value);
}

export class FinancialCouncilWakeRelay {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private cursor: { readonly workspaceId: string; readonly runId: string } | null
    = null;
  private closed = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly deliveryTimeoutMs: number;
  private readonly scheduleTimeout: (
    callback: () => void, milliseconds: number
  ) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;

  constructor(private readonly dependencies: FinancialCouncilWakeRelayDependencies) {
    if (typeof dependencies?.repository?.listRunnableRuns !== "function"
      || typeof dependencies?.sink?.wake !== "function") {
      throw new Error("invalid_financial_council_relay");
    }
    this.intervalMs = dependencies.intervalMs ?? 5_000;
    this.batchSize = dependencies.batchSize ?? 25;
    this.deliveryTimeoutMs = dependencies.deliveryTimeoutMs ?? 5_000;
    this.scheduleTimeout = dependencies.scheduleTimeout
      ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.cancelTimeout = dependencies.cancelTimeout
      ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1
      || !Number.isSafeInteger(this.batchSize) || this.batchSize < 1
      || this.batchSize > 100
      || !Number.isSafeInteger(this.deliveryTimeoutMs)
      || this.deliveryTimeoutMs < 1
      || typeof this.scheduleTimeout !== "function"
      || typeof this.cancelTimeout !== "function") {
      throw new Error("invalid_financial_council_relay");
    }
    TRUSTED_FINANCIAL_COUNCIL_RELAYS.add(this);
  }

  start(): void {
    if (this.closed || this.timer) return;
    void this.sweep().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.runSweep().finally(() => { this.active = null; });
    return this.active;
  }

  private async runSweep(): Promise<void> {
    const enumeration = await this.withDeadline(
      () => this.dependencies.repository.listRunnableRuns({
        after: this.cursor,
        limit: this.batchSize
      })
    );
    if (enumeration.kind === "rejected") {
      await this.report(enumeration.error, null);
      return;
    }
    if (enumeration.kind === "timeout") {
      await this.report(
        new Error("financial_council_runnable_enumeration_timeout"), null
      );
      return;
    }
    const runs = enumeration.value;
    if (runs.length === 0) {
      this.cursor = null;
      return;
    }
    for (const run of runs) {
      if (this.closed) return;
      const delivery = await this.withDeadline(
        () => this.dependencies.sink.wake(run)
      );
      if (delivery.kind === "rejected") {
        await this.report(delivery.error, run.runId);
      } else if (delivery.kind === "timeout") {
        await this.report(
          new Error("financial_council_wake_delivery_timeout"), run.runId
        );
      }
      this.cursor = Object.freeze({
        workspaceId: run.workspaceId,
        runId: run.runId
      });
    }
  }

  private async report(error: unknown, runId: string | null): Promise<void> {
    if (!this.dependencies.onError) return;
    await this.withDeadline(() => this.dependencies.onError!(error, runId));
  }

  private async withDeadline<T>(
    operation: () => T | PromiseLike<T>
  ): Promise<
    | { readonly kind: "fulfilled"; readonly value: T }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "timeout" }
  > {
    const guarded = Promise.resolve().then(operation).then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error) => ({ kind: "rejected" as const, error })
    );
    let handle: unknown;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      handle = this.scheduleTimeout(
        () => resolve({ kind: "timeout" }), this.deliveryTimeoutMs
      );
    });
    const outcome = await Promise.race([guarded, timeout]);
    if (outcome.kind !== "timeout") this.cancelTimeout(handle);
    return outcome;
  }

  async close(): Promise<void> {
    if (this.closed) return this.active ?? Promise.resolve();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }
}

export interface GrowthFinancialCouncilModuleOptions {
  readonly mode?: "memory" | "mysql";
  readonly pool?: mysql.Pool;
  readonly wakeSink?: FinancialCouncilWakeSink;
  readonly modelStore?: DurableModelRuntimeStore;
  readonly relayIntervalMs?: number;
  readonly relayBatchSize?: number;
  readonly relayDeliveryTimeoutMs?: number;
  readonly initializeSchema?: () => Promise<void>;
  readonly createResources?: (input: {
    foundation: GrowthFoundationServices;
    advisor: { readonly today: unknown };
    finance: GrowthFinanceServices;
  }) => Promise<GrowthFinancialCouncilResources>;
  readonly createRouter?: typeof createFinancialCouncilRouter;
  readonly createPolicyRouter?: typeof createFinancialCouncilPolicyRouter;
}

function sealedAdvisor(value: unknown): GrowthAdvisorSealedQueryService {
  if (!value || typeof value !== "object"
    || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !["getToday", "getTodayAt", "sealTodayCutoff"].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor
        && typeof descriptor.value === "function";
    })
    || Reflect.ownKeys(value).length !== 3) {
    throw new Error("INVALID_GROWTH_ADVISOR_SEALED_SERVICE");
  }
  const trusted = value as GrowthAdvisorSealedQueryService;
  return Object.freeze({
    getToday: trusted.getToday.bind(trusted),
    getTodayAt: trusted.getTodayAt.bind(trusted),
    sealTodayCutoff: trusted.sealTodayCutoff.bind(trusted)
  });
}

function workspaceFacts(
  value: unknown
): WorkspaceVerifiedFinancialLedgerSealedReader {
  if (!value || typeof value !== "object"
    || (Object.getPrototypeOf(value)
        !== RepositoryVerifiedFinancialLedgerSealedReader.prototype
      && Object.getPrototypeOf(value)
        !== MysqlVerifiedFinancialLedgerSealedReader.prototype)) {
    throw new Error("INVALID_GROWTH_FINANCE_WORKSPACE_READER");
  }
  const trusted = value as WorkspaceVerifiedFinancialLedgerSealedReader;
  for (const key of ["getVerifiedAt", "listVerifiedCostsAt",
    "listVerifiedFactsAt", "listWorkspaceVerifiedFactsAt"] as const) {
    if (typeof trusted[key] !== "function") {
      throw new Error("INVALID_GROWTH_FINANCE_WORKSPACE_READER");
    }
  }
  return Object.freeze({
    getVerifiedAt: trusted.getVerifiedAt.bind(trusted),
    listVerifiedCostsAt: trusted.listVerifiedCostsAt.bind(trusted),
    listVerifiedFactsAt: trusted.listVerifiedFactsAt.bind(trusted),
    listWorkspaceVerifiedFactsAt:
      trusted.listWorkspaceVerifiedFactsAt.bind(trusted)
  });
}

function trustedResources(
  value: unknown
): asserts value is GrowthFinancialCouncilResources {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.isFrozen(value)
    || !TRUSTED_FINANCIAL_COUNCIL_RESOURCES.has(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")
    || (Reflect.ownKeys(value) as string[]).sort().join("\u0000")
      !== ["service", "relay", "closeFinancialCouncilResources"]
        .sort().join("\u0000")) {
    throw new Error("INVALID_GROWTH_FINANCIAL_COUNCIL_RESOURCES");
  }
  const serviceDescriptor = Object.getOwnPropertyDescriptor(value, "service");
  const relayDescriptor = Object.getOwnPropertyDescriptor(value, "relay");
  const closeDescriptor = Object.getOwnPropertyDescriptor(value,
    "closeFinancialCouncilResources");
  const data = (descriptor: PropertyDescriptor | undefined): descriptor is
    PropertyDescriptor & { value: unknown } =>
    descriptor?.enumerable === true && "value" in descriptor;
  if (!data(serviceDescriptor) || !data(relayDescriptor)
    || !data(closeDescriptor)
    || !isFinancialCouncilService(serviceDescriptor.value)
    || !isFinancialCouncilWakeRelay(relayDescriptor.value)
    || typeof closeDescriptor.value !== "function") {
    throw new Error("INVALID_GROWTH_FINANCIAL_COUNCIL_RESOURCES");
  }
}

class IdempotentInProcessWakeSink implements FinancialCouncilWakeSink {
  private readonly pending = new Set<string>();
  async wake(run: FinancialCouncilRun): Promise<void> {
    this.pending.add(run.runId);
  }
}

const TRUSTED_FINANCIAL_COUNCIL_RESOURCES = new WeakSet<object>();

export async function createGrowthFinancialCouncilResources(input: {
  mode: "memory" | "mysql";
  pool?: mysql.Pool;
  foundation: GrowthFoundationServices;
  advisor: { readonly today: unknown };
  finance: GrowthFinanceServices;
  wakeSink?: FinancialCouncilWakeSink;
  modelStore?: DurableModelRuntimeStore;
  relayIntervalMs?: number;
  relayBatchSize?: number;
  relayDeliveryTimeoutMs?: number;
}): Promise<GrowthFinancialCouncilResources> {
  const advisor = sealedAdvisor(input.advisor.today);
  const facts = workspaceFacts(input.finance.verifiedAsOf);
  if (input.mode === "mysql" && !input.pool) {
    throw new Error("GROWTH_FINANCIAL_COUNCIL_POOL_REQUIRED");
  }
  const repository = input.mode === "mysql"
    ? new MysqlFinancialCouncilRepository(input.pool!)
    : new InMemoryFinancialCouncilRepository(
        input.foundation.temporalTransactions
      );
  const policyRepository = input.mode === "mysql"
    ? new MysqlFinancialCouncilPolicyRepository(input.pool!)
    : new InMemoryFinancialCouncilPolicyRepository();
  const draftRepository = input.mode === "mysql"
    ? new MysqlFinancialCouncilDraftRepository(input.pool!)
    : new InMemoryFinancialCouncilDraftRepository();
  const authority = new FinancialCouncilAuthorityReader({
    advisor,
    verifiedFacts: {
      async listVisibleAt(_context, value) {
        return facts.listWorkspaceVerifiedFactsAt(value.cutoff, {
          currency: value.currency,
          limit: value.limit
        });
      }
    }
  });
  const snapshotBuilder = new FinancialSnapshotBuilder({
    cutoffIssuer: advisor,
    authority,
    businessAdvisor: createBusinessAdvisorService()
  });
  const sourceVerifier = typeof input.foundation.acquisitionWorkspace?.resolve
    === "function"
    ? new FinancialCouncilSourceVerifier({
        cutoffIssuer: advisor,
        authority,
        workspaceResolver: input.foundation.acquisitionWorkspace
      })
    : undefined;
  const now = () => new Date().toISOString();
  let worker: FinancialCouncilPipelineWorker | null = null;
  let sweeper: FinancialCouncilRecoverySweeper | null = null;
  let sink = input.wakeSink ?? null;
  if (!sink && input.modelStore) {
    const resolvePolicy = async () => Object.freeze({
      formulaPolicy: Object.freeze({
        formulaPolicyVersion: "financial-council-formula-policy.v1" as const,
        minimumProductMarginBps: 1_000,
        minimumCashReserveMinor: 0
      }),
      actionPolicy: Object.freeze({
        actionCoefficientVersion: "financial-council-actions.v1" as const,
        costRealizationBps: Object.freeze({
          conservative: 2_500, base: 5_000, optimistic: 7_500
        }),
        dataRiskReductionBps: Object.freeze({
          conservative: 500, base: 1_000, optimistic: 1_500
        }),
        taxRiskReductionBps: Object.freeze({
          conservative: 1_000, base: 2_000, optimistic: 3_000
        })
      })
    });
    const model = new ActiveModelGatewayFinancialCouncilModelPort({
      store: input.modelStore
    });
    const specialists = new FinancialCouncilSpecialistCoordinator({
      repository, model, resolvePolicy, now
    });
    const rebuttals = new FinancialCouncilRebuttalCoordinator({
      repository, model, now,
      validateOutput: (_role, output) => output
    });
    const pipeline = new DefaultFinancialCouncilAnalysisPipeline({
      repository, specialists, rebuttals, resolvePolicy, now
    });
    const analysisWorker = new FinancialCouncilAnalysisWorker({
      repository, pipeline,
      workerId: `financial-council-worker-${process.pid}`,
      now,
      leaseDurationMs: 30 * 60_000
    });
    const optimizationWorker = new FinancialCouncilOptimizationWorker({
      repository,
      policyRepository,
      cfo: model,
      workerId: `financial-council-optimizer-${process.pid}`,
      now,
      leaseDurationMs: 30 * 60_000
    });
    worker = new FinancialCouncilPipelineWorker({
      analysis: analysisWorker,
      optimization: optimizationWorker
    });
    sweeper = new FinancialCouncilRecoverySweeper({
      repository, worker, now, intervalMs: 5_000, batchSize: 25,
      onError() {}
    });
    sink = worker;
  }
  sink ??= new IdempotentInProcessWakeSink();
  const dispatch = createFinancialCouncilDispatchRuntime({
    repository,
    drafts: draftRepository,
    workerId: `financial-council-dispatch-${process.pid}`,
    now,
    onError() {}
  });
  const service = new FinancialCouncilService({
    repository, policyRepository, snapshotBuilder, sourceVerifier,
    advisoryWake: sink
  });
  const relay = new FinancialCouncilWakeRelay({
    repository,
    sink,
    intervalMs: input.relayIntervalMs,
    batchSize: input.relayBatchSize,
    deliveryTimeoutMs: input.relayDeliveryTimeoutMs
  });
  const resources = Object.freeze({
    service,
    relay,
    async closeFinancialCouncilResources() {
      await dispatch.close();
      await sweeper?.close();
      await worker?.close();
    }
  });
  TRUSTED_FINANCIAL_COUNCIL_RESOURCES.add(resources);
  dispatch.start();
  sweeper?.start();
  return resources;
}

function missingPrivateService(): Error & { code: string } {
  return Object.assign(new Error("MISSING_GROWTH_PRIVATE_SERVICE"), {
    code: "MISSING_GROWTH_PRIVATE_SERVICE"
  });
}

export function createGrowthFinancialCouncilModule(
  options: GrowthFinancialCouncilModuleOptions
): GrowthCommercialModule {
  let installed = false;
  let closed = false;
  return Object.freeze({
    name: "growth-financial-council",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }) {
      if (installed) {
        throw new Error("GROWTH_FINANCIAL_COUNCIL_MODULE_ALREADY_INSTALLED");
      }
      installed = true;
      let foundation: GrowthFoundationServices;
      let advisor: { readonly today: unknown };
      let finance: GrowthFinanceServices;
      try {
        foundation = input.privateServices.require(GROWTH_FOUNDATION_SERVICES);
        advisor = input.privateServices.require(GROWTH_ADVISOR_SERVICES);
        finance = input.privateServices.require(GROWTH_FINANCE_SERVICES);
      } catch {
        throw missingPrivateService();
      }
      sealedAdvisor(advisor.today);
      workspaceFacts(finance.verifiedAsOf);
      let resources: GrowthFinancialCouncilResources | null = null;
      try {
        if (options.initializeSchema) await options.initializeSchema();
        else if (options.mode === "mysql") {
          if (!options.pool) throw new Error("GROWTH_FINANCIAL_COUNCIL_POOL_REQUIRED");
          await ensureFinancialCouncilMysqlSchema(options.pool);
          await ensureFinancialCouncilPolicyMysqlSchema(options.pool);
          await ensureFinancialCouncilDraftMysqlSchema(options.pool);
        }
        const createdResources = options.createResources
          ? await options.createResources({ foundation, advisor, finance })
          : await createGrowthFinancialCouncilResources({
              mode: options.mode ?? "memory",
              pool: options.pool,
              foundation,
              advisor,
              finance,
              wakeSink: options.wakeSink,
              modelStore: options.modelStore,
              relayIntervalMs: options.relayIntervalMs,
              relayBatchSize: options.relayBatchSize,
              relayDeliveryTimeoutMs: options.relayDeliveryTimeoutMs
            });
        trustedResources(createdResources);
        resources = createdResources;
        const services = Object.freeze({ service: resources.service });
        input.privateServices.provide(
          GROWTH_FINANCIAL_COUNCIL_SERVICES, services
        );
        const routerFactory = options.createRouter
          ?? createFinancialCouncilRouter;
        input.router.use(
          "/api/v1/finance/council-runs",
          routerFactory({
            service: resources.service,
            workspaceContext: foundation.workspaceContext,
            commandContextFactory: foundation.commandContextFactory,
            httpIdempotency: foundation.httpIdempotency
          })
        );
        const policyRouterFactory = options.createPolicyRouter
          ?? createFinancialCouncilPolicyRouter;
        input.router.use(
          "/api/v1/finance/council-policy",
          policyRouterFactory({
            service: resources.service,
            workspaceContext: foundation.workspaceContext,
            commandContextFactory: foundation.commandContextFactory,
            httpIdempotency: foundation.httpIdempotency
          })
        );
        resources.relay.start();
        return {
          async close() {
            if (closed) return;
            closed = true;
            await resources!.relay.close();
            await resources!.closeFinancialCouncilResources();
          }
        };
      } catch (error) {
        if (resources) {
          await resources.relay.close().catch(() => undefined);
          await resources.closeFinancialCouncilResources()
            .catch(() => undefined);
        }
        throw error;
      }
    }
  });
}
