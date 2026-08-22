import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { createFinancialCouncilRouter } from "./financial-council-router.js";
import * as financialCouncilRouterModule from
  "./financial-council-router.js";
import { repositoryRunFixture, workspace } from
  "./financial-council-repository-contract-test.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { InMemoryGrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import { financialCouncilError } from "./financial-council-domain.js";
import { FinancialCouncilService } from "./financial-council-service.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import { InMemoryFinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { GrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";

const NOW = "2026-08-16T08:01:00.000Z";

test("financial council router exposes the workspace policy capability", () => {
  assert.equal(
    typeof Reflect.get(financialCouncilRouterModule,
      "createFinancialCouncilPolicyRouter"),
    "function"
  );
});

function createInput(extra: Record<string, unknown> = {}) {
  const run = repositoryRunFixture();
  return {
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    businessReport: run.businessReport,
    policyVersionId: run.policyVersionId,
    ...extra
  };
}

function policyInput(extra: Record<string, unknown> = {}) {
  return {
    currency: "CNY",
    balancedWeightsBps: {
      cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000
    },
    minimumCashReserveMinor: 100_000,
    dueDebtMinor: 20_000,
    necessaryOutflowMinor: 30_000,
    budgetLimitMinor: 50_000,
    capacityLimitUnits: 20,
    durationLimitDays: 90,
    minimumActionConfidenceBps: 6_000,
    actionCoefficientVersion: "financial-council-actions.v1",
    ...extra
  };
}

function policyVersion(version = 1) {
  return Object.freeze({
    policyVersionId: version === 1
      ? "financial-council-policy.v1" : `policy-${version}`,
    workspaceId: "ws-1", version, revision: version,
    ...policyInput(), policyHash: `sha256:${String(version).repeat(64)}`,
    createdAt: NOW
  });
}

