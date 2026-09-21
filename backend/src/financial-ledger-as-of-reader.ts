import { assertGrowthAsOfNotFuture, growthInstantMilliseconds } from "./growth-as-of.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import {
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type FinancialFact,
  type FinancialFactProvenance,
  type FinancialFactType,
  type LedgerType,
  type LedgerVerificationEvent,
  type VerifiedCostProvenance
} from "./financial-ledger-domain.js";
import type { FinancialLedgerRepository } from "./financial-ledger-repository.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface VerifiedLedgerSnapshotBase {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly sourceIdentityRoot: string;
  readonly sourceVersion: number;
  readonly amountMinor: number;
  readonly netAmountMinor: number;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly entryRecordedAt: string;
  readonly entryTemporalSequence: number;
  readonly sourceRef: string | null;
  readonly externalId: string | null;
  readonly correctionGroupId: string | null;
  readonly createdBy: string;
  readonly verificationEventId: string;
  readonly verificationRevision: number;
  readonly verificationRecordedAt: string;
  readonly verificationTemporalSequence: number;
  readonly verificationContentHash: `sha256:${string}`;
  readonly entryContentHash: `sha256:${string}`;
  readonly snapshotHash: `sha256:${string}`;
}

export interface VerifiedCostLedgerRow extends VerifiedLedgerSnapshotBase {
  readonly ledgerType: "cost";
  readonly platform: string;
  readonly planId: string | null;
  readonly runId: string | null;
  readonly providerId: string | null;
  readonly costCategory: AcquisitionCostEntry["category"];
  readonly provenance: VerifiedCostProvenance;
  readonly evidenceHash: string;
  readonly correctsCostEntryId: string | null;
  readonly estimateReconciliationId: string | null;
}

export interface VerifiedFinancialFactLedgerRow extends VerifiedLedgerSnapshotBase {
  readonly ledgerType: "financial";
  readonly factType: FinancialFactType;
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly quoteVersionId: string | null;
  readonly provenance: FinancialFactProvenance;
  readonly evidenceHash: string;
  readonly attributionSnapshotHash: `sha256:${string}` | null;
  readonly commercialBindingHash: string | null;
  readonly commercialBindingSnapshotHash: `sha256:${string}` | null;
  readonly commercialAmountHash: string | null;
  readonly dealAuthorityRevision: number | null;
  readonly correctsFactId: string | null;
}

export type VerifiedLedgerRow = VerifiedCostLedgerRow | VerifiedFinancialFactLedgerRow;

export interface VerifiedFinancialLedgerSealedReader {
  getVerifiedAt(cutoff: GrowthSealedReadCutoff, input: {
    ledgerType: "cost" | "financial";
    entryId: string;
    currency: string;
  }): Promise<VerifiedLedgerRow | null>;
  listVerifiedCostsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]>;
  listVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]>;
}

export interface WorkspaceVerifiedFinancialLedgerSealedReader
extends VerifiedFinancialLedgerSealedReader {
  listWorkspaceVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    limit: number;
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]>;
}

export interface VerifiedFinancialLedgerAsOfReader {
  getVerifiedAt(context: ActiveWorkspaceContext, input: {
    ledgerType: "cost" | "financial";
    entryId: string;
    currency: string;
    asOf: string;
  }): Promise<VerifiedLedgerRow | null>;
  listVerifiedCostsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string;
    asOf: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]>;
  listVerifiedFactsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string;
    asOf: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]>;
}

interface FinancialLedgerHistoricalRepository extends Pick<FinancialLedgerRepository,
  "getCostEntry" | "getFinancialFact" | "listFinancialFacts"> {
  listVerificationEvents(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string): Promise<LedgerVerificationEvent[]>;
}

const contentHash = (value: unknown) =>
  canonicalGrowthRequestHash(value) as `sha256:${string}`;

function verifiedBase(
  entry: AcquisitionCostEntry | FinancialFact,
  event: LedgerVerificationEvent
) {
  return {
    workspaceId: entry.workspaceId,
    entryId: entry.id,
    sourceIdentityRoot: entry.sourceIdentityRoot,
    sourceVersion: entry.sourceVersion,
    amountMinor: entry.amountMinor,
    netAmountMinor: entry.amountMinor,
    currency: entry.currency,
    businessOccurredAt: entry.businessOccurredAt,
    entryRecordedAt: entry.recordedAt,
    entryTemporalSequence: entry.temporalSequence,
    sourceRef: entry.sourceRef,
    externalId: entry.externalId,
    correctionGroupId: entry.correctionGroupId,
    createdBy: entry.createdBy,
    verificationEventId: event.id,
    verificationRevision: event.revision,
    verificationRecordedAt: event.recordedAt,
    verificationTemporalSequence: event.temporalSequence,
    verificationContentHash: contentHash(event),
    entryContentHash: contentHash(entry)
  } as const;
}

