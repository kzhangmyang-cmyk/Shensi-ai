import assert from "node:assert/strict";
import test from "node:test";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("financial fact router creates, verifies and corrects facts", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const created = await app.request("/api/v1/finance/facts", {
      method: "POST",
      headers: { "Idempotency-Key": "fact-router-create" },
      body: {
        candidateId: null,
        customerId: null,
        dealId: null,
        factType: "revenue_recognized",
        amountMinor: 100000,
        currency: "CNY",
        businessOccurredAt: "2026-08-09T00:00:00.000Z",
        provenance: "invoice_confirmed",
        sourceRef: null,
        evidenceHash: `sha256:${"a".repeat(64)}`,
        externalId: null,
        sourceIdentityRoot: "external:invoice:fact-router"
      }
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.revision, 1);
    const verified = await app.request(
      `/api/v1/finance/facts/${created.body.id}/verify`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "fact-router-verify",
          "If-Match": `"financial-fact:${created.body.id}:1"`
        },
        body: { reason: "checked" }
      }
    );
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "verified");
    const replayed = await app.request("/api/v1/finance/facts", {
      method: "POST",
      headers: { "Idempotency-Key": "fact-router-create" },
      body: {
        candidateId: null,
        customerId: null,
        dealId: null,
        factType: "revenue_recognized",
        amountMinor: 100000,
        currency: "CNY",
        businessOccurredAt: "2026-08-09T00:00:00.000Z",
        provenance: "invoice_confirmed",
        sourceRef: null,
        evidenceHash: `sha256:${"a".repeat(64)}`,
        externalId: null,
        sourceIdentityRoot: "external:invoice:fact-router"
      }
    });
    assert.equal(replayed.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replayed.body.id, created.body.id);
  } finally {
    await app.close();
  }
});
