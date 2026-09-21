import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ingestDouyinCrawlerPage,
  type DouyinCrawlerEvidenceStore
} from "./acquisition-douyin-crawler-ingestion.js";
import { qualifyDouyinCrawlerCandidate } from "./acquisition-douyin-candidate-policy.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function record(overrides: Partial<{
  recordId: string; kind: "creator" | "comment"; canonicalUrl: string;
  publicDisplayName: string; publicProfileUrl: string | null; textExcerpt: string;
  sourceKeyword: string; observedAt: string; contentHash: string;
}> = {}) {
  return {
    recordId: "comment-1", kind: "comment" as const,
    canonicalUrl: "https://www.douyin.com/video/7350000000000000001",
    publicDisplayName: "公开用户", publicProfileUrl: "https://www.douyin.com/user/abc",
    textExcerpt: "门店正在寻找获客方案，想咨询报价。", sourceKeyword: "门店获客",
    observedAt: "2026-08-24T00:00:00.000Z", contentHash: sha("comment-1"),
    ...overrides
  };
}

function store(): DouyinCrawlerEvidenceStore & { evidence: unknown[]; candidates: unknown[]; dnc: string[] } {
  const evidence: unknown[] = []; const candidates: unknown[] = []; const dnc: string[] = [];
  return {
    evidence, candidates, dnc,
    async findEvidenceByContentHash(_workspaceId, contentHash) {
      return evidence.find((item: any) => item.contentHash === contentHash) as any ?? null;
    },
    async findLatestEvidenceByRecord(_workspaceId, jobId, recordId) {
      return evidence.findLast((item: any) => item.provenance.jobId === jobId && item.platformRecordId === recordId) as any ?? null;
    },
    async appendEvidence(item) { evidence.push(item); return item; },
    async findCandidateBySubjectKey(_workspaceId, subjectStableKey) {
      return candidates.find((item: any) => item.subjectStableKey === subjectStableKey) as any ?? null;
    },
    async saveCandidate(item) { const index = candidates.findIndex((value: any) => value.id === item.id); if (index < 0) candidates.push(item); else candidates[index] = item; return item; },
    async hasDoNotContact(_workspaceId, identityHash) { return dnc.includes(identityHash); },
    async retainDoNotContact(_workspaceId, identityHash) { if (!dnc.includes(identityHash)) dnc.push(identityHash); }
  };
}

function crawlerJobs(records: ReturnType<typeof record>[], workspaceId = "workspace-1") {
  return {
    async findByRun(workspace: string, runId: string) {
      return workspace === workspaceId && runId === "run-1" ? {
        id: "job-1", workspaceId, runId, runIds: ["run-1"], state: "succeeded" as const,
        cursor: "cursor-1", completedAt: "2026-08-24T01:00:00.000Z"
      } : null;
    },
    async listRecords(jobId: string) { return jobId === "job-1" ? records : []; }
  };
}

test("ingestion creates one bounded evidence row and one stable candidate for duplicate records", async () => {
  const repository = store();
  const input = { workspaceId: "workspace-1", runId: "run-1" };
  const crawler = crawlerJobs([record(), record()]);
  const first = await ingestDouyinCrawlerPage({ repository, crawlerJobs: crawler, ...input, now: () => "2026-08-24T01:00:00.000Z" });
  const replay = await ingestDouyinCrawlerPage({ repository, crawlerJobs: crawler, ...input, now: () => "2026-08-24T01:00:00.000Z" });
  assert.deepEqual(first, { evidenceCount: 1, candidateCount: 1, suppressedCount: 0 });
  assert.deepEqual(replay, { evidenceCount: 0, candidateCount: 0, suppressedCount: 0 });
  assert.equal(repository.evidence.length, 1);
  assert.equal((repository.evidence[0] as any).sourceSnippet.length <= 500, true);
  assert.equal(repository.candidates.length, 1);
});

test("video authors remain evidence, not prospects even when their description includes demand words", async () => {
  const repository = store();
  const result = await ingestDouyinCrawlerPage({
    repository, workspaceId: "workspace-1", runId: "run-1",
    crawlerJobs: crawlerJobs([record({ kind: "creator", recordId: "creator-1", textExcerpt: "需要电子合同？找我们报价" })])
  });
  assert.deepEqual(result, { evidenceCount: 1, candidateCount: 0, suppressedCount: 1 });
  assert.equal(repository.evidence.length, 1);
  assert.equal(repository.candidates.length, 0);
  assert.equal(repository.dnc.length, 0);
});

test("edited comments supersede the previous record evidence and refusals are retained as DNC", async () => {
  const repository = store();
  let records = [record()];
  const common = { repository, crawlerJobs: { async findByRun() { return { id: "job-1", workspaceId: "workspace-1", runId: "run-1", runIds: ["run-1"], state: "succeeded" as const, cursor: "cursor-1" }; }, async listRecords() { return records; } }, workspaceId: "workspace-1", runId: "run-1", now: () => "2026-08-24T01:00:00.000Z" };
  await ingestDouyinCrawlerPage(common);
  records = [record({ textExcerpt: "请勿联系，拒绝推销", contentHash: sha("comment-1-edited") })];
  await ingestDouyinCrawlerPage(common);
  assert.equal(repository.evidence.length, 2);
  assert.equal((repository.evidence[1] as any).supersedesEvidenceId, (repository.evidence[0] as any).id);
  assert.equal(repository.dnc.length, 1);
});

test("ingestion rejects a forged page and suppresses a record without public profile identity", async () => {
  const repository = store();
  const input = { repository, workspaceId: "workspace-1", runId: "run-1" };
  await assert.rejects(
    ingestDouyinCrawlerPage({ ...input, crawlerJobs: crawlerJobs([record()], "workspace-2") }),
    /untrusted_crawler_page/u
  );
  const result = await ingestDouyinCrawlerPage({ ...input, crawlerJobs: crawlerJobs([record({ publicProfileUrl: null })]) });
  assert.deepEqual(result, { evidenceCount: 1, candidateCount: 0, suppressedCount: 1 });
  assert.equal(repository.candidates.length, 0);
});

test("numeric Chinese minor ages are suppressed despite punctuation or spacing", () => {
  for (const text of [
    "我今年17岁，想学习。现在需要获客方案",
    "我今年 17 岁，想学习。现在需要获客方案",
    "我今年１７岁！现在需要获客方案"
  ]) {
    assert.deepEqual(qualifyDouyinCrawlerCandidate({
      text,
      kind: "comment",
      hasOriginalPublicSource: true,
      hasKnownIdentity: true
    }), {
      status: "suppressed",
      buyingStage: null,
      reason: "minor_signal",
      retainDoNotContact: true
    });
  }
});
