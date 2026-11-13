import { csrfFromCookie } from "../acquisition/csrf";

export interface GrowthContractManifest {
  name: string;
  contractVersion: string;
  contractHash: string;
  openapiVersion: string;
}

export class GrowthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null = null,
    readonly etag: string | null = null,
    message = code
  ) {
    super(message);
    this.name = "GrowthApiError";
  }
}

export interface GrowthHttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  signal?: AbortSignal;
  onProgress?: (event: unknown) => void;
  referenceProtocol?: 'system-v1';
}

export interface GrowthHttpClient {
  request<T>(
    path: string,
    options?: GrowthHttpRequestOptions
  ): Promise<GrowthHttpResponse<T>>;
}

export interface GrowthHttpResponse<T> {
  status: number;
  etag: string | null;
  body: T;
}

export function createGrowthHttpClient(
  options: {
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    csrf?: () => string;
    baseUrl?: string;
    workspaceId?: () => string | null;
  } = {}
): GrowthHttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const csrf = options.csrf
    ?? (() => {
      try {
        return csrfFromCookie(document.cookie) ?? "";
      } catch {
        return "";
      }
    });
  const baseUrl = options.baseUrl ?? "";
  const workspaceId = options.workspaceId ?? (() => null);
  return Object.freeze({
    async request<T>(
      path: string,
      requestOptions: GrowthHttpRequestOptions = {}
    ) {
      const method = requestOptions.method ?? "GET";
      const headers: Record<string, string> = {
        Accept: requestOptions.onProgress ? 'application/x-ndjson' : "application/json"
      };
      if(method==='GET'&&requestOptions.referenceProtocol==='system-v1'&&/^\/api\/v1\/finance\/cfo-sessions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(path)){
        headers['X-Shensi-Reference-Protocol']='system-v1';
      }
      const activeWorkspaceId = workspaceId()?.trim();
      if (activeWorkspaceId && activeWorkspaceId !== "all") {
        headers["X-Workspace-Id"] = activeWorkspaceId;
      }
      if (requestOptions.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (method !== "GET") {
        const token = csrf();
        if (token) headers["x-csrf-token"] = token;
      }
      if (requestOptions.idempotencyKey) {
        headers["Idempotency-Key"] = requestOptions.idempotencyKey;
      }
      if (requestOptions.ifMatch) {
        headers["If-Match"] = requestOptions.ifMatch;
      }
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: requestOptions.body === undefined
          ? undefined
          : JSON.stringify(requestOptions.body),
        signal: requestOptions.signal
      });
      const etag = response.headers.get("etag");
      if (response.ok && requestOptions.onProgress && response.headers.get('content-type')?.includes('application/x-ndjson')) {
        const reader = response.body?.getReader(); if (!reader) throw new Error('growth_stream_unavailable');
        const decoder = new TextDecoder(); let buffer = ''; let result: unknown; let completed = false; let size = 0;
        const consume = (line: string) => {
          if (!line.trim()) return;
          if (completed) throw new Error('growth_stream_after_result');
          const event = JSON.parse(line);
          if (event.type === 'error') throw new GrowthApiError(Number(event.status) || 500, String(event.code || 'growth_api_error'));
          if (event.type === 'result') { result = event.result; completed = true; }
          else if (event.type === 'stage') requestOptions.onProgress?.(event);
          else throw new Error('growth_stream_invalid');
        };
        try {
          while (true) {
            const { value, done } = await reader.read();
            requestOptions.signal?.throwIfAborted();
            if (done) { buffer += decoder.decode(); consume(buffer); break; }
            size += value.byteLength; if (size > 2_000_000) throw new Error('growth_stream_too_large');
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          }
          if (!completed) throw new Error('growth_stream_incomplete');
          return Object.freeze({ status: response.status, etag, body: result as T });
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const envelope = body && typeof body === "object"
          ? body as { code?: unknown; requestId?: unknown }
          : {};
        const requestId = typeof envelope.requestId === "string"
          ? envelope.requestId : null;
        throw new GrowthApiError(
          response.status,
          typeof envelope.code === "string" ? envelope.code : "growth_api_error",
          requestId,
          etag,
          text
        );
      }
      return Object.freeze({
        status: response.status,
        etag,
        body: body as T
      });
    }
  });
}
