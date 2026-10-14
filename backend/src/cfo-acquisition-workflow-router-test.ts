import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createCfoAcquisitionWorkflowRouter } from "./cfo-acquisition-workflow-router.js";

async function fixture() {
  const calls: string[] = [];
  const workflow = {
    workflowId: "workflow-1",
    instruction: "帮我执行抖音获客",
    stage: "awaiting_plan_approval",
    summary: "已生成计划",
    planId: "plan-1",
    planEtag: '"plan-1:1"',
    runId: null,
    runStatus: null,
    candidates: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z"
  } as const;
  const service = {
    async createDraft(_scope: unknown, input: any) {
      calls.push(`create:${input.instruction}:${input.idempotencyKey}`);
      return workflow;
    },
    async get() { calls.push("get"); return workflow; },
    async latest() { calls.push("latest"); return workflow; },
    async approveAndRun() { calls.push("approve"); return { ...workflow, stage: "running_acquisition" }; },
    async reconcile() { calls.push("reconcile"); return workflow; },
    async decideCandidate() { calls.push("decide"); return workflow; },
    async decideCandidates(_scope: unknown, _id: string, input: any) {
      calls.push(`decide-batch:${input.decisions.map((decision: any) => decision.candidateId).join(",")}`);
      return workflow;
    },
    async cancel() { calls.push("cancel"); return { ...workflow, stage: "cancelled" }; }
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("x-auth") === "yes") req.user = { id: "owner-1", teamId: "team-1" } as any;
    next();
  });
  app.use(createCfoAcquisitionWorkflowRouter({ service: service as any }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server not bound");
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-auth", "yes");
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
    return { response, json: await response.json() };
  };
  return { calls, request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("CFO workflow HTTP boundary requires identity and idempotency", async () => {
  const app = await fixture();
  try {
    const missingKey = await app.request("/api/v1/acquisition/cfo-workflows", {
      method: "POST",
      body: JSON.stringify({ instruction: "帮我执行抖音获客" })
    });
    assert.equal(missingKey.response.status, 400);

    const created = await app.request("/api/v1/acquisition/cfo-workflows", {
      method: "POST",
      headers: { "Idempotency-Key": "workflow-create-1" },
      body: JSON.stringify({ instruction: "帮我执行抖音获客" })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.json.workflowId, "workflow-1");
    assert.equal(app.calls[0], "create:帮我执行抖音获客:workflow-create-1");
  } finally {
    await app.close();
  }
});

test("CFO workflow HTTP boundary exposes latest, approval, decision and cancellation", async () => {
  const app = await fixture();
  try {
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/latest")).response.status, 200);
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/workflow-1")).response.status, 200);
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/workflow-1/approval", {
      method: "POST",
      headers: { "Idempotency-Key": "workflow-approve-1" },
      body: JSON.stringify({ reason: "人工核对通过" })
    })).response.status, 200);
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/workflow-1/candidate-decisions", {
      method: "POST",
      headers: { "Idempotency-Key": "workflow-decision-1" },
      body: JSON.stringify({
        candidateId: "candidate-1",
        action: "rejected",
        reason: "证据不足"
      })
    })).response.status, 200);
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/workflow-1/candidate-decisions/batch", {
      method: "POST",
      headers: { "Idempotency-Key": "workflow-batch-decision-1" },
      body: JSON.stringify({ decisions: [
        { candidateId: "candidate-1", action: "approved", reason: "人工批量核对通过" },
        { candidateId: "candidate-2", action: "approved", reason: "人工批量核对通过" }
      ] })
    })).response.status, 200);
    assert.equal((await app.request("/api/v1/acquisition/cfo-workflows/workflow-1/cancel", {
      method: "POST",
      headers: { "Idempotency-Key": "workflow-cancel-1" },
      body: JSON.stringify({ reason: "人工取消" })
    })).response.status, 200);
    assert.deepEqual(app.calls, ["latest", "reconcile", "approve", "decide", "decide-batch:candidate-1,candidate-2", "cancel"]);
  } finally {
    await app.close();
  }
});
