import {
  buildVerifiedFinancialStatementPackage,
  canonicalFinancialCashForecastSupplement,
  financialStatementPackageHash,
  type FinancialCashForecastSupplement,
  type FinancialModelDataConsent,
  type FinancialStatementPackage,
  type FinancialStatementPackagePreview
} from "./financial-statement-package.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";

export interface CommitFinancialStatementPackageInput {
  readonly workspaceId: string;
  readonly previewId: string;
  readonly packageId: string;
  readonly consent: FinancialModelDataConsent;
  readonly cashForecast: FinancialCashForecastSupplement | null;
  readonly idempotencyKeyHash: `sha256:${string}`;
  readonly requestHash: `sha256:${string}`;
  readonly createdAt: string;
}

export interface FinancialStatementPackageRepository {
  appendPreview(preview: FinancialStatementPackagePreview): Promise<void>;
  getPreview(workspaceId: string, previewId: string): Promise<
    FinancialStatementPackagePreview | null>;
  commitPreview(input: CommitFinancialStatementPackageInput): Promise<{
    readonly value: FinancialStatementPackage;
    readonly replayed: boolean;
  }>;
  getVerified(workspaceId: string, packageId: string): Promise<
    FinancialStatementPackage | null>;
  getLatestVerified(workspaceId: string, input: { readonly limit: 1 }): Promise<
    FinancialStatementPackage | null>;
  cleanupExpired(now: string): Promise<number>;
}

export class FinancialStatementPackageRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinancialStatementPackageRepositoryError";
  }
}

function fail(code: string): never {
  throw new FinancialStatementPackageRepositoryError(code);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPreview(preview: FinancialStatementPackagePreview): void {
  const { previewHash, ...preimage } = preview;
  if (financialCouncilCanonicalHash(preimage) !== previewHash
    || preview.status !== "preview") fail("financial_statement_preview_tampered");
}

export function assertFinancialStatementPackage(
  value: FinancialStatementPackage
): void {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join("\0") !== ["businessReport",
        "cashForecast", "companyName", "consent", "createdAt", "currency",
        "forecastStatus", "packageHash", "packageId", "parserVersion",
        "period", "reportInputHash", "sourceFiles", "status", "warnings",
        "workspaceId"].sort().join("\0")) {
      fail("financial_statement_package_integrity");
    }
    const { packageHash, ...preimage } = value;
    if (financialStatementPackageHash(preimage) !== packageHash
      || value.status !== "verified") fail("financial_statement_package_tampered");
    let historicalBusinessReport = value.businessReport;
    if (value.forecastStatus === "computed") {
      if (!value.cashForecast) fail("financial_statement_package_integrity");
      const forecast = value.cashForecast;
      const canonical = canonicalFinancialCashForecastSupplement({
        forecastAsOf: forecast.forecastAsOf,
        expectedInflowsNext30DaysMinor:
          forecast.expectedInflowsNext30DaysMinor,
        expectedOutflowsNext30DaysMinor:
          forecast.expectedOutflowsNext30DaysMinor,
        expectedInflowsNext31To90DaysMinor:
          forecast.expectedInflowsNext31To90DaysMinor,
        expectedOutflowsNext31To90DaysMinor:
          forecast.expectedOutflowsNext31To90DaysMinor,
        receivables: forecast.receivables,
        attestation: { accepted: true,
          noticeVersion: "financial-cash-forecast.v1" }
      }, { currency: value.currency, acceptedBy: value.consent.acceptedBy,
        acceptedAt: forecast.acceptedAt,
        period: forecast.forecastAsOf.slice(0, 10) });
      if (forecast.acceptedBy !== value.consent.acceptedBy
        || forecast.acceptedAt !== value.createdAt) {
        fail("financial_statement_package_integrity");
      }
      if (financialCouncilCanonicalHash(canonical) !==
        financialCouncilCanonicalHash(forecast)) {
        fail("financial_statement_package_integrity");
      }
      const cashFlow = value.businessReport.cashFlow;
      if (!cashFlow) fail("financial_statement_package_integrity");
      const { receivables: _receivables,
        expectedInflowsNext30DaysMinor: _inflows30,
        expectedOutflowsNext30DaysMinor: _outflows30,
        expectedInflowsNext31To90DaysMinor: _inflows90,
        expectedOutflowsNext31To90DaysMinor: _outflows90,
        ...historicalCashFlow } = cashFlow;
      historicalBusinessReport = { ...value.businessReport,
        cashFlow: { ...historicalCashFlow,
          forecast: { status: "not_computable" as const,
            reason: "source_statements_do_not_provide_forecast" as const } } };
    } else if (value.forecastStatus !== "not_computable"
      || value.cashForecast !== null
      || value.businessReport.cashFlow?.forecast?.status !== "not_computable") {
      fail("financial_statement_package_integrity");
    }
    const rebuilt = buildVerifiedFinancialStatementPackage({
      previewId: "integrity-check", workspaceId: value.workspaceId,
      status: "preview", expiresAt: value.createdAt,
      companyName: value.companyName, currency: value.currency,
      period: value.period, sourceFiles: value.sourceFiles,
      parserVersion: value.parserVersion,
      businessReport: historicalBusinessReport,
      reportInputHash: financialCouncilCanonicalHash(historicalBusinessReport),
      warnings: value.warnings,
      previewHash: `sha256:${"0".repeat(64)}`, createdAt: value.createdAt
    }, { packageId: value.packageId, consent: value.consent,
      cashForecast: value.cashForecast ?? null, createdAt: value.createdAt });
    if (financialCouncilCanonicalHash(rebuilt) !==
      financialCouncilCanonicalHash(value)) {
      fail("financial_statement_package_integrity");
    }
  } catch (error) {
    if (error instanceof FinancialStatementPackageRepositoryError) throw error;
    fail("financial_statement_package_integrity");
  }
}

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly packageId: string;
}

