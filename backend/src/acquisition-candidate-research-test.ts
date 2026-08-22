import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AcquisitionCandidateResearchService,
  type AcquisitionCandidateResearchConnectionValidator
} from "./acquisition-candidate-research.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import type {
  AcquisitionOperationShard,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import {
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";
import type {
  SearchPublicSourceResult,
  SearchPublicSourcesPort
} from "./acquisition-tool-executor.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const OWNER = "owner-research";
const TEAM = "team-research";
const ACTOR = "worker-research";
const TARGET_CREDIT_CODE = "91350200M000100Y48";
const OTHER_CREDIT_CODE = "91350200M000101Y4X";

const scope = {
  ownerId: OWNER,
  teamId: TEAM,
  actorId: ACTOR
};

function run(): AcquisitionRun {
  return {
    id: "run-research",
    ownerId: OWNER,
    teamId: TEAM,
    planId: "plan-research",
    planVersionId: "plan-version-research",
    planVersion: 1,
    planSnapshotHash: "sha256:plan",
    parentRunId: null,
    status: "running",
    terminationIntent: null,
    revision: 1,
    etag: "\"run-research:1\"",
    budgetSnapshotId: "budget-research",
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 20,
      maxResults: 20,
      maxAmountMinor: 0,
      maxDurationSeconds: 60
    },
    budgetSnapshotHash: "sha256:budget",
    billingCurrency: "CNY",
    modelSnapshotRef: {
      jobSnapshotId: "model-snapshot",
      connectionId: "model-connection",
      credentialVersion: 1,
      provider: "test-model",
      model: "test-model-v1",
      capabilitySnapshotHash: "sha256:capability",
      promptVersion: "prompt.v1",
      schemaVersion: "schema.v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    consumedBudget: {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    },
    evidenceCount: 1,
    reason: null,
    createdBy: ACTOR,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedBy: ACTOR,
    updatedAt: "2026-07-26T00:00:00.000Z",
    completedAt: null
  };
}

function shard(): AcquisitionOperationShard {
  return {
    id: "shard-research",
    runId: "run-research",
    ownerId: OWNER,
    teamId: TEAM,
    operationId: "search-organizations",
    parentShardId: null,
    subjectChannel: "organization",
    kind: "search",
    connection: {
      connectionId: "search-connection",
      providerId: "brave",
      kind: "search",
      status: "active",
      credentialVersion: 7
    },
    query: "初始公开搜索",
    sourceRef: "初始公开搜索",
    status: "running",
    budgetSnapshotId: "budget-research",
    allocatedBudget: {
      requests: 20,
      results: 20,
      amountMinor: 0,
      durationSeconds: 60
    },
    consumedBudget: {
      requests: 1,
      results: 1,
      amountMinor: 0,
      durationSeconds: 1
    },
    modelSnapshotRef: run().modelSnapshotRef,
    evidenceCount: 1,
    revision: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    completedAt: null
  };
}

function evidence(
  id: string,
  targetType: DiscoveryEvidence["targetType"],
  sourceUrl: string
): DiscoveryEvidence {
  return {
    id,
    ownerId: OWNER,
    teamId: TEAM,
    targetType,
    sourcePlatform: "brave",
    sourceTitle: "原始公开信号",
    sourceSnippet: "原始公开需求",
    publishedAt: "2026-07-25T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "brave",
      queryText: "初始公开搜索",
      sourceUrl,
      resultRank: 1
    },
    accessStatus: "public_content",
    supersedesEvidenceId: null,
    fetchedAt: "2026-07-26T00:00:00.000Z"
  };
}

function organizationResult(input: {
  sourceUrl: string;
  domain: string | null;
  creditCode?: string | null;
  accessStatus?: SearchPublicSourceResult["accessStatus"];
  sourcePlatform?: string;
}): SearchPublicSourceResult {
  return {
    providerRecordId: `research:${input.sourceUrl}`,
    sourceUrl: input.sourceUrl,
    sourcePlatform: input.sourcePlatform ?? "public_registry",
    sourceType: "other",
    title: "目标科技有限公司",
    snippet: "公开发布新的采购、合作与供应商需求。",
    publishedAt: "2026-07-26T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"c".repeat(64)}`,
    accessStatus: input.accessStatus ?? "public_content",
    subject: {
      kind: "organization",
      name: "目标科技有限公司",
      domain: input.domain,
      region: "厦门",
      creditCode: input.creditCode ?? null,
      organizationId: null
    }
  };
}

