import assert from "node:assert/strict";
import test from "node:test";
import { activeCostEstimateIdAsOf } from "./acquisition-cost-estimate-as-of-reader.js";
import {
  AcquisitionCostEstimateAsOfBoundary,
  RepositoryAcquisitionCostEstimateSealedReader
} from "./acquisition-cost-estimate-as-of-reader.js";
import { foundationServicesFixture } from "./growth-finance-test-fixtures.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import { AcquisitionCostEstimateService } from "./acquisition-cost-estimate-service.js";
import { ledgerCommandContext } from "./growth-finance-test-fixtures.js";
import type { AcquisitionCostEstimateLifecycleEvent } from "./financial-ledger-domain.js";

test("successive recorded ticks preserve the cutoff between supersede and activate", () => {
  const events: AcquisitionCostEstimateLifecycleEvent[] = [
    {
      id: "event-1", workspaceId: "workspace-a", currency: "CNY",
      sourceStableKey: "plan:1", estimateId: "estimate-v1",
      eventType: "activated", eventSequence: 1, revision: 1,
      effectiveAt: "2026-08-01T00:00:00.000Z", supersedesEstimateId: null,
      actorId: "finance-a", recordedAt: "2026-08-01T00:00:00.000Z",
      temporalSequence: 1
    },
    {
      id: "event-z", workspaceId: "workspace-a", currency: "CNY",
      sourceStableKey: "plan:1", estimateId: "estimate-v1",
      eventType: "superseded", eventSequence: 2, revision: 2,
      effectiveAt: "2026-08-09T00:00:00.000Z", supersedesEstimateId: null,
      actorId: "finance-a", recordedAt: "2026-08-09T00:00:00.000Z",
      temporalSequence: 2
    },
    {
      id: "event-a", workspaceId: "workspace-a", currency: "CNY",
      sourceStableKey: "plan:1", estimateId: "estimate-v2",
      eventType: "activated", eventSequence: 3, revision: 3,
      effectiveAt: "2026-08-09T00:00:00.000Z",
      supersedesEstimateId: "estimate-v1", actorId: "finance-a",
      recordedAt: "2026-08-09T00:00:00.001Z", temporalSequence: 3
    }
  ];

  assert.equal(activeCostEstimateIdAsOf(
    events, "2026-08-08T23:59:59.999Z"
  ), "estimate-v1");
  assert.equal(activeCostEstimateIdAsOf(
    events, "2026-08-09T00:00:00.000Z"
  ), null);
  assert.equal(activeCostEstimateIdAsOf(
    events, "2026-08-09T00:00:00.001Z"
  ), "estimate-v2");
});

const workspace = (capabilities: ActiveWorkspaceContext["capabilities"] = Object.freeze([
  "ledger.pending.create"
])): ActiveWorkspaceContext => Object.freeze({
  workspaceId: "workspace-a", kind: "team", actorId: "finance-a",
  role: "admin", teamId: "workspace-a", capabilities,
  capabilityRegistryVersion: "growth-capabilities.v1"
});

test("public as-of boundary authorizes before sealing and forwards the exact token once", async () => {
  const runner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T03:00:00.000Z"
  );
  let seals = 0;
  class CountingBarrier extends DefaultGrowthTemporalBarrier {
    override async sealReadCutoff(context: ActiveWorkspaceContext, asOf: string) {
      seals += 1;
      return super.sealReadCutoff(context, asOf);
    }
  }
  const barrier = new CountingBarrier(runner);
  const foundation = foundationServicesFixture({
    temporalTransactions: runner, temporalBarrier: barrier
  });
  let received: GrowthSealedReadCutoff | null = null;
  const boundary = new AcquisitionCostEstimateAsOfBoundary({
    foundation,
    sealedReader: {
      async getActiveAt(cutoff) { received = cutoff; return null; }
    },
    now: () => "2026-08-09T03:00:00.000Z"
  });

  await assert.rejects(boundary.getActiveAsOf(workspace(Object.freeze([])), {
    currency: "CNY", sourceStableKey: "plan:1",
    asOf: "2026-08-09T02:00:00.000Z"
  }), (error: unknown) => (error as { code?: string }).code === "capability_forbidden");
  assert.equal(seals, 0);
  await boundary.getActiveAsOf(workspace(), {
    currency: "CNY", sourceStableKey: "plan:1",
    asOf: "2026-08-09T02:00:00.000Z"
  });
  assert.equal(seals, 1);
  assert.equal(received?.effectiveAsOf, "2026-08-09T02:00:00.000Z");
});

test("sealed estimate reader is token-only and rejects a forged cutoff before repository reads", async () => {
  let reads = 0;
  const repository = new InMemoryFinancialLedgerRepository();
  const original = repository.listCostEstimateLifecycleEvents.bind(repository);
  repository.listCostEstimateLifecycleEvents = async (...args) => {
    reads += 1;
    return original(...args);
  };
  const reader = new RepositoryAcquisitionCostEstimateSealedReader(repository);

  await assert.rejects(reader.getActiveAt(Object.freeze({
    workspaceId: "workspace-a", effectiveAsOf: "2026-08-09T00:00:00.000Z",
    temporalSequence: 1
  }) as GrowthSealedReadCutoff, {
    currency: "CNY", sourceStableKey: "plan:1"
  }), /invalid_growth_sealed_read_cutoff/u);
  assert.equal(reads, 0);
});

test("a sealed old cutoff remains stable after a newer estimate version activates", async () => {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-01T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(repository);
  const foundation = foundationServicesFixture({
    temporalTransactions: repository, temporalBarrier: barrier
  });
  const service = new AcquisitionCostEstimateService({ repository, foundation });
  const reader = new RepositoryAcquisitionCostEstimateSealedReader(repository);
  const draft1 = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "cutoff-draft-1"), {
      cohortId: null, planId: "plan-1", runId: null, amountMinor: 100,
      currency: "CNY", source: "plan_budget", sourceStableKey: "plan:cutoff",
      inputSnapshotHash: `sha256:${"5".repeat(64)}`,
      validFrom: "2026-08-01T00:00:00.000Z", validTo: null
    }
  );
  await service.activate(ledgerCommandContext(
    "workspace-a", "finance-a", "cutoff-activate-1", 1
  ), { estimateId: draft1.id, effectiveAt: "2026-08-01T00:00:00.000Z" });
  repository.setDatabaseNow("2026-08-08T00:00:00.000Z");
  const oldCutoff = await barrier.sealReadCutoff(
    workspace(), "2026-08-08T00:00:00.000Z"
  );
  repository.setDatabaseNow("2026-08-09T00:00:00.000Z");
  const draft2 = await service.createDraft(
    ledgerCommandContext("workspace-a", "finance-a", "cutoff-draft-2"), {
      cohortId: null, planId: "plan-1", runId: null, amountMinor: 125,
      currency: "CNY", source: "plan_budget", sourceStableKey: "plan:cutoff",
      inputSnapshotHash: `sha256:${"6".repeat(64)}`,
      validFrom: "2026-08-09T00:00:00.000Z", validTo: null
    }
  );
  await service.activate(ledgerCommandContext(
    "workspace-a", "finance-a", "cutoff-activate-2", 1
  ), { estimateId: draft2.id, effectiveAt: "2026-08-09T00:00:00.000Z" });

  assert.equal((await reader.getActiveAt(oldCutoff, {
    currency: "CNY", sourceStableKey: "plan:cutoff"
  }))?.id, draft1.id);
  assert.equal((await reader.getActiveAt(oldCutoff, {
    currency: "CNY", sourceStableKey: "plan:cutoff"
  }))?.id, draft1.id);
});
