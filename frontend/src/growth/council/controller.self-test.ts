import { strict as assert } from "node:assert";
import {
  createFinancialCouncilController
} from "./controller";
import type { FinancialCouncilApi } from "./api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function run(runId: string, status = "analyzing", revision = 2) {
  return Object.freeze({
    runId,
    workspaceId: "workspace-1",
    currency: "CNY",
    status,
    revision,
    dataAsOf: "2026-08-16T08:00:00.000Z",
    businessReport: {},
    policyVersionId: "policy-1",
    snapshotId: "snapshot-1",
    snapshotHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    consensusReport: null,
    portfolios: [],
    latestPortfolioRevision: revision,
    approval: null,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:00:00.000Z",
    expiresAt: "2026-08-16T09:00:00.000Z"
  });
}

const emptyPage = Object.freeze({ items: [], nextAfter: null, hasMore: false });
const policy = Object.freeze({ policyVersionId: "policy-1", revision: 1 });

class ManualScheduler {
  readonly callbacks: Array<() => void> = [];
  schedule = (callback: () => void) => {
    this.callbacks.push(callback);
    return callback;
  };
  cancel = (handle: unknown) => {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  };
}

// This catches an implementation that commits an old GET after a replacement
// run has become active.
{
  const oldRead = deferred<never>();
  const api: FinancialCouncilApi = {
    async getRun(runId: string) {
      if (runId === "old") return oldRead.promise;
      return { status: 200, etag: '"run:new:2"', body: run("new") } as never;
    },
    async listEvents() { return { status: 200, etag: null, body: emptyPage } as never; },
    async listDispatches() { return { status: 200, etag: null, body: emptyPage } as never; },
    async getPolicy() { return { status: 200, etag: '"policy:1"', body: policy } as never; }
  } as unknown as FinancialCouncilApi;
  const controller = createFinancialCouncilController({ api });
  const openingOld = controller.open("old");
  await controller.open("new");
  oldRead.resolve({ status: 200, etag: '"run:old:2"', body: run("old") } as never);
  await openingOld;
  assert.equal(controller.getState().run?.runId, "new");
  controller.destroy();
}

// This catches an implementation that allocates a new idempotency key after a
// failed revision request, creating duplicate server-side edits on retry.
{
  const revisionKeys: string[] = [];
  let attempts = 0;
  let currentRevision = 2;
  const api: FinancialCouncilApi = {
    async getRun() {
      return {
        status: 200,
        etag: `"run:${currentRevision}"`,
        body: run("run-1", currentRevision === 2 ? "analyzing" : "awaiting_approval", currentRevision)
      } as never;
    },
    async listEvents() { return { status: 200, etag: null, body: emptyPage } as never; },
    async listDispatches() { return { status: 200, etag: null, body: emptyPage } as never; },
    async getPolicy() { return { status: 200, etag: '"policy:1"', body: policy } as never; },
    async revisePortfolio(_runId: string, _input: unknown, _etag: string, key: string) {
      revisionKeys.push(key);
      attempts += 1;
      if (attempts === 1) throw new Error("network dropped after write");
      currentRevision = 3;
      return {
        status: 200,
        etag: '"run:3"',
        body: {
          runId: "run-1", revision: 3, baseRevision: 2,
          portfolios: [], createdAt: "2026-08-16T08:00:00.000Z"
        }
      } as never;
    }
  } as unknown as FinancialCouncilApi;
  const controller = createFinancialCouncilController({ api, idFactory: () => "stable-key" });
  await controller.open("run-1");
  await controller.revise({
    baseRevision: 2,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  } as never);
  assert.equal(controller.getState().busy, null);
  await controller.revise({
    baseRevision: 2,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  } as never);
  assert.deepEqual(revisionKeys, ["council-revise:stable-key", "council-revise:stable-key"]);
  assert.equal(controller.getState().run?.revision, 3);
  controller.destroy();
}

