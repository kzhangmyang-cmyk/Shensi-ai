import { strict as assert } from "node:assert";
import { createSessionCoordinator, type VisualReaderPersistedState } from "./session-coordinator";
import { createReliableEventTransport } from "./runtime-transport";
import { BRIDGE_VERSION, type ExtensionEvent } from "./protocol";

const limits = {
  maxVideos: 1,
  maxCommentsPerVideo: 30,
  maxScrolls: 5,
  maxOcrCalls: 0,
  maxDurationMs: 120_000
};

{
  const writes: VisualReaderPersistedState[] = [];
  const coordinator = createSessionCoordinator({
    persist: async (state) => { writes.push(structuredClone(state)); },
    log: () => undefined,
    nonceHash: async () => `sha256:${"1".repeat(64)}`
  });
  await coordinator.authorizeFromGoodJob({
    goodJobTabId: 10,
    channelNonce: "a".repeat(64),
    sessionId: "session-replay",
    limits: { ...limits, maxOcrCalls: 10 },
    artifactUploadEnabled: false
  });
  assert.equal(await coordinator.confirmDouyinTab(20, 7, "https://www.douyin.com/video/123"), true);
  await coordinator.updateUsage({ ocrCallCount: 1 });
  assert.equal(coordinator.snapshot().usage.ocrCallCount, 1,
    "a successful local OCR call consumes the authorized session budget");
  assert.equal(coordinator.receiveBatch("batch-stable"), "new");
  assert.equal(coordinator.receiveBatch("batch-stable"), "replay");
  assert.equal(coordinator.receiveBatch("batch-other"), "blocked");
  assert.equal(coordinator.canAcknowledgeBatch("session-replay", "batch-stable"), true);
  assert.equal(coordinator.canAcknowledgeBatch("session-replay", "wrong"), false);
  assert.equal(coordinator.commitAcknowledgedBatch("session-replay", "wrong"), false);
  assert.equal(coordinator.snapshot().pendingBatchId, "batch-stable");
  assert.equal(coordinator.commitAcknowledgedBatch("session-replay", "batch-stable"), true);
  assert.equal(coordinator.snapshot().pendingBatchId, null);
  assert.ok(writes.every((state) => !("pendingBatchId" in state)));

  assert.equal(coordinator.receiveBatch("batch-before-terminal"), "new");
  await coordinator.finish("partial_success");
  assert.equal(coordinator.snapshot().pendingBatchId, null, "terminal abandons pending ACK without interlock");
}

{
  const stored: VisualReaderPersistedState[] = [];
  let deferred = false;
  const pending: Array<{ state: VisualReaderPersistedState; release: () => void }> = [];
  const coordinator = createSessionCoordinator({
    persist: async (state) => {
      const snapshot = structuredClone(state);
      if (deferred) {
        await new Promise<void>((resolve) => pending.push({ state: snapshot, release: resolve }));
      }
      stored.push(snapshot);
    },
    log: () => undefined,
    nonceHash: async () => `sha256:${"2".repeat(64)}`
  });
  await coordinator.authorizeFromGoodJob({
    goodJobTabId: 10,
    channelNonce: "f".repeat(64),
    sessionId: "session-mutation-fifo",
    limits: { ...limits, maxOcrCalls: 2 },
    artifactUploadEnabled: true
  });
  assert.equal(await coordinator.confirmDouyinTab(20, 7, "https://www.douyin.com/video/123"), true);
  deferred = true;

  const usage = coordinator.updateUsage({ ocrCallCount: 1 });
  while (pending.length < 1) await Promise.resolve();
  const abort = coordinator.abort("user_requested");
  await Promise.resolve();
  assert.equal(pending.length, 1,
    "a terminal mutation cannot start persistence while an older usage mutation is pending");
  let drained = false;
  const drain = coordinator.whenMutationsSettled().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, "replacement settlement waits for the complete coordinator mutation queue");

  pending[0].release();
  while (pending.length < 2) await Promise.resolve();
  pending[1].release();
  await Promise.all([usage, abort, drain]);
  assert.equal(stored.at(-1)?.sessionId, "session-mutation-fifo");
  assert.equal(stored.at(-1)?.status, "aborted",
    "an older deferred persistence cannot overwrite the terminal coordinator state");
}

class ManualRetries {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();
  schedule = (callback: () => void): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  cancel = (handle: unknown): void => {
    if (typeof handle === "number") this.callbacks.delete(handle);
  };
  runNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("missing retry");
    this.callbacks.delete(next[0]);
    next[1]();
  }
  pending(): number { return this.callbacks.size; }
}

