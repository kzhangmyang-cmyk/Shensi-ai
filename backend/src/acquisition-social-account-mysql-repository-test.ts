import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import {
  acquisitionSocialAccountReplaysDdl,
  acquisitionSocialAccountsDdl,
  ensureAcquisitionSocialAccountsMysqlSchema,
  MysqlAcquisitionSocialAccountRepository
} from "./acquisition-social-account-mysql-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";

test("repository rejects raw cookie and profile fields and retains a restart-readable safe record", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await assert.rejects(repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", cookies: "nope" } as never));
  await repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  const stored = await repository.findByWorkspaceAndPlatform("w", "douyin");
  assert.equal(stored?.accountHandle, "h");
  assert.equal((stored as Record<string, unknown>).cookies, undefined);
});

test("MySQL bind uses a transaction and rolls back a competing active handle", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
    async execute(sql: string) { calls.push(sql.startsWith("SELECT") ? "select" : "write"); return [[{ id: "a", workspace_id: "w", platform: "douyin", account_handle: "other", display_name: null, state: "active", login_state_version: 1, revision: 1, etag: '"account-v1"', last_validated_at: null, created_at: "x", updated_at: "x" }], []] as never; }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({ getConnection: async () => connection } as never);
  const result = await repository.bindActive({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "new", displayName: null, state: "active", loginStateVersion: 1, revision: 2, etag: '"account-v2"', lastValidatedAt: null, createdAt: "x", updatedAt: "x" });
  assert.equal(result, "active_handle_conflict");
  assert.deepEqual(calls, ["begin", "select", "rollback", "release"]);
});

type ColumnMetadata = {
  columnType: string;
  nullable: "YES" | "NO";
  defaultValue: string | null;
};

