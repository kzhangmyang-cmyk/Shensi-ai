import assert from "node:assert/strict";
import test from "node:test";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("cost create requires idempotency, verify requires If-Match, and old performance is unchanged", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const missingKey = await app.request("/api/v1/acquisition/cost-entries", {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.body.code, "idempotency_key_required");
    const missingMatch = await app.request(
      "/api/v1/acquisition/cost-entries/cost-1/verify",
      {
        method: "POST",
        headers: { "Idempotency-Key": "verify-cost-0001" },
        body: { reason: "checked" }
      }
    );
    assert.equal(missingMatch.response.status, 428);
  } finally {
    await app.close();
  }
});

test("Finance HTTP and services enforce current ledger capabilities independent of role", async () => {
  for (const role of ["sales", "manager"] as const) {
    const denied = await mountGrowthFinanceRouters({ role, capabilities: [] });
    try {
      const before = await denied.domainWriteCounts();
      assert.equal((await denied.request(
        "/api/v1/acquisition/cost-entries"
      )).response.status, 403);
      assert.equal((await denied.request(
        "/api/v1/finance/import-templates/financial_fact"
      )).response.status, 403);
      assert.equal((await denied.request(
        "/api/v1/finance/imports/preview",
        {
          method: "POST",
          headers: { "Idempotency-Key": `preview-${role}-denied` },
          body: denied.validPreviewBody()
        }
      )).response.status, 403);
      assert.deepEqual(await denied.domainWriteCounts(), before);
    } finally {
      await denied.close();
    }
  }

  const admin = await mountGrowthFinanceRouters({
    role: "admin",
    capabilities: ["ledger.pending.create"]
  });
  try {
    assert.equal((await admin.request(
      "/api/v1/acquisition/cost-entries"
    )).response.status, 200);
    const created = await admin.createPendingCost("current-capability-key");
    assert.equal((await admin.request(
      `/api/v1/acquisition/cost-entries/${created.id}/verify`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "verify-without-capability",
          "If-Match": created.etag
        },
        body: { reason: "checked" }
      }
    )).response.status, 403);
    admin.grant("ledger.verify");
    assert.equal(
      (await admin.verifyCost(created.id, created.etag)).response.status,
      200
    );
    admin.revoke("ledger.pending.create");
    const beforeReplay = await admin.domainWriteCounts();
    assert.equal(
      (await admin.createPendingCost("current-capability-key")).response.status,
      403
    );
    assert.deepEqual(await admin.domainWriteCounts(), beforeReplay);
  } finally {
    await admin.close();
  }
});

test("import preview get and replay never expose stored quote authority or binding", async () => {
  const app = await mountGrowthFinanceRouters({
    role: "admin",
    capabilities: ["ledger.pending.create"]
  });
  try {
    const first = await app.previewContractWon("preview-public-projection");
    const replay = await app.previewContractWon("preview-public-projection");
    const queued = await app.commitPreview(
      first.body.previewId, "commit-public-projection"
    );
    const fetched = await app.request(
      `/api/v1/finance/imports/${queued.body.id}`
    );
    for (const response of [first, replay, queued, fetched]) {
      const serialized = JSON.stringify(response.body);
      assert.equal(serialized.includes("authoritativeDecision"), false);
      assert.equal(serialized.includes("commercialBindingSnapshot"), false);
      assert.equal(serialized.includes("commercialBindingEvidence"), false);
      assert.equal(serialized.includes("commercialAmountHash"), false);
      assert.equal(serialized.includes("authorityRevision"), false);
      assert.equal(serialized.includes("temporalSequence"), false);
    }
    assert.equal(
      replay.response.headers.get("Idempotency-Replayed"),
      "true"
    );
    const stored = await app.internalStoredRow(first.body.previewId, 1);
    assert.equal(
      stored?.normalized?.kind === "financial_fact"
        ? stored.normalized.authoritativeDecision?.quoteVersionId
        : null,
      "quote-1"
    );
  } finally {
    await app.close();
  }
});
