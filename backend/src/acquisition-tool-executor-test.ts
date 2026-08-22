import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AcquisitionDomainError,
  AcquisitionDomainService,
  type LeadConversionPort
} from "./acquisition-domain-service.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  AcquisitionCandidate
} from "./acquisition-domain.js";
import type {
  AcquisitionAgentIdentity,
  AcquisitionAgentToolName
} from "./acquisition-pi-tools.js";
import {
  AcquisitionToolIdempotencyConflictError,
  AcquisitionToolExecutorError,
  ProductionAcquisitionAgentToolExecutor,
  type AcquisitionActionExecutionPort,
  type AcquisitionActionExecutionReceipt,
  type AcquisitionCandidateDirectoryPort,
  type AcquisitionCandidateIndexEntry,
  type AcquisitionJudgmentPort,
  type AcquisitionPriorityCandidatePort,
  type AcquisitionReviewTask,
  type AcquisitionReviewTaskPort,
  type AcquisitionSearchConnectionDirectoryPort,
  type AcquisitionToolResultLedgerPort,
  type GrowthAcquisitionToolDelegate,
  type SearchPublicSourceResult,
  type SearchPublicSourcesPort,
  type SearchPublicSourcesRequest,
  type SearchPublicSourcesResponse
} from "./acquisition-tool-executor.js";
import {
  createGrowthCommercialToolPorts,
  type GrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const identity: AcquisitionAgentIdentity = {
  ownerId: "owner-1",
  teamId: "team-1",
  actorId: "actor-1",
  sessionId: "session-1"
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class TestCandidateDirectory implements AcquisitionCandidateDirectoryPort {
  private readonly byDedupeKey = new Map<string, AcquisitionCandidateIndexEntry>();
  private readonly byCandidateId = new Map<string, AcquisitionCandidateIndexEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<{ entry: AcquisitionCandidateIndexEntry; created: boolean }>
  >();
  createCalls = 0;

  private scopeKey(scope: { ownerId: string; teamId: string }, value: string) {
    return `${scope.ownerId}\u0000${scope.teamId}\u0000${value}`;
  }

  async upsertCandidate(input: {
    ownerId: string;
    teamId: string;
    dedupeKey: string;
    partyType: "organization" | "individual";
    idempotencyKey: string;
    createCandidate: () => Promise<AcquisitionCandidate>;
  }) {
    const key = this.scopeKey(input, input.dedupeKey);
    const existing = this.byDedupeKey.get(key);
    if (existing) {
      return { entry: structuredClone(existing), created: false };
    }
    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending);
    const operation = (async () => {
      const candidate = await input.createCandidate();
      this.createCalls += 1;
      const entry: AcquisitionCandidateIndexEntry = {
        ownerId: input.ownerId,
        teamId: input.teamId,
        candidateId: candidate.id,
        dedupeKey: input.dedupeKey,
        partyType: input.partyType,
        indexedAt: "2026-07-24T01:00:00.000Z"
      };
      this.byDedupeKey.set(key, structuredClone(entry));
      this.byCandidateId.set(
        this.scopeKey(entry, entry.candidateId),
        structuredClone(entry)
      );
      return { entry, created: true };
    })();
    this.inFlight.set(key, operation);
    try {
      return structuredClone(await operation);
    } finally {
      this.inFlight.delete(key);
    }
  }

  entries(scope: { ownerId: string; teamId: string }) {
    return [...this.byCandidateId.values()]
      .filter((entry) =>
        entry.ownerId === scope.ownerId && entry.teamId === scope.teamId
      )
      .map((entry) => structuredClone(entry));
  }
}

class TestPriorityCandidatePort implements AcquisitionPriorityCandidatePort {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor(
    private readonly directory: TestCandidateDirectory,
    private readonly domain: AcquisitionDomainService
  ) {}

  async listPriorityCandidates(input: {
    ownerId: string;
    teamId: string;
    subjectKinds?: Array<"organization" | "individual">;
    minimumGrade?: "S" | "A" | "B" | "C" | "D";
    limit: number;
    sort: "qualification_and_financial_desc";
  }) {
    this.calls.push(structuredClone(input));
    const rank = { S: 0, A: 1, B: 2, C: 3, D: 4 } as const;
    const scope = {
      ownerId: input.ownerId,
      teamId: input.teamId,
      actorId: "storage-query"
    };
    const rows = [];
    for (const entry of this.directory.entries(input)) {
      const candidate = await this.domain.getCandidate(scope, entry.candidateId);
      if (input.subjectKinds
        && !input.subjectKinds.includes(candidate.partyType)) continue;
      const qualifications = await this.domain.listQualificationDecisions(
        scope,
        candidate.id
      );
      const values = await this.domain.listFinancialValueDecisions(
        scope,
        candidate.id
      );
      const qualification = qualifications.at(-1);
      if (input.minimumGrade
        && (!qualification
          || rank[qualification.grade] > rank[input.minimumGrade])) continue;
      rows.push({
        candidateId: candidate.id,
        qualificationGrade: qualification?.grade ?? null,
        qualificationScore: qualification?.score ?? null,
        financialScore: values.at(-1)?.score ?? null,
        updatedAt: candidate.updatedAt
      });
    }
    rows.sort((left, right) =>
      rank[left.qualificationGrade ?? "D"]
        - rank[right.qualificationGrade ?? "D"]
      || (right.financialScore ?? 0) - (left.financialScore ?? 0)
      || right.updatedAt.localeCompare(left.updatedAt)
    );
    return rows.slice(0, input.limit);
  }
}

class TestReviewTaskPort implements AcquisitionReviewTaskPort {
  private readonly tasks = new Map<string, AcquisitionReviewTask>();
  private sequence = 0;

  private key(scope: { ownerId: string; teamId: string }, id: string) {
    return `${scope.ownerId}\u0000${scope.teamId}\u0000${id}`;
  }

  async create(input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">) {
    const task: AcquisitionReviewTask = {
      ...structuredClone(input),
      id: `review-task-${++this.sequence}`,
      status: "pending",
      createdAt: "2026-07-24T02:00:00.000Z"
    };
    this.tasks.set(this.key(task, task.id), task);
    return structuredClone(task);
  }

  async get(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ) {
    return structuredClone(
      this.tasks.get(this.key(scope, reviewTaskId)) ?? null
    );
  }

  approve(scope: { ownerId: string; teamId: string }, reviewTaskId: string) {
    const key = this.key(scope, reviewTaskId);
    const task = this.tasks.get(key);
    assert.ok(task);
    this.tasks.set(key, { ...task, status: "approved" });
  }
}

class TestActionExecutionPort implements AcquisitionActionExecutionPort {
  private readonly receipts = new Map<string, AcquisitionActionExecutionReceipt>();

  private key(scope: { ownerId: string; teamId: string }, id: string) {
    return `${scope.ownerId}\u0000${scope.teamId}\u0000${id}`;
  }

  record(receipt: AcquisitionActionExecutionReceipt) {
    this.receipts.set(
      this.key(receipt, receipt.reviewTaskId),
      structuredClone(receipt)
    );
  }

  async getVerifiedExecution(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ) {
    return structuredClone(
      this.receipts.get(this.key(scope, reviewTaskId)) ?? null
    );
  }
}

class TestToolResultLedger implements AcquisitionToolResultLedgerPort {
  calls = 0;
  private readonly records = new Map<string, {
    requestHash: string;
    result: unknown;
  }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private key(input: {
    ownerId: string;
    teamId: string;
    toolName: string;
    idempotencyKey: string;
  }) {
    return [
      input.ownerId,
      input.teamId,
      input.toolName,
      input.idempotencyKey
    ].join("\u0000");
  }

  async executeOnce<T>(
    input: {
      ownerId: string;
      teamId: string;
      actorId: string;
      sessionId: string;
      toolName: string;
      idempotencyKey: string;
      requestHash: string;
    },
    operation: () => Promise<T>
  ): Promise<T> {
    this.calls += 1;
    const key = this.key(input);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new AcquisitionToolIdempotencyConflictError();
      }
      return structuredClone(existing.result) as T;
    }
    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending) as T;
    const promise = operation();
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      this.records.set(key, {
        requestHash: input.requestHash,
        result: structuredClone(result)
      });
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

