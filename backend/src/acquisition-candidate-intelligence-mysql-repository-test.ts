import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import {
  AcquisitionCandidateIntelligenceOperationError,
  type AcquisitionCandidateIntelligenceOperationRecord
} from "./acquisition-candidate-intelligence-operations.js";
import {
  ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionCandidateIntelligenceOperationRepository,
  ensureAcquisitionCandidateIntelligenceMysqlSchema
} from "./acquisition-candidate-intelligence-mysql-repository.js";

class FakePool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly queue: Array<[unknown, unknown]> = [];
  readonly transactions: string[] = [];

  enqueue(rows: unknown) {
    this.queue.push([rows, []]);
  }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({
      sql: sql.replace(/\s+/gu, " ").trim(),
      values
    });
    return this.queue.shift() ?? [{ affectedRows: 1 }, []];
  }

  async getConnection() {
    return this;
  }

  async beginTransaction() {
    this.transactions.push("begin");
  }

  async commit() {
    this.transactions.push("commit");
  }

  async rollback() {
    this.transactions.push("rollback");
  }

  release() {
    this.transactions.push("release");
  }
}

function asPool(pool: FakePool) {
  return pool as unknown as mysql.Pool;
}

const queuedOperation: AcquisitionCandidateIntelligenceOperationRecord = {
  id: "candidate-intelligence-1",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "actor-a",
  candidateId: "candidate-a",
  sessionId: "session-a",
  identityFingerprint: `sha256:${"a".repeat(64)}`,
  status: "queued",
  currentStage: null,
  completedStages: [],
  skippedStages: [],
  research: null,
  qualification: null,
  battleCardId: null,
  failure: null,
  idempotencyKeyHash: "b".repeat(64),
  requestHash: `sha256:${"c".repeat(64)}`,
  leaseOwner: null,
  leaseToken: null,
  leaseExpiresAt: null,
  createdAt: "2026-08-07T02:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-08-07T02:00:00.000Z",
  completedAt: null,
  failedAt: null
};

function mysqlDate(value: string) {
  return value.slice(0, 23).replace("T", " ");
}

function mysqlRow(
  operation: AcquisitionCandidateIntelligenceOperationRecord,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: operation.id,
    owner_id: operation.ownerId,
    team_id: operation.teamId,
    actor_id: operation.actorId,
    candidate_id: operation.candidateId,
    identity_fingerprint: operation.identityFingerprint,
    idempotency_key_hash: operation.idempotencyKeyHash,
    request_hash: operation.requestHash,
    status: operation.status,
    lease_owner: operation.leaseOwner,
    lease_token: operation.leaseToken,
    lease_expires_at: operation.leaseExpiresAt
      ? mysqlDate(operation.leaseExpiresAt)
      : null,
    payload_json: JSON.stringify(operation),
    created_at: mysqlDate(operation.createdAt),
    updated_at: mysqlDate(operation.updatedAt),
    ...overrides
  };
}

test("candidate intelligence schema creates tenant, idempotency, latest, recovery, and lease invariants", async () => {
  const pool = new FakePool();

  await ensureAcquisitionCandidateIntelligenceMysqlSchema(asPool(pool));

  assert.equal(
    pool.calls.length,
    ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_SCHEMA_STATEMENTS.length
  );
  const schema = pool.calls.map((call) => call.sql).join("\n");
  assert.match(schema, /acquisition_candidate_intelligence_operations/u);
  assert.match(schema, /UNIQUE KEY uk_acquisition_candidate_intelligence_scope/u);
  assert.match(schema, /UNIQUE KEY uk_acquisition_candidate_intelligence_idempotency/u);
  assert.match(schema, /KEY idx_acquisition_candidate_intelligence_latest/u);
  assert.match(schema, /KEY idx_acquisition_candidate_intelligence_recovery/u);
  assert.match(schema, /chk_acquisition_candidate_intelligence_status/u);
  assert.match(schema, /chk_acquisition_candidate_intelligence_lease/u);
});

