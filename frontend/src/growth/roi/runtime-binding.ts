import type { RoiController, RoiPageState } from "./controller";
import { activateRoiTab, moveRoiTabWithKey } from "./tabs";
import { formatRoiAsOfPrecision, formatRoiAsOfSummary, renderRoiPage } from "./view";

export interface RoiRuntimeBindingOptions {
  getHost(): HTMLElement | null;
  createController(): RoiController;
  clearHost?(host: HTMLElement): void;
}

export interface RoiRuntimeBinding {
  mount(context: { signal: AbortSignal }): Promise<void>;
  unmount(): void;
  destroy(): void;
}

/** Owns one mounted ROI page. A new mount never shares controller state or requests. */
export function createRoiRuntimeBinding(options: RoiRuntimeBindingOptions): RoiRuntimeBinding {
  let current: { stop(): void; clear(): void } | null = null;
  let destroyed = false;

  function unmount() {
    const session = current;
    current = null;
    session?.stop();
    session?.clear();
  }

  return {
    async mount(context) {
      unmount();
      if (destroyed || context.signal.aborted) return;
      const hostCandidate = options.getHost();
      if (!hostCandidate) return;
      const host: HTMLElement = hostCandidate;
      const controller = options.createController();
      const pageAbort = new AbortController();
      let queryAbort: AbortController | null = null;
      let sequence = 0;
      let pendingKey: string | null = null;
      let state: RoiPageState = { kind: "loading" };
      const session = {
        stop() {
          pageAbort.abort();
          queryAbort?.abort();
          sequence += 1;
          context.signal.removeEventListener("abort", session.stop);
          host.removeEventListener("submit", onSubmit);
          host.removeEventListener("click", onClick);
          host.removeEventListener("keydown", onKeydown);
          host.removeEventListener("input", onInput);
          host.removeEventListener("change", onInput);
        },
        clear() {
          if (options.clearHost) options.clearHost(host);
          else host.replaceChildren();
        }
      };
      current = session;
      const isCurrent = () => current === session && !destroyed
        && !pageAbort.signal.aborted && !context.signal.aborted;
      const render = () => {
        if (!isCurrent()) return;
        const selectedTab = host.querySelector<HTMLElement>(
          '[data-roi-tab][aria-selected="true"]'
        )?.dataset.roiTab;
        host.innerHTML = renderRoiPage(state);
        if (selectedTab) activateRoiTab(host, selectedTab);
      };
      const settleQuery = (next: RoiPageState) => {
        if (state.kind === "ready" && (next.kind === "error" || next.kind === "conflict")) {
          state = { ...state, queryPending: false, queryError: next.message };
        } else {
          state = next;
        }
        render();
      };

      function onSubmit(event: Event) {
        const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-roi-filters]");
        if (!isCurrent() || !form || !host.contains(form) || state.kind !== "ready") return;
        event.preventDefault();
        const cohortId = form.querySelector<HTMLSelectElement>("[data-roi-cohort]")?.value.trim() ?? "";
        const currency = form.querySelector<HTMLSelectElement>("[data-roi-currency]")?.value.trim() ?? "CNY";
        const localAsOf = form.querySelector<HTMLInputElement>("[data-roi-as-of]")?.value ?? "";
        if (!cohortId || !localAsOf) return;
        const timestamp = Date.parse(localAsOf);
        if (!Number.isFinite(timestamp)) return;
        const filters = { cohortId, currency, asOf: new Date(timestamp).toISOString() };
        const key = JSON.stringify(filters);
        if (key === pendingKey) return;
        queryAbort?.abort();
        const abort = new AbortController();
        queryAbort = abort;
        const requestSequence = ++sequence;
        pendingKey = key;
        state = { ...state, filters, performance: null, queryPending: true, queryError: null };
        render();
        void controller.query(filters, abort.signal).then((next) => {
          if (!isCurrent() || abort.signal.aborted || requestSequence !== sequence) return;
          pendingKey = null;
          settleQuery(next);
        }).catch((error: unknown) => {
          if (!isCurrent() || abort.signal.aborted || requestSequence !== sequence) return;
          pendingKey = null;
          settleQuery({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        });
      }

      function onInput(event: Event) {
        const input = event.target as HTMLInputElement | null;
        if (!isCurrent() || !input?.matches("[data-roi-as-of]") || !host.contains(input)) return;
        const summary = host.querySelector<HTMLTimeElement>("[data-roi-as-of-summary]");
        const precision = host.querySelector<HTMLElement>("[data-roi-as-of-precision]");
        const summaryAction = host.querySelector<HTMLElement>("[data-roi-as-of-summary-action]");
        const preciseLabel = formatRoiAsOfPrecision(input.value);
        if (summary) {
          summary.textContent = formatRoiAsOfSummary(input.value);
          summary.setAttribute("datetime", input.value);
          summary.setAttribute("title", preciseLabel);
        }
        if (precision) precision.textContent = `当前精确截止时间：${preciseLabel}`;
        summaryAction?.setAttribute("aria-label", `数据截至 ${preciseLabel}，展开可调整精确时间`);
      }

      function onClick(event: Event) {
        if (!isCurrent()) return;
        const explanation = (event.target as HTMLElement | null)?.closest<HTMLElement>(
          '[data-roi-action="data-explanation"]'
        );
        if (explanation && host.contains(explanation)) {
          event.preventDefault();
          const target = host.querySelector<HTMLElement>("#roi-data-explanation");
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
          target?.focus({ preventScroll: true });
          return;
        }
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-roi-tab]");
        if (button && host.contains(button)) activateRoiTab(host, button.dataset.roiTab);
      }

      function onKeydown(event: KeyboardEvent) {
        if (!isCurrent()) return;
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-roi-tab]");
        if (!button || !host.contains(button)) return;
        if (moveRoiTabWithKey(host, button, event.key)) event.preventDefault();
      }

      context.signal.addEventListener("abort", session.stop, { once: true });
      host.addEventListener("submit", onSubmit);
      host.addEventListener("click", onClick);
      host.addEventListener("keydown", onKeydown);
      host.addEventListener("input", onInput);
      host.addEventListener("change", onInput);
      render();
      try {
        const next = await controller.loadCohorts(pageAbort.signal);
        if (!isCurrent()) return;
        state = next;
        render();
      } catch (error) {
        if (!isCurrent()) return;
        state = { kind: "error", message: error instanceof Error ? error.message : String(error) };
        render();
      }
    },
    unmount,
    destroy() {
      destroyed = true;
      unmount();
    }
  };
}
