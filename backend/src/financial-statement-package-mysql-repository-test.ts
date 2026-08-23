import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_STATEMENT_PACKAGE_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialStatementPackageRepository
} from "./financial-statement-package-mysql-repository.js";

test("mysql schema creates only the three package tables with InnoDB", () => {
  const ddl = FINANCIAL_STATEMENT_PACKAGE_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /financial_statement_package_previews/u);
  assert.match(ddl, /financial_statement_packages/u);
  assert.match(ddl, /financial_statement_package_idempotency/u);
  assert.equal((ddl.match(/CREATE TABLE/gu) ?? []).length, 3);
  assert.equal((ddl.match(/ENGINE=InnoDB/gu) ?? []).length, 3);
  assert.doesNotMatch(ddl, /content_base64|workbook_bytes|raw_cells/iu);
});

test("mysql commit locks preview and uses one transaction", async () => {
  const queries: string[] = [];
  let commits = 0;
  let rollbacks = 0;
  const connection = {
    async beginTransaction() {},
    async commit() { commits += 1; },
    async rollback() { rollbacks += 1; },
    release() {},
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("financial_statement_package_idempotency")) return [[]];
      if (sql.includes("financial_statement_package_previews")) return [[]];
      return [{ affectedRows: 1 }];
    }
  };
  const pool = { async getConnection() { return connection; } };
  const repository = new MysqlFinancialStatementPackageRepository(pool as never);
  await assert.rejects(repository.commitPreview({ workspaceId: "workspace-a",
    previewId: "missing", packageId: "package-1",
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:00:00.000Z" },
    idempotencyKeyHash: `sha256:${"1".repeat(64)}`,
    requestHash: `sha256:${"2".repeat(64)}`,
    createdAt: "2026-08-23T12:00:00.000Z" }));
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.ok(queries.some((sql) => /previews[\s\S]*FOR UPDATE/iu.test(sql)));
});
