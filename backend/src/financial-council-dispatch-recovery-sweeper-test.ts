import assert from "node:assert/strict";
import test from "node:test";
import { FinancialCouncilDispatchRecoverySweeper } from "./financial-council-dispatch-recovery-sweeper.js";

test("dispatch sweeper is single-flight and close drains the active wake", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const wakes: string[] = [];
  const sweeper = new FinancialCouncilDispatchRecoverySweeper({
    repository: { async listRecoverableDispatches() { return [{ workspaceId: "ws-1", dispatchId: "dispatch-1" }]; } },
    worker: { async wake(row) { wakes.push(row.dispatchId); await blocked; }, async close() {} },
    now: () => "2026-08-16T08:00:00.000Z", intervalMs: 60_000, batchSize: 1,
    onError() {}
  });
  const first = sweeper.sweepOnce();
  assert.equal(first, sweeper.sweepOnce());
  const closing = sweeper.close();
  release();
  await closing;
  assert.deepEqual(wakes, ["dispatch-1"]);
});
