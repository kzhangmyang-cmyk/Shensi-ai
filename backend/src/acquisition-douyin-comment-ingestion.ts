import { createHash } from "node:crypto";
import type { BuyingStage } from "./acquisition-domain.js";
import type {
  AcquisitionActorScope,
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import type {
  AcquisitionDouyinCommentEventRepository,
  DouyinCommentEvent,
  DouyinCommentIngestionSagaWorkItem
} from "./acquisition-douyin-comment-events.js";
import type {
  AcquisitionIndividualSignalIngestionPort
} from "./acquisition-individual-signal-ingestion.js";
import type {
  AcquisitionDouyinCommentIngestionUnitOfWork
} from "./acquisition-douyin-comment-ingestion-unit-of-work.js";
import {
  isSafeAcquisitionPublicActorKey
} from "./acquisition-public-identity-resolver.js";
import {
  DOUYIN_PUBLIC_COMMENT_COVERAGE,
  DOUYIN_PUBLIC_COMMENT_PROVIDER_ID,
  DOUYIN_PUBLIC_COMMENT_PROVIDER_VERSION,
  type DouyinPublicComment,
  type DouyinPublicCommentSamplePage,
  resolveDouyinVideoId
} from "./douyin-public-comment-provider.js";

export type DouyinCommentIntentBand =
  | "strong_signal"
  | "potential_signal"
  | "noise"
  | "negative";

export interface DouyinCommentIntentDecision {
  band: DouyinCommentIntentBand;
  positiveSignals: string[];
  negativeSignals: string[];
  reasons: string[];
  buyingStage: BuyingStage;
  confidence: number;
}

export interface AcquisitionDouyinCommentIngestionInput {
  scope: AcquisitionActorScope;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  sourceUrl: string;
  videoId: string;
  page: DouyinPublicCommentSamplePage;
}

export interface AcquisitionDouyinCommentIngestionResult {
  eventCount: number;
  evidenceCount: number;
  candidateIds: string[];
  unresolvedActorCount: number;
  strongSignalCount: number;
  invalidCommentCount: number;
}

interface AcquisitionDouyinCommentCommittedFact {
  platformEventId: string;
  evidenceId: string;
  candidateId: string | null;
  band: DouyinCommentIntentBand;
}

export interface AcquisitionDouyinCommentRecoveryDiagnostic {
  code: "RECOVERY_FAILED";
  stage: "resume_saga" | "persist_failure";
  sagaHash: string;
  attempt: number;
}

export interface AcquisitionDouyinCommentIngestionServiceOptions {
  events: AcquisitionDouyinCommentEventRepository;
  domain: AcquisitionDomainService;
  individualSignals: AcquisitionIndividualSignalIngestionPort;
  unitOfWork: AcquisitionDouyinCommentIngestionUnitOfWork;
  recoveryWorkerId?: string;
  recoveryLeaseDurationMs?: number;
  now?: () => string;
  onRecoveryError?: (
    diagnostic: AcquisitionDouyinCommentRecoveryDiagnostic
  ) => void;
  failureInjector?: (
    stage: "after_event" | "after_evidence" | "after_candidate"
  ) => Promise<void>;
}

const MAX_DECISION_CODES = 12;

const POSITIVE_RULES = [
  ["price_inquiry", /(?:多少钱|报价|询价|价格|费用)/u],
  ["consultation", /(?:咨询|了解一下|怎么做|怎么联系)/u],
  ["budget", /(?:预算|\d+(?:\.\d+)?\s*(?:万|元|块))/u],
  ["quantity", /\d+\s*(?:套|个|件|台|批|箱|份|家|人)/u],
  ["procurement", /(?:采购|求购|招标)/u],
  ["supplier_sourcing", /(?:供应商|供货|厂家)/u],
  ["franchise", /加盟/u],
  ["cooperation", /合作/u],
  ["trial", /(?:试用|体验)/u],
  ["delivery", /(?:交付|交期|周期多久)/u],
  ["timeline", /(?:急|尽快|马上|本周|这周|下周|上线|月底|\d+天)/u],
  ["business_pain", /(?:获客难|成本太高|成本高|效率低|痛点|缺少|很难)/u],
  ["solution_search", /(?:解决方案|找方案|寻找方案)/u]
] as const;

const NEGATIVE_RULES = [
  ["explicit_rejection", /(?:不需要|不感兴趣|不用了|拒绝|别推销)/u],
  ["no_contact", /(?:请勿联系|勿扰|不要联系|别联系|请勿电话)/u],
  ["anti_marketing", /(?:不接受营销|拒绝推销|反营销)/u]
] as const;

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function uniqueBounded(values: string[]) {
  return [...new Set(values)].slice(0, MAX_DECISION_CODES);
}

function matchingCodes(
  text: string,
  rules: ReadonlyArray<readonly [string, RegExp]>
) {
  return uniqueBounded(rules.flatMap(([code, pattern]) =>
    pattern.test(text) ? [code] : []));
}

function noiseReason(text: string) {
  if (!/[\p{L}\p{N}]/u.test(text)) return "no_business_meaning";
  if (/(?:抽奖|点赞|关注|互关|扣[1一]|评论区见)/u.test(text)) {
    return "engagement_bait";
  }
  if (/(\S{1,4})\1{3,}/u.test(text)) return "copy_spam";
  return null;
}

function has(signals: string[], code: string) {
  return signals.includes(code);
}

function buyingStageFor(signals: string[], strong: boolean): BuyingStage {
  if (strong && (
    has(signals, "procurement")
    || has(signals, "supplier_sourcing")
    || has(signals, "delivery")
    || has(signals, "timeline")
    || (has(signals, "budget") && has(signals, "quantity"))
  )) return "purchase_ready";
  if (has(signals, "price_inquiry")
    || has(signals, "franchise")
    || has(signals, "cooperation")
    || has(signals, "trial")) return "comparison";
  if (has(signals, "solution_search") || has(signals, "consultation")) {
    return "solution_research";
  }
  if (has(signals, "business_pain")) return "problem_defined";
  return "awareness";
}

function isStrong(signals: string[]) {
  const procurementContext = has(signals, "procurement") && [
    "supplier_sourcing", "budget", "quantity", "timeline", "price_inquiry"
  ].some((code) => has(signals, code));
  const supplierContext = has(signals, "supplier_sourcing") && [
    "procurement", "budget", "quantity", "timeline"
  ].some((code) => has(signals, code));
  const priceContext = has(signals, "price_inquiry") && [
    "budget", "quantity", "procurement", "supplier_sourcing", "timeline"
  ].some((code) => has(signals, code));
  const commercialExperimentCount = ["franchise", "cooperation", "trial"]
    .filter((code) => has(signals, code)).length;
  return procurementContext
    || supplierContext
    || priceContext
    || (has(signals, "budget") && has(signals, "quantity"))
    || commercialExperimentCount >= 2
    || (has(signals, "delivery") && has(signals, "timeline"));
}

export function classifyDouyinCommentIntent(
  rawText: string
): DouyinCommentIntentDecision {
  const text = normalizedText(String(rawText ?? ""));
  const negativeSignals = matchingCodes(text, NEGATIVE_RULES);
  if (negativeSignals.length > 0) {
    return {
      band: "negative",
      positiveSignals: matchingCodes(text, POSITIVE_RULES),
      negativeSignals,
      reasons: negativeSignals.map((code) => `negative:${code}`),
      buyingStage: "awareness",
      confidence: 0.98
    };
  }

  const noise = noiseReason(text);
  if (!text || noise) {
    return {
      band: "noise",
      positiveSignals: [],
      negativeSignals: [],
      reasons: [`noise:${noise || "empty"}`],
      buyingStage: "awareness",
      confidence: 0.99
    };
  }

  const positiveSignals = matchingCodes(text, POSITIVE_RULES);
  if (positiveSignals.length === 0) {
    return {
      band: "noise",
      positiveSignals: [],
      negativeSignals: [],
      reasons: ["noise:no_business_meaning"],
      buyingStage: "awareness",
      confidence: 0.85
    };
  }
  const strong = isStrong(positiveSignals);
  const band = strong ? "strong_signal" : "potential_signal";
  return {
    band,
    positiveSignals,
    negativeSignals: [],
    reasons: uniqueBounded(positiveSignals.map((code) =>
      `${strong ? "strong" : "potential"}:${code}`)),
    buyingStage: buyingStageFor(positiveSignals, strong),
    confidence: strong
      ? Math.min(0.95, 0.78 + positiveSignals.length * 0.03)
      : Math.min(0.76, 0.55 + positiveSignals.length * 0.04)
  };
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deterministicId(prefix: string, material: unknown) {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")}`;
}

function validInstant(value: unknown) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function canonicalInstant(value: string) {
  return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function normalizedOptional(value: unknown, maximum: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = normalizedText(value);
  return normalized && normalized.length <= maximum ? normalized : null;
}

type ValidComment = {
  commentId: string;
  text: string;
  occurredAt: string;
  publishedAt: string | null;
  likeCount: number;
  replyCount: number;
  ipLabel: string | null;
  actor: {
    displayName: string;
    handle: string | null;
    secUid: string | null;
  };
};

function validComment(value: unknown, capturedAt: string): ValidComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const comment = value as Partial<DouyinPublicComment>;
  const commentId = typeof comment.commentId === "string"
    ? comment.commentId.normalize("NFKC").trim()
    : "";
  const text = typeof comment.text === "string" ? comment.text : "";
  if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(commentId)
    || !normalizedText(text)
    || text.length > 4_000
    || !nonNegativeInteger(comment.likeCount)
    || !nonNegativeInteger(comment.replyCount)
    || !nullableString(comment.ipLabel)
    || (comment.occurredAt !== null
      && (!boundedNonEmpty(comment.occurredAt, 100)
        || !validInstant(comment.occurredAt)))
    || !comment.actor
    || typeof comment.actor !== "object"
    || Array.isArray(comment.actor)
    || !nullableString(comment.actor.displayName)
    || !nullableString(comment.actor.handle)
    || !nullableString(comment.actor.secUid)
    || (comment.ipLabel !== null
      && normalizedText(comment.ipLabel!).length > 200)
    || (comment.actor.displayName !== null
      && normalizedText(comment.actor.displayName!).length > 200)
    || (comment.actor.handle !== null
      && normalizedText(comment.actor.handle!).length > 64)
    || (comment.actor.secUid !== null
      && normalizedText(comment.actor.secUid!).length > 128)) {
    return null;
  }
  const publishedAt = comment.occurredAt === null
    ? null
    : canonicalInstant(comment.occurredAt!);
  return {
    commentId,
    text,
    occurredAt: publishedAt ?? capturedAt,
    publishedAt,
    likeCount: comment.likeCount!,
    replyCount: comment.replyCount!,
    ipLabel: normalizedOptional(comment.ipLabel, 200),
    actor: {
      displayName: normalizedOptional(comment.actor.displayName, 200)
        ?? "抖音公开用户（身份待核验）",
      handle: normalizedOptional(comment.actor.handle, 64),
      secUid: normalizedOptional(comment.actor.secUid, 128)
    }
  };
}

function actorKey(comment: ValidComment) {
  const secUid = comment.actor.secUid
    ? `douyin:sec_uid:${comment.actor.secUid}`
    : null;
  if (secUid && isSafeAcquisitionPublicActorKey(secUid)) return secUid;
  const handle = comment.actor.handle
    ? `douyin:handle:${comment.actor.handle.toLocaleLowerCase("en-US")}`
    : null;
  if (handle && isSafeAcquisitionPublicActorKey(handle)) return handle;
  return `unmergeable:douyin:comment:${comment.commentId}`;
}

function boundedNonEmpty(value: unknown, maximum: number) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum;
}

