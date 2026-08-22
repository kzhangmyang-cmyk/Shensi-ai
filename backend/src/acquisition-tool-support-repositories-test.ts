import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type { AcquisitionCandidate } from "./acquisition-domain.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionToolAuditLedger,
  AcquisitionToolAuditRecord
} from "./acquisition-pi-tools.js";
import {
  ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS,
  InMemoryAcquisitionCandidateDirectory,
  InMemoryAcquisitionReviewTaskRepository,
  InMemoryAcquisitionToolAuditLedgerAdapter,
  InMemoryAcquisitionToolResultLedger,
  MysqlAcquisitionCandidateDirectory,
  MysqlAcquisitionActionExecutionRepository,
  MysqlAcquisitionPriorityCandidateRepository,
  MysqlAcquisitionReviewTaskRepository,
  MysqlAcquisitionToolAuditStore,
  MysqlAcquisitionToolResultLedger,
  TrustedMysqlAcquisitionActionExecutionWriter,
  ensureAcquisitionToolSupportMysqlSchema
} from "./acquisition-tool-support-repositories.js";

type QueryResult = [unknown, unknown];

class ScriptedConnection {
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
      throw new Error("scripted-query-failure");
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

class ScriptedPool extends ScriptedConnection {
  readonly connection = new ScriptedConnection();

  async getConnection() {
    return this.connection;
  }
}

class PoisonAwarePool extends ScriptedConnection {
  readonly poisonedConnection = new ScriptedConnection();
  readonly replacementConnection = new ScriptedConnection();
  readonly acquired: ScriptedConnection[] = [];

  async getConnection() {
    const connection = this.poisonedConnection.destroyCount > 0
      ? this.replacementConnection
      : this.poisonedConnection;
    this.acquired.push(connection);
    return connection;
  }
}

function asPool(value: unknown) {
  return value as unknown as mysql.Pool;
}

const NOW = "2026-07-24T08:00:00.000Z";

function candidate(
  id: string,
  ownerId = "owner-a",
  teamId = "team-a"
): AcquisitionCandidate {
  return {
    id,
    ownerId,
    teamId,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: `org-${id}`,
      tenantProspectId: `prospect-${id}`
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
    version: 1
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

assert.ok(
  ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS.some((statement) =>
    statement.includes("acquisition_candidate_directory")
  )
);
assert.equal(
  ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS.some((statement) =>
    /idempotency_key\s+varchar/i.test(statement)
  ),
  false,
  "schema must never persist a plaintext idempotency key"
);

{
  const pool = new ScriptedPool();
  await ensureAcquisitionToolSupportMysqlSchema(asPool(pool));
  assert.equal(
    pool.calls.length,
    ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS.length
  );
}

{
  const directory = new InMemoryAcquisitionCandidateDirectory({
    now: () => NOW
  });
  let creates = 0;
  const attempts = Array.from({ length: 32 }, () =>
    directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: "organization:example.cn",
      partyType: "organization",
      idempotencyKey: "candidate-upsert-secret-key",
      createCandidate: async () => {
        creates += 1;
        await Promise.resolve();
        return candidate("candidate-1");
      }
    })
  );
  const results = await Promise.all(attempts);
  assert.equal(creates, 1, "concurrent upserts must invoke creation once");
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.deepEqual(
    new Set(results.map((result) => result.entry.candidateId)),
    new Set(["candidate-1"])
  );
  results[0]!.entry.candidateId = "tampered";
  assert.equal(results[1]!.entry.candidateId, "candidate-1");

  const isolated = await directory.upsertCandidate({
    ownerId: "owner-b",
    teamId: "team-a",
    dedupeKey: "organization:example.cn",
    partyType: "organization",
    idempotencyKey: "candidate-upsert-secret-key",
    createCandidate: async () => candidate("candidate-2", "owner-b")
  });
  assert.equal(isolated.created, true);
  assert.equal(isolated.entry.candidateId, "candidate-2");
}

{
  const directory = new InMemoryAcquisitionCandidateDirectory({
    now: () => NOW
  });
  let attempts = 0;
  const input = {
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:retry.example",
    partyType: "organization" as const,
    idempotencyKey: "retry-key"
  };
  await assert.rejects(
    directory.upsertCandidate({
      ...input,
      createCandidate: async () => {
        attempts += 1;
        throw new Error("temporary");
      }
    }),
    /temporary/
  );
  const replay = await directory.upsertCandidate({
    ...input,
    createCandidate: async () => {
      attempts += 1;
      return candidate("candidate-retry");
    }
  });
  assert.equal(attempts, 2);
  assert.equal(replay.created, true);
}

{
  const directory = new InMemoryAcquisitionCandidateDirectory({
    now: () => NOW
  });
  await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:preexisting.example",
    partyType: "organization",
    idempotencyKey: "preexisting-key",
    createCandidate: async () => candidate("candidate-preexisting")
  });
  const entered = deferred();
  const release = deferred();
  const failing = directory.transaction(async () => {
    await directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: "organization:doomed.example",
      partyType: "organization",
      idempotencyKey: "doomed-key",
      createCandidate: async () => candidate("candidate-doomed")
    });
    entered.resolve();
    await release.promise;
    throw new Error("ROLLBACK_DIRECTORY_SNAPSHOT");
  });
  await entered.promise;

  let survivorSettled = false;
  const survivor = directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:survivor.example",
    partyType: "organization",
    idempotencyKey: "survivor-key",
    createCandidate: async () => candidate("candidate-survivor")
  }).then((result) => {
    survivorSettled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeRollback = survivorSettled;
  release.resolve();
  await assert.rejects(failing, /ROLLBACK_DIRECTORY_SNAPSHOT/u);
  assert.equal((await survivor).created, true);

  assert.equal(
    settledBeforeRollback,
    false,
    "standalone directory upserts must queue behind the active snapshot"
  );
  assert.equal((await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:survivor.example",
    partyType: "organization",
    idempotencyKey: "survivor-key",
    createCandidate: async () => {
      throw new Error("survivor must already be indexed");
    }
  })).created, false);
  assert.equal((await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:preexisting.example",
    partyType: "organization",
    idempotencyKey: "preexisting-key",
    createCandidate: async () => {
      throw new Error("preexisting entry must survive rollback");
    }
  })).created, false);
  assert.equal((await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:doomed.example",
    partyType: "organization",
    idempotencyKey: "doomed-key",
    createCandidate: async () => candidate("candidate-doomed-retry")
  })).created, true);
}

