import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { GrowthHttpError, requireExpectedRevision, type CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  canonicalGrowthRequestHash,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import {
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type LedgerSourceHead,
  type LedgerVerificationEvent,
  type VerifiedCostProvenance
} from "./financial-ledger-domain.js";
import type {
  FinancialLedgerRepository,
  FinancialLedgerTransaction
} from "./financial-ledger-repository.js";
import { assertGrowthTemporalBarrier } from "./growth-temporal-barrier.js";

export class FinancialLedgerError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "FinancialLedgerError";
  }
}

export interface CreatePendingCostInput {
  platform: string;
  planId: string | null;
  runId: string | null;
  providerId: string | null;
  category: AcquisitionCostEntry["category"];
  amountMinor: number;
  currency: string;
  businessOccurredAt: string;
  provenance: VerifiedCostProvenance;
  sourceRef: string | null;
  evidenceHash: string;
  externalId: string | null;
  sourceIdentityRoot: string;
  estimateReconciliationId: string | null;
}

export interface CostLedgerProjection {
  readonly entry: AcquisitionCostEntry;
  readonly events: readonly LedgerVerificationEvent[];
}

export interface CorrectedCostLedgerProjection extends CostLedgerProjection {
  readonly previousEntry: AcquisitionCostEntry;
  readonly previousEvents: readonly LedgerVerificationEvent[];
}

function text(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new FinancialLedgerError(code, 422);
  return normalized;
}

function nullableText(value: string | null, code: string): string | null {
  return value === null ? null : text(value, code);
}

function timestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new FinancialLedgerError("invalid_ledger_timestamp", 422);
  return new Date(time).toISOString();
}

function normalizedInput(input: CreatePendingCostInput): CreatePendingCostInput {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new FinancialLedgerError("invalid_cost_amount", 422);
  }
  const currency = text(input.currency, "invalid_currency").toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new FinancialLedgerError("invalid_currency", 422);
  }
  return Object.freeze({
    platform: text(input.platform, "invalid_cost_platform"),
    planId: nullableText(input.planId, "invalid_plan_id"),
    runId: nullableText(input.runId, "invalid_run_id"),
    providerId: nullableText(input.providerId, "invalid_provider_id"),
    category: input.category,
    amountMinor: input.amountMinor,
    currency,
    businessOccurredAt: timestamp(input.businessOccurredAt),
    provenance: input.provenance,
    sourceRef: nullableText(input.sourceRef, "invalid_source_ref"),
    evidenceHash: text(input.evidenceHash, "invalid_evidence_hash"),
    externalId: nullableText(input.externalId, "invalid_external_id"),
    sourceIdentityRoot: text(input.sourceIdentityRoot, "invalid_source_identity_root"),
    estimateReconciliationId: nullableText(
      input.estimateReconciliationId, "invalid_estimate_reconciliation_id"
    )
  });
}

function samePendingCommand(
  entry: AcquisitionCostEntry,
  input: CreatePendingCostInput
): boolean {
  return entry.platform === input.platform
    && entry.planId === input.planId
    && entry.runId === input.runId
    && entry.providerId === input.providerId
    && entry.category === input.category
    && entry.amountMinor === input.amountMinor
    && entry.currency === input.currency
    && entry.businessOccurredAt === input.businessOccurredAt
    && entry.provenance === input.provenance
    && entry.sourceRef === input.sourceRef
    && entry.evidenceHash === input.evidenceHash
    && entry.externalId === input.externalId
    && entry.sourceIdentityRoot === input.sourceIdentityRoot
    && entry.estimateReconciliationId === input.estimateReconciliationId;
}

async function requiredCostEntry(
  tx: FinancialLedgerTransaction,
  workspaceId: string,
  entryId: string
): Promise<AcquisitionCostEntry> {
  const entry = await tx.getCostEntryForUpdate(workspaceId, entryId);
  if (!entry) throw new FinancialLedgerError("cost_entry_not_found", 404);
  return entry;
}

