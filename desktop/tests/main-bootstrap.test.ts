import { strict as assert } from "node:assert";
import test from "node:test";
import { launchSingleInstanceApplication } from "../src/main/main-bootstrap.ts";

test("single-instance ownership is acquired before Electron readiness", async () => {
  const events: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const launched = launchSingleInstanceApplication({
    requestSingleInstanceLock: () => { events.push("lock"); return true; },
    whenReady: () => { events.push("when-ready"); return ready; },
    start: async () => { events.push("start"); },
    quit: () => events.push("quit"),
    onFailure: () => events.push("failure"),
  });
  assert.equal(launched, true);
  assert.deepEqual(events, ["lock", "when-ready"]);
  resolveReady();
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["lock", "when-ready", "start"]);
});

test("the second instance quits before readiness and never starts", () => {
  const events: string[] = [];
  const launched = launchSingleInstanceApplication({
    requestSingleInstanceLock: () => { events.push("lock"); return false; },
    whenReady: () => { events.push("when-ready"); return Promise.resolve(); },
    start: async () => { events.push("start"); },
    quit: () => events.push("quit"),
    onFailure: () => events.push("failure"),
  });
  assert.equal(launched, false);
  assert.deepEqual(events, ["lock", "quit"]);
});

test("bootstrap failures are reported and terminate the application", async () => {
  const events: string[] = [];
  launchSingleInstanceApplication({
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    start: async () => { throw new Error("boom"); },
    quit: () => events.push("quit"),
    onFailure: () => events.push("failure"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["failure", "quit"]);
});
