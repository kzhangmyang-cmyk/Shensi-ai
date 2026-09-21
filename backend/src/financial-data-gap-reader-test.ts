import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  FinancialDataGapAsOfBoundary,
  type FinancialDataGap,
  type FinancialDataGapSealedReader,
  type FinancialDataGapVisibilityKeys
} from "./financial-data-gap-reader.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import {
  ledgerEntryStatus,
  type FinancialFact,
  type FinancialFactType,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import type {
  FinancialDataGapCode,
  FinancialDataGapSourceType
} from "./growth-contract-types.js";
import {
  foundationServicesFixture,
  ledgerCommandContext
} from "./growth-finance-test-fixtures.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";

const GAP_CODE_ORDER: Record<FinancialDataGapCode, number> = {
  unverified_cost: 0,
  unverified_financial_fact: 1,
  missing_cogs: 2,
  unmatched_payment: 3,
  missing_commercial_binding: 4,
  import_requires_review: 5
};

interface RawGapSeed {
  code: FinancialDataGapCode;
  sourceType: string;
  sourceId: string;
  recordedAt: string;
}

async function financeGapFixture() {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T08:00:00.000Z"
  );
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier: new (await import("./growth-temporal-barrier.js"))
      .DefaultGrowthTemporalBarrier(repository)
  });
  const rawGaps: RawGapSeed[] = [];
  const workspace: ActiveWorkspaceContext = Object.freeze({
    workspaceId: "workspace-a", kind: "team", actorId: "finance-a",
    role: "admin", teamId: "workspace-a",
    capabilities: Object.freeze([
      "ledger.pending.create", "ledger.verify", "roi.close",
      "growth.performance.workspace.read", "pricing.sensitive.read"
    ]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
  const otherWorkspace: ActiveWorkspaceContext = Object.freeze({
    ...workspace, workspaceId: "workspace-b", teamId: "workspace-b"
  });
  function sha(value: unknown): `sha256:${string}` {
    return `sha256:${createHash("sha256")
      .update(JSON.stringify(value)).digest("hex")}`;
  }
  function factGaps(fact: FinancialFact): FinancialDataGap[] {
    const gaps: FinancialDataGap[] = [];
    const base = {
      sourceType: "financial_fact" as FinancialDataGapSourceType,
      sourceId: fact.id,
      candidateId: fact.candidateId,
      customerId: fact.customerId,
      dealId: fact.dealId,
      cohortId: null,
      currency: fact.currency,
      businessOccurredAt: fact.businessOccurredAt,
      recordedAt: fact.recordedAt,
      sourceSnapshotHash: sha({
        id: fact.id, evidenceHash: fact.evidenceHash,
        sourceIdentityRoot: fact.sourceIdentityRoot
      })
    };
    if (fact.factType === "revenue_recognized") {
      gaps.push({ ...base, code: "missing_cogs" });
    }
    if (fact.dealId && !fact.commercialBindingSnapshot) {
      gaps.push({ ...base, code: "missing_commercial_binding" });
    }
    return gaps;
  }
  const sealedReader: FinancialDataGapSealedReader = {
    async listForBindingsAt(context, input) {
      const cutoff = input.cutoff;
      const all: FinancialDataGap[] = [];
      for (const raw of rawGaps) {
        if (raw.sourceType !== "cost_entry"
          && raw.sourceType !== "financial_fact"
          && raw.sourceType !== "finance_import"
          && raw.sourceType !== "commercial_binding") {
          throw Object.assign(
            new Error("financial_data_gap_source_invalid"),
            { code: "financial_data_gap_source_invalid" }
          );
        }
        if (Date.parse(raw.recordedAt) <= Date.parse(cutoff.effectiveAsOf)) {
          all.push({
            code: raw.code,
            sourceType: raw.sourceType as FinancialDataGapSourceType,
            sourceId: raw.sourceId,
            candidateId: null,
            customerId: null,
            dealId: null,
            cohortId: null,
            currency: input.currency,
            businessOccurredAt: raw.recordedAt,
            recordedAt: raw.recordedAt,
            sourceSnapshotHash: sha({ raw: raw.sourceId })
          });
        }
      }
      const facts = await repository.listFinancialFacts(context.workspaceId);
      for (const fact of facts) {
        if (fact.currency !== input.currency
          || Date.parse(fact.recordedAt) > Date.parse(cutoff.effectiveAsOf)
          || fact.temporalSequence > cutoff.temporalSequence) continue;
        const allEvents = await repository.listVerificationEvents(
          context.workspaceId, "financial", fact.id
        );
        const events = allEvents.filter((event) =>
          Date.parse(event.recordedAt) <= Date.parse(cutoff.effectiveAsOf));
        if (ledgerEntryStatus(events) === "pending") {
          all.push({
            ...factGaps(fact)[0]!,
            code: "unverified_financial_fact"
          });
        }
        all.push(...factGaps(fact).filter((gap) =>
          gap.code === "missing_cogs"
          || gap.code === "missing_commercial_binding"));
      }
      const ordered = [...all].sort((left, right) =>
        left.businessOccurredAt.localeCompare(right.businessOccurredAt)
        || left.sourceId.localeCompare(right.sourceId)
        || GAP_CODE_ORDER[left.code] - GAP_CODE_ORDER[right.code]);
      return Object.freeze(ordered.slice(0, input.limit));
    },
    async verifyAt(context, input) {
      const rows = await this.listForBindingsAt(context, {
        visibility: input.visibility,
        currency: input.currency,
        cutoff: input.cutoff,
        limit: 100
      });
      return rows.find((gap) =>
        gap.sourceType === input.sourceType
        && gap.sourceId === input.sourceId
        && gap.code === input.gapCode
        && gap.sourceSnapshotHash === input.sourceSnapshotHash
        && gap.cohortId === input.cohortId) ?? null;
    }
  };
  const visibilityFor = async (
    context: ActiveWorkspaceContext
  ): Promise<FinancialDataGapVisibilityKeys> => {
    if (context.workspaceId !== "workspace-a") {
      return Object.freeze({
        candidateIds: Object.freeze([]),
        customerIds: Object.freeze([]),
        dealIds: Object.freeze([]),
        cohortIds: Object.freeze([])
      });
    }
    return Object.freeze({
      candidateIds: Object.freeze(["candidate-1"]),
      customerIds: Object.freeze(["customer-1"]),
      dealIds: Object.freeze(["deal-1"]),
      cohortIds: Object.freeze(["cohort-1"])
    });
  };
  const publicReader = new FinancialDataGapAsOfBoundary({
    foundation,
    sealedReader,
    now: () => "2026-08-09T10:00:00.000Z",
    visibilityFor
  });
  const service = new (await import("./financial-fact-ledger.js"))
    .FinancialFactLedgerService({
      repository,
      foundation,
      now: () => "2026-08-09T08:00:00.000Z",
      requestExecutionId: () => "gap-fixture-execution",
      bindingVerifier: {
        async verify() {
          throw new Error("commercial_binding_authority_mismatch");
        }
      },
      dealQuoteReader: {
        async getDecisionAt() {
          return null;
        }
      }
    });
  const factInput = (factType: FinancialFactType, id: string) => ({
    candidateId: null,
    customerId: null,
    dealId: null,
    factType,
    amountMinor: 100000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T07:00:00.000Z",
    provenance: "invoice_confirmed" as const,
    sourceRef: `invoice:${id}`,
    evidenceHash: `sha256:${id}`,
    externalId: id,
    sourceIdentityRoot: `external:invoice:${id}`
  });
  return {
    workspace,
    otherWorkspace,
    publicReader,
    recordPendingRevenueWithoutCogs: async (input: {
      recordedAt: string;
    }) => {
      repository.setDatabaseNow(input.recordedAt);
      return service.createPending(
        ledgerCommandContext("workspace-a", "finance-a", "gap-revenue"),
        factInput("revenue_recognized", "revenue-1")
      );
    },
    verifyRevenueAndRecordCogs: async (input: {
      recordedAt: string;
    }) => {
      repository.setDatabaseNow(input.recordedAt);
      const pending = await service.createPending(
        ledgerCommandContext("workspace-a", "finance-a", "gap-revenue"),
        factInput("revenue_recognized", "revenue-1")
      );
      await service.verify(
        ledgerCommandContext("workspace-a", "finance-a", "gap-verify", 1),
        { factId: pending.fact.id, reason: "checked" }
      );
      await service.createPending(
        ledgerCommandContext("workspace-a", "finance-a", "gap-cogs"),
        factInput("cogs_recognized", "cogs-1")
      );
    },
    seedRawGap: async (raw: RawGapSeed) => {
      rawGaps.push(raw);
    }
  };
}

test("financial gaps are historical, workspace scoped and source backed", async () => {
  const fixture = await financeGapFixture();
  await fixture.recordPendingRevenueWithoutCogs({
    recordedAt: "2026-08-09T08:00:00.000Z"
  });
  const before = await fixture.publicReader.listForBindingsAsOf(
    fixture.workspace, {
      currency: "CNY", asOf: "2026-08-09T08:30:00.000Z", limit: 100
    }
  );
  assert.deepEqual(before.map((gap) => gap.code), [
    "unverified_financial_fact", "missing_cogs"
  ]);
  await fixture.verifyRevenueAndRecordCogs({
    recordedAt: "2026-08-09T09:00:00.000Z"
  });
  assert.deepEqual(await fixture.publicReader.listForBindingsAsOf(
    fixture.workspace, {
      currency: "CNY", asOf: "2026-08-09T08:30:00.000Z", limit: 100
    }
  ), before);
  assert.deepEqual(await fixture.publicReader.listForBindingsAsOf(
    fixture.otherWorkspace, {
      currency: "CNY", asOf: "2026-08-09T10:00:00.000Z", limit: 100
    }
  ), []);
});

test("financial gap reader rejects an unknown persisted source discriminant", async () => {
  const fixture = await financeGapFixture();
  await fixture.seedRawGap({
    code: "unverified_cost",
    sourceType: "provider_request_unknown",
    sourceId: "raw-1",
    recordedAt: "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(() => fixture.publicReader.listForBindingsAsOf(
    fixture.workspace, {
      currency: "CNY",
      asOf: "2026-08-09T09:00:00.000Z",
      limit: 100
    }
  ), (error: unknown) =>
    (error as { code?: string }).code === "financial_data_gap_source_invalid");
});
