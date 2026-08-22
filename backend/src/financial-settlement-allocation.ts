import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import type {
  RoiCommandExecutor,
  RoiCommandExecutionIds
} from "./growth-roi-command-executor.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";

export class SettlementError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "SettlementError";
  }
}

export interface CashSettlementAllocationItemInput {
  targetRevenueFactId: string;
  dealId: string;
  quoteVersionId: string;
  amountMinor: number;
  currency: string;
  originalPaymentFactId: string | null;
  originalPaymentAllocationSetId: string | null;
  originalPaymentAllocationItemId: string | null;
  commercialBindingSnapshot: CommercialBindingSnapshot;
}

export interface CashSettlementAllocationSet {
  id: string;
  workspaceId: string;
  sourceFactId: string;
  version: number;
  status: "draft" | "active" | "superseded";
  revision: number;
  items: Array<CashSettlementAllocationItemInput & { id: string }>;
  createdBy: string;
  createdAt: string;
  activatedBy: string | null;
  activatedAt: string | null;
}

export interface CashSettlementAllocationLifecycleEvent {
  id: string;
  workspaceId: string;
  sourceFactId: string;
  allocationSetId: string;
  eventType: "activated" | "superseded";
  eventSequence: number;
  revision: number;
  effectiveAt: string;
  supersedesAllocationSetId: string | null;
  actorId: string;
  recordedAt: string;
  temporalSequence: number;
}

export interface CashReconciliationResult {
  status: "complete" | "incomplete";
  allocatedPaymentMinor: number;
  allocatedRefundMinor: number;
  allocatedBadDebtMinor: number;
  netCashMinor: number;
  unallocatedCustomerBalanceMinor: number;
  gaps: Array<{ revenueFactId: string; remainingMinor: number }>;
}

export interface CashSettlementAllocationServiceLike {
  createDraft(
    context: CommandContext,
    input: {
      sourceFactId: string;
      items: CashSettlementAllocationItemInput[];
    }
  ): Promise<CashSettlementAllocationSet>;
  activate(
    context: CommandContext,
    setId: string
  ): Promise<CashSettlementAllocationSet>;
  reconcile(
    workspace: ActiveWorkspaceContext,
    revenueFactIds: string[],
    cutoff: GrowthSealedReadCutoff
  ): Promise<CashReconciliationResult>;
}

export interface CashSettlementFactReader {
  requireFact(
    workspace: ActiveWorkspaceContext,
    factId: string
  ): Promise<{
    id: string;
    factType: string;
    dealId: string;
    quoteVersionId: string;
    amountMinor: number;
    currency: string;
    commercialBindingSnapshot: CommercialBindingSnapshot | null;
  }>;
}

export interface CashSettlementAllocationRepository {
  createDraft(input: {
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
  }): Promise<CashSettlementAllocationSet>;
  findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null>;
  get(
    workspaceId: string,
    id: string
  ): Promise<CashSettlementAllocationSet | null>;
  activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<CashSettlementAllocationSet>;
  findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null>;
  listLifecycleEvents(
    workspaceId: string,
    sourceFactId: string
  ): Promise<CashSettlementAllocationLifecycleEvent[]>;
  activationCount(allocationSetId: string): Promise<number>;
  listSets(workspaceId: string): Promise<CashSettlementAllocationSet[]>;
}

