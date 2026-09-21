import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  douyinDoNotContactIdentityHash
} from "./acquisition-douyin-crawler-ingestion.js";
import {
  ensureAcquisitionCrawlerJobMysqlSchema
} from "./acquisition-crawler-job-mysql-repository.js";
import {
  ensureAcquisitionDouyinAutomationMysqlSchema
} from "./acquisition-douyin-automation-mysql-repository.js";
import {
  ensureAcquisitionDouyinCrawlerIngestionMysqlSchema,
  InMemoryAcquisitionDouyinCrawlerIngestionRepository,
  MysqlAcquisitionDouyinCrawlerIngestionRepository
} from "./acquisition-douyin-crawler-ingestion-repository.js";
import {
  ensureAcquisitionMysqlSchema,
  MysqlAcquisitionDomainRepository,
  MysqlAcquisitionPlanRunRepository
} from "./acquisition-mysql-repositories.js";
import { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";
import { InMemoryAcquisitionPlanRunRepository } from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionOutreachDraftFinalAuthority,
  MysqlAcquisitionOutreachDraftFinalAuthority
} from "./acquisition-outreach-draft-authority.js";

const SCOPE = Object.freeze({
  workspaceId: "workspace",
  ownerId: "owner",
  teamId: "team",
  actorId: "outreach-authority-test"
});
const candidate: any = {
  id: "candidate-1", ownerId: "owner", teamId: "team",
  partyType: "individual",
  partyRef: {
    partyType: "individual",
    individualPartyId: "individual-1",
    demandSignalId: "signal-1"
  },
  version: 1, status: "needs_research", evidenceIds: ["evidence-1"],
  profile: {
    kind: "individual", publicActorKey: "actor-1",
    publicDisplayName: "公开用户", publicProfileUrl: "https://www.douyin.com/user/actor-1",
    sourcePlatform: "douyin", demandCategory: "public_business_demand",
    demandSummary: "公开需求", locationHint: "", buyingStage: "solution_research",
    negativeSignals: []
  },
  latestDecisionId: null, latestDecisionVersion: null,
  approvedDecisionVersion: null, hardGateFailures: [], leadId: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};
const evidence: any = {
  id: "evidence-1", ownerId: "owner", teamId: "team",
  targetType: "individual_signal", sourcePlatform: "douyin",
  sourceTitle: "获客", sourceSnippet: "公开提到正在寻找获客方案",
  publishedAt: "2026-08-25T00:00:00.000Z", locale: "zh-CN",
  rawArtifactHash: `sha256:${"a".repeat(64)}`,
  contentHash: `sha256:${"a".repeat(64)}`,
  provenance: {
    kind: "mediacrawler_public_record",
    sourceUrl: "https://www.douyin.com/video/1", jobId: "job-1",
    recordId: "record-1", actorKind: "commenter", cursor: "cursor-1",
    upstreamCommit: "commit-1"
  },
  accessStatus: "public_content", supersedesEvidenceId: null,
  fetchedAt: "2026-08-25T00:00:00.000Z"
};
const request: any = {
  scope: SCOPE, candidateId: "candidate-1", evidenceIds: ["evidence-1"],
  publicActorKey: "actor-1", expectedCandidate: candidate,
  expectedEvidence: [evidence]
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("memory final authority and the real DNC writer serialize on the shared coordinator", async () => {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const domain = new InMemoryAcquisitionDomainRepository();
  const planRuns = new InMemoryAcquisitionPlanRunRepository(memoryTransactions);
  const doNotContact = new InMemoryAcquisitionDouyinCrawlerIngestionRepository(
    domain,
    planRuns
  );
  await domain.appendEvidence(structuredClone(evidence));
  await domain.insertCandidate(structuredClone(candidate));
  const authority = new InMemoryAcquisitionOutreachDraftFinalAuthority({
    domain,
    doNotContact
  });

  const holding = deferred();
  const entered = deferred();
  const holder = doNotContact.transaction(SCOPE, async () => {
    entered.resolve();
    await holding.promise;
  });
  await entered.promise;
  const verification = authority.verify(request);
  let writerFinished = false;
  const writer = doNotContact.transaction(SCOPE, async () => {
    await doNotContact.retainDoNotContact(
      SCOPE.workspaceId,
      douyinDoNotContactIdentityHash(request.publicActorKey),
      "explicit_refusal"
    );
    writerFinished = true;
  });
  holding.resolve();
  const verified = await verification;
  assert.equal(writerFinished, false, "queued writer cannot interleave with final verification");
  await writer;
  await holder;
  await assert.rejects(authority.verify(request), /OUTREACH_CANDIDATE_AUTHORITY_CHANGED/u);

  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.candidate), true);
  assert.equal(Object.isFrozen(verified.candidate.profile), true);
  assert.equal(Object.isFrozen(verified.candidate.partyRef), true);
  assert.equal(Object.isFrozen(verified.candidate.evidenceIds), true);
  assert.equal(Object.isFrozen(verified.evidence), true);
  assert.equal(Object.isFrozen(verified.evidence[0]), true);
  assert.equal(Object.isFrozen(verified.evidence[0]!.provenance), true);
  assert.throws(() => {
    (verified.candidate.profile as any).publicDisplayName = "篡改";
  }, TypeError);
  assert.throws(() => {
    (verified.candidate.evidenceIds as string[]).push("forged");
  }, TypeError);
  assert.throws(() => {
    (verified.evidence[0]!.provenance as any).sourceUrl = "https://bad.example";
  }, TypeError);
  assert.equal((verified.candidate.profile as any).publicDisplayName, "公开用户");
  assert.deepEqual(verified.candidate.evidenceIds, ["evidence-1"]);
  assert.equal((verified.evidence[0]!.provenance as any).sourceUrl, "https://www.douyin.com/video/1");
});

