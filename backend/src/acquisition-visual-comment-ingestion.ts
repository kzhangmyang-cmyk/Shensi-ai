import { createHash } from "node:crypto";
import type { AcquisitionDomainService } from "./acquisition-domain-service.js";
import {
  AcquisitionDouyinCommentIngestionService,
  classifyDouyinCommentIntent
} from "./acquisition-douyin-comment-ingestion.js";
import {
  DOUYIN_PUBLIC_COMMENT_COVERAGE,
  DOUYIN_PUBLIC_COMMENT_PROVIDER_ID,
  DOUYIN_PUBLIC_COMMENT_PROVIDER_VERSION
} from "./douyin-public-comment-provider.js";
import type {
  AcquisitionDouyinCommentIngestionUnitOfWork
} from "./acquisition-douyin-comment-ingestion-unit-of-work.js";
import type {
  AcquisitionIndividualSignalIngestionPort
} from "./acquisition-individual-signal-ingestion.js";
import type {
  AcquisitionVisualReaderRepository,
  DouyinVisualCommentObservationV1,
  VisualIngestionWorkItemClaim
} from "./acquisition-visual-reader-sessions.js";
import {
  isVerifiedAcquisitionPublicProfileUrl
} from "./acquisition-public-identity-resolver.js";

export interface AcquisitionVisualIngestionRecoveryDiagnostic {
  code: "RECOVERY_FAILED";
  stage: "resume_work" | "persist_failure";
  workItemHash: string;
  attempt: number;
}

export interface AcquisitionVisualCommentIngestionServiceOptions {
  visualRepository: AcquisitionVisualReaderRepository;
  domain: AcquisitionDomainService;
  individualSignals: AcquisitionIndividualSignalIngestionPort;
  publicCommentIngestion?: Pick<
    AcquisitionDouyinCommentIngestionService,
    "ingestSample"
  >;
  unitOfWork: AcquisitionDouyinCommentIngestionUnitOfWork;
  workerId?: string;
  leaseDurationMs?: number;
  now?: () => string;
  onRecoveryError?: (
    diagnostic: AcquisitionVisualIngestionRecoveryDiagnostic
  ) => void;
  failureInjector?: (
    stage: "after_evidence" | "after_candidate"
  ) => Promise<void>;
}

function canonicalInstant(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("VISUAL_INGESTION_CLOCK_INVALID");
  return new Date(time).toISOString();
}

function verifiedIdentity(observation: DouyinVisualCommentObservationV1) {
  if (!observation.secUid || !observation.publicProfileUrl) return false;
  try {
    const profile = new URL(observation.publicProfileUrl);
    return isVerifiedAcquisitionPublicProfileUrl(profile)
      && profile.pathname.replace(/\/+$/u, "")
        === `/user/${observation.secUid}`
      && observation.fieldConfidences.secUid !== undefined
      && observation.fieldConfidences.secUid >= 0.85
      && observation.fieldConfidences.publicProfileUrl !== undefined
      && observation.fieldConfidences.publicProfileUrl >= 0.85;
  } catch {
    return false;
  }
}

const PROMOTION_CONFIDENCE_FIELDS = [
  "displayName",
  "visibleTimeText",
  "likeCount",
  "replyCount",
  "platformCommentId",
  "publicProfileUrl",
  "secUid"
] as const;

function promotablePublicComment(
  observation: DouyinVisualCommentObservationV1
) {
  const publishedAt = visiblePublishedAt(observation);
  const sourceVideoId = /^https:\/\/www\.douyin\.com\/video\/(\d{1,32})\/?$/u
    .exec(observation.sourceUrl)?.[1] ?? null;
  return verifiedIdentity(observation)
    && typeof observation.displayName === "string"
    && observation.displayName.trim().length > 0
    && observation.displayName.length <= 200
    && sourceVideoId === observation.videoId
    && observation.platformCommentId !== null
    && /^[0-9]{1,32}$/u.test(observation.platformCommentId)
    && publishedAt !== null
    && observation.visibleTimeText === publishedAt
    && Number.isSafeInteger(observation.likeCount)
    && Number(observation.likeCount) >= 0
    && Number.isSafeInteger(observation.replyCount)
    && Number(observation.replyCount) >= 0
    && PROMOTION_CONFIDENCE_FIELDS.every((field) => {
      const confidence = observation.fieldConfidences[field];
      return confidence !== undefined && confidence >= 0.85;
    });
}

