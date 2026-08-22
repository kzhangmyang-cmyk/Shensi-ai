import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  type FinancialDataGapCode,
  type FinancialDataGapSourceType
} from "./growth-contract-types.js";

export interface FinancialDataGap {
  readonly code: FinancialDataGapCode;
  readonly sourceType: FinancialDataGapSourceType;
  readonly sourceId: string;
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly cohortId: string | null;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly recordedAt: string;
  readonly sourceSnapshotHash: `sha256:${string}`;
}

export interface FinancialDataGapVisibilityKeys {
  readonly candidateIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly dealIds: readonly string[];
  readonly cohortIds: readonly string[];
}

export interface FinancialDataGapSealedReader {
  listForBindingsAt(
    context: ActiveWorkspaceContext,
    input: {
      visibility: FinancialDataGapVisibilityKeys;
      currency: string;
      cutoff: GrowthSealedReadCutoff;
      limit: number;
    }
  ): Promise<readonly FinancialDataGap[]>;
  verifyAt(
    context: ActiveWorkspaceContext,
    input: {
      visibility: FinancialDataGapVisibilityKeys;
      sourceType: FinancialDataGapSourceType;
      sourceId: string;
      gapCode: FinancialDataGapCode;
      currency: string;
      cutoff: GrowthSealedReadCutoff;
      sourceSnapshotHash: `sha256:${string}`;
      cohortId: string | null;
    }
  ): Promise<FinancialDataGap | null>;
}

const GAP_CODES: ReadonlySet<string> = new Set([
  "unverified_cost",
  "unverified_financial_fact",
  "missing_cogs",
  "unmatched_payment",
  "missing_commercial_binding",
  "import_requires_review"
]);

const GAP_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "cost_entry",
  "financial_fact",
  "finance_import",
  "commercial_binding"
]);

export function assertFinancialDataGapCode(value: string): FinancialDataGapCode {
  if (!GAP_CODES.has(value)) {
    throw new Error("financial_data_gap_code_invalid");
  }
  return value as FinancialDataGapCode;
}

export function assertFinancialDataGapSourceType(
  value: string
): FinancialDataGapSourceType {
  if (!GAP_SOURCE_TYPES.has(value)) {
    throw new Error("financial_data_gap_source_invalid");
  }
  return value as FinancialDataGapSourceType;
}

function assertVisibility(
  visibility: FinancialDataGapVisibilityKeys
): FinancialDataGapVisibilityKeys {
  const bounded = <T,>(values: readonly T[]): readonly T[] => {
    if (!Array.isArray(values) || values.length > 100) {
      throw new Error("financial_data_gap_visibility_invalid");
    }
    const unique = [...new Set(values.map((value) => String(value)))] as T[];
    return Object.freeze(unique);
  };
  return Object.freeze({
    candidateIds: bounded(visibility.candidateIds),
    customerIds: bounded(visibility.customerIds),
    dealIds: bounded(visibility.dealIds),
    cohortIds: bounded(visibility.cohortIds)
  });
}

function authorized(
  value: string | null,
  allowed: readonly string[]
): boolean {
  return value === null || allowed.includes(value);
}

function hasAnyBinding(visibility: FinancialDataGapVisibilityKeys): boolean {
  return visibility.candidateIds.length > 0
    || visibility.customerIds.length > 0
    || visibility.dealIds.length > 0
    || visibility.cohortIds.length > 0;
}

function gapAuthorized(
  gap: FinancialDataGap,
  visibility: FinancialDataGapVisibilityKeys
): boolean {
  return authorized(gap.candidateId, visibility.candidateIds)
    && authorized(gap.customerId, visibility.customerIds)
    && authorized(gap.dealId, visibility.dealIds)
    && authorized(gap.cohortId, visibility.cohortIds);
}

export class FinancialDataGapAsOfBoundary {
  private readonly foundation: GrowthFoundationServices;
  private readonly sealedReader: FinancialDataGapSealedReader;
  private readonly now: () => string;
  private readonly visibilityFor: (
    context: ActiveWorkspaceContext
  ) => Promise<FinancialDataGapVisibilityKeys>;

