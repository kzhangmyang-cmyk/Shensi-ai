import { strict as assert } from "node:assert";
import {
  createPrivateDomainRuntimeApi,
  pendingAcquisitionBindings
} from "./runtime-api";

assert.deepEqual(pendingAcquisitionBindings({
  acquisitionBindings: [{
    handoffId: "handoff-1",
    leadId: "lead-1",
    candidateId: "candidate-1",
    createdAt: "2026-08-07T08:00:00.000Z"
  }, {
    handoffId: " ",
    leadId: "lead-invalid",
    candidateId: "candidate-invalid",
    createdAt: "2026-08-07T08:00:00.000Z"
  }]
}), [{
  handoffId: "handoff-1",
  leadId: "lead-1",
  candidateId: "candidate-1",
  createdAt: "2026-08-07T08:00:00.000Z"
}]);

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const api = createPrivateDomainRuntimeApi(async (input, init) => {
  calls.push({ input, init });
  if (String(input).startsWith("/api/customers")) {
    return Response.json({
      customers: [{
        id: "customer-1",
        company: "真实客户",
        country: "中国",
        contact: "王总",
        ownerId: "owner-1",
        teamId: "team-1",
        stage: "待首次跟进",
        amount: 12_880,
        health: 80,
        grade: "A",
        nextReminder: "2026-08-08T09:00:00.000Z",
        wecomBound: false,
        activities: [{
          id: "activity-1",
          customerId: "customer-1",
          type: "note",
          content: "获客候选已交接",
          operatorId: "owner-1",
          operatorName: "王业务",
          nextReminder: "2026-08-08T09:00:00.000Z",
          createdAt: "2026-08-07T08:00:00.000Z"
        }]
      }]
    });
  }
  return Response.json({
    todos: [{
      id: "todo-1",
      title: "首次跟进：确认需求和预算",
      type: "customer",
      priority: "high",
      status: "pending",
      dueAt: "2026-08-08T09:00:00.000Z",
      ownerId: "owner-1",
      teamId: "team-1",
      related: "真实客户",
      done: false,
      customerId: "customer-1",
      leadId: "lead-1"
    }]
  });
});

const [customers, todos] = await Promise.all([
  api.getCustomers(),
  api.getTodos()
]);
assert.equal(customers[0]?.activities[0]?.id, "activity-1");
assert.equal(todos[0]?.customerId, "customer-1");
assert.deepEqual(calls.map((call) => call.input), [
  "/api/customers?scope=mine",
  "/api/todos"
]);
for (const call of calls) {
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.credentials, "same-origin");
  assert.equal(new Headers(call.init?.headers).get("accept"), "application/json");
}

const failing = createPrivateDomainRuntimeApi(async () => Response.json({
  message: "真实客户读取失败"
}, { status: 503 }));
await assert.rejects(
  () => failing.getCustomers(),
  /真实客户读取失败/
);
