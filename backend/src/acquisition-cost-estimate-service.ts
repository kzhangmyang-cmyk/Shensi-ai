import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { requireExpectedRevision, type CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  canonicalGrowthRequestHash,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import { assertCurrencyCode, assertMinorAmount } from "./growth-money.js";
import {
  type AcquisitionCostEstimate,
  type AcquisitionCostEstimateLifecycleEvent
} from "./financial-ledger-domain.js";
import type {
  FinancialLedgerRepository,
  FinancialLedgerTransaction
} from "./financial-ledger-repository.js";
import { FinancialLedgerError } from "./acquisition-cost-ledger.js";
import { assertGrowthTemporalBarrier } from "./growth-temporal-barrier.js";

export interface AcquisitionCostEstimateDraftInput {
  cohortId: string | null;
  planId: string | null;
  runId: string | null;
  amountMinor: number;
  currency: string;
  source: AcquisitionCostEstimate["source"];
  sourceStableKey: string;
  inputSnapshotHash: string;
  validFrom: string;
  validTo: string | null;
}

type LifecycleInput = { estimateId: string; effectiveAt: string };

function text(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FinancialLedgerError(code, 422);
  }
  return value.trim();
}

function nullableText(value: string | null, code: string): string | null {
  return value === null ? null : text(value, code);
}

function timestamp(value: string, code = "invalid_cost_estimate_timestamp"): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new FinancialLedgerError(code, 422);
  return new Date(milliseconds).toISOString();
}

function hash(value: string): string {
  const normalized = text(value, "invalid_input_snapshot_hash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new FinancialLedgerError("invalid_input_snapshot_hash", 422);
  }
  return normalized;
}

function draftInput(input: AcquisitionCostEstimateDraftInput): AcquisitionCostEstimateDraftInput {
  const amountMinor = assertMinorAmount(input.amountMinor);
  if (amountMinor < 1) throw new FinancialLedgerError("invalid_cost_estimate_amount", 422);
  const validFrom = timestamp(input.validFrom);
  const validTo = input.validTo === null ? null : timestamp(input.validTo);
  if (validTo !== null && validTo <= validFrom) {
    throw new FinancialLedgerError("invalid_cost_estimate_window", 422);
  }
  if (!["approved_budget", "plan_budget", "provider_estimate", "manual_estimate"]
    .includes(input.source)) {
    throw new FinancialLedgerError("invalid_cost_estimate_source", 422);
  }
  return Object.freeze({
    cohortId: nullableText(input.cohortId, "invalid_cohort_id"),
    planId: nullableText(input.planId, "invalid_plan_id"),
    runId: nullableText(input.runId, "invalid_run_id"),
    amountMinor,
    currency: assertCurrencyCode(input.currency),
    source: input.source,
    sourceStableKey: text(input.sourceStableKey, "invalid_source_stable_key"),
    inputSnapshotHash: hash(input.inputSnapshotHash),
    validFrom,
    validTo
  });
}

function sameDraft(estimate: AcquisitionCostEstimate,
  input: AcquisitionCostEstimateDraftInput): boolean {
  return estimate.cohortId === input.cohortId
    && estimate.planId === input.planId
    && estimate.runId === input.runId
    && estimate.amountMinor === input.amountMinor
    && estimate.currency === input.currency
    && estimate.source === input.source
    && estimate.sourceStableKey === input.sourceStableKey
    && estimate.inputSnapshotHash === input.inputSnapshotHash
    && estimate.validFrom === input.validFrom
    && estimate.validTo === input.validTo;
}

function projection(estimate: AcquisitionCostEstimate,
  event: AcquisitionCostEstimateLifecycleEvent | null): AcquisitionCostEstimate {
  if (!event) return Object.freeze({ ...estimate, status: "draft", revision: 1,
    activatedAt: null });
  return Object.freeze({
    ...estimate,
    status: event.eventType === "activated" ? "active" : "superseded",
    revision: event.revision,
    activatedAt: event.eventType === "activated" ? event.recordedAt : null
  });
}

function estimateHeadRevision(
  events: readonly AcquisitionCostEstimateLifecycleEvent[]
): number {
  let replacementPairs = 0;
  for (const [index, event] of events.entries()) {
    if (event.eventType !== "activated" || event.supersedesEstimateId === null) continue;
    const prior = events[index - 1];
    if (!prior || prior.eventType !== "superseded"
      || prior.estimateId !== event.supersedesEstimateId
      || prior.effectiveAt !== event.effectiveAt) {
      throw new FinancialLedgerError("cost_estimate_history_invalid", 409);
    }
    replacementPairs += 1;
  }
  return events.length - replacementPairs;
}

