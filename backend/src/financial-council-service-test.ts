import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FinancialCouncilService } from "./financial-council-service.js";
import {
  financialCouncilCanonicalHash,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import { InMemoryFinancialCouncilRepository } from
  "./financial-council-repository.js";
import { InMemoryFinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import { policyInput } from "./financial-council-policy-test-support.js";
import {
  repositoryRunFixture,
  snapshotFixture,
  storedPortfolioRevisionFixture,
  workspace
} from "./financial-council-repository-contract-test.js";
import { createDefaultFinancialCouncilPolicy } from
  "./financial-council-policy.js";
import type { CommandContext } from "./growth-command-context.js";
import type { FinancialCouncilCreateInput } from "./growth-contract-types.js";

const NOW = "2026-08-16T08:00:00.000Z";

function context(
  workspaceId = "ws-1",
  capabilities: readonly string[] = ["finance.council.run"]
) {
  return Object.freeze({
    ...workspace(workspaceId),
    role: "admin" as const,
    capabilities: Object.freeze([...capabilities])
  }) as CommandContext["workspace"];
}

function command(
  key = "create-key",
  requestHash = `sha256:${"b".repeat(64)}` as const,
  value = context()
): CommandContext {
  return Object.freeze({
    workspace: value,
    actorId: value.actorId,
    idempotencyKey: key,
    requestHash,
    expectedRevision: null
  });
}

function input(
  overrides: Partial<FinancialCouncilCreateInput> = {}
): FinancialCouncilCreateInput {
  const run = repositoryRunFixture();
  return {
    currency: run.currency,
    dataAsOf: run.dataAsOf,
    businessReport: run.businessReport,
    policyVersionId: "financial-council-policy.v1",
    ...overrides
  };
}

function frozenSnapshot(
  runId: string,
  workspaceId = "ws-1",
  policyVersionId = "financial-council-policy.v1"
) {
  return snapshotFixture(repositoryRunFixture({
    runId, workspaceId, policyVersionId
  })).snapshot;
}

function harness(options: {
  freezeError?: Error;
  wake?: { wake(run: FinancialCouncilRun): Promise<void> };
  onWakeError?: (error: unknown, run: FinancialCouncilRun) => void | Promise<void>;
} = {}) {
  const repository = new InMemoryFinancialCouncilRepository();
  const policyRepository = new InMemoryFinancialCouncilPolicyRepository();
  const wakes: FinancialCouncilRun[] = [];
  let freezeCalls = 0;
  let seenCommand: CommandContext | null = null;
  const service = new FinancialCouncilService({
    repository,
    policyRepository,
    snapshotBuilder: {
      async freeze(commandValue, runId, createInput) {
        freezeCalls += 1;
        seenCommand = commandValue;
        if (options.freezeError) throw options.freezeError;
        return frozenSnapshot(
          runId,
          commandValue.workspace.workspaceId,
          createInput.policyVersionId
        ) as never;
      }
    },
    advisoryWake: options.wake ?? {
      async wake(run) { wakes.push(run); }
    },
    onAdvisoryWakeError: options.onWakeError,
    now: () => NOW
  });
  return {
    repository, policyRepository, service, wakes,
    freezeCalls: () => freezeCalls,
    seenCommand: () => seenCommand
  };
}

test("policy service materializes one default and activates immutable versions",
  async () => {
    const fixture = harness();
    const authorized = context("ws-1", [
      "finance.council.run", "finance.council.policy.manage",
      "pricing.sensitive.read"
    ]);
    const first = await fixture.service.getPolicy(authorized);
    const same = await fixture.service.getPolicy(authorized);
    assert.deepEqual(same, first);
    assert.equal(first.policyVersionId, "financial-council-policy.v1");
    const updateCommand = Object.freeze({
      ...command("policy-update", `sha256:${"9".repeat(64)}`, authorized),
      expectedRevision: 1
    });
    const updated = await fixture.service.updatePolicy(
      updateCommand, policyInput() as never
    );
    const replay = await fixture.service.updatePolicy(
      updateCommand, policyInput() as never
    );
    assert.equal(updated.value.version, 2);
    assert.equal(updated.value.revision, 2);
    assert.equal(updated.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, updated.value);
    assert.deepEqual(await fixture.service.getPolicy(authorized), updated.value);
  });

test("policy service capability and old revision checks fail closed", async () => {
  const fixture = harness();
  await assert.rejects(
    fixture.service.getPolicy(context("ws-1", [])),
    (error: unknown) => (error as { code?: unknown }).code
      === "capability_forbidden"
  );
  await fixture.service.getPolicy(context());
  await assert.rejects(fixture.service.updatePolicy(
    Object.freeze({ ...command("no-manage"), expectedRevision: 1 }),
    policyInput() as never
  ), (error: unknown) => (error as { code?: unknown }).code
    === "capability_forbidden");
});

test("run creation binds an existing immutable workspace policy", async () => {
  const fixture = harness();
  await assert.rejects(fixture.service.createRun(
    command("missing-policy"), input({ policyVersionId: "missing-policy" })
  ), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_policy_not_found");
  assert.equal(fixture.freezeCalls(), 0);
});

test("committed create contains a synchronous advisory wake failure", async () => {
  const fixture = harness({
    wake: { wake() { throw new Error("sync wake failed"); } } as never
  });
  const result = await fixture.service.createRun(command(), input());
  assert.equal(result.value.status, "snapshot_frozen");
  assert.equal((await fixture.repository.listEvents(
    context(), result.value.runId
  )).length, 2);
});

test("committed create never waits for a non-settling advisory wake", async () => {
  let wakeCalled = false;
  const fixture = harness({
    wake: {
      wake() {
        wakeCalled = true;
        return new Promise<void>(() => undefined);
      }
    }
  });
  const result = await Promise.race([
    fixture.service.createRun(command(), input()).then((value) => ({
      kind: "created" as const, value
    })),
    new Promise<{ kind: "blocked" }>((resolve) => setImmediate(() => resolve({
      kind: "blocked"
    })))
  ]);
  assert.equal(result.kind, "created");
  assert.equal(wakeCalled, true);
  if (result.kind === "created") {
    assert.equal(result.value.value.status, "snapshot_frozen");
  }
});

test("advisory wake assimilates and contains an asynchronous observer", async () => {
  let assimilated = false;
  const observer = {
    then(_resolve: () => void, reject: (error: Error) => void) {
      assimilated = true;
      reject(new Error("observer failed"));
    }
  };
  const fixture = harness({
    wake: { async wake() { throw new Error("wake failed"); } },
    onWakeError: (() => observer) as never
  });
  await fixture.service.createRun(command(), input());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(assimilated, true);
});

test("create freezes atomically, exact replay is stable, and replay does not wake", async () => {
  const fixture = harness();
  const first = await fixture.service.createRun(command(), input());
  const replay = await fixture.service.createRun(command(), input());
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(first.value.status, "snapshot_frozen");
  assert.equal(first.value.revision, 2);
  assert.match(first.value.runId,
    /^financial-council:create:sha256:[0-9a-f]{64}$/u);
  assert.equal(fixture.wakes.length, 1);
  assert.equal(fixture.freezeCalls(), 1);
  const analysisIdentity = await fixture.repository.getAnalysisControl(
    context(), first.value.runId
  );
  assert.equal(analysisIdentity?.ownerId, context().actorId);
  assert.equal(analysisIdentity?.teamId, context().teamId);
  assert.deepEqual(
    (await fixture.repository.listEvents(context(), first.value.runId))
      .map((event) => event.revision),
    [1, 2]
  );
});

test("same physical idempotency key produces tenant-scoped public run IDs", async () => {
  const fixture = harness();
  const firstScope = context("ws-1");
  const secondScope = Object.freeze({
    ...context("ws-2"),
    actorId: "manager-2"
  }) as CommandContext["workspace"];
  const first = await fixture.service.createRun(
    command("shared-physical-key", undefined, firstScope),
    input()
  );
  const second = await fixture.service.createRun(
    command("shared-physical-key", undefined, secondScope),
    input()
  );

  const physicalHash = `sha256:${createHash("sha256")
    .update("shared-physical-key")
    .digest("hex")}`;
  const firstPreimage = JSON.stringify({
    idempotencyKeyHash: physicalHash,
    ownerId: "manager-1",
    teamId: "ws-1",
    workspaceId: "ws-1"
  });
  const firstScopedHash = `sha256:${createHash("sha256")
    .update(firstPreimage)
    .digest("hex")}`;

  assert.equal(
    first.value.runId,
    `financial-council:create:${firstScopedHash}`
  );
  assert.match(second.value.runId,
    /^financial-council:create:sha256:[0-9a-f]{64}$/u);
  assert.notEqual(second.value.runId, first.value.runId);
});

test("same creation key with a changed canonical request conflicts without wake", async () => {
  const fixture = harness();
  await fixture.service.createRun(command(), input());
  await assert.rejects(fixture.service.createRun(
    command("create-key", `sha256:${"c".repeat(64)}`),
    input({ policyVersionId: "policy-v2" })
  ), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_idempotency_conflict");
  assert.equal(fixture.wakes.length, 1);
  assert.equal(fixture.freezeCalls(), 1);
});

test("authorization and actor binding fail before snapshot or persistence", async () => {
  for (const invalid of [
    command("forbidden", undefined, context("ws-1", [])),
    { ...command(), actorId: "forged-actor" }
  ]) {
    const fixture = harness();
    await assert.rejects(
      fixture.service.createRun(invalid, input()),
      (error: unknown) => ["capability_forbidden", "financial_council_context_invalid"]
        .includes(String((error as { code?: unknown }).code))
    );
    assert.equal(fixture.freezeCalls(), 0);
    assert.deepEqual(await fixture.repository.listRunnableRuns({
      after: null, limit: 10
    }), []);
  }
});

test("snapshot failure leaves no visible run, snapshot, event, or wake", async () => {
  const fixture = harness({ freezeError: new Error("snapshot failed") });
  await assert.rejects(fixture.service.createRun(command(), input()),
    /snapshot failed/u);
  assert.equal(fixture.wakes.length, 0);
  assert.deepEqual(await fixture.repository.listRunnableRuns({
    after: null, limit: 10
  }), []);
});

test("authenticated capabilities reach the sensitive snapshot projection unchanged", async () => {
  const fixture = harness();
  const sensitive = context("ws-1", [
    "finance.council.run", "pricing.sensitive.read"
  ]);
  await fixture.service.createRun(command("sensitive", undefined, sensitive), input());
  assert.equal(fixture.seenCommand()?.workspace, sensitive);
});

test("run reads are tenant scoped and missing runs use one non-leaking code", async () => {
  const fixture = harness();
  const created = await fixture.service.createRun(command(), input());
  assert.equal((await fixture.service.getRun(
    context(), created.value.runId
  )).runId, created.value.runId);
  for (const requested of [context("ws-2"), context()]) {
    const runId = requested.workspaceId === "ws-2"
      ? created.value.runId : "missing-run";
    await assert.rejects(fixture.service.getRun(requested, runId),
      (error: unknown) => (error as { code?: unknown }).code
        === "financial_council_run_not_found");
  }
});

test("public service rejects the migration-only created state", async () => {
  const fixture = harness();
  const internal = repositoryRunFixture();
  await fixture.repository.createRun(command("migration-create"), internal);
  await assert.rejects(
    fixture.service.getRun(context(), internal.runId),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_integrity"
  );
  await assert.rejects(
    fixture.service.listEvents(context(), internal.runId),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_integrity"
  );
});

test("portfolio revision service has one concurrent base-revision winner and exact replay", async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const policyRepository = new InMemoryFinancialCouncilPolicyRepository();
  const { lease, revision: first, run } =
    await storedPortfolioRevisionFixture(repository, {
      policyVersionId: "financial-council-policy.v1"
    });
  const published = await repository.publishPortfolioRevisionWithLease(lease, {
    revision: 1,
    expectedOutputHash: first.outputHash,
    occurredAt: "2026-08-16T08:07:00.000Z"
  });
  const policy = createDefaultFinancialCouncilPolicy(run.workspaceId,
    "2026-08-16T08:00:00.000Z");
  await policyRepository.getOrCreateActive(workspace(), policy);
  const service = new FinancialCouncilService({
    repository,
    policyRepository,
    snapshotBuilder: { async freeze() { throw new Error("unused"); } },
    now: () => "2026-08-16T08:08:00.000Z"
  });
  const authorized = context();
  const edit = (key: string, hashCharacter: string) => Object.freeze({
    workspace: authorized,
    actorId: authorized.actorId,
    idempotencyKey: key,
    requestHash: `sha256:${hashCharacter.repeat(64)}`,
    expectedRevision: published.value.revision
  }) as CommandContext;
  const input = {
    runId: run.runId,
    baseRevision: 1,
    operations: [{ kind: "select_portfolio" as const,
      portfolioKind: "balanced" as const }]
  };

  const results = await Promise.allSettled([
    service.revisePortfolio(edit("winner-a", "3"), input),
    service.revisePortfolio(edit("winner-b", "4"), input)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length,
    1);
  assert.equal(results.filter((result) => result.status === "rejected").length,
    1);
  const winner = results.find((result) => result.status === "fulfilled")!;
  const winnerCommand = winner === results[0]
    ? edit("winner-a", "3") : edit("winner-b", "4");
  const replay = await service.revisePortfolio(winnerCommand, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.revision, 2);
});
