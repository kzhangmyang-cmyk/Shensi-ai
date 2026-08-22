import assert from "node:assert/strict";
import test from "node:test";
import type express from "express";
import {
  FinancialCouncilWakeRelay,
  GROWTH_FINANCIAL_COUNCIL_SERVICES,
  createGrowthFinancialCouncilResources,
  createGrowthFinancialCouncilModule
} from "./growth-financial-council-module.js";
import { createGrowthPrivateServiceRegistry } from
  "./growth-commercial-private-services.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { GROWTH_ADVISOR_SERVICES } from "./growth-advisor-module.js";
import { GROWTH_FINANCE_SERVICES } from "./growth-finance-module.js";
import { repositoryRunFixture } from
  "./financial-council-repository-contract-test.js";
import { FinancialCouncilService } from "./financial-council-service.js";
import { RepositoryVerifiedFinancialLedgerSealedReader } from
  "./financial-ledger-as-of-reader.js";
import { policyWorkspace } from "./financial-council-policy-test-support.js";

class FakeDeadlineClock {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();
  readonly schedule = (callback: () => void, _milliseconds: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  readonly cancel = (id: unknown): void => {
    this.callbacks.delete(id as number);
  };
  get pending() { return this.callbacks.size; }
  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function frozenRun() {
  return Object.freeze({
    ...repositoryRunFixture(),
    status: "snapshot_frozen" as const,
    revision: 2,
    snapshotId: "snapshot-1",
    snapshotHash: `sha256:${"d".repeat(64)}` as const
  });
}

test("wake relay isolates delivery failure and retries the durable runnable fact", async () => {
  const run = frozenRun();
  let attempts = 0;
  const errors: unknown[] = [];
  const relay = new FinancialCouncilWakeRelay({
    repository: {
      async listRunnableRuns() { return [run]; }
    },
    sink: {
      async wake() {
        attempts += 1;
        if (attempts === 1) throw new Error("wake unavailable");
      }
    },
    onError(error) { errors.push(error); },
    intervalMs: 60_000,
    batchSize: 10
  });
  await relay.sweep();
  await relay.sweep();
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  await relay.close();
});

test("wake relay contains synchronous sink failures", async () => {
  const errors: unknown[] = [];
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return [frozenRun()]; } },
    sink: { wake() { throw new Error("sync sink failed"); } } as never,
    onError(error) { errors.push(error); },
    intervalMs: 60_000,
    batchSize: 10
  });
  await assert.doesNotReject(relay.sweep());
  assert.equal(errors.length, 1);
  await relay.close();
});

test("wake relay assimilates and contains asynchronous observers", async () => {
  let assimilated = false;
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { throw new Error("read failed"); } },
    sink: { async wake() {} },
    onError: (() => ({
      then(_resolve: () => void, reject: (error: Error) => void) {
        assimilated = true;
        reject(new Error("observer failed"));
      }
    })) as never,
    intervalMs: 60_000,
    batchSize: 10
  });
  await relay.sweep();
  await Promise.resolve();
  assert.equal(assimilated, true);
  await relay.close();
});

test("wake relay contains observer failures without an unhandled rejection", async () => {
  const relay = new FinancialCouncilWakeRelay({
    repository: {
      async listRunnableRuns() { throw new Error("repository unavailable"); }
    },
    sink: { async wake() {} },
    onError() { throw new Error("observer failed"); },
    intervalMs: 60_000,
    batchSize: 10
  });
  await assert.doesNotReject(relay.sweep());
  await relay.close();
});

test("wake relay close clears scheduling and awaits the active delivery", async () => {
  const run = frozenRun();
  let deliveries = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return [run]; } },
    sink: {
      async wake() {
        deliveries += 1;
        began();
        await blocked;
      }
    },
    intervalMs: 5,
    batchSize: 10
  });
  relay.start();
  await started;
  let closed = false;
  const closing = relay.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(deliveries, 1);
});

