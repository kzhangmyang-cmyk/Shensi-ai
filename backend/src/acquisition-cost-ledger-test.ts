import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import type {
  GrowthHttpIdempotencyRepository,
  GrowthHttpIdempotencyReservationInput
} from "./growth-http-idempotency-repository.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import { ledgerEntryStatus } from "./financial-ledger-domain.js";
import {
  financeTemporalBarrierFixture,
  foundationServicesFixture,
  ledgerCommandContext,
  twoPendingCostEntriesFixture,
  verifiedCostLedgerFixture
} from "./growth-finance-test-fixtures.js";

class FailFirstCompletionRepository implements GrowthHttpIdempotencyRepository {
  private failed = false;

  constructor(private readonly delegate = new InMemoryGrowthHttpIdempotencyRepository()) {}

  reserve(input: GrowthHttpIdempotencyReservationInput) {
    return this.delegate.reserve(input);
  }

  async complete(
    reservationId: string,
    leaseOwner: string,
    fencingToken: number,
    result: { resourceId: string | null; operationId: string | null }
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected_completion_failure");
    }
    await this.delegate.complete(
      reservationId, leaseOwner, fencingToken, result
    );
  }

  release(reservationId: string, leaseOwner: string, fencingToken: number) {
    return this.delegate.release(reservationId, leaseOwner, fencingToken);
  }
}

test("verify and correct preserve an immutable source-version chain", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new AcquisitionCostLedgerService({
    repository,
    foundation: foundationServicesFixture({
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository()
    }),
    now: () => "2026-08-09T01:00:00.000Z",
    requestExecutionId: () => "request-ledger-1"
  });
  const context = ledgerCommandContext("workspace-a", "finance-a");
  const created = await service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 10000, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "portal_export",
    sourceRef: "portal://row-1", evidenceHash: "sha256:row-1", externalId: "row-1",
    sourceIdentityRoot: "external:douyin-portal:row-1", estimateReconciliationId: null
  });
  await service.verify(ledgerCommandContext("workspace-a", "finance-a", "verify-cost-1", 1), { entryId: created.entry.id, reason: "portal total reconciled" });
  await assert.rejects(() => service.correct(
    ledgerCommandContext("workspace-a", "finance-a", "correct-cost-stale", 1), {
      entryId: created.entry.id, amountMinor: 12000,
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      evidenceHash: "sha256:row-1-corrected", sourceRef: "portal://row-1-reexport",
      reason: "provider reissued report"
    }), (error: unknown) => (error as { code?: string }).code
      === "ledger_revision_conflict");
  const corrected = await service.correct(ledgerCommandContext("workspace-a", "finance-a", "correct-cost-1", 2), {
    entryId: created.entry.id, amountMinor: 12000,
    businessOccurredAt: "2026-08-08T00:00:00.000Z", evidenceHash: "sha256:row-1-corrected",
    sourceRef: "portal://row-1-reexport", reason: "provider reissued report"
  });
  assert.equal(corrected.entry.sourceVersion, 2);
  assert.equal(corrected.entry.correctsCostEntryId, created.entry.id);
  assert.equal(ledgerEntryStatus(corrected.previousEvents), "reversed");
  assert.equal(ledgerEntryStatus(corrected.events), "pending");
});

test("reverse after verification requires current revision two", async () => {
  const state = verifiedCostLedgerFixture();
  await assert.rejects(() => state.service.reverse(
    ledgerCommandContext("workspace-a", "finance-a", "reverse-cost-stale", 1),
    { entryId: state.entry.id, reason: "stale attempt" }
  ), (error: unknown) => (error as { code?: string }).code
    === "ledger_revision_conflict");
  const reversed = await state.service.reverse(
    ledgerCommandContext("workspace-a", "finance-a", "reverse-cost-current", 2),
    { entryId: state.entry.id, reason: "invoice voided" }
  );
  assert.equal(reversed.events.at(-1)?.revision, 3);
});

