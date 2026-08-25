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

export class AcquisitionHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AcquisitionHttpError";
  }
}

export interface DouyinAutomationApi {
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

function safeError(body: unknown, status: number): AcquisitionHttpError {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.error) ? root.error : {};
  const code = typeof nested.code === "string" ? nested.code
    : typeof root.code === "string" ? root.code : `http_${status}`;
  const message = typeof nested.message === "string" ? nested.message
    : typeof root.message === "string" ? root.message : `请求失败（HTTP ${status}）`;
  return new AcquisitionHttpError(status, code, message.slice(0, 300));
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

  const writeHeaders = (idempotencyKey: string, etag?: string) => ({
    "content-type": "application/json",
    "Idempotency-Key": idempotencyKey,
    "X-CSRF-Token": csrfFromCookie(cookieSource()),
    ...(etag ? { "If-Match": etag } : {})
  });

  return {
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
        (value) => value.runId === runId && validString(value.state) && typeof value.recordCount === "number");
    },
    listRunCandidates(runId, signal) {
      return request(`/api/v1/acquisition/runs/${segment(runId)}/candidates`, { method: "GET", signal },
        (value) => Array.isArray(value.items) && (value.nextCursor === null || typeof value.nextCursor === "string"));
    }
  };
}
