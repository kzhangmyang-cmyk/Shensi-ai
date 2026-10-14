import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn, setTimeout as pause } from "node:timers/promises";
import { createBridgeMemoryBackend, bridgeScope, bridgeAccount, bridgeComment, bridgeMessage }
  from "../../backend/test/desktop-outreach-bridge-memory-support.ts";
import { bridgeMysqlRequested, createBridgeMysqlBackend }
  from "../../backend/test/desktop-outreach-bridge-mysql-support.ts";
import { DesktopOutreachActionCoordinator, type DesktopOutreachCoordinatorSnapshot }
  from "../src/main/outreach-action-coordinator.ts";
import { DesktopCentralApiClient } from "../src/main/desktop-central-api-client.ts";
import { SidecarClient } from "../src/main/sidecar-client.ts";
import { createDeviceCredentialStore } from "../src/main/device-credential-store.ts";
import { createDeviceInstallationStore } from "../src/main/device-installation.ts";
import { createOutreachActionJournalStore } from "../src/main/outreach-action-journal.ts";
import { DesktopEnrollmentService } from "../src/main/desktop-enrollment-service.ts";
import type { DesktopOutreachCoordinatorView } from "../src/shared/contracts.ts";

// SidecarClient's transport deadline uses wall time; only the initial epoch is
// wall-clock based. Every lease/retry transition below is controlled by Clock.
const BASE = Date.now();
const mysqlMode = bridgeMysqlRequested();
let mysqlCasesCompleted = 0;
let mysqlCasesCleaned = 0;
const matrixTest = (name: string, run: (t: TestContext) => Promise<void>) => test(name, async (t) => {
  await run(t);
  if (mysqlMode) mysqlCasesCompleted++;
});
after(() => {
  if (mysqlMode && mysqlCasesCompleted === 13 && mysqlCasesCleaned === 13) {
    process.stdout.write("DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:desktop\n");
  }
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" }
});
async function settle() { for (let i = 0; i < 40; i++) await turn(); }
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < (mysqlMode ? 10_000 : 2000); i++) { if (await check()) return; await pause(1); }
  assert.fail("integration condition did not settle");
}
class Clock {
  time = mysqlMode ? Date.now() : BASE; sequence = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  iso = () => new Date(this.time).toISOString();
  setTimeout = (run: () => void, ms: number) => { const id = ++this.sequence;
    this.jobs.set(id, { at: this.time + ms, run }); return id; };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  async tick(ms: number) { this.time += ms;
    for (const [id, job] of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(id); job.run(); }
    await settle(); }
}
type Operation = "claim" | "started" | "receipt" | "reconcile" | "register";
type Trace = { operation: Operation; key: string | null; requestHash: string; processId?: string;
  replayed?: boolean; kind?: string; status: number };
type WireReceipt = { action_id: string; state: "succeeded" | "failed"; failure_code: string | null;
  platform_receipt_reference: string | null; occurred_at: string };

