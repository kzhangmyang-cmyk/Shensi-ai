import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import {
  acquisitionSocialAccountLoginOpeningsDdl,
  acquisitionSocialAccountReplaysDdl,
  acquisitionSocialAccountSessionsDdl,
  acquisitionSocialAccountsDdl,
  ensureAcquisitionSocialAccountsMysqlSchema,
  MysqlAcquisitionSocialAccountRepository
} from "./acquisition-social-account-mysql-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { MysqlDesktopInstallationRepository } from
  "./acquisition-desktop-installation-mysql-repository.js";

test("repository rejects raw cookie and profile fields and retains a restart-readable safe record", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await assert.rejects(repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, loginStateVersionHighWater: 1,
    revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", cookies: "nope" } as never));
  await repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, loginStateVersionHighWater: 1,
    revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  const stored = await repository.findByWorkspaceAndPlatform("w", "douyin");
  assert.equal(stored?.accountHandle, "h");
  assert.equal((stored as Record<string, unknown>).cookies, undefined);
});

test("desktop executor MySQL binding locks installation account and cross-target actions before one fenced write", async () => {
  const calls: string[] = [];
  const accountRow: Record<string, unknown> = { id: "account", workspace_id: "w",
    platform: "douyin", account_handle: `dyacct_${"d".repeat(64)}`,
    upstream_session_id: null, display_name: "Douyin", state: "active",
    login_state_version: 7, login_state_version_high_water: 7,
    executor_mode: null, executor_device_id_hash: null,
    executor_binding_generation: 0, executor_lease_expires_at: null, revision: 1,
    etag: '"account-v1"', last_validated_at: "2026-09-04T00:00:00.000Z",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z" };
  let replayRow: Record<string, unknown> | null = null;
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("FROM acquisition_desktop_installations")) {
        calls.push("lock-installation");
        return [[{ workspace_id: "w", user_id: "u", team_id: "t",
          device_id_hash: `sha256:${"a".repeat(64)}`,
          device_credential_hash: `sha256:${"c".repeat(64)}`,
          protocol_version: 1, state: "active", created_at: "2026-09-04 00:00:00.000",
          updated_at: "2026-09-04 00:00:00.000", revoked_at: null }], []] as never;
      }
      if (normalized.includes("FROM acquisition_social_accounts")) {
        calls.push("lock-account");
        return [[accountRow], []] as never;
      }
      if (normalized.includes("FROM acquisition_outreach_actions")) {
        calls.push("lock-actions");
        assert.match(normalized,
          /status IN \('claimed','executing','reconciliation_required'\)/u);
        assert.doesNotMatch(normalized, /executionTarget|execution_target/u);
        return [[], []] as never;
      }
      if (normalized.startsWith("SELECT request_hash")) {
        calls.push("lock-replay"); return [[replayRow].filter(Boolean), []] as never;
      }
      if (normalized.startsWith("UPDATE acquisition_social_accounts")) {
        calls.push("write-binding");
        Object.assign(accountRow, { executor_mode: "desktop",
          executor_device_id_hash: `sha256:${"a".repeat(64)}`,
          executor_binding_generation: 1,
          executor_lease_expires_at: "2026-09-04T00:01:40.000Z", revision: 2,
          etag: '"account-v2"', updated_at: "2026-09-04T00:00:10.000Z" });
        return [{ affectedRows: 1 }, []] as never;
      }
      if (normalized.startsWith("INSERT INTO acquisition_social_account_replays")) {
        calls.push("write-replay");
        replayRow = { request_hash: "f".repeat(64),
          response_json: JSON.parse(String(values[3] ?? "{}")) };
        return [{ affectedRows: 1 }, []] as never;
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }
  };
  const repository = new MysqlDesktopInstallationRepository({
    getConnection: async () => connection
  } as never);

  const result = await repository.bindDesktopExecutor({ workspaceId: "w", userId: "u",
    teamId: "t", accountId: "account", accountHandle: `dyacct_${"d".repeat(64)}`,
    loginStateVersion: 7, deviceIdHash: `sha256:${"a".repeat(64)}`,
    expectedGeneration: 0, handoff: false, idempotencyKeyHash: "e".repeat(64),
    requestHash: "f".repeat(64), boundAt: "2026-09-04T00:00:10.000Z",
    leaseExpiresAt: "2026-09-04T00:01:40.000Z" });

  assert.equal(result.kind, "bound");
  assert.deepEqual(calls, ["begin", "lock-installation", "lock-account",
    "lock-actions", "lock-replay", "write-binding", "write-replay", "commit", "release"]);
  calls.length = 0;
  const replay = await new MysqlDesktopInstallationRepository({
    getConnection: async () => connection
  } as never).bindDesktopExecutor({ workspaceId: "w", userId: "u", teamId: "t",
    accountId: "account", accountHandle: `dyacct_${"d".repeat(64)}`,
    loginStateVersion: 7, deviceIdHash: `sha256:${"a".repeat(64)}`,
    expectedGeneration: 0, handoff: false, idempotencyKeyHash: "e".repeat(64),
    requestHash: "f".repeat(64), boundAt: "2026-09-04T00:00:30.000Z",
    leaseExpiresAt: "2026-09-04T00:02:00.000Z" });
  assert.equal(replay.kind, "replay");
  assert.equal(replay.kind === "replay"
    ? replay.account.executorLeaseExpiresAt : null, "2026-09-04T00:01:40.000Z");
  assert.deepEqual(calls, ["begin", "lock-installation", "lock-account",
    "lock-actions", "lock-replay", "commit", "release"]);
});

test("desktop installation MySQL revocation invalidates bound accounts in the same transaction", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.startsWith("SELECT * FROM acquisition_desktop_installations")) {
        calls.push("lock-installation");
        return [[{ workspace_id: "w", user_id: "u", team_id: "t",
          device_id_hash: `sha256:${"a".repeat(64)}`,
          device_credential_hash: `sha256:${"c".repeat(64)}`, protocol_version: 1,
          state: "active", created_at: "2026-09-04 00:00:00.000",
          updated_at: "2026-09-04 00:00:00.000", revoked_at: null }], []] as never;
      }
      if (normalized.startsWith("UPDATE acquisition_desktop_installations")) {
        calls.push("revoke"); return [{ affectedRows: 1 }, []] as never;
      }
      if (normalized.startsWith("UPDATE acquisition_social_accounts")) {
        assert.doesNotMatch(normalized, /executor_mode=NULL/u);
        assert.match(normalized, /executor_mode='desktop'/u);
        assert.match(normalized,
          /executor_binding_generation=executor_binding_generation\+1/u);
        assert.match(normalized, /executor_lease_expires_at=\?/u);
        assert.match(normalized, /revision=revision\+1/u);
        calls.push("invalidate-bindings"); return [{ affectedRows: 1 }, []] as never;
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }
  };
  const repository = new MysqlDesktopInstallationRepository({
    getConnection: async () => connection
  } as never);
  assert.equal(await repository.revoke("w", `sha256:${"a".repeat(64)}`,
    "2026-09-04T00:02:00.000Z"), true);
  assert.deepEqual(calls, ["begin", "lock-installation", "revoke",
    "invalidate-bindings", "commit", "release"]);
});

