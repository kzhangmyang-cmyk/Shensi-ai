import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import {
  CATALOG_MYSQL_SCHEMA_STATEMENTS,
  MysqlCatalogRepository,
  ensureCatalogMysqlSchema
} from "./catalog-mysql-repository.js";
import type {
  CommissionCatalogMigrationCommit,
  CreateCatalogItemCommand,
  CreatePricingPolicyDraftCommand,
  PackageVersionLifecycleCommand,
  PricingPolicyLifecycleCommand
} from "./catalog-repository.js";
import type {
  CatalogItem,
  PackageVersion,
  PricingPolicyVersion
} from "./catalog-domain.js";
import { MysqlGrowthTemporalBarrier } from "./growth-temporal-barrier-mysql-repository.js";

class FakeConnection {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly transactions: string[] = [];
  readonly queue: unknown[] = [];
  enqueue(rows: unknown) { this.queue.push(rows); }
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
    return [this.queue.shift() ?? { affectedRows: 1 }, []];
  }
  async beginTransaction() { this.transactions.push("begin"); }
  async commit() { this.transactions.push("commit"); }
  async rollback() { this.transactions.push("rollback"); }
  release() { this.transactions.push("release"); }
}

class FakePool extends FakeConnection {
  constructor(readonly connection = new FakeConnection()) { super(); }
  async getConnection() { return this.connection; }
}

class ExistingSchemaPool extends FakePool {
  private readonly columns = new Map<string, Map<string, string>>([
    ["catalog_items", new Map([["description", "NO"]])],
    ["pricing_policy_versions", new Map()],
    ["package_versions", new Map()], ["package_components", new Map()],
    ["catalog_command_receipts", new Map([["idempotency_key", "NO"]])]
  ]);

  override async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (/FROM information_schema\.columns/u.test(normalized)) {
      const table = String(values[0]);
      return [[...(this.columns.get(table) ?? new Map()).entries()].map(
        ([column_name, is_nullable]) => ({ column_name, is_nullable })
      ), []];
    }
    const add = /^ALTER TABLE (\w+) ADD COLUMN (recorded_at|temporal_sequence)/u
      .exec(normalized);
    if (add) this.columns.get(add[1]!)?.set(add[2]!, "YES");
    const modify = /^ALTER TABLE (\w+) MODIFY COLUMN recorded_at/u.exec(normalized);
    if (modify) {
      this.columns.get(modify[1]!)?.set("recorded_at", "NO");
      this.columns.get(modify[1]!)?.set("temporal_sequence", "NO");
    }
    if (/^ALTER TABLE catalog_command_receipts ADD COLUMN idempotency_key_hash/u
      .test(normalized)) {
      this.columns.get("catalog_command_receipts")
        ?.set("idempotency_key_hash", "YES");
    }
    if (/^ALTER TABLE catalog_command_receipts DROP PRIMARY KEY/u.test(normalized)) {
      this.columns.get("catalog_command_receipts")?.delete("idempotency_key");
      this.columns.get("catalog_command_receipts")
        ?.set("idempotency_key_hash", "NO");
    }
    if (/^ALTER TABLE catalog_items MODIFY COLUMN description TEXT NULL/u
      .test(normalized)) {
      this.columns.get("catalog_items")?.set("description", "YES");
    }
    return [{ affectedRows: 1 }, []];
  }
}

class LifecycleConnection extends FakeConnection {
  constructor(private readonly lifecycle: "activate" | "retire") { super(); }

  override async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (/^INSERT INTO growth_workspace_temporal_barriers/u.test(normalized)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM growth_workspace_temporal_barriers/u.test(normalized)) {
      return [[{ last_recorded_at: "2026-08-09 08:00:00.000", temporal_sequence: 20 }], []];
    }
    if (/CURRENT_TIMESTAMP\(3\)/u.test(normalized)) {
      return [[{ current_timestamp_3: "2026-08-09 08:00:00.000" }], []];
    }
    if (/^UPDATE growth_workspace_temporal_barriers/u.test(normalized)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM catalog_command_receipts/u.test(normalized)) return [[], []];
    if (/^SELECT catalog_item_id FROM pricing_policy_versions/u.test(normalized)) {
      return [[{ catalog_item_id: "item-1" }], []];
    }
    if (/^SELECT package_catalog_item_id FROM package_versions/u.test(normalized)) {
      return [[{ package_catalog_item_id: "package-item-1" }], []];
    }
    if (/^SELECT \* FROM catalog_items/u.test(normalized)) {
      return [[catalogRow({ id: String(values[1] ?? "item-1"), item_type: "package" })], []];
    }
    if (/pricing_policy_versions/u.test(normalized)) {
      return [[pricingRow({ policy_status: this.lifecycle === "retire" ? "active" : "draft" })], []];
    }
    if (/package_versions/u.test(normalized)) {
      return [[packageRow({ package_status: this.lifecycle === "retire" ? "active" : "draft" })], []];
    }
    if (/FROM package_components/u.test(normalized)) return [[], []];
    return [{ affectedRows: 1 }, []];
  }
}

class ReceiptConnection extends FakeConnection {
  private sequence = 0;
  private readonly items = new Map<string, Record<string, unknown>>();
  private readonly receipts = new Map<string, Record<string, unknown>>();

  override async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (/^INSERT INTO growth_workspace_temporal_barriers/u.test(normalized)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM growth_workspace_temporal_barriers/u.test(normalized)) {
      return [[{
        last_recorded_at: "2026-08-09 08:00:00.000",
        temporal_sequence: this.sequence
      }], []];
    }
    if (/CURRENT_TIMESTAMP\(3\)/u.test(normalized)) {
      return [[{ current_timestamp_3: "2026-08-09 08:00:00.000" }], []];
    }
    if (/^UPDATE growth_workspace_temporal_barriers/u.test(normalized)) {
      this.sequence = Number(values[1]);
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT request_hash,resource_kind,resource_id/u.test(normalized)) {
      const receipt = this.receipts.get(values.slice(0, 4).join("\u0000"));
      return [receipt ? [receipt] : [], []];
    }
    if (/^INSERT INTO catalog_command_receipts/u.test(normalized)) {
      this.receipts.set(values.slice(0, 4).join("\u0000"), {
        request_hash: values[4], resource_kind: values[5], resource_id: values[6]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT \* FROM catalog_items/u.test(normalized)) {
      const workspaceId = String(values[0]);
      const id = String(values[1]);
      const code = values[2] === undefined ? null : String(values[2]);
      const rows = [...this.items.values()].filter((row) =>
        row.workspace_id === workspaceId && (row.id === id || row.code === code));
      return [rows, []];
    }
    if (/^INSERT INTO catalog_items/u.test(normalized)) {
      this.items.set(`${values[0]}\u0000${values[1]}`, catalogRow({
        workspace_id: values[0], id: values[1], item_type: values[2], code: values[3],
        name: values[4], description: values[5], unit: values[6],
        item_status: values[7], revision: values[8], created_by: values[9],
        created_at: values[10], updated_at: values[11]
      }));
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE catalog_items SET name/u.test(normalized)) {
      const mapKey = `${values[7]}\u0000${values[8]}`;
      const current = this.items.get(mapKey)!;
      this.items.set(mapKey, {
        ...current, name: values[0], description: values[1], unit: values[2],
        revision: values[3], updated_at: values[4]
      });
      return [{ affectedRows: 1 }, []];
    }
    return [{ affectedRows: 1 }, []];
  }
}

class FailingEmptyStampConnection extends FakeConnection {
  override async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (/^UPDATE package_versions SET recorded_at/u.test(normalized)) {
      this.calls.push({ sql: normalized, values });
      throw new Error("stamp_write_failed");
    }
    return super.query(sql, values);
  }
}

