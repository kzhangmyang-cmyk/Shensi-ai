import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import { AcquisitionCostLedgerService, type CreatePendingCostInput } from "./acquisition-cost-ledger.js";
import type { AuthoritativeDealDecisionRef } from
  "./authoritative-quote-reader.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import type { GrowthCapability } from "./growth-capabilities.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { GrowthWorkspaceSettingsReader } from "./growth-workspace-settings.js";
import {
  canonicalGrowthRequestHash,
  InMemoryGrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import {
  type AcquisitionCostEntry,
  type FinancialFact,
  ledgerEntryStatus,
  type LedgerSourceHead,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import {
  RepositoryVerifiedFinancialLedgerSealedReader,
  VerifiedFinancialLedgerAsOfBoundary,
  type VerifiedFinancialLedgerSealedReader
} from "./financial-ledger-as-of-reader.js";
import {
  InMemoryFinancialLedgerRepository,
  type FinancialLedgerTransaction
} from "./financial-ledger-repository.js";
import {
  FinancialFactLedgerService,
  parseCreateFinancialFactInput,
  type CreateFinancialFactInput
} from "./financial-fact-ledger.js";
import { deriveRevenueAndCogs } from "./financial-fact-ledger.js";
import {
  FinanceImportService,
  FinanceImportError,
  type FinanceImportPreviewCommand
} from "./finance-import-service.js";
import {
  InMemoryFinanceImportRepository
} from "./finance-import-repository.js";
import type {
  FinanceImportOperation,
  FinanceImportOperationInput,
  FinanceImportPreviewRecordInput,
  FinanceImportStoredRowInput,
  FinanceImportClaim,
  FinanceImportRowResult
} from "./finance-import-repository.js";
import {
  FinanceImportWorker
} from "./finance-import-worker.js";
import {
  DefaultFinanceImportRecoverySweeper
} from "./finance-import-recovery-sweeper.js";
import type { FinancialFactType } from "./financial-ledger-domain.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import { growthInstantMilliseconds } from "./growth-as-of.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  createGrowthAcquisitionWorkspaceResolver,
  type ActiveWorkspaceContext
} from "./growth-workspace-context.js";
import {
  InMemoryGrowthWorkspaceSettingsReader,
  InMemoryGrowthWorkspaceSettingsRepository
} from "./growth-workspace-settings.js";

const DEFAULT_NOW = "2026-08-09T03:00:00.000Z";

export function ledgerCommandContext(
  workspaceId: string,
  actorId: string,
  idempotencyKey = `ledger-${actorId}-0001`,
  expectedRevision: number | null = null,
  request: {
    method: "POST" | "PATCH";
    canonicalPath: string;
    pathParams: Readonly<Record<string, string>>;
    payload: unknown;
  } = {
    method: "POST",
    canonicalPath: "/test/financial-ledger",
    pathParams: Object.freeze({}),
    payload: Object.freeze({})
  }
): CommandContext {
  return Object.freeze({
    workspace: workspace(workspaceId, actorId),
    actorId,
    idempotencyKey,
    requestHash: canonicalGrowthRequestHash({
      method: request.method,
      canonicalPath: request.canonicalPath,
      pathParams: Object.fromEntries(Object.entries(request.pathParams)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
      payload: request.payload,
      expectedRevision
    }),
    expectedRevision
  });
}

function workspace(workspaceId: string, actorId = "finance-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team" as const,
    actorId,
    role: "admin" as const,
    teamId: workspaceId,
    capabilities: Object.freeze([
      "ledger.pending.create" as const,
      "ledger.verify" as const,
      "roi.close" as const,
      "growth.performance.workspace.read" as const,
      "pricing.sensitive.read" as const
    ]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

export function foundationServicesFixture(
  overrides: Partial<GrowthFoundationServices> & {
    timeZone?: string;
    settingsRevision?: string;
  } = {}
): GrowthFoundationServices {
  const temporalTransactions = overrides.temporalTransactions
    ?? new InMemoryGrowthTemporalTransactionRunner(DEFAULT_NOW);
  const temporalBarrier = overrides.temporalBarrier
    ?? new DefaultGrowthTemporalBarrier(temporalTransactions);
  const acquisitionWorkspace = overrides.acquisitionWorkspace
    ?? createGrowthAcquisitionWorkspaceResolver({
      async resolve(scope) {
        return {
          workspaceId: scope.teamId,
          kind: "team" as const,
          bindingRevision: "fixture.v1"
        };
      }
    });
  const defaultSettings = overrides.timeZone ? {
    "workspace-a": [{
      timeZone: overrides.timeZone,
      revision: overrides.settingsRevision
        ?? "growth-workspace-settings.v1",
      recordedAt: DEFAULT_NOW,
      eventSequence: 1
    }]
  } : undefined;
  return Object.freeze({
    httpIdempotency: overrides.httpIdempotency
      ?? new InMemoryGrowthHttpIdempotencyRepository(),
    workspaceSettings: overrides.workspaceSettings
      ?? new InMemoryGrowthWorkspaceSettingsReader(defaultSettings),
    workspaceContext: overrides.workspaceContext
      ?? ((request: Request) => {
        if (!request.activeWorkspace) throw new Error("workspace_required");
        return request.activeWorkspace;
      }),
    acquisitionWorkspace,
    temporalTransactions,
    temporalBarrier,
    commandContextFactory: overrides.commandContextFactory
      ?? commandContextFromRequest
  });
}

function costEntry(overrides: Partial<AcquisitionCostEntry> = {}): AcquisitionCostEntry {
  return Object.freeze({
    id: "cost-1",
    workspaceId: "workspace-a",
    platform: "douyin",
    planId: null,
    runId: null,
    providerId: null,
    category: "media",
    amountMinor: 10_000,
    currency: "CNY",
    occurredAt: "2026-08-09T01:00:00.000Z",
    provenance: "portal_export",
    sourceRef: "portal://cost-1",
    evidenceHash: "sha256:cost-1",
    externalId: "cost-1",
    sourceIdentityRoot: "external:portal:cost-1",
    sourceVersion: 1,
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    recordedAt: "2026-08-09T01:00:00.000Z",
    temporalSequence: 1,
    correctsCostEntryId: null,
    correctionGroupId: null,
    estimateReconciliationId: null,
    createdBy: "finance-a",
    ...overrides
  });
}

function sourceHead(entry: AcquisitionCostEntry): LedgerSourceHead {
  return Object.freeze({
    workspaceId: entry.workspaceId,
    ledgerType: "cost",
    sourceIdentityRoot: entry.sourceIdentityRoot,
    currentLedgerEntryId: entry.id,
    currentSourceVersion: entry.sourceVersion,
    revision: entry.sourceVersion
  });
}

function verification(
  entry: AcquisitionCostEntry | FinancialFact,
  overrides: Partial<LedgerVerificationEvent> = {}
): LedgerVerificationEvent {
  return Object.freeze({
    id: `verify-${entry.id}`,
    workspaceId: entry.workspaceId,
    ledgerType: "platform" in entry ? "cost" : "financial",
    ledgerEntryId: entry.id,
    eventType: "verified",
    reversesEventId: null,
    eventSequence: 1,
    revision: 2,
    correctionGroupId: null,
    reason: "checked",
    decidedBy: "finance-a",
    recordedAt: "2026-08-09T02:00:00.000Z",
    temporalSequence: 1,
    ...overrides
  });
}

export function verifiedCostLedgerFixture() {
  const entry = costEntry();
  const repository = new TracingFinancialLedgerRepository({
    costEntries: [entry],
    sourceHeads: [sourceHead(entry)],
    verificationEvents: [verification(entry)],
    temporalTails: {
      "workspace-a": {
        lastRecordedAt: "2026-08-09T02:00:00.000Z",
        temporalSequence: 2
      }
    }
  }, DEFAULT_NOW);
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier: new DefaultGrowthTemporalBarrier(repository)
  });
  return {
    entry,
    repository,
    foundation,
    service: new AcquisitionCostLedgerService({ repository, foundation }),
    correctionLockTrace: () => repository.traces.find((trace) =>
      trace.some((item) => item.startsWith("source:"))) ?? []
  };
}

export function twoPendingCostEntriesFixture(ids: readonly string[]) {
  const entries = ids.map((id, index) => costEntry({
    id,
    externalId: id,
    sourceIdentityRoot: `external:portal:${id}`,
    temporalSequence: index + 1
  }));
  const repository = new InMemoryFinancialLedgerRepository({
    costEntries: entries,
    sourceHeads: entries.map(sourceHead),
    temporalTails: {
      "workspace-a": { lastRecordedAt: DEFAULT_NOW, temporalSequence: entries.length }
    }
  }, DEFAULT_NOW);
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier: new DefaultGrowthTemporalBarrier(repository)
  });
  const service = new AcquisitionCostLedgerService({ repository, foundation });
  return {
    service,
    async status(id: string) {
      const events = await repository.listVerificationEvents("workspace-a", "cost", id);
      return ledgerEntryStatus(events);
    }
  };
}

