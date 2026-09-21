import type { ModelProviderId } from "./types.js";

export type ModelEndpointProfileId =
  | "openai-global"
  | "moonshot-cn"
  | "minimax-cn"
  | "minimax-international"
  | "zhipu-cn"
  | "zhipu-international"
  | "deepseek-global"
  | "qwen-cn-beijing-shared"
  | "qwen-ap-southeast-1-shared"
  | "qwen-us-east-1-shared"
  | "qwen-cn-beijing-workspace"
  | "qwen-ap-southeast-1-workspace"
  | "qwen-ap-northeast-1-workspace"
  | "qwen-eu-central-1-workspace"
  | "doubao-cn-beijing"
  | "hunyuan-guangzhou"
  | "hunyuan-singapore"
  | "hunyuan-guangzhou-backup"
  | "hunyuan-singapore-backup"
  | "hunyuan-international-site-guangzhou"
  | "hunyuan-international-site-singapore"
  | "qianfan-v2";

export type ModelApiSurfaceAvailability =
  | "documented"
  | "model_dependent";

export interface ModelApiSurface {
  path: string;
  availability: ModelApiSurfaceAvailability;
}

export interface ModelApiSurfaces {
  chatCompletions?: ModelApiSurface;
  responses?: ModelApiSurface;
}

export type ModelListPolicy =
  | { policy: "same_key"; path: "/models" }
  | { policy: "not_exposed"; path: null }
  | { policy: "separate_control_plane"; path: null };

interface ExactEndpointHost {
  kind: "exact";
  hostname: string;
}

interface QwenWorkspaceEndpointHost {
  kind: "qwen_workspace";
  hostnameSuffix:
    | ".cn-beijing.maas.aliyuncs.com"
    | ".ap-southeast-1.maas.aliyuncs.com"
    | ".ap-northeast-1.maas.aliyuncs.com"
    | ".eu-central-1.maas.aliyuncs.com";
}

type EndpointHostPolicy = ExactEndpointHost | QwenWorkspaceEndpointHost;

export interface ModelEndpointProfile {
  id: ModelEndpointProfileId;
  provider: ModelProviderId;
  region: string;
  baseUrl: string | null;
  basePath: string;
  hostPolicy: EndpointHostPolicy;
  authentication: "bearer";
  surfaces: ModelApiSurfaces;
  modelList: ModelListPolicy;
  officialReference: string;
  evidenceDate: "2026-07-24";
}

export interface ResolvedModelEndpointProfile
  extends Omit<ModelEndpointProfile, "baseUrl"> {
  baseUrl: string;
  workspaceId: string | null;
}

function freezeProfile(
  profile: ModelEndpointProfile
): Readonly<ModelEndpointProfile> {
  return Object.freeze({
    ...profile,
    hostPolicy: Object.freeze({ ...profile.hostPolicy }),
    surfaces: Object.freeze(
      Object.fromEntries(
        Object.entries(profile.surfaces).map(([key, value]) => [
          key,
          Object.freeze({ ...value })
        ])
      )
    ),
    modelList: Object.freeze({ ...profile.modelList })
  });
}

const documented = (path: string): ModelApiSurface => ({
  path,
  availability: "documented"
});

const modelDependent = (path: string): ModelApiSurface => ({
  path,
  availability: "model_dependent"
});

