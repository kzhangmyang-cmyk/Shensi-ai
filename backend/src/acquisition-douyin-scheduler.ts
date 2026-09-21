import { douyinAutomationHash, localDateInTimeZone } from "./acquisition-douyin-automation.js";
import type { DouyinAutomationRunIntent } from "./acquisition-douyin-automation.js";
import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import type { AcquisitionCrawlerLimits } from "./acquisition-crawler-job.js";

export interface ScheduledDouyinPolicy {
  workspaceId: string; planId: string; planVersionId: string; planVersion: number;
  planSnapshotHash: string; policyVersionId: string; policyHash: string;
  accountId: string; accountLoginStateVersion: number; createdBy: string;
  keywords: string[]; dailyCandidateLimit: number;
  collectCreators: boolean; collectDemandComments: boolean;
  schedule: { enabled: boolean; localTime: string; timeZone: string };
  limits: AcquisitionCrawlerLimits;
}

function localTime(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(instant));
  const value = (kind: "hour" | "minute") => parts.find((part) => part.type === kind)?.value;
  return `${value("hour")}:${value("minute")}`;
}

export class AcquisitionDouyinScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly options: {
    repository: AcquisitionCrawlerJobRepository;
    policies: { listScheduled(): Promise<ScheduledDouyinPolicy[]> };
    runIntents?: {
      create(
        policy: ScheduledDouyinPolicy,
        run: DouyinAutomationRunIntent
      ): Promise<DouyinAutomationRunIntent>;
    };
    idFactory?: (prefix: string) => string;
    now?: () => string;
  }) {}

  async tick() {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    const idFactory = this.options.idFactory ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);
    let created = 0;
    for (const policy of await this.options.policies.listScheduled()) {
      if (!policy.schedule.enabled || localTime(now, policy.schedule.timeZone) !== policy.schedule.localTime) continue;
      const localDate = localDateInTimeZone(now, policy.schedule.timeZone);
      const dailyBudgetId = douyinAutomationHash({
        workspaceId: policy.workspaceId, planId: policy.planId,
        policyVersionId: policy.policyVersionId, localDate
      });
      const proposedRun: DouyinAutomationRunIntent = {
        id: idFactory("douyin-run"),
        acquisitionRunId: idFactory("ar"), workspaceId: policy.workspaceId,
        planId: policy.planId, planVersionId: policy.planVersionId,
        planVersion: policy.planVersion,
        planSnapshotHash: policy.planSnapshotHash,
        policyVersionId: policy.policyVersionId, policyHash: policy.policyHash,
        accountId: policy.accountId,
        accountLoginStateVersion: policy.accountLoginStateVersion,
        dailyBudgetId, localDate, trigger: "scheduled",
        collectCreators: policy.collectCreators,
        collectDemandComments: policy.collectDemandComments,
        status: "queued",
        reason: null, createdBy: policy.createdBy, createdAt: now
      };
      const run = this.options.runIntents
        ? await this.options.runIntents.create(policy, proposedRun)
        : proposedRun;
      const result = await this.options.repository.createOrGet({
        id: idFactory("crawler-job"), workspaceId: policy.workspaceId,
        runId: run.acquisitionRunId, automationIntentId: run.id,
        planId: policy.planId, planVersionId: run.planVersionId,
        planSnapshotHash: run.planSnapshotHash,
        policyVersionId: policy.policyVersionId, policyHash: policy.policyHash,
        accountId: policy.accountId, accountLoginStateVersion: policy.accountLoginStateVersion,
        dailyBudgetId: run.dailyBudgetId, localDate: run.localDate,
        trigger: run.trigger,
        dailyCandidateLimit: policy.dailyCandidateLimit, keywords: policy.keywords,
        collectCreators: run.collectCreators,
        collectDemandComments: run.collectDemandComments,
        limits: policy.limits, createdAt: run.createdAt
      });
      await this.options.repository.enqueue(policy.workspaceId, run.acquisitionRunId, now);
      if (result.created) created += 1;
    }
    return created;
  }
  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    void this.tick();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
