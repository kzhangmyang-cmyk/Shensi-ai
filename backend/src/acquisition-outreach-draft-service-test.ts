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

test("falls back to a validated evidence-grounded draft when the model prose is not grounded verbatim", async () => {
  let gatewayCalls = 0;
  const service = new AcquisitionOutreachDraftService({
    domain: {
      async findCandidate() {
        return {
          id: "candidate-1", ownerId: "owner", teamId: "team", version: 1,
          status: "needs_research", evidenceIds: ["evidence-1"],
          profile: {
            kind: "individual", sourcePlatform: "douyin",
            publicActorKey: "actor-1", publicDisplayName: "公开账号"
          }
        };
      },
      async findEvidence() {
        return {
          id: "evidence-1", ownerId: "owner", teamId: "team",
          contentHash: `sha256:${"a".repeat(64)}`,
          sourceSnippet: "无滤芯除尘？#涨知识",
          sourcePlatform: "douyin",
          provenance: {
            kind: "mediacrawler_public_record",
            actorKind: "creator",
            sourceUrl: "https://www.douyin.com/video/7350000000000000001",
            jobId: "job-1", recordId: "record-1", upstreamCommit: "commit-1"
          }
        };
      }
    } as any,
    finalAuthority: stableFinalAuthority(),
    async resolveSnapshot() { return { jobId: "snapshot-1" }; },
    async gateway() {
      return {
        async callTools() {
          gatewayCalls += 1;
          return {
            toolCalls: [{
              id: "call-1", name: "__goodjob_submit_douyin_outreach_draft",
              arguments: {
                comment: "您好，看到您分享的无滤芯除尘知识，很有启发",
                directMessage: "您好，想和您交流一下",
                rationaleCodes: ["evidence_grounded"]
              }
            }],
            usage: {}, providerRequestId: null
          };
        }
      };
    }
  });

  const draft = await service.generate({
    scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" },
    candidateId: "candidate-1"
  });

  assert.equal(gatewayCalls, 1);
  assert.equal(draft.comment, "看到你公开提到无滤芯除尘,方便的话");
  assert.equal(draft.directMessage, "你好,看到你提到无滤芯除尘,挺感兴趣的。方便的话,咱们简单聊两句呗。");
  assert.deepEqual(draft.rationaleCodes, ["evidence_grounded", "manual_review_required"]);
});

for (const scenario of [
  { keyword: "工业除尘", role: "creator", excerpt: "22千瓦离线脉冲除尘器", video: "车间里的除尘设备演示", text: "你好，你发的那台22千瓦除尘器挺有意思。方便的话，咱们聊聊呗。" },
  { keyword: "门店经营", role: "commenter", excerpt: "小店晚上人少怎么办", video: "街边小店的晚间经营分享", text: "你好，看到你留言说店里晚上人少，想听听你的想法。方便聊两句吗？" },
  { keyword: "", role: "unknown", excerpt: "公开内容", video: null, text: "你好，方便的话，咱们简单聊两句呗。" }
]) {
  for (const verdict of ["supported", "unsupported", "unavailable", "forged_evidence"] as const) {
    test(`contextual DM ${scenario.role} uses actual sources and handles ${verdict} grounding review`, async () => {
      const url = "https://www.douyin.com/video/7350000000000000001";
      const evidence = { id: "evidence-1", ownerId: "owner", teamId: "team", contentHash: `sha256:${"a".repeat(64)}`,
        sourceTitle: scenario.keyword, sourceSnippet: scenario.excerpt, sourcePlatform: "douyin",
        provenance: { kind: "mediacrawler_public_record", sourceUrl: url, jobId: "job-1", recordId: "record-1", actorKind: scenario.role, cursor: null, upstreamCommit: "commit-1" } };
      const requests: any[] = [];
      const service = new AcquisitionOutreachDraftService({
        domain: {
          async findCandidate() { return { id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: "needs_research", evidenceIds: [evidence.id],
            profile: { kind: "individual", sourcePlatform: "douyin", publicActorKey: "actor-1", publicDisplayName: "公开账号" } }; },
          async findEvidence() { return evidence; }
        } as any,
        crawlerJobs: {
          async findById(workspaceId: string, jobId: string) { assert.equal(workspaceId, "workspace"); assert.equal(jobId, "job-1"); return { workspaceId: scenario.video ? workspaceId : "other-workspace", id: jobId }; },
          async listRecords() { assert.ok(scenario.video, "must not load another workspace's records"); return [
            { recordId: "video-1", kind: "video", canonicalUrl: url, textExcerpt: scenario.video, contentHash: `sha256:${"b".repeat(64)}` },
            { recordId: "unrelated", kind: "video", canonicalUrl: "https://www.douyin.com/video/9999999999999999999", textExcerpt: "不相关视频不得引用" }
          ]; }
        } as any,
        finalAuthority: stableFinalAuthority(),
        async resolveSnapshot() { return { jobId: "snapshot-1" }; },
        async gateway() { return { async callTools(request: any) {
          requests.push(request);
          if (requests.length === 1) return { toolCalls: [{ id: "draft", name: "__goodjob_submit_douyin_outreach_draft", arguments: {
            comment: `看到你公开提到${scenario.excerpt}`, directMessage: scenario.text, rationaleCodes: ["evidence_grounded"]
          } }], usage: {}, providerRequestId: null };
          if (verdict === "unavailable") throw new Error("fixture model unavailable");
          return { toolCalls: [{ id: "review", name: "__goodjob_review_douyin_direct_message", arguments: {
            supported: verdict === "supported" || verdict === "forged_evidence",
            evidenceIds: [verdict === "forged_evidence" ? "another-candidates-evidence" : evidence.id]
          } }], usage: {}, providerRequestId: null };
        } }; }
      });
      const draft = await service.generate({ scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team", actorId: "actor" }, candidateId: "candidate-1" });
      assert.equal(draft.comment, `看到你公开提到${scenario.excerpt}`);
      assert.equal(requests.length, 2);
      const input = requests[0].contentBinding.dynamicData;
      assert.equal(input.evidence[0].searchKeyword, scenario.keyword);
      assert.equal(input.evidence[0].actorRole, scenario.role);
      assert.equal(input.evidence[0].excerpt, scenario.excerpt);
      assert.deepEqual(input.evidence[0].relatedVideos.map((item: any) => item.excerpt), scenario.video ? [scenario.video] : []);
      assert.equal(requests[1].contentBinding.dynamicData.directMessage, scenario.text.normalize("NFKC"));
      if (verdict === "supported") {
        assert.equal(draft.directMessage, scenario.text.normalize("NFKC"));
        assert.deepEqual(draft.rationaleCodes, ["evidence_grounded"]);
      } else {
        assert.equal(draft.directMessage, scenario.role === "unknown"
          ? "你好,方便的话,咱们简单聊两句呗。"
          : `你好,看到你提到${scenario.excerpt},挺感兴趣的。方便的话,咱们简单聊两句呗。`);
        assert.deepEqual(draft.rationaleCodes, ["evidence_grounded", "manual_review_required"]);
      }
    });
  }
}
