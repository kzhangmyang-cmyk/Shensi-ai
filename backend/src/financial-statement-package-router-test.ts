import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";
import { createFinancialStatementPackageRouter } from
  "./financial-statement-package-router.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { InMemoryGrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import { FinancialStatementPackageRepositoryError } from
  "./financial-statement-package-repository.js";
import { workspace } from "./financial-council-repository-contract-test.js";

const NOW = "2026-08-23T08:00:00.000Z";
const forecastBody = () => ({
  forecastAsOf: "2026-08-23T07:59:00.000Z",
  expectedInflowsNext30DaysMinor: 100_000,
  expectedOutflowsNext30DaysMinor: 500_000,
  expectedInflowsNext31To90DaysMinor: 800_000,
  expectedOutflowsNext31To90DaysMinor: 300_000,
  receivables: [{ customer: "客户 A", amountMinor: 1_000_000,
    daysOutstanding: 120 }],
  attestation: { accepted: true,
    noticeVersion: "financial-cash-forecast.v1" }
});
const sourceFiles = ["balance_sheet", "income_statement",
  "cash_flow_statement"].map((kind) => ({ kind, fileName: `${kind}.xlsx`,
  fileHash: `sha256:${"b".repeat(64)}`,
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sheetNames: ["Sheet1"] }));
function releasedPackageValidator() {
  const document = loadGrowthContractRelease().document as Record<string, any>;
  const components = structuredClone(document.components);
  for (const schema of Object.values(components.schemas) as any[]) {
    if (schema && typeof schema === "object") delete schema.$id;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema", components,
    $ref: "#/components/schemas/FinancialStatementPackageView"
  });
}
async function listen(onCommit?: (context: any, input: any) => void) {
  const app = express(); app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => { req.activeWorkspace = Object.freeze({
    ...workspace(), role: "admin",
    capabilities: Object.freeze(["ledger.pending.create"])
  }) as never; next(); });
  app.use("/api/v1/finance/statement-packages",
    createFinancialStatementPackageRouter({ service: {
      async preview() { return { previewId: "preview-1", workspaceId: "ws-1",
        status: "preview", expiresAt: NOW, companyName: "ACME", currency: "CNY",
        period: "2026-07", sourceFiles, parserVersion: "financial-statements.v2",
        businessReport: { secret: "normalized" }, reportInputHash: "secret",
        warnings: [], previewHash: "secret", createdAt: NOW }; },
      async commit(context: any, input: any) { onCommit?.(context, input); return { value: { packageId: "package-1", workspaceId: "ws-1",
        status: "verified", companyName: "ACME", currency: "CNY", period: "2026-07",
        sourceFiles, parserVersion: "financial-statements.v2",
        businessReport: { secret: "normalized" }, reportInputHash: "secret",
        warnings: [], consent: { accepted: true },
        forecastStatus: input.cashForecast ? "computed" : "not_computable",
        cashForecast: input.cashForecast ? { source: "management_attested",
          ...forecastBody(), currency: "CNY", acceptedBy: "actor-a",
          acceptedAt: NOW, noticeVersion: "financial-cash-forecast.v1",
          forecastHash: `sha256:${"a".repeat(64)}` } : null, packageHash: "secret",
        createdAt: NOW }, replayed: false }; }
    } as never, workspaceContext(req) { return req.activeWorkspace!; },
      commandContextFactory: commandContextFromRequest,
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(), now: () => NOW }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((r) =>
    server.once("listening", r)); const port = (server.address() as AddressInfo).port;
  return { async request(path: string, init: RequestInit) { const response =
    await fetch(`http://127.0.0.1:${port}${path}`, init); return { response,
      body: await response.json() }; }, close: () => new Promise<void>((r) =>
        server.close(() => r())) };
}

test("statement routes reject open inputs and never return bytes or normalized data", async () => {
  const server = await listen();
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "key-1" };
  try {
    const open = await server.request("/api/v1/finance/statement-packages/preview",
      { method: "POST", headers, body: JSON.stringify({ statements: [],
        workspaceId: "other" }) });
    assert.equal(open.response.status, 422);
    const commit = await server.request(
      "/api/v1/finance/statement-packages/preview-1/commit", { method: "POST",
        headers, body: JSON.stringify({ consent: { accepted: true,
          noticeVersion: "financial-model-data.v1" } }) });
    assert.equal(commit.response.status, 201);
    assert.equal(commit.body.forecastStatus, "not_computable");
    assert.equal(commit.body.cashForecast, null);
    const validate = releasedPackageValidator();
    assert.equal(validate(commit.body), true, JSON.stringify(validate.errors));
    const serialized = JSON.stringify(commit.body);
    for (const forbidden of ["businessReport", "contentBase64", "raw",
      "reportInputHash", "packageHash", "workspaceId"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally { await server.close(); }
});

test("commit forwards only a closed forecast and returns a sanitized summary", async () => {
  let recorded: any;
  const server = await listen((_context, input) => { recorded = input; });
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "key-forecast" };
  try {
    const result = await server.request(
      "/api/v1/finance/statement-packages/preview-1/commit", { method: "POST",
        headers, body: JSON.stringify({ consent: { accepted: true,
          noticeVersion: "financial-model-data.v1" }, cashForecast: forecastBody() }) });
    assert.equal(result.response.status, 201);
    assert.deepEqual(recorded.cashForecast, forecastBody());
    for (const field of ["currency", "source", "acceptedBy", "acceptedAt",
      "forecastHash"]) assert.equal(recorded.cashForecast[field], undefined, field);
    assert.equal(result.body.forecastStatus, "computed");
    assert.equal(result.body.cashForecast.receivablesCount, 1);
    const validate = releasedPackageValidator();
    assert.equal(validate(result.body), true, JSON.stringify(validate.errors));
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("客户 A"), false);
    assert.equal(serialized.includes("receivables"), true);
    assert.equal(serialized.includes("amountMinor"), false);
    assert.equal(serialized.includes("acceptedBy"), false);
  } finally { await server.close(); }
});

test("changed forecast under one idempotency key is a conflict", async () => {
  let first: { idempotencyKey: string; requestHash: string } | undefined;
  const server = await listen((context) => {
    if (!first) { first = context; return; }
    if (context.idempotencyKey === first.idempotencyKey
      && context.requestHash !== first.requestHash) {
      throw new FinancialStatementPackageRepositoryError(
        "financial_statement_idempotency_conflict");
    }
  });
  const headers = { "Content-Type": "application/json",
    "Idempotency-Key": "key-conflict" };
  const body = { consent: { accepted: true,
    noticeVersion: "financial-model-data.v1" }, cashForecast: forecastBody() };
  try {
    const firstResponse = await server.request(
      "/api/v1/finance/statement-packages/preview-1/commit", { method: "POST",
        headers, body: JSON.stringify(body) });
    assert.equal(firstResponse.response.status, 201);
    const changed = await server.request(
      "/api/v1/finance/statement-packages/preview-1/commit", { method: "POST",
        headers, body: JSON.stringify({ ...body, cashForecast: {
          ...body.cashForecast, expectedInflowsNext30DaysMinor: 100_001 } }) });
    assert.equal(changed.response.status, 409);
    assert.equal(changed.body.code, "financial_statement_idempotency_conflict");
  } finally { await server.close(); }
});

test("commit rejects open or unsafe cash forecast browser inputs", async () => {
  const server = await listen();
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "key-invalid" };
  const consent = { accepted: true, noticeVersion: "financial-model-data.v1" };
  const base = forecastBody();
  const cases = [
    { consent, cashForecast: base, workspaceId: "other" },
    { consent, cashForecast: { ...base, acceptedBy: "attacker" } },
    { consent, cashForecast: { ...base, currency: "USD" } },
    { consent, cashForecast: { ...base,
      attestation: { ...base.attestation, acceptedAt: NOW } } },
    { consent, cashForecast: { ...base,
      receivables: [{ ...base.receivables[0], customerId: "secret" }] } },
    { consent, cashForecast: { ...base,
      receivables: Array.from({ length: 101 }, (_, index) => ({
        customer: `customer-${index}`, amountMinor: index + 1,
        daysOutstanding: index })) } },
    { consent, cashForecast: { ...base,
      expectedInflowsNext30DaysMinor: Number.MAX_SAFE_INTEGER + 1 } },
    { consent, cashForecast: { ...base,
      forecastAsOf: "2026-08-23T08:00:02.000Z" } },
    { cashForecast: base }
  ];
  try {
    for (const body of cases) {
      const result = await server.request(
        "/api/v1/finance/statement-packages/preview-1/commit", { method: "POST",
          headers, body: JSON.stringify(body) });
      assert.equal(result.response.status, 422, JSON.stringify(body));
    }
  } finally { await server.close(); }
});

test("statement preview enforces the closed three-statement tuple at runtime", async () => {
  const server = await listen();
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "key-tuple" };
  const upload = (kind: string, extra: Record<string, unknown> = {}) => ({
    kind, fileName: `${kind}.xlsx`,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: "AA==", ...extra
  });
  try {
    for (const statements of [
      [upload("income_statement"), upload("balance_sheet"),
        upload("cash_flow_statement")],
      [upload("balance_sheet", { workspaceId: "other" }),
        upload("income_statement"), upload("cash_flow_statement")]
    ]) {
      const result = await server.request(
        "/api/v1/finance/statement-packages/preview", { method: "POST", headers,
          body: JSON.stringify({ statements }) });
      assert.equal(result.response.status, 422);
    }
  } finally { await server.close(); }
});
