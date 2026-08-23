import type mysql from "mysql2/promise";
import {
  financialStatementPackageHash,
  type FinancialStatementPackage,
  type FinancialStatementPackagePreview
} from "./financial-statement-package.js";
import { financialCouncilCanonicalHash,
  financialCouncilCanonicalJson } from "./financial-council-domain.js";
import {
  FinancialStatementPackageRepositoryError,
  type CommitFinancialStatementPackageInput,
  type FinancialStatementPackageRepository
} from "./financial-statement-package-repository.js";

export const FINANCIAL_STATEMENT_PACKAGE_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS financial_statement_package_previews (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    preview_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    preview_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    preview_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    committed_package_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    PRIMARY KEY (workspace_id, preview_id),
    CONSTRAINT chk_financial_statement_preview_json CHECK (JSON_VALID(preview_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_statement_packages (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    package_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    package_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    package_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, package_id),
    UNIQUE KEY uk_financial_statement_package_hash (workspace_id, package_hash),
    CONSTRAINT chk_financial_statement_package_json CHECK (JSON_VALID(package_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_statement_package_idempotency (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    idempotency_key_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    package_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    response_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, idempotency_key_hash),
    CONSTRAINT fk_financial_statement_idempotency_package
      FOREIGN KEY (workspace_id, package_id)
      REFERENCES financial_statement_packages (workspace_id, package_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_statement_idempotency_json CHECK (JSON_VALID(response_json))
  ) ENGINE=InnoDB`
]);

function fail(code: string): never {
  throw new FinancialStatementPackageRepositoryError(code);
}

function sqlDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("financial_statement_timestamp_invalid");
  }
  return value.slice(0, 23).replace("T", " ");
}

function rows(result: unknown): Record<string, unknown>[] {
  return (result as [Record<string, unknown>[], unknown])[0];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  fail("financial_statement_package_integrity");
}

function parsePreview(row: Record<string, unknown>): FinancialStatementPackagePreview {
  try {
    const value = JSON.parse(text(row.preview_json)) as FinancialStatementPackagePreview;
    const { previewHash, ...preimage } = value;
    if (financialCouncilCanonicalHash(preimage) !== previewHash
      || previewHash !== text(row.preview_hash)) {
      fail("financial_statement_preview_tampered");
    }
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof FinancialStatementPackageRepositoryError) throw error;
    fail("financial_statement_preview_tampered");
  }
}

function parsePackage(row: Record<string, unknown>): FinancialStatementPackage {
  try {
    const value = JSON.parse(text(row.package_json)) as FinancialStatementPackage;
    const { packageHash, ...preimage } = value;
    if (financialStatementPackageHash(preimage) !== packageHash
      || packageHash !== text(row.package_hash)) {
      fail("financial_statement_package_tampered");
    }
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof FinancialStatementPackageRepositoryError) throw error;
    fail("financial_statement_package_tampered");
  }
}

export async function ensureFinancialStatementPackageMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  const connection = await pool.getConnection();
  const lockName = "shensi_financial_statement_package_schema_v2";
  try {
    const acquired = rows(await connection.query(
      "SELECT GET_LOCK(?, 30) AS acquired", [lockName]
    ))[0]?.acquired;
    if (Number(acquired) !== 1) fail("financial_statement_schema_lock_failed");
    for (const statement of FINANCIAL_STATEMENT_PACKAGE_MYSQL_SCHEMA_STATEMENTS) {
      await connection.query(statement);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName])
      .catch(() => undefined);
    connection.release();
  }
}

export class MysqlFinancialStatementPackageRepository
implements FinancialStatementPackageRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async appendPreview(preview: FinancialStatementPackagePreview): Promise<void> {
    const { previewHash, ...preimage } = preview;
    if (financialCouncilCanonicalHash(preimage) !== previewHash) {
      fail("financial_statement_preview_tampered");
    }
    await this.pool.query(
      `INSERT INTO financial_statement_package_previews
       (workspace_id, preview_id, preview_hash, preview_json, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [preview.workspaceId, preview.previewId, preview.previewHash,
        financialCouncilCanonicalJson(preview), sqlDate(preview.expiresAt)]
    );
  }

  async getPreview(workspaceId: string, previewId: string) {
    const found = rows(await this.pool.query(
      `SELECT preview_hash, preview_json
         FROM financial_statement_package_previews
        WHERE workspace_id = ? AND preview_id = ?`, [workspaceId, previewId]));
    return found[0] ? parsePreview(found[0]) : null;
  }

  async commitPreview(input: CommitFinancialStatementPackageInput) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const idempotency = rows(await connection.query(
        `SELECT request_hash, package_id, response_json
           FROM financial_statement_package_idempotency
          WHERE workspace_id = ? AND idempotency_key_hash = ? FOR UPDATE`,
        [input.workspaceId, input.idempotencyKeyHash]));
      if (idempotency[0]) {
        if (text(idempotency[0].request_hash) !== input.requestHash) {
          fail("financial_statement_idempotency_conflict");
        }
        const packageId = text(idempotency[0].package_id);
        const found = rows(await connection.query(
          `SELECT package_hash, package_json FROM financial_statement_packages
            WHERE workspace_id = ? AND package_id = ?`,
          [input.workspaceId, packageId]));
        if (!found[0]) fail("financial_statement_package_integrity");
        const value = parsePackage(found[0]);
        await connection.commit();
        return { value, replayed: true };
      }
      const previews = rows(await connection.query(
        `SELECT preview_hash, preview_json, expires_at, committed_package_id
           FROM financial_statement_package_previews
          WHERE workspace_id = ? AND preview_id = ? FOR UPDATE`,
        [input.workspaceId, input.previewId]));
      if (!previews[0]) fail("financial_statement_preview_not_found");
      const row = previews[0];
      const preview = parsePreview(row);
      if (row.committed_package_id !== null
        && row.committed_package_id !== undefined) {
        fail("financial_statement_preview_committed");
      }
      if (Date.parse(input.createdAt) >= Date.parse(preview.expiresAt)) {
        fail("financial_statement_preview_expired");
      }
      const preimage = { packageId: input.packageId,
        workspaceId: input.workspaceId, status: "verified" as const,
        companyName: preview.companyName, currency: preview.currency,
        period: preview.period, sourceFiles: preview.sourceFiles,
        parserVersion: preview.parserVersion,
        businessReport: preview.businessReport,
        reportInputHash: preview.reportInputHash, warnings: preview.warnings,
        consent: input.consent, createdAt: input.createdAt };
      const value = Object.freeze({ ...preimage,
        packageHash: financialStatementPackageHash(preimage) });
      await connection.query(
        `INSERT INTO financial_statement_packages
         (workspace_id, package_id, package_hash, package_json, created_at)
         VALUES (?, ?, ?, ?, ?)`, [input.workspaceId, input.packageId,
          value.packageHash, financialCouncilCanonicalJson(value),
          sqlDate(input.createdAt)]);
      await connection.query(
        `INSERT INTO financial_statement_package_idempotency
         (workspace_id, idempotency_key_hash, request_hash, package_id,
          response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [input.workspaceId, input.idempotencyKeyHash, input.requestHash,
          input.packageId, financialCouncilCanonicalJson(value),
          sqlDate(input.createdAt)]);
      await connection.query(
        `UPDATE financial_statement_package_previews
            SET committed_package_id = ?
          WHERE workspace_id = ? AND preview_id = ?`,
        [input.packageId, input.workspaceId, input.previewId]);
      await connection.commit();
      return { value, replayed: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getVerified(workspaceId: string, packageId: string) {
    const found = rows(await this.pool.query(
      `SELECT package_hash, package_json FROM financial_statement_packages
        WHERE workspace_id = ? AND package_id = ?`, [workspaceId, packageId]));
    return found[0] ? parsePackage(found[0]) : null;
  }

  async getLatestVerified(workspaceId: string, input: { readonly limit: 1 }) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).length !== 1 || input.limit !== 1) {
      fail("financial_statement_input_invalid");
    }
    const found = rows(await this.pool.query(
      `SELECT package_hash, package_json FROM financial_statement_packages
        WHERE workspace_id = ? ORDER BY created_at DESC, package_id DESC
        LIMIT 1`, [workspaceId]));
    return found[0] ? parsePackage(found[0]) : null;
  }

  async cleanupExpired(now: string): Promise<number> {
    const [result] = await this.pool.query(
      `DELETE FROM financial_statement_package_previews
        WHERE expires_at <= ? AND committed_package_id IS NULL`, [sqlDate(now)]);
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }
}
