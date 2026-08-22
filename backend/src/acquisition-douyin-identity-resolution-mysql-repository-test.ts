import assert from "node:assert/strict";
import test from "node:test";
import type mysql from "mysql2/promise";
import {
  AcquisitionDouyinIdentityResolutionOperationError,
  type AcquisitionDouyinIdentityResolutionOperationRecord
} from "./acquisition-douyin-identity-resolution-operations.js";
import {
  ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionDouyinIdentityResolutionOperationRepository,
  ensureAcquisitionDouyinIdentityResolutionMysqlSchema
} from "./acquisition-douyin-identity-resolution-mysql-repository.js";

class FakePool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly queue: Array<[unknown, unknown]> = [];

  enqueue(rows: unknown) {
    this.queue.push([rows, []]);
  }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
    if (sql.includes(
      "INSERT INTO acquisition_douyin_identity_resolution_idempotency_locks"
    )) {
      return [{ affectedRows: 1 }, []];
    }
    return this.queue.shift() ?? [{ affectedRows: 1 }, []];
  }

  async getConnection() {
    return this as unknown as mysql.PoolConnection;
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

class ConcurrentLifecyclePool {
  readonly calls: string[] = [];
  readonly operations: AcquisitionDouyinIdentityResolutionOperationRecord[] = [];
  private lockTail = Promise.resolve();

  async query(sql: string, values: unknown[] = []) {
    this.calls.push(sql.replace(/\s+/gu, " ").trim());
    if (sql.includes("INSERT INTO")) {
      this.operations.push(JSON.parse(String(values[13])));
    }
    return [{ affectedRows: 1 }, []] as [unknown, unknown];
  }

  async getConnection() {
    let releaseLock!: () => void;
    const previous = this.lockTail;
    this.lockTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let ownsLock = false;
    return {
      beginTransaction: async () => {},
      query: async (sql: string, values: unknown[] = []) => {
        this.calls.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes(
          "INSERT INTO acquisition_douyin_identity_resolution_idempotency_locks"
        )) {
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("FROM acquisition_candidates")
          && sql.includes("FOR UPDATE")) {
          await previous;
          ownsLock = true;
          return [[{ id: values[2] }], []];
        }
        if (sql.includes("idempotency_key_hash = ?")) {
          const operation = this.operations.find((item) =>
            item.ownerId === values[0]
            && item.teamId === values[1]
            && item.idempotencyKeyHash === values[2]);
          return [operation ? [mysqlRow(operation)] : [], []];
        }
        if (sql.includes("JSON_EXTRACT(payload_json")) {
          const blocking = this.operations
            .find((item) => item.ownerId === values[0]
              && item.teamId === values[1]
              && item.candidateId === values[2]
              && !(item.status === "failed"
                && item.retryable
                && item.outcome === "provider_unavailable"));
          return [blocking ? [{ id: blocking.id }] : [], []];
        }
        if (sql.includes(
          "INSERT INTO acquisition_douyin_identity_resolution_operations"
        )) {
          this.operations.push(JSON.parse(String(values[13])));
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
      commit: async () => {
        if (ownsLock) releaseLock();
        ownsLock = false;
      },
      rollback: async () => {
        if (ownsLock) releaseLock();
        ownsLock = false;
      },
      release: () => {
        if (ownsLock) releaseLock();
        ownsLock = false;
      }
    } as unknown as mysql.PoolConnection;
  }
}

class CrossCandidateIdempotencyPool {
  readonly calls: string[] = [];
  readonly operations: AcquisitionDouyinIdentityResolutionOperationRecord[] = [];
  private readonly candidateTails = new Map<string, Promise<void>>();
  private readonly idempotencyTails = new Map<string, Promise<void>>();
  private readonly gapWaiters = new Map<string, Array<{
    connectionId: number;
    resolve: (result: [unknown, unknown]) => void;
  }>>();
  private readonly deadlockVictims = new Map<string, number>();
  private connectionSequence = 0;

  async query() {
    return [{ affectedRows: 1 }, []] as [unknown, unknown];
  }

  async getConnection() {
    const connectionId = ++this.connectionSequence;
    const releases: Array<() => void> = [];
    let pending: AcquisitionDouyinIdentityResolutionOperationRecord | null = null;
    const acquire = async (
      tails: Map<string, Promise<void>>,
      key: string
    ) => {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, current);
      await previous;
      releases.push(release);
    };
    const releaseAll = () => {
      for (const release of releases.splice(0)) release();
    };
    return {
      beginTransaction: async () => {},
      query: async (sql: string, values: unknown[] = []) => {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        this.calls.push(normalized);
        if (normalized.includes(
          "INSERT INTO acquisition_douyin_identity_resolution_idempotency_locks"
        )) {
          await acquire(
            this.idempotencyTails,
            `${values[0]}:${values[1]}:${values[2]}`
          );
          return [{ affectedRows: 1 }, []];
        }
        if (normalized.includes("FROM acquisition_candidates")
          && normalized.includes("FOR UPDATE")) {
          await acquire(
            this.candidateTails,
            `${values[0]}:${values[1]}:${values[2]}`
          );
          return [[{ id: values[2] }], []];
        }
        if (normalized.includes(
          "FROM acquisition_douyin_identity_resolution_operations"
        ) && normalized.includes("idempotency_key_hash = ?")) {
          const key = `${values[0]}:${values[1]}:${values[2]}`;
          const operation = this.operations.find((item) =>
            item.ownerId === values[0]
            && item.teamId === values[1]
            && item.idempotencyKeyHash === values[2]);
          if (operation) return [[mysqlRow(operation)], []];
          if (!normalized.includes("FOR UPDATE")) return [[], []];
          return new Promise<[unknown, unknown]>((resolve) => {
            const waiters = this.gapWaiters.get(key) ?? [];
            waiters.push({ connectionId, resolve });
            this.gapWaiters.set(key, waiters);
            if (waiters.length === 2) {
              this.deadlockVictims.set(
                key,
                Math.max(...waiters.map((waiter) => waiter.connectionId))
              );
              for (const waiter of waiters) waiter.resolve([[], []]);
            }
          });
        }
        if (normalized.includes("JSON_EXTRACT(payload_json")) {
          const blocking = this.operations.find((item) =>
            item.ownerId === values[0]
            && item.teamId === values[1]
            && item.candidateId === values[2]
            && !(item.status === "failed"
              && item.retryable
              && item.outcome === "provider_unavailable"));
          return [blocking ? [{ id: blocking.id }] : [], []];
        }
        if (normalized.includes(
          "INSERT INTO acquisition_douyin_identity_resolution_operations"
        )) {
          const operation = JSON.parse(String(values[13])) as
            AcquisitionDouyinIdentityResolutionOperationRecord;
          const key = `${operation.ownerId}:${operation.teamId}:${operation.idempotencyKeyHash}`;
          if (this.deadlockVictims.get(key) === connectionId) {
            throw Object.assign(new Error("simulated insert-intention deadlock"), {
              errno: 1213,
              code: "ER_LOCK_DEADLOCK"
            });
          }
          pending = operation;
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
      commit: async () => {
        if (pending) this.operations.push(pending);
        pending = null;
        releaseAll();
      },
      rollback: async () => {
        pending = null;
        releaseAll();
      },
      release: releaseAll
    } as unknown as mysql.PoolConnection;
  }
}

function asPool(pool: FakePool) {
  return pool as unknown as mysql.Pool;
}

const queuedOperation: AcquisitionDouyinIdentityResolutionOperationRecord = {
  id: "douyin-identity-resolution-1",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "actor-a",
  candidateId: "candidate-a",
  candidateVersion: 3,
  sourceEvidenceFingerprint: `sha256:${"a".repeat(64)}`,
  searchConnections: [{
    connectionId: "search-connection-1",
    providerId: "baidu-search",
    kind: "search",
    status: "active",
    credentialVersion: 3
  }],
  planSessionId: "acquisition-plan:run-1",
  status: "queued",
  currentStage: null,
  outcome: null,
  retryable: false,
  canonicalProfileUrl: null,
  profileCandidates: [],
  evidence: [],
  intelligenceOperationId: null,
  idempotencyKeyHash: "b".repeat(64),
  requestHash: `sha256:${"c".repeat(64)}`,
  leaseOwner: null,
  leaseToken: null,
  leaseExpiresAt: null,
  createdAt: "2026-08-08T02:00:00.000Z",
  updatedAt: "2026-08-08T02:00:00.000Z",
  completedAt: null
};

function mysqlDate(value: string) {
  return value.slice(0, 23).replace("T", " ");
}

function mysqlRow(
  operation: AcquisitionDouyinIdentityResolutionOperationRecord,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: operation.id,
    owner_id: operation.ownerId,
    team_id: operation.teamId,
    actor_id: operation.actorId,
    candidate_id: operation.candidateId,
    candidate_version: operation.candidateVersion,
    source_evidence_fingerprint: operation.sourceEvidenceFingerprint,
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

test("Douyin identity operation schema creates tenant, lease, latest, and recovery invariants", async () => {
  const pool = new FakePool();

  await ensureAcquisitionDouyinIdentityResolutionMysqlSchema(asPool(pool));

  assert.equal(
    pool.calls.length,
    ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_SCHEMA_STATEMENTS.length
  );
  const schema = pool.calls.map((call) => call.sql).join("\n");
  assert.match(schema, /PRIMARY KEY \(id\)/u);
  assert.match(schema, /candidate_id VARCHAR\(120\) NOT NULL/u);
  assert.match(schema, /UNIQUE KEY uk_douyin_identity_resolution_idempotency\s*\(owner_id, team_id, idempotency_key_hash\)/u);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS acquisition_douyin_identity_resolution_idempotency_locks/u);
  assert.match(schema, /PRIMARY KEY \(owner_id, team_id, idempotency_key_hash\)/u);
  assert.match(schema, /KEY idx_douyin_identity_resolution_latest\s*\(owner_id, team_id, candidate_id, created_at, id\)/u);
  assert.match(schema, /KEY idx_douyin_identity_resolution_recovery\s*\(status, lease_expires_at, created_at, id\)/u);
  for (const status of [
    "queued",
    "running",
    "succeeded",
    "requires_review",
    "failed"
  ]) {
    assert.match(schema, new RegExp(`'${status}'`, "u"));
  }
});

test("MySQL create and idempotency replay are tenant and candidate scoped", async () => {
  const createdPool = new FakePool();
  createdPool.enqueue([]);
  createdPool.enqueue([{ id: queuedOperation.candidateId }]);
  createdPool.enqueue([]);
  const createdRepository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(createdPool)
    );
  assert.deepEqual(await createdRepository.createOperation(queuedOperation), {
    operation: queuedOperation,
    created: true
  });
  const insert = createdPool.calls.find((call) => call.sql.includes(
    "INSERT INTO acquisition_douyin_identity_resolution_operations"
  ));
  assert.ok(insert);
  assert.equal(
    insert.sql.match(/operations \((.*?)\) VALUES/u)?.[1]
      ?.split(",").length,
    insert.values.length
  );

  for (const sameCandidate of [true, false]) {
    const pool = new FakePool();
    pool.enqueue([mysqlRow(queuedOperation)]);
    const repository =
      new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
        asPool(pool)
      );
    const incoming = {
      ...queuedOperation,
      candidateId: sameCandidate ? queuedOperation.candidateId : "candidate-b",
      requestHash: `sha256:${"d".repeat(64)}`
    };
    if (sameCandidate) {
      assert.equal(
        (await repository.createOperation(incoming)).created,
        false
      );
    } else {
      await assert.rejects(
        repository.createOperation(incoming),
        (error: unknown) =>
          error instanceof AcquisitionDouyinIdentityResolutionOperationError
          && error.code === "IDEMPOTENCY_CONFLICT"
      );
    }
    const lookup = pool.calls.find((call) =>
      call.sql.includes("idempotency_key_hash = ?"))!;
    assert.deepEqual(lookup.values, [
      queuedOperation.ownerId,
      queuedOperation.teamId,
      queuedOperation.idempotencyKeyHash
    ]);
  }
});

test("MySQL candidate row lock admits exactly one concurrent lifecycle", async () => {
  const pool = new ConcurrentLifecyclePool();
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      pool as unknown as mysql.Pool
    );
  const second = {
    ...queuedOperation,
    id: "douyin-identity-resolution-2",
    idempotencyKeyHash: "d".repeat(64),
    requestHash: `sha256:${"e".repeat(64)}`
  };

  const results = await Promise.allSettled([
    repository.createOperation(queuedOperation),
    repository.createOperation(second)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection && rejection.status === "rejected");
  assert.equal(
    rejection.reason instanceof AcquisitionDouyinIdentityResolutionOperationError
      ? rejection.reason.code
      : null,
    "OPERATION_ALREADY_RUNNING"
  );
  assert.equal(pool.operations.length, 1);
  assert.equal(pool.calls.filter((sql) =>
    sql.includes("FROM acquisition_candidates")
    && sql.includes("FOR UPDATE")).length, 2);
});

test("MySQL same idempotency key across candidates cannot surface a deadlock", async () => {
  const pool = new CrossCandidateIdempotencyPool();
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      pool as unknown as mysql.Pool
    );
  const otherCandidate = {
    ...queuedOperation,
    id: "douyin-identity-resolution-other-candidate",
    candidateId: "candidate-b",
    requestHash: `sha256:${"e".repeat(64)}`
  };

  const results = await Promise.allSettled([
    repository.createOperation(queuedOperation),
    repository.createOperation(otherCandidate)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection && rejection.status === "rejected");
  assert.equal(
    rejection.reason instanceof AcquisitionDouyinIdentityResolutionOperationError
      ? rejection.reason.code
      : null,
    "IDEMPOTENCY_CONFLICT"
  );
  assert.equal(pool.operations.length, 1);
  const reservationIndex = pool.calls.findIndex((sql) => sql.includes(
    "INSERT INTO acquisition_douyin_identity_resolution_idempotency_locks"
  ));
  const candidateLockIndex = pool.calls.findIndex((sql) =>
    sql.includes("FROM acquisition_candidates")
    && sql.includes("FOR UPDATE"));
  assert.ok(reservationIndex >= 0 && reservationIndex < candidateLockIndex);
  for (const sql of pool.calls.filter((call) =>
    call.includes("idempotency_key_hash = ?"))) {
    assert.doesNotMatch(sql, /FOR UPDATE/u);
  }
});

test("MySQL candidate gate admits one retry after provider_unavailable", async () => {
  const pool = new ConcurrentLifecyclePool();
  pool.operations.push({
    ...queuedOperation,
    id: "douyin-identity-resolution-terminal",
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true,
    idempotencyKeyHash: "f".repeat(64),
    completedAt: "2026-08-08T02:01:00.000Z"
  });
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      pool as unknown as mysql.Pool
    );
  const second = {
    ...queuedOperation,
    id: "douyin-identity-resolution-2",
    idempotencyKeyHash: "d".repeat(64),
    requestHash: `sha256:${"e".repeat(64)}`
  };

  const results = await Promise.allSettled([
    repository.createOperation(queuedOperation),
    repository.createOperation(second)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(pool.operations.length, 2);
});

test("MySQL latest candidate lookup is tenant scoped and deterministic", async () => {
  const pool = new FakePool();
  pool.enqueue([mysqlRow(queuedOperation)]);
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(pool)
    );

  assert.deepEqual(await repository.findLatestForCandidate(
    { ownerId: "owner-a", teamId: "team-a" },
    "candidate-a"
  ), queuedOperation);
  assert.match(pool.calls[0]!.sql, /owner_id = \? AND team_id = \? AND candidate_id = \?/u);
  assert.match(pool.calls[0]!.sql, /ORDER BY created_at DESC, id DESC LIMIT 1/u);
  assert.deepEqual(pool.calls[0]!.values, [
    "owner-a",
    "team-a",
    "candidate-a"
  ]);
});

test("MySQL successful Run ownership lookup is tenant and session scoped", async () => {
  const succeeded = {
    ...queuedOperation,
    status: "succeeded" as const,
    outcome: "verified_consensus" as const,
    intelligenceOperationId: "candidate-intelligence-1",
    completedAt: "2026-08-08T02:01:00.000Z"
  };
  const pool = new FakePool();
  pool.enqueue([mysqlRow(succeeded)]);
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(pool)
    );

  assert.deepEqual(await repository
    .findSucceededForCandidateAndPlanSession(
      { ownerId: "owner-a", teamId: "team-a" },
      "candidate-a",
      "acquisition-plan:run-1"
    ), succeeded);
  assert.match(pool.calls[0]!.sql, /status = 'succeeded'/u);
  assert.match(pool.calls[0]!.sql, /\$\.planSessionId/u);
  assert.match(pool.calls[0]!.sql, /\$\.intelligenceOperationId/u);
  assert.deepEqual(pool.calls[0]!.values, [
    "owner-a",
    "team-a",
    "candidate-a",
    "acquisition-plan:run-1"
  ]);
});

