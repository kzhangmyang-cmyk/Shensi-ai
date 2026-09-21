import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn, setTimeout as pause } from "node:timers/promises";
import { DesktopOutreachActionCoordinator } from "../src/main/outreach-action-coordinator.ts";
import { DesktopCentralApiClient } from "../src/main/desktop-central-api-client.ts";
import { SidecarClient } from "../src/main/sidecar-client.ts";
import { mapActionReceipt } from "../src/main/sidecar-outreach-protocol.ts";
import { createDeviceCredentialStore } from "../src/main/device-credential-store.ts";
import { createDeviceInstallationStore } from "../src/main/device-installation.ts";
import { createOutreachActionJournalStore, type OutreachActionRecoveryRecord } from "../src/main/outreach-action-journal.ts";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/desktop-outreach-hashes.v1.json", import.meta.url), "utf8"));
const at = "2026-09-05T00:00:00.000Z";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
class Clock {
  time = Date.parse(at); sequence = 0;
  jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.sequence; this.jobs.set(id, { at: this.time + ms, fn }); return id; };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  async tick(ms: number) { this.time += ms; for (const [id, job] of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(id); job.fn(); } await settle(); }
}
async function settle() { for (let i = 0; i < 40; i++) await turn(); }
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 1000; i++) { if (await check()) return; await pause(1); } assert.fail("condition did not settle"); }
async function harness(t: TestContext, count = 1, enrolled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-coordinator-")));
  const clock = new Clock();
  const credentials = createDeviceCredentialStore({ directory: join(root, "credentials"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 83)),
    decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 83)).toString()
  } });
  const journal = createOutreachActionJournalStore(join(root, "journal"));
  const tasks = fixture.vectors.map((v: any, i: number) => ({ actionId: v.request.action_id, workspaceId: "workspace-a", accountId: `account-${i}`,
    accountHandle: v.request.account_handle, loginStateVersion: v.request.login_state_version, executorBindingGeneration: 2,
    kind: v.request.kind, canonicalTargetPublicUrl: v.request.canonical_target_public_url, content: v.request.content,
    approvedContentHash: v.request.approved_content_hash, taskRequestHash: v.requestHash, deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    leaseVersion: 3, leaseExpiresAt: "2026-09-05T00:01:00.000Z", predecessorReceipt: null }));
  const bindings = Array.from({ length: count }, (_, i) => ({ accountId: `account-${i}`, bindingGeneration: 2 }));
  if (enrolled) await credentials.save({ workspaceId: "workspace-a", deviceToken: "d".repeat(43), protocolVersion: 1, bindings });
  const events: Array<{ path: string; body: any; key: string | null; signal?: AbortSignal | null }> = [];
  const records: OutreachActionRecoveryRecord[] = [];
  const served = new Set<string>();
  const keys: Array<[string, string]> = [];
  let centralHook: ((path: string, body: any, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  let sidecarHook: ((path: string, body: any, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  const central = new DesktopCentralApiClient({ origin: "http://127.0.0.1:4321", buildManifestSha256: "b".repeat(64), fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname.split("/desktop-outreach-actions")[1]; const body = JSON.parse(String(init?.body));
    events.push({ path, body, key: new Headers(init?.headers).get("idempotency-key"), signal: init?.signal });
    const intercepted = await centralHook?.(path, body, init); if (intercepted) return intercepted;
    if (path === "/claim") {
      const task = tasks.find((task: any) => !served.has(task.actionId) && body.availableAccounts.some((a: any) => a.accountId === task.accountId));
      if (!task) return json({ kind: "empty", serverTime: at, retryAfterMs: 0, replayed: false });
      served.add(task.actionId); return json({ kind: "claimed", task, taskToken: "t".repeat(43), serverTime: at, replayed: false });
    }
    if (path.endsWith("/reconcile")) return json({ kind: "waiting", retryAfterMs: 3000, replayed: false });
    const actionId = path.split("/")[1];
    records.push((await journal.list()).find((r) => r.actionId === actionId)!);
    return json({ actionId, state: body.command.event === "started" ? "executing" : body.command.receipt.state, replayed: false, accountPaused: false, occurredAt: at });
  } });
  const sidecar = new SidecarClient({ origin: "http://127.0.0.1:4322", token: "s".repeat(43), fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; const body = JSON.parse(String(init?.body));
    events.push({ path, body, key: null, signal: init?.signal });
    const intercepted = await sidecarHook?.(path, body, init); if (intercepted) return intercepted;
    if (path.endsWith("/resolve")) {
      const i = Number.parseInt(body.account_key[0], 16); const task = tasks[i] ?? tasks[0];
      return json({ account_key: body.account_key, account_handle: task.accountHandle, account_display_name: "private display", login_state_version: task.loginStateVersion, profile_available: true });
    }
    const actionId = path.split("/")[5];
    if (path.endsWith("/acknowledgement")) return json({ action_id: actionId, acknowledged_at: at });
    const i = tasks.findIndex((task: any) => task.actionId === actionId);
    records.push((await journal.list()).find((r) => r.actionId === actionId)!);
    return json(fixture.vectors[i].receipt);
  } });
  const diagnostics: unknown[] = [];
  const make = () => new DesktopOutreachActionCoordinator({ central, sidecar, installationStore: createDeviceInstallationStore(join(root, "installation")),
    credentialStore: credentials, journalStore: journal, workspaceId: "workspace-a", enabled: true, clock, random: () => 0.5,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    accountKeyFor: (id: string, workspace: string) => { keys.push([id, workspace]); return id.slice(-1).repeat(64); } });
  const coordinator = make();
  t.after(async () => { const stopped = coordinator.stop(); await clock.tick(10_000); await stopped; await rm(root, { recursive: true, force: true }); });
  return { coordinator, make, clock, journal, credentials, events, records, tasks, served, keys, diagnostics,
    centralHook: (hook: NonNullable<typeof centralHook>) => { centralHook = hook; }, sidecarHook: (hook: NonNullable<typeof sidecarHook>) => { sidecarHook = hook; } };
}

test("a rejected central claim reports its stage and HTTP status without private request data", async (t) => {
  const h = await harness(t);
  h.centralHook(async () => json({ error: "desktop_outreach_claim_not_authorized", token: "not-for-logs" }, 404));
  await h.coordinator.start();
  await until(() => h.diagnostics.length > 0);
  assert.deepEqual(h.diagnostics, [{ phase: "poll", source: "central", httpStatus: 404 }]);
  assert.equal(h.coordinator.getStatusMetadata().diagnostic, "binding_unavailable");
  assert.equal(h.events.some((event) => event.path.includes("/actions/")), false);
});

for (const rotated of [false, true]) test(`a human-requested read-only claim with an empty journal never starts a write (rotated: ${rotated})`, async (t) => {
  const h = await harness(t);
  h.tasks.forEach((task: any) => h.served.add(task.actionId));
  let dispatched = false;
  if (rotated) h.sidecarHook(async (path, body) => path.endsWith("/resolve") ? json({
    account_key: body.account_key, account_handle: h.tasks[0].accountHandle,
    account_display_name: "hkko", login_state_version: 8, profile_available: true
  }) : undefined);
  h.centralHook(async (path, body) => {
    if (path === "/claim" && !dispatched) {
      dispatched = true;
      const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...task } = h.tasks[0];
      return json({ kind: "reconcile", serverTime: at, replayed: false,
        taskToken: "r".repeat(43), task: { ...task, leaseVersion: 1,
          ...(rotated ? { observationLoginStateVersion: 8 } : {}),
          originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" } });
    }
    if (body.command?.event === "receipt") return json({ actionId: h.tasks[0].actionId,
      state: "succeeded", accountPaused: false, occurredAt: at, replayed: false });
    return undefined;
  });
  await h.coordinator.start();
  await until(() => h.events.some((e) => e.body.command?.reconciliation === true));
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001/reconcile").length, 1);
  assert.equal(h.events.some((e) => e.body.command?.event === "started"), false);
  assert.equal(h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001"), false);
  const observation = h.events.find((e) => e.path === "/internal/v1/douyin/actions/action-comment-001/reconcile")!;
  assert.equal(observation.body.login_state_version, 7);
  assert.equal(observation.body.observation_login_state_version, rotated ? 8 : undefined);
  assert.equal(h.events.find((e) => e.body.command?.reconciliation)?.body.command.loginStateVersion, rotated ? 8 : 7);
  assert.deepEqual(await h.journal.list(), [], "central owns the durable human request; no fake write journal");
});

test("coordinator metadata is an identity-free projection with observed timestamps and diagnostics", async (t) => {
  const h = await harness(t, 0, false);
  assert.deepEqual(h.coordinator.getStatusMetadata(), { diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0 });
  await h.coordinator.start();
  assert.equal(h.coordinator.getStatusMetadata().updatedAt, at);
  await h.coordinator.onSidecarChanged(false, 1);
  assert.deepEqual(h.coordinator.getStatusMetadata(), { diagnostic: "connector_unavailable", currentActionKind: null, updatedAt: at, pendingReconciliationCount: 0 });
});

test("unenrolled and unbound coordinators never claim or leak credential/identity state", async (t) => {
  const h = await harness(t, 0, false); await h.coordinator.start();
  assert.equal(h.coordinator.getState().state, "unenrolled"); assert.equal(h.events.length, 0);
  await h.credentials.save({ workspaceId: "workspace-a", deviceToken: "d".repeat(43), protocolVersion: 1, bindings: [] });
  await h.coordinator.setContext("workspace-a");
  assert.equal(h.coordinator.getState().state, "unbound"); assert.equal(h.events.length, 0);
});

test("identity mapping receives distinct account and workspace identifiers and Sidecar generation re-resolves bindings", async (t) => {
  const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim"));
  assert.deepEqual(h.keys, [["account-0", "workspace-a"]]);
  await h.coordinator.onSidecarChanged(false, 1); assert.equal(h.coordinator.getState().state, "offline");
  const before = h.events.length; await h.clock.tick(100_000); assert.equal(h.events.length, before);
  await h.coordinator.onSidecarChanged(true, 2); await until(() => h.events.filter((e) => e.path === "/claim").length === 2);
  assert.deepEqual(h.keys, [["account-0", "workspace-a"], ["account-0", "workspace-a"]]);
  assert.equal((await h.credentials.load("workspace-a"))!.bindings.length, 1);
});

test("clearing the active workspace disables claims and reports unenrolled instead of stale stopping", async (t) => {
  const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim"));
  await h.coordinator.setContext(null); assert.equal(h.coordinator.getState().state, "unenrolled");
});

test("a disabled central execution gate is not a network outage and reopens without a duplicate action", async (t) => {
  const h = await harness(t);
  h.tasks.forEach((task: any) => h.served.add(task.actionId));
  let enabled = false;
  h.centralHook(async (path) => path === "/claim" && !enabled
    ? json({ error: "desktop_execution_disabled" }, 503) : undefined);
  await h.coordinator.start();
  await until(() => h.events.some((event) => event.path === "/claim"));
  await settle();
  assert.equal(h.coordinator.getState().state, "disabled");
  assert.equal(h.coordinator.getStatusMetadata().diagnostic, null);
  assert.deepEqual(await h.journal.list(), []);
  enabled = true;
  await h.clock.tick(2_000);
  await until(() => h.coordinator.getState().state === "idle");
  assert.equal(h.events.filter((event) => event.path === "/claim").length, 2);
  assert.equal(h.events.some((event) => event.path === "/internal/v1/douyin/actions/action-comment-001"), false);
});

for (const nextWorkspace of [null, "workspace-b"] as const) {
  test(`a ready-generation transition cannot replace the requested ${nextWorkspace === null ? "logout" : "workspace switch"} context`, async (t) => {
    const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
    await h.credentials.save({ workspaceId: "workspace-b", deviceToken: "b".repeat(43), protocolVersion: 1,
      bindings: [{ accountId: "account-0", bindingGeneration: 2 }] });
    const claims: string[] = [];
    h.centralHook(async (path, _body, init) => {
      if (path === "/claim") claims.push(new Headers(init?.headers).get("X-Shensi-Desktop-Device-Token") === "b".repeat(43) ? "workspace-b" : "workspace-a");
      return undefined;
    });
    await h.coordinator.start(); await until(() => claims.length === 1); await settle();
    const before = claims.length;
    const selection = h.coordinator.setContext(nextWorkspace);
    const ready = h.coordinator.onSidecarChanged(true, 2);
    await Promise.all([selection, ready]); await settle();
    assert.deepEqual(claims.slice(before), nextWorkspace === null ? [] : ["workspace-b"]);
    assert.equal(h.coordinator.getState().state, nextWorkspace === null ? "unenrolled" : "idle");
    await h.clock.tick(60_000);
    assert.equal(claims.slice(before).includes("workspace-a"), false);
    assert.equal(h.keys.slice(1).some(([, workspace]) => workspace === "workspace-a"), false);
  });
}

test("sidecar identity outage prevents claiming that account while another account remains usable", async (t) => {
  const h = await harness(t, 2);
  h.sidecarHook(async (path, body) => path.endsWith("/resolve") && body.account_key === "0".repeat(64) ? json({}, 503) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path.endsWith("action-dm-001/acknowledgement")));
  const claims = h.events.filter((e) => e.path === "/claim"); assert.ok(claims.length > 0);
  for (const claim of claims) assert.equal(claim.body.availableAccounts.some((a: any) => a.accountId === "account-0"), false);
});

for (const [failure, state, paused] of [["action_rejected", "failed", false], ["douyin_verification_required", "risk_paused", true],
  ["douyin_action_receipt_ambiguous", "reconciliation_required", true]] as const) {
  test(`a ${failure} receipt is durably uploaded and centrally classified without retrying the write`, async (t) => {
    const h = await harness(t);
    h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? json({ ...fixture.vectors[0].receipt,
      state: "failed", platform_receipt_reference: null, failure_code: failure }) : undefined);
    h.centralHook(async (path, body) => body.command?.event === "receipt" ? json({ actionId: path.split("/")[1], state, accountPaused: paused, occurredAt: at, replayed: false }) : undefined);
    await h.coordinator.start(); await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0);
    assert.equal(h.coordinator.getState().accounts[0].state, paused ? "risk_paused" : "idle");
    await h.clock.tick(4000); assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
  });
}

test("lost Sidecar response recovers read-only and never calls its write endpoint again", async (t) => {
  const h = await harness(t);
  h.sidecarHook(async (path) => { if (path === "/internal/v1/douyin/actions/action-comment-001") throw new Error("sidecar crashed"); return undefined; });
  h.centralHook(async (path) => {
    if (!path.endsWith("/reconcile")) return undefined;
    const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...task } = h.tasks[0];
    return json({ kind: "reconcile", replayed: false, taskToken: "r".repeat(43), task: { ...task, leaseVersion: 9, originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" } });
  });
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001"));
  await settle(); await h.clock.tick(4000);
  await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001/reconcile").length, 1);
});

test("lost acknowledgement retains the lane across restart and retries only the exact tombstone acknowledgement", async (t) => {
  const h = await harness(t); let ackCount = 0;
  h.sidecarHook(async (path) => { if (path.endsWith("/acknowledgement") && ++ackCount === 1) throw new Error("lost ack"); return undefined; });
  await h.coordinator.start(); await until(() => ackCount === 1); await settle(); assert.equal((await h.journal.list())[0].phase, "sidecar_completed");
  await h.coordinator.stop();
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json({ kind: "terminal", status: "succeeded", receiptHash: fixture.vectors[0].receiptHash, replayed: true }) : undefined);
  await h.coordinator.start(); await until(async () => ackCount === 2 && (await h.journal.list()).length === 0);
  assert.deepEqual(h.events.filter((e) => e.path.endsWith("/acknowledgement")).map((e) => e.body), Array(2).fill({
    request_hash: fixture.vectors[0].requestHash, receipt_hash: fixture.vectors[0].receiptHash }));
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
});

test("a changed login version and conflicting terminal hash fail closed", async (t) => {
  const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, "sidecar_completed"));
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json({ kind: "terminal", status: "succeeded", receiptHash: "f".repeat(64), replayed: false }) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path.endsWith("/reconcile"))); await settle();
  assert.equal((await h.journal.list())[0].receiptHash, fixture.vectors[0].receiptHash); assert.equal(h.events.some((e) => e.path.endsWith("/acknowledgement")), false);
  await h.coordinator.stop(); h.tasks[0].loginStateVersion++;
  await h.coordinator.onSidecarChanged(true, 4); await settle();
  assert.equal(h.coordinator.getState().accounts[0].state, "error");
});

