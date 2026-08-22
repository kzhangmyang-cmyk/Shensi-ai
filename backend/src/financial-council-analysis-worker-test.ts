import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilAnalysisWorker,
  type FinancialCouncilAnalysisPipeline
} from "./financial-council-analysis-worker.js";
import { InMemoryFinancialCouncilRepository } from
  "./financial-council-repository.js";
import {
  command, repositoryRunFixture, snapshotFixture, workspace
} from "./financial-council-repository-contract-test.js";
import type { FinancialCouncilAgentRole } from "./growth-contract-types.js";
import { authorizeSpecialistResultFixture } from
  "./financial-council-repository-contract-test.js";

const T0 = "2026-08-16T08:00:00.000Z";
const T1 = "2026-08-16T08:01:00.000Z";
const T2 = "2026-08-16T08:02:00.000Z";

async function setup() {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("worker"), {
    aggregate, snapshot, occurredAt: snapshot.createdAt
  })).value;
  return { repository, run, snapshot };
}

function pipeline(options: {
  fail?: FinancialCouncilAgentRole;
  unavailableTax?: boolean;
  never?: FinancialCouncilAgentRole;
} = {}) {
  const analyzed: FinancialCouncilAgentRole[] = [];
  let audits = 0;
  const value: FinancialCouncilAnalysisPipeline = {
    async inspectRole(_context, _runId, role) {
      return role === "tax" && options.unavailableTax
        ? { available: false as const, gapCode: "tax_input_missing" as const,
            hardConstraintDependency: false as const,
            actionDependency: false as const }
        : { available: true as const, hardConstraintDependency: false as const,
            actionDependency: false as const };
    },
    async analyzeRole({ role }) {
      analyzed.push(role);
      if (role === options.never) return new Promise(() => undefined);
      if (role === options.fail) throw Object.assign(new Error("provider"), {
        code: "financial_council_model_provider_failed", retryable: false
      });
    },
    async audit() { audits += 1; }
  };
  return { value, analyzed, audits: () => audits };
}

