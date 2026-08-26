import { createAcquisitionApi } from "../acquisition/runtime-api";
import {
  createDouyinAutomationApi,
  type DouyinRunCandidate
} from "../acquisition/douyin-automation-api";
import type { AcquisitionRunStatus } from "../acquisition/runtime-model";

export interface RealPublicInteraction {
  key: string;
  candidateId: string;
  runId: string;
  taskId: string;
  taskName: string;
  runStatus: AcquisitionRunStatus;
  runUpdatedAt: string;
  displayName: string;
  candidateStatus: string;
  excerpt: string;
  sourceUrl: string;
}

export interface RealConversationRunFailure {
  runId: string;
  taskName: string;
  reason: string;
}

export interface RealConversationsSnapshot {
  generatedAt: string;
  runsRead: number;
  interactions: RealPublicInteraction[];
  failedRuns: RealConversationRunFailure[];
  truncatedRunIds: string[];
  receiptAccess: "known_batch_id_only";
}

export interface RealConversationsApi {
  load(signal?: AbortSignal): Promise<RealConversationsSnapshot>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "候选证据读取失败";
}

function interaction(
  task: {
    id: string;
    name: string;
    latestRun: NonNullable<Awaited<ReturnType<ReturnType<typeof createAcquisitionApi>["getOverview"]>>["tasks"][number]["latestRun"]>;
  },
  candidate: DouyinRunCandidate
): RealPublicInteraction {
  return {
    key: `${task.latestRun.id}:${candidate.id}`,
    candidateId: candidate.id,
    runId: task.latestRun.id,
    taskId: task.id,
    taskName: task.name,
    runStatus: task.latestRun.status,
    runUpdatedAt: task.latestRun.updatedAt,
    displayName: candidate.displayName,
    candidateStatus: candidate.status,
    excerpt: candidate.evidence.excerpt,
    sourceUrl: candidate.evidence.sourceUrl
  };
}
export function createRealConversationsApi(
  fetchImpl: typeof fetch = fetch
): RealConversationsApi {
  const acquisitionApi = createAcquisitionApi(fetchImpl);
  const douyinApi = createDouyinAutomationApi(fetchImpl);

  return {
    async load(signal) {
      const overview = await acquisitionApi.getOverview(signal);
      const tasks = overview.tasks.filter((task) =>
        task.platform === "douyin" && task.latestRun !== null
      ) as Array<typeof overview.tasks[number] & {
        latestRun: NonNullable<typeof overview.tasks[number]["latestRun"]>;
      }>;
      const results = await Promise.allSettled(tasks.map(async (task) => ({
        task,
        page: await douyinApi.listRunCandidates(task.latestRun.id, signal)
      })));

      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }

      const interactions: RealPublicInteraction[] = [];
      const failedRuns: RealConversationRunFailure[] = [];
      const truncatedRunIds: string[] = [];
      let runsRead = 0;

      results.forEach((result, index) => {
        const task = tasks[index];
        if (!task) return;
        if (result.status === "rejected") {
          failedRuns.push({
            runId: task.latestRun.id,
            taskName: task.name,
            reason: errorText(result.reason)
          });
          return;
        }
        runsRead += 1;
        result.value.page.items.forEach((candidate) => {
          interactions.push(interaction(task, candidate));
        });
        if (result.value.page.nextCursor !== null) {
          truncatedRunIds.push(task.latestRun.id);
        }
      });

      return {
        generatedAt: overview.generatedAt,
        runsRead,
        interactions,
        failedRuns,
        truncatedRunIds,
        receiptAccess: "known_batch_id_only"
      };
    }
  };
}
