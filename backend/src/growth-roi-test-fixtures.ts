import { createHash, randomUUID } from "node:crypto";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import {
  InMemoryAuthoritativeDiscoverySource,
  type InMemoryDiscoveryRow,
  type AuthoritativeDiscoverySource
} from "./acquisition-authoritative-discovery-projection.js";
import {
  DefaultAcquisitionCohortService
} from "./acquisition-cohort.js";
import {
  InMemoryAcquisitionCohortRepository
} from "./acquisition-cohort-repository.js";
import {
  FoundationRoiCommandExecutor
} from "./growth-roi-command-executor.js";
import {
  foundationServicesFixture
} from "./growth-finance-test-fixtures.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthCapability } from "./growth-capabilities.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import type { CanonicalSubjectMaterial } from "./acquisition-canonical-subject.js";
import { wonQuoteFixture } from "./growth-finance-test-fixtures.js";
import {
  AttributionAllocationService,
  type AttributionAllocationServiceLike
} from "./acquisition-attribution-allocation.js";
import {
  InMemoryAttributionAllocationRepository
} from "./acquisition-attribution-allocation-repository.js";
import {
  DefaultFinancialSourceReportService,
  type FinancialSourceReportService
} from "./financial-source-report.js";
import {
  CashSettlementAllocationService,
  activeSettlementSetIdAsOf,
  type CashSettlementAllocationItemInput
} from "./financial-settlement-allocation.js";
import {
  InMemoryFinancialSettlementRepository
} from "./financial-settlement-allocation-repository.js";
import {
  RoiClosureService,
  type ClosureAttestation,
  type ClosureEvidenceRef
} from "./acquisition-roi-closure.js";
import {
  InMemoryRoiClosureRepository
} from "./acquisition-roi-closure-repository.js";
import {
  DefaultAcquisitionGrowthPerformanceQueryService,
  type GrowthPerformanceDataSource,
  type GrowthPerformanceQueryPage
} from "./acquisition-growth-performance-query.js";

export interface DiscoveryRowSeed {
  eventId: string;
  candidateId: string;
  ownerId: string;
  discoveredAt: string;
  recordedAt: string;
  actorKey: string;
  planId: string;
  runId?: string;
  shardId?: string;
}

function attributionFor(seed: DiscoveryRowSeed): OutcomeAttributionInput {
  return Object.freeze({
    attributionVersion: "acquisition-run.v1",
    runId: seed.runId ?? `run-${seed.eventId}`,
    planId: seed.planId,
    planVersionId: `plan-version-${seed.planId}`,
    planVersion: 1,
    planSnapshotHash: `sha256:${"a".repeat(64)}`,
    discoveredEventId: seed.eventId,
    discoveredAt: seed.discoveredAt,
    shardId: seed.shardId ?? `shard-${seed.eventId}`,
    operationId: `operation-${seed.eventId}`,
    connectionId: `connection-${seed.eventId}`,
    providerId: `provider-${seed.eventId}`,
    evidenceIds: [`evidence-${seed.eventId}`],
    providerIds: [`provider-${seed.eventId}`],
    queryIds: [`query-${seed.eventId}`],
    strategyVersion: "strategy-1",
    qualificationDecisionId: `decision-${seed.eventId}`,
    decisionVersion: "decision-v1",
    decisionSnapshotHash: `sha256:${"b".repeat(64)}`
  });
}

function rowFor(seed: DiscoveryRowSeed): InMemoryDiscoveryRow {
  const material: CanonicalSubjectMaterial = Object.freeze({
    kind: "individual",
    platform: "douyin",
    publicActorKey: seed.actorKey,
    canonicalProfileUrl: null
  });
  return Object.freeze({
    eventId: seed.eventId,
    candidateId: seed.candidateId,
    ownerId: seed.ownerId,
    discoveredAt: seed.discoveredAt,
    sourceRecordedAt: seed.recordedAt,
    sourceTemporalSequence: 1,
    material,
    attribution: attributionFor(seed)
  });
}

export function discoverySource(
  seeds: readonly DiscoveryRowSeed[]
) {
  const source = new InMemoryAuthoritativeDiscoverySource(
    seeds.map(rowFor)
  );
  const listCalls: Array<{ cutoff: GrowthSealedReadCutoff }> = [];
  const watermarkCalls: Array<{ cutoff: GrowthSealedReadCutoff }> = [];
  const wrapped: AuthoritativeDiscoverySource & {
    listCalls: Array<{ cutoff: GrowthSealedReadCutoff }>;
    watermarkCalls: Array<{ cutoff: GrowthSealedReadCutoff }>;
    appendRows(seeds: readonly DiscoveryRowSeed[]): void;
  } = {
    listCalls,
    watermarkCalls,
    async listDiscoveries(
      workspaceId: string,
      query: Parameters<typeof source.listDiscoveries>[1]
    ) {
      listCalls.push({ cutoff: query.cutoff });
      return source.listDiscoveries(workspaceId, query);
    },
    async getWatermark(
      workspaceId: string,
      query: Parameters<typeof source.getWatermark>[1]
    ) {
      watermarkCalls.push({ cutoff: query.cutoff });
      return source.getWatermark(workspaceId, query);
    },
    appendRows(seeds: readonly DiscoveryRowSeed[]) {
      source.appendRows(seeds.map(rowFor));
    }
  };
  return wrapped;
}

