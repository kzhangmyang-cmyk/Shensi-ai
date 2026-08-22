import {
  createHmac,
  randomUUID
} from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError, type ZodType } from "zod";
import {
  ACQUISITION_CONTENT_FETCH_PROVIDER,
  ACQUISITION_IMPORT_PROVIDER,
  ACQUISITION_SEARCH_PROVIDER_IDS,
  ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS
} from "./acquisition-discovery-providers.js";
import {
  acquisitionProviderConnectionVersion
} from "./acquisition-provider-connection-version.js";
import {
  createCredentialRef,
  encryptProviderConfigurationWithSecret
} from "./credential-security.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { getProvider } from "./lead-providers.js";
import {
  ProviderContractError,
  type LeadProvider
} from "./provider-contract.js";
import { assertProviderBaseUrlAllowed } from "./provider-http-client.js";
import { providerRequiresKey } from "./provider-runtime.js";
import type {
  CrmStore,
  PersistedStoreMutation
} from "./store.js";
import type {
  ProviderCatalogItem,
  ProviderConnection
} from "./types.js";

export type AcquisitionProviderConnectionStore = Pick<
  CrmStore,
  | "providerCatalog"
  | "providerConnections"
  | "persist"
  | "persistMutation"
  | "readBarrier"
>;

export interface AcquisitionProviderConnectionsRouterOptions {
  store: AcquisitionProviderConnectionStore;
  credentialSecret: string;
  connectionTester?: AcquisitionProviderConnectionTester;
  requestIdFactory?: (prefix: string) => string;
  idFactory?: (prefix: string) => string;
  now?: () => string;
}

export interface AcquisitionProviderConnectionTestInput {
  scope: {
    ownerId: string;
    teamId: string;
  };
  connection: ProviderConnection;
  provider: LeadProvider;
  catalog: ProviderCatalogItem;
}

export interface AcquisitionProviderConnectionTestResult {
  ok: boolean;
  message: string;
  errorCode?: string | null;
  retryable?: boolean;
  retryAfterAt?: string | null;
  usage?: string;
}

export type AcquisitionProviderConnectionTester = (
  input: AcquisitionProviderConnectionTestInput
) => Promise<AcquisitionProviderConnectionTestResult>;

const createConnectionSchema = z.object({
  providerId: z.string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/u),
  apiKey: z.string().trim().min(1).max(4_000),
  baseUrl: z.string().trim().url().max(2_000).optional(),
  status: z.enum(["active", "disabled"]).default("active")
}).strict();
const updateConnectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(4_000).optional(),
  baseUrl: z.string().trim().url().max(2_000).optional(),
  status: z.enum(["active", "disabled"]).optional()
}).strict().superRefine((value, context) => {
  if (
    value.apiKey === undefined
    && value.baseUrl === undefined
    && value.status === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "至少提供一个可更新字段"
    });
  }
  if (value.baseUrl !== undefined && value.apiKey === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: "修改基础地址时必须重新提交 API Key"
    });
  }
});
const connectionIdSchema = z.string().trim().min(1).max(255);

class AcquisitionProviderConnectionsHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null,
    readonly retryable = false
  ) {
    super(message);
    this.name = "AcquisitionProviderConnectionsHttpError";
  }
}

