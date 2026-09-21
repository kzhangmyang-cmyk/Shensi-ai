import { execFile as nativeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat as nativeLstat,
  readFile as nativeReadFile,
  unlink
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { isTrialPortAvailable } from "./real-trial-config.mjs";
import {
  readRuntimeRecords,
  startTrialRuntime
} from "./real-trial-runtime.mjs";
import { verifyTrialRuntime } from "./real-trial-verify.mjs";
import {
  attestOwnedProcess,
  inspectOwnedProcess,
  stopOwnedProcesses
} from "./lib/process-ownership.mjs";

const execFile = promisify(nativeExecFile);
const TRIAL_MYSQL = Object.freeze({ name: "mysql", port: 3310 });
const TRIAL_WRITERS = Object.freeze([
  Object.freeze({ name: "tunnel", port: null }),
  Object.freeze({ name: "sidecar", port: 5612 }),
  Object.freeze({ name: "backend", port: 5611 }),
  Object.freeze({ name: "frontend", port: 5610 }),
  Object.freeze({ name: "gateway", port: 5608 })
]);
const ALLOWED_NAMES = new Set([
  TRIAL_MYSQL.name,
  ...TRIAL_WRITERS.map(({ name }) => name)
]);
const TRIAL_PROCESSES = Object.freeze([
  TRIAL_MYSQL,
  ...TRIAL_WRITERS
]);
const RECOVERY_PROCESSES = Object.freeze([
  TRIAL_MYSQL,
  TRIAL_WRITERS[0],
  Object.freeze({ name: "backend-bootstrap", port: 5611 }),
  ...TRIAL_WRITERS.slice(1)
]);
const RECOVERY_ALLOWED_NAMES = new Set(
  RECOVERY_PROCESSES.map(({ name }) => name)
);
const LOCAL_TRIAL_ORIGIN = "http://127.0.0.1:5608";
const TRIAL_DATABASE = "shensi_trial";
const TRIAL_DATABASE_USER = "shensi_trial_app";
const SHA256 = /^[a-f0-9]{64}$/u;

function failure(code, name = null) {
  return new Error(name === null ? code : `${code}:${name}`);
}

function runtimePaths(repositoryRoot, configuredRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.includes("\0")) {
    throw failure("TRIAL_CUTOVER_REPOSITORY_ROOT_INVALID");
  }
  const root = resolve(repositoryRoot);
  if (root !== repositoryRoot) {
    throw failure("TRIAL_CUTOVER_REPOSITORY_ROOT_INVALID");
  }
  const runtimeRoot = resolve(root, ".runtime/real-trial");
  if (configuredRoot !== undefined
    && (typeof configuredRoot !== "string"
      || resolve(configuredRoot) !== runtimeRoot)) {
    throw failure("TRIAL_CUTOVER_RUNTIME_ROOT_INVALID");
  }
  return Object.freeze({
    repositoryRoot: root,
    runtimeRoot,
    pidsDirectory: resolve(runtimeRoot, "pids"),
    environmentFile: resolve(runtimeRoot, "trial.env"),
    mysqlSecretFile: resolve(runtimeRoot, "secrets/mysql_app_password"),
    mysqlDatadir: resolve(runtimeRoot, "state/mysql"),
    mysqlServerIdentityFile: resolve(runtimeRoot, "state/mysql/auto.cnf")
  });
}

async function defaultCreateMysqlConnection(input) {
  const mysql = await import(new URL(
    "../backend/node_modules/mysql2/promise.js", import.meta.url
  ));
  return mysql.createConnection(input);
}

async function identityFile(path, dependencies, options = {}) {
  const code = "TRIAL_CUTOVER_MYSQL_IDENTITY_CONFIG_INVALID";
  let info;
  try {
    info = await dependencies.lstat(path);
  } catch {
    throw failure(code);
  }
  const maximum = options.maximum ?? 65_536;
  const forbiddenMode = options.ownerOnly ? 0o077 : 0o027;
  if (!info?.isFile?.() || info.isSymbolicLink?.()
    || (info.mode & forbiddenMode) !== 0
    || !Number.isSafeInteger(info.size) || info.size < 1
    || info.size > maximum) {
    throw failure(code);
  }
  let value;
  try {
    value = await dependencies.readFile(path, "utf8");
  } catch {
    throw failure(code);
  }
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") !== info.size) {
    throw failure(code);
  }
  return value;
}