function asPool(pool: FakePool) { return pool as unknown as mysql.Pool; }

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1", workspace_id: "team-a", item_type: "service",
    code: "SVC-001", name: "诊断服务", description: "获客诊断",
    unit: "次", item_status: "active", revision: 1,
    created_by: "admin-1", created_at: "2026-08-09 08:00:00.001",
    updated_at: "2026-08-09 08:00:00.001",
    last_idempotency_key: "catalog-create-0001",
    last_request_hash: "sha256:catalog-create-0001",
    ...overrides
  };
}

function enqueueBarrier(pool: FakePool, sequence: number, withReceipt = true) {
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{
    last_recorded_at: "2026-08-09 08:00:00.000",
    temporal_sequence: sequence
  }]);
  pool.connection.enqueue([{
    current_timestamp_3: "2026-08-09 08:00:00.000"
  }]);
  pool.connection.enqueue({ affectedRows: 1 });
  if (withReceipt) pool.connection.enqueue([]);
}

function pricingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1", workspace_id: "team-a", catalog_item_id: "item-1",
    version: 1, package_version_id: null, currency: "CNY",
    list_unit_price_minor: 10_000, unit_standard_cost_minor: 4_000,
    default_order_delivery_cost_minor: 0, default_order_sales_cost_minor: 0,
    default_order_service_cost_minor: 0, absolute_floor_unit_price_minor: 4_000,
    standard_discount_limit_bps: 500, absolute_discount_limit_bps: 1_000,
    target_gross_margin_bps: 5_000, absolute_minimum_gross_margin_bps: 2_000,
    standard_payment_term_days: 30, absolute_payment_term_days: 60,
    approval_thresholds_json: JSON.stringify({
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 7_000, manualEscalationEnabled: true
    }),
    surcharge_policies_json: "[]", gift_policies_json: "[]",
    valid_from: "2026-08-09 08:00:00.000", valid_to: null,
    policy_status: "draft", source: "native",
    capability_registry_version: "growth-capabilities.v1", revision: 1,
    created_by: "admin-1", created_at: "2026-08-09 08:00:00.000",
    ...overrides
  };
}

function packageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "package-1", workspace_id: "team-a",
    package_catalog_item_id: "package-item-1", version: 1, currency: "CNY",
    package_status: "draft", valid_from: "2026-08-09 08:00:00.000",
    valid_to: null, revision: 1, created_by: "admin-1",
    created_at: "2026-08-09 08:00:00.000",
    updated_at: "2026-08-09 08:00:00.000", ...overrides
  };
}

function policyValue(overrides: Record<string, unknown> = {}): PricingPolicyVersion {
  return {
    id: "policy-1", workspaceId: "team-a", catalogItemId: "item-1", version: 1,
    packageVersionId: null, currency: "CNY", listUnitPriceMinor: 10_000,
    unitStandardCostMinor: 4_000, defaultOrderDeliveryCostMinor: 0,
    defaultOrderSalesCostMinor: 0, defaultOrderServiceCostMinor: 0,
    absoluteFloorUnitPriceMinor: 4_000, standardDiscountLimitBps: 500,
    absoluteDiscountLimitBps: 1_000, targetGrossMarginBps: 5_000,
    absoluteMinimumGrossMarginBps: 2_000, standardPaymentTermDays: 30,
    absolutePaymentTermDays: 60,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 7_000, manualEscalationEnabled: true
    },
    surchargePolicies: [], giftPolicies: [],
    validFrom: "2026-08-09T08:00:00.000Z", validTo: null,
    status: "draft", source: "native",
    capabilityRegistryVersion: "growth-capabilities.v1", revision: 1,
    createdBy: "admin-1", createdAt: "2026-08-09T08:00:00.000Z",
    ...overrides
  } as PricingPolicyVersion;
}

function testHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function mysqlMigrationCommit(
  times: Readonly<{
    startedAt: string;
    completedAt: string;
    migratedAt: string;
  }>
): CommissionCatalogMigrationCommit {
  const snapshot = ["object", []] as const;
  const snapshotHash = testHash(snapshot);
  return {
    run: {
      id: "offset-run", workspaceId: "team-a", actorId: "admin-1",
      idempotencyKey: "offset-run-key",
      inputSnapshotHash: testHash([
        "commission-catalog-migration-input.v1", "team-a", [snapshot]
      ]),
      startedAt: times.startedAt, completedAt: times.completedAt,
      status: "completed", scanned: 1, migrated: 1, repairRequired: 0,
      reportHash: testHash([
        "commission-catalog-migration-report.v1", "team-a",
        [["offset-product", "migrated", "migrated", snapshotHash]]
      ]),
      items: [{
        workspaceId: "team-a", commissionProductId: "offset-product",
        status: "migrated", code: "migrated", snapshot, snapshotHash,
        catalogItemId: "offset-migration-item",
        pricingPolicyVersionId: "offset-migration-policy"
      }]
    },
    entries: [{
      item: {
        id: "offset-migration-item", workspaceId: "team-a", type: "service",
        code: "OFFSET-MIG", name: "offset migration", description: "", unit: "次",
        status: "active", revision: 1, createdBy: "admin-1",
        createdAt: "2026-08-09T08:00:00.000Z",
        updatedAt: "2026-08-09T08:00:00.000Z"
      },
      pricingPolicy: policyValue({
        id: "offset-migration-policy", catalogItemId: "offset-migration-item"
      }),
      link: {
        workspaceId: "team-a", commissionProductId: "offset-product",
        catalogItemId: "offset-migration-item",
        pricingPolicyVersionId: "offset-migration-policy",
        migratedAt: times.migratedAt
      }
    }]
  };
}

test("catalog schema uses dedicated append-oriented tables", async () => {
  const pool = new ExistingSchemaPool();
  await ensureCatalogMysqlSchema(asPool(pool));
  const schemaSql = pool.calls.map((call) => call.sql).join("\n");
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS catalog_items/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS pricing_policy_versions/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS package_versions/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS package_components/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS catalog_command_receipts/u);
  const receiptSchema = pool.calls.find((call) =>
    /CREATE TABLE IF NOT EXISTS catalog_command_receipts/u.test(call.sql)
  )!.sql;
  assert.match(
    receiptSchema,
    /idempotency_key_hash CHAR\(71\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/u
  );
  assert.doesNotMatch(receiptSchema, /\bidempotency_key VARCHAR/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS commission_product_catalog_links/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS commission_catalog_migration_runs/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS commission_catalog_migration_items/u);
  assert.match(schemaSql, /FOREIGN KEY \(workspace_id, catalog_item_id\)/u);
  assert.match(schemaSql, /FOREIGN KEY \(workspace_id, package_version_id\)/u);
  assert.match(schemaSql, /FOREIGN KEY \(workspace_id, pricing_policy_version_id\)/u);
  assert.match(schemaSql, /FOREIGN KEY \(workspace_id, migration_run_id\)/u);
  assert.match(schemaSql, /snapshot_json LONGTEXT NOT NULL/u);
  assert.match(schemaSql, /JSON_VALID\(snapshot_json\)/u);
  assert.doesNotMatch(schemaSql, /replaceRows|persistAll/u);
});