  constructor(input: {
    foundation: GrowthFoundationServices;
    sealedReader: FinancialDataGapSealedReader;
    now?: () => string;
    visibilityFor?: (
      context: ActiveWorkspaceContext
    ) => Promise<FinancialDataGapVisibilityKeys>;
  }) {
    this.foundation = input.foundation;
    this.sealedReader = input.sealedReader;
    this.now = input.now ?? (() => new Date().toISOString());
    this.visibilityFor = input.visibilityFor ?? (async () => Object.freeze({
      candidateIds: Object.freeze([]),
      customerIds: Object.freeze([]),
      dealIds: Object.freeze([]),
      cohortIds: Object.freeze([])
    }));
  }

  async listForBindingsAsOf(
    context: ActiveWorkspaceContext,
    input: { currency: string; asOf: string; limit: number }
  ): Promise<readonly FinancialDataGap[]> {
    const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
      context, input.asOf
    );
    const visibility = await this.currentVisibility(context);
    return this.sealedReader.listForBindingsAt(context, {
      visibility,
      currency: input.currency,
      cutoff,
      limit: input.limit
    });
  }

  async verifyAsOf(
    context: ActiveWorkspaceContext,
    input: {
      sourceType: FinancialDataGapSourceType;
      sourceId: string;
      gapCode: FinancialDataGapCode;
      currency: string;
      asOf: string;
      sourceSnapshotHash: `sha256:${string}`;
      cohortId: string | null;
    }
  ): Promise<FinancialDataGap | null> {
    const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
      context, input.asOf
    );
    const visibility = await this.currentVisibility(context);
    return this.sealedReader.verifyAt(context, {
      visibility,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      gapCode: input.gapCode,
      currency: input.currency,
      cutoff,
      sourceSnapshotHash: input.sourceSnapshotHash,
      cohortId: input.cohortId
    });
  }

  private async currentVisibility(
    context: ActiveWorkspaceContext
  ): Promise<FinancialDataGapVisibilityKeys> {
    return this.visibilityFor(context);
  }
}

export class ValidatedFinancialDataGapSealedReader
implements FinancialDataGapSealedReader {
  constructor(
    private readonly delegate: FinancialDataGapSealedReader
  ) {}

  async listForBindingsAt(
    context: ActiveWorkspaceContext,
    input: {
      visibility: FinancialDataGapVisibilityKeys;
      currency: string;
      cutoff: GrowthSealedReadCutoff;
      limit: number;
    }
  ): Promise<readonly FinancialDataGap[]> {
    const visibility = assertVisibility(input.visibility);
    if (!hasAnyBinding(visibility)) return Object.freeze([]);
    const cutoff = assertGrowthSealedReadCutoff(
      input.cutoff, context.workspaceId
    );
    if (!Number.isSafeInteger(input.limit) || input.limit < 1
      || input.limit > 100) {
      throw new Error("financial_data_gap_limit_invalid");
    }
    const rows = await this.delegate.listForBindingsAt(context, {
      ...input,
      visibility,
      cutoff,
      limit: Math.min(100, input.limit)
    });
    return Object.freeze(rows.filter((gap) =>
      gapAuthorized(gap, visibility)).slice(0, 100));
  }

  async verifyAt(
    context: ActiveWorkspaceContext,
    input: {
      visibility: FinancialDataGapVisibilityKeys;
      sourceType: FinancialDataGapSourceType;
      sourceId: string;
      gapCode: FinancialDataGapCode;
      currency: string;
      cutoff: GrowthSealedReadCutoff;
      sourceSnapshotHash: `sha256:${string}`;
      cohortId: string | null;
    }
  ): Promise<FinancialDataGap | null> {
    const visibility = assertVisibility(input.visibility);
    if (!hasAnyBinding(visibility)) return null;
    const cutoff = assertGrowthSealedReadCutoff(
      input.cutoff, context.workspaceId
    );
    const found = await this.delegate.verifyAt(context, {
      ...input,
      visibility,
      cutoff
    });
    if (!found || !gapAuthorized(found, visibility)) return null;
    return found;
  }
}
