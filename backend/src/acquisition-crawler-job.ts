import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export type AcquisitionCrawlerJobState =
  | "scheduled" | "queued" | "running" | "succeeded" | "partial"
  | "paused" | "cancelled" | "failed";

export interface AcquisitionCrawlerLimits {
  maxVideos: number;
  maxCommentsPerVideo: number;
  maxPagesPerVideo: number;
  maxDurationSeconds: number;
}

export interface AcquisitionCrawlerJobInput {
  id: string;
  workspaceId: string;
  runId: string;
  automationIntentId: string;
  planId: string;
  planVersionId: string;
  planSnapshotHash: string;
  policyVersionId: string;
  policyHash: string;
  accountId: string;
  accountLoginStateVersion: number;
  dailyBudgetId: string;
  localDate: string;
  trigger: "scheduled" | "run_now";
  dailyCandidateLimit: number;
  keywords: string[];
  collectCreators: boolean;
  collectDemandComments: boolean;
  limits: AcquisitionCrawlerLimits;
  createdAt: string;
  maxAttempts?: number;
}

export interface NormalizedDouyinRecord {
  recordId: string;
  kind: "video" | "creator" | "comment";
  actorKind: "creator" | "commenter" | null;
  canonicalUrl: string;
  publicDisplayName: string;
  publicProfileUrl: string | null;
  textExcerpt: string;
  sourceKeyword: string;
  observedAt: string;
  contentHash: string;
}

export interface PersistedNormalizedDouyinRecord
extends NormalizedDouyinRecord {
  pageCursor: string | null;
}

export interface AcquisitionCrawlerJob extends AcquisitionCrawlerJobInput {
  state: AcquisitionCrawlerJobState;
  runIds: string[];
  automationIntentIds: string[];
  attempt: number;
  maxAttempts: number;
  cursor: string | null;
  cursorHistory: string[];
  recordCount: number;
  candidateBudgetUsed: number;
  cancelRequestedAt: string | null;
  lastErrorCode: string | null;
  leaseWorkerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  updatedAt: string;
  completedAt: string | null;
  ingestionState: "pending" | "running" | "succeeded" | "failed" | null;
  ingestionAttempt: number;
  ingestionLeaseWorkerId: string | null;
  ingestionLeaseToken: string | null;
  ingestionLeaseExpiresAt: string | null;
  ingestionFencingToken: number;
  ingestedAt: string | null;
  acknowledgedAt: string | null;
}

export interface AcquisitionCrawlerJobFence {
  jobId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
}

export interface AcquisitionCrawlerJobClaim {
  job: AcquisitionCrawlerJob;
  fence: AcquisitionCrawlerJobFence;
}

export interface AcquisitionCrawlerIngestionFence {
  jobId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
}

export interface AcquisitionCrawlerIngestionClaim {
  job: AcquisitionCrawlerJob;
  fence: AcquisitionCrawlerIngestionFence;
}

export interface AcquisitionCrawlerStatus {
  runId: string;
  state: AcquisitionCrawlerJobState;
  attempt: number;
  cursorPersisted: boolean;
  recordCount: number;
  candidateBudgetUsed: number;
  candidateBudgetLimit: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function validInstant(value: string) {
  return Number.isFinite(Date.parse(value));
}

function integerBetween(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum
    && Number(value) <= maximum;
}

function boundedId(value: unknown, maximum = 255) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

export function assertCrawlerJobInput(input: AcquisitionCrawlerJobInput) {
  if (!boundedId(input.id) || !boundedId(input.workspaceId)
    || !boundedId(input.runId, 160) || !boundedId(input.automationIntentId)
    || !boundedId(input.planId, 160) || !boundedId(input.planVersionId, 160)
    || !boundedId(input.planSnapshotHash, 200)
    || !boundedId(input.policyVersionId) || !boundedId(input.accountId)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.policyHash)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.dailyBudgetId)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)
    || !Number.isSafeInteger(input.accountLoginStateVersion)
    || input.accountLoginStateVersion < 1
    || !Number.isSafeInteger(input.dailyCandidateLimit)
    || input.dailyCandidateLimit < 1 || input.dailyCandidateLimit > 200
    || !Array.isArray(input.keywords) || input.keywords.length < 1
    || input.keywords.length > 20 || input.keywords.some((value) =>
      typeof value !== "string" || !value.trim() || [...value].length > 100)
    || !["scheduled", "run_now"].includes(input.trigger)
    || typeof input.collectCreators !== "boolean"
    || typeof input.collectDemandComments !== "boolean"
    || (!input.collectCreators && !input.collectDemandComments)
    || !integerBetween(input.limits?.maxVideos, 1, 200)
    || !integerBetween(input.limits?.maxCommentsPerVideo, 1, 200)
    || !integerBetween(input.limits?.maxPagesPerVideo, 1, 20)
    || !integerBetween(input.limits?.maxDurationSeconds, 60, 14_400)
    || (input.maxAttempts !== undefined
      && !integerBetween(input.maxAttempts, 1, 10))
    || !validInstant(input.createdAt)) {
    throw new TypeError("invalid_crawler_job_input");
  }
}

