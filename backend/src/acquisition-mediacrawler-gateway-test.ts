import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret, runtimeMode: "desktop" });
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

test("actions use an independent timeout while health and crawl stay bounded", async () => {
  await withServer((request, response) => {
    response.setHeader("connection", "close");
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/internal/v1/health") {
        response.end(JSON.stringify(validHealth));
      } else if (request.url === "/internal/v1/douyin/crawl-jobs/job-timeout") {
        response.end(JSON.stringify({
          job_id: "job-timeout", state: "running",
          created_at: "2026-08-25T04:00:00.000Z",
          updated_at: "2026-08-25T04:00:01.000Z",
          completed_at: null, acknowledged_at: null,
          record_count: 0, page_count: 0, failure_code: null,
          activity: {
            phase: "queued", current_keyword: null,
            browser_mode: "headless", sequence: 0
          }
        }));
      } else {
        assert.equal(request.url, "/internal/v1/douyin/actions/action-timeout");
        response.end(JSON.stringify({
          action_id: "action-timeout", state: "failed",
          platform_receipt_reference: null,
          occurred_at: "2026-08-25T04:00:01.000Z",
          failure_code: "douyin_verification_required"
        }));
      }
    }, 25);
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl, serviceSecret, timeoutMs: 5, actionTimeoutMs: 50
    });
    await assert.rejects(gateway.health(), { code: "mediacrawler_unavailable" });
    await assert.rejects(gateway.getCrawlJob("job-timeout"), {
      code: "mediacrawler_unavailable"
    });
    const receipt = await gateway.executeAction({
      actionId: "action-timeout", accountHandle: "private-handle",
      loginStateVersion: 3, kind: "comment",
      targetPublicUrl: "https://www.douyin.com/video/video-1",
      content: "exact approved content",
      approvedContentHash: `sha256:${"a".repeat(64)}`,
      deadlineAt: "2026-08-25T04:02:30.000Z"
    });
    assert.equal(receipt.failureCode, "douyin_verification_required");
  });
});

test("action reconciliation calls only the read-only sidecar route", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url,
      "/internal/v1/douyin/actions/action-reconcile/reconcile");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).action_id, "action-reconcile");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      action_id: "action-reconcile",
      state: "succeeded",
      platform_receipt_reference: "douyin-comment:reconciled-123",
      occurred_at: "2026-08-25T04:00:01.000Z",
      failure_code: null
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const receipt = await gateway.reconcileAction({
      actionId: "action-reconcile", accountHandle: "private-handle",
      loginStateVersion: 3, kind: "comment",
      targetPublicUrl: "https://www.douyin.com/video/video-1",
      content: "exact approved content",
      approvedContentHash: `sha256:${"a".repeat(64)}`,
      deadlineAt: "2026-08-25T04:02:30.000Z"
    });
    assert.equal(receipt.platformReceiptReference,
      "douyin-comment:reconciled-123");
  });
});

test("default action HTTP timeout preserves the ten-second result review window", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const previousManualWindow = process.env.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS;
  const observedTimeouts: number[] = [];
  delete process.env.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    observedTimeouts.push(delay ?? 0);
    queueMicrotask(callback);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      })) as typeof fetch
    });
    await assert.rejects(gateway.executeAction({
      actionId: "action-default-timeout", accountHandle: "private-handle",
      loginStateVersion: 3, kind: "comment",
      targetPublicUrl: "https://www.douyin.com/video/video-1",
      content: "exact approved content",
      approvedContentHash: `sha256:${"a".repeat(64)}`,
      deadlineAt: "2026-08-25T04:02:30.000Z"
    }), { code: "mediacrawler_unavailable" });
    assert.deepEqual(observedTimeouts, [175_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (previousManualWindow === undefined) {
      delete process.env.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS;
    } else {
      process.env.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS = previousManualWindow;
    }
  }
});

