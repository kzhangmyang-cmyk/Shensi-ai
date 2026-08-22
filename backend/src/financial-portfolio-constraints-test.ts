import assert from "node:assert/strict";
import test from "node:test";

const HASH = `sha256:${"a".repeat(64)}` as const;

type Scenario = { conservative: number; base: number; optimistic: number };

function action(
  actionId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const zero: Scenario = { conservative: 0, base: 0, optimistic: 0 };
  return {
    actionId,
    kind: "collect_receivable",
    sourceFindingIds: ["finding-1"],
    ownerRole: "cashflow",
    subjectRef: actionId,
    explanation: "recover verified receivable",
    durationDays: 1,
    prerequisites: [],
    mutuallyExclusiveWith: [],
    cashImpact: zero,
    profitImpact: zero,
    riskReductionBps: zero,
    budgetCostMinor: 0,
    capacityUnits: 1,
    confidenceBps: 8_000,
    requiredCapabilities: [],
    requiresHumanApproval: true,
    ...overrides
  };
}

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    openingCashMinor: 100,
    policy: {
      minimumCashReserveMinor: 100,
      dueDebtMinor: 0,
      necessaryOutflowMinor: 0,
      budgetLimitMinor: 100,
      capacityLimitUnits: 10,
      durationLimitDays: 10,
      minimumActionConfidenceBps: 7_000
    },
    actions: [action("action-a")],
    grantedCapabilities: [],
    satisfiedPrerequisiteIds: [],
    complianceBlockedActionIds: [],
    incompleteActionIds: [],
    unresolvedConflictActionIds: [],
    ...overrides
  };
}

async function evaluate(
  value: Record<string, unknown>,
  selectedIds: readonly string[]
) {
  const module = await import("./financial-portfolio-constraints.js");
  return module.evaluateHardConstraints(value as never, selectedIds);
}

function byKind(result: Awaited<ReturnType<typeof evaluate>>, kind: string) {
  const row = result.find((candidate) => candidate.kind === kind);
  assert.ok(row, kind);
  return row;
}

test("cash reserve accepts exact conservative closing-cash boundary", async () => {
  const result = await evaluate(input(), ["action-a"]);
  assert.equal(byKind(result, "cash_reserve").status, "satisfied");
});

test("debt and necessary outflow coverage rejects a one-minor shortfall", async () => {
  const result = await evaluate(input({
    policy: { ...input().policy as object, dueDebtMinor: 101 }
  }), ["action-a"]);
  assert.equal(
    byKind(result, "debt_and_necessary_outflow_coverage").status,
    "violated"
  );
});

test("compliance blocks actions with unresolved tax or evidence conflicts", async () => {
  const result = await evaluate(input({
    unresolvedConflictActionIds: ["action-a"]
  }), ["action-a"]);
  const row = byKind(result, "compliance");
  assert.equal(row.status, "violated");
  assert.deepEqual(row.blockingActionIds, ["action-a"]);
});

test("permission blocks an action whose required capability is absent", async () => {
  const result = await evaluate(input({
    actions: [action("action-a", { requiredCapabilities: ["finance.write"] })]
  }), ["action-a"]);
  assert.equal(byKind(result, "permission").status, "violated");
});

test("data completeness blocks an action with a critical missing fact", async () => {
  const result = await evaluate(input({
    incompleteActionIds: ["action-a"]
  }), ["action-a"]);
  assert.equal(byKind(result, "data_completeness").status, "violated");
});

test("minimum confidence accepts equality and rejects one BPS below it", async () => {
  const accepted = await evaluate(input(), ["action-a"]);
  assert.equal(byKind(accepted, "minimum_confidence").status, "satisfied");
  const rejected = await evaluate(input({
    actions: [action("action-a", { confidenceBps: 6_999 })]
  }), ["action-a"]);
  assert.equal(byKind(rejected, "minimum_confidence").status, "violated");
});

test("budget rejects totals above the configured limit", async () => {
  const result = await evaluate(input({
    actions: [action("action-a", { budgetCostMinor: 101 })]
  }), ["action-a"]);
  assert.equal(byKind(result, "budget").status, "violated");
});

