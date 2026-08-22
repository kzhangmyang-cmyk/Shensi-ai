import { growthHash, parseGrowthHash, type GrowthRoute } from "./router";
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
import { createQuoteApi } from "./quotes/api";
import { createQuoteController } from "./quotes/controller";
import { renderQuoteWorkbench } from "./quotes/view";
import { createFinanceApi } from "./finance/api";
import { createFinanceController } from "./finance/controller";
import { renderFinancePage } from "./finance/view";
import { createGrowthPerformanceApi } from "./roi/api";
import { createRoiController } from "./roi/controller";
import { renderRoiPage } from "./roi/view";
import { createAdvisorApi } from "./advisor/api";
import { createAdvisorCopilotWorkflow } from "./advisor/copilot-workflow";
import { createAdvisorController } from "./advisor/controller";
import { renderAdvisorHome } from "./advisor/view";
import { createAgentsController } from "./agents/controller";
import type { AgentsSessionState } from "./agents/controller";
import { createFinancialCouncilApi } from "./council/api";
import { createFinancialCouncilController } from "./council/controller";
import { createFinancialCouncilWorkbenchEntry } from "./council/entry";
import type { FinancialCouncilCreateInput } from "./council/api";

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
  return document.querySelector<HTMLElement>("#growthWorkspace");
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
  registry.register("agents", {
    handlesOwnRouteChanges: true,
    async mount() {
      const host = growthWorkspaceHost();
      if (!host) return;
      agentsController ??= createAgentsController({
        http: createGrowthHttpClient(),
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
  if (registry.get("catalog") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const catalogController = createCatalogController({
      api: createCatalogApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    registry.register("catalog", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        host.innerHTML = renderCatalogPage({ kind: "loading" });
        const state = await catalogController.load(context.signal);
        if (context.signal.aborted) return;
        host.innerHTML = renderCatalogPage(state);
      },
      unmount() {
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("quote") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const quoteController = createQuoteController({
      api: createQuoteApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    registry.register("quote", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        const caseId = context.route.name === "quote"
          ? context.route.quoteCaseId : undefined;
        if (!caseId) {
          host.innerHTML = renderQuoteWorkbench({
            kind: "error",
            message: "quote_case_required"
          });
          return;
        }
        host.innerHTML = renderQuoteWorkbench({ kind: "loading_case" });
        const state = await quoteController.loadCase(caseId, context.signal);
        if (context.signal.aborted) return;
        host.innerHTML = renderQuoteWorkbench(state);
      },
      unmount() {
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("finance") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const financeController = createFinanceController({
      api: createFinanceApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    registry.register("finance", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        host.innerHTML = renderFinancePage({ kind: "loading" });
        const state = await financeController.load(context.signal);
        if (context.signal.aborted) return;
        host.innerHTML = renderFinancePage(state);
      },
      unmount() {
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("roi") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const roiController = createRoiController({
      api: createGrowthPerformanceApi(http),
      hasFeature: (feature) =>
        mode.kind === "real"
        && (mode.bootstrap.features as readonly string[]).includes(feature),
      hasCapability: (capability) =>
        mode.kind === "real"
        && (mode.bootstrap.capabilities as readonly string[]).includes(capability)
    });
    registry.register("roi", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        host.innerHTML = renderRoiPage({ kind: "loading" });
        const state = await roiController.loadCohorts(context.signal);
        if (context.signal.aborted) return;
        host.innerHTML = renderRoiPage(state);
      },
      unmount() {
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("advisor") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const advisorController = createAdvisorController({
      api: createAdvisorApi(http),
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
    registry.register("advisor", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        host.innerHTML = renderAdvisorHome({ kind: "loading" });
        const state = await advisorController.loadToday({
          currency: "CNY",
          asOf: new Date().toISOString()
        }, context.signal);
        if (context.signal.aborted) return;
        host.innerHTML = renderAdvisorHome(state);
      },
      unmount() {
        const host = growthWorkspaceHost();
        if (host) clearGrowthContent(host);
      }
    });
  }
  if (registry.get("financial-council") === null && mode.kind === "real") {
    const http = createGrowthHttpClient();
    const api = createFinancialCouncilApi(http);
    let councilEntry: ReturnType<typeof createFinancialCouncilWorkbenchEntry> | null = null;
    registry.register("financial-council", {
      async mount(context) {
        const host = growthWorkspaceHost();
        if (!host) return;
        const controller = createFinancialCouncilController({ api });
        councilEntry = createFinancialCouncilWorkbenchEntry({
          host,
          controller,
          capabilities: mode.bootstrap.capabilities as readonly string[],
          async createInput(dataAsOf) {
            const businessReport = agentsSession.activeInput;
            if (!businessReport) return null;
            const policy = await api.getPolicy();
            return {
              currency: businessReport.currency,
              dataAsOf,
              businessReport: businessReport as unknown as FinancialCouncilCreateInput["businessReport"],
              policyVersionId: policy.body.policyVersionId
            };
          }
        });
        const runId = context.route.name === "financial-council"
          ? context.route.runId : undefined;
        await councilEntry.mount(runId);
      },
      unmount() {
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
