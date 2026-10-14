import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import express from "express";
import { createGrowthCommercialCompositionForStore } from "./growth-commercial-composition.js";
import { createDouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import { createAcquisitionSocialAccountRouter } from "./acquisition-social-account-router.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { createAcquisitionDesktopOutreachSyncRouter } from
  "./acquisition-desktop-outreach-sync-router.js";
import { getStore } from "./store.js";

const JWT_SECRET = "social-account-router-test-secret-at-least-32-characters";

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

function cookie(cookiesHeader: string, name: string) {
  return cookiesHeader.split("; ").find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

test("production HTTP composition requires login and CSRF and resolves the authenticated workspace", async () => {
  const trustedOrigin = "https://desktop.shensi.test";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = trustedOrigin;
  const { app, installTestAcquisitionHttpRuntime,
    resolveDesktopClientAdmissionConfiguration } = await import("./server.js");
  type InstallerInput = import("./server.js").InstallAcquisitionHttpRuntimeInput;
  const store = getStore();
  const addedUsers = [{ id: "social-user-a", name: "Social A", email: "social-a@example.test", password: "social-password", role: "admin", teamId: "social-workspace-a", avatar: "SA", status: "active", authVersion: 1 },
    { id: "social-user-b", name: "Social B", email: "social-b@example.test", password: "social-password", role: "admin", teamId: "social-workspace-b", avatar: "SB", status: "active", authVersion: 1 }] as const;
  store.users.push(...addedUsers as never);
  const production = createGrowthCommercialCompositionForStore({ store });
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  let createCalls = 0;
  let loginActive = false;
  const service = new AcquisitionSocialAccountService({ repository, gateway: {
    async createLoginSession() { createCalls += 1; return { sessionId: "upstream", state: "awaiting_scan" as const, qrImageDataUrl: "data:image/png;base64,cXI=", qrStatus: "ready" as const, loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async getLoginSession() { return loginActive
      ? { sessionId: "upstream", state: "active" as const, qrImageDataUrl: null, qrStatus: null, loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: `dyacct_${"a".repeat(64)}`, accountDisplayName: "Douyin", loginStateVersion: 1 }
      : { sessionId: "upstream", state: "awaiting_scan" as const, qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async interactLoginSession(sessionId) { return { sessionId, state: "awaiting_scan" as const, qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async disconnectLoginSession() {}
  }, idFactory: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z", pendingPollMs: 1 });
  const acquisition = express.Router();
  acquisition.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({ service, requestIdFactory: () => "request" }));
  const admissionDigest = "a".repeat(64);
  const installerInput = {
    workspaceMiddleware: production.workspaceMiddleware,
    runtime: { handler: acquisition, async close() {} },
    admissionConfiguration: resolveDesktopClientAdmissionConfiguration({
      SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
      SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: admissionDigest
    })
  } satisfies InstallerInput;
  const uninstall = installTestAcquisitionHttpRuntime(installerInput);
  const server = await new Promise<import("node:http").Server>((resolve) => { const value = app.listen(0, () => resolve(value)); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { "content-type": "application/json", "x-shensi-desktop-build-manifest-sha256": admissionDigest, ...init.headers } });
  const login = async (email: string) => {
    const response = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "social-password" }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { csrfToken: string };
    const sessionCookies = cookies(response);
    assert.equal(cookie(sessionCookies, "gj_csrf"), body.csrfToken);
    return { cookies: sessionCookies, csrf: body.csrfToken };
  };
  try {
    const path = "/api/v1/acquisition/social-accounts/douyin/login-sessions";
    const anonymous = await request(path, { method: "POST", headers: { "Idempotency-Key": "anonymous" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(anonymous.status, 401);

    const userA = await login("social-a@example.test");
    const trustedWrite = await request(path, { method: "POST", headers: { cookie: userA.cookies, "x-csrf-token": userA.csrf, Origin: trustedOrigin, "Idempotency-Key": "trusted-origin" }, body: JSON.stringify({ platform: "invalid" }) });
    assert.equal(trustedWrite.status, 400,
      "a trusted Origin plus cookie CSRF must reach request validation without creating a login session");
    const missingCsrf = await request(path, { method: "POST", headers: { cookie: userA.cookies, "Idempotency-Key": "missing-csrf" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(missingCsrf.status, 403);
    const invalidCsrf = await request(path, { method: "POST", headers: { cookie: userA.cookies, "x-csrf-token": "invalid", "Idempotency-Key": "invalid-csrf" }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(invalidCsrf.status, 403);

    const mutationHeaders = { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "create-key" };
    const first = await request(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ platform: "douyin" }) });
    const replay = await request(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ platform: "douyin" }) });
    const firstBody = await first.json() as {
      id: string;
      state: string;
      loginPage: unknown;
      account: unknown;
    };
    assert.equal(first.status, 201);
    assert.equal(firstBody.state, "awaiting_scan");
    assert.equal(firstBody.loginPage, null,
      "the public POST must return the sidecar placeholder instead of treating a null page as failure");
    assert.equal(firstBody.account, null);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replay.json(), firstBody);

    const refreshed = await request(path, { method: "POST", headers: {
      ...mutationHeaders, "Idempotency-Key": "refreshed-browser-key"
    }, body: JSON.stringify({ platform: "douyin" }) });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers.get("idempotency-replayed"), "true");
    assert.equal((await refreshed.json() as { id: string }).id, firstBody.id);
    assert.equal(createCalls, 1);

    loginActive = true;
    const bound = await service.bindActiveSession({ workspaceId: "social-workspace-a" }, firstBody.id);
    const userB = await login("social-b@example.test");
    const foreign = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: { cookie: userB.cookies, "x-csrf-token": userB.csrf, "Idempotency-Key": "foreign-delete", "If-Match": bound.etag, "x-workspace": "social-workspace-a" } });
    assert.equal(foreign.status, 404);

    const stale = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "stale-delete", "If-Match": '"account-v999"' } });
    assert.equal(stale.status, 412);
    const deleteHeaders = { cookie: userA.cookies, "x-csrf-token": userA.csrf, "Idempotency-Key": "delete-key", "If-Match": bound.etag };
    const deleted = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: deleteHeaders });
    const deletedReplay = await request(`/api/v1/acquisition/social-accounts/${bound.id}`, { method: "DELETE", headers: deleteHeaders });
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200);
    assert.equal(deletedReplay.status, 200);
    assert.equal(deletedReplay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await deletedReplay.json(), deletedBody);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await uninstall();
    for (const user of addedUsers) {
      const index = store.users.findIndex((candidate) => candidate.id === user.id);
      if (index >= 0) store.users.splice(index, 1);
    }
  }
});

