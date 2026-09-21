import type mysql from "mysql2/promise";
import { growthMysqlDate } from
  "./growth-temporal-barrier-mysql-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  FinancialCouncilModelRoutingError,
  assertFinancialCouncilModelRoutingPolicyVersion,
  financialCouncilModelRoutingCanonicalJson,
  immutableFinancialCouncilModelRoutingPolicyVersion,
  withFinancialCouncilModelRoutingPolicyStatus,
  type FinancialCouncilModelRoutingPolicyVersion
} from "./financial-council-model-routing.js";
import {
  financialCouncilModelRoutingCommandIdentity,
  financialCouncilModelRoutingPolicyId,
  financialCouncilModelRoutingWorkspaceId,
  type FinancialCouncilModelRoutingPolicyCommandResult,
  type FinancialCouncilModelRoutingRepository,
  type PutFinancialCouncilModelRoutingPolicyCommand
} from "./financial-council-model-routing-repository.js";

export const FINANCIAL_COUNCIL_MODEL_ROUTING_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS financial_council_model_routing_policies (
    workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_json JSON NOT NULL,
    policy_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_by VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, policy_version_id),
    UNIQUE KEY uq_financial_council_model_routing_revision (workspace_id, revision),
    KEY idx_financial_council_model_routing_current (workspace_id, status, revision),
    CONSTRAINT chk_financial_council_model_routing_status CHECK (
      status IN ('active', 'superseded')
    )
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS financial_council_model_routing_idempotency (
    workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    key_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    response_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, actor_id, key_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
] as const;

const SCHEMA_LOCK = "financial:council-model-routing-schema:v1";

type MysqlRow = Record<string, unknown>;
type QueryExecutor = Pick<mysql.Pool | mysql.PoolConnection, "query">;

function fail(code: string): never {
  throw new FinancialCouncilModelRoutingError(code);
}

function poison(connection: mysql.PoolConnection) {
  try { connection.destroy(); } catch { /* never return an uncertain session */ }
}

export async function ensureFinancialCouncilModelRoutingMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  const connection = await pool.getConnection();
  let acquired = false;
  let poisoned = false;
  try {
    try {
      const [result] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS lock_acquired", [SCHEMA_LOCK, 30]
      );
      const row = Array.isArray(result) ? result[0] as MysqlRow : undefined;
      if (Number(row?.lock_acquired) !== 1) throw new Error();
      acquired = true;
    } catch {
      poison(connection); poisoned = true;
      throw new FinancialCouncilModelRoutingError(
        "financial_council_model_routing_schema_lock_failed"
      );
    }
    for (const statement of FINANCIAL_COUNCIL_MODEL_ROUTING_MYSQL_SCHEMA_STATEMENTS) {
      await connection.query(statement);
    }
  } finally {
    if (acquired) {
      try {
        const [result] = await connection.query(
          "SELECT RELEASE_LOCK(?) AS lock_released", [SCHEMA_LOCK]
        );
        const row = Array.isArray(result) ? result[0] as MysqlRow : undefined;
        if (Number(row?.lock_released) !== 1) throw new Error();
      } catch {
        if (!poisoned) poison(connection);
        poisoned = true;
        throw new FinancialCouncilModelRoutingError(
          "financial_council_model_routing_schema_lock_failed"
        );
      }
    }
    if (!poisoned) connection.release();
  }
}

interface PolicyRow extends MysqlRow {
  readonly workspace_id: string;
  readonly policy_version_id: string;
  readonly status: string;
  readonly policy_json: string | FinancialCouncilModelRoutingPolicyVersion;
  readonly policy_hash: string;
}

interface IdempotencyRow extends MysqlRow {
  readonly request_hash: string;
  readonly response_json: string | FinancialCouncilModelRoutingPolicyVersion;
}

async function rows<T>(
  executor: QueryExecutor,
  sql: string,
  values: readonly unknown[]
): Promise<T[]> {
  const [result] = await executor.query(sql, values as unknown[]);
  if (!Array.isArray(result)) fail("financial_council_model_routing_integrity");
  return result as T[];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { fail("financial_council_model_routing_integrity"); }
}

function policyFromRow(row: PolicyRow) {
  const value = parseJson(row.policy_json);
  try { assertFinancialCouncilModelRoutingPolicyVersion(value); }
  catch { fail("financial_council_model_routing_integrity"); }
  if (value.workspaceId !== row.workspace_id
    || value.policyVersionId !== row.policy_version_id
    || value.status !== row.status || value.policyHash !== row.policy_hash) {
    fail("financial_council_model_routing_integrity");
  }
  return immutableFinancialCouncilModelRoutingPolicyVersion(value);
}

function responseFromRow(row: IdempotencyRow) {
  const value = parseJson(row.response_json);
  try { assertFinancialCouncilModelRoutingPolicyVersion(value); }
  catch { fail("financial_council_model_routing_integrity"); }
  return immutableFinancialCouncilModelRoutingPolicyVersion(value);
}

async function activeRow(
  executor: QueryExecutor,
  workspaceId: string,
  locked = false
) {
  const found = await rows<PolicyRow>(executor, `
    SELECT * FROM financial_council_model_routing_policies
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY revision DESC LIMIT 2${locked ? " FOR UPDATE" : ""}
  `, [workspaceId]);
  if (found.length > 1) fail("financial_council_model_routing_integrity");
  return found[0] ?? null;
}

