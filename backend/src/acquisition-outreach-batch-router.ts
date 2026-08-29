import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { AcquisitionOutreachBatchError, type AcquisitionOutreachBatchService } from "./acquisition-outreach-batch-service.js";
import { ModelGatewayError } from "./model-providers/gateway.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string,
    readonly publicMessage = code, readonly retryable = false) { super(code); }
}
const id = z.string().trim().min(1).max(255);
const createSchema = z.object({ candidateIds: z.array(z.string().trim().min(1).max(255)).min(1).max(200) }).strict();
const putSchema = z.object({ candidates: z.array(z.object({ candidateId: z.string().trim().min(1).max(255),
  selected: z.boolean(), comment: z.string(), directMessage: z.string() }).strict()).min(1).max(200) }).strict();
const approveSchema = z.object({ revision: z.number().int().min(1), batchHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), confirm: z.literal(true) }).strict();
const directMessageApproveSchema = z.object({
  batchRevision: z.number().int().min(1),
  batchHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  commentApprovalHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  dailyLimit: z.number().int().min(1).max(100),
  candidates: z.array(z.object({ candidateId: z.string().trim().min(1).max(255),
    directMessage: z.string().min(1).max(800) }).strict()).min(1).max(100),
  confirm: z.literal(true)
}).strict();
const reasonSchema = z.object({ reason: z.string().trim().max(2_000).optional() }).strict();
const emptySchema = z.object({}).strict();
const reconcileSchema = z.object({
  batchRevision: z.number().int().min(1),
  approvalHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  confirm: z.literal(true)
}).strict();
const listQuerySchema = z.object({
  runId: id,
  candidateId: id,
  limit: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/u).default("20").transform(Number),
  cursor: z.string().min(1).max(8_192).optional()
}).strict();
const cursorPayloadSchema = z.object({
  v: z.literal(1),
  workspaceId: id,
  runId: id,
  candidateId: id,
  createdAt: z.string().datetime({ offset: true }),
  batchId: id
}).strict();
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export interface AcquisitionOutreachInternalErrorEvent {
  requestId: string;
  method: string;
  path: string;
  code: string;
  errorName: string;
  driverCode?: string;
  sqlState?: string;
  stackFingerprint?: string;
}

const defaultInternalError = (event: AcquisitionOutreachInternalErrorEvent) => {
  console.error(JSON.stringify({
    event: "acquisition_outreach_internal_error",
    ...event
  }));
};

function diagnosticFields(error: unknown): Pick<
  AcquisitionOutreachInternalErrorEvent,
  "driverCode" | "sqlState" | "stackFingerprint"
> {
  if (!(error instanceof Error)) return {};
  const record = error as Error & { code?: unknown; sqlState?: unknown };
  const driverCode = typeof record.code === "string"
    && /^[A-Z0-9_]{2,64}$/u.test(record.code)
    ? record.code : undefined;
  const sqlState = typeof record.sqlState === "string"
    && /^[A-Z0-9]{5}$/u.test(record.sqlState)
    ? record.sqlState : undefined;
  const stackFrames = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const stackFingerprint = stackFrames
    ? `sha256:${createHash("sha256").update(`${error.name}\n${stackFrames}`).digest("hex")}`
    : undefined;
  return {
    ...(driverCode ? { driverCode } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(stackFingerprint ? { stackFingerprint } : {})
  };
}

function encodeCursor(payload: CursorPayload, secret: string) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function decodeCursor(value: string, secret: string) {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.toString("base64url") !== signature
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return cursorPayloadSchema.parse(JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ));
  } catch { return null; }
}