function singleEnvironmentValue(contents, name) {
  const prefix = `${name}=`;
  const matches = contents.split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_CONFIG_INVALID");
  }
  return matches[0].slice(prefix.length);
}

function trialMysqlConnectionConfiguration(environment, secret, request) {
  const code = "TRIAL_CUTOVER_MYSQL_IDENTITY_CONFIG_INVALID";
  if (singleEnvironmentValue(environment, "MYSQL_PORT")
      !== String(request.expectedPort)
    || singleEnvironmentValue(
      environment, "SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE"
    ) !== request.secretFile
    || secret.length < 1 || secret !== secret.trim()
    || /[\0\r\n]/u.test(secret)) {
    throw failure(code);
  }
  let url;
  let user;
  let password;
  let database;
  try {
    url = new URL(singleEnvironmentValue(environment, "DATABASE_URL"));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  } catch {
    throw failure(code);
  }
  if (url.protocol !== "mysql:" || url.hostname !== "127.0.0.1"
    || url.port !== String(request.expectedPort)
    || user !== request.expectedUser
    || password !== secret
    || database !== request.expectedDatabase
    || url.search !== "" || url.hash !== "") {
    throw failure(code);
  }
  return Object.freeze({
    host: "127.0.0.1",
    port: request.expectedPort,
    user,
    password: secret,
    database,
    connectTimeout: 3_000
  });
}

function expectedServerUuid(contents) {
  const matches = [...contents.matchAll(
    /^server-uuid=([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/gmu
  )];
  if (matches.length !== 1) {
    throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_CONFIG_INVALID");
  }
  return matches[0][1];
}

async function defaultVerifyTrialMysqlIdentity(request, dependencies) {
  const environment = await identityFile(
    request.environmentFile, dependencies, { ownerOnly: true }
  );
  const secret = await identityFile(
    request.secretFile, dependencies, { ownerOnly: true, maximum: 4_096 }
  );
  const serverUuid = expectedServerUuid(await identityFile(
    request.serverIdentityFile, dependencies, { maximum: 4_096 }
  ));
  const configuration = trialMysqlConnectionConfiguration(
    environment, secret, request
  );
  let connection;
  let rows;
  try {
    connection = await dependencies.createMysqlConnection(configuration);
    if (!connection || typeof connection.execute !== "function"
      || typeof connection.end !== "function") {
      throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID");
    }
    [rows] = await connection.execute(
      "SELECT CURRENT_USER() AS authenticated_user, "
      + "DATABASE() AS database_name, "
      + "@@port AS server_port, @@datadir AS data_directory, "
      + "@@server_uuid AS server_identity, 1 AS sql_ok"
    );
  } catch (caught) {
    if (caught?.message === "TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID") {
      throw caught;
    }
    throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID");
  } finally {
    if (connection && typeof connection.end === "function") {
      try {
        await connection.end();
      } catch {
        throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID");
      }
    }
  }
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!row || typeof row !== "object"
    || row.authenticated_user !== `${request.expectedUser}@127.0.0.1`
    || row.database_name !== request.expectedDatabase
    || Number(row.server_port) !== request.expectedPort
    || typeof row.data_directory !== "string"
    || !isAbsolute(row.data_directory) || row.data_directory.includes("\0")
    || resolve(row.data_directory) !== request.expectedDatadir
    || row.server_identity !== serverUuid
    || Number(row.sql_ok) !== 1) {
    throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID");
  }
  return Object.freeze({
    authenticatedUser: row.authenticated_user,
    database: row.database_name,
    port: request.expectedPort,
    datadir: "retained-trial",
    serverIdentitySha256: createHash("sha256")
      .update(serverUuid).digest("hex"),
    sql: "ok"
  });
}

function mysqlIdentityRequest(paths) {
  return Object.freeze({
    runtimeRoot: paths.runtimeRoot,
    environmentFile: paths.environmentFile,
    secretFile: paths.mysqlSecretFile,
    serverIdentityFile: paths.mysqlServerIdentityFile,
    expectedDatadir: paths.mysqlDatadir,
    expectedDatabase: TRIAL_DATABASE,
    expectedPort: TRIAL_MYSQL.port,
    expectedUser: TRIAL_DATABASE_USER
  });
}

function safeMysqlIdentitySummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.authenticatedUser
      !== `${TRIAL_DATABASE_USER}@127.0.0.1`
    || value.database !== TRIAL_DATABASE
    || value.port !== TRIAL_MYSQL.port
    || value.datadir !== "retained-trial"
    || !SHA256.test(value.serverIdentitySha256 ?? "")
    || value.sql !== "ok") {
    throw failure("TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID");
  }
  return Object.freeze({
    authenticatedUser: value.authenticatedUser,
    database: value.database,
    port: value.port,
    datadir: value.datadir,
    serverIdentitySha256: value.serverIdentitySha256,
    sql: value.sql
  });
}

