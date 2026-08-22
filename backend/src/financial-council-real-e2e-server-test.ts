import assert from "node:assert/strict";
import test from "node:test";
import {
  financialCouncilRealE2eContract,
  startFinancialCouncilRealE2eServer
} from "./financial-council-real-e2e-server.js";

test("real E2E server exposes a stable machine-readable loopback contract", () => {
  assert.deepEqual(financialCouncilRealE2eContract("isolated_test_db"), {
    schemaVersion: "financial-council-real-e2e.v1",
    origin: "http://127.0.0.1:4288",
    healthUrl: "http://127.0.0.1:4288/healthz",
    credentials: {
      email: "admin@goodjob.com",
      password: "goodjob123"
    },
    workspaceId: "europe",
    dataAsOf: "2026-08-16T08:00:00.000Z",
    csrf: { cookie: "gj_csrf", header: "x-csrf-token" },
    databaseName: "isolated_test_db"
  });
});

test("real E2E server fails fast when live MySQL authority is absent", async () => {
  const previous = process.env.MYSQL_TEST_ADMIN_URL;
  delete process.env.MYSQL_TEST_ADMIN_URL;
  try {
    await assert.rejects(
      startFinancialCouncilRealE2eServer(),
      /MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council/u
    );
  } finally {
    if (previous === undefined) delete process.env.MYSQL_TEST_ADMIN_URL;
    else process.env.MYSQL_TEST_ADMIN_URL = previous;
  }
});
