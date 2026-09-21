import assert from "node:assert/strict";
import test from "node:test";
import { FinanceImportWorker } from "./finance-import-worker.js";
import {
  createFinanceImportFixture,
  wonQuoteFixture
} from "./growth-finance-test-fixtures.js";

test("stale fencing tokens cannot commit and replay creates no duplicate facts", async () => {
  const fixture = await createFinanceImportFixture();
  const worker = new FinanceImportWorker(fixture.dependencies);
  const first = await worker.claim(
    fixture.operationId, "worker-a", "2026-08-09T00:00:00.000Z"
  );
  assert.ok(first);
  fixture.setNow("2026-08-09T00:10:00.000Z");
  await assert.rejects(
    () => worker.heartbeat(first, fixture.now()),
    /stale_fencing_token/
  );
  await assert.rejects(
    () => worker.commit(fixture.context, first),
    /stale_fencing_token/
  );
  const second = await worker.claim(
    fixture.operationId, "worker-b", fixture.now()
  );
  assert.ok(second && second.fencingToken > first.fencingToken);
  const committed = await worker.commit(fixture.context, second);
  const replay = await worker.commit(fixture.context, second);
  assert.equal(committed.createdIds.length, 1);
  assert.deepEqual(replay, { ...committed, replayed: true });
});

test("heartbeat renews an unexpired claim and every row save uses the renewed fence", async () => {
  const fixture = await createFinanceImportFixture({ rows: 2 });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(
    fixture.operationId, "worker-a", "2026-08-09T00:00:00.000Z"
  );
  assert.ok(claim);
  fixture.setNow("2026-08-09T00:04:00.000Z");
  const renewed = await worker.heartbeat(claim, fixture.now());
  assert.ok(renewed.leaseExpiresAt > claim.leaseExpiresAt);
  fixture.setNow("2026-08-09T00:06:00.000Z");
  const result = await worker.commit(fixture.context, renewed);
  assert.equal(result.createdIds.length, 2);
  assert.deepEqual(
    fixture.savedRowFences(),
    [renewed.fencingToken, renewed.fencingToken]
  );
});

test("every import transition takes the workspace barrier first and appends a global sequence", async () => {
  const fixture = await createFinanceImportFixture({ rows: 1 });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(
    fixture.operationId, "worker-temporal", fixture.now()
  );
  assert.ok(claim);
  const renewed = await worker.heartbeat(
    claim, fixture.advanceNowBy(60_000)
  );
  await worker.commit(fixture.context, renewed);
  const events = await fixture.operationEvents();
  assert.deepEqual(events.map((event) => event.eventType), [
    "queued", "claimed", "renewed", "row_saved", "completed"
  ]);
  assert.equal(events.every((event, index) => index === 0
    || event.temporalSequence > events[index - 1]!.temporalSequence), true);
  assert.equal(events.every((event, index) => index === 0
    || event.recordedAt > events[index - 1]!.recordedAt), true);
  assert.equal(fixture.writeLockTraces().every(
    (trace) => trace[0] === "temporal:workspace-a"
  ), true);
  assert.equal(fixture.commitBoundarySealCallCount(), 1);
  assert.equal(fixture.internalFactSealCallCount(), 0);
  assert.equal(fixture.quoteReaderSealCallCount(), 0);
  assert.equal(fixture.authorityCutoffs().every(
    (cutoff) => cutoff === fixture.lastCommitBoundaryCutoff()
  ), true);
});

test("commit authority is frozen and identity substitution performs zero writes", async () => {
  const cases = [
    ["cross-workspace", { workspaceId: "workspace-b" }],
    ["changed-actor", { actorId: "finance-b" }],
    ["changed-idempotency-key", { idempotencyKey: "different-commit-identity" }],
    ["tampered-request-hash", { requestHash: "sha256:tampered" }]
  ] as const;
  for (const [name, contextPatch] of cases) {
    const fixture = await createFinanceImportFixture();
    const worker = new FinanceImportWorker(fixture.dependencies);
    const claim = await worker.claim(
      fixture.operationId, `worker-${name}`, fixture.now()
    );
    assert.ok(claim);
    await assert.rejects(
      () => worker.commit(fixture.commandContext(contextPatch), claim),
      /finance_import_authority_mismatch/
    );
    assert.equal(await fixture.countCreatedLedgerRows(), 0);
    assert.equal(await fixture.countSavedRowResults(), 0);
  }

  const switchedPreview = await createFinanceImportFixture();
  switchedPreview.replaceOperationPreviewId("preview-from-another-operation");
  const worker = new FinanceImportWorker(switchedPreview.dependencies);
  const claim = await worker.claim(
    switchedPreview.operationId,
    "worker-preview-swap",
    switchedPreview.now()
  );
  assert.ok(claim);
  await assert.rejects(
    () => worker.commit(switchedPreview.context, claim),
    /finance_import_preview_mismatch/
  );
  assert.equal(await switchedPreview.countCreatedLedgerRows(), 0);
  assert.equal(await switchedPreview.countSavedRowResults(), 0);
});

test("commit revalidates the frozen contract_won amount and currency", async () => {
  const fixture = await createFinanceImportFixture({
    factType: "contract_won",
    amountMinor: 298000,
    currency: "CNY",
    wonQuote: wonQuoteFixture()
  });
  fixture.replaceWonAuthority({
    quoteVersionId: "quote-2",
    quotedAmountMinor: 320000,
    currency: "CNY",
    commercialAmountHash: "sha256:commercial-2",
    authorityRevision: 4
  });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(
    fixture.operationId, "worker-authority-change", fixture.now()
  );
  assert.ok(claim);
  await assert.rejects(
    () => worker.commit(fixture.context, claim),
    (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict"
  );
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("commit rejects current rebinding while preserving the preview's formal binding", async () => {
  const fixture = await createFinanceImportFixture({
    factType: "contract_won",
    amountMinor: 298000,
    currency: "CNY",
    wonQuote: wonQuoteFixture()
  });
  const frozenDecision = await fixture.normalizedAuthoritativeDecision();
  fixture.replaceCurrentBinding({
    candidateId: "candidate-rebound",
    customerId: "customer-rebound",
    dealId: "deal-1",
    handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(
    fixture.operationId, "worker-binding-rebound", fixture.now()
  );
  assert.ok(claim);
  await assert.rejects(
    () => worker.commit(fixture.context, claim),
    (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict"
  );
  assert.equal(
    frozenDecision?.commercialBindingEvidence.candidateId,
    "candidate-1"
  );
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("commit re-runs shared bigint COGS derivation before any ledger write", async () => {
  const cases = [
    {
      revenueMinor: 1000,
      grossProfitMinor: 1001,
      code: "financial_fact_amount_invalid"
    },
    {
      revenueMinor: Number.MAX_SAFE_INTEGER,
      grossProfitMinor: -1,
      code: "amount_out_of_range"
    }
  ] as const;
  for (const current of cases) {
    const fixture = await createFinanceImportFixture({
      revenueMinor: current.revenueMinor,
      grossProfitMinor: current.grossProfitMinor,
      bypassPreviewForCommitIntegrityTest: true
    });
    const worker = new FinanceImportWorker(fixture.dependencies);
    const claim = await worker.claim(
      fixture.operationId, `worker-${current.code}`, fixture.now()
    );
    assert.ok(claim);
    await assert.rejects(
      () => worker.commit(fixture.context, claim),
      (error: unknown) =>
        (error as { code?: string }).code === current.code
    );
    assert.equal(await fixture.countCreatedLedgerRows(), 0);
    assert.equal(await fixture.countSavedRowResults(), 0);
  }
});
