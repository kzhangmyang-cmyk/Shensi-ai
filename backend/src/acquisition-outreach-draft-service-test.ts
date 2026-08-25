import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionOutreachDraftService, assertDraftableDouyinCandidate } from "./acquisition-outreach-draft-service.js";

function stableFinalAuthority() {
  return {
    async hasDoNotContact() { return false; },
    async verify(input: any) {
      return { candidate: input.expectedCandidate, evidence: input.expectedEvidence };
    }
  };
}

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
        id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: "needs_research", evidenceIds: ["evidence-1"],
        profile: { kind: "individual", sourcePlatform: "douyin", publicActorKey: "actor-1" }
      }; },
      async findEvidence() { return {
        id: "evidence-1", ownerId: "owner", teamId: "team", contentHash: `sha256:${"a".repeat(64)}`,
        sourceSnippet: "我今年17岁，想学习。现在需要获客方案", sourcePlatform: "douyin",
        provenance: { kind: "mediacrawler_public_record", sourceUrl: "https://www.douyin.com/video/7350000000000000001" }
      }; }
    } as any,
    finalAuthority: stableFinalAuthority(), async resolveSnapshot() { return { jobId: "snapshot-1" }; },
    async gateway() { return { async callTools() { gatewayCalls += 1; throw new Error("must not call"); } }; }
  });
  await assert.rejects(service.generate({
    scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" }, candidateId: "candidate-1"
  }), /OUTREACH_CANDIDATE_NOT_DRAFTABLE/u);
  assert.equal(gatewayCalls, 0);
});

test("natural-language minor and refusal evidence cannot reach the Task 6 model gateway", async () => {
  for (const sourceSnippet of ["17岁想学习，现在需要获客方案", "我今年十七岁，想学习", "不要联系我，我需要获客方案"]) {
    let gatewayCalls = 0;
    const service = new AcquisitionOutreachDraftService({
      domain: {
        async findCandidate() { return { id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: "needs_research", evidenceIds: ["evidence-1"], profile: { kind: "individual", sourcePlatform: "douyin", publicActorKey: "actor-1" } }; },
        async findEvidence() { return { id: "evidence-1", ownerId: "owner", teamId: "team", contentHash: `sha256:${"a".repeat(64)}`, sourceSnippet, sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record", sourceUrl: "https://www.douyin.com/video/7350000000000000001", jobId: "job-1", recordId: "record-1", upstreamCommit: "commit-1" } }; }
      } as any,
      finalAuthority: stableFinalAuthority(), async resolveSnapshot() { return { jobId: "snapshot-1" }; },
      async gateway() { return { async callTools() { gatewayCalls += 1; throw new Error("must not call"); } }; }
    });
    await assert.rejects(service.generate({ scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" }, candidateId: "candidate-1" }), /OUTREACH_CANDIDATE_NOT_DRAFTABLE/u);
    assert.equal(gatewayCalls, 0);
  }
});

test("rejects a candidate that becomes DNC after model traffic", async () => {
  let reads = 0;
  const service = new AcquisitionOutreachDraftService({
    domain: {
      async findCandidate() { reads += 1; return { id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: reads > 1 ? "do_not_contact" : "needs_research", evidenceIds: ["evidence-1"], profile: { kind: "individual", sourcePlatform: "douyin", publicActorKey: "actor-1" } }; },
      async findEvidence() { return { id: "evidence-1", ownerId: "owner", teamId: "team", contentHash: `sha256:${"a".repeat(64)}`, sourceSnippet: "公开提到正在寻找获客方案", sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record", sourceUrl: "https://www.douyin.com/video/7350000000000000001", jobId: "job-1", recordId: "record-1", upstreamCommit: "commit-1" } }; }
    } as any,
    finalAuthority: {
      async hasDoNotContact() { return false; },
      async verify() { throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED"); }
    }, async resolveSnapshot() { return { jobId: "snapshot-1" }; },
    async gateway() { return { async callTools() { return { toolCalls: [{ id: "call-1", name: "__goodjob_submit_douyin_outreach_draft", arguments: { comment: "看到你公开提到正在寻找获客方案", directMessage: "公开提到正在寻找获客方案", rationaleCodes: ["evidence_grounded"] } }], usage: {}, providerRequestId: null }; } }; }
  });
  await assert.rejects(service.generate({ scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" }, candidateId: "candidate-1" }), /OUTREACH_CANDIDATE_AUTHORITY_CHANGED/u);
});

test("rejects post-call DNC and exact evidence provenance changes", async () => {
  let dncChecks = 0; let evidenceReads = 0;
  const service = new AcquisitionOutreachDraftService({
    domain: {
      async findCandidate() { return { id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: "needs_research", evidenceIds: ["evidence-1"], profile: { kind: "individual", sourcePlatform: "douyin", publicActorKey: "actor-1" } }; },
      async findEvidence() { evidenceReads += 1; return { id: "evidence-1", ownerId: "owner", teamId: "team", contentHash: `sha256:${"a".repeat(64)}`, sourceSnippet: "公开提到正在寻找获客方案", sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record", sourceUrl: evidenceReads > 1 ? "https://www.douyin.com/video/changed" : "https://www.douyin.com/video/1", jobId: "job-1", recordId: "record-1", upstreamCommit: "commit-1" } }; }
    } as any,
    finalAuthority: {
      async hasDoNotContact() { dncChecks += 1; return dncChecks > 1; },
      async verify() { throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED"); }
    },
    async resolveSnapshot() { return { jobId: "snapshot-1" }; },
    async gateway() { return { async callTools() { return { toolCalls: [{ id: "call-1", name: "__goodjob_submit_douyin_outreach_draft", arguments: { comment: "看到你公开提到正在寻找获客方案", directMessage: "公开提到正在寻找获客方案", rationaleCodes: ["evidence_grounded"] } }], usage: {}, providerRequestId: null }; } }; }
  });
  await assert.rejects(service.generate({ scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" }, candidateId: "candidate-1" }), /OUTREACH_CANDIDATE_AUTHORITY_CHANGED/u);
});