test("every fresh start re-resolves durable bindings even without a generation callback", async (t) => {
  const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim")); await h.coordinator.stop(); h.tasks[0].loginStateVersion = 8;
  await h.coordinator.start(); await until(() => h.events.filter((e) => e.path === "/claim").length === 2);
  assert.equal(h.keys.length, 2);
  assert.equal(h.events.filter((e) => e.path === "/claim")[1].body.availableAccounts[0].loginStateVersion, 8);
});

test("a late cold-identity response from a stopped start cannot launch another poll in the new process", async (t) => {
  const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
  let release!: (response: Response) => void; let resolves = 0;
  h.sidecarHook(async (path) => path.endsWith("/resolve") && ++resolves === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  const firstStart = h.coordinator.start(); await until(() => Boolean(release)); await h.coordinator.stop();
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim")); await settle();
  release(json({ account_key: "0".repeat(64), account_handle: h.tasks[0].accountHandle, account_display_name: "old private identity",
    login_state_version: 7, profile_available: true })); await firstStart; await settle();
  assert.equal(h.events.filter((e) => e.path === "/claim").length, 1);
});

test("explicit shutdown invalidates a pending ready-generation transition instead of restarting claims after drain", async (t) => {
  const h = await harness(t); let release!: (response: Response) => void;
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  await h.coordinator.start(); await until(() => Boolean(release));
  const generation = h.coordinator.onSidecarChanged(true, 2); const shutdown = h.coordinator.stop();
  release(json(fixture.vectors[0].receipt)); await Promise.all([generation, shutdown]); await settle();
  const claimCount = h.events.filter((e) => e.path === "/claim").length;
  assert.equal(h.coordinator.getState().state, "stopping");
  await h.clock.tick(60_000); assert.equal(h.events.filter((e) => e.path === "/claim").length, claimCount);
  assert.equal(h.keys.length, 1);
});

test("pre-journal profile busy clears only after central queued without inventing Sidecar acknowledgement", async (t) => {
  const h = await harness(t);
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? json({ ...fixture.vectors[0].receipt,
    state: "failed", failure_code: "douyin_profile_busy", platform_receipt_reference: null }) : undefined);
  h.centralHook(async (path, body) => body.command?.event === "receipt" ? json({ actionId: path.split("/")[1], state: "queued", accountPaused: false, replayed: false, occurredAt: at }) : undefined);
  await h.coordinator.start(); await until(async () => h.events.some((e) => e.body.command?.event === "receipt") && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => e.path.endsWith("/acknowledgement")), false);
});