async function listenPolicy(
  service: Record<string, unknown>,
  capabilities: readonly string[] = [
    "finance.council.run", "catalog.manage", "pricing.sensitive.read"
  ]
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = Object.freeze({
      ...workspace("ws-1"), role: "admin" as const,
      capabilities: Object.freeze([...capabilities])
    }) as never;
    next();
  });
  const factory = Reflect.get(financialCouncilRouterModule,
    "createFinancialCouncilPolicyRouter") as Function;
  const completeService = {
    ...service,
    getPolicyVersion: service.getPolicyVersion ?? service.getPolicy
  };
  app.use("/api/v1/finance/council-policy", factory({
    service: completeService,
    workspaceContext(req: express.Request) { return req.activeWorkspace!; },
    commandContextFactory: commandContextFromRequest,
    httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
    now: () => NOW
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    async request(init: RequestInit = {}) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/finance/council-policy`, init
      );
      return { response, body: await response.json() };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()))
  };
}

test("policy GET and PUT publish capability-scoped immutable versions", async () => {
  let active = policyVersion();
  let updates = 0;
  const server = await listenPolicy({
    async getPolicy() { return active; },
    async updatePolicy() { updates += 1; active = policyVersion(2); return {
      value: active, replayed: false
    }; }
  });
  try {
    const get = await server.request();
    assert.equal(get.response.status, 200);
    assert.equal(get.response.headers.get("etag"),
      '"financial-council-policy:ws-1:1"');
    assert.deepEqual(Object.keys(get.body).sort(), [
      "actionCoefficientVersion", "balancedWeightsBps", "budgetLimitMinor",
      "capacityLimitUnits", "createdAt", "currency", "dueDebtMinor",
      "durationLimitDays", "minimumActionConfidenceBps",
      "minimumCashReserveMinor", "necessaryOutflowMinor", "policyHash",
      "policyVersionId", "revision", "version", "workspaceId"
    ].sort());
    const put = await server.request({
      method: "PUT",
      headers: { "Content-Type": "application/json",
        "Idempotency-Key": "policy-put-1",
        "If-Match": '"financial-council-policy:ws-1:1"' },
      body: JSON.stringify(policyInput())
    });
    assert.equal(put.response.status, 200);
    assert.equal(put.response.headers.get("etag"),
      '"financial-council-policy:ws-1:2"');
    assert.equal(updates, 1);
  } finally { await server.close(); }
});

test("policy PUT requires If-Match and exact replay conflicts on changed body",
  async () => {
    let active = policyVersion();
    let updates = 0;
    const server = await listenPolicy({
      async getPolicy() { return active; },
      async updatePolicy() { updates += 1; active = policyVersion(2); return {
        value: active, replayed: false
      }; }
    });
    const put = (body: unknown, ifMatch?: string) => server.request({
      method: "PUT", headers: { "Content-Type": "application/json",
        "Idempotency-Key": "same-policy-key",
        ...(ifMatch ? { "If-Match": ifMatch } : {}) },
      body: JSON.stringify(body)
    });
    try {
      assert.equal((await put(policyInput())).response.status, 428);
      assert.equal((await put(policyInput(),
        '"financial-council-policy:ws-1:1"')).response.status, 200);
      const replay = await put(policyInput(),
        '"financial-council-policy:ws-1:1"');
      assert.equal(replay.response.status, 200);
      assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
      assert.equal(updates, 1);
      const changed = await put(policyInput({ budgetLimitMinor: 40_000 }),
        '"financial-council-policy:ws-1:1"');
      assert.equal(changed.response.status, 409);
      assert.equal(changed.body.code, "idempotency_conflict");
    } finally { await server.close(); }
  });

test("policy route rejects disable flags, timestamps and missing capabilities",
  async () => {
    const service = {
      async getPolicy() { return policyVersion(); },
      async updatePolicy() { return { value: policyVersion(2), replayed: false }; }
    };
    const allowed = await listenPolicy(service);
    const denied = await listenPolicy({
      ...service,
      async updatePolicy() { throw new GrowthAuthorizationError(); }
    }, ["finance.council.run"]);
    const put = (server: Awaited<ReturnType<typeof listenPolicy>>, body: unknown,
      key: string) => server.request({ method: "PUT", headers: {
        "Content-Type": "application/json", "Idempotency-Key": key,
        "If-Match": '"financial-council-policy:ws-1:1"'
      }, body: JSON.stringify(body) });
    try {
      for (const [body, key] of [
        [policyInput({ enforceCash: false }), "disable"],
        [policyInput({ createdAt: NOW }), "timestamp"]
      ] as const) {
        const result = await put(allowed, body, key);
        assert.equal(result.response.status, 422);
        assert.equal(result.body.code, "financial_council_policy_input_invalid");
      }
      assert.equal((await put(denied, policyInput(), "denied")).response.status,
        403);
    } finally { await Promise.all([allowed.close(), denied.close()]); }
  });

function frozenRun() {
  return Object.freeze({
    ...repositoryRunFixture(),
    status: "snapshot_frozen" as const,
    revision: 2,
    snapshotId: "snapshot-1",
    snapshotHash: `sha256:${"d".repeat(64)}` as const,
    updatedAt: NOW
  });
}

async function listen(
  service: Record<string, unknown>,
  httpIdempotency: GrowthHttpIdempotencyRepository
    = new InMemoryGrowthHttpIdempotencyRepository(),
  capabilities: readonly string[] = ["finance.council.run"],
  workspaceId = "ws-1"
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = Object.freeze({
      ...workspace(workspaceId),
      role: "admin" as const,
      capabilities: Object.freeze([...capabilities])
    }) as never;
    next();
  });
  app.use("/api/v1/finance/council-runs", createFinancialCouncilRouter({
    service: service as never,
    workspaceContext(req) { return req.activeWorkspace!; },
    commandContextFactory: commandContextFromRequest,
    httpIdempotency,
    now: () => NOW
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    async request(path: string, init: RequestInit = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const body = response.headers.get("content-type")?.includes("application/json")
        ? await response.json() : await response.text();
      return { response, body };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()))
  };
}

function revisionResult() {
  return Object.freeze({
    runId: "council-run-1",
    revision: 2,
    baseRevision: 1,
    portfolios: Object.freeze([]),
    createdAt: NOW,
    revisionId: `sha256:${"1".repeat(64)}`,
    outputHash: `sha256:${"2".repeat(64)}`
  });
}

function approvalResult(status: "approved" | "rejected") {
  return Object.freeze({
    approvalId: `sha256:${"3".repeat(64)}`,
    runId: "council-run-1",
    portfolioRevision: 2,
    portfolioKind: "balanced" as const,
    status,
    approvedActionIds: status === "approved" ? Object.freeze(["action-1"])
      : Object.freeze([]),
    requiredCapabilities: Object.freeze(["finance.council.approve"]),
    reason: status === "rejected" ? "needs review" : null,
    approvedAt: NOW,
    approvalHash: `sha256:${"4".repeat(64)}`
  });
}

test("portfolio revision route accepts only a closed edit request and returns all recomputed portfolios", async () => {
  const server = await listen({
    async revisePortfolio() { return { value: revisionResult(), replayed: false }; },
    async getRun() { return frozenRun(); },
    async createRun() { return { value: frozenRun(), replayed: false }; },
    async listEvents() { return []; }
  });
  try {
    const result = await server.request(
      "/api/v1/finance/council-runs/council-run-1/portfolio-revisions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "Idempotency-Key": "edit-1",
          "If-Match": '"financial-council-run:council-run-1:2"'
        },
        body: JSON.stringify({
          baseRevision: 1,
          operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
        })
      }
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      runId: "council-run-1", revision: 2, baseRevision: 1,
      portfolios: [], createdAt: NOW
    });
    assert.equal(result.response.headers.get("etag"),
      '"financial-council-run:council-run-1:2"');
  } finally { await server.close(); }
});

test("approval and rejection bind the selected portfolio and expose only public decisions", async () => {
  const server = await listen({
    async approve() { return { value: approvalResult("approved"), replayed: false }; },
    async reject() { return { value: approvalResult("rejected"), replayed: false }; },
    async getRun() { return frozenRun(); },
    async createRun() { return { value: frozenRun(), replayed: false }; },
    async listEvents() { return []; }
  }, undefined, ["finance.council.run", "finance.council.approve"]);
  const headers = {
    "Content-Type": "application/json", "If-Match":
      '"financial-council-run:council-run-1:2"'
  };
  try {
    const approved = await server.request(
      "/api/v1/finance/council-runs/council-run-1/portfolio-revisions/2/approve", {
        method: "POST", headers: { ...headers, "Idempotency-Key": "approve-1" },
        body: JSON.stringify({ portfolioKind: "balanced" })
      }
    );
    assert.equal(approved.response.status, 202);
    assert.deepEqual(approved.body, {
      approvalId: `sha256:${"3".repeat(64)}`, runId: "council-run-1",
      portfolioRevision: 2, portfolioKind: "balanced", status: "approved",
      approvedActionIds: ["action-1"],
      requiredCapabilities: ["finance.council.approve"], reason: null,
      approvedAt: NOW
    });
    assert.equal("approvalHash" in approved.body, false);

    const rejected = await server.request(
      "/api/v1/finance/council-runs/council-run-1/reject", {
        method: "POST", headers: { ...headers, "Idempotency-Key": "reject-1" },
        body: JSON.stringify({
          portfolioRevision: 2, portfolioKind: "balanced", reason: "needs review"
        })
      }
    );
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.status, "rejected");
    assert.equal(rejected.body.reason, "needs review");
  } finally { await server.close(); }
});

test("dispatch polling exposes nonterminal operation state without worker fences or hashes", async () => {
  const server = await listen({
    async listDispatches() {
      return [{
        dispatchId: `sha256:${"5".repeat(64)}`, runId: "council-run-1",
        approvalId: `sha256:${"3".repeat(64)}`, portfolioRevision: 2,
        portfolioKind: "balanced", actionId: "action-1", status: "retry",
        attempt: 2, receiptId: null, lastErrorCode: "dispatch_retryable",
        createdAt: NOW, updatedAt: NOW
      }];
    },
    async getRun() { return frozenRun(); },
    async createRun() { return { value: frozenRun(), replayed: false }; },
    async listEvents() { return []; }
  });
  try {
    const result = await server.request(
      "/api/v1/finance/council-runs/council-run-1/dispatches"
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      items: [{
        dispatchId: `sha256:${"5".repeat(64)}`, runId: "council-run-1",
        approvalId: `sha256:${"3".repeat(64)}`, portfolioRevision: 2,
        portfolioKind: "balanced", actionId: "action-1", status: "retry",
        attempt: 2, receiptId: null, lastErrorCode: "dispatch_retryable",
        createdAt: NOW, updatedAt: NOW
      }], nextAfter: null, hasMore: false
    });
    assert.equal(result.response.headers.get("cache-control"), "no-store");
  } finally { await server.close(); }
});

test("P4 route payloads conform to the closed financial council runtime schemas", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/financial-council.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", true);
  ajv.addSchema(schema);
  const input = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilPortfolioRevisionInput`
  });
  const revision = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilPortfolioRevisionView`
  });
  const approval = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilApprovalInput`
  });
  const rejection = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilRejectInput`
  });
  const dispatches = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilDispatchPagedResult`
  });
  assert.equal(input({
    baseRevision: 1,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  }), true, JSON.stringify(input.errors));
  assert.equal(revision({
    runId: "council-run-1", revision: 2, baseRevision: 1,
    portfolios: [], createdAt: NOW
  }), true, JSON.stringify(revision.errors));
  assert.equal(approval({ portfolioKind: "balanced" }), true,
    JSON.stringify(approval.errors));
  assert.equal(rejection({
    portfolioRevision: 2, portfolioKind: "balanced", reason: "needs review"
  }), true, JSON.stringify(rejection.errors));
  assert.equal(dispatches({
    items: [{
      dispatchId: `sha256:${"5".repeat(64)}`, runId: "council-run-1",
      approvalId: `sha256:${"3".repeat(64)}`, portfolioRevision: 2,
      portfolioKind: "balanced", actionId: "action-1", status: "running",
      attempt: 1, receiptId: null, lastErrorCode: null,
      createdAt: NOW, updatedAt: NOW
    }], nextAfter: null, hasMore: false
  }), true, JSON.stringify(dispatches.errors));
});

