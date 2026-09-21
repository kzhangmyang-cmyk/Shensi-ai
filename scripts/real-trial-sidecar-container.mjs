import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const TRIAL_COLIMA_PROFILE = "shensi-trial";
export const TRIAL_SIDECAR_IMAGE = "shensi-mediacrawler-trial:virtual-display";
export const DEFAULT_TRIAL_COLIMA_BINARY = "/Users/mac/bin/colima";
export const DEFAULT_TRIAL_LIMACTL_BINARY = "/Users/mac/bin/limactl";
export const DEFAULT_TRIAL_LIMA_HOME = "/Users/mac/.colima/_lima";

function exactVisualLocator(value) {
  const normalized = value ?? "disabled";
  if (normalized !== "disabled" && normalized !== "rapidocr") {
    throw new Error("DOUYIN_ACTION_VISUAL_LOCATOR_INVALID");
  }
  return normalized;
}

function safeAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)
    || /[\r\n,]/u.test(value)) {
    throw new Error(`TRIAL_SIDECAR_${name}_INVALID`);
  }
  return value;
}

function containerChildPath(volume, child, name) {
  const relativePath = relative(volume, child);
  if (!relativePath || relativePath === ".."
    || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`TRIAL_SIDECAR_${name}_OUTSIDE_VOLUME`);
  }
  return `/var/lib/shensi-mediacrawler/${relativePath.split(sep).join("/")}`;
}

function exactBoolean(value, name) {
  if (value !== "true" && value !== "false") {
    throw new Error(`TRIAL_SIDECAR_${name}_INVALID`);
  }
  return value;
}

function colimaPrefix() {
  return ["--profile", TRIAL_COLIMA_PROFILE, "ssh", "--", "docker"];
}

function colimaEnvironment(source = process.env) {
  const home = source.HOME ?? "";
  if (!home) throw new Error("TRIAL_SIDECAR_HOME_REQUIRED");
  return {
    PATH: source.PATH ?? "",
    HOME: home,
    LIMA_HOME: source.SHENSI_TRIAL_LIMA_HOME
      ?? source.LIMA_HOME
      ?? DEFAULT_TRIAL_LIMA_HOME,
    TMPDIR: source.TMPDIR ?? "/tmp",
    LANG: source.LANG ?? "C.UTF-8",
    ...Object.fromEntries(Object.entries(source).filter(([key, value]) =>
      /^(?:HTTP|HTTPS|NO|ALL)_PROXY$/iu.test(key)
      && typeof value === "string" && value.length > 0
    ))
  };
}

export function trialSidecarContainerIdentity(environment) {
  const volume = safeAbsolutePath(
    environment?.MEDIACRAWLER_ENCRYPTED_VOLUME,
    "ENCRYPTED_VOLUME"
  );
  const id = createHash("sha256").update(resolve(volume)).digest("hex");
  return {
    id,
    name: `shensi-real-trial-mediacrawler-${id.slice(0, 16)}`
  };
}

export function virtualSidecarBuildInvocation(
  repositoryRoot,
  actionVisualLocator = "disabled",
  colimaBinary = process.env.SHENSI_TRIAL_COLIMA_BIN
    ?? DEFAULT_TRIAL_COLIMA_BINARY
) {
  const root = safeAbsolutePath(repositoryRoot, "REPOSITORY_ROOT");
  const locator = exactVisualLocator(actionVisualLocator);
  return {
    command: colimaBinary,
    args: [
      ...colimaPrefix(), "build",
      "--file", resolve(root, "services/media-crawler/Dockerfile.shensi"),
      "--tag", TRIAL_SIDECAR_IMAGE,
      "--build-arg", `DOUYIN_ACTION_VISUAL_LOCATOR=${locator}`,
      "--build-arg", "HTTP_PROXY",
      "--build-arg", "HTTPS_PROXY",
      "--build-arg", "NO_PROXY",
      "--build-arg", "http_proxy",
      "--build-arg", "https_proxy",
      "--build-arg", "no_proxy",
      root
    ]
  };
}

