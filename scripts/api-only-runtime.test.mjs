import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access as nativeAccess, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readlink as nativeReadlink, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  API_ONLY_CRYPTO_SECRET_BINDINGS,
  API_ONLY_PORTS,
  API_ONLY_SMOKE_ROUTES,
  acquireApiOnlyOwnerLock,
  apiOnlyStatus,
  apiOnlyComposeInvocation,
  authenticateApiOnlySmoke,
  createDisposableApiOnlyIdentity,
  destroyFailedDisposableApiOnlyPreparation,
  destroyDisposableApiOnlyRuntime,
  dispatchApiOnlyCli,
  parseApiOnlyCli,
  persistDesktopActionStorageCleanupEvidence,
  prepareTrialToApiOnlyMigration,
  prepareApiOnlyRuntime,
  provisionTrialMigrationReader,
  releaseApiOnlyOwnerLock,
  freezeTrialWriters,
  runTrialToApiOnlyMigration,
  runApiOnlyModuleSmoke,
  startApiOnlyDatabase,
  startApiOnlyRuntime,
  stopApiOnlyRuntime,
  validateDisposableApiOnlyOwnerLock,
  verifyEmptyApiOnlyRuntime,
  verifyApiOnlyGatewayBoundary,
  withApiOnlyOwnerLock
} from "./api-only-runtime.mjs";
import { assertRuntimeSelection, discoverComposeRuntime, doctorSummary } from "./container-runtime.mjs";
import { createApiOnlyAuthorityResolver } from "./lib/api-only-authority.mjs";

// The production break caught by these tests is an accidental path from this
// pure supervisor into a real daemon, socket, or port.  Every dependency below
// is injected and records only the contract observed at the process boundary.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-api-only-test-")));
  await mkdir(join(root, "deploy", "nginx"), { recursive: true });
  await mkdir(join(root, ".runtime", "real-trial", "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "deploy", "nginx", "api-only.conf"), "server { location / { return 404; } }\n");
  for (const source of Object.values(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
    await writeFile(join(root, ".runtime", "real-trial", "secrets", source), `fixture-${source}`, { mode: 0o600 });
  }
  await writeFile(join(root, ".runtime", "real-trial", "secrets", "trial_app_password"), "fixture-login-password", { mode: 0o600 });
  return root;
}

async function cleanup(root) { await rm(root, { recursive: true, force: true }); }
async function snapshotAuthorityTree(root) {
  const rows = [];
  async function visit(path, relativePath) {
    let info;
    try { info = await lstat(path); } catch (caught) {
      if (caught?.code === "ENOENT") { rows.push([relativePath, "absent"]); return; }
      throw caught;
    }
    if (info.isDirectory()) {
      const names = (await readdir(path)).sort();
      rows.push([relativePath, "directory", info.mode & 0o777, names]);
      for (const name of names) await visit(join(path, name), `${relativePath}/${name}`);
    } else if (info.isFile()) {
      rows.push([relativePath, "file", info.mode & 0o777, fixtureSha256(await readFile(path))]);
    } else rows.push([relativePath, "other", info.mode & 0o777]);
  }
  await visit(root, ".");
  return rows;
}
function fakeRuntime() {
  return Object.freeze({
    argvPrefix: ["/safe/docker", "compose"],
    daemon: { identity: "engine-fixture" },
    compose: { kind: "docker-compose-plugin", version: "2.fixture" },
    socket: { canonicalPath: "/tmp/fake.sock", identity: "socket-fixture" }
  });
}
function composeRuntimeDiscoveryFixture({ unsafeExecutable = false, unsafeSocket = false, invalidDaemon = false } = {}) {
  const uid = 501;
  let inode = 100;
  const nodes = new Map();
  const add = (path, type, { owner = uid, mode = type === "dir" ? 0o700 : type === "socket" ? 0o600 : 0o755 } = {}) => {
    nodes.set(resolve(path), { type, uid: owner, mode, dev: 1, ino: inode += 1, nlink: 1 });
  };
  add("/", "dir", { owner: 0, mode: 0o755 });
  add("/Users", "dir", { owner: 0, mode: 0o755 });
  add("/Users/alice", "dir", { mode: 0o750 });
  add("/Users/alice/runtime", "dir");
  add("/Users/alice/runtime/docker.sock", "socket", { mode: unsafeSocket ? 0o660 : 0o600 });
  add("/safe", "dir", { owner: 0, mode: unsafeExecutable ? 0o777 : 0o755 });
  add("/safe/docker", "file", { owner: 0, mode: 0o755 });
  add("/usr", "dir", { owner: 0, mode: 0o755 });
  add("/usr/sbin", "dir", { owner: 0, mode: 0o755 });
  add("/usr/sbin/netstat", "file", { owner: 0, mode: 0o755 });
  const calls = [];
  const stat = (node) => ({
    uid: node.uid,
    gid: node.uid,
    mode: node.mode,
    dev: node.dev,
    ino: node.ino,
    nlink: node.nlink,
    size: 0,
    isDirectory: () => node.type === "dir",
    isFile: () => node.type === "file",
    isSocket: () => node.type === "socket",
    isSymbolicLink: () => false
  });
  const lookup = (path) => {
    const node = nodes.get(resolve(path));
    if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return node;
  };
  return {
    calls,
    environment: {
      PATH: "/safe",
      HOME: "/ambient-home-must-not-win",
      DOCKER_HOST: "tcp://ambient.example:2375",
      SHENSI_DOCKER_HOST: "unix:///Users/alice/runtime/docker.sock"
    },
    userInfo: () => ({ homedir: "/Users/alice", uid, gid: uid }),
    getuid: () => uid,
    getgroups: () => [20, uid],
    candidates: [{ command: "/safe/docker", kind: "docker" }],
    async lstat(path) { return stat(lookup(path)); },
    async realpath(path) { lookup(path); return resolve(path); },
    async readlink() { throw Object.assign(new Error("not a link"), { code: "EINVAL" }); },
    async access(path) {
      const node = lookup(path);
      if (node.type !== "file" || (node.mode & 0o111) === 0) throw Object.assign(new Error("not executable"), { code: "EACCES" });
    },
    async composeVersion(command, args, options) {
      calls.push({ type: "compose-version", command, args, options });
      return "v2.fixture";
    },
    async daemonRequest(path, socket, options) {
      calls.push({ type: "daemon", path, socket, options });
      if (path === "/_ping") return "OK";
      if (path === "/info") return invalidDaemon
        ? { ID: "", Name: "engine", Driver: "overlay2", OSType: "linux", Architecture: "arm64" }
        : { ID: "daemon-fixture", Name: "engine", Driver: "overlay2", OSType: "linux", Architecture: "arm64" };
      throw new Error("unexpected daemon endpoint");
    }
  };
}
const COMPOSE_ENGINE_INFO = Object.freeze({
  ID: "daemon-fixture",
  Name: "engine",
  Driver: "overlay2",
  OSType: "linux",
  Architecture: "arm64"
});
function rawInspectionNetwork({ id, name, subnet = null, gateway = null, labels = {} }) {
  return {
    Id: id,
    Name: name,
    IPAM: { Driver: "default", Options: null, Config: subnet === null ? [] : [{ Subnet: subnet, ...(gateway === null ? {} : { Gateway: gateway }) }] },
    Labels: labels
  };
}
function builtinInspectionNetworks() {
  return [
    rawInspectionNetwork({ id: "b".repeat(64), name: "bridge", subnet: "172.17.0.0/16", gateway: "172.17.0.1" }),
    rawInspectionNetwork({ id: "c".repeat(64), name: "host" }),
    rawInspectionNetwork({ id: "d".repeat(64), name: "none" })
  ];
}
function engineInspectionFixture(responses = {}) {
  const calls = [];
  const sequenceOffsets = new Map();
  const request = (options, onResponse) => {
    calls.push(options);
    const outgoing = new EventEmitter();
    outgoing.destroy = () => outgoing;
    outgoing.end = () => queueMicrotask(() => {
      const prefixEntry = Object.entries(responses).find(([path]) => path.endsWith("*") && options.path.startsWith(path.slice(0, -1)));
      const configured = Object.hasOwn(responses, options.path)
        ? responses[options.path]
        : prefixEntry ? prefixEntry[1]
        : options.path === "/info" ? COMPOSE_ENGINE_INFO
          : options.path === "/networks" ? builtinInspectionNetworks()
            : undefined;
      let bodyValue = configured;
      if (configured && typeof configured === "object" && !Array.isArray(configured)
        && Object.keys(configured).length === 1 && Array.isArray(configured.sequence)) {
        const offset = sequenceOffsets.get(options.path) ?? 0;
        bodyValue = configured.sequence[offset];
        sequenceOffsets.set(options.path, offset + 1);
      }
      if (bodyValue === undefined) {
        outgoing.emit("error", new Error(`unexpected Engine endpoint: ${options.path}`));
        return;
      }
      const body = Buffer.from(JSON.stringify(bodyValue));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { "content-type": "application/json", "content-length": String(body.length) };
      response.headersDistinct = { "content-type": ["application/json"], "content-length": [String(body.length)] };
      response.complete = true;
      response.destroy = () => response;
      onResponse(response);
      response.emit("data", body);
      response.emit("end");
    });
    return outgoing;
  };
  return { calls, request };
}
function fixtureRuntimeNonce(project = "shensi-api") {
  return createHash("sha256")
    .update(`${project}:2026-09-04T00:00:00.000Z:${Buffer.alloc(16, 7).toString("hex")}`)
    .digest("hex");
}
function taskOneBoundaryFixture({ networks = builtinInspectionNetworks(), routes = [], postNetwork = null, postGateway = null, promoteAfterMutation = false, mutationOutput = "" } = {}) {
  const discovery = composeRuntimeDiscoveryFixture();
  const daemonIdentity = createHash("sha256").update(JSON.stringify({
    socketIdentity: createHash("sha256").update("/Users/alice/runtime/docker.sock").digest("hex"),
    id: COMPOSE_ENGINE_INFO.ID,
    name: COMPOSE_ENGINE_INFO.Name,
    driver: COMPOSE_ENGINE_INFO.Driver,
    osType: COMPOSE_ENGINE_INFO.OSType,
    architecture: COMPOSE_ENGINE_INFO.Architecture
  })).digest("hex");
  const networkId = "2".repeat(64);
  const networkName = "shensi-api_shensi_internal";
  const hostNetworkName = "shensi-api_shensi_host";
  const labels = {
    "com.docker.compose.project": "shensi-api",
    "com.docker.compose.network": "shensi_internal",
    "io.shensi.api.runtime-nonce": fixtureRuntimeNonce(),
    "io.shensi.api.daemon-identity": daemonIdentity
  };
  const exactPostNetwork = postNetwork ?? rawInspectionNetwork({
    id: networkId,
    name: networkName,
    subnet: "198.18.250.0/24",
    gateway: "198.18.250.1",
    labels
  });
  const exactPostGateway = postGateway ?? [{
    Id: "3".repeat(64),
    Labels: { "com.docker.compose.project": "shensi-api", "com.docker.compose.service": "gateway" },
    NetworkSettings: {
      Networks: {
        [networkName]: { IPAddress: "198.18.250.254", IPPrefixLen: 24, NetworkID: networkId },
        [hostNetworkName]: { IPAddress: "172.31.242.2", IPPrefixLen: 24, NetworkID: "7".repeat(64) }
      }
    }
  }];
  const engine = engineInspectionFixture({
    "/networks": promoteAfterMutation
      ? { sequence: [networks, [...networks, exactPostNetwork]] }
      : networks,
    [`/networks/${networkName}`]: exactPostNetwork,
    "/containers/json?*": exactPostGateway
  });
  const routeCalls = [];
  const renderCalls = [];
  const mutationCalls = [];
  const routeRows = [
    "Routing tables",
    "",
    "Internet:",
    "Destination Gateway Flags Netif",
    "default 192.168.1.1 UGScg en0",
    ...routes.map(({ destination, gateway = "link#1", flags = "UCS", netif = "utun0" }) => `${destination} ${gateway} ${flags} ${netif}`)
  ];
  return {
    discovery,
    daemonIdentity,
    postNetwork: exactPostNetwork,
    engineCalls: engine.calls,
    routeCalls,
    renderCalls,
    mutationCalls,
    networkInspectionOptions: {
      request: engine.request,
      lstat: discovery.lstat,
      realpath: discovery.realpath,
      readlink: discovery.readlink,
      access: discovery.access,
      async execFile(command, args, options) {
        routeCalls.push({ command, args, options });
        return { stdout: `${routeRows.join("\n")}\n`, stderr: "" };
      }
    },
    composeRenderOptions: {
      async revalidateExecutable(path, runtime) {
        renderCalls.push({ type: "revalidate", path, runtime });
        return path === "/safe/docker";
      },
      spawn(command, args, options) {
        renderCalls.push({ type: "spawn", command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      }
    },
    composeMutationOptions: {
      async revalidateExecutable(path, runtime) {
        mutationCalls.push({ type: "revalidate", path, runtime });
        return path === "/safe/docker";
      },
      async probeDaemonIdentity(runtime) {
        mutationCalls.push({ type: "daemon", runtime });
        return runtime.daemon.identity;
      },
      spawn(command, args, options) {
        mutationCalls.push({ type: "spawn", command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => {
          if (mutationOutput) child.stdout.emit("data", Buffer.from(mutationOutput, "utf8"));
          child.emit("close", 0, null);
        });
        return child;
      }
    }
  };
}
function preparedOptions(root, calls = []) {
  let randomSequence = 0;
  const boundary = taskOneBoundaryFixture();
  return {
    runtimeRoot: join(root, ".runtime", "api-only"),
    isPortAvailable: async () => true,
    composeRuntimeDiscoveryOptions: boundary.discovery,
    networkInspectionOptions: boundary.networkInspectionOptions,
    composeRenderOptions: boundary.composeRenderOptions,
    composeMutationOptions: {
      ...boundary.composeMutationOptions,
      spawn(command, args, input) {
        calls.push({ args: args.slice(1), input: { environment: input.env }, command });
        return boundary.composeMutationOptions.spawn(command, args, input);
      }
    },
    resolveCompose: async () => ({ rootHash: "compose-fixture", services: ["mysql", "backend", "gateway"] }),
    runCompose: async (_runtime, args, input) => { calls.push({ args, input }); return { stdout: "" }; },
    createManifest: async () => ({ rootHash: "manifest-fixture" }),
    randomBytes: (size) => Buffer.alloc(size, randomSequence = randomSequence % 250 + 1),
    waitForHealth: async () => undefined,
    now: () => "2026-09-04T00:00:00.000Z",
    processInfo: () => ({ pid: 4242, startToken: "proc-fixture" })
  };
}

const fixedHash = (character) => character.repeat(64);
const bootstrapBackendObservation = (input, character = "e") => ({
  project: input.project,
  runtimeNonce: input.runtimeNonce,
  networkId: input.network.id,
  networkName: input.network.name,
  service: "backend",
  containerId: fixedHash(character),
  imageIdDigest: `sha256:${fixedHash(character)}`
});
async function startHealthyBootstrapFixture(root) {
  const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
  await startApiOnlyRuntime(root, {
    ...preparedOptions(root),
    composeRuntimeDiscoveryOptions: boundary.discovery,
    networkInspectionOptions: boundary.networkInspectionOptions,
    composeMutationOptions: boundary.composeMutationOptions,
    isPortAvailable: async () => true,
    requestHttpHealth: async (input) => input.url.endsWith("/healthz")
      ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
      : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) },
    inspectBootstrapBackendImage: async (input) => bootstrapBackendObservation(input)
  });
  return boundary;
}
const fixtureSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureEvidence = (character) => ({ basename: `${fixedHash(character)}.json`, sha256: fixedHash(character) });
const fixtureIdentitySha256 = (domain, value) => fixtureSha256(Buffer.concat([
  Buffer.from(`${domain}\0`, "utf8"),
  Buffer.from(JSON.stringify(value), "utf8")
]));
const fixtureSortedMap = (value) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));

function acceptedComposeBaseFixture(gatewayImageReference) {
  const ownershipLabels = {
    "io.shensi.api.runtime-nonce": "${SHENSI_API_RUNTIME_NONCE:?required}",
    "io.shensi.api.daemon-identity": "${SHENSI_API_DAEMON_IDENTITY:?required}"
  };
  return {
    services: {
      mysql: {
        image: "mysql:8.4.11",
        environment: {
          MYSQL_DATABASE: "shensi",
          MYSQL_USER: "shensi_app",
          MYSQL_PASSWORD_FILE: "/run/secrets/mysql_app_password",
          MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/mysql_root_password"
        },
        secrets: ["mysql_app_password", "mysql_root_password"],
        volumes: ["mysql_data:/var/lib/mysql"],
        ports: ["127.0.0.1:${SHENSI_API_MYSQL_HOST_PORT:?required}:3306"],
        networks: { shensi_internal: null, shensi_host: null },
        labels: { ...ownershipLabels },
        healthcheck: {
          test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$(cat /run/secrets/mysql_root_password) --silent"],
          interval: "5s",
          timeout: "5s",
          retries: 30
        }
      },
      backend: {
        env_file: "${SHENSI_API_BACKEND_ENV_FILE:?required}",
        environment: {
          NODE_ENV: "production",
          CRM_STORE: "mysql",
          BACKEND_HOST: "0.0.0.0",
          PORT: "4188",
          TRUSTED_PROXY_CIDRS: "${SHENSI_API_GATEWAY_IP:?required}/32",
          SHENSI_API_GATEWAY_IP: "${SHENSI_API_GATEWAY_IP:?required}",
          DOUYIN_OUTREACH_ACTIONS_ENABLED: "false",
          DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
          DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false",
          DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
          SHENSI_RUNTIME_READ_ONLY: "false",
          SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked"
        },
        depends_on: { mysql: { condition: "service_healthy" } },
        networks: ["shensi_internal", "shensi_egress"],
        labels: { ...ownershipLabels },
        healthcheck: {
          test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4188/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
          interval: "10s",
          timeout: "5s",
          retries: 20
        }
      },
      gateway: {
        image: gatewayImageReference,
        pull_policy: "never",
        ports: ["127.0.0.1:${SHENSI_API_HTTP_PORT:?required}:8080"],
        volumes: ["${SHENSI_API_GATEWAY_CONFIG_FILE:?required}:/etc/nginx/conf.d/default.conf:ro"],
        depends_on: { backend: { condition: "service_healthy" } },
        networks: {
          shensi_internal: { ipv4_address: "${SHENSI_API_GATEWAY_IP:?required}" },
          shensi_host: null
        },
        labels: { ...ownershipLabels }
      }
    },
    secrets: {
      mysql_app_password: { file: "${SHENSI_API_MYSQL_APP_PASSWORD_FILE:?required}" },
      mysql_root_password: { file: "${SHENSI_API_MYSQL_ROOT_PASSWORD_FILE:?required}" }
    },
    volumes: { mysql_data: { labels: { ...ownershipLabels } } },
    networks: {
      shensi_internal: {
        internal: true,
        labels: { ...ownershipLabels },
        ipam: { config: [{ subnet: "${SHENSI_API_INTERNAL_SUBNET:?required}", gateway: "${SHENSI_API_IPAM_GATEWAY:?required}" }] }
      },
      shensi_egress: { labels: { ...ownershipLabels } },
      shensi_host: {
        driver: "bridge",
        driver_opts: {
          "com.docker.network.bridge.enable_ip_masquerade": "false",
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
        },
        labels: { ...ownershipLabels }
      }
    }
  };
}

async function materializeCanonicalJournal(root, finalState) {
  const resolver = createApiOnlyAuthorityResolver();
  const attemptId = "0123456789ab";
  const project = `shensi-api-migration-${attemptId}`;
  const runtimeRoot = join(root, ".runtime", "api-only");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(join(root, ".runtime"), 0o700);
  await chmod(runtimeRoot, 0o700);
  const base = (state, index, overrides = {}) => ({
    attemptId,
    project,
    source: { database: "shensi_trial", port: 3310, commit: "a".repeat(40) },
    target: { database: "shensi", port: 3311, commit: "b".repeat(40) },
    state,
    activeRuntime: null,
    rollbackClosedAt: null,
    desktopClientAdmission: { mode: "migration_locked", admittedBuildManifestSha256: null },
    transitionedAt: `2026-09-04T00:00:0${index}.000Z`,
    evidenceManifest: fixtureEvidence("e"),
    failure: null,
    recoveryEvidence: null,
    writeActivation: null,
    acceptedVersion: null,
    ...overrides
  });
  const path = ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending"];
  const end = path.indexOf(finalState);
  if (end < 0) throw new Error("UNSUPPORTED_TEST_JOURNAL_STATE");
  let journal = null;
  const rollbackClosedAt = "2026-09-04T00:00:05.000Z";
  const writeActivation = { confirmationSha256: fixedHash("f"), resumeBinding: fixtureEvidence("0") };
  for (let index = 0; index <= end; index += 1) {
    const state = path[index];
    const overrides = state === "prepared" ? { activeRuntime: "trial" }
      : state === "cutover_read_only" ? { activeRuntime: "target" }
        : state === "write_activation_pending" ? { activeRuntime: "target", rollbackClosedAt, writeActivation }
          : {};
    journal = resolver.buildNextMigrationJournal(journal?.journal ?? null, base(state, index + 1, overrides));
  }
  await writeFile(join(runtimeRoot, "migration-state.json"), journal.canonicalText, { mode: 0o600 });
  return { runtimeRoot, journal };
}

async function materializeAcceptedAuthority(root, { engine = null } = {}) {
  const resolver = createApiOnlyAuthorityResolver();
  const attemptId = "0123456789ab";
  const project = `shensi-api-migration-${attemptId}`;
  const runtimeRoot = join(root, ".runtime", "api-only");
  const artifactSlots = [
    ["container-runtime-selection.json", "containerRuntimeSelectionSha256"],
    ["accepted-compose-base.json", "acceptedComposeBaseSha256"],
    ["backend.env", "backendEnvironmentSha256"],
    ["backend-image-override.json", "backendImageOverrideSha256"],
    ["gateway.conf", "gatewayConfigSha256"],
    ["accepted-resources.json", "acceptedResourcesSha256"],
    ["task5-recovery-seed-candidate-receipt.json", "task5RecoverySeedCandidateReceiptSha256"]
  ];
  const selectedEngine = engine ?? { socketIdentity: fixedHash("2"), daemonIdentity: fixedHash("3") };
  const runtimeNonce = fixedHash("1");
  const labelsFor = (logicalKey, logicalName) => ({
    "com.docker.compose.project": project,
    [logicalKey]: logicalName,
    "io.shensi.api.runtime-nonce": runtimeNonce,
    "io.shensi.api.daemon-identity": selectedEngine.daemonIdentity
  });
  const internalIdentity = {
    name: `${project}_shensi_internal`, id: fixedHash("4"), driver: "bridge", scope: "local",
    internal: true, attachable: false, ingress: false, ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.240.0/24", gateway: "172.31.240.1" }], options: {},
    labels: fixtureSortedMap(labelsFor("com.docker.compose.network", "shensi_internal"))
  };
  const egressIdentity = {
    name: `${project}_shensi_egress`, id: fixedHash("6"), driver: "bridge", scope: "local",
    internal: false, attachable: false, ingress: false, ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.241.0/24", gateway: "172.31.241.1" }], options: {},
    labels: fixtureSortedMap(labelsFor("com.docker.compose.network", "shensi_egress"))
  };
  const hostIdentity = {
    name: `${project}_shensi_host`, id: fixedHash("7"), driver: "bridge", scope: "local",
    internal: false, attachable: false, ingress: false, ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.242.0/24", gateway: "172.31.242.1" }],
    options: {
      "com.docker.network.bridge.enable_ip_masquerade": "false",
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    },
    labels: fixtureSortedMap(labelsFor("com.docker.compose.network", "shensi_host"))
  };
  const volumeIdentity = {
    name: `${project}_mysql_data`, driver: "local", scope: "local",
    mountpoint: `/var/lib/docker/volumes/${project}_mysql_data/_data`,
    createdAt: "2026-09-04T00:00:00.000Z", options: {},
    labels: fixtureSortedMap(labelsFor("com.docker.compose.volume", "mysql_data"))
  };
  const expectedResources = {
    migrationAttemptId: attemptId,
    project,
    ports: { gateway: 5608, mysql: 3311 },
    runtimeNonce,
    engine: selectedEngine,
    networks: {
      internal: { id: internalIdentity.id, name: internalIdentity.name, identitySha256: fixtureIdentitySha256("shensi.api-only.network-identity/v1", internalIdentity), subnet: "172.31.240.0/24", ipamGatewayIp: "172.31.240.1", gatewayServiceIp: "172.31.240.2" },
      egress: { id: egressIdentity.id, name: egressIdentity.name, identitySha256: fixtureIdentitySha256("shensi.api-only.network-identity/v1", egressIdentity) },
      host: { id: hostIdentity.id, name: hostIdentity.name, identitySha256: fixtureIdentitySha256("shensi.api-only.network-identity/v1", hostIdentity) }
    },
    mysql: { containerId: fixedHash("8"), volumeName: volumeIdentity.name, volumeIdentitySha256: fixtureIdentitySha256("shensi.api-only.volume-identity/v1", volumeIdentity), imageIdDigest: `sha256:${fixedHash("a")}` },
    backend: { imageIdDigest: `sha256:${fixedHash("b")}`, composeImageReference: { kind: "engine-image-id", value: `sha256:${fixedHash("b")}` } }
  };
  const gateway = { imageIdDigest: `sha256:${fixedHash("c")}`, composeImageReference: { kind: "engine-image-id", value: `sha256:${fixedHash("c")}` } };
  const acceptedResources = {
    schema: "shensi.api-only.accepted-resources", version: 1, project,
    ports: expectedResources.ports, runtimeNonce, engine: selectedEngine,
    networks: expectedResources.networks, mysql: expectedResources.mysql,
    backend: expectedResources.backend, gateway
  };
  const artifactBytes = Object.fromEntries(artifactSlots.map(([basename]) => [basename, Buffer.from(`sealed:${basename}\n`)]));
  artifactBytes["accepted-compose-base.json"] = Buffer.from(`${JSON.stringify(acceptedComposeBaseFixture(gateway.composeImageReference.value))}\n`);
  artifactBytes["backend-image-override.json"] = Buffer.from(`${JSON.stringify({ services: { backend: { image: expectedResources.backend.composeImageReference.value, pull_policy: "never" } } })}\n`);
  artifactBytes["backend.env"] = Buffer.from([
    "DATABASE_URL=mysql://shensi_app:private-password@mysql:3306/shensi",
    "CRM_STORE=mysql", "NODE_ENV=production", "BACKEND_API_KEY=accepted-compose-secret-canary",
    "DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=true", "SHENSI_RUNTIME_READ_ONLY=false"
  ].join("\n") + "\n");
  artifactBytes["gateway.conf"] = Buffer.from("server { listen 8080; location /healthz { return 200 'ok\\n'; } }\n");
  artifactBytes["accepted-resources.json"] = Buffer.from(`${JSON.stringify(acceptedResources)}\n`);
  const artifacts = Object.fromEntries(artifactSlots.map(([basename, field]) => [field, fixtureSha256(artifactBytes[basename])]));
  const binding = {
    ...expectedResources,
    artifacts,
    acceptedLiveSchemaHash: fixedHash("c"),
    apiContractHash: fixedHash("d"),
    desktopClientAdmission: { mode: "migration_locked", admittedBuildManifestSha256: null }
  };
  const accepted = resolver.buildInitialAcceptedVersion(binding);
  const expectedVersionId = createHash("sha256")
    .update(Buffer.from("shensi.api-only.accepted-version/v1\0", "utf8"))
    .update(Buffer.from(JSON.stringify(binding), "utf8"))
    .digest("hex");
  const expectedRecord = {
    schema: "shensi.api-only.accepted-version",
    version: 1,
    kind: "initial_acceptance",
    versionId: expectedVersionId,
    binding
  };
  const expectedRecordText = `${JSON.stringify(expectedRecord)}\n`;
  assert.equal(accepted.versionId, expectedVersionId);
  assert.equal(accepted.canonicalText, expectedRecordText);
  assert.equal(accepted.recordSha256, fixtureSha256(Buffer.from(expectedRecordText, "utf8")));
  const versionsRoot = join(runtimeRoot, "versions");
  const versionRoot = join(versionsRoot, accepted.versionId);
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await chmod(join(root, ".runtime"), 0o700);
  await chmod(runtimeRoot, 0o700);
  await chmod(versionsRoot, 0o700);
  await chmod(versionRoot, 0o700);
  await writeFile(join(versionRoot, "accepted-version.json"), accepted.canonicalText, { mode: 0o600 });
  for (const [basename] of artifactSlots) await writeFile(join(versionRoot, basename), artifactBytes[basename], { mode: 0o600 });
  const pointer = { schema: "shensi.api-only.active-version-pointer", version: 1, versionId: accepted.versionId, recordSha256: accepted.recordSha256 };
  await writeFile(join(runtimeRoot, "active-version.json"), `${JSON.stringify(pointer)}\n`, { mode: 0o600 });

  const admission = binding.desktopClientAdmission;
  const base = (state, index, overrides = {}) => ({
    attemptId,
    project,
    source: { database: "shensi_trial", port: 3310, commit: "a".repeat(40) },
    target: { database: "shensi", port: 3311, commit: "b".repeat(40) },
    state,
    activeRuntime: null,
    rollbackClosedAt: null,
    desktopClientAdmission: admission,
    transitionedAt: `2026-09-04T00:00:0${index}.000Z`,
    evidenceManifest: fixtureEvidence("e"),
    failure: null,
    recoveryEvidence: null,
    writeActivation: null,
    acceptedVersion: null,
    ...overrides
  });
  let journal = resolver.buildNextMigrationJournal(null, base("prepared", 1, { activeRuntime: "trial" }));
  journal = resolver.buildNextMigrationJournal(journal.journal, base("source_frozen", 2));
  journal = resolver.buildNextMigrationJournal(journal.journal, base("target_restored", 3));
  journal = resolver.buildNextMigrationJournal(journal.journal, base("cutover_read_only", 4, { activeRuntime: "target" }));
  const rollbackClosedAt = "2026-09-04T00:00:05.000Z";
  const writeActivation = { confirmationSha256: fixedHash("f"), resumeBinding: fixtureEvidence("0") };
  journal = resolver.buildNextMigrationJournal(journal.journal, base("write_activation_pending", 5, { activeRuntime: "target", rollbackClosedAt, writeActivation }));
  journal = resolver.buildNextMigrationJournal(journal.journal, base("accepted", 6, {
    activeRuntime: "target",
    rollbackClosedAt,
    writeActivation,
    acceptedVersion: { versionId: accepted.versionId, recordSha256: accepted.recordSha256 }
  }));
  await writeFile(join(runtimeRoot, "migration-state.json"), journal.canonicalText, { mode: 0o600 });
  const secretsRoot = join(runtimeRoot, "secrets");
  await mkdir(secretsRoot, { recursive: true, mode: 0o700 });
  await chmod(secretsRoot, 0o700);
  await writeFile(join(secretsRoot, "mysql_app_password"), "app-secret", { mode: 0o600 });
  await writeFile(join(secretsRoot, "mysql_root_password"), "root-secret", { mode: 0o600 });

  const containerLabels = (service) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.container-number": "1",
    "io.shensi.api.runtime-nonce": runtimeNonce,
    "io.shensi.api.daemon-identity": selectedEngine.daemonIdentity
  });
  const engineResources = {
    internal: {
      Id: internalIdentity.id, Name: internalIdentity.name, Driver: "bridge", Scope: "local", Internal: true,
      Attachable: false, Ingress: false, IPAM: { Driver: "default", Config: [{ Subnet: "172.31.240.0/24", Gateway: "172.31.240.1" }] },
      Options: {}, Labels: labelsFor("com.docker.compose.network", "shensi_internal"), Containers: {}
    },
    egress: {
      Id: egressIdentity.id, Name: egressIdentity.name, Driver: "bridge", Scope: "local", Internal: false,
      Attachable: false, Ingress: false, IPAM: { Driver: "default", Config: [{ Subnet: "172.31.241.0/24", Gateway: "172.31.241.1" }] },
      Options: {}, Labels: labelsFor("com.docker.compose.network", "shensi_egress"), Containers: {}
    },
    host: {
      Id: hostIdentity.id, Name: hostIdentity.name, Driver: "bridge", Scope: "local", Internal: false,
      Attachable: false, Ingress: false, IPAM: { Driver: "default", Config: [{ Subnet: "172.31.242.0/24", Gateway: "172.31.242.1" }] },
      Options: { ...hostIdentity.options }, Labels: labelsFor("com.docker.compose.network", "shensi_host"), Containers: {}
    },
    volume: {
      Name: volumeIdentity.name, Driver: "local", Scope: "local", Mountpoint: volumeIdentity.mountpoint,
      CreatedAt: volumeIdentity.createdAt, Options: {}, Labels: labelsFor("com.docker.compose.volume", "mysql_data")
    }
  };
  const cleanState = (health) => ({
    Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0,
    ...(health ? { Health: { Status: health } } : {})
  });
  engineResources.mysql = {
    Id: expectedResources.mysql.containerId, Image: expectedResources.mysql.imageIdDigest,
    Config: { Labels: containerLabels("mysql") }, State: cleanState("healthy"),
    HostConfig: { PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "3311" }] } },
    NetworkSettings: { Networks: {
      [internalIdentity.name]: { NetworkID: internalIdentity.id, IPAddress: "172.31.240.3", IPPrefixLen: 24 },
      [hostIdentity.name]: { NetworkID: hostIdentity.id, IPAddress: "172.31.242.2", IPPrefixLen: 24 }
    }, Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "3311" }] } },
    Mounts: [
      { Type: "volume", Name: volumeIdentity.name, Source: volumeIdentity.mountpoint, Destination: "/var/lib/mysql", Mode: "rw", RW: true, Propagation: "" },
      { Type: "bind", Source: join(secretsRoot, "mysql_app_password"), Destination: "/run/secrets/mysql_app_password", Mode: "ro", RW: false, Propagation: "rprivate" },
      { Type: "bind", Source: join(secretsRoot, "mysql_root_password"), Destination: "/run/secrets/mysql_root_password", Mode: "ro", RW: false, Propagation: "rprivate" }
    ]
  };
  engineResources.backend = {
    Id: fixedHash("d"), Image: expectedResources.backend.imageIdDigest,
    Config: { Labels: containerLabels("backend") }, State: cleanState("healthy"), HostConfig: { PortBindings: {} },
    NetworkSettings: { Networks: {
      [internalIdentity.name]: { NetworkID: internalIdentity.id, IPAddress: "172.31.240.4", IPPrefixLen: 24 },
      [egressIdentity.name]: { NetworkID: egressIdentity.id, IPAddress: "172.31.241.2", IPPrefixLen: 24 }
    }, Ports: {} }, Mounts: []
  };
  engineResources.gateway = {
    Id: fixedHash("e"), Image: gateway.imageIdDigest,
    Config: { Labels: containerLabels("gateway") }, State: cleanState(null),
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "5608" }] } },
    NetworkSettings: { Networks: {
      [internalIdentity.name]: { NetworkID: internalIdentity.id, IPAddress: "172.31.240.2", IPPrefixLen: 24 },
      [hostIdentity.name]: { NetworkID: hostIdentity.id, IPAddress: "172.31.242.3", IPPrefixLen: 24 }
    }, Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "5608" }] } },
    Mounts: [{ Type: "bind", Source: join(versionRoot, "gateway.conf"), Destination: "/etc/nginx/conf.d/default.conf", Mode: "ro", RW: false, Propagation: "rprivate" }]
  };
  engineResources.internal.Containers = {
    [engineResources.mysql.Id]: { Name: "mysql" }, [engineResources.backend.Id]: { Name: "backend" }, [engineResources.gateway.Id]: { Name: "gateway" }
  };
  engineResources.egress.Containers = {
    [engineResources.backend.Id]: { Name: "backend" }
  };
  engineResources.host.Containers = {
    [engineResources.mysql.Id]: { Name: "mysql" },
    [engineResources.gateway.Id]: { Name: "gateway" }
  };
  engineResources.images = {
    mysql: { Id: expectedResources.mysql.imageIdDigest, RepoDigests: [] },
    backend: { Id: expectedResources.backend.imageIdDigest, RepoDigests: [] },
    gateway: { Id: gateway.imageIdDigest, RepoDigests: [] }
  };
  return { project, runtimeRoot, versionRoot, binding, accepted, expectedResources, gateway, engineResources };
}

