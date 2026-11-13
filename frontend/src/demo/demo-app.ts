import { createDemoRouter, demoModuleMeta } from "./demo-router";
import { createXhsController } from '../conversations/xiaohongshu';
import { renderConversationsView, resetConversationViewState, setConversationFilter } from "./demo-conversations-view";
import { renderCapabilityDemoView } from "./demo-capabilities-view";
import { isOpportunityStage, lossReasons, renderConversionView } from "./demo-conversion-view";
import {
  clearCustomerBatchSelection,
  closeOpportunityForm,
  openOpportunityForm,
  resetPrivateDomainViewState,
  renderPrivateDomainView,
  selectedCustomerBatchIds,
  setPrivateDomainFilter,
  toggleCustomerBatchSelection
} from "./demo-private-domain-view";
import { createDemoStore, type DemoStorageScope } from "./demo-store";
import type { DemoModule, DemoState } from "./demo-types";
import { showDemoToast } from "./demo-ui";
import { renderDashboardView } from "./demo-dashboard-view";
import { createPrivateDomainController } from "../private-domain/controller";
import { createDealCreateController } from "../private-domain/deal-create-controller";
import { parseGrowthHash } from "../growth/router";
import {
  createRealConversationsController,
  shouldUseRealConversations
} from "../conversations/real-controller";
import { createConversationCaptureFixture } from "../conversations/real-capture-fixture";
import {
  createRealDashboardController,
  shouldUseRealDashboard
} from "../dashboard/real-controller";
import { normalizeAppHash } from "../app-route";

/** Lazy-mounted agent controller surface (keeps Growth/agents out of the initial chunk). */
type AgentsDemoController = { render(): void; dispose(): void };
/** Lazy-mounted knowledge library surface. */
type KnowledgeLibraryHandle = { dispose(): void; openUpload(): void };

let agentsDemoController: AgentsDemoController | null = null;
let agentsAuthority: "demo" | "real" | null = null;

function renderAgentConversationInspector(
  inspector: HTMLElement,
  roleName = "经营总管"
): void {
  inspector.innerHTML = `<section class="cfo-chat-inspector" aria-label="本次对话信息">
    <header><h2>本次对话</h2></header>
    <dl>
      <div><dt>当前角色</dt><dd data-cfo-inspector-role>${roleName}</dd></div>
      <div><dt>工作范围</dt><dd>当前工作区</dd></div>
      <div><dt>已使用资料</dt><dd>暂无</dd></div>
    </dl>
    <section><div><h3>相关待办</h3><i class="ph ph-caret-down" aria-hidden="true"></i></div><p>查询完成后显示</p></section>
  </section>`;
}

function currentDemoStorageScope(): DemoStorageScope | null {
  const workspaceId = document.body.dataset.sessionWorkspaceId?.trim();
  const userId = document.body.dataset.sessionUserId?.trim();
  return workspaceId && userId ? { workspaceId, userId } : null;
}

export function readConversationCaptureFixture(locationLike: Pick<Location, "hostname" | "search">):
  ReturnType<typeof createConversationCaptureFixture> | null {
  if (locationLike.hostname !== "localhost"
    && locationLike.hostname !== "127.0.0.1"
    && locationLike.hostname !== "::1") {
    return null;
  }
  const search = new URLSearchParams(locationLike.search);
  return search.get("captureFixture") === "conversations"
    ? createConversationCaptureFixture()
    : null;
}

export { renderDashboardView } from "./demo-dashboard-view";

