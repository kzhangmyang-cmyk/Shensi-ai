import { createHash } from "node:crypto";
import {
  assertGrowthAsOfNotFuture
} from "./growth-as-of.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AdvisorMetricRef,
  AdvisorEvidenceRef,
  AdvisorEntityRef,
  AdvisorRecommendedAction,
  FinancialDataGapCode,
  GrowthRoiSliceKey
} from "./growth-contract-types.js";
import type {
  AdvisorCandidateEvidenceAsOfReader
} from "./growth-advisor-query.js";
import {
  assertAdvisorVisibilitySnapshot,
  type AdvisorVisibilityResolver,
  type AdvisorVisibilitySnapshot
} from "./growth-advisor-query.js";
import type {
  QuotePreviewEvidenceReader
} from "./quote-preview-evidence-reader.js";
import type {
  QuoteVersionEvidenceReader,
  DealAuthoritativeQuoteReader
} from "./authoritative-quote-reader.js";
import type {
  VerifiedFinancialLedgerSealedReader
} from "./financial-ledger-as-of-reader.js";
import type {
  FinancialDataGapSealedReader
} from "./financial-data-gap-reader.js";
import type {
  AcquisitionGrowthPerformanceQueryService
} from "./acquisition-growth-performance-query.js";
import type {
  RoiClosureEvidenceSealedReader
} from "./roi-closure-evidence-reader.js";
import {
  advisorSnapshotHash,
  type AdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import type { AdvisorRecommendation } from "./advisor-recommendation-domain.js";
import {
  applyAdvisorTransition,
  type AdvisorTransitionInput
} from "./advisor-recommendation-domain.js";
import { stableAdvisorActionHash } from "./advisor-action-operation.js";
import type {
  GrowthWorkspaceMemberAssignabilityReader
} from "./growth-workspace-member-assignability.js";
import type {
  FinancialCouncilApprovalProof,
  FinancialCouncilApprovalProofIssuer
} from "./financial-council-approval.js";

export interface AdvisorReferenceSet {
  readonly metricRefs: readonly AdvisorMetricRef[];
  readonly evidenceRefs: readonly AdvisorEvidenceRef[];
  readonly entityRefs: readonly AdvisorEntityRef[];
}

export interface VerifiedAdvisorReferenceSnapshot {
  readonly refs: AdvisorReferenceSet;
  readonly visibilitySourceHash: `sha256:${string}`;
  readonly dataAsOf: string;
}

export interface AdvisorReferenceVerifierPorts {
  readonly candidateEvidence: AdvisorCandidateEvidenceAsOfReader;
  readonly quote: {
    readonly previews: Pick<QuotePreviewEvidenceReader, "verifyAt">;
    readonly quoteVersions: Pick<QuoteVersionEvidenceReader, "getAt">;
    readonly dealAuthoritativeQuotes: Pick<
      DealAuthoritativeQuoteReader,
      "getAt" | "getDecisionAt"
    >;
  };
  readonly finance: {
    readonly verifiedAsOf: Pick<
      VerifiedFinancialLedgerSealedReader,
      "getVerifiedAt"
    >;
    readonly financialGaps: Pick<FinancialDataGapSealedReader, "verifyAt">;
  };
  readonly roi: {
    readonly growthPerformance: Pick<
      AcquisitionGrowthPerformanceQueryService,
      "getAt"
    >;
    readonly closureEvidence: Pick<RoiClosureEvidenceSealedReader, "getAt">;
  };
}

export interface AdvisorReferenceVerifier {
  verify(
    context: ActiveWorkspaceContext,
    refs: AdvisorReferenceSet,
    cutoff: GrowthSealedReadCutoff,
    visibility: AdvisorVisibilitySnapshot
  ): Promise<VerifiedAdvisorReferenceSnapshot>;
}

function advisorReferenceError(message = "advisor_reference_invalid"): Error {
  return Object.assign(new Error(message), { code: "advisor_reference_invalid" });
}

function inSet(value: string | null, allowed: readonly string[]): boolean {
  return value === null || allowed.includes(value);
}

function requireSet(
  value: string,
  allowed: readonly string[],
  label: string
): void {
  if (!allowed.includes(value)) {
    throw advisorReferenceError(`${label}_not_visible`);
  }
}

export class DefaultAdvisorReferenceVerifier
implements AdvisorReferenceVerifier {
  constructor(private readonly ports: AdvisorReferenceVerifierPorts) {}

  async verify(
    context: ActiveWorkspaceContext,
    refs: AdvisorReferenceSet,
    cutoff: GrowthSealedReadCutoff,
    visibility: AdvisorVisibilitySnapshot
  ): Promise<VerifiedAdvisorReferenceSnapshot> {
    assertAdvisorVisibilitySnapshot(visibility);
    if (cutoff.workspaceId !== context.workspaceId
      || visibility.sourceSnapshotHash !== visibility.sourceSnapshotHash) {
      throw advisorReferenceError();
    }
    const subjects = visibility.subjectVisibility;
    for (const ref of refs.metricRefs) {
      if ("asOf" in ref && ref.asOf !== cutoff.effectiveAsOf) {
        throw advisorReferenceError();
      }
    }
    for (const ref of refs.metricRefs) {
      switch (ref.kind) {
        case "growth_performance": {
          requireSet(ref.cohortId, subjects.cohortIds, "cohort");
          if (ref.sliceKey !== "all" && ref.planId === null) {
            throw advisorReferenceError();
          }
          const dto = await this.ports.roi.growthPerformance.getAt(
            context,
            {
              cohortId: ref.cohortId,
              currency: ref.currency,
              planId: ref.planId,
              closureVersionId: ref.closureVersionId
            },
            cutoff
          );
          if (!dto || dto.calculationHash !== ref.calculationHash) {
            throw advisorReferenceError();
          }
          break;
        }
        case "quote_preview": {
          const snapshot = await this.ports.quote.previews.verifyAt(
            context,
            {
              quoteCaseId: ref.quoteCaseId,
              previewIdentity: ref.previewIdentity,
              inputSnapshotHash: ref.inputSnapshotHash,
              calculationHash: ref.calculationHash
            },
            cutoff
          );
          if (!snapshot) throw advisorReferenceError();
          assertSalesOwner(snapshot.salesOwnerActorId, visibility);
          assertSubjectEvidence(snapshot.subjectEvidence, subjects);
          break;
        }
        case "priority_score": {
          const snapshot = await this.ports.candidateEvidence.getAt(
            context,
            { candidateId: ref.candidateId, cutoff }
          );
          if (!snapshot
            || snapshot.qualificationDecisionId
              !== ref.qualificationDecisionId
            || snapshot.qualificationDecisionVersion
              !== ref.qualificationDecisionVersion
            || snapshot.qualificationSnapshotHash !== ref.inputSnapshotHash) {
            throw advisorReferenceError();
          }
          requireSet(ref.candidateId, subjects.candidateIds, "candidate");
          break;
        }
        case "financial_data_gap": {
          const gap = await this.ports.finance.financialGaps.verifyAt(
            context,
            {
              visibility: visibility.financialGapVisibility,
              sourceType: ref.sourceType,
              sourceId: ref.sourceId,
              gapCode: ref.gapCode,
              currency: ref.currency,
              cutoff,
              sourceSnapshotHash: ref.sourceSnapshotHash,
              cohortId: ref.cohortId
            }
          );
          if (!gap) throw advisorReferenceError();
          assertGapBindings(gap, subjects);
          break;
        }
        default: {
          throw advisorReferenceError();
        }
      }
    }
    for (const ref of refs.evidenceRefs) {
      switch (ref.kind) {
        case "candidate_evidence": {
          const snapshot = await this.ports.candidateEvidence.getAt(
            context,
            { candidateId: ref.candidateId, cutoff }
          );
          if (!snapshot
            || snapshot.qualificationDecisionId
              !== ref.qualificationDecisionId
            || snapshot.qualificationDecisionVersion
              !== ref.qualificationDecisionVersion
            || snapshot.qualificationSnapshotHash !== ref.inputSnapshotHash) {
            throw advisorReferenceError();
          }
          requireSet(ref.candidateId, subjects.candidateIds, "candidate");
          const evidence = snapshot.evidence.find((item) =>
            item.evidenceId === ref.evidenceId);
          if (!evidence || evidence.contentHash !== ref.contentHash) {
            throw advisorReferenceError();
          }
          break;
        }
        case "quote_version": {
          const snapshot = await this.ports.quote.quoteVersions.getAt(
            context, ref.quoteVersionId, cutoff
          );
          if (!snapshot
            || snapshot.lifecycleRevision !== ref.lifecycleRevision
            || snapshot.commercialAmountHash !== ref.commercialAmountHash) {
            throw advisorReferenceError();
          }
          assertSalesOwner(snapshot.salesOwnerActorId, visibility);
          assertBindingEvidence(
            snapshot.commercialBindingEvidence,
            subjects
          );
          break;
        }
        case "ledger_entry": {
          const row = await this.ports.finance.verifiedAsOf.getVerifiedAt(
            cutoff,
            {
              ledgerType: ref.ledgerType,
              entryId: ref.ledgerEntryId,
              currency: ref.currency
            }
          );
          if (!row || row.verificationEventId !== ref.verificationEventId
            || row.verificationRevision !== ref.verificationRevision
            || row.evidenceHash !== ref.evidenceHash) {
            throw advisorReferenceError();
          }
          assertLedgerBindings(
            row as {
              candidateId?: string | null;
              customerId?: string | null;
              dealId?: string | null;
              cohortId?: string | null;
            },
            subjects
          );
          break;
        }
        case "roi_snapshot": {
          const evidence = await this.ports.roi.closureEvidence.getAt(
            context,
            {
              closureVersionId: ref.closureVersionId,
              sliceKey: ref.sliceKey,
              cutoff
            }
          );
          if (!evidence
            || evidence.version !== ref.version
            || evidence.calculationHash !== ref.calculationHash) {
            throw advisorReferenceError();
          }
          requireSet(evidence.cohortId, subjects.cohortIds, "cohort");
          break;
        }
        default: {
          throw advisorReferenceError();
        }
      }
    }
    for (const ref of refs.entityRefs) {
      switch (ref.kind) {
        case "customer": {
          const snapshot = await this.ports.quote.quoteVersions.getAt(
            context, ref.quoteVersionId, cutoff
          );
          if (!snapshot) throw advisorReferenceError();
          const binding = snapshot.commercialBindingEvidence;
          if (binding.customerId !== ref.id
            || binding.handoffContentHash !== ref.handoffContentHash
            || binding.bindingHashSchemaVersion
              !== ref.bindingHashSchemaVersion) {
            throw advisorReferenceError();
          }
          assertSalesOwner(snapshot.salesOwnerActorId, visibility);
          assertBindingEvidence(binding, subjects);
          break;
        }
        case "deal": {
          const snapshot = await this.ports.quote.quoteVersions.getAt(
            context, ref.quoteVersionId, cutoff
          );
          if (!snapshot) throw advisorReferenceError();
          const binding = snapshot.commercialBindingEvidence;
          if (binding.dealId !== ref.id
            || binding.dealContentHash !== ref.dealContentHash
            || binding.bindingHashSchemaVersion
              !== ref.bindingHashSchemaVersion) {
            throw advisorReferenceError();
          }
          assertSalesOwner(snapshot.salesOwnerActorId, visibility);
          assertBindingEvidence(binding, subjects);
          await this.verifyDealAuthority(
            context, ref, snapshot.commercialAmountHash, cutoff
          );
          break;
        }
        case "quote_version": {
          const snapshot = await this.ports.quote.quoteVersions.getAt(
            context, ref.id, cutoff
          );
          if (!snapshot
            || snapshot.lifecycleRevision !== ref.lifecycleRevision
            || snapshot.commercialAmountHash !== ref.commercialAmountHash) {
            throw advisorReferenceError();
          }
          assertSalesOwner(snapshot.salesOwnerActorId, visibility);
          assertBindingEvidence(
            snapshot.commercialBindingEvidence,
            subjects
          );
          break;
        }
        case "closure_version": {
          const evidence = await this.ports.roi.closureEvidence.getAt(
            context,
            {
              closureVersionId: ref.id,
              sliceKey: ref.sliceKey,
              cutoff
            }
          );
          if (!evidence
            || evidence.version !== ref.version
            || evidence.calculationHash !== ref.calculationHash) {
            throw advisorReferenceError();
          }
          requireSet(evidence.cohortId, subjects.cohortIds, "cohort");
          break;
        }
        default: {
          throw advisorReferenceError();
        }
      }
    }
    return Object.freeze({
      refs: Object.freeze({
        metricRefs: Object.freeze([...refs.metricRefs]),
        evidenceRefs: Object.freeze([...refs.evidenceRefs]),
        entityRefs: Object.freeze([...refs.entityRefs])
      }),
      visibilitySourceHash: visibility.sourceSnapshotHash,
      dataAsOf: cutoff.effectiveAsOf
    });
  }

  private async verifyDealAuthority(
    context: ActiveWorkspaceContext,
    ref: Extract<AdvisorEntityRef, { kind: "deal" }>,
    commercialAmountHash: `sha256:${string}`,
    cutoff: GrowthSealedReadCutoff
  ): Promise<void> {
    const current = await this.ports.quote.dealAuthoritativeQuotes.getAt(
      context, ref.id, cutoff
    );
    if (ref.dealAuthorityRevision === null) {
      const decision = await this.ports.quote.dealAuthoritativeQuotes
        .getDecisionAt(context, ref.id, cutoff);
      if (current || decision) throw advisorReferenceError();
      return;
    }
    let authority = current;
    if (!authority || authority.authorityRevision !== ref.dealAuthorityRevision) {
      const decision = await this.ports.quote.dealAuthoritativeQuotes
        .getDecisionAt(context, ref.id, cutoff);
      if (!decision
        || decision.authorityRevision !== ref.dealAuthorityRevision) {
        throw advisorReferenceError();
      }
      authority = decision as unknown as NonNullable<typeof current>;
    }
    if (authority.quoteVersionId !== ref.quoteVersionId
      || authority.commercialAmountHash !== commercialAmountHash) {
      throw advisorReferenceError();
    }
  }
}

function assertSalesOwner(
  salesOwnerActorId: string,
  visibility: AdvisorVisibilitySnapshot
): void {
  const scope = visibility.scope;
  if (scope.kind === "sales_own" && salesOwnerActorId !== scope.actorId) {
    throw advisorReferenceError("sales_owner_not_visible");
  }
}

function assertSubjectEvidence(
  subject: {
    candidateId?: string | null;
    customerId?: string | null;
    dealId?: string | null;
  },
  subjects: AdvisorVisibilitySnapshot["subjectVisibility"]
): void {
  const nonNull = [subject.candidateId, subject.customerId, subject.dealId]
    .filter((value): value is string => typeof value === "string" && value !== "");
  if (nonNull.length === 0) throw advisorReferenceError();
  for (const value of nonNull) {
    if (![...subjects.candidateIds, ...subjects.customerIds,
      ...subjects.dealIds].includes(value)) {
      throw advisorReferenceError();
    }
  }
}

function assertBindingEvidence(
  binding: {
    candidateId: string;
    customerId: string;
    dealId: string;
  },
  subjects: AdvisorVisibilitySnapshot["subjectVisibility"]
): void {
  requireSet(binding.candidateId, subjects.candidateIds, "candidate");
  requireSet(binding.customerId, subjects.customerIds, "customer");
  requireSet(binding.dealId, subjects.dealIds, "deal");
}

function assertGapBindings(
  gap: {
    candidateId: string | null;
    customerId: string | null;
    dealId: string | null;
    cohortId: string | null;
  },
  subjects: AdvisorVisibilitySnapshot["subjectVisibility"]
): void {
  const bindings: Array<[string | null, readonly string[]]> = [
    [gap.candidateId, subjects.candidateIds],
    [gap.customerId, subjects.customerIds],
    [gap.dealId, subjects.dealIds],
    [gap.cohortId, subjects.cohortIds]
  ];
  const nonNull = bindings.filter(([value]) => value !== null);
  if (nonNull.length === 0) throw advisorReferenceError();
  for (const [value, allowed] of nonNull) {
    if (!inSet(value, allowed)) throw advisorReferenceError();
  }
}

function assertLedgerBindings(
  row: {
    candidateId?: string | null;
    customerId?: string | null;
    dealId?: string | null;
    cohortId?: string | null;
  },
  subjects: AdvisorVisibilitySnapshot["subjectVisibility"]
): void {
  const bindings: Array<[string | null, readonly string[]]> = [
    [row.candidateId ?? null, subjects.candidateIds],
    [row.customerId ?? null, subjects.customerIds],
    [row.dealId ?? null, subjects.dealIds],
    [row.cohortId ?? null, subjects.cohortIds]
  ];
  const nonNull = bindings.filter(([value]) => value !== null);
  if (nonNull.length === 0) throw advisorReferenceError();
  for (const [value, allowed] of nonNull) {
    if (!inSet(value, allowed)) throw advisorReferenceError();
  }
}

export function verifyAdvisorActionBinding(
  verified: VerifiedAdvisorReferenceSnapshot,
  action: AdvisorRecommendedAction
): void {
  const metricRefs = verified.refs.metricRefs;
  const evidenceRefs = verified.refs.evidenceRefs;
  const entityRefs = verified.refs.entityRefs;
  const has = <T>(
    rows: readonly T[],
    predicate: (row: T) => boolean
  ): boolean => rows.some(predicate);
  let bound = false;
  switch (action.kind) {
    case "open_candidate":
      bound = has([...metricRefs, ...evidenceRefs], (ref) =>
        (ref.kind === "priority_score"
          || ref.kind === "candidate_evidence")
        && ref.candidateId === action.candidateId);
      break;
    case "create_quote_draft":
      bound = has(metricRefs, (ref) =>
        ref.kind === "quote_preview"
        && ref.quoteCaseId === action.quoteCaseId);
      break;
    case "create_quote_approval_task":
      bound = has([...evidenceRefs, ...entityRefs], (ref) =>
        ref.kind === "quote_version"
        && ("quoteVersionId" in ref
          ? ref.quoteVersionId === action.quoteVersionId
          : ref.id === action.quoteVersionId)
        && ref.lifecycleRevision === action.quoteVersionRevision);
      break;
    case "create_sales_todo":
      bound = has(entityRefs, (ref) =>
        ref.kind === "customer" && ref.id === action.customerId);
      break;
    case "complete_cost_data":
      bound = has(metricRefs, (ref) =>
        (ref.kind === "growth_performance"
          && ref.cohortId === action.cohortId)
        || (ref.kind === "financial_data_gap"
          && ref.cohortId === action.cohortId));
      break;
    case "complete_financial_fact":
      bound = has(entityRefs, (ref) =>
        ref.kind === "deal" && ref.id === action.dealId);
      if (!bound) {
        bound = has(metricRefs, (ref) =>
          ref.kind === "financial_data_gap"
          && ref.sourceId === action.dealId);
      }
      break;
    default:
      throw advisorReferenceError();
  }
  if (!bound) {
    throw Object.assign(
      new Error("advisor_action_reference_mismatch"),
      { code: "advisor_action_reference_mismatch" }
    );
  }
}

export interface AdvisorRecommendationServiceOptions {
  readonly repository: AdvisorRecommendationRepository;
  readonly visibility: AdvisorVisibilityResolver;
  readonly verifier: AdvisorReferenceVerifier;
  readonly temporalBarrier: GrowthTemporalBarrier;
  readonly assignability: GrowthWorkspaceMemberAssignabilityReader;
  readonly actionOperations: {
    findByStableHash(
      context: ActiveWorkspaceContext,
      stableActionHash: `sha256:${string}`
    ): Promise<{ status: string; id: string; stableActionHash: `sha256:${string}` } | null>;
    listReceiptsFor(
      workspaceId: string,
      recommendationId: string
    ): Promise<readonly {
      id: string;
      recommendationId: string;
      recommendationRevision: number;
      stableActionHash: `sha256:${string}`;
      operationId: string;
    }[]>;
  };
  readonly now?: () => string;
}

export interface AdvisorRecommendationCreateInput {
  audienceRole: AdvisorRecommendation["audienceRole"];
  type: AdvisorRecommendation["type"];
  summary: string;
  rationale: string;
  metricRefs: readonly AdvisorMetricRef[];
  evidenceRefs: readonly AdvisorEvidenceRef[];
  entityRefs: readonly AdvisorEntityRef[];
  confidenceBps: number;
  riskLevel: AdvisorRecommendation["riskLevel"];
  recommendedAction: AdvisorRecommendedAction;
  assignedTo: string | null;
  dataAsOf: string;
  modelSnapshotRef: string;
  promptVersion: string;
  generationIdempotencyKey: string;
}

/** Internal-only hand-off shape. It is deliberately not used by HTTP or model
 * tool adapters; the opaque approval proof is checked before any create path. */
export interface AdvisorCouncilAcceptedCreateInput {
  readonly councilActionId: string;
  readonly recommendation: AdvisorRecommendationCreateInput;
}

/** The dispatch identity is persisted by Task 4 and is the only idempotency
 * boundary accepted by this internal council hand-off. */
export interface AdvisorCouncilApprovedDispatchInput
extends AdvisorCouncilAcceptedCreateInput {
  readonly dispatchHash: `sha256:${string}`;
}

/** Redacted result consumed by the council dispatch receipt. */
export interface AdvisorCouncilDispatchResult {
  readonly resourceRefs: readonly [{
    readonly kind: "advisor_recommendation";
    readonly id: string;
  }];
  readonly contentHash: `sha256:${string}`;
}

export class AdvisorRecommendationAuthorizer {
  constructor(
    private readonly assignability: GrowthWorkspaceMemberAssignabilityReader
  ) {}

  async assertCanCreate(
    context: ActiveWorkspaceContext,
    assignedTo: string | null
  ): Promise<string | null> {
    if (assignedTo === null) return null;
    try {
      const member = await this.assignability.assertAssignable(
        context, assignedTo
      );
      return member.actorId;
    } catch {
      throw advisorRecommendationForbidden();
    }
  }

  async assertCanTransition(
    context: ActiveWorkspaceContext,
    recommendation: AdvisorRecommendation
  ): Promise<void> {
    if (recommendation.workspaceId !== context.workspaceId) {
      throw advisorRecommendationForbidden();
    }
    if (context.role === "sales") {
      if (recommendation.assignedTo !== context.actorId) {
        throw advisorRecommendationForbidden();
      }
      return;
    }
    if (context.role === "manager") {
      if (recommendation.audienceRole === "sales"
        || context.teamId !== recommendation.workspaceId) {
        throw advisorRecommendationForbidden();
      }
      return;
    }
    if (context.role === "admin" || context.role === "super_admin") {
      if (recommendation.workspaceId !== context.workspaceId) {
        throw advisorRecommendationForbidden();
      }
      return;
    }
    throw advisorRecommendationForbidden();
  }
}

function advisorRecommendationForbidden(): Error & { code: string } {
  return Object.assign(
    new Error("advisor_recommendation_forbidden"),
    { code: "advisor_recommendation_forbidden" }
  );
}

function isCanonicalHash(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function advisorCouncilDispatchResult(
  recommendation: AdvisorRecommendation
): AdvisorCouncilDispatchResult {
  return Object.freeze({
    resourceRefs: Object.freeze([Object.freeze({
      kind: "advisor_recommendation" as const, id: recommendation.id
    })] as const),
    contentHash: advisorSnapshotHash(recommendation)
  });
}

export class AdvisorRecommendationService {
  private readonly repository: AdvisorRecommendationRepository;
  private readonly visibility: AdvisorVisibilityResolver;
  private readonly verifier: AdvisorReferenceVerifier;
  private readonly temporalBarrier: GrowthTemporalBarrier;
  private readonly authorizer: AdvisorRecommendationAuthorizer;
  private readonly actionOperations:
    AdvisorRecommendationServiceOptions["actionOperations"];
  private readonly now: () => string;

  constructor(options: AdvisorRecommendationServiceOptions) {
    this.repository = options.repository;
    this.visibility = options.visibility;
    this.verifier = options.verifier;
    this.temporalBarrier = assertGrowthTemporalBarrier(
      options.temporalBarrier
    );
    this.authorizer = new AdvisorRecommendationAuthorizer(
      options.assignability
    );
    this.actionOperations = options.actionOperations;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async create(
    command: CommandContext,
    input: AdvisorRecommendationCreateInput
  ): Promise<AdvisorRecommendation> {
    const context = command.workspace;
    const readStartedAt = this.now();
    const effectiveAsOf = assertGrowthAsOfNotFuture(
      input.dataAsOf, readStartedAt, 1_000
    );
    const cutoff = await this.temporalBarrier.sealReadCutoff(
      context, effectiveAsOf
    );
    const visibility = await this.visibility.resolveAt(context, cutoff);
    const verified = await this.verifier.verify(
      context,
      {
        metricRefs: input.metricRefs,
        evidenceRefs: input.evidenceRefs,
        entityRefs: input.entityRefs
      },
      cutoff,
      visibility
    );
    verifyAdvisorActionBinding(verified, input.recommendedAction);
    const assignedTo = await this.authorizer.assertCanCreate(
      context, input.assignedTo
    );
    const expiresAt = new Date(
      Date.parse(cutoff.effectiveAsOf) + 24 * 60 * 60 * 1_000
    ).toISOString();
    const inputSnapshotHash = `sha256:${createHash("sha256")
      .update(canonicalJsonStringify({
        refs: verified.refs,
        visibilitySourceHash: verified.visibilitySourceHash,
        dataAsOf: verified.dataAsOf,
        recommendedAction: input.recommendedAction,
        modelSnapshotRef: input.modelSnapshotRef,
        promptVersion: input.promptVersion
      }) ?? "")
      .digest("hex")}` as `sha256:${string}`;
    const aggregate: AdvisorRecommendation = {
      id: `recommendation-${command.idempotencyKey}`,
      workspaceId: context.workspaceId,
      revision: 1,
      audienceRole: input.audienceRole,
      type: input.type,
      summary: input.summary,
      rationale: input.rationale,
      metricRefs: Object.freeze([...input.metricRefs]),
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      entityRefs: Object.freeze([...input.entityRefs]),
      confidenceBps: input.confidenceBps,
      riskLevel: input.riskLevel,
      recommendedAction: Object.freeze({ ...input.recommendedAction }),
      status: "proposed",
      assignedTo,
      acceptedBy: null,
      acceptedAt: null,
      outcomeRefs: Object.freeze([]),
      dataAsOf: cutoff.effectiveAsOf,
      inputSnapshotHash,
      modelSnapshotRef: input.modelSnapshotRef,
      promptVersion: input.promptVersion,
      schemaVersion: "advisor-recommendation.v1",
      generationIdempotencyKey: input.generationIdempotencyKey,
      expiresAt,
      createdAt: cutoff.effectiveAsOf,
      updatedAt: cutoff.effectiveAsOf
    };
    const result = await this.repository.create(command, aggregate);
    return result.value;
  }

  async createAcceptedFromCouncil(
    command: CommandContext,
    input: AdvisorCouncilAcceptedCreateInput,
    rawApprovalProof: unknown,
    proofs: Pick<FinancialCouncilApprovalProofIssuer, "verify">
  ): Promise<AdvisorRecommendation> {
    const proof = proofs.verify(rawApprovalProof);
    return this.createAcceptedFromVerifiedCouncilProof(
      command, input, proof, `council:${proof.approvalId}:${proof.actionId}`
    );
  }

  async probeByDispatchHash(
    context: ActiveWorkspaceContext,
    dispatchHash: `sha256:${string}`
  ): Promise<AdvisorCouncilDispatchResult | null> {
    if (!isCanonicalHash(dispatchHash)) throw advisorRecommendationForbidden();
    const recommendation = await this.repository.findById(
      context, `recommendation-council:${dispatchHash}`
    );
    return recommendation ? advisorCouncilDispatchResult(recommendation) : null;
  }

  async createFromApprovedDispatch(
    command: CommandContext,
    input: AdvisorCouncilApprovedDispatchInput,
    rawApprovalProof: unknown,
    proofs: Pick<FinancialCouncilApprovalProofIssuer, "verify">
  ): Promise<AdvisorCouncilDispatchResult> {
    const proof = proofs.verify(rawApprovalProof);
    if (!input || typeof input !== "object" || !isCanonicalHash(input.dispatchHash)) {
      throw advisorRecommendationForbidden();
    }
    const recommendation = await this.createAcceptedFromVerifiedCouncilProof(
      command, input, proof, `council:${input.dispatchHash}`
    );
    return advisorCouncilDispatchResult(recommendation);
  }

  private async createAcceptedFromVerifiedCouncilProof(
    command: CommandContext,
    input: AdvisorCouncilAcceptedCreateInput,
    proof: FinancialCouncilApprovalProof,
    councilKey: string
  ): Promise<AdvisorRecommendation> {
    if (!input || typeof input !== "object"
      || !/^sha256:[0-9a-f]{64}$/u.test(input.councilActionId)
      || proof.workspaceId !== command.workspace.workspaceId
      || proof.actionId !== input.councilActionId) {
      throw advisorRecommendationForbidden();
    }
    const created = await this.create(Object.freeze({
      ...command,
      idempotencyKey: councilKey,
      requestHash: `sha256:${proof.approvalHash.slice(7)}`,
      expectedRevision: null
    }), {
      ...input.recommendation,
      generationIdempotencyKey: councilKey
    });
    if (created.status === "accepted") return created;
    if (created.status !== "proposed") throw advisorRecommendationForbidden();
    await this.authorizer.assertCanTransition(command.workspace, created);
    const accepted = await this.repository.transition(Object.freeze({
      ...command,
      actorId: proof.approverId,
      idempotencyKey: councilKey,
      requestHash: `sha256:${proof.approvalHash.slice(7)}`,
      expectedRevision: created.revision
    }), {
      recommendationId: created.id,
      kind: "accept",
      reason: null
    });
    return accepted.value;
  }

  async accept(
    command: CommandContext,
    recommendationId: string
  ): Promise<AdvisorRecommendation> {
    return this.transition(command, recommendationId, {
      recommendationId,
      kind: "accept",
      reason: null
    });
  }

  async ignore(
    command: CommandContext,
    recommendationId: string
  ): Promise<AdvisorRecommendation> {
    return this.transition(command, recommendationId, {
      recommendationId,
      kind: "ignore",
      reason: null
    });
  }

  async getProjection(
    context: ActiveWorkspaceContext,
    recommendationId: string
  ): Promise<AdvisorRecommendation> {
    const current = await this.repository.findById(
      context, recommendationId
    );
    if (!current) {
      throw Object.assign(
        new Error("advisor_recommendation_not_found"),
        { code: "advisor_recommendation_not_found" }
      );
    }
    await this.authorizer.assertCanTransition(context, current);
    return current;
  }

  async complete(
    command: CommandContext,
    recommendationId: string
  ): Promise<AdvisorRecommendation> {
    if (arguments.length > 2) {
      throw Object.assign(
        new Error("schema_validation_failed"),
        { code: "schema_validation_failed" }
      );
    }
    const current = await this.repository.findById(
      command.workspace, recommendationId
    );
    if (!current || current.status !== "accepted") {
      throw advisorRecommendationForbidden();
    }
    await this.authorizer.assertCanTransition(
      command.workspace, current
    );
    const receipts = await this.actionOperations.listReceiptsFor(
      command.workspace.workspaceId, recommendationId
    );
    const stableHash = stableAdvisorActionHash({
      workspaceId: current.workspaceId,
      recommendationId: current.id,
      recommendationRevision: current.revision,
      recommendedAction: current.recommendedAction,
      bindingSnapshotHash: current.inputSnapshotHash
    });
    const receipt = receipts.find((row) =>
      row.recommendationId === recommendationId
      && row.recommendationRevision === current.revision
      && row.stableActionHash === stableHash);
    if (!receipt) throw advisorRecommendationForbidden();
    const result = await this.repository.transition(command, {
      recommendationId,
      kind: "complete",
      reason: null,
      outcomeRefs: Object.freeze([
        { kind: "action_receipt" as const, id: receipt.id }
      ])
    });
    return result.value;
  }

  private async transition(
    command: CommandContext,
    recommendationId: string,
    input: AdvisorTransitionInput
  ): Promise<AdvisorRecommendation> {
    const current = await this.repository.findById(
      command.workspace, recommendationId
    );
    if (!current) throw advisorRecommendationForbidden();
    await this.authorizer.assertCanTransition(
      command.workspace, current
    );
    const result = await this.repository.transition(command, input);
    return result.value;
  }
}
