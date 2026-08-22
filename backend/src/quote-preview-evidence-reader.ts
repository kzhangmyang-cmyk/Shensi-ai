import { canonicalJsonStringify } from "./canonical-json.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { QuotePreviewIdentity } from "./quote-domain.js";
import {
  immutableQuoteValue,
  type QuoteRepository,
  type QuoteSubjectEvidenceSnapshot
} from "./quote-repository.js";
import { assertFrozenCommercialBinding } from "./authoritative-quote-reader.js";

function previewError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function trustedCutoff(
  context: ActiveWorkspaceContext,
  cutoff: GrowthSealedReadCutoff
) {
  try {
    return assertGrowthSealedReadCutoff(cutoff, context.workspaceId);
  } catch (error) {
    if (cutoff?.workspaceId !== context.workspaceId) {
      throw previewError("sealed_cutoff_workspace_mismatch");
    }
    throw error;
  }
}

export interface QuotePreviewEvidenceSnapshot {
  readonly id: string;
  readonly quoteCaseId: string;
  readonly salesOwnerActorId: string;
  readonly subjectEvidence: QuoteSubjectEvidenceSnapshot;
  readonly previewIdentity: Readonly<QuotePreviewIdentity>;
  readonly inputSnapshotHash: `sha256:${string}`;
  readonly calculationHash: `sha256:${string}`;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly evidenceHash: `sha256:${string}`;
}

export interface VerifyQuotePreviewEvidenceInput {
  readonly quoteCaseId: string;
  readonly previewIdentity: QuotePreviewIdentity;
  readonly inputSnapshotHash: `sha256:${string}`;
  readonly calculationHash: `sha256:${string}`;
}

function exactIdentity(
  left: QuotePreviewIdentity,
  right: QuotePreviewIdentity
) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function validSubject(
  subject: QuoteSubjectEvidenceSnapshot,
  binding?: CommercialBindingSnapshot | null
) {
  if (!subject || (!subject.candidateId && !subject.customerId
    && !subject.dealId)) return false;
  if (!binding) return true;
  assertFrozenCommercialBinding(binding);
  return subject.candidateId === binding.candidateId
    && subject.customerId === binding.customerId
    && subject.dealId === binding.dealId;
}

export class QuotePreviewEvidenceReader {
  constructor(private readonly repository: QuoteRepository) {}

  async verifyAt(
    context: ActiveWorkspaceContext,
    input: VerifyQuotePreviewEvidenceInput,
    cutoff: GrowthSealedReadCutoff
  ): Promise<QuotePreviewEvidenceSnapshot | null> {
    const trusted = trustedCutoff(context, cutoff);
    const rows = (await this.repository.listPreviewEvidenceAsOf(
      context.workspaceId, input.quoteCaseId, trusted.effectiveAsOf
    )).filter((row) => row.inputSnapshotHash === input.inputSnapshotHash
      && row.calculationHash === input.calculationHash
      && exactIdentity(row.previewIdentity, input.previewIdentity));
    if (rows.length > 1) throw previewError("quote_preview_evidence_corrupt");
    const row = rows[0];
    if (row) {
      if (!validSubject(row.subjectEvidence)) return null;
      return immutableQuoteValue({
        id: row.id, quoteCaseId: row.quoteCaseId,
        salesOwnerActorId: row.salesOwnerActorId,
        subjectEvidence: immutableQuoteValue(structuredClone(
          row.subjectEvidence
        )),
        previewIdentity: immutableQuoteValue(structuredClone(
          row.previewIdentity
        )),
        inputSnapshotHash: row.inputSnapshotHash,
        calculationHash: row.calculationHash,
        effectiveAt: row.effectiveAt,
        recordedAt: row.recordedAt,
        evidenceHash: row.evidenceHash
      });
    }

    const versions = await this.repository.listVersions(
      context.workspaceId, input.quoteCaseId
    );
    const matching = versions.filter((version) =>
      version.recordedAt <= trusted.effectiveAsOf
      && version.inputSnapshotHash === input.inputSnapshotHash
      && version.calculationHash === input.calculationHash
      && exactIdentity(version.previewIdentity as QuotePreviewIdentity,
        input.previewIdentity));
    if (matching.length > 1) {
      const identities = new Set(matching.map((version) => [
        version.salesOwnerActorId,
        canonicalJsonStringify(version.subjectEvidence),
        String((version.commercialBindingSnapshot as
          CommercialBindingSnapshot | null)?.bindingHash)
      ].join("\u0000")));
      if (identities.size !== 1) {
        throw previewError("quote_preview_evidence_corrupt");
      }
    }
    const version = matching.sort((left, right) =>
      right.temporalSequence - left.temporalSequence)[0];
    if (!version) return null;
    const subject = version.subjectEvidence as QuoteSubjectEvidenceSnapshot;
    const binding = version.commercialBindingSnapshot as
      CommercialBindingSnapshot | null;
    if (typeof version.salesOwnerActorId !== "string"
      || !validSubject(subject, binding)) return null;
    return immutableQuoteValue({
      id: version.id, quoteCaseId: version.quoteCaseId,
      salesOwnerActorId: version.salesOwnerActorId,
      subjectEvidence: immutableQuoteValue(structuredClone(subject)),
      previewIdentity: immutableQuoteValue(structuredClone(
        version.previewIdentity as QuotePreviewIdentity
      )),
      inputSnapshotHash: input.inputSnapshotHash,
      calculationHash: input.calculationHash,
      effectiveAt: version.effectiveAt,
      recordedAt: version.recordedAt,
      evidenceHash: String(version.calculationHash) as `sha256:${string}`
    });
  }
}
