import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_STATEMENT_PACKAGE_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialStatementPackageRepository
} from "./financial-statement-package-mysql-repository.js";
import {
  commitFixture,
  forecastRecordFixture,
  previewFixture,
  runFinancialStatementPackageRepositoryContract,
  runFinancialStatementPackageTamperContract
} from "./financial-statement-package-repository-contract-test.js";
import { financialCouncilCanonicalJson } from
  "./financial-council-domain.js";
import type { FinancialStatementPackage } from
  "./financial-statement-package.js";

type PreviewRow = { preview_hash: string; preview_json: string;
  expires_at: string; committed_package_id: string | null };
type PackageRow = { package_hash: string; package_json: string;
  created_at: string };
type IdempotencyRow = { request_hash: string; package_id: string;
  response_json: string };
type FakeState = { previews: Map<string, PreviewRow>;
  packages: Map<string, PackageRow>; idempotency: Map<string, IdempotencyRow> };

function cloneState(state: FakeState): FakeState {
  return { previews: structuredClone(state.previews),
    packages: structuredClone(state.packages),
    idempotency: structuredClone(state.idempotency) };
}

class TransactionalMysqlFake {
  state: FakeState = { previews: new Map(), packages: new Map(),
    idempotency: new Map() };
  failAfterWrite: number | null = null;

  private key(workspaceId: unknown, id: unknown) {
    return `${String(workspaceId)}\0${String(id)}`;
  }

  private execute(state: FakeState, sql: string, values: readonly unknown[] = [],
    wrote?: () => void): unknown {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (/^INSERT INTO financial_statement_package_previews/iu.test(normalized)) {
      state.previews.set(this.key(values[0], values[1]), {
        preview_hash: String(values[2]), preview_json: String(values[3]),
        expires_at: String(values[4]), committed_package_id: null
      });
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT preview_hash, preview_json FROM/iu.test(normalized)) {
      const row = state.previews.get(this.key(values[0], values[1]));
      return [[...(row ? [row] : [])]];
    }
    if (/^SELECT request_hash, package_id, response_json/iu.test(normalized)) {
      const row = state.idempotency.get(this.key(values[0], values[1]));
      return [[...(row ? [row] : [])]];
    }
    if (/^SELECT preview_hash, preview_json, expires_at/iu.test(normalized)) {
      const row = state.previews.get(this.key(values[0], values[1]));
      return [[...(row ? [row] : [])]];
    }
    if (/^SELECT package_hash, package_json FROM/iu.test(normalized)
      && /package_id = \?/iu.test(normalized)) {
      const row = state.packages.get(this.key(values[0], values[1]));
      return [[...(row ? [row] : [])]];
    }
    if (/^SELECT package_hash, package_json FROM/iu.test(normalized)
      && /ORDER BY created_at/iu.test(normalized)) {
      const workspaceId = String(values[0]);
      const rows = [...state.packages.entries()]
        .filter(([key]) => key.startsWith(`${workspaceId}\0`))
        .sort((left, right) => right[1].created_at.localeCompare(left[1].created_at)
          || right[0].localeCompare(left[0]));
      return [[...(rows[0] ? [rows[0][1]] : [])]];
    }
    if (/^INSERT INTO financial_statement_packages /iu.test(normalized)) {
      state.packages.set(this.key(values[0], values[1]), {
        package_hash: String(values[2]), package_json: String(values[3]),
        created_at: String(values[4])
      });
      wrote?.();
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO financial_statement_package_idempotency/iu.test(normalized)) {
      state.idempotency.set(this.key(values[0], values[1]), {
        request_hash: String(values[2]), package_id: String(values[3]),
        response_json: String(values[4])
      });
      wrote?.();
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE financial_statement_package_previews/iu.test(normalized)) {
      const key = this.key(values[1], values[2]);
      const row = state.previews.get(key);
      if (row) state.previews.set(key, { ...row,
        committed_package_id: String(values[0]) });
      wrote?.();
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^DELETE FROM financial_statement_package_previews/iu.test(normalized)) {
      return [{ affectedRows: 0 }];
    }
    throw new Error(`unexpected fake mysql query: ${normalized}`);
  }

