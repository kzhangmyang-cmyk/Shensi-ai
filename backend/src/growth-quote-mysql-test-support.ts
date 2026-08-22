import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ensureCatalogMysqlSchema } from "./catalog-mysql-repository.js";
import { ensureProbabilityAssessmentMysqlSchema } from "./probability-assessment-mysql-repository.js";
import {
  ensureGrowthTemporalBarrierMysqlSchema,
  MysqlGrowthTemporalBarrier
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  ensureQuoteMysqlSchema,
  MysqlQuoteRepository
} from "./quote-mysql-repository.js";

function connectionOptions(url: URL) {
  return {
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    timezone: "Z" as const, dateStrings: true
  };
}

export function requireGrowthQuoteMysqlTestAdminUrl(): URL {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-quotes");
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-quotes:mysql-protocol");
  }
  return url;
}

export interface GrowthQuoteMysqlTestDatabase {
  databaseName: string;
  pool: mysql.Pool;
  connectionA: mysql.PoolConnection;
  connectionB: mysql.PoolConnection;
  barrier: MysqlGrowthTemporalBarrier;
  repository: MysqlQuoteRepository;
}

async function ensureLegacyProjectionSchema(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE customers (
    id VARCHAR(191) PRIMARY KEY, company VARCHAR(255) NOT NULL DEFAULT '',
    billing_address TEXT NULL, document_contact VARCHAR(255) NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE deals (
    id VARCHAR(191) PRIMARY KEY, customer_id VARCHAR(191) NOT NULL,
    owner_id VARCHAR(191) NOT NULL, team_id VARCHAR(191) NOT NULL,
    stage VARCHAR(32) NOT NULL, product VARCHAR(255) NOT NULL DEFAULT '',
    quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
    unit_price DECIMAL(20,2) NOT NULL DEFAULT 0,
    amount DECIMAL(20,2) NOT NULL DEFAULT 0,
    currency VARCHAR(12) NOT NULL DEFAULT 'CNY',
    amount_type VARCHAR(32) NOT NULL DEFAULT 'estimate',
    stage_changed_at DATETIME(3) NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE deal_events (
    id VARCHAR(191) PRIMARY KEY, deal_id VARCHAR(191) NOT NULL,
    event_type VARCHAR(32) NOT NULL, content TEXT NOT NULL,
    operator_id VARCHAR(191) NOT NULL, owner_id_snapshot VARCHAR(191) NULL,
    team_id_snapshot VARCHAR(191) NULL, customer_id_snapshot VARCHAR(191) NULL,
    lead_id_snapshot VARCHAR(191) NULL, handoff_id_snapshot VARCHAR(191) NULL,
    candidate_id_snapshot VARCHAR(191) NULL, amount_minor_snapshot BIGINT NULL,
    currency_snapshot VARCHAR(12) NULL, commercial_authority VARCHAR(32) NULL,
    quote_case_id_snapshot VARCHAR(191) NULL,
    quote_version_id_snapshot VARCHAR(191) NULL,
    commercial_amount_hash CHAR(71) NULL,
    deal_authority_revision_snapshot BIGINT UNSIGNED NULL,
    recorded_at DATETIME(3) NULL, temporal_sequence BIGINT UNSIGNED NULL,
    from_stage VARCHAR(32) NULL, to_stage VARCHAR(32) NULL,
    next_action TEXT NULL, next_action_at VARCHAR(100) NULL,
    related_document_id VARCHAR(191) NULL, created_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE trade_documents (
    id VARCHAR(191) PRIMARY KEY, customer_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL, revision INT NOT NULL,
    commercial_authority VARCHAR(32) NOT NULL,
    quote_case_id VARCHAR(191) NULL, quote_version_id VARCHAR(191) NULL,
    commercial_amount_hash CHAR(71) NULL,
    deal_authority_revision BIGINT UNSIGNED NULL,
    projection_state VARCHAR(32) NULL, quoted_amount_minor BIGINT NULL,
    quote_line_snapshot_json JSON NULL, quote_package_snapshot_json JSON NULL,
    recorded_at DATETIME(3) NULL, temporal_sequence BIGINT UNSIGNED NULL,
    doc_type VARCHAR(32) NOT NULL, title VARCHAR(255) NOT NULL,
    doc_number VARCHAR(255) NOT NULL, issue_date VARCHAR(32) NOT NULL,
    buyer VARCHAR(255) NOT NULL, buyer_address TEXT NULL,
    buyer_contact VARCHAR(255) NULL, seller VARCHAR(255) NOT NULL,
    seller_address TEXT NULL, currency VARCHAR(12) NOT NULL,
    incoterm VARCHAR(32) NULL, payment_term TEXT NULL,
    shipping_method VARCHAR(100) NULL, port_loading VARCHAR(100) NULL,
    port_discharge VARCHAR(100) NULL, validity_date VARCHAR(32) NULL,
    bank_info TEXT NULL, notes TEXT NULL, template_style VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL, audits_json JSON NOT NULL,
    send_records_json JSON NOT NULL, owner_id VARCHAR(191) NOT NULL,
    team_id VARCHAR(191) NOT NULL, items_json JSON NOT NULL,
    updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
}

export async function withGrowthQuoteMysqlTestDatabase<T>(
  run: (fixture: GrowthQuoteMysqlTestDatabase) => Promise<T>
): Promise<T> {
  const adminUrl = requireGrowthQuoteMysqlTestAdminUrl();
  const databaseName = `goodjob_growth_quote_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  let connectionA: mysql.PoolConnection | undefined;
  let connectionB: mysql.PoolConnection | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...connectionOptions(adminUrl),
      database: databaseName, connectionLimit: 6 });
    await ensureGrowthTemporalBarrierMysqlSchema(pool);
    await ensureCatalogMysqlSchema(pool);
    await ensureLegacyProjectionSchema(pool);
    await ensureProbabilityAssessmentMysqlSchema(pool);
    await ensureQuoteMysqlSchema(pool);
    connectionA = await pool.getConnection();
    connectionB = await pool.getConnection();
    assert.notEqual(connectionA.threadId, connectionB.threadId,
      "growth Quote gate requires two physical connections");
    const barrier = new MysqlGrowthTemporalBarrier(pool);
    return await run({ databaseName, pool, connectionA, connectionB,
      barrier, repository: new MysqlQuoteRepository(pool, barrier) });
  } finally {
    connectionB?.release();
    connectionA?.release();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
}