const profiles: ModelEndpointProfile[] = [
  {
    id: "openai-global",
    provider: "openai",
    region: "global",
    baseUrl: "https://api.openai.com/v1",
    basePath: "/v1",
    hostPolicy: { kind: "exact", hostname: "api.openai.com" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference: "https://developers.openai.com/api/reference",
    evidenceDate: "2026-07-24"
  },
  {
    id: "moonshot-cn",
    provider: "moonshot",
    region: "cn",
    baseUrl: "https://api.moonshot.cn/v1",
    basePath: "/v1",
    hostPolicy: { kind: "exact", hostname: "api.moonshot.cn" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference: "https://platform.kimi.com/docs/api/overview",
    evidenceDate: "2026-07-24"
  },
  {
    id: "minimax-cn",
    provider: "minimax",
    region: "cn",
    baseUrl: "https://api.minimaxi.com/v1",
    basePath: "/v1",
    hostPolicy: { kind: "exact", hostname: "api.minimaxi.com" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://platform.minimaxi.com/docs/api-reference/api-overview",
    evidenceDate: "2026-07-24"
  },
  {
    id: "minimax-international",
    provider: "minimax",
    region: "international",
    baseUrl: "https://api.minimax.io/v1",
    basePath: "/v1",
    hostPolicy: { kind: "exact", hostname: "api.minimax.io" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://platform.minimax.io/docs/api-reference/api-overview",
    evidenceDate: "2026-07-24"
  },
  {
    id: "zhipu-cn",
    provider: "zhipu",
    region: "cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    basePath: "/api/paas/v4",
    hostPolicy: { kind: "exact", hostname: "open.bigmodel.cn" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions")
    },
    modelList: { policy: "not_exposed", path: null },
    officialReference:
      "https://docs.bigmodel.cn/api-reference/模型-api/对话补全",
    evidenceDate: "2026-07-24"
  },
  {
    id: "zhipu-international",
    provider: "zhipu",
    region: "international",
    baseUrl: "https://api.z.ai/api/paas/v4",
    basePath: "/api/paas/v4",
    hostPolicy: { kind: "exact", hostname: "api.z.ai" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions")
    },
    modelList: { policy: "not_exposed", path: null },
    officialReference: "https://github.com/zai-org/z-ai-sdk-python",
    evidenceDate: "2026-07-24"
  },
  {
    id: "deepseek-global",
    provider: "deepseek",
    region: "global",
    baseUrl: "https://api.deepseek.com",
    basePath: "",
    hostPolicy: { kind: "exact", hostname: "api.deepseek.com" },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://api-docs.deepseek.com/api/create-chat-completion",
    evidenceDate: "2026-07-24"
  },
  {
    id: "qwen-cn-beijing-shared",
    provider: "qwen",
    region: "cn-beijing",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    basePath: "/compatible-mode/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "dashscope.aliyuncs.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "not_exposed", path: null },
    officialReference: "https://help.aliyun.com/zh/model-studio/regions/",
    evidenceDate: "2026-07-24"
  },
  {
    id: "qwen-ap-southeast-1-shared",
    provider: "qwen",
    region: "ap-southeast-1",
    baseUrl:
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    basePath: "/compatible-mode/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "dashscope-intl.aliyuncs.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "not_exposed", path: null },
    officialReference: "https://help.aliyun.com/zh/model-studio/regions/",
    evidenceDate: "2026-07-24"
  },
  {
    id: "qwen-us-east-1-shared",
    provider: "qwen",
    region: "us-east-1",
    baseUrl:
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    basePath: "/compatible-mode/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "dashscope-us.aliyuncs.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "not_exposed", path: null },
    officialReference: "https://help.aliyun.com/zh/model-studio/regions/",
    evidenceDate: "2026-07-24"
  },
  ...([
    [
      "qwen-cn-beijing-workspace",
      "cn-beijing",
      ".cn-beijing.maas.aliyuncs.com"
    ],
    [
      "qwen-ap-southeast-1-workspace",
      "ap-southeast-1",
      ".ap-southeast-1.maas.aliyuncs.com"
    ],
    [
      "qwen-ap-northeast-1-workspace",
      "ap-northeast-1",
      ".ap-northeast-1.maas.aliyuncs.com"
    ],
    [
      "qwen-eu-central-1-workspace",
      "eu-central-1",
      ".eu-central-1.maas.aliyuncs.com"
    ]
  ] as const).map(([id, region, hostnameSuffix]) => ({
    id,
    provider: "qwen" as const,
    region,
    baseUrl: null,
    basePath: "/compatible-mode/v1",
    hostPolicy: {
      kind: "qwen_workspace" as const,
      hostnameSuffix
    },
    authentication: "bearer" as const,
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "not_exposed" as const, path: null },
    officialReference: "https://help.aliyun.com/zh/model-studio/regions/",
    evidenceDate: "2026-07-24" as const
  })),
  {
    id: "doubao-cn-beijing",
    provider: "doubao",
    region: "cn-beijing",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    basePath: "/api/v3",
    hostPolicy: {
      kind: "exact",
      hostname: "ark.cn-beijing.volces.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "separate_control_plane", path: null },
    officialReference: "https://www.volcengine.com/docs/82379/1958524",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-guangzhou",
    provider: "hunyuan",
    region: "ap-guangzhou",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub.tencentmaas.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://cloud.tencent.com/document/product/1823/130078",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-singapore",
    provider: "hunyuan",
    region: "ap-singapore",
    baseUrl: "https://tokenhub-intl.tencentmaas.com/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub-intl.tencentmaas.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://cloud.tencent.com/document/product/1823/130078",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-guangzhou-backup",
    provider: "hunyuan",
    region: "ap-guangzhou",
    baseUrl: "https://tokenhub.tencentmaas.cn/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub.tencentmaas.cn"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://cloud.tencent.com/document/product/1823/130078",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-singapore-backup",
    provider: "hunyuan",
    region: "ap-singapore",
    baseUrl: "https://tokenhub-intl.tencentmaas.cn/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub-intl.tencentmaas.cn"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://cloud.tencent.com/document/product/1823/130078",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-international-site-guangzhou",
    provider: "hunyuan",
    region: "ap-guangzhou",
    baseUrl: "https://tokenhub.tencentcloudmaas.com/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub.tencentcloudmaas.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://intl.cloud.tencent.com/zh/document/product/1300/80632",
    evidenceDate: "2026-07-24"
  },
  {
    id: "hunyuan-international-site-singapore",
    provider: "hunyuan",
    region: "ap-singapore",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    basePath: "/v1",
    hostPolicy: {
      kind: "exact",
      hostname: "tokenhub-intl.tencentcloudmaas.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: modelDependent("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://intl.cloud.tencent.com/zh/document/product/1300/80632",
    evidenceDate: "2026-07-24"
  },
  {
    id: "qianfan-v2",
    provider: "qianfan",
    region: "cn",
    baseUrl: "https://qianfan.baidubce.com/v2",
    basePath: "/v2",
    hostPolicy: {
      kind: "exact",
      hostname: "qianfan.baidubce.com"
    },
    authentication: "bearer",
    surfaces: {
      chatCompletions: documented("/chat/completions"),
      responses: documented("/responses")
    },
    modelList: { policy: "same_key", path: "/models" },
    officialReference:
      "https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb",
    evidenceDate: "2026-07-24"
  }
];

export const MODEL_ENDPOINT_PROFILES = Object.freeze(
  profiles.map(freezeProfile)
);

export class ModelEndpointProfileError extends Error {
  constructor(
    public readonly code:
      | "ENDPOINT_NOT_ALLOWED"
      | "SURFACE_NOT_ALLOWED",
    message: string
  ) {
    super(message);
    this.name = "ModelEndpointProfileError";
  }
}

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseStrictBaseUrl(rawBaseUrl: string) {
  if (!rawBaseUrl || rawBaseUrl !== rawBaseUrl.trim()) {
    throw new ModelEndpointProfileError(
      "ENDPOINT_NOT_ALLOWED",
      "Model endpoint is not on the official allowlist"
    );
  }
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new ModelEndpointProfileError(
      "ENDPOINT_NOT_ALLOWED",
      "Model endpoint is not a valid official URL"
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    throw new ModelEndpointProfileError(
      "ENDPOINT_NOT_ALLOWED",
      "Model endpoint is not on the official allowlist"
    );
  }
  const pathname = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  return { url, pathname };
}

function matchesHost(
  profile: Readonly<ModelEndpointProfile>,
  hostname: string
) {
  if (profile.hostPolicy.kind === "exact") {
    return hostname === profile.hostPolicy.hostname
      ? { matches: true as const, workspaceId: null }
      : { matches: false as const };
  }
  if (!hostname.endsWith(profile.hostPolicy.hostnameSuffix)) {
    return { matches: false as const };
  }
  const workspaceId = hostname.slice(
    0,
    -profile.hostPolicy.hostnameSuffix.length
  );
  return dnsLabelPattern.test(workspaceId)
    ? { matches: true as const, workspaceId }
    : { matches: false as const };
}

export function resolveModelEndpointProfile(input: {
  provider: ModelProviderId;
  baseUrl: string;
}): Readonly<ResolvedModelEndpointProfile> {
  const { url, pathname } = parseStrictBaseUrl(input.baseUrl);
  for (const profile of MODEL_ENDPOINT_PROFILES) {
    if (
      profile.provider !== input.provider
      || profile.basePath !== pathname
    ) {
      continue;
    }
    const hostMatch = matchesHost(profile, url.hostname);
    if (!hostMatch.matches) continue;
    return Object.freeze({
      ...profile,
      baseUrl: `${url.origin}${profile.basePath}`,
      workspaceId: hostMatch.workspaceId
    });
  }
  throw new ModelEndpointProfileError(
    "ENDPOINT_NOT_ALLOWED",
    "Model endpoint is not on the official provider/region allowlist"
  );
}

export type OfficialModelOperation =
  | "chat_completions"
  | "responses"
  | "model_list";

export function resolveOfficialModelOperationUrl(input: {
  provider: ModelProviderId;
  baseUrl: string;
  operation: OfficialModelOperation;
}) {
  const profile = resolveModelEndpointProfile(input);
  const operationPath =
    input.operation === "chat_completions"
      ? profile.surfaces.chatCompletions?.path
      : input.operation === "responses"
        ? profile.surfaces.responses?.path
        : profile.modelList.policy === "same_key"
          ? profile.modelList.path
          : null;
  if (!operationPath) {
    throw new ModelEndpointProfileError(
      "SURFACE_NOT_ALLOWED",
      "Operation is not exposed by the selected official endpoint profile"
    );
  }
  return `${profile.baseUrl}${operationPath}`;
}
