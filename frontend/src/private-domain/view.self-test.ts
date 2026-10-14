import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderPrivateDomainView } from "./view";

const main = { innerHTML: "" } as HTMLElement;
const inspector = { innerHTML: "" } as HTMLElement;
const state = {
  status: "ready" as const,
  customers: [{
    id: "customer-1",
    company: `真实客户 <script>alert('customer')</script>`,
    country: "中国",
    contact: "王总",
    ownerId: "owner-1",
    teamId: "team-1",
    ownerName: "王业务",
    stage: "待首次跟进",
    amount: 12_880,
    health: 80,
    grade: "A" as const,
    nextReminder: "2026-08-08T09:00:00.000Z",
    wecomBound: false,
    pipelineStage: "暂无活跃商机",
    pipelineAmount: 0,
    activeDealCount: 0,
    acquisitionBindings: [{
      handoffId: "handoff-1",
      leadId: "lead-1",
      candidateId: "candidate-1",
      createdAt: "2026-08-07T08:00:00.000Z"
    }],
    activities: [{
      id: "activity-1",
      customerId: "customer-1",
      type: "note",
      content: `已交接 <img src=x onerror=alert('activity')>`,
      operatorId: "owner-1",
      operatorName: "王业务",
      nextReminder: "2026-08-08T09:00:00.000Z",
      createdAt: "2026-08-07T08:00:00.000Z"
    }]
  }],
  todos: [{
    id: "todo-1",
    title: `首次跟进 <script>alert('todo')</script>`,
    type: "customer",
    priority: "high" as const,
    status: "pending" as const,
    dueAt: "2026-08-08T09:00:00.000Z",
    ownerId: "owner-1",
    teamId: "team-1",
    related: "真实客户",
    done: false,
    customerId: "customer-1",
    leadId: "lead-1"
  }],
  selectedCustomerId: "customer-1",
  customerFilter: "all" as const,
  customerQuery: "",
  gradeFilter: "",
  stageFilter: "",
  ownerFilter: "",
  currentPage: 1,
  pageSize: 20,
  error: null
};

renderPrivateDomainView(state, main, inspector);
assert.match(main.innerHTML, /客户池/);
assert.match(main.innerHTML, /class="demo-private-domain real-private-domain real-private-overview"/);
assert.doesNotMatch(main.innerHTML, /客户与线索/);
assert.match(main.innerHTML, /<th>来源<\/th>/);
assert.match(main.innerHTML, /<th>最近跟进<\/th>/);
assert.match(main.innerHTML, /<th>下一步<\/th>/);
assert.match(main.innerHTML, /<th>操作<\/th>/);
assert.match(main.innerHTML, /抖音获客/);
assert.match(main.innerHTML, /真实客户/);
assert.match(main.innerHTML, /class="real-private-customer-select"/);
assert.match(inspector.innerHTML, /已交接/);
assert.match(inspector.innerHTML, /首次跟进/);
assert.match(inspector.innerHTML, /08\/08 17:00/);
assert.match(inspector.innerHTML, /待处理/);
assert.match(inspector.innerHTML, /data-private-domain-action="complete-todo" data-todo-id="todo-1"/);
assert.doesNotMatch(inspector.innerHTML, /Lead lead-1|Todo todo-1/);
assert.match(inspector.innerHTML, /负责人/);
assert.doesNotMatch(inspector.innerHTML, /Customer ID/);
assert.match(inspector.innerHTML, /data-private-domain-action="create-deal"/);
assert.match(inspector.innerHTML, /创建真实商机/);
assert.doesNotMatch(main.innerHTML + inspector.innerHTML, /演示模式|模拟触达/);
assert.doesNotMatch(main.innerHTML + inspector.innerHTML, /<script>|<img src=x/);
assert.match(main.innerHTML + inspector.innerHTML, /&lt;script&gt;|&lt;img/);

