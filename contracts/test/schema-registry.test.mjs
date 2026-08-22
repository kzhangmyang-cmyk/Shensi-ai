import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadOpenApiSource, loadSchemaRegistry } from "./helpers.mjs";

const expected = [
  "api-error", "paged-result", "async-operation", "model-provider",
  "model-connection", "model-capability", "model-call-record",
  "discovery-provider", "provider-connection", "content-fetch-operation",
  "import-operation", "candidate-intelligence-operation", "douyin-identity-resolution-operation", "douyin-comment-event", "acquisition-plan", "acquisition-run",
  "acquisition-run-presentation", "douyin-visual-comment-observation",
  "acquisition-visual-reader-session",
  "acquisition-operation-shard", "discovery-evidence", "party-ref",
  "organization-candidate", "individual-demand-signal",
  "qualification-decision", "battle-card", "review-event",
  "outcome-feedback", "financial-value-decision", "copilot-session",
  "copilot-message", "copilot-task", "platform-connection",
  "platform-capability-snapshot", "platform-event", "action-policy",
  "action-receipt", "financial-council"
];

const validSha256 = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function financialCouncilRunFixture() {
  const businessReport = {
    currency: "CNY", companyName: "GoodJob", period: "2026-08",
    balanceSheet: { period: "2026-08", cashMinor: 100000, receivablesMinor: 20000, inventoryMinor: 0, otherCurrentAssetsMinor: 0, nonCurrentAssetsMinor: 0, currentLiabilitiesMinor: 10000, nonCurrentLiabilitiesMinor: 0, accountsPayableMinor: 5000 },
    incomeStatement: { period: "2026-08", revenueMinor: 100000, costOfGoodsSoldMinor: 40000, operatingExpensesMinor: 30000, interestExpenseMinor: 0, taxExpenseMinor: 5000, productLines: [], customers: [] },
    cashFlow: null, costDetail: null, taxRisk: null
  };
  const scenarioMoney = { conservative: 100, base: 200, optimistic: 300 };
  const scenarioBps = { conservative: -100, base: 0, optimistic: 100 };
  const action = {
    actionId: "action-1", kind: "collect_receivable", sourceFindingIds: ["finding-1"],
    ownerRole: "cashflow", subjectRef: null, explanation: "Collect an overdue receivable.",
    durationDays: 7, prerequisites: [], mutuallyExclusiveWith: [], cashImpact: scenarioMoney,
    profitImpact: scenarioMoney, riskReductionBps: scenarioBps, budgetCostMinor: 0,
    capacityUnits: 1, confidenceBps: 9000, requiredCapabilities: ["finance.council.approve"],
    requiresHumanApproval: true
  };
  const portfolio = (kind) => ({
    portfolioId: `portfolio-${kind}`, runId: "run-1", revision: 1, kind,
    actionIds: ["action-1"], actions: [action], hardConstraints: [], objectiveScoreBps: 8000,
    scenarioForecast: { cashImpact: scenarioMoney, profitImpact: scenarioMoney, riskReductionBps: scenarioBps },
    sensitivityAnalysis: [], rejectedActions: [], requiredApprovalCapabilities: ["finance.council.approve"],
    expiresAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-16T00:00:00.000Z"
  });
  return {
    runId: "run-1", workspaceId: "workspace-1", currency: "CNY", status: "awaiting_approval",
    revision: 7, dataAsOf: "2026-08-16T00:00:00.000Z", businessReport,
    policyVersionId: "policy-1", snapshotId: "snapshot-1", snapshotHash: validSha256,
    consensusReport: null, portfolios: [portfolio("balanced"), portfolio("cash_first"), portfolio("growth_first")],
    latestPortfolioRevision: 1, approval: null, createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z", expiresAt: "2026-08-17T00:00:00.000Z"
  };
}

const douyinCommentEvent = {
  eventId: "comment-event-1",
  platform: "douyin",
  eventType: "comment",
  platformEventId: "comment-123",
  videoId: "video-456",
  parentCommentId: null,
  text: "想了解一下你们的企业服务方案",
  textHash: validSha256,
  occurredAt: "2026-08-15T01:00:00.000Z",
  capturedAt: "2026-08-15T01:01:00.000Z",
  likeCount: 3,
  replyCount: 1,
  ipLabel: "上海",
  actor: {
    displayName: "公开用户",
    handle: "public-user",
    secUid: "sec-user-1"
  },
  sourceUrl: "https://www.douyin.com/video/456",
  coverage: "public_top_level_sample",
  accessStatus: "public_content",
  providerVersion: "douyin-public-comment-provider-v1",
  rawArtifactHash: validSha256
};

const visualFieldConfidences = {
  visibleText: 0.99,
  displayName: 0.96,
  visibleTimeText: 0.92,
  likeCount: 0.9,
  replyCount: 0.9,
  platformCommentId: 1,
  publicProfileUrl: 1,
  secUid: 1
};

const visualObservation = {
  observationId: "visual-observation-1",
  sessionId: "visual-session-1",
  sourceUrl: "https://www.douyin.com/video/7536012345678909876",
  videoId: "7536012345678909876",
  visibleText: "评论卡当前可见的企业采购需求",
  textHash: validSha256,
  domTextHash: validSha256,
  ocrTextHash: null,
  displayName: "公开用户",
  visibleTimeText: "2小时前",
  likeCount: 3,
  replyCount: 1,
  platformCommentId: "1234567890123456789",
  publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA_public-actor",
  secUid: "MS4wLjABAAAA_public-actor",
  extractionMethod: "dom",
  fieldConfidences: visualFieldConfidences,
  viewportHash: validSha256,
  cardBounds: { x: 24, y: 32, width: 640, height: 180 },
  redactedCropHash: null,
  readerVersion: "goodjob-douyin-visual-reader@1.0.0",
  capturedAt: "2026-08-15T03:00:00.000Z"
};

const visualSubmission = {
  clientObservationKey: "client-observation-1",
  sourceUrl: visualObservation.sourceUrl,
  videoId: visualObservation.videoId,
  visibleText: visualObservation.visibleText,
  domTextHash: visualObservation.domTextHash,
  ocrTextHash: visualObservation.ocrTextHash,
  displayName: visualObservation.displayName,
  visibleTimeText: visualObservation.visibleTimeText,
  likeCount: visualObservation.likeCount,
  replyCount: visualObservation.replyCount,
  platformCommentId: visualObservation.platformCommentId,
  publicProfileUrl: visualObservation.publicProfileUrl,
  secUid: visualObservation.secUid,
  extractionMethod: visualObservation.extractionMethod,
  fieldConfidences: visualFieldConfidences,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  cardBounds: visualObservation.cardBounds,
  readerVersion: visualObservation.readerVersion,
  capturedAt: visualObservation.capturedAt,
  redactedCrop: null
};

const visualUsage = {
  videoCount: 1,
  observationCount: 1,
  scrollCount: 0,
  ocrCallCount: 0,
  domObservationCount: 1,
  accessibilityObservationCount: 0,
  ocrObservationCount: 0,
  lowConfidenceObservationCount: 0,
  artifactCount: 0
};

const visualSession = {
  sessionId: "visual-session-1",
  runId: "run-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  platform: "douyin",
  coverage: "authorized_visible_top_level_sample",
  status: "created",
  artifactUploadEnabled: true,
  limits: {
    maxVideos: 10,
    maxCommentsPerVideo: 30,
    maxScrolls: 5,
    maxOcrCalls: 10,
    maxDurationMs: 120000
  },
  usage: visualUsage,
  outcome: null,
  lastErrorCode: null,
  createdAt: "2026-08-15T03:00:00.000Z",
  authorizedAt: "2026-08-15T03:00:00.000Z",
  updatedAt: "2026-08-15T03:00:00.000Z",
  expiresAt: "2026-08-15T03:02:00.000Z",
  completedAt: null
};

