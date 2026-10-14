import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  attestOwnedProcess,
  expectedOwnedProcessCommand,
  inspectOwnedProcess,
  readOwnedProcessCommand,
  stopOwnedProcesses
} from "./process-ownership.mjs";

function record(overrides = {}) {
  return {
    name: "backend",
    pid: 4201,
    command: "/fixture/node",
    args: ["/fixture/backend.js", "--runtime-nonce", "a".repeat(32)],
    nonce: "a".repeat(32),
    path: "/fixture/pids/backend.json",
    ...overrides
  };
}

test("native process command reader removes ps column padding", async () => {
  const command = await readOwnedProcessCommand(process.pid);
  assert.equal(typeof command, "string");
  assert.equal(command, command.trim());
});

test("native attestation preserves UTF-8 commands under a non-ASCII workspace path", async () => {
  const nonce = "b".repeat(32);
  const args = ["-e", "setTimeout(()=>{},10000)", "新项目", "--runtime-nonce", nonce];
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  try {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1);
    let attested = null;
    for (let attempt = 0; attempt < 20 && attested === null; attempt += 1) {
      try {
        attested = await attestOwnedProcess({
          name: "unicode", pid: child.pid, command: process.execPath, args, nonce
        });
      } catch (caught) {
        if (!/PROCESS_OWNERSHIP_PROCESS_(?:MISSING|REUSED)/u.test(caught?.message ?? "")) throw caught;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(attested);
  } finally {
    child.kill("SIGKILL");
  }
});

test("attestation binds an exact command, nonce, PID, and process start token", async () => {
  const candidate = record();
  const attested = await attestOwnedProcess(candidate, {
    readProcessCommand: async () => expectedOwnedProcessCommand(candidate),
    readProcessStartToken: async () => "process-start-4201"
  });

  assert.deepEqual(attested, {
    ...candidate,
    processStartToken: "process-start-4201"
  });
  assert.equal(Object.isFrozen(attested), true);
  assert.equal(await inspectOwnedProcess(attested, {
    readProcessCommand: async () => expectedOwnedProcessCommand(candidate),
    readProcessStartToken: async () => "process-start-4201"
  }), "owned");
  assert.equal(await inspectOwnedProcess(attested, {
    readProcessCommand: async () => expectedOwnedProcessCommand(candidate),
    readProcessStartToken: async () => "reused-pid-start"
  }), "stale");
});

test("attestation distinguishes a missing PID from a reused PID without leaking commands", async () => {
  const candidate = record();
  await assert.rejects(attestOwnedProcess(candidate, {
    readProcessCommand: async () => null,
    readProcessStartToken: async () => null
  }), { message: "PROCESS_OWNERSHIP_PROCESS_MISSING" });
  await assert.rejects(attestOwnedProcess(candidate, {
    readProcessCommand: async () => "/other/process --runtime-nonce " + candidate.nonce,
    readProcessStartToken: async () => "other-start"
  }), { message: "PROCESS_OWNERSHIP_PROCESS_REUSED" });
});

test("bounded stop revalidates ownership before TERM and KILL", async () => {
  const first = await attestOwnedProcess(record(), {
    readProcessCommand: async () => expectedOwnedProcessCommand(record()),
    readProcessStartToken: async () => "start-4201"
  });
  const signals = [];
  let waits = 0;
  const result = await stopOwnedProcesses([first], {
    readProcessCommand: async () => expectedOwnedProcessCommand(record()),
    readProcessStartToken: async () => "start-4201",
    signalProcessGroup: async (pid, signal) => signals.push([pid, signal]),
    waitForExit: async () => {
      waits += 1;
      return waits === 2;
    },
    removeRecord: async (path) => signals.push(["remove", path])
  });

  assert.deepEqual(signals, [
    [4201, "SIGTERM"],
    [4201, "SIGKILL"],
    ["remove", "/fixture/pids/backend.json"]
  ]);
  assert.deepEqual(result, { stopped: ["backend"], missing: [], stale: [] });
});

test("bounded stop never signals a missing or reused PID", async () => {
  const owned = record({ processStartToken: "original-start" });
  const signals = [];
  const missing = await stopOwnedProcesses([owned], {
    readProcessCommand: async () => null,
    readProcessStartToken: async () => null,
    signalProcessGroup: async (...args) => signals.push(args),
    removeRecord: async () => undefined
  });
  assert.deepEqual(missing, { stopped: [], missing: ["backend"], stale: [] });

  const reused = await stopOwnedProcesses([owned], {
    readProcessCommand: async () => expectedOwnedProcessCommand(owned),
    readProcessStartToken: async () => "replacement-start",
    signalProcessGroup: async (...args) => signals.push(args)
  });
  assert.deepEqual(reused, { stopped: [], missing: [], stale: ["backend"] });
  assert.deepEqual(signals, []);
});

test("bounded stop processes records in reverse startup order", async () => {
  const backend = record({ processStartToken: "backend-start" });
  const gateway = record({
    name: "gateway",
    pid: 4202,
    args: ["/fixture/gateway.js", "--runtime-nonce", "b".repeat(32)],
    nonce: "b".repeat(32),
    path: "/fixture/pids/gateway.json",
    processStartToken: "gateway-start"
  });
  const commands = new Map([
    [backend.pid, expectedOwnedProcessCommand(backend)],
    [gateway.pid, expectedOwnedProcessCommand(gateway)]
  ]);
  const starts = new Map([[backend.pid, "backend-start"], [gateway.pid, "gateway-start"]]);
  const signalled = [];

  const result = await stopOwnedProcesses([backend, gateway], {
    readProcessCommand: async (pid) => commands.get(pid) ?? null,
    readProcessStartToken: async (pid) => starts.get(pid) ?? null,
    signalProcessGroup: async (pid, signal) => signalled.push([pid, signal]),
    waitForExit: async () => true,
    removeRecord: async () => undefined
  });

  assert.deepEqual(signalled, [[4202, "SIGTERM"], [4201, "SIGTERM"]]);
  assert.deepEqual(result, { stopped: ["gateway", "backend"], missing: [], stale: [] });
});
