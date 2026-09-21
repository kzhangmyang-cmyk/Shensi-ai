import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DiscoveryEvidence } from "./acquisition-domain.js";
import type {
  DouyinPublicProfileDiscoveryResult
} from "./acquisition-douyin-public-profile-discovery.js";
import type {
  SearchPublicSourcesPort,
  SearchPublicSourcesResponse
} from "./acquisition-tool-executor.js";
import { AcquisitionDomainError } from "./acquisition-domain-service.js";
import {
  encryptProviderConfigurationWithSecret
} from "./credential-security.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import type { ProviderPage } from "./provider-contract.js";
import type { ProviderConnection } from "./types.js";
import {
  createAcquisitionPublicSearchPort,
  type AcquisitionPublicSearchStore
} from "./acquisition-public-search-port.js";
import {
  AcquisitionDouyinIdentityResolutionOperationError,
  AcquisitionDouyinIdentityResolutionOperationService,
  InMemoryAcquisitionDouyinIdentityResolutionOperationRepository,
  type AcquisitionDouyinIdentityResolutionOperationRecord,
  type AcquisitionDouyinIdentityResolutionScope
} from "./acquisition-douyin-identity-resolution-operations.js";

const SCOPE: AcquisitionDouyinIdentityResolutionScope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "actor-a"
};

function searchConnections(...connectionIds: string[]) {
  return connectionIds.map((connectionId) => ({
    connectionId,
    providerId: "baidu-search",
    kind: "search" as const,
    status: "active" as const,
    credentialVersion: 1
  }));
}

