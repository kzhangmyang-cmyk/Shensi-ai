import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createDouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";

const serviceSecret = "mediacrawler-test-secret-that-is-at-least-32-bytes";
const validHealth = {
  ok: true,
  service: "shensi-mediacrawler",
  upstream_commit: "d6f7c5bb906b6dac40ddf343ef9e26438a3de092",
};

async function withServer(
  handler: Parameters<typeof createServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health sends the service bearer authorization", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/internal/v1/health");
    assert.equal(request.headers.authorization, `Bearer ${serviceSecret}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(validHealth));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.health(), {
      ok: true,
      service: "shensi-mediacrawler",
      upstreamCommit: "d6f7c5bb906b6dac40ddf343ef9e26438a3de092",
    });
  });
});

test("health rejects extra response fields", async () => {
  await withServer((_request, response) => {
    response.end(JSON.stringify({ ...validHealth, leaked: true }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.health(), { code: "mediacrawler_invalid_response" });
  });
});

test("health rejects a response larger than 64 KiB", async () => {
  await withServer((_request, response) => {
    response.end("x".repeat(64 * 1024 + 1));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.health(), { code: "mediacrawler_invalid_response" });
  });
});

test("health maps timeouts to mediacrawler_unavailable without exposing the secret", async () => {
  await withServer((_request, _response) => {}, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret, timeoutMs: 10 });
    await assert.rejects(gateway.health(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "mediacrawler_unavailable");
      assert.equal(String(error).includes(serviceSecret), false);
      return true;
    });
  });
});
