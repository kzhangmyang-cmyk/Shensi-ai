import { strict as assert } from "node:assert";
import { GrowthApiError, createGrowthHttpClient } from "./http";

let requests: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}> = [];

const fetchImpl = async (url: string, init?: RequestInit) => {
  requests.push({
    url,
    method: String(init?.method ?? "GET"),
    headers: init?.headers as Record<string, string>,
    body: typeof init?.body === "string" ? init.body : undefined
  });
  if (url.includes("today")) {
    return new Response(
      JSON.stringify({ code: "invalid_as_of", requestId: "req-1" }),
      { status: 422, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { etag: "\"v:1\"" } }
  );
};

const client = createGrowthHttpClient({
  fetchImpl,
  csrf: () => "csrf-token",
  workspaceId: () => "workspace-a"
});

await client.request("/api/v1/growth/bootstrap");
assert.equal(requests[0]?.method, "GET");
assert.equal(requests[0]?.headers["x-csrf-token"], undefined);
assert.equal(requests[0]?.headers["X-Workspace-Id"], "workspace-a");

await client.request("/api/v1/acquisition/advisor/recommendations/r/accept", {
  method: "POST",
  body: { reason: null },
  idempotencyKey: "key-1",
  ifMatch: "\"advisor-recommendation-v:1\""
});
assert.equal(requests[1]?.headers["x-csrf-token"], "csrf-token");
assert.equal(requests[1]?.headers["Idempotency-Key"], "key-1");
assert.equal(requests[1]?.headers["If-Match"], "\"advisor-recommendation-v:1\"");
assert.equal(requests[1]?.body, JSON.stringify({ reason: null }));

await client.request("/api/v1/finance/council-policy", {
  method: "PUT",
  body: { currency: "CNY" },
  idempotencyKey: "policy-key-1",
  ifMatch: '"financial-council-policy:ws-1:1"'
});
assert.equal(requests[2]?.method, "PUT");
assert.equal(requests[2]?.headers["x-csrf-token"], "csrf-token");
assert.equal(requests[2]?.headers["If-Match"], '"financial-council-policy:ws-1:1"');

await assert.rejects(
  client.request("/api/v1/acquisition/advisor/today?asOf=future"),
  (error: unknown) => error instanceof GrowthApiError
    && error.status === 422
    && error.code === "invalid_as_of"
    && error.requestId === "req-1"
);

const events: unknown[] = [];
const streamClient = createGrowthHttpClient({ csrf: () => 'test-csrf', workspaceId: () => 'ws-stream',
  fetchImpl: async (_url, init) => {
    assert.equal((init?.headers as any).Accept, 'application/x-ndjson');
    assert.equal((init?.headers as any)['x-csrf-token'], 'test-csrf');
    assert.equal((init?.headers as any)['X-Workspace-Id'], 'ws-stream');
    const bytes = new TextEncoder().encode('{"type":"stage","stage":"model_started"}\n{"type":"result","result":{"answer":"已完成"}}\n');
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
    } }), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
assert.deepEqual((await streamClient.request('/stream', { method: 'POST', onProgress: event => events.push(event) })).body, { answer: '已完成' });
assert.deepEqual(events, [{ type: 'stage', stage: 'model_started' }]);
for (const body of ['{"type":"stage","stage":"model_started"}\n', '{"type":"error","status":409,"code":"cfo_session_revision_conflict"}\n']) {
  const broken = createGrowthHttpClient({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }) });
  await assert.rejects(broken.request('/stream', { onProgress() {} }));
}
