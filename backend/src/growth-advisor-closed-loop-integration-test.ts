import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorRecommendationService,
  AdvisorRecommendationAuthorizer,
  DefaultAdvisorReferenceVerifier,
  type AdvisorReferenceVerifierPorts
} from "./advisor-recommendation-service.js";
import {
  DefaultAdvisorVisibilityResolver,
  DefaultPriorityCandidateReader
} from "./growth-advisor-query.js";
import {
  InMemoryAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import {
  qualificationAuthorityEventFixture
} from "./growth-advisor-candidate-authority-projection-test.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  InMemoryAdvisorActionOperationRepository
} from "./advisor-action-operation-repository.js";
import {
  AdvisorActionDispatcher
} from "./advisor-action-dispatcher.js";
import {
  stableAdvisorActionHash,
  type AdvisorActionReceipt
} from "./advisor-action-operation.js";
import {
  createGrowthWorkspaceMemberAssignabilityReader
} from "./growth-workspace-member-assignability.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const managerWorkspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "manager-1",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze([
    "catalog.read",
    "pricing.sensitive.read",
    "growth.performance.team.read"
  ]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function command(
  key: string,
  expectedRevision: number | null = null
): CommandContext {
  return Object.freeze({
    workspace: managerWorkspace,
    actorId: "manager-1",
    idempotencyKey: key,
    requestHash: `sha256:${key}`,
    expectedRevision
  });
}