function acceptedContainerState(status, { health = null } = {}) {
  const running = status === "running";
  return {
    Status: status,
    Running: running,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    Dead: false,
    ExitCode: 0,
    ...(health === null ? {} : { Health: { Status: health } })
  };
}

function acceptedSnapshot(accepted, adjust = () => {}) {
  const resources = structuredClone(accepted.engineResources);
  adjust(resources);
  return resources;
}

function acceptedEngineSequenceFixture(accepted, snapshots) {
  const expected = accepted.expectedResources;
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${expected.project}`] }));
  const labelsFor = (service) => ({
    "com.docker.compose.project": expected.project,
    "com.docker.compose.service": service,
    "io.shensi.api.runtime-nonce": expected.runtimeNonce,
    "io.shensi.api.daemon-identity": expected.engine.daemonIdentity
  });
  const inventories = snapshots.map((snapshot) => ({
    containers: [
      { Id: expected.mysql.containerId, Labels: labelsFor("mysql") },
      ...(snapshot.backend ? [{ Id: snapshot.backend.Id, Labels: labelsFor("backend") }] : []),
      ...(snapshot.gateway ? [{ Id: snapshot.gateway.Id, Labels: labelsFor("gateway") }] : [])
    ],
    networks: [
      { Id: expected.networks.internal.id, Name: expected.networks.internal.name, Labels: snapshot.internal.Labels },
      { Id: expected.networks.egress.id, Name: expected.networks.egress.name, Labels: snapshot.egress.Labels },
      { Id: expected.networks.host.id, Name: expected.networks.host.name, Labels: snapshot.host.Labels }
    ],
    volumes: [{ Name: expected.mysql.volumeName, Labels: snapshot.volume.Labels }]
  }));
  const sequence = (selector) => ({ sequence: snapshots.map(selector) });
  const responses = {
    "/info": COMPOSE_ENGINE_INFO,
    "/networks": [
      ...builtinInspectionNetworks(),
      structuredClone(accepted.engineResources.internal),
      structuredClone(accepted.engineResources.egress),
      structuredClone(accepted.engineResources.host)
    ],
    [`/containers/json?all=1&filters=${filter}`]: sequence((_, index) => inventories[index].containers),
    [`/networks?filters=${filter}`]: sequence((_, index) => inventories[index].networks),
    [`/volumes?filters=${filter}`]: sequence((_, index) => ({ Volumes: inventories[index].volumes, Warnings: null })),
    [`/networks/${encodeURIComponent(expected.networks.internal.id)}`]: sequence((snapshot) => snapshot.internal),
    [`/networks/${encodeURIComponent(expected.networks.egress.id)}`]: sequence((snapshot) => snapshot.egress),
    [`/networks/${encodeURIComponent(expected.networks.host.id)}`]: sequence((snapshot) => snapshot.host),
    [`/containers/${encodeURIComponent(expected.mysql.containerId)}/json`]: sequence((snapshot) => snapshot.mysql),
    [`/volumes/${encodeURIComponent(expected.mysql.volumeName)}`]: sequence((snapshot) => snapshot.volume),
    [`/containers/${encodeURIComponent(fixedHash("d"))}/json`]: sequence((snapshot) => snapshot.backend),
    [`/containers/${encodeURIComponent(fixedHash("e"))}/json`]: sequence((snapshot) => snapshot.gateway),
    [`/images/${encodeURIComponent(expected.mysql.imageIdDigest)}/json`]: accepted.engineResources.images.mysql,
    [`/images/${encodeURIComponent(expected.backend.imageIdDigest)}/json`]: accepted.engineResources.images.backend,
    [`/images/${encodeURIComponent(accepted.gateway.imageIdDigest)}/json`]: accepted.engineResources.images.gateway
  };
  return engineInspectionFixture(responses);
}

function acceptedLifecycleOptionsFixture(discovery, runtime, engine, { psRows = [] } = {}) {
  const calls = [];
  const routeOrNative = (virtualFunction, nativeFunction) => async (path, ...args) => path.startsWith("/usr") || path.startsWith("/safe") || path.startsWith("/Users/alice")
    ? await virtualFunction(path, ...args)
    : await nativeFunction(path, ...args);
  return {
    calls,
    options: {
      request: engine.request,
      async execFile() {
        return { stdout: [
          "Routing tables", "", "Internet:",
          "Destination Gateway Flags Netif", "default 192.168.1.1 UGScg en0", ""
        ].join("\n"), stderr: "" };
      },
      lstat: routeOrNative(discovery.lstat, lstat),
      realpath: routeOrNative(discovery.realpath, realpath),
      readlink: routeOrNative(discovery.readlink, nativeReadlink),
      access: routeOrNative(discovery.access, nativeAccess),
      async revalidateExecutable(path) { return path === runtime.argvPrefix[0]; },
      async probeDaemonIdentity() { return runtime.daemon.identity; },
      monotonicNow: () => 0,
      now: () => "2026-09-04T03:00:00.000Z",
      spawn(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => {
          if (args.slice(-3).join(" ") === "ps --format json") child.stdout.emit("data", Buffer.from(JSON.stringify(psRows)));
          child.emit("close", 0, null);
        });
        return child;
      }
    }
  };
}

test("API-only Compose exposes only the private MySQL/backend/gateway boundary", async () => {
  const compose = parse(await readFile(new URL("../deploy/compose.api-only.yaml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(compose.services).sort(), ["backend", "gateway", "mysql"]);
  assert.deepEqual(compose.services.backend.networks.sort(), ["shensi_egress", "shensi_internal"]);
  assert.deepEqual(compose.services.mysql.networks, { shensi_internal: null, shensi_host: null });
  assert.match(compose.services.gateway.networks.shensi_internal.ipv4_address, /^\$\{SHENSI_API_GATEWAY_IP:\?[^}]+\}$/u);
  assert.deepEqual(compose.networks.shensi_internal.ipam.config, [{ subnet: "${SHENSI_API_INTERNAL_SUBNET:?required}", gateway: "${SHENSI_API_IPAM_GATEWAY:?required}" }]);
  assert.notEqual(compose.networks.shensi_internal.ipam.config[0].gateway, compose.services.gateway.networks.shensi_internal.ipv4_address);
  assert.equal(compose.networks.shensi_internal.internal, true);
  assert.equal(compose.name, undefined);
  assert.equal(compose.volumes.mysql_data, null);
  assert.equal(compose.services.mysql.image, "mysql:8.4.11");
  assert.equal(compose.services.gateway.image, "nginxinc/nginx-unprivileged:1.27-alpine");
  assert.equal(compose.services.backend.build.dockerfile, "deploy/docker/backend.Dockerfile");
  assert.match(compose.services.gateway.ports[0], /^127\.0\.0\.1:\$\{SHENSI_API_HTTP_PORT:\?[^}]+\}:8080$/u);
  assert.match(compose.services.mysql.ports[0], /^127\.0\.0\.1:\$\{SHENSI_API_MYSQL_HOST_PORT:\?[^}]+\}:3306$/u);
  const environment = compose.services.backend.environment;
  for (const [name, value] of Object.entries({ CRM_STORE: "mysql", BACKEND_HOST: "0.0.0.0", PORT: "4188", DOUYIN_OUTREACH_ACTIONS_ENABLED: "false", DOUYIN_OUTREACH_APPROVALS_ENABLED: "true", DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false", DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "false", SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked" })) assert.equal(String(environment[name]), value);
  assert.match(environment.TRUSTED_PROXY_CIDRS, /^\$\{SHENSI_API_GATEWAY_IP:\?[^}]+\}\/32$/u);
  assert.match(environment.SHENSI_API_GATEWAY_IP, /^\$\{SHENSI_API_GATEWAY_IP:\?[^}]+\}$/u);
  assert.equal(Object.keys(environment).some((name) => name.startsWith("MEDIACRAWLER_")), false);
  assert.deepEqual(compose.services.backend.depends_on, { mysql: { condition: "service_healthy" } });
  assert.deepEqual(compose.services.gateway.depends_on, { backend: { condition: "service_healthy" } });
  assert.deepEqual(compose.networks.shensi_internal.labels, {
    "io.shensi.api.runtime-nonce": "${SHENSI_API_RUNTIME_NONCE:?required}",
    "io.shensi.api.daemon-identity": "${SHENSI_API_DAEMON_IDENTITY:?required}"
  });
  assert.equal(compose.services.gateway.networks.shensi_egress, undefined);
  assert.equal(compose.services.gateway.networks.shensi_host, null);
  assert.deepEqual(compose.networks.shensi_host.driver_opts, {
    "com.docker.network.bridge.enable_ip_masquerade": "false",
    "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
  });
  assert.deepEqual(compose.secrets.mysql_app_password, { file: "${SHENSI_API_MYSQL_APP_PASSWORD_FILE:?required}" });
  assert.deepEqual(compose.secrets.mysql_root_password, { file: "${SHENSI_API_MYSQL_ROOT_PASSWORD_FILE:?required}" });
  assert.deepEqual(compose.services.gateway.volumes, ["${SHENSI_API_GATEWAY_CONFIG_FILE:?required}:/etc/nginx/conf.d/default.conf:ro"]);
});

test("nginx has a health endpoint, API-only proxy, and deny-by-default HTTP surface", async () => {
  const nginx = await readFile(new URL("../deploy/nginx/api-only.conf", import.meta.url), "utf8");
  assert.match(nginx, /location = \/healthz \{ access_log off; default_type text\/plain; return 200 "ok\\n"; \}/u);
  assert.match(nginx, /location \^~ \/api\/ \{/u);
  assert.match(nginx, /proxy_pass http:\/\/backend:4188;/u);
  assert.match(nginx, /location \/ \{ return 404; \}/u);
  const locations = [...nginx.matchAll(/^\s*(location\s+[^\{]+)\{/gmu)].map((match) => match[1].trim());
  assert.deepEqual(locations, ["location = /healthz", "location ^~ /api/", "location /"]);
  assert.doesNotMatch(nginx, /douyin-live|live-sessions|novnc|vnc|websockify|proxy_set_header\s+Upgrade/iu);
});

test("CLI and repository surface expose exactly the required API-only commands", async () => {
  // Catches a future CLI branch that lets an operator smuggle a flag or a
  // lifecycle command into the private supervisor.
  const commands = [
    "prepare", "db-start", "start", "stop", "status", "verify",
    "verify-empty", "migration-preflight", "migration-run", "cutover",
    "rollback", "accept-prepare", "accept", "accept-resume", "active-project"
  ];
  for (const command of commands) assert.deepEqual(parseApiOnlyCli([command]), { command });
  for (const argv of [[], ["start", "--force"], ["start", "extra"], ["destroy"], ["verify-empty", "--project-name", "shensi-api"]]) {
    assert.throws(() => parseApiOnlyCli(argv), /API_ONLY_CLI_ARGUMENT_INVALID/u);
  }

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(packageJson.scripts).filter(([name]) => name.startsWith("api:"))),
    {
      "api:prepare": "node scripts/api-only-runtime.mjs prepare",
      "api:runtime:doctor": "node scripts/container-runtime.mjs doctor",
      "api:db:start": "node scripts/api-only-runtime.mjs db-start",
      "api:start": "node scripts/api-only-runtime.mjs start",
      "api:stop": "node scripts/api-only-runtime.mjs stop",
      "api:status": "node scripts/api-only-runtime.mjs status",
      "api:verify": "node scripts/api-only-runtime.mjs verify",
      "api:verify:empty": "node scripts/api-only-runtime.mjs verify-empty",
      "api:verify:desktop-action-storage:installation": "node scripts/verify-desktop-action-storage.mjs installation",
      "api:verify:desktop-action-storage:binding": "node scripts/verify-desktop-action-storage.mjs binding",
      "api:verify:desktop-action-storage:actions": "node scripts/verify-desktop-action-storage.mjs actions",
      "api:verify:desktop-action-storage:all": "node scripts/verify-desktop-action-storage.mjs all",
      "api:verify:desktop-action-bridge:mysql": "node scripts/verify-desktop-action-storage.mjs bridge-mysql",
      "api:verify:multi-mac-crm:mysql": "node scripts/verify-desktop-action-storage.mjs multi-mac-crm",
      "api:migration:preflight": "node scripts/api-only-runtime.mjs migration-preflight",
      "api:migration:run": "node scripts/api-only-runtime.mjs migration-run",
      "api:cutover": "node scripts/api-only-runtime.mjs cutover",
      "api:rollback": "node scripts/api-only-runtime.mjs rollback",
      "api:accept:prepare": "node scripts/api-only-runtime.mjs accept-prepare",
      "api:accept": "node scripts/api-only-runtime.mjs accept",
      "api:accept:resume": "node scripts/api-only-runtime.mjs accept-resume",
      "api:active-project": "node scripts/api-only-runtime.mjs active-project"
    }
  );

  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.runtime\/$/mu);
  assert.doesNotMatch(gitignore, /^(?:docs\/migration|docs\/\*\*|docs\/)\s*$/mu);
});

test("CLI dispatch invokes exactly one allow-listed handler and preserves named gates", async () => {
  const commands = [
    "prepare", "db-start", "start", "stop", "status", "verify",
    "verify-empty", "migration-preflight", "migration-run", "cutover",
    "rollback", "accept-prepare", "accept", "accept-resume", "active-project"
  ];
  const calls = [];
  const handlers = Object.fromEntries(commands.map((command) => [command, async () => {
    calls.push(command);
    return `handled:${command}`;
  }]));

  for (const command of commands) {
    calls.length = 0;
    assert.equal(await dispatchApiOnlyCli([command], handlers), `handled:${command}`);
    assert.deepEqual(calls, [command]);
  }

  await assert.rejects(dispatchApiOnlyCli(["destroy"], handlers), /API_ONLY_CLI_ARGUMENT_INVALID/u);
  await assert.rejects(
    dispatchApiOnlyCli(["verify-empty"], { ...handlers, "verify-empty": undefined }),
    /API_ONLY_COMMAND_GATE_REQUIRED:verify-empty/u
  );
  const inherited = Object.create(handlers);
  await assert.rejects(dispatchApiOnlyCli(["accept-resume"], inherited), /API_ONLY_COMMAND_GATE_REQUIRED:accept-resume/u);
  assert.deepEqual(calls, ["active-project"]);
});

test("prepare accepts only a Task 1-resolved runtime and ignores ambient or arbitrary runtime authorities", async () => {
  const root = await fixture();
  try {
    const discovery = composeRuntimeDiscoveryFixture();
    let arbitraryRuntimeCalls = 0;
    const runtime = await prepareApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: discovery,
      discoverRuntime: async () => {
        arbitraryRuntimeCalls += 1;
        throw new Error("ARBITRARY_RUNTIME_CALLBACK_USED");
      }
    });
    assert.equal(arbitraryRuntimeCalls, 0);
    assert.match(doctorSummary(runtime.composeRuntime), /^API_ONLY_DOCTOR /u);
    assert.equal(runtime.composeRuntime.socket.canonicalPath, "/Users/alice/runtime/docker.sock");
    assert.equal(runtime.composeRuntime.environment.DOCKER_HOST, "unix:///Users/alice/runtime/docker.sock");
    assert.equal(runtime.composeRuntime.environment.HOME, "/Users/alice");
    assert.equal(discovery.calls.some(({ socket }) => socket === "tcp://ambient.example:2375"), false);
    assert.deepEqual(
      discovery.calls.filter(({ type }) => type === "daemon").map(({ path }) => path),
      ["/_ping", "/info", "/_ping", "/info"]
    );
    assert.equal((await lstat(join(runtime.root, "container-runtime-selection.json"))).mode & 0o777, 0o600);
  } finally { await cleanup(root); }

  for (const [name, discovery, expected] of [
    ["executable", composeRuntimeDiscoveryFixture({ unsafeExecutable: true }), /COMPOSE_EXECUTABLE_REQUIRED/u],
    ["socket", composeRuntimeDiscoveryFixture({ unsafeSocket: true }), /DOCKER_SOCKET_REQUIRED/u],
    ["daemon", composeRuntimeDiscoveryFixture({ invalidDaemon: true }), /DAEMON_UNAVAILABLE/u]
  ]) {
    const invalidRoot = await fixture();
    try {
      let arbitraryRuntimeCalls = 0;
      await assert.rejects(prepareApiOnlyRuntime(invalidRoot, {
        ...preparedOptions(invalidRoot),
        composeRuntimeDiscoveryOptions: discovery,
        discoverRuntime: async () => {
          arbitraryRuntimeCalls += 1;
          return fakeRuntime();
        }
      }), expected, name);
      assert.equal(arbitraryRuntimeCalls, 0, name);
    } finally { await cleanup(invalidRoot); }
  }
});

test("prepare derives one persisted Task 1 network claim, private environment, and sealed render from complete inventories", async () => {
  const root = await fixture();
  try {
    const boundary = taskOneBoundaryFixture({ routes: [{ destination: "198.18.250.0/24" }] });
    const runtime = await prepareApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeRenderOptions: boundary.composeRenderOptions,
      runCompose: async () => { throw new Error("ARBITRARY_COMPOSE_RUNNER_USED"); }
    });
    assert.deepEqual(Object.keys(runtime.networkClaim), [
      "schema", "version", "issuedAt", "socketIdentity", "daemonIdentity", "projectName", "networkName",
      "runtimeNonce", "subnet", "ipamGatewayIp", "gatewayServiceIp", "expectedLabels", "existingNetwork"
    ]);
    assert.equal(runtime.networkClaim.subnet, "198.18.251.0/24");
    assert.equal(runtime.networkClaim.ipamGatewayIp, "198.18.251.1");
    assert.equal(runtime.networkClaim.gatewayServiceIp, "198.18.251.254");
    assert.equal(runtime.networkClaim.projectName, runtime.project);
    assert.equal(runtime.networkClaim.runtimeNonce, runtime.runtimeNonce);

    const backend = Object.fromEntries((await readFile(runtime.environmentFile, "utf8")).trimEnd().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(backend.TRUSTED_PROXY_CIDRS, "198.18.251.254/32");
    assert.deepEqual(boundary.engineCalls.map(({ path }) => path), ["/info", "/networks"]);
    assert.deepEqual(boundary.routeCalls.map(({ command, args, options }) => ({ command, args, shell: options.shell })), [{
      command: "/usr/sbin/netstat",
      args: ["-rn", "-f", "inet"],
      shell: false
    }]);

    const render = boundary.renderCalls.find(({ type }) => type === "spawn");
    assert.deepEqual(render.args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api", "config", "--quiet"
    ]);
    assert.equal(render.options.shell, false);
    assert.equal(render.options.env.SHENSI_API_INTERNAL_SUBNET, runtime.networkClaim.subnet);
    assert.equal(render.options.env.SHENSI_API_IPAM_GATEWAY, runtime.networkClaim.ipamGatewayIp);
    assert.equal(render.options.env.SHENSI_API_GATEWAY_IP, runtime.networkClaim.gatewayServiceIp);
    assert.equal(render.options.env.SHENSI_API_RUNTIME_NONCE, runtime.runtimeNonce);
    assert.equal(render.options.env.SHENSI_API_DAEMON_IDENTITY, runtime.composeRuntime.daemon.identity);

    const selection = await assertRuntimeSelection(runtime.root, runtime.composeRuntime, {
      projectName: runtime.project,
      runtimeNonce: runtime.runtimeNonce
    });
    assert.deepEqual(selection.record.ownership.networkClaim, runtime.networkClaim);
    assert.equal(selection.toolchainChanged, false);
    const active = JSON.parse(await readFile(join(runtime.root, "active-project.json"), "utf8"));
    assert.deepEqual(active.networkClaim, runtime.networkClaim);
  } finally { await cleanup(root); }
});

test("each lifecycle mutation uses a fresh one-use Task 1 authorization and rejects pre-spawn or post-create topology drift", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const success = taskOneBoundaryFixture({ promoteAfterMutation: true });
    const composeTimeouts = [];
    assert.equal(prepared.networkClaim.runtimeNonce, fixtureRuntimeNonce());
    assert.equal(prepared.networkClaim.daemonIdentity, success.daemonIdentity);
    assert.deepEqual(success.postNetwork.Labels, prepared.networkClaim.expectedLabels);
    let arbitraryRunnerCalls = 0;
    await startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: success.discovery,
      networkInspectionOptions: success.networkInspectionOptions,
      composeMutationOptions: {
        ...success.composeMutationOptions,
        setTimeout(callback, milliseconds) {
          composeTimeouts.push(milliseconds);
          return setTimeout(callback, milliseconds);
        },
        clearTimeout
      },
      requestHttpHealth: async (input) => input.url.endsWith("/healthz")
        ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
        : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) },
      inspectBootstrapBackendImage: async (input) => bootstrapBackendObservation(input),
      runCompose: async () => {
        arbitraryRunnerCalls += 1;
        throw new Error("ARBITRARY_COMPOSE_RUNNER_USED");
      }
    });
    assert.equal(arbitraryRunnerCalls, 0);
    const mutation = success.mutationCalls.find(({ type }) => type === "spawn");
    assert.deepEqual(mutation.args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api",
      "up", "-d", "--build", "mysql", "backend", "gateway"
    ]);
    assert.equal(mutation.options.env.SHENSI_API_INTERNAL_SUBNET, prepared.networkClaim.subnet);
    assert.equal(mutation.options.env.SHENSI_API_RUNTIME_NONCE, prepared.networkClaim.runtimeNonce);
    assert.deepEqual(composeTimeouts, [600_000]);
    assert.equal(success.engineCalls.filter(({ path }) => path === "/networks").length, 2);
    assert.equal(success.engineCalls.filter(({ path }) => path === `/networks/${prepared.project}_shensi_internal`).length, 3);
    assert.equal(success.engineCalls.some(({ path }) => path.startsWith("/containers/json?")), true);

    const conflict = taskOneBoundaryFixture({
      networks: [...builtinInspectionNetworks(), rawInspectionNetwork({
        id: "9".repeat(64),
        name: "foreign_collision",
        subnet: prepared.networkClaim.subnet,
        gateway: prepared.networkClaim.ipamGatewayIp,
        labels: { owner: "foreign" }
      })]
    });
    await assert.rejects(startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: conflict.discovery,
      networkInspectionOptions: conflict.networkInspectionOptions,
      composeMutationOptions: conflict.composeMutationOptions,
      runCompose: async () => { throw new Error("ARBITRARY_COMPOSE_RUNNER_USED"); }
    }), /API_NETWORK_CLAIM_CONFLICT/u);
    assert.equal(conflict.mutationCalls.some(({ type }) => type === "spawn"), false);

    const wrongGateway = taskOneBoundaryFixture({
      networks: [...builtinInspectionNetworks(), success.postNetwork],
      postGateway: [{
        Id: "3".repeat(64),
        Labels: { "com.docker.compose.project": "shensi-api", "com.docker.compose.service": "gateway" },
        NetworkSettings: {
          Networks: {
            "shensi-api_shensi_internal": { IPAddress: "198.18.250.9", IPPrefixLen: 24, NetworkID: "2".repeat(64) }
          }
        }
      }]
    });
    await assert.rejects(startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: wrongGateway.discovery,
      networkInspectionOptions: wrongGateway.networkInspectionOptions,
      composeMutationOptions: wrongGateway.composeMutationOptions
    }), /API_NETWORK_GATEWAY_INSPECTION_INVALID|API_NETWORK_POST_CREATE_MISMATCH/u);
    assert.equal(wrongGateway.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
  } finally { await cleanup(root); }
});

test("bootstrap db-start holds the retained lock, rechecks both target ports, performs one authorized up mysql, promotes ownership, and waits for bounded MySQL health", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
    const ports = [];
    const healthCalls = [];
    const options = {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      isPortAvailable: async (port) => { ports.push(port); return true; },
      mysqlHealthTimeoutMs: 1_250,
      async waitForMysqlHealth(input) {
        healthCalls.push(input);
        assert.equal((await lstat(join(prepared.root, "owner.lock"))).isFile(), true);
        await assert.rejects(acquireApiOnlyOwnerLock(root, {
          ...options,
          isProcessCurrent: async () => true
        }), /API_ONLY_OWNER_LOCK_HELD/u);
        const active = JSON.parse(await readFile(join(prepared.root, "active-project.json"), "utf8"));
        assert.deepEqual(active.networkClaim.existingNetwork, input.network);
        const selection = await assertRuntimeSelection(prepared.root, prepared.composeRuntime, {
          projectName: prepared.project,
          runtimeNonce: prepared.runtimeNonce
        });
        assert.deepEqual(selection.record.ownership.networkClaim.existingNetwork, input.network);
        return {
          status: "healthy",
          project: input.project,
          runtimeNonce: input.runtimeNonce,
          networkId: input.network.id,
          networkName: input.network.name,
          service: "mysql",
          containerId: "4".repeat(64)
        };
      }
    };

    await startApiOnlyDatabase(root, options);

    assert.deepEqual(ports, [API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql]);
    const mutations = boundary.mutationCalls.filter(({ type }) => type === "spawn");
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api",
      "up", "-d", "mysql"
    ]);
    assert.equal(mutations[0].options.env.SHENSI_API_RUNTIME_NONCE, prepared.runtimeNonce);
    assert.deepEqual(healthCalls, [{
      project: prepared.project,
      runtimeNonce: prepared.runtimeNonce,
      host: "127.0.0.1",
      port: API_ONLY_PORTS.mysql,
      timeoutMs: 1_250,
      network: { id: "2".repeat(64), name: `${prepared.project}_shensi_internal` }
    }]);
    assert.equal(boundary.engineCalls.filter(({ path }) => path === "/networks").length, 2);
    assert.equal(boundary.engineCalls.filter(({ path }) => path === `/networks/${prepared.project}_shensi_internal`).length, 1);
    await assert.rejects(lstat(join(prepared.root, "status.json")), (caught) => caught?.code === "ENOENT");
  } finally { await cleanup(root); }
});

test("bootstrap db-start fails before Compose when either canonical port is occupied", async () => {
  for (const occupied of [API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql]) {
    const root = await fixture();
    try {
      const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
      const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
      const checked = [];
      let healthCalls = 0;
      await assert.rejects(startApiOnlyDatabase(root, {
        ...preparedOptions(root),
        composeRuntimeDiscoveryOptions: boundary.discovery,
        networkInspectionOptions: boundary.networkInspectionOptions,
        composeMutationOptions: boundary.composeMutationOptions,
        isPortAvailable: async (port) => { checked.push(port); return port !== occupied; },
        waitForMysqlHealth: async () => { healthCalls += 1; throw new Error("HEALTH_MUST_NOT_RUN"); }
      }), new RegExp(`API_ONLY_PORT_OCCUPIED:${occupied}`, "u"));
      assert.deepEqual(checked, occupied === API_ONLY_PORTS.gateway
        ? [API_ONLY_PORTS.gateway]
        : [API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql]);
      assert.equal(boundary.mutationCalls.some(({ type }) => type === "spawn"), false);
      assert.equal(healthCalls, 0);
      const active = JSON.parse(await readFile(join(prepared.root, "active-project.json"), "utf8"));
      assert.equal(active.networkClaim.existingNetwork, null);
    } finally { await cleanup(root); }
  }
});

test("bootstrap db-start rejects bounded MySQL timeout and health identity drift without a status commit", async () => {
  for (const failureKind of ["timeout", "identity"]) {
    const root = await fixture();
    try {
      const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
      const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
      let armedTimeout = null;
      const timeoutPromise = new Promise(() => {});
      const options = {
        ...preparedOptions(root),
        composeRuntimeDiscoveryOptions: boundary.discovery,
        networkInspectionOptions: boundary.networkInspectionOptions,
        composeMutationOptions: boundary.composeMutationOptions,
        isPortAvailable: async () => true,
        mysqlHealthTimeoutMs: 900,
        waitForMysqlHealth: failureKind === "timeout"
          ? async () => timeoutPromise
          : async (input) => ({
              status: "healthy",
              project: input.project,
              runtimeNonce: input.runtimeNonce,
              networkId: "5".repeat(64),
              networkName: input.network.name,
              service: "mysql",
              containerId: "4".repeat(64)
            }),
        ...(failureKind === "timeout" ? {
          mysqlHealthSetTimeout(callback, milliseconds) {
            armedTimeout = milliseconds;
            queueMicrotask(callback);
            return Object.freeze({ timer: "fixture" });
          },
          mysqlHealthClearTimeout() {}
        } : {})
      };
      await assert.rejects(startApiOnlyDatabase(root, options), failureKind === "timeout"
        ? /API_ONLY_MYSQL_HEALTH_TIMEOUT/u
        : /API_ONLY_MYSQL_HEALTH_IDENTITY_MISMATCH/u);
      assert.equal(boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
      assert.equal(armedTimeout, failureKind === "timeout" ? 900 : null);
      const active = JSON.parse(await readFile(join(prepared.root, "active-project.json"), "utf8"));
      assert.deepEqual(active.networkClaim.existingNetwork, { id: "2".repeat(64), name: `${prepared.project}_shensi_internal` });
      await assert.rejects(lstat(join(prepared.root, "status.json")), (caught) => caught?.code === "ENOENT");
      await assert.rejects(lstat(join(prepared.root, "owner.lock")), (caught) => caught?.code === "ENOENT");
    } finally { await cleanup(root); }
  }
});

async function disposableMysqlStartFixture() {
  const root = await fixture();
  const project = "shensi-api-empty-0123456789ab";
  const options = {
    ...preparedOptions(root),
    disposable: true,
    project,
    runtimeRoot: join(root, ".runtime", "api-only-empty", "0123456789ab")
  };
  const runtime = await prepareApiOnlyRuntime(root, options);
  const network = rawInspectionNetwork({
    id: fixedHash("2"),
    name: `${project}_shensi_internal`,
    subnet: runtime.networkClaim.subnet,
    gateway: runtime.networkClaim.ipamGatewayIp,
    labels: runtime.networkClaim.expectedLabels
  });
  const boundary = taskOneBoundaryFixture();
  const networkEngine = engineInspectionFixture({
    "/networks": { sequence: [builtinInspectionNetworks(), [...builtinInspectionNetworks(), network]] },
    [`/networks/${network.Name}`]: network
  });
  const containerId = fixedHash("4");
  const labels = {
    "com.docker.compose.project": project,
    "com.docker.compose.service": "mysql"
  };
  const listed = [{ Id: containerId, Labels: { ...labels }, State: "running", Status: "Up (healthy)" }];
  const detail = {
    Id: containerId,
    Image: `sha256:${fixedHash("5")}`,
    Config: { Labels: { ...labels } },
    State: { Status: "running", Running: true, Health: { Status: "healthy", FailingStreak: 0, Log: [] } },
    NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } }
  };
  const engineCalls = [];
  Object.assign(options, {
    composeRuntimeDiscoveryOptions: boundary.discovery,
    networkInspectionOptions: { ...boundary.networkInspectionOptions, request: networkEngine.request },
    composeMutationOptions: boundary.composeMutationOptions,
    mysqlHealthTimeoutMs: 900,
    readDisposableEngineJson: async (selectedRuntime, path) => {
      assert.equal(selectedRuntime.socket.canonicalPath, "/Users/alice/runtime/docker.sock");
      engineCalls.push(path);
      if (path.startsWith("/containers/json?")) return listed;
      if (path === `/containers/${containerId}/json`) return detail;
      throw new Error(`Unexpected disposable MySQL Engine endpoint: ${path}`);
    }
  });
  return { root, runtime, options, boundary, network, containerId, listed, detail, engineCalls };
}

test("disposable db-start defaults to real MySQL Engine health without an injected health adapter", async () => {
  const fixture = await disposableMysqlStartFixture();
  try {
    await startApiOnlyDatabase(fixture.root, fixture.options);
    const filter = encodeURIComponent(JSON.stringify({ label: [
      "com.docker.compose.project=shensi-api-empty-0123456789ab",
      "com.docker.compose.service=mysql"
    ] }));
    assert.deepEqual(fixture.engineCalls, [
      `/containers/json?all=1&filters=${filter}`,
      `/containers/${fixedHash("4")}/json`
    ]);
    const mutations = fixture.boundary.mutationCalls.filter(({ type }) => type === "spawn");
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].args.slice(-3), ["up", "-d", "mysql"]);
    const active = JSON.parse(await readFile(join(fixture.runtime.root, "active-project.json"), "utf8"));
    assert.deepEqual(active.networkClaim.existingNetwork, {
      id: fixedHash("2"), name: "shensi-api-empty-0123456789ab_shensi_internal"
    });
    await assert.rejects(lstat(join(fixture.runtime.root, "status.json")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("disposable db-start polls actual starting MySQL health until the same container is healthy", async () => {
  const fixture = await disposableMysqlStartFixture();
  const read = fixture.options.readDisposableEngineJson;
  let detailReads = 0;
  fixture.options.readDisposableEngineJson = async (runtime, path) => {
    const result = await read(runtime, path);
    if (path !== `/containers/${fixture.containerId}/json`) return result;
    detailReads += 1;
    return {
      ...result,
      State: { ...result.State, Health: { Status: detailReads === 1 ? "starting" : "healthy" } }
    };
  };
  try {
    await startApiOnlyDatabase(fixture.root, fixture.options);
    assert.equal(detailReads, 2);
    assert.equal(fixture.engineCalls.length, 4);
    assert.equal(fixture.engineCalls[0], fixture.engineCalls[2]);
    assert.equal(fixture.engineCalls[1], fixture.engineCalls[3]);
  } finally { await cleanup(fixture.root); }
});

for (const [name, mutate] of [
  ["unhealthy detail despite a healthy list summary", ({ detail }) => { detail.State.Health.Status = "unhealthy"; }],
  ["missing detail health despite a running container", ({ detail }) => { delete detail.State.Health; }],
  ["unknown detail health", ({ detail }) => { detail.State.Health.Status = "ready"; }],
  ["terminal container state despite healthy detail", ({ detail }) => { detail.State.Status = "exited"; detail.State.Running = false; }],
  ["restarting container state despite healthy detail", ({ detail }) => { detail.State.Status = "restarting"; }],
  ["missing service container", ({ listed }) => { listed.length = 0; }],
  ["duplicate service containers", ({ listed }) => { listed.push({ ...listed[0], Id: fixedHash("6") }); }],
  ["wrong summary project", ({ listed }) => { listed[0].Labels["com.docker.compose.project"] = "shensi-api"; }],
  ["wrong summary service", ({ listed }) => { listed[0].Labels["com.docker.compose.service"] = "backend"; }],
  ["wrong inspected project", ({ detail }) => { detail.Config.Labels["com.docker.compose.project"] = "shensi-api"; }],
  ["wrong inspected service", ({ detail }) => { detail.Config.Labels["com.docker.compose.service"] = "backend"; }],
  ["wrong inspected container ID", ({ detail }) => { detail.Id = fixedHash("6"); }],
  ["wrong inspected network ID", ({ detail, network }) => { detail.NetworkSettings.Networks[network.Name].NetworkID = fixedHash("6"); }],
  ["missing expected network attachment", ({ detail }) => { detail.NetworkSettings.Networks = {}; }]
]) {
  test(`disposable db-start rejects ${name}`, async () => {
    const fixture = await disposableMysqlStartFixture();
    mutate(fixture);
    try {
      await assert.rejects(startApiOnlyDatabase(fixture.root, fixture.options), {
        message: "API_ONLY_MYSQL_HEALTH_FAILED"
      });
      assert.equal(fixture.engineCalls.length <= 2, true);
      assert.equal(fixture.boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
      await assert.rejects(lstat(join(fixture.runtime.root, "status.json")), { code: "ENOENT" });
    } finally { await cleanup(fixture.root); }
  });
}

test("disposable db-start rejects a healthy replacement container after observing the original starting", async () => {
  const fixture = await disposableMysqlStartFixture();
  const read = fixture.options.readDisposableEngineJson;
  const replacementId = fixedHash("6");
  let generations = 0;
  fixture.options.readDisposableEngineJson = async (runtime, path) => {
    if (path === `/containers/${replacementId}/json`) {
      fixture.engineCalls.push(path);
      return { ...fixture.detail, Id: replacementId };
    }
    const result = await read(runtime, path);
    if (path.startsWith("/containers/json?")) {
      generations += 1;
      return generations === 1 ? result : [{ ...result[0], Id: replacementId }];
    }
    return { ...result, State: { ...result.State, Health: { Status: "starting" } } };
  };
  try {
    await assert.rejects(startApiOnlyDatabase(fixture.root, fixture.options), {
      message: "API_ONLY_MYSQL_HEALTH_FAILED"
    });
    assert.equal(generations, 2);
    await assert.rejects(lstat(join(fixture.runtime.root, "status.json")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("disposable db-start deadline cancels an in-flight read-only Engine request before returning", async () => {
  const fixture = await disposableMysqlStartFixture();
  delete fixture.options.readDisposableEngineJson;
  const requests = [];
  const timeoutDurations = [];
  const outerTimer = Object.freeze({ timer: "mysql-health" });
  const engineTimer = Object.freeze({ timer: "engine-read" });
  let expireHealth;
  let clearHealth = 0;
  let clearEngine = 0;
  let destroyedRequests = 0;
  let destroyedResponses = 0;
  Object.assign(fixture.options, {
    mysqlHealthSetTimeout(callback, milliseconds) {
      expireHealth = callback;
      timeoutDurations.push(milliseconds);
      return outerTimer;
    },
    mysqlHealthClearTimeout(timer) { assert.equal(timer, outerTimer); clearHealth += 1; },
    disposableEngineSetTimeout() { return engineTimer; },
    disposableEngineClearTimeout(timer) { assert.equal(timer, engineTimer); clearEngine += 1; },
    disposableEngineRequest(input, onResponse) {
      requests.push(input);
      const outgoing = new EventEmitter();
      outgoing.destroy = () => { destroyedRequests += 1; return outgoing; };
      outgoing.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        response.headersDistinct = { "content-type": ["application/json"] };
        response.complete = false;
        response.destroy = () => { destroyedResponses += 1; return response; };
        onResponse(response);
        response.emit("data", Buffer.from("["));
        expireHealth();
      });
      return outgoing;
    }
  });
  try {
    await assert.rejects(startApiOnlyDatabase(fixture.root, fixture.options), {
      message: "API_ONLY_MYSQL_HEALTH_TIMEOUT"
    });
    assert.deepEqual(timeoutDurations, [900]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].socketPath, "/Users/alice/runtime/docker.sock");
    assert.equal(destroyedRequests, 1);
    assert.equal(destroyedResponses, 1);
    assert.equal(clearHealth, 1);
    assert.equal(clearEngine, 1);
    await assert.rejects(lstat(join(fixture.runtime.root, "status.json")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("disposable db-start deadline drains a pending health poll delay before the next event-loop turn", async () => {
  const fixture = await disposableMysqlStartFixture();
  const read = fixture.options.readDisposableEngineJson;
  const timer = Object.freeze({ timer: "mysql-health" });
  const events = [];
  let expireHealth;
  let followingTurn;
  Object.assign(fixture.options, {
    mysqlHealthSetTimeout(callback) { expireHealth = callback; return timer; },
    mysqlHealthClearTimeout(value) { assert.equal(value, timer); },
    readDisposableEngineJson: async (runtime, path) => {
      const result = await read(runtime, path);
      if (path !== `/containers/${fixture.containerId}/json`) return result;
      // The read and its promise continuations finish first, allowing the real
      // polling delay to arm before this controlled outer deadline fires.
      setImmediate(() => {
        expireHealth();
        followingTurn = new Promise((resolveTurn) => setImmediate(() => {
          events.push("next-turn");
          resolveTurn();
        }));
      });
      return { ...result, State: { ...result.State, Health: { Status: "starting" } } };
    }
  });
  try {
    await assert.rejects(startApiOnlyDatabase(fixture.root, fixture.options), {
      message: "API_ONLY_MYSQL_HEALTH_TIMEOUT"
    });
    events.push("returned");
    await followingTurn;
    assert.deepEqual(events, ["returned", "next-turn"]);
    assert.equal(fixture.engineCalls.length, 2);
    await assert.rejects(lstat(join(fixture.runtime.root, "status.json")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("bootstrap start rechecks both ports, preserves the exact build argv, promotes ownership, and proves Gateway plus Backend health independently", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
    const ports = [];
    const requests = [];
    await startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      isPortAvailable: async (port) => { ports.push(port); return true; },
      httpHealthTimeoutMs: 1_350,
      async requestHttpHealth(input) {
        requests.push({ url: input.url, method: input.method, maximumBytes: input.maximumBytes, aborted: input.signal.aborted });
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ ok: true, store: "mysql" }) };
      },
      inspectBootstrapBackendImage: async (input) => bootstrapBackendObservation(input)
    });

    assert.deepEqual(ports, [API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql]);
    const mutations = boundary.mutationCalls.filter(({ type }) => type === "spawn");
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api",
      "up", "-d", "--build", "mysql", "backend", "gateway"
    ]);
    assert.deepEqual(requests, [
      { url: `http://127.0.0.1:${API_ONLY_PORTS.gateway}/healthz`, method: "GET", maximumBytes: 8_192, aborted: false },
      { url: `http://127.0.0.1:${API_ONLY_PORTS.gateway}/api/health`, method: "GET", maximumBytes: 8_192, aborted: false }
    ]);
    const active = JSON.parse(await readFile(join(prepared.root, "active-project.json"), "utf8"));
    assert.deepEqual(active.networkClaim.existingNetwork, { id: "2".repeat(64), name: `${prepared.project}_shensi_internal` });
  } finally { await cleanup(root); }
});

