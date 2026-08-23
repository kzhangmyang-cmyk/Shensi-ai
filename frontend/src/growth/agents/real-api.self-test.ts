import { strict as assert } from "node:assert";
import {
  createRealAgentCenterApi,
  RealAgentCenterApiValidationError
} from "./real-api";
import { GrowthApiError } from "../http";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";

const route = Object.freeze({
  mode: "auto",
  primaryConnectionId: null,
  fallbackConnectionIds: [],
  preferenceWeightBps: 0
});
const routingInput = Object.freeze({
  maxRoleBudgetMinor: 1_000,
  maxRunBudgetMinor: 6_000,
  requestTimeoutMs: 30_000,
  roles: {
    cfo: route, finance: route, profit: route,
    cost: route, cashflow: route, tax: route
  }
});
const routingPolicy = Object.freeze({
  ...routingInput,
  policyVersionId: "routing-policy-1",
  revision: 2,
  createdAt: "2026-08-23T00:00:00.000Z"
});
const selectedConnection = Object.freeze({
  connectionId: "connection-1",
  displayName: "OpenAI 生产",
  model: "gpt-5",
  provider: "openai"
});
const routePreview = Object.freeze({
  role: "finance",
  selectedConnection,
  orderedConnections: [selectedConnection],
  reasonCodes: ["structured_output_certified"],
  missingCapabilities: []
});
const agentCenter = Object.freeze({
  capabilities: { canApprove: true, canManageRouting: true, canRun: true },
  data: {
    status: "ready",
    packageId: "package-1",
    companyName: "示例公司",
    period: "2026-07",
    verifiedAt: "2026-08-23T00:00:00.000Z",
    warningCodes: []
  },
  models: {
    status: "ready",
    routingPolicyVersionId: "routing-policy-1",
    roles: []
  },
  latestRun: null
});
const runAgents = Object.freeze({
  runId: "run-1",
  revision: 1,
  status: "snapshot_frozen",
  updatedAt: "2026-08-23T00:00:00.000Z",
  roles: []
});
const sources = Object.freeze([
  source("balance_sheet", "balance.xlsx"),
  source("income_statement", "income.xlsx"),
  source("cash_flow_statement", "cashflow.xlsx")
]);
const statementPreview = Object.freeze({
  previewId: "preview-1",
  status: "preview",
  companyName: "示例公司",
  period: "2026-07",
  currency: "CNY",
  parserVersion: "financial-statements.v2",
  sourceFiles: sources,
  warningCodes: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T00:30:00.000Z"
});
const statementPackage = Object.freeze({
  packageId: "package-1",
  status: "verified",
  companyName: "示例公司",
  period: "2026-07",
  currency: "CNY",
  parserVersion: "financial-statements.v2",
  sourceFiles: sources,
  warningCodes: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  expiresAt: null
});
const run = Object.freeze({
  runId: "run-1",
  workspaceId: "workspace-1",
  currency: "CNY",
  status: "snapshot_frozen",
  revision: 1,
  dataAsOf: "2026-08-23T00:00:00.000Z",
  businessReport: {},
  policyVersionId: "routing-policy-1",
  snapshotId: "snapshot-1",
  snapshotHash: `sha256:${"a".repeat(64)}`,
  consensusReport: null,
  portfolios: [],
  latestPortfolioRevision: null,
  approval: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T01:00:00.000Z"
});

function source(kind: string, fileName: string) {
  return Object.freeze({
    kind,
    fileName,
    fileHash: `sha256:${"b".repeat(64)}`,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sheetNames: ["Sheet1"]
  });
}

function upload(kind: string, fileName: string, contentBase64: string) {
  return {
    kind,
    fileName,
    contentBase64,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workspaceId: "must-not-cross",
    apiKey: "must-not-cross"
  };
}

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const responseByPath = new Map<string, unknown>([
  ["/api/v1/finance/council-agent-center", agentCenter],
  ["/api/v1/finance/council-runs/run%20%2F%201/agents", runAgents],
  ["/api/v1/finance/council-model-routing-policy", routingPolicy],
  ["/api/v1/finance/council-model-routing-policy/preview", { roles: [routePreview] }],
  ["/api/v1/finance/statement-packages/preview", statementPreview],
  ["/api/v1/finance/statement-packages/preview%20%2F%201/commit", statementPackage],
  ["/api/v1/finance/council-runs", run]
]);
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      status: path.includes("/commit") ? 201 : path.endsWith("council-runs") ? 202 : 200,
      etag: path === "/api/v1/finance/council-model-routing-policy"
        ? '"opaque-routing-etag"' : null,
      body: responseByPath.get(path)
    } as never;
  }
};
const api = createRealAgentCenterApi(http);
const signal = new AbortController().signal;