test("real mounted P4 responses conform to the immutable 1.0.10 release", async () => {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.contractVersion, "1.0.10");
  const components = structuredClone((release.document as {
    components: { schemas: Record<string, Record<string, unknown>> };
  }).components);
  for (const schema of Object.values(components.schemas)) delete schema.$id;
  const root = { $schema: "https://json-schema.org/draft/2020-12/schema", components };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", true);
  const validate = (name: string, value: unknown) => {
    const check = ajv.compile({ ...root, $ref: `#/components/schemas/${name}` });
    assert.equal(check(value), true, `${name}: ${JSON.stringify(check.errors)}`);
  };
  const server = await listen({
    async revisePortfolio() { return { value: revisionResult(), replayed: false }; },
    async approve() { return { value: approvalResult("approved"), replayed: false }; },
    async getRun() { return frozenRun(); },
    async listDispatches() { return [{
      dispatchId: `sha256:${"5".repeat(64)}`, runId: "council-run-1",
      approvalId: `sha256:${"3".repeat(64)}`, portfolioRevision: 2,
      portfolioKind: "balanced", actionId: "action-1", status: "retry",
      attempt: 2, receiptId: null, lastErrorCode: "dispatch_retryable",
      createdAt: NOW, updatedAt: NOW
    }]; }
  }, undefined, ["finance.council.run", "finance.council.approve"]);
  try {
    const headers = { "Content-Type": "application/json", "If-Match":
      '"financial-council-run:council-run-1:2"' };
    const revised = await server.request("/api/v1/finance/council-runs/council-run-1/portfolio-revisions", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "release-revise" },
      body: JSON.stringify({ baseRevision: 1, operations: [
        { kind: "select_portfolio", portfolioKind: "balanced" }
      ] })
    });
    assert.equal(revised.response.status, 200);
    validate("FinancialCouncilPortfolioRevision", revised.body);
    const approved = await server.request("/api/v1/finance/council-runs/council-run-1/portfolio-revisions/2/approve", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "release-approve" },
      body: JSON.stringify({ portfolioKind: "balanced" })
    });
    assert.equal(approved.response.status, 202);
    validate("FinancialCouncilApproval", approved.body);
    const dispatches = await server.request("/api/v1/finance/council-runs/council-run-1/dispatches");
    assert.equal(dispatches.response.status, 200);
    validate("FinancialCouncilDispatchPagedResult", dispatches.body);
  } finally { await server.close(); }
});