test("desktop-only mutations bypass browser auth only at exact paths and still reach device checks", async () => {
  process.env.NODE_ENV = "test";
  const { app, installTestAcquisitionHttpRuntime,
    resolveDesktopClientAdmissionConfiguration } = await import("./server.js");
  const digest = "b".repeat(64);
  const token = "t".repeat(43);
  let registerChecks = 0;
  let deviceChecks = 0;
  const installationService = {
    async createEnrollment() { throw new Error("unexpected_enrollment"); },
    async register() {
      registerChecks += 1;
      return { deviceToken: token, workspaceId: "workspace-device", protocolVersion: 1 as const,
        replayed: false };
    },
    async authenticateDevice() {
      deviceChecks += 1;
      return null;
    },
    async bindDesktopExecutor() { throw new Error("unexpected_binding"); }
  };
  const desktop = createAcquisitionDesktopOutreachSyncRouter({
    installationService,
    desktopExecutionEnabled: true,
    outreachSync: {
      async claim() { throw new Error("unexpected_claim"); },
      async complete() { throw new Error("unexpected_complete"); },
      async reconcile() { throw new Error("unexpected_reconcile"); }
    }
  });
  const runtimeRouter = express.Router();
  runtimeRouter.use(express.json());
  runtimeRouter.use("/api/v1/acquisition", desktop);
  const uninstall = installTestAcquisitionHttpRuntime({
    workspaceMiddleware: (_request, _response, next) => next(),
    runtime: { handler: runtimeRouter, async close() {} },
    admissionConfiguration: resolveDesktopClientAdmissionConfiguration({
      SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
      SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: digest
    })
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = (path: string, body: unknown, key: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-shensi-desktop-build-manifest-sha256": digest,
      "Idempotency-Key": key,
      "X-Shensi-Desktop-Installation-Id": token,
      "X-Shensi-Desktop-Device-Token": token
    }, body: JSON.stringify(body)
  });
  try {
    const register = await request("/api/v1/acquisition/desktop-installations/register",
      { protocolVersion: 1, installationId: token, enrollmentToken: token }, "register-key");
    assert.equal(register.status, 201);
    const claim = await request("/api/v1/acquisition/desktop-outreach-actions/claim",
      { protocolVersion: 1, processInstanceId: token, waitSeconds: 0,
        availableAccounts: [{ accountId: "a", accountHandle: `dyacct_${"a".repeat(64)}`,
          loginStateVersion: 1, bindingGeneration: 1 }] }, "claim-key");
    const complete = await request("/api/v1/acquisition/desktop-outreach-actions/action/complete",
      { protocolVersion: 1, processInstanceId: token, bindingGeneration: 1,
        command: { event: "started", leaseVersion: 1, loginStateVersion: 1,
          taskRequestHash: "a".repeat(64), occurredAt: "2026-09-05T00:00:00.000Z" } }, "complete-key");
    const reconcile = await request("/api/v1/acquisition/desktop-outreach-actions/action/reconcile",
      { protocolVersion: 1, processInstanceId: token, accountId: "a",
        accountHandle: `dyacct_${"a".repeat(64)}`, loginStateVersion: 1,
        bindingGeneration: 1, originalLeaseVersion: 1, taskRequestHash: "a".repeat(64),
        journalPhase: "claimed" }, "reconcile-key");
    assert.equal(claim.status, 401);
    assert.equal(complete.status, 401);
    assert.equal(reconcile.status, 401);
    assert.equal(registerChecks, 1);
    assert.equal(deviceChecks, 3);

    for (const [path, body] of [
      ["/api/v1/acquisition/desktop-installations/enrollments",
        { protocolVersion: 1, installationId: token }],
      ["/api/v1/acquisition/social-accounts/account/desktop-binding",
        { installationId: token, accountHandle: `dyacct_${"a".repeat(64)}`,
          loginStateVersion: 1, expectedBindingGeneration: 0, handoff: false }],
      ["/api/v1/acquisition/social-accounts/douyin/login-sessions",
        { platform: "douyin" }],
      ["/api/v1/acquisition/desktop-outreach-actions/claim/extra",
        { protocolVersion: 1 }],
      ["/api/v1/acquisition/desktop-outreach-actions/%63laim",
        { protocolVersion: 1 }]
    ] as const) {
      const response = await request(path, body, `ordinary-${path}`);
      assert.equal(response.status, 401, `browser auth must remain for ${path}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await uninstall();
  }
});

test("production acquisition admission rejects every mutation before malformed JSON and downstream authority", async () => {
  process.env.NODE_ENV = "test";
  const { app, installTestAcquisitionHttpRuntime } = await import("./server.js");
  const digest = "c".repeat(64);
  const paths = [
    "/api/v1/acquisition/social-accounts/douyin/login-sessions",
    "/api/v1/acquisition/desktop-installations/enrollments",
    "/api/v1/acquisition/desktop-installations/register",
    "/api/v1/acquisition/social-accounts/account/desktop-binding",
    "/api/v1/acquisition/desktop-outreach-actions/claim",
    "/api/v1/acquisition/desktop-outreach-actions/action/complete",
    "/api/v1/acquisition/desktop-outreach-actions/action/reconcile"
  ];
  let workspaceCalls = 0;
  let runtimeCalls = 0;
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const malformedRequest = (path: string, suppliedDigests: string[]) =>
    new Promise<{ status: number; body: { error?: string; message?: string } }>((resolve, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1", port: address.port, path, method: "POST",
        headers: ["Host", `127.0.0.1:${address.port}`, "Content-Type", "application/json", "Content-Length", "1",
          ...suppliedDigests.flatMap((value) =>
            ["X-Shensi-Desktop-Build-Manifest-SHA256", value])]
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); }
          catch { reject(new Error(`unexpected HTTP ${response.statusCode} response: ${body}`)); }
        });
      });
      request.on("error", reject);
      request.end("{");
    });
  try {
    for (const mode of ["migration_locked", "exact"] as const) {
      const uninstall = installTestAcquisitionHttpRuntime({
        workspaceMiddleware: (_req, _res, next) => { workspaceCalls += 1; next(); },
        runtime: {
          handler: (_req, res) => { runtimeCalls += 1; res.status(204).end(); },
          async close() {}
        },
        admissionConfiguration: mode === "migration_locked" ? { mode }
          : { mode, admittedBuildManifestSha256: digest }
      });
      try {
        const rejectedHeaders = mode === "migration_locked" ? [[digest]]
          : [[], [digest.toUpperCase()], ["invalid"], ["d".repeat(64)], [digest, digest]];
        for (const path of paths) {
          for (const headers of rejectedHeaders) {
            const response = await malformedRequest(path, headers);
            assert.equal(response.status, mode === "migration_locked" ? 503 : 409, path);
            assert.deepEqual(response.body, { error: mode === "migration_locked"
              ? "desktop_client_migration_locked" : "desktop_client_build_not_admitted" });
            assert.equal(workspaceCalls, 0);
            assert.equal(runtimeCalls, 0);
          }
          if (mode === "exact") {
            const accepted = await malformedRequest(path, [digest]);
            assert.equal(accepted.status, 400, `admitted ${path} must reach the JSON parser`);
            assert.equal(accepted.body.message, "JSON 格式不正确");
            assert.equal(workspaceCalls, 0);
            assert.equal(runtimeCalls, 0);
          }
        }
      } finally { await uninstall(); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("login creation exposes MediaCrawler unavailability as a retryable 503", async () => {
  const gateway = createDouyinMediaCrawlerGateway({
    baseUrl: "http://127.0.0.1:8899",
    serviceSecret: "router-gateway-test-secret-at-least-32-characters",
    fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(),
    gateway,
    idFactory: () => "unused-login-session-id",
    now: () => "2026-08-31T14:43:13.000Z",
    pendingPollMs: 1
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "social-workspace-gateway-error",
      actorId: "social-user-gateway-error",
      teamId: "social-workspace-gateway-error"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service,
    requestIdFactory: () => "request-gateway-error"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "gateway-unavailable-login"
        },
        body: JSON.stringify({ platform: "douyin" })
      }
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "mediacrawler_unavailable",
      message: "mediacrawler_unavailable",
      details: null,
      requestId: "request-gateway-error",
      retryable: true
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("an upstream login cleanup is exposed as session expiry instead of downtime", async () => {
  let requestCount = 0;
  const gateway = createDouyinMediaCrawlerGateway({
    baseUrl: "http://127.0.0.1:8899",
    serviceSecret: "router-expired-login-test-secret-at-least-32-characters",
    fetchImpl: (async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          session_id: "expired-upstream",
          state: "awaiting_scan",
          qr_image_data_url: null,
          qr_status: "opening",
          login_page: null,
          failure_code: null,
          expires_at: "2026-09-01T00:05:00.000Z",
          account_handle: null,
          account_display_name: null,
          login_state_version: null,
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ detail: "login_session_not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "expired-public-session",
    now: () => "2026-09-01T00:00:00.000Z"
  });
  const login = await service.createLoginSession(
    { workspaceId: "expired-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "expired-workspace", actorId: "expired-user",
      teamId: "expired-workspace"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service, requestIdFactory: () => "expired-request"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}`
    );
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      code: "douyin_login_session_expired",
      message: "douyin_login_session_expired",
      details: null,
      requestId: "expired-request",
      retryable: false
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("login interaction route validates and forwards one workspace-bound event", async () => {
  const interactions: unknown[] = [];
  let now = "2026-09-01T00:00:00.000Z";
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway: {
      async createLoginSession() {
        return { sessionId: "private-upstream", state: "awaiting_scan" as const,
          qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: {
            imageDataUrl: "data:image/png;base64,bG9naW4=", width: 1280, height: 720
          }, expiresAt: "2026-09-01T00:05:00.000Z", accountHandle: null,
          accountDisplayName: null, loginStateVersion: null };
      },
      async getLoginSession() { throw new Error("unexpected poll"); },
      async interactLoginSession(sessionId, interaction) {
        interactions.push({ sessionId, interaction });
        return { sessionId, state: "awaiting_scan" as const, qrImageDataUrl: null,
          qrStatus: "opening" as const,
          loginPage: {
            imageDataUrl: "data:image/png;base64,dXBkYXRlZA==", width: 1280, height: 720
          }, expiresAt: "2026-09-01T00:05:00.000Z", accountHandle: null,
          accountDisplayName: null, loginStateVersion: null };
      }
    },
    idFactory: () => "public-login", now: () => now
  });
  const login = await service.createLoginSession(
    { workspaceId: "interaction-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "interaction-workspace",
      actorId: "interaction-user",
      teamId: "interaction-workspace"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service, requestIdFactory: () => "interaction-request"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/interactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "text", text: "13800138000" })
      }
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { id: string; loginPage: { width: number } };
    assert.equal(body.id, login.id);
    assert.equal(body.loginPage.width, 1280);
    assert.deepEqual(interactions, [{
      sessionId: "private-upstream",
      interaction: { type: "text", text: "13800138000" }
    }]);
    const refreshResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/interactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "refresh_qr" })
      }
    );
    assert.equal(refreshResponse.status, 200);
    assert.deepEqual(interactions[1], {
      sessionId: "private-upstream",
      interaction: { type: "refresh_qr" }
    });
    for (const invalid of [
      { type: "click", normalizedX: -0.01, normalizedY: 0.5 },
      { type: "text", text: "" },
      { type: "text", text: "x".repeat(201) },
      { type: "key", key: "Space" },
      { type: "scroll", deltaX: 0, deltaY: 1.01 },
      { type: "key", key: "Enter", extra: true }
    ]) {
      const invalidResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/interactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(invalid)
        }
      );
      assert.equal(invalidResponse.status, 400);
      assert.deepEqual(await invalidResponse.json(), {
        code: "invalid_request", message: "invalid_request", details: null,
        requestId: "interaction-request", retryable: false
      });
    }
    assert.equal(interactions.length, 2);
    now = "2026-09-01T00:05:00.000Z";
    const expiredResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/interactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "key", key: "Enter" })
      }
    );
    assert.equal(expiredResponse.status, 410);
    assert.deepEqual(await expiredResponse.json(), {
      code: "douyin_login_session_expired",
      message: "douyin_login_session_expired",
      details: null,
      requestId: "interaction-request",
      retryable: false
    });
    assert.equal(interactions.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("login session DELETE cancels the workspace-bound upstream session", async () => {
  const disconnected: string[] = [];
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway: {
      async createLoginSession() {
        return { sessionId: "private-cancel-upstream", state: "awaiting_scan" as const,
          qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
          expiresAt: "2026-09-01T00:05:00.000Z", accountHandle: null,
          accountDisplayName: null, loginStateVersion: null };
      },
      async getLoginSession() { throw new Error("unexpected poll"); },
      async interactLoginSession() { throw new Error("unexpected interaction"); },
      async disconnectLoginSession(sessionId) { disconnected.push(sessionId); }
    },
    idFactory: () => "public-cancel-session",
    now: () => "2026-09-01T00:00:00.000Z"
  });
  const login = await service.createLoginSession(
    { workspaceId: "cancel-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "cancel-workspace", actorId: "cancel-user",
      teamId: "cancel-workspace"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service, requestIdFactory: () => "cancel-request"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const path = `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}`;
    const response = await fetch(path, { method: "DELETE" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.deepEqual(disconnected, ["private-cancel-upstream"]);

    const replay = await fetch(path, { method: "DELETE" });
    assert.equal(replay.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("live login route returns the workspace-bound same-origin websocket path", async () => {
  const upstreamSessions: string[] = [];
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  const service = new AcquisitionSocialAccountService({
    repository,
    gateway: {
      async createLoginSession() {
        return { sessionId: "private-live-upstream", state: "awaiting_scan" as const,
          qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
          interactionSurface: "remote_canvas" as const,
          runtimeState: "running" as const,
          authState: "waiting_for_user" as const,
          taskState: "idle" as const,
          diagnostic: null,
          screenshotAvailable: true,
          qrAvailable: false,
          expiresAt: "2026-09-01T00:05:00.000Z", accountHandle: null,
          accountDisplayName: null, loginStateVersion: null };
      },
      async createLiveLoginSession(sessionId) {
        upstreamSessions.push(sessionId);
        return { token: "b".repeat(64), expiresAt: "2026-09-01T00:00:30.000Z" };
      },
      async getLoginSession() { throw new Error("unexpected poll"); },
      async interactLoginSession() { throw new Error("unexpected interaction"); }
    },
    idFactory: () => "public-live-session",
    now: () => "2026-09-01T00:00:00.000Z"
  });
  const login = await service.createLoginSession(
    { workspaceId: "live-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "live-workspace", actorId: "live-user", teamId: "live-workspace"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service, requestIdFactory: () => "live-request"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/live`,
      { method: "POST" }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      socketPath: `/douyin-live/${"b".repeat(64)}`,
      expiresAt: "2026-09-01T00:00:30.000Z"
    });
    assert.deepEqual(upstreamSessions, ["private-live-upstream"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("live login route rejects an external-window session before calling MediaCrawler", async () => {
  const liveCalls: string[] = [];
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(),
    gateway: {
      async createLoginSession() {
        return { sessionId: "private-external-upstream",
          state: "awaiting_scan" as const, qrImageDataUrl: null,
          qrStatus: null, loginPage: null,
          interactionSurface: "external_window" as const,
          runtimeState: "running" as const,
          authState: "waiting_for_user" as const,
          taskState: "idle" as const, diagnostic: null,
          screenshotAvailable: false, qrAvailable: false,
          expiresAt: "2026-09-01T00:05:00.000Z", accountHandle: null,
          accountDisplayName: null, loginStateVersion: null };
      },
      async createLiveLoginSession(sessionId) {
        liveCalls.push(sessionId);
        return { token: "c".repeat(64),
          expiresAt: "2026-09-01T00:00:30.000Z" };
      },
      async getLoginSession() { throw new Error("unexpected poll"); },
      async interactLoginSession() { throw new Error("unexpected interaction"); }
    },
    idFactory: () => "public-external-session",
    now: () => "2026-09-01T00:00:00.000Z"
  });
  const login = await service.createLoginSession(
    { workspaceId: "external-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "external-workspace", actorId: "external-user",
      teamId: "external-workspace"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service, requestIdFactory: () => "external-request"
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/live`,
      { method: "POST" }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: "douyin_live_login_unavailable",
      message: "douyin_live_login_unavailable",
      details: null,
      requestId: "external-request",
      retryable: false
    });
    assert.deepEqual(liveCalls, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("live login route preserves a retryable context-not-ready conflict", async () => {
  const gateway = createDouyinMediaCrawlerGateway({
    baseUrl: "http://127.0.0.1:8899",
    serviceSecret: "router-live-login-test-secret-at-least-32-characters",
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/live-sessions")) {
        return new Response(JSON.stringify({
          detail: "douyin_login_session_not_interactive",
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        session_id: "starting-upstream",
        state: "awaiting_scan",
        qr_image_data_url: null,
        qr_status: "opening",
        login_page: null,
        failure_code: null,
        expires_at: "2026-09-01T00:05:00.000Z",
        account_handle: null,
        account_display_name: null,
        login_state_version: null,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const service = new AcquisitionSocialAccountService({
    repository: new InMemoryAcquisitionSocialAccountRepository(),
    gateway,
    idFactory: () => "starting-public-session",
    now: () => "2026-09-01T00:00:00.000Z",
  });
  const login = await service.createLoginSession(
    { workspaceId: "starting-workspace" }, { platform: "douyin" }
  );
  const app = express();
  app.use((req, _res, next) => {
    req.activeWorkspace = {
      workspaceId: "starting-workspace",
      actorId: "starting-user",
      teamId: "starting-workspace",
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionSocialAccountRouter({
    service,
    requestIdFactory: () => "starting-request",
  }));
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/social-accounts/douyin/login-sessions/${login.id}/live`,
      { method: "POST" }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: "douyin_login_session_not_ready",
      message: "douyin_login_session_not_ready",
      details: null,
      requestId: "starting-request",
      retryable: true,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});
