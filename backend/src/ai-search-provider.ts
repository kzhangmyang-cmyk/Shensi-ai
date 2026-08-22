import { z } from "zod";
import {
  AI_MODEL_TIMEOUT_MS
} from "./ai-model-runtime.js";
import {
  createActiveModelGatewayForSnapshot
} from "./model-providers/runtime.js";
import { hashModelCallValue } from "./model-providers/call-ledger.js";
import {
  defineProvider,
  type LeadQuery,
  type RawLead
} from "./provider-contract.js";
import type { CrmStore } from "./store.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";
import type {
  FakeProspectProviderDispatchRequest
} from "./prospect-fake-provider.js";

export const AI_SEARCH_PROMPT_VERSION = "ai-search.v1";
export const AI_SEARCH_SCHEMA_VERSION = "ai-search-result.v1";
export const AI_SEARCH_RESULT_SCHEMA_CANONICAL = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["companies"],
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company"],
        properties: {
          company: { type: "string" },
          website: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          business: { type: ["string", "null"] },
          description: { type: ["string", "null"] }
        }
      }
    }
  }
});
export const AI_SEARCH_SCHEMA_HASH = hashModelCallValue(
  AI_SEARCH_RESULT_SCHEMA_CANONICAL
);

const optionalResultString = z.string()
  .nullish()
  .transform((value) => value ?? "");

const aiSearchResultSchema = z.object({
  companies: z.array(z.object({
    company: z.string(),
    website: optionalResultString,
    country: optionalResultString,
    business: optionalResultString,
    description: optionalResultString
  }).strict())
}).strict();

export function aiSearchPromptFor(query: LeadQuery) {
  const count = Math.min(query.limit, 12);
  return [
    "你是资深外贸获客研究助手。根据客户画像列出真实、可能存在的目标公司。",
    "严格只返回 JSON，不要解释、不要 Markdown。",
    "JSON 结构：{\"companies\":[{\"company\":\"\",\"website\":\"\",\"country\":\"\",\"business\":\"\",\"description\":\"\"}]}",
    "只给有把握真实存在的公司；官网不确定就留空，禁止编造域名、邮箱、电话或联系人。",
    `目标公司数量：${count}`,
    `产品/关键词：${query.productKeywords || "未指定"}`,
    `国家/地区：${query.countries || "未指定"}`,
    `行业/场景：${query.industry || "未指定"}`,
    `客户类型：${query.customerType || "未指定"}`,
    `获客目标：${query.goal || "未指定"}`,
    `排除：${query.excludeKeywords || "无"}`
  ].join("\n");
}

export function aiSearchPromptHash(query: LeadQuery) {
  return hashModelCallValue(aiSearchPromptFor(query));
}

function leadsFromResult(
  query: LeadQuery,
  result: z.input<typeof aiSearchResultSchema>
): RawLead[] {
  const count = Math.min(query.limit, 12);
  return result.companies
    .slice(0, count)
    .map((item): RawLead => {
      const firstCountry =
        query.countries.split(/,|，/)[0]?.trim() || "未知";
      const detail = (item.description || "").trim();
      const officialWebsite = (item.website || "").trim();
      return {
        company: item.company.trim(),
        officialWebsite,
        website: officialWebsite,
        country: (item.country || "").trim() || firstCountry,
        business:
          (item.business || "").trim()
          || query.productKeywords
          || "待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: detail
          ? `${detail}（AI 生成，待核实）`
          : "AI 生成候选，待核实。",
        confidence: 58,
        sourceUrl: "",
        recordType: "assisted_suggestion",
        evidenceSummary:
          `${detail || "AI 生成候选"}；尚未完成外部事实核验。`,
        matchedFields: [
          "company",
          ...(officialWebsite ? ["officialWebsite"] : []),
          "country",
          "business"
        ]
      };
    })
    .filter((lead) => lead.company);
}

