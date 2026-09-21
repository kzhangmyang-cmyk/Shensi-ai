import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorActionDispatcher,
  type AdvisorActionToolPorts
} from "./advisor-action-dispatcher.js";
import {
  InMemoryAdvisorActionOperationRepository
} from "./advisor-action-operation-repository.js";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  recommendationFixture
} from "./advisor-recommendation-domain-test.js";
import {
  AdvisorRecommendationAuthorizer
} from "./advisor-recommendation-service.js";
import {
  createGrowthWorkspaceMemberAssignabilityReader
} from "./growth-workspace-member-assignability.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  stableAdvisorActionHash,
  type AdvisorActionReceipt
} from "./advisor-action-operation.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { AdvisorRecommendation } from "./advisor-recommendation-domain.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "manager-1",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze([]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function command(key: string): CommandContext {
  return Object.freeze({
    workspace,
    actorId: "manager-1",
    idempotencyKey: key,
    requestHash: canonicalGrowthRequestHash({ key }),
    expectedRevision: 2
  });
}

function stableHashFor(
  recommendation: AdvisorRecommendation
): `sha256:${string}` {
  return stableAdvisorActionHash({
    workspaceId: recommendation.workspaceId,
    recommendationId: recommendation.id,
    recommendationRevision: recommendation.revision,
    recommendedAction: recommendation.recommendedAction,
    bindingSnapshotHash: recommendation.inputSnapshotHash
  });
}

test("dispatcher loads the accepted frozen action and cannot accept a caller replacement", async () => {
  const stored = recommendationFixture({
    id: "recommendation-1",
    status: "accepted",
    revision: 2,
    recommendedAction: {
      kind: "create_quote_approval_task",
      quoteVersionId: "quote-v1",
      quoteVersionRevision: 4
    }
  });
  const toolCalls: Array<{
    name: string;
    input: unknown;
    stableCallHash: `sha256:${string}`;
  }> = [];
  const toolCommands: Array<{ expectedRevision: number | null }> = [];
  const toolPorts: AdvisorActionToolPorts = {
    async execute(call, child) {
      toolCalls.push({ ...call });
      toolCommands.push({ expectedRevision: child.expectedRevision });
      return { id: "quote-approval-task-1" };
    }
  };
  const dispatcher = new AdvisorActionDispatcher({
    repository: new InMemoryAdvisorActionOperationRepository(),
    recommendations: new InMemoryAdvisorRecommendationRepository([stored]),
    authorizer: new AdvisorRecommendationAuthorizer(
      createGrowthWorkspaceMemberAssignabilityReader({
        members: () => []
      })
    ),
    toolPorts,
    salesTodoHandler: {
      async probeByStableActionHash() {
        return null;
      },
      async execute() {
        throw new Error("unused");
      }
    },
    now: () => "2026-08-09T08:00:00.000Z"
  });
  const receipt = await dispatcher.dispatch(
    command("dispatch-1"), stored.id
  );
  assert.equal(receipt.actionKind, "create_quote_approval_task");
  assert.equal(toolCalls[0]?.name, "create_quote_approval_task");
  assert.equal(toolCommands[0]?.expectedRevision, 4);
  assert.deepEqual(toolCalls[0]?.input, { quoteVersionId: "quote-v1" });
  assert.equal(toolCalls[0]?.stableCallHash, stableHashFor(stored));
});

test("dispatcher replay returns the same persisted receipt without re-executing", async () => {
  const stored = recommendationFixture({
    id: "recommendation-replay",
    status: "accepted",
    revision: 2,
    recommendedAction: {
      kind: "create_sales_todo",
      customerId: "customer-1",
      dueAt: "2026-08-10T08:00:00.000Z"
    }
  });
  let executeCalls = 0;
  const dispatcher = new AdvisorActionDispatcher({
    repository: new InMemoryAdvisorActionOperationRepository(),
    recommendations: new InMemoryAdvisorRecommendationRepository([stored]),
    authorizer: new AdvisorRecommendationAuthorizer(
      createGrowthWorkspaceMemberAssignabilityReader({
        members: () => []
      })
    ),
    toolPorts: {
      async execute() {
        throw new Error("unused");
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
        }
      ): Promise<AdvisorActionReceipt> {
        executeCalls += 1;
        return {
          id: `receipt-todo-${operation.id}`,
          operationId: operation.id,
          workspaceId: operation.workspaceId,
          recommendationId: operation.recommendationId,
          recommendationRevision: operation.recommendationRevision,
          stableActionHash: operation.stableActionHash,
          actionKind: "create_sales_todo",
          resourceRefs: Object.freeze([
            { kind: "sales_todo", id: "customer-1" }
          ]),
          contentHash: `sha256:${"a".repeat(64)}`,
          createdAt: "2026-08-09T08:00:00.000Z"
        };
      }
    },
    now: () => "2026-08-09T08:00:00.000Z"
  });
  const first = await dispatcher.dispatch(
    command("dispatch-replay-1"), stored.id
  );
  const second = await dispatcher.dispatch(
    command("dispatch-replay-2"), stored.id
  );
  assert.equal(first.id, second.id);
  assert.equal(executeCalls, 1);
});

test("dispatcher refuses to run a recommendation that is not accepted", async () => {
  const stored = recommendationFixture({
    id: "recommendation-proposed",
    status: "proposed",
    revision: 1
  });
  const dispatcher = new AdvisorActionDispatcher({
    repository: new InMemoryAdvisorActionOperationRepository(),
    recommendations: new InMemoryAdvisorRecommendationRepository([stored]),
    authorizer: new AdvisorRecommendationAuthorizer(
      createGrowthWorkspaceMemberAssignabilityReader({
        members: () => []
      })
    ),
    toolPorts: {
      async execute() {
        throw new Error("unused");
      }
    },
    salesTodoHandler: {
      async probeByStableActionHash() {
        return null;
      },
      async execute() {
        throw new Error("unused");
      }
    },
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    dispatcher.dispatch(command("dispatch-proposed"), stored.id),
    (error: unknown) =>
      (error as { code?: string }).code === "advisor_recommendation_forbidden"
  );
});

void workspace;
