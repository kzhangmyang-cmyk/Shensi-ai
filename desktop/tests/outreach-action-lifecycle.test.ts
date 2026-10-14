import assert from "node:assert/strict";
import test from "node:test";
import { attachOutreachSidecarLifecycle, sidecarActionPort } from "../src/main/outreach-action-lifecycle.ts";
import type { ConnectorStatus } from "../src/shared/contracts.ts";
import type { SidecarClient } from "../src/main/sidecar-client.ts";

const status = (state: ConnectorStatus["state"]): ConnectorStatus => ({ state, protocolVersion: state === "ready" ? 1 : null, diagnostic: null });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function managerFixture() {
  const listeners = new Set<(value: ConnectorStatus) => void>();
  let current = status("starting");
  const makeClient = () => ({ resolveDouyinIdentity: async () => { throw new Error("unused"); } });
  const manager = {
    client: null as Pick<SidecarClient, "resolveDouyinIdentity"> | null,
    getStatus: () => current,
    onStatus(listener: (value: ConnectorStatus) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(state: ConnectorStatus["state"], replace = false) {
      current = status(state);
      if (state !== "ready") manager.client = null;
      else if (!manager.client || replace) manager.client = makeClient();
      for (const listener of listeners) listener(current);
    },
  };
  return manager;
}

test("coordinator starts only after ready, survives repeated events and receives replacement generations", async () => {
  const manager = managerFixture();
  const events: string[] = [];
  const dispose = attachOutreachSidecarLifecycle({ manager, coordinator: {
    start: async () => { events.push("start"); },
    onSidecarChanged: async (ready, generation) => { events.push(`${ready}:${generation}`); },
  }, onFailure: () => { events.push("failure"); } });
  await settle();
  assert.deepEqual(events, ["false:0"]);
  manager.publish("ready"); await settle();
  manager.publish("ready"); await settle();
  assert.deepEqual(events, ["false:0", "true:1", "start"]);
  manager.publish("crashed"); await settle();
  manager.publish("ready"); await settle();
  assert.deepEqual(events.slice(3), ["false:1", "true:2"]);
  dispose();
  manager.publish("ready", true); await settle();
  assert.equal(events.length, 5);
});

test("a pending readiness callback cannot start work after disconnect or disposal", async () => {
  const manager = managerFixture();
  const events: string[] = [];
  let ready!: () => void;
  const dispose = attachOutreachSidecarLifecycle({ manager, coordinator: {
    start: async () => { events.push("start"); },
    onSidecarChanged: async (available) => { if (available) await new Promise<void>((resolve) => { ready = resolve; }); },
  }, onFailure: () => { events.push("failure"); } });
  manager.publish("ready");
  manager.publish("crashed");
  dispose(); ready(); await settle();
  assert.deepEqual(events, []);
});

test("readiness failures are observed without swallowing the next independent ready event", async () => {
  const manager = managerFixture();
  let failures = 0; let starts = 0;
  const dispose = attachOutreachSidecarLifecycle({ manager, coordinator: {
    start: async () => { starts += 1; },
    onSidecarChanged: async (ready, generation) => { if (ready && generation === 1) throw new Error("private cause"); },
  }, onFailure: () => { failures += 1; } });
  manager.publish("ready"); await settle();
  assert.equal(failures, 1); assert.equal(starts, 0);
  manager.publish("ready", true); await settle();
  assert.equal(starts, 1);
  dispose();
});

test("local action port rejects an offline connector and uses only the current client", async () => {
  const calls: string[] = [];
  const localClient = (generation: string) => ({
    resolveDouyinIdentity: async (key: string) => { calls.push(`${generation}:${key}`); throw new Error("observed"); },
    executeDouyinAction: async () => { throw new Error("unused"); },
    reconcileDouyinAction: async () => { throw new Error("unused"); },
    acknowledgeDouyinAction: async () => { throw new Error("unused"); },
  });
  const manager = { client: null as ReturnType<typeof localClient> | null };
  const port = sidecarActionPort(manager);
  await assert.rejects(port.resolveDouyinIdentity("key"), /sidecar_unavailable/u);
  manager.client = localClient("first");
  await assert.rejects(port.resolveDouyinIdentity("key"), /observed/u);
  manager.client = localClient("replacement");
  await assert.rejects(port.resolveDouyinIdentity("key"), /observed/u);
  assert.deepEqual(calls, ["first:key", "replacement:key"]);
});
