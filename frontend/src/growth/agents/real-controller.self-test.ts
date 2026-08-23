import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import {
  createRealAgentCenterController,
  type RealAgentCenterControllerOptions
} from "./real-controller";
import type { RealAgentCenterApi } from "./real-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfil, fail) => { resolve = fulfil; reject = fail; });
  return { promise, resolve, reject };
}

const roles = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;
const autoRoute = Object.freeze({
  mode: "auto", primaryConnectionId: null, fallbackConnectionIds: [], preferenceWeightBps: 0
});
const routingInput = Object.freeze({
  maxRoleBudgetMinor: 1_000, maxRunBudgetMinor: 6_000, requestTimeoutMs: 30_000,
  roles: { cfo: autoRoute, finance: autoRoute, profit: autoRoute, cost: autoRoute, cashflow: autoRoute, tax: autoRoute }
});
const policy = Object.freeze({
  ...routingInput, policyVersionId: "policy-1", revision: 1,
  createdAt: "2026-08-23T00:00:00.000Z"
});
const councilPolicy = Object.freeze({ policyVersionId: "formula-policy-1" });
const center = Object.freeze({
  capabilities: { canApprove: true, canManageRouting: true, canRun: true },
  data: { status: "not_connected", packageId: null, companyName: null, period: null, verifiedAt: null, warningCodes: [] },
  models: { status: "ready", routingPolicyVersionId: "policy-1", roles: [] },
  latestRun: null
});
const connection = Object.freeze({ connectionId: "connection-1", displayName: "OpenAI", model: "gpt-5", provider: "openai" });
const previews = roles.map((role) => Object.freeze({
  role, selectedConnection: connection, orderedConnections: [connection],
  reasonCodes: ["structured_output_certified"], missingCapabilities: []
}));
const sourceFiles = [
  source("balance_sheet", "balance.xlsx"),
  source("income_statement", "income.xlsx"),
  source("cash_flow_statement", "cashflow.xlsx")
];
const preview = Object.freeze({
  previewId: "preview-1", status: "preview", companyName: "公司", period: "2026-07", currency: "CNY",
  parserVersion: "financial-statements.v2", sourceFiles, warningCodes: ["period_requires_review"],
  createdAt: "2026-08-23T00:00:00.000Z", expiresAt: "2026-08-23T00:30:00.000Z"
});
const statementPackage = Object.freeze({
  packageId: "package-1", status: "verified", companyName: "公司", period: "2026-07", currency: "CNY",
  parserVersion: "financial-statements.v2", sourceFiles, warningCodes: ["period_requires_review"],
  createdAt: "2026-08-23T00:00:00.000Z", expiresAt: null
});
const councilRun = Object.freeze({
  runId: "run-1", workspaceId: "workspace-1", currency: "CNY", status: "snapshot_frozen", revision: 1,
  dataAsOf: "2026-08-23T00:00:00.000Z", businessReport: {}, policyVersionId: "policy-1",
  snapshotId: "snapshot-1", snapshotHash: `sha256:${"a".repeat(64)}`, consensusReport: null,
  portfolios: [], latestPortfolioRevision: null, approval: null,
  createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T01:00:00.000Z"
});
const runAgents = Object.freeze({
  runId: "run-1", revision: 1, status: "snapshot_frozen", updatedAt: "2026-08-23T00:00:00.000Z", roles: []
});

function source(kind: string, fileName: string) {
  return Object.freeze({ kind, fileName, fileHash: `sha256:${"b".repeat(64)}`,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sheetNames: ["Sheet1"] });
}

function file(name: string, value: string): File {
  return new File([value], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    lastModified: 1_777_777
  });
}