export class InMemoryFinancialStatementPackageRepository
implements FinancialStatementPackageRepository {
  private readonly previews = new Map<string, FinancialStatementPackagePreview>();
  private readonly packages = new Map<string, FinancialStatementPackage>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly committedPreviews = new Set<string>();
  private serial: Promise<void> = Promise.resolve();

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\0${id}`;
  }

  async appendPreview(preview: FinancialStatementPackagePreview): Promise<void> {
    assertPreview(preview);
    const key = this.key(preview.workspaceId, preview.previewId);
    if (this.previews.has(key)) fail("financial_statement_preview_conflict");
    this.previews.set(key, clone(preview));
  }

  async getPreview(workspaceId: string, previewId: string) {
    const value = this.previews.get(this.key(workspaceId, previewId));
    if (!value) return null;
    assertPreview(value);
    return clone(value);
  }

  async commitPreview(input: CommitFinancialStatementPackageInput) {
    let release!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const idempotencyKey = this.key(input.workspaceId,
        input.idempotencyKeyHash);
      const existingIdempotency = this.idempotency.get(idempotencyKey);
      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== input.requestHash) {
          fail("financial_statement_idempotency_conflict");
        }
        const replay = this.packages.get(this.key(input.workspaceId,
          existingIdempotency.packageId));
        if (!replay) fail("financial_statement_package_integrity");
        assertFinancialStatementPackage(replay);
        return { value: clone(replay), replayed: true };
      }
      const previewKey = this.key(input.workspaceId, input.previewId);
      const preview = this.previews.get(previewKey);
      if (!preview) fail("financial_statement_preview_not_found");
      assertPreview(preview);
      if (Date.parse(input.createdAt) >= Date.parse(preview.expiresAt)) {
        fail("financial_statement_preview_expired");
      }
      if (this.committedPreviews.has(previewKey)) {
        fail("financial_statement_preview_committed");
      }
      const value = buildVerifiedFinancialStatementPackage(preview, {
        packageId: input.packageId, consent: input.consent,
        cashForecast: input.cashForecast, createdAt: input.createdAt
      });
      const packageKey = this.key(input.workspaceId, input.packageId);
      if (this.packages.has(packageKey)) fail("financial_statement_package_conflict");
      this.packages.set(packageKey, value);
      this.idempotency.set(idempotencyKey, Object.freeze({
        requestHash: input.requestHash, packageId: input.packageId
      }));
      this.committedPreviews.add(previewKey);
      return { value: clone(value), replayed: false };
    } finally {
      release();
    }
  }

  async getVerified(workspaceId: string, packageId: string) {
    const value = this.packages.get(this.key(workspaceId, packageId));
    if (!value) return null;
    assertFinancialStatementPackage(value);
    return clone(value);
  }

  async getLatestVerified(workspaceId: string, input: { readonly limit: 1 }) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).length !== 1 || input.limit !== 1) {
      fail("financial_statement_input_invalid");
    }
    const latest = [...this.packages.values()].filter((value) =>
      value.workspaceId === workspaceId).sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt > right.createdAt ? -1 : 1;
      }
      return Buffer.compare(Buffer.from(right.packageId, "utf8"),
        Buffer.from(left.packageId, "utf8"));
    })[0];
    if (!latest) return null;
    assertFinancialStatementPackage(latest);
    return clone(latest);
  }

  async cleanupExpired(now: string): Promise<number> {
    let deleted = 0;
    for (const [key, preview] of this.previews) {
      if (!this.committedPreviews.has(key)
        && Date.parse(preview.expiresAt) <= Date.parse(now)) {
        this.previews.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
