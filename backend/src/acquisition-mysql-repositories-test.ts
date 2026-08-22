import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import {
  ACQUISITION_MYSQL_SCHEMA_STATEMENTS,
  ACQUISITION_EVIDENCE_ID_SQL_WIDTH,
  MysqlAcquisitionCopilotRepository,
  MysqlAcquisitionDomainRepository,
  MysqlAcquisitionPlanRunRepository,
  ensureAcquisitionMysqlSchema
} from "./acquisition-mysql-repositories.js";
import type {
  AcquisitionAuditEvent,
  AcquisitionCandidate,
  DiscoveryEvidence,
  FinancialValueDecision,
  LeadConversionIntent,
  QualificationDecision
} from "./acquisition-domain.js";
import type {
  AcquisitionCopilotMessage,
  AcquisitionCopilotSession,
  AcquisitionCopilotTask
} from "./acquisition-copilot-service.js";
import type {
  AcquisitionOperationShard,
  AcquisitionPlan,
  AcquisitionPlanVersion,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";

type QueryResult = [unknown, unknown];

class FakeConnection {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly queue: QueryResult[] = [];
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  releaseCount = 0;
  destroyCount = 0;
  failSqlPattern: RegExp | null = null;
  releaseLockResult: number | null = 1;

  enqueue(result: unknown) {
    this.queue.push([result, []]);
  }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    if (this.failSqlPattern?.test(sql)) {
      throw new Error("scripted-query-failure-with-sensitive-comment");
    }
    if (/RELEASE_LOCK/i.test(sql)) {
      return [[{ lock_released: this.releaseLockResult }], []];
    }
    return this.queue.shift() ?? [{ affectedRows: 1 }, []];
  }

  async beginTransaction() {
    this.beginCount += 1;
  }

  async commit() {
    this.commitCount += 1;
  }

  async rollback() {
    this.rollbackCount += 1;
  }

  release() {
    this.releaseCount += 1;
  }

  destroy() {
    this.destroyCount += 1;
  }
}

class FakePool extends FakeConnection {
  readonly connection = new FakeConnection();

  async getConnection() {
    return this.connection;
  }
}

function asPool(value: FakePool) {
  return value as unknown as mysql.Pool;
}

const NOW = "2026-07-24T08:00:00.000Z";

function candidate(overrides: Partial<AcquisitionCandidate> = {}): AcquisitionCandidate {
  return {
    id: "candidate-1",
    ownerId: "owner-a",
    teamId: "team-a",
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: "org-1",
      tenantProspectId: "prospect-1"
    },
    profile: {
      kind: "organization",
      name: "Example",
      domain: "example.cn",
      region: "CN",
      creditCode: null
    },
    evidenceIds: ["evidence-1"],
    status: "normalized",
    latestDecisionId: null,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides
  };
}

function evidence(): DiscoveryEvidence {
  return {
    id: "evidence-1",
    ownerId: "owner-a",
    teamId: "team-a",
    targetType: "organization",
    sourcePlatform: "baidu",
    sourceTitle: "Example",
    sourceSnippet: "公开商机",
    publishedAt: null,
    locale: "zh-CN",
    rawArtifactHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    provenance: {
      kind: "search_result",
      provider: "baidu",
      queryText: "采购需求",
      sourceUrl: "https://example.cn",
      resultRank: 1
    },
    accessStatus: "indexed_summary",
    supersedesEvidenceId: null,
    fetchedAt: NOW
  };
}

function qualification(): QualificationDecision {
  return {
    id: "qualification-1",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    decisionVersion: "qualification-v1",
    decisionEngine: "rules",
    grade: "A",
    score: 88,
    recommendedAction: "priority_review",
    evidence: [],
    positiveSignals: [],
    negativeSignals: [],
    reasons: ["公开需求明确"],
    confidence: 0.9,
    ruleVersion: "rules-v1",
    promptVersion: null,
    modelProvider: null,
    model: null,
    hardGateFailures: [],
    snapshotHash: "sha256:qualification",
    createdAt: NOW
  };
}

function financial(): FinancialValueDecision {
  return {
    id: "financial-1",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    qualificationDecisionId: "qualification-1",
    version: "financial-v1",
    grade: "A",
    score: 82,
    currency: "CNY",
    expectedRevenueMinor: 100_000,
    expectedGrossProfitMinor: 50_000,
    expectedContributionMinor: 25_000,
    factors: {
      profitability: 0.8,
      cashFlow: 0.8,
      creditQuality: 0.8,
      repeatPotential: 0.7,
      referralPotential: 0.6,
      closeProbability: 0.8
    },
    inputSnapshotHash: "sha256:financial",
    createdAt: NOW
  };
}

function domainAudit(): AcquisitionAuditEvent {
  return {
    id: "audit-1",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    actorId: "actor-a",
    eventType: "candidate_updated",
    fromStatus: "normalized",
    toStatus: "qualified",
    resourceId: "candidate-1",
    idempotencyKey: "audit-key-1",
    payloadHash: "sha256:audit",
    createdAt: "2026-07-24T08:01:00.000Z"
  };
}

function session(): AcquisitionCopilotSession {
  return {
    id: "session-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-1",
    status: "active",
    modelSnapshot: {
      jobId: "job-1",
      connectionId: "connection-1",
      credentialVersion: 2,
      provider: "moonshot",
      model: "kimi-k2",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      promptHash: "sha256:prompt-v1",
      schemaHash: "sha256:schema-v1",
      capabilitySnapshotHash: "c".repeat(64),
      baseUrlFingerprint: "d".repeat(64)
    },
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  };
}

function task(): AcquisitionCopilotTask {
  return {
    id: "task-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-1",
    sessionId: "session-1",
    kind: "message",
    status: "queued",
    prompt: "查找中国市场公开商机",
    result: null,
    errorCode: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null
  };
}

