import { createHash, randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  canonicalGrowthRequestHash,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import {
  parseSecureSpreadsheetArtifact,
  type ParsedSpreadsheetCell
} from "./secure-spreadsheet-artifact.js";
import { deriveRevenueAndCogs } from "./financial-fact-ledger.js";
import { assertFrozenCommercialBinding } from "./authoritative-quote-reader.js";
import type {
  AuthoritativeDealDecisionRef,
  DealAuthoritativeQuoteReader
} from "./authoritative-quote-reader.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { CommercialBindingEvidenceSnapshot } from "./quote-repository.js";
import { assertCurrencyCode, currencyExponent } from "./growth-money.js";
import type { FinancialFactType } from "./financial-ledger-domain.js";
import { resolveTenantBusinessInstant } from "./tenant-time.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import {
  type FinanceImportKind,
  type FinanceImportOperation,
  type FinanceImportPreviewRecord,
  type FinanceImportPreviewRow,
  type FinanceImportPublicNormalizedRow,
  type FinanceImportRepository,
  type FinanceImportRowErrorCode,
  type FinanceImportStoredNormalizedRow,
  type FinanceImportStoredRow,
  type FinanceImportStoredRowInput
} from "./finance-import-repository.js";

export const FINANCE_COST_IMPORT_TEMPLATE_VERSION =
  "finance-cost-import.v1" as const;
export const FINANCE_FACT_IMPORT_TEMPLATE_VERSION =
  "finance-fact-import.v1" as const;

export interface FinanceImportTemplate {
  readonly kind: FinanceImportKind;
  readonly version: string;
  readonly headers: readonly string[];
  readonly labels: readonly string[];
  readonly required: readonly string[];
}

export interface FinanceImportPreviewCommand {
  readonly kind: FinanceImportKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: Buffer;
  readonly mapping: Readonly<Record<string, string>>;
}

export interface FinanceImportPreviewResult {
  previewId: string;
  kind: FinanceImportKind;
  fileHash: string;
  replayed: boolean;
  status: "preview_ready" | "partial_success" | "failed";
  resolvedTimeZone: string;
  workspaceSettingsRevision: string;
  validRows: number;
  invalidRows: number;
  rows: FinanceImportPreviewRow[];
}

export interface FinanceImportOperationProjection {
  operation: FinanceImportOperation;
  rows: FinanceImportPreviewRow[];
}

export class FinanceImportError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "FinanceImportError";
  }
}

export class FinanceImportRowError extends Error {
  readonly code: FinanceImportRowErrorCode;

  constructor(code: FinanceImportRowErrorCode) {
    super(code);
    this.name = "FinanceImportRowError";
    this.code = code;
  }
}

const FINANCIAL_FACT_TYPES: ReadonlySet<FinancialFactType> =
  new Set<FinancialFactType>([
    "contract_won",
    "payment_received",
    "revenue_recognized",
    "cogs_recognized",
    "refund",
    "bad_debt_written_off"
  ]);

const COST_CATEGORIES: ReadonlySet<string> = new Set([
  "api",
  "media",
  "content",
  "agency",
  "operation"
]);

const PREVIEW_BODY_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "fileName",
  "mediaType",
  "content",
  "mapping"
]);

const IMPORT_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxSheets: 10,
  maxRows: 5_000,
  maxColumns: 100,
  maxCellLength: 20_000
});

function text(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new FinanceImportError(code, 422);
  return normalized;
}

export function parseFinancePreviewBody(
  rawInput: unknown
): FinanceImportPreviewCommand {
  if (!rawInput
    || (typeof rawInput !== "object" && typeof rawInput !== "function")
    || Array.isArray(rawInput)) {
    throw new FinanceImportError("invalid_finance_preview_body", 422);
  }
  const input = rawInput as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!PREVIEW_BODY_FIELDS.has(key)) {
      throw new FinanceImportError(
        `additionalProperties: ${key}`, 422
      );
    }
  }
  const kind = input.kind;
  if (kind !== "acquisition_cost" && kind !== "financial_fact") {
    throw new FinanceImportError("invalid_finance_import_kind", 422);
  }
  const mediaType = input.mediaType;
  if (mediaType !== "text/csv"
    && mediaType
      !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    throw new FinanceImportError("invalid_finance_import_media_type", 422);
  }
  if (!(input.content instanceof Buffer)) {
    throw new FinanceImportError("invalid_finance_import_content", 422);
  }
  const mapping = input.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new FinanceImportError("invalid_finance_import_mapping", 422);
  }
  const normalizedMapping: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    normalizedMapping[key] = text(
      typeof value === "string" ? value : "",
      "invalid_finance_import_mapping"
    );
  }
  return Object.freeze({
    kind,
    fileName: text(
      typeof input.fileName === "string" ? input.fileName : "",
      "invalid_finance_import_file_name"
    ),
    mediaType,
    content: input.content,
    mapping: Object.freeze(normalizedMapping)
  });
}

