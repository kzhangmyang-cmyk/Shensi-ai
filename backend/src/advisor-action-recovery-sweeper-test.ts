import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorActionRecoverySweeper,
  type AdvisorActionRecoveryAuthorizer
} from "./advisor-action-recovery-sweeper.js";
import {
  InMemoryAdvisorActionOperationRepository
} from "./advisor-action-operation-repository.js";
import {
  stableAdvisorActionHash,
  type AdvisorActionOperation,
  type AdvisorActionReceipt
} from "./advisor-action-operation.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "sales-a",
  role: "sales",
  teamId: "ws-1",
  capabilities: Object.freeze(["todo.create"]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

const stableHash = stableAdvisorActionHash({
  workspaceId: "ws-1",
  recommendationId: "recommendation-ack",
  recommendationRevision: 2,
  recommendedAction: {
    kind: "create_sales_todo",
    customerId: "customer-1",
    dueAt: "2026-08-10T08:00:00.000Z"
  },
  bindingSnapshotHash: `sha256:${"a".repeat(64)}`
});

function capabilitySet() {
  const granted = new Map<string, Set<string>>([
    ["sales-a", new Set(["todo.create"])]
  ]);
  return {
    revoke(actorId: string, capability: string) {
      granted.get(actorId)?.delete(capability);
    },
    has(actorId: string, capability: string) {
      return granted.get(actorId)?.has(capability) ?? false;
    }
  };
}

function resourceLedger() {
  const created = new Map<string, number>();
  return {
    createdForStableActionHash(hash: string) {
      return created.get(hash) ?? 0;
    },
    create(hash: string) {
      created.set(hash, (created.get(hash) ?? 0) + 1);
    }
  };
}

function handlerFixture(
  resources: ReturnType<typeof resourceLedger>,
  options: { throwAfterCommitOnce?: boolean } = {}
) {
  const executeCalls: string[] = [];
  const probeCalls: string[] = [];
  return {
    executeCalls,
    probeCalls,
    handler: {
      async probeByStableActionHash(
        _context: ActiveWorkspaceContext,
        operation: AdvisorActionOperation
      ): Promise<AdvisorActionReceipt | null> {
        probeCalls.push(operation.stableActionHash);
        if (resources.createdForStableActionHash(operation.stableActionHash) > 0) {
          return {
            id: `receipt-${operation.id}`,
            operationId: operation.id,
            workspaceId: operation.workspaceId,
            recommendationId: operation.recommendationId,
            recommendationRevision: operation.recommendationRevision,
            stableActionHash: operation.stableActionHash,
            actionKind: "create_sales_todo",
            resourceRefs: Object.freeze([
              { kind: "sales_todo", id: "customer-1" }
            ]),
            contentHash: `sha256:${"c".repeat(64)}`,
            createdAt: "2026-08-09T08:00:00.000Z"
          };
        }
        return null;
      },
      async execute(
        _command: CommandContext,
        operation: AdvisorActionOperation
      ): Promise<AdvisorActionReceipt> {
        executeCalls.push(operation.stableActionHash);
        resources.create(operation.stableActionHash);
        if (options.throwAfterCommitOnce) {
          throw new Error("simulated_ack_loss");
        }
        return {
          id: `receipt-${operation.id}`,
          operationId: operation.id,
          workspaceId: operation.workspaceId,
          recommendationId: operation.recommendationId,
          recommendationRevision: operation.recommendationRevision,
          stableActionHash: operation.stableActionHash,
          actionKind: "create_sales_todo",
          resourceRefs: Object.freeze([
            { kind: "sales_todo", id: "customer-1" }
          ]),
          contentHash: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-08-09T08:00:00.000Z"
        };
      }
    }
  };
}

function enqueuedOperation(
  repository: InMemoryAdvisorActionOperationRepository
) {
  return repository.enqueue(
    Object.freeze({
      workspace,
      actorId: "sales-a",
      idempotencyKey: "enqueue-ack",
      requestHash: `sha256:${"b".repeat(64)}`,
      expectedRevision: 2
    }),
    {
      recommendationId: "recommendation-ack",
      recommendationRevision: 2,
      requestingActorId: "sales-a",
      stableActionHash: stableHash,
      frozenAction: {
        kind: "create_sales_todo",
        customerId: "customer-1",
        dueAt: "2026-08-10T08:00:00.000Z"
      }
    }
  );
}

test("post-side-effect ACK loss is repaired after capability revocation without repeating the action", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const resources = resourceLedger();
  const capabilities = capabilitySet();
  const handler = handlerFixture(resources, { throwAfterCommitOnce: true });
  const operation = await enqueuedOperation(repository);
  const claim = await repository.claim(operation.id, {
    leaseOwner: "dispatch:sales-a",
    leaseDurationMs: 60_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  assert.ok(claim);
  await assert.rejects(
    handler.handler.execute(
      Object.freeze({ workspace, actorId: "sales-a" }) as CommandContext,
      operation
    ),
    /simulated_ack_loss/u
  );
  await repository.fail(claim, {
    errorCode: "advisor_action_execution_failed",
    retryable: true
  }, "2026-08-09T08:00:00.500Z");
  capabilities.revoke("sales-a", "todo.create");
  const authorizer: AdvisorActionRecoveryAuthorizer = {
    async authorizeProbe() {
      return workspace;
    },
    async authorizeExecution(actual) {
      if (!capabilities.has(actual.requestingActorId, "todo.create")) {
        throw new Error("advisor_action_authorization_revoked");
      }
      return Object.freeze({
        workspace,
        actorId: actual.requestingActorId,
        idempotencyKey: `recovery:${actual.stableActionHash}`,
        requestHash: `sha256:${"d".repeat(64)}`,
        expectedRevision: actual.recommendationRevision
      });
    }
  };
  const recovery = new AdvisorActionRecoverySweeper({
    repository,
    authorizer,
    salesTodoHandler: handler.handler,
    now: () => "2026-08-09T08:01:00.000Z"
  });
  await recovery.sweep();
  await recovery.close();
  const finalOperation = await repository.findByStableHash(
    workspace, stableHash
  );
  assert.equal(finalOperation?.status, "succeeded");
  assert.equal(handler.executeCalls.length, 1);
  assert.equal(handler.probeCalls.length, 1);
  assert.equal(
    resources.createdForStableActionHash(stableHash),
    1
  );
  assert.equal(
    (await repository.listReceiptsFor("ws-1", "recommendation-ack")).length,
    1
  );
});

test("revocation before a side effect creates no resource or receipt", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const resources = resourceLedger();
  const capabilities = capabilitySet();
  const handler = handlerFixture(resources);
  await enqueuedOperation(repository);
  capabilities.revoke("sales-a", "todo.create");
  const authorizer: AdvisorActionRecoveryAuthorizer = {
    async authorizeProbe() {
      return workspace;
    },
    async authorizeExecution(actual) {
      if (!capabilities.has(actual.requestingActorId, "todo.create")) {
        throw new Error("advisor_action_authorization_revoked");
      }
      return Object.freeze({
        workspace,
        actorId: actual.requestingActorId,
        idempotencyKey: `recovery:${actual.stableActionHash}`,
        requestHash: `sha256:${"d".repeat(64)}`,
        expectedRevision: actual.recommendationRevision
      });
    }
  };
  const recovery = new AdvisorActionRecoverySweeper({
    repository,
    authorizer,
    salesTodoHandler: handler.handler,
    now: () => "2026-08-09T08:01:00.000Z"
  });
  await recovery.sweep();
  await recovery.close();
  const finalOperation = await repository.findByStableHash(
    workspace, stableHash
  );
  assert.equal(finalOperation?.status, "failed");
  assert.equal(
    finalOperation?.lastErrorCode,
    "advisor_action_authorization_revoked"
  );
  assert.equal(handler.executeCalls.length, 0);
  assert.equal(
    resources.createdForStableActionHash(stableHash),
    0
  );
  assert.equal(
    (await repository.listReceiptsFor("ws-1", "recommendation-ack")).length,
    0
  );
});
