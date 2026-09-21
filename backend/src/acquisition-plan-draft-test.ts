import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import {
  acquisitionPublicPlanCreateSchema
} from "./acquisition-plan-contract.js";
import {
  AcquisitionPlanDraftError,
  createAcquisitionPlanDraftGenerator
} from "./acquisition-plan-draft.js";
import {
  planReadinessIssues
} from "./acquisition-plan-readiness.js";
import type {
  AcquisitionPlanPayload,
  AcquisitionProviderConnectionSnapshot
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionPlanRunService
} from "./acquisition-plan-run-service.js";
import {
  ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ACQUISITION_MODEL_CONTENT_HASHES,
  ACQUISITION_MODEL_PROMPT_VERSION,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  ACQUISITION_PLAN_DRAFT_PROMPT_ID,
  ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
  ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID
} from "./acquisition-model-content.js";
import {
  acquisitionPiModelSnapshotFromStored
} from "./acquisition-pi-runtime-factory.js";
import type {
  ToolCallingRequest
} from "./model-providers/gateway.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

const scope = {
  ownerId: "owner-plan-draft",
  teamId: "team-plan-draft",
  actorId: "sales-plan-draft"
};

const snapshot: StoredAiJobModelSnapshot = {
  jobId: "job-plan-draft",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  connectionId: "model-connection-plan-draft",
  credentialVersion: 7,
  provider: "qwen",
  model: "qwen-plus",
  capabilitySnapshot: {
    structuredOutput: true,
    toolCalling: true,
    parallelToolCalling: false,
    streaming: true,
    modelListing: true
  },
  promptVersion: ACQUISITION_MODEL_PROMPT_VERSION,
  schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
  promptHash: ACQUISITION_MODEL_CONTENT_HASHES.promptHash,
  schemaHash: ACQUISITION_MODEL_CONTENT_HASHES.schemaHash,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  baseUrlFingerprint: "sha256:qwen-plan-draft-base",
  createdAt: "2026-07-26T00:00:00.000Z"
};

const transcript: AgentMessage[] = [{
  role: "user",
  content: "我们销售企业服务，希望同时覆盖公司和公开表达经营需求的个人。",
  timestamp: 1
}];