async function defaultReadProcessInventory() {
  try {
    const result = await execFile("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 1_048_576,
      shell: false,
      timeout: 3_000
    });
    return String(result.stdout ?? "").split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      return Number.isSafeInteger(pid) && pid > 1
        ? [{ pid, command: match[2] }]
        : [];
    });
  } catch {
    throw failure("TRIAL_CUTOVER_PROCESS_INVENTORY_FAILED");
  }
}

function validateRecords(records, allowedNames = ALLOWED_NAMES) {
  if (!Array.isArray(records)) {
    throw failure("TRIAL_CUTOVER_RECORDS_INVALID");
  }
  const byName = new Map();
  const pids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object"
      || !allowedNames.has(record.name)) {
      throw failure("TRIAL_CUTOVER_RECORD_UNEXPECTED");
    }
    if (byName.has(record.name) || pids.has(record.pid)) {
      throw failure("TRIAL_CUTOVER_RECORDS_AMBIGUOUS");
    }
    byName.set(record.name, record);
    pids.add(record.pid);
  }
  return { byName, pids };
}

function validateInventory(inventory) {
  if (!Array.isArray(inventory)
    || inventory.some((entry) => !entry || typeof entry !== "object"
      || !Number.isSafeInteger(entry.pid) || entry.pid <= 1
      || typeof entry.command !== "string" || entry.command.length === 0
      || entry.command.includes("\0"))) {
    throw failure("TRIAL_CUTOVER_PROCESS_INVENTORY_INVALID");
  }
  return inventory;
}

function mapOwnershipFailure(caught, name) {
  if (caught?.message === "PROCESS_OWNERSHIP_PROCESS_MISSING") return "missing";
  if (caught?.message === "PROCESS_OWNERSHIP_PROCESS_REUSED"
    || caught?.message === "PROCESS_OWNERSHIP_PROCESS_CHANGED") {
    throw failure("TRIAL_CUTOVER_PROCESS_REUSED", name);
  }
  if (caught?.message?.startsWith("PROCESS_OWNERSHIP_")) {
    throw failure("TRIAL_CUTOVER_PROCESS_ATTESTATION_FAILED", name);
  }
  throw caught;
}

function publicSnapshot(paths, mysql, writers, identity) {
  const result = {
    runtimeRoot: paths.runtimeRoot,
    mysql: Object.freeze({
      name: "mysql", pid: mysql.pid, state: "owned", port: 3310,
      identity
    }),
    writers: Object.freeze(writers.map((writer) => Object.freeze({
      name: writer.name,
      pid: writer.status === "owned" ? writer.record.pid : null,
      state: writer.status,
      port: writer.port
    })))
  };
  return Object.freeze(result);
}

