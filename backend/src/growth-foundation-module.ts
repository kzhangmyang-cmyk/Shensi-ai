import type express from "express";
import type mysql from "mysql2/promise";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import { InMemoryGrowthHttpIdempotencyRepository, type GrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import { ensureGrowthHttpIdempotencyMysqlSchema, MysqlGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-mysql-repository.js";
import { commandContextFromRequest, type GrowthCommandContextFactory, type GrowthWorkspaceContextResolver } from "./growth-http-preconditions.js";
import { InMemoryGrowthTemporalTransactionRunner, DefaultGrowthTemporalBarrier, type GrowthTemporalBarrier, type GrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";
import { ensureGrowthTemporalBarrierMysqlSchema, MysqlGrowthTemporalBarrier, MysqlGrowthTemporalTransactionRunner } from "./growth-temporal-barrier-mysql-repository.js";
import {
  InMemoryGrowthWorkspaceSettingsRepository,
  type GrowthWorkspaceSettingsReader
} from "./growth-workspace-settings.js";
import { ensureGrowthWorkspaceSettingsMysqlSchema, MysqlGrowthWorkspaceSettingsRepository } from "./growth-workspace-settings-mysql-repository.js";
import {
  assertGrowthAcquisitionWorkspaceResolver,
  type GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

export interface GrowthFoundationServices {
  httpIdempotency: GrowthHttpIdempotencyRepository;
  workspaceSettings: GrowthWorkspaceSettingsReader;
  workspaceContext: GrowthWorkspaceContextResolver;
  acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver;
  temporalTransactions: GrowthTemporalTransactionRunner;
  temporalBarrier: GrowthTemporalBarrier;
  commandContextFactory: GrowthCommandContextFactory;
}

export const GROWTH_FOUNDATION_SERVICES = defineGrowthPrivateServiceKey<GrowthFoundationServices>("growth-foundation-services");

export type GrowthFoundationModuleOptions =
  | { mode: "memory"; acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver }
  | { mode: "mysql"; pool: mysql.Pool; acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver; closePool?: () => Promise<void> };

export function createGrowthFoundationModule(options: GrowthFoundationModuleOptions): GrowthCommercialModule {
  const acquisitionWorkspace = assertGrowthAcquisitionWorkspaceResolver(options.acquisitionWorkspace);
  let installed = false;
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= options.mode === "mysql" ? (options.closePool?.() ?? Promise.resolve()) : Promise.resolve();
    return closePromise;
  };
  return Object.freeze({
    name: "growth-foundation",
    async install(input: { router: express.Router; toolPorts: GrowthCommercialToolPorts; privateServices: GrowthPrivateServiceRegistry }): Promise<{ close(): Promise<void> }> {
      if (installed) throw new Error("DUPLICATE_GROWTH_FOUNDATION_INSTALL");
      installed = true;
      try {
        let httpIdempotency: GrowthHttpIdempotencyRepository;
        let workspaceSettings: GrowthWorkspaceSettingsReader;
        let temporalTransactions: GrowthTemporalTransactionRunner;
        let temporalBarrier: GrowthTemporalBarrier;
        if (options.mode === "mysql") {
          await ensureGrowthHttpIdempotencyMysqlSchema(options.pool);
          await ensureGrowthTemporalBarrierMysqlSchema(options.pool);
          await ensureGrowthWorkspaceSettingsMysqlSchema(options.pool);
          temporalTransactions = new MysqlGrowthTemporalTransactionRunner(
            options.pool
          );
          temporalBarrier = new MysqlGrowthTemporalBarrier(
            temporalTransactions
          );
          httpIdempotency = new MysqlGrowthHttpIdempotencyRepository(options.pool);
          workspaceSettings = new MysqlGrowthWorkspaceSettingsRepository(options.pool, temporalBarrier);
        } else {
          temporalTransactions = new InMemoryGrowthTemporalTransactionRunner();
          temporalBarrier = new DefaultGrowthTemporalBarrier(
            temporalTransactions
          );
          httpIdempotency = new InMemoryGrowthHttpIdempotencyRepository();
          workspaceSettings = new InMemoryGrowthWorkspaceSettingsRepository(
            temporalTransactions,
            temporalBarrier
          );
        }
        const workspaceContext: GrowthWorkspaceContextResolver = (req) => {
          if (!req.activeWorkspace) throw new Error("workspace_required");
          return req.activeWorkspace;
        };
        const services = Object.freeze({
          httpIdempotency,
          workspaceSettings,
          workspaceContext,
          acquisitionWorkspace,
          temporalTransactions,
          temporalBarrier,
          commandContextFactory: commandContextFromRequest
        });
        input.privateServices.provide(GROWTH_FOUNDATION_SERVICES, services);
        return Object.freeze({ close });
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    }
  });
}
