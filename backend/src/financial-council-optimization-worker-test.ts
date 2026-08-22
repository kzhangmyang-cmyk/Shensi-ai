import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilPipelineWorker,
  FinancialCouncilOptimizationWorker
} from "./financial-council-optimization-worker.js";
import {
  createFinancialCouncilPortfolioRevision,
  InMemoryFinancialCouncilRepository
} from "./financial-council-repository.js";
import {
  storedConsensusFixture,
  workspace
} from "./financial-council-repository-contract-test.js";
import {
  createDefaultFinancialCouncilPolicy
} from "./financial-council-policy.js";
import {
  InMemoryFinancialCouncilPolicyRepository
} from "./financial-council-policy-repository.js";

const NOW = "2026-08-16T08:10:00.000Z";

async function setupSynthesizing() {
  const repository = new InMemoryFinancialCouncilRepository();
  const policyRepository = new InMemoryFinancialCouncilPolicyRepository();
  const policy = createDefaultFinancialCouncilPolicy("ws-1",
    "2026-08-16T08:00:00.000Z");
  await policyRepository.getOrCreateActive(workspace(), policy);
  const { report } = await storedConsensusFixture(repository, {
    policyVersionId: policy.policyVersionId
  });
  const internal = repository as unknown as {
    state: { consensusReports: Map<string, unknown> }
  };
  internal.state.consensusReports.clear();
  let run = (await repository.findRun(workspace(), report.runId))!;
  const lease = (await repository.claimAnalysisRun({
    workspaceId: run.workspaceId,
    runId: run.runId,
    workerId: "analysis-worker",
    leaseToken: "1".repeat(64),
    claimedAt: "2026-08-16T08:02:00.000Z",
    leaseExpiresAt: "2026-08-16T08:20:00.000Z"
  }))!;
  for (const [kind, occurredAt] of [
    ["analyzing", "2026-08-16T08:03:00.000Z"],
    ["auditing", "2026-08-16T08:04:00.000Z"],
    ["synthesizing", "2026-08-16T08:05:00.000Z"]
  ] as const) {
    run = (await repository.transitionRunWithLease(lease, {
      kind, occurredAt, reasonCode: null
    })).value;
  }
  await repository.releaseAnalysisLease(
    lease, "2026-08-16T08:06:00.000Z"
  );
  return { repository, policyRepository, run };
}

function worker(
  input: Awaited<ReturnType<typeof setupSynthesizing>>,
  overrides: Partial<ConstructorParameters<
    typeof FinancialCouncilOptimizationWorker
  >[0]> = {}
) {
  return new FinancialCouncilOptimizationWorker({
    repository: input.repository,
    policyRepository: input.policyRepository,
    cfo: {
      async synthesize() {
        throw Object.assign(new Error("model unavailable"), {
          code: "not_computable:model_connection_unavailable"
        });
      }
    },
    workerId: "optimization-worker",
    now: () => NOW,
    leaseDurationMs: 30 * 60_000,
    leaseTokenFactory: () => "2".repeat(64),
    ...overrides
  });
}

