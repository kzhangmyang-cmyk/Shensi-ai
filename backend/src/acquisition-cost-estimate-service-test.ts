import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionCostEstimateService } from "./acquisition-cost-estimate-service.js";
import { foundationServicesFixture, ledgerCommandContext } from "./growth-finance-test-fixtures.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";

const snapshot = (digit: string) => `sha256:${digit.repeat(64)}`;

test("draft activation appends immutable versions and exactly one active head", async () => {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T00:00:00.000Z"
  );
  const foundation = foundationServicesFixture({ temporalTransactions: repository });
  const service = new AcquisitionCostEstimateService({ repository, foundation });
  const first = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-draft-v1"),
    {
      cohortId: null, planId: "plan-1", runId: null,
      amountMinor: 100, currency: "CNY", source: "plan_budget",
      sourceStableKey: "plan:1", inputSnapshotHash: snapshot("1"),
      validFrom: "2026-08-09T00:00:00.000Z", validTo: null
    }
  );
  const firstActive = await service.activate(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-activate-v1", 1),
    { estimateId: first.id, effectiveAt: "2026-08-09T00:00:00.000Z" }
  );
  const second = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-draft-v2"),
    {
      cohortId: null, planId: "plan-1", runId: null,
      amountMinor: 125, currency: "CNY", source: "plan_budget",
      sourceStableKey: "plan:1", inputSnapshotHash: snapshot("2"),
      validFrom: "2026-08-10T00:00:00.000Z", validTo: null
    }
  );
  const secondActive = await service.activate(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-activate-v2", 1),
    { estimateId: second.id, effectiveAt: "2026-08-10T00:00:00.000Z" }
  );
  const third = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-draft-v3"),
    {
      cohortId: null, planId: "plan-1", runId: null,
      amountMinor: 150, currency: "CNY", source: "plan_budget",
      sourceStableKey: "plan:1", inputSnapshotHash: snapshot("7"),
      validFrom: "2026-08-11T00:00:00.000Z", validTo: null
    }
  );
  await service.activate(
    ledgerCommandContext("workspace-a", "finance-a", "estimate-activate-v3", 1),
    { estimateId: third.id, effectiveAt: "2026-08-11T00:00:00.000Z" }
  );

  assert.equal(first.status, "draft");
  assert.equal(firstActive.status, "active");
  assert.equal(second.version, 2);
  assert.equal(secondActive.status, "active");
  assert.equal(secondActive.amountMinor, 125);
  assert.equal(third.version, 3);
  const events = await repository.listCostEstimateLifecycleEvents(
    "workspace-a", "CNY", "plan:1", "9999-12-31T23:59:59.999Z"
  );
  assert.deepEqual(events.map((event) => [
    event.eventType, event.estimateId, event.eventSequence, event.revision
  ]), [
    ["activated", first.id, 1, 1],
    ["superseded", first.id, 2, 2],
    ["activated", second.id, 3, 3],
    ["superseded", second.id, 4, 4],
    ["activated", third.id, 5, 5]
  ]);
  assert.ok(events[1]!.recordedAt < events[2]!.recordedAt);
  assert.ok(events[1]!.temporalSequence < events[2]!.temporalSequence);
});

test("two concurrent activations of one draft admit one lifecycle decision", async () => {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T00:00:00.000Z"
  );
  const foundation = foundationServicesFixture({ temporalTransactions: repository });
  const service = new AcquisitionCostEstimateService({ repository, foundation });
  const draft = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "concurrent-draft"), {
      cohortId: null, planId: null, runId: null, amountMinor: 100,
      currency: "CNY", source: "manual_estimate",
      sourceStableKey: "manual:shared-1", inputSnapshotHash: snapshot("3"),
      validFrom: "2026-08-09T00:00:00.000Z", validTo: null
    }
  );

  const attempts = await Promise.allSettled(["a", "b"].map((suffix) =>
    service.activate(ledgerCommandContext(
      "workspace-a", `finance-${suffix}`, `activate-${suffix}`, 1
    ), { estimateId: draft.id, effectiveAt: "2026-08-09T00:00:00.000Z" })));

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const events = await repository.listCostEstimateLifecycleEvents(
    "workspace-a", "CNY", "manual:shared-1", "9999-12-31T23:59:59.999Z"
  );
  assert.deepEqual(events.map((event) => event.eventType), ["activated"]);
});

test("idempotent replay rechecks current capability before projecting a draft", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const foundation = foundationServicesFixture({ temporalTransactions: repository });
  const service = new AcquisitionCostEstimateService({ repository, foundation });
  const input = {
    cohortId: null, planId: null, runId: null, amountMinor: 100,
    currency: "CNY", source: "manual_estimate" as const,
    sourceStableKey: "manual:auth", inputSnapshotHash: snapshot("4"),
    validFrom: "2026-08-09T00:00:00.000Z", validTo: null
  };
  const authorized = ledgerCommandContext(
    "workspace-a", "finance-a", "estimate-current-auth"
  );
  await service.createDraft(authorized, input);
  const unauthorized = Object.freeze({
    ...authorized,
    workspace: Object.freeze({ ...authorized.workspace, capabilities: Object.freeze([]) })
  });

  await assert.rejects(service.createDraft(unauthorized, input),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden");
});
