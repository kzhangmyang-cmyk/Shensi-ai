import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import express from "express";
import { createAcquisitionOpenApiPaths } from "./acquisition-openapi.js";
import { createAcquisitionDesktopOutreachSyncRouter } from "./acquisition-desktop-outreach-sync-router.js";
import { createDesktopClientAdmissionMiddleware } from "./desktop-client-admission.js";
import { loadPublishedAcquisitionPaths, loadValidatedProductionAcquisitionPaths,
  operationSurface } from "./acquisition-openapi-contract-test-helpers.js";
import type { DesktopOutreachClaimResult, DesktopOutreachCompletionResult,
  DesktopOutreachRecoveryResult } from "./acquisition-outreach-batch-repository.js";

const prefix = "/api/v1/acquisition";
const paths = {
  enroll: `${prefix}/desktop-installations/enrollments`,
  register: `${prefix}/desktop-installations/register`,
  bind: `${prefix}/social-accounts/{accountId}/desktop-binding`,
  claim: `${prefix}/desktop-outreach-actions/claim`,
  complete: `${prefix}/desktop-outreach-actions/{actionId}/complete`,
  reconcile: `${prefix}/desktop-outreach-actions/{actionId}/reconcile`
};
const token = "t".repeat(43);
const hash = "a".repeat(64);
const at = "2026-09-05T00:00:00.000Z";
const account = { accountId: "account-a", accountHandle: `dyacct_${hash}`,
  loginStateVersion: 2, bindingGeneration: 3 };
const task = { actionId: "action-a", workspaceId: "workspace-a",
  accountId: account.accountId, accountHandle: account.accountHandle,
  loginStateVersion: 2, executorBindingGeneration: 3, kind: "comment" as const,
  canonicalTargetPublicUrl: "https://www.douyin.com/video/7350000000000000001",
  content: "已审批的评论", approvedContentHash: `sha256:${hash}`,
  taskRequestHash: hash, deadlineAt: at, leaseVersion: 4,
  leaseExpiresAt: at, predecessorReceipt: null };
const recoveryTask = { actionId: task.actionId, workspaceId: task.workspaceId,
  accountId: task.accountId, accountHandle: task.accountHandle,
  loginStateVersion: task.loginStateVersion,
  executorBindingGeneration: task.executorBindingGeneration, kind: task.kind,
  canonicalTargetPublicUrl: task.canonicalTargetPublicUrl, content: task.content,
  approvedContentHash: task.approvedContentHash, deadlineAt: at,
  taskRequestHash: hash, leaseVersion: 4, originalLeaseVersion: 4,
  reconciliationGeneration: 1, capability: "reconcile_only" as const };
const claim = { protocolVersion: 1, processInstanceId: token, waitSeconds: 0,
  availableAccounts: [account] };
const started = { event: "started", leaseVersion: 4, loginStateVersion: 2,
  taskRequestHash: hash, occurredAt: at };
const complete = { protocolVersion: 1, processInstanceId: token,
  bindingGeneration: 3, command: started };
const receipt = { actionId: task.actionId, state: "succeeded",
  platformReceiptReference: "receipt-a", occurredAt: at, failureCode: null };
const reconcile = { protocolVersion: 1, processInstanceId: token,
  ...account, originalLeaseVersion: 4, taskRequestHash: hash,
  journalPhase: "central_started" };
const runtime = createAcquisitionOpenApiPaths();
const published = loadPublishedAcquisitionPaths();

test("unstarted release is a closed exact-fence response distinct from receipt terminal", async () => {
  const released = { kind: "released", actionId: task.actionId, taskRequestHash: hash,
    originalLeaseVersion: 4, replayed: false };
  for (const source of [runtime, await published]) {
    const schema = source[paths.reconcile]!.post!.responses[200].content["application/json"].schema;
    assertValid(schema, released);
    for (const bad of [without(released, "actionId"), without(released, "taskRequestHash"),
      without(released, "originalLeaseVersion"), { ...released, originalLeaseVersion: 0 },
      { ...released, taskRequestHash: "bad" }, { ...released, receiptHash: hash },
      { ...released, taskToken: token }, { ...released, state: "queued" }]) {
      assert.equal(validate(schema, bad).valid, false);
    }
  }
});

function validate(schema: object, value: unknown) {
  const check = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
  return { valid: check(value), errors: check.errors };
}
function assertValid(schema: object, value: unknown) {
  const result = validate(schema, value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}
function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value }; delete copy[key]; return copy;
}