test("model-unavailable CFO fallback still publishes three complete empty portfolios", async () => {
  const fixture = await setupSynthesizing();
  const optimizationWorker = worker(fixture);

  await optimizationWorker.wake(fixture.run);

  const published = (await fixture.repository.findRun(
    workspace(), fixture.run.runId
  ))!;
  assert.equal(published.status, "awaiting_approval");
  assert.equal(published.latestPortfolioRevision, 1);
  assert.match(published.consensusReport!.overallDiagnosis,
    /\[finding:/u);
  assert.deepEqual(published.portfolios.map((portfolio) => portfolio.kind),
    ["balanced", "cash_first", "growth_first"]);
  assert.ok(published.portfolios.every((portfolio) =>
    portfolio.actionIds.length === 0
    && portfolio.hardConstraints.length === 12));
  await optimizationWorker.close();
});

test("crash after immutable insert resumes by recomputing and byte-comparing before publish", async () => {
  const fixture = await setupSynthesizing();
  let tick = Date.parse(NOW);
  const tickingNow = () => new Date(tick++).toISOString();
  const originalPublish = fixture.repository.publishPortfolioRevisionWithLease
    .bind(fixture.repository);
  let crash = true;
  fixture.repository.publishPortfolioRevisionWithLease = async (...args) => {
    if (crash) {
      crash = false;
      throw new Error("crash-after-portfolio-insert");
    }
    return originalPublish(...args);
  };
  const first = worker(fixture, { now: tickingNow });
  await assert.rejects(first.wake(fixture.run), /crash-after-portfolio-insert/u);
  assert.equal((await fixture.repository.findRun(
    workspace(), fixture.run.runId))?.status, "optimizing");
  const stored = await fixture.repository.getPortfolioRevision(
    workspace(), fixture.run.runId, 1
  );
  assert.ok(stored);

  const restarted = worker(fixture, { now: tickingNow });
  await restarted.wake(fixture.run);
  assert.equal((await fixture.repository.findRun(
    workspace(), fixture.run.runId))?.status, "awaiting_approval");
  assert.deepEqual(await fixture.repository.getPortfolioRevision(
    workspace(), fixture.run.runId, 1
  ), stored);
});

test("re-signed stored score tamper fails closed during recovery recomputation", async () => {
  const fixture = await setupSynthesizing();
  const originalPublish = fixture.repository.publishPortfolioRevisionWithLease
    .bind(fixture.repository);
  fixture.repository.publishPortfolioRevisionWithLease = async () => {
    throw new Error("crash-after-portfolio-insert");
  };
  await assert.rejects(worker(fixture).wake(fixture.run),
    /crash-after-portfolio-insert/u);
  const stored = (await fixture.repository.getPortfolioRevision(
    workspace(), fixture.run.runId, 1
  ))!;
  const changedPortfolios = stored.portfolios.map((portfolio, index) =>
    index === 0 ? { ...portfolio, objectiveScoreBps: 1 } : portfolio);
  const { revisionId: _revisionId, outputHash: _outputHash,
    portfolios: _portfolios, ...binding } = stored;
  const tampered = createFinancialCouncilPortfolioRevision({
    ...binding, portfolios: changedPortfolios
  });
  const internal = fixture.repository as unknown as {
    state: { portfolioRevisions: Map<string, unknown> }
  };
  internal.state.portfolioRevisions.set(
    `ws-1\u0000${fixture.run.runId}\u00001`, tampered
  );
  fixture.repository.publishPortfolioRevisionWithLease = originalPublish;

  await worker(fixture).wake(fixture.run);

  const failed = await fixture.repository.findRun(
    workspace(), fixture.run.runId
  );
  assert.equal(failed?.status, "failed");
  assert.equal((await fixture.repository.listEvents(
    workspace(), fixture.run.runId
  )).at(-1)?.reasonCode, "portfolio_replay_mismatch");
});

test("critical optimizer invalid input closes as not computable without a revision", async () => {
  const fixture = await setupSynthesizing();
  const invalid = ["balanced", "cash_first", "growth_first"].map((kind) => ({
    kind,
    status: "not_computable",
    reasonCode: "candidate_limit_exceeded"
  })) as never;

  await worker(fixture, { optimize: () => invalid }).wake(fixture.run);

  const closed = await fixture.repository.findRun(
    workspace(), fixture.run.runId
  );
  assert.equal(closed?.status, "not_computable");
  assert.equal((await fixture.repository.listEvents(
    workspace(), fixture.run.runId
  )).at(-1)?.reasonCode, "candidate_limit_exceeded");
  assert.equal(await fixture.repository.getPortfolioRevision(
    workspace(), fixture.run.runId, 1
  ), null);
});

test("pipeline worker runs analysis then optimization and drains both on close", async () => {
  const events: string[] = [];
  const pipeline = new FinancialCouncilPipelineWorker({
    analysis: {
      async wake() { events.push("analysis:wake"); },
      async close() { events.push("analysis:close"); }
    },
    optimization: {
      async wake() { events.push("optimization:wake"); },
      async close() { events.push("optimization:close"); }
    }
  });

  await Promise.all([
    pipeline.wake({ workspaceId: "ws-1", runId: "run-1" }),
    pipeline.wake({ workspaceId: "ws-1", runId: "run-1" })
  ]);
  await pipeline.close();

  assert.deepEqual(events, [
    "analysis:wake", "optimization:wake",
    "optimization:close", "analysis:close"
  ]);
});
