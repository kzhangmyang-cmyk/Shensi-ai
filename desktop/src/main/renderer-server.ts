import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
// One raw 5 MiB file (three for statement packages), plus bounded JSON metadata.
// Keep these transport budgets aligned with backend/src/server.ts; decoded
// per-file and spreadsheet safety limits remain owned by the import services.
const FINANCE_FILE_BASE64_BYTES = Math.ceil((5 * 1024 * 1024) / 3) * 4;
const FINANCE_JSON_ENVELOPE_BYTES = 64 * 1024;
const FINANCE_UPLOAD_BODY_BYTES = new Map([
  ["/api/v1/decision-simulations/preparations", FINANCE_FILE_BASE64_BYTES + FINANCE_JSON_ENVELOPE_BYTES],
  ["/api/v1/finance/documents/inspect", FINANCE_FILE_BASE64_BYTES + FINANCE_JSON_ENVELOPE_BYTES],
  ["/api/v1/finance/imports/preview", FINANCE_FILE_BASE64_BYTES + FINANCE_JSON_ENVELOPE_BYTES],
  ["/api/v1/finance/statement-packages/preview", 3 * FINANCE_FILE_BASE64_BYTES + FINANCE_JSON_ENVELOPE_BYTES],
]);
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const BUILD_HEADER = "x-shensi-desktop-build-manifest-sha256";
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-encoding",
  "content-length",
]);

export interface RendererServer {
  origin: string;
  close(): Promise<void>;
}

export interface RendererServerOptions {
  distDir: string;
  remoteOrigin: string;
  buildManifestSha256: string;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  upstreamTimeoutMs?: number;
}

/** Route-specific deadlines cover each backend model operation and its bounded repair. */
export function rendererUpstreamBudget(method: string | undefined, pathname: string,
  options: Pick<RendererServerOptions, "upstreamTimeoutMs" | "maxResponseBytes"> = {}) {
  const sourceRead = method === "POST" && pathname === "/api/v1/finance/documents/inspect";
  const decisionUpload=method==='POST'&&pathname==='/api/v1/decision-simulations/preparations';
  const decisionResult=(method==='POST'&&pathname==='/api/v1/decision-simulations') || (method==='GET'&&/^\/api\/v1\/decision-simulations\/(?:preparations\/)?[0-9a-f-]{36}$/u.test(pathname));
  const modelRead = sourceRead || (method === "POST" && pathname === "/api/v1/finance/cfo-conversation");
  // Keyword tool-calling uses one 30s attempt; the existing connection test
  // uses up to two 120s structured attempts. Keep ordinary APIs bounded at 10s.
  const keywordRead = method === "POST"
    && /^\/api\/v1\/acquisition\/plans\/[^/]+\/automation\/keyword-suggestions$/u.test(pathname);
  const connectionTest = method === "POST" && pathname === "/api/tools/ai-config/test";
  const timeoutMs = decisionUpload ? 120_000 : connectionTest ? 250_000 : keywordRead ? 40_000
    : modelRead ? 130_000 : DEFAULT_UPSTREAM_TIMEOUT_MS;
  return { timeoutMs: options.upstreamTimeoutMs ?? timeoutMs,
    responseBytes: options.maxResponseBytes ?? (decisionResult||decisionUpload ? 16*1024*1024 : sourceRead ? 8 * 1024 * 1024 : DEFAULT_MAX_RESPONSE_BYTES) };
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly closeConnection = false,
  ) {
    super(publicMessage);
  }
}

function parseRemoteOrigin(value: string): URL {
  const target = new URL(value);
  if (!["http:", "https:"].includes(target.protocol)
    || target.origin !== value.replace(/\/$/u, "")) {
    throw new Error("remoteOrigin must be an HTTP(S) origin");
  }
  return target;
}

function rewriteCookie(value: string): string {
  if (/;\s*Partitioned|(?:__Secure-|__Host-)/iu.test(value)) return "";
  return value
    .replace(/;\s*Domain=[^;]*/iu, "")
    .replace(/;\s*Path=[^;]*/iu, "; Path=/")
    .replace(/;\s*Secure/iu, "")
    .replace(/;\s*SameSite=None/iu, "; SameSite=Lax");
}

