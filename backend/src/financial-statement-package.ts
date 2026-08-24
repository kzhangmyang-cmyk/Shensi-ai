import { createHash } from "node:crypto";
import {
  canonicalBusinessReportInput,
  type BusinessCurrency,
  type BusinessReportInput
} from "./business-advisor/domain.js";
import {
  parseStatementPackage,
  type StatementTable
} from "./business-advisor/statement-import.js";
import { financialCouncilCanonicalHash, immutableFinancialCouncilValue } from "./financial-council-domain.js";

export type FinancialStatementKind = "balance_sheet" | "income_statement"
  | "cash_flow_statement";
export const FINANCIAL_STATEMENT_PARSER_VERSION =
  "financial-statements.v2" as const;
export const FINANCIAL_STATEMENT_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

export interface FinancialStatementPackageInput {
  readonly currency: BusinessCurrency;
  readonly balanceSheet: StatementTable;
  readonly incomeStatement: StatementTable;
  readonly cashFlowStatement: StatementTable;
}

export interface NormalizedFinancialStatementPackage {
  readonly currency: BusinessCurrency;
  readonly companyName: string;
  readonly period: string;
  readonly businessReport: BusinessReportInput;
  readonly reportInputHash: `sha256:${string}`;
  readonly warnings: readonly FinancialStatementWarning[];
}

export interface FinancialStatementSource<Kind extends FinancialStatementKind> {
  readonly kind: Kind;
  readonly fileName: string;
  readonly fileHash: `sha256:${string}`;
  readonly mediaType: typeof FINANCIAL_STATEMENT_MEDIA_TYPE;
  readonly sheetNames: readonly string[];
}

export interface FinancialStatementWarning {
  readonly code: string;
  readonly statement: FinancialStatementKind;
  readonly row: number | null;
  readonly field: string | null;
}

export interface FinancialModelDataConsent {
  readonly accepted: true;
  readonly noticeVersion: "financial-model-data.v1";
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

export interface FinancialStatementUpload<Kind extends FinancialStatementKind> {
  readonly kind: Kind;
  readonly fileName: string;
  readonly mediaType: typeof FINANCIAL_STATEMENT_MEDIA_TYPE;
  readonly contentBase64: string;
}

export interface FinancialStatementPackagePreview {
  readonly previewId: string;
  readonly workspaceId: string;
  readonly status: "preview";
  readonly expiresAt: string;
  readonly companyName: string;
  readonly currency: BusinessCurrency;
  readonly period: string;
  readonly sourceFiles: readonly [
    FinancialStatementSource<"balance_sheet">,
    FinancialStatementSource<"income_statement">,
    FinancialStatementSource<"cash_flow_statement">
  ];
  readonly parserVersion: typeof FINANCIAL_STATEMENT_PARSER_VERSION;
  readonly businessReport: BusinessReportInput;
  readonly reportInputHash: `sha256:${string}`;
  readonly warnings: readonly FinancialStatementWarning[];
  readonly previewHash: `sha256:${string}`;
  readonly createdAt: string;
}

export interface FinancialStatementPackage {
  readonly packageId: string;
  readonly workspaceId: string;
  readonly status: "verified";
  readonly companyName: string;
  readonly currency: BusinessCurrency;
  readonly period: string;
  readonly sourceFiles: FinancialStatementPackagePreview["sourceFiles"];
  readonly parserVersion: typeof FINANCIAL_STATEMENT_PARSER_VERSION;
  readonly businessReport: BusinessReportInput;
  readonly reportInputHash: `sha256:${string}`;
  readonly warnings: readonly FinancialStatementWarning[];
  readonly consent: FinancialModelDataConsent;
  readonly forecastStatus?: "computed" | "not_computable";
  readonly cashForecast?: FinancialCashForecastPublicView | null;
  readonly packageHash: `sha256:${string}`;
  readonly createdAt: string;
}

export class FinancialStatementPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinancialStatementPackageError";
  }
}

export interface FinancialCashForecastSupplementInput {
  readonly forecastAsOf: string;
  readonly expectedInflowsNext30DaysMinor: number;
  readonly expectedOutflowsNext30DaysMinor: number;
  readonly expectedInflowsNext31To90DaysMinor: number;
  readonly expectedOutflowsNext31To90DaysMinor: number;
  readonly receivables: readonly {
    readonly customer: string;
    readonly amountMinor: number;
    readonly daysOutstanding: number;
  }[];
  readonly attestation: { readonly accepted: true;
    readonly noticeVersion: "financial-cash-forecast.v1" };
}

export interface FinancialCashForecastSupplement {
  readonly source: "management_attested";
  readonly forecastAsOf: string;
  readonly currency: BusinessCurrency;
  readonly expectedInflowsNext30DaysMinor: number;
  readonly expectedOutflowsNext30DaysMinor: number;
  readonly expectedInflowsNext31To90DaysMinor: number;
  readonly expectedOutflowsNext31To90DaysMinor: number;
  readonly receivables: readonly {
    readonly customer: string;
    readonly amountMinor: number;
    readonly daysOutstanding: number;
  }[];
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly noticeVersion: "financial-cash-forecast.v1";
  readonly forecastHash: `sha256:${string}`;
}

