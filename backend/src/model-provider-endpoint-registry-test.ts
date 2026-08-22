import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_ENDPOINT_PROFILES,
  ModelEndpointProfileError,
  resolveOfficialModelOperationUrl,
  resolveModelEndpointProfile
} from "./model-providers/endpoint-profiles.js";
import {
  ModelCapabilityCertificationError,
  OFFICIAL_MODEL_ADAPTER_REGISTRY,
  getOfficialModelAdapterRegistration
} from "./model-providers/adapter-registry.js";

function testHeaders(entries: Record<string, string | undefined>) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

test("official endpoint profiles cover exactly the nine approved providers", () => {
  assert.deepEqual(
    [...new Set(
      MODEL_ENDPOINT_PROFILES.map((profile) => profile.provider)
    )].sort(),
    [
      "deepseek",
      "doubao",
      "hunyuan",
      "minimax",
      "moonshot",
      "openai",
      "qianfan",
      "qwen",
      "zhipu"
    ]
  );
});

test("official endpoint profiles expose only documented surfaces and list policy", () => {
  const byId = new Map(
    MODEL_ENDPOINT_PROFILES.map((profile) => [profile.id, profile])
  );
  assert.deepEqual(byId.get("openai-global")?.surfaces, {
    chatCompletions: {
      path: "/chat/completions",
      availability: "documented"
    },
    responses: {
      path: "/responses",
      availability: "documented"
    }
  });
  assert.deepEqual(byId.get("moonshot-cn")?.modelList, {
    policy: "same_key",
    path: "/models"
  });
  assert.deepEqual(byId.get("doubao-cn-beijing")?.modelList, {
    policy: "separate_control_plane",
    path: null
  });
  assert.deepEqual(byId.get("hunyuan-guangzhou")?.surfaces.responses, {
    path: "/responses",
    availability: "model_dependent"
  });
  assert.deepEqual(byId.get("qianfan-v2")?.modelList, {
    policy: "same_key",
    path: "/models"
  });
});

test("strict endpoint resolution accepts canonical official URLs", () => {
  assert.equal(
    resolveModelEndpointProfile({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com"
    }).id,
    "deepseek-global"
  );
  assert.equal(
    resolveModelEndpointProfile({
      provider: "qwen",
      baseUrl:
        "https://llm-123abc.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/"
    }).id,
    "qwen-ap-southeast-1-workspace"
  );
  assert.equal(
    resolveModelEndpointProfile({
      provider: "hunyuan",
      baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1"
    }).id,
    "hunyuan-international-site-singapore"
  );
});

test("strict endpoint resolution rejects host, path, port, and region switching", () => {
  const rejected = [
    {
      provider: "openai" as const,
      baseUrl: "http://api.openai.com/v1"
    },
    {
      provider: "openai" as const,
      baseUrl: "https://api.openai.com/v1/extra"
    },
    {
      provider: "deepseek" as const,
      baseUrl: "https://api.deepseek.com//"
    },
    {
      provider: "openai" as const,
      baseUrl: "https://api.openai.com:8443/v1"
    },
    {
      provider: "qwen" as const,
      baseUrl:
        "https://llm-123abc.ap-southeast-1.maas.aliyuncs.com.evil.example/compatible-mode/v1"
    },
    {
      provider: "qwen" as const,
      baseUrl:
        "https://llm-123abc.us-east-1.maas.aliyuncs.com/compatible-mode/v1"
    },
    {
      provider: "hunyuan" as const,
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1"
    }
  ];

  for (const input of rejected) {
    assert.throws(
      () => resolveModelEndpointProfile(input),
      (error: unknown) =>
        error instanceof ModelEndpointProfileError
        && error.code === "ENDPOINT_NOT_ALLOWED"
    );
  }
});

