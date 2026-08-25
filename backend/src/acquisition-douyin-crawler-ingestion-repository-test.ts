import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import type {
  AcquisitionCrawlerJob,
  NormalizedDouyinRecord,
  PersistedNormalizedDouyinRecord
} from "./acquisition-crawler-job.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";
import {
  ensureAcquisitionCrawlerJobMysqlSchema
} from "./acquisition-crawler-job-mysql-repository.js";
import { InMemoryAcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { ingestDouyinCrawlerPage } from "./acquisition-douyin-crawler-ingestion.js";
import {
  ensureAcquisitionDouyinAutomationMysqlSchema
} from "./acquisition-douyin-automation-mysql-repository.js";
import {
  acquisitionDouyinCrawlerEvidenceIndexDdl,
  acquisitionDouyinDoNotContactDdl,
  ensureAcquisitionDouyinCrawlerIngestionMysqlSchema,
  InMemoryAcquisitionDouyinCrawlerIngestionRepository,
  MysqlAcquisitionDouyinCrawlerIngestionRepository
} from "./acquisition-douyin-crawler-ingestion-repository.js";
import { MEDIACRAWLER_PINNED_UPSTREAM_COMMIT } from "./acquisition-mediacrawler-gateway.js";
import {
  ensureAcquisitionMysqlSchema,
  MysqlAcquisitionDomainRepository,
  MysqlAcquisitionPlanRunRepository
} from "./acquisition-mysql-repositories.js";
import {
  createDouyinCollectionAcquisitionRun,
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionPlan,
  type AcquisitionPlanPayload,
  type AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";

const NOW = "2026-08-25T01:00:00.000Z";
const SCOPE = Object.freeze({
  workspaceId: "workspace-1",
  ownerId: "owner-1",
  teamId: "team-1",
  actorId: "worker-1"
});

function deterministicId(prefix: string, workspaceId: string, value: string) {
  return `${prefix}:${createHash("sha256")
    .update(`${workspaceId}\u0000${value}`)
    .digest("hex").slice(0, 32)}`;
}

function payload(): AcquisitionPlanPayload {
  return {
    targetPlatform: "douyin",
    name: "Douyin acquisition",
    objective: "Find public demand",
    icp: {
      industries: ["industrial"], regions: ["CN"],
      organizationCriteria: [], individualCriteria: [], exclusionRules: []
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

function normalized(overrides: Partial<Omit<PersistedNormalizedDouyinRecord, "contentHash">> = {}) {
  const value = {
    recordId: "comment-stable-1",
    kind: "comment" as const,
    actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/7350000000000000001",
    publicDisplayName: "Public actor",
    publicProfileUrl: "https://www.douyin.com/user/actor-1",
    textExcerpt: "正在寻找门店获客方案，想咨询报价。",
    sourceKeyword: "门店获客",
    observedAt: NOW,
    pageCursor: "opaque-page-cursor-1",
    ...overrides
  };
  return { ...value, contentHash: normalizedDouyinContentHash(value) };
}

function crawlerJob(
  id: string,
  runIds: string[],
  automationIntentIds = runIds.map((runId) => `intent-${runId}`)
): AcquisitionCrawlerJob {
  return {
    id, workspaceId: SCOPE.workspaceId, runId: runIds[0]!, runIds,
    automationIntentId: automationIntentIds[0]!, automationIntentIds,
    planId: "plan-1", planVersionId: "plan-version-1",
    planSnapshotHash: "sha256:plan-1", policyVersionId: "policy-version-1",
    policyHash: `sha256:${"a".repeat(64)}`, accountId: "account-1",
    accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"b".repeat(64)}`,
    localDate: "2026-08-25", trigger: "run_now", dailyCandidateLimit: 50,
    keywords: ["门店获客"], collectCreators: true,
    collectDemandComments: true,
    limits: {
      maxVideos: 30, maxCommentsPerVideo: 50,
      maxPagesPerVideo: 3, maxDurationSeconds: 3_600
    },
    createdAt: NOW, maxAttempts: 3, state: "succeeded", attempt: 1,
    cursor: "cursor-1", cursorHistory: ["cursor-1"], recordCount: 1,
    candidateBudgetUsed: 1, cancelRequestedAt: null, lastErrorCode: null,
    leaseWorkerId: null, leaseToken: null, leaseExpiresAt: null,
    fencingToken: 1, ingestionState: "pending", ingestionAttempt: 0,
    ingestionLeaseWorkerId: null, ingestionLeaseToken: null,
    ingestionLeaseExpiresAt: null, ingestionFencingToken: 0,
    aliasGeneration: runIds.length, projectedAliasGeneration: 0,
    ingestedAt: null, acknowledgedAt: null,
    updatedAt: NOW, completedAt: NOW
  };
}

async function fixture(runIds = ["run-1", "run-2"]) {
  const planRuns = new InMemoryAcquisitionPlanRunRepository();
  const domain = new InMemoryAcquisitionDomainRepository(planRuns);
  const planPayload = payload();
  const version: AcquisitionPlanVersion = {
    id: "plan-version-1", planId: "plan-1", ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId, version: 1, payload: planPayload,
    payloadHash: "sha256:plan-1", createdBy: SCOPE.actorId, createdAt: NOW
  };
  const plan: AcquisitionPlan = {
    id: "plan-1", ownerId: SCOPE.ownerId, teamId: SCOPE.teamId,
    status: "approved", version: 1, revision: 2, etag: '"plan-1:2"',
    currentVersionId: version.id, approvedVersionId: version.id,
    approvedSnapshotHash: version.payloadHash, approvedBy: SCOPE.actorId,
    approvedAt: NOW, budgetSnapshot: planPayload.budgetSnapshot,
    payload: planPayload, createdBy: SCOPE.actorId, createdAt: NOW,
    updatedBy: SCOPE.actorId, updatedAt: NOW
  };
  await planRuns.transaction((transaction) => {
    transaction.putPlan(plan);
    transaction.appendPlanVersion(version);
    for (const runId of runIds) {
      transaction.putRun(createDouyinCollectionAcquisitionRun({
        id: runId, automationIntentId: `intent-${runId}`, plan, version,
        dailyBudgetId: `sha256:${"b".repeat(64)}`, reason: null,
        actorId: SCOPE.actorId, createdAt: NOW
      }).run);
    }
  });
  return {
    planRuns,
    domain,
    repository: new InMemoryAcquisitionDouyinCrawlerIngestionRepository(
      domain,
      planRuns
    )
  };
}

test("authoritative ingestion links every real run alias and keeps cross-job DNC permanent", async () => {
  const { planRuns, domain, repository } = await fixture();
  let job = crawlerJob("job-1", ["run-1", "run-2"]);
  job = { ...job, cursor: null };
  let records = [normalized()];
  const crawlerJobs = {
    async findByRun(_workspaceId: string, runId: string) {
      return job.runIds.includes(runId) ? job : null;
    },
    async listRecords() { return records; }
  };

  await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => NOW
  });
  const firstCandidates = await domain.listCandidates(SCOPE, { limit: 10 });
  assert.equal(firstCandidates.items.length, 1);
  const candidate = firstCandidates.items[0]!;
  assert.deepEqual((await planRuns.listRunCandidateLinks("run-1"))
    .map((value) => value.candidateId), [candidate.id]);
  assert.deepEqual((await planRuns.listRunCandidateLinks("run-2"))
    .map((value) => value.candidateId), [candidate.id]);
  assert.equal((await planRuns.listRunShards("run-1")).length, 0);
  const firstEvidence = await domain.findEvidence(SCOPE, candidate.evidenceIds[0]!);
  assert.equal(firstEvidence?.provenance.kind, "mediacrawler_public_record");
  if (firstEvidence?.provenance.kind === "mediacrawler_public_record") {
    assert.equal(firstEvidence.provenance.upstreamCommit, MEDIACRAWLER_PINNED_UPSTREAM_COMMIT);
    assert.equal(firstEvidence.provenance.cursor, "opaque-page-cursor-1");
    assert.equal(firstEvidence.provenance.actorKind, "commenter");
  }
  const firstRun = await planRuns.getRun("run-1");
  const firstEvents = await planRuns.listRunEvents("run-1");
  await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => "2026-08-25T01:30:00.000Z"
  });
  assert.deepEqual(await planRuns.getRun("run-1"), firstRun);
  assert.deepEqual(await planRuns.listRunEvents("run-1"), firstEvents);

  job = crawlerJob("job-2", ["run-1", "run-2"]);
  records = [normalized({
    textExcerpt: "请勿联系，拒绝任何推销。",
    observedAt: "2026-08-25T02:00:00.000Z"
  })];
  await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-2",
    scope: SCOPE, now: () => "2026-08-25T02:00:00.000Z"
  });
  const afterRefusal = await domain.findCandidate(SCOPE, candidate.id);
  assert.equal(afterRefusal?.status, "do_not_contact");
  const refusalEvidenceId = deterministicId(
    "evidence",
    SCOPE.workspaceId,
    records[0]!.contentHash
  );
  const allEvidence = await domain.getPresentationEvidenceSnapshots(
    SCOPE,
    [candidate.evidenceIds[0]!, refusalEvidenceId]
  );
  const refusal = allEvidence.find((value) => value.id === refusalEvidenceId);
  assert.equal(refusal?.supersedesEvidenceId, candidate.evidenceIds[0]);

  assert.equal(await repository.cleanupExpiredUnlinked(
    SCOPE,
    "2026-11-24T02:00:00.000Z"
  ), 1);
  assert.equal(await domain.findEvidence(SCOPE, refusalEvidenceId), null);
  assert.notEqual(await domain.findEvidence(SCOPE, candidate.evidenceIds[0]!), null);

  job = crawlerJob("job-3", ["run-1", "run-2"]);
  records = [normalized({
    textExcerpt: "现在需要获客系统，请提供报价。",
    observedAt: "2026-11-24T03:00:00.000Z"
  })];
  const replay = await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => "2026-11-24T03:00:00.000Z"
  });
  assert.equal(replay.candidateCount, 0);
  assert.equal(replay.suppressedCount, 1);
  assert.equal((await domain.findCandidate(SCOPE, candidate.id))?.status, "do_not_contact");
  assert.equal((await domain.listAuditEvents(SCOPE, null))
    .some((event) => event.eventType === "douyin_do_not_contact_retained"), true);
});

test("running ingestion exposes candidates without completing the run and terminal replay stays idempotent", async () => {
  const { planRuns, domain, repository } = await fixture(["run-1"]);
  let job: AcquisitionCrawlerJob = {
    ...crawlerJob("job-live", ["run-1"]),
    state: "running",
    completedAt: null,
    ingestionState: null,
  };
  const records = [normalized()];
  const crawlerJobs = {
    async findByRun() { return job; },
    async listRecords() { return records; }
  };
  const ingest = (at = NOW) => ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => at
  });

  await ingest();
  const liveRun = await planRuns.getRun("run-1");
  const liveEvents = await planRuns.listRunEvents("run-1");
  const liveCandidates = await domain.listCandidates(SCOPE, { limit: 10 });
  assert.equal(liveRun?.status, "running");
  assert.equal(liveRun?.completedAt, null);
  assert.equal(liveCandidates.items.length, 1);
  assert.equal(liveEvents.filter((event) => event.type === "candidate.discovered").length, 1);
  assert.equal(liveEvents.filter((event) => event.type === "run.running").length, 1);
  assert.equal(liveEvents.some((event) => [
    "run.succeeded", "run.succeeded_empty", "run.partial_success"
  ].includes(event.type)), false);

  await ingest("2026-08-25T01:05:00.000Z");
  assert.deepEqual(await planRuns.getRun("run-1"), liveRun);
  assert.deepEqual(await planRuns.listRunEvents("run-1"), liveEvents);

  job = {
    ...job,
    state: "partial",
    completedAt: "2026-08-25T01:10:00.000Z",
    ingestionState: "pending",
  };
  await ingest("2026-08-25T01:10:00.000Z");
  const terminalRun = await planRuns.getRun("run-1");
  const terminalEvents = await planRuns.listRunEvents("run-1");
  assert.equal(terminalRun?.status, "partial_success");
  assert.equal(terminalRun?.completedAt, "2026-08-25T01:10:00.000Z");
  assert.equal((await domain.listCandidates(SCOPE, { limit: 10 })).items.length, 1);
  assert.equal(terminalEvents.filter((event) => event.type === "candidate.discovered").length, 1);
  assert.equal(terminalEvents.filter((event) => event.type === "run.partial_success").length, 1);
});

test("DNC audit dedupe uses an exact event lookup instead of reading every workspace audit", async () => {
  const { domain, repository } = await fixture(["run-1"]);
  let listAuditCalls = 0;
  const original = domain.listAuditEvents.bind(domain);
  domain.listAuditEvents = async (...input) => {
    listAuditCalls += 1;
    return original(...input);
  };
  await repository.transaction(SCOPE, async () => {
    await repository.retainDoNotContact(
      SCOPE.workspaceId,
      `dnc:sha256:${"a".repeat(64)}`,
      "explicit_refusal"
    );
    await repository.retainDoNotContact(
      SCOPE.workspaceId,
      `dnc:sha256:${"a".repeat(64)}`,
      "explicit_refusal"
    );
  });
  assert.equal(listAuditCalls, 0);
  assert.equal((await domain.listAuditEvents(SCOPE, null))
    .filter((event) => event.eventType === "douyin_do_not_contact_retained").length, 1);
});

test("authoritative ingestion rolls evidence, candidates, and run links back together", async () => {
  const { planRuns, domain, repository } = await fixture(["run-1"]);
  const job = crawlerJob("job-rollback", ["run-1", "missing-run"]);
  const records = [normalized()];
  await assert.rejects(ingestDouyinCrawlerPage({
    crawlerJobs: {
      async findByRun() { return job; },
      async listRecords() { return records; }
    },
    repository,
    workspaceId: SCOPE.workspaceId,
    runId: "run-1",
    scope: SCOPE,
    now: () => NOW
  }), /douyin_ingestion_run_binding_mismatch/u);
  assert.equal((await domain.listCandidates(SCOPE, { limit: 10 })).items.length, 0);
  assert.equal((await planRuns.listRunCandidateLinks("run-1")).length, 0);
  assert.equal((await planRuns.getRun("run-1"))?.status, "queued");
});

test("a late same-day run alias projects prior ingestion without duplicate records", async () => {
  const { planRuns, domain, repository } = await fixture(["run-1"]);
  let job = crawlerJob("job-late-alias", ["run-1"]);
  const records = [normalized()];
  const crawlerJobs = {
    async findByRun(_workspaceId: string, runId: string) {
      return job.runIds.includes(runId) ? job : null;
    },
    async listRecords() { return records; }
  };
  await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => NOW
  });
  const run1Events = await planRuns.listRunEvents("run-1");
  const plan = await planRuns.getPlan("plan-1");
  const version = await planRuns.getPlanVersion("plan-version-1");
  assert.ok(plan && version);
  await planRuns.transaction((transaction) => {
    transaction.putRun(createDouyinCollectionAcquisitionRun({
      id: "run-2", automationIntentId: "intent-run-2", plan, version,
      dailyBudgetId: `sha256:${"b".repeat(64)}`, reason: null,
      actorId: SCOPE.actorId, createdAt: "2026-08-25T01:05:00.000Z"
    }).run);
  });
  job = crawlerJob("job-late-alias", ["run-1", "run-2"]);
  await ingestDouyinCrawlerPage({
    crawlerJobs, repository, workspaceId: SCOPE.workspaceId, runId: "run-1",
    scope: SCOPE, now: () => "2026-08-25T01:05:00.000Z"
  });
  const candidates = await domain.listCandidates(SCOPE, { limit: 10 });
  assert.equal(candidates.items.length, 1);
  assert.deepEqual(await planRuns.listRunEvents("run-1"), run1Events);
  assert.equal((await planRuns.getRun("run-2"))?.status, "succeeded");
  assert.deepEqual(
    (await planRuns.listRunCandidateLinks("run-2"))
      .map((value) => value.candidateId),
    [candidates.items[0]!.id]
  );
});

test("90-day evidence retention starts at ingestion, not an old publication date", async () => {
  const { repository } = await fixture(["run-1"]);
  const job = crawlerJob("job-old-publication", ["run-1"]);
  const records = [normalized({
    publicProfileUrl: null,
    textExcerpt: "内容不符合候选条件。",
    observedAt: "2025-01-01T00:00:00.000Z"
  })];
  await ingestDouyinCrawlerPage({
    crawlerJobs: {
      async findByRun() { return job; },
      async listRecords() { return records; }
    },
    repository,
    workspaceId: SCOPE.workspaceId,
    runId: "run-1",
    scope: SCOPE,
    now: () => NOW
  });
  assert.equal(await repository.cleanupExpiredUnlinked(
    SCOPE,
    "2026-08-26T01:00:00.000Z"
  ), 0);
  assert.equal(await repository.cleanupExpiredUnlinked(
    SCOPE,
    "2026-11-24T01:00:00.001Z"
  ), 1);
});

test("MySQL ingestion schema enforces authoritative evidence and permanent DNC", async () => {
  const sql: string[] = [];
  await ensureAcquisitionDouyinCrawlerIngestionMysqlSchema({
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{
          COLUMN_TYPE: "varchar(255)",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_unicode_ci"
        }], []];
      }
      if (statement.includes("information_schema.TABLE_CONSTRAINTS")) {
        return [[{
          CONSTRAINT_NAME: "acquisition_douyin_crawler_evidence_authority"
        }], []];
      }
      return [[], []];
    }
  } as never);
  assert.deepEqual(sql.slice(0, 2), [
    acquisitionDouyinCrawlerEvidenceIndexDdl,
    acquisitionDouyinDoNotContactDdl
  ]);
  assert.match(sql[0]!, /PRIMARY KEY \(workspace_id,content_hash\)/u);
  assert.match(sql[0]!, /platform_record_id,observed_at,evidence_id/u);
  assert.match(sql[0]!, /candidate_id,retain_until/u);
  assert.match(sql[1]!, /PRIMARY KEY \(workspace_id,identity_hash\)/u);
  assert.match(sql[1]!, /\^dnc:sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(sql[2]!, /information_schema\.COLUMNS/u);
  assert.match(sql[3]!, /information_schema\.TABLE_CONSTRAINTS/u);
});

test("MySQL ingestion schema aligns evidence ids before adding the authority foreign key", async () => {
  const sql: string[] = [];
  await ensureAcquisitionDouyinCrawlerIngestionMysqlSchema({
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{
          COLUMN_TYPE: "varchar(255)",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_unicode_ci"
        }], []];
      }
      return [[], []];
    }
  } as never);

  assert.doesNotMatch(
    acquisitionDouyinCrawlerEvidenceIndexDdl,
    /CONSTRAINT acquisition_douyin_crawler_evidence_authority/u
  );
  const align = sql.findIndex((statement) =>
    /MODIFY COLUMN evidence_id VARCHAR\(255\)[\s\S]*COLLATE utf8mb4_unicode_ci/iu
      .test(statement)
  );
  const addForeignKey = sql.findIndex((statement) =>
    /ADD CONSTRAINT acquisition_douyin_crawler_evidence_authority/u
      .test(statement)
  );
  assert.notEqual(align, -1);
  assert.ok(addForeignKey > align);
});

test("live MySQL commits and rolls back authoritative crawler ingestion", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const adminUrl = new URL(process.env.MYSQL_TEST_ADMIN_URL!);
  const database = `goodjob_douyin_ingestion_${randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection(adminUrl.toString());
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${database}`;
  const pool = mysql.createPool({ uri: testUrl.toString(), connectionLimit: 4 });
  try {
    await ensureAcquisitionMysqlSchema(pool);
    await ensureAcquisitionDouyinAutomationMysqlSchema(pool);
    await ensureAcquisitionCrawlerJobMysqlSchema(pool);
    await ensureAcquisitionDouyinCrawlerIngestionMysqlSchema(pool);
    const planPayload = payload();
    const version: AcquisitionPlanVersion = {
      id: "plan-version-1", planId: "plan-1", ownerId: SCOPE.ownerId,
      teamId: SCOPE.teamId, version: 1, payload: planPayload,
      payloadHash: "sha256:plan-1", createdBy: SCOPE.actorId, createdAt: NOW
    };
    const plan: AcquisitionPlan = {
      id: "plan-1", ownerId: SCOPE.ownerId, teamId: SCOPE.teamId,
      status: "approved", version: 1, revision: 2, etag: '"plan-1:2"',
      currentVersionId: version.id, approvedVersionId: version.id,
      approvedSnapshotHash: version.payloadHash, approvedBy: SCOPE.actorId,
      approvedAt: NOW, budgetSnapshot: planPayload.budgetSnapshot,
      payload: planPayload, createdBy: SCOPE.actorId, createdAt: NOW,
      updatedBy: SCOPE.actorId, updatedAt: NOW
    };
    const planRuns = new MysqlAcquisitionPlanRunRepository(pool);
    await planRuns.transaction((transaction) => {
      transaction.putPlan(plan);
      transaction.appendPlanVersion(version);
      transaction.putRun(createDouyinCollectionAcquisitionRun({
        id: "run-1", automationIntentId: "intent-run-1", plan, version,
        dailyBudgetId: `sha256:${"b".repeat(64)}`, reason: null,
        actorId: SCOPE.actorId, createdAt: NOW
      }).run);
    });
    const domain = new MysqlAcquisitionDomainRepository(pool);
    const repository = new MysqlAcquisitionDouyinCrawlerIngestionRepository(
      pool,
      domain,
      planRuns
    );
    const insertJob = async (job: AcquisitionCrawlerJob) => {
      await pool.query(
        `INSERT INTO acquisition_crawler_jobs
         (id,workspace_id,plan_id,policy_version_id,local_date,state,
          payload_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [job.id, job.workspaceId, job.planId, job.policyVersionId,
          job.localDate, job.state, JSON.stringify(job), job.createdAt,
          job.updatedAt]
      );
    };
    const firstJob = crawlerJob("live-job-1", ["run-1"]);
    await insertJob(firstJob);
    const firstRecord = normalized();
    await ingestDouyinCrawlerPage({
      crawlerJobs: {
        async findByRun() { return firstJob; },
        async listRecords() { return [firstRecord]; }
      },
      repository,
      workspaceId: SCOPE.workspaceId,
      runId: "run-1",
      scope: SCOPE,
      now: () => NOW
    });
    const candidates = await domain.listCandidates(SCOPE, { limit: 10 });
    assert.equal(candidates.items.length, 1);
    assert.deepEqual(
      (await planRuns.listRunCandidateLinks("run-1"))
        .map((value) => value.candidateId),
      [candidates.items[0]!.id]
    );

    const rollbackJob = crawlerJob(
      "live-job-rollback",
      ["run-1", "missing-run"]
    );
    await insertJob(rollbackJob);
    const rollbackRecord = normalized({
      recordId: "comment-rollback",
      textExcerpt: "另一条公开需求。",
      observedAt: "2026-08-25T02:00:00.000Z"
    });
    await assert.rejects(ingestDouyinCrawlerPage({
      crawlerJobs: {
        async findByRun() { return rollbackJob; },
        async listRecords() { return [rollbackRecord]; }
      },
      repository,
      workspaceId: SCOPE.workspaceId,
      runId: "run-1",
      scope: SCOPE,
      now: () => "2026-08-25T02:00:00.000Z"
    }), /douyin_ingestion_run_binding_mismatch/u);
    assert.equal(await domain.findEvidence(
      SCOPE,
      deterministicId("evidence", SCOPE.workspaceId, rollbackRecord.contentHash)
    ), null);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
