import { strict as assert } from "node:assert";
import {
  CouncilApiValidationError,
  createFinancialCouncilApi
} from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];

const run = Object.freeze({
  runId: "run-1",
  workspaceId: "workspace-1",
  currency: "CNY",
  status: "analyzing",
  revision: 2,
  dataAsOf: "2026-08-16T08:00:00.000Z",
  businessReport: {},
  policyVersionId: "policy-1",
  snapshotId: "snapshot-1",
  snapshotHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  consensusReport: null,
  portfolios: [],
  latestPortfolioRevision: null,
  approval: null,
  createdAt: "2026-08-16T08:00:00.000Z",
  updatedAt: "2026-08-16T08:00:00.000Z",
  expiresAt: "2026-08-16T09:00:00.000Z"
});

const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    const body = path.includes("/portfolio-revisions")
      ? {
          runId: "run-1",
          revision: 3,
          baseRevision: 2,
          portfolios: [],
          createdAt: "2026-08-16T08:00:00.000Z"
        }
      : run;
    return {
      status: path === "/api/v1/finance/council-runs" ? 202 : 200,
      etag: '"financial-council-run:run-1:2"',
      body
    } as never;
  }
};

const api = createFinancialCouncilApi(http);

await api.createRun({
  currency: "CNY",
  dataAsOf: "2026-08-16T08:00:00.000Z",
  businessReport: {} as never,
  policyVersionId: "policy-1",
  workspaceId: "must-not-cross-the-browser-boundary",
  impacts: { cashMinor: 1 }
} as never, "council-create:key-1");

assert.equal(calls[0]?.path, "/api/v1/finance/council-runs");
assert.deepEqual(calls[0]?.options, {
  method: "POST",
  idempotencyKey: "council-create:key-1",
  body: {
    currency: "CNY",
    dataAsOf: "2026-08-16T08:00:00.000Z",
    businessReport: {},
    policyVersionId: "policy-1"
  }
});

await api.revisePortfolio("run / 1", {
  baseRevision: 2,
  operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }],
  impacts: { profitMinor: 9 }
} as never, '"financial-council-run:run-1:2"', "council-revise:key-1");
assert.equal(
  calls[1]?.path,
  "/api/v1/finance/council-runs/run%20%2F%201/portfolio-revisions"
);
assert.deepEqual(calls[1]?.options, {
  method: "POST",
  ifMatch: '"financial-council-run:run-1:2"',
  idempotencyKey: "council-revise:key-1",
  body: {
    baseRevision: 2,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  }
});

const malformed: GrowthHttpClient = {
  async request() {
    return {
      status: 200,
      etag: null,
      body: { ...run, status: "forged_status", leaked: true }
    } as never;
  }
};

await assert.rejects(
  createFinancialCouncilApi(malformed).getRun("run-1"),
  (error: unknown) => error instanceof CouncilApiValidationError
    && error.code === "financial_council_response_invalid"
);

const lifecycle = await createFinancialCouncilApi({
  async request() {
    return {
      status: 200,
      etag: null,
      body: {
        items: [{
          eventId: "run-1:1",
          runId: "run-1",
          revision: 1,
          fromStatus: null,
          toStatus: "created",
          reasonCode: null,
          occurredAt: "2026-08-16T08:00:00.000Z"
        }],
        nextAfter: null,
        hasMore: false
      }
    } as never;
  }
} as GrowthHttpClient).listEvents("run-1");
assert.equal(lifecycle.body.items[0]?.toStatus, "created");