function scope(req: Request) {
  if (!req.user?.id || !req.user.teamId) throw new HttpError(401, "unauthorized");
  const workspace = req.activeWorkspace;
  if (!workspace || workspace.actorId !== req.user.id || workspace.teamId !== req.user.teamId) {
    throw new HttpError(403, "workspace_context_invalid");
  }
  if (!workspace.capabilities?.includes("acquisition.outreach.approve" as never)) {
    throw new HttpError(403, "capability_forbidden");
  }
  return { workspaceId: workspace.workspaceId, ownerId: req.user.id,
    teamId: req.user.teamId, actorId: req.user.id };
}
function key(req: Request) {
  const value = req.header("Idempotency-Key")?.trim() ?? "";
  if (value.length < 8 || value.length > 200) throw new HttpError(400, "invalid_idempotency_key");
  return value;
}
function match(req: Request) {
  const value = req.header("If-Match")?.trim() ?? "";
  if (!value) throw new HttpError(428, "if_match_required");
  if (value.length > 255) throw new HttpError(400, "invalid_if_match");
  return value;
}
function modelFailure(error: ModelGatewayError) {
  if (error.code === "MODEL_RATE_LIMITED") {
    return new HttpError(429, "acquisition_model_rate_limited",
      "AI 模型请求过于频繁，请稍后重试", true);
  }
  if (error.code === "MODEL_PROVIDER_UNAVAILABLE"
    || error.code === "MODEL_TIMEOUT") {
    return new HttpError(503, "acquisition_model_unavailable",
      "AI 模型暂时不可用，请稍后重试", true);
  }
  if (error.code === "MODEL_EMPTY_RESPONSE"
    || error.code === "MODEL_CONTENT_FILTERED"
    || error.code === "MODEL_RESPONSE_INVALID"
    || error.code === "MODEL_SCHEMA_INVALID") {
    return new HttpError(422, "outreach_model_response_invalid",
      "AI 未返回符合要求的评论和私信草稿，请重试或切换模型");
  }
  return new HttpError(409, "active_acquisition_model_unavailable",
    "AI 模型连接不可用，请检查 API Key、模型和连接状态");
}
function knownDraftFailure(error: unknown) {
  if (error instanceof ModelGatewayError) return modelFailure(error);
  if (!(error instanceof Error)) return null;
  if (error.message === "OUTREACH_CANDIDATE_NOT_DRAFTABLE") {
    return new HttpError(409, "candidate_not_draftable",
      "所选候选人不符合外联草稿条件，请刷新候选人后重新选择");
  }
  if (error.message === "OUTREACH_EVIDENCE_FORGED") {
    return new HttpError(409, "candidate_evidence_invalid",
      "候选人证据已变更，请刷新后重新选择");
  }
  if (error.message === "MODEL_SNAPSHOT_UNAVAILABLE"
    || error.message === "ACTIVE_ACQUISITION_MODEL_UNAVAILABLE") {
    return new HttpError(409, "active_acquisition_model_unavailable",
      "请先启用一个支持工具调用的 AI 模型");
  }
  if (error.message === "OUTREACH_MODEL_RESPONSE_INVALID"
    || error.message === "OUTREACH_DRAFT_INVALID") {
    return new HttpError(422, "outreach_model_response_invalid",
      "AI 未返回符合要求的评论和私信草稿，请重试或切换模型");
  }
  return null;
}
function batchPublicMessage(code: string) {
  if (code === "outreach_candidate_projection_pending") {
    return "候选数据仍在采集中或等待最终入库；完成后才能生成或确认真实评论批次，当前不会排队任何动作";
  }
  if (code === "outreach_candidate_projection_unavailable") {
    return "本次采集未形成可审批的最终候选数据，请重新运行采集后再生成评论批次";
  }
  if (code === "outreach_comment_target_invalid") {
    return "所选候选人缺少可评论的视频证据，请返回候选人列表重新选择";
  }
  if (code === "outreach_direct_message_target_invalid") {
    return "所选候选人缺少可私信的抖音主页，请返回候选人列表重新选择";
  }
  return code;
}
function route(requestIdFactory: () => string,
  onInternalError: (event: AcquisitionOutreachInternalErrorEvent) => void,
  handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestIdFactory(); res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    void handler(req, res).catch((error) => {
      const failure = error instanceof AcquisitionOutreachBatchError
        ? error : error instanceof HttpError ? error
          : error instanceof ZodError ? new HttpError(400, "invalid_request")
            : knownDraftFailure(error)
              ?? new HttpError(500, "outreach_internal_error");
      if (failure.code === "outreach_internal_error") {
        try {
          onInternalError({
            requestId,
            method: req.method,
            path: req.path,
            code: failure.code,
            errorName: error instanceof Error ? error.name : typeof error,
            ...diagnosticFields(error)
          });
        } catch {
          // Diagnostics must never replace the safe public error response.
        }
      }
      res.status(failure.status).json({ code: failure.code,
        message: failure instanceof HttpError ? failure.publicMessage
          : batchPublicMessage(failure.code),
        details: error instanceof AcquisitionOutreachBatchError ? error.details : null,
        requestId,
        retryable: failure instanceof HttpError ? failure.retryable : false });
    });
  };
}
function headers(res: Response, result: { replayed: boolean; value: { etag: string } }) {
  res.setHeader("ETag", result.value.etag);
  if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
}