test("candidate intelligence operations are created and retrieved only through tenant-scoped keys", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));

  const created = await repository.createOperation(queuedOperation);

  assert.deepEqual(created, {
    operation: queuedOperation,
    created: true
  });
  assert.match(
    pool.calls.at(-1)!.sql,
    /INSERT INTO acquisition_candidate_intelligence_operations/u
  );
  const insert = pool.calls.at(-1)!;
  const columnList = insert.sql
    .match(/operations \((.*?)\) VALUES/u)?.[1]
    ?.split(",")
    .map((column) => column.trim());
  assert.ok(columnList);
  assert.equal(
    new Set(columnList).size,
    columnList.length,
    "INSERT columns must not be duplicated"
  );
  assert.equal(columnList.length, insert.values.length);

  pool.enqueue([mysqlRow(queuedOperation)]);
  assert.deepEqual(await repository.findOperationByIdempotency({
    ownerId: "owner-a",
    teamId: "team-a",
    idempotencyKeyHash: queuedOperation.idempotencyKeyHash
  }), queuedOperation);
  const byIdempotency = pool.calls.at(-1)!;
  assert.match(byIdempotency.sql, /owner_id = \?/u);
  assert.match(byIdempotency.sql, /team_id = \?/u);
  assert.deepEqual(byIdempotency.values, [
    "owner-a",
    "team-a",
    queuedOperation.idempotencyKeyHash
  ]);

  pool.enqueue([mysqlRow(queuedOperation)]);
  assert.deepEqual(await repository.getOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id
  ), queuedOperation);
  const byId = pool.calls.at(-1)!;
  assert.deepEqual(byId.values, [
    queuedOperation.id,
    "owner-a",
    "team-a"
  ]);

  pool.enqueue([]);
  assert.equal(await repository.getOperation(
    { ownerId: "other-owner", teamId: "team-a" },
    queuedOperation.id
  ), null);
});

test("candidate intelligence reads datetime columns as explicit UTC text", async () => {
  const running = {
    ...queuedOperation,
    status: "running" as const,
    startedAt: "2026-08-07T02:01:00.000Z",
    updatedAt: "2026-08-07T02:01:00.000Z",
    leaseOwner: "worker-a",
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-07T02:11:00.000Z"
  };
  const pool = new FakePool();
  pool.query = async function query(
    sql: string,
    values: unknown[] = []
  ) {
    const normalizedSql = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalizedSql, values });
    const selectsUtcText = [
      "lease_expires_at",
      "created_at",
      "updated_at"
    ].every((column) => new RegExp(
      `DATE_FORMAT\\(${column}, .*?\\) AS ${column}`,
      "u"
    ).test(normalizedSql));
    return [[mysqlRow(running, selectsUtcText
      ? {
          lease_expires_at: "2026-08-07T02:11:00.000000Z",
          created_at: "2026-08-07T02:00:00.000000Z",
          updated_at: "2026-08-07T02:01:00.000000Z"
        }
      : {
          // mysql2 parses a timezone-less DATETIME in the process timezone.
          // These Dates model Asia/Shanghai interpreting the stored UTC wall
          // clock eight hours behind the intended instant.
          lease_expires_at: new Date("2026-08-06T18:11:00.000Z"),
          created_at: new Date("2026-08-06T18:00:00.000Z"),
          updated_at: new Date("2026-08-06T18:01:00.000Z")
        })], []];
  };
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));

  assert.deepEqual(await repository.getOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    running.id
  ), running);
});

