import type { ModelEndpointProfileId } from "./endpoint-profiles.js";
import type {
  ExactModelCapabilityCertificationInput,
  ExactModelCapabilityName,
  ExactModelCapabilityStatus,
  LiveSmokeReadinessInput,
  NormalizedProviderUsage,
  OfficialModelAdapterRegistration,
  ProviderBusinessErrorInput,
  ProviderErrorContract,
  ProviderResponseMetadataInput
} from "./official-adapter.js";
import type { ModelProviderId } from "./types.js";

type RequestIdPolicy =
  | "x-request-id"
  | "trace_id"
  | "body_request_id"
  | "body_id"
  | "body_id_or_error_request_id"
  | "none";

type ErrorEnvelopePolicy =
  | "nested_error"
  | "minimax_base_resp"
  | "http_status_only"
  | "qianfan_top_level";

interface ExactModelCertificationDefinition {
  model: string;
  profileIds: readonly ModelEndpointProfileId[];
  capabilities: Partial<
    Record<ExactModelCapabilityName, ExactModelCapabilityStatus>
  >;
  officialReference: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}

function requestIdFromInput(
  policy: RequestIdPolicy,
  input: ProviderResponseMetadataInput
) {
  const headers = new Headers(input.headers);
  const body = record(input.body);
  if (policy === "x-request-id") {
    return headers.get("x-request-id");
  }
  if (policy === "trace_id") {
    return headers.get("trace_id");
  }
  if (policy === "body_request_id") {
    return typeof body?.request_id === "string"
      ? body.request_id
      : null;
  }
  if (policy === "body_id") {
    return typeof body?.id === "string" ? body.id : null;
  }
  if (policy === "body_id_or_error_request_id") {
    if (typeof body?.id === "string") return body.id;
    const error = record(body?.error);
    return typeof error?.request_id === "string"
      ? error.request_id
      : null;
  }
  return null;
}

function usageFromBody(bodyValue: unknown): NormalizedProviderUsage | null {
  const body = record(bodyValue);
  const response = record(body?.response);
  const usage = record(body?.usage ?? response?.usage);
  if (!usage) return null;
  const inputDetails = record(
    usage.input_tokens_details ?? usage.prompt_tokens_details
  );
  const outputDetails = record(
    usage.output_tokens_details ?? usage.completion_tokens_details
  );
  const normalized: NormalizedProviderUsage = {
    inputTokens: nonNegativeInteger(
      usage.input_tokens ?? usage.prompt_tokens
    ),
    outputTokens: nonNegativeInteger(
      usage.output_tokens ?? usage.completion_tokens
    ),
    totalTokens: nonNegativeInteger(usage.total_tokens),
    reasoningTokens: nonNegativeInteger(outputDetails?.reasoning_tokens),
    cachedInputTokens: nonNegativeInteger(
      inputDetails?.cached_tokens ?? usage.cached_tokens
    ),
    cacheHitTokens: nonNegativeInteger(usage.prompt_cache_hit_tokens),
    cacheMissTokens: nonNegativeInteger(usage.prompt_cache_miss_tokens)
  };
  return Object.values(normalized).some((value) => value !== null)
    ? normalized
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function retryAfterMs(headersInput?: HeadersInit): number | null {
  const raw = new Headers(headersInput).get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : null;
}

function isHttpFailure(status: number) {
  return status < 200 || status >= 300;
}

function parseBusinessError(
  provider: ModelProviderId,
  requestIdPolicy: RequestIdPolicy,
  envelopePolicy: ErrorEnvelopePolicy,
  input: ProviderBusinessErrorInput
) {
  const body = record(input.body);
  let error: Record<string, unknown> | null = null;
  let businessFailure = false;

  if (envelopePolicy === "minimax_base_resp") {
    const baseResponse = record(body?.base_resp);
    const statusCode = stringValue(baseResponse?.status_code);
    if (
      statusCode !== null
      && statusCode !== "0"
    ) {
      businessFailure = true;
      error = {
        code: statusCode,
        message: baseResponse?.status_msg
      };
    } else if (isHttpFailure(input.status)) {
      error = record(body?.error);
    }
  } else if (envelopePolicy === "http_status_only") {
    if (!isHttpFailure(input.status)) return null;
  } else if (envelopePolicy === "qianfan_top_level") {
    if (isHttpFailure(input.status)) {
      error = body;
    } else {
      const code = stringValue(body?.code);
      if (code && code !== "0") {
        businessFailure = true;
        error = body;
      }
    }
  } else {
    error = record(body?.error);
    businessFailure = !isHttpFailure(input.status) && error !== null;
  }

  if (!isHttpFailure(input.status) && !businessFailure) {
    return null;
  }
  return {
    provider,
    source: businessFailure ? "business" as const : "http" as const,
    httpStatus: input.status,
    code: stringValue(error?.code),
    type: typeof error?.type === "string" ? error.type : null,
    message: typeof error?.message === "string" ? error.message : null,
    providerRequestId: requestIdFromInput(requestIdPolicy, input),
    retryAfterMs: retryAfterMs(input.headers)
  };
}

const capabilityNames: readonly ExactModelCapabilityName[] = Object.freeze([
  "chatCompletions",
  "responses",
  "streaming",
  "toolCalling",
  "parallelToolCalling",
  "jsonObject",
  "jsonSchema"
]);

function capabilityStatuses(
  certified: Partial<
    Record<ExactModelCapabilityName, ExactModelCapabilityStatus>
  > = {}
) {
  return Object.freeze(Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      certified[name] ?? "unverified"
    ])
  )) as Readonly<
    Record<ExactModelCapabilityName, ExactModelCapabilityStatus>
  >;
}

