import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import {
  AcquisitionDiscoveryOperationError,
  acquisitionContentFetchCommentExecutionId,
  type AcquisitionContentFetchCommentExecution,
  type AcquisitionContentFetchOperationRecord,
  type AcquisitionImportOperationRecord
} from "./acquisition-discovery-operations.js";
import {
  ACQUISITION_DISCOVERY_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionDiscoveryOperationRepository,
  ensureAcquisitionDiscoveryMysqlSchema
} from "./acquisition-discovery-mysql-repository.js";

class FakePool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly queue: Array<[unknown, unknown]> = [];

  enqueue(rows: unknown) {
    this.queue.push([rows, []]);
  }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({
      sql: sql.replace(/\s+/gu, " ").trim(),
      values
    });
    if (sql.includes("CHECK_CONSTRAINTS")) {
      return [[{
        check_clause:
          "status in ('queued','running','succeeded','partial_success','failed','access_restricted')"
      }], []];
    }
    return this.queue.shift() ?? [{ affectedRows: 1 }, []];
  }

  async getConnection() {
    return {
      query: (sql: string, values: unknown[] = []) => {
        if (sql.includes("GET_LOCK")) {
          this.calls.push({
            sql: sql.replace(/\s+/gu, " ").trim(),
            values
          });
          return Promise.resolve([[{ lock_acquired: 1 }], []]);
        }
        if (sql.includes("RELEASE_LOCK")) {
          this.calls.push({
            sql: sql.replace(/\s+/gu, " ").trim(),
            values
          });
          return Promise.resolve([[{ lock_released: 1 }], []]);
        }
        return this.query(sql, values);
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      destroy() {}
    };
  }
}

class StatefulFetchPool {
  readonly calls: string[] = [];
  operation: AcquisitionContentFetchOperationRecord;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(operation: AcquisitionContentFetchOperationRecord) {
    this.operation = structuredClone(operation);
  }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push(sql.replace(/\s+/gu, " ").trim());
    if (sql.includes("UPDATE acquisition_content_fetch_operations")
      && sql.includes("SET status = ?")) {
      this.operation = JSON.parse(String(values[1])) as
        AcquisitionContentFetchOperationRecord;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes("FROM acquisition_content_fetch_operations")) {
      const [id, ownerId, teamId] = values;
      return [[
        id === this.operation.id
          && ownerId === this.operation.ownerId
          && teamId === this.operation.teamId
          ? { payload_json: JSON.stringify(this.operation) }
          : undefined
      ].filter(Boolean), []];
    }
    return [{ affectedRows: 1 }, []];
  }

  async getConnection() {
    let unlock: (() => void) | null = null;
    return {
      beginTransaction: async () => {
        const previous = this.transactionTail;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.transactionTail = previous.then(() => current);
        await previous;
        unlock = release;
      },
      query: async (sql: string, values: unknown[] = []) => {
        this.calls.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("SELECT payload_json")
          && sql.includes("FOR UPDATE")) {
          const [id, ownerId, teamId] = values;
          const matches = id === this.operation.id
            && ownerId === this.operation.ownerId
            && teamId === this.operation.teamId;
          return [matches ? [{
            payload_json: JSON.stringify(this.operation)
          }] : [], []];
        }
        if (sql.includes("SET status = ?")) {
          this.operation = JSON.parse(String(values[1])) as
            AcquisitionContentFetchOperationRecord;
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("SET payload_json = ?")) {
          this.operation = JSON.parse(String(values[0])) as
            AcquisitionContentFetchOperationRecord;
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      commit: async () => {
        unlock?.();
        unlock = null;
      },
      rollback: async () => {
        unlock?.();
        unlock = null;
      },
      release() {},
      destroy() {}
    };
  }
}

function asPool(pool: FakePool) {
  return pool as unknown as mysql.Pool;
}

const fetchOperation: AcquisitionContentFetchOperationRecord = {
  id: "fetch-1",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "user-a",
  sourceUrl: "https://example.com/opportunity",
  finalUrl: null,
  subjectChannel: "organization",
  status: "queued",
  accessStatus: null,
  httpStatus: null,
  contentType: null,
  title: null,
  rawArtifactHash: null,
  contentHash: null,
  evidenceCount: 0,
  evidenceIds: [],
  candidateCount: 0,
  candidateIds: [],
  commentSampleSummary: null,
  commentEnrichmentExecutions: [],
  errorCode: null,
  idempotencyKeyHash: "a".repeat(64),
  requestHash: `sha256:${"b".repeat(64)}`,
  createdAt: "2026-07-24T08:00:00.000Z",
  startedAt: null,
  completedAt: null
};

const validCommentSummary = {
  status: "succeeded" as const,
  videoCount: 1,
  pagesFetched: 1,
  commentsSampled: 1,
  eventCount: 1,
  evidenceCount: 1,
  candidateIds: ["candidate-comment"],
  unresolvedActorCount: 0,
  strongSignalCount: 1,
  invalidCommentCount: 0,
  errors: [],
  usage: {
    requests: 1,
    results: 1,
    amountMinor: 0,
    durationSeconds: 0
  }
};

