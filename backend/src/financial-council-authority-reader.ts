import type {
  AdvisorRoiSliceView,
  FinancialDataGapView,
  GrowthAdvisorSealedQueryService,
  PendingQuoteApprovalView,
  PriorityCustomerView
} from "./growth-advisor-query.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type { FinancialFactType } from "./financial-ledger-domain.js";
import type { WorkspaceVerifiedFinancialLedgerSealedReader } from
  "./financial-ledger-as-of-reader.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const MAX_UNTRUSTED_TEXT = 1_000;
const QUERY_LIMIT = 100;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const FACT_TYPES = new Set<string>([
  "contract_won", "payment_received", "revenue_recognized",
  "cogs_recognized", "refund", "bad_debt_written_off"
]);
const GAP_CODES = new Set<string>([
  "unverified_cost", "unverified_financial_fact", "missing_cogs",
  "unmatched_payment", "missing_commercial_binding", "import_requires_review"
]);
const GAP_SOURCES = new Set<string>([
  "cost_entry", "financial_fact", "finance_import", "commercial_binding"
]);
const EXPECTED_ROI_REASONS = new Set<unknown>([
  "cost_missing", "attribution_incomplete", "zero_estimated_cost"
]);
const ACTUAL_ROI_REASONS = new Set<unknown>([
  "cost_missing", "cost_not_closed", "gross_profit_unverified",
  "cash_reconciliation_incomplete", "attribution_incomplete",
  "multi_currency_without_fx", "zero_estimated_cost", "zero_cost",
  "query_truncated", "cohort_not_closed"
]);

export interface FinancialCouncilVerifiedFactSource {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly sourceVersion: number;
  readonly factType: FinancialFactType;
  readonly amountMinor: number;
  readonly netAmountMinor: number;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly entryRecordedAt: string;
  readonly verificationRevision: number;
  readonly verificationRecordedAt: string;
  readonly snapshotHash: `sha256:${string}`;
}

export interface FinancialCouncilVerifiedFactsReader {
  listVisibleAt(
    context: ActiveWorkspaceContext,
    input: {
      readonly currency: string;
      readonly cutoff: GrowthSealedReadCutoff;
      readonly limit: number;
    }
  ): Promise<readonly FinancialCouncilVerifiedFactSource[]>;
}

interface VerifiedFactCommon {
  readonly entryId: string;
  readonly sourceVersion: number;
  readonly factType: FinancialFactType;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly entryRecordedAt: string;
  readonly verificationRevision: number;
  readonly verificationRecordedAt: string;
  readonly snapshotHash: `sha256:${string}`;
}

export type FinancialCouncilVerifiedFactView = VerifiedFactCommon & (
  | {
      readonly amountVisibility: "full";
      readonly amountMinor: number;
      readonly netAmountMinor: number;
    }
  | { readonly amountVisibility: "redacted" }
);

export interface FinancialCouncilAuthoritySnapshot {
  readonly workspaceId: string;
  readonly currency: string;
  readonly dataAsOf: string;
  readonly projectionLevel: "full" | "redacted";
  readonly priorityCustomers: readonly PriorityCustomerView[];
  readonly pendingQuoteApprovals: readonly PendingQuoteApprovalView[];
  readonly verifiedFinancialFacts: readonly FinancialCouncilVerifiedFactView[];
  readonly expectedRoi: readonly AdvisorRoiSliceView[];
  readonly actualRoi: readonly AdvisorRoiSliceView[];
  readonly dataGaps: readonly FinancialDataGapView[];
  readonly sourceSnapshotHash: `sha256:${string}`;
}

export interface FinancialCouncilAuthorityReaderDependencies {
  readonly advisor: Pick<GrowthAdvisorSealedQueryService, "getTodayAt">;
  readonly verifiedFacts: FinancialCouncilVerifiedFactsReader;
}

function authorityError(code: string): never {
  throw financialCouncilError(code);
}

function text(value: unknown, code: string, max = 191): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    return authorityError(code);
  }
  return value;
}

function untrustedText(value: unknown): string {
  if (typeof value !== "string") return authorityError("financial_council_authority_invalid");
  return value.slice(0, MAX_UNTRUSTED_TEXT);
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    return authorityError("financial_council_authority_invalid");
  }
  return value as number;
}

