import type {
  CreateCouncilRunFromPackageInput,
  FinancialCouncilAgentCenterView,
  FinancialCouncilModelRoutePreview,
  FinancialCouncilModelRoutingPolicyInput,
  FinancialCouncilModelRoutingPolicyVersion,
  FinancialCouncilPolicyVersion,
  FinancialCouncilRun,
  FinancialCouncilRunAgentsView,
  FinancialStatementPackageCommitInput,
  FinancialStatementPackagePreview,
  FinancialStatementPackagePreviewInput,
  FinancialStatementPackageView,
  FinancialStatementUpload
} from "../contracts";
import type { GrowthHttpClient, GrowthHttpResponse } from "../http";
import {
  createFinancialCouncilApi,
  validateFinancialCouncilRunResponse
} from "../council/api";

const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const STATEMENT_KINDS = [
  "balance_sheet", "income_statement", "cash_flow_statement"
] as const;
const MODEL_ROLES = [
  "cfo", "finance", "profit", "cost", "cashflow", "tax"
] as const;
const PROVIDERS = new Set([
  "openai", "moonshot", "minimax", "zhipu", "deepseek", "qwen",
  "doubao", "hunyuan", "qianfan"
]);
const CENTER_STATUSES = new Set([
  "not_connected", "ready", "running", "waiting", "completed",
  "manual_review", "model_error"
]);
const RUN_STATUSES = new Set([
  "snapshot_frozen", "analyzing", "auditing", "synthesizing", "optimizing",
  "awaiting_approval", "approved", "rejected", "stale", "expired", "failed",
  "not_computable"
]);
const ATTEMPT_ERRORS = new Set([
  "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_UNAVAILABLE",
  "MODEL_AUTH_FAILED", "MODEL_OUTPUT_INVALID", "MODEL_POLICY_CONFLICT",
  "MODEL_ERROR"
]);
const REASON_CODES = new Set([
  "structured_output_certified", "recent_success_rate", "recent_p95_latency",
  "known_cost", "cost_unknown", "consecutive_failure_penalty",
  "role_preference_weight", "stable_tiebreak"
]);
const MISSING_CAPABILITIES = new Set([
  "structured_output_certified", "pinned_connection_eligible"
]);

export class RealAgentCenterApiValidationError extends Error {
  readonly code: "financial_council_request_invalid"
    | "financial_council_response_invalid";

  constructor(kind: "request" | "response") {
    const code = kind === "request"
      ? "financial_council_request_invalid"
      : "financial_council_response_invalid";
    super(code);
    this.name = "RealAgentCenterApiValidationError";
    this.code = code;
  }
}

function invalid(kind: "request" | "response" = "response"): never {
  throw new RealAgentCenterApiValidationError(kind);
}

function record(
  value: unknown,
  keys: readonly string[],
  kind: "request" | "response" = "response"
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(kind);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) invalid(kind);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function safeNonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function stringArray(
  value: unknown,
  allowed?: ReadonlySet<string>
): value is string[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === "string" && (!allowed || allowed.has(item)));
}

function validateConnection(value: unknown): void {
  const row = record(value, ["connectionId", "displayName", "model", "provider"]);
  if (!nonempty(row.connectionId) || typeof row.displayName !== "string"
    || !nonempty(row.model) || typeof row.provider !== "string"
    || !PROVIDERS.has(row.provider)) invalid();
}

function validateRoute(value: unknown, kind: "request" | "response"): void {
  const row = record(value, [
    "mode", "primaryConnectionId", "fallbackConnectionIds", "preferenceWeightBps"
  ], kind);
  if ((row.mode !== "auto" && row.mode !== "pinned")
    || !(row.primaryConnectionId === null || nonempty(row.primaryConnectionId))
    || !Array.isArray(row.fallbackConnectionIds)
    || row.fallbackConnectionIds.length > 2
    || !row.fallbackConnectionIds.every(nonempty)
    || new Set(row.fallbackConnectionIds).size !== row.fallbackConnectionIds.length
    || (typeof row.primaryConnectionId === "string"
      && row.fallbackConnectionIds.includes(row.primaryConnectionId))
    || !safeNonNegative(row.preferenceWeightBps)
    || row.preferenceWeightBps > 10_000
    || (row.mode === "auto"
      && (row.primaryConnectionId !== null || row.fallbackConnectionIds.length !== 0))
    || (row.mode === "pinned" && row.primaryConnectionId === null)) invalid(kind);
}

