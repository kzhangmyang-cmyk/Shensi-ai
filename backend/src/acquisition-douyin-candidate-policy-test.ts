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
  }
});
