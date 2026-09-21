import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptProviderConfiguration } from "./credential-security.js";
import {
  ProviderContractError,
  normalizeProviderPage,
  normalizeProviderQuery,
  providerErrorFromUnknown,
  type LeadProvider
} from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import {
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import {
  createProviderExecutionContext,
  executeProviderHealth,
  executeProviderSearch
} from "./provider-runtime.js";
import type { ProviderConnection, ProviderRequestLog } from "./types.js";
import {
  BAIDU_AI_SEARCH_PROVIDER,
  REAL_WEB_SEARCH_PROVIDERS,
  TAVILY_SEARCH_PROVIDER,
  TENCENT_WEB_SEARCH_PROVIDER
} from "./web-search-providers.js";

const query = normalizeProviderQuery({
  goal: "寻找正在采购工业照明的中国企业",
  productKeywords: "工业照明, LED",
  countries: "中国",
  industry: "制造业",
  customerType: "采购商",
  excludeKeywords: "招聘",
  limit: 7
});

const weightedBaiduLength = (value: string) => Array.from(value).reduce(
  (total, character) => total + (/[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 2 : 1),
  0
);

function tools(provider: LeadProvider) {
  return {
    http: createProviderHttpClient(provider.networkPolicy)
  };
}

function catalog(provider: LeadProvider) {
  const item = createDefaultProviderCatalog()
    .find((candidate) => candidate.code === provider.id);
  assert.ok(item, `${provider.id} should be visible in the provider catalog`);
  return item;
}

function normalize(provider: LeadProvider, page: unknown) {
  const item = catalog(provider);
  return normalizeProviderPage({
    provider,
    catalogPolicyVersion: item.version,
    sourceLevel: item.sourceLevel,
    allowedFields: item.allowedFields,
    retentionPolicy: item.retentionPolicy,
    page
  });
}

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify({
    request_id: "baidu-request-1",
    references: [
      {
        id: 1,
        title: "华东照明有限公司 - 工业照明方案",
        url: "https://Lighting.Example.cn/solutions/industrial?b=2&a=1#section",
        snippet: "华东照明公开发布的工业照明方案摘要。",
        content: "不应替代 snippet 的索引片段。",
        date: "2026-07-22 09:00:00"
      },
      {
        id: 2,
        title: "视频结果",
        url: "https://video.example.cn/2",
        content: "视频摘要",
        type: "video"
      },
      {
        id: 3,
        title: "缺少 URL",
        snippet: "无效网页结果",
        type: "web"
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
});

const baiduPage = await BAIDU_AI_SEARCH_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "baidu-private-key" },
  tools(BAIDU_AI_SEARCH_PROVIDER)
);
assert.equal(requestedUrl, "https://qianfan.baidubce.com/v2/ai_search/web_search");
assert.equal(new URL(requestedUrl).search, "");
const baiduHeaders = new Headers(requestedInit?.headers);
assert.equal(baiduHeaders.get("x-appbuilder-authorization"), "Bearer baidu-private-key");
assert.equal(baiduHeaders.get("authorization"), null);
const firstBaiduBody = JSON.parse(String(requestedInit?.body));
assert.deepEqual({
  ...firstBaiduBody,
  messages: undefined
}, {
  messages: undefined,
  search_source: "baidu_search_v2",
  resource_type_filter: [{ type: "web", top_k: 7 }],
  safe_search: true
});
assert.equal(firstBaiduBody.messages?.[0]?.role, "user");
assert.ok(weightedBaiduLength(firstBaiduBody.messages?.[0]?.content || "") <= 72);
assert.match(firstBaiduBody.messages?.[0]?.content || "", /^寻找正在采购工业照明的中国企业/);
assert.match(firstBaiduBody.messages?.[0]?.content || "", /-招聘/);
assert.equal(baiduPage.rawCount, 3);
assert.equal(baiduPage.records.length, 1);
assert.equal(baiduPage.invalidCount, 1);
assert.match(baiduPage.warnings?.join("\n") || "", /非网页结果 1 条/);
assert.match(baiduPage.warnings?.join("\n") || "", /无效网页结果 1 条/);
assert.equal(
  baiduPage.records[0]?.sourceUrl,
  "https://lighting.example.cn/solutions/industrial?b=2&a=1#section"
);
assert.equal(baiduPage.records[0]?.description, "华东照明公开发布的工业照明方案摘要。");
assert.equal(baiduPage.records[0]?.recordType, "discovery_page");
assert.match(baiduPage.records[0]?.providerRecordId || "", /^urlh:[a-f0-9]{64}$/);
assert.match(baiduPage.records[0]?.evidenceSummary || "", /百度索引第 1 名/);
assert.match(baiduPage.records[0]?.evidenceSummary || "", /请求 baidu-request-1/);
assert.match(baiduPage.records[0]?.evidenceSummary || "", /2026-07-22/);
assert.equal(baiduPage.records[0]?.confidence, 0);
assert.equal(baiduPage.records[0]?.officialWebsite, "");
assert.equal(baiduPage.exhausted, true);
assert.equal(normalize(BAIDU_AI_SEARCH_PROVIDER, baiduPage).status, "partial_success");
assert.equal(String(requestedUrl).includes("baidu-private-key"), false);
const stableBaiduRecordId = baiduPage.records[0]?.providerRecordId;

setProviderHttpTestTransport(async () => new Response(JSON.stringify({
  request_id: "baidu-request-rerun",
  references: [{
    id: 9,
    title: "同一网页的新排名",
    url: "https://lighting.example.cn/solutions/industrial?a=1&b=2",
    content: "同一来源的另一次索引摘要。"
  }]
}), { status: 200 }));
const rerunBaiduPage = await BAIDU_AI_SEARCH_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "baidu-private-key" },
  tools(BAIDU_AI_SEARCH_PROVIDER)
);
assert.equal(rerunBaiduPage.records[0]?.providerRecordId, stableBaiduRecordId);
assert.match(rerunBaiduPage.records[0]?.evidenceSummary || "", /请求 baidu-request-rerun/);
assert.match(rerunBaiduPage.records[0]?.evidenceSummary || "", /第 1 名/);