function financeImportRowIdentity(input: {
  workspaceId: string;
  source: string;
  discriminator: string;
  externalId: string | null;
  fileHash: string;
  sheetName: string;
  rowNumber: number;
}): string {
  const stable = input.externalId?.trim()
    ? [input.workspaceId, input.source, input.discriminator,
      input.externalId.trim()]
    : [input.workspaceId, input.fileHash, input.sheetName,
      String(input.rowNumber), input.discriminator];
  return `finance-import-row:${createHash("sha256")
    .update(stable.join("\u0000")).digest("hex")}`;
}

function rejectFormulaCells(
  row: readonly { formula: string | null; text: string }[]
): void {
  if (row.some((cell) => cell.formula !== null
    || /^[=+\-@]/u.test(cell.text.trimStart()))) {
    throw new FinanceImportRowError("spreadsheet_formula_forbidden");
  }
}

function columnIndexesForMapping(
  headerRow: readonly ParsedSpreadsheetCell[],
  mapping: Readonly<Record<string, string>>
): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (const [column, header] of Object.entries(mapping)) {
    indexes.set(column, headerRow.findIndex((cell) => cell.text === header));
  }
  return indexes;
}

function rowCellValues(
  row: readonly ParsedSpreadsheetCell[],
  columnIndexes: ReadonlyMap<string, number>
): Map<string, string> {
  const values = new Map<string, string>();
  for (const [column, index] of columnIndexes) {
    values.set(column, index >= 0 ? row[index]!.text : "");
  }
  return values;
}

function rowEvidenceHash(
  row: readonly ParsedSpreadsheetCell[]
): string {
  return `sha256:${createHash("sha256")
    .update(row.map((cell) => cell.text).join("\u0000"))
    .digest("hex")}`;
}

function signedDecimalToMinor(value: string, currency: string): number {
  const exponent = currencyExponent(assertCurrencyCode(currency));
  if (exponent === null) throw new Error("currency_invalid");
  const normalized = value.trim().replaceAll("\u2212", "-");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (!match || (match[3]?.length ?? 0) > exponent) {
    throw new Error("decimal_amount_invalid");
  }
  const scale = 10n ** BigInt(exponent);
  const fraction = (match[3] ?? "").padEnd(exponent, "0");
  let minor = BigInt(match[2]!) * scale + BigInt(fraction || "0");
  if (match[1] === "-") minor = -minor;
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (minor < minimum || minor > maximum) {
    throw new Error("amount_out_of_range");
  }
  return Number(minor);
}

function matchesCommercialBindingEvidence(
  verified: {
    candidateId: string;
    customerId: string;
    dealId: string;
    handoffContentHash: string;
    dealContentHash: string;
    bindingHashSchemaVersion: string;
    bindingHash: string;
  },
  evidence: CommercialBindingEvidenceSnapshot
): boolean {
  return verified.candidateId === evidence.candidateId
    && verified.customerId === evidence.customerId
    && verified.dealId === evidence.dealId
    && verified.handoffContentHash === evidence.handoffContentHash
    && verified.dealContentHash === evidence.dealContentHash
    && verified.bindingHashSchemaVersion === evidence.bindingHashSchemaVersion
    && verified.bindingHash === evidence.bindingHash;
}

