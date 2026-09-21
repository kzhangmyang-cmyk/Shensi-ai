import { GrowthApiError } from "../http";
import type { FinancialCouncilCollaboration, FinancialCouncilRunHistory } from "../contracts";
import type {
  CreateCouncilRunFromPackageInput,
  FinancialCouncilApi,
  FinancialCouncilApprovalInput,
  FinancialCouncilDispatchPage,
  FinancialCouncilPolicy,
  FinancialCouncilPolicyInput,
  FinancialCouncilPortfolioRevisionInput,
  FinancialCouncilRejectInput,
  FinancialCouncilRun,
  FinancialCouncilRunEventPage
} from "./api";

const TERMINAL_RUN_STATUSES = new Set([
  "approved", "rejected", "stale", "expired", "failed", "not_computable"
]);
const TERMINAL_DISPATCH_STATUSES = new Set(["succeeded", "failed"]);

export type FinancialCouncilBusy =
  | "loading"
  | "creating"
  | "updating_policy"
  | "revising"
  | "approving"
  | "rejecting"
  | null;

export interface FinancialCouncilControllerState {
  readonly collaboration?: FinancialCouncilCollaboration | null;
  readonly collaborationUpdating?: boolean;
  readonly history?: FinancialCouncilRunHistory | null;
  readonly run: FinancialCouncilRun | null;
  readonly events: FinancialCouncilRunEventPage | null;
  readonly policy: FinancialCouncilPolicy | null;
  readonly dispatches: FinancialCouncilDispatchPage | null;
  readonly selectedPortfolioKind: "balanced" | "cash_first" | "growth_first" | null;
  readonly editDraft: FinancialCouncilPortfolioRevisionInput | null;
  readonly busy: FinancialCouncilBusy;
  readonly error: string | null;
  readonly lastUpdatedAt: string | null;
}

export interface FinancialCouncilControllerOptions {
  readonly api: FinancialCouncilApi;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
  readonly schedulePoll?: (callback: () => void, delay: number) => unknown;
  readonly cancelPoll?: (handle: unknown) => void;
}

export interface FinancialCouncilController {
  getState(): FinancialCouncilControllerState;
  subscribe(listener: (state: FinancialCouncilControllerState) => void): () => void;
  open(runId: string): Promise<void>;
  openLatest(): Promise<void>;
  loadMoreHistory(): Promise<void>;
  retry(): Promise<void>;
  create(input: Parameters<FinancialCouncilApi["createRun"]>[0]): Promise<void>;
  createFromStatementPackage(input: CreateCouncilRunFromPackageInput): Promise<void>;
  updatePolicy(input: FinancialCouncilPolicyInput): Promise<void>;
  selectPortfolio(kind: FinancialCouncilControllerState["selectedPortfolioKind"]): void;
  setEditDraft(draft: FinancialCouncilPortfolioRevisionInput | null): void;
  revise(input?: FinancialCouncilPortfolioRevisionInput): Promise<void>;
  approve(input: FinancialCouncilApprovalInput): Promise<void>;
  reject(input: FinancialCouncilRejectInput): Promise<void>;
  close(): void;
  destroy(): void;
}

