import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, Server } from "node:http";
import test from "node:test";
import express from "express";
import {
  createAcquisitionDouyinIdentityResolutionRouter,
  type AcquisitionDouyinIdentityResolutionRouterOperation,
  type AcquisitionDouyinIdentityResolutionRouterScope
} from "./acquisition-douyin-identity-resolution-router.js";
import type { DiscoveryEvidence } from "./acquisition-domain.js";
import {
  AcquisitionDouyinIdentityResolutionOperationService,
  InMemoryAcquisitionDouyinIdentityResolutionOperationRepository,
  type AcquisitionDouyinIdentityResolutionOperationRecord
} from "./acquisition-douyin-identity-resolution-operations.js";

const scope: AcquisitionDouyinIdentityResolutionRouterScope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "owner-a"
};

function operation(overrides: Partial<AcquisitionDouyinIdentityResolutionRouterOperation> = {}) {
  return {
    id: "douyin-operation-1",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    actorId: scope.actorId,
    candidateId: "candidate-1",
    candidateVersion: 3,
    sourceEvidenceFingerprint: `sha256:${"a".repeat(64)}`,
    searchConnections: [{
      connectionId: "search-connection-1",
      providerId: "baidu-search",
      kind: "search" as const,
      status: "active" as const,
      credentialVersion: 1
    }],
    planSessionId: null,
    status: "succeeded" as const,
    currentStage: null,
    outcome: "verified_consensus" as const,
    retryable: false,
    canonicalProfileUrl: "https://www.douyin.com/user/verified",
    profileCandidates: [{
      publicProfileUrl: "https://www.douyin.com/user/verified",
      evidenceIds: ["evidence-1"]
    }],
    evidence: [{
      evidenceId: "evidence-1",
      evidenceClass: "douyin_public_page" as const,
      publicProfileUrl: "https://www.douyin.com/user/verified",
      accessStatus: "public_content" as const,
      sourceUrl: "https://www.douyin.com/video/1",
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      fetchedAt: "2026-08-08T00:00:00.000Z"
    }],
    intelligenceOperationId: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:00:00.000Z",
    ...overrides
  };
}

function storedOperation(
  item: AcquisitionDouyinIdentityResolutionRouterOperation
): AcquisitionDouyinIdentityResolutionOperationRecord {
  return {
    ...item,
    sourceEvidenceIds: ["evidence-1"],
    idempotencyKeyHash: "c".repeat(64),
    requestHash: `sha256:${"d".repeat(64)}`,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null
  };
}

function sourceEvidence(id: string, version = 1): DiscoveryEvidence {
  return {
    id,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: id,
    sourceSnippet: "公开证据",
    publishedAt: null,
    fetchedAt: "2026-08-08T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:raw-${id}-${version}`,
    contentHash: `sha256:content-${id}-${version}`,
    provenance: {
      kind: "search_result",
      provider: "douyin",
      queryText: id,
      sourceUrl: `https://www.douyin.com/video/${id}`,
      resultRank: 1
    },
    accessStatus: "public_content",
    supersedesEvidenceId: null
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    version: 3,
    partyType: "individual",
    partyRef: { partyType: "individual" },
    profile: { kind: "individual", sourcePlatform: "douyin" },
    identityResolution: null,
    evidenceIds: ["evidence-1"],
    ...overrides
  };
}