function validDirectExecution(
  overrides: Partial<AcquisitionContentFetchCommentExecution> = {}
): AcquisitionContentFetchCommentExecution {
  const contextKey = overrides.contextKey ?? "direct";
  return {
    executionId: acquisitionContentFetchCommentExecutionId({
      ownerId: fetchOperation.ownerId,
      teamId: fetchOperation.teamId,
      operationId: fetchOperation.id,
      contextKey
    }),
    contextKey,
    runId: null,
    shardId: null,
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: "2026-07-24T08:00:00.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

const importOperation: AcquisitionImportOperationRecord = {
  id: "import-1",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "user-a",
  fileName: "leads.csv",
  mediaType: "text/csv",
  subjectChannel: "individual",
  artifactHash: `sha256:${"c".repeat(64)}`,
  artifactCiphertext: "artifact-v1.iv.tag.ciphertext",
  columnMapping: {
    sourceTitle: "title",
    sourceSnippet: "snippet"
  },
  status: "queued",
  rowCount: 0,
  acceptedRowCount: 0,
  evidenceCount: 0,
  evidenceIds: [],
  candidateCount: 0,
  candidateIds: [],
  errorRows: [],
  errorCode: null,
  idempotencyKeyHash: "d".repeat(64),
  requestHash: `sha256:${"e".repeat(64)}`,
  createdAt: "2026-07-24T08:00:00.000Z",
  startedAt: null,
  completedAt: null
};

test("discovery operation schema creates durable tenant and idempotency indexes", async () => {
  const pool = new FakePool();
  await ensureAcquisitionDiscoveryMysqlSchema(asPool(pool));
  assert.equal(
    pool.calls.length,
    ACQUISITION_DISCOVERY_MYSQL_SCHEMA_STATEMENTS.length + 3
  );
  const schema = pool.calls.map((call) => call.sql).join("\n");
  assert.match(schema, /acquisition_content_fetch_operations/);
  assert.match(schema, /acquisition_import_operations/);
  assert.match(schema, /UNIQUE KEY uk_acquisition_fetch_idempotency/);
  assert.match(schema, /UNIQUE KEY uk_acquisition_import_idempotency/);
});

test("discovery schema upgrades the legacy content-fetch status check for partial success", async () => {
  for (const checkClause of [
    null,
    "status in ('queued','running','succeeded','failed','access_restricted')",
    "status in ('queued','running','succeeded','partial_success','failed','access_restricted')"
  ]) {
    const pool = new FakePool();
    pool.query = async function query(
      sql: string,
      values: unknown[] = []
    ) {
      this.calls.push({
        sql: sql.replace(/\s+/gu, " ").trim(),
        values
      });
      if (sql.includes("CHECK_CONSTRAINTS")) {
        return [checkClause === null ? [] : [{ check_clause: checkClause }], []];
      }
      return [{ affectedRows: 1 }, []];
    };

    await ensureAcquisitionDiscoveryMysqlSchema(asPool(pool));

    const migration = pool.calls.filter((call) =>
      call.sql.includes("chk_acquisition_fetch_status")
      && call.sql.startsWith("ALTER TABLE")
    );
    if (checkClause === null) {
      assert.equal(migration.length, 1);
      assert.match(migration[0]!.sql, /ADD CONSTRAINT/u);
    } else if (!checkClause.includes("partial_success")) {
      assert.equal(migration.length, 1);
      assert.match(migration[0]!.sql, /DROP CHECK/u);
      assert.match(migration[0]!.sql, /ADD CONSTRAINT/u);
    } else {
      assert.deepEqual(migration, []);
    }
  }
});

class ConcurrentDiscoveryMigrationPool {
  readonly calls: Array<{
    sql: string;
    dedicated: boolean;
  }> = [];
  getConnectionCalls = 0;
  releases = 0;
  destroys = 0;
  statusClause =
    "status in ('queued','running','succeeded','failed','access_restricted')";
  statusAlterations = 0;
  private lockHeld = false;
  private readonly lockWaiters: Array<() => void> = [];
  private unlockedPoolChecks = 0;
  private releasePoolChecks: (() => void) | null = null;

  private async handle(sql: string, dedicated: boolean) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, dedicated });
    if (normalized.includes("GET_LOCK")) {
      if (this.lockHeld) {
        await new Promise<void>((resolve) => {
          this.lockWaiters.push(resolve);
        });
      }
      this.lockHeld = true;
      return [[{ lock_acquired: 1 }], []];
    }
    if (normalized.includes("RELEASE_LOCK")) {
      this.lockHeld = false;
      this.lockWaiters.shift()?.();
      return [[{ lock_released: 1 }], []];
    }
    if (normalized.includes("CHECK_CONSTRAINTS")) {
      if (!dedicated) {
        this.unlockedPoolChecks += 1;
        if (this.unlockedPoolChecks === 1) {
          await new Promise<void>((resolve) => {
            this.releasePoolChecks = resolve;
          });
        } else {
          this.releasePoolChecks?.();
        }
      }
      return [[{ check_clause: this.statusClause }], []];
    }
    if (normalized.startsWith(
      "ALTER TABLE acquisition_content_fetch_operations DROP CHECK"
    ) || normalized.startsWith(
      "ALTER TABLE acquisition_content_fetch_operations ADD CONSTRAINT"
    )) {
      this.statusAlterations += 1;
      this.statusClause =
        "status in ('queued','running','succeeded','partial_success','failed','access_restricted')";
    }
    return [{ affectedRows: 1 }, []];
  }

  query(sql: string) {
    return this.handle(sql, false);
  }

  async getConnection() {
    this.getConnectionCalls += 1;
    return {
      query: (sql: string) => this.handle(sql, true),
      release: () => { this.releases += 1; },
      destroy: () => { this.destroys += 1; }
    };
  }
}

