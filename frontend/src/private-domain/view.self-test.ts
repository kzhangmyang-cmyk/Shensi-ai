import { strict as assert } from "node:assert";
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
  error: null
};

renderPrivateDomainView(state, main, inspector);
assert.match(main.innerHTML, /真实客户池/);
assert.match(main.innerHTML, /真实客户/);
assert.match(inspector.innerHTML, /已交接/);
assert.match(inspector.innerHTML, /首次跟进/);
assert.match(inspector.innerHTML, /2026-08-08T09:00:00\.000Z/);
assert.match(inspector.innerHTML, /lead-1/);
assert.match(inspector.innerHTML, /data-private-domain-action="create-deal"/);
assert.match(inspector.innerHTML, /创建真实商机/);
assert.doesNotMatch(main.innerHTML + inspector.innerHTML, /演示模式|模拟触达/);
assert.doesNotMatch(main.innerHTML + inspector.innerHTML, /<script>|<img src=x/);
assert.match(main.innerHTML + inspector.innerHTML, /&lt;script&gt;|&lt;img/);

const emptyMain = { innerHTML: "" } as HTMLElement;
const emptyInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView({
  status: "ready",
  customers: [],
  todos: [],
  selectedCustomerId: null,
  error: null
}, emptyMain, emptyInspector);
assert.match(emptyMain.innerHTML, /暂无真实私域客户/);

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
    activeDealCount: 1
  }]
}, { innerHTML: "" } as HTMLElement, dealInspector);
assert.match(
  dealInspector.innerHTML,
  /data-private-domain-action="open-quote-workbench"/
);
assert.match(dealInspector.innerHTML, /打开报价工作台/);

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
  /data-private-domain-action="open-quote-workbench"/
);