{
  const directory = new InMemoryAcquisitionCandidateDirectory({
    now: () => NOW
  });
  const createEntered = deferred();
  const releaseCreate = deferred();
  const survivor = directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:first-in-flight.example",
    partyType: "organization",
    idempotencyKey: "first-in-flight-key",
    createCandidate: async () => {
      createEntered.resolve();
      await releaseCreate.promise;
      return candidate("candidate-first-in-flight");
    }
  });
  await createEntered.promise;
  let laterSnapshotEntered = false;
  const failing = directory.transaction(async () => {
    laterSnapshotEntered = true;
    await directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: "organization:later-doomed.example",
      partyType: "organization",
      idempotencyKey: "later-doomed-key",
      createCandidate: async () => candidate("candidate-later-doomed")
    });
    throw new Error("ROLLBACK_LATER_DIRECTORY_SNAPSHOT");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    laterSnapshotEntered,
    false,
    "a later snapshot must wait for the standalone upsert"
  );
  releaseCreate.resolve();
  assert.equal((await survivor).created, true);
  await assert.rejects(failing, /ROLLBACK_LATER_DIRECTORY_SNAPSHOT/u);
  assert.equal((await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:first-in-flight.example",
    partyType: "organization",
    idempotencyKey: "first-in-flight-key",
    createCandidate: async () => {
      throw new Error("first standalone write must survive later rollback");
    }
  })).created, false);
  assert.equal((await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:later-doomed.example",
    partyType: "organization",
    idempotencyKey: "later-doomed-key",
    createCandidate: async () => candidate("candidate-later-doomed-retry")
  })).created, true);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  const directory = new MysqlAcquisitionCandidateDirectory(asPool(pool), {
    now: () => NOW
  });
  const result = await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:example.cn",
    partyType: "organization",
    idempotencyKey: "plaintext-idempotency-key",
    createCandidate: async () => candidate("candidate-mysql")
  });
  assert.equal(result.created, true);
  assert.equal(result.entry.candidateId, "candidate-mysql");
  assert.match(pool.connection.calls[0]!.sql, /GET_LOCK/i);
  assert.match(pool.connection.calls.at(-1)!.sql, /RELEASE_LOCK/i);
  assert.equal(pool.connection.releaseCount, 1);
  assert.equal(
    JSON.stringify(pool.connection.calls).includes("plaintext-idempotency-key"),
    false,
    "only the idempotency hash may reach MySQL"
  );
  const insert = pool.connection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_candidate_directory")
  );
  assert.ok(insert);
  assert.match(String(insert.values[5]), /^[a-f0-9]{64}$/);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.failSqlPattern = /RELEASE_LOCK/i;
  const directory = new MysqlAcquisitionCandidateDirectory(asPool(pool), {
    now: () => NOW
  });
  await assert.rejects(
    directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: "organization:release.example",
      partyType: "organization",
      idempotencyKey: "release-key",
      createCandidate: async () => candidate("candidate-release")
    }),
    /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
  );
  assert.equal(pool.connection.releaseCount, 0);
  assert.equal(pool.connection.destroyCount, 1);
}