test("wake relay deadlines a non-settling sink and continues the page", async () => {
  const clock = new FakeDeadlineClock();
  const runs = [frozenRun(), Object.freeze({
    ...frozenRun(), runId: "council-run-2"
  })];
  const delivered: string[] = [];
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return runs; } },
    sink: {
      wake(run) {
        delivered.push(run.runId);
        if (run.runId === "council-run-1") {
          began();
          return new Promise<void>(() => undefined);
        }
        return Promise.resolve();
      }
    },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  const sweeping = relay.sweep();
  await started;
  assert.equal(clock.pending, 1);
  clock.fireAll();
  await sweeping;
  assert.deepEqual(delivered, ["council-run-1", "council-run-2"]);
  await relay.close();
});

test("wake relay deadlines a non-settling observer and close completes", async () => {
  const clock = new FakeDeadlineClock();
  let observed = 0;
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return [frozenRun()]; } },
    sink: { async wake() { throw new Error("delivery failed"); } },
    onError() {
      observed += 1;
      return new Promise<void>(() => undefined);
    },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  const sweeping = relay.sweep();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed, 1);
  assert.equal(clock.pending, 1);
  const closing = relay.close();
  clock.fireAll();
  await Promise.all([sweeping, closing]);
});

test("wake relay close completes after a non-settling sink deadline", async () => {
  const clock = new FakeDeadlineClock();
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return [frozenRun()]; } },
    sink: {
      wake() {
        began();
        return new Promise<void>(() => undefined);
      }
    },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  relay.start();
  await started;
  const closing = relay.close();
  assert.equal(clock.pending, 1);
  clock.fireAll();
  await closing;
  assert.equal((relay as unknown as { timer: unknown }).timer, null);
});