export function assertNormalizedDouyinRecord(record: NormalizedDouyinRecord) {
  const keys = ["recordId", "kind", "actorKind", "canonicalUrl", "publicDisplayName",
    "publicProfileUrl", "textExcerpt", "sourceKeyword", "observedAt", "contentHash"];
  const actorProfile = (() => {
    if (!record.publicProfileUrl) return false;
    try {
      const url = new URL(record.publicProfileUrl);
      return url.protocol === "https:" && url.hostname === "www.douyin.com"
        && url.port === "" && url.search === "" && url.hash === ""
        && /^\/user\/[A-Za-z0-9_-]{1,300}$/u.test(url.pathname);
    } catch { return false; }
  })();
  if (Object.keys(record).some((key) => !keys.includes(key))
    || !boundedId(record.recordId)
    || !["video", "creator", "comment"].includes(record.kind)
    || (record.kind === "video" && record.actorKind !== null)
    || (record.kind === "creator" && record.actorKind !== "creator")
    || (record.kind === "comment" && record.actorKind !== "commenter")
    || (record.kind !== "video" && !actorProfile)
    || record.canonicalUrl.length > 2_000
    || !record.canonicalUrl.startsWith("https://www.douyin.com/")
    || record.publicDisplayName.length > 200
    || (record.publicProfileUrl !== null
      && (record.publicProfileUrl.length > 2_000
        || !record.publicProfileUrl.startsWith("https://www.douyin.com/")))
    || [...record.textExcerpt].length > 500
    || [...record.sourceKeyword].length > 100 || !validInstant(record.observedAt)
    || !/^sha256:[0-9a-f]{64}$/u.test(record.contentHash)) {
    throw new TypeError("invalid_normalized_douyin_record");
  }
  if (record.contentHash !== normalizedDouyinContentHash(record)) {
    throw new TypeError("normalized_douyin_content_hash_mismatch");
  }
}

export function normalizedDouyinContentHash(
  record: Omit<NormalizedDouyinRecord, "contentHash" | "observedAt">
) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify({
    canonical_url: record.canonicalUrl,
    kind: record.kind,
    actor_kind: record.actorKind,
    public_display_name: record.publicDisplayName,
    public_profile_url: record.publicProfileUrl,
    record_id: record.recordId,
    source_keyword: record.sourceKeyword,
    text_excerpt: record.textExcerpt
  }), "utf8").digest("hex")}`;
}

export function normalizedDouyinLegacyContentHash(
  record: Omit<NormalizedDouyinRecord, "actorKind" | "contentHash" | "observedAt">
) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify({
    canonical_url: record.canonicalUrl,
    kind: record.kind,
    public_display_name: record.publicDisplayName,
    public_profile_url: record.publicProfileUrl,
    record_id: record.recordId,
    source_keyword: record.sourceKeyword,
    text_excerpt: record.textExcerpt
  }), "utf8").digest("hex")}`;
}

export function crawlerStatus(job: AcquisitionCrawlerJob, runId: string): AcquisitionCrawlerStatus {
  return Object.freeze({
    runId, state: job.state, attempt: job.attempt,
    cursorPersisted: job.cursor !== null, recordCount: job.recordCount,
    candidateBudgetUsed: job.candidateBudgetUsed,
    candidateBudgetLimit: job.dailyCandidateLimit,
    lastErrorCode: job.lastErrorCode, createdAt: job.createdAt,
    updatedAt: job.updatedAt, completedAt: job.completedAt
  });
}