setProviderHttpTestTransport(async () => new Response(JSON.stringify({
  request_id: "baidu-empty-success"
}), { status: 200 }));
const baiduEmptyPage = await BAIDU_AI_SEARCH_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "baidu-private-key" },
  tools(BAIDU_AI_SEARCH_PROVIDER)
);
assert.equal(baiduEmptyPage.records.length, 0);
assert.equal(baiduEmptyPage.rawCount, 0);
assert.equal(baiduEmptyPage.exhausted, true);

const longBaiduQuery = normalizeProviderQuery({
  goal: "超长核心目标".repeat(10),
  productKeywords: "工业照明,智能制造,采购",
  countries: "中国",
  industry: "制造业",
  customerType: "采购负责人",
  excludeKeywords: "招聘",
  limit: 7
});
setProviderHttpTestTransport(async (_url, init) => {
  requestedInit = init;
  return new Response(JSON.stringify({
    request_id: "baidu-truncated",
    references: []
  }), { status: 200 });
});
const truncatedBaiduPage = await BAIDU_AI_SEARCH_PROVIDER.search!(
  { query: longBaiduQuery, cursor: "" },
  { apiKey: "baidu-private-key" },
  tools(BAIDU_AI_SEARCH_PROVIDER)
);
const truncatedBaiduContent = JSON.parse(String(requestedInit?.body)).messages[0].content;
assert.ok(weightedBaiduLength(truncatedBaiduContent) <= 72);
assert.match(truncatedBaiduContent, /^超长核心目标/);
assert.match(truncatedBaiduContent, /-招聘/);
assert.match(truncatedBaiduPage.warnings?.join("\n") || "", /72/);

setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify({
    Response: {
      Query: "工业照明",
      RequestId: "tencent-request-1",
      Pages: [
        JSON.stringify({
          title: "华南工厂采购公告",
          date: "2026-07-21 12:00:00",
          url: "https://factory.example.cn/purchase/lighting",
          passage: "该工厂发布的工业照明采购信息索引摘要。",
          content: "尊享版动态摘要不应覆盖标准摘要。",
          site: "示例工厂",
          score: 0.87
        }),
        "{broken-json",
        JSON.stringify({ title: "缺少 URL", passage: "无效" })
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
});

const tencentPage = await TENCENT_WEB_SEARCH_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "tencent-private-key" },
  tools(TENCENT_WEB_SEARCH_PROVIDER)
);
assert.equal(requestedUrl, "https://api.wsa.cloud.tencent.com/SearchPro");
assert.equal(new URL(requestedUrl).search, "");
const tencentHeaders = new Headers(requestedInit?.headers);
assert.equal(tencentHeaders.get("authorization"), "Bearer tencent-private-key");
assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
  Query: "寻找正在采购工业照明的中国企业 led 工业照明 制造业 采购商 中国 -招聘",
  Mode: 0
});
assert.equal(tencentPage.rawCount, 3);
assert.equal(tencentPage.records.length, 1);
assert.equal(tencentPage.invalidCount, 2);
assert.match(tencentPage.warnings?.join("\n") || "", /无效结果 2 条/);
assert.equal(tencentPage.records[0]?.sourceUrl, "https://factory.example.cn/purchase/lighting");
assert.equal(tencentPage.records[0]?.description, "该工厂发布的工业照明采购信息索引摘要。");
assert.match(tencentPage.records[0]?.providerRecordId || "", /^urlh:[a-f0-9]{64}$/);
assert.equal(tencentPage.records[0]?.confidence, 0);
assert.equal(tencentPage.records[0]?.officialWebsite, "");
assert.match(tencentPage.records[0]?.evidenceSummary || "", /腾讯联网搜索第 1 名/);
assert.match(tencentPage.records[0]?.evidenceSummary || "", /示例工厂/);
assert.match(tencentPage.records[0]?.evidenceSummary || "", /请求 tencent-request-1/);
assert.match(tencentPage.records[0]?.evidenceSummary || "", /检索相关性 0.87/);
assert.equal(tencentPage.exhausted, true);
assert.match(tencentPage.warnings?.join("\n") || "", /可能不完整/);
assert.match(tencentPage.warnings?.join("\n") || "", /无可继续游标/);
assert.equal(String(requestedUrl).includes("tencent-private-key"), false);

const largerTencentQuery = normalizeProviderQuery({
  ...query,
  productKeywords: query.productKeywords.join(","),
  countries: query.countries.join(","),
  industry: query.industries.join(","),
  customerType: query.customerTypes.join(","),
  excludeKeywords: query.excludeKeywords.join(","),
  limit: 30
});
setProviderHttpTestTransport(async (_url, init) => {
  requestedInit = init;
  return new Response(JSON.stringify({
    Response: { Query: "test", RequestId: "tencent-request-2", Pages: [] }
  }), { status: 200 });
});
await TENCENT_WEB_SEARCH_PROVIDER.search!(
  { query: largerTencentQuery, cursor: "" },
  { apiKey: "tencent-private-key" },
  tools(TENCENT_WEB_SEARCH_PROVIDER)
);
assert.equal(
  Object.prototype.hasOwnProperty.call(JSON.parse(String(requestedInit?.body)), "Cnt"),
  false
);

setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify({
    query: "工业照明",
    results: [
      {
        title: "北方设备公司采购动态",
        url: "https://Equipment.Example.cn/",
        content: "Tavily 返回的索引摘要，不是目标网页全文。",
        score: 0.91
      },
      {
        title: "无效分数",
        url: "https://invalid.example.cn/",
        content: "无效",
        score: 2
      }
    ],
    usage: { credits: 1 },
    request_id: "tavily-request-1",
    response_time: 0.42
  }), { status: 200, headers: { "content-type": "application/json" } });
});