function compileVisualReaderDefinition(registry, definitionName) {
  const sessionSchema = registry.schemaDocuments.get(
    "acquisition-visual-reader-session"
  );
  assert.ok(sessionSchema, "visual reader session schema must be registered");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of registry.schemaDocuments.values()) ajv.addSchema(schema);
  return ajv.compile({
    $ref: `${sessionSchema.$id}#/$defs/${definitionName}`
  });
}

function acquisitionPlanPayload(overrides = {}) {
  return {
    targetPlatform: "douyin",
    name: "Douyin public comment plan",
    objective: "Discover public demand signals",
    icp: {
      industries: ["enterprise services"],
      regions: ["China"],
      organizationCriteria: ["public demand"],
      individualCriteria: ["public demand"],
      exclusionRules: []
    },
    subjectChannels: { organization: false, individual: true },
    providerConnections: [{
      connectionId: "public-comment-1",
      providerId: "experimental_public_sample",
      kind: "content_fetch",
      status: "active",
      credentialVersion: 1
    }],
    operations: [{
      operationId: "read-comments",
      subjectChannel: "individual",
      kind: "content_fetch",
      connectionId: "public-comment-1",
      sourceRef: "https://www.douyin.com/video/456",
      allocatedBudget: {
        requests: 3,
        results: 30,
        amountMinor: 0,
        durationSeconds: 120
      }
    }],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 3,
      maxResults: 30,
      maxAmountMinor: 0,
      maxDurationSeconds: 120
    },
    modelSnapshotRef: {
      jobSnapshotId: "snapshot-1",
      connectionId: "model-1",
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
      capabilitySnapshotHash: validSha256,
      promptVersion: "acquisition.v1",
      schemaVersion: "acquisition-plan.v1",
      promptHash: validSha256,
      schemaHash: validSha256
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    },
    ...overrides
  };
}

function acquisitionPlan(payload) {
  return {
    id: "plan-1",
    ownerId: "owner-1",
    teamId: "team-1",
    status: "draft",
    version: 1,
    revision: 1,
    etag: "etag-1",
    currentVersionId: "plan-version-1",
    approvedVersionId: null,
    approvedSnapshotHash: null,
    approvedBy: null,
    approvedAt: null,
    budgetSnapshot: payload.budgetSnapshot,
    payload,
    createdBy: "user-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedBy: "user-1",
    updatedAt: "2026-08-15T00:00:00.000Z"
  };
}

const platformContracts = {
  "platform-connection": {
    id: "platform-connection-1",
    tenantId: "tenant-1",
    teamId: "team-1",
    connectorId: "douyin-official-v1",
    platform: "douyin",
    platformAccountRef: "douyin-account-1",
    scopes: ["video.list", "event.read"],
    credentialVersion: 3,
    sync: {
      mode: "hybrid",
      cursor: "cursor-1"
    },
    status: "active",
    authorizationExpiresAt: "2026-09-05T00:00:00.000Z",
    limits: {
      api_requests_per_day: {
        limit: 1000,
        remaining: 875,
        resetsAt: "2026-08-06T00:00:00.000Z"
      }
    },
    capabilitySnapshotRef: {
      id: "platform-capability-snapshot-1",
      hash: validSha256
    },
    createdBy: "user-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:05:00.000Z"
  },
  "platform-capability-snapshot": {
    id: "platform-capability-snapshot-1",
    tenantId: "tenant-1",
    teamId: "team-1",
    connectionId: "platform-connection-1",
    credentialVersion: 3,
    snapshotHash: validSha256,
    capturedAt: "2026-08-05T00:05:00.000Z",
    expiresAt: "2026-08-05T01:05:00.000Z",
    capturedBy: "connector-worker-1",
    capabilities: {
      future_official_capability: {
        status: "available",
        scopes: ["future.scope"],
        limitRefs: ["api_requests_per_day"],
        reasonCode: null
      }
    }
  },
  "platform-event": {
    id: "platform-event-1",
    tenantId: "tenant-1",
    teamId: "team-1",
    platform: "douyin",
    platformAccountRef: "douyin-account-1",
    platformContentRef: "douyin-video-1",
    platformEventRef: "douyin-event-1",
    platformSubjectRef: "douyin-subject-1",
    eventType: "comment.created",
    rawPayloadHash: validSha256,
    normalizedEventHash: validSha256,
    occurredAt: "2026-08-05T00:10:00.000Z",
    capturedAt: "2026-08-05T00:11:00.000Z",
    authorizationSnapshot: {
      connectionId: "platform-connection-1",
      credentialVersion: 3,
      scopeHash: validSha256,
      capabilitySnapshotRef: {
        id: "platform-capability-snapshot-1",
        hash: validSha256
      }
    },
    dedupeKey: "douyin:douyin-account-1:douyin-event-1",
    accessStatus: "available",
    capturedBy: "connector-worker-1"
  },
  "action-policy": {
    id: "action-policy-1",
    tenantId: "tenant-1",
    teamId: "team-1",
    version: 1,
    planRef: {
      id: "acquisition-plan-1",
      version: 4,
      hash: validSha256
    },
    ruleBundleRef: {
      id: "action-rules-1",
      version: "1.0.0",
      hash: validSha256
    },
    policyHash: validSha256,
    actions: {
      future_official_capability: "review_required"
    },
    effectiveAt: "2026-08-05T00:00:00.000Z",
    expiresAt: "2026-09-05T00:00:00.000Z",
    createdBy: "user-1",
    createdAt: "2026-08-05T00:00:00.000Z"
  },
  "action-receipt": {
    id: "action-receipt-1",
    tenantId: "tenant-1",
    teamId: "team-1",
    intentRef: {
      id: "action-intent-1",
      hash: validSha256
    },
    decisionRef: {
      id: "action-decision-1",
      hash: validSha256
    },
    jobRef: {
      id: "action-job-1",
      attempt: 1
    },
    connectionRef: {
      id: "platform-connection-1",
      credentialVersion: 3
    },
    capabilitySnapshotRef: {
      id: "platform-capability-snapshot-1",
      hash: validSha256
    },
    idempotencyKey: "action-idempotency-1",
    externalId: "douyin-action-1",
    outcome: "succeeded",
    error: null,
    requestHash: validSha256,
    resultHash: validSha256,
    requestedAt: "2026-08-05T00:15:00.000Z",
    completedAt: "2026-08-05T00:15:01.000Z",
    recordedAt: "2026-08-05T00:15:01.000Z",
    recordedBy: "connector-worker-1"
  }
};

test("ai-acquisition.v1 exposes the complete unique schema registry", async () => {
  const registry = await loadSchemaRegistry();
  assert.deepEqual([...registry.names].sort(), [...expected].sort());
  assert.equal(registry.ids.size, expected.length);
  for (const validate of registry.validators.values()) {
    assert.equal(typeof validate, "function");
  }
});