function requireCredentialSecret(secret: string) {
  if (
    typeof secret !== "string"
    || Buffer.byteLength(secret.trim(), "utf8") < 32
  ) {
    throw new TypeError(
      "credentialSecret must contain at least 32 non-whitespace bytes"
    );
  }
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function actor(req: Request) {
  return (req as Request & {
    user?: { id?: string; teamId?: string };
  }).user;
}

function requestId(res: Response) {
  return String(res.locals.acquisitionRequestId);
}

function sendError(error: unknown, res: Response) {
  let code = "internal_error";
  let message = "服务暂时不可用";
  let details: unknown = null;
  let status = 500;
  let retryable = false;

  if (error instanceof ZodError) {
    code = "invalid_request";
    message = "请求参数不符合接口契约";
    status = 400;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  } else if (error instanceof AcquisitionProviderConnectionsHttpError) {
    ({ code, message, details, status, retryable } = error);
  } else if (error instanceof ProviderContractError) {
    code = error.code.toLocaleLowerCase();
    message = error.publicMessage;
    if (error.code === "PROVIDER_RATE_LIMITED") {
      status = 429;
    } else if (
      error.code === "PROVIDER_AUTH_FAILED"
      || error.code === "PROVIDER_CONNECTION_INVALID"
      || error.code === "PROVIDER_QUOTA_EXHAUSTED"
    ) {
      status = 422;
    } else if (
      error.code === "PROVIDER_POLICY_BLOCKED"
      || error.code === "PROVIDER_NOT_REGISTERED"
    ) {
      status = 400;
    } else if (
      error.code === "PROVIDER_DISABLED"
      || error.code === "PROVIDER_CATALOG_MISSING"
    ) {
      status = 409;
    } else if (
      error.code === "PROVIDER_TIMEOUT"
      || error.code === "PROVIDER_NETWORK_ERROR"
      || error.code === "PROVIDER_UNAVAILABLE"
    ) {
      status = 503;
    } else {
      status = 502;
    }
    retryable = error.retryable || [
      "PROVIDER_TIMEOUT",
      "PROVIDER_NETWORK_ERROR",
      "PROVIDER_UNAVAILABLE"
    ].includes(error.code);
    details = error.retryAfterAt
      ? { retryAfterAt: error.retryAfterAt }
      : null;
  }

  res.status(status).json({
    code,
    message,
    details,
    requestId: requestId(res),
    retryable
  });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, _next: NextFunction) => {
    void handler(req, res).catch((error) => sendError(error, res));
  };
}

function idempotencyKey(req: Request) {
  const key = req.header("Idempotency-Key")?.trim() || "";
  if (!key) {
    throw new AcquisitionProviderConnectionsHttpError(
      "idempotency_key_required",
      "写操作必须提供 Idempotency-Key",
      400
    );
  }
  if (key.length > 200) {
    throw new AcquisitionProviderConnectionsHttpError(
      "invalid_idempotency_key",
      "Idempotency-Key 必须为 1 至 200 个字符",
      400
    );
  }
  return key;
}

function keyedHash(
  secret: string,
  purpose: string,
  value: string
) {
  return createHmac("sha256", secret)
    .update("goodjob-acquisition-provider-connections-v1\u0000")
    .update(purpose)
    .update("\u0000")
    .update(value)
    .digest("hex");
}

function createIdempotencyKeyHash(
  secret: string,
  scope: { ownerId: string; teamId: string },
  key: string
) {
  return keyedHash(
    secret,
    "create-idempotency-key",
    [scope.ownerId, scope.teamId, key].join("\u001f")
  );
}

function createRequestFingerprint(
  secret: string,
  scope: { ownerId: string; teamId: string },
  body: z.infer<typeof createConnectionSchema>
) {
  return keyedHash(
    secret,
    "create-request",
    canonicalJsonStringify({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      method: "POST",
      path: "/api/v1/acquisition/provider-connections",
      body
    })
  );
}

function acquisitionV1Policy(connection: ProviderConnection) {
  const value = connection.quotaPolicy.acquisitionV1;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const policy = value as Record<string, unknown>;
  return {
    baseUrl: typeof policy.baseUrl === "string"
      ? policy.baseUrl
      : "",
    createIdempotencyKeyHash:
      typeof policy.createIdempotencyKeyHash === "string"
        ? policy.createIdempotencyKeyHash
        : "",
    createRequestFingerprint:
      typeof policy.createRequestFingerprint === "string"
        ? policy.createRequestFingerprint
        : ""
  };
}

function publicConnection(connection: ProviderConnection) {
  const status = connection.status === "error"
    ? "inactive"
    : connection.status;
  return {
    id: connection.id,
    ownerId: connection.ownerId,
    teamId: connection.teamId,
    providerId: connection.providerId,
    kind: "search" as const,
    status,
    credentialVersion: acquisitionProviderConnectionVersion(connection),
    lastHealthAt: connection.lastHealthAt || null,
    lastHealthStatus: connection.lastHealthStatus,
    lastErrorCode: connection.lastErrorCode || null,
    lastHealthMessage: connection.lastHealthMessage,
    usage: connection.usage,
    createdAt: connection.createdAt
  };
}

