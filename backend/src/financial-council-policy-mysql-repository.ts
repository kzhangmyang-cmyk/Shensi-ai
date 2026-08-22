import type mysql from "mysql2/promise";
import type { FinancialCouncilPolicyVersion } from
  "./growth-contract-types.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import { growthMysqlDate } from
  "./growth-temporal-barrier-mysql-repository.js";
import {
  financialCouncilError,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import { assertFinancialCouncilPolicyVersion } from
  "./financial-council-policy.js";
import type {
  FinancialCouncilPolicyCommandResult,
  FinancialCouncilPolicyRepository
} from "./financial-council-policy-repository.js";

export const FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS financial_council_policy_versions (
    workspace_id VARCHAR(255) NOT NULL,
    policy_version_id VARCHAR(255) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) NOT NULL,
    policy_json JSON NOT NULL,
    policy_hash CHAR(71) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, policy_version_id),
    UNIQUE KEY uq_financial_council_policy_version (workspace_id, version),
    UNIQUE KEY uq_financial_council_policy_revision (workspace_id, revision)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS financial_council_policy_heads (
    workspace_id VARCHAR(255) NOT NULL,
    active_policy_version_id VARCHAR(255) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id),
    CONSTRAINT fk_financial_council_policy_head_version
      FOREIGN KEY (workspace_id, active_policy_version_id)
      REFERENCES financial_council_policy_versions
        (workspace_id, policy_version_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS financial_council_policy_commands (
    workspace_id VARCHAR(255) NOT NULL,
    actor_id VARCHAR(255) NOT NULL,
    key_hash CHAR(71) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    policy_version_id VARCHAR(255) NOT NULL,
    PRIMARY KEY (workspace_id, actor_id, key_hash),
    CONSTRAINT fk_financial_council_policy_command_version
      FOREIGN KEY (workspace_id, policy_version_id)
      REFERENCES financial_council_policy_versions
        (workspace_id, policy_version_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
]);

export async function ensureFinancialCouncilPolicyMysqlSchema(
  executor: Pick<mysql.Pool, "query">
): Promise<void> {
  for (const statement of FINANCIAL_COUNCIL_POLICY_MYSQL_SCHEMA_STATEMENTS) {
    await executor.query(statement);
  }
}

type QueryExecutor = Pick<mysql.Pool | mysql.PoolConnection, "query">;

interface PolicyRow {
  readonly workspace_id: string;
  readonly policy_version_id: string;
  readonly policy_json: string | FinancialCouncilPolicyVersion;
}

interface CommandRow {
  readonly request_hash: string;
  readonly policy_version_id: string;
}

function fail(code: string): never {
  throw financialCouncilError(code);
}

function workspace(context: ActiveWorkspaceContext): string {
  const value = context?.workspaceId;
  if (typeof value !== "string" || !value.trim() || value === "all") {
    fail("financial_council_policy_context_invalid");
  }
  return value;
}

function id(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value
    || [...value].length > 255) {
    fail("financial_council_policy_input_invalid");
  }
  return value;
}

function keyHash(command: CommandContext): `sha256:${string}` {
  if (command.actorId !== command.workspace.actorId
    || typeof command.actorId !== "string" || !command.actorId.trim()
    || !/^sha256:[0-9a-f]{64}$/u.test(command.requestHash)) {
    fail("financial_council_policy_context_invalid");
  }
  try {
    return growthHttpIdempotencyKeyHash(command.idempotencyKey);
  } catch {
    fail("financial_council_policy_context_invalid");
  }
}

function fromRow(row: PolicyRow): FinancialCouncilPolicyVersion {
  let value: unknown = row.policy_json;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { fail("financial_council_policy_integrity"); }
  }
  try { assertFinancialCouncilPolicyVersion(value); } catch {
    fail("financial_council_policy_integrity");
  }
  if (value.workspaceId !== row.workspace_id
    || value.policyVersionId !== row.policy_version_id) {
    fail("financial_council_policy_integrity");
  }
  return immutableFinancialCouncilValue(value);
}

async function rows<T>(
  executor: QueryExecutor,
  sql: string,
  values: readonly unknown[]
): Promise<T[]> {
  const [result] = await executor.query(sql, values as unknown[]);
  if (!Array.isArray(result)) fail("financial_council_policy_integrity");
  return result as T[];
}

async function activeRow(
  executor: QueryExecutor,
  workspaceId: string,
  locked = false
): Promise<PolicyRow | null> {
  const found = await rows<PolicyRow>(executor, `
    SELECT v.*
    FROM financial_council_policy_heads h
    INNER JOIN financial_council_policy_versions v
      ON v.workspace_id = h.workspace_id
      AND v.policy_version_id = h.active_policy_version_id
    WHERE h.workspace_id = ?
    LIMIT 1${locked ? " FOR UPDATE" : ""}
  `, [workspaceId]);
  return found[0] ?? null;
}

async function versionRow(
  executor: QueryExecutor,
  workspaceId: string,
  policyVersionId: string
): Promise<PolicyRow | null> {
  const found = await rows<PolicyRow>(executor, `
    SELECT * FROM financial_council_policy_versions
    WHERE workspace_id = ? AND policy_version_id = ?
    LIMIT 1
  `, [workspaceId, policyVersionId]);
  return found[0] ?? null;
}

