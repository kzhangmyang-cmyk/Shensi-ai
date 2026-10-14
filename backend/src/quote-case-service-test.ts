import assert from "node:assert/strict";
import test from "node:test";
import { quoteCaseFixture } from "./growth-quote-test-fixtures.js";

test("create reserves HTTP idempotency before trusted assignment and denial leaves no Quote writes or receipt", async () => {
  const state = quoteCaseFixture();
  await assert.rejects(
    state.service.create(state.command({ actorId: "sales-a", role: "sales", idempotencyKey: "peer" }), {
      candidateId: "candidate-1", assignedTo: "sales-peer"
    }),
    (error: unknown) => (error as { code?: string }).code === "quote_assignee_forbidden"
  );
  assert.equal(await state.repository.countCases("team-a"), 0);
  assert.equal(await state.repository.countLifecycleEvents("team-a"), 0);
  assert.equal(state.completedIdempotencyCount(), 0);
  const own = await state.service.create(
    state.command({ actorId: "sales-a", role: "sales", idempotencyKey: "self" }),
    { candidateId: "candidate-1", assignedTo: "sales-a" }
  );
  assert.equal(own.value.assignedTo, "sales-a");
});

test("one-time bind freezes the trusted chain and current ProbabilityAssessment v2", async () => {
  const state = quoteCaseFixture({ cases: ["case-a"] });
  const bound = await state.service.bindDeal(
    state.command({ idempotencyKey: "bind", expectedRevision: 1 }),
    "case-a", { dealId: "deal-1" }
  );
  assert.equal(bound.value.dealId, "deal-1");
  assert.equal(bound.value.commercialBindingSnapshot?.candidateVersion, 3);
  assert.equal(await state.repository.boundProbabilityAssessmentId("team-a", "case-a"), "probability-assessment-1");
  assert.equal((await state.repository.findDealAuthority("team-a", "deal-1"))
    ?.openQuoteCaseId, "case-a");
  const replay = await state.service.bindDeal(
    state.command({ idempotencyKey: "bind-replay", expectedRevision: 2 }),
    "case-a", { dealId: "deal-1" }
  );
  assert.equal(replay.value.revision, 2);
  await assert.rejects(
    state.service.bindDeal(state.command({ idempotencyKey: "stale-bind", expectedRevision: 1 }), "case-a", { dealId: "deal-1" }),
    (error: unknown) => (error as { code?: string }).code
      === "quote_case_revision_conflict"
  );
  await assert.rejects(
    state.service.bindDeal(state.command({ idempotencyKey: "rebind", expectedRevision: 2 }), "case-a", { dealId: "deal-2" }),
    (error: unknown) => (error as { code?: string }).code === "quote_case_rebind_forbidden"
  );
});

test("a case requires a subject and trusted references cannot cross workspaces", async () => {
  const state = quoteCaseFixture();
  await assert.rejects(
    state.service.create(state.command({ idempotencyKey: "empty" }), { assignedTo: "sales-a" }),
    (error: unknown) => (error as { code?: string }).code === "quote_case_subject_required"
  );
  await assert.rejects(
    state.service.create(state.command({ idempotencyKey: "cross" }), { candidateId: "candidate-cross", assignedTo: "sales-a" }),
    (error: unknown) => (error as { code?: string }).code === "quote_subject_not_found"
  );
});

test("ordinary CRM deal requires and freezes a human commercial assessment", async () => {
  const state = quoteCaseFixture({ ordinaryDeal: true });
  await assert.rejects(
    state.service.create(state.command({ idempotencyKey: "crm-missing" }), {
      dealId: "deal-1", assignedTo: "sales-a"
    }),
    (error: unknown) => (error as { code?: string }).code
      === "crm_quote_assessment_required"
  );

  const created = await state.service.create(
    state.command({ idempotencyKey: "crm-assessed" }),
    {
      dealId: "deal-1",
      assignedTo: "sales-a",
      crmAssessment: {
        demandConfirmed: true,
        budgetConfirmed: true,
        decisionMakerConfirmed: true,
        closeProbabilityBps: 6500,
        evidenceSummary: "客户预算、需求和决策人均已由销售人工确认。"
      }
    }
  );

  assert.equal(created.value.candidateId, null);
  assert.equal(created.value.customerId, "customer-1");
  assert.equal(created.value.dealId, "deal-1");
  assert.equal(created.value.commercialBindingSnapshot?.sourceKind, "crm");
  assert.equal(await state.repository.boundProbabilityAssessmentId(
    "team-a", created.value.id
  ), created.value.commercialBindingSnapshot?.sourceKind === "crm"
    ? created.value.commercialBindingSnapshot.assessment.inputSnapshotHash
    : null);
});
