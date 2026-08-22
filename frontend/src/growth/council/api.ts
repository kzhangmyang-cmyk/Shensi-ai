import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  FinancialCouncilApproval,
  FinancialCouncilDispatchPagedResult,
  FinancialCouncilPolicyInput,
  FinancialCouncilPolicyVersion,
  FinancialCouncilPortfolioRevision,
  FinancialCouncilPortfolioRevisionInput,
  FinancialCouncilRun,
  FinancialCouncilRunEventPagedResult
} from "../contracts";
import type {
  GrowthHttpClient,
  GrowthHttpResponse
} from "../http";

export type {
  FinancialCouncilApproval,
  FinancialCouncilDispatchPagedResult as FinancialCouncilDispatchPage,
  FinancialCouncilPolicyInput,
  FinancialCouncilPolicyVersion as FinancialCouncilPolicy,
  FinancialCouncilPortfolioRevision,
  FinancialCouncilPortfolioRevisionInput,
  FinancialCouncilRun,
  FinancialCouncilRunEventPagedResult as FinancialCouncilRunEventPage
} from "../contracts";

type FinancialCouncilRunEventPage = FinancialCouncilRunEventPagedResult;
type FinancialCouncilPolicy = FinancialCouncilPolicyVersion;
type FinancialCouncilDispatchPage = FinancialCouncilDispatchPagedResult;

export type FinancialCouncilCreateInput =
  components["schemas"]["FinancialCouncilRun_FinancialCouncilCreateInput"];
export type FinancialCouncilApprovalInput =
  components["schemas"]["FinancialCouncilRun_FinancialCouncilApprovalInput"];
export type FinancialCouncilRejectInput =
  components["schemas"]["FinancialCouncilRun_FinancialCouncilRejectInput"];

const RUN_STATUSES = new Set([
  "snapshot_frozen", "analyzing", "auditing", "synthesizing", "optimizing",
  "awaiting_approval", "approved", "rejected", "stale", "expired", "failed",
  "not_computable"
]);
const EVENT_STATUSES = new Set(["created", ...RUN_STATUSES]);
const PORTFOLIO_KINDS = new Set(["balanced", "cash_first", "growth_first"]);
const APPROVAL_STATUSES = new Set(["approved", "rejected"]);
const DISPATCH_STATUSES = new Set([
  "queued", "running", "retry", "succeeded", "failed"
]);

export class CouncilApiValidationError extends Error {
  readonly code = "financial_council_response_invalid";