const supported = "certified_supported" as const;

const exactModelCertifications: Readonly<
  Partial<Record<ModelProviderId, readonly ExactModelCertificationDefinition[]>>
> = Object.freeze({
  openai: Object.freeze([
    ...["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((model) =>
      Object.freeze({
        model,
        profileIds: Object.freeze(["openai-global"] as const),
        capabilities: Object.freeze({
          chatCompletions: supported,
          responses: supported,
          streaming: supported,
          toolCalling: supported,
          jsonSchema: supported
        }),
        officialReference:
          `https://developers.openai.com/api/docs/models/${model}`
      })
    )
  ]),
  moonshot: Object.freeze([
    Object.freeze({
      model: "kimi-k3",
      profileIds: Object.freeze(["moonshot-cn"] as const),
      capabilities: Object.freeze({
        chatCompletions: supported,
        streaming: supported,
        toolCalling: supported,
        parallelToolCalling: supported,
        jsonObject: supported,
        jsonSchema: supported
      }),
      officialReference: "https://platform.kimi.com/docs/api/chat"
    })
  ]),
  minimax: Object.freeze([
    Object.freeze({
      model: "MiniMax-M3",
      profileIds: Object.freeze([
        "minimax-cn",
        "minimax-international"
      ] as const),
      capabilities: Object.freeze({
        chatCompletions: supported,
        responses: supported,
        streaming: supported,
        toolCalling: supported
      }),
      officialReference:
        "https://platform.minimax.io/docs/api-reference/responses-create"
    })
  ]),
  zhipu: Object.freeze([
    Object.freeze({
      model: "glm-5.2",
      profileIds: Object.freeze(["zhipu-cn"] as const),
      capabilities: Object.freeze({
        chatCompletions: supported,
        streaming: supported,
        toolCalling: supported,
        jsonObject: supported
      }),
      officialReference:
        "https://docs.bigmodel.cn/api-reference/模型-api/对话补全"
    })
  ]),
  deepseek: Object.freeze([
    ...["deepseek-v4-pro", "deepseek-v4-flash"].map((model) =>
      Object.freeze({
        model,
        profileIds: Object.freeze(["deepseek-global"] as const),
        capabilities: Object.freeze({
          chatCompletions: supported,
          streaming: supported,
          toolCalling: supported,
          jsonObject: supported
        }),
        officialReference:
          "https://api-docs.deepseek.com/api/create-chat-completion"
      })
    )
  ]),
  qwen: Object.freeze([
    ...["qwen3.7-plus", "qwen3.7-plus-2026-05-26"].map((model) =>
      Object.freeze({
        model,
        profileIds: Object.freeze([
          "qwen-cn-beijing-shared",
          "qwen-ap-southeast-1-shared",
          "qwen-us-east-1-shared",
          "qwen-cn-beijing-workspace",
          "qwen-ap-southeast-1-workspace",
          "qwen-ap-northeast-1-workspace",
          "qwen-eu-central-1-workspace"
        ] as const),
        capabilities: Object.freeze({
          chatCompletions: supported,
          responses: supported,
          streaming: supported,
          toolCalling: supported,
          jsonObject: supported
        }),
        officialReference:
          "https://help.aliyun.com/zh/model-studio/text-generation-model"
      })
    ),
    ...["qwen3.6-plus", "qwen3.6-plus-2026-04-02"].map((model) =>
      Object.freeze({
        model,
        profileIds: Object.freeze([
          "qwen-cn-beijing-shared",
          "qwen-ap-southeast-1-shared",
          "qwen-us-east-1-shared",
          "qwen-cn-beijing-workspace",
          "qwen-ap-southeast-1-workspace",
          "qwen-ap-northeast-1-workspace"
        ] as const),
        capabilities: Object.freeze({
          chatCompletions: supported,
          responses: supported,
          streaming: supported,
          toolCalling: supported,
          parallelToolCalling: supported,
          jsonObject: supported
        }),
        officialReference:
          "https://help.aliyun.com/en/model-studio/qwen-function-calling"
      })
    )
  ]),
  doubao: Object.freeze([
    Object.freeze({
      model: "doubao-seed-2-0-lite-260215",
      profileIds: Object.freeze(["doubao-cn-beijing"] as const),
      capabilities: Object.freeze({
        responses: supported,
        toolCalling: supported
      }),
      officialReference: "https://www.volcengine.com/docs/82379/1958524"
    })
  ]),
  hunyuan: Object.freeze([
    ...["hy3", "hy3-preview"].map((model) =>
      Object.freeze({
        model,
        profileIds: Object.freeze([
          "hunyuan-guangzhou",
          "hunyuan-guangzhou-backup"
        ] as const),
        capabilities: Object.freeze({
          chatCompletions: supported,
          responses: supported,
          streaming: supported,
          toolCalling: supported,
          jsonObject: supported,
          jsonSchema: supported
        }),
        officialReference:
          "https://cloud.tencent.com/document/product/1823/130079"
      })
    )
  ])
});

