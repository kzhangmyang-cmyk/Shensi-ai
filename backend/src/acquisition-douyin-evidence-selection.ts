import type {
  AcquisitionCandidate,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import {
  discoveryEvidencePublicSourceUrl
} from "./acquisition-domain.js";
import { validOutreachTarget } from "./acquisition-outreach-batch.js";

export function orderedCandidateEvidenceIds(
  candidate: Pick<AcquisitionCandidate, "evidenceIds">
) {
  return [...candidate.evidenceIds].sort();
}

export function selectDouyinCandidateEvidence(
  evidence: readonly DiscoveryEvidence[],
  options: { requireVideo: boolean }
): DiscoveryEvidence | null {
  const publicEvidence = evidence.filter((item) => {
    if (item.sourcePlatform !== "douyin") return false;
    const sourceUrl = discoveryEvidencePublicSourceUrl(item);
    return sourceUrl !== null
      && (validOutreachTarget("comment", sourceUrl)
        || validOutreachTarget("direct_message", sourceUrl));
  }).sort((left, right) => {
    const leftUrl = discoveryEvidencePublicSourceUrl(left)!;
    const rightUrl = discoveryEvidencePublicSourceUrl(right)!;
    if (leftUrl < rightUrl) return -1;
    if (leftUrl > rightUrl) return 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const videoEvidence = publicEvidence.find((item) => {
    const sourceUrl = discoveryEvidencePublicSourceUrl(item);
    return sourceUrl !== null
      && validOutreachTarget("comment", sourceUrl);
  });
  return videoEvidence ?? (options.requireVideo
    ? null
    : publicEvidence[0] ?? null);
}
