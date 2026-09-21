import { createHash } from "node:crypto";
import {
  canonicalSubjectStableKey
} from "./acquisition-canonical-subject.js";
import type { BuyingStage } from "./acquisition-domain.js";
import type { NormalizedDouyinRecord } from "./acquisition-crawler-job.js";
import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import { MEDIACRAWLER_PINNED_UPSTREAM_COMMIT } from "./acquisition-mediacrawler-gateway.js";
import { classifyDouyinPublicSource } from "./acquisition-douyin-public-source.js";
import { qualifyDouyinCrawlerCandidate } from "./acquisition-douyin-candidate-policy.js";


export interface DouyinCrawlerEvidence {
  id: string;
  workspaceId: string;
  contentHash: string;
  platformRecordId: string;
  sourceUrl: string;
  sourceKeyword: string;
  observedAt: string;
  sourceSnippet: string;
  supersedesEvidenceId: string | null;
  provenance: {
    kind: "mediacrawler_public_record";
    jobId: string; recordId: string; actorKind: "creator" | "commenter";
    cursor: string | null; upstreamCommit: string;
  };
}

export interface DouyinCrawlerCandidate {
  id: string;
  workspaceId: string;
  subjectStableKey: string;
  publicActorKey: string;
  displayName: string;
  publicProfileUrl: string;
  buyingStage: BuyingStage;
  evidenceIds: string[];
  status: "needs_research" | "do_not_contact";
}

export interface DouyinCrawlerEvidenceStore {
  transaction?<T>(scope: {
    workspaceId: string;
    ownerId: string;
    teamId: string;
    actorId: string;
    now?: string;
  }, work: () => Promise<T>): Promise<T>;
  findEvidenceByContentHash(workspaceId: string, contentHash: string): Promise<DouyinCrawlerEvidence | null>;
  findLatestEvidenceByRecord?(workspaceId: string, jobId: string, recordId: string): Promise<DouyinCrawlerEvidence | null>;
  appendEvidence(evidence: DouyinCrawlerEvidence): Promise<DouyinCrawlerEvidence>;
  findCandidateBySubjectKey(workspaceId: string, subjectStableKey: string): Promise<DouyinCrawlerCandidate | null>;
  saveCandidate(candidate: DouyinCrawlerCandidate): Promise<DouyinCrawlerCandidate>;
  hasDoNotContact(workspaceId: string, identityHash: string): Promise<boolean>;
  retainDoNotContact(workspaceId: string, identityHash: string, reason?: string): Promise<void>;
  persistRunLinks?(input: {
    job: {
      id: string;
      workspaceId: string;
      runIds: string[];
      planId: string;
      planVersionId: string;
      planSnapshotHash: string;
      state: string;
    };
    candidateIds: string[];
    evidenceCount: number;
    at: string;
  }): void | Promise<void>;
}

