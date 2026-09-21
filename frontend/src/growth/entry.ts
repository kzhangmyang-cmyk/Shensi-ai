import { parseGrowthHash, type GrowthRoute } from "./router";
import { quoteEntryHash, type QuoteEntryContext } from "./quotes/entry";
import {
  growthWorkspaceHost,
  resetGrowthRuntime,
  startGrowthRuntime
} from "./runtime";

interface GrowthRouteMeta {
  title: string;
  subtitle: string;
}

interface GrowthToolbarMeta {
  showToolbar: boolean;
  searchPlaceholder: string;
  primaryAction: string;
}

const GROWTH_ROUTE_NAMES: readonly GrowthRoute["name"][] = [
  "advisor", "agents", "catalog", "quote", "finance", "roi", "financial-council"
];

/* These classes belong to mutually exclusive demo modules.  The demo router
   can leave one on the shared shell while a Growth hash is being mounted;
   keeping it would let that module's page CSS hide or reposition Growth. */
const CONFLICTING_DEMO_ROUTE_CLASSES = [
  "is-dashboard-route",
  "is-agents-route",
  "is-acquisition-route",
  "is-conversations-route",
  "is-private-domain-route",
  "is-settings-route"
] as const;

export function clearGrowthDemoRouteClasses(shell: HTMLElement): void {
  shell.classList.remove(...CONFLICTING_DEMO_ROUTE_CLASSES);
}

export function growthRouteMeta(route: GrowthRoute): GrowthRouteMeta {
  switch (route.name) {
    case "advisor":
      return { title: "增长顾问", subtitle: "今日经营建议与待办优先级" };
    case "agents":
      return { title: "智能体中心", subtitle: "真实任务、能力与执行状态" };
    case "catalog":
      return { title: "客户目录", subtitle: "统一查看客户、线索与经营资料" };
    case "quote":
      return { title: "报价工作台", subtitle: "基于客户需求生成、审批与追踪报价" };
    case "finance":
      return { title: "财务经营", subtitle: "查看经营数据、归因与财务进度" };
    case "roi":
      return { title: "ROI 经营分析", subtitle: "评估投入产出与增长效率" };
    case "financial-council":
      return { title: "财务委员会", subtitle: "真实三表 · 六角色审计 · 人工审批" };
  }
}

export function growthToolbarMeta(route: GrowthRoute): GrowthToolbarMeta {
  if (route.name === "finance") {
    return {
      showToolbar: false,
      searchPlaceholder: "",
      primaryAction: ""
    };
  }
  return {
    showToolbar: true,
    searchPlaceholder: "搜索客户、商机或任务...",
    primaryAction: "查看今日待办"
  };
}

export function resetGrowthSurfaceScroll(
  shells: Iterable<HTMLElement>,
  host: HTMLElement | null
): void {
  for (const shell of shells) shell.scrollTop = 0;
  if (host) host.scrollTop = 0;
}

function currentGrowthShells(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".replica-shell")];
}

function renderUnavailable(reason: string): void {
  const host = growthWorkspaceHost();
  if (!host) return;
  host.innerHTML = `<div class="growth-unavailable">
    <p>Growth 真实模式不可用：<code>${reason.replace(/[<>&"]/gu, "")}</code></p>
  </div>`;
}