const tavilyPage = await TAVILY_SEARCH_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "tavily-private-key" },
  tools(TAVILY_SEARCH_PROVIDER)
);
assert.equal(requestedUrl, "https://api.tavily.com/search");
assert.equal(new URL(requestedUrl).search, "");
const tavilyHeaders = new Headers(requestedInit?.headers);
assert.equal(tavilyHeaders.get("authorization"), "Bearer tavily-private-key");
assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
  query: "寻找正在采购工业照明的中国企业 led 工业照明 制造业 采购商 中国 -招聘",
  search_depth: "basic",
  topic: "general",
  max_results: 7,
  include_answer: false,
  include_raw_content: false,
  include_usage: true
});
assert.equal(tavilyPage.records.length, 1);
assert.equal(tavilyPage.invalidCount, 1);
assert.equal(tavilyPage.records[0]?.sourceUrl, "https://equipment.example.cn/");
assert.equal(tavilyPage.records[0]?.description, "Tavily 返回的索引摘要，不是目标网页全文。");
assert.match(tavilyPage.records[0]?.providerRecordId || "", /^urlh:[a-f0-9]{64}$/);
assert.equal(tavilyPage.records[0]?.confidence, 0);
assert.equal(tavilyPage.records[0]?.officialWebsite, "");
assert.equal(tavilyPage.usage?.quotaUsed, 1);
assert.equal(tavilyPage.usage?.requestCount, 1);
assert.match(tavilyPage.usage?.display || "", /1 credit/);
assert.match(tavilyPage.records[0]?.evidenceSummary || "", /Tavily 索引第 1 名/);
assert.match(tavilyPage.records[0]?.evidenceSummary || "", /请求 tavily-request-1/);
assert.match(tavilyPage.records[0]?.evidenceSummary || "", /检索相关性 0.91/);
assert.equal(tavilyPage.exhausted, true);
assert.equal(String(requestedUrl).includes("tavily-private-key"), false);

for (const [provider, malformedResponse] of [
  [BAIDU_AI_SEARCH_PROVIDER, []],
  [TENCENT_WEB_SEARCH_PROVIDER, { Response: { RequestId: "x" } }],
  [TAVILY_SEARCH_PROVIDER, { request_id: "x" }]
] as const) {
  setProviderHttpTestTransport(async () =>
    new Response(JSON.stringify(malformedResponse), { status: 200 })
  );
  await assert.rejects(
    provider.search!(
      { query, cursor: "" },
      { apiKey: "private-key" },
      tools(provider)
    ),
    (error: unknown) => error instanceof ProviderContractError
      && error.code === "PROVIDER_SCHEMA_CHANGED"
  );
}

for (const status of [400, 200]) {
  setProviderHttpTestTransport(async () => new Response(JSON.stringify({
    requestId: "baidu-auth-failure",
    code: 216003,
    message: "Authentication error with sensitive provider detail"
  }), { status }));
  await assert.rejects(
    BAIDU_AI_SEARCH_PROVIDER.search!(
      { query, cursor: "" },
      { apiKey: "private-key" },
      tools(BAIDU_AI_SEARCH_PROVIDER)
    ),
    (error: unknown) => error instanceof ProviderContractError
      && error.code === "PROVIDER_AUTH_FAILED"
      && error.httpStatus === (status === 200 ? 401 : status)
      && !error.publicMessage.includes("sensitive")
  );
}

for (const [status, expectedCode] of [
  [401, "PROVIDER_AUTH_FAILED"],
  [403, "PROVIDER_AUTH_FAILED"],
  [429, "PROVIDER_RATE_LIMITED"],
  [503, "PROVIDER_UNAVAILABLE"]
] as const) {
  setProviderHttpTestTransport(async () => new Response("error", { status }));
  await assert.rejects(
    BAIDU_AI_SEARCH_PROVIDER.search!(
      { query, cursor: "" },
      { apiKey: "private-key" },
      tools(BAIDU_AI_SEARCH_PROVIDER)
    ).catch((error) => {
      throw providerErrorFromUnknown(error, "search");
    }),
    (error: unknown) => error instanceof ProviderContractError
      && error.code === expectedCode
  );
}