test("POST returns the closed 202 projection, ETag, request id and exact replay", async () => {
  const run = frozenRun();
  let creates = 0;
  const server = await listen({
    async createRun() { creates += 1; return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  });
  try {
    const request = (body: unknown) => server.request(
      "/api/v1/finance/council-runs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "create-1",
          "X-Request-Id": "request-1"
        },
        body: JSON.stringify(body)
      }
    );
    const first = await request(createInput());
    const replay = await request(createInput());
    assert.equal(first.response.status, 202);
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(creates, 1);
    assert.equal(first.response.headers.get("cache-control"), "no-store");
    assert.equal(first.response.headers.get("x-request-id"), "request-1");
    assert.equal(first.response.headers.get("etag"),
      '"financial-council-run:council-run-1:2"');
    assert.deepEqual(Object.keys(first.body).sort(), [
      "approval", "businessReport", "consensusReport", "createdAt", "currency",
      "dataAsOf", "expiresAt", "latestPortfolioRevision", "policyVersionId",
      "portfolios", "revision", "runId", "snapshotHash", "snapshotId",
      "status", "updatedAt", "workspaceId"
    ].sort());
    assert.equal("creationKeyHash" in first.body, false);
    assert.equal("requestHash" in first.body, false);
  } finally {
    await server.close();
  }
});