function nullableBoundedNonEmpty(value: unknown, maximum: number) {
  return value === null || boundedNonEmpty(value, maximum);
}

function prepareSample(input: AcquisitionDouyinCommentIngestionInput) {
  const page = input?.page;
  const metadata = page?.metadata;
  const validSource = boundedNonEmpty(input?.sourceUrl, 4_000)
    && resolveDouyinVideoId(input.sourceUrl) === input.videoId;
  if (!boundedNonEmpty(input?.scope?.ownerId, 100)
    || !boundedNonEmpty(input?.scope?.teamId, 100)
    || !boundedNonEmpty(input?.scope?.actorId, 100)
    || !nullableBoundedNonEmpty(input?.runId, 160)
    || !nullableBoundedNonEmpty(input?.shardId, 160)
    || !nullableBoundedNonEmpty(input?.discoveryOperationId, 160)
    || !validSource
    || !/^[0-9]{1,32}$/u.test(input?.videoId || "")
    || page?.providerId !== DOUYIN_PUBLIC_COMMENT_PROVIDER_ID
    || page?.providerVersion !== DOUYIN_PUBLIC_COMMENT_PROVIDER_VERSION
    || page?.coverage !== DOUYIN_PUBLIC_COMMENT_COVERAGE
    || page?.replyBodiesIncluded !== false
    || !boundedNonEmpty(page?.capturedAt, 100)
    || !validInstant(page?.capturedAt)
    || !/^sha256:[a-f0-9]{64}$/u.test(page?.rawArtifactHash || "")
    || !Array.isArray(page?.comments)
    || page.comments.length > 100
    || (page.nextCursor !== null && !nonNegativeInteger(page.nextCursor))
    || typeof page.hasMore !== "boolean"
    || (page.reportedCommentCount !== null
      && !nonNegativeInteger(page.reportedCommentCount))
    || !metadata
    || !Number.isSafeInteger(metadata.requestedCommentCount)
    || metadata.requestedCommentCount < 1
    || metadata.requestedCommentCount > 100
    || metadata.returnedCommentCount !== page.comments.length
    || !nonNegativeInteger(metadata.duplicateCommentCount)
    || typeof metadata.partial !== "boolean"
    || typeof metadata.cursorProgressed !== "boolean") {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_SAMPLE");
  }
  const capturedAt = canonicalInstant(page.capturedAt);
  const comments = (page.comments as unknown[]).map((rawComment) =>
    validComment(rawComment, capturedAt));
  return {
    capturedAt,
    comments,
    invalidCommentCount: comments.filter((comment) => comment === null).length
  };
}