function operationId(context: CommandContext, operation: string): string {
  return canonicalGrowthRequestHash({
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    operation
  });
}

export class AcquisitionCostEstimateService {
  private readonly now: () => string;
  private readonly requestExecutionId: () => string;

  constructor(private readonly input: {
    repository: FinancialLedgerRepository;
    foundation: GrowthFoundationServices;
    now?: () => string;
    requestExecutionId?: () => string;
  }) {
    assertGrowthTemporalBarrier(input.foundation.temporalBarrier);
    this.now = input.now ?? (() => new Date().toISOString());
    this.requestExecutionId = input.requestExecutionId ?? randomUUID;
  }

  private reservation(context: CommandContext, operation: string) {
    return {
      repository: this.input.foundation.httpIdempotency,
      reservation: {
        workspaceId: context.workspace.workspaceId,
        actorId: context.actorId,
        method: "POST" as const,
        canonicalPath: `/api/v1/acquisition/cost-estimates/${operation}`,
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        attemptedAt: this.now(),
        leaseOwner: this.requestExecutionId(),
        leaseDurationMs: 30_000
      }
    };
  }

  private async readProjection(workspaceId: string, estimateId: string,
    operation: string | null): Promise<AcquisitionCostEstimate> {
    const estimate = await this.input.repository.getCostEstimate(workspaceId, estimateId);
    if (!estimate) throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    const events = await this.input.repository.listCostEstimateLifecycleEvents(
      workspaceId, estimate.currency, estimate.sourceStableKey,
      "9999-12-31T23:59:59.999Z"
    );
    const event = operation === null ? null : events.find((item) => item.id === operation) ?? null;
    if (operation !== null && !event) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    return projection(estimate, event);
  }

