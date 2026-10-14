import { createAcquisitionApi } from "../acquisition/runtime-api";
import {
  createDouyinAutomationApi,
  isDouyinCommentOutreachCandidate,
  type DouyinRunCandidate
} from "../acquisition/douyin-automation-api";
import {
  buildAcquisitionOverviewModel,
  runStatusLabel,
  type AcquisitionRunStatus,
  type AcquisitionTaskSummary
} from "../acquisition/runtime-model";
import type { components } from "../generated/ai-acquisition";

export interface RealPublicInteraction {
  key: string;
  candidateId: string;
  runId: string;
  taskId: string;
  planId: AcquisitionTaskSummary["planId"];
  taskName: string;
  runStatus: AcquisitionRunStatus;
  runUpdatedAt: string;
  displayName: string;
  candidateStatus: string;
  excerpt: string;
  sourceUrl: string;
  /** Optional public display hints; absence preserves the generic visual fallback. */
  avatarUrl?: string;
  coverUrl?: string;
  outreachEligible: boolean;
}

export interface RealConversationRunFailure {
  runId: string;
  taskName: string;
  reason: string;
}

export interface RealConversationAccount {
  id: string;
  displayName: string | null;
  state: string;
  loginStateVersion: number | null;
}

export interface RealConversationsSnapshot {
  generatedAt: string;
  runsRead: number;
  accounts: RealConversationAccount[];
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
  task: AcquisitionTaskSummary,
  run: Pick<components["schemas"]["AcquisitionRun"], "id" | "status" | "updatedAt">,
  candidate: DouyinRunCandidate
): RealPublicInteraction {
  return {
    key: `${run.id}:${candidate.id}`,
    candidateId: candidate.id,
    runId: run.id,
    taskId: task.id,
    planId: task.planId,
    taskName: task.name,
    runStatus: run.status,
    runUpdatedAt: run.updatedAt,
    displayName: candidate.displayName,
    candidateStatus: candidate.status,
    excerpt: candidate.evidence.excerpt,
    sourceUrl: candidate.evidence.sourceUrl,
    ...(candidate.avatarUrl ? { avatarUrl: candidate.avatarUrl } : {}),
    ...(candidate.coverUrl ? { coverUrl: candidate.coverUrl } : {}),
    outreachEligible: isDouyinCommentOutreachCandidate(candidate)
  };
}
export function createRealConversationsApi(
  fetchImpl: typeof fetch = fetch
): RealConversationsApi {
  const acquisitionApi = createAcquisitionApi(fetchImpl);
  const douyinApi = createDouyinAutomationApi(fetchImpl);

  async function readResultRun(task: AcquisitionTaskSummary, runId: string, signal?: AbortSignal) {
    if (task.latestRun?.id === runId) return task.latestRun;
    const response = await fetchImpl(`/api/v1/acquisition/runs/${encodeURIComponent(runId)}`, {
      method: "GET", credentials: "same-origin", headers: { accept: "application/json" }, signal
    });
    if (!response.ok) throw new Error(`历史采集运行读取失败（HTTP ${response.status}）`);
    const run = await response.json() as components["schemas"]["AcquisitionRun"];
    if (!run || run.id !== runId || run.planId !== task.planId
      || typeof run.status !== "string" || typeof runStatusLabel(run.status) !== "string"
      || typeof run.updatedAt !== "string" || !Number.isFinite(Date.parse(run.updatedAt))) {
      throw new Error("历史采集运行与当前任务不一致");
    }
    return run;
  }

  async function readCandidatePages(runId: string, signal?: AbortSignal) {
    const candidates = new Map<string, DouyinRunCandidate>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    // Page until exhaustion; cancellation and cursor-cycle detection remain.
    while (!signal?.aborted) {
      signal?.throwIfAborted();
      const page = await douyinApi.listRunCandidates(runId, signal, cursor ? { cursor } : undefined);
      page.items.forEach((candidate) => candidates.set(candidate.id, candidate));
      if (page.nextCursor === null) return { items: [...candidates.values()], truncated: false };
      if (seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { items: [...candidates.values()], truncated: true };
  }

  return {
    async load(signal) {
      const [overview, accountPage] = await Promise.all([
        acquisitionApi.getOverview(signal),
        douyinApi.listAccounts(signal)
      ]);
      const candidateRuns = new Map(buildAcquisitionOverviewModel(overview).tasks
        .map((task) => [task.id, task.candidateRunId]));
      const tasks = overview.tasks.flatMap((task) => {
        const runId = candidateRuns.get(task.id);
        return task.platform === "douyin" && runId ? [{ task, runId }] : [];
      });
      const results = await Promise.allSettled(tasks.map(async ({ task, runId }) => {
        const run = await readResultRun(task, runId, signal);
        const page = await readCandidatePages(runId, signal);
        return { run, page };
      }));

      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }

      const interactions: RealPublicInteraction[] = [];
      const failedRuns: RealConversationRunFailure[] = [];
      const truncatedRunIds: string[] = [];
      let runsRead = 0;

      results.forEach((result, index) => {
        const source = tasks[index];
        if (!source) return;
        const { task, runId } = source;
        if (result.status === "rejected") {
          failedRuns.push({
            runId,
            taskName: task.name,
            reason: errorText(result.reason)
          });
          return;
        }
        runsRead += 1;
        result.value.page.items.forEach((candidate) => {
          interactions.push(interaction(task, result.value.run, candidate));
        });
        if (result.value.page.truncated) {
          truncatedRunIds.push(runId);
        }
      });

      return {
        generatedAt: overview.generatedAt,
        runsRead,
        accounts: accountPage.items.map((account) => ({
          id: account.id,
          displayName: account.displayName,
          state: account.state,
          loginStateVersion: account.loginStateVersion
        })),
        interactions,
        failedRuns,
        truncatedRunIds,
        receiptAccess: "known_batch_id_only"
      };
    }
  };
}
