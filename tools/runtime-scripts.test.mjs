import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  requiredLocalVariables,
  assertPortAvailable,
  validatePorts,
  validateRequiredVariables
} from "../scripts/dev.mjs";
import {
  assertDockerAvailable,
  assertOwnerOnlyMode,
  requiredProductionVariables,
  validateProductionVariables,
  validateProductionSecrets
} from "../scripts/deploy.mjs";

test("local runtime requires real MySQL and security keys", () => {
  assert.deepEqual(requiredLocalVariables, [
    "DATABASE_URL", "JWT_SECRET", "PROVIDER_CREDENTIAL_KEY",
    "AGENT_JOB_ENCRYPTION_KEY", "ACQUISITION_MASTER_SECRET",
    "MEDIACRAWLER_SERVICE_SECRET_FILE", "MEDIACRAWLER_ENCRYPTED_VOLUME"
  ]);
});

test("ports must be distinct and valid", () => {
  assert.throws(() => validatePorts({ backend: 5191, frontend: 5191 }), /PORT_CONFLICT/u);
  assert.doesNotThrow(() => validatePorts({ backend: 4191, frontend: 5191 }));
});

test("an occupied local port fails before runtime processes can start", async () => {
  const server = createServer();
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  try {
    const address = server.address();
    assert.notEqual(typeof address, "string");
    await assert.rejects(assertPortAvailable(address.port), /PORT_UNAVAILABLE/u);
  } finally {
    await new Promise((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer()));
  }
});

test("local validation names missing variables without exposing values", () => {
  assert.throws(
    () => validateRequiredVariables({ DATABASE_URL: "mysql://present" }),
    /LOCAL_ENVIRONMENT_MISSING:JWT_SECRET,PROVIDER_CREDENTIAL_KEY,AGENT_JOB_ENCRYPTION_KEY,ACQUISITION_MASTER_SECRET,MEDIACRAWLER_SERVICE_SECRET_FILE,MEDIACRAWLER_ENCRYPTED_VOLUME/u
  );
});

test("production adds secure-cookie and database requirements", () => {
  assert.equal(requiredProductionVariables.includes("SESSION_COOKIE_SECURE"), true);
  assert.equal(requiredProductionVariables.includes("SHENSI_MYSQL_APP_PASSWORD"), true);
});

test("production rejects memory persistence and development seed data", () => {
  const environment = Object.fromEntries(requiredProductionVariables.map((name) => [
    name,
    name === "DATABASE_URL" ? "mysql://shensi_app:fixture@mysql:3306/shensi"
      : name === "SESSION_COOKIE_SECURE" ? "true"
        : name === "CORS_ORIGINS" ? "https://shensi.example"
          : "fixture-security-value-that-is-longer-than-32-characters"
  ]));
  assert.throws(
    () => validateProductionVariables({ ...environment, CRM_STORE: "memory" }),
    /PRODUCTION_CRM_STORE_MUST_BE_MYSQL/u
  );
  assert.throws(
    () => validateProductionVariables({
      ...environment,
      CRM_STORE: "mysql",
      CRM_SEED_DEVELOPMENT_DATA: "true"
    }),
    /PRODUCTION_DEVELOPMENT_SEEDING_FORBIDDEN/u
  );
});

test("production accepts only the exact disabled or rapidocr visual locator", () => {
  const environment = Object.fromEntries(requiredProductionVariables.map((name) => [
    name,
    name === "DATABASE_URL" ? "mysql://shensi_app:fixture@mysql:3306/shensi"
      : name === "SESSION_COOKIE_SECURE" ? "true"
        : name === "CORS_ORIGINS" ? "https://shensi.example"
          : "fixture-security-value-that-is-longer-than-32-characters"
  ]));
  const base = {
    ...environment,
    CRM_STORE: "mysql",
    CRM_SEED_DEVELOPMENT_DATA: "false"
  };
  assert.doesNotThrow(() => validateProductionVariables(base));
  assert.doesNotThrow(() => validateProductionVariables({
    ...base,
    DOUYIN_ACTION_VISUAL_LOCATOR: "rapidocr"
  }));
  for (const invalid of ["", "RAPIDOCR", " rapidocr ", "ocr"]) {
    assert.throws(() => validateProductionVariables({
      ...base,
      DOUYIN_ACTION_VISUAL_LOCATOR: invalid
    }), /DOUYIN_ACTION_VISUAL_LOCATOR_INVALID/u);
  }
});

test("production configuration rejects a database URL that is not canonical for its secret file", () => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-runtime-"));
  try {
    const appPassword = "a".repeat(32);
    const differentPassword = "b".repeat(32);
    writeFileSync(join(directory, "mysql_app_password"), appPassword, { mode: 0o600 });
    writeFileSync(join(directory, "mysql_root_password"), "r".repeat(32), { mode: 0o600 });
    assert.throws(
      () => validateProductionSecrets({
        DATABASE_URL: `mysql://shensi_app:${differentPassword}@mysql:3306/shensi`,
        SHENSI_MYSQL_APP_PASSWORD: appPassword
      }, directory),
      /DATABASE_URL_PASSWORD_NOT_CANONICAL/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production environment files require owner-only permissions on POSIX", {
  skip: process.platform === "win32"
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-runtime-"));
  const environmentFile = join(directory, ".env.production.local");
  try {
    writeFileSync(environmentFile, "DATABASE_URL=mysql://example", { mode: 0o600 });
    chmodSync(environmentFile, 0o644);
    assert.throws(() => assertOwnerOnlyMode(environmentFile), /PRODUCTION_ENV_PERMISSIONS_MUST_BE_0600/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing Docker fails explicitly before production commands run", () => {
  assert.throws(
    () => assertDockerAvailable("shensi-docker-command-that-does-not-exist"),
    /DOCKER_UNAVAILABLE/u
  );
});
