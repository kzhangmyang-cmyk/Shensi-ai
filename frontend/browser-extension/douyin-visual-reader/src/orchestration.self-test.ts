import { strict as assert } from "node:assert";
import {
  createSessionCoordinator,
  type VisualReaderPersistedState
} from "./session-coordinator";
import { BoundedReaderError, createBoundedReader } from "./douyin-reader";

const limits = {
  maxVideos: 1,
  maxCommentsPerVideo: 30,
  maxScrolls: 5,
  maxOcrCalls: 0,
  maxDurationMs: 120_000
};

{
  const writes: VisualReaderPersistedState[] = [];
  const logs: unknown[] = [];
  const coordinator = createSessionCoordinator({
    persist: async (state) => { writes.push(structuredClone(state)); },
    log: (entry) => logs.push(entry),
    nonceHash: async () => "sha256:" + "1".repeat(64)
  });
  await coordinator.authorizeFromGoodJob({
    goodJobTabId: 11,
    channelNonce: "a".repeat(64),
    sessionId: "visual-session-1",
    limits,
    artifactUploadEnabled: false
  });
  assert.equal(coordinator.snapshot().douyinTabId, null);
  assert.equal(await coordinator.confirmDouyinTab(21, 7, "https://www.douyin.com/video/123"), true);
  assert.equal(await coordinator.confirmDouyinTab(22, 7, "https://www.douyin.com/video/456"), false, "one confirmed tab only");
  assert.equal(coordinator.beginBatch("batch-1"), true);
  assert.equal(coordinator.beginBatch("batch-2"), false, "wait for webpage ACK");
  assert.equal(coordinator.acknowledgeBatch("visual-session-1", "batch-1"), true);
  assert.equal(coordinator.beginBatch("batch-2"), true);
  await coordinator.abort("visual_reader_user_takeover");
  assert.equal(coordinator.snapshot().status, "aborted");
  assert.equal(coordinator.snapshot().pendingBatchId, null);
  const serialized = JSON.stringify({ writes, logs });
  assert.doesNotMatch(serialized, /正在寻找|林经理|MS4w|aaaaaaaa/u);
  assert.match(serialized, /sha256:/u);
  for (const state of writes) {
    assert.deepEqual(Object.keys(state).sort(), [
      "artifactUploadEnabled", "channelNonceHash", "douyinSourceUrl", "douyinTabId", "douyinWindowId", "goodJobTabId",
      "limits", "sessionId", "status", "usage"
    ]);
  }
}

{
  const writes: VisualReaderPersistedState[] = [];
  const coordinator = createSessionCoordinator({
    persist: async (state) => { writes.push(structuredClone(state)); },
    log: () => undefined,
    nonceHash: async () => "sha256:" + "2".repeat(64)
  });
  await coordinator.authorizeFromGoodJob({
    goodJobTabId: 12,
    channelNonce: "b".repeat(64),
    sessionId: "visual-session-finished",
    limits,
    artifactUploadEnabled: false
  });
  assert.equal(await coordinator.confirmDouyinTab(23, 8, "https://www.douyin.com/video/789"), true);
  await coordinator.finish("completed");
  assert.equal(coordinator.snapshot().status, "completed");
  await coordinator.abort("visual_reader_user_takeover");
  assert.equal(coordinator.snapshot().status, "completed", "popup disconnect cannot rewrite a terminal session");
}

{
  const batches: Array<{
    batchId: string;
    observations: Array<{ clientObservationKey: string; redactedCrop: unknown | null }>;
  }> = [];
  const terminals: Array<{ status: string; errorCodes: string[] }> = [];
  let extraction = 0;
  const scrolls: number[] = [];
  const reader = createBoundedReader({
    sessionId: "visual-session-1",
    limits,
    artifactUploadEnabled: false,
    extract: async () => {
      extraction += 1;
      const key = extraction === 1 ? "dom:first" : extraction === 2 ? "dom:second" : "dom:second";
      return [{ clientObservationKey: key, redactedCrop: null }];
    },
    programmaticScroll: async (index) => { scrolls.push(index); },
    sendBatch: async (batch) => {
      batches.push(batch);
      await reader.acknowledge(batch.batchId);
    },
    sendTerminal: async (terminal) => { terminals.push(terminal); }
  });
  await reader.start();
  assert.deepEqual(scrolls, [1, 2, 3], "two consecutive no-progress cycles stop after bounded scrolls");
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.observations.length <= 20));
  assert.ok(batches.flatMap((batch) => batch.observations).every((item) => item.redactedCrop === null));
  assert.deepEqual(terminals, [{ status: "completed", errorCodes: [] }]);
}