test("financial council contract is closed and carries three portfolios", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("financial-council");
  assert.ok(validate, "financial-council schema must be registered");
  const valid = financialCouncilRunFixture();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, status: "created" }), false);
  assert.equal(validate({
    ...valid, status: "created", snapshotId: null, snapshotHash: null
  }), false);
  assert.equal(validate({ ...valid, hiddenPrompt: "ignore policy" }), false);
  assert.deepEqual(valid.portfolios.map((row) => row.kind), [
    "balanced", "cash_first", "growth_first"
  ]);
  const callerControlled = structuredClone(valid);
  callerControlled.businessReport.workspaceId = "forged-workspace";
  assert.equal(validate(callerControlled), false);
  const unsafeAction = structuredClone(valid);
  unsafeAction.portfolios[0].actions[0].execute = "payment";
  assert.equal(validate(unsafeAction), false);
  const negativeObjectiveScore = structuredClone(valid);
  negativeObjectiveScore.portfolios[0].objectiveScoreBps = -1;
  assert.equal(validate(negativeObjectiveScore), false);
});

test("growth bootstrap accepts the public financial council capabilities", async () => {
  const raw = JSON.parse(await readFile(new URL(
    "../json-schema/growth-bootstrap.v1.schema.json", import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(raw);
  const value = {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["finance.council.run", "finance.council.approve", "finance.council.policy.manage"],
    contractVersion: "1.0.10",
    contractHash: validSha256,
    features: ["finance"]
  };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...value,
    capabilities: ["acquisition.outcome.reconcile.internal"]
  }), false);
});

test("financial council create input keeps the business report optional branches optional", async () => {
  const registry = await loadSchemaRegistry();
  const document = registry.schemaDocuments.get("financial-council");
  assert.ok(document);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of registry.schemaDocuments.values()) ajv.addSchema(schema);
  const validate = ajv.compile({
    $ref: `${document.$id}#/$defs/FinancialCouncilCreateInput`
  });
  const businessReport = financialCouncilRunFixture().businessReport;
  delete businessReport.cashFlow;
  delete businessReport.costDetail;
  delete businessReport.taxRisk;
  delete businessReport.incomeStatement.productLines;
  delete businessReport.incomeStatement.customers;
  assert.equal(validate({
    currency: "CNY",
    dataAsOf: "2026-08-16T00:00:00.000Z",
    businessReport,
    policyVersionId: "policy-1"
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    currency: "CNY",
    dataAsOf: "2026-08-16T00:00:00.000Z",
    businessReport: { ...businessReport, companyName: "💰".repeat(4_000) },
    policyVersionId: "💰".repeat(255)
  }), true, JSON.stringify(validate.errors));

  const nestedOptional = financialCouncilRunFixture().businessReport;
  nestedOptional.cashFlow = {
    period: "2026-08",
    openingCashMinor: 100000,
    operatingInflowMinor: 50000,
    operatingOutflowMinor: 40000,
    investingNetMinor: 0,
    financingNetMinor: 0,
    expectedInflowsNext30DaysMinor: 20000,
    expectedOutflowsNext30DaysMinor: 10000,
    expectedInflowsNext31To90DaysMinor: 10000,
    expectedOutflowsNext31To90DaysMinor: 5000
  };
  nestedOptional.costDetail = {
    materialCostRateBps: 4000,
    laborCostMinor: 10000,
    rawMaterialCostMinor: 20000,
    salesCommissionRateBps: 500,
    fixedOverheadMinor: 5000
  };
  assert.equal(validate({
    currency: "CNY",
    dataAsOf: "2026-08-16T00:00:00.000Z",
    businessReport: nestedOptional,
    policyVersionId: "policy-1"
  }), true, JSON.stringify(validate.errors));
  const invalidPreviousRate = structuredClone(nestedOptional);
  invalidPreviousRate.costDetail.previousMaterialCostRateBps = null;
  assert.equal(validate({
    currency: "CNY",
    dataAsOf: "2026-08-16T00:00:00.000Z",
    businessReport: invalidPreviousRate,
    policyVersionId: "policy-1"
  }), false);

  for (const invalid of [
    { currency: "EUR", businessReport: { ...businessReport, currency: "EUR" } },
    { policyVersionId: "p".repeat(256) },
    { policyVersionId: "💰".repeat(256) },
    { businessReport: { ...businessReport, companyName: "x".repeat(4_001) } },
    { businessReport: { ...businessReport, companyName: "💰".repeat(4_001) } },
    { businessReport: {
      ...businessReport,
      incomeStatement: {
        ...businessReport.incomeStatement,
        productLines: Array.from({ length: 101 }, () => ({
          name: "p", revenueMinor: 1, costOfGoodsSoldMinor: 1,
          afterSalesCostMinor: 1, shippingCostMinor: 1,
          sellingExpenseMinor: 1, allocatedOverheadMinor: 1
        }))
      }
    } }
  ]) {
    const candidate = {
      currency: "CNY",
      dataAsOf: "2026-08-16T00:00:00.000Z",
      businessReport,
      policyVersionId: "policy-v1",
      ...invalid
    };
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  }
});

test("candidate intelligence operations expose only the strict public DTO", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("candidate-intelligence-operation");
  const operation = {
    id: "candidate-intelligence-1",
    candidateId: "candidate-1",
    status: "succeeded",
    currentStage: null,
    completedStages: ["research", "qualification", "battle_card"],
    skippedStages: [],
    research: {
      summary: "已形成公开证据支持的客户研究结论",
      findings: [{
        label: "需求信号",
        content: "客户正在调研获客方案",
        evidenceIds: ["evidence-1"],
        confidence: 0.88
      }]
    },
    qualification: {
      grade: "A",
      score: 82,
      hardGateFailures: [],
      financialValueId: "financial-value-1"
    },
    battleCardId: "battle-card-1",
    failure: null,
    createdAt: "2026-08-07T01:00:00.000Z",
    startedAt: "2026-08-07T01:00:01.000Z",
    updatedAt: "2026-08-07T01:00:03.000Z",
    completedAt: "2026-08-07T01:00:03.000Z",
    failedAt: null
  };

  assert.equal(validate(operation), true, JSON.stringify(validate.errors));
  for (const internalField of [
    "ownerId",
    "teamId",
    "actorId",
    "sessionId",
    "identityFingerprint",
    "idempotencyKey",
    "idempotencyKeyHash",
    "requestHash",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt"
  ]) {
    assert.equal(
      validate({ ...operation, [internalField]: "internal" }),
      false,
      internalField
    );
  }
});

test("Douyin identity operations expose only the strict public DTO", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("douyin-identity-resolution-operation");
  const operation = {
    id: "douyin-identity-1", candidateId: "candidate-1", candidateVersion: 2,
    status: "failed", currentStage: null, outcome: "provider_unavailable",
    retryable: true, canonicalProfileUrl: null, profileCandidates: [],
    evidence: [], intelligenceOperationId: null,
    createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:00:00.000Z"
  };
  assert.equal(validate(operation), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...operation, leaseToken: "secret" }), false);
  assert.equal(validate({ ...operation, ownerId: "owner-1" }), false);
});

test("platform and action placeholder components are published without routes", async () => {
  const document = await loadOpenApiSource();
  const componentRefs = {
    PlatformConnection: "../json-schema/platform-connection.v1.schema.json",
    PlatformCapabilitySnapshot: "../json-schema/platform-capability-snapshot.v1.schema.json",
    PlatformEvent: "../json-schema/platform-event.v1.schema.json",
    DouyinCommentEvent: "../json-schema/douyin-comment-event.v1.schema.json",
    ActionPolicy: "../json-schema/action-policy.v1.schema.json",
    ActionReceipt: "../json-schema/action-receipt.v1.schema.json"
  };
  for (const [name, ref] of Object.entries(componentRefs)) {
    assert.equal(document.components.schemas[name]?.$ref, ref);
  }
  assert.equal(
    Object.keys(document.paths).some((route) => /platform|action/i.test(route)),
    false
  );
});

