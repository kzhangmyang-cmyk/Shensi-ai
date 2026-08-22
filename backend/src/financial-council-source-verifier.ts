import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import {
  validateFinancialCouncilAuthoritySnapshot,
  type FinancialCouncilAuthorityReader,
  type FinancialCouncilAuthoritySnapshot
} from "./financial-council-authority-reader.js";
import {
  validateFinancialSnapshot,
  type FinancialSnapshot
} from "./financial-council-snapshot.js";
import type { GrowthAdvisorSealedQueryService } from
  "./growth-advisor-query.js";
import type {
  ActiveWorkspaceContext,
  GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

export interface FrozenFinancialCouncilWorkspaceBinding {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly teamId: string;
}

export interface VerifiedFinancialCouncilCurrentSources {
  readonly workspaceId: string;
  readonly verifiedAt: string;
  readonly temporalSequence: number;
  readonly sourceSetHash: `sha256:${string}`;
  readonly bindingRevision: string;
}

export interface FinancialCouncilSourceVerifierDependencies {
  readonly cutoffIssuer: Pick<GrowthAdvisorSealedQueryService,
    "sealTodayCutoff">;
  readonly authority: Pick<FinancialCouncilAuthorityReader, "readAt">;
  readonly workspaceResolver: Pick<GrowthAcquisitionWorkspaceResolver,
    "resolve">;
  readonly now?: () => string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function authorityHeadProjection(authority: FinancialCouncilAuthoritySnapshot) {
  return {
    workspaceId: authority.workspaceId,
    currency: authority.currency,
    projectionLevel: authority.projectionLevel,
    priorityCustomers: authority.priorityCustomers.map((row) => ({
      candidateId: row.candidateId,
      customerId: row.customerId,
      dealId: row.dealId,
      priorityScoreBps: row.priorityScoreBps,
      qualificationDecisionId: row.qualificationDecisionId,
      qualificationDecisionVersion: row.qualificationDecisionVersion,
      inputSnapshotHash: row.inputSnapshotHash
    })).sort((left, right) => compare(left.candidateId, right.candidateId)),
    pendingQuoteApprovals: [...authority.pendingQuoteApprovals].sort(
      (left, right) => compare(left.quoteVersionId, right.quoteVersionId)
        || compare(left.approvalId, right.approvalId)
    ),
    verifiedFinancialFacts: [...authority.verifiedFinancialFacts].sort(
      (left, right) => compare(left.entryId, right.entryId)
    ),
    expectedRoi: [...authority.expectedRoi].sort((left, right) =>
      compare(left.cohortId, right.cohortId)
      || compare(left.planId ?? "", right.planId ?? "")
      || compare(left.currency, right.currency)),
    actualRoi: [...authority.actualRoi].sort((left, right) =>
      compare(left.cohortId, right.cohortId)
      || compare(left.planId ?? "", right.planId ?? "")
      || compare(left.currency, right.currency)),
    dataGaps: authority.dataGaps.map(({ asOf: _asOf, ...row }) => row).sort(
      (left, right) => compare(left.sourceType, right.sourceType)
        || compare(left.sourceId, right.sourceId)
        || compare(left.code, right.code)
    )
  };
}

function currentSourceHash(authority: FinancialCouncilAuthoritySnapshot):
`sha256:${string}` {
  return financialCouncilCanonicalHash(authorityHeadProjection(authority));
}

function concrete(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value
    && value !== "" && value !== "all";
}

export class FinancialCouncilSourceVerifier {
  readonly #now: () => string;

  constructor(private readonly dependencies:
  FinancialCouncilSourceVerifierDependencies) {
    if (typeof dependencies?.cutoffIssuer?.sealTodayCutoff !== "function"
      || typeof dependencies?.authority?.readAt !== "function"
      || typeof dependencies?.workspaceResolver?.resolve !== "function") {
      throw new Error("invalid_financial_council_source_verifier");
    }
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async verifyCurrentSources(
    context: ActiveWorkspaceContext,
    rawSnapshot: FinancialSnapshot,
    rawBinding: FrozenFinancialCouncilWorkspaceBinding
  ): Promise<VerifiedFinancialCouncilCurrentSources> {
    const snapshot = validateFinancialSnapshot(rawSnapshot);
    const binding = immutableFinancialCouncilInput(rawBinding);
    if (!context || !concrete(context.workspaceId)
      || !concrete(binding.workspaceId) || !concrete(binding.ownerId)
      || !concrete(binding.teamId)
      || context.workspaceId !== binding.workspaceId
      || snapshot.workspaceId !== binding.workspaceId) {
      throw financialCouncilError("financial_council_workspace_stale");
    }
    const resolved = await this.dependencies.workspaceResolver.resolve({
      ownerId: binding.ownerId,
      teamId: binding.teamId
    });
    if (!resolved || resolved.workspaceId !== binding.workspaceId
      || resolved.ownerId !== binding.ownerId
      || resolved.teamId !== binding.teamId
      || resolved.kind !== context.kind
      || !concrete(resolved.bindingRevision)) {
      throw financialCouncilError("financial_council_workspace_stale");
    }
    const verifiedAt = this.#now();
    const cutoff = await this.dependencies.cutoffIssuer.sealTodayCutoff(
      context, verifiedAt
    );
    const current = validateFinancialCouncilAuthoritySnapshot(
      await this.dependencies.authority.readAt(context, {
        currency: snapshot.currency,
        cutoff
      })
    );
    if (current.workspaceId !== snapshot.workspaceId
      || current.currency !== snapshot.currency
      || current.dataAsOf !== cutoff.effectiveAsOf
      || currentSourceHash(current) !== currentSourceHash(snapshot.authority)) {
      throw financialCouncilError("financial_council_source_stale");
    }
    return immutableFinancialCouncilValue({
      workspaceId: snapshot.workspaceId,
      verifiedAt,
      temporalSequence: cutoff.temporalSequence,
      sourceSetHash: currentSourceHash(current),
      bindingRevision: resolved.bindingRevision
    });
  }
}