test("catalog schema upgrades prerequisite tables and repeats idempotently", async () => {
  const pool = new ExistingSchemaPool();
  await ensureCatalogMysqlSchema(asPool(pool));
  const firstRunCount = pool.calls.length;
  await ensureCatalogMysqlSchema(asPool(pool));
  const firstRunSql = pool.calls.slice(0, firstRunCount).map((call) => call.sql);
  const sql = firstRunSql.join("\n");
  for (const table of [
    "catalog_items", "pricing_policy_versions", "package_versions",
    "package_components"
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN recorded_at`, "u"));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN temporal_sequence`, "u"));
  }
  assert.match(sql, /SET recorded_at = COALESCE\(recorded_at,updated_at\)/u);
  assert.match(sql, /SET recorded_at = COALESCE\(recorded_at,created_at\)/u);
  assert.match(sql, /temporal_sequence = COALESCE\([^\n]*,0\)/u);
  assert.equal(
    pool.calls.slice(firstRunCount).some((call) => / ADD COLUMN /u.test(call.sql)),
    false
  );
});

test("catalog schema creates and upgrades nullable descriptions idempotently", async () => {
  const pool = new ExistingSchemaPool();
  await ensureCatalogMysqlSchema(asPool(pool));
  const firstRunCount = pool.calls.length;
  await ensureCatalogMysqlSchema(asPool(pool));

  const create = CATALOG_MYSQL_SCHEMA_STATEMENTS.find((statement) =>
    /CREATE TABLE IF NOT EXISTS catalog_items/u.test(statement)
  );
  assert.match(create ?? "", /description TEXT NULL/u);
  assert.equal(
    pool.calls.slice(0, firstRunCount).filter((call) =>
      /^ALTER TABLE catalog_items MODIFY COLUMN description TEXT NULL/u
        .test(call.sql)
    ).length,
    1
  );
  assert.equal(
    pool.calls.slice(firstRunCount).some((call) =>
      /^ALTER TABLE catalog_items MODIFY COLUMN description TEXT NULL/u
        .test(call.sql)
    ),
    false
  );
});

test("catalog schema migrates legacy raw receipt keys to fixed ASCII hashes once", async () => {
  const pool = new ExistingSchemaPool();
  await ensureCatalogMysqlSchema(asPool(pool));
  const firstRunCount = pool.calls.length;
  await ensureCatalogMysqlSchema(asPool(pool));
  const first = pool.calls.slice(0, firstRunCount).map((call) => call.sql).join("\n");
  const second = pool.calls.slice(firstRunCount).map((call) => call.sql).join("\n");
  assert.match(
    first,
    /ALTER TABLE catalog_command_receipts ADD COLUMN idempotency_key_hash CHAR\(71\)/u
  );
  assert.match(
    first,
    /SET idempotency_key_hash = CONCAT\('sha256:',\s*SHA2\(CAST\(idempotency_key AS BINARY\),256\)\)/u
  );
  assert.match(first, /DROP PRIMARY KEY[\s\S]*DROP COLUMN idempotency_key/u);
  assert.doesNotMatch(second, /ADD COLUMN idempotency_key_hash|DROP COLUMN idempotency_key/u);
});

test("catalog schema deterministically upgrades and closes the pricing source enum", async () => {
  const pool = new ExistingSchemaPool();
  await ensureCatalogMysqlSchema(asPool(pool));
  const firstRunCount = pool.calls.length;
  await ensureCatalogMysqlSchema(asPool(pool));

  const firstRun = pool.calls.slice(0, CATALOG_MYSQL_SCHEMA_STATEMENTS.length);
  const secondRun = pool.calls.slice(
    firstRunCount, firstRunCount + CATALOG_MYSQL_SCHEMA_STATEMENTS.length
  );
  assert.deepEqual(secondRun, firstRun);

  const sourceStatements = firstRun
    .map((call) => call.sql)
    .filter((sql) => /pricing_policy_versions/u.test(sql) && /\bsource\b/u.test(sql));
  assert.equal(sourceStatements.length, 4);
  assert.match(sourceStatements[0]!, /CREATE TABLE IF NOT EXISTS pricing_policy_versions/u);
  assert.match(
    sourceStatements[0]!,
    /source ENUM\('native','legacy_commission_product'\) NOT NULL/u
  );
  assert.equal(
    sourceStatements[1],
    "ALTER TABLE pricing_policy_versions MODIFY COLUMN source "
      + "ENUM('manual','native','legacy_commission_product') NOT NULL"
  );
  assert.equal(
    sourceStatements[2],
    "UPDATE pricing_policy_versions SET source = 'native' WHERE source = 'manual'"
  );
  assert.equal(
    sourceStatements[3],
    "ALTER TABLE pricing_policy_versions MODIFY COLUMN source "
      + "ENUM('native','legacy_commission_product') NOT NULL"
  );
  assert.doesNotMatch(sourceStatements.at(-1)!, /manual/u);
});