test("real MySQL final authority uses one connection and key-gap-locks a DNC writer", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    && !process.env.MYSQL_TEST_ADMIN_SOCKET
    ? "MYSQL_TEST_ADMIN_URL or MYSQL_TEST_ADMIN_SOCKET is required; no database is provisioned implicitly"
    : false
}, async () => {
  const database = `goodjob_outreach_authority_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL
    ? new URL(process.env.MYSQL_TEST_ADMIN_URL)
    : null;
  const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim() || null;
  const admin = await mysql.createConnection(socketPath
    ? { user: "root", password: "", socketPath, database: "mysql" }
    : adminUrl!.toString());
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  const pool = socketPath
    ? mysql.createPool({
        user: "root", password: "", socketPath, database, connectionLimit: 4
      })
    : (() => {
        const testUrl = new URL(adminUrl!);
        testUrl.pathname = `/${database}`;
        return mysql.createPool({ uri: testUrl.toString(), connectionLimit: 4 });
      })();
  try {
    await ensureAcquisitionMysqlSchema(pool);
    await ensureAcquisitionDouyinAutomationMysqlSchema(pool);
    await ensureAcquisitionCrawlerJobMysqlSchema(pool);
    await ensureAcquisitionDouyinCrawlerIngestionMysqlSchema(pool);
    const domain = new MysqlAcquisitionDomainRepository(pool);
    await domain.transaction(async () => {
      await domain.appendEvidence(structuredClone(evidence));
      await domain.insertCandidate(structuredClone(candidate));
    });
    const locked = deferred();
    const releaseVerification = deferred();
    const connectionIds = new Set<number>();
    const statements: string[] = [];
    const verificationPool = {
      query: pool.query.bind(pool),
      async getConnection() {
        const connection = await pool.getConnection();
        const query = connection.query.bind(connection);
        return new Proxy(connection, {
          get(target, property, receiver) {
            if (property !== "query") return Reflect.get(target, property, receiver);
            return async (sql: string, values?: unknown[]) => {
              statements.push(sql);
              connectionIds.add(connection.threadId);
              const result = await query(sql, values as never);
              if (sql.includes("acquisition_douyin_do_not_contact")
                && sql.includes("FOR UPDATE")) {
                locked.resolve();
                await releaseVerification.promise;
              }
              return result;
            };
          }
        });
      }
    } as unknown as mysql.Pool;
    const planRuns = new MysqlAcquisitionPlanRunRepository(pool);
    const doNotContact = new MysqlAcquisitionDouyinCrawlerIngestionRepository(
      verificationPool,
      domain,
      planRuns
    );
    const authority = new MysqlAcquisitionOutreachDraftFinalAuthority({
      domain,
      doNotContact
    });
    const verification = authority.verify(request);
    await locked.promise;

    const writerConnection = await pool.getConnection();
    await writerConnection.beginTransaction();
    let writerFinished = false;
    const writer = writerConnection.query(
      `INSERT INTO acquisition_douyin_do_not_contact
       (workspace_id,identity_hash,reason,first_observed_at,last_observed_at)
       VALUES (?,?,?,?,?)`,
      [SCOPE.workspaceId, douyinDoNotContactIdentityHash(request.publicActorKey),
        "explicit_refusal", "2026-08-25 00:00:01.000",
        "2026-08-25 00:00:01.000"]
    ).then(() => { writerFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writerFinished, false, "DNC insert must wait on the exact absent-key gap lock");
    releaseVerification.resolve();
    await verification;
    await writer;
    await writerConnection.commit();
    writerConnection.release();

    assert.equal(connectionIds.size, 1, "all final authority reads use its one transaction connection");
    assert.equal(statements.some((sql) => sql.includes("acquisition_candidates") && sql.includes("FOR UPDATE")), true);
    assert.equal(statements.some((sql) => sql.includes("acquisition_discovery_evidence") && sql.includes("FOR UPDATE")), true);
    assert.equal(statements.some((sql) => sql.includes("acquisition_douyin_do_not_contact") && sql.includes("FOR UPDATE")), true);
    await assert.rejects(authority.verify(request), /OUTREACH_CANDIDATE_AUTHORITY_CHANGED/u);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
