import {
  ProviderContractError,
  defineProvider,
  providerHttpStatusError,
  type LeadProvider,
  type NormalizedProviderQuery,
  type ProviderAdapterPage,
  type ProviderCredential,
  type ProviderHealthResult,
  type ProviderOperation,
  type ProviderRuntimeTools,
  type ProviderSearchRequest,
  type ProviderUsage,
  type RawLead
} from "./provider-contract.js";
import { providerRequestFingerprint } from "./provider-request-logging.js";

type JsonObject = Record<string, unknown>;

const HEALTH_QUERY: NormalizedProviderQuery = {
  goal: "GoodJob",
  productKeywords: [],
  countries: [],
  industries: [],
  customerTypes: [],
  excludeKeywords: [],
  limit: 1
};

function schemaChanged(providerName: string, phase: ProviderOperation, cause?: unknown) {
  return new ProviderContractError({
    code: "PROVIDER_SCHEMA_CHANGED",
    retryable: false,
    retryAfterAt: null,
    publicMessage: `${providerName} 返回结构发生变化，已暂停本次查询`,
    httpStatus: null,
    phase
  }, cause === undefined ? undefined : { cause });
}

function quotaExhausted(providerName: string, phase: ProviderOperation, httpStatus: number) {
  return new ProviderContractError({
    code: "PROVIDER_QUOTA_EXHAUSTED",
    retryable: false,
    retryAfterAt: null,
    publicMessage: `${providerName} 额度已用尽，请检查套餐或预算`,
    httpStatus,
    phase
  });
}