test("Douyin comment events publish a strict top-level public sample", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("douyin-comment-event");

  assert.equal(validate(douyinCommentEvent), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...douyinCommentEvent, parentCommentId: "reply-1" }), false);
  assert.equal(validate({
    ...douyinCommentEvent,
    coverage: "all_comments"
  }), false);
  assert.equal(validate({
    ...douyinCommentEvent,
    actor: { ...douyinCommentEvent.actor, avatar: "https://example.com/a.jpg" }
  }), false);
  assert.equal(validate({ ...douyinCommentEvent, unexpected: true }), false);
  for (const field of ["textHash", "rawArtifactHash"]) {
    for (const invalidDigest of [
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `sha256:${"0".repeat(63)}`
    ]) {
      assert.equal(validate({
        ...douyinCommentEvent,
        [field]: invalidDigest
      }), false, `${field}: ${invalidDigest}`);
    }
  }
});

test("visual observations accept only strict visible Douyin comment facts", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("douyin-visual-comment-observation");
  assert.equal(typeof validate, "function", "visual observation schema is missing");

  for (const extractionMethod of ["dom", "accessibility", "ocr", "vision"]) {
    assert.equal(
      validate({ ...visualObservation, extractionMethod }),
      true,
      `${extractionMethod}: ${JSON.stringify(validate.errors)}`
    );
  }
  for (const invalid of [
    { ...visualObservation, extractionMethod: "network" },
    { ...visualObservation, sourceUrl: "http://www.douyin.com/video/7536012345678909876" },
    { ...visualObservation, sourceUrl: "https://douyin.com.evil.example/video/7536012345678909876" },
    { ...visualObservation, sourceUrl: "https://www.douyin.com/video/7536012345678909876?from=share" },
    { ...visualObservation, sourceUrl: "https://www.douyin.com/video/7536012345678909876#comments" },
    { ...visualObservation, sourceUrl: "https://www.douyin.com/video/0" },
    { ...visualObservation, videoId: "0" },
    { ...visualObservation, videoId: "07536012345678909876" },
    { ...visualObservation, videoId: "video-7536012345678909876" },
    { ...visualObservation, platformCommentId: "comment-1" },
    { ...visualObservation, publicProfileUrl: "https://example.test/user/public" },
    { ...visualObservation, publicProfileUrl: "https://www.douyin.com/user/public?token=secret" },
    { ...visualObservation, secUid: "contains whitespace" },
    { ...visualObservation, visibleText: "x".repeat(2_001) },
    { ...visualObservation, domTextHash: "sha256:ABC" },
    { ...visualObservation, ocrTextHash: `sha256:${"0".repeat(63)}` },
    { ...visualObservation, fieldConfidences: { visibleText: 1.01 } },
    { ...visualObservation, fieldConfidences: { visibleText: -0.01 } },
    { ...visualObservation, fieldConfidences: { visibleText: 1, inferredIntent: 1 } },
    { ...visualObservation, fieldConfidences: { displayName: 1 } },
    { ...visualObservation, avatarUrl: "https://example.test/avatar.webp" },
    { ...visualObservation, Cookie: "session=secret" },
    { ...visualObservation, html: "<main>whole page</main>" }
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
  const withoutDomHash = { ...visualObservation };
  delete withoutDomHash.domTextHash;
  assert.equal(validate(withoutDomHash), false, "domTextHash is required nullable provenance");
  const withoutOcrHash = { ...visualObservation };
  delete withoutOcrHash.ocrTextHash;
  assert.equal(validate(withoutOcrHash), false, "ocrTextHash is required nullable provenance");
});

test("visual observation schema records dynamic identity checks for the service boundary", async () => {
  const registry = await loadSchemaRegistry();
  const schema = registry.schemaDocuments.get("douyin-visual-comment-observation");
  const validate = registry.validators.get("douyin-visual-comment-observation");
  assert.ok(schema);
  assert.equal(typeof validate, "function");

  assert.equal(validate({
    ...visualObservation,
    videoId: "9999999999999999999"
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...visualObservation,
    publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA_other-public-actor"
  }), true, JSON.stringify(validate.errors));
  assert.match(schema.description, /Task 3 service.*sourceUrl.*videoId/u);
  assert.match(
    schema.$defs.douyinVisualCommentObservation.properties.publicProfileUrl.description,
    /Task 3 service.*secUid/u
  );
});

test("visual profile keys start alphanumeric and reject dot segments or punctuation-only identities", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("douyin-visual-comment-observation");
  assert.equal(typeof validate, "function");

  for (const invalidKey of [".", "..", "-", "~", "___"]) {
    assert.equal(validate({
      ...visualObservation,
      publicProfileUrl: `https://www.douyin.com/user/${invalidKey}`
    }), false, `publicProfileUrl key ${invalidKey}`);
    assert.equal(validate({
      ...visualObservation,
      secUid: invalidKey
    }), false, `secUid ${invalidKey}`);
  }

  const validKey = "A._~-9";
  assert.equal(validate({
    ...visualObservation,
    publicProfileUrl: `https://www.douyin.com/user/${validKey}`,
    secUid: validKey
  }), true, JSON.stringify(validate.errors));

});

