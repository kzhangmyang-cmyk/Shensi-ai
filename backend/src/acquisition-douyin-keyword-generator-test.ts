import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeDouyinKeywords, parseDouyinKeywordToolArguments } from "./acquisition-douyin-keyword-generator.js";

test("canonicalizes NFKC keywords, removes duplicates, and applies the public bounds", () => {
  assert.deepEqual(canonicalizeDouyinKeywords([
    " 工业除尘 ", "工业除尘", "ＦＡＣＴＯＲＹ", "factory", "", "a".repeat(101)
  ]), ["工业除尘", "FACTORY"]);
  assert.equal(canonicalizeDouyinKeywords(Array.from({ length: 21 }, (_, i) => `词${i}`)).length, 20);
});

test("fails closed on malformed keyword tool arguments before canonicalization", () => {
  for (const value of [
    null,
    { keywords: ["工厂获客"], extra: true },
    { keywords: ["工厂获客", 1] },
    { keywords: "工厂获客" },
    { keywords: [] }
  ]) {
    assert.throws(() => parseDouyinKeywordToolArguments(value), /OUTREACH_MODEL_RESPONSE_INVALID/u);
  }
  for (const value of [
    { keywords: ["合法词", "x".repeat(101)] },
    { keywords: ["合法词", "   "] },
    { keywords: ["合法词", "合法词"] }
  ]) {
    assert.throws(() => parseDouyinKeywordToolArguments(value), /OUTREACH_MODEL_RESPONSE_INVALID/u);
  }
  assert.deepEqual(parseDouyinKeywordToolArguments({ keywords: [" 工厂获客 "] }), ["工厂获客"]);
});
