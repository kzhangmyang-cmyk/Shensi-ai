import { createHash } from "node:crypto";
import type {
  AcquisitionBudgetUsage,
  DouyinPublicCommentSamplePolicy
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionDouyinCommentEventRepository,
  DouyinCommentFetchAttempt,
  DouyinCommentFetchAttemptTerminalProjection
} from "./acquisition-douyin-comment-events.js";
import type {
  AcquisitionDouyinCommentIngestionInput,
  AcquisitionDouyinCommentIngestionResult
} from "./acquisition-douyin-comment-ingestion.js";
import {
  DouyinPublicCommentProviderError,
  type DouyinPublicCommentProviderErrorCode,
  type DouyinPublicCommentProviderPort,
  resolveDouyinVideoId
} from "./douyin-public-comment-provider.js";

export type AcquisitionDouyinCommentEnrichmentStatus =
  | "skipped"
  | "succeeded"
  | "succeeded_empty"
  | "partial_success"
  | "failed";

export interface AcquisitionDouyinCommentEnrichmentError {
  sourceUrl: string;
  videoId: string;
  code: DouyinPublicCommentProviderErrorCode;
}

export interface AcquisitionDouyinCommentEnrichmentInput {
  scope: AcquisitionDouyinCommentIngestionInput["scope"];
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  sourceUrls: string[];
  candidateIds: string[];
  policy: DouyinPublicCommentSamplePolicy | null | undefined;
  remainingBudget: Pick<AcquisitionBudgetUsage, "requests" | "results">;
  signal: AbortSignal;
}

export interface AcquisitionDouyinCommentEnrichmentResult {
  status: AcquisitionDouyinCommentEnrichmentStatus;
  videoCount: number;
  pagesFetched: number;
  commentsSampled: number;
  eventCount: number;
  evidenceCount: number;
  candidateIds: string[];
  unresolvedActorCount: number;
  strongSignalCount: number;
  invalidCommentCount: number;
  errors: AcquisitionDouyinCommentEnrichmentError[];
  usage: AcquisitionBudgetUsage;
}

export interface AcquisitionDouyinCommentEnrichmentPort {
  enrich(
    input: AcquisitionDouyinCommentEnrichmentInput
  ): Promise<AcquisitionDouyinCommentEnrichmentResult>;
}

export interface AcquisitionDouyinCommentEnrichmentServiceOptions {
  provider: DouyinPublicCommentProviderPort;
  events: AcquisitionDouyinCommentEventRepository;
  ingestion: Pick<
    { ingestSample(
      input: AcquisitionDouyinCommentIngestionInput
    ): Promise<AcquisitionDouyinCommentIngestionResult> },
    "ingestSample"
  >;
  now?: () => string;
  nowMs?: () => number;
}

const EMPTY_USAGE: AcquisitionBudgetUsage = Object.freeze({
  requests: 0,
  results: 0,
  amountMinor: 0,
  durationSeconds: 0
});

function emptyResult(
  status: AcquisitionDouyinCommentEnrichmentStatus = "skipped"
): AcquisitionDouyinCommentEnrichmentResult {
  return {
    status,
    videoCount: 0,
    pagesFetched: 0,
    commentsSampled: 0,
    eventCount: 0,
    evidenceCount: 0,
    candidateIds: [],
    unresolvedActorCount: 0,
    strongSignalCount: 0,
    invalidCommentCount: 0,
    errors: [],
    usage: { ...EMPTY_USAGE }
  };
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validPolicy(value: DouyinPublicCommentSamplePolicy | null | undefined) {
  return Boolean(value)
    && typeof value!.enabled === "boolean"
    && Number.isSafeInteger(value!.maxVideosPerRun)
    && value!.maxVideosPerRun >= 1
    && value!.maxVideosPerRun <= 20
    && Number.isSafeInteger(value!.maxCommentsPerVideo)
    && value!.maxCommentsPerVideo >= 1
    && value!.maxCommentsPerVideo <= 100
    && Number.isSafeInteger(value!.maxPagesPerVideo)
    && value!.maxPagesPerVideo >= 1
    && value!.maxPagesPerVideo <= 5;
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal);
}

function attemptId(input: {
  ownerId: string;
  teamId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  videoId: string;
}) {
  return `douyin-comment-fetch:${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")}`;
}