{
  let resolveBatch: (() => void) | null = null;
  const events: string[] = [];
  const reader = createBoundedReader({
    sessionId: "visual-session-2",
    limits,
    artifactUploadEnabled: true,
    extract: async () => [{ clientObservationKey: "dom:first", redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => {
      events.push(`batch:${batch.batchId}`);
      await new Promise<void>((resolve) => { resolveBatch = resolve; });
    },
    sendTerminal: async (terminal) => { events.push(`terminal:${terminal.status}`); }
  });
  const running = reader.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, 1, "terminal waits for last batch ACK");
  reader.userTakeover();
  const finishBatch = resolveBatch as (() => void) | null;
  finishBatch?.();
  await running;
  assert.equal(events.at(-1), "terminal:aborted");
}

{
  let release: (() => void) | null = null;
  const terminals: Array<{ status: string; errorCodes: string[] }> = [];
  const reader = createBoundedReader({
    sessionId: "visual-session-stop",
    limits,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: "dom:stop", redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: async () => new Promise<void>((resolve) => { release = resolve; }),
    sendTerminal: async (terminal) => { terminals.push(terminal); }
  });
  const running = reader.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  reader.stop();
  const finishStop = release as (() => void) | null;
  finishStop?.();
  await running;
  assert.deepEqual(terminals, [{ status: "aborted", errorCodes: [] }]);
}

{
  let attempts = 0;
  const reader = createBoundedReader({
    sessionId: "visual-session-3",
    limits,
    artifactUploadEnabled: false,
    extract: async () => [{ clientObservationKey: `dom:${attempts++}`, redactedCrop: null }],
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => { await reader.acknowledge(batch.batchId); },
    sendTerminal: async () => undefined
  });
  await reader.start();
  assert.equal(reader.usage().scrollCount, 5, "never performs a sixth programmatic scroll");
}

{
  const batchSizes: number[] = [];
  const observations = Array.from({ length: 25 }, (_, index) => ({
    clientObservationKey: `dom:bulk-${index}`,
    redactedCrop: null as null
  }));
  const reader = createBoundedReader({
    sessionId: "visual-session-batches",
    limits,
    artifactUploadEnabled: false,
    extract: async () => observations,
    programmaticScroll: async () => undefined,
    sendBatch: async (batch) => {
      batchSizes.push(batch.observations.length);
      await reader.acknowledge(batch.batchId);
    },
    sendTerminal: async () => undefined
  });
  await reader.start();
  assert.deepEqual(batchSizes, [20, 5], "25 observations are split into protocol-bounded batches");
}

{
  const terminals: Array<{ status: string; errorCodes: string[] }> = [];
  const reader = createBoundedReader({
    sessionId: "visual-session-4",
    limits,
    artifactUploadEnabled: false,
    extract: async () => { throw new BoundedReaderError("visual_source_invalid"); },
    programmaticScroll: async () => undefined,
    sendBatch: async () => undefined,
    sendTerminal: async (terminal) => { terminals.push(terminal); }
  });
  await reader.start();
  assert.deepEqual(terminals, [{
    status: "partial_success",
    errorCodes: ["visual_source_invalid"]
  }]);
}

{
  let clock = 0;
  const terminals: Array<{ status: string; errorCodes: string[] }> = [];
  const reader = createBoundedReader({
    sessionId: "visual-session-expired",
    limits: { ...limits, maxDurationMs: 10 },
    artifactUploadEnabled: false,
    now: () => clock,
    extract: async () => {
      clock = 11;
      return [{ clientObservationKey: "dom:late", redactedCrop: null }];
    },
    programmaticScroll: async () => undefined,
    sendBatch: async () => undefined,
    sendTerminal: async (terminal) => { terminals.push(terminal); }
  });
  await reader.start();
  assert.deepEqual(terminals, [{
    status: "partial_success",
    errorCodes: ["visual_reader_budget_exhausted"]
  }]);
}

console.log("douyin visual reader orchestration self-test passed");
