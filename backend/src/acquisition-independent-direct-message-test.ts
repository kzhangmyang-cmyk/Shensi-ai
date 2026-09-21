import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeMemoryBackend, bridgeScope, bridgeAccount } from "../test/desktop-outreach-bridge-memory-support.js";
import { bridgeMysqlRequested, createBridgeMysqlBackend } from "../test/desktop-outreach-bridge-mysql-support.js";
import type { DesktopOutreachClaimResult, DesktopOutreachCompletionResult } from "./acquisition-outreach-batch-repository.js";
import { outreachActionBlocksAccountLane } from "./acquisition-outreach-batch-repository.js";

type Backend = Awaited<ReturnType<typeof createBridgeMemoryBackend>>;

test("independent DM bypasses only a settled old comment, never an active or uncertain DM lane", async () => {
  const backend = await createBridgeMemoryBackend(() => "2026-09-05T00:00:00.000Z");
  try {
    await backend.approveIndependentMessage();
    const actions = await backend.actions();
    const message = actions?.find(action => action.kind === "direct_message");
    const comment = actions?.find(action => action.kind === "comment");
    assert.ok(message && comment);
    for (const status of ["claimed", "executing"] as const) {
      assert.equal(outreachActionBlocksAccountLane(message, { ...comment, status }, true), true);
    }
    const uncertain = { ...comment, status: "reconciliation_required" as const };
    assert.equal(outreachActionBlocksAccountLane(message, uncertain, false), true,
      "missing completion evidence or an active recovery lease must retain serialization");
    assert.equal(outreachActionBlocksAccountLane(message, uncertain, true), false);
    assert.equal(outreachActionBlocksAccountLane({ ...message, authorizationVersion: 2 }, uncertain, true), true);
    assert.equal(outreachActionBlocksAccountLane(message, { ...uncertain, kind: "direct_message" }, true), true);
    assert.equal(outreachActionBlocksAccountLane(comment, { ...uncertain, id: "another-comment" }, true), true);
    assert.equal(outreachActionBlocksAccountLane(message, { ...uncertain, accountId: "another-account" }, false), false);
    assert.equal(outreachActionBlocksAccountLane(message, { ...uncertain, workspaceId: "another-workspace" }, false), false);
  } finally { await backend.close(); }
});

async function driver(backend: Backend) {
  const installationId = "A".repeat(43), processInstanceId = "p".repeat(43);
  const enrollment = await backend.installationService.createEnrollment(bridgeScope,
    { installationId, protocolVersion: 1 }, "independent-enroll", "e".repeat(64));
  const registered = await backend.installationService.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "independent-register", "f".repeat(64));
  await backend.bind(installationId);
  let counter = 0;
  async function post<T>(path: string, body: unknown, taskToken?: string): Promise<T> {
    const response = await fetch(`${backend.origin}/api/v1/acquisition${path}`, { method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `independent-http-${++counter}`,
        "X-Shensi-Desktop-Installation-Id": installationId,
        "X-Shensi-Desktop-Device-Token": registered.deviceToken,
        ...(taskToken ? { "X-Shensi-Desktop-Task-Token": taskToken } : {}) }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
  }
  return {
    claim: () => post<DesktopOutreachClaimResult>("/desktop-outreach-actions/claim", {
      protocolVersion: 1, waitSeconds: 0, processInstanceId,
      availableAccounts: [{ ...bridgeAccount, bindingGeneration: 1 }] }),
    complete: (claim: Extract<DesktopOutreachClaimResult, {kind:"claimed"}>, command: unknown) =>
      post<DesktopOutreachCompletionResult>(`/desktop-outreach-actions/${claim.task.actionId}/complete`, {
        protocolVersion: 1, processInstanceId, bindingGeneration: 1, command
      }, claim.taskToken)
  };
}

test("independent DM from awaiting batch reaches desktop without any comment or frozen draft match", async () => {
  const backend = await createBridgeMemoryBackend(() => "2026-09-05T00:00:00.000Z", { comment: false });
  try {
    const client = await driver(backend);
    await backend.approveIndependentMessage();
    const claim = await client.claim(); assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    assert.equal(claim.task.kind, "direct_message");
    assert.equal(claim.task.content, "independent edited message");
    assert.equal(claim.task.predecessorReceipt, null);
    assert.equal((await backend.repository.find(bridgeScope.workspaceId, "bridge-batch"))?.state, "awaiting_approval");
    assert.equal((await backend.actions())?.length, 1);
    assert.equal((await client.complete(claim, { event: "started", leaseVersion: claim.task.leaseVersion,
      loginStateVersion: 3, taskRequestHash: claim.task.taskRequestHash,
      occurredAt: "2026-09-05T00:00:00.000Z" })).state, "executing");
  } finally { await backend.close(); }
});

for (const mode of ["memory", "mysql"] as const) test(`${mode}: settled uncertain comment does not starve an independently approved DM; active execution stays serialized`, {
  skip: mode === "mysql" && !bridgeMysqlRequested() ? "guarded disposable MySQL mode required" : false
}, async () => {
  let time = Date.parse("2026-09-05T00:00:00.000Z"); const now = () => new Date(time).toISOString();
  const backend = mode === "mysql" ? await createBridgeMysqlBackend(now) : await createBridgeMemoryBackend(now);
  try {
    const client = await driver(backend);
    await backend.approveIndependentMessage();
    const comment = await client.claim(); assert.equal(comment.kind, "claimed");
    if (comment.kind !== "claimed") return;
    assert.equal(comment.task.kind, "comment");
    const base = { leaseVersion: comment.task.leaseVersion, loginStateVersion: 3,
      taskRequestHash: comment.task.taskRequestHash };
    assert.equal((await client.complete(comment, { ...base, event: "started", occurredAt: now() })).state, "executing");
    time += 61_000;
    assert.equal((await client.claim()).kind, "empty", "active execution blocks a second operation despite pacing elapsed");
    const done = await client.complete(comment, { ...base, event: "receipt", reconciliation: false,
      receipt: { actionId: comment.task.actionId, state: "failed", occurredAt: now(),
        failureCode: "douyin_action_receipt_ambiguous", platformReceiptReference: null } });
    assert.equal(done.state, "reconciliation_required");
    const message = await client.claim(); assert.equal(message.kind, "claimed");
    if (message.kind !== "claimed") return;
    assert.equal(message.task.kind, "direct_message");
    const old = (await backend.actions())?.find(action => action.id === comment.task.actionId);
    assert.equal(old?.status, "reconciliation_required");
    assert.equal(old?.attemptCount, 1, "old comment is never retried");
  } finally { await backend.close(); }
});