test("latest candidate intelligence lookup is tenant-scoped and deterministically ordered", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));
  pool.enqueue([mysqlRow(queuedOperation)]);

  const latest = await repository.findLatestForCandidate(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.candidateId
  );

  assert.deepEqual(latest, queuedOperation);
  const query = pool.calls.at(-1)!;
  assert.match(query.sql, /owner_id = \? AND team_id = \?/u);
  assert.match(query.sql, /candidate_id = \?/u);
  assert.match(query.sql, /ORDER BY created_at DESC, id DESC LIMIT 1/u);
  assert.deepEqual(query.values, [
    "owner-a",
    "team-a",
    queuedOperation.candidateId
  ]);
});

test("duplicate idempotency replays the same request and rejects a different request", async () => {
  const duplicate = Object.assign(new Error("duplicate"), {
    errno: 1062,
    code: "ER_DUP_ENTRY"
  });
  for (const sameRequest of [true, false]) {
    const pool = new FakePool();
    pool.query = async function query(
      sql: string,
      values: unknown[] = []
    ) {
      this.calls.push({
        sql: sql.replace(/\s+/gu, " ").trim(),
        values
      });
      if (sql.includes("INSERT INTO")) throw duplicate;
      const stored = {
        ...queuedOperation,
        requestHash: sameRequest
          ? queuedOperation.requestHash
          : `sha256:${"d".repeat(64)}`
      };
      return [[mysqlRow(stored)], []];
    };
    const repository =
      new MysqlAcquisitionCandidateIntelligenceOperationRepository(
        asPool(pool)
      );

    if (sameRequest) {
      assert.deepEqual(await repository.createOperation(queuedOperation), {
        operation: queuedOperation,
        created: false
      });
    } else {
      await assert.rejects(
        repository.createOperation(queuedOperation),
        (error: unknown) =>
          error instanceof AcquisitionCandidateIntelligenceOperationError
          && error.code === "IDEMPOTENCY_CONFLICT"
      );
    }
  }
});

test("retry command idempotency is tenant-scoped, durable, and conflicts across operations", async () => {
  const command = {
    ownerId: "owner-a",
    teamId: "team-a",
    operationId: queuedOperation.id,
    idempotencyKeyHash: "e".repeat(64),
    requestHash: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-08-07T02:05:00.000Z"
  };
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));
  const failedOperation = {
    ...queuedOperation,
    status: "failed" as const,
    currentStage: "qualification" as const,
    failure: {
      stage: "qualification" as const,
      errorCode: "MODEL_TIMEOUT"
    },
    failedAt: command.createdAt,
    updatedAt: command.createdAt
  };
  const retriedOperation = {
    ...failedOperation,
    status: "queued" as const,
    currentStage: null,
    failure: null,
    failedAt: null
  };
  pool.enqueue([mysqlRow(failedOperation)]);
  pool.enqueue([]);

  assert.deepEqual(await repository.registerRetryCommand(command), {
    command,
    operation: retriedOperation,
    created: true
  });
  const insert = pool.calls.find((call) =>
    /INSERT INTO acquisition_candidate_intelligence_retry_commands/u
      .test(call.sql))!;
  assert.match(
    insert.sql,
    /INSERT INTO acquisition_candidate_intelligence_retry_commands/u
  );
  assert.deepEqual(insert.values, [
    command.ownerId,
    command.teamId,
    command.idempotencyKeyHash,
    command.operationId,
    command.requestHash,
    mysqlDate(command.createdAt)
  ]);
  const requeue = pool.calls.find((call) =>
    /UPDATE acquisition_candidate_intelligence_operations/u.test(call.sql))!;
  assert.match(requeue.sql, /status = 'queued'/u);
  assert.deepEqual(pool.transactions, ["begin", "commit", "release"]);

  for (const sameRequest of [true, false]) {
    const replayPool = new FakePool();
    replayPool.query = async function query(
      sql: string,
      values: unknown[] = []
    ) {
      this.calls.push({
        sql: sql.replace(/\s+/gu, " ").trim(),
        values
      });
      if (sql.includes("FROM acquisition_candidate_intelligence_retry_commands")) {
        return [[{
          owner_id: command.ownerId,
          team_id: command.teamId,
          operation_id: sameRequest
            ? command.operationId
            : "candidate-intelligence-other",
          idempotency_key_hash: command.idempotencyKeyHash,
          request_hash: sameRequest
            ? command.requestHash
            : `sha256:${"1".repeat(64)}`,
          created_at: mysqlDate(command.createdAt)
        }], []];
      }
      return [[mysqlRow(retriedOperation)], []];
    };
    const replayRepository =
      new MysqlAcquisitionCandidateIntelligenceOperationRepository(
        asPool(replayPool)
      );
    if (sameRequest) {
      assert.deepEqual(
        await replayRepository.registerRetryCommand(command),
        { command, operation: retriedOperation, created: false }
      );
    } else {
      await assert.rejects(
        replayRepository.registerRetryCommand(command),
        (error: unknown) =>
          error instanceof AcquisitionCandidateIntelligenceOperationError
          && error.code === "IDEMPOTENCY_CONFLICT"
      );
    }
    const lookup = replayPool.calls.find((call) =>
      /FROM acquisition_candidate_intelligence_retry_commands/u
        .test(call.sql))!;
    assert.match(lookup.sql, /owner_id = \? AND team_id = \?/u);
    assert.deepEqual(lookup.values, [
      command.ownerId,
      command.teamId,
      command.idempotencyKeyHash
    ]);
    assert.deepEqual(
      replayPool.transactions,
      sameRequest
        ? ["begin", "commit", "release"]
        : ["begin", "rollback", "release"]
    );
  }
});