for (const status of [432, 433]) {
  setProviderHttpTestTransport(async () => new Response(JSON.stringify({
    detail: { error: "This request exceeds the plan usage limit." }
  }), { status }));
  await assert.rejects(
    TAVILY_SEARCH_PROVIDER.search!(
      { query, cursor: "" },
      { apiKey: "private-key" },
      tools(TAVILY_SEARCH_PROVIDER)
    ),
    (error: unknown) => error instanceof ProviderContractError
      && error.code === "PROVIDER_QUOTA_EXHAUSTED"
      && error.httpStatus === status
  );
}

let networkCalls = 0;
setProviderHttpTestTransport(async () => {
  networkCalls += 1;
  return new Response("{}");
});
await assert.rejects(
  BAIDU_AI_SEARCH_PROVIDER.search!(
    { query, cursor: "" },
    { apiKey: "private-key", baseUrl: "https://example.com" },
    tools(BAIDU_AI_SEARCH_PROVIDER)
  ).catch((error) => {
    throw providerErrorFromUnknown(error, "search");
  }),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_POLICY_BLOCKED"
);
assert.equal(networkCalls, 0);

const healthFixtures = new Map<string, unknown>([
  ["baidu_ai_search", { request_id: "health-baidu", references: [] }],
  ["tencent_web_search", {
    Response: { Query: "GoodJob", RequestId: "health-tencent", Pages: [] }
  }],
  ["tavily", {
    query: "GoodJob",
    results: [],
    usage: { credits: 1 },
    request_id: "health-tavily",
    response_time: 0.1
  }]
]);
for (const provider of REAL_WEB_SEARCH_PROVIDERS) {
  let healthCalls = 0;
  setProviderHttpTestTransport(async () => {
    healthCalls += 1;
    return new Response(JSON.stringify(healthFixtures.get(provider.id)), { status: 200 });
  });
  const result = await provider.health(
    { apiKey: `${provider.id}-private-key` },
    tools(provider)
  );
  assert.equal(result.ok, true);
  assert.equal(healthCalls, 1, `${provider.id} health should issue one minimal real request`);
}

const integrationSecret = "integration-baidu-secret-never-log";
const integrationIdentity = {
  id: "connection_baidu_integration",
  providerId: BAIDU_AI_SEARCH_PROVIDER.id,
  ownerId: "owner_search_integration",
  teamId: "team_search_integration"
};
const integrationConnection: ProviderConnection = {
  ...integrationIdentity,
  scope: "personal",
  credentialRef: "credential_baidu_integration",
  configurationEncrypted: encryptProviderConfiguration(integrationIdentity, {
    apiKey: integrationSecret,
    baseUrl: BAIDU_AI_SEARCH_PROVIDER.defaultBaseUrl || ""
  }),
  status: "active",
  quotaPolicy: {},
  budgetPolicy: {},
  lastHealthAt: "",
  lastHealthStatus: "untested",
  lastErrorCode: "",
  lastHealthMessage: "",
  usage: "",
  createdBy: integrationIdentity.ownerId,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z"
};
const integrationLogs: ProviderRequestLog[] = [];
let integrationNetworkCalls = 0;
setProviderHttpTestTransport(async (_url, init) => {
  integrationNetworkCalls += 1;
  assert.equal(
    new Headers(init.headers).get("x-appbuilder-authorization"),
    `Bearer ${integrationSecret}`
  );
  return new Response(JSON.stringify({
    request_id: `integration-request-${integrationNetworkCalls}`,
    references: integrationNetworkCalls === 1
      ? [{
          id: 1,
          title: "集成测试搜索结果",
          url: "https://integration.example.cn/result",
          snippet: "仅用于验证加密连接、运行时和审计脱敏。"
        }]
      : []
  }), { status: 200 });
});
const integrationCatalog = catalog(BAIDU_AI_SEARCH_PROVIDER);
const integrationSearch = await executeProviderSearch({
  provider: BAIDU_AI_SEARCH_PROVIDER,
  catalog: integrationCatalog,
  context: createProviderExecutionContext({
    teamId: integrationIdentity.teamId,
    ownerId: integrationIdentity.ownerId,
    runId: "run_web_search_integration",
    providerId: BAIDU_AI_SEARCH_PROVIDER.id,
    operation: "search",
    purpose: "encrypted_connection_integration"
  }),
  connection: integrationConnection,
  query: {
    goal: "验证真实搜索运行时",
    productKeywords: "工业照明",
    countries: "中国",
    industry: "制造业",
    customerType: "采购商",
    excludeKeywords: "",
    limit: 3
  },
  onLogs(logs) {
    integrationLogs.push(...logs);
  }
});
assert.equal(integrationSearch.records.length, 1);
const integrationHealth = await executeProviderHealth({
  provider: BAIDU_AI_SEARCH_PROVIDER,
  catalog: integrationCatalog,
  context: createProviderExecutionContext({
    teamId: integrationIdentity.teamId,
    ownerId: integrationIdentity.ownerId,
    runId: "run_web_search_health_integration",
    providerId: BAIDU_AI_SEARCH_PROVIDER.id,
    operation: "health",
    purpose: "encrypted_connection_health"
  }),
  connection: integrationConnection,
  onLogs(logs) {
    integrationLogs.push(...logs);
  }
});
assert.equal(integrationHealth.ok, true);
assert.equal(integrationNetworkCalls, 2);
assert.equal(integrationConnection.configurationEncrypted.includes(integrationSecret), false);
assert.equal(integrationLogs.length, 2);
assert.deepEqual(
  integrationLogs.map((item) => item.endpointCode).sort(),
  ["connection_test", "search"]
);
assert.ok(integrationLogs.every((item) =>
  item.connectionId === integrationConnection.id
  && /^[a-f0-9]{64}$/.test(item.requestFingerprint)
  && item.httpStatus === 200
));
const integrationAuditJson = JSON.stringify(integrationLogs);
for (const sensitiveValue of [
  integrationSecret,
  "验证真实搜索运行时",
  "工业照明",
  "x-appbuilder-authorization",
  "integration-request-1"
]) {
  assert.equal(integrationAuditJson.includes(sensitiveValue), false);
}

