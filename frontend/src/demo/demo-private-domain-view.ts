import type { DemoCustomer, DemoState, IntentLevel, Platform } from "./demo-types";
import { escapeHtml, formatRelativeTime } from "./demo-ui";
import { normalizeIsoDateTime } from "./demo-store";

type CustomerGroupFilter = "all" | DemoCustomer["group"];

let activeGroup: CustomerGroupFilter = "all";
let activeIntent: IntentLevel | "全部" = "全部";
let activePlatform: Platform | "全部" = "全部";
let activeSearch = "";
let selectedCustomerIds = new Set<string>();
let opportunityFormCustomerId = "";

const groups: Array<{ id: CustomerGroupFilter; label: string }> = [
  { id: "all", label: "全部客户" },
  { id: "重点客户", label: "重点客户" },
  { id: "待跟进", label: "待跟进" },
  { id: "沉默客户", label: "沉默客户" },
  { id: "已创建商机", label: "已创建商机" }
];

const platforms: Platform[] = ["抖音", "小红书", "快手", "微信", "微博"];
const intents: IntentLevel[] = ["高", "中", "低"];
const customerStatuses = ["跟进中", "待跟进", "已沉默", "已有商机"] as const;

function knownIntent(value: string): IntentLevel | null {
  return intents.find((intent) => intent === value) ?? null;
}

function knownStatus(value: string): typeof customerStatuses[number] | null {
  return customerStatuses.find((status) => status === value) ?? null;
}

function intentBadge(value: string): string {
  const intent = knownIntent(value);
  return `<span class="demo-intent intent-${intent ?? "unknown"}">${intent ? `${intent}意向` : "未知意向"}</span>`;
}

function statusBadge(value: string): string {
  const status = knownStatus(value);
  return `<span class="demo-customer-status status-${status ?? "unknown"}">${escapeHtml(status ?? value)}</span>`;
}

function escapedDate(value: string): string {
  return escapeHtml(value);
}

function timelineTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function taskTimelineTime(task: DemoState["tasks"][number]): string | null {
  const dueAt = task.dueAt ? normalizeIsoDateTime(task.dueAt) : null;
  if (dueAt) return dueAt;
  return task.createdAt ? normalizeIsoDateTime(task.createdAt) : null;
}

