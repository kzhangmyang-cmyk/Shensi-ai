import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_COUNCIL_MODEL_ROUTING_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialCouncilModelRoutingRepository,
  ensureFinancialCouncilModelRoutingMysqlSchema
} from "./financial-council-model-routing-mysql-repository.js";
import {
  registerFinancialCouncilModelRoutingRepositoryContract,
  routingPolicyVersion,
  routingPutCommand,
  routingWorkspace
} from "./financial-council-model-routing-repository-contract-test.js";

type Row = Record<string, unknown>;

class FakeRoutingConnection {
  calls: string[] = [];
  policies: Row[] = [];
  idempotency: Row[] = [];
  snapshot: { policies: Row[]; idempotency: Row[] } | null = null;
  failInsertPolicy = false;
  failRollback = false;
  destroyed = false;
  async beginTransaction() {
    this.calls.push("BEGIN");
    this.snapshot = { policies: structuredClone(this.policies),
      idempotency: structuredClone(this.idempotency) };
  }
  async commit() { this.calls.push("COMMIT"); this.snapshot = null; }
  async rollback() {
    this.calls.push("ROLLBACK");
    if (this.snapshot) {
      this.policies = this.snapshot.policies;
      this.idempotency = this.snapshot.idempotency;
      this.snapshot = null;
    }
    if (this.failRollback) throw new Error("forced rollback failure");
  }
  release() { this.calls.push("RELEASE"); }
  destroy() { this.destroyed = true; this.calls.push("DESTROY"); }
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (normalized.includes("GET_LOCK")) return [[{ lock_acquired: 1 }], []];
    if (normalized.includes("RELEASE_LOCK")) {
      return [[{ lock_released: 1 }], []];
    }
    if (normalized.startsWith("CREATE TABLE")) return [[], []];
    if (normalized.includes("FROM financial_council_model_routing_idempotency")) {
      return [[...this.idempotency.filter((row) => row.workspace_id === values[0]
        && row.actor_id === values[1] && row.key_hash === values[2])], []];
    }
    if (normalized.includes("FROM financial_council_model_routing_policies")) {
      let rows = this.policies.filter((row) => row.workspace_id === values[0]);
      if (normalized.includes("policy_version_id = ?")) {
        rows = rows.filter((row) => row.policy_version_id === values[1]);
      }
      if (normalized.includes("status = 'active'")) {
        rows = rows.filter((row) => row.status === "active");
      }
      return [[...rows.map((row) => ({ ...row }))], []];
    }
    if (normalized.startsWith("UPDATE financial_council_model_routing_policies")) {
      const row = this.policies.find((item) => item.workspace_id === values[2]
        && item.policy_version_id === values[3] && item.status === "active"
        && item.revision === values[4]);
      if (!row) return [{ affectedRows: 0 }, []];
      row.status = values[0];
      row.policy_json = values[1];
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO financial_council_model_routing_policies")) {
      if (this.failInsertPolicy) throw new Error("forced policy insert failure");
      this.policies.push({ workspace_id: values[0], policy_version_id: values[1],
        revision: values[2], status: values[3], policy_json: values[4],
        policy_hash: values[5], created_by: values[6], created_at: values[7] });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO financial_council_model_routing_idempotency")) {
      this.idempotency.push({ workspace_id: values[0], actor_id: values[1],
        key_hash: values[2], request_hash: values[3], response_json: values[4],
        created_at: values[5] });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unsupported fake SQL: ${normalized}`);
  }
}

class FakeRoutingPool {
  readonly connection = new FakeRoutingConnection();
  async getConnection() { return this.connection; }
  async query(sql: string, values: unknown[] = []) {
    return this.connection.query(sql, values);
  }
}

registerFinancialCouncilModelRoutingRepositoryContract("mysql", () => {
  const pool = new FakeRoutingPool();
  return new MysqlFinancialCouncilModelRoutingRepository(pool as never);
});

test("routing schema uses one named lock and exactly two additive tables", async () => {
  const pool = new FakeRoutingPool();
  await ensureFinancialCouncilModelRoutingMysqlSchema(pool as never);
  assert.equal(FINANCIAL_COUNCIL_MODEL_ROUTING_MYSQL_SCHEMA_STATEMENTS.length, 2);
  const schema = FINANCIAL_COUNCIL_MODEL_ROUTING_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /financial_council_model_routing_policies/u);
  assert.match(schema, /financial_council_model_routing_idempotency/u);
  assert.match(schema, /PRIMARY KEY \(workspace_id, policy_version_id\)/u);
  assert.match(schema, /UNIQUE KEY[^\n]+\(workspace_id, revision\)/u);
  assert.match(schema, /status IN \('active', 'superseded'\)/u);
  assert.equal(pool.connection.calls.some((sql) => sql.includes("GET_LOCK")),
    true);
  assert.equal(pool.connection.calls.some((sql) => sql.includes("RELEASE_LOCK")),
    true);
});

test("routing schema lock failure poisons its owning connection", async () => {
  const pool = new FakeRoutingPool();
  pool.connection.query = async (sql: string) => {
    if (sql.includes("GET_LOCK")) return [[{ lock_acquired: 0 }], []];
    return [[], []];
  };
  await assert.rejects(ensureFinancialCouncilModelRoutingMysqlSchema(
    pool as never), /financial_council_model_routing_schema_lock_failed/u);
  assert.equal(pool.connection.destroyed, true);
});

test("MySQL supersede and insert rollback preserve the active pointer", async () => {
  const pool = new FakeRoutingPool();
  const repository = new MysqlFinancialCouncilModelRoutingRepository(
    pool as never
  );
  const first = routingPolicyVersion();
  await repository.put(routingPutCommand(), first);
  pool.connection.failInsertPolicy = true;
  await assert.rejects(repository.put(routingPutCommand({ key: "next",
    requestHash: `sha256:${"9".repeat(64)}`, expectedRevision: 1 }),
  routingPolicyVersion("team-1", 2)), /forced policy insert failure/u);
  pool.connection.failInsertPolicy = false;
  assert.deepEqual(await repository.getCurrent(routingWorkspace()), first);
  assert.equal(pool.connection.calls.includes("ROLLBACK"), true);
});

test("MySQL rollback failure poisons the transaction connection", async () => {
  const pool = new FakeRoutingPool();
  const repository = new MysqlFinancialCouncilModelRoutingRepository(
    pool as never
  );
  pool.connection.failInsertPolicy = true;
  pool.connection.failRollback = true;
  await assert.rejects(repository.put(routingPutCommand(),
    routingPolicyVersion()), /forced policy insert failure/u);
  assert.equal(pool.connection.destroyed, true);
  assert.equal(pool.connection.calls.includes("RELEASE"), false);
});

test("MySQL persists canonical policy and exact response JSON", async () => {
  const pool = new FakeRoutingPool();
  const repository = new MysqlFinancialCouncilModelRoutingRepository(
    pool as never
  );
  const value = routingPolicyVersion();
  const reordered = {
    policyHash: value.policyHash,
    status: value.status,
    roles: value.roles,
    workspaceId: value.workspaceId,
    policyVersionId: value.policyVersionId,
    revision: value.revision,
    requestTimeoutMs: value.requestTimeoutMs,
    maxRunBudgetMinor: value.maxRunBudgetMinor,
    maxRoleBudgetMinor: value.maxRoleBudgetMinor,
    createdBy: value.createdBy,
    createdAt: value.createdAt
  } as typeof value;
  await repository.put(routingPutCommand(), reordered);
  const policyJson = String(pool.connection.policies[0]?.policy_json);
  const responseJson = String(pool.connection.idempotency[0]?.response_json);
  assert.equal(policyJson.startsWith('{"createdAt":'), true);
  assert.equal(responseJson, policyJson);
});