test("mysql migration commit rejects cross-workspace references before I/O", async () => {
  const pool = new FakePool();
  const repository = new MysqlCatalogRepository(asPool(pool));
  const snapshot = ["object", []] as const;
  const snapshotHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot)).digest("hex")}` as const;
  const inputSnapshotHash = `sha256:${createHash("sha256").update(JSON.stringify([
    "commission-catalog-migration-input.v1", "team-a", [snapshot]
  ])).digest("hex")}` as const;
  const reportHash = `sha256:${createHash("sha256").update(JSON.stringify([
    "commission-catalog-migration-report.v1", "team-a",
    [["cp-1", "migrated", "migrated", snapshotHash]]
  ])).digest("hex")}` as const;
  const commit = {
    run: {
      id: "run-1", workspaceId: "team-a", actorId: "admin-1",
      idempotencyKey: "invalid-commit", inputSnapshotHash,
      startedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:00.000Z", status: "completed",
      scanned: 1, migrated: 1, repairRequired: 0, reportHash,
      items: [{
        workspaceId: "team-a", commissionProductId: "cp-1",
        status: "migrated", code: "migrated", snapshot, snapshotHash,
        catalogItemId: "item-1", pricingPolicyVersionId: "policy-1"
      }]
    },
    entries: [{
      item: { id: "item-1", workspaceId: "team-b" },
      pricingPolicy: {
        id: "policy-1", workspaceId: "team-a", catalogItemId: "item-1"
      },
      link: {
        workspaceId: "team-a", commissionProductId: "cp-1",
        catalogItemId: "item-1", pricingPolicyVersionId: "policy-1"
      }
    }]
  } as CommissionCatalogMigrationCommit;
  await assert.rejects(
    () => repository.commitCommissionCatalogMigration(commit),
    { code: "invalid_commission_catalog_migration_commit" }
  );
  assert.equal(pool.calls.length, 0);
  assert.equal(pool.connection.transactions.length, 0);
});

test("mysql migration commit rejects a false existing-authority claim before writes", async () => {
  const pool = new FakePool();
  pool.connection.enqueue([]);
  pool.connection.enqueue([{
    workspace_id: "team-a", commission_product_id: "cp-1",
    catalog_item_id: "actual-item", pricing_policy_version_id: "policy-1",
    item_id: "actual-item", policy_id: "policy-1",
    policy_catalog_item_id: "actual-item"
  }]);
  const snapshot = ["object", []] as const;
  const snapshotHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot)).digest("hex")}` as const;
  const commit = {
    run: {
      id: "run-existing-claim", workspaceId: "team-a", actorId: "admin-1",
      idempotencyKey: "existing-claim", inputSnapshotHash:
        `sha256:${createHash("sha256").update(JSON.stringify([
          "commission-catalog-migration-input.v1", "team-a", [snapshot]
        ])).digest("hex")}`,
      startedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:00.000Z", status: "completed",
      scanned: 1, migrated: 1, repairRequired: 0,
      reportHash: `sha256:${createHash("sha256").update(JSON.stringify([
        "commission-catalog-migration-report.v1", "team-a",
        [["cp-1", "migrated", "migrated", snapshotHash]]
      ])).digest("hex")}`,
      items: [{
        workspaceId: "team-a", commissionProductId: "cp-1",
        status: "migrated", code: "migrated", snapshot, snapshotHash,
        catalogItemId: "claimed-item", pricingPolicyVersionId: "policy-1"
      }]
    },
    entries: []
  } as CommissionCatalogMigrationCommit;
  const repository = new MysqlCatalogRepository(asPool(pool));
  await assert.rejects(
    () => repository.commitCommissionCatalogMigration(commit),
    { code: "invalid_commission_catalog_migration_commit" }
  );
  assert.deepEqual(pool.connection.transactions, ["begin", "rollback", "release"]);
  assert.equal(
    pool.connection.calls.some((call) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(call.sql)),
    false
  );
});

test("mysql migration result params find and replay share canonical UTC bytes", async () => {
  const pool = new FakePool();
  pool.connection.enqueue([]);
  const repository = new MysqlCatalogRepository(asPool(pool));
  const commit = mysqlMigrationCommit({
    startedAt: "2026-08-09T16:00:00.123+08:00",
    completedAt: "2026-08-10T17:00:00.456+08:00",
    migratedAt: "2026-08-11T18:00:00.789+08:00"
  });
  const result = await repository.commitCommissionCatalogMigration(commit);
  assert.equal(result.startedAt, "2026-08-09T08:00:00.123Z");
  assert.equal(result.completedAt, "2026-08-10T09:00:00.456Z");
  const runInsert = pool.connection.calls.find((call) =>
    /^INSERT INTO commission_catalog_migration_runs/u.test(call.sql)
  )!;
  assert.equal(runInsert.values[5], "2026-08-09 08:00:00.123");
  assert.equal(runInsert.values[6], "2026-08-10 09:00:00.456");
  const linkInsert = pool.connection.calls.find((call) =>
    /^INSERT INTO commission_product_catalog_links/u.test(call.sql)
  )!;
  assert.equal(linkInsert.values[4], "2026-08-11 10:00:00.789");

  const runRow = {
    id: commit.run.id, workspace_id: "team-a", actor_id: "admin-1",
    idempotency_key: commit.run.idempotencyKey,
    input_snapshot_hash: commit.run.inputSnapshotHash,
    started_at: "2026-08-09T16:00:00.123+08:00",
    completed_at: "2026-08-10T17:00:00.456+08:00",
    run_status: "completed", scanned: 1, migrated: 1, repair_required: 0,
    report_hash: commit.run.reportHash
  };
  const itemRow = {
    workspace_id: "team-a", migration_run_id: commit.run.id,
    commission_product_id: "offset-product", item_status: "migrated",
    result_code: "migrated", snapshot_json: JSON.stringify(
      commit.run.items[0]!.snapshot
    ), snapshot_hash: commit.run.items[0]!.snapshotHash,
    catalog_item_id: "offset-migration-item",
    pricing_policy_version_id: "offset-migration-policy"
  };
  pool.connection.enqueue([runRow]);
  pool.connection.enqueue([itemRow]);
  const replay = await repository.commitCommissionCatalogMigration(commit);
  assert.equal(replay.startedAt, "2026-08-09T08:00:00.123Z");
  assert.equal(replay.completedAt, "2026-08-10T09:00:00.456Z");

  pool.enqueue([{
    workspace_id: "team-a", commission_product_id: "offset-product",
    catalog_item_id: "offset-migration-item",
    pricing_policy_version_id: "offset-migration-policy",
    migrated_at: "2026-08-11T18:00:00.789+08:00"
  }]);
  assert.equal((await repository.findCommissionProductLink(
    "team-a", "offset-product"
  ))?.migratedAt, "2026-08-11T10:00:00.789Z");
  pool.enqueue([runRow]);
  pool.enqueue([itemRow]);
  assert.equal((await repository.findCommissionCatalogMigrationRun(
    "team-a", commit.run.idempotencyKey
  ))?.completedAt, "2026-08-10T09:00:00.456Z");
});

test("mysql rejects canonical instants outside DATETIME range before I/O", async () => {
  const upperRollover = "9999-12-31T23:59:59.999-23:59";
  const lowerRollover = "1000-01-01T00:00:00.000+23:59";
  const item: CatalogItem = {
    id: "range-item", workspaceId: "team-a", type: "service", code: "RANGE",
    name: "range", description: "", unit: "次", status: "active", revision: 1,
    createdBy: "admin-1", createdAt: upperRollover,
    updatedAt: "2026-08-09T08:00:00.000Z"
  };
  const version: PackageVersion = {
    id: "range-package", workspaceId: "team-a",
    packageCatalogItemId: "range-item", version: 1, currency: "CNY",
    status: "draft", validFrom: lowerRollover, validTo: null, revision: 1,
    createdBy: "admin-1", createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  };
  const itemPool = new FakePool();
  const policyPool = new FakePool();
  const packagePool = new FakePool();
  const results = await Promise.allSettled([
    new MysqlCatalogRepository(asPool(itemPool)).appendCatalogItem(item),
    new MysqlCatalogRepository(asPool(policyPool)).appendPricingPolicyVersion(
      policyValue({ id: "range-policy", validFrom: upperRollover })
    ),
    new MysqlCatalogRepository(asPool(packagePool)).appendPackageVersion(version)
  ]);
  assert.deepEqual(results.map((result) => result.status), [
    "rejected", "rejected", "rejected"
  ]);
  assert.equal(itemPool.calls.length, 0);
  assert.equal(policyPool.calls.length, 0);
  assert.equal(packagePool.calls.length, 0);
});