export function projectFinanceImportPreviewRow(
  stored: FinanceImportStoredRow
): FinanceImportPreviewRow {
  const storedNormalized = stored.normalized;
  let normalized: FinanceImportPublicNormalizedRow | null = null;
  if (storedNormalized !== null) {
    if (storedNormalized.kind === "acquisition_cost") {
      normalized = {
        kind: "acquisition_cost",
        category: storedNormalized.category,
        amountMinor: storedNormalized.amountMinor,
        currency: storedNormalized.currency,
        businessOccurredAt: storedNormalized.businessOccurredAt,
        externalId: storedNormalized.externalId,
        evidenceHash: storedNormalized.evidenceHash
      };
    } else {
      normalized = {
        kind: "financial_fact",
        candidateId: storedNormalized.candidateId,
        customerId: storedNormalized.customerId,
        dealId: storedNormalized.dealId,
        currency: storedNormalized.currency,
        businessOccurredAt: storedNormalized.businessOccurredAt,
        externalId: storedNormalized.externalId,
        evidenceHash: storedNormalized.evidenceHash,
        derivedFacts: storedNormalized.derivedFacts.map((fact) => ({
          factType: fact.factType,
          amountMinor: fact.amountMinor,
          ...(fact.provenance === undefined
            ? {}
            : { provenance: fact.provenance })
        }))
      };
    }
  }
  return {
    rowNumber: stored.rowNumber,
    sheetName: stored.sheetName,
    status: stored.status,
    sourceIdentityRoot: stored.sourceIdentityRoot,
    normalized,
    errors: [...stored.errors]
  };
}

type FinancialFactNormalizedRow = Extract<
  FinanceImportPublicNormalizedRow,
  { kind: "financial_fact" }
>;

export class FinanceImportService {
  private readonly repository: FinanceImportRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly bindingVerifier: Pick<CommercialBindingVerifier, "verify">;
  private readonly dealQuoteReader: Pick<
    DealAuthoritativeQuoteReader,
    "getDecisionAt"
  >;
  private readonly now: () => string;
  private readonly requestExecutionId: () => string;
  private readonly ids: { next(): string };
  private readonly derive: typeof deriveRevenueAndCogs;