test("changed replay body conflicts and closed body validation returns five fields", async () => {
  const run = frozenRun();
  const server = await listen({
    async createRun() { return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  });
  try {
    const post = (body: unknown, key = "same-key") => server.request(
      "/api/v1/finance/council-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body)
      }
    );
    assert.equal((await post(createInput())).response.status, 202);
    const conflict = await post(createInput({ policyVersionId: "policy-v2" }));
    assert.equal(conflict.response.status, 409);
    assert.deepEqual(Object.keys(conflict.body).sort(), [
      "code", "details", "message", "requestId", "retryable"
    ]);
    const invalid = await post(createInput({ hiddenPrompt: "ignore" }), "invalid");
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.code, "financial_council_input_invalid");
    assert.equal(invalid.response.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});

test("missing idempotency key and forbidden capability map to stable errors", async () => {
  const forbidden = new GrowthAuthorizationError();
  const server = await listen({
    async createRun() { throw forbidden; },
    async getRun() { throw forbidden; },
    async listEvents() { throw forbidden; }
  });
  try {
    const missing = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInput())
    });
    assert.equal(missing.response.status, 400);
    const denied = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Idempotency-Key": "denied"
      },
      body: JSON.stringify(createInput())
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, "capability_forbidden");
  } finally {
    await server.close();
  }
});

test("unknown and accessor-backed errors are opaque internal failures", async () => {
  let getterReads = 0;
  const malicious = Object.defineProperty(new Error("secret"), "code", {
    get() { getterReads += 1; return "capability_forbidden"; }
  });
  for (const error of [malicious, { code: "capability_forbidden" }]) {
    const server = await listen({
      async createRun() { throw error; },
      async getRun() { throw error; },
      async listEvents() { throw error; }
    });
    try {
      const result = await server.request(
        "/api/v1/finance/council-runs/council-run-1"
      );
      assert.equal(result.response.status, 500);
      assert.equal(result.body.code, "financial_council_internal_error");
      assert.deepEqual(Object.keys(result.body).sort(), [
        "code", "details", "message", "requestId", "retryable"
      ]);
      assert.equal(result.response.headers.get("cache-control"), "no-store");
    } finally {
      await server.close();
    }
  }
  assert.equal(getterReads, 0);
});

test("HTTP idempotency persistence sees only a domain-separated derived key", async () => {
  const run = frozenRun();
  const reservations: unknown[] = [];
  const repository: GrowthHttpIdempotencyRepository = {
    async reserve(input) {
      reservations.push(structuredClone(input));
      return {
        kind: "claimed", reservationId: "reservation-1",
        leaseOwner: input.leaseOwner, leaseExpiresAt: NOW, fencingToken: 1
      };
    },
    async complete() {},
    async release() {}
  };
  const server = await listen({
    async createRun() { return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  }, repository);
  const raw = "raw-council-key-must-not-persist";
  try {
    const result = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": raw },
      body: JSON.stringify(createInput())
    });
    assert.equal(result.response.status, 202);
    const visible = JSON.stringify(reservations);
    assert.equal(visible.includes(raw), false);
    assert.match(visible,
      /financial-council:http:sha256:[0-9a-f]{64}/u);
  } finally {
    await server.close();
  }
});

test("real router request and 202 response conform to the council schema", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/financial-council.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", true);
  ajv.addSchema(schema);
  const validateRequest = ajv.compile({
    $ref: `${schema.$id}#/$defs/FinancialCouncilCreateInput`
  });
  const validateResponse = ajv.getSchema(schema.$id)!;
  const run = frozenRun();
  const server = await listen({
    async createRun() { return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  });
  try {
    const body = createInput();
    assert.equal(validateRequest(body), true, JSON.stringify(validateRequest.errors));
    const result = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "ajv" },
      body: JSON.stringify(body)
    });
    assert.equal(result.response.status, 202);
    assert.equal(validateResponse(result.body), true,
      JSON.stringify(validateResponse.errors));
    assert.equal(validateResponse({ ...result.body, status: "created" }), false);
    assert.equal(validateResponse({
      ...result.body, status: "created", snapshotId: null, snapshotHash: null
    }), false);
  } finally {
    await server.close();
  }
});

