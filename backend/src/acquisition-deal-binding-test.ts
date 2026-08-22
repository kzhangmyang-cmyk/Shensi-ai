import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveTrustedAcquisitionDealBinding
} from "./acquisition-deal-binding.js";
import type { CrmStore } from "./store.js";
import type { AcquisitionCustomerHandoff, Lead } from "./types.js";

function bindingFixture(overrides: { dealId?: string } = {}) {
  const dealId = overrides.dealId ?? "deal-1";
  return {
    acquisitionCustomerHandoffs: [{
      id: "handoff-1",
      ownerId: "owner-1",
      teamId: "team-1",
      candidateId: "candidate-1",
      leadId: "lead-1",
      customerId: "customer-1",
      todoId: "todo-1",
      dealId,
      decisionVersion: "decision-v1",
      mode: "create_new",
      processingKeyHash: `sha256:${"1".repeat(64)}`,
      acceptedProcessingKeyHashes: [],
      requestHash: `sha256:${"2".repeat(64)}`,
      intelligence: {
        qualificationGrade: "A",
        qualificationScore: 88,
        financialGrade: "A",
        currency: "USD",
        expectedRevenueMinor: 100_000,
        expectedGrossProfitMinor: 30_000,
        expectedContributionMinor: 20_000
      },
      qualificationSnapshotHash: `sha256:${"3".repeat(64)}`,
      financialSnapshotHash: `sha256:${"4".repeat(64)}`,
      acquisitionAttribution: {
        attributionVersion: "acquisition-run.v1",
        runId: "run-1",
        planId: "plan-1",
        planVersionId: "plan-version-1",
        planVersion: 1,
        planSnapshotHash: `sha256:${"5".repeat(64)}`,
        discoveredEventId: "discovered-1",
        discoveredAt: "2026-08-01T00:00:00.000Z",
        shardId: "shard-1",
        operationId: "operation-1",
        connectionId: "connection-1",
        providerId: "provider-1",
        evidenceIds: ["evidence-1"],
        providerIds: ["provider-1"],
        queryIds: ["query-1"],
        strategyVersion: "strategy-v1",
        qualificationDecisionId: "qualification-1",
        decisionVersion: "decision-v1",
        decisionSnapshotHash: `sha256:${"6".repeat(64)}`
      },
      createdAt: "2026-08-01T01:00:00.000Z"
    }],
    leads: [{
      id: "lead-1",
      company: "Acme",
      contact: "Buyer",
      country: "US",
      email: "buyer@example.test",
      phone: "",
      wechat: "",
      source: "acquisition",
      intent: "buy",
      stage: "qualified",
      status: "converted",
      ownerId: "owner-1",
      teamId: "team-1",
      estimatedAmount: 1_000,
      nextFollowAt: "",
      lastActivityAt: "",
      remark: "",
      convertedCustomerId: "customer-1",
      convertedDealId: dealId,
      sourceType: "outbound",
      sourceChannel: "acquisition",
      sourceCampaign: "campaign-1",
      externalId: "candidate-1",
      sourceUrl: "https://example.test",
      createdAt: "2026-08-01T01:00:00.000Z"
    }]
  } as Pick<CrmStore, "acquisitionCustomerHandoffs" | "leads">;
}

test("only one complete candidate to handoff to lead to deal chain is trusted", () => {
  const store = bindingFixture({ dealId: "deal-1" });
  const binding = resolveTrustedAcquisitionDealBinding(store, {
    dealId: "deal-1"
  });
  assert.equal(binding?.handoff.candidateId, "candidate-1");
  assert.equal(binding?.lead.convertedDealId, "deal-1");

  store.acquisitionCustomerHandoffs.push(structuredClone(
    store.acquisitionCustomerHandoffs[0]!
  ));
  assert.equal(resolveTrustedAcquisitionDealBinding(store, {
    dealId: "deal-1"
  }), null);
});

test("a full CrmStore binding returns complete Handoff and Lead objects", () => {
  const binding = resolveTrustedAcquisitionDealBinding(bindingFixture(), {
    dealId: "deal-1"
  });
  assert.ok(binding);
  const handoff: AcquisitionCustomerHandoff = binding.handoff;
  const lead: Lead = binding.lead;

  assert.equal(handoff.todoId, "todo-1");
  assert.equal(lead.company, "Acme");
});

test("handoff lookup requires the exact tenant, customer, and lead chain", () => {
  const store = bindingFixture();
  const valid = resolveTrustedAcquisitionDealBinding(store, {
    handoffId: "handoff-1",
    leadId: "lead-1",
    ownerId: "owner-1",
    teamId: "team-1",
    customerId: "customer-1"
  });
  assert.equal(valid?.handoff.id, "handoff-1");
  assert.equal(resolveTrustedAcquisitionDealBinding(store, {
    handoffId: "handoff-1",
    leadId: "lead-1",
    ownerId: "owner-1",
    teamId: "other-team",
    customerId: "customer-1"
  }), null);
});

test("malformed or decision-mismatched attribution is never trusted", () => {
  const store = bindingFixture();
  store.acquisitionCustomerHandoffs[0]!.decisionVersion = "decision-stale";
  assert.equal(resolveTrustedAcquisitionDealBinding(store, {
    dealId: "deal-1"
  }), null);
  store.acquisitionCustomerHandoffs[0]!.decisionVersion = "decision-v1";
  store.acquisitionCustomerHandoffs[0]!.acquisitionAttribution = null;
  assert.equal(resolveTrustedAcquisitionDealBinding(store, {
    dealId: "deal-1"
  }), null);
});
