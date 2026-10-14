import type { AcquisitionCandidate, DiscoveryEvidence } from "./acquisition-domain.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { qualifyDouyinCrawlerCandidate } from "./acquisition-douyin-candidate-policy.js";
import type { AcquisitionPiGatewayPort } from "./acquisition-pi-gateway-runtime.js";
import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import {
  ACQUISITION_OUTREACH_DRAFT_TOOL,
  ACQUISITION_OUTREACH_DM_REVIEW_TOOL,
  acquisitionOutreachModelRequest
} from "./acquisition-outreach-model-content.js";
import {
  buildValidatedAcquisitionOutreachFallback,
  validateAcquisitionOutreachDraft,
  type AcquisitionOutreachDraft
} from "./acquisition-outreach-draft.js";
import type { AcquisitionOutreachDraftFinalAuthorityPort } from "./acquisition-outreach-draft-authority.js";

export function assertDraftableDouyinCandidate(input: { id: string; version: number; status: string; evidence: Array<{ id: string; contentHash: string; text: string }> }) {
  if (!input.id || !Number.isSafeInteger(input.version) || input.version < 1
    || input.status === "do_not_contact" || !input.evidence.length) {
    throw new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE");
  }
  for (const evidence of input.evidence) {
    const policy = qualifyDouyinCrawlerCandidate({ text: evidence.text, kind: "comment", hasOriginalPublicSource: true, hasKnownIdentity: true });
    if (policy.status === "suppressed" && policy.retainDoNotContact) {
      throw new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE");
    }
  }
}

export function parseOutreachDraftToolArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["comment", "directMessage", "rationaleCodes"])
    || typeof record.comment !== "string" || typeof record.directMessage !== "string"
    || !Array.isArray(record.rationaleCodes) || !record.rationaleCodes.length
    || record.rationaleCodes.length > 5 || record.rationaleCodes.some((item) => typeof item !== "string")) {
    throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  }
  return { comment: record.comment, directMessage: record.directMessage, rationaleCodes: record.rationaleCodes as string[] };
}

export class AcquisitionOutreachDraftService {
  constructor(private readonly options: { domain: AcquisitionDomainRepository; finalAuthority: AcquisitionOutreachDraftFinalAuthorityPort; crawlerJobs?: Pick<AcquisitionCrawlerJobRepository, "findById" | "listRecords">; resolveSnapshot(scope: { ownerId: string; teamId: string; actorId: string }): Promise<{ jobId: string }>; gateway(snapshotId: string): Promise<AcquisitionPiGatewayPort>; }) {}
  async generate(input: { scope: { workspaceId: string; ownerId: string; teamId: string; actorId: string }; candidateId: string; evidenceIds?: string[] }): Promise<Readonly<AcquisitionOutreachDraft>> {
    const candidate = await this.options.domain.findCandidate(input.scope, input.candidateId);
    if (!candidate || candidate.ownerId !== input.scope.ownerId || candidate.teamId !== input.scope.teamId || candidate.status === "do_not_contact"
      || candidate.profile.kind !== "individual"
      || candidate.profile.sourcePlatform !== "douyin") {
      throw new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE");
    }
    if (!candidate.profile.publicActorKey
      || await this.options.finalAuthority.hasDoNotContact(
        input.scope,
        candidate.profile.publicActorKey
      )) throw new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE");
    const expected = [...candidate.evidenceIds].sort();
    if (input.evidenceIds && canonicalIds(input.evidenceIds) !== canonicalIds(expected)) throw new Error("OUTREACH_EVIDENCE_FORGED");
    const evidence = await Promise.all(expected.map((id) => this.options.domain.findEvidence(input.scope, id)));
    if (evidence.some((item) => !item)) throw new Error("OUTREACH_EVIDENCE_FORGED");
    const trusted = evidence as DiscoveryEvidence[];
    if (trusted.some((item) => item.ownerId !== input.scope.ownerId || item.teamId !== input.scope.teamId || item.sourcePlatform !== "douyin"
      || item.provenance.kind !== "mediacrawler_public_record"
      || !/^sha256:[a-f0-9]{64}$/u.test(item.contentHash))) {
      throw new Error("OUTREACH_EVIDENCE_FORGED");
    }
    assertDraftableDouyinCandidate({ id: candidate.id, version: candidate.version, status: candidate.status, evidence: trusted.map((item) => ({ id: item.id, contentHash: item.contentHash, text: item.sourceSnippet })) });
    const snapshot = await this.options.resolveSnapshot(input.scope);
    if (!snapshot.jobId) throw new Error("MODEL_SNAPSHOT_UNAVAILABLE");
    const context = {
      candidate: publicCandidate(candidate),
      evidence: await draftEvidenceContext(trusted, input.scope.workspaceId, this.options.crawlerJobs)
    };
    const request = acquisitionOutreachModelRequest({ operation: "draft", payload: context });
    const gateway = await this.options.gateway(snapshot.jobId);
    const result = await gateway.callTools({ contentBinding: request.contentBinding, parallelToolCalls: false });
    if (result.toolCalls.length !== 1 || result.toolCalls[0]?.name !== ACQUISITION_OUTREACH_DRAFT_TOOL) throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
    const args = parseOutreachDraftToolArguments(result.toolCalls[0].arguments);
    let reviewed = false;
    let validatedComment: string | null = null;
    try {
      const preliminary = validateAcquisitionOutreachDraft({
        ...args, candidateId: candidate.id, candidateRevision: candidate.version,
        evidenceHashes: trusted.map((item) => item.contentHash), modelSnapshotId: snapshot.jobId
      }, {
        candidateId: candidate.id, candidateRevision: candidate.version,
        evidenceHashes: trusted.map((item) => item.contentHash),
        evidenceText: trusted.map((item) => item.sourceSnippet), modelSnapshotId: snapshot.jobId
      });
      validatedComment = preliminary.comment;
      const review = acquisitionOutreachModelRequest({ operation: "review_direct_message",
        payload: { ...context, directMessage: preliminary.directMessage } });
      const checked = await gateway.callTools({ contentBinding: review.contentBinding, parallelToolCalls: false });
      const call = checked.toolCalls.length === 1 ? checked.toolCalls[0] : null;
      reviewed = call?.name === ACQUISITION_OUTREACH_DM_REVIEW_TOOL
        && acceptsDirectMessageReview(call.arguments, new Set(expected));
    } catch {
      // An unavailable/malformed review cannot endorse model prose. The final
      // authority check below still runs before an evidence-only fallback.
      reviewed = false;
    }
    // This is the final await. The authority port locks the candidate, exact
    // evidence membership/provenance, and DNC key (including an absent-key
    // gap) in one repository boundary before returning immutable values.
    const verified = await this.options.finalAuthority.verify({ scope: input.scope, candidateId: candidate.id, evidenceIds: expected,
      publicActorKey: candidate.profile.publicActorKey, expectedCandidate: candidate, expectedEvidence: trusted });
    const current = verified.candidate;
    const currentEvidence = verified.evidence;
    assertDraftableDouyinCandidate({ id: current.id, version: current.version, status: current.status,
      evidence: currentEvidence.map((item) => ({ id: item.id, contentHash: item.contentHash, text: item.sourceSnippet })) });
    const authority = {
      candidateId: current.id,
      candidateRevision: current.version,
      evidenceHashes: currentEvidence.map((item) => item.contentHash),
      evidenceText: currentEvidence.map((item) => item.sourceSnippet),
      evidenceAttributionKnown: currentEvidence.every((item) =>
        item.provenance.kind === "mediacrawler_public_record"
        && ["creator", "commenter"].includes(item.provenance.actorKind)),
      modelSnapshotId: snapshot.jobId
    };
    if (!reviewed) {
      const fallback = buildValidatedAcquisitionOutreachFallback(authority);
      return validatedComment === null ? fallback : validateAcquisitionOutreachDraft({
        ...fallback, comment: validatedComment
      }, authority);
    }
    try {
      return validateAcquisitionOutreachDraft({
        candidateId: current.id,
        candidateRevision: current.version,
        evidenceHashes: currentEvidence.map((item) => item.contentHash),
        comment: args.comment,
        directMessage: args.directMessage,
        rationaleCodes: args.rationaleCodes,
        modelSnapshotId: snapshot.jobId
      }, authority);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "OUTREACH_DRAFT_INVALID") throw error;
      return buildValidatedAcquisitionOutreachFallback(authority);
    }
  }
}
function acceptsDirectMessageReview(value: unknown, evidenceIds: Set<string>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["evidenceIds", "supported"])
    && row.supported === true && Array.isArray(row.evidenceIds)
    && row.evidenceIds.length <= 20 && new Set(row.evidenceIds).size === row.evidenceIds.length
    && row.evidenceIds.every((id) => typeof id === "string" && evidenceIds.has(id));
}