async function harness(t: TestContext, autoBind = true) {
  const clock = new Clock();
  const mysqlBackend = mysqlMode ? await createBridgeMysqlBackend(clock.iso) : null;
  const backend = mysqlBackend ?? await createBridgeMemoryBackend(clock.iso);
  const roots: string[] = [];
  const coordinators: DesktopOutreachActionCoordinator[] = [];
  t.after(async () => {
    const stops = coordinators.map((coordinator) => coordinator.stop());
    try {
      await clock.tick(10_000); await Promise.all(stops);
      if (mysqlBackend) await mysqlBackend.assertDurableState();
    } finally {
      try { await backend.close(); }
      finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
    }
    if (mysqlBackend) mysqlCasesCleaned++;
  });
  async function device(label: "A" | "B") {
    const root = await realpath(await mkdtemp(join(tmpdir(), `shensi-two-device-${label}-`))); roots.push(root);
    // The encrypted store is real; only Electron safeStorage/Keychain is replaced.
    const stores = () => ({ installation: createDeviceInstallationStore(join(root, "installation")),
      credentials: createDeviceCredentialStore({ directory: join(root, "credentials"), safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 83)),
        decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 83)).toString()
      } }), journal: createOutreachActionJournalStore(join(root, "journal")) });
    const local = stores();
    const installationId = await local.installation.getOrCreateInstallationId();
    const trace: Trace[] = [];
    const taskTokens = new Set<string>();
    const faults = { centralOffline: false, sidecarUnavailable: false, lose: null as Operation | null,
      lost: 0, loseWriteResponse: false, holdWrite: false, blockStart: false, blockedStarts: 0,
      uncertainComment: false };
    let releaseWrite: (() => void) | undefined;
    const central = new DesktopCentralApiClient({ origin: backend.origin, buildManifestSha256: "b".repeat(64),
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init?.body));
        const operation: Operation = path.endsWith("/claim") ? "claim" : path.endsWith("/reconcile") ? "reconcile"
          : path.endsWith("/register") ? "register" : body.command.event;
        if (faults.centralOffline) throw new Error("seeded central transport outage");
        if (faults.blockStart && operation === "started") { faults.blockedStarts++;
          return json({ error: "seeded_offline_before_start" }, 503); }
        const response = await fetch(url, init);
        const value = await response.clone().json();
        if (value.taskToken) taskTokens.add(value.taskToken);
        trace.push({ operation, key: new Headers(init?.headers).get("idempotency-key"),
          requestHash: digest(String(init?.body)), processId: body.processInstanceId,
          replayed: value.replayed, kind: value.kind, status: response.status });
        if (faults.lose === operation) { faults.lose = null; faults.lost++;
          await response.body?.cancel(); throw new Error("seeded response lost after durable commit"); }
        return response;
      } });
    const enrollment = await backend.installationService.createEnrollment(bridgeScope, { installationId,
      protocolVersion: 1 }, `enroll-device-${label}`, "a".repeat(64));
    const registered = await central.register({ installationId, protocolVersion: 1, enrollmentToken: enrollment.token }, {
      expectedWorkspaceId: bridgeScope.workspaceId, idempotencyKey: `register-device-${label}`
    });
    await local.credentials.save({ ...registered, bindings: [] });
    const writes: Array<{ actionId: string; content: string; target: string; kind: string }> = [];
    const reads: string[] = [];
    const acknowledgements: string[] = [];
    // Retained fake Sidecar receipt state survives client/Main reconstruction, as a
    // real Sidecar journal would. No Python/browser/platform is launched here.
    const receipts = new Map<string, WireReceipt>();
    const sidecar = () => new SidecarClient({ origin: "http://127.0.0.1:4399", token: "s".repeat(43),
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname; const body = JSON.parse(String(init?.body));
        if (faults.sidecarUnavailable) throw new Error("Cookie=seed-cookie /private/Profile seeded outage");
        if (path.endsWith("/resolve")) return json({ account_key: body.account_key,
          account_handle: bridgeAccount.accountHandle, account_display_name: "private identity display",
          login_state_version: 3, profile_available: true });
        const actionId = path.split("/")[5]!;
        if (path.endsWith("/acknowledgement")) {
          // The coordinator must not acknowledge/clear before the real central
          // repository durably records the matching terminal action.
          assert.equal((await backend.actions())!.find((action) => action.id === actionId)!.status,
            faults.uncertainComment && actionId === "bridge-comment" ? "reconciliation_required" : "succeeded");
          acknowledgements.push(actionId); return json({ action_id: actionId, acknowledged_at: clock.iso() });
        }
        if (path.endsWith("/reconcile")) { reads.push(actionId); return receipts.has(actionId)
          ? json(receipts.get(actionId)) : json({ code: "action_reconciliation_not_uncertain" }, 409); }
        writes.push({ actionId, content: body.content, target: body.canonical_target_public_url, kind: body.kind });
        const receipt: WireReceipt = { action_id: actionId, state: "succeeded", failure_code: null,
          platform_receipt_reference: `fake-receipt-${actionId}`, occurred_at: clock.iso() };
        if (faults.uncertainComment && body.kind === "comment") {
          receipt.state = "failed"; receipt.failure_code = "douyin_action_receipt_ambiguous";
          receipt.platform_receipt_reference = null;
        }
        receipts.set(actionId, receipt);
        if (faults.holdWrite) await new Promise<void>((resolve) => { releaseWrite = resolve; });
        if (faults.loseWriteResponse) { faults.loseWriteResponse = false; throw new Error("seeded sidecar response lost"); }
        return json(receipt);
      } });
    const snapshots: DesktopOutreachCoordinatorSnapshot[] = [];
    const make = () => {
      const restored = stores();
      const coordinator = new DesktopOutreachActionCoordinator({ central, sidecar: sidecar(),
        installationStore: restored.installation, credentialStore: restored.credentials, journalStore: restored.journal,
        workspaceId: bridgeScope.workspaceId, enabled: true, clock, random: () => 0.5,
        accountKeyFor: () => "a".repeat(64), onState: (snapshot) => snapshots.push(snapshot) });
      coordinators.push(coordinator); return coordinator;
    };
    return { root, installationId, deviceToken: registered.deviceToken, taskTokens, local, central,
      context: { workspaceId: bridgeScope.workspaceId, installationId, deviceToken: registered.deviceToken },
      trace, faults, writes, reads, acknowledgements, snapshots, make, releaseWrite: () => { assert.ok(releaseWrite); releaseWrite(); } };
  }
  const a = await device("A"); const b = await device("B");
  if (autoBind) {
    const binding = await backend.bind(a.installationId);
    assert.equal(binding.bindingGeneration, 1);
  }
  // B intentionally has a stale local binding: central ownership, not this local
  // reference or Sidecar identity, must prevent B from obtaining write authority.
  for (const device of [a, b]) await device.local.credentials.recordBinding(bridgeScope.workspaceId,
    { accountId: bridgeAccount.accountId, bindingGeneration: 1 });
  return { a, b, clock, backend };
}

