import type { FinancialCashForecastSupplementInput } from "../contracts";

const MONEY_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;
const INTEGER_PATTERN = /^(0|[1-9]\d*)$/u;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export type CashForecastAmountField =
  | "inflow30"
  | "outflow30"
  | "inflow31To90"
  | "outflow31To90";

export interface CashForecastReceivableDraft {
  readonly customer: string;
  readonly amount: string;
  readonly daysOutstanding: string;
}

export interface FinancialCashForecastDraftSnapshot {
  readonly amounts: Readonly<Record<CashForecastAmountField, string>>;
  readonly receivablesState: "unknown" | "empty" | "rows";
  readonly receivables: readonly CashForecastReceivableDraft[];
  readonly attestationAccepted: boolean;
}

export interface FinancialCashForecastDraft {
  snapshot(): FinancialCashForecastDraftSnapshot;
  isComplete(): boolean;
  toInput(forecastAsOf: string): FinancialCashForecastSupplementInput;
  setAmount(field: CashForecastAmountField, value: string): void;
  setReceivablesEmpty(): void;
  addReceivable(value?: CashForecastReceivableDraft): void;
  updateReceivable(index: number, value: CashForecastReceivableDraft): void;
  removeReceivable(index: number): void;
  setAttestation(accepted: boolean): void;
  clear(): void;
  revision(): number;
}

function invalid(): never {
  throw new Error("cash_forecast_invalid");
}

export function parseMajorMoneyToMinor(value: string): number {
  const match = MONEY_PATTERN.exec(value);
  if (!match) invalid();
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100n + fraction;
  if (minor > MAX_SAFE_MINOR) invalid();
  return parseInt(minor.toString(), 10);
}

function parseDays(value: string): number {
  if (!INTEGER_PATTERN.test(value)) invalid();
  const parsed = BigInt(value);
  if (parsed > 3650n) invalid();
  return parseInt(parsed.toString(), 10);
}

function normalizedCustomer(value: string): string {
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < 1 || length > 255) invalid();
  return normalized;
}

export function createFinancialCashForecastDraft(): FinancialCashForecastDraft {
  let amounts: Record<CashForecastAmountField, string> = {
    inflow30: "", outflow30: "", inflow31To90: "", outflow31To90: ""
  };
  let receivablesState: "unknown" | "empty" | "rows" = "unknown";
  let receivables: CashForecastReceivableDraft[] = [];
  let attestationAccepted = false;
  let revision = 0;

  function canonicalReceivables(): FinancialCashForecastSupplementInput["receivables"] {
    if (receivablesState === "unknown") invalid();
    if (receivablesState === "empty") return [];
    if (receivables.length < 1 || receivables.length > 100) invalid();
    const customers = new Set<string>();
    return receivables.map((row) => {
      const customer = normalizedCustomer(row.customer);
      if (customers.has(customer)) invalid();
      customers.add(customer);
      const amountMinor = parseMajorMoneyToMinor(row.amount);
      if (amountMinor < 1) invalid();
      return { customer, amountMinor, daysOutstanding: parseDays(row.daysOutstanding) };
    });
  }

  function toInput(forecastAsOf: string): FinancialCashForecastSupplementInput {
    if (!attestationAccepted || typeof forecastAsOf !== "string"
      || forecastAsOf.length === 0) invalid();
    return {
      forecastAsOf,
      expectedInflowsNext30DaysMinor: parseMajorMoneyToMinor(amounts.inflow30),
      expectedOutflowsNext30DaysMinor: parseMajorMoneyToMinor(amounts.outflow30),
      expectedInflowsNext31To90DaysMinor: parseMajorMoneyToMinor(amounts.inflow31To90),
      expectedOutflowsNext31To90DaysMinor: parseMajorMoneyToMinor(amounts.outflow31To90),
      receivables: canonicalReceivables(),
      attestation: {
        accepted: true,
        noticeVersion: "financial-cash-forecast.v1"
      }
    };
  }

  function clear(): void {
    amounts = { inflow30: "", outflow30: "", inflow31To90: "", outflow31To90: "" };
    receivables = [];
    receivablesState = "unknown";
    attestationAccepted = false;
    revision += 1;
  }

  return Object.freeze({
    snapshot() {
      return Object.freeze({
        amounts: Object.freeze({ ...amounts }),
        receivablesState,
        receivables: Object.freeze(receivables.map((row) => Object.freeze({ ...row }))),
        attestationAccepted
      });
    },
    isComplete() {
      try {
        toInput("1970-01-01T00:00:00.000Z");
        return true;
      } catch {
        return false;
      }
    },
    toInput,
    setAmount(field: CashForecastAmountField, value: string) {
      if (!(field in amounts) || typeof value !== "string") invalid();
      amounts[field] = value;
      revision += 1;
    },
    setReceivablesEmpty() {
      receivables = [];
      receivablesState = "empty";
      revision += 1;
    },
    addReceivable(value = { customer: "", amount: "", daysOutstanding: "" }) {
      if (receivables.length >= 100) invalid();
      receivables.push({ ...value });
      receivablesState = "rows";
      revision += 1;
    },
    updateReceivable(index: number, value: CashForecastReceivableDraft) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= receivables.length) invalid();
      receivables[index] = { ...value };
      receivablesState = "rows";
      revision += 1;
    },
    removeReceivable(index: number) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= receivables.length) invalid();
      receivables.splice(index, 1);
      receivablesState = receivables.length === 0 ? "unknown" : "rows";
      revision += 1;
    },
    setAttestation(accepted: boolean) {
      attestationAccepted = accepted === true;
      revision += 1;
    },
    clear,
    revision() { return revision; }
  });
}
