import assert from "node:assert/strict";
import test from "node:test";
import { readLocalRealRuntimeConfig } from "./local-real-runtime.js";

test("real local config is fixed to loopback mysql 3307 and never returns secrets", () => {
  const config = readLocalRealRuntimeConfig({
    CRM_STORE: "mysql",
    DATABASE_URL: "mysql://shensi_sales_app:local-test-password@127.0.0.1:3307/shensi_sales",
    JWT_SECRET: "x".repeat(32),
    PROVIDER_CREDENTIAL_SECRET: "y".repeat(32)
  });

  assert.deepEqual(config, {
    mysqlHost: "127.0.0.1",
    mysqlPort: 3307,
    mysqlDatabase: "shensi_sales",
    backendOrigin: "http://127.0.0.1:4188",
    frontendOrigin: "http://127.0.0.1:5188"
  });
  assert.equal(JSON.stringify(config).includes("local-test-password"), false);
});

test("real mode refuses memory and non-loopback mysql", () => {
  assert.throws(
    () => readLocalRealRuntimeConfig({ CRM_STORE: "memory" }),
    /REAL_RUNTIME_REQUIRES_MYSQL/u
  );
  assert.throws(
    () => readLocalRealRuntimeConfig({
      CRM_STORE: "mysql",
      DATABASE_URL: "mysql://shensi_sales_app:x@example.com:3307/shensi_sales"
    }),
    /REAL_RUNTIME_MYSQL_TOPOLOGY_INVALID/u
  );
});