test("concurrent retry-key insertion replays the committed winner instead of leaking duplicate-key errors", async () => {
  const duplicate = Object.assign(new Error("duplicate"), {
    errno: 1062,
    code: "ER_DUP_ENTRY"
  });
  const command = {
    ownerId: "owner-a",
    teamId: "team-a",
    operationId: queuedOperation.id,
    idempotencyKeyHash: "9".repeat(64),
    requestHash: `sha256:${"8".repeat(64)}`,
    createdAt: "2026-08-07T02:06:00.000Z"
  };
  for (const sameRequest of [true, false]) {
    const pool = new FakePool();
    let retryLookups = 0;
    pool.query = async function query(
      sql: string,
      values: unknown[] = []
    ) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      this.calls.push({ sql: normalized, values });
      if (sql.includes("FROM acquisition_candidate_intelligence_operations")) {
        return [[mysqlRow(queuedOperation)], []];
      }
      if (sql.includes("FROM acquisition_candidate_intelligence_retry_commands")) {
        retryLookups += 1;
        if (retryLookups === 1) return [[], []];
        return [[{
          owner_id: command.ownerId,
          team_id: command.teamId,
          operation_id: sameRequest
            ? command.operationId
            : "candidate-intelligence-other",
          idempotency_key_hash: command.idempotencyKeyHash,
          request_hash: sameRequest
            ? command.requestHash
            : `sha256:${"7".repeat(64)}`,
          created_at: mysqlDate(command.createdAt)
        }], []];
      }
      if (sql.includes("INSERT INTO acquisition_candidate_intelligence_retry_commands")) {
        throw duplicate;
      }
      return [{ affectedRows: 1 }, []];
    };
    const repository =
      new MysqlAcquisitionCandidateIntelligenceOperationRepository(
        asPool(pool)
      );

    if (sameRequest) {
      assert.deepEqual(await repository.registerRetryCommand(command), {
        command,
        operation: queuedOperation,
        created: false
      });
    } else {
      await assert.rejects(
        repository.registerRetryCommand(command),
        (error: unknown) =>
          error instanceof AcquisitionCandidateIntelligenceOperationError
          && error.code === "IDEMPOTENCY_CONFLICT"
      );
    }
    assert.deepEqual(pool.transactions, ["begin", "rollback", "release"]);
  }
});