test("mysql catalog reads are workspace-scoped and clone parsed JSON", async () => {
  const pool = new FakePool();
  pool.enqueue([{
    id: "policy-1", workspace_id: "team-a", catalog_item_id: "item-1",
    version: 1, package_version_id: null, currency: "CNY",
    list_unit_price_minor: 100, unit_standard_cost_minor: 20,
    default_order_delivery_cost_minor: 0, default_order_sales_cost_minor: 0,
    default_order_service_cost_minor: 0, absolute_floor_unit_price_minor: 20,
    standard_discount_limit_bps: 0, absolute_discount_limit_bps: 0,
    target_gross_margin_bps: 0, absolute_minimum_gross_margin_bps: 0,
    standard_payment_term_days: 0, absolute_payment_term_days: 0,
    approval_thresholds_json: JSON.stringify({
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 0,
      manualEscalationEnabled: false
    }),
    surcharge_policies_json: JSON.stringify([{
      kind: "region", condition: "CN-FJ",
      fixedAmountMinor: 1_000, unitAmountMinor: 0
    }]),
    gift_policies_json: "[]", valid_from: "2026-08-09T08:00:00.000Z",
    valid_to: null, status: "draft", source: "native",
    capability_registry_version: "growth-capabilities.v1", revision: 1,
    created_by: "admin-1", created_at: "2026-08-09T08:00:00.000Z"
  }]);
  const repository = new MysqlCatalogRepository(asPool(pool));
  const policy = await repository.findPricingPolicyVersion("team-a", "policy-1");
  assert.ok(policy);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.source, "native");
  assert.equal(policy.approvalThresholds.manualEscalationEnabled, false);
  assert.deepEqual(policy.surchargePolicies, [{
    kind: "region", condition: "CN-FJ",
    fixedAmountMinor: 1_000, unitAmountMinor: 0
  }]);
  assert.deepEqual(pool.calls.at(-1)?.values, ["team-a", "policy-1"]);
  assert.match(pool.calls.at(-1)!.sql, /workspace_id = \? AND id = \?/u);
});

test("mysql policy boundaries reject full unknown and retired manual shapes before I/O", async () => {
  for (const invalid of [
    { ...policyValue(), source: "manual" },
    { ...policyValue(), futureRule: true }
  ]) {
    const pool = new FakePool();
    const repository = new MysqlCatalogRepository(asPool(pool));
    await assert.rejects(
      () => repository.appendPricingPolicyVersion(invalid as PricingPolicyVersion),
      { code: "invalid_pricing_policy_version" }
    );
    assert.equal(pool.calls.length, 0);
  }

  const pool = new FakePool();
  pool.enqueue([pricingRow({ source: "manual" })]);
  const repository = new MysqlCatalogRepository(asPool(pool));
  await assert.rejects(
    () => repository.findPricingPolicyVersion("team-a", "policy-1"),
    { code: "invalid_pricing_policy_version" }
  );
});

test("mysql policy write and read reject strict scalar and RFC3339 boundary violations", async () => {
  for (const invalid of [
    policyValue({ listUnitPriceMinor: 0 }),
    policyValue({ absoluteMinimumGrossMarginBps: 10_000 }),
    policyValue({ validFrom: "2026-08-09" }),
    policyValue({ validTo: "2026-08-10" }),
    policyValue({ validFrom: "2026-02-30T08:00:00.000Z" }),
    policyValue({ validFrom: new Date("2026-08-09T08:00:00.000Z") })
  ]) {
    const pool = new FakePool();
    const repository = new MysqlCatalogRepository(asPool(pool));
    await assert.rejects(
      () => repository.appendPricingPolicyVersion(invalid),
      { code: "invalid_pricing_policy_version" }
    );
    assert.equal(pool.calls.length, 0);
  }
  for (const invalidRow of [
    pricingRow({ list_unit_price_minor: 0 }),
    pricingRow({ absolute_minimum_gross_margin_bps: 10_000 }),
    pricingRow({ valid_from: "2026-08-09" })
  ]) {
    const pool = new FakePool();
    pool.enqueue([invalidRow]);
    const repository = new MysqlCatalogRepository(asPool(pool));
    await assert.rejects(
      () => repository.findPricingPolicyVersion("team-a", "policy-1"),
      { code: "invalid_pricing_policy_version" }
    );
  }
});

test("mysql item policy and package timestamps normalize RFC3339 offsets to UTC parameters", async () => {
  const offset = "2026-08-09T16:00:00.123+08:00";
  const offsetEnd = "2026-08-10T16:00:00.456+08:00";

  const itemPool = new FakePool();
  const item = await new MysqlCatalogRepository(asPool(itemPool)).appendCatalogItem({
    id: "offset-item", workspaceId: "team-a", type: "service", code: "OFFSET",
    name: "offset", description: "", unit: "次", status: "active", revision: 1,
    createdBy: "admin-1", createdAt: offset, updatedAt: offsetEnd
  });
  assert.deepEqual(itemPool.calls[0]!.values.slice(10, 14), [
    "2026-08-09 08:00:00.123", "2026-08-10 08:00:00.456",
    "2026-08-10 08:00:00.456", 0
  ]);
  assert.equal(item.createdAt, "2026-08-09T08:00:00.123Z");
  assert.equal(item.updatedAt, "2026-08-10T08:00:00.456Z");

  const policyPool = new FakePool();
  const policy = await new MysqlCatalogRepository(asPool(policyPool)).appendPricingPolicyVersion(
    policyValue({ validFrom: offset, validTo: offsetEnd, createdAt: offset })
  );
  assert.equal(policyPool.calls[0]!.values[21], "2026-08-09 08:00:00.123");
  assert.equal(policyPool.calls[0]!.values[22], "2026-08-10 08:00:00.456");
  assert.equal(policyPool.calls[0]!.values[28], "2026-08-09 08:00:00.123");
  assert.equal(policyPool.calls[0]!.values[29], "2026-08-09 08:00:00.123");
  assert.equal(policy.validFrom, "2026-08-09T08:00:00.123Z");
  assert.equal(policy.validTo, "2026-08-10T08:00:00.456Z");
  assert.equal(policy.createdAt, "2026-08-09T08:00:00.123Z");

  const packagePool = new FakePool();
  const version = await new MysqlCatalogRepository(asPool(packagePool)).appendPackageVersion({
    id: "offset-package", workspaceId: "team-a",
    packageCatalogItemId: "package-item-1", version: 1, currency: "CNY",
    status: "draft", validFrom: offset, validTo: offsetEnd, revision: 1,
    createdBy: "admin-1", createdAt: offset, updatedAt: offsetEnd
  });
  assert.deepEqual(packagePool.calls[0]!.values.slice(6, 14), [
    "2026-08-09 08:00:00.123", "2026-08-10 08:00:00.456", 1, "admin-1",
    "2026-08-09 08:00:00.123", "2026-08-10 08:00:00.456",
    "2026-08-10 08:00:00.456", 0
  ]);
  assert.equal(version.validFrom, "2026-08-09T08:00:00.123Z");
  assert.equal(version.validTo, "2026-08-10T08:00:00.456Z");
  assert.equal(version.createdAt, "2026-08-09T08:00:00.123Z");
  assert.equal(version.updatedAt, "2026-08-10T08:00:00.456Z");
});

