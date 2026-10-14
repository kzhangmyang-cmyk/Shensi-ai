import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTrialCutoverAdapter as createProductionTrialCutoverAdapter
} from "./trial-cutover-adapter.mjs";

const ROOT = "/fixture/shensi";
const NONCES = Object.freeze({
  mysql: "1".repeat(32),
  tunnel: "2".repeat(32),
  sidecar: "3".repeat(32),
  backend: "4".repeat(32),
  "backend-bootstrap": "7".repeat(32),
  frontend: "5".repeat(32),
  gateway: "6".repeat(32)
});
const SAFE_MYSQL_IDENTITY = Object.freeze({
  authenticatedUser: "shensi_trial_app@127.0.0.1",
  database: "shensi_trial",
  port: 3310,
  datadir: "retained-trial",
  serverIdentitySha256: "f".repeat(64),
  sql: "ok"
});

function createTrialCutoverAdapter(root, options = {}) {
  return createProductionTrialCutoverAdapter(root, {
    verifyMysqlIdentity: async () => SAFE_MYSQL_IDENTITY,
    ...options
  });
}

function processRecord(name, pid) {
  const nonce = NONCES[name];
  return {
    version: 1,
    name,
    pid,
    command: "/fixture/node",
    args: ["/fixture/real-trial-child.mjs", "--runtime-nonce", nonce],
    nonce,
    expectedPsCommand: `/fixture/node /fixture/real-trial-child.mjs --runtime-nonce ${nonce}`,
    path: `${ROOT}/.runtime/real-trial/pids/${name}.json`
  };
}

function attested(record) {
  return Object.freeze({ ...record, processStartToken: `start-${record.pid}` });
}

function mysqlProofStubs({ databaseUrl, row }) {
  const runtimeRoot = `${ROOT}/.runtime/real-trial`;
  const secretFile = `${runtimeRoot}/secrets/mysql_app_password`;
  const identityFile = `${runtimeRoot}/state/mysql/auto.cnf`;
  const secret = "fixture-database-password";
  const serverUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const values = new Map([
    [`${runtimeRoot}/trial.env`, [
      `DATABASE_URL=${databaseUrl}`,
      "MYSQL_PORT=3310",
      `SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE=${secretFile}`,
      ""
    ].join("\n")],
    [secretFile, secret],
    [identityFile, `[auto]\nserver-uuid=${serverUuid}\n`]
  ]);
  return {
    lstat: async (path) => {
      const value = values.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), {
        code: "ENOENT"
      });
      return {
        mode: path === identityFile ? 0o100640 : 0o100600,
        size: Buffer.byteLength(value, "utf8"),
        isFile: () => true,
        isSymbolicLink: () => false
      };
    },
    readFile: async (path) => values.get(path),
    createMysqlConnection: async () => ({
      execute: async () => [[row]],
      end: async () => undefined
    })
  };
}

test("inspection attests the Trial mysql and live writers while proving absent writers", async () => {
  const records = [
    processRecord("mysql", 4101),
    processRecord("tunnel", 4102),
    processRecord("backend", 4103)
  ];
  const attestations = [];
  const portChecks = [];
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => records,
    attestOwnedProcess: async (record) => {
      attestations.push(record.name);
      return attested(record);
    },
    readProcessInventory: async () => records.map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => {
      portChecks.push(port);
      return port !== 3310;
    }
  });

  const result = await adapter.inspect();

  assert.deepEqual(attestations, ["mysql", "tunnel", "backend"]);
  assert.deepEqual(portChecks, [3310, 5612, 5610, 5608]);
  assert.deepEqual(result, {
    runtimeRoot: `${ROOT}/.runtime/real-trial`,
    mysql: {
      name: "mysql",
      pid: 4101,
      state: "owned",
      port: 3310,
      identity: SAFE_MYSQL_IDENTITY
    },
    writers: [
      { name: "tunnel", pid: 4102, state: "owned", port: null },
      { name: "sidecar", pid: null, state: "absent", port: 5612 },
      { name: "backend", pid: 4103, state: "owned", port: 5611 },
      { name: "frontend", pid: null, state: "absent", port: 5610 },
      { name: "gateway", pid: null, state: "absent", port: 5608 }
    ]
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.writers), true);
});

