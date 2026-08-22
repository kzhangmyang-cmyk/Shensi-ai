import {
  InMemoryFinancialCouncilRepository
} from "./financial-council-repository.js";
import {
  registerFinancialCouncilRepositoryContract
} from "./financial-council-repository-contract-test.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeSpecialistResultFixture, builderSnapshotFixture, command,
  repositoryRunFixture, resignSnapshotRecord, snapshotFixture,
  specialistResultFixture, storedConsensusFixture, storedPortfolioRevisionFixture,
  T1, workspace
} from "./financial-council-repository-contract-test.js";
import {
  financialCouncilAggregateHash,
  financialCouncilCanonicalHash
} from
  "./financial-council-domain.js";

registerFinancialCouncilRepositoryContract(
  "memory financial council repository",
  () => new InMemoryFinancialCouncilRepository()
);

test("memory consensus read reports stored canonical corruption as integrity", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const { report } = await storedConsensusFixture(repository);
  const changed = { ...report, acceptedFindings: [] };
  const { reportId: _old, ...preimage } = changed;
  const internal = repository as unknown as {
    state: { consensusReports: Map<string, unknown> }
  };
  internal.state.consensusReports.set(`ws-1\u0000${report.runId}`, {
    ...preimage, reportId: financialCouncilCanonicalHash(preimage)
  });

  await assert.rejects(repository.getConsensus(workspace(), report.runId),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_integrity");
});

test("memory published run and revision reads reject stored portfolio tampering", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const { lease, revision } = await storedPortfolioRevisionFixture(repository);
  await repository.publishPortfolioRevisionWithLease(lease, {
    revision: 1,
    expectedOutputHash: revision.outputHash,
    occurredAt: "2026-08-16T08:07:00.000Z"
  });
  const internal = repository as unknown as {
    state: { portfolioRevisions: Map<string, Record<string, unknown>> }
  };
  const key = `ws-1\u0000${revision.runId}\u00001`;
  const stored = internal.state.portfolioRevisions.get(key)!;
  internal.state.portfolioRevisions.set(key, {
    ...stored,
    outputHash: `sha256:${"f".repeat(64)}`
  });

  for (const read of [
    () => repository.getPortfolioRevision(workspace(), revision.runId, 1),
    () => repository.findRun(workspace(), revision.runId)
  ]) {
    await assert.rejects(read(), (error: unknown) =>
      (error as { code?: unknown }).code === "financial_council_integrity");
  }
});

test("memory reads and replay reject a re-signed noncanonical report", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  await repository.createRun(command("create"), aggregate);
  const internal = repository as unknown as {
    state: {
      runs: Map<string, Record<string, unknown>>;
      events: Map<string, Array<Record<string, unknown>>>;
    };
  };
  const key = "ws-1\u0000council-run-1";
  const current = internal.state.runs.get(key)!;
  const businessReport = {
    ...(current.businessReport as Record<string, unknown>),
    balanceSheet: {
      ...((current.businessReport as Record<string, unknown>)
        .balanceSheet as Record<string, unknown>),
      cashMinor: -1
    }
  };
  const changed = { ...current, businessReport };
  const event = internal.state.events.get(key)![0]!;
  internal.state.runs.set(key, changed);
  internal.state.events.set(key, [{
    ...event,
    aggregateSnapshot: changed,
    aggregateSnapshotHash: financialCouncilAggregateHash(changed as never)
  }]);
  for (const read of [
    () => repository.findRun(workspace(), aggregate.runId),
    () => repository.createRun(command("replay"), aggregate)
  ]) {
    await assert.rejects(read(), (error: unknown) =>
      (error as { code?: unknown }).code === "financial_council_integrity");
  }
});