async function insertPolicy(
  executor: QueryExecutor,
  policy: FinancialCouncilPolicyVersion,
  ignore: boolean
): Promise<void> {
  await executor.query(`
    INSERT${ignore ? " IGNORE" : ""} INTO financial_council_policy_versions (
      workspace_id, policy_version_id, version, revision, currency,
      policy_json, policy_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    policy.workspaceId, policy.policyVersionId, policy.version, policy.revision,
    policy.currency, JSON.stringify(policy), policy.policyHash,
    growthMysqlDate(policy.createdAt)
  ]);
}

export class MysqlFinancialCouncilPolicyRepository
implements FinancialCouncilPolicyRepository {
  constructor(private readonly pool: mysql.Pool) {
    if (!pool || typeof pool.query !== "function"
      || typeof pool.getConnection !== "function") {
      throw new Error("invalid_financial_council_policy_mysql_repository");
    }
  }

  async findActive(context: ActiveWorkspaceContext) {
    const row = await activeRow(this.pool, workspace(context));
    return row ? fromRow(row) : null;
  }

  async findVersion(
    context: ActiveWorkspaceContext,
    policyVersionId: string
  ) {
    const row = await versionRow(
      this.pool, workspace(context), id(policyVersionId)
    );
    return row ? fromRow(row) : null;
  }

  async getOrCreateActive(
    context: ActiveWorkspaceContext,
    serverDefault: FinancialCouncilPolicyVersion
  ) {
    const workspaceId = workspace(context);
    assertFinancialCouncilPolicyVersion(serverDefault);
    if (serverDefault.workspaceId !== workspaceId) {
      fail("financial_council_policy_workspace_mismatch");
    }
    if (serverDefault.policyVersionId !== "financial-council-policy.v1"
      || serverDefault.version !== 1 || serverDefault.revision !== 1) {
      fail("financial_council_policy_default_invalid");
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      let current = await activeRow(connection, workspaceId, true);
      if (!current) {
        const existing = await rows<PolicyRow>(connection, `
          SELECT * FROM financial_council_policy_versions
          WHERE workspace_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE
        `, [workspaceId]);
        if (existing.length !== 0) fail("financial_council_policy_integrity");
        await insertPolicy(connection, serverDefault, true);
        await connection.query(`
          INSERT IGNORE INTO financial_council_policy_heads (
            workspace_id, active_policy_version_id, revision
          ) VALUES (?, ?, ?)
        `, [workspaceId, serverDefault.policyVersionId, serverDefault.revision]);
        current = await activeRow(connection, workspaceId, true);
      }
      if (!current) fail("financial_council_policy_integrity");
      await connection.commit();
      return fromRow(current);
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async createVersion(
    command: CommandContext,
    policy: FinancialCouncilPolicyVersion
  ): Promise<FinancialCouncilPolicyCommandResult> {
    const workspaceId = workspace(command?.workspace);
    assertFinancialCouncilPolicyVersion(policy);
    if (policy.workspaceId !== workspaceId) {
      fail("financial_council_policy_workspace_mismatch");
    }
    const hash = keyHash(command);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const bindings = await rows<CommandRow>(connection, `
        SELECT request_hash, policy_version_id
        FROM financial_council_policy_commands
        WHERE workspace_id = ? AND actor_id = ? AND key_hash = ?
        LIMIT 1 FOR UPDATE
      `, [workspaceId, command.actorId, hash]);
      const binding = bindings[0];
      if (binding) {
        if (binding.request_hash !== command.requestHash) {
          fail("financial_council_policy_idempotency_conflict");
        }
        const replay = await versionRow(
          connection, workspaceId, binding.policy_version_id
        );
        if (!replay) fail("financial_council_policy_integrity");
        await connection.commit();
        return Object.freeze({ value: fromRow(replay), replayed: true });
      }
      const head = await activeRow(connection, workspaceId, true);
      if (!head) fail("financial_council_policy_integrity");
      const current = fromRow(head);
      if (!Number.isSafeInteger(command.expectedRevision)
        || command.expectedRevision !== current.revision
        || policy.version !== current.version + 1
        || policy.revision !== current.revision + 1) {
        fail("financial_council_policy_revision_conflict");
      }
      await insertPolicy(connection, policy, false);
      await connection.query(`
        INSERT INTO financial_council_policy_commands (
          workspace_id, actor_id, key_hash, request_hash, policy_version_id
        ) VALUES (?, ?, ?, ?, ?)
      `, [workspaceId, command.actorId, hash, command.requestHash,
        policy.policyVersionId]);
      const [updated] = await connection.query(`
        UPDATE financial_council_policy_heads
        SET active_policy_version_id = ?, revision = ?
        WHERE workspace_id = ? AND revision = ?
      `, [policy.policyVersionId, policy.revision, workspaceId,
        current.revision]);
      if (!updated || typeof updated !== "object"
        || Number(Reflect.get(updated, "affectedRows")) !== 1) {
        fail("financial_council_policy_revision_conflict");
      }
      await connection.commit();
      return Object.freeze({
        value: immutableFinancialCouncilValue(policy), replayed: false
      });
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}
