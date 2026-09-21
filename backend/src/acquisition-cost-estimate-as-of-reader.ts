import { FinancialLedgerError } from "./acquisition-cost-ledger.js";
import { assertGrowthAsOfNotFuture, growthInstantMilliseconds } from "./growth-as-of.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import type {
  AcquisitionCostEstimate,
  AcquisitionCostEstimateLifecycleEvent
} from "./financial-ledger-domain.js";
import type { FinancialLedgerRepository } from "./financial-ledger-repository.js";
import {
  assertGrowthTemporalBarrier,
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface AcquisitionCostEstimateAsOfReader {
  getActiveAsOf(workspace: ActiveWorkspaceContext, input: {
    currency: string;
    sourceStableKey: string;
    asOf: string;
  }): Promise<AcquisitionCostEstimate | null>;
}

export interface AcquisitionCostEstimateSealedReader {
  getActiveAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    sourceStableKey: string;
  }): Promise<AcquisitionCostEstimate | null>;
}

function instant(value: string): number {
  try {
    return growthInstantMilliseconds(value);
  } catch {
    throw new Error("cost_estimate_history_invalid");
  }
}

export function activeCostEstimateIdAsOf(
  events: readonly AcquisitionCostEstimateLifecycleEvent[],
  asOf: string
): string | null {
  const cutoff = instant(asOf);
  const recorded = events.filter((event) => instant(event.recordedAt) <= cutoff)
    .sort((left, right) => left.eventSequence - right.eventSequence);
  for (const [index, event] of recorded.entries()) {
    if (!event.id.trim() || !event.workspaceId.trim()
      || event.workspaceId === "all" || !event.currency.trim()
      || !event.sourceStableKey.trim() || !event.estimateId.trim()
      || !event.actorId.trim() || !Number.isSafeInteger(event.temporalSequence)
      || event.temporalSequence < 1
      || event.eventSequence !== index + 1 || event.revision !== index + 1
      || (index > 0 && (event.workspaceId !== recorded[0]!.workspaceId
        || event.currency !== recorded[0]!.currency
        || event.sourceStableKey !== recorded[0]!.sourceStableKey))) {
      throw new Error("cost_estimate_history_invalid");
    }
    instant(event.effectiveAt);
  }
  let activeEstimateId: string | null = null;
  let mostRecentlySuperseded: string | null = null;
  const effective = recorded.filter((event) => instant(event.effectiveAt) <= cutoff)
    .sort((left, right) => instant(left.effectiveAt) - instant(right.effectiveAt)
      || left.eventSequence - right.eventSequence);
  for (const event of effective) {
    if (event.eventType === "superseded") {
      if (activeEstimateId !== event.estimateId
        || event.supersedesEstimateId !== null) {
        throw new Error("cost_estimate_history_invalid");
      }
      mostRecentlySuperseded = event.estimateId;
      activeEstimateId = null;
      continue;
    }
    if (activeEstimateId !== null
      || event.supersedesEstimateId !== mostRecentlySuperseded) {
      throw new Error("cost_estimate_history_invalid");
    }
    activeEstimateId = event.estimateId;
    mostRecentlySuperseded = null;
  }
  return activeEstimateId;
}

export async function getActiveEstimateAt(
  repository: FinancialLedgerRepository,
  cutoff: GrowthSealedReadCutoff,
  input: { currency: string; sourceStableKey: string }
): Promise<AcquisitionCostEstimate | null> {
  if (!cutoff || typeof cutoff.workspaceId !== "string"
    || !cutoff.workspaceId.trim() || cutoff.workspaceId === "all") {
    throw new FinancialLedgerError("invalid_workspace", 403);
  }
  const trusted = assertGrowthSealedReadCutoff(cutoff, cutoff.workspaceId);
  if (!/^[A-Z]{3}$/u.test(input.currency)
    || typeof input.sourceStableKey !== "string" || !input.sourceStableKey.trim()) {
    throw new FinancialLedgerError("invalid_cost_estimate_query", 422);
  }
  const events = (await repository.listCostEstimateLifecycleEvents(
    trusted.workspaceId, input.currency, input.sourceStableKey,
    trusted.effectiveAsOf
  )).filter((event) => event.temporalSequence <= trusted.temporalSequence);
  const activeEstimateId = activeCostEstimateIdAsOf(events, trusted.effectiveAsOf);
  if (activeEstimateId === null) return null;
  const estimate = await repository.getCostEstimate(
    trusted.workspaceId, activeEstimateId
  );
  if (!estimate || estimate.workspaceId !== trusted.workspaceId
    || estimate.currency !== input.currency
    || estimate.sourceStableKey !== input.sourceStableKey
    || instant(estimate.createdAt) > instant(trusted.effectiveAsOf)
    || estimate.temporalSequence > trusted.temporalSequence) {
    throw new Error("cost_estimate_history_invalid");
  }
  const activation = [...events].reverse().find((event) => event.eventType === "activated"
    && event.estimateId === activeEstimateId
    && instant(event.effectiveAt) <= instant(trusted.effectiveAsOf));
  if (!activation) throw new Error("cost_estimate_history_invalid");
  return Object.freeze({
    ...estimate,
    status: "active" as const,
    revision: activation.revision,
    activatedAt: activation.recordedAt
  });
}

export class RepositoryAcquisitionCostEstimateSealedReader
implements AcquisitionCostEstimateSealedReader {
  constructor(private readonly repository: FinancialLedgerRepository) {}

  getActiveAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    sourceStableKey: string;
  }): Promise<AcquisitionCostEstimate | null> {
    return getActiveEstimateAt(this.repository, cutoff, input);
  }
}

export class AcquisitionCostEstimateAsOfBoundary
implements AcquisitionCostEstimateAsOfReader {
  private readonly now: () => string;

  constructor(private readonly input: {
    foundation: GrowthFoundationServices;
    sealedReader: AcquisitionCostEstimateSealedReader;
    now?: () => string;
  }) {
    assertGrowthTemporalBarrier(input.foundation.temporalBarrier);
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async getActiveAsOf(workspace: ActiveWorkspaceContext, input: {
    currency: string;
    sourceStableKey: string;
    asOf: string;
  }): Promise<AcquisitionCostEstimate | null> {
    const readStartedAt = this.now();
    requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
    const effectiveAsOf = assertGrowthAsOfNotFuture(
      input.asOf, readStartedAt, 1_000
    );
    const cutoff = await this.input.foundation.temporalBarrier.sealReadCutoff(
      workspace, effectiveAsOf
    );
    return this.input.sealedReader.getActiveAt(cutoff, {
      currency: input.currency,
      sourceStableKey: input.sourceStableKey
    });
  }
}