test("desktop executor MySQL binding rolls back and releases on a stale affected-row fence", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("FROM acquisition_desktop_installations")) return [[{
        workspace_id: "w", user_id: "u", team_id: "t",
        device_id_hash: `sha256:${"a".repeat(64)}`,
        device_credential_hash: `sha256:${"b".repeat(64)}`, protocol_version: 1,
        state: "active", created_at: "2026-09-04 00:00:00.000",
        updated_at: "2026-09-04 00:00:00.000", revoked_at: null }], []] as never;
      if (normalized.includes("FROM acquisition_social_accounts")) return [[{
        id: "account", workspace_id: "w", platform: "douyin",
        account_handle: `dyacct_${"d".repeat(64)}`, upstream_session_id: null,
        display_name: "Douyin", state: "active", login_state_version: 1,
        login_state_version_high_water: 1, executor_mode: null,
        executor_device_id_hash: null, executor_binding_generation: 0,
        executor_lease_expires_at: null, revision: 1, etag: '"account-v1"',
        last_validated_at: null, created_at: "2026-09-04T00:00:00.000Z",
        updated_at: "2026-09-04T00:00:00.000Z" }], []] as never;
      if (normalized.includes("FROM acquisition_outreach_actions")
        || normalized.startsWith("SELECT request_hash")) return [[], []] as never;
      if (normalized.startsWith("UPDATE acquisition_social_accounts")) {
        calls.push("stale-write"); return [{ affectedRows: 0 }, []] as never;
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }
  };
  const repository = new MysqlDesktopInstallationRepository({
    getConnection: async () => connection
  } as never);
  await assert.rejects(repository.bindDesktopExecutor({ workspaceId: "w", userId: "u",
    teamId: "t", accountId: "account", accountHandle: `dyacct_${"d".repeat(64)}`,
    loginStateVersion: 1, deviceIdHash: `sha256:${"a".repeat(64)}`,
    expectedGeneration: 0, handoff: false, idempotencyKeyHash: "e".repeat(64),
    requestHash: "f".repeat(64), boundAt: "2026-09-04T00:00:10.000Z",
    leaseExpiresAt: "2026-09-04T00:01:40.000Z" }),
  /desktop_executor_binding_stale/u);
  assert.deepEqual(calls, ["begin", "stale-write", "rollback", "release"]);
});

test("MySQL bind uses a transaction and rolls back a competing active handle", async () => {
  const calls: string[] = [];
  const currentHandle = `dyacct_${"b".repeat(64)}`;
  const candidateHandle = `dyacct_${"a".repeat(64)}`;
  const connection = {
    async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
    async execute(sql: string) { calls.push(sql.startsWith("SELECT") ? "select" : "write"); return [[{ id: "a", workspace_id: "w", platform: "douyin", account_handle: currentHandle, upstream_session_id: "current-session", display_name: "当前账号", state: "active", login_state_version: 1, login_state_version_high_water: 1, revision: 1, etag: '"account-v1"', last_validated_at: null, created_at: "x", updated_at: "x" }], []] as never; }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({ getConnection: async () => connection } as never);
  const result = await repository.bindActive({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: candidateHandle, upstreamSessionId: "candidate-session", displayName: "新账号", state: "active", loginStateVersion: 2, loginStateVersionHighWater: 2, revision: 2, etag: '"account-v2"', lastValidatedAt: null, createdAt: "x", updatedAt: "x" });
  assert.equal(result, "active_handle_conflict");
  assert.deepEqual(calls, ["begin", "select", "rollback", "release"]);
});

test("MySQL active binding checks the login-session fence in the same transaction", async () => {
  const calls: string[] = [];
  let sessionSelectParameters: unknown[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
    async execute(sql: string, parameters?: unknown[]) {
      calls.push(sql.includes("acquisition_social_account_sessions") ? "session-select" : "unexpected");
      if (sql.includes("acquisition_social_account_sessions")) sessionSelectParameters = parameters ?? [];
      return [[], []] as never;
    }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({ getConnection: async () => connection } as never);
  const result = await repository.bindActiveFromLoginSession("w", "deleted-login", "upstream", {
    id: "a", workspaceId: "w", platform: "douyin", accountHandle: `dyacct_${"a".repeat(64)}`,
    upstreamSessionId: "upstream", displayName: "账号", state: "active", loginStateVersion: 1,
    loginStateVersionHighWater: 1, revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "x", updatedAt: "x"
  });
  assert.equal(result, "login_session_stale");
  assert.deepEqual(calls, ["begin", "session-select", "rollback", "release"]);
  assert.deepEqual(sessionSelectParameters, ["w", "deleted-login", "upstream"]);
});

test("MySQL bind replaces the same handle with a newer global login version", async () => {
  const calls: string[] = [];
  const writes: unknown[][] = [];
  const handle = `dyacct_${"a".repeat(64)}`;
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT")) {
        calls.push("select");
        return [[{ id: "a", workspace_id: "w", platform: "douyin",
          account_handle: handle, upstream_session_id: "old-session",
          display_name: "旧昵称", state: "active", login_state_version: 1,
          login_state_version_high_water: 1,
          revision: 7, etag: '"account-v7"', last_validated_at: null,
          created_at: "x", updated_at: "x" }], []] as never;
      }
      calls.push("write");
      writes.push(values);
      return [{ affectedRows: 1 }, []] as never;
    }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({
    getConnection: async () => connection
  } as never);
  const replacement = { id: "a", workspaceId: "w", platform: "douyin" as const,
    accountHandle: handle, upstreamSessionId: "new-session", displayName: "新昵称",
    state: "active" as const, loginStateVersion: 2, loginStateVersionHighWater: 2,
    revision: 2,
    etag: '"account-v2"', lastValidatedAt: "y", createdAt: "x", updatedAt: "y" };

  const result = await repository.bindActive(replacement);

  assert.notEqual(result, "active_handle_conflict");
  assert.equal(result !== "active_handle_conflict" ? result.id : null, "a");
  assert.equal(result !== "active_handle_conflict" ? result.revision : null, 8);
  assert.equal(result !== "active_handle_conflict" ? result.etag : null, '"account-v8"');
  assert.equal(writes[0]?.includes(8), true);
  assert.equal(writes[0]?.includes('"account-v8"'), true);
  assert.deepEqual(calls, ["begin", "select", "write", "commit", "release"]);
});