test("terminal queued recovery clears the exact receipt without generic acknowledgement-error suppression", async (t) => {
  const h = await harness(t);
  const busy = mapActionReceipt({ ...fixture.vectors[0].receipt, state: "failed", failure_code: "douyin_profile_busy", platform_receipt_reference: null }, h.tasks[0].actionId);
  await h.journal.save({ ...recoveryRecord(h, 0, "sidecar_completed"), receiptHash: busy.receiptHash });
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json({ kind: "terminal", status: "queued", receiptHash: busy.receiptHash, replayed: false }) : undefined);
  await h.coordinator.start(); await until(async () => h.events.some((e) => e.path.endsWith("/reconcile")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => e.path.endsWith("/acknowledgement")), false);
});

test("a missing acknowledgement for a normal terminal receipt still keeps the durable lane", async (t) => {
  const h = await harness(t); h.sidecarHook(async (path) => path.endsWith("/acknowledgement") ? json({}, 404) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path.endsWith("/acknowledgement"))); await settle();
  assert.equal((await h.journal.list())[0].phase, "sidecar_completed");
});

test("malformed claim and Sidecar receipt cannot authorize a write or central success", async (t) => {
  const h = await harness(t);
  h.centralHook(async (path) => path === "/claim" ? json({ kind: "claimed", task: { ...h.tasks[0], content: "tampered" }, taskToken: "t".repeat(43), serverTime: at, replayed: false }) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim")); await settle();
  assert.equal((await h.journal.list()).length, 0); assert.equal(h.events.some((e) => e.body.command), false);
  await h.coordinator.stop(); h.centralHook(async () => undefined);
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? json({ ...fixture.vectors[0].receipt, action_id: "wrong-action" }) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001")); await settle();
  assert.equal((await h.journal.list())[0].phase, "central_started"); assert.equal(h.events.some((e) => e.body.command?.event === "receipt"), false);
});

test("shutdown uploads an already executing receipt within the ten second grace", async (t) => {
  const h = await harness(t); let release!: (value: Response) => void;
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  await h.coordinator.start(); await until(() => Boolean(release)); const stopping = h.coordinator.stop();
  release(json(fixture.vectors[0].receipt)); await stopping;
  assert.equal((await h.journal.list()).length, 0); assert.equal(h.coordinator.getState().state, "stopping");
});

test("empty polling uses 3-5 second jitter and fresh logical claim keys", async (t) => {
  const h = await harness(t); h.tasks.forEach((task: any) => h.served.add(task.actionId));
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim")); await settle();
  await h.clock.tick(3999); assert.equal(h.events.filter((e) => e.path === "/claim").length, 1);
  await h.clock.tick(1); await until(() => h.events.filter((e) => e.path === "/claim").length === 2);
  const claims = h.events.filter((e) => e.path === "/claim"); assert.notEqual(claims[0].key, claims[1].key);
});

test("transport retries replay an identical lost claim and completion with bounded exponential backoff", async (t) => {
  const h = await harness(t); let claimCount = 0; let receiptCount = 0;
  h.centralHook(async (path, body) => {
    if (path === "/claim" && ++claimCount <= 7) throw new Error("offline");
    if (body.command?.event === "receipt" && ++receiptCount === 1) throw new Error("lost completion");
    return undefined;
  });
  await h.coordinator.start(); await until(() => claimCount === 1);
  for (const [i, ms] of [2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    await settle(); await h.clock.tick(ms - 1); assert.equal(claimCount, i + 1);
    await h.clock.tick(1); await until(() => claimCount === i + 2);
  }
  await until(() => receiptCount === 1); await settle(); await h.clock.tick(1999); assert.equal(receiptCount, 1);
  await h.clock.tick(1); await until(() => receiptCount === 2); await until(async () => (await h.journal.list()).length === 0);
  const claims = h.events.filter((e) => e.path === "/claim");
  assert.equal(new Set(claims.map((e) => e.key)).size, 1); assert.equal(new Set(claims.map((e) => JSON.stringify(e.body))).size, 1);
  const receipts = h.events.filter((e) => e.body.command?.event === "receipt");
  assert.equal(receipts[0].key, receipts[1].key); assert.deepEqual(receipts[0].body, receipts[1].body);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
});

test("central start failure never invokes Sidecar and keeps the claimed record", async (t) => {
  const h = await harness(t); h.centralHook(async (_path, body) => body.command?.event === "started" ? json({}, 403) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.body.command?.event === "started")); await settle();
  assert.equal((await h.journal.list())[0].phase, "claimed");
  assert.equal(h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001"), false);
});

test("two blocked account lanes prevent a third claim while independent lane B completes", async (t) => {
  const h = await harness(t, 3); let release!: (value: Response) => void;
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path.endsWith("action-dm-001/acknowledgement")));
  assert.equal(h.events.filter((e) => e.path === "/claim").length, 2);
  assert.equal((await h.journal.list()).some((r) => r.accountId === "account-0"), true);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
  release(json(fixture.vectors[0].receipt)); await until(async () => (await h.journal.list()).length === 0);
});

