import { strict as assert } from "node:assert";
import * as readerModule from "./douyin-reader";
import { createBoundedReader } from "./douyin-reader";
import { BRIDGE_VERSION, type ExtensionEvent } from "./protocol";
import { createReliableEventTransport } from "./runtime-transport";

class ManualScheduler {
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
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  pending(): number { return this.timers.size; }
}

const limits = {
  maxVideos: 1,
  maxCommentsPerVideo: 30,
  maxScrolls: 5,
  maxOcrCalls: 0,
  maxDurationMs: 100
};

const deadlinePlanner = readerModule as typeof readerModule & {
  deriveVisualReaderDeadlines?: (startedAt: number, maxDurationMs: number) => {
    sessionDeadlineAt: number;
    workDeadlineAt: number;
  };
};
assert.equal(typeof deadlinePlanner.deriveVisualReaderDeadlines, "function",
  "session time reserves a distinct finalization window before its absolute deadline");
assert.deepEqual(deadlinePlanner.deriveVisualReaderDeadlines?.(100, 120_000), {
  sessionDeadlineAt: 120_100,
  workDeadlineAt: 119_100
}, "a normal session reserves one second for terminal delivery");
assert.deepEqual(deadlinePlanner.deriveVisualReaderDeadlines?.(1_000, 100), {
  sessionDeadlineAt: 1_100,
  workDeadlineAt: 1_080
}, "a short session retains a positive proportional finalization window");
assert.deepEqual(deadlinePlanner.deriveVisualReaderDeadlines?.(50, 1), {
  sessionDeadlineAt: 51,
  workDeadlineAt: 50
}, "the smallest allowed session still reserves its only millisecond for terminal delivery");

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

{
  const sent: Array<Array<{ clientObservationKey: string; redactedCrop: unknown }>> = [];
  let reader!: ReturnType<typeof createBoundedReader>;
  const cropped = Array.from({ length: 6 }, (_value, index) => ({
    clientObservationKey: `ocr:crop-${index}`,
    redactedCrop: { mediaType: "image/webp", contentBase64: "UklGRg==", redactionProof: {} }
  }));
  reader = createBoundedReader({
    sessionId: "bounded-crop-batches",
    limits: { ...limits, maxCommentsPerVideo: 6, maxOcrCalls: 10 },
    artifactUploadEnabled: true,
    extract: async () => cropped as any,
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => {
      sent.push(structuredClone(batch.observations));
      queueMicrotask(() => { void reader.acknowledge(batch.batchId); });
      return { accepted: true };
    },
    sendTerminal: () => undefined
  });
  await reader.start();
  assert.deepEqual(sent.map((batch) => batch.length), [5, 1]);
  assert.ok(sent.every((batch) => batch.filter((item) => item.redactedCrop !== null).length <= 5));
  assert.ok(sent.flat().every((item) => item.redactedCrop !== null),
    "reader must not erase already-redacted crops before the page bridge");
}

{
  const scheduler = new ManualScheduler();
  const deadlines = readerModule.deriveVisualReaderDeadlines(0, 1);
  const attempts: ExtensionEvent[] = [];
  const transport = createReliableEventTransport({
    deadlineAt: deadlines.sessionDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    send: async (event) => {
      attempts.push(structuredClone(event));
      return { accepted: true };
    }
  });
  const reader = createBoundedReader({
    sessionId: "minimum-duration-budget",
    limits: { ...limits, maxDurationMs: 1 },
    workDeadlineAt: deadlines.workDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => new Promise<never>(() => undefined),
    programmaticScroll: async () => undefined,
    sendBatch: async () => ({ accepted: true }),
    sendTerminal: (terminal) => transport.queueTerminal({
      version: BRIDGE_VERSION,
      type: "terminal",
      channelNonce: "0".repeat(64),
      sessionId: "minimum-duration-budget",
      status: terminal.status,
      errorCodes: terminal.errorCodes
    })
  });

  const running = reader.start();
  assert.equal(attempts.length, 1,
    "the minimum session starts terminal delivery synchronously at its work deadline");
  scheduler.advance(1);
  await running;
  await transport.whenIdle();

  assert.equal(attempts.length, 1,
    "the minimum session neither duplicates nor sends terminal after the total deadline");
  assert.deepEqual(attempts[0], {
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "0".repeat(64),
    sessionId: "minimum-duration-budget",
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  });
  assert.equal(scheduler.pending(), 0, "minimum-duration finalization clears every timer");
  transport.close();
}