export class AcquisitionDouyinCommentIngestionService {
  private readonly events: AcquisitionDouyinCommentEventRepository;
  private readonly domain: AcquisitionDomainService;
  private readonly individualSignals: AcquisitionIndividualSignalIngestionPort;
  private readonly unitOfWork: AcquisitionDouyinCommentIngestionUnitOfWork;
  private readonly failureInjector?:
    AcquisitionDouyinCommentIngestionServiceOptions["failureInjector"];
  private readonly recoveryWorkerId: string;
  private readonly recoveryLeaseDurationMs: number;
  private readonly now: () => string;
  private readonly onRecoveryError: (
    diagnostic: AcquisitionDouyinCommentRecoveryDiagnostic
  ) => void;

  constructor(options: AcquisitionDouyinCommentIngestionServiceOptions) {
    this.events = options.events;
    this.domain = options.domain;
    this.individualSignals = options.individualSignals;
    this.unitOfWork = options.unitOfWork;
    this.failureInjector = options.failureInjector;
    this.recoveryWorkerId = options.recoveryWorkerId
      ?? "douyin-comment-recovery-worker";
    this.recoveryLeaseDurationMs = options.recoveryLeaseDurationMs ?? 30_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRecoveryError = options.onRecoveryError ?? (() => undefined);
  }

