import assert from "node:assert/strict";
import test from "node:test";
import {
  financialCouncilRealE2eContract,
  financialCouncilRealE2eReadiness,
  startFinancialCouncilRealE2eServer
} from "./financial-council-real-e2e-server.js";
import { completeFinancialCouncilIntegrationReport,
  financialCouncilIntegrationForecastInput } from
  "./financial-council-integration-fixtures.js";

test("deterministic acceptance report and browser forecast share future cash inputs", () => {
  const forecast = financialCouncilIntegrationForecastInput();
  const cashFlow = completeFinancialCouncilIntegrationReport().cashFlow!;
  assert.deepEqual({
    expectedInflowsNext30DaysMinor:
      cashFlow.expectedInflowsNext30DaysMinor,
    expectedOutflowsNext30DaysMinor:
      cashFlow.expectedOutflowsNext30DaysMinor,
    expectedInflowsNext31To90DaysMinor:
      cashFlow.expectedInflowsNext31To90DaysMinor,
    expectedOutflowsNext31To90DaysMinor:
      cashFlow.expectedOutflowsNext31To90DaysMinor,
    receivables: cashFlow.receivables
  }, {
    expectedInflowsNext30DaysMinor:
      forecast.expectedInflowsNext30DaysMinor,
    expectedOutflowsNext30DaysMinor:
      forecast.expectedOutflowsNext30DaysMinor,
    expectedInflowsNext31To90DaysMinor:
      forecast.expectedInflowsNext31To90DaysMinor,
    expectedOutflowsNext31To90DaysMinor:
      forecast.expectedOutflowsNext31To90DaysMinor,
    receivables: forecast.receivables
  });
});

test("real E2E server exposes a stable machine-readable loopback contract", () => {
  assert.deepEqual(financialCouncilRealE2eContract("isolated_test_db"), {
    schemaVersion: "financial-council-real-e2e.v1",
    origin: "http://127.0.0.1:4288",
    healthUrl: "http://127.0.0.1:4288/healthz",
    workspaceId: "europe",
    dataAsOf: "2026-08-16T08:00:00.000Z",
    csrf: { cookie: "gj_csrf", header: "x-csrf-token" },
    databaseName: "isolated_test_db"
  });
  assert.equal(JSON.stringify(financialCouncilRealE2eContract(
    "isolated_test_db")).includes("goodjob123"), false);
});

test("real E2E readiness exposes metadata without forecast inputs", () => {
  const readiness = financialCouncilRealE2eReadiness(
    financialCouncilRealE2eContract("isolated_test_db")
  );
  assert.deepEqual(readiness, {
    status: "ok",
    schemaVersion: "financial-council-real-e2e.v1",
    workspaceId: "europe",
    databaseName: "isolated_test_db"
  });
  const serialized = JSON.stringify(readiness);
  const forecast = financialCouncilIntegrationForecastInput();
  assert.equal(serialized.includes(forecast.receivables[0]!.customer), false);
  assert.equal(serialized.includes(String(
    forecast.expectedInflowsNext30DaysMinor
  )), false);
});

test("real E2E server fails fast when live MySQL authority is absent", async () => {
  const previous = process.env.MYSQL_TEST_ADMIN_URL;
  delete process.env.MYSQL_TEST_ADMIN_URL;
  try {
    await assert.rejects(
      startFinancialCouncilRealE2eServer(),
      /MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council-real-runtime/u
    );
  } finally {
    if (previous === undefined) delete process.env.MYSQL_TEST_ADMIN_URL;
    else process.env.MYSQL_TEST_ADMIN_URL = previous;
  }
});