test("visual submissions reject server fields, exfiltration, invalid crops, and batch overflow", async () => {
  const registry = await loadSchemaRegistry();
  const validateSubmission = compileVisualReaderDefinition(
    registry,
    "visualReaderObservationSubmission"
  );
  const validateBatch = compileVisualReaderDefinition(
    registry,
    "visualReaderObservationBatchRequest"
  );
  const proof = {
    version: "opaque-rect-v1",
    maskColorRgba: [17, 61, 51, 255],
    avatarBounds: { x: 8, y: 8, width: 48, height: 48 },
    visibleRegions: [{ x: 72, y: 8, width: 400, height: 120 }],
    maskedRegions: [{ x: 0, y: 0, width: 64, height: 180 }]
  };
  const crop = {
    mediaType: "image/webp",
    contentBase64: Buffer.alloc(64).toString("base64"),
    redactionProof: proof
  };

  assert.equal(validateSubmission(visualSubmission), true, JSON.stringify(validateSubmission.errors));
  const submissionWithoutDomHash = { ...visualSubmission };
  delete submissionWithoutDomHash.domTextHash;
  assert.equal(validateSubmission(submissionWithoutDomHash), false);
  const submissionWithoutOcrHash = { ...visualSubmission };
  delete submissionWithoutOcrHash.ocrTextHash;
  assert.equal(validateSubmission(submissionWithoutOcrHash), false);
  assert.equal(validateSubmission({
    ...visualSubmission,
    extractionMethod: "accessibility"
  }), true, JSON.stringify(validateSubmission.errors));
  assert.equal(validateSubmission({
    ...visualSubmission,
    extractionMethod: "ocr",
    redactedCrop: crop
  }), true, JSON.stringify(validateSubmission.errors));
  assert.equal(validateSubmission({
    ...visualSubmission,
    extractionMethod: "vision"
  }), true, JSON.stringify(validateSubmission.errors));

  for (const serverField of [
    "observationId",
    "textHash",
    "viewportHash",
    "redactedCropHash"
  ]) {
    assert.equal(validateSubmission({
      ...visualSubmission,
      [serverField]: validSha256
    }), false, serverField);
  }
  for (const exfiltrationField of [
    "Cookie",
    "header",
    "networkResponse",
    "html",
    "browserConfig",
    "fingerprint",
    "avatarUrl",
    "fullPageScreenshot"
  ]) {
    assert.equal(validateSubmission({
      ...visualSubmission,
      [exfiltrationField]: "forbidden"
    }), false, exfiltrationField);
  }
  for (const invalidCrop of [
    { ...crop, mediaType: "image/png" },
    { ...crop, contentBase64: "not base64" },
    { ...crop, contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64") },
    { ...crop, redactionProof: { ...proof, version: "transparent-v1" } },
    { ...crop, redactionProof: { ...proof, maskColorRgba: [17, 61, 51, 254] } },
    { ...crop, redactionProof: { ...proof, maskedRegions: [] } },
    { ...crop, redactionProof: { ...proof, avatarUrl: "https://example.test/avatar.webp" } },
    { ...crop, redactionProof: { ...proof, visibleRegions: [{ x: -1, y: 0, width: 1, height: 1 }] } }
  ]) {
    assert.equal(validateSubmission({
      ...visualSubmission,
      redactedCrop: invalidCrop
    }), false, JSON.stringify(validateSubmission.errors));
  }
  assert.equal(validateSubmission({
    ...visualSubmission,
    redactedCrop: {
      ...crop,
      contentBase64: Buffer.alloc(256 * 1024).toString("base64")
    }
  }), true, JSON.stringify(validateSubmission.errors));

  assert.equal(validateBatch({ observations: [visualSubmission] }), true);
  assert.equal(validateBatch({ observations: [] }), false);
  assert.equal(validateBatch({
    observations: Array.from({ length: 21 }, (_, index) => ({
      ...visualSubmission,
      clientObservationKey: `client-${index}`
    }))
  }), false);
  assert.equal(validateBatch({
    observations: Array.from({ length: 6 }, (_, index) => ({
      ...visualSubmission,
      clientObservationKey: `client-crop-${index}`,
      redactedCrop: crop
    }))
  }), false);
  assert.equal(validateBatch({
    observations: Array.from({ length: 5 }, (_, index) => ({
      ...visualSubmission,
      clientObservationKey: `client-crop-${index}`,
      redactedCrop: crop
    }))
  }), true, JSON.stringify(validateBatch.errors));
});

test("visual crop base64 is canonical at both padding modes and the 256 KiB boundary", async () => {
  const registry = await loadSchemaRegistry();
  const validateSubmission = compileVisualReaderDefinition(
    registry,
    "visualReaderObservationSubmission"
  );
  const proof = {
    version: "opaque-rect-v1",
    maskColorRgba: [17, 61, 51, 255],
    avatarBounds: null,
    visibleRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
    maskedRegions: [{ x: 1, y: 0, width: 1, height: 1 }]
  };
  const withBase64 = (contentBase64) => ({
    ...visualSubmission,
    redactedCrop: {
      mediaType: "image/webp",
      contentBase64,
      redactionProof: proof
    }
  });

  const canonicalDoublePad = Buffer.alloc(256 * 1024).toString("base64");
  const noncanonicalDoublePad = `${canonicalDoublePad.slice(0, -3)}B==`;
  assert.deepEqual(
    Buffer.from(noncanonicalDoublePad, "base64"),
    Buffer.from(canonicalDoublePad, "base64"),
    "the fixture must change only unused double-padding bits"
  );
  assert.equal(validateSubmission(withBase64(canonicalDoublePad)), true);
  assert.equal(validateSubmission(withBase64(noncanonicalDoublePad)), false);

  const canonicalSinglePad = Buffer.from([0, 0]).toString("base64");
  const noncanonicalSinglePad = `${canonicalSinglePad.slice(0, -2)}B=`;
  assert.deepEqual(
    Buffer.from(noncanonicalSinglePad, "base64"),
    Buffer.from(canonicalSinglePad, "base64"),
    "the fixture must change only unused single-padding bits"
  );
  assert.equal(validateSubmission(withBase64(canonicalSinglePad)), true);
  assert.equal(validateSubmission(withBase64(noncanonicalSinglePad)), false);

  assert.equal(
    validateSubmission(withBase64(Buffer.alloc(256 * 1024 + 1).toString("base64"))),
    false
  );
});

test("visual reader session and command DTOs are closed and server bounded", async () => {
  const registry = await loadSchemaRegistry();
  const validateSession = registry.validators.get("acquisition-visual-reader-session");
  assert.equal(typeof validateSession, "function", "visual reader session schema is missing");
  assert.equal(validateSession(visualSession), true, JSON.stringify(validateSession.errors));

  for (const [limit, maximum] of Object.entries({
    maxVideos: 10,
    maxCommentsPerVideo: 30,
    maxScrolls: 5,
    maxOcrCalls: 10,
    maxDurationMs: 120000
  })) {
    assert.equal(validateSession({
      ...visualSession,
      limits: { ...visualSession.limits, [limit]: maximum + 1 }
    }), false, limit);
  }
  assert.equal(validateSession({ ...visualSession, ownerId: "owner-1" }), false);
  assert.equal(validateSession({
    ...visualSession,
    status: "completed",
    outcome: null,
    completedAt: "2026-08-15T03:01:00.000Z"
  }), false, "terminal sessions require a persisted outcome");

  const completedOutcome = {
    status: "completed",
    videoCount: 1,
    observationCount: 1,
    domObservationCount: 1,
    accessibilityObservationCount: 0,
    ocrObservationCount: 0,
    lowConfidenceObservationCount: 0,
    artifactCount: 0,
    errorCodes: []
  };
  const completed = {
    ...visualSession,
    status: "completed",
    outcome: completedOutcome,
    completedAt: "2026-08-15T03:01:00.000Z"
  };
  assert.equal(validateSession(completed), true, JSON.stringify(validateSession.errors));
  assert.equal(validateSession({
    ...completed,
    outcome: { ...completedOutcome, status: "aborted" }
  }), false, "session and outcome terminal states must agree");
  assert.equal(validateSession({
    ...completed,
    outcome: {
      ...completedOutcome,
      errorCodes: ["visual_reader_user_takeover", "visual_reader_user_takeover"]
    }
  }), false, "stable errors are unique");
  assert.equal(validateSession({
    ...completed,
    outcome: { ...completedOutcome, errorCodes: ["cookie_export_failed"] }
  }), false, "outcomes expose only stable visual reader errors");

  const validateCreate = compileVisualReaderDefinition(registry, "visualReaderCreateRequest");
  assert.equal(validateCreate({ runId: "run-1", artifactUploadEnabled: true }), true);
  for (const forbidden of ["planId", "planVersionId", "platform", "authorizedAt", "limits", "Cookie"]) {
    assert.equal(validateCreate({
      runId: "run-1",
      artifactUploadEnabled: true,
      [forbidden]: "forged"
    }), false, forbidden);
  }

  const validateComplete = compileVisualReaderDefinition(registry, "visualReaderCompleteRequest");
  assert.equal(validateComplete({ status: "completed", errorCodes: [] }), true);
  assert.equal(validateComplete({
    status: "partial_success",
    errorCodes: ["visual_extraction_low_confidence"]
  }), true);
  assert.equal(validateComplete({ status: "aborted", errorCodes: [] }), false);
  assert.equal(validateComplete({
    status: "completed",
    errorCodes: [],
    message: "client-authored outcome"
  }), false);

  const validateAbort = compileVisualReaderDefinition(registry, "visualReaderAbortRequest");
  assert.equal(validateAbort({ reasonCode: "user_requested" }), true);
  assert.equal(validateAbort({ reasonCode: "visual_reader_user_takeover" }), true);
  assert.equal(validateAbort({ reasonCode: "access_restricted" }), false);
  assert.equal(validateAbort({
    reasonCode: "user_requested",
    message: "extra client text"
  }), false);
});

test("visual public identifiers use the existing ASCII extensible identifier boundary", async () => {
  const registry = await loadSchemaRegistry();
  const validateObservation = registry.validators.get(
    "douyin-visual-comment-observation"
  );
  const validateSession = registry.validators.get(
    "acquisition-visual-reader-session"
  );
  const validateSubmission = compileVisualReaderDefinition(
    registry,
    "visualReaderObservationSubmission"
  );
  const validateCreate = compileVisualReaderDefinition(registry, "visualReaderCreateRequest");
  const validIdentifier = "A.z_9:-";

  assert.equal(validateObservation({
    ...visualObservation,
    observationId: validIdentifier
  }), true, JSON.stringify(validateObservation.errors));
  assert.equal(validateSession({
    ...visualSession,
    runId: validIdentifier
  }), true, JSON.stringify(validateSession.errors));
  assert.equal(validateSubmission({
    ...visualSubmission,
    clientObservationKey: validIdentifier
  }), true, JSON.stringify(validateSubmission.errors));
  assert.equal(validateCreate({
    runId: validIdentifier,
    artifactUploadEnabled: false
  }), true, JSON.stringify(validateCreate.errors));

  for (const invalidIdentifier of ["visual\u0000session", "visual-session\n", "visual/session"]) {
    assert.equal(validateObservation({
      ...visualObservation,
      observationId: invalidIdentifier
    }), false, `observationId ${JSON.stringify(invalidIdentifier)}`);
    assert.equal(validateSession({
      ...visualSession,
      runId: invalidIdentifier
    }), false, `runId ${JSON.stringify(invalidIdentifier)}`);
    assert.equal(validateSubmission({
      ...visualSubmission,
      clientObservationKey: invalidIdentifier
    }), false, `clientObservationKey ${JSON.stringify(invalidIdentifier)}`);
    assert.equal(validateCreate({
      runId: invalidIdentifier,
      artifactUploadEnabled: false
    }), false, `create runId ${JSON.stringify(invalidIdentifier)}`);
  }
});

test("visual batch responses expose accepted normalized facts without claiming sibling equality", async () => {
  const registry = await loadSchemaRegistry();
  const validateResponse = compileVisualReaderDefinition(
    registry,
    "visualReaderObservationBatchResponse"
  );
  const response = {
    session: { ...visualSession, status: "collecting" },
    accepted: [{
      clientObservationKey: visualSubmission.clientObservationKey,
      observation: visualObservation
    }],
    duplicates: []
  };
  assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
  assert.equal(validateResponse({
    ...response,
    accepted: [{
      ...response.accepted[0],
      observation: { ...visualObservation, sessionId: "visual-session-2" }
    }]
  }), true, JSON.stringify(validateResponse.errors));
  assert.equal(validateResponse({
    ...response,
    duplicates: ["client-duplicate", "client-duplicate"]
  }), false);
  assert.equal(validateResponse({ ...response, artifactBytes: "forbidden" }), false);

  const sessionSchema = registry.schemaDocuments.get(
    "acquisition-visual-reader-session"
  );
  assert.match(
    sessionSchema.$defs.visualReaderObservationBatchResponse.description,
    /Task 3 service.*sessionId/u
  );
});

test("run presentation keeps seven public-comment steps and adds an optional five-step visual summary", async () => {
  const registry = await loadSchemaRegistry();
  const schema = registry.schemaDocuments.get("acquisition-run-presentation");
  assert.equal(schema.required.includes("authorizedVisualReader"), false);
  assert.equal(schema.properties.automationSteps.minItems, 7);
  assert.equal(schema.properties.automationSteps.maxItems, 7);

  const summary = schema.properties.authorizedVisualReader;
  assert.ok(summary, "authorized visual reader summary is missing");
  assert.equal(summary.additionalProperties, false);
  assert.deepEqual(summary.required, [
    "sessionId",
    "coverage",
    "status",
    "limits",
    "usage",
    "outcome",
    "lastErrorCode",
    "sessionCount",
    "aggregateStatus",
    "aggregateUsage",
    "visualSteps"
  ]);
  assert.equal(summary.properties.sessionCount.maximum, 1000);
  assert.equal(
    summary.properties.aggregateUsage.properties.observationCount.maximum,
    300000
  );
  assert.equal(summary.properties.visualSteps.minItems, 5);
  assert.equal(summary.properties.visualSteps.maxItems, 5);
  assert.deepEqual(
    summary.properties.visualSteps.items.properties.id.enum,
    [
      "authorize_visual_reader",
      "read_visible_comment_cards",
      "extract_visible_text",
      "persist_visual_observations",
      "review_visual_signal_confidence"
    ]
  );
});

test("discovery evidence accepts only exact public platform-event provenance", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("discovery-evidence");
  const evidence = {
    id: "evidence-comment-1",
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "抖音公开评论",
    sourceSnippet: "我们正在采购 20 套，请报价。",
    publishedAt: "2026-08-15T01:00:00.000Z",
    fetchedAt: "2026-08-15T01:01:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: validSha256,
    contentHash: validSha256,
    provenance: {
      kind: "platform_public_event",
      sourceUrl: "https://www.douyin.com/video/7536012345678909876",
      platformEventId: "comment-1",
      providerVersion: "douyin-public-comment-provider-v1",
      coverage: "public_top_level_sample"
    },
    accessStatus: "public_content"
  };

  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...evidence, targetType: "organization" }), false);
  assert.equal(validate({ ...evidence, accessStatus: "indexed_summary" }), false);
  assert.equal(validate({
    ...evidence,
    provenance: { ...evidence.provenance, coverage: "all_comments" }
  }), false);
  assert.equal(validate({
    ...evidence,
    provenance: { ...evidence.provenance, providerVersion: undefined }
  }), false);
  assert.equal(validate({
    ...evidence,
    provenance: { ...evidence.provenance, unexpected: true }
  }), false);
});

