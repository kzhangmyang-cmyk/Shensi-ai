import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import type {
  AcquisitionCandidate
} from "./acquisition-domain.js";
import {
  AcquisitionCandidateIntelligenceOperationError,
  AcquisitionCandidateIntelligenceOperationService,
  InMemoryAcquisitionCandidateIntelligenceOperationRepository,
  type AcquisitionCandidateIntelligenceHeartbeatScheduler,
  type AcquisitionCandidateIntelligenceSessionFactory
} from "./acquisition-candidate-intelligence-operations.js";
import type {
  AcquisitionAgentToolExecutor,
  AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import {
  AcquisitionToolExecutorError,
  ProductionAcquisitionAgentToolExecutor,
  type AcquisitionJudgmentPort
} from "./acquisition-tool-executor.js";
import {
  InMemoryAcquisitionCandidateDirectory,
  InMemoryAcquisitionToolResultLedger
} from "./acquisition-tool-support-repositories.js";
import {
  createGrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const NOW = "2026-08-07T02:00:00.000Z";
const scope = {
  ownerId: "owner-intelligence",
  teamId: "team-intelligence",
  actorId: "actor-intelligence"
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function candidate(
  id: string,
  options: { resolved?: boolean } = {}
): AcquisitionCandidate {
  const resolved = options.resolved ?? true;
  return {
    id,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    partyType: "individual",
    partyRef: {
      partyType: "individual",
      individualPartyId: resolved
        ? `individual-${id}`
        : `unresolved-individual-${id}`,
      demandSignalId: `signal-${id}`
    },
    profile: {
      kind: "individual",
      publicActorKey: resolved ? `douyin:${id}` : "",
      publicDisplayName: `候选 ${id}`,
      publicProfileUrl: resolved
        ? `https://www.douyin.com/user/${id}`
        : "",
      sourcePlatform: "douyin",
      demandCategory: "获客系统",
      demandSummary: "正在比较获客方案",
      locationHint: "厦门",
      buyingStage: "comparison",
      negativeSignals: []
    },
    evidenceIds: [`evidence-${id}`],
    status: "normalized",
    latestDecisionId: null,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1
  };
}

function qualification(
  grade: "S" | "A" | "B" | "C" | "D",
  score: number,
  hardGateFailures: string[] = []
) {
  return {
    qualification: {
      grade,
      score,
      hardGateFailures
    },
    financialValue: {
      id: "financial-decision-1",
      currency: "CNY"
    },
    outreachExecuted: false
  };
}

function successfulExecutor(
  calls: AcquisitionToolExecutionInput[],
  grade: "S" | "A" | "B" | "C" | "D" = "A",
  score = 82
): AcquisitionAgentToolExecutor {
  return {
    async execute(input) {
      calls.push(structuredClone({
        ...input,
        signal: undefined
      }));
      if (input.toolName === "research_candidate") {
        return {
          summary: "公开主页显示候选正在比较获客系统。",
          findings: [{
            label: "采购信号",
            content: "候选近期公开表达了明确需求。",
            evidenceIds: ["evidence-candidate-a"],
            confidence: 0.9
          }],
          outreachExecuted: false
        };
      }
      if (input.toolName === "qualify_candidate") {
        return qualification(grade, score);
      }
      return {
        battleCard: {
          id: "battle-card-1",
          candidateId: String(input.payload.candidateId)
        },
        outreachExecuted: false
      };
    }
  };
}

function fixture(options: {
  executor?: AcquisitionAgentToolExecutor;
  candidates?: AcquisitionCandidate[];
  now?: () => string;
  sessionFactory?: AcquisitionCandidateIntelligenceSessionFactory;
  repository?: InMemoryAcquisitionCandidateIntelligenceOperationRepository;
  heartbeatScheduler?: AcquisitionCandidateIntelligenceHeartbeatScheduler;
  workerId?: string;
} = {}) {
  const calls: AcquisitionToolExecutionInput[] = [];
  const candidates = new Map(
    (options.candidates ?? [candidate("candidate-a")])
      .map((item) => [item.id, item])
  );
  const sessionCalls: Array<{
    candidateId: string;
    idempotencyKey: string;
  }> = [];
  const sessionFactory = options.sessionFactory ?? {
    async createSession(input) {
      sessionCalls.push({
        candidateId: input.candidateId,
        idempotencyKey: input.idempotencyKey
      });
      return { sessionId: `model-session:${input.candidateId}` };
    }
  };
  const repository = options.repository
    ?? new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  let id = 0;
  const service = new AcquisitionCandidateIntelligenceOperationService({
    repository,
    candidates: {
      async getCandidate(candidateScope, candidateId) {
        const value = candidates.get(candidateId);
        return value
          && value.ownerId === candidateScope.ownerId
          && value.teamId === candidateScope.teamId
          ? structuredClone(value)
          : null;
      }
    },
    sessionFactory,
    executor: options.executor ?? successfulExecutor(calls),
    idFactory: () => `candidate-intelligence-${++id}`,
    workerId: options.workerId ?? "candidate-intelligence-worker",
    leaseTokenFactory: () => `lease-${++id}`,
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 20_000,
    heartbeatScheduler: options.heartbeatScheduler,
    now: options.now ?? (() => NOW)
  });
  return { calls, candidates, repository, service, sessionCalls };
}

test("creates one queued operation only after identity resolution and pins one model session", async () => {
  const state = fixture({
    candidates: [
      candidate("candidate-a"),
      candidate("candidate-unresolved", { resolved: false }),
      candidate("candidate-b")
    ]
  });

  await assert.rejects(
    state.service.createAfterIdentity(
      scope,
      "candidate-unresolved",
      "after-identity-unresolved"
    ),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "IDENTITY_NOT_RESOLVED"
  );

  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-a"
  );
  const replay = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-a"
  );

  assert.deepEqual(replay, created);
  assert.equal(created.status, "queued");
  assert.equal(created.candidateId, "candidate-a");
  assert.equal(created.sessionId, "model-session:candidate-a");
  assert.deepEqual(created.completedStages, []);
  assert.deepEqual(created.skippedStages, []);
  assert.equal(created.currentStage, null);
  assert.equal(created.failure, null);
  assert.equal(state.sessionCalls.length, 1);

  await assert.rejects(
    state.service.createAfterIdentity(
      scope,
      "candidate-b",
      "after-identity-a"
    ),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("uses a trusted acquisition plan session without creating a replacement", async () => {
  const state = fixture();

  const operation = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "plan-bound-key",
    { trustedSessionId: "acquisition-plan:run-123" }
  );
  const replay = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "plan-bound-key",
    { trustedSessionId: "acquisition-plan:run-123" }
  );

  assert.equal(operation.sessionId, "acquisition-plan:run-123");
  assert.deepEqual(replay, operation);
  assert.equal(state.sessionCalls.length, 0);
});

test("rejects an untrusted supplied session before creating an operation", async () => {
  const state = fixture();

  await assert.rejects(
    state.service.createAfterIdentity(
      scope,
      "candidate-a",
      "untrusted-plan-key",
      { trustedSessionId: "model-session:active" }
    ),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "INVALID_REQUEST"
  );

  assert.equal(state.sessionCalls.length, 0);
});

test("registers retry commands durably and rejects one tenant key reused for another operation", async () => {
  const state = fixture({
    candidates: [candidate("candidate-a"), candidate("candidate-b")]
  });
  const first = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "create-retry-ledger-a"
  );
  const second = await state.service.createAfterIdentity(
    scope,
    "candidate-b",
    "create-retry-ledger-b"
  );

  const registered = await state.service.requestRetry(
    scope,
    first.id,
    "retry-command-ledger-key"
  );
  const replayed = await state.service.requestRetry(
    scope,
    first.id,
    "retry-command-ledger-key"
  );

  assert.equal(registered.shouldDispatch, true);
  assert.equal(replayed.shouldDispatch, false);
  assert.equal(registered.operation.id, first.id);
  assert.equal(replayed.operation.id, first.id);
  await assert.rejects(
    state.service.requestRetry(
      scope,
      second.id,
      "retry-command-ledger-key"
    ),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("retry atomically requeues a failed operation and makes it recoverable", async () => {
  const executor: AcquisitionAgentToolExecutor = {
    async execute() {
      throw new AcquisitionToolExecutorError("INVALID_JUDGMENT_RESULT");
    }
  };
  const state = fixture({ executor });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "create-retry-requeue"
  );
  const failed = await state.service.execute(scope, created.id);
  assert.equal(failed.status, "failed");

  const registered = await state.service.requestRetry(
    scope,
    created.id,
    "retry-requeue-key"
  );
  assert.equal(registered.shouldDispatch, true);
  assert.equal(registered.operation.status, "queued");
  assert.equal(registered.operation.failure, null);
  assert.equal(registered.operation.failedAt, null);
  assert.equal(registered.operation.currentStage, null);
  assert.deepEqual(
    (await state.service.listRecoverableOperations())
      .map((operation) => operation.id),
    [created.id]
  );

  const replayed = await state.service.requestRetry(
    scope,
    created.id,
    "retry-requeue-key"
  );
  assert.equal(replayed.shouldDispatch, false);
  assert.equal(replayed.operation.status, "queued");
});

test("persists research, qualification with finance, and a battle card in stage order", async () => {
  const state = fixture();
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-a"
  );

  const completed = await state.service.execute(scope, created.id);

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.completedStages, [
    "research",
    "qualification",
    "battle_card"
  ]);
  assert.deepEqual(completed.skippedStages, []);
  assert.equal(completed.currentStage, null);
  assert.equal(completed.research?.summary,
    "公开主页显示候选正在比较获客系统。");
  assert.equal(completed.research?.findings[0]?.label, "采购信号");
  assert.deepEqual(completed.qualification, {
    grade: "A",
    score: 82,
    hardGateFailures: [],
    financialValueId: "financial-decision-1"
  });
  assert.equal(completed.battleCardId, "battle-card-1");
  assert.equal(completed.failure, null);
  assert.equal(completed.completedAt, NOW);
  assert.deepEqual(state.calls.map((call) => call.toolName), [
    "research_candidate",
    "qualify_candidate",
    "build_battle_card"
  ]);
  assert.equal(state.calls.every((call) =>
    call.identity.sessionId === created.sessionId
    && call.identity.actorId === scope.actorId
    && call.toolCallId === call.idempotencyKey
    && /^candidate-intelligence-stage:[a-f0-9]{48}$/u.test(
      call.idempotencyKey
    )), true);
  assert.equal(new Set(
    state.calls.map((call) => call.idempotencyKey)
  ).size, 3);

  assert.deepEqual(
    await state.service.get(scope, created.id),
    completed
  );
  assert.deepEqual(await state.service.execute(scope, created.id), completed);
  assert.equal(state.calls.length, 3);
});

test("runs the durable workflow through the production executor and persists domain decisions", async () => {
  let domainId = 0;
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: {
      async createLead(input) {
        return {
          leadId: `lead:${input.candidateId}`,
          partyRef: input.partyRef
        };
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return input.ownerId === scope.ownerId
          && input.teamId === scope.teamId
          ? {
              workspaceId: scope.teamId,
              kind: "team" as const,
              bindingRevision: "binding-1"
            }
          : null;
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-production-${++domainId}`,
    now: () => NOW
  });
  const evidence = await domain.appendEvidence(scope, {
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "公开采购信号",
    sourceSnippet: "厦门门店主理人正在比较 AI 获客系统并计划近期采购。",
    publishedAt: NOW,
    locale: "zh-CN",
    rawArtifactHash: sha256("production-evidence-raw"),
    contentHash: sha256("production-evidence-content"),
    provenance: {
      kind: "user_submitted_url",
      sourceUrl: "https://www.douyin.com/user/production-fixture",
      submittedBy: scope.actorId
    },
    accessStatus: "public_content",
    supersedesEvidenceId: null
  }, "production:evidence");
  const productionCandidate = await domain.createIndividualCandidate(scope, {
    publicActorKey: "douyin:production-fixture",
    publicDisplayName: "厦门门店主理人",
    publicProfileUrl: "https://www.douyin.com/user/production-fixture",
    sourcePlatform: "douyin",
    demandSignalId: "signal-production-fixture",
    demandCategory: "AI 获客系统",
    demandSummary: "正在比较获客系统并计划近期采购",
    locationHint: "厦门",
    buyingStage: "purchase_ready",
    negativeSignals: [],
    individualPartyId: "individual-production-fixture",
    evidenceIds: [evidence.id]
  }, "production:candidate");
  const judgments: AcquisitionJudgmentPort = {
    async qualify(input) {
      return {
        qualification: {
          decisionEngine: "model",
          ruleVersion: input.policyVersion,
          promptVersion: "qualification.production-fixture.v1",
          modelProvider: "zhipu",
          model: "glm-production-fixture",
          dimensions: {
            demandStrength: 95,
            fit: 92,
            identityConfidence: 95,
            buyingStage: 95,
            budgetPotential: 88,
            decisionReachability: 86,
            freshness: 100,
            evidenceDiversity: 80,
            negativeSignalRisk: 0,
            contactRisk: 0
          },
          hardGates: {
            hasOriginalSource: false,
            identityResolved: false,
            notDoNotContact: false,
            noExplicitRejection: false,
            publicDataOnly: false,
            evidenceFresh: false,
            schemaValid: false
          },
          evidenceExcerpts: Object.fromEntries(
            input.evidence.map((item) => [item.id, item.sourceSnippet])
          ),
          reasons: ["公开采购信号明确且身份可核验"]
        },
        financial: {
          currency: "CNY",
          predictedDealAmountMinor: 3_000_000,
          grossMarginBps: 6_000,
          closeProbabilityBps: 8_000,
          acquisitionCostMinor: 30_000,
          salesCostMinor: 50_000,
          serviceCostMinor: 500_000,
          benchmarkDealAmountMinor: 3_000_000,
          collectionDays: 15,
          creditRisk: 10,
          repeatPotential: 80,
          referralPotential: 70
        }
      };
    }
  };
  const productionExecutor = new ProductionAcquisitionAgentToolExecutor({
    domain,
    growthToolPorts: createGrowthCommercialToolPorts(),
    search: {
      async search() {
        throw new Error("search is not used by candidate intelligence");
      }
    },
    searchConnections: {
      async listActiveConnectionIds() {
        return [];
      }
    },
    candidateDirectory: new InMemoryAcquisitionCandidateDirectory({
      now: () => NOW,
      identityAliases: domainRepository
    }),
    priorityCandidates: {
      async listPriorityCandidates() {
        return [];
      }
    },
    reviewTasks: {
      async create() {
        throw new Error("review task creation is not used");
      },
      async get() {
        return null;
      }
    },
    actionExecutions: {
      async getVerifiedExecution() {
        return null;
      }
    },
    toolResults: new InMemoryAcquisitionToolResultLedger(),
    judgments,
    now: () => NOW
  });
  const operationRepository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const operationService =
    new AcquisitionCandidateIntelligenceOperationService({
      repository: operationRepository,
      candidates: {
        getCandidate(candidateScope, candidateId) {
          return domain.getCandidate(candidateScope, candidateId);
        }
      },
      sessionFactory: {
        async createSession() {
          return { sessionId: "production-session" };
        }
      },
      executor: productionExecutor,
      idFactory: () => "candidate-intelligence-production",
      leaseTokenFactory: () => "production-lease",
      workerId: "production-worker",
      now: () => NOW
    });

  const created = await operationService.createAfterIdentity(
    scope,
    productionCandidate.id,
    "production-intelligence-operation"
  );
  const completed = await operationService.execute(scope, created.id);

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.completedStages, [
    "research",
    "qualification",
    "battle_card"
  ]);
  assert.equal(completed.qualification?.grade, "S");
  const qualificationDecisions = await domain.listQualificationDecisions(
    scope,
    productionCandidate.id
  );
  const financialDecisions = await domain.listFinancialValueDecisions(
    scope,
    productionCandidate.id
  );
  const battleCards = await domain.listBattleCards(
    scope,
    productionCandidate.id
  );
  assert.equal(qualificationDecisions.length, 1);
  assert.equal(financialDecisions.length, 1);
  assert.equal(battleCards.length, 1);
  assert.equal(
    completed.qualification?.financialValueId,
    financialDecisions[0]?.id
  );
  assert.equal(completed.battleCardId, battleCards[0]?.id);
});

test("finishes successfully and records a skipped card for an ineligible qualification", async () => {
  const calls: AcquisitionToolExecutionInput[] = [];
  const state = fixture({
    executor: successfulExecutor(calls, "B", 62)
  });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-low-score"
  );

  const completed = await state.service.execute(scope, created.id);

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.completedStages, [
    "research",
    "qualification"
  ]);
  assert.deepEqual(completed.skippedStages, ["battle_card"]);
  assert.equal(completed.battleCardId, null);
  assert.deepEqual(calls.map((call) => call.toolName), [
    "research_candidate",
    "qualify_candidate"
  ]);
});

test("records a stable stage failure and retry resumes without rerunning completed stages", async () => {
  const calls: AcquisitionToolExecutionInput[] = [];
  let qualificationAttempts = 0;
  const executor: AcquisitionAgentToolExecutor = {
    async execute(input) {
      calls.push(structuredClone({ ...input, signal: undefined }));
      if (input.toolName === "research_candidate") {
        return {
          summary: "研究已完成",
          findings: [],
          outreachExecuted: false
        };
      }
      if (input.toolName === "qualify_candidate") {
        qualificationAttempts += 1;
        if (qualificationAttempts === 1) {
          throw new AcquisitionToolExecutorError(
            "INVALID_JUDGMENT_RESULT"
          );
        }
        return qualification("A", 85);
      }
      return {
        battleCard: {
          id: "battle-card-recovered",
          candidateId: "candidate-a"
        }
      };
    }
  };
  const state = fixture({ executor });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-retry"
  );

  const failed = await state.service.execute(scope, created.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.completedStages, ["research"]);
  assert.equal(failed.currentStage, "qualification");
  assert.equal(failed.completedAt, null);
  assert.equal(failed.failedAt, NOW);
  assert.deepEqual(failed.failure, {
    stage: "qualification",
    errorCode: "INVALID_JUDGMENT_RESULT"
  });
  assert.equal(failed.research?.summary, "研究已完成");

  const recovered = await state.service.execute(scope, created.id);
  assert.equal(recovered.status, "succeeded");
  assert.deepEqual(recovered.completedStages, [
    "research",
    "qualification",
    "battle_card"
  ]);
  assert.equal(recovered.failure, null);
  assert.equal(recovered.failedAt, null);
  assert.equal(recovered.completedAt, NOW);
  assert.deepEqual(calls.map((call) => call.toolName), [
    "research_candidate",
    "qualify_candidate",
    "qualify_candidate",
    "build_battle_card"
  ]);
  assert.equal(
    calls[1]?.idempotencyKey,
    calls[2]?.idempotencyKey
  );
  assert.equal(calls.every((call) =>
    call.identity.sessionId === created.sessionId
  ), true);
});

test("normalizes repeated public evidence and hard-gate values to unique arrays", async () => {
  const executor: AcquisitionAgentToolExecutor = {
    async execute(input) {
      if (input.toolName === "research_candidate") {
        return {
          summary: "研究已完成",
          findings: [{
            label: "采购信号",
            content: "存在重复来源",
            evidenceIds: [
              "evidence-1",
              "evidence-1",
              `${"e".repeat(255)}-first`,
              `${"e".repeat(255)}-second`
            ],
            confidence: 0.8
          }],
          outreachExecuted: false
        };
      }
      if (input.toolName === "qualify_candidate") {
        return qualification("D", 10, [
          "DO_NOT_CONTACT",
          "DO_NOT_CONTACT",
          `${"g".repeat(100)}-first`,
          `${"g".repeat(100)}-second`
        ]);
      }
      throw new Error("battle card should be skipped");
    }
  };
  const state = fixture({ executor });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "unique-public-arrays"
  );

  const completed = await state.service.execute(scope, created.id);

  assert.deepEqual(
    completed.research?.findings[0]?.evidenceIds,
    ["evidence-1", "e".repeat(255)]
  );
  assert.deepEqual(
    completed.qualification?.hardGateFailures,
    ["DO_NOT_CONTACT", "g".repeat(100)]
  );
});

test("recovers an expired running lease and keeps tenant reads isolated", async () => {
  let now = NOW;
  const state = fixture({ now: () => now });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "after-identity-lease-recovery"
  );
  const claimed = await state.repository.claimOperation(
    scope,
    created.id,
    {
      leaseOwner: "crashed-worker",
      leaseToken: "crashed-lease",
      claimedAt: NOW,
      leaseExpiresAt: "2026-08-07T02:01:00.000Z"
    }
  );
  assert.equal(claimed.claimed, true);

  await assert.rejects(
    state.service.execute(scope, created.id),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );

  now = "2026-08-07T02:02:00.000Z";
  const recovered = await state.service.execute(scope, created.id);
  assert.equal(recovered.status, "succeeded");

  await assert.rejects(
    state.service.get({
      ...scope,
      ownerId: "other-owner"
    }, created.id),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "RESOURCE_NOT_FOUND"
  );
});

test("finds the latest candidate operation and lists only queued or expired-running recovery work", async () => {
  let now = "2026-08-07T02:00:00.000Z";
  const state = fixture({ now: () => now });
  const first = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "latest-first"
  );
  now = "2026-08-07T02:01:00.000Z";
  const second = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "latest-second"
  );
  assert.equal(
    (await state.service.findLatestForCandidate(
      scope,
      "candidate-a"
    ))?.id,
    second.id
  );
  assert.equal(
    await state.service.findLatestForCandidate(
      { ...scope, ownerId: "other-owner" },
      "candidate-a"
    ),
    null
  );

  const claimed = await state.repository.claimOperation(
    scope,
    first.id,
    {
      leaseOwner: "crashed-worker",
      leaseToken: "expired-token",
      claimedAt: now,
      leaseExpiresAt: "2026-08-07T02:01:30.000Z"
    }
  );
  assert.equal(claimed.claimed, true);
  const failedCandidate = candidate("candidate-failed");
  state.candidates.set(failedCandidate.id, failedCandidate);
  const failed = await state.service.createAfterIdentity(
    scope,
    failedCandidate.id,
    "latest-failed"
  );
  const failingService = new AcquisitionCandidateIntelligenceOperationService({
    repository: state.repository,
    candidates: {
      async getCandidate(_scope, id) {
        return structuredClone(state.candidates.get(id) ?? null);
      }
    },
    sessionFactory: {
      async createSession(input) {
        return { sessionId: `unused:${input.candidateId}` };
      }
    },
    executor: {
      async execute() {
        throw new Error("untrusted failure");
      }
    },
    workerId: "failing-worker",
    leaseTokenFactory: () => "failing-token",
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 20_000,
    now: () => now
  });
  const failedResult = await failingService.execute(scope, failed.id);
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.failure?.errorCode, "TOOL_EXECUTION_FAILED");

  now = "2026-08-07T02:02:00.000Z";
  const recoverable = await state.service.listRecoverableOperations({
    limit: 10
  });
  assert.deepEqual(recoverable.map((item) => item.id).sort(), [
    first.id,
    second.id
  ].sort());
  assert.equal(recoverable.some((item) => item.id === failed.id), false);
});

test("pins the resolved identity and stops before the next tool when its binding changes", async () => {
  const calls: AcquisitionToolExecutionInput[] = [];
  const mutable = candidate("candidate-a");
  let resolveResearch!: (value: unknown) => void;
  const researchPending = new Promise<unknown>((resolve) => {
    resolveResearch = resolve;
  });
  const state = fixture({
    candidates: [mutable],
    executor: {
      async execute(input) {
        calls.push(structuredClone({ ...input, signal: undefined }));
        if (input.toolName === "research_candidate") {
          return researchPending;
        }
        return qualification("A", 90);
      }
    }
  });
  const created = await state.service.createAfterIdentity(
    scope,
    mutable.id,
    "identity-pin"
  );
  assert.match(created.identityFingerprint, /^sha256:[a-f0-9]{64}$/u);
  const execution = state.service.execute(scope, created.id);
  await new Promise((resolve) => setImmediate(resolve));
  const rebound = candidate("candidate-a");
  if (rebound.partyRef.partyType === "individual") {
    rebound.partyRef.individualPartyId = "individual-rebound";
  }
  state.candidates.set(rebound.id, rebound);
  resolveResearch({
    summary: "身份变化前完成的研究",
    findings: []
  });

  const failed = await execution;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.completedStages, ["research"]);
  assert.deepEqual(failed.failure, {
    stage: "qualification",
    errorCode: "IDENTITY_BINDING_CHANGED"
  });
  assert.deepEqual(calls.map((item) => item.toolName), [
    "research_candidate"
  ]);
  assert.equal(
    calls[0]?.idempotencyKey.includes(created.identityFingerprint),
    false,
    "the raw fingerprint is hashed into, not exposed by, the stage key"
  );
});

test("caps persisted research output before storing it", async () => {
  const state = fixture({
    executor: {
      async execute(input) {
        if (input.toolName === "research_candidate") {
          return {
            summary: "摘".repeat(9_000),
            findings: Array.from({ length: 120 }, (_, index) => ({
              label: `标签-${index}-${"长".repeat(250)}`,
              content: "内容".repeat(3_000),
              evidenceIds: Array.from(
                { length: 120 },
                (__, evidenceIndex) => `evidence-${evidenceIndex}`
              ),
              confidence: 0.8
            }))
          };
        }
        if (input.toolName === "qualify_candidate") {
          return qualification("B", 50);
        }
        throw new Error("battle card should be skipped");
      }
    }
  });
  const created = await state.service.createAfterIdentity(
    scope,
    "candidate-a",
    "bounded-output"
  );

  const completed = await state.service.execute(scope, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.research?.summary.length, 8_000);
  assert.equal(completed.research?.findings.length, 100);
  assert.equal(completed.research?.findings[0]?.label.length, 200);
  assert.equal(completed.research?.findings[0]?.content.length, 4_000);
  assert.equal(completed.research?.findings[0]?.evidenceIds.length, 100);
});

class ManualHeartbeatScheduler
implements AcquisitionCandidateIntelligenceHeartbeatScheduler {
  readonly callbacks = new Set<() => void>();

  setInterval(callback: () => void) {
    this.callbacks.add(callback);
    return callback;
  }

  clearInterval(handle: unknown) {
    this.callbacks.delete(handle as () => void);
  }

  async tick() {
    for (const callback of [...this.callbacks]) callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("heartbeats retain a long-running lease against a second service", async () => {
  let now = NOW;
  const repository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const scheduler = new ManualHeartbeatScheduler();
  let resolveResearch!: (value: unknown) => void;
  const researchPending = new Promise<unknown>((resolve) => {
    resolveResearch = resolve;
  });
  const callsA: AcquisitionToolExecutionInput[] = [];
  const serviceA = fixture({
    repository,
    now: () => now,
    workerId: "worker-a",
    heartbeatScheduler: scheduler,
    executor: {
      async execute(input) {
        callsA.push(structuredClone({ ...input, signal: undefined }));
        if (input.toolName === "research_candidate") return researchPending;
        if (input.toolName === "qualify_candidate") {
          return qualification("B", 50);
        }
        throw new Error("unexpected card");
      }
    }
  });
  const serviceB = fixture({
    repository,
    now: () => now,
    workerId: "worker-b"
  });
  const created = await serviceA.service.createAfterIdentity(
    scope,
    "candidate-a",
    "heartbeat-retains-lease"
  );
  const runningA = serviceA.service.execute(scope, created.id);
  await new Promise((resolve) => setImmediate(resolve));

  now = "2026-08-07T02:00:30.000Z";
  await scheduler.tick();
  now = "2026-08-07T02:01:10.000Z";
  await assert.rejects(
    serviceB.service.execute(scope, created.id),
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );

  resolveResearch({ summary: "长任务研究完成", findings: [] });
  const completed = await runningA;
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(callsA.map((item) => item.toolName), [
    "research_candidate",
    "qualify_candidate"
  ]);
});

test("a worker that loses its lease aborts safely while the new owner completes", async () => {
  let now = NOW;
  const repository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const schedulerA = new ManualHeartbeatScheduler();
  let firstSignal: AbortSignal | undefined;
  const serviceA = fixture({
    repository,
    now: () => now,
    workerId: "worker-a",
    heartbeatScheduler: schedulerA,
    executor: {
      execute(input) {
        firstSignal = input.signal;
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            reject(new DOMException("lease lost", "AbortError"));
          }, { once: true });
        });
      }
    }
  });
  const callsB: AcquisitionToolExecutionInput[] = [];
  const serviceB = fixture({
    repository,
    now: () => now,
    workerId: "worker-b",
    executor: successfulExecutor(callsB, "B", 55)
  });
  const created = await serviceA.service.createAfterIdentity(
    scope,
    "candidate-a",
    "lease-loss-race"
  );
  const staleExecution = serviceA.service.execute(scope, created.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSignal?.aborted, false);

  now = "2026-08-07T02:01:01.000Z";
  const winningExecution = serviceB.service.execute(scope, created.id);
  await new Promise((resolve) => setImmediate(resolve));
  await schedulerA.tick();
  await assert.rejects(
    staleExecution,
    (error: unknown) =>
      error instanceof AcquisitionCandidateIntelligenceOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  assert.equal(firstSignal?.aborted, true);

  const winner = await winningExecution;
  assert.equal(winner.status, "succeeded");
  assert.deepEqual(callsB.map((item) => item.toolName), [
    "research_candidate",
    "qualify_candidate"
  ]);
});
