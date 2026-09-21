import assert from "node:assert/strict";
import test from "node:test";
import { createDouyinAttributionTestFixture } from "./acquisition-douyin-attribution-test-fixture.js";
import { AcquisitionDomainService } from "./acquisition-domain-service.js";
import { AcquisitionCrmLeadConversionPort } from "./acquisition-lead-conversion-port.js";
import {
  AcquisitionPrivateDomainHandoffService,
  type AcquisitionPrivateDomainHandoffStore,
  type AcquisitionPrivateDomainHandoffRequest
} from "./acquisition-private-domain-handoff.js";
import {
  AcquisitionCandidateRunAttributionResolver,
  AcquisitionCrmOutcomeReconciliationService,
  type AcquisitionCrmOutcomeReconciliationStore
} from "./acquisition-crm-outcome-reconciliation.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { resolveTrustedAcquisitionDealBinding } from "./acquisition-deal-binding.js";

async function fixture() {
  const source = await createDouyinAttributionTestFixture();
  const store: AcquisitionPrivateDomainHandoffStore & AcquisitionCrmOutcomeReconciliationStore = {
    leads: [], leadSourceEvents: [], leadActivities: [], customers: [],
    customerActivities: [], todos: [], acquisitionCustomerHandoffs: [],
    acquisitionCustomerHandoffOperations: [], deals: [], dealEvents: [],
    acquisitionOutcomeReconciliationDiagnostics: [],
    acquisitionOutcomeReconciliationCheckpoints: [],
    acquisitionOutcomeReconciliationProcessedSources: [],
    async persist() {}, async readBarrier() {}
  };
  let sequence = 0;
  const resolver = new AcquisitionCandidateRunAttributionResolver({
    planRuns: source.planRuns, crawler: source.crawler
  });
  const domain = new AcquisitionDomainService({
    repository: source.domain,
    leadConversionPort: new AcquisitionCrmLeadConversionPort({
      repository: source.domain, store, now: () => source.now
    }),
    growthAcquisitionWorkspace: source.workspace,
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner(source.now)
    ),
    outcomeAttributionResolver: resolver,
    now: () => source.now, idFactory: (prefix) => `${prefix}-${++sequence}`
  });
  const service = new AcquisitionPrivateDomainHandoffService({
    repository: source.domain, domainService: domain, store,
    attributionResolver: resolver, now: () => source.now
  });
  async function qualify(candidateId: string) {
    return domain.qualifyCandidate(source.scope, candidateId, {
      decisionEngine: "rules", ruleVersion: "qualification-rules.v1",
      model: null, modelProvider: null, promptVersion: null,
      dimensions: {
        demandStrength: 95, fit: 90, identityConfidence: 95, buyingStage: 90,
        budgetPotential: 80, decisionReachability: 75, freshness: 95,
        evidenceDiversity: 80, negativeSignalRisk: 0, contactRisk: 5
      },
      hardGates: {
        hasOriginalSource: true, identityResolved: true, notDoNotContact: true,
        noExplicitRejection: true, publicDataOnly: true, evidenceFresh: true,
        schemaValid: true
      },
      evidenceExcerpts: {}, reasons: ["隔离测试的公开需求核对"]
    }, {
      currency: "CNY", predictedDealAmountMinor: 5_000_000, grossMarginBps: 6_000,
      closeProbabilityBps: 8_000, acquisitionCostMinor: 100_000,
      salesCostMinor: 100_000, serviceCostMinor: 300_000,
      benchmarkDealAmountMinor: 5_000_000, collectionDays: 15,
      creditRisk: 10, repeatPotential: 90, referralPotential: 80
    }, `qualify:${candidateId}`);
  }
  return { ...source, store, resolver, domainService: domain, service, qualify };
}

function request(runId: string, discoveredEventId: string, decisionVersion: string): AcquisitionPrivateDomainHandoffRequest {
  return {
    operationCode: "handoff_acquisition_candidate_v1", runId, discoveredEventId,
    decisionVersion, mode: "create_new", existingCustomerId: "",
    followUp: { title: "核对公开需求", dueAt: "2026-08-26T01:00:00.000Z", priority: "high" }
  };
}

