import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type {
  AcquisitionPlanRunRepository,
  AcquisitionPlanVersion,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionVisualArtifactValidationError,
  AcquisitionVisualArtifactValidator,
  type VisualArtifactRedactionProof,
  type ValidatedVisualArtifact
} from "./acquisition-visual-artifact-validator.js";
import {
  AcquisitionVisualReaderRepositoryError,
  deriveVisualReaderOutcome,
  visualObservationIsManualReviewOnly,
  type AcquisitionScope,
  type AcquisitionVisualReaderRepository,
  type DouyinVisualCommentObservationV1,
  type VisualReaderArtifact,
  type VisualReaderSession,
  type VisualReaderStableErrorCode
} from "./acquisition-visual-reader-sessions.js";
import { canonicalJsonStringify } from "./canonical-json.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const VIDEO_URL = /^https:\/\/www\.douyin\.com\/video\/([1-9][0-9]{0,31})\/?$/u;
const VIDEO_ID = /^[1-9][0-9]{0,31}$/u;
const PROFILE_URL = /^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})\/?$/u;
const PUBLIC_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/u;
const MAX_CROP_BYTES = 262_144;
const MAX_BATCH_CROP_BYTES = 5 * MAX_CROP_BYTES;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

const stableErrorCodeSchema = z.enum([
  "visual_reader_not_enabled",
  "visual_reader_session_expired",
  "visual_reader_budget_exhausted",
  "visual_source_invalid",
  "visual_observation_invalid",
  "visual_artifact_invalid",
  "visual_extraction_method_disabled",
  "visual_extraction_low_confidence",
  "visual_reader_user_takeover"
]);
const identifierSchema = z.string().regex(IDENTIFIER);
const nullableDigestSchema = z.string().regex(DIGEST).nullable();
const nullableVisibleStringSchema = z.string().min(1).refine((value) =>
  Array.from(value).length <= 255 && /\S/u.test(value)).nullable();
const nullableCountSchema = z.number().int().min(0).max(2_147_483_647).nullable();
const confidenceSchema = z.number().finite().min(0).max(1);
const fieldConfidencesSchema = z.object({
  visibleText: confidenceSchema,
  displayName: confidenceSchema.optional(),
  visibleTimeText: confidenceSchema.optional(),
  likeCount: confidenceSchema.optional(),
  replyCount: confidenceSchema.optional(),
  platformCommentId: confidenceSchema.optional(),
  publicProfileUrl: confidenceSchema.optional(),
  secUid: confidenceSchema.optional()
}).strict();
const viewportSchema = z.object({
  width: z.number().int().min(1).max(8_192),
  height: z.number().int().min(1).max(8_192),
  deviceScaleFactor: z.number().finite().min(0.5).max(8)
}).strict();
const cardBoundsSchema = z.object({
  x: z.number().finite().min(0).max(8_192),
  y: z.number().finite().min(0).max(8_192),
  width: z.number().finite().positive().max(8_192),
  height: z.number().finite().positive().max(8_192)
}).strict();
const pixelRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1)
}).strict();
const redactionProofSchema = z.object({
  version: z.literal("opaque-rect-v1"),
  maskColorRgba: z.tuple([
    z.literal(17), z.literal(61), z.literal(51), z.literal(255)
  ]),
  avatarBounds: pixelRectSchema.nullable(),
  visibleRegions: z.array(pixelRectSchema).min(1).max(20),
  maskedRegions: z.array(pixelRectSchema).min(1).max(100)
}).strict();
const redactedCropSchema = z.object({
  mediaType: z.literal("image/webp"),
  contentBase64: z.string().min(1).max(349_528).regex(CANONICAL_BASE64),
  redactionProof: redactionProofSchema
}).strict();
const observationSubmissionSchema = z.object({
  clientObservationKey: identifierSchema,
  sourceUrl: z.string().max(80).regex(VIDEO_URL),
  videoId: z.string().regex(VIDEO_ID),
  visibleText: z.string().min(1).refine((value) =>
    Array.from(value).length <= 2_000 && /\S/u.test(value)),
  domTextHash: nullableDigestSchema,
  ocrTextHash: nullableDigestSchema,
  displayName: nullableVisibleStringSchema,
  visibleTimeText: nullableVisibleStringSchema,
  likeCount: nullableCountSchema,
  replyCount: nullableCountSchema,
  platformCommentId: z.string().regex(VIDEO_ID).nullable(),
  publicProfileUrl: z.string().max(170).regex(PROFILE_URL).nullable(),
  secUid: z.string().regex(PUBLIC_KEY).nullable(),
  extractionMethod: z.enum(["dom", "accessibility", "ocr", "vision"]),
  fieldConfidences: fieldConfidencesSchema,
  viewport: viewportSchema,
  cardBounds: cardBoundsSchema,
  readerVersion: z.string().min(1).refine((value) =>
    Array.from(value).length <= 100 && /\S/u.test(value)),
  capturedAt: z.string().datetime({ offset: true }),
  redactedCrop: redactedCropSchema.nullable()
}).strict();
const batchSchema = z.object({
  observations: z.array(observationSubmissionSchema).min(1).max(20)
}).strict();
const createSchema = z.object({
  runId: identifierSchema,
  artifactUploadEnabled: z.boolean()
}).strict();
const completeSchema = z.object({
  status: z.enum(["completed", "partial_success"]),
  errorCodes: z.array(stableErrorCodeSchema).max(9)
}).strict().superRefine((value, context) => {
  if (new Set(value.errorCodes).size !== value.errorCodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate" });
  }
});
const abortSchema = z.object({
  reasonCode: z.enum(["user_requested", "visual_reader_user_takeover"])
}).strict();