export function fixtureWatermark(
  eventId: string,
  count: number
) {
  const rows = Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index + 1}`,
    sourceRecordedAt: `2026-08-0${index + 1}T01:00:01.000Z`
  }));
  const last = rows.at(-1)!;
  return {
    lastSourceRecordedAt: last.sourceRecordedAt,
    lastEventId: eventId,
    lastSourceTemporalSequence: 1,
    eventCount: count,
    eventSetHash: `sha256:${createHash("sha256")
      .update(rows.map((row) =>
        `${row.eventId}\u0000${row.sourceRecordedAt}`).join("\u001f"))
      .digest("hex")}`
  };
}

export function workspaceContext(
  workspaceId: string,
  actorId = "admin-a"
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId,
    role: "admin",
    teamId: workspaceId,
    capabilities: Object.freeze([
      "roi.close",
      "growth.performance.workspace.read",
      "ledger.pending.create",
      "ledger.verify"
    ]) as readonly GrowthCapability[],
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

export function cohortCommandContext(
  workspaceId: string,
  actorId = "admin-a",
  idempotencyKey = "cohort-0001"
): CommandContext {
  const workspace = workspaceContext(workspaceId, actorId);
  return Object.freeze({
    workspace,
    actorId,
    idempotencyKey,
    requestHash: canonicalGrowthRequestHash({
      workspaceId,
      actorId,
      idempotencyKey,
      path: "/api/v1/acquisition/cohorts"
    }),
    expectedRevision: null
  });
}

export async function sealedCutoff(
  workspace: ActiveWorkspaceContext,
  asOf: string
): Promise<GrowthSealedReadCutoff> {
  const runner = new InMemoryGrowthTemporalTransactionRunner(asOf);
  return new DefaultGrowthTemporalBarrier(runner).sealReadCutoff(
    workspace, asOf
  );
}

export function cohortServiceFixture(options: {
  repository?: InMemoryAcquisitionCohortRepository;
  discoveries?: ReturnType<typeof discoverySource>;
  temporalTransactions?: InMemoryGrowthTemporalTransactionRunner;
  ids?: { next(): string };
}) {
  const repository = options.repository
    ?? new InMemoryAcquisitionCohortRepository();
  const transactions = options.temporalTransactions
    ?? new InMemoryGrowthTemporalTransactionRunner(
      "2026-08-09T00:00:00.000Z"
    );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  if (options.repository && options.temporalTransactions) {
    // repository already wired by the caller
  }
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const service = new DefaultAcquisitionCohortService({
    repository,
    foundation,
    commandExecutor: new FoundationRoiCommandExecutor({
      foundation,
      now: () => "2026-08-09T00:00:00.000Z"
    }),
    discoveries: options.discoveries ?? discoverySource([]),
    now: () => "2026-08-09T00:00:00.000Z",
    ids: options.ids
  });
  return {
    service,
    repository,
    closureCatchUp: service,
    readCatchUp: service,
    workspace: workspaceContext("workspace-a")
  };
}

export function lateRecordedDiscoveryFixture(options: {
  initial: readonly DiscoveryRowSeed[];
  late?: readonly DiscoveryRowSeed[];
  cohorts?: Array<{
    id: string;
    from: string;
    to: string;
  }>;
  projectOnlyAfterSeal?: boolean;
}) {
  const cohorts = options.cohorts ?? [{
    id: "cohort-1",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-08T00:00:00.000Z"
  }];
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryAcquisitionCohortRepository(
    transactions, barrier
  );
  const cohortIds = cohorts.map((cohort) => cohort.id);
  let cohortIndex = 0;
  const discoveries = discoverySource(options.initial);
  const fixture = cohortServiceFixture({
    repository,
    discoveries: discoveries as never,
    temporalTransactions: transactions,
    ids: {
      next: () => cohortIds[cohortIndex++] ?? `cohort-${cohortIndex}`
    }
  });
  const created = new Map<string, { id: string }>();
  const workspace = fixture.workspace;
  return {
    ...fixture,
    seal: (asOf: string) => sealedCutoff(workspace, asOf),
    appendLateRows: async () => {
      discoveries.appendRows(options.late ?? []);
    },
    catchUp: async (asOf: string) => {
      transactions.setDatabaseNow(asOf);
      const cutoff = await sealedCutoff(workspace, asOf);
      const cohort = created.values().next().value as { id: string };
      return fixture.closureCatchUp.ensureForClosure(
        cohortCommandContext("workspace-a"),
        { closureOperationId: "close-1", cohortId: cohort.id, cutoff }
      );
    },
    catchUpCohort: async (cohortId: string, cutoff: GrowthSealedReadCutoff) => {
      transactions.setDatabaseNow(cutoff.effectiveAsOf);
      return fixture.closureCatchUp.ensureForClosure(
        cohortCommandContext("workspace-a"),
        { closureOperationId: "close-1", cohortId, cutoff }
      );
    },
    listSources: async () => repository.listMemberSources("workspace-a"),
    listMembersAt: async (cohortId: string, cutoff: GrowthSealedReadCutoff) =>
      repository.listMembersAt("workspace-a", cohortId, cutoff),
    listOwnershipVersions: () =>
      repository.listMembershipVersions("workspace-a"),
    createCohorts: async () => {
      for (const cohort of cohorts) {
        const result = await fixture.service.create(
          cohortCommandContext("workspace-a", "admin-a",
            `cohort-${cohort.id}`),
          {
            platform: "douyin",
            cohortFrom: cohort.from,
            cohortTo: cohort.to,
            definitionVersion: "weekly.v1",
            firstTouchRuleVersion: "first-authoritative-discovery.v1"
          }
        );
        created.set(cohort.id, result);
      }
    }
  };
}

export function sha256Of(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value)).digest("hex")}`;
}

