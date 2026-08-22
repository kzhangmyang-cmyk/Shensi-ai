import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import {
  createFinancialCouncilDraft
} from "./financial-council-draft.js";
import {
  FINANCIAL_COUNCIL_DRAFT_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialCouncilDraftRepository,
  ensureFinancialCouncilDraftMysqlSchema
} from "./financial-council-draft-mysql-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

type Row = Record<string, unknown>;
const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

class FakeConnection {
  rows: Row[] = [];
  calls: string[] = [];
  async beginTransaction() { this.calls.push("BEGIN"); }
  async commit() { this.calls.push("COMMIT"); }
  async rollback() { this.calls.push("ROLLBACK"); }
  release() { this.calls.push("RELEASE"); }
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (normalized.startsWith("CREATE TABLE")) return [[], []];
    if (normalized.startsWith("SELECT")) {
      const column = normalized.includes("dispatch_hash = ?")
        ? "dispatch_hash" : "draft_id";
      return [[...this.rows.filter((row) => row.workspace_id === values[0]
        && row[column] === values[1])], []];
    }
    if (normalized.startsWith("INSERT")) {
      this.rows.push({ workspace_id: values[0], draft_id: values[1],
        dispatch_hash: values[8], content_hash: values[9], draft_json: values[10] });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE")) {
      const row = this.rows.find((item) => item.workspace_id === values[1]
        && item.draft_id === values[2] && item.dispatch_hash === null);
      if (!row) return [{ affectedRows: 0 }, []];
      row.dispatch_hash = values[0];
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unsupported SQL: ${normalized}`);
  }
}

class FakePool extends FakeConnection {
  readonly connection = new FakeConnection();
  async getConnection() { return this.connection; }
  override async query(sql: string, values: unknown[] = []) {
    if (sql.replace(/\s+/gu, " ").trim().startsWith("CREATE TABLE")) {
      return super.query(sql, values);
    }
    return this.connection.query(sql, values);
  }
}

const context: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "workspace-a", kind: "team", actorId: "admin-a", role: "admin",
  teamId: "workspace-a", capabilities: Object.freeze([]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function draft() {
  return createFinancialCouncilDraft({
    workspaceId: "workspace-a", runId: "run-a", portfolioRevision: 2,
    actionId: HASH("a"), actionKind: "prepare_cash_reserve_budget",
    kind: "budget_adjustment_draft", approvalId: "approval-a", approvalHash: HASH("b"),
    portfolioOutputHash: HASH("c"), snapshotHash: HASH("d"), policyHash: HASH("e"),
    approvedAt: "2026-08-22T08:00:00.000Z", createdAt: "2026-08-22T08:00:00.000Z",
    lines: Object.freeze([
      { scenario: "conservative", amountMinor: 120_000 },
      { scenario: "base", amountMinor: 80_000 },
      { scenario: "optimistic", amountMinor: 20_000 }
    ])
  });
}

test("draft MySQL schema is additive and stable", async () => {
  const pool = new FakePool();
  await ensureFinancialCouncilDraftMysqlSchema(pool as never);
  await ensureFinancialCouncilDraftMysqlSchema(pool as never);
  assert.equal(pool.calls.length,
    FINANCIAL_COUNCIL_DRAFT_MYSQL_SCHEMA_STATEMENTS.length * 2);
  assert.match(FINANCIAL_COUNCIL_DRAFT_MYSQL_SCHEMA_STATEMENTS.join("\n"),
    /PRIMARY KEY \(workspace_id, draft_id\)/u);
});

test("draft MySQL repository preserves memory replay and workspace isolation", async () => {
  const pool = new FakePool();
  const repository = new MysqlFinancialCouncilDraftRepository(pool as never);
  const first = await repository.create(draft());
  const replay = await repository.create(draft());

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await repository.findById(context, first.value.draftId))?.draftId,
    first.value.draftId);
  assert.equal(pool.connection.calls.includes("COMMIT"), true);
});

test("draft MySQL repository probes a dispatch before replaying its draft", async () => {
  const pool = new FakePool();
  const repository = new MysqlFinancialCouncilDraftRepository(pool as never);
  const dispatchHash = HASH("9");

  assert.equal(await repository.probeByDispatchHash(context, dispatchHash), null);
  const first = await repository.createFromApprovedDispatch({
    dispatchHash, draft: draft()
  });
  const replay = await repository.createFromApprovedDispatch({
    dispatchHash, draft: draft()
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await repository.probeByDispatchHash(context, dispatchHash), {
    resourceRefs: [{ kind: "financial_council_draft", id: draft().draftId }],
    contentHash: draft().contentHash
  });
});

test("live InnoDB draft repository preserves exact replay parity", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL!;
  const database = `financial_council_draft_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = mysql.createPool(adminUrl);
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  let pool: mysql.Pool | undefined;
  try {
    await admin.query("CREATE DATABASE ?? CHARACTER SET utf8mb4", [database]);
    pool = mysql.createPool(target.toString());
    await ensureFinancialCouncilDraftMysqlSchema(pool);
    const repository = new MysqlFinancialCouncilDraftRepository(pool);
    const first = await repository.create(draft());
    const replay = await repository.create(draft());
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal((await repository.findById(context, first.value.draftId))?.contentHash,
      first.value.contentHash);
  } finally {
    await pool?.end();
    await admin.query("DROP DATABASE IF EXISTS ??", [database]);
    await admin.end();
  }
});
