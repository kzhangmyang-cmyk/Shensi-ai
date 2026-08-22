import {
  createVisualReaderApi,
  isVisualObservationSubmission,
  type VisualObservationSubmission,
  type VisualReaderApi,
  type VisualReaderSession,
  type VisualReaderStableErrorCode,
  type VisualReaderUsage
} from "./visual-reader-api";
import {
  createVisualReaderBridge,
  type VisualReaderBridge,
  type VisualReaderBridgeAvailability,
  type VisualReaderExtensionEvent
} from "./visual-reader-bridge";

export interface AuthorizedVisualReaderProjection {
  sessionId: string;
  coverage: "authorized_visible_top_level_sample";
  status: VisualReaderSession["status"];
  usage: VisualReaderUsage;
  lastErrorCode: VisualReaderStableErrorCode | null;
  visualSteps: Array<{
    id: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    processedCount: number;
    errorCode: VisualReaderStableErrorCode | null;
    message: string;
  }>;
}

export interface VisualReaderControlState {
  extensionStatus: VisualReaderBridgeAvailability | "idle";
  extensionVersion: string | null;
  artifactUploadEnabled: boolean;
  busy: boolean;
  session: VisualReaderSession | null;
  projection: AuthorizedVisualReaderProjection | null;
  message: string | null;
  error: string | null;
}

export interface VisualReaderOpenContext {
  planId: string;
  runId: string | null;
  projection?: AuthorizedVisualReaderProjection;
}

export interface VisualReaderController {
  getState(): Readonly<VisualReaderControlState>;
  subscribe(listener: (state: Readonly<VisualReaderControlState>) => void): () => void;
  whenIdle(): Promise<void>;
  open(context: VisualReaderOpenContext): Promise<void>;
  reconcile(projection?: AuthorizedVisualReaderProjection): Promise<void>;
  setArtifactUploadEnabled(enabled: boolean): void;
  authorize(): Promise<void>;
  stop(): Promise<void>;
  retryProbe(): void;
  close(): void;
  destroy(): void;
}

export interface VisualReaderControllerOptions {
  api?: VisualReaderApi;
  bridgeFactory?: () => VisualReaderBridge;
  keyFactory?: () => string;
  onRequestPresentationRefresh?: () => void;
}

interface QueuedVisualMutation {
  id: string;
  kind: "batch" | "terminal" | "stop";
  sessionId: string;
  run(): Promise<void>;
}

