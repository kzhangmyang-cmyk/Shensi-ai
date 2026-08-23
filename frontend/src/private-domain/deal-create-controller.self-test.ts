import { strict as assert } from "node:assert";
import {
  createAuthoritativeDealCreateApi,
  type AuthoritativeDealCreateInput
} from "./deal-create-controller";

const customer = {
  id: "customer-deal-test",
  company: "测试客户",
  country: "中国",
  contact: "王总",
  ownerId: "owner-1",
  teamId: "team-1",
  stage: "待首次跟进",
  amount: 18_000,
  health: 80,
  nextReminder: "2026-08-25T08:00:00.000Z",
  wecomBound: false,
  activities: [],
  acquisitionBindings: [{
    handoffId: "handoff-1",
    leadId: "lead-1",
    candidateId: "candidate-1",
    createdAt: "2026-08-23T08:00:00.000Z"
  }]
};

const input: AuthoritativeDealCreateInput = {
  title: "测试商机",
  customerId: customer.id,
  product: "测试产品",
  quantity: 30,
  unitPrice: 600,
  amount: 18_000,
  currency: "USD",
  nextAction: "确认采购清单并安排报价",
  nextActionAt: "2026-08-25",
  expectedCloseAt: "2026-09-13",
  acquisitionBinding: { handoffId: "handoff-1", leadId: "lead-1" }
};

{
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const api = createAuthoritativeDealCreateApi({
    cookieSource: () => "session=1; gj_csrf=csrf%2Fdeal",
    fetchImpl: async (path, init = {}) => {
      requests.push({ path: String(path), init });
      return String(path).startsWith("/api/customers")
        ? new Response(JSON.stringify({ customers: [customer] }), { status: 200 })
        : new Response(JSON.stringify({ deal: { id: "deal-1" } }), { status: 201 });
    }
  });

  assert.equal((await api.getCustomer(customer.id))?.id, customer.id);
  assert.equal((await api.createDeal(input)).deal.id, "deal-1");
  assert.equal(requests[0]?.path, "/api/customers?scope=mine");
  assert.equal(requests[0]?.init.credentials, "same-origin");
  assert.equal(new Headers(requests[0]?.init.headers).get("x-csrf-token"), null);
  assert.equal(requests[1]?.path, "/api/deals");
  assert.equal(requests[1]?.init.credentials, "same-origin");
  assert.equal(
    new Headers(requests[1]?.init.headers).get("x-csrf-token"),
    "csrf/deal"
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), input);
}

{
  let unauthorized = 0;
  const api = createAuthoritativeDealCreateApi({
    cookieSource: () => "",
    onUnauthorized: () => {
      unauthorized += 1;
    },
    fetchImpl: async () => new Response(
      JSON.stringify({ message: "登录已失效" }),
      { status: 401 }
    )
  });

  await assert.rejects(api.getCustomer(customer.id), /登录已失效/u);
  assert.equal(unauthorized, 1);
}
