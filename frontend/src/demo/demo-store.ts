import { createSeedDemoState } from "./demo-seed";
import type {
  ConversationMode,
  DemoActivity,
  DemoCustomer,
  DemoState,
  OpportunityStage
} from "./demo-types";

const STORAGE_KEY = "goodjob.frontend-demo.v1";
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const LOSS_REASONS = ["预算延期", "需求取消", "选择其他供应商", "无法联系"] as const;
const PLATFORMS = ["抖音", "小红书", "快手", "微信", "微博"] as const;
const INTENT_LEVELS = ["高", "中", "低"] as const;
const CONVERSATION_MODES = ["agent", "manual", "paused"] as const;
const MESSAGE_SENDERS = ["customer", "agent", "operator"] as const;
const CUSTOMER_GROUPS = ["重点客户", "待跟进", "沉默客户", "已创建商机"] as const;
const CUSTOMER_STATUSES = ["跟进中", "待跟进", "已沉默", "已有商机"] as const;
const OPPORTUNITY_STAGES = ["new", "qualified", "quoted", "negotiating", "won", "lost"] as const;
const ACTIVE_OPPORTUNITY_STAGES = ["new", "qualified", "quoted", "negotiating"] as const;
const ACTIVITY_KINDS = ["message", "transfer", "follow-up", "opportunity", "quote", "stage"] as const;
const TASK_PRIORITIES = ["高", "中", "低"] as const;
const DEMO_MODULES = ["dashboard", "acquisition", "conversations", "private-domain", "conversion", "agents", "scripts", "trade-marketing", "settings"] as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DemoStoreOptions {
  storage?: StorageLike | null;
  now?: () => string;
}

export interface DemoStore {
  getState(): DemoState;
  subscribe(listener: (state: DemoState) => void): () => void;
  selectConversation(id: string): void;
  selectCustomer(id: string): void;
  selectOpportunity(id: string): void;
  sendMessage(conversationId: string, body: string): void;
  sendAgentReply(conversationId: string): void;
  setConversationMode(conversationId: string, mode: ConversationMode): void;
  addConversationTag(conversationId: string, tag: string): void;
  addCustomerTag(customerId: string, tag: string): void;
  transferConversationToPrivate(conversationId: string): string;
  updateCustomer(customerId: string, patch: Partial<Pick<DemoState["customers"][number], "group" | "status" | "nextFollowUpAt">>): void;
  createFollowUp(customerId: string, note: string, dueAt: string): void;
  simulateOutreach(customerIds: string[]): void;
  createOpportunity(customerId: string, input: { title: string; amount: number }): string;
  moveOpportunity(opportunityId: string, stage: OpportunityStage): void;
  createQuote(opportunityId: string, amount: number): void;
  markQuoteSent(opportunityId: string): void;
  updateOpportunity(opportunityId: string, patch: Partial<Pick<DemoState["opportunities"][number], "amount" | "probability" | "nextAction">>): void;
  closeOpportunity(opportunityId: string, result: "won" | "lost", reason?: string): void;
  toggleAgent(name: keyof DemoState["demoSettings"]["agents"]): void;
  toggleScript(platform: keyof DemoState["demoSettings"]["scripts"]): void;
  reset(): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isValidStateShape(value: unknown): value is DemoState {
  if (!isRecord(value) || value.version !== 1) return false;
  return isNonEmptyString(value.selectedConversationId)
    && isNonEmptyString(value.selectedCustomerId)
    && isNonEmptyString(value.selectedOpportunityId)
    && Array.isArray(value.conversations)
    && value.conversations.every(isConversation)
    && Array.isArray(value.customers)
    && value.customers.every(isCustomer)
    && Array.isArray(value.opportunities)
    && value.opportunities.every(isOpportunity)
    && Array.isArray(value.activities)
    && value.activities.every(isActivity)
    && Array.isArray(value.tasks)
    && value.tasks.every(isTask)
    && isSettings(value.demoSettings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowed<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function isFiniteInRange(value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && normalizeIsoDateTime(value) !== null;
}

function isConversation(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.customerId === undefined || isNonEmptyString(value.customerId))
    && typeof value.customerName === "string"
    && isAllowed(value.platform, PLATFORMS)
    && isAllowed(value.intent, INTENT_LEVELS)
    && Number.isInteger(value.unread)
    && isFiniteInRange(value.unread, 0)
    && isAllowed(value.mode, CONVERSATION_MODES)
    && typeof value.needSummary === "string"
    && typeof value.risk === "string"
    && isStringArray(value.tags)
    && Array.isArray(value.messages)
    && value.messages.every(isMessage)
    && isIsoDateTime(value.updatedAt);
}

function isMessage(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isAllowed(value.sender, MESSAGE_SENDERS)
    && typeof value.body === "string"
    && isIsoDateTime(value.sentAt)
    && value.simulated === true;
}

function isCustomer(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.conversationId)
    && typeof value.name === "string"
    && isAllowed(value.platform, PLATFORMS)
    && isAllowed(value.intent, INTENT_LEVELS)
    && isAllowed(value.group, CUSTOMER_GROUPS)
    && isStringArray(value.tags)
    && typeof value.owner === "string"
    && typeof value.needSummary === "string"
    && isIsoDateTime(value.lastContactAt)
    && isIsoDateTime(value.nextFollowUpAt)
    && isAllowed(value.status, CUSTOMER_STATUSES);
}

function isOpportunity(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.customerId)
    || typeof value.title !== "string"
    || !isFiniteInRange(value.amount, 1)
    || !isFiniteInRange(value.probability, 0, 100)
    || !isAllowed(value.stage, OPPORTUNITY_STAGES)
    || !isAllowed(value.source, PLATFORMS)
    || typeof value.nextAction !== "string"
    || (value.quoteAmount !== undefined && !isFiniteInRange(value.quoteAmount, 1))
    || (value.quoteSentAt !== undefined && !isIsoDateTime(value.quoteSentAt))
    || (value.lossReason !== undefined && !isAllowed(value.lossReason, LOSS_REASONS))
    || !isIsoDateTime(value.updatedAt)) {
    return false;
  }
  if (value.quoteSentAt !== undefined && value.quoteAmount === undefined) return false;
  if (value.stage === "won") return value.probability === 100 && value.lossReason === undefined;
  if (value.stage === "lost") return value.probability === 0 && isAllowed(value.lossReason, LOSS_REASONS);
  return value.lossReason === undefined;
}