test("all six desktop operations preserve the published production contract and distinct auth", async () => {
  const source = await published;
  const production = await loadValidatedProductionAcquisitionPaths();
  for (const [name, path] of Object.entries(paths)) {
    assert.deepEqual(operationSurface(production[path]!.post!),
      operationSurface(source[path]!.post!), path);
    const operation = source[path]!.post!;
    assert.deepEqual(operation.security, name === "register" ? []
      : name === "enroll" || name === "bind"
        ? [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }]
        : [{ desktopInstallationId: [], desktopDeviceToken: [] }]);
    const headers = operation.parameters.filter((p: any) => p.in === "header");
    for (const header of ["X-Shensi-Desktop-Build-Manifest-SHA256", "Idempotency-Key"]) {
      assert.equal(headers.find((p: any) => p.name === header)?.required, true, `${name}: ${header}`);
    }
    assert.equal(headers.some((p: any) => p.name === "X-Shensi-Desktop-Task-Token"), name === "complete");
    assert.ok(operation.responses["409"]);
    assert.ok(operation.responses["503"]);
  }
  assert.match(source[paths.claim]!.post!.description, /Task-Token is forbidden/);
  assert.match(source[paths.reconcile]!.post!.description, /Task-Token is forbidden/);
});

test("binding read has closed non-secret projection and production contract parity", async () => {
  const source = await published;
  const production = await loadValidatedProductionAcquisitionPaths();
  assert.deepEqual(operationSurface(production[paths.bind]!.get!), operationSurface(source[paths.bind]!.get!));
  const value = { accountId: "account-a", executorMode: null, bindingGeneration: 0,
    leaseExpiresAt: null, ownedByInstallation: false, hasUnresolvedActions: false };
  for (const document of [runtime, source]) {
    const operation = document[paths.bind]!.get!;
    assert.deepEqual(operation.security, [{ bearerAuth: [] }, { cookieAuth: [] }]);
    const schema = operation.responses[200].content["application/json"].schema;
    assertValid(schema, value);
    assertValid(schema, { ...value, executorMode: "desktop", bindingGeneration: 2,
      leaseExpiresAt: at, ownedByInstallation: true, hasUnresolvedActions: true });
    for (const bad of [{ ...value, bindingGeneration: -1 }, { ...value, accountHandle: "secret" },
      { ...value, deviceIdHash: hash }, without(value, "hasUnresolvedActions")]) {
      assert.equal(validate(schema, bad).valid, false);
    }
  }
});

test("desktop requests require full frozen snapshots and reject mixed receipt/journal states", async () => {
  for (const document of [runtime, await published]) {
    const requestSchema = (path: string) => (document[path]!.post! as any)
      .requestBody.content["application/json"].schema;
    assertValid(requestSchema(paths.claim), claim);
    for (const bad of [{ ...claim, waitSeconds: 1 }, { ...claim, protocolVersion: 2 },
      { ...claim, availableAccounts: [] }, { ...claim, availableAccounts: [account, account] },
      { ...claim, taskToken: token }, { ...claim, workspaceId: "other" }]) {
      assert.equal(validate(requestSchema(paths.claim), bad).valid, false);
    }
    assertValid(requestSchema(paths.complete), complete);
    for (const field of ["leaseVersion", "loginStateVersion", "taskRequestHash", "occurredAt"]) {
      assert.equal(validate(requestSchema(paths.complete), {
        ...complete, command: without(started, field)
      }).valid, false, field);
    }
    for (const bad of [{ ...complete, taskToken: token },
      { ...complete, bindingGeneration: 0 },
      { ...complete, command: { ...started, receipt } },
      { ...complete, command: { ...started, occurredAt: "2026-09-05T00:00:00Z" } }]) {
      assert.equal(validate(requestSchema(paths.complete), bad).valid, false);
    }
    const receiptCommand = { event: "receipt", leaseVersion: 4, loginStateVersion: 2,
      taskRequestHash: hash, reconciliation: false, receipt };
    for (const reconciliation of [false, true]) assertValid(requestSchema(paths.complete), {
      ...complete, command: { ...receiptCommand, reconciliation }
    });
    assert.equal(validate(requestSchema(paths.complete), { ...complete, command: {
      ...receiptCommand, receipt: { ...receipt, failureCode: "action_rejected" }
    } }).valid, false);
    const failedReceipt = { ...receipt, state: "failed", platformReceiptReference: null,
      failureCode: "action_rejected" };
    assertValid(requestSchema(paths.complete), { ...complete, command: {
      ...receiptCommand, receipt: failedReceipt
    } });
    assert.equal(validate(requestSchema(paths.complete), { ...complete, command: {
      ...receiptCommand, reconciliation: true, receipt: failedReceipt
    } }).valid, false);
    assertValid(requestSchema(paths.complete), { ...complete, command: {
      ...receiptCommand, reconciliation: true,
      receipt: { ...failedReceipt, failureCode: "action_unavailable" }
    } });
    assertValid(requestSchema(paths.reconcile), reconcile);
    assertValid(requestSchema(paths.reconcile), { ...reconcile,
      journalPhase: "sidecar_completed", receiptHash: hash });
    for (const bad of [{ ...reconcile, receiptHash: hash },
      { ...reconcile, journalPhase: "sidecar_completed" },
      { ...reconcile, taskToken: token }, without(reconcile, "originalLeaseVersion"),
      without(reconcile, "accountHandle"), without(reconcile, "taskRequestHash")]) {
      assert.equal(validate(requestSchema(paths.reconcile), bad).valid, false);
    }
  }
});

