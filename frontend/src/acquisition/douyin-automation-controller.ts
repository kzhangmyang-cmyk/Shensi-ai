import type {
  DouyinAccount, DouyinAutomationApi, DouyinCandidatePage, DouyinCrawlerStatus,
  DouyinLoginSession, DouyinPolicy, DouyinPolicyInput, DouyinRunCandidate, DouyinRunIntent
} from "./douyin-automation-api";

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
  crawlerStatus: DouyinCrawlerStatus | null;
  candidates: DouyinRunCandidate[];
  selectedCandidateIds: string[];
  error: string | null;
  suggestionError: string | null;
  closed: boolean;
}

export interface DouyinAutomationDraft {
  planName: string;
  policy: DouyinPolicyInput;
}

export interface DouyinAutomationController {
  getState(): DouyinAutomationState;
  subscribe(listener: (state: DouyinAutomationState) => void): () => void;
  load(planId: string | null, planName?: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  suggestKeywords(): Promise<void>;
  save(input: DouyinAutomationDraft): Promise<void>;
  saveAndRun(input: DouyinAutomationDraft): Promise<void>;
  savePolicy(input: DouyinPolicyInput): Promise<void>;
  runNow(): Promise<void>;
  toggleCandidate(candidateId: string): void;
  refreshRun(): Promise<void>;
  abort(): void;
  close(): void;
}

function key(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "未知错误"; }
const terminalStates = new Set(["succeeded", "partial", "paused", "cancelled", "failed"]);
const emptyPolicy = (): DouyinPolicyInput => ({
  keywords: [],
  schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3_600 }
});

