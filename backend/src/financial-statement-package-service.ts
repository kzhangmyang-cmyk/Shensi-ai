import { randomUUID } from "node:crypto";
import {
  FINANCIAL_STATEMENT_MEDIA_TYPE,
  FINANCIAL_STATEMENT_PARSER_VERSION,
  FinancialStatementPackageError,
  canonicalFinancialCashForecastSupplement,
  normalizeFinancialStatementPackage,
  type FinancialCashForecastSupplementInput,
  type FinancialModelDataConsent,
  type FinancialStatementKind,
  type FinancialStatementPackagePreview,
  type FinancialStatementUpload
} from "./financial-statement-package.js";
import type { StatementTable } from "./business-advisor/statement-import.js";
import { parseSecureSpreadsheetArtifact } from
  "./secure-spreadsheet-artifact.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import type { FinancialStatementPackageRepository } from
  "./financial-statement-package-repository.js";

export interface FinancialStatementPackageCommandContext {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: `sha256:${string}`;
}

const LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxSheets: 10,
  maxRows: 5_000, maxColumns: 100, maxCellLength: 20_000 });
const KINDS = ["balance_sheet", "income_statement",
  "cash_flow_statement"] as const;

function fail(code: string): never {
  throw new FinancialStatementPackageError(code);
}

function command(value: FinancialStatementPackageCommandContext) {
  if (!value?.workspaceId?.trim() || value.workspaceId === "all"
    || !value.actorId?.trim() || !value.idempotencyKey?.trim()
    || !/^sha256:[0-9a-f]{64}$/u.test(value.requestHash)) {
    fail("financial_statement_context_invalid");
  }
}

function decode(contentBase64: string): Buffer {
  if (typeof contentBase64 !== "string" || contentBase64.length === 0
    || contentBase64.length % 4 !== 0) fail("financial_statement_content_invalid");
  const content = Buffer.from(contentBase64, "base64");
  // Exact round-trip enforces alphabet, padding and unused bits without a
  // repeated-group regex that exhausts the stack on valid multi-MiB uploads.
  if (content.toString("base64") !== contentBase64) {
    fail("financial_statement_content_invalid");
  }
  return content;
}

function parseUpload(upload: FinancialStatementUpload<FinancialStatementKind>) {
  if (!upload || Object.keys(upload).sort().join("\0") !==
    ["kind", "fileName", "mediaType", "contentBase64"].sort().join("\0")
    || !KINDS.includes(upload.kind) || upload.mediaType !==
      FINANCIAL_STATEMENT_MEDIA_TYPE || !upload.fileName?.trim()
    || [...upload.fileName].length > 255) fail("financial_statement_upload_invalid");
  let parsed;
  try {
    parsed = parseSecureSpreadsheetArtifact({ content: decode(upload.contentBase64),
      mediaType: upload.mediaType, limits: LIMITS });
  } catch (error) {
    const code = (error as { code?: string }).code;
    fail(code === "IMPORT_LIMIT_EXCEEDED"
      ? "financial_statement_limit_exceeded"
      : "financial_statement_artifact_invalid");
  }
  if (new Set(parsed.sheets.map((sheet) => sheet.name)).size !==
      parsed.sheets.length) fail("financial_statement_duplicate_sheet");
  if (parsed.sheets.some((sheet) => sheet.rows.some((row) =>
    row.some((cell) => cell.formula !== null)))) {
    fail("financial_statement_formula_forbidden");
  }
  if (parsed.sheets.length !== 1) fail("financial_statement_sheet_ambiguous");
  const sheet = parsed.sheets[0]!;
  const table: StatementTable = { name: sheet.name,
    rows: sheet.rows.map((row) => row.map((cell) => cell.text)) };
  return { table, source: Object.freeze({ kind: upload.kind,
    fileName: upload.fileName, fileHash: parsed.fileHash as `sha256:${string}`,
    mediaType: FINANCIAL_STATEMENT_MEDIA_TYPE,
    sheetNames: Object.freeze(parsed.sheets.map((sheet) => sheet.name)) }) };
}