async function createClosedLoopFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  await authority.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1",
    ownerId: "sales-a",
    teamId: "ws-1",
    qualificationSnapshotHash: `sha256:${"1".repeat(64)}`
  }));
  const visibility = new DefaultAdvisorVisibilityResolver({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([{
          quoteVersionId: "quote-v1",
          candidateId: "candidate-1",
          customerId: "customer-1",
          dealId: "deal-1",
          salesOwnerActorId: "sales-a",
          teamId: "ws-1"
        }]);
      }
    },
    cohortBindings: {
      async listVisibleCohorts() {
        return Object.freeze([]);
      }
    }
  });
  const candidateEvidence = new DefaultPriorityCandidateReader({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([]);
      }
    },
    displayNames: {
      async listDisplayNames() {
        return new Map([["candidate-1", "示例企业"]]);
      }
    }
  });
  const binding = Object.freeze({
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    handoffContentHash: `sha256:${"2".repeat(64)}`,
    dealContentHash: `sha256:${"3".repeat(64)}`,
    bindingHashSchemaVersion: "commercial-binding.v1"
  });
  const ports: AdvisorReferenceVerifierPorts = {
    candidateEvidence,
    quote: {
      previews: {
        async verifyAt() {
          return null;
        }
      },
      quoteVersions: {
        async getAt() {
          return {
            quoteCaseId: "quote-case-1",
            quoteVersionId: "quote-v1",
            salesOwnerActorId: "sales-a",
            versionKind: "formal",
            sourceDraftVersionId: "draft-1",
            commercialBindingEvidence: binding,
            probabilityAssessmentId: "assessment-1",
            closeProbabilityBps: 5_000,
            lifecycleRevision: 4,
            status: "submitted",
            currency: "CNY",
            quotedAmountMinor: 1_000_000,
            estimatedGrossProfitMinor: 280_000,
            grossMarginBps: 2_800,
            inputSnapshotHash: `sha256:${"6".repeat(64)}`,
            calculationHash: `sha256:${"7".repeat(64)}`,
            commercialAmountHash: `sha256:${"c".repeat(64)}`,
            lifecycleEventId: "lifecycle-1",
            recordedAt: "2026-08-09T07:00:00.000Z"
          };
        }
      },
      dealAuthoritativeQuotes: {
        async getAt() {
          return null;
        },
        async getDecisionAt() {
          return null;
        }
      }
    },
    finance: {
      async getVerifiedAt() {
        return null;
      },
      financialGaps: {
        async verifyAt() {
          return null;
        }
      }
    },
    roi: {
      growthPerformance: {
        async getAt() {
          return {
            cohortId: "cohort-1",
            currency: "CNY",
            planId: null,
            dataAsOf: "2026-08-09T08:00:00.000Z",
            memberIds: [],
            expectedRoiByCurrency: [],
            actualRoiByCurrency: [],
            cashByCurrency: [],
            coverage: {
              costCoverageBps: 0,
              marginCoverageBps: 0,
              cashCoverageBps: 0,
              attributionCoverageBps: 0,
              gapCodes: []
            },
            dataGaps: [],
            closureVersionId: null,
            formulaVersion: "growth-performance.v1",
            calculationHash: `sha256:${"8".repeat(64)}`,
            membershipSnapshotHash: null
          };
        }
      },
      closureEvidence: {
        async getAt() {
          return null;
        }
      }
    }
  };
  const recommendations = new InMemoryAdvisorRecommendationRepository();
  const actionOperations =
    new InMemoryAdvisorActionOperationRepository();
  const salesTodos: Array<{ customerId: string; dueAt: string }> = [];
  const quotePublications: string[] = [];
  const outboundMessages: string[] = [];
  const authorizer = new AdvisorRecommendationAuthorizer(
    createGrowthWorkspaceMemberAssignabilityReader({
      members: () => [
        { id: "sales-a", teamId: "ws-1", role: "sales" as const,
          status: "active" as const }
      ]
    })
  );
  const service = new AdvisorRecommendationService({
    repository: recommendations,
    visibility,
    verifier: new DefaultAdvisorReferenceVerifier(ports),
    temporalBarrier: barrier,
    assignability: createGrowthWorkspaceMemberAssignabilityReader({
      members: () => [
        { id: "sales-a", teamId: "ws-1", role: "sales" as const,
          status: "active" as const }
      ]
    }),
    actionOperations,
    now: () => "2026-08-09T09:00:00.000Z"
  });
  const dispatcher = new AdvisorActionDispatcher({
    repository: actionOperations,
    recommendations,
    authorizer,
    toolPorts: {
      register() {},
      async execute() {
        throw new Error("quote tool must not be called for sales todo");
      }
    },
    salesTodoHandler: {
      async probeByStableActionHash() {
        return null;
      },
      async execute(
        _command: CommandContext,
        operation: {
          id: string;
          workspaceId: string;
          recommendationId: string;
          recommendationRevision: number;
          stableActionHash: `sha256:${string}`;
          frozenAction: { kind: string; customerId: string; dueAt: string };
        }
      ): Promise<AdvisorActionReceipt> {
        salesTodos.push({
          customerId: operation.frozenAction.customerId,
          dueAt: operation.frozenAction.dueAt
        });
        return Object.freeze({
          id: `receipt-todo-${operation.id}`,
          operationId: operation.id,
          workspaceId: operation.workspaceId,
          recommendationId: operation.recommendationId,
          recommendationRevision: operation.recommendationRevision,
          stableActionHash: operation.stableActionHash,
          actionKind: "create_sales_todo",
          resourceRefs: Object.freeze([
            { kind: "sales_todo", id: operation.frozenAction.customerId }
          ]),
          contentHash: `sha256:${"9".repeat(64)}`,
          createdAt: "2026-08-09T08:00:30.000Z"
        });
      }
    },
    now: () => "2026-08-09T08:00:00.000Z"
  });
  return {
    service,
    dispatcher,
    recommendations,
    actionOperations,
    salesTodos,
    quotePublications,
    outboundMessages,
    visibility
  };
}

