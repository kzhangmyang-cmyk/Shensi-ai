import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import type {
  AcquisitionCohortMember,
  AcquisitionCohortMemberSource
} from "./acquisition-cohort-repository.js";
import type {
  RoiClosureVersion,
  RoiCoverageSnapshot,
  RoiSnapshot
} from "./acquisition-roi-closure.js";
import {
  calculateExpectedRoi,
  type RoiGapCode
} from "./acquisition-roi-calculation.js";

export interface GrowthPerformanceQuery {
  cohortId: string;
  currency: string;
  asOf: string;
  planId: string | null;
  closureVersionId: string | null;
}

export type ExpectedRoiCurrencyView = {
  currency: string;
  status: "computed" | "not_computable";
  reason: "cost_missing" | "attribution_incomplete" | "zero_estimated_cost"
    | null;
  roiBps: number | null;
  formulaVersion: "expected-gross-profit-roi.v1";
  quoteVersionIds: string[];
  probabilityAssessmentIds: string[];
  costEstimateIds: string[];
} & (
  | {
      amountVisibility: "full";
      probabilityWeightedGrossProfitMinor: number | null;
      attributedEstimatedCostMinor: number | null;
    }
  | { amountVisibility: "redacted" }
);

export type ActualRoiCurrencyView =
  | ({
      currency: string;
      status: "computed";
      basis: "verified_gross_profit";
      roiBps: number;
      costCoverageBps: number;
      marginCoverageBps: number;
      cashCoverageBps: number;
      attributionCoverageBps: number;
      closureVersionId: string;
      closureAsOf: string;
      formulaVersion: "verified-gross-profit-roi.v1";
    } & (
      | {
          amountVisibility: "full";
          verifiedGrossProfitMinor: number;
          verifiedAcquisitionCostMinor: number;
        }
      | { amountVisibility: "redacted" }
    ))
  | {
      currency: string;
      status: "not_computable";
      reason: RoiGapCode;
      closureVersionId: string | null;
      closureAsOf: string | null;
      formulaVersion: "verified-gross-profit-roi.v1";
    };

export type CashCurrencyView = {
  currency: string;
  status: "complete" | "incomplete" | "not_available";
  contractRoas: unknown;
  cashMultiple: unknown;
  collectionRate: unknown;
} & (
  | {
      amountVisibility: "full";
      verifiedContractWonMinor: number;
      verifiedAcquisitionCostMinor: number;
      allocatedPaymentMinor: number;
      allocatedRefundMinor: number;
      allocatedBadDebtMinor: number;
      netCashMinor: number;
    }
  | { amountVisibility: "redacted" }
);

export interface GrowthPerformanceDto {
  cohortId: string;
  currency: string;
  planId: string | null;
  dataAsOf: string;
  memberIds: string[];
  expectedRoiByCurrency: ExpectedRoiCurrencyView[];
  actualRoiByCurrency: ActualRoiCurrencyView[];
  cashByCurrency: CashCurrencyView[];
  coverage: RoiCoverageSnapshot;
  dataGaps: RoiGapCode[];
  closureVersionId: string | null;
  formulaVersion: string;
  calculationHash: string;
  membershipSnapshotHash: string | null;
}

export interface GrowthPerformanceQueryPage<Row> {
  rows: readonly Row[];
  truncated: boolean;
}

export interface PublishedClosureSelection {
  closure: RoiClosureVersion;
  truncated: boolean;
}

