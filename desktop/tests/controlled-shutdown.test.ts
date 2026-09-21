import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installControlledQuitSignalHandlers, stopDesktopServices } from "../src/main/controlled-shutdown.ts";

test("SIGINT and SIGTERM request Electron's controlled quit only once", () => {
  const signals = new EventEmitter();
  let quits = 0;
  const dispose = installControlledQuitSignalHandlers(signals, () => { quits += 1; });

  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  assert.equal(quits, 1);

  dispose();
  signals.emit("SIGTERM");
  assert.equal(quits, 1);
});

test("quit drains the action coordinator before closing Sidecar and renderer", async () => {
  const calls: string[] = [];
  let drain!: () => void;
  const pending = new Promise<void>((resolve) => { drain = resolve; });
  const stopping = stopDesktopServices({
    coordinator: { stop: async () => { calls.push("coordinator"); await pending; } },
    sidecar: { stop: async () => { calls.push("sidecar"); } },
    renderer: { close: async () => { calls.push("renderer"); } },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["coordinator"]);
  drain();
  await stopping;
  assert.deepEqual(calls, ["coordinator", "sidecar", "renderer"]);
});

test("a failed coordinator or Sidecar shutdown still closes remaining owned services", async () => {
  const calls: string[] = [];
  await assert.rejects(stopDesktopServices({
    coordinator: { stop: async () => { calls.push("coordinator"); throw new Error("private detail"); } },
    sidecar: { stop: async () => { calls.push("sidecar"); throw new Error("private detail"); } },
    renderer: { close: async () => { calls.push("renderer"); } },
  }), /^Error: desktop_shutdown_failed$/u);
  assert.deepEqual(calls, ["coordinator", "sidecar", "renderer"]);
});