function providerErrorCode(error: unknown): DouyinPublicCommentProviderErrorCode {
  return error instanceof DouyinPublicCommentProviderError
    ? error.code
    : "public_sample_unavailable";
}

const PROVIDER_ERROR_CODES = new Set<DouyinPublicCommentProviderErrorCode>([
  "public_sample_unavailable",
  "access_restricted",
  "rate_limited",
  "video_id_unresolved",
  "source_payload_invalid",
  "no_public_comments"
]);

function replayProjection(
  attempt: DouyinCommentFetchAttempt
): DouyinCommentFetchAttemptTerminalProjection {
  return attempt.terminalProjection ?? {
    transportRequestCount: attempt.pagesFetched,
    durationSeconds: 0,
    eventCount: 0,
    evidenceCount: 0,
    candidateIds: [],
    unresolvedActorCount: 0,
    strongSignalCount: 0,
    invalidCommentCount: 0
  };
}

function uniqueVideoSources(sourceUrls: string[], limit: number) {
  const seen = new Set<string>();
  const sources: Array<{ sourceUrl: string; videoId: string }> = [];
  for (const sourceUrl of sourceUrls) {
    const videoId = resolveDouyinVideoId(sourceUrl);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    sources.push({ sourceUrl, videoId });
    if (sources.length >= limit) break;
  }
  return sources;
}

