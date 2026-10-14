import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import test from "node:test";
import express from "express";
import { FinancialCouncilAgentCenter } from './financial-council-agent-center.js';
import { InMemoryCfoConversationSessionRepository } from './cfo-conversation-session-repository.js';
import { createFinancialCouncilAgentCenterRouter } from
  "./financial-council-agent-center-router.js";
import { workspace } from "./financial-council-repository-contract-test.js";

test('session HTTP streams actual stages and a persisted result, then returns scoped history', async () => {
  const context = { ...workspace(), role: 'admin' as const, capabilities: ['finance.council.run'] as const };
  const center = new FinancialCouncilAgentCenter({ sessions: new InMemoryCfoConversationSessionRepository(),
    latestPackage: { getLatestVerified: async () => null }, latestRun: {} as never,
    routing: { getCurrent: async () => null }, runtimeState: () => ({ connections: [], recentCalls: [] }),
    chatModel: async input => { input.onProgress?.('skill_ready'); input.onProgress?.('model_started');
      return { answer: '请补充资料。', provider: 'fixture', model: 'fixture' }; }
  });
  const app = express(); app.use(express.json());
  app.use(createFinancialCouncilAgentCenterRouter({ center, workspaceContext: () => context }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await (await fetch(`${base}/cfo-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: null }) })).json();
    const response = await fetch(`${base}/cfo-sessions/${created.sessionId}/turns`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ question: '现金流如何改善？', revision: 1, documentId: null }) });
    assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.slice(0, -1).map(event => event.stage), ['material_ready', 'skill_ready', 'model_started', 'answer_validated']);
    assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).result.session.revision, 2);
    const restored = await (await fetch(`${base}/cfo-sessions/${created.sessionId}`)).json();
    assert.equal(restored.turns[1].text, '请补充资料。');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

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