test("recovery lists only queued and expired-running operations oldest first", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));
  pool.enqueue([
    mysqlRow(queuedOperation),
    mysqlRow({
      ...queuedOperation,
      id: "candidate-intelligence-expired",
      status: "running",
      leaseOwner: "worker-old",
      leaseToken: "lease-old",
      leaseExpiresAt: "2026-08-07T02:01:00.000Z"
    })
  ]);

  const operations = await repository.listRecoverableOperations({
    now: "2026-08-07T02:02:00.000Z",
    limit: 25
  });

  assert.deepEqual(operations.map((operation) => operation.id), [
    queuedOperation.id,
    "candidate-intelligence-expired"
  ]);
  const query = pool.calls.at(-1)!;
  assert.match(query.sql, /status = 'queued'/u);
  assert.match(
    query.sql,
    /status = 'running' AND lease_expires_at <= \?/u
  );
  assert.doesNotMatch(query.sql, /lease_expires_at IS NULL/u);
  assert.match(query.sql, /ORDER BY created_at ASC, id ASC LIMIT \?/u);
  assert.deepEqual(query.values, ["2026-08-07 02:02:00.000", 25]);
});

test("claim atomically fences queued, failed, or expired-running work by tenant", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));
  const running = {
    ...queuedOperation,
    status: "running" as const,
    startedAt: "2026-08-07T02:02:00.000Z",
    updatedAt: "2026-08-07T02:02:00.000Z",
    leaseOwner: "worker-a",
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-07T02:12:00.000Z"
  };
  pool.enqueue({ affectedRows: 1 });
  pool.enqueue([mysqlRow(running)]);

  const claimed = await repository.claimOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      claimedAt: "2026-08-07T02:02:00.000Z",
      leaseExpiresAt: "2026-08-07T02:12:00.000Z"
    }
  );

  assert.deepEqual(claimed, { operation: running, claimed: true });
  const update = pool.calls[0]!;
  assert.match(update.sql, /UPDATE acquisition_candidate_intelligence_operations/u);
  assert.match(update.sql, /status IN \('queued','failed'\)/u);
  assert.match(update.sql, /status = 'running' AND lease_expires_at <= \?/u);
  assert.match(update.sql, /owner_id = \? AND team_id = \?/u);
  assert.match(update.sql, /payload_json = JSON_SET/u);
  assert.deepEqual(update.values.slice(-4), [
    queuedOperation.id,
    "owner-a",
    "team-a",
    "2026-08-07 02:02:00.000"
  ]);
});