test("correction locks the temporal barrier before source entry and event state", async () => {
  const state = verifiedCostLedgerFixture();
  await state.service.correct(
    ledgerCommandContext("workspace-a", "finance-a", "correct-lock-order", 2),
    {
      entryId: state.entry.id,
      amountMinor: 12_000,
      businessOccurredAt: state.entry.businessOccurredAt,
      evidenceHash: "sha256:correct-lock-order",
      sourceRef: "portal://correct-lock-order",
      reason: "provider correction"
    }
  );
  assert.deepEqual(state.correctionLockTrace().slice(0, 4), [
    "temporal:workspace-a",
    `source:cost:${state.entry.sourceIdentityRoot}`,
    `entry:cost:${state.entry.id}`,
    `events:cost:${state.entry.id}`
  ]);
});

test("a sealed cutoff excludes a later new stream when the database clock regresses", async () => {
  const state = financeTemporalBarrierFixture({
    workspaceId: "workspace-a", databaseNow: "2026-08-09T08:30:00.000Z"
  });
  const sealed = await state.foundation.temporalBarrier.sealReadCutoff(
    state.workspace, "2026-08-09T09:00:00.000Z"
  );
  state.setDatabaseNow("2026-08-09T08:00:00.000Z");
  const created = await state.service.createPending(
    ledgerCommandContext("workspace-a", "finance-a", "new-stream-after-cutoff"),
    state.newCostInput({ sourceIdentityRoot: "external:portal:never-seen-before" })
  );
  const verified = await state.service.verify(
    ledgerCommandContext("workspace-a", "finance-a", "verify-new-stream", 1),
    { entryId: created.entry.id, reason: "checked" }
  );
  assert.equal(created.entry.recordedAt, "2026-08-09T09:00:00.001Z");
  assert.equal(created.entry.temporalSequence, sealed.temporalSequence + 1);
  assert.equal(verified.events.at(-1)?.recordedAt, "2026-08-09T09:00:00.002Z");
  assert.ok((verified.events.at(-1)?.temporalSequence ?? 0) > created.entry.temporalSequence);
  assert.deepEqual(await state.sealedReader.listVerifiedCostsAt(sealed, {
    currency: "CNY", entryIds: [created.entry.id]
  }), []);
  assert.deepEqual(await state.sealedReader.listVerifiedCostsAt(sealed, {
    currency: "CNY", entryIds: [created.entry.id]
  }), []);
  const after = await state.foundation.temporalBarrier.sealReadCutoff(
    state.workspace, "2026-08-09T09:00:00.002Z"
  );
  assert.equal((await state.sealedReader.listVerifiedCostsAt(after, {
    currency: "CNY", entryIds: [created.entry.id]
  })).length, 1);
  assert.deepEqual(state.firstBusinessLockTrace(), [
    "temporal:workspace-a", "source:cost:external:portal:never-seen-before"
  ]);
});

test("one key cannot decide two ledger path IDs", async () => {
  const state = twoPendingCostEntriesFixture(["cost-a", "cost-b"]);
  await state.service.verify(ledgerCommandContext(
    "workspace-a", "finance-a", "verify-cross-id-0001", 1,
    { method: "POST", canonicalPath: "/api/v1/acquisition/cost-entries/:id/verify",
      pathParams: { id: "cost-a" }, payload: { reason: "checked" } }
  ), { entryId: "cost-a", reason: "checked" });
  await assert.rejects(() => state.service.verify(ledgerCommandContext(
    "workspace-a", "finance-a", "verify-cross-id-0001", 1,
    { method: "POST", canonicalPath: "/api/v1/acquisition/cost-entries/:id/verify",
      pathParams: { id: "cost-b" }, payload: { reason: "checked" } }
  ), { entryId: "cost-b", reason: "checked" }),
  (error: unknown) => (error as { code?: string }).code === "idempotency_conflict");
  assert.equal(await state.status("cost-b"), "pending");
});

