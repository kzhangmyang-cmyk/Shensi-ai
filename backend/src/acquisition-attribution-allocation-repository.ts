import type {
  AttributionAllocationItemInput,
  AttributionAllocationLifecycleEvent,
  AttributionAllocationRepository,
  AttributionAllocationSet
} from "./acquisition-attribution-allocation.js";

interface SourceHead {
  sourceType: AttributionAllocationSet["sourceType"];
  sourceId: string;
  activeAllocationSetId: string | null;
  revision: number;
  lastEventSequence: number;
}

export class InMemoryAttributionAllocationRepository
implements AttributionAllocationRepository {
  private readonly sets = new Map<string, AttributionAllocationSet>();
  private readonly events: AttributionAllocationLifecycleEvent[] = [];
  private readonly heads = new Map<string, SourceHead>();
  private readonly activationHashes = new Map<string, string>();
  private readonly draftHashes = new Map<string, `sha256:${string}`>();

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  async createDraft(input: {
    id: string;
    workspaceId: string;
    sourceType: AttributionAllocationSet["sourceType"];
    sourceId: string;
    version: number;
    items: AttributionAllocationItemInput[];
    createdBy: string;
    createdAt: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<AttributionAllocationSet> {
    const existing = await this.findDraftByDomainHash(
      input.workspaceId, input.domainCommandHash
    );
    if (existing) return existing;
    const set = {
      id: input.id,
      workspaceId: input.workspaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      version: input.version,
      status: "draft",
      revision: 1,
      items: Object.freeze(input.items.map((item) =>
        Object.freeze({ ...item, effectiveAmountMinor: 0 }))),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      activatedBy: null,
      activatedAt: null
    } as AttributionAllocationSet;
    this.sets.set(this.key(input.workspaceId, input.id), set);
    this.draftHashes.set(this.key(input.workspaceId, input.id),
      input.domainCommandHash);
    return set;
  }

  async findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null> {
    return [...this.sets.values()].find((set) =>
      set.workspaceId === workspaceId
      && this.draftHashes.get(this.key(workspaceId, set.id))
        === domainCommandHash) ?? null;
  }

  async get(
    workspaceId: string,
    id: string
  ): Promise<AttributionAllocationSet | null> {
    return this.sets.get(this.key(workspaceId, id)) ?? null;
  }

  async activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    amounts: Array<{ targetStableKey: string; amountMinor: number }>;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<AttributionAllocationSet> {
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
    if (!draft) throw Object.assign(new Error("allocation_set_not_found"), {
      code: "allocation_set_not_found"
    });
    const headKey = `${input.workspaceId}\u0000${draft.sourceType}\u0000${draft.sourceId}`;
    const head = this.heads.get(headKey) ?? {
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
      activeAllocationSetId: null,
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
    const amountByKey = new Map(
      input.amounts.map((item) => [item.targetStableKey, item.amountMinor])
    );
    const active = {
      ...draft,
      status: "active",
      revision: input.expectedRevision + 1,
      items: Object.freeze(draft.items.map((item) =>
        Object.freeze({
          ...item,
          effectiveAmountMinor: amountByKey.get(item.targetStableKey) ?? 0
        }))),
      activatedBy: input.activatedBy,
      activatedAt: input.activatedAt
    } as AttributionAllocationSet;
    this.sets.set(this.key(input.workspaceId, active.id), active);
    this.activationHashes.set(
      `${input.workspaceId}\u0000${input.domainCommandHash}`,
      active.id
    );
    if (head.activeAllocationSetId !== null) {
      nextSequence += 1;
      this.events.push(Object.freeze({
        id: `event-${head.activeAllocationSetId}-${nextSequence}`,
        workspaceId: input.workspaceId,
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        allocationSetId: head.activeAllocationSetId,
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
        this.key(input.workspaceId, head.activeAllocationSetId)
      );
      if (previous) {
        this.sets.set(this.key(input.workspaceId, previous.id), Object.freeze({
          ...previous,
          status: "superseded"
        }));
      }
    }
    nextSequence += 1;
    this.events.push(Object.freeze({
      id: `event-${active.id}-${nextSequence}`,
      workspaceId: input.workspaceId,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
      allocationSetId: active.id,
      eventType: "activated",
      eventSequence: nextSequence,
      revision: nextSequence,
      effectiveAt: input.activatedAt,
      supersedesAllocationSetId: head.activeAllocationSetId,
      actorId: input.activatedBy,
      recordedAt: input.activatedAt,
      temporalSequence: input.temporalSequence
    }));
    this.heads.set(headKey, {
      ...head,
      activeAllocationSetId: active.id,
      revision: head.revision + 1,
      lastEventSequence: nextSequence
    });
    return active;
  }

  async findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null> {
    const id = this.activationHashes.get(
      `${workspaceId}\u0000${domainCommandHash}`
    );
    return id ? this.sets.get(this.key(workspaceId, id)) ?? null : null;
  }

  async listLifecycleEvents(
    workspaceId: string,
    sourceType: AttributionAllocationSet["sourceType"],
    sourceId: string
  ): Promise<AttributionAllocationLifecycleEvent[]> {
    return this.events.filter((event) =>
      event.workspaceId === workspaceId
      && event.sourceType === sourceType
      && event.sourceId === sourceId);
  }

  async activationCount(allocationSetId: string): Promise<number> {
    return this.events.filter((event) =>
      event.allocationSetId === allocationSetId
      && event.eventType === "activated").length;
  }

  countDrafts(): number {
    return [...this.sets.values()].filter(
      (set) => set.status === "draft" || set.status === "active"
    ).length;
  }

  countActivations(): number {
    return this.events.filter(
      (event) => event.eventType === "activated"
    ).length;
  }
}
