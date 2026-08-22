import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type RequestHandler } from "express";
import {
  createAcquisitionVisualReaderRouter
} from "./acquisition-visual-reader-router.js";
import {
  AcquisitionVisualReaderServiceError
} from "./acquisition-visual-reader-service.js";

const SESSION = {
  sessionId: "visual-session:abc",
  runId: "run-router",
  planId: "plan-router",
  planVersionId: "version-router",
  platform: "douyin" as const,
  coverage: "authorized_visible_top_level_sample" as const,
  status: "created" as const,
  artifactUploadEnabled: true,
  limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxScrolls: 0, maxOcrCalls: 0, maxDurationMs: 120_000 },
  usage: { videoCount: 0, observationCount: 0, scrollCount: 0, ocrCallCount: 0, domObservationCount: 0, accessibilityObservationCount: 0, ocrObservationCount: 0, lowConfidenceObservationCount: 0, artifactCount: 0 },
  outcome: null,
  lastErrorCode: null,
  createdAt: "2026-08-15T01:00:00.000Z",
  authorizedAt: "2026-08-15T01:00:00.000Z",
  updatedAt: "2026-08-15T01:00:00.000Z",
  expiresAt: "2026-08-15T01:02:00.000Z",
  completedAt: null
};

async function withServer(input: {
  authenticated?: boolean;
  preParser?: RequestHandler;
  service?: Record<string, unknown>;
}, work: (baseUrl: string) => Promise<void>) {
  const app = express();
  if (input.preParser) app.use(input.preParser);
  if (input.authenticated !== false) {
    app.use((req, _res, next) => {
      req.user = { id: "owner-router", teamId: "team-router" } as never;
      next();
    });
  }
  const service = {
    async createSession() { return { session: SESSION, created: true }; },
    async getSession() { return SESSION; },
    async appendObservationBatch() { return { response: { session: SESSION, accepted: [], duplicates: [] }, replayed: false }; },
    async completeSession() { return SESSION; },
    async abortSession() { return { ...SESSION, status: "aborted" }; },
    async getArtifact() { return { mediaType: "image/webp", plaintext: Buffer.from("raw-webp") }; },
    ...input.service
  };
  app.use(createAcquisitionVisualReaderRouter({ service: service as never }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("router rejects missing req.user even when mounted without production auth", async () => {
  await withServer({ authenticated: false }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "create" },
      body: JSON.stringify({ runId: "run-router", artifactUploadEnabled: false })
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, "unauthorized");
  });
});

test("write routes require an ASCII-safe Idempotency-Key without normalization", async () => {
  for (const key of [null, "embedded space", "line\nbreak", "é", "x".repeat(201)]) {
    await withServer({}, async (baseUrl) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key !== null && !key.includes("\n")) headers["Idempotency-Key"] = key;
      const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runId: "run-router", artifactUploadEnabled: false })
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code,
        key === null || key.includes("\n")
          ? "idempotency_key_required" : "invalid_idempotency_key");
    });
  }
});

test("create and batch expose only public bodies plus the replay header", async () => {
  await withServer({
    service: {
      async createSession() { return { session: SESSION, created: false }; },
      async appendObservationBatch() {
        return { response: { session: SESSION, accepted: [], duplicates: ["client-1"] }, replayed: true };
      }
    }
  }, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "create" },
      body: JSON.stringify({ runId: "run-router", artifactUploadEnabled: true })
    });
    assert.equal(created.status, 200);
    assert.equal(created.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await created.json(), SESSION);

    const batch = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(SESSION.sessionId)}/observations:batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "batch" },
      body: JSON.stringify({ observations: [{ redactedCrop: null }] })
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await batch.json(), { session: SESSION, accepted: [], duplicates: ["client-1"] });
  });
});

test("concurrent create exposes one 201 winner and one replay response", async () => {
  let calls = 0;
  await withServer({
    service: {
      async createSession() {
        calls += 1;
        return { session: SESSION, created: calls === 1 };
      }
    }
  }, async (baseUrl) => {
    const request = () => fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "concurrent-create"
        },
        body: JSON.stringify({
          runId: "run-router",
          artifactUploadEnabled: true
        })
      }
    );
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.status).sort(),
      [200, 201]);
    assert.deepEqual(responses.map((response) =>
      response.headers.get("Idempotency-Replayed")).sort(), [null, "true"]);
  });
});

test("get, complete and abort use the route session and reject response mismatch", async () => {
  const calls: Array<{ method: string; sessionId: string; body?: unknown }> = [];
  await withServer({
    service: {
      async getSession(_scope: unknown, sessionId: string) {
        calls.push({ method: "get", sessionId });
        return SESSION;
      },
      async completeSession(_scope: unknown, sessionId: string, body: unknown) {
        calls.push({ method: "complete", sessionId, body });
        return { ...SESSION, status: "completed" };
      },
      async abortSession(_scope: unknown, sessionId: string, body: unknown) {
        calls.push({ method: "abort", sessionId, body });
        return { ...SESSION, status: "aborted" };
      }
    }
  }, async (baseUrl) => {
    const path = encodeURIComponent(SESSION.sessionId);
    const got = await fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions/${path}`
    );
    assert.equal(got.status, 200);
    const completed = await fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions/${path}:complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "complete"
        },
        body: JSON.stringify({ status: "completed", errorCodes: [] })
      }
    );
    assert.equal(completed.status, 200);
    const aborted = await fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions/${path}:abort`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "abort"
        },
        body: JSON.stringify({ reasonCode: "user_requested" })
      }
    );
    assert.equal(aborted.status, 200);
    assert.deepEqual(calls, [
      { method: "get", sessionId: SESSION.sessionId },
      {
        method: "complete",
        sessionId: SESSION.sessionId,
        body: { status: "completed", errorCodes: [] }
      },
      {
        method: "abort",
        sessionId: SESSION.sessionId,
        body: { reasonCode: "user_requested" }
      }
    ]);
  });

  await withServer({
    service: {
      async completeSession() {
        return { ...SESSION, sessionId: "different-session" };
      }
    }
  }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(SESSION.sessionId)}:complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "complete-mismatch"
        },
        body: JSON.stringify({ status: "completed", errorCodes: [] })
      }
    );
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { code: string }).code,
      "internal_error");
  });
});