async function settleLoad(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function apiFixture(overrides: Partial<RealAgentCenterApi> = {}) {
  const calls = {
    previewKeys: [] as string[], commitKeys: [] as string[], createKeys: [] as string[],
    createInputs: [] as unknown[],
    updateKeys: [] as string[], previewStatements: 0, commitStatements: 0,
    createRunFromPackage: 0, updateRouting: 0
  };
  const api: RealAgentCenterApi = {
    async getAgentCenter() { return { status: 200, etag: null, body: center } as never; },
    async getRunAgents() { return { status: 200, etag: null, body: runAgents } as never; },
    async getCouncilPolicy() { return { status: 200, etag: null, body: councilPolicy } as never; },
    async getRoutingPolicy() { return { status: 200, etag: '"opaque-policy-etag"', body: policy } as never; },
    async previewRouting(key) { calls.previewKeys.push(key); return { status: 200, etag: null, body: previews } as never; },
    async updateRouting(_input, _etag, key) { calls.updateRouting += 1; calls.updateKeys.push(key); return { status: 200, etag: '"next-etag"', body: policy } as never; },
    async previewStatements(_input, key) { calls.previewStatements += 1; calls.previewKeys.push(key); return { status: 200, etag: null, body: preview } as never; },
    async commitStatements(_previewId, _input, key) { calls.commitStatements += 1; calls.commitKeys.push(key); return { status: 201, etag: null, body: statementPackage } as never; },
    async createRunFromPackage(input, key) {
      calls.createRunFromPackage += 1; calls.createKeys.push(key);
      calls.createInputs.push(input);
      return { status: 202, etag: null, body: councilRun } as never;
    },
    ...overrides
  };
  return { api, calls };
}

async function selectAll(controller: ReturnType<typeof createRealAgentCenterController>) {
  await controller.selectStatement("balance_sheet", file("balance.xlsx", "balance"));
  await controller.selectStatement("income_statement", file("income.xlsx", "income"));
  await controller.selectStatement("cash_flow_statement", file("cashflow.xlsx", "cashflow"));
}

// End-to-end controller progression catches fallback to legacy businessReport creation.
{
  const { api, calls } = apiFixture();
  const controller = createRealAgentCenterController({ api, idFactory: sequenceIds() });
  await settleLoad();
  await selectAll(controller);
  await controller.previewStatements();
  assert.deepEqual(controller.getState().statementPreview?.warningCodes, ["period_requires_review"]);
  controller.acceptModelDataNotice(true);
  await controller.commitStatements();
  assert.equal(controller.getState().files.balance_sheet?.name, "balance.xlsx");
  await controller.previewStatements();
  assert.equal(calls.previewStatements, 1);
  assert.equal(controller.getState().error, "financial_statement_files_required");
  await controller.startCouncil();
  assert.equal(controller.getState().statementPackage?.status, "verified");
  assert.equal(controller.getState().latestRun?.status, "snapshot_frozen");
  assert.equal(controller.getState().runAgents?.runId, "run-1");
  assert.equal(calls.createRunFromPackage, 1);
  assert.deepEqual(calls.createInputs, [{
    statementPackageId: "package-1",
    policyVersionId: "formula-policy-1"
  }]);
  controller.destroy();
}

// Missing files and rejected consent are closed before transport.
{
  const { api, calls } = apiFixture();
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  await controller.previewStatements();
  assert.equal(controller.getState().error, "financial_statement_files_required");
  assert.equal(calls.previewStatements, 0);
  await selectAll(controller);
  await controller.previewStatements();
  await controller.commitStatements();
  assert.equal(controller.getState().error, "financial_model_data_consent_required");
  assert.equal(calls.commitStatements, 0);
  controller.destroy();
}

// Failed preview creates no package; retry of ambiguous commit/create reuses semantic keys.
{
  let previewAttempts = 0;
  let commitAttempts = 0;
  let createAttempts = 0;
  const { api, calls } = apiFixture({
    async previewStatements(_input, key) {
      calls.previewStatements += 1; calls.previewKeys.push(key); previewAttempts += 1;
      if (previewAttempts === 1) throw new TypeError("network dropped after response");
      return { status: 200, etag: null, body: preview } as never;
    },
    async commitStatements(_previewId, _input, key) {
      calls.commitStatements += 1; calls.commitKeys.push(key); commitAttempts += 1;
      if (commitAttempts === 1) throw new TypeError("network dropped after commit");
      return { status: 201, etag: null, body: statementPackage } as never;
    },
    async createRunFromPackage(_input, key) {
      calls.createRunFromPackage += 1; calls.createKeys.push(key); createAttempts += 1;
      if (createAttempts === 1) throw new TypeError("network dropped after create");
      return { status: 202, etag: null, body: councilRun } as never;
    }
  });
  const controller = createRealAgentCenterController({ api, idFactory: sequenceIds() });
  await settleLoad();
  await selectAll(controller);
  await controller.previewStatements();
  assert.equal(controller.getState().statementPackage, null);
  await controller.previewStatements();
  controller.acceptModelDataNotice(true);
  await controller.commitStatements();
  await controller.commitStatements();
  await controller.startCouncil();
  await controller.startCouncil();
  assert.equal(calls.previewKeys.at(-2), calls.previewKeys.at(-1));
  assert.deepEqual(calls.commitKeys, [calls.commitKeys[0], calls.commitKeys[0]]);
  assert.deepEqual(calls.createKeys, [calls.createKeys[0], calls.createKeys[0]]);
  controller.destroy();
}

// Identical concurrent mutation joins one transport request.
{
  const pending = deferred<never>();
  const { api, calls } = apiFixture({
    async previewStatements(_input, key) {
      calls.previewStatements += 1; calls.previewKeys.push(key);
      return pending.promise;
    }
  });
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  await selectAll(controller);
  const first = controller.previewStatements();
  const second = controller.previewStatements();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.previewStatements, 1);
  pending.resolve({ status: 200, etag: null, body: preview } as never);
  await Promise.all([first, second]);
  controller.destroy();
}

// A late preview for replaced files cannot overwrite the newer package preview.
{
  const oldResponse = deferred<never>();
  let request = 0;
  const newerPreview = { ...preview, previewId: "preview-new" };
  const { api } = apiFixture({
    async previewStatements() {
      request += 1;
      if (request === 1) return oldResponse.promise;
      return { status: 200, etag: null, body: newerPreview } as never;
    }
  });
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  await selectAll(controller);
  const old = controller.previewStatements();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(request, 1);
  await controller.selectStatement("balance_sheet", file("balance-new.xlsx", "new"));
  await controller.previewStatements();
  oldResponse.resolve({ status: 200, etag: null, body: preview } as never);
  await old;
  assert.equal(controller.getState().statementPreview?.previewId, "preview-new");
  controller.destroy();
}

