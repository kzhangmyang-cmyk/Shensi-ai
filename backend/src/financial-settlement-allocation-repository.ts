import type {
  CashSettlementAllocationItemInput,
  CashSettlementAllocationLifecycleEvent,
  CashSettlementAllocationRepository,
  CashSettlementAllocationSet
} from "./financial-settlement-allocation.js";

interface SourceHead {
  activeSetId: string | null;
  revision: number;
  lastEventSequence: number;
}

export class InMemoryFinancialSettlementRepository
implements CashSettlementAllocationRepository {
  private readonly sets = new Map<string, CashSettlementAllocationSet>();
  private readonly events: CashSettlementAllocationLifecycleEvent[] = [];
  private readonly heads = new Map<string, SourceHead>();
  private readonly draftHashes = new Map<string, `sha256:${string}`>();
  private readonly activationHashes = new Map<string, string>();

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  private headKey(workspaceId: string, sourceFactId: string): string {
    return `${workspaceId}\u0000${sourceFactId}`;
  }

  async createDraft(input: {
    id: string;
    workspaceId: string;
    sourceFactId: string;
    version: number;
    items: CashSettlementAllocationItemInput[];
    createdBy: string;
    createdAt: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<CashSettlementAllocationSet> {
    const existing = await this.findDraftByDomainHash(
      input.workspaceId, input.domainCommandHash
    );
    if (existing) return existing;
    const set = {
      id: input.id,
      workspaceId: input.workspaceId,
      sourceFactId: input.sourceFactId,
      version: input.version,
      status: "draft",
      revision: 1,
      items: input.items.map((item) => ({
        ...item,
        id: `item-${input.id}-${item.targetRevenueFactId}`
      })),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      activatedBy: null,
      activatedAt: null
    } as CashSettlementAllocationSet;
    this.sets.set(this.key(input.workspaceId, input.id), set);
    this.draftHashes.set(this.key(input.workspaceId, input.id),
      input.domainCommandHash);
    return set;
  }

  async findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null> {
    return [...this.sets.values()].find((set) =>
      set.workspaceId === workspaceId
      && this.draftHashes.get(this.key(workspaceId, set.id))
        === domainCommandHash) ?? null;
  }

  async get(
    workspaceId: string,
    id: string
  ): Promise<CashSettlementAllocationSet | null> {
    return this.sets.get(this.key(workspaceId, id)) ?? null;
  }

  async activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<CashSettlementAllocationSet> {
    const existingActivation = this.activationHashes.get(
      `${input.workspaceId}\u0000${input.domainCommandHash}`
    );
    if (existingActivation !== undefined) {
      const set = this.sets.get(this.key(input.workspaceId, existingActivation));
      if (!set || set.id !== input.allocationSetId) {
        throw Object.assign(new Error("idempotency_conflict"), {
          code: "idempotency_conflict"
        });
      }
      return set;
    }
    const draft = this.sets.get(
      this.key(input.workspaceId, input.allocationSetId)
    );
    if (!draft) {
      throw Object.assign(new Error("settlement_set_not_found"), {
        code: "settlement_set_not_found"
      });
    }
    const headKey = this.headKey(input.workspaceId, draft.sourceFactId);
    const head = this.heads.get(headKey) ?? {
      activeSetId: null,
      revision: 1,
      lastEventSequence: 0
    };
    if (head.revision !== input.expectedRevision) {
      throw Object.assign(new Error("revision_mismatch"), {
        code: "revision_mismatch",
        status: 412
      });
    }
    let nextSequence = head.lastEventSequence;
    if (head.activeSetId !== null) {
      nextSequence += 1;
      this.events.push(Object.freeze({
        id: `event-${head.activeSetId}-${nextSequence}`,
        workspaceId: input.workspaceId,
        sourceFactId: draft.sourceFactId,
        allocationSetId: head.activeSetId,
        eventType: "superseded",
        eventSequence: nextSequence,
        revision: nextSequence,
        effectiveAt: input.activatedAt,
        supersedesAllocationSetId: null,
        actorId: input.activatedBy,
        recordedAt: input.activatedAt,
        temporalSequence: input.temporalSequence
      }));
      const previous = this.sets.get(
        this.key(input.workspaceId, head.activeSetId)
      );
      if (previous) {
        this.sets.set(this.key(input.workspaceId, previous.id), {
          ...previous,
          status: "superseded"
        });
      }
    }
    nextSequence += 1;
    this.events.push(Object.freeze({
      id: `event-${draft.id}-${nextSequence}`,
      workspaceId: input.workspaceId,
      sourceFactId: draft.sourceFactId,
      allocationSetId: draft.id,
      eventType: "activated",
      eventSequence: nextSequence,
      revision: nextSequence,
      effectiveAt: input.activatedAt,
      supersedesAllocationSetId: head.activeSetId,
      actorId: input.activatedBy,
      recordedAt: input.activatedAt,
      temporalSequence: input.temporalSequence
    }));
    const active = {
      ...draft,
      status: "active",
      revision: head.revision + 1,
      activatedBy: input.activatedBy,
      activatedAt: input.activatedAt
    } as CashSettlementAllocationSet;
    this.sets.set(this.key(input.workspaceId, active.id), active);
    this.activationHashes.set(
      `${input.workspaceId}\u0000${input.domainCommandHash}`,
      active.id
    );
    this.heads.set(headKey, {
      activeSetId: active.id,
      revision: head.revision + 1,
      lastEventSequence: nextSequence
    });
    return active;
  }

  async findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null> {
    const id = this.activationHashes.get(
      `${workspaceId}\u0000${domainCommandHash}`
    );
    return id ? this.sets.get(this.key(workspaceId, id)) ?? null : null;
  }

  async listLifecycleEvents(
    workspaceId: string,
    sourceFactId: string
  ): Promise<CashSettlementAllocationLifecycleEvent[]> {
    return this.events.filter((event) =>
      event.workspaceId === workspaceId
      && event.sourceFactId === sourceFactId);
  }

  async activationCount(allocationSetId: string): Promise<number> {
    return this.events.filter((event) =>
      event.allocationSetId === allocationSetId
      && event.eventType === "activated").length;
  }

  async listSets(workspaceId: string): Promise<CashSettlementAllocationSet[]> {
    return [...this.sets.values()].filter(
      (set) => set.workspaceId === workspaceId
    );
  }
}
