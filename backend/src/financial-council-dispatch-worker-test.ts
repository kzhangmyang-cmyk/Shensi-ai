import assert from "node:assert/strict";
import test from "node:test";
import { FinancialCouncilDispatchWorker } from "./financial-council-dispatch-worker.js";
import { createFinancialCouncilDispatchOperation } from "./financial-council-dispatch-operation.js";

const T0 = "2026-08-16T08:00:00.000Z";
const operation = createFinancialCouncilDispatchOperation({
  dispatchId: `sha256:${"a".repeat(64)}`, workspaceId: "ws-1", runId: "run-1",
  approvalId: `sha256:${"b".repeat(64)}`, approvalHash: `sha256:${"c".repeat(64)}`,
  portfolioRevision: 1, portfolioKind: "balanced", actionId: `sha256:${"d".repeat(64)}`,
  actionHash: `sha256:${"e".repeat(64)}`, resultHash: `sha256:${"f".repeat(64)}`,
  portfolioOutputHash: `sha256:${"0".repeat(64)}`, createdAt: T0
});

test("crash after draft creation replays the probed resource without creating again", async () => {
  let creates = 0; let completion = 0; let resource: any = null;
  const worker = new FinancialCouncilDispatchWorker({
    repository: {
      async claimDispatchOperation() { return { dispatchId: operation.dispatchId, workspaceId: "ws-1", workerId: "w", leaseToken: "1".repeat(64), attempt: completion + 1, claimedAt: T0, leaseExpiresAt: "2026-08-16T08:01:00.000Z" }; },
      async loadDispatchExecution() { return { operation, action: {}, approvalProof: {}, context: { workspaceId: "ws-1" } }; },
      async completeDispatchOperation() { completion += 1; if (completion === 1) throw new Error("crash"); },
      async failDispatchOperation() {}
    },
    adapter: { async adapt() { return { kind: "council_draft" as const, draft: {} as never }; } },
    drafts: {
      async probeByDispatchHash() { return resource; },
      async createFromApprovedDispatch() { creates += 1; resource = { resourceRefs: [{ kind: "financial_council_draft", id: "draft-1" }], contentHash: `sha256:${"9".repeat(64)}` as const }; return { value: resource, replayed: false }; }
    } as never,
    workerId: "w", now: () => T0, leaseTokenFactory: () => "1".repeat(64)
  });
  await assert.rejects(worker.wake({ workspaceId: "ws-1", dispatchId: operation.dispatchId }));
  await worker.wake({ workspaceId: "ws-1", dispatchId: operation.dispatchId });
  assert.equal(creates, 1);
});
