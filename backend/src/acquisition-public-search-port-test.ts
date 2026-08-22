import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encryptProviderConfiguration,
  encryptProviderConfigurationWithSecret
} from "./credential-security.js";
import {
  ProviderContractError,
  type LeadProvider,
  type ProviderPage
} from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import type { PersistedStoreMutation } from "./store.js";
import type {
  ProviderConnection,
  ProviderRequestLog
} from "./types.js";
import {
  AcquisitionPublicSearchPortError,
  createAcquisitionPublicSearchPort,
  type AcquisitionPublicSearchStore,
  type AcquisitionProviderSearchExecutor
} from "./acquisition-public-search-port.js";

process.env.JWT_SECRET =
  "goodjob-acquisition-public-search-test-secret-at-least-32-characters";

const NOW = "2026-07-24T08:00:00.000Z";
const EXPLICIT_CREDENTIAL_SECRET =
  "acquisition-public-search-explicit-credential-secret-v1";

function connection(
  providerId: string,
  overrides: Partial<ProviderConnection> = {}
): ProviderConnection {
  const identity = {
    id: `connection_${providerId}`,
    providerId,
    ownerId: "owner-a",
    teamId: "team-a",
    ...overrides
  };
  return {
    ...identity,
    scope: "personal",
    credentialRef: `credential_${providerId}`,
    credentialVersion: 1,
    configurationEncrypted: encryptProviderConfiguration(identity, {
      apiKey: `${providerId}-official-api-key`,
      baseUrl: ""
    }),
    status: "active",
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested",
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    createdBy: identity.ownerId,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function requestLog(input: {
  provider: LeadProvider;
  connection: ProviderConnection;
  runId: string;
}): ProviderRequestLog {
  return {
    id: `log_${input.provider.id}`,
    teamId: input.connection.teamId,
    ownerId: input.connection.ownerId,
    providerId: input.provider.id,
    connectionId: input.connection.id,
    runId: input.runId,
    runShardId: `${input.runId}_${input.provider.id}`,
    requestFingerprint: "a".repeat(64),
    endpointCode: "search",
    httpStatus: 200,
    attempt: 1,
    quotaUnits: 1,
    costAmount: 0,
    currency: "",
    durationMs: 12,
    responseSize: 1024,
    errorCode: "",
    requestedAt: NOW
  };
}

function providerPage(): ProviderPage {
  return {
    status: "success",
    records: [
      {
        company: "厦门增长科技有限公司",
        officialWebsite: "https://growth.example.cn/",
        website: "https://growth.example.cn/",
        country: "中国 福建 厦门",
        business: "企业获客与销售增长",
        contact: "不应输出的联系人",
        contactInfo: "private@example.cn",
        description: "公开采购需求：正在寻找全网商机识别与渠道 ROI 方案。",
        confidence: 0,
        providerRecordId: "public-company-1",
        sourceUrl: "https://news.example.cn/procurement/growth",
        recordType: "discovery_page",
        fetchedAt: NOW,
        payloadHash: "1".repeat(64),
        evidenceSummary: "公开搜索索引摘要",
        matchedFields: ["company", "description", "sourceUrl"],
        adapterVersion: "1.0",
        catalogPolicyVersion: "1.0",
        sourceLevel: "discovery",
        retentionPolicyRef: "public"
      },
      {
        company: "门店主理人林女士",
        officialWebsite: "",
        website: "",
        country: "中国 厦门",
        business: "门店经营",
        contact: "不应输出的手机号",
        contactInfo: "13800000000",
        description: "公开咨询获客系统，正在比较方案并询问报价，请勿电话推销。",
        confidence: 0,
        providerRecordId: "public-profile-1",
        sourceUrl: "https://www.xiaohongshu.com/user/profile/public-actor",
        recordType: "discovery_page",
        fetchedAt: NOW,
        payloadHash: "2".repeat(64),
        evidenceSummary: "公开个人主页的索引摘要",
        matchedFields: ["company", "description", "sourceUrl"],
        adapterVersion: "1.0",
        catalogPolicyVersion: "1.0",
        sourceLevel: "discovery",
        retentionPolicyRef: "public"
      }
    ],
    nextCursor: null,
    exhausted: true,
    rawCount: 2,
    validCount: 2,
    invalidCount: 0,
    duplicateCount: 0,
    warnings: [],
    usage: {
      requestCount: 1,
      quotaUsed: 1,
      quotaRemaining: null,
      costAmount: null,
      currency: null,
      estimated: false,
      display: ""
    }
  };
}

function createStore(input: {
  connections?: ProviderConnection[];
  persist?: () => Promise<void>;
  useAtomicPersistence?: boolean;
} = {}): AcquisitionPublicSearchStore {
  const store: AcquisitionPublicSearchStore = {
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: input.connections ?? [connection("baidu_ai_search")],
    providerRequestLogs: [],
    persist: input.persist ?? (async () => undefined)
  };
  if (input.useAtomicPersistence) {
    store.persistMutation = async <T>(
      mutation: () => PersistedStoreMutation<T>
    ) => {
      const applied = mutation();
      try {
        await store.persist();
        return applied.value;
      } catch (error) {
        applied.rollback();
        throw error;
      }
    };
  }
  return store;
}

function searchInput(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    providerConnectionId: "connection_baidu_ai_search",
    query: "厦门 企业 正在寻找 AI 获客系统",
    subjectKinds: ["organization", "individual"] as Array<
      "organization" | "individual"
    >,
    maxResults: 10,
    ...overrides
  };
}

test("uses an authorized official BYOK connection and maps public organization and individual signals", async () => {
  const store = createStore({ useAtomicPersistence: true });
  let executionInput:
    | Parameters<AcquisitionProviderSearchExecutor>[0]
    | undefined;
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    executionInput = input;
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    return providerPage();
  };
  const port = createAcquisitionPublicSearchPort(store, { executeSearch });

  const response = await port.search(searchInput());

  assert.equal(executionInput?.provider.id, "baidu_ai_search");
  assert.equal(executionInput?.connection.id, "connection_baidu_ai_search");
  assert.deepEqual(executionInput?.query, {
    goal: "厦门 企业 正在寻找 AI 获客系统",
    productKeywords: "",
    countries: "",
    industry: "",
    customerType: "企业,个人公开需求",
    excludeKeywords: "",
    limit: 10
  });
  assert.equal(response.provider, "baidu_ai_search");
  assert.equal(response.providerConnectionId, "connection_baidu_ai_search");
  assert.equal(response.providerCredentialVersion, 1);
  assert.match(response.requestId || "", /^preq_/);
  assert.equal(response.results.length, 2);
  assert.deepEqual(
    response.results.map((result) => result.providerRecordId),
    ["public-company-1", "public-profile-1"]
  );

  const organization = response.results.find(
    (result) => result.subject.kind === "organization"
  );
  assert(organization);
  assert.equal(organization.accessStatus, "indexed_summary");
  assert.match(organization.rawArtifactHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(organization.subject, {
    kind: "organization",
    name: "厦门增长科技有限公司",
    domain: "growth.example.cn",
    region: "中国 福建 厦门",
    creditCode: null,
    organizationId: organization.subject.kind === "organization"
      ? organization.subject.organizationId
      : null
  });
  assert.match(
    organization.subject.kind === "organization"
      ? organization.subject.organizationId || ""
      : "",
    /^public-org-[a-f0-9]{24}$/
  );

  const individual = response.results.find(
    (result) => result.subject.kind === "individual"
  );
  assert(individual && individual.subject.kind === "individual");
  assert.match(
    individual.subject.publicActorKey,
    /^public:xiaohongshu\.com:sha256:/
  );
  assert.equal(individual.sourcePlatform, "xiaohongshu.com");
  assert.equal(individual.sourceType, "other");
  assert.equal(individual.subject.sourcePlatform, "xiaohongshu.com");
  assert.equal(
    individual.subject.publicProfileUrl,
    "https://www.xiaohongshu.com/user/profile/public-actor"
  );
  assert.equal(individual.subject.buyingStage, "comparison");
  assert.deepEqual(individual.subject.negativeSignals, ["请勿电话推销"]);
  assert.match(
    individual.subject.individualPartyId || "",
    /^public-individual-[a-f0-9]{24}$/
  );

  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("private@example.cn"), false);
  assert.equal(serialized.includes("13800000000"), false);
  assert.equal(serialized.includes("不应输出"), false);
  assert.equal(store.providerRequestLogs.length, 1);
});

