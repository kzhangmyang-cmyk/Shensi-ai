import { strict as assert } from "node:assert";
import { parseFollowUpAt } from "./demo-app";
import { renderCapabilityDemoView } from "./demo-capabilities-view";
import { renderConversationsView } from "./demo-conversations-view";
import { getConversionMetrics, renderConversionView } from "./demo-conversion-view";
import { renderDashboardView } from "./demo-dashboard-view";
import { renderPrivateDomainView } from "./demo-private-domain-view";
import { createDemoStore } from "./demo-store";
import type { DemoState } from "./demo-types";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key)
};

const store = createDemoStore({ storage, now: () => "2026-07-29T09:00:00.000Z" });
const initial = store.getState();
assert.equal(initial.conversations.length >= 5, true);
assert.equal(initial.customers.length >= 4, true);
assert.equal(initial.opportunities.length >= 3, true);

const reviewFailures: string[] = [];
function checkReviewFinding(name: string, check: () => void): void {
  try {
    check();
  } catch (error) {
    reviewFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

checkReviewFinding("default conversation/customer links are reciprocal and transfer is idempotent", () => {
  const linkedCustomer = initial.customers.find((item) => item.conversationId === "conversation-douyin-lin");
  const linkedConversation = initial.conversations.find((item) => item.id === "conversation-douyin-lin");
  assert.ok(linkedCustomer);
  assert.equal(linkedConversation?.customerId, linkedCustomer.id);

  const relationMemory = new Map<string, string>();
  const relationStore = createDemoStore({
    storage: {
      getItem: (key) => relationMemory.get(key) ?? null,
      setItem: (key, value) => void relationMemory.set(key, value),
      removeItem: (key) => void relationMemory.delete(key)
    },
    now: () => "2026-07-29T09:00:00.000Z"
  });
  let notifications = 0;
  relationStore.subscribe(() => {
    notifications += 1;
  });
  const before = relationStore.getState();
  const firstCustomerId = relationStore.transferConversationToPrivate("conversation-douyin-lin");
  const afterFirst = relationStore.getState();
  const notificationsAfterFirst = notifications;
  const secondCustomerId = relationStore.transferConversationToPrivate("conversation-douyin-lin");
  const afterSecond = relationStore.getState();
  assert.equal(firstCustomerId, linkedCustomer.id);
  assert.equal(secondCustomerId, linkedCustomer.id);
  assert.equal(afterFirst.selectedCustomerId, linkedCustomer.id);
  assert.equal(afterFirst.customers.length, before.customers.length);
  assert.equal(afterFirst.activities.length, before.activities.length);
  assert.equal(afterSecond.customers.length, afterFirst.customers.length);
  assert.equal(afterSecond.activities.length, afterFirst.activities.length);
  assert.equal(notifications, notificationsAfterFirst);
});

checkReviewFinding("legacy one-way links normalize without duplicating customers", () => {
  const legacyState = JSON.parse(JSON.stringify(initial)) as DemoState;
  const linkedCustomer = legacyState.customers.find((item) => item.conversationId === "conversation-douyin-lin");
  const linkedConversation = legacyState.conversations.find((item) => item.id === "conversation-douyin-lin");
  assert.ok(linkedCustomer);
  assert.ok(linkedConversation);
  delete linkedConversation.customerId;
  const legacyStore = createDemoStore({
    storage: {
      getItem: () => JSON.stringify(legacyState),
      setItem: () => undefined,
      removeItem: () => undefined
    }
  });
  assert.equal(
    legacyStore.getState().conversations.find((item) => item.id === linkedConversation.id)?.customerId,
    linkedCustomer.id
  );
  assert.equal(legacyStore.getState().customers.length, legacyState.customers.length);
});

checkReviewFinding("generic stage movement cannot enter or reopen terminal stages", () => {
  const terminalStore = createDemoStore({ storage: null, now: () => "2026-07-29T09:00:00.000Z" });
  const opportunityId = "opportunity-office";
  const before = terminalStore.getState();
  let notifications = 0;
  terminalStore.subscribe(() => {
    notifications += 1;
  });
  terminalStore.moveOpportunity(opportunityId, "won");
  terminalStore.moveOpportunity(opportunityId, "lost");
  assert.equal(terminalStore.getState().opportunities.find((item) => item.id === opportunityId)?.stage, "qualified");
  assert.equal(terminalStore.getState().activities.length, before.activities.length);
  assert.equal(notifications, 0);
  terminalStore.closeOpportunity(opportunityId, "won");
  assert.equal(terminalStore.getState().opportunities.find((item) => item.id === opportunityId)?.probability, 100);
  terminalStore.moveOpportunity(opportunityId, "negotiating");
  assert.equal(terminalStore.getState().opportunities.find((item) => item.id === opportunityId)?.stage, "won");

  const terminalMain = { innerHTML: "" } as HTMLElement;
  const terminalInspector = { innerHTML: "" } as HTMLElement;
  renderConversionView(terminalStore.getState(), terminalMain, terminalInspector);
  assert.equal(terminalInspector.innerHTML.includes('data-demo-action="move-opportunity" data-opportunity-id="opportunity-office" data-opportunity-stage="won"'), false);
  assert.equal(terminalInspector.innerHTML.includes('data-demo-action="move-opportunity" data-opportunity-id="opportunity-office" data-opportunity-stage="lost"'), false);
});

checkReviewFinding("malicious persisted unions, ranges, and relationships fall back to seed", () => {
  const payload = 'evil"><img src=x onerror=alert(1)>';
  const maliciousEnums = JSON.parse(JSON.stringify(initial)) as DemoState;
  maliciousEnums.conversations[0].customerName = payload;
  Object.assign(maliciousEnums.conversations[0], { platform: payload, intent: payload, mode: payload });
  Object.assign(maliciousEnums.conversations[0].messages[0], { sender: payload });
  Object.assign(maliciousEnums.customers[0], { platform: payload, intent: payload, group: payload, status: payload });
  Object.assign(maliciousEnums.opportunities[0], { stage: payload, source: payload, lossReason: payload });
  Object.assign(maliciousEnums.activities[0], { kind: payload });
  Object.assign(maliciousEnums.tasks[0], { priority: payload, module: payload });

  const invalidProbability = JSON.parse(JSON.stringify(initial)) as DemoState;
  invalidProbability.opportunities[0].probability = 101;
  const brokenRelationship = JSON.parse(JSON.stringify(initial)) as DemoState;
  brokenRelationship.opportunities[0].customerId = "missing-customer";

  for (const candidate of [maliciousEnums, invalidProbability, brokenRelationship]) {
    const repairedStore = createDemoStore({
      storage: {
        getItem: () => JSON.stringify(candidate),
        setItem: () => undefined,
        removeItem: () => undefined
      }
    });
    assert.equal(repairedStore.getState().conversations[0].id, "conversation-douyin-lin");
    assert.equal(repairedStore.getState().conversations[0].customerName, "林女士");
    assert.equal(repairedStore.getState().opportunities[0].probability, 55);
  }

  const unsafeConversationMain = { innerHTML: "" } as HTMLElement;
  const unsafeConversationInspector = { innerHTML: "" } as HTMLElement;
  renderConversationsView(maliciousEnums, unsafeConversationMain, unsafeConversationInspector);
  const unsafeDashboardMain = { innerHTML: "", querySelectorAll: () => [] } as unknown as HTMLElement;
  const unsafeDashboardInspector = { innerHTML: "" } as HTMLElement;
  renderDashboardView(maliciousEnums, unsafeDashboardMain, unsafeDashboardInspector);
  assert.equal(unsafeConversationMain.innerHTML.includes(payload), false);
  assert.equal(unsafeConversationInspector.innerHTML.includes(payload), false);
  assert.equal(unsafeDashboardMain.innerHTML.includes(payload), false);
});

checkReviewFinding("dashboard entity actions retain safe entity type and id", () => {
  const dashboardMain = { innerHTML: "", querySelectorAll: () => [] } as unknown as HTMLElement;
  const dashboardInspector = { innerHTML: "" } as HTMLElement;
  renderDashboardView(initial, dashboardMain, dashboardInspector);
  assert.equal(dashboardMain.innerHTML.includes('data-demo-entity-type="conversation" data-demo-entity-id="conversation-kuaishou-wang"'), true);
  assert.equal(dashboardMain.innerHTML.includes('data-demo-entity-type="customer" data-demo-entity-id="customer-wechat-zhou"'), true);
  assert.equal(dashboardMain.innerHTML.includes('data-demo-entity-type="opportunity" data-demo-entity-id="opportunity-office"'), true);
});

assert.deepEqual(reviewFailures, [], reviewFailures.join("\n"));

const capabilityMain = { innerHTML: "" } as HTMLElement;
const capabilityInspector = { innerHTML: "" } as HTMLElement;
const unsafeCapabilityState = JSON.parse(JSON.stringify(initial)) as DemoState;
unsafeCapabilityState.tasks[0].title = '<img src=x onerror=alert(1)>';
for (const module of ["agents", "scripts", "trade-marketing", "settings"] as const) {
  renderCapabilityDemoView(module, unsafeCapabilityState, capabilityMain, capabilityInspector);
  assert.equal(capabilityMain.innerHTML.includes('<img src=x onerror=alert(1)>'), false);
}
renderCapabilityDemoView("agents", unsafeCapabilityState, capabilityMain, capabilityInspector);
assert.equal(capabilityMain.innerHTML.includes("智能体"), true);
renderCapabilityDemoView("scripts", unsafeCapabilityState, capabilityMain, capabilityInspector);
assert.equal(capabilityMain.innerHTML.includes("抖音"), true);
renderCapabilityDemoView("trade-marketing", unsafeCapabilityState, capabilityMain, capabilityInspector);
assert.equal(capabilityMain.innerHTML.includes("演示版暂未接入"), true);
renderCapabilityDemoView("settings", unsafeCapabilityState, capabilityMain, capabilityInspector);
assert.equal(capabilityMain.innerHTML.includes("重置演示数据"), true);

const unsafeState = JSON.parse(JSON.stringify(initial)) as DemoState;
const unsafeCustomer = unsafeState.customers[0];
unsafeCustomer.intent = 'high"><img src=x onerror=alert(1)>' as typeof unsafeCustomer.intent;
unsafeCustomer.group = '"><svg onload=alert(1)>' as typeof unsafeCustomer.group;
unsafeCustomer.status = '"><img src=x onerror=alert(1)>' as typeof unsafeCustomer.status;
unsafeCustomer.platform = '"><option selected>unsafe</option>' as typeof unsafeCustomer.platform;
const unsafeMain = { innerHTML: "" } as HTMLElement;
const unsafeInspector = { innerHTML: "" } as HTMLElement;
renderPrivateDomainView(unsafeState, unsafeMain, unsafeInspector);
assert.equal(unsafeMain.innerHTML.includes('intent-high"><img'), false);
assert.equal(unsafeMain.innerHTML.includes('status-"><img'), false);
assert.equal(unsafeMain.innerHTML.includes('<svg onload=alert(1)>'), false);
assert.equal(unsafeMain.innerHTML.includes('<option selected>unsafe</option>'), false);
assert.equal(unsafeInspector.innerHTML.includes('<img src=x onerror=alert(1)>'), false);
assert.doesNotThrow(() => parseFollowUpAt(""));
assert.equal(parseFollowUpAt(""), null);
assert.equal(parseFollowUpAt("2026-07-30T10:00:00.000Z"), "2026-07-30T10:00:00.000Z");
unsafeState.tasks.push({ id: "task-no-time", title: "历史跟进计划", priority: "中", module: "private-domain", relatedId: unsafeCustomer.id, done: false });
renderPrivateDomainView(unsafeState, unsafeMain, unsafeInspector);
assert.equal(unsafeInspector.innerHTML.includes("历史跟进计划"), true);
assert.equal(unsafeInspector.innerHTML.includes("未记录时间"), true);
const fallbackTimelineState: DemoState = {
  ...unsafeState,
  activities: [],
  tasks: [{ id: "task-invalid-due", title: "回退创建时间", priority: "中", module: "private-domain", relatedId: unsafeCustomer.id, done: false, dueAt: "invalid-date", createdAt: "2026-07-29T09:00:00.000Z" }]
};
renderPrivateDomainView(fallbackTimelineState, unsafeMain, unsafeInspector);
assert.equal(unsafeInspector.innerHTML.includes("回退创建时间"), true);
assert.equal(unsafeInspector.innerHTML.includes("未记录时间"), false);
const overflowTimelineState: DemoState = {
  ...unsafeState,
  activities: [],
  tasks: [{ id: "task-overflow-due", title: "拒绝溢出时间", priority: "中", module: "private-domain", relatedId: unsafeCustomer.id, done: false, dueAt: "2026-02-30T10:00:00.000Z" }]
};
renderPrivateDomainView(overflowTimelineState, unsafeMain, unsafeInspector);
assert.equal(unsafeInspector.innerHTML.includes("拒绝溢出时间"), true);
assert.equal(unsafeInspector.innerHTML.includes("未记录时间"), true);

const conversationId = initial.conversations[0].id;
store.selectConversation(conversationId);
store.sendMessage(conversationId, "演示消息");
const afterSend = store.getState().conversations.find((item) => item.id === conversationId);
assert.equal(afterSend?.unread, 0);
assert.equal(afterSend?.messages.at(-1)?.sender, "operator");

store.setConversationMode(conversationId, "paused");
assert.equal(store.getState().conversations.find((item) => item.id === conversationId)?.mode, "paused");

store.setConversationMode(conversationId, "agent");
store.sendAgentReply(conversationId);
assert.equal(store.getState().conversations.find((item) => item.id === conversationId)?.messages.at(-1)?.sender, "agent");

store.sendMessage(conversationId, "请问您预计什么时候采购？");
assert.equal(store.getState().conversations[0].messages.at(-1)?.body, "请问您预计什么时候采购？");

store.setConversationMode(conversationId, "manual");
assert.equal(store.getState().conversations[0].mode, "manual");
store.addConversationTag(conversationId, "已确认面积");
assert.equal(store.getState().conversations[0].tags.includes("已确认面积"), true);

const customerId = store.transferConversationToPrivate(conversationId);
assert.equal(store.getState().customers.some((item) => item.id === customerId), true);
assert.equal(store.transferConversationToPrivate(conversationId), customerId);

store.selectCustomer(customerId);
store.addCustomerTag(customerId, "预算明确");
store.updateCustomer(customerId, {
  group: "重点客户",
  nextFollowUpAt: "2026-07-30T10:00:00.000Z"
});
const beforeInvalidFollowUpTasks = store.getState().tasks.length;
const beforeInvalidFollowUpActivities = store.getState().activities.length;
let invalidFollowUpNotifications = 0;
const unsubscribeInvalidFollowUps = store.subscribe(() => {
  invalidFollowUpNotifications += 1;
});
store.createFollowUp(customerId, "不应创建：空时间", "");
store.createFollowUp(customerId, "不应创建：非法时间", "not-a-date");
for (const invalidDueAt of [
  "2026-02-30T10:00:00.000Z",
  "2025-02-29T10:00:00.000Z",
  "2026-13-01T10:00:00.000Z",
  "2026-01-32T10:00:00.000Z"
]) {
  store.createFollowUp(customerId, `不应创建：${invalidDueAt}`, invalidDueAt);
}
unsubscribeInvalidFollowUps();
assert.equal(store.getState().tasks.length, beforeInvalidFollowUpTasks);
assert.equal(store.getState().activities.length, beforeInvalidFollowUpActivities);
assert.equal(invalidFollowUpNotifications, 0);
store.createFollowUp(customerId, "确认闰年日期", "2028-02-29T18:00:00.000+08:00");
store.createFollowUp(customerId, "发送案例与报价范围", "2026-07-30T18:00:00.000+08:00");
store.createFollowUp(customerId, "确认预算与决策人", "2026-08-01T10:00:00.000Z");
const updatedCustomer = store.getState().customers.find((item) => item.id === customerId);
assert.equal(updatedCustomer?.tags.includes("预算明确"), true);
assert.equal(updatedCustomer?.group, "重点客户");
assert.equal(store.getState().tasks.some((item) => item.relatedId === customerId), true);
const followUpTasks = store.getState().tasks.filter((item) => item.relatedId === customerId && item.id.startsWith("task-follow-up-"));
assert.deepEqual(followUpTasks.map((item) => item.dueAt), ["2028-02-29T10:00:00.000Z", "2026-07-30T10:00:00.000Z", "2026-08-01T10:00:00.000Z"]);
assert.deepEqual(followUpTasks.map((item) => item.createdAt), ["2026-07-29T09:00:00.000Z", "2026-07-29T09:00:00.000Z", "2026-07-29T09:00:00.000Z"]);
renderPrivateDomainView(store.getState(), unsafeMain, unsafeInspector);
const timelineMarkup = unsafeInspector.innerHTML.slice(unsafeInspector.innerHTML.indexOf("跟进时间线"));
assert.equal(timelineMarkup.indexOf("确认预算与决策人") < timelineMarkup.indexOf("发送案例与报价范围"), true);

store.simulateOutreach(["customer-wechat-zhou"]);
const contactedCustomer = store.getState().customers.find((item) => item.id === "customer-wechat-zhou");
assert.equal(contactedCustomer?.group, "待跟进");
assert.equal(store.getState().activities.at(-1)?.title, "执行批量触达");

const opportunityId = store.createOpportunity(customerId, {
  title: "办公空间设计合作",
  amount: 86000
});
store.updateOpportunity(opportunityId, { amount: 96000 });
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.amount, 96000);
assert.deepEqual(getConversionMetrics(store.getState()), {
  totalCount: 4,
  totalAmount: 472000,
  expectedAmount: 292800,
  pendingQuoteCount: 2,
  wonCount: 0,
  receivableAmount: 0
});
const invalidAmountBeforeActivities = store.getState().activities.length;
let invalidAmountNotifications = 0;
const unsubscribeInvalidAmounts = store.subscribe(() => {
  invalidAmountNotifications += 1;
});
for (const invalidAmount of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  store.updateOpportunity(opportunityId, { amount: invalidAmount });
}
unsubscribeInvalidAmounts();
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.amount, 96000);
assert.equal(store.getState().activities.length, invalidAmountBeforeActivities);
assert.equal(invalidAmountNotifications, 0);
store.selectOpportunity(opportunityId);
store.moveOpportunity(opportunityId, "negotiating");
store.createQuote(opportunityId, 81800);
let conversionOpportunity = store.getState().opportunities.find((item) => item.id === opportunityId);
assert.equal(conversionOpportunity?.stage, "negotiating");
assert.equal(conversionOpportunity?.quoteAmount, 81800);
store.createQuote(opportunityId, 0);
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.quoteAmount, 81800);