{
  const scheduler = new ManualScheduler();
  const deadlines = readerModule.deriveVisualReaderDeadlines(0, 1);
  const attempts: ExtensionEvent[] = [];
  const transport = createReliableEventTransport({
    deadlineAt: deadlines.sessionDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    send: async (event) => {
      attempts.push(structuredClone(event));
      return { accepted: true };
    }
  });
  const running = readerModule.startVisualReaderWithinDeadlines({
    deadlines,
    now: () => scheduler.now,
    queueBudgetTerminal: (_currentDeadlines, deadlineCheckedAt) => {
      transport.queueTerminal({
        version: BRIDGE_VERSION,
        type: "terminal",
        channelNonce: "1".repeat(64),
        sessionId: "minimum-duration-start-orchestrator",
        status: "partial_success",
        errorCodes: ["visual_reader_budget_exhausted"]
      }, { deadlineCheckedAt });
      return transport.whenIdle();
    },
    startReader: async () => { throw new Error("an empty work window must not initialize the reader"); }
  });
  assert.equal(attempts.length, 1,
    "the start decision and first terminal send are one synchronous pre-setup action");
  scheduler.advance(1);
  await running;
  assert.equal(attempts.length, 1,
    "setup-time clock advancement cannot erase the already-started minimum-duration attempt");
  assert.equal(scheduler.pending(), 0);
  transport.close();
}

{
  const scheduler = new ManualScheduler();
  const deadlines = readerModule.deriveVisualReaderDeadlines(0, 1);
  scheduler.advance(1);
  let attempts = 0;
  const transport = createReliableEventTransport({
    deadlineAt: deadlines.sessionDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    send: async () => {
      attempts += 1;
      return { accepted: true };
    }
  });
  await readerModule.startVisualReaderWithinDeadlines({
    deadlines,
    now: () => scheduler.now,
    queueBudgetTerminal: (_currentDeadlines, deadlineCheckedAt) => {
      transport.queueTerminal({
        version: BRIDGE_VERSION,
        type: "terminal",
        channelNonce: "2".repeat(64),
        sessionId: "expired-before-terminal-queue",
        status: "partial_success",
        errorCodes: ["visual_reader_budget_exhausted"]
      }, { deadlineCheckedAt });
      return transport.whenIdle();
    },
    startReader: async () => { throw new Error("an expired session must not initialize the reader"); }
  });
  assert.equal(attempts, 0, "queueing at the absolute session deadline starts no terminal send");
  assert.equal(scheduler.pending(), 0, "an already-expired queue creates no timeout or retry");
  transport.close();
}

{
  const scheduler = new ManualScheduler();
  const deadlines = readerModule.deriveVisualReaderDeadlines(0, 100);
  const events: ExtensionEvent[] = [];
  let reader!: ReturnType<typeof createBoundedReader>;
  const transport = createReliableEventTransport({
    deadlineAt: deadlines.sessionDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    send: async (event) => {
      events.push(structuredClone(event));
      if (event.type === "observation_batch") await reader.acknowledge(event.batchId);
      return { accepted: true };
    }
  });
  reader = createBoundedReader({
    sessionId: "normal-start-orchestrator",
    limits: { ...limits, maxCommentsPerVideo: 1 },
    workDeadlineAt: deadlines.workDeadlineAt,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: "dom:normal", redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: (batch) => transport.sendBatch({
      version: BRIDGE_VERSION,
      type: "observation_batch",
      channelNonce: "3".repeat(64),
      sessionId: "normal-start-orchestrator",
      batchId: batch.batchId,
      observations: batch.observations as any
    }),
    sendTerminal: (terminal) => transport.queueTerminal({
      version: BRIDGE_VERSION,
      type: "terminal",
      channelNonce: "3".repeat(64),
      sessionId: "normal-start-orchestrator",
      status: terminal.status,
      errorCodes: terminal.errorCodes
    })
  });
  await readerModule.startVisualReaderWithinDeadlines({
    deadlines,
    now: () => scheduler.now,
    queueBudgetTerminal: async () => { throw new Error("a live work window must run the reader"); },
    startReader: () => reader.start()
  });
  await transport.whenIdle();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "observation_batch");
  assert.deepEqual(events[1], {
    version: BRIDGE_VERSION,
    type: "terminal",
    channelNonce: "3".repeat(64),
    sessionId: "normal-start-orchestrator",
    status: "completed",
    errorCodes: []
  }, "a normal work window retains the existing reader completion path");
  assert.equal(scheduler.pending(), 0, "normal completion clears reader and transport timers");
  transport.close();
}

for (const blockedStage of ["extract", "send", "ack", "scroll"] as const) {
  const scheduler = new ManualScheduler();
  const terminals: unknown[] = [];
  let extraction = 0;
  const never = () => new Promise<never>(() => undefined);
  const reader = createBoundedReader({
    sessionId: `deadline-${blockedStage}`,
    limits,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => {
      extraction += 1;
      if (blockedStage === "extract") return never();
      return blockedStage === "scroll" ? [] : [{ clientObservationKey: "dom:deadline", redactedCrop: null }];
    },
    programmaticScroll: async () => blockedStage === "scroll" ? never() : undefined,
    sendBatch: async () => {
      if (blockedStage === "send") return never();
      return { accepted: true };
    },
    sendTerminal: (terminal) => { terminals.push(terminal); }
  });
  const running = reader.start();
  await flush();
  if (blockedStage !== "extract" && blockedStage !== "send" && blockedStage !== "ack") {
    assert.equal(extraction, 1);
  }
  scheduler.advance(100);
  await running;
  assert.deepEqual(terminals, [{
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  }], `${blockedStage} shares the absolute deadline`);
  assert.equal(scheduler.pending(), 0, `${blockedStage} clears its deadline timer`);
  assert.equal(await reader.acknowledge("batch-1"), false, `${blockedStage} clears pending ACK state`);
}

