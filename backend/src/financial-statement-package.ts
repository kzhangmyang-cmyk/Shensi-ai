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
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";

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
  readonly packageHash: `sha256:${string}`;
  readonly createdAt: string;
}

export class FinancialStatementPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinancialStatementPackageError";
  }
}

function fail(code: string): never {
  throw new FinancialStatementPackageError(code);
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