matrixTest("Main executes independent DM after acknowledged uncertain comment without retrying the comment", async (t) => {
  const h = await harness(t);
  h.a.faults.uncertainComment = true;
  const a = h.a.make(); await a.start();
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.equal((await h.backend.actions())?.[0]?.status, "reconciliation_required");
  await h.backend.approveIndependentMessage();
  await h.clock.tick(61_000);
  await until(() => h.a.acknowledgements.length === 2);
  assert.deepEqual(h.a.writes.map(write => write.kind), ["comment", "direct_message"]);
  assert.equal(h.a.writes[1]?.content, "independent edited message");
  assert.equal((await h.backend.actions())?.find(action => action.id === "bridge-comment")?.attemptCount, 1);
});

matrixTest("two independent installations execute only on the bound device, with separate post-comment v2 message approval", async (t) => {
  const h = await harness(t);
  assert.notEqual(h.a.root, h.b.root); assert.notEqual(h.a.installationId, h.b.installationId);
  assert.notEqual(h.a.deviceToken, h.b.deviceToken);
  await assert.rejects(h.backend.approveMessage(), /outreach_comment_receipt_required/);
  const a = h.a.make(); const b = h.b.make(); await Promise.all([a.start(), b.start()]);
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.deepEqual(h.a.writes, [{ actionId: "bridge-comment", content: bridgeComment,
    target: "https://www.douyin.com/video/bridge-candidate", kind: "comment" }]);
  assert.equal(h.b.writes.length, 0);
  assert.equal(h.a.trace.filter((entry) => entry.operation === "claim" && entry.kind === "claimed").length, 1);
  assert.equal(h.b.trace.filter((entry) => entry.kind === "claimed").length, 0);
  await settle(); await h.clock.tick(4000);
  await until(() => h.a.trace.filter((entry) => entry.operation === "claim").length === 2);
  await settle();
  assert.equal(h.a.writes.length, 1, "comment success alone must not authorize a private message");
  assert.equal((await h.backend.approveMessage()).kind, "created");
  // The production account pacing gate retains its sixty-second comment cooldown.
  await h.clock.tick(60_000);
  await until(async () => h.a.acknowledgements.length === 2 && (await h.a.local.journal.list()).length === 0);
  assert.deepEqual(h.a.writes[1], { actionId: "bridge-message", content: bridgeMessage,
    target: "https://www.douyin.com/user/bridge-candidate", kind: "direct_message" });
  assert.deepEqual((await h.backend.actions())!.map((action) => [action.kind, action.status]),
    [["comment", "succeeded"], ["direct_message", "succeeded"]]);
  assert.equal(h.b.writes.length, 0); assert.equal((await h.b.local.journal.list()).length, 0);
  for (const device of [h.a, h.b]) {
    assert.equal((await stat(device.root)).mode & 0o777, 0o700);
    const snapshot = JSON.stringify(device.snapshots);
    for (const secret of [device.deviceToken, ...device.taskTokens, bridgeAccount.accountHandle,
      bridgeComment, bridgeMessage, device.root, "Cookie=seed-cookie", "private identity display"]) {
      assert.equal(snapshot.includes(secret), false, "Main status must not disclose seeded private data");
    }
    for (const entry of await readdir(join(device.root, "credentials"))) {
      assert.equal((await readFile(join(device.root, "credentials", entry), "utf8")).includes(device.deviceToken), false);
    }
  }
});

