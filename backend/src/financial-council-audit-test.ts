import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalFinancialCouncilAuditGraph,
  buildFinancialCouncilAuditGraph,
  selectFinancialCouncilRebuttalTargets,
  type FinancialCouncilAuditFact
} from "./financial-council-audit.js";
import {
  authorizeSpecialistResultFixture, repositoryRunFixture,
  specialistResultFixture, snapshotFixture, command
} from "./financial-council-repository-contract-test.js";
import { InMemoryFinancialCouncilRepository } from
  "./financial-council-repository.js";

const SHA = (value: string) => `sha256:${value.repeat(64)}` as const;

function fact(overrides: Partial<FinancialCouncilAuditFact> = {}):
FinancialCouncilAuditFact {
  return {
    finding: {
      findingId: "finding-finance",
      runId: "run-1",
      snapshotId: "snapshot-1",
      agentRole: "finance",
      conclusion: "risk_hypothesis",
      evidenceRefs: [{
        source: "business_report",
        sourceId: "business-report",
        contentHash: SHA("a")
      }],
      formulaRef: null,
      confidenceBps: 8_000,
      severity: "warning",
      assumptions: [],
      missingData: [],
      candidateActionIds: []
    },
    actions: [],
    ...overrides
  };
}

const identity = {
  workspaceId: "ws-1",
  runId: "run-1",
  snapshotId: "snapshot-1",
  snapshotHash: SHA("b")
} as const;

test("canonical graph is invariant to UTF-8 input order and uses action_exclusivity", () => {
  const left = fact({
    finding: { ...fact().finding, findingId: "发现-甲" },
    actions: [{
      actionId: "action-a", kind: "complete_financial_data",
      sourceFindingIds: ["发现-甲"], ownerRole: "finance", subjectRef: null,
      explanation: "complete_financial_data_hypothesis", durationDays: 1,
      prerequisites: [], mutuallyExclusiveWith: ["action-b"],
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 500, base: 1_000, optimistic: 1_500 },
      budgetCostMinor: 0, capacityUnits: 0, confidenceBps: 8_000,
      requiredCapabilities: [], requiresHumanApproval: true
    }]
  });
  const right = fact({
    finding: { ...fact().finding, findingId: "finding-z", agentRole: "profit" },
    actions: [{
      ...left.actions[0]!, actionId: "action-b", ownerRole: "profit",
      sourceFindingIds: ["finding-z"], mutuallyExclusiveWith: []
    }]
  });

  const first = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [left, right] });
  const second = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [right, left] });

  assert.deepEqual(second, first);
  assert.equal(first.edges.length, 1);
  assert.equal(first.edges[0]!.kind, "action_exclusivity");
  assert.deepEqual(first.edges[0]!.findingIds, ["finding-z", "发现-甲"]);
});

test("joint financial counterexamples stay separate unless they share a structural conflict", () => {
  const profitability = fact({ finding: {
    ...fact().finding, findingId: "profit-positive", agentRole: "profit",
    formulaRef: { formulaVersion: "product-true-profit.v1",
      inputHash: SHA("c"), resultHash: SHA("d") }
  }});
  const cashNegative = fact({ finding: {
    ...fact().finding, findingId: "cash-negative", agentRole: "cashflow",
    formulaRef: { formulaVersion: "cashflow-forecast.v1",
      inputHash: SHA("e"), resultHash: SHA("f") }
  }});
  const grossMargin = fact({ finding: {
    ...fact().finding, findingId: "gross-margin-high", agentRole: "finance",
    formulaRef: { formulaVersion: "gross-margin.v1",
      inputHash: SHA("1"), resultHash: SHA("2") }
  }});
  const trueProfit = fact({ finding: {
    ...fact().finding, findingId: "true-profit-negative", agentRole: "profit",
    formulaRef: { formulaVersion: "true-profit.v1",
      inputHash: SHA("3"), resultHash: SHA("4") }
  }});
  const highRoiIncompleteEvidence = fact({ finding: {
    ...fact().finding, findingId: "roi-high-incomplete", agentRole: "profit",
    missingData: [{ code: "import_requires_review", source: "roi",
      sourceId: null, description: "actual_roi_missing" }]
  }});

  const graph = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [profitability, cashNegative, grossMargin, trueProfit,
      highRoiIncompleteEvidence] });
  assert.deepEqual(graph.edges, []);
});

test("same canonical capacity signature conflicts but unrelated actions do not", () => {
  const shared = (findingId: string, role: "cost" | "cashflow",
    subjectRef: string | null, capability: string) => fact({
    finding: { ...fact().finding, findingId, agentRole: role },
    actions: [{
      actionId: `action-${findingId}`, kind: role === "cost"
        ? "reduce_cost_anomaly" : "collect_receivable",
      sourceFindingIds: [findingId], ownerRole: role, subjectRef,
      explanation: role === "cost" ? "reduce_cost_anomaly_hypothesis"
        : "collect_receivable_hypothesis",
      durationDays: 1, prerequisites: [], mutuallyExclusiveWith: [],
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 0, base: 0, optimistic: 0 },
      budgetCostMinor: 0, capacityUnits: 1, confidenceBps: 8_000,
      requiredCapabilities: [capability], requiresHumanApproval: true
    }]
  });
  const graph = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [shared("cost-a", "cost", "customer:1", "operator"),
      shared("cash-a", "cashflow", "customer:1", "operator"),
      shared("unrelated", "cost", "customer:2", "other")] });

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.kind, "resource_competition");
  assert.deepEqual(graph.edges[0]!.sharedRefs,
    ["capability:operator", "subject:customer:1"]);
});

