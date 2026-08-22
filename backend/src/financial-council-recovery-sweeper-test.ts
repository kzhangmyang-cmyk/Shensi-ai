import assert from "node:assert/strict";
import test from "node:test";
import { FinancialCouncilRecoverySweeper } from
  "./financial-council-recovery-sweeper.js";

test("recovery sweeper dispatches stalled work once and stop drains in-flight wake", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const wakes: string[] = [];
  const sweeper = new FinancialCouncilRecoverySweeper({
    repository: {
      async listRecoverableAnalysisRuns() {
        return [{ runId: "run-1", workspaceId: "ws-1" }];
      }
    },
    worker: { async wake(run) { wakes.push(run.runId); await blocked; } },
    now: () => "2026-08-16T08:00:00.000Z", intervalMs: 60_000,
    batchSize: 10, onError() {}
  } as never);
  const first = sweeper.sweepOnce();
  const duplicate = sweeper.sweepOnce();
  assert.equal(first, duplicate);
  const stopping = sweeper.stop();
  release();
  await stopping;
  assert.deepEqual(wakes, ["run-1"]);
  await sweeper.close();
});