export function startGrowthWhenRequested(): void {
  const host = growthWorkspaceHost();
  let startPromise: Promise<void> | null = null;
  let resetPromise: Promise<void> = Promise.resolve();
  let retryAfterPending = false;
  let surfaceSequence = 0;
  let activeGrowthHash: string | null = null;

  const syncSurface = (): GrowthRoute | null => {
    const route = parseGrowthHash(window.location.hash);
    const searchRegion = document.querySelector<HTMLElement>(".replica-search");
    const searchInput = document.querySelector<HTMLInputElement>("#replicaSearchInput");
    const primaryAction = document.querySelector<HTMLButtonElement>("#replicaNewTaskButton");
    const primaryActionLabel = document.querySelector<HTMLElement>("#replicaNewTaskButton span");
    const shells = currentGrowthShells();
    shells.forEach((shell) => {
      shell.classList.toggle("is-growth-route", Boolean(route));
      for (const name of GROWTH_ROUTE_NAMES) {
        shell.classList.toggle(`is-growth-${name}-route`, route?.name === name);
      }
      if (route) clearGrowthDemoRouteClasses(shell);
    });
    if (route) {
      if (activeGrowthHash !== window.location.hash) {
        resetGrowthSurfaceScroll(shells, host);
        activeGrowthHash = window.location.hash;
      }
      document.querySelectorAll<HTMLElement>(
        '[data-replica-module-panel="acquisition"]'
      ).forEach((panel) => { panel.hidden = true; });
      if (host) host.hidden = false;
      const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
      if (inspector) inspector.hidden = true;
      const title = document.querySelector<HTMLElement>("#replicaHeaderTitle");
      const subtitle = document.querySelector<HTMLElement>("#replicaHeaderSubtitle");
      const meta = growthRouteMeta(route);
      const toolbar = growthToolbarMeta(route);
      if (title) title.textContent = meta.title;
      if (subtitle) subtitle.textContent = meta.subtitle;
      if (searchRegion) {
        searchRegion.hidden = !toolbar.showToolbar;
        searchRegion.style.display = toolbar.showToolbar ? "" : "none";
      }
      if (searchInput && toolbar.showToolbar) searchInput.placeholder = toolbar.searchPlaceholder;
      if (primaryAction) {
        primaryAction.hidden = !toolbar.showToolbar;
        primaryAction.style.display = toolbar.showToolbar ? "" : "none";
      }
      if (primaryActionLabel && toolbar.showToolbar) primaryActionLabel.textContent = toolbar.primaryAction;
      document.querySelectorAll<HTMLElement>("[data-replica-view]").forEach((button) => {
        button.classList.remove("active");
        button.removeAttribute("aria-current");
      });
    } else {
      if (searchRegion) {
        searchRegion.hidden = false;
        searchRegion.style.display = "";
      }
      if (primaryAction) {
        primaryAction.hidden = false;
        primaryAction.style.display = "";
      }
      activeGrowthHash = null;
    }
    document.querySelectorAll<HTMLElement>("[data-growth-nav]").forEach((link) => {
      const active = link.dataset.growthRoute === route?.name;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    currentGrowthShells().forEach((shell) => { shell.hidden = false; });
    return route;
  };

  const startGrowth = () => {
    if (startPromise) {
      retryAfterPending = true;
      return;
    }
    let retryableOutcome = true;
    startPromise = startGrowthRuntime()
      .then((mode) => {
        retryableOutcome = mode.kind === "unavailable"
          || mode.kind === "cancelled";
        if (mode.kind === "unavailable") renderUnavailable(mode.reason);
      })
      .catch(() => {
        renderUnavailable("workspace_selection_required");
      })
      .finally(() => {
        startPromise = null;
        if (!retryAfterPending || !retryableOutcome) {
          retryAfterPending = false;
          return;
        }
        retryAfterPending = false;
        startRequestedGrowth();
      });
  };

  const startRequestedGrowth = () => {
    const request = ++surfaceSequence;
    const route = syncSurface();
    if (!route) {
      retryAfterPending = false;
      resetPromise = resetPromise
        .catch(() => undefined)
        .then(() => resetGrowthRuntime())
        .catch(() => undefined);
      return;
    }
    void resetPromise
      .catch(() => undefined)
      .then(() => {
        if (request !== surfaceSequence
          || parseGrowthHash(window.location.hash) === null) return;
        startGrowth();
      });
  };

  startRequestedGrowth();
  window.addEventListener("hashchange", startRequestedGrowth);
  document.addEventListener("goodjob:quote-workbench-requested", (event) => {
    const detail = (event as CustomEvent<QuoteEntryContext>).detail ?? {};
    window.location.hash = quoteEntryHash(detail);
  });
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    const detail = (event as CustomEvent<{ authenticated?: boolean }>).detail;
    if (detail?.authenticated === false) {
      retryAfterPending = false;
      resetPromise = resetPromise
        .catch(() => undefined)
        .then(() => resetGrowthRuntime())
        .catch(() => undefined);
      return;
    }
    if (detail?.authenticated) {
      void resetPromise
        .catch(() => undefined)
        .then(startRequestedGrowth);
    }
  });
}