const ACTIVE_SESSION_STATUSES = new Set(["created", "collecting"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "partial_success", "aborted", "expired"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function defaultVisualReaderKey(
  crypto: Pick<Crypto, "getRandomValues"> | null | undefined = globalThis.crypto
): string {
  if (!crypto?.getRandomValues) {
    throw new Error("浏览器缺少 crypto 安全随机数支持");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `visual-reader-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return "网络连接暂时不可用，请保持当前页面后重试";
  if (error instanceof Error && error.name === "VisualReaderApiError") return error.message;
  return "视觉读取请求失败，请重试";
}

function validProjection(value: unknown): value is AuthorizedVisualReaderProjection {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  return typeof projection.sessionId === "string"
    && IDENTIFIER.test(projection.sessionId)
    && projection.coverage === "authorized_visible_top_level_sample"
    && ["created", "collecting", "completed", "partial_success", "aborted", "expired"]
      .includes(String(projection.status))
    && projection.usage !== null && typeof projection.usage === "object"
    && !Array.isArray(projection.usage)
    && Array.isArray(projection.visualSteps);
}

function batchIsBounded(event: Extract<VisualReaderExtensionEvent, { type: "observation_batch" }>): boolean {
  return event.observations.length >= 1
    && event.observations.length <= 20
    && event.observations.every((item) => isVisualObservationSubmission(item, false))
    && event.observations.filter((item) => item.redactedCrop !== null).length <= 5;
}

export function createVisualReaderController(
  options: VisualReaderControllerOptions = {}
): VisualReaderController {
  const api = options.api ?? createVisualReaderApi();
  const bridgeFactory = options.bridgeFactory ?? (() => createVisualReaderBridge());
  const keyFactory = options.keyFactory ?? defaultVisualReaderKey;
  const refreshPresentation = options.onRequestPresentationRefresh ?? (() => undefined);
  const state: VisualReaderControlState = {
    extensionStatus: "idle",
    extensionVersion: null,
    artifactUploadEnabled: true,
    busy: false,
    session: null,
    projection: null,
    message: null,
    error: null
  };
  const listeners = new Set<(state: Readonly<VisualReaderControlState>) => void>();
  const batchKeys = new Map<string, string>();
  const semanticKeys = new Map<string, string>();
  const processingBatches = new Set<string>();
  const mutationQueue: QueuedVisualMutation[] = [];
  const activeDrainEpochs = new Set<number>();
  let bridge: VisualReaderBridge | null = null;
  let context: VisualReaderOpenContext | null = null;
  let generation = 0;
  let disposed = false;
  let startedSessionId: string | null = null;
  let stoppingSessionId: string | null = null;
  let idlePromise: Promise<void> = Promise.resolve();
  let mutationEpoch = 0;
  let mutationBlocked = false;
  let mutationIdlePromise: Promise<void> = Promise.resolve();
  let resolveMutationIdle: (() => void) | null = null;
  let rejectMutationIdle: ((reason: unknown) => void) | null = null;
  let reconcileSerial = 0;

  function notify(): void {
    for (const listener of listeners) listener(state);
  }

  function semanticKey(scope: string): string {
    const existing = semanticKeys.get(scope);
    if (existing) return existing;
    const created = keyFactory();
    semanticKeys.set(scope, created);
    return created;
  }

  function remember<T>(promise: Promise<T>): Promise<T> {
    idlePromise = promise.then(() => undefined);
    void idlePromise.catch(() => undefined);
    return promise;
  }

  function beginMutationCycle(): void {
    if (resolveMutationIdle || rejectMutationIdle) return;
    mutationIdlePromise = new Promise<void>((resolve, reject) => {
      resolveMutationIdle = resolve;
      rejectMutationIdle = reject;
    });
    void mutationIdlePromise.catch(() => undefined);
  }

  function resolveMutationCycle(): void {
    const resolve = resolveMutationIdle;
    resolveMutationIdle = null;
    rejectMutationIdle = null;
    resolve?.();
  }

  function rejectMutationCycle(error: unknown): void {
    const reject = rejectMutationIdle;
    resolveMutationIdle = null;
    rejectMutationIdle = null;
    reject?.(error);
  }

  function resetMutationQueue(): void {
    mutationEpoch += 1;
    mutationQueue.length = 0;
    mutationBlocked = false;
    resolveMutationCycle();
    mutationIdlePromise = Promise.resolve();
  }

  function discardSessionMutations(sessionId: string): void {
    batchKeys.clear();
    processingBatches.clear();
    for (const scope of semanticKeys.keys()) {
      if (scope.startsWith(`terminal:${sessionId}:`)) semanticKeys.delete(scope);
    }
    resetMutationQueue();
  }

  function drainMutationQueue(epoch: number): void {
    if (activeDrainEpochs.has(epoch) || mutationBlocked || epoch !== mutationEpoch) return;
    activeDrainEpochs.add(epoch);
    void (async () => {
      try {
        while (!disposed && epoch === mutationEpoch && !mutationBlocked) {
          const next = mutationQueue[0];
          if (!next) {
            resolveMutationCycle();
            return;
          }
          try {
            await next.run();
          } catch (error) {
            if (epoch !== mutationEpoch || mutationQueue[0] !== next) return;
            mutationBlocked = true;
            rejectMutationCycle(error);
            return;
          }
          if (epoch !== mutationEpoch || mutationQueue[0] !== next) return;
          mutationQueue.shift();
        }
      } finally {
        activeDrainEpochs.delete(epoch);
        if (epoch === mutationEpoch && !mutationBlocked && mutationQueue.length > 0) {
          drainMutationQueue(epoch);
        }
      }
    })();
  }

  function enqueueMutation(operation: QueuedVisualMutation): Promise<void> {
    const existingIndex = mutationQueue.findIndex((item) => item.id === operation.id);
    if (existingIndex >= 0) {
      if (mutationBlocked && existingIndex === 0) {
        mutationBlocked = false;
        beginMutationCycle();
        drainMutationQueue(mutationEpoch);
      }
      return mutationIdlePromise;
    }
    if (mutationBlocked
      && mutationQueue[0]?.kind === "terminal"
      && operation.kind === "terminal"
      && mutationQueue[0].sessionId === operation.sessionId) {
      mutationQueue[0] = operation;
      mutationBlocked = false;
      beginMutationCycle();
      drainMutationQueue(mutationEpoch);
      return mutationIdlePromise;
    }
    mutationQueue.push(operation);
    if (!mutationBlocked) {
      beginMutationCycle();
      drainMutationQueue(mutationEpoch);
    }
    return mutationIdlePromise;
  }

  function resetVisibleState(): void {
    state.extensionStatus = "idle";
    state.extensionVersion = null;
    state.artifactUploadEnabled = true;
    state.busy = false;
    state.session = null;
    state.projection = null;
    state.message = null;
    state.error = null;
  }

  function tryStartSession(): void {
    const currentSession = state.session;
    if (!bridge || state.extensionStatus !== "ready" || !currentSession
      || !ACTIVE_SESSION_STATUSES.has(currentSession.status)
      || startedSessionId === currentSession.sessionId) return;
    bridge.startSession(
      currentSession.sessionId,
      currentSession.limits,
      currentSession.artifactUploadEnabled
    );
    startedSessionId = currentSession.sessionId;
    state.message = "浏览器读取器已连接，正在读取当前可见的一级评论";
    state.error = null;
    notify();
  }

  function onAvailability(value: VisualReaderBridgeAvailability): void {
    if (disposed || !context) return;
    state.extensionStatus = value;
    if (value === "unavailable") {
      state.message = "未检测到授权浏览器读取器，请安装或启用后重新检测";
    } else if (value === "probing") {
      state.message = "正在检测授权浏览器读取器";
    }
    notify();
    if (value === "ready") tryStartSession();
  }

  async function loadSession(
    sessionId: string,
    expectedGeneration: number,
    expectedReconcile: number
  ): Promise<void> {
    const loaded = await api.getSession(sessionId);
    if (disposed || expectedGeneration !== generation
      || expectedReconcile !== reconcileSerial || !context) return;
    if (loaded.sessionId !== sessionId
      || loaded.planId !== context.planId
      || (context.runId !== null && loaded.runId !== context.runId)) {
      throw new Error("服务端视觉读取会话与当前运行不一致");
    }
    if (state.session?.sessionId === loaded.sessionId
      && TERMINAL_SESSION_STATUSES.has(state.session.status)
      && ACTIVE_SESSION_STATUSES.has(loaded.status)) return;
    state.session = loaded;
    state.artifactUploadEnabled = loaded.artifactUploadEnabled;
    state.error = null;
    notify();
    tryStartSession();
  }

  async function handleBatch(
    event: Extract<VisualReaderExtensionEvent, { type: "observation_batch" }>,
    expectedGeneration: number,
    expectedMutationEpoch: number
  ): Promise<void> {
    const currentSession = state.session;
    if (!currentSession || event.sessionId !== currentSession.sessionId
      || !ACTIVE_SESSION_STATUSES.has(currentSession.status)) return;
    if (!batchIsBounded(event)) {
      state.error = "视觉读取批次超过已授权的数量或制品上限";
      state.message = null;
      notify();
      return;
    }
    const scope = `${event.sessionId}:${event.batchId}`;
    if (processingBatches.has(scope)) return;
    processingBatches.add(scope);
    const key = batchKeys.get(scope) ?? keyFactory();
    batchKeys.set(scope, key);
    state.error = null;
    state.message = "正在保存当前可见评论观察";
    notify();
    const observations: VisualObservationSubmission[] = event.observations.map((item) => ({
      ...item,
      redactedCrop: state.artifactUploadEnabled ? item.redactedCrop : null
    }));
    try {
      const response = await api.appendObservationBatch(
        event.sessionId,
        { observations },
        key
      );
      if (disposed || expectedGeneration !== generation
        || expectedMutationEpoch !== mutationEpoch || !context
        || state.session?.sessionId !== event.sessionId) return;
      state.session = response.session;
      state.message = `已保存 ${response.accepted.length + response.duplicates.length} 条可见评论观察`;
      state.error = null;
      bridge?.acknowledgeBatch(event.sessionId, event.batchId);
      refreshPresentation();
      notify();
    } catch (error) {
      if (!disposed && expectedGeneration === generation
        && expectedMutationEpoch === mutationEpoch
        && state.session?.sessionId === event.sessionId) {
        state.message = null;
        state.error = safeErrorMessage(error);
        notify();
      }
      throw error;
    } finally {
      processingBatches.delete(scope);
    }
  }

  async function handleTerminal(
    event: Extract<VisualReaderExtensionEvent, { type: "terminal" }>,
    expectedGeneration: number,
    expectedMutationEpoch: number
  ): Promise<void> {
    const currentSession = state.session;
    if (!currentSession || event.sessionId !== currentSession.sessionId
      || !ACTIVE_SESSION_STATUSES.has(currentSession.status)) return;
    state.busy = true;
    state.message = "正在向服务端确认视觉读取结果";
    state.error = null;
    notify();
    const reasonCode = event.status === "aborted"
      ? "visual_reader_user_takeover"
      : "";
    const keyScope = `terminal:${event.sessionId}:${event.status}:${JSON.stringify(event.errorCodes)}:${reasonCode}`;
    try {
      const updated = event.status === "aborted"
        ? await api.abortSession(
            event.sessionId,
            { reasonCode: "visual_reader_user_takeover" },
            semanticKey(keyScope)
          )
        : await api.completeSession(
            event.sessionId,
            { status: event.status, errorCodes: [...event.errorCodes] },
            semanticKey(keyScope)
          );
      semanticKeys.delete(keyScope);
      if (disposed || expectedGeneration !== generation
        || expectedMutationEpoch !== mutationEpoch || !context
        || state.session?.sessionId !== event.sessionId) return;
      state.session = updated;
      state.message = event.status === "aborted"
        ? "视觉读取已停止"
        : "视觉读取结果已由服务端确认";
      refreshPresentation();
    } catch (error) {
      if (!disposed && expectedGeneration === generation
        && expectedMutationEpoch === mutationEpoch
        && state.session?.sessionId === event.sessionId) {
        state.message = null;
        state.error = safeErrorMessage(error);
      }
      throw error;
    } finally {
      if (!disposed && expectedGeneration === generation
        && expectedMutationEpoch === mutationEpoch
        && state.session?.sessionId === event.sessionId) {
        state.busy = false;
        notify();
      }
    }
  }

  function onExtensionEvent(event: VisualReaderExtensionEvent): void {
    if (disposed || !context) return;
    if (event.type === "ready") {
      state.extensionVersion = event.extensionVersion;
      state.extensionStatus = "ready";
      state.error = null;
      notify();
      tryStartSession();
      return;
    }
    if (event.sessionId === stoppingSessionId) return;
    const currentGeneration = generation;
    const currentMutationEpoch = mutationEpoch;
    if (event.type === "observation_batch") {
      void enqueueMutation({
        id: `batch:${event.sessionId}:${event.batchId}`,
        kind: "batch",
        sessionId: event.sessionId,
        run: () => handleBatch(event, currentGeneration, currentMutationEpoch)
      }).catch(() => undefined);
    } else if (event.type === "terminal") {
      const reasonCode = event.status === "aborted" ? "visual_reader_user_takeover" : "";
      void enqueueMutation({
        id: `terminal:${event.sessionId}:${event.status}:${JSON.stringify(event.errorCodes)}:${reasonCode}`,
        kind: "terminal",
        sessionId: event.sessionId,
        run: () => handleTerminal(event, currentGeneration, currentMutationEpoch)
      }).catch(() => undefined);
    }
  }

  function connectBridge(): void {
    bridge?.destroy();
    bridge = bridgeFactory();
    startedSessionId = null;
    bridge.connect({ onAvailability, onEvent: onExtensionEvent });
  }

  const controller: VisualReaderController = {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    whenIdle() {
      return Promise.all([idlePromise, mutationIdlePromise]).then(() => undefined);
    },
    open(nextContext) {
      generation += 1;
      const currentGeneration = generation;
      const currentReconcile = ++reconcileSerial;
      context = {
        planId: nextContext.planId,
        runId: nextContext.runId,
        projection: nextContext.projection
      };
      stoppingSessionId = null;
      batchKeys.clear();
      semanticKeys.clear();
      processingBatches.clear();
      resetMutationQueue();
      resetVisibleState();
      state.projection = validProjection(nextContext.projection)
        ? nextContext.projection
        : null;
      connectBridge();
      notify();
      if (!state.projection) return Promise.resolve();
      return remember(loadSession(
        state.projection.sessionId,
        currentGeneration,
        currentReconcile
      ));
    },
    reconcile(nextProjection) {
      if (!context) return Promise.resolve();
      const currentReconcile = ++reconcileSerial;
      const normalizedProjection = validProjection(nextProjection) ? nextProjection : null;
      const previousSessionId = state.projection?.sessionId ?? state.session?.sessionId ?? null;
      const nextSessionId = normalizedProjection?.sessionId ?? null;
      const switchedSession = previousSessionId !== null && previousSessionId !== nextSessionId;
      state.projection = normalizedProjection;
      context.projection = normalizedProjection ?? undefined;
      if (switchedSession) {
        stoppingSessionId = null;
        batchKeys.clear();
        semanticKeys.clear();
        processingBatches.clear();
        resetMutationQueue();
        state.session = null;
        state.artifactUploadEnabled = true;
        state.busy = false;
        state.message = null;
        state.error = null;
        connectBridge();
      }
      notify();
      if (!state.projection) return Promise.resolve();
      return remember(loadSession(
        state.projection.sessionId,
        generation,
        currentReconcile
      ));
    },
    setArtifactUploadEnabled(enabled) {
      if (state.session) return;
      state.artifactUploadEnabled = enabled;
      state.error = null;
      notify();
    },
    authorize() {
      if (!context?.runId) {
        return Promise.reject(new Error("当前任务没有可授权的运行"));
      }
      if (state.extensionStatus !== "ready") {
        const error = new Error("请先连接授权浏览器读取器");
        state.error = error.message;
        state.message = null;
        notify();
        return Promise.reject(error);
      }
      const currentGeneration = generation;
      state.busy = true;
      state.error = null;
      state.message = "正在创建短时授权会话";
      notify();
      const keyScope = `authorize:${context.runId}:${state.artifactUploadEnabled}`;
      return remember((async () => {
        try {
          const created = await api.createSession({
            runId: context?.runId ?? "",
            artifactUploadEnabled: state.artifactUploadEnabled
          }, semanticKey(keyScope));
          semanticKeys.delete(keyScope);
          if (disposed || currentGeneration !== generation || !context) return;
          if (created.planId !== context.planId || created.runId !== context.runId) {
            throw new Error("服务端视觉读取会话与当前运行不一致");
          }
          state.session = created;
          state.artifactUploadEnabled = created.artifactUploadEnabled;
          state.message = "授权会话已创建，等待当前抖音页面开始读取";
          refreshPresentation();
          tryStartSession();
        } catch (error) {
          if (!disposed && currentGeneration === generation) {
            state.message = null;
            state.error = safeErrorMessage(error);
          }
          throw error;
        } finally {
          if (!disposed && currentGeneration === generation) {
            state.busy = false;
            notify();
          }
        }
      })());
    },
    stop() {
      const currentSession = state.session;
      if (!currentSession || !ACTIVE_SESSION_STATUSES.has(currentSession.status)) {
        return Promise.reject(new Error("当前没有正在读取的会话"));
      }
      const currentGeneration = generation;
      stoppingSessionId = currentSession.sessionId;
      bridge?.abortSession(currentSession.sessionId);
      discardSessionMutations(currentSession.sessionId);
      const currentMutationEpoch = mutationEpoch;
      state.busy = true;
      state.message = "正在安全停止视觉读取";
      state.error = null;
      notify();
      const keyScope = `stop:${currentSession.sessionId}:user_requested`;
      return enqueueMutation({
        id: keyScope,
        kind: "stop",
        sessionId: currentSession.sessionId,
        run: async () => {
        try {
          const updated = await api.abortSession(
            currentSession.sessionId,
            { reasonCode: "user_requested" },
            semanticKey(keyScope)
          );
          semanticKeys.delete(keyScope);
          if (disposed || currentGeneration !== generation
            || currentMutationEpoch !== mutationEpoch || !context
            || state.session?.sessionId !== currentSession.sessionId) return;
          state.session = updated;
          state.message = "视觉读取已停止";
          refreshPresentation();
        } catch (error) {
          if (!disposed && currentGeneration === generation
            && currentMutationEpoch === mutationEpoch
            && state.session?.sessionId === currentSession.sessionId) {
            state.message = null;
            state.error = safeErrorMessage(error);
          }
          throw error;
        } finally {
          if (!disposed && currentGeneration === generation
            && currentMutationEpoch === mutationEpoch
            && state.session?.sessionId === currentSession.sessionId) {
            state.busy = false;
            notify();
          }
        }
        }
      });
    },
    retryProbe() {
      if (!context || disposed) return;
      state.extensionStatus = "probing";
      state.extensionVersion = null;
      state.message = "正在重新检测授权浏览器读取器";
      state.error = null;
      connectBridge();
      notify();
    },
    close() {
      generation += 1;
      reconcileSerial += 1;
      bridge?.destroy();
      bridge = null;
      context = null;
      startedSessionId = null;
      stoppingSessionId = null;
      batchKeys.clear();
      semanticKeys.clear();
      processingBatches.clear();
      resetMutationQueue();
      resetVisibleState();
      notify();
    },
    destroy() {
      if (disposed) return;
      controller.close();
      disposed = true;
      listeners.clear();
    }
  };

  return controller;
}
