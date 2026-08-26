import { parseGrowthHash, type GrowthRoute } from "./router";
import {
  growthWorkspaceHost,
  resetGrowthRuntime,
  startGrowthRuntime
} from "./runtime";

interface GrowthRouteMeta {
  title: string;
  subtitle: string;
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

export function renderQuoteCaseSelectionRequired(): string {
  return `<section class="growth-panel growth-empty-state">
    <span class="demo-status">报价工作台</span>
    <h2>请选择报价案例</h2>
    <p>请先从客户目录或商机详情进入报价工作台，系统会带入对应客户、需求和报价依据。</p>
    <a class="demo-primary" href="#growth/catalog">前往客户目录</a>
  </section>`;
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
  const shells = document.querySelectorAll<HTMLElement>(".replica-shell");
  let startPromise: Promise<void> | null = null;
  let resetPromise: Promise<void> = Promise.resolve();
  let retryAfterPending = false;
  let surfaceSequence = 0;

  const syncSurface = (): GrowthRoute | null => {
    const route = parseGrowthHash(window.location.hash);
    if (route) {
      document.querySelectorAll<HTMLElement>(
        '[data-replica-module-panel="acquisition"]'
      ).forEach((panel) => { panel.hidden = true; });
      if (host) host.hidden = false;
      const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
      if (inspector) inspector.hidden = true;
      const title = document.querySelector<HTMLElement>("#replicaHeaderTitle");
      const subtitle = document.querySelector<HTMLElement>("#replicaHeaderSubtitle");
      const meta = growthRouteMeta(route);
      if (title) title.textContent = meta.title;
      if (subtitle) subtitle.textContent = meta.subtitle;
    }
    document.querySelectorAll<HTMLElement>("[data-growth-nav]").forEach((link) => {
      const active = link.dataset.growthRoute === route?.name;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    shells.forEach((shell) => { shell.hidden = false; });
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
    if (route.name === "quote" && !route.quoteCaseId) {
      retryAfterPending = false;
      resetPromise = resetPromise
        .catch(() => undefined)
        .then(() => resetGrowthRuntime())
        .then(() => {
          if (request !== surfaceSequence) return;
          const current = parseGrowthHash(window.location.hash);
          if (current?.name === "quote" && !current.quoteCaseId && host) {
            host.innerHTML = renderQuoteCaseSelectionRequired();
          }
        })
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