test("a second decision and a self-conflicting idempotency replay are rejected", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new AcquisitionCostLedgerService({
    repository,
    foundation: foundationServicesFixture({
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository()
    })
  });
  const context = ledgerCommandContext("workspace-a", "finance-a", "idem-cost-0001");
  const first = await service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 100, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "manual_verified",
    sourceRef: "voucher:1", evidenceHash: "sha256:voucher-1", externalId: "voucher-1",
    sourceIdentityRoot: "external:manual:voucher-1", estimateReconciliationId: null
  });
  await assert.rejects(() => service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 101, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "manual_verified",
    sourceRef: "voucher:1", evidenceHash: "sha256:voucher-1", externalId: "voucher-1",
    sourceIdentityRoot: "external:manual:voucher-1", estimateReconciliationId: null
  }), /idempotency_conflict/);
  assert.equal((await repository.getCostEntry("workspace-a", first.entry.id))?.amountMinor, 100);
});

test("public reads cannot observe an uncommitted row and rollback removes it", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const foundation = foundationServicesFixture();
  const service = new AcquisitionCostLedgerService({ repository, foundation });
  const created = await service.createPending(
    ledgerCommandContext("workspace-a", "finance-a", "create-rollback-base"),
    {
      platform: "douyin", planId: null, runId: null, providerId: null,
      category: "media", amountMinor: 100, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      provenance: "manual_verified", sourceRef: "voucher:rollback",
      evidenceHash: "sha256:rollback", externalId: "rollback",
      sourceIdentityRoot: "external:manual:rollback",
      estimateReconciliationId: null
    }
  );
  let inserted!: () => void;
  const insertedPromise = new Promise<void>((resolve) => { inserted = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const pending = repository.transaction(async (tx) => {
    await tx.insertCostEntry(Object.freeze({
      ...created.entry,
      id: "cost-uncommitted",
      sourceIdentityRoot: "external:manual:uncommitted"
    }));
    inserted();
    await gate;
    throw new Error("injected_transaction_failure");
  });
  await insertedPromise;
  assert.equal(await repository.getCostEntry("workspace-a", "cost-uncommitted"), null);
  resume();
  await assert.rejects(pending, /injected_transaction_failure/);
  assert.equal(await repository.getCostEntry("workspace-a", "cost-uncommitted"), null);
});

test("a reclaimed verification returns its stable event after lost completion", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const createFoundation = foundationServicesFixture();
  const createService = new AcquisitionCostLedgerService({
    repository,
    foundation: createFoundation
  });
  const created = await createService.createPending(
    ledgerCommandContext("workspace-a", "finance-a", "create-before-lost-completion"),
    {
      platform: "douyin", planId: null, runId: null, providerId: null,
      category: "media", amountMinor: 100, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      provenance: "manual_verified", sourceRef: "voucher:lost-completion",
      evidenceHash: "sha256:lost-completion", externalId: "lost-completion",
      sourceIdentityRoot: "external:manual:lost-completion",
      estimateReconciliationId: null
    }
  );
  const completion = new FailFirstCompletionRepository();
  let now = "2026-08-09T01:00:00.000Z";
  const foundation = foundationServicesFixture({ httpIdempotency: completion });
  const service = new AcquisitionCostLedgerService({
    repository,
    foundation,
    now: () => now
  });
  const context = ledgerCommandContext(
    "workspace-a", "finance-a", "verify-lost-completion", 1
  );
  await assert.rejects(
    () => service.verify(context, { entryId: created.entry.id, reason: "checked" }),
    /injected_completion_failure/
  );
  now = "2026-08-09T01:00:31.000Z";
  const recovered = await service.verify(
    context, { entryId: created.entry.id, reason: "checked" }
  );
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0]?.eventType, "verified");
});
