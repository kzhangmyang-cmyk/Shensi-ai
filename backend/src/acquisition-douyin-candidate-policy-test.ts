import assert from "node:assert/strict";
import test from "node:test";
import {
  qualifyDouyinCrawlerCandidate
} from "./acquisition-douyin-candidate-policy.js";

test("policy admits explicit public demand at an allowed buying stage", () => {
  const result = qualifyDouyinCrawlerCandidate({
    text: "门店正在寻找获客方案，想咨询具体做法。",
    hasOriginalPublicSource: true
  });
  assert.equal(result.status, "qualified");
  assert.equal(result.buyingStage, "solution_research");
});

test("policy fails closed for refusals, complaints, minors, and missing sources", () => {
  for (const input of [
    { text: "请勿联系，勿扰", hasOriginalPublicSource: true },
    { text: "你们骗人，投诉到底", hasOriginalPublicSource: true },
    { text: "我是初中生，想了解一下", hasOriginalPublicSource: true },
    { text: "正在采购获客方案", hasOriginalPublicSource: false }
  ]) {
    const result = qualifyDouyinCrawlerCandidate(input);
    assert.equal(result.status, "suppressed");
    assert.ok(result.reason);
    assert.equal(result.retainDoNotContact, true);
  }
});

test("parses complete Arabic and Chinese age tokens without adult or version false positives", () => {
  for (const text of ["不满18岁，需要获客方案", "十七岁想学习", "拒绝联系我"]) {
    assert.equal(qualifyDouyinCrawlerCandidate({ text, hasOriginalPublicSource: true }).status, "suppressed");
  }
  for (const text of ["二十岁需要获客方案", "二十八岁需要获客方案", "三十七岁需要获客方案", "2017岁末版本需要获客方案"]) {
    assert.equal(qualifyDouyinCrawlerCandidate({ text, hasOriginalPublicSource: true }).status, "qualified", text);
  }
});

test("creator discovery and demand comments use separate admission policies", () => {
  assert.equal(qualifyDouyinCrawlerCandidate({
    text: "工业除尘设备厂家",
    kind: "creator",
    hasOriginalPublicSource: true
  }).status, "qualified");
  assert.deepEqual(qualifyDouyinCrawlerCandidate({
    text: "工业除尘设备厂家",
    kind: "comment",
    hasOriginalPublicSource: true
  }), {
    status: "suppressed",
    buyingStage: null,
    reason: "buying_stage_not_allowed",
    retainDoNotContact: false
  });
});