for (const invalidReleaseResult of [0, null] as const) {
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.releaseLockResult = invalidReleaseResult;
  const directory = new MysqlAcquisitionCandidateDirectory(asPool(pool), {
    now: () => NOW
  });
  await assert.rejects(
    directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: `organization:release-${String(invalidReleaseResult)}.example`,
      partyType: "organization",
      idempotencyKey: `release-${String(invalidReleaseResult)}-key`,
      createCandidate: async () => candidate(
        `candidate-release-${String(invalidReleaseResult)}`
      )
    }),
    /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
  );
  assert.equal(pool.connection.releaseCount, 0);
  assert.equal(pool.connection.destroyCount, 1);
}

{
  const pool = new PoisonAwarePool();
  pool.poisonedConnection.enqueue([{ lock_acquired: 1 }]);
  pool.poisonedConnection.enqueue([]);
  pool.poisonedConnection.failSqlPattern = /RELEASE_LOCK/i;
  pool.replacementConnection.enqueue([{ lock_acquired: 1 }]);
  pool.replacementConnection.enqueue([]);
  const directory = new MysqlAcquisitionCandidateDirectory(asPool(pool), {
    now: () => NOW
  });
  await assert.rejects(
    directory.upsertCandidate({
      ownerId: "owner-a",
      teamId: "team-a",
      dedupeKey: "organization:poisoned.example",
      partyType: "organization",
      idempotencyKey: "poisoned-key",
      createCandidate: async () => candidate("candidate-poisoned")
    }),
    /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
  );
  await directory.upsertCandidate({
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:replacement.example",
    partyType: "organization",
    idempotencyKey: "replacement-key",
    createCandidate: async () => candidate("candidate-replacement")
  });
  assert.deepEqual(pool.acquired, [
    pool.poisonedConnection,
    pool.replacementConnection
  ]);
  assert.equal(pool.poisonedConnection.releaseCount, 0);
  assert.equal(pool.poisonedConnection.destroyCount, 1);
  assert.equal(pool.replacementConnection.releaseCount, 1);
  assert.equal(pool.replacementConnection.destroyCount, 0);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue([{
    candidate_id: "candidate-shared-lock",
    party_type: "organization",
    indexed_at: new Date(NOW)
  }]);
  const directory = new MysqlAcquisitionCandidateDirectory(asPool(pool), {
    now: () => NOW
  });
  const input = {
    ownerId: "owner-a",
    teamId: "team-a",
    dedupeKey: "organization:shared-lock.example",
    partyType: "organization" as const,
    idempotencyKey: "shared-lock-key",
    createCandidate: async () => candidate("candidate-shared-lock")
  };
  await directory.withTransactionConnection(
    pool.connection as unknown as mysql.PoolConnection,
    async () => {
      assert.equal((await directory.upsertCandidate(input)).created, true);
      assert.equal((await directory.upsertCandidate(input)).created, false);
    }
  );
  assert.equal(
    pool.connection.calls.filter((call) => /GET_LOCK/i.test(call.sql)).length,
    1,
    "a shared session must not re-enter a named lock it already owns"
  );
  assert.equal(
    pool.connection.calls.filter((call) => /RELEASE_LOCK/i.test(call.sql)).length,
    1
  );
  assert.equal(pool.connection.destroyCount, 0);
}

