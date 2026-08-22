import {
  createAcquisitionDetailApi,
  type AcquisitionDetailApi,
  type AcquisitionPrivateDomainHandoffInput,
  type AcquisitionRunControlAction,
  type AcquisitionRunWithEtag,
  type AcquisitionTaskDetail,
  type AcquisitionContentFetchOperation,
  type CandidateDouyinIdentityResolutionOperation,
  type CandidateReviewAction
} from "./detail-center-api";
import {
  renderAcquisitionDetailCenter,
  type AcquisitionCandidateDetail,
  type AcquisitionDetailCenterMode,
  type AcquisitionDetailCenterState,
  type AcquisitionIdentityVerificationState
} from "./detail-center-view";
import {
  createVisualReaderController,
  type AuthorizedVisualReaderProjection,
  type VisualReaderController
} from "./visual-reader-controller";
import {
  createVisualReaderApi,
  VisualReaderApiError,
  type VisualReaderApi
} from "./visual-reader-api";
import type { VisualReaderBridge } from "./visual-reader-bridge";

export type AcquisitionCandidateReviewAction = CandidateReviewAction;

export interface AcquisitionDetailCenterControllerOptions {
  api?: AcquisitionDetailApi;
  eventTarget?: EventTarget;
  root?: HTMLElement | null;
  body?: HTMLElement | null;
  keyFactory?: () => string;
  confirm?: (message: string) => boolean;
  pollIntervalMs?: number;
  schedulePoll?: (callback: () => void, delay: number) => unknown;
  cancelPoll?: (handle: unknown) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  visualReaderApi?: VisualReaderApi;
  visualReaderBridgeFactory?: () => VisualReaderBridge;
  visualReaderController?: VisualReaderController;
  artifactDecoder?: (blob: Blob) => Promise<void>;
  artifactObjectUrl?: {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
  };
}

export interface AcquisitionDetailCenterController {
  getState(): Readonly<AcquisitionDetailCenterState>;
  whenIdle(): Promise<void>;
  open(mode: AcquisitionDetailCenterMode, planId: string): Promise<void>;
  openCandidate(candidateId: string): Promise<void>;
  close(): void;
  switchMode(mode: AcquisitionDetailCenterMode): void;
  selectCandidate(candidateId: string): Promise<void>;
  loadMoreCandidates(): Promise<void>;
  startRun(reason?: string): Promise<void>;
  controlRun(action: AcquisitionRunControlAction, reason: string): Promise<void>;
  reviewCandidate(
    action: AcquisitionCandidateReviewAction,
    reason?: string
  ): Promise<void>;
  fetchCandidateIdentityProfile(profileUrl: string, rationale?: string): Promise<void>;
  confirmCandidateIdentity(input: {
    profileUrl: string;
    rationale: string;
    evidenceIds: string[];
  }): Promise<void>;
  retryIdentityResolution(): Promise<void>;
  startIntelligence(): Promise<void>;
  openPrivateDomainHandoff(): void;
  closePrivateDomainHandoff(): void;
  handoffCandidate(
    input: Omit<
      AcquisitionPrivateDomainHandoffInput,
      "operationCode" | "runId" | "discoveredEventId" | "decisionVersion"
    >
  ): Promise<void>;
  destroy(): void;
}

interface MutationContext {
  serial: number;
  requestSerial: number;
  planId: string | null;
  candidateId: string;
  mode: AcquisitionDetailCenterMode;
}

interface RunMutationContext {
  serial: number;
  requestSerial: number;
  planId: string;
  runId: string | null;
  action: "start" | AcquisitionRunControlAction;
}

interface DetailOpenRequest {
  mode?: unknown;
  planId?: unknown;
  candidateId?: unknown;
}

function defaultEventTarget(): EventTarget {
  return typeof document === "undefined" ? new EventTarget() : document;
}

function requestedMode(value: unknown): AcquisitionDetailCenterMode | null {
  return value === "plan" || value === "candidates" ? value : null;
}