test("discovery evidence closes authorized visual provenance and literal IDs", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("discovery-evidence");
  const observationId = `visual-observation:${"a".repeat(64)}`;
  const evidence = {
    id: `visual:${observationId}:evidence:${validSha256}`,
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "Authorized visible comment observation",
    sourceSnippet: "正在采购 20 套，请报价",
    publishedAt: "2026-08-15T01:00:00.000Z",
    fetchedAt: "2026-08-15T01:01:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: validSha256,
    contentHash: validSha256,
    provenance: {
      kind: "authorized_visual_observation",
      sourceUrl: "https://www.douyin.com/video/7536012345678909876",
      observationId,
      sessionId: "visual-session-1",
      extractionMethod: "dom",
      visibleTextConfidence: 0.99,
      coverage: "authorized_visible_top_level_sample",
      artifactId: null,
      domTextHash: validSha256,
      ocrTextHash: null
    },
    accessStatus: "access_restricted"
  };
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  for (const invalid of [
    { ...evidence, id: "caller-selected-evidence" },
    { ...evidence, sourcePlatform: "xhs" },
    { ...evidence, targetType: "organization" },
    { ...evidence, accessStatus: "public_content" },
    { ...evidence, provenance: { ...evidence.provenance, extractionMethod: "vision" } },
    { ...evidence, provenance: { ...evidence.provenance, unexpected: true } }
  ]) {
    assert.equal(validate(invalid), false);
  }
});

