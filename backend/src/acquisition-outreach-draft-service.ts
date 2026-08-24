import type { AcquisitionCandidate, DiscoveryEvidence } from "./acquisition-domain.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { qualifyDouyinCrawlerCandidate } from "./acquisition-douyin-candidate-policy.js";
import type { AcquisitionPiGatewayPort } from "./acquisition-pi-gateway-runtime.js";
import {
  ACQUISITION_OUTREACH_DRAFT_TOOL,
  acquisitionOutreachModelRequest
} from "./acquisition-outreach-model-content.js";
import { validateAcquisitionOutreachDraft, type AcquisitionOutreachDraft } from "./acquisition-outreach-draft.js";

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
  constructor(private readonly options: { domain: AcquisitionDomainRepository; resolveSnapshot(scope: { ownerId: string; teamId: string }): Promise<{ jobId: string }>; gateway(snapshotId: string): Promise<AcquisitionPiGatewayPort>; }) {}
  async generate(input: { scope: { ownerId: string; teamId: string }; candidateId: string; evidenceIds?: string[] }): Promise<Readonly<AcquisitionOutreachDraft>> {
    const candidate = await this.options.domain.findCandidate(input.scope, input.candidateId);
    if (!candidate || candidate.status === "do_not_contact"
      || candidate.profile.kind !== "individual"
      || candidate.profile.sourcePlatform !== "douyin") {
      throw new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE");
    }
    const expected = [...candidate.evidenceIds].sort();
    if (input.evidenceIds && canonicalIds(input.evidenceIds) !== canonicalIds(expected)) throw new Error("OUTREACH_EVIDENCE_FORGED");
    const evidence = await Promise.all(expected.map((id) => this.options.domain.findEvidence(input.scope, id)));
    if (evidence.some((item) => !item)) throw new Error("OUTREACH_EVIDENCE_FORGED");
    const trusted = evidence as DiscoveryEvidence[];
    if (trusted.some((item) => item.sourcePlatform !== "douyin"
      || item.provenance.kind !== "mediacrawler_public_record"
      || !/^sha256:[a-f0-9]{64}$/u.test(item.contentHash))) {
      throw new Error("OUTREACH_EVIDENCE_FORGED");
    }
    assertDraftableDouyinCandidate({ id: candidate.id, version: candidate.version, status: candidate.status, evidence: trusted.map((item) => ({ id: item.id, contentHash: item.contentHash, text: item.sourceSnippet })) });
    const snapshot = await this.options.resolveSnapshot(input.scope);
    if (!snapshot.jobId) throw new Error("MODEL_SNAPSHOT_UNAVAILABLE");
    const request = acquisitionOutreachModelRequest({ operation: "draft", payload: { candidate: publicCandidate(candidate), evidence: trusted.map((item) => ({ id: item.id, contentHash: item.contentHash, excerpt: item.sourceSnippet, sourceUrl: publicUrl(item) })) } });
    const result = await (await this.options.gateway(snapshot.jobId)).callTools({ contentBinding: request.contentBinding, parallelToolCalls: false });
    if (result.toolCalls.length !== 1 || result.toolCalls[0]?.name !== ACQUISITION_OUTREACH_DRAFT_TOOL) throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
    const args = parseOutreachDraftToolArguments(result.toolCalls[0].arguments);
    // Model traffic is outside the transaction boundary. Re-read all server
    // authority before returning so a concurrent DNC/refusal/revision change
    // can never be turned into a usable immutable draft.
    const current = await this.options.domain.findCandidate(input.scope, input.candidateId);
    if (!current || current.id !== candidate.id || current.version !== candidate.version
      || current.status !== candidate.status || canonicalIds(current.evidenceIds) !== canonicalIds(expected)) {
      throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED");
    }
    const currentEvidence = await Promise.all(expected.map((id) => this.options.domain.findEvidence(input.scope, id)));
    if (currentEvidence.some((item) => !item)
      || currentEvidence.some((item, index) => item?.contentHash !== trusted[index]?.contentHash
        || item?.sourceSnippet !== trusted[index]?.sourceSnippet)) {
      throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED");
    }
    assertDraftableDouyinCandidate({ id: current.id, version: current.version, status: current.status,
      evidence: (currentEvidence as DiscoveryEvidence[]).map((item) => ({ id: item.id, contentHash: item.contentHash, text: item.sourceSnippet })) });
    return validateAcquisitionOutreachDraft({ candidateId: candidate.id, candidateRevision: candidate.version,
      evidenceHashes: trusted.map((item) => item.contentHash), comment: args.comment,
      directMessage: args.directMessage, rationaleCodes: args.rationaleCodes, modelSnapshotId: snapshot.jobId }, {
      candidateId: candidate.id, candidateRevision: candidate.version, evidenceHashes: trusted.map((item) => item.contentHash), evidenceText: trusted.map((item) => item.sourceSnippet), modelSnapshotId: snapshot.jobId
    });
  }
}
function canonicalIds(values: string[]) { return JSON.stringify([...values].sort()); }
function publicUrl(evidence: DiscoveryEvidence) { return evidence.provenance.kind === "mediacrawler_public_record" ? evidence.provenance.sourceUrl : null; }
function publicCandidate(candidate: AcquisitionCandidate) { return candidate.profile.kind === "individual" ? { displayName: candidate.profile.publicDisplayName, platform: candidate.profile.sourcePlatform } : { displayName: candidate.profile.name, platform: "unknown" }; }