function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  if (request.method === "GET" || request.method === "HEAD") return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(parts));
    };
    const onData = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > maxBytes) {
        request.pause();
        finish(new HttpFailure(413, "Request too large", true));
      } else {
        parts.push(chunk);
      }
    };
    const onEnd = () => finish();
    const onError = () => finish(new HttpFailure(400, "Invalid request", true));
    const onAborted = () => finish(new HttpFailure(400, "Request aborted", true));
    const timer = setTimeout(
      () => finish(new HttpFailure(408, "Request timeout", true)),
      timeoutMs,
    );
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpFailure(413, "Response too large");
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      const chunk = Buffer.from(value.value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpFailure(413, "Response too large");
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

async function staticFile(distDir: string, pathname: string): Promise<string | null> {
  const decoded = decodeURIComponent(pathname);
  const candidate = path.resolve(distDir, `.${decoded}`);
  if (candidate !== path.resolve(distDir)
    && !candidate.startsWith(`${path.resolve(distDir)}${path.sep}`)) return null;
  try {
    const resolved = await realpath(candidate);
    return resolved.startsWith(`${distDir}${path.sep}`) && (await stat(resolved)).isFile()
      ? resolved
      : null;
  } catch {
    return null;
  }
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function sendFailure(
  request: IncomingMessage,
  response: ServerResponse,
  failure: HttpFailure,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) response.statusCode = failure.status;
  if (failure.closeConnection && !response.headersSent) {
    response.setHeader("connection", "close");
    response.shouldKeepAlive = false;
    response.once("finish", () => request.destroy());
  }
  response.end(failure.publicMessage);
}

function hasTrustedLocalProvenance(request: IncomingMessage, localOrigin: string): boolean {
  const expectedHost = new URL(localOrigin).host;
  if (request.headers.host !== expectedHost) return false;
  for (const name of ["origin", "referer", "sec-fetch-site"] as const) {
    if (Array.isArray(request.headers[name])) return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== localOrigin) return false;
  const referer = request.headers.referer;
  if (referer !== undefined) {
    try {
      if (new URL(referer).origin !== localOrigin) return false;
    } catch {
      return false;
    }
  }
  return request.headers["sec-fetch-site"] !== "cross-site";
}

export async function startRendererServer(options: RendererServerOptions): Promise<RendererServer> {
  const buildManifestSha256 = options.buildManifestSha256;
  if (typeof buildManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(buildManifestSha256)) {
    throw new Error("buildManifestSha256 must be a canonical SHA-256 digest");
  }
  const distDir = await realpath(options.distDir);
  const upstream = parseRemoteOrigin(options.remoteOrigin);
  const maxBodyBytes = options.maxBodyBytes;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let localOrigin: string | null = null;

  const server = createServer(async (request, response) => {
    try {
      if (closing) throw new HttpFailure(503, "Gateway closing", true);
      if (!localOrigin || !hasTrustedLocalProvenance(request, localOrigin)) {
        throw new HttpFailure(403, "Forbidden", true);
      }
      const rawPath = (request.url ?? "/").split("?", 1)[0]!;
      if (/%2e|%2f|%5c/iu.test(rawPath)
        || decodeURIComponent(rawPath).split("/").includes("..")) {
        throw new HttpFailure(404, "Not found");
      }
      const url = new URL(request.url ?? "/", "http://local");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const budget = rendererUpstreamBudget(request.method, url.pathname, options);
        const routeBodyBytes = request.method === "POST"
          ? FINANCE_UPLOAD_BODY_BYTES.get(url.pathname) : undefined;
        const requestBody = await readRequestBody(request,
          maxBodyBytes ?? routeBodyBytes ?? DEFAULT_MAX_BODY_BYTES, requestTimeoutMs);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value && !HOP_BY_HOP_HEADERS.has(key)
            && !["host", "origin", "referer", BUILD_HEADER].includes(key.toLowerCase())) {
            headers.set(key, Array.isArray(value) ? value.join(",") : value);
          }
        }
        headers.set("origin", upstream.origin);
        headers.set("referer", `${upstream.origin}/`);
        headers.set(BUILD_HEADER, buildManifestSha256);

        const controller = new AbortController();
        upstreamRequests.add(controller);
        const abortDisconnectedRequest = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", abortDisconnectedRequest);
        if (response.destroyed) controller.abort();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budget.timeoutMs);
        timer.unref();
        try {
          const upstreamResponse = await fetch(
            new URL(`${url.pathname}${url.search}`, upstream),
            {
              method: request.method,
              headers,
              body: ["GET", "HEAD"].includes(request.method ?? "") ? undefined : requestBody,
              redirect: "manual",
              signal: controller.signal,
            },
          );
          if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
            await upstreamResponse.body?.cancel().catch(() => undefined);
            throw new HttpFailure(502, "Gateway redirect denied");
          }
          const data = await readResponseBody(upstreamResponse, budget.responseBytes);
          response.statusCode = upstreamResponse.status;
          upstreamResponse.headers.forEach((value, key) => {
            if (!HOP_BY_HOP_HEADERS.has(key) && key !== "set-cookie")
              response.setHeader(key, value);
          });
          const responseHeaders = upstreamResponse.headers as Headers & {
            getSetCookie?: () => string[];
          };
          const cookies = responseHeaders.getSetCookie?.()
            ?? (upstreamResponse.headers.get("set-cookie")
              ? [upstreamResponse.headers.get("set-cookie")!]
              : []);
          const rewritten = cookies.map(rewriteCookie).filter(Boolean);
          if (rewritten.length) response.setHeader("set-cookie", rewritten);
          response.end(data);
        } catch (error) {
          if (timedOut) throw new HttpFailure(504, "Gateway timeout");
          throw error;
        } finally {
          clearTimeout(timer);
          response.off("close", abortDisconnectedRequest);
          upstreamRequests.delete(controller);
        }
        return;
      }

      const file = await staticFile(distDir, url.pathname)
        ?? (url.pathname.includes(".") ? null : await staticFile(distDir, "/index.html"));
      if (!file) throw new HttpFailure(404, "Not found");
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-type", contentType(file));
      const stream = createReadStream(file);
      stream.once("error", () => {
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
      stream.pipe(response);
    } catch (error) {
      sendFailure(
        request,
        response,
        error instanceof HttpFailure ? error : new HttpFailure(502, "Gateway error"),
      );
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("renderer server did not bind");
  localOrigin = `http://127.0.0.1:${address.port}`;

  return {
    origin: localOrigin,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of upstreamRequests) controller.abort();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
