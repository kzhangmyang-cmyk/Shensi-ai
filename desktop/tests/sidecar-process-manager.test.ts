import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, type SpawnOptions } from "node:child_process";

import { resolveSidecarCommand, SidecarProcessManager } from "../src/main/sidecar-process-manager.ts";

const fixture = path.resolve("fixtures/fake-sidecar.mjs");
async function tokenFiles(root: string): Promise<string[]> { return (await readdir(path.join(root, "tmp"))).filter((name) => name.startsWith("sidecar-token-")); }

test("selects deterministic shell-free development and packaged commands", () => {
  assert.deepEqual(resolveSidecarCommand({ environment: "development", repositoryRoot: "/repo" }), { file: "uv", args: ["run", "--frozen", "--project", "services/media-crawler", "python", "-m", "shensi_adapter.desktop_entrypoint"], cwd: "/repo" });
  assert.deepEqual(resolveSidecarCommand({ environment: "production", resourcesPath: "/App/Resources" }), { file: "/App/Resources/sidecar/shensi-sidecar", args: [], cwd: "/App/Resources/sidecar" });
});

test("development spawn adds the deterministic Sidecar import root without shell or token argv", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shensi-manager-spawn-"));
  let observed: { args: readonly string[]; options: SpawnOptions } | undefined;
  const { value } = await manager();
  const custom = new SidecarProcessManager({
    environment: "development", repositoryRoot: "/repo", userDataDirectory: path.join(root, "data"),
    logsDirectory: path.join(root, "logs"), temporaryDirectory: path.join(root, "tmp"), startupTimeoutMs: 20,
    spawn: ((file: string, args: readonly string[], options: SpawnOptions) => {
      observed = { args, options };
      throw new Error("spawn blocked for inspection");
    }) as any,
  });
  await assert.rejects(custom.start());
  assert.equal(observed?.options.shell, false);
  assert.equal(observed?.options.env?.PYTHONPATH, "/repo/services/media-crawler");
  assert.ok(!observed?.args.join(" ").includes("Bearer"));
});

test("Main explicitly selects the local action capability without leaking its business API origin", async () => {
  let environment: NodeJS.ProcessEnv | undefined;
  const { value } = await manager("normal", 250, {
    environmentVariables: { SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED: "false",
      DOUYIN_OUTREACH_ACTIONS_ENABLED: "true", SHENSI_REMOTE_ORIGIN: "https://api.shensi.invalid" },
    spawn: (_file, _args, options) => { environment = options.env; throw new Error("fake spawn boundary"); }
  });
  await assert.rejects(value.start());
  assert.equal(environment?.SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED, "true");
  assert.equal(environment?.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
  assert.equal(environment?.SHENSI_REMOTE_ORIGIN, undefined);
});

test("asynchronous spawn error rejects safely and pre-spawn filesystem errors leave a recoverable state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shensi-manager-errors-"));
  const missing = new SidecarProcessManager({ environment: "test", repositoryRoot: root,
    userDataDirectory: path.join(root, "data"), logsDirectory: path.join(root, "logs"), temporaryDirectory: path.join(root, "tmp"),
    resolveCommand: () => ({ file: path.join(root, "missing-executable"), args: [], cwd: root }) });
  await assert.rejects(missing.start());
  assert.equal(missing.getStatus().diagnostic?.code, "sidecar_spawn_failed");
  const broken = new SidecarProcessManager({ environment: "test", repositoryRoot: root,
    userDataDirectory: path.join(root, "data"), logsDirectory: path.join(root, "logs"), temporaryDirectory: path.join(root, "tmp2"),
    fileSystem: { mkdir: async () => { throw new Error("disk failed"); } } as any });
  await assert.rejects(broken.start());
  assert.equal(broken.getStatus().state, "crashed");
  assert.equal(broken.getStatus().diagnostic?.code, "sidecar_start_failed");
});

async function manager(mode = "normal", shutdownTimeoutMs = 250, overrides: Partial<ConstructorParameters<typeof SidecarProcessManager>[0]> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "shensi-manager-"));
  const logs: string[] = [];
  return { root, logs, value: new SidecarProcessManager({
    environment: "test", repositoryRoot: "/repo", userDataDirectory: path.join(root, "data"), logsDirectory: path.join(root, "logs"), temporaryDirectory: path.join(root, "tmp"), startupTimeoutMs: 600, shutdownTimeoutMs,
    resolveCommand: () => ({ file: process.execPath, args: [fixture], cwd: path.dirname(fixture) }),
    environmentVariables: { FAKE_SIDECAR_MODE: mode }, logger: (message) => logs.push(message), ...overrides,
  }) };
}

