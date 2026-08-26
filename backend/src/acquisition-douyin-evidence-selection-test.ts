import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryEvidence } from "./acquisition-domain.js";
import {
  orderedCandidateEvidenceIds,
  selectDouyinCandidateEvidence
} from "./acquisition-douyin-evidence-selection.js";

function evidence(input: {
  id: string;
  sourceUrl: string;
  snippet?: string;
}): DiscoveryEvidence {
  return {
    id: input.id,
    ownerId: "owner-evidence-selection",
    teamId: "team-evidence-selection",
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "公开抖音证据",
    sourceSnippet: input.snippet ?? "公开提到采购需求",
    publishedAt: "2026-08-26T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "mediacrawler_public_record",
      sourceUrl: input.sourceUrl,
      jobId: "crawler-job-evidence-selection",
      recordId: input.id,
      actorKind: "creator",
      cursor: null,
      upstreamCommit: "commit-evidence-selection"
    },
    accessStatus: "public_content",
    supersedesEvidenceId: null,
    fetchedAt: "2026-08-26T00:00:00.000Z"
  };
}

test("Douyin candidate evidence prefers the exact commentable video over an earlier profile", () => {
  const profile = evidence({
    id: "evidence-z-profile",
    sourceUrl: "https://www.douyin.com/user/MS4wLjABCreator",
    snippet: "公开主页"
  });
  const video = evidence({
    id: "evidence-a-video",
    sourceUrl: "https://www.douyin.com/video/7350000000000000001",
    snippet: "公开需求视频"
  });

  assert.equal(
    selectDouyinCandidateEvidence([profile, video], { requireVideo: false }),
    video
  );
  assert.equal(
    selectDouyinCandidateEvidence([profile, video], { requireVideo: true }),
    video
  );
  assert.deepEqual(
    orderedCandidateEvidenceIds({ evidenceIds: [profile.id, video.id] }),
    [video.id, profile.id]
  );
});

test("profile-only evidence remains inspectable but cannot become a comment target", () => {
  const profile = evidence({
    id: "evidence-profile-only",
    sourceUrl: "https://www.douyin.com/user/MS4wLjABCreator"
  });

  assert.equal(
    selectDouyinCandidateEvidence([profile], { requireVideo: false }),
    profile
  );
  assert.equal(
    selectDouyinCandidateEvidence([profile], { requireVideo: true }),
    null
  );
});

test("mixed and malformed evidence selects the same exact video regardless of input order", () => {
  const malformed = evidence({
    id: "evidence-malformed",
    sourceUrl: "https://www.douyin.com/video/7350000000000000000?share=1"
  });
  const laterVideo = evidence({
    id: "evidence-video-z",
    sourceUrl: "https://www.douyin.com/video/7350000000000000002"
  });
  const exactVideo = evidence({
    id: "evidence-video-a",
    sourceUrl: "https://www.douyin.com/video/7350000000000000001"
  });
  const profile = evidence({
    id: "evidence-profile",
    sourceUrl: "https://www.douyin.com/user/MS4wLjABCreator"
  });
  const first = [laterVideo, malformed, profile, exactVideo];
  const second = [...first].reverse();

  assert.equal(
    selectDouyinCandidateEvidence(first, { requireVideo: true })?.id,
    exactVideo.id
  );
  assert.equal(
    selectDouyinCandidateEvidence(second, { requireVideo: true })?.id,
    exactVideo.id
  );
});

test("profile-only selection ignores non-canonical variants and is deterministic", () => {
  const profileZ = evidence({
    id: "evidence-profile-z",
    sourceUrl: "https://www.douyin.com/user/Z_profile"
  });
  const profileA = evidence({
    id: "evidence-profile-a",
    sourceUrl: "https://www.douyin.com/user/A_profile"
  });
  const queryVariant = evidence({
    id: "evidence-profile-query",
    sourceUrl: "https://www.douyin.com/user/A_profile?from=video"
  });

  assert.equal(
    selectDouyinCandidateEvidence(
      [profileZ, queryVariant, profileA],
      { requireVideo: false }
    )?.id,
    profileA.id
  );
  assert.equal(
    selectDouyinCandidateEvidence(
      [profileA, queryVariant, profileZ],
      { requireVideo: false }
    )?.id,
    profileA.id
  );
});
