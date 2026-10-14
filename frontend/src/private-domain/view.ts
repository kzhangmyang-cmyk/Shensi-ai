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
  customerFilter: "all" | "pending" | "today";
  customerQuery: string;
  gradeFilter: string;
  stageFilter: string;
  ownerFilter: string;
  currentPage: number;
  pageSize: number;
  error: string | null;
  editor?: {
    kind: "customer" | "activity" | "todo" | "complete";
    customerId?: string;
    todoId?: string;
    values: Record<string, string>;
    submitting: boolean;
    error: string | null;
  } | null;
  notice?: string | null;
}

export type PrivateDomainSurface = "private-domain" | "catalog";

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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "待安排";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function customerSource(customer: PrivateDomainCustomer): string {
  return pendingAcquisitionBindings(customer).length > 0 ? "抖音获客" : "CRM 录入";
}

function latestActivityAt(customer: PrivateDomainCustomer): string {
  const latest = customer.activities
    .map((activity) => activity.createdAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
  return latest ? formatDateTime(latest) : "暂无记录";
}

function customerOwnerLabel(customer: PrivateDomainCustomer): string {
  return customer.ownerName?.trim() || "负责人待同步";
}

function localDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function pendingTodos(state: PrivateDomainViewState): PrivateDomainTodo[] {
  return state.todos.filter((todo) => !todo.done && !todo.cancelledAt && !todo.historyAt);
}

function priorityLabel(priority: string): string {
  return ({ high: "高", medium: "中", normal: "普通" })[priority] ?? priority;
}

function todoStatusLabel(todo: PrivateDomainTodo): string {
  return todo.cancelledAt ? "已取消" : todo.done ? "已完成" : todo.historyAt ? "已归档" : todo.status === "in_progress" ? "进行中" : "待处理";
}

function renderEditor(state: PrivateDomainViewState): string {
  const editor = state.editor;
  if (!editor) return "";
  const { values } = editor;
  const input = (name: string, label: string, type = "text", required = false, max = 100) => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(values[name])}"${required ? " required" : ""} maxlength="${max}"></label>`;
  const textarea = (name: string, label: string, max: number) => `<label>${label}<textarea name="${name}" required maxlength="${max}" rows="3">${escapeHtml(values[name])}</textarea></label>`;
  const select = (name: string, label: string, choices: string[][]) => `<label>${label}<select name="${name}">${choices.map(([value, text]) => `<option value="${value}"${values[name] === value ? " selected" : ""}>${text}</option>`).join("")}</select></label>`;
  const title = { customer: "添加客户", activity: "记录跟进", todo: "安排待办", complete: "完成待办" }[editor.kind];
  const fields = editor.kind === "customer"
    ? input("company", "客户 / 公司名称", "text", true) + input("contact", "联系人") + input("country", "国家 / 地区") + input("stage", "客户阶段") + select("grade", "客户等级", [["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"]])
    : editor.kind === "activity"
      ? select("type", "跟进方式", [["note", "备注"], ["call", "电话"], ["email", "邮件"], ["wechat", "微信"], ["whatsapp", "WhatsApp"], ["meeting", "会议"]]) + textarea("content", "跟进内容", 2000) + input("nextReminder", "下次跟进时间", "datetime-local")
      : editor.kind === "todo"
        ? input("title", "待办内容", "text", true, 255) + input("dueAt", "截止时间", "datetime-local", true) + select("priority", "优先级", [["normal", "普通"], ["medium", "中"], ["high", "高"]])
        : textarea("completionResult", "本次处理结果", 255);
  return `<section class="demo-panel real-private-editor"><h3>${title}</h3><form data-private-domain-form="${editor.kind}" class="demo-form"><fieldset${editor.submitting ? " disabled" : ""}>${fields}</fieldset>${editor.error ? `<p role="alert">${escapeHtml(editor.error)}</p>` : ""}<div class="demo-customer-actions"><button class="demo-primary" type="submit"${editor.submitting ? " disabled" : ""}>${editor.submitting ? "正在保存…" : "保存"}</button><button type="button" class="real-private-inspector-action" data-private-domain-action="cancel-editor">关闭</button></div></form></section>`;
}

