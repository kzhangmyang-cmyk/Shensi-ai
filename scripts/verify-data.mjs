import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments, requireEnvironmentName } from "./lib/cli-arguments.mjs";
import { parseMysqlUrl, requireDistinctDatabases } from "./lib/database-url.mjs";

const REQUIRED_TABLES = [
  "acquisition_runs",
  "agent_jobs",
  "ai_model_configs",
  "ai_model_credential_versions",
  "financial_council_runs",
  "provider_connections",
  "users"
];

const INTEGRITY_HASH_ALLOWLIST = new Set([
  "acquisition_runs.plan_snapshot_hash",
  "acquisition_runs.budget_snapshot_hash",
  "ai_model_configs.capability_certification_hash",
  "ai_job_model_snapshots.capability_snapshot_hash",
  "ai_job_model_snapshots.prompt_hash",
  "ai_job_model_snapshots.schema_hash",
  "ai_model_call_records.capability_snapshot_hash",
  "ai_model_call_records.parameter_hash",
  "ai_model_call_records.result_hash",
  "financial_council_runs.request_hash",
  "financial_council_runs.statement_package_hash",
  "financial_council_runs.snapshot_hash"
]);

const CIPHERTEXT_IDENTITY_TABLES = [
  {
    table: "ai_model_credential_versions",
    order: ["connection_id", "credential_version"],
    columns: [
      "connection_id", "credential_version", "provider", "owner_id", "team_id",
      "credential_ref", "api_key_encrypted", "key_mask", "created_by", "created_at"
    ]
  },
  {
    table: "provider_connections",
    order: ["id"],
    columns: [
      "id", "provider_id", "scope", "credential_ref", "credential_version",
      "configuration_encrypted", "status", "quota_policy_json", "budget_policy_json",
      "last_health_at", "last_health_status", "last_error_code", "last_health_message",
      "usage_text", "owner_id", "team_id", "created_by", "created_at", "updated_at"
    ]
  },
  {
    table: "agent_jobs",
    order: ["id"],
    columns: [
      "id", "team_id", "owner_id", "job_type", "aggregate_type", "aggregate_id",
      "parent_job_id", "status", "priority", "idempotency_key", "policy_version",
      "input_json_encrypted", "output_json_encrypted", "attempt_count", "max_attempts",
      "next_attempt_at", "error_code", "error_message", "trace_id", "started_at",
      "finished_at", "created_at"
    ]
  }
];

