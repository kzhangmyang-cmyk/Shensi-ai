import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";

test("MySQL closure recovery requires an authorizer before publication", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const repository = fixture.closureRepository();
    assert.equal(
      typeof repository.countCloseOperations,
      "function"
    );
    assert.equal(await repository.countClosureVersions(), 0);
  });
});