test("MySQL recovery selects queued and expired-running operations oldest first", async () => {
  const expired = {
    ...queuedOperation,
    id: "douyin-identity-resolution-expired",
    status: "running" as const,
    leaseOwner: "worker-old",
    leaseToken: "lease-old",
    leaseExpiresAt: "2026-08-08T02:01:00.000Z"
  };
  const pool = new FakePool();
  pool.enqueue([mysqlRow(queuedOperation), mysqlRow(expired)]);
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(pool)
    );

  const operations = await repository.listRecoverableOperations({
    now: "2026-08-08T02:02:00.000Z",
    limit: 25
  });

  assert.deepEqual(operations.map((operation) => operation.id), [
    queuedOperation.id,
    expired.id
  ]);
  assert.match(pool.calls[0]!.sql, /status = 'queued'/u);
  assert.match(pool.calls[0]!.sql, /status = 'running' AND lease_expires_at <= \?/u);
  assert.match(pool.calls[0]!.sql, /ORDER BY created_at ASC, id ASC LIMIT \?/u);
  assert.deepEqual(pool.calls[0]!.values, ["2026-08-08 02:02:00.000", 25]);
});

test("MySQL claim, save, and renewal are tenant and lease-token fenced", async () => {
  const running = {
    ...queuedOperation,
    status: "running" as const,
    updatedAt: "2026-08-08T02:01:00.000Z",
    leaseOwner: "worker-a",
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-08T02:11:00.000Z"
  };
  const claimPool = new FakePool();
  claimPool.enqueue({ affectedRows: 1 });
  claimPool.enqueue([mysqlRow(running)]);
  const claimRepository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(claimPool)
    );
  assert.equal((await claimRepository.claimOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      claimedAt: "2026-08-08T02:01:00.000Z",
      leaseExpiresAt: "2026-08-08T02:11:00.000Z"
    }
  )).claimed, true);
  assert.match(claimPool.calls[0]!.sql, /status = 'queued'/u);
  assert.doesNotMatch(claimPool.calls[0]!.sql, /status IN \('queued','failed'\)/u);
  assert.match(claimPool.calls[0]!.sql, /owner_id = \? AND team_id = \?/u);

  const savePool = new FakePool();
  savePool.enqueue({ affectedRows: 1 });
  const saveRepository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(savePool)
    );
  await saveRepository.saveOperation({
    ...running,
    status: "succeeded",
    outcome: "verified_consensus",
    updatedAt: "2026-08-08T02:02:00.000Z",
    completedAt: "2026-08-08T02:02:00.000Z"
  }, "lease-a");
  assert.match(savePool.calls[0]!.sql, /lease_owner = NULL/u);
  assert.match(savePool.calls[0]!.sql, /status = 'running' AND lease_token = \?/u);

  const renewPool = new FakePool();
  renewPool.enqueue({ affectedRows: 1 });
  const renewRepository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(renewPool)
    );
  assert.equal(await renewRepository.renewLease(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    "lease-a",
    {
      renewedAt: "2026-08-08T02:03:00.000Z",
      leaseExpiresAt: "2026-08-08T02:13:00.000Z"
    }
  ), true);
  assert.match(renewPool.calls[0]!.sql, /lease_expires_at > \?/u);
  assert.match(renewPool.calls[0]!.sql, /owner_id = \? AND team_id = \?/u);
});

