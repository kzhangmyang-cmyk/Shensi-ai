import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ensureAcquisitionMysqlSchema } from "./acquisition-mysql-repositories.js";
import {
  ensureAcquisitionSocialAccountsMysqlSchema
} from "./acquisition-social-account-mysql-repository.js";
import {
  acquisitionDouyinAutomationCommandReplaysDdl,
  acquisitionDouyinAutomationMigrationStatements,
  acquisitionDouyinAutomationPolicyHeadsDdl,
  acquisitionDouyinAutomationPolicyVersionsDdl,
  acquisitionDouyinRunBindingsDdl,
  acquisitionDouyinRunIntentsDdl,
  ensureAcquisitionDouyinAutomationMysqlSchema,
  MysqlAcquisitionDouyinAutomationRepository
} from "./acquisition-douyin-automation-mysql-repository.js";
import type {
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent
} from "./acquisition-douyin-automation.js";
import {
  douyinAutomationAuthorityIsCurrent,
  InMemoryAcquisitionDouyinAutomationRepository,
  type DouyinAutomationAuthorityState
} from "./acquisition-douyin-automation-repository.js";
import {
  AcquisitionMemoryTransactionCoordinator
} from "./acquisition-memory-transaction-coordinator.js";
import {
  createDouyinCollectionAcquisitionRun,
  type AcquisitionPlan,
  type AcquisitionPlanPayload,
  type AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";

test("automation MySQL schema keeps immutable versions, a mutable head, hashed replay keys and run intents", async () => {
  const statements = [
    acquisitionDouyinAutomationPolicyVersionsDdl,
    acquisitionDouyinAutomationPolicyHeadsDdl,
    acquisitionDouyinAutomationCommandReplaysDdl,
    acquisitionDouyinRunIntentsDdl,
    acquisitionDouyinRunBindingsDdl
  ];
  assert.match(statements[0]!, /acquisition_douyin_automation_policy_versions/u);
  assert.match(statements[0]!, /UNIQUE KEY[^\n]+workspace_id[^\n]+plan_id[^\n]+version_no/u);
  assert.match(statements[1]!, /current_version_id/u);
  assert.match(statements[2]!, /idempotency_key_hash CHAR\(64\)/u);
  assert.doesNotMatch(statements[2]!, /idempotency_key\s+VARCHAR/iu);
  assert.match(statements[3]!, /daily_budget_id CHAR\(71\)/u);
  assert.match(statements[3]!, /policy_version_id/u);
  assert.match(statements[3]!, /account_login_state_version/u);
  assert.match(statements[4]!, /acquisition_run_id/u);

  const executed: string[] = [];
  await ensureAcquisitionDouyinAutomationMysqlSchema({
    async query(sql: string) {
      executed.push(sql);
      return [[], []];
    }
  } as never);
  assert.deepEqual(executed.slice(0, statements.length), statements);
  assert.deepEqual(
    executed.slice(statements.length, -1),
    acquisitionDouyinAutomationMigrationStatements
  );
  assert.match(executed.at(-1)!, /SELECT i\.id/u);
});

test("legacy run-intent JSON safely backfills from the authoritative binding", async () => {
  const current: DouyinAutomationRunIntent = {
    id: "legacy-intent", acquisitionRunId: "authoritative-run",
    workspaceId: "workspace-1", planId: "plan-1",
    planVersionId: "plan-version-1", planVersion: 1,
    planSnapshotHash: "plan-hash", policyVersionId: "policy-1",
    policyHash: `sha256:${"a".repeat(64)}`, accountId: "account-1",
    accountLoginStateVersion: 7, dailyBudgetId: `sha256:${"b".repeat(64)}`,
    localDate: "2026-08-25", trigger: "run_now",
    collectCreators: true, collectDemandComments: true, status: "queued",
    reason: null, createdBy: "owner-1", createdAt: "2026-08-25T01:00:00.000Z"
  };
  const { acquisitionRunId: _omitted, ...legacy } = current;
  const row = {
    id: current.id, workspace_id: current.workspaceId,
    plan_id: current.planId, plan_version_id: current.planVersionId,
    policy_version_id: current.policyVersionId, account_id: current.accountId,
    account_login_state_version: current.accountLoginStateVersion,
    daily_budget_id: current.dailyBudgetId, local_date: current.localDate,
    trigger_kind: current.trigger, status: current.status,
    payload_json: legacy, acquisition_run_id: current.acquisitionRunId
  };
  const repository = new MysqlAcquisitionDouyinAutomationRepository({
    async query(sql: string) {
      return [sql.includes("acquisition_douyin_run_intents") ? [row] : [], []];
    }
  } as never);
  assert.deepEqual(
    await repository.getRunIntent(current.workspaceId, current.id),
    current
  );
});

function acquisitionPlanPayload(): AcquisitionPlanPayload {
  return {
    targetPlatform: "douyin",
    name: "Douyin acquisition",
    objective: "Find public demand",
    icp: {
      industries: [], regions: [], organizationCriteria: [],
      individualCriteria: [], exclusionRules: []
    },
    subjectChannels: { organization: false, individual: true },
    providerConnections: [], operations: [],
    budgetSnapshot: {
      billingCurrency: "CNY", maxRequests: 100, maxResults: 200,
      maxAmountMinor: 10_000, maxDurationSeconds: 3_600
    },
    modelSnapshotRef: {
      jobSnapshotId: "model-job-1", connectionId: "model-connection-1",
      credentialVersion: 1, provider: "qwen", model: "qwen-plus",
      capabilitySnapshotHash: "sha256:capability", promptVersion: "prompt-v1",
      schemaVersion: "schema-v1", promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

function frozenPlan() {
  const payload = acquisitionPlanPayload();
  const version: AcquisitionPlanVersion = {
    id: "plan-version-1", planId: "plan-1", ownerId: "owner-1",
    teamId: "team-1", version: 1, payload, payloadHash: "plan-hash",
    createdBy: "owner-1", createdAt: "2026-08-25T01:00:00.000Z"
  };
  const plan: AcquisitionPlan = {
    id: "plan-1", ownerId: "owner-1", teamId: "team-1",
    status: "approved", version: 1, revision: 2, etag: '"plan-1:2"',
    currentVersionId: version.id, approvedVersionId: version.id,
    approvedSnapshotHash: version.payloadHash, approvedBy: "owner-1",
    approvedAt: version.createdAt, budgetSnapshot: payload.budgetSnapshot,
    payload, createdBy: "owner-1", createdAt: version.createdAt,
    updatedBy: "owner-1", updatedAt: version.createdAt
  };
  return { plan, version };
}

function bindingFor(run: DouyinAutomationRunIntent) {
  const { plan, version } = frozenPlan();
  return createDouyinCollectionAcquisitionRun({
    id: run.acquisitionRunId,
    automationIntentId: run.id,
    plan,
    version,
    dailyBudgetId: run.dailyBudgetId,
    reason: run.reason,
    actorId: run.createdBy,
    createdAt: run.createdAt
  });
}

class StatefulAutomationMysqlPool {
  readonly versions = new Map<string, Record<string, unknown>>();
  readonly heads = new Map<string, Record<string, unknown>>();
  readonly replays = new Map<string, Record<string, unknown>>();
  readonly runs = new Map<string, Record<string, unknown>>();
  readonly bindings = new Map<string, string>();
  planCurrentVersionId = "plan-version-1";
  accountState: "active" | "login_expired" = "active";
  accountLoginStateVersion = 7;
  private lockTail: Promise<void> = Promise.resolve();

  private key(workspaceId: unknown, planId: unknown) {
    return `${String(workspaceId)}:${String(planId)}`;
  }

  private async acquirePlanLock() {
    const previous = this.lockTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lockTail = previous.then(() => current);
    await previous;
    return release;
  }

  async getConnection() {
    const pool = this;
    let releasePlanLock: (() => void) | null = null;
    return {
      async beginTransaction() {},
      async query(sql: string, values: unknown[] = []) {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        if (!releasePlanLock
          && normalized.startsWith("SELECT payload_json FROM acquisition_plans")) {
          releasePlanLock = await pool.acquirePlanLock();
        }
        return pool.query(sql, values);
      },
      async commit() {
        releasePlanLock?.();
        releasePlanLock = null;
      },
      async rollback() {
        releasePlanLock?.();
        releasePlanLock = null;
      },
      release() {
        releasePlanLock?.();
        releasePlanLock = null;
      }
    };
  }

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    let result: unknown[] = [];
    if (normalized.startsWith("SELECT r.*,b.acquisition_run_id FROM acquisition_douyin_automation_command_replays")) {
      result = [...this.replays.values()].filter((row) =>
        row.workspace_id === values[0] && row.plan_id === values[1]
        && row.operation_name === values[2]
        && row.idempotency_key_hash === values[3]).map((row) => ({
          ...row,
          acquisition_run_id: this.bindings.get(String(row.result_id)) ?? null
        }));
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
        ? [{ payload_json: JSON.stringify({
            ...frozenPlan().plan,
            currentVersionId: this.planCurrentVersionId
          }) }]
        : [];
    } else if (normalized.startsWith("SELECT payload_json FROM acquisition_plan_versions")) {
      result = values[0] === "plan-version-1" && values[1] === "plan-1"
        ? [{ payload_json: JSON.stringify(frozenPlan().version) }]
        : [];
    } else if (normalized.startsWith("SELECT id,workspace_id,state,login_state_version FROM acquisition_social_accounts")) {
      result = values[0] === "workspace-1" && values[1] === "account-1"
        ? [{ id: "account-1", workspace_id: "workspace-1", state: this.accountState,
            login_state_version: this.accountLoginStateVersion }]
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
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_run_bindings")) {
      this.bindings.set(String(values[0]), String(values[1]));
    } else if (normalized.startsWith("INSERT INTO acquisition_runs")
      || normalized.startsWith("INSERT INTO acquisition_run_events")
      || normalized.startsWith("INSERT INTO acquisition_plan_run_audit_events")) {
      result = [];
    } else if (normalized.startsWith("INSERT INTO acquisition_douyin_automation_command_replays")) {
      const operation = normalized.includes("'put_policy'") ? "put_policy" : "run_now";
      const resultKind = operation === "put_policy" ? "policy" : "run";
      this.replays.set(`${values[0]}:${values[1]}:${operation}:${values[2]}`, {
        workspace_id: values[0], plan_id: values[1], operation_name: operation,
        idempotency_key_hash: values[2], request_hash: values[3], result_kind: resultKind,
        result_id: values[4], response_json: JSON.parse(String(values[5])), created_at: values[6]
      });
    } else if (normalized.startsWith("SELECT i.*,b.acquisition_run_id FROM acquisition_douyin_run_intents")) {
      const run = this.runs.get(String(values[1]));
      result = run && run.workspace_id === values[0] ? [{
        ...run,
        acquisition_run_id: this.bindings.get(String(run.id)) ?? null
      }] : [];
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

function authorityState(): DouyinAutomationAuthorityState {
  const { plan, version } = frozenPlan();
  return {
    plan,
    version,
    account: {
      id: "account-1", workspaceId: "workspace-1", platform: "douyin",
      state: "active", loginStateVersion: 7
    }
  };
}

function driftAuthority(
  authority: DouyinAutomationAuthorityState,
  drift: "plan" | "account" | "login"
) {
  if (drift === "plan") {
    authority.plan = { ...authority.plan!, currentVersionId: "plan-version-changed" };
  } else if (drift === "account") {
    authority.account = { ...authority.account!, state: "login_expired" };
  } else {
    authority.account = { ...authority.account!, loginStateVersion: 8 };
  }
}

function memoryRepository(authority: DouyinAutomationAuthorityState) {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  return new InMemoryAcquisitionDouyinAutomationRepository(
    memoryTransactions,
    {
      isCurrent(command, requireApproved, token) {
        memoryTransactions.assertOwns(token);
        return douyinAutomationAuthorityIsCurrent(
          command,
          authority,
          requireApproved
        );
      },
      bindRun(_command, token) {
        memoryTransactions.assertOwns(token);
      }
    }
  );
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
    id: "run-1", acquisitionRunId: "acquisition-run-1",
    workspaceId: "workspace-1", planId: "plan-1", planVersionId: "plan-version-1",
    planVersion: 1, planSnapshotHash: "plan-hash", policyVersionId: value.id,
    policyHash: value.policyHash, accountId: "account-1", accountLoginStateVersion: 7,
    dailyBudgetId: `sha256:${"d".repeat(64)}`, localDate: "2026-08-25", trigger: "run_now",
    collectCreators: true, collectDemandComments: true,
    status: "queued", reason: null, createdBy: "owner-1", createdAt: "2026-08-25T01:01:00.000Z"
  };
  const runCommand = {
    workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
    planVersionId: "plan-version-1", policyVersionId: value.id, accountId: "account-1",
    accountLoginStateVersion: 7, idempotencyKey: "run-key-1",
    requestHash: `sha256:${"e".repeat(64)}`, value: run,
    runBinding: bindingFor(run)
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
  const runReplay = [...pool.replays.values()].find((row) => row.result_kind === "run")!;
  (runReplay.response_json as DouyinAutomationRunIntent).acquisitionRunId = "wrong-run";
  await assert.rejects(
    repository.createRunIntent(runCommand),
    /acquisition_douyin_run_intent_binding_corrupt/u
  );
});

test("automation MySQL repository serializes identical new policy and run keys", async () => {
  const pool = new StatefulAutomationMysqlPool();
  const repository = new MysqlAcquisitionDouyinAutomationRepository(pool as never);
  const value = policyVersion();
  const policyCommand = {
    workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
    planVersionId: "plan-version-1", accountId: "account-1", accountLoginStateVersion: 7,
    expectedEtag: '"default"', defaultEtag: '"default"', idempotencyKey: "concurrent-policy-key",
    requestHash: `sha256:${"b".repeat(64)}`, value
  };
  const policyResults = await Promise.all([
    repository.savePolicy(policyCommand),
    repository.savePolicy(policyCommand)
  ]);
  assert.deepEqual(policyResults.map((result) => result.kind).sort(), ["created", "replay"]);
  assert.deepEqual(policyResults[0]?.value, policyResults[1]?.value);
  assert.equal(pool.versions.size, 1);

  const run: DouyinAutomationRunIntent = {
    id: "run-concurrent", acquisitionRunId: "acquisition-run-concurrent",
    workspaceId: "workspace-1", planId: "plan-1",
    planVersionId: "plan-version-1", planVersion: 1, planSnapshotHash: "plan-hash",
    policyVersionId: value.id, policyHash: value.policyHash, accountId: "account-1",
    accountLoginStateVersion: 7, dailyBudgetId: `sha256:${"d".repeat(64)}`,
    localDate: "2026-08-25", trigger: "run_now",
    collectCreators: true, collectDemandComments: true,
    status: "queued", reason: null,
    createdBy: "owner-1", createdAt: "2026-08-25T01:01:00.000Z"
  };
  const runCommand = {
    workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
    planVersionId: "plan-version-1", policyVersionId: value.id, accountId: "account-1",
    accountLoginStateVersion: 7, idempotencyKey: "concurrent-run-key",
    requestHash: `sha256:${"e".repeat(64)}`, value: run,
    runBinding: bindingFor(run)
  };
  const runResults = await Promise.all([
    repository.createRunIntent(runCommand),
    repository.createRunIntent(runCommand)
  ]);
  assert.deepEqual(runResults.map((result) => result.kind).sort(), ["created", "replay"]);
  assert.deepEqual(runResults[0]?.value, runResults[1]?.value);
  assert.equal(pool.runs.size, 1);
});

test("Memory and MySQL reject the same policy and run authority drift", async () => {
  for (const drift of ["plan", "account", "login"] as const) {
    const authority = authorityState();
    const memory = memoryRepository(authority);
    const pool = new StatefulAutomationMysqlPool();
    const mysqlRepository = new MysqlAcquisitionDouyinAutomationRepository(pool as never);
    const value = policyVersion();
    const policyCommand = {
      workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
      planVersionId: "plan-version-1", accountId: "account-1", accountLoginStateVersion: 7,
      expectedEtag: '"default"', defaultEtag: '"default"', idempotencyKey: `drift-${drift}`,
      requestHash: `sha256:${"f".repeat(64)}`, value
    };
    driftAuthority(authority, drift);
    if (drift === "plan") pool.planCurrentVersionId = "plan-version-changed";
    if (drift === "account") pool.accountState = "login_expired";
    if (drift === "login") pool.accountLoginStateVersion = 8;
    const [memoryPolicy, mysqlPolicy] = await Promise.all([
      memory.savePolicy(policyCommand),
      mysqlRepository.savePolicy(policyCommand)
    ]);
    assert.equal(memoryPolicy.kind, "binding_mismatch", `memory policy ${drift}`);
    assert.equal(mysqlPolicy.kind, memoryPolicy.kind, `mysql policy ${drift}`);
    assert.equal(pool.versions.size, 0, drift);

    const runAuthority = authorityState();
    const runMemory = memoryRepository(runAuthority);
    const runPool = new StatefulAutomationMysqlPool();
    const runMysql = new MysqlAcquisitionDouyinAutomationRepository(runPool as never);
    const seedCommand = { ...policyCommand, idempotencyKey: `seed-run-${drift}` };
    assert.equal((await runMemory.savePolicy(seedCommand)).kind, "created");
    assert.equal((await runMysql.savePolicy(seedCommand)).kind, "created");
    driftAuthority(runAuthority, drift);
    if (drift === "plan") runPool.planCurrentVersionId = "plan-version-changed";
    if (drift === "account") runPool.accountState = "login_expired";
    if (drift === "login") runPool.accountLoginStateVersion = 8;
    const run: DouyinAutomationRunIntent = {
      id: `run-drift-${drift}`,
      acquisitionRunId: `acquisition-run-drift-${drift}`,
      workspaceId: "workspace-1", planId: "plan-1",
      planVersionId: "plan-version-1", planVersion: 1, planSnapshotHash: "plan-hash",
      policyVersionId: value.id, policyHash: value.policyHash, accountId: "account-1",
      accountLoginStateVersion: 7, dailyBudgetId: `sha256:${"d".repeat(64)}`,
      localDate: "2026-08-25", trigger: "run_now",
      collectCreators: true, collectDemandComments: true,
      status: "queued", reason: null,
      createdBy: "owner-1", createdAt: "2026-08-25T01:01:00.000Z"
    };
    const runCommand = {
      workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
      planVersionId: "plan-version-1", policyVersionId: value.id, accountId: "account-1",
      accountLoginStateVersion: 7, idempotencyKey: `run-drift-${drift}`,
      requestHash: `sha256:${"e".repeat(64)}`, value: run,
      runBinding: bindingFor(run)
    };
    const [memoryRun, mysqlRun] = await Promise.all([
      runMemory.createRunIntent(runCommand),
      runMysql.createRunIntent(runCommand)
    ]);
    assert.equal(memoryRun.kind, "binding_mismatch", `memory run ${drift}`);
    assert.equal(mysqlRun.kind, memoryRun.kind, `mysql run ${drift}`);
    assert.equal(runPool.runs.size, 0, drift);
  }
});

test("live MySQL serializes identical new policy and run keys into exact replay", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const configured = process.env.MYSQL_TEST_ADMIN_URL!;
  const adminUrl = new URL(configured);
  const databaseName = `goodjob_douyin_automation_${randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection(adminUrl.toString());
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  await admin.query(
    `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  const pool = mysql.createPool({ uri: databaseUrl.toString(), connectionLimit: 4 });
  try {
    await ensureAcquisitionMysqlSchema(pool);
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    await ensureAcquisitionDouyinAutomationMysqlSchema(pool);
    const { plan, version: planVersion } = frozenPlan();
    await pool.query(
      `INSERT INTO acquisition_plans
       (id,owner_id,team_id,revision,payload_json,created_at,updated_at)
       VALUES (?,?,?,?,?,NOW(3),NOW(3))`,
      [plan.id, plan.ownerId, plan.teamId, 1, JSON.stringify(plan)]
    );
    await pool.query(
      `INSERT INTO acquisition_plan_versions
       (id,plan_id,owner_id,team_id,version_no,payload_json,created_at)
       VALUES (?,?,?,?,?,?,NOW(3))`,
      [planVersion.id, planVersion.planId, planVersion.ownerId,
        planVersion.teamId, 1, JSON.stringify(planVersion)]
    );
    await pool.query(
      `INSERT INTO acquisition_social_accounts
       (id,workspace_id,platform,account_handle,display_name,state,
        login_state_version,revision,etag,last_validated_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,1,?,?,?,?)`,
      ["account-1", "workspace-1", "douyin", "private", "Douyin", 7,
        '"account-v1"', "2026-08-25T01:00:00.000Z",
        "2026-08-25T01:00:00.000Z", "2026-08-25T01:00:00.000Z"]
    );

    const repository = new MysqlAcquisitionDouyinAutomationRepository(pool);
    const value = policyVersion();
    const policyCommand = {
      workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
      planVersionId: "plan-version-1", accountId: "account-1", accountLoginStateVersion: 7,
      expectedEtag: '"default"', defaultEtag: '"default"', idempotencyKey: "live-policy-key",
      requestHash: `sha256:${"b".repeat(64)}`, value
    };
    const policyResults = await Promise.all([
      repository.savePolicy(policyCommand), repository.savePolicy(policyCommand)
    ]);
    assert.deepEqual(policyResults.map((result) => result.kind).sort(), ["created", "replay"]);
    assert.deepEqual(policyResults[0]?.value, policyResults[1]?.value);

    const run: DouyinAutomationRunIntent = {
      id: "run-live", acquisitionRunId: "acquisition-run-live",
      workspaceId: "workspace-1", planId: "plan-1",
      planVersionId: "plan-version-1", planVersion: 1, planSnapshotHash: "plan-hash",
      policyVersionId: value.id, policyHash: value.policyHash, accountId: "account-1",
      accountLoginStateVersion: 7, dailyBudgetId: `sha256:${"d".repeat(64)}`,
      localDate: "2026-08-25", trigger: "run_now",
      collectCreators: true, collectDemandComments: true,
      status: "queued", reason: null,
      createdBy: "owner-1", createdAt: "2026-08-25T01:01:00.000Z"
    };
    const runCommand = {
      workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", planId: "plan-1",
      planVersionId: "plan-version-1", policyVersionId: value.id, accountId: "account-1",
      accountLoginStateVersion: 7, idempotencyKey: "live-run-key",
      requestHash: `sha256:${"e".repeat(64)}`, value: run,
      runBinding: bindingFor(run)
    };
    const runResults = await Promise.all([
      repository.createRunIntent(runCommand), repository.createRunIntent(runCommand)
    ]);
    assert.deepEqual(runResults.map((result) => result.kind).sort(), ["created", "replay"]);
    assert.deepEqual(runResults[0]?.value, runResults[1]?.value);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
