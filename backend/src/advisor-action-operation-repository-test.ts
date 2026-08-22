import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAdvisorActionOperationRepository
} from "./advisor-action-operation-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  advisorActionError,
  stableAdvisorActionHash,
  type AdvisorActionReceipt,
  type FrozenAdvisorActionInput
} from "./advisor-action-operation.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "manager-1",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze([]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function command(key: string, actorId = "manager-1"): CommandContext {
  return Object.freeze({
    workspace,
    actorId,
    idempotencyKey: key,
    requestHash: canonicalGrowthRequestHash({ key }),
    expectedRevision: null
  });
}

function frozenInput(
  overrides: Partial<FrozenAdvisorActionInput> = {}
): FrozenAdvisorActionInput {
  return {
    recommendationId: "recommendation-1",
    recommendationRevision: 2,
    requestingActorId: "manager-1",
    stableActionHash: `sha256:${"a".repeat(64)}`,
    frozenAction: {
      kind: "create_sales_todo",
      customerId: "customer-1",
      dueAt: "2026-08-10T08:00:00.000Z"
    },
    ...overrides
  };
}

function receiptFixture(
  operationId: string,
  overrides: Partial<AdvisorActionReceipt> = {}
): AdvisorActionReceipt {
  return {
    id: `receipt-${operationId}`,
    operationId,
    workspaceId: "ws-1",
    recommendationId: "recommendation-1",
    recommendationRevision: 2,
    stableActionHash: `sha256:${"a".repeat(64)}`,
    actionKind: "create_sales_todo",
    resourceRefs: Object.freeze([
      { kind: "sales_todo", id: "customer-1" }
    ]),
    contentHash: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-09T08:00:30.000Z",
    ...overrides
  };
}

test("enqueue deduplicates one stable action and blocks expiry", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const first = await repository.enqueue(command("enqueue-1"), frozenInput());
  const replay = await repository.enqueue(
    command("enqueue-2"), frozenInput()
  );
  assert.equal(replay.id, first.id);
  assert.equal(first.status, "queued");
  assert.equal(first.fencingToken, 1);
  assert.equal(
    await repository.hasBlockingOperation(
      {} as never, "ws-1", "recommendation-1"
    ),
    true
  );
  assert.equal(
    await repository.hasBlockingOperation(
      {} as never, "ws-1", "recommendation-other"
    ),
    false
  );
});

test("claim, renew, complete and fail honor the lease fence", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const operation = await repository.enqueue(
    command("enqueue-claim"), frozenInput()
  );
  const claim = await repository.claim(operation.id, {
    leaseOwner: "worker-a",
    leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  assert.ok(claim);
  assert.equal(claim.fencingToken, 2);
  assert.equal(claim.leaseExpiresAt, "2026-08-09T08:00:01.000Z");
  const concurrent = await repository.claim(operation.id, {
    leaseOwner: "worker-b",
    leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.500Z"
  });
  assert.equal(concurrent, null);
  const renewed = await repository.renew(
    claim, "2026-08-09T08:00:00.900Z", 1_000
  );
  assert.equal(renewed.leaseExpiresAt, "2026-08-09T08:00:01.900Z");
  const completed = await repository.complete(
    renewed, receiptFixture(operation.id), "2026-08-09T08:00:00.950Z"
  );
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.receiptId, `receipt-${operation.id}`);
  assert.equal((await repository.listReceiptsFor("ws-1", "recommendation-1")).length, 1);
});

test("expired or stale action workers cannot persist receipts", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const operation = await repository.enqueue(
    command("enqueue-expire"), frozenInput()
  );
  const claim = await repository.claim(operation.id, {
    leaseOwner: "worker-a",
    leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  assert.ok(claim);
  await assert.rejects(
    repository.complete(
      claim,
      receiptFixture(operation.id),
      "2026-08-09T08:00:01.001Z"
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "stale_advisor_action_fence"
  );
  assert.equal((await repository.listReceiptsFor("ws-1", "recommendation-1")).length, 0);
});

test("retryable failure returns to queued and becomes recoverable", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const operation = await repository.enqueue(
    command("enqueue-retry"), frozenInput()
  );
  const claim = await repository.claim(operation.id, {
    leaseOwner: "worker-a",
    leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  assert.ok(claim);
  await repository.fail(claim, {
    errorCode: "advisor_action_execution_failed",
    retryable: true
  }, "2026-08-09T08:00:00.500Z");
  const recoverable = await repository.listRecoverable(
    "2026-08-09T08:01:00.000Z", 10
  );
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.status, "queued");
  assert.equal(recoverable[0]?.lastErrorCode, "advisor_action_execution_failed");
});

test("non-retryable failure is terminal and blocks nothing", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const operation = await repository.enqueue(
    command("enqueue-fatal"), frozenInput()
  );
  const claim = await repository.claim(operation.id, {
    leaseOwner: "worker-a",
    leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  assert.ok(claim);
  await repository.fail(claim, {
    errorCode: "advisor_action_authorization_revoked",
    retryable: false
  }, "2026-08-09T08:00:00.500Z");
  assert.equal(
    (await repository.findByStableHash(
      workspace, `sha256:${"a".repeat(64)}`
    ))?.status,
    "failed"
  );
  assert.equal(
    await repository.hasBlockingOperation(
      {} as never, "ws-1", "recommendation-1"
    ),
    false
  );
});

test("stable hash identity is unique across recommendations and revisions", async () => {
  const repository = new InMemoryAdvisorActionOperationRepository();
  const first = await repository.enqueue(
    command("enqueue-unique-1"),
    frozenInput({
      recommendationRevision: 1,
      stableActionHash: stableAdvisorActionHash({
        workspaceId: "ws-1",
        recommendationId: "recommendation-1",
        recommendationRevision: 1,
        recommendedAction: {
          kind: "create_sales_todo",
          customerId: "customer-1",
          dueAt: "2026-08-10T08:00:00.000Z"
        },
        bindingSnapshotHash: `sha256:${"a".repeat(64)}`
      })
    })
  );
  const second = await repository.enqueue(
    command("enqueue-unique-2"),
    frozenInput({
      recommendationRevision: 2,
      stableActionHash: stableAdvisorActionHash({
        workspaceId: "ws-1",
        recommendationId: "recommendation-1",
        recommendationRevision: 2,
        recommendedAction: {
          kind: "create_sales_todo",
          customerId: "customer-1",
          dueAt: "2026-08-10T08:00:00.000Z"
        },
        bindingSnapshotHash: `sha256:${"a".repeat(64)}`
      })
    })
  );
  assert.notEqual(first.id, second.id);
  assert.equal(
    (await repository.findByStableHash(workspace, first.stableActionHash))?.id,
    first.id
  );
  assert.equal(
    (await repository.findByStableHash(workspace, second.stableActionHash))?.id,
    second.id
  );
});

test("operation errors carry stable advisor action codes", () => {
  const error = advisorActionError("advisor_action_lease_invalid");
  assert.equal(error.code, "advisor_action_lease_invalid");
  assert.equal(error.message, "advisor_action_lease_invalid");
});
