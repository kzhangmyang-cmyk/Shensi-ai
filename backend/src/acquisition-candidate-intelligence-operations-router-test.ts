import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import {
  AcquisitionCandidateIntelligenceOperationError,
  type AcquisitionCandidateIntelligenceOperation,
  type AcquisitionCandidateIntelligenceScope
} from "./acquisition-candidate-intelligence-operations.js";
import {
  createAcquisitionCandidateIntelligenceOperationsRouter,
  type AcquisitionCandidateIntelligenceOperationsRouterService
} from "./acquisition-candidate-intelligence-operations-router.js";

const OWNER = "owner-candidate-intelligence";
const TEAM = "team-candidate-intelligence";
const NOW = "2026-08-07T04:00:00.000Z";

function operation(input: {
  id: string;
  candidateId: string;
  ownerId?: string;
  teamId?: string;
  status?: AcquisitionCandidateIntelligenceOperation["status"];
}): AcquisitionCandidateIntelligenceOperation {
  return {
    id: input.id,
    ownerId: input.ownerId ?? OWNER,
    teamId: input.teamId ?? TEAM,
    actorId: input.ownerId ?? OWNER,
    candidateId: input.candidateId,
    sessionId: `private-session-${input.id}`,
    identityFingerprint: `sha256:${"a".repeat(64)}`,
    status: input.status ?? "queued",
    currentStage: null,
    completedStages: [],
    skippedStages: [],
    research: null,
    qualification: null,
    battleCardId: null,
    failure: null,
    createdAt: NOW,
    startedAt: null,
    updatedAt: NOW,
    completedAt: null,
    failedAt: null
  };
}

async function fixture(options: { dispatchError?: Error } = {}) {
  const records = new Map<string, AcquisitionCandidateIntelligenceOperation>();
  const idempotency = new Map<string, string>();
  const retryIdempotency = new Map<string, string>();
  const dispatches: Array<{
    scope: AcquisitionCandidateIntelligenceScope;
    operationId: string;
  }> = [];
  let sequence = 0;
  const visible = (
    scope: AcquisitionCandidateIntelligenceScope,
    value: AcquisitionCandidateIntelligenceOperation | undefined
  ) => value
    && value.ownerId === scope.ownerId
    && value.teamId === scope.teamId
    ? structuredClone(value)
    : null;
  const service: AcquisitionCandidateIntelligenceOperationsRouterService = {
    async createAfterIdentity(scope, candidateId, key) {
      if (candidateId === "candidate-unresolved") {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDENTITY_NOT_RESOLVED"
        );
      }
      const replayId = idempotency.get(`${scope.ownerId}:${scope.teamId}:${key}`);
      if (replayId) return structuredClone(records.get(replayId)!);
      const value = operation({
        id: `candidate-intelligence-${++sequence}`,
        candidateId,
        ownerId: scope.ownerId,
        teamId: scope.teamId
      });
      records.set(value.id, structuredClone(value));
      idempotency.set(`${scope.ownerId}:${scope.teamId}:${key}`, value.id);
      return structuredClone(value);
    },
    async get(scope, operationId) {
      const value = visible(scope, records.get(operationId));
      if (!value) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      return value;
    },
    async requestRetry(scope, operationId, key) {
      const value = visible(scope, records.get(operationId));
      if (!value) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      const ledgerKey = `${scope.ownerId}:${scope.teamId}:${key}`;
      const existingOperationId = retryIdempotency.get(ledgerKey);
      if (existingOperationId && existingOperationId !== operationId) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      const retried = existingOperationId === undefined
        && value.status === "failed"
        ? {
            ...value,
            status: "queued" as const,
            currentStage: null,
            failure: null,
            failedAt: null,
            updatedAt: NOW
          }
        : value;
      retryIdempotency.set(ledgerKey, operationId);
      records.set(operationId, structuredClone(retried));
      return {
        operation: structuredClone(retried),
        shouldDispatch: existingOperationId === undefined
      };
    },
    async findLatestForCandidate(scope, candidateId) {
      const value = [...records.values()]
        .filter((item) => item.candidateId === candidateId)
        .reverse()
        .find((item) => visible(scope, item));
      if (!value) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      return structuredClone(value);
    }
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const ownerId = req.header("x-test-owner");
    const teamId = req.header("x-test-team");
    if (ownerId && teamId) {
      req.user = {
        id: ownerId,
        teamId,
        name: ownerId,
        email: `${ownerId}@example.test`,
        role: "sales",
        avatar: "",
        authVersion: 1
      };
    }
    next();
  });
  app.use(createAcquisitionCandidateIntelligenceOperationsRouter({
    service,
    dispatchOperation: async (scope, operationId) => {
      dispatches.push({ scope: structuredClone(scope), operationId });
      if (options.dispatchError) throw options.dispatchError;
    },
    requestIdFactory: () => "candidate-intelligence-request-1"
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  async function request(
    path: string,
    init: RequestInit = {},
    identity: { ownerId: string; teamId: string } | null = {
      ownerId: OWNER,
      teamId: TEAM
    }
  ) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (identity) {
      headers.set("x-test-owner", identity.ownerId);
      headers.set("x-test-team", identity.teamId);
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers
    });
    return {
      response,
      json: await response.json() as Record<string, unknown>
    };
  }

  return {
    dispatches,
    records,
    request,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

test("creates and dispatches a candidate intelligence operation with a safe public response", async () => {
  const state = await fixture();
  try {
    const created = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-create-1" },
        body: "{}"
      }
    );

    assert.equal(created.response.status, 202, JSON.stringify(created.json));
    assert.equal(created.json.candidateId, "candidate-a");
    assert.equal(created.json.status, "queued");
    assert.equal(created.response.headers.get("cache-control"), "no-store");
    assert.equal(
      created.response.headers.get("x-request-id"),
      "candidate-intelligence-request-1"
    );
    for (const forbidden of [
      "ownerId",
      "teamId",
      "actorId",
      "sessionId",
      "identityFingerprint",
      "idempotencyKeyHash",
      "requestHash",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAt"
    ]) {
      assert.equal(forbidden in created.json, false, forbidden);
    }
    assert.deepEqual(state.dispatches, [{
      scope: { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
      operationId: created.json.id
    }]);
  } finally {
    await state.close();
  }
});

test("gets an operation and restores the latest operation by candidate within its tenant", async () => {
  const state = await fixture();
  try {
    const first = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-first" },
        body: "{}"
      }
    );
    const latest = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-latest" },
        body: "{}"
      }
    );
    const loaded = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${latest.json.id}`
    );
    const restored = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operation"
    );
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.json.id, latest.json.id);
    assert.equal(restored.response.status, 200);
    assert.equal(restored.json.id, latest.json.id);
    assert.notEqual(restored.json.id, first.json.id);

    const hidden = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${latest.json.id}`,
      {},
      { ownerId: "other-owner", teamId: TEAM }
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.code, "resource_not_found");
  } finally {
    await state.close();
  }
});

