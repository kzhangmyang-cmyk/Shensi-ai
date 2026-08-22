import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { canonicalBusinessReportInput } from "./business-advisor/domain.js";
import type { FinancialCouncilService } from "./financial-council-service.js";
import type {
  FinancialCouncilCreateInput,
  FinancialCouncilPolicyInput,
  FinancialCouncilPolicyVersion
} from "./growth-contract-types.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import {
  financialCouncilError,
  isFinancialCouncilError
} from "./financial-council-domain.js";
import { normalizeFinancialCouncilPolicyInput } from
  "./financial-council-policy.js";
import type {
  GrowthCommandContextFactory,
  GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";
import {
  parseIfMatchRevision,
  setRevisionEtag
} from "./growth-http-preconditions.js";
import {
  executeGrowthIdempotentCommand,
  growthHttpIdempotencyKeyHash,
  type GrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import type { ReviseFinancialPortfolioInput } from
  "./financial-portfolio-revision.js";
import type { FinancialCouncilPortfolioKind } from
  "./growth-contract-types.js";
import type { FinancialCouncilApprovalRecord } from
  "./financial-council-approval.js";
import type { FinancialCouncilPortfolioRevision } from
  "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const CREATE_PATH = "/api/v1/finance/council-runs";
const REVISE_PATH = "/api/v1/finance/council-runs/:runId/portfolio-revisions";
const APPROVE_PATH = "/api/v1/finance/council-runs/:runId/portfolio-revisions/:revision/approve";
const REJECT_PATH = "/api/v1/finance/council-runs/:runId/reject";

export interface FinancialCouncilRouterDependencies {
  readonly service: Pick<FinancialCouncilService,
    "createRun" | "getRun" | "listEvents" | "revisePortfolio"
    | "getPortfolioRevision" | "approve" | "reject" | "getApproval"
    | "listDispatches">;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
  readonly commandContextFactory: GrowthCommandContextFactory;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly now?: () => string;
}

function route(action: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

function exactCreateInput(raw: unknown): FinancialCouncilCreateInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  const record = raw as Record<string, unknown>;
  const expected = ["businessReport", "currency", "dataAsOf", "policyVersionId"];
  if (Object.keys(record).sort().join("\u0000")
    !== expected.sort().join("\u0000")) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  try {
    const businessReport = canonicalBusinessReportInput(
      record.businessReport as FinancialCouncilCreateInput["businessReport"]
    );
    if (typeof record.currency !== "string"
      || record.currency !== businessReport.currency
      || typeof record.dataAsOf !== "string"
      || new Date(record.dataAsOf).toISOString() !== record.dataAsOf
      || typeof record.policyVersionId !== "string"
      || !record.policyVersionId.trim()
      || [...record.policyVersionId].length > 255) throw new Error();
    return Object.freeze({
      currency: record.currency,
      dataAsOf: record.dataAsOf,
      businessReport,
      policyVersionId: record.policyVersionId
    });
  } catch {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
}

function runId(req: Request): string {
  const value = req.params.runId;
  if (typeof value !== "string" || !value.trim()
    || value.trim() !== value || value.length > 255) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return value;
}

function revision(req: Request): number {
  const value = req.params.revision;
  if (!/^[1-9]\d*$/u.test(value ?? "")) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return parsed;
}

const PORTFOLIO_KINDS = new Set<FinancialCouncilPortfolioKind>([
  "balanced", "cash_first", "growth_first"
]);
const OWNER_ROLES = new Set(["finance", "profit", "cost", "cashflow", "tax"]);

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return record;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !value
    || [...value].length > 255) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return value;
}

function portfolioKind(value: unknown): FinancialCouncilPortfolioKind {
  if (typeof value !== "string" || !PORTFOLIO_KINDS.has(value as
    FinancialCouncilPortfolioKind)) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return value as FinancialCouncilPortfolioKind;
}

function exactRevisionInput(raw: unknown): ReviseFinancialPortfolioInput {
  const record = exactKeys(raw, ["baseRevision", "operations"]);
  if (!Number.isSafeInteger(record.baseRevision) || Number(record.baseRevision) < 1
    || !Array.isArray(record.operations) || record.operations.length < 1
    || record.operations.length > 100) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  const operations = record.operations.map((rawOperation) => {
    if (!rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)
      || Object.getPrototypeOf(rawOperation) !== Object.prototype) {
      throw new GrowthHttpError(422, "financial_council_input_invalid");
    }
    const operation = rawOperation as Record<string, unknown>;
    if (operation.kind === "select_portfolio") {
      const selected = exactKeys(rawOperation, ["kind", "portfolioKind"]);
      return Object.freeze({ kind: "select_portfolio" as const,
        portfolioKind: portfolioKind(selected.portfolioKind) });
    }
    if (operation.kind === "remove_action" || operation.kind === "restore_action") {
      const action = exactKeys(rawOperation, ["kind", "actionId"]);
      return Object.freeze({ kind: operation.kind, actionId: identifier(action.actionId) });
    }
    if (operation.kind === "replace_action_parameters") {
      const replacement = exactKeys(rawOperation, ["kind", "actionId", "parameters"]);
      const parameters = replacement.parameters;
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)
        || Object.getPrototypeOf(parameters) !== Object.prototype) {
        throw new GrowthHttpError(422, "financial_council_input_invalid");
      }
      const parameterRecord = parameters as Record<string, unknown>;
      const parameterKeys = Object.keys(parameterRecord);
      if (parameterKeys.length < 1 || parameterKeys.some((key) =>
        key !== "ownerRole" && key !== "durationDays")
        || (parameterRecord.ownerRole !== undefined
          && (typeof parameterRecord.ownerRole !== "string"
            || !OWNER_ROLES.has(parameterRecord.ownerRole)))
        || (parameterRecord.durationDays !== undefined
          && (!Number.isSafeInteger(parameterRecord.durationDays)
            || Number(parameterRecord.durationDays) < 1
            || Number(parameterRecord.durationDays) > 365))) {
        throw new GrowthHttpError(422, "financial_council_input_invalid");
      }
      return Object.freeze({
        kind: "replace_action_parameters" as const,
        actionId: identifier(replacement.actionId),
        parameters: Object.freeze({
          ...(parameterRecord.ownerRole === undefined ? {} : {
            ownerRole: parameterRecord.ownerRole as "finance" | "profit" | "cost" | "cashflow" | "tax"
          }),
          ...(parameterRecord.durationDays === undefined ? {} : {
            durationDays: Number(parameterRecord.durationDays)
          })
        })
      });
    }
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  });
  return Object.freeze({
    runId: "",
    baseRevision: Number(record.baseRevision),
    operations: Object.freeze(operations)
  });
}

