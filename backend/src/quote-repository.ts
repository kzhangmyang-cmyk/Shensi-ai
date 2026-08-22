import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { ProbabilityAssessmentV2 } from "./probability-assessment.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { Deal, DealEvent } from "./types.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type {
  QuoteCalculationResult,
  QuotePreviewIdentity
} from "./quote-domain.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransaction,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export interface QuoteCase {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly assignedTo: string;
  readonly status: "open" | "closed" | "cancelled";
  readonly currentDraftVersionId: string | null;
  readonly revision: number;
  readonly commercialBindingSnapshot: CommercialBindingSnapshot | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DealAuthoritativeQuote {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly openQuoteCaseId: string | null;
  readonly quoteVersionId: string | null;
  readonly commercialAmountHash: `sha256:${string}` | null;
  readonly authorityRevision: number;
  readonly updatedAt: string;
}

export interface DealAuthoritativeQuoteEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly dealId: string;
  readonly authorityRevision: number;
  readonly quoteCaseId: string;
  readonly quoteVersionId: string | null;
  readonly previousQuoteVersionId?: string | null;
  readonly eventType: "case_bound" | "case_released" | "quote_authorized"
    | "approved" | "superseded" | "rejected" | "expired" | "won" | "lost";
  readonly currency?: string;
  readonly quotedAmountMinor?: number;
  readonly commercialAmountHash?: `sha256:${string}`;
  readonly commercialBindingEvidence?: CommercialBindingEvidenceSnapshot;
  readonly commercialBindingSnapshot?: CommercialBindingSnapshot;
  readonly decidedAt?: string;
  readonly reasonCode?: string | null;
  readonly reasonText?: string | null;
  readonly decisionCommandHash?: `sha256:${string}`;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface CommercialBindingEvidenceSnapshot {
  readonly candidateId: string;
  readonly customerId: string;
  readonly dealId: string;
  readonly handoffContentHash: `sha256:${string}`;
  readonly dealContentHash: `sha256:${string}`;
  readonly bindingHashSchemaVersion: string;
  readonly bindingHash: `sha256:${string}`;
}

export interface QuoteVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly version: number;
  readonly lifecycleRevision: number;
  readonly versionKind: "draft" | "formal";
  readonly sourceDraftVersionId: string | null;
  readonly probabilityAssessmentSnapshot: ProbabilityAssessmentV2 | null;
  readonly status: "draft" | "submitted" | "approved" | "rejected" | "superseded" | "expired";
  readonly createdBy: string;
  readonly createdAt: string;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly temporalSequence: number;
  readonly [key: string]: unknown;
}

export interface QuoteLifecycleEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly quoteVersionId: string | null;
  readonly revision: number;
  readonly fromStatus: QuoteCase["status"] | QuoteVersion["status"] | null;
  readonly toStatus: QuoteCase["status"] | QuoteVersion["status"];
  readonly eventType: "case_created" | "deal_bound" | "case_closed"
    | "case_cancelled" | "version_expired" | "version_transition";
  readonly actorId: string;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface QuoteApproval {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteVersionId: string;
  readonly status: "pending" | "approved" | "rejected" | "cancelled";
  readonly approvalKind: "confirmation" | "exception";
  readonly requiredCapabilities: readonly string[];
  readonly triggeredRules: readonly string[];
  readonly pricingPolicyVersionId: string;
  readonly policySnapshotHash: `sha256:${string}`;
  readonly capabilityRegistryVersion: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

export interface QuoteApprovalEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteVersionId: string;
  readonly approvalId: string;
  readonly revision: number;
  readonly status: QuoteApproval["status"];
  readonly actorId: string;
  readonly reason: string | null;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface QuoteSubjectEvidenceSnapshot {
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
}

export interface QuotePreviewEvidenceRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly quoteCaseRevision: number;
  readonly salesOwnerActorId: string;
  readonly subjectEvidence: QuoteSubjectEvidenceSnapshot;
  readonly createdBy: string;
  readonly requestHash: string;
  readonly stableCommandHash: `sha256:${string}`;
  readonly previewIdentity: Readonly<QuotePreviewIdentity>;
  readonly frozenCalculationResult: Readonly<QuoteCalculationResult>;
  readonly inputSnapshotHash: `sha256:${string}`;
  readonly calculationHash: `sha256:${string}`;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly temporalSequence: number;
  readonly evidenceHash: `sha256:${string}`;
}

export interface AppendQuotePreviewEvidenceCommand {
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly expectedQuoteCaseRevision: number;
  readonly createdBy: string;
  readonly requestHash: string;
  readonly stableCommandHash: `sha256:${string}`;
  readonly effectiveAt: string;
  readonly calculated: QuoteCalculationResult;
}

export interface AppendQuoteVersionCommand {
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly expectedQuoteCaseRevision: number;
  readonly stableCommandHash: `sha256:${string}`;
  readonly versionKind: "draft" | "formal";
  readonly sourceDraftVersionId: string | null;
  readonly effectiveAt: string;
  readonly calculated: QuoteCalculationResult;
  readonly probabilityAssessmentSnapshot: ProbabilityAssessmentV2 | null;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly approval?: Readonly<{
    approvalKind: QuoteApproval["approvalKind"];
    requiredCapabilities: readonly string[];
    triggeredRules: readonly string[];
    pricingPolicyVersionId: string;
    policySnapshotHash: `sha256:${string}`;
    capabilityRegistryVersion: string;
  }>;
}

export interface AppendQuoteVersionResult {
  readonly version: QuoteVersion;
  readonly approval: QuoteApproval | null;
}

