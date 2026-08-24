import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeDouyinKeywords } from "./acquisition-douyin-keyword-generator.js";

test("canonicalizes NFKC keywords, removes duplicates, and applies the public bounds", () => {
  assert.deepEqual(canonicalizeDouyinKeywords([
    " 工业除尘 ", "工业除尘", "ＦＡＣＴＯＲＹ", "factory", "", "a".repeat(101)
  ]), ["工业除尘", "FACTORY"]);
  assert.equal(canonicalizeDouyinKeywords(Array.from({ length: 21 }, (_, i) => `词${i}`)).length, 20);
});