test("individual demand signals bound profile fields without narrowing v1 negative signals", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("individual-demand-signal");
  const signal = {
    id: "signal-1",
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor-1",
    publicDisplayName: "公开用户",
    publicProfileUrl: "https://www.douyin.com/video/7536012345678909876",
    sourcePlatform: "douyin",
    evidenceIds: ["evidence-1"],
    demandCategory: "抖音公开评论需求信号",
    demandSummary: "公开评论信号，非已核实客户事实。",
    locationHint: "上海",
    buyingStage: "purchase_ready",
    negativeSignals: [],
    subjectKind: "individual",
    status: "needs_research",
    version: 1,
    identityResolved: false,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    updatedAt: "2026-08-15T01:00:00.000Z",
    firstSeenAt: "2026-08-15T01:00:00.000Z",
    lastSeenAt: "2026-08-15T01:00:00.000Z"
  };

  assert.equal(validate(signal), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...signal, publicActorKey: "a".repeat(301) }), false);
  assert.equal(validate({ ...signal, demandSummary: "a".repeat(2_001) }), false);
  const visualActorKey =
    `unmergeable:douyin:visual:visual-observation:${"b".repeat(64)}`;
  assert.equal(validate({
    ...signal,
    publicActorKey: visualActorKey,
    status: "needs_research",
    identityResolved: false
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...signal,
    publicActorKey: "unmergeable:douyin:visual:caller-selected",
    status: "needs_research",
    identityResolved: false
  }), false);
  assert.equal(validate({
    ...signal,
    publicActorKey: visualActorKey,
    status: "normalized",
    identityResolved: true
  }), false);
  const legacyNegativeSignals = [
    ...Array.from({ length: 13 }, (_, index) => `reason-${index}`),
    "reason-1",
    "x".repeat(150)
  ];
  assert.equal(validate({
    ...signal,
    negativeSignals: legacyNegativeSignals
  }), true, JSON.stringify(validate.errors));
});

test("acquisition plans version an optional Douyin public comment policy", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("acquisition-plan");
  const policy = {
    enabled: true,
    maxVideosPerRun: 20,
    maxCommentsPerVideo: 100,
    maxPagesPerVideo: 5
  };

  const legacyPayload = acquisitionPlanPayload();
  assert.equal(validate(acquisitionPlan(legacyPayload)), true, JSON.stringify(validate.errors));
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    douyinPublicCommentSample: policy
  }))), true, JSON.stringify(validate.errors));
  const providerBinding = acquisitionPlanPayload().providerConnections[0];
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    providerConnections: [
      { ...providerBinding, providerId: "another-provider" },
      providerBinding
    ],
    douyinPublicCommentSample: policy
  }))), true, JSON.stringify(validate.errors));
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    providerConnections: [],
    douyinPublicCommentSample: policy
  }))), false, "enabled sampling must reject an empty provider set");
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    providerConnections: [
      { ...providerBinding, providerId: "another-provider" },
      { ...providerBinding, kind: "search" },
      { ...providerBinding, status: "inactive" }
    ],
    douyinPublicCommentSample: policy
  }))), false, "enabled sampling must reject a provider set with no exact match");
  for (const invalidBinding of [
    { ...providerBinding, providerId: "another-provider" },
    { ...providerBinding, kind: "search" },
    { ...providerBinding, status: "inactive" }
  ]) {
    assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
      providerConnections: [invalidBinding],
      douyinPublicCommentSample: policy
    }))), false, JSON.stringify(invalidBinding));
  }
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    targetPlatform: "web",
    douyinPublicCommentSample: policy
  }))), false);
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    targetPlatform: "web",
    douyinPublicCommentSample: { ...policy, enabled: false }
  }))), true, JSON.stringify(validate.errors));
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    douyinPublicCommentSample: { ...policy, maxCommentsPerVideo: 101 }
  }))), false);
  assert.equal(validate(acquisitionPlan(acquisitionPlanPayload({
    douyinPublicCommentSample: { ...policy, unexpected: true }
  }))), false);
});

test("platform and action contracts accept canonical objects and reject unknown fields", async () => {
  const registry = await loadSchemaRegistry();
  for (const [name, value] of Object.entries(platformContracts)) {
    const validate = registry.validators.get(name);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...value, unexpected: true }), false, name);
  }
});

test("capability and action keys remain extensible but reject empty keys", async () => {
  const registry = await loadSchemaRegistry();
  const capability = registry.validators.get("platform-capability-snapshot");
  const policy = registry.validators.get("action-policy");

  assert.equal(capability(platformContracts["platform-capability-snapshot"]), true);
  assert.equal(capability({
    ...platformContracts["platform-capability-snapshot"],
    capabilities: {
      "": platformContracts["platform-capability-snapshot"].capabilities.future_official_capability
    }
  }), false);
  assert.equal(policy(platformContracts["action-policy"]), true);
  assert.equal(policy({
    ...platformContracts["action-policy"],
    actions: { "": "blocked" }
  }), false);
});

test("capability and action keys reject whitespace, controls, and unsupported punctuation", async () => {
  const registry = await loadSchemaRegistry();
  const capability = registry.validators.get("platform-capability-snapshot");
  const policy = registry.validators.get("action-policy");
  const capabilityEntry = platformContracts["platform-capability-snapshot"]
    .capabilities.future_official_capability;

  for (const invalidKey of [
    " ",
    "\t",
    "\u0001",
    "future official capability",
    "future/capability",
    "!future"
  ]) {
    assert.equal(capability({
      ...platformContracts["platform-capability-snapshot"],
      capabilities: { [invalidKey]: capabilityEntry }
    }), false, `capability key ${JSON.stringify(invalidKey)}`);
    assert.equal(policy({
      ...platformContracts["action-policy"],
      actions: { [invalidKey]: "blocked" }
    }), false, `action key ${JSON.stringify(invalidKey)}`);
  }
});

test("all immutable digest fields require canonical lowercase SHA-256 values", async () => {
  const registry = await loadSchemaRegistry();
  const digestPaths = {
    "platform-connection": [
      ["capabilitySnapshotRef", "hash"]
    ],
    "platform-capability-snapshot": [
      ["snapshotHash"]
    ],
    "platform-event": [
      ["rawPayloadHash"],
      ["normalizedEventHash"],
      ["authorizationSnapshot", "scopeHash"],
      ["authorizationSnapshot", "capabilitySnapshotRef", "hash"]
    ],
    "action-policy": [
      ["planRef", "hash"],
      ["ruleBundleRef", "hash"],
      ["policyHash"]
    ],
    "action-receipt": [
      ["intentRef", "hash"],
      ["decisionRef", "hash"],
      ["capabilitySnapshotRef", "hash"],
      ["requestHash"],
      ["resultHash"]
    ]
  };

  for (const [name, paths] of Object.entries(digestPaths)) {
    const validate = registry.validators.get(name);
    for (const pathParts of paths) {
      for (const invalidDigest of [
        " ",
        "sha256:abc",
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "md5:0123456789abcdef0123456789abcdef"
      ]) {
        const value = structuredClone(platformContracts[name]);
        const target = pathParts.slice(0, -1)
          .reduce((object, part) => object[part], value);
        target[pathParts.at(-1)] = invalidDigest;
        assert.equal(
          validate(value),
          false,
          `${name}.${pathParts.join(".")}: ${JSON.stringify(invalidDigest)}`
        );
      }
    }
  }
});

test("action receipt idempotency keys are bounded and contain non-whitespace", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("action-receipt");

  for (const idempotencyKey of ["short", "        ", "x".repeat(201)]) {
    assert.equal(validate({
      ...platformContracts["action-receipt"],
      idempotencyKey
    }), false, JSON.stringify(idempotencyKey));
  }
});