function validIntent() {
  return {
    name: "企业服务双主体公开获客计划",
    objective: "发现有明确增长与采购需求的企业和经营者",
    icp: {
      industries: ["企业服务"],
      regions: ["中国大陆"],
      organizationCriteria: ["存在公开采购、招聘或扩张信号"],
      individualCriteria: ["公开职业主页表达经营增长需求"],
      exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: {
      organization: true,
      individual: true
    },
    queryIntents: [{
      subjectChannel: "organization" as const,
      query: "企业服务 采购 OR 招聘销售"
    }, {
      subjectChannel: "individual" as const,
      query: "经营者 公开表达 获客难"
    }],
    budgetIntent: {
      billingCurrency: "CNY",
      maxRequests: 10,
      maxResults: 11,
      maxAmountMinor: 3,
      maxDurationSeconds: 9
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

function fullPayload(
  draft: ReturnType<typeof acquisitionPublicPlanCreateSchema.parse>
): AcquisitionPlanPayload {
  const stored = acquisitionPiModelSnapshotFromStored(snapshot);
  const {
    modelConnectionId: _modelConnectionId,
    ...plan
  } = draft;
  return {
    ...plan,
    modelSnapshotRef: {
      jobSnapshotId: stored.jobId,
      connectionId: stored.connectionId,
      credentialVersion: stored.credentialVersion,
      provider: stored.provider,
      model: stored.model,
      capabilitySnapshotHash: stored.capabilitySnapshotHash,
      promptVersion: stored.promptVersion,
      schemaVersion: stored.schemaVersion,
      promptHash: stored.promptHash,
      schemaHash: stored.schemaHash
    }
  };
}

const activeConnection: AcquisitionProviderConnectionSnapshot = {
  connectionId: "connection-brave",
  providerId: "brave",
  kind: "search",
  status: "active",
  credentialVersion: 2
};

function generatorReturning(
  argumentsValue: Record<string, unknown>,
  options: {
    connectionRows?: AcquisitionProviderConnectionSnapshot[];
    resolvedSnapshot?: StoredAiJobModelSnapshot;
    toolCallCount?: number;
    idFactory?: (prefix: string) => string;
  } = {}
) {
  return createAcquisitionPlanDraftGenerator({
    async resolveSession() {
      return {
        snapshot: options.resolvedSnapshot ?? snapshot,
        gateway: {
          async callTools() {
            const count = options.toolCallCount ?? 1;
            return {
              toolCalls: Array.from({ length: count }, (_, index) => ({
                id: `plan-draft-call-${index + 1}`,
                name: ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
                arguments: structuredClone(argumentsValue)
              })),
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                reasoningTokens: 0
              },
              providerRequestId: "provider-plan-draft"
            };
          }
        }
      };
    },
    connections: {
      async list() {
        return options.connectionRows ?? [activeConnection];
      }
    },
    idFactory: options.idFactory ?? ((prefix) => `${prefix}-stable`)
  });
}

function generateWith(
  generator: ReturnType<typeof createAcquisitionPlanDraftGenerator>,
  targetPlatform?: "douyin" | "web"
) {
  return generator.generate({
    ...scope,
    sessionId: "session-plan-draft",
    transcript,
    prompt: "请生成一个可批准的获客计划",
    ...(targetPlatform ? { targetPlatform } : {})
  });
}

function isDraftError(
  error: unknown,
  code: string,
  details: readonly string[] | null = null
) {
  return error instanceof AcquisitionPlanDraftError
    && error.code === code
    && error.message === code
    && (details === null
      ? error.details === null
      : JSON.stringify(error.details) === JSON.stringify(details));
}

test("generates a trusted, ready plan with stable cartesian operations and conserved budgets", async () => {
  const requests: ToolCallingRequest[] = [];
  const listedScopes: Array<{ ownerId: string; teamId: string }> = [];
  const rows = [{
    connectionId: "connection-serper",
    providerId: "serper",
    kind: "search",
    status: "active",
    credentialVersion: 3,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    scope: "personal"
  }, {
    connectionId: "connection-brave",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 2,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    scope: "personal"
  }, {
    connectionId: "connection-cross-tenant",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 9,
    ownerId: "other-owner",
    teamId: scope.teamId,
    scope: "personal"
  }, {
    connectionId: "connection-team-scope",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 4,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    scope: "team"
  }, {
    connectionId: "connection-disabled",
    providerId: "serper",
    kind: "search",
    status: "disabled",
    credentialVersion: 1
  }, {
    connectionId: "connection-inactive",
    providerId: "brave",
    kind: "search",
    status: "inactive",
    credentialVersion: 1
  }, {
    connectionId: "connection-not-search",
    providerId: "brave",
    kind: "content_fetch",
    status: "active",
    credentialVersion: 1
  }, {
    connectionId: "connection-unofficial",
    providerId: "unregistered-search",
    kind: "search",
    status: "active",
    credentialVersion: 1
  }] as unknown as AcquisitionProviderConnectionSnapshot[];
  let operationSequence = 0;
  const generator = createAcquisitionPlanDraftGenerator({
    async resolveSession(input) {
      assert.deepEqual(input, {
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        sessionId: "session-plan-draft"
      });
      return {
        snapshot,
        gateway: {
          async callTools(request) {
            requests.push(structuredClone(request));
            return {
              toolCalls: [{
                id: "plan-draft-call",
                name: ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
                arguments: validIntent()
              }],
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                reasoningTokens: 5
              },
              providerRequestId: "provider-plan-draft"
            };
          }
        }
      };
    },
    connections: {
      async list(inputScope) {
        listedScopes.push(inputScope);
        return rows;
      }
    },
    idFactory(prefix) {
      assert.equal(prefix, "operation");
      operationSequence += 1;
      return `operation-${operationSequence}`;
    }
  });

  const generated = await generator.generate({
    ...scope,
    sessionId: "session-plan-draft",
    transcript,
    prompt: "请生成一个可批准的获客计划",
    targetPlatform: "douyin"
  });

  assert.deepEqual(listedScopes, [{
    ownerId: scope.ownerId,
    teamId: scope.teamId
  }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    contentBinding: {
      promptId: ACQUISITION_PLAN_DRAFT_PROMPT_ID,
      toolSchemaId: ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID,
      dynamicData: {
        conversation: transcript,
        prompt: "请生成一个可批准的获客计划",
        targetPlatform: "douyin"
      }
    },
    parallelToolCalls: false
  });
  assert.deepEqual(generated.planDraft.providerConnections, [{
    connectionId: "connection-brave",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 2
  }, {
    connectionId: "connection-serper",
    providerId: "serper",
    kind: "search",
    status: "active",
    credentialVersion: 3
  }]);
  assert.equal(generated.planDraft.targetPlatform, "douyin");
  assert.deepEqual(
    generated.planDraft.operations.map((operation) => ({
      operationId: operation.operationId,
      subjectChannel: operation.subjectChannel,
      connectionId: operation.connectionId,
      query: operation.query,
      allocatedBudget: operation.allocatedBudget
    })),
    [{
      operationId: "operation-1",
      subjectChannel: "organization",
      connectionId: "connection-brave",
      query: "site:douyin.com 企业服务 采购 OR 招聘销售",
      allocatedBudget: {
        requests: 2,
        results: 2,
        amountMinor: 1,
        durationSeconds: 2
      }
    }, {
      operationId: "operation-2",
      subjectChannel: "organization",
      connectionId: "connection-serper",
      query: "site:douyin.com 企业服务 采购 OR 招聘销售",
      allocatedBudget: {
        requests: 2,
        results: 2,
        amountMinor: 1,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-3",
      subjectChannel: "organization",
      connectionId: "connection-brave",
      query: "site:iesdouyin.com 企业服务 采购 OR 招聘销售",
      allocatedBudget: {
        requests: 1,
        results: 2,
        amountMinor: 1,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-4",
      subjectChannel: "organization",
      connectionId: "connection-serper",
      query: "site:iesdouyin.com 企业服务 采购 OR 招聘销售",
      allocatedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-5",
      subjectChannel: "individual",
      connectionId: "connection-brave",
      query: "site:douyin.com 经营者 公开表达 获客难",
      allocatedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-6",
      subjectChannel: "individual",
      connectionId: "connection-serper",
      query: "site:douyin.com 经营者 公开表达 获客难",
      allocatedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-7",
      subjectChannel: "individual",
      connectionId: "connection-brave",
      query: "site:iesdouyin.com 经营者 公开表达 获客难",
      allocatedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }, {
      operationId: "operation-8",
      subjectChannel: "individual",
      connectionId: "connection-serper",
      query: "site:iesdouyin.com 经营者 公开表达 获客难",
      allocatedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }]
  );
  assert.equal(
    generated.planDraft.modelConnectionId,
    snapshot.connectionId
  );
  assert.equal("modelSnapshotRef" in generated.planDraft, false);
  assert.deepEqual(
    generated.planDraft.operations.reduce((totals, operation) => ({
      requests: totals.requests + operation.allocatedBudget.requests,
      results: totals.results + operation.allocatedBudget.results,
      amountMinor:
        totals.amountMinor + operation.allocatedBudget.amountMinor,
      durationSeconds:
        totals.durationSeconds
        + operation.allocatedBudget.durationSeconds
    }), {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    }),
    {
      requests: 10,
      results: 11,
      amountMinor: 3,
      durationSeconds: 9
    }
  );
  const publicPlan =
    acquisitionPublicPlanCreateSchema.parse(generated.planDraft);
  const readyPayload = fullPayload(publicPlan);
  assert.deepEqual(planReadinessIssues(readyPayload), []);
  let planIdSequence = 0;
  const planService = new AcquisitionPlanRunService({
    repository: new InMemoryAcquisitionPlanRunRepository(),
    executionPort: {
      async enqueue() {},
      async requestPause() {},
      async resume() {},
      async requestCancel() {}
    },
    idFactory: (prefix) => `${prefix}-${++planIdSequence}`,
    now: () => "2026-07-26T01:00:00.000Z"
  });
  const plan = await planService.createPlan(scope, readyPayload);
  const approved = await planService.approvePlan(
    scope,
    plan.id,
    plan.etag,
    {
      decision: "approve",
      reason: "人工确认该服务端草稿可执行"
    }
  );
  assert.equal(approved.status, "approved");
  assert.match(generated.summary, /企业服务双主体公开获客计划/);
  assert.equal(generated.assistantMessage.role, "assistant");
});

test("generated plans default omitted legacy target platform to web", async () => {
  let sequence = 0;
  const generated = await generateWith(generatorReturning(validIntent(), {
    idFactory: (prefix) => `${prefix}-${++sequence}`
  }));

  assert.equal(generated.planDraft.targetPlatform, "web");
});

test("rejects model attempts to inject trusted connection, snapshot, operation, or allocation fields", async () => {
  const intent = validIntent();
  const injected = [{
    ...intent,
    connectionId: "attacker-connection"
  }, {
    ...intent,
    credentialVersion: 999
  }, {
    ...intent,
    modelSnapshotRef: {
      connectionId: "attacker-model"
    }
  }, {
    ...intent,
    queryIntents: [{
      ...intent.queryIntents[0],
      operationId: "attacker-operation"
    }, intent.queryIntents[1]]
  }, {
    ...intent,
    queryIntents: [{
      ...intent.queryIntents[0],
      allocatedBudget: {
        requests: 999,
        results: 999,
        amountMinor: 999,
        durationSeconds: 999
      }
    }, intent.queryIntents[1]]
  }];

  for (const argumentsValue of injected) {
    await assert.rejects(
      generateWith(generatorReturning(argumentsValue)),
      (error: unknown) =>
        error instanceof Error
        && error.message === "PLAN_DRAFT_INTENT_INVALID"
    );
  }
});

test("enforces the 500-operation cartesian-product boundary without truncation", async () => {
  const twoConnections = [
    activeConnection,
    {
      ...activeConnection,
      connectionId: "connection-serper",
      providerId: "serper",
      credentialVersion: 3
    }
  ];
  const intentAtLimit = {
    ...validIntent(),
    queryIntents: Array.from({ length: 250 }, (_, index) => ({
      subjectChannel: index % 2 === 0
        ? "organization" as const
        : "individual" as const,
      query: `stable query ${index + 1}`
    })),
    budgetIntent: {
      billingCurrency: "CNY",
      maxRequests: 500,
      maxResults: 500,
      maxAmountMinor: 0,
      maxDurationSeconds: 500
    }
  };
  let sequence = 0;
  const accepted = await generateWith(generatorReturning(intentAtLimit, {
    connectionRows: twoConnections,
    idFactory: (prefix) => `${prefix}-${++sequence}`
  }));
  assert.equal(accepted.planDraft.operations.length, 500);

  const threeConnections = [...twoConnections, {
    ...activeConnection,
    connectionId: "connection-brave-backup",
    credentialVersion: 4
  }];
  const tooMany = {
    ...intentAtLimit,
    queryIntents: Array.from({ length: 167 }, (_, index) => ({
      subjectChannel: index % 2 === 0
        ? "organization" as const
        : "individual" as const,
      query: `overflow query ${index + 1}`
    }))
  };
  await assert.rejects(
    generateWith(generatorReturning(tooMany, {
      connectionRows: threeConnections
    })),
    (error: unknown) =>
      isDraftError(error, "PLAN_DRAFT_TOO_MANY_OPERATIONS")
  );
});

test("Douyin expansion happens before the 500-operation ceiling and conserves all budgets", async () => {
  const intentAtLimit = {
    ...validIntent(),
    queryIntents: Array.from({ length: 250 }, (_, index) => ({
      subjectChannel: index % 2 === 0
        ? "organization" as const
        : "individual" as const,
      query: `douyin intent ${index + 1}`
    })),
    budgetIntent: {
      billingCurrency: "CNY",
      maxRequests: 503,
      maxResults: 509,
      maxAmountMinor: 257,
      maxDurationSeconds: 521
    }
  };
  let sequence = 0;
  const accepted = await generateWith(generatorReturning(intentAtLimit, {
    idFactory: (prefix) => `${prefix}-${++sequence}`
  }), "douyin");

  assert.equal(accepted.planDraft.operations.length, 500);
  assert.deepEqual(
    accepted.planDraft.operations.slice(0, 4).map((operation) => ({
      subjectChannel: operation.subjectChannel,
      query: operation.query
    })),
    [{
      subjectChannel: "organization",
      query: "site:douyin.com douyin intent 1"
    }, {
      subjectChannel: "organization",
      query: "site:iesdouyin.com douyin intent 1"
    }, {
      subjectChannel: "individual",
      query: "site:douyin.com douyin intent 2"
    }, {
      subjectChannel: "individual",
      query: "site:iesdouyin.com douyin intent 2"
    }]
  );
  assert.deepEqual(
    accepted.planDraft.operations.reduce((total, operation) => ({
      requests: total.requests + operation.allocatedBudget.requests,
      results: total.results + operation.allocatedBudget.results,
      amountMinor:
        total.amountMinor + operation.allocatedBudget.amountMinor,
      durationSeconds:
        total.durationSeconds + operation.allocatedBudget.durationSeconds
    }), {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    }),
    {
      requests: 503,
      results: 509,
      amountMinor: 257,
      durationSeconds: 521
    }
  );

  const tooMany = {
    ...intentAtLimit,
    queryIntents: Array.from({ length: 251 }, (_, index) => ({
      subjectChannel: index % 2 === 0
        ? "organization" as const
        : "individual" as const,
      query: `douyin overflow ${index + 1}`
    }))
  };
  await assert.rejects(
    generateWith(generatorReturning(tooMany), "douyin"),
    (error: unknown) =>
      isDraftError(error, "PLAN_DRAFT_TOO_MANY_OPERATIONS")
  );
});

test("returns stable errors for missing connections and budgets too small to execute", async () => {
  let modelCalls = 0;
  const noConnectionGenerator = createAcquisitionPlanDraftGenerator({
    async resolveSession() {
      return {
        snapshot,
        gateway: {
          async callTools() {
            modelCalls += 1;
            throw new Error("model must not run without a search connection");
          }
        }
      };
    },
    connections: {
      async list() {
        return [{
          ...activeConnection,
          status: "disabled"
        }];
      }
    }
  });
  await assert.rejects(
    generateWith(noConnectionGenerator),
    (error: unknown) =>
      isDraftError(error, "SEARCH_PROVIDER_CONNECTION_REQUIRED")
  );
  assert.equal(modelCalls, 0);

  const tooSmall = {
    ...validIntent(),
    budgetIntent: {
      ...validIntent().budgetIntent,
      maxRequests: 1
    }
  };
  await assert.rejects(
    generateWith(generatorReturning(tooSmall)),
    (error: unknown) =>
      isDraftError(error, "PLAN_DRAFT_BUDGET_TOO_SMALL")
  );
});

test("returns only ordered readiness issue codes and never returns an unready draft", async () => {
  const unready = {
    ...validIntent(),
    subjectChannels: {
      organization: true,
      individual: false
    },
    queryIntents: [{
      subjectChannel: "organization" as const,
      query: "企业服务 采购"
    }]
  };

  await assert.rejects(
    generateWith(generatorReturning(unready)),
    (error: unknown) =>
      isDraftError(error, "PLAN_DRAFT_NOT_READY", [
        "dual_subject_channels_required",
        "individual_search_query_required"
      ])
  );
});

test("legacy sessions require a new snapshot before plan drafting", async () => {
  const legacySnapshot: StoredAiJobModelSnapshot = {
    ...snapshot,
    jobId: "job-legacy-plan-draft",
    promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES
  };
  let downstreamCalls = 0;
  const legacyGenerator = createAcquisitionPlanDraftGenerator({
    async resolveSession() {
      return {
        snapshot: legacySnapshot,
        gateway: {
          async callTools() {
            downstreamCalls += 1;
            throw new Error("legacy snapshots must not draft plans");
          }
        }
      };
    },
    connections: {
      async list() {
        downstreamCalls += 1;
        return [activeConnection];
      }
    }
  });

  await assert.rejects(
    generateWith(legacyGenerator),
    (error: unknown) =>
      isDraftError(error, "MODEL_CONTENT_UPGRADE_REQUIRED")
  );
  assert.equal(downstreamCalls, 0);
});
