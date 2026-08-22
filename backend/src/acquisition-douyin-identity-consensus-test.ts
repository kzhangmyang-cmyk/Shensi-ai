import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideDouyinIdentityConsensus,
  type DouyinIdentityEvidence
} from "./acquisition-douyin-identity-consensus.js";

function evidence(
  evidenceClass: DouyinIdentityEvidence["evidenceClass"],
  publicProfileUrl: string,
  sourceFingerprint: string,
  accessStatus: DouyinIdentityEvidence["accessStatus"] = "public_content"
): DouyinIdentityEvidence {
  return {
    evidenceId: `${evidenceClass}-${sourceFingerprint}`,
    evidenceClass,
    publicProfileUrl,
    sourceUrl: publicProfileUrl,
    sourceFingerprint,
    accessStatus,
    fetchedAt: "2026-08-08T00:00:00.000Z"
  };
}

function publicPageEvidence(url: string, fingerprint: string) {
  return evidence("douyin_public_page", url, fingerprint);
}

function searchEvidence(url: string, fingerprint: string) {
  return evidence("independent_search_result", url, fingerprint, "indexed_summary");
}

test("consensus verifies one profile supported by distinct public-page and search evidence", () => {
  const verified = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor", "page-fingerprint"),
      searchEvidence("https://www.douyin.com/user/actor", "search-fingerprint")
    ]
  });

  assert.equal(verified.outcome, "verified_consensus");
  assert.equal(verified.canonicalProfileUrl, "https://www.douyin.com/user/actor");
});

test("consensus requires both evidence classes with distinct source fingerprints", () => {
  const oneClass = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [publicPageEvidence("https://www.douyin.com/user/actor", "page")]
  });
  const repeatedFingerprint = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor", "same-source"),
      searchEvidence("https://www.douyin.com/user/actor", "same-source")
    ]
  });

  assert.equal(oneClass.outcome, "insufficient_evidence");
  assert.equal(repeatedFingerprint.outcome, "insufficient_evidence");
});

test("consensus distinguishes ambiguous same-class profiles from conflicting classes", () => {
  const ambiguous = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor-a", "page-a"),
      publicPageEvidence("https://www.douyin.com/user/actor-b", "page-b")
    ]
  });
  const conflicting = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor-a", "page-a"),
      searchEvidence("https://www.douyin.com/user/actor-b", "search-b")
    ]
  });

  assert.equal(ambiguous.outcome, "ambiguous");
  assert.equal(conflicting.outcome, "conflicting");
});

test("consensus closes on restricted evidence before accepting an identity", () => {
  const restricted = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 3,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor", "page"),
      searchEvidence("https://www.douyin.com/user/actor", "search"),
      evidence("douyin_public_page", "https://www.douyin.com/user/actor", "blocked", "access_restricted")
    ]
  });

  assert.equal(restricted.outcome, "access_restricted");
});

test("consensus rejects a stale candidate before evaluating evidence", () => {
  const stale = decideDouyinIdentityConsensus({
    expectedCandidateVersion: 3,
    currentCandidateVersion: 4,
    evidence: [
      publicPageEvidence("https://www.douyin.com/user/actor", "page"),
      searchEvidence("https://www.douyin.com/user/actor", "search")
    ]
  });

  assert.equal(stale.outcome, "stale_candidate");
  assert.equal(stale.canonicalProfileUrl, null);
});