  constructor(input: {
    repository: FinanceImportRepository;
    foundation: GrowthFoundationServices;
    bindingVerifier?: Pick<CommercialBindingVerifier, "verify">;
    dealQuoteReader?: Pick<DealAuthoritativeQuoteReader, "getDecisionAt">;
    now?: () => string;
    requestExecutionId?: () => string;
    ids?: { next(): string };
    derive?: typeof deriveRevenueAndCogs;
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.bindingVerifier = input.bindingVerifier ?? {
      async verify() {
        throw new FinanceImportError("commercial_binding_invalid", 409);
      }
    };
    this.dealQuoteReader = input.dealQuoteReader ?? {
      async getDecisionAt() {
        return null;
      }
    };
    this.now = input.now ?? (() => new Date().toISOString());
    this.requestExecutionId = input.requestExecutionId ?? randomUUID;
    this.ids = input.ids ?? { next: randomUUID };
    this.derive = input.derive ?? deriveRevenueAndCogs;
  }

  private requireCapability(context: CommandContext): void {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
  }

  async template(
    context: CommandContext,
    kind: FinanceImportKind
  ): Promise<FinanceImportTemplate> {
    this.requireCapability(context);
    if (kind === "acquisition_cost") {
      return Object.freeze({
        kind,
        version: FINANCE_COST_IMPORT_TEMPLATE_VERSION,
        headers: Object.freeze([
          "externalId", "category", "amount", "currency",
          "businessOccurredAt", "provenance", "status"
        ]),
        labels: Object.freeze([
          "外部ID", "费用类别", "金额", "币种", "业务发生时间",
          "来源", "状态"
        ]),
        required: Object.freeze([
          "category", "amount", "currency", "businessOccurredAt"
        ])
      });
    }
    return Object.freeze({
      kind,
      version: FINANCE_FACT_IMPORT_TEMPLATE_VERSION,
      headers: Object.freeze([
        "externalId", "factType", "amount", "currency",
        "businessOccurredAt", "provenance", "revenue", "grossProfit",
        "status"
      ]),
      labels: Object.freeze([
        "外部ID", "事实类型", "金额", "币种", "业务发生时间",
        "来源", "收入", "毛利", "状态"
      ]),
      required: Object.freeze([
        "factType", "amount", "currency", "businessOccurredAt"
      ])
    });
  }

  async preview(
    context: CommandContext,
    rawInput: FinanceImportPreviewCommand
  ): Promise<FinanceImportPreviewResult> {
    this.requireCapability(context);
    const input = parseFinancePreviewBody(rawInput);
    const execution = await executeGrowthIdempotentCommand(
      {
        repository: this.foundation.httpIdempotency,
        reservation: {
          workspaceId: context.workspace.workspaceId,
          actorId: context.actorId,
          method: "POST",
          canonicalPath: "/api/v1/finance/imports/preview",
          key: context.idempotencyKey,
          requestHash: context.requestHash,
          attemptedAt: this.now(),
          leaseOwner: this.requestExecutionId(),
          leaseDurationMs: 30_000
        }
      },
      async (resourceId, operationId) => {
        this.requireCapability(context);
        if (!resourceId || operationId !== null) {
          throw new FinanceImportError("idempotency_reference_invalid", 409);
        }
        const preview = await this.repository.getPreview(resourceId);
        if (!preview) {
          throw new FinanceImportError("idempotency_conflict", 409);
        }
        const rows = await this.repository.listStoredRows(preview.id);
        return this.projectPreview(preview, rows);
      },
      async () => {
        const previewStartedAt = this.now();
        const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
          context.workspace, previewStartedAt
        );
        const settings = await this.foundation.workspaceSettings.getAt(
          context.workspace, cutoff
        );
        const artifact = parseSecureSpreadsheetArtifact({
          content: input.content,
          mediaType: input.mediaType,
          limits: IMPORT_LIMITS
        });
        const previewId = this.ids.next();
        const storedRows: FinanceImportStoredRowInput[] = [];
        let validRows = 0;
        let invalidRows = 0;
        for (const sheet of artifact.sheets) {
          const headerRow = sheet.rows[0] ?? [];
          const columnIndexes = columnIndexesForMapping(
            headerRow, input.mapping
          );
          const dataRows = sheet.rows.slice(1);
          for (let index = 0; index < dataRows.length; index += 1) {
            const row = dataRows[index]!;
            const rowNumber = index + 1;
            const normalizedRow = await this.normalizeStoredRow({
              context,
              cutoff,
              kind: input.kind,
              row,
              columnIndexes,
              timeZone: settings.timeZone,
              fileHash: artifact.fileHash,
              sheetName: sheet.name,
              rowNumber,
              previewId
            });
            if (normalizedRow.status === "valid") validRows += 1;
            else invalidRows += 1;
            storedRows.push(normalizedRow);
          }
        }
        const previewRequestHash = canonicalGrowthRequestHash({
          workspaceId: context.workspace.workspaceId,
          actorId: context.actorId,
          kind: input.kind,
          fileName: input.fileName,
          mediaType: input.mediaType,
          fileHash: artifact.fileHash,
          mapping: input.mapping
        });
        const preview = await this.repository.appendPreview({
          id: previewId,
          workspaceId: context.workspace.workspaceId,
          createdBy: context.actorId,
          previewRequestHash,
          fileHash: artifact.fileHash,
          templateVersion: input.kind === "acquisition_cost"
            ? FINANCE_COST_IMPORT_TEMPLATE_VERSION
            : FINANCE_FACT_IMPORT_TEMPLATE_VERSION,
          kind: input.kind,
          resolvedTimeZone: settings.timeZone,
          workspaceSettingsRevision: settings.revision,
          workspaceSettingsRecordedAt: settings.recordedAt,
          workspaceSettingsEventSequence: settings.eventSequence,
          validRows,
          invalidRows,
          authorityEffectiveAsOf: previewStartedAt,
          authorityTemporalSequence: cutoff.temporalSequence
        }, storedRows);
        return {
          resourceId: preview.id,
          operationId: null
        };
      }
    );
    return { ...execution.value, replayed: execution.replayed };
  }

  private async projectPreview(
    preview: FinanceImportPreviewRecord,
    rows: readonly FinanceImportStoredRow[]
  ): Promise<FinanceImportPreviewResult> {
    return {
      previewId: preview.id,
      kind: preview.kind,
      fileHash: preview.fileHash,
      replayed: false,
      status: preview.invalidRows === 0
        ? "preview_ready"
        : preview.validRows > 0 ? "partial_success" : "failed",
      resolvedTimeZone: preview.resolvedTimeZone,
      workspaceSettingsRevision: preview.workspaceSettingsRevision,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      rows: rows.map(projectFinanceImportPreviewRow)
    };
  }