  pool() {
    const database = this;
    return {
      async query(sql: string, values: readonly unknown[] = []) {
        return database.execute(database.state, sql, values);
      },
      async getConnection() {
        let transaction: FakeState | null = null;
        let writes = 0;
        return {
          async beginTransaction() { transaction = cloneState(database.state); },
          async query(sql: string, values: readonly unknown[] = []) {
            if (!transaction) throw new Error("transaction required");
            return database.execute(transaction, sql, values, () => {
              writes += 1;
              if (database.failAfterWrite === writes) {
                throw new Error(`injected-after-write-${writes}`);
              }
            });
          },
          async commit() {
            if (!transaction) throw new Error("transaction required");
            database.state = transaction;
            transaction = null;
          },
          async rollback() { transaction = null; },
          release() {}
        };
      }
    };
  }

  tamper(value: FinancialStatementPackage) {
    const key = this.key(value.workspaceId, value.packageId);
    const row = this.state.packages.get(key);
    if (!row) throw new Error("package missing");
    this.state.packages.set(key, { ...row, package_hash: value.packageHash,
      package_json: financialCouncilCanonicalJson(value) });
  }
}

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
    cashForecast: null,
    idempotencyKeyHash: `sha256:${"1".repeat(64)}`,
    requestHash: `sha256:${"2".repeat(64)}`,
    createdAt: "2026-08-23T12:00:00.000Z" }));
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.ok(queries.some((sql) => /previews[\s\S]*FOR UPDATE/iu.test(sql)));
});

test("fake mysql repository matches the shared package contract", async () => {
  await runFinancialStatementPackageRepositoryContract(async () => {
    const database = new TransactionalMysqlFake();
    return new MysqlFinancialStatementPackageRepository(database.pool() as never);
  });
});

test("fake mysql reads reject self-rehashed malformed forecast packages",
  async () => {
  await runFinancialStatementPackageTamperContract(async () => {
    const database = new TransactionalMysqlFake();
    return { repository: new MysqlFinancialStatementPackageRepository(
      database.pool() as never), tamper(value: FinancialStatementPackage) {
      database.tamper(value);
    } };
  });
});

test("mysql rolls back each write boundary and retry creates one package",
  async () => {
  for (const failureStep of [1, 2, 3]) {
    const database = new TransactionalMysqlFake();
    const repository = new MysqlFinancialStatementPackageRepository(
      database.pool() as never);
    await repository.appendPreview(previewFixture());
    database.failAfterWrite = failureStep;
    await assert.rejects(repository.commitPreview(commitFixture({
      packageId: "package-forecast", cashForecast: forecastRecordFixture()
    })), new RegExp(`injected-after-write-${failureStep}`, "u"));
    assert.equal(database.state.packages.size, 0);
    assert.equal(database.state.idempotency.size, 0);
    assert.equal(database.state.previews.get("workspace-a\0preview-1")
      ?.committed_package_id, null);
    database.failAfterWrite = null;
    const retried = await repository.commitPreview(commitFixture({
      packageId: "package-forecast", cashForecast: forecastRecordFixture()
    }));
    assert.equal(retried.value.forecastStatus, "computed");
    assert.equal(database.state.packages.size, 1);
  }
});

test("mysql retries one deadlock so a concurrent exact request can replay",
  async () => {
  const database = new TransactionalMysqlFake();
  const delegate = database.pool();
  let connections = 0;
  let rollbacks = 0;
  const pool = { ...delegate, async getConnection() {
    connections += 1;
    if (connections > 1) return delegate.getConnection();
    return {
      async beginTransaction() {},
      async query() {
        throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
      },
      async commit() {},
      async rollback() { rollbacks += 1; },
      release() {}
    };
  } };
  const repository = new MysqlFinancialStatementPackageRepository(pool as never);
  await repository.appendPreview(previewFixture());
  const committed = await repository.commitPreview(commitFixture({
    packageId: "package-forecast", cashForecast: forecastRecordFixture()
  }));
  assert.equal(committed.replayed, false);
  assert.equal(committed.value.forecastStatus, "computed");
  assert.equal(connections, 2);
  assert.equal(rollbacks, 1);
});
