import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialLedgerRepository } from "./financial-ledger-repository.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";

export interface FinancialLedgerRepositoryContractFixture {
  repository: FinancialLedgerRepository;
  foundation: GrowthFoundationServices;
  lockTrace?(): readonly string[];
  close(): Promise<void>;
}

export interface FinancialLedgerRepositoryContractCase {
  name: string;
  run(): Promise<void>;
}

export function financialLedgerRepositoryContractCases(
  name: string,
  factory: () => Promise<FinancialLedgerRepositoryContractFixture>
): FinancialLedgerRepositoryContractCase[] {
  return [{
    name: `${name}: rollback releases the first-lock barrier and leaves no partial correction`,
    async run() {
      const fixture = await factory();
      try {
        await assert.rejects(() => fixture.repository.transaction(async (tx) => {
          await fixture.foundation.temporalBarrier.allocateAppend(
            tx, "workspace-a"
          );
          await tx.insertSourceHead({
            workspaceId: "workspace-a",
            ledgerType: "financial",
            sourceIdentityRoot: "external:bank:p-1",
            currentLedgerEntryId: "fact-1",
            currentSourceVersion: 1,
            revision: 1
          });
          throw new Error("inject-after-head");
        }), /inject-after-head/);
        assert.equal(
          await fixture.repository.getFinancialFact("workspace-a", "fact-1"),
          null
        );
        assert.equal(
          await fixture.repository.getFinancialFactBySource(
            "workspace-a", "external:bank:p-1"
          ),
          null
        );
        await fixture.repository.transaction(async (tx) => {
          const stamp = await fixture.foundation.temporalBarrier.allocateAppend(
            tx, "workspace-a"
          );
          assert.equal(stamp.temporalSequence, 1);
        });
      } finally {
        await fixture.close();
      }
    }
  }, {
    name: `${name}: workspace is part of every lookup`,
    async run() {
      const fixture = await factory();
      try {
        assert.equal(
          await fixture.repository.getFinancialFact(
            "workspace-b", "fact-in-workspace-a"
          ),
          null
        );
        assert.equal(
          await fixture.repository.getFinancialFactBySource(
            "workspace-b", "external:bank:p-1"
          ),
          null
        );
      } finally {
        await fixture.close();
      }
    }
  }];
}

export function financialLedgerRepositoryContract(
  name: string,
  factory: () => Promise<FinancialLedgerRepositoryContractFixture>
): void {
  for (const item of financialLedgerRepositoryContractCases(name, factory)) {
    test(item.name, item.run);
  }
}

financialLedgerRepositoryContract("memory", async () => {
  const { InMemoryFinancialLedgerRepository } =
    await import("./financial-ledger-repository.js");
  const { DefaultGrowthTemporalBarrier } =
    await import("./growth-temporal-barrier.js");
  const { foundationServicesFixture } =
    await import("./growth-finance-test-fixtures.js");
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T00:00:00.000Z"
  );
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier: new DefaultGrowthTemporalBarrier(repository)
  });
  return {
    repository,
    foundation,
    close: async () => undefined
  };
});