test("wake relay contains a delivery rejection that arrives after timeout", async () => {
  const clock = new FakeDeadlineClock();
  let rejectLate!: (error: Error) => void;
  const late = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const relay = new FinancialCouncilWakeRelay({
    repository: { async listRunnableRuns() { return [frozenRun()]; } },
    sink: { wake() { began(); return late; } },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  try {
    const sweeping = relay.sweep();
    await started;
    assert.equal(clock.pending, 1);
    clock.fireAll();
    await sweeping;
    rejectLate(new Error("late delivery rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await relay.close();
  }
});

test("wake relay deadlines non-settling runnable enumeration so close completes", async () => {
  const clock = new FakeDeadlineClock();
  let began!: () => void;
  let release!: (runs: readonly ReturnType<typeof frozenRun>[]) => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const relay = new FinancialCouncilWakeRelay({
    repository: {
      listRunnableRuns() {
        began();
        return new Promise<readonly ReturnType<typeof frozenRun>[]>(
          (resolve) => { release = resolve; }
        );
      }
    },
    sink: { async wake() {} },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  const sweeping = relay.sweep();
  await started;
  const closing = relay.close();
  const scheduledDeadlines = clock.pending;
  if (scheduledDeadlines === 0) release([]);
  else clock.fireAll();
  await Promise.all([sweeping, closing]);
  assert.equal(scheduledDeadlines, 1);
});

test("wake relay contains runnable enumeration rejection after its deadline", async () => {
  const clock = new FakeDeadlineClock();
  let rejectLate!: (error: Error) => void;
  const late = new Promise<readonly ReturnType<typeof frozenRun>[]>(
    (_resolve, reject) => { rejectLate = reject; }
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const relay = new FinancialCouncilWakeRelay({
    repository: { listRunnableRuns() { return late; } },
    sink: { async wake() {} },
    deliveryTimeoutMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    intervalMs: 60_000,
    batchSize: 10
  } as never);
  try {
    const sweeping = relay.sweep();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const scheduledDeadlines = clock.pending;
    if (scheduledDeadlines === 0) rejectLate(new Error("cleanup rejection"));
    else clock.fireAll();
    await sweeping;
    if (scheduledDeadlines > 0) {
      rejectLate(new Error("late enumeration rejection"));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scheduledDeadlines, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await relay.close();
  }
});

test("wake relay advances a composite cursor so persistent first-page facts do not starve", async () => {
  const runs = [frozenRun(), Object.freeze({
    ...frozenRun(), workspaceId: "ws-2", runId: "council-run-2"
  })];
  const cursors: unknown[] = [];
  const delivered: string[] = [];
  const relay = new FinancialCouncilWakeRelay({
    repository: {
      async listRunnableRuns(input) {
        cursors.push(input.after);
        return input.after === null ? [runs[0]!] : [runs[1]!];
      }
    },
    sink: { async wake(run) { delivered.push(run.runId); } },
    intervalMs: 60_000,
    batchSize: 1
  });
  await relay.sweep();
  await relay.sweep();
  assert.deepEqual(delivered, ["council-run-1", "council-run-2"]);
  assert.deepEqual(cursors, [null, {
    workspaceId: "ws-1", runId: "council-run-1"
  }]);
  await relay.close();
});

async function moduleFixture() {
  const registry = createGrowthPrivateServiceRegistry();
  const foundation = {
    workspaceContext: (() => { throw new Error("unused"); }) as never,
    commandContextFactory: (() => { throw new Error("unused"); }) as never,
    httpIdempotency: {} as never
  } as never;
  registry.provide(GROWTH_FOUNDATION_SERVICES, foundation);
  const events: string[] = [];
  const today = Object.freeze({
    async getToday() { throw new Error("unused"); },
    async getTodayAt() { throw new Error("unused"); },
    async sealTodayCutoff() { throw new Error("unused"); }
  });
  registry.provide(GROWTH_ADVISOR_SERVICES, Object.freeze({
    today, recommendations: {}, dispatcher: {}
  }) as never);
  const verifiedAsOf = new RepositoryVerifiedFinancialLedgerSealedReader(
    {} as never
  );
  const finance = Object.freeze({
    costLedger: {}, financialFacts: {}, imports: {}, verifiedAsOf,
    financialGaps: {}
  }) as never;
  registry.provide(GROWTH_FINANCE_SERVICES, finance);
  const resources = await createGrowthFinancialCouncilResources({
    mode: "memory",
    foundation,
    advisor: { today },
    finance,
    wakeSink: { async wake() {} },
    relayIntervalMs: 60_000,
    relayBatchSize: 10
  });
  let mounts = 0;
  const router = ({
    use() { mounts += 1; events.push("route:mount"); }
  } as unknown as express.Router);
  const module = createGrowthFinancialCouncilModule({
    async initializeSchema() { events.push("schema"); },
    async createResources() { events.push("resources:create"); return resources; }
  });
  return { registry, events, resources, router, module, mounts: () => mounts };
}

test("constructed resources own a workspace policy repository", async () => {
  const fixture = await moduleFixture();
  const policy = await fixture.resources.service.getPolicy(policyWorkspace());
  assert.equal(policy.policyVersionId, "financial-council-policy.v1");
  await fixture.resources.relay.close();
  await fixture.resources.closeFinancialCouncilResources();
});

test("module rejects untrusted service, relay, and close resources before mount", async () => {
  for (const kind of ["service", "relay", "close"] as const) {
    const fixture = await moduleFixture();
    let starts = 0;
    const invalid = Object.freeze({
      ...fixture.resources,
      ...(kind === "service" ? { service: {} } : {}),
      ...(kind === "relay" ? { relay: {
        start() { starts += 1; }, async sweep() {}, async close() {}
      } } : {}),
      ...(kind === "close" ? { closeFinancialCouncilResources: "close" } : {})
    }) as never;
    const module = createGrowthFinancialCouncilModule({
      async initializeSchema() {},
      async createResources() { return invalid; }
    });
    await assert.rejects(module.install({
      router: fixture.router,
      toolPorts: {} as never,
      privateServices: fixture.registry
    }), /INVALID_GROWTH_FINANCIAL_COUNCIL_RESOURCES/u);
    assert.equal(fixture.mounts(), 0, kind);
    assert.equal(starts, 0, kind);
  }
});

test("module rejects recomposed resources even when children are trusted", async () => {
  const fixture = await moduleFixture();
  const recomposed = Object.freeze({ ...fixture.resources });
  const module = createGrowthFinancialCouncilModule({
    async initializeSchema() {},
    async createResources() { return recomposed; }
  });
  const [installation] = await Promise.allSettled([module.install({
    router: fixture.router,
    toolPorts: {} as never,
    privateServices: fixture.registry
  })]);
  if (installation.status === "fulfilled") await installation.value.close();
  assert.equal(installation.status, "rejected");
  assert.equal(fixture.mounts(), 0);
  assert.equal(fixture.events.includes("relay:start"), false);
});

test("trusted instance brands require complete constructor dependencies", () => {
  assert.throws(
    () => new FinancialCouncilService({} as never),
    /invalid_financial_council_service/u
  );
  assert.throws(
    () => new FinancialCouncilWakeRelay({} as never),
    /invalid_financial_council_relay/u
  );
});

test("module rejects unowned upstream lookalikes before resource creation", async () => {
  for (const kind of ["advisor", "finance"] as const) {
    const registry = createGrowthPrivateServiceRegistry();
    registry.provide(GROWTH_FOUNDATION_SERVICES, {
      workspaceContext() {}, commandContextFactory() {}, httpIdempotency: {}
    } as never);
    const today = {
      async getToday() {}, async getTodayAt() {}, async sealTodayCutoff() {}
    };
    registry.provide(GROWTH_ADVISOR_SERVICES, Object.freeze({
      today: kind === "advisor" ? today : Object.freeze(today),
      recommendations: {}, dispatcher: {}
    }) as never);
    registry.provide(GROWTH_FINANCE_SERVICES, Object.freeze({
      costLedger: {}, financialFacts: {}, imports: {}, financialGaps: {},
      verifiedAsOf: kind === "finance" ? {
        async listWorkspaceVerifiedFactsAt() { return []; }
      } : new RepositoryVerifiedFinancialLedgerSealedReader({} as never)
    }) as never);
    let created = 0;
    const module = createGrowthFinancialCouncilModule({
      async initializeSchema() {},
      async createResources() {
        created += 1;
        return (await moduleFixture()).resources;
      }
    });
    await assert.rejects(module.install({
      router: { use() {} } as never,
      toolPorts: {} as never,
      privateServices: registry
    }), /INVALID_GROWTH_(ADVISOR|FINANCE)/u);
    assert.equal(created, 0, kind);
  }
});

test("financial council module initializes schema before routes and closes once", async () => {
  const fixture = await moduleFixture();
  const handle = await fixture.module.install({
    router: fixture.router,
    toolPorts: {} as never,
    privateServices: fixture.registry
  });
  assert.deepEqual(fixture.events, [
    "schema", "resources:create", "route:mount", "route:mount"
  ]);
  assert.equal(fixture.mounts(), 2);
  assert.equal(
    fixture.registry.require(GROWTH_FINANCIAL_COUNCIL_SERVICES).service,
    fixture.resources.service
  );
  await handle.close();
  await handle.close();
  assert.equal((fixture.resources.relay as unknown as { closed: boolean }).closed,
    true);
  assert.equal((fixture.resources.relay as unknown as { timer: unknown }).timer,
    null);
});

test("module construction failure mounts no routes and closes created resources", async () => {
  const fixture = await moduleFixture();
  const module = createGrowthFinancialCouncilModule({
    async initializeSchema() { fixture.events.push("schema"); },
    async createResources() {
      fixture.events.push("resources:create");
      return fixture.resources;
    },
    createRouter() { throw new Error("router failed"); }
  });
  await assert.rejects(module.install({
    router: fixture.router,
    toolPorts: {} as never,
    privateServices: fixture.registry
  }), /router failed/u);
  assert.equal(fixture.mounts(), 0);
  assert.deepEqual(fixture.events, ["schema", "resources:create"]);
  assert.equal((fixture.resources.relay as unknown as { closed: boolean }).closed,
    true);
});