function recoveryRecord(h: Awaited<ReturnType<typeof harness>>, index: number, phase: OutreachActionRecoveryRecord["phase"]): OutreachActionRecoveryRecord {
  const task = h.tasks[index]; return { version: 1, actionId: task.actionId, accountId: task.accountId, workspaceId: task.workspaceId,
    requestHash: task.taskRequestHash, leaseVersion: 3, bindingGeneration: 2, loginStateVersion: task.loginStateVersion,
    phase, receiptHash: phase === "sidecar_completed" ? fixture.vectors[index].receiptHash : null, updatedAt: at };
}
test("restart recovers both durable accounts read-only with new process and new reconciliation fence", async (t) => {
  const h = await harness(t, 2);
  for (let i = 0; i < 2; i++) await h.journal.save(recoveryRecord(h, i, "central_started"));
  h.centralHook(async (path, body) => {
    if (!path.endsWith("/reconcile")) return undefined;
    const index = body.accountId === "account-0" ? 0 : 1; const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...task } = h.tasks[index];
    return json({ kind: "reconcile", replayed: false, taskToken: "r".repeat(43), task: { ...task, leaseVersion: 9, originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" } });
  });
  h.sidecarHook(async (path) => path.endsWith("action-dm-001/reconcile") ? json({ ...fixture.vectors[1].receipt,
    state: "succeeded", platform_receipt_reference: "douyin-dm:read-only-confirmed", failure_code: null }) : undefined);
  await h.coordinator.start(); await until(async () => h.events.filter((e) => e.path.endsWith("/acknowledgement")).length === 2 && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => /^\/internal\/v1\/douyin\/actions\/[^/]+$/.test(e.path)), false);
  const completions = h.events.filter((e) => e.body.command);
  assert.equal(completions.length, 2);
  for (const completion of completions) { assert.equal(completion.body.command.reconciliation, true); assert.equal(completion.body.command.leaseVersion, 9); }
});

test("terminal recovery acknowledges exact central hash without execution or completion", async (t) => {
  const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, "central_started"));
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json({ kind: "terminal", status: "succeeded", receiptHash: fixture.vectors[0].receiptHash, replayed: false }) : undefined);
  await h.coordinator.start(); await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => e.body.command), false);
  assert.equal(h.events.find((e) => e.path.endsWith("/acknowledgement"))!.body.receipt_hash, fixture.vectors[0].receiptHash);
});