test("login creation accepts an explicit transport timeout override", async () => {
  await withServer((_request, response) => {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        session_id: "login-1",
        state: "awaiting_scan",
        qr_image_data_url: "data:image/png;base64,cXI=",
        qr_status: "ready",
        login_page: {
          image_data_url: "data:image/png;base64,cGFnZQ==",
          width: 1280,
          height: 720,
        },
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
      loginCreationTimeoutMs: 50,
    });
    assert.deepEqual((await gateway.createLoginSession()).loginPage, {
      imageDataUrl: "data:image/png;base64,cGFnZQ==",
      width: 1280,
      height: 720,
    });
  });
});

test("desktop login creation sends only a stable opaque account key and maps split runtime state", async () => {
  const accountKey = createHash("sha256")
    .update("douyin-profile:workspace-a", "utf8")
    .digest("hex");
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/v1/douyin/login-sessions");
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    assert.deepEqual(JSON.parse(rawBody), { account_key: accountKey });
    assert.equal(rawBody.includes("workspace-a"), false,
      "the raw workspace identifier must not cross the Sidecar boundary");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "desktop-login-1",
      state: "awaiting_scan",
      interaction_surface: "external_window",
      runtime_state: "running",
      auth_state: "waiting_for_user",
      task_state: "idle",
      diagnostic: {
        code: "waiting_for_user",
        message: "External browser is ready for manual login.",
        recoverable: true,
        occurred_at: "2026-09-02T08:00:00.000Z"
      },
      screenshot_available: false,
      qr_available: false,
      qr_image_data_url: null,
      qr_status: null,
      login_page: null,
      failure_code: null,
      expires_at: "2026-09-02T08:10:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const session = await gateway.createLoginSession({ accountKey });
    assert.deepEqual({
      interactionSurface: session.interactionSurface,
      runtimeState: session.runtimeState,
      authState: session.authState,
      taskState: session.taskState,
      diagnostic: session.diagnostic,
      screenshotAvailable: session.screenshotAvailable,
      qrAvailable: session.qrAvailable,
      qrImageDataUrl: session.qrImageDataUrl,
      loginPage: session.loginPage
    }, {
      interactionSurface: "external_window",
      runtimeState: "running",
      authState: "waiting_for_user",
      taskState: "idle",
      diagnostic: {
        code: "waiting_for_user",
        message: "External browser is ready for manual login.",
        recoverable: true,
        occurredAt: "2026-09-02T08:00:00.000Z"
      },
      screenshotAvailable: false,
      qrAvailable: false,
      qrImageDataUrl: null,
      loginPage: null
    });
  });
});