test("bootstrap start rejects health timeout, malformed payload, and wrong response origin before status commit", async () => {
  for (const failureKind of ["timeout", "malformed", "wrong-origin"]) {
    const root = await fixture();
    try {
      const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
      const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
      const requests = [];
      const never = new Promise(() => {});
      const options = {
        ...preparedOptions(root),
        composeRuntimeDiscoveryOptions: boundary.discovery,
        networkInspectionOptions: boundary.networkInspectionOptions,
        composeMutationOptions: boundary.composeMutationOptions,
        isPortAvailable: async () => true,
        httpHealthTimeoutMs: 800,
        async requestHttpHealth(input) {
          requests.push(input.url);
          if (failureKind === "timeout") return never;
          if (failureKind === "wrong-origin") {
            return { url: input.url.replace("127.0.0.1", "localhost"), status: 200, contentType: "text/plain", body: "ok\n" };
          }
          return input.url.endsWith("/healthz")
            ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
            : { url: input.url, status: 200, contentType: "application/json", body: "{not-json" };
        },
        ...(failureKind === "timeout" ? {
          httpHealthSetTimeout(callback) { queueMicrotask(callback); return Object.freeze({ timer: "fixture" }); },
          httpHealthClearTimeout() {}
        } : {})
      };
      await assert.rejects(startApiOnlyRuntime(root, options), failureKind === "timeout"
        ? /API_ONLY_(?:GATEWAY|BACKEND)_HEALTH_TIMEOUT/u
        : failureKind === "wrong-origin"
          ? /API_ONLY_(?:GATEWAY|BACKEND)_HEALTH_RESPONSE_INVALID/u
          : /API_ONLY_BACKEND_HEALTH_RESPONSE_INVALID/u);
      assert.deepEqual(requests.sort(), [
        `http://127.0.0.1:${API_ONLY_PORTS.gateway}/api/health`,
        `http://127.0.0.1:${API_ONLY_PORTS.gateway}/healthz`
      ]);
      assert.equal(boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
      await assert.rejects(lstat(join(prepared.root, "status.json")), (caught) => caught?.code === "ENOENT");
      await assert.rejects(lstat(join(prepared.root, "owner.lock")), (caught) => caught?.code === "ENOENT");
    } finally { await cleanup(root); }
  }
});

test("bootstrap status ignores caller image input and atomically commits only pinned runtime, inspected Backend image, network, and Gateway snapshot evidence", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
    const events = [];
    const observedImage = {
      project: prepared.project,
      runtimeNonce: prepared.runtimeNonce,
      networkId: "2".repeat(64),
      networkName: `${prepared.project}_shensi_internal`,
      service: "backend",
      containerId: "e".repeat(64),
      imageIdDigest: `sha256:${"f".repeat(64)}`
    };
    await startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      backendImage: "caller-controlled-image-must-not-win",
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      isPortAvailable: async () => true,
      async requestHttpHealth(input) {
        events.push(input.url.endsWith("/healthz") ? "gateway-health" : "backend-health");
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) };
      },
      async inspectBootstrapBackendImage(input) {
        events.push("backend-image-inspection");
        assert.equal(events.includes("gateway-health"), true);
        assert.equal(events.includes("backend-health"), true);
        assert.deepEqual(input, {
          project: prepared.project,
          runtimeNonce: prepared.runtimeNonce,
          network: { id: "2".repeat(64), name: `${prepared.project}_shensi_internal` },
          service: "backend"
        });
        return observedImage;
      },
      async privateRecordStage(stage, record) {
        if (record.path === join(prepared.root, "status.json") && stage === "before-rename") events.push("status-commit");
      }
    });

    assert.equal(events.indexOf("status-commit") > events.indexOf("backend-image-inspection"), true);
    const text = await readFile(join(prepared.root, "status.json"), "utf8");
    const status = JSON.parse(text);
    assert.equal(text, `${JSON.stringify(status)}\n`);
    assert.deepEqual(status, {
      schema: "shensi.api-only.bootstrap-status",
      version: 1,
      project: prepared.project,
      origin: `http://127.0.0.1:${API_ONLY_PORTS.gateway}`,
      socketIdentity: prepared.composeRuntime.socket.identity,
      daemonIdentity: prepared.composeRuntime.daemon.identity,
      runtimeNonce: prepared.runtimeNonce,
      network: {
        id: "2".repeat(64),
        name: `${prepared.project}_shensi_internal`,
        claimSha256: fixtureSha256(Buffer.from(JSON.stringify({ ...prepared.networkClaim, existingNetwork: { id: "2".repeat(64), name: `${prepared.project}_shensi_internal` } }), "utf8"))
      },
      backend: { containerId: observedImage.containerId, imageIdDigest: observedImage.imageIdDigest },
      gatewaySnapshotSha256: prepared.gatewaySnapshot.sha256,
      createdAt: "2026-09-04T00:00:00.000Z"
    });
    assert.equal(text.includes("caller-controlled-image-must-not-win"), false);
  } finally { await cleanup(root); }
});

test("bootstrap status remains absent when inspected Backend identity drifts after both health proofs", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const boundary = taskOneBoundaryFixture({ promoteAfterMutation: true });
    let imageInspections = 0;
    await assert.rejects(startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      isPortAvailable: async () => true,
      requestHttpHealth: async (input) => input.url.endsWith("/healthz")
        ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
        : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) },
      async inspectBootstrapBackendImage(input) {
        imageInspections += 1;
        return { ...bootstrapBackendObservation(input), networkId: "9".repeat(64) };
      }
    }), /API_ONLY_BOOTSTRAP_BACKEND_IDENTITY_MISMATCH/u);
    assert.equal(imageInspections, 1);
    assert.equal(boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
    await assert.rejects(lstat(join(prepared.root, "status.json")), (caught) => caught?.code === "ENOENT");
  } finally { await cleanup(root); }
});

test("read-only status consumes Task 1 result.output, normalizes a bounded ps array, and probes both fixed health endpoints without writing", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const startedBoundary = await startHealthyBootstrapFixture(root);
    const psRows = [
      { ID: "1".repeat(64), Name: "shensi-api-mysql-1", Command: "entrypoint", Project: prepared.project, Service: "mysql", State: "running", Health: "healthy", ExitCode: 0, Publishers: [] },
      { ID: "2".repeat(64), Name: "shensi-api-backend-1", Command: "node", Project: prepared.project, Service: "backend", State: "running", Health: "healthy", ExitCode: 0, Publishers: [] },
      { ID: "3".repeat(64), Name: "shensi-api-gateway-1", Command: "nginx", Project: prepared.project, Service: "gateway", State: "running", Health: "", ExitCode: 0, Publishers: [] }
    ];
    const statusBoundary = taskOneBoundaryFixture({
      networks: [...builtinInspectionNetworks(), startedBoundary.postNetwork],
      postNetwork: startedBoundary.postNetwork,
      mutationOutput: JSON.stringify(psRows)
    });
    const requests = [];
    const before = await snapshotAuthorityTree(prepared.root);
    let arbitraryHealthCalls = 0;
    const status = await apiOnlyStatus(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: statusBoundary.discovery,
      networkInspectionOptions: statusBoundary.networkInspectionOptions,
      composeMutationOptions: statusBoundary.composeMutationOptions,
      checkHealth: async () => { arbitraryHealthCalls += 1; throw new Error("ARBITRARY_HEALTH_USED"); },
      async requestHttpHealth(input) {
        requests.push(input.url);
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) };
      }
    });

    assert.deepEqual(status, {
      project: prepared.project,
      origin: `http://127.0.0.1:${API_ONLY_PORTS.gateway}`,
      services: [
        { name: "shensi-api-mysql-1", service: "mysql", state: "running", health: "healthy", exitCode: 0 },
        { name: "shensi-api-backend-1", service: "backend", state: "running", health: "healthy", exitCode: 0 },
        { name: "shensi-api-gateway-1", service: "gateway", state: "running", health: "none", exitCode: 0 }
      ],
      healthy: true
    });
    assert.equal(Object.isFrozen(status), true);
    assert.equal(Object.isFrozen(status.services), true);
    assert.equal(status.services.every(Object.isFrozen), true);
    assert.equal(arbitraryHealthCalls, 0);
    assert.deepEqual(requests.sort(), [
      `http://127.0.0.1:${API_ONLY_PORTS.gateway}/api/health`,
      `http://127.0.0.1:${API_ONLY_PORTS.gateway}/healthz`
    ]);
    const invocation = statusBoundary.mutationCalls.find(({ type }) => type === "spawn");
    assert.deepEqual(invocation.args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api", "ps", "--format", "json"
    ]);
    assert.deepEqual(await snapshotAuthorityTree(prepared.root), before);
  } finally { await cleanup(root); }
});

test("read-only status rejects absent state without preparation or writes and rejects malformed or oversized ps output", async () => {
  const missingRoot = await fixture();
  try {
    const before = await snapshotAuthorityTree(join(missingRoot, ".runtime"));
    const effects = [];
    await assert.rejects(apiOnlyStatus(missingRoot, {
      ...preparedOptions(missingRoot),
      isPortAvailable: async () => { effects.push("port"); return true; },
      resolveCompose: async () => { effects.push("compose-model"); return { rootHash: "forbidden" }; },
      requestHttpHealth: async () => { effects.push("health"); throw new Error("forbidden"); }
    }), /API_ONLY_RUNTIME_NOT_PREPARED/u);
    assert.deepEqual(effects, []);
    assert.deepEqual(await snapshotAuthorityTree(join(missingRoot, ".runtime")), before);
  } finally { await cleanup(missingRoot); }

  for (const [label, output] of [
    ["not-array", JSON.stringify({ Service: "mysql" })],
    ["wrong-project", JSON.stringify([{ Name: "foreign", Project: "foreign", Service: "mysql", State: "running", Health: "healthy", ExitCode: 0 }])],
    ["duplicate-service", JSON.stringify([
      { Name: "one", Project: "shensi-api", Service: "mysql", State: "running", Health: "healthy", ExitCode: 0 },
      { Name: "two", Project: "shensi-api", Service: "mysql", State: "running", Health: "healthy", ExitCode: 0 }
    ])],
    ["oversized", JSON.stringify([{ Name: "shensi-api-mysql-1", Project: "shensi-api", Service: "mysql", State: "running", Health: "healthy", ExitCode: 0, Padding: "x".repeat(70_000) }])]
  ]) {
    const root = await fixture();
    try {
      const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
      const startedBoundary = await startHealthyBootstrapFixture(root);
      const boundary = taskOneBoundaryFixture({
        networks: [...builtinInspectionNetworks(), startedBoundary.postNetwork],
        postNetwork: startedBoundary.postNetwork,
        mutationOutput: output
      });
      await assert.rejects(apiOnlyStatus(root, {
        ...preparedOptions(root),
        composeRuntimeDiscoveryOptions: boundary.discovery,
        networkInspectionOptions: boundary.networkInspectionOptions,
        composeMutationOptions: boundary.composeMutationOptions,
        requestHttpHealth: async () => { throw new Error("HEALTH_MUST_NOT_RUN"); }
      }), /API_ONLY_STATUS_OUTPUT_INVALID/u, label);
      assert.equal(boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1, label);
      assert.equal((await lstat(join(prepared.root, "status.json"))).isFile(), true, label);
    } finally { await cleanup(root); }
  }
});

test("read-only status probes both endpoints and reports unhealthy without accepting an arbitrary aggregate health callback", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const startedBoundary = await startHealthyBootstrapFixture(root);
    const row = { Name: "shensi-api-mysql-1", Project: prepared.project, Service: "mysql", State: "running", Health: "healthy", ExitCode: 0 };
    const boundary = taskOneBoundaryFixture({
      networks: [...builtinInspectionNetworks(), startedBoundary.postNetwork],
      postNetwork: startedBoundary.postNetwork,
      mutationOutput: JSON.stringify([row])
    });
    const requests = [];
    const result = await apiOnlyStatus(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      checkHealth: async () => true,
      async requestHttpHealth(input) {
        requests.push(input.url);
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, store: "mysql" }) };
      }
    });
    assert.equal(result.healthy, false);
    assert.equal(requests.length, 2);
  } finally { await cleanup(root); }
});

test("safe stop uses the pinned owner and exact Compose stop, waits for both ports to release, and preserves the runtime tree byte-for-byte", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const boundary = taskOneBoundaryFixture();
    const before = await snapshotAuthorityTree(prepared.root);
    const checks = [];
    const sleeps = [];
    const attempts = new Map([[API_ONLY_PORTS.gateway, 0], [API_ONLY_PORTS.mysql, 0]]);
    await stopApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      portReleaseTimeoutMs: 2_000,
      portReleasePollIntervalMs: 25,
      async isPortAvailable(port) {
        checks.push(port);
        assert.equal((await lstat(join(prepared.root, "owner.lock"))).isFile(), true);
        const count = (attempts.get(port) ?? 0) + 1;
        attempts.set(port, count);
        return count >= 2;
      },
      async portReleaseSleep(milliseconds) { sleeps.push(milliseconds); }
    });
    assert.deepEqual(checks, [API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql, API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql]);
    assert.deepEqual(sleeps, [25]);
    const mutation = boundary.mutationCalls.filter(({ type }) => type === "spawn");
    assert.equal(mutation.length, 1);
    assert.deepEqual(mutation[0].args, [
      "compose", "-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api", "stop"
    ]);
    assert.equal(mutation[0].args.includes("down"), false);
    assert.equal(mutation[0].args.includes("--volumes"), false);
    assert.deepEqual(await snapshotAuthorityTree(prepared.root), before);
  } finally { await cleanup(root); }
});