function routingBody(
  value: FinancialCouncilModelRoutingPolicyInput,
  validationKind: "request" | "response" = "request"
): FinancialCouncilModelRoutingPolicyInput {
  const row = value as unknown as Record<string, unknown>;
  const rolesValue = row.roles;
  if (!rolesValue || typeof rolesValue !== "object" || Array.isArray(rolesValue)) {
    invalid("request");
  }
  const rolesRecord = validationKind === "response"
    ? record(rolesValue, MODEL_ROLES, "response")
    : rolesValue as Record<string, unknown>;
  const roles = Object.fromEntries(MODEL_ROLES.map((role) => {
    const raw = rolesRecord[role];
    if (!raw || typeof raw !== "object") invalid("request");
    const source = raw as Record<string, unknown>;
    const closed = {
      mode: source.mode,
      primaryConnectionId: source.primaryConnectionId,
      fallbackConnectionIds: source.fallbackConnectionIds,
      preferenceWeightBps: source.preferenceWeightBps
    };
    validateRoute(validationKind === "response" ? raw : closed, validationKind);
    return [role, closed];
  }));
  const closed = {
    maxRoleBudgetMinor: row.maxRoleBudgetMinor,
    maxRunBudgetMinor: row.maxRunBudgetMinor,
    requestTimeoutMs: row.requestTimeoutMs,
    roles
  } as FinancialCouncilModelRoutingPolicyInput;
  if (!safeNonNegative(closed.maxRunBudgetMinor)
    || !safeNonNegative(closed.maxRoleBudgetMinor)
    || closed.maxRoleBudgetMinor > closed.maxRunBudgetMinor
    || !positiveInteger(closed.requestTimeoutMs)) invalid(validationKind);
  return closed;
}

function validateRoutingPolicy(
  value: unknown
): FinancialCouncilModelRoutingPolicyVersion {
  const row = record(value, [
    "createdAt", "maxRoleBudgetMinor", "maxRunBudgetMinor", "policyVersionId",
    "requestTimeoutMs", "revision", "roles"
  ]);
  routingBody({
    maxRoleBudgetMinor: row.maxRoleBudgetMinor,
    maxRunBudgetMinor: row.maxRunBudgetMinor,
    requestTimeoutMs: row.requestTimeoutMs,
    roles: row.roles
  } as never, "response");
  if (!nonempty(row.policyVersionId) || !positiveInteger(row.revision)
    || !nonempty(row.createdAt)) invalid();
  return value as FinancialCouncilModelRoutingPolicyVersion;
}

function validateRoutePreview(value: unknown): FinancialCouncilModelRoutePreview {
  const row = record(value, [
    "missingCapabilities", "orderedConnections", "reasonCodes", "role",
    "selectedConnection"
  ]);
  if (typeof row.role !== "string" || !MODEL_ROLES.includes(row.role as never)
    || !Array.isArray(row.orderedConnections)
    || !stringArray(row.reasonCodes, REASON_CODES)
    || !stringArray(row.missingCapabilities, MISSING_CAPABILITIES)) invalid();
  row.orderedConnections.forEach(validateConnection);
  if (row.selectedConnection !== null) validateConnection(row.selectedConnection);
  return value as FinancialCouncilModelRoutePreview;
}

function validateAgentCenter(value: unknown): FinancialCouncilAgentCenterView {
  const row = record(value, ["capabilities", "data", "latestRun", "models"]);
  const capabilities = record(row.capabilities, [
    "canApprove", "canManageRouting", "canRun"
  ]);
  if (typeof capabilities.canApprove !== "boolean"
    || typeof capabilities.canManageRouting !== "boolean"
    || typeof capabilities.canRun !== "boolean") invalid();
  const data = record(row.data, [
    "companyName", "packageId", "period", "status", "verifiedAt", "warningCodes"
  ]);
  if ((data.status !== "not_connected" && data.status !== "ready")
    || !nullableString(data.companyName) || !nullableString(data.packageId)
    || !nullableString(data.period) || !nullableString(data.verifiedAt)
    || !stringArray(data.warningCodes)) invalid();
  const models = record(row.models, ["roles", "routingPolicyVersionId", "status"]);
  if ((models.status !== "not_connected" && models.status !== "ready")
    || !nullableString(models.routingPolicyVersionId) || !Array.isArray(models.roles)) {
    invalid();
  }
  for (const entry of models.roles) {
    const role = record(entry, [
      "connectionDisplayName", "model", "provider", "role", "status"
    ]);
    if (typeof role.role !== "string" || !MODEL_ROLES.includes(role.role as never)
      || typeof role.status !== "string" || !CENTER_STATUSES.has(role.status)
      || !nullableString(role.connectionDisplayName) || !nullableString(role.model)
      || !nullableString(role.provider)) invalid();
  }
  if (row.latestRun !== null) {
    const latest = record(row.latestRun, ["revision", "runId", "status", "updatedAt"]);
    if (!positiveInteger(latest.revision) || !nonempty(latest.runId)
      || typeof latest.status !== "string" || !RUN_STATUSES.has(latest.status)
      || !nonempty(latest.updatedAt)) invalid();
  }
  return value as FinancialCouncilAgentCenterView;
}

