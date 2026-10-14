import type { components } from "../../generated/growth-advisor-quote-roi";
import type { FinancialCouncilCollaboration, FinancialCouncilRunHistory } from "../contracts";
import type {
  FinancialCouncilApproval,
  CreateCouncilRunFromPackageInput,
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
  CreateCouncilRunFromPackageInput,
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

function validateCollaboration(value: unknown, runId: string): FinancialCouncilCollaboration {
  const row = record(value, ["runId", "workspaceId", "revision", "dataAsOf", "currency", "statementPackageId", "snapshotId", "snapshotHash", "policyVersionId", "executionMode", "reviewRoundLimit", "roles", "events", "reviews", "narrative", "report"]);
  const roles = ["cfo", "finance", "profit", "cost", "cashflow", "tax"];
  const states = ["waiting", "running", "completed", "missing_data", "failed", "degraded"];
  const phases = ["analysis", "review", "synthesis", "run"];
  if (row.runId !== runId || !positiveInteger(row.revision) || row.executionMode !== "sequential"
    || row.reviewRoundLimit !== 1 || !Array.isArray(row.roles) || row.roles.length !== 6
    || !Array.isArray(row.events) || !Array.isArray(row.reviews)) responseError();
  for (const role of row.roles as unknown[]) {
    const item = record(role, ["role", "state", "phase", "updatedAt", "message", "reasonCode", "findings", "actions"]);
    const index = roles.indexOf(String(item.role));
    if (index < 0 || !states.includes(String(item.state)) || !phases.includes(String(item.phase)) || typeof item.message !== "string"
      || !Array.isArray(item.findings) || !Array.isArray(item.actions)) responseError();
    roles.splice(index, 1);
    for (const finding of item.findings as unknown[]) {
      const entry = record(finding, ["findingId", "runId", "snapshotId", "agentRole", "conclusion", "evidenceRefs", "formulaRef", "confidenceBps", "severity", "assumptions", "missingData", "candidateActionIds"]);
      if (typeof entry.conclusion !== "string" || typeof entry.severity !== "string"
        || !Array.isArray(entry.evidenceRefs) || !Array.isArray(entry.missingData)) responseError();
      for (const ref of entry.evidenceRefs as unknown[]) {
        const evidence = record(ref, ["source", "sourceId", "contentHash"]);
        if (!nonempty(evidence.source) || !nonempty(evidence.sourceId)) responseError();
      }
      for (const gap of entry.missingData as Record<string, unknown>[]) {
        if (!gap || typeof gap.description !== "string") responseError();
      }
    }
  }
  for (const event of row.events as unknown[]) {
    const item = record(event, ["eventId", "role", "phase", "state", "occurredAt", "message", "reasonCode", "findingIds"]);
    if (!nonempty(item.eventId) || !phases.includes(String(item.phase)) || !states.includes(String(item.state))
      || !nonempty(item.occurredAt) || typeof item.message !== "string" || !Array.isArray(item.findingIds)
      || !item.findingIds.every(id => typeof id === "string")) responseError();
  }
  for (const review of row.reviews as unknown[]) {
    const item = record(review, ["role", "round", "findingId", "peerFindingId", "state", "summary", "occurredAt"]);
    if (item.round !== 1 || !["pending", "upheld", "revised", "withdrawn"].includes(String(item.state))
      || typeof item.summary !== "string" || typeof item.findingId !== "string" || typeof item.peerFindingId !== "string") responseError();
  }
  const report = record(row.report, ["reportId", "version", "title", "complete", "generatedAt", "sections"]);
  if (report.version !== "financial-council-report.v1" || !nonempty(report.reportId)
    || typeof report.title !== "string" || typeof report.complete !== "boolean"
    || !Array.isArray(report.sections)) responseError();
  for (const section of report.sections as unknown[]) {
    const item = record(section, ["id", "title", "paragraphs", "items"]);
    if (!nonempty(item.id) || typeof item.title !== "string" || !Array.isArray(item.paragraphs)
      || !item.paragraphs.every(p => typeof p === "string") || !Array.isArray(item.items)) responseError();
    for (const detail of item.items as unknown[]) {
      const cell = record(detail, ["label", "value", "evidenceRefs"]);
      if (typeof cell.label !== "string" || typeof cell.value !== "string" || !Array.isArray(cell.evidenceRefs)
        || !cell.evidenceRefs.every(ref => typeof ref === "string")) responseError();
    }
  }
  return value as FinancialCouncilCollaboration;
}

export function validateFinancialCouncilRunResponse(
  value: unknown
): FinancialCouncilRun {
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

function packageCreateBody(
  input: CreateCouncilRunFromPackageInput
): CreateCouncilRunFromPackageInput {
  const value = input as unknown as Record<string, unknown>;
  return {
    statementPackageId: value.statementPackageId,
    policyVersionId: value.policyVersionId
  } as CreateCouncilRunFromPackageInput;
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

function optionalSignal(signal: AbortSignal | undefined) {
  return signal ? { signal } : {};
}

export interface FinancialCouncilApi {
  listRuns(after?: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRunHistory>>;
  getCollaboration(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilCollaboration>>;
  createRun(input: FinancialCouncilCreateInput, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
  createFromStatementPackage(input: CreateCouncilRunFromPackageInput, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
  getRun(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
  listEvents(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRunEventPage>>;
  getPolicy(signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilPolicy>>;
  updatePolicy(input: FinancialCouncilPolicyInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilPolicy>>;
  revisePortfolio(runId: string, input: FinancialCouncilPortfolioRevisionInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilPortfolioRevision>>;
  approve(runId: string, revision: number, input: FinancialCouncilApprovalInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilApproval>>;
  reject(runId: string, input: FinancialCouncilRejectInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilApproval>>;
  listDispatches(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilDispatchPage>>;
}

export function createFinancialCouncilApi(http: GrowthHttpClient): FinancialCouncilApi {
  const api: FinancialCouncilApi = {
    async listRuns(after, signal) {
      const query = new URLSearchParams({ limit: "20" });
      if (after) query.set("after", after);
      const response = await http.request<unknown>(`/api/v1/finance/council-runs?${query}`, { signal });
      validatePage(response.body, entry => {
        const row = record(entry, ["runId", "status", "currency", "dataAsOf", "createdAt", "updatedAt"]);
        if (!nonempty(row.runId) || !RUN_STATUSES.has(String(row.status))) responseError();
      });
      return { ...response, body: response.body as FinancialCouncilRunHistory };
    },
    async getCollaboration(runId, signal) {
      const response = await http.request<unknown>(`/api/v1/finance/council-runs/${encodeURIComponent(runId)}/collaboration`, { signal });
      return { ...response, body: validateCollaboration(response.body, runId) };
    },
    async createRun(input, idempotencyKey, signal) {
      const response = await http.request<unknown>("/api/v1/finance/council-runs", {
        method: "POST", body: createBody(input), idempotencyKey,
        ...optionalSignal(signal)
      });
      return { ...response, body: validateFinancialCouncilRunResponse(response.body) };
    },
    async createFromStatementPackage(input, idempotencyKey, signal) {
      const response = await http.request<unknown>("/api/v1/finance/council-runs", {
        method: "POST", body: packageCreateBody(input), idempotencyKey,
        ...optionalSignal(signal)
      });
      return { ...response, body: validateFinancialCouncilRunResponse(response.body) };
    },
    async getRun(runId, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}`, { signal }
      );
      return { ...response, body: validateFinancialCouncilRunResponse(response.body) };
    },
    async listEvents(runId, signal) {
      const items = new Map<string, FinancialCouncilRunEventPage["items"][number]>();
      const cursors = new Set<string>();
      let after: string | null = null;
      for (;;) {
        const query = after ? `?after=${encodeURIComponent(after)}&limit=100` : "";
        const response = await http.request<unknown>(
          `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/events${query}`, { signal }
        );
        const page = validateEvents(response.body);
        for (const item of page.items) items.set(item.eventId, item);
        if (!page.hasMore) return { ...response, body: { items: [...items.values()], nextAfter: page.nextAfter, hasMore: false } };
        if (!page.nextAfter || cursors.has(page.nextAfter)) return responseError();
        cursors.add(page.nextAfter);
        after = page.nextAfter;
      }
    },
    async getPolicy(signal) {
      const response = await http.request<unknown>("/api/v1/finance/council-policy", { signal });
      return { ...response, body: validatePolicy(response.body) };
    },
    async updatePolicy(input, etag, idempotencyKey, signal) {
      const response = await http.request<unknown>("/api/v1/finance/council-policy", {
        method: "PUT", body: policyBody(input), ifMatch: etag, idempotencyKey,
        ...optionalSignal(signal)
      });
      return { ...response, body: validatePolicy(response.body) };
    },
    async revisePortfolio(runId, input, etag, idempotencyKey, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/portfolio-revisions`,
        { method: "POST", body: revisionBody(input), ifMatch: etag,
          idempotencyKey, ...optionalSignal(signal) }
      );
      return { ...response, body: validateRevision(response.body) };
    },
    async approve(runId, revision, input, etag, idempotencyKey, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/portfolio-revisions/${encodeURIComponent(String(revision))}/approve`,
        { method: "POST", body: { portfolioKind: input.portfolioKind },
          ifMatch: etag, idempotencyKey, ...optionalSignal(signal) }
      );
      return { ...response, body: validateApproval(response.body) };
    },
    async reject(runId, input, etag, idempotencyKey, signal) {
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
          idempotencyKey,
          ...optionalSignal(signal)
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
