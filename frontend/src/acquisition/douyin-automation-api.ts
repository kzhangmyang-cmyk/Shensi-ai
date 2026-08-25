import type { components, operations } from "../generated/ai-acquisition";
import { csrfFromCookie } from "./csrf";

export type DouyinPolicyInput = components["schemas"]["DouyinAutomationPolicyInput"];
export type DouyinPolicy = components["schemas"]["DouyinAutomationPolicyResource"];
export type DouyinPolicyVersion = components["schemas"]["DouyinAutomationPolicyVersion"];
export type DouyinRunIntent = components["schemas"]["DouyinAutomationRunIntent"];
export type DouyinCrawlerStatus = components["schemas"]["AcquisitionCrawlerStatus"];
export type DouyinRunCandidate = components["schemas"]["AcquisitionRunCandidate"];
export type DouyinKeywordSuggestions = components["schemas"]["DouyinKeywordSuggestions"];
export type DouyinLoginSession = operations["getAcquisitionDouyinLoginSession"]["responses"][200]["content"]["application/json"];
export type DouyinAccountList = operations["listAcquisitionDouyinSocialAccounts"]["responses"][200]["content"]["application/json"];
export type DouyinAccount = DouyinAccountList["items"][number];
export type DouyinCandidatePage = operations["listAcquisitionRunCandidates"]["responses"][200]["content"]["application/json"];

export interface DouyinAutomationPlanCreateInput {
  name: string;
  keywords: string[];
  dailyCandidateLimit: number;
}

export interface DouyinAutomationPlanResource {
  id: string;
  name: string;
  status: "draft" | "approved";
  version: number;
  etag: string;
}

export interface AcquisitionHttpErrorDetail {
  path: string;
  code: string;
  message: string;
}

export class AcquisitionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly AcquisitionHttpErrorDetail[] = []
  ) {
    super(message);
    this.name = "AcquisitionHttpError";
  }
}

