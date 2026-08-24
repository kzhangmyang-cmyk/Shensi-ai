import assert from "node:assert/strict";
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

test("runtime migration upgrades every legacy account and replay column", async () => {
  const statements: string[] = [];
  const legacy = {
    acquisition_social_accounts: ["id", "workspace_id", "platform", "account_handle", "display_name", "state", "login_state_version", "revision", "etag", "last_validated_at", "created_at", "updated_at"],
    acquisition_social_account_replays: ["workspace_id", "operation_name", "idempotency_key", "request_hash", "response_json", "response_status"]
  } as const;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      if (sql.includes("information_schema.COLUMNS")) {
        const names = legacy[String(values[0]) as keyof typeof legacy] ?? [];
        return [names.map((name) => ({ COLUMN_NAME: name, IS_NULLABLE: name === "response_json" ? "NO" : "YES" })), []];
      }
      return [{ affectedRows: 1 }, []];
    }
  };
  await ensureAcquisitionSocialAccountsMysqlSchema(pool as never);
  const migration = statements.filter((sql) => sql.startsWith("ALTER TABLE")).join("\n");
  assert.match(migration, /ADD COLUMN upstream_session_id/u);
  assert.match(migration, /ADD COLUMN idempotency_key_hash CHAR\(64\) NULL/u);
  assert.match(migration, /DROP COLUMN idempotency_key/u);
  for (const column of ["state", "response_headers_json", "lease_owner", "lease_expires_at", "fencing_token", "expires_at", "created_at", "updated_at", "completed_at"]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}`, "u"));
  }
  assert.match(migration, /MODIFY COLUMN response_json JSON NULL/u);
  assert.match(statements.at(-1) ?? "", /SET state = IF\(response_status = 0/u);
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
  replay: ReplayRow | null;
  sessions: Map<string, Record<string, unknown>>;
  accounts: Map<string, Record<string, unknown>>;
};

class StatefulSocialMysqlPool {
  state: FakeState = { replay: null, sessions: new Map(), accounts: new Map() };
  failNextCompletion = false;

  private clone(): FakeState { return structuredClone(this.state); }

  private async run(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith("INSERT IGNORE INTO acquisition_social_account_replays")) {
      if (this.state.replay) return [{ affectedRows: 0 }, []];
      const [workspaceId, operation, key, requestHash, leaseOwner, leaseExpiresAt, expiresAt, createdAt, updatedAt] = values;
      this.state.replay = { workspace_id: workspaceId, operation_name: operation, idempotency_key_hash: key, request_hash: requestHash,
        state: "pending", response_json: null, response_status: 0, response_headers_json: null, lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt, fencing_token: 1, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, completed_at: null };
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_replays")) {
      const [workspaceId, operation, key] = values;
      const row = this.state.replay;
      return [[row && row.workspace_id === workspaceId && row.operation_name === operation && row.idempotency_key_hash === key ? structuredClone(row) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET request_hash=?")) {
      const row = this.state.replay!;
      const [requestHash, leaseOwner, leaseExpiresAt, expiresAt, createdAt, updatedAt] = values;
      Object.assign(row, { request_hash: requestHash, state: "pending", response_json: null, response_status: 0,
        response_headers_json: null, lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
        fencing_token: Number(row.fencing_token) + 1, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, completed_at: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET lease_owner=?")) {
      const row = this.state.replay!;
      const [leaseOwner, leaseExpiresAt, updatedAt, expiresAt] = values;
      Object.assign(row, { lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
        fencing_token: Number(row.fencing_token) + 1, updated_at: updatedAt, expires_at: expiresAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_replays") && normalized.includes("SET state='completed'")) {
      if (this.failNextCompletion) { this.failNextCompletion = false; return [{ affectedRows: 0 }, []]; }
      const row = this.state.replay!;
      const [response, status, headers, updatedAt, completedAt, workspaceId, operation, key, leaseOwner, fence, requestHash] = values;
      const matches = row && row.workspace_id === workspaceId && row.operation_name === operation && row.idempotency_key_hash === key
        && row.lease_owner === leaseOwner && row.fencing_token === fence && row.request_hash === requestHash && row.state === "pending";
      if (!matches) return [{ affectedRows: 0 }, []];
      Object.assign(row, { state: "completed", response_json: response, response_status: status, response_headers_json: headers,
        lease_owner: null, lease_expires_at: null, updated_at: updatedAt, completed_at: completedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_replays")) {
      this.state.replay = null;
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO acquisition_social_account_sessions")) {
      const [id, workspaceId, upstreamId, expiresAt, createdAt] = values;
      this.state.sessions.set(`${workspaceId}\u0000${id}`, { id, workspace_id: workspaceId, upstream_id: upstreamId, expires_at: expiresAt, created_at: createdAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_sessions")) {
      return [[this.state.sessions.get(`${values[0]}\u0000${values[1]}`)].filter(Boolean), []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_sessions")) {
      for (const [key, row] of this.state.sessions) if (String(row.expires_at) <= String(values[0])) this.state.sessions.delete(key);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_accounts")) {
      const row = this.state.accounts.get(`${values[0]}\u0000${values[1]}`);
      return [[row ? structuredClone(row) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET state='disconnected'")) {
      const [revision, etag, updatedAt, workspaceId, id, expectedEtag] = values;
      const key = `${workspaceId}\u0000${id}`;
      const row = this.state.accounts.get(key);
      if (!row || row.etag !== expectedEtag) return [{ affectedRows: 0 }, []];
      Object.assign(row, { state: "disconnected", account_handle: null, upstream_session_id: null,
        login_state_version: null, revision, etag, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected fake SQL: ${normalized}`);
  }

  execute(sql: string, values: unknown[] = []) { return this.run(sql, values); }
  async getConnection() {
    let snapshot: FakeState | null = null;
    return {
      beginTransaction: async () => { snapshot = this.clone(); },
      execute: (sql: string, values: unknown[] = []) => this.run(sql, values),
      commit: async () => { snapshot = null; },
      rollback: async () => { if (snapshot) this.state = snapshot; snapshot = null; },
      release() {}
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
  assert.equal(rollbackPool.state.replay, null);
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
  assert.equal(pool.state.replay?.state, "pending");

  const disconnected = await repository.disconnectAndCompleteReplay("w", "account", '"account-v1"', now, fence, completion);
  assert.equal(disconnected?.state, "disconnected");
  assert.equal(pool.state.accounts.get("w\u0000account")?.state, "disconnected");
  assert.equal(pool.state.replay?.state, "completed");
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