function validateRunAgents(value: unknown): FinancialCouncilRunAgentsView {
  const row = record(value, ["revision", "roles", "runId", "status", "updatedAt"]);
  if (!positiveInteger(row.revision) || !nonempty(row.runId)
    || typeof row.status !== "string" || !RUN_STATUSES.has(row.status)
    || !nonempty(row.updatedAt) || !Array.isArray(row.roles)) invalid();
  for (const entry of row.roles) {
    const role = record(entry, ["attempts", "phase", "role", "status"]);
    if (typeof role.role !== "string" || !MODEL_ROLES.includes(role.role as never)
      || (role.phase !== "analysis" && role.phase !== "consensus")
      || typeof role.status !== "string" || !CENTER_STATUSES.has(role.status)
      || !Array.isArray(role.attempts)) invalid();
    for (const entryAttempt of role.attempts) {
      const attempt = record(entryAttempt, [
        "attempt", "completedAt", "connectionDisplayName", "errorCode", "model",
        "provider", "startedAt", "status"
      ]);
      if (!positiveInteger(attempt.attempt) || !nonempty(attempt.connectionDisplayName)
        || !nonempty(attempt.model) || !nonempty(attempt.provider)
        || (attempt.status !== "succeeded" && attempt.status !== "failed")
        || !(attempt.errorCode === null || (typeof attempt.errorCode === "string"
          && ATTEMPT_ERRORS.has(attempt.errorCode)))
        || !nullableString(attempt.startedAt) || !nullableString(attempt.completedAt)) {
        invalid();
      }
    }
  }
  return value as FinancialCouncilRunAgentsView;
}

function statementUploadBody(
  value: FinancialStatementPackagePreviewInput
): FinancialStatementPackagePreviewInput {
  const rawStatements = (value as unknown as Record<string, unknown>).statements;
  if (!Array.isArray(rawStatements) || rawStatements.length !== 3) invalid("request");
  const statements = rawStatements.map((raw, index) => {
    if (!raw || typeof raw !== "object") invalid("request");
    const value = raw as Record<string, unknown>;
    const closed = {
      kind: value.kind,
      fileName: value.fileName,
      mediaType: value.mediaType,
      contentBase64: value.contentBase64
    } as FinancialStatementUpload;
    if (closed.kind !== STATEMENT_KINDS[index]
      || !nonempty(closed.fileName) || closed.fileName.length > 255
      || closed.mediaType !== XLSX_MEDIA_TYPE || !nonempty(closed.contentBase64)) {
      invalid("request");
    }
    return closed;
  });
  return { statements } as FinancialStatementPackagePreviewInput;
}

function validateSourceFiles(value: unknown): void {
  if (!Array.isArray(value)) invalid();
  for (const entry of value) {
    const source = record(entry, [
      "fileHash", "fileName", "kind", "mediaType", "sheetNames"
    ]);
    if (typeof source.kind !== "string" || !STATEMENT_KINDS.includes(source.kind as never)
      || !nonempty(source.fileName) || !nonempty(source.fileHash)
      || source.mediaType !== XLSX_MEDIA_TYPE || !stringArray(source.sheetNames)) invalid();
  }
}

function validateStatementPreview(value: unknown): FinancialStatementPackagePreview {
  const row = record(value, [
    "companyName", "createdAt", "currency", "expiresAt", "parserVersion",
    "period", "previewId", "sourceFiles", "status", "warningCodes"
  ]);
  if (!nonempty(row.companyName) || !nonempty(row.createdAt)
    || (row.currency !== "CNY" && row.currency !== "USD")
    || !nonempty(row.expiresAt) || row.parserVersion !== "financial-statements.v2"
    || !nonempty(row.period) || !nonempty(row.previewId) || row.status !== "preview"
    || !stringArray(row.warningCodes)) invalid();
  validateSourceFiles(row.sourceFiles);
  return value as FinancialStatementPackagePreview;
}

function validateStatementPackage(value: unknown): FinancialStatementPackageView {
  const row = record(value, [
    "companyName", "createdAt", "currency", "expiresAt", "packageId",
    "parserVersion", "period", "sourceFiles", "status", "warningCodes"
  ]);
  if (!nonempty(row.companyName) || !nonempty(row.createdAt)
    || (row.currency !== "CNY" && row.currency !== "USD")
    || row.expiresAt !== null || !nonempty(row.packageId)
    || row.parserVersion !== "financial-statements.v2" || !nonempty(row.period)
    || row.status !== "verified" || !stringArray(row.warningCodes)) invalid();
  validateSourceFiles(row.sourceFiles);
  return value as FinancialStatementPackageView;
}