function providerFailure(input: {
  code: ProviderContractError["code"];
  providerName: string;
  phase: ProviderOperation;
  httpStatus: number | null;
  retryable?: boolean;
}) {
  const publicMessages: Partial<Record<ProviderContractError["code"], string>> = {
    PROVIDER_AUTH_FAILED: `${input.providerName} 鉴权失败，请检查 API Key`,
    PROVIDER_RATE_LIMITED: `${input.providerName} 调用过于频繁，请稍后重试`,
    PROVIDER_TIMEOUT: `${input.providerName} 请求超时，请稍后重试`,
    PROVIDER_UNAVAILABLE: `${input.providerName} 暂时不可用，请稍后重试`
  };
  return new ProviderContractError({
    code: input.code,
    retryable: input.retryable ?? false,
    retryAfterAt: null,
    publicMessage: publicMessages[input.code] || `${input.providerName} 请求失败`,
    httpStatus: input.httpStatus,
    phase: input.phase
  });
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function webQueryText(query: NormalizedProviderQuery) {
  const exclude = query.excludeKeywords.map((item) => `-${item}`).join(" ");
  return [
    query.goal,
    query.productKeywords.join(" "),
    query.industries.join(" "),
    query.customerTypes.join(" "),
    query.countries.join(" "),
    exclude
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function baiduCharacterWeight(character: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 2 : 1;
}

function baiduWeightedLength(value: string) {
  return Array.from(value).reduce(
    (total, character) => total + baiduCharacterWeight(character),
    0
  );
}

function takeBaiduWeighted(value: string, budget: number) {
  let used = 0;
  let result = "";
  for (const character of value) {
    const weight = baiduCharacterWeight(character);
    if (used + weight > budget) break;
    result += character;
    used += weight;
  }
  return result.trim();
}

function baiduQueryText(query: NormalizedProviderQuery) {
  const full = webQueryText(query);
  const maxWeight = 72;
  if (baiduWeightedLength(full) <= maxWeight) {
    return { text: full, truncated: false };
  }

  const exclusions = query.excludeKeywords.map((item) => `-${item}`).join(" ");
  const reservedExclusions = takeBaiduWeighted(exclusions, Math.min(24, maxWeight));
  const separatorWeight = reservedExclusions ? 1 : 0;
  const core = query.goal
    || query.productKeywords.join(" ")
    || query.industries.join(" ")
    || "企业采购";
  const coreBudget = Math.max(
    0,
    maxWeight - baiduWeightedLength(reservedExclusions) - separatorWeight
  );
  let text = takeBaiduWeighted(core, coreBudget);
  if (reservedExclusions) text = `${text} ${reservedExclusions}`.trim();

  const context = [
    query.productKeywords.join(" "),
    query.industries.join(" "),
    query.customerTypes.join(" "),
    query.countries.join(" ")
  ].filter(Boolean).join(" ");
  const remaining = maxWeight - baiduWeightedLength(text) - (text && context ? 1 : 0);
  if (remaining > 0 && context) {
    text = `${text} ${takeBaiduWeighted(context, remaining)}`.trim();
  }
  return { text, truncated: true };
}

function validSourceUrl(value: unknown) {
  const raw = nonEmptyString(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function domainFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function companyFromResult(title: string, url: string) {
  const titleCompany = title.split(/[-|｜–—]/)[0]?.trim();
  if (titleCompany) return titleCompany.slice(0, 200);
  const domain = domainFromUrl(url);
  const stem = domain.split(".")[0] || "公开搜索结果";
  return stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()).slice(0, 200);
}

function canonicalSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

function stableSourceRecordId(providerId: string, sourceUrl: string) {
  return `urlh:${providerRequestFingerprint({
    purpose: "provider-source-record-v1",
    providerId,
    sourceUrl: canonicalSourceUrl(sourceUrl)
  })}`;
}

function discoveryLead(input: {
  providerId: string;
  requestId: string;
  title: string;
  url: string;
  snippet: string;
  query: NormalizedProviderQuery;
  evidencePrefix: string;
  evidenceDetails?: string[];
  score?: number | null;
}): RawLead {
  const snippet = input.snippet.slice(0, 2000);
  const details = [
    `请求 ${input.requestId}`,
    ...(input.evidenceDetails || []),
    typeof input.score === "number" ? `检索相关性 ${input.score}` : ""
  ].filter(Boolean);
  const evidence = [
    input.evidencePrefix,
    ...details,
    snippet || input.title
  ].filter(Boolean).join("；").slice(0, 1000);
  return {
    company: companyFromResult(input.title, input.url),
    officialWebsite: "",
    country: input.query.countries[0] || "未知",
    business: (snippet || input.query.productKeywords.join(", ") || input.query.industries.join(", ") || "待核实业务").slice(0, 500),
    contact: "待维护",
    contactInfo: "",
    description: snippet,
    confidence: 0,
    providerRecordId: stableSourceRecordId(input.providerId, input.url),
    sourceUrl: input.url,
    recordType: "discovery_page",
    evidenceSummary: evidence,
    matchedFields: [
      "company",
      "description",
      "sourceUrl"
    ]
  };
}

function providerPage(input: {
  records: RawLead[];
  rawCount: number;
  invalidCount: number;
  warnings: string[];
  usage?: Partial<ProviderUsage>;
  exhausted?: boolean;
}): ProviderAdapterPage {
  return {
    records: input.records,
    rawCount: input.rawCount,
    invalidCount: input.invalidCount,
    warnings: input.warnings,
    nextCursor: null,
    exhausted: input.exhausted ?? true,
    usage: {
      requestCount: 1,
      quotaUsed: null,
      quotaRemaining: null,
      costAmount: null,
      currency: null,
      estimated: false,
      display: "",
      ...input.usage
    }
  };
}

async function readJsonResponse(
  response: Response,
  providerName: string,
  phase: ProviderOperation,
  quotaStatuses: number[] = []
) {
  if (quotaStatuses.includes(response.status)) {
    throw quotaExhausted(providerName, phase, response.status);
  }
  if (!response.ok) throw providerHttpStatusError(response, providerName);
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw schemaChanged(providerName, phase, error);
  }
}

function baseUrl(credential: ProviderCredential, fallback: string) {
  return (credential.baseUrl || fallback).replace(/\/+$/, "");
}

async function readBaiduResponse(response: Response, phase: ProviderOperation) {
  const providerName = "百度 AI 搜索";
  const raw = await response.text();
  let payload: unknown;
  const mayInspectBusinessError = response.ok || raw.length <= 64 * 1024;
  if (mayInspectBusinessError) {
    try {
      payload = raw ? JSON.parse(raw) as unknown : null;
    } catch (error) {
      if (response.ok) throw schemaChanged(providerName, phase, error);
    }
  }

  if (isObject(payload)) {
    const businessCode = typeof payload.code === "number"
      ? payload.code
      : Number(nonEmptyString(payload.code));
    if (businessCode === 216003) {
      throw providerFailure({
        code: "PROVIDER_AUTH_FAILED",
        providerName,
        phase,
        httpStatus: response.ok ? 401 : response.status
      });
    }
    if (Number.isFinite(businessCode) && businessCode !== 0 && response.ok) {
      throw providerFailure({
        code: "PROVIDER_UNAVAILABLE",
        providerName,
        phase,
        httpStatus: response.status,
        retryable: true
      });
    }
  }
  if (!response.ok) throw providerHttpStatusError(response, providerName);
  return payload;
}

async function baiduSearch(
  request: ProviderSearchRequest,
  credential: ProviderCredential,
  tools: ProviderRuntimeTools,
  phase: ProviderOperation = "search"
) {
  const boundedQuery = baiduQueryText(request.query);
  const requestedLimit = Math.min(request.query.limit, 20);
  const response = await tools.http.fetch(
    `${baseUrl(credential, "https://qianfan.baidubce.com/v2/ai_search")}/web_search`,
    {
      method: "POST",
      headers: {
        "X-Appbuilder-Authorization": `Bearer ${credential.apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: boundedQuery.text }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: requestedLimit }],
        safe_search: true
      })
    }
  );
  const payload = await readBaiduResponse(response, phase);
  if (!isObject(payload)
    || !nonEmptyString(payload.request_id)) {
    throw schemaChanged("百度 AI 搜索", phase);
  }
  if (payload.references !== undefined && !Array.isArray(payload.references)) {
    throw schemaChanged("百度 AI 搜索", phase);
  }

  const requestId = nonEmptyString(payload.request_id);
  const references = Array.isArray(payload.references) ? payload.references : [];
  const records: RawLead[] = [];
  let invalidCount = 0;
  let ignoredNonWeb = 0;
  references.forEach((value, index) => {
    if (!isObject(value)) {
      invalidCount += 1;
      return;
    }
    const resourceType = nonEmptyString(value.type);
    if (resourceType && resourceType !== "web") {
      ignoredNonWeb += 1;
      return;
    }
    const title = nonEmptyString(value.title);
    const url = validSourceUrl(value.url);
    if (!title || !url) {
      invalidCount += 1;
      return;
    }
    const snippet = nonEmptyString(value.snippet) || nonEmptyString(value.content);
    const date = nonEmptyString(value.date);
    records.push(discoveryLead({
      providerId: BAIDU_AI_SEARCH_PROVIDER.id,
      requestId,
      title,
      url,
      snippet,
      query: request.query,
      evidencePrefix: `百度索引第 ${index + 1} 名`,
      evidenceDetails: date ? [`网页日期 ${date}`] : []
    }));
  });

  const warnings = [
    ...(boundedQuery.truncated ? ["百度搜索词已按官方 72 字符权重上限截断，保留核心目标与排除词"] : []),
    ...(ignoredNonWeb ? [`已忽略非网页结果 ${ignoredNonWeb} 条`] : []),
    ...(invalidCount ? [`已忽略无效网页结果 ${invalidCount} 条`] : []),
    ...(references.length >= requestedLimit
      ? ["百度结果已达到当前请求上限；该接口当前无可继续游标，结果可能不完整"]
      : [])
  ];
  return providerPage({
    records,
    rawCount: references.length,
    invalidCount,
    warnings,
    exhausted: true
  });
}

async function tencentSearch(
  request: ProviderSearchRequest,
  credential: ProviderCredential,
  tools: ProviderRuntimeTools,
  phase: ProviderOperation = "search"
) {
  const response = await tools.http.fetch(
    `${baseUrl(credential, "https://api.wsa.cloud.tencent.com")}/SearchPro`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        Query: webQueryText(request.query),
        Mode: 0
      })
    }
  );
  const payload = await readJsonResponse(response, "腾讯联网搜索", phase);
  const responseBody = isObject(payload) && isObject(payload.Response)
    ? payload.Response
    : null;
  if (!responseBody
    || !Array.isArray(responseBody.Pages)
    || !nonEmptyString(responseBody.RequestId)) {
    throw schemaChanged("腾讯联网搜索", phase);
  }

  const requestId = nonEmptyString(responseBody.RequestId);
  const records: RawLead[] = [];
  let invalidCount = 0;
  responseBody.Pages.forEach((serialized, index) => {
    if (typeof serialized !== "string") {
      invalidCount += 1;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      invalidCount += 1;
      return;
    }
    if (!isObject(value)) {
      invalidCount += 1;
      return;
    }
    const title = nonEmptyString(value.title);
    const url = validSourceUrl(value.url);
    const score = typeof value.score === "number"
      && Number.isFinite(value.score)
      && value.score >= 0
      && value.score <= 1
      ? value.score
      : null;
    if (!title || !url || score === null) {
      invalidCount += 1;
      return;
    }
    const snippet = nonEmptyString(value.passage) || nonEmptyString(value.content);
    const site = nonEmptyString(value.site);
    const date = nonEmptyString(value.date);
    records.push(discoveryLead({
      providerId: TENCENT_WEB_SEARCH_PROVIDER.id,
      requestId,
      title,
      url,
      snippet,
      query: request.query,
      evidencePrefix: `腾讯联网搜索第 ${index + 1} 名`,
      evidenceDetails: [
        site ? `站点 ${site}` : "",
        date ? `网页日期 ${date}` : ""
      ],
      score
    }));
  });
  return providerPage({
    records,
    rawCount: responseBody.Pages.length,
    invalidCount,
    warnings: [
      ...(invalidCount ? [`已忽略无效结果 ${invalidCount} 条`] : []),
      ...(responseBody.Pages.length
        ? ["腾讯标准接口使用默认返回规模；该接口当前无可继续游标，结果可能不完整"]
        : [])
    ],
    exhausted: true
  });
}

async function tavilySearch(
  request: ProviderSearchRequest,
  credential: ProviderCredential,
  tools: ProviderRuntimeTools,
  phase: ProviderOperation = "search"
) {
  const requestedLimit = Math.min(request.query.limit, 20);
  const response = await tools.http.fetch(
    `${baseUrl(credential, "https://api.tavily.com")}/search`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        query: webQueryText(request.query),
        search_depth: "basic",
        topic: "general",
        max_results: requestedLimit,
        include_answer: false,
        include_raw_content: false,
        include_usage: true
      })
    }
  );
  const payload = await readJsonResponse(response, "Tavily", phase, [432, 433]);
  if (!isObject(payload)
    || !Array.isArray(payload.results)
    || !nonEmptyString(payload.request_id)) {
    throw schemaChanged("Tavily", phase);
  }
  let credits: number | null = null;
  if (payload.usage !== undefined) {
    if (!isObject(payload.usage)
      || typeof payload.usage.credits !== "number"
      || !Number.isFinite(payload.usage.credits)
      || payload.usage.credits < 0) {
      throw schemaChanged("Tavily", phase);
    }
    credits = payload.usage.credits;
  }

  const requestId = nonEmptyString(payload.request_id);
  const records: RawLead[] = [];
  let invalidCount = 0;
  payload.results.forEach((value, index) => {
    if (!isObject(value)) {
      invalidCount += 1;
      return;
    }
    const title = nonEmptyString(value.title);
    const url = validSourceUrl(value.url);
    const snippet = nonEmptyString(value.content);
    const score = typeof value.score === "number"
      && Number.isFinite(value.score)
      && value.score >= 0
      && value.score <= 1
      ? value.score
      : null;
    if (!title || !url || !snippet || score === null) {
      invalidCount += 1;
      return;
    }
    records.push(discoveryLead({
      providerId: TAVILY_SEARCH_PROVIDER.id,
      requestId,
      title,
      url,
      snippet,
      query: request.query,
      evidencePrefix: `Tavily 索引第 ${index + 1} 名`,
      score
    }));
  });
  return providerPage({
    records,
    rawCount: payload.results.length,
    invalidCount,
    warnings: [
      ...(invalidCount ? [`已忽略无效结果 ${invalidCount} 条`] : []),
      ...(payload.results.length >= requestedLimit
        ? ["Tavily 结果已达到当前请求上限；该接口当前无可继续游标，结果可能不完整"]
        : [])
    ],
    exhausted: true,
    usage: credits === null
      ? undefined
      : {
          quotaUsed: credits,
          display: `本次使用 ${credits} credit${credits === 1 ? "" : "s"}`
        }
  });
}

async function healthFromSearch(
  search: (
    request: ProviderSearchRequest,
    credential: ProviderCredential,
    tools: ProviderRuntimeTools,
    phase: ProviderOperation
  ) => Promise<ProviderAdapterPage>,
  credential: ProviderCredential,
  tools: ProviderRuntimeTools,
  providerName: string
): Promise<ProviderHealthResult> {
  const page = await search(
    { query: HEALTH_QUERY, cursor: "" },
    credential,
    tools,
    "health"
  );
  return {
    ok: true,
    message: `${providerName} 连接通过`,
    usage: page.usage
  };
}

export const BAIDU_AI_SEARCH_PROVIDER = defineProvider({
  id: "baidu_ai_search",
  name: "百度 AI 搜索",
  tier: "paid",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5",
  keyHint: "填写百度千帆 AppBuilder API Key；凭据仅加密保存在当前账号连接中。",
  defaultBaseUrl: "https://qianfan.baidubce.com/v2/ai_search",
  costNote: "按百度千帆 AI 搜索实际套餐与用量计费。",
  networkPolicy: {
    allowedHosts: ["qianfan.baidubce.com"],
    allowedPathPrefixes: ["/v2/ai_search/web_search"],
    allowedMethods: ["POST"]
  },
  search: baiduSearch,
  async health(credential, tools) {
    return await healthFromSearch(baiduSearch, credential, tools, "百度 AI 搜索");
  }
});

export const TENCENT_WEB_SEARCH_PROVIDER = defineProvider({
  id: "tencent_web_search",
  name: "腾讯联网搜索",
  tier: "paid",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://cloud.tencent.com/document/product/1806/130615",
  keyHint: "填写腾讯云联网搜索 API Key；凭据仅加密保存在当前账号连接中。",
  defaultBaseUrl: "https://api.wsa.cloud.tencent.com",
  costNote: "按腾讯云联网搜索实际套餐与用量计费。",
  networkPolicy: {
    allowedHosts: ["api.wsa.cloud.tencent.com"],
    allowedPathPrefixes: ["/SearchPro"],
    allowedMethods: ["POST"]
  },
  search: tencentSearch,
  async health(credential, tools) {
    return await healthFromSearch(tencentSearch, credential, tools, "腾讯联网搜索");
  }
});

export const TAVILY_SEARCH_PROVIDER = defineProvider({
  id: "tavily",
  name: "Tavily Search",
  tier: "paid",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  keyHint: "填写 Tavily API Key；凭据仅加密保存在当前账号连接中。",
  defaultBaseUrl: "https://api.tavily.com",
  costNote: "按 Tavily 实际 credit 用量与套餐计费。",
  networkPolicy: {
    allowedHosts: ["api.tavily.com"],
    allowedPathPrefixes: ["/search"],
    allowedMethods: ["POST"]
  },
  search: tavilySearch,
  async health(credential, tools) {
    return await healthFromSearch(tavilySearch, credential, tools, "Tavily");
  }
});

export const REAL_WEB_SEARCH_PROVIDERS: LeadProvider[] = [
  BAIDU_AI_SEARCH_PROVIDER,
  TENCENT_WEB_SEARCH_PROVIDER,
  TAVILY_SEARCH_PROVIDER
];