export type VisualObservationSubmission = z.infer<
  typeof observationSubmissionSchema
>;
export type VisualObservationBatchRequest = z.infer<typeof batchSchema>;
export type VisualReaderCompleteRequest = z.infer<typeof completeSchema>;
export type VisualReaderAbortRequest = z.infer<typeof abortSchema>;

export interface VisualReaderServiceScope extends AcquisitionScope {
  actorId: string;
}

export class AcquisitionVisualReaderServiceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "AcquisitionVisualReaderServiceError";
  }
}

interface ArtifactValidator {
  validate(input: {
    bytes: Buffer;
    viewport: VisualObservationSubmission["viewport"];
    cardBounds: VisualObservationSubmission["cardBounds"];
    redactionProof: VisualArtifactRedactionProof;
  }): Promise<ValidatedVisualArtifact>;
}

export interface AcquisitionVisualReaderServiceOptions {
  repository: AcquisitionVisualReaderRepository;
  planRunRepository: Pick<
    AcquisitionPlanRunRepository,
    "getRun" | "getPlanVersion"
  >;
  purposeSecret: string;
  now?: () => string;
  artifactValidator?: ArtifactValidator;
}

function fail(code: string, status: number): never {
  throw new AcquisitionVisualReaderServiceError(code, status);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") fail("visual_observation_invalid", 400);
  return result;
}

function digest(value: string | Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validScope(scope: unknown): asserts scope is VisualReaderServiceScope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)
    || Object.keys(scope).length !== 3) fail("unauthenticated", 401);
  const value = scope as Record<string, unknown>;
  for (const key of ["ownerId", "teamId", "actorId"]) {
    if (typeof value[key] !== "string"
      || !SCOPE_IDENTIFIER.test(value[key])) fail("unauthenticated", 401);
  }
}

function validHeader(value: unknown) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    fail("invalid_idempotency_key", 400);
  }
  return value;
}

function repositoryScope(scope: VisualReaderServiceScope): AcquisitionScope {
  return { ownerId: scope.ownerId, teamId: scope.teamId };
}

function parseOrFail<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(code, 400);
  return parsed.data;
}

function assertRunAuthority(
  scope: VisualReaderServiceScope,
  run: AcquisitionRun | null,
  version: AcquisitionPlanVersion | null
): asserts run is AcquisitionRun {
  if (!run || !version
    || run.ownerId !== scope.ownerId || run.teamId !== scope.teamId
    || version.ownerId !== scope.ownerId || version.teamId !== scope.teamId) {
    fail("resource_not_found", 404);
  }
  if (run.planId !== version.planId
    || run.planVersionId !== version.id
    || run.planVersion !== version.version
    || !["queued", "running"].includes(run.status)
    || version.payload.targetPlatform !== "douyin"
    || version.payload.douyinPublicCommentSample?.enabled !== true) {
    fail("visual_reader_not_enabled", 409);
  }
}

function decodedCropBytes(submission: VisualObservationSubmission) {
  if (!submission.redactedCrop) return null;
  const bytes = Buffer.from(submission.redactedCrop.contentBase64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CROP_BYTES
    || bytes.toString("base64") !== submission.redactedCrop.contentBase64) {
    fail("visual_artifact_invalid", 400);
  }
  return bytes;
}

