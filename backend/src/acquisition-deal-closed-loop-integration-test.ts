import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { app } from "./server.js";
import {
  createAcquisitionApplication
} from "./acquisition-application.js";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence,
  FinancialValueDecision,
  QualificationDecision
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionOperationShard,
  type AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import { getStore } from "./store.js";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

async function listen(application: typeof app = app): Promise<{
  server: Server;
  request(path: string, init?: RequestInit): Promise<{
    response: Response;
    json: any;
  }>;
}> {
  const server = await new Promise<Server>((resolve) => {
    const listening = application.listen(
      0,
      "127.0.0.1",
      () => resolve(listening)
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.body) headers.set("content-type", "application/json");
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
      return {
        response,
        json: await response.json().catch(() => null)
      };
    }
  };
}

test("real handoff HTTP output binds one Deal and blocks legacy commercial closure", async () => {
  const store = getStore();
  const owner = store.users.find((item) => item.email === "alex@goodjob.com");
  assert.ok(owner);
  const suffix = `closed-loop-${Date.now()}`;
  const candidateId = `candidate-${suffix}`;
  const evidenceId = `evidence-${suffix}`;
  const qualificationDecisionId = `qualification-${suffix}`;
  const runId = `run-${suffix}`;
  const discoveredEventId = `discovered-${suffix}`;
  const shardId = `shard-${suffix}`;
  const operationId = `operation-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const planRunRepository = new InMemoryAcquisitionPlanRunRepository();
  domainRepository.bindPresentationRunRepository(planRunRepository);
  const evidence: DiscoveryEvidence = {
    id: evidenceId,
    ownerId: owner.id,
    teamId: owner.teamId,
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: "公开采购需求",
    sourceSnippet: "寻找长期供应商",
    publishedAt: "2026-08-06T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "采购需求",
      sourceUrl: "https://example.test/acquisition",
      resultRank: 1
    },
    accessStatus: "public_content",
    supersedesEvidenceId: null,
    fetchedAt: "2026-08-07T07:00:00.000Z"
  };
  const candidate: AcquisitionCandidate = {
    id: candidateId,
    ownerId: owner.id,
    teamId: owner.teamId,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: `organization-${suffix}`,
      tenantProspectId: `tenant-prospect-${suffix}`
    },
    profile: {
      kind: "organization",
      name: "闭环集成测试客户",
      domain: "closed-loop.example",
      region: "中国",
      creditCode: null
    },
    evidenceIds: [evidenceId],
    status: "approved",
    latestDecisionId: qualificationDecisionId,
    latestDecisionVersion: "qualification-v2",
    approvedDecisionVersion: "qualification-v2",
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-08-07T07:00:00.000Z",
    updatedAt: "2026-08-07T07:40:00.000Z",
    version: 3
  };
  const qualification: QualificationDecision = {
    id: qualificationDecisionId,
    ownerId: owner.id,
    teamId: owner.teamId,
    candidateId,
    decisionVersion: "qualification-v2",
    decisionEngine: "model",
    grade: "S",
    score: 94,
    recommendedAction: "priority_review",
    evidence: [{ evidenceId, excerpt: "寻找长期供应商" }],
    positiveSignals: [{ name: "purchase_intent", score: 98 }],
    negativeSignals: [],
    reasons: ["公开需求明确"],
    confidence: 0.94,
    ruleVersion: "qualification-rules-v2",
    promptVersion: "qualification-prompt-v2",
    modelProvider: "server-provider",
    model: "server-model",
    hardGateFailures: [],
    snapshotHash: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-07T07:30:00.000Z"
  };
  const financial: FinancialValueDecision = {
    id: `financial-${suffix}`,
    ownerId: owner.id,
    teamId: owner.teamId,
    candidateId,
    qualificationDecisionId,
    version: "financial-v1",
    grade: "A",
    score: 90,
    currency: "CNY",
    expectedRevenueMinor: 1_288_000,
    expectedGrossProfitMinor: 708_400,
    expectedContributionMinor: 520_000,
    factors: {
      profitability: 90,
      cashFlow: 88,
      creditQuality: 92,
      repeatPotential: 85,
      referralPotential: 80,
      closeProbability: 86
    },
    inputSnapshotHash: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-08-07T07:31:00.000Z"
  };
  const modelSnapshotRef = {
    jobSnapshotId: `snapshot-${suffix}`,
    connectionId: `model-${suffix}`,
    credentialVersion: 1,
    provider: "moonshot",
    model: "kimi-k3",
    capabilitySnapshotHash: `sha256:${"f".repeat(64)}`,
    promptVersion: "acquisition.v1",
    schemaVersion: "acquisition-plan.v1",
    promptHash: `sha256:${"1".repeat(64)}`,
    schemaHash: `sha256:${"2".repeat(64)}`
  };
  const run: AcquisitionRun = {
    id: runId,
    ownerId: owner.id,
    teamId: owner.teamId,
    planId: `plan-${suffix}`,
    planVersionId: `plan-version-${suffix}`,
    planVersion: 1,
    planSnapshotHash: `sha256:${"e".repeat(64)}`,
    parentRunId: null,
    status: "succeeded",
    terminationIntent: null,
    revision: 2,
    etag: `"${runId}:2"`,
    budgetSnapshotId: `budget-${suffix}`,
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 1,
      maxResults: 1,
      maxAmountMinor: 100,
      maxDurationSeconds: 60
    },
    budgetSnapshotHash: `sha256:${"3".repeat(64)}`,
    billingCurrency: "CNY",
    modelSnapshotRef,
    consumedBudget: {
      requests: 1,
      results: 1,
      amountMinor: 100,
      durationSeconds: 1
    },
    evidenceCount: 1,
    reason: null,
    createdBy: owner.id,
    createdAt: "2026-08-07T06:00:00.000Z",
    updatedBy: owner.id,
    updatedAt: "2026-08-07T07:00:00.000Z",
    completedAt: "2026-08-07T07:00:00.000Z"
  };
  const shard: AcquisitionOperationShard = {
    id: shardId,
    runId,
    ownerId: owner.id,
    teamId: owner.teamId,
    operationId,
    parentShardId: null,
    subjectChannel: "organization",
    kind: "search",
    connection: {
      connectionId,
      providerId: "baidu_ai_search",
      kind: "search",
      status: "active",
      credentialVersion: 1
    },
    query: "采购需求",
    sourceRef: "",
    status: "succeeded",
    budgetSnapshotId: run.budgetSnapshotId,
    allocatedBudget: {
      requests: 1,
      results: 1,
      amountMinor: 100,
      durationSeconds: 60
    },
    consumedBudget: structuredClone(run.consumedBudget),
    modelSnapshotRef,
    evidenceCount: 1,
    revision: 2,
    createdAt: "2026-08-07T06:00:00.000Z",
    updatedAt: "2026-08-07T07:00:00.000Z",
    completedAt: "2026-08-07T07:00:00.000Z"
  };
  const attribution = {
    attributionVersion: "acquisition-run.v1" as const,
    runId,
    planId: run.planId,
    planVersionId: run.planVersionId,
    planVersion: 1,
    planSnapshotHash: run.planSnapshotHash,
    discoveredEventId,
    discoveredAt: "2026-08-07T07:00:00.000Z",
    shardId,
    operationId,
    connectionId,
    providerId: "baidu_ai_search",
    evidenceIds: [evidenceId],
    providerIds: ["baidu_ai_search"],
    queryIds: [`operation:${operationId}`],
    strategyVersion: "acquisition-plan-v1",
    qualificationDecisionId,
    decisionVersion: "qualification-v2",
    decisionSnapshotHash: `sha256:${"c".repeat(64)}`
  };
  await domainRepository.appendEvidence(evidence);
  await domainRepository.insertCandidate(candidate);
  await domainRepository.appendQualificationDecision(qualification);
  await domainRepository.appendFinancialValue(financial);
  await planRunRepository.transaction((transaction) => {
    transaction.putRun(run);
    transaction.putShard(shard);
    transaction.appendRunEvent({
      id: discoveredEventId,
      runId,
      shardId,
      ownerId: owner.id,
      teamId: owner.teamId,
      type: "candidate.discovered",
      actorId: owner.id,
      revision: 2,
      at: attribution.discoveredAt,
      data: { candidateId, operationId, connectionId }
    });
  });
  const acquisitionRuntime = await createAcquisitionApplication({
    store,
    masterSecret: "closed-loop-integration-master-secret-at-least-32-bytes",
    growthToolPorts: createGrowthCommercialToolPorts(),
    acquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      resolve: async () => null
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    domainRepository,
    planRunRepository,
    now: () => "2026-08-07T08:00:00.000Z",
    outcomeReconciliationIntervalMs: 60_000
  });
  const acquisitionApp = express();
  acquisitionApp.use(express.json());
  acquisitionApp.use((request, _response, next) => {
    request.user = {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role,
      teamId: owner.teamId,
      avatar: owner.avatar,
      authVersion: owner.authVersion ?? 1
    };
    next();
  });
  acquisitionApp.use(acquisitionRuntime.handler);
  const acquisitionHttp = await listen(acquisitionApp as typeof app);

  const runtime = await listen();
  let customerId = "";
  let leadId = "";
  let handoffId = "";
  try {
    const login = await runtime.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: owner.email,
        password: "goodjob123"
      })
    });
    assert.equal(login.response.status, 200);
    const handoff = await acquisitionHttp.request(
      `/api/v1/acquisition/candidates/${candidateId}/private-domain-handoffs`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `handoff-${suffix}`
        },
        body: JSON.stringify({
          operationCode: "handoff_acquisition_candidate_v1",
          runId,
          discoveredEventId,
          decisionVersion: "qualification-v2",
          mode: "create_new",
          existingCustomerId: "",
          followUp: {
            title: "首次跟进：确认需求和预算",
            dueAt: "2026-08-08T09:00:00.000Z",
            priority: "high"
          }
        })
      }
    );
    assert.equal(handoff.response.status, 200);
    customerId = handoff.json.handoff.customerId;
    leadId = handoff.json.handoff.leadId;
    handoffId = handoff.json.handoff.id;
    assert.equal(handoff.json.handoff.runId, runId);
    assert.equal(handoff.json.handoff.discoveredEventId, discoveredEventId);
    assert.equal(handoff.json.customer.amount, 12_880);
    assert.equal(
      store.acquisitionCustomerHandoffs.find((item) =>
        item.id === handoffId)?.acquisitionAttribution?.runId,
      runId
    );
    const handoffSource = store.leadSourceEvents.find((item) =>
      item.leadId === leadId
      && item.channel === "acquisition_private_domain_handoff_snapshot"
    );
    assert.deepEqual(
      JSON.parse(handoffSource?.rawPayload ?? "{}").acquisitionAttribution,
      attribution
    );
    const validHandoff = store.acquisitionCustomerHandoffs.find((item) =>
      item.id === handoffId);
    const validLead = store.leads.find((item) => item.id === leadId);
    assert.ok(validHandoff);
    assert.ok(validLead);
    const excludedHandoffIds = {
      missingAttribution: `${handoffId}-missing-attribution`,
      malformedAttribution: `${handoffId}-malformed-attribution`,
      decisionMismatch: `${handoffId}-decision-mismatch`,
      handoffAlreadyBound: `${handoffId}-handoff-bound`,
      leadAlreadyBound: `${handoffId}-lead-bound`
    };
    const excludedLeadIds = {
      missingAttribution: `${leadId}-missing-attribution`,
      malformedAttribution: `${leadId}-malformed-attribution`,
      decisionMismatch: `${leadId}-decision-mismatch`,
      handoffAlreadyBound: `${leadId}-handoff-bound`,
      leadAlreadyBound: `${leadId}-lead-bound`
    };
    Object.entries(excludedHandoffIds).forEach(([kind, id]) => {
      const nextLeadId = excludedLeadIds[kind as keyof typeof excludedLeadIds];
      const candidate = `${candidateId}-${kind}`;
      store.leads.push({
        ...structuredClone(validLead),
        id: nextLeadId,
        externalId: candidate,
        convertedDealId: kind === "leadAlreadyBound" ? "deal-existing" : ""
      });
      store.acquisitionCustomerHandoffs.push({
        ...structuredClone(validHandoff),
        id,
        candidateId: candidate,
        leadId: nextLeadId,
        dealId: kind === "handoffAlreadyBound" ? "deal-existing" : undefined,
        acquisitionAttribution: kind === "missingAttribution"
          ? null
          : kind === "malformedAttribution"
            ? { ...structuredClone(attribution), runId: "" }
            : structuredClone(attribution),
        decisionVersion: kind === "decisionMismatch"
          ? `${attribution.decisionVersion}-stale`
          : validHandoff.decisionVersion
      });
    });
    const missingOperationRecovery = await acquisitionHttp.request(
      `/api/v1/acquisition/candidates/${candidateId}-missingAttribution/private-domain-handoffs`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `handoff-${suffix}-missing-operation-recovery`
        },
        body: JSON.stringify({
          operationCode: "handoff_acquisition_candidate_v1",
          runId,
          discoveredEventId,
          decisionVersion: "qualification-v2",
          mode: "create_new",
          existingCustomerId: "",
          followUp: {
            title: "不得恢复无可信操作的历史交接",
            dueAt: "2026-08-08T09:00:00.000Z",
            priority: "high"
          }
        })
      }
    );
    assert.equal(missingOperationRecovery.response.status, 409);
    assert.equal(
      missingOperationRecovery.json.code,
      "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING"
    );
    const customerRead = await runtime.request("/api/customers", {
      headers: { authorization: `Bearer ${login.json.token}` }
    });
    assert.equal(customerRead.response.status, 200);
    assert.deepEqual(
      customerRead.json.customers.find((item: { id: string }) =>
        item.id === customerId)?.acquisitionBindings,
      [{
        handoffId,
        leadId,
        candidateId,
        createdAt: handoff.json.handoff.createdAt
      }]
    );
    const dealInput = {
      customerId,
      title: "获客闭环商机",
      product: "GoodJob CRM",
      quantity: 1,
      unitPrice: 12_880,
      currency: "CNY",
      nextAction: "发送正式报价",
      nextActionAt: "2026-08-09",
      expectedCloseAt: "2026-08-31",
      acquisitionBinding: { leadId, handoffId }
    };
    const missingAttributionBinding = await runtime.request("/api/deals", {
      method: "POST",
      headers: { authorization: `Bearer ${login.json.token}` },
      body: JSON.stringify({
        ...dealInput,
        title: "不得创建的无归因商机",
        acquisitionBinding: {
          handoffId: excludedHandoffIds.missingAttribution,
          leadId: excludedLeadIds.missingAttribution
        }
      })
    });
    assert.equal(missingAttributionBinding.response.status, 404);
    assert.equal(store.deals.some((item) =>
      item.title === "不得创建的无归因商机"), false);
    for (const kind of ["malformedAttribution", "decisionMismatch"] as const) {
      const invalidAttributionBinding = await runtime.request("/api/deals", {
        method: "POST",
        headers: { authorization: `Bearer ${login.json.token}` },
        body: JSON.stringify({
          ...dealInput,
          title: `不得创建的无效归因商机-${kind}`,
          acquisitionBinding: {
            handoffId: excludedHandoffIds[kind],
            leadId: excludedLeadIds[kind]
          }
        })
      });
      assert.equal(invalidAttributionBinding.response.status, 404);
      assert.equal(store.deals.some((item) =>
        item.title === `不得创建的无效归因商机-${kind}`), false);
    }
    const createAtomicDealFixture = (label: string) => {
      const fixtureLead = {
        ...structuredClone(validLead),
        id: `${leadId}-${label}`,
        externalId: `${candidateId}-${label}`,
        convertedDealId: ""
      };
      const fixtureHandoff = {
        ...structuredClone(validHandoff),
        id: `${handoffId}-${label}`,
        candidateId: `${candidateId}-${label}`,
        leadId: fixtureLead.id,
        dealId: undefined
      };
      const recommendation = {
        id: `recommendation-${suffix}-${label}`,
        signalId: `signal-${suffix}-${label}`,
        teamId: owner.teamId,
        ownerId: owner.id,
        prospectCandidateId: fixtureHandoff.candidateId,
        leadId: fixtureLead.id,
        customerId,
        suggestedTitle: `原子创建测试-${label}`,
        suggestedProduct: "GoodJob CRM",
        suggestedQuantity: 1,
        suggestedUnitPrice: 12_880,
        suggestedAmount: 12_880,
        currency: "CNY",
        initialStage: "询盘" as const,
        nextAction: "发送正式报价",
        nextActionAt: "2026-08-09",
        expectedCloseAt: "2026-08-31",
        reasonCodes: ["clear_demand"],
        missingFields: [],
        evidenceRefs: [],
        recommendationScore: 90,
        duplicateDealIds: [],
        status: "generated" as const,
        expiresAt: "2026-09-01T00:00:00.000Z",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z"
      };
      store.leads.push(fixtureLead);
      store.acquisitionCustomerHandoffs.push(fixtureHandoff);
      store.dealRecommendations.push(recommendation);
      return { fixtureLead, fixtureHandoff, recommendation };
    };
    const failedFixture = createAtomicDealFixture("atomic-failure");
    const originalPersistMutationForFailure = store.persistMutation;
    let failedMutationSnapshot = {
      deal: false,
      event: false,
      binding: false,
      recommendation: false
    };
    let failedDealId = "";
    store.persistMutation = async <T>(mutation: () => {
      value: T;
      rollback(): void;
    }) => {
      const applied = mutation();
      const failedDeal = store.deals.find((item) =>
        item.title === "原子创建失败商机");
      const failedEvent = failedDeal
        ? store.dealEvents.find((item) =>
          item.dealId === failedDeal.id && item.type === "created")
        : undefined;
      failedDealId = failedDeal?.id ?? "";
      failedMutationSnapshot = {
        deal: Boolean(failedDeal),
        event: Boolean(failedEvent
          && failedEvent.leadIdSnapshot === failedFixture.fixtureLead.id
          && failedEvent.handoffIdSnapshot === failedFixture.fixtureHandoff.id),
        binding: Boolean(failedDeal
          && failedFixture.fixtureHandoff.dealId === failedDeal.id
          && failedFixture.fixtureLead.convertedDealId === failedDeal.id),
        recommendation: Boolean(failedDeal
          && failedFixture.recommendation.linkedDealId === failedDeal.id
          && failedFixture.recommendation.status === "converted_by_user")
      };
      applied.rollback();
      throw new Error("injected atomic deal persistence failure");
    };
    let failedAtomicCreation: Awaited<ReturnType<typeof runtime.request>>;
    try {
      failedAtomicCreation = await runtime.request("/api/deals", {
        method: "POST",
        headers: { authorization: `Bearer ${login.json.token}` },
        body: JSON.stringify({
          ...dealInput,
          title: "原子创建失败商机",
          recommendationId: failedFixture.recommendation.id,
          acquisitionBinding: {
            leadId: failedFixture.fixtureLead.id,
            handoffId: failedFixture.fixtureHandoff.id
          }
        })
      });
    } finally {
      store.persistMutation = originalPersistMutationForFailure;
    }
    assert.equal(failedAtomicCreation.response.status, 500);
    assert.deepEqual(failedMutationSnapshot, {
      deal: true,
      event: true,
      binding: true,
      recommendation: true
    });
    assert.equal(store.deals.some((item) =>
      item.title === "原子创建失败商机"), false);
    assert.ok(failedDealId);
    assert.equal(store.dealEvents.some((item) =>
      item.dealId === failedDealId), false);
    assert.equal(failedFixture.fixtureHandoff.dealId, undefined);
    assert.equal(failedFixture.fixtureLead.convertedDealId, "");
    assert.equal(failedFixture.recommendation.status, "generated");
    assert.equal(failedFixture.recommendation.linkedDealId, undefined);

    const successfulFixture = createAtomicDealFixture("atomic-success");
    const originalPersistMutationForSuccess = store.persistMutation;
    const originalPersistForSuccess = store.persist;
    let successfulMutationCount = 0;
    let successfulPersistCount = 0;
    let successfulMutationSnapshot = {
      event: false,
      binding: false,
      recommendation: false
    };
    store.persist = async () => {
      successfulPersistCount += 1;
    };
    store.persistMutation = async <T>(mutation: () => {
      value: T;
      rollback(): void;
    }) => {
      successfulMutationCount += 1;
      const applied = mutation();
      const successfulDeal = store.deals.find((item) =>
        item.title === "原子创建成功商机");
      const successfulEvent = successfulDeal
        ? store.dealEvents.find((item) =>
          item.dealId === successfulDeal.id && item.type === "created")
        : undefined;
      successfulMutationSnapshot = {
        event: Boolean(successfulEvent
          && successfulEvent.leadIdSnapshot === successfulFixture.fixtureLead.id
          && successfulEvent.handoffIdSnapshot === successfulFixture.fixtureHandoff.id),
        binding: Boolean(successfulDeal
          && successfulFixture.fixtureHandoff.dealId === successfulDeal.id
          && successfulFixture.fixtureLead.convertedDealId === successfulDeal.id),
        recommendation: Boolean(successfulDeal
          && successfulFixture.recommendation.linkedDealId === successfulDeal.id
          && successfulFixture.recommendation.status === "converted_by_user")
      };
      await store.persist();
      return applied.value;
    };
    let successfulAtomicCreation: Awaited<ReturnType<typeof runtime.request>>;
    try {
      successfulAtomicCreation = await runtime.request("/api/deals", {
        method: "POST",
        headers: { authorization: `Bearer ${login.json.token}` },
        body: JSON.stringify({
          ...dealInput,
          title: "原子创建成功商机",
          recommendationId: successfulFixture.recommendation.id,
          acquisitionBinding: {
            leadId: successfulFixture.fixtureLead.id,
            handoffId: successfulFixture.fixtureHandoff.id
          }
        })
      });
    } finally {
      store.persistMutation = originalPersistMutationForSuccess;
      store.persist = originalPersistForSuccess;
    }
    assert.equal(successfulAtomicCreation.response.status, 200);
    assert.equal(successfulMutationCount, 1);
    assert.equal(successfulPersistCount, 1);
    assert.deepEqual(successfulMutationSnapshot, {
      event: true,
      binding: true,
      recommendation: true
    });
    const originalPersistMutation = store.persistMutation;
    let releaseConcurrentMutations!: () => void;
    const concurrentMutationGate = new Promise<void>((resolve) => {
      releaseConcurrentMutations = resolve;
    });
    let concurrentMutationArrivals = 0;
    let mutationTail = Promise.resolve();
    store.persistMutation = async <T>(mutation: () => {
      value: T;
      rollback(): void;
    }) => {
      concurrentMutationArrivals += 1;
      if (concurrentMutationArrivals === 2) releaseConcurrentMutations();
      await concurrentMutationGate;
      const previous = mutationTail;
      let releaseMutation!: () => void;
      mutationTail = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      await previous;
      const applied = mutation();
      try {
        await store.persist();
        return applied.value;
      } catch (error) {
        applied.rollback();
        throw error;
      } finally {
        releaseMutation();
      }
    };
    let attempts: Awaited<ReturnType<typeof runtime.request>>[];
    try {
      attempts = await Promise.all([
        runtime.request("/api/deals", {
          method: "POST",
          headers: { authorization: `Bearer ${login.json.token}` },
          body: JSON.stringify(dealInput)
        }),
        runtime.request("/api/deals", {
          method: "POST",
          headers: { authorization: `Bearer ${login.json.token}` },
          body: JSON.stringify({ ...dealInput, title: "并发重复商机" })
        })
      ]);
    } finally {
      store.persistMutation = originalPersistMutation;
    }
    assert.deepEqual(
      attempts.map((attempt) => attempt.response.status).sort(),
      [200, 409]
    );
    const created = attempts.find((attempt) => attempt.response.status === 200)!;
    assert.equal(created.response.status, 200);
    assert.equal(
      store.leads.find((item) => item.id === leadId)?.convertedDealId,
      created.json.deal.id
    );
    const boundCustomer = store.customers.find((item) => item.id === customerId);
    assert.ok(boundCustomer);
    const alternateCustomerId = `${customerId}-alternate`;
    store.customers.push({
      ...structuredClone(boundCustomer),
      id: alternateCustomerId,
      company: "不允许迁移到的客户"
    });
    const moveBoundDeal = await runtime.request(`/api/deals/${created.json.deal.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${login.json.token}` },
      body: JSON.stringify({
        ...dealInput,
        customerId: alternateCustomerId,
        acquisitionBinding: undefined
      })
    });
    assert.equal(moveBoundDeal.response.status, 409);
    assert.equal(created.json.deal.customerId, customerId);
    assert.equal(store.deals.find((item) =>
      item.id === created.json.deal.id)?.customerId, customerId);
    const duplicateBinding = await runtime.request("/api/deals", {
      method: "POST",
      headers: { authorization: `Bearer ${login.json.token}` },
      body: JSON.stringify({ ...dealInput, title: "不得创建的重复商机" })
    });
    assert.equal(duplicateBinding.response.status, 409);
    assert.equal(store.deals.filter((item) =>
      item.id === created.json.deal.id
      || item.title === "并发重复商机"
      || item.title === "不得创建的重复商机").length, 1);
    const boundDeal = store.deals.find((item) =>
      item.id === created.json.deal.id);
    assert.ok(boundDeal);
    const commercialEventsBefore = store.dealEvents
      .filter((item) => item.dealId === boundDeal.id
        && ["quote", "won", "lost"].includes(item.type))
      .map((item) => item.id);
    const feedbackBefore = store.acquisitionOutcomeFeedback
      .filter((item) => item.dealId === boundDeal.id)
      .map((item) => item.id);
    const quote = await runtime.request(`/api/deals/${boundDeal.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.json.token}` },
      body: JSON.stringify({
        type: "quote",
        content: "不得通过 legacy route 发送获客报价",
        nextAction: "等待正式 QuoteVersion",
        nextActionAt: "2026-08-10"
      })
    });
    assert.equal(quote.response.status, 409);
    assert.equal(quote.json.code, "authoritative_quote_required");
    const won = await runtime.request(`/api/deals/${created.json.deal.id}/stage`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${login.json.token}` },
      body: JSON.stringify({
        stage: "成交",
        result: "客户已签署合同",
        nextAction: "安排交付",
        nextActionAt: "2026-08-12",
        expectedCloseAt: "2026-08-31",
        transitionReason: "集成测试快速推进",
        wonReason: "已收到客户签字合同"
      })
    });
    assert.equal(won.response.status, 409);
    assert.equal(won.json.code, "authoritative_quote_required");
    assert.equal(boundDeal.stage, "询盘");
    assert.deepEqual(store.dealEvents
      .filter((item) => item.dealId === boundDeal.id
        && ["quote", "won", "lost"].includes(item.type))
      .map((item) => item.id), commercialEventsBefore);
    assert.deepEqual(store.acquisitionOutcomeFeedback
      .filter((item) => item.dealId === boundDeal.id)
      .map((item) => item.id), feedbackBefore);
    assert.deepEqual(await domainRepository.listOutcomes({
      ownerId: owner.id,
      teamId: owner.teamId
    }, candidateId), []);
  } finally {
    await new Promise<void>((resolve, reject) => runtime.server.close(
      (error) => error ? reject(error) : resolve()
    ));
    await new Promise<void>((resolve, reject) => acquisitionHttp.server.close(
      (error) => error ? reject(error) : resolve()
    ));
    await acquisitionRuntime.close();
    const createdDealIds = new Set(store.deals
      .filter((item) => item.title === "获客闭环商机"
        || item.title === "并发重复商机"
        || item.title === "不得创建的无归因商机"
        || item.title === "原子创建失败商机"
        || item.title === "原子创建成功商机")
      .map((item) => item.id));
    store.dealEvents = store.dealEvents.filter((item) =>
      !createdDealIds.has(item.dealId));
    store.deals = store.deals.filter((item) => !createdDealIds.has(item.id));
    store.acquisitionCustomerHandoffs = store.acquisitionCustomerHandoffs
      .filter((item) => item.id !== handoffId
        && !item.id.startsWith(`${handoffId}-`));
    store.acquisitionCustomerHandoffOperations =
      store.acquisitionCustomerHandoffOperations.filter((item) =>
        item.candidateId !== candidateId);
    store.todos = store.todos.filter((item) =>
      item.leadId !== leadId && item.customerId !== customerId);
    store.customerActivities = store.customerActivities.filter((item) =>
      item.customerId !== customerId);
    store.leadActivities = store.leadActivities.filter((item) =>
      item.leadId !== leadId);
    store.leads = store.leads.filter((item) => item.id !== leadId
      && !item.id.startsWith(`${leadId}-`));
    store.dealRecommendations = store.dealRecommendations.filter((item) =>
      !item.id.startsWith(`recommendation-${suffix}-`));
    store.leadSourceEvents = store.leadSourceEvents.filter((item) =>
      item.leadId !== leadId);
    store.customers = store.customers.filter((item) => item.id !== customerId
      && item.id !== `${customerId}-alternate`);
  }
});