export interface QuotePublicationOperation {
  readonly id: string;
  readonly workspaceId: string;
  readonly quoteCaseId: string;
  readonly quoteVersionId: string;
  readonly dealId: string;
  readonly dealAuthorityRevision: number;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly status: "queued" | "running" | "succeeded" | "partial_failure"
    | "failed" | "superseded" | "cancelled";
  readonly piDocumentId: string | null;
  readonly dealEventId: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly idempotencyKey: string;
  readonly leaseOwner: string | null;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuotePublicationClaim {
  readonly operationId: string;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly authorityRevision: number;
}

export interface QuotePublicationHistory {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly status: QuotePublicationOperation["status"];
  readonly leaseOwner: string | null;
  readonly fencingToken: number;
  readonly authorityRevision: number;
  readonly piDocumentId: string | null;
  readonly dealEventId: string | null;
  readonly errorCode: string | null;
  readonly actorId: string | null;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface DecideQuoteApprovalCommand {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly quoteVersionId: string;
  readonly expectedRevision: number;
  readonly decision: "approve" | "reject" | "expire";
  readonly reason: string | null;
  readonly stableCommandHash: `sha256:${string}`;
  readonly requestHash: string;
  readonly verifiedBindingSnapshot: CommercialBindingSnapshot;
}

export interface QuoteApprovalDecisionPersistenceResult {
  readonly quoteVersion: QuoteVersion;
  readonly approval: QuoteApproval;
  readonly authority: DealAuthoritativeQuote;
  readonly authorityEvent: DealAuthoritativeQuoteEvent;
  readonly lifecycleEvents: readonly QuoteLifecycleEvent[];
  readonly publicationOperation: QuotePublicationOperation;
}

export type DealCommercialDecisionPersistenceInput =
  | { readonly type: "won" | "lost"; readonly quoteVersionId: string;
      readonly commercialAmountHash: `sha256:${string}`;
      readonly reasonCode: string | null; readonly reasonText: string | null;
      readonly occurredAt: string }
  | { readonly type: "pre_quote_disqualified";
      readonly reasonCode: string; readonly reasonText: string | null;
      readonly occurredAt: string };

export interface DecideDealPersistenceCommand {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly dealId: string;
  readonly expectedAuthorityRevision: number;
  readonly input: DealCommercialDecisionPersistenceInput;
  readonly stableCommandHash: `sha256:${string}`;
  readonly requestHash: string;
  readonly crm?: {
    readonly deals: Deal[];
    readonly dealEvents: DealEvent[];
  };
}

export interface DealCommercialDecisionPersistenceResult {
  readonly deal: Pick<Deal,
    "id" | "customerId" | "stage" | "amountType" | "ownerId" | "teamId">;
  readonly event: DealEvent;
  readonly quoteCase: QuoteCase | null;
  readonly authorityRevision: number;
  readonly cancelledPublicationOperationIds: readonly string[];
}

export interface QuoteCaseListQuery {
  readonly status?: QuoteCase["status"];
  readonly assignedTo?: string;
  readonly dealId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface QuoteCasePage {
  readonly items: readonly QuoteCase[];
  readonly nextCursor: string | null;
}

interface QuoteCommandBase {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number | null;
}

export interface CreateQuoteCaseCommand extends QuoteCommandBase {
  readonly quoteCase: QuoteCase;
  readonly bindingSnapshot?: CommercialBindingSnapshot | null;
  readonly probabilityAssessment?: ProbabilityAssessmentV2 | null;
}

export interface BindQuoteCaseDealCommand extends QuoteCommandBase {
  readonly quoteCaseId: string;
  readonly dealId: string;
  readonly bindingSnapshot: CommercialBindingSnapshot;
  readonly probabilityAssessment: ProbabilityAssessmentV2;
}

export interface CloseQuoteCaseCommand extends QuoteCommandBase {
  readonly quoteCaseId: string;
}

export interface CancelQuoteCaseCommand extends QuoteCommandBase {
  readonly quoteCaseId: string;
}

export interface QuoteCaseCommandResult {
  readonly quoteCase: QuoteCase;
  readonly replayed: boolean;
}

export interface QuoteRepository {
  listCases(workspaceId: string, query: QuoteCaseListQuery): Promise<QuoteCasePage>;
  findCase(workspaceId: string, id: string): Promise<QuoteCase | null>;
  createCase(command: CreateQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
  bindCaseDeal(command: BindQuoteCaseDealCommand): Promise<QuoteCaseCommandResult>;
  closeCase(command: CloseQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
  cancelCase(command: CancelQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
  assertCaseAccessible(
    workspaceId: string,
    id: string,
    actorId: string
  ): Promise<QuoteCase>;
  getVersion(workspaceId: string, id: string): Promise<QuoteVersion | null>;
  listVersions(workspaceId: string, quoteCaseId: string): Promise<readonly QuoteVersion[]>;
  findPreviewEvidence(
    workspaceId: string,
    id: string
  ): Promise<QuotePreviewEvidenceRecord | null>;
  findPreviewEvidenceByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ): Promise<QuotePreviewEvidenceRecord | null>;
  appendOrGetPreviewEvidence(
    command: AppendQuotePreviewEvidenceCommand
  ): Promise<QuotePreviewEvidenceRecord>;
  findDraftByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ): Promise<QuoteVersion | null>;
  appendVersionFromCalculation(
    command: AppendQuoteVersionCommand
  ): Promise<AppendQuoteVersionResult>;
  getApproval(workspaceId: string, id: string): Promise<QuoteApproval | null>;
  findApprovalByQuoteVersion(
    workspaceId: string,
    quoteVersionId: string
  ): Promise<QuoteApproval | null>;
  listApprovals(workspaceId: string): Promise<readonly QuoteApproval[]>;
  listApprovalEvents(
    workspaceId: string,
    quoteVersionId?: string
  ): Promise<readonly QuoteApprovalEvent[]>;
  listLifecycleEvents(
    workspaceId: string,
    quoteVersionId?: string
  ): Promise<readonly QuoteLifecycleEvent[]>;
  listAuthorityEvents(
    workspaceId: string,
    dealId?: string
  ): Promise<readonly DealAuthoritativeQuoteEvent[]>;
  listPreviewEvidenceAsOf(
    workspaceId: string,
    quoteCaseId: string,
    effectiveAsOf: string
  ): Promise<readonly QuotePreviewEvidenceRecord[]>;
  findCurrentDealAuthority(
    workspaceId: string,
    dealId: string
  ): Promise<DealAuthoritativeQuote | null>;
  decideApproval(
    command: DecideQuoteApprovalCommand
  ): Promise<QuoteApprovalDecisionPersistenceResult>;
  findApprovalDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ): Promise<QuoteApprovalDecisionPersistenceResult | null>;
  decideDeal(
    command: DecideDealPersistenceCommand
  ): Promise<DealCommercialDecisionPersistenceResult>;
  findDealDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ): Promise<DealCommercialDecisionPersistenceResult | null>;
  getPublication(operationId: string): Promise<QuotePublicationOperation | null>;
  claimPublication(operationId: string, workerId: string, now: string,
    nextExpiry: string): Promise<QuotePublicationClaim | null>;
  renewPublicationLease(claim: QuotePublicationClaim, now: string,
    nextExpiry: string): Promise<boolean>;
  recordPiPublished(claim: QuotePublicationClaim, piDocumentId: string,
    now: string): Promise<boolean>;
  recordCrmPublished(claim: QuotePublicationClaim, dealEventId: string,
    now: string): Promise<boolean>;
  finishPublication(claim: QuotePublicationClaim, now: string): Promise<boolean>;
  failPublication(claim: QuotePublicationClaim, errorCode: string,
    now: string): Promise<boolean>;
  cancelPublication(claim: QuotePublicationClaim, errorCode: string,
    now: string): Promise<boolean>;
  isPublicationAuthorityCurrent(claim: QuotePublicationClaim): Promise<boolean>;
  listRecoverablePublications(now?: string, limit?: number):
    Promise<readonly QuotePublicationOperation[]>;
  retryPublication(operationId: string, context: ActiveWorkspaceContext,
    now: string): Promise<QuotePublicationOperation>;
  listPublicationHistory(operationId: string):
    Promise<readonly QuotePublicationHistory[]>;
}

interface Receipt {
  requestHash: string;
  quoteCaseId: string;
}

function quoteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function required(value: string, code: string) {
  const result = value.trim();
  if (!result) throw quoteError(code);
  return result;
}

function growthInstant(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw quoteError("invalid_publication_instant");
  return parsed;
}

function immutableCase(value: QuoteCase): QuoteCase {
  return Object.freeze({
    ...structuredClone(value),
    commercialBindingSnapshot: value.commercialBindingSnapshot
      ? Object.freeze(structuredClone(value.commercialBindingSnapshot))
      : null
  });
}

function validateVersion(version: QuoteVersion): QuoteVersion {
  const valid = version.versionKind === "draft"
    ? version.sourceDraftVersionId === null
      && version.probabilityAssessmentSnapshot === null
    : Boolean(version.sourceDraftVersionId)
      && version.probabilityAssessmentSnapshot !== null;
  if (!valid) throw quoteError("invalid_quote_version_authority");
  return immutableQuoteValue(structuredClone(version));
}

export function immutableQuoteValue<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    immutableQuoteValue(child);
  }
  return Object.freeze(value);
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

export function snapshotQuoteCalculation(
  result: QuoteCalculationResult
): QuoteCalculationResult {
  return immutableQuoteValue(structuredClone({
    ...result,
    offeredLineAmountMinor: result.offeredLineAmountMinor,
    diagnosticNetProductAmountMinor: result.diagnosticNetProductAmountMinor,
    diagnosticQuotedAmountMinor: result.diagnosticQuotedAmountMinor,
    surchargeMinor: result.surchargeMinor,
    absoluteFloorAmountMinor: result.absoluteFloorAmountMinor,
    lineStandardCostMinor: result.lineStandardCostMinor,
    giftCostMinor: result.giftCostMinor,
    minimumMarginPriceMinor: result.minimumMarginPriceMinor,
    lineSnapshot: result.lineSnapshot,
    packageSnapshot: result.packageSnapshot,
    giftSnapshots: result.giftSnapshots,
    giftPolicySnapshots: result.giftPolicySnapshots,
    pricingPolicySnapshot: result.pricingPolicySnapshot,
    inputSnapshot: result.inputSnapshot,
    inputSnapshotHash: result.inputSnapshotHash,
    calculationHash: result.calculationHash,
    commercialAmountHash: result.commercialAmountHash
  })) as QuoteCalculationResult;
}

export function quoteSubjectEvidence(
  quoteCase: QuoteCase
): QuoteSubjectEvidenceSnapshot {
  const subject = immutableQuoteValue({
    candidateId: quoteCase.candidateId,
    customerId: quoteCase.customerId,
    dealId: quoteCase.dealId
  });
  if (!subject.candidateId && !subject.customerId && !subject.dealId) {
    throw quoteError("quote_case_subject_required");
  }
  const binding = quoteCase.commercialBindingSnapshot;
  if (binding && (subject.candidateId !== binding.candidateId
    || subject.customerId !== binding.customerId
    || subject.dealId !== binding.dealId)) {
    throw quoteError("commercial_binding_authority_mismatch");
  }
  return subject;
}

export function createQuoteVersionFromCalculation(input: Readonly<{
  id: string;
  quoteCase: QuoteCase;
  version: number;
  versionKind: "draft" | "formal";
  sourceDraftVersionId: string | null;
  probabilityAssessmentSnapshot: ProbabilityAssessmentV2 | null;
  calculated: QuoteCalculationResult;
  actorId: string;
  effectiveAt: string;
  recordedAt: string;
  temporalSequence: number;
  stableCommandHash: `sha256:${string}`;
  requestHash: string;
}>): QuoteVersion {
  const result = input.calculated;
  if (result.amountState !== "actionable" || result.commercialAmountHash === null) {
    throw quoteError("quote_not_actionable");
  }
  const { workspaceId: _workspaceId, ...transportInput } = result.inputSnapshot;
  const version: QuoteVersion = {
    amountVisibility: "full",
    id: input.id,
    workspaceId: input.quoteCase.workspaceId,
    quoteCaseId: input.quoteCase.id,
    version: input.version,
    lifecycleRevision: 1,
    versionKind: input.versionKind,
    sourceDraftVersionId: input.sourceDraftVersionId,
    currency: result.currency,
    lineSnapshot: structuredClone(result.lineSnapshot),
    lineItems: [{
      catalogItemId: result.lineSnapshot.catalogItemId,
      pricingPolicyVersionId: result.lineSnapshot.pricingPolicyVersionId,
      packageVersionId: result.lineSnapshot.packageVersionId,
      quantityMicros: result.lineSnapshot.quantityMicros,
      offeredUnitPriceMinor: result.lineSnapshot.offeredUnitPriceMinor,
      lineAmountMinor: result.lineSnapshot.offeredLineAmountMinor,
      standardCostMinor: result.lineSnapshot.lineStandardCostMinor
    }],
    customerTargetPriceMinor: result.inputSnapshot.customerTargetPriceMinor,
    discountMinor: result.inputSnapshot.orderDiscountMinor,
    surchargeMinor: result.surchargeMinor,
    requiredSurchargeMinor: result.requiredSurchargeMinor,
    paymentTerms: { days: result.inputSnapshot.paymentTermDays },
    giftItems: result.giftSnapshots.map((gift) => ({
      catalogItemId: gift.catalogItemId,
      quantityMicros: gift.quantityMicros,
      standardCostMinor: gift.standardCostMinor
    })),
    listAmountMinor: result.listAmountMinor,
    netProductAmountMinor: result.netProductAmountMinor,
    quotedAmountMinor: result.quotedAmountMinor,
    estimatedFulfillmentCostMinor: result.estimatedFulfillmentCostMinor,
    estimatedSalesCostMinor: result.estimatedSalesCostMinor,
    estimatedServiceCostMinor: result.estimatedServiceCostMinor,
    estimatedGrossProfitMinor: result.estimatedGrossProfitMinor,
    estimatedContributionMinor: result.estimatedContributionMinor,
    discountBps: result.discountBps,
    grossMarginBps: result.grossMarginBps,
    approvalReasons: result.gate.reasons.map((reason) => reason.code),
    pricingPolicySnapshot: structuredClone(result.pricingPolicySnapshot),
    packageSnapshot: result.packageSnapshot
      ? structuredClone(result.packageSnapshot) : null,
    probabilityAssessmentSnapshot: input.probabilityAssessmentSnapshot
      ? structuredClone(input.probabilityAssessmentSnapshot) : null,
    previewIdentity: structuredClone(result.previewIdentity),
    commercialAmountHash: result.commercialAmountHash,
    inputSnapshot: structuredClone(transportInput),
    inputSnapshotHash: result.inputSnapshotHash,
    calculationHash: result.calculationHash,
    gate: structuredClone(result.gate),
    salesOwnerActorId: input.quoteCase.assignedTo,
    subjectEvidence: quoteSubjectEvidence(input.quoteCase),
    commercialBindingSnapshot: input.quoteCase.commercialBindingSnapshot
      ? structuredClone(input.quoteCase.commercialBindingSnapshot) : null,
    stableCommandHash: input.stableCommandHash,
    requestHash: input.requestHash,
    status: input.versionKind === "draft" ? "draft" : "submitted",
    createdBy: input.actorId,
    createdAt: input.recordedAt,
    effectiveAt: input.effectiveAt,
    recordedAt: input.recordedAt,
    temporalSequence: input.temporalSequence
  };
  return validateVersion(immutableQuoteValue(version));
}

export interface InMemoryQuoteRepositorySeed {
  readonly cases?: readonly QuoteCase[];
  readonly versions?: readonly QuoteVersion[];
  readonly approvals?: readonly QuoteApproval[];
  readonly lifecycleEvents?: readonly QuoteLifecycleEvent[];
  readonly authority?: readonly DealAuthoritativeQuote[];
  readonly authorityEvents?: readonly DealAuthoritativeQuoteEvent[];
  readonly previewEvidence?: readonly QuotePreviewEvidenceRecord[];
  readonly publicationOperations?: readonly QuotePublicationOperation[];
  readonly publicationHistory?: readonly QuotePublicationHistory[];
}

export class InMemoryQuoteRepository implements QuoteRepository {
  private readonly cases = new Map<string, QuoteCase>();
  private readonly versions = new Map<string, QuoteVersion>();
  private readonly lifecycleEvents: QuoteLifecycleEvent[] = [];
  private readonly previewEvidence = new Map<string, QuotePreviewEvidenceRecord>();
  private readonly previewByStableHash = new Map<string, string>();
  private readonly approvals = new Map<string, QuoteApproval>();
  private readonly approvalEvents: QuoteApprovalEvent[] = [];
  private readonly bindingSnapshots = new Map<string, CommercialBindingSnapshot>();
  private readonly boundAssessments = new Map<string, ProbabilityAssessmentV2>();
  private readonly dealAuthorities = new Map<string, DealAuthoritativeQuote>();
  private readonly authorityEvents: DealAuthoritativeQuoteEvent[] = [];
  private readonly publicationOperations = new Map<string, QuotePublicationOperation>();
  private readonly publicationHistory: QuotePublicationHistory[] = [];
  private readonly approvalDecisions = new Map<string,
    QuoteApprovalDecisionPersistenceResult>();
  private readonly dealDecisions = new Map<string,
    DealCommercialDecisionPersistenceResult>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly workspaceMutationTails = new Map<string, Promise<void>>();
  private readonly temporalBarrier: GrowthTemporalBarrier;

