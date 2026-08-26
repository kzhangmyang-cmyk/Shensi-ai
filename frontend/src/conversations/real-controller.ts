import {
  createOutreachBatchApi,
  type OutreachBatchApi
} from "../acquisition/outreach-batch-api";
import {
  createOutreachBatchController,
  type OutreachBatchState
} from "../acquisition/outreach-batch-controller";
import {
  outreachBatchSelection,
  type OutreachBatchSelectionStore
} from "../acquisition/outreach-batch-selection";
import { bindOutreachBatchActions } from "../acquisition/outreach-batch-view";
import {
  createRealConversationsApi,
  type RealConversationsApi,
  type RealPublicInteraction
} from "./real-api";
import {
  renderRealConversationsView,
  type RealConversationsViewState
} from "./real-view";

export interface RealConversationsControllerOptions {
  api?: RealConversationsApi;
  outreachApi?: OutreachBatchApi;
  outreachPollDelayMs?: number;
  batchSelection?: OutreachBatchSelectionStore;
  main?: HTMLElement | null;
  inspector?: HTMLElement | null;
}

export interface RealConversationsController {
  getState(): Readonly<RealConversationsViewState>;
  whenIdle(): Promise<void>;
  open(): Promise<void>;
  deactivate(): void;
  selectInteraction(key: string): void;
  createOutreachForSelected(): Promise<void>;
  destroy(): void;
}

export function shouldUseRealConversations(
  module: string,
  sessionMode: string | undefined
): boolean {
  return module === "conversations" && sessionMode === "real";
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "真实公开互动读取失败";
}

function emptyOutreachState(
  phase: OutreachBatchState["phase"] = "idle"
): OutreachBatchState {
  return {
    phase,
    batch: null,
    drafts: {},
    actions: [],
    error: null,
    conflict: false,
    closed: false
  };
}