test("rejects a live connection whose credential version differs from the frozen search request", async () => {
  const store = createStore({
    connections: [connection("baidu_ai_search", { credentialVersion: 2 })]
  });
  let executionCount = 0;
  const port = createAcquisitionPublicSearchPort(store, {
    async executeSearch(input) {
      executionCount += 1;
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      return providerPage();
    }
  });

  await assert.rejects(
    port.search(searchInput({
      expectedConnection: {
        providerId: "baidu_ai_search",
        credentialVersion: 1
      }
    })),
    (error: unknown) => error instanceof AcquisitionPublicSearchPortError
      && error.code === "PROVIDER_CONNECTION_SNAPSHOT_MISMATCH"
  );
  await assert.rejects(
    port.search(searchInput({
      expectedConnection: {
        providerId: "brave",
        credentialVersion: 2
      }
    })),
    (error: unknown) => error instanceof AcquisitionPublicSearchPortError
      && error.code === "PROVIDER_CONNECTION_SNAPSHOT_MISMATCH"
  );
  assert.equal(executionCount, 0);
});

test("classifies a non-bound Douyin result as content while retaining the search provider", async () => {
  const store = createStore();
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    const source = providerPage().records[1]!;
    return {
      ...providerPage(),
      records: [{
        ...source,
        sourceUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
        providerRecordId: "douyin-profile"
      }],
      rawCount: 1,
      validCount: 1
    };
  };

  const response = await createAcquisitionPublicSearchPort(store, {
    executeSearch
  }).search(searchInput({ query: "厦门 美业 获客" }));

  assert.equal(response.provider, "baidu_ai_search");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.sourcePlatform, "douyin");
  assert.equal(response.results[0]?.sourceType, "profile");
  assert.equal(response.results[0]?.subject.kind, "individual");
  if (response.results[0]?.subject.kind === "individual") {
    assert.equal(response.results[0].subject.sourcePlatform, "douyin");
    assert.match(
      response.results[0].subject.individualPartyId || "",
      /^public-individual-/u
    );
  }
});