test("concurrent discovery schema startup serializes status migration on a dedicated session", async () => {
  const pool = new ConcurrentDiscoveryMigrationPool();
  await Promise.all([
    ensureAcquisitionDiscoveryMysqlSchema(pool as unknown as mysql.Pool),
    ensureAcquisitionDiscoveryMysqlSchema(pool as unknown as mysql.Pool)
  ]);

  assert.equal(pool.getConnectionCalls, 2);
  assert.equal(pool.statusAlterations, 1);
  assert.equal(pool.releases, 2);
  assert.equal(pool.destroys, 0);
  assert.equal(pool.calls.filter((call) =>
    call.sql.includes("GET_LOCK")).length, 2);
  assert.equal(pool.calls.filter((call) =>
    call.sql.includes("RELEASE_LOCK")).length, 2);
  assert.equal(pool.calls.every((call) => call.dedicated), true);
});

test("discovery schema lock failure poisons its dedicated connection", async () => {
  let releases = 0;
  let destroys = 0;
  const connection = {
    async query(sql: string) {
      if (sql.includes("GET_LOCK")) {
        return [[{ lock_acquired: 0 }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { releases += 1; },
    destroy() { destroys += 1; }
  };
  const pool = {
    async query() {
      return [[{
        check_clause:
          "status in ('queued','running','succeeded','partial_success','failed','access_restricted')"
      }], []];
    },
    async getConnection() { return connection; }
  } as unknown as mysql.Pool;

  await assert.rejects(
    ensureAcquisitionDiscoveryMysqlSchema(pool),
    /ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_FAILED/
  );
  assert.equal(destroys, 1);
  assert.equal(releases, 0);
});

test("discovery schema release failure poisons and never returns its session", async () => {
  let releases = 0;
  let destroys = 0;
  const connection = {
    async query(sql: string) {
      if (sql.includes("GET_LOCK")) {
        return [[{ lock_acquired: 1 }], []];
      }
      if (sql.includes("RELEASE_LOCK")) {
        throw new Error("mysql connection lost while releasing lock");
      }
      if (sql.includes("CHECK_CONSTRAINTS")) {
        return [[{
          check_clause:
            "status in ('queued','running','succeeded','partial_success','failed','access_restricted')"
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    },
    release() { releases += 1; },
    destroy() { destroys += 1; }
  };
  const pool = {
    async getConnection() { return connection; }
  } as unknown as mysql.Pool;

  await assert.rejects(
    ensureAcquisitionDiscoveryMysqlSchema(pool),
    /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/
  );
  assert.equal(destroys, 1);
  assert.equal(releases, 0);
});

test("mysql repository persists encrypted import artifacts and tenant-scoped fetch records", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));

  const createdFetch = await repository.createContentFetchOperation(
    fetchOperation
  );
  assert.equal(createdFetch.created, true);
  assert.equal(createdFetch.operation.id, fetchOperation.id);
  const fetchInsert = pool.calls.at(-1)!;
  assert.match(fetchInsert.sql, /INSERT INTO acquisition_content_fetch_operations/);
  assert.doesNotMatch(JSON.stringify(fetchInsert.values), /fetch-key/);

  pool.enqueue([{
    payload_json: JSON.stringify(fetchOperation)
  }]);
  const loaded = await repository.getContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    fetchOperation.id
  );
  assert.deepEqual(loaded, fetchOperation);
  const fetchSelect = pool.calls.at(-1)!;
  assert.match(fetchSelect.sql, /owner_id = \\?/);
  assert.match(fetchSelect.sql, /team_id = \\?/);
  assert.deepEqual(
    fetchSelect.values.slice(0, 3),
    [fetchOperation.id, "owner-a", "team-a"]
  );

  const createdImport = await repository.createImportOperation(
    importOperation
  );
  assert.equal(createdImport.created, true);
  const importInsert = pool.calls.at(-1)!;
  assert.match(importInsert.sql, /INSERT INTO acquisition_import_operations/);
  const serialized = JSON.stringify(importInsert.values);
  assert.match(serialized, /artifact-v1\.iv\.tag\.ciphertext/);
  assert.doesNotMatch(serialized, /contentBase64/);
});

test("mysql repository round-trips partial comment enrichment and its candidate associations", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  const operation: AcquisitionContentFetchOperationRecord = {
    ...fetchOperation,
    status: "partial_success",
    finalUrl: "https://www.douyin.com/video/7536012345678904333",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html",
    title: "公开视频",
    rawArtifactHash: `sha256:${"1".repeat(64)}`,
    contentHash: `sha256:${"2".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["original-evidence"],
    candidateCount: 2,
    candidateIds: ["original-candidate", "comment-candidate"],
    commentSampleSummary: {
      status: "partial_success",
      videoCount: 1,
      pagesFetched: 1,
      commentsSampled: 1,
      eventCount: 1,
      evidenceCount: 1,
      candidateIds: ["comment-candidate"],
      unresolvedActorCount: 1,
      strongSignalCount: 1,
      invalidCommentCount: 0,
      errors: [{
        sourceUrl: "https://www.douyin.com/video/7536012345678904333",
        videoId: "7536012345678904333",
        code: "rate_limited"
      }],
      usage: {
        requests: 2,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    },
    errorCode: "rate_limited",
    startedAt: "2026-07-24T08:00:01.000Z",
    completedAt: "2026-07-24T08:00:02.000Z"
  };
  pool.enqueue([{ payload_json: JSON.stringify(operation) }]);

  const loaded = await repository.getContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    operation.id
  );

  assert.deepEqual(loaded, operation);
});

test("mysql comment execution saga survives restart and concurrent claims", async () => {
  const base: AcquisitionContentFetchOperationRecord = {
    ...fetchOperation,
    status: "succeeded",
    finalUrl: "https://www.douyin.com/video/7536012345678904333",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html",
    title: "公开视频",
    rawArtifactHash: `sha256:${"1".repeat(64)}`,
    contentHash: `sha256:${"2".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["base-evidence"],
    startedAt: "2026-07-24T08:00:00.000Z",
    completedAt: "2026-07-24T08:00:01.000Z"
  };
  const pool = new StatefulFetchPool(base);
  const firstRepository = new MysqlAcquisitionDiscoveryOperationRepository(
    pool as unknown as mysql.Pool
  );
  const execution: AcquisitionContentFetchCommentExecution = {
    executionId: acquisitionContentFetchCommentExecutionId({
      ownerId: base.ownerId,
      teamId: base.teamId,
      operationId: base.id,
      contextKey: "run:run-mysql:shard-mysql"
    }),
    contextKey: "run:run-mysql:shard-mysql",
    runId: "run-mysql",
    shardId: "shard-mysql",
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 3 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: "2026-07-24T08:00:02.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: "2026-07-24T08:00:02.000Z",
    updatedAt: "2026-07-24T08:00:02.000Z",
    completedAt: null
  };
  await firstRepository.putContentFetchCommentExecution(
    { ownerId: base.ownerId, teamId: base.teamId },
    base.id,
    execution
  );
  const claim = (worker: string) =>
    firstRepository.claimContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution.executionId,
      {
        leaseOwner: worker,
        leaseToken: `lease-${worker}`,
        claimedAt: "2026-07-24T08:00:02.000Z",
        leaseExpiresAt: "2026-07-24T08:10:02.000Z",
        staleRunningBefore: "2026-07-24T07:50:02.000Z"
      }
    );
  const claims = await Promise.all([claim("a"), claim("b")]);
  assert.equal(claims.filter((result) => result.claimed).length, 1);
  const winner = claims.find((result) => result.claimed)!;
  const summary = {
    status: "succeeded" as const,
    videoCount: 1,
    pagesFetched: 1,
    commentsSampled: 1,
    eventCount: 1,
    evidenceCount: 1,
    candidateIds: ["candidate-from-comment"],
    unresolvedActorCount: 0,
    strongSignalCount: 1,
    invalidCommentCount: 0,
    errors: [],
    usage: {
      requests: 1,
      results: 1,
      amountMinor: 0,
      durationSeconds: 0
    }
  };
  await firstRepository.completeContentFetchCommentExecution(
    { ownerId: base.ownerId, teamId: base.teamId },
    base.id,
    execution.executionId,
    winner.execution!.leaseToken!,
    summary,
    "2026-07-24T08:00:03.000Z"
  );

  const restartedRepository =
    new MysqlAcquisitionDiscoveryOperationRepository(
      pool as unknown as mysql.Pool
    );
  const loaded = await restartedRepository.getContentFetchOperation(
    { ownerId: base.ownerId, teamId: base.teamId },
    base.id
  );
  assert.deepEqual(
    loaded?.commentEnrichmentExecutions?.[0]?.summary,
    summary
  );
  const replayClaim = await restartedRepository
    .claimContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution.executionId,
      {
        leaseOwner: "restart-worker",
        leaseToken: "restart-lease",
        claimedAt: "2026-07-24T08:20:00.000Z",
        leaseExpiresAt: "2026-07-24T08:30:00.000Z",
        staleRunningBefore: "2026-07-24T08:10:00.000Z"
      }
    );
  assert.equal(replayClaim.claimed, false);
  assert.deepEqual(replayClaim.execution?.summary, summary);
  assert.equal(pool.calls.some((sql) => /FOR UPDATE/u.test(sql)), true);
});

test("mysql comment executions accept service-sized lease owners through recovery and completion", async () => {
  for (const leaseOwnerLength of [101, 160]) {
    const base: AcquisitionContentFetchOperationRecord = {
      ...fetchOperation,
      status: "succeeded",
      finalUrl: "https://www.douyin.com/video/7536012345678904333",
      accessStatus: "public_content",
      httpStatus: 200,
      contentType: "text/html",
      title: "公开视频",
      rawArtifactHash: `sha256:${"1".repeat(64)}`,
      contentHash: `sha256:${"2".repeat(64)}`,
      evidenceCount: 1,
      evidenceIds: ["base-evidence"],
      startedAt: "2026-07-24T08:00:00.000Z",
      completedAt: "2026-07-24T08:00:01.000Z"
    };
    const pool = new StatefulFetchPool(base);
    const repository = new MysqlAcquisitionDiscoveryOperationRepository(
      pool as unknown as mysql.Pool
    );
    const execution = validDirectExecution();
    await repository.putContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution
    );

    const firstLeaseOwner = "w".repeat(leaseOwnerLength);
    const firstClaim = await repository.claimContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution.executionId,
      {
        leaseOwner: firstLeaseOwner,
        leaseToken: "first-lease",
        claimedAt: "2026-07-24T08:00:01.000Z",
        leaseExpiresAt: "2026-07-24T08:00:02.000Z",
        staleRunningBefore: "2026-07-24T07:50:01.000Z"
      }
    );
    assert.equal(firstClaim.claimed, true);
    assert.equal(firstClaim.execution?.leaseOwner, firstLeaseOwner);

    const running = await repository.getContentFetchOperation(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id
    );
    assert.equal(
      running?.commentEnrichmentExecutions?.[0]?.leaseOwner,
      firstLeaseOwner
    );

    const recoveryLeaseOwner = "r".repeat(leaseOwnerLength);
    const recovered = await repository.claimContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution.executionId,
      {
        leaseOwner: recoveryLeaseOwner,
        leaseToken: "recovery-lease",
        claimedAt: "2026-07-24T08:00:03.000Z",
        leaseExpiresAt: "2026-07-24T08:10:03.000Z",
        staleRunningBefore: "2026-07-24T07:50:03.000Z"
      }
    );
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.execution?.leaseOwner, recoveryLeaseOwner);

    await repository.completeContentFetchCommentExecution(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id,
      execution.executionId,
      "recovery-lease",
      validCommentSummary,
      "2026-07-24T08:00:04.000Z"
    );
    const restartedRepository =
      new MysqlAcquisitionDiscoveryOperationRepository(
        pool as unknown as mysql.Pool
      );
    const completed = await restartedRepository.getContentFetchOperation(
      { ownerId: base.ownerId, teamId: base.teamId },
      base.id
    );
    assert.equal(
      completed?.commentEnrichmentExecutions?.[0]?.status,
      "succeeded"
    );
    assert.deepEqual(
      completed?.commentEnrichmentExecutions?.[0]?.summary,
      validCommentSummary
    );
  }
});