function parseBatch(input: unknown) {
  const batch = parseOrFail(batchSchema, input, "visual_observation_invalid");
  let cropCount = 0;
  let decodedBytes = 0;
  const crops = batch.observations.map((submission) => {
    const bytes = decodedCropBytes(submission);
    if (bytes) {
      cropCount += 1;
      decodedBytes += bytes.byteLength;
    }
    return bytes;
  });
  if (cropCount > 5 || decodedBytes > MAX_BATCH_CROP_BYTES) {
    fail("payload_too_large", 413);
  }
  return { batch, crops };
}

function trimNullable(value: string | null) {
  return value === null ? null : value.trim();
}

function dynamicSubmissionCheck(
  submission: VisualObservationSubmission,
  session: VisualReaderSession
) {
  const source = VIDEO_URL.exec(submission.sourceUrl);
  if (!source || source[1] !== submission.videoId) {
    fail("visual_source_invalid", 400);
  }
  if (submission.publicProfileUrl && submission.secUid) {
    const profile = PROFILE_URL.exec(submission.publicProfileUrl);
    if (!profile || profile[1] !== submission.secUid) {
      fail("visual_observation_invalid", 400);
    }
  }
  if (submission.extractionMethod === "vision") {
    fail("visual_extraction_method_disabled", 400);
  }
  const normalizedTextHash = digest(submission.visibleText.trim());
  if ((submission.extractionMethod === "dom"
      || submission.extractionMethod === "accessibility")
    && submission.domTextHash !== normalizedTextHash) {
    fail("visual_observation_invalid", 400);
  }
  if (submission.extractionMethod === "ocr"
    && submission.ocrTextHash !== normalizedTextHash) {
    fail("visual_observation_invalid", 400);
  }
  if (submission.extractionMethod === "ocr"
    && (submission.platformCommentId !== null
      || submission.publicProfileUrl !== null
      || submission.secUid !== null)) {
    fail("visual_observation_invalid", 400);
  }
  if (submission.extractionMethod === "ocr" && !submission.redactedCrop) {
    fail("visual_artifact_invalid", 400);
  }
  if (submission.redactedCrop && !session.artifactUploadEnabled) {
    fail("visual_artifact_invalid", 400);
  }
  if (submission.cardBounds.x + submission.cardBounds.width
      > submission.viewport.width
    || submission.cardBounds.y + submission.cardBounds.height
      > submission.viewport.height) {
    fail("visual_observation_invalid", 400);
  }
  const capturedAt = Date.parse(submission.capturedAt);
  if (!Number.isFinite(capturedAt)
    || capturedAt < Date.parse(session.authorizedAt)
    || capturedAt > Date.parse(session.expiresAt)) {
    fail("visual_observation_invalid", 400);
  }
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof AcquisitionVisualReaderServiceError) throw error;
  if (error instanceof AcquisitionVisualArtifactValidationError) {
    fail("visual_artifact_invalid", 400);
  }
  if (!(error instanceof AcquisitionVisualReaderRepositoryError)) throw error;
  const mapping: Record<string, [string, number]> = {
    VISUAL_READER_INVALID_INPUT: ["visual_observation_invalid", 400],
    VISUAL_READER_SESSION_CONFLICT: ["idempotency_conflict", 409],
    VISUAL_READER_SESSION_NOT_FOUND: ["resource_not_found", 404],
    VISUAL_READER_SESSION_EXPIRED: ["visual_reader_session_expired", 409],
    VISUAL_READER_SESSION_TERMINAL: ["visual_reader_terminal", 409],
    VISUAL_READER_CLIENT_KEY_CONFLICT: ["idempotency_conflict", 409],
    VISUAL_READER_OBSERVATION_CONFLICT: ["visual_observation_invalid", 409],
    VISUAL_READER_ARTIFACT_INVALID: ["visual_artifact_invalid", 400],
    VISUAL_READER_ARTIFACT_CONFLICT: ["idempotency_conflict", 409],
    VISUAL_READER_BUDGET_EXHAUSTED: ["visual_reader_budget_exhausted", 409]
  };
  const mapped = mapping[error.code] ?? ["internal_error", 500];
  fail(mapped[0], mapped[1]);
}

export class AcquisitionVisualReaderService {
  private readonly repository: AcquisitionVisualReaderRepository;
  private readonly planRunRepository: AcquisitionVisualReaderServiceOptions[
    "planRunRepository"
  ];
  private readonly purposeSecret: string;
  private readonly now: () => string;
  private readonly artifactValidator: ArtifactValidator;

  constructor(options: AcquisitionVisualReaderServiceOptions) {
    if (!options || typeof options !== "object"
      || typeof options.purposeSecret !== "string"
      || Buffer.byteLength(options.purposeSecret, "utf8") < 32) {
      throw new Error("ACQUISITION_VISUAL_READER_CONFIGURATION_INVALID");
    }
    this.repository = options.repository;
    this.planRunRepository = options.planRunRepository;
    this.purposeSecret = options.purposeSecret;
    this.now = options.now ?? (() => new Date().toISOString());
    this.artifactValidator = options.artifactValidator
      ?? new AcquisitionVisualArtifactValidator();
  }