async function fixture(input: {
  user?: { id: string; teamId: string } | null;
  candidates?: Map<string, ReturnType<typeof candidate>>;
  latest?: AcquisitionDouyinIdentityResolutionRouterOperation | null;
} = {}) {
  const creations: Array<{ idempotencyKey: string; candidateVersion: number }> = [];
  const dispatched: string[] = [];
  const candidates = input.candidates ?? new Map([["candidate-1", candidate()]]);
  const evidence = new Map<string, DiscoveryEvidence>([
    ["evidence-1", sourceEvidence("evidence-1")],
    ["evidence-2", sourceEvidence("evidence-2")]
  ]);
  const searchConnections = [{
    connectionId: "search-connection-1",
    providerId: "baidu-search",
    kind: "search" as const,
    status: "active" as const,
    credentialVersion: 1
  }];
  const repository =
    new InMemoryAcquisitionDouyinIdentityResolutionOperationRepository();
  if (input.latest !== null) {
    await repository.createOperation(storedOperation(input.latest ?? operation()));
  }
  let sequence = 0;
  const operationService = new AcquisitionDouyinIdentityResolutionOperationService({
    repository,
    evidence: {
      async getEvidence(requestScope, evidenceId) {
        const item = evidence.get(evidenceId);
        return item
          && item.ownerId === requestScope.ownerId
          && item.teamId === requestScope.teamId
          ? structuredClone(item)
          : null;
      }
    },
    idFactory: () => `douyin-operation-created-${++sequence}`,
    now: () => "2026-08-08T01:00:00.000Z"
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    if (input.user !== null) {
      req.user = input.user ?? {
        id: scope.ownerId,
        teamId: scope.teamId,
        name: "Owner",
        email: "owner@example.test",
        role: "sales",
        avatar: "",
        authVersion: 1
      };
    }
    next();
  });
  app.use(createAcquisitionDouyinIdentityResolutionRouter({
    operations: {
      async findIdempotentReplay(requestScope, candidateId, idempotencyKey) {
        return operationService.findIdempotentReplay(
          requestScope,
          candidateId,
          idempotencyKey
        );
      },
      async findLatestForCandidate(requestScope, candidateId) {
        return operationService.findLatestForCandidate(requestScope, candidateId);
      },
      async create(requestScope, create, idempotencyKey) {
        const result = await operationService.createWithResult(
          requestScope,
          create,
          idempotencyKey
        );
        if (!result.replayed) {
          creations.push({
            idempotencyKey,
            candidateVersion: create.expectedCandidateVersion
          });
        }
        return result;
      }
    },
    candidates: {
      async getCandidate(requestScope, candidateId) {
        return requestScope.ownerId === scope.ownerId
          && requestScope.teamId === scope.teamId
          ? candidates.get(candidateId) ?? null
          : null;
      }
    },
    searchConnections: {
      async list() {
        return structuredClone(searchConnections);
      }
    },
    async dispatchOperation(_scope, operationId) {
      dispatched.push(operationId);
    },
    requestIdFactory: () => "request-douyin-router"
  }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    creations,
    dispatched,
    candidates,
    evidence,
    searchConnections,
    async latest(candidateId = "candidate-1") {
      return operationService.findLatestForCandidate(scope, candidateId);
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
      return { response, json: await response.json().catch(() => null) };
    },
    rawRequest(path: string, input: {
      method: string;
      headers: Record<string, string | string[]>;
      body?: string;
    }) {
      return new Promise<{
        status: number;
        headers: Record<string, string | string[]>;
        json: unknown;
      }>(
        (resolve, reject) => {
          const responseHeaders: Record<string, string | string[]> = {};
          const request = httpRequest(`${baseUrl}${path}`, input, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              for (let index = 0; index < response.rawHeaders.length; index += 2) {
                responseHeaders[response.rawHeaders[index]!] = response.rawHeaders[index + 1]!;
              }
              const body = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode ?? 0,
                headers: responseHeaders,
                json: body ? JSON.parse(body) : null
              });
            });
          });
          request.on("error", reject);
          if (input.body !== undefined) request.write(input.body);
          request.end();
        }
      );
    },
    close: () => new Promise<void>((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve()
    ))
  };
}

test("latest Douyin identity operation projects only its safe public DTO", async () => {
  const subject = await fixture();
  try {
    const result = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operation"
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.json.outcome, "verified_consensus");
    for (const privateField of [
      "ownerId", "teamId", "actorId", "searchConnections", "planSessionId",
      "sourceEvidenceFingerprint", "idempotencyKeyHash", "requestHash",
      "leaseOwner", "leaseToken", "leaseExpiresAt"
    ]) assert.equal(result.json[privateField], undefined, privateField);
  } finally {
    await subject.close();
  }
});

