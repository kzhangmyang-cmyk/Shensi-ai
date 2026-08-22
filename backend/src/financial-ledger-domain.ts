import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { CommercialBindingSnapshot } from
  "./commercial-binding-snapshot.js";
import { assertMinorAmount } from "./growth-money.js";

export type LedgerType = "cost" | "financial";
export type LedgerEntryStatus = "pending" | "verified" | "rejected" | "reversed";
export type VerifiedCostProvenance =
  | "provider_reported"
  | "portal_export"
  | "invoice_confirmed"
  | "manual_verified";

export interface LedgerVerificationEvent {
  id: string;
  workspaceId: string;
  ledgerType: LedgerType;
  ledgerEntryId: string;
  eventType: "verified" | "rejected" | "reversed";
  reversesEventId: string | null;
  eventSequence: number;
  revision: number;
  correctionGroupId: string | null;
  reason: string;
  decidedBy: string;
  recordedAt: string;
  temporalSequence: number;
}

export interface LedgerSourceHead {
  workspaceId: string;
  ledgerType: LedgerType;
  sourceIdentityRoot: string;
  currentLedgerEntryId: string;
  currentSourceVersion: number;
  revision: number;
}

export interface AcquisitionCostEntry {
  id: string;
  workspaceId: string;
  platform: string;
  planId: string | null;
  runId: string | null;
  providerId: string | null;
  category: "api" | "media" | "content" | "agency" | "operation";
  amountMinor: number;
  currency: string;
  occurredAt: string;
  provenance: VerifiedCostProvenance;
  sourceRef: string | null;
  evidenceHash: string;
  externalId: string | null;
  sourceIdentityRoot: string;
  sourceVersion: number;
  businessOccurredAt: string;
  recordedAt: string;
  temporalSequence: number;
  correctsCostEntryId: string | null;
  correctionGroupId: string | null;
  estimateReconciliationId: string | null;
  createdBy: string;
}

export interface AcquisitionCostEstimate {
  id: string;
  workspaceId: string;
  cohortId: string | null;
  planId: string | null;
  runId: string | null;
  amountMinor: number;
  currency: string;
  source:
    | "approved_budget"
    | "plan_budget"
    | "provider_estimate"
    | "manual_estimate";
  sourceStableKey: string;
  version: number;
  status: "draft" | "active" | "superseded";
  sourceVersion: number;
  inputSnapshotHash: string;
  revision: number;
  validFrom: string;
  validTo: string | null;
  createdBy: string;
  createdAt: string;
  temporalSequence: number;
  activatedAt: string | null;
}

export interface AcquisitionCostEstimateLifecycleEvent {
  id: string;
  workspaceId: string;
  currency: string;
  sourceStableKey: string;
  estimateId: string;
  eventType: "activated" | "superseded";
  eventSequence: number;
  revision: number;
  effectiveAt: string;
  supersedesEstimateId: string | null;
  actorId: string;
  recordedAt: string;
  temporalSequence: number;
}

export type FinancialFactType =
  | "contract_won"
  | "payment_received"
  | "revenue_recognized"
  | "cogs_recognized"
  | "refund"
  | "bad_debt_written_off";
export type FinancialFactProvenance =
  | "portal_export"
  | "bank_statement"
  | "invoice_confirmed"
  | "manual_verified"
  | "derived_from_import";

const FINANCIAL_FACT_TYPES: ReadonlySet<string> = new Set<FinancialFactType>([
  "contract_won",
  "payment_received",
  "revenue_recognized",
  "cogs_recognized",
  "refund",
  "bad_debt_written_off"
]);

export interface FinancialFact {
  id: string;
  workspaceId: string;
  candidateId: string | null;
  customerId: string | null;
  dealId: string | null;
  quoteVersionId: string | null;
  factType: FinancialFactType;
  amountMinor: number;
  currency: string;
  businessOccurredAt: string;
  recordedAt: string;
  temporalSequence: number;
  provenance: FinancialFactProvenance;
  sourceRef: string | null;
  evidenceHash: string;
  externalId: string | null;
  sourceIdentityRoot: string;
  sourceVersion: number;
  attributionSnapshot: OutcomeAttributionInput | null;
  commercialBindingSnapshot: CommercialBindingSnapshot | null;
  commercialAmountHash: string | null;
  dealAuthorityRevision: number | null;
  correctsFactId: string | null;
  correctionGroupId: string | null;
  createdBy: string;
}