function exactApprovalInput(raw: unknown): { readonly portfolioKind: FinancialCouncilPortfolioKind } {
  const record = exactKeys(raw, ["portfolioKind"]);
  return Object.freeze({ portfolioKind: portfolioKind(record.portfolioKind) });
}

function exactRejectInput(raw: unknown): {
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly reason: string;
} {
  const record = exactKeys(raw, ["portfolioRevision", "portfolioKind", "reason"]);
  if (!Number.isSafeInteger(record.portfolioRevision)
    || Number(record.portfolioRevision) < 1) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
  return Object.freeze({
    portfolioRevision: Number(record.portfolioRevision),
    portfolioKind: portfolioKind(record.portfolioKind),
    reason: identifier(record.reason)
  });
}

function projectRun(run: Awaited<ReturnType<FinancialCouncilService["getRun"]>>) {
  if (run.status === "created" || run.revision < 2
    || run.snapshotId === null || run.snapshotHash === null) {
    throw financialCouncilError("financial_council_integrity");
  }
  return Object.freeze({
    runId: run.runId,
    workspaceId: run.workspaceId,
    currency: run.currency,
    status: run.status,
    revision: run.revision,
    dataAsOf: run.dataAsOf,
    businessReport: run.businessReport,
    policyVersionId: run.policyVersionId,
    snapshotId: run.snapshotId,
    snapshotHash: run.snapshotHash,
    consensusReport: run.consensusReport,
    portfolios: run.portfolios,
    latestPortfolioRevision: run.latestPortfolioRevision,
    approval: run.approval,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    expiresAt: run.expiresAt
  });
}

