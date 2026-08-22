import assert from "node:assert/strict";
import test from "node:test";
import {
  claimFinancialCouncilDispatchOperation,
  createFinancialCouncilDispatchOperation,
  completeFinancialCouncilDispatchOperation
} from "./financial-council-dispatch-operation.js";

const T0 = "2026-08-16T08:00:00.000Z";
const T1 = "2026-08-16T08:01:00.000Z";

test("current dispatch lease rejects completion at exact expiry", () => {
  const operation = createFinancialCouncilDispatchOperation({
    dispatchId: `sha256:${"a".repeat(64)}`,
    workspaceId: "ws-1",
    runId: "run-1",
    approvalId: `sha256:${"b".repeat(64)}`,
    approvalHash: `sha256:${"c".repeat(64)}`,
    portfolioRevision: 1,
    portfolioKind: "balanced",
    actionId: `sha256:${"d".repeat(64)}`,
    actionHash: `sha256:${"e".repeat(64)}`,
    resultHash: `sha256:${"f".repeat(64)}`,
    portfolioOutputHash: `sha256:${"0".repeat(64)}`,
    createdAt: T0
  });
  const running = {
    ...operation,
    status: "running" as const,
    attempt: 1,
    leaseWorkerId: "worker-a",
    leaseToken: "1".repeat(64),
    claimedAt: T0,
    leaseExpiresAt: T1,
    updatedAt: T0
  };

  assert.throws(() => completeFinancialCouncilDispatchOperation(running, {
    workerId: "worker-a",
    leaseToken: "1".repeat(64),
    attempt: 1,
    completedAt: T1,
    receiptId: `sha256:${"2".repeat(64)}`
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_dispatch_lease_stale");
});

test("same worker reclaim fences the prior dispatch attempt", () => {
  const queued = createFinancialCouncilDispatchOperation({
    dispatchId: `sha256:${"3".repeat(64)}`,
    workspaceId: "ws-1", runId: "run-1",
    approvalId: `sha256:${"4".repeat(64)}`,
    approvalHash: `sha256:${"5".repeat(64)}`,
    portfolioRevision: 1, portfolioKind: "balanced",
    actionId: `sha256:${"6".repeat(64)}`,
    actionHash: `sha256:${"7".repeat(64)}`,
    resultHash: `sha256:${"8".repeat(64)}`,
    portfolioOutputHash: `sha256:${"9".repeat(64)}`,
    createdAt: T0
  });
  const first = claimFinancialCouncilDispatchOperation(queued, {
    workerId: "worker-a", leaseToken: "a".repeat(64),
    claimedAt: T0, leaseExpiresAt: T1
  })!;
  const second = claimFinancialCouncilDispatchOperation(first.operation, {
    workerId: "worker-a", leaseToken: "b".repeat(64),
    claimedAt: T1, leaseExpiresAt: "2026-08-16T08:02:00.000Z"
  })!;

  assert.equal(second.lease.attempt, 2);
  assert.throws(() => completeFinancialCouncilDispatchOperation(second.operation, {
    workerId: first.lease.workerId, leaseToken: first.lease.leaseToken,
    attempt: first.lease.attempt, completedAt: "2026-08-16T08:01:30.000Z",
    receiptId: `sha256:${"c".repeat(64)}`
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_dispatch_lease_stale");
});
