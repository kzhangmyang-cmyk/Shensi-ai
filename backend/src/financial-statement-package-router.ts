import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router }
  from "express";
import { requireGrowthCapabilities, GrowthAuthorizationError } from
  "./growth-capabilities.js";
import { GrowthHttpError } from "./growth-command-context.js";
import type { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";
import { FinancialStatementPackageError } from "./financial-statement-package.js";
import { FinancialStatementPackageRepositoryError } from
  "./financial-statement-package-repository.js";
import { executeGrowthIdempotentCommand,
  growthHttpIdempotencyKeyHash, type GrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import type { GrowthCommandContextFactory, GrowthWorkspaceContextResolver } from
  "./growth-http-preconditions.js";

const PREVIEW = "/api/v1/finance/statement-packages/preview";
const COMMIT = "/api/v1/finance/statement-packages/:previewId/commit";
function route(action: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void action(req, res).catch(next);
}
function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new GrowthHttpError(422, "financial_statement_input_invalid");
  }
  return value as Record<string, unknown>;
}
const STATEMENT_KINDS = ["balance_sheet", "income_statement",
  "cash_flow_statement"] as const;
const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function statementUploads(value: unknown) {
  if (!Array.isArray(value) || value.length !== STATEMENT_KINDS.length) {
    throw new GrowthHttpError(422, "financial_statement_three_uploads_required");
  }
  return Object.freeze(value.map((raw, index) => {
    const upload = exact(raw, ["kind", "fileName", "mediaType", "contentBase64"]);
    if (upload.kind !== STATEMENT_KINDS[index]
      || typeof upload.fileName !== "string" || !upload.fileName.trim()
      || upload.fileName.length > 255 || upload.mediaType !== XLSX_MEDIA_TYPE
      || typeof upload.contentBase64 !== "string" || !upload.contentBase64) {
      throw new GrowthHttpError(422, "financial_statement_input_invalid");
    }
    return Object.freeze({ kind: upload.kind, fileName: upload.fileName,
      mediaType: upload.mediaType, contentBase64: upload.contentBase64 });
  }));
}
function project(value: any) {
  return Object.freeze({
    ...(value.previewId ? { previewId: value.previewId } : {}),
    ...(value.packageId ? { packageId: value.packageId } : {}),
    status: value.status, expiresAt: value.expiresAt ?? null,
    companyName: value.companyName, currency: value.currency, period: value.period,
    sourceFiles: value.sourceFiles, parserVersion: value.parserVersion,
    warningCodes: value.warnings.map((item: { code: string }) => item.code),
    createdAt: value.createdAt
  });
}
function sendError(req: Request, res: Response, error: unknown) {
  let status = 500; let code = "financial_statement_internal_error";
  if (error instanceof GrowthHttpError) { status = error.status; code = error.code; }
  else if (error instanceof GrowthAuthorizationError) { status = 403; code = error.code; }
  else if (error instanceof FinancialStatementPackageError
    || error instanceof FinancialStatementPackageRepositoryError) {
    code = error.code; status = code.includes("not_found") ? 404
      : code.includes("expired") || code.includes("committed")
        || code.includes("conflict") ? 409 : 422;
  }
  res.status(status).json({ code, message: code, details: null,
    requestId: res.getHeader("X-Request-Id"), retryable: false });
}
export function createFinancialStatementPackageRouter(dependencies: {
  readonly service: Pick<FinancialStatementPackageService,
    "preview" | "commit" | "getPreview">;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
  readonly commandContextFactory: GrowthCommandContextFactory;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly now?: () => string;
}): Router {
  const router = express.Router(); const now = dependencies.now ??
    (() => new Date().toISOString());
  router.use((req, res, next) => { res.setHeader("X-Request-Id",
    req.header("X-Request-Id")?.trim() || randomUUID());
    res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/preview", route(async (req, res) => {
    const body = exact(req.body, ["statements"]);
    const uploads = statementUploads(body.statements);
    const context = dependencies.workspaceContext(req);
    requireGrowthCapabilities(context, ["ledger.pending.create"]);
    const payload = Object.freeze({ statements: uploads });
    const command = dependencies.commandContextFactory(req, { canonicalPath: PREVIEW,
      pathParams: Object.freeze({}), payload, expectedRevision: null });
    let immediate: any = null;
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency, reservation: {
        workspaceId: context.workspaceId, actorId: context.actorId, method: "POST",
        canonicalPath: PREVIEW,
        key: `statement-preview:http:${growthHttpIdempotencyKeyHash(command.idempotencyKey)}`,
        requestHash: command.requestHash, attemptedAt: now(),
        leaseOwner: `statement-preview-${randomUUID()}`, leaseDurationMs: 30_000
      }
    }, async (resourceId) => immediate ?? dependencies.service.getPreview({
      workspaceId: context.workspaceId, actorId: context.actorId
    }, resourceId!), async () => {
      immediate = await dependencies.service.preview({ workspaceId: context.workspaceId,
        actorId: context.actorId, idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash as `sha256:${string}` },
      { uploads: uploads as never });
      return { resourceId: immediate.previewId, operationId: null };
    });
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    res.status(200).json(project(result.value));
  }));
  router.post("/:previewId/commit", route(async (req, res) => {
    const previewId = req.params.previewId;
    if (!previewId?.trim() || previewId.length > 191) {
      throw new GrowthHttpError(422, "financial_statement_input_invalid");
    }
    const body = exact(req.body, ["consent"]);
    const consent = exact(body.consent, ["accepted", "noticeVersion"]);
    if (consent.accepted !== true
      || consent.noticeVersion !== "financial-model-data.v1") {
      throw new GrowthHttpError(422, "financial_statement_consent_required");
    }
    const context = dependencies.workspaceContext(req);
    requireGrowthCapabilities(context, ["ledger.pending.create"]);
    const payload = Object.freeze({ consent: Object.freeze({ accepted: true,
      noticeVersion: "financial-model-data.v1" }) });
    const command = dependencies.commandContextFactory(req, { canonicalPath: COMMIT,
      pathParams: Object.freeze({ previewId }), payload, expectedRevision: null });
    const result = await dependencies.service.commit({ workspaceId: context.workspaceId,
      actorId: context.actorId, idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash as `sha256:${string}` }, {
      previewId, consent: Object.freeze({ accepted: true,
        noticeVersion: "financial-model-data.v1", acceptedBy: context.actorId,
        acceptedAt: now() })
    });
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    res.status(201).json(project(result.value));
  }));
  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) =>
    sendError(req, res, error));
  return router;
}
