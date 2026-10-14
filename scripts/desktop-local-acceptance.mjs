// Backend-only acceptance on the fixed fresh-local runtime. No browser or
// platform sends. Run seed once, restart desktop:local, then run verify.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverComposeRuntime } from "./container-runtime.mjs";
import { prepareDesktopLocalRuntime } from "./desktop-local-runtime.mjs";
import { prepareDevelopmentBuildIdentity } from "../desktop/scripts/prepare-dev-build-identity.mjs";
import { DesktopCentralApiClient } from "../desktop/src/main/desktop-central-api-client.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["seed", "verify", "enrollment"].includes(mode)) throw new Error("DESKTOP_LOCAL_ACCEPTANCE_COMMAND_INVALID");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await discoverComposeRuntime();
const config = await prepareDesktopLocalRuntime(root, runtime.daemon.identity);
const origin = `http://127.0.0.1:${config.backendPort}`;
const manifest = await prepareDevelopmentBuildIdentity(root);
const digest = createHash("sha256").update(await readFile(manifest)).digest("hex");
async function api(path, { method = "GET", body, token, idempotencyKey, expected = 200 } = {}) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", Origin: origin,
      "X-Shensi-Desktop-Build-Manifest-SHA256": digest, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, expected, `${method} ${path} status=${response.status}`);
  return response.json();
}
assert.equal((await api("/api/health")).store, "mysql");
const users = [];
for (const suffix of ["a", "b"]) {
  const account = `local_check_${config.owner.slice(0, 8)}_${suffix}`;
  // Separate test credentials stay out of stdout and argv; no old accounts.
  const password = createHmac("sha256", config.secrets.JWT_SECRET).update(`acceptance:${suffix}`).digest("base64url");
  if (mode === "seed") await api("/api/auth/register", { method: "POST", body: { account, password }, expected: 201 });
  users.push(await api("/api/auth/login", { method: "POST", body: { email: account, password } }));
}
assert.notEqual(users[0].user.teamId, users[1].user.teamId);
const company = `本地数据库验收-${config.owner.slice(0, 8)}`;
if (mode === "seed") {
  for (const user of users) assert.equal((await api("/api/customers?scope=mine", { token: user.token })).customers.length, 0);
  await api("/api/customers", { method: "POST", token: users[0].token, body: { company, country: "中国", contact: "验收数据" } });
}
const own = (await api("/api/customers?scope=mine", { token: users[0].token })).customers;
assert.equal(own.length, 1);
assert.equal(own[0].company, company);
for (const scope of ["mine", "team", "public"]) {
  const other = await api(`/api/customers?scope=${scope}`, { token: users[1].token });
  assert.equal(other.customers.some((item) => item.id === own[0].id), false);
}
if (mode === "seed") await api(`/api/customers/${own[0].id}`, { method: "PATCH", token: users[1].token,
  body: { company: "must-not-change" }, expected: 404 });
assert.equal((await api("/api/customers?scope=mine", { token: users[0].token })).customers[0].company, company);
if (mode === "enrollment") {
  // Exercise the real HTTP issuance and Main client against the host Backend
  // (including its local timezone), not the UTC-only disposable test runner.
  // This stable acceptance device is never saved into Electron's credentials.
  const installationId = createHmac("sha256", config.secrets.JWT_SECRET)
    .update("acceptance:desktop-installation").digest("base64url");
  const enrollment = await api("/api/v1/acquisition/desktop-installations/enrollments", {
    method: "POST", token: users[0].token, expected: 201, idempotencyKey: crypto.randomUUID(),
    body: { installationId, protocolVersion: 1 }
  });
  assert.ok(Date.parse(enrollment.expiresAt) > Date.now());
  const registered = await new DesktopCentralApiClient({ origin, buildManifestSha256: digest })
    .register({ installationId, protocolVersion: 1, enrollmentToken: enrollment.enrollmentToken },
      { expectedWorkspaceId: users[0].user.teamId, idempotencyKey: crypto.randomUUID() });
  assert.equal(registered.workspaceId, users[0].user.teamId);
  assert.equal(registered.protocolVersion, 1);
}
console.log(JSON.stringify({ suite: "desktop-local-api-acceptance", mode, passed: true,
  registration: mode === "seed", login: true, customerPersisted: true, workspaceIsolation: true,
  desktopEnrollment: mode === "enrollment",
  uiTested: false, realPlatformSend: false }));