function projectEvent(event: Awaited<ReturnType<
  FinancialCouncilService["listEvents"]
>>[number]) {
  return Object.freeze({
    eventId: event.eventId,
    runId: event.runId,
    revision: event.revision,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt
  });
}

function projectPortfolioRevision(revision: FinancialCouncilPortfolioRevision) {
  return Object.freeze({
    runId: revision.runId,
    revision: revision.revision,
    baseRevision: revision.baseRevision ?? null,
    portfolios: revision.portfolios,
    createdAt: revision.createdAt
  });
}

function projectApproval(approval: FinancialCouncilApprovalRecord) {
  return Object.freeze({
    approvalId: approval.approvalId,
    runId: approval.runId,
    portfolioRevision: approval.portfolioRevision,
    portfolioKind: approval.portfolioKind,
    status: approval.status,
    approvedActionIds: approval.approvedActionIds,
    requiredCapabilities: approval.requiredCapabilities,
    reason: approval.reason,
    approvedAt: approval.approvedAt
  });
}

async function approvalForRun(
  service: Pick<FinancialCouncilRouterDependencies["service"], "getApproval">,
  workspace: ActiveWorkspaceContext,
  runId: string,
  approvalId: string
): Promise<FinancialCouncilApprovalRecord> {
  const approval = await service.getApproval(workspace, approvalId);
  if (approval.runId !== runId) {
    throw new GrowthHttpError(404, "financial_council_run_not_found");
  }
  return approval;
}

function trustedError(error: unknown): {
  readonly status: number;
  readonly code: string;
} {
  try {
    if (error instanceof GrowthHttpError) {
      return { status: error.status, code: error.code };
    }
    if (error instanceof GrowthAuthorizationError) {
      return { status: 403, code: error.code };
    }
    if (isFinancialCouncilError(error)) {
      if (error.code === "financial_council_integrity") {
        return { status: 500, code: "financial_council_internal_error" };
      }
      const status = error.code === "financial_council_run_not_found" ? 404
        : error.code === "financial_council_policy_not_found" ? 404
        : error.code === "financial_council_policy_revision_conflict"
          || error.code === "financial_council_revision_conflict" ? 412
        : error.code === "financial_council_idempotency_conflict"
          || error.code === "financial_council_run_conflict"
          || error.code === "financial_council_snapshot_conflict"
          || error.code === "financial_council_policy_idempotency_conflict"
          || error.code === "financial_council_policy_version_conflict"
          || error.code === "financial_council_portfolio_revision_conflict"
          || error.code === "financial_council_approval_conflict"
          || error.code === "financial_council_approval_state_invalid"
          || error.code === "financial_council_portfolio_state_invalid"
          || error.code === "financial_council_policy_stale"
          || error.code === "financial_council_source_stale"
          || error.code === "financial_council_workspace_stale" ? 409
        : error.code === "financial_council_input_invalid"
            || error.code === "financial_council_policy_input_invalid"
            || error.code === "financial_council_policy_context_invalid"
            || error.code === "financial_council_policy_workspace_mismatch"
            || error.code === "financial_council_policy_currency_mismatch"
            || error.code === "financial_council_policy_default_invalid"
            || error.code === "financial_council_policy_coefficient_unknown"
            || error.code === "financial_council_transition_invalid"
            || error.code === "financial_council_timestamp_invalid"
            || error.code === "financial_council_context_invalid"
            || error.code === "financial_council_authority_workspace_mismatch"
            || error.code === "financial_council_authority_invalid"
            || error.code === "financial_council_authority_duplicate"
            || error.code === "financial_council_authority_query_truncated"
            || error.code === "financial_council_portfolio_operation_invalid"
            || error.code === "financial_council_portfolio_operation_duplicate"
            || error.code === "financial_council_portfolio_action_not_found"
            || error.code === "financial_council_approval_invalid"
            || error.code === "invalid_as_of" ? 422 : 500;
      return { status, code: error.code };
    }
  } catch {
    // Unknown objects, including hostile proxies, are opaque internal errors.
  }
  return { status: 500, code: "financial_council_internal_error" };
}