test("safe stop rejects missing prepared state without writes and times out without deleting retained evidence", async () => {
  const missingRoot = await fixture();
  try {
    const before = await snapshotAuthorityTree(join(missingRoot, ".runtime"));
    const effects = [];
    await assert.rejects(stopApiOnlyRuntime(missingRoot, {
      ...preparedOptions(missingRoot),
      isPortAvailable: async () => { effects.push("port"); return true; },
      resolveCompose: async () => { effects.push("compose-model"); return { rootHash: "forbidden" }; }
    }), /API_ONLY_RUNTIME_NOT_PREPARED/u);
    assert.deepEqual(effects, []);
    assert.deepEqual(await snapshotAuthorityTree(join(missingRoot, ".runtime")), before);
  } finally { await cleanup(missingRoot); }

  const timeoutRoot = await fixture();
  try {
    const prepared = await prepareApiOnlyRuntime(timeoutRoot, preparedOptions(timeoutRoot));
    await writeFile(join(prepared.evidenceDirectory, "retained-proof.json"), "retained-evidence\n", { mode: 0o600 });
    const boundary = taskOneBoundaryFixture();
    const before = await snapshotAuthorityTree(prepared.root);
    let now = 0;
    const checks = [];
    await assert.rejects(stopApiOnlyRuntime(timeoutRoot, {
      ...preparedOptions(timeoutRoot),
      composeRuntimeDiscoveryOptions: boundary.discovery,
      networkInspectionOptions: boundary.networkInspectionOptions,
      composeMutationOptions: boundary.composeMutationOptions,
      isPortAvailable: async (port) => { checks.push(port); return false; },
      portReleaseTimeoutMs: 100,
      portReleasePollIntervalMs: 50,
      portReleaseMonotonicNow: () => now,
      portReleaseSleep: async (milliseconds) => { now += milliseconds; }
    }), /API_ONLY_PORT_RELEASE_TIMEOUT/u);
    assert.deepEqual(checks, [
      API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql,
      API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql,
      API_ONLY_PORTS.gateway, API_ONLY_PORTS.mysql
    ]);
    assert.equal(boundary.mutationCalls.filter(({ type }) => type === "spawn").length, 1);
    assert.deepEqual(await snapshotAuthorityTree(prepared.root), before);
  } finally { await cleanup(timeoutRoot); }
});

test("runtime root, project, ports, and private Trial files fail closed before Compose", async () => {
  // Catches an implementation that invokes Compose after an unsafe input was
  // accepted, which would make hostile paths or a live port actionable.
  const root = await fixture(); const calls = [];
  try {
    await assert.rejects(prepareApiOnlyRuntime(root, { ...preparedOptions(root, calls), runtimeRoot: ".runtime/api-only" }), /API_ONLY_RUNTIME_ROOT_MUST_BE_ABSOLUTE/u);
    await assert.rejects(prepareApiOnlyRuntime(root, { ...preparedOptions(root, calls), project: "not-shensi" }), /API_ONLY_PROJECT_INVALID/u);
    await assert.rejects(prepareApiOnlyRuntime(root, { ...preparedOptions(root, calls), isPortAvailable: async (port) => port !== API_ONLY_PORTS.gateway }), /API_ONLY_PORT_OCCUPIED:5608/u);
    const target = join(root, "outside");
    const canonicalRuntime = join(root, ".runtime", "api-only");
    await mkdir(target);
    await rm(canonicalRuntime, { recursive: true, force: true });
    await symlink(target, canonicalRuntime);
    await assert.rejects(prepareApiOnlyRuntime(root, preparedOptions(root, calls)), /API_ONLY_RUNTIME_ROOT_INVALID/u);
    await rm(canonicalRuntime, { force: true });
    await chmod(join(root, ".runtime", "real-trial", "secrets", "jwt_secret"), 0o640);
    await assert.rejects(prepareApiOnlyRuntime(root, preparedOptions(root, calls)), /API_ONLY_SECRET_FILE_MUST_BE_OWNER_ONLY/u);
    assert.equal(calls.length, 0);
  } finally { await cleanup(root); }
});

test("repository and retained runtime roots reject aliases, escape, ownership, and replacement before effects", async () => {
  const makeGuarded = (root, effects, overrides = {}) => ({
    ...preparedOptions(root),
    isPortAvailable: async () => { effects.push("port"); return true; },
    discoverRuntime: async () => { effects.push("discovery"); return fakeRuntime(); },
    resolveCompose: async () => { effects.push("source"); return { rootHash: "source" }; },
    runCompose: async () => { effects.push("compose"); return { stdout: "" }; },
    ...overrides
  });

  const relativeFixture = await fixture();
  try {
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime("relative/repository", makeGuarded(relativeFixture, effects, {
        disposable: true,
        project: "shensi-api-empty-0123456789ab",
        runtimeRoot: join(relativeFixture, ".runtime", "api-only-empty")
      })),
      /API_ONLY_REPOSITORY_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally { await cleanup(relativeFixture); }

  const aliasFixture = await fixture();
  const alias = `${aliasFixture}-alias`;
  try {
    await symlink(aliasFixture, alias);
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime(alias, makeGuarded(aliasFixture, effects)),
      /API_ONLY_REPOSITORY_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally {
    await rm(alias, { force: true });
    await cleanup(aliasFixture);
  }

  const foreignFixture = await fixture();
  const foreignRoot = await realpath(await mkdtemp(join(tmpdir(), "shensi-api-only-foreign-")));
  try {
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime(foreignFixture, makeGuarded(foreignFixture, effects, {
        runtimeRoot: join(foreignRoot, "api-only")
      })),
      /API_ONLY_RUNTIME_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally {
    await rm(foreignRoot, { recursive: true, force: true });
    await cleanup(foreignFixture);
  }

  const ancestorFixture = await fixture();
  try {
    const target = join(ancestorFixture, "real-runtime-parent");
    const linked = join(ancestorFixture, "linked-runtime-parent");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime(ancestorFixture, makeGuarded(ancestorFixture, effects, {
        runtimeRoot: join(linked, "api-only")
      })),
      /API_ONLY_RUNTIME_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally { await cleanup(ancestorFixture); }

  const modeFixture = await fixture();
  try {
    await chmod(modeFixture, 0o775);
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime(modeFixture, makeGuarded(modeFixture, effects)),
      /API_ONLY_REPOSITORY_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally {
    await chmod(modeFixture, 0o700);
    await cleanup(modeFixture);
  }

  const ownerFixture = await fixture();
  try {
    const effects = [];
    await assert.rejects(
      prepareApiOnlyRuntime(ownerFixture, makeGuarded(ownerFixture, effects, {
        getuid: () => (process.getuid?.() ?? 0) + 1
      })),
      /API_ONLY_REPOSITORY_ROOT_INVALID/u
    );
    assert.deepEqual(effects, []);
  } finally { await cleanup(ownerFixture); }

  const replacementFixture = await fixture();
  try {
    const runtimeRoot = join(replacementFixture, ".runtime", "api-only");
    const displaced = join(replacementFixture, ".runtime", "api-only-displaced");
    const effects = [];
    let replaced = false;
    await assert.rejects(
      prepareApiOnlyRuntime(replacementFixture, makeGuarded(replacementFixture, effects, {
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          if (!replaced && path === runtimeRoot) {
            replaced = true;
            await rename(runtimeRoot, displaced);
            await mkdir(runtimeRoot, { mode: 0o700 });
          }
          return handle;
        }
      })),
      /API_ONLY_RUNTIME_ROOT_INVALID/u
    );
    assert.equal(replaced, true);
    assert.deepEqual(effects, []);
  } finally { await cleanup(replacementFixture); }
});

test("private JSON create and replacement are canonical, inode-bound, and durable across crash points", async () => {
  const root = await fixture();
  const calls = [];
  const base = preparedOptions(root, calls);
  let runtime;
  try {
    runtime = await prepareApiOnlyRuntime(root, base);
    const statusPath = join(runtime.root, "status.json");
    const isStatusTemporary = (path) => String(path).startsWith(join(runtime.root, ".status.json.")) && String(path).endsWith(".tmp");
    const readStatus = async () => {
      const text = await readFile(statusPath, "utf8");
      const value = JSON.parse(text);
      assert.equal(text, `${JSON.stringify(value)}\n`);
      return value;
    };
    const expectedImageDigest = (label) => `sha256:${fixtureSha256(Buffer.from(label, "utf8"))}`;
    const temporaryNames = async () => (await readdir(runtime.root)).filter((name) => /^\.status\.json\..+\.tmp$/u.test(name));
    let networkExists = false;
    const atomicOptions = (backendImage, events, failure = null) => {
      const seedBoundary = taskOneBoundaryFixture();
      const boundary = taskOneBoundaryFixture({
        networks: networkExists ? [...builtinInspectionNetworks(), seedBoundary.postNetwork] : builtinInspectionNetworks(),
        promoteAfterMutation: !networkExists,
        postNetwork: seedBoundary.postNetwork
      });
      return {
        ...preparedOptions(root, calls),
        backendImage,
        composeRuntimeDiscoveryOptions: boundary.discovery,
        networkInspectionOptions: boundary.networkInspectionOptions,
        composeMutationOptions: {
          ...boundary.composeMutationOptions,
          spawn(command, args, input) {
            calls.push({ args: args.slice(1), input: { environment: input.env }, command });
            networkExists = true;
            return boundary.composeMutationOptions.spawn(command, args, input);
          }
        },
        requestHttpHealth: async (input) => input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) },
        inspectBootstrapBackendImage: async (input) => ({
          ...bootstrapBackendObservation(input),
          imageIdDigest: `sha256:${fixtureSha256(Buffer.from(backendImage, "utf8"))}`
        }),
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        return {
          chmod: (...args) => handle.chmod(...args),
          close: (...args) => handle.close(...args),
          readFile: (...args) => handle.readFile(...args),
          stat: (...args) => handle.stat(...args),
          async sync(...args) {
            if (isStatusTemporary(path)) {
              events.push("file-sync");
              if (failure === "file-sync") throw new Error("PRIVATE_RECORD_FILE_SYNC_CRASH");
            } else if (path === runtime.root && events.includes("after-rename")) {
              events.push("directory-sync");
              if (failure === "directory-sync") throw new Error("PRIVATE_RECORD_DIRECTORY_SYNC_CRASH");
            }
            return handle.sync(...args);
          },
          async writeFile(...args) {
            if (isStatusTemporary(path) && failure === "write") throw new Error("PRIVATE_RECORD_WRITE_CRASH");
            return handle.writeFile(...args);
          }
        };
      },
      async rename(from, to) {
        if (isStatusTemporary(from) && to === statusPath) {
          events.push("rename");
          if (failure === "rename") throw new Error("PRIVATE_RECORD_RENAME_CRASH");
        }
        return rename(from, to);
      },
      async privateRecordStage(stage, record) {
        if (record.path !== statusPath) return;
        events.push(stage);
        if (failure === "target-replacement" && stage === "before-rename") {
          await rename(statusPath, `${statusPath}.displaced`);
          await writeFile(statusPath, '{"intruder":true}\n', { mode: 0o600 });
        }
        if (failure === stage) throw new Error(`PRIVATE_RECORD_${stage.toUpperCase().replaceAll("-", "_")}_CRASH`);
      }
      };
    };

    const createEvents = [];
    await startApiOnlyRuntime(root, atomicOptions("image-one", createEvents));
    assert.deepEqual(createEvents, ["file-sync", "after-file-sync", "before-rename", "rename", "after-rename", "directory-sync", "after-directory-sync"]);
    assert.equal((await readStatus()).backend.imageIdDigest, expectedImageDigest("image-one"));
    const created = await lstat(statusPath);
    assert.equal(created.mode & 0o777, 0o600);
    assert.equal(created.nlink, 1);
    assert.deepEqual(await temporaryNames(), []);

    const replaceEvents = [];
    await startApiOnlyRuntime(root, atomicOptions("image-two", replaceEvents));
    const replaced = await lstat(statusPath);
    assert.notEqual(`${created.dev}:${created.ino}`, `${replaced.dev}:${replaced.ino}`);
    assert.equal((await readStatus()).backend.imageIdDigest, expectedImageDigest("image-two"));
    assert.deepEqual(await temporaryNames(), []);

    for (const failure of ["write", "file-sync", "before-rename", "rename"]) {
      const events = [];
      await assert.rejects(startApiOnlyRuntime(root, atomicOptions(`image-${failure}`, events, failure)), new RegExp(`PRIVATE_RECORD_${failure.toUpperCase().replaceAll("-", "_")}_CRASH`, "u"));
      assert.equal((await readStatus()).backend.imageIdDigest, expectedImageDigest("image-two"), failure);
      assert.deepEqual(await temporaryNames(), [], failure);
    }

    await assert.rejects(startApiOnlyRuntime(root, atomicOptions("image-target-replacement", [], "target-replacement")), /API_ONLY_PRIVATE_JSON_INVALID/u);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), { intruder: true });
    assert.deepEqual(await temporaryNames(), []);
    await rm(statusPath);
    await rename(`${statusPath}.displaced`, statusPath);
    assert.equal((await readStatus()).backend.imageIdDigest, expectedImageDigest("image-two"));

    for (const failure of ["after-rename", "directory-sync"]) {
      const events = [];
      await assert.rejects(startApiOnlyRuntime(root, atomicOptions(`image-${failure}`, events, failure)), new RegExp(`PRIVATE_RECORD_${failure.toUpperCase().replaceAll("-", "_")}_CRASH`, "u"));
      assert.equal((await readStatus()).backend.imageIdDigest, expectedImageDigest(`image-${failure}`), failure);
      assert.deepEqual(await temporaryNames(), [], failure);
    }
  } finally { await cleanup(root); }
});