test("one deterministic target per role follows kind then edge and finding order", () => {
  const graph = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [
      fact({ finding: { ...fact().finding, findingId: "finance-a",
        formulaRef: { formulaVersion: "ratio.v1", inputHash: SHA("9"),
          resultHash: SHA("a") } } }),
      fact({ finding: { ...fact().finding, findingId: "profit-a",
        agentRole: "profit", formulaRef: { formulaVersion: "ratio.v1",
          inputHash: SHA("9"), resultHash: SHA("b") } } })
    ]
  });
  const targets = selectFinancialCouncilRebuttalTargets(graph, [
    { findingId: "finance-a", role: "finance" },
    { findingId: "profit-a", role: "profit" }
  ]);
  assert.equal(targets.length, 2);
  assert.equal(targets.every((target) => target.round === 1), true);
  assert.equal(targets.every((target) => target.kind === "formula"), true);
});

test("public audit entry accepts only Task 3 validator-authorized results", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("audit-authority"), {
    aggregate, snapshot, occurredAt: snapshot.createdAt
  })).value;
  const roles = ["finance", "profit", "cost", "cashflow", "tax"] as const;
  const authorized = roles.map((role) => authorizeSpecialistResultFixture(run, snapshot,
      specialistResultFixture(run, snapshot, role)));

  assert.equal(buildFinancialCouncilAuditGraph(authorized).runId, run.runId);
  assert.throws(() => buildFinancialCouncilAuditGraph([
    structuredClone(authorized[0]!), ...authorized.slice(1)
  ] as never), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_specialist_result_invalid");
});

test("graph construction rejects a cross-run finding before hashing", () => {
  assert.throws(() => buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [fact({ finding: { ...fact().finding, runId: "foreign-run" } })]
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_audit_invalid");
});

test("definition and risk preference remain closed deterministic conflict kinds", () => {
  const definitionLeft = fact({ finding: { ...fact().finding,
    findingId: "definition-a", formulaRef: { formulaVersion: "margin.gross.v1",
      inputHash: SHA("7"), resultHash: SHA("8") } } });
  const definitionRight = fact({ finding: { ...fact().finding,
    findingId: "definition-b", agentRole: "profit",
    formulaRef: { formulaVersion: "margin.true.v1", inputHash: SHA("7"),
      resultHash: SHA("8") } } });
  const action = (findingId: string, role: "cost" | "cashflow",
    kind: "reduce_cost_anomaly" | "collect_receivable") => fact({
    finding: { ...fact().finding, findingId, agentRole: role },
    actions: [{ actionId: `action-${findingId}`, kind,
      sourceFindingIds: [findingId], ownerRole: role,
      subjectRef: "customer:shared", explanation: kind === "reduce_cost_anomaly"
        ? "reduce_cost_anomaly_hypothesis" : "collect_receivable_hypothesis",
      durationDays: 1, prerequisites: [], mutuallyExclusiveWith: [],
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 0, base: 0, optimistic: 0 },
      budgetCostMinor: 0, capacityUnits: 0, confidenceBps: 8_000,
      requiredCapabilities: [], requiresHumanApproval: true }]
  });
  const graph = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [definitionLeft, definitionRight,
      action("risk-a", "cost", "reduce_cost_anomaly"),
      action("risk-b", "cashflow", "collect_receivable")] });

  assert.deepEqual(graph.edges.map((edge) => edge.kind),
    ["definition", "risk_preference"]);
});

test("same-role portfolio risk alternatives create exactly one real conflict", () => {
  const cashAction = (
    findingId: string,
    kind: "collect_receivable" | "prepare_cash_reserve_budget"
  ) => fact({
    finding: { ...fact().finding, findingId, agentRole: "cashflow" },
    actions: [{
      actionId: `action-${findingId}`, kind,
      sourceFindingIds: [findingId], ownerRole: "cashflow", subjectRef: null,
      explanation: `${kind}_hypothesis`, durationDays: 1,
      prerequisites: [], mutuallyExclusiveWith: [],
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 0, base: 0, optimistic: 0 },
      budgetCostMinor: 0, capacityUnits: 0, confidenceBps: 8_000,
      requiredCapabilities: [], requiresHumanApproval: true
    }]
  });
  const graph = buildCanonicalFinancialCouncilAuditGraph({ ...identity,
    facts: [cashAction("cash-collect", "collect_receivable"),
      cashAction("cash-reserve", "prepare_cash_reserve_budget")] });

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.kind, "risk_preference");
  assert.deepEqual(graph.edges[0]!.sharedRefs, ["role:cashflow"]);
});