const SYSTEM_CONNECTION_CREATED_AT = "2026-07-23T00:00:00.000Z";

function publicSystemConnection(
  connection:
    (typeof ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS)[
      keyof typeof ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS
    ]
) {
  return {
    id: connection.connectionId,
    ownerId: "system",
    teamId: null,
    providerId: connection.providerId,
    kind: connection.kind,
    status: connection.status,
    credentialVersion: connection.credentialVersion,
    lastHealthAt: null,
    lastHealthStatus: "untested",
    lastErrorCode: null,
    lastHealthMessage: "系统托管来源",
    usage: "",
    createdAt: SYSTEM_CONNECTION_CREATED_AT
  };
}

function systemConnection(id: string) {
  return Object.values(ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS).find(
    (connection) => connection.connectionId === id
  ) || null;
}

function isApprovedSearchProviderId(providerId: string) {
  return ACQUISITION_SEARCH_PROVIDER_IDS.includes(
    providerId as (typeof ACQUISITION_SEARCH_PROVIDER_IDS)[number]
  );
}

function scopedPersonalConnection(
  store: AcquisitionProviderConnectionStore,
  scope: { ownerId: string; teamId: string },
  id: string
) {
  return store.providerConnections.find((connection) =>
    connection.id === id
    && connection.ownerId === scope.ownerId
    && connection.teamId === scope.teamId
    && connection.scope === "personal"
    && isApprovedSearchProviderId(connection.providerId)
  ) || null;
}

function safeHealthMessage(
  result: AcquisitionProviderConnectionTestResult
) {
  if (result.ok) return "数据源连接测试通过";
  const messages: Record<string, string> = {
    PROVIDER_AUTH_FAILED: "数据源授权已失效，请检查连接配置",
    PROVIDER_RATE_LIMITED: "数据源当前限流，可稍后重试",
    PROVIDER_QUOTA_EXHAUSTED: "数据源额度已用尽，请检查套餐或预算",
    PROVIDER_TIMEOUT: "数据源响应超时，可稍后重试",
    PROVIDER_POLICY_BLOCKED: "数据源请求被安全策略阻止",
    PROVIDER_UNAVAILABLE: "数据源暂时不可用，可稍后重试",
    PROVIDER_SCHEMA_CHANGED: "数据源请求或返回结构不兼容，请检查适配器",
    PROVIDER_NETWORK_ERROR: "数据源连接异常，可稍后重试",
    PROVIDER_INTERNAL_ERROR: "数据源适配器执行异常，请检查配置或适配器"
  };
  return messages[result.errorCode || ""]
    || "数据源连接测试失败，请检查连接配置或稍后重试";
}

function normalizedTestResult(
  result: AcquisitionProviderConnectionTestResult
) {
  if (
    typeof result?.ok !== "boolean"
    || typeof result.message !== "string"
    || result.message.trim().length < 1
    || result.message.length > 2_000
    || (
      result.errorCode !== undefined
      && result.errorCode !== null
      && (
        typeof result.errorCode !== "string"
        || result.errorCode.length > 120
      )
    )
    || (
      result.retryAfterAt !== undefined
      && result.retryAfterAt !== null
      && (
        typeof result.retryAfterAt !== "string"
        || !Number.isFinite(Date.parse(result.retryAfterAt))
      )
    )
    || (
      result.usage !== undefined
      && (
        typeof result.usage !== "string"
        || result.usage.length > 2_000
      )
    )
  ) {
    throw new AcquisitionProviderConnectionsHttpError(
      "invalid_connection_tester_response",
      "数据源连接测试服务返回了无效结果",
      502,
      null,
      true
    );
  }
  return {
    ok: result.ok,
    message: safeHealthMessage(result),
    errorCode: result.errorCode || null,
    retryable: result.retryable === true,
    retryAfterAt: result.retryAfterAt || null,
    usage: result.usage || ""
  };
}