test("inspection requires an authenticated Trial mysql identity proof and exposes only its safe summary", async () => {
  const mysql = processRecord("mysql", 4151);
  const requests = [];
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    isPortAvailable: async (port) => port !== 3310,
    verifyMysqlIdentity: async (request) => {
      requests.push(request);
      return {
        authenticatedUser: "shensi_trial_app@127.0.0.1",
        database: "shensi_trial",
        port: 3310,
        datadir: "retained-trial",
        serverIdentitySha256: "a".repeat(64),
        sql: "ok",
        password: "must-never-be-returned"
      };
    }
  });

  const result = await adapter.inspect();

  assert.deepEqual(requests, [{
    runtimeRoot: `${ROOT}/.runtime/real-trial`,
    environmentFile: `${ROOT}/.runtime/real-trial/trial.env`,
    secretFile: `${ROOT}/.runtime/real-trial/secrets/mysql_app_password`,
    serverIdentityFile: `${ROOT}/.runtime/real-trial/state/mysql/auto.cnf`,
    expectedDatadir: `${ROOT}/.runtime/real-trial/state/mysql`,
    expectedDatabase: "shensi_trial",
    expectedPort: 3310,
    expectedUser: "shensi_trial_app"
  }]);
  assert.deepEqual(result.mysql.identity, {
    authenticatedUser: "shensi_trial_app@127.0.0.1",
    database: "shensi_trial",
    port: 3310,
    datadir: "retained-trial",
    serverIdentitySha256: "a".repeat(64),
    sql: "ok"
  });
  assert.equal(JSON.stringify(result).includes("must-never-be-returned"), false);
});

test("default mysql proof authenticates from private Trial files and verifies SQL server identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-mysql-proof-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  const secrets = join(runtimeRoot, "secrets");
  const datadir = join(runtimeRoot, "state", "mysql");
  const secretFile = join(secrets, "mysql_app_password");
  const environmentFile = join(runtimeRoot, "trial.env");
  const identityFile = join(datadir, "auto.cnf");
  const password = "fixture:database-password";
  const serverUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const mysql = processRecord("mysql", 4161);
  const connections = [];
  const queries = [];
  let ended = 0;
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await mkdir(datadir, { recursive: true, mode: 0o700 });
  await writeFile(secretFile, password, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(environmentFile, [
    `DATABASE_URL=mysql://shensi_trial_app:${encodeURIComponent(password)}`
      + "@127.0.0.1:3310/shensi_trial",
    "MYSQL_PORT=3310",
    `SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE=${secretFile}`,
    ""
  ].join("\n"), { mode: 0o600 });
  await chmod(environmentFile, 0o600);
  await writeFile(identityFile,
    `[auto]\nserver-uuid=${serverUuid}\n`, { mode: 0o640 });
  await chmod(identityFile, 0o640);

  const adapter = createProductionTrialCutoverAdapter(root, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    isPortAvailable: async (port) => port !== 3310,
    createMysqlConnection: async (input) => {
      connections.push(input);
      return {
        execute: async (sql) => {
          queries.push(sql);
          if (sql.includes(" AS current_user")) {
            throw new Error("ER_PARSE_ERROR");
          }
          return [[{
          authenticated_user: "shensi_trial_app@127.0.0.1",
          database_name: "shensi_trial",
          server_port: 3310,
          data_directory: `${datadir}/`,
          server_identity: serverUuid,
          sql_ok: 1
          }]];
        },
        end: async () => { ended += 1; }
      };
    }
  });

  try {
    const result = await adapter.inspect();
    assert.deepEqual(connections, [{
      host: "127.0.0.1",
      port: 3310,
      user: "shensi_trial_app",
      password,
      database: "shensi_trial",
      connectTimeout: 3_000
    }]);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /CURRENT_USER\(\) AS authenticated_user/u);
    assert.match(queries[0], /@@server_uuid AS server_identity/u);
    assert.equal(ended, 1);
    assert.deepEqual(result.mysql.identity, {
      authenticatedUser: "shensi_trial_app@127.0.0.1",
      database: "shensi_trial",
      port: 3310,
      datadir: "retained-trial",
      serverIdentitySha256: createHash("sha256")
        .update(serverUuid).digest("hex"),
      sql: "ok"
    });
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.equal(JSON.stringify(result).includes(serverUuid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default mysql proof rejects the wrong endpoint, database, datadir, or server identity", async () => {
  const mysql = processRecord("mysql", 4171);
  const password = "fixture-database-password";
  const serverUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const baseRow = {
    authenticated_user: "shensi_trial_app@127.0.0.1",
    database_name: "shensi_trial",
    server_port: 3310,
    data_directory: `${ROOT}/.runtime/real-trial/state/mysql/`,
    server_identity: serverUuid,
    sql_ok: 1
  };
  const common = {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    isPortAvailable: async (port) => port !== 3310
  };
  const invalidConfigurations = [
    `mysql://shensi_trial_app:${encodeURIComponent(password)}`
      + "@127.0.0.1:3311/shensi_trial",
    `mysql://shensi_trial_app:${encodeURIComponent(password)}`
      + "@127.0.0.1:3310/not_the_trial_database"
  ];
  for (const databaseUrl of invalidConfigurations) {
    const stubs = mysqlProofStubs({
      databaseUrl,
      row: baseRow
    });
    const adapter = createProductionTrialCutoverAdapter(ROOT, {
      ...common,
      ...stubs
    });
    await assert.rejects(adapter.inspect(), {
      message: "TRIAL_CUTOVER_MYSQL_IDENTITY_CONFIG_INVALID"
    });
  }

  const validUrl = `mysql://shensi_trial_app:${encodeURIComponent(password)}`
    + "@127.0.0.1:3310/shensi_trial";
  for (const row of [
    { ...baseRow, data_directory: "/tmp/not-the-trial-datadir/" },
    {
      ...baseRow,
      server_identity: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
    }
  ]) {
    const stubs = mysqlProofStubs({
      databaseUrl: validUrl,
      row
    });
    const adapter = createProductionTrialCutoverAdapter(ROOT, {
      ...common,
      ...stubs
    });
    await assert.rejects(adapter.inspect(), {
      message: "TRIAL_CUTOVER_MYSQL_IDENTITY_INVALID"
    });
  }
});

test("freeze stops only attested live writers, leaves mysql owned, and verifies writer ports are free", async () => {
  const records = [
    processRecord("mysql", 4201),
    processRecord("tunnel", 4202),
    processRecord("backend", 4203)
  ];
  const stoppedInputs = [];
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => records,
    attestOwnedProcess: async (record) => attested(record),
    inspectOwnedProcess: async (record) => record.name === "mysql" ? "owned" : "stale",
    readProcessInventory: async () => records.map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310,
    stopOwnedProcesses: async (owned) => {
      stoppedInputs.push(owned);
      return Object.freeze({
        stopped: Object.freeze(["backend", "tunnel"]),
        missing: Object.freeze([]),
        stale: Object.freeze([])
      });
    }
  });

  const result = await adapter.freezeWriters();

  assert.equal(stoppedInputs.length, 1);
  assert.deepEqual(stoppedInputs[0].map(({ name, processStartToken }) => ({
    name, processStartToken
  })), [
    { name: "tunnel", processStartToken: "start-4202" },
    { name: "backend", processStartToken: "start-4203" }
  ]);
  assert.equal(stoppedInputs[0].some(({ name }) => name === "mysql"), false);
  assert.deepEqual(result, {
    mysql: { name: "mysql", pid: 4201, state: "owned", port: 3310 },
    stopped: ["tunnel", "backend"],
    absent: ["sidecar", "frontend", "gateway"],
    releasedPorts: [5608, 5610, 5611, 5612]
  });
  assert.equal(Object.isFrozen(result), true);
});