function verificationEvent(
  entry: AcquisitionCostEntry,
  eventType: LedgerVerificationEvent["eventType"],
  decidedBy: string,
  reason: string,
  recordedAt: string,
  input: {
    id?: string;
    eventSequence: number;
    revision: number;
    temporalSequence: number;
    reversesEventId?: string | null;
    correctionGroupId?: string | null;
  }
): LedgerVerificationEvent {
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: entry.workspaceId,
    ledgerType: "cost",
    ledgerEntryId: entry.id,
    eventType,
    reversesEventId: input.reversesEventId ?? null,
    eventSequence: input.eventSequence,
    revision: input.revision,
    correctionGroupId: input.correctionGroupId ?? null,
    reason: text(reason, "invalid_ledger_reason"),
    decidedBy: text(decidedBy, "invalid_growth_actor_id"),
    recordedAt,
    temporalSequence: input.temporalSequence
  });
}

function route(event: "create" | "verify" | "reject" | "reverse" | "correct") {
  return event === "create"
    ? "/api/v1/acquisition/cost-entries"
    : `/api/v1/acquisition/cost-entries/:id/${event}`;
}

function stableOperationId(context: CommandContext, operation: string): string {
  return canonicalGrowthRequestHash({
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    operation
  });
}

function isSameDecision(
  event: LedgerVerificationEvent,
  eventType: LedgerVerificationEvent["eventType"],
  actorId: string,
  reason: string
): boolean {
  return event.eventType === eventType
    && event.decidedBy === actorId
    && event.reason === reason.trim();
}

export class AcquisitionCostLedgerService {
  private readonly repository: FinancialLedgerRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly now: () => string;
  private readonly requestExecutionId: () => string;

  constructor(input: {
    repository: FinancialLedgerRepository;
    foundation: GrowthFoundationServices;
    now?: () => string;
    requestExecutionId?: () => string;
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    assertGrowthTemporalBarrier(input.foundation.temporalBarrier);
    this.now = input.now ?? (() => new Date().toISOString());
    this.requestExecutionId = input.requestExecutionId ?? randomUUID;
  }

  private reservation(context: CommandContext, canonicalPath: string) {
    return {
      repository: this.foundation.httpIdempotency,
      reservation: {
        workspaceId: context.workspace.workspaceId,
        actorId: context.actorId,
        method: "POST",
        canonicalPath,
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        attemptedAt: this.now(),
        leaseOwner: this.requestExecutionId(),
        leaseDurationMs: 30_000
      }
    } as const;
  }

  private async events(workspaceId: string, entryId: string) {
    return this.repository.transaction((tx) =>
      tx.listVerificationEventsForUpdate(workspaceId, "cost", entryId));
  }

  private async projectCreate(
    context: CommandContext,
    resourceId: string | null,
    operationId: string | null,
    expected: CreatePendingCostInput
  ): Promise<CostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    if (!resourceId || operationId !== null) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    const entry = await this.repository.getCostEntry(
      context.workspace.workspaceId, resourceId
    );
    if (!entry || !samePendingCommand(entry, expected)) {
      throw new FinancialLedgerError("idempotency_conflict", 409);
    }
    return Object.freeze({ entry, events: Object.freeze(await this.events(entry.workspaceId, entry.id)) });
  }

