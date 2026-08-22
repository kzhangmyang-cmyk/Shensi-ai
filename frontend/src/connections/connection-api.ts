export interface SearchProvider {
  id: string;
  kind: "search" | "content_fetch" | "import";
  displayName: string;
  officialDocsUrl?: string;
  defaultBaseUrl?: string;
  requiresKey?: boolean;
  keyHint?: string;
  costNote?: string;
  capabilities: string[];
}

export interface SearchConnection {
  id: string;
  ownerId?: string;
  teamId?: string | null;
  providerId: string;
  kind: "search" | "content_fetch" | "import";
  status: "active" | "inactive" | "disabled" | "error";
  credentialVersion: number;
  lastHealthAt?: string | null;
  lastHealthStatus: "untested" | "passed" | "failed";
  lastErrorCode?: string | null;
  lastHealthMessage?: string;
  usage?: string;
  createdAt?: string;
}

export interface SearchConnectionCreateInput {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  status?: "active" | "disabled";
}

export interface SearchConnectionUpdateInput {
  apiKey?: string;
  baseUrl?: string;
  status?: "active" | "disabled";
}

export interface ConnectionHealth {
  ok: boolean;
  message: string;
  errorCode?: string | null;
  retryable?: boolean;
  retryAfterAt?: string | null;
  usage?: string;
}

export interface ModelEndpointProfile {
  provider: string;
  endpointProfileId: string;
  region: string;
  baseUrl: string | null;
  requiresWorkspaceId: boolean;
  modelListPolicy: "same_key" | "not_exposed" | "separate_control_plane";
  officialReference: string;
}

export interface ModelConnection {
  id: string;
  ownerId?: string;
  teamId?: string | null;
  provider: string;
  model: string;
  endpointProfileId?: string;
  endpointRegion?: string;
  endpointWorkspaceId?: string | null;
  adapterVersion?: string;
  baseUrlFingerprint?: string;
  credentialVersion: number;
  capabilitySnapshot: {
    structuredOutput?: boolean;
    toolCalling: boolean;
    parallelToolCalling?: boolean;
    streaming?: boolean;
    modelListing?: boolean;
  };
  capabilityCertificationHash?: string;
  status: "active" | "inactive" | "disabled";
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelConnectionCreateInput {
  provider: string;
  name?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  active?: boolean;
}

export interface ModelConnectionUpdateInput {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ConnectionSettingsApiOptions {
  cookieSource?: () => string;
  idempotencyKeyFactory?: () => string;
}

interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

interface ErrorEnvelope {
  message?: unknown;
  error?: { message?: unknown };
}

function defaultCookieSource(): string {
  return typeof document === "undefined" ? "" : document.cookie;
}

function csrfFromCookie(cookie: string): string {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("gj_csrf="))
    ?.slice("gj_csrf=".length);
  if (!encoded) throw new Error("登录会话缺少 CSRF 令牌，请重新登录");
  try {
    const decoded = decodeURIComponent(encoded);
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch {
    throw new Error("CSRF 令牌格式无效，请重新登录");
  }
}

function errorMessage(body: ErrorEnvelope, status: number): string {
  if (typeof body.error?.message === "string" && body.error.message.trim()) {
    return body.error.message;
  }
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message;
  }
  return `请求失败（HTTP ${status}）`;
}

function pathSegment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("连接 ID 不能为空");
  return encodeURIComponent(normalized);
}

function idempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new Error("幂等键必须为 1 到 200 个字符");
  }
  return key;
}

export function createConnectionSettingsApi(
  fetchImpl: typeof fetch = fetch,
  options: ConnectionSettingsApiOptions = {}
) {
  const cookieSource = options.cookieSource ?? defaultCookieSource;
  const keyFactory = options.idempotencyKeyFactory
    ?? (() => globalThis.crypto.randomUUID());

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("X-CSRF-Token", csrfFromCookie(cookieSource()));
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
    }
    const response = await fetchImpl(path, {
      credentials: "same-origin",
      ...init,
      headers
    });
    const body = await response.json().catch(() => ({})) as T & ErrorEnvelope;
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body;
  }

  function getPage<T>(path: string): Promise<Page<T>> {
    return request<Page<T>>(path, { method: "GET" });
  }

  function jsonRequest<T>(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
    useIdempotency = false,
    stableKey?: string
  ): Promise<T> {
    const headers = new Headers();
    if (useIdempotency) {
      headers.set(
        "Idempotency-Key",
        idempotencyKey(stableKey ?? keyFactory())
      );
    }
    return request<T>(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }

  return {
    async listSearchProviders(): Promise<SearchProvider[]> {
      return (await getPage<SearchProvider>(
        "/api/v1/acquisition/providers"
      )).items ?? [];
    },

    async listSearchConnections(): Promise<SearchConnection[]> {
      return (await getPage<SearchConnection>(
        "/api/v1/acquisition/provider-connections"
      )).items ?? [];
    },

    createSearchConnection(
      input: SearchConnectionCreateInput,
      stableKey?: string
    ): Promise<SearchConnection> {
      return jsonRequest(
        "/api/v1/acquisition/provider-connections",
        "POST",
        input,
        true,
        stableKey
      );
    },

    updateSearchConnection(
      id: string,
      input: SearchConnectionUpdateInput
    ): Promise<SearchConnection> {
      return jsonRequest(
        `/api/v1/acquisition/provider-connections/${pathSegment(id)}`,
        "PATCH",
        input
      );
    },

    testSearchConnection(id: string): Promise<ConnectionHealth> {
      return jsonRequest(
        `/api/v1/acquisition/provider-connections/${pathSegment(id)}/test`,
        "POST"
      );
    },

    async deleteSearchConnection(id: string): Promise<void> {
      await jsonRequest(
        `/api/v1/acquisition/provider-connections/${pathSegment(id)}`,
        "DELETE"
      );
    },

    async listModelEndpointProfiles(): Promise<ModelEndpointProfile[]> {
      return (await getPage<ModelEndpointProfile>(
        "/api/v1/ai/endpoint-profiles"
      )).items ?? [];
    },

    async listModelConnections(): Promise<ModelConnection[]> {
      return (await getPage<ModelConnection>(
        "/api/v1/ai/connections"
      )).items ?? [];
    },

    createModelConnection(
      input: ModelConnectionCreateInput,
      stableKey?: string
    ): Promise<ModelConnection> {
      return jsonRequest(
        "/api/v1/ai/connections",
        "POST",
        input,
        true,
        stableKey
      );
    },

    updateModelConnection(
      id: string,
      input: ModelConnectionUpdateInput,
      stableKey?: string
    ): Promise<ModelConnection> {
      return jsonRequest(
        `/api/v1/ai/connections/${pathSegment(id)}`,
        "PATCH",
        input,
        true,
        stableKey
      );
    },

    activateModelConnection(
      id: string,
      reason: string,
      stableKey?: string
    ): Promise<ModelConnection> {
      return jsonRequest(
        `/api/v1/ai/connections/${pathSegment(id)}/activate`,
        "POST",
        { reason },
        true,
        stableKey
      );
    },

    testModelConnection(id: string): Promise<ConnectionHealth> {
      return jsonRequest(
        "/api/tools/ai-config/test",
        "POST",
        { id }
      );
    },

    async deleteModelConnection(
      id: string,
      stableKey?: string
    ): Promise<void> {
      await jsonRequest(
        `/api/v1/ai/connections/${pathSegment(id)}`,
        "DELETE",
        undefined,
        true,
        stableKey
      );
    }
  };
}
