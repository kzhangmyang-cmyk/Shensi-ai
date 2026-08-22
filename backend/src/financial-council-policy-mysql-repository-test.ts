import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import {
  FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialCouncilPolicyRepository,
  ensureFinancialCouncilPolicyMysqlSchema
} from "./financial-council-policy-mysql-repository.js";
import { policyCommand, policyVersion, policyWorkspace } from
  "./financial-council-policy-test-support.js";

type Row = Record<string, unknown>;

class FakePolicyConnection {
  calls: string[] = [];
  versions: Row[] = [];
  heads: Row[] = [];
  commands: Row[] = [];
  async beginTransaction() { this.calls.push("BEGIN"); }
  async commit() { this.calls.push("COMMIT"); }
  async rollback() { this.calls.push("ROLLBACK"); }
  release() { this.calls.push("RELEASE"); }
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (normalized.startsWith("CREATE TABLE")) return [[], []];
    if (normalized.includes("FROM financial_council_policy_commands")) {
      return [[...this.commands.filter((row) => row.workspace_id === values[0]
        && row.actor_id === values[1] && row.key_hash === values[2])], []];
    }
    if (normalized.includes("FROM financial_council_policy_heads")) {
      const head = this.heads.find((row) => row.workspace_id === values[0]);
      if (!head) return [[], []];
      const version = this.versions.find((row) => row.workspace_id === values[0]
        && row.policy_version_id === head.active_policy_version_id);
      return [[version ? { ...version } : { ...head }], []];
    }
    if (normalized.includes("FROM financial_council_policy_versions")) {
      const rows = this.versions.filter((row) => row.workspace_id === values[0]
        && (values.length < 2 || row.policy_version_id === values[1]));
      return [[...rows], []];
    }
    if (normalized.startsWith("INSERT IGNORE INTO financial_council_policy_versions")
      || normalized.startsWith("INSERT INTO financial_council_policy_versions")) {
      if (!this.versions.some((row) => row.workspace_id === values[0]
        && row.policy_version_id === values[1])) {
        this.versions.push({
          workspace_id: values[0], policy_version_id: values[1],
          version: values[2], revision: values[3], currency: values[4],
          policy_json: values[5], policy_hash: values[6], created_at: values[7]
        });
      }
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT IGNORE INTO financial_council_policy_heads")) {
      if (!this.heads.some((row) => row.workspace_id === values[0])) {
        this.heads.push({ workspace_id: values[0],
          active_policy_version_id: values[1], revision: values[2] });
      }
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO financial_council_policy_commands")) {
      this.commands.push({ workspace_id: values[0], actor_id: values[1],
        key_hash: values[2], request_hash: values[3],
        policy_version_id: values[4] });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE financial_council_policy_heads")) {
      const row = this.heads.find((head) => head.workspace_id === values[2]
        && head.revision === values[3]);
      if (!row) return [{ affectedRows: 0 }, []];
      row.active_policy_version_id = values[0]; row.revision = values[1];
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unsupported fake SQL: ${normalized}`);
  }
}

class FakePolicyPool extends FakePolicyConnection {
  connection = new FakePolicyConnection();
  async getConnection() { return this.connection; }
  override async query(sql: string, values: unknown[] = []) {
    if (sql.replace(/\s+/gu, " ").trim().startsWith("CREATE TABLE")) {
      return super.query(sql, values);
    }
    return this.connection.query(sql, values);
  }
}

test("policy MySQL schema is additive, retry-safe and has immutable version keys",
  async () => {
    const pool = new FakePolicyPool();
    await ensureFinancialCouncilPolicyMysqlSchema(pool as never);
    await ensureFinancialCouncilPolicyMysqlSchema(pool as never);
    assert.equal(pool.calls.length,
      FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS.length * 2);
    assert.match(FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS.join("\n"),
      /PRIMARY KEY \(workspace_id, policy_version_id\)/u);
    assert.match(FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS.join("\n"),
      /UNIQUE KEY uq_financial_council_policy_version/u);
  });

test("MySQL policy repository matches default, activation and replay semantics",
  async () => {
    const pool = new FakePolicyPool();
    const repository = new MysqlFinancialCouncilPolicyRepository(pool as never);
    const initial = await repository.getOrCreateActive(
      policyWorkspace(), policyVersion()
    );
    const next = policyVersion("ws-1", 2);
    assert.equal((await repository.createVersion(
      policyCommand(), next
    )).replayed, false);
    assert.equal((await repository.createVersion(
      policyCommand(), policyVersion("ws-1", 2, {
        policyVersionId: "ignored-retry-id"
      })
    )).replayed, true);
    assert.deepEqual(await repository.findActive(policyWorkspace()), next);
    assert.deepEqual(await repository.findVersion(
      policyWorkspace(), initial.policyVersionId
    ), initial);
    assert.equal(
      pool.connection.versions.find((row) =>
        row.policy_version_id === next.policyVersionId)?.created_at,
      "2026-08-16 08:01:00.000"
    );
    assert.equal(pool.connection.calls.includes("COMMIT"), true);
    assert.equal(pool.connection.calls.includes("RELEASE"), true);
  });

test("MySQL policy repository rejects a caller-named default", async () => {
  const repository = new MysqlFinancialCouncilPolicyRepository(
    new FakePolicyPool() as never
  );
  await assert.rejects(repository.getOrCreateActive(
    policyWorkspace(),
    policyVersion("ws-1", 1, { policyVersionId: "caller-default" })
  ), /financial_council_policy_default_invalid/u);
});

test("MySQL policy repository rolls back changed replay and stale CAS", async () => {
  const pool = new FakePolicyPool();
  const repository = new MysqlFinancialCouncilPolicyRepository(pool as never);
  await repository.getOrCreateActive(policyWorkspace(), policyVersion());
  await repository.createVersion(policyCommand(), policyVersion("ws-1", 2));
  await assert.rejects(repository.createVersion(policyCommand({
    requestHash: `sha256:${"e".repeat(64)}`
  }), policyVersion("ws-1", 3)),
  /financial_council_policy_idempotency_conflict/u);
  await assert.rejects(repository.createVersion(policyCommand({
    key: "stale", expectedRevision: 1,
    requestHash: `sha256:${"f".repeat(64)}`
  }), policyVersion("ws-1", 3)),
  /financial_council_policy_revision_conflict/u);
  assert.equal(pool.connection.calls.filter((call) => call === "ROLLBACK").length,
    2);
});

test("live InnoDB policy versions preserve immutable activation parity", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL!;
  const database = `financial_council_policy_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = mysql.createPool(adminUrl);
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  let pool: mysql.Pool | undefined;
  try {
    await admin.query("CREATE DATABASE ?? CHARACTER SET utf8mb4", [database]);
    pool = mysql.createPool(target.toString());
    await ensureFinancialCouncilPolicyMysqlSchema(pool);
    const repository = new MysqlFinancialCouncilPolicyRepository(pool);
    const initial = await repository.getOrCreateActive(
      policyWorkspace(), policyVersion()
    );
    const next = policyVersion("ws-1", 2);
    const created = await repository.createVersion(policyCommand(), next);
    const replay = await repository.createVersion(policyCommand(), next);
    assert.equal(created.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(await repository.findVersion(
      policyWorkspace(), initial.policyVersionId
    ), initial);
    assert.deepEqual(await repository.findActive(policyWorkspace()), next);
  } finally {
    await pool?.end();
    await admin.query("DROP DATABASE IF EXISTS ??", [database]);
    await admin.end();
  }
});