test("lease-token CAS saves preserve a renewed running lease and release it only at terminal state", async () => {
  const running = {
    ...queuedOperation,
    status: "running" as const,
    startedAt: "2026-08-07T02:02:00.000Z",
    updatedAt: "2026-08-07T02:03:00.000Z",
    leaseOwner: "worker-a",
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-07T02:12:00.000Z",
    currentStage: "research" as const
  };
  const runningPool = new FakePool();
  const runningRepository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(
      asPool(runningPool)
    );
  runningPool.enqueue({ affectedRows: 1 });

  await runningRepository.saveOperation(running, "lease-a");

  const runningSave = runningPool.calls.at(-1)!;
  assert.match(runningSave.sql, /status = 'running'/u);
  assert.match(
    runningSave.sql,
    /JSON_EXTRACT\(\s*payload_json, '\$\.leaseExpiresAt'/u
  );
  assert.doesNotMatch(runningSave.sql, /lease_owner = NULL/u);
  assert.match(runningSave.sql, /status = 'running' AND lease_token = \?/u);
  assert.equal(runningSave.values.at(-1), "lease-a");

  const terminalPool = new FakePool();
  const terminalRepository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(
      asPool(terminalPool)
    );
  terminalPool.enqueue({ affectedRows: 1 });
  await terminalRepository.saveOperation({
    ...running,
    status: "succeeded",
    currentStage: null,
    completedStages: ["research", "qualification", "battle_card"],
    completedAt: "2026-08-07T02:04:00.000Z",
    updatedAt: "2026-08-07T02:04:00.000Z"
  }, "lease-a");

  const terminalSave = terminalPool.calls.at(-1)!;
  assert.match(terminalSave.sql, /lease_owner = NULL/u);
  assert.match(terminalSave.sql, /lease_token = NULL/u);
  assert.match(terminalSave.sql, /lease_expires_at = NULL/u);
  const terminalPayload = JSON.parse(String(terminalSave.values[1]));
  assert.deepEqual({
    leaseOwner: terminalPayload.leaseOwner,
    leaseToken: terminalPayload.leaseToken,
    leaseExpiresAt: terminalPayload.leaseExpiresAt
  }, {
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null
  });
});

test("lease renewal is tenant-scoped, token-fenced, and cannot revive an expired lease", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionCandidateIntelligenceOperationRepository(asPool(pool));
  pool.enqueue({ affectedRows: 1 });

  assert.equal(await repository.renewLease(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    "lease-a",
    {
      renewedAt: "2026-08-07T02:03:00.000Z",
      leaseExpiresAt: "2026-08-07T02:13:00.000Z"
    }
  ), true);

  const update = pool.calls.at(-1)!;
  assert.match(update.sql, /status = 'running' AND lease_token = \?/u);
  assert.match(update.sql, /lease_expires_at > \?/u);
  assert.match(update.sql, /owner_id = \? AND team_id = \?/u);
  assert.match(update.sql, /'\$\.leaseExpiresAt', \?/u);
  assert.deepEqual(update.values.slice(0, 4), [
    "2026-08-07 02:13:00.000",
    "2026-08-07T02:13:00.000Z",
    "2026-08-07T02:03:00.000Z",
    "2026-08-07 02:03:00.000"
  ]);
  assert.deepEqual(update.values.slice(-5), [
    queuedOperation.id,
    "owner-a",
    "team-a",
    "lease-a",
    "2026-08-07 02:03:00.000"
  ]);

  pool.enqueue({ affectedRows: 0 });
  assert.equal(await repository.renewLease(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    "stale-lease",
    {
      renewedAt: "2026-08-07T02:14:00.000Z",
      leaseExpiresAt: "2026-08-07T02:24:00.000Z"
    }
  ), false);
});

test("reads reject malformed payloads and every indexed-column drift", async () => {
  const runningWithoutLease = {
    ...queuedOperation,
    status: "running" as const
  };
  const cases: Array<{
    row: Record<string, unknown>;
    error: RegExp;
  }> = [
    {
      row: mysqlRow(queuedOperation, { payload_json: "not-json" }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:invalid_json/u
    },
    {
      row: mysqlRow(queuedOperation, { owner_id: "owner-b" }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:owner_id_mismatch/u
    },
    {
      row: mysqlRow(queuedOperation, { candidate_id: "candidate-b" }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:candidate_id_mismatch/u
    },
    {
      row: mysqlRow(queuedOperation, { status: "succeeded" }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:status_mismatch/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        requestHash: "invalid-request-hash"
      }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:request_hash/u
    },
    {
      row: mysqlRow(runningWithoutLease),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:lease_state/u
    },
    {
      row: mysqlRow(queuedOperation, {
        updated_at: "2026-08-07 02:00:01.000"
      }),
      error: /ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:updated_at_mismatch/u
    }
  ];

  for (const item of cases) {
    const pool = new FakePool();
    const repository =
      new MysqlAcquisitionCandidateIntelligenceOperationRepository(
        asPool(pool)
      );
    pool.enqueue([item.row]);

    await assert.rejects(
      repository.getOperation(
        { ownerId: "owner-a", teamId: "team-a" },
        queuedOperation.id
      ),
      item.error
    );
  }
});