function isActivity(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isAllowed(value.kind, ACTIVITY_KINDS)
    && typeof value.title === "string"
    && typeof value.detail === "string"
    && isIsoDateTime(value.createdAt);
}

function isTask(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && typeof value.title === "string"
    && isAllowed(value.priority, TASK_PRIORITIES)
    && isAllowed(value.module, DEMO_MODULES)
    && isNonEmptyString(value.relatedId)
    && typeof value.done === "boolean"
    && (value.dueAt === undefined || isIsoDateTime(value.dueAt))
    && (value.createdAt === undefined || isIsoDateTime(value.createdAt));
}

function isSettings(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { agents: agentSettings, scripts: scriptSettings } = value;
  if (!isRecord(agentSettings) || !isRecord(scriptSettings)) return false;
  const agentNames = ["获客识别智能体", "社媒沟通智能体", "客户跟进智能体"] as const;
  return agentNames.every((name) => typeof agentSettings[name] === "boolean")
    && PLATFORMS.every((platform) => typeof scriptSettings[platform] === "boolean");
}

function hasUniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function normalizeStateRelationships(value: DemoState): DemoState | null {
  if (!hasUniqueIds(value.conversations)
    || !hasUniqueIds(value.customers)
    || !hasUniqueIds(value.opportunities)
    || !hasUniqueIds(value.activities)
    || !hasUniqueIds(value.tasks)) {
    return null;
  }
  const conversationsById = new Map(value.conversations.map((item) => [item.id, item]));
  const customersById = new Map(value.customers.map((item) => [item.id, item]));
  const customersByConversationId = new Map<string, DemoCustomer>();
  for (const customer of value.customers) {
    const conversation = conversationsById.get(customer.conversationId);
    if (!conversation || conversation.platform !== customer.platform || customersByConversationId.has(customer.conversationId)) return null;
    customersByConversationId.set(customer.conversationId, customer);
  }

  const conversations = value.conversations.map((conversation) => {
    const reverseCustomer = customersByConversationId.get(conversation.id);
    if (conversation.customerId) {
      const forwardCustomer = customersById.get(conversation.customerId);
      if (!forwardCustomer || forwardCustomer.conversationId !== conversation.id || (reverseCustomer && reverseCustomer.id !== forwardCustomer.id)) {
        return null;
      }
      return conversation;
    }
    return reverseCustomer ? { ...conversation, customerId: reverseCustomer.id } : conversation;
  });
  if (conversations.some((item) => item === null)) return null;
  const normalizedConversations = conversations as DemoState["conversations"];
  const normalizedConversationsById = new Map(normalizedConversations.map((item) => [item.id, item]));

  if (!normalizedConversationsById.has(value.selectedConversationId)
    || !customersById.has(value.selectedCustomerId)
    || !value.opportunities.some((item) => item.id === value.selectedOpportunityId)) {
    return null;
  }
  for (const customer of value.customers) {
    if (normalizedConversationsById.get(customer.conversationId)?.customerId !== customer.id) return null;
  }
  const opportunitiesById = new Map(value.opportunities.map((item) => [item.id, item]));
  for (const opportunity of value.opportunities) {
    const customer = customersById.get(opportunity.customerId);
    if (!customer || customer.platform !== opportunity.source) return null;
  }
  for (const task of value.tasks) {
    if (task.module === "conversations" && !normalizedConversationsById.has(task.relatedId)) return null;
    if (task.module === "private-domain" && !customersById.has(task.relatedId)) return null;
    if (task.module === "conversion" && !opportunitiesById.has(task.relatedId)) return null;
  }
  return { ...value, conversations: normalizedConversations };
}