for (const operation of ["claim", "started", "receipt"] as const) {
  matrixTest(`lost ${operation} response replays its exact committed HTTP request and never repeats the Sidecar write`, async (t) => {
    const h = await harness(t); h.a.faults.lose = operation;
    const coordinator = h.a.make(); await coordinator.start(); await until(() => h.a.faults.lost === 1); await settle();
    const records = await h.a.local.journal.list();
    assert.deepEqual(records.map((record) => record.phase), operation === "claim" ? []
      : [operation === "started" ? "claimed" : "sidecar_completed"]);
    assert.equal(h.a.writes.length, operation === "receipt" ? 1 : 0);
    assert.equal(h.a.acknowledgements.length, 0);
    await h.clock.tick(2000);
    await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
    const replay = h.a.trace.filter((entry) => entry.operation === operation);
    assert.equal(replay.length, 2); assert.equal(replay[0].key, replay[1].key);
    assert.equal(replay[0].requestHash, replay[1].requestHash);
    assert.deepEqual(replay.map((entry) => entry.replayed), [false, true]);
    assert.equal(h.a.writes.length, 1); assert.equal(h.b.writes.length, 0);
  });
}

for (const offlineMs of [30_000, 180_001]) {
matrixTest(`Main/backend-service restart after ${offlineMs}ms preserves the live-binding requirement and reconciles without rewriting`, async (t) => {
  const h = await harness(t); h.a.faults.loseWriteResponse = true;
  const first = h.a.make(); await first.start();
  await until(() => h.a.writes.length === 1); await settle();
  assert.equal((await h.a.local.journal.list())[0]!.phase, "central_started");
  const oldProcess = h.a.trace.find((entry) => entry.operation === "started")!.processId;
  await first.stop(); await h.clock.tick(offlineMs); h.backend.restartService();
  const restored = createDeviceInstallationStore(join(h.a.root, "installation"));
  assert.equal(await restored.getOrCreateInstallationId(), h.a.installationId);
  const second = h.a.make();
  const bridge = new DesktopEnrollmentService({ central: h.a.central, installationStore: h.a.local.installation,
    credentialStore: h.a.local.credentials, coordinator: second });
  t.after(() => bridge.dispose());
  await bridge.setDesktopWorkspace({ workspaceId: bridgeScope.workspaceId });
  if (offlineMs > 90_000) {
    // Existing authority requires a live binding; an expired connection cannot
    // silently renew itself. The authenticated operator confirms the same device,
    // exact generation and no handoff before Main retries read-only recovery.
    await until(() => second.getState().state === "error");
    assert.equal(h.a.trace.find((entry) => entry.operation === "reconcile")!.kind, "not_authorized");
    assert.equal(h.a.reads.length, 0); assert.equal(h.a.acknowledgements.length, 0);
    assert.equal((await h.a.local.journal.list())[0]!.phase, "central_started");
    assert.equal((await h.backend.bind(h.a.installationId, 1, false)).bindingGeneration, 1);
    await bridge.recordDesktopBinding({ workspaceId: bridgeScope.workspaceId,
      accountId: bridgeAccount.accountId, bindingGeneration: 1 });
  }
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.equal(h.a.writes.length, 1); assert.deepEqual(h.a.reads, ["bridge-comment"]);
  assert.notEqual(h.a.trace.find((entry) => entry.operation === "reconcile")!.processId, oldProcess);
  assert.equal((await h.backend.actions())![0]!.status, "succeeded");
});
}

matrixTest("disconnect before central started releases the expired zero-write journal before a fresh claim can execute", async (t) => {
  const h = await harness(t); h.a.faults.blockStart = true;
  const first = h.a.make(); await first.start(); await until(() => h.a.faults.blockedStarts === 1);
  assert.equal((await h.a.local.journal.list())[0]!.phase, "claimed");
  assert.equal(h.a.writes.length, 0); assert.equal((await h.backend.actions())![0]!.status, "claimed");
  const stopping = first.stop(); await h.clock.tick(10_000); await stopping;
  await h.clock.tick(170_001);
  assert.equal(await h.backend.repository.recoverExpiredActionClaims(h.clock.iso()), 1);
  assert.equal((await h.backend.actions())![0]!.status, "queued");
  await h.backend.bind(h.a.installationId, 1, false); h.a.faults.blockStart = false;
  const second = h.a.make(); await second.start();
  await until(async () => h.a.trace.some((entry) => entry.operation === "reconcile" && entry.kind === "released")
    && (await h.a.local.journal.list()).length === 0);
  assert.equal(h.a.writes.length, 0); assert.equal(h.a.acknowledgements.length, 0);
  await settle(); await h.clock.tick(4000);
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.equal(h.a.writes.length, 1); assert.equal((await h.backend.actions())![0]!.status, "succeeded");
});