test("restart delegates only to the retained Trial runtime root", async () => {
  const calls = [];
  const stages = [];
  const restarted = {
    root: `${ROOT}/.runtime/real-trial`,
    origin: "https://trial.example.test",
    records: [
      processRecord("mysql", 4301),
      processRecord("tunnel", 4302),
      processRecord("sidecar", 4303),
      processRecord("backend", 4304),
      processRecord("frontend", 4305),
      processRecord("gateway", 4306)
    ]
  };
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [],
    readProcessInventory: async () => [],
    isPortAvailable: async () => true,
    recoveryStartOptions: {
      runtimeRoot: "/must/not/win",
      outreachActionsEnabled: false
    },
    startTrialRuntime: async (root, options) => {
      calls.push({ root, options });
      await options.runtimeStage("mysql-ready", { pid: 4301 });
      await options.runtimeStage("not-a-recovery-stage");
      await options.runtimeStage("runtime-ready", { origin: restarted.origin });
      return restarted;
    }
  });

  assert.equal(await adapter.restart({
    onStage: async (stage, detail) => stages.push({ stage, detail })
  }), restarted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, ROOT);
  assert.equal(calls[0].options.runtimeRoot,
    `${ROOT}/.runtime/real-trial`);
  assert.equal(calls[0].options.outreachActionsEnabled, false);
  assert.equal(typeof calls[0].options.runtimeStage, "function");
  assert.deepEqual(stages, [
    { stage: "after-trial-process-stop", detail: undefined },
    { stage: "mysql-ready", detail: { pid: 4301 } },
    {
      stage: "runtime-ready",
      detail: { origin: restarted.origin }
    }
  ]);
});