function evidence(
  id: string,
  contentHash: string,
  rawArtifactHash: string
): DiscoveryEvidence {
  return {
    id,
    ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId,
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: id,
    sourceSnippet: "公开证据",
    publishedAt: null,
    fetchedAt: "2026-08-08T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash,
    contentHash,
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

function fixture(options: { operationIds?: string[] } = {}) {
  const repository =
    new InMemoryAcquisitionDouyinIdentityResolutionOperationRepository();
  const evidenceById = new Map([
    ["evidence-a", evidence("evidence-a", "sha256:content-a", "sha256:raw-a")],
    ["evidence-b", evidence("evidence-b", "sha256:content-b", "sha256:raw-b")]
  ]);
  let now = "2026-08-08T00:00:00.000Z";
  let sequence = 0;
  const service = new AcquisitionDouyinIdentityResolutionOperationService({
    repository,
    evidence: {
      async getEvidence(scope, evidenceId) {
        const item = evidenceById.get(evidenceId);
        return item
          && item.ownerId === scope.ownerId
          && item.teamId === scope.teamId
          ? structuredClone(item)
          : null;
      }
    },
    idFactory: () => options.operationIds?.shift()
      ?? `identity-operation-${++sequence}`,
    now: () => now
  });
  return {
    repository,
    evidenceById,
    service,
    setNow(value: string) {
      now = value;
    }
  };
}

const CREATE_INPUT = {
  candidateId: "candidate-1",
  expectedCandidateVersion: 3,
  sourceEvidenceIds: ["evidence-a", "evidence-b"],
  searchConnections: [{
    connectionId: "search-connection-2",
    providerId: "baidu-search",
    kind: "search" as const,
    status: "active" as const,
    credentialVersion: 8
  }, {
    connectionId: "search-connection-1",
    providerId: "brave-search",
    kind: "search" as const,
    status: "active" as const,
    credentialVersion: 3
  }],
  planSessionId: "acquisition-plan:run-1"
};

test("create persists a queued operation at the expected candidate version", async () => {
  const { service } = fixture();

  const created = await service.create(
    SCOPE,
    CREATE_INPUT,
    "identity-create-key"
  );

  assert.equal(created.status, "queued");
  assert.equal(created.candidateVersion, 3);
  assert.equal(created.candidateId, "candidate-1");
  assert.deepEqual(created.searchConnections, [{
    connectionId: "search-connection-1",
    providerId: "brave-search",
    kind: "search",
    status: "active",
    credentialVersion: 3
  }, {
    connectionId: "search-connection-2",
    providerId: "baidu-search",
    kind: "search",
    status: "active",
    credentialVersion: 8
  }]);
  assert.equal(created.planSessionId, "acquisition-plan:run-1");
  assert.equal(created.outcome, null);
  assert.deepEqual(created.evidence, []);
});

test("idempotent replay keeps the original frozen connection snapshot", async () => {
  const { service } = fixture();
  const created = await service.create(
    SCOPE,
    CREATE_INPUT,
    "identity-create-key"
  );

  const replayed = await service.create(SCOPE, {
    ...CREATE_INPUT,
    searchConnections: CREATE_INPUT.searchConnections.map((connection) =>
      connection.connectionId === "search-connection-1"
        ? { ...connection, credentialVersion: 4 }
        : connection)
  }, "identity-create-key");

  assert.deepEqual(replayed, created);
});

test("idempotency replays equivalent requests independent of source order and time", async () => {
  const { service, setNow } = fixture();
  const created = await service.create(
    SCOPE,
    CREATE_INPUT,
    "identity-create-key"
  );
  setNow("2026-08-08T01:00:00.000Z");

  const replayed = await service.create(SCOPE, {
    ...CREATE_INPUT,
    sourceEvidenceIds: ["evidence-b", "evidence-a"],
    searchConnections: [
      CREATE_INPUT.searchConnections[1]!,
      CREATE_INPUT.searchConnections[0]!
    ]
  }, "identity-create-key");

  assert.deepEqual(replayed, created);
});

test("createWithResult reports an idempotent replay without creating a second operation", async () => {
  const { service } = fixture();
  const created = await service.createWithResult(
    SCOPE,
    CREATE_INPUT,
    "identity-create-result-key"
  );
  const replayed = await service.createWithResult(
    SCOPE,
    CREATE_INPUT,
    "identity-create-result-key"
  );

  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.operation.id, created.operation.id);
});

test("findIdempotentReplay is tenant and candidate scoped", async () => {
  const { service } = fixture();
  const created = await service.create(SCOPE, CREATE_INPUT, "identity-find-key");
  assert.equal(
    (await service.findIdempotentReplay(
      SCOPE,
      "candidate-1",
      "identity-find-key"
    ))?.id,
    created.id
  );
  assert.equal(
    await service.findIdempotentReplay(
      { ...SCOPE, ownerId: "other-owner", actorId: "other-owner" },
      "candidate-1",
      "identity-find-key"
    ),
    null
  );
  await assert.rejects(
    service.findIdempotentReplay(
      SCOPE,
      "candidate-2",
      "identity-find-key"
    ),
    (error: unknown) =>
      error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("idempotency conflicts across candidates but replays frozen source evidence", async () => {
  const { service, evidenceById } = fixture();
  const created = await service.create(
    SCOPE,
    CREATE_INPUT,
    "identity-create-key"
  );

  await assert.rejects(
    service.create(SCOPE, {
      ...CREATE_INPUT,
      candidateId: "candidate-2"
    }, "identity-create-key"),
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );

  evidenceById.set(
    "evidence-a",
    evidence("evidence-a", "sha256:changed", "sha256:raw-a")
  );
  const replayed = await service.create(
    SCOPE,
    CREATE_INPUT,
    "identity-create-key"
  );
  assert.deepEqual(replayed, created);
});

test("different idempotency keys cannot concurrently create a candidate lifecycle", async () => {
  const { service } = fixture();

  const results = await Promise.allSettled([
    service.createWithResult(SCOPE, CREATE_INPUT, "candidate-race-a"),
    service.createWithResult(SCOPE, CREATE_INPUT, "candidate-race-b")
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection && rejection.status === "rejected");
  assert.equal(
    rejection.reason instanceof AcquisitionDouyinIdentityResolutionOperationError
      ? rejection.reason.code
      : null,
    "OPERATION_ALREADY_RUNNING"
  );
});

test("a retryable provider failure permits one new candidate lifecycle", async () => {
  const { service, repository } = fixture();
  const first = await service.create(SCOPE, CREATE_INPUT, "retryable-first");
  const claimed = await repository.claimOperation(SCOPE, first.id, {
    leaseOwner: "worker-retryable",
    leaseToken: "lease-retryable",
    claimedAt: "2026-08-08T00:01:00.000Z",
    leaseExpiresAt: "2026-08-08T00:11:00.000Z"
  });
  await repository.saveOperation({
    ...claimed.operation!,
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true,
    updatedAt: "2026-08-08T00:02:00.000Z",
    completedAt: "2026-08-08T00:02:00.000Z"
  }, "lease-retryable");

  const retried = await service.create(
    SCOPE,
    CREATE_INPUT,
    "retryable-second"
  );
  assert.notEqual(retried.id, first.id);
  assert.equal(retried.status, "queued");
});

test("a same-timestamp retry cannot be hidden behind terminal ID ordering", async () => {
  const { service, repository } = fixture({
    operationIds: ["z-terminal", "a-retry", "b-should-not-create"]
  });
  const first = await service.create(SCOPE, CREATE_INPUT, "same-time-first");
  const claimed = await repository.claimOperation(SCOPE, first.id, {
    leaseOwner: "worker-same-time",
    leaseToken: "lease-same-time",
    claimedAt: "2026-08-08T00:00:00.000Z",
    leaseExpiresAt: "2026-08-08T00:10:00.000Z"
  });
  await repository.saveOperation({
    ...claimed.operation!,
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true,
    completedAt: "2026-08-08T00:00:00.000Z"
  }, "lease-same-time");

  await service.create(SCOPE, CREATE_INPUT, "same-time-retry");
  await assert.rejects(
    service.create(SCOPE, CREATE_INPUT, "same-time-third"),
    (error: unknown) =>
      error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
});

test("create rejects duplicate source evidence IDs", async () => {
  const { service } = fixture();

  await assert.rejects(
    service.create(SCOPE, {
      ...CREATE_INPUT,
      sourceEvidenceIds: ["evidence-a", "evidence-a"]
    }, "duplicate-source-key"),
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "INVALID_REQUEST"
  );
});

test("create rejects an untrusted plan session before persistence", async () => {
  const { service, repository } = fixture();

  await assert.rejects(
    service.create(SCOPE, {
      ...CREATE_INPUT,
      planSessionId: "model-session:not-a-frozen-plan"
    }, "invalid-plan-session"),
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "INVALID_REQUEST"
  );
  assert.equal(
    await repository.findOperationByIdempotency({
      ownerId: SCOPE.ownerId,
      teamId: SCOPE.teamId,
      idempotencyKeyHash: createHash("sha256")
        .update("invalid-plan-session")
        .digest("hex")
    }),
    null
  );
});

test("latest candidate lookup is tenant scoped", async () => {
  const { service, evidenceById } = fixture();
  const otherScope = { ...SCOPE, ownerId: "owner-b", actorId: "actor-b" };
  evidenceById.set("evidence-other", {
    ...evidence("evidence-other", "sha256:content-other", "sha256:raw-other"),
    ownerId: otherScope.ownerId
  });
  const first = await service.create(SCOPE, {
    ...CREATE_INPUT,
    sourceEvidenceIds: ["evidence-a"]
  }, "latest-a");
  const other = await service.create(otherScope, {
    ...CREATE_INPUT,
    sourceEvidenceIds: ["evidence-other"]
  }, "latest-b");

  assert.equal(
    (await service.findLatestForCandidate(SCOPE, "candidate-1"))?.id,
    first.id
  );
  assert.equal(
    (await service.findLatestForCandidate(otherScope, "candidate-1"))?.id,
    other.id
  );
  assert.equal(
    await service.findLatestForCandidate(
      { ...SCOPE, teamId: "other-team" },
      "candidate-1"
    ),
    null
  );
});

test("only the active lease token can save an operation", async () => {
  const { service, repository } = fixture();
  const created = await service.create(SCOPE, CREATE_INPUT, "lease-save");
  const claimed = await repository.claimOperation(SCOPE, created.id, {
    leaseOwner: "worker-a",
    leaseToken: "lease-token-a",
    claimedAt: "2026-08-08T00:01:00.000Z",
    leaseExpiresAt: "2026-08-08T00:11:00.000Z"
  });
  assert.equal(claimed.claimed, true);
  const completed = {
    ...claimed.operation!,
    status: "succeeded" as const,
    outcome: "verified_consensus" as const,
    completedAt: "2026-08-08T00:02:00.000Z",
    updatedAt: "2026-08-08T00:02:00.000Z"
  };

  await assert.rejects(
    repository.saveOperation(completed, "lease-token-b"),
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  await repository.saveOperation(completed, "lease-token-a");
  assert.equal((await repository.getOperation(SCOPE, created.id))?.status, "succeeded");
});

test("concurrent claimants produce exactly one lease winner", async () => {
  const { service, repository } = fixture();
  const created = await service.create(SCOPE, CREATE_INPUT, "concurrent-claim");
  const claims = [
    {
      leaseOwner: "worker-a",
      leaseToken: "lease-token-a",
      claimedAt: "2026-08-08T00:01:00.000Z",
      leaseExpiresAt: "2026-08-08T00:11:00.000Z"
    },
    {
      leaseOwner: "worker-b",
      leaseToken: "lease-token-b",
      claimedAt: "2026-08-08T00:01:00.000Z",
      leaseExpiresAt: "2026-08-08T00:11:00.000Z"
    }
  ];

  const results = await Promise.all(claims.map((claim) =>
    repository.claimOperation(SCOPE, created.id, claim)
  ));
  const winners = results.filter((result) => result.claimed);
  const stored = await repository.getOperation(SCOPE, created.id);

  assert.equal(winners.length, 1);
  assert.equal(stored?.leaseToken, winners[0]?.operation?.leaseToken);
  assert.equal(stored?.leaseOwner, winners[0]?.operation?.leaseOwner);
});

test("request identity replays across case and non-ASCII ordering without localeCompare", async () => {
  const { service, evidenceById } = fixture();
  evidenceById.set(
    "Evidence-Z",
    evidence("Evidence-Z", "sha256:内容-Z", "sha256:原文-Z")
  );
  evidenceById.set(
    "证据-é",
    evidence("证据-é", "sha256:内容-é", "sha256:原文-é")
  );
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = function forbiddenLocaleCompare() {
    throw new Error("localeCompare must not define request identity");
  };
  try {
    const created = await service.create(SCOPE, {
      ...CREATE_INPUT,
      sourceEvidenceIds: ["证据-é", "Evidence-Z"],
      searchConnections: searchConnections("搜索-é", "Connection-Z")
    }, "locale-independent-request");
    const replayed = await service.create(SCOPE, {
      ...CREATE_INPUT,
      sourceEvidenceIds: ["Evidence-Z", "证据-é"],
      searchConnections: searchConnections("Connection-Z", "搜索-é")
    }, "locale-independent-request");

    assert.deepEqual(replayed, created);
    assert.deepEqual(
      created.searchConnections.map((connection) => connection.connectionId),
      ["Connection-Z", "搜索-é"]
    );
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

test("terminal operations are never claimed", async () => {
  const { service, repository } = fixture();
  for (const status of ["succeeded", "requires_review", "failed"] as const) {
    const created = await service.create(SCOPE, {
      ...CREATE_INPUT,
      candidateId: `candidate-${status}`
    }, `terminal-${status}`);
    const firstClaim = await repository.claimOperation(SCOPE, created.id, {
      leaseOwner: "worker-a",
      leaseToken: `token-${status}`,
      claimedAt: "2026-08-08T00:01:00.000Z",
      leaseExpiresAt: "2026-08-08T00:11:00.000Z"
    });
    await repository.saveOperation({
      ...firstClaim.operation!,
      status,
      retryable: status === "failed",
      outcome: status === "succeeded" ? "verified_consensus" : "ambiguous",
      updatedAt: "2026-08-08T00:02:00.000Z",
      completedAt: "2026-08-08T00:02:00.000Z"
    }, `token-${status}`);

    const secondClaim = await repository.claimOperation(SCOPE, created.id, {
      leaseOwner: "worker-b",
      leaseToken: `second-${status}`,
      claimedAt: "2026-08-08T01:00:00.000Z",
      leaseExpiresAt: "2026-08-08T01:10:00.000Z"
    });
    assert.equal(secondClaim.claimed, false, status);
  }
});

test("recovery returns queued and expired-running operations in creation order", async () => {
  const { service, repository, setNow } = fixture();
  const queued = await service.create(SCOPE, {
    ...CREATE_INPUT,
    candidateId: "candidate-recovery-queued"
  }, "recovery-queued");
  setNow("2026-08-08T00:00:01.000Z");
  const expired = await service.create(SCOPE, {
    ...CREATE_INPUT,
    candidateId: "candidate-recovery-expired"
  }, "recovery-expired");
  await repository.claimOperation(SCOPE, expired.id, {
    leaseOwner: "worker-old",
    leaseToken: "expired-token",
    claimedAt: "2026-08-08T00:00:02.000Z",
    leaseExpiresAt: "2026-08-08T00:01:00.000Z"
  });
  setNow("2026-08-08T00:00:03.000Z");
  const active = await service.create(SCOPE, {
    ...CREATE_INPUT,
    candidateId: "candidate-recovery-active"
  }, "recovery-active");
  await repository.claimOperation(SCOPE, active.id, {
    leaseOwner: "worker-active",
    leaseToken: "active-token",
    claimedAt: "2026-08-08T00:00:04.000Z",
    leaseExpiresAt: "2026-08-08T02:00:00.000Z"
  });

  const recoverable = await repository.listRecoverableOperations({
    now: "2026-08-08T01:00:00.000Z",
    limit: 100
  });

  assert.deepEqual(recoverable.map((operation) => operation.id), [
    queued.id,
    expired.id
  ]);
});

const PROFILE_URL = "https://www.douyin.com/user/MS4wLjABAAAAverified";
const OTHER_PROFILE_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAconflicting";
const SOURCE_URL = "https://www.douyin.com/video/7536012345678901234";

type ExecutionScenario =
  | "verified"
  | "not_found"
  | "insufficient_evidence"
  | "ambiguous"
  | "conflicting"
  | "access_restricted"
  | "redirect_not_allowed"
  | "profile_redirect_mismatch"
  | "commit_then_crash"
  | "commit_stale_race"
  | "commit_identity_conflict"
  | "duplicate_search_url_records"
  | "search_append_then_crash"
  | "stale_candidate"
  | "provider_unavailable";

function executionFixture(
  scenario: ExecutionScenario,
  options: {
    beforeDiscover?: (sourceUrl: string) => Promise<void>;
    beforeGetCandidate?: (call: number) => Promise<void>;
    afterValidateSearchConnection?: () => Promise<void>;
    search?: SearchPublicSourcesPort;
    searchResponseCredentialVersion?: number;
    heartbeatIntervalMs?: number;
    heartbeatScheduler?: {
      setInterval(callback: () => void, delayMs: number): unknown;
      clearInterval(handle: unknown): void;
    };
    leaseDurationMs?: number;
    now?: () => string;
    afterSaveOperation?: (
      repository: InMemoryAcquisitionDouyinIdentityResolutionOperationRepository,
      operation: AcquisitionDouyinIdentityResolutionOperationRecord
    ) => Promise<void>;
  } = {}
) {
  class FixtureRepository
  extends InMemoryAcquisitionDouyinIdentityResolutionOperationRepository {
    override async saveOperation(
      operation: AcquisitionDouyinIdentityResolutionOperationRecord,
      leaseToken: string
    ) {
      await super.saveOperation(operation, leaseToken);
      await options.afterSaveOperation?.(this, structuredClone(operation));
    }
  }
  const repository = new FixtureRepository();
  const sourceEvidence: DiscoveryEvidence = {
    ...evidence(
      "source-evidence",
      "sha256:source-content",
      "sha256:source-raw"
    ),
    sourceTitle: "厦门门店主理人寻找 AI 获客方案",
    sourceSnippet: "作者线索：林老师，近期正在比较供应商。",
    provenance: {
      kind: "user_submitted_url",
      sourceUrl: SOURCE_URL,
      submittedBy: SCOPE.actorId
    }
  };
  const evidenceById = new Map([[sourceEvidence.id, sourceEvidence]]);
  const evidenceByIdempotencyKey = new Map<string, {
    input: unknown;
    evidence: DiscoveryEvidence;
  }>();
  const appendedEvidence: DiscoveryEvidence[] = [];
  const discoveryCalls: string[] = [];
  const searchCalls: Array<{
    providerConnectionId: string;
    query: string;
    sessionId: string;
  }> = [];
  const identityCommits: Array<{
    candidateId: string;
    input: {
      expectedCandidateVersion: number;
      evidenceIds: string[];
      subject: { publicProfileUrl: string };
    };
    idempotencyKey: string;
  }> = [];
  const intelligenceCreates: Array<{
    candidateId: string;
    idempotencyKey: string;
    options: { trustedSessionId?: string };
  }> = [];
  const intelligenceExecutes: string[] = [];
  const validatedSearchConnections: Array<{
    connectionId: string;
    providerId: string;
    kind: "search";
    status: "active";
    credentialVersion: number;
  }> = [];
  const committedIdentityKeys = new Set<string>();
  let generatedEvidence = 0;
  let generatedOperation = 0;
  let crashedAfterSearchAppend = false;
  let candidateVersion = scenario === "stale_candidate" ? 4 : 3;
  let currentCredentialVersion = 1;
  let candidateReads = 0;

  const discoveryResult = (
    sourceUrl: string
  ): DouyinPublicProfileDiscoveryResult => {
    if (sourceUrl === SOURCE_URL) {
      if (scenario === "not_found") {
        return { status: "not_found", redirectChain: [SOURCE_URL], publicProfileUrls: [] };
      }
      if (scenario === "access_restricted") {
        return { status: "access_restricted", redirectChain: [SOURCE_URL], publicProfileUrls: [] };
      }
      if (scenario === "redirect_not_allowed") {
        return { status: "redirect_not_allowed", redirectChain: [], publicProfileUrls: [] };
      }
      return {
        status: "succeeded",
        redirectChain: [SOURCE_URL],
        publicProfileUrls: scenario === "ambiguous"
          ? [PROFILE_URL, OTHER_PROFILE_URL]
          : [PROFILE_URL],
        rawArtifactHash: "sha256:source-page-raw",
        contentHash: "sha256:source-page-content"
      };
    }
    if (scenario === "profile_redirect_mismatch"
      && sourceUrl === PROFILE_URL) {
      return {
        status: "succeeded",
        redirectChain: [PROFILE_URL, OTHER_PROFILE_URL],
        publicProfileUrls: [OTHER_PROFILE_URL],
        rawArtifactHash: "sha256:redirected-profile-page-raw",
        contentHash: "sha256:redirected-profile-page-content"
      };
    }
    return {
      status: "succeeded",
      redirectChain: [sourceUrl],
      publicProfileUrls: [sourceUrl],
      rawArtifactHash: sourceUrl === PROFILE_URL
        ? "sha256:profile-page-raw"
        : "sha256:other-profile-page-raw",
      contentHash: sourceUrl === PROFILE_URL
        ? "sha256:profile-page-content"
        : "sha256:other-profile-page-content"
    };
  };

  const searchResponse = (
    connectionId: string,
    requestSequence: number
  ): SearchPublicSourcesResponse => {
    const result: SearchPublicSourcesResponse["results"][number] = {
      providerRecordId: `record-${connectionId}`,
      sourceUrl: scenario === "conflicting"
        ? OTHER_PROFILE_URL
        : PROFILE_URL,
      sourcePlatform: "douyin",
      sourceType: "profile",
      title: "林老师的抖音主页",
      snippet: "厦门门店主理人",
      publishedAt: null,
      locale: "zh-CN",
      rawArtifactHash: `sha256:search-raw-${connectionId}`,
      accessStatus: "indexed_summary",
      subject: {
        kind: "individual",
        publicActorKey: "douyin:lin",
        publicDisplayName: "林老师",
        publicProfileUrl: scenario === "conflicting"
          ? OTHER_PROFILE_URL
          : PROFILE_URL,
        sourcePlatform: "douyin",
        demandCategory: "AI 获客",
        demandSummary: "比较供应商",
        locationHint: "厦门",
        buyingStage: "comparison",
        negativeSignals: []
      }
    };
    return {
      providerConnectionId: connectionId,
      providerCredentialVersion:
        options.searchResponseCredentialVersion ?? 1,
      provider: "baidu-search",
      requestId: scenario === "search_append_then_crash"
        ? `request-${connectionId}-${requestSequence}`
        : `request-${connectionId}`,
      results: scenario === "not_found"
        || scenario === "insufficient_evidence"
        || scenario === "ambiguous"
        || scenario === "access_restricted"
        || scenario === "redirect_not_allowed"
        ? []
        : scenario === "duplicate_search_url_records"
          ? [result, {
              ...result,
              providerRecordId: `record-${connectionId}-duplicate`,
              rawArtifactHash: `sha256:search-raw-${connectionId}-duplicate`
            }]
          : [result]
    };
  };

  const service = new AcquisitionDouyinIdentityResolutionOperationService({
    repository,
    evidence: {
      async getEvidence(candidateScope, evidenceId) {
        const item = evidenceById.get(evidenceId);
        return item
          && item.ownerId === candidateScope.ownerId
          && item.teamId === candidateScope.teamId
          ? structuredClone(item)
          : null;
      },
      async appendEvidence(_candidateScope, input, idempotencyKey) {
        const existing = evidenceByIdempotencyKey.get(idempotencyKey);
        if (existing) {
          if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
            throw new Error("simulated evidence idempotency conflict");
          }
          return structuredClone(existing.evidence);
        }
        const item: DiscoveryEvidence = {
          ...input,
          id: `verified-evidence-${++generatedEvidence}`,
          ownerId: SCOPE.ownerId,
          teamId: SCOPE.teamId,
          fetchedAt: "2026-08-08T00:00:00.000Z",
          supersedesEvidenceId: input.supersedesEvidenceId ?? null
        };
        evidenceById.set(item.id, item);
        evidenceByIdempotencyKey.set(idempotencyKey, {
          input: structuredClone(input),
          evidence: structuredClone(item)
        });
        appendedEvidence.push(structuredClone(item));
        if (scenario === "search_append_then_crash"
          && input.provenance.kind === "search_result"
          && !crashedAfterSearchAppend) {
          crashedAfterSearchAppend = true;
          throw new Error("simulated crash after search evidence append");
        }
        return structuredClone(item);
      }
    },
    candidates: {
      async getCandidate() {
        candidateReads += 1;
        await options.beforeGetCandidate?.(candidateReads);
        return {
          id: "candidate-1",
          version: candidateVersion
        };
      }
    },
    discovery: {
      async discover(input) {
        await options.beforeDiscover?.(input.sourceUrl);
        discoveryCalls.push(input.sourceUrl);
        return discoveryResult(input.sourceUrl);
      }
    },
    search: options.search ?? {
      async search(input) {
        searchCalls.push({
          providerConnectionId: input.providerConnectionId,
          query: input.query,
          sessionId: input.sessionId
        });
        if (scenario === "provider_unavailable") {
          throw new Error("provider temporarily unavailable");
        }
        if (input.providerConnectionId === "search-connection-failed") {
          throw new Error("one provider failed");
        }
        return searchResponse(
          input.providerConnectionId,
          searchCalls.length
        );
      }
    },
    async validateSearchConnection(input) {
      validatedSearchConnections.push(structuredClone(input.connection));
      if (input.connection.credentialVersion !== currentCredentialVersion) {
        throw new Error("simulated rotated provider credential");
      }
      await options.afterValidateSearchConnection?.();
    },
    identityResolution: {
      async resolveCandidateIdentity(
        _candidateScope,
        candidateId,
        input,
        idempotencyKey
      ) {
        if (committedIdentityKeys.has(idempotencyKey)) return {} as never;
        committedIdentityKeys.add(idempotencyKey);
        identityCommits.push({
          candidateId,
          input: structuredClone(input),
          idempotencyKey
        });
        if (scenario === "commit_then_crash") {
          candidateVersion = 4;
          throw new Error("simulated crash after identity commit");
        }
        if (scenario === "commit_stale_race") {
          throw new AcquisitionDomainError(
            "stale_candidate",
            "simulated candidate version race"
          );
        }
        if (scenario === "commit_identity_conflict") {
          throw new AcquisitionDomainError(
            "identity_conflict",
            "simulated alias conflict"
          );
        }
        return {} as never;
      }
    },
    candidateIntelligence: {
      async createAfterIdentity(
        _candidateScope,
        candidateId,
        idempotencyKey,
        options = {}
      ) {
        intelligenceCreates.push({ candidateId, idempotencyKey, options });
        return {
          id: "candidate-intelligence-1",
          candidateId,
          status: "queued"
        } as never;
      },
      async execute(_candidateScope, operationId) {
        intelligenceExecutes.push(operationId);
        return {
          id: operationId,
          candidateId: "candidate-1",
          status: "succeeded"
        } as never;
      }
    },
    workerId: "identity-worker",
    leaseTokenFactory: () => "identity-lease",
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatScheduler: options.heartbeatScheduler,
    idFactory: () => `identity-operation-${++generatedOperation}`,
    now: options.now ?? (() => "2026-08-08T00:00:00.000Z")
  });

  return {
    service,
    repository,
    appendedEvidence,
    discoveryCalls,
    searchCalls,
    identityCommits,
    intelligenceCreates,
    intelligenceExecutes,
    validatedSearchConnections,
    setCandidateVersion(value: number) {
      candidateVersion = value;
    },
    setCredentialVersion(value: number) {
      currentCredentialVersion = value;
    }
  };
}

test("executes public-page and independent-search verification before one identity and intelligence chain", async () => {
  const state = executionFixture("verified");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections(
      "search-connection-failed",
      "search-connection-success"
    ),
    planSessionId: "acquisition-plan:run-123"
  }, "verified-operation-key");

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.outcome, "verified_consensus");
  assert.equal(completed.canonicalProfileUrl, PROFILE_URL);
  assert.deepEqual(state.discoveryCalls, [SOURCE_URL, PROFILE_URL]);
  assert.equal(state.searchCalls.length, 2);
  assert.match(state.searchCalls[0]!.query, /7536012345678901234/u);
  assert.match(state.searchCalls[0]!.query, /林老师/u);
  assert.equal(state.appendedEvidence.length, 2);
  assert.deepEqual(state.appendedEvidence[0]?.provenance, {
    kind: "controlled_public_page",
    sourceUrl: PROFILE_URL,
    discoveredFromEvidenceId: "source-evidence",
    redirectChain: [PROFILE_URL],
    extractorVersion: "douyin-public-profile-v1"
  });
  assert.deepEqual(state.appendedEvidence[1]?.provenance, {
    kind: "search_result",
    provider: "baidu-search",
    providerConnectionId: "search-connection-success",
    requestId: "request-search-connection-success",
    providerRecordId: "record-search-connection-success",
    queryText: state.searchCalls[1]!.query,
    sourceUrl: PROFILE_URL,
    resultRank: 1,
    sourceType: "profile"
  });
  assert.equal(state.identityCommits.length, 1);
  assert.equal(state.identityCommits[0]?.input.expectedCandidateVersion, 3);
  assert.deepEqual(state.identityCommits[0]?.input.evidenceIds, [
    "verified-evidence-1",
    "verified-evidence-2"
  ]);
  assert.equal(
    state.identityCommits[0]?.idempotencyKey.startsWith(
      "douyin-identity:commit:sha256:"
    ),
    true
  );
  assert.equal(state.intelligenceCreates.length, 1);
  assert.equal(
    state.intelligenceCreates[0]?.idempotencyKey.startsWith(
      "douyin-identity:intelligence:sha256:"
    ),
    true
  );
  assert.deepEqual(state.intelligenceCreates[0]?.options, {
    trustedSessionId: "acquisition-plan:run-123"
  });
  assert.deepEqual(state.intelligenceExecutes, ["candidate-intelligence-1"]);

  const replay = await state.service.execute(SCOPE, created.id);
  assert.deepEqual(replay, completed);
  assert.equal(state.identityCommits.length, 1);
  assert.equal(state.intelligenceCreates.length, 1);
  assert.equal(state.intelligenceExecutes.length, 1);
});

test("finds successful identity intelligence ownership for one frozen Run", async () => {
  const state = executionFixture("verified");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-owned"
  }, "owned-run-operation");
  const completed = await state.service.execute(SCOPE, created.id);

  const owned = await state.service
    .findSucceededForCandidateAndPlanSession(
      SCOPE,
      "candidate-1",
      "acquisition-plan:run-owned"
    );

  assert.deepEqual(owned, completed);
  assert.equal(owned?.intelligenceOperationId, "candidate-intelligence-1");
});

test("rejects a requested profile when its page redirects to and proves another profile", async () => {
  const state = executionFixture("profile_redirect_mismatch");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-profile-ownership"
  }, "profile-ownership-mismatch");

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "requires_review");
  assert.equal(completed.outcome, "redirect_not_allowed");
  assert.equal(
    state.appendedEvidence.some((item) =>
      item.provenance.kind === "controlled_public_page"),
    false
  );
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("persists duplicate search URL records under provenance-specific idempotency keys", async () => {
  const state = executionFixture("duplicate_search_url_records");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-duplicate-search"
  }, "duplicate-search-records");

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.outcome, "verified_consensus");
  assert.equal(state.appendedEvidence.length, 3);
  assert.equal(state.identityCommits.length, 1);
  assert.equal(state.intelligenceCreates.length, 1);
});