export class CashSettlementAllocationService
implements CashSettlementAllocationServiceLike {
  private readonly repository: CashSettlementAllocationRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly commandExecutor: RoiCommandExecutor;
  private readonly facts: CashSettlementFactReader;
  private readonly now: () => string;
  private readonly ids: { next(): string };

  constructor(input: {
    repository: CashSettlementAllocationRepository;
    foundation: GrowthFoundationServices;
    commandExecutor: RoiCommandExecutor;
    facts: CashSettlementFactReader;
    now?: () => string;
    ids?: { next(): string };
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.commandExecutor = input.commandExecutor;
    this.facts = input.facts;
    this.now = input.now ?? (() => new Date().toISOString());
    this.ids = input.ids ?? { next: randomUUID };
  }

  async createDraft(
    context: CommandContext,
    input: {
      sourceFactId: string;
      items: CashSettlementAllocationItemInput[];
    }
  ): Promise<CashSettlementAllocationSet> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/finance/settlement-allocation-sets",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      sourceFactId: input.sourceFactId
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/finance/settlement-allocation-sets",
        resourceKind: "settlement_set"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new SettlementError("idempotency_reference_invalid", 409);
          }
          const set = await this.repository.get(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!set) throw new SettlementError("idempotency_conflict", 409);
          return set;
        },
        executeClaimed: async (hash) => {
          const replay = await this.repository.findDraftByDomainHash(
            context.workspace.workspaceId, hash
          );
          if (replay) {
            return { resourceId: replay.id, operationId: null };
          }
          const draft = await this.repository.createDraft({
            id: this.ids.next(),
            workspaceId: context.workspace.workspaceId,
            sourceFactId: input.sourceFactId,
            version: 1,
            items: input.items,
            createdBy: context.actorId,
            createdAt: this.now(),
            domainCommandHash: hash,
            requestHash: context.requestHash,
            requestedBy: context.actorId
          });
          return { resourceId: draft.id, operationId: null };
        }
      }
    );
  }

  async activate(
    context: CommandContext,
    setId: string
  ): Promise<CashSettlementAllocationSet> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath:
          "/api/v1/finance/settlement-allocation-sets/:id/activate",
        resourceKind: "settlement_set"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new SettlementError("idempotency_reference_invalid", 409);
          }
          const set = await this.repository.get(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!set || set.id !== setId) {
            throw new SettlementError("idempotency_reference_invalid", 409);
          }
          return set;
        },
        executeClaimed: async (domainCommandHash) => {
          const replay = await this.repository.findActivationByDomainCommandHash(
            context.workspace.workspaceId, domainCommandHash
          );
          if (replay) {
            if (replay.id !== setId) {
              throw new SettlementError("idempotency_conflict", 409);
            }
            return { resourceId: replay.id, operationId: null };
          }
          const draft = await this.repository.get(
            context.workspace.workspaceId, setId
          );
          if (!draft) throw new SettlementError("settlement_set_not_found", 404);
          const activeSets = (await this.repository.listSets(
            context.workspace.workspaceId
          )).filter((set) => set.status === "active");
          for (const item of draft.items) {
            if (item.originalPaymentAllocationItemId !== null) {
              const paymentSet = activeSets.find((set) =>
                set.sourceFactId === item.originalPaymentFactId);
              const paymentItem = paymentSet?.items.find((candidate) =>
                candidate.id === item.originalPaymentAllocationItemId
                && candidate.targetRevenueFactId === item.targetRevenueFactId);
              if (!paymentItem) {
                throw new SettlementError("refund_payment_item_invalid", 422);
              }
            }
          }
          const source = await this.facts.requireFact(
            context.workspace, draft.sourceFactId
          );
          void source;
          const active = await this.repository.activate({
            workspaceId: context.workspace.workspaceId,
            allocationSetId: setId,
            expectedRevision,
            activatedBy: context.actorId,
            activatedAt: this.now(),
            temporalSequence: 1,
            domainCommandHash,
            requestHash: context.requestHash
          });
          return { resourceId: active.id, operationId: null };
        }
      }
    );
  }

  async reconcile(
    workspace: ActiveWorkspaceContext,
    revenueFactIds: string[],
    cutoff: GrowthSealedReadCutoff
  ): Promise<CashReconciliationResult> {
    requireGrowthCapabilities(workspace, ["ledger.verify"]);
    if (cutoff.workspaceId !== workspace.workspaceId) {
      throw new SettlementError("sealed_cutoff_workspace_mismatch", 409);
    }
    const gaps: Array<{ revenueFactId: string; remainingMinor: number }> = [];
    let allocatedPaymentMinor = 0;
    let allocatedRefundMinor = 0;
    let allocatedBadDebtMinor = 0;
    let unallocatedCustomerBalanceMinor = 0;
    const sets = await this.repository.listSets(workspace.workspaceId);
    for (const revenueFactId of revenueFactIds) {
      const revenue = await this.facts.requireFact(workspace, revenueFactId);
      const allocated = sets
        .filter((set) => set.status === "active")
        .flatMap((set) => set.items)
        .filter((item) => item.targetRevenueFactId === revenueFactId)
        .reduce((sum, item) => sum + item.amountMinor, 0);
      if (allocated < revenue.amountMinor) {
        gaps.push({
          revenueFactId,
          remainingMinor: revenue.amountMinor - allocated
        });
      }
      allocatedPaymentMinor += allocated;
    }
    const paymentSets = sets.filter((set) => set.status === "active");
    for (const set of paymentSets) {
      const source = await this.facts.requireFact(
        workspace, set.sourceFactId
      );
      const allocated = set.items.reduce(
        (sum, item) => sum + item.amountMinor, 0
      );
      if (source.factType === "payment_received"
        && allocated < source.amountMinor) {
        unallocatedCustomerBalanceMinor += source.amountMinor - allocated;
      }
    }
    const netCashMinor = allocatedPaymentMinor - allocatedRefundMinor;
    return {
      status: gaps.length === 0 ? "complete" : "incomplete",
      allocatedPaymentMinor,
      allocatedRefundMinor,
      allocatedBadDebtMinor,
      netCashMinor,
      unallocatedCustomerBalanceMinor,
      gaps
    };
  }
}

export function activeSettlementSetIdAsOf(
  events: readonly CashSettlementAllocationLifecycleEvent[],
  asOf: string
): string | null {
  const recorded = events
    .filter((event) => event.recordedAt <= asOf)
    .sort((a, b) => a.eventSequence - b.eventSequence);
  for (const [index, event] of recorded.entries()) {
    if (event.eventSequence !== index + 1
      || event.revision !== index + 1) {
      throw new Error("settlement_history_invalid");
    }
  }
  let activeId: string | null = null;
  const effective = recorded
    .filter((event) => event.effectiveAt <= asOf)
    .sort((a, b) =>
      a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0
      || a.eventSequence - b.eventSequence);
  for (const event of effective) {
    if (event.eventType === "superseded"
      && activeId !== event.allocationSetId) {
      throw new Error("settlement_history_invalid");
    }
    activeId = event.eventType === "activated"
      ? event.allocationSetId : null;
  }
  return activeId;
}
