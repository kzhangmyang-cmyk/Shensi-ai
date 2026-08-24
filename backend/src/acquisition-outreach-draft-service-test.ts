import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionOutreachDraftService, assertDraftableDouyinCandidate } from "./acquisition-outreach-draft-service.js";

test("refuses forged, DNC, refusal, and minor candidate evidence before any model call", () => {
  assert.throws(() => assertDraftableDouyinCandidate({
    id: "candidate-1", version: 1, status: "do_not_contact", evidence: []
  }), /OUTREACH_CANDIDATE_NOT_DRAFTABLE/u);
  assert.throws(() => assertDraftableDouyinCandidate({
    id: "candidate-1", version: 1, status: "needs_research",
    evidence: [{ id: "evidence-1", contentHash: "sha256:x", text: "我今年17岁，想学习。现在需要获客方案" }]
  }), /OUTREACH_CANDIDATE_NOT_DRAFTABLE/u);
});

test("minor evidence cannot reach the Task 6 model gateway", async () => {
  let gatewayCalls = 0;
  const service = new AcquisitionOutreachDraftService({
    domain: {
      async findCandidate() { return {
        id: "candidate-1", version: 1, status: "needs_research", evidenceIds: ["evidence-1"],
        profile: { kind: "individual", sourcePlatform: "douyin" }
      }; },
      async findEvidence() { return {
        id: "evidence-1", contentHash: `sha256:${"a".repeat(64)}`,
        sourceSnippet: "我今年17岁，想学习。现在需要获客方案", sourcePlatform: "douyin",
        provenance: { kind: "mediacrawler_public_record", sourceUrl: "https://www.douyin.com/video/7350000000000000001" }
      }; }
    } as any,
    async resolveSnapshot() { return { jobId: "snapshot-1" }; },
    async gateway() { return { async callTools() { gatewayCalls += 1; throw new Error("must not call"); } }; }
  });
  await assert.rejects(service.generate({
    scope: { ownerId: "owner", teamId: "team" }, candidateId: "candidate-1"
  }), /OUTREACH_CANDIDATE_NOT_DRAFTABLE/u);
  assert.equal(gatewayCalls, 0);
});