test("capacity rejects totals above the configured limit", async () => {
  const result = await evaluate(input({
    policy: { ...input().policy as object, capacityLimitUnits: 1 },
    actions: [action("action-a", { capacityUnits: 2 })]
  }), ["action-a"]);
  assert.equal(byKind(result, "capacity").status, "violated");
});

test("duration rejects summed selected action durations above the limit", async () => {
  const result = await evaluate(input({
    policy: { ...input().policy as object, durationLimitDays: 1 },
    actions: [action("action-a", { durationDays: 2 })]
  }), ["action-a"]);
  assert.equal(byKind(result, "duration").status, "violated");
});

test("prerequisite rejects missing closure and selected prerequisite cycles", async () => {
  const missing = await evaluate(input({
    actions: [action("action-a", { prerequisites: ["action-b"] })]
  }), ["action-a"]);
  assert.equal(byKind(missing, "prerequisite").status, "violated");
  const cycle = await evaluate(input({
    actions: [
      action("action-a", { prerequisites: ["action-b"] }),
      action("action-b", { prerequisites: ["action-a"] })
    ]
  }), ["action-b", "action-a"]);
  const row = byKind(cycle, "prerequisite");
  assert.equal(row.status, "violated");
  assert.deepEqual(row.blockingActionIds, ["action-a", "action-b"]);
});

test("mutual exclusion requires symmetric declarations and disallows both actions", async () => {
  const asymmetric = await evaluate(input({
    actions: [
      action("action-a", { mutuallyExclusiveWith: ["action-b"] }),
      action("action-b")
    ]
  }), ["action-a", "action-b"]);
  assert.equal(byKind(asymmetric, "mutual_exclusion").status, "violated");
  const symmetric = await evaluate(input({
    actions: [
      action("action-a", { mutuallyExclusiveWith: ["action-b"] }),
      action("action-b", { mutuallyExclusiveWith: ["action-a"] })
    ]
  }), ["action-b", "action-a"]);
  assert.equal(byKind(symmetric, "mutual_exclusion").status, "violated");
  assert.deepEqual(
    byKind(symmetric, "mutual_exclusion").blockingActionIds,
    ["action-a", "action-b"]
  );
});

test("duplicate action rejects the same semantic kind and subject", async () => {
  const result = await evaluate(input({
    actions: [
      action("action-a", { subjectRef: "customer-1" }),
      action("action-b", { subjectRef: "customer-1" })
    ]
  }), ["action-b", "action-a"]);
  assert.equal(byKind(result, "duplicate_action").status, "violated");
  assert.deepEqual(
    byKind(result, "duplicate_action").blockingActionIds,
    ["action-a", "action-b"]
  );
});

test("evaluation returns all twelve constraints in fixed order for an empty selection", async () => {
  const result = await evaluate(input({ actions: [] }), []);
  assert.deepEqual(result.map((row) => row.kind), [
    "cash_reserve",
    "debt_and_necessary_outflow_coverage",
    "compliance",
    "permission",
    "data_completeness",
    "minimum_confidence",
    "budget",
    "capacity",
    "duration",
    "prerequisite",
    "mutual_exclusion",
    "duplicate_action"
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
});

test("all violated constraints are reported in action-id order without short circuiting", async () => {
  const result = await evaluate(input({
    actions: [action("action-b", {
      budgetCostMinor: 101,
      capacityUnits: 11,
      confidenceBps: 1,
      requiredCapabilities: ["finance.write"],
      prerequisites: ["missing"]
    })],
    complianceBlockedActionIds: ["action-b"],
    incompleteActionIds: ["action-b"]
  }), ["action-b"]);
  assert.deepEqual(
    result.filter((row) => row.status === "violated").map((row) => row.kind),
    [
      "compliance", "permission", "data_completeness", "minimum_confidence",
      "budget", "capacity", "prerequisite"
    ]
  );
});

test("constraint inputs reject unsafe public integers", async () => {
  await assert.rejects(
    evaluate(input({ openingCashMinor: Number.MAX_SAFE_INTEGER + 1 }), []),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_portfolio_constraint_input_invalid"
  );
});

void HASH;