// Routing is capability-gated, pinned to eligible IDs, and preserves opaque ETag.
{
  let receivedEtag: string | null = null;
  const forbiddenCenter = { ...center, capabilities: { ...center.capabilities, canManageRouting: false } };
  const forbiddenFixture = apiFixture({
    async getAgentCenter() { return { status: 200, etag: null, body: forbiddenCenter } as never; }
  });
  const forbidden = createRealAgentCenterController({ api: forbiddenFixture.api });
  await settleLoad();
  await forbidden.updateRouting(routingInput as never);
  assert.equal(forbiddenFixture.calls.updateRouting, 0);
  assert.equal(forbidden.getState().error, "financial_council_routing_forbidden");
  forbidden.destroy();

  const malformedFixture = apiFixture();
  const malformed = createRealAgentCenterController({ api: malformedFixture.api });
  await settleLoad();
  await assert.doesNotReject(malformed.updateRouting({ roles: {} } as never));
  assert.equal(malformedFixture.calls.updateRouting, 0);
  assert.equal(malformed.getState().error, "financial_council_routing_invalid");
  malformed.destroy();

  const { api, calls } = apiFixture({
    async updateRouting(_input, etag, key) {
      receivedEtag = etag; calls.updateRouting += 1; calls.updateKeys.push(key);
      return { status: 200, etag: '"next"', body: policy } as never;
    }
  });
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  const invalidPinned = {
    ...routingInput,
    roles: { ...routingInput.roles, finance: { ...autoRoute, mode: "pinned", primaryConnectionId: "unknown" } }
  };
  await controller.updateRouting(invalidPinned as never);
  assert.equal(calls.updateRouting, 0);
  assert.equal(controller.getState().error, "financial_council_pinned_connection_invalid");
  await controller.updateRouting(routingInput as never);
  assert.equal(receivedEtag, '"opaque-policy-etag"');
  controller.destroy();
}

// 412 reloads current policy/ETag while retaining a safe conflict error.
{
  let reads = 0;
  const current = { ...policy, policyVersionId: "policy-current", revision: 2 };
  const { api } = apiFixture({
    async getRoutingPolicy() {
      reads += 1;
      return { status: 200, etag: reads === 1 ? '"old"' : '"current"', body: reads === 1 ? policy : current } as never;
    },
    async updateRouting() { throw new GrowthApiError(412, "routing_policy_precondition_failed"); }
  });
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  await controller.updateRouting(routingInput as never);
  assert.equal(controller.getState().routingPolicy?.policyVersionId, "policy-current");
  assert.equal(controller.getState().error, "routing_policy_precondition_failed");
  controller.destroy();
}

// Routing semantic keys ignore caller extras that are not in the generated DTO.
{
  const { api, calls } = apiFixture({
    async updateRouting(_input, _etag, key) {
      calls.updateRouting += 1;
      calls.updateKeys.push(key);
      throw new TypeError("ambiguous network failure");
    }
  });
  const controller = createRealAgentCenterController({ api, idFactory: sequenceIds() });
  await settleLoad();
  await controller.updateRouting({ ...routingInput, workspaceId: "forged-a" } as never);
  await controller.updateRouting({ ...routingInput, workspaceId: "forged-b" } as never);
  assert.deepEqual(calls.updateKeys, [calls.updateKeys[0], calls.updateKeys[0]]);
  controller.destroy();
}

// close/destroy abort every command/read, suppress late state, and release private files.
for (const teardown of ["close", "destroy"] as const) {
  const pending = deferred<never>();
  let requestSignal: AbortSignal | undefined;
  let fileReads = 0;
  const heldFile = {
    name: "balance.xlsx", size: 7, lastModified: 1,
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    async arrayBuffer() { fileReads += 1; return new TextEncoder().encode("balance").buffer; }
  } as File;
  const { api } = apiFixture({
    async previewStatements(_input, _key, signal) { requestSignal = signal; return pending.promise; }
  });
  const controller = createRealAgentCenterController({ api });
  await settleLoad();
  await controller.selectStatement("balance_sheet", heldFile);
  await controller.selectStatement("income_statement", file("income.xlsx", "income"));
  await controller.selectStatement("cash_flow_statement", file("cash.xlsx", "cash"));
  const operation = controller.previewStatements();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(requestSignal?.aborted, false);
  controller[teardown]();
  assert.equal(requestSignal?.aborted, true);
  pending.resolve({ status: 200, etag: null, body: preview } as never);
  await operation;
  assert.equal(controller.getState().statementPreview, null);
  assert.equal(controller.getState().files.balance_sheet, null);
  assert.equal(fileReads, 2);
}

function sequenceIds(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

const _optionsTypeCheck: RealAgentCenterControllerOptions | null = null;
void _optionsTypeCheck;
