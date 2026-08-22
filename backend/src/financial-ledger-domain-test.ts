import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurrencyCode,
  assertMinorAmount,
  decimalMajorToMinor
} from "./growth-money.js";
import {
  costSourceIdentityRoot,
  financialSourceIdentityRoot,
  ledgerEntryNetMinor,
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";

const entry: AcquisitionCostEntry = {
  id: "cost-1", workspaceId: "workspace-1", platform: "douyin",
  planId: null, runId: "run-1", providerId: "baidu-ai-search",
  category: "api", amountMinor: 1234, currency: "CNY",
  occurredAt: "2026-08-09T00:00:00.000Z",
  provenance: "provider_reported", sourceRef: "invoice:88",
  evidenceHash: "sha256:evidence", externalId: "provider-row-88",
  sourceIdentityRoot: "provider-request:evidence-88", sourceVersion: 1,
  businessOccurredAt: "2026-08-09T00:00:00.000Z",
  recordedAt: "2026-08-09T00:01:00.000Z", temporalSequence: 1,
  correctsCostEntryId: null, correctionGroupId: null,
  estimateReconciliationId: null, createdBy: "finance-1"
};

const verified: LedgerVerificationEvent = {
  id: "verification-z", workspaceId: "workspace-1", ledgerType: "cost",
  ledgerEntryId: "cost-1", eventType: "verified", reversesEventId: null,
  eventSequence: 1, revision: 2,
  correctionGroupId: null, reason: "invoice checked", decidedBy: "finance-2",
  recordedAt: "2026-08-09T00:02:00.000Z", temporalSequence: 2
};

test("source identity and verification projection are deterministic", () => {
  assert.equal(costSourceIdentityRoot({
    kind: "provider_request", accountingEvidenceId: "evidence-88"
  }), "provider-request:evidence-88");
  assert.equal(ledgerEntryStatus([]), "pending");
  assert.equal(ledgerEntryStatus([verified]), "verified");
  assert.equal(ledgerEntryNetMinor(entry, [verified]), 1234);
  assert.equal(ledgerEntryNetMinor(entry, [verified, {
    ...verified, id: "verification-a", eventType: "reversed",
    reversesEventId: verified.id, eventSequence: 2, revision: 3,
    temporalSequence: 3
  }]), 0);
});

test("legacy equal-millisecond verify and reverse still decode by eventSequence", () => {
  const reversed: LedgerVerificationEvent = {
    ...verified, id: "verification-a", eventType: "reversed",
    reversesEventId: verified.id, eventSequence: 2, revision: 3,
    recordedAt: verified.recordedAt, temporalSequence: 3
  };
  assert.equal(ledgerEntryStatus([reversed, verified]), "reversed");
});

test("a source identity rejects empty external keys", () => {
  assert.throws(
    () => costSourceIdentityRoot({
      kind: "external", sourceSystem: "portal", externalId: ""
    }),
    /source_identity_invalid/
  );
});

test("CNY decimal major units convert exactly to minor units", () => {
  assert.equal(decimalMajorToMinor("12.34", "CNY"), 1234);
});

test("financial source identities reject an unknown runtime fact type", () => {
  assert.throws(() => financialSourceIdentityRoot({
    kind: "external",
    sourceSystem: "bank",
    factType: "not-a-fact" as never,
    externalId: "row-1"
  }), /source_identity_invalid/);
});

test("verification projection rejects a malformed append timestamp", () => {
  assert.throws(
    () => ledgerEntryStatus([{ ...verified, recordedAt: "yesterday" }]),
    /ledger_event_sequence_invalid/
  );
});

test("currency exponents convert without floating point and reject extra precision", () => {
  assert.equal(decimalMajorToMinor("12", "JPY"), 12);
  assert.equal(decimalMajorToMinor("12.345", "KWD"), 12345);
  assert.throws(
    () => decimalMajorToMinor("12.345", "CNY"),
    /decimal amount/
  );
  assert.throws(() => decimalMajorToMinor("-1", "CNY"), /decimal amount/);
});

test("currency and minor amounts use closed safe-integer validation", () => {
  assert.equal(assertCurrencyCode("CNY"), "CNY");
  assert.equal(
    assertMinorAmount(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER
  );
  assert.throws(() => assertCurrencyCode("cny"), /currency/);
  assert.throws(() => assertCurrencyCode("ZZZ"), /currency/);
  assert.throws(() => assertMinorAmount(-1), /amountMinor/);
  assert.throws(
    () => assertMinorAmount(Number.MAX_SAFE_INTEGER + 1),
    /amountMinor/
  );
  assert.throws(
    () => decimalMajorToMinor("90071992547409.92", "CNY"),
    /decimal amount/
  );
});

test("financial import identities include the closed fact classification", () => {
  assert.equal(financialSourceIdentityRoot({
    kind: "import_row",
    fileHash: "sha256:file",
    sheetName: "收入😀",
    rowNumber: 7,
    factType: "revenue_recognized"
  }), "import:sha256:file:收入😀:7:revenue_recognized");
  assert.throws(() => costSourceIdentityRoot({
    kind: "import_row",
    fileHash: "sha256:file",
    sheetName: "收入",
    rowNumber: 0
  }), /source_identity_invalid/);
});

test("verification projection rejects illegal append-only event chains", () => {
  const reversal: LedgerVerificationEvent = {
    ...verified,
    id: "verification-reversal",
    eventType: "reversed",
    reversesEventId: verified.id,
    eventSequence: 2,
    revision: 3,
    recordedAt: "2026-08-09T00:03:00.000Z",
    temporalSequence: 3
  };
  assert.throws(
    () => ledgerEntryStatus([reversal]),
    /ledger_event_sequence_invalid/
  );
  assert.throws(() => ledgerEntryStatus([
    verified,
    { ...reversal, reversesEventId: "verification-other" }
  ]), /ledger_event_sequence_invalid/);
  assert.throws(() => ledgerEntryStatus([
    verified,
    { ...reversal, ledgerType: "financial" }
  ]), /ledger_event_sequence_invalid/);
  assert.equal(ledgerEntryStatus([{ ...verified, eventType: "rejected" }]), "rejected");
});

test("ledger net amount rejects unsafe or negative original money", () => {
  assert.throws(
    () => ledgerEntryNetMinor({ amountMinor: -1 }, [verified]),
    /amountMinor/
  );
  assert.throws(
    () => ledgerEntryNetMinor(
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      [verified]
    ),
    /amountMinor/
  );
});