async function versionRow(
  executor: QueryExecutor,
  workspaceId: string,
  policyVersionId: string
) {
  const found = await rows<PolicyRow>(executor, `
    SELECT * FROM financial_council_model_routing_policies
    WHERE workspace_id = ? AND policy_version_id = ? LIMIT 1
  `, [workspaceId, policyVersionId]);
  return found[0] ?? null;
}

export class MysqlFinancialCouncilModelRoutingRepository
implements FinancialCouncilModelRoutingRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly pool: mysql.Pool) {
    if (!pool || typeof pool.query !== "function"
      || typeof pool.getConnection !== "function") {
      throw new Error("invalid_financial_council_model_routing_mysql_repository");
    }
  }

  async getCurrent(context: ActiveWorkspaceContext) {
    const row = await activeRow(
      this.pool, financialCouncilModelRoutingWorkspaceId(context)
    );
    return row ? policyFromRow(row) : null;
  }

  async getVersion(context: ActiveWorkspaceContext, policyVersionId: string) {
    const row = await versionRow(this.pool,
      financialCouncilModelRoutingWorkspaceId(context),
      financialCouncilModelRoutingPolicyId(policyVersionId));
    return row ? policyFromRow(row) : null;
  }

  async put(
    command: PutFinancialCouncilModelRoutingPolicyCommand,
    policy: FinancialCouncilModelRoutingPolicyVersion
  ): Promise<FinancialCouncilModelRoutingPolicyCommandResult> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { return await this.putExclusive(command, policy); }
    finally { release(); }
  }

  private async putExclusive(
    command: PutFinancialCouncilModelRoutingPolicyCommand,
    policy: FinancialCouncilModelRoutingPolicyVersion
  ): Promise<FinancialCouncilModelRoutingPolicyCommandResult> {
    const identity = financialCouncilModelRoutingCommandIdentity(command);
    const connection = await this.pool.getConnection();
    let poisoned = false;
    try {
      await connection.beginTransaction();
      const bindings = await rows<IdempotencyRow>(connection, `
        SELECT request_hash, response_json
        FROM financial_council_model_routing_idempotency
        WHERE workspace_id = ? AND actor_id = ? AND key_hash = ?
        LIMIT 1 FOR UPDATE
      `, [identity.workspaceId, identity.actorId, identity.keyHash]);
      const binding = bindings[0];
      if (binding) {
        if (binding.request_hash !== command.requestHash) {
          fail("financial_council_model_routing_idempotency_conflict");
        }
        const response = responseFromRow(binding);
        if (response.workspaceId !== identity.workspaceId
          || response.createdBy !== identity.actorId) {
          fail("financial_council_model_routing_integrity");
        }
        await connection.commit();
        return Object.freeze({ value: response, replayed: true });
      }
      try { assertFinancialCouncilModelRoutingPolicyVersion(policy); }
      catch { fail("financial_council_model_routing_integrity"); }
      if (policy.workspaceId !== identity.workspaceId
        || policy.createdBy !== identity.actorId) {
        fail("financial_council_model_routing_workspace_mismatch");
      }
      if (policy.status !== "active") {
        fail("financial_council_model_routing_integrity");
      }
      const head = await activeRow(connection, identity.workspaceId, true);
      const current = head ? policyFromRow(head) : null;
      const currentRevision = current?.revision ?? null;
      if (command.expectedRevision !== currentRevision
        || policy.revision !== (currentRevision ?? 0) + 1) {
        fail("financial_council_model_routing_revision_conflict");
      }
      if (current) {
        const superseded = withFinancialCouncilModelRoutingPolicyStatus(
          current, "superseded"
        );
        const [result] = await connection.query(`
          UPDATE financial_council_model_routing_policies
          SET status = ?, policy_json = ?
          WHERE workspace_id = ? AND policy_version_id = ?
            AND status = 'active' AND revision = ?
        `, ["superseded", financialCouncilModelRoutingCanonicalJson(superseded),
          identity.workspaceId,
          current.policyVersionId, current.revision]);
        if (Number((result as { affectedRows?: unknown })?.affectedRows) !== 1) {
          fail("financial_council_model_routing_revision_conflict");
        }
      }
      await connection.query(`
        INSERT INTO financial_council_model_routing_policies (
          workspace_id, policy_version_id, revision, status, policy_json,
          policy_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [policy.workspaceId, policy.policyVersionId, policy.revision,
        policy.status, financialCouncilModelRoutingCanonicalJson(policy),
        policy.policyHash,
        policy.createdBy, growthMysqlDate(policy.createdAt)]);
      await connection.query(`
        INSERT INTO financial_council_model_routing_idempotency (
          workspace_id, actor_id, key_hash, request_hash,
          response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [identity.workspaceId, identity.actorId, identity.keyHash,
        command.requestHash, financialCouncilModelRoutingCanonicalJson(policy),
        growthMysqlDate(policy.createdAt)]);
      await connection.commit();
      return Object.freeze({
        value: immutableFinancialCouncilModelRoutingPolicyVersion(policy),
        replayed: false
      });
    } catch (error) {
      try { await connection.rollback(); }
      catch { poison(connection); poisoned = true; }
      throw error;
    } finally {
      if (!poisoned) connection.release();
    }
  }
}
