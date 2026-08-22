import { randomUUID } from "node:crypto";
import express from "express";
import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import {
  AcquisitionDiscoveryOperationError,
  type AcquisitionDiscoveryOperationErrorCode,
  type AcquisitionDiscoveryOperationService,
  type AcquisitionDiscoveryScope
} from "./acquisition-discovery-operations.js";

const contentFetchInputSchema = z.object({
  sourceUrl: z.string().trim().min(1).max(4_096),
  subjectChannel: z.enum(["organization", "individual"])
}).strict();

const operationIdSchema = z.string().trim().min(1).max(160);
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
}).strict();
const subjectChannelSchema = z.enum(["organization", "individual"]);
const fileNameSchema = z.string().trim().min(1).max(255);
const columnMappingSchema = z.object({
  sourceTitle: z.string().trim().min(1).max(200),
  sourceSnippet: z.string().trim().min(1).max(200),
  sourcePlatform: z.string().trim().min(1).max(200).optional(),
  sourceUrl: z.string().trim().min(1).max(200).optional(),
  publishedAt: z.string().trim().min(1).max(200).optional(),
  locale: z.string().trim().min(1).max(200).optional()
}).strict();
const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function metadataText(
  req: Request,
  key: string,
  headerNames: string[]
) {
  const value = req.query[key];
  const candidates: string[] = [];
  if (value !== undefined) {
    if (typeof value !== "string") {
      throw new AcquisitionDiscoveryOperationsHttpError(
        "invalid_request",
        `${key} 查询参数必须是字符串`,
        400
      );
    }
    candidates.push(value);
  }
  for (const headerName of headerNames) {
    const headerValue = req.header(headerName);
    if (headerValue !== undefined) candidates.push(headerValue);
  }
  const first = candidates[0];
  if (!first) {
    throw new AcquisitionDiscoveryOperationsHttpError(
      "invalid_request",
      `必须提供 ${key} 元数据`,
      400
    );
  }
  if (candidates.some((candidate) => candidate !== first)) {
    throw new AcquisitionDiscoveryOperationsHttpError(
      "invalid_request",
      `${key} 查询参数与请求头不能冲突`,
      400
    );
  }
  return first;
}

function importMediaType(contentType: string, fileName: string) {
  const normalized = contentType
    .split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase();
  if (normalized === "text/csv") return "text/csv" as const;
  if (normalized === XLSX_MEDIA_TYPE) return XLSX_MEDIA_TYPE;
  if (normalized === "application/octet-stream"
    && fileName.toLocaleLowerCase().endsWith(".csv")) {
    return "text/csv" as const;
  }
  if (normalized === "application/octet-stream"
    && fileName.toLocaleLowerCase().endsWith(".xlsx")) {
    return XLSX_MEDIA_TYPE;
  }
  throw new AcquisitionDiscoveryOperationsHttpError(
    "unsupported_media_type",
    "导入文件媒体类型与文件扩展名不受支持",
    415
  );
}

function rawImportBody(req: Request) {
  if (!Buffer.isBuffer(req.body)) {
    throw new AcquisitionDiscoveryOperationsHttpError(
      "unsupported_media_type",
      "导入文件必须使用受支持的原始二进制媒体类型",
      415
    );
  }
  return req.body;
}

function parsedMapping(value: string) {
  try {
    return columnMappingSchema.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof ZodError) throw error;
    throw new AcquisitionDiscoveryOperationsHttpError(
      "invalid_request",
      "mapping 必须是有效的 JSON 对象",
      400
    );
  }
}

export interface AcquisitionDiscoveryOperationsRouterOptions {
  service: AcquisitionDiscoveryOperationService;
  dispatchContentFetchOperation: (
    scope: AcquisitionDiscoveryScope,
    operationId: string
  ) => Promise<void>;
  dispatchImportOperation: (
    scope: AcquisitionDiscoveryScope,
    operationId: string
  ) => Promise<void>;
  requestIdFactory?: () => string;
}

class AcquisitionDiscoveryOperationsHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AcquisitionDiscoveryOperationsHttpError";
  }
}

const operationErrorHttp: Record<
  AcquisitionDiscoveryOperationErrorCode,
  { status: number; message: string }
> = {
  INVALID_REQUEST: {
    status: 400,
    message: "请求参数无效"
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "获客发现操作不存在"
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "Idempotency-Key 已用于不同请求"
  },
  UNSAFE_SOURCE_URL: {
    status: 400,
    message: "来源 URL 不符合安全策略"
  },
  CONTENT_FETCH_FAILED: {
    status: 502,
    message: "公开内容抓取失败"
  },
  UNSUPPORTED_CONTENT_TYPE: {
    status: 415,
    message: "内容类型不受支持"
  },
  RESPONSE_TOO_LARGE: {
    status: 413,
    message: "公开内容响应超过大小限制"
  },
  IMPORT_ARTIFACT_INVALID: {
    status: 422,
    message: "导入文件内容无效"
  },
  IMPORT_LIMIT_EXCEEDED: {
    status: 413,
    message: "导入文件超过处理限制"
  },
  IMPORT_PROCESSING_FAILED: {
    status: 500,
    message: "导入文件处理失败"
  },
  OPERATION_ALREADY_RUNNING: {
    status: 409,
    message: "获客发现操作已在运行"
  },
  ABORTED: {
    status: 409,
    message: "获客发现操作已中止"
  }
};

