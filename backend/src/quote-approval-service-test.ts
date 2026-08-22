import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalFixture,
  managerDecisionContext
} from "./growth-quote-test-fixtures.js";

test("submitter cannot approve their own formal quote", async () => {
  const state = approvalFixture({ submittedBy: "manager-1" });
  await assert.rejects(
    state.service.approve(managerDecisionContext({ actorId: "manager-1" }),
      state.formalVersion.id, { reason: "同意" }),
    (error: unknown) => (error as { code?: string }).code
      === "approval_self_decision_forbidden"
  );
});

test("approval requires a formal version and queues one authoritative publication", async () => {
  const state = approvalFixture();
  await assert.rejects(
    state.service.approve(managerDecisionContext(), state.draftVersion.id,
      { reason: "同意" }),
    (error: unknown) => (error as { code?: string }).code
      === "formal_quote_version_required"
  );

  const first = await state.service.approve(managerDecisionContext(),
    state.formalVersion.id, { reason: "同意" });
  assert.equal(first.replayed, false);
  assert.equal(first.value.quoteVersion.status, "approved");
  assert.equal(first.value.authority.quoteVersionId, state.formalVersion.id);
  assert.equal(first.value.publicationOperation.status, "queued");
  assert.equal(first.value.publicationOperation.idempotencyKey,
    `quote-publication:deal-1:${state.formalVersion.id}:${first.value.authority.authorityRevision}`);

  const replay = await state.service.approve(managerDecisionContext(),
    state.formalVersion.id, { reason: "同意" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.publicationOperation.id,
    first.value.publicationOperation.id);
});

test("exception approval requires every frozen capability", async () => {
  const state = approvalFixture({
    requiredCapabilities: [
      "quote.exception.discount.approve",
      "quote.exception.payment_terms.approve"
    ]
  });
  await assert.rejects(
    state.service.approve(managerDecisionContext({
      capabilities: ["quote.exception.discount.approve"]
    }), state.formalVersion.id, { reason: "同意" }),
    (error: unknown) => (error as { code?: string }).code
      === "capability_forbidden"
  );
});
