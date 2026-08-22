import { createHash } from "node:crypto";
import {
  decryptProviderConfiguration,
  decryptProviderConfigurationWithSecret
} from "./credential-security.js";
import type {
  SearchPublicSourceResult,
  SearchPublicSourcesPort,
  SearchPublicSourcesRequest,
  SearchPublicSourcesResponse
} from "./acquisition-tool-executor.js";
import {
  ProviderContractError,
  providerErrorFromUnknown,
  type LeadProvider,
  type LeadQuery,
  type ProviderExecutionContext,
  type ProviderPage,
  type ProviderRecord
} from "./provider-contract.js";
import {
  createProviderExecutionContext,
  executeProviderSearch
} from "./provider-runtime.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProviderCatalogItem,
  ProviderConnection,
  ProviderRequestLog
} from "./types.js";
import {
  REAL_WEB_SEARCH_PROVIDERS
} from "./web-search-providers.js";
import {
  extractAcquisitionPublicCreditCode,
  isVerifiedAcquisitionPublicProfileUrl,
  normalizeAcquisitionPublicDomain,
  normalizeAcquisitionPublicUrl,
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";
import {
  classifyDouyinPublicSource,
  isDouyinBoundPublicSearchQuery,
  type DouyinPublicSourceType
} from "./acquisition-douyin-public-source.js";
import {
  acquisitionProviderConnectionVersion
} from "./acquisition-provider-connection-version.js";

export const ACQUISITION_PUBLIC_SEARCH_PROVIDER_IDS = [
  "baidu_ai_search",
  "tencent_web_search",
  "tavily",
  "serper",
  "brave",
  "serpapi"
] as const;

const ACQUISITION_PUBLIC_SEARCH_PROVIDERS = Object.freeze(
  ACQUISITION_PUBLIC_SEARCH_PROVIDER_IDS.map((providerId) => {
    const provider = [
      ...REAL_WEB_SEARCH_PROVIDERS,
      ...LEAD_PROVIDERS
    ].find((item) => item.id === providerId);
    if (!provider) {
      throw new Error(
        `Approved acquisition search provider is unavailable: ${providerId}`
      );
    }
    return provider;
  })
);

export type AcquisitionPublicSearchPortErrorCode =
  | "PROVIDER_CONNECTION_UNAVAILABLE"
  | "PROVIDER_CONNECTION_SNAPSHOT_MISMATCH"
  | "PROVIDER_NOT_SUPPORTED"
  | "PROVIDER_CATALOG_UNAVAILABLE"
  | "INVALID_PROVIDER_AUDIT_LOG"
  | "AUDIT_PERSISTENCE_FAILED"
  | "SEARCH_AND_AUDIT_PERSISTENCE_FAILED";

const ERROR_MESSAGES: Record<
  AcquisitionPublicSearchPortErrorCode,
  string
> = {
  PROVIDER_CONNECTION_UNAVAILABLE: "公开搜索连接不可用，请检查当前账号的连接配置",
  PROVIDER_CONNECTION_SNAPSHOT_MISMATCH:
    "公开搜索连接已更新，请使用当前连接重新发起搜索",
  PROVIDER_NOT_SUPPORTED: "该连接不是受支持的公开搜索数据源",
  PROVIDER_CATALOG_UNAVAILABLE: "公开搜索数据源目录不可用",
  INVALID_PROVIDER_AUDIT_LOG: "公开搜索调用缺少有效审计记录",
  AUDIT_PERSISTENCE_FAILED: "公开搜索审计记录未能安全保存",
  SEARCH_AND_AUDIT_PERSISTENCE_FAILED:
    "公开搜索失败，且调用审计记录未能安全保存"
};

export class AcquisitionPublicSearchPortError extends Error {
  constructor(public readonly code: AcquisitionPublicSearchPortErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AcquisitionPublicSearchPortError";
  }
}

export type AcquisitionPublicSearchStore = Pick<
  CrmStore,
  | "providerCatalog"
  | "providerConnections"
  | "providerRequestLogs"
  | "persist"
  | "persistMutation"
>;

export interface AcquisitionProviderSearchExecutionInput {
  provider: LeadProvider;
  catalog: ProviderCatalogItem;
  context: ProviderExecutionContext;
  connection: ProviderConnection;
  query: LeadQuery;
  onLogs(logs: ProviderRequestLog[]): void;
}

export type AcquisitionProviderSearchExecutor = (
  input: AcquisitionProviderSearchExecutionInput
) => Promise<ProviderPage>;

export interface AcquisitionPublicSearchPortOptions {
  executeSearch?: AcquisitionProviderSearchExecutor;
  credentialSecret?: string;
}

function abortError() {
  return new DOMException("aborted", "AbortError");
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function clipped(value: string | undefined, maxLength: number) {
  return (value || "").trim().slice(0, maxLength);
}

function validPublicUrl(value: string) {
  try {
    const normalized = normalizeAcquisitionPublicUrl(value);
    return normalized ? new URL(normalized) : null;
  } catch {
    return null;
  }
}

function usableRegion(value: string | undefined) {
  const region = clipped(value, 200);
  return region && !/^(?:未知|unknown|n\/a|null)$/iu.test(region)
    ? region
    : null;
}

function publicSnippet(record: ProviderRecord) {
  return clipped(
    record.description || record.evidenceSummary || record.business,
    4_000
  );
}

function localeFor(...values: string[]) {
  return values.some((value) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(value))
    ? "zh-CN"
    : "und";
}

const PUBLIC_BUSINESS_ROLE =
  /(?:主理人|创始人|联合创始人|老板|负责人|采购经理|采购负责人|总经理|店长|运营总监|销售总监|CEO|founder|owner|director|manager)/iu;
const ORGANIZATION_NAME =
  /(?:有限公司|有限责任公司|股份公司|集团|企业|公司|机构|中心|协会|合作社)$/u;

function isPublicIndividualSignal(record: ProviderRecord) {
  return isVerifiedAcquisitionPublicProfileUrl(record.sourceUrl)
    || (
      !ORGANIZATION_NAME.test(record.company.trim())
      && PUBLIC_BUSINESS_ROLE.test(record.company)
    );
}

function isUnresolvedDouyinIndividualSignal(source: {
  sourcePlatform: string;
  sourceType: DouyinPublicSourceType;
}) {
  return source.sourcePlatform === "douyin"
    && (
      source.sourceType === "video"
      || source.sourceType === "comment_signal"
      || source.sourceType === "short_link"
    );
}

function buyingStage(text: string): Extract<
  SearchPublicSourceResult["subject"],
  { kind: "individual" }
>["buyingStage"] {
  if (/(?:正在采购|采购需求|招标|求购|寻找供应商|马上购买|尽快上线|近期上线)/u.test(text)) {
    return "purchase_ready";
  }
  if (/(?:比价|对比|比较|询价|报价|方案选择)/u.test(text)) {
    return "comparison";
  }
  if (/(?:寻找方案|了解方案|调研|咨询|怎么做|解决方案)/u.test(text)) {
    return "solution_research";
  }
  if (/(?:获客难|成本高|需要|需求|痛点|缺少)/u.test(text)) {
    return "problem_defined";
  }
  return "awareness";
}

const PUBLIC_NEGATIVE_SIGNALS = [
  "不需要",
  "请勿联系",
  "拒绝推销",
  "勿扰",
  "不接受营销",
  "请勿电话推销"
] as const;

function negativeSignals(text: string) {
  return PUBLIC_NEGATIVE_SIGNALS.filter((signal) => text.includes(signal));
}

function rawArtifactHash(providerId: string, record: ProviderRecord) {
  return `sha256:${sha256(JSON.stringify({
    providerId,
    providerRecordId: record.providerRecordId,
    providerPayloadHash: record.payloadHash,
    sourceUrl: record.sourceUrl,
    title: record.company,
    snippet: publicSnippet(record),
    evidenceSummary: record.evidenceSummary
  }))}`;
}

function demandCategory(query: string) {
  return clipped(query, 100) || "公开需求信号";
}

function contentSource(
  source: URL,
  title: string,
  snippet: string
): { sourcePlatform: string; sourceType: DouyinPublicSourceType } {
  const douyin = classifyDouyinPublicSource(source, title, snippet);
  if (douyin) return douyin;
  return {
    sourcePlatform: source.hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, ""),
    sourceType: "other"
  };
}

function toPublicResult(
  providerId: string,
  record: ProviderRecord,
  request: SearchPublicSourcesRequest
): SearchPublicSourceResult | null {
  const source = validPublicUrl(record.sourceUrl);
  if (!source) return null;
  const title = clipped(record.company, 500);
  const snippet = publicSnippet(record);
  if (!title && !snippet) return null;
  const classifiedSource = contentSource(source, title, snippet);
  const individual = isUnresolvedDouyinIndividualSignal(classifiedSource)
    || isPublicIndividualSignal(record);

  if (individual) {
    if (!request.subjectKinds.includes("individual")) return null;
    const signalText = [title, snippet, record.evidenceSummary || ""].join(" ");
    const verifiedPublicProfile =
      isVerifiedAcquisitionPublicProfileUrl(source)
      && (
        classifiedSource.sourcePlatform !== "douyin"
        || classifiedSource.sourceType === "profile"
      );
    const publicActorKey = `${
      verifiedPublicProfile ? "public" : "unresolved-public-signal"
    }:${classifiedSource.sourcePlatform}:sha256:${sha256(source.toString())}`;
    const subject = {
      kind: "individual" as const,
      publicActorKey,
      publicDisplayName: classifiedSource.sourceType === "comment_signal"
        ? "抖音公开评论式信号（身份待核实）"
        : title || "公开商务账号",
      publicProfileUrl: source.toString(),
      sourcePlatform: classifiedSource.sourcePlatform,
      demandCategory: demandCategory(request.query),
      demandSummary:
        clipped(snippet || "搜索索引仅返回标题，具体需求需人工核实。", 2_000),
      locationHint: usableRegion(record.country) || "",
      buyingStage: buyingStage(signalText),
      negativeSignals: negativeSignals(signalText)
    };
    const resolution = resolveAcquisitionPublicIdentity({
      ownerId: request.ownerId,
      teamId: request.teamId,
      provider: providerId,
      sourceUrl: source.toString(),
      sourceType: classifiedSource.sourceType,
      subject
    });
    return {
      providerRecordId: record.providerRecordId,
      sourceUrl: source.toString(),
      ...classifiedSource,
      title,
      snippet,
      publishedAt: null,
      locale: localeFor(request.query, title, snippet),
      rawArtifactHash: rawArtifactHash(providerId, record),
      accessStatus: "indexed_summary",
      subject: {
        ...subject,
        individualPartyId: resolution.status === "resolved"
          ? resolution.partyId
          : null
      }
    };
  }

  if (!request.subjectKinds.includes("organization")) return null;
  const subject = {
    kind: "organization" as const,
    name: title,
    domain: normalizeAcquisitionPublicDomain(record.officialWebsite),
    region: usableRegion(record.country),
    creditCode: extractAcquisitionPublicCreditCode(
      [title, snippet, record.evidenceSummary || ""].join(" ")
    )
  };
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: request.ownerId,
    teamId: request.teamId,
    provider: providerId,
    sourceUrl: source.toString(),
    sourceType: classifiedSource.sourceType,
    subject
  });
  return {
    providerRecordId: record.providerRecordId,
    sourceUrl: source.toString(),
    ...classifiedSource,
    title,
    snippet,
    publishedAt: null,
    locale: localeFor(request.query, title, snippet),
    rawArtifactHash: rawArtifactHash(providerId, record),
    accessStatus: "indexed_summary",
    subject: {
      ...subject,
      organizationId: resolution.status === "resolved"
        ? resolution.partyId
        : null
    }
  };
}

