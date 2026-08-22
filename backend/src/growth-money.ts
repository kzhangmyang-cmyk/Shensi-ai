export const ISO_4217_EXPONENT_V1_CUTOFF = Object.freeze({
  authority: "SIX Financial Information AG",
  amendment: 180,
  effectiveDate: "2026-01-01"
} as const);

const ISO_4217_EXPONENT_V1_GROUPS = Object.freeze({
  0: Object.freeze([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"
  ]),
  2: Object.freeze([
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
  ]),
  3: Object.freeze(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]),
  4: Object.freeze(["CLF", "UYW"])
} as const);

const exponents: Record<string, number> = {};
for (const [exponent, currencies] of Object.entries(ISO_4217_EXPONENT_V1_GROUPS)) {
  for (const currency of currencies) exponents[currency] = Number(exponent);
}
/** A frozen ISO 4217 currency exponent registry used by all Growth arithmetic. */
export const ISO_4217_EXPONENT_V1: Readonly<Record<string, number>> =
  Object.freeze(exponents);

export function currencyExponent(currency: string): number | null {
  return Object.hasOwn(ISO_4217_EXPONENT_V1, currency)
    ? ISO_4217_EXPONENT_V1[currency]!
    : null;
}

export function assertCurrencyCode(value: string): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)
    || currencyExponent(value) === null) {
    throw Object.assign(new RangeError("currency"), {
      code: "currency_invalid"
    });
  }
  return value;
}

function amountRangeError(field: string): RangeError & { code: string } {
  return Object.assign(new RangeError(field), { code: "amount_out_of_range" });
}

export function assertMinorAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw amountRangeError("amountMinor");
  }
  return value;
}

export function decimalMajorToMinor(
  value: string,
  currency: string
): number {
  const exponent = currencyExponent(assertCurrencyCode(currency))!;
  const match = typeof value === "string"
    ? /^(\d+)(?:\.(\d+))?$/u.exec(value)
    : null;
  if (!match || (match[2]?.length ?? 0) > exponent) {
    throw Object.assign(new RangeError("decimal amount"), {
      code: "decimal_amount_invalid"
    });
  }
  const scale = 10n ** BigInt(exponent);
  const fraction = (match[2] ?? "").padEnd(exponent, "0");
  return safeMinor(
    BigInt(match[1]!) * scale + BigInt(fraction || "0"),
    "decimal amount"
  );
}

export function roundHalfUpDiv(
  numerator: bigint,
  denominator: bigint
): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid ratio");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

export function roundSignedHalfUpDiv(
  numerator: bigint,
  denominator: bigint
): bigint {
  if (denominator <= 0n) throw new RangeError("invalid ratio");
  return numerator < 0n
    ? -roundHalfUpDiv(-numerator, denominator)
    : roundHalfUpDiv(numerator, denominator);
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid ratio");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

export function safeMinor(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw amountRangeError(field);
  }
  return Number(value);
}

export function safeSignedInteger(value: bigint, field: string): number {
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minimum || value > maximum) throw amountRangeError(field);
  return Number(value);
}

function nonnegativeIntegerBigInt(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  if (value < 0) {
    throw Object.assign(new RangeError(field), {
      code: `${field === "unitMinor" ? "unit_minor" : "quantity_micros"}_out_of_range`
    });
  }
  return BigInt(value);
}

export function multiplyQuantityMinor(
  unitMinor: number,
  quantityMicros: number,
  rounding: "half_up" | "ceil"
): number {
  const unit = nonnegativeIntegerBigInt(unitMinor, "unitMinor");
  const quantity = nonnegativeIntegerBigInt(quantityMicros, "quantityMicros");
  if (rounding !== "half_up" && rounding !== "ceil") {
    throw Object.assign(new RangeError("rounding"), { code: "invalid_rounding" });
  }
  const numerator = unit * quantity;
  return safeMinor(
    rounding === "ceil"
      ? ceilDiv(numerator, 1_000_000n)
      : roundHalfUpDiv(numerator, 1_000_000n),
    "quantity amount"
  );
}