function required(env, name) {
  if (!env[name]) throw new Error(`ENV_REQUIRED:${name}`);
  return env[name];
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(values, selector = (value) => JSON.stringify(value)) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

function normalizedSnapshot(snapshot) {
  return {
    tables: sorted(snapshot.tables, (row) => row.name),
    schemaMetadata: sorted(snapshot.schemaMetadata, (row) => row.table),
    migrationMetadata: sorted(snapshot.migrationMetadata),
    userIds: sorted(snapshot.userIds, String),
    workspaceIds: sorted(snapshot.workspaceIds, String),
    acquisitionRuns: sorted(snapshot.acquisitionRuns, (row) => row.id),
    financialCouncilRuns: sorted(snapshot.financialCouncilRuns, (row) => `${row.id}:${row.workspaceId || ""}`),
    modelConnections: sorted(snapshot.modelConnections, (row) => row.id),
    integrityHashes: sorted(snapshot.integrityHashes.filter((entry) =>
      INTEGRITY_HASH_ALLOWLIST.has(`${entry.table}.${entry.column}`))),
    ciphertextIdentities: sorted(snapshot.ciphertextIdentities ?? [], (entry) => entry.table)
  };
}

export function compareDataSnapshots(sourceInput, targetInput, now = new Date()) {
  const source = normalizedSnapshot(sourceInput);
  const target = normalizedSnapshot(targetInput);
  const sourceTableNames = source.tables.map((row) => row.name);
  const targetTableNames = target.tables.map((row) => row.name);
  const checks = [
    {
      code: "REQUIRED_TABLE_MISSING",
      passed: REQUIRED_TABLES.every((table) => sourceTableNames.includes(table) && targetTableNames.includes(table))
    },
    { code: "TABLE_SET_MISMATCH", passed: same(sourceTableNames, targetTableNames) },
    { code: "TABLE_COUNT_MISMATCH", passed: same(source.tables, target.tables) },
    { code: "SCHEMA_METADATA_MISMATCH", passed: same(source.schemaMetadata, target.schemaMetadata) },
    { code: "MIGRATION_METADATA_MISMATCH", passed: same(source.migrationMetadata, target.migrationMetadata) },
    {
      code: "STABLE_ID_MISMATCH",
      passed: same(source.userIds, target.userIds) && same(source.workspaceIds, target.workspaceIds)
    },
    { code: "ACQUISITION_RUN_MISMATCH", passed: same(source.acquisitionRuns, target.acquisitionRuns) },
    {
      code: "FINANCIAL_COUNCIL_RUN_MISMATCH",
      passed: same(source.financialCouncilRuns, target.financialCouncilRuns)
    },
    { code: "MODEL_CONNECTION_MISMATCH", passed: same(source.modelConnections, target.modelConnections) },
    { code: "INTEGRITY_HASH_MISMATCH", passed: same(source.integrityHashes, target.integrityHashes) },
    {
      code: "ENCRYPTED_ROW_IDENTITY_MISSING",
      passed: CIPHERTEXT_IDENTITY_TABLES.every(({ table }) =>
        source.ciphertextIdentities.some((entry) => entry.table === table)
        && target.ciphertextIdentities.some((entry) => entry.table === table))
    },
    {
      code: "ENCRYPTED_ROW_IDENTITY_MISMATCH",
      passed: same(source.ciphertextIdentities, target.ciphertextIdentities)
    }
  ];
  const failures = checks.filter((check) => !check.passed).map((check) => check.code);
  return {
    format: "shensi-data-verification.v1",
    classification: "non-sensitive-identifiers-and-hashes",
    createdAt: now.toISOString(),
    passed: failures.length === 0,
    codes: failures.length === 0 ? ["VERIFICATION_PASSED"] : failures,
    checks,
    source,
    target
  };
}

async function readDatabaseSnapshot(parsed) {
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const mysql = require("mysql2/promise");
  const connection = await mysql.createConnection({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database
  });
  try {
    const [tableRows] = await connection.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [parsed.database]
    );
    const tableNames = tableRows.map((row) => String(row.table_name));
    const tableSet = new Set(tableNames);
    const [columnRows] = await connection.query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
              COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable,
              COLUMN_DEFAULT AS column_default, EXTRA AS extra
         FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [parsed.database]
    );
    const columnMap = new Map();
    for (const row of columnRows) {
      const table = String(row.table_name);
      const columns = columnMap.get(table) ?? [];
      columns.push({
        name: String(row.column_name),
        type: String(row.column_type),
        nullable: String(row.is_nullable),
        default: row.column_default === null ? null : String(row.column_default),
        extra: String(row.extra)
      });
      columnMap.set(table, columns);
    }
    const tables = [];
    for (const name of tableNames) {
      const [[row]] = await connection.query(
        `SELECT COUNT(*) AS row_count FROM ${mysql.escapeId(name)}`
      );
      tables.push({ name, count: Number(row.row_count) });
    }
    const schemaMetadata = tableNames.map((table) => ({
      table,
      columns: columnMap.get(table) ?? []
    }));
    const versionColumns = new Set(["schema_version", "persistence_schema_version", "contract_version"]);
    const migrationMetadata = [];
    for (const [table, columns] of columnMap) {
      for (const column of columns.map((entry) => entry.name).filter((name) => versionColumns.has(name))) {
        const identifier = mysql.escapeId(column);
        const [rows] = await connection.query(
          `SELECT DISTINCT ${identifier} AS value FROM ${mysql.escapeId(table)}
            WHERE ${identifier} IS NOT NULL ORDER BY ${identifier} LIMIT 101`
        );
        migrationMetadata.push({ table, column, values: rows.map((row) => String(row.value)) });
      }
    }
    const userIds = [];
    const workspaceIds = new Set();
    if (tableSet.has("users")) {
      const [rows] = await connection.query("SELECT id, team_id FROM users ORDER BY id");
      for (const row of rows) {
        userIds.push(String(row.id));
        workspaceIds.add(String(row.team_id));
      }
    }
    const acquisitionRuns = [];
    if (tableSet.has("acquisition_runs")) {
      const [rows] = await connection.query(
        `SELECT id, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.status')), '') AS status
           FROM acquisition_runs ORDER BY id`
      );
      for (const row of rows) acquisitionRuns.push({ id: String(row.id), status: String(row.status) });
    }
    const financialCouncilRuns = [];
    if (tableSet.has("financial_council_runs")) {
      const [rows] = await connection.query(
        "SELECT run_id, workspace_id, status FROM financial_council_runs ORDER BY workspace_id, run_id"
      );
      for (const row of rows) {
        workspaceIds.add(String(row.workspace_id));
        financialCouncilRuns.push({
          id: String(row.run_id), workspaceId: String(row.workspace_id), status: String(row.status)
        });
      }
    }
    const modelConnections = [];
    if (tableSet.has("ai_model_configs")) {
      const [rows] = await connection.query(
        `SELECT id, provider, model, credential_version, is_default
           FROM ai_model_configs ORDER BY id`
      );
      for (const row of rows) {
        modelConnections.push({
          id: String(row.id),
          provider: String(row.provider),
          model: String(row.model),
          credentialVersion: Number(row.credential_version),
          isDefault: Boolean(row.is_default)
        });
      }
    }
    const integrityHashes = [];
    for (const qualified of INTEGRITY_HASH_ALLOWLIST) {
      const [table, column] = qualified.split(".");
      const columns = columnMap.get(table) ?? [];
      if (tableSet.has(table) && columns.some((entry) => entry.name === column)) {
        const identifier = mysql.escapeId(column);
        const [rows] = await connection.query(
          `SELECT ${identifier} AS hash FROM ${mysql.escapeId(table)}
            WHERE ${identifier} IS NOT NULL AND ${identifier} <> ''
            ORDER BY ${identifier} LIMIT 5`
        );
        for (const row of rows) {
          integrityHashes.push({ table, column, hash: String(row.hash) });
        }
      }
    }
    const ciphertextIdentities = [];
    for (const definition of CIPHERTEXT_IDENTITY_TABLES) {
      if (!tableSet.has(definition.table)) continue;
      const actualColumns = new Set((columnMap.get(definition.table) ?? []).map((entry) => entry.name));
      for (const column of definition.columns) {
        if (!actualColumns.has(column)) {
          throw new Error(`ENCRYPTED_IDENTITY_COLUMN_MISSING:${definition.table}.${column}`);
        }
      }
      const projection = definition.columns.map((column) => mysql.escapeId(column)).join(", ");
      const order = definition.order.map((column) => mysql.escapeId(column)).join(", ");
      const [rows] = await connection.query(
        `SELECT SHA2(CAST(JSON_ARRAY(${projection}) AS CHAR), 256) AS row_digest
           FROM ${mysql.escapeId(definition.table)} ORDER BY ${order}`
      );
      const aggregate = createHash("sha256").update(`${definition.table}\n`);
      for (const row of rows) aggregate.update(String(row.row_digest)).update("\n");
      ciphertextIdentities.push({
        table: definition.table,
        rowCount: rows.length,
        aggregateDigest: aggregate.digest("hex")
      });
    }
    return {
      tables, schemaMetadata, migrationMetadata, userIds,
      workspaceIds: [...workspaceIds], acquisitionRuns, financialCouncilRuns,
      modelConnections, integrityHashes, ciphertextIdentities
    };
  } finally {
    await connection.end();
  }
}

