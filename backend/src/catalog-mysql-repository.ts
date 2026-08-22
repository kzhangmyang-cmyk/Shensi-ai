import type mysql from "mysql2/promise";
import type {
  CatalogItem,
  CommissionCatalogMigrationItemResult,
  CommissionCatalogMigrationRun,
  CommissionProductCatalogLink,
  PackageComponent,
  PackageVersion,
  PricingPolicyVersion
} from "./catalog-domain.js";
import {
  assertClosedPricingPolicyRules,
  assertClosedPricingPolicyVersion,
  immutableClone,
  normalizeCatalogItemInstants,
  normalizeCommissionCatalogMigrationRunInstants,
  normalizeCommissionProductCatalogLinkInstant,
  normalizePackageVersionInstants,
  normalizePricingPolicyVersionInstants
} from "./catalog-domain.js";
import type {
  CatalogCommandResult,
  CatalogListQuery,
  CatalogLockedValidationView,
  CatalogRepository,
  CommissionCatalogMigrationCommit,
  CreateCatalogItemCommand,
  CreatePackageVersionDraftCommand,
  CreatePricingPolicyDraftCommand,
  PackageComponentDraft,
  PackageCostSnapshot,
  PackageVersionLifecycleCommand,
  PricingPolicyLifecycleCommand,
  RetireCatalogItemCommand,
  UpdateCatalogItemCommand,
  UpdatePackageVersionDraftCommand
} from "./catalog-repository.js";
import {
  assertCommissionCatalogMigrationCommitInvariant,
  normalizeCommissionCatalogMigrationCommit
} from "./catalog-repository.js";
import {
  MysqlGrowthTemporalTransaction,
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import { growthHttpIdempotencyKeyHash } from "./growth-http-idempotency-repository.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type MysqlRow = Record<string, unknown>;
type CatalogAppendStamp = Readonly<{
  recordedAt: string;
  temporalSequence: number;
}>;
type StampedPackageComponent = Readonly<{
  component: PackageComponent;
  stamp: CatalogAppendStamp;
}>;

export const CATALOG_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS catalog_package_graph_guards (
    workspace_id VARCHAR(191) NOT NULL,
    PRIMARY KEY (workspace_id),
    CONSTRAINT chk_catalog_package_graph_guard_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS catalog_items (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    item_type ENUM('product','service','package') NOT NULL,
    code VARCHAR(191) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    unit VARCHAR(100) NOT NULL,
    item_status ENUM('active','retired') NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_catalog_items_code (workspace_id, code),
    CONSTRAINT chk_catalog_items_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS package_versions (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    package_catalog_item_id VARCHAR(191) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) NOT NULL,
    package_status ENUM('draft','active','retired') NOT NULL,
    valid_from DATETIME(3) NOT NULL,
    valid_to DATETIME(3) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_package_versions_version
      (workspace_id, package_catalog_item_id, version),
    KEY idx_package_versions_window
      (workspace_id, package_catalog_item_id, currency, package_status, valid_from, valid_to),
    CONSTRAINT fk_package_version_catalog
      FOREIGN KEY (workspace_id, package_catalog_item_id)
      REFERENCES catalog_items (workspace_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS pricing_policy_versions (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    catalog_item_id VARCHAR(191) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    package_version_id VARCHAR(191) NULL,
    currency CHAR(3) NOT NULL,
    list_unit_price_minor BIGINT UNSIGNED NOT NULL,
    unit_standard_cost_minor BIGINT UNSIGNED NOT NULL,
    default_order_delivery_cost_minor BIGINT UNSIGNED NOT NULL,
    default_order_sales_cost_minor BIGINT UNSIGNED NOT NULL,
    default_order_service_cost_minor BIGINT UNSIGNED NOT NULL,
    absolute_floor_unit_price_minor BIGINT UNSIGNED NOT NULL,
    standard_discount_limit_bps INT UNSIGNED NOT NULL,
    absolute_discount_limit_bps INT UNSIGNED NOT NULL,
    target_gross_margin_bps INT UNSIGNED NOT NULL,
    absolute_minimum_gross_margin_bps INT UNSIGNED NOT NULL,
    standard_payment_term_days INT UNSIGNED NOT NULL,
    absolute_payment_term_days INT UNSIGNED NOT NULL,
    approval_thresholds_json JSON NOT NULL,
    surcharge_policies_json JSON NOT NULL,
    gift_policies_json JSON NOT NULL,
    valid_from DATETIME(3) NOT NULL,
    valid_to DATETIME(3) NULL,
    policy_status ENUM('draft','active','retired') NOT NULL,
    source ENUM('native','legacy_commission_product') NOT NULL,
    capability_registry_version VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_pricing_policy_versions_version
      (workspace_id, catalog_item_id, version),
    KEY idx_pricing_policy_versions_window
      (workspace_id, catalog_item_id, currency, policy_status, valid_from, valid_to),
    CONSTRAINT fk_pricing_policy_catalog
      FOREIGN KEY (workspace_id, catalog_item_id)
      REFERENCES catalog_items (workspace_id, id),
    CONSTRAINT fk_pricing_policy_package
      FOREIGN KEY (workspace_id, package_version_id)
      REFERENCES package_versions (workspace_id, id)
  ) ENGINE=InnoDB`,
  `ALTER TABLE pricing_policy_versions MODIFY COLUMN source
    ENUM('manual','native','legacy_commission_product') NOT NULL`,
  `UPDATE pricing_policy_versions
    SET source = 'native' WHERE source = 'manual'`,
  `ALTER TABLE pricing_policy_versions MODIFY COLUMN source
    ENUM('native','legacy_commission_product') NOT NULL`,
  `CREATE TABLE IF NOT EXISTS package_components (
    workspace_id VARCHAR(191) NOT NULL,
    package_version_id VARCHAR(191) NOT NULL,
    component_catalog_item_id VARCHAR(191) NOT NULL,
    component_pricing_policy_version_id VARCHAR(191) NOT NULL,
    quantity_micros BIGINT UNSIGNED NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (
      workspace_id, package_version_id, component_catalog_item_id,
      component_pricing_policy_version_id
    ),
    KEY idx_package_components_target
      (workspace_id, component_catalog_item_id),
    CONSTRAINT fk_package_component_version
      FOREIGN KEY (workspace_id, package_version_id)
      REFERENCES package_versions (workspace_id, id),
    CONSTRAINT fk_package_component_catalog
      FOREIGN KEY (workspace_id, component_catalog_item_id)
      REFERENCES catalog_items (workspace_id, id),
    CONSTRAINT fk_package_component_policy
      FOREIGN KEY (workspace_id, component_pricing_policy_version_id)
      REFERENCES pricing_policy_versions (workspace_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS package_cost_snapshots (
    workspace_id VARCHAR(191) NOT NULL,
    pricing_policy_version_id VARCHAR(191) NOT NULL,
    package_version_id VARCHAR(191) NOT NULL,
    component_unit_standard_cost_minor BIGINT UNSIGNED NOT NULL,
    package_own_unit_service_cost_minor BIGINT UNSIGNED NOT NULL,
    total_unit_standard_cost_minor BIGINT UNSIGNED NOT NULL,
    component_snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    components_json JSON NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, pricing_policy_version_id),
    KEY idx_package_cost_snapshot_version (workspace_id, package_version_id),
    CONSTRAINT fk_package_cost_snapshot_policy
      FOREIGN KEY (workspace_id, pricing_policy_version_id)
      REFERENCES pricing_policy_versions (workspace_id, id),
    CONSTRAINT fk_package_cost_snapshot_version
      FOREIGN KEY (workspace_id, package_version_id)
      REFERENCES package_versions (workspace_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS catalog_command_receipts (
    workspace_id VARCHAR(191) NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    operation ENUM(
      'catalog_item.create','catalog_item.update','catalog_item.retire',
      'pricing_policy.create_draft','pricing_policy.activate','pricing_policy.retire',
      'package_version.create_draft','package_version.update_draft',
      'package_version.activate','package_version.retire'
    ) NOT NULL,
    idempotency_key_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash VARCHAR(191) NOT NULL,
    resource_kind ENUM('catalog_item','pricing_policy','package_version') NOT NULL,
    resource_id VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, actor_id, operation, idempotency_key_hash),
    CONSTRAINT chk_catalog_command_receipts_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS commission_product_catalog_links (
    workspace_id VARCHAR(191) NOT NULL,
    commission_product_id VARCHAR(191) NOT NULL,
    catalog_item_id VARCHAR(191) NOT NULL,
    pricing_policy_version_id VARCHAR(191) NOT NULL,
    migrated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, commission_product_id),
    UNIQUE KEY uk_commission_product_catalog_item (workspace_id, catalog_item_id),
    UNIQUE KEY uk_commission_product_policy (workspace_id, pricing_policy_version_id),
    CONSTRAINT fk_commission_product_catalog
      FOREIGN KEY (workspace_id, catalog_item_id)
      REFERENCES catalog_items (workspace_id, id),
    CONSTRAINT fk_commission_product_policy
      FOREIGN KEY (workspace_id, pricing_policy_version_id)
      REFERENCES pricing_policy_versions (workspace_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS commission_catalog_migration_runs (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    idempotency_key VARCHAR(191) NOT NULL,
    input_snapshot_hash CHAR(71) NOT NULL,
    started_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NOT NULL,
    run_status ENUM('completed') NOT NULL,
    scanned BIGINT UNSIGNED NOT NULL,
    migrated BIGINT UNSIGNED NOT NULL,
    repair_required BIGINT UNSIGNED NOT NULL,
    report_hash CHAR(71) NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_commission_catalog_migration_idempotency
      (workspace_id, idempotency_key),
    CONSTRAINT chk_commission_catalog_migration_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS commission_catalog_migration_items (
    workspace_id VARCHAR(191) NOT NULL,
    migration_run_id VARCHAR(191) NOT NULL,
    commission_product_id VARCHAR(191) NOT NULL,
    item_status ENUM('migrated','repair_required') NOT NULL,
    result_code VARCHAR(100) NOT NULL,
    snapshot_json LONGTEXT NOT NULL,
    snapshot_hash CHAR(71) NOT NULL,
    catalog_item_id VARCHAR(191) NULL,
    pricing_policy_version_id VARCHAR(191) NULL,
    PRIMARY KEY (workspace_id, migration_run_id, commission_product_id),
    CONSTRAINT fk_commission_catalog_migration_run
      FOREIGN KEY (workspace_id, migration_run_id)
      REFERENCES commission_catalog_migration_runs (workspace_id, id),
    CONSTRAINT fk_commission_catalog_migration_item_catalog
      FOREIGN KEY (workspace_id, catalog_item_id)
      REFERENCES catalog_items (workspace_id, id),
    CONSTRAINT fk_commission_catalog_migration_item_policy
      FOREIGN KEY (workspace_id, pricing_policy_version_id)
      REFERENCES pricing_policy_versions (workspace_id, id),
    CONSTRAINT chk_commission_catalog_migration_snapshot_json CHECK (
      JSON_VALID(snapshot_json)
    )
  ) ENGINE=InnoDB`
] as const;

export async function ensureCatalogMysqlSchema(pool: mysql.Pool): Promise<void> {
  for (const statement of CATALOG_MYSQL_SCHEMA_STATEMENTS) await pool.query(statement);
  const [descriptionRows] = await pool.query(
    `SELECT column_name,is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
       AND column_name = 'description'`,
    ["catalog_items"]
  );
  const descriptionColumn = (descriptionRows as MysqlRow[]).find((row) =>
    String(row.column_name) === "description"
  );
  if (!descriptionColumn) throw new Error("catalog_items_description_missing");
  if (String(descriptionColumn.is_nullable) !== "YES") {
    await pool.query(
      "ALTER TABLE catalog_items MODIFY COLUMN description TEXT NULL"
    );
  }
  const upgrades = [
    { table: "catalog_items", fallback: "updated_at" },
    { table: "pricing_policy_versions", fallback: "created_at" },
    { table: "package_versions", fallback: "updated_at" },
    { table: "package_components", fallback: null }
  ] as const;
  for (const { table, fallback } of upgrades) {
    const [rows] = await pool.query(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
         AND column_name IN ('recorded_at','temporal_sequence')`,
      [table]
    );
    const columns = new Map((rows as MysqlRow[]).map((row) => [
      String(row.column_name), String(row.is_nullable)
    ]));
    const missingRecordedAt = !columns.has("recorded_at");
    const missingSequence = !columns.has("temporal_sequence");
    if (missingRecordedAt) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN recorded_at DATETIME(3) NULL`);
    }
    if (missingSequence) {
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN temporal_sequence BIGINT UNSIGNED NULL`
      );
    }
    if (fallback) {
      await pool.query(
        `UPDATE ${table} SET recorded_at = COALESCE(recorded_at,${fallback}),
           temporal_sequence = COALESCE(temporal_sequence,0)
         WHERE recorded_at IS NULL OR temporal_sequence IS NULL`
      );
    } else {
      await pool.query(
        `UPDATE package_components c
         INNER JOIN package_versions v
           ON v.workspace_id = c.workspace_id AND v.id = c.package_version_id
         SET c.recorded_at = COALESCE(c.recorded_at,v.updated_at),
           c.temporal_sequence = COALESCE(c.temporal_sequence,0)
         WHERE c.recorded_at IS NULL OR c.temporal_sequence IS NULL`
      );
    }
    if (missingRecordedAt || missingSequence
      || columns.get("recorded_at") === "YES"
      || columns.get("temporal_sequence") === "YES") {
      await pool.query(
        `ALTER TABLE ${table}
         MODIFY COLUMN recorded_at DATETIME(3) NOT NULL,
         MODIFY COLUMN temporal_sequence BIGINT UNSIGNED NOT NULL`
      );
    }
  }
  const [receiptColumnRows] = await pool.query(
    `SELECT column_name,is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
       AND column_name IN ('idempotency_key','idempotency_key_hash')`,
    ["catalog_command_receipts"]
  );
  const receiptColumns = new Map((receiptColumnRows as MysqlRow[]).map((row) => [
    String(row.column_name), String(row.is_nullable)
  ]));
  if (receiptColumns.has("idempotency_key")) {
    if (!receiptColumns.has("idempotency_key_hash")) {
      await pool.query(
        `ALTER TABLE catalog_command_receipts
         ADD COLUMN idempotency_key_hash
           CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL`
      );
    }
    await pool.query(
      `UPDATE catalog_command_receipts
       SET idempotency_key_hash = CONCAT('sha256:',
         SHA2(CAST(idempotency_key AS BINARY),256))
       WHERE idempotency_key_hash IS NULL`
    );
    await pool.query(
      `ALTER TABLE catalog_command_receipts
       DROP PRIMARY KEY,
       MODIFY COLUMN idempotency_key_hash
         CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       ADD PRIMARY KEY (workspace_id,actor_id,operation,idempotency_key_hash),
       DROP COLUMN idempotency_key`
    );
  }
}

function instant(value: unknown): string {
  return growthMysqlInstant(value);
}

function pricingInstant(value: unknown): string {
  try {
    return instant(value);
  } catch {
    throw Object.assign(new Error("invalid_pricing_policy_version"), {
      code: "invalid_pricing_policy_version"
    });
  }
}

function json<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function safeNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid_${field}`);
  return number;
}

function parseCatalogItem(row: MysqlRow): CatalogItem {
  return immutableClone(normalizeCatalogItemInstants({
    id: String(row.id), workspaceId: String(row.workspace_id),
    type: row.item_type, code: String(row.code), name: String(row.name),
    description: row.description === null ? null : String(row.description),
    unit: String(row.unit),
    status: row.item_status, revision: safeNumber(row.revision, "revision"),
    createdBy: String(row.created_by), createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at)
  } as CatalogItem)) as CatalogItem;
}

function parsePricingPolicy(row: MysqlRow): PricingPolicyVersion {
  const policy = {
    id: String(row.id), workspaceId: String(row.workspace_id),
    catalogItemId: String(row.catalog_item_id),
    version: safeNumber(row.version, "version"),
    packageVersionId: row.package_version_id === null
      ? null : String(row.package_version_id),
    currency: String(row.currency),
    listUnitPriceMinor: safeNumber(row.list_unit_price_minor, "list_unit_price_minor"),
    unitStandardCostMinor: safeNumber(row.unit_standard_cost_minor, "unit_standard_cost_minor"),
    defaultOrderDeliveryCostMinor: safeNumber(row.default_order_delivery_cost_minor, "default_order_delivery_cost_minor"),
    defaultOrderSalesCostMinor: safeNumber(row.default_order_sales_cost_minor, "default_order_sales_cost_minor"),
    defaultOrderServiceCostMinor: safeNumber(row.default_order_service_cost_minor, "default_order_service_cost_minor"),
    absoluteFloorUnitPriceMinor: safeNumber(row.absolute_floor_unit_price_minor, "absolute_floor_unit_price_minor"),
    standardDiscountLimitBps: safeNumber(row.standard_discount_limit_bps, "standard_discount_limit_bps"),
    absoluteDiscountLimitBps: safeNumber(row.absolute_discount_limit_bps, "absolute_discount_limit_bps"),
    targetGrossMarginBps: safeNumber(row.target_gross_margin_bps, "target_gross_margin_bps"),
    absoluteMinimumGrossMarginBps: safeNumber(row.absolute_minimum_gross_margin_bps, "absolute_minimum_gross_margin_bps"),
    standardPaymentTermDays: safeNumber(row.standard_payment_term_days, "standard_payment_term_days"),
    absolutePaymentTermDays: safeNumber(row.absolute_payment_term_days, "absolute_payment_term_days"),
    approvalThresholds: json(row.approval_thresholds_json),
    surchargePolicies: json(row.surcharge_policies_json),
    giftPolicies: json(row.gift_policies_json),
    validFrom: pricingInstant(row.valid_from),
    validTo: row.valid_to === null ? null : pricingInstant(row.valid_to),
    status: row.policy_status ?? row.status, source: row.source,
    capabilityRegistryVersion: String(row.capability_registry_version),
    revision: safeNumber(row.revision, "revision"),
    createdBy: String(row.created_by), createdAt: pricingInstant(row.created_at)
  } as PricingPolicyVersion;
  return immutableClone(
    normalizePricingPolicyVersionInstants(policy)
  ) as PricingPolicyVersion;
}

function parsePackageVersion(row: MysqlRow): PackageVersion {
  return immutableClone(normalizePackageVersionInstants({
    id: String(row.id), workspaceId: String(row.workspace_id),
    packageCatalogItemId: String(row.package_catalog_item_id),
    version: safeNumber(row.version, "version"), currency: String(row.currency),
    status: row.package_status, validFrom: instant(row.valid_from),
    validTo: row.valid_to === null ? null : instant(row.valid_to),
    revision: safeNumber(row.revision, "revision"),
    createdBy: String(row.created_by), createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at)
  } as PackageVersion)) as PackageVersion;
}

function parsePackageComponent(row: MysqlRow): PackageComponent {
  return immutableClone({
    workspaceId: String(row.workspace_id),
    packageVersionId: String(row.package_version_id),
    componentCatalogItemId: String(row.component_catalog_item_id),
    componentPricingPolicyVersionId: String(
      row.component_pricing_policy_version_id
    ),
    quantityMicros: safeNumber(row.quantity_micros, "quantity_micros")
  }) as PackageComponent;
}

function parsePackageCostSnapshot(row: MysqlRow): PackageCostSnapshot {
  return immutableClone({
    workspaceId: String(row.workspace_id),
    pricingPolicyVersionId: String(row.pricing_policy_version_id),
    packageVersionId: String(row.package_version_id),
    componentUnitStandardCostMinor: safeNumber(
      row.component_unit_standard_cost_minor,
      "component_unit_standard_cost_minor"
    ),
    packageOwnUnitServiceCostMinor: safeNumber(
      row.package_own_unit_service_cost_minor,
      "package_own_unit_service_cost_minor"
    ),
    totalUnitStandardCostMinor: safeNumber(
      row.total_unit_standard_cost_minor,
      "total_unit_standard_cost_minor"
    ),
    componentSnapshotHash: String(row.component_snapshot_hash),
    components: json(row.components_json)
  }) as PackageCostSnapshot;
}

function parseLink(row: MysqlRow): CommissionProductCatalogLink {
  return immutableClone(normalizeCommissionProductCatalogLinkInstant({
    workspaceId: String(row.workspace_id),
    commissionProductId: String(row.commission_product_id),
    catalogItemId: String(row.catalog_item_id),
    pricingPolicyVersionId: String(row.pricing_policy_version_id),
    migratedAt: instant(row.migrated_at)
  })) as CommissionProductCatalogLink;
}

async function first<T>(
  source: QuerySource,
  sql: string,
  values: unknown[],
  parse: (row: MysqlRow) => T
): Promise<T | null> {
  const [rows] = await source.query(sql, values);
  const row = (rows as MysqlRow[])[0];
  return row ? parse(row) : null;
}

async function insertCatalogItem(
  source: QuerySource,
  item: CatalogItem,
  stamp: CatalogAppendStamp = { recordedAt: item.updatedAt, temporalSequence: 0 }
): Promise<void> {
  await source.query(
    `INSERT INTO catalog_items (
      workspace_id,id,item_type,code,name,description,unit,item_status,revision,
      created_by,created_at,updated_at,recorded_at,temporal_sequence
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [item.workspaceId, item.id, item.type, item.code, item.name, item.description,
      item.unit, item.status, item.revision, item.createdBy,
      growthMysqlDate(item.createdAt), growthMysqlDate(item.updatedAt),
      growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
  );
}

async function insertPricingPolicy(
  source: QuerySource,
  policy: PricingPolicyVersion,
  stamp: CatalogAppendStamp = { recordedAt: policy.createdAt, temporalSequence: 0 }
): Promise<void> {
  await source.query(
    `INSERT INTO pricing_policy_versions (
      workspace_id,id,catalog_item_id,version,package_version_id,currency,
      list_unit_price_minor,unit_standard_cost_minor,
      default_order_delivery_cost_minor,default_order_sales_cost_minor,
      default_order_service_cost_minor,absolute_floor_unit_price_minor,
      standard_discount_limit_bps,absolute_discount_limit_bps,
      target_gross_margin_bps,absolute_minimum_gross_margin_bps,
      standard_payment_term_days,absolute_payment_term_days,
      approval_thresholds_json,surcharge_policies_json,gift_policies_json,
      valid_from,valid_to,policy_status,source,capability_registry_version,
      revision,created_by,created_at,recorded_at,temporal_sequence
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [policy.workspaceId, policy.id, policy.catalogItemId, policy.version,
      policy.packageVersionId, policy.currency, policy.listUnitPriceMinor,
      policy.unitStandardCostMinor, policy.defaultOrderDeliveryCostMinor,
      policy.defaultOrderSalesCostMinor, policy.defaultOrderServiceCostMinor,
      policy.absoluteFloorUnitPriceMinor, policy.standardDiscountLimitBps,
      policy.absoluteDiscountLimitBps, policy.targetGrossMarginBps,
      policy.absoluteMinimumGrossMarginBps, policy.standardPaymentTermDays,
      policy.absolutePaymentTermDays, JSON.stringify(policy.approvalThresholds),
      JSON.stringify(policy.surchargePolicies), JSON.stringify(policy.giftPolicies),
      growthMysqlDate(policy.validFrom),
      policy.validTo ? growthMysqlDate(policy.validTo) : null,
      policy.status, policy.source, policy.capabilityRegistryVersion,
      policy.revision, policy.createdBy, growthMysqlDate(policy.createdAt),
      growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
  );
}

function parseMigrationItem(row: MysqlRow): CommissionCatalogMigrationItemResult {
  return immutableClone({
    workspaceId: String(row.workspace_id),
    commissionProductId: String(row.commission_product_id),
    status: row.item_status,
    code: row.result_code,
    snapshot: json(row.snapshot_json),
    snapshotHash: String(row.snapshot_hash),
    catalogItemId: row.catalog_item_id === null ? null : String(row.catalog_item_id),
    pricingPolicyVersionId: row.pricing_policy_version_id === null
      ? null : String(row.pricing_policy_version_id)
  }) as CommissionCatalogMigrationItemResult;
}

async function findRun(
  source: QuerySource,
  workspaceId: string,
  idempotencyKey: string,
  forUpdate = false
): Promise<CommissionCatalogMigrationRun | null> {
  const [rows] = await source.query(
    `SELECT * FROM commission_catalog_migration_runs
     WHERE workspace_id = ? AND idempotency_key = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [workspaceId, idempotencyKey]
  );
  const row = (rows as MysqlRow[])[0];
  if (!row) return null;
  const [itemRows] = await source.query(
    `SELECT * FROM commission_catalog_migration_items
     WHERE workspace_id = ? AND migration_run_id = ?
     ORDER BY commission_product_id`,
    [workspaceId, String(row.id)]
  );
  return immutableClone(normalizeCommissionCatalogMigrationRunInstants({
    id: String(row.id), workspaceId: String(row.workspace_id),
    actorId: String(row.actor_id), idempotencyKey: String(row.idempotency_key),
    inputSnapshotHash: String(row.input_snapshot_hash),
    startedAt: instant(row.started_at), completedAt: instant(row.completed_at),
    status: row.run_status, scanned: safeNumber(row.scanned, "scanned"),
    migrated: safeNumber(row.migrated, "migrated"),
    repairRequired: safeNumber(row.repair_required, "repair_required"),
    reportHash: String(row.report_hash),
    items: (itemRows as MysqlRow[]).map(parseMigrationItem)
  } as CommissionCatalogMigrationRun)) as CommissionCatalogMigrationRun;
}

function migrationConflict(): Error & { code: string } {
  return Object.assign(new Error("commission_catalog_migration_conflict"), {
    code: "commission_catalog_migration_conflict"
  });
}

class MysqlCatalogCommandAbort<T> extends Error {
  constructor(readonly result: CatalogCommandResult<T>) {
    super("catalog_command_aborted");
  }
}

function commandAbort<T>(result: CatalogCommandResult<T>): never {
  throw new MysqlCatalogCommandAbort(result);
}

function assertCommandIdentity(command: Readonly<{
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
}>): void {
  if (!command.actorId.trim() || !command.idempotencyKey.trim()
    || command.idempotencyKey.length > 200 || !command.requestHash.trim()) {
    throw Object.assign(new Error("invalid_catalog_command_identity"), {
      code: "invalid_catalog_command_identity"
    });
  }
}

type CatalogCommandOperation =
  | "catalog_item.create" | "catalog_item.update" | "catalog_item.retire"
  | "pricing_policy.create_draft" | "pricing_policy.activate"
  | "pricing_policy.retire" | "package_version.create_draft"
  | "package_version.update_draft" | "package_version.activate"
  | "package_version.retire";
type CatalogReceiptResourceKind =
  | "catalog_item" | "pricing_policy" | "package_version";

async function mysqlReceiptReplay<T>(
  connection: mysql.PoolConnection,
  workspaceId: string,
  command: Readonly<{ actorId: string; idempotencyKey: string; requestHash: string }>,
  operation: CatalogCommandOperation,
  resourceKind: CatalogReceiptResourceKind,
  read: (resourceId: string) => Promise<T | null>
): Promise<CatalogCommandResult<T> | null> {
  assertCommandIdentity(command);
  const [rows] = await connection.query(
    `SELECT request_hash,resource_kind,resource_id
     FROM catalog_command_receipts
     WHERE workspace_id = ? AND actor_id = ? AND operation = ?
       AND idempotency_key_hash = ? FOR UPDATE`,
    [workspaceId, command.actorId, operation,
      growthHttpIdempotencyKeyHash(command.idempotencyKey)]
  );
  const receipt = (rows as MysqlRow[])[0];
  if (!receipt) return null;
  if (receipt.request_hash !== command.requestHash) {
    return { kind: "state_conflict", code: "idempotency_conflict" };
  }
  if (receipt.resource_kind !== resourceKind) {
    return { kind: "state_conflict", code: "catalog_command_receipt_corrupt" };
  }
  const value = await read(String(receipt.resource_id));
  return value === null
    ? { kind: "state_conflict", code: "catalog_command_receipt_corrupt" }
    : { kind: "ok", value, replayed: true };
}

async function insertCatalogReceipt(
  connection: mysql.PoolConnection,
  workspaceId: string,
  command: Readonly<{ actorId: string; idempotencyKey: string; requestHash: string }>,
  operation: CatalogCommandOperation,
  resourceKind: CatalogReceiptResourceKind,
  resourceId: string,
  stamp: CatalogAppendStamp
): Promise<void> {
  await connection.query(
    `INSERT INTO catalog_command_receipts (
      workspace_id,actor_id,operation,idempotency_key_hash,request_hash,
      resource_kind,resource_id,recorded_at,temporal_sequence
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
    [workspaceId, command.actorId, operation,
      growthHttpIdempotencyKeyHash(command.idempotencyKey),
      command.requestHash, resourceKind, resourceId,
      growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
  );
}

function decodeCursor(cursor: string): readonly [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || parsed.some((value) => typeof value !== "string")) throw new Error();
    return parsed as [string, string];
  } catch {
    throw Object.assign(new Error("invalid_catalog_cursor"), {
      code: "invalid_catalog_cursor"
    });
  }
}

function checkedListQuery(query: CatalogListQuery): CatalogListQuery {
  if (!query || !Number.isSafeInteger(query.limit)
    || query.limit < 1 || query.limit > 100
    || !["code", "name", "updatedAt"].includes(query.sort)
    || !["asc", "desc"].includes(query.direction)
    || (query.cursor !== null && (
      typeof query.cursor !== "string" || query.cursor.trim() === ""
    ))
    || (query.type !== undefined
      && !["product", "service", "package"].includes(query.type))
    || (query.status !== undefined
      && !["active", "retired"].includes(query.status))) {
    throw Object.assign(new Error("invalid_catalog_list_query"), {
      code: "invalid_catalog_list_query"
    });
  }
  if (query.cursor !== null) decodeCursor(query.cursor);
  return query;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mysqlPage<T>(
  values: readonly T[],
  query: CatalogListQuery,
  sortValue: (value: T) => string,
  id: (value: T) => string
): readonly T[] {
  const checked = checkedListQuery(query);
  const multiplier = checked.direction === "asc" ? 1 : -1;
  const sorted = [...values].sort((left, right) => multiplier * (
    compareCodePoints(sortValue(left), sortValue(right))
    || compareCodePoints(id(left), id(right))
  ));
  const cursor = checked.cursor === null ? null : decodeCursor(checked.cursor);
  return sorted.filter((value) => {
    if (!cursor) return true;
    return multiplier * (
      compareCodePoints(sortValue(value), cursor[0])
      || compareCodePoints(id(value), cursor[1])
    ) > 0;
  }).slice(0, checked.limit);
}

function lifecycleConflict<T extends { status: string; revision: number }>(
  current: T,
  expectedRevision: number,
  expectedStatus: string,
  code: string
): void {
  if (current.revision !== expectedRevision) {
    commandAbort({ kind: "revision_conflict", actualRevision: current.revision });
  }
  if (current.status !== expectedStatus) {
    commandAbort({ kind: "state_conflict", code });
  }
}

export class MysqlCatalogRepository implements CatalogRepository {
  private readonly temporalBarrier: GrowthTemporalBarrier | null;

  constructor(
    private readonly pool: mysql.Pool,
    temporalBarrier?: GrowthTemporalBarrier
  ) {
    this.temporalBarrier = temporalBarrier
      ? assertGrowthTemporalBarrier(temporalBarrier) : null;
  }

  private async command<T>(
    workspaceId: string,
    work: (
      connection: mysql.PoolConnection,
      transaction: MysqlGrowthTemporalTransaction,
      stamp: { recordedAt: string; temporalSequence: number }
    ) => Promise<CatalogCommandResult<T>>,
    packageGraphGuard = false
  ): Promise<CatalogCommandResult<T>> {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    if (!this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const temporalBarrier = this.temporalBarrier;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const transaction = new MysqlGrowthTemporalTransaction(connection);
      const stamp = await temporalBarrier.allocateAppend(
        transaction,
        concreteWorkspaceId
      );
      if (packageGraphGuard) {
        await this.withPackageGraphGuard(connection, concreteWorkspaceId);
      }
      const result = await work(connection, transaction, stamp);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (error instanceof MysqlCatalogCommandAbort) {
        return error.result as CatalogCommandResult<T>;
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async withPackageGraphGuard(
    connection: mysql.PoolConnection,
    workspaceId: string
  ): Promise<void> {
    await connection.query(
      `INSERT INTO catalog_package_graph_guards (workspace_id) VALUES (?)
       ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
      [workspaceId]
    );
    await connection.query(
      `SELECT workspace_id FROM catalog_package_graph_guards
       WHERE workspace_id = ? FOR UPDATE`,
      [workspaceId]
    );
    const locks: readonly [string, string][] = [
      ["catalog_items", "id"],
      ["package_versions", "id"],
      ["pricing_policy_versions", "id"],
      ["package_components",
        "package_version_id,component_catalog_item_id,component_pricing_policy_version_id"],
      ["package_versions", "package_catalog_item_id,currency,valid_from,id"],
      ["package_cost_snapshots", "pricing_policy_version_id"]
    ];
    for (const [table, order] of locks) {
      await connection.query(
        `SELECT * FROM ${table} WHERE workspace_id = ?
         ORDER BY ${order.split(",").map((column) => `BINARY ${column}`).join(",")}
         FOR UPDATE`,
        [workspaceId]
      );
    }
  }

  async appendCatalogItem(item: CatalogItem): Promise<CatalogItem> {
    const stored = normalizeCatalogItemInstants(item);
    await insertCatalogItem(this.pool, stored);
    return immutableClone(stored) as CatalogItem;
  }

  findCatalogItem(workspaceId: string, id: string): Promise<CatalogItem | null> {
    return first(this.pool,
      "SELECT * FROM catalog_items WHERE workspace_id = ? AND id = ?",
      [workspaceId, id], parseCatalogItem);
  }

  async listCatalogItems(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly CatalogItem[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    checkedListQuery(query);
    const values: unknown[] = [concrete];
    let sql = "SELECT * FROM catalog_items WHERE workspace_id = ?";
    if (query.type !== undefined) {
      sql += " AND item_type = ?";
      values.push(query.type);
    }
    if (query.status !== undefined) {
      sql += " AND item_status = ?";
      values.push(query.status);
    }
    const [rows] = await this.pool.query(sql, values);
    const items = (rows as MysqlRow[]).map(parseCatalogItem);
    return immutableClone(mysqlPage(
      items, query,
      (item) => query.sort === "updatedAt" ? item.updatedAt : item[query.sort],
      (item) => item.id
    )) as readonly CatalogItem[];
  }

  async appendPricingPolicyVersion(
    policy: PricingPolicyVersion
  ): Promise<PricingPolicyVersion> {
    const stored = normalizePricingPolicyVersionInstants(policy);
    await insertPricingPolicy(this.pool, stored);
    return immutableClone(stored) as PricingPolicyVersion;
  }

  findPricingPolicyVersion(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PricingPolicyVersion | null> {
    return first(this.pool,
      "SELECT * FROM pricing_policy_versions WHERE workspace_id = ? AND id = ?",
      [workspaceId, pricingPolicyVersionId], parsePricingPolicy);
  }

  async listPricingPolicies(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly PricingPolicyVersion[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    checkedListQuery(query);
    const values: unknown[] = [concrete];
    let sql = `SELECT p.*,i.code AS parent_code,i.name AS parent_name,
      i.updated_at AS parent_updated_at
      FROM pricing_policy_versions p
      INNER JOIN catalog_items i
        ON i.workspace_id = p.workspace_id AND i.id = p.catalog_item_id
      WHERE p.workspace_id = ?`;
    if (query.type !== undefined) {
      sql += " AND i.item_type = ?";
      values.push(query.type);
    }
    if (query.status !== undefined) {
      sql += " AND i.item_status = ?";
      values.push(query.status);
    }
    const [rows] = await this.pool.query(sql, values);
    const rowList = rows as MysqlRow[];
    const byId = new Map(rowList.map((row) => [String(row.id), row]));
    const policies = rowList.map(parsePricingPolicy);
    return immutableClone(mysqlPage(
      policies, query,
      (policy) => {
        const row = byId.get(policy.id)!;
        return query.sort === "code" ? String(row.parent_code)
          : query.sort === "name" ? String(row.parent_name)
            : instant(row.parent_updated_at);
      },
      (policy) => policy.id
    )) as readonly PricingPolicyVersion[];
  }

  async appendPackageVersion(version: PackageVersion): Promise<PackageVersion> {
    const stored = normalizePackageVersionInstants(version);
    await this.pool.query(
      `INSERT INTO package_versions (
        workspace_id,id,package_catalog_item_id,version,currency,package_status,
        valid_from,valid_to,revision,created_by,created_at,updated_at,
        recorded_at,temporal_sequence
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [stored.workspaceId, stored.id, stored.packageCatalogItemId,
        stored.version, stored.currency, stored.status,
        growthMysqlDate(stored.validFrom),
        stored.validTo ? growthMysqlDate(stored.validTo) : null,
        stored.revision, stored.createdBy, growthMysqlDate(stored.createdAt),
        growthMysqlDate(stored.updatedAt), growthMysqlDate(stored.updatedAt),
        0]
    );
    return immutableClone(stored) as PackageVersion;
  }

  findPackageVersion(workspaceId: string, id: string): Promise<PackageVersion | null> {
    return first(this.pool,
      "SELECT * FROM package_versions WHERE workspace_id = ? AND id = ?",
      [workspaceId, id], parsePackageVersion);
  }

  async listPackageVersions(
    workspaceId: string,
    itemId: string,
    query: CatalogListQuery
  ): Promise<readonly PackageVersion[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    checkedListQuery(query);
    const values: unknown[] = [concrete, itemId];
    let sql = `SELECT v.*,i.code AS parent_code,i.name AS parent_name,
      i.updated_at AS parent_updated_at
      FROM package_versions v
      INNER JOIN catalog_items i
        ON i.workspace_id = v.workspace_id AND i.id = v.package_catalog_item_id
      WHERE v.workspace_id = ? AND v.package_catalog_item_id = ?`;
    if (query.type !== undefined) {
      sql += " AND i.item_type = ?";
      values.push(query.type);
    }
    if (query.status !== undefined) {
      sql += " AND i.item_status = ?";
      values.push(query.status);
    }
    const [rows] = await this.pool.query(sql, values);
    const rowList = rows as MysqlRow[];
    const byId = new Map(rowList.map((row) => [String(row.id), row]));
    const versions = rowList.map(parsePackageVersion);
    return immutableClone(mysqlPage(
      versions, query,
      (version) => {
        const row = byId.get(version.id)!;
        return query.sort === "code" ? String(row.parent_code)
          : query.sort === "name" ? String(row.parent_name)
            : version.updatedAt;
      },
      (version) => version.id
    )) as readonly PackageVersion[];
  }

  async listPackageComponents(
    workspaceId: string,
    packageVersionId: string
  ): Promise<readonly PackageComponent[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT c.* FROM package_components c
       INNER JOIN package_versions v
         ON v.workspace_id = c.workspace_id AND v.id = c.package_version_id
       WHERE c.workspace_id = ? AND c.package_version_id = ?
       ORDER BY c.component_catalog_item_id,c.component_pricing_policy_version_id`,
      [concrete, packageVersionId]
    );
    return immutableClone(
      (rows as MysqlRow[]).map(parsePackageComponent)
    ) as readonly PackageComponent[];
  }

  findPackageCostSnapshot(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PackageCostSnapshot | null> {
    return first(
      this.pool,
      `SELECT * FROM package_cost_snapshots
       WHERE workspace_id = ? AND pricing_policy_version_id = ?`,
      [workspaceId, pricingPolicyVersionId],
      parsePackageCostSnapshot
    );
  }

  async replaceDraftPackageComponents(
    workspaceId: string,
    packageVersionId: string,
    components: readonly PackageComponent[]
  ): Promise<readonly PackageComponent[]> {
    if (components.some((component) => component.workspaceId !== workspaceId
      || component.packageVersionId !== packageVersionId)) {
      throw Object.assign(new Error("invalid_package_component_scope"), {
        code: "invalid_package_component_scope"
      });
    }
    if (!this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const temporalBarrier = this.temporalBarrier;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const transaction = new MysqlGrowthTemporalTransaction(connection);
      const stamped: StampedPackageComponent[] = [];
      let emptyStamp: CatalogAppendStamp | null = null;
      if (components.length === 0) {
        emptyStamp = await temporalBarrier.allocateAppend(transaction, workspaceId);
      } else {
        for (const component of components) {
          const stamp = await temporalBarrier.allocateAppend(
            transaction,
            workspaceId
          );
          stamped.push({ component, stamp });
        }
      }
      const [rows] = await connection.query(
        `SELECT package_status,updated_at FROM package_versions
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspaceId, packageVersionId]
      );
      const version = (rows as MysqlRow[])[0];
      if (!version) throw new Error("package_version_not_found");
      if (version.package_status !== "draft") throw new Error("package_version_immutable");
      await connection.query(
        "DELETE FROM package_components WHERE workspace_id = ? AND package_version_id = ?",
        [workspaceId, packageVersionId]
      );
      if (emptyStamp) {
        await connection.query(
          `UPDATE package_versions SET recorded_at = ?,temporal_sequence = ?
           WHERE workspace_id = ? AND id = ?`,
          [growthMysqlDate(emptyStamp.recordedAt), emptyStamp.temporalSequence,
            workspaceId, packageVersionId]
        );
      }
      for (const { component, stamp } of stamped) {
        await connection.query(
          `INSERT INTO package_components (
            workspace_id,package_version_id,component_catalog_item_id,
            component_pricing_policy_version_id,quantity_micros,
            recorded_at,temporal_sequence
          ) VALUES (?,?,?,?,?,?,?)`,
          [workspaceId, packageVersionId, component.componentCatalogItemId,
            component.componentPricingPolicyVersionId, component.quantityMicros,
            growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
        );
      }
      await connection.commit();
      return immutableClone(
        stamped.map((entry) => entry.component)
      ) as readonly PackageComponent[];
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createCatalogItem(
    command: CreateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (connection, _tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "catalog_item.create",
        "catalog_item", (resourceId) => first(
          connection,
          "SELECT * FROM catalog_items WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parseCatalogItem
        )
      );
      if (replay) commandAbort(replay);
      const [rows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND (id = ? OR code = ?)
         ORDER BY id FOR UPDATE`,
        [command.workspaceId, command.id, command.code]
      );
      const matches = rows as MysqlRow[];
      const idRow = matches.find((row) => row.id === command.id);
      if (idRow) {
        commandAbort({ kind: "state_conflict", code: "catalog_item_id_conflict" });
      }
      if (matches.some((row) => row.code === command.code)) {
        commandAbort({ kind: "state_conflict", code: "catalog_code_conflict" });
      }
      const item = immutableClone(normalizeCatalogItemInstants({
        id: command.id,
        workspaceId: command.workspaceId,
        type: command.type,
        code: command.code,
        name: command.name,
        description: command.description,
        unit: command.unit,
        status: "active" as const,
        revision: 1,
        createdBy: command.actorId,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      await insertCatalogItem(connection, item, stamp);
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "catalog_item.create",
        "catalog_item", command.id, stamp
      );
      return { kind: "ok", value: item, replayed: false };
    });
  }

  async updateCatalogItem(
    command: UpdateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (connection, _tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "catalog_item.update",
        "catalog_item", (resourceId) => first(
          connection,
          "SELECT * FROM catalog_items WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parseCatalogItem
        )
      );
      if (replay) commandAbort(replay);
      const [rows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.id]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) commandAbort({ kind: "not_found" });
      const current = parseCatalogItem(row);
      lifecycleConflict(
        current, command.expectedRevision, "active", "catalog_item_retired"
      );
      const next = immutableClone(normalizeCatalogItemInstants({
        ...current,
        ...command.patch,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      await connection.query(
        `UPDATE catalog_items
         SET name = ?,description = ?,unit = ?,revision = ?,updated_at = ?,
           recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
        [next.name, next.description, next.unit, next.revision,
          growthMysqlDate(next.updatedAt), growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence,
          command.workspaceId, command.id, command.expectedRevision]
      );
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "catalog_item.update",
        "catalog_item", command.id, stamp
      );
      return { kind: "ok", value: next, replayed: false };
    });
  }

  async retireCatalogItem(
    command: RetireCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (connection, _tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "catalog_item.retire",
        "catalog_item", (resourceId) => first(
          connection,
          "SELECT * FROM catalog_items WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parseCatalogItem
        )
      );
      if (replay) commandAbort(replay);
      const [rows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.id]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) commandAbort({ kind: "not_found" });
      const current = parseCatalogItem(row);
      lifecycleConflict(
        current, command.expectedRevision, "active", "catalog_item_retired"
      );
      const next = immutableClone(normalizeCatalogItemInstants({
        ...current,
        status: "retired" as const,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      await connection.query(
        `UPDATE catalog_items
         SET item_status = 'retired',revision = ?,updated_at = ?,
           recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
        [next.revision, growthMysqlDate(next.updatedAt),
          growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence,
          command.workspaceId, command.id, command.expectedRevision]
      );
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "catalog_item.retire",
        "catalog_item", command.id, stamp
      );
      return { kind: "ok", value: next, replayed: false };
    });
  }

  private mysqlValidationView(
    connection: mysql.PoolConnection
  ): CatalogLockedValidationView {
    return {
      findCatalogItem: (workspaceId, id) => first(
        connection,
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspaceId, id], parseCatalogItem
      ),
      findPricingPolicyVersion: (workspaceId, id) => first(
        connection,
        `SELECT * FROM pricing_policy_versions
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspaceId, id], parsePricingPolicy
      ),
      findPackageVersion: (workspaceId, id) => first(
        connection,
        `SELECT * FROM package_versions
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspaceId, id], parsePackageVersion
      ),
      listActivePricingPolicyWindowsForUpdate: async (
        workspaceId, catalogItemId, currency
      ) => {
        const [rows] = await connection.query(
          `SELECT * FROM pricing_policy_versions
           WHERE workspace_id = ? AND catalog_item_id = ? AND currency = ?
             AND policy_status = 'active'
           ORDER BY valid_from,id FOR UPDATE`,
          [workspaceId, catalogItemId, currency]
        );
        return immutableClone(
          (rows as MysqlRow[]).map(parsePricingPolicy)
        ) as readonly PricingPolicyVersion[];
      },
      listPackageComponents: async (workspaceId, id) => {
        const [rows] = await connection.query(
          `SELECT * FROM package_components
           WHERE workspace_id = ? AND package_version_id = ?
           ORDER BY component_catalog_item_id,component_pricing_policy_version_id
           FOR UPDATE`,
          [workspaceId, id]
        );
        return immutableClone(
          (rows as MysqlRow[]).map(parsePackageComponent)
        ) as readonly PackageComponent[];
      },
      listActivePackageVersionWindowsForUpdate: async (
        workspaceId, catalogItemId, currency
      ) => {
        const [rows] = await connection.query(
          `SELECT * FROM package_versions
           WHERE workspace_id = ? AND package_catalog_item_id = ?
             AND currency = ? AND package_status = 'active'
           ORDER BY BINARY valid_from,BINARY id FOR UPDATE`,
          [workspaceId, catalogItemId, currency]
        );
        return immutableClone(
          (rows as MysqlRow[]).map(parsePackageVersion)
        ) as readonly PackageVersion[];
      }
    };
  }

  async createPricingPolicyDraft(
    command: CreatePricingPolicyDraftCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.command(command.workspaceId, async (connection, _tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "pricing_policy.create_draft",
        "pricing_policy", (resourceId) => first(
          connection,
          `SELECT * FROM pricing_policy_versions
           WHERE workspace_id = ? AND id = ? FOR UPDATE`,
          [command.workspaceId, resourceId], parsePricingPolicy
        )
      );
      if (replay) commandAbort(replay);
      assertClosedPricingPolicyRules(command);
      const [parentRows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.catalogItemId]
      );
      const parentRow = (parentRows as MysqlRow[])[0];
      if (!parentRow) commandAbort({ kind: "not_found" });
      const parent = parseCatalogItem(parentRow);
      if (parent.status !== "active") {
        commandAbort({ kind: "state_conflict", code: "catalog_item_retired" });
      }
      const [existingRows] = await connection.query(
        `SELECT * FROM pricing_policy_versions
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.id]
      );
      const existingRow = (existingRows as MysqlRow[])[0];
      if (existingRow) {
        commandAbort({
          kind: "state_conflict", code: "pricing_policy_id_conflict"
        });
      }
      const [versionRows] = await connection.query(
        `SELECT MAX(version) AS max_version FROM pricing_policy_versions
         WHERE workspace_id = ? AND catalog_item_id = ?`,
        [command.workspaceId, command.catalogItemId]
      );
      const maxVersion = Number((versionRows as MysqlRow[])[0]?.max_version ?? 0);
      if (!Number.isSafeInteger(maxVersion) || maxVersion < 0) {
        throw new Error("invalid_pricing_policy_version");
      }
      const {
        actorId, idempotencyKey: _idempotencyKey,
        requestHash: _requestHash, ...fields
      } = command;
      const policy = immutableClone(normalizePricingPolicyVersionInstants({
        ...fields,
        version: maxVersion + 1,
        status: "draft" as const,
        revision: 1,
        createdBy: actorId,
        createdAt: stamp.recordedAt
      })) as PricingPolicyVersion;
      assertClosedPricingPolicyVersion(policy);
      await insertPricingPolicy(connection, policy, stamp);
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "pricing_policy.create_draft",
        "pricing_policy", command.id, stamp
      );
      return { kind: "ok", value: policy, replayed: false };
    });
  }

  private pricingLifecycle(
    command: PricingPolicyLifecycleCommand,
    from: PricingPolicyVersion["status"],
    to: PricingPolicyVersion["status"],
    invalidCode: string,
    operation: Extract<CatalogCommandOperation,
      "pricing_policy.activate" | "pricing_policy.retire">
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.command(command.workspaceId, async (connection, tx, initialStamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, operation,
        "pricing_policy", (resourceId) => first(
          connection,
          `SELECT * FROM pricing_policy_versions
           WHERE workspace_id = ? AND id = ? FOR UPDATE`,
          [command.workspaceId, resourceId], parsePricingPolicy
        )
      );
      if (replay) commandAbort(replay);
      const [discoveryRows] = await connection.query(
        `SELECT catalog_item_id FROM pricing_policy_versions
         WHERE workspace_id = ? AND id = ?`,
        [command.workspaceId, command.id]
      );
      const discovery = (discoveryRows as MysqlRow[])[0];
      if (!discovery) commandAbort({ kind: "not_found" });
      const catalogItemId = String(discovery.catalog_item_id);
      const [parentRows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, catalogItemId]
      );
      const parentRow = (parentRows as MysqlRow[])[0];
      if (!parentRow) commandAbort({ kind: "not_found" });
      const parent = parseCatalogItem(parentRow);
      const [rows] = await connection.query(
        `SELECT * FROM pricing_policy_versions
         WHERE workspace_id = ? AND id = ? AND catalog_item_id = ? FOR UPDATE`,
        [command.workspaceId, command.id, catalogItemId]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) commandAbort({ kind: "not_found" });
      const current = parsePricingPolicy(row);
      lifecycleConflict(current, command.expectedRevision, from, invalidCode);
      const snapshot = command.validate
        ? await command.validate(this.mysqlValidationView(connection), current, parent)
        : undefined;
      let stamp = initialStamp;
      if (snapshot) {
        if (snapshot.workspaceId !== command.workspaceId
          || snapshot.pricingPolicyVersionId !== command.id
          || snapshot.packageVersionId !== current.packageVersionId) {
          commandAbort({
            kind: "state_conflict", code: "invalid_package_cost_snapshot"
          });
        }
        await connection.query(
          `INSERT INTO package_cost_snapshots (
            workspace_id,pricing_policy_version_id,package_version_id,
            component_unit_standard_cost_minor,package_own_unit_service_cost_minor,
            total_unit_standard_cost_minor,component_snapshot_hash,components_json,
            recorded_at,temporal_sequence
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [snapshot.workspaceId, snapshot.pricingPolicyVersionId,
            snapshot.packageVersionId, snapshot.componentUnitStandardCostMinor,
            snapshot.packageOwnUnitServiceCostMinor,
            snapshot.totalUnitStandardCostMinor, snapshot.componentSnapshotHash,
            JSON.stringify(snapshot.components), growthMysqlDate(initialStamp.recordedAt),
            initialStamp.temporalSequence]
        );
        if (!this.temporalBarrier) throw new Error("catalog_temporal_adapter_required");
        stamp = await this.temporalBarrier.allocateAppend(tx, command.workspaceId);
      }
      if (to === "retired") {
        const [inUseRows] = await connection.query(
          `SELECT c.package_version_id FROM package_components c
           INNER JOIN package_versions v
             ON v.workspace_id = c.workspace_id AND v.id = c.package_version_id
           WHERE c.workspace_id = ?
             AND c.component_pricing_policy_version_id = ?
             AND v.package_status = 'active'
           ORDER BY BINARY c.package_version_id LIMIT 1 FOR UPDATE`,
          [command.workspaceId, command.id]
        );
        if ((inUseRows as MysqlRow[]).length > 0) commandAbort({
          kind: "state_conflict",
          code: "pricing_policy_in_use_by_active_package"
        });
      }
      const next = immutableClone(normalizePricingPolicyVersionInstants({
        ...current,
        capabilityRegistryVersion: to === "active"
          ? command.capabilityRegistryVersion ?? current.capabilityRegistryVersion
          : current.capabilityRegistryVersion,
        status: to,
        revision: current.revision + 1
      })) as PricingPolicyVersion;
      assertClosedPricingPolicyVersion(next);
      await connection.query(
        `UPDATE pricing_policy_versions
         SET policy_status = ?,capability_registry_version = ?,revision = ?,
           recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
        [to, next.capabilityRegistryVersion, next.revision,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence,
          command.workspaceId, command.id, command.expectedRevision]
      );
      await insertCatalogReceipt(
        connection, command.workspaceId, command, operation,
        "pricing_policy", command.id, stamp
      );
      return { kind: "ok", value: next, replayed: false };
    }, command.validate !== undefined);
  }

  activatePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.pricingLifecycle(
      command, "draft", "active", "pricing_policy_not_draft",
      "pricing_policy.activate"
    );
  }

  retirePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.pricingLifecycle(
      command, "active", "retired", "pricing_policy_not_active",
      "pricing_policy.retire"
    );
  }

  private async mysqlPackageComponentsWithStamps(
    connection: mysql.PoolConnection,
    transaction: MysqlGrowthTemporalTransaction,
    workspaceId: string,
    packageVersionId: string,
    components: readonly PackageComponentDraft[]
  ): Promise<readonly StampedPackageComponent[]> {
    if (!this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const temporalBarrier = this.temporalBarrier;
    const result: StampedPackageComponent[] = [];
    for (const component of components) {
      if (!Number.isSafeInteger(component.quantityMicros)
        || component.quantityMicros <= 0) {
        throw Object.assign(new Error("invalid_package_component_quantity"), {
          code: "invalid_package_component_quantity"
        });
      }
      const stamp = await temporalBarrier.allocateAppend(
        transaction,
        workspaceId
      );
      result.push({
        component: { workspaceId, packageVersionId, ...component },
        stamp
      });
    }
    void connection;
    return immutableClone(result) as readonly StampedPackageComponent[];
  }

  private async insertPackageComponents(
    connection: mysql.PoolConnection,
    components: readonly StampedPackageComponent[]
  ): Promise<void> {
    for (const { component, stamp } of components) {
      await connection.query(
        `INSERT INTO package_components (
          workspace_id,package_version_id,component_catalog_item_id,
          component_pricing_policy_version_id,quantity_micros,
          recorded_at,temporal_sequence
        ) VALUES (?,?,?,?,?,?,?)`,
        [component.workspaceId, component.packageVersionId,
          component.componentCatalogItemId,
          component.componentPricingPolicyVersionId, component.quantityMicros,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
      );
    }
  }

  async createPackageVersionDraft(
    command: CreatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (connection, tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "package_version.create_draft",
        "package_version", (resourceId) => first(
          connection,
          "SELECT * FROM package_versions WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parsePackageVersion
        )
      );
      if (replay) commandAbort(replay);
      const [parentRows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.packageCatalogItemId]
      );
      const parentRow = (parentRows as MysqlRow[])[0];
      if (!parentRow) commandAbort({ kind: "not_found" });
      const parent = parseCatalogItem(parentRow);
      if (command.expectedParentRevision !== undefined
        && parent.revision !== command.expectedParentRevision) {
        commandAbort({ kind: "revision_conflict", actualRevision: parent.revision });
      }
      if (parent.type !== "package" || parent.status !== "active") {
        commandAbort({ kind: "state_conflict", code: "invalid_package_catalog_item" });
      }
      const [existingRows] = await connection.query(
        `SELECT * FROM package_versions
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, command.id]
      );
      const existingRow = (existingRows as MysqlRow[])[0];
      if (existingRow) {
        commandAbort({
          kind: "state_conflict", code: "package_version_id_conflict"
        });
      }
      const [versionRows] = await connection.query(
        `SELECT MAX(version) AS max_version FROM package_versions
         WHERE workspace_id = ? AND package_catalog_item_id = ?`,
        [command.workspaceId, command.packageCatalogItemId]
      );
      const maxVersion = Number((versionRows as MysqlRow[])[0]?.max_version ?? 0);
      if (!Number.isSafeInteger(maxVersion) || maxVersion < 0) {
        throw new Error("invalid_package_version");
      }
      const components = await this.mysqlPackageComponentsWithStamps(
        connection, tx, command.workspaceId, command.id, command.components
      );
      const version = immutableClone(normalizePackageVersionInstants({
        id: command.id,
        workspaceId: command.workspaceId,
        packageCatalogItemId: command.packageCatalogItemId,
        version: maxVersion + 1,
        currency: command.currency,
        status: "draft" as const,
        validFrom: command.validFrom,
        validTo: command.validTo,
        revision: 1,
        createdBy: command.actorId,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      if (command.validate) {
        await command.validate(
          this.mysqlValidationView(connection),
          version,
          components.map((entry) => entry.component)
        );
      }
      await connection.query(
        `INSERT INTO package_versions (
          workspace_id,id,package_catalog_item_id,version,currency,package_status,
          valid_from,valid_to,revision,created_by,created_at,updated_at,
          recorded_at,temporal_sequence
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [version.workspaceId, version.id, version.packageCatalogItemId,
          version.version, version.currency, version.status,
          growthMysqlDate(version.validFrom),
          version.validTo ? growthMysqlDate(version.validTo) : null,
          version.revision, version.createdBy, growthMysqlDate(version.createdAt),
          growthMysqlDate(version.updatedAt), growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence]
      );
      await this.insertPackageComponents(connection, components);
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "package_version.create_draft",
        "package_version", command.id, stamp
      );
      return { kind: "ok", value: version, replayed: false };
    }, command.validate !== undefined);
  }

  async updatePackageVersionDraft(
    command: UpdatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (connection, tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, "package_version.update_draft",
        "package_version", (resourceId) => first(
          connection,
          "SELECT * FROM package_versions WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parsePackageVersion
        )
      );
      if (replay) commandAbort(replay);
      const [discoveryRows] = await connection.query(
        `SELECT package_catalog_item_id FROM package_versions
         WHERE workspace_id = ? AND id = ?`,
        [command.workspaceId, command.id]
      );
      const discovery = (discoveryRows as MysqlRow[])[0];
      if (!discovery) commandAbort({ kind: "not_found" });
      const catalogItemId = String(discovery.package_catalog_item_id);
      const [parentRows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, catalogItemId]
      );
      if (!(parentRows as MysqlRow[])[0]) commandAbort({ kind: "not_found" });
      const [rows] = await connection.query(
        `SELECT * FROM package_versions
         WHERE workspace_id = ? AND id = ? AND package_catalog_item_id = ? FOR UPDATE`,
        [command.workspaceId, command.id, catalogItemId]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) commandAbort({ kind: "not_found" });
      const current = parsePackageVersion(row);
      lifecycleConflict(
        current, command.expectedRevision, "draft", "package_version_immutable"
      );
      const { components: componentPatch, ...fieldPatch } = command.patch;
      const components = componentPatch === undefined ? null
        : await this.mysqlPackageComponentsWithStamps(
          connection, tx, command.workspaceId, command.id, componentPatch
        );
      const next = immutableClone(normalizePackageVersionInstants({
        ...current,
        ...fieldPatch,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      if (command.validate) {
        const lockedComponents = components
          ? components.map((entry) => entry.component)
          : await this.mysqlValidationView(connection).listPackageComponents(
              command.workspaceId, command.id
            );
        await command.validate(
          this.mysqlValidationView(connection), next, lockedComponents
        );
      }
      await connection.query(
        `UPDATE package_versions
         SET currency = ?,valid_from = ?,valid_to = ?,revision = ?,updated_at = ?,
           recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
        [next.currency, growthMysqlDate(next.validFrom),
          next.validTo ? growthMysqlDate(next.validTo) : null, next.revision,
          growthMysqlDate(next.updatedAt), growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence,
          command.workspaceId, command.id, command.expectedRevision]
      );
      if (components) {
        await connection.query(
          `DELETE FROM package_components
           WHERE workspace_id = ? AND package_version_id = ?`,
          [command.workspaceId, command.id]
        );
        await this.insertPackageComponents(connection, components);
      }
      await insertCatalogReceipt(
        connection, command.workspaceId, command, "package_version.update_draft",
        "package_version", command.id, stamp
      );
      return { kind: "ok", value: next, replayed: false };
    }, command.validate !== undefined);
  }

  private packageLifecycle(
    command: PackageVersionLifecycleCommand,
    from: PackageVersion["status"],
    to: PackageVersion["status"],
    invalidCode: string,
    operation: Extract<CatalogCommandOperation,
      "package_version.activate" | "package_version.retire">
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (connection, _tx, stamp) => {
      const replay = await mysqlReceiptReplay(
        connection, command.workspaceId, command, operation,
        "package_version", (resourceId) => first(
          connection,
          "SELECT * FROM package_versions WHERE workspace_id = ? AND id = ? FOR UPDATE",
          [command.workspaceId, resourceId], parsePackageVersion
        )
      );
      if (replay) commandAbort(replay);
      const [discoveryRows] = await connection.query(
        `SELECT package_catalog_item_id FROM package_versions
         WHERE workspace_id = ? AND id = ?`,
        [command.workspaceId, command.id]
      );
      const discovery = (discoveryRows as MysqlRow[])[0];
      if (!discovery) commandAbort({ kind: "not_found" });
      const catalogItemId = String(discovery.package_catalog_item_id);
      const [parentRows] = await connection.query(
        `SELECT * FROM catalog_items
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspaceId, catalogItemId]
      );
      if (!(parentRows as MysqlRow[])[0]) commandAbort({ kind: "not_found" });
      const [rows] = await connection.query(
        `SELECT * FROM package_versions
         WHERE workspace_id = ? AND id = ? AND package_catalog_item_id = ? FOR UPDATE`,
        [command.workspaceId, command.id, catalogItemId]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) commandAbort({ kind: "not_found" });
      const current = parsePackageVersion(row);
      lifecycleConflict(current, command.expectedRevision, from, invalidCode);
      const [componentRows] = await connection.query(
        `SELECT * FROM package_components
         WHERE workspace_id = ? AND package_version_id = ?
         ORDER BY component_catalog_item_id,component_pricing_policy_version_id
         FOR UPDATE`,
        [command.workspaceId, command.id]
      );
      const components = immutableClone(
        (componentRows as MysqlRow[]).map(parsePackageComponent)
      ) as readonly PackageComponent[];
      if (command.validate) {
        await command.validate(
          this.mysqlValidationView(connection), current, components
        );
      }
      if (to === "retired") {
        const [inUseRows] = await connection.query(
          `SELECT id FROM pricing_policy_versions
           WHERE workspace_id = ? AND package_version_id = ?
             AND policy_status = 'active'
           ORDER BY BINARY id LIMIT 1 FOR UPDATE`,
          [command.workspaceId, command.id]
        );
        if ((inUseRows as MysqlRow[]).length > 0) commandAbort({
          kind: "state_conflict", code: "package_version_in_use"
        });
      }
      const next = immutableClone(normalizePackageVersionInstants({
        ...current,
        status: to,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      await connection.query(
        `UPDATE package_versions
         SET package_status = ?,revision = ?,updated_at = ?,recorded_at = ?,
           temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
        [to, next.revision, growthMysqlDate(next.updatedAt),
          growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence,
          command.workspaceId, command.id, command.expectedRevision]
      );
      await insertCatalogReceipt(
        connection, command.workspaceId, command, operation,
        "package_version", command.id, stamp
      );
      return { kind: "ok", value: next, replayed: false };
    }, command.validate !== undefined);
  }

  activatePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.packageLifecycle(
      command, "draft", "active", "package_version_not_draft",
      "package_version.activate"
    );
  }

  retirePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.packageLifecycle(
      command, "active", "retired", "package_version_not_active",
      "package_version.retire"
    );
  }

  findCommissionProductLink(
    workspaceId: string,
    commissionProductId: string
  ): Promise<CommissionProductCatalogLink | null> {
    return first(this.pool,
      `SELECT * FROM commission_product_catalog_links
       WHERE workspace_id = ? AND commission_product_id = ?`,
      [workspaceId, commissionProductId], parseLink);
  }

  findCommissionCatalogMigrationRun(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<CommissionCatalogMigrationRun | null> {
    return findRun(this.pool, workspaceId, idempotencyKey);
  }

  async commitCommissionCatalogMigration(
    commit: CommissionCatalogMigrationCommit
  ): Promise<CommissionCatalogMigrationRun> {
    commit = normalizeCommissionCatalogMigrationCommit(commit);
    assertCommissionCatalogMigrationCommitInvariant(commit);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const existing = await findRun(
        connection,
        commit.run.workspaceId,
        commit.run.idempotencyKey,
        true
      );
      if (existing) {
        if (existing.inputSnapshotHash !== commit.run.inputSnapshotHash) {
          throw migrationConflict();
        }
        await connection.commit();
        return existing;
      }
      const entryProductIds = new Set(
        commit.entries.map((entry) => entry.link.commissionProductId)
      );
      for (const result of commit.run.items) {
        if (result.status !== "migrated"
          || entryProductIds.has(result.commissionProductId)) continue;
        const [authorityRows] = await connection.query(
          `SELECT l.workspace_id,l.commission_product_id,l.catalog_item_id,
             l.pricing_policy_version_id,i.id AS item_id,
             p.id AS policy_id,p.catalog_item_id AS policy_catalog_item_id
           FROM commission_product_catalog_links l
           INNER JOIN catalog_items i
             ON i.workspace_id = l.workspace_id AND i.id = l.catalog_item_id
           INNER JOIN pricing_policy_versions p
             ON p.workspace_id = l.workspace_id
            AND p.id = l.pricing_policy_version_id
           WHERE l.workspace_id = ? AND l.commission_product_id = ?
           FOR UPDATE`,
          [commit.run.workspaceId, result.commissionProductId]
        );
        const authority = (authorityRows as MysqlRow[])[0];
        if (!authority
          || authority.workspace_id !== commit.run.workspaceId
          || authority.commission_product_id !== result.commissionProductId
          || authority.catalog_item_id !== result.catalogItemId
          || authority.pricing_policy_version_id !== result.pricingPolicyVersionId
          || authority.item_id !== result.catalogItemId
          || authority.policy_id !== result.pricingPolicyVersionId
          || authority.policy_catalog_item_id !== result.catalogItemId) {
          throw Object.assign(
            new Error("invalid_commission_catalog_migration_commit"),
            { code: "invalid_commission_catalog_migration_commit" }
          );
        }
      }
      await connection.query(
        `INSERT INTO commission_catalog_migration_runs (
          workspace_id,id,actor_id,idempotency_key,input_snapshot_hash,
          started_at,completed_at,run_status,scanned,migrated,repair_required,
          report_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [commit.run.workspaceId, commit.run.id, commit.run.actorId,
          commit.run.idempotencyKey, commit.run.inputSnapshotHash,
          growthMysqlDate(commit.run.startedAt),
          growthMysqlDate(commit.run.completedAt),
          commit.run.status, commit.run.scanned, commit.run.migrated,
          commit.run.repairRequired, commit.run.reportHash]
      );
      for (const entry of commit.entries) {
        await insertCatalogItem(
          connection, normalizeCatalogItemInstants(entry.item)
        );
        await insertPricingPolicy(
          connection,
          normalizePricingPolicyVersionInstants(entry.pricingPolicy)
        );
        await connection.query(
          `INSERT INTO commission_product_catalog_links (
            workspace_id,commission_product_id,catalog_item_id,
            pricing_policy_version_id,migrated_at
          ) VALUES (?,?,?,?,?)`,
          [entry.link.workspaceId, entry.link.commissionProductId,
            entry.link.catalogItemId, entry.link.pricingPolicyVersionId,
            growthMysqlDate(entry.link.migratedAt)]
        );
      }
      for (const item of commit.run.items) {
        await connection.query(
          `INSERT INTO commission_catalog_migration_items (
            workspace_id,migration_run_id,commission_product_id,item_status,
            result_code,snapshot_json,snapshot_hash,catalog_item_id,
            pricing_policy_version_id
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
          [item.workspaceId, commit.run.id, item.commissionProductId,
            item.status, item.code, JSON.stringify(item.snapshot), item.snapshotHash,
            item.catalogItemId, item.pricingPolicyVersionId]
        );
      }
      await connection.commit();
      return immutableClone(commit.run) as CommissionCatalogMigrationRun;
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        const existing = await findRun(
          connection,
          commit.run.workspaceId,
          commit.run.idempotencyKey
        );
        if (existing) {
          if (existing.inputSnapshotHash !== commit.run.inputSnapshotHash) {
            throw migrationConflict();
          }
          return existing;
        }
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