function plan(): AcquisitionPlan {
  const budgetSnapshot = {
    maxRequests: 20,
    maxResults: 100,
    maxAmountMinor: 10_000,
    maxDurationSeconds: 300,
    billingCurrency: "CNY"
  };
  const modelSnapshotRef = {
    jobSnapshotId: "job-1",
    connectionId: "model-connection-1",
    credentialVersion: 2,
    provider: "moonshot",
    model: "kimi-k2",
    capabilitySnapshotHash: "c".repeat(64),
    promptVersion: "prompt-v1",
    promptHash: "e".repeat(64),
    schemaHash: "f".repeat(64),
    schemaVersion: "acquisition-plan.v1"
  };
  return {
    id: "plan-1",
    ownerId: "owner-a",
    teamId: "team-a",
    status: "draft",
    version: 1,
    revision: 1,
    etag: "\"plan-1:1\"",
    currentVersionId: "plan-version-1",
    approvedVersionId: null,
    approvedSnapshotHash: null,
    approvedBy: null,
    approvedAt: null,
    budgetSnapshot,
    payload: {
      name: "中国公开商机",
      objective: "发现组织与个人需求线索",
      icp: {
        industries: ["通用"],
        regions: ["中国"],
        organizationCriteria: ["公开采购需求"],
        individualCriteria: ["公开表达需求"],
        exclusionRules: ["拒绝联系"]
      },
      subjectChannels: {
        organization: true,
        individual: true
      },
      providerConnections: [],
      operations: [],
      budgetSnapshot,
      modelSnapshotRef,
      stopConditions: {
        stopWhenBudgetExhausted: true,
        stopWhenNoMoreResults: true
      }
    },
    createdBy: "user-1",
    createdAt: NOW,
    updatedBy: "user-1",
    updatedAt: NOW
  };
}

function planVersion(): AcquisitionPlanVersion {
  const value = plan();
  return {
    id: value.currentVersionId,
    planId: value.id,
    ownerId: value.ownerId,
    teamId: value.teamId,
    version: value.version,
    payload: structuredClone(value.payload),
    payloadHash: "1".repeat(64),
    createdBy: value.createdBy,
    createdAt: value.createdAt
  };
}

function acquisitionRun(): AcquisitionRun {
  const value = plan();
  return {
    id: "run-1",
    ownerId: value.ownerId,
    teamId: value.teamId,
    planId: value.id,
    planVersionId: value.currentVersionId,
    planVersion: value.version,
    planSnapshotHash: "2".repeat(64),
    parentRunId: null,
    status: "queued",
    terminationIntent: null,
    revision: 1,
    etag: "\"run-1:1\"",
    budgetSnapshotId: "budget-1",
    budgetSnapshot: structuredClone(value.budgetSnapshot),
    budgetSnapshotHash: "3".repeat(64),
    billingCurrency: "CNY",
    modelSnapshotRef: structuredClone(value.payload.modelSnapshotRef),
    consumedBudget: {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    },
    evidenceCount: 0,
    reason: null,
    createdBy: "user-1",
    createdAt: NOW,
    updatedBy: "user-1",
    updatedAt: NOW,
    completedAt: null
  };
}