{
  const pool = new ScriptedPool();
  pool.enqueue([
    {
      candidate_id: "candidate-priority",
      qualification_grade: "A",
      qualification_score: "88.5",
      financial_score: 76,
      updated_at: new Date(NOW)
    }
  ]);
  const repository = new MysqlAcquisitionPriorityCandidateRepository(
    asPool(pool)
  );
  const result = await repository.listPriorityCandidates({
    ownerId: "owner-a",
    teamId: "team-a",
    subjectKinds: ["organization"],
    minimumGrade: "B",
    limit: 7,
    sort: "qualification_and_financial_desc"
  });
  assert.deepEqual(result, [{
    candidateId: "candidate-priority",
    qualificationGrade: "A",
    qualificationScore: 88.5,
    financialScore: 76,
    updatedAt: NOW
  }]);
  assert.equal(pool.calls.length, 1);
  const query = pool.calls[0]!;
  assert.match(query.sql, /JOIN acquisition_candidate_directory/i);
  assert.match(query.sql, /acquisition_qualification_decisions/i);
  assert.match(query.sql, /acquisition_financial_values/i);
  assert.match(query.sql, /JSON_EXTRACT\(c\.payload_json, '\$\.partyType'\)/i);
  assert.match(query.sql, /CASE qualification_grade/i);
  assert.match(query.sql, /LIMIT \?/i);
  assert.equal(query.values.at(-1), 7);
  assert.equal(
    query.sql.indexOf("ORDER BY") < query.sql.indexOf("LIMIT ?"),
    true,
    "storage must sort before applying LIMIT"
  );

  await assert.rejects(
    repository.listPriorityCandidates({
      ownerId: "owner-a",
      teamId: "team-a",
      subjectKinds: ["organization", "organization"],
      limit: 7,
      sort: "qualification_and_financial_desc"
    }),
    /subjectKinds/
  );
}

{
  const reviews = new InMemoryAcquisitionReviewTaskRepository({
    now: () => NOW,
    idFactory: () => "review-in-memory"
  });
  const input = {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    candidateId: "candidate-1",
    proposedAction: "email" as const,
    rationale: "公开需求符合人工邮件复核条件",
    idempotencyKey: "review-idempotency-plaintext"
  };
  const results = await Promise.all(
    Array.from({ length: 24 }, () => reviews.create(input))
  );
  assert.deepEqual(
    new Set(results.map((result) => result.id)),
    new Set(["review-in-memory"])
  );
  assert.equal(results.every((result) => result.status === "pending"), true);
  assert.equal(
    (await reviews.get(input, "review-in-memory"))?.id,
    "review-in-memory"
  );
  assert.equal(
    await reviews.get(
      { ownerId: "other-owner", teamId: input.teamId },
      "review-in-memory"
    ),
    null
  );
  await assert.rejects(
    reviews.create({ ...input, rationale: "different request" }),
    /IDEMPOTENCY_CONFLICT/
  );
}

{
  const pool = new ScriptedPool();
  const mysqlReviewInput = {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    candidateId: "candidate-1",
    proposedAction: "email" as const,
    rationale: "人工复核",
    idempotencyKey: "review-idempotency-plaintext"
  };
  const mysqlReviewRequestHash = createHash("sha256")
    .update(canonicalJsonStringify({
      ownerId: mysqlReviewInput.ownerId,
      teamId: mysqlReviewInput.teamId,
      actorId: mysqlReviewInput.actorId,
      sessionId: mysqlReviewInput.sessionId,
      candidateId: mysqlReviewInput.candidateId,
      proposedAction: mysqlReviewInput.proposedAction,
      rationale: mysqlReviewInput.rationale
    }))
    .digest("hex");
  const mysqlReviewKeyHash = createHash("sha256")
    .update(mysqlReviewInput.idempotencyKey)
    .digest("hex");
  pool.enqueue({ affectedRows: 1 });
  pool.enqueue([{
    id: "review-mysql",
    owner_id: "owner-a",
    team_id: "team-a",
    actor_id: "actor-a",
    session_id: "session-a",
    candidate_id: "candidate-1",
    proposed_action: "email",
    rationale: "人工复核",
    idempotency_key_hash: mysqlReviewKeyHash,
    request_hash: mysqlReviewRequestHash,
    status: "pending",
    created_at: new Date(NOW)
  }]);
  const reviews = new MysqlAcquisitionReviewTaskRepository(asPool(pool), {
    now: () => NOW,
    idFactory: () => "review-mysql"
  });
  const task = await reviews.create(mysqlReviewInput);
  assert.equal(task.id, "review-mysql");
  assert.equal(task.idempotencyKey, "review-idempotency-plaintext");
  assert.equal(
    JSON.stringify(pool.calls).includes("review-idempotency-plaintext"),
    false
  );
  const insert = pool.calls[0]!;
  assert.match(insert.sql, /INSERT INTO acquisition_review_tasks/i);
  assert.match(String(insert.values[8]), /^[a-f0-9]{64}$/);
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/i);
}

