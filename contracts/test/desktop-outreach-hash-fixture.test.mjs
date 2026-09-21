import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtureUrl = new URL("../fixtures/desktop-outreach-hashes.v1.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function exactKeys(value, keys, path) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${path} keys`);
}

function validateFixture(value) {
  exactKeys(value, ["version", "canonicalizerVersion", "vectors", "acceptedTargets",
    "rejectedTargets", "rejectedTimestamps"], "fixture");
  assert.equal(value.version, 1);
  assert.equal(value.canonicalizerVersion, "douyin-target-url-v1");
  assert.equal(value.vectors.length, 2);
  for (const [index, vector] of value.vectors.entries()) {
    exactKeys(vector, ["name", "rawTargetPublicUrl", "canonicalTargetPublicUrl", "request",
      "requestCanonicalJson", "requestHash", "receipt", "receiptCanonicalJson", "receiptHash"],
    `vectors[${index}]`);
    exactKeys(vector.request, ["account_handle", "action_id", "approved_content_hash",
      "canonical_target_public_url", "content", "kind", "login_state_version"],
    `vectors[${index}].request`);
    exactKeys(vector.receipt, ["action_id", "failure_code", "occurred_at",
      "platform_receipt_reference", "state"], `vectors[${index}].receipt`);
    assert.equal(JSON.stringify(vector.request), vector.requestCanonicalJson);
    assert.equal(JSON.stringify(vector.receipt), vector.receiptCanonicalJson);
    assert.match(vector.requestHash, /^[a-f0-9]{64}$/u);
    assert.match(vector.receiptHash, /^[a-f0-9]{64}$/u);
    assert.equal(hash(vector.requestCanonicalJson), vector.requestHash);
    assert.equal(hash(vector.receiptCanonicalJson), vector.receiptHash);
    assert.equal(vector.request.canonical_target_public_url,
      vector.canonicalTargetPublicUrl);
    assert.match(vector.receipt.occurred_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  }
  for (const [index, vector] of value.acceptedTargets.entries()) {
    exactKeys(vector, ["kind", "raw", "canonical"], `acceptedTargets[${index}]`);
  }
  for (const [index, vector] of value.rejectedTargets.entries()) {
    exactKeys(vector, ["kind", "raw", "reason"], `rejectedTargets[${index}]`);
  }
  assert.equal(value.rejectedTimestamps.every((item) => typeof item === "string"), true);
  return true;
}

test("desktop outreach fixture freezes exact canonical JSON and lowercase hashes", () => {
  assert.equal(validateFixture(fixture), true);
});

test("desktop outreach fixture decoder rejects protocol drift", () => {
  const mutate = (change) => {
    const value = structuredClone(fixture);
    change(value);
    return value;
  };
  assert.throws(() => validateFixture(mutate((value) => { value.extra = true; })), /keys/u);
  assert.throws(() => validateFixture(mutate((value) => {
    value.canonicalizerVersion = "douyin-target-url-v2";
  })));
  assert.throws(() => validateFixture(mutate((value) => {
    value.vectors[0].requestHash = value.vectors[0].requestHash.toUpperCase();
  })));
  assert.throws(() => validateFixture(mutate((value) => {
    value.vectors[0].requestCanonicalJson += " ";
  })));
});