{
  const { document } = parseHTML(`<main>${main.innerHTML}</main>`);
  const filterGroup = document.querySelector<HTMLElement>(".real-private-tabs");
  const filterButtons = Array.from(
    filterGroup?.querySelectorAll<HTMLButtonElement>("button") ?? []
  );
  assert.equal(
    filterGroup?.getAttribute("role"),
    "group",
    "customer filters share one result table, so they must be a button group rather than incomplete tabs"
  );
  assert.equal(filterGroup?.getAttribute("aria-label"), "客户筛选");
  assert.equal(filterButtons.length, 3);
  assert.ok(
    filterButtons.every((button) => button.tagName === "BUTTON" && button.getAttribute("role") === null),
    "customer filters must retain native button keyboard behavior instead of overriding it with tab roles"
  );
  assert.deepEqual(
    filterButtons.map((button) => button.getAttribute("aria-pressed")),
    ["true", "false", "false"],
    "the selected filter must be announced as the active pressed button"
  );
}

{
  const todayMain = { innerHTML: "" } as HTMLElement;
  const todayInspector = { innerHTML: "" } as HTMLElement;
  renderPrivateDomainView({
    ...state,
    todos: [{ ...state.todos[0], dueAt: new Date().toISOString() }]
  }, todayMain, todayInspector);
  const { document } = parseHTML(`<main>${todayMain.innerHTML}</main>`);
  const followUpRow = document.querySelector<HTMLTableRowElement>(
    ".real-private-followups tbody tr"
  );
  const followUpCustomerButton = document.querySelector<HTMLButtonElement>(
    ".real-private-followups [data-private-domain-action=select-customer]"
  );
  assert.equal(
    followUpRow?.getAttribute("data-private-domain-action"),
    null,
    "a table row must not be the only customer-selection interaction because rows are not keyboard focusable"
  );
  assert.equal(
    followUpCustomerButton?.tagName,
    "BUTTON",
    "today follow-up customer selection must use a native button so Enter and Space activate it"
  );
  assert.equal(followUpCustomerButton?.getAttribute("type"), "button");
  assert.equal(followUpCustomerButton?.dataset.customerId, "customer-1");
  const followUpCustomerLabel = followUpCustomerButton?.getAttribute("aria-label") ?? "";
  assert.equal(followUpCustomerLabel.startsWith("查看真实客户 "), true);
  assert.equal(followUpCustomerLabel.endsWith("的客户详情"), true);
}

const catalogMain = { innerHTML: "" } as HTMLElement;
const catalogInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView(state, catalogMain, catalogInspector, { surface: "catalog" });
assert.match(catalogMain.innerHTML, /<th>客户等级<\/th>/);
assert.match(catalogMain.innerHTML, /<th>首次或下次跟进<\/th>/);
assert.match(catalogMain.innerHTML, /<th>预期金额<\/th>/);
assert.equal(
  catalogMain.innerHTML.indexOf("首次或下次跟进") < catalogMain.innerHTML.indexOf("预期金额"),
  true
);
assert.match(catalogMain.innerHTML, /real-private-result-count[^>]*>1 位客户/);
assert.match(catalogMain.innerHTML, />A级</);
assert.match(catalogMain.innerHTML, />¥12,880\.00</);
assert.doesNotMatch(catalogMain.innerHTML, /<th>来源<\/th>/);

const shellClassNames = new Set<string>();
const privateDomainShell = {
  classList: {
    toggle(name: string, enabled: boolean) {
      if (enabled) shellClassNames.add(name);
      else shellClassNames.delete(name);
    }
  }
} as unknown as Element;
const unselectedMain = {
  innerHTML: "",
  closest: () => privateDomainShell
} as unknown as HTMLElement;
const unselectedInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  selectedCustomerId: null
}, unselectedMain, unselectedInspector);
assert.equal(unselectedInspector.hidden, true);
assert.equal(
  shellClassNames.has("is-single-pane-module"),
  true,
  "an unselected customer pool must use the full-width main surface"
);
assert.match(unselectedMain.innerHTML, /真实客户/);
renderPrivateDomainView(state, unselectedMain, unselectedInspector);
assert.equal(
  shellClassNames.has("is-single-pane-module"),
  false,
  "an explicitly selected customer may return to the right-side inspector"
);