test("latest Douyin identity operation is tenant-scoped and returns 404 when absent", async () => {
  const subject = await fixture({ user: { id: "owner-b", teamId: "team-b" } });
  try {
    const result = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operation"
    );
    assert.equal(result.response.status, 404);
  } finally {
    await subject.close();
  }
});

test("Douyin identity operation routes require authentication", async () => {
  const subject = await fixture({ user: null });
  try {
    const result = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operation"
    );
    assert.equal(result.response.status, 401);
  } finally {
    await subject.close();
  }
});

test("retry re-reads trusted candidate inputs, dispatches, and marks idempotent replays", async () => {
  const subject = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const first = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "retry-operation-1" }, body: "{}" }
    );
    assert.equal(first.response.status, 202);
    assert.equal(subject.creations[0]?.candidateVersion, 3);
    assert.deepEqual(subject.dispatched, ["douyin-operation-created-1"]);
    const replay = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "retry-operation-1" }, body: "{}" }
    );
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(subject.dispatched, ["douyin-operation-created-1"]);

  } finally {
    await subject.close();
  }
});

test("retry returns the replay marker for an idempotent retry request", async () => {
  const subject = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const created = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "replay-key" }, body: "{}" }
    );
    assert.equal(created.response.status, 202);
    const replay = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "replay-key" }, body: "{}" }
    );
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(subject.dispatched, ["douyin-operation-created-1"]);
  } finally {
    await subject.close();
  }
});

test("successful replay stays frozen after candidate, evidence, and connections change", async () => {
  const subject = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const created = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "frozen-replay-key" }, body: "{}" }
    );
    assert.equal(created.response.status, 202);
    subject.candidates.set("candidate-1", candidate({
      version: 4,
      evidenceIds: ["evidence-2"],
      identityResolution: { status: "resolved" }
    }));
    subject.evidence.set("evidence-1", sourceEvidence("evidence-1", 2));
    subject.searchConnections[0]!.credentialVersion = 2;

    const replay = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "frozen-replay-key" }, body: "{}" }
    );

    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replay.json.id, created.json.id);
    assert.equal(replay.json.candidateVersion, 3);
    assert.deepEqual(subject.dispatched, ["douyin-operation-created-1"]);
  } finally {
    await subject.close();
  }
});

test("retry rejects malformed input and unsafe candidates before creating work", async () => {
  const cases = [
    { body: JSON.stringify({ canonicalProfileUrl: "https://attacker.test" }), latest: operation({ status: "failed", outcome: "provider_unavailable", retryable: true }), expected: 400 },
    { body: "{}", latest: operation({ status: "failed", outcome: "provider_unavailable", retryable: true }), candidate: candidate({ identityResolution: { status: "resolved" } }), expected: 422 },
    { body: "{}", latest: operation({ status: "failed", outcome: "provider_unavailable", retryable: true }), candidate: candidate({ profile: { kind: "individual", sourcePlatform: "xiaohongshu" } }), expected: 422 },
    { body: "{}", latest: operation({ status: "succeeded", outcome: "verified_consensus", retryable: false }), expected: 409 },
    { body: "{}", latest: operation({ status: "failed", outcome: "ambiguous", retryable: false }), expected: 409 }
  ];
  for (const item of cases) {
    const subject = await fixture({
      latest: item.latest,
      candidates: new Map([["candidate-1", item.candidate ?? candidate()]])
    });
    try {
      const result = await subject.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: item.body }
      );
      assert.equal(result.response.status, item.expected);
      assert.equal(subject.creations.length, 0);
    } finally {
      await subject.close();
    }
  }
});