test("pending connections may precede capability capture but active connections may not", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("platform-connection");

  assert.equal(validate({
    ...platformContracts["platform-connection"],
    status: "pending",
    capabilitySnapshotRef: null
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...platformContracts["platform-connection"],
    status: "active",
    capabilitySnapshotRef: null
  }), false);
});

test("action policy decisions are exactly the three fail-closed outcomes", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("action-policy");
  for (const decision of ["auto_allowed", "review_required", "blocked"]) {
    assert.equal(validate({
      ...platformContracts["action-policy"],
      actions: { future_official_capability: decision }
    }), true, decision);
  }
  assert.equal(validate({
    ...platformContracts["action-policy"],
    actions: { future_official_capability: "allowed" }
  }), false);
});

test("action receipts require immutable request/result hashes and normalized outcomes", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("action-receipt");
  const { requestHash, ...withoutRequestHash } = platformContracts["action-receipt"];
  const { resultHash, ...withoutResultHash } = platformContracts["action-receipt"];

  assert.equal(validate(platformContracts["action-receipt"]), true);
  assert.equal(validate({
    ...platformContracts["action-receipt"],
    externalId: null,
    outcome: "failed",
    error: {
      category: "rate_limited",
      code: "PLATFORM_RATE_LIMITED",
      message: "The official platform rate limit was reached.",
      retryable: true
    }
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate(withoutRequestHash), false);
  assert.equal(validate(withoutResultHash), false);
  assert.equal(validate({
    ...platformContracts["action-receipt"],
    outcome: "ok"
  }), false);
  assert.equal(validate({
    ...platformContracts["action-receipt"],
    outcome: "failed",
    error: "RATE_LIMITED"
  }), false);
});

test("battle-card.v2 enforces evidence-bound structured intelligence", async () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const schema = JSON.parse(await readFile(
    path.join(root, "json-schema", "battle-card.v2.schema.json"),
    "utf8"
  ));
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const claim = {
    kind: "fact",
    text: "客户官网公开发布了采购需求。",
    evidenceIds: ["evidence-1"],
    confidence: 1
  };
  const valid = {
    id: "battle-card-2",
    candidateId: "candidate-1",
    qualificationDecisionId: "decision-1",
    partyType: "organization",
    schemaVersion: "battle-card.v2",
    intelligence: {
      accountOverview: [claim],
      needAssessment: [claim],
      supplierHypotheses: [{
        kind: "unknown",
        text: "没有足够证据确认现有供应商。",
        evidenceIds: [],
        confidence: null
      }],
      buyingCommittee: [{
        role: "业务负责人",
        priority: 1,
        influence: "decision_maker",
        concerns: ["投入产出"],
        claim
      }],
      procurementPreferences: [{
        kind: "inference",
        text: "采购更关注可量化效果。",
        evidenceIds: ["evidence-1"],
        confidence: 0.72
      }],
      connectionStrategies: [{
        channel: "email",
        targetRole: "业务负责人",
        rationale: claim,
        openingDraft: "建议人工审核后，以公开需求为背景提供诊断。"
      }],
      roleSpecificOpeners: [{
        role: "业务负责人",
        channel: "email",
        text: "看到贵司公开的采购需求，我们整理了一页诊断供参考。"
      }],
      doNotActions: ["不要在没有证据时声称了解现有供应商"],
      financialSummary: {
        decisionId: "financial-1",
        decisionVersion: "financial-v1",
        grade: "A",
        score: 82,
        currency: "CNY",
        expectedRevenueMinor: 1_000_000,
        expectedGrossProfitMinor: 600_000,
        expectedContributionMinor: 500_000,
        factors: {
          profitability: 80,
          cashFlow: 70,
          creditQuality: 75,
          repeatPotential: 60,
          referralPotential: 40,
          closeProbability: 65
        }
      }
    },
    evidenceIds: ["evidence-1"],
    confidence: 0.8,
    modelProvider: "openai",
    model: "gpt-5",
    promptVersion: "acquisition-model-prompt-bundle.v5",
    createdAt: "2026-07-26T00:00:00.000Z"
  };

  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const invalidClaim of [{
    ...claim,
    evidenceIds: []
  }, {
    kind: "inference",
    text: "没有置信度的推断",
    evidenceIds: ["evidence-1"],
    confidence: null
  }, {
    kind: "unknown",
    text: "未知项不得引用证据",
    evidenceIds: ["evidence-1"],
    confidence: null
  }]) {
    assert.equal(validate({
      ...valid,
      intelligence: {
        ...valid.intelligence,
        accountOverview: [invalidClaim]
      }
    }), false);
  }
});

test("financial values expose only the current closed public projection", async () => {
  const registry = await loadSchemaRegistry();
  const schema = registry.schemaDocuments.get("financial-value-decision");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "id",
    "candidateId",
    "qualificationDecisionId",
    "version",
    "grade",
    "score",
    "currency",
    "expectedRevenueMinor",
    "expectedGrossProfitMinor",
    "expectedContributionMinor",
    "factors",
    "createdAt"
  ]);
  assert.deepEqual(Object.keys(schema.properties), schema.required);
  for (const name of [
    "expectedRevenueMinor",
    "expectedGrossProfitMinor",
    "expectedContributionMinor"
  ]) {
    assert.equal(schema.properties[name].type, "integer");
  }
  assert.deepEqual(schema.properties.factors.required, [
    "profitability",
    "cashFlow",
    "creditQuality",
    "repeatPotential",
    "referralPotential",
    "closeProbability"
  ]);
  assert.equal(schema.properties.factors.additionalProperties, false);
});

test("copilot messages preserve identity, session, content, and linkage", async () => {
  const registry = await loadSchemaRegistry();
  const schema = registry.schemaDocuments.get("copilot-message");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "id",
    "sessionId",
    "sequence",
    "message",
    "createdAt"
  ]);
  const variants = schema.properties.message.oneOf;
  assert.deepEqual(
    variants.map((variant) => variant.properties.role.const),
    ["user", "assistant", "toolResult"]
  );
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false);
    assert.ok(variant.required.includes("role"));
    assert.ok(variant.required.includes("content"));
    assert.ok(variant.required.includes("timestamp"));
  }
  const toolResult = variants.find(
    (variant) => variant.properties.role.const === "toolResult"
  );
  assert.ok(toolResult.required.includes("toolCallId"));
  assert.equal(schema.properties.taskId, undefined);
});

test("acquisition plan and copilot task schemas expose the optional target platform", async () => {
  const registry = await loadSchemaRegistry();
  const plan = registry.schemaDocuments.get("acquisition-plan");
  const task = registry.schemaDocuments.get("copilot-task");

  assert.deepEqual(plan.$defs.payload.properties.targetPlatform, {
    enum: ["douyin", "web"]
  });
  assert.equal(plan.$defs.payload.required.includes("targetPlatform"), false);
  assert.deepEqual(task.properties.targetPlatform, {
    enum: ["douyin", "web"]
  });
  assert.equal(task.required.includes("targetPlatform"), false);
});

test("live outcome attribution publishes the complete persisted acquisition run chain", async () => {
  const registry = await loadSchemaRegistry();
  const attribution = registry.schemaDocuments.get("outcome-feedback")
    .$defs.liveAttribution;
  for (const field of [
    "attributionVersion",
    "planId",
    "planVersionId",
    "planVersion",
    "planSnapshotHash",
    "discoveredEventId",
    "discoveredAt",
    "shardId",
    "operationId",
    "connectionId",
    "providerId"
  ]) {
    assert.ok(attribution.required.includes(field), `${field} is required`);
    assert.ok(attribution.properties[field], `${field} is published`);
  }
});