test("mysql comment execution parser rejects lease owners above the service limit", async () => {
  const pool = new FakePool();
  pool.enqueue([{ payload_json: JSON.stringify({
    ...fetchOperation,
    commentEnrichmentExecutions: [validDirectExecution({
      status: "running",
      attemptCount: 1,
      leaseOwner: "w".repeat(161),
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-07-24T08:10:00.000Z",
      updatedAt: "2026-07-24T08:00:01.000Z"
    })]
  }) }]);

  await assert.rejects(
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool))
      .getContentFetchOperation(
        { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
        fetchOperation.id
      ),
    /MYSQL_INTEGRITY:comment_execution/u
  );
});

test("mysql terminal base write preserves an execution added after its claim snapshot", async () => {
  const running: AcquisitionContentFetchOperationRecord = {
    ...fetchOperation,
    status: "running",
    leaseOwner: "base-worker",
    leaseToken: "base-lease",
    leaseExpiresAt: "2026-07-24T08:10:00.000Z",
    startedAt: "2026-07-24T08:00:00.000Z"
  };
  const staleClaimSnapshot = structuredClone(running);
  const pool = new StatefulFetchPool(running);
  const repository = new MysqlAcquisitionDiscoveryOperationRepository(
    pool as unknown as mysql.Pool
  );
  const laterExecution: AcquisitionContentFetchCommentExecution = {
    executionId: acquisitionContentFetchCommentExecutionId({
      ownerId: running.ownerId,
      teamId: running.teamId,
      operationId: running.id,
      contextKey: "run:later-run:later-shard"
    }),
    contextKey: "run:later-run:later-shard",
    runId: "later-run",
    shardId: "later-shard",
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 3 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: "2026-07-24T08:00:01.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: "2026-07-24T08:00:01.000Z",
    updatedAt: "2026-07-24T08:00:01.000Z",
    completedAt: null
  };
  await repository.putContentFetchCommentExecution(
    { ownerId: running.ownerId, teamId: running.teamId },
    running.id,
    laterExecution
  );

  await repository.putContentFetchOperation({
    ...staleClaimSnapshot,
    status: "succeeded",
    completedAt: "2026-07-24T08:00:02.000Z"
  }, "base-lease");

  assert.equal(pool.operation.status, "succeeded");
  assert.deepEqual(
    pool.operation.commentEnrichmentExecutions?.map((item) =>
      item.executionId),
    [laterExecution.executionId]
  );
});

