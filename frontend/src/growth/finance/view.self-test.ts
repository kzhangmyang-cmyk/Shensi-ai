import { strict as assert } from "node:assert";
import { renderFinancePage } from "./view";
import type { FinancePageState } from "./controller";
import type { AcquisitionCostEstimate } from "./api";

const ready: Extract<FinancePageState, { kind: "ready" }> = {
  kind: "ready",
  costEntries: [],
  costEstimates: [{
    id: "estimate-1",
    workspaceId: "ws-1",
    status: "active",
    currency: "CNY",
    amountMinor: 20_000,
    createdAt: "2026-08-09T08:00:00.000Z"
  } as unknown as AcquisitionCostEstimate],
  facts: [{
    id: "fact-1",
    workspaceId: "ws-1",
    factType: "payment_received",
    amountMinor: 100_000,
    currency: "CNY",
    status: "verified",
    revision: 3,
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    quoteVersionId: "quote-v1",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    recordedAt: "2026-08-09T08:00:00.000Z",
    createdBy: "manager-1",
    sourceIdentityRoot: "source-1",
    sourceRef: null,
    sourceVersion: 1,
    externalId: null,
    evidenceHash: `sha256:${"a".repeat(64)}`,
    correctionGroupId: null,
    correctsFactId: null,
    commercialAmountHash: null,
    commercialBindingSnapshot: null,
    attributionSnapshot: null,
    dealAuthorityRevision: null,
    provenance: "manual_verified"
  }],
  importState: { kind: "idle" },
  canVerify: true
};

const html = renderFinancePage(ready);
assert.equal(html.includes("财务账本"), true);
assert.equal(html.includes("fact-1"), true);
assert.equal(html.includes("data-action=\"correct-fact\""), false);
assert.equal(html.includes("estimate-1"), true);
assert.equal(html.includes("<script>"), false);

const pendingFacts: FinancePageState = {
  ...ready,
  facts: [{
    ...ready.facts[0]!,
    status: "pending"
  }]
};
assert.equal(
  renderFinancePage(pendingFacts).includes("data-action=\"correct-fact\""),
  true
);

assert.equal(
  renderFinancePage({ kind: "forbidden" }).includes("无权"),
  true
);