class TracingFinancialLedgerRepository extends InMemoryFinancialLedgerRepository {
  readonly traces: string[][] = [];

  override async transaction<T>(work: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    const trace: string[] = [];
    this.traces.push(trace);
    return super.transaction((tx) => work({
      ...tx,
      lockWorkspaceTemporalBarrierForUpdate: async (workspaceId) => {
        trace.push(`temporal:${workspaceId}`);
        return tx.lockWorkspaceTemporalBarrierForUpdate(workspaceId);
      },
      getSourceHeadForUpdate: async (workspaceId, ledgerType, sourceIdentityRoot) => {
        trace.push(`source:${ledgerType}:${sourceIdentityRoot}`);
        return tx.getSourceHeadForUpdate(workspaceId, ledgerType, sourceIdentityRoot);
      },
      getCostEntryForUpdate: async (workspaceId, id) => {
        trace.push(`entry:cost:${id}`);
        return tx.getCostEntryForUpdate(workspaceId, id);
      },
      listVerificationEventsForUpdate: async (workspaceId, ledgerType, entryId) => {
        trace.push(`events:${ledgerType}:${entryId}`);
        return tx.listVerificationEventsForUpdate(workspaceId, ledgerType, entryId);
      }
    }));
  }
}

export function financeTemporalBarrierFixture(input: {
  workspaceId: string;
  databaseNow: string;
}) {
  const repository = new TracingFinancialLedgerRepository({}, input.databaseNow);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(repository);
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier
  });
  const service = new AcquisitionCostLedgerService({ repository, foundation });
  const newCostInput = (
    overrides: Partial<CreatePendingCostInput> = {}
  ): CreatePendingCostInput => ({
    platform: "douyin",
    planId: null,
    runId: null,
    providerId: null,
    category: "media",
    amountMinor: 10_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T08:00:00.000Z",
    provenance: "portal_export",
    sourceRef: "portal://new-cost",
    evidenceHash: "sha256:new-cost",
    externalId: "new-cost",
    sourceIdentityRoot: "external:portal:new-cost",
    estimateReconciliationId: null,
    ...overrides
  });
  return {
    repository,
    foundation,
    service,
    workspace: workspace(input.workspaceId),
    sealedReader: new RepositoryVerifiedFinancialLedgerSealedReader(repository),
    setDatabaseNow: (value: string) => repository.setDatabaseNow(value),
    newCostInput,
    firstBusinessLockTrace: () => repository.traces.find((trace) =>
      trace.some((item) => item.startsWith("source:")))?.slice(0, 2) ?? []
  };
}

const attributionSnapshot: OutcomeAttributionInput = Object.freeze({
  attributionVersion: "acquisition-run.v1",
  runId: "run-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  planVersion: 1,
  planSnapshotHash: "sha256:plan",
  discoveredEventId: "discovered-1",
  discoveredAt: "2026-08-01T00:00:00.000Z",
  shardId: "shard-1",
  operationId: "operation-1",
  connectionId: "connection-1",
  providerId: "provider-1",
  evidenceIds: ["evidence-1"],
  providerIds: ["provider-1"],
  queryIds: ["query-1"],
  strategyVersion: "strategy-1",
  qualificationDecisionId: "qualification-1",
  decisionVersion: "decision-1",
  decisionSnapshotHash: "sha256:decision"
});

function bindingSnapshot(
  bindingHash?: string
): CommercialBindingSnapshot {
  const base = {
    candidateId: "candidate-1",
    handoffId: "handoff-1",
    leadId: "lead-1",
    customerId: "customer-1",
    dealId: "deal-1",
    candidateVersion: 1,
    handoffContentHash: "sha256:handoff" as `sha256:${string}`,
    dealContentHash: "sha256:deal" as `sha256:${string}`,
    bindingHashSchemaVersion: "commercial-binding.v1" as const,
    attributionSnapshot
  };
  const computedHash = `sha256:${createHash("sha256")
    .update(canonicalJsonStringify({
      customerId: base.customerId,
      handoffContentHash: base.handoffContentHash,
      dealContentHash: base.dealContentHash,
      bindingHashSchemaVersion: base.bindingHashSchemaVersion
    }) ?? "")
    .digest("hex")}` as `sha256:${string}`;
  return Object.freeze({
    ...base,
    bindingHash: (bindingHash ?? computedHash) as `sha256:${string}`,
    verifiedAt: "2026-08-09T01:00:00.000Z"
  });
}

function financialFact(overrides: Partial<FinancialFact> = {}): FinancialFact {
  return Object.freeze({
    id: "refund-1",
    workspaceId: "workspace-a",
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    quoteVersionId: "quote-1",
    factType: "refund",
    amountMinor: 10_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    recordedAt: "2026-08-09T01:00:00.000Z",
    temporalSequence: 1,
    provenance: "invoice_confirmed",
    sourceRef: "invoice://refund-1",
    evidenceHash: "sha256:refund-evidence",
    externalId: "refund-1",
    sourceIdentityRoot: "external:invoice:refund-1",
    sourceVersion: 1,
    attributionSnapshot,
    commercialBindingSnapshot: bindingSnapshot(),
    commercialAmountHash: "sha256:commercial-1",
    dealAuthorityRevision: 1,
    correctsFactId: null,
    correctionGroupId: null,
    createdBy: "finance-a",
    ...overrides
  });
}

function readerFor(initial: {
  costs?: readonly AcquisitionCostEntry[];
  facts?: readonly FinancialFact[];
  events?: readonly LedgerVerificationEvent[];
}) {
  const repository = new InMemoryFinancialLedgerRepository({
    costEntries: initial.costs,
    financialFacts: initial.facts,
    verificationEvents: initial.events
  }, DEFAULT_NOW);
  const runner = new InMemoryGrowthTemporalTransactionRunner(DEFAULT_NOW);
  const foundation = foundationServicesFixture({
    temporalTransactions: runner,
    temporalBarrier: new DefaultGrowthTemporalBarrier(runner)
  });
  const sealedReader = new RepositoryVerifiedFinancialLedgerSealedReader(repository);
  const reader = new VerifiedFinancialLedgerAsOfBoundary({
    foundation,
    sealedReader,
    now: () => DEFAULT_NOW
  });
  return { repository, foundation, sealedReader, reader };
}

