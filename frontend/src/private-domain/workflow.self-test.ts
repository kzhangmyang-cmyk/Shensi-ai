import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createPrivateDomainController } from "./controller";
import { createPrivateDomainRuntimeApi, type PrivateDomainCustomer, type PrivateDomainTodo } from "./runtime-api";

const { document, window } = parseHTML("<main></main><aside></aside>");
const main = document.querySelector<HTMLElement>("main")!;
const inspector = document.querySelector<HTMLElement>("aside")!;
const events = new EventTarget();
const customers: PrivateDomainCustomer[] = [];
const todos: PrivateDomainTodo[] = [];
const writes: Array<{ path: string; body: Record<string, string> }> = [];
let releaseWrite: (() => void) | undefined;
let writeGate: Promise<void> | undefined;
let failure = "";
let readGate: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
const api = createPrivateDomainRuntimeApi(async (input, init) => {
  const path = String(input);
  if (init?.method === "GET") {
    if (readGate) await readGate;
    if (path === "/api/customers?scope=mine") return Response.json({ customers });
    if (path === "/api/todos") return Response.json({ todos });
    throw new Error(`Unexpected read ${path}`);
  }
  assert.equal(init?.method, "POST");
  assert.equal(init?.credentials, "same-origin");
  assert.equal(new Headers(init?.headers).get("x-csrf-token"), "isolated/csrf");
  const body = JSON.parse(String(init?.body));
  writes.push({ path, body });
  if (writeGate) await writeGate;
  if (failure) return Response.json({ message: failure }, { status: 409 });
  if (path === "/api/customers") {
    const customer: PrivateDomainCustomer = { id: `customer-${customers.length + 1}`, company: body.company, country: body.country, contact: body.contact,
      ownerId: "owner", teamId: "team", ownerName: "测试负责人", stage: body.stage, grade: body.grade,
      amount: 0, health: 72, nextReminder: "", wecomBound: false, activities: [] };
    customers.unshift(customer);
    return Response.json({ customer });
  }
  if (path === "/api/customers/customer-1/activities") {
    customers.find((customer) => customer.id === "customer-1")!.activities.unshift({ id: "activity-1", customerId: "customer-1", type: body.type,
      content: body.content, nextReminder: body.nextReminder, operatorId: "owner", createdAt: "2026-09-10T10:00:00Z" });
    return Response.json({ customer: customers.find((customer) => customer.id === "customer-1") });
  }
  if (path === "/api/todos") {
    const todo: PrivateDomainTodo = { id: "todo-1", title: body.title, customerId: body.customerId, type: body.type, priority: body.priority,
      ownerId: "owner", teamId: "team", related: body.related, done: false, status: "pending", dueAt: body.dueAt };
    todos.push(todo); return Response.json({ todo });
  }
  if (path === "/api/todos/todo-1/complete") {
    todos[0]!.done = true; return Response.json({ todo: todos[0] });
  }
  throw new Error(`Unexpected write ${path}`);
}, () => "gj_csrf=isolated%2Fcsrf");
const controller = createPrivateDomainController({ main, inspector, eventTarget: events, api });
const field = (name: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`[data-private-domain-form] [name=${name}]`);
  assert.ok(input, `form field ${name} is available`); input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const click = (action: string) => {
  const button = document.querySelector<HTMLButtonElement>(`[data-private-domain-action=${action}]`);
  assert.ok(button, `${action} is available`);
  button.dispatchEvent(new window.Event("click", { bubbles: true }));
};
const submit = () => {
  const form = document.querySelector<HTMLFormElement>("[data-private-domain-form]");
  assert.ok(form);
  const event = new window.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
};
await controller.open();
events.dispatchEvent(new Event("goodjob:customer-create-requested"));
assert.ok(main.querySelector("[data-private-domain-form=customer]"), "the real shell action opens the customer form");
field("company", "  隔离客户  "); field("contact", "王先生"); field("country", "中国");
writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
submit(); submit();
assert.equal(writes.length, 1, "duplicate submission is single-flight");
events.dispatchEvent(new Event("goodjob:customer-create-requested"));
assert.equal(document.querySelector<HTMLButtonElement>("[type=submit]")?.disabled, true);
releaseWrite!(); writeGate = undefined;
await controller.whenIdle();
assert.equal(writes[0]?.body.company, "隔离客户");
assert.equal(controller.getState().selectedCustomerId, "customer-1");
assert.match(inspector.textContent!, /隔离客户/);
assert.equal(main.querySelector("[data-private-domain-form]"), null);
click("record-activity"); field("content", "电话确认了需求"); submit(); await controller.whenIdle();
assert.match(inspector.textContent!, /电话确认了需求/);
click("create-todo"); field("title", "下次确认预算"); field("dueAt", "2099-10-01T10:00"); submit(); await controller.whenIdle();
assert.equal(writes.at(-1)?.body.customerId, "customer-1");
assert.match(inspector.textContent!, /下次确认预算/);
click("complete-todo"); field("completionResult", "已经确认预算"); submit(); await controller.whenIdle();
assert.equal(writes.at(-1)?.body.completionResult, "已经确认预算");
assert.match(inspector.textContent!, /已完成/);
assert.equal(inspector.querySelector("[data-private-domain-action=complete-todo]"), null);

events.dispatchEvent(new Event("goodjob:customer-create-requested"));
field("company", "错误保留客户"); failure = "当前客户不可写入"; submit(); await controller.whenIdle();
assert.match(main.textContent!, /当前客户不可写入/);
assert.equal(main.querySelector<HTMLInputElement>("[name=company]")?.value, "错误保留客户");
failure = "";
click("cancel-editor");
events.dispatchEvent(new Event("goodjob:customer-create-requested"));
field("company", "迟到客户");
writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
submit();
controller.deactivate();
main.innerHTML = "另一个页面";
releaseWrite!(); writeGate = undefined;
await controller.whenIdle();
assert.equal(main.innerHTML, "另一个页面", "late writes cannot replace the next route");
await controller.open("customer-1");
click("record-activity"); field("content", "迟到活动");
writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
submit(); controller.selectCustomer("customer-2");
releaseWrite!(); writeGate = undefined;
await controller.whenIdle();
assert.equal(controller.getState().selectedCustomerId, "customer-2", "late activity completion must not reselect the old customer");
assert.doesNotMatch(inspector.textContent!, /迟到活动/);
controller.selectCustomer("customer-1");
click("record-activity"); field("content", "刷新期间仍可切客户");
readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
submit();
await new Promise((resolve) => setTimeout(resolve, 0));
controller.selectCustomer("customer-2");
releaseRead!(); readGate = undefined;
await controller.whenIdle();
assert.equal(controller.getState().selectedCustomerId, "customer-2", "post-save refresh cannot overwrite a newer selection");
controller.destroy();
console.log("Private-domain real workflow self-test passed");