async function testSchemaIsCompleteAndHasNoSecretColumns() {
  const sql = ACQUISITION_MYSQL_SCHEMA_STATEMENTS.join("\n").toLowerCase();
  for (const table of [
    "acquisition_discovery_evidence",
    "acquisition_candidates",
    "acquisition_candidate_identity_aliases",
    "acquisition_qualification_decisions",
    "acquisition_financial_values",
    "acquisition_battle_cards",
    "acquisition_review_events",
    "acquisition_research_attempts",
    "acquisition_conversion_intents",
    "acquisition_conversions",
    "acquisition_outcomes",
    "acquisition_domain_audit_events",
    "acquisition_domain_idempotency",
    "acquisition_copilot_sessions",
    "acquisition_copilot_tasks",
    "acquisition_copilot_messages",
    "acquisition_copilot_idempotency",
    "acquisition_plans",
    "acquisition_plan_versions",
    "acquisition_runs",
    "acquisition_operation_shards",
    "acquisition_plan_events",
    "acquisition_run_events",
    "acquisition_plan_run_audit_events",
    "acquisition_run_idempotency",
    "acquisition_usage_idempotency",
    "acquisition_execution_intents"
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
  }
  assert.doesNotMatch(sql, /\b(api_key|secret_key|access_token)\b/);
  assert.match(sql, /unique key uk_acquisition_candidate_scope/);
  assert.match(
    sql,
    /primary key \(owner_id, team_id, dedupe_key_hash\)/
  );
  assert.match(
    sql,
    /unique key uk_acquisition_conversion_intent_candidate\s+\(owner_id, team_id, candidate_id\)/
  );
  assert.match(
    sql,
    /status in \('pending_crm','crm_committed','completed'\)/
  );
  assert.match(sql, /unique key uk_acquisition_copilot_message_sequence/);
  assert.match(sql, /unique key uk_acquisition_domain_idempotency/);
  const longestVisualEvidenceId = `visual:${"o".repeat(160)}`
    + `:evidence:sha256:${"a".repeat(64)}`;
  assert.equal(longestVisualEvidenceId.length, 248);
  assert.match(
    sql,
    /acquisition_discovery_evidence \(\s*id varchar\(255\) primary key/u
  );
  assert.match(
    sql,
    /alter table acquisition_discovery_evidence\s+modify column id varchar\(255\) not null/u
  );
  assert.doesNotMatch(sql, /evidence_id varchar\(120\)/u);
  assert.equal(ACQUISITION_EVIDENCE_ID_SQL_WIDTH, 255);
  assert.match(
    sql,
    /create table if not exists acquisition_run_idempotency \(\s*scope_key_hash char\(64\) primary key/
  );
  assert.match(
    sql,
    /create table if not exists acquisition_usage_idempotency \(\s*scope_key_hash char\(64\) primary key/
  );
  assert.match(
    sql,
    /constraint fk_acquisition_qualification_candidate\s+foreign key \(owner_id, team_id, candidate_id\)/
  );
  assert.match(
    sql,
    /constraint fk_acquisition_copilot_message_session\s+foreign key \(owner_id, team_id, session_id\)/
  );
  assert.match(
    sql,
    /constraint fk_acquisition_shard_run\s+foreign key \(owner_id, team_id, run_id\)/
  );
  assert.match(sql, /dispatch_lease_until datetime\(3\) null/);
  assert.match(sql, /dispatch_attempts bigint unsigned not null default 0/);
  assert.match(
    sql,
    /constraint fk_acquisition_run_plan_version\s+foreign key \(owner_id, team_id, plan_id, plan_version_id\)/
  );
}

async function testEnsureSchemaExecutesEveryStatement() {
  const pool = new FakePool();
  await ensureAcquisitionMysqlSchema(asPool(pool));
  assert.equal(pool.calls.length, ACQUISITION_MYSQL_SCHEMA_STATEMENTS.length);
}

async function testDomainQueriesAlwaysUseOwnerAndTeam() {
  const pool = new FakePool();
  pool.enqueue([{
    id: "candidate-1",
    owner_id: "owner-a",
    team_id: "team-a",
    version: 1,
    payload_json: JSON.stringify(candidate())
  }]);
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  assert.deepEqual(
    await repository.findCandidate(
      { ownerId: "owner-a", teamId: "team-a" },
      "candidate-1"
    ),
    candidate()
  );
  const call = pool.calls.at(-1)!;
  assert.match(call.sql, /owner_id = \? AND team_id = \?/);
  assert.deepEqual(call.values, ["candidate-1", "owner-a", "team-a"]);
}

async function testDomainRejectsCorruptOrCrossTenantJson() {
  const pool = new FakePool();
  pool.enqueue([{
    id: "candidate-1",
    owner_id: "owner-a",
    team_id: "team-a",
    version: 1,
    payload_json: JSON.stringify(candidate({ teamId: "team-b" }))
  }]);
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  await assert.rejects(
    () => repository.findCandidate(
      { ownerId: "owner-a", teamId: "team-a" },
      "candidate-1"
    ),
    /integrity/i
  );
}

async function testCandidateRejectsJsonVersionThatDiffersFromLockColumn() {
  const pool = new FakePool();
  pool.enqueue([{
    id: "candidate-1",
    owner_id: "owner-a",
    team_id: "team-a",
    version: 7,
    payload_json: JSON.stringify(candidate({ version: 6 }))
  }]);
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  await assert.rejects(
    () => repository.findCandidate(
      { ownerId: "owner-a", teamId: "team-a" },
      "candidate-1"
    ),
    /version_mismatch/
  );
}

async function testCandidateSaveUsesOptimisticVersionAndScope() {
  const pool = new FakePool();
  pool.enqueue({ affectedRows: 1 });
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  await repository.saveCandidate(candidate({ version: 2 }));
  const call = pool.calls.at(-1)!;
  assert.match(
    call.sql,
    /WHERE id = \? AND owner_id = \? AND team_id = \? AND version = \?/
  );
  assert.deepEqual(call.values.slice(-4), [
    "candidate-1",
    "owner-a",
    "team-a",
    1
  ]);

  const conflictPool = new FakePool();
  conflictPool.enqueue({ affectedRows: 0 });
  await assert.rejects(
    () => new MysqlAcquisitionDomainRepository(asPool(conflictPool))
      .saveCandidate(candidate({ version: 2 })),
    /CANDIDATE_VERSION_CONFLICT/
  );
}

async function testIdentityAliasesAreScopedHashedAndSerialized() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  const dedupeKey = "organization:domain:example.cn";

  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{ lock_released: 1 }]);

  await repository.transaction(() =>
    repository.bindCandidateIdentityAliases([{
      ownerId: "owner-a",
      teamId: "team-a",
      candidateId: "candidate-1",
      partyType: "organization",
      basis: "organization_domain",
      dedupeKey,
      createdAt: NOW
    }])
  );

  const lock = pool.connection.calls.find((call) =>
    /GET_LOCK/u.test(call.sql)
  );
  const insert = pool.connection.calls.find((call) =>
    /INSERT INTO acquisition_candidate_identity_aliases/u.test(call.sql)
  );
  assert.ok(lock);
  assert.ok(insert);
  assert.equal(
    insert.values.includes(dedupeKey),
    false,
    "raw identity keys must not be persisted"
  );
  assert.ok(
    insert.values.includes(
      createHash("sha256").update(dedupeKey).digest("hex")
    )
  );
  assert.equal(pool.connection.beginCount, 1);
  assert.equal(pool.connection.commitCount, 1);
  assert.equal(pool.connection.releaseCount, 1);

  pool.enqueue([{
    candidate_id: "candidate-1",
    party_type: "organization",
    basis: "organization_domain",
    created_at: NOW
  }]);
  const found = await repository.findCandidateIdentityAlias(
    { ownerId: "owner-a", teamId: "team-a" },
    dedupeKey
  );
  assert.equal(found?.candidateId, "candidate-1");
  const lookup = pool.calls.at(-1)!;
  assert.deepEqual(lookup.values, [
    "owner-a",
    "team-a",
    createHash("sha256").update(dedupeKey).digest("hex")
  ]);
}

async function testIdentityAliasReleaseFailureDestroysSession() {
  for (const releaseFailure of ["query", "invalid_result"] as const) {
    const pool = new FakePool();
    const connection = pool.connection;
    const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
    connection.enqueue([{ lock_acquired: 1 }]);
    connection.enqueue([]);
    connection.enqueue([]);
    if (releaseFailure === "query") {
      connection.failSqlPattern = /RELEASE_LOCK/i;
    } else {
      connection.releaseLockResult = 0;
    }

    await assert.rejects(
      repository.transaction(() => repository.bindCandidateIdentityAliases([{
        ownerId: "owner-a",
        teamId: "team-a",
        candidateId: "candidate-1",
        partyType: "organization",
        basis: "organization_domain",
        dedupeKey: `organization:${releaseFailure}.example`,
        createdAt: NOW
      }])),
      /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
    );
    assert.equal(connection.commitCount, 1);
    assert.equal(connection.rollbackCount, 0);
    assert.equal(connection.releaseCount, 0);
    assert.equal(connection.destroyCount, 1);
  }
}

async function testAppendEvidenceUsesInsertOnly() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  await repository.appendEvidence(evidence());
  assert.match(pool.calls.at(-1)!.sql, /^INSERT INTO acquisition_discovery_evidence/);
  assert.doesNotMatch(pool.calls.at(-1)!.sql, /UPDATE|ON DUPLICATE/i);
  const storedPayload = JSON.parse(String(pool.calls.at(-1)!.values.at(-2)));
  assert.deepEqual(storedPayload, evidence());
  assert.equal("createdAt" in storedPayload, false);
}