  private async normalizeStoredRow(input: {
    context: CommandContext;
    cutoff: GrowthSealedReadCutoff;
    kind: FinanceImportKind;
    row: readonly ParsedSpreadsheetCell[];
    columnIndexes: ReadonlyMap<string, number>;
    timeZone: string;
    fileHash: string;
    sheetName: string;
    rowNumber: number;
    previewId: string;
  }): Promise<FinanceImportStoredRowInput> {
    const errors: FinanceImportRowErrorCode[] = [];
    try {
      rejectFormulaCells(input.row);
    } catch (error) {
      if (error instanceof FinanceImportRowError) {
        errors.push(error.code);
      } else {
        throw error;
      }
    }
    const values = rowCellValues(input.row, input.columnIndexes);
    const status = values.get("status")?.trim() ?? "";
    if (status !== "" && status !== "pending") {
      errors.push("verified_import_forbidden");
    }
    const evidenceHash = rowEvidenceHash(input.row);
    let normalized: FinanceImportStoredNormalizedRow | null = null;
    if (input.kind === "acquisition_cost") {
      normalized = this.normalizeCostRow({
        values,
        timeZone: input.timeZone,
        evidenceHash,
        errors
      });
    } else {
      normalized = await this.normalizeFactRow({
        context: input.context,
        cutoff: input.cutoff,
        values,
        timeZone: input.timeZone,
        evidenceHash,
        errors
      });
    }
    const isInvalid = errors.length > 0 || normalized === null;
    const discriminator = input.kind === "acquisition_cost"
      ? (normalized?.kind === "acquisition_cost"
        ? normalized.category : "cost")
      : (normalized?.kind === "financial_fact"
        ? normalized.derivedFacts[0]?.factType ?? "fact"
        : "fact");
    return Object.freeze({
      id: this.ids.next(),
      previewId: input.previewId,
      rowNumber: input.rowNumber,
      sheetName: input.sheetName,
      status: isInvalid ? "invalid" : "valid",
      sourceIdentityRoot: financeImportRowIdentity({
        workspaceId: input.context.workspace.workspaceId,
        source: input.kind,
        discriminator,
        externalId: values.get("externalId")?.trim() || null,
        fileHash: input.fileHash,
        sheetName: input.sheetName,
        rowNumber: input.rowNumber
      }),
      normalized: isInvalid ? null : normalized,
      errors: Object.freeze(errors)
    });
  }

  private normalizeCostRow(input: {
    values: ReadonlyMap<string, string>;
    timeZone: string;
    evidenceHash: string;
    errors: FinanceImportRowErrorCode[];
  }): FinanceImportStoredNormalizedRow | null {
    const { values } = input;
    const category = values.get("category")?.trim() ?? "";
    const amountText = values.get("amount")?.trim() ?? "";
    const currencyText = values.get("currency")?.trim() ?? "";
    const businessText = values.get("businessOccurredAt")?.trim() ?? "";
    if (!COST_CATEGORIES.has(category)) {
      input.errors.push("required_field_missing");
    }
    let currency = "";
    try {
      currency = assertCurrencyCode(currencyText.toUpperCase());
    } catch {
      if (!currencyText) input.errors.push("required_field_missing");
      else input.errors.push("currency_invalid");
    }
    let amountMinor = 0;
    try {
      amountMinor = signedDecimalToMinor(amountText, currency || "CNY");
      if (amountMinor < 0) return null;
    } catch {
      if (!amountText) input.errors.push("required_field_missing");
      else input.errors.push("money_invalid");
    }
    const resolved = resolveTenantBusinessInstant(
      businessText, input.timeZone
    );
    if (!businessText) {
      input.errors.push("required_field_missing");
    } else if (!resolved) {
      input.errors.push("business_time_invalid");
    }
    if (input.errors.length > 0) return null;
    return Object.freeze({
      kind: "acquisition_cost",
      category: category as "api" | "media" | "content" | "agency" | "operation",
      amountMinor,
      currency,
      businessOccurredAt: resolved!,
      externalId: values.get("externalId")?.trim() || null,
      evidenceHash: input.evidenceHash
    });
  }

