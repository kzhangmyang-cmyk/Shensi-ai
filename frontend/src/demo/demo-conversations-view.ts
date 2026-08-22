import type { DemoConversation, DemoState } from "./demo-types";
import { escapeHtml, formatRelativeTime } from "./demo-ui";

type ConversationFilter = "all" | "unread" | "high-intent" | "manual";

let activeFilter: ConversationFilter = "all";
let activePlatform = "全部";

const quickReplies = [
  "方便补充一下项目面积和所在城市吗？",
  "我先为您整理相近案例，方便留下联系方式吗？",
  "预算和预计启动时间大约在什么范围？"
];

function knownMode(mode: string): DemoConversation["mode"] | null {
  return mode === "agent" || mode === "manual" || mode === "paused" ? mode : null;
}

function knownIntent(intent: string): DemoConversation["intent"] | null {
  return intent === "高" || intent === "中" || intent === "低" ? intent : null;
}

function modeLabel(mode: string): string {
  const safeMode = knownMode(mode);
  return safeMode ? { agent: "智能体跟进", manual: "人工接管", paused: "已暂停" }[safeMode] : "未知模式";
}

function intentBadge(intent: string): string {
  const safeIntent = knownIntent(intent);
  return `<span class="demo-intent intent-${safeIntent ?? "unknown"}">${safeIntent ? `${safeIntent}意向` : "未知意向"}</span>`;
}

function filterLabel(filter: ConversationFilter): string {
  return { all: "全部", unread: "未读", "high-intent": "高意向", manual: "需人工" }[filter];
}

function conversationMatches(conversation: DemoConversation): boolean {
  if (activePlatform !== "全部" && conversation.platform !== activePlatform) return false;
  if (activeFilter === "unread") return conversation.unread > 0;
  if (activeFilter === "high-intent") return conversation.intent === "高";
  if (activeFilter === "manual") return conversation.mode === "manual" || conversation.mode === "paused";
  return true;
}

function renderConversationRow(conversation: DemoConversation, selected: boolean): string {
  const latest = conversation.messages.at(-1);
  return `<button type="button" class="demo-conversation-row ${selected ? "selected" : ""}" data-demo-action="select-conversation" data-conversation-id="${escapeHtml(conversation.id)}">
    <span class="demo-conversation-row-top"><b>${escapeHtml(conversation.customerName)}</b><time>${formatRelativeTime(conversation.updatedAt)}</time></span>
    <span class="demo-conversation-row-meta"><span>${escapeHtml(conversation.platform)}</span>${intentBadge(conversation.intent)}${conversation.unread ? `<em>${conversation.unread}</em>` : ""}</span>
    <small>${escapeHtml(latest?.body ?? conversation.needSummary)}</small>
  </button>`;
}

function renderMessage(conversation: DemoConversation): string {
  return conversation.messages.map((message) => {
    const sender = message.sender === "customer" || message.sender === "agent" || message.sender === "operator" ? message.sender : "unknown";
    const senderLabel = sender === "customer" ? escapeHtml(conversation.customerName) : sender === "agent" ? "沟通智能体" : sender === "operator" ? "顾问" : "未知发送方";
    return `<article class="demo-message sender-${sender}">
    <span>${senderLabel}</span>
    <p>${escapeHtml(message.body)}</p>
    <time>${formatRelativeTime(message.sentAt)} · 演示</time>
  </article>`;
  }).join("");
}

export function setConversationFilter(filter: string, platform?: string): void {
  if (filter === "all" || filter === "unread" || filter === "high-intent" || filter === "manual") activeFilter = filter;
  if (platform) activePlatform = platform;
}

export function resetConversationViewState(): void {
  activeFilter = "all";
  activePlatform = "全部";
}

