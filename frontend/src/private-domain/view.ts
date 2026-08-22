import type {
  PrivateDomainCustomer,
  PrivateDomainTodo
} from "./runtime-api";
import { pendingAcquisitionBindings } from "./runtime-api";

export interface PrivateDomainViewState {
  status: "loading" | "ready" | "error";
  customers: PrivateDomainCustomer[];
  todos: PrivateDomainTodo[];
  selectedCustomerId: string | null;
  error: string | null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2
  }).format(Number.isFinite(value) ? value : 0);
}

function renderCustomerList(state: PrivateDomainViewState): string {
  if (state.status === "loading" && state.customers.length === 0) {
    return `<section class="demo-panel demo-empty" role="status"><h2>正在读取真实私域客户…</h2></section>`;
  }
  if (state.status === "error" && state.customers.length === 0) {
    return `<section class="demo-panel demo-empty" role="alert"><h2>真实私域客户读取失败</h2><p>${escapeHtml(state.error)}</p><button type="button" data-private-domain-action="retry">重新加载</button></section>`;
  }
  if (state.customers.length === 0) {
    return `<section class="demo-panel demo-empty"><h2>暂无真实私域客户</h2><p>已批准的获客候选完成 CRM/私域交接后会出现在这里。</p></section>`;
  }
  return `
    <section class="demo-private-domain" aria-label="真实私域客户池">
      <section class="demo-customer-list demo-panel">
        <header><div><span class="demo-status">真实数据</span><h2>真实客户池</h2><p>来自 CRM 的客户、活动与关联待办。</p></div><button type="button" data-private-domain-action="retry">刷新</button></header>
        ${state.error ? `<div class="demo-customer-list-meta" role="alert"><span>${escapeHtml(state.error)}</span></div>` : ""}
        <div class="demo-customer-table-wrap"><table class="demo-customer-table">
          <thead><tr><th>客户</th><th>等级</th><th>阶段</th><th>负责人</th><th>首次/下次跟进</th><th>预期金额</th></tr></thead>
          <tbody>${state.customers.map((customer) => `
            <tr class="${customer.id === state.selectedCustomerId ? "selected" : ""}" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}">
              <td><button type="button" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}"><b>${escapeHtml(customer.company)}</b><small>${escapeHtml(customer.contact || "待维护联系人")}</small></button></td>
              <td>${escapeHtml(customer.grade ?? "待评估")}</td>
              <td>${escapeHtml(customer.stage)}</td>
              <td>${escapeHtml(customer.ownerName ?? customer.ownerId)}</td>
              <td>${escapeHtml(customer.nextReminder || "待安排")}</td>
              <td>${escapeHtml(formatAmount(customer.amount))}</td>
            </tr>
          `).join("")}</tbody>
        </table></div>
      </section>
    </section>
  `;
}

function renderInspector(
  customer: PrivateDomainCustomer | undefined,
  todos: PrivateDomainTodo[]
): string {
  if (!customer) return "";
  const relatedTodos = todos.filter((todo) => todo.customerId === customer.id);
  const pendingBindings = pendingAcquisitionBindings(customer);
  return `
    <section class="demo-panel demo-customer-inspector">
      <header><div><span class="demo-status">真实 CRM</span><h3>${escapeHtml(customer.company)}</h3><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact || "待维护")}</p></div><strong>${escapeHtml(customer.grade ?? "待评估")}级</strong></header>
      <div class="demo-customer-detail-grid">
        <div><b>Customer ID</b><span>${escapeHtml(customer.id)}</span></div>
        <div><b>下次跟进</b><span>${escapeHtml(customer.nextReminder || "待安排")}</span></div>
        <div><b>活跃商机</b><span>${escapeHtml(customer.pipelineStage ?? "暂无活跃商机")}</span></div>
        <div><b>预期金额</b><span>${escapeHtml(formatAmount(customer.amount))}</span></div>
      </div>
      ${pendingBindings.length > 0 ? `<div class="demo-customer-actions"><button type="button" class="demo-primary" data-private-domain-action="create-deal" data-customer-id="${escapeHtml(customer.id)}">创建真实商机</button></div>` : ""}
      ${(customer.activeDealCount ?? 0) > 0 && customer.acquisitionBindings?.some(
        (binding) => typeof binding?.handoffId === "string"
          && Boolean(binding.handoffId.trim()))
        ? `<div class="demo-customer-actions"><button type="button" data-private-domain-action="open-quote-workbench" data-customer-id="${escapeHtml(customer.id)}">打开报价工作台</button></div>`
        : ""}
      <div class="demo-analysis-block demo-customer-timeline"><b>真实客户活动</b><ol>${customer.activities.length > 0
        ? customer.activities.map((activity) => `<li><time>${escapeHtml(activity.createdAt)}</time><span><b>${escapeHtml(activity.operatorName ?? activity.operatorId)}</b>${escapeHtml(activity.content)}</span></li>`).join("")
        : "<li><span><b>暂无活动</b>客户尚无跟进记录。</span></li>"}</ol></div>
      <div class="demo-analysis-block demo-customer-timeline"><b>关联待办</b><ol>${relatedTodos.length > 0
        ? relatedTodos.map((todo) => `<li data-todo-id="${escapeHtml(todo.id)}"><time>${escapeHtml(todo.dueAt || "待安排")}</time><span><b>${escapeHtml(todo.title)}</b>Todo ${escapeHtml(todo.id)} · Lead ${escapeHtml(todo.leadId ?? "未关联")}</span></li>`).join("")
        : "<li><span><b>暂无待办</b>该客户尚无未完成待办。</span></li>"}</ol></div>
    </section>
  `;
}

export function renderPrivateDomainView(
  state: PrivateDomainViewState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  main.innerHTML = renderCustomerList(state);
  inspector.innerHTML = renderInspector(
    state.customers.find((customer) => customer.id === state.selectedCustomerId)
      ?? state.customers[0],
    state.todos
  );
}