class TestSearchPort implements SearchPublicSourcesPort {
  readonly calls: SearchPublicSourcesRequest[] = [];

  constructor(
    private readonly negativeSignals: string[] = [],
    private readonly resolvedIdentities = true,
    private readonly organizationDomain: string | null = "growth.example.cn",
    private readonly individualActorKey = "public:store-owner",
    private readonly individualProfileUrl =
      "https://example.cn/profile/store-owner",
    private readonly individualPlatform = "public_forum",
    private readonly individualSourceType:
      SearchPublicSourceResult["sourceType"] = "other"
  ) {}

  async search(
    input: SearchPublicSourcesRequest
  ): Promise<SearchPublicSourcesResponse> {
    this.calls.push(structuredClone({
      ...input,
      signal: undefined
    }));
    if (input.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (input.providerConnectionId === "search-broken") {
      throw new Error("SECRET_API_KEY=must-not-leak");
    }
    const provider = input.providerConnectionId === "search-tavily"
      ? "tavily"
      : "baidu_ai_search";
    const results: SearchPublicSourceResult[] = [
      {
        providerRecordId: "provider-record-organization-growth",
        sourceUrl: "https://example.cn/company/growth",
        sourcePlatform: "company_registry",
        sourceType: "other",
        title: "厦门增长科技正在寻找获客系统",
        snippet: "公开采购需求：需要全网商机识别、客户评分和渠道 ROI。",
        publishedAt: "2026-07-23T03:00:00.000Z",
        locale: "zh-CN",
        rawArtifactHash: sha256("company-growth"),
        accessStatus: "indexed_summary",
        subject: {
          kind: "organization",
          name: "厦门增长科技有限公司",
          domain: this.organizationDomain,
          region: "  福建省　厦门市  ",
          creditCode: null,
          organizationId: this.resolvedIdentities ? "org-growth" : null
        }
      },
      {
        providerRecordId: "provider-record-individual-store-owner",
        sourceUrl: "https://example.cn/profile/store-owner",
        sourcePlatform: this.individualPlatform,
        sourceType: this.individualSourceType,
        title: "厦门门店主理人公开咨询获客方案",
        snippet: "正在比较获客系统，希望近期上线，关注投入产出。",
        publishedAt: "2026-07-23T04:00:00.000Z",
        locale: "zh-CN",
        rawArtifactHash: sha256("individual-store-owner"),
        accessStatus: "public_content",
        subject: {
          kind: "individual",
          publicActorKey: this.individualActorKey,
          publicDisplayName: "厦门门店主理人",
          publicProfileUrl: this.individualProfileUrl,
          sourcePlatform: this.individualPlatform,
          demandCategory: "获客系统",
          demandSummary: "正在比较获客系统，希望近期上线",
          locationHint: "厦门",
          buyingStage: "comparison",
          negativeSignals: [...this.negativeSignals],
          individualPartyId: this.resolvedIdentities
            ? "individual-store-owner"
            : null
        }
      }
    ];
    const rawResults: unknown[] = [...results];
    if (input.providerConnectionId === "search-with-invalid") {
      rawResults.push({
        sourceUrl: "javascript:alert(1)",
        title: "invalid",
        snippet: "invalid",
        publishedAt: null,
        locale: "zh-CN",
        rawArtifactHash: "not-a-sha256",
        accessStatus: "public_content",
        subject: { kind: "organization", name: "" }
      });
    }
    return {
      providerConnectionId: input.providerConnectionId,
      providerCredentialVersion: 1,
      provider,
      requestId: `request-${input.providerConnectionId}`,
      results: rawResults.filter((result) =>
        typeof result !== "object"
        || result === null
        || !("subject" in result)
        || input.subjectKinds.includes(
          (result as SearchPublicSourceResult).subject.kind
        )
      ) as SearchPublicSourceResult[]
    };
  }
}

class TestSearchConnectionDirectory
implements AcquisitionSearchConnectionDirectoryPort {
  readonly calls: Array<{ ownerId: string; teamId: string }> = [];

  constructor(
    private readonly connectionIds = ["search-ok", "search-tavily"]
  ) {}

  async listActiveConnectionIds(scope: {
    ownerId: string;
    teamId: string;
  }) {
    this.calls.push(structuredClone(scope));
    return [...this.connectionIds];
  }
}

function createHarness(options: {
  judgments?: AcquisitionJudgmentPort;
  negativeSignals?: string[];
  resolvedIdentities?: boolean;
  organizationDomain?: string | null;
  individualActorKey?: string;
  individualProfileUrl?: string;
  individualPlatform?: string;
  individualSourceType?: SearchPublicSourceResult["sourceType"];
  searchConnectionIds?: string[];
  candidateIdFactory?: () => string;
  growthToolPorts?: GrowthCommercialToolPorts;
  growthCommercialTools?: GrowthAcquisitionToolDelegate;
  performance?: {
    get(scope: { ownerId: string; teamId: string }, query: {
      platform?: "douyin" | "web";
      from: string;
      to: string;
    }): Promise<unknown>;
  };
} = {}) {
  let id = 0;
  let tick = 0;
  const repository = new InMemoryAcquisitionDomainRepository();
  const converted: string[] = [];
  const leadConversionPort: LeadConversionPort = {
    async createLead(request) {
      converted.push(request.candidateId);
      return {
        leadId: `lead-${converted.length}`,
        partyRef: request.partyRef
      };
    }
  };
  const growthAcquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      return {
        workspaceId: scope.teamId,
        kind: "team" as const,
        bindingRevision: "tool-executor-test-binding"
      };
    }
  });
  const growthTemporalBarrier = new DefaultGrowthTemporalBarrier(
    new InMemoryGrowthTemporalTransactionRunner()
  );
  const domain = new AcquisitionDomainService({
    repository,
    leadConversionPort,
    growthAcquisitionWorkspace,
    growthTemporalBarrier,
    idFactory: (prefix) => prefix === "candidate" && options.candidateIdFactory
      ? options.candidateIdFactory()
      : `${prefix}-${++id}`,
    now: () =>
      new Date(Date.UTC(2026, 6, 24, 1, 0, tick++)).toISOString()
  });
  const search = new TestSearchPort(
    options.negativeSignals,
    options.resolvedIdentities,
    options.organizationDomain,
    options.individualActorKey,
    options.individualProfileUrl,
    options.individualPlatform,
    options.individualSourceType
  );
  const searchConnections = new TestSearchConnectionDirectory(
    options.searchConnectionIds
  );
  const directory = new TestCandidateDirectory();
  const priority = new TestPriorityCandidatePort(directory, domain);
  const reviews = new TestReviewTaskPort();
  const executions = new TestActionExecutionPort();
  const toolResults = new TestToolResultLedger();
  const executor = new ProductionAcquisitionAgentToolExecutor({
    domain,
    growthToolPorts: options.growthToolPorts
      ?? createGrowthCommercialToolPorts(),
    growthCommercialTools: options.growthCommercialTools,
    search,
    searchConnections,
    candidateDirectory: directory,
    priorityCandidates: priority,
    reviewTasks: reviews,
    actionExecutions: executions,
    toolResults,
    judgments: options.judgments,
    performance: options.performance as never,
    now: () => "2026-07-24T08:00:00.000Z"
  });
  return {
    repository,
    domain,
    search,
    searchConnections,
    directory,
    priority,
    reviews,
    executions,
    toolResults,
    executor,
    converted
  };
}