function individualResult(input: {
  sourceUrl: string;
  profileUrl: string;
  actorKey: string;
}): SearchPublicSourceResult {
  return {
    providerRecordId: `research:${input.sourceUrl}`,
    sourceUrl: input.sourceUrl,
    title: "Alice",
    snippet: "公开寻找供应商和 AI 增长解决方案。",
    publishedAt: "2026-07-26T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"d".repeat(64)}`,
    accessStatus: "public_content",
    subject: {
      kind: "individual",
      publicActorKey: input.actorKey,
      publicDisplayName: "Alice",
      publicProfileUrl: input.profileUrl,
      sourcePlatform: "linkedin-search",
      demandCategory: "增长系统",
      demandSummary: "公开寻找供应商和 AI 增长解决方案。",
      locationHint: "上海",
      buyingStage: "solution_research",
      negativeSignals: [],
      individualPartyId: "forged-party-id-must-not-be-trusted"
    }
  };
}

async function fixture(candidate: AcquisitionCandidate) {
  const repository = new InMemoryAcquisitionDomainRepository();
  const originalEvidence = evidence(
    candidate.evidenceIds[0]!,
    candidate.partyType === "organization"
      ? "organization"
      : "individual_signal",
    candidate.partyType === "organization"
      ? "https://target.example.cn/original"
      : "https://news.example.cn/alice/original"
  );
  await repository.appendEvidence(originalEvidence);
  await repository.insertCandidate(candidate);
  let sequence = 0;
  const domain = new AcquisitionDomainService({
    repository,
    leadConversionPort: {
      async createLead() {
        throw new Error("not used");
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return input.ownerId === OWNER && input.teamId === TEAM
          ? {
              workspaceId: TEAM,
              kind: "team" as const,
              bindingRevision: "binding-1"
            }
          : null;
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-research-${++sequence}`,
    now: () => "2026-07-26T01:00:00.000Z"
  });
  return { repository, domain };
}

function organizationCandidate(): AcquisitionCandidate {
  return {
    id: "candidate-organization",
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: "public-org-target",
      tenantProspectId: "prospect-target"
    },
    profile: {
      kind: "organization",
      name: "目标科技有限公司",
      domain: "target.example.cn",
      region: "厦门",
      creditCode: TARGET_CREDIT_CODE
    },
    evidenceIds: ["evidence-original"],
    status: "approved",
    latestDecisionId: "qualification-old",
    latestDecisionVersion: "decision-old",
    approvedDecisionVersion: "decision-old",
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    version: 3
  };
}

function individualCandidate(): AcquisitionCandidate {
  const publicProfileUrl =
    "https://www.linkedin.com/in/alice?a=1&b=2";
  const publicActorKey = "public:linkedin:alice";
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: OWNER,
    teamId: TEAM,
    provider: "linkedin-search",
    sourceUrl: "https://news.example.cn/alice/original",
    subject: {
      kind: "individual",
      publicActorKey,
      publicProfileUrl,
      sourcePlatform: "linkedin-search"
    }
  });
  assert.equal(resolution.status, "resolved");
  return {
    id: "candidate-individual",
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "individual",
    partyRef: {
      partyType: "individual",
      individualPartyId: resolution.partyId,
      demandSignalId: "signal-alice"
    },
    profile: {
      kind: "individual",
      publicActorKey,
      publicDisplayName: "Alice",
      publicProfileUrl,
      sourcePlatform: "linkedin-search",
      demandCategory: "增长系统",
      demandSummary: "公开寻找供应商",
      locationHint: "上海",
      buyingStage: "solution_research",
      negativeSignals: []
    },
    evidenceIds: ["evidence-original"],
    status: "qualified",
    latestDecisionId: "qualification-alice",
    latestDecisionVersion: "decision-alice",
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    version: 2
  };
}

function researchInput(
  candidateId: string,
  signal = new AbortController().signal
) {
  return {
    scope,
    run: run(),
    shard: shard(),
    candidateId,
    questions: ["补充公开采购证据"],
    signal
  };
}

test("organization research accepts only non-conflicting strong identity matches, dedupes URLs, and invalidates old decisions", async () => {
  const { repository, domain } = await fixture(organizationCandidate());
  const searchCalls: Parameters<SearchPublicSourcesPort["search"]>[0][] = [];
  const validatorCalls: number[] = [];
  const responses = [
    [
      organizationResult({
        sourceUrl: "https://news.example.cn/target?a=1&b=2",
        domain: "https://www.target.example.cn/"
      }),
      organizationResult({
        sourceUrl: "https://news.example.cn/not-target",
        domain: "other.example.cn"
      }),
      organizationResult({
        sourceUrl: "https://news.example.cn/conflict",
        domain: "target.example.cn",
        creditCode: OTHER_CREDIT_CODE
      }),
      organizationResult({
        sourceUrl: "https://news.example.cn/fifth",
        domain: "other.example.cn"
      }),
      organizationResult({
        sourceUrl: "https://news.example.cn/sixth",
        domain: "other.example.cn"
      }),
      organizationResult({
        sourceUrl: "https://news.example.cn/beyond-limit",
        domain: "target.example.cn"
      })
    ],
    [
      organizationResult({
        sourceUrl: "https://news.example.cn/target?b=2&a=1#duplicate",
        domain: "target.example.cn"
      }),
      organizationResult({
        sourceUrl: "https://procurement.example.cn/target",
        domain: null,
        creditCode: TARGET_CREDIT_CODE
      })
    ],
    [
      organizationResult({
        sourceUrl: "https://target.example.cn/original#already-attached",
        domain: "target.example.cn"
      })
    ]
  ];
  const search: SearchPublicSourcesPort = {
    async search(input) {
      searchCalls.push(structuredClone(input));
      return {
        providerConnectionId: input.providerConnectionId,
        providerCredentialVersion: 1,
        provider: "brave",
        requestId: `request-${searchCalls.length}`,
        results: responses[searchCalls.length - 1] ?? []
      };
    }
  };
  const validateConnection: AcquisitionCandidateResearchConnectionValidator =
    async () => {
      validatorCalls.push(validatorCalls.length + 1);
    };
  const service = new AcquisitionCandidateResearchService({
    domain,
    search,
    validateConnection
  });

  const result = await service.research(
    researchInput("candidate-organization")
  );

  assert.equal(searchCalls.length, 3);
  assert.equal(validatorCalls.length, 3);
  assert.deepEqual(searchCalls.map((call) => call.query), [
    "\"目标科技有限公司\" \"target.example.cn\" 采购 招标 合作",
    "\"目标科技有限公司\" 招聘 扩张 融资 新项目",
    "\"目标科技有限公司\" 供应商 系统 服务商"
  ]);
  assert.equal(searchCalls.every((call) =>
    call.maxResults === 5
    && call.providerConnectionId === "search-connection"
    && call.subjectKinds.length === 1
    && call.subjectKinds[0] === "organization"
  ), true);
  assert.equal(
    searchCalls.every((call) => call.query.length <= 500),
    true
  );
  assert.equal(result.status, "completed");
  assert.equal(result.addedEvidenceIds.length, 2);
  assert.deepEqual(result.queries.map((query) => query.resultCount), [
    5, 2, 1
  ]);

  const updated = await domain.getCandidate(
    scope,
    "candidate-organization"
  );
  assert.equal(updated.evidenceIds.length, 3);
  assert.equal(updated.status, "normalized");
  assert.equal(updated.latestDecisionId, null);
  assert.equal(updated.latestDecisionVersion, null);
  assert.equal(updated.approvedDecisionVersion, null);
  assert.equal(
    (await repository.listCandidates(
      { ownerId: OWNER, teamId: TEAM },
      { limit: 100 }
    )).items.length,
    1,
    "supplemental research must never create a new candidate"
  );
  const firstAdded = await domain.getEvidence(
    scope,
    result.addedEvidenceIds[0]!
  );
  assert.deepEqual(firstAdded.provenance, {
    kind: "search_result",
    provider: "brave",
    providerConnectionId: "search-connection",
    requestId: "request-1",
    providerRecordId:
      "research:https://news.example.cn/target?a=1&b=2",
    queryText:
      "\"目标科技有限公司\" \"target.example.cn\" 采购 招标 合作",
    sourceUrl: "https://news.example.cn/target?a=1&b=2",
    resultRank: 1
  });
  assert.equal(firstAdded.sourcePlatform, "public_registry");
});

test("individual research requires an exact normalized public profile and the resolved party id", async () => {
  const candidate = individualCandidate();
  const { repository, domain } = await fixture(candidate);
  const acceptedProfile =
    "https://www.linkedin.com/in/alice?b=2&a=1#public";
  const search: SearchPublicSourcesPort = {
    async search(input) {
      return {
        providerConnectionId: input.providerConnectionId,
        providerCredentialVersion: 1,
        provider: "linkedin-search",
        requestId: "individual-research",
        results: input.query.includes("求购")
          ? [
              individualResult({
                sourceUrl: "https://news.example.cn/alice/new",
                profileUrl: acceptedProfile,
                actorKey: candidate.profile.kind === "individual"
                  ? candidate.profile.publicActorKey
                  : ""
              }),
              individualResult({
                sourceUrl: "https://news.example.cn/alice/forged",
                profileUrl: acceptedProfile,
                actorKey:
                  `public:linkedin-search:sha256:${"2".repeat(64)}`
              }),
              individualResult({
                sourceUrl: "https://news.example.cn/bob/new",
                profileUrl: "https://www.linkedin.com/in/bob",
                actorKey: candidate.profile.kind === "individual"
                  ? candidate.profile.publicActorKey
                  : ""
              })
            ]
          : []
      };
    }
  };
  const service = new AcquisitionCandidateResearchService({
    domain,
    search,
    validateConnection: async () => undefined
  });

  const result = await service.research(
    researchInput("candidate-individual")
  );

  assert.equal(result.status, "completed");
  assert.equal(result.addedEvidenceIds.length, 1);
  const updated = await domain.getCandidate(scope, candidate.id);
  assert.equal(updated.evidenceIds.length, 2);
  assert.equal(
    (await repository.listCandidates(
      { ownerId: OWNER, teamId: TEAM },
      { limit: 100 }
    )).items.length,
    1
  );
});

test("restricted results report access_restricted without attaching evidence", async () => {
  const { domain } = await fixture(organizationCandidate());
  const service = new AcquisitionCandidateResearchService({
    domain,
    search: {
      async search(input) {
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion: 1,
          provider: "brave",
          requestId: "restricted",
          results: [organizationResult({
            sourceUrl: "https://restricted.example.cn/login",
            domain: "target.example.cn",
            accessStatus: "access_restricted"
          })]
        };
      }
    },
    validateConnection: async () => undefined
  });

  const result = await service.research(
    researchInput("candidate-organization")
  );

  assert.equal(result.status, "access_restricted");
  assert.deepEqual(result.addedEvidenceIds, []);
  assert.equal(
    (await domain.getCandidate(scope, "candidate-organization"))
      .evidenceIds.length,
    1
  );
});

test("revalidates the approved connection before every query and stops after drift", async () => {
  const { domain } = await fixture(organizationCandidate());
  let validations = 0;
  let searches = 0;
  const service = new AcquisitionCandidateResearchService({
    domain,
    search: {
      async search(input) {
        searches += 1;
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion: 1,
          provider: "brave",
          requestId: `request-${searches}`,
          results: []
        };
      }
    },
    validateConnection: async () => {
      validations += 1;
      if (validations === 2) {
        throw new Error("credential snapshot drifted");
      }
    }
  });

  const result = await service.research(
    researchInput("candidate-organization")
  );

  assert.equal(result.status, "failed");
  assert.equal(validations, 2);
  assert.equal(searches, 1);
});

test("returns failed on its internal deadline instead of waiting for a stuck provider", async () => {
  const { domain } = await fixture(organizationCandidate());
  let searches = 0;
  const service = new AcquisitionCandidateResearchService({
    domain,
    search: {
      async search() {
        searches += 1;
        return new Promise(() => undefined);
      }
    },
    validateConnection: async () => undefined,
    timeoutMs: 10
  });

  const result = await service.research(
    researchInput("candidate-organization")
  );

  assert.equal(result.status, "failed");
  assert.equal(searches, 1);
});

test("propagates an external abort and never starts another query", async () => {
  const { domain } = await fixture(organizationCandidate());
  const controller = new AbortController();
  let searches = 0;
  const service = new AcquisitionCandidateResearchService({
    domain,
    search: {
      async search(input) {
        searches += 1;
        controller.abort(new DOMException("cancelled", "AbortError"));
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion: 1,
          provider: "brave",
          requestId: "aborted",
          results: []
        };
      }
    },
    validateConnection: async () => undefined
  });

  await assert.rejects(
    service.research(
      researchInput("candidate-organization", controller.signal)
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError"
  );
  assert.equal(searches, 1);
});
