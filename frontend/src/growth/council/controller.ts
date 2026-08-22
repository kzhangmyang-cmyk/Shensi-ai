import { GrowthApiError } from "../http";
import type {
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
  create(input: Parameters<FinancialCouncilApi["createRun"]>[0]): Promise<void>;
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

  function newGeneration(): number {
    generation += 1;
    refreshGeneration += 1;
    runEtag = null;
    policyEtag = null;
    stopPolling();
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
    if (destroyed || generation !== expected || (!isTerminal(run)
      || !dispatchesComplete(state.dispatches)) === false) return;
    if (isTerminal(run) && dispatchesComplete(state.dispatches)) return;
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
      const [eventsResponse, dispatchesResponse, policyResponse] = await Promise.all([
        options.api.listEvents(runId, abort.signal),
        run.status === "approved"
          ? options.api.listDispatches(runId, abort.signal)
          : Promise.resolve(null),
        polling ? Promise.resolve(null) : options.api.getPolicy(abort.signal)
      ]);
      if (!current(expected, runId) || requestGeneration !== refreshGeneration) return;
      runEtag = runResponse.etag;
      if (policyResponse) policyEtag = policyResponse.etag;
      publish({
        run,
        events: eventsResponse.body,
        dispatches: dispatchesResponse?.body ?? state.dispatches,
        policy: policyResponse?.body ?? state.policy,
        busy: polling ? null : state.busy,
        error: null,
        lastUpdatedAt: now()
      });
      schedule(run, expected);
    } catch (error) {
      if (!current(expected, runId) || requestGeneration !== refreshGeneration
        || (error instanceof DOMException && error.name === "AbortError")) return;
      publish({ busy: polling ? null : state.busy, error: errorMessage(error) });
      if (state.run) schedule(state.run, expected);
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
      publish({ ...initialState(), busy: "loading" });
      await refresh(expected, runId, false);
      if (current(expected, runId)) publish({ busy: null });
    },
    async create(input) {
      const [idempotencyKey, clearKey] = keyFor("create", input);
      publish({ busy: "creating", error: null });
      try {
        const response = await options.api.createRun(input, idempotencyKey);
        clearKey();
        await this.open(response.body.runId);
      } catch (error) {
        publish({ busy: null, error: errorMessage(error) });
      }
    },
    async updatePolicy(input) {
      if (!state.policy || !policyEtag) {
        publish({ error: "financial_council_policy_unavailable" });
        return;
      }
      const [idempotencyKey, clearKey] = keyFor("policy", input);
      publish({ busy: "updating_policy", error: null });
      try {
        const response = await options.api.updatePolicy(
          input,
          policyEtag,
          idempotencyKey
        );
        clearKey();
        policyEtag = response.etag;
        publish({ policy: response.body, busy: null, lastUpdatedAt: now() });
      } catch (error) {
        publish({ busy: null, error: errorMessage(error) });
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
      const [idempotencyKey, clearKey] = keyFor("revise", {
        runId: run.runId, baseRevision: input.baseRevision, operations: input.operations
      });
      publish({ busy: "revising", error: null });
      try {
        await options.api.revisePortfolio(
          run.runId, input, runEtag, idempotencyKey
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null, editDraft: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
      }
    },
    async approve(input) {
      const run = state.run;
      if (!run || !runEtag || !run.latestPortfolioRevision) {
        publish({ error: "financial_council_approval_unavailable" });
        return;
      }
      const expected = generation;
      const revision = run.latestPortfolioRevision;
      const [idempotencyKey, clearKey] = keyFor("approve", {
        runId: run.runId, revision, portfolioKind: input.portfolioKind
      });
      publish({ busy: "approving", error: null });
      try {
        await options.api.approve(
          run.runId, revision, input, runEtag, idempotencyKey
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
      }
    },
    async reject(input) {
      const run = state.run;
      if (!run || !runEtag) {
        publish({ error: "financial_council_rejection_unavailable" });
        return;
      }
      const expected = generation;
      const [idempotencyKey, clearKey] = keyFor("reject", {
        runId: run.runId,
        portfolioRevision: input.portfolioRevision,
        portfolioKind: input.portfolioKind
      });
      publish({ busy: "rejecting", error: null });
      try {
        await options.api.reject(
          run.runId, input, runEtag, idempotencyKey
        );
        if (!current(expected, run.runId)) return;
        clearKey();
        await reloadAfterCommand(expected, run.runId);
        if (current(expected, run.runId)) publish({ busy: null });
      } catch (error) {
        if (current(expected, run.runId)) publish({ busy: null, error: errorMessage(error) });
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
