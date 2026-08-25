import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionOutreachDraftFinalAuthority, MysqlAcquisitionOutreachDraftFinalAuthority } from "./acquisition-outreach-draft-authority.js";

const candidate: any = { id: "candidate-1", ownerId: "owner", teamId: "team", version: 1, status: "needs_research", evidenceIds: ["evidence-1"], profile: { kind: "individual", publicActorKey: "actor-1", sourcePlatform: "douyin" } };
const evidence: any = { id: "evidence-1", ownerId: "owner", teamId: "team", sourcePlatform: "douyin", contentHash: `sha256:${"a".repeat(64)}`, sourceSnippet: "公开提到正在寻找获客方案", provenance: { kind: "mediacrawler_public_record", sourceUrl: "https://www.douyin.com/video/1", jobId: "job-1", recordId: "record-1", upstreamCommit: "commit-1" } };
const request: any = { scope: { workspaceId: "workspace", ownerId: "owner", teamId: "team" }, candidateId: "candidate-1", evidenceIds: ["evidence-1"], publicActorKey: "actor-1", expectedCandidate: candidate, expectedEvidence: [evidence] };

test("memory final authority holds the shared DNC lock until immutable authority returns", async () => {
  let locked = false; let dnc = false; let writerRan = false; let writerAttempted = false;
  const writer = async () => { writerAttempted = true; if (locked) return; dnc = true; writerRan = true; };
  const authority = new InMemoryAcquisitionOutreachDraftFinalAuthority({
    domain: { async transaction(work: any) { return work(); }, async findCandidate() { return structuredClone(candidate); }, async findEvidence() { return structuredClone(evidence); } } as any,
    async withLockedDnc(_scope, _actor, work) { locked = true; try { const pendingWriter = writer(); const value = await work(); await pendingWriter; return value; } finally { locked = false; } },
    async hasDoNotContact() { return dnc; }
  });
  const verified = await authority.verify(request);
  assert.equal(writerAttempted, true);
  assert.equal(dnc, false, "writer cannot slip between final checks and accepted authority");
  await writer();
  assert.equal(verified.candidate.id, "candidate-1");
  assert.equal(writerRan, true);
  assert.equal(dnc, true);
});

test("mysql final authority locks candidate/evidence/absent-DNC gap and rolls back on changed authority", async () => {
  const events: string[] = [];
  const connection = { async beginTransaction() { events.push("begin"); }, async commit() { events.push("commit"); }, async rollback() { events.push("rollback"); }, release() { events.push("release"); }, async query(sql: string) { events.push(sql); return []; } };
  const authority = new MysqlAcquisitionOutreachDraftFinalAuthority({ pool: { async getConnection() { return connection; } }, async load() { return { candidate: structuredClone(candidate), evidence: [structuredClone(evidence)], dnc: false }; } });
  await authority.verify(request);
  assert.equal(events.includes("commit"), true);
  assert.equal(events.some((event) => event.includes("acquisition_candidates") && event.includes("FOR UPDATE")), true);
  assert.equal(events.some((event) => event.includes("acquisition_discovery_evidence") && event.includes("FOR UPDATE")), true);
  assert.equal(events.some((event) => event.includes("acquisition_douyin_do_not_contact") && event.includes("FOR UPDATE")), true);
  const failed = new MysqlAcquisitionOutreachDraftFinalAuthority({ pool: { async getConnection() { return connection; } }, async load() { return { candidate: structuredClone(candidate), evidence: [structuredClone(evidence)], dnc: true }; } });
  await assert.rejects(failed.verify(request), /OUTREACH_CANDIDATE_AUTHORITY_CHANGED/u);
  assert.equal(events.includes("rollback"), true);
});