export function virtualSidecarRunInvocation(environment, options = {}) {
  const volume = safeAbsolutePath(
    environment?.MEDIACRAWLER_ENCRYPTED_VOLUME,
    "ENCRYPTED_VOLUME"
  );
  const profile = safeAbsolutePath(
    environment?.MEDIACRAWLER_PROFILE_ROOT,
    "PROFILE_ROOT"
  );
  const output = safeAbsolutePath(
    environment?.MEDIACRAWLER_CRAWL_OUTPUT_ROOT,
    "CRAWL_OUTPUT_ROOT"
  );
  const secret = safeAbsolutePath(
    environment?.MEDIACRAWLER_SERVICE_SECRET_FILE,
    "SERVICE_SECRET_FILE"
  );
  const profileTarget = containerChildPath(volume, profile, "PROFILE_ROOT");
  const outputTarget = containerChildPath(volume, output, "CRAWL_OUTPUT_ROOT");
  const secretDirectory = dirname(secret);
  const secretTarget = `/run/secrets/${secret.slice(secretDirectory.length + 1)}`;
  const outreach = exactBoolean(
    environment?.DOUYIN_OUTREACH_ACTIONS_ENABLED ?? "false",
    "OUTREACH_GATE"
  );
  const locator = exactVisualLocator(
    environment?.DOUYIN_ACTION_VISUAL_LOCATOR
  );
  const verificationSeconds =
    environment?.DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS ?? "120";
  if (!/^[0-9]+$/u.test(verificationSeconds)) {
    throw new Error("TRIAL_SIDECAR_MANUAL_VERIFICATION_INVALID");
  }
  const identity = trialSidecarContainerIdentity(environment);
  const colimaBinary = options.colimaBinary
    ?? process.env.SHENSI_TRIAL_COLIMA_BIN
    ?? DEFAULT_TRIAL_COLIMA_BINARY;
  return {
    command: colimaBinary,
    args: [
      ...colimaPrefix(), "run",
      "--detach", "--rm", "--init",
      `--name=${identity.name}`,
      `--label=io.shensi.trial-runtime=${identity.id}`,
      "--stop-signal=SIGTERM",
      "--stop-timeout=25",
      "--publish=127.0.0.1:5612:8899",
      "--read-only",
      "--security-opt=no-new-privileges:true",
      "--cap-drop=ALL",
      "--pids-limit=256",
      "--cpus=1.5",
      "--memory=2048m",
      "--shm-size=1g",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m",
      `--mount=type=bind,source=${volume},target=/var/lib/shensi-mediacrawler`,
      `--mount=type=bind,source=${secretDirectory},target=/run/secrets,readonly`,
      `--env=MEDIACRAWLER_SERVICE_SECRET_FILE=${secretTarget}`,
      "--env=MEDIACRAWLER_ENCRYPTED_VOLUME=/var/lib/shensi-mediacrawler",
      `--env=MEDIACRAWLER_PROFILE_ROOT=${profileTarget}`,
      `--env=MEDIACRAWLER_CRAWL_OUTPUT_ROOT=${outputTarget}`,
      "--env=HOME=/tmp/shensi-browser-home",
      "--env=MEDIACRAWLER_BROWSER_HEADLESS=false",
      "--env=MEDIACRAWLER_BROWSER_CHANNEL=",
      "--env=MEDIACRAWLER_BROWSER_DISPLAY=virtual",
      "--env=HTTP_PROXY",
      "--env=HTTPS_PROXY",
      "--env=NO_PROXY",
      "--env=http_proxy",
      "--env=https_proxy",
      "--env=no_proxy",
      `--env=DOUYIN_OUTREACH_ACTIONS_ENABLED=${outreach}`,
      `--env=DOUYIN_ACTION_VISUAL_LOCATOR=${locator}`,
      `--env=DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS=${verificationSeconds}`,
      TRIAL_SIDECAR_IMAGE
    ],
    identity
  };
}

function missingContainer(error) {
  return /no such (?:container|object)/iu.test(
    `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`
  );
}

function sidecarColimaBinary(options) {
  return options.colimaBinary
    ?? process.env.SHENSI_TRIAL_COLIMA_BIN
    ?? DEFAULT_TRIAL_COLIMA_BINARY;
}

function inactiveColimaProfile(error) {
  return /colima \[profile=[^\]]+\] is not running/iu.test(
    `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`
  );
}

async function colimaProfileRunning(options = {}) {
  const runExecFile = options.execFile ?? execFile;
  const colimaBinary = sidecarColimaBinary(options);
  try {
    const result = await runExecFile(colimaBinary, [
      "--profile", TRIAL_COLIMA_PROFILE, "status", "--json"
    ], { env: colimaEnvironment(options.hostEnvironment) });
    const status = JSON.parse(String(result.stdout ?? ""));
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      throw new Error("TRIAL_SIDECAR_COLIMA_STATUS_INVALID");
    }
    return true;
  } catch (error) {
    if (inactiveColimaProfile(error)) return false;
    throw error;
  }
}

