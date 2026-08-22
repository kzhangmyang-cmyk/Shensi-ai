import {
  classifyDouyinPublicSource
} from "./acquisition-douyin-public-source.js";
import {
  isVerifiedAcquisitionPublicProfileUrl,
  normalizeAcquisitionPublicUrl
} from "./acquisition-public-identity-resolver.js";

export type DouyinIdentityEvidenceClass =
  | "douyin_public_page"
  | "independent_search_result";

export type DouyinIdentityResolutionOutcome =
  | "verified_consensus"
  | "not_found"
  | "insufficient_evidence"
  | "ambiguous"
  | "conflicting"
  | "access_restricted"
  | "redirect_not_allowed"
  | "stale_candidate"
  | "provider_unavailable";

export type DouyinIdentityEvidenceAccessStatus =
  | "indexed_summary"
  | "public_content"
  | "access_restricted"
  | "redirect_not_allowed"
  | "provider_unavailable";

export interface DouyinIdentityEvidence {
  evidenceId: string;
  evidenceClass: DouyinIdentityEvidenceClass;
  publicProfileUrl: string;
  sourceUrl: string;
  sourceFingerprint: string;
  accessStatus: DouyinIdentityEvidenceAccessStatus;
  fetchedAt: string;
}

export interface DouyinIdentityConsensusDecision {
  outcome: DouyinIdentityResolutionOutcome;
  canonicalProfileUrl: string | null;
  profileCandidates: Array<{
    publicProfileUrl: string;
    evidenceIds: string[];
  }>;
}

function normalizedProfileUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    const normalized = normalizeAcquisitionPublicUrl(url.toString());
    return normalized
      && classifyDouyinPublicSource(normalized)?.sourceType === "profile"
      && isVerifiedAcquisitionPublicProfileUrl(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function decision(
  outcome: DouyinIdentityResolutionOutcome,
  profileCandidates: DouyinIdentityConsensusDecision["profileCandidates"],
  canonicalProfileUrl: string | null = null
): DouyinIdentityConsensusDecision {
  return { outcome, canonicalProfileUrl, profileCandidates };
}

export function decideDouyinIdentityConsensus(input: {
  expectedCandidateVersion: number;
  currentCandidateVersion: number;
  evidence: DouyinIdentityEvidence[];
}): DouyinIdentityConsensusDecision {
  if (input.expectedCandidateVersion !== input.currentCandidateVersion) {
    return decision("stale_candidate", []);
  }
  const accessOutcome = input.evidence.some((item) => item.accessStatus === "redirect_not_allowed")
    ? "redirect_not_allowed"
    : input.evidence.some((item) => item.accessStatus === "provider_unavailable")
      ? "provider_unavailable"
      : input.evidence.some((item) => item.accessStatus === "access_restricted")
        ? "access_restricted"
        : null;
  if (accessOutcome) return decision(accessOutcome, []);

  const accessible = input.evidence.flatMap((item) => {
    if (item.accessStatus !== "indexed_summary" && item.accessStatus !== "public_content") return [];
    const publicProfileUrl = normalizedProfileUrl(item.publicProfileUrl);
    const sourceFingerprint = item.sourceFingerprint.trim();
    return publicProfileUrl && sourceFingerprint
      ? [{ ...item, publicProfileUrl, sourceFingerprint }]
      : [];
  });
  const candidatesByUrl = new Map<string, typeof accessible>();
  for (const item of accessible) {
    const items = candidatesByUrl.get(item.publicProfileUrl) || [];
    items.push(item);
    candidatesByUrl.set(item.publicProfileUrl, items);
  }
  const profileCandidates = [...candidatesByUrl.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([publicProfileUrl, items]) => ({
      publicProfileUrl,
      evidenceIds: [...new Set(items.map((item) => item.evidenceId))].sort((left, right) =>
        left.localeCompare(right)
      )
    }));
  if (!profileCandidates.length) return decision("not_found", []);

  if (profileCandidates.length > 1) {
    const profilesByClass = new Map<DouyinIdentityEvidenceClass, Set<string>>();
    for (const item of accessible) {
      const profiles = profilesByClass.get(item.evidenceClass) || new Set<string>();
      profiles.add(item.publicProfileUrl);
      profilesByClass.set(item.evidenceClass, profiles);
    }
    const publicPageProfiles = profilesByClass.get("douyin_public_page") || new Set<string>();
    const searchProfiles = profilesByClass.get("independent_search_result") || new Set<string>();
    const classesDisagree = publicPageProfiles.size > 0
      && searchProfiles.size > 0
      && [...publicPageProfiles].some((profile) => !searchProfiles.has(profile));
    return decision(classesDisagree ? "conflicting" : "ambiguous", profileCandidates);
  }

  const [canonicalProfileUrl] = candidatesByUrl.keys();
  const evidence = candidatesByUrl.get(canonicalProfileUrl!)!;
  const publicFingerprints = new Set(evidence
    .filter((item) => item.evidenceClass === "douyin_public_page")
    .map((item) => item.sourceFingerprint));
  const searchFingerprints = new Set(evidence
    .filter((item) => item.evidenceClass === "independent_search_result")
    .map((item) => item.sourceFingerprint));
  if (!publicFingerprints.size || !searchFingerprints.size) {
    return decision("insufficient_evidence", profileCandidates);
  }
  const distinctSources = [...publicFingerprints].some((fingerprint) => !searchFingerprints.has(fingerprint));
  return distinctSources
    ? decision("verified_consensus", profileCandidates, canonicalProfileUrl!)
    : decision("insufficient_evidence", profileCandidates);
}
