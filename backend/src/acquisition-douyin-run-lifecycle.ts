import { createHash } from "node:crypto";
import type { AcquisitionCrawlerJob } from "./acquisition-crawler-job.js";
import type {
  AcquisitionPlanRunRepository,
  AcquisitionRun,
  AcquisitionRunStatus
} from "./acquisition-plan-run-repository.js";

type TerminalCrawlerState = "paused" | "failed" | "cancelled";

const preservedRunStatuses = new Set<AcquisitionRunStatus>([
  "paused",
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed",
  "budget_exhausted"
]);

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function projectDouyinCrawlerTerminalRuns(input: {
  repository: AcquisitionPlanRunRepository;
  scope: {
    workspaceId: string;
    ownerId: string;
    teamId: string;
    actorId: string;
  };
  job: Pick<AcquisitionCrawlerJob,
    "id" | "workspaceId" | "runIds" | "planId" | "planVersionId"
    | "planSnapshotHash" | "state" | "lastErrorCode">;
  at: string;
}) {
  if (input.job.workspaceId !== input.scope.workspaceId
    || !["paused", "failed", "cancelled"].includes(input.job.state)) {
    throw new Error("douyin_terminal_projection_job_mismatch");
  }
  const status = input.job.state as TerminalCrawlerState;
  return input.repository.transaction((transaction) => {
    const projected: AcquisitionRun[] = [];
    for (const runId of input.job.runIds) {
      const run = transaction.getRun(runId);
      if (!run || run.ownerId !== input.scope.ownerId
        || run.teamId !== input.scope.teamId
        || run.planId !== input.job.planId
        || run.planVersionId !== input.job.planVersionId
        || run.planSnapshotHash !== input.job.planSnapshotHash) {
        throw new Error("douyin_terminal_projection_run_binding_mismatch");
      }
      if (run.status === status || preservedRunStatuses.has(run.status)) {
        projected.push(run);
        continue;
      }
      const updated: AcquisitionRun = {
        ...run,
        status,
        terminationIntent: status === "cancelled"
          ? "cancelled" : run.terminationIntent,
        revision: run.revision + 1,
        etag: `"${run.id}:${run.revision + 1}"`,
        updatedBy: input.scope.actorId,
        updatedAt: input.at,
        completedAt: status === "paused" ? null : input.at
      };
      transaction.putRun(updated);
      transaction.appendRunEvent({
        id: `are-douyin-terminal-${hash(`${run.id}\u0000${status}`).slice(0, 48)}`,
        runId: run.id,
        shardId: null,
        ownerId: run.ownerId,
        teamId: run.teamId,
        type: `run.${status}`,
        actorId: input.scope.actorId,
        revision: updated.revision,
        at: input.at,
        data: {
          previousStatus: run.status,
          jobId: input.job.id,
          ...(input.job.lastErrorCode
            ? { errorCode: input.job.lastErrorCode }
            : {})
        }
      });
      projected.push(updated);
    }
    return projected;
  });
}