test("a Douyin-bound search drops off-platform leakage and never verifies video or comment-like identities", async () => {
  const store = createStore();
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    const source = providerPage().records[1]!;
    const record = (
      providerRecordId: string,
      sourceUrl: string,
      description: string
    ) => ({
      ...source,
      company: "门店主理人林女士",
      sourceUrl,
      description,
      providerRecordId,
      payloadHash: providerRecordId[0]!.repeat(64)
    });
    return {
      ...providerPage(),
      records: [
        record(
          "1-profile",
          "https://www.douyin.com/user/MS4wLjABAAAA",
          "公开商务主页：正在寻找获客方案。"
        ),
        record(
          "2-video",
          "https://www.douyin.com/video/7521000000000000000",
          "公开视频摘要：正在寻找获客方案。"
        ),
        record(
          "3-comment",
          "https://www.iesdouyin.com/share/video/7521000000000000001",
          "搜索索引摘要显示评论区回复：想了解报价。"
        ),
        record(
          "4-short",
          "https://v.douyin.com/AbCdEfGh/",
          "公开短链接索引摘要。"
        ),
        record(
          "5-off-platform",
          "https://news.example.cn/douyin/lead",
          "搜索引擎混入的站外结果。"
        ),
        record(
          "6-lookalike",
          "https://douyin.com.evil.example/user/MS4wLjABAAAA",
          "伪造的域名。"
        )
      ],
      rawCount: 6,
      validCount: 6
    };
  };

  const response = await createAcquisitionPublicSearchPort(store, {
    executeSearch
  }).search(searchInput({
    query: "site:douyin.com 厦门 美业 获客",
    subjectKinds: ["individual"]
  }));

  assert.deepEqual(
    response.results.map((result) => result.sourceType),
    ["profile", "video", "comment_signal", "short_link"]
  );
  assert.equal(
    response.results.every((result) => result.sourcePlatform === "douyin"),
    true
  );
  const byType = new Map(response.results.map((result) => [
    result.sourceType,
    result
  ]));
  for (const sourceType of [
    "video",
    "comment_signal",
    "short_link"
  ] as const) {
    const result = byType.get(sourceType);
    assert(result?.subject.kind === "individual");
    assert.equal(result.subject.individualPartyId, null, sourceType);
    assert.match(result.subject.publicActorKey, /^unresolved-public-signal:/u);
  }
  const profile = byType.get("profile");
  assert(profile?.subject.kind === "individual");
  assert.match(profile.subject.individualPartyId || "", /^public-individual-/u);
});