export type FinancialCashForecastPublicView = FinancialCashForecastSupplement;

interface FinancialCashForecastContext {
  readonly currency: BusinessCurrency;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly period: string;
}

function fail(code: string): never {
  throw new FinancialStatementPackageError(code);
}

function closedCopy(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("financial_statement_input_invalid");
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("financial_statement_input_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("financial_statement_input_invalid");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function validMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateForecastRecord(value: FinancialCashForecastSupplement,
  context: FinancialCashForecastContext): FinancialCashForecastSupplement {
  const record = closedCopy(value);
  if (Object.keys(record).sort().join("\0") !== ["acceptedAt", "acceptedBy",
    "currency", "expectedInflowsNext30DaysMinor", "expectedInflowsNext31To90DaysMinor",
    "expectedOutflowsNext30DaysMinor", "expectedOutflowsNext31To90DaysMinor",
    "forecastAsOf", "forecastHash", "noticeVersion", "receivables", "source"].sort().join("\0")) {
    fail("financial_cash_forecast_invalid");
  }
  const preimage = {
    source: value.source, forecastAsOf: value.forecastAsOf,
    currency: value.currency,
    expectedInflowsNext30DaysMinor: value.expectedInflowsNext30DaysMinor,
    expectedOutflowsNext30DaysMinor: value.expectedOutflowsNext30DaysMinor,
    expectedInflowsNext31To90DaysMinor: value.expectedInflowsNext31To90DaysMinor,
    expectedOutflowsNext31To90DaysMinor: value.expectedOutflowsNext31To90DaysMinor,
    receivables: value.receivables, acceptedBy: value.acceptedBy,
    acceptedAt: value.acceptedAt, noticeVersion: value.noticeVersion
  };
  if (financialCouncilCanonicalHash(preimage) !== value.forecastHash) {
    fail("financial_cash_forecast_hash_invalid");
  }
  if (value.currency !== context.currency || value.source !== "management_attested"
    || value.noticeVersion !== "financial-cash-forecast.v1"
    || !validInstant(value.forecastAsOf) || !validInstant(value.acceptedAt)
    || typeof value.acceptedBy !== "string" || value.acceptedBy.length === 0
    || Date.parse(value.forecastAsOf) > Date.parse(value.acceptedAt)) {
    fail("financial_cash_forecast_invalid");
  }
  return value;
}

export function canonicalFinancialCashForecastSupplement(
  input: FinancialCashForecastSupplementInput,
  context: FinancialCashForecastContext
): FinancialCashForecastSupplement {
  const root = closedCopy(input);
  const ctx = closedCopy(context);
  const keys = Object.keys(root).sort();
  if (keys.join("\0") !== ["attestation", "expectedInflowsNext30DaysMinor",
    "expectedInflowsNext31To90DaysMinor", "expectedOutflowsNext30DaysMinor",
    "expectedOutflowsNext31To90DaysMinor", "forecastAsOf", "receivables"].sort().join("\0")
    || Object.keys(ctx).sort().join("\0") !== ["acceptedAt", "acceptedBy", "currency", "period"].sort().join("\0")) {
    fail("financial_statement_input_invalid");
  }
  if ((ctx.currency !== "CNY" && ctx.currency !== "USD")
    || typeof ctx.acceptedBy !== "string" || ctx.acceptedBy.length === 0
    || !validInstant(ctx.acceptedAt) || typeof ctx.period !== "string"
    || !validInstant(root.forecastAsOf) || root.forecastAsOf.slice(0, 10) !== ctx.period
    || Date.parse(root.forecastAsOf) > Date.parse(ctx.acceptedAt)) {
    fail("financial_cash_forecast_invalid");
  }
  const attestation = closedCopy(root.attestation);
  if (Object.keys(attestation).sort().join("\0") !== "accepted\0noticeVersion"
    || attestation.accepted !== true
    || attestation.noticeVersion !== "financial-cash-forecast.v1") fail("financial_cash_forecast_invalid");
  for (const key of ["expectedInflowsNext30DaysMinor", "expectedOutflowsNext30DaysMinor",
    "expectedInflowsNext31To90DaysMinor", "expectedOutflowsNext31To90DaysMinor"]) {
    if (!validMoney(root[key])) fail("financial_cash_forecast_invalid");
  }
  const receiptInput = root.receivables;
  if (!Array.isArray(receiptInput) || receiptInput.length > 100
    || Reflect.ownKeys(receiptInput).length !== receiptInput.length + 1
    || Reflect.ownKeys(receiptInput).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= receiptInput.length))) fail("financial_cash_forecast_invalid");
  const rows = receiptInput.map((raw) => {
    const row = closedCopy(raw);
    if (Object.keys(row).sort().join("\0") !== "amountMinor\0customer\0daysOutstanding"
      || typeof row.customer !== "string" || row.customer.trim() === ""
      || [...row.customer].length > 256 || !validMoney(row.amountMinor) || row.amountMinor === 0
      || !Number.isSafeInteger(row.daysOutstanding as number)
      || (row.daysOutstanding as number) < 0 || (row.daysOutstanding as number) > 3650) {
      fail("financial_cash_forecast_invalid");
    }
    return { customer: row.customer as string, amountMinor: row.amountMinor as number,
      daysOutstanding: row.daysOutstanding as number };
  });
  const normalized = rows.map((row) => row.customer.normalize("NFC").trim());
  if (new Set(normalized).size !== normalized.length) fail("financial_cash_forecast_invalid");
  rows.sort((left, right) => Buffer.compare(Buffer.from(left.customer, "utf8"), Buffer.from(right.customer, "utf8")));
  const preimage = { source: "management_attested" as const,
    forecastAsOf: root.forecastAsOf as string, currency: ctx.currency as BusinessCurrency,
    expectedInflowsNext30DaysMinor: root.expectedInflowsNext30DaysMinor as number,
    expectedOutflowsNext30DaysMinor: root.expectedOutflowsNext30DaysMinor as number,
    expectedInflowsNext31To90DaysMinor: root.expectedInflowsNext31To90DaysMinor as number,
    expectedOutflowsNext31To90DaysMinor: root.expectedOutflowsNext31To90DaysMinor as number,
    receivables: rows, acceptedBy: ctx.acceptedBy as string,
    acceptedAt: ctx.acceptedAt as string,
    noticeVersion: "financial-cash-forecast.v1" as const };
  return immutableFinancialCouncilValue({ ...preimage,
    forecastHash: financialCouncilCanonicalHash(preimage) });
}