test("all preserved and smoke secrets copy byte-for-byte and reject unsafe source or destination identities", async () => {
  const root = await fixture();
  try {
    const options = preparedOptions(root);
    const runtime = await prepareApiOnlyRuntime(root, options);
    for (const sourceName of Object.values(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
      const source = join(root, ".runtime", "real-trial", "secrets", sourceName);
      const destination = join(runtime.secretsDirectory, sourceName);
      assert.deepEqual(await readFile(destination), await readFile(source), sourceName);
      const info = await lstat(destination);
      assert.equal(info.mode & 0o777, 0o600, sourceName);
      assert.equal(info.nlink, 1, sourceName);
    }
    const smokeSource = join(root, ".runtime", "real-trial", "secrets", "trial_app_password");
    const smokeDestination = join(runtime.secretsDirectory, "smoke_login_password");
    assert.deepEqual(await readFile(smokeDestination), await readFile(smokeSource));
    assert.equal((await lstat(smokeDestination)).nlink, 1);
    assert.equal((await readFile(runtime.environmentFile, "utf8")).includes(await readFile(smokeSource, "utf8")), false);

    await prepareApiOnlyRuntime(root, options);
    for (const sourceName of Object.values(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
      assert.deepEqual(
        await readFile(join(runtime.secretsDirectory, sourceName)),
        await readFile(join(root, ".runtime", "real-trial", "secrets", sourceName))
      );
    }

    const hardLinkedDestination = join(runtime.secretsDirectory, "jwt_secret");
    await link(hardLinkedDestination, join(runtime.secretsDirectory, "jwt_secret.alias"));
    await assert.rejects(prepareApiOnlyRuntime(root, options), /API_ONLY_PRIVATE_FILE_INVALID/u);
  } finally { await cleanup(root); }

  const ancestorRoot = await fixture();
  try {
    const trial = join(ancestorRoot, ".runtime", "real-trial");
    const actual = join(ancestorRoot, ".runtime", "real-trial-actual");
    await rename(trial, actual);
    await symlink(actual, trial);
    await assert.rejects(prepareApiOnlyRuntime(ancestorRoot, preparedOptions(ancestorRoot)), /API_ONLY_SECRET_FILE_INVALID/u);
  } finally { await cleanup(ancestorRoot); }

  const hardLinkRoot = await fixture();
  try {
    const source = join(hardLinkRoot, ".runtime", "real-trial", "secrets", "jwt_secret");
    await link(source, join(hardLinkRoot, ".runtime", "real-trial", "secrets", "jwt_secret.alias"));
    await assert.rejects(prepareApiOnlyRuntime(hardLinkRoot, preparedOptions(hardLinkRoot)), /API_ONLY_SECRET_FILE_INVALID/u);
  } finally { await cleanup(hardLinkRoot); }

  const replacementRoot = await fixture();
  try {
    const source = join(replacementRoot, ".runtime", "real-trial", "secrets", "jwt_secret");
    const displaced = `${source}.displaced`;
    let replaced = false;
    await assert.rejects(prepareApiOnlyRuntime(replacementRoot, {
      ...preparedOptions(replacementRoot),
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        if (!replaced && path === source) {
          replaced = true;
          const bytes = await handle.readFile();
          await rename(source, displaced);
          await writeFile(source, bytes, { mode: 0o600 });
        }
        return handle;
      }
    }), /API_ONLY_SECRET_FILE_INVALID/u);
    assert.equal(replaced, true);
  } finally { await cleanup(replacementRoot); }
});

test("five generated credentials use distinct 48-byte base64url values and retries never rotate them", async () => {
  const names = ["mysql_app_password", "mysql_root_password", "bootstrap_admin_password", "migration_reader_password", "migration_backup_passphrase"];
  const root = await fixture();
  const requested = [];
  let sequence = 0;
  const options = {
    ...preparedOptions(root),
    randomBytes(size) {
      requested.push(size);
      sequence += 1;
      return Buffer.alloc(size, sequence);
    }
  };
  try {
    const runtime = await prepareApiOnlyRuntime(root, options);
    assert.equal(requested.filter((size) => size === 48).length, names.length);
    const first = {};
    for (const name of names) {
      const value = await readFile(join(runtime.secretsDirectory, name), "utf8");
      assert.match(value, /^[A-Za-z0-9_-]{64}$/u, name);
      assert.equal(Buffer.from(value, "base64url").length, 48, name);
      assert.equal(Buffer.from(value, "base64url").toString("base64url"), value, name);
      first[name] = value;
    }
    assert.equal(new Set(Object.values(first)).size, names.length);

    requested.length = 0;
    await prepareApiOnlyRuntime(root, options);
    assert.equal(requested.includes(48), false);
    for (const name of names) assert.equal(await readFile(join(runtime.secretsDirectory, name), "utf8"), first[name]);
  } finally { await cleanup(root); }

  const shortRoot = await fixture();
  try {
    await assert.rejects(prepareApiOnlyRuntime(shortRoot, {
      ...preparedOptions(shortRoot),
      randomBytes: (size) => Buffer.alloc(size === 48 ? 47 : size, 1)
    }), /API_ONLY_GENERATED_SECRET_INVALID/u);
  } finally { await cleanup(shortRoot); }

  const malformedRoot = await fixture();
  try {
    let malformedSequence = 6;
    const runtime = await prepareApiOnlyRuntime(malformedRoot, {
      ...preparedOptions(malformedRoot),
      randomBytes: (size) => Buffer.alloc(size, malformedSequence += 1)
    });
    await writeFile(join(runtime.secretsDirectory, "mysql_app_password"), "not-base64url", { mode: 0o600 });
    await assert.rejects(prepareApiOnlyRuntime(malformedRoot, preparedOptions(malformedRoot)), /API_ONLY_GENERATED_SECRET_INVALID/u);
  } finally { await cleanup(malformedRoot); }

  const duplicateRoot = await fixture();
  try {
    const runtime = await prepareApiOnlyRuntime(duplicateRoot, {
      ...preparedOptions(duplicateRoot),
      randomBytes: (() => {
        let value = 20;
        return (size) => Buffer.alloc(size, value += 1);
      })()
    });
    const duplicate = await readFile(join(runtime.secretsDirectory, "mysql_app_password"));
    await writeFile(join(runtime.secretsDirectory, "mysql_root_password"), duplicate, { mode: 0o600 });
    await assert.rejects(prepareApiOnlyRuntime(duplicateRoot, preparedOptions(duplicateRoot)), /API_ONLY_GENERATED_SECRET_INVALID/u);
  } finally { await cleanup(duplicateRoot); }
});

test("backend environment has one closed key set and rejects newline or binary value injection", async () => {
  const root = await fixture();
  try {
    const runtime = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const text = await readFile(runtime.environmentFile, "utf8");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.slice(0, -1).includes("\n\n"), false);
    const entries = text.trimEnd().split("\n").map((line) => {
      const separator = line.indexOf("=");
      assert.equal(separator > 0, true, line);
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
    const environment = Object.fromEntries(entries);
    const expectedNames = [
      "DATABASE_URL", "CRM_STORE", "CRM_SEED_DEVELOPMENT_DATA", "NODE_ENV", "BACKEND_HOST", "PORT",
      "TRUSTED_PROXY_CIDRS", "CORS_ORIGINS", "SESSION_COOKIE_SECURE", "DOUYIN_OUTREACH_ACTIONS_ENABLED",
      "DOUYIN_OUTREACH_APPROVALS_ENABLED", "DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED",
      "DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED", "SHENSI_DESKTOP_CLIENT_ADMISSION_MODE",
      "INITIAL_ADMIN_EMAIL", "INITIAL_ADMIN_PASSWORD", ...Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS)
    ].sort();
    assert.deepEqual(Object.keys(environment).sort(), expectedNames);
    assert.equal(new Set(entries.map(([name]) => name)).size, entries.length);
    assert.equal(environment.CRM_STORE, "mysql");
    assert.equal(environment.CRM_SEED_DEVELOPMENT_DATA, "false");
    assert.equal(environment.NODE_ENV, "production");
    assert.equal(environment.BACKEND_HOST, "0.0.0.0");
    assert.equal(environment.PORT, "4188");
    assert.equal(environment.TRUSTED_PROXY_CIDRS, "198.18.250.254/32");
    assert.equal(environment.CORS_ORIGINS, "http://127.0.0.1:5608");
    assert.equal(environment.SESSION_COOKIE_SECURE, "true");
    assert.equal(environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
    assert.equal(environment.DOUYIN_OUTREACH_APPROVALS_ENABLED, "true");
    assert.equal(environment.DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED, "false");
    assert.equal(environment.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, "false");
    assert.equal(environment.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, "migration_locked");
    assert.equal(environment.INITIAL_ADMIN_EMAIL, "migration-bootstrap@shensi.local");
    const mysqlPassword = await readFile(join(runtime.secretsDirectory, "mysql_app_password"), "utf8");
    assert.equal(environment.DATABASE_URL, `mysql://shensi_app:${encodeURIComponent(mysqlPassword)}@mysql:3306/shensi`);
    assert.equal(environment.INITIAL_ADMIN_PASSWORD, await readFile(join(runtime.secretsDirectory, "bootstrap_admin_password"), "utf8"));
    for (const [name, sourceName] of Object.entries(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
      assert.equal(environment[name], await readFile(join(root, ".runtime", "real-trial", "secrets", sourceName), "utf8", name));
    }
    assert.equal(Object.keys(environment).some((name) => name.startsWith("MEDIACRAWLER_")), false);
    assert.equal(Object.hasOwn(environment, "SHENSI_DESKTOP_CLIENT_ADMITTED_BUILD_MANIFEST_SHA256"), false);
    assert.equal(text.includes(await readFile(join(runtime.secretsDirectory, "smoke_login_password"), "utf8")), false);
  } finally { await cleanup(root); }

  for (const [label, bytes] of [
    ["newline", Buffer.from("valid-prefix\nINJECTED_KEY=yes", "utf8")],
    ["binary", Buffer.from([0xff, 0xfe, 0xfd, 0x00])]
  ]) {
    const invalidRoot = await fixture();
    const effects = [];
    try {
      await writeFile(join(invalidRoot, ".runtime", "real-trial", "secrets", "jwt_secret"), bytes, { mode: 0o600 });
      await assert.rejects(prepareApiOnlyRuntime(invalidRoot, {
        ...preparedOptions(invalidRoot),
        discoverRuntime: async () => { effects.push("discovery"); return fakeRuntime(); },
        resolveCompose: async () => { effects.push("source"); return { rootHash: "source" }; }
      }), /API_ONLY_BACKEND_ENV_VALUE_INVALID/u, label);
      await assert.rejects(lstat(join(invalidRoot, ".runtime", "api-only", "backend.env")), (caught) => caught?.code === "ENOENT");
      assert.deepEqual(effects, [], label);
    } finally { await cleanup(invalidRoot); }
  }
});

test("Gateway snapshot is confined, identity-stable, and rejected on unsafe source or restart record", async () => {
  const expectUnsafeSource = async (mutate, override = {}) => {
    const root = await fixture();
    try {
      await mutate(root);
      await assert.rejects(prepareApiOnlyRuntime(root, { ...preparedOptions(root), ...override }), /API_ONLY_GATEWAY_(?:SOURCE|SNAPSHOT)_INVALID/u);
    } finally { await cleanup(root); }
  };

  await expectUnsafeSource(async (root) => {
    await chmod(join(root, "deploy", "nginx", "api-only.conf"), 0o666);
  });
  await expectUnsafeSource(async (root) => {
    const source = join(root, "deploy", "nginx", "api-only.conf");
    await link(source, `${source}.alias`);
  });
  await expectUnsafeSource(async (root) => {
    const nginx = join(root, "deploy", "nginx");
    const actual = join(root, "deploy", "nginx-actual");
    await rename(nginx, actual);
    await symlink(actual, nginx);
  });

  const replacementRoot = await fixture();
  try {
    const source = join(replacementRoot, "deploy", "nginx", "api-only.conf");
    let replaced = false;
    await assert.rejects(prepareApiOnlyRuntime(replacementRoot, {
      ...preparedOptions(replacementRoot),
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        if (!replaced && path === source) {
          replaced = true;
          const bytes = await handle.readFile();
          await rename(source, `${source}.displaced`);
          await writeFile(source, bytes, { mode: 0o644 });
        }
        return handle;
      }
    }), /API_ONLY_GATEWAY_SOURCE_INVALID/u);
    assert.equal(replaced, true);
  } finally { await cleanup(replacementRoot); }

  const expectUnsafeRestart = async (mutate) => {
    const root = await fixture();
    const effects = [];
    try {
      const runtime = await prepareApiOnlyRuntime(root, preparedOptions(root));
      const recordPath = join(runtime.root, "active-project.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      await mutate({ root, runtime, record, recordPath });
      await assert.rejects(startApiOnlyRuntime(root, {
        ...preparedOptions(root),
        discoverRuntime: async () => { effects.push("discovery"); return fakeRuntime(); },
        runCompose: async () => { effects.push("compose"); return { stdout: "" }; }
      }), /API_ONLY_GATEWAY_SNAPSHOT_INVALID/u);
      assert.deepEqual(effects, []);
    } finally { await cleanup(root); }
  };

  await expectUnsafeRestart(async ({ root, runtime, record, recordPath }) => {
    const escaped = join(root, "escaped-gateway.conf");
    await writeFile(escaped, await readFile(runtime.gatewaySnapshot.path), { mode: 0o600 });
    record.gatewaySnapshot.path = escaped;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  await expectUnsafeRestart(async ({ runtime, record, recordPath }) => {
    const renamed = join(runtime.root, "snapshots", `${"0".repeat(64)}.conf`);
    await rename(runtime.gatewaySnapshot.path, renamed);
    record.gatewaySnapshot.path = renamed;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  await expectUnsafeRestart(async ({ runtime }) => {
    await link(runtime.gatewaySnapshot.path, `${runtime.gatewaySnapshot.path}.alias`);
  });
  await expectUnsafeRestart(async ({ runtime }) => {
    const snapshots = join(runtime.root, "snapshots");
    const actual = join(runtime.root, "snapshots-actual");
    await rename(snapshots, actual);
    await symlink(actual, snapshots);
  });
  await expectUnsafeRestart(async ({ runtime }) => {
    await rm(runtime.gatewaySnapshot.path);
  });
  await expectUnsafeRestart(async ({ runtime }) => {
    await writeFile(runtime.gatewaySnapshot.path, "tampered\n", { mode: 0o600 });
  });
});

test("prepare creates owner-only secrets and an immutable Gateway snapshot that survives source drift", async () => {
  // Catches a mutable bind mount or permissive secret/runtime modes.
  const root = await fixture(); const secret = "fixture-jwt-secret";
  await writeFile(join(root, ".runtime", "real-trial", "secrets", "jwt_secret"), secret, { mode: 0o600 });
  const output = []; const options = preparedOptions(root);
  options.emit = (value) => output.push(value);
  try {
    const runtime = await prepareApiOnlyRuntime(root, options);
    assert.equal((await lstat(runtime.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(runtime.secretsDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(runtime.environmentFile)).mode & 0o777, 0o600);
    assert.equal((await lstat(runtime.gatewaySnapshot.path)).isSymbolicLink(), false);
    assert.match(runtime.gatewaySnapshot.path, new RegExp(`^${runtime.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/snapshots/[a-f0-9]{64}\\.conf$`, "u"));
    const before = await readFile(runtime.gatewaySnapshot.path, "utf8");
    await writeFile(join(root, "deploy", "nginx", "api-only.conf"), "MUTATED SOURCE\n");
    assert.equal(await readFile(runtime.gatewaySnapshot.path, "utf8"), before);
    assert.equal(output.join("\n").includes(secret), false);
  } finally { await cleanup(root); }
});

test("Compose invocation uses the resolved prefix, exact model/project, absolute private paths, and selected ports", async () => {
  // Catches a compose command that silently falls back to a global CLI or
  // mutable/relative secret configuration.
  const root = await fixture();
  try {
    const runtime = await prepareApiOnlyRuntime(root, preparedOptions(root));
    const invocation = apiOnlyComposeInvocation(runtime, ["ps", "--format", "json"]);
    assert.deepEqual(invocation.argvPrefix, ["/safe/docker", "compose"]);
    assert.deepEqual(invocation.args.slice(0, 4), ["-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api"]);
    assert.equal(invocation.environment.SHENSI_API_HTTP_PORT, "5608");
    assert.equal(invocation.environment.SHENSI_API_MYSQL_HOST_PORT, "3311");
    for (const value of [invocation.environment.SHENSI_API_RUNTIME_ROOT, invocation.environment.SHENSI_API_BACKEND_ENV_FILE, invocation.environment.SHENSI_API_GATEWAY_CONFIG_FILE, invocation.environment.SHENSI_API_MYSQL_APP_PASSWORD_FILE]) assert.equal(value.startsWith("/"), true);
    const standalone = apiOnlyComposeInvocation({ ...runtime, composeRuntime: { ...fakeRuntime(), argvPrefix: ["/safe/docker-compose"], compose: { kind: "standalone", version: "1.fixture" } } }, ["ps"]);
    assert.deepEqual(standalone.argvPrefix, ["/safe/docker-compose"]);
  } finally { await cleanup(root); }
});

test("accepted authority precedes bootstrap defaults and performs no B2-only mutation", async () => {
  const root = await fixture();
  const setupCalls = [];
  try {
    await prepareApiOnlyRuntime(root, preparedOptions(root, setupCalls));
    const accepted = await materializeAcceptedAuthority(root);
    await writeFile(join(root, "deploy", "nginx", "api-only.conf"), "DRIFTED CURRENT SOURCE\n");
    const effects = { port: 0, discovery: 0, compose: 0, source: 0 };
    const guarded = {
      ...preparedOptions(root),
      project: "shensi-api",
      isPortAvailable: async () => { effects.port += 1; return true; },
      discoverRuntime: async () => { effects.discovery += 1; throw new Error("CURRENT_RUNTIME_CONSULTED"); },
      resolveCompose: async () => { effects.source += 1; throw new Error("CURRENT_SOURCE_CONSULTED"); },
      runCompose: async () => { effects.compose += 1; throw new Error("COMPOSE_INVOKED"); }
    };
    const startFailure = await startApiOnlyRuntime(root, guarded).then(() => null, (caught) => caught);
    assert.match(startFailure?.message ?? "", /^API_ONLY_/u);
    assert.doesNotMatch(startFailure?.message ?? "", /ACTIVE_PROJECT|CURRENT_|COMPOSE_INVOKED/u);
    assert.deepEqual(effects, { port: 0, discovery: 0, compose: 0, source: 0 });

    const prepareFailure = await prepareApiOnlyRuntime(root, guarded).then(() => null, (caught) => caught);
    assert.match(prepareFailure?.message ?? "", /^API_ONLY_/u);
    assert.deepEqual(effects, { port: 0, discovery: 0, compose: 0, source: 0 });
    assert.equal(accepted.project, "shensi-api-migration-0123456789ab");
  } finally { await cleanup(root); }

  const lockedRoot = await fixture();
  const lockOptions = preparedOptions(lockedRoot);
  let lock;
  try {
    await mkdir(join(lockedRoot, ".runtime", "api-only"), { recursive: true, mode: 0o700 });
    await chmod(join(lockedRoot, ".runtime", "api-only"), 0o700);
    await writeFile(join(lockedRoot, ".runtime", "api-only", "migration-state.json"), "not-json\n", { mode: 0o600 });
    lock = await acquireApiOnlyOwnerLock(lockedRoot, lockOptions);
    await assert.rejects(startApiOnlyRuntime(lockedRoot, {
      ...lockOptions,
      isProcessCurrent: async () => true,
      discoverRuntime: async () => { throw new Error("DISCOVERY_MUST_NOT_RUN"); },
      runCompose: async () => { throw new Error("COMPOSE_MUST_NOT_RUN"); }
    }), /API_ONLY_OWNER_LOCK_HELD/u);
  } finally {
    if (lock) await releaseApiOnlyOwnerLock(lock, lockOptions);
    await cleanup(lockedRoot);
  }

  const unsafeModeRoot = await fixture();
  try {
    const accepted = await materializeAcceptedAuthority(unsafeModeRoot);
    await chmod(accepted.runtimeRoot, 0o755);
    const before = await snapshotAuthorityTree(accepted.runtimeRoot);
    const failure = await startApiOnlyRuntime(unsafeModeRoot, preparedOptions(unsafeModeRoot)).then(() => null, (caught) => caught);
    assert.match(failure?.message ?? "", /^API_ONLY_/u);
    assert.deepEqual(await snapshotAuthorityTree(accepted.runtimeRoot), before);
    assert.equal((await lstat(accepted.runtimeRoot)).mode & 0o777, 0o755);
  } finally { await cleanup(unsafeModeRoot); }
});

test("accepted database lifecycle uses only fresh B2 R C evidence and never consults bootstrap or current source", async () => {
  const root = await fixture();
  try {
    const discovery = composeRuntimeDiscoveryFixture();
    const selected = await discoverComposeRuntime(discovery);
    const accepted = await materializeAcceptedAuthority(root, {
      engine: { socketIdentity: selected.socket.identity, daemonIdentity: selected.daemon.identity }
    });
    const pre = acceptedSnapshot(accepted, (resources) => {
      resources.mysql.State = acceptedContainerState("created");
    });
    const ready = acceptedSnapshot(accepted);
    const engine = acceptedEngineSequenceFixture(accepted, [pre, pre, ready, ready, ready, ready]);
    const lifecycle = acceptedLifecycleOptionsFixture(discovery, selected, engine);
    const forbidden = { bootstrap: 0, source: 0, arbitraryCompose: 0, port: 0 };
    const result = await startApiOnlyDatabase(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: discovery,
      acceptedLifecycleOptions: lifecycle.options,
      discoverRuntime: async () => { forbidden.bootstrap += 1; throw new Error("BOOTSTRAP_RUNTIME_FORBIDDEN"); },
      resolveCompose: async () => { forbidden.source += 1; throw new Error("CURRENT_SOURCE_FORBIDDEN"); },
      runCompose: async () => { forbidden.arbitraryCompose += 1; throw new Error("ARBITRARY_COMPOSE_FORBIDDEN"); },
      isPortAvailable: async () => { forbidden.port += 1; throw new Error("BOOTSTRAP_PORT_CHECK_FORBIDDEN"); }
    });
    assert.deepEqual(forbidden, { bootstrap: 0, source: 0, arbitraryCompose: 0, port: 0 });
    assert.equal(result.operation, "start-mysql");
    assert.equal(["applied", "already_satisfied", "reconciled_target"].includes(result.outcome), true);
    const spawns = lifecycle.calls.map(({ args }) => args.slice(selected.argvPrefix.length - 1));
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[0].slice(-2), ["config", "--quiet"]);
    assert.deepEqual(spawns[1].slice(-2), ["start", "mysql"]);
    assert.equal(lifecycle.calls.some(({ args }) => args.includes("--build") || args.includes("deploy/compose.api-only.yaml")), false);
  } finally { await cleanup(root); }
});

test("accepted runtime lifecycle sequences database then no-build runtime start and proves final health from fresh evidence", async () => {
  const root = await fixture();
  try {
    const discovery = composeRuntimeDiscoveryFixture();
    const selected = await discoverComposeRuntime(discovery);
    const accepted = await materializeAcceptedAuthority(root, {
      engine: { socketIdentity: selected.socket.identity, daemonIdentity: selected.daemon.identity }
    });
    const databaseStopped = acceptedSnapshot(accepted, (resources) => {
      resources.mysql.State = acceptedContainerState("created");
      resources.backend.State = acceptedContainerState("exited", { health: "unhealthy" });
      resources.gateway.State = acceptedContainerState("exited");
    });
    const databaseReady = acceptedSnapshot(accepted, (resources) => {
      resources.backend.State = acceptedContainerState("exited", { health: "unhealthy" });
      resources.gateway.State = acceptedContainerState("exited");
    });
    const allReady = acceptedSnapshot(accepted);
    const engine = acceptedEngineSequenceFixture(accepted, [
      databaseStopped, databaseStopped, databaseReady, databaseReady,
      databaseReady, databaseReady, allReady, allReady, allReady
    ]);
    const lifecycle = acceptedLifecycleOptionsFixture(discovery, selected, engine);
    const healthCalls = [];
    const result = await startApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: discovery,
      acceptedLifecycleOptions: lifecycle.options,
      requestHttpHealth: async (input) => {
        healthCalls.push(input.url);
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) };
      }
    });
    assert.equal(result.operation, "start-runtime");
    assert.deepEqual(healthCalls.sort(), [
      "http://127.0.0.1:5608/api/health", "http://127.0.0.1:5608/healthz"
    ]);
    assert.equal(lifecycle.calls.length, 4);
    assert.deepEqual(lifecycle.calls.map(({ args }) => args.slice(-2)), [
      ["config", "--quiet"], ["start", "mysql"], ["config", "--quiet"], ["backend", "gateway"]
    ]);
    const runtimeMutation = lifecycle.calls.at(-1).args;
    assert.deepEqual(runtimeMutation.slice(-6), ["up", "-d", "--no-build", "--no-deps", "backend", "gateway"]);
    assert.equal(lifecycle.calls.some(({ args }) => args.includes("--build") || args.includes("pull")), false);
  } finally { await cleanup(root); }
});

test("accepted status validates Compose rows probes conditionally and detects final authority or resource drift", async () => {
  const statusCase = async ({ partial = false, drift = false } = {}) => {
    const root = await fixture();
    const discovery = composeRuntimeDiscoveryFixture();
    const selected = await discoverComposeRuntime(discovery);
    const accepted = await materializeAcceptedAuthority(root, {
      engine: { socketIdentity: selected.socket.identity, daemonIdentity: selected.daemon.identity }
    });
    const ready = acceptedSnapshot(accepted);
    const notReady = acceptedSnapshot(accepted, (resources) => {
      resources.backend.State = acceptedContainerState("exited", { health: "unhealthy" });
      resources.gateway.State = acceptedContainerState("exited");
    });
    const initial = partial ? notReady : ready;
    const snapshots = drift ? [ready, ready, ready, notReady] : [initial, initial, initial, initial];
    const engine = acceptedEngineSequenceFixture(accepted, snapshots);
    const psRows = partial ? [{
      ID: accepted.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy", Ignored: "discard"
    }] : [
      { ID: accepted.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy", Ignored: "discard" },
      { ID: fixedHash("d"), Service: "backend", State: "running", Health: "healthy" },
      { ID: fixedHash("e"), Service: "gateway", State: "running", Health: "" }
    ];
    const lifecycle = acceptedLifecycleOptionsFixture(discovery, selected, engine, { psRows });
    const healthCalls = [];
    const options = {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: discovery,
      acceptedLifecycleOptions: lifecycle.options,
      requestHttpHealth: async (input) => {
        healthCalls.push(input.url);
        return input.url.endsWith("/healthz")
          ? { url: input.url, status: 200, contentType: "text/plain", body: "ok\n" }
          : { url: input.url, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, store: "mysql" }) };
      }
    };
    return { root, lifecycle, healthCalls, options };
  };

  const ready = await statusCase();
  try {
    const result = await apiOnlyStatus(ready.root, ready.options);
    assert.deepEqual(result, {
      project: "shensi-api-migration-0123456789ab",
      origin: "http://127.0.0.1:5608",
      services: [
        { service: "mysql", state: "running", health: "healthy" },
        { service: "backend", state: "running", health: "healthy" },
        { service: "gateway", state: "running", health: "none" }
      ],
      healthy: true
    });
    assert.equal(JSON.stringify(result).includes("discard"), false);
    assert.equal(ready.healthCalls.length, 2);
  } finally { await cleanup(ready.root); }

  const partial = await statusCase({ partial: true });
  try {
    const result = await apiOnlyStatus(partial.root, partial.options);
    assert.equal(result.healthy, false);
    assert.deepEqual(result.services, [{ service: "mysql", state: "running", health: "healthy" }]);
    assert.deepEqual(partial.healthCalls, []);
  } finally { await cleanup(partial.root); }

  const drift = await statusCase({ drift: true });
  try {
    await assert.rejects(apiOnlyStatus(drift.root, drift.options), /API_ONLY_ACCEPTED_STATUS_CHANGED/u);
    assert.equal(drift.healthCalls.length, 2);
  } finally { await cleanup(drift.root); }
});

test("accepted stop preserves pointer version files volume and networks proves stopped identities and waits for both loopback ports", async () => {
  const root = await fixture();
  try {
    const discovery = composeRuntimeDiscoveryFixture();
    const selected = await discoverComposeRuntime(discovery);
    const accepted = await materializeAcceptedAuthority(root, {
      engine: { socketIdentity: selected.socket.identity, daemonIdentity: selected.daemon.identity }
    });
    const running = acceptedSnapshot(accepted);
    const stopped = acceptedSnapshot(accepted, (resources) => {
      resources.mysql.State = acceptedContainerState("exited", { health: "unhealthy" });
      resources.backend.State = acceptedContainerState("exited", { health: "unhealthy" });
      resources.gateway.State = acceptedContainerState("exited");
    });
    const engine = acceptedEngineSequenceFixture(accepted, [running, running, stopped, stopped, stopped]);
    const lifecycle = acceptedLifecycleOptionsFixture(discovery, selected, engine);
    const protectedPaths = [
      join(accepted.runtimeRoot, "active-version.json"),
      join(accepted.runtimeRoot, "migration-state.json"),
      ...(await readdir(accepted.versionRoot)).sort().map((name) => join(accepted.versionRoot, name)),
      join(accepted.runtimeRoot, "secrets", "mysql_app_password"),
      join(accepted.runtimeRoot, "secrets", "mysql_root_password")
    ];
    const before = await Promise.all(protectedPaths.map(async (path) => ({
      path, bytes: await readFile(path), mode: (await lstat(path)).mode & 0o777
    })));
    const portCalls = [];
    const result = await stopApiOnlyRuntime(root, {
      ...preparedOptions(root),
      composeRuntimeDiscoveryOptions: discovery,
      acceptedLifecycleOptions: lifecycle.options,
      isPortAvailable: async (port) => { portCalls.push(port); return true; },
      portReleaseMonotonicNow: () => 0,
      portReleaseSleep: async () => undefined
    });
    assert.equal(result.operation, "stop");
    assert.deepEqual(portCalls.sort((left, right) => left - right), [3311, 5608]);
    assert.equal(lifecycle.calls.length, 2);
    assert.deepEqual(lifecycle.calls.at(-1).args.slice(-1), ["stop"]);
    assert.equal(lifecycle.calls.at(-1).args.includes("down"), false);
    assert.equal(lifecycle.calls.at(-1).args.includes("--volumes"), false);
    for (const expected of before) {
      assert.deepEqual(await readFile(expected.path), expected.bytes, expected.path);
      assert.equal((await lstat(expected.path)).mode & 0o777, expected.mode, expected.path);
    }
    assert.equal(engine.calls.some(({ path }) => path === `/networks/${accepted.expectedResources.networks.internal.id}`), true);
    assert.equal(engine.calls.some(({ path }) => path === `/volumes/${accepted.expectedResources.mysql.volumeName}`), true);
  } finally { await cleanup(root); }
});

test("public lifecycle cannot inject accepted authority", async () => {
  const root = await fixture();
  try {
    const injectedRuntime = await prepareApiOnlyRuntime(root, preparedOptions(root));
    await materializeAcceptedAuthority(root);
    const effects = { port: 0, discovery: 0, compose: 0, inspection: 0, health: 0, source: 0 };
    const acceptedEvidence = {
      state: "accepted",
      project: injectedRuntime.project,
      engineIdentity: injectedRuntime.composeRuntime.daemon.identity,
      network: "caller-network",
      mysql: { container: "caller-container", volume: "caller-volume" },
      backend: { imageDigest: `sha256:${fixedHash("a")}` },
      gatewaySnapshot: injectedRuntime.gatewaySnapshot,
      compose: injectedRuntime.composeRecord,
      desktopAdmission: { mode: "migration_locked" }
    };
    const options = {
      ...preparedOptions(root),
      project: "shensi-api",
      runtimeRoot: join(root, ".runtime", "caller-selected-authority"),
      runtime: injectedRuntime,
      acceptedEvidence,
      inspectAccepted: async () => { effects.inspection += 1; return acceptedEvidence; },
      authority: { phase: "accepted" },
      lifecycleAuthority: { phase: "accepted" },
      acceptedResourceProjection: { lifecyclePhase: "accepted" },
      expectedResources: { project: "caller-project" },
      acceptedResources: { project: "caller-project" },
      artifacts: { backendEnvironment: { path: "/caller/backend.env", sha256: fixedHash("0") } },
      backendEnvironmentPath: "/caller/backend.env",
      isPortAvailable: async () => { effects.port += 1; return true; },
      discoverRuntime: async () => { effects.discovery += 1; return fakeRuntime(); },
      resolveCompose: async () => { effects.source += 1; return { rootHash: "caller-source" }; },
      runCompose: async () => { effects.compose += 1; return { stdout: "[]" }; },
      checkHealth: async () => { effects.health += 1; return true; }
    };
    for (const operation of [prepareApiOnlyRuntime, startApiOnlyDatabase, startApiOnlyRuntime, stopApiOnlyRuntime, apiOnlyStatus]) {
      const failure = await operation(root, options).then(() => null, (caught) => caught);
      assert.match(failure?.message ?? "", /^API_ONLY_/u, operation.name);
    }
    assert.deepEqual(effects, { port: 0, discovery: 0, compose: 0, inspection: 0, health: 0, source: 0 });
  } finally { await cleanup(root); }

  for (const [state, code] of [["prepared", /API_ONLY_MIGRATION_IN_PROGRESS/u], ["write_activation_pending", /API_ONLY_ACCEPT_RESUME_REQUIRED/u]]) {
    const phaseRoot = await fixture();
    try {
      await materializeCanonicalJournal(phaseRoot, state);
      const effects = [];
      const options = {
        ...preparedOptions(phaseRoot),
        isPortAvailable: async () => { effects.push("port"); return true; },
        discoverRuntime: async () => { effects.push("discovery"); return fakeRuntime(); },
        resolveCompose: async () => { effects.push("source"); return { rootHash: "source" }; },
        runCompose: async () => { effects.push("compose"); return { stdout: "[]" }; },
        checkHealth: async () => { effects.push("health"); return true; }
      };
      for (const operation of [prepareApiOnlyRuntime, startApiOnlyDatabase, startApiOnlyRuntime, stopApiOnlyRuntime]) {
        await assert.rejects(operation(phaseRoot, options), code, `${state}:${operation.name}`);
      }
      const status = await apiOnlyStatus(phaseRoot, options);
      assert.equal(status.phase, state === "prepared" ? "migration" : "write_activation_pending");
      assert.equal(Object.isFrozen(status), true);
      assert.deepEqual(effects, []);
    } finally { await cleanup(phaseRoot); }
  }
});

test("Task 2 never creates or mutates the migration journal", async () => {
  const bootstrapRoot = await fixture();
  try {
    const runtime = await prepareApiOnlyRuntime(bootstrapRoot, preparedOptions(bootstrapRoot));
    await assert.rejects(lstat(join(runtime.root, "migration-state.json")), (caught) => caught?.code === "ENOENT");
    await assert.rejects(lstat(join(runtime.root, "active-version.json")), (caught) => caught?.code === "ENOENT");
  } finally { await cleanup(bootstrapRoot); }

  const legacyRoot = await fixture();
  try {
    const runtimeRoot = join(legacyRoot, ".runtime", "api-only");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(join(legacyRoot, ".runtime"), 0o700);
    await chmod(runtimeRoot, 0o700);
    await writeFile(join(runtimeRoot, "migration-state.json"), '{"state":"bootstrap"}\n', { mode: 0o600 });
    const before = await snapshotAuthorityTree(runtimeRoot);
    await assert.rejects(prepareApiOnlyRuntime(legacyRoot, preparedOptions(legacyRoot)), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
    assert.deepEqual(await snapshotAuthorityTree(runtimeRoot), before);
  } finally { await cleanup(legacyRoot); }

  const invalidRoot = await fixture();
  try {
    const { runtimeRoot } = await materializeCanonicalJournal(invalidRoot, "prepared");
    await writeFile(join(runtimeRoot, "active-version.json"), "invalid-pointer\n", { mode: 0o600 });
    const before = await snapshotAuthorityTree(runtimeRoot);
    const effects = [];
    await assert.rejects(startApiOnlyRuntime(invalidRoot, {
      ...preparedOptions(invalidRoot),
      discoverRuntime: async () => { effects.push("discovery"); return fakeRuntime(); },
      runCompose: async () => { effects.push("compose"); return { stdout: "" }; }
    }), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
    assert.deepEqual(await snapshotAuthorityTree(runtimeRoot), before);
    assert.deepEqual(effects, []);
  } finally { await cleanup(invalidRoot); }
});

test("canonical lifecycle blocks prepare after acceptance, start during write activation, and keeps verify-empty disposable", async () => {
  // Catches lifecycle aliases that could promote/reuse the accepted target.
  const acceptedRoot = await fixture();
  try {
    await materializeAcceptedAuthority(acceptedRoot);
    await assert.rejects(prepareApiOnlyRuntime(acceptedRoot, preparedOptions(acceptedRoot)), /API_ONLY_ALREADY_ACCEPTED/u);
  } finally { await cleanup(acceptedRoot); }

  const pendingRoot = await fixture();
  try {
    await materializeCanonicalJournal(pendingRoot, "write_activation_pending");
    await assert.rejects(startApiOnlyRuntime(pendingRoot, preparedOptions(pendingRoot)), /API_ONLY_ACCEPT_RESUME_REQUIRED/u);
  } finally { await cleanup(pendingRoot); }

  const disposableRoot = await fixture();
  try {
    const emptyOptions = preparedOptions(disposableRoot); delete emptyOptions.runtimeRoot;
    const empty = await prepareApiOnlyRuntime(disposableRoot, { ...emptyOptions, disposable: true, project: "shensi-api-empty-deadbeefcafe" });
    assert.equal(empty.project, "shensi-api-empty-deadbeefcafe");
    assert.deepEqual(empty.ports, { gateway: 5628, mysql: 3312 });
    assert.equal(empty.root, join(disposableRoot, ".runtime", "api-only-empty"));
  } finally { await cleanup(disposableRoot); }
});

test("stop uses Compose stop and never a destructive down or volume option", async () => {
  // Catches a shutdown regression that destroys retained evidence/data.
  const root = await fixture(); const calls = [];
  try {
    const runtime = await prepareApiOnlyRuntime(root, preparedOptions(root, calls));
    await stopApiOnlyRuntime(root, { ...preparedOptions(root, calls), runtime });
    const args = calls.at(-1).args;
    assert.equal(args.at(-1), "stop");
    assert.equal(args.includes("down"), false);
    assert.equal(args.includes("--volumes"), false);
  } finally { await cleanup(root); }
});

test("retained and disposable locks use fixed basenames and one exact non-secret record schema", async () => {
  const root = await fixture();
  const secretNeedle = "must-not-appear-in-owner-lock";
  const retainedOptions = {
    runtimeRoot: join(root, ".runtime", "api-only"),
    processInfo: () => ({ pid: 4242, startToken: "proc:4242:1700000000" }),
    isProcessCurrent: async () => true,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    engineIdentity: `engine-${secretNeedle}`,
    now: () => "2026-09-04T00:00:00.000Z"
  };
  let retained;
  let disposable;
  try {
    retained = await acquireApiOnlyOwnerLock(root, retainedOptions);
    assert.equal(retained.path, join(root, ".runtime", "api-only", "owner.lock"));
    const retainedText = await readFile(retained.path, "utf8");
    const retainedRecord = JSON.parse(retainedText);
    assert.equal(retainedText, `${JSON.stringify(retainedRecord)}\n`);
    assert.deepEqual(Object.keys(retainedRecord), ["project", "ports", "pid", "processStartToken", "nonce", "engineIdHash", "createdAt"]);
    assert.deepEqual(retainedRecord, {
      project: "shensi-api",
      ports: { gateway: 5608, mysql: 3311 },
      pid: 4242,
      processStartToken: "proc:4242:1700000000",
      nonce: "ab".repeat(16),
      engineIdHash: createHash("sha256").update(`engine-${secretNeedle}`).digest("hex"),
      createdAt: "2026-09-04T00:00:00.000Z"
    });
    const retainedInfo = await lstat(retained.path);
    assert.equal(retainedInfo.mode & 0o777, 0o600);
    assert.equal(retainedInfo.nlink, 1);
    assert.equal(retainedText.includes(secretNeedle), false);
    await releaseApiOnlyOwnerLock(retained, retainedOptions);
    retained = null;

    const disposableOptions = {
      ...retainedOptions,
      runtimeRoot: join(root, ".runtime", "api-only-empty"),
      disposable: true,
      project: "shensi-api-empty-aaaaaaaaaaaa"
    };
    disposable = await acquireApiOnlyOwnerLock(root, disposableOptions);
    assert.equal(disposable.path, join(root, ".runtime", "api-only-empty", "disposable-5628-3312"));
    await assert.rejects(acquireApiOnlyOwnerLock(root, {
      ...disposableOptions,
      project: "shensi-api-empty-bbbbbbbbbbbb"
    }), /API_ONLY_OWNER_LOCK_HELD/u);
  } finally {
    if (retained) await releaseApiOnlyOwnerLock(retained, retainedOptions);
    if (disposable) await releaseApiOnlyOwnerLock(disposable, { ...retainedOptions, runtimeRoot: join(root, ".runtime", "api-only-empty"), disposable: true, project: "shensi-api-empty-aaaaaaaaaaaa" });
    await cleanup(root);
  }

  for (const override of [
    { processInfo: () => ({ pid: Number.MAX_SAFE_INTEGER + 1, startToken: "token" }) },
    { processInfo: () => ({ pid: 12, startToken: "token\0hidden" }) },
    { randomBytes: () => Buffer.alloc(15, 1) },
    { now: () => "not-a-time" }
  ]) {
    const invalidRoot = await fixture();
    try {
      await assert.rejects(acquireApiOnlyOwnerLock(invalidRoot, {
        runtimeRoot: join(invalidRoot, ".runtime", "api-only"),
        processInfo: () => ({ pid: 12, startToken: "token" }),
        randomBytes: (size) => Buffer.alloc(size, 1),
        engineIdentity: "engine",
        now: () => "2026-09-04T00:00:00.000Z",
        ...override
      }), /API_ONLY_OWNER_LOCK_INPUT_INVALID/u);
    } finally { await cleanup(invalidRoot); }
  }
});

test("owner-lock liveness binds PID plus start token and stale recovery rechecks the same inode and record", async () => {
  const root = await fixture();
  const base = {
    runtimeRoot: join(root, ".runtime", "api-only"),
    processInfo: () => ({ pid: 7002, startToken: "contender-token" }),
    randomBytes: (size) => Buffer.alloc(size, 0x22),
    engineIdentity: "engine-fixture",
    now: () => "2026-09-04T00:00:00.000Z"
  };
  let owned;
  try {
    owned = await acquireApiOnlyOwnerLock(root, { ...base, processInfo: () => ({ pid: 7001, startToken: "owner-token" }) });
    await assert.rejects(acquireApiOnlyOwnerLock(root, {
      ...base,
      readProcessStartToken: async (pid) => pid === 7001 ? "owner-token" : null
    }), /API_ONLY_OWNER_LOCK_HELD/u);

    const recovered = await acquireApiOnlyOwnerLock(root, {
      ...base,
      readProcessStartToken: async (pid) => pid === 7001 ? "reused-pid-token" : null
    });
    owned = recovered;
    assert.equal(recovered.pid, 7002);
    assert.equal(recovered.processStartToken, "contender-token");
  } finally {
    if (owned) await releaseApiOnlyOwnerLock(owned, base);
    await cleanup(root);
  }

  const replacementRoot = await fixture();
  const replacementBase = {
    runtimeRoot: join(replacementRoot, ".runtime", "api-only"),
    processInfo: () => ({ pid: 8001, startToken: "old-owner" }),
    randomBytes: (size) => Buffer.alloc(size, 0x33),
    engineIdentity: "engine-fixture",
    now: () => "2026-09-04T00:00:00.000Z"
  };
  try {
    const old = await acquireApiOnlyOwnerLock(replacementRoot, replacementBase);
    const oldText = await readFile(old.path, "utf8");
    const replacement = { ...JSON.parse(oldText), pid: 8002, processStartToken: "replacement-owner", nonce: "44".repeat(16) };
    const displaced = `${old.path}.displaced`;
    let swapped = false;
    await assert.rejects(acquireApiOnlyOwnerLock(replacementRoot, {
      ...replacementBase,
      processInfo: () => ({ pid: 8003, startToken: "contender" }),
      isProcessCurrent: async () => false,
      async beforeStaleLockRemoval(path) {
        swapped = true;
        await rename(path, displaced);
        await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
    }), /API_ONLY_OWNER_LOCK_CHANGED/u);
    assert.equal(swapped, true);
    assert.equal(await readFile(old.path, "utf8"), `${JSON.stringify(replacement)}\n`);
    assert.equal(await readFile(displaced, "utf8"), oldText);
  } finally { await cleanup(replacementRoot); }

  const defaultReaderRoot = await fixture();
  let defaultReaderLock;
  try {
    defaultReaderLock = await acquireApiOnlyOwnerLock(defaultReaderRoot, {
      runtimeRoot: join(defaultReaderRoot, ".runtime", "api-only"),
      readProcessStartToken: async (pid) => pid === process.pid ? "injected-current-process-token" : null,
      randomBytes: (size) => Buffer.alloc(size, 0x55),
      engineIdentity: "engine-fixture",
      now: () => "2026-09-04T00:00:00.000Z"
    });
    assert.equal(defaultReaderLock.pid, process.pid);
    assert.equal(defaultReaderLock.processStartToken, "injected-current-process-token");
  } finally {
    if (defaultReaderLock) await releaseApiOnlyOwnerLock(defaultReaderLock, { runtimeRoot: join(defaultReaderRoot, ".runtime", "api-only") });
    await cleanup(defaultReaderRoot);
  }
});

test("owner-lock release requires the full record and refuses replacement before unlink", async () => {
  const root = await fixture();
  const options = {
    runtimeRoot: join(root, ".runtime", "api-only"),
    processInfo: () => ({ pid: 9001, startToken: "release-owner" }),
    randomBytes: (size) => Buffer.alloc(size, 0x66),
    engineIdentity: "engine-fixture",
    now: () => "2026-09-04T00:00:00.000Z"
  };
  try {
    const lock = await acquireApiOnlyOwnerLock(root, options);
    const changed = { ...JSON.parse(await readFile(lock.path, "utf8")), engineIdHash: "7".repeat(64) };
    await writeFile(lock.path, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    await assert.rejects(releaseApiOnlyOwnerLock(lock, options), /API_ONLY_OWNER_LOCK_OWNER_MISMATCH/u);
    assert.equal(await readFile(lock.path, "utf8"), `${JSON.stringify(changed)}\n`);
  } finally { await cleanup(root); }

  const replacementRoot = await fixture();
  const replacementOptions = {
    runtimeRoot: join(replacementRoot, ".runtime", "api-only"),
    processInfo: () => ({ pid: 9002, startToken: "replacement-release-owner" }),
    randomBytes: (size) => Buffer.alloc(size, 0x77),
    engineIdentity: "engine-fixture",
    now: () => "2026-09-04T00:00:00.000Z"
  };
  try {
    const lock = await acquireApiOnlyOwnerLock(replacementRoot, replacementOptions);
    const text = await readFile(lock.path, "utf8");
    const displaced = `${lock.path}.displaced`;
    let swapped = false;
    await assert.rejects(releaseApiOnlyOwnerLock(lock, {
      ...replacementOptions,
      async beforeOwnerLockRelease(path) {
        swapped = true;
        await rename(path, displaced);
        await writeFile(path, text, { mode: 0o600 });
      }
    }), /API_ONLY_OWNER_LOCK_CHANGED/u);
    assert.equal(swapped, true);
    assert.equal(await readFile(lock.path, "utf8"), text);
    assert.equal(await readFile(displaced, "utf8"), text);
  } finally { await cleanup(replacementRoot); }
});

test("owner-lock wrapper releases only after child cleanup on return, throw, and repeated signals", async () => {
  const makeInput = (root, events, overrides = {}) => ({
    repositoryRoot: root,
    runtimeRoot: join(root, ".runtime", "api-only"),
    processInfo: () => ({ pid: 9100, startToken: "wrapper-owner" }),
    randomBytes: (size) => Buffer.alloc(size, 0x88),
    engineIdentity: "engine-fixture",
    now: () => "2026-09-04T00:00:00.000Z",
    registerSignalHandler(signal, handler) {
      events.push(`register:${signal}`);
      overrides.handlers?.set(signal, handler);
      return () => events.push(`unregister:${signal}`);
    },
    async cleanupChildren(reason) { events.push(`cleanup:${reason}`); },
    async beforeOwnerLockRelease() { events.push("release"); },
    ...overrides
  });

  const normalRoot = await fixture();
  try {
    const events = [];
    assert.equal(await withApiOnlyOwnerLock(makeInput(normalRoot, events), async () => {
      events.push("callback");
      return "result";
    }), "result");
    assert.equal(events.indexOf("cleanup:return") > events.indexOf("callback"), true);
    assert.equal(events.indexOf("release") > events.indexOf("cleanup:return"), true);
    assert.equal(events.indexOf("unregister:SIGTERM") > events.indexOf("release"), true);
  } finally { await cleanup(normalRoot); }

  const throwRoot = await fixture();
  try {
    const events = [];
    await assert.rejects(withApiOnlyOwnerLock(makeInput(throwRoot, events), async () => {
      events.push("callback");
      throw new Error("CALLBACK_FAILED");
    }), /CALLBACK_FAILED/u);
    assert.equal(events.indexOf("cleanup:error") > events.indexOf("callback"), true);
    assert.equal(events.indexOf("release") > events.indexOf("cleanup:error"), true);
  } finally { await cleanup(throwRoot); }

  const signalRoot = await fixture();
  try {
    const events = [];
    const handlers = new Map();
    let finishCallback;
    let finishCleanup;
    let markReady;
    const ready = new Promise((resolveReady) => { markReady = resolveReady; });
    const input = makeInput(signalRoot, events, {
      handlers,
      cleanupChildren: async (reason) => {
        events.push(`cleanup:${reason}:start`);
        await new Promise((resolveCleanup) => { finishCleanup = resolveCleanup; });
        events.push(`cleanup:${reason}:done`);
      }
    });
    const running = withApiOnlyOwnerLock(input, async () => {
      events.push("callback:start");
      markReady();
      return new Promise((resolveCallback) => { finishCallback = resolveCallback; });
    });
    await ready;
    const first = handlers.get("SIGINT")();
    const second = handlers.get("SIGTERM")();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(events.filter((value) => value.endsWith(":start")).length, 2);
    assert.equal(events.filter((value) => value.startsWith("cleanup:")).length, 1);
    assert.equal(events.includes("release"), false);
    finishCleanup();
    await Promise.all([first, second]);
    assert.equal(events.includes("release"), false);
    finishCallback("signal-result");
    assert.equal(await running, "signal-result");
    assert.equal(events.filter((value) => value.startsWith("cleanup:")).length, 2);
    assert.equal(events.indexOf("release") > events.indexOf("cleanup:SIGINT:done"), true);
  } finally { await cleanup(signalRoot); }

  const cleanupFailureRoot = await fixture();
  let failedLockPath;
  try {
    const events = [];
    const input = makeInput(cleanupFailureRoot, events, {
      cleanupChildren: async () => { events.push("cleanup:failed"); throw new Error("CHILD_CLEANUP_FAILED"); }
    });
    await assert.rejects(withApiOnlyOwnerLock(input, async (lock) => {
      failedLockPath = lock.path;
      return "ignored";
    }), /CHILD_CLEANUP_FAILED/u);
    assert.equal(events.includes("release"), false);
    assert.equal((await lstat(failedLockPath)).isFile(), true);
  } finally {
    if (failedLockPath) await rm(failedLockPath, { force: true });
    await cleanup(cleanupFailureRoot);
  }
});

test("owner lock rejects a live owner and only the exact nonce releases it", async () => {
  // Catches a stale-lock shortcut that lets a second supervisor delete a live
  // owner's lock record.
  const root = await fixture();
  try {
    const options = { runtimeRoot: join(root, ".runtime", "api-only"), processInfo: () => ({ pid: 4242, startToken: "same-process" }), isProcessCurrent: async () => true, engineIdentity: "engine-fixture", now: () => "2026-09-04T00:00:00.000Z" };
    const lock = await acquireApiOnlyOwnerLock(root, options);
    await assert.rejects(acquireApiOnlyOwnerLock(root, options), /API_ONLY_OWNER_LOCK_HELD/u);
    await assert.rejects(releaseApiOnlyOwnerLock({ ...lock, nonce: "wrong" }, options), /API_ONLY_OWNER_LOCK_OWNER_MISMATCH/u);
    await releaseApiOnlyOwnerLock(lock, options);
    let callbackRan = false;
    await withApiOnlyOwnerLock({ repositoryRoot: root, ...options }, async () => { callbackRan = true; });
    assert.equal(callbackRan, true);
  } finally { await cleanup(root); }
});

function smokeJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function smokeBodyFor(route, workspaceId = "workspace-from-bootstrap") {
  if (route.module === "growth bootstrap") {
    return { status: "ready", workspaceId, features: [] };
  }
  const body = {};
  for (const key of route.shape.required) body[key] = `${key}-value`;
  for (const key of route.shape.arrays) body[key] = [];
  for (const key of route.shape.numbers) body[key] = 0;
  if (route.module === "auth") body.user = { id: "user-from-auth" };
  return body;
}

const EXPECTED_SMOKE_ROUTES = Object.freeze([
  ["auth", "/api/auth/me", ["user"], [], []],
  ["dashboard", "/api/dashboard/summary", ["scope", "metrics"], [], []],
  ["agents", "/api/v1/business-advisor/agents", ["items"], ["items"], []],
  ["growth bootstrap", "/api/v1/growth/bootstrap", ["status", "workspaceId", "features"], ["features"], []],
  ["acquisition", "/api/v1/acquisition/overview?platform=douyin", ["generatedAt", "tasks"], [], []],
  ["conversations/account", "/api/v1/acquisition/social-accounts/douyin", ["items"], ["items"], []],
  ["private domain", "/api/customers?scope=mine", ["customers"], ["customers"], []],
  ["private-domain todos", "/api/todos", ["todos"], ["todos"], []],
  ["conversion", "/api/deals", ["deals", "events"], ["deals", "events"], []],
  ["scripts/knowledge", "/api/knowledge/assets", ["assets"], ["assets"], []],
  ["trade marketing", "/api/prospect-campaigns?includeArchived=false", ["campaigns", "total"], ["campaigns"], ["total"]],
  ["settings", "/api/profile", ["user"], [], []],
  ["search connections", "/api/v1/acquisition/provider-connections", ["items", "nextCursor"], ["items"], []],
  ["AI connections", "/api/v1/ai/connections", ["items", "nextCursor"], ["items"], []],
  ["advisor", "/api/v1/acquisition/advisor/today?currency=CNY&asOf=<clock ISO>", [], [], []],
  ["catalog", "/api/v1/catalog/items?limit=1", ["items"], ["items"], []],
  ["quotes", "/api/v1/quotes/cases?limit=1", ["items"], ["items"], []],
  ["finance costs", "/api/v1/acquisition/cost-entries?limit=1", ["items"], ["items"], []],
  ["finance facts", "/api/v1/finance/facts?limit=1", ["items"], ["items"], []],
  ["ROI", "/api/v1/acquisition/cohorts?limit=1", ["items"], ["items"], []],
  ["financial council", "/api/v1/finance/council-policy", ["policyVersionId", "revision"], [], []]
]);

test("Task 3 smoke manifest freezes the exact authenticated read-only module surface", () => {
  assert.equal(Object.isFrozen(API_ONLY_SMOKE_ROUTES), true);
  assert.equal(API_ONLY_SMOKE_ROUTES.length, EXPECTED_SMOKE_ROUTES.length);
  assert.deepEqual(API_ONLY_SMOKE_ROUTES.map((route) => [
    route.module,
    route.path,
    route.shape.required,
    route.shape.arrays,
    route.shape.numbers
  ]), EXPECTED_SMOKE_ROUTES);
  assert.deepEqual(new Set(API_ONLY_SMOKE_ROUTES.map((route) => route.path)).size,
    API_ONLY_SMOKE_ROUTES.length);
  for (const route of API_ONLY_SMOKE_ROUTES) {
    assert.equal(Object.isFrozen(route), true);
    assert.equal(Object.isFrozen(route.shape), true);
    assert.equal(route.method, "GET");
    assert.equal(route.realPlatformWrite, false);
  }
});

test("Task 3 authentication has exact register and login payloads and keeps credentials in memory", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return smokeJson({
      token: url.endsWith("/register") ? "register-token" : "login-token",
      csrfToken: url.endsWith("/register") ? "register-csrf" : "login-csrf",
      user: { id: "user-auth", teamId: "workspace-auth" }
    }, url.endsWith("/register") ? 201 : 200);
  };
  const registered = await authenticateApiOnlySmoke({
    origin: "http://127.0.0.1:5628",
    mode: "register",
    account: "api_smoke_123456789abc",
    password: "register-password-secret",
    fetchImpl
  });
  const loggedIn = await authenticateApiOnlySmoke({
    origin: "http://127.0.0.1:5608",
    mode: "login",
    email: "test@example.invalid",
    password: "login-password-secret",
    fetchImpl
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    account: "api_smoke_123456789abc",
    password: "register-password-secret"
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    email: "test@example.invalid",
    password: "login-password-secret"
  });
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.signal instanceof AbortSignal, true);
  }
  assert.deepEqual(registered, {
    bearerToken: "register-token",
    csrfToken: "register-csrf",
    user: { id: "user-auth", teamId: "workspace-auth" },
    activeWorkspace: "workspace-auth"
  });
  assert.deepEqual(loggedIn, {
    bearerToken: "login-token",
    csrfToken: "login-csrf",
    user: { id: "user-auth", teamId: "workspace-auth" },
    activeWorkspace: "workspace-auth"
  });
});

test("Task 3 runner authenticates, resolves bootstrap workspace, and emits body-free module evidence", async () => {
  const calls = [];
  const clock = () => new Date("2026-09-04T08:09:10.123Z");
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: `${parsed.pathname}${parsed.search}`, init });
    if (parsed.pathname === "/api/auth/login") {
      return smokeJson({
        token: "token-must-not-leak",
        csrfToken: "csrf-must-not-leak",
        user: { id: "user-must-not-be-used-as-workspace", teamId: "workspace-auth" }
      });
    }
    const route = API_ONLY_SMOKE_ROUTES.find((candidate) =>
      candidate.module === "advisor"
        ? parsed.pathname === "/api/v1/acquisition/advisor/today"
        : candidate.path === `${parsed.pathname}${parsed.search}`);
    assert.ok(route, `unexpected smoke path ${parsed.pathname}${parsed.search}`);
    return smokeJson(smokeBodyFor(route));
  };
  const report = await runApiOnlyModuleSmoke({
    origin: "http://127.0.0.1:5628",
    mode: "login",
    email: "smoke@example.invalid",
    password: "password-must-not-leak",
    fetchImpl,
    clock
  });
  assert.equal(report.length, API_ONLY_SMOKE_ROUTES.length);
  assert.deepEqual(report.map((row) => Object.keys(row)),
    API_ONLY_SMOKE_ROUTES.map(() => ["module", "method", "path", "status", "shape"]));
  assert.deepEqual(report.map(({ module, method, status }) => ({ module, method, status })),
    API_ONLY_SMOKE_ROUTES.map(({ module, method }) => ({ module, method, status: 200 })));
  const serialized = JSON.stringify(report);
  for (const forbidden of ["token-must-not-leak", "csrf-must-not-leak", "password-must-not-leak",
    "user-must-not-be-used-as-workspace", "workspace-from-bootstrap"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(report.find((row) => row.module === "advisor").path,
    "/api/v1/acquisition/advisor/today?currency=CNY&asOf=2026-09-04T08%3A09%3A10.123Z");
  const moduleCalls = calls.filter(({ path }) => path !== "/api/auth/login");
  assert.equal(moduleCalls.length, API_ONLY_SMOKE_ROUTES.length);
  for (const call of moduleCalls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.Authorization, "Bearer token-must-not-leak");
    assert.equal(call.init.redirect, "manual");
  }
  const bootstrapIndex = calls.findIndex(({ path }) => path === "/api/v1/growth/bootstrap");
  assert.equal(bootstrapIndex, 1);
  for (const call of moduleCalls.filter(({ path }) => path !== "/api/v1/growth/bootstrap")) {
    assert.equal(call.init.headers["X-Workspace-Id"], "workspace-from-bootstrap");
  }
  assert.equal(calls[bootstrapIndex].init.headers["X-Workspace-Id"], "workspace-auth");
});

