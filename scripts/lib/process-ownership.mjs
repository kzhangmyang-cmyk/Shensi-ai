import { createHash } from "node:crypto";
import { execFile as nativeExecFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nativeExecFile);
const NONCE = /^[a-f0-9]{32}$/u;
const NAME = /^[a-z0-9-]+$/u;

function failure(code) {
  return new Error(code);
}

function boundedText(value, maximum = 4096) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function validRecord(record, { requireStartToken = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || !NAME.test(record.name ?? "")
    || !Number.isSafeInteger(record.pid) || record.pid <= 1
    || !boundedText(record.command)
    || !Array.isArray(record.args)
    || record.args.some((argument) => typeof argument !== "string"
      || argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 8192)
    || !NONCE.test(record.nonce ?? "")
    || (record.path !== undefined
      && (!boundedText(record.path) || !isAbsolute(record.path)))) return false;
  if (requireStartToken && !boundedText(record.processStartToken, 512)) return false;
  if (record.processStartToken !== undefined
    && !boundedText(record.processStartToken, 512)) return false;
  return true;
}

export function expectedOwnedProcessCommand(record) {
  if (!validRecord(record)) throw failure("PROCESS_OWNERSHIP_RECORD_INVALID");
  return [record.command, ...record.args].join(" ");
}

async function defaultReadProcessField(pid, field) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw failure("PROCESS_OWNERSHIP_INSPECTION_FAILED");
  }
  try {
    const result = await execFile("/bin/ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      // Preserve the exact UTF-8 argv text. macOS `ps` renders non-ASCII
      // workspace paths as control-sequence escapes under the C locale,
      // which makes a live owned process look like a reused PID.
      env: {
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      maxBuffer: 16_384,
      shell: false,
      timeout: 2_000
    });
    const value = String(result.stdout ?? "").trimEnd();
    return value.length === 0 ? null : value;
  } catch (caught) {
    if (Number(caught?.code) === 1) return null;
    throw failure("PROCESS_OWNERSHIP_INSPECTION_FAILED");
  }
}

export async function readOwnedProcessCommand(pid) {
  return defaultReadProcessField(pid, "command");
}

export async function readOwnedProcessStartToken(pid) {
  const started = await defaultReadProcessField(pid, "lstart");
  if (started === null) return null;
  if (!boundedText(started, 512)) {
    throw failure("PROCESS_OWNERSHIP_INSPECTION_FAILED");
  }
  return createHash("sha256").update(`${pid}\0${started}`).digest("hex");
}

function readers(options) {
  const readProcessCommand = options.readProcessCommand ?? readOwnedProcessCommand;
  const readProcessStartToken = options.readProcessStartToken ?? readOwnedProcessStartToken;
  if (typeof readProcessCommand !== "function" || typeof readProcessStartToken !== "function") {
    throw failure("PROCESS_OWNERSHIP_ADAPTER_INVALID");
  }
  return { readProcessCommand, readProcessStartToken };
}

async function snapshot(record, options) {
  const { readProcessCommand, readProcessStartToken } = readers(options);
  let firstStart;
  let command;
  let secondStart;
  try {
    firstStart = await readProcessStartToken(record.pid);
    command = await readProcessCommand(record.pid);
    secondStart = await readProcessStartToken(record.pid);
  } catch (caught) {
    if (caught?.message?.startsWith("PROCESS_OWNERSHIP_")) throw caught;
    throw failure("PROCESS_OWNERSHIP_INSPECTION_FAILED");
  }
  if (firstStart === null || command === null || secondStart === null) return null;
  if (!boundedText(firstStart, 512) || !boundedText(secondStart, 512)
    || !boundedText(command, 32_768)) {
    throw failure("PROCESS_OWNERSHIP_INSPECTION_FAILED");
  }
  if (firstStart !== secondStart) throw failure("PROCESS_OWNERSHIP_PROCESS_CHANGED");
  return { command, processStartToken: firstStart };
}