function freezeSnapshotFingerprint(snapshot) {
  const lifecycle = (entry) => entry?.state ?? entry?.status;
  if (!snapshot || typeof snapshot !== "object"
    || snapshot.mysql?.name !== "mysql"
    || lifecycle(snapshot.mysql) !== "owned"
    || !Number.isSafeInteger(snapshot.mysql.pid)
    || !Array.isArray(snapshot.writers)
    || snapshot.writers.length !== TRIAL_WRITERS.length) {
    throw failure("TRIAL_CUTOVER_FREEZE_INPUT_INVALID");
  }
  const writers = snapshot.writers.map((writer) => ({
    name: writer?.name,
    pid: writer?.pid,
    state: lifecycle(writer)
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const expectedNames = [...TRIAL_WRITERS]
    .map(({ name }) => name).sort();
  if (writers.some((writer, index) => writer.name !== expectedNames[index]
    || !["owned", "absent"].includes(writer.state)
    || (writer.state === "owned"
      ? !Number.isSafeInteger(writer.pid) || writer.pid <= 1
      : writer.pid !== null))) {
    throw failure("TRIAL_CUTOVER_FREEZE_INPUT_INVALID");
  }
  return JSON.stringify({
    mysql: { name: "mysql", pid: snapshot.mysql.pid, state: "owned" },
    writers
  });
}

function validateFreezeInput(input) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.liveWriters)) {
    throw failure("TRIAL_CUTOVER_FREEZE_INPUT_INVALID");
  }
  const fingerprint = freezeSnapshotFingerprint(input.snapshot);
  const expectedLive = input.snapshot.writers
    .filter((writer) => (writer.state ?? writer.status) === "owned")
    .map(({ name, pid }) => `${name}:${pid}`).sort();
  const providedLive = input.liveWriters
    .map(({ name, pid }) => `${name}:${pid}`).sort();
  if (JSON.stringify(expectedLive) !== JSON.stringify(providedLive)) {
    throw failure("TRIAL_CUTOVER_FREEZE_INPUT_INVALID");
  }
  return fingerprint;
}

function exactRuntimeRecords(records) {
  if (!Array.isArray(records) || records.length !== ALLOWED_NAMES.size) {
    return false;
  }
  const names = records.map((record) => record?.name);
  return names.every((name) => ALLOWED_NAMES.has(name))
    && new Set(names).size === ALLOWED_NAMES.size;
}

async function privateTrialPassword(paths, dependencies) {
  const path = resolve(paths.runtimeRoot, "secrets/trial_app_password");
  let info;
  try {
    info = await dependencies.lstat(path);
  } catch {
    throw failure("TRIAL_CUTOVER_LOGIN_SECRET_INVALID");
  }
  if (!info?.isFile?.() || info.isSymbolicLink?.()
    || (info.mode & 0o077) !== 0
    || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > 4_096) {
    throw failure("TRIAL_CUTOVER_LOGIN_SECRET_INVALID");
  }
  let password;
  try {
    password = await dependencies.readFile(path, "utf8");
  } catch {
    throw failure("TRIAL_CUTOVER_LOGIN_SECRET_INVALID");
  }
  if (typeof password !== "string" || password.length === 0
    || Buffer.byteLength(password, "utf8") !== info.size
    || password !== password.trim()
    || /[\0\r\n]/u.test(password)) {
    throw failure("TRIAL_CUTOVER_LOGIN_SECRET_INVALID");
  }
  return password;
}