test("Task 3 smoke failures expose only module path and status", async () => {
  const session = Object.freeze({
    bearerToken: "failure-token-secret",
    csrfToken: "failure-csrf-secret",
    user: { id: "failure-user-secret", teamId: "workspace-auth" },
    activeWorkspace: "workspace-auth"
  });
  const cases = [
    {
      name: "401",
      target: "auth",
      response: () => smokeJson({ detail: "server-secret-token-password" }, 401),
      expected: "API_ONLY_SMOKE_FAILED:auth:/api/auth/me:401"
    },
    {
      name: "non-json",
      target: "auth",
      response: () => new Response("server-secret-token-password", {
        status: 200, headers: { "content-type": "text/plain" }
      }),
      expected: "API_ONLY_SMOKE_INVALID_RESPONSE:auth:/api/auth/me:200"
    },
    {
      name: "missing key",
      target: "auth",
      response: () => smokeJson({}),
      expected: "API_ONLY_SMOKE_INVALID_RESPONSE:auth:/api/auth/me:200"
    },
    {
      name: "wrong array",
      target: "agents",
      response: () => smokeJson({ items: "server-secret-token-password" }),
      expected: "API_ONLY_SMOKE_INVALID_RESPONSE:agents:/api/v1/business-advisor/agents:200"
    },
    {
      name: "non-200 module",
      target: "agents",
      response: () => smokeJson({ detail: "server-secret-token-password" }, 503),
      expected: "API_ONLY_SMOKE_FAILED:agents:/api/v1/business-advisor/agents:503"
    }
  ];
  for (const scenario of cases) {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const route = API_ONLY_SMOKE_ROUTES.find((candidate) =>
        candidate.module === "advisor"
          ? parsed.pathname === "/api/v1/acquisition/advisor/today"
          : candidate.path === `${parsed.pathname}${parsed.search}`);
      assert.ok(route);
      if (route.module === scenario.target) return scenario.response();
      return smokeJson(smokeBodyFor(route));
    };
    let caught;
    try {
      await runApiOnlyModuleSmoke({
        origin: "http://127.0.0.1:5628", session, fetchImpl,
        clock: () => new Date("2026-09-04T08:09:10.123Z")
      });
    } catch (error) { caught = error; }
    assert.equal(caught?.message, scenario.expected, scenario.name);
    for (const forbidden of ["failure-token-secret", "failure-csrf-secret", "failure-user-secret",
      "server-secret-token-password"]) assert.equal(String(caught).includes(forbidden), false);
  }
});

test("Task 3 authentication failures and invalid origins are closed and redacted", async () => {
  for (const response of [
    smokeJson({ detail: "password-leak" }, 401),
    new Response("password-leak", { status: 200, headers: { "content-type": "text/plain" } }),
    smokeJson({ token: "token-leak", csrfToken: "csrf-leak", user: {} })
  ]) {
    let caught;
    try {
      await authenticateApiOnlySmoke({
        origin: "http://127.0.0.1:5628", mode: "login", email: "user@example.invalid",
        password: "password-leak", fetchImpl: async () => response
      });
    } catch (error) { caught = error; }
    assert.match(caught?.message ?? "", /^API_ONLY_SMOKE_(?:FAILED|INVALID_RESPONSE):auth:\/api\/auth\/login:(?:200|401)$/u);
    for (const forbidden of ["password-leak", "token-leak", "csrf-leak"])
      assert.equal(String(caught).includes(forbidden), false);
  }
  for (const origin of [
    "https://127.0.0.1:5628", "http://localhost:5628", "http://127.0.0.1:9999",
    "http://user:password@127.0.0.1:5628", "http://127.0.0.1:5628/"
  ]) {
    await assert.rejects(authenticateApiOnlySmoke({
      origin, mode: "login", email: "user@example.invalid", password: "secret",
      fetchImpl: async () => { throw new Error("must not fetch"); }
    }), /API_ONLY_SMOKE_ORIGIN_INVALID/u);
  }
  await assert.rejects(authenticateApiOnlySmoke({
    origin: "http://127.0.0.1:5628", mode: "unknown", password: "secret",
    fetchImpl: async () => { throw new Error("must not fetch"); }
  }), /API_ONLY_SMOKE_AUTH_MODE_INVALID/u);
});

test("Task 3 per-request deadline remains active through response-body validation", async () => {
  const active = new Map();
  let nextTimer = 0;
  const setTimeoutImpl = (_callback, milliseconds) => {
    const timer = { id: nextTimer += 1, milliseconds };
    active.set(timer.id, timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => { active.delete(timer.id); };
  const response = {
    status: 200,
    redirected: false,
    url: "http://127.0.0.1:5628/api/auth/login",
    headers: new Headers({ "content-type": "application/json" }),
    async text() {
      assert.equal([...active.values()].some(({ milliseconds }) => milliseconds === 10_000), true);
      return JSON.stringify({
        token: "deadline-token", csrfToken: "deadline-csrf",
        user: { id: "deadline-user", teamId: "deadline-workspace" }
      });
    }
  };
  await authenticateApiOnlySmoke({
    origin: "http://127.0.0.1:5628", mode: "login", email: "deadline-user",
    password: "deadline-password", fetchImpl: async () => response,
    setTimeoutImpl, clearTimeoutImpl
  });
  assert.equal(active.size, 0);
});

test("Task 3 suite deadline includes authentication and every module body", async () => {
  const active = new Map();
  let nextTimer = 0;
  const setTimeoutImpl = (_callback, milliseconds) => {
    const timer = { id: nextTimer += 1, milliseconds };
    active.set(timer.id, timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => { active.delete(timer.id); };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const body = parsed.pathname === "/api/auth/login"
      ? { token: "suite-token", csrfToken: "suite-csrf", user: { id: "suite-user", teamId: "suite-auth-workspace" } }
      : smokeBodyFor(API_ONLY_SMOKE_ROUTES.find((candidate) =>
        candidate.module === "advisor"
          ? parsed.pathname === "/api/v1/acquisition/advisor/today"
          : candidate.path === path));
    return {
      status: 200,
      redirected: false,
      url,
      headers: new Headers({ "content-type": "application/json" }),
      async text() {
        const durations = [...active.values()].map(({ milliseconds }) => milliseconds);
        assert.equal(durations.includes(90_000), true);
        assert.equal(durations.includes(10_000), true);
        return JSON.stringify(body);
      }
    };
  };
  await runApiOnlyModuleSmoke({
    origin: "http://127.0.0.1:5628", mode: "login", email: "suite-user",
    password: "suite-password", fetchImpl,
    clock: () => new Date("2026-09-04T08:09:10.123Z"),
    setTimeoutImpl, clearTimeoutImpl
  });
  assert.equal(active.size, 0);
});

test("Task 3 gateway boundary proves only health routes and denies Web noVNC and upgrade paths", async () => {
  const httpCalls = [];
  const upgradeCalls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    httpCalls.push({ path: parsed.pathname, init });
    if (parsed.pathname === "/healthz") {
      return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (parsed.pathname === "/api/health") {
      return smokeJson({ ok: true, store: "mysql", prospectQueue: { running: false } });
    }
    return new Response("", { status: 404 });
  };
  const upgradeProbe = async (url, options) => {
    upgradeCalls.push({ path: new URL(url).pathname, options });
    return { status: 404 };
  };
  const report = await verifyApiOnlyGatewayBoundary({
    origin: "http://127.0.0.1:5628", fetchImpl, upgradeProbe
  });
  assert.deepEqual(httpCalls.map(({ path }) => path), [
    "/healthz", "/api/health", "/", "/live-sessions/probe",
    `/douyin-live/${"A".repeat(43)}`, "/novnc/vnc.html"
  ]);
  assert.deepEqual(upgradeCalls.map(({ path }) => path), [
    "/live-sessions/probe", `/douyin-live/${"A".repeat(43)}`
  ]);
  for (const { init } of httpCalls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal instanceof AbortSignal, true);
  }
  assert.deepEqual(report.http.map(({ path, status }) => ({ path, status })), [
    { path: "/healthz", status: 200 },
    { path: "/api/health", status: 200 },
    { path: "/", status: 404 },
    { path: "/live-sessions/probe", status: 404 },
    { path: `/douyin-live/${"A".repeat(43)}`, status: 404 },
    { path: "/novnc/vnc.html", status: 404 }
  ]);
  assert.deepEqual(report.upgrades, [
    { method: "UPGRADE", path: "/live-sessions/probe", status: 404 },
    { method: "UPGRADE", path: `/douyin-live/${"A".repeat(43)}`, status: 404 }
  ]);
});

test("Task 3 gateway boundary rejects health drift and any accepted upgrade", async () => {
  const baseFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/healthz") return new Response("ok", { status: 200 });
    if (path === "/api/health") return smokeJson({ ok: true, store: "memory" });
    return new Response("", { status: 404 });
  };
  await assert.rejects(verifyApiOnlyGatewayBoundary({
    origin: "http://127.0.0.1:5628", fetchImpl: baseFetch,
    upgradeProbe: async () => ({ status: 404 })
  }), /API_ONLY_GATEWAY_BOUNDARY_FAILED:\/healthz:200/u);

  const validFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/healthz") return new Response("ok\n", { status: 200 });
    if (path === "/api/health") return smokeJson({ ok: true, store: "mysql" });
    return new Response("", { status: 404 });
  };
  await assert.rejects(verifyApiOnlyGatewayBoundary({
    origin: "http://127.0.0.1:5628", fetchImpl: validFetch,
    upgradeProbe: async () => ({ status: 101 })
  }), /API_ONLY_GATEWAY_UPGRADE_ACCEPTED:\/live-sessions\/probe:101/u);
});

test("Task 4 disposable identity is exact isolated and run-scoped", () => {
  const first = createDisposableApiOnlyIdentity((size) => {
    assert.equal(size, 6);
    return Buffer.from("0123456789ab", "hex");
  });
  const second = createDisposableApiOnlyIdentity(() => Buffer.from("fedcba987654", "hex"));
  assert.deepEqual(first, {
    suffix: "0123456789ab",
    project: "shensi-api-empty-0123456789ab",
    runtimeRelativeRoot: ".runtime/api-only-empty/0123456789ab",
    ports: { gateway: 5628, mysql: 3312 },
    account: "api_smoke_0123456789ab"
  });
  assert.notEqual(first.project, second.project);
  assert.match(first.project, /^shensi-api-empty-[a-f0-9]{12}$/u);
  assert.match(first.account, /^api_smoke_[a-f0-9]{12}$/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.ports), true);
  for (const invalid of [
    () => Buffer.alloc(5),
    () => Buffer.alloc(7),
    () => "0123456789ab",
    () => { throw new Error("entropy must be redacted"); }
  ]) assert.throws(() => createDisposableApiOnlyIdentity(invalid), /API_ONLY_DISPOSABLE_IDENTITY_INVALID/u);
});

test("Task 4 disposable preparation uses its run root and independently generated owner-only secrets", async () => {
  const root = await fixture();
  try {
    const identity = createDisposableApiOnlyIdentity(() => Buffer.from("0123456789ab", "hex"));
    const runtimeRoot = join(root, identity.runtimeRelativeRoot);
    const options = preparedOptions(root);
    delete options.runtimeRoot;
    const runtime = await prepareApiOnlyRuntime(root, {
      ...options,
      disposable: true,
      project: identity.project,
      runtimeRoot
    });
    assert.equal(runtime.root, runtimeRoot);
    assert.equal(runtime.project, identity.project);
    assert.deepEqual(runtime.ports, identity.ports);
    for (const directory of [
      join(root, ".runtime", "api-only-empty"), runtimeRoot,
      runtime.secretsDirectory, runtime.logsDirectory, runtime.evidenceDirectory
    ]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    for (const filename of [
      ...Object.values(API_ONLY_CRYPTO_SECRET_BINDINGS),
      "smoke_login_password", "mysql_app_password", "mysql_root_password",
      "bootstrap_admin_password", "migration_reader_password", "migration_backup_passphrase"
    ]) {
      const path = join(runtime.secretsDirectory, filename);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(path, "utf8"), /^fixture-/u);
    }
    assert.equal(runtime.backend.CORS_ORIGINS, "http://127.0.0.1:5628");
  } finally { await cleanup(root); }
});

async function disposableCleanupFixture(suffix = "0123456789ab") {
  const root = await fixture();
  const project = `shensi-api-empty-${suffix}`;
  const base = join(root, ".runtime", "api-only-empty");
  const runtimeRoot = join(base, suffix);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await chmod(runtimeRoot, 0o700);
  const retainedRoot = join(root, ".runtime", "api-only");
  const retainedEvidenceDirectory = join(retainedRoot, "evidence", "empty");
  await mkdir(retainedEvidenceDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [retainedRoot, join(retainedRoot, "evidence"), retainedEvidenceDirectory]) {
    await chmod(directory, 0o700);
  }
  const retainedPath = join(retainedEvidenceDirectory, `${suffix}.json`);
  const retainedBytes = Buffer.from(`${JSON.stringify({ verified: true, suffix })}\n`);
  await writeFile(retainedPath, retainedBytes, { mode: 0o600 });
  const composeRuntime = fakeRuntime();
  const lockOptions = {
    runtimeRoot: base,
    disposable: true,
    project,
    processInfo: () => ({ pid: 8181, startToken: `cleanup-${suffix}` }),
    isProcessCurrent: async () => true,
    randomBytes: (size) => Buffer.alloc(size, 0x91),
    engineIdentity: composeRuntime.daemon.identity,
    now: () => "2026-09-04T09:00:00.000Z"
  };
  const ownerLock = await acquireApiOnlyOwnerLock(root, lockOptions);
  return {
    root,
    base,
    lockOptions,
    runtime: Object.freeze({
      repositoryRoot: root,
      root: runtimeRoot,
      project,
      ports: Object.freeze({ gateway: 5628, mysql: 3312 }),
      composeRuntime,
      runtimeNonce: fixedHash("6"),
      ownerLock,
      retainedEvidence: Object.freeze({
        path: retainedPath,
        sha256: fixtureSha256(retainedBytes)
      })
    })
  };
}

