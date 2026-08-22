import { strict as assert } from "node:assert";
import { renderAdvisorHome } from "./view";
import type { AdvisorHomeState } from "./controller";
import type { AdvisorRecommendation } from "./api";

const quotePreviewInputSnapshotHash = `sha256:${"a".repeat(64)}` as const;
const quotePreviewCalculationHash = `sha256:${"b".repeat(64)}` as const;
const quoteCommercialAmountHash = `sha256:${"c".repeat(64)}` as const;

const recommendation: AdvisorRecommendation = {
  id: "recommendation-1",
  workspaceId: "workspace-1",
  revision: 1,
  audienceRole: "manager",
  type: "quote_risk",
  summary: "优先处理已提交且即将过期的报价",
  rationale: "报价版本 quote-v3 距失效还有 12 小时",
  metricRefs: [{
    kind: "quote_preview",
    quoteCaseId: "quote-case-3",
    previewIdentity: {
      inputSnapshotHash: quotePreviewInputSnapshotHash,
      calculationHash: quotePreviewCalculationHash,
      pricingPolicyVersionId: "pricing-policy-v7",
      pricingPolicyRevision: 7,
      packageVersionId: "package-v3",
      formulaVersion: "quote-calculation.v1"
    },
    inputSnapshotHash: quotePreviewInputSnapshotHash,
    calculationHash: quotePreviewCalculationHash
  }],
  evidenceRefs: [{
    kind: "quote_version",
    quoteVersionId: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: quoteCommercialAmountHash
  }],
  entityRefs: [{
    kind: "quote_version",
    id: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: quoteCommercialAmountHash
  }],
  confidenceBps: 8700,
  riskLevel: "high",
  recommendedAction: {
    kind: "create_quote_approval_task",
    quoteVersionId: "quote-v3",
    quoteVersionRevision: 3
  },
  status: "proposed",
  assignedTo: null,
  acceptedBy: null,
  acceptedAt: null,
  outcomeRefs: [],
  dataAsOf: "2026-08-09T08:00:00.000Z",
  inputSnapshotHash: `sha256:${"d".repeat(64)}`,
  modelSnapshotRef: "model-snapshot-1",
  promptVersion: "growth-advisor.v1",
  schemaVersion: "advisor-recommendation.v1",
  generationIdempotencyKey: "advisor-generation:workspace-1:2026-08-09",
  expiresAt: "2026-08-10T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
};

const [previewMetric] = recommendation.metricRefs;
assert.ok(previewMetric);
assert.equal(previewMetric.kind, "quote_preview");
assert.equal(previewMetric.quoteCaseId, "quote-case-3");
assert.equal(
  previewMetric.previewIdentity.inputSnapshotHash,
  quotePreviewInputSnapshotHash
);
assert.equal(
  previewMetric.previewIdentity.calculationHash,
  quotePreviewCalculationHash
);

const [quoteEvidence] = recommendation.evidenceRefs;
assert.ok(quoteEvidence);
assert.equal(quoteEvidence.kind, "quote_version");
assert.equal(quoteEvidence.quoteVersionId, "quote-v3");
assert.equal(quoteEvidence.lifecycleRevision, 3);
assert.equal(quoteEvidence.commercialAmountHash, quoteCommercialAmountHash);
assert.equal(
  "quoteVersionRevision" in recommendation.recommendedAction
    ? recommendation.recommendedAction.quoteVersionRevision : null,
  3
);

const ready: Extract<AdvisorHomeState, { kind: "ready" }> = {
  kind: "ready",
  today: {
    workspaceId: "ws-1",
    audienceRole: "manager",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    priorityCustomers: [{
      candidateId: "candidate-1",
      customerId: "customer-1",
      dealId: "deal-1",
      displayName: "示例企业",
      priorityScoreBps: 7800,
      qualificationDecisionId: "qualification-1",
      qualificationDecisionVersion: "qualification-v1",
      inputSnapshotHash: `sha256:${"e".repeat(64)}`
    }],
    pendingQuoteApprovals: [{
      approvalId: "approval-1",
      quoteVersionId: "quote-v3",
      quoteVersionRevision: 3,
      quoteCaseId: "quote-case-3",
      approvalKind: "confirmation",
      requiredCapabilities: ["quote.confirm"],
      submittedAt: "2026-08-09T07:00:00.000Z",
      expiresAt: "2026-08-10T07:00:00.000Z"
    }],
    expectedRoi: [{
      cohortId: "cohort-1",
      planId: null,
      currency: "CNY",
      status: "not_computable",
      reason: "cost_missing",
      roiBps: null,
      formulaVersion: "expected-roi.v1",
      amountVisibility: "redacted"
    }],
    actualRoi: [],
    financialDataGaps: [{
      code: "unverified_cost",
      sourceType: "cost_entry",
      sourceId: "cost-1",
      sourceSnapshotHash: `sha256:${"f".repeat(64)}`,
      cohortId: null,
      currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z"
    }],
    recommendations: [recommendation],
    sourceSnapshotHash: `sha256:${"g".repeat(64)}`
  } as never,
  explanation: "基于已关账数据，建议先处理即将过期的报价。",
  aiUnavailable: false,
  decidingId: null
};

const html = renderAdvisorHome(ready);
assert.equal(html.includes("增长参谋"), true);
assert.equal(html.includes("优先处理已提交且即将过期的报价"), true);
assert.equal(html.includes("8700 bps"), true);
assert.equal(html.includes("quote-v3"), true);
assert.equal(html.includes("创建报价审批任务"), true);
assert.equal(html.includes("data-action=\"accept\""), true);
assert.equal(html.includes("data-action=\"approve\""), false);
assert.equal(html.includes("data-action=\"verify\""), false);
assert.equal(html.includes("data-action=\"send\""), false);
assert.equal(html.includes("data-action=\"outreach\""), false);
assert.equal(html.includes("示例企业"), true);
assert.equal(html.includes("unverified_cost"), true);
assert.equal(html.includes("<script>"), false);

const aiFailure: AdvisorHomeState = {
  ...ready,
  explanation: "",
  aiUnavailable: true
};
const failureHtml = renderAdvisorHome(aiFailure);
assert.equal(failureHtml.includes("ai_explanation_unavailable"), true);
assert.equal(failureHtml.includes("示例企业"), true);
assert.equal(failureHtml.includes("quote-v3"), true);