test("keeps ordinary Douyin video and short-link results as unresolved individual signals", async () => {
  const store = createStore();
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    const source = providerPage().records[1]!;
    return {
      ...providerPage(),
      records: [
        {
          ...source,
          company: "夏季门店经营复盘",
          sourceUrl: "https://www.douyin.com/video/7521000000000000010",
          description: "公开搜索摘要：咨询量不少，但有效到店客户不多。",
          providerRecordId: "ordinary-video",
          payloadHash: "7".repeat(64)
        },
        {
          ...source,
          company: "门店经营经验分享",
          sourceUrl: "https://v.douyin.com/OrdinaryLink/",
          description: "公开短链接索引摘要，具体账号主体仍需人工核验。",
          providerRecordId: "ordinary-short-link",
          payloadHash: "8".repeat(64)
        }
      ],
      rawCount: 2,
      validCount: 2
    };
  };

  const response = await createAcquisitionPublicSearchPort(store, {
    executeSearch
  }).search(searchInput({
    query: "site:douyin.com 厦门 门店 获客",
    subjectKinds: ["individual"]
  }));

  assert.deepEqual(
    response.results.map((result) => result.sourceType),
    ["video", "short_link"]
  );
  for (const result of response.results) {
    assert.equal(result.sourcePlatform, "douyin");
    assert.equal(result.subject.kind, "individual");
    if (result.subject.kind === "individual") {
      assert.equal(result.subject.individualPartyId, null);
      assert.match(
        result.subject.publicActorKey,
        /^unresolved-public-signal:douyin:/u
      );
    }
  }
});

test("keeps public organization identities stable across providers but scopes individuals to the provider", async () => {
  async function identities(providerId: "baidu_ai_search" | "tavily") {
    const selected = connection(providerId);
    const store = createStore({ connections: [selected] });
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      const page = providerPage();
      page.records = page.records.map((record) =>
        record.recordType === "discovery_page"
          && record.company === "厦门增长科技有限公司"
          ? {
              ...record,
              officialWebsite: providerId === "baidu_ai_search"
                ? "HTTPS://WWW.GROWTH.EXAMPLE.CN/company/"
                : "growth.example.cn"
            }
          : record
      );
      return page;
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({
      providerConnectionId: selected.id
    }));
    const organization = response.results.find(
      (result) => result.subject.kind === "organization"
    );
    const individual = response.results.find(
      (result) => result.subject.kind === "individual"
    );
    assert(organization?.subject.kind === "organization");
    assert(individual?.subject.kind === "individual");
    return {
      organizationId: organization.subject.organizationId,
      individualPartyId: individual.subject.individualPartyId
    };
  }

  const baidu = await identities("baidu_ai_search");
  const tavily = await identities("tavily");

  assert.equal(baidu.organizationId, tavily.organizationId);
  assert.notEqual(baidu.individualPartyId, tavily.individualPartyId);
});

test("canonicalizes public profile identities and rejects private URL parameters", async () => {
  async function individualResult(sourceUrl: string, company: string) {
    const store = createStore();
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      const source = providerPage().records[1]!;
      return {
        ...providerPage(),
        records: [{ ...source, sourceUrl, company }],
        rawCount: 1,
        validCount: 1
      };
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({ subjectKinds: ["individual"] }));
    return response.results[0] ?? null;
  }

  const first = await individualResult(
    "https://www.xiaohongshu.com/user/profile/public-actor/?b=2&a=1#bio",
    "门店主理人林女士"
  );
  const second = await individualResult(
    "https://www.xiaohongshu.com/user/profile/public-actor?a=1&b=2",
    "林女士（门店负责人）"
  );
  assert(first?.subject.kind === "individual");
  assert(second?.subject.kind === "individual");
  assert.equal(
    first.subject.individualPartyId,
    second.subject.individualPartyId
  );
  assert.equal(
    first.subject.publicActorKey,
    second.subject.publicActorKey
  );

  const privateEmail = "private@example.cn";
  const unsafe = await individualResult(
    `https://www.xiaohongshu.com/user/profile/public-actor?email=${privateEmail}`,
    "门店主理人林女士"
  );
  assert.equal(unsafe, null);

  const unsafePath = await individualResult(
    "https://www.xiaohongshu.com/user/profile/private%40example.cn",
    "门店主理人林女士"
  );
  assert.equal(unsafePath, null);

  const lookalikeHost = await individualResult(
    "https://evil.example.cn/xiaohongshu.com/user/profile/public-actor",
    "门店主理人林女士"
  );
  assert(lookalikeHost?.subject.kind === "individual");
  assert.equal(lookalikeHost.subject.individualPartyId, null);
  assert.match(
    lookalikeHost.subject.publicActorKey,
    /^unresolved-public-signal:/
  );
});