function sendError(req: Request, res: Response, error: unknown): void {
  const { code, status } = trustedError(error);
  const requestId = res.getHeader("X-Request-Id") as string;
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.removeHeader("ETag");
  res.end(JSON.stringify({
    code,
    message: code,
    details: null,
    requestId,
    retryable: code === "idempotency_in_progress"
  }));
}

export function createFinancialCouncilRouter(
  dependencies: FinancialCouncilRouterDependencies
): Router {
  const router = express.Router();
  const now = dependencies.now ?? (() => new Date().toISOString());
  router.use((req, res, next) => {
    const requestId = req.header("X-Request-Id")?.trim() || randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/", route(async (req, res) => {
    const body = exactCreateInput(req.body);
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: CREATE_PATH,
      pathParams: Object.freeze({}),
      payload: body,
      expectedRevision: null
    });
    let repositoryReplayed = false;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        method: "POST",
        canonicalPath: CREATE_PATH,
        key: `financial-council:http:${growthHttpIdempotencyKeyHash(
          command.idempotencyKey
        )}`,
        requestHash: command.requestHash,
        attemptedAt: now(),
        leaseOwner: `financial-council-http-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      if (!resourceId) throw new GrowthHttpError(409, "idempotency_conflict");
      return projectRun(await dependencies.service.getRun(
        command.workspace, resourceId
      ));
    }, async () => {
      const created = await dependencies.service.createRun(command, body);
      repositoryReplayed = created.replayed;
      return { resourceId: created.value.runId, operationId: null };
    });
    if (result.replayed || repositoryReplayed) {
      res.setHeader("Idempotency-Replayed", "true");
    }
    setRevisionEtag(
      res, "financial-council-run", result.value.runId, result.value.revision
    );
    res.status(202).json(result.value);
  }));

  router.get("/:runId", route(async (req, res) => {
    const id = runId(req);
    const run = await dependencies.service.getRun(
      dependencies.workspaceContext(req), id
    );
    setRevisionEtag(res, "financial-council-run", run.runId, run.revision);
    res.status(200).json(projectRun(run));
  }));

  router.get("/:runId/events", route(async (req, res) => {
    if (Object.keys(req.query).length !== 0) {
      throw new GrowthHttpError(422, "financial_council_input_invalid");
    }
    const id = runId(req);
    const events = await dependencies.service.listEvents(
      dependencies.workspaceContext(req), id
    );
    res.status(200).json(Object.freeze({
      items: Object.freeze(events.map(projectEvent)),
      nextAfter: null,
      hasMore: false
    }));
  }));

  router.post("/:runId/portfolio-revisions", route(async (req, res) => {
    const id = runId(req);
    const input = exactRevisionInput(req.body);
    const expectedRevision = parseIfMatchRevision(
      req, `financial-council-run:${id}`
    );
    const payload = Object.freeze({ ...input, runId: id });
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: REVISE_PATH,
      pathParams: Object.freeze({ runId: id }),
      payload,
      expectedRevision
    });
    let immediate: FinancialCouncilPortfolioRevision | null = null;
    let repositoryReplayed = false;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId, actorId: command.actorId,
        method: "POST", canonicalPath: REVISE_PATH,
        key: `financial-council-revision:http:${growthHttpIdempotencyKeyHash(command.idempotencyKey)}`,
        requestHash: command.requestHash, attemptedAt: now(),
        leaseOwner: `financial-council-revision-http-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId, operationId) => {
      if (immediate) return immediate;
      const parsed = Number(operationId);
      if (!resourceId || !Number.isSafeInteger(parsed)) {
        throw new GrowthHttpError(409, "idempotency_conflict");
      }
      return dependencies.service.getPortfolioRevision(command.workspace, resourceId, parsed);
    }, async () => {
      const revised = await dependencies.service.revisePortfolio(command, payload);
      immediate = revised.value;
      repositoryReplayed = revised.replayed;
      return { resourceId: revised.value.runId, operationId: String(revised.value.revision) };
    });
    if (result.replayed || repositoryReplayed) res.setHeader("Idempotency-Replayed", "true");
    const run = await dependencies.service.getRun(command.workspace, id);
    setRevisionEtag(res, "financial-council-run", id, run.revision);
    res.status(200).json(projectPortfolioRevision(result.value));
  }));

  router.post("/:runId/portfolio-revisions/:revision/approve", route(async (req, res) => {
    const id = runId(req);
    const portfolioRevision = revision(req);
    const body = exactApprovalInput(req.body);
    const expectedRevision = parseIfMatchRevision(req, `financial-council-run:${id}`);
    const payload = Object.freeze({ runId: id, portfolioRevision, ...body });
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: APPROVE_PATH,
      pathParams: Object.freeze({ runId: id, revision: String(portfolioRevision) }),
      payload, expectedRevision
    });
    let immediate: FinancialCouncilApprovalRecord | null = null;
    let repositoryReplayed = false;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId, actorId: command.actorId,
        method: "POST", canonicalPath: APPROVE_PATH,
        key: `financial-council-approve:http:${growthHttpIdempotencyKeyHash(command.idempotencyKey)}`,
        requestHash: command.requestHash, attemptedAt: now(),
        leaseOwner: `financial-council-approve-http-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      if (immediate) return immediate;
      if (!resourceId) throw new GrowthHttpError(409, "idempotency_conflict");
      return approvalForRun(dependencies.service, command.workspace, id, resourceId);
    }, async () => {
      const approved = await dependencies.service.approve(command, payload);
      immediate = approved.value;
      repositoryReplayed = approved.replayed;
      return { resourceId: approved.value.approvalId, operationId: null };
    });
    if (result.replayed || repositoryReplayed) res.setHeader("Idempotency-Replayed", "true");
    const run = await dependencies.service.getRun(command.workspace, id);
    setRevisionEtag(res, "financial-council-run", id, run.revision);
    res.status(202).json(projectApproval(result.value));
  }));

  router.post("/:runId/reject", route(async (req, res) => {
    const id = runId(req);
    const body = exactRejectInput(req.body);
    const expectedRevision = parseIfMatchRevision(req, `financial-council-run:${id}`);
    const payload = Object.freeze({ runId: id, ...body });
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: REJECT_PATH, pathParams: Object.freeze({ runId: id }),
      payload, expectedRevision
    });
    let immediate: FinancialCouncilApprovalRecord | null = null;
    let repositoryReplayed = false;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId, actorId: command.actorId,
        method: "POST", canonicalPath: REJECT_PATH,
        key: `financial-council-reject:http:${growthHttpIdempotencyKeyHash(command.idempotencyKey)}`,
        requestHash: command.requestHash, attemptedAt: now(),
        leaseOwner: `financial-council-reject-http-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      if (immediate) return immediate;
      if (!resourceId) throw new GrowthHttpError(409, "idempotency_conflict");
      return approvalForRun(dependencies.service, command.workspace, id, resourceId);
    }, async () => {
      const rejected = await dependencies.service.reject(command, payload);
      immediate = rejected.value;
      repositoryReplayed = rejected.replayed;
      return { resourceId: rejected.value.approvalId, operationId: null };
    });
    if (result.replayed || repositoryReplayed) res.setHeader("Idempotency-Replayed", "true");
    const run = await dependencies.service.getRun(command.workspace, id);
    setRevisionEtag(res, "financial-council-run", id, run.revision);
    res.status(200).json(projectApproval(result.value));
  }));

  router.get("/:runId/dispatches", route(async (req, res) => {
    if (Object.keys(req.query).length !== 0) {
      throw new GrowthHttpError(422, "financial_council_input_invalid");
    }
    const id = runId(req);
    const items = await dependencies.service.listDispatches(
      dependencies.workspaceContext(req), id
    );
    res.status(200).json(Object.freeze({ items, nextAfter: null, hasMore: false }));
  }));

  router.use((error: unknown, req: Request, res: Response,
    _next: NextFunction) => sendError(req, res, error));
  return router;
}

