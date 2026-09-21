import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";

import { AcquisitionOutreachBatchError, AcquisitionOutreachBatchService,
  type OutreachScope } from
  "./acquisition-outreach-batch-service.js";
import { createAcquisitionOutreachBatchRouter } from
  "./acquisition-outreach-batch-router.js";
import type { AcquisitionOutreachAction } from "./acquisition-outreach-batch.js";

const NOW = "2026-08-25T04:00:00.000Z";
const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const scope: OutreachScope = { workspaceId: "workspace-1", ownerId: "owner-1",
  teamId: "team-1", actorId: "owner-1" };

function action(executionTarget: "desktop" | "server",
  status: "reconciliation_required" | "risk_paused" = executionTarget === "desktop"
    ? "reconciliation_required" : "risk_paused"): AcquisitionOutreachAction {
  return { id: "comment-1", workspaceId: "workspace-1", batchId: "batch-1",
    batchRevision: 1, candidateId: "candidate-1", accountId: "account-1",
    accountLoginStateVersion: 3, policyVersionId: "policy-v1",
    localDate: "2026-08-25", kind: "comment", executionTarget, sequence: 1,
    status, predecessorActionId: null,
    targetPublicUrl: "https://www.douyin.com/video/candidate-1",
    content: "exact approved comment", contentHash: digest("content"),
    approvalHash: digest("approval"), createdAt: "2026-08-25T00:00:00.000Z",
    attemptCount: 1, platformReceiptReference: null,
    occurredAt: "2026-08-25T03:59:00.000Z",
    failureCode: "douyin_action_receipt_ambiguous" };
}

function directMessage(): AcquisitionOutreachAction {
  return { ...action("desktop"), id: "message-1", kind: "direct_message",
    sequence: 2, status: "blocked_by_predecessor", predecessorActionId: "comment-1",
    targetPublicUrl: "https://www.douyin.com/user/candidate-1",
    content: "exact approved message", contentHash: digest("message"),
    authorizationVersion: 2, approvedBy: "owner-1",
    approvedAt: "2026-08-25T00:00:00.000Z", directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1, failureCode: null, occurredAt: null };
}

function serviceFixture(executionTarget: "desktop" | "server") {
  const current = action(executionTarget);
  const successor = directMessage();
  let now = NOW;
  let gatewayCalls = 0;
  let serverSuccessCalls = 0;
  const desktopRecords: unknown[] = [];
  const persisted = new Map<string, { requestHash: string;
    value: AcquisitionOutreachAction & {
    reconciliationRequest: { requestedByUserId: string; requestedAt: string;
      expectedExecutionLeaseVersion: number } } }>();
  const repository = {
    async listActions() { return [current, successor]; },
    async find() { return null; },
    async recordDesktopReconciliation(input: { idempotencyKey: string;
      requestHash: string; requestedByUserId: string; requestedAt: string }) {
      desktopRecords.push(input);
      const existing = persisted.get(input.idempotencyKey);
      if (existing) return existing.requestHash === input.requestHash
        ? { kind: "replay", value: existing.value }
        : { kind: "conflict" };
      if (current.status !== "reconciliation_required") return { kind: "stale" };
      const reconciliationRequest = { requestedByUserId: input.requestedByUserId,
        requestedAt: input.requestedAt, expectedExecutionLeaseVersion: 7 };
      const value = { ...current, reconciliationRequest };
      persisted.set(input.idempotencyKey, { requestHash: input.requestHash, value });
      return { kind: "created", value };
    },
    async reconcileActionSuccess() {
      serverSuccessCalls += 1;
      return true;
    }
  };
  const service = new AcquisitionOutreachBatchService({ repository: repository as never,
    douyinOutreachActionsEnabled: true, serverExecutionEnabled: true,
    desktopExecutionEnabled: true, idFactory: (kind) => kind, now: () => now,
    loadRunAuthority: async () => null, listRunCandidateIds: async () => [],
    generateDraft: async () => { throw new Error("unused"); },
    loadCandidateAuthority: async () => null,
    loadAccountAuthority: async () => ({ accountId: "account-1", state: "active",
      loginStateVersion: 3, accountHandle: `dyacct_${"a".repeat(64)}`,
      displayName: "Douyin", executorMode: executionTarget === "desktop"
        ? "desktop" as const : "server" as const,
      executorDeviceIdHash: executionTarget === "desktop" ? digest("device") : null,
      executorBindingGeneration: executionTarget === "desktop" ? 4 : 0,
      executorLeaseExpiresAt: executionTarget === "desktop"
        ? "2026-08-25T04:02:00.000Z" : null }),
    reconcileAction: async (input) => {
      gatewayCalls += 1;
      return { actionId: input.actionId, state: "succeeded" as const,
        platformReceiptReference: "douyin-comment:server-reconciled",
        occurredAt: NOW, failureCode: null };
    }
  });
  return { service, current, successor, desktopRecords,
    manualRecord: { requestedByUserId: scope.actorId, requestedAt: NOW,
      expectedExecutionLeaseVersion: 7 },
    setNow(value: string) { now = value; },
    gatewayCalls: () => gatewayCalls, serverSuccessCalls: () => serverSuccessCalls };
}