export function allocationFixture(options: {
  failFoundationCompletionOncePerMutation?: boolean;
} = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const failedCompletions = new Set<string>();
  if (options.failFoundationCompletionOncePerMutation) {
    const originalComplete = foundation.httpIdempotency.complete.bind(
      foundation.httpIdempotency
    );
    foundation.httpIdempotency.complete = async (...args) => {
      const [reservationId] = args;
      if (!failedCompletions.has(reservationId as string)) {
        failedCompletions.add(reservationId as string);
        throw new Error("injected_completion_loss");
      }
      return originalComplete(...args);
    };
  }
  let clock = "2026-08-09T00:00:00.000Z";
  const commandExecutor = new FoundationRoiCommandExecutor({
    foundation,
    now: () => clock
  });
  const capabilities: string[] = ["ledger.pending.create", "ledger.verify"];
  const repository = new InMemoryAttributionAllocationRepository();
  const dependencies = {
    repository,
    foundation,
    commandExecutor,
    sources: {
      async requireEffectiveAmountMinor() {
        return 10_000;
      }
    },
    now: () => clock,
    ids: { next: () => randomUUID() }
  };
  const service = new AttributionAllocationService(dependencies);
  const buildContext = (
    key = "allocation-0001",
    requestHash?: string
  ) => Object.freeze({
    workspace: Object.freeze({
      workspaceId: "workspace-a",
      kind: "team",
      actorId: "finance-a",
      role: "admin",
      teamId: "workspace-a",
      capabilities: capabilities as unknown as readonly string[],
      capabilityRegistryVersion: "growth-capabilities.v1"
    }) as ActiveWorkspaceContext,
    actorId: "finance-a",
    idempotencyKey: key,
    requestHash: requestHash ?? canonicalGrowthRequestHash({
      workspaceId: "workspace-a",
      actorId: "finance-a",
      idempotencyKey: key
    }),
    expectedRevision: null
  });
  const context = Object.assign(
    buildContext,
    buildContext()
  ) as ReturnType<typeof buildContext> & typeof buildContext;
  const reportServiceInstance = new DefaultFinancialSourceReportService({
    commandExecutor,
    now: () => clock,
    ids: { next: () => randomUUID() }
  });
  const reportService = () => reportServiceInstance;
  const reportInput = Object.freeze({
    currency: "CNY",
    sourceSystem: "bank",
    sourceCursor: null,
    reportHash: `sha256:${"a".repeat(64)}`,
    declaredTotalMinor: 10_000,
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-08T00:00:00.000Z"
  });
  const item = (
    cohortId: string,
    bps: number,
    targetStableKey: string
  ): import("./acquisition-attribution-allocation.js")
    .AttributionAllocationItemInput => ({
    cohortId,
    candidateId: null,
    planId: null,
    runId: null,
    allocationBps: bps,
    allocationRule: "manual" as const,
    ruleVersion: "manual.v1",
    evidenceRefs: [{
      kind: "ledger_source" as const,
      ledgerType: "cost" as const,
      ledgerEntryId: "cost-1",
      evidenceHash: `sha256:${"b".repeat(64)}`
    }],
    targetStableKey
  });
  return {
    dependencies,
    service,
    context,
    financialSourceReports: reportService,
    reportInput,
    allocationDraft: (reportId: string) => ({
      sourceType: "source_report" as const,
      sourceId: reportId,
      items: [
        item("cohort-a", 6000, "cohort-a"),
        item("cohort-b", 4000, "cohort-b")
      ]
    }),
    twoCompleteDrafts: async (allocationService: AttributionAllocationServiceLike) => {
      const draftInput = (sourceId: string) => ({
        sourceType: "cost_entry" as const,
        sourceId,
        items: [
          item("cohort-a", 6000, "cohort-a"),
          item("cohort-b", 4000, "cohort-b")
        ]
      });
      const a = await allocationService.createDraft(
        context("draft-a"), draftInput("cost-a")
      );
      const b = await allocationService.createDraft(
        context("draft-b"), draftInput("cost-b")
      );
      return [a, b] as const;
    },
    expireFoundationLease: () => {
      clock = new Date(
        Date.parse(clock) + 60_000
      ).toISOString();
      transactions.setDatabaseNow(clock);
    },
    revoke: (capability: string) => {
      const index = capabilities.indexOf(capability);
      if (index >= 0) capabilities.splice(index, 1);
    },
    restore: (capability: string) => {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    },
    activationCount: (allocationSetId: string) =>
      repository.activationCount(allocationSetId),
    domainCommandRowCounts: async () => {
      return {
        reports: reportServiceInstance.countReports(),
        drafts: repository.countDrafts(),
        activations: repository.countActivations()
      };
    }
  };
}