  private hmac(purpose: string, value: unknown) {
    return createHmac("sha256", this.purposeSecret)
      .update(`${purpose}\0${canonical(value)}`)
      .digest("hex");
  }

  async createSession(
    scope: VisualReaderServiceScope,
    input: unknown,
    idempotencyKey: unknown
  ) {
    try {
      validScope(scope);
      const body = parseOrFail(createSchema, input, "visual_observation_invalid");
      const rawKey = validHeader(idempotencyKey);
      const run = await this.planRunRepository.getRun(body.runId);
      const version = run
        ? await this.planRunRepository.getPlanVersion(run.planVersionId)
        : null;
      assertRunAuthority(scope, run, version);
      const policy = version!.payload.douyinPublicCommentSample!;
      const now = this.now();
      const nowTime = Date.parse(now);
      if (!Number.isFinite(nowTime) || new Date(nowTime).toISOString() !== now) {
        throw new Error("ACQUISITION_VISUAL_READER_CLOCK_INVALID");
      }
      const result = await this.repository.createSessionWithResult({
        scope: repositoryScope(scope),
        sessionId: `visual-session:${this.hmac("session:v1", {
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          runId: run.id,
          idempotencyKey: rawKey
        })}`,
        runId: run.id,
        planId: run.planId,
        planVersionId: run.planVersionId,
        artifactUploadEnabled: body.artifactUploadEnabled,
        limits: {
          maxVideos: Math.min(10, policy.maxVideosPerRun),
          maxCommentsPerVideo: Math.min(30, policy.maxCommentsPerVideo),
          maxScrolls: 5,
          maxOcrCalls: 10,
          maxDurationMs: 120_000
        },
        createdAt: now,
        authorizedAt: now,
        expiresAt: new Date(nowTime + 120_000).toISOString()
      });
      return result;
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async getSession(scope: VisualReaderServiceScope, sessionId: unknown) {
    try {
      validScope(scope);
      if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId)) {
        fail("resource_not_found", 404);
      }
      const session = await this.repository.getSession(
        repositoryScope(scope),
        sessionId
      );
      if (!session) fail("resource_not_found", 404);
      return session;
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async appendObservationBatch(
    scope: VisualReaderServiceScope,
    sessionId: unknown,
    input: unknown,
    idempotencyKey: unknown
  ) {
    try {
      validScope(scope);
      if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId)) {
        fail("resource_not_found", 404);
      }
      const rawKey = validHeader(idempotencyKey);
      const { batch, crops } = parseBatch(input);
      const requestBinding = {
        keyHash: `sha256:${this.hmac("batch-key:v1", {
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          sessionId,
          idempotencyKey: rawKey
        })}`,
        requestHash: digest(canonical(batch))
      };
      const replay = await this.repository.findObservationBatchReplay({
        scope: repositoryScope(scope),
        sessionId,
        requestBinding
      });
      if (replay) {
        return {
          response: replay,
          replayed: true,
          manualReviewOnlyObservationIds: replay.accepted
            .filter(({ observation }) =>
              visualObservationIsManualReviewOnly(observation))
            .map(({ observation }) => observation.observationId)
        };
      }
      const session = await this.repository.getSession(
        repositoryScope(scope),
        sessionId
      );
      if (!session) fail("resource_not_found", 404);
      if (["completed", "partial_success", "aborted", "expired"].includes(
        session.status
      )) fail(session.status === "expired"
        ? "visual_reader_session_expired" : "visual_reader_terminal", 409);

      const normalized = [] as Array<{
        clientObservationKey: string;
        observation: DouyinVisualCommentObservationV1;
        artifact?: {
          artifactId: string;
          observationId: string;
          mediaType: "image/webp";
          plaintext: Buffer;
          plaintextHash: string;
          byteLength: number;
          width: number;
          height: number;
          maskedRegionCount: number;
          createdAt: string;
          expiresAt: string;
        };
      }>;
      for (let index = 0; index < batch.observations.length; index += 1) {
        const submission = batch.observations[index]!;
        dynamicSubmissionCheck(submission, session);
        const cropBytes = crops[index];
        const visibleText = submission.visibleText.trim();
        const redactedCropHash = cropBytes ? digest(cropBytes) : null;
        const normalizedFacts = {
          sourceUrl: submission.sourceUrl,
          videoId: submission.videoId,
          visibleText,
          domTextHash: submission.domTextHash,
          ocrTextHash: submission.ocrTextHash,
          displayName: trimNullable(submission.displayName),
          visibleTimeText: trimNullable(submission.visibleTimeText),
          likeCount: submission.likeCount,
          replyCount: submission.replyCount,
          platformCommentId: submission.platformCommentId,
          publicProfileUrl: submission.publicProfileUrl,
          secUid: submission.secUid,
          extractionMethod: submission.extractionMethod,
          fieldConfidences: submission.fieldConfidences,
          viewportHash: digest(canonical(submission.viewport)),
          cardBounds: submission.cardBounds,
          redactedCropHash,
          readerVersion: submission.readerVersion.trim(),
          capturedAt: new Date(submission.capturedAt).toISOString()
        };
        const observationSuffix = this.hmac("observation:v1", {
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          sessionId,
          clientObservationKey: submission.clientObservationKey,
          facts: normalizedFacts
        });
        const observation: DouyinVisualCommentObservationV1 = {
          observationId: `visual-observation:${observationSuffix}`,
          sessionId,
          ...normalizedFacts,
          textHash: digest(visibleText)
        };
        let artifact: typeof normalized[number]["artifact"];
        if (cropBytes && submission.redactedCrop) {
          const validated = await this.artifactValidator.validate({
            bytes: cropBytes,
            viewport: submission.viewport,
            cardBounds: submission.cardBounds,
            redactionProof: submission.redactedCrop.redactionProof
          });
          const createdAt = this.now();
          artifact = {
            artifactId: `visual-artifact:${observationSuffix}`,
            observationId: observation.observationId,
            mediaType: "image/webp",
            plaintext: Buffer.from(validated.bytes),
            plaintextHash: redactedCropHash!,
            byteLength: validated.bytes.byteLength,
            width: validated.width,
            height: validated.height,
            maskedRegionCount: validated.maskedRegionCount,
            createdAt,
            expiresAt: new Date(Date.parse(createdAt) + THIRTY_DAYS_MS)
              .toISOString()
          };
        }
        normalized.push({
          clientObservationKey: submission.clientObservationKey,
          observation,
          ...(artifact ? { artifact } : {})
        });
      }
      await this.repository.appendObservationBatchWithResult({
        scope: repositoryScope(scope),
        sessionId,
        ingestionActorId: scope.actorId,
        observations: normalized,
        usageDelta: { scrollCount: 1, ocrCallCount: 0 },
        requestBinding
      });
      const stored = await this.repository.findObservationBatchReplay({
        scope: repositoryScope(scope),
        sessionId,
        requestBinding
      });
      if (!stored) throw new Error("ACQUISITION_VISUAL_READER_REPLAY_MISSING");
      return {
        response: stored,
        replayed: false,
        manualReviewOnlyObservationIds: stored.accepted
          .filter(({ observation }) =>
            visualObservationIsManualReviewOnly(observation))
          .map(({ observation }) => observation.observationId)
      };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async completeSession(
    scope: VisualReaderServiceScope,
    sessionId: unknown,
    input: unknown
  ) {
    try {
      const body = parseOrFail(completeSchema, input,
        "visual_observation_invalid");
      const session = await this.getSession(scope, sessionId);
      return await this.repository.completeSession(
        repositoryScope(scope),
        session.sessionId,
        deriveVisualReaderOutcome(body.status, session.usage,
          body.errorCodes as VisualReaderStableErrorCode[])
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async abortSession(
    scope: VisualReaderServiceScope,
    sessionId: unknown,
    input: unknown
  ) {
    try {
      const body = parseOrFail(abortSchema, input,
        "visual_observation_invalid");
      const session = await this.getSession(scope, sessionId);
      const errors: VisualReaderStableErrorCode[] = body.reasonCode
        === "visual_reader_user_takeover"
        ? ["visual_reader_user_takeover"] : [];
      return await this.repository.completeSession(
        repositoryScope(scope),
        session.sessionId,
        deriveVisualReaderOutcome("aborted", session.usage, errors)
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async getArtifact(
    scope: VisualReaderServiceScope,
    artifactId: unknown
  ): Promise<VisualReaderArtifact> {
    try {
      validScope(scope);
      if (typeof artifactId !== "string" || !IDENTIFIER.test(artifactId)) {
        fail("resource_not_found", 404);
      }
      const artifact = await this.repository.getArtifact(
        repositoryScope(scope),
        artifactId
      );
      if (!artifact) fail("resource_not_found", 404);
      return artifact;
    } catch (error) {
      mapRepositoryError(error);
    }
  }
}