export function projectVerifiedFinancialFact(
  entry: FinancialFact,
  event: LedgerVerificationEvent
): VerifiedFinancialFactLedgerRow {
  const draft = {
    ...verifiedBase(entry, event),
    ledgerType: "financial" as const,
    factType: entry.factType,
    candidateId: entry.candidateId,
    customerId: entry.customerId,
    dealId: entry.dealId,
    quoteVersionId: entry.quoteVersionId,
    provenance: entry.provenance,
    evidenceHash: entry.evidenceHash,
    attributionSnapshotHash: entry.attributionSnapshot === null
      ? null : contentHash(entry.attributionSnapshot),
    commercialBindingHash: entry.commercialBindingSnapshot?.bindingHash ?? null,
    commercialBindingSnapshotHash: entry.commercialBindingSnapshot === null
      ? null : contentHash(entry.commercialBindingSnapshot),
    commercialAmountHash: entry.commercialAmountHash,
    dealAuthorityRevision: entry.dealAuthorityRevision,
    correctsFactId: entry.correctsFactId
  } as const;
  return Object.freeze({ ...draft, snapshotHash: contentHash(draft) });
}

export function projectVerifiedCost(
  entry: AcquisitionCostEntry,
  event: LedgerVerificationEvent
): VerifiedCostLedgerRow {
  const draft = {
    ...verifiedBase(entry, event),
    ledgerType: "cost" as const,
    platform: entry.platform,
    planId: entry.planId,
    runId: entry.runId,
    providerId: entry.providerId,
    costCategory: entry.category,
    provenance: entry.provenance,
    evidenceHash: entry.evidenceHash,
    correctsCostEntryId: entry.correctsCostEntryId,
    estimateReconciliationId: entry.estimateReconciliationId
  } as const;
  return Object.freeze({ ...draft, snapshotHash: contentHash(draft) });
}

function concreteText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function boundedEntryIds(entryIds: readonly string[]): readonly string[] {
  if (!Array.isArray(entryIds) || entryIds.length > 500) {
    throw new Error("invalid_ledger_entry_ids");
  }
  const normalized = entryIds.map((entryId) =>
    concreteText(entryId, "invalid_ledger_entry_ids"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("invalid_ledger_entry_ids");
  }
  return normalized;
}

function atOrBefore(value: string, cutoff: string): boolean {
  return growthInstantMilliseconds(value) <= growthInstantMilliseconds(cutoff);
}

function stableRows<T extends VerifiedLedgerRow>(rows: T[]): readonly T[] {
  return Object.freeze(rows.sort((left, right) =>
    growthInstantMilliseconds(left.businessOccurredAt)
      - growthInstantMilliseconds(right.businessOccurredAt)
    || (left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0)));
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("invalid_ledger_limit");
  }
  return limit;
}

