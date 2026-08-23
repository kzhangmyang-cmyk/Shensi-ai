import test from "node:test";
import {
  runFinancialStatementPackageRepositoryContract
} from "./financial-statement-package-repository-contract-test.js";
import {
  InMemoryFinancialStatementPackageRepository
} from "./financial-statement-package-repository.js";

test("memory financial statement package repository contract", async () => {
  await runFinancialStatementPackageRepositoryContract(async () =>
    new InMemoryFinancialStatementPackageRepository());
});