export function verifiedLedgerAsOfFixture(options: {
  sameIdAcrossLedgerTypes?: string;
  verificationRecordedAt?: string;
} = {}) {
  const id = options.sameIdAcrossLedgerTypes ?? "cost-1";
  const cost = costEntry({ id, externalId: id, sourceIdentityRoot: `external:portal:${id}` });
  const fact = financialFact({ id, externalId: id, sourceIdentityRoot: `external:invoice:${id}` });
  const verifiedAt = options.verificationRecordedAt ?? "2026-08-09T02:00:00.000Z";
  const costVerification = verification(cost, { recordedAt: verifiedAt });
  const reversal = verification(cost, {
    id: `reverse-${id}`,
    eventType: "reversed",
    reversesEventId: costVerification.id,
    eventSequence: 2,
    revision: 3,
    recordedAt: "2026-08-09T04:00:00.000Z"
  });
  const events: LedgerVerificationEvent[] = options.sameIdAcrossLedgerTypes
    ? [costVerification, verification(fact, { recordedAt: verifiedAt })]
    : [costVerification, reversal];
  const state = readerFor({
    costs: [cost],
    facts: options.sameIdAcrossLedgerTypes ? [fact] : [],
    events
  });
  return {
    ...state,
    workspace: workspace("workspace-a"),
    otherWorkspace: workspace("workspace-b"),
    appendVerification: (_input: { recordedAt: string }) => undefined,
    appendReversal: (_input: { recordedAt: string }) => undefined
  };
}

export function verifiedFinancialFactAsOfFixture(input: {
  factType: FinancialFact["factType"];
  candidateId: string | null;
  customerId: string | null;
  dealId: string | null;
  quoteVersionId: string | null;
  evidenceHash: string;
  commercialBindingHash: string | null;
  commercialAmountHash: string | null;
}) {
  const fact = financialFact({
    ...input,
    commercialBindingSnapshot: input.commercialBindingHash === null
      ? null : bindingSnapshot(input.commercialBindingHash)
  });
  const state = readerFor({ facts: [fact], events: [verification(fact)] });
  return { ...state, workspace: workspace("workspace-a") };
}

export function financialFactProjectionFixture() {
  const fact = financialFact();
  return { fact, verification: verification(fact) };
}

export function financialFactFixture(options: {
  factType?: FinancialFact["factType"];
  dealDecision?: AuthoritativeDealDecisionRef | null;
  status?: "pending" | "verified" | "rejected" | "reversed";
  revision?: number;
} = {}) {
  const formalBinding = bindingSnapshot();
  const defaultDecision: AuthoritativeDealDecisionRef = Object.freeze({
    type: "won",
    dealId: "deal-1",
    quoteCaseId: "case-1",
    quoteVersionId: "quote-1",
    currency: "CNY",
    quotedAmountMinor: 298_000,
    commercialAmountHash: "sha256:commercial-1",
    commercialBindingEvidence: Object.freeze({
      candidateId: formalBinding.candidateId,
      customerId: formalBinding.customerId,
      dealId: formalBinding.dealId,
      handoffContentHash: formalBinding.handoffContentHash,
      dealContentHash: formalBinding.dealContentHash,
      bindingHashSchemaVersion: formalBinding.bindingHashSchemaVersion,
      bindingHash: formalBinding.bindingHash
    }),
    commercialBindingSnapshot: formalBinding,
    authorityRevision: 3,
    decidedAt: "2026-08-08T00:00:00.000Z"
  });
  const decision = options.dealDecision === undefined
    ? defaultDecision : options.dealDecision;
  let currentBinding: CommercialBindingSnapshot = Object.freeze({
    ...formalBinding,
    verifiedAt: "2026-08-09T02:00:00.000Z"
  });
  const factType = options.factType ?? "refund";
  const input: CreateFinancialFactInput = Object.freeze({
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    factType,
    amountMinor: factType === "contract_won" ? 298_000 : 50_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z",
    provenance: "invoice_confirmed",
    sourceRef: "invoice:1",
    evidenceHash: "sha256:invoice-1",
    externalId: "invoice-1",
    sourceIdentityRoot: "external:invoice:invoice-1"
  });
  const replacement: CreateFinancialFactInput = Object.freeze({
    ...input,
    businessOccurredAt: "2026-08-08T01:00:00.000Z",
    evidenceHash: "sha256:invoice-corrected",
    sourceRef: "invoice:corrected"
  });
  const seededFact = financialFact({
    id: "fact-1",
    factType,
    amountMinor: input.amountMinor,
    currency: input.currency,
    businessOccurredAt: input.businessOccurredAt,
    provenance: input.provenance,
    sourceRef: input.sourceRef,
    evidenceHash: input.evidenceHash,
    externalId: input.externalId,
    sourceIdentityRoot: input.sourceIdentityRoot,
    commercialBindingSnapshot: formalBinding,
    attributionSnapshot: formalBinding.attributionSnapshot,
    quoteVersionId: defaultDecision.quoteVersionId,
    commercialAmountHash: defaultDecision.commercialAmountHash,
    dealAuthorityRevision: defaultDecision.authorityRevision
  });
  const status = options.status ?? "pending";
  const seededEvents: LedgerVerificationEvent[] = [];
  if (status !== "pending") {
    seededEvents.push(verification(seededFact, {
      eventType: status === "rejected" ? "rejected" : "verified"
    }));
  }
  if (status === "reversed") {
    seededEvents.push(verification(seededFact, {
      id: "reverse-fact-1",
      eventType: "reversed",
      reversesEventId: seededEvents[0]!.id,
      eventSequence: 2,
      revision: 3,
      recordedAt: "2026-08-09T02:30:00.000Z",
      temporalSequence: 2
    }));
  }
  const expectedRevision = status === "pending" ? 1
    : status === "reversed" ? 3 : 2;
  if (options.revision !== undefined && options.revision !== expectedRevision) {
    throw new Error("financial_fact_fixture_revision_mismatch");
  }
  const repository = new InMemoryFinancialLedgerRepository({
    financialFacts: options.status ? [seededFact] : [],
    sourceHeads: options.status ? [{
      workspaceId: seededFact.workspaceId,
      ledgerType: "financial",
      sourceIdentityRoot: seededFact.sourceIdentityRoot,
      currentLedgerEntryId: seededFact.id,
      currentSourceVersion: 1,
      revision: 1
    }] : [],
    verificationEvents: options.status ? seededEvents : [],
    temporalTails: options.status ? {
      "workspace-a": {
        lastRecordedAt: status === "reversed"
          ? "2026-08-09T02:30:00.000Z"
          : "2026-08-09T02:00:00.000Z",
        temporalSequence: status === "reversed" ? 2 : 1
      }
    } : {}
  }, DEFAULT_NOW);
  let seals = 0;
  let lastCutoff: GrowthSealedReadCutoff | null = null;
  class CountingBarrier extends DefaultGrowthTemporalBarrier {
    override async sealReadCutoff(
      context: ActiveWorkspaceContext,
      effectiveAsOf: string
    ) {
      seals += 1;
      lastCutoff = await super.sealReadCutoff(context, effectiveAsOf);
      return lastCutoff;
    }
  }
  const temporalBarrier = new CountingBarrier(repository);
  const foundation = foundationServicesFixture({
    temporalTransactions: repository,
    temporalBarrier
  });
  const quoteCutoffs: GrowthSealedReadCutoff[] = [];
  const service = new FinancialFactLedgerService({
    repository,
    foundation,
    now: () => DEFAULT_NOW,
    requestExecutionId: () => "financial-fact-fixture-execution",
    bindingVerifier: {
      async verify() { return currentBinding; }
    },
    dealQuoteReader: {
      async getDecisionAt(_context, _dealId, cutoff) {
        quoteCutoffs.push(cutoff);
        return decision;
      }
    }
  });
  const command = ledgerCommandContext("workspace-a", "finance-a");
  return {
    service,
    repository,
    foundation,
    workspace: workspace("workspace-a"),
    command,
    commandWith(overrides: {
      idempotencyKey?: string;
      expectedRevision?: number | null;
    }) {
      return ledgerCommandContext(
        "workspace-a",
        "finance-a",
        overrides.idempotencyKey ?? command.idempotencyKey,
        overrides.expectedRevision ?? null
      );
    },
    input,
    replacement,
    fact: seededFact,
    dealDecision: decision,
    currentBinding: () => currentBinding,
    replaceCurrentBinding(overrides: Partial<CommercialBindingSnapshot>) {
      currentBinding = Object.freeze({ ...currentBinding, ...overrides });
    },
    parseCreateBody: parseCreateFinancialFactInput,
    foundationSealCallCount: () => seals,
    lastFoundationCutoff: () => lastCutoff,
    quoteReaderCutoffs: () => [...quoteCutoffs],
    issueCutoff: (workspaceId: string) => temporalBarrier.sealReadCutoff(
      workspace(workspaceId), DEFAULT_NOW
    ),
    async snapshotCounts() {
      const facts = await repository.listFinancialFacts("workspace-a");
      const eventCounts = await Promise.all(facts.map((fact) =>
        repository.listVerificationEvents(
          "workspace-a", "financial", fact.id
        ).then((events) => events.length)));
      return { facts: facts.length,
        events: eventCounts.reduce((sum, count) => sum + count, 0) };
    }
  };
}