  constructor(
    private readonly transactions: GrowthTemporalTransactionRunner,
    temporalBarrier: GrowthTemporalBarrier,
    seed: InMemoryQuoteRepositorySeed = {}
  ) {
    this.temporalBarrier = assertGrowthTemporalBarrier(temporalBarrier);
    for (const quoteCase of seed.cases ?? []) {
      this.cases.set(this.caseKey(quoteCase.workspaceId, quoteCase.id),
        immutableCase(quoteCase));
      this.lifecycleEvents.push(Object.freeze({
        id: `seed-lifecycle-${quoteCase.id}`,
        workspaceId: quoteCase.workspaceId,
        quoteCaseId: quoteCase.id,
        quoteVersionId: null,
        revision: 1,
        fromStatus: null,
        toStatus: "open",
        eventType: "case_created",
        actorId: quoteCase.assignedTo,
        recordedAt: quoteCase.createdAt,
        temporalSequence: this.lifecycleEvents.length + 1
      }));
    }
    for (const version of seed.versions ?? []) {
      this.versions.set(this.caseKey(version.workspaceId, version.id),
        validateVersion(version));
    }
    for (const approval of seed.approvals ?? []) {
      this.approvals.set(this.caseKey(approval.workspaceId, approval.id),
        immutableQuoteValue(structuredClone(approval)));
    }
    if (seed.lifecycleEvents) {
      this.lifecycleEvents.splice(0, this.lifecycleEvents.length,
        ...seed.lifecycleEvents.map((event) => immutableQuoteValue(
          structuredClone(event)
        )));
    }
    for (const authority of seed.authority ?? []) {
      this.dealAuthorities.set(this.caseKey(authority.workspaceId,
        authority.dealId), immutableQuoteValue(structuredClone(authority)));
    }
    this.authorityEvents.push(...(seed.authorityEvents ?? []).map((event) =>
      immutableQuoteValue(structuredClone(event))));
    for (const operation of seed.publicationOperations ?? []) {
      this.publicationOperations.set(this.caseKey(operation.workspaceId,
        operation.id), immutableQuoteValue(structuredClone(operation)));
    }
    this.publicationHistory.push(...(seed.publicationHistory ?? []).map((row) =>
      immutableQuoteValue(structuredClone(row))));
    for (const evidence of seed.previewEvidence ?? []) {
      this.previewEvidence.set(this.caseKey(evidence.workspaceId, evidence.id),
        immutableQuoteValue(structuredClone(evidence)));
      this.previewByStableHash.set(this.caseKey(evidence.workspaceId,
        evidence.stableCommandHash), evidence.id);
    }
  }

  private caseKey(workspaceId: string, id: string) {
    return `${workspaceId}\u0000${id}`;
  }

  private snapshotState() {
    return {
      cases: new Map(this.cases), versions: new Map(this.versions),
      lifecycleEvents: [...this.lifecycleEvents],
      previewEvidence: new Map(this.previewEvidence),
      previewByStableHash: new Map(this.previewByStableHash),
      approvals: new Map(this.approvals),
      approvalEvents: [...this.approvalEvents],
      bindingSnapshots: new Map(this.bindingSnapshots),
      boundAssessments: new Map(this.boundAssessments),
      dealAuthorities: new Map(this.dealAuthorities),
      authorityEvents: [...this.authorityEvents],
      publicationOperations: new Map(this.publicationOperations),
      publicationHistory: [...this.publicationHistory],
      approvalDecisions: new Map(this.approvalDecisions),
      dealDecisions: new Map(this.dealDecisions),
      receipts: new Map(this.receipts)
    };
  }

  private restoreState(snapshot: ReturnType<InMemoryQuoteRepository["snapshotState"]>) {
    const restoreMap = <K, V>(target: Map<K, V>, source: Map<K, V>) => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    restoreMap(this.cases, snapshot.cases);
    restoreMap(this.versions, snapshot.versions);
    restoreMap(this.bindingSnapshots, snapshot.bindingSnapshots);
    restoreMap(this.boundAssessments, snapshot.boundAssessments);
    restoreMap(this.previewEvidence, snapshot.previewEvidence);
    restoreMap(this.previewByStableHash, snapshot.previewByStableHash);
    restoreMap(this.approvals, snapshot.approvals);
    restoreMap(this.publicationOperations, snapshot.publicationOperations);
    restoreMap(this.approvalDecisions, snapshot.approvalDecisions);
    restoreMap(this.dealDecisions, snapshot.dealDecisions);
    restoreMap(this.dealAuthorities, snapshot.dealAuthorities);
    restoreMap(this.receipts, snapshot.receipts);
    this.lifecycleEvents.splice(0, this.lifecycleEvents.length,
      ...snapshot.lifecycleEvents);
    this.authorityEvents.splice(0, this.authorityEvents.length,
      ...snapshot.authorityEvents);
    this.approvalEvents.splice(0, this.approvalEvents.length,
      ...snapshot.approvalEvents);
    this.publicationHistory.splice(0, this.publicationHistory.length,
      ...snapshot.publicationHistory);
  }

  private async acquireWorkspaceMutationGate(workspaceId: string) {
    const predecessor = this.workspaceMutationTails.get(workspaceId)
      ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.workspaceMutationTails.set(workspaceId, current);
    await predecessor;
    return () => {
      unlock();
      if (this.workspaceMutationTails.get(workspaceId) === current) {
        this.workspaceMutationTails.delete(workspaceId);
      }
    };
  }

  private async mutation<T>(
    workspaceId: string,
    work: (
      tx: GrowthTemporalTransaction,
      firstStamp: { recordedAt: string; temporalSequence: number }
    ) => Promise<T>
  ): Promise<T> {
    let release: (() => void) | undefined;
    let snapshot: ReturnType<InMemoryQuoteRepository["snapshotState"]>
      | undefined;
    try {
      return await this.transactions.run(async (tx) => {
        const firstStamp = await this.temporalBarrier.allocateAppend(
          tx,
          workspaceId
        );
        release = await this.acquireWorkspaceMutationGate(workspaceId);
        snapshot = this.snapshotState();
        return work(tx, firstStamp);
      });
    } catch (error) {
      if (snapshot) this.restoreState(snapshot);
      throw error;
    } finally {
      release?.();
    }
  }

  private receiptKey(workspaceId: string, commandKey: string) {
    return `${workspaceId}\u0000${commandKey}`;
  }

  private replay(command: QuoteCommandBase): QuoteCaseCommandResult | null {
    const receipt = this.receipts.get(this.receiptKey(
      command.workspaceId,
      required(command.commandKey, "invalid_quote_command_key")
    ));
    if (!receipt) return null;
    if (receipt.requestHash !== command.requestHash) {
      throw quoteError("quote_command_identity_conflict");
    }
    const quoteCase = this.cases.get(this.caseKey(
      command.workspaceId,
      receipt.quoteCaseId
    ));
    if (!quoteCase) throw quoteError("quote_command_receipt_corrupt");
    return { quoteCase, replayed: true };
  }

  private complete(command: QuoteCommandBase, quoteCase: QuoteCase) {
    this.receipts.set(this.receiptKey(command.workspaceId, command.commandKey), {
      requestHash: command.requestHash,
      quoteCaseId: quoteCase.id
    });
  }

  private currentCase(command: QuoteCommandBase, id: string): QuoteCase {
    const quoteCase = this.cases.get(this.caseKey(command.workspaceId, id));
    if (!quoteCase) throw quoteError("quote_case_not_found");
    if (command.expectedRevision !== quoteCase.revision) {
      throw quoteError(command.expectedRevision === null
        ? "revision_required" : "quote_case_revision_conflict");
    }
    return quoteCase;
  }

  private activeFormalVersion(workspaceId: string, quoteCaseId: string) {
    return [...this.versions.values()].some((version) =>
      version.workspaceId === workspaceId
      && version.quoteCaseId === quoteCaseId
      && version.versionKind === "formal"
      && (version.status === "submitted" || version.status === "approved"));
  }

  private appendCaseLifecycle(input: Omit<QuoteLifecycleEvent,
    "id" | "recordedAt" | "temporalSequence">,
  stamp: { recordedAt: string; temporalSequence: number }) {
    this.lifecycleEvents.push(Object.freeze({
      ...input,
      id: `quote-lifecycle-${input.workspaceId}-${stamp.temporalSequence}`,
      ...stamp
    }));
  }

