import { growthHash } from "../router";
import type {
  FinancialCouncilCreateInput,
  FinancialCouncilPortfolioRevisionInput
} from "./api";
import type {
  FinancialCouncilController,
  FinancialCouncilControllerState
} from "./controller";
import { renderFinancialCouncilWorkbench } from "./view";

type PortfolioKind = NonNullable<FinancialCouncilControllerState["selectedPortfolioKind"]>;
type EntryController = Pick<FinancialCouncilController,
  "getState" | "subscribe" | "create" | "open" | "selectPortfolio"
  | "setEditDraft" | "revise" | "approve" | "reject" | "destroy">;

export interface FinancialCouncilWorkbenchEntryOptions {
  readonly host: HTMLElement;
  readonly controller: EntryController;
  readonly capabilities: readonly string[];
  readonly createInput: (dataAsOf: string) => Promise<FinancialCouncilCreateInput | null>;
  readonly replaceHash?: (hash: string) => void;
}

export interface FinancialCouncilWorkbenchEntry {
  mount(runId?: string): Promise<void>;
  dispose(): void;
}

function selectedKind(state: FinancialCouncilControllerState): PortfolioKind | null {
  return state.selectedPortfolioKind
    ?? state.run?.portfolios[0]?.kind
    ?? null;
}

function draftFor(
  state: FinancialCouncilControllerState,
  operation: FinancialCouncilPortfolioRevisionInput["operations"][number]
): FinancialCouncilPortfolioRevisionInput | null {
  const kind = selectedKind(state);
  if (!state.run || !kind || !state.run.latestPortfolioRevision) return null;
  const prior = state.editDraft?.operations ?? [];
  const withoutSame = prior.filter((entry) => {
    if (entry.kind === "select_portfolio") return false;
    if (operation.kind === "replace_action_parameters") {
      return entry.kind !== "replace_action_parameters"
        || entry.actionId !== operation.actionId;
    }
    if (operation.kind === "remove_action" || operation.kind === "restore_action") {
      return !((entry.kind === "remove_action" || entry.kind === "restore_action")
        && entry.actionId === operation.actionId);
    }
    return true;
  });
  return {
    baseRevision: state.run.latestPortfolioRevision,
    operations: [{ kind: "select_portfolio", portfolioKind: kind }, ...withoutSame, operation]
  };
}

function normalizedDataAsOf(value: string): string | null {
  if (!value) return null;
  if (/Z$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createFinancialCouncilWorkbenchEntry(
  options: FinancialCouncilWorkbenchEntryOptions
): FinancialCouncilWorkbenchEntry {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  const replaceHash = options.replaceHash ?? ((hash: string) => {
    window.history.replaceState(null, "", hash);
  });

  function render(state = options.controller.getState()): void {
    if (disposed) return;
    options.host.innerHTML = renderFinancialCouncilWorkbench(state, {
      capabilities: options.capabilities,
      canCreate: options.capabilities.includes("finance.council.run")
    });
  }

  function feedback(message: string): void {
    const node = options.host.querySelector<HTMLElement>("[data-council-create-feedback]");
    if (node) node.textContent = message;
  }

  async function create(): Promise<void> {
    const field = options.host.querySelector<HTMLInputElement>("[data-council-data-as-of]");
    const dataAsOf = normalizedDataAsOf(field?.value ?? "");
    if (!dataAsOf) {
      feedback("请选择有效的数据截至时间。");
      return;
    }
    const input = await options.createInput(dataAsOf);
    if (disposed) return;
    if (!input) {
      feedback("请先在经营顾问中完成当前有效 Business report。");
      return;
    }
    await options.controller.create(input);
    const run = options.controller.getState().run;
    if (run && !disposed) {
      replaceHash(growthHash({ name: "financial-council", runId: run.runId }));
    }
  }

  function onChange(event: Event): void {
    const target = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-council-action]");
    if (!target || !options.host.contains(target) || disposed) return;
    const state = options.controller.getState();
    const action = target.dataset.councilAction;
    if (action === "select-portfolio") {
      const kind = (target as HTMLInputElement).value as PortfolioKind;
      options.controller.selectPortfolio(kind);
      const draft = draftFor(options.controller.getState(), {
        kind: "select_portfolio", portfolioKind: kind
      });
      if (draft) options.controller.setEditDraft(draft);
      return;
    }
    if (action !== "replace-action-parameters") return;
    const actionId = target.dataset.actionId;
    const field = target.dataset.field;
    if (!actionId || (field !== "ownerRole" && field !== "durationDays")) return;
    const current = state.editDraft?.operations.find((operation) =>
      operation.kind === "replace_action_parameters" && operation.actionId === actionId);
    const parameters = current?.kind === "replace_action_parameters"
      ? { ...current.parameters } : {};
    if (field === "ownerRole") {
      parameters.ownerRole = (target as HTMLSelectElement).value as typeof parameters.ownerRole;
    } else {
      const duration = Number((target as HTMLInputElement).value);
      if (!Number.isSafeInteger(duration) || duration < 0) return;
      parameters.durationDays = duration;
    }
    const draft = draftFor(state, {
      kind: "replace_action_parameters", actionId, parameters
    });
    if (draft) options.controller.setEditDraft(draft);
  }

  function onClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-council-action]");
    if (!target || !options.host.contains(target) || disposed) return;
    const action = target.dataset.councilAction;
    if (action === "create") {
      void create();
      return;
    }
    const state = options.controller.getState();
    if (action === "remove-action" || action === "restore-action") {
      const actionId = target.dataset.actionId;
      if (!actionId) return;
      const draft = draftFor(state, {
        kind: action === "remove-action" ? "remove_action" : "restore_action",
        actionId
      });
      if (draft) options.controller.setEditDraft(draft);
      return;
    }
    if (action === "revise") {
      void options.controller.revise();
      return;
    }
    const kind = selectedKind(state);
    if (!kind || !state.run?.latestPortfolioRevision) return;
    if (action === "approve") {
      void options.controller.approve({ portfolioKind: kind });
      return;
    }
    if (action === "reject") {
      const reason = options.host.querySelector<HTMLTextAreaElement>("[data-council-rejection-reason]")?.value.trim();
      if (!reason) return;
      void options.controller.reject({
        portfolioKind: kind,
        portfolioRevision: state.run.latestPortfolioRevision,
        reason
      });
    }
  }

  options.host.addEventListener("click", onClick);
  options.host.addEventListener("change", onChange);

  return Object.freeze({
    async mount(runId?: string) {
      if (disposed) return;
      unsubscribe ??= options.controller.subscribe(render);
      render();
      if (runId) await options.controller.open(runId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      options.host.removeEventListener("click", onClick);
      options.host.removeEventListener("change", onChange);
      options.controller.destroy();
    }
  });
}