store.closeOpportunity(opportunityId, "lost", "不明确原因");
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.stage, "negotiating");
store.closeOpportunity(opportunityId, "lost", "预算延期");
conversionOpportunity = store.getState().opportunities.find((item) => item.id === opportunityId);
assert.equal(conversionOpportunity?.stage, "lost");
assert.equal(conversionOpportunity?.lossReason, "预算延期");

const unsafeConversionState = JSON.parse(JSON.stringify(initial)) as DemoState;
unsafeConversionState.opportunities[0].title = '"><img src=x onerror=alert(1)>';
unsafeConversionState.opportunities[0].nextAction = '<svg onload=alert(1)>';
const unsafeConversionMain = { innerHTML: "" } as HTMLElement;
const unsafeConversionInspector = { innerHTML: "" } as HTMLElement;
renderConversionView(unsafeConversionState, unsafeConversionMain, unsafeConversionInspector);
assert.equal(unsafeConversionMain.innerHTML.includes("商机总数"), true);
assert.equal(unsafeConversionMain.innerHTML.includes("预计成交"), true);
assert.equal(unsafeConversionMain.innerHTML.includes("待回款"), true);
assert.equal(unsafeConversionMain.innerHTML.includes('"><img src=x onerror=alert(1)>'), false);
assert.equal(unsafeConversionInspector.innerHTML.includes("创建报价"), true);
assert.equal(unsafeConversionInspector.innerHTML.includes("下一步行动"), true);