const blockedIdentity = {
  ...integrationIdentity,
  id: "connection_baidu_blocked"
};
const blockedConnection: ProviderConnection = {
  ...integrationConnection,
  ...blockedIdentity,
  credentialRef: "credential_baidu_blocked",
  configurationEncrypted: encryptProviderConfiguration(blockedIdentity, {
    apiKey: integrationSecret,
    baseUrl: "https://example.com"
  })
};
await assert.rejects(executeProviderSearch({
  provider: BAIDU_AI_SEARCH_PROVIDER,
  catalog: integrationCatalog,
  context: createProviderExecutionContext({
    teamId: blockedIdentity.teamId,
    ownerId: blockedIdentity.ownerId,
    runId: "run_web_search_blocked",
    providerId: BAIDU_AI_SEARCH_PROVIDER.id,
    operation: "search",
    purpose: "connection_allowlist_integration"
  }),
  connection: blockedConnection,
  query: {
    goal: "验证连接白名单",
    productKeywords: "",
    countries: "",
    industry: "",
    customerType: "",
    excludeKeywords: "",
    limit: 1
  },
  onLogs() {}
}), (error: unknown) => error instanceof ProviderContractError
  && error.code === "PROVIDER_POLICY_BLOCKED");
assert.equal(integrationNetworkCalls, 2);

assert.deepEqual(
  REAL_WEB_SEARCH_PROVIDERS.map((provider) => provider.id),
  ["baidu_ai_search", "tencent_web_search", "tavily"]
);
for (const provider of REAL_WEB_SEARCH_PROVIDERS) {
  assert.equal(provider.requiresKey, true);
  assert.equal(provider.category, "web");
  assert.equal(provider.capabilities.includes("web"), true);
  assert.equal(LEAD_PROVIDERS.includes(provider), true);
  const item = catalog(provider);
  assert.equal(item.licensePolicy.requiresKey, true);
  assert.equal(item.accessMode, "api");
}

const backendPackage = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8"
)) as { scripts?: Record<string, string> };
assert.match(
  backendPackage.scripts?.test || "",
  /test:provider:web-search/,
  "the default backend test command must aggregate the real web-search fixtures"
);

setProviderHttpTestTransport(null);
console.log("Real web search provider tests passed");