test("mysql repository rejects a 1001st comment execution and keeps the first 1000 readable", async () => {
  const executions = Array.from({ length: 1_000 }, (_unused, index) => {
    const contextKey = `run:run-${index}:shard-${index}`;
    return validDirectExecution({
      executionId: acquisitionContentFetchCommentExecutionId({
        ownerId: fetchOperation.ownerId,
        teamId: fetchOperation.teamId,
        operationId: fetchOperation.id,
        contextKey
      }),
      contextKey,
      runId: `run-${index}`,
      shardId: `shard-${index}`
    });
  });
  const pool = new StatefulFetchPool({
    ...fetchOperation,
    commentEnrichmentExecutions: executions
  });
  const repository = new MysqlAcquisitionDiscoveryOperationRepository(
    pool as unknown as mysql.Pool
  );
  const overflowContext = "run:overflow:overflow";
  await assert.rejects(
    repository.putContentFetchCommentExecution(
      { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
      fetchOperation.id,
      validDirectExecution({
        executionId: acquisitionContentFetchCommentExecutionId({
          ownerId: fetchOperation.ownerId,
          teamId: fetchOperation.teamId,
          operationId: fetchOperation.id,
          contextKey: overflowContext
        }),
        contextKey: overflowContext,
        runId: "overflow",
        shardId: "overflow"
      })
    ),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "INVALID_REQUEST"
      && error.message === "COMMENT_ENRICHMENT_EXECUTION_LIMIT"
  );
  assert.equal(pool.operation.commentEnrichmentExecutions?.length, 1_000);
  assert.equal((await repository.getContentFetchOperation(
    { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
    fetchOperation.id
  ))?.commentEnrichmentExecutions?.length, 1_000);

  const createPool = new FakePool();
  await assert.rejects(
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(createPool))
      .createContentFetchOperation({
        ...fetchOperation,
        commentEnrichmentExecutions: [
          ...executions,
          validDirectExecution({
            executionId: acquisitionContentFetchCommentExecutionId({
              ownerId: fetchOperation.ownerId,
              teamId: fetchOperation.teamId,
              operationId: fetchOperation.id,
              contextKey: overflowContext
            }),
            contextKey: overflowContext,
            runId: "overflow",
            shardId: "overflow"
          })
        ]
      }),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "INVALID_REQUEST"
  );
  assert.equal(createPool.calls.length, 0);
});

test("mysql base failure terminally fences a claimed comment execution", async () => {
  const execution = validDirectExecution();
  const pool = new StatefulFetchPool({
    ...fetchOperation,
    status: "failed",
    errorCode: "CONTENT_FETCH_FAILED",
    startedAt: "2026-07-24T08:00:00.000Z",
    completedAt: "2026-07-24T08:00:01.000Z",
    commentEnrichmentExecutions: [execution]
  });
  const repository = new MysqlAcquisitionDiscoveryOperationRepository(
    pool as unknown as mysql.Pool
  );
  const claimed = await repository.claimContentFetchCommentExecution(
    { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
    fetchOperation.id,
    execution.executionId,
    {
      leaseOwner: "worker-base-failed",
      leaseToken: "lease-base-failed",
      claimedAt: "2026-07-24T08:00:02.000Z",
      leaseExpiresAt: "2026-07-24T08:10:02.000Z",
      staleRunningBefore: "2026-07-24T07:50:02.000Z"
    }
  );
  assert.equal(claimed.claimed, true);
  await repository.terminallyFailContentFetchCommentExecution(
    { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
    fetchOperation.id,
    execution.executionId,
    "lease-base-failed",
    "2026-07-24T08:00:03.000Z",
    "BASE_CONTENT_FETCH_FAILED"
  );
  const stored = (await repository.getContentFetchOperation(
    { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
    fetchOperation.id
  ))?.commentEnrichmentExecutions?.[0];
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.lastErrorCode, "BASE_CONTENT_FETCH_FAILED");
  assert.equal(stored?.completedAt, "2026-07-24T08:00:03.000Z");
  assert.equal(stored?.leaseToken, null);
});

test("mysql repository defaults evidence ids for legacy content-fetch payloads", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  const legacyPayload = structuredClone(fetchOperation) as Partial<
    AcquisitionContentFetchOperationRecord
  >;
  delete legacyPayload.evidenceIds;
  legacyPayload.commentEnrichmentExecutions = null as never;
  pool.enqueue([{ payload_json: JSON.stringify(legacyPayload) }]);

  const loaded = await repository.getContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    fetchOperation.id
  );

  assert.deepEqual(loaded?.evidenceIds, []);
  assert.deepEqual(loaded?.commentEnrichmentExecutions, []);
});

test("mysql comment execution parser rejects contradictory direct and Run identity", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  const contradictory: AcquisitionContentFetchCommentExecution = {
    executionId: "comment-enrichment:contradictory",
    contextKey: "direct",
    runId: "run-must-be-null",
    shardId: null,
    policy: {
      enabled: true,
      maxVideosPerRun: 1,
      maxCommentsPerVideo: 1,
      maxPagesPerVideo: 1
    },
    remainingBudget: { requests: 1, results: 1 },
    status: "queued",
    summary: null,
    attemptCount: 0,
    nextAttemptAt: "2026-07-24T08:00:00.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    completedAt: null
  };
  pool.enqueue([{ payload_json: JSON.stringify({
    ...fetchOperation,
    commentEnrichmentExecutions: [contradictory]
  }) }]);

  await assert.rejects(
    repository.getContentFetchOperation(
      { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
      fetchOperation.id
    ),
    /MYSQL_INTEGRITY:comment_execution/u
  );
});

test("mysql comment execution parser enforces every terminal and lease state combination", async () => {
  const validStates: AcquisitionContentFetchCommentExecution[] = [
    validDirectExecution(),
    validDirectExecution({
      attemptCount: 1,
      lastErrorCode: "COMMENT_ENRICHMENT_FAILED",
      nextAttemptAt: "2026-07-24T08:00:02.000Z",
      updatedAt: "2026-07-24T08:00:01.000Z"
    }),
    validDirectExecution({
      status: "running",
      attemptCount: 1,
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-07-24T08:10:00.000Z",
      updatedAt: "2026-07-24T08:00:01.000Z"
    }),
    validDirectExecution({
      status: "succeeded",
      attemptCount: 1,
      summary: validCommentSummary,
      updatedAt: "2026-07-24T08:00:02.000Z",
      completedAt: "2026-07-24T08:00:02.000Z"
    }),
    validDirectExecution({
      status: "failed",
      attemptCount: 1,
      lastErrorCode: "BASE_CONTENT_FETCH_FAILED",
      updatedAt: "2026-07-24T08:00:02.000Z",
      completedAt: "2026-07-24T08:00:02.000Z"
    })
  ];
  for (const execution of validStates) {
    const pool = new FakePool();
    pool.enqueue([{ payload_json: JSON.stringify({
      ...fetchOperation,
      commentEnrichmentExecutions: [execution]
    }) }]);
    const loaded = await new MysqlAcquisitionDiscoveryOperationRepository(
      asPool(pool)
    ).getContentFetchOperation(
      { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
      fetchOperation.id
    );
    assert.equal(
      loaded?.commentEnrichmentExecutions?.[0]?.status,
      execution.status
    );
  }

  const invalidStates: AcquisitionContentFetchCommentExecution[] = [
    validDirectExecution({
      attemptCount: 0,
      lastErrorCode: "COMMENT_ENRICHMENT_FAILED"
    }),
    validDirectExecution({
      status: "running",
      attemptCount: 0,
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-07-24T08:10:00.000Z"
    }),
    validDirectExecution({
      status: "running",
      attemptCount: 1
    }),
    validDirectExecution({
      status: "succeeded",
      attemptCount: 1,
      completedAt: "2026-07-24T08:00:02.000Z"
    }),
    validDirectExecution({
      status: "failed",
      attemptCount: 1,
      lastErrorCode: "COMMENT_ENRICHMENT_FAILED",
      completedAt: "2026-07-24T08:00:02.000Z"
    }),
    validDirectExecution({
      updatedAt: "2026-07-24T07:59:59.000Z"
    }),
    validDirectExecution({
      remainingBudget: { requests: -1, results: 1 }
    }),
    validDirectExecution({
      policy: {
        enabled: true,
        maxVideosPerRun: 21,
        maxCommentsPerVideo: 1,
        maxPagesPerVideo: 1
      }
    }),
    validDirectExecution({
      lastErrorCode: "https://example.com/raw-comment" as never
    })
  ];
  for (const execution of invalidStates) {
    const pool = new FakePool();
    pool.enqueue([{ payload_json: JSON.stringify({
      ...fetchOperation,
      commentEnrichmentExecutions: [execution]
    }) }]);
    await assert.rejects(
      new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool))
        .getContentFetchOperation(
          { ownerId: fetchOperation.ownerId, teamId: fetchOperation.teamId },
          fetchOperation.id
        ),
      /MYSQL_INTEGRITY:comment_execution/u
    );
  }
});