async function testDomainTransactionUsesOneConnectionAndRollsBackAtomically() {
  const committedPool = new FakePool();
  const committedRepository = new MysqlAcquisitionDomainRepository(
    asPool(committedPool)
  );
  await committedRepository.transaction(async () => {
    await committedRepository.appendEvidence(evidence());
  });
  assert.equal(committedPool.connection.beginCount, 1);
  assert.equal(committedPool.connection.commitCount, 1);
  assert.equal(committedPool.connection.rollbackCount, 0);
  assert.ok(committedPool.connection.calls.some((call) =>
    call.sql.startsWith("INSERT INTO acquisition_discovery_evidence")
  ));
  assert.equal(
    committedPool.calls.some((call) =>
      call.sql.startsWith("INSERT INTO acquisition_discovery_evidence")
    ),
    false,
    "transactional domain writes must use the leased connection"
  );

  const rolledBackPool = new FakePool();
  const rolledBackRepository = new MysqlAcquisitionDomainRepository(
    asPool(rolledBackPool)
  );
  await assert.rejects(
    rolledBackRepository.transaction(async () => {
      await rolledBackRepository.appendEvidence(evidence());
      throw new Error("simulated domain transaction failure");
    }),
    /simulated domain transaction failure/
  );
  assert.equal(rolledBackPool.connection.commitCount, 0);
  assert.equal(rolledBackPool.connection.rollbackCount, 1);
  assert.equal(rolledBackPool.connection.releaseCount, 1);
}

async function testRawIdempotencyKeysAreNotPersisted() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  const rawKey = "customer-request-123456";
  await repository.appendReviewEvent({
    id: "review-1",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    decisionVersion: "decision-v1",
    action: "approved",
    reason: "证据充分",
    reviewerId: "user-1",
    idempotencyKey: rawKey,
    createdAt: NOW
  });
  const payload = String(pool.calls.at(-1)!.values.at(-2));
  assert.doesNotMatch(payload, new RegExp(rawKey));
  assert.match(payload, /"idempotencyKey":"sha256:[a-f0-9]{64}"/);
}

async function testDomainIdempotencyRestoresTheRequestKeyOnReplay() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  const rawKey = "customer-request-654321";
  const review = {
    id: "review-2",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    decisionVersion: "decision-v1",
    action: "approved" as const,
    reason: null,
    reviewerId: "user-1",
    idempotencyKey: rawKey,
    createdAt: NOW
  };
  const record = {
    ownerId: "owner-a",
    teamId: "team-a",
    operation: "review_candidate",
    idempotencyKey: rawKey,
    requestHash: "5".repeat(64),
    result: { review },
    createdAt: NOW
  };
  await repository.appendIdempotency(record);
  const payload = String(pool.calls.at(-1)!.values.at(-2));
  pool.enqueue([{
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: payload
  }]);
  assert.deepEqual(
    await repository.findIdempotency(
      { ownerId: "owner-a", teamId: "team-a" },
      "review_candidate",
      rawKey
    ),
    record
  );
}

async function testCopilotPersistenceIsScopedAndMessageOrderIsDurable() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));
  await repository.insertSession(session());
  await repository.insertTask(task());
  const messages: AcquisitionCopilotMessage[] = [
    {
      id: "message-1",
      ownerId: "owner-a",
      teamId: "team-a",
      sessionId: "session-1",
      sequence: 1,
      message: {
        role: "user",
        content: "查找中国市场公开商机",
        timestamp: 1
      },
      createdAt: NOW
    }
  ];
  pool.connection.enqueue([{ id: "session-1" }]);
  pool.connection.enqueue([{ max_sequence: 5 }]);
  pool.connection.enqueue({ affectedRows: 1 });
  await repository.appendMessages(messages);
  const insert = pool.connection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_copilot_messages")
  );
  assert.ok(insert);
  assert.doesNotMatch(JSON.stringify(insert.values), /api[_-]?key/i);
  assert.equal(insert.values[4], 6);
  const storedMessage = JSON.parse(String(insert.values[5]));
  assert.equal(storedMessage.sequence, 6);
  assert.equal(pool.connection.beginCount, 1);
  assert.equal(pool.connection.commitCount, 1);
  assert.ok(pool.connection.calls.some((call) =>
    /FROM acquisition_copilot_sessions/.test(call.sql)
    && /owner_id = \? AND team_id = \?/.test(call.sql)
    && /FOR UPDATE/.test(call.sql)
  ));

  pool.enqueue([{
    id: "message-1",
    owner_id: "owner-a",
    team_id: "team-a",
    session_id: "session-1",
    sequence_no: 1,
    payload_json: JSON.stringify(messages[0])
  }]);
  assert.deepEqual(
    await repository.listMessages(
      { ownerId: "owner-a", teamId: "team-a" },
      "session-1"
    ),
    messages
  );
  const list = pool.calls.at(-1)!;
  assert.match(list.sql, /owner_id = \? AND team_id = \?/);
  assert.match(list.sql, /ORDER BY sequence_no, id/);
}

async function testCopilotClaimIsAtomicAndScoped() {
  const pool = new FakePool();
  const connection = pool.connection;
  const queuedTask = task();
  connection.enqueue([{
    id: queuedTask.id,
    owner_id: queuedTask.ownerId,
    team_id: queuedTask.teamId,
    payload_json: JSON.stringify(queuedTask)
  }]);
  connection.enqueue([{ id: "session-1" }]);
  connection.enqueue([]);
  connection.enqueue({ affectedRows: 1 });
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));
  assert.equal(
    await repository.claimTaskDispatch(
      { ownerId: "owner-a", teamId: "team-a" },
      "task-1"
    ),
    true
  );
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 1);
  const targetLock = connection.calls[0]!;
  assert.match(targetLock.sql, /FROM acquisition_copilot_tasks/);
  assert.match(targetLock.sql, /owner_id = \? AND team_id = \?/);
  assert.match(targetLock.sql, /status = 'queued'/);
  assert.match(targetLock.sql, /FOR UPDATE/);
  const sessionLock = connection.calls[1]!;
  assert.match(sessionLock.sql, /FROM acquisition_copilot_sessions/);
  assert.match(sessionLock.sql, /FOR UPDATE/);
  const runningCheck = connection.calls[2]!;
  assert.match(runningCheck.sql, /status = 'running'/);
  assert.match(runningCheck.sql, /session_id = \?/);
  const update = connection.calls[3]!;
  assert.match(update.sql, /^UPDATE acquisition_copilot_tasks/);
  assert.match(update.sql, /SET status = 'running'/);
  assert.match(update.sql, /payload_json = \?/);
  assert.match(update.sql, /owner_id = \? AND team_id = \?/);
  assert.match(update.sql, /status = 'queued'/);
  assert.match(update.sql, /dispatch_attempts = dispatch_attempts \+ 1/);
  const stored = JSON.parse(String(update.values[0]));
  assert.equal(stored.status, "running");
  assert.equal(typeof stored.startedAt, "string");
  assert.equal(
    update.values[1],
    stored.startedAt.replace("T", " ").replace("Z", "")
  );
}