async function renderModule(module: DemoModule, state: DemoState, host: HTMLElement, inspector: HTMLElement): Promise<void> {
  if(module==='home'){
    inspector.replaceChildren();const scope=JSON.stringify(currentDemoStorageScope());
    const [{ mountHome }, { createAcquisitionApi }] = await Promise.all([
      import("../home/view"),
      import("../acquisition/runtime-api")
    ]);
    mountHome(host,document.body.dataset.sessionMode==='real'?createAcquisitionApi():undefined,()=>JSON.stringify(currentDemoStorageScope())===scope);return;
  }
  if(module==='decision-simulation') {
    inspector.replaceChildren();
    const { mountDecisionSimulation } = await import("../decision-simulation/view");
    mountDecisionSimulation(host);
    return;
  }
  if (module === "enterprise-query") {
    inspector.replaceChildren();
    const { mountEnterpriseQuery } = await import("../enterprise-query/view");
    mountEnterpriseQuery(host);
    return;
  }
  if (module === "dashboard") {
    renderDashboardView(state, host, inspector);
    return;
  }
  if (module === "agents") {
    const authority = document.body.dataset.sessionMode === "real" ? "real" : "demo";
    if (agentsDemoController && agentsAuthority !== authority) {
      agentsDemoController.dispose();
      agentsDemoController = null;
      host.replaceChildren();
      inspector.replaceChildren();
    }
    agentsAuthority = authority;
    renderAgentConversationInspector(inspector);
    if (!agentsDemoController) {
      const [
        { createAgentsController },
        { createGrowthHttpClient },
        { createRealAgentCenterApi },
        { createRealAgentCenterController },
        { mountRetainedCfoConversation }
      ] = await Promise.all([
        import("../growth/agents/controller"),
        import("../growth/http"),
        import("../growth/agents/real-api"),
        import("../growth/agents/real-controller"),
        import("../growth/agents/cfo-session-view")
      ]);
      agentsDemoController = authority === "real"
        ? createAgentsController({
            host,
            supportHost: inspector,
            conversation: chatHost => mountRetainedCfoConversation({ host: chatHost,
              scope: () => { const scope = currentDemoStorageScope(); return scope ? JSON.stringify(scope) : null; },
              http: createGrowthHttpClient({ workspaceId: () => document.body.dataset.sessionWorkspaceId ?? null }) }),
            real: createRealAgentCenterController({
              api: createRealAgentCenterApi(createGrowthHttpClient())
            })
          })
        : createAgentsController({ host, demo: true });
    }
    agentsDemoController.render();
    return;
  }
  if (module === "conversations") {
    renderConversationsView(state, host, inspector);
    return;
  }
  if (module === "private-domain") {
    renderPrivateDomainView(state, host, inspector);
    return;
  }
  if (module === "conversion") {
    renderConversionView(state, host, inspector);
    return;
  }
  if (module === "scripts" || module === "trade-marketing" || module === "settings") {
    renderCapabilityDemoView(module, state, host, inspector);
    return;
  }
}

