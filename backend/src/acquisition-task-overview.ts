import type {
  AcquisitionBudgetUsage,
  AcquisitionPlan,
  AcquisitionPlanRunRepository,
  AcquisitionPlanStatus,
  AcquisitionRun,
  AcquisitionRunStatus,
  AcquisitionTargetPlatform
} from "./acquisition-plan-run-repository.js";
import type { AcquisitionScope } from "./acquisition-plan-run-service.js";

export type AcquisitionTaskPlatform = AcquisitionTargetPlatform;
export type AcquisitionDiscoveryMethod =
  | "public_search"
  | "user_import"
  | "official_authorized";
export type AcquisitionTaskStatus = AcquisitionRunStatus | "not_started";

export interface AcquisitionTaskLatestRun {
  id: string;
  status: AcquisitionRunStatus;
  updatedAt: string;
  completedAt: string | null;
  evidenceCount: number;
  consumedBudget: Omit<AcquisitionBudgetUsage, "amountMinor"> & {
    amountMinor?: number;
  };
}

export interface AcquisitionTaskSummary {
  id: string;
  planId: string;
  name: string;
  objective: string;
  platform: AcquisitionTaskPlatform;
  discoveryMethods: AcquisitionDiscoveryMethod[];
  planStatus: AcquisitionPlanStatus;
  latestRun: AcquisitionTaskLatestRun | null;
  updatedAt: string;
}

export interface AcquisitionTaskOverview {
  generatedAt: string;
  platform: AcquisitionTaskPlatform;
  totals: { tasks: number };
  statusCounts: Partial<Record<AcquisitionTaskStatus, number>>;
  discoveryMethodCounts: Partial<Record<AcquisitionDiscoveryMethod, number>>;
  tasks: AcquisitionTaskSummary[];
}

export interface AcquisitionTaskListQuery {
  platform?: AcquisitionTaskPlatform;
  planStatus?: AcquisitionPlanStatus;
}

function platformFor(plan: AcquisitionPlan): AcquisitionTaskPlatform {
  if (plan.payload.targetPlatform) return plan.payload.targetPlatform;
  const references = plan.payload.operations.flatMap((operation) => [
    operation.query ?? "",
    operation.sourceRef ?? ""
  ]);
  return references.some((reference) =>
    /(?:^|[^a-z0-9-])(?:www\.)?(?:ies)?douyin\.com\b/i.test(reference)
  )
    ? "douyin"
    : "web";
}

function discoveryMethodsFor(
  plan: AcquisitionPlan
): AcquisitionDiscoveryMethod[] {
  const methods = new Set<AcquisitionDiscoveryMethod>();
  for (const operation of plan.payload.operations) {
    if (operation.kind === "import_rows") {
      methods.add("user_import");
    } else {
      methods.add("public_search");
    }
  }
  return [...methods];
}

function latestRunFor(plan: AcquisitionPlan, runs: AcquisitionRun[]) {
  return runs
    .filter((run) => run.planId === plan.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id))[0] ?? null;
}

function summaryFor(plan: AcquisitionPlan, runs: AcquisitionRun[]) {
  const latestRun = latestRunFor(plan, runs);
  const consumedBudget = latestRun
    ? (() => {
        const { amountMinor, ...usage } = structuredClone(latestRun.consumedBudget);
        return amountMinor > 0 ? { ...usage, amountMinor } : usage;
      })()
    : null;
  return {
    id: plan.id,
    planId: plan.id,
    name: plan.payload.name,
    objective: plan.payload.objective,
    platform: platformFor(plan),
    discoveryMethods: discoveryMethodsFor(plan),
    planStatus: plan.status,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          updatedAt: latestRun.updatedAt,
          completedAt: latestRun.completedAt,
          evidenceCount: latestRun.evidenceCount,
          consumedBudget: consumedBudget!
        }
      : null,
    updatedAt: latestRun && latestRun.updatedAt > plan.updatedAt
      ? latestRun.updatedAt
      : plan.updatedAt
  } satisfies AcquisitionTaskSummary;
}

export class AcquisitionTaskOverviewService {
  private readonly repository: AcquisitionPlanRunRepository;
  private readonly now: () => string;

  constructor(options: {
    repository: AcquisitionPlanRunRepository;
    now?: () => string;
  }) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getOverview(
    scope: AcquisitionScope,
    platform: AcquisitionTaskPlatform
  ): Promise<AcquisitionTaskOverview> {
    const tasks = await this.listTasks(scope, { platform });
    const recentTasks = tasks.slice(0, 20);
    const statusCounts: AcquisitionTaskOverview["statusCounts"] = {};
    const discoveryMethodCounts:
      AcquisitionTaskOverview["discoveryMethodCounts"] = {};
    for (const task of tasks) {
      const status = task.latestRun?.status ?? "not_started";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      for (const method of task.discoveryMethods) {
        discoveryMethodCounts[method] = (discoveryMethodCounts[method] ?? 0) + 1;
      }
    }
    return structuredClone({
      generatedAt: this.now(),
      platform,
      totals: { tasks: tasks.length },
      statusCounts,
      discoveryMethodCounts,
      tasks: recentTasks
    });
  }

  async listTasks(
    scope: AcquisitionScope,
    query: AcquisitionTaskListQuery = {}
  ): Promise<AcquisitionTaskSummary[]> {
    const [plans, runs] = await Promise.all([
      this.repository.listPlans(scope),
      this.repository.listRuns(scope)
    ]);
    return structuredClone(plans.map((plan) =>
      summaryFor(structuredClone(plan), structuredClone(runs))
    ).filter((task) =>
      (!query.platform || task.platform === query.platform)
      && (!query.planStatus || task.planStatus === query.planStatus)
    ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || right.id.localeCompare(left.id)));
  }

  async getTask(
    scope: AcquisitionScope,
    planId: string
  ): Promise<AcquisitionTaskSummary | null> {
    const tasks = await this.listTasks(scope);
    return structuredClone(tasks.find((task) => task.planId === planId) ?? null);
  }
}