test("restart stops an exactly attested retained mysql before starting Trial again", async () => {
  const mysql = processRecord("mysql", 4351);
  const calls = [];
  const restarted = {
    root: `${ROOT}/.runtime/real-trial`,
    origin: "https://trial.example.test",
    records: [
      processRecord("mysql", 4361),
      processRecord("tunnel", 4362),
      processRecord("sidecar", 4363),
      processRecord("backend", 4364),
      processRecord("frontend", 4365),
      processRecord("gateway", 4366)
    ]
  };
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => {
      calls.push(`attest:${record.name}`);
      return attested(record);
    },
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    stopOwnedProcesses: async (records) => {
      calls.push(`stop:${records.map(({ name }) => name).join(",")}`);
      assert.equal(records[0].processStartToken, `start-${mysql.pid}`);
      return { stopped: ["mysql"], missing: [], stale: [] };
    },
    isPortAvailable: async (port) => {
      calls.push(`port:${port}`);
      return true;
    },
    startTrialRuntime: async () => {
      calls.push("start");
      return restarted;
    }
  });

  assert.equal(await adapter.restart(), restarted);
  assert.deepEqual(calls, [
    "attest:mysql",
    "stop:mysql",
    "port:3310",
    "port:5612",
    "port:5611",
    "port:5610",
    "port:5608",
    "start"
  ]);
});

test("restart recovers from an exactly owned partial Trial startup", async () => {
  const records = [
    processRecord("mysql", 4371),
    processRecord("backend-bootstrap", 4372),
    processRecord("gateway", 4373)
  ];
  const stopped = [];
  const restarted = {
    root: `${ROOT}/.runtime/real-trial`,
    origin: "https://trial.example.test",
    records: [
      processRecord("mysql", 4381),
      processRecord("tunnel", 4382),
      processRecord("sidecar", 4383),
      processRecord("backend", 4384),
      processRecord("frontend", 4385),
      processRecord("gateway", 4386)
    ]
  };
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => records,
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => records.map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    stopOwnedProcesses: async (owned) => {
      stopped.push(...owned);
      return {
        stopped: owned.map(({ name }) => name),
        missing: [],
        stale: []
      };
    },
    isPortAvailable: async () => true,
    startTrialRuntime: async () => restarted
  });

  assert.equal(await adapter.restart(), restarted);
  assert.deepEqual(stopped.map(({ name }) => name), [
    "mysql", "backend-bootstrap", "gateway"
  ]);
  assert.equal(stopped.every(({ processStartToken }) =>
    typeof processStartToken === "string"), true);
});

test("restart fails closed for a reused PID or an unrecorded Trial wrapper", async () => {
  const mysql = processRecord("mysql", 4391);
  const effects = [];
  const reused = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async () => {
      throw new Error("PROCESS_OWNERSHIP_PROCESS_REUSED");
    },
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: "/usr/bin/unrelated-process"
    }],
    stopOwnedProcesses: async () => effects.push("stop"),
    isPortAvailable: async () => true,
    startTrialRuntime: async () => effects.push("start")
  });
  await assert.rejects(reused.restart(), {
    message: "TRIAL_CUTOVER_PROCESS_REUSED:mysql"
  });

  const unowned = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [],
    readProcessInventory: async () => [{
      pid: 4399,
      command: "/fixture/node /fixture/real-trial-child.mjs --runtime-nonce "
        + "f".repeat(32)
    }],
    stopOwnedProcesses: async () => effects.push("stop"),
    isPortAvailable: async () => true,
    startTrialRuntime: async () => effects.push("start")
  });
  await assert.rejects(unowned.restart(), {
    message: "TRIAL_CUTOVER_UNOWNED_TRIAL_PROCESS"
  });
  assert.deepEqual(effects, []);
});

test("restart refuses to start while a recovered Trial port remains bound", async () => {
  const mysql = processRecord("mysql", 4401);
  let started = false;
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    stopOwnedProcesses: async () => ({
      stopped: ["mysql"], missing: [], stale: []
    }),
    isPortAvailable: async (port) => port !== 5608,
    startTrialRuntime: async () => {
      started = true;
    }
  });

  await assert.rejects(adapter.restart(), {
    message: "TRIAL_CUTOVER_RECOVERY_PORT_STILL_BOUND:gateway"
  });
  assert.equal(started, false);
});