function approvedCatalog(
  store: AcquisitionProviderConnectionStore,
  providerId: string
): ProviderCatalogItem {
  const catalog = store.providerCatalog.find(
    (item) => item.code === providerId
  );
  if (!catalog) {
    throw new AcquisitionProviderConnectionsHttpError(
      "provider_catalog_unavailable",
      "公开搜索数据源目录不可用",
      409
    );
  }
  if (
    catalog.status !== "active"
    || catalog.accessMode !== "api"
    || catalog.licensePolicy.requiresKey !== true
  ) {
    throw new AcquisitionProviderConnectionsHttpError(
      "provider_policy_blocked",
      "该数据源不允许创建 BYOK 搜索连接",
      409
    );
  }
  return catalog;
}

async function persistConnectionMutation<T>(
  store: AcquisitionProviderConnectionStore,
  mutation: () => PersistedStoreMutation<T>
) {
  if (store.persistMutation) {
    try {
      return await store.persistMutation(mutation);
    } catch (error) {
      if (
        error instanceof AcquisitionProviderConnectionsHttpError
        || error instanceof ProviderContractError
      ) {
        throw error;
      }
      throw new AcquisitionProviderConnectionsHttpError(
        "provider_connection_persistence_failed",
        "数据源连接未能安全保存，请稍后重试",
        503,
        null,
        true
      );
    }
  }
  const applied = mutation();
  try {
    await store.persist();
    return applied.value;
  } catch {
    try {
      applied.rollback();
    } catch {
      // The public response deliberately does not expose persistence or
      // rollback internals. The store remains responsible for alerting.
    }
    throw new AcquisitionProviderConnectionsHttpError(
      "provider_connection_persistence_failed",
      "数据源连接未能安全保存，请稍后重试",
      503,
      null,
      true
    );
  }
}