async function testCopilotClaimRejectsAnotherRunningTaskInTheSession() {
  const pool = new FakePool();
  const connection = pool.connection;
  const queuedTask = task();
  connection.enqueue([{
    id: queuedTask.id,
    owner_id: queuedTask.ownerId,
    team_id: queuedTask.teamId,
    payload_json: JSON.stringify(queuedTask)
  }]);
  connection.enqueue([{ id: "session-1" }]);
  connection.enqueue([{ id: "task-running" }]);
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));

  assert.equal(
    await repository.claimTaskDispatch(
      { ownerId: "owner-a", teamId: "team-a" },
      "task-1"
    ),
    false
  );
  assert.equal(
    connection.calls.some((call) =>
      call.sql.startsWith("UPDATE acquisition_copilot_tasks")
    ),
    false
  );
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 1);
}

async function testCopilotTransactionUsesOneConnectionAndRollsBackAtomically() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));
  const failure = new Error("SIMULATED_COPILOT_CRASH");
  await assert.rejects(
    () => repository.transaction(async () => {
      await repository.insertSession(session());
      throw failure;
    }),
    failure
  );
  assert.equal(pool.connection.beginCount, 1);
  assert.equal(pool.connection.commitCount, 0);
  assert.equal(pool.connection.rollbackCount, 1);
  assert.equal(pool.connection.releaseCount, 1);
  assert.equal(
    pool.connection.calls.some((call) =>
      call.sql.startsWith("INSERT INTO acquisition_copilot_sessions")
    ),
    true,
    "copilot writes must share the transaction connection"
  );
  assert.equal(
    pool.calls.some((call) =>
      call.sql.startsWith("INSERT INTO acquisition_copilot_sessions")
    ),
    false,
    "copilot writes must not escape to the pool during a transaction"
  );
}

async function testPlaintextCredentialFieldsAreRejected() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));
  const unsafe = {
    ...session(),
    modelSnapshot: {
      ...session().modelSnapshot,
      clientSecret: "plaintext-must-not-be-stored"
    }
  } as AcquisitionCopilotSession;
  await assert.rejects(
    () => repository.insertSession(unsafe),
    /PLAINTEXT_SECRET_REJECTED/
  );
  assert.equal(pool.calls.length, 0);
}

async function testTaskStateUpdateUsesExpectedPreviousState() {
  const pool = new FakePool();
  pool.enqueue({ affectedRows: 1 });
  const repository = new MysqlAcquisitionCopilotRepository(asPool(pool));
  await repository.saveTask({
    ...task(),
    status: "running",
    startedAt: NOW
  });
  const call = pool.calls.at(-1)!;
  assert.match(call.sql, /AND status IN \('queued'\)/);
  assert.deepEqual(call.values.slice(-5), [
    "task-1",
    "owner-a",
    "team-a",
    "user-1",
    "session-1"
  ]);
}

async function testRunPersistsImmutableSnapshotColumnsAfterVersion() {
  const pool = new FakePool();
  const connection = pool.connection;
  connection.enqueue([{ id: 1 }]);
  for (let index = 0; index < 10; index += 1) {
    connection.enqueue([]);
  }
  const repository = new MysqlAcquisitionPlanRunRepository(asPool(pool));
  await repository.transaction((transaction) => {
    transaction.putPlan(plan());
    transaction.appendPlanVersion(planVersion());
    transaction.putRun(acquisitionRun());
  });
  const versionIndex = connection.calls.findIndex((call) =>
    call.sql.startsWith("INSERT INTO acquisition_plan_versions")
  );
  const runIndex = connection.calls.findIndex((call) =>
    call.sql.startsWith("INSERT INTO acquisition_runs")
  );
  assert.ok(versionIndex >= 0);
  assert.ok(runIndex > versionIndex);
  const insert = connection.calls[runIndex]!;
  assert.match(
    insert.sql,
    /\(id, plan_id, plan_version_id, owner_id, team_id, revision,\s*plan_snapshot_hash, budget_snapshot_hash, payload_json/
  );
  assert.deepEqual(insert.values.slice(0, 8), [
    "run-1",
    "plan-1",
    "plan-version-1",
    "owner-a",
    "team-a",
    1,
    "2".repeat(64),
    "3".repeat(64)
  ]);
}

async function testRunListQueryPushesFilteringOrderingAndLimitIntoSql() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionPlanRunRepository(asPool(pool));
  pool.enqueue([]);
  await repository.listRuns({ ownerId: "owner-a", teamId: "team-a" });
  const unfiltered = pool.calls.at(-1)!;
  assert.doesNotMatch(unfiltered.sql, /acquisition_plan_versions/u);
  assert.match(unfiltered.sql, /ORDER BY updated_at DESC, id DESC/u);

  const run = acquisitionRun();
  pool.enqueue([{
    id: run.id,
    owner_id: run.ownerId,
    team_id: run.teamId,
    payload_json: JSON.stringify(run)
  }]);
  const selected = await repository.listRuns(
    { ownerId: "owner-a", teamId: "team-a" },
    {
      targetPlatform: "douyin",
      createdAtOnOrBefore: "2026-08-07T23:59:59.999Z",
      orderBy: "created_at_desc",
      limit: 3
    }
  );

  assert.deepEqual(selected, [run]);
  const filtered = pool.calls.at(-1)!;
  assert.match(
    filtered.sql,
    /INNER JOIN acquisition_plan_versions v/u
  );
  assert.match(
    filtered.sql,
    /JSON_EXTRACT\(v\.payload_json, '\$\.payload\.targetPlatform'\)/u
  );
  assert.match(filtered.sql, /r\.created_at <= \?/u);
  assert.match(filtered.sql, /ORDER BY r\.created_at DESC, r\.id DESC/u);
  assert.match(filtered.sql, /LIMIT \?/u);
  assert.deepEqual(filtered.values, [
    "owner-a",
    "team-a",
    "douyin",
    "2026-08-07 23:59:59.999",
    3
  ]);
}