test("mysql item policy and package reads normalize offset timestamps to UTC", async () => {
  const itemPool = new FakePool();
  itemPool.enqueue([catalogRow({
    created_at: "2026-08-09T16:00:00.123+08:00",
    updated_at: "2026-08-10T16:00:00.456+08:00"
  })]);
  const item = await new MysqlCatalogRepository(asPool(itemPool))
    .findCatalogItem("team-a", "item-1");
  assert.equal(item?.createdAt, "2026-08-09T08:00:00.123Z");
  assert.equal(item?.updatedAt, "2026-08-10T08:00:00.456Z");

  const policyPool = new FakePool();
  policyPool.enqueue([pricingRow({
    valid_from: "2026-08-09T16:00:00.123+08:00",
    valid_to: "2026-08-10T16:00:00.456+08:00",
    created_at: "2026-08-09T16:00:00.123+08:00"
  })]);
  const policy = await new MysqlCatalogRepository(asPool(policyPool))
    .findPricingPolicyVersion("team-a", "policy-1");
  assert.equal(policy?.validFrom, "2026-08-09T08:00:00.123Z");
  assert.equal(policy?.validTo, "2026-08-10T08:00:00.456Z");
  assert.equal(policy?.createdAt, "2026-08-09T08:00:00.123Z");

  const packagePool = new FakePool();
  packagePool.enqueue([packageRow({
    valid_from: "2026-08-09T16:00:00.123+08:00",
    valid_to: "2026-08-10T16:00:00.456+08:00",
    created_at: "2026-08-09T16:00:00.123+08:00",
    updated_at: "2026-08-10T16:00:00.456+08:00"
  })]);
  const version = await new MysqlCatalogRepository(asPool(packagePool))
    .findPackageVersion("team-a", "package-1");
  assert.equal(version?.validFrom, "2026-08-09T08:00:00.123Z");
  assert.equal(version?.validTo, "2026-08-10T08:00:00.456Z");
  assert.equal(version?.createdAt, "2026-08-09T08:00:00.123Z");
  assert.equal(version?.updatedAt, "2026-08-10T08:00:00.456Z");
});

test("mysql catalog command locks the temporal barrier before domain rows and commits", async () => {
  const pool = new FakePool();
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{
    last_recorded_at: "2026-08-09 08:00:00.000",
    temporal_sequence: 4
  }]);
  pool.connection.enqueue([{
    current_timestamp_3: "2026-08-09 08:00:00.000"
  }]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([]);
  pool.connection.enqueue([]);
  const repository = new MysqlCatalogRepository(
    asPool(pool),
    new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const command: CreateCatalogItemCommand = {
    workspaceId: "team-a", id: "item-1", type: "service", code: "SVC-001",
    name: "诊断服务", description: "获客诊断", unit: "次",
    actorId: "admin-1", idempotencyKey: "catalog-create-0001",
    requestHash: "sha256:catalog-create-0001"
  };

  const result = await repository.createCatalogItem(command);

  assert.equal(result.kind, "ok");
  assert.equal(result.replayed, false);
  assert.deepEqual(result.value, {
    id: "item-1", workspaceId: "team-a", type: "service", code: "SVC-001",
    name: "诊断服务", description: "获客诊断", unit: "次", status: "active",
    revision: 1, createdBy: "admin-1",
    createdAt: "2026-08-09T08:00:00.001Z",
    updatedAt: "2026-08-09T08:00:00.001Z"
  });
  assert.deepEqual(pool.connection.transactions, ["begin", "commit", "release"]);
  const sql = pool.connection.calls.map((call) => call.sql);
  assert.match(sql[0]!, /^INSERT INTO growth_workspace_temporal_barriers/u);
  assert.match(sql[1]!, /growth_workspace_temporal_barriers[\s\S]*FOR UPDATE/u);
  const firstDomainLock = sql.findIndex((statement) =>
    /FROM catalog_items/u.test(statement) && /FOR UPDATE/u.test(statement)
  );
  assert.ok(firstDomainLock > 3);
  assert.ok(sql.slice(0, firstDomainLock).every((statement) =>
    /growth_workspace_temporal_barriers|CURRENT_TIMESTAMP|catalog_command_receipts/u
      .test(statement)
  ));
  const insert = pool.connection.calls.find((call) =>
    /^INSERT INTO catalog_items/u.test(call.sql)
  )!;
  assert.match(insert.sql, /^INSERT INTO catalog_items/u);
  assert.equal(insert.values[12], "2026-08-09 08:00:00.001");
  assert.equal(insert.values[13], 5);
  assert.doesNotMatch(sql.join("\n"), /persistAll|replaceRows/u);
});

test("mysql domain receipts scope by actor and operation and survive intervening commands", async () => {
  const connection = new ReceiptConnection();
  const pool = new FakePool(connection);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const maximumKey = "x".repeat(200);
  const create: CreateCatalogItemCommand = {
    workspaceId: "team-a", id: "item-1", type: "service", code: "SVC-001",
    name: "原名称", description: "获客诊断", unit: "次",
    actorId: "admin-1", idempotencyKey: maximumKey,
    requestHash: "sha256:create"
  };
  assert.equal((await repository.createCatalogItem(create)).kind, "ok");
  assert.equal((await repository.updateCatalogItem({
    workspaceId: "team-a", id: "item-1", expectedRevision: 1,
    patch: { name: "actor-one" }, actorId: "admin-1",
    idempotencyKey: maximumKey, requestHash: "sha256:update-one"
  })).kind, "ok");
  assert.equal((await repository.updateCatalogItem({
    workspaceId: "team-a", id: "item-1", expectedRevision: 2,
    patch: { name: "actor-two" }, actorId: "admin-2",
    idempotencyKey: maximumKey, requestHash: "sha256:update-two"
  })).kind, "ok");
  assert.deepEqual(await repository.updateCatalogItem({
    workspaceId: "team-a", id: "item-1", expectedRevision: 3,
    patch: { name: "conflict" }, actorId: "admin-1",
    idempotencyKey: maximumKey, requestHash: "sha256:changed"
  }), { kind: "state_conflict", code: "idempotency_conflict" });

  const replay = await repository.createCatalogItem({ ...create, id: "ignored-new-id" });
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.id, "item-1");
  assert.equal(replay.value.name, "actor-two");
  assert.equal(replay.value.revision, 3);
  const receiptScopes = connection.calls.filter((call) =>
    /FROM catalog_command_receipts/u.test(call.sql)
  );
  assert.ok(receiptScopes.length > 0);
  assert.equal(receiptScopes.some((call) => call.values.includes(maximumKey)), false);
  assert.equal(
    receiptScopes.every((call) => /^sha256:[a-f0-9]{64}$/u.test(String(call.values[3]))),
    true
  );
});

