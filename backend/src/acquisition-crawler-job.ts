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

export interface AcquisitionCrawlerActivity {
  phase: "queued" | "starting_browser" | "opening_douyin" | "searching"
    | "collecting_comments" | "finalizing" | "completed";
  currentKeyword: string | null;
  browserMode: "visible" | "headless";
  sequence: number;
}

export const acquisitionCrawlerStoredErrorCodes = [
  "crawler_account_binding_changed",
  "crawler_page_limit_exceeded",
  "crawler_candidate_budget_exhausted",
  "crawler_lease_expired",
  "crawler_ingestion_lease_expired",
  "crawler_worker_failed",
  "crawler_ingestion_failed",
  "mediacrawler_job_paused",
  "mediacrawler_job_failed",
  "mediacrawler_partial",
  "crawl_interrupted_after_partial_results"
] as const;

export type AcquisitionCrawlerStoredErrorCode =
  typeof acquisitionCrawlerStoredErrorCodes[number];

const acquisitionCrawlerStoredErrorCodeSet = new Set<string>(
  acquisitionCrawlerStoredErrorCodes
);

export function isAcquisitionCrawlerStoredErrorCode(
  value: unknown
): value is AcquisitionCrawlerStoredErrorCode {
  return typeof value === "string"
    && acquisitionCrawlerStoredErrorCodeSet.has(value);
}

export function normalizeAcquisitionCrawlerStoredErrorCode(
  value: unknown,
  fallback: AcquisitionCrawlerStoredErrorCode | null
): AcquisitionCrawlerStoredErrorCode | null {
  if (value === null || value === undefined) return null;
  return isAcquisitionCrawlerStoredErrorCode(value) ? value : fallback;
}

export function publicAcquisitionCrawlerErrorCode(
  value: unknown
): AcquisitionCrawlerStoredErrorCode | null {
  const normalized = normalizeAcquisitionCrawlerStoredErrorCode(
    value,
    "crawler_worker_failed"
  );
  return normalized === "crawl_interrupted_after_partial_results"
    ? "mediacrawler_partial" : normalized;
}

export function clearAcquisitionCrawlerIngestionErrorCode(
  value: unknown
): AcquisitionCrawlerStoredErrorCode | null {
  const normalized = normalizeAcquisitionCrawlerStoredErrorCode(
    value,
    "crawler_worker_failed"
  );
  return normalized === "crawler_ingestion_failed"
    || normalized === "crawler_ingestion_lease_expired" ? null : normalized;
}

export const defaultAcquisitionCrawlerActivity: AcquisitionCrawlerActivity = Object.freeze({
  phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
});

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
  aliasGeneration: number;
  projectedAliasGeneration: number;
  ingestedAt: string | null;
  acknowledgedAt: string | null;
  activity: AcquisitionCrawlerActivity;
  activityObserved: boolean;
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
  aliasGeneration: number;
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
  candidateProjectionState: "pending" | "ready" | "failed";
  activity: AcquisitionCrawlerActivity;
}

export type AcquisitionCrawlerOutreachFinalizationState =
  | "pending" | "ready" | "unavailable";

export function crawlerOutreachFinalizationState(
  job: Pick<AcquisitionCrawlerJob,
    "state" | "ingestionState" | "aliasGeneration"
    | "projectedAliasGeneration">
): AcquisitionCrawlerOutreachFinalizationState {
  if (["succeeded", "partial"].includes(job.state)
    && job.ingestionState === "succeeded"
    && job.projectedAliasGeneration === job.aliasGeneration) {
    return "ready";
  }
  if (["paused", "cancelled", "failed"].includes(job.state)
    || job.ingestionState === "failed") {
    return "unavailable";
  }
  return "pending";
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

export function assertAcquisitionCrawlerActivity(
  activity: AcquisitionCrawlerActivity
) {
  const keys = ["phase", "currentKeyword", "browserMode", "sequence"];
  if (!activity || typeof activity !== "object"
    || Object.keys(activity).some((key) => !keys.includes(key))
    || !["queued", "starting_browser", "opening_douyin", "searching",
      "collecting_comments", "finalizing", "completed"].includes(activity.phase)
    || (activity.currentKeyword !== null
      && (typeof activity.currentKeyword !== "string" || !activity.currentKeyword
        || [...activity.currentKeyword].length > 100))
    || !["visible", "headless"].includes(activity.browserMode)
    || !Number.isSafeInteger(activity.sequence) || activity.sequence < 0) {
    throw new TypeError("invalid_crawler_activity");
  }
}

export function assertAcquisitionCrawlerActivityForKeywords(
  activity: AcquisitionCrawlerActivity,
  keywords: readonly string[]
) {
  assertAcquisitionCrawlerActivity(activity);
  if (!Array.isArray(keywords)
    || (activity.currentKeyword !== null
      && !keywords.includes(activity.currentKeyword))) {
    throw new TypeError("invalid_crawler_activity");
  }
}

export function assertCrawlerActivityObserved(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("invalid_crawler_activity_observation");
  }
}

export function assertTerminalCrawlerActivity(
  activity: AcquisitionCrawlerActivity | undefined
): asserts activity is AcquisitionCrawlerActivity {
  if (!activity) throw new TypeError("invalid_crawler_terminal_activity");
  assertAcquisitionCrawlerActivity(activity);
  if (activity.phase !== "completed" || activity.currentKeyword !== null) {
    throw new TypeError("invalid_crawler_terminal_activity");
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
  assertAcquisitionCrawlerActivityForKeywords(job.activity, job.keywords);
  assertCrawlerActivityObserved(job.activityObserved);
  const candidateProjectionState = (() => {
    if (["scheduled", "queued", "running"].includes(job.state)) {
      return "pending" as const;
    }
    if (["paused", "cancelled", "failed"].includes(job.state)) {
      return "ready" as const;
    }
    if (job.ingestionState === "failed") return "failed" as const;
    return job.ingestionState === "succeeded"
      && job.projectedAliasGeneration === job.aliasGeneration
      ? "ready" as const : "pending" as const;
  })();
  return Object.freeze({
    runId, state: job.state, attempt: job.attempt,
    cursorPersisted: job.cursor !== null, recordCount: job.recordCount,
    candidateBudgetUsed: job.candidateBudgetUsed,
    candidateBudgetLimit: job.dailyCandidateLimit,
    lastErrorCode: publicAcquisitionCrawlerErrorCode(job.lastErrorCode),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt, completedAt: job.completedAt,
    candidateProjectionState,
    activity: Object.freeze({
      phase: job.activity.phase,
      currentKeyword: job.activity.currentKeyword,
      browserMode: job.activity.browserMode,
      sequence: job.activity.sequence
    })
  });
}