export function createRealConversationsController(
  options: RealConversationsControllerOptions = {}
): RealConversationsController {
  const api = options.api ?? createRealConversationsApi();
  const batchApi = options.outreachApi ?? createOutreachBatchApi();
  const batchSelection = options.batchSelection ?? outreachBatchSelection;
  const main = options.main ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleMain"));
  const inspector = options.inspector ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleInspector"));
  const state: RealConversationsViewState = {
    status: "loading",
    snapshot: null,
    selectedInteractionKey: null,
    outreach: emptyOutreachState(),
    error: null
  };
  const batchController = createOutreachBatchController({
    api: batchApi,
    pollDelayMs: options.outreachPollDelayMs
  });
  let active = false;
  let disposed = false;
  let requestSerial = 0;
  let requestAbort: AbortController | null = null;
  let recoverySerial = 0;
  let recoveryAbort: AbortController | null = null;
  let idlePromise = Promise.resolve();
  let latestBatchState = batchController.getState();
  let effectiveBatchId: string | null = null;
  let suppressSelectionBroadcast = false;

  function selectedInteraction(): RealPublicInteraction | undefined {
    const interactions = state.snapshot?.interactions ?? [];
    return interactions.find((item) => item.key === state.selectedInteractionKey)
      ?? interactions[0];
  }

  function batchBelongsTo(
    outreach: OutreachBatchState,
    interaction: RealPublicInteraction | undefined
  ): boolean {
    return Boolean(interaction
      && outreach.batch?.runId === interaction.runId
      && outreach.batch.candidates.some((candidate) =>
        candidate.candidateId === interaction.candidateId));
  }

  function projectBatchState(outreach: OutreachBatchState): OutreachBatchState {
    if (effectiveBatchId !== null
      && outreach.batch?.id === effectiveBatchId
      && batchBelongsTo(outreach, selectedInteraction())) {
      return outreach;
    }
    return {
      ...outreach,
      batch: null,
      drafts: {},
      actions: []
    };
  }

  function render(): void {
    if (active && main && inspector) {
      renderRealConversationsView(state, main, inspector);
    }
  }

  function rememberBatch(batchId: string): void {
    if (batchSelection.read() === batchId) return;
    suppressSelectionBroadcast = true;
    try {
      batchSelection.remember(batchId);
    } finally {
      suppressSelectionBroadcast = false;
    }
  }

  function clearRememberedBatch(): void {
    if (batchSelection.read() === null) return;
    suppressSelectionBroadcast = true;
    try {
      batchSelection.clear();
    } finally {
      suppressSelectionBroadcast = false;
    }
  }

  async function recoverSelectedBatch(): Promise<void> {
    recoverySerial += 1;
    const own = recoverySerial;
    recoveryAbort?.abort();
    recoveryAbort = new AbortController();
    batchController.abort();
    effectiveBatchId = null;
    clearRememberedBatch();
    const interaction = selectedInteraction();
    if (!interaction?.outreachEligible || !active || disposed) {
      state.outreach = emptyOutreachState();
      render();
      return;
    }
    state.outreach = emptyOutreachState("loading");
    render();
    try {
      const listed = await batchApi.listBatches(
        interaction.runId,
        interaction.candidateId,
        1,
        null,
        recoveryAbort.signal
      );
      if (disposed || !active || own !== recoverySerial) return;
      const latest = listed.items[0];
      if (!latest) {
        clearRememberedBatch();
        state.outreach = emptyOutreachState();
        render();
        return;
      }
      await batchController.load(latest.id);
      if (disposed || !active || own !== recoverySerial) return;
      const recovered = latestBatchState.batch;
      if (latestBatchState.phase === "ready"
        && recovered?.id === latest.id
        && batchBelongsTo(latestBatchState, interaction)) {
        effectiveBatchId = recovered.id;
        state.outreach = latestBatchState;
        rememberBatch(recovered.id);
      } else {
        const reason = latestBatchState.error
          ?? "服务器返回的批次与最新候选批次不一致";
        state.outreach = {
          ...emptyOutreachState("error"),
          error: reason
        };
      }
      render();
    } catch (error) {
      if (disposed || !active || own !== recoverySerial || recoveryAbort.signal.aborted) {
        return;
      }
      state.outreach = {
        ...emptyOutreachState("error"),
        error: errorText(error)
      };
      render();
    }
  }

  const unsubscribeBatch = batchController.subscribe((next) => {
    latestBatchState = next;
    state.outreach = projectBatchState(next);
    render();
  });

  const controller: RealConversationsController = {
    getState() { return state; },
    whenIdle() { return idlePromise; },
    open() {
      active = true;
      requestAbort?.abort();
      requestAbort = new AbortController();
      const serial = ++requestSerial;
      state.status = "loading";
      state.error = null;
      effectiveBatchId = null;
      batchController.abort();
      clearRememberedBatch();
      state.outreach = emptyOutreachState("loading");
      render();
      const operation = (async () => {
        try {
          const snapshot = await api.load(requestAbort?.signal);
          if (disposed || serial !== requestSerial) return;
          state.snapshot = snapshot;
          state.selectedInteractionKey = snapshot.interactions.some((item) =>
            item.key === state.selectedInteractionKey)
            ? state.selectedInteractionKey
            : snapshot.interactions[0]?.key ?? null;
          state.status = "ready";
          state.error = null;
          render();
          await recoverSelectedBatch();
        } catch (error) {
          if (disposed || serial !== requestSerial) return;
          state.status = "error";
          state.error = errorText(error);
          render();
          throw error;
        }
      })();
      idlePromise = operation.then(() => undefined, () => undefined);
      return operation;
    },
    deactivate() {
      active = false;
      requestSerial += 1;
      requestAbort?.abort();
      requestAbort = null;
      recoverySerial += 1;
      recoveryAbort?.abort();
      recoveryAbort = null;
      batchController.abort();
    },
    selectInteraction(key) {
      const normalized = key.trim();
      if (!state.snapshot?.interactions.some((item) => item.key === normalized)) {
        return;
      }
      state.selectedInteractionKey = normalized;
      const operation = recoverSelectedBatch();
      idlePromise = operation.then(() => undefined, () => undefined);
    },
    async createOutreachForSelected() {
      await idlePromise;
      const interaction = selectedInteraction();
      if (!active || disposed || !interaction?.outreachEligible
        || batchBelongsTo(state.outreach, interaction)) return;
      await batchController.create(interaction.runId, [interaction.candidateId]);
      if (latestBatchState.phase === "ready"
        && latestBatchState.batch
        && batchBelongsTo(latestBatchState, interaction)) {
        effectiveBatchId = latestBatchState.batch.id;
        state.outreach = latestBatchState;
        rememberBatch(latestBatchState.batch.id);
      } else {
        state.outreach = projectBatchState(latestBatchState);
      }
      render();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller.deactivate();
      main?.removeEventListener("click", onClick);
      inspector?.removeEventListener("click", onClick);
      unbindBatchActions();
      unsubscribeSelection();
      unsubscribeBatch();
      batchController.close();
    }
  };

  function onClick(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-real-conversations-action]"
    );
    if (!target || (!main?.contains(target) && !inspector?.contains(target))) return;
    const action = target.dataset.realConversationsAction;
    if (action === "select") {
      controller.selectInteraction(target.dataset.interactionKey ?? "");
    } else if (action === "retry") {
      void controller.open().catch(() => undefined);
    } else if (action === "create-outreach") {
      void controller.createOutreachForSelected();
    }
  }

  const unbindBatchActions = main
    ? bindOutreachBatchActions(main, batchController)
    : () => undefined;
  const unsubscribeSelection = batchSelection.subscribe(() => {
    if (!active || disposed || suppressSelectionBroadcast) return;
    const operation = recoverSelectedBatch();
    idlePromise = operation.then(() => undefined, () => undefined);
  });
  main?.addEventListener("click", onClick);
  inspector?.addEventListener("click", onClick);
  return controller;
}