test("real repository through service never publishes migration-only created", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/financial-council.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", true);
  const validateRun = ajv.compile(schema);
  const repository = new InMemoryFinancialCouncilRepository();
  const internal = repositoryRunFixture();
  await repository.createRun({
    workspace: Object.freeze({
      ...workspace(), role: "admin" as const,
      capabilities: Object.freeze(["finance.council.run"])
    }) as never,
    actorId: "manager-1",
    idempotencyKey: "migration-create",
    requestHash: internal.requestHash,
    expectedRevision: null
  }, internal);
  const service = new FinancialCouncilService({
    repository,
    snapshotBuilder: { async freeze() { throw new Error("unused"); } }
  });
  const server = await listen(service as unknown as Record<string, unknown>);
  try {
    const result = await server.request(
      `/api/v1/finance/council-runs/${internal.runId}`
    );
    assert.equal(result.response.status, 500);
    assert.equal(result.body.code, "financial_council_internal_error");
    assert.equal(validateRun(result.body), false);
    assert.deepEqual(Object.keys(result.body).sort(), [
      "code", "details", "message", "requestId", "retryable"
    ]);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});

test("runtime rejects policy IDs beyond the published 255-character bound", async () => {
  const run = frozenRun();
  const server = await listen({
    async createRun() { return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  });
  try {
    const result = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "long" },
      body: JSON.stringify(createInput({ policyVersionId: "p".repeat(256) }))
    });
    assert.equal(result.response.status, 422);
  } finally {
    await server.close();
  }
});

test("runtime create text bounds count Unicode code points like JSON Schema", async () => {
  const run = frozenRun();
  const server = await listen({
    async createRun() { return { value: run, replayed: false }; },
    async getRun() { return run; },
    async listEvents() { return []; }
  });
  try {
    const atBoundary = createInput({
      policyVersionId: "💰".repeat(255),
      businessReport: {
        ...createInput().businessReport,
        companyName: "💰".repeat(4_000)
      }
    });
    const accepted = await server.request("/api/v1/finance/council-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "unicode-ok" },
      body: JSON.stringify(atBoundary)
    });
    assert.equal(accepted.response.status, 202);

    for (const [key, body] of [
      ["unicode-policy-long", createInput({
        policyVersionId: "💰".repeat(256)
      })],
      ["unicode-report-long", createInput({
        businessReport: {
          ...createInput().businessReport,
          companyName: "💰".repeat(4_001)
        }
      })]
    ] as const) {
      const rejected = await server.request("/api/v1/finance/council-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body)
      });
      assert.equal(rejected.response.status, 422);
    }
  } finally {
    await server.close();
  }
});

test("GET tenant isolation is 404 and events use the Task 1 page envelope", async () => {
  const run = frozenRun();
  const notFound = financialCouncilError("financial_council_run_not_found");
  const service = {
    async createRun() { return { value: run, replayed: false }; },
    async getRun(context: { workspaceId: string }) {
      if (context.workspaceId !== run.workspaceId) throw notFound;
      return run;
    },
    async listEvents(context: { workspaceId: string }) {
      if (context.workspaceId !== run.workspaceId) throw notFound;
      return [{
        eventId: "council-run-1:2", runId: run.runId, revision: 2,
        fromStatus: "created", toStatus: "snapshot_frozen",
        reasonCode: null, occurredAt: NOW,
        workspaceId: run.workspaceId, actorId: "admin-1",
        aggregateSnapshotHash: run.snapshotHash,
        aggregateSnapshot: run
      }];
    }
  };
  const server = await listen(service);
  const hiddenServer = await listen(service, undefined, undefined, "ws-2");
  try {
    const found = await server.request(
      "/api/v1/finance/council-runs/council-run-1"
    );
    assert.equal(found.response.status, 200);
    assert.equal(found.response.headers.get("etag"),
      '"financial-council-run:council-run-1:2"');
    const events = await server.request(
      "/api/v1/finance/council-runs/council-run-1/events"
    );
    assert.deepEqual(events.body, {
      items: [{
        eventId: "council-run-1:2", runId: "council-run-1", revision: 2,
        fromStatus: "created", toStatus: "snapshot_frozen",
        reasonCode: null, occurredAt: NOW
      }],
      nextAfter: null,
      hasMore: false
    });
    const hidden = await hiddenServer.request("/api/v1/finance/council-runs/council-run-1");
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.body.code, "financial_council_run_not_found");
  } finally {
    await Promise.all([server.close(), hiddenServer.close()]);
  }
});