export function verifiedLedgerReaderBoundaryFixture(options: {
  serverNow?: string;
  duplicateEntryInWorkspace?: string;
} = {}) {
  const costA = costEntry();
  const costs = [costA];
  const events = [verification(costA)];
  if (options.duplicateEntryInWorkspace) {
    const duplicate = costEntry({ workspaceId: options.duplicateEntryInWorkspace });
    costs.push(duplicate);
    events.push(verification(duplicate));
  }
  const repository = new InMemoryFinancialLedgerRepository({
    costEntries: costs,
    verificationEvents: events
  }, options.serverNow ?? DEFAULT_NOW);
  const runner = new InMemoryGrowthTemporalTransactionRunner(options.serverNow ?? DEFAULT_NOW);
  const baseBarrier = new DefaultGrowthTemporalBarrier(runner);
  let seals = 0;
  let lastEffectiveAsOf: string | null = null;
  let lastCutoff: GrowthSealedReadCutoff | null = null;
  const countingBarrier: GrowthTemporalBarrier = {
    allocateAppend: (tx, workspaceId) => baseBarrier.allocateAppend(tx, workspaceId),
    async sealReadCutoff(context, effectiveAsOf) {
      seals += 1;
      lastEffectiveAsOf = effectiveAsOf;
      lastCutoff = await baseBarrier.sealReadCutoff(context, effectiveAsOf);
      return lastCutoff;
    }
  };
  const actualSealed = new RepositoryVerifiedFinancialLedgerSealedReader(repository);
  let delegateCalls = 0;
  let delegateCutoff: GrowthSealedReadCutoff | null = null;
  const delegate: VerifiedFinancialLedgerSealedReader = {
    async getVerifiedAt(cutoff, input) {
      delegateCalls += 1;
      delegateCutoff = cutoff;
      return actualSealed.getVerifiedAt(cutoff, input);
    },
    async listVerifiedCostsAt(cutoff, input) {
      delegateCalls += 1;
      delegateCutoff = cutoff;
      return actualSealed.listVerifiedCostsAt(cutoff, input);
    },
    async listVerifiedFactsAt(cutoff, input) {
      delegateCalls += 1;
      delegateCutoff = cutoff;
      return actualSealed.listVerifiedFactsAt(cutoff, input);
    }
  };
  const foundation = foundationServicesFixture({
    temporalTransactions: runner,
    temporalBarrier: countingBarrier
  });
  const publicReader = new VerifiedFinancialLedgerAsOfBoundary({
    foundation,
    sealedReader: delegate,
    now: () => options.serverNow ?? DEFAULT_NOW
  });
  return {
    workspace: workspace("workspace-a"),
    publicReader,
    sealedReader: actualSealed,
    seal: (workspaceId: string, asOf: string) =>
      baseBarrier.sealReadCutoff(workspace(workspaceId), asOf),
    sealCallCount: () => seals,
    lastFoundationEffectiveAsOf: () => lastEffectiveAsOf,
    lastDelegateCutoff: () => delegateCutoff,
    foundationCutoff: () => lastCutoff,
    delegateCallCount: () => delegateCalls,
    internalSealCallCount: () => 0,
    foundationIssuedInvalidAllToken: () => Object.freeze({
      workspaceId: "all",
      effectiveAsOf: DEFAULT_NOW,
      temporalSequence: 1
    }) as GrowthSealedReadCutoff
  };
}

export interface FinancePreviewFixtureOptions {
  previews?: string[];
  createdBy?: string;
  financialRows?: Array<{
    externalId: string;
    revenueMinor: number;
    grossProfitMinor: number;
  }>;
  businessOccurredAt?: string;
  timeZone?: string;
  settingsRevision?: string;
  pauseAfterSeal?: boolean;
  physicalConnections?: number;
  wonQuote?: AuthoritativeDealDecisionRef | null;
  currentBinding?: CommercialBindingSnapshot | null;
}