export function completeTwoCohortDraft(
  sourceId: string,
  firstBps: number
) {
  return {
    sourceType: "cost_entry" as const,
    sourceId,
    items: [
      {
        cohortId: "cohort-a",
        candidateId: null,
        planId: null,
        runId: null,
        allocationBps: firstBps,
        allocationRule: "manual" as const,
        ruleVersion: "manual.v1",
        evidenceRefs: [{
          kind: "ledger_source" as const,
          ledgerType: "cost" as const,
          ledgerEntryId: sourceId,
          evidenceHash: `sha256:${"a".repeat(64)}`
        }],
        targetStableKey: "cohort-a"
      },
      {
        cohortId: "cohort-b",
        candidateId: null,
        planId: null,
        runId: null,
        allocationBps: 10_000 - firstBps,
        allocationRule: "manual" as const,
        ruleVersion: "manual.v1",
        evidenceRefs: [{
          kind: "ledger_source" as const,
          ledgerType: "cost" as const,
          ledgerEntryId: sourceId,
          evidenceHash: `sha256:${"b".repeat(64)}`
        }],
        targetStableKey: "cohort-b"
      }
    ]
  };
}

export function settlementFixture(options: {
  revenues?: Array<{ id: string; dealId: string; amountMinor: number }>;
  payments?: Array<{ id: string; dealId: string; amountMinor: number }>;
  refunds?: Array<{ id: string; dealId: string; amountMinor: number }>;
  failFoundationCompletionOncePerMutation?: boolean;
} = {}) {
  const revenues = options.revenues ?? [];
  const payments = options.payments ?? [];
  const refunds = options.refunds ?? [];
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const failedCompletions = new Set<string>();
  if (options.failFoundationCompletionOncePerMutation) {
    const originalComplete = foundation.httpIdempotency.complete.bind(
      foundation.httpIdempotency
    );
    foundation.httpIdempotency.complete = async (...args) => {
      const [reservationId] = args;
      if (!failedCompletions.has(reservationId as string)) {
        failedCompletions.add(reservationId as string);
        throw new Error("injected_completion_loss");
      }
      return originalComplete(...args);
    };
  }
  let clock = "2026-08-09T00:00:00.000Z";
  const commandExecutor = new FoundationRoiCommandExecutor({
    foundation,
    now: () => clock
  });
  const capabilities: string[] = ["ledger.pending.create", "ledger.verify"];
  const repository = new InMemoryFinancialSettlementRepository();
  const workspace = workspaceContext("workspace-a");
  const binding = wonQuoteFixture().commercialBindingSnapshot;
  const factReader = {
    async requireFact(
      _workspace: ActiveWorkspaceContext,
      factId: string
    ) {
      const revenue = revenues.find((item) => item.id === factId);
      if (revenue) {
        return {
          id: revenue.id,
          factType: "revenue_recognized",
          dealId: revenue.dealId,
          quoteVersionId: "quote-1",
          amountMinor: revenue.amountMinor,
          currency: "CNY",
          commercialBindingSnapshot: binding
        };
      }
      const payment = payments.find((item) => item.id === factId);
      if (payment) {
        return {
          id: payment.id,
          factType: "payment_received",
          dealId: payment.dealId,
          quoteVersionId: "quote-1",
          amountMinor: payment.amountMinor,
          currency: "CNY",
          commercialBindingSnapshot: binding
        };
      }
      const refund = refunds.find((item) => item.id === factId);
      if (refund) {
        return {
          id: refund.id,
          factType: "refund",
          dealId: refund.dealId,
          quoteVersionId: "quote-1",
          amountMinor: refund.amountMinor,
          currency: "CNY",
          commercialBindingSnapshot: binding
        };
      }
      throw new Error("financial_fact_not_found");
    }
  };
  const service = new CashSettlementAllocationService({
    repository,
    foundation,
    commandExecutor,
    facts: factReader,
    now: () => clock,
    ids: { next: () => randomUUID() }
  });
  const context = (
    key = "settlement-0001",
    requestHash?: string
  ) => Object.freeze({
    workspace: Object.freeze({
      workspaceId: "workspace-a",
      kind: "team",
      actorId: "finance-a",
      role: "admin",
      teamId: "workspace-a",
      capabilities: capabilities as unknown as readonly string[],
      capabilityRegistryVersion: "growth-capabilities.v1"
    }) as ActiveWorkspaceContext,
    actorId: "finance-a",
    idempotencyKey: key,
    requestHash: requestHash ?? canonicalGrowthRequestHash({
      workspaceId: "workspace-a",
      actorId: "finance-a",
      idempotencyKey: key
    }),
    expectedRevision: null
  });
  const item = (
    revId: string,
    dealId: string,
    amountMinor: number,
    paymentRef: {
      paymentFactId: string | null;
      paymentSetId: string | null;
      paymentItemId: string | null;
    } = {
      paymentFactId: null,
      paymentSetId: null,
      paymentItemId: null
    }
  ): CashSettlementAllocationItemInput => ({
    targetRevenueFactId: revId,
    dealId,
    quoteVersionId: "quote-1",
    amountMinor,
    currency: "CNY",
    originalPaymentFactId: paymentRef.paymentFactId,
    originalPaymentAllocationSetId: paymentRef.paymentSetId,
    originalPaymentAllocationItemId: paymentRef.paymentItemId,
    commercialBindingSnapshot: binding
  });
  const dealOf = (factId: string) =>
    revenues.find((item) => item.id === factId)?.dealId
    ?? payments.find((item) => item.id === factId)?.dealId
    ?? refunds.find((item) => item.id === factId)?.dealId
    ?? "deal-a";
  return {
    dependencies: {
      repository,
      foundation,
      commandExecutor,
      facts: factReader,
      now: () => clock
    },
    service,
    workspace,
    foundation,
    context,
    completeDraft: {
      sourceFactId: payments[0]?.id ?? "pay-a",
      items: [
        item(
          revenues[0]?.id ?? "rev-a",
          dealOf(payments[0]?.id ?? "pay-a"),
          payments[0]?.amountMinor ?? 100
        )
      ]
    },
    activatePayment: async (
      settlementService: CashSettlementAllocationService,
      paymentId: string,
      revenueId: string,
      amountMinor: number
    ) => {
      const draft = await settlementService.createDraft(
        context(`draft-${paymentId}`),
        {
          sourceFactId: paymentId,
          items: [item(revenueId, dealOf(paymentId), amountMinor)]
        }
      );
      return settlementService.activate(
        { ...context(`activate-${paymentId}`), expectedRevision: 1 },
        draft.id
      );
    },
    activateRefund: async (
      settlementService: CashSettlementAllocationService,
      refundId: string,
      revenueId: string,
      amountMinor: number,
      paymentRef: {
        paymentFactId: string;
        paymentSetId: string;
        paymentItemId: string;
      }
    ) => {
      const draft = await settlementService.createDraft(
        context(`refund-draft-${refundId}`),
        {
          sourceFactId: refundId,
          items: [item(
            revenueId, dealOf(refundId), amountMinor, paymentRef
          )]
        }
      );
      return settlementService.activate(
        { ...context(`refund-activate-${refundId}`), expectedRevision: 1 },
        draft.id
      );
    },
    twoCompleteDrafts: async (
      settlementService: CashSettlementAllocationService
    ) => {
      const a = await settlementService.createDraft(
        context("settlement-draft-a"),
        {
          sourceFactId: payments[0]?.id ?? "pay-a",
          items: [item(
            revenues[0]?.id ?? "rev-a",
            dealOf(payments[0]?.id ?? "pay-a"),
            payments[0]?.amountMinor ?? 100
          )]
        }
      );
      const b = await settlementService.createDraft(
        context("settlement-draft-b"),
        {
          sourceFactId: payments[1]?.id ?? "pay-b",
          items: [item(
            revenues[1]?.id ?? "rev-b",
            dealOf(payments[1]?.id ?? "pay-b"),
            payments[1]?.amountMinor ?? 100
          )]
        }
      );
      return [a, b] as const;
    },
    expireFoundationLease: () => {
      clock = new Date(Date.parse(clock) + 60_000).toISOString();
      transactions.setDatabaseNow(clock);
    },
    revoke: (capability: string) => {
      const index = capabilities.indexOf(capability);
      if (index >= 0) capabilities.splice(index, 1);
    },
    restore: (capability: string) => {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    },
    activationCount: (allocationSetId: string) =>
      repository.activationCount(allocationSetId),
    domainCommandRowCounts: async () => ({
      drafts: (await repository.listSets("workspace-a")).length,
      activations: (await repository.listSets("workspace-a"))
        .filter((set) => set.status === "active").length
    })
  };
}

