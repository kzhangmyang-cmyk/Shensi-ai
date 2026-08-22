import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGrowthRequestHash } from "./growth-http-preconditions.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { InMemoryGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import {
  bindingInputFixture,
  commandContextFixture,
  probabilityRecordFixture,
  quoteInputFixture,
  quotePolicyFixture,
  workspaceContextFixture
} from "./growth-quote-test-fixtures.js";
import { createCommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import { InMemoryQuoteRepository, type QuoteCase, type QuoteVersion } from "./quote-repository.js";
import {
  QuoteVersionService,
  type QuotePreviewInput
} from "./quote-version-service.js";

const NOW = "2026-08-09T08:00:00.000Z";

function transportInput(): QuotePreviewInput {
  const { workspaceId: _workspaceId, ...input } = quoteInputFixture();
  return input;
}

function fixture(options: { assessment?: "current" | "legacy" | "stale" | "missing" } = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const binding = createCommercialBindingSnapshot(bindingInputFixture());
  const quoteCase: QuoteCase = {
    id: "case-1", workspaceId: "team-a", candidateId: "candidate-1",
    customerId: "customer-1", dealId: "deal-1", assignedTo: "sales-a",
    status: "open", currentDraftVersionId: null, revision: 1,
    commercialBindingSnapshot: binding, createdAt: NOW, updatedAt: NOW
  };
  const repository = new InMemoryQuoteRepository(transactions, temporalBarrier, {
    cases: [quoteCase]
  });
  const assessment = options.assessment === "missing" ? null
    : options.assessment === "legacy" ? ({
        ...probabilityRecordFixture(), precision: "percent"
      } as never)
    : probabilityRecordFixture({
        dealId: "deal-1",
        qualificationDecisionId: options.assessment === "stale"
          ? "qualification-old" : "qualification-1",
        qualificationDecisionVersion: options.assessment === "stale"
          ? "decision-old" : "decision-v1"
      });
  let resolveCalls = 0;
  let now = NOW;
  const policy = quotePolicyFixture({ validFrom: "2026-08-01T00:00:00.000Z" });
  const foundation = Object.freeze({
    httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
    temporalTransactions: transactions,
    temporalBarrier
  });
  const service = new QuoteVersionService({
    repository,
    probabilityAssessments: {
      async findCurrent() { return assessment; }
    } as never,
    bindingVerifier: {
      async verify() { return binding; }
    } as never,
    catalog: {
      quoteCatalog: {
        async resolveAt(_context: unknown, input: { effectiveAt: string }) {
          resolveCalls += 1;
          if (input.effectiveAt >= "2026-09-01T00:00:00.000Z") {
            throw Object.assign(new Error("pricing_policy_not_effective"), {
              code: "pricing_policy_not_effective"
            });
          }
          return { catalogItem: { id: "catalog-item-1" }, pricingPolicy: policy,
            packageVersion: null, packageCostSnapshot: null };
        }
      }
    } as never,
    foundation: foundation as never,
    calculator: new QuoteCalculationService(),
    now: () => now,
    idFactory: (prefix) => `${prefix}-${Math.random().toString(16).slice(2)}`,
    qualificationAuthority: {
      async findCurrent() {
        return {
          qualificationDecisionId: "qualification-1",
          qualificationDecisionVersion: "decision-v1",
          inputSnapshotHash: probabilityRecordFixture().inputSnapshotHash
        };
      }
    }
  });
  function command(kind: "preview" | "create" | "submit", id: string,
    expectedRevision = 1) {
    const actorId = "sales-a";
    const workspace = workspaceContextFixture("sales", undefined, actorId);
    const canonicalPath = kind === "preview"
      ? "/api/v1/quotes/cases/:id/preview"
      : kind === "create"
        ? "/api/v1/quotes/cases/:id/versions"
        : "/api/v1/quotes/versions/:id/submit";
    return commandContextFixture({ workspace, actorId, expectedRevision,
      idempotencyKey: `${kind}-${id}`,
      requestHash: canonicalGrowthRequestHash({ method: "POST", canonicalPath,
        pathParams: { id }, payload: {}, expectedRevision }) });
  }
  return { repository, service, command, resolveCalls: () => resolveCalls,
    advance(value: string) { now = value; } };
}

async function createDraft(state: ReturnType<typeof fixture>): Promise<QuoteVersion> {
  const input = transportInput();
  const preview = await state.service.preview(
    state.command("preview", "case-1"), "case-1", input
  );
  return (await state.service.createVersion(
    state.command("create", "case-1"), "case-1",
    { previewIdentity: preview.value.previewIdentity, quoteInput: input }
  )).value;
}

test("createVersion rejects client authoritative totals with zero writes", async () => {
  const state = fixture();
  const input = transportInput();
  const preview = await state.service.preview(
    state.command("preview", "case-1"), "case-1", input
  );
  await assert.rejects(state.service.createVersion(
    state.command("create", "case-1"), "case-1", {
      previewIdentity: preview.value.previewIdentity,
      quoteInput: { ...input, quotedAmountMinor: 1 } as never
    }), (error: unknown) => (error as { code?: string }).code
      === "quote_input_contains_authoritative_field");
  assert.equal((await state.repository.listVersions("team-a", "case-1")).length, 0);
});

test("createVersion persists only the server recalculation", async () => {
  const state = fixture();
  const input = transportInput();
  const preview = await state.service.preview(
    state.command("preview", "case-1"), "case-1", input
  );
  const created = await state.service.createVersion(
    state.command("create", "case-1"), "case-1",
    { previewIdentity: preview.value.previewIdentity, quoteInput: input }
  );
  assert.equal(created.value.quotedAmountMinor, preview.value.quotedAmountMinor);
  assert.equal(created.value.inputSnapshotHash, preview.value.inputSnapshotHash);
  assert.equal(Object.isFrozen(created.value.pricingPolicySnapshot), true);
  assert.equal(created.value.versionKind, "draft");
  assert.equal(created.value.probabilityAssessmentSnapshot, null);
});

test("submission appends a distinct formal version and leaves the draft immutable", async () => {
  const state = fixture();
  const draft = await createDraft(state);
  const before = await state.repository.getVersion("team-a", draft.id);
  const submitted = await state.service.submit(
    state.command("submit", draft.id, draft.lifecycleRevision), draft.id
  );
  assert.deepEqual(await state.repository.getVersion("team-a", draft.id), before);
  assert.notEqual(submitted.value.submittedVersion.id, draft.id);
  assert.equal(submitted.value.submittedVersion.versionKind, "formal");
  assert.equal(submitted.value.submittedVersion.sourceDraftVersionId, draft.id);
  assert.equal(submitted.value.submittedVersion.probabilityAssessmentSnapshot
    ?.closeProbabilityBps, 4_321);
  assert.equal(submitted.value.approval.quoteVersionId,
    submitted.value.submittedVersion.id);
});

test("submission fails closed for missing legacy or stale v2 probability", async () => {
  for (const assessment of ["missing", "legacy", "stale"] as const) {
    const state = fixture({ assessment });
    const draft = await createDraft(state);
    await assert.rejects(state.service.submit(
      state.command("submit", draft.id, draft.lifecycleRevision), draft.id
    ), (error: unknown) => (error as { code?: string }).code
      === "probability_assessment_v2_required");
  }
});

test("committed preview replay returns frozen evidence without recalculating", async () => {
  const state = fixture();
  const input = transportInput();
  const command = state.command("preview", "case-1");
  const first = await state.service.preview(command, "case-1", input);
  state.advance("2026-09-02T00:00:00.000Z");
  const replay = await state.service.preview(command, "case-1", input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(state.resolveCalls(), 1);
  assert.equal("effectiveAt" in replay.value, false);
});