test("real router projections and admission failures conform to the desktop response unions", async () => {
  let claimed = true;
  let humanClaim = false;
  let observationLoginStateVersion: number | undefined;
  let registrationReplay = false;
  let recovery: DesktopOutreachRecoveryResult = { kind: "reconcile", task: recoveryTask,
    taskToken: token, replayed: false };
  let completionState: DesktopOutreachCompletionResult["state"] = "executing";
  const app = express();
  let admission = createDesktopClientAdmissionMiddleware({ mode: "exact", admittedBuildManifestSha256: hash });
  app.use((request, response, next) => admission(request, response, next));
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "user-a", teamId: "team-a" } as never;
    request.activeWorkspace = { workspaceId: "workspace-a", actorId: "user-a",
      teamId: "team-a", capabilities: ["acquisition.outreach.approve"] } as never;
    next();
  });
  app.use(prefix, createAcquisitionDesktopOutreachSyncRouter({ desktopExecutionEnabled: true,
    installationService: {
      async createEnrollment() { return { token, expiresAt: at }; },
      async register() { return { deviceToken: token, workspaceId: "workspace-a",
        protocolVersion: 1, replayed: registrationReplay }; },
      async authenticateDevice() { return { workspaceId: "workspace-a", userId: "user-a",
        teamId: "team-a", deviceIdHash: `sha256:${hash}`, protocolVersion: 1 }; },
      async bindDesktopExecutor() { return { accountId: account.accountId, executorMode: "desktop",
        bindingGeneration: 3, leaseExpiresAt: at, ownedByInstallation: true }; }
    },
    outreachSync: {
      async claim(): Promise<DesktopOutreachClaimResult | (Extract<DesktopOutreachRecoveryResult, { kind: "reconcile" }> & { serverTime: string })> {
        if (humanClaim) return { kind: "reconcile", task: { ...recoveryTask,
          ...(observationLoginStateVersion === undefined ? {} : { observationLoginStateVersion }) }, taskToken: token,
          serverTime: at, replayed: false };
        return claimed ? { kind: "claimed", task, taskToken: token,
          serverTime: at, replayed: false, fence: {} as never }
          : { kind: "empty", serverTime: at, retryAfterMs: 3000, replayed: true };
      },
      async complete() { return { actionId: task.actionId, state: completionState,
        replayed: false, accountPaused: false, occurredAt: at }; },
      async reconcile() { return recovery; }
    }
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const source = await published;
  async function post(path: string, body: unknown, expected = 200, digest = hash) {
    const response = await fetch(`${origin}${path
      .replace("{accountId}", account.accountId).replace("{actionId}", task.actionId)}`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "contract-key",
        "X-Shensi-Desktop-Build-Manifest-SHA256": digest,
        "X-Shensi-Desktop-Installation-Id": token, "X-Shensi-Desktop-Device-Token": token,
        ...(path === paths.complete ? { "X-Shensi-Desktop-Task-Token": token } : {}) },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, expected);
    const actual = await response.json();
    for (const document of [runtime, source]) {
      const schema = (document[path]!.post! as any).responses[String(expected)]
        .content["application/json"].schema;
      assertValid(schema, actual);
      if (expected < 300) assert.equal(validate(schema, { ...actual, fence: {} }).valid, false);
    }
    return actual;
  }
  try {
    await post(paths.enroll, { protocolVersion: 1, installationId: token }, 201);
    const registration = { protocolVersion: 1, installationId: token, enrollmentToken: token };
    await post(paths.register, registration, 201);
    registrationReplay = true; await post(paths.register, registration);
    await post(paths.bind, { installationId: token, accountHandle: account.accountHandle,
      loginStateVersion: 2, expectedBindingGeneration: 2, handoff: false });
    await post(paths.claim, claim);
    claimed = false; await post(paths.claim, claim);
    humanClaim = true;
    assert.deepEqual((await post(paths.claim, claim)).task, recoveryTask);
    observationLoginStateVersion = 3;
    const rotatedTask = { ...recoveryTask, observationLoginStateVersion: 3 };
    assert.deepEqual((await post(paths.claim, claim)).task, rotatedTask,
      "HTTP claim preserves current observation login without replacing the frozen login");
    humanClaim = false;
    for (const state of ["executing", "succeeded", "failed", "queued", "risk_paused",
      "reconciliation_required"] as const) {
      completionState = state; await post(paths.complete, complete);
    }
    const recovered = await post(paths.reconcile, reconcile);
    assert.deepEqual(recovered.task, recoveryTask);
    recovery = { kind: "reconcile", task: rotatedTask, taskToken: token, replayed: false };
    assert.deepEqual((await post(paths.reconcile, reconcile)).task, rotatedTask);
    for (const value of [{ kind: "waiting", retryAfterMs: 3000, replayed: false },
      { kind: "released", actionId: task.actionId, taskRequestHash: hash,
        originalLeaseVersion: 4, replayed: false },
      { kind: "terminal", status: "succeeded", receiptHash: hash, replayed: true },
      { kind: "not_authorized", replayed: false }] as const) {
      recovery = value; await post(paths.reconcile, reconcile);
    }
    await post(paths.claim, claim, 409, "b".repeat(64));
    await post(paths.complete, { ...complete, command: {} }, 400);
    admission = createDesktopClientAdmissionMiddleware({ mode: "migration_locked" });
    await post(paths.claim, claim, 503);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("production parser 400 and 413 responses conform on all six desktop mutations", async () => {
  process.env.NODE_ENV = "test";
  const previousLimit = process.env.JSON_BODY_LIMIT;
  process.env.JSON_BODY_LIMIT = "1kb";
  let serverModule: typeof import("./server.js");
  try { serverModule = await import("./server.js"); }
  finally {
    if (previousLimit === undefined) delete process.env.JSON_BODY_LIMIT;
    else process.env.JSON_BODY_LIMIT = previousLimit;
  }
  let downstreamCalls = 0;
  const uninstall = serverModule.installTestAcquisitionHttpRuntime({
    admissionConfiguration: { mode: "exact", admittedBuildManifestSha256: hash },
    workspaceMiddleware: (_request, _response, next) => { downstreamCalls++; next(); },
    runtime: { handler: (_request, response) => { downstreamCalls++; response.status(204).end(); },
      async close() {} }
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const running = serverModule.app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const source = await published;
  try {
    for (const path of Object.values(paths)) {
      for (const [body, status, message] of [
        ["{", 400, "JSON 格式不正确"],
        [JSON.stringify({ value: "x".repeat(2048) }), 413, "请求内容过大"]
      ] as const) {
        const response: globalThis.Response = await fetch(`http://127.0.0.1:${address.port}${path
          .replace("{accountId}", account.accountId).replace("{actionId}", task.actionId)}`, {
          method: "POST", headers: { "content-type": "application/json",
            "X-Shensi-Desktop-Build-Manifest-SHA256": hash,
            "X-Request-Id": "desktop-parser-contract" }, body
        });
        assert.equal(response.status, status, path);
        const actual = await response.json();
        assert.deepEqual(actual, status === 400 ? { code: "invalid_json", message,
          details: null, requestId: "desktop-parser-contract", retryable: false } : { message });
        for (const document of [runtime, source]) {
          const schema = (document[path]!.post! as any).responses[String(status)]
            .content["application/json"].schema;
          assertValid(schema, actual);
          assert.equal(validate(schema, { ...actual, rawBody: "private" }).valid, false);
          assert.equal(validate(schema, { message: "arbitrary exception" }).valid, false);
        }
      }
    }
    assert.equal(downstreamCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await uninstall();
  }
});
