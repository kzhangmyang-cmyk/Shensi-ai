import {
  AcquisitionHttpError,
  isDouyinCommentOutreachCandidate,
  type DouyinAccount, type DouyinAutomationApi,
  type DouyinCrawlerStatus, type DouyinLoginInteraction, type DouyinLoginSession, type DouyinPolicy,
  type DouyinPolicyInput, type DouyinRunCandidate, type DouyinRunIntent
} from "./douyin-automation-api";
import { createAcquisitionBrowserRuntimes, DesktopLoginSyncError, isDesktopLoginSessionUnavailable } from "./acquisition-browser-runtime";
import { desktopAdmissionMessage } from "../desktop/desktop-admission-error";
import { getInstalledDesktopRuntime } from "../desktop/desktop-runtime";
import type { ConnectorStatus, DouyinCollectionStatus } from "../desktop/desktop-bridge";

export type DouyinAutomationPhase = "idle" | "loading" | "ready" | "saving" | "running" | "error";
export interface DouyinAutomationState {
  phase: DouyinAutomationPhase;
  planId: string | null;
  planName: string;
  planStatus: "draft" | "approved" | null;
  account: DouyinAccount | null;
  loginSession: DouyinLoginSession | null;
  policy: DouyinPolicy | null;
  draftPolicy: DouyinPolicyInput;
  runIntent: DouyinRunIntent | null;
  activeRunId: string | null;
  crawlerStatus: DouyinCrawlerStatus | null;
  localCrawlerStatus?: DouyinCollectionStatus | null;
  historicalRun?: boolean;
  candidates: DouyinRunCandidate[];
  selectedCandidateIds: string[];
  error: string | null;
  errorRetry?: "reload" | "reconnect" | "cancel" | null;
  connectionPending?: boolean;
  interactionPending?: boolean;
  suggestionError: string | null;
  connectorStatus?: ConnectorStatus | null;
  closed: boolean;
}

export interface DouyinAutomationDraft {
  planName: string;
  policy: DouyinPolicyInput;
}

export interface DouyinAutomationController {
  getState(): DouyinAutomationState;
  subscribe(listener: (state: DouyinAutomationState) => void): () => void;
  load(planId: string | null, planName?: string, latestRunId?: string | null): Promise<void>;
  connect(): Promise<void>;
  confirmLogin(): Promise<void>;
  cancelLogin(): Promise<void>;
  interactLogin(input: DouyinLoginInteraction): Promise<void>;
  disconnect(): Promise<void>;
  suggestKeywords(): Promise<void>;
  save(input: DouyinAutomationDraft): Promise<void>;
  saveAndRun(input: DouyinAutomationDraft): Promise<void>;
  savePolicy(input: DouyinPolicyInput): Promise<void>;
  runNow(): Promise<void>;
  controlCollection?(action: "pause" | "resume" | "stop"): Promise<void>;
  toggleCandidate(candidateId: string): void;
  selectAllCandidates(selected: boolean): void;
  refreshRun(): Promise<void>;
  restartConnector(): Promise<void>;
  abort(): void;
  close(): void;
}

function key(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "未知错误"; }
function loginMessage(error: unknown): string {
  const admission = desktopAdmissionMessage(error);
  if (admission) return admission;
  return error instanceof AcquisitionHttpError
    && (error.status >= 500 || ["internal_error", "http_500"].includes(error.code))
    ? "抖音登录服务暂时不可用，请稍后重新打开登录页。"
    : message(error);
}
function admissionFailure(error: unknown): string | null {
  return error instanceof DesktopLoginSyncError ? error.message : desktopAdmissionMessage(error);
}
function expiredLoginSession(session: DouyinLoginSession): DouyinLoginSession {
  return {
    ...session,
    state: "login_expired",
    qrImageDataUrl: null,
    qrStatus: null,
    loginPage: null,
    failureCode: null,
    authState: session.authState === undefined ? undefined : "expired",
    taskState: session.taskState === undefined ? undefined : "completed",
    screenshotAvailable: session.screenshotAvailable === undefined ? undefined : false,
    qrAvailable: session.qrAvailable === undefined ? undefined : false,
    account: null
  };
}
function isExpiredLoginError(error: unknown): boolean {
  return error instanceof AcquisitionHttpError
    && (error.status === 410 || error.code === "douyin_login_session_expired");
}
function isMissingCrawlerStatus(error: unknown): boolean {
  return error instanceof AcquisitionHttpError
    && error.status === 404
    && error.code === "crawler_status_not_found";
}
const terminalStates = new Set(["succeeded", "partial", "paused", "cancelled", "failed"]);
const requiresRunPolling = (status: DouyinCrawlerStatus) => !terminalStates.has(status.state)
  || status.candidateProjectionState === "pending";