function initialState(): FinancialCouncilControllerState {
  return Object.freeze({
    run: null,
    collaboration: null,
    collaborationUpdating: false,
    history: null,
    events: null,
    policy: null,
    dispatches: null,
    selectedPortfolioKind: null,
    editDraft: null,
    busy: null,
    error: null,
    lastUpdatedAt: null
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof GrowthApiError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function isTerminal(run: FinancialCouncilRun): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

function dispatchesComplete(dispatches: FinancialCouncilDispatchPage | null): boolean {
  if (!dispatches) return false;
  const items = dispatches.items as readonly { status: string }[];
  return items.every((item) => TERMINAL_DISPATCH_STATUSES.has(item.status));
}

function historyWithRun(
  page: FinancialCouncilRunHistory | null | undefined,
  run: FinancialCouncilRun
): FinancialCouncilRunHistory | null {
  if (!page) return null;
  const summary: FinancialCouncilRunHistory["items"][number] = {
    runId: run.runId, status: run.status, currency: run.currency,
    dataAsOf: run.dataAsOf, createdAt: run.createdAt, updatedAt: run.updatedAt
  };
  const existing = page.items.some(item => item.runId === run.runId);
  const items = existing ? page.items.map(item => item.runId === run.runId ? summary : item)
    : [...page.items, summary].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ...page, items };
}

export function createFinancialCouncilController(
  options: FinancialCouncilControllerOptions
): FinancialCouncilController {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory
    ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const schedulePoll = options.schedulePoll
    ?? ((callback, delay) => setTimeout(callback, delay));
  const cancelPoll = options.cancelPoll ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const listeners = new Set<(state: FinancialCouncilControllerState) => void>();
  const semanticKeys = new Map<string, string>();
  let state = initialState();
  let generation = 0;
  let refreshGeneration = 0;
  let destroyed = false;
  let activeRunId: string | null = null;
  let pollHandle: unknown = null;
  let pollAbort: AbortController | null = null;
  let runEtag: string | null = null;
  let policyEtag: string | null = null;
  const commandAborts = new Set<AbortController>();

  function publish(next: Partial<FinancialCouncilControllerState>): void {
    if (destroyed) return;
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) listener(state);
  }

  function stopPolling(): void {
    if (pollHandle !== null) cancelPoll(pollHandle);
    pollHandle = null;
    pollAbort?.abort();
    pollAbort = null;
  }

  function stopCommands(): void {
    for (const abort of commandAborts) abort.abort();
    commandAborts.clear();
  }

  function commandAbort(): AbortController {
    const abort = new AbortController();
    commandAborts.add(abort);
    return abort;
  }

  function generationCurrent(expected: number): boolean {
    return !destroyed && generation === expected;
  }

  function newGeneration(): number {
    generation += 1;
    refreshGeneration += 1;
    runEtag = null;
    policyEtag = null;
    stopPolling();
    stopCommands();
    return generation;
  }

  function current(expected: number, runId: string): boolean {
    return !destroyed && generation === expected && activeRunId === runId;
  }

  function keyFor(kind: string, input: unknown): [string, () => void] {
    const semantic = `${kind}:${stableValue(input)}`;
    let key = semanticKeys.get(semantic);
    if (!key) {
      key = `council-${kind}:${idFactory()}`;
      semanticKeys.set(semantic, key);
    }
    return [key, () => semanticKeys.delete(semantic)];
  }

  function schedule(run: FinancialCouncilRun, expected: number): void {
    if (destroyed || generation !== expected) return;
    if (isTerminal(run) && (run.status !== "approved" || dispatchesComplete(state.dispatches))) return;
    if (pollHandle !== null) cancelPoll(pollHandle);
    pollHandle = schedulePoll(() => {
      pollHandle = null;
      void refresh(expected, run.runId, true);
    }, pollIntervalMs);
  }

  async function refresh(
    expected: number,
    runId: string,
    polling: boolean
  ): Promise<void> {
    if (!current(expected, runId)) return;
    const requestGeneration = ++refreshGeneration;
    pollAbort?.abort();
    const abort = new AbortController();
    pollAbort = abort;
    try {
      const runResponse = await options.api.getRun(runId, abort.signal);
      if (!current(expected, runId) || requestGeneration !== refreshGeneration) return;
      const run = runResponse.body;
      runEtag = runResponse.etag;
      publish({ run, history: historyWithRun(state.history, run), collaboration: state.collaboration?.runId === run.runId ? state.collaboration : null, collaborationUpdating: true, lastUpdatedAt: now() });
      const [eventsResponse, dispatchesResponse, policyResponse, collaborationResponse, historyResponse] = await Promise.allSettled([
        options.api.listEvents(runId, abort.signal),
        run.status === "approved"
          ? options.api.listDispatches(runId, abort.signal)
          : Promise.resolve(null),
        polling && state.policy ? Promise.resolve(null) : options.api.getPolicy(abort.signal),
        options.api.getCollaboration(runId, abort.signal),
        state.history ? Promise.resolve(null) : options.api.listRuns(undefined, abort.signal)
      ]);
      if (!current(expected, runId) || requestGeneration !== refreshGeneration) return;
      const errors = [eventsResponse, dispatchesResponse, policyResponse, collaborationResponse, historyResponse]
        .filter((result) => result.status === "rejected")
        .map((result) => errorMessage((result as PromiseRejectedResult).reason));
      const collaboration = collaborationResponse.status === "fulfilled" ? collaborationResponse.value.body : null;
      const collaborationMatches = collaboration?.runId === run.runId && collaboration.revision === run.revision;
      if (collaboration && !collaborationMatches) errors.push("协作记录版本同步中，请重试");
      if (policyResponse.status === "fulfilled" && policyResponse.value) policyEtag = policyResponse.value.etag;
      publish({
        run,
        events: eventsResponse.status === "fulfilled" ? eventsResponse.value.body : state.events,
        dispatches: dispatchesResponse.status === "fulfilled" ? dispatchesResponse.value?.body ?? state.dispatches : state.dispatches,
        policy: policyResponse.status === "fulfilled" ? policyResponse.value?.body ?? state.policy : state.policy,
        collaboration: collaborationMatches ? collaboration : state.collaboration,
        collaborationUpdating: false,
        history: historyWithRun(historyResponse.status === "fulfilled" ? historyResponse.value?.body ?? state.history : state.history, run),
        busy: polling ? null : state.busy,
        error: errors.length ? `部分信息加载失败：${errors.join("；")}` : null,
        lastUpdatedAt: now()
      });
      schedule(run, expected);
    } catch (error) {
      if (!current(expected, runId) || requestGeneration !== refreshGeneration
        || (error instanceof DOMException && error.name === "AbortError")) return;
      publish({ busy: polling ? null : state.busy, collaborationUpdating: false, error: errorMessage(error) });
      if (state.run) schedule(state.run, expected);
      else pollHandle = schedulePoll(() => {
        pollHandle = null;
        void refresh(expected, runId, true);
      }, pollIntervalMs);
    } finally {
      if (pollAbort === abort) pollAbort = null;
    }
  }

  async function reloadAfterCommand(
    expected: number,
    runId: string
  ): Promise<void> {
    await refresh(expected, runId, false);
  }

  const controller: FinancialCouncilController = {
    getState() { return state; },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async open(runId) {
      const expected = newGeneration();
      activeRunId = runId;
      publish({ ...initialState(), history: state.history, busy: "loading" });
      await refresh(expected, runId, false);
      if (current(expected, runId)) publish({ busy: null });
    },
    async openLatest() {
      const expected = newGeneration();
      activeRunId = null;
      publish({ ...initialState(), busy: "loading" });
      try {
        const response = await options.api.listRuns();
        if (!generationCurrent(expected)) return;
        publish({ history: response.body, busy: null });
        if (response.body.items[0]) await this.open(response.body.items[0].runId);
      } catch (error) {
        if (generationCurrent(expected)) publish({ busy: null, error: errorMessage(error) });
      }
    },
    async loadMoreHistory() {
      const expected = generation;
      const after = state.history?.nextAfter;
      if (!after || !state.history?.hasMore) return;
      try {
        const response = await options.api.listRuns(after);
        if (!generationCurrent(expected)) return;
        const items = new Map((state.history?.items ?? []).map(item => [item.runId, item]));
        response.body.items.forEach(item => items.set(item.runId, item));
        publish({ history: { ...response.body, items: [...items.values()] } });
      } catch (error) { if (generationCurrent(expected)) publish({ error: errorMessage(error) }); }
    },
    async retry() {
      stopPolling();
      if (activeRunId) await refresh(generation, activeRunId, false);
      else await this.openLatest();
    },
    async create(input) {
      const [idempotencyKey, clearKey] = keyFor("create", input);
      const expected = generation;
      const abort = commandAbort();
      publish({ busy: "creating", error: null });
      try {
        const response = await options.api.createRun(
          input, idempotencyKey, abort.signal
        );
        if (!generationCurrent(expected)) return;
        clearKey();
        await this.open(response.body.runId);
      } catch (error) {
        if (generationCurrent(expected) && !abort.signal.aborted) {
          publish({ busy: null, error: errorMessage(error) });
        }
      } finally {
        commandAborts.delete(abort);
      }
    },
    async createFromStatementPackage(input) {
      const [idempotencyKey, clearKey] = keyFor("create-package", input);
      const expected = generation;
      const abort = commandAbort();
      publish({ busy: "creating", error: null });
      try {
        const response = await options.api.createFromStatementPackage(
          input, idempotencyKey, abort.signal
        );
        if (!generationCurrent(expected)) return;
        clearKey();
        await this.open(response.body.runId);
      } catch (error) {
        if (generationCurrent(expected) && !abort.signal.aborted) {
          publish({ busy: null, error: errorMessage(error) });
        }
      } finally {
        commandAborts.delete(abort);
      }
    },
    async updatePolicy(input) {
      if (!state.policy || !policyEtag) {
        publish({ error: "financial_council_policy_unavailable" });
        return;
      }
      const [idempotencyKey, clearKey] = keyFor("policy", input);
      const expected = generation;
      const expectedPolicy = state.policy;
      const expectedEtag = policyEtag;
      const abort = commandAbort();
      publish({ busy: "updating_policy", error: null });
      try {
        const response = await options.api.updatePolicy(
          input,
          expectedEtag,
          idempotencyKey,
          abort.signal
        );
        if (!generationCurrent(expected) || state.policy !== expectedPolicy
          || policyEtag !== expectedEtag) return;
        clearKey();
        policyEtag = response.etag;
        publish({ policy: response.body, busy: null, lastUpdatedAt: now() });
      } catch (error) {
        if (generationCurrent(expected) && !abort.signal.aborted) {
          publish({ busy: null, error: errorMessage(error) });
        }
      } finally {
        commandAborts.delete(abort);
      }
    },
    selectPortfolio(kind) { publish({ selectedPortfolioKind: kind }); },
    setEditDraft(draft) { publish({ editDraft: draft }); },
    async revise(input = state.editDraft ?? undefined) {
      const run = state.run;
      if (!run || !runEtag || !input || !run.latestPortfolioRevision) {
        publish({ error: "financial_council_revision_unavailable" });
        return;
      }
      const expected = generation;
      const abort = commandAbort();
      const [idempotencyKey, clearKey] = keyFor("revise", {
        runId: run.runId, baseRevision: input.baseRevision, operations: input.operations
      });
      publish({ busy: "revising", error: null });
      try {
        await options.api.revisePortfolio(
          run.runId, input, runEtag, idempotencyKey, abort.signal
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null, editDraft: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
      } finally {
        commandAborts.delete(abort);
      }
    },
    async approve(input) {
      const run = state.run;
      if (!run || !runEtag || !run.latestPortfolioRevision) {
        publish({ error: "financial_council_approval_unavailable" });
        return;
      }
      const expected = generation;
      const abort = commandAbort();
      const revision = run.latestPortfolioRevision;
      const [idempotencyKey, clearKey] = keyFor("approve", {
        runId: run.runId, revision, portfolioKind: input.portfolioKind
      });
      publish({ busy: "approving", error: null });
      try {
        await options.api.approve(
          run.runId, revision, input, runEtag, idempotencyKey, abort.signal
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
      } finally {
        commandAborts.delete(abort);
      }
    },
    async reject(input) {
      const run = state.run;
      if (!run || !runEtag) {
        publish({ error: "financial_council_rejection_unavailable" });
        return;
      }
      const expected = generation;
      const abort = commandAbort();
      const [idempotencyKey, clearKey] = keyFor("reject", {
        runId: run.runId,
        portfolioRevision: input.portfolioRevision,
        portfolioKind: input.portfolioKind
      });
      publish({ busy: "rejecting", error: null });
      try {
        await options.api.reject(
          run.runId, input, runEtag, idempotencyKey, abort.signal
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
      } finally {
        commandAborts.delete(abort);
      }
    },
    close() {
      if (destroyed) return;
      newGeneration();
      activeRunId = null;
      state = initialState();
      for (const listener of listeners) listener(state);
    },
    destroy() {
      if (destroyed) return;
      newGeneration();
      destroyed = true;
      activeRunId = null;
      state = initialState();
      listeners.clear();
      semanticKeys.clear();
    }
  };
  return Object.freeze(controller);
}
