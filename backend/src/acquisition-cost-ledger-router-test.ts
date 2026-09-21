import assert from "node:assert/strict";
import test from "node:test";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("cost ledger router creates, verifies, rejects and corrects entries", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const created = await app.createPendingCost("cost-router-create");
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.revision, 1);
    const verified = await app.verifyCost(created.id, created.etag);
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "verified");
    assert.equal(verified.body.revision, 2);
    const replayed = await app.createPendingCost("cost-router-create");
    assert.equal(replayed.id, created.id);
  } finally {
    await app.close();
  }
});