const emptyPolicy = (): DouyinPolicyInput => ({
  keywords: [],
  schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: false,
  collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3_600 }
});

export function createDouyinAutomationController(options: {
  api: DouyinAutomationApi;
  onPlanSaved?: (planId: string) => void;
  pollDelayMs?: number;
  terminalCandidateRetryLimit?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): DouyinAutomationController {
  const desktopRuntime = getInstalledDesktopRuntime();
  const browserRuntimes = createAcquisitionBrowserRuntimes(options.api, {
    desktopBridge: desktopRuntime?.bridge,
    accountId: () => desktopRuntime?.accountId() ?? null,
    onLocalAccount: desktopRuntime ? (account, local) => desktopRuntime.acceptLocalAccount(account, local) : undefined
  });
  const listeners = new Set<(state: DouyinAutomationState) => void>();
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const pollDelayMs = options.pollDelayMs ?? 2_000;
  const terminalCandidateRetryLimit = options.terminalCandidateRetryLimit ?? 3;
  let generation = 0;
  let aborter = new AbortController();
  let loginGeneration = 0;
  let loginAborter = new AbortController();
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let loginInteractionRevision = 0;
  let interactionQueue: Promise<void> = Promise.resolve();
  let queuedInteractionCount = 0;
  let runTimer: { handle: ReturnType<typeof setTimeout>; runId: string; generation: number } | null = null;
  let runFlight: Promise<void> | null = null;
  let collectionControlFlight: Promise<void> | null = null;
  let runRefreshFlight: { runId: string; generation: number; promise: Promise<void> } | null = null;
  let terminalCandidateRetry: {
    runId: string;
    generation: number;
    failures: number;
  } | null = null;
  let saveFlight: Promise<void> | null = null;
  let connectFlight: Promise<void> | null = null;
  const cancelledLoginCreates = new Set<number>();
  let loginCancellation: {
    identity: string | (() => Promise<void>);
    promise: Promise<void>;
  } | null = null;
  let state: DouyinAutomationState = { phase: "idle", planId: null, planName: "", planStatus: null, account: null, loginSession: null, policy: null, draftPolicy: emptyPolicy(), runIntent: null, activeRunId: null, crawlerStatus: null, historicalRun: false, candidates: [], selectedCandidateIds: [], error: null, errorRetry: null, connectionPending: false, interactionPending: false, suggestionError: null, connectorStatus: desktopRuntime?.connectorStatus() ?? null, closed: false };
  const emit = (patch: Partial<DouyinAutomationState>) => {
    const normalized = patch.error === null
      ? { ...patch, errorRetry: null }
      : patch.phase === "error" && patch.error && patch.errorRetry === undefined
        ? { ...patch, errorRetry: "reload" as const }
        : patch;
    state = { ...state, ...normalized };
    if (patch.candidates !== undefined || patch.selectedCandidateIds !== undefined) {
      const eligible = new Set(state.candidates.filter(isDouyinCommentOutreachCandidate).map((candidate) => candidate.id));
      state.selectedCandidateIds = [...new Set(state.selectedCandidateIds)].filter((id) => eligible.has(id));
    }
    listeners.forEach((listener) => listener(state));
  };
  const unsubscribeConnector = desktopRuntime?.subscribe((connectorStatus) => {
    emit({ connectorStatus });
  }) ?? (() => undefined);
  const current = (value: number) => !state.closed && value === generation;
  const currentLogin = (value: number) => !state.closed && value === loginGeneration;
  const resetLoginLifecycle = () => {
    loginGeneration += 1;
    loginAborter.abort();
    loginAborter = new AbortController();
    if (loginTimer) clearTimer(loginTimer);
    loginTimer = null;
    loginInteractionRevision = 0;
    interactionQueue = Promise.resolve();
    queuedInteractionCount = 0;
    connectFlight = null;
    return loginGeneration;
  };
  const resetLifecycle = () => {
    generation += 1;
    aborter.abort();
    aborter = new AbortController();
    resetLoginLifecycle();
    if (runTimer) clearTimer(runTimer.handle);
    runTimer = null;
    runRefreshFlight = null;
    terminalCandidateRetry = null;
    return generation;
  };
  const cancelLoginSessionTracked = (
    session: Pick<DouyinLoginSession, "id" | "interactionSurface"> | (() => Promise<void>)
  ): Promise<void> => {
    const identity = typeof session === "function" ? session : session.id;
    if (loginCancellation?.identity === identity) return loginCancellation.promise;
    const prior = loginCancellation?.promise.catch(() => undefined)
      ?? Promise.resolve();
    const tracked = {
      identity,
      promise: prior
        .then(() => typeof session === "function" ? session()
          : browserRuntimes.forSession(session).cancelLogin(session.id))
    };
    loginCancellation = tracked;
    void tracked.promise.then(() => {
      if (loginCancellation === tracked) loginCancellation = null;
    }, () => {
      if (loginCancellation === tracked) loginCancellation = null;
    });
    return tracked.promise;
  };
  const cancelLoginSessionBestEffort = (
    session: Pick<DouyinLoginSession, "id" | "interactionSurface">
  ): Promise<void> => cancelLoginSessionTracked(session).catch(() => undefined);
  const cancelAwaitingLoginBestEffort = () => {
    if (state.loginSession?.state !== "awaiting_scan") return;
    void cancelLoginSessionBestEffort(state.loginSession);
  };
  const pollLogin = async (sessionId: string, ownGeneration: number): Promise<void> => {
    if (!currentLogin(ownGeneration)) return;
    const observedInteractionRevision = loginInteractionRevision;
    try {
      const activeSession = state.loginSession;
      if (!activeSession || activeSession.id !== sessionId) return;
      const loginSession = await browserRuntimes.forSession(activeSession)
        .getStatus(sessionId, loginAborter.signal);
      if (!currentLogin(ownGeneration)) return;
      if (observedInteractionRevision !== loginInteractionRevision) {
        if (state.loginSession?.state === "awaiting_scan"
          && !state.loginSession.failureCode
          && Date.parse(state.loginSession.expiresAt) > Date.now()
          && !state.interactionPending
          && loginTimer === null) {
          loginTimer = setTimer(() => void pollLogin(sessionId, ownGeneration), pollDelayMs);
        }
        return;
      }
      const observedSession = loginSession.state === "awaiting_scan"
        && Date.parse(loginSession.expiresAt) <= Date.now()
        ? expiredLoginSession(loginSession)
        : loginSession;
      emit({
        loginSession: observedSession,
        account: observedSession.account ?? state.account,
        phase: "ready",
        error: null,
        connectionPending: false,
        interactionPending: false
      });
      if (observedSession.state === "awaiting_scan" && !observedSession.failureCode
        && Date.parse(observedSession.expiresAt) > Date.now()) {
        loginTimer = setTimer(() => void pollLogin(sessionId, ownGeneration), pollDelayMs);
      }
    } catch (error) {
      if (!currentLogin(ownGeneration)
        || error instanceof DOMException && error.name === "AbortError") return;
      const admission = admissionFailure(error);
      if (admission) {
        emit({ phase: "ready",
          loginSession: error instanceof DesktopLoginSyncError ? error.session : state.loginSession,
          error: admission, errorRetry: null, connectionPending: false, interactionPending: false });
        return;
      }
      const activeSession = state.loginSession;
      if (!activeSession || activeSession.id !== sessionId
        || activeSession.state !== "awaiting_scan" || activeSession.failureCode) return;
      if (isDesktopLoginSessionUnavailable(error)) {
        emit({ phase: "ready", loginSession: expiredLoginSession(activeSession),
          error: "本机登录会话已结束，请重新打开抖音登录。", errorRetry: "reconnect",
          connectionPending: false, interactionPending: false });
        return;
      }
      if (Date.parse(activeSession.expiresAt) <= Date.now()) {
        emit({
          phase: "ready",
          loginSession: expiredLoginSession(activeSession),
          error: null,
          connectionPending: false,
          interactionPending: false
        });
        return;
      }
      if (observedInteractionRevision === loginInteractionRevision) emit({
        phase: "ready",
        error: "抖音登录状态暂时不可用，正在自动重试；请保持登录窗口打开。",
        errorRetry: null,
        connectionPending: false
      });
      loginTimer = setTimer(() => void pollLogin(sessionId, ownGeneration), pollDelayMs);
    }
  };
  const clearRunTimer = () => {
    if (!runTimer) return;
    clearTimer(runTimer.handle);
    runTimer = null;
  };
  const scheduleRunRefresh = (
    runId: string,
    ownGeneration: number,
    delayMs = pollDelayMs
  ) => {
    if (!current(ownGeneration)) return;
    clearRunTimer();
    const timer = { handle: null as unknown as ReturnType<typeof setTimeout>, runId, generation: ownGeneration };
    timer.handle = setTimer(() => {
      if (runTimer === timer) runTimer = null;
      void refreshRunFor(runId, ownGeneration);
    }, delayMs);
    runTimer = timer;
  };
  const readCandidatePages = async (runId: string, signal: AbortSignal): Promise<DouyinRunCandidate[]> => {
    const candidates = new Map<string, DouyinRunCandidate>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    while (!signal.aborted) {
      signal.throwIfAborted();
      const page = await options.api.listRunCandidates(runId, signal, cursor ? { cursor } : undefined);
      signal.throwIfAborted();
      page.items.forEach((candidate) => candidates.set(candidate.id, candidate));
      if (page.nextCursor === null) return [...candidates.values()];
      if (seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("候选人分页未能完整读取，请刷新重试");
  };
  const refreshRunFor = (runId: string, ownGeneration: number): Promise<void> => {
    if (!current(ownGeneration)) return Promise.resolve();
    const existing = runRefreshFlight;
    if (existing && existing.runId === runId && existing.generation === ownGeneration) return existing.promise;
    clearRunTimer();
    const flight = (async () => {
      let validatedStatus: DouyinCrawlerStatus | null = null;
      try {
        const crawlerStatus = await options.api.getCrawlerStatus(runId, aborter.signal);
        if (!current(ownGeneration)) return;
        if (crawlerStatus.runId !== runId) throw new Error("服务器返回的采集状态与当前运行不匹配");
        validatedStatus = crawlerStatus;
        const candidates = await readCandidatePages(runId, aborter.signal);
        if (!current(ownGeneration)) return;
        terminalCandidateRetry = null;
        emit({ crawlerStatus,
          localCrawlerStatus: terminalStates.has(crawlerStatus.state) ? null
            : browserRuntimes.desktop.getCollectionStatusForRun(runId),
          historicalRun: false, candidates, phase: "ready", error: null });
        if (requiresRunPolling(crawlerStatus)) scheduleRunRefresh(runId, ownGeneration);
      } catch (error) {
        if (current(ownGeneration) && !(error instanceof DOMException && error.name === "AbortError")) {
          if (isMissingCrawlerStatus(error) && state.runIntent === null) {
            try {
              const candidates = await readCandidatePages(runId, aborter.signal);
              if (!current(ownGeneration)) return;
              terminalCandidateRetry = null;
              emit({
                crawlerStatus: null,
                localCrawlerStatus: null,
                historicalRun: true,
                candidates,
                phase: "ready",
                error: null
              });
            } catch (candidateError) {
              if (current(ownGeneration)
                && !(candidateError instanceof DOMException
                  && candidateError.name === "AbortError")) {
                emit({
                  phase: "error",
                  error: message(candidateError)
                });
              }
            }
            return;
          }
          emit({ ...(validatedStatus ? { crawlerStatus: validatedStatus } : {}),
            localCrawlerStatus: validatedStatus && terminalStates.has(validatedStatus.state) ? null
              : browserRuntimes.desktop.getCollectionStatusForRun(runId),
            phase: "error", error: message(error) });
          if (!validatedStatus || requiresRunPolling(validatedStatus)) {
            scheduleRunRefresh(runId, ownGeneration);
          } else {
            if (!terminalCandidateRetry
              || terminalCandidateRetry.runId !== runId
              || terminalCandidateRetry.generation !== ownGeneration) {
              terminalCandidateRetry = {
                runId,
                generation: ownGeneration,
                failures: 0
              };
            }
            if (terminalCandidateRetry.failures < terminalCandidateRetryLimit) {
              const delayMs = pollDelayMs * (2 ** terminalCandidateRetry.failures);
              terminalCandidateRetry.failures += 1;
              scheduleRunRefresh(runId, ownGeneration, delayMs);
            }
          }
        }
      }
    })();
    runRefreshFlight = { runId, generation: ownGeneration, promise: flight };
    void flight.finally(() => {
      if (runRefreshFlight?.promise === flight) runRefreshFlight = null;
    });
    return flight;
  };
  const persist = (input: DouyinAutomationDraft, runAfterSave: boolean): Promise<void> => {
    if (saveFlight) return saveFlight;
    const planName = input.planName.trim();
    const keywords = [...new Set(input.policy.keywords.map((keyword) => keyword.trim()).filter(Boolean))];
    if (!state.account || state.account.state !== "active") {
      emit({ phase: "error", error: "请先连接抖音账号" });
      return Promise.resolve();
    }
    if (!planName) {
      emit({ phase: "error", error: "请输入计划名称" });
      return Promise.resolve();
    }
    if (keywords.length === 0) {
      emit({ phase: "error", error: "至少添加 1 个关键词" });
      return Promise.resolve();
    }
    const own = generation;
    const normalized: DouyinPolicyInput = { ...input.policy, keywords };
    emit({ phase: "saving", planName, draftPolicy: normalized, error: null });
    const flight = (async () => {
      try {
        let planId = state.planId;
        let policy = state.policy;
        let savedPlanName = planName;
        if (!planId) {
          const plan = await options.api.createPlan({
            name: planName,
            keywords,
            dailyCandidateLimit: normalized.dailyCandidateLimit
          }, key("douyin-plan"), aborter.signal);
          if (!current(own)) return;
          const approved = plan.status === "approved"
            ? plan
            : await options.api.approvePlan(plan.id, plan.etag, aborter.signal);
          if (!current(own)) return;
          planId = approved.id;
          savedPlanName = approved.name;
          emit({ planId, planName: savedPlanName, planStatus: approved.status });
          policy = await options.api.getAutomation(planId, aborter.signal);
          if (!current(own)) return;
        } else {
          const approved = await options.api.savePlanName(planId, planName, aborter.signal, keywords);
          if (!current(own)) return;
          savedPlanName = approved.name;
          emit({ planName: savedPlanName, planStatus: approved.status });
          // A plan revision changes the policy's frozen plan identity. Read its
          // current ETag before publishing the new policy against that version.
          policy = await options.api.getAutomation(planId, aborter.signal);
          if (!current(own)) return;
        }
        if (!policy) {
          policy = await options.api.getAutomation(planId, aborter.signal);
          if (!current(own)) return;
        }
        const saved = await options.api.putAutomation(planId, normalized, policy.etag, key("douyin-policy"), aborter.signal);
        if (!current(own)) return;
        emit({ phase: "ready", policy: saved, draftPolicy: normalized, planId, planName: savedPlanName, planStatus: "approved", error: null });
        if (runAfterSave) await controller.runNow();
        if (current(own) && state.phase !== "error") options.onPlanSaved?.(planId);
      } catch (error) {
        if (current(own) && !(error instanceof DOMException && error.name === "AbortError")) emit({ phase: "error", error: message(error) });
      }
    })();
    saveFlight = flight;
    void flight.finally(() => { if (saveFlight === flight) saveFlight = null; });
    return flight;
  };
  const controller: DouyinAutomationController = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async load(planId, planName, latestRunId = null) {
      const own = resetLifecycle();
      const restoredRunId = planId ? latestRunId?.trim() || null : null;
      emit({ phase: "loading", planId, planName: planName?.trim() ?? "", planStatus: planId ? "approved" : null, policy: null, draftPolicy: emptyPolicy(), error: null, connectionPending: false, interactionPending: false, suggestionError: null, runIntent: null, activeRunId: restoredRunId, crawlerStatus: null, localCrawlerStatus: null, historicalRun: false, candidates: [], selectedCandidateIds: [] });
      try {
        const accountPromise = options.api.listAccounts(aborter.signal);
        const policyPromise = planId ? options.api.getAutomation(planId, aborter.signal) : Promise.resolve(null);
        const [accountList, policy] = await Promise.all([accountPromise, policyPromise]);
        if (!current(own)) return;
        emit({ phase: "ready", account: accountList.items.find((item) => item.state !== "disconnected") ?? null, policy, draftPolicy: policy ? { keywords: [...policy.keywords], schedule: { ...policy.schedule }, dailyCandidateLimit: policy.dailyCandidateLimit, collectCreators: policy.collectCreators, collectDemandComments: policy.collectDemandComments, limits: { ...policy.limits } } : emptyPolicy(), error: null });
        if (restoredRunId) await refreshRunFor(restoredRunId, own);
      } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
    },
    connect() {
      if (connectFlight) return connectFlight;
      if (state.loginSession?.state === "awaiting_scan"
        && !state.loginSession.failureCode
        && (state.loginSession.interactionSurface === "external_window"
          || state.loginSession.qrStatus === "opening")) {
        return Promise.resolve();
      }
      const previousSessionId = state.loginSession?.state === "awaiting_scan"
        ? state.loginSession.id
        : null;
      const previousSession = state.loginSession?.state === "awaiting_scan"
        ? state.loginSession
        : null;
      const browserRuntime = browserRuntimes.forSession(previousSession);
      const pendingCancellation = previousSessionId
        ? cancelLoginSessionTracked(previousSession!)
        : loginCancellation?.promise ?? null;
      let cancellationCompleted = pendingCancellation === null;
      const own = resetLoginLifecycle();
      emit({ phase: "loading", loginSession: previousSession, error: null,
        connectionPending: true, interactionPending: false });
      const flight = (async () => {
        try {
          if (pendingCancellation) {
            await pendingCancellation;
            cancellationCompleted = true;
          }
          if (!currentLogin(own)) return;
          if (previousSessionId
            && state.loginSession?.id === previousSessionId) {
            emit({ loginSession: null });
          }
          const loginSession = await browserRuntime.startLogin(
            key("douyin-login"), loginAborter.signal
          );
          if (cancelledLoginCreates.delete(own)) {
            if (!state.closed && loginGeneration === own + 1) {
              emit({ loginSession, connectionPending: false, interactionPending: true });
            }
            try {
              await browserRuntimes.forSession(loginSession).cancelLogin(loginSession.id);
              if (!state.closed && loginGeneration === own + 1) emit({ phase: "ready", loginSession: null,
                error: null, connectionPending: false, interactionPending: false });
            } catch (error) {
              if (!state.closed && loginGeneration === own + 1) emit({ phase: "error", loginSession,
                error: `取消登录失败：${loginMessage(error)}`, errorRetry: "cancel",
                connectionPending: false, interactionPending: false });
            }
            return;
          }
          if (!currentLogin(own)) return;
          emit({ phase: "ready", loginSession, account: loginSession.account ?? state.account, connectionPending: false });
          if (loginSession.state === "awaiting_scan" && !loginSession.failureCode) {
            void pollLogin(loginSession.id, own);
          }
        } catch (error) {
          if (!currentLogin(own)) return;
          if (error instanceof DesktopLoginSyncError) {
            emit({ phase: "ready", loginSession: error.session, error: error.message,
              errorRetry: null, connectionPending: false, interactionPending: false });
            return;
          }
          if (!cancellationCompleted && previousSession) {
            emit({ phase: "error", loginSession: previousSession,
              error: `取消旧登录失败：${loginMessage(error)}`,
              errorRetry: "cancel", connectionPending: false,
              interactionPending: false });
            return;
          }
          emit({ phase: "error", error: loginMessage(error),
            errorRetry: "reconnect", connectionPending: false });
        }
      })();
      connectFlight = flight;
      void flight.finally(() => {
        if (connectFlight === flight) connectFlight = null;
      });
      return flight;
    },
    async confirmLogin() {
      const activeSession = state.loginSession;
      if (!activeSession || activeSession.state !== "awaiting_scan"
        || activeSession.failureCode) return;
      if (Date.parse(activeSession.expiresAt) <= Date.now()) {
        if (loginTimer) clearTimer(loginTimer);
        loginTimer = null;
        emit({
          phase: "ready",
          loginSession: expiredLoginSession(activeSession),
          error: null,
          interactionPending: false
        });
        return;
      }
      const own = loginGeneration;
      const sessionId = activeSession.id;
      loginInteractionRevision += 1;
      if (loginTimer) clearTimer(loginTimer);
      loginTimer = null;
      emit({ interactionPending: true, error: null });
      try {
        const loginSession = await browserRuntimes.forSession(activeSession)
          .confirmLogin(sessionId, loginAborter.signal);
        if (!currentLogin(own) || state.loginSession?.id !== sessionId) return;
        emit({
          phase: "ready",
          loginSession,
          account: loginSession.account ?? state.account,
          error: null,
          connectionPending: false
        });
        if (loginSession.state === "awaiting_scan" && !loginSession.failureCode
          && Date.parse(loginSession.expiresAt) > Date.now()) {
          loginTimer = setTimer(() => void pollLogin(sessionId, own), pollDelayMs);
        }
      } catch (error) {
        if (!currentLogin(own) || state.loginSession?.id !== sessionId
          || error instanceof DOMException && error.name === "AbortError") return;
        const admission = admissionFailure(error);
        if (admission) {
          emit({ phase: "ready",
            loginSession: error instanceof DesktopLoginSyncError ? error.session : state.loginSession,
            error: admission, errorRetry: null, connectionPending: false });
        } else if (isExpiredLoginError(error) || isDesktopLoginSessionUnavailable(error)) {
          emit({
            phase: "ready",
            loginSession: expiredLoginSession(state.loginSession),
            error: null
          });
        } else {
          emit({
            phase: "ready",
            error: `登录状态检测失败：${loginMessage(error)}`,
            errorRetry: null
          });
          loginTimer = setTimer(() => void pollLogin(sessionId, own), pollDelayMs);
        }
      } finally {
        if (currentLogin(own) && state.loginSession?.id === sessionId) {
          emit({ interactionPending: false });
        }
      }
    },
    async cancelLogin() {
      if (connectFlight && !state.loginSession) {
        cancelledLoginCreates.add(loginGeneration);
        loginGeneration += 1;
        emit({ interactionPending: true });
        return;
      }
      const session = state.loginSession?.state === "awaiting_scan"
        ? state.loginSession : null;
      if (!session) return;
      if (loginTimer) clearTimer(loginTimer);
      loginTimer = null;
      emit({ interactionPending: true, error: null });
      try {
        await browserRuntimes.forSession(session).cancelLogin(session.id);
        resetLoginLifecycle();
        emit({ phase: "ready", loginSession: null, error: null,
          connectionPending: false, interactionPending: false });
      } catch (error) {
        emit({ phase: "error", loginSession: session,
          error: `取消登录失败：${loginMessage(error)}`, errorRetry: "cancel",
          connectionPending: false, interactionPending: false });
      }
    },
    interactLogin(input) {
      const activeSession = state.loginSession;
      if (!activeSession || activeSession.state !== "awaiting_scan"
        || activeSession.failureCode) return Promise.resolve();
      if (Date.parse(activeSession.expiresAt) <= Date.now()) {
        if (loginTimer) clearTimer(loginTimer);
        loginTimer = null;
        emit({
          phase: "ready",
          loginSession: expiredLoginSession(activeSession),
          error: null,
          interactionPending: false
        });
        return Promise.resolve();
      }
      const own = loginGeneration;
      const sessionId = activeSession.id;
      const signal = loginAborter.signal;
      loginInteractionRevision += 1;
      queuedInteractionCount += 1;
      emit({ interactionPending: true, error: null });
      const flight = interactionQueue.then(async () => {
        if (!currentLogin(own) || state.loginSession?.id !== sessionId
          || state.loginSession.state !== "awaiting_scan") return;
        try {
          const loginSession = await options.api.interactLoginSession(sessionId, input, signal);
          if (!currentLogin(own) || state.loginSession?.id !== sessionId
            || state.account?.state === "active") return;
          if ((loginSession.state !== "awaiting_scan" || loginSession.failureCode) && loginTimer) {
            clearTimer(loginTimer);
            loginTimer = null;
          }
          emit({
            loginSession,
            account: loginSession.account ?? state.account,
            phase: "ready",
            error: null
          });
        } catch (error) {
          if (currentLogin(own) && state.loginSession?.id === sessionId
            && isExpiredLoginError(error)) {
            if (loginTimer) clearTimer(loginTimer);
            loginTimer = null;
            emit({
              phase: "ready",
              loginSession: expiredLoginSession(state.loginSession),
              error: null,
              interactionPending: false
            });
          } else if (currentLogin(own) && !(error instanceof DOMException && error.name === "AbortError")) {
            emit({ phase: "ready", error: `登录页操作失败：${loginMessage(error)}` });
          }
        }
      });
      interactionQueue = flight.catch(() => undefined);
      return flight.finally(() => {
        if (!currentLogin(own)) return;
        queuedInteractionCount = Math.max(0, queuedInteractionCount - 1);
        if (queuedInteractionCount === 0) emit({ interactionPending: false });
      });
    },
    async disconnect() {
      if (!state.account) return;
      const cancelLocalLogin = browserRuntimes.forSession(null).kind === "desktop"
        ? browserRuntimes.desktop.captureLoginCancellation() : null;
      const own = resetLifecycle();
      emit({ phase: "loading", error: null, localCrawlerStatus: null, connectionPending: false, interactionPending: false });
      try {
        await options.api.disconnectAccount(state.account.id, state.account.etag, key("douyin-disconnect"), aborter.signal);
        // Cloud success must release the captured login even after route exit.
        const cancellation = cancelLocalLogin ? cancelLoginSessionTracked(cancelLocalLogin) : null;
        if (current(own)) emit({ phase: "ready", account: null, loginSession: null, runIntent: null, activeRunId: null, crawlerStatus: null, historicalRun: false, candidates: [], selectedCandidateIds: [] });
        if (cancellation) await cancellation;
      } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
    },
    async suggestKeywords() {
      if (!state.planId || !state.policy) return;
      const own = generation;
      emit({ phase: "loading", error: null, suggestionError: null });
      try {
        const result = await options.api.suggestKeywords(state.planId, key("douyin-keywords"), aborter.signal);
        if (current(own)) emit({ phase: "ready", policy: { ...state.policy!, keywords: result.keywords }, draftPolicy: { ...state.draftPolicy, keywords: [...result.keywords] }, error: null });
      } catch (error) { if (current(own)) emit({ phase: "ready", suggestionError: `${message(error)}；仍可手工输入关键词` }); }
    },
    save(input) { return persist(input, false); },
    saveAndRun(input) { return persist(input, true); },
    async savePolicy(input) {
      return persist({ planName: state.planName || "抖音自动获客计划", policy: input }, false);
    },
    runNow() {
      if (runFlight) return runFlight;
      if (!state.planId) return Promise.resolve();
      if (state.activeRunId && (!state.crawlerStatus
        || state.crawlerStatus.runId !== state.activeRunId)) return Promise.resolve();
      if (state.crawlerStatus && requiresRunPolling(state.crawlerStatus)) {
        return Promise.resolve();
      }
      const own = generation;
      emit({ phase: "running", error: null, runIntent: null, activeRunId: null,
        crawlerStatus: null, localCrawlerStatus: null, historicalRun: false,
        candidates: [], selectedCandidateIds: [] });
      const flight = (async () => {
        try {
          const runIntent = await browserRuntimes.forSession(state.loginSession)
            .startCollection(state.planId!, key("douyin-run"), aborter.signal);
          if (!current(own)) return;
          terminalCandidateRetry = null;
          emit({ runIntent, activeRunId: runIntent.acquisitionRunId, crawlerStatus: null, localCrawlerStatus: null, historicalRun: false, candidates: [], selectedCandidateIds: [], phase: "ready", error: null });
          await refreshRunFor(runIntent.acquisitionRunId, own);
        } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
      })();
      runFlight = flight;
      void flight.finally(() => { if (runFlight === flight) runFlight = null; });
      return flight;
    },
    selectAllCandidates(selected) {
      emit({ selectedCandidateIds: selected
        ? state.candidates.filter(isDouyinCommentOutreachCandidate).map((candidate) => candidate.id) : [] });
    },
    toggleCandidate(candidateId) {
      const candidate = state.candidates.find((item) => item.id === candidateId);
      if (!candidate || !isDouyinCommentOutreachCandidate(candidate)) return;
      const selected = new Set(state.selectedCandidateIds);
      if (selected.has(candidateId)) selected.delete(candidateId); else selected.add(candidateId);
      emit({ selectedCandidateIds: [...selected] });
    },
    async refreshRun() {
      if (state.activeRunId) await refreshRunFor(state.activeRunId, generation);
    },
    controlCollection(action) {
      if (collectionControlFlight) return collectionControlFlight;
      const runId = state.activeRunId;
      const ownGeneration = generation;
      if (!runId) return Promise.resolve();
      collectionControlFlight = (async () => {
        try {
          await browserRuntimes.desktop.controlCollectionForRun(runId, action);
          if (current(ownGeneration) && state.activeRunId === runId) {
            emit({ localCrawlerStatus: browserRuntimes.desktop.getCollectionStatusForRun(runId), error: null });
          }
        } catch (error) {
          if (current(ownGeneration)) emit({ error: message(error) });
        } finally { collectionControlFlight = null; }
      })();
      return collectionControlFlight;
    },
    async restartConnector() {
      if (!desktopRuntime) return;
      try {
        emit({ connectorStatus: { state: "starting", protocolVersion: null, diagnostic: null }, error: null });
        await desktopRuntime.restartConnector();
      } catch (error) {
        emit({ connectorStatus: { state: "crashed", protocolVersion: null, diagnostic: {
          code: "connector_restart_failed", message: loginMessage(error), recoverable: true,
          occurredAt: new Date().toISOString()
        } } });
      }
    },
    abort() {
      if (state.closed) return;
      if (connectFlight && !state.loginSession) {
        cancelledLoginCreates.add(loginGeneration);
      }
      cancelAwaitingLoginBestEffort();
      resetLifecycle();
      emit({ loginSession: null, localCrawlerStatus: null, connectionPending: false, interactionPending: false });
    },
    close() {
      if (state.closed) return;
      if (connectFlight && !state.loginSession) {
        cancelledLoginCreates.add(loginGeneration);
      }
      cancelAwaitingLoginBestEffort();
      resetLifecycle();
      emit({
        closed: true,
        phase: "idle",
        loginSession: null,
        localCrawlerStatus: null,
        connectionPending: false,
        interactionPending: false
      });
      listeners.clear();
      unsubscribeConnector();
    }
  };
  return controller;
}