test("keeps deterministic public identities tenant scoped", async () => {
  async function organizationId(ownerId: string, teamId: string) {
    const selected = connection("baidu_ai_search", { ownerId, teamId });
    const store = createStore({ connections: [selected] });
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      return providerPage();
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({
      ownerId,
      teamId,
      providerConnectionId: selected.id
    }));
    const organization = response.results.find(
      (result) => result.subject.kind === "organization"
    );
    assert(organization?.subject.kind === "organization");
    return organization.subject.organizationId;
  }

  const firstOwner = await organizationId("owner-a", "team-a");
  const secondOwnerSameTenant = await organizationId("owner-b", "team-a");
  const otherTenant = await organizationId("owner-a", "team-b");

  assert.equal(firstOwner, secondOwnerSameTenant);
  assert.notEqual(firstOwner, otherTenant);
});

test("resolves only validated public organization identifiers and leaves weak names for research", async () => {
  async function resolveRecord(
    record: ProviderPage["records"][number]
  ) {
    const store = createStore();
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      return {
        ...providerPage(),
        records: [record],
        rawCount: 1,
        validCount: 1
      };
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({ subjectKinds: ["organization"] }));
    assert.equal(response.results.length, 1);
    const subject = response.results[0]!.subject;
    assert.equal(subject.kind, "organization");
    return subject;
  }

  const source = providerPage().records[0]!;
  const creditResolved = await resolveRecord({
    ...source,
    officialWebsite: "",
    description:
      "企业公示信息：统一社会信用代码 91350200M000100Y48；正在采购获客系统。"
  });
  assert.equal(creditResolved.creditCode, "91350200M000100Y48");
  assert.match(creditResolved.organizationId || "", /^public-org-/);

  const weak = await resolveRecord({
    ...source,
    company: "增长工作室",
    officialWebsite: "",
    website: "",
    description: "公开搜索结果仅包含企业简称，尚无可核验官网或信用代码。"
  });
  assert.equal(weak.domain, null);
  assert.equal(weak.creditCode, null);
  assert.equal(weak.organizationId, null);

  const invalidCreditCode = await resolveRecord({
    ...source,
    officialWebsite: "",
    description:
      "企业公示信息：统一社会信用代码 91350200M000100Y43；正在采购获客系统。"
  });
  assert.equal(invalidCreditCode.creditCode, null);
  assert.equal(invalidCreditCode.organizationId, null);
});

test("supports all approved real search providers", async () => {
  for (const providerId of [
    "baidu_ai_search",
    "tencent_web_search",
    "tavily",
    "serper",
    "brave",
    "serpapi"
  ]) {
    const selected = connection(providerId);
    const store = createStore({ connections: [selected] });
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      return { ...providerPage(), records: [] };
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({
      providerConnectionId: selected.id,
      subjectKinds: ["organization"]
    }));
    assert.equal(response.provider, providerId);
  }
});