export class ModelCapabilityCertificationError extends Error {
  constructor(
    public readonly code: "PROFILE_PROVIDER_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "ModelCapabilityCertificationError";
  }
}

function certifyExactModelCapabilities(
  provider: ModelProviderId,
  endpointProfileIds: readonly ModelEndpointProfileId[],
  input: ExactModelCapabilityCertificationInput
) {
  if (!endpointProfileIds.includes(input.profileId)) {
    throw new ModelCapabilityCertificationError(
      "PROFILE_PROVIDER_MISMATCH",
      "Endpoint profile does not belong to the selected provider"
    );
  }
  const definition = exactModelCertifications[provider]?.find(
    (candidate) =>
      candidate.model === input.model
      && candidate.profileIds.includes(input.profileId)
  );
  return Object.freeze({
    provider,
    profileId: input.profileId,
    model: input.model,
    capabilities: capabilityStatuses(definition?.capabilities),
    evidence: definition
      ? Object.freeze({
          model: definition.model,
          evidenceDate: "2026-07-24",
          officialReference: definition.officialReference
        })
      : null
  });
}

function registration(
  provider: ModelProviderId,
  endpointProfileIds: readonly ModelEndpointProfileId[],
  requestIdPolicy: RequestIdPolicy,
  errorContract: ProviderErrorContract,
  errorEnvelopePolicy: ErrorEnvelopePolicy
): Readonly<OfficialModelAdapterRegistration> {
  return Object.freeze({
    provider,
    endpointProfileIds: Object.freeze([...endpointProfileIds]),
    errorContract,
    extractResponseMetadata(input: ProviderResponseMetadataInput) {
      return {
        providerRequestId: requestIdFromInput(requestIdPolicy, input),
        usage: usageFromBody(input.body)
      };
    },
    parseBusinessError(input: ProviderBusinessErrorInput) {
      return parseBusinessError(
        provider,
        requestIdPolicy,
        errorEnvelopePolicy,
        input
      );
    },
    certifyExactModelCapabilities(
      input: ExactModelCapabilityCertificationInput
    ) {
      return certifyExactModelCapabilities(
        provider,
        endpointProfileIds,
        input
      );
    },
    evaluateLiveSmokeReadiness(input: LiveSmokeReadinessInput) {
      if (!endpointProfileIds.includes(input.profileId)) {
        throw new ModelCapabilityCertificationError(
          "PROFILE_PROVIDER_MISMATCH",
          "Endpoint profile does not belong to the selected provider"
        );
      }
      if (!input.credential?.trim()) {
        return Object.freeze({
          provider,
          profileId: input.profileId,
          model: input.model,
          status: "not_run" as const,
          reason: "missing_api_key" as const
        });
      }
      return Object.freeze({
        provider,
        profileId: input.profileId,
        model: input.model,
        status: "ready" as const,
        reason: null
      });
    }
  });
}