export function createAcquisitionOutreachBatchRouter(options: {
  service: AcquisitionOutreachBatchService; cursorSecret: string;
  requestIdFactory?: () => string;
  onInternalError?: (event: AcquisitionOutreachInternalErrorEvent) => void;
}) {
  const router = Router(); const requestId = options.requestIdFactory ?? (() => `request_${crypto.randomUUID()}`);
  const internalError = options.onInternalError ?? defaultInternalError;
  router.post("/runs/:runId/outreach-batches", route(requestId, internalError, async (req, res) => {
    const result = await options.service.create(scope(req), id.parse(req.params.runId), key(req), createSchema.parse(req.body));
    headers(res, result); res.status(201).json(result.value);
  }));
  router.get("/outreach-batches", route(requestId, internalError, async (req, res) => {
    const currentScope = scope(req);
    const query = listQuerySchema.parse(req.query);
    let after: { createdAt: string; batchId: string } | null = null;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, options.cursorSecret);
      if (!cursor || cursor.workspaceId !== currentScope.workspaceId
        || cursor.runId !== query.runId || cursor.candidateId !== query.candidateId) {
        throw new HttpError(400, "invalid_cursor");
      }
      after = { createdAt: cursor.createdAt, batchId: cursor.batchId };
    }
    const page = await options.service.listByRunCandidate(currentScope, {
      runId: query.runId, candidateId: query.candidateId,
      limit: query.limit, after
    });
    res.json({
      items: page.items,
      nextCursor: page.next ? encodeCursor({
        v: 1, workspaceId: currentScope.workspaceId,
        runId: query.runId, candidateId: query.candidateId,
        createdAt: page.next.createdAt, batchId: page.next.batchId
      }, options.cursorSecret) : null
    });
  }));
  router.get("/outreach-batches/:batchId", route(requestId, internalError, async (req, res) => {
    const value = await options.service.get(scope(req), id.parse(req.params.batchId));
    res.setHeader("ETag", value.etag); res.json(value);
  }));
  router.put("/outreach-batches/:batchId", route(requestId, internalError, async (req, res) => {
    const result = await options.service.put(scope(req), id.parse(req.params.batchId), match(req), key(req), putSchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  router.post("/outreach-batches/:batchId/approve", route(requestId, internalError, async (req, res) => {
    const result = await options.service.approve(scope(req), id.parse(req.params.batchId), match(req), key(req), approveSchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  router.post("/outreach-batches/:batchId/direct-messages/approve",
    route(requestId, internalError, async (req, res) => {
      const result = await options.service.approveDirectMessages(
        scope(req), id.parse(req.params.batchId), match(req), key(req),
        directMessageApproveSchema.parse(req.body)
      );
      headers(res, result); res.json(result.value);
    }));
  for (const operation of ["reject", "pause"] as const) {
    router.post(`/outreach-batches/:batchId/${operation}`, route(requestId, internalError, async (req, res) => {
      const result = await options.service[operation](scope(req), id.parse(req.params.batchId), match(req), key(req), reasonSchema.parse(req.body));
      headers(res, result); res.json(result.value);
    }));
  }
  router.post("/outreach-batches/:batchId/resume", route(requestId, internalError, async (req, res) => {
    const result = await options.service.resume(scope(req), id.parse(req.params.batchId), match(req), key(req), emptySchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  router.get("/outreach-batches/:batchId/actions", route(requestId, internalError, async (req, res) => {
    res.json({ items: await options.service.actions(scope(req), id.parse(req.params.batchId)) });
  }));
  router.post("/outreach-batches/:batchId/actions/:actionId/reconcile",
    route(requestId, internalError, async (req, res) => {
      key(req);
      const value = await options.service.reconcileAction(
        scope(req),
        id.parse(req.params.batchId),
        id.parse(req.params.actionId),
        reconcileSchema.parse(req.body),
      );
      res.json(value);
    }));
  return router;
}
