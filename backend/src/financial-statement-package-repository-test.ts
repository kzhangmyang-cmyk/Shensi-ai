import test from "node:test";
import {
  runFinancialStatementPackageRepositoryContract,
  runFinancialStatementPackageTamperContract
} from "./financial-statement-package-repository-contract-test.js";
import {
  InMemoryFinancialStatementPackageRepository
} from "./financial-statement-package-repository.js";

test("memory financial statement package repository contract", async () => {
  await runFinancialStatementPackageRepositoryContract(async () =>
    new InMemoryFinancialStatementPackageRepository());
});

test("memory financial statement package reads reject closed forecast corruption",
  async () => {
  await runFinancialStatementPackageTamperContract(async () => {
    const repository = new InMemoryFinancialStatementPackageRepository();
    return { repository, tamper(value) {
      const packages = (repository as unknown as { packages: Map<string, unknown> })
        .packages;
      packages.set("workspace-a\0package-forecast", structuredClone(value));
    } };
  });
});