test("starts from authenticated ready handshake and protects the secret", async () => {
  const { value, root, logs } = await manager();
  const status = await value.start();
  assert.equal(status.state, "ready");
  assert.equal(status.protocolVersion, 1);
  assert.ok(value.client);
  const tokenPath = path.join(root, "tmp", (await tokenFiles(root))[0]!);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  const token = await readFile(tokenPath, "utf8");
  assert.ok(!logs.join(" ").includes(token));
  await value.stop();
  assert.equal(value.getStatus().state, "stopped");
  assert.deepEqual(await tokenFiles(root), []);
});

for (const [name, mode, code] of [["invalid handshake", "invalid-ready", "sidecar_ready_invalid"], ["bad token health", "bad-health", "sidecar_health_failed"], ["early exit", "early-exit", "sidecar_exited"]] as const) {
  test(name, async () => {
    const { value } = await manager(mode);
    await assert.rejects(value.start());
    assert.equal(value.getStatus().diagnostic?.code, code);
    await value.stop();
  });
}

test("rejects ready records with extra fields or an immediate/delayed second record", async () => {
  for (const mode of ["extra-ready", "duplicate-ready", "delayed-duplicate-ready"]) {
    const { value, root } = await manager(mode);
    await assert.rejects(value.start());
    assert.equal(value.getStatus().diagnostic?.code, "sidecar_ready_invalid");
    assert.deepEqual(await tokenFiles(root), []);
  }
});

test("development ready PID must belong to the spawned launcher tree", async () => {
  const { value } = await manager("bad-pid");
  await assert.rejects(value.start());
  assert.equal(value.getStatus().diagnostic?.code, "sidecar_ready_invalid");
});

test("times out startup and forcibly kills an uncooperative process", async () => {
  const { value } = await manager("no-ready", 50);
  await assert.rejects(value.start(), /timed out/i);
  await value.stop();
});

test("sole ownership rejects concurrent start and stop waits for in-flight startup cleanup", async () => {
  const { value, root } = await manager("no-ready");
  const starting = value.start();
  const cancelled = assert.rejects(starting);
  await assert.rejects(value.start(), /already started/);
  await value.stop();
  await cancelled;
  assert.equal(value.getStatus().state, "stopped");
  assert.equal(value.client, null);
  assert.deepEqual(await tokenFiles(root), []);
});

test("stop aborts an in-flight health request and lifecycle calls remain serialized", async () => {
  const { value } = await manager("normal", 100, { requestTimeoutMs: 5_000,
    fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })) });
  const starting = value.start(); const rejected = assert.rejects(starting);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await Promise.race([value.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error("stop hung")), 700))]);
  await rejected;
  assert.equal(value.getStatus().state, "stopped");
});

test("production forces bundled visible Chromium and fails closed when resources are absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shensi-manager-production-"));
  await (await import("node:fs/promises")).mkdir(path.join(root, "resources", "playwright"), { recursive: true });
  let environment: NodeJS.ProcessEnv | undefined;
  const { value } = await manager("normal", 100, { environment: "production", resourcesPath: path.join(root, "resources"), repositoryRoot: undefined,
    spawn: ((_file: string, _args: readonly string[], options: SpawnOptions) => { environment = options.env; return spawn(process.execPath, [fixture], options); }) as any,
    resolveCommand: () => ({ file: process.execPath, args: [fixture], cwd: path.dirname(fixture) }),
    environmentVariables: { MEDIACRAWLER_BROWSER_CHANNEL: "chrome", MEDIACRAWLER_BROWSER_DISPLAY: "virtual", PLAYWRIGHT_BROWSERS_PATH: "/hostile", PYTHONPATH: "/hostile" } });
  await value.start();
  assert.equal(environment?.MEDIACRAWLER_BROWSER_CHANNEL, "chromium");
  assert.equal(environment?.MEDIACRAWLER_BROWSER_DISPLAY, "operator");
  assert.equal(environment?.MEDIACRAWLER_BROWSER_HEADLESS, "false");
  assert.equal(environment?.PLAYWRIGHT_BROWSERS_PATH, path.join(root, "resources", "playwright"));
  assert.equal(environment?.PYTHONPATH, undefined);
  await value.stop();
  const missing = await manager("normal", 100, { environment: "production", resourcesPath: path.join(root, "missing"), repositoryRoot: undefined });
  await assert.rejects(missing.value.start());
  assert.equal(missing.value.getStatus().state, "crashed");
});