const emptyMain = { innerHTML: "" } as HTMLElement;
const emptyInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  status: "ready",
  customers: [],
  todos: [],
  selectedCustomerId: null,
  customerFilter: "all",
  customerQuery: "",
  gradeFilter: "",
  stageFilter: "",
  ownerFilter: "",
  currentPage: 1,
  pageSize: 20,
  error: null
}, emptyMain, emptyInspector);
assert.match(emptyMain.innerHTML, /暂无客户/);
assert.match(emptyMain.innerHTML, /class="demo-private-domain real-private-domain real-private-overview"/);
assert.equal(emptyInspector.hidden, true);
assert.doesNotMatch(emptyMain.innerHTML, /客户与线索/);
assert.match(emptyMain.innerHTML, /<th>客户<\/th>/);
assert.match(emptyMain.innerHTML, /<th>来源<\/th>/);
assert.match(emptyMain.innerHTML, /<th>阶段<\/th>/);
assert.match(emptyMain.innerHTML, /href="#acquisition"/);
assert.match(emptyMain.innerHTML, /开始获客/);
assert.match(emptyMain.innerHTML, /工作提示/);
assert.match(emptyMain.innerHTML, /今日跟进/);
assert.match(emptyMain.innerHTML, /前往获客中心/);

const pagedCustomers = Array.from({ length: 21 }, (_, index) => ({
  ...state.customers[0],
  id: `paged-customer-${index + 1}`,
  company: `第${index + 1}号隔离客户`
}));
const pagedMain = { innerHTML: "" } as HTMLElement;
const pagedInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  customers: pagedCustomers,
  selectedCustomerId: "paged-customer-21",
  currentPage: 2,
  pageSize: 20
}, pagedMain, pagedInspector);
assert.match(pagedMain.innerHTML, /第21号隔离客户/);
assert.doesNotMatch(pagedMain.innerHTML, /第1号隔离客户/);
assert.match(pagedMain.innerHTML, /21 条客户/);
assert.match(pagedMain.innerHTML, /<b>2<\/b>/);
assert.match(pagedInspector.innerHTML, /第21号隔离客户/);

const errorInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  status: "error",
  customers: [],
  todos: [],
  selectedCustomerId: null,
  customerFilter: "all",
  customerQuery: "",
  gradeFilter: "",
  stageFilter: "",
  ownerFilter: "",
  currentPage: 1,
  pageSize: 20,
  error: "请求失败（HTTP 403）"
}, { innerHTML: "" } as HTMLElement, errorInspector);
assert.equal(errorInspector.hidden, true);

const noBindingInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  customers: [{ ...state.customers[0], acquisitionBindings: [] }]
}, { innerHTML: "" } as HTMLElement, noBindingInspector);
assert.doesNotMatch(
  noBindingInspector.innerHTML,
  /data-private-domain-action="create-deal"/
);

const dealInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  customers: [{
    ...state.customers[0]!,
    activeDealCount: 1,
    activeDealId: "manual-deal",
    acquisitionBindings: []
  }]
}, { innerHTML: "" } as HTMLElement, dealInspector);
assert.match(dealInspector.innerHTML, /评估并创建正式报价/);
assert.match(dealInspector.innerHTML, /人工确认需求、预算、决策人和成交概率/);

const quoteEligibleInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  customers: [{
    ...state.customers[0]!,
    activeDealCount: 1,
    quoteEligibleDealId: "deal-1",
    quoteEligibleCandidateId: "candidate-1",
    acquisitionBindings: []
  }]
}, { innerHTML: "" } as HTMLElement, quoteEligibleInspector);
assert.match(
  quoteEligibleInspector.innerHTML,
  /data-private-domain-action="open-quote-workbench"/
);
assert.match(quoteEligibleInspector.innerHTML, /打开正式报价工作台/);

const zeroDealInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  ...state,
  customers: [{
    ...state.customers[0]!,
    activeDealCount: 0
  }]
}, { innerHTML: "" } as HTMLElement, zeroDealInspector);
assert.doesNotMatch(
  zeroDealInspector.innerHTML,
  /打开正式报价工作台/
);
assert.match(zeroDealInspector.innerHTML, /创建报价草稿/);