function parseValidState(value: unknown): DemoState | null {
  if (!isValidStateShape(value)) return null;
  return normalizeStateRelationships(value);
}

export function normalizeIsoDateTime(value: string): string | null {
  const candidate = value.trim();
  const match = ISO_DATE_TIME_PATTERN.exec(candidate);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;

  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function createDemoStore(options: DemoStoreOptions = {}): DemoStore {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(state: DemoState) => void>();
  let state = loadInitialState(storage);

  function loadInitialState(candidateStorage: StorageLike | null): DemoState {
    if (!candidateStorage) return createSeedDemoState();
    try {
      const raw = candidateStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        const normalized = parseValidState(parsed);
        if (normalized) {
          candidateStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
          return normalized;
        }
      }
    } catch {
      // Invalid or unavailable browser storage falls back to the deterministic demo.
    }
    const seed = createSeedDemoState();
    try {
      candidateStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    } catch {
      // Keep the in-memory demo state when storage cannot be written.
    }
    return seed;
  }

  function save(nextState: DemoState): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // A full or unavailable localStorage must not break the demo interaction.
    }
  }

  function activity(nextState: DemoState, kind: DemoActivity["kind"], title: string, detail: string): DemoState {
    return {
      ...nextState,
      activities: [...nextState.activities, {
        id: `activity-${nextState.activities.length + 1}`,
        kind,
        title,
        detail,
        createdAt: now()
      }]
    };
  }

  function commit(update: (current: DemoState) => DemoState | null): void {
    const nextState = update(state);
    if (!nextState) return;
    state = nextState;
    save(state);
    listeners.forEach((listener) => listener(state));
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectConversation(id) {
      commit((current) => {
        const conversation = current.conversations.find((item) => item.id === id);
        if (!conversation) return null;
        const selectionChanged = current.selectedConversationId !== id;
        const unreadChanged = conversation.unread !== 0;
        if (!selectionChanged && !unreadChanged) return null;
        const next = {
          ...current,
          selectedConversationId: id,
          conversations: current.conversations.map((item) => item.id === id ? { ...item, unread: 0 } : item)
        };
        return activity(next, "message", "查看社媒对话", `已打开${conversation.customerName}的${conversation.platform}会话。`);
      });
    },
    selectCustomer(id) {
      commit((current) => {
        const customer = current.customers.find((item) => item.id === id);
        if (!customer || current.selectedCustomerId === id) return null;
        return activity({ ...current, selectedCustomerId: id }, "follow-up", "查看私域客户", `已打开${customer.name}的客户档案。`);
      });
    },
    selectOpportunity(id) {
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === id);
        if (!opportunity || current.selectedOpportunityId === id) return null;
        return activity({ ...current, selectedOpportunityId: id }, "stage", "查看成交商机", `已打开${opportunity.title}商机。`);
      });
    },
    sendMessage(conversationId, body) {
      const text = body.trim();
      if (!text) return;
      commit((current) => {
        const conversation = current.conversations.find((item) => item.id === conversationId);
        if (!conversation) return null;
        const sentAt = now();
        const message = { id: `message-${current.conversations.reduce((count, item) => count + item.messages.length, 0) + 1}`, sender: "operator" as const, body: text, sentAt, simulated: true as const };
        const next = {
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, unread: 0, messages: [...item.messages, message], updatedAt: sentAt } : item)
        };
        return activity(next, "message", "发送社媒消息", `已向${conversation.customerName}发送消息：${text}`);
      });
    },
    sendAgentReply(conversationId) {
      commit((current) => {
        const conversation = current.conversations.find((item) => item.id === conversationId);
        if (!conversation || conversation.mode !== "agent") return null;
        const sentAt = now();
        const message = {
          id: `message-${current.conversations.reduce((count, item) => count + item.messages.length, 0) + 1}`,
          sender: "agent" as const,
          body: "已收到您的问题，我先为您整理适合的演示方案，稍后继续为您说明。",
          sentAt,
          simulated: true as const
        };
        const next = {
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId
            ? { ...item, messages: [...item.messages, message], updatedAt: sentAt }
            : item)
        };
        return activity(next, "message", "智能体回复社媒消息", `已向${conversation.customerName}发送演示自动回复。`);
      });
    },
    setConversationMode(conversationId, mode) {
      if (!isAllowed(mode, CONVERSATION_MODES)) return;
      commit((current) => {
        const conversation = current.conversations.find((item) => item.id === conversationId);
        if (!conversation || conversation.mode === mode) return null;
        const next = {
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, mode, updatedAt: now() } : item)
        };
        return activity(next, "stage", "更新对话模式", `${conversation.customerName}的会话已切换为${mode}。`);
      });
    },
    addConversationTag(conversationId, tag) {
      const text = tag.trim();
      if (!text) return;
      commit((current) => {
        const conversation = current.conversations.find((item) => item.id === conversationId);
        if (!conversation || conversation.tags.includes(text)) return null;
        const next = {
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, tags: [...item.tags, text], updatedAt: now() } : item)
        };
        return activity(next, "message", "添加对话标签", `已为${conversation.customerName}添加“${text}”。`);
      });
    },
    addCustomerTag(customerId, tag) {
      const text = tag.trim();
      if (!text) return;
      commit((current) => {
        const customer = current.customers.find((item) => item.id === customerId);
        if (!customer || customer.tags.includes(text)) return null;
        const next = { ...current, customers: current.customers.map((item) => item.id === customerId ? { ...item, tags: [...item.tags, text] } : item) };
        return activity(next, "follow-up", "添加客户标签", `已为${customer.name}添加“${text}”。`);
      });
    },
    transferConversationToPrivate(conversationId) {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation) return "";
      const existingCustomer = (conversation.customerId
        ? state.customers.find((item) => item.id === conversation.customerId && item.conversationId === conversationId)
        : undefined) ?? state.customers.find((item) => item.conversationId === conversationId);
      if (existingCustomer) {
        commit((current) => {
          const currentConversation = current.conversations.find((item) => item.id === conversationId);
          const currentCustomer = current.customers.find((item) => item.id === existingCustomer.id && item.conversationId === conversationId);
          if (!currentConversation || !currentCustomer) return null;
          const needsConversationLink = currentConversation.customerId !== currentCustomer.id;
          const needsSelection = current.selectedCustomerId !== currentCustomer.id;
          if (!needsConversationLink && !needsSelection) return null;
          return {
            ...current,
            selectedCustomerId: currentCustomer.id,
            conversations: needsConversationLink
              ? current.conversations.map((item) => item.id === conversationId ? { ...item, customerId: currentCustomer.id } : item)
              : current.conversations
          };
        });
        return existingCustomer.id;
      }
      const customerId = `customer-${conversationId.replace(/^conversation-/, "")}`;
      commit((current) => {
        const currentConversation = current.conversations.find((item) => item.id === conversationId);
        if (!currentConversation) return null;
        if (currentConversation.customerId) return null;
        const createdAt = now();
        const customer: DemoCustomer = {
          id: customerId,
          conversationId,
          name: currentConversation.customerName,
          platform: currentConversation.platform,
          intent: currentConversation.intent,
          group: "待跟进",
          tags: [...currentConversation.tags],
          owner: "待分配",
          needSummary: currentConversation.needSummary,
          lastContactAt: createdAt,
          nextFollowUpAt: createdAt,
          status: "待跟进"
        };
        const next = {
          ...current,
          selectedCustomerId: customerId,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, customerId } : item),
          customers: [...current.customers, customer]
        };
        return activity(next, "transfer", "转入私域客户", `${customer.name}已从${customer.platform}会话转入私域。`);
      });
      return customerId;
    },
    updateCustomer(customerId, patch) {
      if (patch.group !== undefined && !isAllowed(patch.group, CUSTOMER_GROUPS)) return;
      if (patch.status !== undefined && !isAllowed(patch.status, CUSTOMER_STATUSES)) return;
      if (patch.nextFollowUpAt !== undefined && !isIsoDateTime(patch.nextFollowUpAt)) return;
      commit((current) => {
        const customer = current.customers.find((item) => item.id === customerId);
        if (!customer || Object.keys(patch).length === 0) return null;
        const next = { ...current, customers: current.customers.map((item) => item.id === customerId ? { ...item, ...patch } : item) };
        return activity(next, "follow-up", "更新客户信息", `已更新${customer.name}的跟进信息。`);
      });
    },
    createFollowUp(customerId, note, dueAt) {
      const text = note.trim();
      const normalizedDueAt = normalizeIsoDateTime(dueAt);
      if (!text || !normalizedDueAt) return;
      commit((current) => {
        const customer = current.customers.find((item) => item.id === customerId);
        if (!customer) return null;
        const createdAt = now();
        const task = { id: `task-follow-up-${current.tasks.length + 1}`, title: text, priority: "中" as const, module: "private-domain" as const, relatedId: customerId, done: false, dueAt: normalizedDueAt, createdAt };
        const next = {
          ...current,
          customers: current.customers.map((item) => item.id === customerId ? { ...item, nextFollowUpAt: normalizedDueAt } : item),
          tasks: [...current.tasks, task]
        };
        return activity(next, "follow-up", "创建跟进", `${customer.name}：${text}`);
      });
    },
    simulateOutreach(customerIds) {
      const ids = new Set(customerIds);
      const targets = state.customers.filter((customer) => ids.has(customer.id));
      if (targets.length === 0) return;
      commit((current) => {
        const sentAt = now();
        const targetIds = new Set(current.customers.filter((customer) => ids.has(customer.id)).map((customer) => customer.id));
        if (targetIds.size === 0) return null;
        let messageNumber = current.conversations.reduce((count, item) => count + item.messages.length, 0);
        const conversations = current.conversations.map((conversation) => {
          const matchingCustomer = current.customers.find((customer) => targetIds.has(customer.id)
            && (conversation.customerId === customer.id || conversation.id === customer.conversationId));
          if (!matchingCustomer) return conversation;
          messageNumber += 1;
          const message = { id: `message-${messageNumber}`, sender: "agent" as const, body: "您好，想了解一下您目前的项目进展，方便继续为您提供方案支持吗？", sentAt, simulated: true as const };
          return { ...conversation, messages: [...conversation.messages, message], updatedAt: sentAt };
        });
        const next = {
          ...current,
          conversations,
          customers: current.customers.map((customer) => targetIds.has(customer.id)
            ? { ...customer, group: "待跟进" as const, status: "待跟进" as const, lastContactAt: sentAt }
            : customer)
        };
        return activity(next, "message", "执行批量触达", `已向${targetIds.size}位私域客户发送模拟触达。`);
      });
    },
    createOpportunity(customerId, input) {
      const title = input.title.trim();
      if (!title || !isFiniteInRange(input.amount, 1)) return "";
      const customer = state.customers.find((item) => item.id === customerId);
      if (!customer) return "";
      const opportunityId = `opportunity-${currentIdPart(customerId)}-${state.opportunities.length + 1}`;
      commit((current) => {
        const currentCustomer = current.customers.find((item) => item.id === customerId);
        if (!currentCustomer) return null;
        const createdAt = now();
        const opportunity = {
          id: opportunityId, customerId, title, amount: input.amount, probability: 30, stage: "new" as const,
          source: currentCustomer.platform, nextAction: "确认需求与预算", updatedAt: createdAt
        };
        const next: DemoState = {
          ...current,
          selectedOpportunityId: opportunityId,
          customers: current.customers.map((item) => item.id === customerId ? { ...item, group: "已创建商机" as const, status: "已有商机" as const } : item),
          opportunities: [...current.opportunities, opportunity]
        };
        return activity(next, "opportunity", "创建商机", `已为${currentCustomer.name}创建${title}商机。`);
      });
      return opportunityId;
    },
    moveOpportunity(opportunityId, stage) {
      if (!isAllowed(stage, ACTIVE_OPPORTUNITY_STAGES)) return;
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity || opportunity.stage === stage || opportunity.stage === "won" || opportunity.stage === "lost") return null;
        const next = { ...current, opportunities: current.opportunities.map((item) => item.id === opportunityId ? { ...item, stage, updatedAt: now() } : item) };
        return activity(next, "stage", "移动商机阶段", `${opportunity.title}已进入${stage}阶段。`);
      });
    },
    createQuote(opportunityId, amount) {
      if (!Number.isFinite(amount) || amount < 1) return;
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity) return null;
        const stage = opportunity.stage === "new" || opportunity.stage === "qualified" ? "quoted" as const : opportunity.stage;
        const next: DemoState = { ...current, opportunities: current.opportunities.map((item) => item.id === opportunityId ? { ...item, quoteAmount: amount, stage, updatedAt: now() } : item) };
        return activity(next, "quote", "创建报价", `已为${opportunity.title}创建¥${amount}报价。`);
      });
    },
    markQuoteSent(opportunityId) {
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity) return null;
        const sentAt = now();
        const next = { ...current, opportunities: current.opportunities.map((item) => item.id === opportunityId ? { ...item, quoteSentAt: sentAt, updatedAt: sentAt } : item) };
        return activity(next, "quote", "发送报价", `${opportunity.title}报价已发送。`);
      });
    },
    updateOpportunity(opportunityId, patch) {
      if (patch.amount !== undefined && (!Number.isFinite(patch.amount) || patch.amount < 1)) return;
      if (patch.probability !== undefined && (!Number.isFinite(patch.probability) || patch.probability < 0 || patch.probability > 100)) return;
      if (patch.nextAction !== undefined && !patch.nextAction.trim()) return;
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity || Object.keys(patch).length === 0) return null;
        if (opportunity.stage === "won" && patch.probability !== undefined && patch.probability !== 100) return null;
        if (opportunity.stage === "lost" && patch.probability !== undefined && patch.probability !== 0) return null;
        const next = { ...current, opportunities: current.opportunities.map((item) => item.id === opportunityId ? { ...item, ...patch, updatedAt: now() } : item) };
        return activity(next, "opportunity", "更新商机", `已更新${opportunity.title}的成交信息。`);
      });
    },
    closeOpportunity(opportunityId, result, reason) {
      const lossReason = reason?.trim();
      if (result === "lost" && (!lossReason || !LOSS_REASONS.includes(lossReason as typeof LOSS_REASONS[number]))) return;
      commit((current) => {
        const opportunity = current.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity) return null;
        const probability = result === "won" ? 100 : 0;
        if (opportunity.stage === result
          && opportunity.probability === probability
          && (result === "won" ? opportunity.lossReason === undefined : opportunity.lossReason === lossReason)) {
          return null;
        }
        const next = {
          ...current,
          opportunities: current.opportunities.map((item) => item.id === opportunityId ? {
            ...item,
            stage: result,
            probability,
            lossReason: result === "lost" ? lossReason : undefined,
            updatedAt: now()
          } : item)
        };
        return activity(next, "stage", "关闭商机", `${opportunity.title}已${result === "won" ? "赢单" : "丢单"}。`);
      });
    },
    toggleAgent(name) {
      commit((current) => {
        const next = { ...current, demoSettings: { ...current.demoSettings, agents: { ...current.demoSettings.agents, [name]: !current.demoSettings.agents[name] } } };
        return activity(next, "stage", "更新智能体设置", `${name}已${next.demoSettings.agents[name] ? "启用" : "停用"}。`);
      });
    },
    toggleScript(platform) {
      commit((current) => {
        const next = { ...current, demoSettings: { ...current.demoSettings, scripts: { ...current.demoSettings.scripts, [platform]: !current.demoSettings.scripts[platform] } } };
        return activity(next, "stage", "更新平台话术", `${platform}话术已${next.demoSettings.scripts[platform] ? "启用" : "停用"}。`);
      });
    },
    reset() {
      commit(() => activity(createSeedDemoState(), "stage", "重置演示数据", "已恢复初始演示数据。"));
    }
  };
}

function currentIdPart(id: string): string {
  return id.replace(/^(customer|conversation)-/, "");
}