test("drains output and isolates throwing listeners and output sinks", async () => {
  let bytes = 0;
  const { value } = await manager("verbose", 100, { outputLogger: (_stream, text) => { bytes += text.length; if (bytes < 100) throw new Error("sink failed"); } });
  value.onStatus(() => { throw new Error("listener failed"); });
  await value.start();
  await value.stop();
  assert.ok(bytes > 1_000);
});

test("uses a unique per-generation secret and removes both generations", async () => {
  const paths: string[] = [];
  const { value, root } = await manager("normal", 100, { spawn: ((file: string, args: readonly string[], options: SpawnOptions) => { paths.push(String(options.env?.MEDIACRAWLER_SERVICE_SECRET_FILE)); return spawn(file, args, options); }) as any });
  await value.start(); await value.restart(); await value.stop();
  assert.equal(new Set(paths).size, 2);
  assert.deepEqual(await tokenFiles(root), []);
});

test("forced shutdown reaps a separately grouped descendant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shensi-manager-descendant-")); const pidFile = path.join(root, "descendant.pid");
  const { value } = await manager("descendant", 80, { environmentVariables: { FAKE_SIDECAR_MODE: "descendant", FAKE_DESCENDANT_PID_FILE: pidFile } });
  await value.start(); const descendantPid = Number(await readFile(pidFile, "utf8"));
  await value.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.throws(() => process.kill(descendantPid, 0));
});

for (const [mode, action] of [["cooperative-descendant", "stop"], ["crash-descendant", "crash"]] as const) {
  test(`${action} reaps a stubborn descendant even when the root exits promptly`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `shensi-manager-${mode}-`)); const pidFile = path.join(root, "descendant.pid");
    const { value } = await manager(mode, 120, { environmentVariables: { FAKE_SIDECAR_MODE: mode, FAKE_DESCENDANT_PID_FILE: pidFile } });
    await value.start(); const descendantPid = Number(await readFile(pidFile, "utf8"));
    if (action === "stop") await value.stop(); else { await new Promise((resolve) => setTimeout(resolve, 500)); await value.stop(); }
    assert.throws(() => process.kill(descendantPid, 0));
  });
}

test("restart immediately followed by stop never spawns the replacement generation", async () => {
  let spawns = 0;
  const { value } = await manager("normal", 100, { spawn: ((file: string, args: readonly string[], options: SpawnOptions) => { spawns++; return spawn(file, args, options); }) as any });
  await value.start();
  const restarting = value.restart(); const cancelled = assert.rejects(restarting);
  await value.stop(); await cancelled;
  assert.equal(spawns, 1);
  assert.equal(value.getStatus().state, "stopped");
});

test("does not signal a PID whose recorded process identity has been reused", async () => {
  let rootPid = 0, identity = "owned-start"; const signalled: number[] = [];
  const { value } = await manager("normal", 80, {
    spawn: ((file: string, args: readonly string[], options: SpawnOptions) => { const child = spawn(file, args, options); rootPid = child.pid!; return child; }) as any,
    processTable: async () => rootPid ? [{ pid: 777777, ppid: rootPid, started: identity }] : [],
    processKill: (pid, signal) => { signalled.push(pid); if (Math.abs(pid) !== 777777) process.kill(pid, signal); },
  });
  await value.start(); await new Promise((resolve) => setTimeout(resolve, 40));
  identity = "reused-start";
  await value.stop();
  assert.ok(!signalled.some((pid) => Math.abs(pid) === 777777));
});

test("listeners unsubscribe and unexpected crashes restart at most twice", async () => {
  const { value } = await manager("crash", 100);
  let calls = 0;
  const unsubscribe = value.onStatus(() => calls++);
  await value.start();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(value.getRestartCount(), 2);
  assert.equal(value.getStatus().state, "crashed");
  unsubscribe();
  const before = calls;
  await value.stop();
  assert.equal(calls, before);
});

test("restart and graceful/forced stop leave no ready client", async () => {
  const first = await manager();
  await first.value.start();
  await first.value.restart();
  assert.equal(first.value.getStatus().state, "ready");
  await first.value.stop();
  assert.equal(first.value.client, null);
  const forced = await manager("ignore-term", 30);
  await forced.value.start();
  await forced.value.stop();
  assert.equal(forced.value.getStatus().state, "stopped");
});