  constructor() {
    super("financial_council_response_invalid");
    this.name = "CouncilApiValidationError";
  }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CouncilApiValidationError();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new CouncilApiValidationError();
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nullableString(value: unknown): boolean {
  return value === null || nonempty(value);
}

function responseError(): never {
  throw new CouncilApiValidationError();
}

function validateRun(value: unknown): FinancialCouncilRun {
  const row = record(value, [
    "runId", "workspaceId", "currency", "status", "revision", "dataAsOf",
    "businessReport", "policyVersionId", "snapshotId", "snapshotHash",
    "consensusReport", "portfolios", "latestPortfolioRevision", "approval",
    "createdAt", "updatedAt", "expiresAt"
  ]);
  if (!nonempty(row.runId) || !nonempty(row.workspaceId)
    || (row.currency !== "CNY" && row.currency !== "USD")
    || typeof row.status !== "string" || !RUN_STATUSES.has(row.status)
    || !positiveInteger(row.revision) || !nonempty(row.dataAsOf)
    || !row.businessReport || typeof row.businessReport !== "object"
    || !nonempty(row.policyVersionId) || !nonempty(row.snapshotId)
    || !nonempty(row.snapshotHash) || !Array.isArray(row.portfolios)
    || !(row.latestPortfolioRevision === null || positiveInteger(row.latestPortfolioRevision))
    || !(row.consensusReport === null || typeof row.consensusReport === "object")
    || !(row.approval === null || typeof row.approval === "object")
    || !nonempty(row.createdAt) || !nonempty(row.updatedAt) || !nonempty(row.expiresAt)) {
    return responseError();
  }
  return value as FinancialCouncilRun;
}

function validatePage(value: unknown, item: (value: unknown) => void): void {
  const row = record(value, ["items", "nextAfter", "hasMore"]);
  if (!Array.isArray(row.items) || !nullableString(row.nextAfter)
    || typeof row.hasMore !== "boolean") return responseError();
  for (const entry of row.items) item(entry);
}

function validateEvents(value: unknown): FinancialCouncilRunEventPage {
  validatePage(value, (entry) => {
    const row = record(entry, [
      "eventId", "runId", "revision", "fromStatus", "toStatus", "reasonCode",
      "occurredAt"
    ]);
    if (!nonempty(row.eventId) || !nonempty(row.runId) || !positiveInteger(row.revision)
      || !(row.fromStatus === null || (typeof row.fromStatus === "string"
        && EVENT_STATUSES.has(row.fromStatus)))
      || typeof row.toStatus !== "string" || !EVENT_STATUSES.has(row.toStatus)
      || !(row.reasonCode === null || nonempty(row.reasonCode))
      || !nonempty(row.occurredAt)) responseError();
  });
  return value as FinancialCouncilRunEventPage;
}

function validatePolicy(value: unknown): FinancialCouncilPolicy {
  const row = record(value, [
    "policyVersionId", "workspaceId", "version", "revision", "currency",
    "balancedWeightsBps", "minimumCashReserveMinor", "dueDebtMinor",
    "necessaryOutflowMinor", "budgetLimitMinor", "capacityLimitUnits",
    "durationLimitDays", "minimumActionConfidenceBps", "actionCoefficientVersion",
    "policyHash", "createdAt"
  ]);
  if (!nonempty(row.policyVersionId) || !nonempty(row.workspaceId)
    || !positiveInteger(row.version) || !positiveInteger(row.revision)
    || (row.currency !== "CNY" && row.currency !== "USD")
    || !row.balancedWeightsBps || typeof row.balancedWeightsBps !== "object"
    || !nonempty(row.actionCoefficientVersion) || !nonempty(row.policyHash)
    || !nonempty(row.createdAt)) return responseError();
  return value as FinancialCouncilPolicy;
}

function validateRevision(value: unknown): FinancialCouncilPortfolioRevision {
  const row = record(value, ["runId", "revision", "baseRevision", "portfolios", "createdAt"]);
  if (!nonempty(row.runId) || !positiveInteger(row.revision)
    || !(row.baseRevision === null || positiveInteger(row.baseRevision))
    || !Array.isArray(row.portfolios) || !nonempty(row.createdAt)) return responseError();
  return value as FinancialCouncilPortfolioRevision;
}

function validateApproval(value: unknown): FinancialCouncilApproval {
  const row = record(value, [
    "approvalId", "runId", "portfolioRevision", "portfolioKind", "status",
    "approvedActionIds", "requiredCapabilities", "reason", "approvedAt"
  ]);
  if (!nonempty(row.approvalId) || !nonempty(row.runId)
    || !positiveInteger(row.portfolioRevision) || typeof row.portfolioKind !== "string"
    || !PORTFOLIO_KINDS.has(row.portfolioKind) || typeof row.status !== "string"
    || !APPROVAL_STATUSES.has(row.status) || !Array.isArray(row.approvedActionIds)
    || !Array.isArray(row.requiredCapabilities) || !(row.reason === null || nonempty(row.reason))
    || !nonempty(row.approvedAt)) return responseError();
  return value as FinancialCouncilApproval;
}

function validateDispatches(value: unknown): FinancialCouncilDispatchPage {
  validatePage(value, (entry) => {
    const row = record(entry, [
      "dispatchId", "runId", "approvalId", "portfolioRevision", "portfolioKind",
      "actionId", "status", "attempt", "receiptId", "lastErrorCode", "createdAt",
      "updatedAt"
    ]);
    if (!nonempty(row.dispatchId) || !nonempty(row.runId) || !nonempty(row.approvalId)
      || !positiveInteger(row.portfolioRevision) || typeof row.portfolioKind !== "string"
      || !PORTFOLIO_KINDS.has(row.portfolioKind) || !nonempty(row.actionId)
      || typeof row.status !== "string" || !DISPATCH_STATUSES.has(row.status)
      || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 0
      || !nullableString(row.receiptId) || !nullableString(row.lastErrorCode)
      || !nonempty(row.createdAt) || !nonempty(row.updatedAt)) responseError();
  });
  return value as FinancialCouncilDispatchPage;
}

function createBody(input: FinancialCouncilCreateInput) {
  const value = input as unknown as Record<string, unknown>;
  return {
    currency: value.currency,
    dataAsOf: value.dataAsOf,
    businessReport: value.businessReport,
    policyVersionId: value.policyVersionId
  } as FinancialCouncilCreateInput;
}

function policyBody(input: FinancialCouncilPolicyInput): FinancialCouncilPolicyInput {
  const value = input as unknown as Record<string, unknown>;
  return {
    currency: value.currency,
    balancedWeightsBps: value.balancedWeightsBps,
    minimumCashReserveMinor: value.minimumCashReserveMinor,
    dueDebtMinor: value.dueDebtMinor,
    necessaryOutflowMinor: value.necessaryOutflowMinor,
    budgetLimitMinor: value.budgetLimitMinor,
    capacityLimitUnits: value.capacityLimitUnits,
    durationLimitDays: value.durationLimitDays,
    minimumActionConfidenceBps: value.minimumActionConfidenceBps,
    actionCoefficientVersion: value.actionCoefficientVersion
  } as FinancialCouncilPolicyInput;
}

function revisionBody(
  input: FinancialCouncilPortfolioRevisionInput
): FinancialCouncilPortfolioRevisionInput {
  const value = input as unknown as Record<string, unknown>;
  return { baseRevision: value.baseRevision, operations: value.operations } as FinancialCouncilPortfolioRevisionInput;
}

export interface FinancialCouncilApi {
  createRun(input: FinancialCouncilCreateInput, idempotencyKey: string): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
  getRun(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
  listEvents(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRunEventPage>>;
  getPolicy(signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilPolicy>>;
  updatePolicy(input: FinancialCouncilPolicyInput, etag: string, idempotencyKey: string): Promise<GrowthHttpResponse<FinancialCouncilPolicy>>;
  revisePortfolio(runId: string, input: FinancialCouncilPortfolioRevisionInput, etag: string, idempotencyKey: string): Promise<GrowthHttpResponse<FinancialCouncilPortfolioRevision>>;
  approve(runId: string, revision: number, input: FinancialCouncilApprovalInput, etag: string, idempotencyKey: string): Promise<GrowthHttpResponse<FinancialCouncilApproval>>;
  reject(runId: string, input: FinancialCouncilRejectInput, etag: string, idempotencyKey: string): Promise<GrowthHttpResponse<FinancialCouncilApproval>>;
  listDispatches(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilDispatchPage>>;
}

export function createFinancialCouncilApi(http: GrowthHttpClient): FinancialCouncilApi {
  const api: FinancialCouncilApi = {
    async createRun(input, idempotencyKey) {
      const response = await http.request<unknown>("/api/v1/finance/council-runs", {
        method: "POST", body: createBody(input), idempotencyKey
      });
      return { ...response, body: validateRun(response.body) };
    },
    async getRun(runId, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}`, { signal }
      );
      return { ...response, body: validateRun(response.body) };
    },
    async listEvents(runId, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/events`, { signal }
      );
      return { ...response, body: validateEvents(response.body) };
    },
    async getPolicy(signal) {
      const response = await http.request<unknown>("/api/v1/finance/council-policy", { signal });
      return { ...response, body: validatePolicy(response.body) };
    },
    async updatePolicy(input, etag, idempotencyKey) {
      const response = await http.request<unknown>("/api/v1/finance/council-policy", {
        method: "PUT", body: policyBody(input), ifMatch: etag, idempotencyKey
      });
      return { ...response, body: validatePolicy(response.body) };
    },
    async revisePortfolio(runId, input, etag, idempotencyKey) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/portfolio-revisions`,
        { method: "POST", body: revisionBody(input), ifMatch: etag, idempotencyKey }
      );
      return { ...response, body: validateRevision(response.body) };
    },
    async approve(runId, revision, input, etag, idempotencyKey) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/portfolio-revisions/${encodeURIComponent(String(revision))}/approve`,
        { method: "POST", body: { portfolioKind: input.portfolioKind }, ifMatch: etag, idempotencyKey }
      );
      return { ...response, body: validateApproval(response.body) };
    },
    async reject(runId, input, etag, idempotencyKey) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/reject`,
        {
          method: "POST",
          body: {
            portfolioRevision: input.portfolioRevision,
            portfolioKind: input.portfolioKind,
            reason: input.reason
          },
          ifMatch: etag,
          idempotencyKey
        }
      );
      return { ...response, body: validateApproval(response.body) };
    },
    async listDispatches(runId, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/dispatches`, { signal }
      );
      return { ...response, body: validateDispatches(response.body) };
    }
  };
  return Object.freeze(api);
}
