import assert from "node:assert/strict";
import test from "node:test";
import {
  CashSettlementAllocationService
} from "./financial-settlement-allocation.js";
import {
  settlementFixture,
  settlementLifecycleFixture
} from "./growth-roi-test-fixtures.js";

test("Deal A underpayment is not cancelled by Deal B overpayment", async () => {
  const fixture = settlementFixture({
    revenues: [
      { id: "rev-a", dealId: "deal-a", amountMinor: 100 },
      { id: "rev-b", dealId: "deal-b", amountMinor: 100 }
    ],
    payments: [
      { id: "pay-a", dealId: "deal-a", amountMinor: 50 },
      { id: "pay-b", dealId: "deal-b", amountMinor: 150 }
    ]
  });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  await fixture.activatePayment(service, "pay-a", "rev-a", 50);
  await fixture.activatePayment(service, "pay-b", "rev-b", 100);
  const cutoff = await fixture.foundation.temporalBarrier.sealReadCutoff(
    fixture.workspace, "2026-08-09T00:00:00.000Z"
  );
  const result = await service.reconcile(
    fixture.workspace, ["rev-a", "rev-b"], cutoff
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.unallocatedCustomerBalanceMinor, 50);
  assert.deepEqual(result.gaps, [{
    revenueFactId: "rev-a",
    remainingMinor: 50
  }]);
});

test("refund must freeze the exact active payment allocation item", async () => {
  const fixture = settlementFixture({
    revenues: [{ id: "rev-a", dealId: "deal-a", amountMinor: 100 }],
    payments: [{ id: "pay-a", dealId: "deal-a", amountMinor: 100 }],
    refunds: [{ id: "refund-a", dealId: "deal-a", amountMinor: 20 }]
  });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  const payment = await fixture.activatePayment(
    service, "pay-a", "rev-a", 100
  );
  await assert.rejects(
    () => fixture.activateRefund(
      service,
      "refund-a",
      "rev-a",
      20,
      {
        paymentFactId: "pay-a",
        paymentSetId: payment.id,
        paymentItemId: "wrong-item"
      }
    ),
    /refund_payment_item_invalid/
  );
});

test("settlement replacement advances one recorded tick and preserves historical asOf", () => {
  const fixture = settlementLifecycleFixture();
  assert.equal(
    fixture.asOfReader.getActiveId(
      fixture.events, "2026-08-08T23:59:59.999Z"
    ),
    "payment-v1"
  );
  assert.equal(
    fixture.asOfReader.getActiveId(
      fixture.events, "2026-08-09T00:00:00.000Z"
    ),
    null
  );
  assert.equal(
    fixture.asOfReader.getActiveId(
      fixture.events, "2026-08-09T00:00:00.001Z"
    ),
    "payment-v2"
  );
  assert.deepEqual(
    fixture.events.map((event) => event.eventSequence),
    [1, 2, 3]
  );
});

test("settlement draft and activation recover one immutable result after Foundation completion loss", async () => {
  const fixture = settlementFixture({
    revenues: [{ id: "rev-a", dealId: "deal-a", amountMinor: 100 }],
    payments: [{ id: "pay-a", dealId: "deal-a", amountMinor: 100 }],
    failFoundationCompletionOncePerMutation: true
  });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  await assert.rejects(
    () => service.createDraft(
      fixture.context("settlement-draft-loss"), fixture.completeDraft
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const draft = await service.createDraft(
    fixture.context("settlement-draft-loss"), fixture.completeDraft
  );
  await assert.rejects(
    () => service.activate(
      { ...fixture.context("settlement-activate-loss"), expectedRevision: 1 },
      draft.id
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const active = await service.activate(
    { ...fixture.context("settlement-activate-loss"), expectedRevision: 1 },
    draft.id
  );
  assert.equal(active.id, draft.id);
  assert.deepEqual(await fixture.domainCommandRowCounts(), {
    drafts: 1,
    activations: 1
  });
});

test("settlement replay reauthorizes and rejects a shared key on another set", async () => {
  const fixture = settlementFixture({
    revenues: [
      { id: "rev-a", dealId: "deal-a", amountMinor: 100 },
      { id: "rev-b", dealId: "deal-b", amountMinor: 100 }
    ],
    payments: [
      { id: "pay-a", dealId: "deal-a", amountMinor: 100 },
      { id: "pay-b", dealId: "deal-b", amountMinor: 100 }
    ]
  });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  const [a, b] = await fixture.twoCompleteDrafts(service);
  await service.activate(
    { ...fixture.context("shared-settlement-key"), expectedRevision: 1 },
    a.id
  );
  fixture.revoke("ledger.verify");
  await assert.rejects(
    () => service.activate(
      { ...fixture.context("shared-settlement-key"), expectedRevision: 1 },
      a.id
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "capability_forbidden"
  );
  fixture.restore("ledger.verify");
  await assert.rejects(
    () => service.activate(
      {
        ...fixture.context(
          "shared-settlement-key",
          `sha256:${"e".repeat(64)}`
        ),
        expectedRevision: 1
      },
      b.id
    ),
    /idempotency_conflict/
  );
  assert.equal(await fixture.activationCount(b.id), 0);
});