export interface FinancialCouncilPolicyRouterDependencies {
  readonly service: Pick<FinancialCouncilService,
    "getPolicy" | "getPolicyVersion" | "updatePolicy">;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
  readonly commandContextFactory: GrowthCommandContextFactory;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly now?: () => string;
}

function exactPolicyInput(raw: unknown): FinancialCouncilPolicyInput {
  try {
    return normalizeFinancialCouncilPolicyInput(
      raw as FinancialCouncilPolicyInput
    );
  } catch (error) {
    if (isFinancialCouncilError(error)) {
      throw new GrowthHttpError(422, error.code);
    }
    throw new GrowthHttpError(422, "financial_council_policy_input_invalid");
  }
}

function projectPolicy(policy: FinancialCouncilPolicyVersion) {
  return Object.freeze({
    policyVersionId: policy.policyVersionId,
    workspaceId: policy.workspaceId,
    version: policy.version,
    revision: policy.revision,
    currency: policy.currency,
    balancedWeightsBps: policy.balancedWeightsBps,
    minimumCashReserveMinor: policy.minimumCashReserveMinor,
    dueDebtMinor: policy.dueDebtMinor,
    necessaryOutflowMinor: policy.necessaryOutflowMinor,
    budgetLimitMinor: policy.budgetLimitMinor,
    capacityLimitUnits: policy.capacityLimitUnits,
    durationLimitDays: policy.durationLimitDays,
    minimumActionConfidenceBps: policy.minimumActionConfidenceBps,
    actionCoefficientVersion: policy.actionCoefficientVersion,
    policyHash: policy.policyHash,
    createdAt: policy.createdAt
  });
}

