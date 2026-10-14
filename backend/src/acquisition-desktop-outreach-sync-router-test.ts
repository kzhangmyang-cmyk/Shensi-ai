import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import test from "node:test";

import { createDesktopClientAdmissionMiddleware } from "./desktop-client-admission.js";
import { createAcquisitionDesktopOutreachSyncRouter } from "./acquisition-desktop-outreach-sync-router.js";

const installationId = "i".repeat(43);
const deviceToken = "d".repeat(43);
const enrollmentToken = "e".repeat(43);
const taskToken = "t".repeat(43);
const processInstanceId = "p".repeat(43);
const accountHandle = `dyacct_${"a".repeat(64)}`;
const hash = "b".repeat(64);
const DEVICE_ID = "X-Shensi-Desktop-Installation-Id";
const DEVICE_TOKEN = "X-Shensi-Desktop-Device-Token";
const TASK_TOKEN = "X-Shensi-Desktop-Task-Token";

const claimBody = {
  protocolVersion: 1, processInstanceId, waitSeconds: 0,
  availableAccounts: [{ accountId: "account-a", accountHandle,
    loginStateVersion: 2, bindingGeneration: 3 }]
};
const completeBody = {
  protocolVersion: 1, processInstanceId, bindingGeneration: 3,
  command: { event: "started", leaseVersion: 4, loginStateVersion: 2,
    taskRequestHash: hash, occurredAt: "2026-09-05T00:00:00.000Z" }
};
const reconcileBody = {
  protocolVersion: 1, processInstanceId, accountId: "account-a", accountHandle,
  loginStateVersion: 2, bindingGeneration: 3, originalLeaseVersion: 4,
  taskRequestHash: hash, journalPhase: "claimed"
};
const userHeaders = { "Content-Type": "application/json", "X-Test-Auth": "yes",
  "X-Test-Workspace": "yes", "Idempotency-Key": "idempotency-key-1" };
const deviceHeaders = { "Content-Type": "application/json", "Idempotency-Key": "idempotency-key-1",
  [DEVICE_ID]: installationId, [DEVICE_TOKEN]: deviceToken };