  async createDraft(context: CommandContext,
    rawInput: AcquisitionCostEstimateDraftInput): Promise<AcquisitionCostEstimate> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const input = draftInput(rawInput);
    const stableEstimateId = operationId(context, "draft");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, "draft"),
      async (resourceId, persistedOperationId) => {
        requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
        if (!resourceId || persistedOperationId !== null) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const estimate = await this.readProjection(
          context.workspace.workspaceId, resourceId, null
        );
        if (!sameDraft(estimate, input)) {
          throw new FinancialLedgerError("idempotency_conflict", 409);
        }
        return estimate;
      },
      async () => this.input.repository.transaction(async (tx) => {
        const stamp = await this.input.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const active = await tx.getActiveCostEstimateForUpdate(
          context.workspace.workspaceId, input.currency, input.sourceStableKey
        );
        const events = await tx.listCostEstimateLifecycleEventsForUpdate(
          context.workspace.workspaceId, input.currency, input.sourceStableKey
        );
        const existing = await tx.getCostEstimateForUpdate(
          context.workspace.workspaceId, stableEstimateId
        );
        if (existing) {
          if (!sameDraft(existing, input)) {
            throw new FinancialLedgerError("idempotency_conflict", 409);
          }
          return { resourceId: existing.id, operationId: null };
        }
        const priorEstimate = active ?? (events.length === 0 ? null
          : await tx.getCostEstimateForUpdate(
            context.workspace.workspaceId, events.at(-1)!.estimateId
          ));
        if (events.length > 0 && !priorEstimate) {
          throw new FinancialLedgerError("cost_estimate_history_invalid", 409);
        }
        const version = (priorEstimate?.version ?? 0) + 1;
        if (!Number.isSafeInteger(version)) {
          throw new FinancialLedgerError("cost_estimate_version_exhausted", 409);
        }
        const estimate = Object.freeze({
          id: stableEstimateId,
          workspaceId: context.workspace.workspaceId,
          ...input,
          version,
          status: "draft" as const,
          sourceVersion: version,
          revision: 1,
          createdBy: context.actorId,
          createdAt: stamp.recordedAt,
          temporalSequence: stamp.temporalSequence,
          activatedAt: null
        }) satisfies AcquisitionCostEstimate;
        await tx.insertCostEstimate(estimate);
        return { resourceId: estimate.id, operationId: null };
      })
    );
    return execution.value;
  }

  async activate(context: CommandContext,
    rawInput: LifecycleInput): Promise<AcquisitionCostEstimate> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const expectedRevision = requireExpectedRevision(context);
    const input = {
      estimateId: text(rawInput.estimateId, "invalid_cost_estimate_id"),
      effectiveAt: timestamp(rawInput.effectiveAt)
    };
    const persistedEstimate = await this.input.repository.getCostEstimate(
      context.workspace.workspaceId, input.estimateId
    );
    if (!persistedEstimate) throw new FinancialLedgerError("cost_estimate_not_found", 404);
    const stableOperation = operationId(context, "activate");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, "activate"),
      async (resourceId, persistedOperationId) => {
        requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
        if (resourceId !== input.estimateId || persistedOperationId !== stableOperation) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        return this.readProjection(context.workspace.workspaceId,
          input.estimateId, stableOperation);
      },
      async () => this.input.repository.transaction(async (tx) => {
        const firstStamp = await this.input.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const active = await tx.getActiveCostEstimateForUpdate(
          context.workspace.workspaceId, persistedEstimate.currency,
          persistedEstimate.sourceStableKey
        );
        const events = await tx.listCostEstimateLifecycleEventsForUpdate(
          context.workspace.workspaceId, persistedEstimate.currency,
          persistedEstimate.sourceStableKey
        );
        const authoritative = await tx.getCostEstimateForUpdate(
          context.workspace.workspaceId, input.estimateId
        );
        if (!authoritative || authoritative.currency !== persistedEstimate.currency
          || authoritative.sourceStableKey !== persistedEstimate.sourceStableKey) {
          throw new FinancialLedgerError("cost_estimate_not_found", 404);
        }
        if (input.effectiveAt < authoritative.validFrom
          || (authoritative.validTo !== null
            && input.effectiveAt >= authoritative.validTo)
          || (events.length > 0
            && input.effectiveAt < events.at(-1)!.effectiveAt)) {
          throw new FinancialLedgerError("invalid_cost_estimate_effective_at", 422);
        }
        const existing = events.find((event) => event.id === stableOperation);
        if (existing) return { resourceId: authoritative.id, operationId: existing.id };
        if (events.some((event) => event.eventType === "activated"
          && event.estimateId === authoritative.id)) {
          throw new FinancialLedgerError("cost_estimate_already_activated", 409);
        }
        if (expectedRevision !== authoritative.revision) {
          throw new FinancialLedgerError("cost_estimate_revision_conflict", 412);
        }
        let sequence = events.length;
        if (active) {
          sequence += 1;
          await tx.appendCostEstimateLifecycleEvent(Object.freeze({
            id: operationId(context, "activate:supersede"),
            workspaceId: authoritative.workspaceId,
            currency: authoritative.currency,
            sourceStableKey: authoritative.sourceStableKey,
            estimateId: active.id,
            eventType: "superseded" as const,
            eventSequence: sequence,
            revision: sequence,
            effectiveAt: input.effectiveAt,
            supersedesEstimateId: null,
            actorId: context.actorId,
            recordedAt: firstStamp.recordedAt,
            temporalSequence: firstStamp.temporalSequence
          }));
        }
        const activationStamp = active
          ? await this.input.foundation.temporalBarrier.allocateAppend(
            tx, context.workspace.workspaceId
          ) : firstStamp;
        sequence += 1;
        await tx.appendCostEstimateLifecycleEvent(Object.freeze({
          id: stableOperation,
          workspaceId: authoritative.workspaceId,
          currency: authoritative.currency,
          sourceStableKey: authoritative.sourceStableKey,
          estimateId: authoritative.id,
          eventType: "activated" as const,
          eventSequence: sequence,
          revision: sequence,
          effectiveAt: input.effectiveAt,
          supersedesEstimateId: active?.id ?? null,
          actorId: context.actorId,
          recordedAt: activationStamp.recordedAt,
          temporalSequence: activationStamp.temporalSequence
        }));
        const updated = await tx.compareAndSetCostEstimateHead({
          workspaceId: authoritative.workspaceId,
          currency: authoritative.currency,
          sourceStableKey: authoritative.sourceStableKey,
          expectedRevision: estimateHeadRevision(events),
          activeEstimateId: authoritative.id,
          lastEventSequence: sequence
        });
        if (!updated) throw new FinancialLedgerError("cost_estimate_revision_conflict", 412);
        return { resourceId: authoritative.id, operationId: stableOperation };
      })
    );
    return execution.value;
  }

  async supersede(context: CommandContext,
    rawInput: LifecycleInput): Promise<AcquisitionCostEstimate> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const expectedRevision = requireExpectedRevision(context);
    const input = {
      estimateId: text(rawInput.estimateId, "invalid_cost_estimate_id"),
      effectiveAt: timestamp(rawInput.effectiveAt)
    };
    const persistedEstimate = await this.input.repository.getCostEstimate(
      context.workspace.workspaceId, input.estimateId
    );
    if (!persistedEstimate) throw new FinancialLedgerError("cost_estimate_not_found", 404);
    const stableOperation = operationId(context, "supersede");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, "supersede"),
      async (resourceId, persistedOperationId) => {
        requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
        if (resourceId !== input.estimateId || persistedOperationId !== stableOperation) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        return this.readProjection(context.workspace.workspaceId,
          input.estimateId, stableOperation);
      },
      async () => this.input.repository.transaction(async (tx) => {
        const stamp = await this.input.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const active = await tx.getActiveCostEstimateForUpdate(
          context.workspace.workspaceId, persistedEstimate.currency,
          persistedEstimate.sourceStableKey
        );
        const events = await tx.listCostEstimateLifecycleEventsForUpdate(
          context.workspace.workspaceId, persistedEstimate.currency,
          persistedEstimate.sourceStableKey
        );
        const existing = events.find((event) => event.id === stableOperation);
        if (existing) {
          return { resourceId: input.estimateId, operationId: existing.id };
        }
        if (!active || active.id !== input.estimateId) {
          throw new FinancialLedgerError("cost_estimate_not_active", 409);
        }
        if (input.effectiveAt < active.validFrom
          || (events.length > 0
            && input.effectiveAt < events.at(-1)!.effectiveAt)) {
          throw new FinancialLedgerError("invalid_cost_estimate_effective_at", 422);
        }
        if (expectedRevision !== events.length) {
          throw new FinancialLedgerError("cost_estimate_revision_conflict", 412);
        }
        const sequence = events.length + 1;
        await tx.appendCostEstimateLifecycleEvent(Object.freeze({
          id: stableOperation,
          workspaceId: active.workspaceId,
          currency: active.currency,
          sourceStableKey: active.sourceStableKey,
          estimateId: active.id,
          eventType: "superseded" as const,
          eventSequence: sequence,
          revision: sequence,
          effectiveAt: input.effectiveAt,
          supersedesEstimateId: null,
          actorId: context.actorId,
          recordedAt: stamp.recordedAt,
          temporalSequence: stamp.temporalSequence
        }));
        const updated = await tx.compareAndSetCostEstimateHead({
          workspaceId: active.workspaceId,
          currency: active.currency,
          sourceStableKey: active.sourceStableKey,
          expectedRevision: estimateHeadRevision(events),
          activeEstimateId: null,
          lastEventSequence: sequence
        });
        if (!updated) throw new FinancialLedgerError("cost_estimate_revision_conflict", 412);
        return { resourceId: active.id, operationId: stableOperation };
      })
    );
    return execution.value;
  }

  /** Internal provider projection path. All identity and version fields are server-derived. */
  async createAndActivateProjected(context: CommandContext, input: {
    cohortId?: string | null;
    planId?: string | null;
    runId: string;
    amountMinor: number;
    currency: string;
    sourceStableKey: string;
    inputSnapshotHash: string;
    validFrom: string;
  }): Promise<AcquisitionCostEstimate> {
    const draft = await this.createDraft(context, {
      cohortId: input.cohortId ?? null,
      planId: input.planId ?? null,
      runId: input.runId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      source: "provider_estimate",
      sourceStableKey: input.sourceStableKey,
      inputSnapshotHash: input.inputSnapshotHash,
      validFrom: input.validFrom,
      validTo: null
    });
    return this.activate(Object.freeze({ ...context, expectedRevision: 1,
      idempotencyKey: `${context.idempotencyKey}:activate`,
      requestHash: canonicalGrowthRequestHash({
        draftId: draft.id, effectiveAt: input.validFrom
      }) }), { estimateId: draft.id, effectiveAt: input.validFrom });
  }
}
