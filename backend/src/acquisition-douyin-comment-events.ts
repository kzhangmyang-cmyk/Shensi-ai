import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface AcquisitionScope {
  ownerId: string;
  teamId: string;
}

export interface DouyinCommentEvent {
  eventId: string;
  platform: "douyin";
  eventType: "comment";
  platformEventId: string;
  videoId: string;
  parentCommentId: null;
  text: string;
  textHash: string;
  occurredAt: string;
  capturedAt: string;
  likeCount: number;
  replyCount: number;
  ipLabel: string | null;
  actor: {
    displayName: string;
    handle: string | null;
    secUid: string | null;
  };
  sourceUrl: string;
  coverage: "public_top_level_sample";
  accessStatus: "public_content";
  providerVersion: string;
  rawArtifactHash: string;
}

export interface DouyinCommentObservation {
  observationId: string;
  eventId: string;
  capturedAt: string;
  likeCount: number;
  replyCount: number;
  observedTextHash: string;
  providerVersion: string;
  rawArtifactHash: string;
}

export interface DouyinCommentContentVersion {
  contentVersionId: string;
  eventId: string;
  textHash: string;
  observationId: string;
  text: string;
  occurredAt: string;
  actor: DouyinCommentEvent["actor"];
  sourceUrl: string;
  platformEventId: string;
  providerVersion: string;
  coverage: "public_top_level_sample";
  rawArtifactHash: string;
}

export interface DouyinCommentIngestionSagaStart {
  sagaId: string;
  actorId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
}

export interface DouyinCommentIngestionSaga {
  sagaId: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  eventId: string;
  observationId: string;
  textHash: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  status: "pending" | "committed";
  candidateId: string | null;
  evidenceId: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: "RECOVERY_FAILED" | null;
}

export interface DouyinCommentIngestionSagaWorkItem {
  saga: DouyinCommentIngestionSaga;
  event: DouyinCommentEvent;
  observation: DouyinCommentObservation;
  contentVersion: DouyinCommentContentVersion;
}

export interface AppendDouyinCommentObservationInput {
  scope: AcquisitionScope;
  observationId: string;
  event: DouyinCommentEvent;
  ingestionSaga?: DouyinCommentIngestionSagaStart;
}

export interface DouyinCommentEventLink {
  linkId: string;
  eventId: string;
  observationId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  candidateId: string | null;
  evidenceId: string | null;
}

export interface LinkDouyinCommentEventInput {
  scope: AcquisitionScope;
  eventId: string;
  observationId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  candidateId: string | null;
  evidenceId: string | null;
}

export type DouyinCommentFetchAttemptTerminalStatus =
  | "succeeded"
  | "partial_success"
  | "failed"
  | "no_public_comments";

export interface DouyinCommentFetchAttemptTerminalProjection {
  transportRequestCount: number;
  durationSeconds: number;
  eventCount: number;
  evidenceCount: number;
  candidateIds: string[];
  unresolvedActorCount: number;
  strongSignalCount: number;
  invalidCommentCount: number;
}

export interface DouyinCommentFetchAttempt {
  attemptId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  sourceUrl: string;
  videoId: string | null;
  status: "running" | DouyinCommentFetchAttemptTerminalStatus;
  errorCode: string | null;
  requestedCount: number;
  returnedCount: number;
  reportedCommentCount: number | null;
  pagesFetched: number;
  startedAt: string;
  completedAt: string | null;
  terminalProjection?: DouyinCommentFetchAttemptTerminalProjection;
}

export interface StartDouyinCommentFetchAttemptInput {
  scope: AcquisitionScope;
  attemptId: string;
  runId: string | null;
  shardId: string | null;
  discoveryOperationId: string | null;
  sourceUrl: string;
  videoId: string | null;
  requestedCount: number;
  startedAt: string;
}

export interface FinishDouyinCommentFetchAttemptInput {
  status: DouyinCommentFetchAttemptTerminalStatus;
  errorCode: string | null;
  returnedCount: number;
  reportedCommentCount: number | null;
  pagesFetched: number;
  completedAt: string;
  terminalProjection?: DouyinCommentFetchAttemptTerminalProjection;
}

export interface DouyinRunCommentSignal {
  event: DouyinCommentEvent;
  latestObservation: DouyinCommentObservation;
  link: DouyinCommentEventLink;
}

export interface DouyinRunCommentSummary {
  linkedEventCount: number;
  observationCount: number;
  fetchAttemptCount: number;
  discoveredVideoCount: number;
  returnedCommentCount: number;
  validDemandSignalCount: number;
  unresolvedActorCount: number;
  strongSignalCount: number;
}