export function createDouyinAutomationController(options: {
  api: DouyinAutomationApi;
  onPlanCreated?: (planId: string) => void;
  pollDelayMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): DouyinAutomationController {
  const listeners = new Set<(state: DouyinAutomationState) => void>();
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const pollDelayMs = options.pollDelayMs ?? 2_000;
  let generation = 0;
  let aborter = new AbortController();
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let runFlight: Promise<void> | null = null;
  let saveFlight: Promise<void> | null = null;
  let state: DouyinAutomationState = { phase: "idle", planId: null, planName: "", planStatus: null, account: null, loginSession: null, policy: null, draftPolicy: emptyPolicy(), runIntent: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null, suggestionError: null, closed: false };
  const emit = (patch: Partial<DouyinAutomationState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };
  const current = (value: number) => !state.closed && value === generation;
  const resetLifecycle = () => {
    generation += 1;
    aborter.abort();
    aborter = new AbortController();
    if (loginTimer) clearTimer(loginTimer);
    if (runTimer) clearTimer(runTimer);
    loginTimer = null; runTimer = null;
    return generation;
  };
  const pollLogin = async (sessionId: string, ownGeneration: number): Promise<void> => {
    if (!current(ownGeneration)) return;
    try {
      const loginSession = await options.api.getLoginSession(sessionId, aborter.signal);
      if (!current(ownGeneration)) return;
      emit({ loginSession, account: loginSession.account ?? state.account, phase: "ready", error: null });
      if (loginSession.state === "awaiting_scan" && Date.parse(loginSession.expiresAt) > Date.now()) {
        loginTimer = setTimer(() => void pollLogin(sessionId, ownGeneration), pollDelayMs);
      }
    } catch (error) {
      if (current(ownGeneration) && !(error instanceof DOMException && error.name === "AbortError")) emit({ phase: "error", error: message(error) });
    }
  };
  const refreshRunFor = async (runId: string, ownGeneration: number): Promise<void> => {
    if (!current(ownGeneration)) return;
    try {
      const [crawlerStatus, page] = await Promise.all([
        options.api.getCrawlerStatus(runId, aborter.signal),
        options.api.listRunCandidates(runId, aborter.signal)
      ]);
      if (!current(ownGeneration)) return;
      emit({ crawlerStatus, candidates: page.items, phase: "ready", error: null });
      if (!terminalStates.has(crawlerStatus.state)) {
        runTimer = setTimer(() => void refreshRunFor(runId, ownGeneration), pollDelayMs);
      }
    } catch (error) {
      if (current(ownGeneration) && !(error instanceof DOMException && error.name === "AbortError")) {
        emit({ phase: "error", error: message(error) });
        runTimer = setTimer(() => void refreshRunFor(runId, ownGeneration), pollDelayMs);
      }
    }
  };
  const persist = (input: DouyinAutomationDraft, runAfterSave: boolean): Promise<void> => {
    if (saveFlight) return saveFlight;
    const planName = input.planName.trim();
    const keywords = [...new Set(input.policy.keywords.map((keyword) => keyword.trim()).filter(Boolean))];
    if (!state.account || state.account.state !== "active") {
      emit({ phase: "error", error: "请先扫码连接抖音账号" });
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
        let created = false;
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
          created = true;
          emit({ planId, planName: approved.name || planName, planStatus: approved.status });
          policy = await options.api.getAutomation(planId, aborter.signal);
          if (!current(own)) return;
        }
        if (!policy) {
          policy = await options.api.getAutomation(planId, aborter.signal);
          if (!current(own)) return;
        }
        const saved = await options.api.putAutomation(planId, normalized, policy.etag, key("douyin-policy"), aborter.signal);
        if (!current(own)) return;
        emit({ phase: "ready", policy: saved, draftPolicy: normalized, planId, planName, planStatus: "approved", error: null });
        if (runAfterSave) await controller.runNow();
        if (created) options.onPlanCreated?.(planId);
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
    async load(planId, planName) {
      const own = resetLifecycle();
      emit({ phase: "loading", planId, planName: planName?.trim() ?? "", planStatus: planId ? "approved" : null, policy: null, draftPolicy: emptyPolicy(), error: null, suggestionError: null, runIntent: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [] });
      try {
        const accountPromise = options.api.listAccounts(aborter.signal);
        const policyPromise = planId ? options.api.getAutomation(planId, aborter.signal) : Promise.resolve(null);
        const [accountList, policy] = await Promise.all([accountPromise, policyPromise]);
        if (current(own)) emit({ phase: "ready", account: accountList.items.find((item) => item.state !== "disconnected") ?? null, policy, draftPolicy: policy ? { keywords: [...policy.keywords], schedule: { ...policy.schedule }, dailyCandidateLimit: policy.dailyCandidateLimit, collectCreators: policy.collectCreators, collectDemandComments: policy.collectDemandComments, limits: { ...policy.limits } } : emptyPolicy(), error: null });
      } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
    },
    async connect() {
      const own = resetLifecycle();
      emit({ phase: "loading", loginSession: null, error: null });
      try {
        const loginSession = await options.api.createLoginSession(key("douyin-login"), aborter.signal);
        if (!current(own)) return;
        emit({ phase: "ready", loginSession, account: loginSession.account ?? state.account });
        if (loginSession.state === "awaiting_scan") void pollLogin(loginSession.id, own);
      } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
    },
    async disconnect() {
      if (!state.account) return;
      const own = resetLifecycle();
      emit({ phase: "loading", error: null });
      try {
        await options.api.disconnectAccount(state.account.id, state.account.etag, key("douyin-disconnect"), aborter.signal);
        if (current(own)) emit({ phase: "ready", account: null, loginSession: null, runIntent: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [] });
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
      if (state.runIntent && !state.crawlerStatus) return Promise.resolve();
      if (state.crawlerStatus && !terminalStates.has(state.crawlerStatus.state)) {
        return Promise.resolve();
      }
      const own = generation;
      emit({ phase: "running", error: null });
      const flight = (async () => {
        try {
          const runIntent = await options.api.runNow(state.planId!, key("douyin-run"), aborter.signal);
          if (!current(own)) return;
          emit({ runIntent, phase: "ready", error: null });
          await refreshRunFor(runIntent.acquisitionRunId, own);
        } catch (error) { if (current(own)) emit({ phase: "error", error: message(error) }); }
      })();
      runFlight = flight;
      void flight.finally(() => { if (runFlight === flight) runFlight = null; });
      return flight;
    },
    toggleCandidate(candidateId) {
      const selected = new Set(state.selectedCandidateIds);
      if (selected.has(candidateId)) selected.delete(candidateId); else selected.add(candidateId);
      emit({ selectedCandidateIds: [...selected] });
    },
    async refreshRun() {
      if (state.runIntent) await refreshRunFor(state.runIntent.acquisitionRunId, generation);
    },
    abort() { if (!state.closed) resetLifecycle(); },
    close() { if (state.closed) return; resetLifecycle(); emit({ closed: true, phase: "idle" }); listeners.clear(); }
  };
  return controller;
}