export function settlementLifecycleFixture() {
  const events = [
    {
      id: "event-1",
      workspaceId: "workspace-a",
      sourceFactId: "pay-a",
      allocationSetId: "payment-v1",
      eventType: "activated" as const,
      eventSequence: 1,
      revision: 1,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      supersedesAllocationSetId: null,
      actorId: "finance-a",
      recordedAt: "2026-08-01T00:00:00.000Z",
      temporalSequence: 1
    },
    {
      id: "event-z",
      workspaceId: "workspace-a",
      sourceFactId: "pay-a",
      allocationSetId: "payment-v1",
      eventType: "superseded" as const,
      eventSequence: 2,
      revision: 2,
      effectiveAt: "2026-08-09T00:00:00.000Z",
      supersedesAllocationSetId: null,
      actorId: "finance-a",
      recordedAt: "2026-08-09T00:00:00.000Z",
      temporalSequence: 2
    },
    {
      id: "event-a",
      workspaceId: "workspace-a",
      sourceFactId: "pay-a",
      allocationSetId: "payment-v2",
      eventType: "activated" as const,
      eventSequence: 3,
      revision: 3,
      effectiveAt: "2026-08-09T00:00:00.000Z",
      supersedesAllocationSetId: "payment-v1",
      actorId: "finance-a",
      recordedAt: "2026-08-09T00:00:00.001Z",
      temporalSequence: 3
    }
  ];
  return {
    events,
    asOfReader: {
      getActiveId: (
        source: typeof events,
        asOf: string
      ) => {
        return activeSettlementSetIdAsOf(source, asOf);
      }
    }
  };
}