test("waiting recovery makes fresh observations; not_authorized and hash conflicts retain the lane", async (t) => {
  const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, "claimed")); let calls = 0;
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json(++calls === 1 ? { kind: "waiting", retryAfterMs: 3000, replayed: false } : { kind: "not_authorized", replayed: false }) : undefined);
  await h.coordinator.start(); await until(() => calls === 1); await settle(); await h.clock.tick(4000); await until(() => calls === 2); await settle();
  const recovery = h.events.filter((e) => e.path.endsWith("/reconcile")); assert.notEqual(recovery[0].key, recovery[1].key);
  assert.equal((await h.journal.list())[0].phase, "claimed"); assert.equal(h.events.some((e) => e.path === "/claim"), false);
});

test("central released proof clears only the exact unstarted journal and then permits a new claim", async (t) => {
  const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, "claimed"));
  h.centralHook(async (path) => path.endsWith("/reconcile") ? json({ kind: "released", actionId: h.tasks[0].actionId,
    taskRequestHash: h.tasks[0].taskRequestHash, originalLeaseVersion: 3, replayed: false }) : undefined);
  await h.coordinator.start(); await until(async () => h.events.some((e) => e.path.endsWith("/reconcile")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => e.path.endsWith("/acknowledgement")), false);
  await h.clock.tick(4000); await until(() => h.events.some((e) => e.path === "/claim"));
  await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
});