test("lease uses random 64-hex token, increments attempt, and exact expiry is stale", async () => {
  const { repository, run } = await setup();
  const first = await repository.claimAnalysisRun({
    workspaceId: run.workspaceId, runId: run.runId, workerId: "worker-a",
    leaseToken: "a".repeat(64), claimedAt: T0, leaseExpiresAt: T1
  });
  assert.equal(first?.attempt, 1);
  assert.match(first!.leaseToken, /^[0-9a-f]{64}$/u);
  await assert.rejects(repository.transitionRunWithLease(first!, {
    kind: "analyzing", occurredAt: T1, reasonCode: null
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_lease_stale");
  const reclaimed = await repository.claimAnalysisRun({
    workspaceId: run.workspaceId, runId: run.runId, workerId: "worker-a",
    leaseToken: "b".repeat(64), claimedAt: T1, leaseExpiresAt: T2
  });
  assert.equal(reclaimed?.attempt, 2);
  await assert.rejects(repository.transitionRunWithLease(first!, {
    kind: "analyzing", occurredAt: "2026-08-16T08:00:30.000Z",
    reasonCode: null
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_lease_stale");
});

test("stale lease fences specialist, graph, rebuttal reservation and disposition writes", async () => {
  const { repository, run, snapshot } = await setup();
  const lease = (await repository.claimAnalysisRun({
    workspaceId: run.workspaceId, runId: run.runId, workerId: "worker-a",
    leaseToken: "9".repeat(64), claimedAt: T0, leaseExpiresAt: T1
  }))!;
  const staleWrite = { lease, completedAt: T1 };
  const specialist = authorizeSpecialistResultFixture(run, snapshot);
  const stale = (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_lease_stale";
  await assert.rejects(repository.storeSpecialistResult(
    workspace(), specialist, staleWrite
  ), stale);
  await assert.rejects(repository.storeAuditGraph(
    workspace(), {} as never, [], staleWrite
  ), stale);
  await assert.rejects(repository.reserveRebuttalAttempt(
    workspace(), {} as never, staleWrite
  ), stale);
  await assert.rejects(repository.completeRebuttalAttempt(
    workspace(), {} as never, staleWrite
  ), stale);
});

test("duplicate wake has one winner and restart reuses durable role outcomes", async () => {
  const { repository, run } = await setup();
  const execution = pipeline();
  const worker = new FinancialCouncilAnalysisWorker({
    repository, pipeline: execution.value, workerId: "worker-a",
    now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: (() => {
      let sequence = 0;
      return () => (++sequence).toString(16).padStart(64, "0");
    })()
  });
  await Promise.all([worker.wake(run), worker.wake(run)]);
  assert.deepEqual(execution.analyzed,
    ["finance", "profit", "cost", "cashflow", "tax"]);
  assert.equal(execution.audits(), 1);
  assert.equal((await repository.findRun(workspace(), run.runId))?.status,
    "synthesizing");
  await worker.close();
});

test("process restart resumes auditing without replaying the five analyze jobs", async () => {
  const { repository, run } = await setup();
  const first = pipeline();
  first.value.audit = async () => { throw new Error("crash-after-analysis"); };
  const crashed = new FinancialCouncilAnalysisWorker({
    repository, pipeline: first.value, workerId: "worker-a",
    now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "1".repeat(64)
  });
  await assert.rejects(crashed.wake(run), /crash-after-analysis/u);
  assert.equal((await repository.findRun(workspace(), run.runId))?.status,
    "auditing");

  const resumed = pipeline();
  const restarted = new FinancialCouncilAnalysisWorker({
    repository, pipeline: resumed.value, workerId: "worker-b",
    now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "2".repeat(64)
  });
  await restarted.wake(run);
  assert.deepEqual(resumed.analyzed, []);
  assert.equal(resumed.audits(), 1);
  assert.equal((await repository.findRun(workspace(), run.runId))?.status,
    "synthesizing");
});

test("one retry is transport-only and keeps one logical role identity", async () => {
  const { repository, run } = await setup();
  const attempts = new Map<FinancialCouncilAgentRole, number>();
  const logical: FinancialCouncilAgentRole[] = [];
  const execution = pipeline();
  execution.value.analyzeRole = async ({ role }) => {
    logical.push(role);
    const count = (attempts.get(role) ?? 0) + 1;
    attempts.set(role, count);
    if (role === "profit" && count === 1) throw Object.assign(
      new Error("transport"), { retryable: true }
    );
  };
  const worker = new FinancialCouncilAnalysisWorker({
    repository, pipeline: execution.value, workerId: "worker-a",
    now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "3".repeat(64)
  });
  await worker.wake(run);
  assert.equal(logical.length, 6);
  assert.equal(attempts.get("profit"), 2);
  assert.deepEqual([...new Set(logical)],
    ["finance", "profit", "cost", "cashflow", "tax"]);
});

test("noncritical failure persists a closed redacted gap but critical failure closes the run", async () => {
  const noncritical = await setup();
  const partial = pipeline({ fail: "profit" });
  const worker = new FinancialCouncilAnalysisWorker({
    repository: noncritical.repository, pipeline: partial.value,
    workerId: "worker-a", now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "c".repeat(64)
  });
  await worker.wake(noncritical.run);
  assert.equal((await noncritical.repository.findRun(
    workspace(), noncritical.run.runId))?.status, "synthesizing");
  assert.deepEqual((await noncritical.repository.listAnalysisGaps(
    workspace(), noncritical.run.runId)).map((gap) =>
    ({ role: gap.role, code: gap.code, detail: gap.detail })), [{
      role: "profit", code: "specialist_unavailable", detail: null
    }]);

  const critical = await setup();
  const failed = pipeline({ fail: "cashflow" });
  const criticalWorker = new FinancialCouncilAnalysisWorker({
    repository: critical.repository, pipeline: failed.value,
    workerId: "worker-b", now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "d".repeat(64)
  });
  await criticalWorker.wake(critical.run);
  assert.equal((await critical.repository.findRun(
    workspace(), critical.run.runId))?.status, "not_computable");
});

test("missing tax input becomes a gap without a fabricated tax model result", async () => {
  const { repository, run } = await setup();
  const execution = pipeline({ unavailableTax: true });
  const worker = new FinancialCouncilAnalysisWorker({
    repository, pipeline: execution.value, workerId: "worker-a",
    now: () => T0, leaseDurationMs: 60_000,
    leaseTokenFactory: () => "e".repeat(64)
  });
  await worker.wake(run);
  assert.equal(execution.analyzed.includes("tax"), false);
  assert.equal((await repository.listAnalysisGaps(
    workspace(), run.runId))[0]?.code, "tax_input_missing");
});

test("timeout closes a critical role and logs only closed identifiers", async () => {
  const { repository, run } = await setup();
  const execution = pipeline({ never: "finance" });
  const logs: unknown[] = [];
  const worker = new FinancialCouncilAnalysisWorker({
    repository, pipeline: execution.value, workerId: "worker-secret",
    now: () => T0, leaseDurationMs: 60_000, roleTimeoutMs: 1,
    leaseTokenFactory: () => "f".repeat(64),
    logger: { error(event) { logs.push(event); } }
  });
  await worker.wake(run);
  assert.equal((await repository.findRun(workspace(), run.runId))?.status,
    "not_computable");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("worker-secret"), false);
  assert.equal(serialized.includes("f".repeat(64)), false);
  assert.equal(serialized.includes("provider"), false);
  assert.match(serialized, /finance/u);
});
