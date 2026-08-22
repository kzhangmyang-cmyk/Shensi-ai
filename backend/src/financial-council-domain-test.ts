import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  applyFinancialCouncilTransition,
  financialCouncilError,
  financialCouncilAggregateHash,
  financialCouncilCanonicalHash,
  isFinancialCouncilError,
  type FinancialCouncilRun
} from "./financial-council-domain.js";

test("financial council errors are branded and cannot be forged by shape", () => {
  const trusted = financialCouncilError("financial_council_input_invalid");
  assert.equal(isFinancialCouncilError(trusted), true);
  assert.equal(isFinancialCouncilError({ code: trusted.code }), false);
  assert.equal(isFinancialCouncilError(Object.create(trusted)), false);
});

export const T0 = "2026-08-16T08:00:00.000Z";
export const T1 = "2026-08-16T08:01:00.000Z";
export const T2 = "2026-08-16T08:02:00.000Z";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

export function runFixture(
  overrides: Partial<FinancialCouncilRun> = {}
): FinancialCouncilRun {
  return Object.freeze({
    runId: "council-run-1",
    workspaceId: "ws-1",
    creationKeyHash: SHA_A,
    requestHash: SHA_B,
    currency: "CNY",
    status: "created",
    revision: 1,
    dataAsOf: "2026-08-15T00:00:00.000Z",
    businessReport: Object.freeze({
      currency: "CNY",
      companyName: "示例公司",
      period: "2026-07",
      balanceSheet: Object.freeze({
        period: "2026-07",
        cashMinor: 100_000,
        receivablesMinor: 20_000,
        inventoryMinor: 10_000,
        otherCurrentAssetsMinor: 5_000,
        nonCurrentAssetsMinor: 80_000,
        currentLiabilitiesMinor: 30_000,
        nonCurrentLiabilitiesMinor: 40_000,
        accountsPayableMinor: 12_000
      }),
      incomeStatement: Object.freeze({
        period: "2026-07",
        revenueMinor: 150_000,
        costOfGoodsSoldMinor: 70_000,
        operatingExpensesMinor: 30_000,
        interestExpenseMinor: 2_000,
        taxExpenseMinor: 5_000
      })
    }),
    policyVersionId: "policy-v1",
    snapshotId: null,
    snapshotHash: null,
    consensusReport: null,
    portfolios: Object.freeze([]),
    latestPortfolioRevision: null,
    approval: null,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: "2026-08-17T08:00:00.000Z",
    ...overrides
  });
}

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: unknown }).code === code;
}

test("run transitions are closed and revisioned", () => {
  const created = runFixture({ status: "created", revision: 1 });
  const frozen = applyFinancialCouncilTransition(created, {
    kind: "snapshot_frozen", occurredAt: T1, actorId: "system:council"
  });
  assert.equal(frozen.status, "snapshot_frozen");
  assert.equal(frozen.revision, 2);
  assert.equal(frozen.updatedAt, T1);
  assert.throws(() => applyFinancialCouncilTransition(frozen, {
    kind: "approved", occurredAt: T2, actorId: "actor-1"
  }), hasCode("financial_council_transition_invalid"));
});

test("the only progressive path reaches each approval state in order", () => {
  const kinds = [
    "snapshot_frozen", "analyzing", "auditing", "synthesizing",
    "optimizing", "awaiting_approval", "approved"
  ] as const;
  const result = kinds.reduce((run, kind, index) =>
    applyFinancialCouncilTransition(run, {
      kind,
      occurredAt: `2026-08-16T08:0${index + 1}:00.000Z`,
      actorId: "system:council"
    }), runFixture());
  assert.equal(result.status, "approved");
  assert.equal(result.revision, 8);
});

test("every nonterminal may fail or become not computable", () => {
  const statuses = [
    "created", "snapshot_frozen", "analyzing", "auditing", "synthesizing",
    "optimizing", "awaiting_approval"
  ] as const;
  for (const status of statuses) {
    for (const kind of ["failed", "not_computable"] as const) {
      const next = applyFinancialCouncilTransition(runFixture({ status }), {
        kind, occurredAt: T1, actorId: "system:council"
      });
      assert.equal(next.status, kind, `${status} -> ${kind}`);
    }
  }
});

test("terminal runs never reopen", () => {
  for (const status of [
    "approved", "rejected", "stale", "expired", "failed", "not_computable"
  ] as const) {
    assert.throws(() => applyFinancialCouncilTransition(
      runFixture({ status }),
      { kind: "analyzing", occurredAt: T1, actorId: "actor-1" }
    ), hasCode("financial_council_transition_invalid"), status);
  }
});

test("an awaiting approval run may become explicitly stale and never reopen",
() => {
  const stale = applyFinancialCouncilTransition(runFixture({
    status: "awaiting_approval"
  }), { kind: "stale", occurredAt: T1, actorId: "system:council" });
  assert.equal(stale.status, "stale");
  assert.throws(() => applyFinancialCouncilTransition(stale, {
    kind: "approved", occurredAt: T2, actorId: "actor-1"
  }), hasCode("financial_council_transition_invalid"));
});

test("aggregate hashes cover canonical immutable run state", () => {
  const run = runFixture();
  assert.match(financialCouncilAggregateHash(run), /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    financialCouncilAggregateHash(run),
    financialCouncilAggregateHash(runFixture({ revision: 2 }))
  );
  assert.equal(Object.isFrozen(applyFinancialCouncilTransition(run, {
    kind: "failed", occurredAt: T1, actorId: "system:council"
  })), true);
});

test("canonical hashes are independent of the process locale", () => {
  const script = [
    "import { financialCouncilCanonicalHash as hash }",
    "from './src/financial-council-domain.ts';",
    "console.log(hash({ 'ä': 1, z: 2 }));"
  ].join(" ");
  const hashAt = (locale: string) => execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", script
  ], {
    cwd: process.cwd(),
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    encoding: "utf8"
  }).trim();
  assert.equal(hashAt("en_US.UTF-8"), hashAt("sv_SE.UTF-8"));
});

test("canonical hashing rejects every non-JSON value without collisions", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = [1, 2];
  delete sparse[1];
  const invalid: readonly [string, unknown][] = [
    ["undefined property", { optional: undefined }],
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["negative infinity", { value: Number.NEGATIVE_INFINITY }],
    ["function", { value: () => 1 }],
    ["symbol", { value: Symbol("value") }],
    ["bigint", { value: 1n }],
    ["sparse array", sparse],
    ["cycle", cycle],
    ["non-plain object", { value: new Date(T0) }]
  ];
  for (const [label, value] of invalid) {
    assert.throws(
      () => financialCouncilAggregateHash(value as FinancialCouncilRun),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_council_input_invalid",
      label
    );
  }
});

test("canonical hashing rejects decorated and accessor-backed arrays", () => {
  const nonEnumerable = [1];
  Object.defineProperty(nonEnumerable, "hidden", { value: 2 });
  const symbolKey = [1];
  Object.defineProperty(symbolKey, Symbol("hidden"), { value: 2 });
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get: () => 1
  });
  accessor.length = 1;

  for (const value of [nonEnumerable, symbolKey, accessor]) {
    assert.throws(
      () => financialCouncilCanonicalHash(value),
      hasCode("financial_council_input_invalid")
    );
  }
});
