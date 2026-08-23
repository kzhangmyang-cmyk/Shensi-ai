import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createFinancialStatementPackageRouter } from
  "./financial-statement-package-router.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { InMemoryGrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import { workspace } from "./financial-council-repository-contract-test.js";

const NOW = "2026-08-23T08:00:00.000Z";
async function listen() {
  const app = express(); app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => { req.activeWorkspace = Object.freeze({
    ...workspace(), role: "admin",
    capabilities: Object.freeze(["ledger.pending.create"])
  }) as never; next(); });
  app.use("/api/v1/finance/statement-packages",
    createFinancialStatementPackageRouter({ service: {
      async preview() { return { previewId: "preview-1", workspaceId: "ws-1",
        status: "preview", expiresAt: NOW, companyName: "ACME", currency: "CNY",
        period: "2026-07", sourceFiles: [], parserVersion: "financial-statements.v2",
        businessReport: { secret: "normalized" }, reportInputHash: "secret",
        warnings: [], previewHash: "secret", createdAt: NOW }; },
      async commit() { return { value: { packageId: "package-1", workspaceId: "ws-1",
        status: "verified", companyName: "ACME", currency: "CNY", period: "2026-07",
        sourceFiles: [], parserVersion: "financial-statements.v2",
        businessReport: { secret: "normalized" }, reportInputHash: "secret",
        warnings: [], consent: { accepted: true }, packageHash: "secret",
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
    const serialized = JSON.stringify(commit.body);
    for (const forbidden of ["businessReport", "contentBase64", "raw",
      "reportInputHash", "packageHash", "workspaceId"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
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