for (const [suite, purpose] of [["installation", "desktop-action-storage"],
  ["outreach-schema", "desktop-action-storage"],
  ["multi-mac-crm", "multi-mac-crm-mysql"],
  ["bridge-mysql", "desktop-action-bridge-mysql"]]) {
for (const result of ["passed", "failed"]) {
test(`${purpose}${suite === "outreach-schema" ? " outreach-schema" : ""} ${result} cleanup evidence is isolated from empty verification evidence`, async () => {
  const fixture = await disposableCleanupFixture();
  try {
    const evidenceDirectory = join(fixture.runtime.root, "evidence");
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const runtime = { ...fixture.runtime, evidenceDirectory };
    const receipt = await persistDesktopActionStorageCleanupEvidence(
      fixture.root,
      runtime,
      { suffix: "0123456789ab", project: fixture.runtime.project,
        ports: fixture.runtime.ports },
      { suite, result,
        verifiedAt: "2026-09-04T09:01:00.000Z" }
    );
    assert.equal(receipt.retained.path, join(fixture.root, ".runtime", "api-only",
      "evidence", purpose, "0123456789ab.json"));
    assert.doesNotMatch(receipt.retained.path, /\/evidence\/empty\//u);
    const retainedBytes = await readFile(receipt.retained.path);
    assert.deepEqual(await readFile(receipt.runtimePath), retainedBytes);
    assert.equal((await lstat(receipt.retained.path)).mode & 0o777, 0o600);
    assert.equal(receipt.retained.sha256, fixtureSha256(retainedBytes));
    const persisted = JSON.parse(retainedBytes.toString("utf8"));
    assert.deepEqual(persisted, {
      schema: `shensi.${purpose}.cleanup-receipt`,
      version: 1,
      result,
      verifiedAt: "2026-09-04T09:01:00.000Z",
      project: fixture.runtime.project,
      projectSuffix: "0123456789ab",
      ports: { gateway: 5628, mysql: 3312 },
      suite
    });
    let volumeInspection = 0;
    const cleaned = await destroyDisposableApiOnlyRuntime({
      ...runtime,
      retainedEvidence: receipt.retained
    }, {
      resolveComposeRuntimeForCleanup: async () => runtime.composeRuntime,
      inspectDisposableVolumes: async () => (result === "passed" && ++volumeInspection === 1
        ? [`${runtime.project}_mysql_data`] : []),
      runDisposableComposeDown: async () => ({ code: 0 })
    });
    assert.equal(cleaned.cleanup, "complete");
    await assert.rejects(lstat(runtime.root), { code: "ENOENT" });
    assert.deepEqual(await readFile(receipt.retained.path), retainedBytes);
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});
}
}

test("outreach-schema cleanup receipt cannot be relabeled as bridge matrix proof", async () => {
  // A broad shared suite allowlist must not let a schema-only receipt acquire
  // the bridge-matrix purpose merely by changing its path and schema field.
  const fixture = await disposableCleanupFixture();
  try {
    const evidenceDirectory = join(fixture.runtime.root, "evidence");
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const runtime = { ...fixture.runtime, evidenceDirectory };
    const receipt = await persistDesktopActionStorageCleanupEvidence(fixture.root, runtime,
      { suffix: "0123456789ab", project: runtime.project, ports: runtime.ports },
      { suite: "outreach-schema", result: "passed", verifiedAt: "2026-09-04T09:01:00.000Z" });
    const forgedDirectory = join(fixture.root, ".runtime", "api-only", "evidence", "desktop-action-bridge-mysql");
    await mkdir(forgedDirectory, { mode: 0o700 });
    const forgedPath = join(forgedDirectory, "0123456789ab.json");
    const forged = JSON.parse(await readFile(receipt.retained.path, "utf8"));
    forged.schema = "shensi.desktop-action-bridge-mysql.cleanup-receipt";
    const forgedBytes = Buffer.from(`${JSON.stringify(forged)}\n`);
    await writeFile(forgedPath, forgedBytes, { mode: 0o600 });
    const effects = [];
    await assert.rejects(destroyDisposableApiOnlyRuntime({
      ...runtime,
      retainedEvidence: { path: forgedPath, sha256: fixtureSha256(forgedBytes) }
    }, {
      resolveComposeRuntimeForCleanup: async () => { effects.push("engine"); return runtime.composeRuntime; },
      inspectDisposableVolumes: async () => { effects.push("volumes"); return [`${runtime.project}_mysql_data`]; },
      runDisposableComposeDown: async () => { effects.push("down"); return { code: 0 }; }
    }), /API_ONLY_DISPOSABLE_EVIDENCE_INVALID/u);
    assert.deepEqual(effects, []);
    assert.equal((await lstat(runtime.root)).isDirectory(), true);
    assert.equal(JSON.parse(await readFile(receipt.retained.path, "utf8")).suite, "outreach-schema");
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});

test("Task 2 desktop storage authority rejects a forged lock and validates live engine ownership", async () => {
  const fixture = await disposableCleanupFixture();
  try {
    const validated = await validateDisposableApiOnlyOwnerLock(fixture.root, {
      nonce: fixture.runtime.ownerLock.nonce,
      readProcessStartToken: async () => fixture.runtime.ownerLock.processStartToken,
      resolveComposeRuntimeForOwnerLockValidation: async () => fixture.runtime.composeRuntime
    });
    assert.equal(validated.project, fixture.runtime.project);
    assert.equal(validated.engineIdHash, fixture.runtime.ownerLock.engineIdHash);
    await assert.rejects(validateDisposableApiOnlyOwnerLock(fixture.root, {
      nonce: fixture.runtime.ownerLock.nonce,
      readProcessStartToken: async () => "stale-process-start-token",
      resolveComposeRuntimeForOwnerLockValidation: async () => fixture.runtime.composeRuntime
    }), /API_ONLY_OWNER_LOCK_INVALID/u);
    await assert.rejects(validateDisposableApiOnlyOwnerLock(fixture.root, {
      nonce: fixture.runtime.ownerLock.nonce,
      readProcessStartToken: async () => fixture.runtime.ownerLock.processStartToken,
      resolveComposeRuntimeForOwnerLockValidation: async () => ({
        ...fixture.runtime.composeRuntime, daemon: { identity: "foreign-engine" }
      })
    }), /API_ONLY_OWNER_LOCK_ENGINE_INVALID/u);
    await writeFile(fixture.runtime.ownerLock.path, JSON.stringify({
      project: fixture.runtime.project,
      ports: fixture.runtime.ports,
      nonce: fixture.runtime.ownerLock.nonce
    }), { mode: 0o600 });
    await assert.rejects(validateDisposableApiOnlyOwnerLock(fixture.root, {
      nonce: fixture.runtime.ownerLock.nonce,
      readProcessStartToken: async () => fixture.runtime.ownerLock.processStartToken,
      resolveComposeRuntimeForOwnerLockValidation: async () => fixture.runtime.composeRuntime
    }), /API_ONLY_OWNER_LOCK_INVALID/u);
  } finally { await cleanup(fixture.root); }
});

test("Task 2 failed disposable preparation removes only an owned resource-free run root", async () => {
  const fixture = await disposableCleanupFixture();
  try {
    const result = await destroyFailedDisposableApiOnlyPreparation({
      repositoryRoot: fixture.root, root: fixture.runtime.root,
      project: fixture.runtime.project, ports: fixture.runtime.ports,
      composeRuntime: fixture.runtime.composeRuntime,
      ownerLock: fixture.runtime.ownerLock
    }, {
      readProcessStartToken: async () => fixture.runtime.ownerLock.processStartToken,
      resolveComposeRuntimeForOwnerLockValidation: async () => fixture.runtime.composeRuntime,
      resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
      inspectFailedPreparationResources: async () => ({
        containers: [], networks: [], volumes: []
      })
    });
    assert.equal(result.cleanup, "complete");
    await assert.rejects(lstat(fixture.runtime.root), { code: "ENOENT" });
    assert.equal((await lstat(fixture.runtime.ownerLock.path)).isFile(), true);
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});

test("Task 4 cleanup validates project root owner engine evidence and volume scope before exact down", async () => {
  const fixture = await disposableCleanupFixture();
  const events = [];
  let volumeInspection = 0;
  try {
    const result = await destroyDisposableApiOnlyRuntime(fixture.runtime, {
      resolveComposeRuntimeForCleanup: async () => {
        events.push("engine");
        return fixture.runtime.composeRuntime;
      },
      inspectDisposableVolumes: async () => {
        volumeInspection += 1;
        events.push(`volumes:${volumeInspection}`);
        return volumeInspection === 1 ? [`${fixture.runtime.project}_mysql_data`] : [];
      },
      runDisposableComposeDown: async (_runtime, args) => {
        events.push(`down:${args.join(" ")}`);
        return { code: 0 };
      }
    });
    assert.deepEqual(result, {
      project: fixture.runtime.project,
      runtimeRoot: fixture.runtime.root,
      cleanup: "complete"
    });
    assert.deepEqual(events, ["engine", "volumes:1", "down:down --volumes --remove-orphans", "volumes:2"]);
    await assert.rejects(lstat(fixture.runtime.root), { code: "ENOENT" });
    assert.equal((await lstat(fixture.runtime.retainedEvidence.path)).isFile(), true);
    assert.equal((await lstat(fixture.runtime.ownerLock.path)).isFile(), true);
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});

test("Task 4 cleanup rejects retained migration aliased and unowned disposable targets before down", async () => {
  const scenarios = [
    {
      mutate: (runtime) => ({ ...runtime, project: "shensi-api" }),
      error: /API_ONLY_DISPOSABLE_PROJECT_REQUIRED/u
    },
    {
      mutate: (runtime) => ({ ...runtime, project: "shensi-api-migration-0123456789ab" }),
      error: /API_ONLY_DISPOSABLE_PROJECT_REQUIRED/u
    },
    {
      mutate: (runtime) => ({ ...runtime, root: join(runtime.repositoryRoot, ".runtime", "api-only-empty", "fedcba987654") }),
      error: /API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID/u
    },
    {
      mutate: (runtime) => ({ ...runtime, root: join(runtime.repositoryRoot, "outside", "0123456789ab") }),
      error: /API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID/u
    },
    {
      mutate: (runtime) => ({ ...runtime, ownerLock: { ...runtime.ownerLock, nonce: "00".repeat(16) } }),
      error: /API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH/u
    }
  ];
  for (const scenario of scenarios) {
    const fixture = await disposableCleanupFixture();
    let down = 0;
    try {
      await assert.rejects(destroyDisposableApiOnlyRuntime(scenario.mutate(fixture.runtime), {
        resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
        inspectDisposableVolumes: async () => [`${fixture.runtime.project}_mysql_data`],
        runDisposableComposeDown: async () => { down += 1; }
      }), scenario.error);
      assert.equal(down, 0);
    } finally {
      await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
      await cleanup(fixture.root);
    }
  }

  const symlinked = await disposableCleanupFixture();
  let symlinkDown = 0;
  try {
    const outside = join(symlinked.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await rm(symlinked.runtime.root, { recursive: true });
    await symlink(outside, symlinked.runtime.root);
    await assert.rejects(destroyDisposableApiOnlyRuntime(symlinked.runtime, {
      resolveComposeRuntimeForCleanup: async () => symlinked.runtime.composeRuntime,
      inspectDisposableVolumes: async () => [`${symlinked.runtime.project}_mysql_data`],
      runDisposableComposeDown: async () => { symlinkDown += 1; }
    }), /API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID/u);
    assert.equal(symlinkDown, 0);
  } finally {
    await releaseApiOnlyOwnerLock(symlinked.runtime.ownerLock, symlinked.lockOptions).catch(() => undefined);
    await cleanup(symlinked.root);
  }
});

test("Task 4 cleanup rejects engine evidence and any non-project volume without effects", async () => {
  for (const scenario of [
    {
      options: (fixture) => ({
        resolveComposeRuntimeForCleanup: async () => ({ ...fixture.runtime.composeRuntime, daemon: { identity: "engine-drift" } }),
        inspectDisposableVolumes: async () => [`${fixture.runtime.project}_mysql_data`]
      }),
      error: /API_ONLY_DISPOSABLE_ENGINE_CHANGED/u
    },
    {
      options: (fixture) => ({
        resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
        inspectDisposableVolumes: async () => [`${fixture.runtime.project}_mysql_data`, "foreign_volume"]
      }),
      error: /API_ONLY_DISPOSABLE_VOLUME_INVALID/u
    },
    {
      options: (fixture) => ({
        resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
        inspectDisposableVolumes: async () => [`${fixture.runtime.project}-lookalike_mysql_data`]
      }),
      error: /API_ONLY_DISPOSABLE_VOLUME_INVALID/u
    }
  ]) {
    const fixture = await disposableCleanupFixture();
    let down = 0;
    try {
      await assert.rejects(destroyDisposableApiOnlyRuntime(fixture.runtime, {
        ...scenario.options(fixture),
        runDisposableComposeDown: async () => { down += 1; }
      }), scenario.error);
      assert.equal(down, 0);
      assert.equal((await lstat(fixture.runtime.root)).isDirectory(), true);
    } finally {
      await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
      await cleanup(fixture.root);
    }
  }
});

test("Task 4 default cleanup inventories only the exact disposable project and proves zero residue", async () => {
  const fixture = await disposableCleanupFixture();
  const calls = [];
  let running = true;
  const responseFor = (path) => {
    if (path.startsWith("/containers/json?")) return running ? [
      { Id: fixedHash("1"), Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.service": "mysql" } },
      { Id: fixedHash("2"), Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.service": "backend" } },
      { Id: fixedHash("3"), Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.service": "gateway" } }
    ] : [];
    if (path.startsWith("/networks?")) return running ? [{
      Id: fixedHash("4"),
      Name: `${fixture.runtime.project}_shensi_internal`,
      Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.network": "shensi_internal" }
    }, {
      Id: fixedHash("5"),
      Name: `${fixture.runtime.project}_shensi_egress`,
      Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.network": "shensi_egress" }
    }, {
      Id: fixedHash("6"),
      Name: `${fixture.runtime.project}_shensi_host`,
      Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.network": "shensi_host" }
    }] : [];
    if (path.startsWith("/volumes?")) return {
      Volumes: running ? [{
        Name: `${fixture.runtime.project}_mysql_data`,
        Labels: { "com.docker.compose.project": fixture.runtime.project, "com.docker.compose.volume": "mysql_data" }
      }] : null,
      Warnings: null
    };
    throw new Error(`unexpected path ${path}`);
  };
  try {
    const result = await destroyDisposableApiOnlyRuntime(fixture.runtime, {
      resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
      disposableEngineRequest(input, callback) {
        calls.push(input.path);
        const outgoing = new EventEmitter();
        outgoing.destroy = () => undefined;
        outgoing.end = () => queueMicrotask(() => {
          const bytes = Buffer.from(JSON.stringify(responseFor(input.path)), "utf8");
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = { "content-type": "application/json", "content-length": String(bytes.length) };
          response.complete = true;
          response.destroy = () => undefined;
          callback(response);
          response.emit("data", bytes);
          response.emit("end");
        });
        return outgoing;
      },
      runDisposableComposeDown: async () => {
        running = false;
        return { code: 0 };
      }
    });
    assert.equal(result.cleanup, "complete");
    assert.equal(calls.filter((path) => path.startsWith("/containers/json?")).length, 2);
    assert.equal(calls.filter((path) => path.startsWith("/networks?")).length, 2);
    assert.equal(calls.filter((path) => path.startsWith("/volumes?")).length, 2);
    assert.equal(calls.every((path) => decodeURIComponent(path).includes(`com.docker.compose.project=${fixture.runtime.project}`)), true);
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});

test("Task 4 default down reloads the promoted runtime instead of using the pre-create network claim", async () => {
  const fixture = await disposableCleanupFixture();
  let volumeRead = 0;
  let loaded = 0;
  const promoted = Object.freeze({
    ...fixture.runtime,
    networkClaim: Object.freeze({ existingNetwork: Object.freeze({ id: fixedHash("5"), name: `${fixture.runtime.project}_shensi_internal` }) })
  });
  try {
    await destroyDisposableApiOnlyRuntime(fixture.runtime, {
      resolveComposeRuntimeForCleanup: async () => fixture.runtime.composeRuntime,
      inspectDisposableVolumes: async () => (++volumeRead === 1 ? [`${fixture.runtime.project}_mysql_data`] : []),
      loadDisposableRuntimeForCleanup: async () => {
        loaded += 1;
        return promoted;
      },
      invokeDisposableComposeDown: async (selected, args) => {
        assert.equal(selected, promoted);
        assert.deepEqual(args, ["down", "--volumes", "--remove-orphans"]);
        return { code: 0 };
      }
    });
    assert.equal(loaded, 1);
    assert.equal(volumeRead, 2);
  } finally {
    await releaseApiOnlyOwnerLock(fixture.runtime.ownerLock, fixture.lockOptions).catch(() => undefined);
    await cleanup(fixture.root);
  }
});

async function disposableOrchestrationFixture() {
  const root = await fixture();
  const suffix = "abcdef123456";
  const project = `shensi-api-empty-${suffix}`;
  const runtimeRoot = join(root, ".runtime", "api-only-empty", suffix);
  const composeRuntime = fakeRuntime();
  const events = [];
  const handlers = new Map();
  const options = {
    identityRandomBytes: () => Buffer.from(suffix, "hex"),
    ownerLockRandomBytes: (size) => Buffer.alloc(size, 0x72),
    processInfo: () => ({ pid: 9292, startToken: "empty-verifier" }),
    isProcessCurrent: async () => true,
    now: () => "2026-09-04T10:00:00.000Z",
    registerSignalHandler(signal, handler) {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    async resolveDisposableComposeRuntime() {
      events.push("engine");
      return composeRuntime;
    },
    async isPortAvailable(port) {
      const lockPath = join(root, ".runtime", "api-only-empty", "disposable-5628-3312");
      assert.equal((await lstat(lockPath)).isFile(), true);
      events.push(`port:${port}`);
      return true;
    },
    async createBackendRuntimeManifest() {
      events.push("manifest");
      return { scope: "backend-runtime", rootHash: fixedHash("a") };
    },
    async prepareDisposableRuntime(_repositoryRoot, context) {
      events.push("prepare");
      assert.equal(context.identity.project, project);
      assert.equal(context.runtimeRoot, runtimeRoot);
      await mkdir(join(runtimeRoot, "evidence"), { recursive: true, mode: 0o700 });
      await chmod(join(root, ".runtime", "api-only-empty"), 0o700);
      await chmod(runtimeRoot, 0o700);
      await chmod(join(runtimeRoot, "evidence"), 0o700);
      const smokePath = join(runtimeRoot, "smoke-password");
      await writeFile(smokePath, "disposable-password-secret", { mode: 0o600 });
      return Object.freeze({
        root: runtimeRoot,
        project,
        ports: Object.freeze({ gateway: 5628, mysql: 3312 }),
        composeRuntime,
        runtimeNonce: fixedHash("9"),
        smokePath,
        evidenceDirectory: join(runtimeRoot, "evidence")
      });
    },
    async startDisposableRuntime(runtime) {
      events.push("start");
      assert.equal(runtime.project, project);
    },
    async readDisposableSmokePassword(runtime) {
      events.push("password");
      return readFile(runtime.smokePath, "utf8");
    },
    async runDisposableModuleSmoke(input) {
      events.push("smoke");
      assert.equal(input.mode, "register");
      assert.equal(input.account, `api_smoke_${suffix}`);
      assert.equal(input.password, "disposable-password-secret");
      return API_ONLY_SMOKE_ROUTES.map(({ module, method, path, shape }) => ({
        module,
        method,
        path: module === "advisor"
          ? "/api/v1/acquisition/advisor/today?currency=CNY&asOf=2026-09-04T10%3A00%3A00.000Z"
          : path,
        status: 200,
        shape
      }));
    },
    async verifyDisposableGateway(input) {
      events.push("gateway");
      assert.equal(input.origin, "http://127.0.0.1:5628");
      const safeId = "A".repeat(43);
      return {
        http: [
          { method: "GET", path: "/healthz", status: 200 },
          { method: "GET", path: "/api/health", status: 200 },
          { method: "GET", path: "/", status: 404 },
          { method: "GET", path: "/live-sessions/probe", status: 404 },
          { method: "GET", path: `/douyin-live/${safeId}`, status: 404 },
          { method: "GET", path: "/novnc/vnc.html", status: 404 }
        ],
        upgrades: [
          { method: "UPGRADE", path: "/live-sessions/probe", status: 404 },
          { method: "UPGRADE", path: `/douyin-live/${safeId}`, status: 404 }
        ]
      };
    },
    async inspectDisposableBuild(runtime, context) {
      events.push("build");
      assert.equal(runtime.project, project);
      assert.equal(context.sourceManifestHash, fixedHash("a"));
      return {
        imageIdDigest: `sha256:${fixedHash("b")}`,
        composeConfigHash: fixedHash("c")
      };
    },
    async destroyDisposableRuntime(runtime) {
      events.push("cleanup");
      assert.equal((await lstat(runtime.retainedEvidence.path)).isFile(), true);
      await rm(runtime.root, { recursive: true });
      return { project: runtime.project, runtimeRoot: runtime.root, cleanup: "complete" };
    }
  };
  return { root, suffix, project, runtimeRoot, composeRuntime, events, handlers, options };
}

test("Task 4 empty verification holds the shared lock through ports build smoke evidence and cleanup", async () => {
  const fixture = await disposableOrchestrationFixture();
  try {
    const result = await verifyEmptyApiOnlyRuntime(fixture.root, fixture.options);
    assert.deepEqual(fixture.events, [
      "engine", "port:5628", "port:3312", "manifest", "prepare", "start",
      "password", "smoke", "gateway", "build", "cleanup"
    ]);
    assert.equal(result.projectSuffix, fixture.suffix);
    assert.equal(result.modules.length, API_ONLY_SMOKE_ROUTES.length);
    assert.deepEqual(result.build, {
      sourceManifestHash: fixedHash("a"),
      imageIdDigest: `sha256:${fixedHash("b")}`,
      composeConfigHash: fixedHash("c"),
      builtAt: "2026-09-04T10:00:00.000Z"
    });
    assert.equal(result.cleanup.cleanup, "complete");
    assert.equal((await lstat(result.retainedEvidence.path)).mode & 0o777, 0o600);
    assert.equal(fixtureSha256(await readFile(result.retainedEvidence.path)), result.retainedEvidence.sha256);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "disposable-password-secret", `api_smoke_${fixture.suffix}`,
      "bearerToken", "csrfToken", "token"
    ]) assert.equal(serialized.includes(forbidden), false);
    await assert.rejects(lstat(fixture.runtimeRoot), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.root, ".runtime", "api-only-empty", "disposable-5628-3312")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("Task 4 empty verification always retains redacted failure evidence and cleans after start or smoke failure", async () => {
  for (const stage of ["start", "smoke"]) {
    const fixture = await disposableOrchestrationFixture();
    try {
      if (stage === "start") fixture.options.startDisposableRuntime = async () => {
        fixture.events.push("start");
        throw new Error("API_ONLY_GATEWAY_HEALTH_REQUEST_FAILED");
      };
      if (stage === "smoke") fixture.options.runDisposableModuleSmoke = async () => {
        fixture.events.push("smoke");
        throw new Error("module-password-token-secret");
      };
      let caught;
      try { await verifyEmptyApiOnlyRuntime(fixture.root, fixture.options); }
      catch (error) { caught = error; }
      assert.equal(caught?.message, `API_ONLY_EMPTY_VERIFICATION_FAILED:${stage}`);
      assert.equal(fixture.events.at(-1), "cleanup");
      assert.equal(fixture.events.filter((event) => event === "cleanup").length, 1);
      const retainedPath = join(fixture.root, ".runtime", "api-only", "evidence", "empty", `${fixture.suffix}.json`);
      const retained = await readFile(retainedPath, "utf8");
      assert.equal(retained.includes("password-token-secret"), false);
      assert.match(retained, /"result":"failed"/u);
      assert.equal(JSON.parse(retained).failureCode, stage === "start" ? "API_ONLY_GATEWAY_HEALTH_REQUEST_FAILED" : null);
      await assert.rejects(lstat(fixture.runtimeRoot), { code: "ENOENT" });
      await assert.rejects(lstat(join(fixture.root, ".runtime", "api-only-empty", "disposable-5628-3312")), { code: "ENOENT" });
    } finally { await cleanup(fixture.root); }
  }
});

test("Task 4 shared disposable lock rejects a second verifier before ports or runtime creation", async () => {
  const first = await disposableOrchestrationFixture();
  let releaseStart;
  let startEntered;
  const entered = new Promise((resolveEntered) => { startEntered = resolveEntered; });
  first.options.startDisposableRuntime = async () => {
    first.events.push("start");
    startEntered();
    await new Promise((resolveStart) => { releaseStart = resolveStart; });
  };
  const running = verifyEmptyApiOnlyRuntime(first.root, first.options);
  await entered;
  let secondPortChecks = 0;
  let secondPrepareCalls = 0;
  await assert.rejects(verifyEmptyApiOnlyRuntime(first.root, {
    ...first.options,
    identityRandomBytes: () => Buffer.from("fedcba654321", "hex"),
    isPortAvailable: async () => { secondPortChecks += 1; return true; },
    prepareDisposableRuntime: async () => { secondPrepareCalls += 1; throw new Error("must not prepare"); }
  }), /API_ONLY_OWNER_LOCK_HELD/u);
  assert.equal(secondPortChecks, 0);
  assert.equal(secondPrepareCalls, 0);
  releaseStart();
  await running;
  await cleanup(first.root);
});

test("Task 4 signal cleanup is idempotent and releases only after the disposable runtime is removed", async () => {
  const fixture = await disposableOrchestrationFixture();
  let rejectSmoke;
  let smokeEntered;
  const entered = new Promise((resolveEntered) => { smokeEntered = resolveEntered; });
  fixture.options.runDisposableModuleSmoke = async () => {
    fixture.events.push("smoke");
    smokeEntered();
    return new Promise((_resolveSmoke, reject) => { rejectSmoke = reject; });
  };
  try {
    const running = verifyEmptyApiOnlyRuntime(fixture.root, fixture.options);
    await entered;
    const firstSignal = fixture.handlers.get("SIGTERM")();
    const secondSignal = fixture.handlers.get("SIGINT")();
    await Promise.all([firstSignal, secondSignal]);
    assert.equal(fixture.events.filter((event) => event === "cleanup").length, 1);
    await assert.rejects(lstat(fixture.runtimeRoot), { code: "ENOENT" });
    rejectSmoke(new Error("signal-secret-must-not-leak"));
    await assert.rejects(running, /API_ONLY_EMPTY_VERIFICATION_FAILED:smoke/u);
    assert.equal(fixture.events.filter((event) => event === "cleanup").length, 1);
    await assert.rejects(lstat(join(fixture.root, ".runtime", "api-only-empty", "disposable-5628-3312")), { code: "ENOENT" });
  } finally { await cleanup(fixture.root); }
});

test("Task 4 stale disposable lock recovery writes an owner-only redacted audit before replacement", async () => {
  const fixture = await disposableOrchestrationFixture();
  const base = join(fixture.root, ".runtime", "api-only-empty");
  const staleOptions = {
    runtimeRoot: base,
    disposable: true,
    project: "shensi-api-empty-111111111111",
    processInfo: () => ({ pid: 1111, startToken: "stale-start-token-secret" }),
    randomBytes: (size) => Buffer.alloc(size, 0x31),
    engineIdentity: fixture.composeRuntime.daemon.identity,
    now: () => "2026-09-04T09:59:00.000Z"
  };
  const stale = await acquireApiOnlyOwnerLock(fixture.root, staleOptions);
  try {
    fixture.options.isProcessCurrent = async () => false;
    await verifyEmptyApiOnlyRuntime(fixture.root, fixture.options);
    const auditDirectory = join(fixture.root, ".runtime", "api-only", "evidence", "empty", "stale-locks");
    const names = await readdir(auditDirectory);
    assert.equal(names.length, 1);
    const auditPath = join(auditDirectory, names[0]);
    const audit = await readFile(auditPath, "utf8");
    assert.equal((await lstat(auditPath)).mode & 0o777, 0o600);
    assert.equal(audit.includes("stale-start-token-secret"), false);
    assert.equal(audit.includes(stale.nonce), false);
    assert.match(audit, /"processStartTokenSha256":"[a-f0-9]{64}"/u);
    assert.match(audit, /"nonceSha256":"[a-f0-9]{64}"/u);
  } finally {
    await rm(stale.path, { force: true });
    await cleanup(fixture.root);
  }
});

test("Task 4 default port probe is used before every disposable effect", async () => {
  const fixture = await disposableOrchestrationFixture();
  const ports = [];
  delete fixture.options.isPortAvailable;
  fixture.options.createDisposablePortServer = () => {
    const server = new EventEmitter();
    server.listen = (input, callback) => {
      ports.push(input.port);
      queueMicrotask(callback);
    };
    server.close = (callback) => queueMicrotask(() => callback());
    return server;
  };
  try {
    await verifyEmptyApiOnlyRuntime(fixture.root, fixture.options);
    assert.deepEqual(ports, [5628, 3312]);
    assert.equal(fixture.events.indexOf("prepare") > fixture.events.indexOf("engine"), true);
  } finally { await cleanup(fixture.root); }
});

test("Task 4 default build evidence revalidates the engine running image and resolved Compose bytes", async () => {
  const fixture = await disposableOrchestrationFixture();
  const containerId = fixedHash("d");
  const imageIdDigest = `sha256:${fixedHash("e")}`;
  const networkId = fixedHash("f");
  const networkName = `${fixture.project}_shensi_internal`;
  const composeBytes = "services:\n  backend:\n    image: shensi-disposable\n";
  delete fixture.options.inspectDisposableBuild;
  fixture.options.startDisposableRuntime = async (runtime) => {
    fixture.events.push("start");
    await writeFile(join(runtime.root, "status.json"), `${JSON.stringify({
      schema: "shensi.api-only.bootstrap-status",
      version: 1,
      project: fixture.project,
      origin: "http://127.0.0.1:5628",
      socketIdentity: fixture.composeRuntime.socket.identity,
      daemonIdentity: fixture.composeRuntime.daemon.identity,
      runtimeNonce: fixedHash("9"),
      network: { id: networkId, name: networkName, claimSha256: fixedHash("8") },
      backend: { containerId, imageIdDigest },
      gatewaySnapshotSha256: fixedHash("7"),
      createdAt: "2026-09-04T10:00:00.000Z"
    })}\n`, { mode: 0o600 });
  };
  fixture.options.revalidateDisposableComposeRuntime = async () => Object.freeze({
    ...fixture.composeRuntime,
    environment: Object.freeze({ HOME: "/different-authority-only-environment" })
  });
  fixture.options.readDisposableEngineJson = async (_runtime, path) => {
    if (path.startsWith("/containers/json?")) return [{
      Id: containerId,
      Labels: {
        "com.docker.compose.project": fixture.project,
        "com.docker.compose.service": "backend"
      }
    }];
    if (path === `/containers/${containerId}/json`) return {
      Id: containerId,
      Image: imageIdDigest,
      Config: { Labels: {
        "com.docker.compose.project": fixture.project,
        "com.docker.compose.service": "backend"
      } },
      State: { Status: "running" },
      NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId } } }
    };
    throw new Error(`unexpected engine path ${path}`);
  };
  fixture.options.runDisposableComposeConfig = async (runtime, args, context) => {
    assert.equal(runtime, fixture.composeRuntime);
    assert.deepEqual(args, ["-f", "deploy/compose.api-only.yaml", "--project-name", fixture.project, "config"]);
    assert.equal(context.cwd, fixture.root);
    return { code: 0, signal: null, output: composeBytes, truncated: false };
  };
  try {
    const result = await verifyEmptyApiOnlyRuntime(fixture.root, fixture.options);
    assert.deepEqual(result.build, {
      sourceManifestHash: fixedHash("a"),
      imageIdDigest,
      composeConfigHash: fixtureSha256(Buffer.from(composeBytes, "utf8")),
      builtAt: "2026-09-04T10:00:00.000Z"
    });
  } finally { await cleanup(fixture.root); }
});

test("Task 4 source wires verify-empty to the real disposable orchestrator", async () => {
  const source = await readFile(new URL("./api-only-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /"verify-empty":\s*async \(\) => \{\s*console\.log\(JSON\.stringify\(await verifyEmptyApiOnlyRuntime\(root\)\)\);\s*\}/u);
  assert.doesNotMatch(source, /"verify-empty":\s*unavailable\("verify-empty"\)/u);
});

function task5BuildEvidence() {
  return Object.freeze({
    sourceManifestHash: fixedHash("a"),
    imageIdDigest: `sha256:${fixedHash("b")}`,
    composeConfigHash: fixedHash("c"),
    builtAt: "2026-09-04T10:00:00.000Z"
  });
}

function task5TrialSnapshot() {
  return Object.freeze({
    mysql: Object.freeze({ name: "mysql", pid: 4100, state: "owned" }),
    writers: Object.freeze([
      Object.freeze({ name: "backend", pid: 4101, state: "owned" }),
      Object.freeze({ name: "frontend", pid: null, state: "absent" }),
      Object.freeze({ name: "gateway", pid: 4102, state: "owned" }),
      Object.freeze({ name: "sidecar", pid: null, state: "absent" }),
      Object.freeze({ name: "tunnel", pid: 4103, state: "owned" })
    ])
  });
}

function task5Prerequisites() {
  return Object.freeze({
    actionBridge: Object.freeze({
      version: "desktop-outreach-action-bridge-v1",
      sha256: fixedHash("d")
    }),
    featureParity: Object.freeze({
      tasks1To4Sha256: fixedHash("e"),
      task5HarnessSha256: fixedHash("f")
    })
  });
}

async function task5Root() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-task5-test-")));
  await mkdir(join(root, ".runtime", "api-only", "evidence", "empty"), {
    recursive: true,
    mode: 0o700
  });
  for (const directory of [
    join(root, ".runtime"),
    join(root, ".runtime", "api-only"),
    join(root, ".runtime", "api-only", "evidence"),
    join(root, ".runtime", "api-only", "evidence", "empty")
  ]) await chmod(directory, 0o700);
  return root;
}

test("Task 5 migration reader rotates one loopback-only SELECT account without exposing its password", async () => {
  const root = await task5Root();
  const calls = [];
  let connectionInput;
  const connection = {
    async execute(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql === "SHOW GRANTS FOR 'shensi_migration_reader'@'127.0.0.1'") {
        return [[{
          grant: "GRANT SELECT, SHOW VIEW, TRIGGER ON `shensi_trial`.* TO `shensi_migration_reader`@`127.0.0.1`"
        }]];
      }
      return [[]];
    },
    async end() { calls.push({ sql: "<end>", parameters: [] }); }
  };
  try {
    const result = await provisionTrialMigrationReader({
      repositoryRoot: root,
      adminDatabaseUrl: "mysql://root:admin-secret@127.0.0.1:3310/mysql",
      randomBytes: () => Buffer.alloc(48, 7),
      createConnection: async (input) => { connectionInput = input; return connection; }
    });
    const password = Buffer.alloc(48, 7).toString("base64url");
    assert.equal(connectionInput.password, "admin-secret");
    assert.equal(result.user, "shensi_migration_reader");
    assert.equal(result.host, "127.0.0.1");
    assert.deepEqual(result.privileges, ["SELECT", "SHOW VIEW", "TRIGGER"]);
    assert.equal(Object.values(result).includes(password), false);
    assert.equal(await readFile(result.secretFile, "utf8"), password);
    assert.equal((await lstat(result.secretFile)).mode & 0o777, 0o600);
    assert.equal(calls.some(({ sql }) => sql.includes(password) || sql.includes("admin-secret")), false);
    assert.equal(calls.filter(({ parameters }) => parameters.includes(password)).length, 1);
    assert.deepEqual(calls.slice(0, 4).map(({ sql }) => sql), [
      "CREATE USER IF NOT EXISTS 'shensi_migration_reader'@'127.0.0.1'",
      "ALTER USER 'shensi_migration_reader'@'127.0.0.1' IDENTIFIED BY ?",
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'shensi_migration_reader'@'127.0.0.1'",
      "GRANT SELECT, SHOW VIEW, TRIGGER ON `shensi_trial`.* TO 'shensi_migration_reader'@'127.0.0.1'"
    ]);
  } finally { await cleanup(root); }
});

test("Task 5 migration reader rejects every privilege outside the reviewed read-only grant", async () => {
  const root = await task5Root();
  let wroteSecret = false;
  try {
    await assert.rejects(provisionTrialMigrationReader({
      repositoryRoot: root,
      adminDatabaseUrl: "mysql://root:admin-secret@127.0.0.1:3310/mysql",
      randomBytes: () => Buffer.alloc(48, 8),
      writeSecret: async () => { wroteSecret = true; },
      createConnection: async () => ({
        async execute(sql) {
          if (sql.startsWith("SHOW GRANTS")) return [[
            { grant: "GRANT SELECT, SHOW VIEW, TRIGGER ON `shensi_trial`.* TO `shensi_migration_reader`@`127.0.0.1`" },
            { grant: "GRANT DELETE ON `shensi_trial`.* TO `shensi_migration_reader`@`127.0.0.1`" }
          ]];
          return [[]];
        },
        async end() {}
      })
    }), /API_ONLY_MIGRATION_READER_GRANT_INVALID/u);
    assert.equal(wroteSecret, false);
  } finally { await cleanup(root); }
});

test("Task 5 preflight binds current build, Trial ownership, empty evidence, queues and prerequisite hashes", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  const emptyDescriptor = Object.freeze({ basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") });
  let provisioned = 0;
  try {
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: { inspect: async () => task5TrialSnapshot() },
      readEmptyVerificationEvidence: async () => Object.freeze({
        descriptor: emptyDescriptor,
        report: Object.freeze({ result: "passed", build })
      }),
      captureCurrentBuild: async () => build,
      readPrerequisiteEvidence: async () => task5Prerequisites(),
      queryActionInventory: async () => Object.freeze({
        legacyServerActions: Object.freeze({ count: 0, ids: Object.freeze([]) }),
        desktopNonTerminalActions: Object.freeze({ count: 0, ids: Object.freeze([]) }),
        desktopInFlightWrites: Object.freeze({ count: 0, ids: Object.freeze([]) })
      }),
      checkMigrationPorts: async () => Object.freeze({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
      provisionMigrationReader: async () => { provisioned += 1; return { secretFile: join(root, "reader") }; },
      gitCommit: async () => "a".repeat(40),
      randomBytes: () => Buffer.from("0123456789ab", "hex"),
      now: () => "2026-09-04T12:00:00.000Z"
    });
    assert.equal(provisioned, 1);
    assert.equal(result.ready, true);
    assert.equal(result.authorized, false);
    assert.equal(result.attemptId, "0123456789ab");
    assert.equal(result.project, "shensi-api-migration-0123456789ab");
    assert.deepEqual(result.source, { database: "shensi_trial", host: "127.0.0.1", port: 3310 });
    assert.deepEqual(result.target, { database: "shensi", host: "127.0.0.1", port: 3311 });
    assert.deepEqual(result.writers.map(({ name, pid, state }) => ({ name, pid, state })), task5TrialSnapshot().writers);
    assert.equal(JSON.stringify(result).includes("password"), false);
    const journalPath = join(root, ".runtime", "api-only", "migration-state.json");
    const journalText = await readFile(journalPath, "utf8");
    const journal = JSON.parse(journalText);
    assert.equal(journal.state, "prepared");
    assert.equal(journal.activeRuntime, "trial");
    assert.equal((await lstat(journalPath)).mode & 0o777, 0o600);
    assert.equal(journalText, `${JSON.stringify(journal)}\n`);
  } finally { await cleanup(root); }
});

test("Task 5 preflight reports action/prerequisite blockers before reader or journal mutation", async () => {
  const root = await task5Root();
  let provisioned = 0;
  const build = task5BuildEvidence();
  try {
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: { inspect: async () => task5TrialSnapshot() },
      readEmptyVerificationEvidence: async () => ({ descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") }, report: { result: "passed", build } }),
      captureCurrentBuild: async () => build,
      readPrerequisiteEvidence: async () => null,
      queryActionInventory: async () => ({
        legacyServerActions: { count: 1, ids: ["action-stable-1"] },
        desktopNonTerminalActions: { count: 0, ids: [] },
        desktopInFlightWrites: { count: 0, ids: [] }
      }),
      checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
      provisionMigrationReader: async () => { provisioned += 1; },
      gitCommit: async () => "a".repeat(40)
    });
    assert.equal(result.ready, false);
    assert.equal(result.authorized, false);
    assert.deepEqual(result.blockers, ["DESKTOP_ACTION_BRIDGE_EVIDENCE_MISSING", "LEGACY_SERVER_ACTIONS_PRESENT"]);
    assert.equal(provisioned, 0);
    await assert.rejects(readFile(join(root, ".runtime", "api-only", "migration-state.json")), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("Task 5 preflight reads the latest real empty-verification evidence from disk", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  const evidence = {
    schema: "shensi.api-only.empty-verification",
    version: 1,
    result: "passed",
    verifiedAt: "2026-09-04T10:00:00.000Z",
    build
  };
  const evidenceText = `${JSON.stringify(evidence)}\n`;
  const evidenceSha256 = fixtureSha256(Buffer.from(evidenceText, "utf8"));
  try {
    await writeFile(
      join(root, ".runtime", "api-only", "evidence", "empty", "0123456789ab.json"),
      evidenceText,
      { mode: 0o600 }
    );
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: { inspect: async () => task5TrialSnapshot() },
      readPrerequisiteEvidence: async () => null,
      queryActionInventory: async () => ({
        legacyServerActions: { count: 0, ids: [] },
        desktopNonTerminalActions: { count: 0, ids: [] },
        desktopInFlightWrites: { count: 0, ids: [] }
      }),
      checkMigrationPorts: async () => ({
        targetMysql3311: "free", gateway5608: "owned_trial_writer"
      })
    });
    assert.equal(result.ready, false);
    assert.equal(result.emptyVerificationEvidenceSha256, evidenceSha256);
    assert.deepEqual(result.blockers, ["DESKTOP_ACTION_BRIDGE_EVIDENCE_MISSING"]);
  } finally { await cleanup(root); }
});

test("Task 5 preflight binds the authenticated Trial MySQL identity without secrets", async () => {
  const root = await task5Root();
  const identity = {
    authenticatedUser: "shensi_trial_app@127.0.0.1",
    database: "shensi_trial",
    port: 3310,
    datadir: "retained-trial",
    serverIdentitySha256: fixedHash("9"),
    sql: "ok"
  };
  const snapshot = task5TrialSnapshot();
  try {
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: {
        inspect: async () => ({
          ...snapshot,
          mysql: { ...snapshot.mysql, identity }
        })
      },
      readPrerequisiteEvidence: async () => null,
      readEmptyVerificationEvidence: async () => null,
      queryActionInventory: async () => ({
        legacyServerActions: { count: 0, ids: [] },
        desktopNonTerminalActions: { count: 0, ids: [] },
        desktopInFlightWrites: { count: 0, ids: [] }
      }),
      checkMigrationPorts: async () => ({
        targetMysql3311: "free", gateway5608: "owned_trial_writer"
      })
    });
    assert.deepEqual(result.mysql.identity, identity);
    assert.equal(JSON.stringify(result).includes("password"), false);
  } finally { await cleanup(root); }
});

test("Task 5 default preflight port probe normalizes free ports and an owned Trial gateway", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  const probed = [];
  try {
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: { inspect: async () => task5TrialSnapshot() },
      readEmptyVerificationEvidence: async () => ({
        descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
        report: { result: "passed", build }
      }),
      captureCurrentBuild: async () => build,
      readPrerequisiteEvidence: async () => task5Prerequisites(),
      queryActionInventory: async () => ({
        legacyServerActions: { count: 0, ids: [] },
        desktopNonTerminalActions: { count: 0, ids: [] },
        desktopInFlightWrites: { count: 0, ids: [] }
      }),
      isMigrationPortAvailable: async (port) => {
        probed.push(port);
        return port === 3311;
      },
      provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
      gitCommit: async () => "a".repeat(40),
      randomBytes: () => Buffer.from("0123456789ab", "hex"),
      now: () => "2026-09-04T12:00:00.000Z"
    });
    assert.equal(result.ready, true);
    assert.deepEqual(probed, [3311, 5608]);
  } finally { await cleanup(root); }
});

test("Task 5 preflight classifies server, desktop, and in-flight actions from stable fields", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  const sql = [];
  const connection = {
    async execute(statement) {
      sql.push(statement);
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{ column_name: "execution_target" }]];
      }
      if (statement.includes("COUNT(*)")) return [[
        { execution_target: "server", status: "queued", action_count: 1 },
        { execution_target: "desktop", status: "queued", action_count: 1 },
        { execution_target: "desktop", status: "executing", action_count: 1 }
      ]];
      if (statement.includes("execution_target='server'")) {
        return [[{ id: "server-1", status: "queued" }]];
      }
      return [[
        { id: "desktop-q", status: "queued" },
        { id: "desktop-x", status: "executing" }
      ]];
    },
    async end() {}
  };
  try {
    const result = await prepareTrialToApiOnlyMigration(root, {
      trialAdapter: { inspect: async () => task5TrialSnapshot() },
      readEmptyVerificationEvidence: async () => ({
        descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
        report: { result: "passed", build }
      }),
      readPrerequisiteEvidence: async () => task5Prerequisites(),
      readTrialDatabaseUrl: async () => "mysql://reader:redacted@127.0.0.1:3310/shensi_trial",
      createActionInventoryConnection: async () => connection,
      checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" })
    });
    assert.deepEqual(result.legacyServerActions, { count: 1, ids: ["server-1"] });
    assert.deepEqual(result.desktopNonTerminalActions, {
      count: 2, ids: ["desktop-q", "desktop-x"]
    });
    assert.deepEqual(result.desktopInFlightWrites, { count: 1, ids: ["desktop-x"] });
    assert.deepEqual(result.blockers, [
      "LEGACY_SERVER_ACTIONS_PRESENT",
      "DESKTOP_NON_TERMINAL_ACTIONS_PRESENT",
      "DESKTOP_IN_FLIGHT_WRITES_PRESENT"
    ]);
    assert.equal(sql.length, 4);
    assert.equal(sql.some((statement) => /comment|message|content/iu.test(statement)), false);
  } finally { await cleanup(root); }
});

test("Task 5 freeze stops only owned Trial writers, keeps mysql, proves ports, and commits source_frozen", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  const snapshot = task5TrialSnapshot();
  const frozen = [];
  const prepareOptions = {
    trialAdapter: {
      inspect: async () => snapshot,
      freezeWriters: async (input) => { frozen.push(...input.liveWriters.map(({ name }) => name)); return { stopped: frozen }; }
    },
    readEmptyVerificationEvidence: async () => ({ descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") }, report: { result: "passed", build } }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => task5Prerequisites(),
    queryActionInventory: async () => ({ legacyServerActions: { count: 0, ids: [] }, desktopNonTerminalActions: { count: 0, ids: [] }, desktopInFlightWrites: { count: 0, ids: [] } }),
    checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
    provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    now: () => "2026-09-04T12:00:00.000Z"
  };
  try {
    await prepareTrialToApiOnlyMigration(root, prepareOptions);
    const result = await freezeTrialWriters(root, {
      ...prepareOptions,
      authorized: true,
      verifyReleasedWriterPorts: async () => true,
      now: () => "2026-09-04T12:01:00.000Z"
    });
    assert.deepEqual(frozen, ["backend", "gateway", "tunnel"]);
    assert.equal(result.state, "source_frozen");
    assert.deepEqual(result.mysql, snapshot.mysql);
    const journal = JSON.parse(await readFile(join(root, ".runtime", "api-only", "migration-state.json"), "utf8"));
    assert.equal(journal.state, "source_frozen");
    assert.equal(journal.activeRuntime, null);
  } finally { await cleanup(root); }
});

test("Task 5 recovers Trial when writer freeze mutates processes before reporting failure", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  let restartCalls = 0;
  let migrationCalls = 0;
  let clock = 0;
  const options = {
    authorized: true,
    trialAdapter: {
      inspect: async () => task5TrialSnapshot(),
      freezeWriters: async () => { throw new Error("FREEZE_RESULT_LOST"); },
      restart: async () => { restartCalls += 1; return { root: join(root, ".runtime", "real-trial") }; },
      verifyRecovered: async () => ({ ok: true })
    },
    readEmptyVerificationEvidence: async () => ({
      descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
      report: { result: "passed", build }
    }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => task5Prerequisites(),
    queryActionInventory: async () => ({
      legacyServerActions: { count: 0, ids: [] },
      desktopNonTerminalActions: { count: 0, ids: [] },
      desktopInFlightWrites: { count: 0, ids: [] }
    }),
    checkMigrationPorts: async () => ({
      targetMysql3311: "free", gateway5608: "owned_trial_writer"
    }),
    provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    now: () => new Date(Date.UTC(2026, 8, 4, 15, 0, clock++)).toISOString(),
    runMigrationProcess: async () => { migrationCalls += 1; },
    upgradeActionBridge: async () => ({ ok: true }),
    stopTargetProject: async () => undefined
  };
  try {
    await assert.rejects(
      runTrialToApiOnlyMigration(root, options),
      /API_ONLY_MIGRATION_FAILED_RECOVERED:API_ONLY_MIGRATION_FAILED/u
    );
    assert.equal(restartCalls, 1);
    assert.equal(migrationCalls, 0);
    const journal = JSON.parse(await readFile(
      join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
    ));
    assert.equal(journal.state, "failed_recovered");
    assert.equal(journal.activeRuntime, "trial");
    await assert.rejects(
      readFile(join(root, ".runtime", "api-only", "migration-freeze-intent.json")),
      { code: "ENOENT" }
    );
  } finally { await cleanup(root); }
});

test("Task 5 resumes recovery from a persisted freeze intent after process interruption", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  let restartCalls = 0;
  let clock = 0;
  const shared = {
    readEmptyVerificationEvidence: async () => ({
      descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
      report: { result: "passed", build }
    }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => task5Prerequisites(),
    queryActionInventory: async () => ({
      legacyServerActions: { count: 0, ids: [] },
      desktopNonTerminalActions: { count: 0, ids: [] },
      desktopInFlightWrites: { count: 0, ids: [] }
    }),
    checkMigrationPorts: async () => ({
      targetMysql3311: "free", gateway5608: "owned_trial_writer"
    }),
    provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    now: () => new Date(Date.UTC(2026, 8, 4, 16, 0, clock++)).toISOString()
  };
  try {
    await prepareTrialToApiOnlyMigration(root, {
      ...shared,
      trialAdapter: { inspect: async () => task5TrialSnapshot() }
    });
    await assert.rejects(freezeTrialWriters(root, {
      ...shared,
      authorized: true,
      trialAdapter: {
        inspect: async () => task5TrialSnapshot(),
        freezeWriters: async () => { throw new Error("PROCESS_INTERRUPTED"); }
      }
    }), /PROCESS_INTERRUPTED/u);
    const interrupted = JSON.parse(await readFile(
      join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
    ));
    assert.equal(interrupted.state, "prepared");
    assert.equal(JSON.parse(await readFile(
      join(root, ".runtime", "api-only", "migration-freeze-intent.json"), "utf8"
    )).attemptId, "0123456789ab");

    const recovered = await runTrialToApiOnlyMigration(root, {
      ...shared,
      trialAdapter: {
        restart: async () => { restartCalls += 1; return { root }; },
        verifyRecovered: async () => ({ ok: true })
      },
      stopTargetProject: async () => undefined
    });
    assert.equal(recovered.state, "failed_recovered");
    assert.equal(restartCalls, 1);
    const journal = JSON.parse(await readFile(
      join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
    ));
    assert.equal(journal.state, "failed_recovered");
    assert.equal(journal.activeRuntime, "trial");
    await assert.rejects(
      readFile(join(root, ".runtime", "api-only", "migration-freeze-intent.json")),
      { code: "ENOENT" }
    );
  } finally { await cleanup(root); }
});

test("Task 5 migration run is authorization-gated before freeze or child-process effects", async () => {
  const root = await task5Root();
  let effects = 0;
  try {
    await assert.rejects(runTrialToApiOnlyMigration(root, {
      authorized: false,
      trialAdapter: { inspect: async () => { effects += 1; } },
      runMigrationProcess: async () => { effects += 1; }
    }), /API_ONLY_MIGRATION_AUTHORIZATION_REQUIRED/u);
    assert.equal(effects, 0);
  } finally { await cleanup(root); }
});

test("Task 5 migration run validates every destructive dependency before preflight or freeze", async () => {
  const cases = [
    {
      omit: "upgradeActionBridge",
      code: /API_ONLY_MIGRATION_ACTION_BRIDGE_UPGRADER_REQUIRED/u
    },
    {
      omit: "runMigrationProcess",
      code: /API_ONLY_MIGRATION_PROCESS_ADAPTER_REQUIRED/u
    },
    {
      omit: "stopTargetProject",
      code: /API_ONLY_MIGRATION_TARGET_STOP_ADAPTER_REQUIRED/u
    }
  ];
  for (const { omit, code } of cases) {
    const root = await task5Root();
    let effects = 0;
    const options = {
      authorized: true,
      trialAdapter: {
        inspect: async () => { effects += 1; return task5TrialSnapshot(); },
        freezeWriters: async () => { effects += 1; }
      },
      upgradeActionBridge: async () => { effects += 1; },
      runMigrationProcess: async () => { effects += 1; },
      stopTargetProject: async () => { effects += 1; }
    };
    delete options[omit];
    try {
      await assert.rejects(runTrialToApiOnlyMigration(root, options), code);
      assert.equal(effects, 0, omit);
    } finally { await cleanup(root); }
  }
});

test("Task 5 owner lock rejects an overlapping supervisor before Trial or reader effects", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  let releaseFirst;
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let inspections = 0;
  let provisions = 0;
  const options = {
    trialAdapter: { inspect: async () => { inspections += 1; return task5TrialSnapshot(); } },
    readEmptyVerificationEvidence: async () => ({
      descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
      report: { result: "passed", build }
    }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => {
      firstEntered();
      await blocked;
      return task5Prerequisites();
    },
    queryActionInventory: async () => ({
      legacyServerActions: { count: 0, ids: [] },
      desktopNonTerminalActions: { count: 0, ids: [] },
      desktopInFlightWrites: { count: 0, ids: [] }
    }),
    checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
    provisionMigrationReader: async () => { provisions += 1; },
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    ownerLockRandomBytes: () => Buffer.alloc(16, 9),
    processInfo: async () => ({ pid: 4242, startToken: "task5-owner-start" }),
    readProcessStartToken: async () => "task5-owner-start",
    engineIdentity: "task5-test-engine",
    now: () => "2026-09-04T12:00:00.000Z"
  };
  try {
    const first = prepareTrialToApiOnlyMigration(root, options);
    await entered;
    await assert.rejects(prepareTrialToApiOnlyMigration(root, options), /API_ONLY_OWNER_LOCK_HELD/u);
    assert.equal(inspections, 1);
    assert.equal(provisions, 0);
    releaseFirst();
    const result = await first;
    assert.equal(result.ready, true);
    assert.equal(provisions, 1);
  } finally {
    releaseFirst?.();
    await cleanup(root);
  }
});

test("Task 5 API core has no real-trial import and CLI migration commands are live", async () => {
  const source = await readFile(new URL("./api-only-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*real-trial-/u);
  assert.doesNotMatch(source, /"migration-preflight":\s*unavailable/u);
  assert.doesNotMatch(source, /"migration-run":\s*unavailable/u);
  assert.match(source, /createTask5MigrationRunner/u);
  assert.match(source, /runMigrationProcess:\s*migrationRunner\.runMigrationProcess/u);
  assert.match(source, /stopTargetProject:\s*migrationRunner\.stopTargetProject/u);
});

test("Task 5 recovery checkpoints never rerun migration or expose Trial before verified recovery", async () => {
  const crashStages = [
    "after-recovery-pending-entry",
    "after-target-stop",
    "before-trial-restart",
    "after-trial-mysql-restart",
    "after-full-trial-start",
    "after-health-login-verification",
    "before-final-recovered-state-commit",
    "after-final-recovered-state-commit"
  ];
  for (const crashStage of crashStages) {
    const root = await task5Root();
    const build = task5BuildEvidence();
    let migrationCalls = 0;
    let restartCalls = 0;
    let crashEnabled = true;
    let clock = 0;
    const checkpoint = async (stage) => {
      if (crashEnabled && stage === crashStage) throw new Error(`INJECTED_CRASH:${stage}`);
    };
    const trialAdapter = {
      inspect: async () => task5TrialSnapshot(),
      freezeWriters: async () => ({ stopped: ["backend", "gateway", "tunnel"] }),
      restart: async ({ onStage } = {}) => {
        restartCalls += 1;
        await onStage?.("after-trial-mysql-restart");
        return { root: join(root, ".runtime", "real-trial") };
      },
      verifyRecovered: async () => ({ ok: true })
    };
    const options = {
      authorized: true,
      trialAdapter,
      readEmptyVerificationEvidence: async () => ({
        descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
        report: { result: "passed", build }
      }),
      captureCurrentBuild: async () => build,
      readPrerequisiteEvidence: async () => task5Prerequisites(),
      queryActionInventory: async () => ({
        legacyServerActions: { count: 0, ids: [] },
        desktopNonTerminalActions: { count: 0, ids: [] },
        desktopInFlightWrites: { count: 0, ids: [] }
      }),
      checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
      verifyReleasedWriterPorts: async () => true,
      provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
      gitCommit: async () => "a".repeat(40),
      randomBytes: () => Buffer.from("0123456789ab", "hex"),
      now: () => new Date(Date.UTC(2026, 8, 4, 12, 0, clock++)).toISOString(),
      runMigrationProcess: async () => {
        migrationCalls += 1;
        throw new Error("DATA_VERIFICATION_FAILED:TABLE_COUNT_MISMATCH,STABLE_ID_MISMATCH");
      },
      upgradeActionBridge: async () => { throw new Error("UPGRADE_MUST_NOT_RUN"); },
      stopTargetProject: async () => undefined,
      recoveryCheckpoint: checkpoint
    };
    try {
      await assert.rejects(runTrialToApiOnlyMigration(root, options), /INJECTED_CRASH|API_ONLY_MIGRATION_FAILED_RECOVERED/u);
      const afterCrash = JSON.parse(await readFile(
        join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
      ));
      if (crashStage === "after-final-recovered-state-commit") {
        assert.equal(afterCrash.state, "failed_recovered", crashStage);
        assert.equal(afterCrash.activeRuntime, "trial", crashStage);
        assert.match(afterCrash.attemptSummaries.at(-1).recoveryEvidence.sha256, /^[a-f0-9]{64}$/u);
      } else {
        assert.equal(afterCrash.state, "recovery_pending", crashStage);
        assert.equal(afterCrash.activeRuntime, null, crashStage);
        assert.equal(afterCrash.attemptSummaries.at(-1).recoveryEvidence, null, crashStage);
      }

      if (crashStage === "after-recovery-pending-entry") {
        const restartsBeforeMissingStopper = restartCalls;
        await assert.rejects(
          runTrialToApiOnlyMigration(root, { ...options, stopTargetProject: undefined }),
          /API_ONLY_MIGRATION_TARGET_STOP_ADAPTER_REQUIRED/u
        );
        assert.equal(restartCalls, restartsBeforeMissingStopper, crashStage);
      }

      crashEnabled = false;
      const recovered = await runTrialToApiOnlyMigration(root, options);
      assert.equal(recovered.state, "failed_recovered", crashStage);
      assert.equal(migrationCalls, 1, crashStage);
      const finalJournal = JSON.parse(await readFile(
        join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
      ));
      assert.equal(finalJournal.activeAttemptId, "0123456789ab", crashStage);
      assert.equal(finalJournal.state, "failed_recovered", crashStage);
      assert.equal(finalJournal.activeRuntime, "trial", crashStage);
      const attemptCount = new Set(finalJournal.attemptSummaries.map(({ attemptId }) => attemptId)).size;
      assert.equal(attemptCount, 1, crashStage);

      const repeated = await runTrialToApiOnlyMigration(root, options);
      assert.equal(repeated.state, "failed_recovered", crashStage);
      assert.equal(migrationCalls, 1, crashStage);
      assert.equal(new Set((JSON.parse(await readFile(
        join(root, ".runtime", "api-only", "migration-state.json"), "utf8"
      ))).attemptSummaries.map(({ attemptId }) => attemptId)).size, 1, crashStage);
      assert.ok(restartCalls >= (crashStage === "after-final-recovered-state-commit" ? 1 : 1), crashStage);
    } finally { await cleanup(root); }
  }
});

test("Task 5 reentry from source_frozen recovers the same attempt without rerunning migration", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  let migrationCalls = 0;
  let upgradeCalls = 0;
  let clock = 0;
  const trialAdapter = {
    inspect: async () => task5TrialSnapshot(),
    freezeWriters: async () => ({ stopped: ["backend", "gateway", "tunnel"] }),
    restart: async () => ({ root: join(root, ".runtime", "real-trial") }),
    verifyRecovered: async () => ({ ok: true })
  };
  const options = {
    authorized: true,
    trialAdapter,
    readEmptyVerificationEvidence: async () => ({
      descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
      report: { result: "passed", build }
    }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => task5Prerequisites(),
    queryActionInventory: async () => ({
      legacyServerActions: { count: 0, ids: [] },
      desktopNonTerminalActions: { count: 0, ids: [] },
      desktopInFlightWrites: { count: 0, ids: [] }
    }),
    checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
    verifyReleasedWriterPorts: async () => true,
    provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    now: () => new Date(Date.UTC(2026, 8, 4, 13, 0, clock++)).toISOString(),
    runMigrationProcess: async () => { migrationCalls += 1; },
    upgradeActionBridge: async () => { upgradeCalls += 1; },
    stopTargetProject: async () => undefined
  };
  try {
    await prepareTrialToApiOnlyMigration(root, options);
    await freezeTrialWriters(root, options);
    const frozen = JSON.parse(await readFile(join(root, ".runtime", "api-only", "migration-state.json"), "utf8"));
    assert.equal(frozen.state, "source_frozen");

    const result = await runTrialToApiOnlyMigration(root, options);
    assert.equal(result.state, "failed_recovered");
    assert.equal(result.attemptId, "0123456789ab");
    assert.equal(migrationCalls, 0);
    assert.equal(upgradeCalls, 0);
    const recovered = JSON.parse(await readFile(join(root, ".runtime", "api-only", "migration-state.json"), "utf8"));
    assert.deepEqual(recovered.attemptSummaries.map(({ state }) => state), [
      "prepared", "source_frozen", "recovery_pending", "failed_recovered"
    ]);
  } finally { await cleanup(root); }
});

test("Task 5 commits target_restored only for exact encrypted migration and bridge descriptors", async () => {
  const root = await task5Root();
  const build = task5BuildEvidence();
  let clock = 0;
  let migrationInput;
  const options = {
    authorized: true,
    trialAdapter: {
      inspect: async () => task5TrialSnapshot(),
      freezeWriters: async () => ({ stopped: ["backend", "gateway", "tunnel"] }),
      restart: async () => { throw new Error("RECOVERY_MUST_NOT_RUN"); },
      verifyRecovered: async () => { throw new Error("RECOVERY_MUST_NOT_RUN"); }
    },
    readEmptyVerificationEvidence: async () => ({
      descriptor: { basename: `${fixedHash("1")}.json`, sha256: fixedHash("1") },
      report: { result: "passed", build }
    }),
    captureCurrentBuild: async () => build,
    readPrerequisiteEvidence: async () => task5Prerequisites(),
    queryActionInventory: async () => ({
      legacyServerActions: { count: 0, ids: [] },
      desktopNonTerminalActions: { count: 0, ids: [] },
      desktopInFlightWrites: { count: 0, ids: [] }
    }),
    checkMigrationPorts: async () => ({ targetMysql3311: "free", gateway5608: "owned_trial_writer" }),
    verifyReleasedWriterPorts: async () => true,
    provisionMigrationReader: async () => ({ secretFile: join(root, "reader") }),
    gitCommit: async () => "a".repeat(40),
    randomBytes: () => Buffer.from("0123456789ab", "hex"),
    now: () => new Date(Date.UTC(2026, 8, 4, 14, 0, clock++)).toISOString(),
    runMigrationProcess: async (input) => {
      migrationInput = input;
      return {
        ok: true,
        manifest: { basename: "2026-09-04-shensi.sql.enc.migration-manifest.json", sha256: fixedHash("2") },
        encryptedBackup: { basename: "2026-09-04-shensi.sql.enc", sha256: fixedHash("3") },
        verification: { basename: "2026-09-04-shensi-verification.json", sha256: fixedHash("4") }
      };
    },
    upgradeActionBridge: async () => ({
      version: "desktop-outreach-action-bridge-v1",
      sha256: fixedHash("5"),
      preservationReport: { basename: "desktop-action-bridge-preservation.json", sha256: fixedHash("6") }
    }),
    stopTargetProject: async () => undefined
  };
  try {
    const result = await runTrialToApiOnlyMigration(root, options);
    assert.equal(result.state, "target_restored");
    assert.equal(result.attemptId, "0123456789ab");
    assert.deepEqual(migrationInput, {
      attemptId: "0123456789ab",
      project: "shensi-api-migration-0123456789ab",
      source: { database: "shensi_trial", host: "127.0.0.1", port: 3310 },
      target: { database: "shensi", host: "127.0.0.1", port: 3311 },
      sourceCommit: "a".repeat(40)
    });
    const journal = JSON.parse(await readFile(join(root, ".runtime", "api-only", "migration-state.json"), "utf8"));
    assert.deepEqual(journal.attemptSummaries.map(({ state }) => state), [
      "prepared", "source_frozen", "target_restored"
    ]);
    assert.equal(journal.activeRuntime, null);
  } finally { await cleanup(root); }
});