export function parseFollowUpAt(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

export function handOffDemoSurfaceToGrowth(
  host: HTMLElement,
  inspector: HTMLElement
): void {
  host.hidden = false;
  inspector.replaceChildren();
  inspector.hidden = true;
}

export function startDemoApp(): void {
  const shell = document.querySelector<HTMLElement>(".replica-shell");
  const host = document.querySelector<HTMLElement>("#demoModuleMain");
  const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
  if (!shell || !host || !inspector || shell.dataset.demoAppStarted === "true") return;
  shell.dataset.demoAppStarted = "true";

  const store = createDemoStore({ scope: currentDemoStorageScope() });
  const router = createDemoRouter();
  void import("../growth/entry").then(({ startGrowthWhenRequested }) => startGrowthWhenRequested());
  const conversationCaptureFixture = readConversationCaptureFixture(window.location);
  if (conversationCaptureFixture) {
    document.body.dataset.captureFixture = "conversations";
  }
  const privateDomainController = createPrivateDomainController({
    main: host,
    inspector
  });
  const realConversationsController = createRealConversationsController({
    main: host,
    inspector,
    captureFixture: conversationCaptureFixture
  });
  const realDashboardController = createRealDashboardController({
    main: host,
    inspector
  });
  createDealCreateController();
  let realPrivateDomainActive = false;
  let realConversationsActive = false;
  const xhsController = createXhsController(host);
  let xhsSelected = false;
  let realDashboardActive = false;
  let requestedRealCustomerId = "";
  let greetingSettings: { dispose(): void } | null = null;
  let knowledgeLibrary: KnowledgeLibraryHandle | null = null;
  let knowledgeScope: string | null = null;
  let pendingAgentEntry: { kind: "voice" | "question"; scope: string } | null = null;
  let pendingTodos = 0;
  const currentScope = () => JSON.stringify(currentDemoStorageScope());
  const currentRoute = () => normalizeAppHash(window.location.hash);
  function openAgentEntry(kind: "voice" | "question"): void {
    pendingAgentEntry = { kind, scope: currentScope() };
    router.navigate("agents");
  }
  const completeAgentEntry = (): void => {
    const entry = pendingAgentEntry;
    if (!entry || currentRoute() !== "#agents") return;
    pendingAgentEntry = null;
    if (document.body.dataset.sessionMode !== "real" || entry.scope !== currentScope()) return;
    if (entry.kind === "voice") {
      host.querySelector<HTMLButtonElement>("[data-voice-settings]")?.click();
    } else {
      host.querySelector<HTMLTextAreaElement>("#cfoQuestion")?.focus();
    }
  };
  const openTodayTodos = async (): Promise<void> => {
    const request = ++pendingTodos;
    const scope = currentScope();
    router.navigate("dashboard");
    await realDashboardController.whenIdle();
    if (request !== pendingTodos || currentRoute() !== "#dashboard"
      || document.body.dataset.sessionMode !== "real" || scope !== currentScope()) return;
    const section = host.querySelector<HTMLElement>("[data-dashboard-todos]");
    section?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const updateAgentInspector = (event: Event) => {
    if (router.current() !== "agents") return;
    const detail = (event as CustomEvent<{ roleName?: string }>).detail;
    const role = inspector.querySelector<HTMLElement>("[data-cfo-inspector-role]");
    if (role && detail?.roleName) role.textContent = detail.roleName;
  };
  document.addEventListener("goodjob:cfo-role-changed", updateAgentInspector);
  let renderGeneration = 0;
  const render = () => {
    const generation = ++renderGeneration;
    if (router.current() !== 'knowledge' || parseGrowthHash(window.location.hash) || knowledgeScope !== currentScope()) {
      knowledgeLibrary?.dispose();
      knowledgeLibrary = null;
      knowledgeScope = null;
    }
    if (router.current() !== 'conversations' || document.body.dataset.sessionMode !== 'real' || parseGrowthHash(window.location.hash)) { xhsSelected = false; xhsController.deactivate(); }
    if (currentRoute() !== "#agents") pendingAgentEntry = null;
    greetingSettings?.dispose();
    greetingSettings = null;
    if (currentRoute() !== '#agents') {
      agentsDemoController?.dispose();
      agentsDemoController = null;
      agentsAuthority = null;
    }
    if (parseGrowthHash(window.location.hash)) {
      if (realDashboardActive) realDashboardController.deactivate();
      realDashboardActive = false;
      if (realPrivateDomainActive) privateDomainController.deactivate();
      realPrivateDomainActive = false;
      if (realConversationsActive) realConversationsController.deactivate();
      realConversationsActive = false;
      agentsDemoController?.dispose();
      agentsDemoController = null;
      agentsAuthority = null;
      handOffDemoSurfaceToGrowth(host, inspector);
      return;
    }
    if (router.current() === "private-domain"
      && shell.dataset.acquisitionMode !== "demo") {
      if (realDashboardActive) realDashboardController.deactivate();
      realDashboardActive = false;
      if (realConversationsActive) realConversationsController.deactivate();
      realConversationsActive = false;
      if (!realPrivateDomainActive || requestedRealCustomerId) {
        realPrivateDomainActive = true;
        const preferred = requestedRealCustomerId || undefined;
        requestedRealCustomerId = "";
        void privateDomainController.open(preferred).catch(() => undefined);
      }
      return;
    }
    if (shouldUseRealConversations(
      router.current(),
      document.body.dataset.sessionMode
    )) {
      if (realDashboardActive) realDashboardController.deactivate();
      realDashboardActive = false;
      if (realPrivateDomainActive) privateDomainController.deactivate();
      realPrivateDomainActive = false;
      agentsDemoController?.dispose();
      agentsDemoController = null;
      agentsAuthority = null;
      if (xhsSelected) {
        if (realConversationsActive) realConversationsController.deactivate();
        realConversationsActive = false;
        void xhsController.open();
        return;
      }
      xhsController.deactivate();
      if (!realConversationsActive) {
        realConversationsActive = true;
        void realConversationsController.open().catch(() => undefined);
      }
      return;
    }
    if (shouldUseRealDashboard(
      router.current(),
      document.body.dataset.sessionMode
    )) {
      if (realPrivateDomainActive) privateDomainController.deactivate();
      realPrivateDomainActive = false;
      if (realConversationsActive) realConversationsController.deactivate();
      realConversationsActive = false;
      agentsDemoController?.dispose();
      agentsDemoController = null;
      agentsAuthority = null;
      if (!realDashboardActive) {
        realDashboardActive = true;
        void realDashboardController.open().catch(() => undefined);
      }
      return;
    }
    if (realDashboardActive) realDashboardController.deactivate();
    realDashboardActive = false;
    if (realPrivateDomainActive) privateDomainController.deactivate();
    realPrivateDomainActive = false;
    if (realConversationsActive) realConversationsController.deactivate();
    realConversationsActive = false;
    // A same-route hash notification must not discard the conversation or a
    // settings dialog just opened by the header/navigation action.
    if (router.current() !== "agents") {
      agentsDemoController?.dispose();
      agentsDemoController = null;
      agentsAuthority = null;
    }
    if (router.current() === 'knowledge') {
      inspector.replaceChildren();
      inspector.hidden = true;
      host.hidden = false;
      knowledgeScope = currentScope();
      void import("../knowledge/view").then(({ mountKnowledgeLibrary }) => {
        if (generation !== renderGeneration || router.current() !== "knowledge") return;
        knowledgeLibrary ??= mountKnowledgeLibrary(host);
      });
      return;
    }
    const moduleName = router.current();
    void renderModule(moduleName, store.getState(), host, inspector).then(async () => {
      if (generation !== renderGeneration) return;
      completeAgentEntry();
      if (router.current() === "settings") {
        const { mountSettingsPage } = await import("../desktop/settings-page");
        if (generation !== renderGeneration || router.current() !== "settings") return;
        greetingSettings = mountSettingsPage(host, {
          voiceBridge: window.shensiCfoVoice,
          realtimeBridge: window.shensiCfoRealtime,
          workspaceId: document.body.dataset.sessionWorkspaceId
        });
      }
    });
  };
  let draggedOpportunityId = "";
  let resetInProgress = false;

  function sendConversationMessage(conversationId: string, body: string): void {
    const text = body.trim();
    if (!text) {
      showDemoToast("请输入演示消息");
      return;
    }
    const conversation = store.getState().conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const shouldReply = conversation.mode === "agent";
    store.sendMessage(conversationId, text);
    if (shouldReply) store.sendAgentReply(conversationId);
  }

  shell.addEventListener("click", (event) => {
    const xhsTarget = event.target as HTMLElement;
    if (router.current() === 'conversations' && xhsTarget.closest('[data-xhs-open], [data-xhs-back]')) {
      xhsSelected = Boolean(xhsTarget.closest('[data-xhs-open]'));
      render();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("#replicaNewTaskButton") && document.body.dataset.sessionMode === "real") {
      event.preventDefault();
      event.stopPropagation();
      const route = currentRoute();
      if(route==='#home'){router.navigate('acquisition');return;}
      if (route === "#decision-simulation") {
        shell.querySelector<HTMLInputElement>('.decision-simulation input[name="title"]')?.focus();
      } else if (route === "#enterprise-query") {
        shell.querySelector<HTMLInputElement>('.enterprise-query input[name="keyword"]')?.focus();
      } else if (route.split('?',1)[0] === '#knowledge') {
        knowledgeLibrary?.openUpload();
      } else if (route === "#private-domain") {
        document.dispatchEvent(new CustomEvent("goodjob:customer-create-requested"));
      } else if (route === "#agents") {
        openAgentEntry("question");
      } else if (route === "#conversations") {
        const state = realConversationsController.getState();
        const interaction = state.snapshot?.interactions.find(item => item.key === state.selectedInteractionKey)
          ?? state.snapshot?.interactions[0];
        if (interaction?.outreachEligible) {
          void realConversationsController.createOutreachForSelected();
        } else {
          const toast = document.querySelector<HTMLElement>("#replicaToast span");
          if (toast) toast.textContent = "请先选择具备公开证据、可准备私信的候选人。";
          document.querySelector<HTMLElement>("#replicaToast")?.classList.add("show");
        }
      } else if (route !== "#acquisition" && route !== "#growth/finance") {
        void openTodayTodos();
      }
      return;
    }
    if (target.closest("[data-settings-voice-configure]")) {
      event.preventDefault();
      if (document.body.dataset.sessionMode === "real") openAgentEntry("voice");
      else router.navigate("agents");
      return;
    }
    const realCustomerLink = target.closest<HTMLElement>(
      "[data-private-domain-customer-id]"
    );
    if (realCustomerLink?.dataset.privateDomainCustomerId) {
      event.preventDefault();
      requestedRealCustomerId = realCustomerLink.dataset.privateDomainCustomerId;
      shell.dataset.acquisitionMode = "real";
      document.dispatchEvent(new CustomEvent(
        "goodjob:acquisition-mode-changed",
        { detail: { mode: "real" } }
      ));
      router.navigate("private-domain");
      return;
    }
    const moduleButton = target.closest<HTMLButtonElement>("[data-demo-action=\"open-module\"]");
    const module = moduleButton?.dataset.demoModule;
    if (module && Object.prototype.hasOwnProperty.call(demoModuleMeta, module)) {
      const entityType = moduleButton?.dataset.demoEntityType;
      const entityId = moduleButton?.dataset.demoEntityId;
      if (entityType !== undefined || entityId !== undefined) {
        const state = store.getState();
        const validConversation = entityType === "conversation"
          && module === "conversations"
          && state.conversations.some((item) => item.id === entityId);
        const validCustomer = entityType === "customer"
          && module === "private-domain"
          && state.customers.some((item) => item.id === entityId);
        const validOpportunity = entityType === "opportunity"
          && module === "conversion"
          && state.opportunities.some((item) => item.id === entityId);
        if (!entityId || (!validConversation && !validCustomer && !validOpportunity)) return;
        if (validConversation) store.selectConversation(entityId);
        if (validCustomer) store.selectCustomer(entityId);
        if (validOpportunity) store.selectOpportunity(entityId);
      }
      router.navigate(module as DemoModule);
      return;
    }
    const nav = target.closest<HTMLButtonElement>("[data-replica-view]");
    if (nav?.dataset.replicaView) {
      router.navigate(nav.dataset.replicaView as DemoModule);
      return;
    }
    const actionTarget = target.closest<HTMLElement>("[data-demo-action]");
    const action = actionTarget?.dataset.demoAction;
    const conversationId = actionTarget?.dataset.conversationId;
    const opportunityId = actionTarget?.dataset.opportunityId;
    if (action === "open-connection-center") {
      const mode = actionTarget?.dataset.connectionMode;
      if (mode === "search" || mode === "model") {
        document.dispatchEvent(new CustomEvent("goodjob:connections-open-requested", {
          detail: { mode, returnTo: "settings" }
        }));
      }
      return;
    }
    if (action === "simulate-acquisition-sync") {
      if (router.current() !== "acquisition") return;
      if (shell.dataset.acquisitionMode === "real") {
        showDemoToast("真实模式不会执行演示同步；候选客户需先完成 AI 研判和人工审核");
        return;
      }
      const selectedTask = shell.querySelector<HTMLElement>(".replica-task-row.active");
      const platform = selectedTask?.dataset.taskProject;
      const conversation = store.getState().conversations.find((item) => item.platform === platform);
      if (!conversation) {
        showDemoToast("演示版暂未接入：当前项目没有对应会话");
        return;
      }
      const customerId = store.transferConversationToPrivate(conversation.id);
      if (!customerId) {
        showDemoToast("演示版暂未接入：当前项目无法模拟同步");
        return;
      }
      router.navigate("private-domain");
      showDemoToast("模拟同步完成，已打开私域客户");
      return;
    }
    if (action === "select-conversation" && conversationId) {
      store.selectConversation(conversationId);
      return;
    }
    if (action === "filter-conversations") {
      setConversationFilter(actionTarget?.dataset.conversationFilter ?? "all", actionTarget?.dataset.platform);
      render();
      return;
    }
    if (action === "quick-reply" && conversationId) {
      sendConversationMessage(conversationId, actionTarget?.dataset.reply ?? "");
      return;
    }
    if (action === "set-conversation-mode" && conversationId) {
      const mode = actionTarget?.dataset.mode;
      if (mode === "agent" || mode === "manual" || mode === "paused") {
        store.setConversationMode(conversationId, mode);
        showDemoToast(`已切换为${mode === "agent" ? "智能体跟进" : mode === "manual" ? "人工接管" : "已暂停"}`);
      }
      return;
    }
    if (action === "transfer-to-private" && conversationId) {
      const customerId = store.transferConversationToPrivate(conversationId);
      if (customerId) showDemoToast("演示：客户已转入私域");
      return;
    }
    if (action === "open-private-customer") {
      const customerId = actionTarget?.dataset.customerId;
      if (customerId) {
        store.selectCustomer(customerId);
        router.navigate("private-domain");
      }
      return;
    }
    if (action === "filter-customers" && actionTarget instanceof HTMLButtonElement) {
      setPrivateDomainFilter({ group: actionTarget.dataset.customerGroup });
      render();
      return;
    }
    if (action === "toggle-customer-batch" && actionTarget instanceof HTMLInputElement) {
      const customerId = actionTarget.dataset.customerId;
      if (customerId) {
        toggleCustomerBatchSelection(customerId, actionTarget.checked);
        render();
      }
      return;
    }
    if (action === "select-customer") {
      const customerId = actionTarget?.dataset.customerId;
      if (customerId) store.selectCustomer(customerId);
      return;
    }
    if (action === "simulate-outreach") {
      const customerIds = selectedCustomerBatchIds();
      if (!customerIds.length) return;
      store.simulateOutreach(customerIds);
      clearCustomerBatchSelection();
      showDemoToast("演示：已模拟触达");
      return;
    }
    if (action === "open-opportunity-form") {
      const customerId = actionTarget?.dataset.customerId;
      if (customerId) {
        openOpportunityForm(customerId);
        render();
      }
      return;
    }
    if (action === "select-opportunity" && opportunityId) {
      store.selectOpportunity(opportunityId);
      return;
    }
    if (action === "move-opportunity" && opportunityId && isOpportunityStage(actionTarget?.dataset.opportunityStage)) {
      const stage = actionTarget.dataset.opportunityStage;
      if (stage === "won") {
        showDemoToast("请使用“标记模拟成交”关闭商机");
        return;
      }
      if (stage === "lost") {
        store.selectOpportunity(opportunityId);
        showDemoToast("请在右侧选择流失原因");
        return;
      }
      store.moveOpportunity(opportunityId, stage);
      showDemoToast("已移动演示商机阶段");
      return;
    }
    if (action === "mark-quote-sent" && opportunityId) {
      store.markQuoteSent(opportunityId);
      showDemoToast("演示：报价已标记发送");
      return;
    }
    if (action === "close-won" && opportunityId) {
      store.closeOpportunity(opportunityId, "won");
      showDemoToast("演示：商机已标记成交");
      return;
    }
    if (action === "toggle-agent") {
      const name = actionTarget?.dataset.agentName;
      if (name === "获客识别智能体" || name === "社媒沟通智能体" || name === "客户跟进智能体") {
        store.toggleAgent(name);
        showDemoToast("演示：状态已切换");
      }
      return;
    }
    if (action === "toggle-script") {
      const platform = actionTarget?.dataset.scriptPlatform;
      if (platform === "抖音" || platform === "小红书" || platform === "快手" || platform === "微信" || platform === "微博") {
        store.toggleScript(platform);
        showDemoToast("演示：状态已切换");
      }
      return;
    }
    if (action === "open-reset-dialog") {
      const dialog = host.querySelector<HTMLDialogElement>("#demoResetDialog");
      if (dialog && !dialog.open) dialog.showModal();
      return;
    }
    if (action === "cancel-reset") {
      actionTarget?.closest<HTMLDialogElement>("dialog")?.close();
      return;
    }
    if (action === "confirm-reset") {
      const dialog = actionTarget?.closest<HTMLDialogElement>("dialog");
      if (!dialog?.open || resetInProgress) return;
      resetInProgress = true;
      shell.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((openDialog) => openDialog.close());
      shell.querySelectorAll<HTMLFormElement>("form").forEach((form) => form.reset());
      resetConversationViewState();
      resetPrivateDomainViewState();
      draggedOpportunityId = "";
      document.dispatchEvent(new Event("goodjob:demo-reset"));
      store.reset();
      router.navigate("agents");
      showDemoToast("演示：已恢复初始数据");
      resetInProgress = false;
      return;
    }
    if (target.closest("#replicaNewTaskButton") && router.current() !== "acquisition") {
      event.preventDefault();
      event.stopPropagation();
      if (router.current() === "enterprise-query") {
        shell.querySelector<HTMLInputElement>('.enterprise-query input[name="keyword"]')?.focus();
        return;
      }
      if(router.current()==='decision-simulation') {shell.querySelector<HTMLInputElement>('.decision-simulation input[name="title"]')?.focus();return;}
      showDemoToast(`${demoModuleMeta[router.current()].primaryAction}已模拟完成`);
    }
  });
  shell.addEventListener("dragstart", (event) => {
    if (router.current() !== "conversion") return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-demo-action="select-opportunity"][draggable="true"]');
    const opportunityId = card?.dataset.opportunityId;
    if (!opportunityId) return;
    draggedOpportunityId = opportunityId;
    event.dataTransfer?.setData("text/plain", opportunityId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  shell.addEventListener("dragover", (event) => {
    if (router.current() !== "conversion" || !(event.target as HTMLElement).closest("[data-opportunity-stage]")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  shell.addEventListener("drop", (event) => {
    if (router.current() !== "conversion") return;
    const lane = (event.target as HTMLElement).closest<HTMLElement>("[data-opportunity-stage]");
    const stage = lane?.dataset.opportunityStage;
    const opportunityId = event.dataTransfer?.getData("text/plain") || draggedOpportunityId;
    draggedOpportunityId = "";
    if (!opportunityId || !isOpportunityStage(stage)) return;
    event.preventDefault();
    if (stage === "won") {
      store.closeOpportunity(opportunityId, "won");
      showDemoToast("演示：商机已按成交语义关闭");
      return;
    }
    if (stage === "lost") {
      store.selectOpportunity(opportunityId);
      showDemoToast("请在右侧选择流失原因");
      return;
    }
    store.moveOpportunity(opportunityId, stage);
    showDemoToast("已拖动更新演示阶段");
  });
  shell.addEventListener("submit", (event) => {
    if (router.current() === "acquisition" || router.current() === "enterprise-query" || router.current() === "decision-simulation") return;
    const form = event.target as HTMLFormElement;
    const action = form.dataset.demoAction;
    // Real modules own their submissions; only explicitly marked demo forms belong here.
    if (!action || event.defaultPrevented) return;
    const conversationId = form.dataset.conversationId;
    if (action === "send-message" && conversationId) {
      event.preventDefault();
      const message = form.querySelector<HTMLTextAreaElement>('textarea[name="demo-message"]')?.value ?? "";
      sendConversationMessage(conversationId, message);
      return;
    }
    if (action === "add-conversation-tag" && conversationId) {
      event.preventDefault();
      const tag = form.querySelector<HTMLInputElement>('input[name="demo-tag"]')?.value ?? "";
      if (!tag.trim()) {
        showDemoToast("请输入演示标签");
        return;
      }
      store.addConversationTag(conversationId, tag);
      showDemoToast("已添加演示标签");
      return;
    }
    const customerId = form.dataset.customerId;
    const opportunityId = form.dataset.opportunityId;
    if (action === "filter-customers") {
      event.preventDefault();
      setPrivateDomainFilter({
        search: form.querySelector<HTMLInputElement>('input[name="customer-search"]')?.value,
        intent: form.querySelector<HTMLSelectElement>('select[name="customer-intent"]')?.value,
        platform: form.querySelector<HTMLSelectElement>('select[name="customer-platform"]')?.value
      });
      render();
      return;
    }
    if (action === "add-customer-tag" && customerId) {
      event.preventDefault();
      const tag = form.querySelector<HTMLInputElement>('input[name="customer-tag"]')?.value ?? "";
      if (!tag.trim()) {
        showDemoToast("请输入演示标签");
        return;
      }
      store.addCustomerTag(customerId, tag);
      showDemoToast("已添加客户标签");
      return;
    }
    if (action === "change-customer-group" && customerId) {
      event.preventDefault();
      const group = form.querySelector<HTMLSelectElement>('select[name="customer-group"]')?.value;
      if (group === "重点客户" || group === "待跟进" || group === "沉默客户" || group === "已创建商机") {
        store.updateCustomer(customerId, { group });
        showDemoToast("已更新客户分组");
      }
      return;
    }
    if (action === "create-follow-up" && customerId) {
      event.preventDefault();
      const note = form.querySelector<HTMLInputElement>('input[name="follow-up-note"]')?.value ?? "";
      const dueValue = form.querySelector<HTMLInputElement>('input[name="follow-up-at"]')?.value ?? "";
      const dueAt = parseFollowUpAt(dueValue);
      if (!note.trim() || !dueAt) {
        showDemoToast("请补全跟进内容和时间");
        return;
      }
      store.createFollowUp(customerId, note, dueAt);
      showDemoToast("已创建跟进计划");
      return;
    }
    if (action === "create-opportunity" && customerId) {
      event.preventDefault();
      const title = form.querySelector<HTMLInputElement>('input[name="opportunity-title"]')?.value ?? "";
      const amount = Number(form.querySelector<HTMLInputElement>('input[name="opportunity-amount"]')?.value);
      if (!title.trim() || !Number.isFinite(amount) || amount <= 0) {
        showDemoToast("请填写商机名称和有效金额");
        return;
      }
      const opportunityId = store.createOpportunity(customerId, { title, amount });
      if (!opportunityId) return;
      closeOpportunityForm();
      router.navigate("conversion");
      showDemoToast("已创建演示商机");
      return;
    }
    if (action === "create-quote" && opportunityId) {
      event.preventDefault();
      const amount = Number(form.querySelector<HTMLInputElement>('input[name="quote-amount"]')?.value);
      if (!Number.isFinite(amount) || amount < 1) {
        showDemoToast("报价金额需大于 0");
        return;
      }
      store.createQuote(opportunityId, amount);
      showDemoToast("已创建演示报价");
      return;
    }
    if (action === "update-opportunity" && opportunityId) {
      event.preventDefault();
      const amount = Number(form.querySelector<HTMLInputElement>('input[name="opportunity-amount"]')?.value);
      const probability = Number(form.querySelector<HTMLInputElement>('input[name="opportunity-probability"]')?.value);
      const nextAction = form.querySelector<HTMLInputElement>('input[name="opportunity-next-action"]')?.value.trim() ?? "";
      if (!Number.isFinite(amount) || amount < 1 || !Number.isFinite(probability) || probability < 0 || probability > 100 || !nextAction) {
        showDemoToast("请填写有效金额、0–100 的概率和下一步行动");
        return;
      }
      store.updateOpportunity(opportunityId, { amount, probability, nextAction });
      showDemoToast("已更新演示商机");
      return;
    }
    if (action === "close-lost" && opportunityId) {
      event.preventDefault();
      const reason = form.querySelector<HTMLSelectElement>('select[name="loss-reason"]')?.value;
      if (!reason || !lossReasons.includes(reason as typeof lossReasons[number])) {
        showDemoToast("请选择有效的流失原因");
        return;
      }
      store.closeOpportunity(opportunityId, "lost", reason);
      showDemoToast("演示：商机已标记流失");
      return;
    }
    event.preventDefault();
    showDemoToast("表单提交已模拟完成");
  });

  store.subscribe(render);
  router.subscribe(render);
  window.addEventListener("hashchange", render);
  document.addEventListener("goodjob:acquisition-mode-changed", () => {
    if (parseGrowthHash(window.location.hash)) return;
    router.navigate(router.current());
  });
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    knowledgeLibrary?.dispose();
    knowledgeLibrary = null;
    knowledgeScope = null;
    void import("../growth/agents/cfo-session-view").then(({ clearRetainedCfoConversation }) => clearRetainedCfoConversation(document));
    pendingAgentEntry = null;
    pendingTodos += 1;
    if (realDashboardActive) realDashboardController.deactivate();
    realDashboardActive = false;
    if (realConversationsActive) realConversationsController.deactivate();
    realConversationsActive = false;
    agentsDemoController?.dispose();
    agentsDemoController = null;
    agentsAuthority = null;
    host.replaceChildren();
    inspector.replaceChildren();
    const authenticated = (event as CustomEvent<{ authenticated?: boolean }>).detail
      ?.authenticated === true;
    if (authenticated) {
      store.switchScope(currentDemoStorageScope());
      render();
    }
  });
  render();
}

if (typeof document !== "undefined") startDemoApp();