function auditLogMatches(
  log: ProviderRequestLog,
  input: AcquisitionProviderSearchExecutionInput
) {
  return Boolean(log.id.trim())
    && log.ownerId === input.context.ownerId
    && log.teamId === input.context.teamId
    && log.providerId === input.provider.id
    && log.connectionId === input.connection.id
    && log.runId === input.context.runId
    && log.runShardId === input.context.runShardId
    && log.endpointCode === "search"
    && /^[a-f0-9]{64}$/iu.test(log.requestFingerprint)
    && Number.isFinite(log.httpStatus)
    && Number.isFinite(log.attempt)
    && Number.isFinite(log.quotaUnits)
    && Number.isFinite(log.durationMs)
    && Number.isFinite(log.responseSize)
    && Number.isFinite(Date.parse(log.requestedAt));
}

function assertValidAuditLogs(
  store: AcquisitionPublicSearchStore,
  logs: ProviderRequestLog[],
  input: AcquisitionProviderSearchExecutionInput
) {
  const ids = new Set<string>();
  if (logs.length === 0 || logs.some((log) => {
    if (!auditLogMatches(log, input)
      || ids.has(log.id)
      || store.providerRequestLogs.some((existing) => existing.id === log.id)) {
      return true;
    }
    ids.add(log.id);
    return false;
  })) {
    throw new AcquisitionPublicSearchPortError("INVALID_PROVIDER_AUDIT_LOG");
  }
}

