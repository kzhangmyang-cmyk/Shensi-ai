import { createDemoRouter, demoModuleMeta } from "./demo-router";
import { renderConversationsView, resetConversationViewState, setConversationFilter } from "./demo-conversations-view";
import { renderDashboardView, resetDashboardViewState } from "./demo-dashboard-view";
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
import { createDemoStore } from "./demo-store";
import type { DemoModule, DemoState } from "./demo-types";
import { showDemoToast } from "./demo-ui";
import { createPrivateDomainController } from "../private-domain/controller";
import { startGrowthWhenRequested } from "../growth/entry";
import { createAgentsController } from "../growth/agents/controller";

let agentsDemoController: ReturnType<typeof createAgentsController> | null = null;

function renderModule(module: DemoModule, state: DemoState, host: HTMLElement, inspector: HTMLElement): void {
  if (module === "agents") {
    agentsDemoController ??= createAgentsController({
      host,
      demo: true
    });
    agentsDemoController.render();
    return;
  }
  if (module === "dashboard") {
    renderDashboardView(state, host, inspector);
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

export function startDemoApp(): void {
  const shell = document.querySelector<HTMLElement>(".replica-shell");
  const host = document.querySelector<HTMLElement>("#demoModuleMain");
  const inspector = document.querySelector<HTMLElement>("#demoModuleInspector");
  if (!shell || !host || !inspector || shell.dataset.demoAppStarted === "true") return;
  shell.dataset.demoAppStarted = "true";

  const store = createDemoStore();
  const router = createDemoRouter();
  startGrowthWhenRequested();
  const privateDomainController = createPrivateDomainController({
    main: host,
    inspector
  });
  let realPrivateDomainActive = false;
  let requestedRealCustomerId = "";
  const render = () => {
    if (router.current() === "private-domain"
      && shell.dataset.acquisitionMode !== "demo") {
      if (!realPrivateDomainActive || requestedRealCustomerId) {
        realPrivateDomainActive = true;
        const preferred = requestedRealCustomerId || undefined;
        requestedRealCustomerId = "";
        void privateDomainController.open(preferred).catch(() => undefined);
      }
      return;
    }
    if (realPrivateDomainActive) privateDomainController.deactivate();
    realPrivateDomainActive = false;
    agentsDemoController?.dispose();
    agentsDemoController = null;
    renderModule(router.current(), store.getState(), host, inspector);
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
    const target = event.target as HTMLElement;
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
      resetDashboardViewState();
      resetConversationViewState();
      resetPrivateDomainViewState();
      draggedOpportunityId = "";
      document.dispatchEvent(new Event("goodjob:demo-reset"));
      store.reset();
      router.navigate("dashboard");
      showDemoToast("演示：已恢复初始数据");
      resetInProgress = false;
      return;
    }
    if (target.closest("#replicaNewTaskButton") && router.current() !== "acquisition") {
      event.preventDefault();
      event.stopPropagation();
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
    if (router.current() === "acquisition") return;
    const form = event.target as HTMLFormElement;
    const action = form.dataset.demoAction;
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
  document.addEventListener("goodjob:acquisition-mode-changed", () => {
    router.navigate(router.current());
  });
  render();
}

if (typeof document !== "undefined") startDemoApp();
