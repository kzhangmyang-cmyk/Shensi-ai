import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SHENSI_SKIP_LOCAL_ENV = "true";
process.env.CRM_STORE = "memory";
process.env.JWT_SECRET = "crm-workflow-isolated-test-secret-at-least-32-characters";
const { app } = await import("./server.js");
const { createMemoryStore, setStore } = await import("./store.js");

test("customer follow-up todo routes preserve binding, ownership and rejected state", async (t) => {
  const store = createMemoryStore({ customers: [], customerActivities: [], todos: [] });
  assert.equal(store.mode, "memory");
  setStore(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function request(path: string, method = "GET", body?: unknown, token?: string) {
    const response = await fetch(origin + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  async function login(email: string) {
    const response = await request("/api/auth/login", "POST", { email, password: "goodjob123" });
    assert.equal(response.status, 200);
    return response.body.token as string;
  }
  const owner = await login("shirley@goodjob.com");
  const other = await login("mia@goodjob.com");
  const manager = await login("alex@goodjob.com");
  const created = await request("/api/customers", "POST", { company: "隔离测试客户", country: "中国", contact: "测试联系人" }, owner);
  assert.equal(created.status, 200);
  const customer = created.body.customer;
  const activity = await request(`/api/customers/${customer.id}/activities`, "POST", { type: "note", content: "已核对需求", nextReminder: "2099-10-01T10:00" }, owner);
  assert.equal(activity.status, 200);
  assert.equal(activity.body.customer.activities[0].content, "已核对需求");

  await t.test("new customer todo retains the exact customer ID and completes through the real route", async () => {
    const result = await request("/api/todos", "POST", { title: "核对报价", type: "customer", customerId: customer.id, related: customer.company }, owner);
    assert.equal(result.status, 200);
    assert.equal(result.body.todo.customerId, customer.id);
    const complete = await request(`/api/todos/${result.body.todo.id}/complete`, "POST", { completionResult: "已完成核对" }, owner);
    assert.equal(complete.status, 200);
    assert.equal(complete.body.todo.done, true);
    assert.equal(complete.body.todo.completionResult, "已完成核对");
  });
  await t.test("customer binding obeys owner, team and public-pool visibility", async () => {
    const crossTeam = { ...store.customers[0]!, id: "cross-team-customer", teamId: "unrelated-team", ownerId: "unrelated-owner" };
    const publicCustomer = { ...store.customers[0]!, id: "public-customer", ownerId: "", poolStatus: "public" as const };
    store.customers.push(crossTeam, publicCustomer);
    const before = store.todos.length;
    for (const [token, customerId, status] of [[other, customer.id, 404], [owner, crossTeam.id, 404], [owner, publicCustomer.id, 409], [owner, "missing", 404]] as const) {
      const result = await request("/api/todos", "POST", { title: "不应写入", type: "customer", customerId }, token);
      assert.equal(result.status, status);
      assert.equal(store.todos.length, before);
    }
    const allowed = await request("/api/todos", "POST", { title: "主管跟进", type: "customer", customerId: customer.id }, manager);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.todo.customerId, customer.id);
    assert.notEqual(allowed.body.todo.ownerId, customer.ownerId);
  });
  await t.test("cancelled todos cannot be completed", async () => {
    const result = await request("/api/todos", "POST", { title: "已取消事项" }, owner);
    const todo = store.todos.find((item) => item.id === result.body.todo.id)!;
    todo.cancelledAt = "2026-09-01T00:00:00.000Z";
    todo.cancellationReason = "客户交接已撤销";
    const before = structuredClone(todo);
    assert.equal((await request(`/api/todos/${todo.id}/complete`, "POST", {}, owner)).status, 409);
    assert.deepEqual(todo, before);
    assert.equal((await request(`/api/todos/${todo.id}`, "PATCH", { done: true }, owner)).status, 409);
    assert.deepEqual(todo, before);
  });
  await t.test("rejected reminder postponement leaves all todo fields unchanged", async () => {
    const result = await request("/api/todos", "POST", { title: "保持原内容", dueAt: "2099-10-01T10:00" }, owner);
    const todo = store.todos.find((item) => item.id === result.body.todo.id)!;
    todo.reminderRuleId = "isolated-reminder";
    const before = structuredClone(todo);
    const rejected = await request(`/api/todos/${todo.id}`, "PATCH", { title: "不应写入", done: true, completionResult: "结果", dueAt: "2099-10-02T10:00" }, owner);
    assert.equal(rejected.status, 400);
    assert.deepEqual(todo, before);
  });
});