export interface RealAgentCenterApi {
  getAgentCenter(signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilAgentCenterView>>;
  getRunAgents(runId: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRunAgentsView>>;
  getCouncilPolicy(signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilPolicyVersion>>;
  getRoutingPolicy(signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilModelRoutingPolicyVersion>>;
  previewRouting(idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilModelRoutePreview[]>>;
  updateRouting(input: FinancialCouncilModelRoutingPolicyInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilModelRoutingPolicyVersion>>;
  previewStatements(input: FinancialStatementPackagePreviewInput, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialStatementPackagePreview>>;
  commitStatements(previewId: string, input: FinancialStatementPackageCommitInput, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialStatementPackageView>>;
  createRunFromPackage(input: CreateCouncilRunFromPackageInput, idempotencyKey: string, signal?: AbortSignal): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
}

export function createRealAgentCenterApi(http: GrowthHttpClient): RealAgentCenterApi {
  const councilApi = createFinancialCouncilApi(http);
  const api: RealAgentCenterApi = {
    async getAgentCenter(signal) {
      const response = await http.request<unknown>(
        "/api/v1/finance/council-agent-center", { signal }
      );
      return { ...response, body: validateAgentCenter(response.body) };
    },
    async getRunAgents(runId, signal) {
      const response = await http.request<unknown>(
        `/api/v1/finance/council-runs/${encodeURIComponent(runId)}/agents`, { signal }
      );
      return { ...response, body: validateRunAgents(response.body) };
    },
    getCouncilPolicy(signal) {
      return councilApi.getPolicy(signal);
    },
    async getRoutingPolicy(signal) {
      const response = await http.request<unknown>(
        "/api/v1/finance/council-model-routing-policy", { signal }
      );
      return { ...response, body: validateRoutingPolicy(response.body) };
    },
    async previewRouting(idempotencyKey, signal) {
      const response = await http.request<unknown>(
        "/api/v1/finance/council-model-routing-policy/preview",
        { method: "POST", body: {}, idempotencyKey, signal }
      );
      const body = record(response.body, ["roles"]);
      if (!Array.isArray(body.roles)) invalid();
      return { ...response, body: body.roles.map(validateRoutePreview) };
    },
    async updateRouting(input, etag, idempotencyKey, signal) {
      const response = await http.request<unknown>(
        "/api/v1/finance/council-model-routing-policy",
        { method: "PUT", body: routingBody(input), ifMatch: etag, idempotencyKey, signal }
      );
      return { ...response, body: validateRoutingPolicy(response.body) };
    },
    async previewStatements(input, idempotencyKey, signal) {
      const response = await http.request<unknown>(
        "/api/v1/finance/statement-packages/preview",
        { method: "POST", body: statementUploadBody(input), idempotencyKey, signal }
      );
      return { ...response, body: validateStatementPreview(response.body) };
    },
    async commitStatements(previewId, input, idempotencyKey, signal) {
      const consent = (input as unknown as Record<string, unknown>).consent;
      if (!consent || typeof consent !== "object") invalid("request");
      const raw = consent as Record<string, unknown>;
      const body = {
        consent: { accepted: raw.accepted, noticeVersion: raw.noticeVersion }
      } as FinancialStatementPackageCommitInput;
      if (body.consent.accepted !== true
        || body.consent.noticeVersion !== "financial-model-data.v1") invalid("request");
      const response = await http.request<unknown>(
        `/api/v1/finance/statement-packages/${encodeURIComponent(previewId)}/commit`,
        { method: "POST", body, idempotencyKey, signal }
      );
      return { ...response, body: validateStatementPackage(response.body) };
    },
    async createRunFromPackage(input, idempotencyKey, signal) {
      const raw = input as unknown as Record<string, unknown>;
      const body = {
        statementPackageId: raw.statementPackageId,
        policyVersionId: raw.policyVersionId
      } as CreateCouncilRunFromPackageInput;
      if (!nonempty(body.statementPackageId) || !nonempty(body.policyVersionId)) {
        invalid("request");
      }
      const response = await http.request<unknown>(
        "/api/v1/finance/council-runs/from-statement-package",
        { method: "POST", body, idempotencyKey, signal }
      );
      return { ...response, body: validateFinancialCouncilRunResponse(response.body) };
    }
  };
  return Object.freeze(api);
}