async function inspectOwnedContainer(environment, reference, options = {}) {
  const identity = trialSidecarContainerIdentity(environment);
  const runExecFile = options.execFile ?? execFile;
  const colimaBinary = sidecarColimaBinary(options);
  if (!await colimaProfileRunning(options)) {
    return { exists: false, running: false, id: null };
  }
  try {
    const result = await runExecFile(colimaBinary, [
      ...colimaPrefix(), "inspect",
      "--format={{ index .Config.Labels \"io.shensi.trial-runtime\" }}|{{.Id}}|{{.State.Running}}",
      reference
    ], { env: colimaEnvironment(options.hostEnvironment) });
    const [owner, id, running, ...extra] = String(result.stdout ?? "")
      .trim().split(/[|\t]/u);
    if (owner !== identity.id) {
      throw new Error("TRIAL_SIDECAR_CONTAINER_OWNERSHIP_MISMATCH");
    }
    if (extra.length || !/^[a-f0-9]{64}$/u.test(id)
      || (running !== "true" && running !== "false")) {
      throw new Error("TRIAL_SIDECAR_CONTAINER_INSPECTION_INVALID");
    }
    return { exists: true, running: running === "true", id };
  } catch (error) {
    if (missingContainer(error)) {
      return { exists: false, running: false, id: null };
    }
    throw error;
  }
}

export async function inspectTrialSidecarContainer(
  environment, options = {}
) {
  const identity = trialSidecarContainerIdentity(environment);
  return inspectOwnedContainer(environment, identity.name, options);
}

async function removeStoppedOwnedContainer(environment, id, options) {
  const runExecFile = options.execFile ?? execFile;
  const colimaBinary = sidecarColimaBinary(options);
  try {
    await runExecFile(colimaBinary, [
      ...colimaPrefix(), "rm", id
    ], { env: colimaEnvironment(options.hostEnvironment) });
  } catch (error) {
    if (!missingContainer(error)) throw error;
  }
}

async function stopOwnedContainer(environment, reference, options = {}) {
  const inspected = await inspectOwnedContainer(
    environment, reference, options
  );
  if (!inspected.exists) return inspected;
  if (!inspected.running) {
    await removeStoppedOwnedContainer(environment, inspected.id, options);
    return { exists: true, stopped: true, id: inspected.id };
  }
  const runExecFile = options.execFile ?? execFile;
  const colimaBinary = sidecarColimaBinary(options);
  try {
    await runExecFile(colimaBinary, [
      ...colimaPrefix(), "stop", "--time=25", inspected.id
    ], { env: colimaEnvironment(options.hostEnvironment) });
  } catch (error) {
    if (!missingContainer(error)) throw error;
  }
  return { exists: true, stopped: true, id: inspected.id };
}

export async function cleanupTrialSidecarContainer(
  environment, options = {}
) {
  const identity = trialSidecarContainerIdentity(environment);
  const result = await stopOwnedContainer(environment, identity.name, options);
  if (!result.exists) {
    return { exists: false, stopped: false, id: null };
  }
  return { exists: true, stopped: true, id: result.id };
}

function containerId(stdout) {
  const value = String(stdout ?? "").trim();
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("TRIAL_SIDECAR_CONTAINER_ID_INVALID");
  }
  return value;
}

export async function runVirtualSidecar(environment = process.env, options = {}) {
  const invocation = virtualSidecarRunInvocation(environment, options);
  const runExecFile = options.execFile ?? execFile;
  const spawn = options.spawn ?? nodeSpawn;
  const lifecycleOptions = {
    colimaBinary: invocation.command,
    execFile: runExecFile,
    hostEnvironment: options.hostEnvironment
  };
  await cleanupTrialSidecarContainer(environment, lifecycleOptions);
  const started = await runExecFile(invocation.command, invocation.args, {
    env: colimaEnvironment(options.hostEnvironment)
  });
  const id = containerId(started.stdout);
  const logs = spawn(invocation.command, [
    ...colimaPrefix(), "logs", "--follow", id
  ], {
    stdio: "inherit",
    env: colimaEnvironment(options.hostEnvironment)
  });
  let stopping = false;
  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = stopOwnedContainer(environment, id, lifecycleOptions);
    return stopPromise;
  };
  let signalStopError;
  const requestStop = () => {
    void stop().catch((error) => {
      signalStopError ??= error;
    });
  };
  const signalSource = options.signalSource ?? process;
  signalSource.once("SIGINT", requestStop);
  signalSource.once("SIGTERM", requestStop);
  try {
    const waited = await runExecFile(invocation.command, [
      ...colimaPrefix(), "wait", id
    ], { env: colimaEnvironment(options.hostEnvironment) });
    if (stopPromise) await stopPromise;
    if (signalStopError) throw signalStopError;
    const exitCode = String(waited.stdout ?? "").trim();
    if (!stopping && exitCode !== "0") {
      throw new Error(`TRIAL_SIDECAR_CONTAINER_EXIT:${exitCode || "unknown"}`);
    }
  } finally {
    signalSource.removeListener("SIGINT", requestStop);
    signalSource.removeListener("SIGTERM", requestStop);
    await stopOwnedContainer(environment, id, lifecycleOptions).catch(() => {});
    try { logs.kill("SIGTERM"); } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runVirtualSidecar().catch((error) => {
    console.error(error instanceof Error
      ? error.message : "TRIAL_SIDECAR_CONTAINER_FAILED");
    process.exitCode = 1;
  });
}
