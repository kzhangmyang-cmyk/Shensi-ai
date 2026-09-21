import { csrfFromCookie } from "./csrf";

export interface AcquisitionPerformanceFact {
  metricId: string;
  text: string;
  evidenceRefs: string[];
}

export interface AcquisitionPerformanceDto {
  counts: {
    discovered: number;
    highIntent: number;
    approved: number;
    converted: number;
    contacted: number;
    quoted: number;
    won: number;
    lost: number;
  };
  rates: {
    highIntentRate: number | null;
    approvalRate: number | null;
    crmConversionRate: number | null;
    contactRate: number | null;
    quoteRate: number | null;
    winRate: number | null;
  };
  valuesByCurrency: Array<{
    currency: string;
    estimatedPipelineMinor: number;
    quotedMinor: number;
    wonContractMinor: number;
  }>;
  cost: {
    status: "available" | "not_aggregatable";
    executionCostMinor: number | null;
    currency: string | null;
    coverage: "recorded_api_execution_only";
  };
  roi: {
    status: "not_computable";
    reason: "channel_cost_or_verified_margin_unavailable";
  };
  dataQuality: {
    missingAttribution: number;
    missingFinancial: number;
    truncated: boolean;
    lastReconciledAt: string | null;
  };
  briefingFacts: {
    headlines: AcquisitionPerformanceFact[];
    risks: AcquisitionPerformanceFact[];
    actions: AcquisitionPerformanceFact[];
    metricIds: string[];
  };
}
export interface AcquisitionPerformanceFilters {
  platform?: "douyin" | "web";
  from: string;
  to: string;
}

interface ErrorBody {
  message?: unknown;
  error?: { message?: unknown };
}

export class AcquisitionPerformanceApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AcquisitionPerformanceApiError";
    this.status = status;
  }
}

export interface AcquisitionPerformanceApiOptions {
  cookieSource?: () => string;
}

function message(body: ErrorBody, status: number) {
  if (typeof body.error?.message === "string" && body.error.message.trim()) {
    return body.error.message;
  }
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message;
  }
  return `请求失败（HTTP ${status}）`;
}

function key(prefix: string) {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${value}`;
}

export function createAcquisitionPerformanceApi(
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) =>
    window.setTimeout(resolve, ms)),
  options: AcquisitionPerformanceApiOptions = {}
) {
  const cookieSource = options.cookieSource
    ?? (() => typeof document === "undefined" ? "" : document.cookie);

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("X-CSRF-Token", csrfFromCookie(cookieSource()));
    }
    const response = await fetchImpl(path, {
      credentials: "same-origin",
      ...init,
      headers
    });
    const body = await response.json().catch(() => ({})) as T & ErrorBody;
    if (!response.ok) {
      throw new AcquisitionPerformanceApiError(
        message(body, response.status),
        response.status
      );
    }
    return body;
  }

  return {
    getPerformance(filters: AcquisitionPerformanceFilters) {
      const query = new URLSearchParams();
      if (filters.platform) query.set("platform", filters.platform);
      query.set("from", filters.from);
      query.set("to", filters.to);
      return request<AcquisitionPerformanceDto>(
        `/api/v1/acquisition/performance?${query.toString()}`,
        { method: "GET" }
      );
    },
    async generateBriefing(
      filters: AcquisitionPerformanceFilters,
      options: { signal?: AbortSignal } = {}
    ) {
      const signal = options.signal;
      signal?.throwIfAborted();
      const session = await request<{ resourceId: string }>(
        "/api/v1/acquisition/copilot/sessions",
        {
          method: "POST",
          signal,
          headers: { "Idempotency-Key": key("performance-session") },
          body: JSON.stringify({ connectionId: null })
        }
      );
      if (!session.resourceId) throw new Error("AI 简报会话创建失败");
      const task = await request<{ id: string }>(
        `/api/v1/acquisition/copilot/sessions/${encodeURIComponent(session.resourceId)}/messages`,
        {
          method: "POST",
          signal,
          headers: { "Idempotency-Key": key("performance-briefing") },
          body: JSON.stringify({
            responseMode: "assistant",
            targetPlatform: filters.platform ?? "web",
            message: [
              "请调用只读 get_acquisition_performance 工具生成老板经营简报。",
              `platform=${filters.platform ?? "all"}`,
              `from=${filters.from}`,
              `to=${filters.to}`,
              "只能解释工具返回的确定性事实和 metricId；不得修改数值，不得推断实际回款、毛利或 ROI。",
              "请明确区分事实、AI 解读和数据缺口。"
            ].join("\n")
          })
        }
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        signal?.throwIfAborted();
        const current = await request<{
          status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
          result: { summary?: string } | null;
          errorCode: string | null;
        }>(`/api/v1/acquisition/copilot/tasks/${encodeURIComponent(task.id)}`, {
          method: "GET",
          signal
        });
        if (current.status === "succeeded") {
          const summary = current.result?.summary?.trim();
          if (!summary) throw new Error("AI 未返回可用解读");
          return summary;
        }
        if (current.status === "failed" || current.status === "cancelled") {
          throw new Error(current.errorCode || "AI 解读生成失败");
        }
        await wait(500);
        signal?.throwIfAborted();
      }
      throw new Error("AI 解读生成超时");
    }
  };
}
