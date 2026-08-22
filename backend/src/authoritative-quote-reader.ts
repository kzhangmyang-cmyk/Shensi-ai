import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import { BINDING_HASH_SCHEMA_VERSION,
  type CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import {
  immutableQuoteValue,
  type CommercialBindingEvidenceSnapshot,
  type DealAuthoritativeQuoteEvent,
  type QuoteRepository,
  type QuoteVersion
} from "./quote-repository.js";

function authorityError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function cutoffFor(
  context: ActiveWorkspaceContext,
  cutoff: GrowthSealedReadCutoff
): GrowthSealedReadCutoff {
  try {
    return assertGrowthSealedReadCutoff(cutoff, context.workspaceId);
  } catch (error) {
    if (cutoff?.workspaceId !== context.workspaceId) {
      throw authorityError("sealed_cutoff_workspace_mismatch");
    }
    throw error;
  }
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

export function commercialBindingEvidenceFromSnapshot(
  snapshot: CommercialBindingSnapshot
): CommercialBindingEvidenceSnapshot {
  return immutableQuoteValue({
    candidateId: snapshot.candidateId,
    customerId: snapshot.customerId,
    dealId: snapshot.dealId,
    handoffContentHash: snapshot.handoffContentHash,
    dealContentHash: snapshot.dealContentHash,
    bindingHashSchemaVersion: snapshot.bindingHashSchemaVersion,
    bindingHash: snapshot.bindingHash
  });
}

export function assertFrozenCommercialBinding(
  snapshot: CommercialBindingSnapshot,
  evidence?: CommercialBindingEvidenceSnapshot
): CommercialBindingEvidenceSnapshot {
  if (snapshot.bindingHashSchemaVersion !== BINDING_HASH_SCHEMA_VERSION) {
    throw authorityError("commercial_binding_hash_mismatch");
  }
  const expectedHash = sha({
    customerId: snapshot.customerId,
    handoffContentHash: snapshot.handoffContentHash,
    dealContentHash: snapshot.dealContentHash,
    bindingHashSchemaVersion: snapshot.bindingHashSchemaVersion
  });
  if (expectedHash !== snapshot.bindingHash) {
    throw authorityError("commercial_binding_hash_mismatch");
  }
  const projected = commercialBindingEvidenceFromSnapshot(snapshot);
  if (evidence && canonicalJsonStringify(evidence)
    !== canonicalJsonStringify(projected)) {
    throw authorityError("commercial_binding_authority_mismatch");
  }
  return projected;
}

export interface AuthoritativeQuoteRef {
  readonly quoteCaseId: string;
  readonly quoteVersionId: string;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly authorityRevision: number;
}

export interface AuthoritativeDealDecisionRef {
  readonly type: "won" | "lost";
  readonly dealId: string;
  readonly quoteCaseId: string;
  readonly quoteVersionId: string;
  readonly currency: string;
  readonly quotedAmountMinor: number;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly commercialBindingEvidence: CommercialBindingEvidenceSnapshot;
  readonly commercialBindingSnapshot: CommercialBindingSnapshot;
  readonly authorityRevision: number;
  readonly decidedAt: string;
}

function currentFromEvents(
  events: readonly DealAuthoritativeQuoteEvent[]
): AuthoritativeQuoteRef | null {
  let current: AuthoritativeQuoteRef | null = null;
  for (const event of [...events].sort((left, right) =>
    left.authorityRevision - right.authorityRevision)) {
    if ((event.eventType === "approved"
      || event.eventType === "quote_authorized"
      || event.eventType === "superseded")
      && event.quoteVersionId && event.commercialAmountHash) {
      current = immutableQuoteValue({
        quoteCaseId: event.quoteCaseId,
        quoteVersionId: event.quoteVersionId,
        commercialAmountHash: event.commercialAmountHash,
        authorityRevision: event.authorityRevision
      });
    } else if (event.eventType === "rejected"
      || event.eventType === "expired" || event.eventType === "won"
      || event.eventType === "lost" || event.eventType === "case_released") {
      current = null;
    }
  }
  return current;
}

export class DealAuthoritativeQuoteReader {
  constructor(private readonly repository: QuoteRepository) {}

  async getCurrent(context: ActiveWorkspaceContext, dealId: string) {
    const authority = await this.repository.findCurrentDealAuthority(
      context.workspaceId, dealId
    );
    if (!authority?.quoteVersionId || !authority.commercialAmountHash
      || !authority.openQuoteCaseId) return null;
    return immutableQuoteValue({ quoteCaseId: authority.openQuoteCaseId,
      quoteVersionId: authority.quoteVersionId,
      commercialAmountHash: authority.commercialAmountHash,
      authorityRevision: authority.authorityRevision });
  }

  async getAt(
    context: ActiveWorkspaceContext,
    dealId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AuthoritativeQuoteRef | null> {
    const trusted = cutoffFor(context, cutoff);
    const events = (await this.repository.listAuthorityEvents(
      context.workspaceId, dealId
    )).filter((event) => event.recordedAt <= trusted.effectiveAsOf);
    return currentFromEvents(events);
  }

  async getDecisionAt(
    context: ActiveWorkspaceContext,
    dealId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AuthoritativeDealDecisionRef | null> {
    const trusted = cutoffFor(context, cutoff);
    const event = (await this.repository.listAuthorityEvents(
      context.workspaceId, dealId
    )).filter((candidate) => candidate.recordedAt <= trusted.effectiveAsOf
      && (candidate.eventType === "won" || candidate.eventType === "lost"))
      .sort((left, right) => right.authorityRevision
        - left.authorityRevision)[0];
    if (!event) return null;
    const snapshot = event.commercialBindingSnapshot;
    const evidence = event.commercialBindingEvidence;
    if (!event.quoteVersionId || !event.currency
      || !Number.isSafeInteger(event.quotedAmountMinor)
      || !event.commercialAmountHash || !snapshot || !evidence
      || snapshot.dealId !== dealId || evidence.dealId !== dealId) {
      throw authorityError("commercial_binding_authority_mismatch");
    }
    assertFrozenCommercialBinding(snapshot, evidence);
    const version = await this.repository.getVersion(
      context.workspaceId, event.quoteVersionId
    );
    if (!version || version.versionKind !== "formal"
      || version.quoteCaseId !== event.quoteCaseId
      || version.currency !== event.currency
      || version.quotedAmountMinor !== event.quotedAmountMinor
      || version.commercialAmountHash !== event.commercialAmountHash
      || canonicalJsonStringify(version.commercialBindingSnapshot)
        !== canonicalJsonStringify(snapshot)) {
      throw authorityError("commercial_binding_authority_mismatch");
    }
    return immutableQuoteValue({
      type: event.eventType as "won" | "lost",
      dealId,
      quoteCaseId: event.quoteCaseId,
      quoteVersionId: event.quoteVersionId,
      currency: event.currency,
      quotedAmountMinor: event.quotedAmountMinor!,
      commercialAmountHash: event.commercialAmountHash,
      commercialBindingEvidence: immutableQuoteValue(structuredClone(evidence)),
      commercialBindingSnapshot: immutableQuoteValue(structuredClone(snapshot)),
      authorityRevision: event.authorityRevision,
      decidedAt: event.decidedAt ?? event.recordedAt
    });
  }
}

export interface AuthoritativeQuoteContribution {
  readonly candidateId: string;
  readonly dealId: string;
  readonly quoteVersionId: string;
  readonly currency: string;
  readonly approvedQuoteGrossProfitMinor: number;
  readonly closeProbabilityBps: number;
  readonly probabilityAssessmentId: string;
  readonly commercialAmountHash: `sha256:${string}`;
}

function versionStatusAt(
  version: QuoteVersion,
  events: Awaited<ReturnType<QuoteRepository["listLifecycleEvents"]>>,
  effectiveAsOf: string
) {
  return events.filter((event) => event.quoteVersionId === version.id
    && event.recordedAt <= effectiveAsOf)
    .sort((left, right) => right.revision - left.revision)[0]?.toStatus
    ?? version.status;
}

export class AuthoritativeQuoteAsOfReader {
  constructor(private readonly repository: QuoteRepository) {}

  async listContributionsAsOf(
    context: ActiveWorkspaceContext,
    input: {
      candidateIds: string[];
      currency: string;
      cutoff: GrowthSealedReadCutoff;
    }
  ): Promise<AuthoritativeQuoteContribution[]> {
    const trusted = cutoffFor(context, input.cutoff);
    const candidateIds = new Set(input.candidateIds);
    const authorityEvents = (await this.repository.listAuthorityEvents(
      context.workspaceId
    )).filter((event) => event.recordedAt <= trusted.effectiveAsOf);
    const byDeal = new Map<string, DealAuthoritativeQuoteEvent[]>();
    for (const event of authorityEvents) {
      const events = byDeal.get(event.dealId) ?? [];
      events.push(event);
      byDeal.set(event.dealId, events);
    }
    const lifecycleEvents = await this.repository.listLifecycleEvents(
      context.workspaceId
    );
    const rows: AuthoritativeQuoteContribution[] = [];
    for (const [dealId, events] of byDeal) {
      const current = currentFromEvents(events);
      if (!current) continue;
      const version = await this.repository.getVersion(
        context.workspaceId, current.quoteVersionId
      );
      if (!version || version.versionKind !== "formal"
        || versionStatusAt(version, lifecycleEvents,
          trusted.effectiveAsOf) !== "approved") continue;
      const assessment = version.probabilityAssessmentSnapshot;
      const binding = version.commercialBindingSnapshot as
        CommercialBindingSnapshot | null;
      if (!assessment || assessment.precision !== "bps" || !binding) continue;
      assertFrozenCommercialBinding(binding);
      if (!candidateIds.has(binding.candidateId)
        || version.currency !== input.currency) continue;
      rows.push(immutableQuoteValue({
        candidateId: binding.candidateId, dealId,
        quoteVersionId: version.id, currency: input.currency,
        approvedQuoteGrossProfitMinor: Number(
          version.estimatedGrossProfitMinor
        ),
        closeProbabilityBps: assessment.closeProbabilityBps,
        probabilityAssessmentId: assessment.id,
        commercialAmountHash: current.commercialAmountHash
      }));
    }
    return rows;
  }
}

export interface PendingQuoteApprovalSnapshot {
  readonly quoteCaseId: string;
  readonly quoteVersionId: string;
  readonly approvalId: string;
  readonly approvalKind: "confirmation" | "exception";
  readonly requiredCapabilities: readonly string[];
  readonly lifecycleRevision: number;
  readonly currency: string;
  readonly quotedAmountMinor: number;
  readonly estimatedGrossProfitMinor: number;
  readonly estimatedContributionMinor: number;
  readonly grossMarginBps: number;
  readonly probabilityAssessmentId: string;
  readonly closeProbabilityBps: number;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly salesOwnerActorId: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly expiresAt: string | null;
}

export class QuoteApprovalAsOfReader {
  constructor(private readonly repository: QuoteRepository) {}

  async listPendingAsOf(
    context: ActiveWorkspaceContext,
    input: {
      cutoff: GrowthSealedReadCutoff;
      limit: number;
      currency?: string;
    }
  ): Promise<readonly PendingQuoteApprovalSnapshot[]> {
    const trusted = cutoffFor(context, input.cutoff);
    const limit = Math.min(100, Math.max(1, input.limit));
    const [approvals, approvalEvents, lifecycleEvents] = await Promise.all([
      this.repository.listApprovals(context.workspaceId),
      this.repository.listApprovalEvents(context.workspaceId),
      this.repository.listLifecycleEvents(context.workspaceId)
    ]);
    const rows: PendingQuoteApprovalSnapshot[] = [];
    for (const approval of approvals) {
      if (approval.submittedAt > trusted.effectiveAsOf) continue;
      const decision = approvalEvents.filter((event) =>
        event.approvalId === approval.id
        && event.recordedAt <= trusted.effectiveAsOf)
        .sort((left, right) => right.revision - left.revision)[0];
      if (decision && decision.status !== "pending") continue;
      const version = await this.repository.getVersion(
        context.workspaceId, approval.quoteVersionId
      );
      if (!version || version.versionKind !== "formal"
        || version.recordedAt > trusted.effectiveAsOf) continue;
      if (input.currency !== undefined
        && version.currency !== input.currency) continue;
      const lifecycle = lifecycleEvents.filter((event) =>
        event.quoteVersionId === version.id
        && event.recordedAt <= trusted.effectiveAsOf)
        .sort((left, right) => right.revision - left.revision)[0];
      if ((lifecycle?.toStatus ?? version.status) !== "submitted") continue;
      const assessment = version.probabilityAssessmentSnapshot;
      const owner = version.salesOwnerActorId;
      if (!assessment || assessment.precision !== "bps"
        || typeof owner !== "string"
        || context.role === "sales" && owner !== context.actorId) continue;
      rows.push(immutableQuoteValue({
        quoteCaseId: version.quoteCaseId, quoteVersionId: version.id,
        approvalId: approval.id, approvalKind: approval.approvalKind,
        requiredCapabilities: Object.freeze([...approval.requiredCapabilities]),
        lifecycleRevision: lifecycle?.revision ?? version.lifecycleRevision,
        currency: String(version.currency),
        quotedAmountMinor: Number(version.quotedAmountMinor),
        estimatedGrossProfitMinor: Number(version.estimatedGrossProfitMinor),
        estimatedContributionMinor: Number(version.estimatedContributionMinor),
        grossMarginBps: Number(version.grossMarginBps),
        probabilityAssessmentId: assessment.id,
        closeProbabilityBps: assessment.closeProbabilityBps,
        commercialAmountHash: String(version.commercialAmountHash) as
          `sha256:${string}`,
        salesOwnerActorId: owner, submittedBy: approval.submittedBy,
        submittedAt: approval.submittedAt,
        expiresAt: typeof version.expiresAt === "string"
          ? version.expiresAt : null
      }));
    }
    return Object.freeze(rows.sort((left, right) =>
      left.submittedAt.localeCompare(right.submittedAt)
      || left.quoteVersionId.localeCompare(right.quoteVersionId)).slice(0, limit));
  }
}

export interface QuoteVersionEvidenceSnapshot {
  readonly quoteCaseId: string;
  readonly quoteVersionId: string;
  readonly salesOwnerActorId: string;
  readonly versionKind: "draft" | "formal";
  readonly sourceDraftVersionId: string | null;
  readonly commercialBindingEvidence: CommercialBindingEvidenceSnapshot;
  readonly probabilityAssessmentId: string;
  readonly closeProbabilityBps: number;
  readonly lifecycleRevision: number;
  readonly status: QuoteVersion["status"];
  readonly currency: string;
  readonly quotedAmountMinor: number;
  readonly estimatedGrossProfitMinor: number;
  readonly estimatedContributionMinor: number;
  readonly grossMarginBps: number;
  readonly inputSnapshotHash: `sha256:${string}`;
  readonly calculationHash: `sha256:${string}`;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly lifecycleEventId: string;
  readonly recordedAt: string;
}

export class QuoteVersionEvidenceReader {
  constructor(private readonly repository: QuoteRepository) {}

  async getAt(
    context: ActiveWorkspaceContext,
    quoteVersionId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<QuoteVersionEvidenceSnapshot | null> {
    const trusted = cutoffFor(context, cutoff);
    const version = await this.repository.getVersion(
      context.workspaceId, quoteVersionId
    );
    if (!version || version.recordedAt > trusted.effectiveAsOf) return null;
    const events = await this.repository.listLifecycleEvents(
      context.workspaceId, version.id
    );
    const lifecycle = events.filter((event) =>
      event.recordedAt <= trusted.effectiveAsOf)
      .sort((left, right) => right.revision - left.revision)[0];
    if (!lifecycle) return null;
    const binding = version.commercialBindingSnapshot as
      CommercialBindingSnapshot | null;
    const subject = version.subjectEvidence as {
      candidateId?: unknown; customerId?: unknown; dealId?: unknown
    } | undefined;
    const owner = version.salesOwnerActorId;
    const assessment = version.probabilityAssessmentSnapshot;
    if (!binding || typeof owner !== "string" || !assessment
      || assessment.precision !== "bps"
      || subject?.candidateId !== binding.candidateId
      || subject.customerId !== binding.customerId
      || subject.dealId !== binding.dealId) {
      throw authorityError("commercial_binding_authority_mismatch");
    }
    const evidence = assertFrozenCommercialBinding(binding);
    return immutableQuoteValue({
      quoteCaseId: version.quoteCaseId, quoteVersionId: version.id,
      salesOwnerActorId: owner, versionKind: version.versionKind,
      sourceDraftVersionId: version.sourceDraftVersionId,
      commercialBindingEvidence: evidence,
      probabilityAssessmentId: assessment.id,
      closeProbabilityBps: assessment.closeProbabilityBps,
      lifecycleRevision: lifecycle.revision,
      status: lifecycle.toStatus as QuoteVersion["status"],
      currency: String(version.currency),
      quotedAmountMinor: Number(version.quotedAmountMinor),
      estimatedGrossProfitMinor: Number(version.estimatedGrossProfitMinor),
      estimatedContributionMinor: Number(version.estimatedContributionMinor),
      grossMarginBps: Number(version.grossMarginBps),
      inputSnapshotHash: String(version.inputSnapshotHash) as `sha256:${string}`,
      calculationHash: String(version.calculationHash) as `sha256:${string}`,
      commercialAmountHash: String(version.commercialAmountHash) as
        `sha256:${string}`,
      lifecycleEventId: lifecycle.id, recordedAt: lifecycle.recordedAt
    });
  }
}
