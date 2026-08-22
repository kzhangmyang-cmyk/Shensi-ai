import test from "node:test";
import assert from "node:assert/strict";
import { loadContractHarness } from "./helpers.mjs";

test("personal evidence cannot omit provenance or masquerade as a company", async () => {
  const { validateCase } = await loadContractHarness();
  assert.equal(validateCase("discovery-evidence", {
    id: "ev_invalid", targetType: "individual_signal"
  }).valid, false);
  assert.equal(validateCase("individual-demand-signal", {
    id: "person_invalid", company: "个人用户"
  }).valid, false);
});

test("identity workbench contracts accept versioned identity state and exact evidence ids", async () => {
  const { validateCase } = await loadContractHarness();
  assert.equal(validateCase("individual-demand-signal", {
    id: "candidate-individual-1",
    publicActorKey: "unresolved-public-signal:video",
    publicDisplayName: "待核验抖音主体",
    publicProfileUrl: "https://www.douyin.com/video/1234567890",
    sourcePlatform: "douyin",
    evidenceIds: ["evidence-video-1"],
    demandCategory: "获客系统",
    demandSummary: "公开视频摘要包含需求信号",
    locationHint: "厦门",
    buyingStage: "solution_research",
    negativeSignals: [],
    subjectKind: "individual",
    status: "normalized",
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    version: 7,
    identityResolved: false,
    updatedAt: "2026-08-06T00:00:00.000Z",
    firstSeenAt: "2026-08-06T00:00:00.000Z",
    lastSeenAt: "2026-08-06T00:00:00.000Z"
  }).valid, true);
  assert.equal(validateCase("discovery-evidence", {
    id: "evidence-video-1",
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "公开视频",
    sourceSnippet: "评论摘要",
    publishedAt: null,
    fetchedAt: "2026-08-06T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "site:douyin.com 获客",
      sourceUrl: "https://www.douyin.com/video/1234567890",
      resultRank: 1,
      sourceType: "video"
    },
    accessStatus: "indexed_summary"
  }).valid, true);
  assert.equal(validateCase("content-fetch-operation", {
    id: "fetch-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-a",
    sourceUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
    finalUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
    subjectChannel: "individual",
    status: "succeeded",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html; charset=utf-8",
    title: "公开主页",
    rawArtifactHash: `sha256:${"c".repeat(64)}`,
    contentHash: `sha256:${"d".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["evidence-profile-1"],
    candidateCount: 0,
    candidateIds: [],
    commentSampleSummary: null,
    errorCode: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    startedAt: "2026-08-06T00:00:01.000Z",
    completedAt: "2026-08-06T00:00:02.000Z"
  }).valid, true);
});

test("search evidence accepts exact provider trace without breaking legacy records", async () => {
  const { validateCase } = await loadContractHarness();
  const legacyEvidence = {
    id: "evidence-search-trace-1",
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "公开视频",
    sourceSnippet: "搜索索引摘要",
    publishedAt: null,
    fetchedAt: "2026-08-07T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "site:douyin.com 获客",
      sourceUrl: "https://www.douyin.com/video/1234567890",
      resultRank: 1,
      sourceType: "video"
    },
    accessStatus: "indexed_summary"
  };

  assert.equal(
    validateCase("discovery-evidence", legacyEvidence).valid,
    true,
    "existing search evidence must remain readable"
  );
  assert.equal(validateCase("discovery-evidence", {
    ...legacyEvidence,
    provenance: {
      ...legacyEvidence.provenance,
      providerConnectionId: "connection-baidu-1",
      requestId: "provider-request-1",
      providerRecordId: "urlh:provider-record-1"
    }
  }).valid, true);
});

test("content fetch operations keep status, evidence count, and evidence ids consistent", async () => {
  const { validateCase } = await loadContractHarness();
  const operation = {
    id: "fetch-invariant-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-a",
    sourceUrl: "https://example.test/public-source",
    finalUrl: null,
    subjectChannel: "organization",
    status: "queued",
    accessStatus: null,
    httpStatus: null,
    contentType: null,
    title: null,
    rawArtifactHash: null,
    contentHash: null,
    evidenceCount: 0,
    evidenceIds: [],
    candidateCount: 0,
    candidateIds: [],
    commentSampleSummary: null,
    errorCode: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    startedAt: null,
    completedAt: null
  };

  for (const status of ["queued", "running", "failed"]) {
    assert.equal(validateCase("content-fetch-operation", {
      ...operation,
      status
    }).valid, true, `${status} with no evidence must be valid`);
  }
  assert.equal(validateCase("content-fetch-operation", {
    ...operation,
    status: "failed",
    evidenceCount: 1,
    evidenceIds: ["evidence-preserved-after-failure"]
  }).valid, true, "failed fetch must preserve evidence formed before failure");
  assert.equal(validateCase("content-fetch-operation", {
    ...operation,
    status: "failed",
    evidenceCount: 1,
    evidenceIds: ["evidence-preserved-after-failure"],
    candidateCount: 1,
    candidateIds: ["candidate-preserved-after-failure"]
  }).valid, true, "failed fetch must preserve a candidate formed before failure");
  for (const status of ["succeeded", "access_restricted"]) {
    assert.equal(validateCase("content-fetch-operation", {
      ...operation,
      status,
      evidenceCount: 1,
      evidenceIds: ["evidence-current-operation"]
    }).valid, true, `${status} with one evidence id must be valid`);
  }

  const invalid = [
    { status: "succeeded", evidenceCount: 1, evidenceIds: [] },
    {
      status: "access_restricted",
      evidenceCount: 0,
      evidenceIds: ["evidence-current-operation"]
    },
    {
      status: "failed",
      candidateCount: 1,
      candidateIds: ["candidate-without-evidence"]
    },
    {
      status: "succeeded",
      evidenceCount: 2,
      evidenceIds: ["evidence-duplicate", "evidence-duplicate"]
    },
    {
      status: "succeeded",
      evidenceCount: 1,
      evidenceIds: ["evidence-current-operation"],
      candidateCount: 1,
      candidateIds: []
    },
    {
      status: "queued",
      candidateCount: 1,
      candidateIds: ["candidate-too-early"]
    }
  ];
  for (const values of invalid) {
    assert.equal(validateCase("content-fetch-operation", {
      ...operation,
      ...values
    }).valid, false, JSON.stringify(values));
  }
  const missingCandidateAssociation = structuredClone(operation);
  delete missingCandidateAssociation.candidateCount;
  delete missingCandidateAssociation.candidateIds;
  assert.equal(
    validateCase(
      "content-fetch-operation",
      missingCandidateAssociation
    ).valid,
    false,
    "public fetch responses must always expose candidate associations"
  );
});

test("content fetch operations expose persisted public comment enrichment summaries", async () => {
  const { validateCase } = await loadContractHarness();
  const operation = {
    id: "fetch-comment-summary-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-a",
    sourceUrl: "https://www.douyin.com/video/7536012345678904333",
    finalUrl: "https://www.douyin.com/video/7536012345678904333",
    subjectChannel: "individual",
    status: "partial_success",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html",
    title: "公开视频",
    rawArtifactHash: `sha256:${"1".repeat(64)}`,
    contentHash: `sha256:${"2".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["original-evidence"],
    candidateCount: 2,
    candidateIds: ["original-candidate", "comment-candidate"],
    commentSampleSummary: {
      status: "partial_success",
      videoCount: 1,
      pagesFetched: 1,
      commentsSampled: 1,
      eventCount: 1,
      evidenceCount: 1,
      candidateIds: ["comment-candidate"],
      unresolvedActorCount: 1,
      strongSignalCount: 1,
      invalidCommentCount: 0,
      errors: [{
        sourceUrl: "https://www.douyin.com/video/7536012345678904333",
        videoId: "7536012345678904333",
        code: "rate_limited"
      }],
      usage: {
        requests: 2,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    },
    errorCode: "rate_limited",
    createdAt: "2026-08-15T00:00:00.000Z",
    startedAt: "2026-08-15T00:00:01.000Z",
    completedAt: "2026-08-15T00:00:02.000Z"
  };

  assert.equal(
    validateCase("content-fetch-operation", operation).valid,
    true
  );
  assert.equal(
    validateCase("content-fetch-operation", {
      ...operation,
      candidateCount: 3,
      candidateIds: ["original-candidate", "comment-candidate"]
    }).valid,
    false,
    "candidateCount must equal candidateIds.length exactly"
  );
});

test("import operations expose row outcomes and downstream evidence and candidate links", async () => {
  const { validateCase } = await loadContractHarness();
  const operation = {
    id: "import-contract-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "user-a",
    fileName: "douyin-links.csv",
    mediaType: "text/csv",
    subjectChannel: "individual",
    artifactHash: `sha256:${"a".repeat(64)}`,
    status: "partial_success",
    rowCount: 3,
    acceptedRowCount: 2,
    errorRows: [{
      sheetName: "CSV",
      rowNumber: 3,
      code: "UNSUPPORTED_SOURCE_URL",
      message: "不支持的公开链接"
    }],
    evidenceCount: 2,
    evidenceIds: ["evidence-import-1", "evidence-import-2"],
    candidateCount: 1,
    candidateIds: ["candidate-import-1"],
    errorCode: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    startedAt: "2026-08-07T00:00:01.000Z",
    completedAt: "2026-08-07T00:00:02.000Z"
  };

  assert.equal(
    validateCase("import-operation", operation).valid,
    true
  );

  const queued = {
    ...operation,
    status: "queued",
    rowCount: 0,
    acceptedRowCount: 0,
    errorRows: [],
    evidenceCount: 0,
    evidenceIds: [],
    candidateCount: 0,
    candidateIds: [],
    startedAt: null,
    completedAt: null
  };
  assert.equal(validateCase("import-operation", queued).valid, true);

  const legacy = {
    id: operation.id,
    ownerId: operation.ownerId,
    artifactHash: operation.artifactHash,
    status: "queued",
    createdAt: operation.createdAt
  };
  assert.equal(
    validateCase("import-operation", legacy).valid,
    false,
    "public import responses may not omit runtime outcome fields"
  );

  const invalid = [
    { ...queued, evidenceCount: 1, evidenceIds: ["evidence-too-early"] },
    { ...queued, candidateCount: 1, candidateIds: ["candidate-too-early"] },
    { ...operation, evidenceCount: 0, evidenceIds: ["evidence-mismatch"] },
    { ...operation, candidateCount: 0, candidateIds: ["candidate-mismatch"] },
    { ...operation, evidenceCount: 2, evidenceIds: undefined },
    { ...operation, candidateCount: undefined, candidateIds: ["candidate-1"] }
  ];
  for (const values of invalid) {
    const candidate = structuredClone(values);
    if (candidate.evidenceIds === undefined) delete candidate.evidenceIds;
    if (candidate.candidateCount === undefined) delete candidate.candidateCount;
    assert.equal(validateCase("import-operation", candidate).valid, false);
  }
});

test("import evidence can retain its original public source URL", async () => {
  const { validateCase } = await loadContractHarness();
  const evidence = {
    id: "evidence-import-source-1",
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "用户提交的公开抖音链接",
    sourceSnippet: "公开内容中包含需求信号",
    publishedAt: null,
    fetchedAt: "2026-08-07T00:00:02.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "import_artifact_row",
      importBatchId: "import-contract-1",
      artifactHash: `sha256:${"a".repeat(64)}`,
      sheetName: "CSV",
      rowNumber: 2,
      sourceUrl: "https://www.douyin.com/video/1234567890"
    },
    accessStatus: "user_supplied"
  };

  assert.equal(validateCase("discovery-evidence", evidence).valid, true);
  const legacy = structuredClone(evidence);
  delete legacy.provenance.sourceUrl;
  assert.equal(
    validateCase("discovery-evidence", legacy).valid,
    true,
    "existing import evidence without sourceUrl must remain readable"
  );
});

test("outcome feedback rejects untyped live parties and legacy individual parties", async () => {
  const { validateCase } = await loadContractHarness();
  const live = {
    id: "outcome_live_invalid", ownerId: "owner", teamId: "team", leadId: null, customerId: null,
    eventType: "validated", occurredAt: "2026-07-23T00:00:00.000Z", amount: null,
    reasonCode: null, reasonText: null, idempotencyKey: "key", createdBy: "user",
    createdAt: "2026-07-23T00:00:00.000Z", recordKind: "live", partyRef: { arbitrary: true },
    candidateId: "candidate", attribution: {
      runId: "run", evidenceIds: [], providerIds: [], queryIds: [], strategyVersion: "v1",
      qualificationDecisionId: "decision", decisionVersion: "v1", decisionSnapshotHash: "hash",
      decisionEngine: "rules", ruleVersion: "v1", modelProvider: null, model: null, promptVersion: null
    }
  };
  const legacy = {
    ...live, id: "outcome_legacy_invalid", recordKind: "legacy_migrated", legacySourceId: "legacy-1",
    partyRef: { partyType: "individual", individualPartyId: "party", demandSignalId: "signal" },
    candidateId: null, attribution: {
      ...live.attribution, runId: null, strategyVersion: null, qualificationDecisionId: null,
      decisionVersion: null, decisionSnapshotHash: null, decisionEngine: null, ruleVersion: null
    }, migrationWarnings: []
  };
  assert.equal(validateCase("outcome-feedback", live).valid, false);
  assert.equal(validateCase("outcome-feedback", legacy).valid, false);
});

test("rules decisions cannot claim model metadata and inference cards require support", async () => {
  const { validateCase } = await loadContractHarness();
  const decision = {
    decisionEngine: "rules", grade: "B", score: 60, recommendedAction: "nurture",
    evidence: [{ evidenceId: "ev_1" }], positiveSignals: [], negativeSignals: [], reasons: ["rule"],
    confidence: 0.7, ruleVersion: "rules-v1", promptVersion: "prompt-v1", modelProvider: "openai", model: "gpt"
  };
  const card = {
    id: "card_1", candidateId: "candidate_1", partyType: "organization",
    sections: [{ label: "Pain point", kind: "inference", content: "Likely needs a CRM." }],
    evidenceIds: ["ev_1"], confidence: 0.8, modelProvider: "openai", model: "gpt", promptVersion: "v1",
    createdAt: "2026-07-23T00:00:00.000Z"
  };
  assert.equal(validateCase("qualification-decision", decision).valid, false);
  assert.equal(validateCase("battle-card", card).valid, false);
});

test("contract examples validate as complete organization and individual flows", async () => {
  const { loadExamples, validateCase } = await loadContractHarness();
  const examples = await loadExamples();
  for (const record of examples.organization.records) {
    assert.equal(validateCase(record.schema, record.value).valid, true, record.schema);
  }
  for (const record of examples.individual.records) {
    assert.equal(validateCase(record.schema, record.value).valid, true, record.schema);
  }
  assert.equal(examples.organization.records.length > 0, true);
  assert.equal(examples.individual.records.length > 0, true);
  assert.equal(examples.search.queryText.length > 0, true);
});
