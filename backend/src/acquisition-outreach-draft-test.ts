import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidatedAcquisitionOutreachFallback,
  validateAcquisitionOutreachDraft,
  validateManualAcquisitionOutreachDraft
} from "./acquisition-outreach-draft.js";

const base = {
  candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
  comment: "看到你公开提到正在寻找获客方案，祝进展顺利。",
  directMessage: "看到你公开提到正在寻找获客方案；如愿意，可交流公开场景里的思路。",
  rationaleCodes: ["evidence_grounded"], modelSnapshotId: "snapshot-1"
};

test("manual prose permits short wording but retains authority and safety validation", () => {
  const authority = { candidateId: base.candidateId, candidateRevision: base.candidateRevision,
    evidenceHashes: [...base.evidenceHashes], evidenceText: ["正在寻找获客方案"], modelSnapshotId: base.modelSnapshotId };
  for (const comment of ["聊聊?", "方便的话聊聊？", "你好"]) {
    assert.equal(validateManualAcquisitionOutreachDraft({ ...base, comment }, authority).comment, comment.normalize("NFKC"));
    assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment }, authority), /OUTREACH_DRAFT_INVALID/u);
  }
  for (const comment of ["", "字".repeat(301), "https://example.com", "电话13800138000", "保证成交", "你好\n聊聊"]) {
    assert.throws(() => validateManualAcquisitionOutreachDraft({ ...base, comment }, authority), /OUTREACH_MANUAL_DRAFT_INVALID/u);
  }
  assert.throws(() => validateManualAcquisitionOutreachDraft({ ...base, candidateRevision: 99 }, authority), /OUTREACH_MANUAL_DRAFT_INVALID/u);
});

test("rejects unsafe, unsupported, multiline, and forged draft fields while hashing server values", () => {
  const accepted = validateAcquisitionOutreachDraft(base, {
    candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["公开提到正在寻找获客方案"], modelSnapshotId: "snapshot-1"
  });
  assert.equal(accepted.contentHash.startsWith("sha256:"), true);
  for (const comment of ["", "请访问 https://bad.example", "访问 example.com", "访问 example.dev", "访问 xn--fsqu00a.xn--55qx5d", "访问 例子.公司", "访问 例子。公司", "访问 例子．公司", "访问 例子｡公司", "联系电话 13800138000", "第一名保证成交", "第一行\n第二行", "第一行\u0085第二行", "加\u200b微信", "保证\u200b成交", "保证\u202e成交", "转化率100%", "我们已经服务了上万客户", "贵司年营收过亿", "贵司销量全球第一", "恭喜入选高新技术企业", "贵公司成立于2010年"]) {
    assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment }, {
      candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
      evidenceText: ["公开提到正在寻找获客方案"], modelSnapshotId: "snapshot-1"
    }), /OUTREACH_DRAFT_INVALID/u);
  }
});

test("grounds every non-template phrase in one approved evidence row and closes rationale codes", () => {
  assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment: "贵司年营收过亿", rationaleCodes: ["invented"] }, {
    candidateId: "candidate-1", candidateRevision: 2, evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["贵司年营收", "过亿"], modelSnapshotId: "snapshot-1"
  }), /OUTREACH_DRAFT_INVALID/u);
  assert.throws(() => validateAcquisitionOutreachDraft({
    ...base,
    comment: "贵公司成立于2010年"
  }, {
    candidateId: "candidate-1", candidateRevision: 2,
    evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["贵公司成立于", "2010年"],
    modelSnapshotId: "snapshot-1"
  }), /OUTREACH_DRAFT_INVALID/u);
  assert.doesNotThrow(() => validateAcquisitionOutreachDraft({
    ...base,
    comment: "看到你公开提到贵公司成立于2010年，祝进展顺利。"
  }, {
    candidateId: "candidate-1", candidateRevision: 2,
    evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["公开资料显示贵公司成立于2010年，正在寻找获客方案"],
    modelSnapshotId: "snapshot-1"
  }));
});

test("allows grounded dotted product and technology names without public TLDs", () => {
  for (const product of ["Node.js", "Qwen.VL"]) {
    assert.doesNotThrow(() => validateAcquisitionOutreachDraft({
      ...base,
      comment: `看到你公开提到正在评估${product}方案，祝进展顺利。`,
      directMessage:
        `看到你公开提到正在评估${product}方案；如愿意，可交流公开场景里的思路。`
    }, {
      candidateId: "candidate-1", candidateRevision: 2,
      evidenceHashes: [`sha256:${"a".repeat(64)}`],
      evidenceText: [`公开提到正在评估${product}方案`],
      modelSnapshotId: "snapshot-1"
    }), product);
  }
});

test("rejects recognized registry domains and protocol-obfuscated URLs", () => {
  for (const comment of [
    "访问 example.dev",
    "访问 例子。公司",
    "访问 xn--fsqu00a.xn--55qx5d",
    "访问 h\u200bttps://example.dev",
    "访问 ｗｗｗ。example.dev"
  ]) {
    assert.throws(() => validateAcquisitionOutreachDraft({
      ...base,
      comment
    }, {
      candidateId: "candidate-1", candidateRevision: 2,
      evidenceHashes: [`sha256:${"a".repeat(64)}`],
      evidenceText: [comment], modelSnapshotId: "snapshot-1"
    }), /OUTREACH_DRAFT_INVALID/u, comment);
  }
});

test("server fallback skips unsafe evidence segments and still fails closed without a safe segment", () => {
  const authority = {
    candidateId: "candidate-1", candidateRevision: 2,
    evidenceHashes: [`sha256:${"a".repeat(64)}`],
    evidenceText: ["请访问 example.com；正在调研工业除尘方案"],
    modelSnapshotId: "snapshot-1"
  };
  const accepted = buildValidatedAcquisitionOutreachFallback(authority);
  assert.equal(accepted.comment, "看到你公开提到正在调研工业除尘方案,方便的话");
  assert.equal(accepted.directMessage, "你好,看到你提到正在调研工业除尘方案,挺感兴趣的。方便的话,咱们简单聊两句呗。");
  assert.equal(buildValidatedAcquisitionOutreachFallback({ ...authority, evidenceAttributionKnown: false }).directMessage,
    "你好,方便的话,咱们简单聊两句呗。");
  assert.deepEqual(accepted.rationaleCodes, ["evidence_grounded", "manual_review_required"]);

  assert.throws(() => buildValidatedAcquisitionOutreachFallback({
    ...authority,
    evidenceText: ["请访问 example.com"]
  }), /OUTREACH_DRAFT_INVALID/u);
});

test("natural DM language is structurally valid without relaxing comments or unsafe-content checks", () => {
  const authority = { ...base, evidenceText: ["正在寻找获客方案"] };
  const directMessage = "你好，看你在聊怎么找客户，我也挺感兴趣的。方便的话，咱们聊两句呗。";
  assert.equal(validateAcquisitionOutreachDraft({ ...base, directMessage }, authority).directMessage,
    directMessage.normalize("NFKC"));
  assert.throws(() => validateAcquisitionOutreachDraft({ ...base, comment: directMessage }, authority), /OUTREACH_DRAFT_INVALID/u);
  for (const unsafe of ["加微信聊", "访问 example.com", "保证成交", "13800138000", "你好\n聊聊"]) {
    assert.throws(() => validateAcquisitionOutreachDraft({ ...base, directMessage: unsafe }, authority), /OUTREACH_DRAFT_INVALID/u);
  }
});
