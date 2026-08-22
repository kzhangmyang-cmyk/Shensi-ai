import assert from "node:assert/strict";
import test from "node:test";
import {
  advisorActionReceiptContentHash,
  assertAdvisorActionClaim,
  stableAdvisorActionHash,
  type AdvisorActionOperation,
  type AdvisorActionReceipt
} from "./advisor-action-operation.js";

function operationFixture(
  overrides: Partial<AdvisorActionOperation> = {}
): AdvisorActionOperation {
  return Object.freeze({
    id: "advisor-action-1",
    workspaceId: "ws-1",
    recommendationId: "recommendation-1",
    recommendationRevision: 2,
    requestingActorId: "manager-1",
    stableActionHash: `sha256:${"a".repeat(64)}`,
    frozenAction: {
      kind: "create_sales_todo",
      customerId: "customer-1",
      dueAt: "2026-08-10T08:00:00.000Z"
    },
    status: "running",
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-08-09T08:01:00.000Z",
    fencingToken: 2,
    attempts: 1,
    receiptId: null,
    retryable: true,
    lastErrorCode: null,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:30.000Z",
    ...overrides
  });
}

test("stable advisor action hash is deterministic over the frozen action and binding snapshot", () => {
  const input = {
    workspaceId: "ws-1",
    recommendationId: "recommendation-1",
    recommendationRevision: 2,
    recommendedAction: {
      kind: "create_quote_approval_task" as const,
      quoteVersionId: "quote-v1",
      quoteVersionRevision: 4
    },
    bindingSnapshotHash: `sha256:${"b".repeat(64)}`
  };
  const first = stableAdvisorActionHash(input);
  const second = stableAdvisorActionHash({ ...input });
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(
    first,
    stableAdvisorActionHash({
      ...input,
      recommendedAction: {
        kind: "create_sales_todo",
        customerId: "customer-1",
        dueAt: "2026-08-10T08:00:00.000Z"
      }
    })
  );
});

test("receipt content hash freezes operation identity and resource refs", () => {
  const receipt: Omit<AdvisorActionReceipt, "contentHash" | "createdAt"> = {
    id: "receipt-1",
    operationId: "advisor-action-1",
    workspaceId: "ws-1",
    recommendationId: "recommendation-1",
    recommendationRevision: 2,
    stableActionHash: `sha256:${"a".repeat(64)}`,
    actionKind: "create_sales_todo",
    resourceRefs: Object.freeze([
      { kind: "sales_todo", id: "customer-1" }
    ])
  };
  const hash = advisorActionReceiptContentHash(receipt);
  assert.match(hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    advisorActionReceiptContentHash(structuredClone(receipt)),
    hash
  );
});

test("claim fence rejects stale lease owners, tokens, and expired leases", () => {
  const operation = operationFixture();
  const claim = {
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    leaseOwner: "worker-a",
    fencingToken: 2,
    leaseExpiresAt: "2026-08-09T08:01:00.000Z"
  };
  assert.doesNotThrow(() =>
    assertAdvisorActionClaim(operation, claim, "2026-08-09T08:00:30.000Z"));
  assert.throws(
    () => assertAdvisorActionClaim(
      operation,
      { ...claim, leaseOwner: "worker-b" },
      "2026-08-09T08:00:30.000Z"
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "stale_advisor_action_fence"
  );
  assert.throws(
    () => assertAdvisorActionClaim(
      operation,
      { ...claim, fencingToken: 3 },
      "2026-08-09T08:00:30.000Z"
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "stale_advisor_action_fence"
  );
  assert.throws(
    () => assertAdvisorActionClaim(
      operation,
      claim,
      "2026-08-09T08:02:00.000Z"
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "stale_advisor_action_fence"
  );
});
