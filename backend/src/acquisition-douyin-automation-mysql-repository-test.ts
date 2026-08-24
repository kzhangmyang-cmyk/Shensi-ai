import assert from "node:assert/strict";
import test from "node:test";
import {
  acquisitionDouyinAutomationCommandReplaysDdl,
  acquisitionDouyinAutomationPolicyHeadsDdl,
  acquisitionDouyinAutomationPolicyVersionsDdl,
  acquisitionDouyinRunIntentsDdl,
  ensureAcquisitionDouyinAutomationMysqlSchema,
  MysqlAcquisitionDouyinAutomationRepository
} from "./acquisition-douyin-automation-mysql-repository.js";
import type {
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent
} from "./acquisition-douyin-automation.js";
import { createHash } from "node:crypto";

test("automation MySQL schema keeps immutable versions, a mutable head, hashed replay keys and run intents", async () => {
  const statements = [
    acquisitionDouyinAutomationPolicyVersionsDdl,
    acquisitionDouyinAutomationPolicyHeadsDdl,
    acquisitionDouyinAutomationCommandReplaysDdl,
    acquisitionDouyinRunIntentsDdl
  ];
  assert.match(statements[0]!, /acquisition_douyin_automation_policy_versions/u);
  assert.match(statements[0]!, /UNIQUE KEY[^\n]+workspace_id[^\n]+plan_id[^\n]+version_no/u);
  assert.match(statements[1]!, /current_version_id/u);
  assert.match(statements[2]!, /idempotency_key_hash CHAR\(64\)/u);
  assert.doesNotMatch(statements[2]!, /idempotency_key\s+VARCHAR/iu);
  assert.match(statements[3]!, /daily_budget_id CHAR\(71\)/u);
  assert.match(statements[3]!, /policy_version_id/u);
  assert.match(statements[3]!, /account_login_state_version/u);

  const executed: string[] = [];
  await ensureAcquisitionDouyinAutomationMysqlSchema({
    async query(sql: string) {
      executed.push(sql);
      return [[], []];
    }
  } as never);
  assert.deepEqual(executed, statements);
});

class StatefulAutomationMysqlPool {
  readonly versions = new Map<string, Record<string, unknown>>();
  readonly heads = new Map<string, Record<string, unknown>>();
  readonly replays = new Map<string, Record<string, unknown>>();
  readonly runs = new Map<string, Record<string, unknown>>();
  private snapshot: string | null = null;

  private key(workspaceId: unknown, planId: unknown) {
    return `${String(workspaceId)}:${String(planId)}`;
  }

  async getConnection() { return this; }
  async beginTransaction() {
    this.snapshot = JSON.stringify({
      versions: [...this.versions], heads: [...this.heads],
      replays: [...this.replays], runs: [...this.runs]
    });
  }
  async commit() { this.snapshot = null; }
  async rollback() {
    if (!this.snapshot) return;
    const state = JSON.parse(this.snapshot) as Record<string, Array<[string, Record<string, unknown>]>>;
    for (const [map, rows] of [
      [this.versions, state.versions], [this.heads, state.heads],
      [this.replays, state.replays], [this.runs, state.runs]
    ] as const) {
      map.clear();
      for (const [key, value] of rows) map.set(key, value);
    }
    this.snapshot = null;
  }
  release() {}

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    let result: unknown[] = [];
    if (normalized.startsWith("SELECT * FROM acquisition_douyin_automation_command_replays")) {
      result = [...this.replays.values()].filter((row) =>
        row.workspace_id === values[0] && row.plan_id === values[1]
        && row.operation_name === values[2]
        && row.idempotency_key_hash === values[3]);
    } else if (normalized.startsWith("SELECT v.* FROM acquisition_douyin_automation_policy_heads")) {
      const head = this.heads.get(this.key(values[0], values[1]));
      const version = head && this.versions.get(String(head.current_version_id));
      result = version ? [version] : [];
    } else if (normalized.startsWith("SELECT * FROM acquisition_douyin_automation_policy_versions")) {
      result = [...this.versions.values()].filter((row) =>
        row.workspace_id === values[0] && row.plan_id === values[1])
        .sort((left, right) => Number(left.version_no) - Number(right.version_no));
    } else if (normalized.startsWith("SELECT * FROM acquisition_douyin_automation_policy_heads")) {
      const head = this.heads.get(this.key(values[0], values[1]));
      result = head ? [head] : [];
    } else if (normalized.startsWith("SELECT current_version_id FROM acquisition_douyin_automation_policy_heads")) {
      const head = this.heads.get(this.key(values[0], values[1]));
      result = head ? [{ current_version_id: head.current_version_id }] : [];
    } else if (normalized.startsWith("SELECT payload_json FROM acquisition_plans")) {
      result = values[0] === "plan-1" && values[1] === "owner-1" && values[2] === "team-1"
        ? [{ payload_json: JSON.stringify({ id: "plan-1", currentVersionId: "plan-version-1", status: "approved", approvedVersionId: "plan-version-1" }) }]
        : [];
    } else if (normalized.startsWith("SELECT id FROM acquisition_plan_versions")) {
      result = values[0] === "plan-version-1" && values[1] === "plan-1"
        ? [{ id: "plan-version-1" }]
        : [];
    } else if (normalized.startsWith("SELECT id,workspace_id,state,login_state_version FROM acquisition_social_accounts")) {
      result = values[0] === "workspace-1" && values[1] === "account-1"
        ? [{ id: "account-1", workspace_id: "workspace-1", state: "active", login_state_version: 7 }]
        : [];
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_automation_policy_versions")) {
      const payload = JSON.parse(String(values[12])) as DouyinAutomationPolicyVersion;
      this.versions.set(String(values[0]), {
        id: values[0], workspace_id: values[1], owner_id: values[2], team_id: values[3],
        plan_id: values[4], plan_version_id: values[5], account_id: values[6],
        account_login_state_version: values[7], version_no: values[8], revision: values[9],
        etag: values[10], policy_hash: values[11], payload_json: payload,
        created_by: values[13], created_at: values[14]
      });
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_automation_policy_heads")) {
      this.heads.set(this.key(values[0], values[1]), {
        workspace_id: values[0], plan_id: values[1], current_version_id: values[2],
        revision: values[3], etag: values[4], updated_at: values[5]
      });
    } else if (normalized.startsWith("UPDATE acquisition_douyin_automation_policy_heads")) {
      this.heads.set(this.key(values[4], values[5]), {
        workspace_id: values[4], plan_id: values[5], current_version_id: values[0],
        revision: values[1], etag: values[2], updated_at: values[3]
      });
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_run_intents")) {
      const payload = JSON.parse(String(values[13])) as DouyinAutomationRunIntent;
      this.runs.set(String(values[0]), {
        id: values[0], workspace_id: values[1], owner_id: values[2], team_id: values[3],
        plan_id: values[4], plan_version_id: values[5], policy_version_id: values[6],
        account_id: values[7], account_login_state_version: values[8], daily_budget_id: values[9],
        local_date: values[10], trigger_kind: values[11], status: values[12],
        payload_json: payload, created_at: values[14]
      });
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_automation_command_replays")) {
      const operation = normalized.includes("'put_policy'") ? "put_policy" : "run_now";
      const resultKind = operation === "put_policy" ? "policy" : "run";
      this.replays.set(`${values[0]}:${values[1]}:${operation}:${values[2]}`, {
        workspace_id: values[0], plan_id: values[1], operation_name: operation,
        idempotency_key_hash: values[2], request_hash: values[3], result_kind: resultKind,
        result_id: values[4], response_json: JSON.parse(String(values[5])), created_at: values[6]
      });
    } else if (normalized.startsWith("SELECT * FROM acquisition_douyin_run_intents")) {
      const run = this.runs.get(String(values[1]));
      result = run && run.workspace_id === values[0] ? [run] : [];
    } else {
      throw new Error(`unexpected automation SQL: ${normalized}`);
    }
    return [result, []];
  }
}