  private async normalizeFactRow(input: {
    context: CommandContext;
    cutoff: GrowthSealedReadCutoff;
    values: ReadonlyMap<string, string>;
    timeZone: string;
    evidenceHash: string;
    errors: FinanceImportRowErrorCode[];
  }): Promise<FinanceImportStoredNormalizedRow | null> {
    const factTypeText = input.values.get("factType")?.trim() ?? "";
    const amountText = input.values.get("amount")?.trim() ?? "";
    const revenueText = input.values.get("revenue")?.trim() ?? "";
    const grossProfitText = input.values.get("grossProfit")?.trim() ?? "";
    const currencyText = input.values.get("currency")?.trim() ?? "";
    const businessText = input.values.get("businessOccurredAt")?.trim() ?? "";
    const candidateId = input.values.get("candidateId")?.trim() || null;
    const customerId = input.values.get("customerId")?.trim() || null;
    const dealId = input.values.get("dealId")?.trim() || null;
    let currency = "";
    try {
      currency = assertCurrencyCode(currencyText.toUpperCase());
    } catch {
      if (!currencyText) input.errors.push("required_field_missing");
      else input.errors.push("currency_invalid");
    }
    let businessOccurredAt = "";
    if (!businessText) {
      input.errors.push("required_field_missing");
    } else {
      const resolved = resolveTenantBusinessInstant(
        businessText, input.timeZone
      );
      if (!resolved) input.errors.push("business_time_invalid");
      else businessOccurredAt = resolved;
    }
    let derivedFacts: Array<{
      factType: FinancialFactType;
      amountMinor: number;
      provenance?: "derived_from_import";
    }> = [];
    let derivationInputs: {
      revenueMinor: number | null;
      grossProfitMinor: number | null;
    } | null = null;
    const derivationPresent = revenueText.length > 0
      || grossProfitText.length > 0;
    if (derivationPresent) {
      try {
        const revenueMinor = revenueText
          ? signedDecimalToMinor(revenueText, currency || "CNY") : null;
        const grossProfitMinor = grossProfitText
          ? signedDecimalToMinor(grossProfitText, currency || "CNY") : null;
        derivationInputs = { revenueMinor, grossProfitMinor };
        if (grossProfitText && revenueMinor === null) {
          input.errors.push("required_field_missing");
        } else {
          const derived = this.derive({
            revenueMinor,
            grossProfitMinor
          });
          if (derived) {
            derivedFacts = [{
              factType: "revenue_recognized",
              amountMinor: derived.revenueMinor
            }];
            if (derived.cogsMinor !== null) {
              derivedFacts.push({
                factType: "cogs_recognized",
                amountMinor: derived.cogsMinor,
                provenance: "derived_from_import"
              });
            }
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "amount_out_of_range") {
          input.errors.push("amount_out_of_range");
        } else if (code === "revenue_required_for_gross_profit") {
          input.errors.push("required_field_missing");
        } else {
          input.errors.push("financial_fact_amount_invalid");
        }
      }
    } else {
      if (!factTypeText
        || !FINANCIAL_FACT_TYPES.has(factTypeText as FinancialFactType)) {
        input.errors.push("required_field_missing");
      }
      try {
        const amountMinor = signedDecimalToMinor(
          amountText, currency || "CNY"
        );
        if (amountMinor < 0) throw new Error("money_invalid");
        if (factTypeText) {
          derivedFacts = [{
            factType: factTypeText as FinancialFactType,
            amountMinor
          }];
        }
      } catch {
        if (!amountText) input.errors.push("required_field_missing");
        else input.errors.push("money_invalid");
      }
    }
    if (input.errors.length > 0) return null;
    const publicRow: FinancialFactNormalizedRow = Object.freeze({
      kind: "financial_fact",
      candidateId,
      customerId,
      dealId,
      currency,
      businessOccurredAt,
      externalId: input.values.get("externalId")?.trim() || null,
      evidenceHash: input.evidenceHash,
      derivedFacts: derivedFacts.map((fact) => ({ ...fact }))
    });
    let authoritativeDecision: AuthoritativeDealDecisionRef | null = null;
    if (candidateId || customerId || dealId) {
      try {
        authoritativeDecision = await this.resolveRowAuthority({
          context: input.context,
          cutoff: input.cutoff,
          row: publicRow
        });
      } catch (error) {
        if (error instanceof FinanceImportRowError) {
          input.errors.push(error.code);
          return null;
        }
        if ((error as { code?: string }).code === "commercial_binding_invalid"
          || (error as { code?: string }).code
            === "commercial_binding_hash_mismatch"
          || (error as { code?: string }).code
            === "commercial_binding_authority_mismatch") {
          input.errors.push("financial_fact_conflict");
          return null;
        }
        throw error;
      }
    }
    return Object.freeze({
      ...publicRow,
      authoritativeDecision,
      derivationInputs
    });
  }

  private async resolveRowAuthority(input: {
    context: CommandContext;
    cutoff: GrowthSealedReadCutoff;
    row: FinancialFactNormalizedRow;
  }): Promise<AuthoritativeDealDecisionRef> {
    const { candidateId, customerId, dealId } = input.row;
    if (!candidateId || !customerId || !dealId) {
      throw new FinanceImportRowError("commercial_binding_invalid");
    }
    const decision = await this.dealQuoteReader.getDecisionAt(
      input.context.workspace, dealId, input.cutoff
    );
    if (!decision || decision.type !== "won") {
      throw new FinanceImportRowError("financial_fact_conflict");
    }
    const evidence = decision.commercialBindingEvidence;
    if (evidence.candidateId !== candidateId
      || evidence.customerId !== customerId
      || evidence.dealId !== dealId) {
      throw new FinanceImportRowError("financial_fact_conflict");
    }
    assertFrozenCommercialBinding(
      decision.commercialBindingSnapshot, evidence
    );
    const verified = await this.bindingVerifier.verify(
      input.context.workspace, { candidateId, customerId, dealId }
    );
    if (!matchesCommercialBindingEvidence(verified, evidence)) {
      throw new FinanceImportRowError("financial_fact_conflict");
    }
    const contractFact = input.row.derivedFacts.find((fact) =>
      fact.factType === "contract_won");
    if (contractFact
      && (contractFact.amountMinor !== decision.quotedAmountMinor
        || input.row.currency !== decision.currency)) {
      throw new FinanceImportRowError("financial_fact_conflict");
    }
    return decision;
  }

  async get(
    context: CommandContext,
    operationId: string
  ): Promise<FinanceImportOperationProjection | null> {
    this.requireCapability(context);
    const operation = await this.repository.getOperation(
      text(operationId, "invalid_finance_import_operation_id")
    );
    if (!operation
      || operation.workspaceId !== context.workspace.workspaceId) {
      return null;
    }
    return this.projectOperation(context.workspace, operation);
  }

  async queueCommit(
    context: CommandContext,
    previewId: string
  ): Promise<{ operation: FinanceImportOperation; replayed: boolean }> {
    this.requireCapability(context);
    const attemptedAt = this.now();
    const result = await executeGrowthIdempotentCommand({
      repository: this.foundation.httpIdempotency,
      reservation: {
        workspaceId: context.workspace.workspaceId,
        actorId: context.actorId,
        method: "POST",
        canonicalPath: "/api/v1/finance/imports/:previewId/commit",
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        attemptedAt,
        leaseOwner: this.requestExecutionId(),
        leaseDurationMs: 30_000
      }
    }, async (resourceId, operationId) => {
      this.requireCapability(context);
      if (resourceId !== previewId || operationId === null) {
        throw new FinanceImportError("idempotency_reference_invalid", 409);
      }
      const operation = await this.repository.getOperation(operationId);
      const preview = await this.repository.getPreview(previewId);
      if (!preview || !operation
        || preview.workspaceId !== context.workspace.workspaceId
        || preview.createdBy !== context.actorId
        || operation.previewId !== preview.id
        || operation.workspaceId !== preview.workspaceId
        || operation.requestingActorId !== context.actorId) {
        throw new FinanceImportError(
          "finance_import_authority_mismatch", 403
        );
      }
      return operation;
    }, async () => {
      const preview = await this.repository.getPreview(previewId);
      if (!preview
        || preview.workspaceId !== context.workspace.workspaceId
        || preview.createdBy !== context.actorId) {
        throw new FinanceImportError(
          "finance_import_authority_mismatch", 403
        );
      }
      const operation = await this.repository.appendOperation(Object.freeze({
        id: this.ids.next(),
        previewId: preview.id,
        workspaceId: preview.workspaceId,
        requestingActorId: context.actorId,
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
        previewRequestHash: preview.previewRequestHash,
        fileHash: preview.fileHash,
        templateVersion: preview.templateVersion,
        status: "queued",
        validRows: preview.validRows,
        invalidRows: preview.invalidRows,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
        resultCreatedIds: [],
        lastErrorCode: null
      }));
      return { resourceId: preview.id, operationId: operation.id };
    });
    return { operation: result.value, replayed: result.replayed };
  }

  private async projectOperation(
    workspace: ActiveWorkspaceContext,
    operation: FinanceImportOperation
  ): Promise<FinanceImportOperationProjection> {
    const rows = await this.repository.listStoredRows(operation.previewId);
    return Object.freeze({
      operation,
      rows: rows.map(projectFinanceImportPreviewRow)
    });
  }
}