test("the production Acquisition tool executor consumes the issued Growth registry", async () => {
  const growthToolPorts = createGrowthCommercialToolPorts();
  const command = Object.freeze({ marker: "command" }) as never;
  const payload = Object.freeze({ query: "catalog" });
  growthToolPorts.register("list_catalog_items", async (input, actual) => {
    assert.equal(actual, command);
    return input;
  });
  const { executor } = createHarness({ growthToolPorts });
  assert.equal(await executor.executeGrowthTool({
    name: "list_catalog_items",
    input: payload,
    stableCallHash: `sha256:${"a".repeat(64)}`
  }, command), payload);
});

test("the production Acquisition tool executor rejects a forged Growth registry", () => {
  assert.throws(() => createHarness({
    growthToolPorts: Object.freeze({
      register() {},
      execute: async () => null
    }) as never
  }), /INVALID_GROWTH_TOOL_PORTS/u);
});

test("owned Growth tools bypass the generic outer result ledger", async () => {
  const delegated: string[] = [];
  const state = createHarness({
    growthCommercialTools: {
      owns(toolName) { return toolName === "preview_quote"; },
      async execute(input) {
        delegated.push(input.toolName);
        return { delegated: true };
      }
    }
  });
  const result = await state.executor.execute({
    identity,
    toolName: "preview_quote",
    toolCallId: "quote-call-1",
    idempotencyKey: "quote-key-1",
    payload: { deliberately: "parsed only by the owned delegate" }
  });
  assert.deepEqual(result, { delegated: true });
  assert.deepEqual(delegated, ["preview_quote"]);
  assert.equal(state.toolResults.calls, 0);
});

async function execute(
  executor: ProductionAcquisitionAgentToolExecutor,
  toolName: AcquisitionAgentToolName,
  payload: Record<string, unknown>,
  idempotencyKey = `${toolName}:1`,
  overriddenIdentity = identity,
  signal?: AbortSignal
) {
  return executor.execute({
    identity: overriddenIdentity,
    toolName,
    toolCallId: `call:${toolName}`,
    idempotencyKey,
    payload,
    signal
  }) as Promise<Record<string, any>>;
}