export function financePreviewFixture(
  options: FinancePreviewFixtureOptions = {}
) {
  const ledgerRepository = new InMemoryFinancialLedgerRepository(
    {}, DEFAULT_NOW
  );
  const transactions = new InMemoryGrowthTemporalTransactionRunner(DEFAULT_NOW);
  const baseBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const settingsRepository = new InMemoryGrowthWorkspaceSettingsRepository(
    transactions,
    baseBarrier,
    options.timeZone ? {
      "workspace-a": [{
        timeZone: options.timeZone,
        revision: options.settingsRevision
          ?? "growth-workspace-settings.v1",
        recordedAt: DEFAULT_NOW,
        eventSequence: 1
      }]
    } : {}
  );
  const getAtTokens: GrowthSealedReadCutoff[] = [];
  const previewCutoffs: GrowthSealedReadCutoff[] = [];
  let currentGetCalls = 0;
  let seals = 0;
  let lastCutoff: GrowthSealedReadCutoff | null = null;
  let releaseGate: (() => void) | null = null;
  let gatePromise: Promise<void> | null = null;
  let pausedOnce = false;
  let resolveFirstSeal: (() => void) | null = null;
  const firstSealPromise = new Promise<void>((resolve) => {
    resolveFirstSeal = resolve;
  });
  class CountingPreviewBarrier extends DefaultGrowthTemporalBarrier {
    override async sealReadCutoff(
      context: ActiveWorkspaceContext,
      effectiveAsOf: string
    ) {
      const token = await super.sealReadCutoff(context, effectiveAsOf);
      seals += 1;
      lastCutoff = token;
      previewCutoffs.push(token);
      if (seals === 1) resolveFirstSeal?.();
      if (options.pauseAfterSeal && !pausedOnce) {
        pausedOnce = true;
        gatePromise = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      }
      if (options.pauseAfterSeal && gatePromise) await gatePromise;
      return token;
    }
  }
  const countingBarrier = new CountingPreviewBarrier(transactions);
  const settingsReader: GrowthWorkspaceSettingsReader = {
    async get(context) {
      currentGetCalls += 1;
      return settingsRepository.get(context);
    },
    async getAt(context, cutoff) {
      getAtTokens.push(cutoff);
      return settingsRepository.getAt(context, cutoff);
    }
  };
  const sealSnapshots = new Map<string, number>();
  const commandOrder: string[] = [];
  let clock = growthInstantMilliseconds(DEFAULT_NOW);
  const now = () => new Date(clock += 1).toISOString();
  let deriveCalls = 0;
  const countingDerive = ((
    input: { revenueMinor: number | null; grossProfitMinor: number | null }
  ) => {
    deriveCalls += 1;
    return deriveRevenueAndCogs(input);
  }) as typeof deriveRevenueAndCogs;
  const capabilityLists = new Map<string, GrowthCapability[]>();
  function capabilitiesFor(actorId: string): readonly GrowthCapability[] {
    let capabilities = capabilityLists.get(actorId);
    if (!capabilities) {
      capabilities = [
        "ledger.pending.create" as const,
        "ledger.verify" as const,
        "roi.close" as const,
        "growth.performance.workspace.read" as const,
        "pricing.sensitive.read" as const
      ];
      capabilityLists.set(actorId, capabilities);
    }
    return capabilities;
  }
  let wonDecision = options.wonQuote ?? null;
  let currentBinding = options.currentBinding
    ?? (options.wonQuote
      ? Object.freeze({
          ...options.wonQuote.commercialBindingSnapshot,
          verifiedAt: "2026-08-09T02:00:00.000Z"
        })
      : null);
  const quoteCutoffs: GrowthSealedReadCutoff[] = [];
  const quoteReaderSeals = 0;
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: countingBarrier,
    workspaceSettings: settingsReader
  });
  const repository = new InMemoryFinanceImportRepository(
    transactions, countingBarrier
  );
  const service = new FinanceImportService({
    repository,
    foundation,
    now,
    derive: countingDerive,
    bindingVerifier: {
      async verify() {
        if (!currentBinding) {
          throw new Error("commercial_binding_authority_mismatch");
        }
        return currentBinding;
      }
    },
    dealQuoteReader: {
      async getDecisionAt(_context, _dealId, cutoff) {
        quoteCutoffs.push(cutoff);
        return wonDecision;
      }
    }
  });
  function workspaceFor(
    actorId: string,
    workspaceId = "workspace-a"
  ): ActiveWorkspaceContext {
    return Object.freeze({
      workspaceId,
      kind: "team" as const,
      actorId,
      role: "admin" as const,
      teamId: workspaceId,
      capabilities: capabilitiesFor(actorId),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
  }
  function buildCommand(overrides?: string | Partial<{
    actorId: string;
    idempotencyKey: string;
    expectedRevision: number | null;
    method: string;
    canonicalPath: string;
    pathParams: Readonly<Record<string, string>>;
    payload: unknown;
  }>): CommandContext {
    const key = typeof overrides === "string"
      ? overrides : overrides?.idempotencyKey ?? "finance-preview-0001";
    commandOrder.push(key);
    sealSnapshots.set(key, seals);
    const actorId = typeof overrides === "object"
      ? overrides.actorId ?? "finance-a" : "finance-a";
    const method = typeof overrides === "object"
      ? overrides.method ?? "POST" : "POST";
    const canonicalPath = typeof overrides === "object"
      ? overrides.canonicalPath ?? "/api/v1/finance/imports/preview"
      : "/api/v1/finance/imports/preview";
    const pathParams = typeof overrides === "object"
      ? overrides.pathParams ?? Object.freeze({})
      : Object.freeze({});
    const payload = typeof overrides === "object"
      ? overrides.payload ?? Object.freeze({}) : Object.freeze({});
    const expectedRevision = typeof overrides === "object"
      ? overrides.expectedRevision ?? null : null;
    return Object.freeze({
      workspace: workspaceFor(actorId),
      actorId,
      idempotencyKey: key,
      requestHash: canonicalGrowthRequestHash({
        method,
        canonicalPath,
        pathParams: Object.fromEntries(
          Object.entries(pathParams).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0)
        ),
        payload,
        expectedRevision
      }),
      expectedRevision
    });
  }
  function buildInput(overrides: {
    businessOccurredAt?: string;
    amountMinor?: number;
    currency?: string;
  } = {}): FinanceImportPreviewCommand {
    const rows = options.financialRows ?? [{
      externalId: "fact-1", revenueMinor: 1000, grossProfitMinor: 400
    }];
    const businessOccurredAt = overrides.businessOccurredAt
      ?? options.businessOccurredAt ?? "2026-08-09";
    const csv = [
      "externalId,factType,amount,currency,businessOccurredAt,provenance,revenue,grossProfit,status",
      ...rows.map((row) => {
        const amount = overrides.amountMinor !== undefined
          ? (overrides.amountMinor / 100).toFixed(2)
          : (row.revenueMinor / 100).toFixed(2);
        const currency = overrides.currency ?? "CNY";
        const formatMinor = (value: number) => (value < 0 ? "\u2212" : "")
          + (Math.abs(value) / 100).toFixed(2);
        const revenue = formatMinor(row.revenueMinor);
        const grossProfit = formatMinor(row.grossProfitMinor);
        return `${row.externalId},revenue_recognized,${amount},${currency},${businessOccurredAt},derived_from_import,${revenue},${grossProfit},pending`;
      })
    ].join("\n");
    return Object.freeze({
      kind: "financial_fact",
      fileName: "facts.csv",
      mediaType: "text/csv",
      content: Buffer.from(csv),
      mapping: Object.freeze({
        externalId: "externalId",
        factType: "factType",
        amount: "amount",
        currency: "currency",
        businessOccurredAt: "businessOccurredAt",
        provenance: "provenance",
        revenue: "revenue",
        grossProfit: "grossProfit",
        status: "status"
      })
    });
  }
  const baseCommand = buildCommand();
  const baseInput = buildInput();
  const command = Object.assign(
    buildCommand,
    baseCommand
  ) as CommandContext & ((overrides?: Parameters<typeof buildCommand>[0])
    => CommandContext);
  const input = Object.assign(
    buildInput,
    baseInput
  ) as FinanceImportPreviewCommand & ((
    overrides?: Parameters<typeof buildInput>[0]
  ) => FinanceImportPreviewCommand);
  const previewIds = options.previews ?? ["preview-1"];
  for (const previewId of previewIds) {
    repository.seedPreview({
      id: previewId,
      workspaceId: "workspace-a",
      createdBy: options.createdBy ?? "finance-a",
      previewRequestHash: canonicalGrowthRequestHash({
        workspaceId: "workspace-a",
        previewId
      }),
      fileHash: "sha256:seeded-preview",
      templateVersion: "finance-fact-import.v1",
      kind: "financial_fact",
      resolvedTimeZone: "Asia/Shanghai",
      workspaceSettingsRevision: "settings-1",
      workspaceSettingsRecordedAt: DEFAULT_NOW,
      workspaceSettingsEventSequence: 1,
      validRows: 1,
      invalidRows: 0,
      authorityEffectiveAsOf: DEFAULT_NOW,
      authorityTemporalSequence: 1
    }, [{
      id: `row-${previewId}-1`,
      previewId,
      rowNumber: 1,
      sheetName: "CSV",
      status: "valid",
      sourceIdentityRoot: `finance-import-row:${previewId}`,
      normalized: {
        kind: "financial_fact",
        candidateId: null,
        customerId: null,
        dealId: null,
        currency: "CNY",
        businessOccurredAt: "2026-08-08T16:00:00.000Z",
        externalId: "fact-1",
        evidenceHash: "sha256:seeded-row",
        derivedFacts: [{
          factType: "revenue_recognized",
          amountMinor: 100000
        }],
        authoritativeDecision: null
      },
      errors: []
    }]);
  }
  return {
    service,
    repository,
    foundation,
    workspace: workspaceFor("finance-a"),
    command,
    input,
    previewId: previewIds[0]!,
    previewIds,
    countLedgerRows: async () =>
      (await ledgerRepository.listFinancialFacts("workspace-a")).length,
    dealDecision: () => wonDecision,
    deriveHelperCallCount: () => deriveCalls,
    foundationSealCallCount: () => seals,
    previewSealCallCount: (key: string) => {
      const start = sealSnapshots.get(key) ?? 0;
      const index = commandOrder.indexOf(key);
      const end = index >= 0 && index + 1 < commandOrder.length
        ? sealSnapshots.get(commandOrder[index + 1]!) ?? seals
        : seals;
      return end - start;
    },
    lastFoundationCutoff: () => lastCutoff,
    previewCutoffs: () => [...previewCutoffs],
    quoteReaderCutoffs: () => [...quoteCutoffs],
    quoteReaderSealCallCount: () => quoteReaderSeals,
    workspaceSettingsGetAtTokens: () => [...getAtTokens],
    workspaceSettingsCurrentGetCallCount: () => currentGetCalls,
    waitForPreviewSeal: () => firstSealPromise,
    releasePreviewAfterSeal: () => {
      releaseGate?.();
      releaseGate = null;
      gatePromise = null;
    },
    appendWorkspaceSettingsOnConnectionB: (input: {
      timeZone: string;
      revision: string;
    }) => settingsRepository.appendTrustedSettingsEvent(
      "workspace-a", input
    ),
    revoke: (actorId: string, capability: string) => {
      const capabilities = capabilityLists.get(actorId);
      const index = capabilities?.indexOf(
        capability as GrowthCapability
      ) ?? -1;
      if (index >= 0) capabilities!.splice(index, 1);
    },
    replaceCurrentBinding: (overrides: Partial<CommercialBindingSnapshot>) => {
      if (!currentBinding) throw new Error("won_authority_required");
      currentBinding = Object.freeze({ ...currentBinding, ...overrides });
    },
    currentBinding: () => currentBinding,
    setWonQuote: (decision: AuthoritativeDealDecisionRef | null) => {
      wonDecision = decision;
    }
  };
}