test("retry validates the idempotency header and dispatches the existing operation", async () => {
  const state = await fixture();
  try {
    const created = await state.request(
      "/api/v1/acquisition/candidates/candidate-retry/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-retry-create" },
        body: "{}"
      }
    );
    state.dispatches.length = 0;
    state.records.set(String(created.json.id), operation({
      id: String(created.json.id),
      candidateId: "candidate-retry",
      status: "failed"
    }));
    const missingKey = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${created.json.id}/retry`,
      { method: "POST", body: "{}" }
    );
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.code, "idempotency_key_required");

    const retried = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${created.json.id}/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-retry-1" },
        body: "{}"
      }
    );
    assert.equal(retried.response.status, 202);
    assert.equal(retried.json.id, created.json.id);
    assert.equal(retried.json.status, "queued");
    assert.deepEqual(state.dispatches, [{
      scope: { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
      operationId: created.json.id
    }]);

    const replayed = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${created.json.id}/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-retry-1" },
        body: "{}"
      }
    );
    assert.equal(replayed.response.status, 202);
    assert.equal(state.dispatches.length, 1);

    const another = await state.request(
      "/api/v1/acquisition/candidates/candidate-other/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-other-create" },
        body: "{}"
      }
    );
    state.dispatches.length = 0;
    const conflict = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${another.json.id}/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-retry-1" },
        body: "{}"
      }
    );
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.code, "idempotency_conflict");
    assert.deepEqual(state.dispatches, []);
  } finally {
    await state.close();
  }
});

test("writes require authentication, strict empty JSON, and a resolved identity", async () => {
  const state = await fixture();
  try {
    const unauthenticated = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-unauthenticated" },
        body: "{}"
      },
      null
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.json.code, "unauthorized");

    const unknownField = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-strict" },
        body: JSON.stringify({ executeOutreach: true })
      }
    );
    assert.equal(unknownField.response.status, 400);
    assert.equal(unknownField.json.code, "invalid_request");

    const unresolved = await state.request(
      "/api/v1/acquisition/candidates/candidate-unresolved/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-unresolved" },
        body: "{}"
      }
    );
    assert.equal(unresolved.response.status, 409);
    assert.equal(unresolved.json.code, "identity_not_resolved");
  } finally {
    await state.close();
  }
});

test("dispatch failures are sanitized and leave the durable operation retrievable", async () => {
  const state = await fixture({ dispatchError: new Error("secret queue error") });
  try {
    const created = await state.request(
      "/api/v1/acquisition/candidates/candidate-a/intelligence-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "candidate-op-dispatch-failure" },
        body: "{}"
      }
    );
    assert.equal(created.response.status, 500);
    assert.equal(created.json.code, "internal_error");
    assert.equal(created.json.retryable, true);
    assert.doesNotMatch(JSON.stringify(created.json), /secret queue error/u);

    const stored = [...state.records.values()][0];
    assert.ok(stored);
    const loaded = await state.request(
      `/api/v1/acquisition/candidate-intelligence-operations/${stored.id}`
    );
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.json.status, "queued");
  } finally {
    await state.close();
  }
});

test("retry dispatch failure leaves a queued operation that an idempotent replay can observe", async () => {
  const state = await fixture({ dispatchError: new Error("secret queue error") });
  try {
    const failed = operation({
      id: "candidate-intelligence-retry-crash",
      candidateId: "candidate-retry-crash",
      status: "failed"
    });
    state.records.set(failed.id, failed);
    const path =
      `/api/v1/acquisition/candidate-intelligence-operations/${failed.id}/retry`;

    const first = await state.request(path, {
      method: "POST",
      headers: { "Idempotency-Key": "retry-crash-window" },
      body: "{}"
    });
    assert.equal(first.response.status, 500);
    assert.equal(state.records.get(failed.id)?.status, "queued");

    const replay = await state.request(path, {
      method: "POST",
      headers: { "Idempotency-Key": "retry-crash-window" },
      body: "{}"
    });
    assert.equal(replay.response.status, 202);
    assert.equal(replay.json.status, "queued");
  } finally {
    await state.close();
  }
});