export function settlementDraft(
  sourceFactId: string,
  revenueFactId: string,
  amountMinor: number,
  dealId = "deal-a"
) {
  return {
    sourceFactId,
    items: [{
      targetRevenueFactId: revenueFactId,
      dealId,
      quoteVersionId: "quote-1",
      amountMinor,
      currency: "CNY",
      originalPaymentFactId: null,
      originalPaymentAllocationSetId: null,
      originalPaymentAllocationItemId: null,
      commercialBindingSnapshot:
        wonQuoteFixture().commercialBindingSnapshot
    }]
  };
}

export async function completeClosureFixture(options: {
  currency?: string;
  costMinor?: number;
  revenueMinor?: number;
  cogsMinor?: number;
  paymentMinor?: number;
  refundMinor?: number;
  contractWonMinor?: number;
  sharedCohortCostMinor?: number;
  explicitPlanCostAllocations?: string[];
  members?: Array<{
    id: string;
    firstPlanId: string;
    revenueMinor: number;
    cogsMinor: number;
    acquisitionCostMinor: number;
  }>;
  failFoundationCompletionOncePerMutation?: boolean;
  serverNow?: string;
  deferCohortProjection?: boolean;
} = {}) {
  const currency = options.currency ?? "CNY";
  const members = options.members ?? [{
    id: "member-a",
    firstPlanId: "plan-a",
    revenueMinor: 1000,
    cogsMinor: 200,
    acquisitionCostMinor: 200
  }];
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    options.serverNow ?? "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const failedCompletions = new Set<string>();
  let clock = options.serverNow ?? "2026-08-09T00:00:00.000Z";
  const commandExecutor = new FoundationRoiCommandExecutor({
    foundation,
    now: () => clock
  });
  const capabilities: string[] = ["roi.close", "ledger.verify"];
  const repository = new InMemoryRoiClosureRepository();
  const workspace = workspaceContext("workspace-a");
  const cohortId = "cohort-a";
  const hash = (label: string) =>
    `sha256:${createHash("sha256").update(label).digest("hex")}`;
  const closureEvidence = {
    membershipSnapshotHash: hash("membership"),
    attestationSetHash: hash("attestations"),
    factSetHash: hash("facts"),
    costSetHash: hash("costs"),
    allocationSetHash: hash("allocations"),
    settlementSetHash: hash("settlements")
  };
  const reader = {
    async freezeEvidence(input: {
      workspace: ActiveWorkspaceContext;
      cutoff: import("./growth-temporal-barrier.js").GrowthSealedReadCutoff;
      attestations: ClosureAttestation[];
    }) {
      void input;
      const revenueMinor = members.reduce(
        (sum, member) => sum + member.revenueMinor, 0
      );
      const cogsMinor = members.reduce(
        (sum, member) => sum + member.cogsMinor, 0
      );
      const acquisitionCostMinor = members.reduce(
        (sum, member) => sum + member.acquisitionCostMinor, 0
      )
        + (options.sharedCohortCostMinor ?? 0);
      return {
        closureEvidence,
        verifiedRevenueMinor: options.revenueMinor ?? revenueMinor,
        verifiedCogsMinor: options.cogsMinor ?? cogsMinor,
        verifiedRefundMinor: options.refundMinor ?? 0,
        verifiedBadDebtMinor: 0,
        verifiedAcquisitionCostMinor: options.costMinor
          ?? acquisitionCostMinor,
        allCoverageBps: 10000,
        cashReconciled: true,
        members: members.map((member) => ({
          cohortMemberId: member.id,
          ownershipVersionId: `version-${member.id}`,
          firstPlanId: member.firstPlanId
        })),
        verifiedContractWonMinor: options.contractWonMinor ?? 1000,
        allocatedPaymentMinor: options.paymentMinor ?? 900,
        netCashMinor: (options.paymentMinor ?? 900)
          - (options.refundMinor ?? 0)
      };
    }
  };
  const service = new RoiClosureService({
    repository,
    foundation,
    commandExecutor,
    reader,
    now: () => clock
  });
  const context = (key = "closure-0001") => Object.freeze({
    workspace: Object.freeze({
      workspaceId: "workspace-a",
      kind: "team",
      actorId: "finance-a",
      role: "admin",
      teamId: "workspace-a",
      capabilities: capabilities as unknown as readonly string[],
      capabilityRegistryVersion: "growth-capabilities.v1"
    }) as ActiveWorkspaceContext,
    actorId: "finance-a",
    idempotencyKey: key,
    requestHash: canonicalGrowthRequestHash({
      workspaceId: "workspace-a",
      actorId: "finance-a",
      idempotencyKey: key
    }),
    expectedRevision: null
  });
  const evidenceRef = (id: string): ClosureEvidenceRef => ({
    kind: "ledger_entry",
    ledgerType: "financial",
    ledgerEntryId: id,
    evidenceHash: hash(id)
  });
  const attestationInput = {
    cohortId,
    currency,
    aspect: "revenue" as const,
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-08T00:00:00.000Z",
    declaredTotalMinor: 1000,
    sourceSystem: "bank",
    sourceCursor: null,
    sourceReportId: null,
    reportAllocationSetId: null,
    reportHash: hash("report"),
    evidenceRefs: [evidenceRef("rev-a")]
  };
  const attestationIds: string[] = [];
  const createAttestation = async (
    closureService: RoiClosureService,
    commandContext: ReturnType<typeof context>,
    input: typeof attestationInput
  ) => {
    if (Date.parse(input.periodTo) > Date.parse(clock)) {
      throw Object.assign(new Error("invalid_as_of"), {
        code: "invalid_as_of"
      });
    }
    const cutoff = await barrier.sealReadCutoff(
      workspace, input.periodTo
    );
    const attestation = await closureService.createAttestationAt(
      commandContext, input, cutoff
    );
    attestationIds.push(attestation.id);
    return attestation;
  };
  const closeInput = {
    cohortId,
    currency,
    attestationIds
  };
  for (const aspect of [
    "acquisition_cost",
    "revenue",
    "cogs",
    "cash",
    "refund_bad_debt",
    "attribution"
  ] as const) {
    const cutoff = await barrier.sealReadCutoff(
      workspace, "2026-08-08T00:00:00.000Z"
    );
    const attestation = await service.createAttestationAt(
      context(`seed-attestation-${aspect}`),
      {
        ...attestationInput,
        aspect
      },
      cutoff
    );
    attestationIds.push(attestation.id);
  }
  if (options.failFoundationCompletionOncePerMutation) {
    const originalComplete = foundation.httpIdempotency.complete.bind(
      foundation.httpIdempotency
    );
    foundation.httpIdempotency.complete = async (...args) => {
      const [reservationId] = args;
      if (!failedCompletions.has(reservationId as string)) {
        failedCompletions.add(reservationId as string);
        throw new Error("injected_completion_loss");
      }
      return originalComplete(...args);
    };
  }
  return {
    dependencies: {
      repository,
      foundation,
      commandExecutor,
      reader,
      now: () => clock
    },
    service,
    repository,
    workspace,
    foundation,
    cohortId,
    attestationIds,
    attestationInput,
    closeInput,
    context,
    createAttestation,
    close: async (
      closureService: RoiClosureService,
      commandContext: ReturnType<typeof context>,
      input: { cohortId: string; currency: string; asOf: string; attestationIds: string[] }
    ) => {
      const cutoff = await barrier.sealReadCutoff(workspace, input.asOf);
      return closureService.closeAt(commandContext, {
        cohortId: input.cohortId,
        currency: input.currency,
        attestationIds: input.attestationIds
      }, cutoff);
    },
    expireFoundationLease: () => {
      clock = new Date(Date.parse(clock) + 60_000).toISOString();
      transactions.setDatabaseNow(clock);
    },
    revoke: (capability: string) => {
      const index = capabilities.indexOf(capability);
      if (index >= 0) capabilities.splice(index, 1);
    },
    restore: (capability: string) => {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    },
    insertLateVerifiedRefund: async (
      _amountMinor: number,
      _recordedAt: string
    ) => undefined,
    domainCommandRowCounts: async () => ({
      attestations: Math.max(0, await repository.countAttestations() - 6),
      closeOperations: await repository.countCloseOperations(),
      closureVersions: await repository.countClosureVersions(),
      reopenEvents: await repository.countTotalReopenEvents()
    })
  };
}

