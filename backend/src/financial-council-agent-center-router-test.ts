import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import test from "node:test";
import express from "express";
import { createFinancialCouncilAgentCenterRouter } from
  "./financial-council-agent-center-router.js";
import { workspace } from "./financial-council-repository-contract-test.js";

test("agent-center reads reject bodies and return only the center projection", async () => {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.activeWorkspace = Object.freeze({ ...workspace(), role: "admin",
      capabilities: Object.freeze(["finance.council.run"]) }) as never; next(); });
  app.use("/api/v1/finance", createFinancialCouncilAgentCenterRouter({
    center: { async get() { return { data: {}, models: {}, latestRun: null,
      capabilities: {} }; }, async getRunAgents() {
      return { runId: "run-1", status: "analyzing", revision: 2,
        updatedAt: "2026-08-23T08:00:00.000Z", roles: [] }; } } as never,
    workspaceContext(req) { return req.activeWorkspace!; }
  }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((r) =>
    server.once("listening", r)); const port = (server.address() as AddressInfo).port;
  try {
    const okay = await fetch(`http://127.0.0.1:${port}/api/v1/finance/council-agent-center`);
    assert.equal(okay.status, 200);
    const bodyRead = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port,
        path: "/api/v1/finance/council-agent-center", method: "GET",
        headers: { "Content-Type": "application/json", "Content-Length": "2" }
      }, (response) => { response.resume(); response.once("end", () =>
        resolve(response.statusCode ?? 0)); });
      req.once("error", reject); req.end("{}");
    });
    assert.equal(bodyRead, 422);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
