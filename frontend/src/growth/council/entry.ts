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
import { renderReportHtml } from "./report";
import type { CreateCouncilRunFromPackageInput } from "../contracts";

type PortfolioKind = NonNullable<FinancialCouncilControllerState["selectedPortfolioKind"]>;
type EntryController = Pick<FinancialCouncilController,
  "getState" | "subscribe" | "create" | "open" | "selectPortfolio"
  | "setEditDraft" | "revise" | "approve" | "reject" | "destroy"
  | "openLatest" | "loadMoreHistory" | "retry" | "createFromStatementPackage">;

export interface FinancialCouncilWorkbenchEntryOptions {
  readonly host: HTMLElement;
  readonly controller: EntryController;
  readonly capabilities: readonly string[];
  readonly canCreate?: boolean;
  readonly createBlockedReason?: string;
  readonly createInput?: (dataAsOf: string) => Promise<FinancialCouncilCreateInput | null>;
  readonly packageInput?: CreateCouncilRunFromPackageInput | null;
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
  let renderedRunId: string | null = null;

  function identity(node: HTMLElement): string | null {
    if (node.id) return `id:${node.id}`;
    const data = node.dataset;
    if (data.councilDetail) return `detail:${data.councilDetail}`;
    if (data.eventId) return `event:${data.eventId}`;
    if (data.councilScroll) return `scroll:${data.councilScroll}`;
    if (node.classList.contains("council-report-reader")) return "report-reader";
    if (data.councilAction) return JSON.stringify([node.tagName, data.councilAction, data.actionId, data.field, data.runId, node.getAttribute("name"), node.getAttribute("type") === "radio" ? node.getAttribute("value") : null]);
    if (node.tagName === "A") return `link:${node.getAttribute("href")}`;
    if (node.tagName === "DETAILS") return `details:${node.querySelector("summary")?.textContent ?? ""}`;
    if (node.tagName === "SUMMARY" && node.parentElement) return `summary:${identity(node.parentElement)}`;
    return null;
  }

  const replaceHash = options.replaceHash ?? ((hash: string) => {
    window.history.replaceState(null, "", hash);
  });