async function testPlanRunIdempotencyScopesAreHashedAtRest() {
  const pool = new FakePool();
  const connection = pool.connection;
  connection.enqueue([{ id: 1 }]);
  for (let index = 0; index < 10; index += 1) {
    connection.enqueue([]);
  }
  const rawScopeKey = "team-a\u001fowner-a\u001fcreate_run\u001frequest-123";
  const repository = new MysqlAcquisitionPlanRunRepository(asPool(pool));
  await repository.transaction((transaction) => {
    transaction.putIdempotency({
      scopeKey: rawScopeKey,
      requestHash: "4".repeat(64),
      resultType: "run",
      resultId: "run-1",
      createdAt: NOW
    });
    assert.equal(transaction.getIdempotency(rawScopeKey)?.resultId, "run-1");
  });
  const insert = connection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_run_idempotency")
  );
  assert.ok(insert);
  assert.doesNotMatch(String(insert.values[3]), new RegExp(rawScopeKey));
  assert.match(
    String(insert.values[3]),
    /"scopeKey":"sha256:[a-f0-9]{64}"/
  );
  assert.equal(
    String(insert.values[3]).includes("request-123"),
    false
  );

  const planPool = new FakePool();
  const planConnection = planPool.connection;
  planConnection.enqueue([{ id: 1 }]);
  for (let index = 0; index < 10; index += 1) {
    planConnection.enqueue([]);
  }
  const planRepository = new MysqlAcquisitionPlanRunRepository(
    asPool(planPool)
  );
  const rawPlanScopeKey =
    "team-a\u001fowner-a\u001fcreate_plan\u001fplan-request-123";
  await planRepository.transaction((transaction) => {
    transaction.putIdempotency({
      scopeKey: rawPlanScopeKey,
      requestHash: "5".repeat(64),
      resultType: "plan",
      resultId: "plan-1",
      createdAt: NOW
    });
  });
  const planInsert = planConnection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_run_idempotency")
  );
  assert.ok(planInsert);
  assert.equal(
    String(planInsert.values[3]).includes("plan-request-123"),
    false
  );
  assert.match(
    String(planInsert.values[3]),
    /"scopeKey":"sha256:[a-f0-9]{64}"/
  );
}

async function testPlanRunTransactionCommitsNewRowsWithoutOverwriteUpsert() {
  const pool = new FakePool();
  const connection = pool.connection;
  connection.enqueue([{ id: 1 }]);
  for (let index = 0; index < 10; index += 1) {
    connection.enqueue([]);
  }
  const repository = new MysqlAcquisitionPlanRunRepository(asPool(pool));
  await repository.transaction((transaction) => {
    transaction.putPlan(plan());
  });
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 1);
  assert.equal(connection.rollbackCount, 0);
  const insert = connection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_plans")
  );
  assert.ok(insert);
  assert.doesNotMatch(insert.sql, /ON DUPLICATE KEY UPDATE/);
}

async function testPlanRunTransactionLocksAndRollsBack() {
  const pool = new FakePool();
  const connection = pool.connection;
  connection.enqueue([{ id: 1 }]);
  for (let index = 0; index < 11; index += 1) {
    connection.enqueue([]);
  }
  const repository = new MysqlAcquisitionPlanRunRepository(asPool(pool));
  const failure = new Error("boom");
  await assert.rejects(
    () => repository.transaction(() => {
      throw failure;
    }),
    failure
  );
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 0);
  assert.equal(connection.rollbackCount, 1);
  assert.equal(connection.releaseCount, 1);
  assert.ok(connection.calls.some((call) =>
    /SELECT id FROM acquisition_plan_run_transaction_guard WHERE id = 1 FOR UPDATE/
      .test(call.sql)
  ));
}

function conversionIntent(): LeadConversionIntent {
  return {
    id: "conversion-intent-1",
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    decisionVersion: "decision-v1",
    partyRef: {
      partyType: "organization",
      organizationId: "org-1",
      tenantProspectId: "prospect-1"
    },
    reviewerId: "reviewer-1",
    idempotencyKey: "convert-1",
    evidenceIds: ["evidence-1"],
    evidenceSnapshotHash: `sha256:${"f".repeat(64)}`,
    status: "pending_crm",
    leadId: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  };
}