export function createAiSearchProvider(
  store: CrmStore,
  snapshot: StoredAiJobModelSnapshot
) {
  if (!snapshot.baseUrl) {
    throw new Error("AI search model snapshot is missing its endpoint");
  }
  const base = new URL(snapshot.baseUrl);
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  return defineProvider({
    id: "ai_search",
    name: "AI 搜索",
    tier: "ai",
    category: "ai",
    requiresKey: false,
    capabilities: ["ai", "company"],
    docsUrl: "",
    keyHint: "",
    defaultBaseUrl: snapshot.baseUrl,
    costNote:
      "调用任务创建时固化的 AI 模型，候选结果必须人工核实。",
    networkPolicy: {
      allowedHosts: [base.hostname.toLocaleLowerCase()],
      allowedPathPrefixes: [basePath],
      allowedMethods: ["POST"],
      timeoutMs: AI_MODEL_TIMEOUT_MS,
      maxResponseBytes: 2 * 1024 * 1024
    },
    async search({ query }, _credential, tools) {
      if (store.pendingAiJobModelSnapshots.some(
        (item) => item.jobId === snapshot.jobId
      )) {
        throw new Error(
          "AI job model snapshot must be durable before provider execution"
        );
      }
      const legacyQuery: LeadQuery = {
        goal: query.goal,
        productKeywords: query.productKeywords.join(", "),
        countries: query.countries.join(", "),
        industry: query.industries.join(", "),
        customerType: query.customerTypes.join(", "),
        excludeKeywords: query.excludeKeywords.join(", "),
        limit: query.limit
      };
      const gateway = createActiveModelGatewayForSnapshot(store, {
        storedSnapshot: snapshot,
        fetch: ((url: string, init?: RequestInit) =>
          tools.http.fetch(url, init)) as typeof fetch,
        requestTimeoutMs: AI_MODEL_TIMEOUT_MS
      });
      let providerError: unknown;
      try {
        const response = await gateway.generateStructured({
          prompt: aiSearchPromptFor(legacyQuery),
          schemaHash: AI_SEARCH_SCHEMA_HASH,
          schema: aiSearchResultSchema
        });
        const records = leadsFromResult(legacyQuery, response.value);
        return {
          records,
          rawCount: records.length,
          invalidCount: 0,
          nextCursor: null,
          exhausted: true,
          warnings: [
            "AI 生成候选仅属于辅助建议，进入跟进前必须核实企业身份与官网。"
          ],
          usage: {
            requestCount: 1,
            estimated: false,
            display: ""
          }
        };
      } catch (error) {
        providerError = error;
        throw error;
      } finally {
        try {
          await store.persist();
        } catch (persistenceError) {
          if (providerError !== undefined) {
            throw new AggregateError(
              [providerError, persistenceError],
              "AI 搜索失败且模型调用审计记录持久化失败"
            );
          }
          throw persistenceError;
        }
      }
    },
    async health() {
      return {
        ok: true,
        message: "AI 搜索使用任务创建时固化的模型连接"
      };
    }
  });
}

export function resolveAiSearchProviderFromSnapshot(
  store: CrmStore,
  request: Pick<
    FakeProspectProviderDispatchRequest,
    "providerCode" | "runId" | "shardId" | "ownerId" | "teamId"
  >
) {
  if (request.providerCode !== "ai_search") return undefined;
  const bindings = store.prospectRunQueueChildBindings.filter(
    (item) => item.runId === request.runId
      && item.shardId === request.shardId
      && item.ownerId === request.ownerId
      && item.teamId === request.teamId
  );
  if (bindings.length !== 1) return undefined;
  const snapshots = store.aiJobModelSnapshots.filter(
    (item) => item.jobId === bindings[0].jobId
      && item.ownerId === request.ownerId
      && item.teamId === request.teamId
  );
  if (snapshots.length !== 1 || !snapshots[0].baseUrl) {
    return undefined;
  }
  const snapshot = snapshots[0];
  return {
    provider: createAiSearchProvider(store, snapshot),
    credential: {
      apiKey: "",
      baseUrl: snapshot.baseUrl
    }
  };
}
