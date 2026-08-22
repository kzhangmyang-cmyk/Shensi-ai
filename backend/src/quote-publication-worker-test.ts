import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  InMemoryQuoteRepository,
  type DealAuthoritativeQuote,
  type QuotePublicationOperation
} from "./quote-repository.js";
import { QuotePublicationWorker } from "./quote-publication-worker.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import type { QuoteVersion } from "./quote-repository.js";

const publicationVersion = Object.freeze({
  id: "version-1", workspaceId: "team-a", quoteCaseId: "case-1", version: 1,
  lifecycleRevision: 2, versionKind: "formal", sourceDraftVersionId: "draft-1",
  probabilityAssessmentSnapshot: {}, status: "approved", createdBy: "sales-1",
  createdAt: "2026-08-09T08:00:00.000Z",
  effectiveAt: "2026-08-09T08:00:00.000Z",
  recordedAt: "2026-08-09T08:00:00.000Z", temporalSequence: 3,
  currency: "USD", quotedAmountMinor: 29_800,
  commercialAmountHash: `sha256:${"a".repeat(64)}`,
  lineSnapshot: { catalogItemId: "sku-1", quantityMicros: 2_000_000,
    offeredUnitPriceMinor: 14_900 }, packageSnapshot: null
}) as unknown as QuoteVersion;

const operation = Object.freeze({
  id: "publication-1", workspaceId: "team-a", quoteCaseId: "case-1",
  quoteVersionId: "version-1", dealId: "deal-1", dealAuthorityRevision: 2,
  commercialAmountHash: `sha256:${"a".repeat(64)}`, status: "queued",
  piDocumentId: null, dealEventId: null, attempts: 0, lastErrorCode: null,
  idempotencyKey: "quote-publication:deal-1:version-1:2",
  leaseOwner: null, fencingToken: 0, leaseExpiresAt: null,
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
}) as QuotePublicationOperation;

const authority = Object.freeze({
  workspaceId: "team-a", dealId: "deal-1", openQuoteCaseId: "case-1",
  quoteVersionId: "version-1",
  commercialAmountHash: `sha256:${"a".repeat(64)}`,
  authorityRevision: 2, updatedAt: "2026-08-09T08:00:00.000Z"
}) as DealAuthoritativeQuote;

export function publicationFixture(options: {
  failAfterPi?: boolean; failAfterCrm?: boolean; staleAuthority?: boolean;
} = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:10:00.000Z"
  );
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryQuoteRepository(transactions, temporalBarrier, {
    versions: [publicationVersion], authority: [options.staleAuthority
      ? { ...authority, quoteVersionId: null, commercialAmountHash: null,
          authorityRevision: 3 }
      : authority],
    publicationOperations: [operation]
  });
  const piIds: string[] = [];
  const crmIds: string[] = [];
  let failedPi = false;
  let failedCrm = false;
  const crm = {
    async ensurePiProjection() {
      if (!piIds.length) piIds.push("pi-stable-1");
      if (options.failAfterPi && !failedPi) {
        failedPi = true;
        throw Object.assign(new Error("crash_after_pi"), {
          code: "crash_after_pi"
        });
      }
      return { piDocumentId: piIds[0]! };
    },
    async publishQuotedDeal() {
      if (!crmIds.length) crmIds.push("event-stable-1");
      if (options.failAfterCrm && !failedCrm) {
        failedCrm = true;
        throw Object.assign(new Error("crash_after_crm"), {
          code: "crash_after_crm"
        });
      }
      return { dealEventId: crmIds[0]! };
    }
  };
  const workerA = new QuotePublicationWorker({ repository, crm,
    workerId: "worker-a", leaseDurationMs: 30_000 });
  const workerB = new QuotePublicationWorker({ repository, crm,
    workerId: "worker-b", leaseDurationMs: 30_000 });
  return { repository, workerA, workerB, piIds, crmIds, transactions };
}

test("two workers publish one PI and one quote event", async () => {
  const state = publicationFixture();
  const results = await Promise.all([
    state.workerA.runOne("publication-1"),
    state.workerB.runOne("publication-1")
  ]);
  assert.equal(results.filter((result) => result.status === "succeeded").length,
  1);
  assert.deepEqual(state.piIds, ["pi-stable-1"]);
  assert.deepEqual(state.crmIds, ["event-stable-1"]);
  assert.equal((await state.repository.getPublication("publication-1"))?.status,
    "succeeded");
});

test("crash after PI is recovered without duplicating PI", async () => {
  const state = publicationFixture({ failAfterPi: true });
  assert.equal((await state.workerA.runOne("publication-1")).status, "failed");
  await state.repository.retryPublication("publication-1", Object.freeze({
    workspaceId: "team-a", kind: "team", actorId: "manager-1",
    role: "manager", teamId: "team-a",
    capabilities: capabilitiesForHumanRole("manager"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  }),
    "2026-08-09T08:10:01.000Z");
  assert.equal((await state.workerB.runOne("publication-1")).status, "succeeded");
  assert.deepEqual(state.piIds, ["pi-stable-1"]);
});

test("expired and stale claims cannot mutate publication state", async () => {
  const state = publicationFixture();
  const claim = await state.repository.claimPublication("publication-1",
    "worker-a", "2026-08-09T08:10:00.000Z", "2026-08-09T08:10:30.000Z");
  assert.ok(claim);
  state.transactions.setDatabaseNow("2026-08-09T08:10:30.001Z");
  assert.equal(await state.repository.recordPiPublished(claim,
    "pi-too-late", "2026-08-09T08:10:30.001Z"), false);
  assert.equal((await state.repository.getPublication("publication-1"))
    ?.piDocumentId, null);
});

test("authority revision mismatch cancels before side effects", async () => {
  const state = publicationFixture({ staleAuthority: true });
  const result = await state.workerA.runOne("publication-1");
  assert.equal(result.status, "cancelled");
  assert.equal(state.piIds.length, 0);
  assert.equal(state.crmIds.length, 0);
});