{
  const pool = new ScriptedPool();
  pool.enqueue([{
    id: "review-corrupt",
    owner_id: "other-owner",
    team_id: "team-a",
    actor_id: "actor-a",
    session_id: "session-a",
    candidate_id: "candidate-1",
    proposed_action: "email",
    rationale: "人工复核",
    idempotency_key_hash: "a".repeat(64),
    request_hash: "b".repeat(64),
    status: "pending",
    created_at: new Date(NOW)
  }]);
  const reviews = new MysqlAcquisitionReviewTaskRepository(asPool(pool));
  await assert.rejects(
    reviews.get(
      { ownerId: "owner-a", teamId: "team-a" },
      "review-corrupt"
    ),
    /scope/
  );
}

{
  const pool = new ScriptedPool();
  const proofSecret = "receipt-proof-secret-at-least-32-characters-long";
  const writer = new TrustedMysqlAcquisitionActionExecutionWriter(
    asPool(pool),
    {
      proofSecret,
      now: () => NOW,
      idFactory: () => "execution-1"
    }
  );
  const receipt = await writer.recordExecution({
    ownerId: "owner-a",
    teamId: "team-a",
    candidateId: "candidate-1",
    reviewTaskId: "review-1",
    proposedAction: "email",
    credential: {
      issuer: "goodjob-action-worker",
      credentialId: "credential-1"
    }
  });
  assert.match(receipt.credential.proofHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(pool.calls).includes(proofSecret), false);

  pool.enqueue([{
    execution_id: receipt.executionId,
    owner_id: receipt.ownerId,
    team_id: receipt.teamId,
    candidate_id: receipt.candidateId,
    review_task_id: receipt.reviewTaskId,
    proposed_action: receipt.proposedAction,
    executed_at: new Date(receipt.executedAt),
    credential_issuer: receipt.credential.issuer,
    credential_id: receipt.credential.credentialId,
    proof_hash: receipt.credential.proofHash
  }]);
  const reader = new MysqlAcquisitionActionExecutionRepository(asPool(pool), {
    proofSecret
  });
  assert.equal("recordExecution" in reader, false);
  assert.deepEqual(
    await reader.getVerifiedExecution(
      { ownerId: "owner-a", teamId: "team-a" },
      "review-1"
    ),
    receipt
  );

  pool.enqueue([{
    execution_id: receipt.executionId,
    owner_id: receipt.ownerId,
    team_id: receipt.teamId,
    candidate_id: "tampered-candidate",
    review_task_id: receipt.reviewTaskId,
    proposed_action: receipt.proposedAction,
    executed_at: new Date(receipt.executedAt),
    credential_issuer: receipt.credential.issuer,
    credential_id: receipt.credential.credentialId,
    proof_hash: receipt.credential.proofHash
  }]);
  assert.equal(
    await reader.getVerifiedExecution(
      { ownerId: "owner-a", teamId: "team-a" },
      "review-1"
    ),
    null,
    "a stored receipt with an invalid proof must not be trusted"
  );
}