  private async projectDecision(
    context: CommandContext,
    resourceId: string | null,
    operationId: string | null,
    entryId: string,
    eventType: LedgerVerificationEvent["eventType"]
  ): Promise<CostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    if (resourceId !== entryId || !operationId) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    const entry = await this.repository.getCostEntry(
      context.workspace.workspaceId, entryId
    );
    if (!entry) throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    const events = await this.events(entry.workspaceId, entry.id);
    const operation = events.find((event) => event.id === operationId);
    if (!operation || operation.eventType !== eventType
      || operation.ledgerEntryId !== entry.id) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    return Object.freeze({ entry, events: Object.freeze(events) });
  }

  async get(context: CommandContext, entryId: string): Promise<CostLedgerProjection | null> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const entry = await this.repository.getCostEntry(
      context.workspace.workspaceId, text(entryId, "invalid_cost_entry_id")
    );
    if (!entry) return null;
    return Object.freeze({ entry, events: Object.freeze(await this.events(entry.workspaceId, entry.id)) });
  }

  async createPending(
    context: CommandContext,
    rawInput: CreatePendingCostInput
  ): Promise<CostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const input = normalizedInput(rawInput);
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, route("create")),
      (resourceId, operationId) => this.projectCreate(
        context, resourceId, operationId, input
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const currentHead = await tx.getSourceHeadForUpdate(
          context.workspace.workspaceId, "cost", input.sourceIdentityRoot
        );
        if (currentHead) {
          const current = await requiredCostEntry(
            tx, context.workspace.workspaceId, currentHead.currentLedgerEntryId
          );
          if (!samePendingCommand(current, input)) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          return { resourceId: current.id, operationId: null };
        }
        const entry = Object.freeze({
          id: randomUUID(),
          workspaceId: context.workspace.workspaceId,
          platform: input.platform,
          planId: input.planId,
          runId: input.runId,
          providerId: input.providerId,
          category: input.category,
          amountMinor: input.amountMinor,
          currency: input.currency,
          occurredAt: input.businessOccurredAt,
          provenance: input.provenance,
          sourceRef: input.sourceRef,
          evidenceHash: input.evidenceHash,
          externalId: input.externalId,
          sourceIdentityRoot: input.sourceIdentityRoot,
          sourceVersion: 1,
          businessOccurredAt: input.businessOccurredAt,
          recordedAt: stamp.recordedAt,
          temporalSequence: stamp.temporalSequence,
          correctsCostEntryId: null,
          correctionGroupId: null,
          estimateReconciliationId: input.estimateReconciliationId,
          createdBy: context.actorId
        }) satisfies AcquisitionCostEntry;
        const head = Object.freeze({
          workspaceId: entry.workspaceId,
          ledgerType: "cost" as const,
          sourceIdentityRoot: entry.sourceIdentityRoot,
          currentLedgerEntryId: entry.id,
          currentSourceVersion: 1,
          revision: 1
        }) satisfies LedgerSourceHead;
        await tx.insertSourceHead(head);
        await tx.insertCostEntry(entry);
        return { resourceId: entry.id, operationId: null };
      })
    );
    return execution.value;
  }

  async verify(
    context: CommandContext,
    input: { entryId: string; reason: string }
  ): Promise<CostLedgerProjection> {
    return this.decidePending(context, input, "verified");
  }

  async reject(
    context: CommandContext,
    input: { entryId: string; reason: string }
  ): Promise<CostLedgerProjection> {
    return this.decidePending(context, input, "rejected");
  }

  private async decidePending(
    context: CommandContext,
    input: { entryId: string; reason: string },
    eventType: "verified" | "rejected"
  ): Promise<CostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    const operationId = stableOperationId(context, eventType);
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, route(eventType === "verified" ? "verify" : "reject")),
      (resourceId, operationId) => this.projectDecision(
        context, resourceId, operationId, input.entryId, eventType
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const entry = await requiredCostEntry(
          tx, context.workspace.workspaceId, input.entryId
        );
        const events = await tx.listVerificationEventsForUpdate(
          entry.workspaceId, "cost", entry.id
        );
        const existing = events.find((event) => event.id === operationId);
        if (existing) {
          if (!isSameDecision(existing, eventType, context.actorId, input.reason)) {
            throw new FinancialLedgerError("idempotency_reference_invalid", 409);
          }
          return { resourceId: entry.id, operationId: existing.id };
        }
        if (ledgerEntryStatus(events) !== "pending") {
          throw new FinancialLedgerError("ledger_decision_already_recorded", 409);
        }
        if (expectedRevision !== 1) {
          throw new FinancialLedgerError("ledger_revision_conflict", 412);
        }
        const event = verificationEvent(
          entry, eventType, context.actorId, input.reason, stamp.recordedAt,
          {
            id: operationId,
            eventSequence: 1,
            revision: 2,
            temporalSequence: stamp.temporalSequence
          }
        );
        await tx.appendVerificationEvent(event);
        return { resourceId: entry.id, operationId: event.id };
      })
    );
    return execution.value;
  }

  async reverse(
    context: CommandContext,
    input: { entryId: string; reason: string }
  ): Promise<CostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    const operationId = stableOperationId(context, "reversed");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, route("reverse")),
      (resourceId, operationId) => this.projectDecision(
        context, resourceId, operationId, input.entryId, "reversed"
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const entry = await requiredCostEntry(
          tx, context.workspace.workspaceId, input.entryId
        );
        const events = await tx.listVerificationEventsForUpdate(
          entry.workspaceId, "cost", entry.id
        );
        const existing = events.find((event) => event.id === operationId);
        if (existing) {
          if (!isSameDecision(existing, "reversed", context.actorId, input.reason)) {
            throw new FinancialLedgerError("idempotency_reference_invalid", 409);
          }
          return { resourceId: entry.id, operationId: existing.id };
        }
        if (ledgerEntryStatus(events) !== "verified") {
          throw new FinancialLedgerError("ledger_not_verified", 409);
        }
        if (expectedRevision !== 2) {
          throw new FinancialLedgerError("ledger_revision_conflict", 412);
        }
        const verified = events[0]!;
        const event = verificationEvent(
          entry, "reversed", context.actorId, input.reason, stamp.recordedAt,
          {
            id: operationId,
            eventSequence: 2,
            revision: 3,
            temporalSequence: stamp.temporalSequence,
            reversesEventId: verified.id
          }
        );
        await tx.appendVerificationEvent(event);
        return { resourceId: entry.id, operationId: event.id };
      })
    );
    return execution.value;
  }

  async correct(
    context: CommandContext,
    input: {
      entryId: string;
      amountMinor: number;
      businessOccurredAt: string;
      evidenceHash: string;
      sourceRef: string | null;
      reason: string;
    }
  ): Promise<CorrectedCostLedgerProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    const amountMinor = input.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new FinancialLedgerError("invalid_cost_amount", 422);
    }
    const businessOccurredAt = timestamp(input.businessOccurredAt);
    const evidenceHash = text(input.evidenceHash, "invalid_evidence_hash");
    const sourceRef = nullableText(input.sourceRef, "invalid_source_ref");
    const correctionGroupId = stableOperationId(context, "correction-group");
    const reversalOperationId = stableOperationId(context, "correction-reversal");
    const replacementEntryId = stableOperationId(context, "correction-replacement");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, route("correct")),
      async (resourceId, operationId) => {
        requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
        if (!resourceId || !operationId) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const entry = await this.repository.getCostEntry(
          context.workspace.workspaceId, resourceId
        );
        if (!entry || entry.correctionGroupId !== operationId
          || entry.correctsCostEntryId !== input.entryId
          || entry.amountMinor !== amountMinor
          || entry.businessOccurredAt !== businessOccurredAt
          || entry.evidenceHash !== evidenceHash
          || entry.sourceRef !== sourceRef) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const previousEntry = await this.repository.getCostEntry(
          context.workspace.workspaceId, input.entryId
        );
        if (!previousEntry) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const [events, previousEvents] = await Promise.all([
          this.events(entry.workspaceId, entry.id),
          this.events(previousEntry.workspaceId, previousEntry.id)
        ]);
        if (!previousEvents.some((event) =>
          event.eventType === "reversed"
          && event.correctionGroupId === operationId)) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        return Object.freeze({
          entry,
          events: Object.freeze(events),
          previousEntry,
          previousEvents: Object.freeze(previousEvents)
        });
      },
      async () => {
        const probe = await this.repository.getCostEntry(
          context.workspace.workspaceId, input.entryId
        );
        if (!probe) throw new FinancialLedgerError("cost_entry_not_found", 404);
        return this.repository.transaction(async (tx) => {
          const reversalStamp = await this.foundation.temporalBarrier.allocateAppend(
            tx, context.workspace.workspaceId
          );
          const head = await tx.getSourceHeadForUpdate(
            context.workspace.workspaceId, "cost", probe.sourceIdentityRoot
          );
          const entry = await requiredCostEntry(tx, probe.workspaceId, probe.id);
          if (entry.sourceIdentityRoot !== probe.sourceIdentityRoot
            || entry.sourceVersion !== probe.sourceVersion) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          const previousEvents = await tx.listVerificationEventsForUpdate(
            entry.workspaceId, "cost", entry.id
          );
          const existingReversal = previousEvents.find(
            (event) => event.id === reversalOperationId
          );
          if (existingReversal) {
            if (!isSameDecision(
              existingReversal, "reversed", context.actorId, input.reason
            ) || existingReversal.correctionGroupId !== correctionGroupId) {
              throw new FinancialLedgerError("idempotency_reference_invalid", 409);
            }
            const replacement = await requiredCostEntry(
              tx, context.workspace.workspaceId, replacementEntryId
            );
            if (!head || head.currentLedgerEntryId !== replacement.id
              || replacement.correctsCostEntryId !== entry.id
              || replacement.correctionGroupId !== correctionGroupId
              || replacement.amountMinor !== amountMinor
              || replacement.businessOccurredAt !== businessOccurredAt
              || replacement.evidenceHash !== evidenceHash
              || replacement.sourceRef !== sourceRef) {
              throw new FinancialLedgerError("idempotency_reference_invalid", 409);
            }
            return { resourceId: replacement.id, operationId: correctionGroupId };
          }
          if (!head || head.currentLedgerEntryId !== probe.id
            || head.currentSourceVersion !== probe.sourceVersion) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          if (ledgerEntryStatus(previousEvents) !== "verified") {
            throw new FinancialLedgerError("ledger_not_verified", 409);
          }
          if (expectedRevision !== 2) {
            throw new FinancialLedgerError("ledger_revision_conflict", 412);
          }
          const reversal = verificationEvent(
            entry, "reversed", context.actorId, input.reason,
            reversalStamp.recordedAt,
            {
              id: reversalOperationId,
              eventSequence: 2,
              revision: 3,
              temporalSequence: reversalStamp.temporalSequence,
              reversesEventId: previousEvents[0]!.id,
              correctionGroupId
            }
          );
          await tx.appendVerificationEvent(reversal);
          const replacementStamp = await this.foundation.temporalBarrier.allocateAppend(
            tx, context.workspace.workspaceId
          );
          const replacement = Object.freeze({
            ...entry,
            id: replacementEntryId,
            amountMinor,
            occurredAt: businessOccurredAt,
            businessOccurredAt,
            evidenceHash,
            sourceRef,
            sourceVersion: entry.sourceVersion + 1,
            recordedAt: replacementStamp.recordedAt,
            temporalSequence: replacementStamp.temporalSequence,
            correctsCostEntryId: entry.id,
            correctionGroupId,
            createdBy: context.actorId
          }) satisfies AcquisitionCostEntry;
          await tx.insertCostEntry(replacement);
          const advanced = await tx.compareAndSetSourceHead(head.revision, {
            ...head,
            currentLedgerEntryId: replacement.id,
            currentSourceVersion: replacement.sourceVersion,
            revision: head.revision + 1
          });
          if (!advanced) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          return { resourceId: replacement.id, operationId: correctionGroupId };
        });
      }
    );
    return execution.value;
  }
}
