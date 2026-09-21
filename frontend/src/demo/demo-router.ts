import type { DemoModule } from "./demo-types";
import { parseGrowthHash } from "../growth/router";
import { normalizeAppHash } from "../app-route";

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

export interface ModuleSurface {
  mainVisible: boolean;
  inspectorVisible: boolean;
}

export function moduleSurfaceForSession(
  module: DemoModule,
  _captureFixture?: string | null
): ModuleSurface {
  if (module === "acquisition") {
    return { mainVisible: false, inspectorVisible: false };
  }
  if (module === "conversations") {
    return { mainVisible: true, inspectorVisible: false };
  }
  return {
    mainVisible: true,
    inspectorVisible: module === "dashboard"
      || module === "agents"
      || module === "private-domain"
  };
}

export function moduleMetaForSession(
  module: DemoModule,
  sessionMode: string | undefined
): ModuleMeta {
  const meta = demoModuleMeta[module];
  if (module === "agents" && sessionMode === "real") {
    return { ...meta, primaryAction: "向经营顾问提问" };
  }
  if (module !== "dashboard" || sessionMode !== "real") return meta;
  return {
    ...meta,
    subtitle: "本团队经营数据 · 本人待办 · 近三个月趋势",
    searchPlaceholder: "搜索客户、商机或待办..."
  };
}

export const demoModuleMeta: Record<DemoModule, ModuleMeta> = {
  home:{title:'首页',subtitle:'获客 · 经营顾问 · 星盘决策',searchPlaceholder:'选择工作入口',primaryAction:'进入获客中心'},
  "decision-simulation": {title:"星盘决策模拟",subtitle:"同起点经营方案对照与月度回放",searchPlaceholder:"查看经营方案",primaryAction:"编辑经营起点"},
  "enterprise-query": {
    title: "企业查询",
    subtitle: "查询企业资料，查看详情并加入客户池",
    searchPlaceholder: "企业名称、行业或关键词",
    primaryAction: "查询企业"
  },
  dashboard: {
    title: "自动营销总览",
    subtitle: "本地演示数据概览与今日待办",
    searchPlaceholder: "搜索演示数据、客户或工作台...",
    primaryAction: "查看今日待办"
  },
  acquisition: {
    title: "获客中心",
    subtitle: "演示模式 · 获客 · 沟通 · 私域沉淀 · 成交",
    searchPlaceholder: "搜索获客任务...",
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
    searchPlaceholder: "搜索客户、商机或任务...",
    primaryAction: "查看今日待办"
  }
};

const modules = new Set<DemoModule>(Object.keys(demoModuleMeta) as DemoModule[]);

export function demoModuleFromHash(hash: string, fallback: DemoModule): DemoModule {
  const module = hash.replace(/^#/, "");
  return modules.has(module as DemoModule) ? module as DemoModule : fallback;
}

export function createDemoRouter(initial: DemoModule = "agents"): DemoRouter {
  const initialHash = normalizeAppHash(window.location.hash);
  if (window.location.hash !== initialHash) window.history.replaceState(null, "", initialHash);
  const growthRequested = parseGrowthHash(initialHash) !== null;
  let active = growthRequested
    ? initial
    : demoModuleFromHash(initialHash, initial);
  let ownsSurface = !growthRequested;
  const listeners = new Set<(module: DemoModule) => void>();

  function renderShell(module: DemoModule): void {
    const acquisition = module === "acquisition";
    const captureFixture = document.body.dataset.captureFixture ?? null;
    const surface = moduleSurfaceForSession(module, captureFixture);
    document.querySelectorAll<HTMLElement>("[data-replica-module-panel=\"acquisition\"]").forEach((panel) => {
      panel.hidden = !acquisition;
    });
    const main = document.querySelector<HTMLElement>("#demoModuleMain");
    const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
    if (main) main.hidden = !surface.mainVisible;
    if (inspector) {
      inspector.hidden = !surface.inspectorVisible;
      if (!surface.inspectorVisible) inspector.replaceChildren();
    }
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-single-pane-module",
      surface.mainVisible && !surface.inspectorVisible
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-dashboard-route",
      module === "dashboard"
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-agents-route",
      module === "agents"
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-acquisition-route",
      module === "acquisition"
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-conversations-route",
      module === "conversations"
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-private-domain-route",
      module === "private-domain"
    );
    document.querySelector<HTMLElement>(".replica-shell")?.classList.toggle(
      "is-settings-route",
      module === "settings"
    );

    document.querySelectorAll<HTMLElement>("[data-replica-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.replicaView === module);
    });

    const meta = moduleMetaForSession(module, document.body.dataset.sessionMode);
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
    if (action) action.textContent = realAcquisition ? "新建抖音采集计划" : meta.primaryAction;
  }

  function navigate(module: DemoModule): void {
    const nextHash = normalizeAppHash(`#${module}`);
    active = demoModuleFromHash(nextHash, "agents");
    ownsSurface = parseGrowthHash(nextHash) === null;
    renderShell(active);
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
    listeners.forEach((listener) => listener(active));
  }

  window.addEventListener("hashchange", () => {
    const normalizedHash = normalizeAppHash(window.location.hash);
    if (window.location.hash !== normalizedHash) window.history.replaceState(null, "", normalizedHash);
    if (parseGrowthHash(normalizedHash)) {
      ownsSurface = false;
      return;
    }
    const next = demoModuleFromHash(normalizedHash, initial);
    // Growth can replace the shared title, route classes and inspector while
    // the last standalone module remains unchanged.
    if (next === active && ownsSurface) return;
    ownsSurface = true;
    active = next;
    renderShell(active);
    listeners.forEach((listener) => listener(active));
  });

  renderShell(active);

  return {
    current: () => active,
    navigate,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