export class FinancialStatementPackageService {
  private readonly now: () => string;
  private readonly ids: { next(): string };
  constructor(private readonly dependencies: {
    readonly repository: FinancialStatementPackageRepository;
    readonly now?: () => string;
    readonly ids?: { next(): string };
  }) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.ids = dependencies.ids ?? { next: () => randomUUID() };
  }

  async preview(context: FinancialStatementPackageCommandContext, input: {
    readonly uploads: readonly FinancialStatementUpload<FinancialStatementKind>[];
  }): Promise<FinancialStatementPackagePreview> {
    command(context);
    if (!input || Object.keys(input).join("") !== "uploads"
      || !Array.isArray(input.uploads) || input.uploads.length !== 3) {
      fail("financial_statement_three_uploads_required");
    }
    const parsed = input.uploads.map(parseUpload);
    if (new Set(parsed.map((row) => row.source.kind)).size !== 3) {
      fail("financial_statement_three_uploads_required");
    }
    const byKind = new Map(parsed.map((row) => [row.source.kind, row]));
    const normalized = normalizeFinancialStatementPackage({
      currency: (() => {
        const metadata = byKind.get("balance_sheet")!.table.rows.flat()
          .map(String).find((cell) => /^(?:币种|currency)\s*[:：]/iu.test(cell));
        const currency = metadata?.split(/[:：]/u)[1]?.trim().toUpperCase();
        if (currency !== "CNY" && currency !== "USD") {
          fail("financial_statement_currency_required");
        }
        return currency;
      })(),
      balanceSheet: byKind.get("balance_sheet")!.table,
      incomeStatement: byKind.get("income_statement")!.table,
      cashFlowStatement: byKind.get("cash_flow_statement")!.table
    });
    const createdAt = this.now();
    const previewId = this.ids.next();
    const sourceFiles = Object.freeze(KINDS.map((kind) =>
      byKind.get(kind)!.source)) as FinancialStatementPackagePreview["sourceFiles"];
    const preimage = { previewId, workspaceId: context.workspaceId,
      status: "preview" as const,
      expiresAt: new Date(Date.parse(createdAt) + 60 * 60 * 1_000).toISOString(),
      companyName: normalized.companyName, currency: normalized.currency,
      period: normalized.period, sourceFiles,
      parserVersion: FINANCIAL_STATEMENT_PARSER_VERSION,
      businessReport: normalized.businessReport,
      reportInputHash: normalized.reportInputHash, warnings: normalized.warnings,
      createdAt };
    const preview = Object.freeze({ ...preimage,
      previewHash: financialCouncilCanonicalHash(preimage) });
    await this.dependencies.repository.appendPreview(preview);
    return preview;
  }

  async commit(context: FinancialStatementPackageCommandContext, input: {
    readonly previewId: string;
    readonly consent: FinancialModelDataConsent | null;
    readonly cashForecast?: FinancialCashForecastSupplementInput | null;
  }) {
    command(context);
    const consent = input?.consent;
    const keys = input && Object.keys(input).sort().join("\0");
    if (!input || (keys !== ["previewId", "consent"].sort().join("\0")
      && keys !== ["previewId", "consent", "cashForecast"].sort().join("\0"))
      || !consent || Object.keys(consent).sort().join("\0") !==
      ["accepted", "noticeVersion", "acceptedBy", "acceptedAt"]
        .sort().join("\0")
      || consent.accepted !== true
      || consent.noticeVersion !== "financial-model-data.v1"
      || consent.acceptedBy !== context.actorId
      || Number.isNaN(Date.parse(consent.acceptedAt))) {
      fail("financial_statement_consent_required");
    }
    const createdAt = this.now();
    let cashForecast = null;
    if (input.cashForecast !== undefined && input.cashForecast !== null) {
      const preview = await this.dependencies.repository.getPreview(
        context.workspaceId, input.previewId);
      if (!preview) fail("financial_statement_preview_not_found");
      cashForecast = canonicalFinancialCashForecastSupplement(
        input.cashForecast, { currency: preview.currency,
          acceptedBy: context.actorId, acceptedAt: createdAt,
          period: preview.period });
    }
    const packageId = `financial-statement-package:${
      financialCouncilCanonicalHash({ workspaceId: context.workspaceId,
        previewId: input.previewId, requestHash: context.requestHash })}`;
    return this.dependencies.repository.commitPreview({
      workspaceId: context.workspaceId, previewId: input.previewId, packageId,
      consent, cashForecast, idempotencyKeyHash: financialCouncilCanonicalHash(
        context.idempotencyKey), requestHash: context.requestHash,
      createdAt
    });
  }

  async getPreview(context: Pick<FinancialStatementPackageCommandContext,
  "workspaceId" | "actorId">, previewId: string) {
    if (!context?.workspaceId?.trim() || !context.actorId?.trim()
      || typeof previewId !== "string" || !previewId.trim()) {
      fail("financial_statement_context_invalid");
    }
    const value = await this.dependencies.repository.getPreview(
      context.workspaceId, previewId
    );
    if (!value) fail("financial_statement_preview_not_found");
    return value;
  }

  async getVerified(context: Pick<FinancialStatementPackageCommandContext,
  "workspaceId" | "actorId">, packageId: string) {
    if (!context?.workspaceId?.trim() || !context.actorId?.trim()) {
      fail("financial_statement_context_invalid");
    }
    const value = await this.dependencies.repository.getVerified(
      context.workspaceId, packageId);
    if (!value) fail("financial_statement_package_not_found");
    return value;
  }

  async getLatestVerified(context: Pick<FinancialStatementPackageCommandContext,
  "workspaceId" | "actorId">) {
    if (!context?.workspaceId?.trim() || !context.actorId?.trim()) {
      fail("financial_statement_context_invalid");
    }
    return this.dependencies.repository.getLatestVerified(
      context.workspaceId, Object.freeze({ limit: 1 })
    );
  }
}