export interface DouyinAutomationApi {
  createPlan(input: DouyinAutomationPlanCreateInput, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinAutomationPlanResource>;
  approvePlan(planId: string, etag: string, signal?: AbortSignal): Promise<DouyinAutomationPlanResource>;
  listAccounts(signal?: AbortSignal): Promise<DouyinAccountList>;
  createLoginSession(idempotencyKey: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  getLoginSession(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  disconnectAccount(accountId: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  getAutomation(planId: string, signal?: AbortSignal): Promise<DouyinPolicy>;
  suggestKeywords(planId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinKeywordSuggestions>;
  putAutomation(planId: string, input: DouyinPolicyInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinPolicyVersion>;
  runNow(planId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinRunIntent>;
  getCrawlerStatus(runId: string, signal?: AbortSignal): Promise<DouyinCrawlerStatus>;
  listRunCandidates(runId: string, signal?: AbortSignal): Promise<DouyinCandidatePage>;
}

export interface DouyinAutomationApiOptions {
  cookie?: string;
  cookieSource?: () => string;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorDetails(value: unknown): AcquisitionHttpErrorDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.path !== "string"
      || typeof item.code !== "string"
      || typeof item.message !== "string") return [];
    return [{
      path: item.path.slice(0, 160),
      code: item.code.slice(0, 80),
      message: item.message.slice(0, 300)
    }];
  }).slice(0, 10);
}

function safeError(body: unknown, status: number): AcquisitionHttpError {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.error) ? root.error : {};
  const code = typeof nested.code === "string" ? nested.code
    : typeof root.code === "string" ? root.code : `http_${status}`;
  const message = typeof nested.message === "string" ? nested.message
    : typeof root.message === "string" ? root.message : `请求失败（HTTP ${status}）`;
  const details = safeErrorDetails(nested.details ?? root.details);
  const firstDetail = details[0];
  const displayMessage = firstDetail
    ? `${message}：${firstDetail.path || "请求内容"}：${firstDetail.message}`
    : message;
  return new AcquisitionHttpError(status, code, displayMessage.slice(0, 300), details);
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertShape<T>(body: unknown, predicate: (value: Record<string, unknown>) => boolean): T {
  if (!isRecord(body) || !predicate(body)) {
    throw new AcquisitionHttpError(502, "malformed_response", "服务器返回了无法识别的数据");
  }
  const forbidden = /cookie|accountHandle|browserProfile|leaseToken|serviceSecret/iu;
  if (forbidden.test(JSON.stringify(body))) {
    throw new AcquisitionHttpError(502, "unsafe_response", "服务器返回了不应向浏览器暴露的字段");
  }
  return body as T;
}

function policyShape(value: Record<string, unknown>): boolean {
  return validString(value.planId) && validString(value.etag)
    && Array.isArray(value.keywords) && isRecord(value.schedule)
    && typeof value.dailyCandidateLimit === "number";
}

function loginShape(value: Record<string, unknown>): boolean {
  return validString(value.id) && value.platform === "douyin"
    && ["awaiting_scan", "active", "login_expired"].includes(String(value.state))
    && validString(value.expiresAt);
}

function planShape(value: Record<string, unknown>): boolean {
  const payload = isRecord(value.payload) ? value.payload : {};
  return validString(value.id) && (validString(value.name) || validString(payload.name))
    && ["draft", "approved"].includes(String(value.status))
    && typeof value.version === "number";
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function validDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function crawlerActivityShape(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !["queued", "starting_browser", "opening_douyin", "searching",
      "collecting_comments", "finalizing", "completed"].includes(String(value.phase))
    || (value.currentKeyword !== null
      && (!validString(value.currentKeyword) || unicodeLength(value.currentKeyword) > 100))
    || !["visible", "headless"].includes(String(value.browserMode))
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) return false;
  return Object.keys(value).every((key) => [
    "phase", "currentKeyword", "browserMode", "sequence"
  ].includes(key));
}

function crawlerStatusShape(value: Record<string, unknown>, runId: string): boolean {
  const keys = [
    "runId", "state", "attempt", "cursorPersisted", "recordCount",
    "candidateBudgetUsed", "candidateBudgetLimit", "lastErrorCode",
    "createdAt", "updatedAt", "completedAt", "activity"
  ];
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && value.runId === runId
    && ["scheduled", "queued", "running", "succeeded", "partial", "paused", "cancelled", "failed"].includes(String(value.state))
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 0
    && typeof value.cursorPersisted === "boolean"
    && Number.isSafeInteger(value.recordCount) && Number(value.recordCount) >= 0
    && Number.isSafeInteger(value.candidateBudgetUsed) && Number(value.candidateBudgetUsed) >= 0
    && Number.isSafeInteger(value.candidateBudgetLimit)
    && Number(value.candidateBudgetLimit) >= 1 && Number(value.candidateBudgetLimit) <= 200
    && (value.lastErrorCode === null
      || (typeof value.lastErrorCode === "string" && unicodeLength(value.lastErrorCode) <= 100))
    && validDateTime(value.createdAt) && validDateTime(value.updatedAt)
    && (value.completedAt === null || validDateTime(value.completedAt))
    && crawlerActivityShape(value.activity);
}

export function createDouyinAutomationApi(
  fetchImpl: typeof fetch = fetch,
  options: DouyinAutomationApiOptions = {}
): DouyinAutomationApi {
  const cookieSource = options.cookieSource ?? (() => options.cookie
    ?? (typeof document === "undefined" ? "" : document.cookie));

  async function request<T>(path: string, init: RequestInit, validate: (value: Record<string, unknown>) => boolean): Promise<T> {
    const response = await fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.headers ?? {}) }
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw safeError(body, response.status);
    return assertShape<T>(body, validate);
  }

  async function requestPlan(path: string, init: RequestInit): Promise<DouyinAutomationPlanResource> {
    const response = await fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.headers ?? {}) }
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw safeError(body, response.status);
    const plan = assertShape<Record<string, unknown>>(body, planShape);
    const etag = response.headers.get("etag");
    if (!etag) throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划缺少 ETag");
    const payload = isRecord(plan.payload) ? plan.payload : {};
    return {
      id: String(plan.id),
      name: String(validString(plan.name) ? plan.name : payload.name),
      status: plan.status as DouyinAutomationPlanResource["status"],
      version: Number(plan.version),
      etag
    };
  }

  const writeHeaders = (idempotencyKey: string, etag?: string) => ({
    "content-type": "application/json",
    "Idempotency-Key": idempotencyKey,
    "X-CSRF-Token": csrfFromCookie(cookieSource()),
    ...(etag ? { "If-Match": etag } : {})
  });