test("research replay with a new audited request reaches a terminal operation", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  const state = executionFixture("search_append_then_crash", {
    now: () => now
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-search-replay"
  }, "search-replay-operation");
  await assert.rejects(
    state.service.execute(SCOPE, created.id),
    /simulated crash after search evidence append/u
  );
  now = "2026-08-08T00:02:00.000Z";

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.outcome, "verified_consensus");
  assert.equal(state.searchCalls.length, 2);
  assert.equal(state.identityCommits.length, 1);
  assert.equal(state.intelligenceCreates.length, 1);
});

test("recovery fails closed when a frozen search credential has rotated", async () => {
  const state = executionFixture("verified");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-rotated-search"
  }, "rotated-search-recovery");
  const crashed = await state.repository.claimOperation(SCOPE, created.id, {
    leaseOwner: "crashed-worker",
    leaseToken: "crashed-lease",
    claimedAt: "2026-08-07T23:58:00.000Z",
    leaseExpiresAt: "2026-08-07T23:59:00.000Z"
  });
  await state.repository.saveOperation({
    ...crashed.operation!,
    currentStage: "independent_search"
  }, "crashed-lease");
  state.setCredentialVersion(2);

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "failed");
  assert.equal(completed.outcome, "provider_unavailable");
  assert.deepEqual(state.validatedSearchConnections, searchConnections(
    "search-connection-success"
  ));
  assert.deepEqual(state.searchCalls, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("rejects audited search provenance from a different credential version", async () => {
  const state = executionFixture("verified", {
    searchResponseCredentialVersion: 2
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-response-version-mismatch"
  }, "response-version-mismatch");

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "failed");
  assert.equal(completed.outcome, "provider_unavailable");
  assert.equal(state.searchCalls.length, 1);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("rejects a credential rotated between identity validation and actual public search use", async () => {
  const credentialSecret =
    "identity-search-rotation-test-secret-at-least-32-characters";
  function liveConnection(credentialVersion: number): ProviderConnection {
    const identity = {
      id: "identity-search-connection",
      providerId: "baidu_ai_search",
      ownerId: SCOPE.ownerId,
      teamId: SCOPE.teamId
    };
    return {
      ...identity,
      scope: "personal",
      credentialRef: "credential_identity_search",
      credentialVersion,
      configurationEncrypted: encryptProviderConfigurationWithSecret(
        identity,
        { apiKey: `official-key-v${credentialVersion}`, baseUrl: "" },
        credentialSecret
      ),
      status: "active",
      quotaPolicy: {},
      budgetPolicy: {},
      lastHealthAt: "",
      lastHealthStatus: "untested",
      lastErrorCode: "",
      lastHealthMessage: "",
      usage: "",
      createdBy: SCOPE.ownerId,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: `2026-08-08T00:00:0${credentialVersion}.000Z`
    };
  }
  const store: AcquisitionPublicSearchStore = {
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [liveConnection(1)],
    providerRequestLogs: [],
    async persist() {}
  };
  const executedCredentialVersions: number[] = [];
  const search = createAcquisitionPublicSearchPort(store, {
    credentialSecret,
    async executeSearch(input) {
      executedCredentialVersions.push(
        Number(input.connection.credentialVersion)
      );
      input.onLogs([{
        id: `rotation-log-${executedCredentialVersions.length}`,
        teamId: input.context.teamId,
        ownerId: input.context.ownerId,
        providerId: input.provider.id,
        connectionId: input.connection.id,
        runId: input.context.runId,
        runShardId: input.context.runShardId,
        requestFingerprint: "a".repeat(64),
        endpointCode: "search",
        httpStatus: 200,
        attempt: 1,
        quotaUnits: 1,
        costAmount: 0,
        currency: "",
        durationMs: 1,
        responseSize: 100,
        errorCode: "",
        requestedAt: "2026-08-08T00:00:00.000Z"
      }]);
      const page: ProviderPage = {
        status: "success",
        records: [{
          company: "林老师",
          officialWebsite: "",
          website: "",
          country: "中国 厦门",
          business: "门店经营",
          contact: "",
          contactInfo: "",
          description: "正在比较 AI 获客供应商",
          confidence: 0,
          providerRecordId: "rotated-search-record",
          sourceUrl: PROFILE_URL,
          recordType: "discovery_page",
          fetchedAt: "2026-08-08T00:00:00.000Z",
          payloadHash: "b".repeat(64),
          evidenceSummary: "独立公开搜索索引证据",
          matchedFields: ["company", "description", "sourceUrl"],
          adapterVersion: "1.0",
          catalogPolicyVersion: "1.0",
          sourceLevel: "discovery",
          retentionPolicyRef: "public"
        }],
        nextCursor: null,
        exhausted: true,
        rawCount: 1,
        validCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        warnings: [],
        usage: {
          requestCount: 1,
          quotaUsed: 1,
          quotaRemaining: null,
          costAmount: null,
          currency: null,
          estimated: false,
          display: ""
        }
      };
      return page;
    }
  });
  let rotated = false;
  const state = executionFixture("verified", {
    search,
    async afterValidateSearchConnection() {
      if (rotated) return;
      rotated = true;
      store.providerConnections.splice(0, 1, liveConnection(2));
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: [{
      connectionId: "identity-search-connection",
      providerId: "baidu_ai_search",
      kind: "search",
      status: "active",
      credentialVersion: 1
    }],
    planSessionId: "acquisition-plan:run-use-boundary-rotation"
  }, "credential-use-boundary-rotation");

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(rotated, true);
  assert.equal(completed.status, "failed");
  assert.equal(completed.outcome, "provider_unavailable");
  assert.deepEqual(executedCredentialVersions, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

for (const expected of [
  { scenario: "commit_stale_race", outcome: "stale_candidate" },
  { scenario: "commit_identity_conflict", outcome: "conflicting" }
] as const) {
  test(`${expected.scenario} becomes a terminal review outcome`, async () => {
    const state = executionFixture(expected.scenario);
    const created = await state.service.create(SCOPE, {
      candidateId: "candidate-1",
      expectedCandidateVersion: 3,
      sourceEvidenceIds: ["source-evidence"],
      searchConnections: searchConnections("search-connection-success"),
      planSessionId: "acquisition-plan:run-commit-race"
    }, `terminal-${expected.scenario}`);

    const completed = await state.service.execute(SCOPE, created.id);

    assert.equal(completed.status, "requires_review");
    assert.equal(completed.outcome, expected.outcome);
    assert.equal(state.identityCommits.length, 1);
    assert.deepEqual(state.intelligenceCreates, []);

    const replayed = await state.service.execute(SCOPE, created.id);
    assert.deepEqual(replayed, completed);
    assert.equal(state.identityCommits.length, 1);
  });
}

test("lease recovery resumes persisted intelligence dispatch without repeating identity confirmation", async () => {
  const state = executionFixture("verified");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-recovery"
  }, "recover-intelligence-dispatch");
  const oldClaim = await state.repository.claimOperation(SCOPE, created.id, {
    leaseOwner: "crashed-worker",
    leaseToken: "crashed-lease",
    claimedAt: "2026-08-07T23:58:00.000Z",
    leaseExpiresAt: "2026-08-07T23:59:00.000Z"
  });
  await state.repository.saveOperation({
    ...oldClaim.operation!,
    currentStage: "intelligence_dispatch",
    outcome: "verified_consensus",
    canonicalProfileUrl: PROFILE_URL,
    profileCandidates: [{
      publicProfileUrl: PROFILE_URL,
      evidenceIds: ["verified-evidence-public", "verified-evidence-search"]
    }],
    intelligenceOperationId: "candidate-intelligence-1"
  }, "crashed-lease");
  state.setCandidateVersion(4);

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.outcome, "verified_consensus");
  assert.deepEqual(state.discoveryCalls, []);
  assert.deepEqual(state.searchCalls, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
  assert.deepEqual(state.intelligenceExecutes, ["candidate-intelligence-1"]);
});

test("recovery replays a committed identity before dispatch without becoming stale", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  const state = executionFixture("commit_then_crash", { now: () => now });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-commit-crash"
  }, "commit-crash-operation");

  await assert.rejects(
    state.service.execute(SCOPE, created.id),
    /simulated crash after identity commit/u
  );
  const interrupted = await state.repository.getOperation(SCOPE, created.id);
  assert.equal(interrupted?.currentStage, "identity_confirmation");
  assert.equal(interrupted?.outcome, "verified_consensus");
  now = "2026-08-08T00:02:00.000Z";

  const completed = await state.service.execute(SCOPE, created.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.outcome, "verified_consensus");
  assert.equal(state.identityCommits.length, 1);
  assert.equal(state.intelligenceCreates.length, 1);
  assert.deepEqual(state.intelligenceExecutes, ["candidate-intelligence-1"]);
  assert.deepEqual(state.discoveryCalls, [SOURCE_URL, PROFILE_URL]);
  assert.equal(state.searchCalls.length, 1);
});

test("renews the identity lease while public verification is still running", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  let releaseDiscovery!: () => void;
  let discoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    discoveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const heartbeatCallbacks: Array<() => void> = [];
  const clearedHandles: unknown[] = [];
  const savedLeaseExpiriesAfterRenewal: Array<string | null> = [];
  const state = executionFixture("verified", {
    now: () => now,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    heartbeatScheduler: {
      setInterval(callback) {
        heartbeatCallbacks.push(callback);
        return callback;
      },
      clearInterval(handle) {
        clearedHandles.push(handle);
      }
    },
    async afterSaveOperation(_repository, operation) {
      if (now === "2026-08-08T00:00:05.000Z") {
        savedLeaseExpiriesAfterRenewal.push(operation.leaseExpiresAt);
      }
    },
    async beforeDiscover(sourceUrl) {
      if (sourceUrl !== SOURCE_URL) return;
      discoveryStarted();
      await blocked;
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-heartbeat"
  }, "heartbeat-operation");

  const execution = state.service.execute(SCOPE, created.id);
  await started;
  assert.equal(heartbeatCallbacks.length, 1);
  now = "2026-08-08T00:00:05.000Z";
  heartbeatCallbacks[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    (await state.repository.getOperation(SCOPE, created.id))?.leaseExpiresAt,
    "2026-08-08T00:00:15.000Z"
  );
  releaseDiscovery();

  assert.equal((await execution).status, "succeeded");
  assert.equal(savedLeaseExpiriesAfterRenewal.length > 0, true);
  assert.equal(
    savedLeaseExpiriesAfterRenewal.every((value) =>
      value === "2026-08-08T00:00:15.000Z"),
    true
  );
  assert.deepEqual(clearedHandles, [heartbeatCallbacks[0]]);
});

test("aborts before evidence mutation when the identity lease is lost", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  let releaseDiscovery!: () => void;
  let discoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    discoveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const heartbeatCallbacks: Array<() => void> = [];
  const state = executionFixture("verified", {
    now: () => now,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    heartbeatScheduler: {
      setInterval(callback) {
        heartbeatCallbacks.push(callback);
        return callback;
      },
      clearInterval() {}
    },
    async beforeDiscover(sourceUrl) {
      if (sourceUrl !== SOURCE_URL) return;
      discoveryStarted();
      await blocked;
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-lease-loss"
  }, "lease-loss-operation");
  const execution = state.service.execute(SCOPE, created.id);
  await started;
  now = "2026-08-08T00:00:11.000Z";
  const replacement = await state.repository.claimOperation(
    SCOPE,
    created.id,
    {
      leaseOwner: "replacement-worker",
      leaseToken: "replacement-lease",
      claimedAt: now,
      leaseExpiresAt: "2026-08-08T00:00:21.000Z"
    }
  );
  assert.equal(replacement.claimed, true);
  heartbeatCallbacks[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseDiscovery();

  await assert.rejects(
    execution,
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  assert.deepEqual(state.appendedEvidence, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("synchronously fences evidence mutation after an expired lease is reclaimed", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  let releaseDiscovery!: () => void;
  let discoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    discoveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const state = executionFixture("verified", {
    now: () => now,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    heartbeatScheduler: {
      setInterval(callback) {
        return callback;
      },
      clearInterval() {}
    },
    async beforeDiscover(sourceUrl) {
      if (sourceUrl !== SOURCE_URL) return;
      discoveryStarted();
      await blocked;
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-sync-fence"
  }, "sync-fence-operation");
  const execution = state.service.execute(SCOPE, created.id);
  await started;
  now = "2026-08-08T00:00:11.000Z";
  const replacement = await state.repository.claimOperation(
    SCOPE,
    created.id,
    {
      leaseOwner: "replacement-worker",
      leaseToken: "replacement-lease",
      claimedAt: now,
      leaseExpiresAt: "2026-08-08T00:00:21.000Z"
    }
  );
  assert.equal(replacement.claimed, true);
  releaseDiscovery();

  await assert.rejects(
    execution,
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  assert.deepEqual(state.appendedEvidence, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("synchronously fences intelligence dispatch after its lease is reclaimed", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  let reclaimed = false;
  const state = executionFixture("verified", {
    now: () => now,
    async afterSaveOperation(repository, operation) {
      if (reclaimed || !operation.intelligenceOperationId) return;
      reclaimed = true;
      now = "2026-08-08T00:02:00.000Z";
      const replacement = await repository.claimOperation(
        SCOPE,
        operation.id,
        {
          leaseOwner: "replacement-worker",
          leaseToken: "replacement-lease",
          claimedAt: now,
          leaseExpiresAt: "2026-08-08T00:03:00.000Z"
        }
      );
      assert.equal(replacement.claimed, true);
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-dispatch-fence"
  }, "dispatch-fence-operation");

  await assert.rejects(
    state.service.execute(SCOPE, created.id),
    (error: unknown) =>
      error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  assert.equal(state.intelligenceCreates.length, 1);
  assert.deepEqual(state.intelligenceExecutes, []);
});

test("synchronously fences consensus persistence after its lease expires", async () => {
  let now = "2026-08-08T00:00:00.000Z";
  let releaseCandidateRead!: () => void;
  let candidateReadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    candidateReadStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseCandidateRead = resolve;
  });
  const state = executionFixture("verified", {
    now: () => now,
    leaseDurationMs: 10_000,
    async beforeGetCandidate(call) {
      if (call !== 1) return;
      candidateReadStarted();
      await blocked;
    }
  });
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: "acquisition-plan:run-consensus-fence"
  }, "consensus-fence-operation");

  const execution = state.service.execute(SCOPE, created.id);
  await started;
  now = "2026-08-08T00:00:11.000Z";
  releaseCandidateRead();

  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "OPERATION_ALREADY_RUNNING"
  );
  const persisted = await state.repository.getOperation(SCOPE, created.id);
  assert.equal(persisted?.currentStage, "consensus_gate");
  assert.equal(persisted?.outcome, null);
  assert.equal(persisted?.canonicalProfileUrl, null);
  assert.deepEqual(persisted?.profileCandidates, []);
  assert.deepEqual(persisted?.evidence, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

test("persisted invalid plan sessions fail before evidence or identity side effects", async () => {
  const state = executionFixture("verified");
  const created = await state.service.create(SCOPE, {
    candidateId: "candidate-1",
    expectedCandidateVersion: 3,
    sourceEvidenceIds: ["source-evidence"],
    searchConnections: searchConnections("search-connection-success"),
    planSessionId: null
  }, "persisted-invalid-session");
  const oldClaim = await state.repository.claimOperation(SCOPE, created.id, {
    leaseOwner: "corrupting-worker",
    leaseToken: "corrupting-lease",
    claimedAt: "2026-08-07T23:58:00.000Z",
    leaseExpiresAt: "2026-08-07T23:59:00.000Z"
  });
  await state.repository.saveOperation({
    ...oldClaim.operation!,
    planSessionId: "model-session:not-a-frozen-plan"
  }, "corrupting-lease");

  await assert.rejects(
    state.service.execute(SCOPE, created.id),
    (error: unknown) => error instanceof AcquisitionDouyinIdentityResolutionOperationError
      && error.code === "INVALID_REQUEST"
  );
  assert.deepEqual(state.discoveryCalls, []);
  assert.deepEqual(state.searchCalls, []);
  assert.deepEqual(state.appendedEvidence, []);
  assert.deepEqual(state.identityCommits, []);
  assert.deepEqual(state.intelligenceCreates, []);
});

for (const expected of [
  { scenario: "not_found", status: "requires_review" },
  { scenario: "insufficient_evidence", status: "requires_review" },
  { scenario: "ambiguous", status: "requires_review" },
  { scenario: "conflicting", status: "requires_review" },
  { scenario: "access_restricted", status: "requires_review" },
  { scenario: "redirect_not_allowed", status: "requires_review" },
  { scenario: "stale_candidate", status: "requires_review" },
  { scenario: "provider_unavailable", status: "failed" }
] as const) {
  test(`${expected.scenario} is terminal without identity or intelligence side effects`, async () => {
    const state = executionFixture(expected.scenario);
    const created = await state.service.create(SCOPE, {
      candidateId: "candidate-1",
      expectedCandidateVersion: 3,
      sourceEvidenceIds: ["source-evidence"],
      searchConnections: searchConnections("search-connection-success"),
      planSessionId: null
    }, `terminal-${expected.scenario}`);

    const completed = await state.service.execute(SCOPE, created.id);

    assert.equal(completed.status, expected.status);
    assert.equal(completed.outcome, expected.scenario);
    assert.equal(
      completed.retryable,
      expected.scenario === "provider_unavailable"
    );
    assert.equal(state.identityCommits.length, 0);
    assert.equal(state.intelligenceCreates.length, 0);
    assert.equal(state.intelligenceExecutes.length, 0);
  });
}