test("standalone router rejects serialized JSON over 2 MiB even after a looser parser", async () => {
  let serviceCalls = 0;
  await withServer({
    preParser: express.json({ limit: "4mb" }),
    service: { async appendObservationBatch() { serviceCalls += 1; throw new Error("must not run"); } }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(SESSION.sessionId)}/observations:batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "large-batch" },
      body: JSON.stringify({ observations: [{ visibleText: "x".repeat(2 * 1024 * 1024) }] })
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { code: string }).code, "payload_too_large");
    assert.equal(serviceCalls, 0);
  });
});

test("standalone router maps malformed JSON to a safe standard ApiError", async () => {
  let serviceCalls = 0;
  const secret = "MALFORMED_VISUAL_JSON_MUST_NOT_ECHO";
  await withServer({
    service: {
      async createSession() {
        serviceCalls += 1;
        throw new Error("must not run");
      }
    }
  }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/v1/acquisition/visual-reader-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "malformed-json",
          "X-Request-Id": "visual-reader-malformed-json"
        },
        body: `{"secret":"${secret}"`
      }
    );
    assert.equal(response.status, 400);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "code", "details", "message", "requestId", "retryable"
    ]);
    assert.equal(body.code, "invalid_json");
    assert.equal(body.details, null);
    assert.equal(body.requestId, "visual-reader-malformed-json");
    assert.equal(body.retryable, false);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(response.headers.get("x-request-id"),
      "visual-reader-malformed-json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(serviceCalls, 0);
  });
});

test("errors never echo submitted text, secUid, URL, image or stack", async () => {
  const secrets = [
    "SECRET_COMMENT_BODY", "SECRET_SEC_UID",
    "https://www.douyin.com/video/999999", "UklGRlNFQ1JFVA=="
  ];
  await withServer({
    service: {
      async appendObservationBatch() {
        throw new AcquisitionVisualReaderServiceError(
          "visual_observation_invalid",
          400
        );
      }
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(SESSION.sessionId)}/observations:batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "invalid",
        "X-Request-Id": "router-safe-error"
      },
      body: JSON.stringify({ observations: [{ visibleText: secrets[0], secUid: secrets[1], sourceUrl: secrets[2], redactedCrop: { contentBase64: secrets[3] } }] })
    });
    assert.equal(response.status, 400);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "code", "details", "message", "requestId", "retryable"
    ]);
    assert.equal(body.requestId, "router-safe-error");
    assert.equal(body.details, null);
    assert.equal(body.retryable, false);
    assert.equal(response.headers.get("x-request-id"), "router-safe-error");
    const serialized = JSON.stringify(body);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("stack"), false);
  });

  await withServer({
    service: {
      async appendObservationBatch() {
        throw Object.assign(new Error(secrets.join(" ")), {
          code: "dependency_secret_error",
          status: 400
        });
      }
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-sessions/${encodeURIComponent(SESSION.sessionId)}/observations:batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "unexpected-dependency-error"
      },
      body: JSON.stringify({ observations: [] })
    });
    assert.equal(response.status, 500);
    assert.equal(
      (await response.json() as { code: string }).code,
      "internal_error"
    );
  });
});

test("artifact GET returns raw WebP with private anti-sniffing headers", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/acquisition/visual-reader-artifacts/artifact-router`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; sandbox");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from("raw-webp"));
  });
});

test("production parser order keeps visual writes at 2 MiB when JSON_BODY_LIMIT is larger", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBodyLimit = process.env.JSON_BODY_LIMIT;
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "10mb";
  const { app } = await import("./server.js");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const secret = "OVERSIZED_VISUAL_BODY_MUST_NOT_ECHO";
    const rawBody = `${" ".repeat(2 * 1024 * 1024)}${JSON.stringify({ secret })}`;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/acquisition/visual-reader-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "oversized-whitespace",
          "X-Request-Id": "visual-reader-oversized-body"
        },
        body: rawBody
      }
    );
    assert.equal(response.status, 413);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "code", "details", "message", "requestId", "retryable"
    ]);
    assert.equal(body.code, "payload_too_large");
    assert.equal(body.details, null);
    assert.equal(body.requestId, "visual-reader-oversized-body");
    assert.equal(body.retryable, false);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(response.headers.get("x-request-id"),
      "visual-reader-oversized-body");
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousBodyLimit === undefined) delete process.env.JSON_BODY_LIMIT;
    else process.env.JSON_BODY_LIMIT = previousBodyLimit;
  }
});