export interface DouyinRunCommentPresentationProjection {
  fetchAttemptCount: number;
  discoveredVideoCount: number;
  returnedCommentCount: number;
  resolvedVideoCount: number;
  unresolvedVideoCount: number;
  runningAttemptCount: number;
  succeededAttemptCount: number;
  partialSuccessAttemptCount: number;
  failedAttemptCount: number;
  noPublicCommentsAttemptCount: number;
  attemptStartedAt: string | null;
  attemptCompletedAt: string | null;
  terminalEventCount: number;
  terminalEvidenceCount: number;
  linkedEventCount: number;
  ingestionEventCount: number;
  pendingIngestionCount: number;
  errorCodes: string[];
  candidateIds: string[];
}

export interface AcquisitionDouyinCommentEventRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  appendObservation(input: AppendDouyinCommentObservationInput): Promise<{
    event: DouyinCommentEvent;
    observation: DouyinCommentObservation;
    eventCreated: boolean;
    contentChanged: boolean;
    contentVersion: DouyinCommentContentVersion;
    ingestionSaga: DouyinCommentIngestionSaga | null;
  }>;
  getIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string
  ): Promise<DouyinCommentIngestionSagaWorkItem | null>;
  listPendingIngestionSagas(
    options: { limit: number }
  ): Promise<DouyinCommentIngestionSagaWorkItem[]>;
  claimPendingIngestionSagas(options: {
    workerId: string;
    now: string;
    leaseDurationMs: number;
    limit: number;
  }): Promise<DouyinCommentIngestionSagaWorkItem[]>;
  failIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    failure: {
      workerId: string;
      failedAt: string;
      nextAttemptAt: string;
      errorCode: "RECOVERY_FAILED";
    }
  ): Promise<DouyinCommentIngestionSaga>;
  commitIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    result: { candidateId: string | null; evidenceId: string }
  ): Promise<{
    saga: DouyinCommentIngestionSaga;
    link: DouyinCommentEventLink;
    created: boolean;
  }>;
  linkEvent(input: LinkDouyinCommentEventInput): Promise<{
    link: DouyinCommentEventLink;
    created: boolean;
  }>;
  startFetchAttempt(input: StartDouyinCommentFetchAttemptInput): Promise<{
    attempt: DouyinCommentFetchAttempt;
    created: boolean;
  }>;
  finishFetchAttempt(
    scope: AcquisitionScope,
    attemptId: string,
    terminal: FinishDouyinCommentFetchAttemptInput
  ): Promise<DouyinCommentFetchAttempt>;
  listRunCommentSignals(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ): Promise<DouyinRunCommentSignal[]>;
  getRunCommentSummary(
    scope: AcquisitionScope,
    runId: string
  ): Promise<DouyinRunCommentSummary>;
  listFetchAttempts(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ): Promise<DouyinCommentFetchAttempt[]>;
  /** Internal Run Presentation projection. All attempt rows are aggregated;
   * candidate IDs remain bounded by the repository hard limit. */
  getRunCommentPresentationProjection(
    scope: AcquisitionScope,
    runId: string
  ): Promise<DouyinRunCommentPresentationProjection>;
  /** Internal bounded signal fact read. Callers request one extra row to
   * detect and fail closed on the hard projection limit. */
  listRunCommentSignalsForPresentation(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ): Promise<DouyinRunCommentSignal[]>;
}

function cloned<T>(value: T): T {
  return structuredClone(value);
}

function scopeKey(scope: AcquisitionScope) {
  return `${scope.ownerId}\u0000${scope.teamId}`;
}

function eventKey(scope: AcquisitionScope, platformEventId: string) {
  return `${scopeKey(scope)}\u0000douyin\u0000${platformEventId}`;
}

function entityKey(scope: AcquisitionScope, id: string) {
  return `${scopeKey(scope)}\u0000${id}`;
}

