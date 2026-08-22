import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ISO_4217_EXPONENT_V1,
  ISO_4217_EXPONENT_V1_CUTOFF,
  ceilDiv,
  currencyExponent,
  multiplyQuantityMinor,
  roundHalfUpDiv,
  roundSignedHalfUpDiv,
  safeMinor,
  safeSignedInteger
} from "./growth-money.js";

const ACTIVE_EXPONENTS_AT_AMENDMENT_180 = Object.freeze({
  0: [
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
    "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"
  ],
  2: [
    "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN",
    "BAM", "BBD", "BDT", "BMD", "BND", "BOB", "BOV", "BRL", "BSD",
    "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW",
    "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DKK", "DOP",
    "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL",
    "GHS", "GIP", "GMD", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF",
    "IDR", "ILS", "INR", "IRR", "JMD", "KES", "KGS", "KHR", "KPW",
    "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL",
    "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK",
    "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
    "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR", "RON",
    "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP",
    "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
    "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "USD",
    "USN", "UYU", "UZS", "VED", "VES", "WST", "XAD", "XCD", "XCG",
    "YER", "ZAR", "ZMW", "ZWG"
  ],
  3: ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"],
  4: ["CLF", "UYW"]
} as const);

test("V1 registry exactly matches active numeric exponents at SIX amendment 180", () => {
  assert.deepEqual(ISO_4217_EXPONENT_V1_CUTOFF, {
    authority: "SIX Financial Information AG",
    amendment: 180,
    effectiveDate: "2026-01-01"
  });
  const expected = Object.fromEntries(
    Object.entries(ACTIVE_EXPONENTS_AT_AMENDMENT_180).flatMap(
      ([exponent, codes]) => codes.map((code) => [code, Number(exponent)])
    )
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(ISO_4217_EXPONENT_V1).sort()),
    Object.fromEntries(Object.entries(expected).sort())
  );
  assert.equal(currencyExponent("XCG"), 2);
  assert.equal(currencyExponent("XAD"), 2);
  assert.equal(currencyExponent("ANG"), null);
  assert.equal(currencyExponent("BGN"), null);
  assert.equal(Object.isFrozen(ISO_4217_EXPONENT_V1), true);
  assert.equal(Object.isFrozen(ISO_4217_EXPONENT_V1_CUTOFF), true);
});

test("fixed-point money and ISO exponents are deterministic", () => {
  assert.equal(currencyExponent("JPY"), 0);
  assert.equal(currencyExponent("CNY"), 2);
  assert.equal(currencyExponent("KWD"), 3);
  assert.equal(currencyExponent("RMB"), null);
  assert.equal(currencyExponent("cny"), null);
  assert.equal(multiplyQuantityMinor(333, 1_500_000, "half_up"), 500);
  assert.equal(multiplyQuantityMinor(1, 1, "ceil"), 1);
  assert.equal(roundHalfUpDiv(5n, 2n), 3n);
  assert.equal(roundSignedHalfUpDiv(1n, 2n), 1n);
  assert.equal(roundSignedHalfUpDiv(-1n, 2n), -1n);
  assert.equal(roundSignedHalfUpDiv(5n, 2n), 3n);
  assert.equal(roundSignedHalfUpDiv(-5n, 2n), -3n);
  assert.equal(roundSignedHalfUpDiv(-4n, 3n), -1n);
  assert.equal(safeSignedInteger(-30_000n, "roiBps"), -30_000);
  assert.equal(ceilDiv(1n, 1_000_000n), 1n);
  assert.throws(
    () => safeMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "amount"),
    (error: unknown) => (error as { code?: string }).code
      === "amount_out_of_range"
  );
});

test("money helpers reject unsafe, negative, fractional, and invalid ratio inputs", () => {
  assert.throws(() => safeMinor(-1n, "amount"), { code: "amount_out_of_range" });
  assert.throws(
    () => safeSignedInteger(BigInt(Number.MIN_SAFE_INTEGER) - 1n, "ratio"),
    { code: "amount_out_of_range" }
  );
  assert.throws(() => roundHalfUpDiv(-1n, 2n), /invalid ratio/u);
  assert.throws(() => roundHalfUpDiv(1n, 0n), /invalid ratio/u);
  assert.throws(() => ceilDiv(-1n, 2n), /invalid ratio/u);
  assert.throws(() => roundSignedHalfUpDiv(1n, 0n), /invalid ratio/u);
  assert.throws(
    () => multiplyQuantityMinor(-1, 1, "half_up"),
    { code: "unit_minor_out_of_range" }
  );
  assert.throws(
    () => multiplyQuantityMinor(1, -1, "half_up"),
    { code: "quantity_micros_out_of_range" }
  );
  assert.throws(() => multiplyQuantityMinor(1.5, 1, "half_up"), /integer/u);
  assert.throws(() => multiplyQuantityMinor(1, 1.5, "half_up"), /integer/u);
  assert.throws(
    () => multiplyQuantityMinor(1, 1, "bankers" as "half_up"),
    { code: "invalid_rounding" }
  );
});
