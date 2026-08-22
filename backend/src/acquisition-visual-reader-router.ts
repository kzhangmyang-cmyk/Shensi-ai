import express, {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import {
  AcquisitionVisualReaderServiceError,
  type AcquisitionVisualReaderService
} from "./acquisition-visual-reader-service.js";
import { sendStandardApiError } from "./acquisition-api-error-response.js";

export const ACQUISITION_VISUAL_READER_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/u;

export interface AcquisitionVisualReaderRouterOptions {
  service: AcquisitionVisualReaderService;
}

class VisualReaderHttpError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "VisualReaderHttpError";
  }
}

function scope(req: Request) {
  const user = req.user as { id?: unknown; teamId?: unknown } | undefined;
  if (typeof user?.id !== "string" || !user.id
    || typeof user.teamId !== "string" || !user.teamId) {
    throw new VisualReaderHttpError("unauthorized", 401);
  }
  return { ownerId: user.id, teamId: user.teamId, actorId: user.id };
}

function idempotencyKey(req: Request) {
  const raw = req.header("Idempotency-Key");
  if (raw === undefined) {
    throw new VisualReaderHttpError("idempotency_key_required", 400);
  }
  if (!IDEMPOTENCY_KEY.test(raw)) {
    throw new VisualReaderHttpError("invalid_idempotency_key", 400);
  }
  return raw;
}

function bodyWithinLimit(req: Request, _res: Response, next: NextFunction) {
  try {
    const serialized = JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(serialized, "utf8")
      > ACQUISITION_VISUAL_READER_JSON_BODY_LIMIT_BYTES) {
      throw new VisualReaderHttpError("payload_too_large", 413);
    }
    next();
  } catch (error) {
    next(error);
  }
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function assertSessionPath(session: unknown, sessionId: string) {
  if (!session || typeof session !== "object"
    || (session as { sessionId?: unknown }).sessionId !== sessionId) {
    throw new Error("ACQUISITION_VISUAL_READER_RESPONSE_INTEGRITY");
  }
}

function sendSafeError(error: unknown, req: Request, res: Response) {
  const entityTooLarge = error && typeof error === "object"
    && (error as { type?: unknown }).type === "entity.too.large";
  const malformedJson = error instanceof SyntaxError
    && "body" in error;
  let code = "internal_error";
  let status = 500;
  if (entityTooLarge) {
    code = "payload_too_large";
    status = 413;
  } else if (malformedJson) {
    code = "invalid_json";
    status = 400;
  } else if (error instanceof VisualReaderHttpError
    || error instanceof AcquisitionVisualReaderServiceError) {
    code = error.code;
    status = error.status;
  }
  sendStandardApiError(req, res, status, {
    code,
    message: status === 500
      ? "Visual reader service unavailable"
      : "Visual reader request rejected"
  });
}

export function createAcquisitionVisualReaderRouter(
  options: AcquisitionVisualReaderRouterOptions
) {
  const router = Router();
  router.use(express.json({ limit: ACQUISITION_VISUAL_READER_JSON_BODY_LIMIT_BYTES }));
  router.use(bodyWithinLimit);

  router.post(
    "/api/v1/acquisition/visual-reader-sessions",
    asyncRoute(async (req, res) => {
      const result = await options.service.createSession(
        scope(req),
        req.body,
        idempotencyKey(req)
      );
      if (!result.created) res.setHeader("Idempotency-Replayed", "true");
      res.status(result.created ? 201 : 200).json(result.session);
    })
  );

  router.get(
    "/api/v1/acquisition/visual-reader-sessions/:sessionId",
    asyncRoute(async (req, res) => {
      const session = await options.service.getSession(
        scope(req),
        req.params.sessionId
      );
      assertSessionPath(session, req.params.sessionId);
      res.status(200).json(session);
    })
  );

  router.post(
    "/api/v1/acquisition/visual-reader-sessions/:sessionId/observations:batch",
    asyncRoute(async (req, res) => {
      const result = await options.service.appendObservationBatch(
        scope(req),
        req.params.sessionId,
        req.body,
        idempotencyKey(req)
      );
      assertSessionPath(result.response.session, req.params.sessionId);
      for (const accepted of result.response.accepted) {
        if (accepted.observation.sessionId !== req.params.sessionId) {
          throw new Error("ACQUISITION_VISUAL_READER_RESPONSE_INTEGRITY");
        }
      }
      if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
      res.status(200).json(result.response);
    })
  );

  router.post(
    "/api/v1/acquisition/visual-reader-sessions/:sessionId\\:complete",
    asyncRoute(async (req, res) => {
      idempotencyKey(req);
      const session = await options.service.completeSession(
        scope(req),
        req.params.sessionId,
        req.body
      );
      assertSessionPath(session, req.params.sessionId);
      res.status(200).json(session);
    })
  );

  router.post(
    "/api/v1/acquisition/visual-reader-sessions/:sessionId\\:abort",
    asyncRoute(async (req, res) => {
      idempotencyKey(req);
      const session = await options.service.abortSession(
        scope(req),
        req.params.sessionId,
        req.body
      );
      assertSessionPath(session, req.params.sessionId);
      res.status(200).json(session);
    })
  );

  router.get(
    "/api/v1/acquisition/visual-reader-artifacts/:artifactId",
    asyncRoute(async (req, res) => {
      const artifact = await options.service.getArtifact(
        scope(req),
        req.params.artifactId
      );
      if (artifact.mediaType !== "image/webp"
        || !Buffer.isBuffer(artifact.plaintext)) {
        throw new Error("ACQUISITION_VISUAL_READER_RESPONSE_INTEGRITY");
      }
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; sandbox"
      );
      res.status(200).send(artifact.plaintext);
    })
  );

  router.use((error: unknown, req: Request, res: Response,
    _next: NextFunction) => {
    sendSafeError(error, req, res);
  });
  return router;
}