function contentVersionKey(
  scope: AcquisitionScope,
  eventId: string,
  textHash: string
) {
  return `${scopeKey(scope)}\u0000${eventId}\u0000${textHash}`;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nonEmpty(value: unknown, maximum = 255) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function nullableNonEmpty(value: unknown, maximum = 255) {
  return value === null || nonEmpty(value, maximum);
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validInstant(value: unknown) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function canonicalDouyinCommentInstant(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_INSTANT");
  }
  return date.toISOString();
}

function validDigest(value: unknown) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function assertAppendDouyinCommentObservationInput(
  input: AppendDouyinCommentObservationInput
) {
  const event = input?.event;
  let validUrl = false;
  try {
    validUrl = Boolean(event && new URL(event.sourceUrl));
  } catch {
    validUrl = false;
  }
  const saga = input?.ingestionSaga;
  if (!input
    || !nonEmpty(input.scope?.ownerId, 100)
    || !nonEmpty(input.scope?.teamId, 100)
    || !nonEmpty(input.observationId, 160)
    || !event
    || !nonEmpty(event.eventId, 160)
    || event.platform !== "douyin"
    || event.eventType !== "comment"
    || !nonEmpty(event.platformEventId)
    || !nonEmpty(event.videoId)
    || event.parentCommentId !== null
    || !nonEmpty(event.text, 10_000)
    || !validDigest(event.textHash)
    || !validInstant(event.occurredAt)
    || !validInstant(event.capturedAt)
    || !nonNegativeInteger(event.likeCount)
    || !nonNegativeInteger(event.replyCount)
    || !nullableNonEmpty(event.ipLabel)
    || !nonEmpty(event.actor?.displayName)
    || !nullableNonEmpty(event.actor?.handle)
    || !nullableNonEmpty(event.actor?.secUid)
    || !validUrl
    || event.sourceUrl.length > 4_000
    || event.coverage !== "public_top_level_sample"
    || event.accessStatus !== "public_content"
    || !nonEmpty(event.providerVersion)
    || !validDigest(event.rawArtifactHash)
    || (saga !== undefined && (
      !nonEmpty(saga.sagaId, 160)
      || !nonEmpty(saga.actorId, 100)
      || !nullableNonEmpty(saga.runId, 160)
      || !nullableNonEmpty(saga.shardId, 160)
      || !nullableNonEmpty(saga.discoveryOperationId, 160)
    ))) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_EVENT");
  }
}

export function assertStartDouyinCommentFetchAttemptInput(
  input: StartDouyinCommentFetchAttemptInput
) {
  let validUrl = false;
  try {
    validUrl = Boolean(input && new URL(input.sourceUrl));
  } catch {
    validUrl = false;
  }
  if (!input
    || !nonEmpty(input.scope?.ownerId, 100)
    || !nonEmpty(input.scope?.teamId, 100)
    || !nonEmpty(input.attemptId, 160)
    || !nullableNonEmpty(input.runId, 160)
    || !nullableNonEmpty(input.shardId, 160)
    || !nullableNonEmpty(input.discoveryOperationId, 160)
    || !validUrl
    || input.sourceUrl.length > 4_000
    || !nullableNonEmpty(input.videoId)
    || !nonNegativeInteger(input.requestedCount)
    || !validInstant(input.startedAt)) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_FETCH_ATTEMPT");
  }
}

export function assertFinishDouyinCommentFetchAttemptInput(
  input: FinishDouyinCommentFetchAttemptInput
) {
  const statuses = new Set([
    "succeeded", "partial_success", "failed", "no_public_comments"
  ]);
  const projection = input?.terminalProjection;
  const projectionCounts = projection && [
    projection.transportRequestCount,
    projection.durationSeconds,
    projection.eventCount,
    projection.evidenceCount,
    projection.unresolvedActorCount,
    projection.strongSignalCount,
    projection.invalidCommentCount
  ];
  if (!input
    || !statuses.has(input.status)
    || !nullableNonEmpty(input.errorCode)
    || !nonNegativeInteger(input.returnedCount)
    || (input.reportedCommentCount !== null
      && !nonNegativeInteger(input.reportedCommentCount))
    || !nonNegativeInteger(input.pagesFetched)
    || !validInstant(input.completedAt)
    || (projection !== undefined && (
      !projectionCounts?.every(nonNegativeInteger)
      || !Array.isArray(projection.candidateIds)
      || projection.candidateIds.length > 100
      || projection.candidateIds.some((id) => !nonEmpty(id, 160))
      || new Set(projection.candidateIds).size
        !== projection.candidateIds.length
    ))) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_FETCH_ATTEMPT");
  }
}

export function assertLinkDouyinCommentEventInput(
  input: LinkDouyinCommentEventInput
) {
  if (!input
    || !nonEmpty(input.scope?.ownerId, 100)
    || !nonEmpty(input.scope?.teamId, 100)
    || !nonEmpty(input.eventId, 160)
    || !nonEmpty(input.observationId, 160)
    || !nullableNonEmpty(input.runId, 160)
    || !nullableNonEmpty(input.shardId, 160)
    || !nullableNonEmpty(input.discoveryOperationId, 160)
    || !nullableNonEmpty(input.candidateId, 160)
    || !nullableNonEmpty(input.evidenceId, 160)) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_LINK");
  }
}

function deterministicLink(input: LinkDouyinCommentEventInput) {
  const identity = JSON.stringify([
    input.scope.ownerId,
    input.scope.teamId,
    input.eventId,
    input.observationId,
    input.runId,
    input.shardId,
    input.discoveryOperationId,
    input.candidateId,
    input.evidenceId
  ]);
  return `douyin-comment-link:${createHash("sha256")
    .update(identity)
    .digest("hex")}`;
}

function deterministicContentVersionId(
  scope: AcquisitionScope,
  eventId: string,
  textHash: string
) {
  return `douyin-comment-content:${createHash("sha256").update(JSON.stringify([
    scope.ownerId,
    scope.teamId,
    eventId,
    textHash
  ])).digest("hex")}`;
}

function positiveLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_LIMIT");
  }
  return limit;
}

function presentationLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_001) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_PRESENTATION_LIMIT_INVALID");
  }
  return limit;
}

type Scoped<T> = { scope: AcquisitionScope; value: T };

export class InMemoryAcquisitionDouyinCommentEventRepository
implements AcquisitionDouyinCommentEventRepository {
  private readonly eventsByBoundary = new Map<string, Scoped<DouyinCommentEvent>>();
  private readonly eventsById = new Map<string, Scoped<DouyinCommentEvent>>();
  private readonly observations = new Map<string, Scoped<DouyinCommentObservation>>();
  private readonly contentVersions =
    new Map<string, Scoped<DouyinCommentContentVersion>>();
  private readonly ingestionSagas =
    new Map<string, Scoped<DouyinCommentIngestionSaga>>();
  private readonly links = new Map<string, Scoped<DouyinCommentEventLink>>();
  private readonly attempts = new Map<string, Scoped<DouyinCommentFetchAttempt>>();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshots = {
      eventsByBoundary: cloned([...this.eventsByBoundary.entries()]),
      eventsById: cloned([...this.eventsById.entries()]),
      observations: cloned([...this.observations.entries()]),
      contentVersions: cloned([...this.contentVersions.entries()]),
      ingestionSagas: cloned([...this.ingestionSagas.entries()]),
      links: cloned([...this.links.entries()]),
      attempts: cloned([...this.attempts.entries()])
    };
    try {
      return await this.transactionContext.run(true, work);
    } catch (error) {
      const restore = <TValue>(
        target: Map<string, TValue>,
        entries: Array<[string, TValue]>
      ) => {
        target.clear();
        for (const [key, value] of entries) target.set(key, value);
      };
      restore(this.eventsByBoundary, snapshots.eventsByBoundary);
      restore(this.eventsById, snapshots.eventsById);
      restore(this.observations, snapshots.observations);
      restore(this.contentVersions, snapshots.contentVersions);
      restore(this.ingestionSagas, snapshots.ingestionSagas);
      restore(this.links, snapshots.links);
      restore(this.attempts, snapshots.attempts);
      throw error;
    } finally {
      release();
    }
  }

  async appendObservation(
    input: AppendDouyinCommentObservationInput
  ): ReturnType<AcquisitionDouyinCommentEventRepository["appendObservation"]> {
    if (!this.transactionContext.getStore()) {
      return this.transaction(() => this.appendObservation(input));
    }
    assertAppendDouyinCommentObservationInput(input);
    const boundary = eventKey(input.scope, input.event.platformEventId);
    const stored = this.eventsByBoundary.get(boundary);
    const normalizedEvent: DouyinCommentEvent = {
      ...cloned(input.event),
      occurredAt: canonicalDouyinCommentInstant(input.event.occurredAt),
      capturedAt: canonicalDouyinCommentInstant(input.event.capturedAt)
    };
    const event = stored?.value ?? normalizedEvent;
    const eventCreated = !stored;
    const eventIdKey = entityKey(input.scope, event.eventId);
    if (eventCreated) {
      if (this.eventsById.has(eventIdKey)) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_EVENT_ID_CONFLICT");
      }
    }
    const observation: DouyinCommentObservation = {
      observationId: input.observationId,
      eventId: event.eventId,
      capturedAt: normalizedEvent.capturedAt,
      likeCount: input.event.likeCount,
      replyCount: input.event.replyCount,
      observedTextHash: input.event.textHash,
      providerVersion: input.event.providerVersion,
      rawArtifactHash: input.event.rawArtifactHash
    };
    const observationKey = entityKey(input.scope, input.observationId);
    const existingObservation = this.observations.get(observationKey)?.value;
    if (existingObservation && !same(existingObservation, observation)) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_OBSERVATION_ID_CONFLICT");
    }
    const contentKey = contentVersionKey(
      input.scope,
      event.eventId,
      observation.observedTextHash
    );
    const existingContentVersion = this.contentVersions.get(contentKey)?.value;
    const contentVersion: DouyinCommentContentVersion =
      existingContentVersion ?? {
        contentVersionId: deterministicContentVersionId(
          input.scope,
          event.eventId,
          observation.observedTextHash
        ),
        eventId: event.eventId,
        textHash: observation.observedTextHash,
        observationId: observation.observationId,
        text: normalizedEvent.text,
        occurredAt: normalizedEvent.occurredAt,
        actor: cloned(normalizedEvent.actor),
        sourceUrl: normalizedEvent.sourceUrl,
        platformEventId: normalizedEvent.platformEventId,
        providerVersion: normalizedEvent.providerVersion,
        coverage: normalizedEvent.coverage,
        rawArtifactHash: normalizedEvent.rawArtifactHash
      };
    const sagaKey = input.ingestionSaga
      ? entityKey(input.scope, input.ingestionSaga.sagaId)
      : null;
    const existingSaga = sagaKey
      ? this.ingestionSagas.get(sagaKey)?.value
      : null;
    const requestedSaga: DouyinCommentIngestionSaga | null = input.ingestionSaga
      ? {
          ...cloned(input.ingestionSaga),
          ownerId: input.scope.ownerId,
          teamId: input.scope.teamId,
          eventId: event.eventId,
          observationId: observation.observationId,
          textHash: observation.observedTextHash,
          status: "pending",
          candidateId: null,
          evidenceId: null,
          createdAt: observation.capturedAt,
          updatedAt: observation.capturedAt,
          committedAt: null,
          attemptCount: 0,
          nextAttemptAt: observation.capturedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null
        }
      : null;
    if (existingSaga && requestedSaga && !same({
      ...existingSaga,
      status: "pending",
      candidateId: null,
      evidenceId: null,
      updatedAt: requestedSaga.updatedAt,
      committedAt: null,
      attemptCount: requestedSaga.attemptCount,
      nextAttemptAt: requestedSaga.nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null
    }, requestedSaga)) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_CONFLICT");
    }
    if (eventCreated) {
      const scoped = { scope: cloned(input.scope), value: event };
      this.eventsByBoundary.set(boundary, scoped);
      this.eventsById.set(eventIdKey, scoped);
    }
    if (!existingObservation) {
      this.observations.set(observationKey, {
        scope: cloned(input.scope),
        value: cloned(observation)
      });
    }
    if (!existingContentVersion) {
      this.contentVersions.set(contentKey, {
        scope: cloned(input.scope),
        value: cloned(contentVersion)
      });
    }
    if (sagaKey && requestedSaga && !existingSaga) {
      this.ingestionSagas.set(sagaKey, {
        scope: cloned(input.scope),
        value: cloned(requestedSaga)
      });
    }
    return cloned({
      event,
      observation: existingObservation ?? observation,
      eventCreated,
      contentChanged: event.textHash !== observation.observedTextHash,
      contentVersion,
      ingestionSaga: existingSaga ?? requestedSaga
    });
  }

  async getIngestionSaga(scope: AcquisitionScope, sagaId: string) {
    if (!nonEmpty(scope?.ownerId, 100)
      || !nonEmpty(scope?.teamId, 100)
      || !nonEmpty(sagaId, 160)) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_INGESTION_SAGA");
    }
    const saga = this.ingestionSagas.get(entityKey(scope, sagaId))?.value;
    if (!saga) return null;
    const event = this.eventsById.get(entityKey(scope, saga.eventId))?.value;
    const observation = this.observations.get(
      entityKey(scope, saga.observationId)
    )?.value;
    const contentVersion = this.contentVersions.get(contentVersionKey(
      scope,
      saga.eventId,
      saga.textHash
    ))?.value;
    if (!event || !observation || !contentVersion) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_INTEGRITY");
    }
    return cloned({ saga, event, observation, contentVersion });
  }

  async listPendingIngestionSagas(options: { limit: number }) {
    const limit = positiveLimit(options.limit);
    const pending = [...this.ingestionSagas.values()]
      .map((item) => item.value)
      .filter((saga) => saga.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.sagaId.localeCompare(right.sagaId))
      .slice(0, limit);
    const work = await Promise.all(pending.map((saga) => this.getIngestionSaga(
      { ownerId: saga.ownerId, teamId: saga.teamId },
      saga.sagaId
    )));
    return work.filter((item): item is DouyinCommentIngestionSagaWorkItem =>
      item !== null);
  }

  async claimPendingIngestionSagas(options: {
    workerId: string;
    now: string;
    leaseDurationMs: number;
    limit: number;
  }) {
    return this.transaction(async () => {
      const limit = positiveLimit(options.limit);
      if (!nonEmpty(options.workerId, 100)
        || !validInstant(options.now)
        || !Number.isSafeInteger(options.leaseDurationMs)
        || options.leaseDurationMs < 1_000
        || options.leaseDurationMs > 10 * 60_000) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_LEASE");
      }
      const now = canonicalDouyinCommentInstant(options.now);
      const leaseExpiresAt = new Date(
        new Date(now).getTime() + options.leaseDurationMs
      ).toISOString();
      const claimed = [...this.ingestionSagas.values()]
        .map((item) => item.value)
        .filter((saga) => saga.status === "pending"
          && saga.nextAttemptAt <= now
          && (saga.leaseExpiresAt === null || saga.leaseExpiresAt <= now))
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt)
          || left.createdAt.localeCompare(right.createdAt)
          || left.sagaId.localeCompare(right.sagaId))
        .slice(0, limit);
      for (const saga of claimed) {
        const stored = this.ingestionSagas.get(entityKey({
          ownerId: saga.ownerId,
          teamId: saga.teamId
        }, saga.sagaId))!;
        stored.value = {
          ...stored.value,
          attemptCount: stored.value.attemptCount + 1,
          leaseOwner: options.workerId,
          leaseExpiresAt,
          updatedAt: now
        };
      }
      const work = await Promise.all(claimed.map((saga) =>
        this.getIngestionSaga(
          { ownerId: saga.ownerId, teamId: saga.teamId },
          saga.sagaId
        )));
      return work.filter((item): item is DouyinCommentIngestionSagaWorkItem =>
        item !== null);
    });
  }

  async failIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    failure: {
      workerId: string;
      failedAt: string;
      nextAttemptAt: string;
      errorCode: "RECOVERY_FAILED";
    }
  ) {
    return this.transaction(async () => {
      const failedAt = canonicalDouyinCommentInstant(failure.failedAt);
      const nextAttemptAt = canonicalDouyinCommentInstant(failure.nextAttemptAt);
      if (!nonEmpty(failure.workerId, 100)
        || failure.errorCode !== "RECOVERY_FAILED"
        || nextAttemptAt <= failedAt) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_RECOVERY_FAILURE");
      }
      const stored = this.ingestionSagas.get(entityKey(scope, sagaId));
      if (!stored || stored.value.status !== "pending") {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_NOT_FOUND");
      }
      if (stored.value.leaseOwner !== failure.workerId) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_LEASE_CONFLICT");
      }
      stored.value = {
        ...stored.value,
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.errorCode,
        updatedAt: failedAt
      };
      return cloned(stored.value);
    });
  }

  async commitIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    result: { candidateId: string | null; evidenceId: string }
  ) {
    return this.transaction(async () => {
      if (!nonEmpty(scope?.ownerId, 100)
        || !nonEmpty(scope?.teamId, 100)
        || !nonEmpty(sagaId, 160)
        || !nullableNonEmpty(result.candidateId, 160)
        || !nonEmpty(result.evidenceId, 160)) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_INGESTION_RESULT");
      }
      const key = entityKey(scope, sagaId);
      const stored = this.ingestionSagas.get(key);
      if (!stored) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_NOT_FOUND");
      }
      const saga = stored.value;
      if (saga.status === "committed") {
        if (saga.candidateId !== result.candidateId
          || saga.evidenceId !== result.evidenceId) {
          throw new Error("ACQUISITION_DOUYIN_COMMENT_INGESTION_SAGA_CONFLICT");
        }
        const linked = await this.linkEvent({
          scope,
          eventId: saga.eventId,
          observationId: saga.observationId,
          runId: saga.runId,
          shardId: saga.shardId,
          discoveryOperationId: saga.discoveryOperationId,
          candidateId: saga.candidateId,
          evidenceId: saga.evidenceId
        });
        return cloned({ saga, link: linked.link, created: false });
      }
      const linked = await this.linkEvent({
        scope,
        eventId: saga.eventId,
        observationId: saga.observationId,
        runId: saga.runId,
        shardId: saga.shardId,
        discoveryOperationId: saga.discoveryOperationId,
        candidateId: result.candidateId,
        evidenceId: result.evidenceId
      });
      const committed: DouyinCommentIngestionSaga = {
        ...saga,
        status: "committed",
        candidateId: result.candidateId,
        evidenceId: result.evidenceId,
        updatedAt: saga.updatedAt,
        committedAt: saga.updatedAt,
        leaseOwner: null,
        leaseExpiresAt: null
      };
      stored.value = cloned(committed);
      return cloned({
        saga: committed,
        link: linked.link,
        created: linked.created
      });
    });
  }

  async linkEvent(
    input: LinkDouyinCommentEventInput
  ): ReturnType<AcquisitionDouyinCommentEventRepository["linkEvent"]> {
    if (!this.transactionContext.getStore()) {
      return this.transaction(() => this.linkEvent(input));
    }
    assertLinkDouyinCommentEventInput(input);
    if (!this.eventsById.has(entityKey(input.scope, input.eventId))) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_EVENT_NOT_FOUND");
    }
    const observation = this.observations.get(
      entityKey(input.scope, input.observationId)
    )?.value;
    if (!observation || observation.eventId !== input.eventId) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_OBSERVATION_NOT_FOUND");
    }
    const link: DouyinCommentEventLink = {
      linkId: deterministicLink(input),
      eventId: input.eventId,
      observationId: input.observationId,
      runId: input.runId,
      shardId: input.shardId,
      discoveryOperationId: input.discoveryOperationId,
      candidateId: input.candidateId,
      evidenceId: input.evidenceId
    };
    const key = entityKey(input.scope, link.linkId);
    const existing = this.links.get(key)?.value;
    if (existing && !same(existing, link)) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_LINK_ID_CONFLICT");
    }
    if (!existing) {
      this.links.set(key, { scope: cloned(input.scope), value: cloned(link) });
    }
    return cloned({ link: existing ?? link, created: !existing });
  }

  async startFetchAttempt(
    input: StartDouyinCommentFetchAttemptInput
  ): ReturnType<AcquisitionDouyinCommentEventRepository["startFetchAttempt"]> {
    if (!this.transactionContext.getStore()) {
      return this.transaction(() => this.startFetchAttempt(input));
    }
    assertStartDouyinCommentFetchAttemptInput(input);
    const attempt: DouyinCommentFetchAttempt = {
      attemptId: input.attemptId,
      runId: input.runId,
      shardId: input.shardId,
      discoveryOperationId: input.discoveryOperationId,
      sourceUrl: input.sourceUrl,
      videoId: input.videoId,
      status: "running",
      errorCode: null,
      requestedCount: input.requestedCount,
      returnedCount: 0,
      reportedCommentCount: null,
      pagesFetched: 0,
      startedAt: canonicalDouyinCommentInstant(input.startedAt),
      completedAt: null
    };
    const key = entityKey(input.scope, input.attemptId);
    const existing = this.attempts.get(key)?.value;
    if (existing) {
      const immutableReplay = existing.status === "running"
        ? existing
        : { ...existing, status: "running", errorCode: null,
            returnedCount: 0, reportedCommentCount: null, pagesFetched: 0,
            completedAt: null,
            terminalProjection: undefined } as DouyinCommentFetchAttempt;
      if (!same(immutableReplay, {
        ...attempt,
        startedAt: immutableReplay.startedAt
      })) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_FETCH_ATTEMPT_CONFLICT");
      }
      return cloned({ attempt: existing, created: false });
    }
    this.attempts.set(key, { scope: cloned(input.scope), value: cloned(attempt) });
    return cloned({ attempt, created: true });
  }

  async finishFetchAttempt(
    scope: AcquisitionScope,
    attemptId: string,
    terminal: FinishDouyinCommentFetchAttemptInput
  ): ReturnType<AcquisitionDouyinCommentEventRepository["finishFetchAttempt"]> {
    if (!this.transactionContext.getStore()) {
      return this.transaction(() => this.finishFetchAttempt(
        scope,
        attemptId,
        terminal
      ));
    }
    assertFinishDouyinCommentFetchAttemptInput(terminal);
    const normalizedTerminal = {
      ...terminal,
      completedAt: canonicalDouyinCommentInstant(terminal.completedAt)
    };
    const key = entityKey(scope, attemptId);
    const stored = this.attempts.get(key);
    if (!stored) throw new Error("ACQUISITION_DOUYIN_COMMENT_FETCH_ATTEMPT_NOT_FOUND");
    const finished: DouyinCommentFetchAttempt = {
      ...stored.value,
      ...normalizedTerminal
    };
    if (stored.value.status !== "running") {
      if (!same(stored.value, {
        ...finished,
        completedAt: stored.value.completedAt
      })) {
        throw new Error("ACQUISITION_DOUYIN_COMMENT_FETCH_ATTEMPT_CONFLICT");
      }
      return cloned(stored.value);
    }
    stored.value = cloned(finished);
    return cloned(finished);
  }

  async listRunCommentSignals(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    const limit = positiveLimit(options.limit);
    return this.runCommentSignals(scope, runId, limit);
  }

  async listRunCommentSignalsForPresentation(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    return this.runCommentSignals(
      scope,
      runId,
      presentationLimit(options.limit)
    );
  }

  private runCommentSignals(
    scope: AcquisitionScope,
    runId: string,
    limit: number
  ) {
    const scopedPrefix = `${scopeKey(scope)}\u0000`;
    const snapshots = [...this.links.entries()]
      .filter(([key, item]) => key.startsWith(scopedPrefix)
        && item.value.runId === runId)
      .flatMap(([, item]) => {
        const link = item.value;
        const event = this.eventsById.get(
          entityKey(scope, link.eventId)
        )?.value;
        const latestObservation = this.observations.get(
          entityKey(scope, link.observationId)
        )?.value;
        return event && latestObservation
          && latestObservation.eventId === event.eventId
          ? [{ event, latestObservation, link }]
          : [];
      })
      .sort((left, right) =>
        right.latestObservation.capturedAt.localeCompare(
          left.latestObservation.capturedAt
        )
        || right.latestObservation.observationId.localeCompare(
          left.latestObservation.observationId
        )
        || right.link.linkId.localeCompare(left.link.linkId));
    const seenEvents = new Set<string>();
    return snapshots
      .filter((snapshot) => {
        if (seenEvents.has(snapshot.event.eventId)) return false;
        seenEvents.add(snapshot.event.eventId);
        return true;
      })
      .slice(0, limit)
      .map(cloned);
  }

  async getRunCommentSummary(scope: AcquisitionScope, runId: string) {
    const runLinks = [...this.links.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => item.value);
    const linkedEventIds = new Set(runLinks.map((link) => link.eventId));
    const observationCount = new Set(
      runLinks.map((link) => link.observationId)
    ).size;
    const attempts = [...this.attempts.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => item.value);
    return {
      linkedEventCount: linkedEventIds.size,
      observationCount,
      fetchAttemptCount: attempts.length,
      discoveredVideoCount: new Set(attempts.map((attempt) =>
        attempt.videoId ?? attempt.sourceUrl
      )).size,
      returnedCommentCount: attempts.reduce(
        (total, attempt) => total + attempt.returnedCount,
        0
      ),
      validDemandSignalCount: new Set(runLinks.flatMap((link) =>
        link.candidateId ? [link.eventId] : []
      )).size,
      unresolvedActorCount: attempts.reduce(
        (total, attempt) =>
          total + (attempt.terminalProjection?.unresolvedActorCount ?? 0),
        0
      ),
      strongSignalCount: attempts.reduce(
        (total, attempt) =>
          total + (attempt.terminalProjection?.strongSignalCount ?? 0),
        0
      )
    };
  }

  async listFetchAttempts(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    const limit = positiveLimit(options.limit);
    return [...this.attempts.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => cloned(item.value))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.attemptId.localeCompare(right.attemptId))
      .slice(0, limit);
  }

  async getRunCommentPresentationProjection(
    scope: AcquisitionScope,
    runId: string
  ): Promise<DouyinRunCommentPresentationProjection> {
    const attempts = [...this.attempts.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => item.value)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.attemptId.localeCompare(right.attemptId));
    const candidateIds = [...new Set(attempts.flatMap((attempt) =>
      attempt.terminalProjection?.candidateIds ?? []
    ))].sort();
    if (candidateIds.length > 10_000) {
      throw new Error(
        "ACQUISITION_DOUYIN_COMMENT_PRESENTATION_FACT_LIMIT_EXCEEDED"
      );
    }
    const completed = attempts.flatMap((attempt) =>
      attempt.completedAt ? [attempt.completedAt] : []
    );
    const sagas = [...this.ingestionSagas.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => item.value);
    const links = [...this.links.values()]
      .filter((item) => same(item.scope, scope) && item.value.runId === runId)
      .map((item) => item.value);
    return cloned({
      fetchAttemptCount: attempts.length,
      discoveredVideoCount: new Set(attempts.map((attempt) =>
        attempt.videoId ?? attempt.sourceUrl
      )).size,
      returnedCommentCount: attempts.reduce(
        (total, attempt) => total + attempt.returnedCount,
        0
      ),
      resolvedVideoCount: new Set(attempts.flatMap((attempt) =>
        attempt.videoId ? [attempt.videoId] : []
      )).size,
      unresolvedVideoCount: attempts.filter((attempt) =>
        attempt.videoId === null
      ).length,
      runningAttemptCount: attempts.filter((attempt) =>
        attempt.status === "running"
      ).length,
      succeededAttemptCount: attempts.filter((attempt) =>
        attempt.status === "succeeded"
      ).length,
      partialSuccessAttemptCount: attempts.filter((attempt) =>
        attempt.status === "partial_success"
      ).length,
      failedAttemptCount: attempts.filter((attempt) =>
        attempt.status === "failed"
      ).length,
      noPublicCommentsAttemptCount: attempts.filter((attempt) =>
        attempt.status === "no_public_comments"
      ).length,
      attemptStartedAt: attempts.at(0)?.startedAt ?? null,
      attemptCompletedAt: attempts.length > 0
        && completed.length === attempts.length
        ? completed.sort().at(-1)!
        : null,
      terminalEventCount: attempts.reduce(
        (total, attempt) =>
          total + (attempt.terminalProjection?.eventCount ?? 0),
        0
      ),
      terminalEvidenceCount: attempts.reduce(
        (total, attempt) =>
          total + (attempt.terminalProjection?.evidenceCount ?? 0),
        0
      ),
      linkedEventCount: new Set(links.map((link) => link.eventId)).size,
      ingestionEventCount: new Set(sagas.map((saga) => saga.eventId)).size,
      pendingIngestionCount: sagas.filter((saga) =>
        saga.status !== "committed"
      ).length,
      errorCodes: [...new Set(attempts.flatMap((attempt) =>
        attempt.errorCode ? [attempt.errorCode] : []
      ))],
      candidateIds
    });
  }
}
