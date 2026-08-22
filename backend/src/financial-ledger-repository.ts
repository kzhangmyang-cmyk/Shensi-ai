import {
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type AcquisitionCostEstimate,
  type AcquisitionCostEstimateLifecycleEvent,
  type FinancialFact,
  type LedgerSourceHead,
  type LedgerType,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import {
  assertConcreteGrowthWorkspaceId,
  type GrowthTemporalTransaction,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export interface FinancialLedgerTransaction extends GrowthTemporalTransaction {
  getSourceHeadForUpdate(workspaceId: string, ledgerType: LedgerType, sourceIdentityRoot: string): Promise<LedgerSourceHead | null>;
  insertSourceHead(head: LedgerSourceHead): Promise<void>;
  compareAndSetSourceHead(expectedRevision: number, head: LedgerSourceHead): Promise<boolean>;
  getCostEntryForUpdate(workspaceId: string, id: string): Promise<AcquisitionCostEntry | null>;
  insertCostEntry(entry: AcquisitionCostEntry): Promise<void>;
  getFinancialFactForUpdate(workspaceId: string, id: string): Promise<FinancialFact | null>;
  insertFinancialFact(fact: FinancialFact): Promise<void>;
  listVerificationEventsForUpdate(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string): Promise<LedgerVerificationEvent[]>;
  appendVerificationEvent(event: LedgerVerificationEvent): Promise<void>;
  getCostEstimateForUpdate(workspaceId: string, id: string): Promise<AcquisitionCostEstimate | null>;
  insertCostEstimate(estimate: AcquisitionCostEstimate): Promise<void>;
  getActiveCostEstimateForUpdate(workspaceId: string, currency: string, sourceStableKey: string): Promise<AcquisitionCostEstimate | null>;
  listCostEstimateLifecycleEventsForUpdate(workspaceId: string, currency: string, sourceStableKey: string): Promise<AcquisitionCostEstimateLifecycleEvent[]>;
  appendCostEstimateLifecycleEvent(event: AcquisitionCostEstimateLifecycleEvent): Promise<void>;
  compareAndSetCostEstimateHead(input: { workspaceId: string; currency: string; sourceStableKey: string; expectedRevision: number; activeEstimateId: string | null; lastEventSequence: number }): Promise<boolean>;
}

export interface FinancialLedgerRepository {
  transaction<T>(work: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T>;
  getCostEntry(workspaceId: string, id: string): Promise<AcquisitionCostEntry | null>;
  getCostEntryBySource(workspaceId: string, sourceIdentityRoot: string): Promise<AcquisitionCostEntry | null>;
  getFinancialFact(workspaceId: string, id: string): Promise<FinancialFact | null>;
  getFinancialFactBySource(workspaceId: string, sourceIdentityRoot: string): Promise<FinancialFact | null>;
  listFinancialFacts(workspaceId: string): Promise<FinancialFact[]>;
  getCostEstimate(workspaceId: string, id: string): Promise<AcquisitionCostEstimate | null>;
  listCostEstimateLifecycleEvents(workspaceId: string, currency: string, sourceStableKey: string, asOf: string): Promise<AcquisitionCostEstimateLifecycleEvent[]>;
}

interface EstimateHead {
  activeEstimateId: string | null;
  revision: number;
  lastEventSequence: number;
}

interface TemporalTail {
  lastRecordedAt: string;
  temporalSequence: number;
}

interface MemoryState {
  sourceHeads: Map<string, LedgerSourceHead>;
  costEntries: Map<string, AcquisitionCostEntry>;
  financialFacts: Map<string, FinancialFact>;
  verificationEvents: Map<string, LedgerVerificationEvent[]>;
  costEstimates: Map<string, AcquisitionCostEstimate>;
  estimateEvents: Map<string, AcquisitionCostEstimateLifecycleEvent[]>;
  estimateHeads: Map<string, EstimateHead>;
  temporalTails: Map<string, TemporalTail>;
}

export interface InMemoryFinancialLedgerInitialState {
  readonly costEntries?: readonly AcquisitionCostEntry[];
  readonly financialFacts?: readonly FinancialFact[];
  readonly verificationEvents?: readonly LedgerVerificationEvent[];
  readonly sourceHeads?: readonly LedgerSourceHead[];
  readonly costEstimates?: readonly AcquisitionCostEstimate[];
  readonly estimateLifecycleEvents?: readonly AcquisitionCostEstimateLifecycleEvent[];
  readonly temporalTails?: Readonly<Record<string, Readonly<TemporalTail>>>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";

function key(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

function immutable<T extends object>(value: T): T {
  return Object.freeze({ ...value });
}

function copyState(state: MemoryState): MemoryState {
  return {
    sourceHeads: new Map(state.sourceHeads),
    costEntries: new Map(state.costEntries),
    financialFacts: new Map(state.financialFacts),
    verificationEvents: new Map([...state.verificationEvents].map(
      ([stream, events]) => [stream, [...events]]
    )),
    costEstimates: new Map(state.costEstimates),
    estimateEvents: new Map([...state.estimateEvents].map(
      ([stream, events]) => [stream, [...events]]
    )),
    estimateHeads: new Map([...state.estimateHeads].map(
      ([stream, head]) => [stream, { ...head }]
    )),
    temporalTails: new Map([...state.temporalTails].map(
      ([workspaceId, tail]) => [workspaceId, { ...tail }]
    ))
  };
}

function entryKey(workspaceId: string, id: string): string {
  return key(assertConcreteGrowthWorkspaceId(workspaceId), id);
}

function sourceKey(workspaceId: string, ledgerType: LedgerType, sourceIdentityRoot: string): string {
  return key(assertConcreteGrowthWorkspaceId(workspaceId), ledgerType, sourceIdentityRoot);
}

function eventKey(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string): string {
  return key(assertConcreteGrowthWorkspaceId(workspaceId), ledgerType, ledgerEntryId);
}

function estimateStreamKey(workspaceId: string, currency: string, sourceStableKey: string): string {
  return key(assertConcreteGrowthWorkspaceId(workspaceId), currency, sourceStableKey);
}

export class InMemoryFinancialLedgerRepository
implements FinancialLedgerRepository, GrowthTemporalTransactionRunner {
  private state: MemoryState;
  private queue: Promise<void> = Promise.resolve();
  private databaseNow: string;

  constructor(
    initial: InMemoryFinancialLedgerInitialState = {},
    databaseNow = EPOCH
  ) {
    this.databaseNow = databaseNow;
    this.state = {
      sourceHeads: new Map((initial.sourceHeads ?? []).map((head) => [
        sourceKey(head.workspaceId, head.ledgerType, head.sourceIdentityRoot),
        immutable(head)
      ])),
      costEntries: new Map((initial.costEntries ?? []).map((entry) => [
        entryKey(entry.workspaceId, entry.id), immutable(entry)
      ])),
      financialFacts: new Map((initial.financialFacts ?? []).map((fact) => [
        entryKey(fact.workspaceId, fact.id), immutable(fact)
      ])),
      verificationEvents: new Map(),
      costEstimates: new Map((initial.costEstimates ?? []).map((estimate) => [
        entryKey(estimate.workspaceId, estimate.id), immutable(estimate)
      ])),
      estimateEvents: new Map(),
      estimateHeads: new Map(),
      temporalTails: new Map(Object.entries(initial.temporalTails ?? {}).map(
        ([workspaceId, tail]) => [assertConcreteGrowthWorkspaceId(workspaceId), { ...tail }]
      ))
    };
    for (const event of initial.verificationEvents ?? []) {
      const stream = eventKey(event.workspaceId, event.ledgerType, event.ledgerEntryId);
      const events = this.state.verificationEvents.get(stream) ?? [];
      events.push(immutable(event));
      events.sort((left, right) => left.eventSequence - right.eventSequence);
      this.state.verificationEvents.set(stream, events);
    }
    for (const event of initial.estimateLifecycleEvents ?? []) {
      const stream = estimateStreamKey(event.workspaceId, event.currency, event.sourceStableKey);
      const events = this.state.estimateEvents.get(stream) ?? [];
      events.push(immutable(event));
      events.sort((left, right) => left.eventSequence - right.eventSequence);
      this.state.estimateEvents.set(stream, events);
    }
  }

  setDatabaseNow(value: string): void {
    this.databaseNow = value;
  }

  async run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T> {
    return this.transaction((tx) => work(tx));
  }

  async transaction<T>(work: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    const pending = copyState(this.state);
    const tx = this.transactionView(pending);
    try {
      const result = await work(tx);
      this.state = pending;
      return result;
    } finally {
      release();
    }
  }

  private transactionView(pending: MemoryState): FinancialLedgerTransaction {
    return {
      lockWorkspaceTemporalBarrierForUpdate: async (workspaceId) => {
        const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
        return { ...(pending.temporalTails.get(concrete) ?? {
          lastRecordedAt: EPOCH, temporalSequence: 0
        }) };
      },
      currentTimestamp3: async () => this.databaseNow,
      saveWorkspaceTemporalBarrier: async (workspaceId, expectedSequence, next) => {
        const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
        const current = pending.temporalTails.get(concrete) ?? {
          lastRecordedAt: EPOCH, temporalSequence: 0
        };
        if (current.temporalSequence !== expectedSequence) {
          throw new Error("growth_temporal_barrier_sequence_conflict");
        }
        pending.temporalTails.set(concrete, { ...next });
      },
      getSourceHeadForUpdate: async (workspaceId, ledgerType, sourceIdentityRoot) =>
        pending.sourceHeads.get(sourceKey(workspaceId, ledgerType, sourceIdentityRoot)) ?? null,
      insertSourceHead: async (head) => {
        const stream = sourceKey(head.workspaceId, head.ledgerType, head.sourceIdentityRoot);
        if (pending.sourceHeads.has(stream)) throw new Error("ledger_source_head_exists");
        pending.sourceHeads.set(stream, immutable(head));
      },
      compareAndSetSourceHead: async (expectedRevision, head) => {
        const stream = sourceKey(head.workspaceId, head.ledgerType, head.sourceIdentityRoot);
        const current = pending.sourceHeads.get(stream);
        if (!current || current.revision !== expectedRevision) return false;
        pending.sourceHeads.set(stream, immutable(head));
        return true;
      },
      getCostEntryForUpdate: async (workspaceId, id) =>
        pending.costEntries.get(entryKey(workspaceId, id)) ?? null,
      insertCostEntry: async (entry) => {
        const location = entryKey(entry.workspaceId, entry.id);
        if (pending.costEntries.has(location)) throw new Error("cost_entry_exists");
        pending.costEntries.set(location, immutable(entry));
      },
      getFinancialFactForUpdate: async (workspaceId, id) =>
        pending.financialFacts.get(entryKey(workspaceId, id)) ?? null,
      insertFinancialFact: async (fact) => {
        const location = entryKey(fact.workspaceId, fact.id);
        if (pending.financialFacts.has(location)) throw new Error("financial_fact_exists");
        pending.financialFacts.set(location, immutable(fact));
      },
      listVerificationEventsForUpdate: async (workspaceId, ledgerType, ledgerEntryId) =>
        [...(pending.verificationEvents.get(eventKey(workspaceId, ledgerType, ledgerEntryId)) ?? [])],
      appendVerificationEvent: async (event) => {
        const stream = eventKey(event.workspaceId, event.ledgerType, event.ledgerEntryId);
        const events = pending.verificationEvents.get(stream) ?? [];
        if (events.some((candidate) => candidate.id === event.id)
          || event.eventSequence !== events.length + 1
          || event.revision !== events.length + 2) {
          throw new Error("ledger_event_sequence_invalid");
        }
        const next = [...events, immutable(event)];
        ledgerEntryStatus(next);
        pending.verificationEvents.set(stream, next);
      },
      getCostEstimateForUpdate: async (workspaceId, id) =>
        pending.costEstimates.get(entryKey(workspaceId, id)) ?? null,
      insertCostEstimate: async (estimate) => {
        const location = entryKey(estimate.workspaceId, estimate.id);
        if (pending.costEstimates.has(location)) throw new Error("cost_estimate_exists");
        pending.costEstimates.set(location, immutable(estimate));
      },
      getActiveCostEstimateForUpdate: async (workspaceId, currency, sourceStableKey) => {
        const head = pending.estimateHeads.get(estimateStreamKey(workspaceId, currency, sourceStableKey));
        return head?.activeEstimateId
          ? pending.costEstimates.get(entryKey(workspaceId, head.activeEstimateId)) ?? null
          : null;
      },
      listCostEstimateLifecycleEventsForUpdate: async (workspaceId, currency, sourceStableKey) =>
        [...(pending.estimateEvents.get(estimateStreamKey(workspaceId, currency, sourceStableKey)) ?? [])],
      appendCostEstimateLifecycleEvent: async (event) => {
        const stream = estimateStreamKey(event.workspaceId, event.currency, event.sourceStableKey);
        const events = pending.estimateEvents.get(stream) ?? [];
        if (event.eventSequence !== events.length + 1
          || event.revision !== events.length + 1
          || events.some((candidate) => candidate.id === event.id)) {
          throw new Error("cost_estimate_event_sequence_invalid");
        }
        pending.estimateEvents.set(stream, [...events, immutable(event)]);
      },
      compareAndSetCostEstimateHead: async (input) => {
        const stream = estimateStreamKey(input.workspaceId, input.currency, input.sourceStableKey);
        const current = pending.estimateHeads.get(stream) ?? {
          activeEstimateId: null, revision: 0, lastEventSequence: 0
        };
        if (current.revision !== input.expectedRevision) return false;
        pending.estimateHeads.set(stream, {
          activeEstimateId: input.activeEstimateId,
          revision: input.expectedRevision + 1,
          lastEventSequence: input.lastEventSequence
        });
        return true;
      }
    };
  }

  async getCostEntry(workspaceId: string, id: string): Promise<AcquisitionCostEntry | null> {
    return this.state.costEntries.get(entryKey(workspaceId, id)) ?? null;
  }

  async getCostEntryBySource(workspaceId: string, sourceIdentityRoot: string): Promise<AcquisitionCostEntry | null> {
    const head = this.state.sourceHeads.get(sourceKey(workspaceId, "cost", sourceIdentityRoot));
    return head ? this.getCostEntry(workspaceId, head.currentLedgerEntryId) : null;
  }

  async getFinancialFact(workspaceId: string, id: string): Promise<FinancialFact | null> {
    return this.state.financialFacts.get(entryKey(workspaceId, id)) ?? null;
  }

  async getFinancialFactBySource(workspaceId: string, sourceIdentityRoot: string): Promise<FinancialFact | null> {
    const head = this.state.sourceHeads.get(sourceKey(workspaceId, "financial", sourceIdentityRoot));
    return head ? this.getFinancialFact(workspaceId, head.currentLedgerEntryId) : null;
  }

  async getCostEstimate(workspaceId: string, id: string): Promise<AcquisitionCostEstimate | null> {
    return this.state.costEstimates.get(entryKey(workspaceId, id)) ?? null;
  }

  async listCostEstimateLifecycleEvents(workspaceId: string, currency: string, sourceStableKey: string, asOf: string): Promise<AcquisitionCostEstimateLifecycleEvent[]> {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff)) throw new Error("invalid_as_of");
    return [...(this.state.estimateEvents.get(estimateStreamKey(workspaceId, currency, sourceStableKey)) ?? [])]
      .filter((event) => Date.parse(event.recordedAt) <= cutoff)
      .sort((left, right) => left.eventSequence - right.eventSequence);
  }

  async listVerificationEvents(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string): Promise<LedgerVerificationEvent[]> {
    return [...(this.state.verificationEvents.get(eventKey(workspaceId, ledgerType, ledgerEntryId)) ?? [])];
  }

  async listCostEntries(workspaceId: string): Promise<AcquisitionCostEntry[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    return [...this.state.costEntries.values()].filter((entry) => entry.workspaceId === concrete);
  }

  async listFinancialFacts(workspaceId: string): Promise<FinancialFact[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    return [...this.state.financialFacts.values()].filter((fact) => fact.workspaceId === concrete);
  }
}
