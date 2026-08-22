import assert from "node:assert/strict";
import test from "node:test";
import { quoteCaseFixture } from "./growth-quote-test-fixtures.js";

test("repository enforces revision CAS, one open Case per Deal, and rolls back losing writes", async () => {
  const state = quoteCaseFixture({ cases: ["case-a", "case-b"] });
  const [left, right] = await Promise.all([
    state.service.bindDeal(state.command({ idempotencyKey: "bind-a", expectedRevision: 1 }), "case-a", { dealId: "deal-1" }),
    state.service.bindDeal(state.command({ idempotencyKey: "bind-b", expectedRevision: 1 }), "case-b", { dealId: "deal-1" })
  ].map((promise) => promise.then(({ value }) => value.id, (error) => error.code)));
  assert.deepEqual([left, right].sort(), ["deal_open_quote_case_conflict", "case-a"].sort());
  assert.equal(await state.repository.countBindings("team-a"), 1);
  assert.equal(await state.repository.countLifecycleEvents("team-a"), 3);
});

test("cancel expires drafts and terminal transitions reject submitted or approved versions", async () => {
  const cancellable = quoteCaseFixture({ cases: ["case-a"], versionStatuses: ["draft"] });
  const cancelled = await cancellable.service.cancel(
    cancellable.command({ idempotencyKey: "cancel", expectedRevision: 1 }), "case-a"
  );
  assert.equal(cancelled.value.status, "cancelled");
  assert.deepEqual(await cancellable.repository.listVersionStatuses("team-a", "case-a"), ["expired"]);
  for (const status of ["submitted", "approved"] as const) {
    const blocked = quoteCaseFixture({ cases: ["case-a"], versionStatuses: [status] });
    await assert.rejects(
      blocked.service.close(blocked.command({ idempotencyKey: `close-${status}`, expectedRevision: 1 }), "case-a"),
      (error: unknown) => (error as { code?: string }).code === "quote_case_has_active_formal_version"
    );
  }
});

test("a transaction failure after business work rolls back Case, lifecycle, and command receipt", async () => {
  const state = quoteCaseFixture({ failAfterWork: true });
  await assert.rejects(
    state.service.create(state.command({ idempotencyKey: "commit-failure" }), {
      candidateId: "candidate-1", assignedTo: "sales-a"
    }),
    (error: unknown) => (error as { code?: string }).code === "quote_commit_failed"
  );
  assert.equal(await state.repository.countCases("team-a"), 0);
  assert.equal(await state.repository.countLifecycleEvents("team-a"), 0);
  assert.equal(state.completedIdempotencyCount(), 0);
});