test("decrypts BYOK configuration with an explicit credential secret and rejects the wrong secret", async () => {
  function explicitConnection() {
    const selected = connection("baidu_ai_search");
    return {
      ...selected,
      configurationEncrypted: encryptProviderConfigurationWithSecret(
        selected,
        {
          apiKey: "explicit-secret-api-key",
          baseUrl: ""
        },
        EXPLICIT_CREDENTIAL_SECRET
      )
    };
  }

  let executionCount = 0;
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    executionCount += 1;
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    return { ...providerPage(), records: [] };
  };

  const accepted = await createAcquisitionPublicSearchPort(
    createStore({ connections: [explicitConnection()] }),
    {
      executeSearch,
      credentialSecret: EXPLICIT_CREDENTIAL_SECRET
    }
  ).search(searchInput({ subjectKinds: ["organization"] }));
  assert.equal(accepted.provider, "baidu_ai_search");
  assert.equal(executionCount, 1);

  await assert.rejects(
    createAcquisitionPublicSearchPort(
      createStore({ connections: [explicitConnection()] }),
      {
        executeSearch,
        credentialSecret:
          "acquisition-public-search-wrong-credential-secret-v1"
      }
    ).search(searchInput({ subjectKinds: ["organization"] })),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "PROVIDER_CONNECTION_UNAVAILABLE"
  );
  assert.equal(
    executionCount,
    1,
    "an unreadable explicit-secret connection must fail before provider use"
  );
});

test("keeps legacy BYOK connections readable during acquisition credential migration", async () => {
  const legacy = connection("baidu_ai_search");
  let executionCount = 0;
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    executionCount += 1;
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    return { ...providerPage(), records: [] };
  };

  const response = await createAcquisitionPublicSearchPort(
    createStore({ connections: [legacy] }),
    {
      executeSearch,
      credentialSecret: EXPLICIT_CREDENTIAL_SECRET
    }
  ).search(searchInput({ subjectKinds: ["organization"] }));

  assert.equal(response.provider, "baidu_ai_search");
  assert.equal(executionCount, 1);
});

test("does not misclassify an organization page merely because its snippet mentions a decision maker", async () => {
  const store = createStore();
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    const page = providerPage();
    page.records = [{
      ...page.records[0]!,
      company: "厦门供应链科技有限公司",
      description: "采购负责人正在公开调研企业获客方案。"
    }];
    return page;
  };

  const response = await createAcquisitionPublicSearchPort(store, {
    executeSearch
  }).search(searchInput({ subjectKinds: ["organization", "individual"] }));

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.subject.kind, "organization");
});

test("raw artifact hashes change when the indexed public evidence changes", async () => {
  async function hashFor(description: string) {
    const store = createStore();
    const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
      input.onLogs([
        requestLog({
          provider: input.provider,
          connection: input.connection,
          runId: input.context.runId
        })
      ]);
      const page = providerPage();
      page.records = [{ ...page.records[0]!, description }];
      return page;
    };
    const response = await createAcquisitionPublicSearchPort(store, {
      executeSearch
    }).search(searchInput({ subjectKinds: ["organization"] }));
    return response.results[0]!.rawArtifactHash;
  }

  assert.notEqual(
    await hashFor("公开需求版本一"),
    await hashFor("公开需求版本二")
  );
});

test("does not reveal whether a missing, cross-tenant, disabled, or non-personal connection exists", async () => {
  const inaccessibleConnections = [
    connection("baidu_ai_search", { ownerId: "other-owner" }),
    connection("baidu_ai_search", {
      id: "disabled",
      status: "disabled"
    }),
    connection("baidu_ai_search", {
      id: "team-scope",
      scope: "team"
    })
  ];
  let calls = 0;
  const executeSearch: AcquisitionProviderSearchExecutor = async () => {
    calls += 1;
    return providerPage();
  };
  const port = createAcquisitionPublicSearchPort(
    createStore({ connections: inaccessibleConnections }),
    { executeSearch }
  );

  for (const providerConnectionId of [
    inaccessibleConnections[0]!.id,
    "disabled",
    "team-scope",
    "does-not-exist"
  ]) {
    await assert.rejects(
      port.search(searchInput({ providerConnectionId })),
      (error: unknown) =>
        error instanceof AcquisitionPublicSearchPortError
        && error.code === "PROVIDER_CONNECTION_UNAVAILABLE"
        && !error.message.includes(providerConnectionId)
    );
  }
  assert.equal(calls, 0);
});