async function discover(
  executor: ProductionAcquisitionAgentToolExecutor,
  providerConnectionIds = ["search-ok", "search-broken"],
  idempotencyKey = "search:1"
) {
  return execute(executor, "search_public_sources", {
    query: "厦门 获客系统 采购",
    providerConnectionIds,
    subjectKinds: ["organization", "individual"],
    maxResults: 10
  }, idempotencyKey);
}

test("searches authorized providers, survives a partial failure, and idempotently creates both candidate kinds", async () => {
  const { executor, search, domain } = createHarness();

  const first = await discover(executor);
  assert.equal(first.status, "partial");
  assert.equal(first.outreachExecuted, false);
  assert.equal(first.providerFailures.length, 1);
  assert.deepEqual(first.providerFailures[0], {
    providerConnectionId: "search-broken",
    provider: "unknown",
    errorCode: "SEARCH_PROVIDER_FAILED",
    retryAfterAt: null
  });
  assert.equal(JSON.stringify(first).includes("must-not-leak"), false);
  assert.equal(first.candidates.length, 2);
  assert.deepEqual(
    new Set(first.candidates.map((item: any) => item.partyType)),
    new Set(["organization", "individual"])
  );
  assert.equal(first.evidence.length, 2);
  assert.deepEqual(
    first.evidence.map((item: any) => item.sourcePlatform),
    ["company_registry", "public_forum"]
  );
  assert.equal(
    first.evidence.every(
      (item: any) => item.provenance.provider === "baidu_ai_search"
    ),
    true
  );
  assert.deepEqual(
    first.evidence.map((item: any) => ({
      providerConnectionId: item.provenance.providerConnectionId,
      requestId: item.provenance.requestId,
      providerRecordId: item.provenance.providerRecordId
    })),
    [
      {
        providerConnectionId: "search-ok",
        requestId: "request-search-ok",
        providerRecordId: "provider-record-organization-growth"
      },
      {
        providerConnectionId: "search-ok",
        requestId: "request-search-ok",
        providerRecordId: "provider-record-individual-store-owner"
      }
    ]
  );
  assert.equal(search.calls.length, 2);
  assert.equal(
    first.candidates.find((item: any) => item.partyType === "organization")
      .profile.region,
    "福建省 厦门市"
  );

  const replay = await discover(executor);
  assert.deepEqual(
    replay.candidates.map((item: any) => item.id),
    first.candidates.map((item: any) => item.id)
  );
  assert.deepEqual(
    replay.evidence.map((item: any) => item.id),
    first.evidence.map((item: any) => item.id)
  );
  assert.equal(search.calls.length, 2, "tool result ledger must prevent re-search");
  const organization = await domain.getCandidate(
    {
      ownerId: identity.ownerId,
      teamId: identity.teamId,
      actorId: identity.actorId
    },
    first.candidates[0].id
  );
  assert.equal(organization.evidenceIds.length, 1);

  await assert.rejects(
    execute(executor, "search_public_sources", {
      query: "不同查询",
      providerConnectionIds: ["search-ok"],
      subjectKinds: ["organization"],
      maxResults: 10
    }, "search:1"),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("keeps a Douyin comment-like profile result unresolved at the executor boundary", async () => {
  const { executor } = createHarness({
    resolvedIdentities: false,
    individualActorKey: `public:douyin:sha256:${"d".repeat(64)}`,
    individualProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
    individualPlatform: "douyin",
    individualSourceType: "comment_signal"
  });

  const discovery = await discover(executor, ["search-ok"]);
  const individual = discovery.candidates.find(
    (item: any) => item.partyType === "individual"
  );
  assert.ok(individual);
  assert.match(
    individual.partyRef.individualPartyId,
    /^unresolved-individual-/u
  );
  assert.deepEqual(individual.identityResolution, {
    status: "needs_research",
    basis: null,
    reasonCode: "insufficient_provider_public_actor_identity",
    resolverVersion: "acquisition-public-identity-v1"
  });
  const individualEvidence = discovery.evidence.find(
    (item: any) => item.targetType === "individual_signal"
  );
  assert.equal(
    individualEvidence?.provenance.sourceType,
    "comment_signal"
  );
});

test("automatically uses the tenant's active search connections when the agent omits internal connection ids", async () => {
  const {
    executor,
    search,
    searchConnections
  } = createHarness();

  const result = await execute(executor, "search_public_sources", {
    query: "厦门 企业 正在寻找 获客系统",
    subjectKinds: ["organization", "individual"],
    maxResults: 10
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(searchConnections.calls, [{
    ownerId: identity.ownerId,
    teamId: identity.teamId
  }]);
  assert.deepEqual(
    search.calls.map((call) => call.providerConnectionId),
    ["search-ok", "search-tavily"]
  );
});

test("fails with a stable setup error when no active search connection is configured", async () => {
  const { executor, search } = createHarness({
    searchConnectionIds: []
  });

  await assert.rejects(
    execute(executor, "search_public_sources", {
      query: "厦门 企业 正在寻找 获客系统",
      subjectKinds: ["organization", "individual"],
      maxResults: 10
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "SEARCH_PROVIDER_CONNECTION_REQUIRED"
  );
  assert.equal(search.calls.length, 0);
});

test("resolves strong public identities at the executor boundary instead of trusting nullable provider ids", async () => {
  const { executor } = createHarness({ resolvedIdentities: false });

  const discovery = await discover(executor, ["search-ok"]);
  const organization = discovery.candidates.find(
    (item: any) => item.partyType === "organization"
  );
  const individual = discovery.candidates.find(
    (item: any) => item.partyType === "individual"
  );
  assert.ok(organization);
  assert.ok(individual);
  assert.match(
    organization.partyRef.organizationId,
    /^public-org-[a-f0-9]{24}$/
  );
  assert.match(
    individual.partyRef.individualPartyId,
    /^public-individual-[a-f0-9]{24}$/
  );
  assert.equal(organization.identityResolution.status, "resolved");
  assert.equal(individual.identityResolution.status, "resolved");

  const qualification = await execute(executor, "qualify_candidate", {
    candidateId: organization.id,
    policyVersion: "qualification-rules.identity-v1"
  }, "qualify:strong-public-identity");
  assert.notEqual(qualification.qualification.grade, "D");
  assert.equal(
    qualification.qualification.hardGateFailures.includes(
      "identity_unresolved"
    ),
    false
  );
});

test("qualification consumes controlled public-page evidence as a public source", async () => {
  const { domain, executor } = createHarness();
  const scope = {
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    actorId: identity.actorId
  };
  const source = await domain.appendEvidence(scope, {
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "抖音公开视频",
    sourceSnippet: "视频中包含明确的公开作者链接。",
    publishedAt: "2026-07-24T04:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: sha256("controlled-source-raw"),
    contentHash: sha256("controlled-source-content"),
    provenance: {
      kind: "search_result",
      provider: "douyin",
      queryText: "抖音 公开采购需求",
      sourceUrl: "https://www.douyin.com/video/controlled-source",
      resultRank: 1
    },
    accessStatus: "public_content"
  }, "controlled-source-evidence");
  const page = await domain.appendEvidence(scope, {
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "抖音公开主页",
    sourceSnippet: "公开主页显示该主体正在比较获客系统。",
    publishedAt: "2026-07-24T04:30:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: sha256("controlled-page-raw"),
    contentHash: sha256("controlled-page-content"),
    provenance: {
      kind: "controlled_public_page",
      sourceUrl: "https://www.douyin.com/user/controlled-actor",
      discoveredFromEvidenceId: source.id,
      redirectChain: ["https://www.douyin.com/video/controlled-source"],
      extractorVersion: "douyin-public-profile-v1"
    },
    accessStatus: "public_content"
  }, "controlled-page-evidence");
  const candidate = await domain.createIndividualCandidate(scope, {
    publicActorKey: "public:douyin:controlled-actor",
    publicDisplayName: "受控公开主页主体",
    publicProfileUrl: "https://www.douyin.com/user/controlled-actor",
    sourcePlatform: "douyin",
    demandSignalId: "signal-controlled-actor",
    demandCategory: "获客系统",
    demandSummary: "正在比较获客系统",
    locationHint: "厦门",
    buyingStage: "comparison",
    negativeSignals: [],
    individualPartyId: "individual-controlled-actor",
    evidenceIds: [page.id]
  }, "controlled-page-candidate");

  const qualification = await execute(executor, "qualify_candidate", {
    candidateId: candidate.id,
    policyVersion: "qualification-rules.controlled-page-v1"
  }, "controlled-page-qualification");

  assert.equal(
    qualification.qualification.hardGateFailures.includes(
      "missing_original_source"
    ),
    false
  );
  assert.equal(
    qualification.qualification.hardGateFailures.includes("schema_invalid"),
    false
  );
  assert.notEqual(qualification.qualification.grade, "D");
});

test("maps current controlled tools and keeps the retired outcome tool read-only", async () => {
  const {
    executor,
    domain,
    reviews,
    executions,
    priority: priorityPort
  } = createHarness();
  const discovery = await discover(executor, ["search-ok"]);
  const organization = discovery.candidates.find(
    (item: any) => item.partyType === "organization"
  );
  assert.ok(organization);

  const evidence = await execute(executor, "get_candidate_evidence", {
    candidateId: organization.id
  });
  assert.equal(evidence.candidate.id, organization.id);
  assert.equal(evidence.evidence.length, 1);

  const research = await execute(executor, "research_candidate", {
    candidateId: organization.id,
    depth: "standard",
    researchQuestions: ["是否有公开采购信号？"]
  });
  assert.equal(research.mode, "conservative_rules");
  assert.equal(research.newEvidenceCount, 0);
  assert.equal(research.outreachExecuted, false);

  const qualification = await execute(executor, "qualify_candidate", {
    candidateId: organization.id,
    policyVersion: "qualification-rules.v1"
  });
  assert.equal(qualification.qualification.decisionEngine, "rules");
  assert.equal(qualification.candidate.status, "pending_review");
  assert.equal(qualification.outreachExecuted, false);

  const financial = await execute(executor, "estimate_financial_value", {
    candidateId: organization.id,
    currency: "CNY",
    policyVersion: "financial-rules.v1"
  });
  assert.equal(financial.persisted, true);
  assert.equal(financial.financialValue.currency, "CNY");

  const battleCard = await execute(executor, "build_battle_card", {
    candidateId: organization.id,
    templateVersion: "battle-card.v2"
  });
  assert.equal(battleCard.battleCard.candidateId, organization.id);
  assert.equal(battleCard.battleCard.modelProvider, "rules");
  assert.equal(battleCard.battleCard.schemaVersion, "battle-card.v2");
  assert.equal(
    battleCard.battleCard.intelligence.financialSummary.decisionId,
    financial.financialValue.id
  );

  const strategy = await execute(executor, "draft_connection_strategy", {
    candidateId: organization.id,
    targetRole: "老板",
    channels: ["public_reply", "enterprise_wechat", "email"]
  });
  assert.equal(strategy.requiresHumanReview, true);
  assert.equal(strategy.outreachExecuted, false);
  assert.deepEqual(
    strategy.drafts.map((item: any) => item.channel),
    ["public_reply", "enterprise_wechat", "email"]
  );

  const priority = await execute(executor, "list_priority_candidates", {
    subjectKinds: ["organization"],
    minimumGrade: "D",
    limit: 20
  });
  assert.equal(priority.candidates.length, 1);
  assert.equal(priority.candidates[0].candidate.id, organization.id);
  assert.deepEqual(priorityPort.calls.at(-1), {
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    subjectKinds: ["organization"],
    minimumGrade: "D",
    limit: 20,
    sort: "qualification_and_financial_desc"
  });

  const scope = {
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    actorId: identity.actorId
  };
  const decisionVersion = qualification.qualification.decisionVersion;
  await domain.reviewCandidate(scope, organization.id, {
    action: "approved",
    decisionVersion,
    reason: null,
    idempotencyKey: "human-review:approve"
  });

  const review = await execute(executor, "create_review_task", {
    candidateId: organization.id,
    proposedAction: "convert",
    rationale: "资格与财务价值均已完成，提交人工复核。"
  });
  assert.equal(review.reviewTask.status, "pending");
  assert.equal(review.outreachExecuted, false);

  await domain.convertCandidate(scope, organization.id, {
    decisionVersion,
    idempotencyKey: "human-convert:1"
  });
  reviews.approve(scope, review.reviewTask.id);
  executions.record({
    executionId: "execution-1",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    candidateId: organization.id,
    reviewTaskId: review.reviewTask.id,
    proposedAction: "convert",
    executedAt: "2026-07-24T05:59:00.000Z",
    credential: {
      issuer: "goodjob-action-worker",
      credentialId: "credential-1",
      proofHash: sha256("trusted-execution-proof")
    }
  });

  await assert.rejects(
    execute(executor, "record_outcome", {
      candidateId: organization.id,
      reviewTaskId: review.reviewTask.id,
      outcome: "won",
      occurredAt: "2026-07-24T06:00:00.000Z",
      amountMinor: 2_980_000,
      currency: "CNY",
      notes: "客户已签约"
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "LEGACY_OUTCOME_TOOL_READ_ONLY"
  );
});

test("enforces tenant isolation even when a candidate id is known", async () => {
  const { executor } = createHarness();
  const discovery = await discover(executor, ["search-ok"]);
  const candidateId = discovery.candidates[0].id;

  await assert.rejects(
    execute(executor, "get_candidate_evidence", {
      candidateId
    }, "intruder:get", {
      ownerId: "owner-2",
      teamId: "team-2",
      actorId: "actor-2",
      sessionId: "session-2"
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "RESOURCE_NOT_FOUND"
      && !error.message.includes(candidateId)
  );
});

test("returns stable non-secret errors for invalid payload, unknown tool, all-provider failure, and abort", async () => {
  const { executor } = createHarness();

  await assert.rejects(
    execute(executor, "search_public_sources", {
      query: "",
      providerConnectionIds: [],
      subjectKinds: [],
      maxResults: 0
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "INVALID_PAYLOAD"
      && error.message === "INVALID_PAYLOAD"
  );

  await assert.rejects(
    executor.execute({
      identity,
      toolName: "send_private_message" as AcquisitionAgentToolName,
      toolCallId: "call:unknown",
      idempotencyKey: "unknown:1",
      payload: {}
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "UNKNOWN_TOOL"
  );

  await assert.rejects(
    execute(executor, "get_candidate_evidence", {
      candidateId: "candidate-a"
    }, "x".repeat(121)),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "INVALID_IDENTITY"
  );

  await assert.rejects(
    discover(executor, ["search-broken"], "search:all-failed"),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "SEARCH_ALL_PROVIDERS_FAILED"
      && !error.message.includes("SECRET_API_KEY")
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execute(executor, "search_public_sources", {
      query: "厦门 获客系统",
      providerConnectionIds: ["search-ok"],
      subjectKinds: ["organization"],
      maxResults: 10
    }, "search:aborted", identity, controller.signal),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "ABORTED"
  );
});

test("retired outcome recording remains read-only before execution lookup", async () => {
  const { executor } = createHarness();
  const discovery = await discover(executor, ["search-ok"]);
  const candidate = discovery.candidates[0];

  await assert.rejects(
    execute(executor, "record_outcome", {
      candidateId: candidate.id,
      reviewTaskId: "review-task-from-another-tenant",
      outcome: "contacted",
      occurredAt: "2026-07-24T06:00:00.000Z"
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "LEGACY_OUTCOME_TOOL_READ_ONLY"
  );
});

test("isolates dedupe namespaces, atomically upserts candidates, and reports per-result ingest failures", async () => {
  const { executor, directory } = createHarness();
  const [left, right] = await Promise.all([
    discover(executor, ["search-ok"], "search:concurrent:left"),
    discover(executor, ["search-ok"], "search:concurrent:right")
  ]);
  assert.deepEqual(
    left.candidates.map((item: any) => item.id),
    right.candidates.map((item: any) => item.id)
  );
  assert.equal(
    directory.createCalls,
    2,
    "atomic upsert may create each organization/individual only once"
  );

  const otherNamespace = await discover(
    executor,
    ["search-tavily"],
    "search:tavily"
  );
  assert.equal(
    directory.createCalls,
    3,
    "matching organization domains merge while public individuals remain provider scoped"
  );
  const sharedCandidateIds = otherNamespace.candidates
    .filter((candidate: any) =>
      left.candidates.some((existing: any) => existing.id === candidate.id)
    );
  assert.deepEqual(
    sharedCandidateIds.map((candidate: any) => candidate.partyType),
    ["organization"]
  );

  const withInvalid = await discover(
    executor,
    ["search-with-invalid"],
    "search:invalid-result"
  );
  assert.equal(withInvalid.status, "partial");
  assert.equal(withInvalid.candidates.length, 2);
  assert.deepEqual(withInvalid.ingestFailures, [{
    providerConnectionId: "search-with-invalid",
    resultIndex: 2,
    errorCode: "SEARCH_RESULT_INVALID"
  }]);
});

test("reports raw, accepted, duplicate, and failed search counts with candidate ids", async () => {
  const candidateIds = ["candidate-existing", "candidate-new"];
  const { executor } = createHarness({
    candidateIdFactory: () => candidateIds.shift()!
  });
  await execute(executor, "search_public_sources", {
    query: "厦门 获客系统 采购",
    providerConnectionIds: ["search-ok"],
    subjectKinds: ["organization"],
    maxResults: 10
  }, "search:existing-candidate");

  const result = await execute(executor, "search_public_sources", {
    query: "厦门 获客系统 采购",
    providerConnectionIds: ["search-with-invalid"],
    subjectKinds: ["organization", "individual"],
    maxResults: 10
  }, "search:counted-results");

  assert.equal(result.rawResultCount, 3);
  assert.equal(result.acceptedResultCount, 2);
  assert.equal(result.duplicateResultCount, 1);
  assert.equal(result.failedResultCount, 1);
  assert.deepEqual(
    [...result.candidateIds].sort(),
    ["candidate-existing", "candidate-new"]
  );

  const providerFailure = await execute(executor, "search_public_sources", {
    query: "厦门 获客系统 采购",
    providerConnectionIds: ["search-ok", "search-broken"],
    subjectKinds: ["organization"],
    maxResults: 10
  }, "search:provider-failure-not-ingest-failure");
  assert.equal(providerFailure.providerFailures.length, 1);
  assert.equal(providerFailure.failedResultCount, 0);
});

test("routes weak organization names to controlled identity research instead of a D do-not-contact decision", async () => {
  const { executor } = createHarness({
    resolvedIdentities: false,
    organizationDomain: null
  });
  const discovery = await discover(executor, ["search-ok"]);
  const organization = discovery.candidates.find(
    (item: any) => item.partyType === "organization"
  );
  assert.ok(organization);
  assert.match(
    organization.partyRef.organizationId,
    /^unresolved-org-[a-f0-9]{24}$/
  );
  assert.deepEqual(organization.identityResolution, {
    status: "needs_research",
    basis: null,
    reasonCode: "insufficient_public_organization_identity",
    resolverVersion: "acquisition-public-identity-v1"
  });

  const research = await execute(executor, "research_candidate", {
    candidateId: organization.id,
    depth: "standard",
    researchQuestions: ["核验官网域名或统一社会信用代码"]
  }, "research:weak-organization");
  assert.equal(research.requiresIdentityResearch, true);
  assert.equal(research.outreachExecuted, false);

  await assert.rejects(
    execute(executor, "qualify_candidate", {
      candidateId: organization.id,
      policyVersion: "qualification-rules.identity-v1"
    }, "qualify:weak-organization"),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "IDENTITY_RESEARCH_REQUIRED"
  );
});

test("rejects private contact data masquerading as a public individual identity", async () => {
  const privatePhone = "13800000000";
  const { executor } = createHarness({
    resolvedIdentities: false,
    individualActorKey: `public:phone:${privatePhone}`
  });

  const discovery = await discover(
    executor,
    ["search-ok"],
    "search:private-actor-key"
  );

  assert.equal(
    discovery.candidates.some(
      (candidate: any) => candidate.partyType === "individual"
    ),
    false
  );
  assert.equal(JSON.stringify(discovery).includes(privatePhone), false);
  assert.deepEqual(discovery.ingestFailures, [{
    providerConnectionId: "search-ok",
    resultIndex: 1,
    errorCode: "SEARCH_RESULT_INVALID"
  }]);
});

test("recomputes hard gates deterministically and blocks ineligible strategy or review actions", async () => {
  const judgments: AcquisitionJudgmentPort = {
    async qualify({ policyVersion }) {
      return {
        qualification: {
          decisionEngine: "model",
          ruleVersion: policyVersion,
          promptVersion: "qualification.model.v1",
          modelProvider: "zhipu",
          model: "glm-test",
          dimensions: {
            demandStrength: 100,
            fit: 100,
            identityConfidence: 100,
            buyingStage: 100,
            budgetPotential: 100,
            decisionReachability: 100,
            freshness: 100,
            evidenceDiversity: 100,
            negativeSignalRisk: 0,
            contactRisk: 0
          },
          hardGates: {
            hasOriginalSource: true,
            identityResolved: true,
            notDoNotContact: true,
            noExplicitRejection: true,
            publicDataOnly: true,
            evidenceFresh: true,
            schemaValid: true
          },
          evidenceExcerpts: {},
          reasons: ["model supplied optimistic gates"]
        },
        financial: {
          currency: "CNY",
          predictedDealAmountMinor: 1_000_000,
          grossMarginBps: 5_000,
          closeProbabilityBps: 8_000,
          acquisitionCostMinor: 10_000,
          salesCostMinor: 10_000,
          serviceCostMinor: 100_000,
          benchmarkDealAmountMinor: 1_000_000,
          collectionDays: 30,
          creditRisk: 20,
          repeatPotential: 50,
          referralPotential: 30
        }
      };
    }
  };
  const { executor } = createHarness({
    judgments,
    negativeSignals: ["别联系我"],
    resolvedIdentities: false
  });
  const discovery = await discover(executor, ["search-ok"]);
  const individual = discovery.candidates.find(
    (item: any) => item.partyType === "individual"
  );
  const qualification = await execute(executor, "qualify_candidate", {
    candidateId: individual.id,
    policyVersion: "qualification-rules.v2"
  });
  assert.equal(qualification.qualification.grade, "D");
  assert.deepEqual(
    qualification.qualification.hardGateFailures,
    ["explicit_rejection"]
  );
  assert.equal(
    qualification.qualification.reasons.some((reason: string) =>
      reason.includes("确定性硬门禁")
    ),
    true
  );

  await assert.rejects(
    execute(executor, "research_candidate", {
      candidateId: individual.id,
      depth: "standard",
      researchQuestions: []
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "ELIGIBILITY_BLOCKED"
  );
  await assert.rejects(
    execute(executor, "draft_connection_strategy", {
      candidateId: individual.id,
      targetRole: "负责人",
      channels: ["public_reply"]
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "ELIGIBILITY_BLOCKED"
  );
  await assert.rejects(
    execute(executor, "create_review_task", {
      candidateId: individual.id,
      proposedAction: "public_reply",
      rationale: "不应创建"
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "ELIGIBILITY_BLOCKED"
  );
});

test("never accepts model-created evidence as formal evidence", async () => {
  const malicious = {
    async research() {
      return {
        summary: "attempted evidence injection",
        findings: [],
        newEvidence: [{
          targetType: "organization",
          sourcePlatform: "model",
          sourceTitle: "hallucinated",
          sourceSnippet: "hallucinated",
          publishedAt: null,
          locale: "zh-CN",
          rawArtifactHash: sha256("hallucinated"),
          contentHash: sha256("hallucinated-content"),
          provenance: {
            kind: "search_result",
            provider: "model",
            queryText: "hallucinated",
            sourceUrl: "https://example.cn/hallucinated",
            resultRank: 1
          },
          accessStatus: "public_content"
        }]
      };
    }
  } as unknown as AcquisitionJudgmentPort;
  const { executor, domain } = createHarness({ judgments: malicious });
  const discovery = await discover(executor, ["search-ok"]);
  const candidate = discovery.candidates[0];
  const before = await domain.getCandidate({
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    actorId: identity.actorId
  }, candidate.id);

  await assert.rejects(
    execute(executor, "research_candidate", {
      candidateId: candidate.id,
      depth: "deep",
      researchQuestions: []
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "INVALID_JUDGMENT_RESULT"
  );
  const after = await domain.getCandidate({
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    actorId: identity.actorId
  }, candidate.id);
  assert.deepEqual(after.evidenceIds, before.evidenceIds);
});

test("retired outcome tool cannot write even with a mismatched execution", async () => {
  const {
    executor,
    domain,
    reviews,
    executions
  } = createHarness();
  const discovery = await discover(executor, ["search-ok"]);
  const candidate = discovery.candidates[0];
  const qualification = await execute(executor, "qualify_candidate", {
    candidateId: candidate.id,
    policyVersion: "qualification.v1"
  });
  const scope = {
    ownerId: identity.ownerId,
    teamId: identity.teamId,
    actorId: identity.actorId
  };
  await domain.reviewCandidate(scope, candidate.id, {
    action: "approved",
    decisionVersion: qualification.qualification.decisionVersion,
    reason: null,
    idempotencyKey: "approve:mismatch"
  });
  const review = await execute(executor, "create_review_task", {
    candidateId: candidate.id,
    proposedAction: "convert",
    rationale: "人工审核转换"
  }, "review:mismatch");
  await domain.convertCandidate(scope, candidate.id, {
    decisionVersion: qualification.qualification.decisionVersion,
    idempotencyKey: "convert:mismatch"
  });
  reviews.approve(scope, review.reviewTask.id);
  executions.record({
    executionId: "execution-mismatch",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    candidateId: candidate.id,
    reviewTaskId: review.reviewTask.id,
    proposedAction: "email",
    executedAt: "2026-07-24T05:59:00.000Z",
    credential: {
      issuer: "goodjob-action-worker",
      credentialId: "credential-mismatch",
      proofHash: sha256("mismatch")
    }
  });

  await assert.rejects(
    execute(executor, "record_outcome", {
      candidateId: candidate.id,
      reviewTaskId: review.reviewTask.id,
      outcome: "won",
      occurredAt: "2026-07-24T06:00:00.000Z",
      amountMinor: 100,
      currency: "CNY"
    }, "outcome:mismatch"),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "LEGACY_OUTCOME_TOOL_READ_ONLY"
  );
});

test("validates retired outcome payload shape before returning read-only", async () => {
  const { executor } = createHarness();
  await assert.rejects(
    execute(executor, "record_outcome", {
      candidateId: "candidate-a",
      reviewTaskId: "review-a",
      outcome: "won",
      occurredAt: "2026-07-24T06:00:00.000Z",
      amountMinor: 10.5,
      currency: "CNY"
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "INVALID_PAYLOAD"
  );
  await assert.rejects(
    execute(executor, "record_outcome", {
      candidateId: "candidate-a",
      reviewTaskId: "review-a",
      outcome: "won",
      occurredAt: "2026-07-24T06:00:00.000Z",
      amountMinor: 100,
      currency: "ZZZ"
    }, "outcome:unknown-currency"),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "LEGACY_OUTCOME_TOOL_READ_ONLY"
  );
});

test("normalizes date-only performance windows to inclusive Shanghai instants", async () => {
  const calls: unknown[] = [];
  const { executor } = createHarness({
    performance: {
      async get(scope, query) {
        calls.push({ scope, query });
        return { ok: true };
      }
    }
  });

  const result = await execute(executor, "get_acquisition_performance", {
    platform: "douyin",
    from: "2026-08-02",
    to: "2026-08-02"
  }, "performance:valid");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    scope: { ownerId: "owner-1", teamId: "team-1" },
    query: {
      platform: "douyin",
      from: "2026-08-01T16:00:00.000Z",
      to: "2026-08-02T15:59:59.999Z"
    }
  }]);
});

test("rejects invalid date-only performance windows without querying", async () => {
  const calls: unknown[] = [];
  const { executor } = createHarness({
    performance: {
      async get(scope, query) {
        calls.push({ scope, query });
        return { ok: true };
      }
    }
  });
  const invalidPayloads = [
    { from: "2026-02-30", to: "2026-02-30" },
    { from: "2026-08-08", to: "2026-08-07" },
    { from: "2026-05-09", to: "2026-08-07" }
  ];

  for (const [index, payload] of invalidPayloads.entries()) {
    await assert.rejects(
      execute(
        executor,
        "get_acquisition_performance",
        payload,
        `performance:invalid:${index}`
      ),
      (error: unknown) =>
        error instanceof AcquisitionToolExecutorError
        && error.code === "INVALID_PAYLOAD"
    );
  }
  assert.deepEqual(calls, []);
});

test("domain errors remain typed underneath the executor harness", () => {
  assert.equal(
    new AcquisitionDomainError("resource_not_found", "secret id", 404).code,
    "resource_not_found"
  );
});