test("mysql repository marks legacy terminal fetches without evidence ids as refetch-required failures", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  const legacyPayload = {
    ...structuredClone(fetchOperation),
    status: "succeeded" as const,
    finalUrl: "https://example.com/opportunity",
    accessStatus: "public_content" as const,
    httpStatus: 200,
    contentType: "text/html",
    title: "公开商机",
    rawArtifactHash: `sha256:${"c".repeat(64)}`,
    contentHash: `sha256:${"d".repeat(64)}`,
    evidenceCount: 1,
    startedAt: "2026-07-24T08:00:01.000Z",
    completedAt: "2026-07-24T08:00:02.000Z"
  } as Partial<AcquisitionContentFetchOperationRecord>;
  delete legacyPayload.evidenceIds;
  pool.enqueue([{ payload_json: JSON.stringify(legacyPayload) }]);

  const loaded = await repository.getContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    fetchOperation.id
  );

  assert.equal(loaded?.status, "failed");
  assert.equal(loaded?.evidenceCount, 0);
  assert.deepEqual(loaded?.evidenceIds, []);
  assert.equal(
    loaded?.errorCode,
    "LEGACY_EVIDENCE_IDS_UNAVAILABLE_REFETCH_REQUIRED"
  );
});

test("mysql repository rejects duplicate and inconsistent content-fetch evidence references", async () => {
  const invalidPayloads = [
    {
      ...fetchOperation,
      status: "succeeded",
      evidenceCount: 2,
      evidenceIds: ["evidence-1", "evidence-1"]
    },
    {
      ...fetchOperation,
      status: "succeeded",
      evidenceCount: 1,
      evidenceIds: []
    }
  ];

  for (const payload of invalidPayloads) {
    const pool = new FakePool();
    const repository =
      new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
    pool.enqueue([{ payload_json: JSON.stringify(payload) }]);

    await assert.rejects(
      repository.getContentFetchOperation(
        { ownerId: "owner-a", teamId: "team-a" },
        fetchOperation.id
      ),
      /ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_/u
    );
  }
});