test("restart is repeatable and cleans each newly recorded runtime before relaunch", async () => {
  let records = [processRecord("mysql", 4411)];
  let starts = 0;
  const stoppedBatches = [];
  const nextRuntime = () => ({
    root: `${ROOT}/.runtime/real-trial`,
    origin: `https://trial-${starts}.example.test`,
    records: [
      processRecord("mysql", 4421 + starts * 10),
      processRecord("tunnel", 4422 + starts * 10),
      processRecord("sidecar", 4423 + starts * 10),
      processRecord("backend", 4424 + starts * 10),
      processRecord("frontend", 4425 + starts * 10),
      processRecord("gateway", 4426 + starts * 10)
    ]
  });
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => records,
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => records.map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    stopOwnedProcesses: async (owned) => {
      const names = owned.map(({ name }) => name);
      stoppedBatches.push(names);
      records = [];
      return { stopped: names, missing: [], stale: [] };
    },
    isPortAvailable: async () => true,
    startTrialRuntime: async () => {
      starts += 1;
      const runtime = nextRuntime();
      records = runtime.records;
      return runtime;
    }
  });

  await adapter.restart();
  await adapter.restart();

  assert.equal(starts, 2);
  assert.deepEqual(stoppedBatches, [
    ["mysql"],
    ["mysql", "tunnel", "sidecar", "backend", "frontend", "gateway"]
  ]);
});

test("recovery verification proves local mysql health and the original test login without returning secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cutover-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  const secrets = join(runtimeRoot, "secrets");
  const passwordPath = join(secrets, "trial_app_password");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await writeFile(passwordPath, "fixture-login-secret", { mode: 0o600 });
  await chmod(passwordPath, 0o600);
  const requests = [];
  const publicChecks = [];
  const mysqlIdentityRequests = [];
  const adapter = createTrialCutoverAdapter(root, {
    verifyMysqlIdentity: async (request) => {
      mysqlIdentityRequests.push(request);
      return SAFE_MYSQL_IDENTITY;
    },
    verifyTrialRuntime: async (options) => publicChecks.push(options.origin),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/api/health")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, store: "mysql" })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "must-not-be-returned",
          user: {
            email: "test@shensi.local",
            role: "admin",
            teamId: "trial-pilot-001"
          }
        })
      };
    }
  });

  try {
    const result = await adapter.verifyRecovered({ root: runtimeRoot });
    assert.deepEqual(publicChecks, ["http://127.0.0.1:5608"]);
    assert.equal(mysqlIdentityRequests.length, 1);
    assert.equal(mysqlIdentityRequests[0].runtimeRoot, runtimeRoot);
    assert.deepEqual(requests.map(({ url }) => url), [
      "http://127.0.0.1:5608/api/health",
      "http://127.0.0.1:5608/api/auth/login"
    ]);
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      email: "test@shensi.local",
      password: "fixture-login-secret"
    });
    assert.deepEqual(result, {
      ok: true,
      origin: "http://127.0.0.1:5608",
      store: "mysql",
      mysqlIdentity: SAFE_MYSQL_IDENTITY,
      user: {
        email: "test@shensi.local",
        role: "admin",
        teamId: "trial-pilot-001"
      }
    });
    assert.equal(JSON.stringify(result).includes("fixture-login-secret"), false);
    assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection fails closed for a reused writer PID and an unowned Trial wrapper", async () => {
  const mysql = processRecord("mysql", 4401);
  const backend = processRecord("backend", 4402);
  const reused = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql, backend],
    attestOwnedProcess: async (record) => {
      if (record.name === "backend") {
        throw new Error("PROCESS_OWNERSHIP_PROCESS_REUSED");
      }
      return attested(record);
    },
    readProcessInventory: async () => [mysql, backend].map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310
  });
  await assert.rejects(reused.inspect(), {
    message: "TRIAL_CUTOVER_PROCESS_REUSED:backend"
  });

  const unowned = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [
      { pid: mysql.pid, command: mysql.expectedPsCommand },
      {
        pid: 4499,
        command: "/fixture/node /fixture/real-trial-child.mjs --runtime-nonce "
          + "f".repeat(32)
      }
    ],
    isPortAvailable: async (port) => port !== 3310
  });
  await assert.rejects(unowned.inspect(), {
    message: "TRIAL_CUTOVER_UNOWNED_TRIAL_PROCESS"
  });
});