matrixTest("a completed local journal survives lost central completion and restart, then clears only against durable terminal proof", async (t) => {
  const h = await harness(t); h.a.faults.lose = "receipt";
  const first = h.a.make(); await first.start(); await until(() => h.a.faults.lost === 1); await settle();
  assert.equal((await h.a.local.journal.list())[0]!.phase, "sidecar_completed");
  assert.equal((await h.backend.actions())![0]!.status, "succeeded");
  assert.equal(h.a.acknowledgements.length, 0);
  const stopping = first.stop(); await h.clock.tick(10_000); await stopping;
  h.backend.restartService(); const second = h.a.make(); await second.start();
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.equal(h.a.trace.find((entry) => entry.operation === "reconcile")!.kind, "terminal");
  assert.equal(h.a.trace.filter((entry) => entry.operation === "receipt").length, 1);
  assert.equal(h.a.reads.length, 0); assert.equal(h.a.writes.length, 1);
});

matrixTest("the narrow status bridge survives Renderer-like unsubscribe/reload and disposal without cancelling Main execution", async (t) => {
  const h = await harness(t); h.a.faults.holdWrite = true;
  const coordinator = h.a.make();
  const bridge = new DesktopEnrollmentService({ central: h.a.central, installationStore: h.a.local.installation,
    credentialStore: h.a.local.credentials, coordinator });
  t.after(() => bridge.dispose()); let oldEvents = 0;
  const unsubscribe = bridge.onDesktopOutreachStatusChanged(() => { oldEvents++; throw new Error("Renderer observer crashed"); });
  await bridge.setDesktopWorkspace({ workspaceId: bridgeScope.workspaceId });
  await until(() => h.a.writes.length === 1);
  unsubscribe(); const detachedCount = oldEvents;
  const reloaded: DesktopOutreachCoordinatorView[] = [await bridge.getDesktopOutreachStatus()];
  const detachReloaded = bridge.onDesktopOutreachStatusChanged((snapshot) => reloaded.push(snapshot));
  // Repeated authenticated bootstrap of the same workspace cannot drain the lane.
  await bridge.setDesktopWorkspace({ workspaceId: bridgeScope.workspaceId });
  assert.equal(reloaded[0].state, "executing");
  assert.equal(reloaded[0].currentActionKind, "comment");
  assert.deepEqual(Object.keys(reloaded[0]).sort(), ["currentActionKind", "diagnostic", "ownership",
    "pendingReconciliationCount", "state", "updatedAt"]);
  const serialized = JSON.stringify(reloaded);
  for (const secret of [h.a.deviceToken, ...h.a.taskTokens, h.a.installationId, bridgeAccount.accountId,
    "bridge-comment", bridgeAccount.accountHandle, bridgeComment, bridgeMessage, h.a.root]) {
    assert.equal(serialized.includes(secret), false);
  }
  detachReloaded(); bridge.dispose();
  h.a.releaseWrite();
  await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  assert.equal(oldEvents, detachedCount); assert.equal(coordinator.getState().accounts[0].state, "idle");
  assert.equal(h.a.writes.length, 1);
});