export type CostSourceIdentityInput =
  | { kind: "provider_request"; accountingEvidenceId: string }
  | { kind: "legacy_run_final"; runId: string; finalHash: string }
  | { kind: "external"; sourceSystem: string; externalId: string }
  | { kind: "import_row"; fileHash: string; sheetName: string; rowNumber: number };

function sourceIdentityText(value: string): string {
  if (typeof value !== "string") throw new Error("source_identity_invalid");
  const normalized = value.trim();
  if (!normalized) throw new Error("source_identity_invalid");
  return normalized;
}

function isIsoTimestamp(value: string): boolean {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
      .test(value)
    && Number.isFinite(Date.parse(value));
}

export function costSourceIdentityRoot(input: CostSourceIdentityInput): string {
  if (input.kind === "provider_request") {
    return `provider-request:${sourceIdentityText(input.accountingEvidenceId)}`;
  }
  if (input.kind === "legacy_run_final") {
    return `legacy-run-final:${sourceIdentityText(input.runId)}:${sourceIdentityText(input.finalHash)}`;
  }
  if (input.kind === "external") {
    return `external:${sourceIdentityText(input.sourceSystem)}:${sourceIdentityText(input.externalId)}`;
  }
  if (!Number.isSafeInteger(input.rowNumber) || input.rowNumber < 1) {
    throw new Error("source_identity_invalid");
  }
  return `import:${sourceIdentityText(input.fileHash)}:${sourceIdentityText(input.sheetName)}:${input.rowNumber}`;
}

export function financialSourceIdentityRoot(input:
  | {
      kind: "external";
      sourceSystem: string;
      factType: FinancialFactType;
      externalId: string;
    }
  | {
      kind: "import_row";
      fileHash: string;
      sheetName: string;
      rowNumber: number;
      factType: FinancialFactType;
    }
): string {
  if (!FINANCIAL_FACT_TYPES.has(input.factType)) {
    throw new Error("source_identity_invalid");
  }
  if (input.kind === "external") {
    return costSourceIdentityRoot({
      kind: "external",
      sourceSystem: `${input.sourceSystem}:${input.factType}`,
      externalId: input.externalId
    });
  }
  return `${costSourceIdentityRoot({
    kind: "import_row",
    fileHash: input.fileHash,
    sheetName: input.sheetName,
    rowNumber: input.rowNumber
  })}:${input.factType}`;
}

export function ledgerEntryStatus(
  events: readonly LedgerVerificationEvent[]
): LedgerEntryStatus {
  const ordered = [...events].sort((left, right) =>
    left.eventSequence - right.eventSequence);
  if (ordered.length === 0) return "pending";
  for (const [index, event] of ordered.entries()) {
    if (!event.id.trim() || !event.workspaceId.trim()
      || event.workspaceId === "all" || !event.ledgerEntryId.trim()
      || !event.reason.trim() || !event.decidedBy.trim()
      || (event.ledgerType !== "cost" && event.ledgerType !== "financial")
      || !isIsoTimestamp(event.recordedAt)
      || !Number.isSafeInteger(event.temporalSequence)
      || event.temporalSequence < 1
      || event.eventSequence !== index + 1 || event.revision !== index + 2) {
      throw new Error("ledger_event_sequence_invalid");
    }
    if (index > 0
      && (event.workspaceId !== ordered[0]!.workspaceId
        || event.ledgerType !== ordered[0]!.ledgerType
        || event.ledgerEntryId !== ordered[0]!.ledgerEntryId)) {
      throw new Error("ledger_event_sequence_invalid");
    }
  }
  const decision = ordered[0]!;
  if (decision.reversesEventId !== null) {
    throw new Error("ledger_event_sequence_invalid");
  }
  if (decision.eventType === "rejected") {
    if (ordered.length !== 1) throw new Error("ledger_event_sequence_invalid");
    return "rejected";
  }
  if (decision.eventType !== "verified") {
    throw new Error("ledger_event_sequence_invalid");
  }
  if (ordered.length === 1) return "verified";
  const reversal = ordered[1]!;
  if (ordered.length !== 2 || reversal.eventType !== "reversed"
    || reversal.reversesEventId !== decision.id) {
    throw new Error("ledger_event_sequence_invalid");
  }
  return "reversed";
}

export function ledgerEntryNetMinor(
  entry: { amountMinor: number },
  events: readonly LedgerVerificationEvent[]
): number {
  const amountMinor = assertMinorAmount(entry.amountMinor);
  return ledgerEntryStatus(events) === "verified" ? amountMinor : 0;
}
