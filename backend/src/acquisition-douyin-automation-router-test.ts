import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";
import {
  createAcquisitionDouyinAutomationRouter
} from "./acquisition-douyin-automation-router.js";
import {
  InMemoryAcquisitionDouyinAutomationRepository
} from "./acquisition-douyin-automation-repository.js";
import {
  AcquisitionDouyinAutomationService
} from "./acquisition-douyin-automation-service.js";
import {
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionPlan,
  type AcquisitionPlanPayload,
  type AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";

const NOW = "2026-08-25T01:00:00.000Z";
const POLICY = {
  keywords: ["工业除尘设备", "工厂环保改造"],
  schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: {
    maxVideos: 30,
    maxCommentsPerVideo: 50,
    maxPagesPerVideo: 3,
    maxDurationSeconds: 3_600
  }
};

function payload(): AcquisitionPlanPayload {
  return {
    targetPlatform: "douyin",
    name: "抖音获客",
    objective: "工业环保需求",
    icp: {
      industries: ["工业环保"],
      regions: ["中国"],
      organizationCriteria: ["有改造需求"],
      individualCriteria: ["公开需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: true, individual: true },
    providerConnections: [],
    operations: [],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 100,
      maxResults: 1_000,
      maxAmountMinor: 10_000,
      maxDurationSeconds: 3_600
    },
    modelSnapshotRef: {
      jobSnapshotId: "job-1",
      connectionId: "connection-1",
      credentialVersion: 1,
      provider: "qwen",
      model: "qwen-plus",
      capabilitySnapshotHash: "sha256:capability",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

async function createHttp() {
  const plans = new InMemoryAcquisitionPlanRunRepository();
  const planPayload = payload();
  const version: AcquisitionPlanVersion = {
    id: "plan-version-1",
    planId: "plan-1",
    ownerId: "owner-a",
    teamId: "team-a",
    version: 1,
    payload: planPayload,
    payloadHash: "plan-snapshot-hash-1",
    createdBy: "owner-a",
    createdAt: NOW
  };
  const plan: AcquisitionPlan = {
    id: version.planId,
    ownerId: version.ownerId,
    teamId: version.teamId,
    status: "approved",
    version: 1,
    revision: 2,
    etag: '"plan-1:2"',
    currentVersionId: version.id,
    approvedVersionId: version.id,
    approvedSnapshotHash: version.payloadHash,
    approvedBy: "owner-a",
    approvedAt: NOW,
    budgetSnapshot: planPayload.budgetSnapshot,
    payload: planPayload,
    createdBy: "owner-a",
    createdAt: NOW,
    updatedBy: "owner-a",
    updatedAt: NOW
  };
  await plans.transaction((transaction) => {
    transaction.putPlan(plan);
    transaction.appendPlanVersion(version);
  });
  const accounts = new InMemoryAcquisitionSocialAccountRepository();
  await accounts.upsert({
    id: "account-1",
    workspaceId: "workspace-a",
    platform: "douyin",
    accountHandle: "must-not-leak",
    upstreamSessionId: "upstream-1",
    displayName: "企业抖音号",
    state: "active",
    loginStateVersion: 7,
    revision: 1,
    etag: '"account-v1"',
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  let sequence = 0;
  const service = new AcquisitionDouyinAutomationService({
    repository: new InMemoryAcquisitionDouyinAutomationRepository(),
    plans,
    accounts,
    resolvePlanWorkspace: async () => ({ workspaceId: "workspace-a" }),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => NOW
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: "owner-a",
      teamId: "team-a",
      name: "Owner",
      email: "owner@example.test",
      role: "sales",
      avatar: "",
      authVersion: 1
    };
    req.activeWorkspace = {
      workspaceId: req.header("X-Test-Workspace") ?? "workspace-a",
      kind: "team",
      actorId: "owner-a",
      role: "sales",
      teamId: "team-a",
      capabilities: [],
      capabilityRegistryVersion: "growth-capabilities.v1"
    };
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionDouyinAutomationRouter({
    service,
    requestIdFactory: () => "request-automation-1"
  }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`${base}${path}`, { ...init, headers });
      return { response, body: await response.json() };
    },
    close: () => new Promise<void>((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve()
    ))
  };
}

test("automation router enforces conditional idempotent writes and exact replay", async () => {
  const http = await createHttp();
  try {
    const initial = await http.request("/api/v1/acquisition/plans/plan-1/automation");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.source, "default");
    const initialEtag = initial.response.headers.get("etag");
    assert.equal(initialEtag, initial.body.etag);

    const missingIfMatch = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      {
        method: "PUT",
        headers: { "Idempotency-Key": "policy-router-1" },
        body: JSON.stringify(POLICY)
      }
    );
    assert.equal(missingIfMatch.response.status, 428);
    assert.equal(missingIfMatch.body.code, "if_match_required");

    const strict = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      {
        method: "PUT",
        headers: {
          "Idempotency-Key": "policy-router-strict-1",
          "If-Match": initialEtag!
        },
        body: JSON.stringify({ ...POLICY, accountHandle: "forged" })
      }
    );
    assert.equal(strict.response.status, 400);

    const saved = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      {
        method: "PUT",
        headers: {
          "Idempotency-Key": "policy-router-1",
          "If-Match": initialEtag!
        },
        body: JSON.stringify(POLICY)
      }
    );
    assert.equal(saved.response.status, 200);
    assert.equal(saved.response.headers.get("etag"), saved.body.etag);
    assert.equal(JSON.stringify(saved.body).includes("must-not-leak"), false);

    const replay = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      {
        method: "PUT",
        headers: {
          "Idempotency-Key": "policy-router-1",
          "If-Match": initialEtag!
        },
        body: JSON.stringify(POLICY)
      }
    );
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(replay.body, saved.body);
  } finally {
    await http.close();
  }
});

test("run-now is workspace-bound, closed, idempotent, and rejects changed replay", async () => {
  const http = await createHttp();
  try {
    const initial = await http.request("/api/v1/acquisition/plans/plan-1/automation");
    const saved = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      {
        method: "PUT",
        headers: {
          "Idempotency-Key": "policy-run-router-1",
          "If-Match": initial.response.headers.get("etag")!
        },
        body: JSON.stringify(POLICY)
      }
    );
    assert.equal(saved.response.status, 200);

    const run = await http.request(
      "/api/v1/acquisition/plans/plan-1/run-now",
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-router-replay-1" },
        body: JSON.stringify({ reason: "立即执行" })
      }
    );
    assert.equal(run.response.status, 202);
    assert.equal(run.body.policyVersionId, saved.body.id);

    const replay = await http.request(
      "/api/v1/acquisition/plans/plan-1/run-now",
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-router-replay-1" },
        body: JSON.stringify({ reason: "立即执行" })
      }
    );
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(replay.body, run.body);

    const changed = await http.request(
      "/api/v1/acquisition/plans/plan-1/run-now",
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-router-replay-1" },
        body: JSON.stringify({ reason: "changed" })
      }
    );
    assert.equal(changed.response.status, 409);
    assert.equal(changed.body.code, "automation_idempotency_conflict");

    const unknownField = await http.request(
      "/api/v1/acquisition/plans/plan-1/run-now",
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-router-strict-1" },
        body: JSON.stringify({ accountId: "forged" })
      }
    );
    assert.equal(unknownField.response.status, 400);

    const crossWorkspace = await http.request(
      "/api/v1/acquisition/plans/plan-1/automation",
      { headers: { "X-Test-Workspace": "workspace-other" } }
    );
    assert.equal(crossWorkspace.response.status, 404);
  } finally {
    await http.close();
  }
});
