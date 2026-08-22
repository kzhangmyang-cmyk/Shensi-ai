import { randomUUID } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import {
  AcquisitionCandidateIntelligenceOperationError,
  type AcquisitionCandidateIntelligenceOperation,
  type AcquisitionCandidateIntelligenceScope
} from "./acquisition-candidate-intelligence-operations.js";

const idSchema = z.string().trim().min(1).max(160);
const emptyBodySchema = z.object({}).strict();

export interface AcquisitionCandidateIntelligenceOperationsRouterService {
  createAfterIdentity(
    scope: AcquisitionCandidateIntelligenceScope,
    candidateId: string,
    idempotencyKey: string
  ): Promise<AcquisitionCandidateIntelligenceOperation>;
  get(
    scope: AcquisitionCandidateIntelligenceScope,
    operationId: string
  ): Promise<AcquisitionCandidateIntelligenceOperation>;
  requestRetry(
    scope: AcquisitionCandidateIntelligenceScope,
    operationId: string,
    idempotencyKey: string
  ): Promise<{
    operation: AcquisitionCandidateIntelligenceOperation;
    shouldDispatch: boolean;
  }>;
  findLatestForCandidate(
    scope: AcquisitionCandidateIntelligenceScope,
    candidateId: string
  ): Promise<AcquisitionCandidateIntelligenceOperation | null>;
}

export interface AcquisitionCandidateIntelligenceOperationsRouterOptions {
  service: AcquisitionCandidateIntelligenceOperationsRouterService;
  dispatchOperation: (
    scope: AcquisitionCandidateIntelligenceScope,
    operationId: string
  ) => Promise<void>;
  requestIdFactory?: () => string;
}

class CandidateIntelligenceHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CandidateIntelligenceHttpError";
  }
}

function scopeFromRequest(req: Request): AcquisitionCandidateIntelligenceScope {
  const user = req.user;
  if (!user?.id || !user.teamId) {
    throw new CandidateIntelligenceHttpError(
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
  const value = req.header("Idempotency-Key")?.trim() ?? "";
  if (!value || value.length > 200) {
    throw new CandidateIntelligenceHttpError(
      value ? "invalid_idempotency_key" : "idempotency_key_required",
      value
        ? "Idempotency-Key 不能超过 200 个字符"
        : "必须提供 Idempotency-Key 请求头",
      400
    );
  }
  return value;
}

function parseEmptyBody(req: Request) {
  return emptyBodySchema.parse(req.body ?? {});
}

function publicOperation(operation: AcquisitionCandidateIntelligenceOperation) {
  return {
    id: operation.id,
    candidateId: operation.candidateId,
    status: operation.status,
    currentStage: operation.currentStage,
    completedStages: [...operation.completedStages],
    skippedStages: [...operation.skippedStages],
    research: operation.research === null
      ? null
      : structuredClone(operation.research),
    qualification: operation.qualification === null
      ? null
      : structuredClone(operation.qualification),
    battleCardId: operation.battleCardId,
    failure: operation.failure === null
      ? null
      : structuredClone(operation.failure),
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
    failedAt: operation.failedAt
  };
}

function operationErrorResponse(error: AcquisitionCandidateIntelligenceOperationError) {
  switch (error.code) {
    case "INVALID_REQUEST":
      return { status: 400, message: "请求参数无效" };
    case "RESOURCE_NOT_FOUND":
      return { status: 404, message: "候选智能研判任务不存在" };
    case "IDEMPOTENCY_CONFLICT":
      return { status: 409, message: "Idempotency-Key 已用于不同请求" };
    case "IDENTITY_NOT_RESOLVED":
      return { status: 409, message: "候选主体尚未完成公开身份核验" };
    case "OPERATION_ALREADY_RUNNING":
      return { status: 409, message: "候选智能研判任务已在运行" };
    default:
      return { status: 500, message: "候选智能研判服务暂时不可用" };
  }
}

function requestId(res: Response) {
  return String(res.locals.candidateIntelligenceRequestId ?? "");
}

function sendError(error: unknown, res: Response) {
  let code = "internal_error";
  let message = "候选智能研判服务暂时不可用";
  let status = 500;
  let details: unknown = null;

  if (error instanceof ZodError) {
    code = "invalid_request";
    message = "请求参数不符合候选智能研判接口约束";
    status = 400;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  } else if (error instanceof CandidateIntelligenceHttpError) {
    ({ code, message, status } = error);
  } else if (error instanceof AcquisitionCandidateIntelligenceOperationError) {
    const mapped = operationErrorResponse(error);
    code = error.code.toLocaleLowerCase("en-US");
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

export function createAcquisitionCandidateIntelligenceOperationsRouter(
  options: AcquisitionCandidateIntelligenceOperationsRouterOptions
) {
  const router = Router();
  const createRequestId = options.requestIdFactory
    ?? (() => `request_${randomUUID()}`);

  router.use("/api/v1/acquisition", (_req, res, next) => {
    const id = createRequestId();
    res.locals.candidateIntelligenceRequestId = id;
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
    "/api/v1/acquisition/candidates/:candidateId/intelligence-operations",
    asyncRoute(async (req, res) => {
      parseEmptyBody(req);
      const scope = scopeFromRequest(req);
      const created = await options.service.createAfterIdentity(
        scope,
        idSchema.parse(req.params.candidateId),
        idempotencyKey(req)
      );
      await options.dispatchOperation(scope, created.id);
      res.status(202).json(publicOperation(created));
    })
  );

  router.get(
    "/api/v1/acquisition/candidate-intelligence-operations/:operationId",
    asyncRoute(async (req, res) => {
      const loaded = await options.service.get(
        scopeFromRequest(req),
        idSchema.parse(req.params.operationId)
      );
      res.json(publicOperation(loaded));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:candidateId/intelligence-operation",
    asyncRoute(async (req, res) => {
      const loaded = await options.service.findLatestForCandidate(
        scopeFromRequest(req),
        idSchema.parse(req.params.candidateId)
      );
      if (!loaded) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      res.json(publicOperation(loaded));
    })
  );

  router.post(
    "/api/v1/acquisition/candidate-intelligence-operations/:operationId/retry",
    asyncRoute(async (req, res) => {
      parseEmptyBody(req);
      const scope = scopeFromRequest(req);
      const retry = await options.service.requestRetry(
        scope,
        idSchema.parse(req.params.operationId),
        idempotencyKey(req)
      );
      if (retry.shouldDispatch) {
        await options.dispatchOperation(scope, retry.operation.id);
      }
      res.status(202).json(publicOperation(retry.operation));
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
