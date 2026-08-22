import type express from "express";
import type mysql from "mysql2/promise";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import {
  createAcquisitionCostLedgerRouter
} from "./acquisition-cost-ledger-router.js";
import { FinancialFactLedgerService } from "./financial-fact-ledger.js";
import { createFinancialFactRouter } from "./financial-fact-router.js";
import { FinanceImportService } from "./finance-import-service.js";
import {
  createFinanceImportRouter
} from "./finance-import-router.js";
import {
  InMemoryFinanceImportRepository
} from "./finance-import-repository.js";
import {
  MysqlFinanceImportRepository
} from "./finance-import-mysql-repository.js";
import {
  FinanceImportWorker
} from "./finance-import-worker.js";
import {
  DefaultFinanceImportRecoverySweeper
} from "./finance-import-recovery-sweeper.js";
import {
  InMemoryFinancialLedgerRepository,
  type FinancialLedgerRepository
} from "./financial-ledger-repository.js";
import {
  MysqlFinancialLedgerRepository
} from "./financial-ledger-mysql-repository.js";
import {
  MysqlVerifiedFinancialLedgerSealedReader
} from "./financial-ledger-as-of-mysql-reader.js";
import {
  RepositoryVerifiedFinancialLedgerSealedReader,
  type VerifiedFinancialLedgerSealedReader
} from "./financial-ledger-as-of-reader.js";
import {
  type FinancialDataGapSealedReader
} from "./financial-data-gap-reader.js";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { GROWTH_QUOTE_AUTHORITY_READERS } from "./growth-quote-module.js";
import type { FinanceImportRecoveryAuthorizer } from "./finance-import-worker.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { DealAuthoritativeQuoteReader } from "./authoritative-quote-reader.js";
import { ensureFinanceImportMysqlSchema } from "./finance-import-mysql-repository.js";

export interface GrowthFinanceServices {
  readonly costLedger: AcquisitionCostLedgerService;
  readonly financialFacts: FinancialFactLedgerService;
  readonly imports: FinanceImportService;
  readonly verifiedAsOf: VerifiedFinancialLedgerSealedReader;
  readonly financialGaps: FinancialDataGapSealedReader;
}

export const GROWTH_FINANCE_SERVICES =
  defineGrowthPrivateServiceKey<GrowthFinanceServices>(
    "growth-finance-services"
  );

export type GrowthFinanceModuleOptions = {
  recoveryAuthorizer: FinanceImportRecoveryAuthorizer;
  processWorkerId: string;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  now?: () => string;
  onRecoveryError?: (error: unknown, operationId: string | null) => void;
  startRecovery?: boolean;
} & (
  | { mode: "memory" }
  | { mode: "mysql"; pool: mysql.Pool }
);

class EmptyFinancialDataGapSealedReader implements FinancialDataGapSealedReader {
  async listForBindingsAt() {
    return Object.freeze([]);
  }

  async verifyAt() {
    return null;
  }
}

export function createGrowthFinanceModule(
  options: GrowthFinanceModuleOptions
): GrowthCommercialModule {
  let installed = false;
  let worker: FinanceImportWorker | null = null;
  let sweeper: DefaultFinanceImportRecoverySweeper | null = null;
  let closePromise: Promise<void> | null = null;
  const close = async () => {
    await worker?.close();
    if (sweeper) await sweeper.close();
  };
  return Object.freeze({
    name: "growth-finance",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }): Promise<{ close(): Promise<void> }> {
      if (installed) throw new Error("DUPLICATE_GROWTH_FINANCE_INSTALL");
      installed = true;
      try {
        const foundation = input.privateServices.require(
          GROWTH_FOUNDATION_SERVICES
        );
        const quoteAuthority = input.privateServices.require(
          GROWTH_QUOTE_AUTHORITY_READERS
        );
        const bindingVerifier: Pick<CommercialBindingVerifier, "verify"> =
          quoteAuthority.commercialBindingVerifier;
        const dealQuoteReader: Pick<
          DealAuthoritativeQuoteReader,
          "getDecisionAt"
        > = quoteAuthority.dealAuthoritativeQuotes;
        let ledgerRepository: FinancialLedgerRepository;
        let verifiedAsOf: VerifiedFinancialLedgerSealedReader;
        let importRepository: InMemoryFinanceImportRepository
          | MysqlFinanceImportRepository;
        if (options.mode === "mysql") {
          await ensureFinanceImportMysqlSchema(options.pool);
          const mysqlLedger = new MysqlFinancialLedgerRepository(options.pool);
          ledgerRepository = mysqlLedger;
          verifiedAsOf = new MysqlVerifiedFinancialLedgerSealedReader(
            options.pool
          );
          importRepository = new MysqlFinanceImportRepository(
            options.pool, foundation.temporalBarrier
          );
        } else {
          ledgerRepository = new InMemoryFinancialLedgerRepository();
          verifiedAsOf = new RepositoryVerifiedFinancialLedgerSealedReader(
            ledgerRepository as never
          );
          importRepository = new InMemoryFinanceImportRepository(
            foundation.temporalTransactions,
            foundation.temporalBarrier
          );
        }
        const costLedger = new AcquisitionCostLedgerService({
          repository: ledgerRepository,
          foundation
        });
        const financialFacts = new FinancialFactLedgerService({
          repository: ledgerRepository,
          foundation,
          bindingVerifier,
          dealQuoteReader,
          now: options.now
        });
        const imports = new FinanceImportService({
          repository: importRepository,
          foundation,
          bindingVerifier,
          dealQuoteReader,
          now: options.now
        });
        const financialGaps = new EmptyFinancialDataGapSealedReader();
        input.privateServices.provide(GROWTH_FINANCE_SERVICES, Object.freeze({
          costLedger,
          financialFacts,
          imports,
          verifiedAsOf,
          financialGaps
        }));
        worker = new FinanceImportWorker({
          repository: importRepository,
          foundation,
          costLedger,
          financialFactLedger: financialFacts,
          bindingVerifier,
          dealQuoteReader,
          now: options.now
        });
        if (options.startRecovery !== false) {
          sweeper = new DefaultFinanceImportRecoverySweeper({
            repository: importRepository,
            worker,
            authorizer: options.recoveryAuthorizer,
            workerId: options.processWorkerId,
            intervalMs: options.recoveryIntervalMs ?? 60_000,
            batchSize: options.recoveryBatchSize ?? 10,
            now: options.now ?? (() => new Date().toISOString()),
            onError: options.onRecoveryError ?? (() => undefined)
          });
          sweeper.start();
        }
        input.router.use(createAcquisitionCostLedgerRouter({
          ledger: costLedger,
          workspaceContext: foundation.workspaceContext,
          commandContextFactory: foundation.commandContextFactory
        }));
        input.router.use(createFinancialFactRouter({
          ledger: financialFacts,
          workspaceContext: foundation.workspaceContext,
          commandContextFactory: foundation.commandContextFactory
        }));
        input.router.use(createFinanceImportRouter({
          imports,
          workspaceContext: foundation.workspaceContext,
          commandContextFactory: foundation.commandContextFactory,
          now: options.now
        }));
        return Object.freeze({ close });
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    }
  });
}
