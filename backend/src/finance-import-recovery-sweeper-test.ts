import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinanceImportFixture
} from "./growth-finance-test-fixtures.js";

test("recovery reclaims an expired operation and stop waits for in-flight work", async () => {
  const fixture = await createFinanceImportFixture({
    status: "running",
    expiredOwner: "dead-worker"
  });
  const sweeper = fixture.recoverySweeper({
    workerId: "finance-recovery-1",
    intervalMs: 5_000
  });
  sweeper.start();
  const sweep = sweeper.sweepOnce();
  await fixture.waitUntilRecoveryClaimed();
  const stopping = sweeper.stop();
  assert.equal(fixture.stopResolved(stopping), false);
  fixture.releaseRecoveryRow();
  await sweep;
  await stopping;
  assert.equal((await fixture.operation())?.status, "succeeded");
  assert.ok(
    (await fixture.operation())!.fencingToken > fixture.expiredFencingToken
  );
  await sweeper.close();
  await sweeper.close();
  assert.equal(fixture.activeTimerCount(), 0);
});

test("one failed recovery is isolated from the next recoverable operation", async () => {
  const fixture = await createFinanceImportFixture({
    operations: ["bad-preview", "good-preview"]
  });
  fixture.failAuthorizationFor("bad-preview");
  await fixture.recoverySweeper({
    workerId: "finance-recovery-1",
    intervalMs: 5_000
  }).sweepOnce();
  assert.equal((await fixture.operation("bad-preview"))?.status, "failed");
  assert.equal((await fixture.operation("good-preview"))?.status, "succeeded");
});

test("recovery reauthorizes current ledger capability before claim work", async () => {
  const fixture = await createFinanceImportFixture({
    status: "running",
    expiredOwner: "dead-worker",
    requestingActorId: "finance-admin"
  });
  fixture.revoke("finance-admin", "ledger.pending.create");
  const before = await fixture.domainAndRowResultWriteCounts();
  await fixture.recoverySweeper({
    workerId: "finance-recovery-current-auth",
    intervalMs: 5_000
  }).sweepOnce();
  assert.equal(
    (await fixture.operation())?.lastErrorCode,
    "capability_forbidden"
  );
  assert.deepEqual(
    await fixture.domainAndRowResultWriteCounts(),
    before
  );
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("recovery rebuilds only the frozen operation identity and rejects a swapped preview", async () => {
  const fixture = await createFinanceImportFixture({
    status: "running",
    expiredOwner: "dead-worker"
  });
  fixture.replaceOperationPreviewId("preview-from-another-workspace");
  await fixture.recoverySweeper({
    workerId: "finance-recovery-1",
    intervalMs: 5_000
  }).sweepOnce();
  assert.deepEqual(fixture.recoveryAuthorizationInputs(), [
    { operationId: fixture.operationId }
  ]);
  assert.deepEqual(
    fixture.lastRecoveryContextIdentity(),
    fixture.frozenOperationContextIdentity()
  );
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
  assert.equal(
    (await fixture.operation())?.lastErrorCode,
    "finance_import_preview_mismatch"
  );
});