export interface DouyinCrawlerIngestionResult {
  evidenceCount: number;
  candidateCount: number;
  suppressedCount: number;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function publicActorKey(record: NormalizedDouyinRecord) {
  const profile = record.publicProfileUrl?.trim();
  if (!profile || Buffer.byteLength(profile, "utf8") > 2_000) return "";
  try {
    const url = new URL(profile);
    const match = /^\/user\/([A-Za-z0-9_-]{1,300})$/u.exec(url.pathname);
    return url.protocol === "https:" && url.hostname === "www.douyin.com"
      && url.port === "" && url.search === "" && url.hash === "" && match
      ? `douyin:/user/${match[1]}` : "";
  } catch { return ""; }
}

export function douyinDoNotContactIdentityHash(actorKey: string) {
  return `dnc:sha256:${hash(`douyin\u0000${actorKey}`)}`;
}

function boundedExcerpt(value: string) {
  return [...value.normalize("NFKC").trim()].slice(0, 500).join("");
}

function idFor(prefix: string, workspaceId: string, value: string) {
  return `${prefix}:${hash(`${workspaceId}\u0000${value}`).slice(0, 32)}`;
}

/**
 * Converts a persisted, Task-4-validated page into bounded evidence and an
 * identity-stable individual candidate. It deliberately has no model port.
 */
export async function ingestDouyinCrawlerPage(input: {
  crawlerJobs: Pick<AcquisitionCrawlerJobRepository, "findByRun" | "listRecords">;
  repository: DouyinCrawlerEvidenceStore;
  workspaceId: string;
  runId: string;
  scope?: { ownerId: string; teamId: string; actorId: string };
  now?: () => string;
}): Promise<DouyinCrawlerIngestionResult> {
  const job = await input.crawlerJobs.findByRun(input.workspaceId, input.runId);
  if (!job || job.workspaceId !== input.workspaceId || !job.runIds.includes(input.runId)
    || !["running", "succeeded", "partial"].includes(job.state)) {
    throw new Error("untrusted_crawler_page");
  }
  const records = await input.crawlerJobs.listRecords(job.id);
  const ingestedAt = input.now?.() ?? new Date().toISOString();
  const execute = async () => {
    const result: DouyinCrawlerIngestionResult = { evidenceCount: 0, candidateCount: 0, suppressedCount: 0 };
    const candidateIds = new Set<string>();
    const evidenceIds = new Set<string>();
    for (const record of records) {
      if (record.kind !== "creator" && record.kind !== "comment") continue;
      const actorKey = publicActorKey(record);
      const boundedSourceUrl = record.canonicalUrl.startsWith("https://")
        && Buffer.byteLength(record.canonicalUrl, "utf8") <= 2_000;
      const source = boundedSourceUrl
        ? classifyDouyinPublicSource(record.canonicalUrl, "", record.textExcerpt)
        : null;
      const policy = qualifyDouyinCrawlerCandidate({
        text: record.textExcerpt,
        kind: record.kind,
        hasOriginalPublicSource: Boolean(source),
        hasKnownIdentity: Boolean(actorKey)
      });
      const dncHash = actorKey ? douyinDoNotContactIdentityHash(actorKey) : null;

      // A valid public record remains bounded evidence even when its edited
      // content creates a permanent DNC. This preserves the exact refusal or
      // complaint that justified suppression without re-admitting the actor.
      let evidence: DouyinCrawlerEvidence | null = null;
      if (source && boundedSourceUrl) {
        evidence = await input.repository.findEvidenceByContentHash(
          input.workspaceId,
          record.contentHash
        );
        if (!evidence) {
          const previous = await input.repository.findLatestEvidenceByRecord?.(
            input.workspaceId, job.id, record.recordId
          ) ?? null;
          evidence = await input.repository.appendEvidence({
            id: idFor("evidence", input.workspaceId, record.contentHash),
            workspaceId: input.workspaceId,
            contentHash: record.contentHash,
            platformRecordId: record.recordId,
            sourceUrl: record.canonicalUrl,
            sourceKeyword: record.sourceKeyword,
            observedAt: record.observedAt,
            sourceSnippet: boundedExcerpt(record.textExcerpt),
            supersedesEvidenceId: previous?.id ?? null,
            provenance: {
              kind: "mediacrawler_public_record",
              jobId: job.id,
              recordId: record.recordId,
              actorKind: record.actorKind!,
              cursor: record.pageCursor,
              upstreamCommit: MEDIACRAWLER_PINNED_UPSTREAM_COMMIT
            }
          });
          result.evidenceCount += 1;
        }
        evidenceIds.add(evidence.id);
      }

      if (policy.status === "suppressed") {
        if (policy.retainDoNotContact && dncHash) {
          await input.repository.retainDoNotContact(
            input.workspaceId,
            dncHash,
            policy.reason
          );
        }
        if (actorKey) {
          const resolved = canonicalSubjectStableKey(input.workspaceId, {
            kind: "individual", platform: "douyin", publicActorKey: actorKey,
            canonicalProfileUrl: record.publicProfileUrl
          });
          if (resolved.subjectStableKey) {
            const existing = await input.repository.findCandidateBySubjectKey(
              input.workspaceId,
              resolved.subjectStableKey
            );
            if (existing && policy.retainDoNotContact) {
              await input.repository.saveCandidate({
                ...existing,
                status: "do_not_contact"
              });
            }
          }
        }
        result.suppressedCount += 1;
        continue;
      }
      if (!source || !evidence) { result.suppressedCount += 1; continue; }
      if (!actorKey) { result.suppressedCount += 1; continue; }
      if (await input.repository.hasDoNotContact(input.workspaceId, dncHash!)) {
        result.suppressedCount += 1;
        continue;
      }
      const resolved = canonicalSubjectStableKey(input.workspaceId, {
        kind: "individual", platform: "douyin", publicActorKey: actorKey,
        canonicalProfileUrl: record.publicProfileUrl
      });
      if (!resolved.subjectStableKey || !record.publicProfileUrl) {
        result.suppressedCount += 1;
        continue;
      }
      const existing = await input.repository.findCandidateBySubjectKey(
        input.workspaceId,
        resolved.subjectStableKey
      );
      if (!existing) {
        const candidateId = idFor("candidate", input.workspaceId, resolved.subjectStableKey);
        await input.repository.saveCandidate({
          id: candidateId,
          workspaceId: input.workspaceId,
          subjectStableKey: resolved.subjectStableKey,
          publicActorKey: actorKey,
          displayName: record.publicDisplayName,
          publicProfileUrl: record.publicProfileUrl,
          buyingStage: policy.buyingStage,
          evidenceIds: [evidence.id],
          status: "needs_research"
        });
        result.candidateCount += 1;
        candidateIds.add(candidateId);
      } else if (!existing.evidenceIds.includes(evidence.id)) {
        await input.repository.saveCandidate({
          ...existing,
          buyingStage: policy.buyingStage,
          evidenceIds: [...existing.evidenceIds, evidence.id]
        });
        candidateIds.add(existing.id);
      } else {
        candidateIds.add(existing.id);
      }
    }
    await input.repository.persistRunLinks?.({
      job,
      candidateIds: [...candidateIds],
      evidenceCount: evidenceIds.size,
      at: ingestedAt
    });
    return result;
  };
  if (!input.repository.transaction) return execute();
  if (!input.scope) throw new Error("douyin_ingestion_scope_required");
  return input.repository.transaction({
    workspaceId: input.workspaceId,
    ...input.scope,
    now: ingestedAt
  }, execute);
}