function appendAuditMutation(
  store: AcquisitionPublicSearchStore,
  logs: ProviderRequestLog[]
): PersistedStoreMutation<void> {
  const copies = structuredClone(logs);
  const insertedIds = new Set(copies.map((log) => log.id));
  store.providerRequestLogs.unshift(...copies);
  return {
    value: undefined,
    rollback() {
      store.providerRequestLogs.splice(
        0,
        store.providerRequestLogs.length,
        ...store.providerRequestLogs.filter(
          (log) => !insertedIds.has(log.id)
        )
      );
    }
  };
}

async function persistAuditLogs(
  store: AcquisitionPublicSearchStore,
  logs: ProviderRequestLog[]
) {
  if (store.persistMutation) {
    await store.persistMutation(() => appendAuditMutation(store, logs));
    return;
  }
  const applied = appendAuditMutation(store, logs);
  try {
    await store.persist();
  } catch (error) {
    applied.rollback();
    throw error;
  }
}

function captureAuthorizedConnection(
  store: AcquisitionPublicSearchStore,
  input: SearchPublicSourcesRequest
) {
  const connection = store.providerConnections.find((candidate) =>
    candidate.id === input.providerConnectionId
    && candidate.ownerId === input.ownerId
    && candidate.teamId === input.teamId
    && candidate.scope === "personal"
    && candidate.status === "active"
  );
  if (!connection) {
    throw new AcquisitionPublicSearchPortError(
      "PROVIDER_CONNECTION_UNAVAILABLE"
    );
  }
  const captured = structuredClone(connection);
  const credentialVersion = acquisitionProviderConnectionVersion(captured);
  if (input.expectedConnection
    && (
      captured.providerId !== input.expectedConnection.providerId
      || credentialVersion !== input.expectedConnection.credentialVersion
    )) {
    throw new AcquisitionPublicSearchPortError(
      "PROVIDER_CONNECTION_SNAPSHOT_MISMATCH"
    );
  }
  return { connection: captured, credentialVersion };
}

