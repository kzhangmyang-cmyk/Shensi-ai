import { growthHash, parseGrowthHash, type GrowthRoute } from "./router";
import { mountEnterpriseAnalysis } from './finance/enterprise-analysis';
import {
  resolveGrowthMode,
  type GrowthMode,
  type GrowthUnavailable
} from "./mode";
import manifest from "../../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import { loadGrowthBootstrap } from "./bootstrap-api";
import { createGrowthHttpClient } from "./http";
import { createCatalogApi } from "./catalog/api";
import {
  createCatalogController,
  type CatalogPageState
} from "./catalog/controller";
import { renderCatalogPage } from "./catalog/view";
import { createCatalogPageEntry } from "./catalog/entry";
import { createQuoteApi, type QuotePreviewInput } from "./quotes/api";
import {
  createQuoteController,
  type QuoteWorkbenchState
} from "./quotes/controller";
import {
  renderQuoteWorkbench,
  matchesQuoteCaseFilter,
  type QuoteWorkbenchViewOptions
} from "./quotes/view";
import { createFinanceApi, financeImportFileIssue, financeDocumentFileIssue, type FinanceDocumentInspection, type FinanceImportMapping } from "./finance/api";
import { createFinanceController } from "./finance/controller";
import { renderFinancePage } from "./finance/view";
import { createFinanceImportWorkflow } from "./finance/import-workflow";
import { financeDocumentScope, setFinanceDocumentSelection } from "./finance/document-selection";
import { createGrowthPerformanceApi } from "./roi/api";
import { createRoiController } from "./roi/controller";
import { createRoiRuntimeBinding } from "./roi/runtime-binding";
import { createAdvisorApi } from "./advisor/api";
import { createAdvisorCopilotWorkflow } from "./advisor/copilot-workflow";
import { createAdvisorController } from "./advisor/controller";
import type { AdvisorHomeState } from "./advisor/controller";
import { renderAdvisorHome } from "./advisor/view";
import { createAgentsController } from "./agents/controller";
import type { AgentsSessionState } from "./agents/controller";
import { createFinancialCouncilApi } from "./council/api";
import { createRealAgentCenterApi } from "./agents/real-api";
import { createFinancialCouncilController } from "./council/controller";
import { createFinancialCouncilWorkbenchEntry } from "./council/entry";
import { createPrivateDomainController } from "../private-domain/controller";
import { createPrivateDomainRuntimeApi } from "../private-domain/runtime-api";

export type GrowthModeState = GrowthMode | GrowthUnavailable;

export interface GrowthPageContext {
  route: GrowthRoute;
  mode: GrowthModeState;
  signal: AbortSignal;
  abort(): void;
}

export interface GrowthPageController {
  readonly handlesOwnRouteChanges?: boolean;
  mount(context: GrowthPageContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
}

export class GrowthPageRegistry {
  private readonly pages = new Map<string, GrowthPageController>();

  register(name: string, controller: GrowthPageController): void {
    this.pages.set(name, controller);
  }

  get(name: string): GrowthPageController | null {
    return this.pages.get(name) ?? null;
  }
}

export function growthWorkspaceHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#demoModuleMain");
}

let activeAbort: AbortController | null = null;
let activeController: GrowthPageController | null = null;
let bootstrapAbort: AbortController | null = null;
let navigationSequence = 0;
let runtimeEpoch = 0;
let sharedRuntime: {
  readonly registry: GrowthPageRegistry;
  readonly mode: GrowthModeState;
} | null = null;

function clearGrowthContent(host: HTMLElement): void {
  if (parseGrowthHash(window.location.hash) === null) return;
  for (const child of [...host.children]) {
    if (child.matches("nav.growth-nav")) continue;
    child.remove();
  }
}

async function switchPage(
  registry: GrowthPageRegistry,
  route: GrowthRoute,
  mode: GrowthModeState,
  expectedEpoch: number
): Promise<void> {
  if (expectedEpoch !== runtimeEpoch) return;
  const controller = registry.get(route.name);
  if (controller
    && activeController === controller
    && controller.handlesOwnRouteChanges) return;
  const sequence = ++navigationSequence;
  activeAbort?.abort();
  const previousController = activeController;
  activeController = null;
  activeAbort = null;
  await previousController?.unmount?.();
  if (expectedEpoch !== runtimeEpoch || sequence !== navigationSequence) return;
  const host = growthWorkspaceHost();
  if (host) clearGrowthContent(host);
  if (!controller || !host) return;
  const abort = new AbortController();
  activeAbort = abort;
  activeController = controller;
  await controller.mount({
    route,
    mode,
    signal: abort.signal,
    abort: () => abort.abort()
  });
  if (expectedEpoch !== runtimeEpoch || sequence !== navigationSequence) {
    abort.abort();
    if (activeAbort === abort) {
      activeAbort = null;
      activeController = null;
      await controller.unmount?.();
    }
  }
}

function dispatchPage(
  registry: GrowthPageRegistry,
  mode: GrowthModeState,
  epoch: number
): void {
  const route = parseGrowthHash(window.location.hash);
  if (!route) return;
  void switchPage(registry, route, mode, epoch).catch(() => undefined);
}

export async function resetGrowthRuntime(): Promise<void> {
  runtimeEpoch += 1;
  navigationSequence += 1;
  sharedRuntime = null;
  bootstrapAbort?.abort();
  bootstrapAbort = null;
  activeAbort?.abort();
  activeAbort = null;
  const controller = activeController;
  activeController = null;
  try {
    await controller?.unmount?.();
  } catch {
    // Reset remains a usable lifecycle barrier even if cleanup fails.
  }
  const host = growthWorkspaceHost();
  if (host) clearGrowthContent(host);
}