  async ingestSample(
    input: AcquisitionDouyinCommentIngestionInput,
    internal?: {
      onCommitted?: (
        fact: AcquisitionDouyinCommentCommittedFact
      ) => void | Promise<void>;
    }
  ): Promise<AcquisitionDouyinCommentIngestionResult> {
    const prepared = prepareSample(input);
    const capturedAt = prepared.capturedAt;
    const candidateIds: string[] = [];
    const seenCandidateIds = new Set<string>();
    const unresolvedActors = new Set<string>();
    let eventCount = 0;
    let evidenceCount = 0;
    let strongSignalCount = 0;
    const invalidCommentCount = prepared.invalidCommentCount;

    for (const comment of prepared.comments) {
      if (!comment) continue;
      const normalizedContent = normalizedText(comment.text);
      const textHash = sha256(normalizedContent);
      const eventId = deterministicId("douyin-comment-event", [
        input.scope.ownerId,
        input.scope.teamId,
        "douyin",
        comment.commentId
      ]);
      const event: DouyinCommentEvent = {
        eventId,
        platform: "douyin",
        eventType: "comment",
        platformEventId: comment.commentId,
        videoId: input.videoId,
        parentCommentId: null,
        text: comment.text,
        textHash,
        occurredAt: comment.occurredAt,
        capturedAt,
        likeCount: comment.likeCount,
        replyCount: comment.replyCount,
        ipLabel: comment.ipLabel,
        actor: comment.actor,
        sourceUrl: input.sourceUrl,
        coverage: "public_top_level_sample",
        accessStatus: "public_content",
        providerVersion: input.page.providerVersion,
        rawArtifactHash: input.page.rawArtifactHash
      };
      const observationId = deterministicId("douyin-comment-observation", [
        eventId,
        capturedAt,
        textHash,
        comment.likeCount,
        comment.replyCount,
        input.page.providerVersion,
        input.page.rawArtifactHash
      ]);
      const sagaId = deterministicId("douyin-comment-ingestion", [
        input.scope.ownerId,
        input.scope.teamId,
        observationId,
        input.runId,
        input.shardId,
        input.discoveryOperationId
      ]);
      const appended = await this.events.appendObservation({
        scope: input.scope,
        observationId,
        event,
        ingestionSaga: {
          sagaId,
          actorId: input.scope.actorId,
          runId: input.runId,
          shardId: input.shardId,
          discoveryOperationId: input.discoveryOperationId
        }
      });
      eventCount += 1;
      await this.failureInjector?.("after_event");
      if (!appended.ingestionSaga) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_MISSING");
      }
      const resumed = await this.resumeSaga({
        saga: appended.ingestionSaga,
        event: appended.event,
        observation: appended.observation,
        contentVersion: appended.contentVersion
      }, true);
      evidenceCount += 1;
      if (resumed.band === "strong_signal") strongSignalCount += 1;
      if (resumed.candidateId
        && !seenCandidateIds.has(resumed.candidateId)) {
        seenCandidateIds.add(resumed.candidateId);
        candidateIds.push(resumed.candidateId);
      }
      if (resumed.unresolvedDedupeKey) {
        unresolvedActors.add(resumed.unresolvedDedupeKey);
      }
      await internal?.onCommitted?.({
        platformEventId: comment.commentId,
        evidenceId: resumed.evidenceId,
        candidateId: resumed.candidateId,
        band: resumed.band
      });
    }

