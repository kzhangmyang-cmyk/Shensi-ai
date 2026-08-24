import { z } from "zod";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const upstreamCommit = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092" as const;

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("shensi-mediacrawler"),
  upstream_commit: z.literal(upstreamCommit)
}).strict();
const loginSessionResponseSchema = z.object({
  session_id: z.string().min(1),
  state: z.enum(["awaiting_scan", "active", "expired", "failed"]),
  qr_image_data_url: z.string().startsWith("data:image/").nullable(),
  expires_at: z.string().datetime(),
  account_handle: z.string().min(1).nullable(),
  account_display_name: z.string().nullable(),
  login_state_version: z.number().int().positive().nullable()
}).strict();

type GatewayCode = "mediacrawler_unavailable" | "mediacrawler_invalid_response";

class MediaCrawlerGatewayError extends Error {
  readonly code: GatewayCode;

  constructor(code: GatewayCode) {
    super(code);
    this.name = "MediaCrawlerGatewayError";
    this.code = code;
  }
}

export interface DouyinMediaCrawlerGateway {
  health(signal?: AbortSignal): Promise<Readonly<{
    ok: true;
    service: "shensi-mediacrawler";
    upstreamCommit: "d6f7c5bb906b6dac40ddf343ef9e26438a3de092";
  }>>;
  createLoginSession(signal?: AbortSignal): Promise<DouyinLoginSession>;
  getLoginSession(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  disconnectLoginSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export interface DouyinLoginSession {
  sessionId: string;
  state: "awaiting_scan" | "active" | "expired" | "failed";
  qrImageDataUrl: string | null;
  expiresAt: string;
  accountHandle: string | null;
  accountDisplayName: string | null;
  loginStateVersion: number | null;
}

export interface DouyinMediaCrawlerGatewayOptions {
  baseUrl: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isPrivateHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const privateIpv4 = /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/u.test(host);
  const privateIpv6 = host === "::1" || /^f[cd][0-9a-f:]*$/u.test(host) || /^fe[89ab][0-9a-f:]*$/u.test(host);
  if (url.protocol !== "http:" || url.username || url.password || !(host === "localhost" || privateIpv4 || privateIpv6)) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  return url;
}

function normalizedSecret(value: string): string {
  if (/\s/u.test(value) || Buffer.byteLength(value, "utf8") < 32) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  return value;
}

function requestAbortSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createDouyinMediaCrawlerGateway(
  options: DouyinMediaCrawlerGatewayOptions
): DouyinMediaCrawlerGateway {
  const baseUrl = isPrivateHttpUrl(options.baseUrl);
  const serviceSecret = normalizedSecret(options.serviceSecret);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  async function loginSessionRequest(
    method: "GET" | "POST", path: string, signal?: AbortSignal
  ): Promise<DouyinLoginSession> {
    const request = requestAbortSignal(signal, timeoutMs);
    try {
      if (request.signal.aborted) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      const response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: { authorization: `Bearer ${serviceSecret}` },
        signal: request.signal
      });
      if (!response.ok) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      let body: unknown;
      try { body = JSON.parse(await responseText(response)); } catch (error) {
        if (error instanceof MediaCrawlerGatewayError) throw error;
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      const parsed = loginSessionResponseSchema.safeParse(body);
      if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      return Object.freeze({
        sessionId: parsed.data.session_id, state: parsed.data.state,
        qrImageDataUrl: parsed.data.qr_image_data_url, expiresAt: parsed.data.expires_at,
        accountHandle: parsed.data.account_handle,
        accountDisplayName: parsed.data.account_display_name,
        loginStateVersion: parsed.data.login_state_version
      });
    } catch (error) {
      if (error instanceof MediaCrawlerGatewayError) throw error;
      throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
    } finally { request.dispose(); }
  }

  return Object.freeze({
    createLoginSession(signal?: AbortSignal) {
      return loginSessionRequest("POST", "/internal/v1/douyin/login-sessions", signal);
    },
    getLoginSession(sessionId: string, signal?: AbortSignal) {
      return loginSessionRequest("GET", `/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`, signal);
    },
    async disconnectLoginSession(sessionId: string, signal?: AbortSignal) {
      const request = requestAbortSignal(signal, timeoutMs);
      try {
        const response = await fetchImpl(new URL(`/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`, baseUrl), { method: "DELETE", headers: { authorization: `Bearer ${serviceSecret}` }, signal: request.signal });
        if (!response.ok && response.status !== 404) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      } catch (error) { if (error instanceof MediaCrawlerGatewayError) throw error; throw new MediaCrawlerGatewayError("mediacrawler_unavailable"); } finally { request.dispose(); }
    },
    async health(signal?: AbortSignal) {
      const request = requestAbortSignal(signal, timeoutMs);
      try {
        if (request.signal.aborted) {
          throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
        }
        const response = await fetchImpl(new URL("/internal/v1/health", baseUrl), {
          headers: { authorization: `Bearer ${serviceSecret}` },
          signal: request.signal
        });
        if (!response.ok) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
        let body: unknown;
        try {
          body = JSON.parse(await responseText(response));
        } catch (error) {
          if (error instanceof MediaCrawlerGatewayError) throw error;
          throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
        }
        const parsed = healthResponseSchema.safeParse(body);
        if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
        return Object.freeze({
          ok: parsed.data.ok,
          service: parsed.data.service,
          upstreamCommit: parsed.data.upstream_commit
        });
      } catch (error) {
        if (error instanceof MediaCrawlerGatewayError) throw error;
        throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      } finally {
        request.dispose();
      }
    }
  });
}