store.moveOpportunity(opportunityId, "quoted");
store.createQuote(opportunityId, 82000);
store.markQuoteSent(opportunityId);
store.updateOpportunity(opportunityId, {
  probability: 85,
  nextAction: "确认合同细节"
});
store.closeOpportunity(opportunityId, "won");
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.stage, "won");
assert.equal(store.getState().opportunities.find((item) => item.id === opportunityId)?.quoteSentAt, "2026-07-29T09:00:00.000Z");

store.toggleAgent("社媒沟通智能体");
store.toggleScript("抖音");
assert.equal(store.getState().demoSettings.agents["社媒沟通智能体"], false);
assert.equal(store.getState().demoSettings.scripts["抖音"], false);

store.simulateOutreach(["customer-wechat-zhou"]);
assert.equal(
  store.getState().conversations.find((item) => item.id === "conversation-wechat-li")?.messages.at(-1)?.sender,
  "agent"
);

const malformedStorage = {
  getItem: () => '{"version":1}',
  setItem: () => undefined,
  removeItem: () => undefined
};
const repaired = createDemoStore({ storage: malformedStorage, now: () => "2026-07-29T10:00:00.000Z" });
assert.equal(repaired.getState().conversations.length >= 5, true);
assert.equal(repaired.getState().customers.length >= 4, true);

const invalidTaskStorage = {
  getItem: () => JSON.stringify({ ...initial, tasks: [{ ...initial.tasks[0], dueAt: 123 }] }),
  setItem: () => undefined,
  removeItem: () => undefined
};
const repairedTaskState = createDemoStore({ storage: invalidTaskStorage, now: () => "2026-07-29T10:00:00.000Z" });
assert.equal(repairedTaskState.getState().tasks[0]?.dueAt, undefined);

const reloaded = createDemoStore({ storage, now: () => "2026-07-29T10:00:00.000Z" });
assert.equal(reloaded.getState().opportunities.some((item) => item.id === opportunityId), true);

reloaded.reset();
assert.equal(reloaded.getState().opportunities.some((item) => item.id === opportunityId), false);
assert.equal(reloaded.getState().activities.length, 9);
assert.equal(reloaded.getState().activities.at(-1)?.title, "重置演示数据");
const resetState = reloaded.getState();
assert.equal(resetState.version, 1);
assert.equal(resetState.conversations[0].id, "conversation-douyin-lin");
assert.equal(memory.has("goodjob.frontend-demo.v1"), true);