class ManualClock {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  schedule = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  pending(): number { return this.timers.size; }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

{
  const retries = new ManualRetries();
  const attempts: ExtensionEvent[] = [];
  const terminal: ExtensionEvent = {
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "b".repeat(64),
    sessionId: "session-terminal",
    status: "aborted",
    errorCodes: ["visual_reader_user_takeover"]
  };
  const transport = createReliableEventTransport({
    maxTerminalAttempts: 3,
    retryDelayMs: 10,
    scheduleTimeout: retries.schedule,
    cancelTimeout: retries.cancel,
    send: async (event) => {
      attempts.push(structuredClone(event));
      if (attempts.length === 1) return { accepted: false };
      if (attempts.length === 2) throw new Error("service worker restarted");
      return { accepted: true };
    }
  });
  transport.queueTerminal(terminal);
  await flush();
  retries.runNext();
  await flush();
  retries.runNext();
  await flush();
  await transport.whenIdle();
  assert.deepEqual(attempts, [terminal, terminal, terminal]);
  assert.equal(retries.pending(), 0);
  transport.close();
}

{
  const retries = new ManualRetries();
  let attempts = 0;
  const transport = createReliableEventTransport({
    maxTerminalAttempts: 2,
    attemptTimeoutMs: 5,
    retryDelayMs: 5,
    scheduleTimeout: retries.schedule,
    cancelTimeout: retries.cancel,
    send: async () => {
      attempts += 1;
      return new Promise(() => undefined);
    }
  });
  transport.queueTerminal({
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "c".repeat(64),
    sessionId: "session-hung-terminal",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });
  await flush();
  retries.runNext();
  await flush();
  retries.runNext();
  await flush();
  retries.runNext();
  await flush();
  await transport.whenIdle();
  assert.equal(attempts, 2, "a hung runtime send is bounded and retried exactly");
  assert.equal(retries.pending(), 0);
}

{
  const clock = new ManualClock();
  let attempts = 0;
  const transport = createReliableEventTransport({
    deadlineAt: 20,
    now: () => clock.now,
    retryDelayMs: 10,
    maxTerminalAttempts: 5,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    send: async () => {
      attempts += 1;
      return { accepted: false };
    }
  });
  transport.queueTerminal({
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "d".repeat(64),
    sessionId: "session-terminal-deadline",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });
  await flush();
  clock.advance(10);
  await flush();
  clock.advance(10);
  await flush();
  assert.equal(attempts, 2, "terminal retry shares the session absolute deadline and never sends after it");
  await transport.whenIdle();
  assert.equal(clock.pending(), 0, "deadline cleanup cancels every terminal retry timer");
}

{
  const clock = new ManualClock();
  clock.now = 80;
  let attempts = 0;
  const transport = createReliableEventTransport({
    deadlineAt: 100,
    now: () => clock.now,
    retryDelayMs: 10,
    attemptTimeoutMs: 50,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    send: async () => {
      attempts += 1;
      return new Promise<{ accepted: boolean }>(() => undefined);
    }
  });
  transport.queueTerminal({
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "e".repeat(64),
    sessionId: "session-terminal-reserve-hang",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });
  await flush();
  assert.equal(attempts, 1, "terminal delivery starts immediately inside the reserved finalization window");
  clock.advance(20);
  await flush();
  await transport.whenIdle();
  assert.equal(attempts, 1, "a hung first terminal attempt cannot outlive the total session deadline");
  assert.equal(clock.pending(), 0, "a hung reserved terminal attempt clears every timer at the session deadline");
}

{
  const clock = new ManualClock();
  let attempts = 0;
  const transport = createReliableEventTransport({
    deadlineAt: 1,
    now: () => clock.now,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    send: () => {
      attempts += 1;
      clock.advance(1);
      return new Promise<{ accepted: boolean }>(() => undefined);
    }
  });
  transport.queueTerminal({
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "9".repeat(64),
    sessionId: "session-terminal-send-consumes-deadline",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  }, { deadlineCheckedAt: 0 });
  await flush();
  assert.equal(attempts, 1, "the eligible first send starts synchronously");
  assert.equal(clock.pending(), 0,
    "a send that consumes the remaining deadline cannot schedule a timeout beyond it");
  await transport.whenIdle();
  transport.close();
}

{
  const clock = new ManualClock();
  clock.now = 80;
  let attempts = 0;
  const transport = createReliableEventTransport({
    deadlineAt: 100,
    now: () => clock.now,
    retryDelayMs: 10,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    send: async () => {
      attempts += 1;
      return { accepted: false };
    }
  });
  transport.queueTerminal({
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "f".repeat(64),
    sessionId: "session-terminal-reserve-retry",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });
  await flush();
  clock.advance(10);
  await flush();
  clock.advance(10);
  await flush();
  await transport.whenIdle();
  assert.equal(attempts, 2, "a rejected terminal retries only inside the remaining session deadline");
  assert.equal(clock.pending(), 0, "a rejected reserved terminal leaves no retry timer after the total deadline");
}

console.log("douyin service reliability self-test passed");