export class RepositoryVerifiedFinancialLedgerSealedReader
implements WorkspaceVerifiedFinancialLedgerSealedReader {
  constructor(private readonly repository: FinancialLedgerHistoricalRepository) {}

  private trusted(cutoff: GrowthSealedReadCutoff): GrowthSealedReadCutoff {
    if (!cutoff || typeof cutoff.workspaceId !== "string"
      || !cutoff.workspaceId.trim() || cutoff.workspaceId === "all") {
      throw new Error("invalid_workspace");
    }
    return assertGrowthSealedReadCutoff(cutoff, cutoff.workspaceId);
  }

  private async verifiedEvent(
    cutoff: GrowthSealedReadCutoff,
    ledgerType: LedgerType,
    entryId: string
  ): Promise<LedgerVerificationEvent | null> {
    const prefix = (await this.repository.listVerificationEvents(
      cutoff.workspaceId, ledgerType, entryId
    )).filter((event) =>
      atOrBefore(event.recordedAt, cutoff.effectiveAsOf)
      && event.temporalSequence <= cutoff.temporalSequence)
      .sort((left, right) =>
        left.eventSequence - right.eventSequence || left.revision - right.revision);
    if (ledgerEntryStatus(prefix) !== "verified") return null;
    return prefix.find((event) => event.eventType === "verified") ?? null;
  }

  private visible(
    cutoff: GrowthSealedReadCutoff,
    entry: AcquisitionCostEntry | FinancialFact | null,
    currency: string
  ): entry is AcquisitionCostEntry | FinancialFact {
    return Boolean(entry
      && entry.workspaceId === cutoff.workspaceId
      && entry.currency === currency
      && entry.amountMinor !== 0
      && atOrBefore(entry.businessOccurredAt, cutoff.effectiveAsOf)
      && atOrBefore(entry.recordedAt, cutoff.effectiveAsOf)
      && entry.temporalSequence <= cutoff.temporalSequence);
  }

  async getVerifiedAt(cutoff: GrowthSealedReadCutoff, input: {
    ledgerType: "cost" | "financial";
    entryId: string;
    currency: string;
  }): Promise<VerifiedLedgerRow | null> {
    const trusted = this.trusted(cutoff);
    const entryId = concreteText(input.entryId, "invalid_ledger_entry_id");
    const currency = concreteText(input.currency, "invalid_currency");
    if (input.ledgerType === "cost") {
      const entry = await this.repository.getCostEntry(trusted.workspaceId, entryId);
      if (!this.visible(trusted, entry, currency)) return null;
      const event = await this.verifiedEvent(trusted, "cost", entryId);
      return event ? projectVerifiedCost(entry, event) : null;
    }
    if (input.ledgerType === "financial") {
      const entry = await this.repository.getFinancialFact(trusted.workspaceId, entryId);
      if (!this.visible(trusted, entry, currency)) return null;
      const event = await this.verifiedEvent(trusted, "financial", entryId);
      return event ? projectVerifiedFinancialFact(entry, event) : null;
    }
    throw new Error("invalid_ledger_type");
  }

  async listVerifiedCostsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const rows = await Promise.all(boundedEntryIds(input.entryIds).map(async (entryId) => {
      const row = await this.getVerifiedAt(trusted, {
        ledgerType: "cost", entryId, currency
      });
      return row?.ledgerType === "cost" ? row : null;
    }));
    return stableRows(rows.filter((row): row is VerifiedCostLedgerRow => row !== null));
  }

  async listVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const rows = await Promise.all(boundedEntryIds(input.entryIds).map(async (entryId) => {
      const row = await this.getVerifiedAt(trusted, {
        ledgerType: "financial", entryId, currency
      });
      return row?.ledgerType === "financial" ? row : null;
    }));
    return stableRows(rows.filter(
      (row): row is VerifiedFinancialFactLedgerRow => row !== null
    ));
  }

  async listWorkspaceVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    limit: number;
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const limit = boundedLimit(input.limit);
    const candidates = await this.repository.listFinancialFacts(
      trusted.workspaceId
    );
    const rows = await Promise.all(candidates.map(async (entry) => {
      if (!this.visible(trusted, entry, currency)) return null;
      const row = await this.getVerifiedAt(trusted, {
        ledgerType: "financial", entryId: entry.id, currency
      });
      return row?.ledgerType === "financial" ? row : null;
    }));
    return Object.freeze(stableRows(rows.filter(
      (row): row is VerifiedFinancialFactLedgerRow => row !== null
    )).slice(0, limit));
  }
}

export class VerifiedFinancialLedgerAsOfBoundary
implements VerifiedFinancialLedgerAsOfReader {
  private readonly foundation: GrowthFoundationServices;
  private readonly sealedReader: VerifiedFinancialLedgerSealedReader;
  private readonly now: () => string;

  constructor(input: {
    foundation: GrowthFoundationServices;
    sealedReader: VerifiedFinancialLedgerSealedReader;
    now?: () => string;
  }) {
    this.foundation = input.foundation;
    this.sealedReader = input.sealedReader;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  private async cutoff(context: ActiveWorkspaceContext, asOf: string) {
    const readStartedAt = this.now();
    requireGrowthCapabilities(context, ["ledger.pending.create"]);
    const effectiveAsOf = assertGrowthAsOfNotFuture(asOf, readStartedAt, 1_000);
    return this.foundation.temporalBarrier.sealReadCutoff(context, effectiveAsOf);
  }

  async getVerifiedAt(context: ActiveWorkspaceContext, input: {
    ledgerType: "cost" | "financial";
    entryId: string;
    currency: string;
    asOf: string;
  }): Promise<VerifiedLedgerRow | null> {
    const cutoff = await this.cutoff(context, input.asOf);
    return this.sealedReader.getVerifiedAt(cutoff, {
      ledgerType: input.ledgerType, entryId: input.entryId, currency: input.currency
    });
  }

  async listVerifiedCostsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string;
    asOf: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]> {
    const cutoff = await this.cutoff(context, input.asOf);
    return this.sealedReader.listVerifiedCostsAt(cutoff, {
      currency: input.currency, entryIds: input.entryIds
    });
  }

  async listVerifiedFactsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string;
    asOf: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]> {
    const cutoff = await this.cutoff(context, input.asOf);
    return this.sealedReader.listVerifiedFactsAt(cutoff, {
      currency: input.currency, entryIds: input.entryIds
    });
  }
}