function visiblePublishedAt(observation: DouyinVisualCommentObservationV1) {
  if (!observation.visibleTimeText) return null;
  const time = Date.parse(observation.visibleTimeText);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function evidenceId(observation: DouyinVisualCommentObservationV1) {
  return `visual:${observation.observationId}:evidence:${observation.textHash}`;
}

export class AcquisitionVisualCommentIngestionService {
  private readonly visualRepository: AcquisitionVisualReaderRepository;
  private readonly domain: AcquisitionDomainService;
  private readonly individualSignals: AcquisitionIndividualSignalIngestionPort;
  private readonly publicCommentIngestion?: Pick<
    AcquisitionDouyinCommentIngestionService,
    "ingestSample"
  >;
  private readonly unitOfWork: AcquisitionDouyinCommentIngestionUnitOfWork;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => string;
  private readonly onRecoveryError: (
    diagnostic: AcquisitionVisualIngestionRecoveryDiagnostic
  ) => void;
  private readonly failureInjector?: (
    stage: "after_evidence" | "after_candidate"
  ) => Promise<void>;

  constructor(options: AcquisitionVisualCommentIngestionServiceOptions) {
    this.visualRepository = options.visualRepository;
    this.domain = options.domain;
    this.individualSignals = options.individualSignals;
    this.publicCommentIngestion = options.publicCommentIngestion;
    this.unitOfWork = options.unitOfWork;
    this.workerId = options.workerId ?? "visual-ingestion-recovery-worker";
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRecoveryError = options.onRecoveryError ?? (() => undefined);
    this.failureInjector = options.failureInjector;
  }

  async recoverPendingVisualIngestionWorkItems(options: { limit: number }) {
    const now = canonicalInstant(this.now());
    const claimed = await this.visualRepository.claimPendingIngestionWorkItems({
      workerId: this.workerId,
      now,
      leaseDurationMs: this.leaseDurationMs,
      limit: options.limit
    });
    for (const work of claimed) {
      try {
        await this.unitOfWork.transaction(() => this.resume(work));
      } catch {
        const failedAt = canonicalInstant(this.now());
        const delayMs = Math.min(
          5 * 60_000,
          1_000 * (2 ** Math.min(8, Math.max(0,
            work.workItem.attemptCount - 1)))
        );
        this.report("resume_work", work);
        try {
          await this.visualRepository.failIngestionWorkItem({
            ownerId: work.workItem.ownerId,
            teamId: work.workItem.teamId
          }, work.workItem.observationId, {
            workerId: this.workerId,
            leaseToken: work.workItem.leaseToken!,
            attemptCount: work.workItem.attemptCount,
            failedAt,
            nextAttemptAt: new Date(
              Date.parse(failedAt) + delayMs
            ).toISOString(),
            errorCode: "RECOVERY_FAILED"
          });
        } catch {
          this.report("persist_failure", work);
        }
      }
    }
    return claimed.length;
  }

  private async resume(work: VisualIngestionWorkItemClaim) {
    const { workItem, observation } = work;
    const scope = {
      ownerId: workItem.ownerId,
      teamId: workItem.teamId,
      actorId: workItem.actorId
    };
    const visualScope = {
      ownerId: workItem.ownerId,
      teamId: workItem.teamId
    };
    const artifact = workItem.artifactId
      ? await this.visualRepository.getArtifact(visualScope, workItem.artifactId)
      : null;
    if (observation.extractionMethod === "vision") {
      throw new Error("VISUAL_INGESTION_VISION_REJECTED");
    }
    const literalEvidenceId = evidenceId(observation);
    const evidence = await this.domain.appendAuthorizedVisualEvidence(scope, {
      targetType: "individual_signal",
      sourcePlatform: "douyin",
      sourceTitle: "Authorized visible comment observation",
      sourceSnippet: observation.visibleText,
      publishedAt: visiblePublishedAt(observation),
      locale: "zh-CN",
      rawArtifactHash: artifact?.plaintextHash
        ?? observation.redactedCropHash
        ?? observation.textHash,
      contentHash: observation.textHash,
      provenance: {
        kind: "authorized_visual_observation",
        sourceUrl: observation.sourceUrl,
        observationId: observation.observationId,
        sessionId: observation.sessionId,
        extractionMethod: observation.extractionMethod,
        visibleTextConfidence: observation.fieldConfidences.visibleText,
        coverage: "authorized_visible_top_level_sample",
        artifactId: workItem.artifactId,
        domTextHash: observation.domTextHash,
        ocrTextHash: observation.ocrTextHash
      },
      accessStatus: "access_restricted"
    }, literalEvidenceId, `visual-evidence:${observation.observationId}`);
    await this.failureInjector?.("after_evidence");

    if (workItem.disposition === "manual_review_only") {
      await this.visualRepository.completeIngestionWorkItem(
        visualScope,
        observation.observationId,
        {
          workerId: this.workerId,
          leaseToken: workItem.leaseToken!,
          attemptCount: workItem.attemptCount,
          status: "manual_review_only",
          evidenceId: evidence.id,
          platformEvidenceId: null,
          candidateId: null,
          completedAt: canonicalInstant(this.now())
        }
      );
      return;
    }

    const decision = classifyDouyinCommentIntent(observation.visibleText);
    let candidateId: string | null = null;
    let platformEvidenceId: string | null = null;
    if (this.publicCommentIngestion && promotablePublicComment(observation)) {
      let committed: {
        platformEventId: string;
        evidenceId: string;
        candidateId: string | null;
      } | null = null;
      await this.publicCommentIngestion.ingestSample({
        scope,
        runId: workItem.runId,
        shardId: null,
        discoveryOperationId: null,
        sourceUrl: observation.sourceUrl,
        videoId: observation.videoId,
        page: {
          comments: [{
            commentId: observation.platformCommentId!,
            text: observation.visibleText,
            occurredAt: visiblePublishedAt(observation),
            likeCount: observation.likeCount!,
            replyCount: observation.replyCount!,
            ipLabel: null,
            actor: {
              displayName: observation.displayName,
              handle: null,
              secUid: observation.secUid
            }
          }],
          nextCursor: null,
          hasMore: false,
          reportedCommentCount: 1,
          capturedAt: observation.capturedAt,
          rawArtifactHash: artifact?.plaintextHash
            ?? observation.redactedCropHash
            ?? observation.textHash,
          providerId: DOUYIN_PUBLIC_COMMENT_PROVIDER_ID,
          providerVersion: DOUYIN_PUBLIC_COMMENT_PROVIDER_VERSION,
          coverage: DOUYIN_PUBLIC_COMMENT_COVERAGE,
          metadata: {
            requestedCommentCount: 1,
            returnedCommentCount: 1,
            duplicateCommentCount: 0,
            partial: false,
            cursorProgressed: false
          },
          replyBodiesIncluded: false
        }
      }, {
        onCommitted: (fact) => {
          committed = fact;
        }
      });
      const promotionFact = committed as {
        platformEventId: string;
        evidenceId: string;
        candidateId: string | null;
      } | null;
      if (!promotionFact
        || promotionFact.platformEventId !== observation.platformCommentId) {
        throw new Error("VISUAL_PUBLIC_PROMOTION_FACT_MISSING");
      }
      candidateId = promotionFact.candidateId;
      platformEvidenceId = promotionFact.evidenceId;
      if (candidateId) {
        await this.domain.attachEvidenceToCandidate(
          scope,
          candidateId,
          evidence.id,
          `visual-promotion-attach:${observation.observationId}`
        );
      }
      await this.failureInjector?.("after_candidate");
    } else if (decision.band !== "noise") {
      const identityVerified = verifiedIdentity(observation);
      const sourceUrl = identityVerified
        ? observation.publicProfileUrl!
        : observation.sourceUrl;
      const ingested = await this.individualSignals.ingest({
        scope,
        provider: "experimental_public_sample",
        sourceUrl,
        sourceType: identityVerified ? "profile" : "video",
        subject: {
          publicActorKey: identityVerified
            ? `douyin:sec_uid:${observation.secUid}`
            : `unmergeable:douyin:visual:${observation.observationId}`,
          publicDisplayName: observation.displayName
            ?? "抖音可见用户（身份待核验）",
          publicProfileUrl: sourceUrl,
          sourcePlatform: "douyin",
          demandCategory: "抖音授权可见评论需求信号",
          demandSummary: observation.visibleText.slice(0, 2_000),
          locationHint: "",
          buyingStage: decision.buyingStage,
          negativeSignals: decision.negativeSignals
        },
        evidence,
        idempotencyKey: `visual-signal:${observation.observationId}`,
        ...(decision.band === "negative"
          ? { initialCandidateStatus: "do_not_contact" as const }
          : !identityVerified
            ? { initialCandidateStatus: "needs_research" as const }
            : {})
      });
      candidateId = ingested.candidate.id;
      await this.failureInjector?.("after_candidate");
    }

    await this.visualRepository.completeIngestionWorkItem(
      visualScope,
      observation.observationId,
      {
        workerId: this.workerId,
        leaseToken: workItem.leaseToken!,
        attemptCount: workItem.attemptCount,
        status: "succeeded",
        evidenceId: evidence.id,
        platformEvidenceId,
        candidateId,
        completedAt: canonicalInstant(this.now())
      }
    );
  }

  private report(
    stage: AcquisitionVisualIngestionRecoveryDiagnostic["stage"],
    work: VisualIngestionWorkItemClaim
  ) {
    try {
      this.onRecoveryError(Object.freeze({
        code: "RECOVERY_FAILED",
        stage,
        workItemHash: `sha256:${createHash("sha256")
          .update(work.workItem.workItemId).digest("hex")}`,
        attempt: work.workItem.attemptCount
      }));
    } catch {
      // Diagnostics cannot affect recovery state.
    }
  }
}