export async function attestOwnedProcess(record, options = {}) {
  if (!validRecord(record)) throw failure("PROCESS_OWNERSHIP_RECORD_INVALID");
  const observed = await snapshot(record, options);
  if (observed === null) throw failure("PROCESS_OWNERSHIP_PROCESS_MISSING");
  if (observed.command !== expectedOwnedProcessCommand(record)
    || !observed.command.includes(`--runtime-nonce ${record.nonce}`)) {
    throw failure("PROCESS_OWNERSHIP_PROCESS_REUSED");
  }
  return Object.freeze({ ...record, processStartToken: observed.processStartToken });
}

export async function inspectOwnedProcess(record, options = {}) {
  if (!validRecord(record, { requireStartToken: true })) {
    throw failure("PROCESS_OWNERSHIP_RECORD_INVALID");
  }
  const observed = await snapshot(record, options);
  if (observed === null) return "missing";
  if (observed.processStartToken !== record.processStartToken
    || observed.command !== expectedOwnedProcessCommand(record)
    || !observed.command.includes(`--runtime-nonce ${record.nonce}`)) return "stale";
  return "owned";
}

function defaultSignalProcessGroup(pid, signal) {
  process.kill(-pid, signal);
}

async function defaultWaitForExit(record, options) {
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const waitMilliseconds = options.waitMilliseconds?.(record) ?? 5_000;
  if (!Number.isSafeInteger(waitMilliseconds) || waitMilliseconds < 0 || waitMilliseconds > 120_000
    || typeof sleep !== "function") throw failure("PROCESS_OWNERSHIP_ADAPTER_INVALID");
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    if (await inspectOwnedProcess(record, options) !== "owned") return true;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return await inspectOwnedProcess(record, options) !== "owned";
}

async function removeOwnedRecord(record, options) {
  if (!record.path) return;
  const removeRecord = options.removeRecord;
  if (typeof removeRecord !== "function") {
    throw failure("PROCESS_OWNERSHIP_RECORD_REMOVER_REQUIRED");
  }
  await removeRecord(record.path);
}

export async function stopOwnedProcesses(records, options = {}) {
  if (!Array.isArray(records) || records.some((record) => !validRecord(record, { requireStartToken: true }))) {
    throw failure("PROCESS_OWNERSHIP_RECORD_INVALID");
  }
  const signalProcessGroup = options.signalProcessGroup ?? defaultSignalProcessGroup;
  const waitForExit = options.waitForExit
    ? async (record) => options.waitForExit(record)
    : async (record) => defaultWaitForExit(record, options);
  if (typeof signalProcessGroup !== "function" || typeof waitForExit !== "function") {
    throw failure("PROCESS_OWNERSHIP_ADAPTER_INVALID");
  }
  const result = { stopped: [], missing: [], stale: [] };

  for (const record of [...records].reverse()) {
    const initial = await inspectOwnedProcess(record, options);
    if (initial === "missing") {
      await removeOwnedRecord(record, options);
      result.missing.push(record.name);
      continue;
    }
    if (initial === "stale") {
      result.stale.push(record.name);
      continue;
    }

    try {
      await signalProcessGroup(record.pid, "SIGTERM");
    } catch (caught) {
      if (caught?.code !== "ESRCH" || await inspectOwnedProcess(record, options) === "owned") {
        throw failure("PROCESS_OWNERSHIP_SIGNAL_FAILED");
      }
    }
    if (await waitForExit(record)) {
      await removeOwnedRecord(record, options);
      result.stopped.push(record.name);
      continue;
    }

    const beforeKill = await inspectOwnedProcess(record, options);
    if (beforeKill !== "owned") {
      await removeOwnedRecord(record, options);
      result.stopped.push(record.name);
      continue;
    }
    try {
      await signalProcessGroup(record.pid, "SIGKILL");
    } catch (caught) {
      if (caught?.code !== "ESRCH" || await inspectOwnedProcess(record, options) === "owned") {
        throw failure("PROCESS_OWNERSHIP_SIGNAL_FAILED");
      }
    }
    if (await waitForExit(record) || await inspectOwnedProcess(record, options) !== "owned") {
      await removeOwnedRecord(record, options);
      result.stopped.push(record.name);
    } else {
      result.stale.push(record.name);
    }
  }
  return Object.freeze({
    stopped: Object.freeze(result.stopped),
    missing: Object.freeze(result.missing),
    stale: Object.freeze(result.stale)
  });
}