test("MySQL claim does not report success when read-back has a replacement lease", async () => {
  const replaced = {
    ...queuedOperation,
    status: "running" as const,
    updatedAt: "2026-08-08T02:01:01.000Z",
    leaseOwner: "worker-b",
    leaseToken: "lease-b",
    leaseExpiresAt: "2026-08-08T02:11:01.000Z"
  };
  const pool = new FakePool();
  pool.enqueue({ affectedRows: 1 });
  pool.enqueue([mysqlRow(replaced)]);
  const repository =
    new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
      asPool(pool)
    );

  const result = await repository.claimOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    queuedOperation.id,
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      claimedAt: "2026-08-08T02:01:00.000Z",
      leaseExpiresAt: "2026-08-08T02:11:00.000Z"
    }
  );

  assert.equal(result.claimed, false);
  assert.match(pool.calls[1]!.sql, /lease_token = \?/u);
  assert.deepEqual(pool.calls[1]!.values, [
    queuedOperation.id,
    "owner-a",
    "team-a",
    "lease-a"
  ]);
});

test("MySQL reads fail closed on JSON and indexed-column mismatches", async () => {
  const cases = [
    {
      row: mysqlRow(queuedOperation, { payload_json: "not-json" }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:invalid_json/u
    },
    {
      row: mysqlRow(queuedOperation, { owner_id: "owner-b" }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:owner_id_mismatch/u
    },
    {
      row: mysqlRow(queuedOperation, { candidate_version: 4 }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:candidate_version_mismatch/u
    },
    {
      row: mysqlRow(queuedOperation, { status: "succeeded" }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:status_mismatch/u
    },
    {
      row: mysqlRow({ ...queuedOperation, requestHash: "invalid" }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:request_hash/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        planSessionId: "model-session:not-a-frozen-plan"
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:plan_session_id/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        searchConnections: [{
          connectionId: "search-connection-1",
          providerId: "",
          kind: "search",
          status: "active",
          credentialVersion: 3
        }]
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:search_connections/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        searchConnections: [{
          ...queuedOperation.searchConnections[0]!,
          kind: "content_fetch" as const
        }]
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:search_connections/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        searchConnections: [{
          ...queuedOperation.searchConnections[0]!,
          status: "inactive" as const
        }]
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:search_connections/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        searchConnections: [{
          connectionId: "search-connection-1",
          providerId: "baidu-search",
          kind: "search",
          status: "active",
          credentialVersion: 0
        }]
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:search_connections/u
    },
    {
      row: mysqlRow({
        ...queuedOperation,
        searchConnections: [
          queuedOperation.searchConnections[0]!,
          queuedOperation.searchConnections[0]!
        ]
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:search_connections/u
    },
    {
      row: mysqlRow({ ...queuedOperation, status: "running" }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:lease_state/u
    },
    {
      row: mysqlRow(queuedOperation, {
        updated_at: "2026-08-08 02:00:01.000"
      }),
      error: /ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:updated_at_mismatch/u
    }
  ];

  for (const item of cases) {
    const pool = new FakePool();
    pool.enqueue([item.row]);
    const repository =
      new MysqlAcquisitionDouyinIdentityResolutionOperationRepository(
        asPool(pool)
      );
    await assert.rejects(
      repository.getOperation(
        { ownerId: "owner-a", teamId: "team-a" },
        queuedOperation.id
      ),
      item.error
    );
  }
});
