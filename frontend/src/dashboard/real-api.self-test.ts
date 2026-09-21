import { strict as assert } from "node:assert";
import { DashboardRequestError, createRealDashboardApi } from "./real-api";

{
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const api = createRealDashboardApi(async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ scope: "本人业务" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const result = await api.load();
  assert.equal(result.scope, "本人业务");
  assert.deepEqual(calls, [{
    input: "/api/dashboard/summary?period=3m",
    init: {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: undefined
    }
  }]);
}

{
  const api = createRealDashboardApi(async () => new Response(
    JSON.stringify({ code: "dashboard_unavailable" }),
    { status: 503, headers: { "content-type": "application/json" } }
  ));
  await assert.rejects(api.load(), /dashboard_unavailable/u);
}

{
  const api = createRealDashboardApi(async () => new Response(
    JSON.stringify({ code: "unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } }
  ));
  await assert.rejects(api.load(), (error: unknown) => {
    assert.ok(error instanceof DashboardRequestError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthorized");
    return true;
  });
}
