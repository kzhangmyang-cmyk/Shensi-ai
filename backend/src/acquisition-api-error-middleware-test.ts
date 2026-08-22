import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { Ajv } from "ajv";
import express from "express";
import rateLimit from "express-rate-limit";
import {
  acquisitionApiErrorMiddleware,
  acquisitionApiRateLimitHandler
} from "./acquisition-api-error-response.js";
import { createAcquisitionOpenApiPaths } from "./acquisition-openapi.js";

const route =
  "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations";
const contractPath =
  "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations";

function assertApiError(status: 400 | 429, body: unknown) {
  const value = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), [
    "code", "details", "message", "requestId", "retryable"
  ]);
  const operation = createAcquisitionOpenApiPaths()[contractPath]!
    .post as Record<string, any>;
  const responseSchema = operation.responses[String(status)]
    .content["application/json"].schema;
  const schema = structuredClone(responseSchema.oneOf[0]);
  schema.properties.details = {};
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
}

async function mount(options: { rateLimit?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (options.rateLimit) {
    app.use("/api", rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: false,
      legacyHeaders: false,
      handler: acquisitionApiRateLimitHandler
    }));
  }
  app.post(route, (_req, res) => res.status(202).json({ accepted: true }));
  app.use(acquisitionApiErrorMiddleware);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    async request(body = "{}") {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Request-Id": "request-middleware-contract"
        },
        body
      });
      return {
        response,
        json: await response.json()
      };
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

test("invalid acquisition JSON uses the standard ApiError envelope", async () => {
  const subject = await mount();
  try {
    const result = await subject.request("{");
    assert.equal(result.response.status, 400);
    assert.equal(result.json.code, "invalid_json");
    assert.equal(result.json.requestId, "request-middleware-contract");
    assert.equal(result.json.retryable, false);
    assertApiError(400, result.json);
  } finally {
    await subject.close();
  }
});

test("acquisition rate limiting uses the retryable ApiError envelope", async () => {
  const subject = await mount({ rateLimit: true });
  try {
    assert.equal((await subject.request()).response.status, 202);
    const result = await subject.request();
    assert.equal(result.response.status, 429);
    assert.equal(result.json.code, "rate_limit_exceeded");
    assert.equal(result.json.requestId, "request-middleware-contract");
    assert.equal(result.json.retryable, true);
    assertApiError(429, result.json);
  } finally {
    await subject.close();
  }
});