function scopeFromRequest(req: Request): AcquisitionDiscoveryScope {
  const user = req.user;
  if (!user?.id || !user.teamId) {
    throw new AcquisitionDiscoveryOperationsHttpError(
      "unauthorized",
      "需要登录后访问",
      401
    );
  }
  return {
    ownerId: user.id,
    teamId: user.teamId,
    actorId: user.id
  };
}

function idempotencyKey(req: Request) {
  const key = req.header("Idempotency-Key")?.trim() ?? "";
  if (!key || key.length > 200) {
    throw new AcquisitionDiscoveryOperationsHttpError(
      key ? "invalid_idempotency_key" : "idempotency_key_required",
      key
        ? "Idempotency-Key 不能超过 200 个字符"
        : "必须提供 Idempotency-Key 请求头",
      400
    );
  }
  return key;
}

function requestId(res: Response) {
  return String(res.locals.acquisitionDiscoveryRequestId ?? "");
}

function sendError(error: unknown, res: Response) {
  let code = "internal_error";
  let message = "获客发现操作服务暂时不可用";
  let status = 500;
  let details: unknown = null;

  if (error instanceof ZodError) {
    code = "invalid_request";
    message = "请求参数不符合获客发现操作接口约束";
    status = 400;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  } else if (
    error
    && typeof error === "object"
    && (
      (error as { type?: unknown }).type === "entity.too.large"
      || (error as { status?: unknown }).status === 413
    )
  ) {
    code = "import_limit_exceeded";
    message = "导入文件不能超过 5 MiB";
    status = 413;
  } else if (error instanceof AcquisitionDiscoveryOperationsHttpError) {
    ({ code, message, status } = error);
  } else if (error instanceof AcquisitionDiscoveryOperationError) {
    const mapped = operationErrorHttp[error.code];
    code = error.code.toLocaleLowerCase();
    message = mapped.message;
    status = mapped.status;
  }

  res.status(status).json({
    code,
    message,
    details,
    requestId: requestId(res),
    retryable: status >= 500
  });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

export function createAcquisitionDiscoveryOperationsRouter(
  options: AcquisitionDiscoveryOperationsRouterOptions
) {
  const router = Router();
  const createRequestId = options.requestIdFactory
    ?? (() => `request_${randomUUID()}`);

  router.use("/api/v1/acquisition", (_req, res, next) => {
    const id = createRequestId();
    res.locals.acquisitionDiscoveryRequestId = id;
    res.setHeader("X-Request-Id", id);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.use("/api/v1/acquisition", (req, res, next) => {
    try {
      scopeFromRequest(req);
      next();
    } catch (error) {
      sendError(error, res);
    }
  });

  router.post(
    "/api/v1/acquisition/content-fetch-operations",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const operation =
        await options.service.createContentFetchOperation(
          scope,
          contentFetchInputSchema.parse(req.body),
          idempotencyKey(req),
          { queueStandaloneCommentEnrichment: true }
        );
      await options.dispatchContentFetchOperation(scope, operation.id);
      res.status(202).json(operation);
    })
  );

  router.get(
    "/api/v1/acquisition/content-fetch-operations",
    asyncRoute(async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      const items =
        await options.service.listContentFetchOperations(
          scopeFromRequest(req),
          { limit: query.limit }
        );
      res.json({ items });
    })
  );

  router.get(
    "/api/v1/acquisition/content-fetch-operations/:id",
    asyncRoute(async (req, res) => {
      const operation =
        await options.service.getContentFetchOperation(
          scopeFromRequest(req),
          operationIdSchema.parse(req.params.id)
        );
      res.json(operation);
    })
  );

  router.post(
    "/api/v1/acquisition/import-operations",
    express.raw({
      type: ["text/csv", XLSX_MEDIA_TYPE, "application/octet-stream"],
      limit: 5 * 1024 * 1024
    }),
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const fileName = fileNameSchema.parse(metadataText(
        req,
        "fileName",
        [
          "fileName",
          "File-Name",
          "X-File-Name",
          "X-Acquisition-File-Name"
        ]
      ));
      const operation = await options.service.createImportOperation(
        scope,
        {
          fileName,
          mediaType: importMediaType(
            req.header("Content-Type") ?? "",
            fileName
          ),
          content: rawImportBody(req),
          subjectChannel: subjectChannelSchema.parse(
            metadataText(
              req,
              "subjectChannel",
              [
                "subjectChannel",
                "Subject-Channel",
                "X-Subject-Channel",
                "X-Acquisition-Subject-Channel"
              ]
            )
          ),
          columnMapping: parsedMapping(metadataText(
            req,
            "mapping",
            [
              "mapping",
              "Column-Mapping",
              "X-Column-Mapping",
              "X-Acquisition-Mapping"
            ]
          ))
        },
        idempotencyKey(req)
      );
      await options.dispatchImportOperation(scope, operation.id);
      res.status(202).json(operation);
    })
  );

  router.get(
    "/api/v1/acquisition/import-operations",
    asyncRoute(async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      const items = await options.service.listImportOperations(
        scopeFromRequest(req),
        { limit: query.limit }
      );
      res.json({ items });
    })
  );

  router.get(
    "/api/v1/acquisition/import-operations/:id",
    asyncRoute(async (req, res) => {
      const operation = await options.service.getImportOperation(
        scopeFromRequest(req),
        operationIdSchema.parse(req.params.id)
      );
      res.json(operation);
    })
  );

  router.use(
    "/api/v1/acquisition",
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      sendError(error, res);
    }
  );

  return router;
}
