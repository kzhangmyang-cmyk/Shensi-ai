import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalizeDouyinOutreachTargetUrl,
  desktopOutreachReceiptHash,
  desktopOutreachRequestHash,
  validateCanonicalDesktopOutreachTimestamp
} from "./acquisition-outreach-target-url.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../contracts/fixtures/desktop-outreach-hashes.v1.json", import.meta.url
), "utf8"));

test("canonical target vectors preserve ordered query bytes and normalize only locked forms", () => {
  for (const vector of fixture.acceptedTargets) {
    assert.equal(canonicalizeDouyinOutreachTargetUrl(vector.kind, vector.raw), vector.canonical);
    assert.equal(canonicalizeDouyinOutreachTargetUrl(vector.kind, vector.canonical),
      vector.canonical);
  }
  for (const vector of fixture.vectors) {
    assert.equal(canonicalizeDouyinOutreachTargetUrl(vector.request.kind,
      vector.rawTargetPublicUrl), vector.canonicalTargetPublicUrl);
  }
});

test("canonical target vectors reject ambiguous and cross-kind URLs", () => {
  for (const vector of fixture.rejectedTargets) {
    assert.throws(() => canonicalizeDouyinOutreachTargetUrl(vector.kind, vector.raw),
      /douyin_target_url_invalid/u, `${vector.reason}: ${JSON.stringify(vector.raw)}`);
  }
});

test("request and receipt hashes match the shared Unicode vectors", () => {
  for (const vector of fixture.vectors) {
    assert.deepEqual(desktopOutreachRequestHash(vector.request), {
      canonicalJson: vector.requestCanonicalJson,
      hash: vector.requestHash
    });
    assert.deepEqual(desktopOutreachReceiptHash(vector.receipt), {
      canonicalJson: vector.receiptCanonicalJson,
      hash: vector.receiptHash
    });
  }
});

test("signed timestamps require UTC Z with exactly three fractional digits", () => {
  for (const vector of fixture.vectors) {
    assert.equal(validateCanonicalDesktopOutreachTimestamp(vector.receipt.occurred_at),
      vector.receipt.occurred_at);
  }
  for (const value of fixture.rejectedTimestamps) {
    assert.throws(() => validateCanonicalDesktopOutreachTimestamp(value),
      /desktop_outreach_timestamp_invalid/u);
  }
});
