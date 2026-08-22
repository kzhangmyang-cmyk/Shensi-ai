import { createHash } from "node:crypto";
import {
  assertGrowthAsOfNotFuture
} from "./growth-as-of.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthWorkspaceSettingsReader } from "./growth-workspace-settings.js";
import type {
  FinancialDataGap,
  FinancialDataGapSealedReader,
  FinancialDataGapVisibilityKeys
} from "./financial-data-gap-reader.js";
import type {
  ExpectedRoiCurrencyView,
  ActualRoiCurrencyView,
  GrowthPerformanceDto
} from "./acquisition-growth-performance-query.js";
import type {
  PendingQuoteApprovalSnapshot,
  QuoteApprovalAsOfReader,
  QuoteVersionEvidenceReader,
  QuoteVersionEvidenceSnapshot
} from "./authoritative-quote-reader.js";
import type {
  AdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import type {
  AdvisorRecommendation
} from "./advisor-recommendation-domain.js";
import type {
  AdvisorCandidateAuthorityEvent,
  AdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import {
  canonicalJsonStringify
} from "./canonical-json.js";
import type {
  FinancialDataGapCode,
  FinancialDataGapSourceType
} from "./growth-contract-types.js";

export function advisorAudienceRoleFor(
  role: ActiveWorkspaceContext["role"]
): AdvisorRecommendation["audienceRole"] {
  if (role === "sales") return "sales";
  if (role === "manager") return "manager";
  if (role === "admin") return "admin";
  return "super_admin";
}

export interface AdvisorTodayQuery {
  currency: string;
  asOf: string;
}

export interface PriorityCustomerView {
  candidateId: string;
  customerId: string | null;
  dealId: string | null;
  displayName: string;
  priorityScoreBps: number;
  qualificationDecisionId: string;
  qualificationDecisionVersion: string;
  inputSnapshotHash: `sha256:${string}`;
}

export interface PendingQuoteApprovalView {
  approvalId: string;
  quoteVersionId: string;
  quoteVersionRevision: number;
  quoteCaseId: string;
  approvalKind: "confirmation" | "exception";
  requiredCapabilities: readonly string[];
  submittedAt: string;
  expiresAt: string | null;
  currency?: string;
  quotedAmountMinor?: number;
  estimatedGrossProfitMinor?: number;
  estimatedContributionMinor?: number;
  grossMarginBps?: number;
}

export interface FinancialDataGapView {
  code: FinancialDataGapCode;
  sourceType: FinancialDataGapSourceType;
  sourceId: string;
  sourceSnapshotHash: `sha256:${string}`;
  cohortId: string | null;
  currency: string;
  asOf: string;
}

export type AdvisorRoiSliceView =
  & { cohortId: string; planId: string | null }
  & (ExpectedRoiCurrencyView | ActualRoiCurrencyView);

export interface GrowthAdvisorTodayView {
  workspaceId: string;
  audienceRole: AdvisorRecommendation["audienceRole"];
  dataAsOf: string;
  priorityCustomers: readonly PriorityCustomerView[];
  pendingQuoteApprovals: readonly PendingQuoteApprovalView[];
  expectedRoi: readonly AdvisorRoiSliceView[];
  actualRoi: readonly AdvisorRoiSliceView[];
  dataGaps: readonly FinancialDataGapView[];
  recommendations: readonly AdvisorRecommendation[];
  sourceSnapshotHash: `sha256:${string}`;
}

export interface GrowthAdvisorAuthorityTodayView
extends Omit<GrowthAdvisorTodayView, "pendingQuoteApprovals"> {
  pendingQuoteApprovals: readonly (
    PendingQuoteApprovalView & { readonly currency: string }
  )[];
}

export interface GrowthAdvisorQueryService {
  getToday(
    context: ActiveWorkspaceContext,
    query: AdvisorTodayQuery
  ): Promise<GrowthAdvisorTodayView>;
}

export interface GrowthAdvisorSealedQueryService
extends GrowthAdvisorQueryService {
  sealTodayCutoff(
    context: ActiveWorkspaceContext,
    effectiveAsOf: string
  ): Promise<GrowthSealedReadCutoff>;
  getTodayAt(
    context: ActiveWorkspaceContext,
    query: { currency: string; cutoff: GrowthSealedReadCutoff }
  ): Promise<GrowthAdvisorAuthorityTodayView>;
}

function assertGrowthAdvisorReadCutoff(
  issuedCutoffs: WeakSet<object>,
  context: ActiveWorkspaceContext,
  cutoff: GrowthSealedReadCutoff
): GrowthSealedReadCutoff {
  try {
    const trusted = assertGrowthSealedReadCutoff(cutoff, context.workspaceId);
    if (!issuedCutoffs.has(trusted)) {
      throw new Error("invalid_growth_advisor_sealed_read_cutoff");
    }
    return trusted;
  } catch (error) {
    if ((error as Error).message === "invalid_growth_advisor_sealed_read_cutoff") {
      throw error;
    }
    throw new Error("invalid_growth_advisor_sealed_read_cutoff");
  }
}

export interface AdvisorPerformancePortfolioReader {
  listVisible(context: ActiveWorkspaceContext, query: {
    currency: string;
    cutoff: GrowthSealedReadCutoff;
    limit: number;
  }): Promise<readonly {
    cohortId: string;
    planId: string | null;
    performance: GrowthPerformanceDto;
  }[]>;
}

export type AdvisorVisibilityScope =
  | { kind: "sales_own"; actorId: string }
  | { kind: "team"; teamId: string }
  | { kind: "workspace"; workspaceId: string };

export interface AdvisorSubjectVisibilityKeys {
  readonly candidateIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly dealIds: readonly string[];
  readonly cohortIds: readonly string[];
}

export interface AdvisorVisibilitySnapshot {
  readonly scope: AdvisorVisibilityScope;
  readonly subjectVisibility: AdvisorSubjectVisibilityKeys;
  readonly financialGapVisibility: FinancialDataGapVisibilityKeys;
  readonly sourceSnapshotHash: `sha256:${string}`;
}

const issuedVisibilitySnapshots = new WeakSet<object>();

export function markAdvisorVisibilitySnapshot(
  snapshot: AdvisorVisibilitySnapshot
): AdvisorVisibilitySnapshot {
  issuedVisibilitySnapshots.add(snapshot);
  return snapshot;
}

export function assertAdvisorVisibilitySnapshot(
  snapshot: AdvisorVisibilitySnapshot
): AdvisorVisibilitySnapshot {
  if (!snapshot || !issuedVisibilitySnapshots.has(snapshot)) {
    throw new Error("advisor_visibility_snapshot_invalid");
  }
  return snapshot;
}

export interface AdvisorVisibilityResolver {
  resolveAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AdvisorVisibilitySnapshot>;
}

export interface QuoteBindingVisibilityRow {
  readonly quoteVersionId: string;
  readonly candidateId: string;
  readonly customerId: string;
  readonly dealId: string;
  readonly salesOwnerActorId: string;
  readonly teamId: string;
}

export interface QuoteBindingVisibilitySource {
  listVisibleBindings(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<readonly QuoteBindingVisibilityRow[]>;
}

export interface CohortBindingVisibilityRow {
  readonly cohortId: string;
  readonly candidateIds: readonly string[];
  readonly dealIds: readonly string[];
  readonly customerIds: readonly string[];
  readonly teamId: string;
}

export interface CohortBindingVisibilitySource {
  listVisibleCohorts(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff,
    candidateIds: readonly string[]
  ): Promise<readonly CohortBindingVisibilityRow[]>;
}

function boundedSortedUnique(values: Iterable<string>): readonly string[] {
  const unique = [...new Set(values)].filter((value) =>
    typeof value === "string" && value.trim() !== "").sort();
  return Object.freeze(unique.slice(0, 100));
}

function visibilityHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

export interface AdvisorVisibilityResolverDependencies {
  candidateAuthority: Pick<
    AdvisorCandidateAuthorityRepository,
    "listAt" | "getAt"
  >;
  quoteBindings: QuoteBindingVisibilitySource;
  cohortBindings: CohortBindingVisibilitySource;
}

/** The visibility resolver derives bounded, sorted, deduplicated candidate,
 *  customer, Deal and cohort IDs only from sealed candidate authority plus
 *  Quote/ROI binding authorities visible to the current association. No model,
 *  ref or request-body ID can enter the sets. */
export class DefaultAdvisorVisibilityResolver
implements AdvisorVisibilityResolver {
  constructor(
    private readonly dependencies: AdvisorVisibilityResolverDependencies
  ) {}

  async resolveAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AdvisorVisibilitySnapshot> {
    if (cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const authority = await this.dependencies.candidateAuthority.listAt(
      context.workspaceId, cutoff
    );
    const scope: AdvisorVisibilityScope = context.role === "sales"
      ? { kind: "sales_own", actorId: context.actorId }
      : context.role === "manager"
        ? { kind: "team", teamId: context.teamId }
        : { kind: "workspace", workspaceId: context.workspaceId };
    const visibleAuthority = authority.filter((event) => {
      if (scope.kind === "sales_own") return event.ownerId === scope.actorId;
      if (scope.kind === "team") return event.teamId === scope.teamId;
      return event.workspaceId === scope.workspaceId;
    });
    const candidateIds = boundedSortedUnique(
      visibleAuthority.map((event) => event.candidateId)
    );
    const bindings = await this.dependencies.quoteBindings.listVisibleBindings(
      context, cutoff
    );
    const visibleBindings = bindings.filter((binding) => {
      if (scope.kind === "sales_own") {
        return binding.salesOwnerActorId === scope.actorId;
      }
      if (scope.kind === "team") return binding.teamId === scope.teamId;
      return binding.teamId === scope.workspaceId;
    });
    const customerIds = boundedSortedUnique(
      visibleBindings.map((binding) => binding.customerId)
    );
    const dealIds = boundedSortedUnique(
      visibleBindings.map((binding) => binding.dealId)
    );
    const cohorts = await this.dependencies.cohortBindings.listVisibleCohorts(
      context, cutoff, candidateIds
    );
    const cohortIds = boundedSortedUnique(
      cohorts.map((cohort) => cohort.cohortId)
    );
    const subjectVisibility: AdvisorSubjectVisibilityKeys = Object.freeze({
      candidateIds,
      customerIds,
      dealIds,
      cohortIds
    });
    const financialGapVisibility: FinancialDataGapVisibilityKeys =
      Object.freeze({
        candidateIds,
        customerIds,
        dealIds,
        cohortIds
      });
    const sourceSnapshotHash = visibilityHash({
      scope,
      authority: visibleAuthority.map((event) => [
        event.candidateId,
        event.qualificationDecisionId,
        event.qualificationDecisionVersion,
        event.qualificationSnapshotHash,
        event.financialValueDecisionId,
        event.financialValueDecisionVersion,
        event.financialValueInputSnapshotHash
      ]),
      bindings: visibleBindings.map((binding) => [
        binding.quoteVersionId,
        binding.candidateId,
        binding.customerId,
        binding.dealId
      ]),
      cohorts: cohorts.map((cohort) => cohort.cohortId)
    });
    return markAdvisorVisibilitySnapshot(Object.freeze({
      scope,
      subjectVisibility,
      financialGapVisibility,
      sourceSnapshotHash
    }));
  }
}

export interface PriorityCandidateReader {
  listAsOf(
    context: ActiveWorkspaceContext,
    input: {
      cutoff: GrowthSealedReadCutoff;
      timeZone: string;
      limit: number;
    }
  ): Promise<readonly PriorityCustomerView[]>;
}

export interface AdvisorCandidateEvidenceAsOfSnapshot {
  readonly candidateId: string;
  readonly qualificationDecisionId: string;
  readonly qualificationDecisionVersion: string;
  readonly qualificationSnapshotHash: `sha256:${string}`;
  readonly financialValueInputSnapshotHash: `sha256:${string}`;
  readonly grade: string;
  readonly score: number;
  readonly evidence: readonly {
    evidenceId: string;
    contentHash: string;
    fetchedAt: string;
  }[];
}

export interface AdvisorCandidateEvidenceAsOfReader {
  getAt(
    context: ActiveWorkspaceContext,
    input: { candidateId: string; cutoff: GrowthSealedReadCutoff }
  ): Promise<AdvisorCandidateEvidenceAsOfSnapshot | null>;
}

export interface CandidateDisplayNameSource {
  listDisplayNames(
    workspaceId: string,
    candidateIds: readonly string[]
  ): Promise<ReadonlyMap<string, string>>;
}

export interface PriorityCandidateReaderDependencies {
  candidateAuthority: Pick<
    AdvisorCandidateAuthorityRepository,
    "listAt" | "getAt"
  >;
  quoteBindings: QuoteBindingVisibilitySource;
  displayNames: CandidateDisplayNameSource;
}

/** Priority candidates and evidence read only append-only authority events at
 *  the sealed cutoff; they never infer historical authority from a mutable
 *  Candidate head or a bounded Top-N scan. */
export class DefaultPriorityCandidateReader
implements PriorityCandidateReader, AdvisorCandidateEvidenceAsOfReader {
  constructor(
    private readonly dependencies: PriorityCandidateReaderDependencies
  ) {}

  async listAsOf(
    context: ActiveWorkspaceContext,
    input: {
      cutoff: GrowthSealedReadCutoff;
      timeZone: string;
      limit: number;
    }
  ): Promise<readonly PriorityCustomerView[]> {
    if (input.cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const limit = Math.min(100, Math.max(1, input.limit));
    const authority = await this.dependencies.candidateAuthority.listAt(
      context.workspaceId, input.cutoff
    );
    const visible = authority.filter((event) => {
      if (context.role === "sales") return event.ownerId === context.actorId;
      if (context.role === "manager") return event.teamId === context.teamId;
      return event.workspaceId === context.workspaceId;
    });
    const bindings = await this.dependencies.quoteBindings.listVisibleBindings(
      context, input.cutoff
    );
    const bindingByCandidate = new Map<string, QuoteBindingVisibilityRow>();
    for (const binding of bindings) {
      const visibleBinding = context.role === "sales"
        ? binding.salesOwnerActorId === context.actorId
        : context.role === "manager"
          ? binding.teamId === context.teamId
          : binding.teamId === context.workspaceId;
      if (visibleBinding && !bindingByCandidate.has(binding.candidateId)) {
        bindingByCandidate.set(binding.candidateId, binding);
      }
    }
    const names = await this.dependencies.displayNames.listDisplayNames(
      context.workspaceId, visible.map((event) => event.candidateId)
    );
    const rows = visible
      .sort((left, right) =>
        right.score - left.score
        || left.candidateId.localeCompare(right.candidateId))
      .slice(0, limit)
      .map((event) => {
        const binding = bindingByCandidate.get(event.candidateId);
        return Object.freeze({
          candidateId: event.candidateId,
          customerId: binding?.customerId ?? null,
          dealId: binding?.dealId ?? null,
          displayName: names.get(event.candidateId)
            ?? event.candidateId,
          priorityScoreBps: Math.max(0, Math.min(10_000, event.score * 100)),
          qualificationDecisionId: event.qualificationDecisionId,
          qualificationDecisionVersion: event.qualificationDecisionVersion,
          inputSnapshotHash: event.qualificationSnapshotHash as
            `sha256:${string}`
        });
      });
    return Object.freeze(rows);
  }

  async getAt(
    context: ActiveWorkspaceContext,
    input: { candidateId: string; cutoff: GrowthSealedReadCutoff }
  ): Promise<AdvisorCandidateEvidenceAsOfSnapshot | null> {
    const event = await this.dependencies.candidateAuthority.getAt(
      context.workspaceId, input.candidateId, input.cutoff
    );
    if (!event) return null;
    const visible = context.role === "sales"
      ? event.ownerId === context.actorId
      : context.role === "manager"
        ? event.teamId === context.teamId
        : event.workspaceId === context.workspaceId;
    if (!visible) return null;
    return Object.freeze({
      candidateId: event.candidateId,
      qualificationDecisionId: event.qualificationDecisionId,
      qualificationDecisionVersion: event.qualificationDecisionVersion,
      qualificationSnapshotHash: event.qualificationSnapshotHash as
        `sha256:${string}`,
      financialValueInputSnapshotHash:
        event.financialValueInputSnapshotHash as `sha256:${string}`,
      grade: event.grade,
      score: event.score,
      evidence: Object.freeze(event.evidence.map((item) =>
        Object.freeze({ ...item })))
    });
  }
}

export interface GrowthAdvisorQueryServiceDependencies {
  temporalBarrier: GrowthTemporalBarrier;
  workspaceSettings: GrowthWorkspaceSettingsReader;
  visibility: AdvisorVisibilityResolver;
  priorityCandidates: PriorityCandidateReader;
  quoteApprovals: Pick<QuoteApprovalAsOfReader, "listPendingAsOf">;
  quoteVersions: Pick<QuoteVersionEvidenceReader, "getAt">;
  performancePortfolio: AdvisorPerformancePortfolioReader;
  financialGaps: Pick<FinancialDataGapSealedReader, "listForBindingsAt">;
  recommendations: Pick<AdvisorRecommendationRepository, "listAt">;
  now?: () => string;
}

function snapshotHashForView(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

const LEGACY_TODAY_LIMITS = Object.freeze({
  priorityCustomers: 10,
  pendingQuoteApprovals: 50
});

const AUTHORITY_COMPLETENESS_PROBE_LIMITS = Object.freeze({
  priorityCustomers: 100,
  pendingQuoteApprovals: 100
});

export function createGrowthAdvisorQueryService(
  dependencies: GrowthAdvisorQueryServiceDependencies
): GrowthAdvisorSealedQueryService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const issuedCutoffs = new WeakSet<object>();
  const sealTodayCutoff = async (
    context: ActiveWorkspaceContext,
    effectiveAsOf: string
  ): Promise<GrowthSealedReadCutoff> => {
    const cutoff = await dependencies.temporalBarrier.sealReadCutoff(
      context, effectiveAsOf
    );
    issuedCutoffs.add(cutoff);
    return cutoff;
  };
  const loadTodayAt = async (
    context: ActiveWorkspaceContext,
    query: { currency: string; cutoff: GrowthSealedReadCutoff },
    limits: {
      readonly priorityCustomers: number;
      readonly pendingQuoteApprovals: number;
    }
  ): Promise<GrowthAdvisorAuthorityTodayView> => {
    const cutoff = assertGrowthAdvisorReadCutoff(
      issuedCutoffs, context, query.cutoff
    );
    const dataAsOf = cutoff.effectiveAsOf;
    const settings = await dependencies.workspaceSettings.getAt(
      context, cutoff
    );
    const audienceRole = advisorAudienceRoleFor(context.role);
    const visibility = await dependencies.visibility.resolveAt(
      context, cutoff
    );
    const priorityCustomers =
      await dependencies.priorityCandidates.listAsOf(context, {
        cutoff,
        timeZone: settings.timeZone,
        limit: limits.priorityCustomers
      });
    const approvals = await dependencies.quoteApprovals.listPendingAsOf(
      context, {
        cutoff,
        limit: limits.pendingQuoteApprovals,
        currency: query.currency
      }
    );
    const pendingQuoteApprovals: GrowthAdvisorAuthorityTodayView[
      "pendingQuoteApprovals"
    ][number][] = [];
    const projectedGaps: FinancialDataGapView[] = [];
    const sensitive = context.capabilities.includes("pricing.sensitive.read");
    for (const approval of approvals) {
      const quoteVersion = await dependencies.quoteVersions.getAt(
        context, approval.quoteVersionId, cutoff
      );
      if (!quoteVersion) {
        projectedGaps.push(Object.freeze({
          code: "missing_commercial_binding" as const,
          sourceType: "commercial_binding" as const,
          sourceId: approval.quoteVersionId,
          sourceSnapshotHash: approval.commercialAmountHash,
          cohortId: null,
          currency: approval.currency,
          asOf: dataAsOf
        }));
        continue;
      }
      pendingQuoteApprovals.push(Object.freeze({
        approvalId: approval.approvalId,
        quoteVersionId: approval.quoteVersionId,
        quoteVersionRevision: quoteVersion.lifecycleRevision,
        quoteCaseId: approval.quoteCaseId,
        approvalKind: approval.approvalKind,
        requiredCapabilities: Object.freeze([
          ...approval.requiredCapabilities
        ]),
        submittedAt: approval.submittedAt,
        expiresAt: approval.expiresAt,
        currency: approval.currency,
        ...(sensitive ? {
          quotedAmountMinor: approval.quotedAmountMinor,
          estimatedGrossProfitMinor: approval.estimatedGrossProfitMinor,
          estimatedContributionMinor: approval.estimatedContributionMinor,
          grossMarginBps: approval.grossMarginBps
        } : {})
      }));
    }
    const portfolio = await dependencies.performancePortfolio.listVisible(
      context, { currency: query.currency, cutoff, limit: 100 }
    );
    const expectedRoi: AdvisorRoiSliceView[] = [];
    const actualRoi: AdvisorRoiSliceView[] = [];
    for (const slice of portfolio) {
      for (const view of slice.performance.expectedRoiByCurrency) {
        expectedRoi.push(Object.freeze({
          cohortId: slice.cohortId,
          planId: slice.planId,
          ...view
        }));
      }
      if (context.role === "sales") continue;
      for (const view of slice.performance.actualRoiByCurrency) {
        actualRoi.push(Object.freeze({
          cohortId: slice.cohortId,
          planId: slice.planId,
          ...view
        }));
      }
    }
    const financeRows = await dependencies.financialGaps.listForBindingsAt(
      context, {
        visibility: visibility.financialGapVisibility,
        currency: query.currency,
        cutoff,
        limit: 100
      }
    );
    const gapViews: FinancialDataGapView[] = [
      ...projectedGaps,
      ...financeRows.map((gap: FinancialDataGap) => Object.freeze({
        code: gap.code,
        sourceType: gap.sourceType,
        sourceId: gap.sourceId,
        sourceSnapshotHash: gap.sourceSnapshotHash,
        cohortId: gap.cohortId,
        currency: gap.currency,
        asOf: gap.recordedAt
      }))
    ];
    const recommendationPage = await dependencies.recommendations.listAt(
      context, {
        status: ["proposed", "accepted"],
        cutoff,
        limit: 100,
        cursor: null
      }
    );
    const sourceSnapshotHash = snapshotHashForView({
      visibility: visibility.sourceSnapshotHash,
      settings: [settings.revision, settings.timeZone],
      priorityCustomers: priorityCustomers.map((row) => [
        row.candidateId,
        row.qualificationDecisionId,
        row.qualificationDecisionVersion,
        row.inputSnapshotHash
      ]),
      pendingQuoteApprovals: pendingQuoteApprovals.map((row) => [
        row.quoteVersionId,
        row.quoteVersionRevision
      ]),
      expectedRoi: expectedRoi.map((row) => [
        row.cohortId,
        row.planId,
        row.currency,
        row.status,
        "roiBps" in row ? row.roiBps : null
      ]),
      actualRoi: actualRoi.map((row) => [
        row.cohortId,
        row.planId,
        row.currency,
        row.status,
        "roiBps" in row ? row.roiBps : null
      ]),
      dataGaps: gapViews.map((gap) => [
        gap.code,
        gap.sourceType,
        gap.sourceId,
        gap.sourceSnapshotHash
      ]),
      recommendations: recommendationPage.items.map((row) => [
        row.id,
        row.revision,
        row.inputSnapshotHash
      ]),
      dataAsOf
    });
    return Object.freeze({
      workspaceId: context.workspaceId,
      audienceRole,
      dataAsOf,
      priorityCustomers,
      pendingQuoteApprovals: Object.freeze(pendingQuoteApprovals),
      expectedRoi: Object.freeze(expectedRoi),
      actualRoi: Object.freeze(actualRoi),
      dataGaps: Object.freeze(gapViews),
      recommendations: Object.freeze([...recommendationPage.items]),
      sourceSnapshotHash
    });
  };
  const getTodayAt = (
    context: ActiveWorkspaceContext,
    query: { currency: string; cutoff: GrowthSealedReadCutoff }
  ) => loadTodayAt(context, query, AUTHORITY_COMPLETENESS_PROBE_LIMITS);
  return Object.freeze({
    async getToday(
      context: ActiveWorkspaceContext,
      query: AdvisorTodayQuery
    ) {
      const readStartedAt = now();
      const effectiveAsOf = assertGrowthAsOfNotFuture(
        query.asOf, readStartedAt, 1_000
      );
      const cutoff = await sealTodayCutoff(context, effectiveAsOf);
      const view = await loadTodayAt(
        context,
        { currency: query.currency, cutoff },
        LEGACY_TODAY_LIMITS
      );
      const sensitive = context.capabilities.includes("pricing.sensitive.read");
      return Object.freeze({
        ...view,
        pendingQuoteApprovals: Object.freeze(
          view.pendingQuoteApprovals.map((row) => Object.freeze({
            approvalId: row.approvalId,
            quoteVersionId: row.quoteVersionId,
            quoteVersionRevision: row.quoteVersionRevision,
            quoteCaseId: row.quoteCaseId,
            approvalKind: row.approvalKind,
            requiredCapabilities: row.requiredCapabilities,
            submittedAt: row.submittedAt,
            expiresAt: row.expiresAt,
            ...(sensitive ? {
              currency: row.currency,
              quotedAmountMinor: row.quotedAmountMinor,
              estimatedGrossProfitMinor: row.estimatedGrossProfitMinor,
              estimatedContributionMinor: row.estimatedContributionMinor,
              grossMarginBps: row.grossMarginBps
            } : {})
          }))
        )
      });
    },
    sealTodayCutoff,
    getTodayAt
  });
}

export interface QuoteVersionJoinedView {
  readonly approval: PendingQuoteApprovalSnapshot;
  readonly quoteVersion: QuoteVersionEvidenceSnapshot;
}

export function joinPendingQuoteVersions(
  approval: PendingQuoteApprovalSnapshot,
  quoteVersion: QuoteVersionEvidenceSnapshot
): QuoteVersionJoinedView {
  return Object.freeze({
    approval,
    quoteVersion
  });
}
