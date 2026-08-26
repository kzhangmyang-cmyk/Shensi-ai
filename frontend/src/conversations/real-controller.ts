import {
  createRealConversationsApi,
  type RealConversationsApi
} from "./real-api";
import {
  renderRealConversationsView,
  type RealConversationsViewState
} from "./real-view";

export interface RealConversationsControllerOptions {
  api?: RealConversationsApi;
  main?: HTMLElement | null;
  inspector?: HTMLElement | null;
}

export interface RealConversationsController {
  getState(): Readonly<RealConversationsViewState>;
  whenIdle(): Promise<void>;
  open(): Promise<void>;
  deactivate(): void;
  selectInteraction(key: string): void;
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

export function createRealConversationsController(
  options: RealConversationsControllerOptions = {}
): RealConversationsController {
  const api = options.api ?? createRealConversationsApi();
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
    error: null
  };
  let active = false;
  let disposed = false;
  let requestSerial = 0;
  let requestAbort: AbortController | null = null;
  let idlePromise = Promise.resolve();

  function render(): void {
    if (active && main && inspector) {
      renderRealConversationsView(state, main, inspector);
    }
  }

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
    },
    selectInteraction(key) {
      const normalized = key.trim();
      if (!state.snapshot?.interactions.some((item) => item.key === normalized)) {
        return;
      }
      state.selectedInteractionKey = normalized;
      render();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller.deactivate();
      main?.removeEventListener("click", onClick);
      inspector?.removeEventListener("click", onClick);
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
    }
  }

  main?.addEventListener("click", onClick);
  inspector?.addEventListener("click", onClick);
  return controller;
}