test("local claimed can recover central durable started authority but uses only the read-only recovery fence", async (t) => {
  const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, "claimed"));
  h.centralHook(async (path) => {
    if (!path.endsWith("/reconcile")) return undefined;
    const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...task } = h.tasks[0];
    return json({ kind: "reconcile", replayed: false, taskToken: "r".repeat(43), task: { ...task, leaseVersion: 9, originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" } });
  });
  await h.coordinator.start(); await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0);
  assert.equal(h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001"), false);
  const completion = h.events.find((e) => e.body.command)!; assert.equal(completion.body.command.event, "receipt");
  assert.equal(completion.body.command.leaseVersion, 9); assert.equal(completion.body.command.reconciliation, true);
});

for (const boundary of ["no_sidecar_journal", "unuploaded_original_failure", "cached_original_failure"] as const) {
  test(`read-only recovery retains ${boundary} for checking without manufacturing a receipt or a write`, async (t) => {
    const h = await harness(t); await h.journal.save(recoveryRecord(h, 0, boundary === "no_sidecar_journal" ? "claimed" : "central_started"));
    h.centralHook(async (path) => {
      if (!path.endsWith("/reconcile")) return undefined;
      const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...task } = h.tasks[0];
      return json({ kind: "reconcile", replayed: false, taskToken: "r".repeat(43), task: { ...task, leaseVersion: 9,
        originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" } });
    });
    h.sidecarHook(async (path) => path.endsWith("/reconcile") ? boundary === "cached_original_failure"
      ? json({ ...fixture.vectors[0].receipt, state: "failed", failure_code: "action_rejected", platform_receipt_reference: null })
      : json({ code: "action_reconciliation_not_uncertain" }, 409) : undefined);
    await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/internal/v1/douyin/actions/action-comment-001/reconcile")); await settle();
    assert.equal((await h.journal.list()).length, 1);
    assert.equal(h.events.some((e) => e.body.command || e.path.endsWith("/acknowledgement") || e.path === "/internal/v1/douyin/actions/action-comment-001"), false);
    assert.equal(h.coordinator.getState().accounts[0].state, "reconciling");
  });
}

test("two simultaneously blocked lanes exclude a third account through every poll", async (t) => {
  const h = await harness(t, 3); const releases: Array<(value: Response) => void> = [];
  h.sidecarHook(async (path) => /^\/internal\/v1\/douyin\/actions\/[^/]+$/.test(path) ? new Promise<Response>((resolve) => { releases.push(resolve); }) : undefined);
  await h.coordinator.start(); await until(() => releases.length === 2);
  assert.equal((await h.journal.list()).length, 2); await h.clock.tick(4000);
  assert.equal(h.events.filter((e) => e.path === "/claim").length, 2);
  assert.equal(h.events.filter((e) => /^\/internal\/v1\/douyin\/actions\/[^/]+$/.test(e.path)).length, 2);
  releases.forEach((release, index) => release(json(fixture.vectors[index].receipt)));
  await until(async () => (await h.journal.list()).length === 0);
});

test("shutdown aborts outstanding poll without waiting for a hung transport", async (t) => {
  const h = await harness(t); h.centralHook(async (path) => path === "/claim" ? new Promise<Response>(() => {}) : undefined);
  await h.coordinator.start(); await until(() => h.events.some((e) => e.path === "/claim"));
  await h.coordinator.stop(); assert.equal(h.events.find((e) => e.path === "/claim")!.signal?.aborted, true);
  await h.clock.tick(60_000); assert.equal(h.events.filter((e) => e.path === "/claim").length, 1);
});

test("shutdown gives in-flight receipt ten seconds and never reuses old write authority after restart", async (t) => {
  const h = await harness(t); let release!: (response: Response) => void;
  h.sidecarHook(async (path) => path === "/internal/v1/douyin/actions/action-comment-001" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  await h.coordinator.start(); await until(() => Boolean(release)); const old = h.events.find((e) => e.body.command?.event === "started")!.body.processInstanceId;
  let stopped = false; const stopping = h.coordinator.stop().then(() => { stopped = true; });
  await h.clock.tick(9999); assert.equal(stopped, false); await h.clock.tick(1); await stopping;
  await h.coordinator.start(); release(json(fixture.vectors[0].receipt)); await settle();
  assert.equal(h.events.filter((e) => e.body.command?.event === "receipt").length, 0);
  await until(() => h.events.some((e) => e.path === "/action-comment-001/reconcile"));
  assert.notEqual(h.events.find((e) => e.path === "/action-comment-001/reconcile")!.body.processInstanceId, old);
  assert.equal(h.events.filter((e) => e.path === "/internal/v1/douyin/actions/action-comment-001").length, 1);
});

test("new action persists journal then started then local receipt then central receipt then exact ack then clear", async (t) => {
  const h = await harness(t); await h.coordinator.start();
  await until(async () => h.events.some((e) => e.path.endsWith("/acknowledgement")) && (await h.journal.list()).length === 0)
    .catch((error) => { assert.fail(`${error.message}: ${JSON.stringify({ events: h.events, state: h.coordinator.getState(), records: h.records })}`); });
  assert.deepEqual(h.records.map((r) => r.phase), ["claimed", "central_started", "sidecar_completed"]);
  assert.deepEqual(h.events.map((e) => e.path), ["/internal/v1/douyin/account-identities/resolve", "/claim", "/action-comment-001/complete", "/internal/v1/douyin/actions/action-comment-001", "/action-comment-001/complete", "/internal/v1/douyin/actions/action-comment-001/acknowledgement"]);
  assert.equal(h.events[5].body.receipt_hash, "c05a502bd41a0cb098d5e0474fefd6abd51987f0717e5949defd5dabec754006");
  const state = JSON.stringify(h.coordinator.getState());
  for (const secret of ["d".repeat(43), "t".repeat(43), "private display", h.tasks[0].content, h.tasks[0].accountHandle]) assert.equal(state.includes(secret), false);
});
