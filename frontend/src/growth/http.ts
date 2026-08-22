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
  return Object.freeze({
    async request<T>(
      path: string,
      requestOptions: GrowthHttpRequestOptions = {}
    ) {
      const method = requestOptions.method ?? "GET";
      const headers: Record<string, string> = {
        Accept: "application/json"
      };
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
