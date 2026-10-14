import assert from "node:assert/strict";
import test from "node:test";
import { bridgeMysqlRequested, createBridgeMysqlBackend }
  from "../test/desktop-outreach-bridge-mysql-support.js";
import { bridgeScope, bridgeAccount, bridgeMessage } from "../test/desktop-outreach-bridge-memory-support.js";
import { MysqlAcquisitionSocialAccountRepository } from "./acquisition-social-account-mysql-repository.js";
import type { DesktopOutreachActionTask, DesktopOutreachCompletionResult, DesktopOutreachReconciliationTask } from "./acquisition-outreach-batch-repository.js";
import type { AcquisitionOutreachAction } from "./acquisition-outreach-batch.js";
import { createHash } from "node:crypto";

type Backend = Awaited<ReturnType<typeof createBridgeMysqlBackend>>;
type Device = { installationId: string; deviceToken: string };
type Claim = { kind: "claimed"; task: DesktopOutreachActionTask; taskToken: string;
  serverTime: string; replayed: boolean } | { kind: "empty"; replayed: boolean };
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const mysqlMode = bridgeMysqlRequested();

async function post<T>(backend: Backend, path: string, body: unknown, key: string,
  device?: Device, taskToken?: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(`${backend.origin}/api/v1/acquisition${path}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key,
      ...(device ? { "X-Shensi-Desktop-Installation-Id": device.installationId,
        "X-Shensi-Desktop-Device-Token": device.deviceToken } : {}),
      ...(taskToken ? { "X-Shensi-Desktop-Task-Token": taskToken } : {}) }, body: JSON.stringify(body)
  });
  assert.equal(response.status, expectedStatus, "local central HTTP status");
  return await response.json() as T;
}

async function register(backend: Backend, label: "A" | "B", scope = bridgeScope) {
  const installationId = label.repeat(43);
  const enrollment = await backend.installationService.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, `enrollment-device-${label}`, "e".repeat(64));
  const registered = await post<{ deviceToken: string; workspaceId: string }>(backend,
    "/desktop-installations/register", { installationId, enrollmentToken: enrollment.token,
      protocolVersion: 1 }, `register-device-${label}`, undefined, undefined, 201);
  assert.equal(registered.workspaceId, scope.workspaceId);
  return { installationId, deviceToken: registered.deviceToken };
}

function claimBody(processInstanceId: string, account = bridgeAccount) {
  return { protocolVersion: 1, waitSeconds: 0, processInstanceId,
    availableAccounts: [{ ...account, bindingGeneration: 1 }] };
}

async function addQueuedComment(backend: Backend, suffix: string,
  workspaceId = bridgeScope.workspaceId, accountId = bridgeAccount.accountId) {
  const original = await backend.repository.find(bridgeScope.workspaceId, "bridge-batch");
  assert.ok(original);
  const originalAction = (await backend.actions())![0]!;
  const candidateId = `candidate-${suffix}`;
  const batch = { ...original, id: `batch-${suffix}`, workspaceId, accountId,
    batchHash: hash(`batch-${suffix}`), state: "awaiting_approval" as const,
    approvedBy: null, approvedAt: null, approvalHash: null,
    candidates: original.candidates.map((candidate) => ({ ...candidate, candidateId })) };
  const action: AcquisitionOutreachAction = { ...originalAction, id: `comment-${suffix}`,
    workspaceId, accountId, batchId: batch.id, candidateId, status: "queued" };
  assert.equal((await backend.repository.create({ workspaceId, operation: "create", batch,
    idempotencyKey: `create-${suffix}`, requestHash: hash(`create-${suffix}`) })).kind, "created");
  assert.equal((await backend.repository.approve({ workspaceId, batchId: batch.id, ifMatch: batch.etag,
    idempotencyKey: `approve-${suffix}`, requestHash: hash(`approve-${suffix}`),
    async build() { return { batch: { ...batch, state: "approved", approvedBy: bridgeScope.userId,
      approvedAt: original.approvedAt, approvalHash: action.approvalHash }, actions: [action] }; }
  })).kind, "created");
}

test("bridge fixture mode rejects misspelled operator mode instead of silently using Memory", async () => {
  const requested = bridgeMysqlRequested;
  assert.equal(requested({}), false);
  assert.equal(requested({ DESKTOP_ACTION_BRIDGE_MYSQL: "1" }), true);
  for (const value of ["0", "true", "", " 1"]) {
    assert.throws(() => requested({ DESKTOP_ACTION_BRIDGE_MYSQL: value }), /DESKTOP_ACTION_BRIDGE_MYSQL_MODE_INVALID/);
  }
});

test("guarded real MySQL backend matrix: account lanes, frozen approvals, HTTP replay and persisted service authority", {
  skip: mysqlMode ? false : "explicit lock-owned bridge MySQL operator mode is required"
}, async (t) => {
  let completedCases = 0;
  await t.test("two process claims serialize one account while a different workspace account proceeds", async () => {
    const now = () => "2026-09-05T00:00:00.000Z";
    const backend = await createBridgeMysqlBackend(now);
    try {
      await addQueuedComment(backend, "same-account");
      const secondScope = { ...bridgeScope, workspaceId: "workspace-independent" };
      const secondAccount = { ...bridgeAccount, accountId: "account-independent", accountHandle: `dyacct_${"b".repeat(64)}` };
      const social = new MysqlAcquisitionSocialAccountRepository(backend.pool);
      const original = await social.findById(bridgeScope.workspaceId, bridgeAccount.accountId); assert.ok(original);
      await social.upsert({ ...original, id: secondAccount.accountId, workspaceId: secondScope.workspaceId,
        accountHandle: secondAccount.accountHandle });
      await addQueuedComment(backend, "independent", secondScope.workspaceId, secondAccount.accountId);
      const a = await register(backend, "A"); const b = await register(backend, "B", secondScope);
      await backend.bind(a.installationId);
      await backend.installationService.bindDesktopExecutor(secondScope, secondAccount.accountId,
        { ...secondAccount, installationId: b.installationId, expectedGeneration: 0, handoff: false },
        "bind-independent", "c".repeat(64));
      // Both requests leave the same barrier; DB account locks decide the winner.
      const [first, second, independent] = await Promise.all([
        post<Claim>(backend, "/desktop-outreach-actions/claim", claimBody("p".repeat(43)), "claim-process-one", a),
        post<Claim>(backend, "/desktop-outreach-actions/claim", claimBody("q".repeat(43)), "claim-process-two", a),
        post<Claim>(backend, "/desktop-outreach-actions/claim", claimBody("r".repeat(43), secondAccount), "claim-independent", b)
      ]);
      assert.deepEqual([first.kind, second.kind].sort(), ["claimed", "empty"]);
      assert.equal(independent.kind, "claimed");
      const evidence = await backend.assertDurableState();
      assert.equal(evidence.actions.filter((action) => action.status === "claimed").length, 2);
      assert.equal(evidence.actions.filter((action) => action.status === "queued").length, 1);
      assert.equal(evidence.attempts, 2);
      assert.equal(evidence.actions.every((action) => action.writes === 0), true);
      const emptyClaims = await Promise.all([
        post<Claim>(backend, "/desktop-outreach-actions/claim", claimBody("p".repeat(43)), "empty-lane-original", a),
        post<Claim>(backend, "/desktop-outreach-actions/claim", claimBody("r".repeat(43), secondAccount), "empty-lane-independent", b)
      ]);
      assert.deepEqual(emptyClaims.map((entry) => entry.kind), ["empty", "empty"]);
      assert.equal((await backend.assertDurableState()).attempts, 2,
        "parallel empty claims cannot create another attempt");
    } finally { await backend.close(); }
    completedCases++;
  });

  await t.test("bound device, independent v2 approval and exact claim/start/receipt replay survive repository/service restart", async () => {
    let time = Date.parse("2026-09-05T00:00:00.000Z");
    const now = () => new Date(time).toISOString();
    const backend = await createBridgeMysqlBackend(now);
    try {
      const a = await register(backend, "A"); const b = await register(backend, "B");
      await backend.bind(a.installationId);
      await assert.rejects(backend.approveMessage(), /outreach_comment_receipt_required/);
      const processInstanceId = "p".repeat(43);
      const body = claimBody(processInstanceId);
      const [claim] = await Promise.all([
        post<Claim>(backend, "/desktop-outreach-actions/claim", body, "lost-claim-request", a),
        post(backend, "/desktop-outreach-actions/claim", claimBody("q".repeat(43)), "unbound-device-claim", b,
          undefined, 404)
      ]);
      assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
      const oldRepository = backend.repository; const oldService = backend.installationService;
      backend.restartService();
      assert.notEqual(backend.repository, oldRepository); assert.notEqual(backend.installationService, oldService);
      const replay = await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "lost-claim-request", a);
      assert.equal(JSON.stringify(replay) === JSON.stringify({ ...claim, replayed: true }), true,
        "lost claim must reconstruct the exact frozen task, token and fence");
      const complete = (command: unknown, key: string) => post<DesktopOutreachCompletionResult>(backend,
        `/desktop-outreach-actions/${claim.task.actionId}/complete`, { protocolVersion: 1,
          processInstanceId, bindingGeneration: 1, command }, key, a, claim.taskToken);
      const started = { event: "started", leaseVersion: claim.task.leaseVersion, loginStateVersion: 3,
        taskRequestHash: claim.task.taskRequestHash, occurredAt: now() };
      const start = await complete(started, "lost-start-request");
      backend.restartService();
      assert.deepEqual(await complete(started, "lost-start-request"), { ...start, replayed: true });
      assert.equal(start.state, "executing");
      await assert.rejects(backend.approveMessage(), /outreach_comment_receipt_required/);
      const receipt = { event: "receipt", leaseVersion: claim.task.leaseVersion, loginStateVersion: 3,
        taskRequestHash: claim.task.taskRequestHash, reconciliation: false,
        receipt: { actionId: claim.task.actionId, state: "succeeded", occurredAt: now(),
          failureCode: null, platformReceiptReference: "fake-comment-exact-receipt" } };
      const completed = await complete(receipt, "lost-receipt-request");
      backend.restartService();
      assert.deepEqual(await complete(receipt, "lost-receipt-request"), { ...completed, replayed: true });
      assert.equal(completed.state, "succeeded");
      assert.equal((await backend.actions())!.length, 1, "comment success cannot create an unapproved message");
      assert.equal((await backend.approveMessage()).kind, "created");
      assert.equal((await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "message-before-pacing", a)).kind, "empty");
      time += 60_000;
      const message = await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "message-after-pacing", a);
      assert.equal(message.kind, "claimed"); if (message.kind !== "claimed") return;
      assert.equal(message.task.kind, "direct_message");
      assert.equal(message.task.predecessorReceipt, "fake-comment-exact-receipt");
      assert.equal(message.task.content === bridgeMessage, true, "exact independently approved message");
      const evidence = await backend.assertDurableState();
      assert.equal(evidence.attempts, 2);
      assert.deepEqual(evidence.completions.sort((a, b) => a.operation.localeCompare(b.operation)),
        [{ operation: "receipt", count: 1 }, { operation: "started", count: 1 }]);
      const serialized = JSON.stringify(evidence);
      for (const secret of [a.deviceToken, b.deviceToken, claim.taskToken, message.taskToken,
        bridgeMessage, bridgeAccount.accountHandle, "Cookie=seed-cookie", "/private/Profile"])
        assert.equal(serialized.includes(secret), false, "safe evidence excludes private authority and content");
    } finally { await backend.close(); }
    completedCases++;
  });
  for (const rotated of [false, true]) await t.test(`human observation preserves the original receipt and frozen write approvals (rotated: ${rotated})`, async () => {
    let time = "2026-09-05T00:00:00.000Z";
    const now = () => time;
    const backend = await createBridgeMysqlBackend(now);
    try {
      const a = await register(backend, "A");
      await backend.bind(a.installationId);
      const processInstanceId = "p".repeat(43);
      let body = claimBody(processInstanceId);
      const claim = await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "original-comment-claim", a);
      assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
      const frozen = { leaseVersion: claim.task.leaseVersion, loginStateVersion: claim.task.loginStateVersion,
        taskRequestHash: claim.task.taskRequestHash };
      let currentBinding = 1;
      const complete = (command: unknown, key: string, capability = claim.taskToken) => post<DesktopOutreachCompletionResult>(backend,
        `/desktop-outreach-actions/${claim.task.actionId}/complete`, { protocolVersion: 1,
          processInstanceId, bindingGeneration: currentBinding, command }, key, a, capability);
      await complete({ ...frozen, event: "started", occurredAt: now() }, "original-comment-start");
      const receipt = { actionId: claim.task.actionId, state: "failed", platformReceiptReference: null,
        failureCode: "douyin_action_receipt_ambiguous", occurredAt: now() };
      await complete({ ...frozen, event: "receipt", reconciliation: false, receipt }, "original-comment-receipt");
      await addQueuedComment(backend, "after-human-observation");
      const action = (await backend.actions()).find((entry) => entry.id === claim.task.actionId)!;
      const request = { workspaceId: bridgeScope.workspaceId, batchId: action.batchId,
        actionId: action.id, batchRevision: action.batchRevision, approvalHash: action.approvalHash,
        contentHash: action.contentHash, requestedByUserId: bridgeScope.userId, requestedAt: now(),
        operation: "request_desktop_action_reconciliation" as const,
        idempotencyKey: "human-confirmed-observation", requestHash: hash("human-confirmed-observation") };
      assert.equal((await backend.repository.recordDesktopReconciliation(request)).kind, "created");
      const currentLogin = bridgeAccount.loginStateVersion + (rotated ? 1 : 0);
      if (rotated) {
        const social = new MysqlAcquisitionSocialAccountRepository(backend.pool);
        const account = await social.findById(bridgeScope.workspaceId, bridgeAccount.accountId);
        assert.ok(account);
        const rebound = await social.bindActive({ ...account, loginStateVersion: currentLogin,
          loginStateVersionHighWater: currentLogin });
        assert.equal((await social.findById(bridgeScope.workspaceId, bridgeAccount.accountId))?.loginStateVersion, currentLogin);
        assert.notEqual(rebound, "active_handle_conflict");
        if (rebound === "active_handle_conflict") throw Error("unexpected account switch");
        currentBinding = rebound.executorBindingGeneration!;
        body = claimBody(processInstanceId, { ...bridgeAccount, loginStateVersion: currentLogin });
        body.availableAccounts[0].bindingGeneration = currentBinding;
      }
      const [before] = await backend.pool.query("SELECT receipt_json,receipt_hash,receipt_response_json FROM acquisition_outreach_action_attempts WHERE action_id=?", [action.id]);
      type Observation = { kind: "reconcile"; task: DesktopOutreachReconciliationTask; taskToken: string; replayed: boolean };
      const grant = await post<Observation>(backend, "/desktop-outreach-actions/claim", body, "human-observation-claim", a);
      assert.equal(grant.kind, "reconcile");
      assert.equal(grant.task.capability, "reconcile_only");
      assert.equal(grant.task.actionId, action.id);
      assert.equal(grant.task.loginStateVersion, bridgeAccount.loginStateVersion);
      assert.equal(grant.task.observationLoginStateVersion, rotated ? currentLogin : undefined);
      const replay = await post<Observation>(backend, "/desktop-outreach-actions/claim", body, "human-observation-claim", a);
      assert.equal(replay.taskToken, grant.taskToken);
      assert.equal(replay.replayed, true);
      assert.equal((await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "while-observation-active", a)).kind, "empty");
      const result = await complete({ ...frozen, loginStateVersion: currentLogin, leaseVersion: grant.task.leaseVersion, event: "receipt", reconciliation: true,
        receipt: { ...receipt, state: "succeeded", failureCode: null,
          platformReceiptReference: "readonly-observed-original-comment" } }, "observed-success-completion", grant.taskToken);
      assert.equal(result.state, "succeeded");
      backend.restartService();
      const [after] = await backend.pool.query("SELECT receipt_json,receipt_hash,receipt_response_json FROM acquisition_outreach_action_attempts WHERE action_id=?", [action.id]);
      assert.deepEqual(after, before, "read-only observation never rewrites the original platform attempt");
      // The desktop keeps its 90-second binding alive while polling. Advance
      // past the observation lease without also simulating a disconnected device.
      for (const minute of [1, 2, 3, 4, 5, 6]) {
        time = `2026-09-05T00:0${minute}:00.000Z`;
        assert.equal((await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "human-observation-claim", a)).kind, "empty",
          "a completed read-only key can never become a new write claim");
      }
      const next = await post<Claim>(backend, "/desktop-outreach-actions/claim", body, "next-approved-comment", a);
      assert.equal(next.kind, rotated ? "empty" : "claimed", "old-login writes need fresh user approval, not silent restoration");
      if (next.kind === "claimed") assert.notEqual(next.task.actionId, action.id);
      const [counts] = await backend.pool.query("SELECT platform_write_attempt_count FROM acquisition_outreach_actions WHERE id=?", [action.id]);
      assert.equal((counts as Array<{ platform_write_attempt_count: number }>)[0].platform_write_attempt_count, 1);
    } finally { await backend.close(); }
    completedCases++;
  });
  if (completedCases === 4) process.stdout.write("DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:backend\n");
});

test("explicit MySQL mode fails closed before connection for missing or invalid owner authority", async () => {
  const seededSecret = "never-print-admin-secret";
  for (const environment of [
    { DESKTOP_ACTION_BRIDGE_MYSQL: "1" },
    { DESKTOP_ACTION_BRIDGE_MYSQL: "1", MYSQL_TEST_ADMIN_URL: `mysql://root:${seededSecret}@127.0.0.1:3306/mysql`,
      DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
    { DESKTOP_ACTION_BRIDGE_MYSQL: "1", MYSQL_TEST_ADMIN_URL: `mysql://root:${seededSecret}@127.0.0.1:3312/retained`,
      DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) }
  ]) {
    await assert.rejects(createBridgeMysqlBackend(() => new Date().toISOString(), environment),
      (error: unknown) => error instanceof Error
        && error.message === "DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID"
        && !String(error.stack).includes(seededSecret));
  }
  await assert.rejects(createBridgeMysqlBackend(() => new Date().toISOString(), {}),
    /DESKTOP_ACTION_BRIDGE_MYSQL_MODE_REQUIRED/);
});
