export interface DashboardPeriodSummary {
  label: string;
  start: string;
  end: string;
  expectedDeals: number;
  expectedAmounts: Array<{ currency: string; amount: number }>;
  pendingTodos: number;
  highPriorityTodos: number;
  newLeads: number;
  briefing: {
    title: string;
    description: string;
    basis: string;
    action: string;
    impact: string;
  };
}

export interface RealDashboardSummary {
  scope: string;
  scopeLabels: { business: string; todos: string };
  updatedAt: string;
  periods: {
    today: DashboardPeriodSummary;
    week: DashboardPeriodSummary;
    month: DashboardPeriodSummary;
  };
  history: {
    period: DashboardHistoryPeriod;
    label: string;
    start: string;
    end: string;
    buckets: Array<{
      key: string;
      label: string;
      start: string;
      end: string;
      newLeads: number;
      expectedDeals: number;
      expectedAmounts: Array<{ currency: string; amount: number }>;
    }>;
    leadSources: Array<{
      source: string;
      count: number;
      share: number;
    }>;
  };
  briefing: {
    title: string;
    description: string;
    basis: string;
    action: string;
    impact: string;
    riskAmount: number;
    riskLabel: string;
    closableDeals: number;
    closableAmount: number;
    closableAmounts: Array<{ currency: string; amount: number }>;
    unreadWecom: number;
  };
  metrics: {
    customers: number;
    riskCustomers: number;
    todos: number;
    overdueTodos: number;
    forecastAmount: number;
    forecastAmounts: Array<{ currency: string; amount: number }>;
    wecomBoundRate: number;
    pendingKnowledge: number;
    examPassRate: number;
    unfinishedExams: number;
    customerCompleteness: number;
  };
  schedule: Array<{
    time: string;
    title: string;
    subtitle: string;
    tone: string;
  }>;
  quality: {
    followHealth: number;
    overdueRate: number;
    avgResponseHours: number;
  };
  leadFunnel: {
    stages: Array<{
      key: string;
      label: string;
      count: number;
      conversionRate: number;
    }>;
    todayAdded: number;
    filteredOut: number;
    dealConversionRate: number;
  };
  pipelineHealth: Array<{
    stage: string;
    count: number;
    amount: number;
    amounts: Array<{ currency: string; amount: number }>;
    riskCount: number;
    width: number;
    tone: string;
  }>;
  todoInsights: {
    total: number;
    overdue: number;
    completionRate: number;
    impactAmount: number;
    typeRows: Array<{
      type: string;
      label: string;
      count: number;
      risk: string;
    }>;
    weekLoad: Array<{ day: string; count: number }>;
    historyCount: number;
    historyAmount: number;
  };
  priorityTasks: Array<{
    id: string;
    customerId: string;
    title: string;
    subtitle: string;
    score: number;
    reason: string;
    action: string;
    tone: string;
    badge: string;
  }>;
}

export interface RealDashboardApi {
  load(signal?: AbortSignal, period?: DashboardHistoryPeriod): Promise<RealDashboardSummary>;
}

export type DashboardHistoryPeriod = "3m" | "month";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DashboardRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${code} (HTTP ${status})`);
    this.name = "DashboardRequestError";
  }
}

function responseError(status: number, body: unknown): DashboardRequestError {
  let code = "dashboard_request_failed";
  if (body && typeof body === "object") {
    const envelope = body as { code?: unknown; message?: unknown };
    code = typeof envelope.code === "string"
      ? envelope.code
      : typeof envelope.message === "string"
        ? envelope.message
        : "dashboard_request_failed";
  }
  return new DashboardRequestError(status, code);
}

export function createRealDashboardApi(
  fetchImpl: FetchLike = fetch
): RealDashboardApi {
  return {
    async load(signal, period = "3m") {
      const response = await fetchImpl(`/api/dashboard/summary?period=${encodeURIComponent(period)}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw responseError(response.status, body);
      return body as RealDashboardSummary;
    }
  };
}
