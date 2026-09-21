import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("Render free API blueprint keeps secrets external and Aiven TLS verified", async () => {
  const blueprint = parse(await readFile(new URL("../render.yaml", import.meta.url), "utf8"));
  assert.equal(blueprint.services.length, 1);
  const service = blueprint.services[0];
  assert.equal(service.type, "web");
  assert.equal(service.runtime, "docker");
  assert.equal(service.plan, "free");
  assert.equal(service.healthCheckPath, "/api/health");
  assert.equal(service.autoDeployTrigger, "off");
  const variables = new Map(service.envVars.map((item) => [item.key, item]));
  assert.equal(variables.get("DATABASE_URL")?.sync, false);
  assert.equal(variables.get("MYSQL_SSL_CA")?.sync, false);
  assert.equal(variables.get("MYSQL_SSL_MODE")?.value, "verify_ca");
  assert.equal(variables.get("SHENSI_DESKTOP_CLIENT_ADMISSION_MODE")?.value,
    "migration_locked");
  assert.equal(variables.get("DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED")?.value,
    "false");
});