test("real crawler discovery remains review-gated and hands off one customer and todo with its actual job", async () => {
  const f = await fixture();
  const { candidate, discovered } = f.first;
  assert.equal(candidate.status, "needs_research");
  const qualified = await f.qualify(candidate.id);
  const input = request(discovered.runId, discovered.id, qualified.qualification.decisionVersion);
  await assert.rejects(f.service.create(f.scope, candidate.id, input, "before-review"),
    { code: "ACQUISITION_HANDOFF_NOT_APPROVED" });
  assert.equal(f.store.customers.length, 0);
  assert.equal(f.store.todos.length, 0);
  await f.domainService.reviewCandidate(f.scope, candidate.id, {
    action: "approved", decisionVersion: input.decisionVersion,
    reason: "隔离测试人工审核", idempotencyKey: "human-review"
  });
  const result = await f.service.create(f.scope, candidate.id, input, "handoff-first");
  const replay = await f.service.create(f.scope, candidate.id, input, "handoff-first");
  assert.equal(replay.replayed, true);
  assert.equal(replay.customer.id, result.customer.id);
  assert.equal(f.store.leads.length, 1);
  assert.equal(f.store.customers.length, 1);
  assert.equal(f.store.todos.length, 1);
  assert.equal(f.store.acquisitionCustomerHandoffs.length, 1);
  assert.equal(result.todo.customerId, result.customer.id);
  assert.equal(result.todo.leadId, result.lead.id);
  assert.equal(result.handoff.acquisitionAttribution?.attributionVersion, "douyin-crawler.v1");
  assert.equal(result.handoff.acquisitionAttribution?.shardId, null);
  if (result.handoff.acquisitionAttribution?.attributionVersion !== "douyin-crawler.v1") {
    assert.fail("expected an actual crawler source");
  }
  assert.equal(result.handoff.acquisitionAttribution.jobId, "job-handoff-attribution");
  assert.deepEqual(result.handoff.acquisitionAttribution.providerIds, []);
  const binding = resolveTrustedAcquisitionDealBinding(f.store, {
    handoffId: result.handoff.id, leadId: result.lead.id,
    customerId: result.customer.id, ownerId: f.scope.ownerId, teamId: f.scope.teamId
  });
  assert.ok(binding, "real handoff must be readable by the existing commercial binding path");
});

test("a second reviewed crawler candidate links the existing scoped customer instead of duplicating it", async () => {
  const f = await fixture();
  async function handoff(source: typeof f.first, existingCustomerId = "") {
    const qualified = await f.qualify(source.candidate.id);
    const input = request(source.discovered.runId, source.discovered.id, qualified.qualification.decisionVersion);
    await f.domainService.reviewCandidate(f.scope, source.candidate.id, {
      action: "approved", decisionVersion: input.decisionVersion,
      reason: "隔离测试人工审核", idempotencyKey: `review:${source.candidate.id}`
    });
    if (existingCustomerId) Object.assign(input, { mode: "link_existing", existingCustomerId });
    return f.service.create(f.scope, source.candidate.id, input, `handoff:${source.candidate.id}`);
  }
  const first = await handoff(f.first);
  const second = await f.ingestRun({
    runId: "run-second", jobId: "job-second", localDate: "2026-08-26",
    recordOverrides: { recordId: "comment-second", publicProfileUrl: "https://www.douyin.com/user/second-buyer" }
  });
  const linked = await handoff(second, first.customer.id);
  assert.equal(linked.customer.id, first.customer.id);
  assert.equal(linked.handoff.mode, "link_existing");
  assert.equal(f.store.customers.length, 1);
  assert.equal(f.store.leads.length, 2);
  assert.equal(f.store.todos.length, 2);
});

test("CRM activity reconciliation preserves crawler source and individual identity and rejects a forged job", async () => {
  const f = await fixture();
  const { candidate, discovered } = f.first;
  const qualified = await f.qualify(candidate.id);
  const input = request(discovered.runId, discovered.id, qualified.qualification.decisionVersion);
  await f.domainService.reviewCandidate(f.scope, candidate.id, {
    action: "approved", decisionVersion: input.decisionVersion,
    reason: "隔离测试人工审核", idempotencyKey: "review"
  });
  const handoff = await f.service.create(f.scope, candidate.id, input, "handoff");
  f.store.leadActivities.push({
    id: "human-call", leadId: handoff.lead.id, type: "call", content: "隔离测试跟进",
    operatorId: f.scope.actorId, nextFollowAt: "", createdAt: "2026-08-25T02:00:00.000Z"
  });
  const reconciler = new AcquisitionCrmOutcomeReconciliationService({
    store: f.store, planRuns: f.planRuns, outcomeRecorder: f.domainService,
    attributionResolver: f.resolver, now: () => "2026-08-25T03:00:00.000Z"
  });
  const result = await reconciler.runTenant(f.scope);
  assert.equal(result.reconciled, 1);
  await reconciler.runTenant(f.scope);
  const outcomes = await f.domainService.listOutcomes(f.scope, candidate.id);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.recordKind, "live");
  assert.equal(outcome.partyRef?.partyType, "individual");
  if (outcome.recordKind !== "live") assert.fail("crawler outcome was incorrectly downgraded");
  assert.equal(outcome.attribution.attributionVersion, "douyin-crawler.v1");
  assert.ok(handoff.handoff.acquisitionAttribution?.attributionVersion === "douyin-crawler.v1");
  await assert.rejects(f.domainService.recordOutcome(f.scope, {
    leadId: handoff.lead.id, customerId: handoff.customer.id, eventType: "contacted",
    occurredAt: f.now, amount: null, reasonCode: null, reasonText: null,
    candidateId: candidate.id, idempotencyKey: "forged-direct-outcome",
    attribution: { ...handoff.handoff.acquisitionAttribution, jobId: "forged-job" }
  }), { code: "invalid_request" });
  assert.equal((await f.domain.listOutcomes(f.scope, candidate.id)).length, 1);
});