function customerMatches(customer: DemoCustomer): boolean {
  if (activeGroup !== "all" && customer.group !== activeGroup) return false;
  if (activeIntent !== "全部" && customer.intent !== activeIntent) return false;
  if (activePlatform !== "全部" && customer.platform !== activePlatform) return false;
  const query = activeSearch.toLocaleLowerCase();
  return !query || [customer.name, customer.platform, customer.owner, customer.needSummary, ...customer.tags]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function customerStatusLabel(customer: DemoCustomer): string {
  return knownStatus(customer.status) ?? customer.status;
}

function renderGroupRail(state: DemoState): string {
  return `<aside class="demo-customer-groups demo-panel" aria-label="客户分组">
    <div><span class="demo-status">演示模式</span><h2>客户分组</h2><small>共 ${state.customers.length} 位客户</small></div>
    <div class="demo-customer-group-list">
      ${groups.map((group) => `<button type="button" class="${activeGroup === group.id ? "active" : ""}" ${group.id === "已创建商机" ? 'aria-label="筛选商机已创建客户"' : ""} data-demo-action="filter-customers" data-customer-group="${group.id}"><span>${group.label}</span><b>${group.id === "all" ? state.customers.length : state.customers.filter((customer) => customer.group === group.id).length}</b></button>`).join("")}
      <button type="button" class="demo-custom-group" disabled><span>自定义分组</span><small>演示版暂未接入</small></button>
    </div>
  </aside>`;
}

function renderTags(customer: DemoCustomer): string {
  return `<div class="demo-customer-tags">${customer.tags.length
    ? customer.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")
    : "<small>暂无标签</small>"}</div>`;
}

function renderCustomerRows(customers: DemoCustomer[], selectedCustomerId: string, transferredCustomerIds: Set<string>): string {
  if (!customers.length) return `<div class="demo-customer-empty"><b>当前筛选下没有客户</b><span>试试清除搜索或切换分组。</span></div>`;
  return `<div class="demo-customer-table-wrap"><table class="demo-customer-table">
    <thead><tr><th scope="col"><span class="sr-only">批量选择</span></th><th scope="col">客户名称</th><th scope="col">来源平台</th><th scope="col">意向等级</th><th scope="col">客户标签</th><th scope="col">所属分组</th><th scope="col">负责人</th><th scope="col">最后沟通</th><th scope="col">下一步跟进</th><th scope="col">当前状态</th></tr></thead>
    <tbody>${customers.map((customer) => `<tr class="${customer.id === selectedCustomerId ? "selected" : ""}" data-demo-action="select-customer" data-customer-id="${escapeHtml(customer.id)}" ${transferredCustomerIds.has(customer.id) ? `data-customer-source="${escapeHtml(customer.conversationId)}"` : ""}>
      <td data-label="批量选择"><input type="checkbox" aria-label="选择${escapeHtml(customer.name)}" data-demo-action="toggle-customer-batch" data-customer-id="${escapeHtml(customer.id)}" ${selectedCustomerIds.has(customer.id) ? "checked" : ""}></td>
      <td data-label="客户名称"><b>${escapeHtml(customer.name)}</b><small>${escapeHtml(customer.needSummary)}</small></td>
      <td data-label="来源平台">${escapeHtml(customer.platform)}</td>
      <td data-label="意向等级">${intentBadge(customer.intent)}</td>
      <td data-label="客户标签">${renderTags(customer)}</td>
      <td data-label="所属分组"><span class="demo-customer-group-chip">${escapeHtml(customer.group)}</span></td>
      <td data-label="负责人">${escapeHtml(customer.owner)}</td>
      <td data-label="最后沟通"><time datetime="${escapedDate(customer.lastContactAt)}">${formatRelativeTime(customer.lastContactAt)}</time></td>
      <td data-label="下一步跟进"><time datetime="${escapedDate(customer.nextFollowUpAt)}">${formatRelativeTime(customer.nextFollowUpAt)}</time></td>
      <td data-label="当前状态">${statusBadge(customer.status)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderTimeline(state: DemoState, customer: DemoCustomer): string {
  const conversation = state.conversations.find((item) => item.id === customer.conversationId);
  const items = [
    ...state.activities.filter((item) => item.detail.includes(customer.name) || (conversation && item.detail.includes(conversation.customerName))).map((item) => ({ title: item.title, detail: item.detail, at: item.createdAt })),
    ...state.tasks.filter((item) => item.relatedId === customer.id).map((item) => ({ title: "跟进计划", detail: item.title, at: taskTimelineTime(item) }))
  ].sort((left, right) => timelineTimestamp(right.at) - timelineTimestamp(left.at)).slice(0, 5);
  return items.length ? items.map((item) => `<li><time>${item.at ? formatRelativeTime(item.at) : "未记录时间"}</time><span><b>${escapeHtml(item.title)}</b>${escapeHtml(item.detail)}</span></li>`).join("")
    : "<li><span><b>待补充</b>该客户暂无演示跟进记录。</span></li>";
}

function renderInspector(state: DemoState, customer: DemoCustomer): string {
  const conversation = state.conversations.find((item) => item.id === customer.conversationId);
  const showOpportunityForm = opportunityFormCustomerId === customer.id;
  return `<section class="demo-panel demo-customer-inspector">
    <header><div><span class="demo-status">演示模式</span><h3>${escapeHtml(customer.name)}</h3><p>${escapeHtml(customer.owner)} · ${escapeHtml(customerStatusLabel(customer))}</p></div>${intentBadge(customer.intent)}</header>
    <div class="demo-customer-detail-grid"><div><b>客户来源</b><span>${escapeHtml(customer.platform)} · ${escapeHtml(customer.conversationId)}</span></div><div><b>下一步计划</b><time datetime="${escapedDate(customer.nextFollowUpAt)}">${formatRelativeTime(customer.nextFollowUpAt)}</time></div></div>
    <div class="demo-analysis-block"><b>需求摘要</b><p>${escapeHtml(customer.needSummary)}</p></div>
    <div class="demo-analysis-block"><b>聊天摘要</b><p>${escapeHtml(conversation?.messages.at(-1)?.body ?? "暂无关联聊天记录")}</p></div>
    <div class="demo-analysis-block"><b>标签与分组</b>${renderTags(customer)}<form class="demo-customer-group-form" data-demo-action="change-customer-group" data-customer-id="${escapeHtml(customer.id)}"><select name="customer-group" aria-label="客户分组">${groups.slice(1).map((group) => `<option value="${group.id}" ${customer.group === group.id ? "selected" : ""}>${group.label}</option>`).join("")}</select><button type="submit">更新分组</button></form></div>
    <form class="demo-add-tag" data-demo-action="add-customer-tag" data-customer-id="${escapeHtml(customer.id)}"><label>添加客户标签<input name="customer-tag" maxlength="16" placeholder="如：预算明确"></label><button type="submit">添加标签</button></form>
    <form class="demo-follow-up-form" data-demo-action="create-follow-up" data-customer-id="${escapeHtml(customer.id)}"><label>安排跟进<input name="follow-up-note" maxlength="40" placeholder="如：发送案例与报价范围"></label><label>跟进时间<input name="follow-up-at" type="datetime-local" value="2026-07-30T10:00"></label><button type="submit">安排跟进</button></form>
    <div class="demo-customer-actions"><button type="button" class="demo-primary" data-demo-action="open-opportunity-form" data-customer-id="${escapeHtml(customer.id)}">创建商机 <span>演示模式</span></button></div>
    ${showOpportunityForm ? `<form class="demo-opportunity-form" data-demo-action="create-opportunity" data-customer-id="${escapeHtml(customer.id)}"><b>创建演示商机</b><label>商机名称<input name="opportunity-title" maxlength="40" value="${escapeHtml(customer.name)}合作商机"></label><label>预计金额<input name="opportunity-amount" type="number" min="0" step="1000" value="86000"></label><button type="submit" class="demo-primary">确认创建商机</button></form>` : ""}
    <div class="demo-analysis-block demo-customer-timeline"><b>跟进时间线</b><ol>${renderTimeline(state, customer)}</ol></div>
  </section>`;
}

export function setPrivateDomainFilter(input: { group?: string; intent?: string; platform?: string; search?: string }): void {
  const matchingGroup = groups.find((group) => group.id === input.group);
  if (matchingGroup) activeGroup = matchingGroup.id;
  if (input.intent === "全部" || input.intent === "高" || input.intent === "中" || input.intent === "低") activeIntent = input.intent;
  if (input.platform === "全部" || input.platform === "抖音" || input.platform === "小红书" || input.platform === "快手" || input.platform === "微信" || input.platform === "微博") activePlatform = input.platform;
  if (input.search !== undefined) activeSearch = input.search.trim();
}

export function toggleCustomerBatchSelection(customerId: string, selected: boolean): void {
  if (selected) selectedCustomerIds.add(customerId);
  else selectedCustomerIds.delete(customerId);
}

export function selectedCustomerBatchIds(): string[] {
  return [...selectedCustomerIds];
}

export function clearCustomerBatchSelection(): void {
  selectedCustomerIds.clear();
}

export function openOpportunityForm(customerId: string): void {
  opportunityFormCustomerId = customerId;
}

export function closeOpportunityForm(): void {
  opportunityFormCustomerId = "";
}

export function resetPrivateDomainViewState(): void {
  activeGroup = "all";
  activeIntent = "全部";
  activePlatform = "全部";
  activeSearch = "";
  selectedCustomerIds.clear();
  opportunityFormCustomerId = "";
}

export function renderPrivateDomainView(state: DemoState, main: HTMLElement, inspector: HTMLElement): void {
  const selected = state.customers.find((customer) => customer.id === state.selectedCustomerId) ?? state.customers[0];
  selectedCustomerIds = new Set([...selectedCustomerIds].filter((id) => state.customers.some((customer) => customer.id === id)));
  if (!selected) {
    main.innerHTML = '<section class="demo-panel demo-empty"><h2>暂无私域客户</h2><p>先从社媒对话中转入一位客户，再开始演示跟进。</p></section>';
    inspector.innerHTML = "";
    return;
  }
  const customers = state.customers.filter(customerMatches);
  const transferredCustomerIds = new Set(state.conversations.flatMap((conversation) => conversation.customerId ? [conversation.customerId] : []));
  const availablePlatforms = ["全部", ...platforms.filter((platform) => state.customers.some((customer) => customer.platform === platform))];
  main.innerHTML = `<section class="demo-private-domain" aria-label="私域客户池">
    ${renderGroupRail(state)}
    <section class="demo-customer-list demo-panel"><header><div><span class="demo-status">演示模式</span><h2>客户资产池</h2><p>筛选、分组与触达均只更新本地演示数据。</p></div><button type="button" class="demo-primary" data-demo-action="simulate-outreach" ${selectedCustomerIds.size ? "" : "disabled"}>模拟批量触达 <span>${selectedCustomerIds.size ? `${selectedCustomerIds.size} 位客户` : "请选择客户"}</span></button></header>
      <form class="demo-customer-filters" data-demo-action="filter-customers"><label>搜索客户<input name="customer-search" value="${escapeHtml(activeSearch)}" placeholder="客户、标签或需求"></label><label>意向<select name="customer-intent">${(["全部", ...intents] as const).map((intent) => `<option value="${intent}" ${activeIntent === intent ? "selected" : ""}>${intent === "全部" ? "全部意向" : `${intent}意向`}</option>`).join("")}</select></label><label>来源<select name="customer-platform">${availablePlatforms.map((platform) => `<option value="${platform}" ${activePlatform === platform ? "selected" : ""}>${platform === "全部" ? "全部来源" : platform}</option>`).join("")}</select></label><button type="submit">筛选</button></form>
      <div class="demo-customer-list-meta"><span>${customers.length} 位匹配客户</span><small>勾选客户后可模拟批量触达</small></div>${renderCustomerRows(customers, selected.id, transferredCustomerIds)}
    </section>
  </section>`;
  inspector.innerHTML = renderInspector(state, selected);
}