await api.getAgentCenter(signal);
await api.getRunAgents("run / 1", signal);
await api.getRoutingPolicy(signal);
await api.previewRouting("routing-preview-key", signal);
await api.updateRouting({
  ...routingInput,
  workspaceId: "must-not-cross",
  capabilities: ["must-not-cross"],
  roles: {
    ...routingInput.roles,
    finance: { ...route, apiKey: "raw-secret", arbitraryModelBody: { prompt: "no" } }
  }
} as never, '"opaque-routing-etag"', "routing-update-key", signal);
await api.previewStatements({
  statements: [
    upload("balance_sheet", "balance.xlsx", "YmFsYW5jZQ=="),
    upload("income_statement", "income.xlsx", "aW5jb21l"),
    upload("cash_flow_statement", "cashflow.xlsx", "Y2FzaGZsb3c=")
  ],
  workspaceId: "must-not-cross",
  actorId: "must-not-cross"
} as never, "statement-preview-key", signal);
await api.commitStatements("preview / 1", {
  consent: {
    accepted: true,
    noticeVersion: "financial-model-data.v1",
    actorId: "must-not-cross"
  },
  workspaceId: "must-not-cross"
} as never, "statement-commit-key", signal);
await api.createRunFromPackage({
  statementPackageId: "package-1",
  policyVersionId: "routing-policy-1",
  businessReport: { must: "not cross" },
  workspaceId: "must-not-cross"
} as never, "run-create-key", signal);

assert.deepEqual(calls, [
  { path: "/api/v1/finance/council-agent-center", options: { signal } },
  { path: "/api/v1/finance/council-runs/run%20%2F%201/agents", options: { signal } },
  { path: "/api/v1/finance/council-model-routing-policy", options: { signal } },
  {
    path: "/api/v1/finance/council-model-routing-policy/preview",
    options: { method: "POST", body: {}, idempotencyKey: "routing-preview-key", signal }
  },
  {
    path: "/api/v1/finance/council-model-routing-policy",
    options: {
      method: "PUT", body: routingInput, ifMatch: '"opaque-routing-etag"',
      idempotencyKey: "routing-update-key", signal
    }
  },
  {
    path: "/api/v1/finance/statement-packages/preview",
    options: {
      method: "POST", idempotencyKey: "statement-preview-key", signal,
      body: {
        statements: [
          publicUpload("balance_sheet", "balance.xlsx", "YmFsYW5jZQ=="),
          publicUpload("income_statement", "income.xlsx", "aW5jb21l"),
          publicUpload("cash_flow_statement", "cashflow.xlsx", "Y2FzaGZsb3c=")
        ]
      }
    }
  },
  {
    path: "/api/v1/finance/statement-packages/preview%20%2F%201/commit",
    options: {
      method: "POST", idempotencyKey: "statement-commit-key", signal,
      body: { consent: { accepted: true, noticeVersion: "financial-model-data.v1" } }
    }
  },
  {
    path: "/api/v1/finance/council-runs",
    options: {
      method: "POST", idempotencyKey: "run-create-key", signal,
      body: { statementPackageId: "package-1", policyVersionId: "routing-policy-1" }
    }
  }
]);

function publicUpload(kind: string, fileName: string, contentBase64: string) {
  return {
    kind, fileName, contentBase64,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };
}

for (const status of [400, 401, 403, 409, 412]) {
  const failure = new GrowthApiError(status, `safe_${status}`, "request-1");
  const failing = createRealAgentCenterApi({
    async request() { throw failure; }
  });
  await assert.rejects(
    failing.updateRouting(routingInput as never, '"etag"', "semantic-key"),
    (error: unknown) => error === failure
  );
}

const malformed = createRealAgentCenterApi({
  async request() {
    return { status: 200, etag: null, body: { ...agentCenter, leaked: true } } as never;
  }
});
await assert.rejects(
  malformed.getAgentCenter(),
  (error: unknown) => error instanceof RealAgentCenterApiValidationError
    && error.code === "financial_council_response_invalid"
);

await assert.rejects(
  createRealAgentCenterApi({
    async request() {
      return {
        status: 200,
        etag: '"etag"',
        body: { ...routingPolicy, leakedModelBody: { prompt: "secret" } }
      } as never;
    }
  }).getRoutingPolicy(),
  (error: unknown) => error instanceof RealAgentCenterApiValidationError
    && error.code === "financial_council_response_invalid"
);

await assert.rejects(
  api.previewStatements({
    statements: [
      publicUpload("balance_sheet", "a.xlsx", "YQ=="),
      publicUpload("balance_sheet", "b.xlsx", "Yg=="),
      publicUpload("cash_flow_statement", "c.xlsx", "Yw==")
    ]
  } as never, "duplicate-key"),
  /financial_council_request_invalid/u
);
