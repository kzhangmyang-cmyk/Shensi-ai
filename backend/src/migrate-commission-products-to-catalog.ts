import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  MysqlCatalogRepository,
  ensureCatalogMysqlSchema
} from "./catalog-mysql-repository.js";
import {
  CommissionCatalogMigrationService,
  type CommissionProductMigrationSource
} from "./commission-catalog-migration.js";

export interface CommissionCatalogMigrationCliArguments {
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
}

const CLI_ARGUMENTS = ["workspace", "actor", "idempotency"] as const;
type CliArgumentName = typeof CLI_ARGUMENTS[number];

export function parseCommissionCatalogMigrationArguments(
  arguments_: readonly string[]
): CommissionCatalogMigrationCliArguments {
  const allowed = new Set<string>(CLI_ARGUMENTS);
  const values = new Map<CliArgumentName, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("--")) {
      throw new Error(`unknown argument ${argument}`);
    }
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument ${flag}`);
    const typedName = name as CliArgumentName;
    if (values.has(typedName)) throw new Error(`duplicate --${name}`);
    const rawValue = separator >= 0
      ? argument.slice(separator + 1)
      : arguments_[index + 1];
    if (rawValue === undefined) throw new Error(`missing --${name}`);
    const value = rawValue.trim();
    if (!value) throw new Error(`blank --${name}`);
    if (value.startsWith("-")) {
      throw new Error(`flag-looking value for --${name}`);
    }
    if (value === "all") throw new Error(`invalid --${name}`);
    if (separator < 0) {
      index += 1;
    }
    values.set(typedName, value);
  }
  for (const name of CLI_ARGUMENTS) {
    if (!values.has(name)) throw new Error(`missing --${name}`);
  }
  return Object.freeze({
    workspaceId: values.get("workspace")!,
    actorId: values.get("actor")!,
    idempotencyKey: values.get("idempotency")!
  });
}

function databaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim()
    || process.env.MYSQL_URL?.trim();
  if (!configured) {
    throw new Error("commission catalog migration requires DATABASE_URL or MYSQL_URL");
  }
  const url = new URL(configured);
  if (url.protocol !== "mysql:") throw new Error("database URL must use mysql protocol");
  return configured;
}

export function commissionProductMigrationSourceFromRow(
  row: Record<string, unknown>
): CommissionProductMigrationSource {
  return {
    id: String(row.id),
    name: String(row.name),
    category: String(row.category ?? ""),
    model: String(row.model ?? ""),
    currency: String(row.currency),
    defaultPrice: row.default_price,
    costPrice: row.cost_price,
    status: row.status === "active" ? "active" : "disabled",
    remark: String(row.remark ?? ""),
    ownerId: String(row.owner_id),
    teamId: String(row.team_id),
    updatedAt: row.updated_at
  };
}

async function main(): Promise<void> {
  const { workspaceId, actorId, idempotencyKey } =
    parseCommissionCatalogMigrationArguments(process.argv.slice(2));
  const pool = mysql.createPool({
    uri: databaseUrl(),
    connectionLimit: 2,
    timezone: "Z",
    dateStrings: true
  });
  try {
    await ensureCatalogMysqlSchema(pool);
    const repository = new MysqlCatalogRepository(pool);
    const service = new CommissionCatalogMigrationService({
      repository,
      products: async (workspace) => {
        const [rows] = await pool.query(
          `SELECT id,name,category,model,currency,default_price,cost_price,
             status,remark,owner_id,team_id,updated_at
           FROM commission_products
           WHERE team_id = ?
           ORDER BY id`,
          [workspace]
        );
        return (rows as Array<Record<string, unknown>>)
          .map(commissionProductMigrationSourceFromRow);
      }
    });
    const run = await service.execute(workspaceId, actorId, idempotencyKey);
    const summary = Object.freeze({
      id: run.id,
      workspaceId: run.workspaceId,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      scanned: run.scanned,
      migrated: run.migrated,
      repairRequired: run.repairRequired,
      reportHash: run.reportHash
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