export function growthPerformanceFixture(options: {
  closures?: Array<{
    id: string;
    version: number;
    asOf: string;
    closedAt?: string;
    status?: "closed" | "superseded";
    roiBps?: number;
  }>;
  members?: Array<{ id: string; firstPlanId: string }>;
  memberSources?: Array<{ cohortMemberId: string; candidateId: string }>;
  quoteCandidateId?: string;
} = {}) {
  const closures = options.closures ?? [];
  const members = options.members ?? [{ id: "member-a", firstPlanId: "plan-a" }];
  const memberSources = options.memberSources ?? [];
  const workspace = workspaceContext("workspace-a");
  const cohortId = "cohort-1";
  const hash = (label: string) =>
    `sha256:${createHash("sha256").update(label).digest("hex")}`;
  const source: GrowthPerformanceDataSource = {
    async listCohortMembersAsOf(
      _workspaceId,
      requestedCohortId,
      planId,
      _cutoff
    ): Promise<GrowthPerformanceQueryPage<
      import("./acquisition-cohort-repository.js").AcquisitionCohortMember
    >> {
      const rows = members
        .filter((member) =>
          requestedCohortId === cohortId
          && (planId === null || member.firstPlanId === planId))
        .map((member) => ({
          id: member.id,
          primaryCandidateId: `candidate-${member.id}`,
          firstPlanId: member.firstPlanId
        }));
      void rows;
      const typedRows = rows as unknown as
        import("./acquisition-cohort-repository.js")
          .AcquisitionCohortMember[];
      return { rows: typedRows, truncated: false };
    },
    async listCohortMemberSourcesAsOf(
      _workspaceId,
      memberIds,
      _cutoff
    ): Promise<GrowthPerformanceQueryPage<
      import("./acquisition-cohort-repository.js")
        .AcquisitionCohortMemberSource
    >> {
      return {
        rows: memberSources.filter((source) =>
          memberIds.includes(source.cohortMemberId)) as unknown as
          import("./acquisition-cohort-repository.js")
            .AcquisitionCohortMemberSource[],
        truncated: false
      };
    },
    async selectPublishedClosure(
      _workspaceId,
      requestedCohortId,
      currency,
      cutoff
    ) {
      const selected = closures
        .filter((closure) =>
          requestedCohortId === cohortId
          && currency === "CNY"
          && (closure.closedAt ?? closure.asOf) <= cutoff.effectiveAsOf)
        .sort((a, b) =>
          (b.closedAt ?? b.asOf).localeCompare(a.closedAt ?? a.asOf)
          || b.version - a.version)[0];
      return selected
        ? {
            closure: Object.freeze({
              id: selected.id,
              workspaceId: "workspace-a",
              cohortId,
              currency,
              version: selected.version,
              asOf: selected.asOf,
              status: selected.status ?? "closed",
              previousClosureVersionId: null,
              formulaVersion: "verified-gross-profit-roi.v1",
              membershipSnapshotHash: hash("membership"),
              attestationSetHash: hash("attestations"),
              factSetHash: hash("facts"),
              costSetHash: hash("costs"),
              allocationSetHash: hash("allocations"),
              settlementSetHash: hash("settlements"),
              closedBy: "finance-a",
              closedAt: selected.closedAt ?? selected.asOf
            }),
            truncated: false
          }
        : null;
    },
    async getExactPublishedClosure(
      _workspaceId,
      requestedCohortId,
      currency,
      closureVersionId,
      cutoff
    ) {
      const closure = closures.find((candidate) =>
        candidate.id === closureVersionId);
      if (!closure) return null;
      const publishedAt = closure.closedAt ?? closure.asOf;
      if (publishedAt > cutoff.effectiveAsOf) return null;
      return {
        closure: Object.freeze({
          id: closure.id,
          workspaceId: "workspace-a",
          cohortId,
          currency,
          version: closure.version,
          asOf: closure.asOf,
          status: closure.status ?? "closed",
          previousClosureVersionId: null,
          formulaVersion: "verified-gross-profit-roi.v1",
          membershipSnapshotHash: hash("membership"),
          attestationSetHash: hash("attestations"),
          factSetHash: hash("facts"),
          costSetHash: hash("costs"),
          allocationSetHash: hash("allocations"),
          settlementSetHash: hash("settlements"),
          closedBy: "finance-a",
          closedAt: publishedAt
        }),
        truncated: false
      };
    },
    async readMaterializedSnapshot(
      _workspaceId,
      closureVersionId,
      sliceKey
    ) {
      const closure = closures.find((candidate) =>
        candidate.id === closureVersionId);
      if (!closure) return null;
      const metrics = closure.roiBps !== undefined
        ? {
            status: "computed" as const,
            verifiedGrossProfitMinor: 1000,
            verifiedAcquisitionCostMinor: 200,
            roiBps: closure.roiBps,
            formulaVersion: "verified-gross-profit-roi.v1"
          }
        : {
            status: "not_computable" as const,
            reason: "cohort_not_closed" as const,
            formulaVersion: "verified-gross-profit-roi.v1" as const
          };
      return Object.freeze({
        closureVersionId,
        sliceKey,
        planId: sliceKey === "all" ? null : sliceKey.slice(5),
        memberCount: members.length,
        memberSetHash: hash("members"),
        computedMetrics: metrics,
        commercialRatios: {
          verifiedContractWonMinor: 1000,
          allocatedPaymentMinor: 900,
          netCashMinor: 900,
          verifiedAcquisitionCostMinor: 200,
          contractRoas: {
            status: "computed",
            bps: 50_000,
            formulaVersion: "contract-roas.v1"
          },
          cashMultiple: {
            status: "computed",
            bps: 45_000,
            formulaVersion: "cash-multiple.v1"
          },
          collectionRate: {
            status: "computed",
            bps: 9_000,
            formulaVersion: "collection-rate.v1"
          }
        },
        commercialAuthoritySetHash: hash("authority"),
        coverage: {
          costCoverageBps: 10000,
          marginCoverageBps: 10000,
          cashCoverageBps: 10000,
          attributionCoverageBps: 10000,
          gapCodes: metrics.status === "computed" ? [] : ["cohort_not_closed"]
        },
        calculationHash: hash("calculation")
      } as unknown as import("./acquisition-roi-closure.js").RoiSnapshot);
    }
  };
  const contributions = {
    async listQuoteContributions(
      _workspaceId: string,
      _candidateIds: string[],
      _currency: string,
      _cutoff: import("./growth-temporal-barrier.js")
        .GrowthSealedReadCutoff
    ) {
      const candidateId = options.quoteCandidateId;
      if (!candidateId) return [];
      return [{
        dealId: "deal-1",
        approvedGrossProfitMinor: 10000,
        closeProbabilityBps: 5000,
        quoteVersionId: "quote-secondary",
        probabilityAssessmentId: "assessment-secondary"
      }];
    }
  };
  const service = new DefaultAcquisitionGrowthPerformanceQueryService(
    source, contributions
  );
  return {
    dependencies: {
      source,
      contributions
    },
    service,
    workspace,
    cohortId,
    seal: (asOf: string) => sealedCutoff(workspace, asOf)
  };
}
