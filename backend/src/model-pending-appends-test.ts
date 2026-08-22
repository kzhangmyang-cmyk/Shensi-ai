import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  persistThenClearModelAppendBatches
} from "./model-providers/pending-appends.js";
import { ensureAiModelJobIdCapacity } from "./mysql-store.js";
import type {
  ModelConnectionActivationEvent,
  ModelConnectionIdempotencyRecord,
  ModelCredentialVersion,
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";
import type {
  ModelCallRecord
} from "./model-providers/call-ledger.js";

function batches() {
  return {
    pendingModelCredentialVersions: [] as ModelCredentialVersion[],
    pendingModelConnectionActivationEvents:
      [] as ModelConnectionActivationEvent[],
    pendingAiJobModelSnapshots: [] as StoredAiJobModelSnapshot[],
    pendingModelConnectionIdempotencyRecords:
      [] as ModelConnectionIdempotencyRecord[],
    pendingModelCallRecords: [] as ModelCallRecord[]
  };
}

test("pending model appends clear only persisted rows after success", async () => {
  const live = batches();
  live.pendingModelCredentialVersions.push(
    { connectionId: "conn-1", version: 1 } as ModelCredentialVersion
  );
  live.pendingModelConnectionActivationEvents.push(
    { id: "event-1" } as ModelConnectionActivationEvent
  );
  live.pendingAiJobModelSnapshots.push(
    { jobId: "job-1" } as StoredAiJobModelSnapshot
  );
  live.pendingModelConnectionIdempotencyRecords.push(
    {
      ownerId: "owner-1",
      idempotencyKeyHash: "hash-1"
    } as ModelConnectionIdempotencyRecord
  );
  live.pendingModelCallRecords.push(
    { id: "call-1" } as ModelCallRecord
  );
  const persisted = structuredClone(live);
  live.pendingModelCredentialVersions.push(
    { connectionId: "conn-2", version: 2 } as ModelCredentialVersion
  );

  await persistThenClearModelAppendBatches(
    live,
    persisted,
    async () => {}
  );
  assert.deepEqual(
    live.pendingModelCredentialVersions.map(
      (item) => `${item.connectionId}:${item.version}`
    ),
    ["conn-2:2"]
  );
  assert.deepEqual(live.pendingModelConnectionActivationEvents, []);
  assert.deepEqual(live.pendingAiJobModelSnapshots, []);
  assert.deepEqual(live.pendingModelConnectionIdempotencyRecords, []);
  assert.deepEqual(live.pendingModelCallRecords, []);
});

test("failed model append persistence throws and retains every pending row", async () => {
  const live = batches();
  live.pendingModelConnectionActivationEvents.push(
    { id: "event-retry" } as ModelConnectionActivationEvent
  );
  const persisted = structuredClone(live);

  await assert.rejects(
    persistThenClearModelAppendBatches(
      live,
      persisted,
      async () => {
        throw new Error("insert failed");
      }
    ),
    /insert failed/
  );
  assert.equal(live.pendingModelConnectionActivationEvents.length, 1);
});

test("MySQL persists pending model rows with strict inserts, not loaded history", () => {
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  for (const pendingName of [
    "pendingModelCredentialVersions",
    "pendingModelConnectionActivationEvents",
    "pendingAiJobModelSnapshots",
    "pendingModelConnectionIdempotencyRecords",
    "pendingModelCallRecords"
  ]) {
    assert.match(source, new RegExp(`insertRows[\\s\\S]+${pendingName}`));
  }
  assert.doesNotMatch(
    source,
    /INSERT IGNORE INTO ai_(?:model_credential_versions|model_connection_activation_events|job_model_snapshots|model_connection_idempotency|model_call_records)/
  );
});

test("model call ledger is loaded and appended durably without payload columns", () => {
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  const schemas = [
    readFileSync(new URL("../schema.mysql.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../goodjob_crm.full.sql", import.meta.url), "utf8")
  ];
  assert.match(source, /modelCallRecords:\s*await loadModelCallRecords\(pool\)/);
  assert.match(source, /SELECT \* FROM ai_model_call_records/);
  assert.match(
    source,
    /insertRows\(connection, "ai_model_call_records", store\.pendingModelCallRecords/
  );
  for (const schema of schemas) {
    assert.match(schema, /CREATE TABLE ai_model_call_records/);
    assert.match(schema, /PRIMARY KEY\(id\)/);
    const table = schema.match(
      /CREATE TABLE ai_model_call_records \([\s\S]*?\n\);/
    )?.[0] || "";
    assert.doesNotMatch(
      table,
      /\b(?:prompt|output|api_key|credential_plaintext)\b/i
    );
  }
});

test("MySQL migration backfills immutable endpoints for pre-existing job snapshots", () => {
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /UPDATE ai_job_model_snapshots AS snapshot[\s\S]*JOIN ai_model_configs AS config[\s\S]*snapshot\.base_url = TRIM\(TRAILING '\/' FROM config\.base_url\)[\s\S]*SHA2\(TRIM\(TRAILING '\/' FROM config\.base_url\), 256\)[\s\S]*snapshot\.base_url = ''[\s\S]*snapshot\.base_url_fingerprint = ''/
  );
});

test("MySQL migration widens both official model job identities before use", async () => {
  const statements: string[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      if (/information_schema\.columns/iu.test(sql)) {
        return [[{
          maximumLength: 90,
          characterSet: "utf8mb4",
          collationName: "utf8mb4_general_ci",
          tableName: values?.[0]
        }], []];
      }
      return [[], []];
    }
  };

  await ensureAiModelJobIdCapacity(pool as never);

  assert.deepEqual(
    statements.filter((statement) => statement.startsWith("ALTER TABLE")),
    [
    "ALTER TABLE ai_job_model_snapshots MODIFY COLUMN job_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "ALTER TABLE ai_model_call_records MODIFY COLUMN job_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL"
    ]
  );
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  const schemas = [
    readFileSync(new URL("../schema.mysql.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../goodjob_crm.full.sql", import.meta.url), "utf8")
  ];
  for (const text of [source, ...schemas]) {
    const snapshotTable = text.match(
      /CREATE TABLE(?: IF NOT EXISTS)? ai_job_model_snapshots \([\s\S]*?\n\);/
    )?.[0] || "";
    const callTable = text.match(
      /CREATE TABLE(?: IF NOT EXISTS)? ai_model_call_records \([\s\S]*?\n\);/
    )?.[0] || "";
    assert.match(
      snapshotTable,
      /job_id VARCHAR\(255\) CHARACTER SET ascii COLLATE ascii_bin/
    );
    assert.match(
      callTable,
      /job_id VARCHAR\(255\) CHARACTER SET ascii COLLATE ascii_bin/
    );
  }
});