test("adapter registry has one immutable registration for each provider", () => {
  assert.deepEqual(
    OFFICIAL_MODEL_ADAPTER_REGISTRY.map(
      (registration) => registration.provider
    ),
    [
      "openai",
      "moonshot",
      "minimax",
      "zhipu",
      "deepseek",
      "qwen",
      "doubao",
      "hunyuan",
      "qianfan"
    ]
  );
  assert.equal(Object.isFrozen(OFFICIAL_MODEL_ADAPTER_REGISTRY), true);
  for (const registration of OFFICIAL_MODEL_ADAPTER_REGISTRY) {
    assert.equal(Object.isFrozen(registration), true);
    assert.ok(registration.endpointProfileIds.length >= 1);
    assert.equal(
      getOfficialModelAdapterRegistration(registration.provider),
      registration
    );
  }
});

test("registrations extract only documented request ids and usage fields", () => {
  const cases = [
    {
      provider: "openai" as const,
      headers: {
        "x-request-id": "req_openai",
        "request-id": "must_not_win"
      },
      body: {
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 14
        }
      },
      expected: {
        providerRequestId: "req_openai",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          reasoningTokens: 1,
          cachedInputTokens: 3,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "moonshot" as const,
      headers: { "x-request-id": "unverified_header" },
      body: {
        usage: {
          prompt_tokens: 9,
          completion_tokens: 2,
          total_tokens: 11,
          cached_tokens: 5
        }
      },
      expected: {
        providerRequestId: null,
        usage: {
          inputTokens: 9,
          outputTokens: 2,
          totalTokens: 11,
          reasoningTokens: null,
          cachedInputTokens: 5,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "minimax" as const,
      headers: {
        trace_id: "trace_minimax",
        "x-request-id": "must_not_win"
      },
      body: {
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
          prompt_tokens_details: { cached_tokens: 2 }
        }
      },
      expected: {
        providerRequestId: "trace_minimax",
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
          reasoningTokens: null,
          cachedInputTokens: 2,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "zhipu" as const,
      headers: {},
      body: {
        request_id: "req_zhipu",
        usage: {
          prompt_tokens: 7,
          completion_tokens: 6,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 1 }
        }
      },
      expected: {
        providerRequestId: "req_zhipu",
        usage: {
          inputTokens: 7,
          outputTokens: 6,
          totalTokens: 13,
          reasoningTokens: null,
          cachedInputTokens: 1,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "deepseek" as const,
      headers: { "x-request-id": "unverified_header" },
      body: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 8 }
        }
      },
      expected: {
        providerRequestId: null,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          reasoningTokens: 8,
          cachedInputTokens: null,
          cacheHitTokens: 60,
          cacheMissTokens: 40
        }
      }
    },
    {
      provider: "qwen" as const,
      headers: { "x-request-id": "unverified_header" },
      body: {
        usage: {
          prompt_tokens: 5,
          completion_tokens: 4,
          total_tokens: 9
        }
      },
      expected: {
        providerRequestId: null,
        usage: {
          inputTokens: 5,
          outputTokens: 4,
          totalTokens: 9,
          reasoningTokens: null,
          cachedInputTokens: null,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "doubao" as const,
      headers: { "x-request-id": "must_not_win" },
      body: {
        id: "req_doubao",
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5
        }
      },
      expected: {
        providerRequestId: "req_doubao",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          reasoningTokens: null,
          cachedInputTokens: null,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "hunyuan" as const,
      headers: {},
      body: {
        id: "req_hunyuan",
        usage: {
          prompt_tokens: 12,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens: 6,
          completion_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 18
        }
      },
      expected: {
        providerRequestId: "req_hunyuan",
        usage: {
          inputTokens: 12,
          outputTokens: 6,
          totalTokens: 18,
          reasoningTokens: 2,
          cachedInputTokens: 4,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    },
    {
      provider: "qianfan" as const,
      headers: {},
      body: {
        id: "req_qianfan",
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7
        }
      },
      expected: {
        providerRequestId: "req_qianfan",
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          totalTokens: 7,
          reasoningTokens: null,
          cachedInputTokens: null,
          cacheHitTokens: null,
          cacheMissTokens: null
        }
      }
    }
  ];

  for (const fixture of cases) {
    const registration = getOfficialModelAdapterRegistration(
      fixture.provider
    );
    assert.deepEqual(
      registration.extractResponseMetadata({
        headers: testHeaders(fixture.headers),
        body: fixture.body
      }),
      fixture.expected,
      fixture.provider
    );
  }
});

test("registrations normalize documented HTTP and business error envelopes", () => {
  const cases = [
    {
      provider: "openai" as const,
      status: 401,
      headers: { "x-request-id": "req_openai_error" },
      body: {
        error: {
          code: "invalid_api_key",
          type: "authentication_error",
          message: "Incorrect API key"
        }
      },
      expected: {
        provider: "openai",
        source: "http",
        httpStatus: 401,
        code: "invalid_api_key",
        type: "authentication_error",
        message: "Incorrect API key",
        providerRequestId: "req_openai_error",
        retryAfterMs: null
      }
    },
    {
      provider: "moonshot" as const,
      status: 429,
      headers: { "retry-after": "2" },
      body: {
        error: {
          code: "rate_limit_reached_error",
          type: "rate_limit_reached_error",
          message: "Rate limit reached"
        }
      },
      expected: {
        provider: "moonshot",
        source: "http",
        httpStatus: 429,
        code: "rate_limit_reached_error",
        type: "rate_limit_reached_error",
        message: "Rate limit reached",
        providerRequestId: null,
        retryAfterMs: 2_000
      }
    },
    {
      provider: "minimax" as const,
      status: 200,
      headers: { trace_id: "trace_minimax_error" },
      body: {
        base_resp: {
          status_code: 1008,
          status_msg: "insufficient balance"
        }
      },
      expected: {
        provider: "minimax",
        source: "business",
        httpStatus: 200,
        code: "1008",
        type: null,
        message: "insufficient balance",
        providerRequestId: "trace_minimax_error",
        retryAfterMs: null
      }
    },
    {
      provider: "zhipu" as const,
      status: 400,
      headers: {},
      body: {
        request_id: "req_zhipu_error",
        error: {
          code: "1211",
          message: "Model does not exist"
        }
      },
      expected: {
        provider: "zhipu",
        source: "http",
        httpStatus: 400,
        code: "1211",
        type: null,
        message: "Model does not exist",
        providerRequestId: "req_zhipu_error",
        retryAfterMs: null
      }
    },
    {
      provider: "deepseek" as const,
      status: 402,
      headers: {},
      body: { detail: "shape intentionally not assumed" },
      expected: {
        provider: "deepseek",
        source: "http",
        httpStatus: 402,
        code: null,
        type: null,
        message: null,
        providerRequestId: null,
        retryAfterMs: null
      }
    },
    {
      provider: "qwen" as const,
      status: 401,
      headers: {},
      body: {
        error: {
          code: "invalid_api_key",
          type: "InvalidApiKey",
          message: "Incorrect API key"
        }
      },
      expected: {
        provider: "qwen",
        source: "http",
        httpStatus: 401,
        code: "invalid_api_key",
        type: "InvalidApiKey",
        message: "Incorrect API key",
        providerRequestId: null,
        retryAfterMs: null
      }
    },
    {
      provider: "doubao" as const,
      status: 400,
      headers: {},
      body: {
        error: {
          code: "SensitiveContentDetected.SevereViolation",
          message: "Sensitive content"
        }
      },
      expected: {
        provider: "doubao",
        source: "http",
        httpStatus: 400,
        code: "SensitiveContentDetected.SevereViolation",
        type: null,
        message: "Sensitive content",
        providerRequestId: null,
        retryAfterMs: null
      }
    },
    {
      provider: "hunyuan" as const,
      status: 429,
      headers: { "retry-after": "3" },
      body: {
        error: {
          code: 429001,
          type: "gateway_error",
          message: "Rate limited",
          request_id: "req_hunyuan_error"
        }
      },
      expected: {
        provider: "hunyuan",
        source: "http",
        httpStatus: 429,
        code: "429001",
        type: "gateway_error",
        message: "Rate limited",
        providerRequestId: "req_hunyuan_error",
        retryAfterMs: 3_000
      }
    },
    {
      provider: "qianfan" as const,
      status: 400,
      headers: {},
      body: {
        code: "invalid_request_error",
        type: "invalid_request_error",
        message: "Invalid request"
      },
      expected: {
        provider: "qianfan",
        source: "http",
        httpStatus: 400,
        code: "invalid_request_error",
        type: "invalid_request_error",
        message: "Invalid request",
        providerRequestId: null,
        retryAfterMs: null
      }
    }
  ];

  for (const fixture of cases) {
    const registration = getOfficialModelAdapterRegistration(
      fixture.provider
    );
    assert.deepEqual(
      registration.parseBusinessError({
        status: fixture.status,
        headers: testHeaders(fixture.headers),
        body: fixture.body
      }),
      fixture.expected,
      fixture.provider
    );
  }
  assert.equal(
    getOfficialModelAdapterRegistration("minimax").parseBusinessError({
      status: 200,
      body: {
        base_resp: { status_code: 0, status_msg: "success" }
      }
    }),
    null
  );
});

test("capability certification is exact-model and leaves unknowns unverified", () => {
  for (const model of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ]) {
    const openai = getOfficialModelAdapterRegistration(
      "openai"
    ).certifyExactModelCapabilities({
      profileId: "openai-global",
      model
    });
    assert.equal(openai.capabilities.chatCompletions, "certified_supported");
    assert.equal(openai.capabilities.responses, "certified_supported");
    assert.equal(openai.capabilities.streaming, "certified_supported");
    assert.equal(openai.capabilities.toolCalling, "certified_supported");
    assert.equal(openai.capabilities.jsonSchema, "certified_supported");
    assert.equal(openai.evidence?.model, model);
  }

  for (const model of [
    "qwen3.7-plus",
    "qwen3.7-plus-2026-05-26",
    "qwen3.6-plus",
    "qwen3.6-plus-2026-04-02"
  ]) {
    const qwen = getOfficialModelAdapterRegistration(
      "qwen"
    ).certifyExactModelCapabilities({
      profileId: "qwen-cn-beijing-workspace",
      model
    });
    assert.equal(qwen.capabilities.chatCompletions, "certified_supported");
    assert.equal(qwen.capabilities.responses, "certified_supported");
    assert.equal(qwen.capabilities.streaming, "certified_supported");
    assert.equal(qwen.capabilities.toolCalling, "certified_supported");
    assert.equal(qwen.capabilities.jsonObject, "certified_supported");
    assert.equal(qwen.evidence?.model, model);
  }

  const qwenParallel = getOfficialModelAdapterRegistration(
    "qwen"
  ).certifyExactModelCapabilities({
    profileId: "qwen-cn-beijing-workspace",
    model: "qwen3.6-plus"
  });
  assert.equal(
    qwenParallel.capabilities.parallelToolCalling,
    "certified_supported"
  );

  const kimi = getOfficialModelAdapterRegistration(
    "moonshot"
  ).certifyExactModelCapabilities({
    profileId: "moonshot-cn",
    model: "kimi-k3"
  });
  assert.equal(kimi.capabilities.jsonObject, "certified_supported");
  assert.equal(kimi.capabilities.jsonSchema, "certified_supported");
  assert.equal(kimi.capabilities.parallelToolCalling, "certified_supported");

  const deepseek = getOfficialModelAdapterRegistration(
    "deepseek"
  ).certifyExactModelCapabilities({
    profileId: "deepseek-global",
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(deepseek.capabilities, {
    chatCompletions: "certified_supported",
    responses: "unverified",
    streaming: "certified_supported",
    toolCalling: "certified_supported",
    parallelToolCalling: "unverified",
    jsonObject: "certified_supported",
    jsonSchema: "unverified"
  });
  assert.equal(deepseek.evidence?.model, "deepseek-v4-pro");
  assert.match(deepseek.evidence?.officialReference || "", /^https:\/\//);

  const hy3 = getOfficialModelAdapterRegistration(
    "hunyuan"
  ).certifyExactModelCapabilities({
    profileId: "hunyuan-guangzhou",
    model: "hy3"
  });
  assert.equal(hy3.capabilities.responses, "certified_supported");
  assert.equal(hy3.capabilities.jsonSchema, "certified_supported");

  const unknowns = OFFICIAL_MODEL_ADAPTER_REGISTRY.map((registration) => {
    const certification = registration.certifyExactModelCapabilities({
      profileId: registration.endpointProfileIds[0],
      model: "vendor-model-not-officially-certified"
    });
    return {
      provider: registration.provider,
      evidence: certification.evidence,
      statuses: [...new Set(Object.values(certification.capabilities))]
    };
  });
  assert.deepEqual(
    unknowns,
    OFFICIAL_MODEL_ADAPTER_REGISTRY.map((registration) => ({
      provider: registration.provider,
      evidence: null,
      statuses: ["unverified"]
    }))
  );

  assert.throws(
    () => getOfficialModelAdapterRegistration(
      "qwen"
    ).certifyExactModelCapabilities({
      profileId: "openai-global",
      model: "qwen3.6-plus"
    }),
    (error: unknown) =>
      error instanceof ModelCapabilityCertificationError
      && error.code === "PROFILE_PROVIDER_MISMATCH"
  );
});

test("live smoke remains not_run when an API key is absent", () => {
  for (const registration of OFFICIAL_MODEL_ADAPTER_REGISTRY) {
    const profileId = registration.endpointProfileIds[0];
    assert.deepEqual(
      registration.evaluateLiveSmokeReadiness({
        profileId,
        model: "explicit-model-id",
        credential: undefined
      }),
      {
        provider: registration.provider,
        profileId,
        model: "explicit-model-id",
        status: "not_run",
        reason: "missing_api_key"
      }
    );
    assert.equal(
      registration.evaluateLiveSmokeReadiness({
        profileId,
        model: "explicit-model-id",
        credential: "   "
      }).status,
      "not_run"
    );
  }
  assert.deepEqual(
    getOfficialModelAdapterRegistration(
      "openai"
    ).evaluateLiveSmokeReadiness({
      profileId: "openai-global",
      model: "explicit-model-id",
      credential: "present-test-credential"
    }),
    {
      provider: "openai",
      profileId: "openai-global",
      model: "explicit-model-id",
      status: "ready",
      reason: null
    }
  );
});

test("operation URLs can only be built from a profile-declared path", () => {
  assert.equal(
    resolveOfficialModelOperationUrl({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      operation: "responses"
    }),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    resolveOfficialModelOperationUrl({
      provider: "qianfan",
      baseUrl: "https://qianfan.baidubce.com/v2",
      operation: "model_list"
    }),
    "https://qianfan.baidubce.com/v2/models"
  );
  assert.throws(
    () => resolveOfficialModelOperationUrl({
      provider: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      operation: "responses"
    }),
    (error: unknown) =>
      error instanceof ModelEndpointProfileError
      && error.code === "SURFACE_NOT_ALLOWED"
  );
  assert.throws(
    () => resolveOfficialModelOperationUrl({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      operation: "model_list"
    }),
    (error: unknown) =>
      error instanceof ModelEndpointProfileError
      && error.code === "SURFACE_NOT_ALLOWED"
  );
});