test("mysql repository preserves evidence association when candidate ingestion fails after fetch", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  pool.enqueue([{ payload_json: JSON.stringify({
    ...fetchOperation,
    status: "failed",
    evidenceCount: 1,
    evidenceIds: ["evidence-1"],
    candidateCount: 0,
    candidateIds: [],
    errorCode: "CONTENT_FETCH_FAILED"
  }) }]);

  const loaded = await repository.getContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    fetchOperation.id
  );

  assert.equal(loaded?.status, "failed");
  assert.deepEqual(loaded?.evidenceIds, ["evidence-1"]);
  assert.deepEqual(loaded?.candidateIds, []);
});

test("mysql repository lists tenant operations by created time and id with a bounded limit", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  pool.enqueue([
    { payload_json: JSON.stringify(fetchOperation) }
  ]);

  const fetchItems = await repository.listContentFetchOperations(
    { ownerId: "owner-a", teamId: "team-a" },
    25
  );

  assert.deepEqual(fetchItems, [fetchOperation]);
  const fetchSelect = pool.calls.at(-1)!;
  assert.match(
    fetchSelect.sql,
    /ORDER BY created_at DESC, id DESC LIMIT \?/
  );
  assert.deepEqual(fetchSelect.values, ["owner-a", "team-a", 25]);

  pool.enqueue([
    { payload_json: JSON.stringify(importOperation) }
  ]);
  const importItems = await repository.listImportOperations(
    { ownerId: "owner-a", teamId: "team-a" },
    10
  );

  assert.deepEqual(importItems, [importOperation]);
  const importSelect = pool.calls.at(-1)!;
  assert.match(
    importSelect.sql,
    /ORDER BY created_at DESC, id DESC LIMIT \?/
  );
  assert.deepEqual(importSelect.values, ["owner-a", "team-a", 10]);
});