test("mysql catalog preserves nullable descriptions across updates and replay", async () => {
  const connection = new ReceiptConnection();
  const pool = new FakePool(connection);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const created = await repository.createCatalogItem({
    workspaceId: "team-a", id: "nullable-item", type: "service",
    code: "NULLABLE", name: "可空描述", description: null, unit: "次",
    actorId: "admin-1", idempotencyKey: "nullable-create",
    requestHash: "sha256:nullable-create"
  });
  assert.equal(created.kind, "ok");
  assert.equal(created.value.description, null);

  const renamed = await repository.updateCatalogItem({
    workspaceId: "team-a", id: "nullable-item", expectedRevision: 1,
    patch: { name: "仅修改名称" }, actorId: "admin-1",
    idempotencyKey: "nullable-rename", requestHash: "sha256:nullable-rename"
  });
  assert.equal(renamed.kind, "ok");
  assert.equal(renamed.value.description, null);

  const described = await repository.updateCatalogItem({
    workspaceId: "team-a", id: "nullable-item", expectedRevision: 2,
    patch: { description: "临时描述" }, actorId: "admin-1",
    idempotencyKey: "nullable-describe", requestHash: "sha256:nullable-describe"
  });
  assert.equal(described.kind, "ok");
  assert.equal(described.value.description, "临时描述");

  const clear = {
    workspaceId: "team-a", id: "nullable-item", expectedRevision: 3,
    patch: { description: null }, actorId: "admin-1",
    idempotencyKey: "nullable-clear", requestHash: "sha256:nullable-clear"
  } as const;
  const cleared = await repository.updateCatalogItem(clear);
  assert.equal(cleared.kind, "ok");
  assert.equal(cleared.value.description, null);
  const replay = await repository.updateCatalogItem(clear);
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.description, null);

  const insert = connection.calls.find((call) =>
    /^INSERT INTO catalog_items/u.test(call.sql)
  );
  assert.equal(insert?.values[5], null);
});

test("mysql draft-component replacement takes the temporal barrier before its package lock", async () => {
  const pool = new FakePool();
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{
    last_recorded_at: "2026-08-09 08:00:00.000",
    temporal_sequence: 8
  }]);
  pool.connection.enqueue([{
    current_timestamp_3: "2026-08-09 08:00:00.000"
  }]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{
    package_status: "draft", updated_at: "2026-08-09 08:00:00.000"
  }]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );

  const components = await repository.replaceDraftPackageComponents(
    "team-a", "package-version-1", [{
      workspaceId: "team-a", packageVersionId: "package-version-1",
      componentCatalogItemId: "item-1",
      componentPricingPolicyVersionId: "policy-1", quantityMicros: 1_000_000
    }]
  );

  assert.deepEqual(Object.keys(components[0]!).sort(), [
    "componentCatalogItemId", "componentPricingPolicyVersionId",
    "packageVersionId", "quantityMicros", "workspaceId"
  ]);
  const sql = pool.connection.calls.map((call) => call.sql);
  assert.match(sql[0]!, /^INSERT INTO growth_workspace_temporal_barriers/u);
  assert.match(sql[1]!, /growth_workspace_temporal_barriers[\s\S]*FOR UPDATE/u);
  assert.match(sql[4]!, /FROM package_versions[\s\S]*FOR UPDATE/u);
  const componentInsert = pool.connection.calls.at(-1)!;
  assert.equal(componentInsert.values.at(-2), "2026-08-09 08:00:00.001");
  assert.equal(componentInsert.values.at(-1), 9);
  assert.deepEqual(pool.connection.transactions, ["begin", "commit", "release"]);
});

test("mysql empty draft-component replacement persists its set-level authority stamp", async () => {
  const pool = new FakePool();
  enqueueBarrier(pool, 8, false);
  pool.connection.enqueue([{
    package_status: "draft", updated_at: "2026-08-09 08:00:00.000"
  }]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );

  assert.deepEqual(
    await repository.replaceDraftPackageComponents("team-a", "package-version-1", []),
    []
  );
  const stampUpdate = pool.connection.calls.find((call) =>
    /^UPDATE package_versions SET recorded_at/u.test(call.sql)
  );
  assert.ok(stampUpdate);
  assert.deepEqual(stampUpdate.values, [
    "2026-08-09 08:00:00.001", 9, "team-a", "package-version-1"
  ]);
});