function redactedKey(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function testConversionIntentsAreDurableScopedAndRecoverable() {
  const pool = new FakePool();
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  const intent = conversionIntent();

  await repository.appendConversionIntent(intent);
  const insert = pool.calls.at(-1)!;
  assert.match(insert.sql, /INSERT INTO acquisition_conversion_intents/);
  assert.doesNotMatch(JSON.stringify(insert.values), /convert-1/);

  pool.enqueue([{
    id: intent.id,
    owner_id: intent.ownerId,
    team_id: intent.teamId,
    candidate_id: intent.candidateId,
    status: intent.status,
    payload_json: JSON.stringify({
      ...intent,
      idempotencyKey: redactedKey(intent.idempotencyKey)
    })
  }]);
  const restored = await repository.findConversionIntent(
    { ownerId: intent.ownerId, teamId: intent.teamId },
    intent.candidateId
  );
  assert.equal(restored?.idempotencyKey, redactedKey(intent.idempotencyKey));
  const find = pool.calls.at(-1)!;
  assert.match(find.sql, /owner_id = \? AND team_id = \?/);
  assert.deepEqual(find.values, [
    intent.candidateId,
    intent.ownerId,
    intent.teamId
  ]);

  pool.enqueue([{
    id: intent.id,
    owner_id: intent.ownerId,
    team_id: intent.teamId,
    candidate_id: intent.candidateId,
    status: intent.status,
    payload_json: JSON.stringify({
      ...intent,
      idempotencyKey: redactedKey(intent.idempotencyKey)
    })
  }]);
  const recoverable = await repository.listRecoverableConversionIntents(10);
  assert.deepEqual(recoverable, [{
    ...intent,
    idempotencyKey: redactedKey(intent.idempotencyKey)
  }]);
  const list = pool.calls.at(-1)!;
  assert.match(list.sql, /status IN \('pending_crm', 'crm_committed'\)/);
  assert.match(list.sql, /LIMIT \?/);
  assert.deepEqual(list.values, [10]);
}

async function testPresentationReadsAreTenantBoundedPagedAndBatched() {
  const planPool = new FakePool();
  const planRepository =
    new MysqlAcquisitionPlanRunRepository(asPool(planPool));
  planPool.enqueue([]);
  assert.deepEqual(
    await planRepository.getRunPresentationExecution("run-1"),
    {
      providers: [],
      sourcesSearched: 0,
      pagesAnalyzed: 0
    }
  );
  const execution = planPool.calls.at(-1)!;
  assert.match(execution.sql, /WITH terminal_events AS/u);
  assert.match(execution.sql, /ROW_NUMBER\(\) OVER/u);
  assert.match(execution.sql, /started_shards\.occurred_at/u);
  assert.match(execution.sql, /terminal_events\.occurred_at/u);
  assert.match(execution.sql, /FROM acquisition_operation_shards s/u);
  assert.doesNotMatch(execution.sql, /SELECT e\.\*/u);
  assert.deepEqual(execution.values, ["run-1", "run-1", "run-1"]);

  const runValue = acquisitionRun();
  const presentationShard: AcquisitionOperationShard = {
    id: "shard-1",
    runId: runValue.id,
    ownerId: runValue.ownerId,
    teamId: runValue.teamId,
    operationId: "operation-1",
    parentShardId: null,
    subjectChannel: "individual",
    kind: "search",
    connection: {
      connectionId: "connection-1",
      providerId: "search-provider",
      kind: "search",
      status: "active",
      credentialVersion: 1
    },
    query: "抖音公开视频",
    sourceRef: "",
    status: "succeeded",
    budgetSnapshotId: runValue.budgetSnapshotId,
    allocatedBudget: {
      requests: 1,
      results: 10,
      amountMinor: 0,
      durationSeconds: 30
    },
    consumedBudget: {
      requests: 1,
      results: 2,
      amountMinor: 0,
      durationSeconds: 3
    },
    modelSnapshotRef: runValue.modelSnapshotRef,
    evidenceCount: 1,
    revision: 2,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:05.000Z",
    completedAt: "2026-07-24T08:00:05.000Z"
  };
  const terminalEvent = {
    id: "event-shard-1-succeeded",
    runId: runValue.id,
    shardId: presentationShard.id,
    ownerId: runValue.ownerId,
    teamId: runValue.teamId,
    type: "shard.succeeded",
    actorId: "user-1",
    revision: 2,
    at: "2026-07-24T08:00:05.000Z",
    data: {
      rawResultCount: 2,
      acceptedResultCount: 1,
      duplicateResultCount: 1,
      failedResultCount: 0
    }
  };
  planPool.enqueue([{
    id: presentationShard.id,
    owner_id: presentationShard.ownerId,
    team_id: presentationShard.teamId,
    payload_json: JSON.stringify(presentationShard),
    terminal_payload_json: JSON.stringify(terminalEvent),
    terminal_occurred_at: "2026-07-24 08:00:05.000",
    started_occurred_at: "2026-07-24 08:00:01.000",
    has_started: 1
  }]);
  const lifecycle = await planRepository.getRunPresentationExecution("run-1");
  assert.equal(lifecycle.providers[0]?.startedAt, "2026-07-24T08:00:01.000Z");
  assert.equal(lifecycle.providers[0]?.completedAt, "2026-07-24T08:00:05.000Z");

  planPool.enqueue([]);
  await planRepository.listRunCandidateEventsPage("run-1", {
    after: {
      createdAt: "2026-07-24T08:00:00.000Z",
      eventId: "event-1"
    },
    limit: 3
  });
  const eventPage = planPool.calls.at(-1)!;
  assert.match(eventPage.sql, /occurred_at > \?/);
  assert.match(eventPage.sql, /occurred_at = \? AND e\.id > \?/);
  assert.match(eventPage.sql, /LIMIT \?/);
  assert.deepEqual(eventPage.values, [
    "run-1",
    "2026-07-24 08:00:00.000",
    "2026-07-24 08:00:00.000",
    "event-1",
    3
  ]);

  const domainPool = new FakePool();
  const domainRepository =
    new MysqlAcquisitionDomainRepository(asPool(domainPool));
  domainPool.enqueue([{
    id: "audit-1",
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: JSON.stringify(domainAudit())
  }]);
  const audits = await domainRepository.listPresentationAuditEvents(
    { ownerId: "owner-a", teamId: "team-a" },
    {
      runId: "run-1",
      after: {
        createdAt: "2026-07-24T08:00:30.000Z",
        eventId: "event-2"
      },
      limit: 2
    }
  );
  assert.deepEqual(audits, [domainAudit()]);
  const auditPage = domainPool.calls.at(-1)!;
  assert.match(auditPage.sql, /WITH discovered_candidates AS/u);
  assert.match(auditPage.sql, /FROM acquisition_run_events e/u);
  assert.match(auditPage.sql, /a\.owner_id = \? AND a\.team_id = \?/);
  assert.match(auditPage.sql, /a\.created_at > links\.discovered_at/u);
  assert.match(auditPage.sql, /a\.created_at > \?/);
  assert.match(auditPage.sql, /LIMIT \?/);
  assert.deepEqual(auditPage.values, [
    "run-1",
    "owner-a",
    "team-a",
    "owner-a",
    "team-a",
    "2026-07-24 08:00:30.000",
    "2026-07-24 08:00:30.000",
    "event-2",
    2
  ]);

  const currentCandidate = candidate({
    latestDecisionId: "qualification-1",
    latestDecisionVersion: "qualification-v1",
    evidenceIds: ["evidence-1"]
  });
  domainPool.enqueue([{
    id: currentCandidate.id,
    owner_id: currentCandidate.ownerId,
    team_id: currentCandidate.teamId,
    payload_json: JSON.stringify(currentCandidate)
  }]);
  domainPool.enqueue([{
    id: "qualification-1",
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: JSON.stringify({
      ...qualification(),
      candidateId: "candidate-2"
    })
  }]);
  domainPool.enqueue([{
    id: "financial-1",
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: JSON.stringify(financial())
  }]);
  domainPool.enqueue([{
    id: "evidence-1",
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: JSON.stringify(evidence())
  }]);
  const snapshots = await domainRepository.getPresentationCandidateSnapshots(
    { ownerId: "owner-a", teamId: "team-a" },
    ["candidate-1"]
  );
  assert.deepEqual(snapshots, [{
    candidate: currentCandidate,
    qualification: null,
    financial: null,
    sourcePlatforms: ["baidu"]
  }]);
  const batchCalls = domainPool.calls.slice(-4);
  assert.equal(batchCalls.length, 4);
  assert.ok(batchCalls.every((call) => /JSON_TABLE/u.test(call.sql)));
  assert.ok(batchCalls.every((call) =>
    /owner_id = \? AND .*team_id = \?/u.test(call.sql)
  ));

  domainPool.enqueue([{
    id: "evidence-1",
    owner_id: "owner-a",
    team_id: "team-a",
    payload_json: JSON.stringify(evidence())
  }]);
  assert.deepEqual(
    await domainRepository.getPresentationEvidenceSnapshots(
      { ownerId: "owner-a", teamId: "team-a" },
      ["evidence-1", "evidence-1"]
    ),
    [evidence()]
  );
  const evidenceBatch = domainPool.calls.at(-1)!;
  assert.match(evidenceBatch.sql, /JSON_TABLE/u);
  assert.match(evidenceBatch.sql, /e\.owner_id = \? AND e\.team_id = \?/u);
  assert.deepEqual(evidenceBatch.values.slice(1), ["owner-a", "team-a"]);

  domainPool.enqueue([{
    revenue_currency: null,
    deduped_count: 1,
    organization_count: 0,
    valid_count: 1,
    high_intent_count: 1,
    financial_evaluated_count: 0,
    financial_pending_count: 1,
    expected_revenue_minor: 0
  }, {
    revenue_currency: "CNY",
    deduped_count: 1,
    organization_count: 1,
    valid_count: 1,
    high_intent_count: 1,
    financial_evaluated_count: 1,
    financial_pending_count: 0,
    expected_revenue_minor: 100_000
  }]);
  assert.deepEqual(
    await domainRepository.getPresentationCandidateSummary(
      { ownerId: "owner-a", teamId: "team-a" },
      "run-1"
    ),
    {
      organizationsFound: 1,
      dedupedCandidates: 2,
      validOpportunities: 2,
      highIntent: 2,
      financialEvaluatedHighIntentCount: 1,
      financialPendingHighIntentCount: 1,
      expectedRevenueByCurrency: [{
        currency: "CNY",
        amountMinor: 100_000
      }]
    }
  );
  const summaryCall = domainPool.calls.at(-1)!;
  assert.match(summaryCall.sql, /FROM acquisition_run_events e/u);
  assert.doesNotMatch(summaryCall.sql, /JSON_TABLE/u);
  assert.match(summaryCall.sql, /AS is_high_intent/u);
  assert.match(summaryCall.sql, /\$\.hardGateFailures/u);
  assert.match(summaryCall.sql, /<> 'do_not_contact'/u);
  assert.match(summaryCall.sql, /GROUP BY revenue_currency/u);
  assert.deepEqual(summaryCall.values, [
    "run-1",
    "owner-a",
    "team-a",
    "owner-a",
    "team-a"
  ]);
}

async function testQualificationBundleAppendsAuthorityWithBarrierAndGuard() {
  const pool = new FakePool();
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  const repository = new MysqlAcquisitionDomainRepository(asPool(pool));
  const scope = { ownerId: "owner-a", teamId: "team-a" };
  await assert.rejects(
    repository.commitQualificationBundle({
      workspace: {
        workspaceId: "all",
        workspaceBindingRevision: "binding-1"
      },
      candidate: candidate(),
      qualification: qualification(),
      financialValue: financial(),
      auditEvents: [],
      authority: {
        workspaceId: "all",
        workspaceBindingRevision: "binding-1",
        candidateId: "candidate-1",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        qualificationDecisionId: "qualification-1",
        qualificationDecisionVersion: "decision-v1",
        qualificationSnapshotHash: `sha256:${"a".repeat(64)}`,
        financialValueDecisionId: "financial-value-1",
        financialValueDecisionVersion: "financial-value-v1",
        financialValueInputSnapshotHash: `sha256:${"b".repeat(64)}`,
        grade: "A",
        score: 80,
        evidence: []
      }
    }),
    /growth_workspace_required/u
  );
  assert.equal(pool.connection.beginCount, 0);
}

async function run() {
  await testSchemaIsCompleteAndHasNoSecretColumns();
  await testEnsureSchemaExecutesEveryStatement();
  await testDomainQueriesAlwaysUseOwnerAndTeam();
  await testDomainRejectsCorruptOrCrossTenantJson();
  await testCandidateRejectsJsonVersionThatDiffersFromLockColumn();
  await testCandidateSaveUsesOptimisticVersionAndScope();
  await testIdentityAliasesAreScopedHashedAndSerialized();
  await testIdentityAliasReleaseFailureDestroysSession();
  await testAppendEvidenceUsesInsertOnly();
  await testDomainTransactionUsesOneConnectionAndRollsBackAtomically();
  await testRawIdempotencyKeysAreNotPersisted();
  await testDomainIdempotencyRestoresTheRequestKeyOnReplay();
  await testCopilotPersistenceIsScopedAndMessageOrderIsDurable();
  await testCopilotClaimIsAtomicAndScoped();
  await testCopilotClaimRejectsAnotherRunningTaskInTheSession();
  await testCopilotTransactionUsesOneConnectionAndRollsBackAtomically();
  await testPlaintextCredentialFieldsAreRejected();
  await testTaskStateUpdateUsesExpectedPreviousState();
  await testRunPersistsImmutableSnapshotColumnsAfterVersion();
  await testRunListQueryPushesFilteringOrderingAndLimitIntoSql();
  await testPlanRunIdempotencyScopesAreHashedAtRest();
  await testPlanRunTransactionCommitsNewRowsWithoutOverwriteUpsert();
  await testPlanRunTransactionLocksAndRollsBack();
  await testConversionIntentsAreDurableScopedAndRecoverable();
  await testPresentationReadsAreTenantBoundedPagedAndBatched();
  await testQualificationBundleAppendsAuthorityWithBarrierAndGuard();
  console.log("acquisition mysql repositories tests passed");
}

await run();