matrixTest("binding status is tenant/user/device scoped and handoff remains blocked until the active action is resolved", async (t) => {
  const h = await harness(t, false);
  const status = (installationId: string, scope = bridgeScope) =>
    h.backend.installationService.getDesktopBindingStatus(scope, bridgeAccount.accountId, installationId);
  assert.deepEqual(await status(h.a.installationId), { accountId: bridgeAccount.accountId, executorMode: "server",
    bindingGeneration: 0, leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: false });
  await h.backend.bind(h.a.installationId);
  assert.deepEqual(await status(h.a.installationId), { accountId: bridgeAccount.accountId, executorMode: "desktop",
    bindingGeneration: 1, leaseExpiresAt: new Date(h.clock.now() + 90_000).toISOString(),
    ownedByInstallation: true, hasUnresolvedActions: false });
  assert.equal((await status(h.b.installationId)).ownedByInstallation, false);
  for (const scope of [{ ...bridgeScope, workspaceId: "another-workspace" }, { ...bridgeScope, userId: "another-user" }]) {
    await assert.rejects(status(h.a.installationId, scope), /social_account_not_found/);
  }
  await assert.rejects(status("z".repeat(43)), /social_account_not_found/);
  const projection = JSON.stringify(await status(h.a.installationId));
  for (const secret of [h.a.installationId, h.a.deviceToken, bridgeAccount.accountHandle, "executorDeviceIdHash"]) {
    assert.equal(projection.includes(secret), false);
  }
  h.a.faults.holdWrite = true; const first = h.a.make(); await first.start(); await until(() => h.a.writes.length === 1);
  assert.equal((await status(h.b.installationId)).hasUnresolvedActions, true);
  await assert.rejects(h.backend.bind(h.b.installationId, 1, true), /desktop_executor_handoff_blocked/);
  const record = (await h.a.local.journal.list())[0]!;
  h.a.releaseWrite(); await until(async () => h.a.acknowledgements.length === 1 && (await h.a.local.journal.list()).length === 0);
  await first.stop();
  assert.equal((await status(h.b.installationId)).hasUnresolvedActions, false);
  assert.equal((await h.backend.bind(h.b.installationId, 1, true)).bindingGeneration, 2);
  assert.equal((await status(h.a.installationId)).ownedByInstallation, false);
  assert.equal((await status(h.b.installationId)).ownedByInstallation, true);
  await assert.rejects(h.a.central.claim(h.a.context, { protocolVersion: 1, waitSeconds: 0,
    processInstanceId: "o".repeat(43), availableAccounts: [{ ...bridgeAccount, bindingGeneration: 1 }] },
  { idempotencyKey: "old-device-after-handoff" }), /central_http_404/);
  await assert.rejects(h.a.central.complete(h.a.context, "bridge-comment", { protocolVersion: 1,
    processInstanceId: h.a.trace.find((entry) => entry.operation === "started")!.processId!, bindingGeneration: 1,
    command: { event: "started", leaseVersion: record.leaseVersion, loginStateVersion: 3,
      taskRequestHash: record.requestHash, occurredAt: new Date(BASE).toISOString() } },
  { idempotencyKey: "old-start-after-handoff", taskToken: [...h.a.taskTokens][0] }), /central_http_404/);
  await assert.rejects(h.a.central.complete(h.a.context, "bridge-comment", { protocolVersion: 1,
    processInstanceId: h.a.trace.find((entry) => entry.operation === "started")!.processId!, bindingGeneration: 1,
    command: { event: "receipt", leaseVersion: record.leaseVersion, loginStateVersion: 3,
      taskRequestHash: record.requestHash, reconciliation: false, receipt: { actionId: "bridge-comment",
        state: "succeeded", occurredAt: new Date(BASE).toISOString(), failureCode: null,
        platformReceiptReference: "fake-receipt-bridge-comment" } } },
  { idempotencyKey: "old-complete-after-handoff", taskToken: [...h.a.taskTokens][0] }), /central_http_404/);
  assert.equal(h.a.writes.length, 1); assert.equal(h.b.writes.length, 0);
});

for (const boundary of ["central-offline", "sidecar-unavailable"] as const) {
  matrixTest(`${boundary} leaves both devices at zero new platform writes`, async (t) => {
    const h = await harness(t);
    for (const device of [h.a, h.b]) {
      if (boundary === "central-offline") device.faults.centralOffline = true;
      else device.faults.sidecarUnavailable = true;
    }
    const coordinators = [h.a.make(), h.b.make()]; await Promise.all(coordinators.map((value) => value.start()));
    await settle(); await h.clock.tick(4000); await settle();
    for (const device of [h.a, h.b]) {
      assert.equal(device.writes.length, 0); assert.equal((await device.local.journal.list()).length, 0);
      assert.equal(device.trace.some((entry) => entry.operation === "started"), false);
      assert.equal(JSON.stringify(device.snapshots).includes("Cookie=seed-cookie"), false);
    }
    assert.equal((await h.backend.actions())![0]!.status, "queued");
  });
}
