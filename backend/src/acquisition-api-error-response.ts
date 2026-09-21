import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function acquisitionRequest(req: Request) {
  const pathname = new URL(
    req.originalUrl || req.url,
    "http://localhost"
  ).pathname.toLocaleLowerCase("en-US");
  return pathname === "/api/v1/acquisition"
    || pathname.startsWith("/api/v1/acquisition/");
}

export function sendStandardApiError(
  req: Request,
  res: Response,
  status: number,
  input: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  }
) {
  const provided = String(req.header("X-Request-Id") || "").trim();
  const requestId = provided.slice(0, 100) || `request_${randomUUID()}`;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({
    code: input.code,
    message: input.message,
    details: input.details ?? null,
    requestId,
    retryable: input.retryable ?? status >= 500
  });
}

export function acquisitionApiRateLimitHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
  options: { statusCode: number; message: unknown }
) {
  if (!acquisitionRequest(req)) {
    res.status(options.statusCode).send(options.message);
    return;
  }
  sendStandardApiError(req, res, 429, {
    code: "rate_limit_exceeded",
    message: "请求过于频繁，请稍后再试",
    retryable: true
  });
}

export function acquisitionApiErrorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (acquisitionRequest(req)
    && error instanceof SyntaxError
    && "body" in error) {
    sendStandardApiError(req, res, 400, {
      code: "invalid_json",
      message: "JSON 格式不正确",
      retryable: false
    });
    return;
  }
  next(error);
}