test("mysql empty draft-component replacement rolls back delete when stamp write fails", async () => {
  const connection = new FailingEmptyStampConnection();
  const pool = new FakePool(connection);
  enqueueBarrier(pool, 8, false);
  connection.enqueue([{
    package_status: "draft", updated_at: "2026-08-09 08:00:00.000"
  }]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  await assert.rejects(
    () => repository.replaceDraftPackageComponents(
      "team-a", "package-version-1", []
    ),
    /stamp_write_failed/u
  );
  assert.deepEqual(connection.transactions, ["begin", "rollback", "release"]);
  const sql = connection.calls.map((call) => call.sql);
  assert.ok(sql.findIndex((statement) => /^DELETE FROM package_components/u.test(statement))
    < sql.findIndex((statement) => /^UPDATE package_versions SET recorded_at/u.test(statement)));
});

for (const lifecycle of ["activate", "retire"] as const) {
  test(`mysql pricing ${lifecycle} locks discovered parent then child separately`, async () => {
    const pool = new FakePool(new LifecycleConnection(lifecycle));
    const repository = new MysqlCatalogRepository(
      asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
    );
    const command: PricingPolicyLifecycleCommand = {
      workspaceId: "team-a", id: "policy-1", expectedRevision: 1,
      actorId: "admin-1", idempotencyKey: `policy-${lifecycle}`,
      requestHash: `sha256:policy-${lifecycle}`
    };
    await repository[lifecycle === "activate"
      ? "activatePricingPolicy" : "retirePricingPolicy"](command);
    const domain = pool.connection.calls.slice(5).map((call) => call.sql);
    assert.match(domain[0]!, /^SELECT catalog_item_id FROM pricing_policy_versions/u);
    assert.match(domain[1]!, /^SELECT \* FROM catalog_items[\s\S]*FOR UPDATE/u);
    assert.match(domain[2]!, /^SELECT \* FROM pricing_policy_versions[\s\S]*FOR UPDATE/u);
    assert.doesNotMatch(domain.slice(0, 3).join("\n"), /INNER JOIN/u);
  });

  test(`mysql package ${lifecycle} locks discovered parent then child separately`, async () => {
    const pool = new FakePool(new LifecycleConnection(lifecycle));
    const repository = new MysqlCatalogRepository(
      asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
    );
    const command: PackageVersionLifecycleCommand = {
      workspaceId: "team-a", id: "package-1", expectedRevision: 1,
      actorId: "admin-1", idempotencyKey: `package-${lifecycle}`,
      requestHash: `sha256:package-${lifecycle}`
    };
    await repository[lifecycle === "activate"
      ? "activatePackageVersion" : "retirePackageVersion"](command);
    const domain = pool.connection.calls.slice(5).map((call) => call.sql);
    assert.match(domain[0]!, /^SELECT package_catalog_item_id FROM package_versions/u);
    assert.match(domain[1]!, /^SELECT \* FROM catalog_items[\s\S]*FOR UPDATE/u);
    assert.match(domain[2]!, /^SELECT \* FROM package_versions[\s\S]*FOR UPDATE/u);
    assert.doesNotMatch(domain.slice(0, 3).join("\n"), /INNER JOIN/u);
  });
}

test("mysql stale revision matches memory semantics and rolls back its barrier allocation", async () => {
  const pool = new FakePool();
  enqueueBarrier(pool, 5);
  pool.connection.enqueue([catalogRow({ revision: 2 })]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );

  const result = await repository.updateCatalogItem({
    workspaceId: "team-a", id: "item-1", expectedRevision: 1,
    patch: { name: "并发覆盖" }, actorId: "admin-2",
    idempotencyKey: "catalog-update-stale",
    requestHash: "sha256:catalog-update-stale"
  });

  assert.deepEqual(result, { kind: "revision_conflict", actualRevision: 2 });
  assert.deepEqual(pool.connection.transactions, ["begin", "rollback", "release"]);
  assert.equal(
    pool.connection.calls.some((call) => /^UPDATE catalog_items/u.test(call.sql)),
    false
  );
});

test("mysql pricing version allocation locks one parent before reading MAX(version)", async () => {
  const pool = new FakePool();
  enqueueBarrier(pool, 10);
  pool.connection.enqueue([catalogRow()]);
  pool.connection.enqueue([]);
  pool.connection.enqueue([{ max_version: 4 }]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const command: CreatePricingPolicyDraftCommand = {
    workspaceId: "team-a", id: "policy-5", catalogItemId: "item-1",
    packageVersionId: null, currency: "CNY", listUnitPriceMinor: 10_000,
    unitStandardCostMinor: 4_000, defaultOrderDeliveryCostMinor: 0,
    defaultOrderSalesCostMinor: 0, defaultOrderServiceCostMinor: 0,
    absoluteFloorUnitPriceMinor: 4_000, standardDiscountLimitBps: 500,
    absoluteDiscountLimitBps: 1_000, targetGrossMarginBps: 5_000,
    absoluteMinimumGrossMarginBps: 2_000, standardPaymentTermDays: 30,
    absolutePaymentTermDays: 60,
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve",
      marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve",
      giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve",
      manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 7_000,
      manualEscalationEnabled: true
    },
    surchargePolicies: [], giftPolicies: [],
    validFrom: "2026-08-09T16:00:00.123+08:00",
    validTo: "2026-08-10T17:00:00.456+08:00",
    source: "native", capabilityRegistryVersion: "growth-capabilities.v1",
    actorId: "admin-1", idempotencyKey: "policy-create-5",
    requestHash: "sha256:policy-create-5"
  };

  const result = await repository.createPricingPolicyDraft(command);

  assert.equal(result.kind, "ok");
  assert.equal(result.value.version, 5);
  assert.equal(result.value.validFrom, "2026-08-09T08:00:00.123Z");
  assert.equal(result.value.validTo, "2026-08-10T09:00:00.456Z");
  const sql = pool.connection.calls.map((call) => call.sql);
  const parentLock = sql.findIndex((statement) =>
    /FROM catalog_items/u.test(statement) && /FOR UPDATE/u.test(statement)
  );
  const maxRead = sql.findIndex((statement) => /SELECT MAX\(version\)/u.test(statement));
  assert.ok(parentLock > 3);
  assert.ok(maxRead > parentLock);
  assert.deepEqual(pool.connection.calls[maxRead]!.values, ["team-a", "item-1"]);
  assert.deepEqual(pool.connection.transactions, ["begin", "commit", "release"]);
});

test("mysql package create and receipt replay return canonical UTC bytes", async () => {
  const pool = new FakePool();
  enqueueBarrier(pool, 30);
  pool.connection.enqueue([catalogRow({
    id: "package-item-offset", item_type: "package"
  })]);
  pool.connection.enqueue([]);
  pool.connection.enqueue([{ max_version: 0 }]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const command = {
    workspaceId: "team-a", id: "package-offset",
    packageCatalogItemId: "package-item-offset", currency: "CNY",
    validFrom: "2026-08-12T16:00:00.123+08:00",
    validTo: "2026-08-13T17:00:00.456+08:00", components: [],
    actorId: "admin-1", idempotencyKey: "package-offset-create",
    requestHash: "sha256:package-offset-create"
  } as const;
  const created = await repository.createPackageVersionDraft(command);
  assert.equal(created.kind, "ok");
  assert.equal(created.value.validFrom, "2026-08-12T08:00:00.123Z");
  assert.equal(created.value.validTo, "2026-08-13T09:00:00.456Z");

  enqueueBarrier(pool, 31, false);
  pool.connection.enqueue([{
    request_hash: command.requestHash,
    resource_kind: "package_version",
    resource_id: command.id
  }]);
  pool.connection.enqueue([packageRow({
    id: command.id, package_catalog_item_id: command.packageCatalogItemId,
    valid_from: "2026-08-12 08:00:00.123",
    valid_to: "2026-08-13 09:00:00.456"
  })]);
  const replay = await repository.createPackageVersionDraft(command);
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.validFrom, "2026-08-12T08:00:00.123Z");
  assert.equal(replay.value.validTo, "2026-08-13T09:00:00.456Z");
});

test("mysql package update and receipt replay return canonical UTC bytes", async () => {
  const pool = new FakePool();
  enqueueBarrier(pool, 40);
  pool.connection.enqueue([{ package_catalog_item_id: "package-item-1" }]);
  pool.connection.enqueue([catalogRow({ id: "package-item-1", item_type: "package" })]);
  pool.connection.enqueue([packageRow()]);
  const repository = new MysqlCatalogRepository(
    asPool(pool), new MysqlGrowthTemporalBarrier(asPool(pool))
  );
  const command = {
    workspaceId: "team-a", id: "package-1", expectedRevision: 1,
    patch: {
      validFrom: "2026-08-14T16:00:00.123+08:00",
      validTo: "2026-08-15T17:00:00.456+08:00"
    },
    actorId: "admin-1", idempotencyKey: "package-offset-update",
    requestHash: "sha256:package-offset-update"
  } as const;
  const updated = await repository.updatePackageVersionDraft(command);
  assert.equal(updated.kind, "ok");
  assert.equal(updated.value.validFrom, "2026-08-14T08:00:00.123Z");
  assert.equal(updated.value.validTo, "2026-08-15T09:00:00.456Z");

  enqueueBarrier(pool, 41, false);
  pool.connection.enqueue([{
    request_hash: command.requestHash,
    resource_kind: "package_version",
    resource_id: command.id
  }]);
  pool.connection.enqueue([packageRow({
    revision: 2, valid_from: "2026-08-14 08:00:00.123",
    valid_to: "2026-08-15 09:00:00.456"
  })]);
  const replay = await repository.updatePackageVersionDraft(command);
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.validFrom, "2026-08-14T08:00:00.123Z");
  assert.equal(replay.value.validTo, "2026-08-15T09:00:00.456Z");
});