export function contractWonImportFixture(options: {
  rows?: number;
  wonQuote?: AuthoritativeDealDecisionRef | null;
} = {}) {
  const state = financePreviewFixture({
    wonQuote: options.wonQuote ?? wonQuoteFixture()
  });
  const rows = options.rows ?? 1;
  const wonQuote = options.wonQuote ?? wonQuoteFixture();
  state.setWonQuote(wonQuote);
  if (!state.currentBinding()) {
    state.replaceCurrentBinding({
      ...wonQuote.commercialBindingSnapshot
    });
  }
  return {
    ...state,
    input(overrides: {
      amountMinor?: number;
      currency?: string;
    } = {}): FinanceImportPreviewCommand {
      const amountMinor = overrides.amountMinor ?? 298_000;
      const currency = overrides.currency ?? "CNY";
      const csv = [
        "externalId,factType,amount,currency,businessOccurredAt,provenance,status,candidateId,customerId,dealId",
        ...Array.from({ length: rows }, (_, index) =>
          `contract-${index + 1},contract_won,${(amountMinor / 100).toFixed(2)},${currency},2026-08-09,portal_export,pending,candidate-1,customer-1,deal-1`)
      ].join("\n");
      return Object.freeze({
        kind: "financial_fact",
        fileName: "facts.csv",
        mediaType: "text/csv",
        content: Buffer.from(csv),
        mapping: Object.freeze({
          externalId: "externalId",
          factType: "factType",
          amount: "amount",
          currency: "currency",
          businessOccurredAt: "businessOccurredAt",
          provenance: "provenance",
          revenue: "revenue",
          grossProfit: "grossProfit",
          status: "status",
          candidateId: "candidateId",
          customerId: "customerId",
          dealId: "dealId"
        })
      });
    }
  };
}

export function wonQuoteFixture(): AuthoritativeDealDecisionRef {
  const snapshot = Object.freeze({
    candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
    customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
    handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
    bindingHashSchemaVersion: "commercial-binding.v1",
    attributionSnapshot: Object.freeze({
      attributionVersion: "acquisition-run.v1",
      runId: "run-1",
      planId: "plan-1",
      planVersionId: "plan-version-1",
      planVersion: 1,
      planSnapshotHash: "sha256:plan",
      discoveredEventId: "discovered-1",
      discoveredAt: "2026-08-01T00:00:00.000Z",
      shardId: "shard-1",
      operationId: "operation-1",
      connectionId: "connection-1",
      providerId: "provider-1",
      evidenceIds: ["evidence-1"],
      providerIds: ["provider-1"],
      queryIds: ["query-1"],
      strategyVersion: "strategy-1",
      qualificationDecisionId: "qualification-1",
      decisionVersion: "decision-1",
      decisionSnapshotHash: "sha256:decision"
    }),
    verifiedAt: "2026-08-08T02:00:00.000Z"
  });
  const bindingHash = `sha256:${createHash("sha256")
    .update(canonicalJsonStringify({
      customerId: snapshot.customerId,
      handoffContentHash: snapshot.handoffContentHash,
      dealContentHash: snapshot.dealContentHash,
      bindingHashSchemaVersion: snapshot.bindingHashSchemaVersion
    }) ?? "")
    .digest("hex")}`;
  const fullSnapshot = Object.freeze({
    ...snapshot,
    bindingHash
  }) as CommercialBindingSnapshot;
  const evidence = Object.freeze({
    candidateId: fullSnapshot.candidateId,
    customerId: fullSnapshot.customerId,
    dealId: fullSnapshot.dealId,
    handoffContentHash: fullSnapshot.handoffContentHash,
    dealContentHash: fullSnapshot.dealContentHash,
    bindingHashSchemaVersion: fullSnapshot.bindingHashSchemaVersion,
    bindingHash: fullSnapshot.bindingHash
  });
  return Object.freeze({
    type: "won",
    dealId: "deal-1",
    quoteCaseId: "case-1",
    quoteVersionId: "quote-1",
    currency: "CNY",
    quotedAmountMinor: 298_000,
    commercialAmountHash: "sha256:commercial-1",
    commercialBindingEvidence: evidence,
    commercialBindingSnapshot: fullSnapshot,
    authorityRevision: 3,
    decidedAt: "2026-08-08T00:00:00.000Z"
  });
}

export interface CreateFinanceImportFixtureOptions {
  rows?: number;
  factType?: FinancialFactType;
  amountMinor?: number;
  currency?: string;
  wonQuote?: AuthoritativeDealDecisionRef | null;
  status?: "queued" | "running";
  expiredOwner?: string;
  operations?: string[];
  requestingActorId?: string;
  revenueMinor?: number;
  grossProfitMinor?: number;
  bypassPreviewForCommitIntegrityTest?: boolean;
}

