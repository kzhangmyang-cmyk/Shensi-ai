import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";

test("MySQL expired owner cannot renew or save after a higher-fence reclaim", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued", rows: 1
    });
    const workerA = fixture.financeImportWorker({ connection: "a" });
    const workerB = fixture.financeImportWorker({ connection: "b" });
    const first = await workerA.claim(
      operationId, "worker-a", "2026-08-09T00:00:00.000Z"
    );
    assert.ok(first);
    fixture.setNow("2026-08-09T00:10:00.000Z");
    const second = await workerB.claim(
      operationId, "worker-b", fixture.now()
    );
    assert.ok(second && second.fencingToken > first.fencingToken);
    await assert.rejects(
      () => workerA.heartbeat(first, fixture.now()),
      /stale_fencing_token/
    );
    await assert.rejects(
      () => fixture.importRepository.saveRowResult(
        first, fixture.rowResult(), fixture.now()
      ),
      /stale_fencing_token/
    );
    const completed = await workerB.commit(
      fixture.commandContext(operationId), second
    );
    assert.equal(completed.createdIds.length, 1);
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 1);
  });
});

test("MySQL import claim renew row-save and completion share the global temporal order", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued", rows: 1
    });
    const worker = fixture.financeImportWorker({ connection: "b" });
    const claim = await worker.claim(operationId, "worker-order", fixture.now());
    assert.ok(claim);
    const renewed = await worker.heartbeat(claim, fixture.advanceNowBy(60_000));
    await worker.commit(fixture.commandContext(operationId), renewed);
    const events = await fixture.listImportOperationEvents(operationId);
    assert.deepEqual(events.map((event) => event.eventType), [
      "queued", "claimed", "renewed", "row_saved", "completed"
    ]);
    assert.equal(events.every((event, index) => index === 0
      || event.temporalSequence > events[index - 1]!.temporalSequence), true);
    assert.equal(fixture.writeLockTraces(operationId).every(
      (trace) => trace[0] === "temporal:workspace-a"
    ), true);
  });
});

test("MySQL recovery sweeper reclaims an expired operation exactly once", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "running",
      expiredOwner: "dead-worker",
      rows: 1
    });
    await fixture.financeImportRecoverySweeper().sweepOnce();
    assert.equal(
      (await fixture.importRepository.getOperation(operationId))?.status,
      "succeeded"
    );
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 1);
  });
});

test("MySQL rejects operation/preview hash substitution before any ledger write", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued", rows: 1
    });
    await assert.rejects(
      () => fixture.tamperOperationPreviewLink(operationId, {
        fileHash: "sha256:other-file"
      }),
      /finance_import_preview_identity_fk/
    );
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
    assert.equal(
      await fixture.countFinanceImportRowResults(operationId),
      0
    );
  });
});

test("MySQL import round-trips loss COGS and invalid arithmetic writes zero", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const lossOperation = await fixture.insertFinanceImportOperation({
      status: "queued",
      revenueMinor: 1000,
      grossProfitMinor: -400,
      rows: 1
    });
    const worker = fixture.financeImportWorker({ connection: "b" });
    const lossClaim = await worker.claim(
      lossOperation, "worker-loss", fixture.now()
    );
    assert.ok(lossClaim);
    const committed = await worker.commit(
      fixture.commandContext(lossOperation), lossClaim
    );
    assert.deepEqual(
      await fixture.readFactAmounts(committed.createdIds),
      [1000, 1400]
    );

    for (const invalid of [
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
    ] as const) {
      const operationId = await fixture.insertFinanceImportOperation({
        status: "queued",
        ...invalid,
        rows: 1,
        bypassPreviewForCommitIntegrityTest: true
      });
      const claim = await worker.claim(
        operationId, `worker-${invalid.code}`, fixture.now()
      );
      assert.ok(claim);
      await assert.rejects(
        () => worker.commit(fixture.commandContext(operationId), claim),
        (error: unknown) =>
          (error as { code?: string }).code === invalid.code
      );
      assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
      assert.equal(
        await fixture.countFinanceImportRowResults(operationId),
        0
      );
    }
  });
});

test("MySQL import commit enforces the frozen contract_won amount and binding", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued",
      factType: "contract_won",
      amountMinor: 298000,
      currency: "CNY",
      rows: 1
    });
    fixture.replaceWonAuthority({
      quotedAmountMinor: 320000,
      currency: "CNY",
      quoteVersionId: "quote-2",
      authorityRevision: 4
    });
    const worker = fixture.financeImportWorker({ connection: "a" });
    const claim = await worker.claim(
      operationId, "worker-contract-won", fixture.now()
    );
    assert.ok(claim);
    await assert.rejects(
      () => worker.commit(fixture.commandContext(operationId), claim),
      (error: unknown) =>
        (error as { code?: string }).code === "financial_fact_conflict"
    );
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
    assert.equal(
      await fixture.countFinanceImportRowResults(operationId),
      0
    );
  });
});