{
  const ledger = new InMemoryAcquisitionToolResultLedger();
  let operations = 0;
  let releaseOperation!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const execute = () => ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "get_candidate_evidence",
    idempotencyKey: "tool-result-idempotency-plaintext",
    requestHash: `sha256:${"a".repeat(64)}`
  }, async () => {
    operations += 1;
    await gate;
    return { candidateId: "candidate-1", values: [1, 2, 3] };
  });
  const executions = Array.from({ length: 32 }, execute);
  await Promise.resolve();
  assert.equal(operations, 1);
  releaseOperation();
  const results = await Promise.all(executions);
  assert.equal(operations, 1);
  results[0]!.values.push(4);
  assert.deepEqual(results[1]!.values, [1, 2, 3]);

  let failedAttempts = 0;
  const retryInput = {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "research_candidate",
    idempotencyKey: "retry-result-key",
    requestHash: `sha256:${"b".repeat(64)}`
  };
  await assert.rejects(
    ledger.executeOnce(retryInput, async () => {
      failedAttempts += 1;
      throw new Error("temporary");
    }),
    /temporary/
  );
  assert.deepEqual(
    await ledger.executeOnce(retryInput, async () => {
      failedAttempts += 1;
      return { status: "ok" };
    }),
    { status: "ok" }
  );
  assert.equal(failedAttempts, 2, "failed results must not be cached");

  const redacted = await ledger.executeOnce({
    ...retryInput,
    idempotencyKey: "redacted-result-key",
    requestHash: `sha256:${"c".repeat(64)}`
  }, async () => ({
    reviewTask: {
      idempotencyKey: "nested-plaintext-idempotency"
    }
  }));
  assert.match(
    redacted.reviewTask.idempotencyKey,
    /^sha256:[a-f0-9]{64}$/
  );
  await assert.rejects(
    ledger.executeOnce({
      ...retryInput,
      idempotencyKey: "secret-result-key",
      requestHash: `sha256:${"d".repeat(64)}`
    }, async () => ({ apiKey: "must-not-persist" })),
    /PLAINTEXT_SECRET_REJECTED/
  );
}