test("retry requires a unique idempotency key and an existing candidate", async () => {
  const subject = await fixture({
    latest: operation({ status: "failed", outcome: "provider_unavailable", retryable: true }),
    candidates: new Map()
  });
  try {
    const missing = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      { method: "POST", body: "{}" }
    );
    assert.equal(missing.response.status, 400);
    const absent = await subject.request(
      "/api/v1/acquisition/candidates/missing/douyin-identity-resolution-operations",
      { method: "POST", headers: { "Idempotency-Key": "key-missing-candidate" }, body: "{}" }
    );
    assert.equal(absent.response.status, 404);
  } finally {
    await subject.close();
  }
});

test("retry body is present JSON and exactly an empty object", async () => {
  const cases: Array<{ body?: string; label: string }> = [
    { label: "missing body" },
    { label: "JSON null", body: "null" },
    { label: "additional property", body: JSON.stringify({ outcome: "verified_consensus" }) }
  ];
  for (const item of cases) {
    const subject = await fixture({ latest: operation({
      status: "failed", outcome: "provider_unavailable", retryable: true
    }) });
    try {
      const result = await subject.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        {
          method: "POST",
          headers: { "Idempotency-Key": `strict-${item.label}` },
          body: item.body
        }
      );
      assert.equal(result.response.status, 400, item.label);
      assert.equal(subject.creations.length, 0, item.label);
    } finally {
      await subject.close();
    }
  }
});

test("retry accepts only the application/json media type", async () => {
  const rejectedMedia = [
    { contentType: "application/x-www-form-urlencoded", body: "&" },
    { contentType: "text/plain", body: "{}" },
    { contentType: "multipart/form-data; boundary=empty", body: "--empty--" },
    { contentType: "", body: "{}" }
  ];
  for (const [index, item] of rejectedMedia.entries()) {
    const rejected = await fixture({ latest: operation({
      status: "failed", outcome: "provider_unavailable", retryable: true
    }) });
    try {
      const result = await rejected.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        {
          method: "POST",
          headers: {
            "content-type": item.contentType,
            "Idempotency-Key": `rejected-media-${index}`
          },
          body: item.body
        }
      );
      assert.equal(result.response.status, 400, item.contentType || "missing");
      assert.equal(rejected.creations.length, 0);
      assert.equal(rejected.dispatched.length, 0);
    } finally {
      await rejected.close();
    }
  }

  const accepted = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const result = await accepted.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Idempotency-Key": "json-with-charset"
        },
        body: "{}"
      }
    );
    assert.equal(result.response.status, 202);
    assert.equal(accepted.creations.length, 1);
    assert.equal(accepted.dispatched.length, 1);
  } finally {
    await accepted.close();
  }
});

test("retry rejects physically duplicated Idempotency-Key headers", async () => {
  const subject = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const result = await subject.rawRequest(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": ["duplicate-key-a", "duplicate-key-b"]
        },
        body: "{}"
      }
    );
    assert.equal(result.status, 400);
    assert.equal(subject.creations.length, 0);
  } finally {
    await subject.close();
  }
});

test("concurrent candidates cannot share one idempotency key", async () => {
  const subject = await fixture({
    latest: null,
    candidates: new Map([
      ["candidate-1", candidate()],
      ["candidate-2", candidate({ id: "candidate-2" })]
    ])
  });
  try {
    const results = await Promise.all([
      subject.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        { method: "POST", headers: { "Idempotency-Key": "candidate-bound-key" }, body: "{}" }
      ),
      subject.request(
        "/api/v1/acquisition/candidates/candidate-2/douyin-identity-resolution-operations",
        { method: "POST", headers: { "Idempotency-Key": "candidate-bound-key" }, body: "{}" }
      )
    ]);
    assert.deepEqual(
      results.map((result) => result.response.status).sort(),
      [202, 409]
    );
    assert.equal(subject.creations.length, 1);
    assert.equal(subject.dispatched.length, 1);
  } finally {
    await subject.close();
  }
});