test("inspection does not infer writer absence while its port is still bound", async () => {
  const mysql = processRecord("mysql", 4501);
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [{
      pid: mysql.pid,
      command: mysql.expectedPsCommand
    }],
    isPortAvailable: async (port) => port !== 3310 && port !== 5612
  });

  await assert.rejects(adapter.inspect(), {
    message: "TRIAL_CUTOVER_WRITER_ABSENCE_UNPROVEN:sidecar"
  });
});

test("freeze fails closed when the bounded stop cannot account for a writer", async () => {
  const mysql = processRecord("mysql", 4601);
  const backend = processRecord("backend", 4602);
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql, backend],
    attestOwnedProcess: async (record) => attested(record),
    readProcessInventory: async () => [mysql, backend].map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310,
    stopOwnedProcesses: async () => ({
      stopped: [], missing: [], stale: ["backend"]
    })
  });

  await assert.rejects(adapter.freezeWriters(), {
    message: "TRIAL_CUTOVER_WRITER_STOP_INCOMPLETE"
  });
});

test("freeze refuses success when mysql ownership changes after writer shutdown", async () => {
  const mysql = processRecord("mysql", 4701);
  const backend = processRecord("backend", 4702);
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql, backend],
    attestOwnedProcess: async (record) => attested(record),
    inspectOwnedProcess: async () => "stale",
    readProcessInventory: async () => [mysql, backend].map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310,
    stopOwnedProcesses: async () => ({
      stopped: ["backend"], missing: [], stale: []
    })
  });

  await assert.rejects(adapter.freezeWriters(), {
    message: "TRIAL_CUTOVER_MYSQL_OWNERSHIP_LOST"
  });
});

test("freeze refuses success while a stopped writer port remains bound", async () => {
  const mysql = processRecord("mysql", 4751);
  const backend = processRecord("backend", 4752);
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => [mysql, backend],
    attestOwnedProcess: async (record) => attested(record),
    inspectOwnedProcess: async () => "owned",
    readProcessInventory: async () => [mysql, backend].map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310 && port !== 5611,
    stopOwnedProcesses: async () => ({
      stopped: ["backend"], missing: [], stale: []
    })
  });

  await assert.rejects(adapter.freezeWriters(), {
    message: "TRIAL_CUTOVER_WRITER_PORT_STILL_BOUND:backend"
  });
});

test("recovery verification rejects a non-private login secret before sending credentials", async () => {
  const fetchCalls = [];
  const adapter = createTrialCutoverAdapter(ROOT, {
    verifyTrialRuntime: async () => undefined,
    lstat: async () => ({
      mode: 0o100644,
      size: 12,
      isFile: () => true,
      isSymbolicLink: () => false
    }),
    readFile: async () => "unsafe-value",
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, store: "mysql" })
      };
    }
  });

  await assert.rejects(adapter.verifyRecovered({
    root: `${ROOT}/.runtime/real-trial`
  }), { message: "TRIAL_CUTOVER_LOGIN_SECRET_INVALID" });
  assert.deepEqual(fetchCalls, ["http://127.0.0.1:5608/api/health"]);
});

test("adapter cannot be redirected away from the fixed retained Trial root", () => {
  assert.throws(() => createTrialCutoverAdapter(ROOT, {
    runtimeRoot: `${ROOT}/.runtime/not-the-retained-trial`
  }), { message: "TRIAL_CUTOVER_RUNTIME_ROOT_INVALID" });
});

test("freeze rejects a preflight snapshot when writer ownership changed before shutdown", async () => {
  const mysql = processRecord("mysql", 4801);
  const backend = processRecord("backend", 4802);
  let currentRecords = [mysql, backend];
  const adapter = createTrialCutoverAdapter(ROOT, {
    readRuntimeRecords: async () => currentRecords,
    attestOwnedProcess: async (record) => attested(record),
    inspectOwnedProcess: async () => "owned",
    readProcessInventory: async () => currentRecords.map((record) => ({
      pid: record.pid,
      command: record.expectedPsCommand
    })),
    isPortAvailable: async (port) => port !== 3310,
    stopOwnedProcesses: async () => ({
      stopped: [], missing: [], stale: []
    })
  });
  const snapshot = await adapter.inspect();
  currentRecords = [mysql];

  await assert.rejects(adapter.freezeWriters({
    snapshot,
    liveWriters: snapshot.writers.filter(({ state }) => state === "owned")
  }), { message: "TRIAL_CUTOVER_SNAPSHOT_CHANGED" });
});
