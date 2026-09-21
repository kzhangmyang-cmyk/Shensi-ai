import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  completeTwoCohortDraft
} from "./growth-roi-test-fixtures.js";

test("only one allocation version becomes active under concurrent activation", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const service = fixture.attributionService();
    const [a, b] = await Promise.all([6000, 7000].map((bps, index) =>
      service.createDraft(
        fixture.context(`draft-${index}`),
        completeTwoCohortDraft("cost-1", bps)
      )));
    const results = await Promise.allSettled([
      service.activate(
        { ...fixture.context("activate-a"), expectedRevision: 1 }, a.id
      ),
      service.activate(
        { ...fixture.context("activate-b"), expectedRevision: 1 }, b.id
      )
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1
    );
    assert.equal(
      (await fixture.repository.listActiveSets(
        "workspace-a", "cost_entry", "cost-1"
      )).length,
      1
    );
  });
});