test("live login creation returns only a bounded public websocket token", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url,
      "/internal/v1/douyin/login-sessions/upstream%2Fsession/live-sessions");
    assert.equal(request.headers.authorization, `Bearer ${serviceSecret}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      token: "a".repeat(64),
      expires_at: "2026-09-01T00:05:00.000Z",
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.createLiveLoginSession("upstream/session"), {
      token: "a".repeat(64),
      expiresAt: "2026-09-01T00:05:00.000Z",
    });
  });
});

test("live login creation preserves a context-not-ready conflict", async () => {
  await withServer((_request, response) => {
    response.statusCode = 409;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      detail: "douyin_login_session_not_interactive",
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.createLiveLoginSession("starting-session"), {
      code: "douyin_login_session_not_ready",
    });
  });
});

test("live login creation does not treat another 409 as startup", async () => {
  await withServer((_request, response) => {
    response.statusCode = 409;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ detail: "another_conflict" }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.createLiveLoginSession("conflict-session"), {
      code: "mediacrawler_unavailable"
    });
  });
});

test("live login creation preserves an upstream-expired session", async () => {
  await withServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ detail: "login_session_not_found" }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.createLiveLoginSession("expired-session"), {
      code: "douyin_login_session_expired"
    });
  });
});

test("login creation maps a sidecar 500 to mediacrawler_unavailable", async () => {
  await withServer((_request, response) => {
    response.statusCode = 500;
    response.end();
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.createLoginSession(), (error: unknown) => {
      assert.equal((error as { name?: string }).name, "MediaCrawlerGatewayError");
      assert.equal(
        (error as { code?: string }).code,
        "mediacrawler_unavailable"
      );
      return true;
    });
  });
});

test("login lookup treats an exact sidecar not-found as an expired mapped session", async () => {
  await withServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ detail: "login_session_not_found" }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.getLoginSession("missing-login"), {
      code: "douyin_login_session_expired"
    });
  });
});

test("login sessions expose only an allowlisted sidecar failure code", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "failed-login",
      state: "failed",
      qr_image_data_url: null,
      qr_status: null,
      login_page: null,
      failure_code: "douyin_login_ui_unsupported",
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const session = await gateway.getLoginSession("failed-login");
    assert.equal(session.state, "failed");
    assert.equal(session.failureCode, "douyin_login_ui_unsupported");
  });
});

test("login sessions map the required closed QR status", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "ready-login",
      state: "awaiting_scan",
      qr_image_data_url: "data:image/png;base64,cXI=",
      qr_status: "ready",
      login_page: null,
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const session = await gateway.getLoginSession("ready-login");
    assert.equal(session.qrStatus, "ready");
  });
});

test("login sessions reject a missing QR status", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "legacy-login",
      state: "awaiting_scan",
      qr_image_data_url: null,
      login_page: null,
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.getLoginSession("legacy-login"), {
      code: "mediacrawler_invalid_response"
    });
  });
});

test("login sessions fail closed when the sidecar omits runtime ownership fields", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "desktop-runtime-unknown",
      state: "awaiting_scan",
      qr_image_data_url: null,
      qr_status: null,
      login_page: null,
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret, runtimeMode: "desktop" });
    await assert.rejects(gateway.getLoginSession("desktop-runtime-unknown"), {
      code: "mediacrawler_invalid_response"
    });
  });
});

test("login lookup rejects a response belonging to another session", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "other-session", state: "awaiting_scan", qr_image_data_url: null,
      qr_status: null, login_page: null, failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z", account_handle: null,
      account_display_name: null, login_state_version: null,
      interaction_surface: "external_window", runtime_state: "running",
      auth_state: "waiting_for_user", task_state: "idle", diagnostic: null,
      screenshot_available: false, qr_available: false
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret, runtimeMode: "desktop" });
    await assert.rejects(gateway.getLoginSession("requested-session"), {
      code: "mediacrawler_invalid_response"
    });
  });
});

test("login page frames larger than 64 KiB use a dedicated bounded response budget", async () => {
  const encodedFrame = "A".repeat(128 * 1024);
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "large-login-frame",
      state: "awaiting_scan",
      qr_image_data_url: null,
      qr_status: "opening",
      login_page: {
        image_data_url: `data:image/jpeg;base64,${encodedFrame}`,
        width: 1280,
        height: 800,
      },
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl,
      serviceSecret,
    });
    const session = await gateway.getLoginSession("large-login-frame");
    assert.equal(session.loginPage?.imageDataUrl.length,
      "data:image/jpeg;base64,".length + encodedFrame.length);
  });
});

test("login page frames still reject responses larger than 2 MiB", async () => {
  const encodedFrame = "A".repeat(2 * 1024 * 1024);
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "oversized-login-frame",
      state: "awaiting_scan",
      qr_image_data_url: null,
      qr_status: "opening",
      login_page: {
        image_data_url: `data:image/jpeg;base64,${encodedFrame}`,
        width: 1280,
        height: 800,
      },
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl,
      serviceSecret,
    });
    await assert.rejects(
      gateway.getLoginSession("oversized-login-frame"),
      { code: "mediacrawler_invalid_response" },
    );
  });
});

test("login sessions reject an arbitrary upstream failure code", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "failed-login",
      state: "failed",
      qr_image_data_url: null,
      qr_status: null,
      login_page: null,
      failure_code: "raw_playwright_exception",
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.getLoginSession("failed-login"), {
      code: "mediacrawler_invalid_response"
    });
  });
});

test("login interaction sends the exact upstream session and normalized click", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url,
      "/internal/v1/douyin/login-sessions/upstream%2Fsession/interactions");
    assert.equal(request.headers.authorization, `Bearer ${serviceSecret}`);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      type: "click",
      normalized_x: 0.25,
      normalized_y: 0.75,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "upstream/session",
      state: "awaiting_scan",
      qr_image_data_url: null,
      qr_status: "opening",
      login_page: {
        image_data_url: "data:image/png;base64,cGFnZQ==",
        width: 1280,
        height: 720,
      },
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const session = await gateway.interactLoginSession("upstream/session", {
      type: "click",
      normalizedX: 0.25,
      normalizedY: 0.75,
    });
    assert.equal(session.sessionId, "upstream/session");
    assert.equal(session.loginPage?.width, 1280);
  });
});

test("login interaction sends the semantic QR refresh command", async () => {
  await withServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { type: "refresh_qr" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      session_id: "refresh-session",
      state: "awaiting_scan",
      qr_image_data_url: "data:image/png;base64,bmV3",
      qr_status: "ready",
      login_page: null,
      failure_code: null,
      expires_at: "2026-08-25T05:30:00.000Z",
      account_handle: null,
      account_display_name: null,
      login_state_version: null,
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    const session = await gateway.interactLoginSession("refresh-session", {
      type: "refresh_qr"
    });
    assert.equal(session.qrStatus, "ready");
  });
});

test("default login creation timeout stays on the short transport budget", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedTimeouts: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    observedTimeouts.push(delay ?? 0);
    queueMicrotask(callback);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      })) as typeof fetch
    });
    await assert.rejects(gateway.createLoginSession(), {
      code: "mediacrawler_unavailable"
    });
    assert.deepEqual(observedTimeouts, [5_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("login polling has a dedicated browser-command timeout", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedTimeouts: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    observedTimeouts.push(delay ?? 0);
    queueMicrotask(callback);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      })) as typeof fetch
    });
    await assert.rejects(gateway.health(), {
      code: "mediacrawler_unavailable"
    });
    await assert.rejects(gateway.getLoginSession("polling-session"), {
      code: "mediacrawler_unavailable"
    });
    assert.deepEqual(observedTimeouts, [5_000, 70_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("login interactions keep the browser-command timeout instead of the short transport budget", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedTimeouts: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    observedTimeouts.push(delay ?? 0);
    queueMicrotask(callback);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      })) as typeof fetch
    });
    await assert.rejects(gateway.interactLoginSession("refresh-session", {
      type: "refresh_qr"
    }), { code: "mediacrawler_unavailable" });
    assert.deepEqual(observedTimeouts, [70_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("login interaction accepts a sidecar result after 65 seconds but before its 70 second transport deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let requestSignal: AbortSignal | undefined;
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => {
        requestSignal = init?.signal;
        return await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(JSON.stringify({
            session_id: "slow-refresh-session",
            state: "awaiting_scan",
            qr_image_data_url: "data:image/png;base64,bmV3",
            qr_status: "ready",
            login_page: null,
            failure_code: null,
            expires_at: "2026-08-25T05:30:00.000Z",
            account_handle: null,
            account_display_name: null,
            login_state_version: null,
          }))), 65_000);
        });
      }) as typeof fetch
    });

    const interaction = gateway.interactLoginSession("slow-refresh-session", {
      type: "refresh_qr"
    });
    context.mock.timers.tick(64_999);
    assert.equal(requestSignal?.aborted, false);
    context.mock.timers.tick(1);

    const session = await interaction;
    assert.equal(session.qrStatus, "ready");
    assert.equal(requestSignal?.aborted, false);
  } finally {
    context.mock.timers.reset();
  }
});

test("login interaction aborts at its 70 second transport deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let requestSignal: AbortSignal | undefined;
    const gateway = createDouyinMediaCrawlerGateway({
      baseUrl: "http://127.0.0.1:8000",
      serviceSecret,
      fetchImpl: (async (_input, init) => {
        requestSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }) as typeof fetch
    });

    const interaction = gateway.interactLoginSession("stalled-refresh-session", {
      type: "refresh_qr"
    });
    context.mock.timers.tick(69_999);
    assert.equal(requestSignal?.aborted, false);
    context.mock.timers.tick(1);

    await assert.rejects(interaction, { code: "mediacrawler_unavailable" });
    assert.equal(requestSignal?.aborted, true);
  } finally {
    context.mock.timers.reset();
  }
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

test("gateway reports a missing persisted crawl job without treating it as downtime", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/internal/v1/douyin/crawl-jobs/job-missing");
    response.statusCode = 404;
    response.end();
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.equal(await gateway.findCrawlJob("job-missing"), null);
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
      activity: {
        phase: "queued", current_keyword: null, browser_mode: "headless", sequence: 0
      }
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.getCrawlJob("job-live"), {
      jobId: "job-live",
      state: "running",
      recordCount: 25,
      pageCount: 1,
      failureCode: null,
      activity: {
        phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
      }
    });
  });
});

test("gateway recovers legacy terminal crawl descriptors without activity", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      job_id: "job-legacy-partial",
      state: "partial",
      created_at: "2026-08-25T16:18:09.216Z",
      updated_at: "2026-08-25T16:19:11.137Z",
      completed_at: "2026-08-25T16:19:11.137Z",
      acknowledged_at: null,
      record_count: 305,
      page_count: 13,
      failure_code: "crawl_interrupted_after_partial_results"
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    assert.deepEqual(await gateway.getCrawlJob("job-legacy-partial"), {
      jobId: "job-legacy-partial",
      state: "partial",
      recordCount: 305,
      pageCount: 13,
      failureCode: "crawl_interrupted_after_partial_results",
      activity: {
        phase: "completed",
        currentKeyword: null,
        browserMode: "headless",
        sequence: 1
      }
    });
  });
});

test("gateway still rejects live crawl descriptors without activity", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      job_id: "job-live-without-activity",
      state: "running",
      created_at: "2026-08-25T16:18:09.216Z",
      updated_at: "2026-08-25T16:19:11.137Z",
      completed_at: null,
      acknowledged_at: null,
      record_count: 25,
      page_count: 1,
      failure_code: null
    }));
  }, async (baseUrl) => {
    const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
    await assert.rejects(gateway.getCrawlJob("job-live-without-activity"), {
      code: "mediacrawler_invalid_response"
    });
  });
});

test("gateway maps strict snake-case sidecar activity and rejects private activity fields", async () => {
  for (const [extra, accepted] of [[undefined, true], ["private_handle", false]] as const) {
    await withServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        job_id: "job-live", state: "running",
        created_at: "2026-08-25T04:00:00.000Z",
        updated_at: "2026-08-25T04:00:01.000Z",
        completed_at: null, acknowledged_at: null,
        record_count: 0, page_count: 0, failure_code: null,
        activity: {
          phase: "searching", current_keyword: "袜子",
          browser_mode: "visible", sequence: 2,
          ...(extra ? { [extra]: "never expose" } : {})
        }
      }));
    }, async (baseUrl) => {
      const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
      if (accepted) {
        assert.deepEqual((await gateway.getCrawlJob("job-live")).activity, {
          phase: "searching", currentKeyword: "袜子", browserMode: "visible", sequence: 2
        });
      } else {
        await assert.rejects(gateway.getCrawlJob("job-live"), {
          code: "mediacrawler_invalid_response"
        });
      }
    });
  }
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

test("gateway accepts every closed Douyin control failure code", async () => {
  for (const failureCode of [
    "douyin_direct_message_unavailable",
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
    "douyin_account_identity_changed",
    "douyin_profile_busy"
  ]) {
    await withServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        action_id: "action-1", state: "failed", platform_receipt_reference: null,
        occurred_at: "2026-08-25T04:00:01.000Z", failure_code: failureCode
      }));
    }, async (baseUrl) => {
      const gateway = createDouyinMediaCrawlerGateway({ baseUrl, serviceSecret });
      const receipt = await gateway.executeAction({ actionId: "action-1",
        accountHandle: "private-handle", loginStateVersion: 3, kind: "comment",
        targetPublicUrl: "https://www.douyin.com/video/video-1",
        content: "exact approved content", approvedContentHash: `sha256:${"a".repeat(64)}`,
        deadlineAt: "2026-08-25T04:01:00.000Z" });
      assert.equal(receipt.failureCode, failureCode);
    });
  }
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
