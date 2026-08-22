import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import XLSX from "xlsx-js-style";
import { GrowthHttpError, type CommandContext } from "./growth-command-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  type GrowthCommandContextFactory,
  type GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";
import type {
  FinanceImportKind,
  FinanceImportOperation,
  FinanceImportPreviewRow,
  FinanceImportRowErrorCode
} from "./finance-import-repository.js";
import type {
  FinanceImportPreviewResult,
  FinanceImportService
} from "./finance-import-service.js";

const idSchema = z.string().min(1).max(191)
  .refine((value) => value.trim() === value);
const kindSchema = z.enum(["acquisition_cost", "financial_fact"]);
const mediaTypeSchema = z.enum([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
const previewBodySchema = z.object({
  kind: kindSchema,
  fileName: z.string().min(1).max(200),
  mediaType: mediaTypeSchema,
  contentBase64: z.string().min(1),
  mapping: z.record(z.string().min(1).max(200), z.string().min(1).max(200))
}).strict();

function requiredWorkspace(req: Request): void {
  const workspaceId = req.header("X-Workspace-Id")?.trim();
  if (!workspaceId || workspaceId === "all") {
    throw new GrowthHttpError(403, "workspace_required");
  }
}

function requireIdempotency(req: Request): void {
  const key = req.header("Idempotency-Key");
  if (key === undefined || !key.trim()) {
    throw new GrowthHttpError(400, "idempotency_key_required");
  }
  if (key.length > 200) {
    throw new GrowthHttpError(400, "invalid_idempotency_key");
  }
}

function requireImportCapability(
  options: FinanceImportRouterOptions,
  req: Request
): void {
  requireGrowthCapabilities(
    options.workspaceContext(req), ["ledger.pending.create"]
  );
}

function command(
  options: FinanceImportRouterOptions,
  req: Request,
  canonicalPath: string,
  pathParams: Readonly<Record<string, string>>,
  payload: unknown
): CommandContext {
  requiredWorkspace(req);
  requireIdempotency(req);
  return options.commandContextFactory(req, {
    canonicalPath,
    pathParams,
    payload,
    expectedRevision: null
  });
}

function replay(res: Response, value: boolean): void {
  res.setHeader("Idempotency-Replayed", value ? "true" : "false");
}

function jsonWithoutEtag(
  res: Response,
  status: number,
  value: unknown
): void {
  res.status(status).json(value);
}

function route(action: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

export interface PublicFinanceImportOperation {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: FinanceImportKind;
  readonly status: "previewed" | "queued" | "running" | "succeeded"
    | "failed" | "requires_review";
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export function projectFinanceImportOperation(
  operation: FinanceImportOperation
): PublicFinanceImportOperation {
  return Object.freeze({
    id: operation.id,
    workspaceId: operation.workspaceId,
    kind: operation.templateVersion.startsWith("finance-cost-")
      ? "acquisition_cost"
      : "financial_fact",
    status: operation.status === "partial_success"
      ? "requires_review"
      : operation.status,
    totalRows: operation.validRows + operation.invalidRows,
    acceptedRows: operation.validRows,
    rejectedRows: operation.invalidRows,
    createdAt: operation.createdAt,
    completedAt: operation.status === "succeeded"
      || operation.status === "partial_success"
      || operation.status === "failed"
      ? operation.updatedAt : null
  });
}

export interface PublicFinanceImportPreview {
  readonly previewId: string;
  readonly kind: FinanceImportKind;
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly errors: Array<{
    rowNumber: number;
    code: FinanceImportRowErrorCode;
    field: string | null;
    message: string;
  }>;
  readonly expiresAt: string;
}

export function projectFinanceImportPreview(
  result: FinanceImportPreviewResult
): PublicFinanceImportPreview {
  const errors = result.rows
    .filter((row) => row.status === "invalid")
    .flatMap((row) => row.errors.map((code) => ({
      rowNumber: row.rowNumber,
      code,
      field: null,
      message: code
    })));
  return Object.freeze({
    previewId: result.previewId,
    kind: result.kind,
    totalRows: result.validRows + result.invalidRows,
    acceptedRows: result.validRows,
    rejectedRows: result.invalidRows,
    errors,
    expiresAt: "1970-01-01T00:00:00.000Z"
  });
}

export interface FinanceImportRouterOptions {
  imports: FinanceImportService;
  workspaceContext: GrowthWorkspaceContextResolver;
  commandContextFactory: GrowthCommandContextFactory;
  now?: () => string;
}

export function createFinanceImportRouter(
  options: FinanceImportRouterOptions
): Router {
  const router = express.Router();

  router.get("/api/v1/finance/import-templates/:kind", route(async (req, res) => {
    requiredWorkspace(req);
    requireImportCapability(options, req);
    const kind = kindSchema.parse(req.params.kind);
    const template = await options.imports.template(
      command(options, req, "/api/v1/finance/import-templates/:kind",
        Object.freeze({ kind }), {}),
      kind
    );
    const workbook = XLSX.utils.book_new();
    const headers = template.headers.map((header, index) =>
      `${header}(${template.labels[index] ?? ""})`);
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([headers]),
      "template"
    );
    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx"
    }) as Buffer;
    res.status(200)
      .setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${kind}-template.xlsx"`
      )
      .send(buffer);
  }));

  router.post("/api/v1/finance/imports/preview", route(async (req, res) => {
    requiredWorkspace(req);
    requireIdempotency(req);
    requireImportCapability(options, req);
    const payload = previewBodySchema.parse(req.body);
    const content = Buffer.from(payload.contentBase64, "base64");
    const context = command(options, req, "/api/v1/finance/imports/preview",
      Object.freeze({}), payload);
    const result = await options.imports.preview(context, {
      kind: payload.kind,
      fileName: payload.fileName,
      mediaType: payload.mediaType,
      content,
      mapping: payload.mapping
    });
    replay(res, result.replayed);
    jsonWithoutEtag(res, 200, projectFinanceImportPreview(result));
  }));

  router.post("/api/v1/finance/imports/:previewId/commit",
    route(async (req, res) => {
      requiredWorkspace(req);
      requireIdempotency(req);
      requireImportCapability(options, req);
      const previewId = idSchema.parse(req.params.previewId);
      const context = command(options, req,
        "/api/v1/finance/imports/:previewId/commit",
        Object.freeze({ previewId }), {});
      const execution = await options.imports.queueCommit(context, previewId);
      replay(res, execution.replayed);
      res.status(202).json(projectFinanceImportOperation(execution.operation));
    }));

  router.get("/api/v1/finance/imports/:id", route(async (req, res) => {
    requiredWorkspace(req);
    requireImportCapability(options, req);
    const id = idSchema.parse(req.params.id);
    const projection = await options.imports.get(
      {
        workspace: options.workspaceContext(req),
        actorId: req.header("X-Actor-Id")?.trim() ?? "finance-a",
        idempotencyKey: `get-${id}`,
        requestHash: `sha256:${"0".repeat(64)}`,
        expectedRevision: null
      },
      id
    );
    if (!projection) throw new GrowthHttpError(404, "finance_import_not_found");
    jsonWithoutEtag(
      res, 200, projectFinanceImportOperation(projection.operation)
    );
  }));

  router.get("/api/v1/finance/imports/:id/errors", route(async (req, res) => {
    requiredWorkspace(req);
    requireImportCapability(options, req);
    const id = idSchema.parse(req.params.id);
    const projection = await options.imports.get(
      {
        workspace: options.workspaceContext(req),
        actorId: req.header("X-Actor-Id")?.trim() ?? "finance-a",
        idempotencyKey: `get-errors-${id}`,
        requestHash: `sha256:${"0".repeat(64)}`,
        expectedRevision: null
      },
      id
    );
    if (!projection) throw new GrowthHttpError(404, "finance_import_not_found");
    const errors = projection.rows
      .filter((row) => row.status === "invalid")
      .flatMap((row: FinanceImportPreviewRow) =>
        row.errors.map((code) => ({
          rowNumber: row.rowNumber,
          code,
          field: null,
          message: code
        })));
    jsonWithoutEtag(res, 200, {
      items: errors,
      nextAfter: null,
      hasMore: false
    });
  }));

  return router;
}