test("memory reads and replay reject re-signed run-bound snapshot provenance", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = await builderSnapshotFixture(aggregate);
  const frozen = (await repository.createAndFreezeRun(command("create"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  const changedSnapshot = resignSnapshotRecord(snapshot, (value) => ({
    ...value,
    report: {
      ...(value.report as Record<string, unknown>),
      netProfitMinor: Number(
        (value.report as Record<string, unknown>).netProfitMinor
      ) + 1
    }
  }));
  const changedRun = { ...frozen, snapshotHash: changedSnapshot.snapshotHash };
  const internal = repository as unknown as {
    state: {
      runs: Map<string, Record<string, unknown>>;
      events: Map<string, Array<Record<string, unknown>>>;
      snapshots: Map<string, unknown>;
    };
  };
  const runKey = `ws-1\u0000${aggregate.runId}`;
  const events = internal.state.events.get(runKey)!;
  internal.state.runs.set(runKey, changedRun);
  internal.state.snapshots.set(
    `ws-1\u0000${snapshot.snapshotId}`, changedSnapshot
  );
  events[1] = {
    ...events[1],
    aggregateSnapshot: changedRun,
    aggregateSnapshotHash: financialCouncilAggregateHash(changedRun as never)
  };
  for (const read of [
    () => repository.findRun(workspace(), aggregate.runId),
    () => repository.findFrozenRunByCreationKey(
      workspace(), aggregate.creationKeyHash, aggregate.requestHash
    )
  ]) {
    await assert.rejects(read(), (error: unknown) =>
      (error as { code?: unknown }).code === "financial_council_integrity");
  }
});

for (const method of ["findRun", "findFrozenRunByCreationKey"] as const) {
  test(`memory ${method} rejects snapshot freeze time mismatch`, async () => {
    const repository = new InMemoryFinancialCouncilRepository();
    const aggregate = repositoryRunFixture();
    const snapshot = await builderSnapshotFixture(aggregate);
    await repository.createAndFreezeRun(command("create"), {
      aggregate, snapshot, occurredAt: T1
    });
    const internal = repository as unknown as {
      state: { snapshots: Map<string, Record<string, unknown>> }
    };
    const snapshotKey = `ws-1\u0000${snapshot.snapshotId}`;
    const record = internal.state.snapshots.get(snapshotKey)!;
    internal.state.snapshots.set(snapshotKey, {
      ...record, createdAt: "2026-08-16T08:02:00.000Z"
    });

    const read = method === "findRun"
      ? repository.findRun(workspace(), aggregate.runId)
      : repository.findFrozenRunByCreationKey(
          workspace(), aggregate.creationKeyHash, aggregate.requestHash
        );
    await assert.rejects(read, (error: unknown) =>
      (error as { code?: unknown }).code === "financial_council_integrity");
  });
}

test("memory replay and reads reject every re-signed history divergence", async () => {
  for (const kind of ["hash", "actor", "time", "aggregate"] as const) {
    const repository = new InMemoryFinancialCouncilRepository();
    const aggregate = repositoryRunFixture();
    await repository.createAndFreezeRun(command("create"), {
      aggregate, snapshot: snapshotFixture(aggregate), occurredAt: T1
    });
    const internal = repository as unknown as {
      state: { events: Map<string, Array<Record<string, unknown>>> }
    };
    const events = internal.state.events.get("ws-1\u0000council-run-1")!;
    const target = kind === "aggregate" ? events[1]! : events[0]!;
    const changed = kind === "hash"
      ? { ...target, aggregateSnapshotHash: `sha256:${"f".repeat(64)}` }
      : kind === "actor"
        ? { ...target, actorId: "attacker" }
        : kind === "time"
          ? { ...target, occurredAt: T1 }
          : (() => {
              const aggregateSnapshot = {
                ...(target.aggregateSnapshot as object), policyVersionId: "tampered"
              };
              return {
                ...target,
                aggregateSnapshot,
                aggregateSnapshotHash: financialCouncilAggregateHash(
                  aggregateSnapshot as never
                )
              };
            })();
    events[kind === "aggregate" ? 1 : 0] = changed;
    const calls = [
      () => repository.findFrozenRunByCreationKey(
        workspace(), aggregate.creationKeyHash, aggregate.requestHash
      ),
      () => repository.findRun(workspace(), aggregate.runId),
      () => repository.listEvents(workspace(), aggregate.runId),
      () => repository.listRunnableRuns({ after: null, limit: 10 })
    ];
    for (const call of calls) {
      await assert.rejects(call(), (error: unknown) =>
        (error as { code?: unknown }).code === "financial_council_integrity");
    }
  }
});

test("memory legacy create replay rejects a missing or corrupted first event", async () => {
  for (const corruption of ["missing", "hash"] as const) {
    const repository = new InMemoryFinancialCouncilRepository();
    const aggregate = repositoryRunFixture();
    await repository.createRun(command("create"), aggregate);
    const internal = repository as unknown as {
      state: { events: Map<string, Array<Record<string, unknown>>> }
    };
    const events = internal.state.events.get("ws-1\u0000council-run-1")!;
    if (corruption === "missing") events.splice(0, 1);
    else events[0] = {
      ...events[0], aggregateSnapshotHash: `sha256:${"f".repeat(64)}`
    };

    await assert.rejects(
      repository.createRun(command("replay"), aggregate),
      (error: unknown) =>
        (error as { code?: unknown }).code === "financial_council_integrity"
    );
  }
});

test("memory specialist reads reject missing atomic child records", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("specialist"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  await repository.storeSpecialistResult(
    workspace(), authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot)
    )
  );
  const internal = repository as unknown as {
    state: { specialistFindings: Map<string, unknown> }
  };
  internal.state.specialistFindings.clear();

  await assert.rejects(repository.getSpecialistResult(
    workspace(), run.runId, "finance", "analyze"
  ), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_integrity");
});

test("memory specialist listing rejects an orphan result without its run", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("specialist"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  await repository.storeSpecialistResult(
    workspace(), authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot)
    )
  );
  const internal = repository as unknown as {
    state: { runs: Map<string, unknown> }
  };
  internal.state.runs.clear();

  await assert.rejects(repository.listSpecialistResults(
    workspace(), run.runId
  ), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_integrity");
});

test("memory specialist reads bind each map key to its role and phase", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("specialist"), {
    aggregate, snapshot, occurredAt: T1
  })).value;
  await repository.storeSpecialistResult(
    workspace(), authorizeSpecialistResultFixture(
      run, snapshot, specialistResultFixture(run, snapshot)
    )
  );
  const internal = repository as unknown as {
    state: { specialistResults: Map<string, unknown> }
  };
  const financeKey = `${run.workspaceId}\u0000${run.runId}`
    + "\u0000finance\u0000analyze";
  const profitKey = `${run.workspaceId}\u0000${run.runId}`
    + "\u0000profit\u0000analyze";
  const stored = internal.state.specialistResults.get(financeKey)!;
  internal.state.specialistResults.delete(financeKey);
  internal.state.specialistResults.set(profitKey, stored);

  for (const read of [
    () => repository.getSpecialistResult(
      workspace(), run.runId, "profit", "analyze"
    ),
    () => repository.listSpecialistResults(workspace(), run.runId)
  ]) {
    await assert.rejects(read(), (error: unknown) =>
      (error as { code?: unknown }).code === "financial_council_integrity");
  }
});