function assertReadableByokConnection(
  connection: ProviderConnection,
  credentialSecret: string | undefined
) {
  try {
    let credential;
    if (credentialSecret === undefined) {
      credential = decryptProviderConfiguration(
        connection,
        connection.configurationEncrypted
      );
    } else {
      try {
        credential = decryptProviderConfigurationWithSecret(
          connection,
          connection.configurationEncrypted,
          credentialSecret
        );
      } catch (error) {
        const acquisitionV1 = connection.quotaPolicy?.acquisitionV1;
        if (
          acquisitionV1
          && typeof acquisitionV1 === "object"
          && !Array.isArray(acquisitionV1)
        ) {
          throw error;
        }
        credential = decryptProviderConfiguration(
          connection,
          connection.configurationEncrypted
        );
      }
    }
    if (!credential.apiKey.trim() || !connection.credentialRef.trim()) {
      throw new Error("missing credential");
    }
  } catch {
    throw new AcquisitionPublicSearchPortError(
      "PROVIDER_CONNECTION_UNAVAILABLE"
    );
  }
}

class StoreBackedAcquisitionPublicSearchPort
implements SearchPublicSourcesPort {
  private readonly providers: ReadonlyMap<string, LeadProvider>;
  private readonly executeSearch: AcquisitionProviderSearchExecutor;
  private readonly credentialSecret: string | undefined;

  constructor(
    private readonly store: AcquisitionPublicSearchStore,
    options: AcquisitionPublicSearchPortOptions
  ) {
    this.providers = new Map(
      ACQUISITION_PUBLIC_SEARCH_PROVIDERS.map((provider) => [
        provider.id,
        provider
      ])
    );
    this.executeSearch = options.executeSearch
      || (async (input) => executeProviderSearch(input));
    this.credentialSecret = options.credentialSecret;
  }

  async search(
    request: SearchPublicSourcesRequest
  ): Promise<SearchPublicSourcesResponse> {
    assertNotAborted(request.signal);
    const { connection, credentialVersion } =
      captureAuthorizedConnection(this.store, request);
    const provider = this.providers.get(connection.providerId);
    if (!provider) {
      throw new AcquisitionPublicSearchPortError("PROVIDER_NOT_SUPPORTED");
    }
    assertReadableByokConnection(connection, this.credentialSecret);

    const catalog = this.store.providerCatalog.find((item) =>
      item.code === provider.id
      && item.status === "active"
      && item.accessMode === "api"
      && item.licensePolicy.requiresKey === true
    );
    if (!catalog) {
      throw new AcquisitionPublicSearchPortError(
        "PROVIDER_CATALOG_UNAVAILABLE"
      );
    }

    const context = createProviderExecutionContext({
      ownerId: request.ownerId,
      teamId: request.teamId,
      runId: request.sessionId,
      providerId: provider.id,
      operation: "search",
      purpose: "acquisition_agent_public_search"
    });
    const logs: ProviderRequestLog[] = [];
    const executionInput: AcquisitionProviderSearchExecutionInput = {
      provider,
      catalog,
      context,
      connection,
      query: {
        goal: request.query,
        productKeywords: "",
        countries: "",
        industry: "",
        customerType: request.subjectKinds
          .map((kind) => kind === "organization" ? "企业" : "个人公开需求")
          .join(","),
        excludeKeywords: "",
        limit: request.maxResults
      },
      onLogs(emitted) {
        logs.push(...structuredClone(emitted));
      }
    };

    let page: ProviderPage | undefined;
    let searchError: unknown;
    try {
      page = await this.executeSearch(executionInput);
    } catch (error) {
      searchError = error;
    }

    let auditError: unknown;
    try {
      assertValidAuditLogs(this.store, logs, executionInput);
      await persistAuditLogs(this.store, logs);
    } catch (error) {
      auditError = error;
    }

    if (searchError !== undefined) {
      if (auditError !== undefined) {
        throw new AcquisitionPublicSearchPortError(
          "SEARCH_AND_AUDIT_PERSISTENCE_FAILED"
        );
      }
      if (searchError instanceof DOMException
        && searchError.name === "AbortError") {
        throw searchError;
      }
      const normalized = providerErrorFromUnknown(searchError, "search");
      throw new ProviderContractError({
        code: normalized.code,
        retryable: normalized.retryable,
        retryAfterAt: normalized.retryAfterAt,
        publicMessage: normalized.publicMessage,
        httpStatus: normalized.httpStatus,
        phase: normalized.phase
      });
    }
    if (auditError !== undefined) {
      if (auditError instanceof AcquisitionPublicSearchPortError
        && auditError.code === "INVALID_PROVIDER_AUDIT_LOG") {
        throw auditError;
      }
      throw new AcquisitionPublicSearchPortError(
        "AUDIT_PERSISTENCE_FAILED"
      );
    }
    assertNotAborted(request.signal);

    const douyinBound = isDouyinBoundPublicSearchQuery(request.query);
    const results = page!.records
      .map((record) => toPublicResult(provider.id, record, request))
      .filter((result): result is SearchPublicSourceResult =>
        result !== null
        && (!douyinBound || result.sourcePlatform === "douyin")
      )
      .slice(0, request.maxResults);
    return {
      providerConnectionId: connection.id,
      providerCredentialVersion: credentialVersion,
      provider: provider.id,
      requestId: context.requestId,
      results
    };
  }
}

export function createAcquisitionPublicSearchPort(
  store: AcquisitionPublicSearchStore,
  options: AcquisitionPublicSearchPortOptions = {}
): SearchPublicSourcesPort {
  return new StoreBackedAcquisitionPublicSearchPort(store, options);
}
