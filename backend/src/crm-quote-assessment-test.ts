import assert from "node:assert/strict";
import test from "node:test";
import {
  createCrmQuoteAuthoritySnapshot,
  verifyCrmQuoteAuthoritySnapshot
} from "./crm-quote-assessment.js";

const context = Object.freeze({ workspaceId: "team-a", actorId: "sales-a" });
const customer = Object.freeze({ id: "customer-1", ownerId: "sales-a", teamId: "team-a" });
const deal = Object.freeze({
  id: "deal-1", customerId: "customer-1", title: "Dust collector",
  stage: "询盘" as const, product: "Collector", quantity: 2,
  unitPrice: 12_500, amount: 25_000, currency: "CNY",
  amountType: "estimate" as const, ownerId: "sales-a", teamId: "team-a",
  nextAction: "技术确认", nextActionAt: "2026-09-08T03:00:00.000Z",
  expectedCloseAt: "2026-10-01T00:00:00.000Z",
  stageChangedAt: "2026-09-07T00:00:00.000Z"
});

test("ordinary CRM quote authority freezes human qualification without acquisition evidence", () => {
  const snapshot = createCrmQuoteAuthoritySnapshot({
    context,
    customer,
    deal,
    assessment: {
      demandConfirmed: true,
      budgetConfirmed: true,
      decisionMakerConfirmed: true,
      closeProbabilityBps: 6500,
      evidenceSummary: "客户确认两台设备预算，并由厂长参与技术评审。"
    },
    verifiedAt: "2026-09-07T08:00:00.000Z"
  });

  assert.equal(snapshot.sourceKind, "crm");
  assert.equal(snapshot.customerId, "customer-1");
  assert.equal(snapshot.dealId, "deal-1");
  assert.equal(snapshot.assessment.assessedBy, "sales-a");
  assert.equal(snapshot.assessment.precision, "bps");
  assert.equal("candidateId" in snapshot, false);
  assert.equal("handoffId" in snapshot, false);
  assert.equal(verifyCrmQuoteAuthoritySnapshot(snapshot, {
    context,
    customer,
    deal
  }), true);
});

test("ordinary CRM quote authority becomes stale when the deal authority changes", () => {
  const snapshot = createCrmQuoteAuthoritySnapshot({
    context,
    customer,
    deal,
    assessment: {
      demandConfirmed: true,
      budgetConfirmed: false,
      decisionMakerConfirmed: true,
      closeProbabilityBps: 4200,
      evidenceSummary: "需求已确认，预算仍待财务复核。"
    },
    verifiedAt: "2026-09-07T08:00:00.000Z"
  });

  assert.equal(verifyCrmQuoteAuthoritySnapshot(snapshot, {
    context,
    customer,
    deal: { ...deal, amount: 30_000 }
  }), false);
});