export function createFinancialCouncilPolicyRouter(
  dependencies: FinancialCouncilPolicyRouterDependencies
): Router {
  const router = express.Router();
  const now = dependencies.now ?? (() => new Date().toISOString());
  router.use((req, res, next) => {
    const requestId = req.header("X-Request-Id")?.trim() || randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", route(async (req, res) => {
    if (Object.keys(req.query).length !== 0) {
      throw new GrowthHttpError(422, "financial_council_policy_input_invalid");
    }
    const context = dependencies.workspaceContext(req);
    const policy = await dependencies.service.getPolicy(context);
    setRevisionEtag(
      res, "financial-council-policy", context.workspaceId, policy.revision
    );
    res.status(200).json(projectPolicy(policy));
  }));
  router.put("/", route(async (req, res) => {
    const body = exactPolicyInput(req.body);
    const workspace = dependencies.workspaceContext(req);
    const expectedRevision = parseIfMatchRevision(
      req, `financial-council-policy:${workspace.workspaceId}`
    );
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: "/api/v1/finance/council-policy",
      pathParams: Object.freeze({}),
      payload: body,
      expectedRevision
    });
    let repositoryReplayed = false;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        method: "PUT",
        canonicalPath: "/api/v1/finance/council-policy",
        key: `financial-council-policy:http:${growthHttpIdempotencyKeyHash(
          command.idempotencyKey
        )}`,
        requestHash: command.requestHash,
        attemptedAt: now(),
        leaseOwner: `financial-council-policy-http-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      if (!resourceId) throw new GrowthHttpError(409, "idempotency_conflict");
      return projectPolicy(await dependencies.service.getPolicyVersion(
        command.workspace, resourceId
      ));
    }, async () => {
      const created = await dependencies.service.updatePolicy(command, body);
      repositoryReplayed = created.replayed;
      return {
        resourceId: created.value.policyVersionId,
        operationId: null
      };
    });
    if (result.replayed || repositoryReplayed) {
      res.setHeader("Idempotency-Replayed", "true");
    }
    setRevisionEtag(
      res, "financial-council-policy", command.workspace.workspaceId,
      result.value.revision
    );
    res.status(200).json(result.value);
  }));
  router.use((error: unknown, req: Request, res: Response,
    _next: NextFunction) => sendError(req, res, error));
  return router;
}