export function renderConversationsView(
  state: DemoState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  const selected = state.conversations.find((item) => item.id === state.selectedConversationId) ?? state.conversations[0];
  if (!selected) {
    main.innerHTML = "";
    inspector.innerHTML = "";
    return;
  }
  const platforms = ["全部", ...new Set(state.conversations.map((item) => item.platform))];
  const visible = state.conversations.filter(conversationMatches)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const manualCount = state.conversations.filter((item) => item.mode === "manual" || item.mode === "paused").length;
  const customer = selected.customerId ? state.customers.find((item) => item.id === selected.customerId) : undefined;

  main.innerHTML = `
    <section class="demo-conversations" aria-label="社媒对话工作台">
      <aside class="demo-conversation-list demo-panel">
        <div class="demo-conversation-list-heading"><div><span class="demo-status">演示模式</span><h2>会话收件箱</h2></div><small>${visible.length} 条会话</small></div>
        <div class="demo-platform-filters" role="group" aria-label="平台筛选">
          ${platforms.map((platform) => `<button type="button" class="${activePlatform === platform ? "active" : ""}" data-demo-action="filter-conversations" data-conversation-filter="${activeFilter}" data-platform="${escapeHtml(platform)}"><span>${escapeHtml(platform)}</span><b>${platform === "全部" ? state.conversations.length : state.conversations.filter((item) => item.platform === platform).length}</b></button>`).join("")}
        </div>
        <div class="demo-conversation-tabs" role="group" aria-label="会话状态筛选">
          ${(["all", "unread", "high-intent", "manual"] as ConversationFilter[]).map((filter) => `<button type="button" class="${activeFilter === filter ? "active" : ""}" data-demo-action="filter-conversations" data-conversation-filter="${filter}" data-platform="${escapeHtml(activePlatform)}">${filterLabel(filter)}${filter === "manual" ? ` <b>${manualCount}</b>` : ""}</button>`).join("")}
        </div>
        <div class="demo-conversation-rows">
          ${visible.length ? visible.map((conversation) => renderConversationRow(conversation, conversation.id === selected.id)).join("") : '<p class="demo-conversation-empty">当前筛选下没有演示会话。</p>'}
        </div>
      </aside>

      <section class="demo-chat-panel demo-panel">
        <header class="demo-chat-header">
          <div><span class="demo-status">演示模式</span><h2>${escapeHtml(selected.customerName)}</h2><p>${escapeHtml(selected.platform)} · ${modeLabel(selected.mode)} · ${knownIntent(selected.intent) ? `${knownIntent(selected.intent)}意向` : "未知意向"}</p></div>
          <div class="demo-chat-header-actions"><span class="demo-chip">${selected.messages.length} 条消息</span><span class="demo-mode-badge mode-${knownMode(selected.mode) ?? "unknown"}">${modeLabel(selected.mode)}</span></div>
        </header>
        <div class="demo-message-history" aria-live="polite">${renderMessage(selected)}</div>
        <div class="demo-quick-replies"><span>演示模式快捷回复</span>${quickReplies.map((reply) => `<button type="button" data-demo-action="quick-reply" data-conversation-id="${escapeHtml(selected.id)}" data-reply="${escapeHtml(reply)}">${escapeHtml(reply)}</button>`).join("")}</div>
        <form class="demo-message-composer" data-demo-action="send-message" data-conversation-id="${escapeHtml(selected.id)}">
          <label for="demo-message">发送演示消息</label>
          <textarea id="demo-message" name="demo-message" rows="3" placeholder="输入消息；不会发送到真实平台"></textarea>
          <div><small>仅写入当前浏览器的演示数据。</small><button type="submit" class="demo-primary">发送 <span>演示模式</span></button></div>
        </form>
      </section>
    </section>`;

  inspector.innerHTML = `
    <section class="demo-panel demo-conversation-inspector">
      <header><div><span class="demo-status">演示模式</span><h3>${escapeHtml(selected.customerName)} · 对话分析</h3></div>${intentBadge(selected.intent)}</header>
      <div class="demo-analysis-block"><b>需求摘要</b><p>${escapeHtml(selected.needSummary)}</p></div>
      <div class="demo-analysis-block risk"><b>风险提示</b><p>${escapeHtml(selected.risk)}</p></div>
      <div class="demo-analysis-block"><b>客户标签</b><div class="demo-tag-list">${selected.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") || "<small>暂无标签</small>"}</div></div>
      <form class="demo-add-tag" data-demo-action="add-conversation-tag" data-conversation-id="${escapeHtml(selected.id)}"><label>添加演示标签<input name="demo-tag" maxlength="16" placeholder="如：已确认预算"></label><button type="submit">添加</button></form>
      <div class="demo-mode-controls"><span>对话模式 <small>演示模式</small></span><div>${(["agent", "manual", "paused"] as const).map((mode) => `<button type="button" class="${selected.mode === mode ? "active" : ""}" data-demo-action="set-conversation-mode" data-conversation-id="${escapeHtml(selected.id)}" data-mode="${mode}">${modeLabel(mode)}</button>`).join("")}</div></div>
      <div class="demo-takeover-note"><b>${selected.mode === "agent" ? "智能体正在接待" : selected.mode === "manual" ? "人工已接管" : selected.mode === "paused" ? "自动回复已暂停" : "未知对话状态"}</b><span>所有切换只影响本地演示状态。</span></div>
      <div class="demo-transfer-panel"><div><b>${customer ? "已转入私域客户池" : "转入私域"}</b><span>${customer ? `已关联 ${escapeHtml(customer.name)} 的演示客户档案。` : "沉淀客户资料，继续完成后续跟进。"}</span></div>${customer ? `<button type="button" class="demo-primary" data-demo-action="open-private-customer" data-customer-id="${escapeHtml(customer.id)}">查看私域客户 <span>演示模式</span></button>` : `<button type="button" class="demo-primary" data-demo-action="transfer-to-private" data-conversation-id="${escapeHtml(selected.id)}">转入私域 <span>演示模式</span></button>`}</div>
    </section>`;
}