test("MySQL job identity migration is inert when both columns are compliant", async () => {
  const altered: string[] = [];
  const pool = {
    async query(sql: string) {
      if (/^\s*ALTER TABLE/iu.test(sql)) altered.push(sql);
      return [[{
        maximumLength: 255,
        characterSet: "ascii",
        collationName: "ascii_bin"
      }], []];
    }
  };

  await ensureAiModelJobIdCapacity(pool as never);
  assert.deepEqual(altered, []);
});

test("MySQL persists immutable credential AAD and job content hashes", () => {
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  const schemas = [
    readFileSync(new URL("../schema.mysql.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../goodjob_crm.full.sql", import.meta.url), "utf8")
  ];

  assert.match(
    source,
    /ai_model_credential_versions[\s\S]*provider VARCHAR\(40\)/
  );
  assert.match(
    source,
    /UPDATE ai_model_credential_versions AS credential[\s\S]*JOIN ai_model_configs AS config[\s\S]*credential\.provider = config\.provider/
  );
  assert.match(
    source,
    /pendingModelCredentialVersions[\s\S]*item\.provider[\s\S]*\(connection_id,credential_version,provider,owner_id,team_id/
  );
  assert.match(
    source,
    /pendingAiJobModelSnapshots[\s\S]*item\.promptHash[\s\S]*item\.schemaHash[\s\S]*prompt_hash,schema_hash/
  );
  for (const schema of schemas) {
    const credentialTable = schema.match(
      /CREATE TABLE ai_model_credential_versions \([\s\S]*?\n\);/
    )?.[0] || "";
    const snapshotTable = schema.match(
      /CREATE TABLE ai_job_model_snapshots \([\s\S]*?\n\);/
    )?.[0] || "";
    assert.match(credentialTable, /\bprovider VARCHAR\(40\) NOT NULL/);
    assert.match(snapshotTable, /\bprompt_hash VARCHAR\(80\) NOT NULL/);
    assert.match(snapshotTable, /\bschema_hash VARCHAR\(80\) NOT NULL/);
  }
});

test("connection idempotency replay is loaded durably from hashed-key SQL", () => {
  const source = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  const schemas = [
    readFileSync(new URL("../schema.mysql.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../goodjob_crm.full.sql", import.meta.url), "utf8")
  ];
  assert.match(
    source,
    /modelConnectionIdempotencyRecords:\s*await loadModelConnectionIdempotencyRecords\(pool\)/
  );
  assert.match(
    source,
    /SELECT \* FROM ai_model_connection_idempotency/
  );
  assert.match(
    source,
    /insertRows\(connection, "ai_model_connection_idempotency", store\.pendingModelConnectionIdempotencyRecords/
  );
  for (const schema of schemas) {
    assert.match(schema, /CREATE TABLE ai_model_connection_idempotency/);
    assert.match(
      schema,
      /PRIMARY KEY\(owner_id, team_id, idempotency_key_hash\)/
    );
    assert.doesNotMatch(schema, /\bidempotency_key\s+VARCHAR/i);
  }
});