async function recoveryRequest(fetchImpl, path, init = {}) {
  try {
    const response = await fetchImpl(`${LOCAL_TRIAL_ORIGIN}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response || typeof response !== "object") {
      throw failure("TRIAL_CUTOVER_RECOVERY_RESPONSE_INVALID");
    }
    return response;
  } catch (caught) {
    if (caught?.message?.startsWith("TRIAL_CUTOVER_")) throw caught;
    throw failure("TRIAL_CUTOVER_RECOVERY_REQUEST_FAILED");
  }
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw failure("TRIAL_CUTOVER_RECOVERY_RESPONSE_INVALID");
  }
}

export function createTrialCutoverAdapter(repositoryRoot, options = {}) {
  const paths = runtimePaths(repositoryRoot, options.runtimeRoot);
  const mysqlIdentityDependencies = Object.freeze({
    lstat: options.lstat ?? nativeLstat,
    readFile: options.readFile ?? nativeReadFile,
    createMysqlConnection: options.createMysqlConnection
      ?? defaultCreateMysqlConnection
  });
  const dependencies = {
    readRuntimeRecords: options.readRuntimeRecords ?? readRuntimeRecords,
    attestOwnedProcess: options.attestOwnedProcess ?? attestOwnedProcess,
    inspectOwnedProcess: options.inspectOwnedProcess ?? inspectOwnedProcess,
    readProcessInventory: options.readProcessInventory ?? defaultReadProcessInventory,
    isPortAvailable: options.isPortAvailable ?? isTrialPortAvailable,
    verifyMysqlIdentity: options.verifyMysqlIdentity
      ?? ((request) => defaultVerifyTrialMysqlIdentity(
        request, mysqlIdentityDependencies
      )),
    stopOwnedProcesses: options.stopOwnedProcesses ?? stopOwnedProcesses,
    startTrialRuntime: options.startTrialRuntime ?? startTrialRuntime,
    verifyTrialRuntime: options.verifyTrialRuntime ?? verifyTrialRuntime,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    lstat: options.lstat ?? nativeLstat,
    readFile: options.readFile ?? nativeReadFile
  };
  if (Object.values(dependencies).some((dependency) => typeof dependency !== "function")) {
    throw failure("TRIAL_CUTOVER_ADAPTER_INVALID");
  }
  const recoveryStartOptions = options.recoveryStartOptions ?? {};
  if (!recoveryStartOptions || typeof recoveryStartOptions !== "object"
    || Array.isArray(recoveryStartOptions)) {
    throw failure("TRIAL_CUTOVER_RECOVERY_OPTIONS_INVALID");
  }
  const ownershipOptions = Object.freeze({
    ...(options.readProcessCommand
      ? { readProcessCommand: options.readProcessCommand }
      : {}),
    ...(options.readProcessStartToken
      ? { readProcessStartToken: options.readProcessStartToken }
      : {}),
    ...(options.signalProcessGroup
      ? { signalProcessGroup: options.signalProcessGroup }
      : {}),
    ...(options.waitForExit ? { waitForExit: options.waitForExit } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    waitMilliseconds: options.waitMilliseconds ?? ((record) => (
      record.name === "sidecar" ? 30_000 : 5_000
    )),
    removeRecord: options.removeRecord ?? (async (path) => {
      await unlink(path).catch((caught) => {
        if (caught?.code !== "ENOENT") throw caught;
      });
    })
  });

  const inspectDetailed = async () => {
    const runtime = Object.freeze({
      root: paths.runtimeRoot,
      pidsDirectory: paths.pidsDirectory
    });
    const { byName, pids } = validateRecords(
      await dependencies.readRuntimeRecords(runtime)
    );
    const mysqlRecord = byName.get(TRIAL_MYSQL.name);
    if (!mysqlRecord) throw failure("TRIAL_CUTOVER_MYSQL_RECORD_REQUIRED");
    let mysql;
    try {
      mysql = await dependencies.attestOwnedProcess(mysqlRecord, ownershipOptions);
    } catch (caught) {
      mapOwnershipFailure(caught, TRIAL_MYSQL.name);
      throw failure("TRIAL_CUTOVER_MYSQL_NOT_OWNED");
    }
    if (await dependencies.isPortAvailable(TRIAL_MYSQL.port)) {
      throw failure("TRIAL_CUTOVER_MYSQL_UNHEALTHY");
    }
    const identity = safeMysqlIdentitySummary(
      await dependencies.verifyMysqlIdentity(mysqlIdentityRequest(paths))
    );

    const inventory = validateInventory(await dependencies.readProcessInventory());
    if (inventory.some(({ pid, command }) => !pids.has(pid)
      && command.includes("real-trial-child.mjs"))) {
      throw failure("TRIAL_CUTOVER_UNOWNED_TRIAL_PROCESS");
    }

    const writers = [];
    for (const definition of TRIAL_WRITERS) {
      const record = byName.get(definition.name);
      if (record) {
        try {
          writers.push({
            ...definition,
            status: "owned",
            record: await dependencies.attestOwnedProcess(record, ownershipOptions)
          });
          continue;
        } catch (caught) {
          if (mapOwnershipFailure(caught, definition.name) !== "missing") {
            throw caught;
          }
        }
      }
      if (definition.port !== null
        && !await dependencies.isPortAvailable(definition.port)) {
        throw failure("TRIAL_CUTOVER_WRITER_ABSENCE_UNPROVEN", definition.name);
      }
      writers.push({ ...definition, status: "absent", record: null });
    }
    return Object.freeze({
      runtime,
      mysql,
      identity,
      writers: Object.freeze(writers)
    });
  };

  const stopRecordedProcessesForRestart = async () => {
    const runtime = Object.freeze({
      root: paths.runtimeRoot,
      pidsDirectory: paths.pidsDirectory
    });
    const { byName, pids } = validateRecords(
      await dependencies.readRuntimeRecords(runtime),
      RECOVERY_ALLOWED_NAMES
    );
    const inventory = validateInventory(await dependencies.readProcessInventory());
    if (inventory.some(({ pid, command }) => !pids.has(pid)
      && command.includes("real-trial-child.mjs"))) {
      throw failure("TRIAL_CUTOVER_UNOWNED_TRIAL_PROCESS");
    }

    const owned = [];
    for (const { name } of RECOVERY_PROCESSES) {
      const record = byName.get(name);
      if (!record) continue;
      try {
        owned.push(await dependencies.attestOwnedProcess(
          record, ownershipOptions
        ));
      } catch (caught) {
        if (mapOwnershipFailure(caught, name) !== "missing") throw caught;
        await ownershipOptions.removeRecord(record.path);
      }
    }

    if (owned.length > 0) {
      const outcome = await dependencies.stopOwnedProcesses(
        owned, ownershipOptions
      );
      const requestedNames = new Set(owned.map(({ name }) => name));
      const outcomeNames = [
        ...(Array.isArray(outcome?.stopped) ? outcome.stopped : []),
        ...(Array.isArray(outcome?.missing) ? outcome.missing : []),
        ...(Array.isArray(outcome?.stale) ? outcome.stale : [])
      ];
      if (!Array.isArray(outcome?.stopped)
        || !Array.isArray(outcome?.missing)
        || !Array.isArray(outcome?.stale)
        || outcome.stale.length > 0
        || new Set(outcomeNames).size !== outcomeNames.length
        || outcomeNames.some((name) => !requestedNames.has(name))
        || requestedNames.size !== outcome.stopped.length
          + outcome.missing.length) {
        throw failure("TRIAL_CUTOVER_RECOVERY_STOP_INCOMPLETE");
      }
    }

    for (const { name, port } of TRIAL_PROCESSES) {
      if (port === null) continue;
      if (!await dependencies.isPortAvailable(port)) {
        throw failure("TRIAL_CUTOVER_RECOVERY_PORT_STILL_BOUND", name);
      }
    }
  };

  return Object.freeze({
    runtimeRoot: paths.runtimeRoot,
    async inspect() {
      const snapshot = await inspectDetailed();
      return publicSnapshot(
        paths, snapshot.mysql, snapshot.writers, snapshot.identity
      );
    },
    async freezeWriters(input) {
      const expectedSnapshot = validateFreezeInput(input);
      const snapshot = await inspectDetailed();
      if (expectedSnapshot !== null
        && freezeSnapshotFingerprint(publicSnapshot(
          paths, snapshot.mysql, snapshot.writers, snapshot.identity
        )) !== expectedSnapshot) {
        throw failure("TRIAL_CUTOVER_SNAPSHOT_CHANGED");
      }
      const liveWriters = snapshot.writers
        .filter(({ status }) => status === "owned")
        .map(({ record }) => record);
      const stopped = liveWriters.length === 0
        ? { stopped: [], missing: [], stale: [] }
        : await dependencies.stopOwnedProcesses(liveWriters, ownershipOptions);
      const requestedNames = new Set(liveWriters.map(({ name }) => name));
      const outcomeNames = [
        ...(Array.isArray(stopped?.stopped) ? stopped.stopped : []),
        ...(Array.isArray(stopped?.missing) ? stopped.missing : []),
        ...(Array.isArray(stopped?.stale) ? stopped.stale : [])
      ];
      if (!Array.isArray(stopped?.stopped)
        || !Array.isArray(stopped?.missing)
        || !Array.isArray(stopped?.stale)
        || new Set(outcomeNames).size !== outcomeNames.length
        || outcomeNames.some((name) => !requestedNames.has(name))
        || stopped.stale.length > 0
        || requestedNames.size !== stopped.stopped.length + stopped.missing.length) {
        throw failure("TRIAL_CUTOVER_WRITER_STOP_INCOMPLETE");
      }
      if (await dependencies.inspectOwnedProcess(
        snapshot.mysql, ownershipOptions
      ) !== "owned") {
        throw failure("TRIAL_CUTOVER_MYSQL_OWNERSHIP_LOST");
      }
      const releasedPorts = [];
      for (const { name, port } of TRIAL_WRITERS) {
        if (port === null) continue;
        if (!await dependencies.isPortAvailable(port)) {
          throw failure("TRIAL_CUTOVER_WRITER_PORT_STILL_BOUND", name);
        }
        releasedPorts.push(port);
      }
      const stoppedNames = new Set([
        ...stopped.stopped,
        ...stopped.missing
      ]);
      return Object.freeze({
        mysql: Object.freeze({
          name: "mysql",
          pid: snapshot.mysql.pid,
          state: "owned",
          port: TRIAL_MYSQL.port
        }),
        stopped: Object.freeze(TRIAL_WRITERS
          .filter(({ name }) => stoppedNames.has(name))
          .map(({ name }) => name)),
        absent: Object.freeze(snapshot.writers
          .filter(({ status }) => status === "absent")
          .map(({ name }) => name)),
        releasedPorts: Object.freeze(releasedPorts.sort((a, b) => a - b))
      });
    },
    async restart(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || (input.onStage !== undefined
          && typeof input.onStage !== "function")) {
        throw failure("TRIAL_CUTOVER_RECOVERY_OPTIONS_INVALID");
      }
      const onStage = input.onStage ?? (async () => undefined);
      await stopRecordedProcessesForRestart();
      await onStage("after-trial-process-stop");
      const runtimeStage = async (stage, ...details) => {
        if (stage === "mysql-ready" || stage === "runtime-ready") {
          await onStage(stage, ...details);
        }
      };
      const runtime = await dependencies.startTrialRuntime(
        paths.repositoryRoot,
        {
          ...recoveryStartOptions,
          runtimeRoot: paths.runtimeRoot,
          runtimeStage
        }
      );
      if (!runtime || typeof runtime !== "object"
        || resolve(runtime.root ?? "") !== paths.runtimeRoot
        || typeof runtime.origin !== "string" || runtime.origin.length === 0
        || !exactRuntimeRecords(runtime.records)) {
        throw failure("TRIAL_CUTOVER_RESTART_INVALID");
      }
      return runtime;
    },
    async verifyRecovered(runtime) {
      if (!runtime || typeof runtime !== "object"
        || resolve(runtime.root ?? "") !== paths.runtimeRoot) {
        throw failure("TRIAL_CUTOVER_RECOVERY_RUNTIME_INVALID");
      }
      const mysqlIdentity = safeMysqlIdentitySummary(
        await dependencies.verifyMysqlIdentity(mysqlIdentityRequest(paths))
      );
      await dependencies.verifyTrialRuntime({
        origin: LOCAL_TRIAL_ORIGIN,
        fetchImpl: dependencies.fetchImpl
      });
      const healthResponse = await recoveryRequest(
        dependencies.fetchImpl, "/api/health", {
          method: "GET",
          headers: { accept: "application/json" }
        }
      );
      const health = await responseJson(healthResponse);
      if (healthResponse.ok !== true || health?.ok !== true
        || health?.store !== "mysql") {
        throw failure("TRIAL_CUTOVER_RECOVERY_HEALTH_INVALID");
      }
      const password = await privateTrialPassword(paths, dependencies);
      const loginResponse = await recoveryRequest(
        dependencies.fetchImpl, "/api/auth/login", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            email: "test@shensi.local",
            password
          })
        }
      );
      const login = await responseJson(loginResponse);
      if (loginResponse.ok !== true
        || login?.user?.email !== "test@shensi.local"
        || login.user.role !== "admin"
        || login.user.teamId !== "trial-pilot-001") {
        throw failure("TRIAL_CUTOVER_RECOVERY_LOGIN_INVALID");
      }
      return Object.freeze({
        ok: true,
        origin: LOCAL_TRIAL_ORIGIN,
        store: "mysql",
        mysqlIdentity,
        user: Object.freeze({
          email: login.user.email,
          role: login.user.role,
          teamId: login.user.teamId
        })
      });
    }
  });
}