const freshReplayColumns = new Map<string, ColumnMetadata>([
  ["workspace_id", { columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
  ["operation_name", { columnType: "varchar(120)", nullable: "NO", defaultValue: null }],
  ["idempotency_key_hash", { columnType: "char(64)", nullable: "NO", defaultValue: null }],
  ["request_hash", { columnType: "char(64)", nullable: "NO", defaultValue: null }],
  ["state", { columnType: "varchar(16)", nullable: "NO", defaultValue: null }],
  ["response_json", { columnType: "json", nullable: "YES", defaultValue: null }],
  ["response_status", { columnType: "int", nullable: "NO", defaultValue: "0" }],
  ["response_headers_json", { columnType: "json", nullable: "YES", defaultValue: null }],
  ["lease_owner", { columnType: "varchar(128)", nullable: "YES", defaultValue: null }],
  ["lease_expires_at", { columnType: "varchar(40)", nullable: "YES", defaultValue: null }],
  ["fencing_token", { columnType: "bigint unsigned", nullable: "NO", defaultValue: "0" }],
  ["expires_at", { columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["created_at", { columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["updated_at", { columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["completed_at", { columnType: "varchar(40)", nullable: "YES", defaultValue: null }]
]);

class StatefulLegacyReplaySchemaPool {
  readonly accountColumns = new Map([
    "id", "workspace_id", "platform", "account_handle", "display_name", "state", "login_state_version",
    "revision", "etag", "last_validated_at", "created_at", "updated_at"
  ].map((name) => [name, { columnType: "varchar(255)", nullable: "YES" as const, defaultValue: null }]));
  readonly replayColumns = new Map<string, ColumnMetadata>([
    ["workspace_id", { columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
    ["operation_name", { columnType: "varchar(120)", nullable: "NO", defaultValue: null }],
    ["idempotency_key", { columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
    ["request_hash", { columnType: "char(64)", nullable: "NO", defaultValue: null }],
    ["response_json", { columnType: "json", nullable: "NO", defaultValue: null }],
    ["response_status", { columnType: "int", nullable: "NO", defaultValue: null }]
  ]);
  readonly rows = [
    { idempotency_key: "raw-key-completed", idempotency_key_hash: null as string | null,
      response_status: 201, state: null as string | null, response_headers_json: null as object | null,
      completed_at: null as string | null, updated_at: "2026-08-24T00:00:00.000Z" },
    { idempotency_key: "raw-key-pending", idempotency_key_hash: null as string | null,
      response_status: 0, state: null as string | null, response_headers_json: null as object | null,
      completed_at: null as string | null, updated_at: "2026-08-24T00:00:00.000Z" }
  ];
  expiryIndex: string[] | null = ["updated_at"];
  stateCheck: string | null = "state IN ('completed')";

  private setColumn(definition: string) {
    const match = definition.match(/^(\w+) ((?:VAR)?CHAR\(\d+\)|JSON|INT|BIGINT UNSIGNED) (.*?)(?: AFTER \w+)?$/iu);
    if (!match) throw new Error(`unsupported column definition: ${definition}`);
    const [, name, columnType, qualifiers] = match;
    const defaultMatch = qualifiers.match(/\bDEFAULT (?:'([^']*)'|([^\s,]+))/iu);
    const rawDefault = defaultMatch?.[1] ?? defaultMatch?.[2] ?? null;
    this.replayColumns.set(name, {
      columnType: columnType.toLowerCase(),
      nullable: /\bNOT NULL\b/iu.test(qualifiers) ? "NO" : "YES",
      defaultValue: rawDefault === null || rawDefault.toUpperCase() === "NULL" ? null : rawDefault
    });
  }

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) return [{ affectedRows: 0 }, []];
    if (normalized.includes("information_schema.COLUMNS")) {
      const source = values[0] === "acquisition_social_accounts" ? this.accountColumns : this.replayColumns;
      return [[...source].map(([name, metadata]) => ({ COLUMN_NAME: name, COLUMN_TYPE: metadata.columnType,
        IS_NULLABLE: metadata.nullable, COLUMN_DEFAULT: metadata.defaultValue })), []];
    }
    if (normalized.includes("information_schema.STATISTICS")) {
      return [this.expiryIndex?.map((name, index) => ({ INDEX_NAME: "acquisition_social_account_replays_expiry",
        COLUMN_NAME: name, SEQ_IN_INDEX: index + 1, NON_UNIQUE: 1 })) ?? [], []];
    }
    if (normalized.includes("information_schema.TABLE_CONSTRAINTS")) {
      return [this.stateCheck ? [{ CONSTRAINT_NAME: "acquisition_social_account_replays_state", CHECK_CLAUSE: this.stateCheck }] : [], []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN upstream_session_id")) {
      this.accountColumns.set("upstream_session_id", { columnType: "varchar(512)", nullable: "YES", defaultValue: null });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_account_replays") && normalized.includes("DROP PRIMARY KEY")) {
      this.replayColumns.delete("idempotency_key");
      for (const row of this.rows) delete (row as Record<string, unknown>).idempotency_key;
      return [{ affectedRows: 0 }, []];
    }
    const columnChange = normalized.match(/^ALTER TABLE acquisition_social_account_replays (?:ADD|MODIFY) COLUMN (.+)$/iu);
    if (columnChange) {
      this.setColumn(columnChange[1]);
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays SET idempotency_key_hash=SHA2")) {
      for (const row of this.rows) row.idempotency_key_hash = createHash("sha256").update(row.idempotency_key).digest("hex");
      return [{ affectedRows: this.rows.length }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("state = IF")) {
      if (this.stateCheck && !this.stateCheck.includes("pending") && this.rows.some((row) => row.response_status === 0)) {
        throw new Error("legacy replay state check rejected pending backfill");
      }
      for (const row of this.rows) {
        row.state = row.response_status === 0 ? "pending" : "completed";
        row.response_headers_json = row.response_status === 0 ? row.response_headers_json : (row.response_headers_json ?? {});
        row.completed_at = row.response_status === 0 ? null : (row.completed_at ?? row.updated_at);
      }
      return [{ affectedRows: this.rows.length }, []];
    }
    if (normalized.includes("DROP INDEX acquisition_social_account_replays_expiry")) {
      this.expiryIndex = null;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes("ADD INDEX acquisition_social_account_replays_expiry")) {
      this.expiryIndex = ["expires_at"];
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes("DROP CHECK acquisition_social_account_replays_state")) {
      this.stateCheck = null;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes("ADD CONSTRAINT acquisition_social_account_replays_state CHECK")) {
      this.stateCheck = "(`state` in (_utf8mb4'pending',_utf8mb4'completed'))";
      return [{ affectedRows: 0 }, []];
    }
    throw new Error(`unexpected migration SQL: ${normalized}`);
  }
}

test("runtime migration makes a legacy replay table statefully identical to fresh DDL", async () => {
  const pool = new StatefulLegacyReplaySchemaPool();

  await ensureAcquisitionSocialAccountsMysqlSchema(pool as never);

  assert.deepEqual(
    Object.fromEntries([...pool.replayColumns].sort(([left], [right]) => left.localeCompare(right))),
    Object.fromEntries([...freshReplayColumns].sort(([left], [right]) => left.localeCompare(right)))
  );
  assert.deepEqual(pool.expiryIndex, ["expires_at"]);
  assert.match(pool.stateCheck ?? "", /state.*pending.*completed/iu);
  assert.deepEqual(pool.rows.map((row) => row.state), ["completed", "pending"]);
  assert.equal("idempotency_key" in pool.rows[0], false);
});

test("schema definitions contain restart-safe replay state and upstream handle metadata", () => {
  assert.match(acquisitionSocialAccountsDdl, /upstream_session_id VARCHAR\(512\) NULL/u);
  for (const column of ["state", "response_headers_json", "lease_owner", "lease_expires_at", "fencing_token", "expires_at", "created_at", "updated_at", "completed_at"]) {
    assert.match(acquisitionSocialAccountReplaysDdl, new RegExp(`\\b${column}\\b`, "u"));
  }
  assert.match(acquisitionSocialAccountReplaysDdl, /response_json JSON NULL/u);
  assert.match(acquisitionSocialAccountReplaysDdl, /idempotency_key_hash CHAR\(64\) NOT NULL/u);
  assert.doesNotMatch(acquisitionSocialAccountReplaysDdl, /idempotency_key VARCHAR/u);
});

test("both checked-in schema snapshots match the runtime social-account state", async () => {
  for (const name of ["schema.mysql.sql", "goodjob_crm.full.sql"]) {
    const snapshot = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    const account = snapshot.match(/CREATE TABLE acquisition_social_accounts \([\s\S]*?\n\)/u)?.[0] ?? "";
    const replay = snapshot.match(/CREATE TABLE acquisition_social_account_replays \([\s\S]*?\n\)/u)?.[0] ?? "";
    assert.match(account, /upstream_session_id VARCHAR\(512\) NULL/u, name);
    for (const column of ["idempotency_key_hash", "state", "response_json JSON NULL", "response_headers_json", "lease_owner", "lease_expires_at", "fencing_token", "expires_at", "created_at", "updated_at", "completed_at"]) {
      assert.match(replay, new RegExp(column.replaceAll(" ", "\\s+"), "u"), `${name}: ${column}`);
    }
  }
});

type ReplayRow = Record<string, unknown>;
type FakeState = {
  replays: Map<string, ReplayRow>;
  sessions: Map<string, Record<string, unknown>>;
  accounts: Map<string, Record<string, unknown>>;
};

class StatefulSocialMysqlPool {
  state: FakeState = { replays: new Map(), sessions: new Map(), accounts: new Map() };
  failNextCompletion = false;
  private transactionTail: Promise<void> = Promise.resolve();

  private clone(): FakeState { return structuredClone(this.state); }

  private replayKey(workspaceId: unknown, operation: unknown, key: unknown) {
    return `${String(workspaceId)}\u0000${String(operation)}\u0000${String(key)}`;
  }

  private async acquireTransaction() {
    const previous = this.transactionTail;
    let release = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }

  private async run(state: FakeState, sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith("INSERT IGNORE INTO acquisition_social_account_replays")) {
      const [workspaceId, operation, key, requestHash, leaseOwner, leaseExpiresAt, expiresAt, createdAt, updatedAt] = values;
      const replayKey = this.replayKey(workspaceId, operation, key);
      if (state.replays.has(replayKey)) return [{ affectedRows: 0 }, []];
      state.replays.set(replayKey, { workspace_id: workspaceId, operation_name: operation, idempotency_key_hash: key, request_hash: requestHash,
        state: "pending", response_json: null, response_status: 0, response_headers_json: null, lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt, fencing_token: 1, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, completed_at: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_replays")) {
      const [workspaceId, operation, key] = values;
      const row = state.replays.get(this.replayKey(workspaceId, operation, key));
      return [[row ? structuredClone(row) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET request_hash=?")) {
      const [requestHash, leaseOwner, leaseExpiresAt, expiresAt, createdAt, updatedAt, workspaceId, operation, key, fence] = values;
      const row = state.replays.get(this.replayKey(workspaceId, operation, key));
      if (!row || row.fencing_token !== fence) return [{ affectedRows: 0 }, []];
      Object.assign(row, { request_hash: requestHash, state: "pending", response_json: null, response_status: 0,
        response_headers_json: null, lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
        fencing_token: Number(row.fencing_token) + 1, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, completed_at: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET lease_owner=?")) {
      const [leaseOwner, leaseExpiresAt, updatedAt, expiresAt, workspaceId, operation, key, fence, attemptedAt] = values;
      const row = state.replays.get(this.replayKey(workspaceId, operation, key));
      const leaseExpired = row?.lease_expires_at == null || String(row.lease_expires_at) <= String(attemptedAt);
      if (!row || row.state !== "pending" || row.fencing_token !== fence || !leaseExpired) return [{ affectedRows: 0 }, []];
      Object.assign(row, { lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
        fencing_token: Number(row.fencing_token) + 1, updated_at: updatedAt, expires_at: expiresAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET state='completed'")) {
      if (this.failNextCompletion) { this.failNextCompletion = false; return [{ affectedRows: 0 }, []]; }
      const [response, status, headers, updatedAt, completedAt, workspaceId, operation, key, leaseOwner, fence, requestHash] = values;
      const row = state.replays.get(this.replayKey(workspaceId, operation, key));
      const matches = row && row.lease_owner === leaseOwner && row.fencing_token === fence
        && row.request_hash === requestHash && row.state === "pending";
      if (!matches) return [{ affectedRows: 0 }, []];
      Object.assign(row, { state: "completed", response_json: response, response_status: status, response_headers_json: headers,
        lease_owner: null, lease_expires_at: null, updated_at: updatedAt, completed_at: completedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_replays")) {
      const [workspaceId, operation, key, leaseOwner, fence] = values;
      const replayKey = this.replayKey(workspaceId, operation, key);
      const row = state.replays.get(replayKey);
      if (!row || row.lease_owner !== leaseOwner || row.fencing_token !== fence || row.state !== "pending") {
        return [{ affectedRows: 0 }, []];
      }
      state.replays.delete(replayKey);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO acquisition_social_account_sessions")) {
      const [id, workspaceId, upstreamId, expiresAt, createdAt] = values;
      state.sessions.set(`${workspaceId}\u0000${id}`, { id, workspace_id: workspaceId, upstream_id: upstreamId, expires_at: expiresAt, created_at: createdAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_sessions")) {
      return [[state.sessions.get(`${values[0]}\u0000${values[1]}`)].filter(Boolean), []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_sessions")) {
      for (const [key, row] of state.sessions) if (String(row.expires_at) <= String(values[0])) state.sessions.delete(key);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_accounts")) {
      const row = state.accounts.get(`${values[0]}\u0000${values[1]}`);
      return [[row ? structuredClone(row) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET state='disconnected'")) {
      const [revision, etag, updatedAt, workspaceId, id, expectedEtag] = values;
      const key = `${workspaceId}\u0000${id}`;
      const row = state.accounts.get(key);
      if (!row || row.etag !== expectedEtag) return [{ affectedRows: 0 }, []];
      Object.assign(row, { state: "disconnected", account_handle: null, upstream_session_id: null,
        login_state_version: null, revision, etag, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected fake SQL: ${normalized}`);
  }

  async execute(sql: string, values: unknown[] = []) {
    const release = await this.acquireTransaction();
    try {
      return await this.run(this.state, sql, values);
    } finally {
      release();
    }
  }

  async getConnection() {
    let transaction: FakeState | null = null;
    let releaseTransaction: (() => void) | null = null;
    const finish = () => {
      releaseTransaction?.();
      releaseTransaction = null;
      transaction = null;
    };
    return {
      beginTransaction: async () => {
        if (transaction) throw new Error("fake_transaction_already_started");
        releaseTransaction = await this.acquireTransaction();
        transaction = this.clone();
      },
      execute: (sql: string, values: unknown[] = []) => {
        if (!transaction) throw new Error("fake_transaction_not_started");
        return this.run(transaction, sql, values);
      },
      commit: async () => {
        if (!transaction) throw new Error("fake_transaction_not_started");
        this.state = transaction;
        finish();
      },
      rollback: async () => { finish(); },
      release: () => { finish(); }
    };
  }
}

function gateway(counter: { creates: number; disconnects: number }) {
  return {
    async createLoginSession() { counter.creates += 1; return { sessionId: `upstream-${counter.creates}`, state: "awaiting_scan" as const, qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:10:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async getLoginSession() { throw new Error("not used"); },
    async disconnectLoginSession() { counter.disconnects += 1; }
  };
}

function replayReservation(overrides: Partial<{
  workspaceId: string;
  operation: string;
  key: string;
  requestHash: string;
  attemptedAt: string;
  leaseOwner: string;
  leaseDurationMs: number;
  replayExpiresAt: string;
}> = {}) {
  return {
    workspaceId: "w",
    operation: "create_douyin_login_session",
    key: "key",
    requestHash: "hash",
    attemptedAt: "2026-08-24T00:00:00.000Z",
    leaseOwner: "owner",
    leaseDurationMs: 100,
    replayExpiresAt: "2026-08-24T00:01:00.000Z",
    ...overrides
  };
}

test("stateful fake MySQL isolates replay keys and gives one concurrent claimant the lease", async () => {
  const repository = new MysqlAcquisitionSocialAccountRepository(new StatefulSocialMysqlPool() as never);

  const claims = await Promise.all([
    repository.claimReplay(replayReservation({ leaseOwner: "winner-a" })),
    repository.claimReplay(replayReservation({ leaseOwner: "winner-b" }))
  ]);

  assert.deepEqual(claims.map((claim) => claim.kind).sort(), ["claimed", "pending"]);
  assert.equal((await repository.claimReplay(replayReservation({ key: "other-key", leaseOwner: "other-key-owner" }))).kind, "claimed");
  assert.equal((await repository.claimReplay(replayReservation({ workspaceId: "other-workspace", leaseOwner: "other-workspace-owner" }))).kind, "claimed");
});

test("stateful fake MySQL rejects a stale replay fence and deletes only the fenced row", async () => {
  const repository = new MysqlAcquisitionSocialAccountRepository(new StatefulSocialMysqlPool() as never);
  const original = await repository.claimReplay(replayReservation({ leaseOwner: "original" }));
  assert.equal(original.kind, "claimed");
  if (original.kind !== "claimed") throw new Error("original claim missing");
  assert.equal((await repository.claimReplay(replayReservation({
    key: "unrelated", leaseOwner: "unrelated", leaseDurationMs: 1_000
  }))).kind, "claimed");

  const replacement = await repository.claimReplay(replayReservation({
    attemptedAt: "2026-08-24T00:00:00.101Z",
    leaseOwner: "replacement"
  }));
  assert.equal(replacement.kind, "claimed");
  if (replacement.kind !== "claimed") throw new Error("replacement claim missing");
  assert.equal(replacement.fencingToken, original.fencingToken + 1);

  await assert.rejects(repository.completeReplay(original, {
    requestHash: "hash", response: { stale: true }, status: 200, headers: {},
    completedAt: "2026-08-24T00:00:00.101Z"
  }), /stale_social_account_replay_fence/u);
  await assert.rejects(repository.releaseReplay(original), /stale_social_account_replay_fence/u);
  assert.equal((await repository.claimReplay(replayReservation({
    attemptedAt: "2026-08-24T00:00:00.102Z",
    leaseOwner: "observer"
  }))).kind, "pending");

  await repository.releaseReplay(replacement);
  assert.equal((await repository.claimReplay(replayReservation({
    attemptedAt: "2026-08-24T00:00:00.102Z",
    leaseOwner: "fresh"
  }))).kind, "claimed");
  assert.equal((await repository.claimReplay(replayReservation({
    key: "unrelated",
    attemptedAt: "2026-08-24T00:00:00.102Z",
    leaseOwner: "unrelated-observer"
  }))).kind, "pending");
});

test("stateful fake MySQL preserves replay across restart, reclaims expiry, and really rolls back", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  let now = "2026-08-24T00:00:00.000Z";
  const service = () => new AcquisitionSocialAccountService({ repository: new MysqlAcquisitionSocialAccountRepository(pool as never), gateway: gateway(counter),
    idFactory: () => `local-${counter.creates}`, now: () => now, replayLeaseMs: 100, replayTtlMs: 1_000, pendingPollMs: 1 });
  const first = await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "key", "hash");
  const restarted = await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "key", "hash");
  assert.equal(first.replayed, false);
  assert.equal(restarted.replayed, true);
  assert.equal(counter.creates, 1);

  now = "2026-08-24T00:00:02.000Z";
  const expired = await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "key", "hash");
  assert.equal(expired.replayed, false);
  assert.equal(counter.creates, 2);

  now = "2026-08-24T00:00:04.000Z";
  const rollbackPool = new StatefulSocialMysqlPool();
  const rollbackService = () => new AcquisitionSocialAccountService({ repository: new MysqlAcquisitionSocialAccountRepository(rollbackPool as never), gateway: gateway(counter),
    idFactory: () => `local-${counter.creates}`, now: () => now, replayLeaseMs: 100, replayTtlMs: 1_000, pendingPollMs: 1 });
  rollbackPool.failNextCompletion = true;
  await assert.rejects(rollbackService().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "rollback", "hash"), /stale_social_account_replay_fence/u);
  assert.equal(rollbackPool.state.sessions.has("w\u0000local-3"), false);
  assert.equal(rollbackPool.state.replays.size, 0);
  const recovered = await rollbackService().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "rollback", "hash");
  assert.equal(recovered.replayed, false);
  assert.equal(counter.disconnects, 1);
});

test("stateful fake MySQL atomically rolls back account disconnect and replay completion", async () => {
  const pool = new StatefulSocialMysqlPool();
  const repository = new MysqlAcquisitionSocialAccountRepository(pool as never);
  const now = "2026-08-24T00:00:00.000Z";
  pool.state.accounts.set("w\u0000account", { id: "account", workspace_id: "w", platform: "douyin",
    account_handle: "private", upstream_session_id: "upstream", display_name: "Douyin", state: "active",
    login_state_version: 1, revision: 1, etag: '"account-v1"', last_validated_at: now, created_at: now, updated_at: now });
  const fence = await repository.claimReplay({ workspaceId: "w", operation: "disconnect_douyin_social_account", key: "delete",
    requestHash: "delete-hash", attemptedAt: now, leaseOwner: "owner", leaseDurationMs: 100,
    replayExpiresAt: "2026-08-24T00:01:00.000Z" });
  assert.equal(fence.kind, "claimed");
  if (fence.kind !== "claimed") throw new Error("claim missing");
  const completion = { requestHash: "delete-hash", response: { state: "disconnected" }, status: 200,
    headers: { "Idempotency-Replayed": "true" }, completedAt: now };
  pool.failNextCompletion = true;
  await assert.rejects(repository.disconnectAndCompleteReplay("w", "account", '"account-v1"', now, fence, completion),
    /stale_social_account_replay_fence/u);
  assert.equal(pool.state.accounts.get("w\u0000account")?.state, "active");
  assert.equal([...pool.state.replays.values()][0]?.state, "pending");

  const disconnected = await repository.disconnectAndCompleteReplay("w", "account", '"account-v1"', now, fence, completion);
  assert.equal(disconnected?.state, "disconnected");
  assert.equal(pool.state.accounts.get("w\u0000account")?.state, "disconnected");
  assert.equal([...pool.state.replays.values()][0]?.state, "completed");
});

test("live MySQL restart, replay expiry, reclaim, and transaction rollback", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly" : false
}, async () => {
  const adminUrl = new URL(process.env.MYSQL_TEST_ADMIN_URL!);
  const databaseName = `goodjob_social_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection(adminUrl.toString());
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool(databaseUrl.toString());
  try {
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    const repository = () => new MysqlAcquisitionSocialAccountRepository(pool);
    const counter = { creates: 0, disconnects: 0 };
    let now = "2026-08-24T00:00:00.000Z";
    const service = () => new AcquisitionSocialAccountService({ repository: repository(), gateway: gateway(counter), idFactory: () => `live-${counter.creates}`,
      now: () => now, replayLeaseMs: 100, replayTtlMs: 1_000, pendingPollMs: 1 });
    await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "restart", "hash");
    assert.equal((await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "restart", "hash")).replayed, true);
    now = "2026-08-24T00:00:02.000Z";
    assert.equal((await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "restart", "hash")).replayed, false);

    const crash = await repository().claimReplay({ workspaceId: "w", operation: "create_douyin_login_session", key: "crash", requestHash: "hash", attemptedAt: now, leaseOwner: "dead", leaseDurationMs: 100, replayExpiresAt: "2026-08-24T00:01:00.000Z" });
    assert.equal(crash.kind, "claimed");
    now = "2026-08-24T00:00:02.101Z";
    assert.equal((await service().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "crash", "hash")).replayed, false);

    now = "2026-08-24T00:00:03.000Z";
    const fence = await repository().claimReplay({ workspaceId: "w", operation: "rollback", key: "rollback", requestHash: "good", attemptedAt: now, leaseOwner: "owner", leaseDurationMs: 100, replayExpiresAt: "2026-08-24T00:01:00.000Z" });
    assert.equal(fence.kind, "claimed");
    if (fence.kind !== "claimed") throw new Error("live claim missing");
    await assert.rejects(repository().saveLoginSessionAndCompleteReplay({ id: "rolled-back", workspaceId: "w", upstreamId: "raw", expiresAt: "2026-08-24T00:10:00.000Z", createdAt: now }, fence,
      { requestHash: "wrong", response: {}, status: 200, headers: {}, completedAt: now }), /stale_social_account_replay_fence/u);
    assert.equal(await repository().findLoginSession("w", "rolled-back"), null);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${databaseName}\``);
    await admin.end();
  }
});