  return {
    createPlan(input, idempotencyKey, signal) {
      const keywords = input.keywords.map((keyword) => keyword.trim()).filter(Boolean).slice(0, 20);
      const name = input.name.trim().slice(0, 200);
      const dailyCandidateLimit = Math.max(1, Math.min(200, Math.trunc(input.dailyCandidateLimit)));
      const objective = `通过 MediaCrawler 采集抖音公开内容，发现与 ${keywords.join("、")} 相关的潜在客户`;
      return requestPlan("/api/v1/acquisition/plans", {
        method: "POST", signal, headers: writeHeaders(idempotencyKey),
        body: JSON.stringify({
          executionMode: "douyin_mediacrawler",
          targetPlatform: "douyin",
          name,
          objective,
          icp: {
            industries: keywords,
            regions: ["不限地区"],
            organizationCriteria: ["公开内容与手工关键词匹配"],
            individualCriteria: ["公开内容与手工关键词匹配"],
            exclusionRules: []
          },
          subjectChannels: { organization: true, individual: true },
          providerConnections: [],
          operations: [],
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 1,
            maxResults: dailyCandidateLimit,
            maxAmountMinor: 0,
            maxDurationSeconds: 3_600
          },
          stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
        })
      });
    },
    approvePlan(planId, etag, signal) {
      return requestPlan(`/api/v1/acquisition/plans/${segment(planId)}/approval`, {
        method: "POST", signal,
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfFromCookie(cookieSource()),
          "If-Match": etag
        },
        body: JSON.stringify({ decision: "approve", reason: "启用 MediaCrawler 抖音自动采集" })
      });
    },
    listAccounts(signal) {
      return request("/api/v1/acquisition/social-accounts/douyin", { method: "GET", signal },
        (value) => Array.isArray(value.items));
    },
    createLoginSession(idempotencyKey, signal) {
      return request("/api/v1/acquisition/social-accounts/douyin/login-sessions", {
        method: "POST", signal, headers: writeHeaders(idempotencyKey),
        body: JSON.stringify({ platform: "douyin" })
      }, loginShape);
    },
    getLoginSession(sessionId, signal) {
      return request(`/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}`,
        { method: "GET", signal }, loginShape);
    },
    async disconnectAccount(accountId, etag, idempotencyKey, signal) {
      await request(`/api/v1/acquisition/social-accounts/${segment(accountId)}`, {
        method: "DELETE", signal, headers: writeHeaders(idempotencyKey, etag)
      }, (value) => validString(value.id) && value.state === "disconnected");
    },
    getAutomation(planId, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation`,
        { method: "GET", signal }, policyShape);
    },
    suggestKeywords(planId, idempotencyKey, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation/keyword-suggestions`, {
        method: "POST", signal, headers: writeHeaders(idempotencyKey), body: "{}"
      }, (value) => Array.isArray(value.keywords) && validString(value.modelSnapshotId));
    },
    putAutomation(planId, input, etag, idempotencyKey, signal) {
      const closed: DouyinPolicyInput = {
        keywords: [...input.keywords],
        schedule: { enabled: input.schedule.enabled, localTime: input.schedule.localTime, timeZone: input.schedule.timeZone },
        dailyCandidateLimit: input.dailyCandidateLimit,
        collectCreators: input.collectCreators,
        collectDemandComments: input.collectDemandComments,
        limits: { ...input.limits }
      };
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation`, {
        method: "PUT", signal, headers: writeHeaders(idempotencyKey, etag), body: JSON.stringify(closed)
      }, policyShape);
    },
    runNow(planId, idempotencyKey, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/run-now`, {
        method: "POST", signal, headers: writeHeaders(idempotencyKey), body: "{}"
      }, (value) => validString(value.id) && validString(value.acquisitionRunId) && value.status === "queued");
    },
    getCrawlerStatus(runId, signal) {
      return request(`/api/v1/acquisition/runs/${segment(runId)}/crawler-status`, { method: "GET", signal },
        (value) => crawlerStatusShape(value, runId));
    },
    listRunCandidates(runId, signal) {
      return request(`/api/v1/acquisition/runs/${segment(runId)}/candidates`, { method: "GET", signal },
        (value) => Array.isArray(value.items) && (value.nextCursor === null || typeof value.nextCursor === "string"));
    }
  };
}
