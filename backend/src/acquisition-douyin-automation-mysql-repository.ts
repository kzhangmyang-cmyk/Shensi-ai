import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type {
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent
} from "./acquisition-douyin-automation.js";
import {
  douyinAutomationAuthorityIsCurrent,
  type AcquisitionDouyinAutomationRepository,
  type CreateDouyinAutomationRunIntentCommand,
  type CreateDouyinAutomationRunIntentResult,
  type DouyinAutomationCommandOperation,
  type DouyinAutomationReplayLookup,
  type SaveDouyinAutomationPolicyCommand,
  type SaveDouyinAutomationPolicyResult
} from "./acquisition-douyin-automation-repository.js";
import type {
  AcquisitionPlan,
  AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";

export const acquisitionDouyinAutomationPolicyVersionsDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_automation_policy_versions (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  owner_id VARCHAR(100) NOT NULL,
  team_id VARCHAR(100) NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  plan_version_id VARCHAR(160) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  account_login_state_version BIGINT UNSIGNED NOT NULL,
  version_no BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  etag VARCHAR(255) NOT NULL,
  policy_hash CHAR(71) NOT NULL,
  payload_json JSON NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY acquisition_douyin_automation_policy_version_number (workspace_id, plan_id, version_no),
  UNIQUE KEY acquisition_douyin_automation_policy_version_scope (workspace_id, plan_id, id),
  INDEX acquisition_douyin_automation_policy_plan (workspace_id, plan_id, version_no)
) ENGINE=InnoDB`;

export const acquisitionDouyinAutomationPolicyHeadsDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_automation_policy_heads (
  workspace_id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  current_version_id VARCHAR(255) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  etag VARCHAR(255) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (workspace_id, plan_id),
  CONSTRAINT acquisition_douyin_automation_policy_head_version
    FOREIGN KEY (workspace_id, plan_id, current_version_id)
    REFERENCES acquisition_douyin_automation_policy_versions (workspace_id, plan_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB`;

export const acquisitionDouyinAutomationCommandReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_automation_command_replays (
  workspace_id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  operation_name VARCHAR(32) NOT NULL,
  idempotency_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(71) NOT NULL,
  result_kind VARCHAR(16) NOT NULL,
  result_id VARCHAR(255) NOT NULL,
  response_json JSON NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (workspace_id, plan_id, operation_name, idempotency_key_hash),
  CONSTRAINT acquisition_douyin_automation_replay_operation
    CHECK (operation_name IN ('put_policy', 'run_now')),
  CONSTRAINT acquisition_douyin_automation_replay_result
    CHECK (result_kind IN ('policy', 'run'))
) ENGINE=InnoDB`;

export const acquisitionDouyinRunIntentsDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_run_intents (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  owner_id VARCHAR(100) NOT NULL,
  team_id VARCHAR(100) NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  plan_version_id VARCHAR(160) NOT NULL,
  policy_version_id VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  account_login_state_version BIGINT UNSIGNED NOT NULL,
  daily_budget_id CHAR(71) NOT NULL,
  local_date CHAR(10) NOT NULL,
  trigger_kind VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  payload_json JSON NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY acquisition_douyin_run_intent_scope (workspace_id, id),
  INDEX acquisition_douyin_run_intent_daily_budget (workspace_id, daily_budget_id, created_at),
  CONSTRAINT acquisition_douyin_run_intent_policy
    FOREIGN KEY (workspace_id, plan_id, policy_version_id)
    REFERENCES acquisition_douyin_automation_policy_versions (workspace_id, plan_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT acquisition_douyin_run_intent_trigger
    CHECK (trigger_kind IN ('run_now', 'scheduled')),
  CONSTRAINT acquisition_douyin_run_intent_status
    CHECK (status IN ('queued'))
) ENGINE=InnoDB`;

const schemaStatements = [
  acquisitionDouyinAutomationPolicyVersionsDdl,
  acquisitionDouyinAutomationPolicyHeadsDdl,
  acquisitionDouyinAutomationCommandReplaysDdl,
  acquisitionDouyinRunIntentsDdl
];

export async function ensureAcquisitionDouyinAutomationMysqlSchema(
  pool: Pick<mysql.Pool, "query">
) {
  for (const statement of schemaStatements) await pool.query(statement);
}

type Source = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type Row = Record<string, unknown>;

function keyHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function parsed(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function rows(source: Source, sql: string, values: unknown[] = []) {
  const [result] = await source.query(sql, values);
  return Array.isArray(result) ? result as Row[] : [];
}

function policy(row: Row): DouyinAutomationPolicyVersion {
  const value = parsed(row.payload_json) as DouyinAutomationPolicyVersion;
  if (value.id !== String(row.id)
    || value.workspaceId !== String(row.workspace_id)
    || value.planId !== String(row.plan_id)
    || value.planVersionId !== String(row.plan_version_id)
    || value.accountId !== String(row.account_id)
    || value.accountLoginStateVersion
      !== Number(row.account_login_state_version)
    || value.version !== Number(row.version_no)
    || value.revision !== Number(row.revision)
    || value.etag !== String(row.etag)
    || value.policyHash !== String(row.policy_hash)) {
    throw new Error("acquisition_douyin_automation_policy_row_corrupt");
  }
  return structuredClone(value);
}

function runIntent(row: Row): DouyinAutomationRunIntent {
  const value = parsed(row.payload_json) as DouyinAutomationRunIntent;
  if (value.id !== String(row.id)
    || value.workspaceId !== String(row.workspace_id)
    || value.planId !== String(row.plan_id)
    || value.planVersionId !== String(row.plan_version_id)
    || value.policyVersionId !== String(row.policy_version_id)
    || value.accountId !== String(row.account_id)
    || value.accountLoginStateVersion
      !== Number(row.account_login_state_version)
    || value.dailyBudgetId !== String(row.daily_budget_id)
    || value.localDate !== String(row.local_date)
    || value.trigger !== String(row.trigger_kind)
    || value.status !== String(row.status)) {
    throw new Error("acquisition_douyin_run_intent_row_corrupt");
  }
  return structuredClone(value);
}

function replay(row: Row | undefined, requestHash: string): DouyinAutomationReplayLookup {
  if (!row) return { kind: "none" };
  if (String(row.request_hash) !== requestHash) return { kind: "conflict" };
  const value = parsed(row.response_json);
  if (row.result_kind === "policy") {
    return { kind: "policy", value: structuredClone(value) as DouyinAutomationPolicyVersion };
  }
  if (row.result_kind === "run") {
    return { kind: "run", value: structuredClone(value) as DouyinAutomationRunIntent };
  }
  throw new Error("acquisition_douyin_automation_replay_corrupt");
}

async function readReplay(
  source: Source,
  workspaceId: string,
  planId: string,
  operation: DouyinAutomationCommandOperation,
  idempotencyKey: string,
  requestHash: string,
  forUpdate = false
) {
  const result = await rows(
    source,
    `SELECT * FROM acquisition_douyin_automation_command_replays
     WHERE workspace_id=? AND plan_id=? AND operation_name=?
       AND idempotency_key_hash=?${forUpdate ? " FOR UPDATE" : ""}`,
    [workspaceId, planId, operation, keyHash(idempotencyKey)]
  );
  return replay(result[0], requestHash);
}

async function lockPlanAuthority(
  source: Source,
  command: {
    ownerId: string;
    teamId: string;
    planId: string;
  }
) {
  const planRows = await rows(
    source,
    `SELECT payload_json FROM acquisition_plans
     WHERE id=? AND owner_id=? AND team_id=? FOR UPDATE`,
    [command.planId, command.ownerId, command.teamId]
  );
  return planRows[0]
    ? parsed(planRows[0].payload_json) as AcquisitionPlan
    : null;
}

async function bindingIsCurrent(
  source: Source,
  command: SaveDouyinAutomationPolicyCommand
    | CreateDouyinAutomationRunIntentCommand,
  requireApproved: boolean,
  plan: AcquisitionPlan | null
) {
  const versionRows = await rows(
    source,
    `SELECT payload_json FROM acquisition_plan_versions
     WHERE id=? AND plan_id=? AND owner_id=? AND team_id=? FOR UPDATE`,
    [command.planVersionId, command.planId, command.ownerId, command.teamId]
  );
  const version = versionRows[0]
    ? parsed(versionRows[0].payload_json) as AcquisitionPlanVersion
    : null;
  const accountRows = await rows(
    source,
    `SELECT id,workspace_id,state,login_state_version
     FROM acquisition_social_accounts
     WHERE workspace_id=? AND id=? AND platform='douyin' FOR UPDATE`,
    [command.workspaceId, command.accountId]
  );
  const row = accountRows[0];
  const account = row ? {
    workspaceId: String(row.workspace_id),
    id: String(row.id),
    platform: "douyin" as const,
    state: row.state as "active" | "login_expired" | "disconnected",
    loginStateVersion: Number(row.login_state_version)
  } : null;
  return douyinAutomationAuthorityIsCurrent(
    command,
    { plan, version, account },
    requireApproved
  );
}

export class MysqlAcquisitionDouyinAutomationRepository
implements AcquisitionDouyinAutomationRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async listCurrentPolicies() {
    const result = await rows(
      this.pool,
      `SELECT v.* FROM acquisition_douyin_automation_policy_heads h
       INNER JOIN acquisition_douyin_automation_policy_versions v
       ON v.workspace_id=h.workspace_id AND v.plan_id=h.plan_id
       AND v.id=h.current_version_id ORDER BY v.workspace_id,v.plan_id`,
      []
    );
    return result.map(policy);
  }

  async getCurrent(workspaceId: string, planId: string) {
    const result = await rows(
      this.pool,
      `SELECT v.* FROM acquisition_douyin_automation_policy_heads h
       INNER JOIN acquisition_douyin_automation_policy_versions v
         ON v.workspace_id=h.workspace_id AND v.plan_id=h.plan_id
        AND v.id=h.current_version_id
       WHERE h.workspace_id=? AND h.plan_id=?`,
      [workspaceId, planId]
    );
    return result[0] ? policy(result[0]) : null;
  }

  async listVersions(workspaceId: string, planId: string) {
    const result = await rows(
      this.pool,
      `SELECT * FROM acquisition_douyin_automation_policy_versions
       WHERE workspace_id=? AND plan_id=? ORDER BY version_no,id`,
      [workspaceId, planId]
    );
    return result.map(policy);
  }

  findCommandReplay(
    workspaceId: string,
    planId: string,
    operation: DouyinAutomationCommandOperation,
    idempotencyKey: string,
    requestHash: string
  ) {
    return readReplay(
      this.pool,
      workspaceId,
      planId,
      operation,
      idempotencyKey,
      requestHash
    );
  }

  async savePolicy(
    command: SaveDouyinAutomationPolicyCommand
  ): Promise<SaveDouyinAutomationPolicyResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const plan = await lockPlanAuthority(connection, command);
      const existing = await readReplay(
        connection,
        command.workspaceId,
        command.planId,
        "put_policy",
        command.idempotencyKey,
        command.requestHash,
        true
      );
      if (existing.kind === "conflict") {
        await connection.rollback();
        return { kind: "conflict" };
      }
      if (existing.kind !== "none") {
        await connection.commit();
        return existing.kind === "policy"
          ? { kind: "replay", value: existing.value }
          : { kind: "binding_mismatch" };
      }
      const heads = await rows(
        connection,
        `SELECT * FROM acquisition_douyin_automation_policy_heads
         WHERE workspace_id=? AND plan_id=? FOR UPDATE`,
        [command.workspaceId, command.planId]
      );
      const head = heads[0];
      const actualEtag = head ? String(head.etag) : command.defaultEtag;
      if (actualEtag !== command.expectedEtag) {
        await connection.rollback();
        return { kind: "precondition_failed" };
      }
      if (!await bindingIsCurrent(connection, command, false, plan)) {
        await connection.rollback();
        return { kind: "binding_mismatch" };
      }
      const expectedRevision = Number(head?.revision ?? 0) + 1;
      if (command.value.version !== expectedRevision
        || command.value.revision !== expectedRevision) {
        await connection.rollback();
        return { kind: "binding_mismatch" };
      }
      await connection.query(
        `INSERT INTO acquisition_douyin_automation_policy_versions
         (id,workspace_id,owner_id,team_id,plan_id,plan_version_id,
          account_id,account_login_state_version,version_no,revision,etag,
          policy_hash,payload_json,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          command.value.id,
          command.workspaceId,
          command.ownerId,
          command.teamId,
          command.planId,
          command.planVersionId,
          command.accountId,
          command.accountLoginStateVersion,
          command.value.version,
          command.value.revision,
          command.value.etag,
          command.value.policyHash,
          json(command.value),
          command.value.createdBy,
          command.value.createdAt
        ]
      );
      if (head) {
        await connection.query(
          `UPDATE acquisition_douyin_automation_policy_heads
           SET current_version_id=?,revision=?,etag=?,updated_at=?
           WHERE workspace_id=? AND plan_id=? AND revision=?`,
          [command.value.id, command.value.revision, command.value.etag,
            command.value.createdAt, command.workspaceId, command.planId,
            Number(head.revision)]
        );
      } else {
        await connection.query(
          `INSERT INTO acquisition_douyin_automation_policy_heads
           (workspace_id,plan_id,current_version_id,revision,etag,updated_at)
           VALUES (?,?,?,?,?,?)`,
          [command.workspaceId, command.planId, command.value.id,
            command.value.revision, command.value.etag, command.value.createdAt]
        );
      }
      await connection.query(
        `INSERT INTO acquisition_douyin_automation_command_replays
         (workspace_id,plan_id,operation_name,idempotency_key_hash,
          request_hash,result_kind,result_id,response_json,created_at)
         VALUES (?,?,'put_policy',?,?,'policy',?,?,?)`,
        [command.workspaceId, command.planId, keyHash(command.idempotencyKey),
          command.requestHash, command.value.id, json(command.value),
          command.value.createdAt]
      );
      await connection.commit();
      return { kind: "created", value: command.value };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async createRunIntent(
    command: CreateDouyinAutomationRunIntentCommand
  ): Promise<CreateDouyinAutomationRunIntentResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const plan = await lockPlanAuthority(connection, command);
      const existing = await readReplay(
        connection,
        command.workspaceId,
        command.planId,
        "run_now",
        command.idempotencyKey,
        command.requestHash,
        true
      );
      if (existing.kind === "conflict") {
        await connection.rollback();
        return { kind: "conflict" };
      }
      if (existing.kind !== "none") {
        await connection.commit();
        return existing.kind === "run"
          ? { kind: "replay", value: existing.value }
          : { kind: "binding_mismatch" };
      }
      const heads = await rows(
        connection,
        `SELECT current_version_id FROM acquisition_douyin_automation_policy_heads
         WHERE workspace_id=? AND plan_id=? FOR UPDATE`,
        [command.workspaceId, command.planId]
      );
      if (String(heads[0]?.current_version_id ?? "")
        !== command.policyVersionId
        || !await bindingIsCurrent(connection, command, true, plan)) {
        await connection.rollback();
        return { kind: "binding_mismatch" };
      }
      await connection.query(
        `INSERT INTO acquisition_douyin_run_intents
         (id,workspace_id,owner_id,team_id,plan_id,plan_version_id,
          policy_version_id,account_id,account_login_state_version,
          daily_budget_id,local_date,trigger_kind,status,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [command.value.id, command.workspaceId, command.ownerId,
          command.teamId, command.planId, command.planVersionId,
          command.policyVersionId, command.accountId,
          command.accountLoginStateVersion, command.value.dailyBudgetId,
          command.value.localDate, command.value.trigger, command.value.status,
          json(command.value), command.value.createdAt]
      );
      await connection.query(
        `INSERT INTO acquisition_douyin_automation_command_replays
         (workspace_id,plan_id,operation_name,idempotency_key_hash,
          request_hash,result_kind,result_id,response_json,created_at)
         VALUES (?,?,'run_now',?,?,'run',?,?,?)`,
        [command.workspaceId, command.planId, keyHash(command.idempotencyKey),
          command.requestHash, command.value.id, json(command.value),
          command.value.createdAt]
      );
      await connection.commit();
      return { kind: "created", value: command.value };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getRunIntent(workspaceId: string, runId: string) {
    const result = await rows(
      this.pool,
      `SELECT * FROM acquisition_douyin_run_intents
       WHERE workspace_id=? AND id=?`,
      [workspaceId, runId]
    );
    return result[0] ? runIntent(result[0]) : null;
  }
}
