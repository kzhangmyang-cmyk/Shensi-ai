import assert from "node:assert/strict";
import express from "express";
import test from "node:test";
import {
  createAcquisitionDesktopSyncRouter
} from "./acquisition-desktop-sync-router.js";

function fixture() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("X-Test-Auth") === "yes") {
      req.user = { id: "owner-a", username: "owner-a", name: "Owner",
        role: "admin", teamId: "team-a", avatarUrl: null, isActive: true,
        createdAt: "2026-09-03T00:00:00.000Z" };
    }
    if (req.header("X-Test-Workspace") === "yes") {
      req.activeWorkspace = {
        workspaceId: "workspace-a", actorId: "owner-a", teamId: "team-a"
      };
    }
    next();
  });
  const socialAccounts = {
    async completeDesktopLogin(...args: unknown[]) {
      calls.push({ name: "login", args });
      return { view: { id: "account-1", workspaceId: "workspace-a",
        platform: "douyin", displayName: "Douyin", state: "active",
        loginStateVersion: 7, revision: 1, etag: '"account-v1"',
        lastValidatedAt: "2026-09-03T00:00:00.000Z",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z" },
      status: 200, headers: {}, replayed: false };
    }
  };
  const desktopSync = {
    async prepareRun(...args: unknown[]) {
      calls.push({ name: "prepare", args });
      return { run: { id: "run-1" }, taskToken: "opaque-capability",
        task: { taskId: "job-1" } };
    },
    async claim(...args: unknown[]) {
      calls.push({ name: "claim", args });
      return { jobId: "job-1", state: "running", leaseVersion: 1 };
    },
    async renew(...args: unknown[]) { calls.push({ name: "renew", args }); return {}; },
    async uploadPage(...args: unknown[]) { calls.push({ name: "page", args }); return {}; },
    async complete(...args: unknown[]) { calls.push({ name: "complete", args }); return {}; },
    async cancel(...args: unknown[]) { calls.push({ name: "cancel", args }); return {}; }
  };
  app.use("/api/v1/acquisition", createAcquisitionDesktopSyncRouter({
    socialAccounts: socialAccounts as never,
    desktopSync: desktopSync as never,
    requestIdFactory: () => "desktop-request-1"
  }));
  return { app, calls };
}

async function request(app: express.Express, path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    server.close();
  }
}

const authHeaders = {
  "Content-Type": "application/json",
  "X-Test-Auth": "yes",
  "X-Test-Workspace": "yes"
};

test("desktop routes require authenticated active workspace and bounded identity", async () => {
  const { app, calls } = fixture();
  const body = JSON.stringify({
    accountHandle: `dyacct_${"a".repeat(64)}`,
    displayName: "Douyin",
    loginStateVersion: 7
  });
  assert.equal((await request(app,
    "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
    { method: "POST", headers: { "Content-Type": "application/json",
      "Idempotency-Key": "desktop-login-key" }, body })).status, 401);
  assert.equal((await request(app,
    "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
    { method: "POST", headers: { ...authHeaders,
      "X-Test-Workspace": "no", "Idempotency-Key": "desktop-login-key" }, body })).status, 400);
  const unknown = await request(app,
    "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
    { method: "POST", headers: { ...authHeaders,
      "Idempotency-Key": "desktop-login-key" },
    body: JSON.stringify({ ...JSON.parse(body), profilePath: "/tmp/profile" }) });
  assert.equal(unknown.status, 400);
  const accepted = await request(app,
    "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
    { method: "POST", headers: { ...authHeaders,
      "Idempotency-Key": "desktop-login-key" }, body });
  assert.equal(accepted.status, 200);
  assert.equal(calls.filter((call) => call.name === "login").length, 1);
  assert.equal((await accepted.text()).includes(`dyacct_${"a".repeat(64)}`), false);
});

test("desktop login completion uses the canonical 64-hex social-account replay digest", async () => {
  const { app, calls } = fixture();
  const path = "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions";
  for (const input of [
    { accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "Douyin", loginStateVersion: 7 },
    { loginStateVersion: 7, displayName: "  Douyin  ", accountHandle: `dyacct_${"a".repeat(64)}` }
  ]) {
    const response = await request(app, path, {
      method: "POST", headers: { ...authHeaders, "Idempotency-Key": "same-login" },
      body: JSON.stringify(input)
    });
    assert.equal(response.status, 200);
  }
  // Fixed canonical JSON fixture, independent of the production hash helper.
  // A sha256: prefix is valid for crawler hashes, but is truncated by the
  // social-account CHAR(64) ledger and prevents completion of its replay.
  assert.deepEqual(calls.map((call) => call.args[3]), [
    "26284d68d063c072c8758a5290258da3f8fbdda74ca13fc69f98acd86e4b4470",
    "26284d68d063c072c8758a5290258da3f8fbdda74ca13fc69f98acd86e4b4470"
  ]);
});

test("desktop task capabilities stay in headers and page schemas reject unknown fields", async () => {
  const { app, calls } = fixture();
  const taskToken = "opaque-capability-that-is-long-enough-1234";
  const missingToken = await request(app,
    "/api/v1/acquisition/desktop-crawler-jobs/job-1/claim",
    { method: "POST", headers: authHeaders, body: "{}" });
  assert.equal(missingToken.status, 400);
  const claim = await request(app,
    "/api/v1/acquisition/desktop-crawler-jobs/job-1/claim",
    { method: "POST", headers: {
      ...authHeaders, "X-Shensi-Desktop-Task-Token": taskToken
    }, body: "{}" });
  assert.equal(claim.status, 200);
  assert.equal(calls.some((call) => JSON.stringify(call.args)
    .includes(taskToken)), true);

  const invalidPage = await request(app,
    "/api/v1/acquisition/desktop-crawler-jobs/job-1/pages",
    { method: "PUT", headers: {
      ...authHeaders,
      "X-Shensi-Desktop-Task-Token": taskToken,
      "Idempotency-Key": "desktop-page-key"
    }, body: JSON.stringify({ leaseVersion: 1, cursor: null, nextCursor: "p2",
      done: false, records: [], executable: "chromium" }) });
  assert.equal(invalidPage.status, 400);
  assert.equal(calls.filter((call) => call.name === "page").length, 0);
});
