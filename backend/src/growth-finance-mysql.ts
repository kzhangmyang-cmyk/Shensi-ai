import type mysql from "mysql2/promise";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import { MysqlVerifiedFinancialLedgerSealedReader } from "./financial-ledger-as-of-mysql-reader.js";
import { VerifiedFinancialLedgerAsOfBoundary } from "./financial-ledger-as-of-reader.js";
import {
  ensureFinancialLedgerMysqlSchema,
  MysqlFinancialLedgerRepository
} from "./financial-ledger-mysql-repository.js";
import {
  ensureFinanceImportMysqlSchema,
  MysqlFinanceImportRepository
} from "./finance-import-mysql-repository.js";
import { FinanceImportService } from "./finance-import-service.js";
import {
  ensureAttributionAllocationMysqlSchema
} from "./acquisition-attribution-allocation-mysql-repository.js";
import {
  ensureFinancialSettlementMysqlSchema
} from "./financial-settlement-allocation-mysql-repository.js";
import {
  ensureRoiClosureMysqlSchema
} from "./acquisition-roi-closure-mysql-repository.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { assertGrowthTemporalBarrier } from "./growth-temporal-barrier.js";

export async function createGrowthFinanceMysql(input: {
  pool: mysql.Pool;
  foundation: GrowthFoundationServices;
}) {
  await ensureFinancialLedgerMysqlSchema(input.pool);
  await ensureFinanceImportMysqlSchema(input.pool);
  await ensureAttributionAllocationMysqlSchema(input.pool);
  await ensureFinancialSettlementMysqlSchema(input.pool);
  await ensureRoiClosureMysqlSchema(input.pool);
  assertGrowthTemporalBarrier(input.foundation.temporalBarrier);
  const repository = new MysqlFinancialLedgerRepository(input.pool);
  const financeImportRepository = new MysqlFinanceImportRepository(
    input.pool, input.foundation.temporalBarrier
  );
  const sealedReader = new MysqlVerifiedFinancialLedgerSealedReader(input.pool);
  return Object.freeze({
    repository,
    financeImportRepository,
    financeImportService: new FinanceImportService({
      repository: financeImportRepository,
      foundation: input.foundation
    }),
    costLedger: new AcquisitionCostLedgerService({
      repository,
      foundation: input.foundation
    }),
    sealedReader,
    verifiedLedgerAsOf: new VerifiedFinancialLedgerAsOfBoundary({
      foundation: input.foundation,
      sealedReader
    })
  });
}
