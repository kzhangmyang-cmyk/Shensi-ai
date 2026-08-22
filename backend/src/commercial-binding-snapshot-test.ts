import assert from "node:assert/strict";
import test from "node:test";
import {
  BINDING_HASH_SCHEMA_VERSION,
  CommercialBindingVerifier,
  createCommercialBindingSnapshot,
  verifyCommercialBindingSnapshot
} from "./commercial-binding-snapshot.js";
import { bindingInputFixture, dealFixture, workspaceContextFixture } from "./growth-quote-test-fixtures.js";

test("binding freezes the acquisition chain while mutable money cannot change its authority hashes", () => {
  const snapshot = createCommercialBindingSnapshot(bindingInputFixture({
    deal: { ...dealFixture(), amount: 12_345, currency: "CNY" }
  }));
  const changedMoney = bindingInputFixture({
    deal: { ...dealFixture(), amount: 99_999, currency: "USD" }
  });
  assert.equal(snapshot.candidateId, "candidate-1");
  assert.equal(snapshot.dealId, "deal-1");
  assert.equal(snapshot.bindingHashSchemaVersion, BINDING_HASH_SCHEMA_VERSION);
  assert.equal(snapshot.dealContentHash,
    createCommercialBindingSnapshot(changedMoney).dealContentHash);
  assert.match(snapshot.bindingHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(verifyCommercialBindingSnapshot(snapshot, changedMoney), true);
  assert.equal(verifyCommercialBindingSnapshot(snapshot, bindingInputFixture({
    candidate: { ...bindingInputFixture().candidate, version: 4 }
  })), false);
});

test("binding verifier rejects stale Deal authority and cross-workspace acquisition rows", async () => {
  const current = bindingInputFixture();
  const verifier = new CommercialBindingVerifier({
    acquisitionCustomerHandoffs: [current.handoff],
    leads: [current.lead as never], customers: [current.customer as never],
    deals: [current.deal],
    async findCandidate(workspaceId, candidateId) {
      return workspaceId === current.candidate.teamId
        && candidateId === current.candidate.id ? current.candidate : null;
    },
    async findCurrentDealAuthority() {
      return { workspaceId: "team-a", dealId: "deal-1",
        customerId: "customer-1", dealContentHash: `sha256:${"f".repeat(64)}`,
        authorityRevision: 3 };
    }
  }, () => current.verifiedAt);
  await assert.rejects(
    verifier.verify(workspaceContextFixture("manager"), {
      candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1"
    }),
    (error: unknown) => (error as { code?: string }).code
      === "commercial_binding_authority_mismatch"
  );
  await assert.rejects(
    verifier.verify({ ...workspaceContextFixture("manager"),
      workspaceId: "team-b", teamId: "team-b" }, {
      candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1"
    }),
    (error: unknown) => (error as { code?: string }).code
      === "commercial_binding_authority_mismatch"
  );
});