export function buildVerifiedFinancialStatementPackage(
  preview: FinancialStatementPackagePreview,
  input: { readonly packageId: string; readonly consent: FinancialModelDataConsent;
    readonly cashForecast: FinancialCashForecastSupplement | null;
    readonly createdAt: string }
): FinancialStatementPackage {
  if (!preview.businessReport.cashFlow) fail("financial_cash_forecast_invalid");
  const cashForecast = input.cashForecast === null ? null : validateForecastRecord(
    input.cashForecast, { currency: preview.currency,
      acceptedBy: input.consent.acceptedBy, acceptedAt: input.consent.acceptedAt,
      period: input.consent.acceptedAt.slice(0, 10) });
  const cashFlow = cashForecast === null ? preview.businessReport.cashFlow : (() => {
    const { forecast: _notComputable, ...historicalCashFlow } = preview.businessReport.cashFlow!;
    return {
    ...historicalCashFlow, receivables: cashForecast.receivables,
    expectedInflowsNext30DaysMinor: cashForecast.expectedInflowsNext30DaysMinor,
    expectedOutflowsNext30DaysMinor: cashForecast.expectedOutflowsNext30DaysMinor,
    expectedInflowsNext31To90DaysMinor: cashForecast.expectedInflowsNext31To90DaysMinor,
    expectedOutflowsNext31To90DaysMinor: cashForecast.expectedOutflowsNext31To90DaysMinor
    };
  })();
  const businessReport = canonicalBusinessReportInput({ ...preview.businessReport, cashFlow });
  const preimage = { packageId: input.packageId, workspaceId: preview.workspaceId,
    status: "verified" as const, companyName: preview.companyName,
    currency: preview.currency, period: preview.period, sourceFiles: preview.sourceFiles,
    parserVersion: preview.parserVersion, businessReport,
    reportInputHash: financialCouncilCanonicalHash(businessReport), warnings: preview.warnings,
    consent: input.consent, forecastStatus: cashForecast === null ? "not_computable" as const : "computed" as const,
    cashForecast, createdAt: input.createdAt };
  return immutableFinancialCouncilValue({ ...preimage,
    packageHash: financialStatementPackageHash(preimage) });
}

function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail("financial_statement_input_invalid");
  }
}

export function normalizeFinancialStatementPackage(
  value: FinancialStatementPackageInput
): NormalizedFinancialStatementPackage {
  exact(value, ["currency", "balanceSheet", "incomeStatement",
    "cashFlowStatement"]);
  if (!value.cashFlowStatement) fail("financial_statement_cashflow_required");
  const parsed = parseStatementPackage(value.balanceSheet,
    value.incomeStatement, value.cashFlowStatement);
  if (value.currency !== parsed.input.currency) {
    fail("financial_statement_currency_mismatch");
  }
  const businessReport = canonicalBusinessReportInput(parsed.input);
  return Object.freeze({
    currency: businessReport.currency,
    companyName: businessReport.companyName,
    period: businessReport.period,
    businessReport,
    reportInputHash: financialCouncilCanonicalHash(businessReport),
    warnings: Object.freeze(parsed.warnings.map((code) => Object.freeze({
      code, statement: "cash_flow_statement" as const,
      row: null, field: null
    })))
  });
}

export function financialStatementFileHash(content: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function financialStatementPackageHash(
  value: Omit<FinancialStatementPackage, "packageHash">
): `sha256:${string}` {
  return financialCouncilCanonicalHash(value);
}
