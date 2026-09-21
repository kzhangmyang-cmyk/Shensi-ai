import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startDevelopmentDesktop } from "./prepare-dev-build-identity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const SHUTDOWN_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const children = new Set();
let stopping = false;

function child(executable, arguments_, options = {}) {
  const processValue = spawn(executable, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    detached: options.detached ?? false,
    shell: false,
    stdio: "inherit",
  });
  children.add(processValue);
  processValue.once("exit", () => children.delete(processValue));
  return processValue;
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  const running = [...children].filter((value) => value.exitCode === null);
  for (const value of running) value.kill("SIGTERM");
  const timeout = setTimeout(() => {
    for (const value of running) if (value.exitCode === null) value.kill("SIGKILL");
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();
  await Promise.all(running.map((value) => new Promise((resolve) => {
    if (value.exitCode !== null) resolve();
    else value.once("exit", resolve);
  })));
  clearTimeout(timeout);
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void stop(signal === "SIGINT" ? 130 : 143); });
}

try {
  const electron = await startDevelopmentDesktop({
    repositoryRoot,
    electronExecutable,
    spawnProcess: child,
  });
  electron.once("error", () => { if (!stopping) void stop(1); });
  electron.once("exit", (code) => { if (!stopping) void stop(code ?? 0); });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}