test("rejects unsupported or unreadable BYOK connections before execution", async () => {
  let calls = 0;
  const executeSearch: AcquisitionProviderSearchExecutor = async () => {
    calls += 1;
    return providerPage();
  };
  const unsupported = connection("hunter");
  const broken = connection("tavily", {
    id: "broken",
    configurationEncrypted: "not-an-encrypted-credential"
  });

  await assert.rejects(
    createAcquisitionPublicSearchPort(
      createStore({ connections: [unsupported] }),
      { executeSearch }
    ).search(searchInput({ providerConnectionId: unsupported.id })),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "PROVIDER_NOT_SUPPORTED"
  );
  await assert.rejects(
    createAcquisitionPublicSearchPort(
      createStore({ connections: [broken] }),
      { executeSearch }
    ).search(searchInput({ providerConnectionId: "broken" })),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "PROVIDER_CONNECTION_UNAVAILABLE"
  );
  assert.equal(calls, 0);
});

test("persists provider audit logs on search failure and sanitizes an unknown provider error", async () => {
  const selected = connection("tavily");
  let persisted = 0;
  const store = createStore({
    connections: [selected],
    persist: async () => {
      persisted += 1;
    }
  });
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    const log = requestLog({
      provider: input.provider,
      connection: input.connection,
      runId: input.context.runId
    });
    log.httpStatus = 500;
    log.errorCode = "provider_internal_error";
    input.onLogs([log]);
    throw new Error("SECRET_API_KEY=must-never-leak");
  };

  await assert.rejects(
    createAcquisitionPublicSearchPort(store, { executeSearch })
      .search(searchInput({
        providerConnectionId: selected.id,
        subjectKinds: ["organization"]
      })),
    (error: unknown) =>
      error instanceof ProviderContractError
      && error.code === "PROVIDER_INTERNAL_ERROR"
      && !error.message.includes("SECRET_API_KEY")
  );
  assert.equal(persisted, 1);
  assert.equal(store.providerRequestLogs.length, 1);
});

test("rolls back transient logs and returns a safe combined error when provider and persistence both fail", async () => {
  const store = createStore({
    persist: async () => {
      throw new Error("mysql://private-user:private-pass@db.internal");
    }
  });
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    throw new Error("SECRET_API_KEY=must-never-leak");
  };

  await assert.rejects(
    createAcquisitionPublicSearchPort(store, { executeSearch })
      .search(searchInput()),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "SEARCH_AND_AUDIT_PERSISTENCE_FAILED"
      && !error.message.includes("SECRET_API_KEY")
      && !error.message.includes("private-pass")
  );
  assert.equal(store.providerRequestLogs.length, 0);
});

test("rejects a successful response when its audit log cannot be made durable", async () => {
  const store = createStore({
    useAtomicPersistence: true,
    persist: async () => {
      throw new Error("database credentials must not leak");
    }
  });
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    input.onLogs([
      requestLog({
        provider: input.provider,
        connection: input.connection,
        runId: input.context.runId
      })
    ]);
    return providerPage();
  };

  await assert.rejects(
    createAcquisitionPublicSearchPort(store, { executeSearch })
      .search(searchInput()),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "AUDIT_PERSISTENCE_FAILED"
      && !error.message.includes("credentials")
  );
  assert.equal(store.providerRequestLogs.length, 0);
});

test("rejects mismatched audit logs and does not persist them", async () => {
  const store = createStore();
  const executeSearch: AcquisitionProviderSearchExecutor = async (input) => {
    const forged = requestLog({
      provider: input.provider,
      connection: input.connection,
      runId: input.context.runId
    });
    forged.ownerId = "other-owner";
    input.onLogs([forged]);
    return providerPage();
  };

  await assert.rejects(
    createAcquisitionPublicSearchPort(store, { executeSearch })
      .search(searchInput()),
    (error: unknown) =>
      error instanceof AcquisitionPublicSearchPortError
      && error.code === "INVALID_PROVIDER_AUDIT_LOG"
  );
  assert.equal(store.providerRequestLogs.length, 0);
});

test("honors a pre-aborted acquisition request without calling a provider", async () => {
  let calls = 0;
  const executeSearch: AcquisitionProviderSearchExecutor = async () => {
    calls += 1;
    return providerPage();
  };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createAcquisitionPublicSearchPort(createStore(), { executeSearch })
      .search(searchInput({ signal: controller.signal })),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError"
  );
  assert.equal(calls, 0);
});