export interface StartGrowthRuntimeOptions {
  requested?: "real" | "demo";
  registry?: GrowthPageRegistry;
  bootstrapLoader?: { load(signal?: AbortSignal): Promise<unknown> };
}

export type GrowthRuntimeStartState = GrowthModeState | { kind: "cancelled" };

export async function startGrowthRuntime(
  options: StartGrowthRuntimeOptions = {}
): Promise<GrowthRuntimeStartState> {
  const startEpoch = runtimeEpoch;
  const singleShot = options.registry !== undefined
    || options.bootstrapLoader !== undefined
    || options.requested !== undefined;
  const cachedRuntime = !singleShot ? sharedRuntime : null;
  if (cachedRuntime) {
    dispatchPage(cachedRuntime.registry, cachedRuntime.mode, startEpoch);
    return cachedRuntime.mode;
  }
  const registry = options.registry ?? new GrowthPageRegistry();
  const agentsSession: AgentsSessionState = {};
  let agentsController: ReturnType<typeof createAgentsController> | null = null;
  let http = createGrowthHttpClient();
  registry.register("agents", {
    handlesOwnRouteChanges: true,
    async mount() {
      const host = growthWorkspaceHost();
      if (!host) return;
      agentsController ??= createAgentsController({
        http,
        host,
        session: agentsSession
      });
      agentsController.render();
    },
    unmount() {
      agentsController?.dispose();
      agentsController = null;
      const host = growthWorkspaceHost();
      if (host) clearGrowthContent(host);
    }
  });
  let mode: GrowthModeState;
  if (options.requested === "demo") {
    mode = { kind: "demo" };
  } else {
    const abort = new AbortController();
    if (!singleShot) {
      bootstrapAbort?.abort();
      bootstrapAbort = abort;
    }
    try {
      const bootstrap = await (options.bootstrapLoader
        ? options.bootstrapLoader.load(abort.signal)
        : loadGrowthBootstrap(undefined, abort.signal)) as never;
      mode = resolveGrowthMode({
        requested: "real",
        pinned: manifest,
        bootstrap
      });
    } catch {
      if (abort.signal.aborted || startEpoch !== runtimeEpoch) {
        return { kind: "cancelled" };
      }
      mode = { kind: "unavailable", reason: "workspace_selection_required" };
    } finally {
      if (bootstrapAbort === abort) bootstrapAbort = null;
    }
  }
  if (startEpoch !== runtimeEpoch) {
    return { kind: "cancelled" };
  }
  if (mode.kind === "real") {
    http = createGrowthHttpClient({
      workspaceId: () => mode.bootstrap.workspaceId
    });
  }
  if (registry.get("catalog") === null && mode.kind === "real") {
    const catalogEntry = createCatalogPageEntry({
      api: createCatalogApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    let customerDirectory: ReturnType<typeof createPrivateDomainController> | null = null;
    let catalogHost: HTMLElement | null = null;
    const onCatalogTabClick = (event: Event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        "[data-growth-catalog-tab]"
      );
      if (!button || !catalogHost?.contains(button)) return;
      const selected = button.dataset.growthCatalogTab;
      catalogHost.querySelectorAll<HTMLButtonElement>("[data-growth-catalog-tab]").forEach((tab) => {
        const active = tab.dataset.growthCatalogTab === selected;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });
      catalogHost.querySelectorAll<HTMLElement>("[data-growth-catalog-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.growthCatalogPanel !== selected;
      });
    };
    registry.register("catalog", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        catalogHost = host;
        host.innerHTML = `<section class="growth-panel growth-customer-directory">
          <nav class="growth-catalog-tabs" role="tablist" aria-label="客户目录视图">
            <button type="button" class="active" role="tab" aria-selected="true" data-growth-catalog-tab="customers">客户与线索</button>
            <button type="button" role="tab" aria-selected="false" data-growth-catalog-tab="products">产品与定价</button>
          </nav>
          <div data-growth-catalog-panel="customers">
            <div class="growth-customer-layout">
              <div data-growth-customer-list></div>
              <div data-growth-customer-inspector></div>
            </div>
            <details class="growth-catalog-summary">
              <summary><i class="ph ph-cube" aria-hidden="true"></i><span><strong>产品与定价资料</strong><small>维护报价所需的产品与价格</small></span><i class="ph ph-caret-right" aria-hidden="true"></i></summary>
              <div class="growth-catalog-summary-body"><p>需要维护报价资料时再展开目录。</p><button type="button" data-growth-catalog-tab="products">查看产品与定价</button></div>
            </details>
          </div>
          <div class="growth-supporting-catalog" data-growth-catalog-panel="products" hidden>
            <div data-growth-product-catalog>${renderCatalogPage({ kind: "loading" })}</div>
          </div>
        </section>`;
        host.addEventListener("click", onCatalogTabClick);
        const listHost = host.querySelector<HTMLElement>("[data-growth-customer-list]");
        const inspectorHost = host.querySelector<HTMLElement>("[data-growth-customer-inspector]");
        customerDirectory = createPrivateDomainController({
          api: createPrivateDomainRuntimeApi(),
          main: listHost,
          inspector: inspectorHost,
          eventTarget: document,
          surface: "catalog"
        });
        const productCatalogHost = host.querySelector<HTMLElement>("[data-growth-product-catalog]");
        await Promise.all([
          productCatalogHost ? catalogEntry.mount(productCatalogHost, context.signal) : Promise.resolve(),
          customerDirectory.open().catch(() => undefined)
        ]);
        if (context.signal.aborted) return;
      },
      unmount() {
        catalogEntry.unmount();
        customerDirectory?.destroy();
        customerDirectory = null;
        const host = growthWorkspaceHost();
        host?.removeEventListener("click", onCatalogTabClick);
        catalogHost = null;
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("quote") === null && mode.kind === "real") {
    const quoteController = createQuoteController({
      api: createQuoteApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    const quoteCatalogController = createCatalogController({
      api: createCatalogApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    let quoteHost: HTMLElement | null = null;
    let quoteState: QuoteWorkbenchState = { kind: "loading_case" };
    let quoteViewOptions: QuoteWorkbenchViewOptions = {};
    let quoteCommandAbort: AbortController | null = null;

    const viewOptions = (catalog: CatalogPageState): QuoteWorkbenchViewOptions => {
      const capabilities = mode.kind === "real"
        ? mode.bootstrap.capabilities as readonly string[] : [];
      if (catalog.kind !== "ready") {
        return {
          items: [], policies: [],
          canDraft: capabilities.includes("quote.draft.create"),
          canApprove: capabilities.includes("quote.confirm")
        };
      }
      return {
        items: catalog.items
          .filter((item) => item.status === "active")
          .map((item) => ({ id: item.id, name: item.name })),
        policies: catalog.policies
          .filter((policy) => policy.status === "active")
          .map((policy) => ({
            id: policy.id,
            currency: policy.currency ?? "CNY",
            ...(policy.listUnitPriceMinor === undefined
              ? {} : { listUnitPriceMinor: policy.listUnitPriceMinor })
          })),
        canDraft: capabilities.includes("quote.draft.create"),
        canApprove: capabilities.includes("quote.confirm")
      };
    };

    const renderQuote = (state: QuoteWorkbenchState) => {
      quoteState = state;
      if (quoteHost) quoteHost.innerHTML = renderQuoteWorkbench(
        state, quoteViewOptions
      );
    };

    const reloadQuoteCase = async (caseId: string, signal?: AbortSignal) => {
      const state = await quoteController.loadCase(caseId, signal);
      if (!signal?.aborted) renderQuote(state);
    };

    const integerMinor = (value: FormDataEntryValue | null): number =>
      Math.round(Number(String(value ?? "0")) * 100);

    const previewInputFrom = (form: HTMLFormElement): QuotePreviewInput => {
      const data = new FormData(form);
      const target = String(data.get("customerTargetPrice") ?? "").trim();
      return {
        catalogItemId: String(data.get("catalogItemId") ?? ""),
        pricingPolicyVersionId: String(data.get("pricingPolicyVersionId") ?? ""),
        quantityMicros: Math.round(Number(data.get("quantity") ?? 0) * 1_000_000),
        offeredUnitPriceMinor: integerMinor(data.get("offeredUnitPrice")),
        orderDiscountMinor: integerMinor(data.get("orderDiscount")),
        customerTargetPriceMinor: target ? integerMinor(target) : null,
        paymentTermDays: Math.round(Number(data.get("paymentTermDays") ?? 0)),
        creditRiskBps: null,
        manualEscalation: data.get("manualEscalation") === "on",
        giftItems: [],
        surchargeContext: {
          region: String(data.get("region") ?? "").trim() || null,
          deliveryMethod: String(data.get("deliveryMethod") ?? "").trim() || null
        }
      };
    };

    const onQuoteSubmit = (event: Event) => {
      const assessmentForm = (event.target as HTMLElement | null)
        ?.closest<HTMLFormElement>("[data-quote-assessment-form]");
      if (assessmentForm && quoteHost?.contains(assessmentForm)) {
        event.preventDefault();
        if (quoteState.kind !== "assessment_required") return;
        const assessmentState = quoteState;
        const data = new FormData(assessmentForm);
        const closeProbability = Number(data.get("closeProbability") ?? 0);
        const evidenceSummary = String(data.get("evidenceSummary") ?? "").trim();
        renderQuote({ kind: "loading_case" });
        quoteCommandAbort?.abort();
        const commandAbort = new AbortController();
        quoteCommandAbort = commandAbort;
        void quoteController.createCase({
          customerId: assessmentState.customerId,
          dealId: assessmentState.dealId,
          assignedTo: assessmentState.assignedTo,
          crmAssessment: {
            demandConfirmed: data.get("demandConfirmed") === "on",
            budgetConfirmed: data.get("budgetConfirmed") === "on",
            decisionMakerConfirmed: data.get("decisionMakerConfirmed") === "on",
            closeProbabilityBps: Math.round(closeProbability * 100),
            evidenceSummary
          }
        }, commandAbort.signal).then((created) => {
          if (commandAbort.signal.aborted || quoteCommandAbort !== commandAbort) {
            return;
          }
          renderQuote(created);
          if (created.kind === "case_created") {
            window.location.hash = growthHash({
              name: "quote", quoteCaseId: created.case.id
            });
          }
        });
        return;
      }
      const form = (event.target as HTMLElement | null)
        ?.closest<HTMLFormElement>("[data-quote-preview-form]");
      if (!form || !quoteHost?.contains(form)) return;
      event.preventDefault();
      if (!(quoteState.kind === "editing" || quoteState.kind === "preview_ready")) return;
      const input = previewInputFrom(form);
      const currentCase = quoteState.case;
      renderQuote({ kind: "previewing", case: currentCase, input });
      quoteCommandAbort?.abort();
      const commandAbort = new AbortController();
      quoteCommandAbort = commandAbort;
      void quoteController.preview(
        currentCase.id,
        input,
        form.dataset.etag ?? "",
        commandAbort.signal
      ).then((state) => {
        if (!commandAbort.signal.aborted && quoteCommandAbort === commandAbort) {
          renderQuote(state);
        }
      });
    };

    const onQuoteClick = (event: Event) => {
      const listFilter = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>("[data-quote-list-filter]");
      if (listFilter && quoteHost?.contains(listFilter)) {
        quoteHost.querySelectorAll<HTMLButtonElement>("[data-quote-list-filter]").forEach((button) => {
          const active = button === listFilter;
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", String(active));
        });
        const select = quoteHost.querySelector<HTMLSelectElement>("[data-quote-status-filter]");
        if (select) select.value = listFilter.dataset.quoteListFilter ?? "all";
        applyQuoteListFilters();
        return;
      }
      const refresh = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>("[data-quote-list-refresh]");
      if (refresh && quoteHost?.contains(refresh)) {
        renderQuote({ kind: "loading_case" });
        void quoteController.listCases().then(renderQuote);
        return;
      }
      const target = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>("[data-quote-action]");
      if (!target || !quoteHost?.contains(target)) return;
      const action = target.dataset.quoteAction;
      const caseId = target.dataset.caseId
        ?? ("case" in quoteState ? quoteState.case.id : "");
      const versionId = target.dataset.versionId ?? "";
      const etag = target.dataset.etag ?? "";
      const after = async (state: QuoteWorkbenchState) => {
        renderQuote(state);
        if (caseId && !["error", "conflict", "hard_blocked"].includes(state.kind)) {
          await reloadQuoteCase(caseId);
        }
      };
      if (action === "save-draft" && quoteState.kind === "preview_ready") {
        void quoteController.saveDraft(
          quoteState.case.id, quoteState.input, quoteState.preview, etag
        ).then(after);
        return;
      }
      if (action === "submit-version" && versionId) {
        void quoteController.submit(versionId, etag).then(after);
        return;
      }
      if ((action === "approve-version" || action === "reject-version")
        && versionId) {
        const item = target.closest<HTMLElement>(".quote-version");
        const reasonInput = item?.querySelector<HTMLInputElement>(
          "[data-quote-decision-reason]"
        );
        const reason = reasonInput?.value.trim() ?? "";
        if (!reason) {
          reasonInput?.setCustomValidity("请填写审批说明");
          reasonInput?.reportValidity();
          return;
        }
        reasonInput?.setCustomValidity("");
        const command = action === "approve-version"
          ? quoteController.approve(versionId, etag, reason)
          : quoteController.reject(versionId, etag, reason);
        void command.then(after);
      }
    };

    const applyQuoteListFilters = () => {
      if (!quoteHost) return;
      const query = quoteHost.querySelector<HTMLInputElement>("[data-quote-list-query]")
        ?.value.trim().toLocaleLowerCase("zh-CN") ?? "";
      const filter = quoteHost.querySelector<HTMLSelectElement>("[data-quote-status-filter]")
        ?.value ?? "all";
      quoteHost.querySelectorAll<HTMLElement>("[data-quote-case-status]").forEach((row) => {
        const status = row.dataset.quoteCaseStatus ?? "";
        row.hidden = !matchesQuoteCaseFilter(status, filter, row.dataset.quoteCaseSearch ?? "", query);
      });
    };

    const onQuoteFilterInput = (event: Event) => {
      const control = (event.target as HTMLElement | null)?.closest(
        "[data-quote-list-query], [data-quote-status-filter]"
      );
      if (!control || !quoteHost?.contains(control)) return;
      if (control instanceof HTMLSelectElement) {
        quoteHost.querySelectorAll<HTMLButtonElement>("[data-quote-list-filter]").forEach((button) => {
          const active = button.dataset.quoteListFilter === control.value;
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", String(active));
        });
      }
      applyQuoteListFilters();
    };

    registry.register("quote", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        quoteHost = host;
        host.addEventListener("submit", onQuoteSubmit);
        host.addEventListener("click", onQuoteClick);
        host.addEventListener("input", onQuoteFilterInput);
        host.addEventListener("change", onQuoteFilterInput);
        const route = context.route.name === "quote" ? context.route : null;
        const caseId = route?.quoteCaseId;
        if (!caseId) {
          renderQuote({ kind: "loading_case" });
          const subject = route?.dealId
            ? { dealId: route.dealId }
            : route?.customerId
              ? { customerId: route.customerId }
              : route?.candidateId
                ? { candidateId: route.candidateId } : null;
          if (subject) {
            const assignedTo = route?.assignedTo?.trim()
              || document.body.dataset.sessionUserId?.trim();
            if (!assignedTo) {
              renderQuote({ kind: "error", message: "当前登录用户信息不可用" });
              return;
            }
            if (route?.dealId && !route.candidateId) {
              renderQuote({
                kind: "assessment_required",
                customerId: route.customerId?.trim() || null,
                dealId: route.dealId,
                assignedTo
              });
              return;
            }
            const created = await quoteController.createCase({
              ...subject,
              ...(route?.customerId ? { customerId: route.customerId } : {}),
              assignedTo
            }, context.signal);
            if (context.signal.aborted) return;
            renderQuote(created);
            if (created.kind === "case_created") {
              window.location.hash = growthHash({
                name: "quote", quoteCaseId: created.case.id
              });
            }
            return;
          }
          const state = await quoteController.listCases(context.signal);
          if (context.signal.aborted) return;
          renderQuote(state);
          return;
        }
        renderQuote({ kind: "loading_case" });
        const [state, catalog] = await Promise.all([
          quoteController.loadCase(caseId, context.signal),
          quoteCatalogController.load(context.signal)
        ]);
        if (context.signal.aborted) return;
        quoteViewOptions = viewOptions(catalog);
        renderQuote(state);
      },
      unmount() {
        quoteCommandAbort?.abort();
        quoteCommandAbort = null;
        quoteHost?.removeEventListener("submit", onQuoteSubmit);
        quoteHost?.removeEventListener("click", onQuoteClick);
        quoteHost?.removeEventListener("input", onQuoteFilterInput);
        quoteHost?.removeEventListener("change", onQuoteFilterInput);
        quoteHost = null;
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("finance") === null && mode.kind === "real") {
    let financeAnalysis: ReturnType<typeof mountEnterpriseAnalysis> | null = null;
    const financeApi = createFinanceApi(http);
    const financeController = createFinanceController({
      api: financeApi,
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    const financeImport = createFinanceImportWorkflow(financeApi);
    let financeHost: HTMLElement | null = null;
    let financeAbort: AbortController | null = null;
    // Retain the native File handle across form renders; byte content exists only
    // while previewImport reads and sends it, never in browser persistence.
    let financeFile: File | null = null;
    let financeQueue: File[] = [];
    const financeQueueStatus = new Map<File, string>();
    let financeKind: "readonly" | "acquisition_cost" | "financial_fact" = "readonly";
    let financeDocument: FinanceDocumentInspection | null = null;
    let financeMapping: FinanceImportMapping = {};
    const canImportFinance = (mode.bootstrap.capabilities as readonly string[]).includes("ledger.pending.create");
    const canReadFinanceModel = (mode.bootstrap.capabilities as readonly string[]).includes("finance.council.run");
    const documentScope = financeDocumentScope(mode.bootstrap.workspaceId, document.body.dataset.sessionUserId);
    let financeBusy = false;
    const renderFinance = (state: Awaited<ReturnType<typeof financeController.load>>) => {
      if (financeHost) financeHost.innerHTML = renderFinancePage(state, {
        kind: financeKind,
        document: financeDocument,
        mapping: financeMapping,
        file: financeFile ? { name: financeFile.name, size: financeFile.size } : null
      });
      if (financeHost && financeQueue.length) {
        const queue = document.createElement('section'); queue.setAttribute('aria-label', '逐文件入账队列');
        const label = document.createElement('p'); label.textContent = '逐文件入账：选择一份核对用途、映射与预览，再明确提交。其余文件不会一并入账。'; queue.append(label);
        financeQueue.forEach((file, index) => {
          const row = document.createElement('div'); const text = document.createElement('span'); text.textContent = `${file.name} · ${financeQueueStatus.get(file) ?? '待处理'} `;
          const open = document.createElement('button'); open.type = 'button'; open.dataset.financeQueueOpen = String(index); open.textContent = file === financeFile ? '重新核对 / 重试' : '核对此文件'; open.disabled = financeBusy;
          const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.financeQueueRemove = String(index); remove.textContent = '移除'; remove.disabled = financeBusy;
          row.append(text, open, remove); queue.append(row);
        });
        financeHost.prepend(queue);
      }
    };
    const renderFinanceImportState = async (
      importState: Awaited<ReturnType<typeof financeImport.preview>>,
      signal?: AbortSignal
    ) => {
      if (!financeHost || signal?.aborted) return;
      financeBusy = false;
      if (financeFile && financeQueue.includes(financeFile)) financeQueueStatus.set(financeFile,
        importState.kind === 'failed' ? importState.message : importState.kind === 'succeeded' ? '已提交' : importState.kind === 'partial_success' ? '部分成功，需核对' : importState.kind === 'document_ready' ? '已读取，待核对入账' : '待核对或提交');
      if (importState.kind === "document_ready") {
        financeDocument = importState.document;
        if (financeDocument.selectedForConversation && documentScope) {
          const { documentId, fileName, fileHash, classification, missingStatements, expiresAt } = financeDocument;
          setFinanceDocumentSelection(documentScope, { kind: "readonly_document", documentId, fileName, fileHash, classification, missingStatements, expiresAt });
        }
      }
      if (importState.kind === "succeeded" || importState.kind === "partial_success") financeFile = null;
      renderFinance(financeController.setImportState(importState));
      if (importState.kind === "succeeded" || importState.kind === "partial_success") {
        const refreshed = await financeController.load(signal);
        if (!signal?.aborted) renderFinance(refreshed);
      }
    };
    const inspectFinanceFile = (file: File, readWithModel = false) => {
      if (readWithModel && !canReadFinanceModel) return;
      financeAbort?.abort();
      const abort = new AbortController(); financeAbort = abort;
      financeFile = file;
      const issue = financeDocumentFileIssue(file, file.name);
      if (issue) { void renderFinanceImportState({ kind: "failed", message: issue }, abort.signal); return; }
      financeBusy = true;
      renderFinance(financeController.setImportState({ kind: "inspecting", readWithModel }));
      void financeImport.inspect(file, file.name, readWithModel, abort.signal).then(state => {
        if (financeAbort === abort && financeFile === file && !abort.signal.aborted) return renderFinanceImportState(state, abort.signal);
      });
    };
    const onFinanceSubmit = (event: Event) => {
      const form = (event.target as HTMLElement | null)
        ?.closest<HTMLFormElement>("[data-finance-import-form]");
      if (!form || !financeHost?.contains(form)) return;
      event.preventDefault();
      event.stopPropagation();
      if (financeBusy) return;
      const file = financeFile ?? form.querySelector<HTMLInputElement>(
        "[data-finance-import-file]"
      )?.files?.[0];
      const kind = form.querySelector<HTMLSelectElement>(
        "[data-finance-import-kind]"
      )?.value;
      if (!file) {
        void renderFinanceImportState({ kind: "failed", message: "请选择 CSV、XLSX、含文字的 PDF 或 DOCX 文件" }); return;
      }
      if (file && kind === "readonly") { inspectFinanceFile(file); return; }
      if (!canImportFinance) return;
      if (!file || (kind !== "acquisition_cost" && kind !== "financial_fact")) {
        void renderFinanceImportState({
          kind: "failed",
          message: "请选择 CSV 或 XLSX 文件"
        });
        return;
      }
      const issue = financeImportFileIssue(file, file.name);
      if (issue) {
        void renderFinanceImportState({ kind: "failed", message: issue });
        return;
      }
      financeFile = file;
      financeKind = kind;
      form.querySelectorAll<HTMLInputElement>("[data-finance-mapping]").forEach(input => {
        const field = input.dataset.financeMapping!;
        if (input.value.trim()) financeMapping[field] = input.value.trim();
        else delete financeMapping[field];
      });
      financeAbort?.abort();
      const abort = new AbortController();
      financeAbort = abort;
      financeBusy = true;
      renderFinance(financeController.setImportState({ kind: "uploading" }));
      void financeImport.preview(
        kind,
        file,
        file.name,
        financeController.nextIdempotencyKey("finance-preview"),
        abort.signal,
        financeMapping
      ).then((state) => {
        if (!abort.signal.aborted) return renderFinanceImportState(state, abort.signal);
      });
    };
    const onFinanceClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const queueButton = target?.closest<HTMLButtonElement>('[data-finance-queue-open], [data-finance-queue-remove]');
      if (queueButton && financeHost?.contains(queueButton) && !financeBusy) {
        const file = financeQueue[Number(queueButton.dataset.financeQueueOpen ?? queueButton.dataset.financeQueueRemove)];
        if (!file) return;
        if (queueButton.dataset.financeQueueRemove !== undefined) {
          financeQueue = financeQueue.filter(item => item !== file); financeQueueStatus.delete(file);
          if (financeFile === file) { financeFile = null; financeDocument = null; }
          void renderFinanceImportState({ kind: 'idle' });
        } else { financeKind = 'readonly'; financeMapping = {}; inspectFinanceFile(file); }
        return;
      }
      const action = target?.closest<HTMLButtonElement>("[data-action]");
      if (action && financeHost?.contains(action)) {
        if (action.dataset.action === "clear-finance-document-selection") {
          if (financeBusy) return;
          financeAbort?.abort(); const abort = new AbortController(); financeAbort = abort; financeBusy = true;
          void financeApi.clearDocumentSelection(abort.signal).then(() => {
            if (abort.signal.aborted || financeAbort !== abort || !financeHost) return;
            if (documentScope) setFinanceDocumentSelection(documentScope, null);
            if (financeDocument) financeDocument = { ...financeDocument, selectedForConversation: false };
            return renderFinanceImportState(financeDocument ? { kind: "document_ready", document: financeDocument } : { kind: "idle" }, abort.signal);
          }, () => { if (!abort.signal.aborted) void renderFinanceImportState({ kind: "failed", message: "取消资料未完成，仍保留原追问来源，请重试。" }, abort.signal); });
          return;
        }
        if (action.dataset.action === "cancel-finance-document") {
          financeAbort?.abort(); financeAbort = null; financeFile = null; financeDocument = null; financeMapping = {}; financeKind = "readonly";
          void renderFinanceImportState({ kind: "idle" }); return;
        }
        if (action.dataset.action === "read-finance-document") {
          if (!financeBusy && financeFile) inspectFinanceFile(financeFile, true);
          return;
        }
      }
      const tab = target?.closest<HTMLButtonElement>("[data-finance-tab]");
      if (tab && financeHost?.contains(tab)) {
        const selected = tab.dataset.financeTab;
        financeHost.querySelectorAll<HTMLButtonElement>("[data-finance-tab]").forEach((button) => {
          const active = button.dataset.financeTab === selected;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-selected", String(active));
        });
        financeHost.querySelectorAll<HTMLElement>("[data-finance-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.financePanel !== selected;
        });
        return;
      }
      const button = target?.closest<HTMLButtonElement>("[data-action='commit-finance-import']");
      if (!button || !financeHost?.contains(button) || button.disabled || financeBusy || !canImportFinance) return;
      const previewId = button.dataset.financeImportPreviewId;
      if (!previewId) return;
      financeAbort?.abort();
      const abort = new AbortController();
      financeAbort = abort;
      financeBusy = true;
      renderFinance(financeController.setImportState({ kind: "committing" }));
      void financeImport.commit(
        previewId,
        financeController.nextIdempotencyKey("finance-commit"),
        abort.signal
      ).then((state) => {
        if (!abort.signal.aborted) return renderFinanceImportState(state, abort.signal);
      });
    };
    const onFinanceChange = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const form = target?.closest<HTMLFormElement>("[data-finance-import-form]");
      if (form && financeHost?.contains(form)) {
        const fileInput = target?.closest<HTMLInputElement>("[data-finance-import-file]");
        if (fileInput) {
          const files = Array.from(fileInput.files ?? []);
          const file = files[0];
          if (!file) return;
          if (files.length > 10 || files.reduce((sum, item) => sum + item.size, 0) > 5 * 1024 * 1024) { void renderFinanceImportState({ kind: 'failed', message: '每批最多10份，合计5MB；原队列保留。' }); return; }
          financeQueue = files; financeQueueStatus.clear();
          if (files.length > 1) financeAnalysis?.setFiles(files);
          financeDocument = null; financeMapping = {}; financeKind = "readonly";
          inspectFinanceFile(file); return;
        }
        if (financeBusy) return;
        const mappingInput = target?.closest<HTMLInputElement>("[data-finance-mapping]");
        if (mappingInput) {
          if (mappingInput.value.trim()) financeMapping[mappingInput.dataset.financeMapping!] = mappingInput.value.trim();
          else delete financeMapping[mappingInput.dataset.financeMapping!];
          return;
        }
        const kind = form.querySelector<HTMLSelectElement>("[data-finance-import-kind]")?.value;
        if (kind === "readonly" || (canImportFinance && (kind === "acquisition_cost" || kind === "financial_fact"))) financeKind = kind;
        financeMapping = {};
        financeAbort?.abort();
        financeAbort = null;
        const issue = financeFile ? (financeKind === "readonly" ? financeDocumentFileIssue : financeImportFileIssue)(financeFile, financeFile.name) : null;
        void renderFinanceImportState(issue ? { kind: "failed", message: issue } : financeDocument ? { kind: "document_ready", document: financeDocument } : { kind: "idle" });
        return;
      }
      const filter = (event.target as HTMLElement | null)
        ?.closest<HTMLSelectElement>("[data-finance-status-filter]");
      if (!filter || !financeHost?.contains(filter)) return;
      const selected = filter.value;
      financeHost.querySelectorAll<HTMLTableRowElement>("[data-finance-status]").forEach((row) => {
        const status = row.dataset.financeStatus;
        row.hidden = selected !== "all"
          && (selected === "pending" ? status === "verified" : status !== selected);
      });
    };
    const onFinanceDrop = (event: DragEvent) => {
      const zone = (event.target as HTMLElement | null)?.closest("[data-finance-import-dropzone]");
      if (!zone || !financeHost?.contains(zone)) return;
      event.preventDefault();
      if (event.type !== "drop") return;
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      financeAbort?.abort();
      financeAbort = null;
      if (files.length > 10 || Array.from(files).reduce((sum, item) => sum + item.size, 0) > 5 * 1024 * 1024) { void renderFinanceImportState({ kind: 'failed', message: '每批最多10份，合计5MB；原队列保留。' }); return; }
      financeQueue = Array.from(files); financeQueueStatus.clear();
      if (files.length > 1) financeAnalysis?.setFiles(Array.from(files));
      financeDocument = null; financeMapping = {}; financeKind = "readonly";
      inspectFinanceFile(files[0]!);
    };
    registry.register("finance", {
      async mount(context) {
        const outer = growthWorkspaceHost();
        if (!outer) return;
        const analysisHost = document.createElement('div'); const host = document.createElement('div');
        outer.replaceChildren(analysisHost, host);
        financeAnalysis = mountEnterpriseAnalysis({ host: analysisHost, http, purpose: 'finance', canAnalyze: canReadFinanceModel });
        financeHost = host;
        host.addEventListener("submit", onFinanceSubmit);
        host.addEventListener("click", onFinanceClick);
        host.addEventListener("change", onFinanceChange);
        host.addEventListener("dragover", onFinanceDrop);
        host.addEventListener("drop", onFinanceDrop);
        host.innerHTML = renderFinancePage({ kind: "loading" });
        const state = await financeController.load(context.signal);
        if (context.signal.aborted) return;
        renderFinance(state);
      },
      unmount() {
        financeAnalysis?.dispose(); financeAnalysis = null;
        financeQueue = []; financeQueueStatus.clear();
        financeAbort?.abort();
        financeAbort = null;
        financeFile = null;
        financeKind = "readonly";
        financeDocument = null; financeMapping = {};
        financeBusy = false;
        financeController.setImportState({ kind: "idle" });
        financeHost?.removeEventListener("submit", onFinanceSubmit);
        financeHost?.removeEventListener("click", onFinanceClick);
        financeHost?.removeEventListener("change", onFinanceChange);
        financeHost?.removeEventListener("dragover", onFinanceDrop);
        financeHost?.removeEventListener("drop", onFinanceDrop);
        financeHost = null;
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("roi") === null && mode.kind === "real") {
    let roiAnalysis: ReturnType<typeof mountEnterpriseAnalysis> | null = null;
    let roiOuter: HTMLElement | null = null;
    registry.register("roi", createRoiRuntimeBinding({
      getHost: () => {
        roiOuter = growthWorkspaceHost(); if (!roiOuter) return null;
        const analysisHost = document.createElement('div'); const host = document.createElement('div');
        roiOuter.replaceChildren(analysisHost, host);
        roiAnalysis = mountEnterpriseAnalysis({ host: analysisHost, http, purpose: 'roi',
          canAnalyze: (mode.bootstrap.capabilities as readonly string[]).includes('finance.council.run') });
        return host;
      },
      clearHost: () => { roiAnalysis?.dispose(); roiAnalysis = null; if (roiOuter) clearGrowthContent(roiOuter); roiOuter = null; },
      createController: () => createRoiController({
        api: createGrowthPerformanceApi(http),
        hasFeature: (feature) =>
          mode.kind === "real"
          && (mode.bootstrap.features as readonly string[]).includes(feature),
        hasCapability: (capability) =>
          mode.kind === "real"
          && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
      })
    }));
  }
  if (registry.get("advisor") === null && mode.kind === "real") {
    const advisorApi = createAdvisorApi(http);
    const advisorController = createAdvisorController({
      api: advisorApi,
      copilot: createAdvisorCopilotWorkflow({
        async createSession() {
          throw new Error("advisor_copilot_session_required");
        },
        async postMessage() {
          throw new Error("advisor_copilot_session_required");
        },
        async getTask() {
          throw new Error("advisor_copilot_session_required");
        }
      }),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    let advisorHost: HTMLElement | null = null;
    let advisorState: AdvisorHomeState = { kind: "loading" };
    const onAdvisorClick = (event: Event) => {
      const button = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>("button[data-action]");
      if (!button || !advisorHost?.contains(button)
        || advisorState.kind !== "ready") return;
      const action = button.dataset.action;
      if (action === "advisor-refresh") {
        advisorHost.innerHTML = renderAdvisorHome({ kind: "loading" });
        void advisorController.loadToday({
          currency: "CNY",
          asOf: new Date().toISOString()
        }).then((state) => {
          advisorState = state;
          if (advisorHost) advisorHost.innerHTML = renderAdvisorHome(state);
        });
        return;
      }
      if (action === "gap-navigate") {
        window.location.hash = button.dataset.source === "commercial_binding"
          ? "#growth/catalog"
          : "#growth/finance";
        return;
      }
      if (action !== "accept" && action !== "ignore" && action !== "complete") {
        return;
      }
      const recommendation = (advisorState.today.recommendations ?? [])
        .find((row) => row.id === button.dataset.id);
      if (!recommendation) return;
      advisorState = {
        ...advisorState,
        decidingId: recommendation.id
      };
      advisorHost.innerHTML = renderAdvisorHome(advisorState);
      void advisorController.decide(action, recommendation).then((state) => {
        advisorState = state;
        if (advisorHost) advisorHost.innerHTML = renderAdvisorHome(state);
      });
    };
    registry.register("advisor", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        advisorHost = host;
        host.addEventListener("click", onAdvisorClick);
        host.innerHTML = renderAdvisorHome({ kind: "loading" });
        const state = await advisorController.loadToday({
          currency: "CNY",
          asOf: new Date().toISOString()
        }, context.signal);
        if (context.signal.aborted) return;
        advisorState = state;
        host.innerHTML = renderAdvisorHome(state);
      },
      unmount() {
        advisorHost?.removeEventListener("click", onAdvisorClick);
        advisorHost = null;
        advisorState = { kind: "loading" };
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("financial-council") === null && mode.kind === "real") {
    let councilAnalysis: ReturnType<typeof mountEnterpriseAnalysis> | null = null;
    const api = createFinancialCouncilApi(http);
    let councilEntry: ReturnType<typeof createFinancialCouncilWorkbenchEntry> | null = null;
    let councilMountGeneration = 0;
    registry.register("financial-council", {
      async mount(context) {
        const expectedMount = ++councilMountGeneration;
        const outer = growthWorkspaceHost();
        if (!outer) return;
        const analysisHost = document.createElement('div'); const host = document.createElement('div');
        outer.replaceChildren(analysisHost, host);
        councilAnalysis = mountEnterpriseAnalysis({ host: analysisHost, http, purpose: 'management',
          canAnalyze: (mode.bootstrap.capabilities as readonly string[]).includes('finance.council.run') });
        const controller = createFinancialCouncilController({ api });
        const [centerResult, policyResult] = await Promise.allSettled([
          createRealAgentCenterApi(http).getAgentCenter(), api.getPolicy()
        ]);
        if (expectedMount !== councilMountGeneration) { controller.destroy(); return; }
        const center = centerResult.status === "fulfilled" ? centerResult.value.body : null;
        const policy = policyResult.status === "fulfilled" ? policyResult.value.body : null;
        const packageInput = center?.capabilities.canRun && center.data.status === "ready"
          && center.models.status === "ready" && center.data.packageId && policy
          ? { statementPackageId: center.data.packageId, policyVersionId: policy.policyVersionId }
          : null;
        councilEntry = createFinancialCouncilWorkbenchEntry({
          host,
          controller,
          capabilities: mode.bootstrap.capabilities as readonly string[],
          canCreate: !!packageInput,
          packageInput,
          createBlockedReason: !center || !policy ? "分析配置暂未加载，请到智能体中心检查资料与策略。"
            : !center.capabilities.canRun ? "当前账号没有发起分析权限。"
            : center.data.status !== "ready" ? "正式三表专项分析需要已确认三表；不影响上方企业资料分析。"
            : "请先完成六角色模型配置。"
        });
        const runId = context.route.name === "financial-council"
          ? context.route.runId : undefined;
        await councilEntry.mount(runId);
      },
      unmount() {
        councilMountGeneration += 1;
        councilAnalysis?.dispose(); councilAnalysis = null;
        councilEntry?.dispose();
        councilEntry = null;
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (mode.kind !== "unavailable"
    && !singleShot
    && startEpoch === runtimeEpoch) {
    sharedRuntime = { registry, mode };
  }
  if (mode.kind !== "unavailable") {
    dispatchPage(registry, mode, startEpoch);
  }
  return mode;
}

export { growthHash };