function customerIdsForFilter(state: PrivateDomainViewState): Set<string> | null {
  if (state.customerFilter === "all") return null;
  const today = localDateKey(new Date());
  return new Set(pendingTodos(state)
    .filter((todo) => state.customerFilter === "pending"
      || localDateKey(todo.dueAt) === today)
    .map((todo) => todo.customerId)
    .filter((id): id is string => Boolean(id)));
}

function filteredCustomers(state: PrivateDomainViewState): PrivateDomainCustomer[] {
  const todoIds = customerIdsForFilter(state);
  const query = state.customerQuery.trim().toLocaleLowerCase("zh-CN");
  return state.customers.filter((customer) =>
    (!todoIds || todoIds.has(customer.id))
    && (!query || [
      customer.company,
      customer.contact,
      customer.ownerName,
      customer.stage
    ].some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query)))
    && (!state.gradeFilter || customer.grade === state.gradeFilter)
    && (!state.stageFilter || customer.stage === state.stageFilter)
    && (!state.ownerFilter || customer.ownerId === state.ownerFilter));
}

function renderCustomerTabs(state: PrivateDomainViewState): string {
  const openTodos = pendingTodos(state);
  const today = localDateKey(new Date());
  const todayCount = openTodos.filter((todo) => localDateKey(todo.dueAt) === today).length;
  const tabs = [
    ["all", "全部客户", state.customers.length],
    ["pending", "待跟进", openTodos.length],
    ["today", "今日待办", todayCount]
  ] as const;
  const stageOptions = [...new Set(state.customers.map((customer) => customer.stage).filter(Boolean))];
  const gradeOptions = [...new Set(state.customers.map((customer) => customer.grade).filter(Boolean))];
  const owners = [...new Map(state.customers.map((customer) => [
    customer.ownerId,
    customer.ownerName ?? customer.ownerId
  ])).entries()];
  return `<div class="real-private-filterbar"><label class="real-private-search"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><span class="sr-only">搜索客户</span><input type="search" placeholder="搜索客户" value="${escapeHtml(state.customerQuery)}" data-private-domain-query></label><div class="real-private-tabs" role="group" aria-label="客户筛选">${tabs.map(([value, label, count]) =>
    `<button type="button" aria-pressed="${state.customerFilter === value}" class="${state.customerFilter === value ? "active" : ""}" data-private-domain-action="filter" data-filter="${value}">${label}<b>${count}</b></button>`
  ).join("")}</div><div class="real-private-selects">
    <label><span class="sr-only">客户等级</span><select data-private-domain-filter="grade" aria-label="客户等级"><option value="">全部等级</option>${gradeOptions.map((grade) => `<option value="${escapeHtml(grade)}"${state.gradeFilter === grade ? " selected" : ""}>${escapeHtml(grade)}</option>`).join("")}</select></label>
    <label><span class="sr-only">客户阶段</span><select data-private-domain-filter="stage" aria-label="客户阶段"><option value="">全部阶段</option>${stageOptions.map((stage) => `<option value="${escapeHtml(stage)}"${state.stageFilter === stage ? " selected" : ""}>${escapeHtml(stage)}</option>`).join("")}</select></label>
    <label><span class="sr-only">负责人</span><select data-private-domain-filter="owner" aria-label="负责人"><option value="">全部负责人</option>${owners.map(([id, name]) => `<option value="${escapeHtml(id)}"${state.ownerFilter === id ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>
  </div></div>`;
}

function renderEmptyCustomerRow(
  message = "获客候选完成 CRM 交接后会出现在这里。"
): string {
  return `<tr><td colspan="7"><div class="real-private-empty"><i class="ph ph-users-three" aria-hidden="true"></i><strong>暂无客户</strong><span>${escapeHtml(message)}</span><a href="#acquisition">前往获客中心</a></div></td></tr>`;
}

function renderPagination(total: number, state: PrivateDomainViewState): string {
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(Math.max(1, state.currentPage), pageCount);
  return `<footer class="real-private-pagination"><span>${total} 条客户</span><div>
    <button type="button" aria-label="上一页" data-private-domain-action="page" data-page="prev"${page <= 1 ? " disabled" : ""}><i class="ph ph-caret-left" aria-hidden="true"></i></button>
    <b>${page}</b>
    <button type="button" aria-label="下一页" data-private-domain-action="page" data-page="next"${page >= pageCount ? " disabled" : ""}><i class="ph ph-caret-right" aria-hidden="true"></i></button>
    <label><span class="sr-only">每页条数</span><select data-private-domain-filter="page-size" aria-label="每页条数">${[20, 50, 100].map((size) => `<option value="${size}"${state.pageSize === size ? " selected" : ""}>${size} 条/页</option>`).join("")}</select></label>
  </div></footer>`;
}

function renderWorkGuide(): string {
  return `<section class="demo-panel real-private-guide" aria-label="客户沉淀流程">
    <header><span class="demo-status">工作提示</span></header>
    <ol>
      <li><i class="ph ph-magnifying-glass" aria-hidden="true"></i><span><b>采集候选</b><small>在获客中心发现并核对公开线索</small></span></li>
      <li><i class="ph ph-user-check" aria-hidden="true"></i><span><b>核对并录入</b><small>人工确认客户身份与归属后写入 CRM</small></span></li>
      <li><i class="ph ph-calendar-check" aria-hidden="true"></i><span><b>建立跟进</b><small>为真实客户安排下一次联系与负责人</small></span></li>
    </ol>
  </section>`;
}

function renderTodayFollowUps(state: PrivateDomainViewState): string {
  const today = localDateKey(new Date());
  const todos = pendingTodos(state).filter((todo) => localDateKey(todo.dueAt) === today);
  const customerById = new Map(state.customers.map((customer) => [customer.id, customer]));
  return `<section class="demo-panel real-private-followups" aria-label="今日跟进">
    <header><div><span class="demo-status">今日跟进</span></div><span>${todos.length} 项</span></header>
    <div class="demo-customer-table-wrap"><table class="demo-customer-table">
      <thead><tr><th>待办</th><th>客户</th><th>优先级</th><th>负责人</th><th>截止时间</th><th>状态</th></tr></thead>
      <tbody>${todos.length > 0 ? todos.map((todo) => {
        const customer = todo.customerId ? customerById.get(todo.customerId) : undefined;
        return `<tr>
          <td><b>${escapeHtml(todo.title)}</b><small>${escapeHtml(todo.related || "未关联说明")}</small></td>
          <td>${customer
            ? `<button type="button" class="real-private-customer-select real-private-followup-customer-select" aria-label="查看${escapeHtml(customer.company)}的客户详情" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</button>`
            : "未关联客户"}</td><td>${escapeHtml(priorityLabel(todo.priority))}</td>
          <td>${escapeHtml(customer?.ownerName ?? "当前负责人")}</td><td>${escapeHtml(formatDateTime(todo.dueAt))}</td><td>${escapeHtml(todoStatusLabel(todo))}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="real-private-empty compact"><i class="ph ph-calendar-blank" aria-hidden="true"></i><strong>今天暂无待跟进事项</strong><span>新的真实待办会自动出现在这里。</span></div></td></tr>`}</tbody>
    </table></div>
    <footer class="real-private-count">${todos.length} 条跟进</footer>
  </section>`;
}

function renderCustomerList(
  state: PrivateDomainViewState,
  surface: PrivateDomainSurface
): string {
  if (state.status === "loading" && state.customers.length === 0) {
    return `<section class="demo-panel demo-empty" role="status"><h2>正在读取真实私域客户…</h2></section>`;
  }
  if (state.status === "error" && state.customers.length === 0) {
    return `<section class="demo-panel demo-empty" role="alert"><h2>真实私域客户读取失败</h2><p>${escapeHtml(state.error)}</p><button type="button" data-private-domain-action="retry">重新加载</button></section>`;
  }
  const visibleCustomers = filteredCustomers(state);
  const pageCount = Math.max(1, Math.ceil(visibleCustomers.length / state.pageSize));
  const page = Math.min(Math.max(1, state.currentPage), pageCount);
  const pagedCustomers = visibleCustomers.slice((page - 1) * state.pageSize, page * state.pageSize);
  const customerCountLabel = surface === "catalog"
    ? `${visibleCustomers.length} 位客户`
    : `${visibleCustomers.length} 位匹配客户`;
  const controls = `<div class="real-private-controls">${renderCustomerTabs(state)}<div class="real-private-domain-toolbar"><button type="button" data-private-domain-action="retry"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>刷新</button><a class="demo-primary" href="#acquisition"><i class="ph ph-plus" aria-hidden="true"></i>开始获客</a></div><div class="real-private-result-count" aria-live="polite">${customerCountLabel}</div></div>`;
  const tableHead = surface === "catalog"
    ? `<thead><tr><th>客户</th><th>客户等级</th><th>阶段</th><th>负责人</th><th>首次或下次跟进</th><th>预期金额</th><th>操作</th></tr></thead>`
    : `<thead><tr><th>客户</th><th>来源</th><th>阶段</th><th>负责人</th><th>最近跟进</th><th>下一步</th><th>操作</th></tr></thead>`;
  if (state.customers.length === 0) {
    return `<section class="demo-private-domain real-private-domain real-private-overview" aria-label="真实私域客户池">
      <section class="demo-customer-list demo-panel">
        ${controls}
        <div class="demo-customer-table-wrap"><table class="demo-customer-table">
          ${tableHead}
          <tbody>${renderEmptyCustomerRow()}</tbody>
        </table></div>
        ${renderPagination(0, state)}
      </section>
      ${renderWorkGuide()}
      ${renderTodayFollowUps(state)}
    </section>`;
  }
  return `
    <section class="demo-private-domain real-private-domain real-private-overview" aria-label="真实私域客户池">
      <section class="demo-customer-list demo-panel">
        ${controls}
        ${state.error ? `<div class="demo-customer-list-meta" role="alert"><span>${escapeHtml(state.error)}</span></div>` : ""}
        <div class="demo-customer-table-wrap"><table class="demo-customer-table">
          ${tableHead}
          <tbody>${visibleCustomers.length > 0 ? pagedCustomers.map((customer) => `
            <tr class="${customer.id === state.selectedCustomerId ? "selected" : ""}" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}">
              <td><button type="button" class="real-private-customer-select" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}"><b>${escapeHtml(customer.company)}</b><small>${escapeHtml(customer.contact || "待维护联系人")}</small></button></td>
              <td>${surface === "catalog"
                ? escapeHtml(`${customer.grade ?? "待评估"}级`)
                : escapeHtml(customerSource(customer))}</td>
              <td>${escapeHtml(customer.stage)}</td>
              <td>${escapeHtml(customer.ownerName ?? customer.ownerId)}</td>
              <td>${surface === "catalog"
                ? escapeHtml(formatDateTime(customer.nextReminder))
                : escapeHtml(latestActivityAt(customer))}</td>
              <td>${surface === "catalog"
                ? escapeHtml(formatAmount(customer.amount))
                : escapeHtml(formatDateTime(customer.nextReminder))}</td>
              <td><button type="button" class="real-private-row-action" data-private-domain-action="select-customer" data-customer-id="${escapeHtml(customer.id)}">查看详情</button></td>
            </tr>
          `).join("") : renderEmptyCustomerRow("当前筛选下没有需要处理的客户。")}</tbody>
        </table></div>
        ${renderPagination(visibleCustomers.length, { ...state, currentPage: page })}
      </section>
      ${renderWorkGuide()}
      ${renderTodayFollowUps(state)}
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
      <header><div><span class="demo-status">客户详情</span><h3>${escapeHtml(customer.company)}</h3><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact || "待维护")}</p></div><strong>${escapeHtml(customer.grade ?? "待评估")}级</strong></header>
      <div class="demo-customer-detail-grid">
        <div><b>负责人</b><span>${escapeHtml(customerOwnerLabel(customer))}</span></div>
        <div><b>下次跟进</b><span>${escapeHtml(formatDateTime(customer.nextReminder))}</span></div>
        <div><b>活跃商机</b><span>${escapeHtml(customer.pipelineStage ?? "暂无活跃商机")}</span></div>
        <div><b>预期金额</b><span>${escapeHtml(formatAmount(customer.amount))}</span></div>
      </div>
      <div class="demo-customer-actions"><button type="button" class="real-private-inspector-action" data-private-domain-action="record-activity">记录跟进</button><button type="button" class="real-private-inspector-action" data-private-domain-action="create-todo">安排待办</button></div>
      ${pendingBindings.length > 0 ? `<div class="demo-customer-actions"><button type="button" class="demo-primary" data-private-domain-action="create-deal" data-customer-id="${escapeHtml(customer.id)}">创建真实商机</button></div>` : ""}
      <div class="demo-customer-actions"><button type="button" class="real-private-inspector-action" data-private-domain-action="open-quote-workbench" data-customer-id="${escapeHtml(customer.id)}">${customer.quoteEligibleDealId?.trim()
        ? "打开正式报价工作台"
        : customer.activeDealId?.trim()
          ? "评估并创建正式报价"
          : "创建报价草稿"}</button></div>
      ${customer.activeDealId?.trim() && !customer.quoteEligibleDealId?.trim()
        ? `<p class="demo-customer-action-note">普通 CRM 商机将先由负责人明确人工确认需求、预算、决策人和成交概率，再进入正式报价审批。</p>`
        : ""}
      <div class="demo-analysis-block demo-customer-timeline"><b>真实客户活动</b><ol>${customer.activities.length > 0
        ? customer.activities.map((activity) => `<li><time>${escapeHtml(formatDateTime(activity.createdAt))}</time><span><b>${escapeHtml(activity.operatorName ?? activity.operatorId)}</b>${escapeHtml(activity.content)}</span></li>`).join("")
        : "<li><span><b>暂无活动</b>客户尚无跟进记录。</span></li>"}</ol></div>
      <div class="demo-analysis-block demo-customer-timeline"><b>关联待办</b><ol>${relatedTodos.length > 0
        ? relatedTodos.map((todo) => `<li data-todo-id="${escapeHtml(todo.id)}"><time>${escapeHtml(formatDateTime(todo.dueAt))}</time><span><b>${escapeHtml(todo.title)}</b>${escapeHtml(priorityLabel(todo.priority))}优先级 · ${escapeHtml(todoStatusLabel(todo))}${!todo.done && !todo.cancelledAt && !todo.historyAt ? `<button type="button" class="real-private-inspector-action" data-private-domain-action="complete-todo" data-todo-id="${escapeHtml(todo.id)}">完成待办</button>` : ""}</span></li>`).join("")
        : "<li><span><b>暂无待办</b>该客户尚无未完成待办。</span></li>"}</ol></div>
    </section>
  `;
}

export function renderPrivateDomainView(
  state: PrivateDomainViewState,
  main: HTMLElement,
  inspector: HTMLElement,
  options: { surface?: PrivateDomainSurface } = {}
): void {
  const selectedCustomer = state.customers.find((customer) =>
    customer.id === state.selectedCustomerId);
  main.innerHTML = `${state.notice ? `<p role="status">${escapeHtml(state.notice)}</p>` : ""}${state.editor?.kind === "customer" ? renderEditor(state) : ""}${renderCustomerList(state, options.surface ?? "private-domain")}`;
  inspector.innerHTML = `${state.editor && state.editor.kind !== "customer" ? renderEditor(state) : ""}${renderInspector(selectedCustomer, state.todos)}`;
  inspector.hidden = selectedCustomer === undefined;
  main.closest?.(".replica-shell")?.classList.toggle(
    "is-single-pane-module",
    selectedCustomer === undefined
  );
}