export async function createFinanceImportFixture(
  options: CreateFinanceImportFixtureOptions = {}
) {
  const ledgerRepository = new InMemoryFinancialLedgerRepository(
    {}, DEFAULT_NOW
  );
  const transactions = new InMemoryGrowthTemporalTransactionRunner(DEFAULT_NOW);
  const baseBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const seals: GrowthSealedReadCutoff[] = [];
  class CountingFinanceBarrier extends DefaultGrowthTemporalBarrier {
    override async sealReadCutoff(
      context: ActiveWorkspaceContext,
      effectiveAsOf: string
    ) {
      const token = await super.sealReadCutoff(context, effectiveAsOf);
      seals.push(token);
      return token;
    }
  }
  const countingBarrier = new CountingFinanceBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: countingBarrier
  });
  const importRepository = new InMemoryFinanceImportRepository(
    transactions, baseBarrier
  );
  let clock = growthInstantMilliseconds(DEFAULT_NOW);
  const now = () => new Date(clock).toISOString();
  const setNow = (value: string) => {
    clock = growthInstantMilliseconds(value);
  };
  const advanceNowBy = (milliseconds: number) => {
    clock += milliseconds;
    return now();
  };
  const rowCount = options.rows ?? 1;
  const factType = options.factType ?? "revenue_recognized";
  const amountMinor = options.amountMinor ?? 1000;
  const currency = options.currency ?? "CNY";
  const revenueMinor = options.revenueMinor;
  const grossProfitMinor = options.grossProfitMinor;
  const requestingActorId = options.requestingActorId ?? "finance-a";
  const wonQuote = options.wonQuote ?? wonQuoteFixture();
  let wonDecision = options.wonQuote === null ? null : wonQuote;
  let currentBinding = wonDecision
    ? Object.freeze({
        ...wonDecision.commercialBindingSnapshot,
        verifiedAt: "2026-08-09T02:00:00.000Z"
      }) as CommercialBindingSnapshot
    : null;
  const quoteCutoffs: GrowthSealedReadCutoff[] = [];
  const financialFactService = new FinancialFactLedgerService({
    repository: ledgerRepository,
    foundation,
    now,
    requestExecutionId: () => "finance-import-fixture-execution",
    bindingVerifier: {
      async verify() {
        if (!currentBinding) {
          throw new Error("commercial_binding_authority_mismatch");
        }
        return currentBinding;
      }
    },
    dealQuoteReader: {
      async getDecisionAt(_context, _dealId, cutoff) {
        quoteCutoffs.push(cutoff);
        return wonDecision;
      }
    }
  });
  const costLedgerService = new AcquisitionCostLedgerService({
    repository: ledgerRepository,
    foundation
  });
  const worker = new FinanceImportWorker({
    repository: importRepository,
    foundation,
    costLedger: costLedgerService,
    financialFactLedger: financialFactService,
    bindingVerifier: {
      async verify() {
        if (!currentBinding) {
          throw new Error("commercial_binding_authority_mismatch");
        }
        return currentBinding;
      }
    },
    dealQuoteReader: {
      async getDecisionAt(_context, _dealId, cutoff) {
        quoteCutoffs.push(cutoff);
        return wonDecision;
      }
    },
    now,
    leaseDurationMs: 5 * 60_000,
    ids: { next: () => randomUUID() }
  });
  const previewIds = options.operations ?? ["preview-1"];
  const operationIds = previewIds.map((_, index) =>
    `operation-${index + 1}`);
  const previewId = previewIds[0]!;
  const operationId = operationIds[0]!;
  const fileHash = "sha256:fixture-file";
  const previewRequestHash = canonicalGrowthRequestHash({
    workspaceId: "workspace-a",
    fileHash
  });
  const operationRequestHash = canonicalGrowthRequestHash({
    workspaceId: "workspace-a",
    actorId: requestingActorId,
    previewId,
    idempotencyKey: "finance-commit-0001"
  });
  const expiredOwner = options.expiredOwner ?? null;
  const status = options.status ?? "queued";
  for (let index = 0; index < previewIds.length; index += 1) {
    const currentPreviewId = previewIds[index]!;
    const derivedFacts: Array<{
      factType: FinancialFactType;
      amountMinor: number;
      provenance?: "derived_from_import";
    }> = [];
    let derivationInputs: {
      revenueMinor: number | null;
      grossProfitMinor: number | null;
    } | null = null;
    const bypass = options.bypassPreviewForCommitIntegrityTest
      && revenueMinor !== undefined;
    if (bypass) {
      derivedFacts.push({
        factType: "revenue_recognized",
        amountMinor: revenueMinor!
      });
      derivedFacts.push({
        factType: "cogs_recognized",
        amountMinor: revenueMinor! - (grossProfitMinor ?? 0),
        provenance: "derived_from_import"
      });
      derivationInputs = {
        revenueMinor,
        grossProfitMinor: grossProfitMinor ?? null
      };
    } else if (revenueMinor !== undefined) {
      const derived = deriveRevenueAndCogs({
        revenueMinor,
        grossProfitMinor: grossProfitMinor ?? null
      });
      if (derived) {
        derivedFacts.push({
          factType: "revenue_recognized",
          amountMinor: derived.revenueMinor
        });
        if (derived.cogsMinor !== null) {
          derivedFacts.push({
            factType: "cogs_recognized",
            amountMinor: derived.cogsMinor,
            provenance: "derived_from_import"
          });
        }
      }
      derivationInputs = {
        revenueMinor,
        grossProfitMinor: grossProfitMinor ?? null
      };
    } else {
      derivedFacts.push({ factType, amountMinor });
    }
    const storedRows: FinanceImportStoredRowInput[] = Array.from(
      { length: rowCount },
      (_, rowIndex) => {
        const rowNumber = rowIndex + 1;
        return Object.freeze({
          id: `row-${currentPreviewId}-${rowNumber}`,
          previewId: currentPreviewId,
          rowNumber,
          sheetName: "CSV",
          status: "valid",
          sourceIdentityRoot: `finance-import-row:${currentPreviewId}:${rowNumber}`,
          normalized: Object.freeze({
            kind: "financial_fact",
            candidateId: factType === "contract_won"
              ? "candidate-1" : null,
            customerId: factType === "contract_won"
              ? "customer-1" : null,
            dealId: factType === "contract_won" ? "deal-1" : null,
            currency,
            businessOccurredAt: "2026-08-08T16:00:00.000Z",
            externalId: `external-${currentPreviewId}-${rowNumber}`,
            evidenceHash: `sha256:row-${currentPreviewId}-${rowNumber}`,
            derivedFacts: derivedFacts.map((fact) => ({ ...fact })),
            authoritativeDecision: factType === "contract_won"
              ? wonDecision : null,
            derivationInputs
          }),
          errors: []
        });
      }
    );
    const previewRecord: FinanceImportPreviewRecordInput = Object.freeze({
      id: currentPreviewId,
      workspaceId: "workspace-a",
      createdBy: requestingActorId,
      previewRequestHash,
      fileHash,
      templateVersion: "finance-fact-import.v1",
      kind: "financial_fact",
      resolvedTimeZone: "Asia/Shanghai",
      workspaceSettingsRevision: "settings-1",
      workspaceSettingsRecordedAt: DEFAULT_NOW,
      workspaceSettingsEventSequence: 1,
      validRows: rowCount,
      invalidRows: 0,
      authorityEffectiveAsOf: DEFAULT_NOW,
      authorityTemporalSequence: 1
    });
    importRepository.seedPreview(previewRecord, storedRows);
    const operationInput: FinanceImportOperationInput = Object.freeze({
      id: operationIds[index]!,
      previewId: currentPreviewId,
      workspaceId: "workspace-a",
      requestingActorId,
      idempotencyKey: "finance-commit-0001",
      requestHash: operationRequestHash,
      previewRequestHash,
      fileHash,
      templateVersion: "finance-fact-import.v1",
      status: status === "running" ? "running" : "queued",
      validRows: rowCount,
      invalidRows: 0,
      leaseOwner: status === "running" ? expiredOwner : null,
      leaseExpiresAt: status === "running"
        ? new Date(clock - 60_000).toISOString() : null,
      fencingToken: status === "running" ? 1 : 0,
      resultCreatedIds: [],
      lastErrorCode: null
    });
    await importRepository.appendOperation(operationInput);
  }
  const capabilityLists = new Map<string, GrowthCapability[]>();
  function capabilitiesFor(actorId: string): readonly GrowthCapability[] {
    let capabilities = capabilityLists.get(actorId);
    if (!capabilities) {
      capabilities = [
        "ledger.pending.create" as const,
        "ledger.verify" as const,
        "roi.close" as const,
        "growth.performance.workspace.read" as const,
        "pricing.sensitive.read" as const
      ];
      capabilityLists.set(actorId, capabilities);
    }
    return capabilities;
  }
  function workspaceFor(
    actorId: string,
    workspaceId = "workspace-a"
  ): ActiveWorkspaceContext {
    return Object.freeze({
      workspaceId,
      kind: "team" as const,
      actorId,
      role: "admin" as const,
      teamId: workspaceId,
      capabilities: capabilitiesFor(actorId),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
  }
  const frozenContext = Object.freeze({
    workspace: workspaceFor(requestingActorId),
    actorId: requestingActorId,
    idempotencyKey: "finance-commit-0001",
    requestHash: operationRequestHash,
    expectedRevision: null
  }) as CommandContext;
  function commandContext(patch: Partial<{
    workspaceId: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
  }> = {}): CommandContext {
    return Object.freeze({
      workspace: workspaceFor(
        patch.actorId ?? requestingActorId,
        patch.workspaceId
      ),
      actorId: patch.actorId ?? requestingActorId,
      idempotencyKey: patch.idempotencyKey ?? frozenContext.idempotencyKey,
      requestHash: patch.requestHash ?? frozenContext.requestHash,
      expectedRevision: null
    });
  }
  const failedAuthorizationPreviews = new Set<string>();
  const recoveryAuthorizationInputs: Array<{ operationId: string }> = [];
  let lastRecoveryContext: CommandContext | null = null;
  let recoveryPauseGate: Promise<void> | null = null;
  let releaseRecoveryPause: (() => void) | null = null;
  let waitForClaimResolve: (() => void) | null = null;
  const waitForClaimPromise = new Promise<void>((resolve) => {
    waitForClaimResolve = resolve;
  });
  let waitForPauseResolve: (() => void) | null = null;
  const waitForPausePromise = new Promise<void>((resolve) => {
    waitForPauseResolve = resolve;
  });
  let recoveryClaimObserved = false;
  const activeSweepers = new Set<{ closed: boolean }>();
  const pauseNextLedgerCall = options.status === "running"
    && Boolean(options.expiredOwner);
  let pauseArmed = pauseNextLedgerCall;
  const originalCreatePendingAt = financialFactService.createPendingAt.bind(
    financialFactService
  );
  financialFactService.createPendingAt = async (context, cutoff, input) => {
    if (pauseArmed) {
      pauseArmed = false;
      if (!recoveryPauseGate) {
        recoveryPauseGate = new Promise<void>((resolve) => {
          releaseRecoveryPause = resolve;
        });
        waitForPauseResolve?.();
      }
      await recoveryPauseGate;
    }
    return originalCreatePendingAt(context, cutoff, input);
  };
  const originalClaim = importRepository.claim.bind(importRepository);
  importRepository.claim = async (operationId, workerId, now, expiry) => {
    const claim = await originalClaim(operationId, workerId, now, expiry);
    if (claim && workerId.startsWith("finance-recovery")
      && !recoveryClaimObserved) {
      recoveryClaimObserved = true;
      waitForClaimResolve?.();
    }
    return claim;
  };
  function recoverySweeper(input: {
    workerId: string;
    intervalMs: number;
  }) {
    const handle = { closed: false };
    activeSweepers.add(handle);
    const authorizer = {
      async commandFor(operation: FinanceImportOperation) {
        recoveryAuthorizationInputs.push({ operationId: operation.id });
        if (failedAuthorizationPreviews.has(operation.previewId)) {
          throw new FinanceImportError(
            "finance_import_authority_mismatch", 403
          );
        }
        const context = commandContext({
          actorId: operation.requestingActorId
        });
        requireGrowthCapabilities(
          context.workspace, ["ledger.pending.create"]
        );
        lastRecoveryContext = context;
        return context;
      }
    };
    const sweeper = new DefaultFinanceImportRecoverySweeper({
      repository: importRepository,
      worker,
      authorizer,
      workerId: input.workerId,
      intervalMs: input.intervalMs,
      batchSize: 10,
      now,
      onError: () => undefined
    });
    const originalClose = sweeper.close.bind(sweeper);
    sweeper.close = async () => {
      handle.closed = true;
      return originalClose();
    };
    return sweeper;
  }
  return {
    dependencies: {
      repository: importRepository,
      foundation,
      costLedger: costLedgerService,
      financialFactLedger: financialFactService,
      bindingVerifier: {
        async verify() {
          if (!currentBinding) {
            throw new Error("commercial_binding_authority_mismatch");
          }
          return currentBinding;
        }
      },
      dealQuoteReader: {
        async getDecisionAt(
          _context: ActiveWorkspaceContext,
          _dealId: string,
          cutoff: GrowthSealedReadCutoff
        ) {
          quoteCutoffs.push(cutoff);
          return wonDecision;
        }
      },
      now,
      leaseDurationMs: 5 * 60_000
    },
    repository: importRepository,
    foundation,
    worker,
    operationId,
    operationIds,
    previewId,
    context: frozenContext,
    commandContext,
    now,
    setNow,
    advanceNowBy,
    expiredFencingToken: status === "running" ? 1 : 0,
    savedRowFences: () => [...importRepository.savedRowFences],
    operationEvents: () =>
      importRepository.listOperationEvents(operationId),
    writeLockTraces: () => importRepository.writeLockTracesSnapshot(),
    commitBoundarySealCallCount: () => seals.length,
    internalFactSealCallCount: () => 0,
    quoteReaderSealCallCount: () => 0,
    authorityCutoffs: () => [...quoteCutoffs],
    lastCommitBoundaryCutoff: () => seals.at(-1) ?? null,
    replaceOperationPreviewId: (value: string) =>
      importRepository.replaceOperationPreviewId(operationId, value),
    countCreatedLedgerRows: async () =>
      (await ledgerRepository.listFinancialFacts("workspace-a")).length,
    countSavedRowResults: async () =>
      (await importRepository.listRowResults(operationId)).length,
    normalizedAuthoritativeDecision: async () => {
      const row = await importRepository.getStoredRow(previewId, 1);
      return row?.normalized?.kind === "financial_fact"
        ? row.normalized.authoritativeDecision : null;
    },
    replaceWonAuthority: (overrides: Partial<AuthoritativeDealDecisionRef>) => {
      if (!wonDecision) throw new Error("won_authority_required");
      wonDecision = Object.freeze({ ...wonDecision, ...overrides });
    },
    restoreWonAuthorityFor: () => {
      wonDecision = wonQuote;
    },
    replaceCurrentBinding: (
      overrides: Partial<CommercialBindingSnapshot>
    ) => {
      if (!currentBinding) throw new Error("won_authority_required");
      currentBinding = Object.freeze({ ...currentBinding, ...overrides });
    },
    recoverySweeper,
    waitUntilRecoveryClaimed: () => pauseNextLedgerCall
      ? waitForPausePromise
      : waitForClaimPromise,
    releaseRecoveryRow: () => {
      releaseRecoveryPause?.();
      releaseRecoveryPause = null;
      recoveryPauseGate = null;
    },
    stopResolved: (promise: Promise<unknown>) => {
      let resolved = false;
      void promise.then(() => {
        resolved = true;
      });
      return resolved;
    },
    operation: async (id?: string) => {
      const target = id ?? operationId;
      const byOperation = await importRepository.getOperation(target);
      if (byOperation) return byOperation;
      for (const candidate of operationIds) {
        const operation = await importRepository.getOperation(candidate);
        if (operation?.previewId === target) return operation;
      }
      return null;
    },
    activeTimerCount: () =>
      [...activeSweepers].filter((sweeper) => !sweeper.closed).length,
    failAuthorizationFor: (previewId: string) => {
      failedAuthorizationPreviews.add(previewId);
    },
    revoke: (actorId: string, capability: string) => {
      const capabilities = capabilityLists.get(actorId);
      const index = capabilities?.indexOf(
        capability as GrowthCapability
      ) ?? -1;
      if (index >= 0) capabilities!.splice(index, 1);
    },
    recoveryAuthorizationInputs: () => [...recoveryAuthorizationInputs],
    lastRecoveryContextIdentity: () => {
      if (!lastRecoveryContext) return null;
      return {
        workspaceId: lastRecoveryContext.workspace.workspaceId,
        actorId: lastRecoveryContext.actorId,
        idempotencyKey: lastRecoveryContext.idempotencyKey,
        requestHash: lastRecoveryContext.requestHash
      };
    },
    frozenOperationContextIdentity: () => ({
      workspaceId: frozenContext.workspace.workspaceId,
      actorId: frozenContext.actorId,
      idempotencyKey: frozenContext.idempotencyKey,
      requestHash: frozenContext.requestHash
    }),
    domainAndRowResultWriteCounts: async () => ({
      ledgerRows: (await ledgerRepository.listFinancialFacts("workspace-a"))
        .length,
      rowResults: (await importRepository.listRowResults(operationId)).length
    })
  };
}