{
  const ledger = new InMemoryAcquisitionToolResultLedger();
  let releaseOperation!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const first = ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "research_candidate",
    idempotencyKey: "pending-conflict-key",
    requestHash: `sha256:${"a".repeat(64)}`
  }, async () => {
    await gate;
    return { ok: true };
  });
  await Promise.resolve();
  await assert.rejects(
    ledger.executeOnce({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "actor-a",
      sessionId: "session-a",
      toolName: "research_candidate",
      idempotencyKey: "pending-conflict-key",
      requestHash: `sha256:${"b".repeat(64)}`
    }, async () => ({ ok: false })),
    /IDEMPOTENCY_CONFLICT/
  );
  releaseOperation();
  await first;
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool));
  let operations = 0;
  const value = await ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "get_candidate_evidence",
    idempotencyKey: "mysql-result-idempotency-plaintext",
    requestHash: `sha256:${"e".repeat(64)}`
  }, async () => {
    operations += 1;
    return { candidateId: "candidate-1" };
  });
  assert.deepEqual(value, { candidateId: "candidate-1" });
  assert.equal(operations, 1);
  assert.equal(pool.connection.beginCount, 1);
  assert.equal(pool.connection.commitCount, 1);
  assert.equal(pool.connection.rollbackCount, 0);
  assert.equal(
    JSON.stringify(pool.connection.calls)
      .includes("mysql-result-idempotency-plaintext"),
    false
  );
  const pendingInsert = pool.connection.calls.find((call) =>
    call.sql.startsWith("INSERT INTO acquisition_tool_results")
  );
  assert.ok(pendingInsert);
  assert.match(String(pendingInsert.values[3]), /^[a-f0-9]{64}$/);
  assert.equal(pendingInsert.values.at(-1), null);
  const successUpdate = pool.calls.find((call) =>
    call.sql.startsWith("UPDATE acquisition_tool_results")
  );
  assert.ok(successUpdate);
  assert.equal(
    successUpdate.values[0],
    JSON.stringify({ value: { candidateId: "candidate-1" } }),
    "stored results use an envelope so JSON null remains distinguishable"
  );
  assert.match(pool.connection.calls.at(-1)!.sql, /RELEASE_LOCK/i);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.connection.enqueue({ affectedRows: 1 });
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool), {
    claimTokenFactory: () => "raw-claim-token-must-not-be-persisted"
  });
  await ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "get_candidate_evidence",
    idempotencyKey: "operation-must-run-outside-claim-transaction",
    requestHash: `sha256:${"7".repeat(64)}`
  }, async () => {
    assert.equal(
      pool.connection.commitCount,
      1,
      "the pending claim must commit before an external operation starts"
    );
    assert.equal(
      pool.connection.releaseCount,
      1,
      "the database connection must be returned before external work starts"
    );
    return { ok: true };
  });
  const allDatabaseCalls = JSON.stringify([
    ...pool.connection.calls,
    ...pool.calls
  ]);
  assert.equal(
    allDatabaseCalls.includes("raw-claim-token-must-not-be-persisted"),
    false,
    "only a hash of the fencing token may reach MySQL"
  );
  assert.equal(
    allDatabaseCalls.includes(
      createHash("sha256")
        .update("raw-claim-token-must-not-be-persisted")
        .digest("hex")
    ),
    true
  );
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([{
    request_hash: `sha256:${"8".repeat(64)}`,
    state: "pending",
    result_json: null,
    claim_token_hash: "1".repeat(64),
    lease_expires_at: "2026-07-24 07:59:00.000",
    attempt_count: 1
  }]);
  pool.connection.enqueue({ affectedRows: 1 });
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool), {
    now: () => NOW,
    claimTokenFactory: () => "stale-recovery-token"
  });
  let operations = 0;
  const recovered = await ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "research_candidate",
    idempotencyKey: "stale-pending-key",
    requestHash: `sha256:${"8".repeat(64)}`
  }, async () => {
    operations += 1;
    return { recovered: true };
  });
  assert.deepEqual(recovered, { recovered: true });
  assert.equal(operations, 1);
  const reclaim = pool.connection.calls.find((call) =>
    call.sql.startsWith("UPDATE acquisition_tool_results")
    && call.sql.includes("attempt_count = attempt_count + 1")
  );
  assert.ok(reclaim, "expired pending work must be reclaimed atomically");
  assert.match(
    String(reclaim.values[2]),
    /^[a-f0-9]{64}$/,
    "the stale claim is replaced by a hashed fencing token"
  );
  assert.equal(
    JSON.stringify(reclaim).includes("stale-recovery-token"),
    false
  );
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([{
    request_hash: `sha256:${"9".repeat(64)}`,
    state: "pending",
    result_json: null,
    claim_token_hash: "2".repeat(64),
    lease_expires_at: "2026-07-24 08:01:00.000",
    attempt_count: 1
  }]);
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool), {
    now: () => NOW,
    pendingWaitTimeoutMs: 0
  });
  let operations = 0;
  await assert.rejects(
    ledger.executeOnce({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "actor-a",
      sessionId: "session-a",
      toolName: "research_candidate",
      idempotencyKey: "live-pending-key",
      requestHash: `sha256:${"9".repeat(64)}`
    }, async () => {
      operations += 1;
      return { mustNotRun: true };
    }),
    /ACQUISITION_TOOL_RESULT_PENDING_TIMEOUT/
  );
  assert.equal(operations, 0);
  assert.equal(pool.connection.commitCount, 1);
  assert.equal(pool.connection.releaseCount, 1);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  pool.enqueue({ affectedRows: 0 });
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool), {
    claimTokenFactory: () => "losing-fencing-token"
  });
  await assert.rejects(
    ledger.executeOnce({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "actor-a",
      sessionId: "session-a",
      toolName: "research_candidate",
      idempotencyKey: "lost-lease-key",
      requestHash: `sha256:${"0".repeat(64)}`
    }, async () => ({ result: "stale-worker" })),
    /ACQUISITION_TOOL_RESULT_CLAIM_LOST/
  );
  const completion = pool.calls.find((call) =>
    call.sql.startsWith("UPDATE acquisition_tool_results")
  );
  assert.ok(completion);
  assert.match(completion.sql, /claim_token_hash = \?/);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([{
    request_hash: `sha256:${"e".repeat(64)}`,
    state: "succeeded",
    result_json: JSON.stringify({ value: null })
  }]);
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool));
  let operations = 0;
  const replay = await ledger.executeOnce({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    sessionId: "session-a",
    toolName: "get_candidate_evidence",
    idempotencyKey: "mysql-result-idempotency-plaintext",
    requestHash: `sha256:${"e".repeat(64)}`
  }, async () => {
    operations += 1;
    return "must-not-run";
  });
  assert.equal(replay, null);
  assert.equal(operations, 0);
  assert.equal(pool.connection.commitCount, 1);
}

