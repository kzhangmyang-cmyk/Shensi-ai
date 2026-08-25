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

test("login creation allows interactive browser startup beyond the general timeout", async () => {
  await withServer((_request, response) => {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        session_id: "login-1",
        state: "awaiting_scan",
        qr_image_data_url: "data:image/png;base64,cXI=",
        expires_at: "2026-08-25T05:30:00.000Z",
        account_handle: null,
        account_display_name: null,
        login_state_version: null,
      }));
    }, 25);
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl,
      serviceSecret,
      timeoutMs: 5,
    });
    assert.equal((await gateway.createLoginSession()).state, "awaiting_scan");
  });
});

test("gateway rejects a secret with fewer than 32 non-whitespace bytes", () => {
  assert.throws(
    () => createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret: "a" + " ".repeat(64) + "b",
    }),
    { code: "mediacrawler_unavailable" },
  );
});

test("health honors an already-aborted caller signal before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const gateway = createDouyinMediaCrawlerGateway({
    baseUrl: "http://127.0.0.1:8000",
    serviceSecret,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(validHealth));
    },
  });

  await assert.rejects(gateway.health(controller.signal), { code: "mediacrawler_unavailable" });
  assert.equal(fetchCalls, 0);
});

test("gateway accepts bracketed IPv6 loopback and private addresses", () => {
  for (const baseUrl of ["http://[::1]:8000", "http://[fc00::1]:8000", "http://[fe80::1]:8000"]) {
    assert.doesNotThrow(() => createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret }));
  }
});

test("gateway acknowledges persisted pages and returns the server timestamp", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/v1/douyin/crawl-jobs/job-1/acknowledgement");
    assert.equal(request.headers.authorization, `Bearer ${serviceSecret}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      job_id: "job-1",
      acknowledged_at: "2026-08-25T04:00:00.000Z"
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.acknowledgeCrawlJob("job-1"), {
      jobId: "job-1",
      acknowledgedAt: "2026-08-25T04:00:00.000Z"
    });
  });
});

test("gateway exposes progressive crawl counts and the bounded failure code", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      job_id: "job-live",
      state: "running",
      created_at: "2026-08-25T04:00:00.000Z",
      updated_at: "2026-08-25T04:00:01.000Z",
      completed_at: null,
      acknowledged_at: null,
      record_count: 25,
      page_count: 1,
      failure_code: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.getCrawlJob("job-live"), {
      jobId: "job-live",
      state: "running",
      recordCount: 25,
      pageCount: 1,
      failureCode: null,
    });
  });
});

test("gateway sends the exact frozen action and accepts only a bound sanitized receipt", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/v1/douyin/actions/action-1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        action_id: "action-1", account_handle: "private-handle",
        login_state_version: 3, kind: "comment",
        target_public_url: "https://www.douyin.com/video/video-1",
        content: "exact approved content", deadline_at: "2026-08-25T04:01:00.000Z",
        approved_content_hash: `sha256:${"a".repeat(64)}`
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ action_id: "action-1", state: "succeeded",
        platform_receipt_reference: "receipt-1", occurred_at: "2026-08-25T04:00:01.000Z",
        failure_code: null }));
    });
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.equal((await gateway.executeAction({ actionId: "action-1",
      accountHandle: "private-handle", loginStateVersion: 3, kind: "comment",
      targetPublicUrl: "https://www.douyin.com/video/video-1",
      content: "exact approved content", approvedContentHash: `sha256:${"a".repeat(64)}`,
      deadlineAt: "2026-08-25T04:01:00.000Z" })).platformReceiptReference, "receipt-1");
  });
});

test("gateway accepts a real-shaped commenter identity and rejects a root actor", async () => {
  for (const [profile, accepted] of [
    ["https://www.douyin.com/user/MS4wLjABCommenter", true],
    ["https://www.douyin.com/", false]
  ] as const) {
    await withServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        job_id: "job-1", cursor: null, next_cursor: null, done: true,
        records: [{
          record_id: "comment-1", kind: "comment", actor_kind: "commenter",
          canonical_url: "https://www.douyin.com/video/1",
          public_display_name: "Buyer", public_profile_url: profile,
          text_excerpt: "需要报价", source_keyword: "报价",
          observed_at: "2026-08-25T04:00:00.000Z",
          content_hash: `sha256:${"a".repeat(64)}`
        }]
      }));
    }, async (baseUrl) => {
      const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
      if (accepted) {
        assert.equal((await gateway.getCrawlResults("job-1", null)).records[0]?.actorKind, "commenter");
      } else {
        await assert.rejects(gateway.getCrawlResults("job-1", null), {
          code: "mediacrawler_invalid_response"
        });
      }
    });
  }
});