test("authoritative facts become a recommendation and one controlled task", async () => {
  const fixture = await createClosedLoopFixture();
  const created = await fixture.service.create(
    command("recommend-tracer"),
    {
      audienceRole: "manager",
      type: "priority_customer",
      summary: "为高意向客户创建销售待办",
      rationale: "客户 customer-1 存在已验证的高意向报价",
      metricRefs: Object.freeze([{
        kind: "priority_score",
        candidateId: "candidate-1",
        qualificationDecisionId: "qualification-1",
        qualificationDecisionVersion: "qualification-v1",
        inputSnapshotHash: `sha256:${"1".repeat(64)}`
      }]),
      evidenceRefs: Object.freeze([]),
      entityRefs: Object.freeze([{
        kind: "customer",
        id: "customer-1",
        quoteVersionId: "quote-v1",
        handoffContentHash: `sha256:${"2".repeat(64)}`,
        bindingHashSchemaVersion: "commercial-binding.v1"
      }]),
      confidenceBps: 8_500,
      riskLevel: "medium",
      recommendedAction: {
        kind: "create_sales_todo",
        customerId: "customer-1",
        dueAt: "2026-08-10T08:00:00.000Z"
      },
      assignedTo: null,
      dataAsOf: "2026-08-09T08:00:00.000Z",
      modelSnapshotRef: "model-snapshot-tracer",
      promptVersion: "growth-advisor.v1",
      generationIdempotencyKey: "generation-tracer"
    }
  );
  assert.equal(created.status, "proposed");
  assert.match(created.inputSnapshotHash, /^sha256:[a-f0-9]{64}$/u);

  const accepted = await fixture.service.accept(
    command("accept-tracer", 1), created.id
  );
  assert.equal(accepted.status, "accepted");

  const receipt = await fixture.dispatcher.dispatch(
    command("dispatch-tracer", accepted.revision), accepted.id
  );
  assert.equal(receipt.actionKind, "create_sales_todo");
  assert.deepEqual(fixture.salesTodos, [{
    customerId: "customer-1",
    dueAt: "2026-08-10T08:00:00.000Z"
  }]);
  assert.equal(fixture.quotePublications.length, 0);
  assert.equal(fixture.outboundMessages.length, 0);

  const completed = await fixture.service.complete(
    command("complete-tracer", accepted.revision + 1),
    accepted.id
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.outcomeRefs, [
    { kind: "action_receipt", id: receipt.id }
  ]);

  const stableHash = stableAdvisorActionHash({
    workspaceId: accepted.workspaceId,
    recommendationId: accepted.id,
    recommendationRevision: accepted.revision,
    recommendedAction: accepted.recommendedAction,
    bindingSnapshotHash: accepted.inputSnapshotHash
  });
  assert.equal(receipt.stableActionHash, stableHash);
  assert.equal(fixture.salesTodos.length, 1);
});

test("replayed dispatch never duplicates the controlled task", async () => {
  const fixture = await createClosedLoopFixture();
  const created = await fixture.service.create(
    command("recommend-replay"),
    {
      audienceRole: "manager",
      type: "priority_customer",
      summary: "重放测试",
      rationale: "同一建议只应产生一个受控任务",
      metricRefs: Object.freeze([{
        kind: "priority_score",
        candidateId: "candidate-1",
        qualificationDecisionId: "qualification-1",
        qualificationDecisionVersion: "qualification-v1",
        inputSnapshotHash: `sha256:${"1".repeat(64)}`
      }]),
      evidenceRefs: Object.freeze([]),
      entityRefs: Object.freeze([{
        kind: "customer",
        id: "customer-1",
        quoteVersionId: "quote-v1",
        handoffContentHash: `sha256:${"2".repeat(64)}`,
        bindingHashSchemaVersion: "commercial-binding.v1"
      }]),
      confidenceBps: 8_500,
      riskLevel: "medium",
      recommendedAction: {
        kind: "create_sales_todo",
        customerId: "customer-1",
        dueAt: "2026-08-10T08:00:00.000Z"
      },
      assignedTo: null,
      dataAsOf: "2026-08-09T08:00:00.000Z",
      modelSnapshotRef: "model-snapshot-replay",
      promptVersion: "growth-advisor.v1",
      generationIdempotencyKey: "generation-replay"
    }
  );
  await fixture.service.accept(command("accept-replay", 1), created.id);
  const first = await fixture.dispatcher.dispatch(
    command("dispatch-replay-1", 2), created.id
  );
  const second = await fixture.dispatcher.dispatch(
    command("dispatch-replay-2", 2), created.id
  );
  assert.equal(first.id, second.id);
  assert.equal(fixture.salesTodos.length, 1);
});
