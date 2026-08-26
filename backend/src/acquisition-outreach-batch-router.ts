import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { AcquisitionOutreachBatchError, type AcquisitionOutreachBatchService } from "./acquisition-outreach-batch-service.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const id = z.string().trim().min(1).max(255);
const createSchema = z.object({ candidateIds: z.array(z.string().trim().min(1).max(255)).min(1).max(200) }).strict();
const putSchema = z.object({ candidates: z.array(z.object({ candidateId: z.string().trim().min(1).max(255),
  selected: z.boolean(), comment: z.string(), directMessage: z.string() }).strict()).min(1).max(200) }).strict();
const approveSchema = z.object({ revision: z.number().int().min(1), batchHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), confirm: z.literal(true) }).strict();
const reasonSchema = z.object({ reason: z.string().trim().max(2_000).optional() }).strict();
const emptySchema = z.object({}).strict();
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
function route(requestIdFactory: () => string,
  handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestIdFactory(); res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    void handler(req, res).catch((error) => {
      const failure = error instanceof AcquisitionOutreachBatchError
        ? error : error instanceof HttpError ? error
          : error instanceof ZodError ? new HttpError(400, "invalid_request")
            : new HttpError(500, "outreach_internal_error");
      res.status(failure.status).json({ code: failure.code, message: failure.code,
        details: error instanceof AcquisitionOutreachBatchError ? error.details : null,
        requestId, retryable: false });
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
}) {
  const router = Router(); const requestId = options.requestIdFactory ?? (() => `request_${crypto.randomUUID()}`);
  router.post("/runs/:runId/outreach-batches", route(requestId, async (req, res) => {
    const result = await options.service.create(scope(req), id.parse(req.params.runId), key(req), createSchema.parse(req.body));
    headers(res, result); res.status(201).json(result.value);
  }));
  router.get("/outreach-batches", route(requestId, async (req, res) => {
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
  router.get("/outreach-batches/:batchId", route(requestId, async (req, res) => {
    const value = await options.service.get(scope(req), id.parse(req.params.batchId));
    res.setHeader("ETag", value.etag); res.json(value);
  }));
  router.put("/outreach-batches/:batchId", route(requestId, async (req, res) => {
    const result = await options.service.put(scope(req), id.parse(req.params.batchId), match(req), key(req), putSchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  router.post("/outreach-batches/:batchId/approve", route(requestId, async (req, res) => {
    const result = await options.service.approve(scope(req), id.parse(req.params.batchId), match(req), key(req), approveSchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  for (const operation of ["reject", "pause"] as const) {
    router.post(`/outreach-batches/:batchId/${operation}`, route(requestId, async (req, res) => {
      const result = await options.service[operation](scope(req), id.parse(req.params.batchId), match(req), key(req), reasonSchema.parse(req.body));
      headers(res, result); res.json(result.value);
    }));
  }
  router.post("/outreach-batches/:batchId/resume", route(requestId, async (req, res) => {
    const result = await options.service.resume(scope(req), id.parse(req.params.batchId), match(req), key(req), emptySchema.parse(req.body));
    headers(res, result); res.json(result.value);
  }));
  router.get("/outreach-batches/:batchId/actions", route(requestId, async (req, res) => {
    res.json({ items: await options.service.actions(scope(req), id.parse(req.params.batchId)) });
  }));
  return router;
}