const command = (value: AcquisitionOutreachAction) => ({
  batchRevision: value.batchRevision, approvalHash: value.approvalHash,
  contentHash: value.contentHash, confirm: true as const
});

async function reconcile(service: AcquisitionOutreachBatchService,
  batchId: string, actionId: string, idempotencyKey: string,
  input: ReturnType<typeof command>) {
  return (service.reconcileAction as unknown as (
    scope: OutreachScope, batchId: string, actionId: string,
    idempotencyKey: string, input: ReturnType<typeof command>) => Promise<unknown>)(
      scope, batchId, actionId, idempotencyKey, input);
}

test("desktop human reconciliation records one fenced request and calls no gateway", async () => {
  const value = serviceFixture("desktop");
  const result = await reconcile(value.service, value.current.batchId, value.current.id,
    "manual-reconciliation-key-1", command(value.current)) as AcquisitionOutreachAction;

  assert.equal(result.status, "reconciliation_required");
  assert.equal("reconciliationRequest" in result, false,
    "private audit metadata must not change the public action contract");
  assert.equal(value.gatewayCalls(), 0);
  assert.equal(value.serverSuccessCalls(), 0);
  assert.equal(value.desktopRecords.length, 1);
  const persisted = value.desktopRecords[0] as Record<string, unknown>;
  assert.equal(persisted.requestedByUserId, scope.actorId);
  assert.equal(persisted.requestedAt, NOW);
  assert.equal(persisted.idempotencyKey, "manual-reconciliation-key-1");
  assert.equal(value.successor.status, "blocked_by_predecessor",
    "requesting reconciliation is not a successful predecessor receipt");
});

test("desktop manual reconciliation keeps replay and conflict semantics after terminalization",
  async () => {
    const value = serviceFixture("desktop");
    const first = await reconcile(value.service, value.current.batchId, value.current.id,
      "manual-reconciliation-key-1", command(value.current)) as AcquisitionOutreachAction;
    value.current.status = "succeeded";
    value.current.failureCode = null;
    value.current.platformReceiptReference = "douyin-comment:observed-success";
    value.current.occurredAt = "2026-08-25T04:00:30.000Z";
    value.setNow("2026-08-25T04:01:00.000Z");

    assert.deepEqual(await reconcile(value.service, value.current.batchId, value.current.id,
      "manual-reconciliation-key-1", command(value.current)), first,
    "an exact retry returns the originally persisted response");
    assert.equal(value.desktopRecords.length, 2,
      "terminal state must not bypass repository replay resolution");

    await assert.rejects(reconcile(value.service, value.current.batchId, value.current.id,
      "manual-reconciliation-key-1", { ...command(value.current),
        contentHash: digest("changed-content") }), (error: unknown) =>
      error instanceof AcquisitionOutreachBatchError
        && error.code === "outreach_idempotency_conflict");

    const otherActor = { ...scope, actorId: "owner-2" };
    await assert.rejects(value.service.reconcileAction(otherActor, value.current.batchId,
      value.current.id, "manual-reconciliation-key-1", command(value.current)),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_idempotency_conflict");

    await assert.rejects(reconcile(value.service, value.current.batchId, value.current.id,
      "manual-reconciliation-key-2", command(value.current)), (error: unknown) =>
      error instanceof AcquisitionOutreachBatchError
        && error.code === "outreach_action_stale");
  });

test("legacy server human reconciliation still uses the read-only gateway", async () => {
  const value = serviceFixture("server");
  const result = await reconcile(value.service, value.current.batchId, value.current.id,
    "server-reconciliation-key-1", command(value.current)) as AcquisitionOutreachAction;

  assert.equal(result.status, "succeeded");
  assert.equal(result.platformReceiptReference, "douyin-comment:server-reconciled");
  assert.equal(value.gatewayCalls(), 1);
  assert.equal(value.serverSuccessCalls(), 1);
  assert.equal(value.desktopRecords.length, 0);
});

test("manual reconciliation route forwards the required idempotency key", async () => {
  const calls: unknown[][] = [];
  const service = {
    async reconcileAction(...args: unknown[]) {
      calls.push(args);
      return action("desktop");
    }
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "owner-1", teamId: "team-1" } as never;
    req.activeWorkspace = { workspaceId: "workspace-1", actorId: "owner-1",
      teamId: "team-1", capabilities: ["acquisition.outreach.approve"] } as never;
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionOutreachBatchRouter({
    service: service as never,
    cursorSecret: "human-reconciliation-router-secret-at-least-32-bytes",
    requestIdFactory: () => "request-human-reconciliation"
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/acquisition/` +
      "outreach-batches/batch-1/actions/comment-1/reconcile", {
      method: "POST", headers: { "content-type": "application/json",
        "Idempotency-Key": "manual-reconciliation-key-1" },
      body: JSON.stringify(command(action("desktop")))
    });
    assert.equal(response.status, 200);
    assert.equal("reconciliationRequest" in await response.json(), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 5);
  assert.equal(calls[0]?.[3], "manual-reconciliation-key-1");
  assert.deepEqual(calls[0]?.[4], command(action("desktop")));
});