{
  const pool = new ScriptedPool();
  pool.connection.enqueue([{ lock_acquired: 1 }]);
  pool.connection.enqueue([]);
  pool.connection.enqueue({ affectedRows: 1 });
  const ledger = new MysqlAcquisitionToolResultLedger(asPool(pool));
  await assert.rejects(
    ledger.executeOnce({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "actor-a",
      sessionId: "session-a",
      toolName: "qualify_candidate",
      idempotencyKey: "mysql-result-failure",
      requestHash: `sha256:${"f".repeat(64)}`
    }, async () => {
      throw new Error("operation-failed");
    }),
    /operation-failed/
  );
  assert.equal(
    pool.connection.commitCount,
    1,
    "the durable claim is committed before external work fails"
  );
  assert.equal(pool.connection.rollbackCount, 0);
  assert.equal(
    pool.calls.some((call) =>
      call.sql.startsWith("UPDATE acquisition_tool_results")
    ),
    false
  );
  assert.equal(
    pool.calls.some((call) =>
      call.sql.startsWith("DELETE FROM acquisition_tool_results")
    ),
    true,
    "a failed claimant releases only its own pending claim"
  );
}

const auditRecord: AcquisitionToolAuditRecord = {
  id: "audit-1",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "actor-a",
  sessionId: "session-a",
  toolName: "get_candidate_evidence",
  toolCallIdHash: "1".repeat(64),
  idempotencyKeyHash: "2".repeat(64),
  parameterHash: "3".repeat(64),
  resultHash: "4".repeat(64),
  status: "succeeded",
  errorCode: null,
  startedAt: NOW,
  completedAt: NOW
};

{
  const audit = new InMemoryAcquisitionToolAuditLedgerAdapter();
  await audit.append(auditRecord);
  const listed = await audit.list({
    ownerId: "owner-a",
    teamId: "team-a",
    sessionId: "session-a"
  });
  assert.deepEqual(listed, [auditRecord]);
  listed[0]!.status = "failed";
  assert.equal(
    (await audit.list({
      ownerId: "owner-a",
      teamId: "team-a",
      sessionId: "session-a"
    }))[0]!.status,
    "succeeded"
  );
  assert.deepEqual(
    await audit.list({
      ownerId: "other-owner",
      teamId: "team-a",
      sessionId: "session-a"
    }),
    []
  );
}

{
  const pool = new ScriptedPool();
  const store: AcquisitionToolAuditLedger =
    new MysqlAcquisitionToolAuditStore(asPool(pool));
  await store.append(auditRecord);
  assert.match(pool.calls[0]!.sql, /INSERT INTO acquisition_tool_audit/i);
  assert.equal(pool.calls[0]!.sql.includes("payload_json"), false);
  pool.enqueue([{
    id: auditRecord.id,
    owner_id: auditRecord.ownerId,
    team_id: auditRecord.teamId,
    actor_id: auditRecord.actorId,
    session_id: auditRecord.sessionId,
    tool_name: auditRecord.toolName,
    tool_call_id_hash: auditRecord.toolCallIdHash,
    idempotency_key_hash: auditRecord.idempotencyKeyHash,
    parameter_hash: auditRecord.parameterHash,
    result_hash: auditRecord.resultHash,
    status: auditRecord.status,
    error_code: auditRecord.errorCode,
    started_at: new Date(auditRecord.startedAt),
    completed_at: new Date(auditRecord.completedAt)
  }]);
  assert.deepEqual(
    await store.list({
      ownerId: "owner-a",
      teamId: "team-a",
      sessionId: "session-a"
    }),
    [auditRecord]
  );
}

{
  const pool = new ScriptedPool();
  pool.enqueue([{
    id: auditRecord.id,
    owner_id: "other-owner",
    team_id: auditRecord.teamId,
    actor_id: auditRecord.actorId,
    session_id: auditRecord.sessionId,
    tool_name: auditRecord.toolName,
    tool_call_id_hash: auditRecord.toolCallIdHash,
    idempotency_key_hash: auditRecord.idempotencyKeyHash,
    parameter_hash: auditRecord.parameterHash,
    result_hash: auditRecord.resultHash,
    status: auditRecord.status,
    error_code: auditRecord.errorCode,
    started_at: new Date(auditRecord.startedAt),
    completed_at: new Date(auditRecord.completedAt)
  }]);
  const store = new MysqlAcquisitionToolAuditStore(asPool(pool));
  await assert.rejects(
    store.list({
      ownerId: "owner-a",
      teamId: "team-a",
      sessionId: "session-a"
    }),
    /scope/
  );
}

console.log("acquisition tool support repository tests passed");