test("mysql claim is atomic and never steals running or terminal operations", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  pool.enqueue({ affectedRows: 1 });
  pool.enqueue([{
    payload_json: JSON.stringify({
      ...fetchOperation,
      status: "running",
      startedAt: "2026-07-24T08:01:00.000Z",
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-07-24T08:11:00.000Z"
    })
  }]);
  const claimed = await repository.claimContentFetchOperation(
    { ownerId: "owner-a", teamId: "team-a" },
    fetchOperation.id,
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      claimedAt: "2026-07-24T08:01:00.000Z",
      leaseExpiresAt: "2026-07-24T08:11:00.000Z",
      staleRunningBefore: "2026-07-24T07:51:00.000Z"
    }
  );
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.operation?.status, "running");
  const update = pool.calls[0]!;
  assert.match(update.sql, /status = 'queued'/);
  assert.match(update.sql, /lease_expires_at <= \?/);
  assert.match(update.sql, /owner_id = \\?/);
  assert.match(update.sql, /team_id = \\?/);
});

test("mysql recovery listing is cross-tenant, bounded, and oldest first", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  pool.enqueue([
    { payload_json: JSON.stringify(fetchOperation) },
    { payload_json: JSON.stringify(importOperation) }
  ]);

  const operations = await repository.listRecoverableOperations({
    now: "2026-07-24T08:10:00.000Z",
    staleRunningBefore: "2026-07-24T08:00:00.000Z",
    limit: 20
  });

  assert.deepEqual(
    operations.map((operation) => operation.id),
    [fetchOperation.id, importOperation.id]
  );
  const query = pool.calls.at(-1)!;
  assert.match(query.sql, /UNION ALL/);
  assert.match(query.sql, /lease_expires_at <= \?/);
  assert.match(query.sql, /ORDER BY created_at ASC, id ASC/);
  assert.match(query.sql, /LIMIT \?/);
  assert.deepEqual(query.values, [
    "2026-07-24 08:10:00.000",
    "2026-07-24 08:00:00.000",
    "2026-07-24T08:10:00.000Z",
    "2026-07-24T08:10:00.000Z",
    "2026-07-24 08:10:00.000",
    "2026-07-24 08:00:00.000",
    20
  ]);
});

test("mysql terminal writes are fenced by the active lease token", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  pool.enqueue([{
    payload_json: JSON.stringify({
      ...fetchOperation,
      status: "running",
      leaseOwner: "active-worker",
      leaseToken: "active-lease",
      leaseExpiresAt: "2026-07-24T08:10:00.000Z",
      startedAt: "2026-07-24T08:00:00.000Z"
    })
  }]);

  await assert.rejects(
    repository.putContentFetchOperation({
      ...fetchOperation,
      status: "succeeded",
      startedAt: "2026-07-24T08:00:00.000Z",
      completedAt: "2026-07-24T08:01:00.000Z"
    }, "stale-lease"),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
      && error.message === "OPERATION_LEASE_LOST"
  );
  const query = pool.calls.at(-1)!;
  assert.match(query.sql, /FOR UPDATE/);
});

test("duplicate idempotency compares request hashes instead of silently reusing another request", async () => {
  const pool = new FakePool();
  const repository =
    new MysqlAcquisitionDiscoveryOperationRepository(asPool(pool));
  const duplicate = Object.assign(new Error("duplicate"), {
    errno: 1062,
    code: "ER_DUP_ENTRY"
  });
  pool.query = async function query(
    sql: string,
    values: unknown[] = []
  ) {
    this.calls.push({
      sql: sql.replace(/\s+/gu, " ").trim(),
      values
    });
    if (sql.includes("INSERT INTO")) throw duplicate;
    return [[{
      payload_json: JSON.stringify({
        ...fetchOperation,
        requestHash: `sha256:${"f".repeat(64)}`
      })
    }], []];
  };
  await assert.rejects(
    repository.createContentFetchOperation({
      ...fetchOperation,
      requestSemanticsVersion: 1
    }),
    (error: unknown) =>
      error instanceof AcquisitionDiscoveryOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );
});
