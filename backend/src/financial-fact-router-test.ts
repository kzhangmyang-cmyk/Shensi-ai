import assert from "node:assert/strict";
import test from "node:test";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("financial fact list paginates without duplicates and requires capability", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const ids: string[] = [];
    for (const key of ["page-a", "page-b", "page-c"]) {
      const created = await app.request("/api/v1/finance/facts", {
        method: "POST", headers: { "Idempotency-Key": key },
        body: {
          candidateId: null, customerId: null, dealId: null,
          factType: "revenue_recognized", amountMinor: 100, currency: "CNY",
          businessOccurredAt: "2026-08-09T00:00:00.000Z",
          provenance: "invoice_confirmed", sourceRef: null,
          evidenceHash: `sha256:${"a".repeat(64)}`,
          externalId: null, sourceIdentityRoot: `external:invoice:${key}`
        }
      });
      assert.equal(created.response.status, 201);
      ids.push(created.body.id);
    }
    ids.sort();
    const first = await app.request("/api/v1/finance/facts?limit=2");
    assert.deepEqual(first.body.items.map((item: { id: string }) => item.id), ids.slice(0, 2));
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.nextAfter, ids[1]);
    const last = await app.request(`/api/v1/finance/facts?limit=2&cursor=${first.body.nextAfter}`);
    assert.deepEqual(last.body.items.map((item: { id: string }) => item.id), ids.slice(2));
    assert.equal(last.body.hasMore, false);
    assert.equal(last.body.nextAfter, null);
    app.revoke("ledger.pending.create");
    assert.equal((await app.request("/api/v1/finance/facts")).response.status, 403);
  } finally {
    await app.close();
  }
});

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
    const listed = await app.request("/api/v1/finance/facts?limit=1");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, created.body.id);
    assert.equal(listed.body.items[0].status, "verified");
    assert.equal(listed.body.items[0].revision, verified.body.revision);
    const otherWorkspace = await app.request("/api/v1/finance/facts", {
      headers: { "X-Workspace-Id": "workspace-b" }
    });
    assert.deepEqual(otherWorkspace.body.items, []);
    const after = await app.request(`/api/v1/finance/facts?cursor=${created.body.id}`);
    assert.deepEqual(after.body, { items: [], nextAfter: null, hasMore: false });
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
