import assert from "node:assert/strict";
import test from "node:test";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("finance import router previews, commits and lists row errors", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const preview = await app.previewContractWon("import-router-preview");
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.kind, "financial_fact");
    assert.equal(preview.body.totalRows, 1);
    assert.equal(preview.body.acceptedRows, 1);
    assert.equal(preview.body.errors.length, 0);
    const committed = await app.commitPreview(
      preview.body.previewId, "import-router-commit"
    );
    assert.equal(committed.response.status, 202);
    assert.equal(committed.body.status, "queued");
    const fetched = await app.request(
      `/api/v1/finance/imports/${committed.body.id}`
    );
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.body.id, committed.body.id);
    const errors = await app.request(
      `/api/v1/finance/imports/${committed.body.id}/errors`
    );
    assert.equal(errors.response.status, 200);
    assert.deepEqual(errors.body.items, []);
  } finally {
    await app.close();
  }
});