export interface GrowthPerformanceDataSource {
  listCohortMembersAsOf(
    workspaceId: string,
    cohortId: string,
    planId: string | null,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthPerformanceQueryPage<AcquisitionCohortMember>>;
  listCohortMemberSourcesAsOf(
    workspaceId: string,
    cohortMemberIds: readonly string[],
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthPerformanceQueryPage<AcquisitionCohortMemberSource>>;
  selectPublishedClosure(
    workspaceId: string,
    cohortId: string,
    currency: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<PublishedClosureSelection | null>;
  getExactPublishedClosure(
    workspaceId: string,
    cohortId: string,
    currency: string,
    closureVersionId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<PublishedClosureSelection | null>;
  readMaterializedSnapshot(
    workspaceId: string,
    closureVersionId: string,
    sliceKey: "all" | `plan:${string}`
  ): Promise<RoiSnapshot | null>;
}

export interface ExpectedRoiContributionSource {
  listQuoteContributions(
    workspaceId: string,
    candidateIds: string[],
    currency: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<Array<{
    dealId: string;
    approvedGrossProfitMinor: number;
    closeProbabilityBps: number;
    quoteVersionId: string;
    probabilityAssessmentId: string;
  }>>;
}

export interface AcquisitionGrowthPerformanceQueryService {
  getAt(
    context: ActiveWorkspaceContext,
    query: Omit<GrowthPerformanceQuery, "asOf">,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthPerformanceDto>;
}

export class DefaultAcquisitionGrowthPerformanceQueryService
implements AcquisitionGrowthPerformanceQueryService {
  constructor(
    private readonly source: GrowthPerformanceDataSource,
    private readonly contributions: ExpectedRoiContributionSource
  ) {}

  async getAt(
    context: ActiveWorkspaceContext,
    query: Omit<GrowthPerformanceQuery, "asOf">,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthPerformanceDto> {
    requireGrowthCapabilities(context, [
      "growth.performance.workspace.read"
    ]);
    if (cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const members = await this.source.listCohortMembersAsOf(
      context.workspaceId, query.cohortId, query.planId, cutoff
    );
    const memberIds = members.rows.map((member) => member.id);
    const sources = await this.source.listCohortMemberSourcesAsOf(
      context.workspaceId, memberIds, cutoff
    );
    const candidateIds = [
      ...new Set([
        ...members.rows.map((member) => member.primaryCandidateId),
        ...sources.rows.map((source) => source.candidateId)
      ])
    ];
    const contributions = await this.contributions.listQuoteContributions(
      context.workspaceId, candidateIds, query.currency, cutoff
    );
    const quoteVersionIds = contributions.map(
      (contribution) => contribution.quoteVersionId
    );
    const probabilityAssessmentIds = contributions.map(
      (contribution) => contribution.probabilityAssessmentId
    );
    const expected = calculateExpectedRoi({
      contributions: contributions.map((contribution) => ({
        dealId: contribution.dealId,
        approvedGrossProfitMinor: contribution.approvedGrossProfitMinor,
        closeProbabilityBps: contribution.closeProbabilityBps
      })),
      attributedEstimatedCostMinor: null,
      costCoverageBps: 0
    });
    const expectedView: ExpectedRoiCurrencyView = {
      currency: query.currency,
      status: expected.status,
      reason: expected.status === "not_computable" ? expected.reason : null,
      roiBps: expected.status === "computed" ? expected.roiBps : null,
      formulaVersion: "expected-gross-profit-roi.v1",
      quoteVersionIds,
      probabilityAssessmentIds,
      costEstimateIds: [],
      amountVisibility: "full",
      probabilityWeightedGrossProfitMinor:
        expected.status === "computed"
          ? expected.probabilityWeightedGrossProfitMinor : null,
      attributedEstimatedCostMinor:
        expected.status === "computed"
          ? expected.attributedEstimatedCostMinor : null
    };
    let selection: PublishedClosureSelection | null = null;
    if (query.closureVersionId) {
      selection = await this.source.getExactPublishedClosure(
        context.workspaceId, query.cohortId, query.currency,
        query.closureVersionId, cutoff
      );
    } else {
      selection = await this.source.selectPublishedClosure(
        context.workspaceId, query.cohortId, query.currency, cutoff
      );
    }
    const sliceKey: "all" | `plan:${string}` = query.planId
      ? `plan:${query.planId}` : "all";
    let actualView: ActualRoiCurrencyView = {
      currency: query.currency,
      status: "not_computable",
      reason: "cohort_not_closed",
      closureVersionId: null,
      closureAsOf: null,
      formulaVersion: "verified-gross-profit-roi.v1"
    };
    let cashView: CashCurrencyView | null = null;
    let coverage: RoiCoverageSnapshot = {
      costCoverageBps: 0,
      marginCoverageBps: 0,
      cashCoverageBps: 0,
      attributionCoverageBps: 0,
      gapCodes: ["cohort_not_closed"]
    };
    let membershipSnapshotHash: string | null = null;
    if (selection) {
      const snapshot = await this.source.readMaterializedSnapshot(
        context.workspaceId, selection.closure.id, sliceKey
      );
      if (snapshot) {
        const metrics = snapshot.computedMetrics;
        if (metrics.status === "computed") {
          actualView = {
            currency: query.currency,
            status: "computed",
            basis: "verified_gross_profit",
            roiBps: metrics.roiBps,
            costCoverageBps: snapshot.coverage.costCoverageBps,
            marginCoverageBps: snapshot.coverage.marginCoverageBps,
            cashCoverageBps: snapshot.coverage.cashCoverageBps,
            attributionCoverageBps:
              snapshot.coverage.attributionCoverageBps,
            closureVersionId: selection.closure.id,
            closureAsOf: selection.closure.asOf,
            formulaVersion: "verified-gross-profit-roi.v1",
            amountVisibility: "full",
            verifiedGrossProfitMinor: metrics.verifiedGrossProfitMinor,
            verifiedAcquisitionCostMinor:
              metrics.verifiedAcquisitionCostMinor
          };
        } else {
          actualView = {
            currency: query.currency,
            status: "not_computable",
            reason: metrics.reason,
            closureVersionId: selection.closure.id,
            closureAsOf: selection.closure.asOf,
            formulaVersion: "verified-gross-profit-roi.v1"
          };
        }
        const ratios = snapshot.commercialRatios;
        cashView = {
          currency: query.currency,
          status: "complete",
          contractRoas: ratios.contractRoas,
          cashMultiple: ratios.cashMultiple,
          collectionRate: ratios.collectionRate,
          amountVisibility: "full",
          verifiedContractWonMinor: ratios.verifiedContractWonMinor,
          verifiedAcquisitionCostMinor: ratios.verifiedAcquisitionCostMinor,
          allocatedPaymentMinor: ratios.allocatedPaymentMinor,
          allocatedRefundMinor: Math.max(
            0, ratios.allocatedPaymentMinor - ratios.netCashMinor
          ),
          allocatedBadDebtMinor: 0,
          netCashMinor: ratios.netCashMinor
        };
        coverage = snapshot.coverage;
        membershipSnapshotHash = snapshot.memberSetHash;
      }
    }
    const calculationHash = hashCanonicalJson({
      cohortId: query.cohortId,
      currency: query.currency,
      planId: query.planId,
      memberIds: [...memberIds].sort(),
      expectedView,
      actualView,
      cashView
    });
    return {
      cohortId: query.cohortId,
      currency: query.currency,
      planId: query.planId,
      dataAsOf: cutoff.effectiveAsOf,
      memberIds,
      expectedRoiByCurrency: [expectedView],
      actualRoiByCurrency: [actualView],
      cashByCurrency: cashView ? [cashView] : [],
      coverage,
      dataGaps: coverage.gapCodes,
      closureVersionId: selection?.closure.id ?? null,
      formulaVersion: "growth-performance.v1",
      calculationHash,
      membershipSnapshotHash
    };
  }
}