export const OFFICIAL_MODEL_ADAPTER_REGISTRY = Object.freeze([
  registration(
    "openai",
    ["openai-global"],
    "x-request-id",
    "documented_envelope",
    "nested_error"
  ),
  registration(
    "moonshot",
    ["moonshot-cn"],
    "none",
    "documented_envelope",
    "nested_error"
  ),
  registration(
    "minimax",
    ["minimax-cn", "minimax-international"],
    "trace_id",
    "documented_business_status",
    "minimax_base_resp"
  ),
  registration(
    "zhipu",
    ["zhipu-cn", "zhipu-international"],
    "body_request_id",
    "documented_envelope",
    "nested_error"
  ),
  registration(
    "deepseek",
    ["deepseek-global"],
    "none",
    "http_status_only",
    "http_status_only"
  ),
  registration("qwen", [
    "qwen-cn-beijing-shared",
    "qwen-ap-southeast-1-shared",
    "qwen-us-east-1-shared",
    "qwen-cn-beijing-workspace",
    "qwen-ap-southeast-1-workspace",
    "qwen-ap-northeast-1-workspace",
    "qwen-eu-central-1-workspace"
  ], "none", "shape_unverified", "nested_error"),
  registration(
    "doubao",
    ["doubao-cn-beijing"],
    "body_id",
    "shape_unverified",
    "nested_error"
  ),
  registration("hunyuan", [
    "hunyuan-guangzhou",
    "hunyuan-singapore",
    "hunyuan-guangzhou-backup",
    "hunyuan-singapore-backup",
    "hunyuan-international-site-guangzhou",
    "hunyuan-international-site-singapore"
  ], "body_id_or_error_request_id", "documented_envelope", "nested_error"),
  registration(
    "qianfan",
    ["qianfan-v2"],
    "body_id",
    "documented_envelope",
    "qianfan_top_level"
  )
]);

export function getOfficialModelAdapterRegistration(
  provider: ModelProviderId
) {
  const registration = OFFICIAL_MODEL_ADAPTER_REGISTRY.find(
    (candidate) => candidate.provider === provider
  );
  if (!registration) {
    throw new TypeError(`No official model adapter registered for ${provider}`);
  }
  return registration;
}