async function draftEvidenceContext(evidence: DiscoveryEvidence[], workspaceId: string,
  jobs?: Pick<AcquisitionCrawlerJobRepository, "findById" | "listRecords">) {
  const recordsByJob = new Map<string, Awaited<ReturnType<AcquisitionCrawlerJobRepository["listRecords"]>>>();
  for (const item of evidence) {
    if (!jobs || item.provenance.kind !== "mediacrawler_public_record"
      || recordsByJob.has(item.provenance.jobId)) continue;
    const job = await jobs.findById(workspaceId, item.provenance.jobId);
    recordsByJob.set(item.provenance.jobId, job?.workspaceId === workspaceId
      && job.id === item.provenance.jobId ? await jobs.listRecords(job.id) : []);
  }
  return evidence.map((item) => {
    const provenance = item.provenance;
    const role = provenance.kind === "mediacrawler_public_record" ? provenance.actorKind : null;
    const sourceUrl = publicUrl(item);
    const records = provenance.kind === "mediacrawler_public_record"
      ? recordsByJob.get(provenance.jobId) ?? [] : [];
    return {
      id: item.id, contentHash: item.contentHash, excerpt: item.sourceSnippet, sourceUrl,
      // MediaCrawler stores its search keyword in sourceTitle, not a video title.
      searchKeyword: item.sourceTitle ?? "",
      actorRole: role === "creator" || role === "commenter" ? role : "unknown",
      relatedVideos: records.filter((record) => record.kind === "video"
        && record.canonicalUrl === sourceUrl).slice(0, 3).map((record) => ({
        recordId: record.recordId, contentHash: record.contentHash,
        sourceUrl: record.canonicalUrl, excerpt: record.textExcerpt.slice(0, 500),
        attribution: "associated_video_author_not_assumed_recipient"
      }))
    };
  });
}
function canonicalIds(values: string[]) { return JSON.stringify([...values].sort()); }
function publicUrl(evidence: DiscoveryEvidence) { return evidence.provenance.kind === "mediacrawler_public_record" ? evidence.provenance.sourceUrl : null; }
function publicCandidate(candidate: AcquisitionCandidate) { return candidate.profile.kind === "individual" ? { displayName: candidate.profile.publicDisplayName, platform: candidate.profile.sourcePlatform } : { displayName: candidate.profile.name, platform: "unknown" }; }