function reportTimestamp(value) {
  return value.toISOString().replace(/[.:]/gu, "-");
}

export function parseVerificationArguments(argv) {
  return parseCliArguments(argv, {
    "--source-env": { key: "sourceEnv" },
    "--inventory-only": { key: "inventoryOnly", boolean: true },
    "--output": { key: "output" }
  });
}

export async function verifyData({
  env = process.env,
  snapshotDatabase = readDatabaseSnapshot,
  now = new Date(),
  root = resolve(import.meta.dirname, ".."),
  sourceEnvName = "SOURCE_DATABASE_URL",
  targetEnvName = "TARGET_DATABASE_URL",
  inventoryOnly = false,
  reportPathOverride
} = {}) {
  const sourceName = requireEnvironmentName(sourceEnvName, "SOURCE_DATABASE_URL");
  const source = parseMysqlUrl(required(env, sourceName));
  if (inventoryOnly) {
    const sourceSnapshot = normalizedSnapshot(await snapshotDatabase(source));
    const report = {
      format: "shensi-data-inventory.v1",
      classification: "non-sensitive-identifiers-and-hashes",
      createdAt: now.toISOString(),
      passed: true,
      codes: ["INVENTORY_CAPTURED"],
      source: sourceSnapshot
    };
    const reportPath = resolve(reportPathOverride || env.VERIFICATION_REPORT || resolve(
      env.BACKUP_DIRECTORY || resolve(root, "backups"),
      `${reportTimestamp(now)}-shensi-source-inventory.json`
    ));
    await writeReport(reportPath, report);
    return { report, reportPath };
  }
  const targetName = requireEnvironmentName(targetEnvName, "TARGET_DATABASE_URL");
  const target = parseMysqlUrl(required(env, targetName));
  if (target.database !== "shensi") throw new Error("TARGET_DATABASE_MUST_BE_SHENSI");
  requireDistinctDatabases(source.database, target.database);
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    snapshotDatabase(source), snapshotDatabase(target)
  ]);
  const report = compareDataSnapshots(sourceSnapshot, targetSnapshot, now);
  const reportPath = resolve(reportPathOverride || env.VERIFICATION_REPORT || resolve(
    env.BACKUP_DIRECTORY || resolve(root, "backups"),
    `${reportTimestamp(now)}-shensi-verification.json`
  ));
  await writeReport(reportPath, report);
  return { report, reportPath };
}

async function writeReport(reportPath, report) {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const handle = await open(reportPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseVerificationArguments(process.argv.slice(2));
  const result = await verifyData({
    sourceEnvName: options.sourceEnv,
    inventoryOnly: options.inventoryOnly,
    reportPathOverride: options.output
  });
  console.log(JSON.stringify({
    code: result.report.passed ? "SHENSI_DATA_VERIFICATION_OK" : "SHENSI_DATA_VERIFICATION_FAILED",
    reportFile: basename(result.reportPath),
    checks: result.report.codes
  }));
  if (!result.report.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "DATA_VERIFICATION_FAILED");
    process.exitCode = 1;
  });
}