function bps(value: unknown): number {
  const result = safeInteger(value);
  if (result < 0 || result > 10_000) {
    return authorityError("financial_council_authority_invalid");
  }
  return result;
}

function hash(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !HASH.test(value)) {
    return authorityError("financial_council_authority_invalid");
  }
  return value as `sha256:${string}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalKey(...parts: readonly (string | null)[]): string {
  return parts.map((part) => part === null ? "-1:" : `${part.length}:${part}`)
    .join("");
}

function canonicalAuthorityRows<Input, Output>(
  rows: readonly Input[],
  project: (row: Input) => Output,
  sortKey: (row: Output) => string,
  identityKey: (row: Output) => string = sortKey
): readonly Output[] {
  const projected = rows.map(project).sort((left, right) =>
    compare(sortKey(left), sortKey(right)));
  if (projected.length >= QUERY_LIMIT) {
    return authorityError("financial_council_authority_query_truncated");
  }
  const identities = new Set<string>();
  for (const row of projected) {
    const identity = identityKey(row);
    if (identities.has(identity)) {
      return authorityError("financial_council_authority_duplicate");
    }
    identities.add(identity);
  }
  return Object.freeze(projected);
}

function exactAuthorityObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return authorityError("financial_council_authority_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => typeof key === "string"
      && !required.includes(key) && !optional.includes(key))) {
    return authorityError("financial_council_authority_invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return authorityError("financial_council_authority_invalid");
    }
  }
}

function exactAuthorityRows(
  value: unknown,
  shape: (row: Record<string, unknown>) => readonly string[]
): void {
  if (!Array.isArray(value) || value.length >= QUERY_LIMIT) {
    return authorityError("financial_council_authority_invalid");
  }
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return authorityError("financial_council_authority_invalid");
    }
    exactAuthorityObject(row, shape(row as Record<string, unknown>));
  }
}

function assertCanonicalAuthorityOrder(
  value: unknown,
  keyOf: (row: Record<string, unknown>) => string
): void {
  const rows = value as readonly Record<string, unknown>[];
  let previous: string | null = null;
  for (const row of rows) {
    const current = keyOf(row);
    if (previous !== null && compare(previous, current) >= 0) {
      return authorityError("financial_council_authority_invalid");
    }
    previous = current;
  }
}

function assertProjectedAuthorityRows(
  value: unknown,
  project: (row: Record<string, unknown>) => unknown
): void {
  for (const row of value as readonly Record<string, unknown>[]) {
    if (financialCouncilCanonicalHash(project(row))
      !== financialCouncilCanonicalHash(row)) {
      return authorityError("financial_council_authority_invalid");
    }
  }
}

function projectPersistedFact(
  row: Record<string, unknown>,
  sensitive: boolean
): FinancialCouncilVerifiedFactView {
  if (!FACT_TYPES.has(String(row.factType))) {
    return authorityError("financial_council_authority_invalid");
  }
  const common = {
    entryId: text(row.entryId, "financial_council_authority_invalid"),
    sourceVersion: safeInteger(row.sourceVersion),
    factType: row.factType as FinancialFactType,
    currency: text(row.currency, "financial_council_authority_invalid", 3),
    businessOccurredAt: text(row.businessOccurredAt,
      "financial_council_authority_invalid", 35),
    entryRecordedAt: text(row.entryRecordedAt,
      "financial_council_authority_invalid", 35),
    verificationRevision: safeInteger(row.verificationRevision),
    verificationRecordedAt: text(row.verificationRecordedAt,
      "financial_council_authority_invalid", 35),
    snapshotHash: hash(row.snapshotHash)
  };
  if (!sensitive) return Object.freeze({
    ...common, amountVisibility: "redacted" as const
  });
  return Object.freeze({
    ...common,
    amountVisibility: "full" as const,
    amountMinor: safeInteger(row.amountMinor),
    netAmountMinor: safeInteger(row.netAmountMinor)
  });
}

/** The single closed runtime validator for produced and persisted authority. */
export function validateFinancialCouncilAuthoritySnapshot(
  value: unknown
): FinancialCouncilAuthoritySnapshot {
  const stable = immutableFinancialCouncilInput(value) as unknown;
  exactAuthorityObject(stable, ["workspaceId", "currency", "dataAsOf",
    "projectionLevel", "priorityCustomers", "pendingQuoteApprovals",
    "verifiedFinancialFacts", "expectedRoi", "actualRoi", "dataGaps",
    "sourceSnapshotHash"]);
  text(stable.workspaceId, "financial_council_authority_invalid");
  if (stable.currency !== "CNY" && stable.currency !== "USD") {
    return authorityError("financial_council_authority_invalid");
  }
  text(stable.dataAsOf, "financial_council_authority_invalid", 35);
  if (stable.projectionLevel !== "full"
    && stable.projectionLevel !== "redacted") {
    return authorityError("financial_council_authority_invalid");
  }
  exactAuthorityRows(stable.priorityCustomers, () => ["candidateId",
    "customerId", "dealId", "displayName", "priorityScoreBps",
    "qualificationDecisionId", "qualificationDecisionVersion",
    "inputSnapshotHash"]);
  assertCanonicalAuthorityOrder(stable.priorityCustomers,
    (row) => canonicalKey(String(row.candidateId)));
  assertProjectedAuthorityRows(stable.priorityCustomers,
    (row) => projectPriority(row as unknown as PriorityCustomerView));
  exactAuthorityRows(stable.pendingQuoteApprovals, (row) => row.currency === undefined
    ? ["approvalId", "quoteVersionId", "quoteVersionRevision", "quoteCaseId",
        "approvalKind", "requiredCapabilities", "submittedAt", "expiresAt"]
    : ["approvalId", "quoteVersionId", "quoteVersionRevision", "quoteCaseId",
        "approvalKind", "requiredCapabilities", "submittedAt", "expiresAt",
        "currency", "quotedAmountMinor", "estimatedGrossProfitMinor",
        "estimatedContributionMinor", "grossMarginBps"]);
  assertCanonicalAuthorityOrder(stable.pendingQuoteApprovals,
    (row) => canonicalKey(String(row.quoteVersionId), String(row.approvalId)));
  assertProjectedAuthorityRows(stable.pendingQuoteApprovals,
    (row) => projectApproval(
      row as unknown as PendingQuoteApprovalView,
      stable.projectionLevel === "full"
    ));
  exactAuthorityRows(stable.verifiedFinancialFacts, (row) =>
    row.amountVisibility === "full"
      ? ["entryId", "sourceVersion", "factType", "currency",
          "businessOccurredAt", "entryRecordedAt", "verificationRevision",
          "verificationRecordedAt", "snapshotHash", "amountVisibility",
          "amountMinor", "netAmountMinor"]
      : ["entryId", "sourceVersion", "factType", "currency",
          "businessOccurredAt", "entryRecordedAt", "verificationRevision",
          "verificationRecordedAt", "snapshotHash", "amountVisibility"]);
  assertCanonicalAuthorityOrder(stable.verifiedFinancialFacts,
    (row) => canonicalKey(String(row.entryId)));
  assertProjectedAuthorityRows(stable.verifiedFinancialFacts,
    (row) => projectPersistedFact(row, stable.projectionLevel === "full"));
  exactAuthorityRows(stable.expectedRoi, (row) =>
    row.amountVisibility === "full"
      ? ["cohortId", "planId", "currency", "status", "reason", "roiBps",
          "formulaVersion", "quoteVersionIds", "probabilityAssessmentIds",
          "costEstimateIds", "amountVisibility",
          "probabilityWeightedGrossProfitMinor", "attributedEstimatedCostMinor"]
      : ["cohortId", "planId", "currency", "status", "reason", "roiBps",
          "formulaVersion", "quoteVersionIds", "probabilityAssessmentIds",
          "costEstimateIds", "amountVisibility"]);
  assertCanonicalAuthorityOrder(stable.expectedRoi,
    (row) => canonicalKey(String(row.cohortId), row.planId === null
      ? null : String(row.planId), String(row.currency)));
  assertProjectedAuthorityRows(stable.expectedRoi,
    (row) => projectExpected(
      row as unknown as AdvisorRoiSliceView,
      stable.projectionLevel === "full"
    ));
  exactAuthorityRows(stable.actualRoi, (row) => row.status === "not_computable"
    ? ["cohortId", "planId", "currency", "status", "reason",
        "closureVersionId", "closureAsOf", "formulaVersion"]
    : row.amountVisibility === "full"
      ? ["cohortId", "planId", "currency", "status", "basis", "roiBps",
          "costCoverageBps", "marginCoverageBps", "cashCoverageBps",
          "attributionCoverageBps", "closureVersionId", "closureAsOf",
          "formulaVersion", "amountVisibility", "verifiedGrossProfitMinor",
          "verifiedAcquisitionCostMinor"]
      : ["cohortId", "planId", "currency", "status", "basis", "roiBps",
          "costCoverageBps", "marginCoverageBps", "cashCoverageBps",
          "attributionCoverageBps", "closureVersionId", "closureAsOf",
          "formulaVersion", "amountVisibility"]);
  assertCanonicalAuthorityOrder(stable.actualRoi,
    (row) => canonicalKey(String(row.cohortId), row.planId === null
      ? null : String(row.planId), String(row.currency)));
  assertProjectedAuthorityRows(stable.actualRoi,
    (row) => projectActual(
      row as unknown as AdvisorRoiSliceView,
      stable.projectionLevel === "full"
    ));
  exactAuthorityRows(stable.dataGaps, () => ["code", "sourceType", "sourceId",
    "sourceSnapshotHash", "cohortId", "currency", "asOf"]);
  assertCanonicalAuthorityOrder(stable.dataGaps,
    (row) => canonicalKey(String(row.sourceType), String(row.sourceId),
      String(row.code)));
  assertProjectedAuthorityRows(stable.dataGaps,
    (row) => projectGap(row as unknown as FinancialDataGapView));
  for (const collection of [stable.pendingQuoteApprovals,
    stable.verifiedFinancialFacts, stable.expectedRoi, stable.actualRoi,
    stable.dataGaps] as const) {
    if ((collection as readonly Record<string, unknown>[]).some(
      (row) => row.currency !== undefined && row.currency !== stable.currency
    )) return authorityError("financial_council_authority_invalid");
  }
  const sourceSnapshotHash = hash(stable.sourceSnapshotHash);
  const { sourceSnapshotHash: _sourceSnapshotHash, ...projection } = stable;
  if (financialCouncilCanonicalHash(projection) !== sourceSnapshotHash) {
    return authorityError("financial_council_authority_invalid");
  }
  return immutableFinancialCouncilValue(
    stable as unknown as FinancialCouncilAuthoritySnapshot
  );
}

function projectPriority(row: PriorityCustomerView): PriorityCustomerView {
  return Object.freeze({
    candidateId: text(row.candidateId, "financial_council_authority_invalid"),
    customerId: row.customerId === null ? null
      : text(row.customerId, "financial_council_authority_invalid"),
    dealId: row.dealId === null ? null
      : text(row.dealId, "financial_council_authority_invalid"),
    displayName: untrustedText(row.displayName),
    priorityScoreBps: bps(row.priorityScoreBps),
    qualificationDecisionId: text(
      row.qualificationDecisionId, "financial_council_authority_invalid"
    ),
    qualificationDecisionVersion: text(
      row.qualificationDecisionVersion, "financial_council_authority_invalid"
    ),
    inputSnapshotHash: hash(row.inputSnapshotHash)
  });
}

function projectApproval(
  row: PendingQuoteApprovalView,
  sensitive: boolean
): PendingQuoteApprovalView {
  if (row.approvalKind !== "confirmation" && row.approvalKind !== "exception") {
    return authorityError("financial_council_authority_invalid");
  }
  const common = {
    approvalId: text(row.approvalId, "financial_council_authority_invalid"),
    quoteVersionId: text(row.quoteVersionId, "financial_council_authority_invalid"),
    quoteVersionRevision: safeInteger(row.quoteVersionRevision),
    quoteCaseId: text(row.quoteCaseId, "financial_council_authority_invalid"),
    approvalKind: row.approvalKind,
    requiredCapabilities: Object.freeze(row.requiredCapabilities
      .map((capability) => text(capability, "financial_council_authority_invalid"))
      .sort(compare)),
    submittedAt: text(row.submittedAt, "financial_council_authority_invalid", 35),
    expiresAt: row.expiresAt === null ? null
      : text(row.expiresAt, "financial_council_authority_invalid", 35)
  } as const;
  if (!sensitive) return Object.freeze(common);
  if (row.currency === undefined || row.quotedAmountMinor === undefined
    || row.estimatedGrossProfitMinor === undefined
    || row.estimatedContributionMinor === undefined
    || row.grossMarginBps === undefined) {
    return authorityError("financial_council_authority_invalid");
  }
  return Object.freeze({
    ...common,
    currency: text(row.currency, "financial_council_authority_invalid", 3),
    quotedAmountMinor: safeInteger(row.quotedAmountMinor),
    estimatedGrossProfitMinor: safeInteger(row.estimatedGrossProfitMinor),
    estimatedContributionMinor: safeInteger(row.estimatedContributionMinor),
    grossMarginBps: safeInteger(row.grossMarginBps)
  });
}

function projectExpected(
  row: AdvisorRoiSliceView,
  sensitive: boolean
): AdvisorRoiSliceView {
  if (!("reason" in row) || !("quoteVersionIds" in row)
    || !("probabilityAssessmentIds" in row) || !("costEstimateIds" in row)) {
    return authorityError("financial_council_authority_invalid");
  }
  if ((row.status !== "computed" && row.status !== "not_computable")
    || (row.status === "computed" && row.reason !== null)
    || (row.status === "not_computable"
      && !EXPECTED_ROI_REASONS.has(row.reason))) {
    return authorityError("financial_council_authority_invalid");
  }
  const common = {
    cohortId: text(row.cohortId, "financial_council_authority_invalid"),
    planId: row.planId === null ? null
      : text(row.planId, "financial_council_authority_invalid"),
    currency: text(row.currency, "financial_council_authority_invalid", 3),
    status: row.status,
    reason: row.reason,
    roiBps: row.roiBps === null ? null : safeInteger(row.roiBps),
    formulaVersion: "expected-gross-profit-roi.v1" as const,
    quoteVersionIds: [...row.quoteVersionIds].sort(compare),
    probabilityAssessmentIds: [...row.probabilityAssessmentIds].sort(compare),
    costEstimateIds: [...row.costEstimateIds].sort(compare)
  };
  if (!sensitive) {
    return Object.freeze({ ...common, amountVisibility: "redacted" as const });
  }
  if (row.amountVisibility !== "full") {
    return authorityError("financial_council_authority_invalid");
  }
  return Object.freeze({
    ...common,
    amountVisibility: "full" as const,
    probabilityWeightedGrossProfitMinor:
      row.probabilityWeightedGrossProfitMinor === null ? null
        : safeInteger(row.probabilityWeightedGrossProfitMinor),
    attributedEstimatedCostMinor:
      row.attributedEstimatedCostMinor === null ? null
        : safeInteger(row.attributedEstimatedCostMinor)
  });
}

function projectActual(
  row: AdvisorRoiSliceView,
  sensitive: boolean
): AdvisorRoiSliceView {
  const identity = {
    cohortId: text(row.cohortId, "financial_council_authority_invalid"),
    planId: row.planId === null ? null
      : text(row.planId, "financial_council_authority_invalid"),
    currency: text(row.currency, "financial_council_authority_invalid", 3)
  };
  if (row.status !== "computed" && row.status !== "not_computable") {
    return authorityError("financial_council_authority_invalid");
  }
  if (row.status === "not_computable") {
    if (!("closureVersionId" in row) || !("closureAsOf" in row)) {
      return authorityError("financial_council_authority_invalid");
    }
    if (!ACTUAL_ROI_REASONS.has(row.reason)) {
      return authorityError("financial_council_authority_invalid");
    }
    return Object.freeze({
      ...identity,
      status: "not_computable" as const,
      reason: row.reason,
      closureVersionId: row.closureVersionId,
      closureAsOf: row.closureAsOf,
      formulaVersion: "verified-gross-profit-roi.v1" as const
    });
  }
  if (!("basis" in row) || !("costCoverageBps" in row)) {
    return authorityError("financial_council_authority_invalid");
  }
  const common = {
    ...identity,
    status: "computed" as const,
    basis: "verified_gross_profit" as const,
    roiBps: safeInteger(row.roiBps),
    costCoverageBps: bps(row.costCoverageBps),
    marginCoverageBps: bps(row.marginCoverageBps),
    cashCoverageBps: bps(row.cashCoverageBps),
    attributionCoverageBps: bps(row.attributionCoverageBps),
    closureVersionId: text(row.closureVersionId, "financial_council_authority_invalid"),
    closureAsOf: text(row.closureAsOf, "financial_council_authority_invalid", 35),
    formulaVersion: "verified-gross-profit-roi.v1" as const
  };
  if (!sensitive) {
    return Object.freeze({ ...common, amountVisibility: "redacted" as const });
  }
  if (row.amountVisibility !== "full") {
    return authorityError("financial_council_authority_invalid");
  }
  return Object.freeze({
    ...common,
    amountVisibility: "full" as const,
    verifiedGrossProfitMinor: safeInteger(row.verifiedGrossProfitMinor),
    verifiedAcquisitionCostMinor: safeInteger(row.verifiedAcquisitionCostMinor)
  });
}

function projectFact(
  row: FinancialCouncilVerifiedFactSource,
  sensitive: boolean
): FinancialCouncilVerifiedFactView {
  if (!FACT_TYPES.has(row.factType)) {
    return authorityError("financial_council_authority_invalid");
  }
  const common: VerifiedFactCommon = {
    entryId: text(row.entryId, "financial_council_authority_invalid"),
    sourceVersion: safeInteger(row.sourceVersion),
    factType: row.factType,
    currency: text(row.currency, "financial_council_authority_invalid", 3),
    businessOccurredAt: text(row.businessOccurredAt, "financial_council_authority_invalid", 35),
    entryRecordedAt: text(row.entryRecordedAt, "financial_council_authority_invalid", 35),
    verificationRevision: safeInteger(row.verificationRevision),
    verificationRecordedAt: text(row.verificationRecordedAt, "financial_council_authority_invalid", 35),
    snapshotHash: hash(row.snapshotHash)
  };
  return sensitive
    ? Object.freeze({
        ...common,
        amountVisibility: "full" as const,
        amountMinor: safeInteger(row.amountMinor),
        netAmountMinor: safeInteger(row.netAmountMinor)
      })
    : Object.freeze({ ...common, amountVisibility: "redacted" as const });
}

function projectGap(row: FinancialDataGapView): FinancialDataGapView {
  if (!GAP_CODES.has(row.code) || !GAP_SOURCES.has(row.sourceType)) {
    return authorityError("financial_council_authority_invalid");
  }
  return Object.freeze({
    code: row.code,
    sourceType: row.sourceType,
    sourceId: text(row.sourceId, "financial_council_authority_invalid"),
    sourceSnapshotHash: hash(row.sourceSnapshotHash),
    cohortId: row.cohortId === null ? null
      : text(row.cohortId, "financial_council_authority_invalid"),
    currency: text(row.currency, "financial_council_authority_invalid", 3),
    asOf: text(row.asOf, "financial_council_authority_invalid", 35)
  });
}

export class SealedLedgerFinancialCouncilVerifiedFactsReader
implements FinancialCouncilVerifiedFactsReader {
  constructor(
    private readonly ledger: Pick<
      WorkspaceVerifiedFinancialLedgerSealedReader,
      "listWorkspaceVerifiedFactsAt"
    >
  ) {}

  async listVisibleAt(
    context: ActiveWorkspaceContext,
    input: {
      readonly currency: string;
      readonly cutoff: GrowthSealedReadCutoff;
      readonly limit: number;
    }
  ): Promise<readonly FinancialCouncilVerifiedFactSource[]> {
    const cutoff = assertGrowthSealedReadCutoff(
      input.cutoff, context.workspaceId
    );
    const rows = await this.ledger.listWorkspaceVerifiedFactsAt(cutoff, {
      currency: input.currency,
      limit: input.limit
    });
    if (rows.some((row) => row.workspaceId !== context.workspaceId)) {
      return authorityError("financial_council_authority_workspace_mismatch");
    }
    return immutableFinancialCouncilValue(rows.map((row) => ({
      workspaceId: row.workspaceId,
      entryId: row.entryId,
      sourceVersion: row.sourceVersion,
      factType: row.factType,
      amountMinor: row.amountMinor,
      netAmountMinor: row.netAmountMinor,
      currency: row.currency,
      businessOccurredAt: row.businessOccurredAt,
      entryRecordedAt: row.entryRecordedAt,
      verificationRevision: row.verificationRevision,
      verificationRecordedAt: row.verificationRecordedAt,
      snapshotHash: row.snapshotHash
    })));
  }
}

export class FinancialCouncilAuthorityReader {
  constructor(
    private readonly dependencies: FinancialCouncilAuthorityReaderDependencies
  ) {}

  async readAt(
    context: ActiveWorkspaceContext,
    input: { readonly currency: string; readonly cutoff: GrowthSealedReadCutoff }
  ): Promise<FinancialCouncilAuthoritySnapshot> {
    if (!context.workspaceId.trim() || context.workspaceId === "all") {
      return authorityError("financial_council_authority_workspace_mismatch");
    }
    const cutoff = assertGrowthSealedReadCutoff(
      input.cutoff, context.workspaceId
    );
    const [today, factRows] = await Promise.all([
      this.dependencies.advisor.getTodayAt(context, {
        currency: input.currency, cutoff
      }),
      this.dependencies.verifiedFacts.listVisibleAt(context, {
        currency: input.currency, cutoff, limit: QUERY_LIMIT
      })
    ]);
    if (today.workspaceId !== context.workspaceId
      || today.dataAsOf !== cutoff.effectiveAsOf
      || factRows.some((row) => row.workspaceId !== context.workspaceId)) {
      return authorityError("financial_council_authority_workspace_mismatch");
    }
    const sensitive = context.capabilities.includes("pricing.sensitive.read");
    const priorityCustomers = canonicalAuthorityRows(
      today.priorityCustomers,
      projectPriority,
      (row) => canonicalKey(row.candidateId)
    );
    const pendingQuoteApprovals = canonicalAuthorityRows(
      today.pendingQuoteApprovals.filter((row) => row.currency === input.currency),
      (row) => projectApproval(row, sensitive),
      (row) => canonicalKey(row.quoteVersionId, row.approvalId),
      (row) => canonicalKey(row.approvalId)
    );
    const verifiedFinancialFacts = canonicalAuthorityRows(
      factRows.filter((row) => row.currency === input.currency),
      (row) => projectFact(row, sensitive),
      (row) => canonicalKey(row.entryId)
    );
    const expectedRoi = canonicalAuthorityRows(
      today.expectedRoi.filter((row) => row.currency === input.currency),
      (row) => projectExpected(row, sensitive),
      (row) => canonicalKey(row.cohortId, row.planId, row.currency)
    );
    const actualRoi = canonicalAuthorityRows(
      today.actualRoi.filter((row) => row.currency === input.currency),
      (row) => projectActual(row, sensitive),
      (row) => canonicalKey(row.cohortId, row.planId, row.currency)
    );
    const dataGaps = canonicalAuthorityRows(
      today.dataGaps.filter((row) => row.currency === input.currency),
      projectGap,
      (row) => canonicalKey(row.sourceType, row.sourceId, row.code)
    );
    const projection = {
      workspaceId: context.workspaceId,
      currency: input.currency,
      dataAsOf: cutoff.effectiveAsOf,
      projectionLevel: sensitive ? "full" as const : "redacted" as const,
      priorityCustomers,
      pendingQuoteApprovals,
      verifiedFinancialFacts,
      expectedRoi,
      actualRoi,
      dataGaps
    };
    return validateFinancialCouncilAuthoritySnapshot({
      ...projection,
      sourceSnapshotHash: financialCouncilCanonicalHash(projection)
    });
  }
}
