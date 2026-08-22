import { strict as assert } from "node:assert";
import {
  goodJobRecoveryTerminalFromMemory,
  matchesUnavailableSession,
  recoverOrphanedVisualReaderSession
} from "./restart-recovery";
import type { VisualReaderPersistedState } from "./session-coordinator";

const activeState: VisualReaderPersistedState = {
  sessionId: "session-restart",
  goodJobTabId: 11,
  douyinTabId: 21,
  douyinWindowId: 7,
  douyinSourceUrl: "https://www.douyin.com/video/123",
  limits: {
    maxVideos: 1,
    maxCommentsPerVideo: 30,
    maxScrolls: 5,
    maxOcrCalls: 0,
    maxDurationMs: 120_000
  },
  usage: { observationCount: 8, scrollCount: 2, ocrCallCount: 0 },
  artifactUploadEnabled: false,
  channelNonceHash: `sha256:${"1".repeat(64)}`,
  status: "reading"
};

for (const label of ["reading", "pending ACK retained only in content memory"]) {
  const actions: unknown[] = [];
  const result = await recoverOrphanedVisualReaderSession({
    load: async () => structuredClone(activeState),
    clear: async () => { actions.push("clear"); },
    notifyGoodJob: async (tabId, message) => { actions.push({ target: "goodjob", tabId, message }); },
    notifyDouyin: async (tabId, message) => { actions.push({ target: "douyin", tabId, message }); }
  });
  assert.equal(result, "active_session_failed_closed", label);
  assert.equal(actions[0], "clear", "persisted authority is removed before endpoint notification");
  assert.deepEqual(actions.slice(1), [
    {
      target: "goodjob",
      tabId: 11,
      message: { kind: "goodjob_reader_unavailable", sessionId: "session-restart" }
    },
    {
      target: "douyin",
      tabId: 21,
      message: { kind: "visual_reader_unavailable", sessionId: "session-restart" }
    }
  ]);
  const serialized = JSON.stringify(actions);
  assert.doesNotMatch(serialized, /正在寻找|林经理|rawNonce|aaaaaaaa/u);
  assert.doesNotMatch(serialized, /channelNonceHash|sha256:/u,
    "even the nonce hash is unnecessary in restart notifications");
}

{
  const actions: string[] = [];
  const result = await recoverOrphanedVisualReaderSession({
    load: async () => ({ ...activeState, status: "completed" }),
    clear: async () => { actions.push("clear"); },
    notifyGoodJob: async () => { actions.push("goodjob"); },
    notifyDouyin: async () => { actions.push("douyin"); }
  });
  assert.equal(result, "terminal_session_cleared");
  assert.deepEqual(actions, ["clear"]);
}

{
  let cleared = false;
  const result = await recoverOrphanedVisualReaderSession({
    load: async () => null,
    clear: async () => { cleared = true; },
    notifyGoodJob: async () => undefined,
    notifyDouyin: async () => undefined
  });
  assert.equal(result, "none");
  assert.equal(cleared, false);
}

{
  const actions: string[] = [];
  const result = await recoverOrphanedVisualReaderSession({
    load: async () => ({
      ...activeState,
      limits: { ...activeState.limits, maxScrolls: 6 }
    }),
    clear: async () => { actions.push("clear"); },
    notifyGoodJob: async () => { actions.push("goodjob"); },
    notifyDouyin: async () => { actions.push("douyin"); }
  });
  assert.equal(result, "invalid_session_cleared");
  assert.deepEqual(actions, ["clear"], "malformed storage is cleared without trusting its tab targets");
}

const memoryNonce = "b".repeat(64);
assert.deepEqual(goodJobRecoveryTerminalFromMemory(
  { kind: "goodjob_reader_unavailable", sessionId: "session-restart" },
  { sessionId: "session-restart", channelNonce: memoryNonce }
), {
  version: "goodjob.visual-reader.bridge.v1",
  type: "terminal",
  channelNonce: memoryNonce,
  sessionId: "session-restart",
  status: "partial_success",
  errorCodes: ["visual_reader_session_expired"]
}, "the surviving GoodJob content script persists restart expiry through the non-user terminal contract");
assert.equal(matchesUnavailableSession(
  { kind: "visual_reader_unavailable", sessionId: "session-restart" },
  "visual_reader_unavailable",
  "session-restart"
), true, "the surviving Douyin content script can stop a retained pending batch");
assert.equal(matchesUnavailableSession(
  { kind: "visual_reader_unavailable", sessionId: "other" },
  "visual_reader_unavailable",
  "session-restart"
), false);

console.log("douyin visual reader restart recovery self-test passed");