function requestedPlanId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requestedCandidateId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `acquisition-detail-${random ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function defaultConfirm(message: string): boolean {
  return typeof window === "undefined" ? true : window.confirm(message);
}

function defaultStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function customEvent<T>(name: string, detail: T): Event {
  if (typeof CustomEvent === "function") {
    return new CustomEvent<T>(name, { detail });
  }
  const event = new Event(name);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(record).filter(Boolean) as Array<Record<string, unknown>>;
  const container = record(value);
  const items = container?.items;
  return Array.isArray(items)
    ? items.map(record).filter(Boolean) as Array<Record<string, unknown>>
    : [];
}

function recordIdentity(
  value: Record<string, unknown>,
  preferredKeys: string[]
): string | null {
  for (const key of preferredKeys) {
    const identity = requestedPlanId(value[key]);
    if (identity) return `${key}:${identity}`;
  }
  return null;
}

function mergeRecordItems(
  current: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
  preferredKeys: string[]
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const indexes = new Map<string, number>();
  for (const item of [...current, ...incoming]) {
    const identity = recordIdentity(item, preferredKeys);
    if (!identity) {
      merged.push(item);
      continue;
    }
    const existingIndex = indexes.get(identity);
    if (existingIndex === undefined) {
      indexes.set(identity, merged.length);
      merged.push(item);
      continue;
    }
    merged[existingIndex] = {
      ...merged[existingIndex],
      ...item
    };
  }
  return merged;
}

/** Reconciles only server projections; IDs replace stale items and counters never increment locally. */
export function mergeRunPresentationProjection(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...current,
    ...incoming,
    automationSteps: mergeRecordItems(
      records(current.automationSteps),
      records(incoming.automationSteps),
      ["id"]
    ),
    commentSignals: mergeRecordItems(
      records(current.commentSignals),
      records(incoming.commentSignals),
      ["eventId"]
    ),
    summary: record(incoming.summary) ?? record(current.summary) ?? {}
  };
}

function mergePolledTaskDetail(
  current: AcquisitionTaskDetail | null,
  incoming: AcquisitionTaskDetail,
  preservePagination = false
): AcquisitionTaskDetail {
  if (!current || current.latestRun?.id !== incoming.latestRun?.id) return incoming;
  if (!incoming.presentation) {
    return {
      ...incoming,
      presentation: current.presentation
    };
  }
  if (!current.presentation) return incoming;
  return {
    ...incoming,
    presentation: {
      ...mergeRunPresentationProjection(current.presentation, incoming.presentation),
      candidateEvents: mergeRecordItems(
        current.presentation.candidateEvents,
        incoming.presentation.candidateEvents,
        ["candidateId", "eventId"]
      ),
      providers: mergeRecordItems(
        current.presentation.providers,
        incoming.presentation.providers,
        ["shardId", "connectionId", "providerId"]
      ),
      ...(preservePagination
        ? {
            hasMore: current.presentation.hasMore,
            nextAfter: current.presentation.nextAfter
          }
        : {})
    }
  };
}

function activeRun(detail: AcquisitionTaskDetail | null): boolean {
  return [
    "queued",
    "running",
    "pause_requested",
    "cancel_requested"
  ].includes(detail?.latestRun?.status ?? "");
}

function shouldPollRun(detail: AcquisitionTaskDetail | null): boolean {
  const visualStatus = detail?.presentation?.authorizedVisualReader?.status;
  return activeRun(detail)
    || detail?.presentation?.hasMore === true
    || visualStatus === "created"
    || visualStatus === "collecting";
}

function shouldPollSelectedCandidate(
  detail: AcquisitionCandidateDetail | null
): boolean {
  const identity = detail?.identityResolutionOperation;
  const intelligence = detail?.intelligenceOperation;
  if (identity?.status === "queued" || identity?.status === "running") {
    return true;
  }
  if (intelligence?.status === "queued" || intelligence?.status === "running") {
    return true;
  }
  return false;
}

const IDENTITY_HANDOFF_GRACE_POLLS = 3;
const IDENTITY_HANDOFF_LEDGER_LIMIT = 8;

interface IdentityHandoffScope {
  candidateId: string;
  identityOperationId: string;
  intelligenceOperationId: string;
  serverCompletedAtMs: number;
}

interface IdentityHandoffLedgerEntry extends IdentityHandoffScope {
  attempts: number;
  terminalIntelligenceObserved: boolean;
}

function identityHandoffScope(
  detail: AcquisitionCandidateDetail | null
): IdentityHandoffScope | null {
  const identity = detail?.identityResolutionOperation;
  if (identity?.status !== "succeeded"
    || identity.outcome !== "verified_consensus"
    || !identity.intelligenceOperationId) return null;
  const candidateId = requestedCandidateId(identity.candidateId)
    ?? requestedCandidateId(detail?.candidate?.id);
  const serverCompletedAtMs = Date.parse(
    identity.completedAt ?? identity.updatedAt
  );
  return candidateId && Number.isFinite(serverCompletedAtMs)
    ? {
        candidateId,
        identityOperationId: identity.id,
        intelligenceOperationId: identity.intelligenceOperationId,
        serverCompletedAtMs
      }
    : null;
}

function identityHandoffLedgerKey(scope: IdentityHandoffScope): string {
  return JSON.stringify([
    scope.candidateId,
    scope.identityOperationId,
    scope.intelligenceOperationId
  ]);
}

function runProgressFingerprint(detail: AcquisitionTaskDetail | null): string {
  return fingerprint({
    run: detail?.latestRun ?? null,
    shards: detail?.shards ?? [],
    summary: detail?.presentation?.summary ?? null,
    providers: detail?.presentation?.providers ?? [],
    authorizedVisualReader: detail?.presentation?.authorizedVisualReader ?? null
  });
}

function authorizedVisualReaderProjection(
  detail: AcquisitionTaskDetail | null
): AuthorizedVisualReaderProjection | undefined {
  return detail?.presentation?.authorizedVisualReader;
}

function taskDetailIsOlder(
  current: AcquisitionTaskDetail | null,
  incoming: AcquisitionTaskDetail
): boolean {
  const currentRun = current?.latestRun ?? null;
  const incomingRun = incoming.latestRun;
  if (!currentRun || !incomingRun || currentRun.id !== incomingRun.id) return false;
  const currentRecord = record(currentRun);
  const incomingRecord = record(incomingRun);
  const currentRevision = currentRecord?.revision;
  const incomingRevision = incomingRecord?.revision;
  if (typeof currentRevision === "number" && Number.isFinite(currentRevision)
    && typeof incomingRevision === "number" && Number.isFinite(incomingRevision)
    && currentRevision !== incomingRevision) {
    return incomingRevision < currentRevision;
  }
  const currentUpdatedAt = Date.parse(currentRun.updatedAt);
  const incomingUpdatedAt = Date.parse(incomingRun.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(incomingUpdatedAt)
    && currentUpdatedAt !== incomingUpdatedAt) {
    return incomingUpdatedAt < currentUpdatedAt;
  }
  return !activeRun(current) && activeRun(incoming);
}

function firstCandidateId(detail: unknown): string | null {
  const taskDetail = record(detail);
  const presentation = record(taskDetail?.presentation);
  for (const event of records(presentation?.candidateEvents)) {
    const eventCandidateId = requestedPlanId(event.candidateId);
    if (eventCandidateId) return eventCandidateId;
    const candidateId = requestedPlanId(record(event.candidate)?.id);
    if (candidateId) return candidateId;
  }
  return null;
}

function handoffAttributionSource(
  detail: AcquisitionTaskDetail | null,
  candidateId: string
) {
  const runId = requestedPlanId(detail?.latestRun?.id);
  if (!runId) return null;
  const event = records(detail?.presentation?.candidateEvents).find((item) =>
    requestedPlanId(item.candidateId) === candidateId
    || requestedPlanId(record(item.candidate)?.id) === candidateId);
  const discoveredEventId = requestedPlanId(event?.eventId)
    ?? requestedPlanId(event?.id);
  return discoveredEventId ? { runId, discoveredEventId } : null;
}

function storedHandoffRequest(value: unknown) {
  const request = record(value);
  if (!request) return null;
  const followUp = record(request?.followUp);
  const hasRunId = Object.prototype.hasOwnProperty.call(request, "runId");
  const hasDiscoveredEventId = Object.prototype.hasOwnProperty.call(
    request,
    "discoveredEventId"
  );
  const runId = requestedPlanId(request.runId);
  const discoveredEventId = requestedPlanId(request.discoveredEventId);
  const decisionVersion = requestedPlanId(request?.decisionVersion);
  const existingCustomerId = typeof request?.existingCustomerId === "string"
    ? request.existingCustomerId
    : null;
  const title = typeof followUp?.title === "string" ? followUp.title : null;
  const dueAt = typeof followUp?.dueAt === "string" ? followUp.dueAt : null;
  const priority = followUp?.priority;
  if (hasRunId !== hasDiscoveredEventId
    || (hasRunId && (!runId || !discoveredEventId))
    || request?.operationCode !== "handoff_acquisition_candidate_v1"
    || !decisionVersion
    || (request.mode !== "create_new" && request.mode !== "link_existing")
    || existingCustomerId === null
    || title === null
    || dueAt === null
    || (priority !== "high" && priority !== "medium" && priority !== "normal")) {
    return null;
  }
  return {
    operationCode: request.operationCode,
    ...(hasRunId
      ? { runId: runId!, discoveredEventId: discoveredEventId! }
      : {}),
    decisionVersion,
    mode: request.mode as "create_new" | "link_existing",
    existingCustomerId,
    followUp: {
      title,
      dueAt,
      priority: priority as "high" | "medium" | "normal"
    }
  };
}

function recoverableHandoffRequest(status: unknown) {
  const result = record(status);
  const inProgress = record(result?.inProgress);
  if (inProgress) return storedHandoffRequest(inProgress.request);
  const recovery = record(result?.recovery);
  return recovery ? storedHandoffRequest(recovery.request) : undefined;
}

interface ResourceLoad<T> {
  value: T;
  errors: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "请求失败";
}

const TERMINAL_CONTENT_FETCH_STATUSES = new Set([
  "succeeded",
  "failed",
  "access_restricted"
]);

function sleepWith(
  schedule: (callback: () => void, delay: number) => unknown,
  cancel: (handle: unknown) => void,
  delay: number
): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const handle = schedule(() => {
      resolved = true;
      resolve();
    }, delay);
    if (resolved) cancel(handle);
  });
}

function canonicalDouyinProfileUrl(value: string): string {
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("请填写有效的抖音公开主页 URL");
  }
  const hostname = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/u, "");
  if (url.protocol !== "https:"
    || (hostname !== "www.douyin.com" && hostname !== "douyin.com")
    || !path.startsWith("/user/")
    || path.length <= "/user/".length) {
    throw new Error("仅支持 HTTPS 的抖音 /user/ 精确公开主页");
  }
  url.hash = "";
  return url.toString();
}

function validIdentityRationale(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("请填写人工核验说明");
  if (normalized.length > 2_000) {
    throw new Error("人工核验说明不能超过 2000 个字符");
  }
  return normalized;
}

function validEvidenceIds(values: string[]): string[] {
  const normalized = [...new Set(values.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error("请至少选择一条公开主页证据");
  if (normalized.length > 100) throw new Error("公开主页证据不能超过 100 条");
  return normalized;
}

function candidateVersion(candidate: Record<string, unknown> | null | undefined): number {
  const version = candidate?.version;
  if (!Number.isSafeInteger(version) || Number(version) <= 0) {
    throw new Error("候选版本缺失，请刷新后重试");
  }
  return Number(version);
}

function unresolvedDouyinCandidate(
  candidate: Record<string, unknown> | null | undefined
): boolean {
  return candidate?.subjectKind === "individual"
    && candidate.identityResolved !== true
    && typeof candidate.sourcePlatform === "string"
    && candidate.sourcePlatform.toLowerCase().includes("douyin");
}

function identityStateForCandidate(
  candidate: Record<string, unknown> | null | undefined,
  previous?: AcquisitionIdentityVerificationState | null
): AcquisitionIdentityVerificationState | null {
  if (candidate?.subjectKind !== "individual"
    || typeof candidate.sourcePlatform !== "string"
    || !candidate.sourcePlatform.toLowerCase().includes("douyin")) {
    return null;
  }
  if (candidate.identityResolved === true) {
    return {
      status: "confirmed",
      profileUrl: typeof candidate.publicProfileUrl === "string"
        ? candidate.publicProfileUrl
        : previous?.profileUrl ?? "",
      rationale: previous?.rationale ?? "",
      evidenceIds: previous?.evidenceIds ?? [],
      operationId: previous?.operationId ?? null,
      message: "主体已确认",
      error: null
    };
  }
  return previous ?? {
    status: "idle",
    profileUrl: typeof candidate.publicProfileUrl === "string"
      ? candidate.publicProfileUrl
      : "",
    rationale: "已人工核对本次受控抓取的抖音公开主页，与候选需求主体一致。",
    evidenceIds: [],
    operationId: null,
    message: null,
    error: null
  };
}

async function loadResource<T>(
  label: string,
  load: () => Promise<T>,
  fallback: T
): Promise<ResourceLoad<T>> {
  try {
    return { value: await load(), errors: [] };
  } catch (error) {
    return { value: fallback, errors: [`${label}：${errorText(error)}`] };
  }
}

async function loadCursorPages(
  label: string,
  loadPage: (cursor?: string) => Promise<unknown>
): Promise<ResourceLoad<Array<Record<string, unknown>>>> {
  const items: Array<Record<string, unknown>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    let page: unknown;
    try {
      page = await loadPage(cursor);
    } catch (error) {
      return {
        value: items,
        errors: [`${label}：${errorText(error)}`]
      };
    }
    items.push(...records(page));
    const nextCursor = requestedPlanId(record(page)?.nextCursor);
    if (!nextCursor) return { value: items, errors: [] };
    if (seenCursors.has(nextCursor)) {
      return {
        value: items,
        errors: [`${label}：服务端返回重复分页游标，已停止继续读取`]
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function createAcquisitionDetailCenterController(
  options: AcquisitionDetailCenterControllerOptions = {}
): AcquisitionDetailCenterController {
  const api = options.api ?? createAcquisitionDetailApi();
  const eventTarget = options.eventTarget ?? defaultEventTarget();
  const keyFactory = options.keyFactory ?? defaultKey;
  const visualReaderApi = options.visualReaderApi ?? createVisualReaderApi();
  const visualReaderController = options.visualReaderController
    ?? createVisualReaderController({
      api: visualReaderApi,
      bridgeFactory: options.visualReaderBridgeFactory,
      keyFactory,
      onRequestPresentationRefresh: () => {
        if (!disposed && detailOpen && currentPlanId) {
          remember(pollRun(pollGeneration));
        }
      }
    });
  const storage = options.storage === undefined
    ? defaultStorage()
    : options.storage;
  const ask = options.confirm ?? defaultConfirm;
  const pollIntervalMs = typeof options.pollIntervalMs === "number"
    && Number.isFinite(options.pollIntervalMs)
    && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : 3_000;
  const schedulePoll = options.schedulePoll
    ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancelPoll = options.cancelPoll
    ?? ((handle: unknown) => globalThis.clearTimeout(
      handle as ReturnType<typeof globalThis.setTimeout>
    ));
  const pendingIdempotencyKeys = new Map<string, string>();
  const state: AcquisitionDetailCenterState = {
    mode: "plan",
    status: "ready",
    detail: null,
    selectedCandidateId: null,
    candidateDetail: null,
    message: null,
    error: null,
    loadingMoreCandidates: false,
    runControlBusy: false,
    runControlReason: "",
    handoffDialog: null,
    identityVerification: null,
    visualReader: visualReaderController.getState(),
    visualArtifact: null
  };
  let disposed = false;
  let requestSerial = 0;
  let candidateSerial = 0;
  let mutationSerial = 0;
  let runMutationSerial = 0;
  let pollGeneration = 0;
  let pollHandle: unknown = null;
  let hasPollHandle = false;
  let pollFailureCount = 0;
  let selectedCandidatePollGeneration = 0;
  let selectedCandidatePollHandle: unknown = null;
  let hasSelectedCandidatePollHandle = false;
  let selectedCandidatePollInFlightGeneration: number | null = null;
  let selectedCandidatePollFailureCount = 0;
  let selectedCandidatePollingEnabled = true;
  let detailOpen = false;
  const identityHandoffLedger = new Map<string, IdentityHandoffLedgerEntry>();
  let paginatedRunId: string | null = null;
  let expectedRunId: string | null = null;
  let currentPlanId: string | null = null;
  let mutating = false;
  let runMutating = false;
  let idlePromise = Promise.resolve();
  let root = options.root
    ?? (typeof document === "undefined"
      ? null
      : document.getElementById("replicaAcquisitionDetailCenter"));
  let body = options.body
    ?? (root?.querySelector<HTMLElement>("#replicaAcquisitionDetailCenterBody") ?? null);
  let returnFocus: { focus(): void } | null = null;
  let artifactLoadSerial = 0;
  const artifactObjectUrl = options.artifactObjectUrl ?? {
    createObjectURL(blob: Blob) {
      return globalThis.URL.createObjectURL(blob);
    },
    revokeObjectURL(url: string) {
      globalThis.URL.revokeObjectURL(url);
    }
  };
  const artifactDecoder = options.artifactDecoder ?? (async (blob: Blob) => {
    if (typeof globalThis.createImageBitmap !== "function") {
      throw new Error("浏览器缺少安全图像解码支持");
    }
    const bitmap = await globalThis.createImageBitmap(blob);
    try {
      if (bitmap.width < 1 || bitmap.height < 1) {
        throw new Error("服务端返回了无效的视觉读取制品");
      }
    } finally {
      bitmap.close();
    }
  });

  function render(): void {
    if (body) {
      body.innerHTML = renderAcquisitionDetailCenter(state);
    }
  }

  function releaseVisualArtifact(): void {
    artifactLoadSerial += 1;
    const objectUrl = state.visualArtifact?.objectUrl;
    if (objectUrl) artifactObjectUrl.revokeObjectURL(objectUrl);
    state.visualArtifact = null;
  }

  function evidenceAuthorizesArtifact(artifactId: string): boolean {
    return (state.candidateDetail?.evidence ?? []).some((item) => {
      const provenance = record(item.provenance);
      return provenance?.kind === "authorized_visual_observation"
        && provenance.artifactId === artifactId;
    });
  }

  async function viewVisualArtifact(artifactId: string): Promise<void> {
    const id = requestedPlanId(artifactId);
    if (!id || !evidenceAuthorizesArtifact(id)) return;
    releaseVisualArtifact();
    const serial = artifactLoadSerial;
    state.visualArtifact = {
      artifactId: id,
      status: "loading",
      objectUrl: null,
      message: null
    };
    render();
    try {
      const artifact = await visualReaderApi.getArtifact(id);
      if (disposed || serial !== artifactLoadSerial || !evidenceAuthorizesArtifact(id)) return;
      if (artifact.mediaType !== "image/webp") {
        throw new Error("服务端返回了无效的视觉读取制品");
      }
      const blob = new Blob(
        [artifact.content],
        { type: "image/webp" }
      );
      await artifactDecoder(blob);
      if (disposed || serial !== artifactLoadSerial || !evidenceAuthorizesArtifact(id)) return;
      const objectUrl = artifactObjectUrl.createObjectURL(blob);
      if (disposed || serial !== artifactLoadSerial || !evidenceAuthorizesArtifact(id)) {
        artifactObjectUrl.revokeObjectURL(objectUrl);
        return;
      }
      state.visualArtifact = {
        artifactId: id,
        status: "ready",
        objectUrl,
        message: null
      };
    } catch (error) {
      if (disposed || serial !== artifactLoadSerial) return;
      const expired = error instanceof VisualReaderApiError && error.status === 404;
      state.visualArtifact = {
        artifactId: id,
        status: expired ? "expired" : "error",
        objectUrl: null,
        message: expired
          ? "制品已到期，证据哈希仍保留"
          : "遮挡裁剪暂不可用，证据哈希仍保留"
      };
    }
    render();
  }

  function rejectValidation(message: string): Promise<never> {
    state.error = message;
    state.message = null;
    render();
    return Promise.reject(new Error(message));
  }

  function resolveDom(): void {
    if (typeof document === "undefined") return;
    root ??= document.getElementById("replicaAcquisitionDetailCenter");
    body ??= root?.querySelector<HTMLElement>("#replicaAcquisitionDetailCenterBody") ?? null;
  }

  function showRoot(): void {
    resolveDom();
    if (!root) return;
    const dialog = root as HTMLDialogElement;
    if (!dialog.open) {
      const activeElement = root.ownerDocument?.activeElement;
      returnFocus = activeElement && "focus" in activeElement
        ? activeElement as { focus(): void }
        : null;
    }
    root.hidden = false;
    root.classList.add("is-open");
    root.setAttribute("aria-hidden", "false");
    if (typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }
  }

  function finishClose(): void {
    if (root) {
      root.hidden = true;
      root.classList.remove("is-open");
      root.setAttribute("aria-hidden", "true");
    }
    const focus = returnFocus;
    returnFocus = null;
    focus?.focus();
  }

  function hideRoot(): void {
    if (!root) {
      finishClose();
      return;
    }
    const dialog = root as HTMLDialogElement;
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    }
    finishClose();
  }

  function stableKey(operation: string, payload: unknown): {
    id: string;
    value: string;
    storageKey?: string;
  } {
    const id = `${operation}:${fingerprint(payload)}`;
    const storageKey = `goodjob:acquisition-idempotency:${id}`;
    let value = pendingIdempotencyKeys.get(id)
      ?? (operation === "handoff-candidate"
        ? storage?.getItem(storageKey) ?? undefined
        : undefined);
    if (!value) {
      value = keyFactory();
      pendingIdempotencyKeys.set(id, value);
      if (operation === "handoff-candidate") {
        storage?.setItem(storageKey, value);
      }
    } else {
      pendingIdempotencyKeys.set(id, value);
    }
    return { id, value, storageKey } as {
      id: string;
      value: string;
      storageKey: string;
    };
  }

  function forgetStableKey(key: {
    id: string;
    storageKey?: string;
  }): void {
    pendingIdempotencyKeys.delete(key.id);
    if (key.storageKey) storage?.removeItem(key.storageKey);
  }

  function invalidateMutation(): void {
    mutationSerial += 1;
    mutating = false;
  }

  function invalidateRunMutation(): void {
    stopRunPolling();
    runMutationSerial += 1;
    runMutating = false;
    state.runControlBusy = false;
  }

  function stopRunPolling(): void {
    pollGeneration += 1;
    if (hasPollHandle) cancelPoll(pollHandle);
    pollHandle = null;
    hasPollHandle = false;
    pollFailureCount = 0;
  }

  function stopSelectedCandidatePolling(): void {
    selectedCandidatePollGeneration += 1;
    if (hasSelectedCandidatePollHandle) {
      cancelPoll(selectedCandidatePollHandle);
    }
    selectedCandidatePollHandle = null;
    hasSelectedCandidatePollHandle = false;
    selectedCandidatePollFailureCount = 0;
  }

  function clearCandidatePaginationBusy(): void {
    const wasLoadingMore = state.loadingMoreCandidates;
    state.loadingMoreCandidates = false;
    if (wasLoadingMore && state.message === "正在加载更多真实候选…") {
      state.message = null;
    }
  }

  function resetCandidateStateForRunChange(): void {
    stopSelectedCandidatePolling();
    paginatedRunId = null;
    candidateSerial += 1;
    state.selectedCandidateId = null;
    state.candidateDetail = null;
    state.identityVerification = null;
    clearCandidatePaginationBusy();
  }

  async function pollPresentationTail(
    generation: number,
    serial: number,
    planId: string
  ): Promise<"ok" | "stalled" | "failed"> {
    const stalledMessage = "候选分页游标未前进，已停止自动追踪；重新打开任务可重试";
    const detail = state.detail;
    const presentation = detail?.presentation;
    const runId = requestedPlanId(detail?.latestRun?.id);
    let cursor = requestedPlanId(presentation?.nextAfter);
    if (!detail || !presentation || !runId || !cursor
      || typeof api.getRunPresentation !== "function") return "ok";
    const visitedCursors = new Set<string>();
    try {
      while (cursor && !visitedCursors.has(cursor)) {
        visitedCursors.add(cursor);
        const nextPage = await api.getRunPresentation(runId, {
          after: cursor,
          limit: 100
        });
        if (disposed
          || generation !== pollGeneration
          || serial !== requestSerial
          || planId !== currentPlanId) return "ok";
        const currentDetail = state.detail;
        const currentPresentation = currentDetail?.presentation;
        if (!currentDetail || !currentPresentation
          || requestedPlanId(currentDetail.latestRun?.id) !== runId
          || requestedPlanId(currentPresentation.nextAfter) !== cursor) return "ok";
        const nextCursor: string = requestedPlanId(nextPage.nextAfter) ?? cursor;
        const stalled = nextPage.hasMore && nextCursor === cursor;
        state.detail = {
          ...currentDetail,
          presentation: {
            ...mergeRunPresentationProjection(
              currentPresentation,
              nextPage as unknown as Record<string, unknown>
            ),
            candidateEvents: mergeRecordItems(
              currentPresentation.candidateEvents,
              nextPage.candidateEvents.map((event) => ({ ...event })),
              ["candidateId", "eventId"]
            ),
            providers: mergeRecordItems(
              currentPresentation.providers,
              nextPage.providers.map((provider) => ({ ...provider })),
              ["shardId", "connectionId", "providerId"]
            ),
            summary: { ...nextPage.summary },
            hasMore: stalled ? false : nextPage.hasMore,
            nextAfter: nextCursor
          }
        };
        paginatedRunId = runId;
        if (stalled) {
          state.error = stalledMessage;
          return "stalled";
        }
        if (!nextPage.hasMore) {
          if (state.error === stalledMessage) state.error = null;
          return "ok";
        }
        cursor = nextCursor;
      }
    } catch {
      // The task snapshot remains usable; the tail is retried on the next poll.
      return "failed";
    }
    return "ok";
  }

  function ensureRunPolling(): void {
    if (disposed || hasPollHandle || !currentPlanId || !shouldPollRun(state.detail)) return;
    const generation = pollGeneration;
    const delay = Math.min(
      30_000,
      pollIntervalMs * (2 ** Math.min(pollFailureCount, 10))
    );
    hasPollHandle = true;
    pollHandle = schedulePoll(() => {
      hasPollHandle = false;
      pollHandle = null;
      remember(pollRun(generation));
    }, delay);
  }

  async function pollRun(generation: number): Promise<void> {
    const planId = currentPlanId;
    const serial = requestSerial;
    if (disposed || !planId || generation !== pollGeneration) return;
    try {
      const incoming = await api.getTask(planId);
      if (disposed
        || generation !== pollGeneration
        || serial !== requestSerial
        || planId !== currentPlanId) return;
      const incomingRunId = requestedPlanId(incoming.latestRun?.id);
      if (expectedRunId && incomingRunId !== expectedRunId) {
        pollFailureCount = 0;
        if (shouldPollRun(state.detail)) ensureRunPolling();
        return;
      }
      if (expectedRunId === incomingRunId) expectedRunId = null;
      if (taskDetailIsOlder(state.detail, incoming)) {
        pollFailureCount = 0;
        if (shouldPollRun(state.detail)) ensureRunPolling();
        return;
      }
      const before = runProgressFingerprint(state.detail);
      const currentRunId = requestedPlanId(state.detail?.latestRun?.id);
      const runChanged = currentRunId !== incomingRunId;
      state.detail = mergePolledTaskDetail(
        state.detail,
        incoming,
        !runChanged && paginatedRunId === currentRunId
      );
      if (runChanged) {
        resetCandidateStateForRunChange();
      }
      const tailResult = await pollPresentationTail(generation, serial, planId);
      if (disposed
        || generation !== pollGeneration
        || serial !== requestSerial
        || planId !== currentPlanId) return;
      pollFailureCount = tailResult === "ok"
        ? 0
        : Math.min(pollFailureCount + 1, 10);
      state.status = "ready";
      await visualReaderController.reconcile(
        authorizedVisualReaderProjection(state.detail)
      ).catch(() => undefined);
      render();
      if (before !== runProgressFingerprint(state.detail)) {
        eventTarget.dispatchEvent(customEvent(
          "goodjob:acquisition-refresh-requested",
          {
            planId,
            action: "poll",
            runId: state.detail.latestRun?.id ?? null,
            status: state.detail.latestRun?.status ?? null
          }
        ));
      }
    } catch {
      if (disposed
        || generation !== pollGeneration
        || serial !== requestSerial
        || planId !== currentPlanId) return;
      pollFailureCount = Math.min(pollFailureCount + 1, 10);
    }
    if (generation !== pollGeneration) return;
    if (shouldPollRun(state.detail)) ensureRunPolling();
  }

  function beginMutation(candidateId: string): MutationContext {
    mutating = true;
    return {
      serial: ++mutationSerial,
      requestSerial,
      planId: currentPlanId,
      candidateId,
      mode: state.mode
    };
  }

  function mutationIsCurrent(context: MutationContext): boolean {
    return !disposed
      && context.serial === mutationSerial
      && context.requestSerial === requestSerial
      && context.planId === currentPlanId
      && context.candidateId === state.selectedCandidateId
      && context.mode === state.mode;
  }

  function beginRunMutation(
    planId: string,
    action: RunMutationContext["action"],
    runId: string | null
  ): RunMutationContext {
    stopRunPolling();
    runMutating = true;
    state.runControlBusy = true;
    return {
      serial: ++runMutationSerial,
      requestSerial,
      planId,
      runId,
      action
    };
  }

  function runMutationIsCurrent(context: RunMutationContext): boolean {
    return !disposed
      && context.serial === runMutationSerial
      && context.requestSerial === requestSerial
      && context.planId === currentPlanId;
  }

  function applyRunResult(result: AcquisitionRunWithEtag): void {
    if (!state.detail) return;
    const run = result.run;
    const runChanged = state.detail.latestRun?.id !== run.id;
    if (runChanged) {
      resetCandidateStateForRunChange();
      expectedRunId = run.id;
    }
    state.detail = {
      ...state.detail,
      latestRun: {
        id: run.id,
        status: run.status,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
        evidenceCount: run.evidenceCount,
        consumedBudget: { ...run.consumedBudget },
        etag: result.etag ?? run.etag,
        planVersion: run.planVersion,
        revision: run.revision,
        budgetSnapshot: { ...run.budgetSnapshot },
        modelSnapshotRef: { ...run.modelSnapshotRef }
      },
      ...(runChanged ? { shards: [], presentation: null } : {})
    };
  }

  async function refreshAfterRunMutation(
    context: RunMutationContext,
    result: AcquisitionRunWithEtag,
    completedMessage: string
  ): Promise<void> {
    if (!runMutationIsCurrent(context)) return;
    state.runControlReason = "";
    applyRunResult(result);
    state.error = null;
    state.message = `${completedMessage}，正在刷新任务状态…`;
    render();
    const eventDetail = {
      planId: context.planId,
      action: context.action,
      runId: result.run.id
    };
    eventTarget.dispatchEvent(customEvent(
      "goodjob:acquisition-refresh-requested",
      eventDetail
    ));
    eventTarget.dispatchEvent(customEvent(
      "goodjob:acquisition-notify",
      { message: completedMessage }
    ));
    try {
      const detail = await api.getTask(context.planId);
      if (!runMutationIsCurrent(context)) return;
      const currentRunId = requestedPlanId(state.detail?.latestRun?.id);
      const incomingRunId = requestedPlanId(detail.latestRun?.id);
      if (incomingRunId !== result.run.id) {
        state.message = completedMessage;
        state.error = `${completedMessage}，但任务详情仍在同步，请稍后刷新`;
        render();
        ensureRunPolling();
        return;
      }
      expectedRunId = null;
      const runChanged = currentRunId !== incomingRunId;
      if (!taskDetailIsOlder(state.detail, detail)) {
        state.detail = mergePolledTaskDetail(
          state.detail,
          detail,
          !runChanged && paginatedRunId === currentRunId
        );
        if (runChanged) paginatedRunId = null;
      }
      state.message = completedMessage;
      state.error = null;
    } catch (error) {
      if (!runMutationIsCurrent(context)) return;
      state.message = completedMessage;
      state.error = `${completedMessage}，但详情刷新失败：${errorText(error)}`;
    }
    render();
    ensureRunPolling();
  }

  const candidateSnapshotMetadata = new WeakMap<
    AcquisitionCandidateDetail,
    {
      errors: string[];
      failedFields: Set<keyof AcquisitionCandidateDetail>;
    }
  >();

  async function readCandidateSnapshot(
    candidateId: string
  ): Promise<AcquisitionCandidateDetail> {
    const [candidateResult, evidenceResult, qualificationResult,
      financialResult, battleCardResult, reviewsResult, identityResult,
      operationResult, handoffResult] =
      await Promise.all([
        loadResource(
          "候选基本信息",
          () => api.getCandidate(candidateId),
          null
        ),
        loadCursorPages("公开证据", (cursor) => api.getCandidateEvidence(candidateId, {
          ...(cursor ? { cursor } : {}),
          limit: 100
        })),
        loadResource(
          "资格研判",
          () => api.getCandidateQualification(candidateId),
          null
        ),
        loadResource(
          "财务价值",
          () => api.getCandidateFinancialValue(candidateId),
          null
        ),
        loadResource(
          "客户作战卡",
          () => api.getCandidateBattleCard(candidateId),
          null
        ),
        loadCursorPages("审核记录", (cursor) => api.getCandidateReviews(candidateId, {
          ...(cursor ? { cursor } : {}),
          limit: 100
        })),
        loadResource<CandidateDouyinIdentityResolutionOperation | null>(
          "自动主体核验",
          () => typeof api.getLatestDouyinIdentityResolutionOperation === "function"
            ? api.getLatestDouyinIdentityResolutionOperation(candidateId)
            : Promise.resolve(null),
          null
        ),
        loadResource(
          "AI 研判任务",
          () => api.getLatestIntelligenceOperation(candidateId),
          null
        ),
        loadResource(
          "CRM/私域交接",
          () => typeof api.getCandidatePrivateDomainHandoff === "function"
            ? api.getCandidatePrivateDomainHandoff(candidateId)
            : Promise.resolve(null),
          null
        )
      ]);
    const candidateContainer = record(candidateResult.value);
    const snapshot: AcquisitionCandidateDetail = {
      candidate: record(candidateContainer?.candidate),
      evidence: evidenceResult.value,
      qualification: record(qualificationResult.value),
      financialValue: record(financialResult.value),
      battleCard: record(battleCardResult.value),
      reviews: reviewsResult.value,
      intelligenceOperation: record(operationResult.value),
      identityResolutionOperation: identityResult.value,
      privateDomainHandoff: handoffResult.value
    };
    const failures = [
      ...candidateResult.errors,
      ...evidenceResult.errors,
      ...qualificationResult.errors,
      ...financialResult.errors,
      ...battleCardResult.errors,
      ...reviewsResult.errors,
      ...identityResult.errors,
      ...operationResult.errors,
      ...handoffResult.errors
    ];
    const failedFields = new Set<keyof AcquisitionCandidateDetail>();
    if (candidateResult.errors.length > 0) failedFields.add("candidate");
    if (evidenceResult.errors.length > 0) failedFields.add("evidence");
    if (qualificationResult.errors.length > 0) {
      failedFields.add("qualification");
    }
    if (financialResult.errors.length > 0) failedFields.add("financialValue");
    if (battleCardResult.errors.length > 0) failedFields.add("battleCard");
    if (reviewsResult.errors.length > 0) failedFields.add("reviews");
    if (identityResult.errors.length > 0) {
      failedFields.add("identityResolutionOperation");
    }
    if (operationResult.errors.length > 0) {
      failedFields.add("intelligenceOperation");
    }
    if (handoffResult.errors.length > 0) {
      failedFields.add("privateDomainHandoff");
    }
    candidateSnapshotMetadata.set(snapshot, { errors: failures, failedFields });
    return snapshot;
  }

  function pollingWarning(current: string | null, errors: string[]): string {
    const newErrors = errors.filter((error) => !current?.includes(error));
    if (newErrors.length === 0) return current ?? "";
    const warning = `后台候选资料刷新部分失败：${newErrors.join("；")}`;
    return current ? `${current}；${warning}` : warning;
  }

  async function applyCandidateSnapshot(
    candidateId: string,
    requestSerialForCandidate: number,
    applies: () => boolean = () => true,
    silent = false
  ): Promise<void> {
    const snapshot = await readCandidateSnapshot(candidateId);
    if (disposed
      || requestSerialForCandidate !== candidateSerial
      || candidateId !== state.selectedCandidateId
      || !applies()) return;
    const metadata = candidateSnapshotMetadata.get(snapshot) ?? {
      errors: [],
      failedFields: new Set<keyof AcquisitionCandidateDetail>()
    };
    const previous = state.candidateDetail;
    const nextSnapshot = silent && previous
      ? {
          candidate: metadata.failedFields.has("candidate")
            ? previous.candidate
            : snapshot.candidate,
          evidence: metadata.failedFields.has("evidence")
            ? previous.evidence
            : snapshot.evidence,
          qualification: metadata.failedFields.has("qualification")
            ? previous.qualification
            : snapshot.qualification,
          financialValue: metadata.failedFields.has("financialValue")
            ? previous.financialValue
            : snapshot.financialValue,
          battleCard: metadata.failedFields.has("battleCard")
            ? previous.battleCard
            : snapshot.battleCard,
          reviews: metadata.failedFields.has("reviews")
            ? previous.reviews
            : snapshot.reviews,
          intelligenceOperation: metadata.failedFields.has("intelligenceOperation")
            ? previous.intelligenceOperation
            : snapshot.intelligenceOperation,
          identityResolutionOperation: metadata.failedFields.has(
            "identityResolutionOperation"
          )
            ? previous.identityResolutionOperation
            : snapshot.identityResolutionOperation,
          privateDomainHandoff: metadata.failedFields.has("privateDomainHandoff")
            ? previous.privateDomainHandoff
            : snapshot.privateDomainHandoff
        }
      : snapshot;
    state.candidateDetail = nextSnapshot;
    if (state.visualArtifact && !evidenceAuthorizesArtifact(
      state.visualArtifact.artifactId
    )) {
      releaseVisualArtifact();
    }
    state.identityVerification = identityStateForCandidate(
      nextSnapshot.candidate,
      state.identityVerification
    );
    if (silent) {
      const coreOperationFailed = metadata.failedFields.has(
        "identityResolutionOperation"
      ) || metadata.failedFields.has("intelligenceOperation");
      selectedCandidatePollFailureCount = coreOperationFailed
        ? Math.min(selectedCandidatePollFailureCount + 1, 10)
        : 0;
      if (metadata.errors.length > 0) {
        state.error = pollingWarning(state.error, metadata.errors);
      }
      return;
    }
    if (metadata.errors.length === 0) {
      state.message = null;
      state.error = null;
      state.loadingMoreCandidates = false;
    } else {
      state.message = "部分资料暂不可用，已保留成功加载的数据";
      state.error = `部分候选资料加载失败：${metadata.errors.join("；")}`;
    }
  }

  function shouldContinueSelectedCandidatePolling(
    detail: AcquisitionCandidateDetail | null
  ): boolean {
    const handoff = identityHandoffScope(detail);
    if (handoff) {
      const key = identityHandoffLedgerKey(handoff);
      let entry = identityHandoffLedger.get(key);
      if (!entry) {
        entry = {
          ...handoff,
          attempts: 0,
          terminalIntelligenceObserved: false
        };
        identityHandoffLedger.set(key, entry);
        if (identityHandoffLedger.size > IDENTITY_HANDOFF_LEDGER_LIMIT) {
          const oldestKey = identityHandoffLedger.keys().next().value;
          if (typeof oldestKey === "string") {
            identityHandoffLedger.delete(oldestKey);
          }
        }
      }
      const intelligence = detail?.intelligenceOperation;
      const intelligenceMatches = requestedPlanId(intelligence?.id)
        === handoff.intelligenceOperationId;
      const intelligenceStatus = intelligenceMatches
        ? intelligence?.status
        : null;
      if (intelligenceStatus === "succeeded" || intelligenceStatus === "failed") {
        entry.terminalIntelligenceObserved = true;
        return false;
      }
      if (entry.terminalIntelligenceObserved) return false;
      if (intelligenceStatus === "queued" || intelligenceStatus === "running") {
        return true;
      }
      return entry.attempts < IDENTITY_HANDOFF_GRACE_POLLS;
    }
    return shouldPollSelectedCandidate(detail);
  }

  function recordIdentityHandoffGraceAttempt(): void {
    const handoff = identityHandoffScope(state.candidateDetail);
    if (!handoff) return;
    const intelligenceId = requestedPlanId(
      state.candidateDetail?.intelligenceOperation?.id
    );
    if (intelligenceId === handoff.intelligenceOperationId) return;
    const entry = identityHandoffLedger.get(identityHandoffLedgerKey(handoff));
    if (entry
      && !entry.terminalIntelligenceObserved
      && entry.attempts < IDENTITY_HANDOFF_GRACE_POLLS) {
      entry.attempts += 1;
    }
  }

  function ensureSelectedCandidatePolling(): void {
    const candidateId = state.selectedCandidateId;
    if (disposed
      || !detailOpen
      || !selectedCandidatePollingEnabled
      || hasSelectedCandidatePollHandle
      || selectedCandidatePollInFlightGeneration
        === selectedCandidatePollGeneration
      || !candidateId
      || !shouldContinueSelectedCandidatePolling(state.candidateDetail)) return;
    const generation = selectedCandidatePollGeneration;
    const baseDelay = Math.max(2_000, pollIntervalMs);
    const handoff = identityHandoffScope(state.candidateDetail);
    const handoffAttempts = handoff
      ? identityHandoffLedger.get(identityHandoffLedgerKey(handoff))?.attempts ?? 0
      : 0;
    const delayExponent = Math.max(
      selectedCandidatePollFailureCount,
      handoffAttempts
    );
    const delay = Math.min(
      30_000,
      baseDelay * (2 ** Math.min(delayExponent, 10))
    );
    hasSelectedCandidatePollHandle = true;
    selectedCandidatePollHandle = schedulePoll(() => {
      hasSelectedCandidatePollHandle = false;
      selectedCandidatePollHandle = null;
      remember(pollSelectedCandidate(generation, candidateId));
    }, delay);
  }

  async function pollSelectedCandidate(
    generation: number,
    candidateId: string
  ): Promise<void> {
    if (disposed
      || !detailOpen
      || !selectedCandidatePollingEnabled
      || generation !== selectedCandidatePollGeneration
      || candidateId !== state.selectedCandidateId) return;
    selectedCandidatePollInFlightGeneration = generation;
    try {
      recordIdentityHandoffGraceAttempt();
      const serial = ++candidateSerial;
      try {
        await applyCandidateSnapshot(
          candidateId,
          serial,
          () => generation === selectedCandidatePollGeneration
            && candidateId === state.selectedCandidateId,
          true
        );
        if (disposed
          || !detailOpen
          || !selectedCandidatePollingEnabled
          || generation !== selectedCandidatePollGeneration
          || candidateId !== state.selectedCandidateId) return;
        render();
      } catch {
        if (disposed
          || !detailOpen
          || !selectedCandidatePollingEnabled
          || generation !== selectedCandidatePollGeneration
          || candidateId !== state.selectedCandidateId) return;
        selectedCandidatePollFailureCount = Math.min(
          selectedCandidatePollFailureCount + 1,
          10
        );
      }
    } finally {
      if (selectedCandidatePollInFlightGeneration === generation) {
        selectedCandidatePollInFlightGeneration = null;
      }
    }
    if (disposed
      || !detailOpen
      || !selectedCandidatePollingEnabled
      || generation !== selectedCandidatePollGeneration
      || candidateId !== state.selectedCandidateId) return;
    if (shouldContinueSelectedCandidatePolling(state.candidateDetail)) {
      ensureSelectedCandidatePolling();
    }
  }

  async function refreshAfterMutation(
    context: MutationContext,
    progressMessage: string,
    completedMessage: string
  ): Promise<void> {
    if (!mutationIsCurrent(context)) return;
    const taskSerial = requestSerial;
    const refreshSerial = ++candidateSerial;
    state.error = null;
    state.message = progressMessage;
    render();
    const taskPromise = context.planId
      ? api.getTask(context.planId)
      : Promise.resolve(null);
    const [detail] = await Promise.all([
      taskPromise,
      applyCandidateSnapshot(
        context.candidateId,
        refreshSerial,
        () => mutationIsCurrent(context)
      )
    ]);
    if (!mutationIsCurrent(context)
      || taskSerial !== requestSerial
      || refreshSerial !== candidateSerial) return;
    if (detail && !taskDetailIsOlder(state.detail, detail)) {
      const currentRunId = requestedPlanId(state.detail?.latestRun?.id);
      const incomingRunId = requestedPlanId(detail.latestRun?.id);
      const runChanged = currentRunId !== incomingRunId;
      state.detail = mergePolledTaskDetail(
        state.detail,
        detail,
        !runChanged && paginatedRunId === currentRunId
      );
      if (runChanged) paginatedRunId = null;
    }
    state.message = state.error
      ? `${completedMessage}，部分资料刷新失败`
      : completedMessage;
    render();
    ensureSelectedCandidatePolling();
  }

  function remember<T>(promise: Promise<T>): Promise<T> {
    idlePromise = promise.then(() => undefined, () => undefined);
    return promise;
  }

  async function waitForContentFetchOperation(
    operation: AcquisitionContentFetchOperation,
    context: MutationContext
  ): Promise<AcquisitionContentFetchOperation | null> {
    let current = operation;
    while (!TERMINAL_CONTENT_FETCH_STATUSES.has(current.status)) {
      await sleepWith(schedulePoll, cancelPoll, pollIntervalMs);
      if (!mutationIsCurrent(context)) return null;
      current = await api.getContentFetchOperation(current.id);
    }
    return mutationIsCurrent(context) ? current : null;
  }

  const controller: AcquisitionDetailCenterController = {
    getState() {
      return state;
    },

    whenIdle() {
      return idlePromise;
    },

    open(mode, planId) {
      releaseVisualArtifact();
      invalidateMutation();
      invalidateRunMutation();
      stopSelectedCandidatePolling();
      clearCandidatePaginationBusy();
      const serial = ++requestSerial;
      currentPlanId = planId;
      paginatedRunId = null;
      expectedRunId = null;
      detailOpen = true;
      showRoot();
      state.mode = mode;
      state.status = "loading";
      state.detail = null;
      state.selectedCandidateId = null;
      state.candidateDetail = null;
      state.identityVerification = null;
      state.message = null;
      state.error = null;
      state.runControlReason = "";
      state.handoffDialog = null;
      candidateSerial += 1;
      render();
      return remember((async () => {
        try {
          const detail = await api.getTask(planId);
          if (disposed || serial !== requestSerial) return;
          state.detail = detail;
          state.status = "ready";
          await visualReaderController.open({
            planId,
            runId: requestedPlanId(detail.latestRun?.id),
            projection: authorizedVisualReaderProjection(detail)
          }).catch(() => undefined);
          if (disposed || serial !== requestSerial) return;
          ensureRunPolling();
          if (state.mode === "candidates" && !state.selectedCandidateId) {
            const candidateId = firstCandidateId(detail);
            if (candidateId) {
              await controller.selectCandidate(candidateId);
              return;
            }
          }
        } catch (error) {
          if (disposed || serial !== requestSerial) return;
          state.status = "error";
          state.error = error instanceof Error ? error.message : "任务详情加载失败";
          render();
          throw error;
        }
        render();
      })());
    },

    openCandidate(candidateId) {
      const id = requestedCandidateId(candidateId);
      if (!id) return rejectValidation("候选 ID 不能为空");
      releaseVisualArtifact();
      invalidateMutation();
      invalidateRunMutation();
      stopSelectedCandidatePolling();
      clearCandidatePaginationBusy();
      requestSerial += 1;
      currentPlanId = null;
      paginatedRunId = null;
      expectedRunId = null;
      detailOpen = true;
      visualReaderController.close();
      showRoot();
      state.mode = "candidates";
      state.status = "ready";
      state.detail = null;
      state.selectedCandidateId = null;
      state.candidateDetail = null;
      state.identityVerification = null;
      state.message = null;
      state.error = null;
      state.runControlReason = "";
      state.handoffDialog = null;
      candidateSerial += 1;
      render();
      return controller.selectCandidate(id);
    },

    close() {
      releaseVisualArtifact();
      detailOpen = false;
      visualReaderController.close();
      invalidateMutation();
      invalidateRunMutation();
      stopSelectedCandidatePolling();
      clearCandidatePaginationBusy();
      requestSerial += 1;
      candidateSerial += 1;
      paginatedRunId = null;
      expectedRunId = null;
      state.identityVerification = null;
      hideRoot();
    },

    switchMode(mode) {
      invalidateMutation();
      state.mode = mode;
      state.error = null;
      state.message = null;
      state.handoffDialog = null;
      if (mode === "candidates" && !state.selectedCandidateId) {
        const candidateId = firstCandidateId(state.detail);
        if (candidateId) {
          void controller.selectCandidate(candidateId).catch(() => undefined);
          return;
        }
      }
      render();
    },

    selectCandidate(candidateId) {
      const id = requestedPlanId(candidateId);
      if (!id) return rejectValidation("候选 ID 不能为空");
      releaseVisualArtifact();
      invalidateMutation();
      stopSelectedCandidatePolling();
      const serial = ++candidateSerial;
      state.selectedCandidateId = id;
      state.candidateDetail = null;
      state.identityVerification = null;
      state.handoffDialog = null;
      state.error = null;
      state.message = "正在读取候选证据与 AI 研判…";
      render();
      return remember((async () => {
        try {
          await applyCandidateSnapshot(id, serial);
        } catch (error) {
          if (disposed || serial !== candidateSerial) return;
          state.candidateDetail = null;
          state.message = null;
          state.error = error instanceof Error ? error.message : "候选研判读取失败";
          render();
          throw error;
        }
        render();
        ensureSelectedCandidatePolling();
      })());
    },

    loadMoreCandidates() {
      const detail = state.detail;
      const presentation = detail?.presentation;
      const runId = requestedPlanId(detail?.latestRun?.id);
      const cursor = requestedPlanId(presentation?.nextAfter);
      if (!detail || !presentation || presentation.hasMore !== true || !runId || !cursor) {
        return rejectValidation("当前没有更多候选可加载");
      }
      if (state.loadingMoreCandidates) {
        return rejectValidation("更多候选正在加载");
      }
      const serial = requestSerial;
      const planId = currentPlanId;
      state.loadingMoreCandidates = true;
      state.error = null;
      state.message = "正在加载更多真实候选…";
      render();
      return remember((async () => {
        try {
          const nextPage = await api.getRunPresentation(runId, {
            after: cursor,
            limit: 100
          });
          if (disposed || serial !== requestSerial || planId !== currentPlanId) return;
          const currentDetail = state.detail;
          const currentPresentation = currentDetail?.presentation;
          if (!currentDetail || !currentPresentation
            || requestedPlanId(currentDetail.latestRun?.id) !== runId
            || requestedPlanId(currentPresentation.nextAfter) !== cursor) {
            clearCandidatePaginationBusy();
            render();
            return;
          }

          const eventKeys = new Set<string>();
          const mergedEvents = [
            ...currentPresentation.candidateEvents,
            ...nextPage.candidateEvents.map((event) => ({ ...event }))
          ].filter((event) => {
            const key = requestedPlanId(event.candidateId)
              ?? requestedPlanId(event.eventId);
            if (!key) return true;
            if (eventKeys.has(key)) return false;
            eventKeys.add(key);
            return true;
          });
          const providerKeys = new Set<string>();
          const mergedProviders = [
            ...currentPresentation.providers,
            ...nextPage.providers.map((provider) => ({ ...provider }))
          ].filter((provider) => {
            const key = requestedPlanId(provider.shardId)
              ?? `${String(provider.connectionId ?? "")}:${String(provider.providerId ?? "")}`;
            if (providerKeys.has(key)) return false;
            providerKeys.add(key);
            return true;
          });
          const repeatedCursor = nextPage.hasMore && nextPage.nextAfter === cursor;
          state.detail = {
            ...currentDetail,
            presentation: {
              ...mergeRunPresentationProjection(
                currentPresentation,
                nextPage as unknown as Record<string, unknown>
              ),
              candidateEvents: mergedEvents,
              providers: mergedProviders,
              hasMore: repeatedCursor ? false : nextPage.hasMore,
              nextAfter: repeatedCursor ? null : nextPage.nextAfter
            }
          };
          paginatedRunId = runId;
          state.loadingMoreCandidates = false;
          state.message = repeatedCursor
            ? "已加载可用候选；服务端分页游标未前进，已停止继续加载"
            : `已加载 ${nextPage.candidateEvents.length} 条更多候选`;
          state.error = repeatedCursor
            ? "候选分页游标重复，已停止继续读取以避免循环请求"
            : null;
          render();
        } catch (error) {
          if (disposed || serial !== requestSerial || planId !== currentPlanId) return;
          state.loadingMoreCandidates = false;
          state.message = null;
          state.error = error instanceof Error ? error.message : "更多候选加载失败";
          render();
          throw error;
        }
      })());
    },

    startRun(reason) {
      const detail = state.detail;
      const planId = currentPlanId;
      const planStatus = requestedPlanId(detail?.plan.status);
      const latestRun = detail?.latestRun ?? null;
      const latestStatus = latestRun?.status ?? null;
      const normalizedReason = (
        reason === undefined ? state.runControlReason ?? "" : reason
      ).trim();
      const planVersion = typeof detail?.plan.version === "number"
        && Number.isFinite(detail.plan.version)
        ? detail.plan.version
        : null;
      const runPlanVersion = typeof latestRun?.planVersion === "number"
        && Number.isFinite(latestRun.planVersion)
        ? latestRun.planVersion
        : null;
      const isBudgetContinuation = latestStatus === "budget_exhausted"
        && planVersion !== null
        && runPlanVersion !== null
        && planVersion > runPlanVersion;
      const restartableStatuses = new Set([
        "cancelled",
        "succeeded",
        "succeeded_empty",
        "partial_success",
        "failed"
      ]);
      if (!detail || !planId) {
        return rejectValidation("请先打开一个获客计划");
      }
      if (planStatus !== "approved") {
        return rejectValidation("只有已人工审批的计划可以启动运行");
      }
      if (latestStatus === "budget_exhausted" && !isBudgetContinuation) {
        return rejectValidation("预算已用完，请先调整预算并重新审批后再续跑");
      }
      if (latestStatus !== null
        && !restartableStatuses.has(latestStatus)
        && !isBudgetContinuation) {
        return rejectValidation("当前运行尚未结束，不能再次启动");
      }
      if (runMutating) return rejectValidation("另一项运行操作正在进行");

      const input = {
        ...(isBudgetContinuation && latestRun
          ? { parentRunId: latestRun.id }
          : {}),
        ...(normalizedReason ? { reason: normalizedReason } : {})
      };
      const idempotency = stableKey("start-run", { planId, ...input });
      const context = beginRunMutation(planId, "start", latestRun?.id ?? null);
      state.runControlReason = normalizedReason;
      state.error = null;
      state.message = isBudgetContinuation
        ? "正在按新预算继续运行…"
        : latestRun ? "正在创建新的独立运行…" : "正在启动获客运行…";
      render();
      return remember((async () => {
        try {
          const result = await api.createRun(planId, input, idempotency.value);
          pendingIdempotencyKeys.delete(idempotency.id);
          await refreshAfterRunMutation(
            context,
            result,
            isBudgetContinuation
              ? "追加预算后的运行已启动"
              : latestRun ? "新的独立运行已启动" : "获客运行已启动"
          );
        } catch (error) {
          if (runMutationIsCurrent(context)) {
            state.error = errorText(error);
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === runMutationSerial) {
            runMutating = false;
            state.runControlBusy = false;
            render();
            ensureRunPolling();
          }
        }
      })());
    },

    controlRun(action, reason) {
      const detail = state.detail;
      const planId = currentPlanId;
      const latestRun = detail?.latestRun ?? null;
      const normalizedReason = reason.trim();
      const allowedActions: AcquisitionRunControlAction[] = [
        "pause",
        "resume",
        "cancel"
      ];
      if (!allowedActions.includes(action)) {
        return rejectValidation("运行控制动作无效");
      }
      if (!detail || !planId || !latestRun) {
        return rejectValidation("当前计划还没有可控制的运行");
      }
      if (!normalizedReason) {
        return rejectValidation("暂停、继续或取消运行必须填写操作理由");
      }
      const status = latestRun.status;
      const actionAllowed = action === "pause"
        ? status === "queued" || status === "running"
        : action === "resume"
          ? status === "paused"
          : ["queued", "running", "pause_requested", "paused"].includes(status);
      if (!actionAllowed) {
        return rejectValidation(
          action === "pause"
            ? "只有排队中或运行中的任务可以暂停"
            : action === "resume"
              ? "只有已暂停的任务可以继续"
              : "当前运行状态不能取消"
        );
      }
      const etag = typeof latestRun.etag === "string" ? latestRun.etag.trim() : "";
      if (!etag) {
        return rejectValidation("运行 ETag 缺失，请刷新详情后重试");
      }
      if (action === "cancel" && !ask("确认取消当前获客运行？")) {
        return Promise.resolve();
      }
      if (runMutating) return rejectValidation("另一项运行操作正在进行");

      const context = beginRunMutation(planId, action, latestRun.id);
      state.runControlReason = normalizedReason;
      const progressLabel = action === "pause"
        ? "正在请求安全暂停…"
        : action === "resume"
          ? "正在继续运行…"
          : "正在取消运行…";
      const completedLabel = action === "pause"
        ? "暂停请求已提交"
        : action === "resume"
          ? "运行已继续"
          : "取消请求已提交";
      state.error = null;
      state.message = progressLabel;
      render();
      return remember((async () => {
        try {
          const result = await api.controlRun(
            latestRun.id,
            action,
            etag,
            normalizedReason
          );
          await refreshAfterRunMutation(context, result, completedLabel);
        } catch (error) {
          if (runMutationIsCurrent(context)) {
            state.error = errorText(error);
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === runMutationSerial) {
            runMutating = false;
            state.runControlBusy = false;
            render();
            ensureRunPolling();
          }
        }
      })());
    },

    reviewCandidate(action, reason = "") {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      const status = typeof candidate?.status === "string" ? candidate.status : null;
      const decisionVersion = typeof candidate?.latestDecisionVersion === "string"
        ? candidate.latestDecisionVersion.trim()
        : "";
      const normalizedReason = reason.trim();
      const allowed = [
        "approved",
        "rejected",
        "do_not_contact",
        "needs_research",
        "reopen"
      ].includes(action);
      if (!allowed) return rejectValidation("审核动作无效");
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (!decisionVersion) {
        return rejectValidation("候选缺少当前资格决定版本，不能审核");
      }
      if (action === "reopen" ? status !== "rejected" : status !== "pending_review") {
        return rejectValidation(
          action === "reopen"
            ? "只有已驳回候选可以重开"
            : "候选当前不在待审核状态"
        );
      }
      if (["rejected", "needs_research", "reopen"].includes(action)
        && !normalizedReason) {
        return rejectValidation("该审核动作必须填写原因");
      }
      if (action === "do_not_contact"
        && !ask("确认将该候选标记为禁止联系？")) {
        return Promise.resolve();
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      const input = {
        action,
        decisionVersion,
        reason: normalizedReason || null
      };
      const idempotency = stableKey("review-candidate", { candidateId, ...input });
      const context = beginMutation(candidateId);
      state.error = null;
      state.message = "正在提交人工审核…";
      render();
      return remember((async () => {
        try {
          await api.reviewCandidate(candidateId, input, idempotency.value);
          pendingIdempotencyKeys.delete(idempotency.id);
          if (!mutationIsCurrent(context)) return;
          eventTarget.dispatchEvent(customEvent(
            "goodjob:acquisition-candidate-changed",
            { planId: context.planId, candidateId, action }
          ));
          await refreshAfterMutation(
            context,
            "审核已记录，正在刷新候选…",
            "审核已记录"
          );
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.error = error instanceof Error ? error.message : "审核提交失败";
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    fetchCandidateIdentityProfile(profileUrl, rationale = "") {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (!unresolvedDouyinCandidate(candidate)) {
        return rejectValidation("只有未确认主体的抖音个人候选需要公开主页核验");
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      let canonicalProfileUrl: string;
      let normalizedRationale: string;
      try {
        canonicalProfileUrl = canonicalDouyinProfileUrl(profileUrl);
        normalizedRationale = rationale.trim()
          || "已人工核对本次受控抓取的抖音公开主页，与候选需求主体一致。";
      } catch (error) {
        return rejectValidation(errorText(error));
      }
      const idempotency = stableKey("identity-fetch", {
        candidateId,
        profileUrl: canonicalProfileUrl
      });
      const context = beginMutation(candidateId);
      state.error = null;
      state.message = null;
      state.identityVerification = {
        status: "fetching",
        profileUrl: canonicalProfileUrl,
        rationale: normalizedRationale,
        evidenceIds: [],
        operationId: null,
        message: "正在抓取抖音公开主页证据…",
        error: null
      };
      render();
      return remember((async () => {
        try {
          const created = await api.createContentFetchOperation(
            {
              sourceUrl: canonicalProfileUrl,
              subjectChannel: "individual"
            },
            idempotency.value
          );
          const completed = await waitForContentFetchOperation(created, context);
          if (!completed || !mutationIsCurrent(context)) return;
          pendingIdempotencyKeys.delete(idempotency.id);
          if (completed.status === "succeeded" && completed.evidenceIds.length > 0) {
            state.identityVerification = {
              status: "ready_to_confirm",
              profileUrl: canonicalProfileUrl,
              rationale: normalizedRationale,
              evidenceIds: [...completed.evidenceIds],
              operationId: completed.id,
              message: `已抓取 ${completed.evidenceIds.length} 条公开主页证据，请人工确认后启动 AI 研判。`,
              error: null
            };
          } else {
            const reason = completed.status === "access_restricted"
              ? "公开主页访问受限，不能用于主体核验"
              : completed.errorCode
                ? `公开主页抓取失败（${completed.errorCode}）`
                : "抓取完成，但没有返回可用于核验的公开证据";
            state.identityVerification = {
              status: "failed",
              profileUrl: canonicalProfileUrl,
              rationale: normalizedRationale,
              evidenceIds: [],
              operationId: completed.id,
              message: null,
              error: reason
            };
          }
          render();
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.identityVerification = {
              status: "failed",
              profileUrl: canonicalProfileUrl,
              rationale: normalizedRationale,
              evidenceIds: [],
              operationId: null,
              message: null,
              error: errorText(error)
            };
            state.error = errorText(error);
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    confirmCandidateIdentity(input) {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (!unresolvedDouyinCandidate(candidate)) {
        return rejectValidation("只有未确认主体的抖音个人候选可以执行主体确认");
      }
      if (state.identityVerification?.status !== "ready_to_confirm") {
        return rejectValidation("请先抓取精确公开主页证据");
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      let canonicalProfileUrl: string;
      let rationale: string;
      let evidenceIds: string[];
      let version: number;
      try {
        canonicalProfileUrl = canonicalDouyinProfileUrl(input.profileUrl);
        if (canonicalProfileUrl !== state.identityVerification.profileUrl) {
          throw new Error("确认主页与已抓取的公开主页不一致");
        }
        rationale = validIdentityRationale(input.rationale);
        evidenceIds = validEvidenceIds(input.evidenceIds);
        const allowed = new Set(state.identityVerification.evidenceIds);
        if (evidenceIds.some((id) => !allowed.has(id))) {
          throw new Error("所选证据不是本次受控抓取返回的公开证据");
        }
        version = candidateVersion(candidate);
      } catch (error) {
        return rejectValidation(errorText(error));
      }

      const idempotency = stableKey("identity-confirm", {
        candidateId,
        version,
        profileUrl: canonicalProfileUrl,
        evidenceIds,
        rationale
      });
      const context = beginMutation(candidateId);
      state.error = null;
      state.message = "正在确认主体并准备启动 AI 研判…";
      state.identityVerification = {
        ...state.identityVerification,
        status: "confirming",
        profileUrl: canonicalProfileUrl,
        rationale,
        evidenceIds,
        message: "正在保存主体确认…",
        error: null
      };
      render();
      return remember((async () => {
        let intelligenceStarted = false;
        try {
          const result = await api.confirmCandidateIdentity(
            candidateId,
            version,
            {
              subjectKind: "individual",
              publicProfileUrl: canonicalProfileUrl,
              sourcePlatform: "douyin",
              evidenceIds,
              rationale
            },
            idempotency.value
          );
          pendingIdempotencyKeys.delete(idempotency.id);
          if (!mutationIsCurrent(context)) return;
          if (state.candidateDetail) {
            state.candidateDetail = {
              ...state.candidateDetail,
              candidate: result.candidate as unknown as Record<string, unknown>
            };
          }
          state.identityVerification = {
            status: "confirmed",
            profileUrl: canonicalProfileUrl,
            rationale,
            evidenceIds,
            operationId: state.identityVerification?.operationId ?? null,
            message: "主体已确认，正在启动 AI 研判…",
            error: null
          };
          try {
            const startKey = stableKey("identity-start-intelligence", {
              candidateId,
              profileUrl: canonicalProfileUrl
            });
            await api.startIntelligenceOperation(candidateId, startKey.value);
            pendingIdempotencyKeys.delete(startKey.id);
            intelligenceStarted = true;
          } catch (error) {
            if (mutationIsCurrent(context)) {
              state.error = `主体已确认，但 AI 研判启动失败：${errorText(error)}`;
            }
          }
          if (!mutationIsCurrent(context)) return;
          eventTarget.dispatchEvent(customEvent(
            "goodjob:acquisition-candidate-changed",
            {
              planId: context.planId,
              candidateId,
              action: intelligenceStarted
                ? "identity_confirmed_and_intelligence_started"
                : "identity_confirmed"
            }
          ));
          await refreshAfterMutation(
            context,
            intelligenceStarted
              ? "主体已确认，AI 研判已启动，正在刷新候选…"
              : "主体已确认，正在刷新候选…",
            intelligenceStarted
              ? "主体已确认并启动 AI 研判"
              : "主体已确认"
          );
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.identityVerification = {
              ...state.identityVerification!,
              status: "failed",
              message: null,
              error: errorText(error)
            };
            state.error = errorText(error);
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    retryIdentityResolution() {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      const operation = state.candidateDetail?.identityResolutionOperation;
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (operation?.status !== "failed" || operation.retryable !== true) {
        return rejectValidation("当前自动主体核验任务不可重试");
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      let version: number;
      try {
        version = candidateVersion(candidate);
      } catch (error) {
        return rejectValidation(errorText(error));
      }
      const idempotency = stableKey("retry-identity-resolution", {
        candidateId,
        candidateVersion: version,
        failedOperationId: operation.id
      });
      const context = beginMutation(candidateId);
      stopSelectedCandidatePolling();
      state.error = null;
      state.message = "正在重新提交自动主体核验…";
      render();
      return remember((async () => {
        try {
          const created = await api.retryDouyinIdentityResolution(
            candidateId,
            idempotency.value
          );
          pendingIdempotencyKeys.delete(idempotency.id);
          if (!mutationIsCurrent(context)) return;
          if (state.candidateDetail) {
            state.candidateDetail = {
              ...state.candidateDetail,
              identityResolutionOperation: created
            };
          }
          await refreshAfterMutation(
            context,
            "自动主体核验已重新排队，正在刷新状态…",
            "自动主体核验已重新排队"
          );
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.error = errorText(error);
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    openPrivateDomainHandoff() {
      const candidate = state.candidateDetail?.candidate;
      const handoffStatus = state.candidateDetail?.privateDomainHandoff;
      const status = typeof candidate?.status === "string"
        ? candidate.status
        : "";
      if (!candidate || !state.selectedCandidateId) {
        void rejectValidation("请先选择一个候选").catch(() => undefined);
        return;
      }
      const recoveryRequest = recoverableHandoffRequest(handoffStatus);
      if (recoveryRequest === null) {
        void rejectValidation(
          "历史交接归因不完整，无法安全恢复"
        ).catch(() => undefined);
        return;
      }
      if (handoffStatus && "handoff" in handoffStatus
        && recoveryRequest === undefined) return;
      if (status !== "approved" && status !== "converted_to_lead") {
        void rejectValidation("只有已批准或已转线索的候选可以交接").catch(
          () => undefined
        );
        return;
      }
      const source = recoveryRequest?.runId && recoveryRequest.discoveredEventId
        ? {
            runId: recoveryRequest.runId,
            discoveredEventId: recoveryRequest.discoveredEventId
          }
        : handoffAttributionSource(state.detail, state.selectedCandidateId);
      if (!source) {
        void rejectValidation("候选缺少当前运行的固定发现事件").catch(
          () => undefined
        );
        return;
      }
      state.error = null;
      state.handoffDialog = {
        open: true,
        busy: false,
        recovering: Boolean(recoveryRequest),
        runId: source.runId,
        discoveredEventId: source.discoveredEventId,
        decisionVersion: recoveryRequest?.decisionVersion
          ?? (typeof candidate.approvedDecisionVersion === "string"
            && candidate.approvedDecisionVersion.trim()
            ? candidate.approvedDecisionVersion.trim()
            : typeof candidate.latestDecisionVersion === "string"
              ? candidate.latestDecisionVersion.trim()
              : ""),
        mode: recoveryRequest?.mode ?? "create_new",
        existingCustomerId: recoveryRequest?.existingCustomerId ?? "",
        followUp: recoveryRequest
          ? { ...recoveryRequest.followUp }
          : {
              title: "首次跟进：确认需求和预算",
              dueAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
              priority: "high"
            }
      };
      render();
    },

    closePrivateDomainHandoff() {
      if (state.handoffDialog?.busy) return;
      state.handoffDialog = null;
      render();
    },

    handoffCandidate(input) {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      const dialog = state.handoffDialog;
      const status = typeof candidate?.status === "string"
        ? candidate.status
        : "";
      const decisionVersion = dialog?.decisionVersion.trim() ?? "";
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (status !== "approved" && status !== "converted_to_lead") {
        return rejectValidation("只有已批准或已转线索的候选可以交接");
      }
      if (!decisionVersion) {
        return rejectValidation("候选缺少已批准的资格决定版本");
      }
      if (!dialog?.open || !dialog.runId.trim()
        || !dialog.discoveredEventId.trim()) {
        return rejectValidation("候选缺少当前运行的固定发现事件");
      }
      const effectiveInput = dialog.recovering ? dialog : input;
      const title = effectiveInput.followUp.title.trim();
      const existingCustomerId = effectiveInput.existingCustomerId.trim();
      const dueTimestamp = Date.parse(effectiveInput.followUp.dueAt);
      if (effectiveInput.mode !== "create_new" && effectiveInput.mode !== "link_existing") {
        return rejectValidation("私域交接模式无效");
      }
      if (effectiveInput.mode === "link_existing" && !existingCustomerId) {
        return rejectValidation("请选择要关联的已有客户");
      }
      if (!title) return rejectValidation("首次跟进标题不能为空");
      if (!Number.isFinite(dueTimestamp)) {
        return rejectValidation("请填写有效的首次跟进时间");
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      const request: AcquisitionPrivateDomainHandoffInput = {
        operationCode: "handoff_acquisition_candidate_v1",
        runId: dialog.runId,
        discoveredEventId: dialog.discoveredEventId,
        decisionVersion,
        mode: effectiveInput.mode,
        existingCustomerId: effectiveInput.mode === "link_existing"
          ? existingCustomerId
          : "",
        followUp: {
          title,
          dueAt: new Date(dueTimestamp).toISOString(),
          priority: effectiveInput.followUp.priority
        }
      };
      const idempotency = stableKey("handoff-candidate", {
        candidateId,
        ...request
      });
      const context = beginMutation(candidateId);
      state.handoffDialog = {
        open: true,
        busy: true,
        recovering: dialog.recovering,
        runId: request.runId,
        discoveredEventId: request.discoveredEventId,
        decisionVersion: request.decisionVersion,
        mode: request.mode,
        existingCustomerId: request.existingCustomerId,
        followUp: { ...request.followUp }
      };
      state.error = null;
      state.message = "正在交接至 CRM/私域…";
      render();
      return remember((async () => {
        try {
          const result = await api.handoffCandidate(
            candidateId,
            request,
            idempotency.value
          );
          forgetStableKey(idempotency);
          if (!mutationIsCurrent(context)) return;
          if (state.candidateDetail) {
            state.candidateDetail = {
              ...state.candidateDetail,
              privateDomainHandoff: result
            };
          }
          state.handoffDialog = null;
          state.error = null;
          state.message = "已交接至 CRM/私域并创建首次跟进待办";
          eventTarget.dispatchEvent(customEvent(
            "goodjob:acquisition-candidate-changed",
            {
              planId: context.planId,
              candidateId,
              action: "private_domain_handoff_completed",
              customerId: result.handoff.customerId,
              todoId: result.handoff.todoId,
              leadId: result.handoff.leadId,
              handoffId: result.handoff.id
            }
          ));
          render();
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.error = errorText(error);
            state.message = null;
            if (state.handoffDialog) state.handoffDialog.busy = false;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    startIntelligence() {
      const candidateId = state.selectedCandidateId;
      const candidate = state.candidateDetail?.candidate;
      if (!candidateId || !candidate) {
        return rejectValidation("请先选择一个候选");
      }
      if (candidate.identityResolved !== true) {
        return rejectValidation("候选主体尚未完成公开身份核验");
      }
      if (state.candidateDetail?.qualification) {
        return rejectValidation("候选已有有效资格研判，无需重复启动");
      }
      if (mutating) return rejectValidation("另一项候选操作正在进行");

      const idempotency = stableKey("start-intelligence", { candidateId });
      const context = beginMutation(candidateId);
      state.error = null;
      state.message = "正在启动 AI 客户情报与资格研判…";
      render();
      return remember((async () => {
        try {
          await api.startIntelligenceOperation(candidateId, idempotency.value);
          pendingIdempotencyKeys.delete(idempotency.id);
          if (!mutationIsCurrent(context)) return;
          eventTarget.dispatchEvent(customEvent(
            "goodjob:acquisition-candidate-changed",
            {
              planId: context.planId,
              candidateId,
              action: "intelligence_started"
            }
          ));
          await refreshAfterMutation(
            context,
            "AI 研判任务已启动，正在刷新状态…",
            "AI 研判任务已启动"
          );
        } catch (error) {
          if (mutationIsCurrent(context)) {
            state.error = error instanceof Error ? error.message : "AI 研判任务启动失败";
            state.message = null;
            render();
          }
          throw error;
        } finally {
          if (context.serial === mutationSerial) mutating = false;
        }
      })());
    },

    destroy() {
      if (disposed) return;
      releaseVisualArtifact();
      disposed = true;
      detailOpen = false;
      invalidateMutation();
      invalidateRunMutation();
      stopSelectedCandidatePolling();
      clearCandidatePaginationBusy();
      requestSerial += 1;
      candidateSerial += 1;
      pendingIdempotencyKeys.clear();
      identityHandoffLedger.clear();
      paginatedRunId = null;
      expectedRunId = null;
      unsubscribeVisualReader();
      visualReaderController.destroy();
      eventTarget.removeEventListener(
        "goodjob:acquisition-detail-open-requested",
        onOpenRequested as EventListener
      );
      eventTarget.removeEventListener(
        "goodjob:acquisition-mode-changed",
        onAcquisitionModeChanged as EventListener
      );
      root?.removeEventListener("click", onRootClick);
      root?.removeEventListener("change", onRootChange);
      root?.removeEventListener("submit", onRootSubmit);
      root?.removeEventListener("close", onRootClose);
    }
  };

  function onOpenRequested(event: Event): void {
    const detail = (event as CustomEvent<DetailOpenRequest>).detail;
    const mode = requestedMode(detail?.mode);
    const planId = requestedPlanId(detail?.planId);
    const candidateId = requestedCandidateId(detail?.candidateId);
    if (!mode) return;
    if (!planId) {
      if (mode === "candidates" && candidateId) {
        void controller.openCandidate(candidateId).catch(() => undefined);
      }
      return;
    }
    void controller.open(mode, planId)
      .then(() => {
        if (
          mode === "candidates"
          && candidateId
          && controller.getState().selectedCandidateId !== candidateId
        ) {
          return controller.selectCandidate(candidateId);
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  function onAcquisitionModeChanged(event: Event): void {
    const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode;
    if (mode === "demo") {
      selectedCandidatePollingEnabled = false;
      stopSelectedCandidatePolling();
      invalidateMutation();
      candidateSerial += 1;
      return;
    }
    if (mode === "real") {
      selectedCandidatePollingEnabled = true;
      if (detailOpen) ensureSelectedCandidatePolling();
    }
  }

  function consume(promise: Promise<void>): void {
    void promise.catch(() => undefined);
  }

  function actionTarget(event: Event): HTMLElement | null {
    const target = event.target as {
      closest?: (selector: string) => HTMLElement | null;
    } | null;
    const action = target?.closest?.("[data-acquisition-detail-action]") ?? null;
    return action && root?.contains(action) ? action : null;
  }

  function onRootClick(event: Event): void {
    const target = actionTarget(event);
    if (!target) return;
    const action = target.dataset.acquisitionDetailAction;
    if (action === "close") {
      controller.close();
    } else if (action === "switch-mode") {
      const mode = requestedMode(target.dataset.mode);
      if (mode) controller.switchMode(mode);
    } else if (action === "select-candidate") {
      consume(remember((async () => {
        await controller.selectCandidate(target.dataset.candidateId ?? "");
        if (state.selectedCandidateId && state.candidateDetail) {
          controller.switchMode("candidates");
        }
      })()));
    } else if (action === "load-more-candidates") {
      consume(controller.loadMoreCandidates());
    } else if (action === "retry") {
      if (currentPlanId) consume(controller.open(state.mode, currentPlanId));
    } else if (action === "authorize-visual-reader") {
      event.preventDefault();
      consume(visualReaderController.authorize());
    } else if (action === "stop-visual-reader") {
      event.preventDefault();
      consume(visualReaderController.stop());
    } else if (action === "retry-visual-reader-probe") {
      event.preventDefault();
      visualReaderController.retryProbe();
    } else if (action === "view-visual-artifact") {
      event.preventDefault();
      consume(remember(viewVisualArtifact(target.dataset.artifactId ?? "")));
    } else if (action === "close-visual-artifact") {
      event.preventDefault();
      releaseVisualArtifact();
      render();
    } else if (action === "retry-identity-resolution") {
      event.preventDefault();
      consume(controller.retryIdentityResolution());
    } else if (action === "start-intelligence") {
      event.preventDefault();
      consume(controller.startIntelligence());
    } else if (action === "open-private-domain-handoff") {
      event.preventDefault();
      controller.openPrivateDomainHandoff();
    } else if (action === "open-quote-workbench") {
      event.preventDefault();
      const candidateId = target.dataset.candidateId?.trim() ?? "";
      const customerId = target.dataset.customerId?.trim() ?? "";
      if (!candidateId && !customerId) return;
      window.dispatchEvent(new CustomEvent(
        "goodjob:quote-workbench-requested",
        {
          detail: Object.freeze({
            candidateId: candidateId || undefined,
            customerId: customerId || undefined
          })
        }
      ));
      if (candidateId) {
        window.location.hash = `#growth/quotes?candidate=${
          encodeURIComponent(candidateId)
        }`;
      }
    } else if (action === "close-private-domain-handoff") {
      event.preventDefault();
      controller.closePrivateDomainHandoff();
    } else if (action === "review") {
      event.preventDefault();
      const reviewAction = target.dataset.reviewAction as AcquisitionCandidateReviewAction;
      const reasonControl = root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[name="reviewReason"]'
      );
      consume(controller.reviewCandidate(reviewAction, reasonControl?.value ?? ""));
    } else if (action === "run-control") {
      event.preventDefault();
      const runAction = target.dataset.acquisitionRunAction;
      const reasonControl = root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[name="runControlReason"]'
      );
      const reason = reasonControl?.value ?? "";
      if (runAction === "start") {
        consume(controller.startRun(reason));
      } else {
        consume(controller.controlRun(
          runAction as AcquisitionRunControlAction,
          reason
        ));
      }
    }
  }

  function onRootChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    if (!target?.matches?.('input[name="visualReaderArtifactUpload"]')
      || !root?.contains(target)) return;
    visualReaderController.setArtifactUploadEnabled(target.checked);
  }

  function onRootSubmit(event: Event): void {
    const form = event.target as HTMLFormElement | null;
    if (form?.dataset?.acquisitionDetailForm === "private-domain-handoff") {
      event.preventDefault();
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const mode = (form.elements.namedItem("handoffMode") as RadioNodeList | null)
        ?.value;
      const existingCustomerId = (form.elements.namedItem(
        "existingCustomerId"
      ) as HTMLInputElement | null)?.value ?? "";
      const title = (form.elements.namedItem(
        "followUpTitle"
      ) as HTMLInputElement | null)?.value ?? "";
      const dueAt = (form.elements.namedItem(
        "followUpDueAt"
      ) as HTMLInputElement | null)?.value ?? "";
      const priority = (form.elements.namedItem(
        "followUpPriority"
      ) as HTMLSelectElement | null)?.value;
      consume(controller.handoffCandidate({
        mode: mode as "create_new" | "link_existing",
        existingCustomerId,
        followUp: {
          title,
          dueAt,
          priority: priority as "high" | "medium" | "normal"
        }
      }));
      return;
    }
    if (form?.dataset?.acquisitionDetailForm === "identity-verification") {
      event.preventDefault();
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const submitter = (event as SubmitEvent).submitter as HTMLElement | null;
      const identityAction = submitter?.dataset.identityAction;
      const profileUrl = (form.elements.namedItem(
        "identityProfileUrl"
      ) as HTMLInputElement | null)?.value ?? "";
      const rationale = (form.elements.namedItem(
        "identityRationale"
      ) as HTMLTextAreaElement | null)?.value ?? "";
      const evidenceIds = Array.from(
        form.querySelectorAll<HTMLInputElement>(
          'input[name="identityEvidenceId"]:checked'
        )
      ).map((input) => input.value);
      if (identityAction === "confirm") {
        consume(controller.confirmCandidateIdentity({
          profileUrl,
          rationale,
          evidenceIds
        }));
      } else {
        consume(controller.fetchCandidateIdentityProfile(profileUrl, rationale));
      }
      return;
    }
    if (form?.dataset?.acquisitionDetailForm !== "review") return;
    event.preventDefault();
    if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
    const submitter = (event as SubmitEvent).submitter as HTMLElement | null;
    const action = submitter?.dataset.reviewAction
      ?? (form.elements.namedItem("action") as HTMLInputElement | null)?.value;
    const reason = (form.elements.namedItem("reviewReason") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null)?.value ?? "";
    consume(controller.reviewCandidate(
      action as AcquisitionCandidateReviewAction,
      reason
    ));
  }

  function onRootClose(): void {
    releaseVisualArtifact();
    if (detailOpen) visualReaderController.close();
    detailOpen = false;
    invalidateMutation();
    invalidateRunMutation();
    stopSelectedCandidatePolling();
    clearCandidatePaginationBusy();
    requestSerial += 1;
    candidateSerial += 1;
    paginatedRunId = null;
    expectedRunId = null;
    state.identityVerification = null;
    finishClose();
  }

  eventTarget.addEventListener(
    "goodjob:acquisition-detail-open-requested",
    onOpenRequested as EventListener
  );
  eventTarget.addEventListener(
    "goodjob:acquisition-mode-changed",
    onAcquisitionModeChanged as EventListener
  );
  const unsubscribeVisualReader = visualReaderController.subscribe((visualState) => {
    state.visualReader = { ...visualState };
    render();
  });
  resolveDom();
  root?.addEventListener("click", onRootClick);
  root?.addEventListener("change", onRootChange);
  root?.addEventListener("submit", onRootSubmit);
  root?.addEventListener("close", onRootClose);
  render();

  return controller;
}

let singleton: AcquisitionDetailCenterController | null = null;

export function startAcquisitionDetailCenter(): AcquisitionDetailCenterController {
  singleton ??= createAcquisitionDetailCenterController();
  return singleton;
}
