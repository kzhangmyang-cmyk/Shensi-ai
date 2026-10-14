import { clearAppSession } from "../app-session";
import {
  DashboardRequestError,
  createRealDashboardApi,
  type RealDashboardApi
} from "./real-api";
import type { DashboardHistoryPeriod } from "./real-api";
import { renderRealDashboardView, type RealDashboardViewState } from "./real-view";

export interface RealDashboardControllerOptions {
  api?: RealDashboardApi;
  main?: HTMLElement | null;
  inspector?: HTMLElement | null;
  onUnauthorized?: () => void;
}

export interface RealDashboardController {
  getState(): Readonly<RealDashboardViewState>;
  whenIdle(): Promise<void>;
  open(): Promise<void>;
  setPeriod(period: DashboardHistoryPeriod): Promise<void>;
  deactivate(): void;
  destroy(): void;
}

export function shouldUseRealDashboard(
  module: string,
  sessionMode: string | undefined
): boolean {
  return module === "dashboard" && sessionMode === "real";
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "dashboard_request_failed";
}

function defaultUnauthorizedBoundary(): void {
  if (typeof document === "undefined" || typeof localStorage === "undefined") return;
  clearAppSession();
}

export function createRealDashboardController(
  options: RealDashboardControllerOptions = {}
): RealDashboardController {
  const api = options.api ?? createRealDashboardApi();
  const onUnauthorized = options.onUnauthorized ?? defaultUnauthorizedBoundary;
  const main = options.main ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleMain"));
  const inspector = options.inspector ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleInspector"));
  const state: RealDashboardViewState = {
    status: "loading",
    summary: null,
    error: null,
    period: "3m"
  };
  let active = false;
  let disposed = false;
  let serial = 0;
  let abort: AbortController | null = null;
  let idlePromise = Promise.resolve();

  function render(): void {
    if (active && !disposed && main && inspector) {
      renderRealDashboardView(state, main, inspector);
    }
  }

  const controller: RealDashboardController = {
    getState: () => state,
    whenIdle: () => idlePromise,
    open() {
      if (disposed) return Promise.resolve();
      active = true;
      abort?.abort();
      abort = new AbortController();
      const own = ++serial;
      state.status = "loading";
      state.error = null;
      render();
      const operation = (async () => {
        try {
          const summary = await api.load(abort?.signal, state.period);
          if (disposed || !active || own !== serial) return;
          state.summary = summary;
          state.status = "ready";
          state.error = null;
          render();
        } catch (error) {
          if (disposed || !active || own !== serial) return;
          if (error instanceof DashboardRequestError && error.status === 401) {
            controller.deactivate();
            onUnauthorized();
            return;
          }
          state.status = "error";
          state.error = errorText(error);
          render();
          throw error;
        }
      })();
      idlePromise = operation.then(() => undefined, () => undefined);
      return operation;
    },
    setPeriod(period) {
      if (period === state.period) return idlePromise;
      state.period = period;
      return controller.open();
    },
    deactivate() {
      active = false;
      serial += 1;
      abort?.abort();
      abort = null;
    },
    destroy() {
      if (disposed) return;
      controller.deactivate();
      disposed = true;
      main?.removeEventListener("click", onClick);
    }
  };

  function onClick(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-real-dashboard-action="retry"], [data-real-dashboard-period]'
    );
    if (!target || !main?.contains(target)) return;
    const period = target.dataset.realDashboardPeriod;
    if (period === "3m" || period === "month") {
      void controller.setPeriod(period).catch(() => undefined);
      return;
    }
    void controller.open().catch(() => undefined);
  }

  main?.addEventListener("click", onClick);
  return controller;
}