function policyVersion(): DouyinAutomationPolicyVersion {
  return {
    id: "policy-1", source: "version", workspaceId: "workspace-1", planId: "plan-1",
    planVersionId: "plan-version-1", planVersion: 1, planSnapshotHash: "plan-hash",
    accountId: "account-1", accountLoginStateVersion: 7, version: 1, revision: 1,
    etag: '"automation-1"', policyHash: `sha256:${"a".repeat(64)}`,
    keywords: ["工业除尘设备"], schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" },
    dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true,
    limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 },
    createdBy: "owner-1", createdAt: "2026-08-25T01:00:00.000Z"
  };
}

test("automation MySQL repository matches append, CAS, replay and frozen run behavior", async () => {
  const pool = new StatefulAutomationMysqlPool();
  const repository = new MysqlAcquisitionDouyinAutomationRepository(pool as never);
  const value = policyVersion();
  const command = {
    workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
    planVersionId: "plan-version-1", accountId: "account-1", accountLoginStateVersion: 7,
    expectedEtag: '"default"', defaultEtag: '"default"', idempotencyKey: "policy-key-1",
    requestHash: `sha256:${"b".repeat(64)}`, value
  };
  assert.equal((await repository.savePolicy(command)).kind, "created");
  assert.deepEqual(await repository.getCurrent("workspace-1", "plan-1"), value);
  assert.deepEqual(await repository.listVersions("workspace-1", "plan-1"), [value]);
  assert.equal((await repository.savePolicy(command)).kind, "replay");
  assert.equal((await repository.savePolicy({ ...command, requestHash: `sha256:${"c".repeat(64)}` })).kind, "conflict");

  const run: DouyinAutomationRunIntent = {
    id: "run-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "plan-version-1",
    planVersion: 1, planSnapshotHash: "plan-hash", policyVersionId: value.id,
    policyHash: value.policyHash, accountId: "account-1", accountLoginStateVersion: 7,
    dailyBudgetId: `sha256:${"d".repeat(64)}`, localDate: "2026-08-25", trigger: "run_now",
    status: "queued", reason: null, createdBy: "owner-1", createdAt: "2026-08-25T01:01:00.000Z"
  };
  const runCommand = {
    workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
    planVersionId: "plan-version-1", policyVersionId: value.id, accountId: "account-1",
    accountLoginStateVersion: 7, idempotencyKey: "run-key-1",
    requestHash: `sha256:${"e".repeat(64)}`, value: run
  };
  assert.equal((await repository.createRunIntent(runCommand)).kind, "created");
  assert.deepEqual(await repository.getRunIntent("workspace-1", "run-1"), run);
  assert.equal((await repository.createRunIntent(runCommand)).kind, "replay");
  assert.equal(
    [...pool.replays.values()].every((row) => String(row.idempotency_key_hash).length === 64),
    true
  );
  assert.equal(
    [...pool.replays.values()].some((row) => row.idempotency_key_hash === createHash("sha256").update("run-key-1").digest("hex")),
    true
  );
});