  async listCases(workspaceId: string, query: QuoteCaseListQuery) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const rows = [...this.cases.values()]
      .filter((row) => row.workspaceId === workspace
        && (!query.status || row.status === query.status)
        && (!query.assignedTo || row.assignedTo === query.assignedTo)
        && (!query.dealId || row.dealId === query.dealId)
        && (!query.cursor || row.id > query.cursor))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
      items: Object.freeze(rows.slice(0, limit)),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null
    });
  }

  async findCase(workspaceId: string, id: string) {
    return this.cases.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(id, "invalid_quote_case_id")
    )) ?? null;
  }

  async assertCaseAccessible(workspaceId: string, id: string, actorId: string) {
    required(actorId, "invalid_growth_actor_id");
    const quoteCase = await this.findCase(workspaceId, id);
    if (!quoteCase) throw quoteError("quote_case_not_found");
    return quoteCase;
  }

  async getVersion(workspaceId: string, id: string) {
    return this.versions.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(id, "invalid_quote_version_id")
    )) ?? null;
  }

  async getApproval(workspaceId: string, id: string) {
    return this.approvals.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(id, "invalid_quote_approval_id")
    )) ?? null;
  }

  async findApprovalByQuoteVersion(workspaceId: string, quoteVersionId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return [...this.approvals.values()].find((row) =>
      row.workspaceId === workspace
      && row.quoteVersionId === quoteVersionId) ?? null;
  }

  async listApprovals(workspaceId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return Object.freeze([...this.approvals.values()].filter((row) =>
      row.workspaceId === workspace));
  }

  async listApprovalEvents(workspaceId: string, quoteVersionId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return Object.freeze(this.approvalEvents.filter((row) =>
      row.workspaceId === workspace
      && (!quoteVersionId || row.quoteVersionId === quoteVersionId))
      .sort((left, right) => left.revision - right.revision));
  }

  async listLifecycleEvents(workspaceId: string, quoteVersionId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return Object.freeze(this.lifecycleEvents.filter((row) =>
      row.workspaceId === workspace
      && (!quoteVersionId || row.quoteVersionId === quoteVersionId))
      .sort((left, right) => left.revision - right.revision));
  }

  async listAuthorityEvents(workspaceId: string, dealId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return Object.freeze(this.authorityEvents.filter((row) =>
      row.workspaceId === workspace && (!dealId || row.dealId === dealId))
      .sort((left, right) => left.authorityRevision - right.authorityRevision));
  }

  async listPreviewEvidenceAsOf(
    workspaceId: string,
    quoteCaseId: string,
    effectiveAsOf: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return Object.freeze([...this.previewEvidence.values()].filter((row) =>
      row.workspaceId === workspace && row.quoteCaseId === quoteCaseId
      && row.recordedAt <= effectiveAsOf));
  }

  async findCurrentDealAuthority(workspaceId: string, dealId: string) {
    return this.dealAuthorities.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(dealId, "invalid_deal_id")
    )) ?? null;
  }

  async findApprovalDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    return this.approvalDecisions.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId), stableCommandHash
    )) ?? null;
  }

  async findDealDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    return this.dealDecisions.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(stableCommandHash, "invalid_quote_stable_command_hash")
    )) ?? null;
  }

  async decideDeal(
    command: DecideDealPersistenceCommand
  ): Promise<DealCommercialDecisionPersistenceResult> {
    const workspaceId = assertConcreteGrowthWorkspaceId(command.workspaceId);
    const decisionKey = this.caseKey(workspaceId, command.stableCommandHash);
    const replay = this.dealDecisions.get(decisionKey);
    if (replay) return replay;
    if (!command.crm) throw quoteError("deal_crm_transaction_required");
    const crmDeal = command.crm.deals.find((deal) =>
      deal.id === command.dealId && deal.teamId === workspaceId);
    if (!crmDeal) throw quoteError("deal_not_found");
    const originalDeal = structuredClone(crmDeal);
    const originalEventLength = command.crm.dealEvents.length;
    let crmMutationStarted = false;
    try {
      return await this.mutation(workspaceId, async (tx, authorityStamp) => {
        const secondReplay = this.dealDecisions.get(decisionKey);
        if (secondReplay) return secondReplay;
        const authorityKey = this.caseKey(workspaceId, command.dealId);
        const currentAuthority = this.dealAuthorities.get(authorityKey) ?? null;
        const currentRevision = currentAuthority?.authorityRevision ?? 0;
        if (command.expectedAuthorityRevision !== Math.max(1, currentRevision)) {
          throw quoteError("revision_conflict");
        }
        const priorDecision = this.authorityEvents.find((event) =>
          event.workspaceId === workspaceId && event.dealId === command.dealId
          && (event.eventType === "won" || event.eventType === "lost"));
        if (priorDecision) throw quoteError("deal_already_decided");

        const commercial = command.input.type !== "pre_quote_disqualified";
        if (commercial && (!currentAuthority?.quoteVersionId
          || currentAuthority.quoteVersionId !== command.input.quoteVersionId)) {
          throw quoteError("quote_version_conflict");
        }
        if (commercial && currentAuthority?.commercialAmountHash
          !== command.input.commercialAmountHash) {
          throw quoteError("commercial_amount_hash_mismatch");
        }
        if (!commercial && currentAuthority?.quoteVersionId) {
          throw quoteError("authoritative_quote_already_exists");
        }

        const quoteCase = currentAuthority?.openQuoteCaseId
          ? this.cases.get(this.caseKey(workspaceId,
              currentAuthority.openQuoteCaseId)) ?? null
          : [...this.cases.values()].find((item) =>
              item.workspaceId === workspaceId
              && item.dealId === command.dealId && item.status === "open") ?? null;
        const version = commercial
          ? this.versions.get(this.caseKey(workspaceId,
              command.input.quoteVersionId)) ?? null
          : null;
        let binding: CommercialBindingSnapshot | null = null;
        let evidence: CommercialBindingEvidenceSnapshot | null = null;
        let amountMinor: number | null = null;
        let currency: string | null = null;
        if (commercial) {
          binding = version?.commercialBindingSnapshot as
            CommercialBindingSnapshot | null;
          amountMinor = Number(version?.quotedAmountMinor);
          currency = String(version?.currency ?? "").toUpperCase();
          if (!version || version.versionKind !== "formal"
            || version.status !== "approved" || !quoteCase
            || quoteCase.id !== version.quoteCaseId
            || quoteCase.dealId !== command.dealId
            || !binding || binding.dealId !== command.dealId
            || binding.customerId !== quoteCase.customerId
            || binding.candidateId !== quoteCase.candidateId
            || canonicalJsonStringify(quoteCase.commercialBindingSnapshot)
              !== canonicalJsonStringify(binding)
            || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
            || !/^[A-Z]{3}$/u.test(currency)
            || version.commercialAmountHash
              !== command.input.commercialAmountHash) {
            throw quoteError("commercial_binding_authority_mismatch");
          }
          const expectedBindingHash = hash({
            customerId: binding.customerId,
            handoffContentHash: binding.handoffContentHash,
            dealContentHash: binding.dealContentHash,
            bindingHashSchemaVersion: binding.bindingHashSchemaVersion
          });
          if (binding.bindingHashSchemaVersion !== "commercial-binding.v1"
            || binding.bindingHash !== expectedBindingHash) {
            throw quoteError("commercial_binding_authority_mismatch");
          }
          evidence = immutableQuoteValue({
            candidateId: binding.candidateId,
            customerId: binding.customerId,
            dealId: binding.dealId,
            handoffContentHash: binding.handoffContentHash,
            dealContentHash: binding.dealContentHash,
            bindingHashSchemaVersion: binding.bindingHashSchemaVersion,
            bindingHash: binding.bindingHash
          });
        }

        const authorityRevision = currentRevision + 1;
        const eventType = command.input.type === "won" ? "won" : "lost";
        const authorityEvent: DealAuthoritativeQuoteEvent = immutableQuoteValue({
          id: `deal-authority-${workspaceId}-${authorityStamp.temporalSequence}`,
          workspaceId, dealId: command.dealId, authorityRevision,
          quoteCaseId: quoteCase?.id ?? "",
          quoteVersionId: commercial ? command.input.quoteVersionId : null,
          previousQuoteVersionId: currentAuthority?.quoteVersionId ?? null,
          eventType, ...(commercial ? {
            currency: currency!, quotedAmountMinor: amountMinor!,
            commercialAmountHash: command.input.commercialAmountHash,
            commercialBindingEvidence: evidence!,
            commercialBindingSnapshot: immutableQuoteValue(
              structuredClone(binding!))
          } : {}),
          reasonCode: command.input.reasonCode,
          reasonText: command.input.reasonText,
          decisionCommandHash: command.stableCommandHash,
          decidedAt: command.input.occurredAt,
          ...authorityStamp
        });
        this.authorityEvents.push(authorityEvent);

        const cancelledIds: string[] = [];
        const unfinished = new Set<QuotePublicationOperation["status"]>([
          "queued", "running", "partial_failure", "failed"
        ]);
        for (const [key, operation] of this.publicationOperations) {
          if (operation.workspaceId !== workspaceId
            || operation.dealId !== command.dealId
            || !unfinished.has(operation.status)) continue;
          const stamp = await this.temporalBarrier.allocateAppend(tx,
            workspaceId);
          const cancelled = immutableQuoteValue({ ...operation,
            status: "cancelled" as const, leaseOwner: null,
            leaseExpiresAt: null, lastErrorCode: "deal_decided",
            updatedAt: stamp.recordedAt });
          this.publicationOperations.set(key, cancelled);
          this.publicationHistory.push(immutableQuoteValue({
            id: `quote-publication-history-${workspaceId}-${stamp.temporalSequence}`,
            workspaceId, operationId: operation.id, status: "cancelled" as const,
            leaseOwner: operation.leaseOwner,
            fencingToken: operation.fencingToken, authorityRevision,
            piDocumentId: operation.piDocumentId,
            dealEventId: operation.dealEventId,
            errorCode: "deal_decided", actorId: command.actorId, ...stamp
          }));
          cancelledIds.push(operation.id);
        }

        const dealEventStamp = await this.temporalBarrier.allocateAppend(tx,
          workspaceId);
        const previousStage = crmDeal.stage;
        crmMutationStarted = true;
        Object.assign(crmDeal, {
          stage: eventType === "won" ? "成交" : "丢单",
          amountType: command.input.type === "won" ? "won"
            : commercial ? "quoted" : "estimate",
          ...(commercial ? { amount: amountMinor! / 100, currency } : {}),
          stageChangedAt: dealEventStamp.recordedAt,
          closedAt: command.input.occurredAt,
          ...(eventType === "won"
            ? { wonReason: command.input.reasonText ?? undefined }
            : { lostReasonCategory: command.input.reasonCode ?? undefined,
                lostReason: command.input.reasonText ?? undefined })
        });
        const dealEvent: DealEvent = Object.freeze({
          id: `deal-decision-${command.stableCommandHash.slice(7, 47)}`,
          dealId: command.dealId, type: eventType,
          content: command.input.reasonText ?? command.input.reasonCode ?? "",
          operatorId: command.actorId, ownerIdSnapshot: crmDeal.ownerId,
          teamIdSnapshot: crmDeal.teamId,
          customerIdSnapshot: commercial ? binding!.customerId : crmDeal.customerId,
          leadIdSnapshot: commercial ? binding!.leadId : null,
          handoffIdSnapshot: commercial ? binding!.handoffId : null,
          candidateIdSnapshot: commercial ? binding!.candidateId : null,
          amountMinorSnapshot: commercial ? amountMinor : null,
          currencySnapshot: commercial ? currency : null,
          commercialAuthority: commercial ? "quote_projection"
            : "pre_quote_disqualified",
          quoteCaseIdSnapshot: quoteCase?.id ?? null,
          quoteVersionIdSnapshot: commercial ? command.input.quoteVersionId : null,
          commercialAmountHash: commercial
            ? command.input.commercialAmountHash : null,
          dealAuthorityRevisionSnapshot: authorityRevision,
          authorityRevision,
          commercialBindingEvidence: commercial ? evidence : null,
          commercialBindingSnapshot: commercial
            ? immutableQuoteValue(structuredClone(binding!)) : null,
          reasonCode: command.input.reasonCode,
          reasonText: command.input.reasonText,
          occurredAt: command.input.occurredAt,
          fromStage: previousStage,
          toStage: eventType === "won" ? "成交" : "丢单",
          recordedAt: dealEventStamp.recordedAt,
          temporalSequence: dealEventStamp.temporalSequence,
          createdAt: dealEventStamp.recordedAt
        });
        command.crm!.dealEvents.push(dealEvent);

        let closedCase: QuoteCase | null = quoteCase;
        if (quoteCase) {
          const lifecycleStamp = await this.temporalBarrier.allocateAppend(tx,
            workspaceId);
          closedCase = immutableCase({ ...quoteCase, status: "closed",
            currentDraftVersionId: null, revision: quoteCase.revision + 1,
            updatedAt: lifecycleStamp.recordedAt });
          this.cases.set(this.caseKey(workspaceId, quoteCase.id), closedCase);
          this.appendCaseLifecycle({ workspaceId, quoteCaseId: quoteCase.id,
            quoteVersionId: commercial ? command.input.quoteVersionId : null,
            revision: closedCase.revision, fromStatus: quoteCase.status,
            toStatus: "closed", eventType: "case_closed",
            actorId: command.actorId }, lifecycleStamp);
        }
        this.dealAuthorities.set(authorityKey, immutableQuoteValue({
          workspaceId, dealId: command.dealId, openQuoteCaseId: null,
          quoteVersionId: null, commercialAmountHash: null,
          authorityRevision, updatedAt: authorityStamp.recordedAt
        }));
        const result = immutableQuoteValue({
          deal: { id: crmDeal.id, customerId: crmDeal.customerId,
            stage: crmDeal.stage, amountType: crmDeal.amountType,
            ownerId: crmDeal.ownerId, teamId: crmDeal.teamId },
          event: dealEvent,
          quoteCase: closedCase, authorityRevision,
          cancelledPublicationOperationIds: Object.freeze(cancelledIds)
        });
        this.dealDecisions.set(decisionKey, result);
        return result;
      });
    } catch (error) {
      if (crmMutationStarted) {
        Object.assign(crmDeal, originalDeal);
        command.crm.dealEvents.splice(originalEventLength);
      }
      throw error;
    }
  }

  async decideApproval(
    command: DecideQuoteApprovalCommand
  ): Promise<QuoteApprovalDecisionPersistenceResult> {
    const workspaceId = assertConcreteGrowthWorkspaceId(command.workspaceId);
    const decisionKey = this.caseKey(workspaceId, command.stableCommandHash);
    const replay = this.approvalDecisions.get(decisionKey);
    if (replay) return replay;
    return this.mutation(workspaceId, async (tx, firstStamp) => {
      const secondReplay = this.approvalDecisions.get(decisionKey);
      if (secondReplay) return secondReplay;
      const version = this.versions.get(this.caseKey(workspaceId,
        command.quoteVersionId));
      if (!version) throw quoteError("quote_version_not_found");
      if (version.versionKind !== "formal" || !version.sourceDraftVersionId
        || version.probabilityAssessmentSnapshot?.precision !== "bps") {
        throw quoteError("formal_quote_version_required");
      }
      const quoteCase = this.cases.get(this.caseKey(workspaceId,
        version.quoteCaseId));
      if (!quoteCase || !quoteCase.dealId) {
        throw quoteError("quote_deal_binding_required");
      }
      const frozenBinding = version.commercialBindingSnapshot;
      if (!frozenBinding || typeof frozenBinding !== "object") {
        throw quoteError("commercial_binding_authority_mismatch");
      }
      const binding = frozenBinding as CommercialBindingSnapshot;
      if (binding.dealId !== quoteCase.dealId
        || binding.customerId !== quoteCase.customerId
        || binding.candidateId !== quoteCase.candidateId
        || command.verifiedBindingSnapshot.bindingHash !== binding.bindingHash
        || command.verifiedBindingSnapshot.dealContentHash
          !== binding.dealContentHash
        || command.verifiedBindingSnapshot.handoffContentHash
          !== binding.handoffContentHash) {
        throw quoteError("commercial_binding_authority_mismatch");
      }
      const gate = version.gate as { status?: string } | undefined;
      if (gate?.status === "hard_blocked") throw quoteError("quote_hard_blocked");
      const approval = [...this.approvals.values()].find((row) =>
        row.workspaceId === workspaceId
        && row.quoteVersionId === version.id);
      if (!approval) throw quoteError("quote_approval_not_found");
      if (approval.status !== "pending") {
        throw quoteError("quote_approval_already_decided");
      }
      const versionEvents = this.lifecycleEvents.filter((row) =>
        row.workspaceId === workspaceId && row.quoteVersionId === version.id);
      const currentRevision = Math.max(version.lifecycleRevision,
        ...versionEvents.map((row) => row.revision));
      if (command.expectedRevision !== currentRevision) {
        throw quoteError("revision_conflict");
      }
      const authorityKey = this.caseKey(workspaceId, quoteCase.dealId);
      const existingAuthority = this.dealAuthorities.get(authorityKey)
        ?? immutableQuoteValue({ workspaceId, dealId: quoteCase.dealId,
          openQuoteCaseId: quoteCase.id, quoteVersionId: null,
          commercialAmountHash: null, authorityRevision: 0,
          updatedAt: firstStamp.recordedAt });
      const lastAuthorityEvent = this.authorityEvents.filter((event) =>
        event.workspaceId === workspaceId && event.dealId === quoteCase.dealId)
        .sort((left, right) => right.authorityRevision
          - left.authorityRevision)[0];
      if (lastAuthorityEvent?.eventType === "won"
        || lastAuthorityEvent?.eventType === "lost") {
        throw quoteError("deal_already_decided");
      }
      const lifecycleEvents: QuoteLifecycleEvent[] = [];
      if (command.decision === "approve" && existingAuthority.quoteVersionId
        && existingAuthority.quoteVersionId !== version.id) {
        const previous = this.versions.get(this.caseKey(workspaceId,
          existingAuthority.quoteVersionId));
        if (previous) {
          const previousEvents = this.lifecycleEvents.filter((row) =>
            row.workspaceId === workspaceId
            && row.quoteVersionId === previous.id);
          const previousRevision = Math.max(previous.lifecycleRevision,
            ...previousEvents.map((row) => row.revision)) + 1;
          const event = immutableQuoteValue({
            id: `quote-lifecycle-${workspaceId}-${firstStamp.temporalSequence}`,
            workspaceId, quoteCaseId: previous.quoteCaseId,
            quoteVersionId: previous.id, revision: previousRevision,
            fromStatus: "approved" as const, toStatus: "superseded" as const,
            eventType: "version_transition" as const, actorId: command.actorId,
            ...firstStamp
          });
          this.lifecycleEvents.push(event);
          lifecycleEvents.push(event);
        }
      }
      const decisionStamp = lifecycleEvents.length
        ? await this.temporalBarrier.allocateAppend(tx, workspaceId)
        : firstStamp;
      const nextStatus: QuoteVersion["status"] = command.decision === "approve"
        ? "approved" : command.decision === "reject" ? "rejected" : "expired";
      const lifecycle = immutableQuoteValue({
        id: `quote-lifecycle-${workspaceId}-${decisionStamp.temporalSequence}`,
        workspaceId, quoteCaseId: quoteCase.id, quoteVersionId: version.id,
        revision: currentRevision + 1, fromStatus: "submitted" as const,
        toStatus: nextStatus, eventType: "version_transition" as const,
        actorId: command.actorId, ...decisionStamp
      });
      this.lifecycleEvents.push(lifecycle);
      lifecycleEvents.push(lifecycle);
      const approvalStamp = await this.temporalBarrier.allocateAppend(tx,
        workspaceId);
      const approvalStatus: QuoteApproval["status"] = command.decision
        === "approve" ? "approved" : command.decision === "reject"
          ? "rejected" : "cancelled";
      const decidedApproval = immutableQuoteValue({ ...approval,
        status: approvalStatus, decidedBy: command.actorId,
        decidedAt: approvalStamp.recordedAt, reason: command.reason });
      this.approvals.set(this.caseKey(workspaceId, approval.id), decidedApproval);
      const approvalEvent = immutableQuoteValue({
        id: `quote-approval-event-${workspaceId}-${approvalStamp.temporalSequence}`,
        workspaceId, quoteVersionId: version.id, approvalId: approval.id,
        revision: 2, status: approvalStatus, actorId: command.actorId,
        reason: command.reason, ...approvalStamp
      });
      this.approvalEvents.push(approvalEvent);
      const authorityStamp = await this.temporalBarrier.allocateAppend(tx,
        workspaceId);
      const authorityRevision = existingAuthority.authorityRevision + 1;
      const commercialAmountHash = String(version.commercialAmountHash) as
        `sha256:${string}`;
      const evidence = immutableQuoteValue({
        candidateId: binding.candidateId, customerId: binding.customerId,
        dealId: binding.dealId,
        handoffContentHash: binding.handoffContentHash,
        dealContentHash: binding.dealContentHash,
        bindingHashSchemaVersion: binding.bindingHashSchemaVersion,
        bindingHash: binding.bindingHash
      });
      const authorityEvent = immutableQuoteValue({
        id: `deal-authority-${workspaceId}-${authorityStamp.temporalSequence}`,
        workspaceId, dealId: quoteCase.dealId, authorityRevision,
        quoteCaseId: quoteCase.id, quoteVersionId: version.id,
        previousQuoteVersionId: existingAuthority.quoteVersionId,
        eventType: command.decision === "approve" ? "approved" as const
          : command.decision === "reject" ? "rejected" as const
            : "expired" as const,
        currency: String(version.currency),
        quotedAmountMinor: Number(version.quotedAmountMinor),
        commercialAmountHash,
        commercialBindingEvidence: evidence,
        commercialBindingSnapshot: immutableQuoteValue(structuredClone(binding)),
        decidedAt: authorityStamp.recordedAt,
        ...authorityStamp
      });
      this.authorityEvents.push(authorityEvent);
      const authority = immutableQuoteValue({
        workspaceId, dealId: quoteCase.dealId,
        openQuoteCaseId: quoteCase.id,
        quoteVersionId: command.decision === "approve" ? version.id : null,
        commercialAmountHash: command.decision === "approve"
          ? commercialAmountHash : null,
        authorityRevision, updatedAt: authorityStamp.recordedAt
      });
      this.dealAuthorities.set(authorityKey, authority);
      const publicationStamp = await this.temporalBarrier.allocateAppend(tx,
        workspaceId);
      const stableKey = `quote-publication:${quoteCase.dealId}:${version.id}:${authorityRevision}`;
      const publicationOperation = immutableQuoteValue({
        id: `quote-publication-${workspaceId}-${publicationStamp.temporalSequence}`,
        workspaceId, quoteCaseId: quoteCase.id, quoteVersionId: version.id,
        dealId: quoteCase.dealId, dealAuthorityRevision: authorityRevision,
        commercialAmountHash,
        status: command.decision === "approve" ? "queued" as const
          : "cancelled" as const,
        piDocumentId: null, dealEventId: null, attempts: 0,
        lastErrorCode: null, idempotencyKey: stableKey,
        leaseOwner: null, fencingToken: 0, leaseExpiresAt: null,
        createdAt: publicationStamp.recordedAt,
        updatedAt: publicationStamp.recordedAt
      });
      this.publicationOperations.set(this.caseKey(workspaceId,
        publicationOperation.id), publicationOperation);
      const projectedVersion = immutableQuoteValue({ ...version,
        status: nextStatus, lifecycleRevision: currentRevision + 1 });
      this.versions.set(this.caseKey(workspaceId, version.id), projectedVersion);
      const result = immutableQuoteValue({ quoteVersion: projectedVersion,
        approval: decidedApproval, authority, authorityEvent,
        lifecycleEvents: Object.freeze(lifecycleEvents), publicationOperation });
      this.approvalDecisions.set(decisionKey, result);
      return result;
    });
  }

  async listVersions(workspaceId: string, quoteCaseId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    required(quoteCaseId, "invalid_quote_case_id");
    return Object.freeze([...this.versions.values()]
      .filter((row) => row.workspaceId === workspace
        && row.quoteCaseId === quoteCaseId)
      .sort((left, right) => left.version - right.version));
  }

  async findPreviewEvidence(workspaceId: string, id: string) {
    return this.previewEvidence.get(this.caseKey(
      assertConcreteGrowthWorkspaceId(workspaceId),
      required(id, "invalid_quote_preview_evidence_id")
    )) ?? null;
  }

  async findPreviewEvidenceByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const evidenceId = this.previewByStableHash.get(this.caseKey(
      workspace,
      required(stableCommandHash, "invalid_quote_stable_command_hash")
    ));
    return evidenceId ? this.previewEvidence.get(this.caseKey(
      workspace,
      evidenceId
    )) ?? null : null;
  }

  async appendOrGetPreviewEvidence(command: AppendQuotePreviewEvidenceCommand) {
    const workspaceId = assertConcreteGrowthWorkspaceId(command.workspaceId);
    return this.mutation(workspaceId, async (_tx, stamp) => {
      const stableKey = this.caseKey(workspaceId, command.stableCommandHash);
      const existingId = this.previewByStableHash.get(stableKey);
      if (existingId) {
        return this.previewEvidence.get(this.caseKey(workspaceId, existingId))!;
      }
      const quoteCase = this.cases.get(this.caseKey(
        workspaceId,
        required(command.quoteCaseId, "invalid_quote_case_id")
      ));
      if (!quoteCase) throw quoteError("quote_case_not_found");
      if (quoteCase.status !== "open") throw quoteError("quote_case_not_open");
      if (quoteCase.revision !== command.expectedQuoteCaseRevision) {
        throw quoteError("revision_conflict");
      }
      const subjectEvidence = quoteSubjectEvidence(quoteCase);
      const identity = {
        workspaceId,
        quoteCaseId: quoteCase.id,
        quoteCaseRevision: quoteCase.revision,
        salesOwnerActorId: quoteCase.assignedTo,
        subjectEvidence,
        createdBy: command.createdBy,
        requestHash: command.requestHash,
        stableCommandHash: command.stableCommandHash,
        previewIdentity: command.calculated.previewIdentity,
        inputSnapshotHash: command.calculated.inputSnapshotHash,
        calculationHash: command.calculated.calculationHash,
        effectiveAt: command.effectiveAt,
        recordedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      };
      const evidence: QuotePreviewEvidenceRecord = immutableQuoteValue({
        id: `quote-preview-${command.stableCommandHash.slice(7)}`,
        ...identity,
        frozenCalculationResult: snapshotQuoteCalculation(command.calculated),
        evidenceHash: hash({ schemaVersion: "quote-preview-evidence.v1", ...identity })
      });
      this.previewEvidence.set(this.caseKey(workspaceId, evidence.id), evidence);
      this.previewByStableHash.set(stableKey, evidence.id);
      return evidence;
    });
  }

  async findDraftByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    return [...this.versions.values()].find((row) =>
      row.workspaceId === workspace && row.versionKind === "draft"
      && row.stableCommandHash === stableCommandHash) ?? null;
  }

  async appendVersionFromCalculation(
    command: AppendQuoteVersionCommand
  ): Promise<AppendQuoteVersionResult> {
    const workspaceId = assertConcreteGrowthWorkspaceId(command.workspaceId);
    return this.mutation(workspaceId, async (tx, versionStamp) => {
      const existingStable = [...this.versions.values()].find((row) =>
        row.workspaceId === workspaceId
        && row.stableCommandHash === command.stableCommandHash);
      if (existingStable) {
        const approval = [...this.approvals.values()].find((row) =>
          row.workspaceId === workspaceId
          && row.quoteVersionId === existingStable.id) ?? null;
        return { version: existingStable, approval };
      }
      const quoteCase = this.cases.get(this.caseKey(
        workspaceId,
        required(command.quoteCaseId, "invalid_quote_case_id")
      ));
      if (!quoteCase) throw quoteError("quote_case_not_found");
      if (quoteCase.status !== "open") throw quoteError("quote_case_not_open");
      if (command.versionKind === "draft"
        && quoteCase.revision !== command.expectedQuoteCaseRevision) {
        throw quoteError("revision_conflict");
      }
      if (command.versionKind === "draft"
        && (command.sourceDraftVersionId !== null
          || command.probabilityAssessmentSnapshot !== null)) {
        throw quoteError("invalid_quote_version_authority");
      }
      let sourceDraft: QuoteVersion | null = null;
      if (command.versionKind === "formal") {
        if (!command.sourceDraftVersionId
          || !command.probabilityAssessmentSnapshot || !command.approval) {
          throw quoteError("invalid_quote_version_authority");
        }
        sourceDraft = this.versions.get(this.caseKey(
          workspaceId,
          command.sourceDraftVersionId
        )) ?? null;
        if (!sourceDraft || sourceDraft.quoteCaseId !== quoteCase.id
          || sourceDraft.versionKind !== "draft") {
          throw quoteError("quote_draft_not_found");
        }
        if (sourceDraft.lifecycleRevision !== command.expectedQuoteCaseRevision) {
          throw quoteError("revision_conflict");
        }
        const existingFormal = [...this.versions.values()].find((row) =>
          row.workspaceId === workspaceId
          && row.sourceDraftVersionId === sourceDraft!.id);
        if (existingFormal) throw quoteError("quote_draft_already_submitted");
      }
      const nextVersion = Math.max(0, ...[...this.versions.values()]
        .filter((row) => row.workspaceId === workspaceId
          && row.quoteCaseId === quoteCase.id)
        .map((row) => row.version)) + 1;
      const id = `${command.versionKind === "draft" ? "quote-draft" : "quote-formal"}-${command.stableCommandHash.slice(7)}`;
      const version = createQuoteVersionFromCalculation({
        id, quoteCase, version: nextVersion,
        versionKind: command.versionKind,
        sourceDraftVersionId: sourceDraft?.id ?? null,
        probabilityAssessmentSnapshot: command.probabilityAssessmentSnapshot,
        calculated: command.calculated, actorId: command.actorId,
        effectiveAt: command.effectiveAt,
        recordedAt: versionStamp.recordedAt,
        temporalSequence: versionStamp.temporalSequence,
        stableCommandHash: command.stableCommandHash,
        requestHash: command.requestHash
      });
      this.versions.set(this.caseKey(workspaceId, version.id), version);
      let approval: QuoteApproval | null = null;
      if (command.versionKind === "formal") {
        const lifecycleStamp = await this.temporalBarrier.allocateAppend(
          tx,
          workspaceId
        );
        this.lifecycleEvents.push(immutableQuoteValue({
          id: `quote-lifecycle-${workspaceId}-${lifecycleStamp.temporalSequence}`,
          workspaceId,
          quoteCaseId: quoteCase.id,
          quoteVersionId: version.id,
          revision: 1,
          fromStatus: null,
          toStatus: "submitted",
          eventType: "version_transition",
          actorId: command.actorId,
          ...lifecycleStamp
        }));
        const approvalStamp = await this.temporalBarrier.allocateAppend(
          tx,
          workspaceId
        );
        approval = immutableQuoteValue({
          id: `quote-approval-${workspaceId}-${approvalStamp.temporalSequence}`,
          workspaceId,
          quoteVersionId: version.id,
          status: "pending",
          approvalKind: command.approval!.approvalKind,
          requiredCapabilities: [...command.approval!.requiredCapabilities],
          triggeredRules: [...command.approval!.triggeredRules],
          pricingPolicyVersionId: command.approval!.pricingPolicyVersionId,
          policySnapshotHash: command.approval!.policySnapshotHash,
          capabilityRegistryVersion: command.approval!.capabilityRegistryVersion,
          submittedBy: command.actorId,
          submittedAt: approvalStamp.recordedAt,
          decidedBy: null,
          decidedAt: null,
          reason: null
        });
        this.approvals.set(this.caseKey(workspaceId, approval.id), approval);
      }
      const storedCase = immutableCase({
        ...quoteCase,
        currentDraftVersionId: command.versionKind === "draft"
          ? version.id : quoteCase.currentDraftVersionId,
        revision: quoteCase.revision + 1,
        updatedAt: versionStamp.recordedAt
      });
      this.cases.set(this.caseKey(workspaceId, quoteCase.id), storedCase);
      return { version, approval };
    });
  }

  async createCase(command: CreateQuoteCaseCommand) {
    command = { ...command,
      workspaceId: assertConcreteGrowthWorkspaceId(command.workspaceId) };
    const replay = this.replay(command);
    if (replay) return replay;
    return this.mutation(command.workspaceId, async (tx, caseStamp) => {
      const secondReplay = this.replay(command);
      if (secondReplay) return secondReplay;
      const value = command.quoteCase;
      if (value.workspaceId !== command.workspaceId || value.revision !== 1
        || value.status !== "open" || value.assignedTo.trim() === ""
        || (!value.candidateId && !value.customerId && !value.dealId)
        || this.cases.has(this.caseKey(value.workspaceId, value.id))) {
        throw quoteError("invalid_quote_case_create");
      }
      if (value.dealId) {
        if (!command.bindingSnapshot || !command.probabilityAssessment) {
          throw quoteError("commercial_binding_required");
        }
        const conflict = [...this.cases.values()].some((row) =>
          row.workspaceId === value.workspaceId && row.dealId === value.dealId
          && row.status === "open");
        if (conflict) throw quoteError("deal_open_quote_case_conflict");
      }
      const stored = immutableCase({ ...value,
        createdAt: caseStamp.recordedAt, updatedAt: caseStamp.recordedAt });
      this.cases.set(this.caseKey(stored.workspaceId, stored.id), stored);
      if (command.bindingSnapshot && command.probabilityAssessment) {
        await this.temporalBarrier.allocateAppend(tx, command.workspaceId);
        this.bindingSnapshots.set(this.caseKey(stored.workspaceId, stored.id),
          Object.freeze(structuredClone(command.bindingSnapshot)));
        this.boundAssessments.set(this.caseKey(stored.workspaceId, stored.id),
          Object.freeze(structuredClone(command.probabilityAssessment)));
        this.dealAuthorities.set(this.caseKey(stored.workspaceId, stored.dealId!),
          Object.freeze({ workspaceId: stored.workspaceId, dealId: stored.dealId!,
            openQuoteCaseId: stored.id, quoteVersionId: null,
            commercialAmountHash: null, authorityRevision: 1,
            updatedAt: caseStamp.recordedAt }));
      }
      const lifecycleStamp = await this.temporalBarrier.allocateAppend(
        tx,
        command.workspaceId
      );
      this.appendCaseLifecycle({
        workspaceId: stored.workspaceId, quoteCaseId: stored.id,
        quoteVersionId: null, revision: 1, fromStatus: null,
        toStatus: "open", eventType: "case_created", actorId: command.actorId
      }, lifecycleStamp);
      if (stored.dealId) {
        const authorityStamp = await this.temporalBarrier.allocateAppend(
          tx,
          command.workspaceId
        );
        this.authorityEvents.push(Object.freeze({
          id: `deal-quote-authority-${stored.workspaceId}-${authorityStamp.temporalSequence}`,
          workspaceId: stored.workspaceId, dealId: stored.dealId,
          authorityRevision: 1, quoteCaseId: stored.id, quoteVersionId: null,
          eventType: "case_bound", ...authorityStamp
        }));
      }
      this.complete(command, stored);
      return { quoteCase: stored, replayed: false };
    });
  }

  async bindCaseDeal(command: BindQuoteCaseDealCommand) {
    command = { ...command,
      workspaceId: assertConcreteGrowthWorkspaceId(command.workspaceId) };
    const replay = this.replay(command);
    if (replay) return replay;
    return this.mutation(command.workspaceId, async (tx, caseStamp) => {
      const secondReplay = this.replay(command);
      if (secondReplay) return secondReplay;
      const current = this.currentCase(command, command.quoteCaseId);
      if (current.status !== "open") throw quoteError("quote_case_not_open");
      if (current.dealId) {
        if (current.dealId !== command.dealId) {
          throw quoteError("quote_case_rebind_forbidden");
        }
        this.complete(command, current);
        return { quoteCase: current, replayed: true };
      }
      if (command.bindingSnapshot.dealId !== command.dealId
        || command.bindingSnapshot.candidateId !== current.candidateId
        || command.probabilityAssessment.workspaceId !== command.workspaceId
        || command.probabilityAssessment.candidateId !== current.candidateId
        || command.probabilityAssessment.dealId !== command.dealId) {
        throw quoteError("commercial_binding_authority_mismatch");
      }
      const authorityKey = this.caseKey(command.workspaceId, command.dealId);
      const guard = this.dealAuthorities.get(authorityKey);
      if (guard?.openQuoteCaseId && guard.openQuoteCaseId !== current.id) {
        throw quoteError("deal_open_quote_case_conflict");
      }
      const conflicting = [...this.cases.values()].some((row) =>
        row.workspaceId === command.workspaceId && row.dealId === command.dealId
        && row.status === "open" && row.id !== current.id);
      if (conflicting) throw quoteError("deal_open_quote_case_conflict");
      const stored = immutableCase({ ...current,
        customerId: command.bindingSnapshot.customerId,
        dealId: command.dealId,
        revision: current.revision + 1,
        commercialBindingSnapshot: command.bindingSnapshot,
        updatedAt: caseStamp.recordedAt
      });
      const nextAuthorityRevision = (guard?.authorityRevision ?? 0) + 1;
      this.dealAuthorities.set(authorityKey, Object.freeze({
        workspaceId: command.workspaceId, dealId: command.dealId,
        openQuoteCaseId: stored.id, quoteVersionId: guard?.quoteVersionId ?? null,
        commercialAmountHash: guard?.commercialAmountHash ?? null,
        authorityRevision: nextAuthorityRevision, updatedAt: caseStamp.recordedAt
      }));
      this.cases.set(this.caseKey(stored.workspaceId, stored.id), stored);
      await this.temporalBarrier.allocateAppend(tx, command.workspaceId);
      this.bindingSnapshots.set(this.caseKey(stored.workspaceId, stored.id),
        Object.freeze(structuredClone(command.bindingSnapshot)));
      this.boundAssessments.set(this.caseKey(stored.workspaceId, stored.id),
        Object.freeze(structuredClone(command.probabilityAssessment)));
      const lifecycleStamp = await this.temporalBarrier.allocateAppend(
        tx,
        command.workspaceId
      );
      this.appendCaseLifecycle({
        workspaceId: stored.workspaceId, quoteCaseId: stored.id,
        quoteVersionId: null, revision: stored.revision,
        fromStatus: "open", toStatus: "open", eventType: "deal_bound",
        actorId: command.actorId
      }, lifecycleStamp);
      const authorityStamp = await this.temporalBarrier.allocateAppend(
        tx,
        command.workspaceId
      );
      this.authorityEvents.push(Object.freeze({
        id: `deal-quote-authority-${command.workspaceId}-${authorityStamp.temporalSequence}`,
        workspaceId: command.workspaceId, dealId: command.dealId,
        authorityRevision: nextAuthorityRevision, quoteCaseId: stored.id,
        quoteVersionId: null, eventType: "case_bound", ...authorityStamp
      }));
      this.complete(command, stored);
      return { quoteCase: stored, replayed: false };
    });
  }

  private async terminal(
    command: CloseQuoteCaseCommand | CancelQuoteCaseCommand,
    status: "closed" | "cancelled"
  ): Promise<QuoteCaseCommandResult> {
    command = { ...command,
      workspaceId: assertConcreteGrowthWorkspaceId(command.workspaceId) };
    const replay = this.replay(command);
    if (replay) return replay;
    return this.mutation(command.workspaceId, async (tx, stamp) => {
      const secondReplay = this.replay(command);
      if (secondReplay) return secondReplay;
      const current = this.currentCase(command, command.quoteCaseId);
      if (current.status !== "open") throw quoteError("quote_case_not_open");
      if (this.activeFormalVersion(command.workspaceId, current.id)) {
        throw quoteError("quote_case_has_active_formal_version");
      }
      if (status === "cancelled") {
        for (const [key, version] of this.versions) {
          if (version.workspaceId === command.workspaceId
            && version.quoteCaseId === current.id
            && version.status === "draft") {
            this.versions.set(key, Object.freeze({ ...version,
              status: "expired",
              lifecycleRevision: version.lifecycleRevision + 1
            }));
            const versionStamp = await this.temporalBarrier.allocateAppend(
              tx,
              command.workspaceId
            );
            this.appendCaseLifecycle({
              workspaceId: command.workspaceId, quoteCaseId: current.id,
              quoteVersionId: version.id,
              revision: version.lifecycleRevision + 1,
              fromStatus: "draft", toStatus: "expired",
              eventType: "version_expired", actorId: command.actorId
            }, versionStamp);
          }
        }
      }
      const stored = immutableCase({ ...current, status,
        revision: current.revision + 1, updatedAt: stamp.recordedAt });
      this.cases.set(this.caseKey(stored.workspaceId, stored.id), stored);
      const lifecycleStamp = await this.temporalBarrier.allocateAppend(
        tx,
        command.workspaceId
      );
      this.appendCaseLifecycle({
        workspaceId: stored.workspaceId, quoteCaseId: stored.id,
        quoteVersionId: null, revision: stored.revision,
        fromStatus: "open", toStatus: status,
        eventType: status === "closed" ? "case_closed" : "case_cancelled",
        actorId: command.actorId
      }, lifecycleStamp);
      if (stored.dealId) {
        const authorityKey = this.caseKey(stored.workspaceId, stored.dealId);
        const guard = this.dealAuthorities.get(authorityKey);
        if (guard?.openQuoteCaseId === stored.id) {
          this.dealAuthorities.set(authorityKey, Object.freeze({ ...guard,
            openQuoteCaseId: null, authorityRevision: guard.authorityRevision + 1,
            updatedAt: stamp.recordedAt }));
        }
      }
      this.complete(command, stored);
      return { quoteCase: stored, replayed: false };
    });
  }

  closeCase(command: CloseQuoteCaseCommand) {
    return this.terminal(command, "closed");
  }

  cancelCase(command: CancelQuoteCaseCommand) {
    return this.terminal(command, "cancelled");
  }

  private publicationEntry(operationId: string) {
    const matches = [...this.publicationOperations.entries()].filter(([, row]) =>
      row.id === operationId);
    if (matches.length > 1) throw quoteError("publication_identity_ambiguous");
    return matches[0] ?? null;
  }

  private async publicationMutation<T>(
    operationId: string,
    work: (
      tx: GrowthTemporalTransaction,
      key: string,
      operation: QuotePublicationOperation,
      databaseNow: string
    ) => Promise<T>
  ): Promise<T | null> {
    const initial = this.publicationEntry(operationId);
    if (!initial) return null;
    const workspaceId = initial[1].workspaceId;
    let release: (() => void) | undefined;
    let snapshot: ReturnType<InMemoryQuoteRepository["snapshotState"]>
      | undefined;
    try {
      return await this.transactions.run(async (tx) => {
        await tx.lockWorkspaceTemporalBarrierForUpdate(workspaceId);
        release = await this.acquireWorkspaceMutationGate(workspaceId);
        snapshot = this.snapshotState();
        const current = this.publicationEntry(operationId);
        if (!current || current[1].workspaceId !== workspaceId) return null;
        return work(tx, current[0], current[1], await tx.currentTimestamp3());
      });
    } catch (error) {
      if (snapshot) this.restoreState(snapshot);
      throw error;
    } finally {
      release?.();
    }
  }

  private livePublication(
    operation: QuotePublicationOperation,
    claim: QuotePublicationClaim,
    databaseNow: string
  ) {
    return operation.status === "running"
      && operation.leaseOwner === claim.leaseOwner
      && operation.fencingToken === claim.fencingToken
      && operation.dealAuthorityRevision === claim.authorityRevision
      && growthInstant(operation.leaseExpiresAt) > growthInstant(databaseNow);
  }

  private async appendPublicationHistory(
    tx: GrowthTemporalTransaction,
    operation: QuotePublicationOperation,
    errorCode: string | null,
    actorId: string | null
  ) {
    const stamp = await this.temporalBarrier.allocateAppend(
      tx,
      operation.workspaceId
    );
    this.publicationHistory.push(immutableQuoteValue({
      id: `quote-publication-history-${operation.workspaceId}-${stamp.temporalSequence}`,
      workspaceId: operation.workspaceId, operationId: operation.id,
      status: operation.status, leaseOwner: operation.leaseOwner,
      fencingToken: operation.fencingToken,
      authorityRevision: operation.dealAuthorityRevision,
      piDocumentId: operation.piDocumentId,
      dealEventId: operation.dealEventId,
      errorCode, actorId, ...stamp
    }));
    return stamp;
  }

  async getPublication(operationId: string) {
    const operation = this.publicationEntry(required(operationId,
      "invalid_publication_operation_id"))?.[1] ?? null;
    return operation ? immutableQuoteValue(structuredClone(operation)) : null;
  }

  async claimPublication(
    operationId: string,
    workerId: string,
    _now: string,
    nextExpiry: string
  ): Promise<QuotePublicationClaim | null> {
    const result = await this.publicationMutation(operationId,
      async (tx, key, operation, databaseNow) => {
        const recoverable = operation.status === "queued"
          || operation.status === "failed"
          || operation.status === "partial_failure"
          || operation.status === "running"
            && growthInstant(operation.leaseExpiresAt) <= growthInstant(databaseNow);
        if (!recoverable
          || growthInstant(nextExpiry) <= growthInstant(databaseNow)) return null;
        const running = immutableQuoteValue({ ...operation,
          status: "running" as const,
          leaseOwner: required(workerId, "invalid_publication_worker_id"),
          fencingToken: operation.fencingToken + 1,
          leaseExpiresAt: nextExpiry,
          attempts: operation.attempts + 1,
          lastErrorCode: null,
          updatedAt: databaseNow
        });
        this.publicationOperations.set(key, running);
        await this.appendPublicationHistory(tx, running, null, null);
        const reread = this.publicationOperations.get(key)!;
        if (reread.status !== "running" || reread.leaseOwner !== workerId
          || reread.fencingToken !== running.fencingToken
          || reread.dealAuthorityRevision !== operation.dealAuthorityRevision
          || growthInstant(reread.leaseExpiresAt) <= growthInstant(databaseNow)) {
          throw quoteError("publication_claim_readback_failed");
        }
        return Object.freeze({ operationId: reread.id,
          leaseOwner: workerId, fencingToken: reread.fencingToken,
          leaseExpiresAt: reread.leaseExpiresAt!,
          authorityRevision: reread.dealAuthorityRevision });
      });
    return result ?? null;
  }

  private async transitionPublication(
    claim: QuotePublicationClaim,
    change: (operation: QuotePublicationOperation, databaseNow: string) =>
      QuotePublicationOperation,
    errorCode: string | null = null
  ) {
    const result = await this.publicationMutation(claim.operationId,
      async (tx, key, operation, databaseNow) => {
        if (!this.livePublication(operation, claim, databaseNow)) return false;
        const next = immutableQuoteValue(change(operation, databaseNow));
        this.publicationOperations.set(key, next);
        await this.appendPublicationHistory(tx, next, errorCode, null);
        return true;
      });
    return result === true;
  }

  renewPublicationLease(claim: QuotePublicationClaim, _now: string,
    nextExpiry: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => {
      if (growthInstant(nextExpiry) <= growthInstant(databaseNow)) {
        throw quoteError("invalid_publication_lease_expiry");
      }
      return { ...operation, leaseExpiresAt: nextExpiry,
        updatedAt: databaseNow };
    });
  }

  recordPiPublished(claim: QuotePublicationClaim, piDocumentId: string,
    _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation,
      piDocumentId: operation.piDocumentId
        ?? required(piDocumentId, "invalid_pi_document_id"),
      updatedAt: databaseNow
    }));
  }

  recordCrmPublished(claim: QuotePublicationClaim, dealEventId: string,
    _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation,
      dealEventId: operation.dealEventId
        ?? required(dealEventId, "invalid_deal_event_id"),
      updatedAt: databaseNow
    }));
  }

  finishPublication(claim: QuotePublicationClaim, _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => {
      if (!operation.piDocumentId || !operation.dealEventId) {
        throw quoteError("publication_receipts_incomplete");
      }
      return { ...operation, status: "succeeded" as const,
        leaseOwner: null, leaseExpiresAt: null, updatedAt: databaseNow };
    });
  }

  failPublication(claim: QuotePublicationClaim, errorCode: string,
    _now: string) {
    const code = required(errorCode, "invalid_publication_error_code");
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation,
      status: operation.piDocumentId || operation.dealEventId
        ? "partial_failure" as const : "failed" as const,
      leaseOwner: null, leaseExpiresAt: null, lastErrorCode: code,
      updatedAt: databaseNow
    }), code);
  }

  cancelPublication(claim: QuotePublicationClaim, errorCode: string,
    _now: string) {
    const code = required(errorCode, "invalid_publication_error_code");
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation, status: code === "publication_superseded"
        ? "superseded" as const : "cancelled" as const,
      leaseOwner: null, leaseExpiresAt: null, lastErrorCode: code,
      updatedAt: databaseNow
    }), code);
  }

  async isPublicationAuthorityCurrent(claim: QuotePublicationClaim) {
    const operation = await this.getPublication(claim.operationId);
    if (!operation) return false;
    const authority = this.dealAuthorities.get(this.caseKey(
      operation.workspaceId,
      operation.dealId
    ));
    return Boolean(authority
      && authority.authorityRevision === claim.authorityRevision
      && authority.quoteVersionId === operation.quoteVersionId
      && authority.openQuoteCaseId === operation.quoteCaseId
      && authority.commercialAmountHash === operation.commercialAmountHash);
  }

  async listRecoverablePublications(now?: string, limit = 100) {
    const databaseNow = now ?? "9999-12-31T23:59:59.999Z";
    return Object.freeze([...this.publicationOperations.values()]
      .filter((row) => row.status === "queued" || row.status === "failed"
        || row.status === "partial_failure" || row.status === "running"
          && growthInstant(row.leaseExpiresAt) <= growthInstant(databaseNow))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, limit))
      .map((row) => immutableQuoteValue(structuredClone(row))));
  }

  async retryPublication(operationId: string, context: ActiveWorkspaceContext,
    _now: string) {
    requireGrowthCapabilities(context, ["quote.confirm"]);
    const result = await this.publicationMutation(operationId,
      async (tx, key, operation, databaseNow) => {
        if (context.workspaceId !== operation.workspaceId) {
          throw quoteError("publication_workspace_mismatch");
        }
        if (operation.status !== "failed"
          && operation.status !== "partial_failure") {
          throw quoteError("publication_not_retryable");
        }
        const queued = immutableQuoteValue({ ...operation,
          status: "queued" as const, leaseOwner: null, leaseExpiresAt: null,
          fencingToken: operation.fencingToken + 1, lastErrorCode: null,
          updatedAt: databaseNow
        });
        this.publicationOperations.set(key, queued);
        await this.appendPublicationHistory(tx, queued, null, context.actorId);
        return queued;
      });
    if (!result) throw quoteError("publication_not_found");
    return result;
  }

  async listPublicationHistory(operationId: string) {
    return Object.freeze(this.publicationHistory.filter((row) =>
      row.operationId === operationId).map((row) =>
        immutableQuoteValue(structuredClone(row))));
  }

  async countCases(workspaceId: string) {
    return [...this.cases.values()].filter((row) =>
      row.workspaceId === workspaceId).length;
  }

  async countVersions(workspaceId: string, quoteCaseId: string) {
    return (await this.listVersions(workspaceId, quoteCaseId)).length;
  }

  async countFormalVersions(workspaceId: string, quoteCaseId: string) {
    return (await this.listVersions(workspaceId, quoteCaseId)).filter((row) =>
      row.versionKind === "formal").length;
  }

  async countPreviewEvidence(workspaceId: string, quoteCaseId: string) {
    return [...this.previewEvidence.values()].filter((row) =>
      row.workspaceId === workspaceId && row.quoteCaseId === quoteCaseId).length;
  }

  async listPreviewEvidence(
    workspaceId: string,
    quoteCaseId: string,
    inputSnapshotHash?: string,
    calculationHash?: string
  ) {
    return [...this.previewEvidence.values()].filter((row) =>
      row.workspaceId === workspaceId && row.quoteCaseId === quoteCaseId
      && (!inputSnapshotHash || row.inputSnapshotHash === inputSnapshotHash)
      && (!calculationHash || row.calculationHash === calculationHash));
  }

  async countApprovals(workspaceId: string) {
    return [...this.approvals.values()].filter((row) =>
      row.workspaceId === workspaceId).length;
  }

  async countBindings(workspaceId: string) {
    return [...this.bindingSnapshots.keys()].filter((key) =>
      key.startsWith(`${workspaceId}\u0000`)).length;
  }

  async countLifecycleEvents(workspaceId: string) {
    return this.lifecycleEvents.filter((row) =>
      row.workspaceId === workspaceId).length;
  }

  async listVersionStatuses(workspaceId: string, quoteCaseId: string) {
    return [...this.versions.values()].filter((row) =>
      row.workspaceId === workspaceId && row.quoteCaseId === quoteCaseId)
      .map((row) => row.status);
  }

  async boundProbabilityAssessmentId(workspaceId: string, quoteCaseId: string) {
    return this.boundAssessments.get(this.caseKey(workspaceId, quoteCaseId))?.id
      ?? null;
  }

  async findDealAuthority(workspaceId: string, dealId: string) {
    return this.dealAuthorities.get(this.caseKey(workspaceId, dealId)) ?? null;
  }
}
