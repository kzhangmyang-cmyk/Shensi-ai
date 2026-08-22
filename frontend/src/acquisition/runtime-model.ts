export type AcquisitionPlatform = "douyin" | "web";

export type AcquisitionDiscoveryMethod =
  | "public_search"
  | "user_import"
  | "official_authorized";

export type AcquisitionRunStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "succeeded_empty"
  | "partial_success"
  | "failed"
  | "budget_exhausted";

export interface AcquisitionTaskLatestRun {
  id: string;
  status: AcquisitionRunStatus;
  updatedAt: string;
  completedAt: string | null;
  evidenceCount: number;
  consumedBudget: {
    requests: number;
    results: number;
    amountMinor?: number;
    durationSeconds: number;
  };
}

export interface AcquisitionTaskSummary {
  id: string;
  planId: string;
  name: string;
  objective: string;
  platform: AcquisitionPlatform;
  discoveryMethods: AcquisitionDiscoveryMethod[];
  planStatus: "draft" | "approved" | "archived";
  latestRun: AcquisitionTaskLatestRun | null;
  updatedAt: string;
}

export interface AcquisitionTaskOverview {
  generatedAt: string;
  platform: AcquisitionPlatform;
  totals: { tasks: number };
  statusCounts: Partial<Record<AcquisitionRunStatus | "not_started", number>>;
  discoveryMethodCounts: Partial<Record<AcquisitionDiscoveryMethod, number>>;
  tasks: AcquisitionTaskSummary[];
}

export interface AcquisitionMetricModel {
  label: string;
  value: number;
  unit: "项";
  tone: "normal" | "active" | "success" | "danger";
}

export interface AcquisitionTaskRowModel {
  id: string;
  planId: string;
  name: string;
  objective: string;
  platformLabel: string;
  status: AcquisitionRunStatus | null;
  statusLabel: string;
  statusTone: "normal" | "active" | "success" | "danger";
  evidenceCount: number;
  requests: number;
  results: number;
  durationSeconds: number;
  updatedAt: string;
  tags: string[];
}

export interface AcquisitionOverviewModel {
  generatedAt: string;
  metrics: AcquisitionMetricModel[];
  tasks: AcquisitionTaskRowModel[];
}

const RUN_STATUS_LABELS: Record<AcquisitionRunStatus, string> = {
  queued: "排队中",
  running: "正在运行",
  pause_requested: "正在暂停",
  paused: "已暂停",
  cancel_requested: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  succeeded_empty: "已完成 · 无结果",
  partial_success: "部分完成",
  failed: "运行失败",
  budget_exhausted: "预算已用完"
};

const DISCOVERY_METHOD_LABELS: Record<AcquisitionDiscoveryMethod, string> = {
  public_search: "公开搜索",
  user_import: "用户导入",
  official_authorized: "官方授权"
};

const RUNNING_STATUSES = new Set<AcquisitionRunStatus>([
  "queued",
  "running",
  "pause_requested",
  "cancel_requested"
]);

const COMPLETED_STATUSES = new Set<AcquisitionRunStatus>([
  "succeeded",
  "succeeded_empty",
  "partial_success"
]);

const ATTENTION_STATUSES = new Set<AcquisitionRunStatus>([
  "paused",
  "cancelled",
  "failed",
  "budget_exhausted"
]);

function sumStatuses(
  counts: AcquisitionTaskOverview["statusCounts"],
  statuses: ReadonlySet<AcquisitionRunStatus>
): number {
  let total = 0;
  statuses.forEach((status) => {
    total += counts[status] ?? 0;
  });
  return total;
}

function statusTone(
  status: AcquisitionRunStatus | null
): AcquisitionTaskRowModel["statusTone"] {
  if (status === null) return "normal";
  if (RUNNING_STATUSES.has(status)) return "active";
  if (COMPLETED_STATUSES.has(status)) return "success";
  return "danger";
}

export function runStatusLabel(status: AcquisitionRunStatus | null): string {
  return status === null ? "尚未开始" : RUN_STATUS_LABELS[status];
}

export function buildAcquisitionOverviewModel(
  overview: AcquisitionTaskOverview
): AcquisitionOverviewModel {
  const running = sumStatuses(overview.statusCounts, RUNNING_STATUSES);
  const completed = sumStatuses(overview.statusCounts, COMPLETED_STATUSES);
  const attention = sumStatuses(overview.statusCounts, ATTENTION_STATUSES);

  return {
    generatedAt: overview.generatedAt,
    metrics: [
      {
        label: "真实任务",
        value: overview.totals.tasks,
        unit: "项",
        tone: "normal"
      },
      { label: "运行中", value: running, unit: "项", tone: "active" },
      { label: "已完成", value: completed, unit: "项", tone: "success" },
      { label: "需关注", value: attention, unit: "项", tone: "danger" }
    ],
    tasks: overview.tasks.map((task) => {
      const latestRun = task.latestRun;
      return {
        id: task.id,
        planId: task.planId,
        name: task.name,
        objective: task.objective,
        platformLabel: task.platform === "douyin" ? "抖音" : "全网公开网页",
        status: latestRun?.status ?? null,
        statusLabel: runStatusLabel(latestRun?.status ?? null),
        statusTone: statusTone(latestRun?.status ?? null),
        evidenceCount: latestRun?.evidenceCount ?? 0,
        requests: latestRun?.consumedBudget.requests ?? 0,
        results: latestRun?.consumedBudget.results ?? 0,
        durationSeconds: latestRun?.consumedBudget.durationSeconds ?? 0,
        updatedAt: latestRun?.updatedAt ?? task.updatedAt,
        tags: task.discoveryMethods.map((method) => DISCOVERY_METHOD_LABELS[method])
      };
    })
  };
}