test("MySQL login-session bind keeps the latest revoked executor fence under a stale candidate", async () => {
  const deviceA = `sha256:${"a".repeat(64)}`;
  const deviceB = `sha256:${"b".repeat(64)}`;
  const writes: unknown[][] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (sql.includes("acquisition_social_account_sessions")) return [[{ id: "login" }], []] as never;
      if (sql.includes("acquisition_social_account_login_openings")) return [[], []] as never;
      if (sql.startsWith("SELECT * FROM acquisition_social_accounts")) return [[{
        id: "account", workspace_id: "w", platform: "douyin",
        account_handle: `dyacct_${"a".repeat(64)}`, upstream_session_id: null,
        display_name: "Douyin", state: "active", login_state_version: 7,
        login_state_version_high_water: 7, executor_mode: "desktop",
        executor_device_id_hash: deviceB, executor_binding_generation: 5,
        executor_lease_expires_at: "2026-09-04T00:00:05.000Z", revision: 5,
        etag: '"account-v5"', last_validated_at: null,
        created_at: "2026-09-04T00:00:00.000Z",
        updated_at: "2026-09-04T00:00:05.000Z" }], []] as never;
      writes.push(values); return [{ affectedRows: 1 }, []] as never;
    }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({
    getConnection: async () => connection
  } as never);

  const result = await repository.bindActiveFromLoginSession("w", "login", "upstream", {
    id: "stale", workspaceId: "w", platform: "douyin",
    accountHandle: `dyacct_${"a".repeat(64)}`, upstreamSessionId: "upstream",
    displayName: "Douyin", state: "active", loginStateVersion: 8,
    loginStateVersionHighWater: 8, executorMode: "desktop",
    executorDeviceIdHash: deviceA, executorBindingGeneration: 5,
    executorLeaseExpiresAt: "2026-09-04T00:02:00.000Z", revision: 5,
    etag: '"account-v5"', lastValidatedAt: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:10.000Z"
  });

  assert.notEqual(result, "active_handle_conflict");
  assert.notEqual(result, "login_session_stale");
  if (typeof result === "string") throw new Error("unexpected bind result");
  assert.deepEqual({ device: result.executorDeviceIdHash,
    generation: result.executorBindingGeneration,
    lease: result.executorLeaseExpiresAt, revision: result.revision }, {
    device: deviceB, generation: 6,
    lease: "2026-09-04T00:00:05.000Z", revision: 6
  });
  assert.deepEqual(writes[0]?.slice(9, 14), ["desktop", deviceB, 6,
    "2026-09-04T00:00:05.000Z", 6]);
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
  readonly engines = new Map([
    ["acquisition_social_accounts", "MyISAM"],
    ["acquisition_social_account_sessions", "MyISAM"],
    ["acquisition_social_account_login_openings", "MyISAM"],
    ["acquisition_social_account_replays", "MyISAM"]
  ]);
  engineMutations = 0;
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
  readonly sessionColumns = new Map<string, ColumnMetadata>([
    ["id", { columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
    ["workspace_id", { columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
    ["upstream_id", { columnType: "varchar(512)", nullable: "NO", defaultValue: null }],
    ["expires_at", { columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
    ["created_at", { columnType: "varchar(40)", nullable: "NO", defaultValue: null }]
  ]);
  readonly accountRows = [{ login_state_version: 5,
    login_state_version_high_water: 0, executor_binding_generation: 8, executor_binding_generation_high_water: 0 }];
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
  executorIndex: string[] | null = null;
  executorCheck: string | null = null;
  accountDefinitionMutations = 0;

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
    if (normalized.includes("information_schema.TABLES")) {
      return [[{ ENGINE: this.engines.get(String(values[0])) }], []];
    }
    if (normalized.includes("information_schema.COLUMNS")) {
      const source = values[0] === "acquisition_social_accounts"
        ? this.accountColumns
        : values[0] === "acquisition_social_account_sessions"
          ? this.sessionColumns : this.replayColumns;
      return [[...source].map(([name, metadata]) => ({ COLUMN_NAME: name, COLUMN_TYPE: metadata.columnType,
        IS_NULLABLE: metadata.nullable, COLUMN_DEFAULT: metadata.defaultValue })), []];
    }
    if (normalized.includes("information_schema.STATISTICS")) {
      if (normalized.includes("acquisition_social_accounts")) {
        return [this.executorIndex?.map((name, index) => ({
          INDEX_NAME: "acquisition_social_accounts_executor_lookup", COLUMN_NAME: name,
          SEQ_IN_INDEX: index + 1, NON_UNIQUE: 1 })) ?? [], []];
      }
      return [this.expiryIndex?.map((name, index) => ({ INDEX_NAME: "acquisition_social_account_replays_expiry",
        COLUMN_NAME: name, SEQ_IN_INDEX: index + 1, NON_UNIQUE: 1 })) ?? [], []];
    }
    if (normalized.includes("information_schema.TABLE_CONSTRAINTS")) {
      if (normalized.includes("acquisition_social_accounts")) {
        return [this.executorCheck ? [{ CONSTRAINT_NAME:
          "acquisition_social_accounts_executor_binding",
        CHECK_CLAUSE: this.executorCheck }] : [], []];
      }
      return [this.stateCheck ? [{ CONSTRAINT_NAME: "acquisition_social_account_replays_state", CHECK_CLAUSE: this.stateCheck }] : [], []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN upstream_session_id")) {
      this.accountColumns.set("upstream_session_id", { columnType: "varchar(512)", nullable: "YES", defaultValue: null });
      return [{ affectedRows: 0 }, []];
    }
    const engineChange = normalized.match(
      /^ALTER TABLE (acquisition_social_accounts|acquisition_social_account_sessions|acquisition_social_account_login_openings|acquisition_social_account_replays) ENGINE=InnoDB$/u);
    if (engineChange) {
      this.engines.set(engineChange[1], "InnoDB");
      this.engineMutations += 1;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN login_state_version_high_water")) {
      this.accountColumns.set("login_state_version_high_water",
        { columnType: "bigint unsigned", nullable: "NO", defaultValue: "0" });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN executor_mode")) {
      this.accountDefinitionMutations += 1;
      this.accountColumns.set("executor_mode",
        { columnType: "varchar(16)", nullable: "YES", defaultValue: null });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN executor_device_id_hash")) {
      this.accountDefinitionMutations += 1;
      this.accountColumns.set("executor_device_id_hash",
        { columnType: "char(71)", nullable: "YES", defaultValue: null });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN executor_binding_generation_high_water ")) {
      this.accountDefinitionMutations += 1;
      this.accountColumns.set("executor_binding_generation_high_water", { columnType: "bigint unsigned", nullable: "NO", defaultValue: "0" });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET executor_binding_generation_high_water=")) {
      for (const row of this.accountRows) row.executor_binding_generation_high_water = Math.max(row.executor_binding_generation_high_water, row.executor_binding_generation);
      return [{ affectedRows: this.accountRows.length }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN executor_binding_generation")) {
      this.accountDefinitionMutations += 1;
      this.accountColumns.set("executor_binding_generation",
        { columnType: "bigint unsigned", nullable: "NO", defaultValue: "0" });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_accounts ADD COLUMN executor_lease_expires_at")) {
      this.accountDefinitionMutations += 1;
      this.accountColumns.set("executor_lease_expires_at",
        { columnType: "varchar(40)", nullable: "YES", defaultValue: null });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes("ADD INDEX acquisition_social_accounts_executor_lookup")) {
      this.executorIndex = ["workspace_id", "executor_mode", "executor_device_id_hash",
        "executor_lease_expires_at"];
      this.accountDefinitionMutations += 1;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes("ADD CONSTRAINT acquisition_social_accounts_executor_binding")) {
      this.executorCheck = "((executor_mode is null or executor_mode='server') and executor_device_id_hash is null and executor_binding_generation=0 and executor_lease_expires_at is null) or (executor_mode='desktop' and executor_device_id_hash is not null and executor_binding_generation>0 and executor_lease_expires_at is not null)";
      this.accountDefinitionMutations += 1;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("ALTER TABLE acquisition_social_account_sessions ADD COLUMN interaction_surface")) {
      this.sessionColumns.set("interaction_surface",
        { columnType: "varchar(32)", nullable: "NO", defaultValue: "remote_canvas" });
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET login_state_version_high_water=GREATEST")) {
      for (const row of this.accountRows) {
        row.login_state_version_high_water = Math.max(row.login_state_version_high_water,
          row.login_state_version ?? 0);
      }
      return [{ affectedRows: this.accountRows.length }, []];
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
  assert.equal(pool.accountRows[0]?.login_state_version_high_water, 5);
  assert.equal(pool.accountRows[0]?.executor_binding_generation_high_water, 8);
  assert.deepEqual(pool.sessionColumns.get("interaction_surface"), {
    columnType: "varchar(32)", nullable: "NO", defaultValue: "remote_canvas"
  });
  assert.equal("idempotency_key" in pool.rows[0], false);
  assert.deepEqual(pool.executorIndex, ["workspace_id", "executor_mode",
    "executor_device_id_hash", "executor_lease_expires_at"]);
  assert.match(pool.executorCheck ?? "", /executor_mode.*desktop/iu);
  const mutations = pool.accountDefinitionMutations;
  await ensureAcquisitionSocialAccountsMysqlSchema(pool as never);
  assert.equal(pool.accountDefinitionMutations, mutations,
    "a canonical executor schema must be a no-op on the second ensure");
});

test("schema ensure repairs every social-account engine once then becomes a no-op", async () => {
  const pool = new StatefulLegacyReplaySchemaPool();

  await ensureAcquisitionSocialAccountsMysqlSchema(pool as never);
  assert.deepEqual([...pool.engines.values()], ["InnoDB", "InnoDB", "InnoDB", "InnoDB"]);
  assert.equal(pool.engineMutations, 4);

  await ensureAcquisitionSocialAccountsMysqlSchema(pool as never);
  assert.equal(pool.engineMutations, 4);
});

test("schema definitions contain restart-safe replay state and upstream handle metadata", () => {
  assert.match(acquisitionSocialAccountsDdl, /upstream_session_id VARCHAR\(512\) NULL/u);
  assert.match(acquisitionSocialAccountsDdl,
    /login_state_version_high_water BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(acquisitionSocialAccountsDdl,
    /executor_mode VARCHAR\(16\).*NULL/u);
  assert.match(acquisitionSocialAccountsDdl,
    /executor_device_id_hash CHAR\(71\).*NULL/u);
  assert.match(acquisitionSocialAccountsDdl,
    /executor_binding_generation BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(acquisitionSocialAccountsDdl,
    /executor_lease_expires_at VARCHAR\(40\) NULL/u);
  assert.match(acquisitionSocialAccountsDdl,
    /acquisition_social_accounts_executor_lookup\s+\(workspace_id,executor_mode,executor_device_id_hash,executor_lease_expires_at\)/u);
  for (const column of ["state", "response_headers_json", "lease_owner", "lease_expires_at", "fencing_token", "expires_at", "created_at", "updated_at", "completed_at"]) {
    assert.match(acquisitionSocialAccountReplaysDdl, new RegExp(`\\b${column}\\b`, "u"));
  }
  assert.match(acquisitionSocialAccountReplaysDdl, /response_json JSON NULL/u);
  assert.match(acquisitionSocialAccountReplaysDdl, /idempotency_key_hash CHAR\(64\) NOT NULL/u);
  assert.doesNotMatch(acquisitionSocialAccountReplaysDdl, /idempotency_key VARCHAR/u);
  assert.match(acquisitionSocialAccountLoginOpeningsDdl,
    /workspace_id VARCHAR\(255\) NOT NULL PRIMARY KEY/u);
  assert.match(acquisitionSocialAccountLoginOpeningsDdl,
    /session_id VARCHAR\(255\) NULL/u);
  assert.match(acquisitionSocialAccountLoginOpeningsDdl,
    /fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(acquisitionSocialAccountSessionsDdl,
    /interaction_surface VARCHAR\(32\) NOT NULL DEFAULT 'remote_canvas'/u);
});

test("both checked-in schema snapshots match the runtime social-account state", async () => {
  for (const ddl of [acquisitionSocialAccountsDdl, acquisitionSocialAccountSessionsDdl,
    acquisitionSocialAccountLoginOpeningsDdl, acquisitionSocialAccountReplaysDdl]) {
    assert.match(ddl, /\) ENGINE=InnoDB$/u);
  }
  for (const name of ["schema.mysql.sql", "goodjob_crm.full.sql"]) {
    const snapshot = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    const statement = (table: string) => snapshot.match(new RegExp(
      `CREATE TABLE ${table} \\([\\s\\S]*?;`, "u"))?.[0] ?? "";
    const account = statement("acquisition_social_accounts");
    const session = statement("acquisition_social_account_sessions");
    const opening = statement("acquisition_social_account_login_openings");
    const replay = statement("acquisition_social_account_replays");
    assert.match(account, /upstream_session_id VARCHAR\(512\) NULL/u, name);
    assert.match(account,
      /login_state_version_high_water BIGINT UNSIGNED NOT NULL DEFAULT 0/u, name);
    for (const column of ["executor_mode", "executor_device_id_hash",
      "executor_binding_generation", "executor_lease_expires_at",
      "acquisition_social_accounts_executor_lookup"]) {
      assert.match(account, new RegExp(`\\b${column}\\b`, "u"), `${name}: ${column}`);
    }
    assert.match(account, /\) ENGINE=InnoDB;$/u, `${name}: engine`);
    for (const column of ["idempotency_key_hash", "state", "response_json JSON NULL", "response_headers_json", "lease_owner", "lease_expires_at", "fencing_token", "expires_at", "created_at", "updated_at", "completed_at"]) {
      assert.match(replay, new RegExp(column.replaceAll(" ", "\\s+"), "u"), `${name}: ${column}`);
    }
    assert.match(opening, /workspace_id VARCHAR\(255\) NOT NULL PRIMARY KEY/u, name);
    assert.match(opening, /session_id VARCHAR\(255\) NULL/u, name);
    assert.match(opening,
      /fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0/u, name);
    assert.match(session,
      /interaction_surface VARCHAR\(32\) NOT NULL DEFAULT 'remote_canvas'/u, name);
    for (const [table, definition] of [["accounts", account], ["sessions", session],
      ["login openings", opening], ["replays", replay]] as const) {
      assert.match(definition, /\) ENGINE=InnoDB;$/u, `${name}: ${table} engine`);
    }
  }
});

type ReplayRow = Record<string, unknown>;
type FakeState = {
  replays: Map<string, ReplayRow>;
  sessions: Map<string, Record<string, unknown>>;
  loginOpenings: Map<string, Record<string, unknown>>;
  accounts: Map<string, Record<string, unknown>>;
};

class StatefulSocialMysqlPool {
  state: FakeState = { replays: new Map(), sessions: new Map(),
    loginOpenings: new Map(), accounts: new Map() };
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
    if (normalized.startsWith("INSERT IGNORE INTO acquisition_social_account_login_openings")) {
      const [workspaceId, leaseOwner, leaseExpiresAt, updatedAt] = values;
      const key = String(workspaceId);
      if (state.loginOpenings.has(key)) return [{ affectedRows: 0 }, []];
      state.loginOpenings.set(key, { workspace_id: workspaceId, session_id: null,
        lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
        fencing_token: 1, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT opening.*")
      && normalized.includes("FROM acquisition_social_account_login_openings")) {
      const opening = state.loginOpenings.get(String(values[0]));
      if (!opening) return [[], []];
      const session = opening.session_id == null
        ? undefined
        : state.sessions.get(`${String(opening.workspace_id)}\u0000${String(opening.session_id)}`);
      return [[structuredClone({ ...opening,
        session_record_id: session?.id,
        session_workspace_id: session?.workspace_id,
        session_upstream_id: session?.upstream_id,
        session_interaction_surface: session?.interaction_surface,
        session_expires_at: session?.expires_at,
        session_created_at: session?.created_at
      })], []];
    }
    if (normalized.startsWith("SELECT workspace_id FROM acquisition_social_account_login_openings")) {
      const opening = state.loginOpenings.get(String(values[0]));
      return [[opening ? structuredClone(opening) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_login_openings")) {
      const opening = state.loginOpenings.get(String(values[0]));
      return [[opening ? structuredClone(opening) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("INSERT INTO acquisition_social_account_login_openings")) {
      if (normalized.includes("VALUES (?,NULL")) {
        const [workspaceId, leaseOwner, leaseExpiresAt, updatedAt] = values;
        state.loginOpenings.set(String(workspaceId), { workspace_id: workspaceId,
          session_id: null, lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt,
          fencing_token: 1, updated_at: updatedAt });
        return [{ affectedRows: 1 }, []];
      }
      const [workspaceId, sessionId, updatedAt] = values;
      state.loginOpenings.set(String(workspaceId), { workspace_id: workspaceId,
        session_id: sessionId, lease_owner: null, lease_expires_at: null,
        fencing_token: 1, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_login_openings")
      && normalized.includes("SET session_id=NULL")) {
      const [leaseOwner, leaseExpiresAt, updatedAt, workspaceId] = values;
      const fence = values.at(-1);
      const opening = state.loginOpenings.get(String(workspaceId));
      if (!opening || opening.fencing_token !== fence) return [{ affectedRows: 0 }, []];
      Object.assign(opening, { session_id: null, lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt,
        fencing_token: Number(opening.fencing_token) + 1,
        updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_account_login_openings")
      && normalized.includes("SET session_id=?")) {
      const [sessionId, updatedAt, workspaceId, leaseOwner, fence] = values;
      const opening = state.loginOpenings.get(String(workspaceId));
      const matches = opening && opening.session_id == null
        && opening.lease_owner === leaseOwner && opening.fencing_token === fence;
      if (!matches) return [{ affectedRows: 0 }, []];
      Object.assign(opening, { session_id: sessionId, lease_owner: null,
        lease_expires_at: null, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_login_openings")) {
      const [workspaceId, second, fence] = values;
      const key = String(workspaceId);
      const opening = state.loginOpenings.get(key);
      const matches = normalized.includes("session_id IS NULL")
        ? opening?.session_id == null && opening?.lease_owner === second
          && opening?.fencing_token === fence
        : opening?.session_id === second;
      if (!matches) return [{ affectedRows: 0 }, []];
      state.loginOpenings.delete(key);
      return [{ affectedRows: 1 }, []];
    }
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
      const [id, workspaceId, upstreamId, interactionSurface, expiresAt, createdAt] = values;
      state.sessions.set(`${workspaceId}\u0000${id}`, { id, workspace_id: workspaceId,
        upstream_id: upstreamId, interaction_surface: interactionSurface,
        expires_at: expiresAt, created_at: createdAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_account_sessions")) {
      return [[state.sessions.get(`${values[0]}\u0000${values[1]}`)].filter(Boolean), []];
    }
    if (normalized.startsWith("SELECT id FROM acquisition_social_account_sessions")) {
      return [[state.sessions.get(`${values[0]}\u0000${values[1]}`)].filter(Boolean), []];
    }
    if (normalized.startsWith("DELETE FROM acquisition_social_account_sessions")) {
      if (normalized.includes("WHERE workspace_id=? AND id=?")) {
        const deleted = state.sessions.delete(`${values[0]}\u0000${values[1]}`);
        return [{ affectedRows: deleted ? 1 : 0 }, []];
      }
      for (const [key, row] of state.sessions) if (String(row.expires_at) <= String(values[0])) state.sessions.delete(key);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT * FROM acquisition_social_accounts")) {
      const row = [...state.accounts.values()].find((candidate) =>
        candidate.workspace_id === values[0]
        && (candidate.id === values[1] || candidate.platform === values[1]));
      return [[row ? structuredClone(row) : undefined].filter(Boolean), []];
    }
    if (normalized.startsWith("INSERT INTO acquisition_social_accounts")) {
      const [id, workspaceId, platform, accountHandle, upstreamSessionId,
        displayName, accountState, loginStateVersion, highWater, executorMode,
        executorDeviceIdHash, executorBindingGeneration, executorLeaseExpiresAt,
        revision, etag,
        lastValidatedAt, createdAt, updatedAt, bindingHighWater] = values;
      const existingEntry = [...state.accounts].find(([, candidate]) =>
        candidate.workspace_id === workspaceId && candidate.platform === platform);
      const next = { id, workspace_id: workspaceId, platform,
        account_handle: accountHandle, upstream_session_id: upstreamSessionId,
        display_name: displayName, state: accountState,
        login_state_version: loginStateVersion,
        login_state_version_high_water: Math.max(
          Number(existingEntry?.[1].login_state_version_high_water ?? 0),
          Number(highWater ?? 0)
        ),
        executor_mode: executorMode, executor_device_id_hash: executorDeviceIdHash,
        executor_binding_generation: executorBindingGeneration,
        executor_binding_generation_high_water: Math.max(Number(bindingHighWater ?? 0), Number(existingEntry?.[1].executor_binding_generation_high_water ?? 0), Number(existingEntry?.[1].executor_binding_generation ?? 0)),
        executor_lease_expires_at: executorLeaseExpiresAt,
        revision, etag, last_validated_at: lastValidatedAt,
        created_at: existingEntry?.[1].created_at ?? createdAt, updated_at: updatedAt };
      if (existingEntry) state.accounts.delete(existingEntry[0]);
      state.accounts.set(`${workspaceId}\u0000${id}`, next);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET state='risk_paused'")) {
      const [revision, etag, updatedAt, workspaceId, id, accountHandle,
        loginStateVersion, expectedRevision, expectedEtag] = values;
      const key = `${workspaceId}\u0000${id}`;
      const row = state.accounts.get(key);
      if (!row || row.state !== "active" || row.account_handle !== accountHandle
        || row.login_state_version !== loginStateVersion
        || row.revision !== expectedRevision || row.etag !== expectedEtag) {
        return [{ affectedRows: 0 }, []];
      }
      Object.assign(row, { state: "risk_paused", revision, etag, updated_at: updatedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE acquisition_social_accounts SET ") && normalized.includes("state='disconnected'")) {
      const [revision, etag, updatedAt, workspaceId, id, expectedEtag] = values;
      const key = `${workspaceId}\u0000${id}`;
      const row = state.accounts.get(key);
      if (!row || row.etag !== expectedEtag) return [{ affectedRows: 0 }, []];
      Object.assign(row, { state: "disconnected", account_handle: null, upstream_session_id: null,
        executor_binding_generation_high_water: Math.max(Number(row.executor_binding_generation_high_water ?? 0), Number(row.executor_binding_generation ?? 0)),
        login_state_version: null, executor_mode: null, executor_device_id_hash: null,
        executor_binding_generation: 0, executor_lease_expires_at: null,
        revision, etag, updated_at: updatedAt });
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
    async createLoginSession() { counter.creates += 1; return { sessionId: `upstream-${counter.creates}`, state: "awaiting_scan" as const, qrImageDataUrl: "data:image/png;base64,cXI=", qrStatus: "ready" as const, loginPage: null, expiresAt: "2026-08-24T00:10:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async interactLoginSession(sessionId: string) { return { sessionId, state: "awaiting_scan" as const, qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null, expiresAt: "2026-08-24T00:10:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
    async getLoginSession(sessionId: string) { return { sessionId, state: "awaiting_scan" as const, qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null, expiresAt: "2026-08-24T00:10:00.000Z", accountHandle: null, accountDisplayName: null, loginStateVersion: null }; },
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

function socialAccountRow(overrides: Record<string, unknown> = {}) {
  const now = "2026-08-24T00:00:00.000Z";
  return { id: "account", workspace_id: "w", platform: "douyin",
    account_handle: `dyacct_${"a".repeat(64)}`, upstream_session_id: "session-v1",
    display_name: "Douyin", state: "active", login_state_version: 1,
    login_state_version_high_water: 1, revision: 1, etag: '"account-v1"',
    last_validated_at: now, created_at: now, updated_at: now, ...overrides };
}

function socialAccountCandidate(version: number) {
  const now = `2026-08-24T00:00:0${version}.000Z`;
  return { id: `stale-${version}`, workspaceId: "w", platform: "douyin" as const,
    accountHandle: `dyacct_${"a".repeat(64)}`, upstreamSessionId: `session-v${version}`,
    displayName: "Douyin", state: "active" as const, loginStateVersion: version,
    loginStateVersionHighWater: version, revision: 2, etag: '"account-v2"',
    lastValidatedAt: now, createdAt: now, updatedAt: now };
}

test("stateful fake MySQL serializes newer binds and rejects a stale disconnect ETag", async () => {
  const pool = new StatefulSocialMysqlPool();
  pool.state.accounts.set("w\u0000account", socialAccountRow());
  const repository = new MysqlAcquisitionSocialAccountRepository(pool as never);

  const [second, third] = await Promise.all([
    repository.bindActive(socialAccountCandidate(2)),
    repository.bindActive(socialAccountCandidate(3))
  ]);
  const stored = await repository.findById("w", "account");

  assert.notEqual(second, "active_handle_conflict");
  assert.notEqual(third, "active_handle_conflict");
  assert.equal(second !== "active_handle_conflict" ? second.revision : null, 2);
  assert.equal(third !== "active_handle_conflict" ? third.revision : null, 3);
  assert.equal(stored?.id, "account");
  assert.equal(stored?.loginStateVersion, 3);
  assert.equal(stored?.loginStateVersionHighWater, 3);
  assert.equal(stored?.revision, 3);
  assert.equal(stored?.etag, '"account-v3"');
  const staleUpsert = await repository.upsert(socialAccountCandidate(1));
  assert.equal(staleUpsert.loginStateVersion, 3);
  assert.equal(staleUpsert.loginStateVersionHighWater, 3);
  assert.equal((await repository.findById("w", "account"))?.revision, 3);
  assert.equal(await repository.disconnect("w", "account", '"account-v2"',
    "2026-08-24T00:00:04.000Z"), null);
  assert.equal((await repository.findById("w", "account"))?.state, "active");
});

test("stateful fake MySQL replaces an invalid legacy active identity with a newer valid login", async () => {
  const pool = new StatefulSocialMysqlPool();
  pool.state.accounts.set("w\u0000account", socialAccountRow({
    account_handle: "legacy-random-handle", display_name: null,
    login_state_version: 1, login_state_version_high_water: 1,
    revision: 3, etag: '"account-v3"'
  }));
  const repository = new MysqlAcquisitionSocialAccountRepository(pool as never);

  const result = await repository.bindActive(socialAccountCandidate(2));
  const stored = await repository.findById("w", "account");

  assert.notEqual(result, "active_handle_conflict");
  assert.equal(stored?.id, "account");
  assert.equal(stored?.accountHandle, `dyacct_${"a".repeat(64)}`);
  assert.equal(stored?.displayName, "Douyin");
  assert.equal(stored?.loginStateVersion, 2);
  assert.equal(stored?.loginStateVersionHighWater, 2);
  assert.equal(stored?.revision, 4);
});

test("stateful fake MySQL high-water rejects old sessions after disconnect or risk pause", async () => {
  for (const state of ["disconnected", "risk_paused"] as const) {
    const pool = new StatefulSocialMysqlPool();
    pool.state.accounts.set("w\u0000account", socialAccountRow({
      state, account_handle: state === "disconnected" ? null : `dyacct_${"a".repeat(64)}`,
      upstream_session_id: state === "disconnected" ? null : "session-v3",
      login_state_version: state === "disconnected" ? null : 3,
      login_state_version_high_water: 3, revision: 4, etag: '"account-v4"'
    }));
    const repository = new MysqlAcquisitionSocialAccountRepository(pool as never);

    const result = await repository.bindActive(socialAccountCandidate(2));

    assert.notEqual(result, "active_handle_conflict");
    assert.equal(result !== "active_handle_conflict" ? result.state : null, state);
    const stored = await repository.findById("w", "account");
    assert.equal(stored?.state, state);
    assert.equal(stored?.loginStateVersionHighWater, 3);
    assert.equal(stored?.revision, 4);
  }
});

test("stateful fake MySQL pause CAS cannot roll a newer reconnect back", async () => {
  const pool = new StatefulSocialMysqlPool();
  pool.state.accounts.set("w\u0000account", socialAccountRow());
  const repository = new MysqlAcquisitionSocialAccountRepository(pool as never);
  const oldIdentity = { accountHandle: `dyacct_${"a".repeat(64)}`,
    loginStateVersion: 1, revision: 1, etag: '"account-v1"' };
  await repository.bindActive(socialAccountCandidate(2));

  assert.equal(await repository.pauseActiveAccount("w", "account", oldIdentity,
    "2026-08-24T00:00:03.000Z"), null);
  const stored = await repository.findById("w", "account");
  assert.equal(stored?.state, "active");
  assert.equal(stored?.loginStateVersion, 2);
  assert.equal(stored?.revision, 2);

  const pauseFirstPool = new StatefulSocialMysqlPool();
  pauseFirstPool.state.accounts.set("w\u0000account", socialAccountRow());
  const pauseFirst = new MysqlAcquisitionSocialAccountRepository(pauseFirstPool as never);
  const [paused, rebound] = await Promise.all([
    pauseFirst.pauseActiveAccount("w", "account", oldIdentity,
      "2026-08-24T00:00:02.000Z"),
    pauseFirst.bindActive(socialAccountCandidate(2))
  ]);
  assert.equal(paused?.state, "risk_paused");
  assert.notEqual(rebound, "active_handle_conflict");
  const reboundStored = await pauseFirst.findById("w", "account");
  assert.equal(reboundStored?.state, "active");
  assert.equal(reboundStored?.loginStateVersion, 2);
  assert.equal(reboundStored?.revision, 3);
});

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

test("MySQL login sessions preserve the interaction surface across repository restarts", async () => {
  const pool = new StatefulSocialMysqlPool();
  const first = new MysqlAcquisitionSocialAccountRepository(pool as never);
  await first.saveLoginSession({
    id: "desktop-session", workspaceId: "workspace-desktop",
    upstreamId: "upstream-desktop", interactionSurface: "external_window",
    expiresAt: "2026-09-01T00:05:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z"
  });

  const restarted = new MysqlAcquisitionSocialAccountRepository(pool as never);
  assert.equal((await restarted.findLoginSession(
    "workspace-desktop", "desktop-session"
  ))?.interactionSurface, "external_window");

  pool.state.sessions.set("workspace-legacy\u0000legacy-session", {
    id: "legacy-session", workspace_id: "workspace-legacy",
    upstream_id: "upstream-legacy",
    expires_at: "2026-09-01T00:05:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z"
  });
  assert.equal((await restarted.findLoginSession(
    "workspace-legacy", "legacy-session"
  ))?.interactionSurface, "remote_canvas");
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
  assert.equal(counter.creates, 1);

  now = "2026-08-24T00:00:04.000Z";
  const rollbackPool = new StatefulSocialMysqlPool();
  const rollbackService = () => new AcquisitionSocialAccountService({ repository: new MysqlAcquisitionSocialAccountRepository(rollbackPool as never), gateway: gateway(counter),
    idFactory: () => `local-${counter.creates}`, now: () => now, replayLeaseMs: 100, replayTtlMs: 1_000, pendingPollMs: 1 });
  rollbackPool.failNextCompletion = true;
  await assert.rejects(rollbackService().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "rollback", "hash"), /stale_social_account_replay_fence/u);
  assert.equal(rollbackPool.state.sessions.has("w\u0000local-2"), false);
  assert.equal(rollbackPool.state.replays.size, 0);
  assert.equal(rollbackPool.state.loginOpenings.size, 0);
  const recovered = await rollbackService().createLoginSessionIdempotently({ workspaceId: "w" }, { platform: "douyin" }, "rollback", "hash");
  assert.equal(recovered.replayed, false);
  assert.equal(counter.disconnects, 1);
});

test("stateful fake MySQL serializes different login keys by workspace", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const sharedGateway = {
    ...gateway(counter),
    async createLoginSession() {
      counter.creates += 1;
      entered();
      await gate;
      return { sessionId: "mysql-shared-upstream", state: "awaiting_scan" as const,
        qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
        expiresAt: "2026-08-24T00:10:00.000Z", accountHandle: null,
        accountDisplayName: null, loginStateVersion: null };
    }
  };
  const service = (id: string) => new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: sharedGateway,
    idFactory: () => id,
    now: () => "2026-08-24T00:00:00.000Z",
    replayLeaseMs: 1_000,
    pendingPollMs: 1
  });

  const first = service("mysql-public-session").createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" }, "mysql-first-key", "hash"
  );
  await started;
  const second = service("must-not-create").createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" }, "mysql-second-key", "hash"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(counter.creates, 1);
  release();

  const [created, reused] = await Promise.all([first, second]);
  assert.equal(counter.creates, 1);
  assert.equal(reused.view.id, created.view.id);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id,
    "mysql-public-session");
});

test("stateful fake MySQL does not replay a login cancelled during the upstream reuse check", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  let releaseUpstreamCheck!: () => void;
  let upstreamCheckStarted!: () => void;
  const upstreamCheckGate = new Promise<void>((resolve) => {
    releaseUpstreamCheck = resolve;
  });
  const upstreamCheckEntered = new Promise<void>((resolve) => {
    upstreamCheckStarted = resolve;
  });
  const baseGateway = gateway(counter);
  const sharedGateway = {
    ...baseGateway,
    async getLoginSession(sessionId: string) {
      upstreamCheckStarted();
      await upstreamCheckGate;
      return baseGateway.getLoginSession(sessionId);
    }
  };
  let nextId = 0;
  const service = () => new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: sharedGateway,
    idFactory: () => `mysql-cancel-race-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const firstService = service();
  const first = await firstService.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-cancel-race-first", "hash"
  );
  const replacementPromise = service().createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-cancel-race-second", "hash"
  );
  await upstreamCheckEntered;
  await firstService.cancelLoginSession({ workspaceId: "w" }, first.view.id);
  assert.equal(pool.state.loginOpenings.has("w"), false);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), false);
  releaseUpstreamCheck();

  const replacement = await replacementPromise;

  assert.equal(counter.creates, 2);
  assert.notEqual(replacement.view.id, first.view.id);
  assert.equal(replacement.view.id, "mysql-cancel-race-2");
});

test("stateful fake MySQL closes reuse before a remote disconnect finishes", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  const disconnectEntered = new Promise<void>((resolve) => {
    disconnectStarted = resolve;
  });
  const baseGateway = gateway(counter);
  const sharedGateway = {
    ...baseGateway,
    async disconnectLoginSession() {
      counter.disconnects += 1;
      disconnectStarted();
      await disconnectGate;
    }
  };
  let nextId = 0;
  const service = () => new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: sharedGateway,
    idFactory: () => `mysql-begin-cancel-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const cancellingService = service();
  const first = await cancellingService.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-begin-cancel-first", "hash"
  );
  const cancellation = cancellingService.cancelLoginSession(
    { workspaceId: "w" }, first.view.id
  );
  await disconnectEntered;
  assert.equal(pool.state.loginOpenings.has("w"), true);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id, null);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), true);

  const replacementPromise = service().createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-begin-cancel-second", "hash"
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(counter.creates, 1, "create must remain pending behind the cancellation fence");
  releaseDisconnect();
  await cancellation;
  const replacement = await replacementPromise;

  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), false);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id,
    replacement.view.id);
});

test("stateful fake MySQL rejects an in-flight reuse after pre-disconnect cancellation", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  const baseGateway = gateway(counter);
  let releaseReuseGet!: () => void;
  let reuseGetStarted!: () => void;
  const reuseGetGate = new Promise<void>((resolve) => {
    releaseReuseGet = resolve;
  });
  const reuseGetEntered = new Promise<void>((resolve) => {
    reuseGetStarted = resolve;
  });
  let getCalls = 0;
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  const disconnectEntered = new Promise<void>((resolve) => {
    disconnectStarted = resolve;
  });
  const sharedGateway = {
    ...baseGateway,
    async getLoginSession(sessionId: string) {
      getCalls += 1;
      if (getCalls === 1) {
        reuseGetStarted();
        await reuseGetGate;
      }
      return baseGateway.getLoginSession(sessionId);
    },
    async disconnectLoginSession() {
      counter.disconnects += 1;
      disconnectStarted();
      await disconnectGate;
    }
  };
  let nextId = 0;
  const service = () => new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: sharedGateway,
    idFactory: () => `mysql-combined-race-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const cancellingService = service();
  const first = await cancellingService.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-combined-race-first", "hash"
  );
  const replacementPromise = service().createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-combined-race-second", "hash"
  );
  await reuseGetEntered;
  const cancellation = cancellingService.cancelLoginSession(
    { workspaceId: "w" }, first.view.id
  );
  await disconnectEntered;
  assert.equal(pool.state.loginOpenings.get("w")?.session_id, null);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), true);
  releaseReuseGet();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(counter.creates, 1);
  releaseDisconnect();
  await cancellation;
  const replacement = await replacementPromise;
  assert.equal(counter.creates, 2);
  assert.notEqual(replacement.view.id, first.view.id);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id,
    replacement.view.id);

  const reusedReplacement = await service().createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-combined-race-third", "hash"
  );

  assert.equal(counter.creates, 2);
  assert.equal(reusedReplacement.view.id, replacement.view.id);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), false);
  assert.equal(pool.state.sessions.has(
    `w\u0000${replacement.view.id}`
  ), true);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id,
    replacement.view.id);
});

test("stateful fake MySQL restores a failed cancel as the reusable workspace opening", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  const baseGateway = gateway(counter);
  let failDisconnect = true;
  const sharedGateway = {
    ...baseGateway,
    async disconnectLoginSession() {
      counter.disconnects += 1;
      if (failDisconnect) throw new Error("disconnect_failed");
    }
  };
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: sharedGateway,
    idFactory: () => `mysql-cancel-retry-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-cancel-retry-first", "hash"
  );

  await assert.rejects(service.cancelLoginSession(
    { workspaceId: "w" }, first.view.id
  ), /disconnect_failed/u);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), true);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id, first.view.id);

  const replacement = await service.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-cancel-retry-second", "hash"
  );
  assert.equal(counter.creates, 1);
  assert.equal(replacement.view.id, first.view.id);

  failDisconnect = false;
  await service.cancelLoginSession({ workspaceId: "w" }, first.view.id);
  const reusedReplacement = await service.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" },
    "mysql-cancel-retry-third", "hash"
  );

  assert.equal(counter.disconnects, 2);
  assert.equal(counter.creates, 2);
  assert.notEqual(reusedReplacement.view.id, replacement.view.id);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), false);
});

test("stateful fake MySQL releases the workspace opening after login cancellation", async () => {
  const pool = new StatefulSocialMysqlPool();
  const counter = { creates: 0, disconnects: 0 };
  let nextId = 0;
  const service = new AcquisitionSocialAccountService({
    repository: new MysqlAcquisitionSocialAccountRepository(pool as never),
    gateway: gateway(counter),
    idFactory: () => `mysql-cancel-${++nextId}`,
    now: () => "2026-08-24T00:00:00.000Z",
    pendingPollMs: 1
  });
  const first = await service.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" }, "mysql-cancel-first", "hash"
  );

  await service.cancelLoginSession({ workspaceId: "w" }, first.view.id);
  assert.equal(pool.state.loginOpenings.has("w"), false);
  assert.equal(pool.state.sessions.has(`w\u0000${first.view.id}`), false);
  const reconnected = await service.createLoginSessionIdempotently(
    { workspaceId: "w" }, { platform: "douyin" }, "mysql-cancel-second", "hash"
  );

  assert.equal(counter.disconnects, 1);
  assert.equal(counter.creates, 2);
  assert.notEqual(reconnected.view.id, first.view.id);
  assert.equal(pool.state.loginOpenings.get("w")?.session_id,
    reconnected.view.id);
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
    const opening = await repository().claimLoginOpening({
      workspaceId: "w", attemptedAt: now, leaseOwner: "opening-owner",
      leaseDurationMs: 100
    });
    assert.equal(opening.kind, "claimed");
    if (opening.kind !== "claimed") throw new Error("live opening claim missing");
    await assert.rejects(repository().saveLoginSessionAndCompleteReplay({ id: "rolled-back", workspaceId: "w", upstreamId: "raw", expiresAt: "2026-08-24T00:10:00.000Z", createdAt: now }, fence,
      { requestHash: "wrong", response: {}, status: 200, headers: {}, completedAt: now },
    opening), /stale_social_account_replay_fence/u);
    assert.equal(await repository().findLoginSession("w", "rolled-back"), null);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${databaseName}\``);
    await admin.end();
  }
});