  function render(state = options.controller.getState()): void {
    if (disposed) return;
    const sameRun = renderedRunId === (state.run?.runId ?? null);
    const doc = options.host.ownerDocument;
    const controls = [...options.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")];
    const active = doc.activeElement && options.host.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
    const focused = active ? identity(active) : null;
    const selection = active as HTMLInputElement | null;
    const range = selection && "selectionStart" in selection ? [selection.selectionStart, selection.selectionEnd] : null;
    const drafts = new Map(controls.flatMap(node => {
      const key = identity(node);
      return key ? [[key, { value: node.value, checked: "checked" in node ? node.checked : null }] as const] : [];
    }));
    const details = new Map([...options.host.querySelectorAll<HTMLDetailsElement>("details")].map(node => [identity(node), node.open]));
    const innerScroll = new Map([...options.host.querySelectorAll<HTMLElement>("[id],[data-council-scroll],.council-report-reader")].map(node => [identity(node), { top: node.scrollTop, left: node.scrollLeft }]));
    const scroll: { node: HTMLElement; top: number; left: number }[] = [];
    for (let node: HTMLElement | null = options.host; node; node = node.parentElement) scroll.push({ node, top: node.scrollTop, left: node.scrollLeft });
    options.host.innerHTML = renderFinancialCouncilWorkbench(state, {
      capabilities: options.capabilities,
      canCreate: options.canCreate
        ?? options.capabilities.includes("finance.council.run"),
      packageReady: !!options.packageInput,
      createBlockedReason: options.createBlockedReason,
      canExportPdf: !!doc.defaultView?.shensiCouncilReport
    });
    renderedRunId = state.run?.runId ?? null;
    if (sameRun) {
      const nextControls = [...options.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")];
      nextControls.forEach((node) => {
        const key = identity(node);
        const prior = key ? drafts.get(key) : null;
        if (!prior) return;
        node.value = prior.value;
        if (prior.checked !== null && "checked" in node) node.checked = prior.checked;
      });
      options.host.querySelectorAll<HTMLDetailsElement>("details").forEach((node) => {
        const open = details.get(identity(node));
        if (open !== undefined) node.open = open;
      });
      const nextFocus = focused ? [...options.host.querySelectorAll<HTMLElement>("input,textarea,select,button,a,summary")].find(node => identity(node) === focused) : null;
      nextFocus?.focus({ preventScroll: true });
      if (range && nextFocus && "setSelectionRange" in nextFocus && range[0] !== null && range[1] !== null) {
        try { (nextFocus as HTMLInputElement).setSelectionRange(range[0]!, range[1]!); } catch { /* non-text input */ }
      }
      options.host.querySelectorAll<HTMLElement>("[id],[data-council-scroll],.council-report-reader").forEach(node => {
        const prior = innerScroll.get(identity(node));
        if (prior) { node.scrollTop = prior.top; node.scrollLeft = prior.left; }
      });
      scroll.forEach(({ node, top, left }) => { node.scrollTop = top; node.scrollLeft = left; });
    }
  }

  function feedback(message: string): void {
    const node = options.host.querySelector<HTMLElement>("[data-council-create-feedback]");
    if (node) node.textContent = message;
  }

  async function create(): Promise<void> {
    if (options.packageInput) {
      await options.controller.createFromStatementPackage(options.packageInput);
      const run = options.controller.getState().run;
      if (run && !disposed) replaceHash(growthHash({ name: "financial-council", runId: run.runId }));
      return;
    }
    const field = options.host.querySelector<HTMLInputElement>("[data-council-data-as-of]");
    const dataAsOf = normalizedDataAsOf(field?.value ?? "");
    if (!dataAsOf) {
      feedback("请选择有效的数据截至时间。");
      return;
    }
    const input = await options.createInput?.(dataAsOf);
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

  function onAuxiliaryAction(event: Event): void {
    const target = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-council-action]");
    if (!target || !options.host.contains(target) || disposed) return;
    const action = target.dataset.councilAction;
    if (action === "retry") { void options.controller.retry(); return; }
    if (action === "more-history") { void options.controller.loadMoreHistory(); return; }
    if (action === "open-history" && target.dataset.runId) {
      const runId = target.dataset.runId;
      void options.controller.open(runId);
      replaceHash(growthHash({ name: "financial-council", runId }));
      return;
    }
    if (action === "download-html" || action === "download-pdf") {
      const collaboration = options.controller.getState().collaboration;
      if (!collaboration) {
        const node = options.host.querySelector('[data-council-export-feedback]');
        if (node) node.textContent = '尚无可导出报告，请先分析或打开已有报告。';
        return;
      }
      const { runId, report } = collaboration;
      const { reportId } = report;
      const html = renderReportHtml(report);
      const filename = `financial-council-${reportId.slice(0, 100)}`;
      const feedback = (message: string) => {
        if (disposed) return;
        const current = options.controller.getState();
        if (current.run?.runId !== runId || current.collaboration?.runId !== runId
          || current.collaboration.report.reportId !== reportId) return;
        const node = options.host.querySelector("[data-council-export-feedback]");
        if (node) node.textContent = message;
      };
      if (action === "download-pdf") {
        const bridge = options.host.ownerDocument.defaultView?.shensiCouncilReport;
        if (bridge) void bridge.exportPdf({ html, filename: `${filename}.pdf` }).then(result => feedback(result.status === "saved" ? "PDF 已保存" : "已取消保存")).catch(() => feedback("PDF 导出失败，请重试。"));
        else feedback('PDF 导出需在桌面应用中使用。');
      } else {
        const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
        const link = options.host.ownerDocument.createElement("a");
        link.href = url; link.download = `${filename}.html`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        feedback("HTML 报告已下载");
      }
      return;
    }
  }

  function onChange(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-council-action]");
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
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('.council-detailed-report nav a');
    if (anchor && options.host.contains(anchor)) {
      const id = anchor.getAttribute("href")?.slice(1) ?? "";
      if (/^council-report-section-\d+$/u.test(id)) {
        event.preventDefault();
        options.host.querySelector(`#${id}`)?.scrollIntoView({ block: "start" });
        return;
      }
    }
    onAuxiliaryAction(event);
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
      else await options.controller.openLatest();
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