    return {
      eventCount,
      evidenceCount,
      candidateIds,
      unresolvedActorCount: unresolvedActors.size,
      strongSignalCount,
      invalidCommentCount
    };
  }

  /** Called by the recovery worker after a process restart. */
  async recoverPendingIngestionSagas(options: { limit: number }) {
    const now = canonicalInstant(this.now());
    const workItems = await this.events.claimPendingIngestionSagas({
      workerId: this.recoveryWorkerId,
      now,
      leaseDurationMs: this.recoveryLeaseDurationMs,
      limit: options.limit
    });
    for (const workItem of workItems) {
      try {
        await this.resumeSaga(workItem, false);
      } catch (error) {
        const failedAt = canonicalInstant(this.now());
        const exponent = Math.min(8, Math.max(0,
          workItem.saga.attemptCount - 1));
        const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** exponent));
        this.reportRecoveryError("resume_saga", workItem);
        try {
          await this.events.failIngestionSaga({
            ownerId: workItem.saga.ownerId,
            teamId: workItem.saga.teamId
          }, workItem.saga.sagaId, {
            workerId: this.recoveryWorkerId,
            failedAt,
            nextAttemptAt: new Date(
              new Date(failedAt).getTime() + delayMs
            ).toISOString(),
            errorCode: "RECOVERY_FAILED"
          });
        } catch {
          this.reportRecoveryError("persist_failure", workItem);
        }
      }
    }
    return workItems.length;
  }

  private reportRecoveryError(
    stage: AcquisitionDouyinCommentRecoveryDiagnostic["stage"],
    workItem: DouyinCommentIngestionSagaWorkItem
  ) {
    const diagnostic = Object.freeze({
      code: "RECOVERY_FAILED" as const,
      stage,
      sagaHash: `sha256:${createHash("sha256")
        .update(workItem.saga.sagaId)
        .digest("hex")}`,
      attempt: workItem.saga.attemptCount
    });
    try {
      this.onRecoveryError(diagnostic);
    } catch {
      // Diagnostics must never stop recovery or alter durable saga state.
    }
  }

  private async resumeSaga(
    work: DouyinCommentIngestionSagaWorkItem,
    injectFailures: boolean
  ) {
    return this.unitOfWork.transaction(() =>
      this.resumeSagaWithinUnitOfWork(work, injectFailures));
  }

  private async resumeSagaWithinUnitOfWork(
    work: DouyinCommentIngestionSagaWorkItem,
    injectFailures: boolean
  ) {
    const scope: AcquisitionActorScope = {
      ownerId: work.saga.ownerId,
      teamId: work.saga.teamId,
      actorId: work.saga.actorId
    };
    const authoritativeEvent = work.event;
    const content = work.contentVersion;
    const normalizedContent = normalizedText(content.text);
    const evidenceKey = `comment:${content.eventId}:evidence:${content.textHash}`;
    const evidence = await this.domain.appendEvidence(scope, {
      targetType: "individual_signal",
      sourcePlatform: "douyin",
      sourceTitle:
        `${authoritativeEvent.actor.displayName} 的抖音公开评论`.slice(0, 500),
      sourceSnippet: content.text,
      publishedAt: content.occurredAt,
      locale: "zh-CN",
      rawArtifactHash: content.rawArtifactHash,
      contentHash: content.textHash,
      provenance: {
        kind: "platform_public_event",
        sourceUrl: content.sourceUrl,
        platformEventId: content.platformEventId,
        providerVersion: content.providerVersion,
        coverage: content.coverage
      },
      accessStatus: "public_content"
    }, evidenceKey);
    if (injectFailures) await this.failureInjector?.("after_evidence");

    const decision = classifyDouyinCommentIntent(normalizedContent);
    let candidateId: string | null = null;
    let unresolvedDedupeKey: string | null = null;
    if (decision.band !== "noise") {
      const authoritativeComment: ValidComment = {
        commentId: authoritativeEvent.platformEventId,
        text: authoritativeEvent.text,
        occurredAt: authoritativeEvent.occurredAt,
        publishedAt: authoritativeEvent.occurredAt,
        likeCount: authoritativeEvent.likeCount,
        replyCount: authoritativeEvent.replyCount,
        ipLabel: authoritativeEvent.ipLabel,
        actor: authoritativeEvent.actor
      };
      const publicActorKey = actorKey(authoritativeComment);
      const demandSummary = [
        `抖音公开评论需求信号（非已核实客户事实）：${normalizedContent}`,
        `可审计规则：${decision.reasons.join("、")}`
      ].join("\n").slice(0, 2_000);
      const ingested = await this.individualSignals.ingest({
        scope,
        provider: DOUYIN_PUBLIC_COMMENT_PROVIDER_ID,
        sourceUrl: authoritativeEvent.sourceUrl,
        sourceType: "video",
        subject: {
          publicActorKey,
          publicDisplayName: authoritativeEvent.actor.displayName,
          publicProfileUrl: authoritativeEvent.sourceUrl,
          sourcePlatform: "douyin",
          demandCategory: "抖音公开评论需求信号",
          demandSummary,
          locationHint: authoritativeEvent.ipLabel ?? "",
          buyingStage: decision.buyingStage,
          negativeSignals: decision.negativeSignals
        },
        evidence,
        idempotencyKey: deterministicId("douyin-comment-signal", evidenceKey),
        ...(decision.band === "negative"
          ? { initialCandidateStatus: "do_not_contact" as const }
          : {}),
        beforeCandidateCommit: injectFailures && this.failureInjector
          ? () => this.failureInjector!("after_candidate")
          : undefined
      });
      candidateId = ingested.candidate.id;
      if (ingested.identityResolution.status === "needs_research") {
        unresolvedDedupeKey = ingested.identityResolution.dedupeKey;
      }
    }

    await this.events.commitIngestionSaga(scope, work.saga.sagaId, {
      candidateId,
      evidenceId: evidence.id
    });
    return {
      band: decision.band,
      candidateId,
      unresolvedDedupeKey,
      evidenceId: evidence.id
    };
  }
}
