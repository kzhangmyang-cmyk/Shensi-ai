import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  settlementDraft
} from "./growth-roi-test-fixtures.js";

test("concurrent payment and bad debt cannot consume more than one revenue", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.insertVerifiedRevenue("rev-a", "deal-a", 100);
    await fixture.insertVerifiedPayment("pay-a", "deal-a", 70);
    await fixture.insertVerifiedBadDebt("bad-a", "deal-a", 70);
    const service = fixture.settlementService();
    const [paySet, badSet] = await Promise.all([
      service.createDraft(
        fixture.context("pay-draft"),
        settlementDraft("pay-a", "rev-a", 70)
      ),
      service.createDraft(
        fixture.context("bad-draft"),
        settlementDraft("bad-a", "rev-a", 70)
      )
    ]);
    const results = await Promise.allSettled([
      service.activate(
        { ...fixture.context("pay-active"), expectedRevision: 1 },
        paySet.id
      ),
      service.activate(
        { ...fixture.context("bad-active"), expectedRevision: 1 },
        badSet.id
      )
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1
    );
  });
});
