import type { DemoModule } from "./demo-types";
import { parseGrowthHash } from "../growth/router";

export interface DemoRouter {
  current(): DemoModule;
  navigate(module: DemoModule): void;
  subscribe(listener: (module: DemoModule) => void): () => void;
}

interface ModuleMeta {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  primaryAction: string;
}

export const demoModuleMeta: Record<DemoModule, ModuleMeta> = {
  dashboard: {
    title: "自动营销总览",
    subtitle: "汇总全渠道运营数据与今日待办",
    searchPlaceholder: "搜索数据、待办或客户...",
    primaryAction: "查看今日计划"
  },
  acquisition: {
    title: "自动营销系统",
    subtitle: "演示模式 · 获客 · 沟通 · 私域沉淀 · 成交",
    searchPlaceholder: "搜索平台、客户或获客任务...",
    primaryAction: "新建演示获客任务"
  },
  conversations: {
    title: "社媒对话",
    subtitle: "统一处理多平台客户咨询与自动回复",
    searchPlaceholder: "搜索客户、对话或消息...",
    primaryAction: "发起对话"
  },
  "private-domain": {
    title: "私域客户池",
    subtitle: "沉淀客户资产，持续跟进转化",
    searchPlaceholder: "搜索客户、标签或跟进任务...",
    primaryAction: "添加客户"
  },
  conversion: {
    title: "成交工作台",
    subtitle: "跟进商机、报价和成交进度",
    searchPlaceholder: "搜索商机、客户或报价...",
    primaryAction: "新建商机"
  },
  agents: {
    title: "智能体中心",
    subtitle: "配置自动营销智能体与执行状态",
    searchPlaceholder: "搜索智能体、能力或任务...",
    primaryAction: "新建智能体"
  },
  scripts: {
    title: "自动工作流",
    subtitle: "管理自动化工作流与执行计划",
    searchPlaceholder: "搜索工作流、平台或执行记录...",
    primaryAction: "新建工作流"
  },
  "trade-marketing": {
    title: "外贸营销",
    subtitle: "触达海外市场，拓展全球客户",
    searchPlaceholder: "搜索市场、客户或营销活动...",
    primaryAction: "新建营销活动"
  },
  settings: {
    title: "设置中心",
    subtitle: "管理自动营销系统的偏好与权限",
    searchPlaceholder: "搜索设置项...",
    primaryAction: "保存设置"
  }
};

const modules = new Set<DemoModule>(Object.keys(demoModuleMeta) as DemoModule[]);

function moduleFromHash(fallback: DemoModule): DemoModule {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return fallback;
  return modules.has(hash as DemoModule) ? hash as DemoModule : "acquisition";
}

export function createDemoRouter(initial: DemoModule = "acquisition"): DemoRouter {
  const growthRequested = parseGrowthHash(window.location.hash) !== null;
  let active = growthRequested
    ? initial
    : moduleFromHash(initial);
  const listeners = new Set<(module: DemoModule) => void>();

  function renderShell(module: DemoModule): void {
    const acquisition = module === "acquisition";
    document.querySelectorAll<HTMLElement>("[data-replica-module-panel=\"acquisition\"]").forEach((panel) => {
      panel.hidden = !acquisition;
    });
    const main = document.querySelector<HTMLElement>("#demoModuleMain");
    const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
    if (main) main.hidden = acquisition;
    if (inspector) inspector.hidden = acquisition;

    document.querySelectorAll<HTMLElement>("[data-replica-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.replicaView === module);
    });

    const meta = demoModuleMeta[module];
    const title = document.querySelector<HTMLElement>("#replicaHeaderTitle");
    const subtitle = document.querySelector<HTMLElement>("#replicaHeaderSubtitle");
    const search = document.querySelector<HTMLInputElement>("#replicaSearchInput");
    const action = document.querySelector<HTMLElement>("#replicaNewTaskButton span");
    const realAcquisition = acquisition
      && document.querySelector<HTMLElement>(".replica-shell")?.dataset.acquisitionMode === "real";
    if (title) title.textContent = meta.title;
    if (subtitle) subtitle.textContent = realAcquisition
      ? "真实抖音任务 · 公开搜索 · AI 研判 · 人工审核"
      : meta.subtitle;
    if (search) search.placeholder = meta.searchPlaceholder;
    if (action) action.textContent = realAcquisition ? "新建真实任务" : meta.primaryAction;
  }

  function navigate(module: DemoModule): void {
    active = modules.has(module) ? module : "acquisition";
    renderShell(active);
    if (window.location.hash !== `#${active}`) window.location.hash = active;
    listeners.forEach((listener) => listener(active));
  }

  window.addEventListener("hashchange", () => {
    if (parseGrowthHash(window.location.hash)) return;
    const next = moduleFromHash(initial);
    if (next === active) return;
    active = next;
    renderShell(active);
    listeners.forEach((listener) => listener(active));
  });

  renderShell(active);
  if (!growthRequested && window.location.hash !== `#${active}`) window.location.hash = active;

  return {
    current: () => active,
    navigate,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