{
  const scheduler = new ManualScheduler();
  const terminals: unknown[] = [];
  const reader = createBoundedReader({
    sessionId: "work-deadline-before-terminal",
    limits,
    workDeadlineAt: 80,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => new Promise<never>(() => undefined),
    programmaticScroll: async () => undefined,
    sendBatch: async () => ({ accepted: true }),
    sendTerminal: (terminal) => { terminals.push(terminal); }
  });
  const running = reader.start();
  await flush();
  scheduler.advance(80);
  assert.deepEqual(terminals, [{
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  }], "the work-deadline timer queues the budget terminal before rejection settles");
  await flush();
  assert.deepEqual(terminals, [{
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  }], "a blocked work stage reaches finalization before the session deadline");
  await running;
  assert.equal(scheduler.pending(), 0, "work-deadline completion clears its operation timer");
}

{
  const scheduler = new ManualScheduler();
  const attempts: string[] = [];
  const terminals: unknown[] = [];
  const reader = createBoundedReader({
    sessionId: "retry-same-batch",
    limits: { ...limits, maxCommentsPerVideo: 1 },
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    retryDelayMs: 10,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: "dom:stable", redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => {
      attempts.push(batch.batchId);
      if (attempts.length === 1) return { accepted: false };
      if (attempts.length === 2) throw new Error("runtime transport unavailable");
      return { accepted: true };
    },
    sendTerminal: (terminal) => { terminals.push(terminal); }
  });
  const running = reader.start();
  await flush();
  scheduler.advance(10);
  await flush();
  scheduler.advance(10);
  await flush();
  assert.deepEqual(attempts, ["batch-1", "batch-1", "batch-1"]);
  assert.deepEqual(terminals, [], "normal work does not emit terminal before its final batch ACK");
  assert.equal(await reader.acknowledge("wrong-batch"), false);
  assert.equal(await reader.acknowledge("batch-1"), true);
  await running;
  assert.deepEqual(terminals, [{ status: "completed", errorCodes: [] }]);
  assert.equal(scheduler.pending(), 0);
}

{
  const scheduler = new ManualScheduler();
  const attempts: string[] = [];
  const reader = createBoundedReader({
    sessionId: "ack-replay",
    limits: { ...limits, maxCommentsPerVideo: 1 },
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    retryDelayMs: 10,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: "dom:ack-replay", redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => { attempts.push(batch.batchId); return { accepted: true }; },
    sendTerminal: () => undefined
  });
  const running = reader.start();
  await flush();
  assert.deepEqual(attempts, ["batch-1"]);
  scheduler.advance(10);
  await flush();
  assert.deepEqual(attempts, ["batch-1", "batch-1"], "lost ACK replays the same retained batch");
  assert.equal(await reader.acknowledge("batch-1"), true);
  await running;
  assert.equal(scheduler.pending(), 0);
}

{
  const scheduler = new ManualScheduler();
  const terminals: unknown[] = [];
  const reader = createBoundedReader({
    sessionId: "takeover-pending",
    limits,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: "dom:pending", redactedCrop: null }],
    programmaticScroll: async () => { throw new Error("must not scroll after takeover"); },
    sendBatch: async () => ({ accepted: true }),
    sendTerminal: (terminal) => { terminals.push(terminal); }
  });
  const running = reader.start();
  await flush();
  reader.userTakeover();
  await running;
  assert.deepEqual(terminals, [{
    status: "aborted",
    errorCodes: ["visual_reader_user_takeover"]
  }]);
  assert.equal(await reader.acknowledge("batch-1"), false);
  assert.equal(scheduler.pending(), 0);
}

{
  const scheduler = new ManualScheduler();
  let releaseExtract: ((value: Array<{ clientObservationKey: string; redactedCrop: null }>) => void) | null = null;
  let batchCalls = 0;
  const terminals: unknown[] = [];
  const reader = createBoundedReader({
    sessionId: "takeover-extract",
    limits,
    now: () => scheduler.now,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    artifactUploadEnabled: false,
    extract: async () => new Promise((resolve) => { releaseExtract = resolve; }),
    programmaticScroll: async () => { throw new Error("must not scroll after takeover"); },
    sendBatch: async () => { batchCalls += 1; return { accepted: true }; },
    sendTerminal: (terminal) => { terminals.push(terminal); return new Promise<void>(() => undefined); }
  });
  const running = reader.start();
  await flush();
  reader.userTakeover();
  await running;
  const finishLateExtract = releaseExtract as ((value: Array<{
    clientObservationKey: string;
    redactedCrop: null;
  }>) => void) | null;
  finishLateExtract?.([{ clientObservationKey: "dom:late", redactedCrop: null }]);
  await flush();
  assert.equal(batchCalls, 0);
  assert.deepEqual(terminals, [{
    status: "aborted",
    errorCodes: ["visual_reader_user_takeover"]
  }]);
  assert.equal(scheduler.pending(), 0);
}

console.log("douyin reader reliability self-test passed");