// This catches terminal run polling continuing after approval, and a late poll
// re-populating state after teardown.
{
  const scheduler = new ManualScheduler();
  const lateRead = deferred<never>();
  let reads = 0;
  const api: FinancialCouncilApi = {
    async getRun() {
      reads += 1;
      if (reads === 1) return { status: 200, etag: '"run:1"', body: run("run-1") } as never;
      return lateRead.promise;
    },
    async listEvents() { return { status: 200, etag: null, body: emptyPage } as never; },
    async listDispatches() { return { status: 200, etag: null, body: emptyPage } as never; },
    async getPolicy() { return { status: 200, etag: '"policy:1"', body: policy } as never; }
  } as unknown as FinancialCouncilApi;
  const controller = createFinancialCouncilController({
    api,
    pollIntervalMs: 1,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });
  await controller.open("run-1");
  assert.equal(scheduler.callbacks.length, 1);
  scheduler.callbacks.shift()?.();
  controller.destroy();
  lateRead.resolve({ status: 200, etag: '"run:2"', body: run("run-1", "approved", 3) } as never);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState().run, null);
  assert.equal(scheduler.callbacks.length, 0);
}

// This catches a same-run poll from before a revision overwriting the newer
// server projection after its request resolves late.
{
  const scheduler = new ManualScheduler();
  const stalePoll = deferred<never>();
  let reads = 0;
  const api: FinancialCouncilApi = {
    async getRun() {
      reads += 1;
      if (reads === 1) {
        return { status: 200, etag: '"run:2"', body: run("run-1", "awaiting_approval", 2) } as never;
      }
      if (reads === 2) return stalePoll.promise;
      return { status: 200, etag: '"run:3"', body: run("run-1", "awaiting_approval", 3) } as never;
    },
    async listEvents() { return { status: 200, etag: null, body: emptyPage } as never; },
    async listDispatches() { return { status: 200, etag: null, body: emptyPage } as never; },
    async getPolicy() { return { status: 200, etag: '"policy:1"', body: policy } as never; },
    async revisePortfolio() {
      return {
        status: 200,
        etag: '"run:3"',
        body: {
          runId: "run-1", revision: 3, baseRevision: 2,
          portfolios: [], createdAt: "2026-08-16T08:00:00.000Z"
        }
      } as never;
    }
  } as unknown as FinancialCouncilApi;
  const controller = createFinancialCouncilController({
    api,
    pollIntervalMs: 1,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });
  await controller.open("run-1");
  scheduler.callbacks.shift()?.();
  await controller.revise({
    baseRevision: 2,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  } as never);
  assert.equal(controller.getState().run?.revision, 3);
  stalePoll.resolve({ status: 200, etag: '"run:2"', body: run("run-1", "awaiting_approval", 2) } as never);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.getState().run?.revision, 3);
  controller.destroy();
}

// This catches a controller that reconstructs an ETag instead of forwarding
// the opaque concurrency token received from the server.
{
  let receivedEtag: string | null = null;
  const api: FinancialCouncilApi = {
    async getRun() {
      return { status: 200, etag: '"opaque-server-etag"', body: run("run-1", "awaiting_approval", 2) } as never;
    },
    async listEvents() { return { status: 200, etag: null, body: emptyPage } as never; },
    async listDispatches() { return { status: 200, etag: null, body: emptyPage } as never; },
    async getPolicy() { return { status: 200, etag: '"opaque-policy-etag"', body: policy } as never; },
    async revisePortfolio(_runId: string, _input: unknown, etag: string) {
      receivedEtag = etag;
      return {
        status: 200, etag: '"opaque-next-etag"', body: {
          runId: "run-1", revision: 3, baseRevision: 2,
          portfolios: [], createdAt: "2026-08-16T08:00:00.000Z"
        }
      } as never;
    }
  } as unknown as FinancialCouncilApi;
  const controller = createFinancialCouncilController({ api });
  await controller.open("run-1");
  await controller.revise({
    baseRevision: 2,
    operations: [{ kind: "select_portfolio", portfolioKind: "balanced" }]
  } as never);
  assert.equal(receivedEtag, '"opaque-server-etag"');
  controller.destroy();
}