test("concurrent retry keys create and dispatch exactly one candidate lifecycle", async () => {
  const subject = await fixture({ latest: operation({
    status: "failed", outcome: "provider_unavailable", retryable: true
  }) });
  try {
    const results = await Promise.all([
      subject.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        { method: "POST", headers: { "Idempotency-Key": "concurrent-a" }, body: "{}" }
      ),
      subject.request(
        "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
        { method: "POST", headers: { "Idempotency-Key": "concurrent-b" }, body: "{}" }
      )
    ]);
    assert.deepEqual(
      results.map((result) => result.response.status).sort(),
      [202, 409]
    );
    assert.equal(subject.dispatched.length, 1);
    assert.equal((await subject.latest())?.status, "queued");
  } finally {
    await subject.close();
  }
});

test("public projection filters sentinel evidence and caps related lists", async () => {
  const evidence = Array.from({ length: 105 }, (_, index) => ({
    evidenceId: `evidence-${index}`,
    evidenceClass: "douyin_public_page" as const,
    publicProfileUrl: `https://www.douyin.com/user/${index}`,
    sourceUrl: `https://www.douyin.com/video/${index}`,
    sourceFingerprint: `sha256:${String(index).padStart(64, "0")}`,
    accessStatus: "public_content" as const,
    fetchedAt: "2026-08-08T00:00:00.000Z"
  }));
  evidence.splice(3, 0, {
    evidenceId: "provider-unavailable-sentinel",
    evidenceClass: "independent_search_result",
    publicProfileUrl: "",
    sourceUrl: "",
    sourceFingerprint: `sha256:${"f".repeat(64)}`,
    accessStatus: "provider_unavailable",
    fetchedAt: "2026-08-08T00:00:00.000Z"
  });
  const profileCandidates = evidence
    .filter((item) => item.publicProfileUrl)
    .map((item) => ({
      publicProfileUrl: item.publicProfileUrl,
      evidenceIds: [item.evidenceId, item.evidenceId]
    }));
  Object.assign(evidence[0]!, {
    ownerId: "private-owner",
    providerConnectionSnapshot: { credentialVersion: 99 }
  });
  Object.assign(profileCandidates[0]!, {
    internalScore: 0.99,
    privateEvidence: { rawArtifact: "secret" }
  });
  profileCandidates.push({
    publicProfileUrl: "https://WWW.DOUYIN.COM/user/0/#duplicate",
    evidenceIds: ["evidence-1", "evidence-0"]
  });
  const subject = await fixture({ latest: operation({
    canonicalProfileUrl: null,
    profileCandidates,
    evidence
  }) });
  try {
    const result = await subject.request(
      "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operation"
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.json.evidence.length, 100);
    assert.equal(result.json.profileCandidates.length, 100);
    assert.deepEqual(Object.keys(result.json.evidence[0]).sort(), [
      "accessStatus",
      "evidenceClass",
      "evidenceId",
      "fetchedAt",
      "publicProfileUrl",
      "sourceFingerprint",
      "sourceUrl"
    ]);
    assert.deepEqual(result.json.profileCandidates[0], {
      publicProfileUrl: "https://www.douyin.com/user/0",
      evidenceIds: ["evidence-0", "evidence-1"]
    });
    assert.equal(
      new Set(result.json.profileCandidates.map(
        (item: { publicProfileUrl: string }) => item.publicProfileUrl
      )).size,
      result.json.profileCandidates.length
    );
    assert.equal(
      result.json.evidence.some((item: { evidenceId: string }) =>
        item.evidenceId === "provider-unavailable-sentinel"),
      false
    );
    const publicEvidenceIds = new Set(
      result.json.evidence.map((item: { evidenceId: string }) => item.evidenceId)
    );
    for (const profile of result.json.profileCandidates) {
      assert.ok(profile.evidenceIds.length <= 100);
      assert.equal(new Set(profile.evidenceIds).size, profile.evidenceIds.length);
      assert.ok(profile.evidenceIds.every((id: string) => publicEvidenceIds.has(id)));
    }
  } finally {
    await subject.close();
  }
});