export function createAcquisitionProviderConnectionsRouter(
  options: AcquisitionProviderConnectionsRouterOptions
) {
  requireCredentialSecret(options.credentialSecret);
  const router = Router();
  const requestIdFactory = options.requestIdFactory
    ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const idFactory = options.idFactory
    ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const now = options.now ?? (() => new Date().toISOString());

  router.use("/api/v1/acquisition", (req, res, next) => {
    const requestId = requestIdFactory("request");
    res.locals.acquisitionRequestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    const user = actor(req);
    if (!user?.id || !user.teamId) {
      res.status(401).json({
        code: "unauthorized",
        message: "需要登录后访问",
        details: null,
        requestId,
        retryable: false
      });
      return;
    }
    next();
  });

  router.get("/api/v1/acquisition/providers", asyncRoute(async (_req, res) => {
    await options.store.readBarrier();
    const searchProviders = ACQUISITION_SEARCH_PROVIDER_IDS.map((id) => {
      const provider = getProvider(id);
      if (!provider) {
        throw new Error(`Approved acquisition provider is unavailable: ${id}`);
      }
      const catalog = options.store.providerCatalog.find(
        (item) => item.code === id
      );
      return {
        id,
        kind: "search" as const,
        displayName: catalog?.name || provider.name,
        officialDocsUrl: catalog?.officialDocsUrl || provider.docsUrl,
        defaultBaseUrl:
          catalog?.baseUrl || provider.defaultBaseUrl || "",
        requiresKey: providerRequiresKey(provider, catalog),
        keyHint:
          catalog?.licensePolicy.keyHint || provider.keyHint,
        costNote:
          catalog?.licensePolicy.costNote || provider.costNote,
        capabilities: [
          ...(catalog?.capabilities || provider.capabilities)
        ]
      };
    });
    res.json({
      items: [
        ...searchProviders,
        { ...ACQUISITION_CONTENT_FETCH_PROVIDER },
        { ...ACQUISITION_IMPORT_PROVIDER }
      ],
      nextCursor: null
    });
  }));

  router.get(
    "/api/v1/acquisition/provider-connections",
    asyncRoute(async (req, res) => {
      const user = actor(req)!;
      await options.store.readBarrier();
      const personal = options.store.providerConnections
        .filter((connection) =>
          connection.ownerId === user.id
          && connection.teamId === user.teamId
          && connection.scope === "personal"
          && isApprovedSearchProviderId(connection.providerId)
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt)
          || right.id.localeCompare(left.id)
        )
        .map(publicConnection);
      res.json({
        items: [
          ...personal,
          ...Object.values(ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS)
            .map(publicSystemConnection)
        ],
        nextCursor: null
      });
    })
  );

  router.post(
    "/api/v1/acquisition/provider-connections",
    asyncRoute(async (req, res) => {
      const key = idempotencyKey(req);
      const parsedBody = parse(createConnectionSchema, req.body);
      const body = {
        ...parsedBody,
        status: parsedBody.status ?? "active"
      };
      if (
        body.providerId === ACQUISITION_CONTENT_FETCH_PROVIDER.id
        || body.providerId === ACQUISITION_IMPORT_PROVIDER.id
      ) {
        throw new AcquisitionProviderConnectionsHttpError(
          "system_connection_read_only",
          "系统数据源连接为只读",
          403
        );
      }
      if (!isApprovedSearchProviderId(body.providerId)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_not_supported",
          "该数据源不是受支持的 BYOK 公开搜索数据源",
          400
        );
      }
      const user = actor(req)!;
      const scope = {
        ownerId: user.id!,
        teamId: user.teamId!
      };
      const idempotencyKeyHash = createIdempotencyKeyHash(
        options.credentialSecret,
        scope,
        key
      );
      const requestFingerprint = createRequestFingerprint(
        options.credentialSecret,
        scope,
        body
      );
      await options.store.readBarrier();
      const provider = getProvider(body.providerId);
      if (!provider || !ACQUISITION_SEARCH_PROVIDER_IDS.includes(
        provider.id as (typeof ACQUISITION_SEARCH_PROVIDER_IDS)[number]
      )) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_not_supported",
          "该数据源不是受支持的 BYOK 公开搜索数据源",
          400
        );
      }
      const catalog = approvedCatalog(options.store, body.providerId);
      if (!providerRequiresKey(provider, catalog)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_policy_blocked",
          "该数据源不允许创建 BYOK 搜索连接",
          409
        );
      }
      const baseUrl = body.baseUrl
        || catalog.baseUrl
        || provider.defaultBaseUrl
        || "";
      try {
        assertProviderBaseUrlAllowed(baseUrl, provider.networkPolicy);
      } catch (error) {
        if (!(error instanceof ProviderContractError)) throw error;
        throw new AcquisitionProviderConnectionsHttpError(
          "invalid_provider_base_url",
          "数据源基础地址不在官方网络白名单",
          400
        );
      }
      const result = await persistConnectionMutation(options.store, () => {
        const idempotent = options.store.providerConnections.find(
          (candidate) =>
            candidate.ownerId === scope.ownerId
            && candidate.teamId === scope.teamId
            && acquisitionV1Policy(candidate)
              ?.createIdempotencyKeyHash === idempotencyKeyHash
        );
        if (idempotent) {
          if (
            acquisitionV1Policy(idempotent)?.createRequestFingerprint
              !== requestFingerprint
          ) {
            throw new AcquisitionProviderConnectionsHttpError(
              "idempotency_key_conflict",
              "该 Idempotency-Key 已用于不同的连接创建请求",
              409
            );
          }
          return {
            value: { connection: idempotent, replayed: true },
            rollback() {}
          };
        }
        if (options.store.providerConnections.some((candidate) =>
          candidate.providerId === body.providerId
          && candidate.ownerId === scope.ownerId
          && candidate.teamId === scope.teamId
        )) {
          throw new AcquisitionProviderConnectionsHttpError(
            "provider_connection_exists",
            "当前用户已在当前团队创建该数据源连接",
            409
          );
        }
        const timestamp = now();
        const id = idFactory("provider_connection");
        const context = {
          id,
          providerId: body.providerId,
          ...scope
        };
        const connection: ProviderConnection = {
          ...context,
          scope: "personal",
          credentialRef: createCredentialRef(),
          credentialVersion: 1,
          configurationEncrypted: encryptProviderConfigurationWithSecret(
            context,
            { apiKey: body.apiKey, baseUrl },
            options.credentialSecret
          ),
          status: body.status,
          quotaPolicy: {
            acquisitionV1: {
              baseUrl,
              createIdempotencyKeyHash: idempotencyKeyHash,
              createRequestFingerprint: requestFingerprint
            }
          },
          budgetPolicy: {},
          lastHealthAt: "",
          lastHealthStatus: "untested",
          lastErrorCode: "",
          lastHealthMessage: "",
          usage: "",
          createdBy: scope.ownerId,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        options.store.providerConnections.unshift(connection);
        return {
          value: { connection, replayed: false },
          rollback() {
            const index = options.store.providerConnections.indexOf(
              connection
            );
            if (index >= 0) {
              options.store.providerConnections.splice(index, 1);
            }
          }
        };
      });
      if (result.replayed) {
        res.setHeader("Idempotency-Replayed", "true");
      }
      res
        .status(result.replayed ? 200 : 201)
        .json(publicConnection(result.connection));
    })
  );

  router.get(
    "/api/v1/acquisition/provider-connections/:id",
    asyncRoute(async (req, res) => {
      const user = actor(req)!;
      await options.store.readBarrier();
      const fixed = systemConnection(req.params.id);
      if (fixed) {
        res.json(publicSystemConnection(fixed));
        return;
      }
      const connection = scopedPersonalConnection(
        options.store,
        { ownerId: user.id!, teamId: user.teamId! },
        req.params.id
      );
      if (!connection) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_connection_not_found",
          "数据源连接不存在或不属于当前用户",
          404
        );
      }
      res.json(publicConnection(connection));
    })
  );

  router.patch(
    "/api/v1/acquisition/provider-connections/:id",
    asyncRoute(async (req, res) => {
      const id = parse(connectionIdSchema, req.params.id);
      if (systemConnection(id)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "system_connection_read_only",
          "系统数据源连接为只读",
          403
        );
      }
      const body = parse(updateConnectionSchema, req.body);
      const user = actor(req)!;
      const scope = {
        ownerId: user.id!,
        teamId: user.teamId!
      };
      await options.store.readBarrier();
      const connection = await persistConnectionMutation(
        options.store,
        () => {
          const current = scopedPersonalConnection(
            options.store,
            scope,
            id
          );
          if (!current) {
            throw new AcquisitionProviderConnectionsHttpError(
              "provider_connection_not_found",
              "数据源连接不存在或不属于当前用户",
              404
            );
          }
          const before = structuredClone(current);
          if (body.apiKey !== undefined) {
            const provider = getProvider(current.providerId);
            if (!provider || !isApprovedSearchProviderId(provider.id)) {
              throw new AcquisitionProviderConnectionsHttpError(
                "provider_not_supported",
                "该连接不是受支持的 BYOK 公开搜索数据源",
                409
              );
            }
            const catalog = approvedCatalog(
              options.store,
              current.providerId
            );
            const baseUrl = body.baseUrl
              || acquisitionV1Policy(current)?.baseUrl
              || catalog.baseUrl
              || provider.defaultBaseUrl
              || "";
            try {
              assertProviderBaseUrlAllowed(
                baseUrl,
                provider.networkPolicy
              );
            } catch (error) {
              if (!(error instanceof ProviderContractError)) throw error;
              throw new AcquisitionProviderConnectionsHttpError(
                "invalid_provider_base_url",
                "数据源基础地址不在官方网络白名单",
                400
              );
            }
            const currentVersion =
              acquisitionProviderConnectionVersion(current);
            if (currentVersion >= Number.MAX_SAFE_INTEGER) {
              throw new AcquisitionProviderConnectionsHttpError(
                "credential_version_exhausted",
                "数据源连接凭据版本已耗尽",
                409
              );
            }
            current.configurationEncrypted =
              encryptProviderConfigurationWithSecret(
                current,
                { apiKey: body.apiKey, baseUrl },
                options.credentialSecret
              );
            current.credentialVersion = currentVersion + 1;
            const rawPolicy = current.quotaPolicy.acquisitionV1;
            current.quotaPolicy = {
              ...current.quotaPolicy,
              acquisitionV1: {
                ...(rawPolicy
                  && typeof rawPolicy === "object"
                  && !Array.isArray(rawPolicy)
                  ? rawPolicy
                  : {}),
                baseUrl
              }
            };
            current.lastHealthAt = "";
            current.lastHealthStatus = "untested";
            current.lastErrorCode = "";
            current.lastHealthMessage = "";
            current.usage = "";
          }
          if (body.status !== undefined) {
            current.status = body.status;
          }
          current.updatedAt = now();
          return {
            value: current,
            rollback() {
              Object.assign(current, before);
            }
          };
        }
      );
      res.json(publicConnection(connection));
    })
  );

  router.delete(
    "/api/v1/acquisition/provider-connections/:id",
    asyncRoute(async (req, res) => {
      const id = parse(connectionIdSchema, req.params.id);
      if (systemConnection(id)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "system_connection_read_only",
          "系统数据源连接为只读",
          403
        );
      }
      const user = actor(req)!;
      const scope = {
        ownerId: user.id!,
        teamId: user.teamId!
      };
      await options.store.readBarrier();
      await persistConnectionMutation(options.store, () => {
        const connection = scopedPersonalConnection(
          options.store,
          scope,
          id
        );
        if (!connection) {
          throw new AcquisitionProviderConnectionsHttpError(
            "provider_connection_not_found",
            "数据源连接不存在或不属于当前用户",
            404
          );
        }
        const index = options.store.providerConnections.indexOf(
          connection
        );
        options.store.providerConnections.splice(index, 1);
        return {
          value: undefined,
          rollback() {
            options.store.providerConnections.splice(
              index,
              0,
              connection
            );
          }
        };
      });
      res.status(204).end();
    })
  );

  router.post(
    "/api/v1/acquisition/provider-connections/:id/test",
    asyncRoute(async (req, res) => {
      const id = parse(connectionIdSchema, req.params.id);
      if (systemConnection(id)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "system_connection_read_only",
          "系统数据源连接为只读",
          403
        );
      }
      const user = actor(req)!;
      const scope = {
        ownerId: user.id!,
        teamId: user.teamId!
      };
      await options.store.readBarrier();
      const connection = scopedPersonalConnection(
        options.store,
        scope,
        id
      );
      if (!connection) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_connection_not_found",
          "数据源连接不存在或不属于当前用户",
          404
        );
      }
      if (!options.connectionTester) {
        throw new AcquisitionProviderConnectionsHttpError(
          "connection_tester_unavailable",
          "数据源连接测试服务暂不可用",
          503,
          null,
          true
        );
      }
      const provider = getProvider(connection.providerId);
      if (!provider || !isApprovedSearchProviderId(provider.id)) {
        throw new AcquisitionProviderConnectionsHttpError(
          "provider_not_supported",
          "该连接不是受支持的 BYOK 公开搜索数据源",
          409
        );
      }
      const catalog = approvedCatalog(
        options.store,
        connection.providerId
      );
      const testedCiphertext = connection.configurationEncrypted;
      const testedVersion = acquisitionProviderConnectionVersion(
        connection
      );
      const result = normalizedTestResult(
        await options.connectionTester({
          scope,
          connection: structuredClone(connection),
          provider,
          catalog: structuredClone(catalog)
        })
      );
      await persistConnectionMutation(options.store, () => {
        const current = scopedPersonalConnection(
          options.store,
          scope,
          id
        );
        if (!current) {
          throw new AcquisitionProviderConnectionsHttpError(
            "provider_connection_not_found",
            "数据源连接不存在或不属于当前用户",
            404
          );
        }
        if (
          current.configurationEncrypted !== testedCiphertext
          || acquisitionProviderConnectionVersion(current)
            !== testedVersion
        ) {
          throw new AcquisitionProviderConnectionsHttpError(
            "provider_connection_changed",
            "数据源连接已更新，请重新测试",
            409,
            null,
            true
          );
        }
        const before = structuredClone(current);
        current.lastHealthAt = now();
        current.lastHealthStatus = result.ok ? "passed" : "failed";
        current.lastErrorCode = result.errorCode?.toLocaleLowerCase() || "";
        current.lastHealthMessage = result.message;
        current.usage = result.usage;
        current.updatedAt = current.lastHealthAt;
        return {
          value: undefined,
          rollback() {
            Object.assign(current, before);
          }
        };
      });
      res.json(result);
    })
  );

  return router;
}
