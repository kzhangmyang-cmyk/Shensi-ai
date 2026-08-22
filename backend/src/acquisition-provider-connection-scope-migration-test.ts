import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type mysql from "mysql2/promise";
import {
  ensureProviderConnectionOwnerTeamUniqueness
} from "./mysql-store.js";

const schemaSources = [
  readFileSync(new URL("../schema.mysql.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../goodjob_crm.full.sql", import.meta.url), "utf8"),
  readFileSync(new URL("./mysql-store.ts", import.meta.url), "utf8")
];

test("provider connection fresh schemas enforce owner-and-team uniqueness", () => {
  for (const source of schemaSources) {
    assert.match(
      source,
      /CREATE TABLE(?: IF NOT EXISTS)? provider_catalog\s*\(/u
    );
    assert.match(
      source,
      /CREATE TABLE(?: IF NOT EXISTS)? provider_connections\s*\([\s\S]*?credential_version BIGINT UNSIGNED NOT NULL DEFAULT 1[\s\S]*?UNIQUE KEY uk_provider_connection_owner_team\s*\(\s*provider_id\s*,\s*owner_id\s*,\s*team_id\s*\)/u
    );
    assert.doesNotMatch(
      source,
      /UNIQUE KEY uk_provider_connection_owner\s*\(\s*provider_id\s*,\s*owner_id\s*\)/u
    );
  }
});

interface IndexDefinition {
  columns: string[];
  unique: boolean;
}

class FakeProviderConnectionIndexPool {
  readonly calls: string[] = [];
  readonly indexes = new Map<string, IndexDefinition>();
  failIndexName: string | null;
  readonly duplicateScopes: Array<{
    providerId: string;
    ownerId: string;
    teamId: string;
    duplicateCount: number;
    connectionIds: string;
  }>;

  constructor(
    indexes: Record<string, IndexDefinition>,
    duplicateScopes: FakeProviderConnectionIndexPool[
      "duplicateScopes"
    ] = [],
    failIndexName: string | null = null
  ) {
    for (const [name, definition] of Object.entries(indexes)) {
      this.indexes.set(name, structuredClone(definition));
    }
    this.duplicateScopes = structuredClone(duplicateScopes);
    this.failIndexName = failIndexName;
  }

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (
      normalized.includes("FROM provider_connections")
      && normalized.includes("GROUP BY provider_id")
    ) {
      return [structuredClone(this.duplicateScopes), []];
    }
    if (normalized.includes("FROM information_schema.statistics")) {
      const indexName = String(values[1] ?? "");
      const definition = this.indexes.get(indexName);
      if (normalized.includes("COUNT(*) AS count")) {
        return [[{ count: definition ? definition.columns.length : 0 }], []];
      }
      return [
        (definition?.columns ?? []).map((columnName) => ({
          columnName,
          nonUnique: definition?.unique ? 0 : 1
        })),
        []
      ];
    }
    const replace = normalized.match(
      /ALTER TABLE `provider_connections` DROP INDEX `([^`]+)`, ADD UNIQUE KEY `([^`]+)` \(([^)]+)\)/u
    );
    if (replace) {
      if (replace[2] === this.failIndexName) {
        throw new Error(`injected DDL failure: ${replace[2]}`);
      }
      this.indexes.delete(replace[1]!);
      this.indexes.set(replace[2]!, {
        columns: [...replace[3]!.matchAll(/`([^`]+)`/gu)]
          .map((match) => match[1]!),
        unique: true
      });
      return [{ affectedRows: 0 }, []];
    }
    const add = normalized.match(
      /ALTER TABLE `provider_connections` ADD UNIQUE KEY `([^`]+)` \(([^)]+)\)/u
    );
    if (add) {
      if (add[1] === this.failIndexName) {
        throw new Error(`injected DDL failure: ${add[1]}`);
      }
      this.indexes.set(add[1]!, {
        columns: [...add[2]!.matchAll(/`([^`]+)`/gu)]
          .map((match) => match[1]!),
        unique: true
      });
      return [{ affectedRows: 0 }, []];
    }
    const drop = normalized.match(
      /ALTER TABLE `provider_connections` DROP INDEX `([^`]+)`/u
    );
    if (drop) {
      this.indexes.delete(drop[1]!);
      return [{ affectedRows: 0 }, []];
    }
    throw new Error(`Unexpected query: ${normalized}`);
  }
}

function asPool(pool: FakeProviderConnectionIndexPool) {
  return pool as unknown as mysql.Pool;
}

test("legacy provider connection indexes upgrade safely and idempotently", async () => {
  const pool = new FakeProviderConnectionIndexPool({
    uk_provider_connection_owner: {
      columns: ["provider_id", "owner_id"],
      unique: true
    },
    uk_provider_connection_owner_team: {
      columns: ["provider_id", "team_id"],
      unique: true
    }
  });

  await ensureProviderConnectionOwnerTeamUniqueness(asPool(pool));
  assert.deepEqual(
    pool.indexes.get("uk_provider_connection_owner_team"),
    {
      columns: ["provider_id", "owner_id", "team_id"],
      unique: true
    }
  );
  assert.equal(pool.indexes.has("uk_provider_connection_owner"), false);
  const firstPassAlterCalls = pool.calls.filter(
    (sql) => sql.startsWith("ALTER TABLE")
  );
  assert.ok(
    firstPassAlterCalls.findIndex((sql) =>
      sql.includes("ADD UNIQUE KEY `uk_provider_connection_owner_team`"))
    < firstPassAlterCalls.findIndex((sql) =>
      sql.includes("DROP INDEX `uk_provider_connection_owner`"))
  );

  await ensureProviderConnectionOwnerTeamUniqueness(asPool(pool));
  assert.deepEqual(
    pool.calls.filter((sql) => sql.startsWith("ALTER TABLE")),
    firstPassAlterCalls
  );
});

test("a malformed canonical index without legacy protection is replaced behind a temporary guard", async () => {
  const pool = new FakeProviderConnectionIndexPool({
    uk_provider_connection_owner_team: {
      columns: ["provider_id", "owner_id"],
      unique: true
    }
  });

  await ensureProviderConnectionOwnerTeamUniqueness(asPool(pool));
  assert.deepEqual(
    pool.indexes.get("uk_provider_connection_owner_team"),
    {
      columns: ["provider_id", "owner_id", "team_id"],
      unique: true
    }
  );
  assert.equal(
    pool.indexes.has("uk_provider_connection_owner_team_migration"),
    false
  );
  const alters = pool.calls.filter((sql) => sql.startsWith("ALTER TABLE"));
  assert.match(
    alters[0]!,
    /ADD UNIQUE KEY `uk_provider_connection_owner_team_migration`/u
  );
  assert.match(
    alters[1]!,
    /DROP INDEX `uk_provider_connection_owner_team`, ADD UNIQUE KEY `uk_provider_connection_owner_team`/u
  );
});

test("a malformed temporary index is repaired atomically before canonical replacement", async () => {
  const pool = new FakeProviderConnectionIndexPool({
    uk_provider_connection_owner_team: {
      columns: ["provider_id", "owner_id"],
      unique: true
    },
    uk_provider_connection_owner_team_migration: {
      columns: ["owner_id", "team_id"],
      unique: false
    }
  });

  await ensureProviderConnectionOwnerTeamUniqueness(asPool(pool));
  assert.deepEqual(
    pool.indexes.get("uk_provider_connection_owner_team"),
    {
      columns: ["provider_id", "owner_id", "team_id"],
      unique: true
    }
  );
  assert.equal(
    pool.indexes.has("uk_provider_connection_owner_team_migration"),
    false
  );
  const firstAlter = pool.calls.find((sql) =>
    sql.startsWith("ALTER TABLE")
  );
  assert.match(
    firstAlter!,
    /DROP INDEX `uk_provider_connection_owner_team_migration`, ADD UNIQUE KEY `uk_provider_connection_owner_team_migration`/u
  );
});

test("canonical DDL failure leaves the temporary unique guard for a safe retry", async () => {
  const canonical = "uk_provider_connection_owner_team";
  const temporary = "uk_provider_connection_owner_team_migration";
  const pool = new FakeProviderConnectionIndexPool(
    {
      [canonical]: {
        columns: ["provider_id", "owner_id"],
        unique: true
      }
    },
    [],
    canonical
  );

  await assert.rejects(
    ensureProviderConnectionOwnerTeamUniqueness(asPool(pool)),
    /injected DDL failure/u
  );
  assert.deepEqual(pool.indexes.get(temporary), {
    columns: ["provider_id", "owner_id", "team_id"],
    unique: true
  });
  assert.deepEqual(pool.indexes.get(canonical), {
    columns: ["provider_id", "owner_id"],
    unique: true
  });

  pool.failIndexName = null;
  await ensureProviderConnectionOwnerTeamUniqueness(asPool(pool));
  assert.deepEqual(pool.indexes.get(canonical), {
    columns: ["provider_id", "owner_id", "team_id"],
    unique: true
  });
  assert.equal(pool.indexes.has(temporary), false);
});

test("provider connection scope duplicates fail fast without deleting BYOK rows", async () => {
  const duplicateScopes = [{
    providerId: "serper",
    ownerId: "owner-a",
    teamId: "team-a",
    duplicateCount: 2,
    connectionIds: "connection-a,connection-b"
  }];
  const pool = new FakeProviderConnectionIndexPool(
    {},
    duplicateScopes
  );

  await assert.rejects(
    ensureProviderConnectionOwnerTeamUniqueness(asPool(pool)),
    /PROVIDER_CONNECTION_SCOPE_DUPLICATES.*serper.*owner-a.*team-a/u
  );
  assert.deepEqual(pool.duplicateScopes, duplicateScopes);
  assert.equal(
    pool.calls.some((sql) => /ALTER TABLE|DELETE FROM/u.test(sql)),
    false
  );
});
