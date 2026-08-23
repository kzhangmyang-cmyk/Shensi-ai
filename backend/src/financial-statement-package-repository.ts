import {
  financialStatementPackageHash,
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

function assertPackage(value: FinancialStatementPackage): void {
  const { packageHash, ...preimage } = value;
  if (financialStatementPackageHash(preimage) !== packageHash
    || value.status !== "verified") fail("financial_statement_package_tampered");
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
        assertPackage(replay);
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
      const preimage = {
        packageId: input.packageId, workspaceId: input.workspaceId,
        status: "verified" as const, companyName: preview.companyName,
        currency: preview.currency, period: preview.period,
        sourceFiles: preview.sourceFiles, parserVersion: preview.parserVersion,
        businessReport: preview.businessReport,
        reportInputHash: preview.reportInputHash, warnings: preview.warnings,
        consent: input.consent, createdAt: input.createdAt
      };
      const value = Object.freeze({ ...clone(preimage),
        packageHash: financialStatementPackageHash(preimage) });
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
    assertPackage(value);
    return clone(value);
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
