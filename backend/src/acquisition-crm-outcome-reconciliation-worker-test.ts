import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionCrmOutcomeReconciliationWorker
} from "./acquisition-crm-outcome-reconciliation-worker.js";

test("worker invokes bounded reconciliation independently for each durable tenant scope", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const worker = new AcquisitionCrmOutcomeReconciliationWorker({
    service: {
      async runTenant(scope, options) {
        calls.push({ ...scope, ...options });
        return {
          scanned: 0,
          reconciled: 0,
          skipped: 0,
          failed: 0,
          lastReconciledAt: "2026-08-08T00:00:00.000Z"
        };
      }
    },
    listTenantScopes: () => [{
      ownerId: "owner-a",
      teamId: "team-a"
    }, {
      ownerId: "owner-b",
      teamId: "team-b"
    }],
    batchSize: 37,
    intervalMs: 60_000,
    setTimer: () => ({ unref() {} }),
    clearTimer() {}
  });

  await worker.start();
  await worker.close();

  assert.deepEqual(calls, [{
    ownerId: "owner-a",
    teamId: "team-a",
    limit: 37
  }, {
    ownerId: "owner-b",
    teamId: "team-b",
    limit: 37
  }]);
});