export class AcquisitionDouyinCommentEnrichmentService
implements AcquisitionDouyinCommentEnrichmentPort {
  private readonly provider: DouyinPublicCommentProviderPort;
  private readonly events: AcquisitionDouyinCommentEventRepository;
  private readonly ingestion:
    AcquisitionDouyinCommentEnrichmentServiceOptions["ingestion"];
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(options: AcquisitionDouyinCommentEnrichmentServiceOptions) {
    if (options.provider.providerId !== "experimental_public_sample") {
      throw new TypeError("Invalid Douyin public comment provider");
    }
    this.provider = options.provider;
    this.events = options.events;
    this.ingestion = options.ingestion;
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async enrich(
    input: AcquisitionDouyinCommentEnrichmentInput
  ): Promise<AcquisitionDouyinCommentEnrichmentResult> {
    if (!validPolicy(input.policy)
      || !input.policy?.enabled) {
      return emptyResult();
    }
    if (!Array.isArray(input.sourceUrls)
      || !Array.isArray(input.candidateIds)
      || !nonNegativeInteger(input.remainingBudget?.requests)
      || !nonNegativeInteger(input.remainingBudget?.results)) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_ENRICHMENT_INVALID_INPUT");
    }
    assertNotAborted(input.signal);
    const sources = uniqueVideoSources(
      input.sourceUrls,
      input.policy.maxVideosPerRun
    );
    if (sources.length === 0
      || input.remainingBudget.requests === 0
      || input.remainingBudget.results === 0) {
      return emptyResult();
    }

    const existingCandidateIds = new Set(input.candidateIds);
    const newCandidateIds = new Set<string>();
    const errors: AcquisitionDouyinCommentEnrichmentError[] = [];
    let requests = 0;
    let commentsSampled = 0;
    let pagesFetched = 0;
    let videoCount = 0;
    let eventCount = 0;
    let evidenceCount = 0;
    let unresolvedActorCount = 0;
    let strongSignalCount = 0;
    let invalidCommentCount = 0;
    let durationSeconds = 0;

    for (const source of sources) {
      assertNotAborted(input.signal);
      if (requests >= input.remainingBudget.requests
        || commentsSampled >= input.remainingBudget.results) break;
      videoCount += 1;
      const requestedCount = Math.min(
        input.policy.maxCommentsPerVideo,
        input.remainingBudget.results - commentsSampled
      );
      const fetchAttemptId = attemptId({
        ownerId: input.scope.ownerId,
        teamId: input.scope.teamId,
        runId: input.runId,
        shardId: input.shardId,
        discoveryOperationId: input.discoveryOperationId,
        videoId: source.videoId
      });
      const startedAttempt = await this.events.startFetchAttempt({
        scope: input.scope,
        attemptId: fetchAttemptId,
        runId: input.runId,
        shardId: input.shardId,
        discoveryOperationId: input.discoveryOperationId,
        sourceUrl: source.sourceUrl,
        videoId: source.videoId,
        requestedCount,
        startedAt: this.now()
      });
      if (startedAttempt.attempt.status !== "running") {
        const terminal = startedAttempt.attempt;
        const projection = replayProjection(terminal);
        if (requests + projection.transportRequestCount
          > input.remainingBudget.requests
          || commentsSampled + terminal.returnedCount
          > input.remainingBudget.results) {
          throw new Error(
            "ACQUISITION_DOUYIN_COMMENT_ENRICHMENT_REPLAY_BUDGET_CONFLICT"
          );
        }
        requests += projection.transportRequestCount;
        durationSeconds += projection.durationSeconds;
        pagesFetched += terminal.pagesFetched;
        commentsSampled += terminal.returnedCount;
        eventCount += projection.eventCount;
        evidenceCount += projection.evidenceCount;
        unresolvedActorCount += projection.unresolvedActorCount;
        strongSignalCount += projection.strongSignalCount;
        invalidCommentCount += projection.invalidCommentCount;
        for (const candidateId of projection.candidateIds) {
          if (!existingCandidateIds.has(candidateId)) {
            newCandidateIds.add(candidateId);
          }
        }
        if (terminal.errorCode) {
          if (!PROVIDER_ERROR_CODES.has(
            terminal.errorCode as DouyinPublicCommentProviderErrorCode
          )) {
            throw new Error(
              "ACQUISITION_DOUYIN_COMMENT_ENRICHMENT_TERMINAL_FAILURE"
            );
          }
          errors.push({
            ...source,
            code: terminal.errorCode as DouyinPublicCommentProviderErrorCode
          });
        }
        continue;
      }
      const videoStartedAtMs = this.nowMs();
      const videoRequestStart = requests;
      let cursor = 0;
      let videoPages = 0;
      let videoComments = 0;
      let reportedCommentCount: number | null = null;
      let videoError: DouyinPublicCommentProviderErrorCode | null = null;
      let providerCallRequestBaseline = requests;
      let videoEventCount = 0;
      let videoEvidenceCount = 0;
      let videoUnresolvedActorCount = 0;
      let videoStrongSignalCount = 0;
      let videoInvalidCommentCount = 0;
      const videoCandidateIds = new Set<string>();
      const terminalProjection = () => ({
        transportRequestCount: requests - videoRequestStart,
        durationSeconds: Math.max(
          0,
          Math.ceil((this.nowMs() - videoStartedAtMs) / 1_000)
        ),
        eventCount: videoEventCount,
        evidenceCount: videoEvidenceCount,
        candidateIds: [...videoCandidateIds],
        unresolvedActorCount: videoUnresolvedActorCount,
        strongSignalCount: videoStrongSignalCount,
        invalidCommentCount: videoInvalidCommentCount
      });
      const seenCommentIds = new Set<string>();
      const visitedCursors = new Set<number>([0]);
      try {
        while (videoPages < input.policy.maxPagesPerVideo
          && videoComments < input.policy.maxCommentsPerVideo
          && requests < input.remainingBudget.requests
          && commentsSampled < input.remainingBudget.results) {
          assertNotAborted(input.signal);
          const count = Math.min(
            input.policy.maxCommentsPerVideo - videoComments,
            input.remainingBudget.results - commentsSampled,
            100
          );
          providerCallRequestBaseline = requests;
          const page = await this.provider.fetchTopLevelSample({
            videoId: source.videoId,
            sourceUrl: source.sourceUrl,
            cursor,
            count,
            transportRequestBudget:
              input.remainingBudget.requests - requests,
            signal: input.signal
          });
          const transportRequestCount =
            page.metadata.transportRequestCount ?? 1;
          if (!Number.isSafeInteger(transportRequestCount)
            || transportRequestCount < 1
            || transportRequestCount
              > input.remainingBudget.requests - requests) {
            throw new DouyinPublicCommentProviderError(
              "source_payload_invalid",
              Math.max(0, Number(transportRequestCount) || 0)
            );
          }
          requests += transportRequestCount;
          assertNotAborted(input.signal);
          if (page.comments.length > count) {
            throw new DouyinPublicCommentProviderError(
              "source_payload_invalid"
            );
          }
          const deduplicatedComments = page.comments.filter((comment) => {
            if (seenCommentIds.has(comment.commentId)) return false;
            seenCommentIds.add(comment.commentId);
            return true;
          });
          const duplicateCommentCount = page.comments.length
            - deduplicatedComments.length;
          const authoritativePage = {
            ...page,
            comments: deduplicatedComments,
            capturedAt: startedAttempt.attempt.startedAt,
            metadata: {
              ...page.metadata,
              returnedCommentCount: deduplicatedComments.length,
              duplicateCommentCount:
                page.metadata.duplicateCommentCount + duplicateCommentCount
            }
          };
          const ingested = await this.ingestion.ingestSample({
            scope: input.scope,
            runId: input.runId,
            shardId: input.shardId,
            discoveryOperationId: input.discoveryOperationId,
            sourceUrl: source.sourceUrl,
            videoId: source.videoId,
            page: authoritativePage
          });
          const sampledCount = deduplicatedComments.length;
          videoPages += 1;
          pagesFetched += 1;
          videoComments += sampledCount;
          commentsSampled += sampledCount;
          eventCount += ingested.eventCount;
          evidenceCount += ingested.evidenceCount;
          unresolvedActorCount += ingested.unresolvedActorCount;
          strongSignalCount += ingested.strongSignalCount;
          invalidCommentCount += ingested.invalidCommentCount;
          videoEventCount += ingested.eventCount;
          videoEvidenceCount += ingested.evidenceCount;
          videoUnresolvedActorCount += ingested.unresolvedActorCount;
          videoStrongSignalCount += ingested.strongSignalCount;
          videoInvalidCommentCount += ingested.invalidCommentCount;
          reportedCommentCount = page.reportedCommentCount;
          for (const candidateId of ingested.candidateIds) {
            if (!existingCandidateIds.has(candidateId)) {
              newCandidateIds.add(candidateId);
              videoCandidateIds.add(candidateId);
            }
          }
          if (!page.hasMore || page.nextCursor === null
            || visitedCursors.has(page.nextCursor)) break;
          visitedCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      } catch (error) {
        if (input.signal.aborted) {
          await this.events.finishFetchAttempt(
            input.scope,
            fetchAttemptId,
            {
              status: videoComments > 0 ? "partial_success" : "failed",
              errorCode: "ABORTED",
              returnedCount: videoComments,
              reportedCommentCount,
              pagesFetched: videoPages,
              terminalProjection: terminalProjection(),
              completedAt: this.now()
            }
          );
          throw abortReason(input.signal);
        }
        if (!(error instanceof DouyinPublicCommentProviderError)) {
          await this.events.finishFetchAttempt(
            input.scope,
            fetchAttemptId,
            {
              status: "failed",
              errorCode: "ENRICHMENT_PIPELINE_FAILED",
              returnedCount: videoComments,
              reportedCommentCount,
              pagesFetched: videoPages,
              terminalProjection: terminalProjection(),
              completedAt: this.now()
            }
          );
          throw error;
        }
        const consumedRequests = error.transportRequestCount > 0
          ? error.transportRequestCount
          : requests === providerCallRequestBaseline ? 1 : 0;
        requests += Math.min(
          consumedRequests,
          input.remainingBudget.requests - requests
        );
        videoError = providerErrorCode(error);
        errors.push({ ...source, code: videoError });
      }
      const noPublicComments = videoError === "no_public_comments";
      const projection = terminalProjection();
      await this.events.finishFetchAttempt(input.scope, fetchAttemptId, {
        status: videoError
          ? noPublicComments
            ? "no_public_comments"
            : videoComments > 0 ? "partial_success" : "failed"
          : "succeeded",
        errorCode: videoError,
        returnedCount: videoComments,
        reportedCommentCount,
        pagesFetched: videoPages,
        terminalProjection: projection,
        completedAt: this.now()
      });
      durationSeconds += projection.durationSeconds;
    }

    const hardErrors = errors.filter((error) =>
      error.code !== "no_public_comments");
    const status: AcquisitionDouyinCommentEnrichmentStatus =
      hardErrors.length > 0
        ? commentsSampled > 0 ? "partial_success" : "failed"
        : commentsSampled > 0 ? "succeeded" : "succeeded_empty";
    return {
      status,
      videoCount,
      pagesFetched,
      commentsSampled,
      eventCount,
      evidenceCount,
      candidateIds: [...newCandidateIds],
      unresolvedActorCount,
      strongSignalCount,
      invalidCommentCount,
      errors,
      usage: {
        requests,
        results: commentsSampled,
        amountMinor: 0,
        durationSeconds
      }
    };
  }
}