function fixture(options: { desktopExecutionEnabled?: boolean; omitDesktopExecutionGate?: boolean;
  admission?: "locked" | "exact"; activePrincipal?: boolean; serviceError?: string;
  registrationReplay?: boolean; claimEmpty?: boolean } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const app = express();
  if (options.admission) {
    app.use(createDesktopClientAdmissionMiddleware(options.admission === "locked"
      ? { mode: "migration_locked" }
      : { mode: "exact", admittedBuildManifestSha256: "a".repeat(64) }));
  }
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("X-Test-Auth") === "yes") req.user = { id: "user-a", teamId: "team-a" } as never;
    if (req.header("X-Test-Workspace") === "yes") req.activeWorkspace = {
      workspaceId: "workspace-a", actorId: req.header("X-Test-Actor") ?? "user-a",
      teamId: "team-a", capabilities: req.header("X-Test-Capability") === "no" ? [] : ["acquisition.outreach.approve"]
    } as never;
    next();
  });
  const principal = options.activePrincipal === false ? null : { workspaceId: "workspace-a",
    userId: "user-a", teamId: "team-a", deviceIdHash: "sha256:private-device-hash", protocolVersion: 1 as const };
  const installationService = {
    async createEnrollment(...args: unknown[]) { calls.push({ name: "enroll", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { token: enrollmentToken, expiresAt: "2026-09-05T00:01:00.000Z" }; },
    async register(...args: unknown[]) { calls.push({ name: "register", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { deviceToken, workspaceId: "workspace-a", protocolVersion: 1 as const,
        replayed: options.registrationReplay === true,
        deviceIdHash: "sha256:must-never-leak" }; },
    async authenticateDevice(...args: unknown[]) { calls.push({ name: "authenticate", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return principal; },
    async getDesktopBindingStatus(...args: unknown[]) { calls.push({ name: "binding-status", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { accountId: "account-a", executorMode: "desktop", bindingGeneration: 3,
        leaseExpiresAt: "2026-09-05T00:02:00.000Z", ownedByInstallation: false,
        hasUnresolvedActions: true, internalDeviceIdHash: "sha256:must-never-leak" }; },
    async bindDesktopExecutor(...args: unknown[]) { calls.push({ name: "binding", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { accountId: "account-a", executorMode: "desktop" as const, bindingGeneration: 3,
        leaseExpiresAt: "2026-09-05T00:02:00.000Z", ownedByInstallation: true,
        internalDeviceIdHash: "sha256:must-never-leak" }; }
  };
  const outreachSync = {
    async claim(...args: unknown[]) { calls.push({ name: "claim", args });
      if (options.serviceError) throw new Error(options.serviceError);
      if (options.claimEmpty) return { kind: "empty" as const,
        serverTime: "2026-09-05T00:00:00.000Z", retryAfterMs: 3_000,
        replayed: true, internalProcessHash: "sha256:must-never-leak" };
      return { kind: "claimed" as const, taskToken, serverTime: "2026-09-05T00:00:00.000Z", replayed: false,
        task: { actionId: "action-a", workspaceId: "workspace-a", accountId: "account-a",
          accountHandle, loginStateVersion: 2,
          executorBindingGeneration: 3, kind: "comment", canonicalTargetPublicUrl: "https://www.douyin.com/x",
          content: "hello", approvedContentHash: "sha256:" + hash, taskRequestHash: hash,
          deadlineAt: "2026-09-05T00:01:00.000Z", leaseVersion: 4, leaseExpiresAt: "2026-09-05T00:01:30.000Z",
          predecessorReceipt: null }, fence: { deviceIdHash: "sha256:private-device-hash" },
        internalProcessHash: "sha256:must-never-leak" }; },
    async complete(...args: unknown[]) { calls.push({ name: "complete", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { actionId: "action-a", state: "executing", replayed: false, accountPaused: false,
        occurredAt: "2026-09-05T00:00:00.000Z", internalTaskTokenHash: "sha256:must-never-leak" }; },
    async reconcile(...args: unknown[]) { calls.push({ name: "reconcile", args });
      if (options.serviceError) throw new Error(options.serviceError);
      return { kind: "terminal" as const, status: "succeeded", receiptHash: hash,
        replayed: false, internalDeviceIdHash: "sha256:must-never-leak" }; }
  };
  app.use("/api/v1/acquisition", createAcquisitionDesktopOutreachSyncRouter({
    installationService: installationService as never, outreachSync: outreachSync as never,
    ...(options.omitDesktopExecutionGate ? {}
      : { desktopExecutionEnabled: options.desktopExecutionEnabled ?? true })
  }));
  return { app, calls };
}

async function request(app: express.Express, path: string, init: RequestInit = {}) {
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try { const address = server.address(); assert.ok(address && typeof address === "object");
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function rawRequest(app: express.Express, path: string, headers: Record<string, string | string[]>, body: string) {
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try { const address = server.address(); assert.ok(address && typeof address === "object");
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: address.port, path, method: "POST", headers }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text })); });
      req.on("error", reject); req.end(body);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("public installation routes return only their prescribed enrollment, registration, and binding projections", async () => {
  const { app, calls } = fixture();
  const enrollment = await request(app, "/api/v1/acquisition/desktop-installations/enrollments", { method: "POST", headers: userHeaders,
    body: JSON.stringify({ protocolVersion: 1, installationId }) });
  assert.equal(enrollment.status, 201); assert.deepEqual(await enrollment.json(), { enrollmentToken, expiresAt: "2026-09-05T00:01:00.000Z" });
  const registration = await request(app, "/api/v1/acquisition/desktop-installations/register", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "idempotency-key-1" },
    body: JSON.stringify({ protocolVersion: 1, installationId, enrollmentToken }) });
  assert.equal(registration.status, 201); assert.deepEqual(await registration.json(), { deviceToken, workspaceId: "workspace-a", protocolVersion: 1 });
  const replayFixture = fixture({ registrationReplay: true });
  const replay = await request(replayFixture.app, "/api/v1/acquisition/desktop-installations/register", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "idempotency-key-1" },
    body: JSON.stringify({ protocolVersion: 1, installationId, enrollmentToken }) });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { deviceToken,
    workspaceId: "workspace-a", protocolVersion: 1 });
  const binding = await request(app, "/api/v1/acquisition/social-accounts/account-a/desktop-binding", { method: "POST", headers: userHeaders,
    body: JSON.stringify({ installationId, accountHandle, loginStateVersion: 2, expectedBindingGeneration: 2, handoff: false }) });
  assert.equal(binding.status, 200); assert.deepEqual(await binding.json(), { accountId: "account-a", executorMode: "desktop", bindingGeneration: 3,
    leaseExpiresAt: "2026-09-05T00:02:00.000Z", ownedByInstallation: true });
  assert.deepEqual(calls.map((call) => call.name), ["enroll", "register", "binding"]);
  assert.equal((calls[1].args[2] as string), createHash("sha256").update(JSON.stringify({ enrollmentToken, installationId, protocolVersion: 1 })).digest("hex"));
});

test("binding status is authenticated, strictly scoped, read-only and never exposes device identity", async () => {
  const { app, calls } = fixture({ desktopExecutionEnabled: false });
  const path = `/api/v1/acquisition/social-accounts/account-a/desktop-binding?installationId=${installationId}`;
  const result = await request(app, path, { headers: userHeaders });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { accountId: "account-a", executorMode: "desktop",
    bindingGeneration: 3, leaseExpiresAt: "2026-09-05T00:02:00.000Z",
    ownedByInstallation: false, hasUnresolvedActions: true });
  assert.deepEqual(calls, [{ name: "binding-status", args: [
    { workspaceId: "workspace-a", userId: "user-a", teamId: "team-a" },
    "account-a", installationId
  ] }]);
  for (const query of ["", `?installationId=${installationId}&extra=true`,
    `?installationId=${installationId}&installationId=${installationId}`]) {
    assert.equal((await request(app, path.split("?")[0] + query,
      { headers: userHeaders })).status, 400);
  }
  assert.equal((await request(app, path)).status, 401);
  assert.equal((await request(app, path, { headers: { ...userHeaders,
    "X-Test-Actor": "other-user" } })).status, 403);
  assert.equal((await request(app, path, { headers: { ...userHeaders,
    "X-Test-Capability": "no" } })).status, 403);
  assert.equal(calls.length, 1);
});

test("desktop action routes authenticate physical device headers and project fence internals away", async () => {
  const { app, calls } = fixture();
  const claim = await request(app, "/api/v1/acquisition/desktop-outreach-actions/claim", { method: "POST", headers: deviceHeaders, body: JSON.stringify(claimBody) });
  assert.equal(claim.status, 200); const claimJson = await claim.json() as Record<string, unknown>;
  assert.deepEqual(claimJson, { kind: "claimed", taskToken,
    serverTime: "2026-09-05T00:00:00.000Z", replayed: false,
    task: { actionId: "action-a", workspaceId: "workspace-a", accountId: "account-a",
      accountHandle, loginStateVersion: 2, executorBindingGeneration: 3,
      kind: "comment", canonicalTargetPublicUrl: "https://www.douyin.com/x",
      content: "hello", approvedContentHash: "sha256:" + hash,
      taskRequestHash: hash, deadlineAt: "2026-09-05T00:01:00.000Z",
      leaseVersion: 4, leaseExpiresAt: "2026-09-05T00:01:30.000Z",
      predecessorReceipt: null } });
  assert.equal(JSON.stringify(claimJson).includes("must-never-leak"), false);
  const complete = await request(app, "/api/v1/acquisition/desktop-outreach-actions/action-a/complete", { method: "POST", headers: { ...deviceHeaders, [TASK_TOKEN]: taskToken }, body: JSON.stringify(completeBody) });
  assert.equal(complete.status, 200); assert.deepEqual(await complete.json(), { actionId: "action-a", state: "executing", replayed: false, accountPaused: false, occurredAt: "2026-09-05T00:00:00.000Z" });
  const reconcile = await request(app, "/api/v1/acquisition/desktop-outreach-actions/action-a/reconcile", { method: "POST", headers: deviceHeaders, body: JSON.stringify(reconcileBody) });
  assert.equal(reconcile.status, 200); assert.deepEqual(await reconcile.json(), { kind: "terminal", status: "succeeded", receiptHash: hash, replayed: false });
  assert.deepEqual(calls.map((call) => call.name), ["authenticate", "claim", "authenticate", "complete", "authenticate", "reconcile"]);
  assert.deepEqual(calls[1].args, [{ workspaceId: "workspace-a", userId: "user-a",
    teamId: "team-a", deviceIdHash: "sha256:private-device-hash", protocolVersion: 1 },
  { processInstanceId, availableAccounts: claimBody.availableAccounts,
    idempotencyKey: "idempotency-key-1" }]);
  assert.deepEqual(calls[3].args[2], { event: "started", leaseVersion: 4,
    loginStateVersion: 2, taskRequestHash: hash,
    occurredAt: "2026-09-05T00:00:00.000Z", processInstanceId, taskToken,
    executorBindingGeneration: 3, idempotencyKey: "idempotency-key-1" });
  assert.deepEqual(calls[5].args[2], { version: 1, processInstanceId,
    accountId: "account-a", accountHandle, loginStateVersion: 2,
    bindingGeneration: 3, originalLeaseVersion: 4, taskRequestHash: hash,
    journalPhase: "claimed", idempotencyKey: "idempotency-key-1" });
});

test("empty claim responses are projected and omitted execution gates fail closed", async () => {
  const empty = fixture({ claimEmpty: true });
  const response = await request(empty.app, "/api/v1/acquisition/desktop-outreach-actions/claim",
    { method: "POST", headers: deviceHeaders, body: JSON.stringify(claimBody) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {
    kind: "empty", serverTime: "2026-09-05T00:00:00.000Z",
    retryAfterMs: 3_000, replayed: true });
  const omitted = fixture({ omitDesktopExecutionGate: true });
  const rejected = await request(omitted.app,
    "/api/v1/acquisition/desktop-outreach-actions/claim",
    { method: "POST", headers: deviceHeaders, body: JSON.stringify(claimBody) });
  assert.equal(rejected.status, 503); assert.deepEqual(await rejected.json(), {
    error: "desktop_execution_disabled" }); assert.equal(omitted.calls.length, 0);
});

test("strict transport rejects unknown bodies, media types, bad methods, and unauthorized user contexts before service calls", async () => {
  const paths = ["/desktop-installations/enrollments", "/desktop-installations/register", "/social-accounts/account-a/desktop-binding",
    "/desktop-outreach-actions/claim", "/desktop-outreach-actions/action-a/complete", "/desktop-outreach-actions/action-a/reconcile"];
  for (const path of paths) { const { app } = fixture(); const response = await request(app, `/api/v1/acquisition${path}`, { method: "PUT" }); assert.equal(response.status, 405, path); }
  const { app, calls } = fixture();
  const badJson = await request(app, "/api/v1/acquisition/desktop-installations/enrollments", { method: "POST", headers: userHeaders, body: JSON.stringify({ protocolVersion: 1, installationId, extra: true }) });
  assert.equal(badJson.status, 400); assert.equal(calls.length, 0);
  const media = await request(app, "/api/v1/acquisition/desktop-installations/register", { method: "POST", headers: { "Content-Type": "text/plain", "Idempotency-Key": "idempotency-key-1" }, body: "x" });
  assert.equal(media.status, 415); assert.deepEqual(await media.json(), { error: "unsupported_media_type" });
  const forbidden = await request(app, "/api/v1/acquisition/desktop-installations/enrollments", { method: "POST", headers: { ...userHeaders, "X-Test-Capability": "no" }, body: JSON.stringify({ protocolVersion: 1, installationId }) });
  assert.equal(forbidden.status, 403); const invalidContext = await request(app, "/api/v1/acquisition/desktop-installations/enrollments", { method: "POST", headers: { ...userHeaders, "X-Test-Actor": "other-user" }, body: JSON.stringify({ protocolVersion: 1, installationId }) });
  assert.equal(invalidContext.status, 403); assert.equal(calls.length, 0);
});

test("device proof rejects cookies and missing duplicate comma-joined or malformed physical headers without authentication calls", async () => {
  const cases: Array<[string, Record<string, string | string[]>]> = [
    ["cookie", { "Content-Type": "application/json", Cookie: "session=browser" }],
    ["missing", { "Content-Type": "application/json", [DEVICE_ID]: installationId }],
    ["duplicate", { ...deviceHeaders, [DEVICE_ID]: [installationId, installationId] }],
    ["comma", { ...deviceHeaders, [DEVICE_TOKEN]: `${deviceToken},${deviceToken}` }],
    ["malformed", { ...deviceHeaders, [DEVICE_TOKEN]: "bad" }]
  ];
  for (const [name, headers] of cases) { const { app, calls } = fixture(); const response = await rawRequest(app, "/api/v1/acquisition/desktop-outreach-actions/claim", headers, JSON.stringify(claimBody));
    assert.equal(response.status, 401, name); assert.deepEqual(JSON.parse(response.body), { error: "desktop_device_authentication_required" }, name); assert.equal(calls.length, 0, name); }
});

test("complete requires one well-formed task capability and action services keep inactive or absent authority non-enumerating", async () => {
  for (const taskHeader of [undefined, [taskToken, taskToken] as unknown as string, `${taskToken},${taskToken}`, "bad"]) {
    const { app, calls } = fixture(); const headers = { ...deviceHeaders, ...(taskHeader === undefined ? {} : { [TASK_TOKEN]: taskHeader }) } as Record<string, string | string[]>;
    const response = await rawRequest(app, "/api/v1/acquisition/desktop-outreach-actions/action-a/complete", headers, JSON.stringify(completeBody));
    assert.equal(response.status, 400); assert.equal(calls.length, 1);
  }
  const { app, calls } = fixture({ activePrincipal: false });
  const response = await request(app, "/api/v1/acquisition/desktop-outreach-actions/action-elsewhere/reconcile", { method: "POST", headers: deviceHeaders, body: JSON.stringify(reconcileBody) });
  assert.equal(response.status, 401); assert.equal(calls.length, 1);
});

test("claim and reconcile reject every physical task capability header before sync", async () => {
  const paths = ["/desktop-outreach-actions/claim",
    "/desktop-outreach-actions/action-a/reconcile"] as const;
  const bodies = [claimBody, reconcileBody] as const;
  const values: Array<string | string[]> = [taskToken, [taskToken, taskToken],
    `${taskToken},${taskToken}`, "bad"];
  for (let index = 0; index < paths.length; index += 1) {
    for (const value of values) {
      const { app, calls } = fixture();
      const response = await rawRequest(app, `/api/v1/acquisition${paths[index]}`,
        { ...deviceHeaders, "x-shensi-desktop-task-token": value },
        JSON.stringify(bodies[index]));
      assert.equal(response.status, 400); assert.deepEqual(JSON.parse(response.body),
        { error: "unexpected_desktop_task_token" });
      assert.equal(calls.length, 0);
    }
  }
});

test("service conflicts, expiry, unavailable execution, and raw secret failures map to stable non-echoing transport responses", async () => {
  for (const [code, status] of [["desktop_registration_idempotency_conflict", 409], ["desktop_enrollment_expired", 410], ["social_account_not_found", 404], ["desktop_outreach_start_expired", 410], ["desktop_action_replay_conflict", 409]] as const) {
    const { app } = fixture({ serviceError: code });
    const path = code.startsWith("desktop_registration") || code.startsWith("desktop_enrollment") ? "/desktop-installations/register" : code === "social_account_not_found" ? "/social-accounts/account-elsewhere/desktop-binding" : "/desktop-outreach-actions/action-a/complete";
    const headers = path.includes("desktop-installations") ? { "Content-Type": "application/json", "Idempotency-Key": "idempotency-key-1" } : path.includes("social-") ? userHeaders : { ...deviceHeaders, [TASK_TOKEN]: taskToken };
    const body = path.includes("desktop-installations") ? { protocolVersion: 1, installationId, enrollmentToken } : path.includes("social-") ? { installationId, accountHandle, loginStateVersion: 2, expectedBindingGeneration: 2, handoff: false } : completeBody;
    const response = await request(app, `/api/v1/acquisition${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, status, code); const text = await response.text(); assert.equal(text.includes(taskToken), false, code); assert.equal(text.includes(deviceToken), false, code);
  }
  const disabled = fixture({ desktopExecutionEnabled: false });
  const response = await request(disabled.app, "/api/v1/acquisition/desktop-outreach-actions/claim", { method: "POST", headers: deviceHeaders, body: JSON.stringify(claimBody) });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "desktop_execution_disabled" }); assert.equal(disabled.calls.length, 0);
});

test("admission before JSON parsing stops all six desktop operations and an admitted request still reaches router authentication", async () => {
  const paths = ["/desktop-installations/enrollments", "/desktop-installations/register", "/social-accounts/account-a/desktop-binding", "/desktop-outreach-actions/claim", "/desktop-outreach-actions/action-a/complete", "/desktop-outreach-actions/action-a/reconcile"];
  for (const path of paths) { const locked = fixture({ admission: "locked" }); const response = await request(locked.app, `/api/v1/acquisition${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }); assert.equal(response.status, 503, path); assert.equal(locked.calls.length, 0, path); }
  const exact = fixture({ admission: "exact" }); const response = await request(exact.app, "/api/v1/acquisition/desktop-outreach-actions/claim", { method: "POST", headers: { ...deviceHeaders, "X-Shensi-Desktop-Build-Manifest-SHA256": "a".repeat(64) }, body: JSON.stringify({ ...claimBody, extra: true }) });
  assert.equal(response.status, 400); assert.equal(exact.calls.length, 1);
});
