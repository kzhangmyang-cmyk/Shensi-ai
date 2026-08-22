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
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export class AttributionError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "AttributionError";
  }
}

export type AttributionEvidenceRef =
  | { kind: "cohort_member"; cohortMemberId: string }
  | { kind: "source_report"; sourceReportId: string; reportHash: string }
  | { kind: "commercial_binding"; dealId: string; bindingHash: string }
  | {
      kind: "ledger_source";
      ledgerType: "cost" | "financial";
      ledgerEntryId: string;
      evidenceHash: string;
    };

export interface AttributionAllocationItemInput {
  cohortId: string;
  candidateId: string | null;
  planId: string | null;
  runId: string | null;
  allocationBps: number;
  allocationRule: "first_touch" | "direct" | "manual"
    | "equal_split" | "evidence_weighted";
  ruleVersion: string;
  evidenceRefs: AttributionEvidenceRef[];
  targetStableKey: string;
}

export interface AttributionAllocationSet {
  id: string;
  workspaceId: string;
  sourceType: "cost_entry" | "cost_estimate" | "financial_fact"
    | "source_report";
  sourceId: string;
  version: number;
  status: "draft" | "active" | "superseded";
  revision: number;
  items: Array<AttributionAllocationItemInput & {
    effectiveAmountMinor: number;
  }>;
  createdBy: string;
  createdAt: string;
  activatedBy: string | null;
  activatedAt: string | null;
}

export interface AttributionAllocationLifecycleEvent {
  id: string;
  workspaceId: string;
  sourceType: AttributionAllocationSet["sourceType"];
  sourceId: string;
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

export interface AttributionAllocationServiceLike {
  createDraft(
    context: CommandContext,
    input: {
      sourceType: AttributionAllocationSet["sourceType"];
      sourceId: string;
      items: AttributionAllocationItemInput[];
    }
  ): Promise<AttributionAllocationSet>;
  activate(
    context: CommandContext,
    allocationSetId: string
  ): Promise<AttributionAllocationSet>;
  get(
    workspace: ActiveWorkspaceContext,
    id: string
  ): Promise<AttributionAllocationSet | null>;
}

export interface AttributionSourceAmountReader {
  requireEffectiveAmountMinor(
    workspace: ActiveWorkspaceContext,
    sourceType: AttributionAllocationSet["sourceType"],
    sourceId: string
  ): Promise<number>;
}

export interface AttributionAllocationRepository {
  createDraft(input: {
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
  }): Promise<AttributionAllocationSet>;
  findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null>;
  get(workspaceId: string, id: string): Promise<AttributionAllocationSet | null>;
  activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    amounts: Array<{ targetStableKey: string; amountMinor: number }>;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<AttributionAllocationSet>;
  findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null>;
  listLifecycleEvents(
    workspaceId: string,
    sourceType: AttributionAllocationSet["sourceType"],
    sourceId: string
  ): Promise<AttributionAllocationLifecycleEvent[]>;
  activationCount(allocationSetId: string): Promise<number>;
}

export class AttributionAllocationService
implements AttributionAllocationServiceLike {
  private readonly repository: AttributionAllocationRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly commandExecutor: RoiCommandExecutor;
  private readonly sources: AttributionSourceAmountReader;
  private readonly now: () => string;
  private readonly ids: { next(): string };

  constructor(input: {
    repository: AttributionAllocationRepository;
    foundation: GrowthFoundationServices;
    commandExecutor: RoiCommandExecutor;
    sources: AttributionSourceAmountReader;
    now?: () => string;
    ids?: { next(): string };
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.commandExecutor = input.commandExecutor;
    this.sources = input.sources;
    this.now = input.now ?? (() => new Date().toISOString());
    this.ids = input.ids ?? { next: randomUUID };
  }

  async createDraft(
    context: CommandContext,
    input: {
      sourceType: AttributionAllocationSet["sourceType"];
      sourceId: string;
      items: AttributionAllocationItemInput[];
    }
  ): Promise<AttributionAllocationSet> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/acquisition/attribution-allocation-sets",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      sourceType: input.sourceType,
      sourceId: input.sourceId
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/acquisition/attribution-allocation-sets",
        resourceKind: "attribution_set"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new AttributionError("idempotency_reference_invalid", 409);
          }
          const set = await this.repository.get(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!set) throw new AttributionError("idempotency_conflict", 409);
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
            sourceType: input.sourceType,
            sourceId: input.sourceId,
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
    allocationSetId: string
  ): Promise<AttributionAllocationSet> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath:
          "/api/v1/acquisition/attribution-allocation-sets/:id/activate",
        resourceKind: "attribution_set"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new AttributionError("idempotency_reference_invalid", 409);
          }
          const set = await this.repository.get(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!set || set.id !== allocationSetId) {
            throw new AttributionError("idempotency_reference_invalid", 409);
          }
          return set;
        },
        executeClaimed: async (domainCommandHash) => {
          const replay = await this.repository.findActivationByDomainCommandHash(
            context.workspace.workspaceId, domainCommandHash
          );
          if (replay) {
            if (replay.id !== allocationSetId) {
              throw new AttributionError("idempotency_conflict", 409);
            }
            return { resourceId: replay.id, operationId: null };
          }
          const draft = await this.repository.get(
            context.workspace.workspaceId, allocationSetId
          );
          if (!draft) throw new AttributionError("allocation_set_not_found", 404);
          const bps = draft.items.reduce(
            (sum, item) => sum + item.allocationBps, 0
          );
          if (bps !== 10_000) {
            throw new AttributionError("allocation_bps_incomplete", 422);
          }
          const { allocateMinorByBps } = await import(
            "./acquisition-allocation-math.js"
          );
          const sourceAmountMinor =
            await this.sources.requireEffectiveAmountMinor(
              context.workspace, draft.sourceType, draft.sourceId
            );
          const amounts = allocateMinorByBps(sourceAmountMinor, draft.items);
          const active = await this.repository.activate({
            workspaceId: context.workspace.workspaceId,
            allocationSetId,
            expectedRevision,
            amounts,
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

  async get(
    workspace: ActiveWorkspaceContext,
    id: string
  ): Promise<AttributionAllocationSet | null> {
    requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
    return this.repository.get(workspace.workspaceId, id);
  }
}
