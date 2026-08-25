import assert from "node:assert/strict";
import test from "node:test";
import { validateAcquisitionOutreachDraft } from "./acquisition-outreach-draft.js";

const base = {
  candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
  comment: "看到你公开提到正在寻找获客方案，祝进展顺利。",
  directMessage: "看到你公开提到正在寻找获客方案；如愿意，可交流公开场景里的思路。",
  rationaleCodes: ["evidence_grounded"], modelSnapshotId: "snapshot-1"
};

test("rejects unsafe, unsupported, multiline, and forged draft fields while hashing server values", () => {
  const accepted = validateAcquisitionOutreachDraft(base, {
    candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["公开提到正在寻找获客方案"], modelSnapshotId: "snapshot-1"
  });
  assert.equal(accepted.contentHash.startsWith("sha256:"), true);
  for (const comment of ["", "请访问 https://bad.example", "访问 example.com", "访问 example.dev", "访问 xn--fsqu00a.xn--55qx5d", "访问 例子.公司", "联系电话 13800138000", "第一名保证成交", "第一行\n第二行", "第一行\u0085第二行", "加\u200b微信", "保证\u200b成交", "保证\u202e成交", "转化率100%", "我们已经服务了上万客户", "贵司年营收过亿", "贵司销量全球第一", "恭喜入选高新技术企业"]) {
    assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment }, {
      candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
      evidenceText: ["公开提到正在寻找获客方案"], modelSnapshotId: "snapshot-1"
    }), /OUTREACH_DRAFT_INVALID/u);
  }
});

test("grounds a factual phrase in one approved evidence row and closes rationale codes", () => {
  assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment: "贵司年营收过亿", rationaleCodes: ["invented"] }, {
    candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["贵司年营收", "过亿"], modelSnapshotId: "snapshot-1"
  }), /OUTREACH_DRAFT_INVALID/u);
});
