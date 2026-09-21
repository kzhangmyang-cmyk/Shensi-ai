import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access as nativeAccess, chmod, link, lstat, mkdir, mkdtemp, open as nativeOpen, readFile, readlink as nativeReadlink, realpath as nativeRealpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import * as authorityModule from "./lib/api-only-authority.mjs";
import {
  allocateApiOnlyNetwork, assertRenderOnlyComposeArgs, assertRuntimeSelection,
  composeEnvironmentForNetworkClaim, createApiOnlyNetworkInspectionBridge,
  discoverComposeRuntime, doctorSummary,
  revalidateApiOnlyNetworkClaim, runResolvedCompose, runtimeSelectionPath,
  validateApiOnlyComposeInputs, verifyApiOnlyNetworkAfterCreate, writeRuntimeSelection
} from "./container-runtime.mjs";

const UID = 501;
const HASH_DIR = "a".repeat(64);
const NONCE = "b".repeat(64);
let nextIno = 10;

function entry(type, { uid = UID, mode, target, bytes = "", dev = 1, ino = nextIno++, nlink = 1 } = {}) {
  return { type, uid, mode: mode ?? (type === "dir" ? 0o755 : type === "socket" ? 0o600 : 0o644), target, bytes: Buffer.from(bytes), dev, ino, nlink };
}
function statFor(node) {
  return { uid: node.uid, gid: node.uid, mode: node.mode, dev: node.dev, ino: node.ino, nlink: node.nlink, size: node.bytes.length,
    isDirectory: () => node.type === "dir", isFile: () => node.type === "file", isSocket: () => node.type === "socket", isSymbolicLink: () => node.type === "link" };
}
function virtualFs() {
  const nodes = new Map();
  const norm = (path) => posix.resolve("/", path);
  function resolveLinks(path, seen = new Set()) {
    let cursor = "/";
    for (const part of norm(path).split("/").filter(Boolean)) {
      cursor = posix.join(cursor, part);
      const node = nodes.get(cursor);
      if (node?.type === "link") {
        if (seen.has(cursor)) throw Object.assign(new Error("cycle"), { code: "ELOOP" });
        seen.add(cursor);
        cursor = resolveLinks(posix.resolve(posix.dirname(cursor), node.target), seen);
      }
    }
    return cursor;
  }
  return { nodes, add(path, node) { nodes.set(norm(path), node); },
    async lstat(path) { const node = nodes.get(norm(path)); if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return statFor(node); },
    async realpath(path) { const resolved = resolveLinks(path); if (!nodes.has(resolved)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return resolved; },
    async readlink(path) { const node = nodes.get(norm(path)); if (node?.type !== "link") throw Object.assign(new Error("not link"), { code: "EINVAL" }); return node.target; },
    async access(path) { const node = nodes.get(resolveLinks(path)); if (!node || node.type !== "file" || (node.mode & 0o111) === 0) throw Object.assign(new Error("not executable"), { code: "EACCES" }); },
    async readdir(path, options = {}) { const root = norm(path); return [...nodes].filter(([candidate]) => posix.dirname(candidate) === root).sort(([a], [b]) => a < b ? -1 : 1).map(([candidate, node]) => options.withFileTypes ? { name: posix.basename(candidate), isDirectory: () => node.type === "dir", isFile: () => node.type === "file", isSymbolicLink: () => node.type === "link" } : posix.basename(candidate)); },
    async open(path) { const node = nodes.get(norm(path)); if (!node || node.type === "link") throw Object.assign(new Error("open failed"), { code: node?.type === "link" ? "ELOOP" : "ENOENT" }); return { async fstat() { return statFor(node); }, async readFile() { return Buffer.from(node.bytes); }, async close() {} }; }
  };
}

function discoveryFixture({ contextHost = "unix:///Users/alice/.docker/run/docker.sock", profiles = [], healthy = ["/Users/alice/.docker/run/docker.sock"], explicit, dockerBroken = false, unsafeBinaryParent = false } = {}) {
  const context = "desktop-linux";
  const fs = virtualFs();
  const base = {
    "/": entry("dir", { uid: 0, mode: 0o755 }), "/Users": entry("dir", { uid: 0, mode: 0o755 }), "/Users/alice": entry("dir", { mode: 0o750 }),
    "/Users/alice/.docker": entry("dir"), "/Users/alice/.docker/config.json": entry("file", { mode: 0o644, bytes: JSON.stringify({ currentContext: context }) }),
    "/Users/alice/.docker/contexts": entry("dir"), "/Users/alice/.docker/contexts/meta": entry("dir"), [`/Users/alice/.docker/contexts/meta/${HASH_DIR}`]: entry("dir"),
    [`/Users/alice/.docker/contexts/meta/${HASH_DIR}/meta.json`]: entry("file", { mode: 0o644, bytes: JSON.stringify({ Name: context, Metadata: {}, Endpoints: { docker: { Host: contextHost } } }) }),
    "/Users/alice/.docker/run": entry("dir", { mode: 0o700 }), "/Users/alice/.docker/run/docker.sock": entry("socket"), "/Users/alice/.colima": entry("dir"),
    "/usr": entry("dir", { uid: 0 }), "/usr/local": entry("dir", { uid: 0, mode: unsafeBinaryParent ? 0o777 : 0o755 }), "/usr/local/bin": entry("dir", { uid: 0 }),
    "/usr/local/bin/docker": entry("link", { uid: 0, mode: 0o777, target: dockerBroken ? "/missing/docker" : "/Applications/Docker.app/Contents/Resources/bin/docker" }),
    "/usr/local/bin/docker-compose": entry("file", { mode: 0o755 }), "/Applications": entry("dir", { uid: 0 }), "/Applications/Docker.app": entry("dir", { uid: 0 }),
    "/Applications/Docker.app/Contents": entry("dir", { uid: 0 }), "/Applications/Docker.app/Contents/Resources": entry("dir", { uid: 0 }),
    "/Applications/Docker.app/Contents/Resources/bin": entry("dir", { uid: 0 }), "/Applications/Docker.app/Contents/Resources/bin/docker": entry("file", { uid: 0, mode: 0o755 })
  };
  for (const [path, node] of Object.entries(base)) fs.add(path, node);
  for (const profile of profiles) {
    fs.add(`/Users/alice/.colima/${profile}`, entry("dir", { mode: 0o700 }));
    fs.add(`/Users/alice/.colima/${profile}/colima.yaml`, entry("file", { mode: 0o600, bytes: "cpu: 2" }));
    fs.add(`/Users/alice/.colima/${profile}/docker.sock`, entry("socket"));
  }
  const calls = [];
  return { ...fs, calls,
    environment: { PATH: "/usr/local/bin", HOME: "/attacker", DOCKER_HOST: "tcp://attacker:2375", ...(explicit ? { SHENSI_DOCKER_HOST: explicit } : {}), SHENSI_API_HTTP_PORT: "5628", LEAKED_SECRET: "no" },
    userInfo: () => ({ homedir: "/Users/alice", uid: UID, gid: UID }), getuid: () => UID, getgroups: () => [20, UID],
    async composeVersion(command, args, options) { calls.push({ type: "compose-version", command, args, options }); if (command.endsWith("docker") && args.join(" ") === "compose version --short") return "v2.31.0"; if (command.endsWith("docker-compose") && args.join(" ") === "version --short") return "2.31.0"; throw new Error("forbidden command"); },
    async daemonRequest(path, socket, options) { calls.push({ type: "daemon", path, socket, options }); if (!healthy.includes(socket)) throw new Error("unhealthy"); if (path === "/_ping") return "OK"; if (path === "/info") return { ID: `id:${socket}`, Name: "engine", Driver: "overlay2", OSType: "linux", Architecture: "aarch64", ServerVersion: "27.4.1" }; throw new Error("unexpected endpoint"); }
  };
}
const runtimeFrom = async (fixture = discoveryFixture()) => await discoverComposeRuntime(fixture);

const RESOURCE_VERSION_ARTIFACTS = [
  ["containerRuntimeSelection", "container-runtime-selection.json", "containerRuntimeSelectionSha256"],
  ["acceptedComposeBase", "accepted-compose-base.json", "acceptedComposeBaseSha256"],
  ["backendEnvironment", "backend.env", "backendEnvironmentSha256"],
  ["backendImageOverride", "backend-image-override.json", "backendImageOverrideSha256"],
  ["gatewayConfig", "gateway.conf", "gatewayConfigSha256"],
  ["acceptedResources", "accepted-resources.json", "acceptedResourcesSha256"],
  ["task5RecoverySeedCandidateReceipt", "task5-recovery-seed-candidate-receipt.json", "task5RecoverySeedCandidateReceiptSha256"]
];
const resourceHex = (character) => character.repeat(64);
const resourceSha256 = (value) => createHash("sha256").update(value).digest("hex");
const resourceIdentitySha256 = (domain, value) => resourceSha256(Buffer.concat([
  Buffer.from(`${domain}\0`, "utf8"),
  Buffer.from(JSON.stringify(value), "utf8")
]));
const resourceSortedMap = (value) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
const resourceEvidence = (character) => ({ basename: `${resourceHex(character)}.json`, sha256: resourceHex(character) });

function acceptedComposeBaseValue(expectedResources, gatewayImageReference) {
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
        ipam: {
          config: [{
            subnet: "${SHENSI_API_INTERNAL_SUBNET:?required}",
            gateway: "${SHENSI_API_IPAM_GATEWAY:?required}"
          }]
        }
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

function resourceMigrationTransition(state, previous, acceptedVersion = null) {
  const attemptId = "0123456789ab";
  const project = `shensi-api-migration-${attemptId}`;
  const transitionedAt = `2026-09-04T0${["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending", "accepted"].indexOf(state)}:00:00.000Z`;
  const desktopClientAdmission = { mode: "migration_locked", admittedBuildManifestSha256: null };
  const writeActivation = state === "write_activation_pending"
    ? { confirmationSha256: resourceHex("9"), resumeBinding: resourceEvidence("a") }
    : state === "accepted" ? previous.writeActivation : null;
  return {
    attemptId,
    project,
    source: { database: "shensi_trial", port: 3310, commit: "a".repeat(40) },
    target: { database: "shensi", port: 3311, commit: "b".repeat(40) },
    state,
    activeRuntime: state === "prepared" ? "trial" : ["cutover_read_only", "write_activation_pending", "accepted"].includes(state) ? "target" : null,
    rollbackClosedAt: state === "write_activation_pending" ? transitionedAt : state === "accepted" ? previous.rollbackClosedAt : null,
    desktopClientAdmission,
    transitionedAt,
    evidenceManifest: resourceEvidence("5"),
    failure: null,
    recoveryEvidence: null,
    writeActivation,
    acceptedVersion: state === "accepted" ? acceptedVersion : null
  };
}

async function acceptedResourceProjectionFixture({
  canonicalAcceptedResources = true,
  adjustComposeBase,
  serializeComposeBase,
  adjustBackendOverride,
  serializeBackendOverride,
  backendEnvironmentText,
  gatewayConfigText
} = {}) {
  const runtime = await runtimeFrom();
  const repositoryRoot = await nativeRealpath(await mkdtemp(join(tmpdir(), "shensi-resource-inspection-test-")));
  await chmod(repositoryRoot, 0o700);
  const runtimeRoot = join(repositoryRoot, ".runtime", "api-only");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(join(repositoryRoot, ".runtime"), 0o700);
  await chmod(runtimeRoot, 0o700);

  const attemptId = "0123456789ab";
  const project = `shensi-api-migration-${attemptId}`;
  const runtimeNonce = resourceHex("1");
  const labelsFor = (logicalKey, logicalName) => ({
    "com.docker.compose.project": project,
    [logicalKey]: logicalName,
    "io.shensi.api.runtime-nonce": runtimeNonce,
    "io.shensi.api.daemon-identity": runtime.daemon.identity
  });
  const internalIdentity = {
    name: `${project}_shensi_internal`,
    id: resourceHex("4"),
    driver: "bridge",
    scope: "local",
    internal: true,
    attachable: false,
    ingress: false,
    ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.240.0/24", gateway: "172.31.240.1" }],
    options: {},
    labels: resourceSortedMap(labelsFor("com.docker.compose.network", "shensi_internal"))
  };
  const egressIdentity = {
    name: `${project}_shensi_egress`,
    id: resourceHex("6"),
    driver: "bridge",
    scope: "local",
    internal: false,
    attachable: false,
    ingress: false,
    ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.241.0/24", gateway: "172.31.241.1" }],
    options: {},
    labels: resourceSortedMap(labelsFor("com.docker.compose.network", "shensi_egress"))
  };
  const hostIdentity = {
    name: `${project}_shensi_host`,
    id: resourceHex("7"),
    driver: "bridge",
    scope: "local",
    internal: false,
    attachable: false,
    ingress: false,
    ipamDriver: "default",
    ipamConfig: [{ subnet: "172.31.242.0/24", gateway: "172.31.242.1" }],
    options: {
      "com.docker.network.bridge.enable_ip_masquerade": "false",
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    },
    labels: resourceSortedMap(labelsFor("com.docker.compose.network", "shensi_host"))
  };
  const volumeIdentity = {
    name: `${project}_mysql_data`,
    driver: "local",
    scope: "local",
    mountpoint: `/var/lib/docker/volumes/${project}_mysql_data/_data`,
    createdAt: "2026-09-04T00:00:00.000Z",
    options: {},
    labels: resourceSortedMap(labelsFor("com.docker.compose.volume", "mysql_data"))
  };
  const engineResources = {
    internal: {
      Id: internalIdentity.id, Name: internalIdentity.name, Driver: internalIdentity.driver, Scope: internalIdentity.scope,
      Internal: internalIdentity.internal, Attachable: internalIdentity.attachable, Ingress: internalIdentity.ingress,
      IPAM: { Driver: internalIdentity.ipamDriver, Config: internalIdentity.ipamConfig.map(({ subnet, gateway }) => ({ Subnet: subnet, Gateway: gateway })) },
      Options: internalIdentity.options, Labels: labelsFor("com.docker.compose.network", "shensi_internal"), Containers: {}
    },
    egress: {
      Id: egressIdentity.id, Name: egressIdentity.name, Driver: egressIdentity.driver, Scope: egressIdentity.scope,
      Internal: egressIdentity.internal, Attachable: egressIdentity.attachable, Ingress: egressIdentity.ingress,
      IPAM: { Driver: egressIdentity.ipamDriver, Config: egressIdentity.ipamConfig.map(({ subnet, gateway }) => ({ Subnet: subnet, Gateway: gateway })) },
      Options: egressIdentity.options, Labels: labelsFor("com.docker.compose.network", "shensi_egress"), Containers: {}
    },
    host: {
      Id: hostIdentity.id, Name: hostIdentity.name, Driver: hostIdentity.driver, Scope: hostIdentity.scope,
      Internal: hostIdentity.internal, Attachable: hostIdentity.attachable, Ingress: hostIdentity.ingress,
      IPAM: { Driver: hostIdentity.ipamDriver, Config: hostIdentity.ipamConfig.map(({ subnet, gateway }) => ({ Subnet: subnet, Gateway: gateway })) },
      Options: hostIdentity.options, Labels: labelsFor("com.docker.compose.network", "shensi_host"), Containers: {}
    },
    volume: {
      Name: volumeIdentity.name, Driver: volumeIdentity.driver, Scope: volumeIdentity.scope,
      Mountpoint: volumeIdentity.mountpoint, CreatedAt: volumeIdentity.createdAt,
      Options: volumeIdentity.options, Labels: labelsFor("com.docker.compose.volume", "mysql_data")
    }
  };
  const expectedResources = {
    migrationAttemptId: attemptId,
    project,
    ports: { gateway: 5608, mysql: 3311 },
    runtimeNonce,
    engine: { socketIdentity: runtime.socket.identity, daemonIdentity: runtime.daemon.identity },
    networks: {
      internal: {
        id: resourceHex("4"),
        name: `${project}_shensi_internal`,
        identitySha256: resourceIdentitySha256("shensi.api-only.network-identity/v1", internalIdentity),
        subnet: "172.31.240.0/24",
        ipamGatewayIp: "172.31.240.1",
        gatewayServiceIp: "172.31.240.2"
      },
      egress: { id: resourceHex("6"), name: `${project}_shensi_egress`, identitySha256: resourceIdentitySha256("shensi.api-only.network-identity/v1", egressIdentity) },
      host: { id: resourceHex("7"), name: `${project}_shensi_host`, identitySha256: resourceIdentitySha256("shensi.api-only.network-identity/v1", hostIdentity) }
    },
    mysql: {
      containerId: resourceHex("8"),
      volumeName: `${project}_mysql_data`,
      volumeIdentitySha256: resourceIdentitySha256("shensi.api-only.volume-identity/v1", volumeIdentity),
      imageIdDigest: `sha256:${resourceHex("a")}`
    },
    backend: {
      imageIdDigest: `sha256:${resourceHex("b")}`,
      composeImageReference: { kind: "engine-image-id", value: `sha256:${resourceHex("b")}` }
    }
  };
  const containerLabels = (service) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.container-number": "1",
    "io.shensi.api.runtime-nonce": runtimeNonce,
    "io.shensi.api.daemon-identity": runtime.daemon.identity
  });
  engineResources.mysql = {
    Id: expectedResources.mysql.containerId,
    Image: expectedResources.mysql.imageIdDigest,
    Config: { Labels: containerLabels("mysql") },
    State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(expectedResources.ports.mysql) }] } },
    NetworkSettings: {
      Networks: {
        [expectedResources.networks.internal.name]: { NetworkID: expectedResources.networks.internal.id, IPAddress: "172.31.240.3", IPPrefixLen: 24 },
        [expectedResources.networks.host.name]: { NetworkID: expectedResources.networks.host.id, IPAddress: "172.31.242.2", IPPrefixLen: 24 }
      },
      Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(expectedResources.ports.mysql) }] }
    },
    Mounts: [
      { Type: "volume", Name: expectedResources.mysql.volumeName, Source: volumeIdentity.mountpoint, Destination: "/var/lib/mysql", Mode: "rw", RW: true, Propagation: "" },
      { Type: "bind", Source: join(runtimeRoot, "secrets", "mysql_app_password"), Destination: "/run/secrets/mysql_app_password", Mode: "ro", RW: false, Propagation: "rprivate" },
      { Type: "bind", Source: join(runtimeRoot, "secrets", "mysql_root_password"), Destination: "/run/secrets/mysql_root_password", Mode: "ro", RW: false, Propagation: "rprivate" }
    ]
  };
  engineResources.backend = {
    Id: resourceHex("d"),
    Image: expectedResources.backend.imageIdDigest,
    Config: { Labels: containerLabels("backend") },
    State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: {
      Networks: {
        [expectedResources.networks.internal.name]: { NetworkID: expectedResources.networks.internal.id, IPAddress: "172.31.240.4", IPPrefixLen: 24 },
        [expectedResources.networks.egress.name]: { NetworkID: expectedResources.networks.egress.id, IPAddress: "172.31.241.2", IPPrefixLen: 24 }
      },
      Ports: {}
    },
    Mounts: []
  };
  engineResources.gateway = {
    Id: resourceHex("e"),
    Image: `sha256:${resourceHex("c")}`,
    Config: { Labels: containerLabels("gateway") },
    State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 },
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(expectedResources.ports.gateway) }] } },
    NetworkSettings: {
      Networks: {
        [expectedResources.networks.internal.name]: { NetworkID: expectedResources.networks.internal.id, IPAddress: expectedResources.networks.internal.gatewayServiceIp, IPPrefixLen: 24 },
        [expectedResources.networks.host.name]: { NetworkID: expectedResources.networks.host.id, IPAddress: "172.31.242.3", IPPrefixLen: 24 }
      },
      Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(expectedResources.ports.gateway) }] }
    },
    Mounts: [
      { Type: "bind", Source: "GATEWAY_CONFIG_PATH", Destination: "/etc/nginx/conf.d/default.conf", Mode: "ro", RW: false, Propagation: "rprivate" }
    ]
  };
  engineResources.internal.Containers = {
    [engineResources.mysql.Id]: { Name: "mysql" },
    [engineResources.backend.Id]: { Name: "backend" },
    [engineResources.gateway.Id]: { Name: "gateway" }
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
    gateway: { Id: `sha256:${resourceHex("c")}`, RepoDigests: [] }
  };
  const acceptedResources = {
    schema: "shensi.api-only.accepted-resources",
    version: 1,
    project: expectedResources.project,
    ports: expectedResources.ports,
    runtimeNonce: expectedResources.runtimeNonce,
    engine: expectedResources.engine,
    networks: expectedResources.networks,
    mysql: expectedResources.mysql,
    backend: expectedResources.backend,
    gateway: {
      imageIdDigest: `sha256:${resourceHex("c")}`,
      composeImageReference: { kind: "engine-image-id", value: `sha256:${resourceHex("c")}` }
    }
  };
  const acceptedResourcesText = canonicalAcceptedResources
    ? `${JSON.stringify(acceptedResources)}\n`
    : `${JSON.stringify(acceptedResources, null, 2)}\n`;
  const bytes = Object.fromEntries(RESOURCE_VERSION_ARTIFACTS.map(([, basename]) => [basename, Buffer.from(`sealed:${basename}\n`, "utf8")]));
  const composeBase = acceptedComposeBaseValue(expectedResources, acceptedResources.gateway.composeImageReference.value);
  adjustComposeBase?.(composeBase);
  const backendOverride = {
    services: {
      backend: {
        image: expectedResources.backend.composeImageReference.value,
        pull_policy: "never"
      }
    }
  };
  adjustBackendOverride?.(backendOverride);
  bytes["accepted-compose-base.json"] = Buffer.from(serializeComposeBase?.(composeBase) ?? `${JSON.stringify(composeBase)}\n`, "utf8");
  bytes["backend-image-override.json"] = Buffer.from(serializeBackendOverride?.(backendOverride) ?? `${JSON.stringify(backendOverride)}\n`, "utf8");
  bytes["backend.env"] = Buffer.from(backendEnvironmentText ?? [
    "DATABASE_URL=mysql://shensi_app:private-password@mysql:3306/shensi",
    "CRM_STORE=mysql",
    "NODE_ENV=production",
    "BACKEND_API_KEY=accepted-compose-secret-canary",
    "DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=true",
    "SHENSI_RUNTIME_READ_ONLY=false"
  ].join("\n") + "\n", "utf8");
  bytes["gateway.conf"] = Buffer.from(gatewayConfigText ?? "server { listen 8080; location /healthz { return 200 'ok\\n'; } }\n", "utf8");
  bytes["accepted-resources.json"] = Buffer.from(acceptedResourcesText, "utf8");
  const artifacts = Object.fromEntries(RESOURCE_VERSION_ARTIFACTS.map(([, basename, field]) => [field, resourceSha256(bytes[basename])]));
  const binding = {
    ...expectedResources,
    artifacts,
    acceptedLiveSchemaHash: resourceHex("d"),
    apiContractHash: resourceHex("e"),
    desktopClientAdmission: { mode: "migration_locked", admittedBuildManifestSha256: null }
  };
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const built = resolver.buildInitialAcceptedVersion(binding);
  const versionsRoot = join(runtimeRoot, "versions");
  const versionRoot = join(versionsRoot, built.versionId);
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await chmod(versionsRoot, 0o700);
  await chmod(versionRoot, 0o700);
  await writeFile(join(versionRoot, "accepted-version.json"), built.canonicalText, { mode: 0o600 });
  await chmod(join(versionRoot, "accepted-version.json"), 0o600);
  for (const [, basename] of RESOURCE_VERSION_ARTIFACTS) {
    await writeFile(join(versionRoot, basename), bytes[basename], { mode: 0o600 });
    await chmod(join(versionRoot, basename), 0o600);
  }
  const pointer = { schema: "shensi.api-only.active-version-pointer", version: 1, versionId: built.versionId, recordSha256: built.recordSha256 };
  await writeFile(join(runtimeRoot, "active-version.json"), `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
  await chmod(join(runtimeRoot, "active-version.json"), 0o600);
  let journal = null;
  for (const state of ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending", "accepted"]) {
    const previous = journal?.journal.attemptSummaries.at(-1) ?? null;
    const transition = resourceMigrationTransition(state, previous, { versionId: built.versionId, recordSha256: built.recordSha256 });
    journal = resolver.buildNextMigrationJournal(journal?.journal ?? null, transition);
  }
  await writeFile(join(runtimeRoot, "migration-state.json"), journal.canonicalText, { mode: 0o600 });
  await chmod(join(runtimeRoot, "migration-state.json"), 0o600);
  const secretsRoot = join(runtimeRoot, "secrets");
  await mkdir(secretsRoot, { mode: 0o700 });
  await chmod(secretsRoot, 0o700);
  await writeFile(join(secretsRoot, "mysql_app_password"), "app-secret", { mode: 0o600 });
  await writeFile(join(secretsRoot, "mysql_root_password"), "root-secret", { mode: 0o600 });
  await chmod(join(secretsRoot, "mysql_app_password"), 0o600);
  await chmod(join(secretsRoot, "mysql_root_password"), 0o600);
  const authority = await resolver.readLifecycleAuthority(repositoryRoot);
  const projection = resolver.projectAcceptedResources(authority);
  engineResources.gateway.Mounts[0].Source = projection.artifacts.gatewayConfig.path;
  const artifactPaths = Object.values(projection.artifacts).map(({ path }) => path);
  return { repositoryRoot, runtime, projection, artifactPaths, versionRoot, bytes, engineResources };
}

test("accepted resource bridge exposes only one read-only method and rejects every unknown or non-function seam", async () => {
  const module = await import("./container-runtime.mjs");
  assert.equal(typeof module.createApiOnlyResourceInspectionBridge, "function");
  const bridge = module.createApiOnlyResourceInspectionBridge();
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ["inspectAcceptedResourceSet"]);
  assert.equal(typeof bridge.inspectAcceptedResourceSet, "function");
  for (const invalid of [
    null,
    [],
    { unknown: () => {} },
    { request: true },
    { lstat: null },
    { realpath: "yes" },
    { open: {} },
    { getuid: 501 },
    { setTimeout: [] },
    { clearTimeout: false }
  ]) {
    assert.throws(
      () => module.createApiOnlyResourceInspectionBridge(invalid),
      /API_ONLY_RESOURCE_INSPECTION_OPTIONS_INVALID/u
    );
  }
});

test("accepted resource inspection rejects an untrusted runtime or forged B2 projection before filesystem or Engine effects", async () => {
  const module = await import("./container-runtime.mjs");
  let effects = 0;
  const forbidden = () => {
    effects += 1;
    throw new Error("RESOURCE_INSPECTION_EFFECT_CALLED");
  };
  const bridge = module.createApiOnlyResourceInspectionBridge({
    request: forbidden,
    lstat: forbidden,
    realpath: forbidden,
    open: forbidden,
    getuid: forbidden,
    setTimeout: forbidden,
    clearTimeout: forbidden
  });

  await assert.rejects(
    () => bridge.inspectAcceptedResourceSet({}, {}),
    /COMPOSE_RUNTIME_UNTRUSTED/u
  );
  assert.equal(effects, 0);

  const runtime = await runtimeFrom();
  await assert.rejects(
    () => bridge.inspectAcceptedResourceSet(runtime, {}),
    /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u
  );
  assert.equal(effects, 0);
});

test("accepted resource inspection reopens all seven fixed artifacts and rejects path inode hash mode link and canonical-byte drift before Engine effects", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const canonicalDrift = await acceptedResourceProjectionFixture({ canonicalAcceptedResources: false });
  try {
    let engineEffects = 0;
    const opened = new Set();
    let closed = 0;
    const countingOpen = async (path, flags, mode) => {
      const handle = await nativeOpen(path, flags, mode);
      if (!fixture.artifactPaths.includes(path)) return handle;
      opened.add(path);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => handle.read(...args),
        readFile: (...args) => handle.readFile(...args),
        async close() { closed += 1; await handle.close(); }
      };
    };
    await assert.rejects(() => module.createApiOnlyResourceInspectionBridge({
      request() { engineEffects += 1; throw new Error("ENGINE_EFFECT_CALLED"); },
      open: countingOpen
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection));
    assert.deepEqual([...opened].sort(), [...fixture.artifactPaths].sort());
    assert.equal(closed, 7);
    assert.ok(engineEffects <= 1);

    const assertArtifactInvalidBeforeEngine = async (targetFixture, options = {}) => {
      let calls = 0;
      const bridge = module.createApiOnlyResourceInspectionBridge({
        request() { calls += 1; throw new Error("ENGINE_EFFECT_CALLED"); },
        ...options
      });
      await assert.rejects(
        () => bridge.inspectAcceptedResourceSet(targetFixture.runtime, targetFixture.projection),
        /API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID/u
      );
      assert.equal(calls, 0);
    };

    const pathTarget = fixture.artifactPaths[0];
    await assertArtifactInvalidBeforeEngine(fixture, {
      realpath: async (path) => path === pathTarget ? `${path}.alias` : await nativeRealpath(path)
    });

    const inodeTarget = fixture.artifactPaths[1];
    await assertArtifactInvalidBeforeEngine(fixture, {
      open: async (path, flags, mode) => {
        const handle = await nativeOpen(path, flags, mode);
        if (path !== inodeTarget) return handle;
        return {
          async stat(...args) {
            const info = await handle.stat(...args);
            return new Proxy(info, { get(target, property) { return property === "ino" ? target.ino + 1 : Reflect.get(target, property, target); } });
          },
          read: (...args) => handle.read(...args),
          readFile: (...args) => handle.readFile(...args),
          close: (...args) => handle.close(...args)
        };
      }
    });

    const hashTarget = fixture.artifactPaths[2];
    await writeFile(hashTarget, "changed artifact bytes\n", { mode: 0o600 });
    await assertArtifactInvalidBeforeEngine(fixture);
    await writeFile(hashTarget, fixture.bytes["backend.env"], { mode: 0o600 });

    const modeTarget = fixture.artifactPaths[3];
    await chmod(modeTarget, 0o644);
    await assertArtifactInvalidBeforeEngine(fixture);
    await chmod(modeTarget, 0o600);

    const linkTarget = fixture.artifactPaths[4];
    const hardlink = join(fixture.repositoryRoot, "artifact-hardlink");
    await link(linkTarget, hardlink);
    await assertArtifactInvalidBeforeEngine(fixture);
    await rm(hardlink);

    await assertArtifactInvalidBeforeEngine(canonicalDrift);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
    await rm(canonicalDrift.repositoryRoot, { recursive: true, force: true });
  }
});

function acceptedResourceEngineFixture(fixture, { finalInfo = BRIDGE_ENGINE_INFO, adjustInventories, adjustExact } = {}) {
  const expected = fixture.projection.expectedResources;
  const projectLabel = `com.docker.compose.project=${expected.project}`;
  const filter = encodeURIComponent(JSON.stringify({ label: [projectLabel] }));
  const paths = {
    containers: `/containers/json?all=1&filters=${filter}`,
    networks: `/networks?filters=${filter}`,
    volumes: `/volumes?filters=${filter}`
  };
  const labelsFor = (service) => ({
    "com.docker.compose.project": expected.project,
    "com.docker.compose.service": service,
    "io.shensi.api.runtime-nonce": expected.runtimeNonce,
    "io.shensi.api.daemon-identity": expected.engine.daemonIdentity
  });
  const backendId = resourceHex("d");
  const gatewayId = resourceHex("e");
  const inventories = {
    containers: [
      { Id: expected.mysql.containerId, Labels: labelsFor("mysql") },
      { Id: backendId, Labels: labelsFor("backend") },
      { Id: gatewayId, Labels: labelsFor("gateway") }
    ],
    networks: [
      { Id: expected.networks.internal.id, Name: expected.networks.internal.name, Labels: structuredClone(fixture.engineResources.internal.Labels) },
      { Id: expected.networks.egress.id, Name: expected.networks.egress.name, Labels: structuredClone(fixture.engineResources.egress.Labels) },
      { Id: expected.networks.host.id, Name: expected.networks.host.name, Labels: structuredClone(fixture.engineResources.host.Labels) }
    ],
    volumes: [
      { Name: expected.mysql.volumeName, Labels: structuredClone(fixture.engineResources.volume.Labels) }
    ]
  };
  adjustInventories?.(inventories);
  const exact = structuredClone(fixture.engineResources);
  adjustExact?.(exact);
  const responses = {
    "/info": [{ body: BRIDGE_ENGINE_INFO }, { body: finalInfo }],
    [paths.containers]: { body: inventories.containers },
    [paths.networks]: { body: inventories.networks },
    [paths.volumes]: { body: { Volumes: inventories.volumes, Warnings: null } },
    [`/networks/${encodeURIComponent(expected.networks.internal.id)}`]: { body: exact.internal },
    [`/networks/${encodeURIComponent(expected.networks.egress.id)}`]: { body: exact.egress },
    [`/networks/${encodeURIComponent(expected.networks.host.id)}`]: { body: exact.host },
    [`/containers/${encodeURIComponent(expected.mysql.containerId)}/json`]: { body: exact.mysql },
    [`/volumes/${encodeURIComponent(expected.mysql.volumeName)}`]: { body: exact.volume },
    [`/containers/${encodeURIComponent(backendId)}/json`]: { body: exact.backend },
    [`/containers/${encodeURIComponent(gatewayId)}/json`]: { body: exact.gateway },
    [`/images/${encodeURIComponent(expected.mysql.imageIdDigest)}/json`]: { body: exact.images.mysql },
    [`/images/${encodeURIComponent(expected.backend.imageIdDigest)}/json`]: { body: exact.images.backend },
    [`/images/${encodeURIComponent(`sha256:${resourceHex("c")}`)}/json`]: { body: exact.images.gateway }
  };
  const engine = engineRequestFixture(responses);
  return {
    ...engine,
    inventoryPaths: ["/info", paths.containers, paths.networks, paths.volumes],
    expectedPaths: [
      "/info",
      paths.containers,
      paths.networks,
      paths.volumes,
      `/networks/${encodeURIComponent(expected.networks.internal.id)}`,
      `/networks/${encodeURIComponent(expected.networks.egress.id)}`,
      `/networks/${encodeURIComponent(expected.networks.host.id)}`,
      `/containers/${encodeURIComponent(expected.mysql.containerId)}/json`,
      `/volumes/${encodeURIComponent(expected.mysql.volumeName)}`,
      `/containers/${encodeURIComponent(backendId)}/json`,
      `/containers/${encodeURIComponent(gatewayId)}/json`,
      `/images/${encodeURIComponent(expected.mysql.imageIdDigest)}/json`,
      `/images/${encodeURIComponent(expected.backend.imageIdDigest)}/json`,
      `/images/${encodeURIComponent(`sha256:${resourceHex("c")}`)}/json`,
      "/info"
    ]
  };
}

function acceptedLifecycleRequestFixture(fixture, acceptedOptions = {}) {
  const {
    adjustPreExact,
    adjustPreInventories,
    adjustPostExact = acceptedOptions.adjustExact,
    adjustPostInventories = acceptedOptions.adjustInventories,
    finalInfo
  } = acceptedOptions;
  const explicitPre = Object.hasOwn(acceptedOptions, "adjustPreExact") || Object.hasOwn(acceptedOptions, "adjustPreInventories");
  const pre = acceptedResourceEngineFixture(fixture, {
    finalInfo,
    adjustExact: explicitPre ? adjustPreExact : adjustPostExact,
    adjustInventories: explicitPre ? adjustPreInventories : adjustPostInventories
  });
  const post = acceptedResourceEngineFixture(fixture, {
    finalInfo,
    adjustExact: adjustPostExact,
    adjustInventories: adjustPostInventories
  });
  const networkRows = [
    ...rawBuiltinNetworks(),
    structuredClone(fixture.engineResources.internal),
    structuredClone(fixture.engineResources.egress)
  ];
  const networks = engineRequestFixture({
    "/networks": Array.from({ length: 4 }, () => ({ body: structuredClone(networkRows) }))
  });
  let acceptedInspection = 0;
  return {
    accepted: post,
    pre,
    post,
    networks,
    request(options, onResponse) {
      if (options.path === "/networks") return networks.request(options, onResponse);
      if (options.path.startsWith("/containers/json?all=1&filters=")) acceptedInspection += 1;
      return (acceptedInspection <= 1 ? pre : post).request(options, onResponse);
    }
  };
}

function acceptedLifecycleRouteSeams(route) {
  const routeOrNative = (routeFunction, nativeFunction) => async (path, ...args) => path.startsWith("/usr")
    ? await routeFunction(path, ...args)
    : await nativeFunction(path, ...args);
  return {
    execFile: route.execFile,
    lstat: routeOrNative(route.lstat, lstat),
    realpath: routeOrNative(route.realpath, nativeRealpath),
    readlink: routeOrNative(route.readlink, nativeReadlink),
    access: routeOrNative(route.access, nativeAccess)
  };
}

test("accepted resource inspection performs only the bounded fixed project-filtered Engine GET sequence and rejects daemon drift or malformed transport", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const engine = acceptedResourceEngineFixture(fixture);
    const observed = await module.createApiOnlyResourceInspectionBridge({ request: engine.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    assert.equal(observed.matched, true);
    assert.deepEqual(engine.calls.map(({ path }) => path), engine.expectedPaths);
    for (const call of engine.calls) assert.deepEqual(call, {
      socketPath: fixture.runtime.socket.canonicalPath,
      path: call.path,
      method: "GET",
      agent: false,
      timeout: 3_000,
      maxResponseBytes: 1_048_576,
      headers: { Accept: "application/json" }
    });

    const malformed = engineRequestFixture({ "/info": { statusCode: 500, body: {} } });
    await assert.rejects(
      () => module.createApiOnlyResourceInspectionBridge({ request: malformed.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
      /API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID/u
    );

    const drifted = acceptedResourceEngineFixture(fixture, { finalInfo: { ...BRIDGE_ENGINE_INFO, ID: "changed-daemon" } });
    await assert.rejects(
      () => module.createApiOnlyResourceInspectionBridge({ request: drifted.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
      /API_ONLY_ACCEPTED_RESOURCE_MISMATCH/u
    );
    assert.deepEqual(drifted.calls.map(({ path }) => path), drifted.expectedPaths);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted resource inspection rejects duplicate missing or unknown project candidates instead of selecting an arbitrary object", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const cases = [
      ["duplicate", (inventories) => inventories.containers.push({ ...inventories.containers[0], Id: resourceHex("f") })],
      ["missing", (inventories) => inventories.networks.pop()],
      ["unknown", (inventories) => inventories.volumes.push({
        Name: `${fixture.projection.expectedResources.project}_unknown`,
        Labels: {
          "com.docker.compose.project": fixture.projection.expectedResources.project,
          "com.docker.compose.volume": "unknown"
        }
      })]
    ];
    for (const [name, adjustInventories] of cases) {
      const engine = acceptedResourceEngineFixture(fixture, { adjustInventories });
      await assert.rejects(
        () => module.createApiOnlyResourceInspectionBridge({ request: engine.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
        /API_ONLY_ACCEPTED_RESOURCE_MISMATCH/u,
        name
      );
      assert.deepEqual(engine.calls.map(({ path }) => path), engine.inventoryPaths, name);
    }
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted resource inspection binds all networks and the volume to exact labels topology and domain-separated identities", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const cases = [
      ["internal-label", (exact) => { exact.internal.Labels["io.shensi.api.runtime-nonce"] = resourceHex("f"); }, 5],
      ["internal-topology", (exact) => {
        exact.internal.IPAM.Config[0].Subnet = "172.31.242.0/24";
        exact.internal.IPAM.Config[0].Gateway = "172.31.242.1";
      }, 5],
      ["network-identity", (exact) => { exact.internal.Options.changed = "true"; }, 5],
      ["egress-attachment", (exact) => { exact.egress.Containers[fixture.projection.expectedResources.mysql.containerId] = { Name: "mysql" }; }, 6],
      ["host-identity", (exact) => { exact.host.Options["com.docker.network.bridge.enable_ip_masquerade"] = "true"; }, 7],
      ["host-attachment", (exact) => { exact.host.Containers[resourceHex("d")] = { Name: "backend" }; }, 7],
      ["volume-identity", (exact) => { exact.volume.Labels["io.shensi.api.daemon-identity"] = resourceHex("f"); }, 9]
    ];
    for (const [name, adjustExact, expectedCalls] of cases) {
      const engine = acceptedResourceEngineFixture(fixture, { adjustExact });
      await assert.rejects(
        () => module.createApiOnlyResourceInspectionBridge({ request: engine.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
        /API_ONLY_ACCEPTED_RESOURCE_MISMATCH/u,
        name
      );
      assert.equal(engine.calls.length, expectedCalls, name);
    }
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted resource inspection binds MySQL identity image loopback port internal attachment volume and secret mounts", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const cases = [
      ["container-id", (exact) => { exact.mysql.Id = resourceHex("f"); }],
      ["image", (exact) => { exact.mysql.Image = `sha256:${resourceHex("f")}`; }],
      ["loopback-port", (exact) => { exact.mysql.HostConfig.PortBindings["3306/tcp"][0].HostIp = "0.0.0.0"; }],
      ["internal-attachment", (exact) => { exact.mysql.NetworkSettings.Networks.foreign = { NetworkID: resourceHex("f"), IPAddress: "10.0.0.2", IPPrefixLen: 24 }; }],
      ["volume", (exact) => { exact.mysql.Mounts[0].RW = false; }],
      ["secret", (exact) => { exact.mysql.Mounts[1].Source = `${exact.mysql.Mounts[1].Source}.wrong`; }]
    ];
    for (const [name, adjustExact] of cases) {
      const engine = acceptedResourceEngineFixture(fixture, { adjustExact });
      await assert.rejects(
        () => module.createApiOnlyResourceInspectionBridge({ request: engine.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
        /API_ONLY_ACCEPTED_RESOURCE_MISMATCH/u,
        name
      );
      assert.equal(engine.calls.length, 8, name);
    }
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted resource inspection validates recreatable Backend and Gateway identities images topology ports and Gateway config mount", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const cases = [
      ["backend-image", (exact) => { exact.backend.Image = `sha256:${resourceHex("f")}`; }, 10],
      ["backend-topology", (exact) => { delete exact.backend.NetworkSettings.Networks[fixture.projection.expectedResources.networks.egress.name]; }, 10],
      ["gateway-port", (exact) => { exact.gateway.NetworkSettings.Ports["8080/tcp"][0].HostIp = "0.0.0.0"; }, 11],
      ["gateway-address", (exact) => { exact.gateway.NetworkSettings.Networks[fixture.projection.expectedResources.networks.internal.name].IPAddress = "172.31.240.9"; }, 11],
      ["gateway-config", (exact) => { exact.gateway.Mounts[0].Source = `${exact.gateway.Mounts[0].Source}.wrong`; }, 11],
      ["image-inspection", (exact) => { exact.images.mysql.Id = `sha256:${resourceHex("f")}`; }, 12]
    ];
    for (const [name, adjustExact, expectedCalls] of cases) {
      const engine = acceptedResourceEngineFixture(fixture, { adjustExact });
      await assert.rejects(
        () => module.createApiOnlyResourceInspectionBridge({ request: engine.request }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection),
        /API_ONLY_ACCEPTED_RESOURCE_MISMATCH/u,
        name
      );
      assert.equal(engine.calls.length, expectedCalls, name);
    }
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted resource inspection returns only a deeply frozen branded status-safe projection and never leaks raw or secret input", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const assertFrozen = (value) => {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozen(child);
  };
  try {
    const bridge = module.createApiOnlyResourceInspectionBridge({ request: acceptedResourceEngineFixture(fixture).request });
    const result = await bridge.inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    assert.deepEqual(Object.keys(result), ["schema", "version", "projectionSha256", "artifactSetSha256", "identitySha256", "stateSha256", "matched", "mysql", "backend", "gateway"]);
    assert.deepEqual(result, {
      schema: "shensi.api-only.accepted-resource-set",
      version: 1,
      projectionSha256: result.projectionSha256,
      artifactSetSha256: result.artifactSetSha256,
      identitySha256: result.identitySha256,
      stateSha256: result.stateSha256,
      matched: true,
      mysql: { present: true, state: "running", healthy: true },
      backend: { present: true, state: "running", healthy: true },
      gateway: { present: true, state: "running", healthcheckConfigured: false }
    });
    for (const digest of [result.projectionSha256, result.artifactSetSha256, result.identitySha256, result.stateSha256]) assert.match(digest, /^[a-f0-9]{64}$/u);
    assertFrozen(result);
    const serialized = JSON.stringify(result);
    for (const forbidden of [fixture.repositoryRoot, fixture.runtime.socket.canonicalPath, fixture.projection.expectedResources.project, fixture.projection.expectedResources.mysql.containerId, "sealed:", "mysql_app_password"]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(Object.isFrozen(structuredClone(result)), false);

    const repeat = await module.createApiOnlyResourceInspectionBridge({ request: acceptedResourceEngineFixture(fixture).request })
      .inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    assert.deepEqual(repeat, result);

    const stoppedEngine = acceptedResourceEngineFixture(fixture, { adjustExact(exact) {
      exact.backend.State = { ...exact.backend.State, Status: "exited", Running: false, Health: { Status: "unhealthy" } };
    } });
    const stopped = await module.createApiOnlyResourceInspectionBridge({ request: stoppedEngine.request })
      .inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    assert.equal(stopped.identitySha256, result.identitySha256);
    assert.notEqual(stopped.stateSha256, result.stateSha256);
    assert.deepEqual(stopped.backend, { present: true, state: "clean-stopped", healthy: false });

    const absentEngine = acceptedResourceEngineFixture(fixture, { adjustInventories(inventories) {
      inventories.containers = inventories.containers.filter(({ Labels }) => Labels["com.docker.compose.service"] === "mysql");
    } });
    const absent = await module.createApiOnlyResourceInspectionBridge({ request: absentEngine.request })
      .inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    assert.deepEqual(absent.backend, { present: false, state: "absent", healthy: null });
    assert.deepEqual(absent.gateway, { present: false, state: "absent", healthcheckConfigured: false });
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted Compose bridge exposes only one validation method and rejects every unknown or non-function seam", async () => {
  const module = await import("./container-runtime.mjs");
  assert.equal(typeof module.createApiOnlyAcceptedComposeValidationBridge, "function");
  const bridge = module.createApiOnlyAcceptedComposeValidationBridge();
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ["validateAcceptedComposeInputs"]);
  assert.equal(typeof bridge.validateAcceptedComposeInputs, "function");
  for (const invalid of [
    null,
    [],
    { unknown: () => {} },
    { lstat: true },
    { realpath: null },
    { open: "yes" },
    { getuid: 501 },
    { spawn: {} },
    { setTimeout: [] },
    { clearTimeout: false },
    { revalidateExecutable: 1 },
    { probeDaemonIdentity: "no" },
    { monotonicNow: null }
  ]) {
    assert.throws(
      () => module.createApiOnlyAcceptedComposeValidationBridge(invalid),
      /API_ONLY_ACCEPTED_COMPOSE_OPTIONS_INVALID/u
    );
  }
});

test("accepted Compose validation requires the matching runtime B2 projection and authentic B3-R observation before effects", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const other = await acceptedResourceProjectionFixture();
  try {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    let effects = 0;
    const forbidden = () => {
      effects += 1;
      throw new Error("ACCEPTED_COMPOSE_EFFECT_CALLED");
    };
    const bridge = module.createApiOnlyAcceptedComposeValidationBridge({
      lstat: forbidden,
      realpath: forbidden,
      open: forbidden,
      getuid: forbidden,
      spawn: forbidden,
      setTimeout: forbidden,
      clearTimeout: forbidden,
      revalidateExecutable: forbidden,
      probeDaemonIdentity: forbidden,
      monotonicNow: forbidden
    });

    await assert.rejects(
      () => bridge.validateAcceptedComposeInputs({}, {}, {}),
      /COMPOSE_RUNTIME_UNTRUSTED/u
    );
    assert.equal(effects, 0);

    await assert.rejects(
      () => bridge.validateAcceptedComposeInputs(fixture.runtime, {}, {}),
      /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u
    );
    assert.equal(effects, 0);

    for (const forged of [{}, structuredClone(observation)]) {
      await assert.rejects(
        () => bridge.validateAcceptedComposeInputs(fixture.runtime, fixture.projection, forged),
        /API_ONLY_ACCEPTED_COMPOSE_OBSERVATION_REQUIRED/u
      );
      assert.equal(effects, 0);
    }

    await assert.rejects(
      () => bridge.validateAcceptedComposeInputs(other.runtime, other.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_OBSERVATION_REQUIRED/u
    );
    assert.equal(effects, 0);

    await assert.rejects(
      () => bridge.validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID/u
    );
    assert.equal(effects, 1);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
    await rm(other.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted Compose validation holds and revalidates the four fixed version files as one descriptor transaction", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const composePaths = [
      fixture.projection.artifacts.acceptedComposeBase.path,
      fixture.projection.artifacts.backendImageOverride.path,
      fixture.projection.artifacts.backendEnvironment.path,
      fixture.projection.artifacts.gatewayConfig.path
    ];
    const opened = [];
    const closed = [];
    let spawned = 0;
    const bridge = module.createApiOnlyAcceptedComposeValidationBridge({
      open: async (path, flags, mode) => {
        const handle = await nativeOpen(path, flags, mode);
        if (!composePaths.includes(path)) return handle;
        opened.push(path);
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => handle.read(...args),
          async close() { closed.push(path); await handle.close(); }
        };
      },
      spawn() { spawned += 1; throw new Error("SPAWN_MUST_NOT_RUN_IN_FILE_CYCLE"); }
    });
    await assert.rejects(
      () => bridge.validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED/u
    );
    assert.deepEqual(opened, composePaths);
    assert.deepEqual(closed, [...composePaths].reverse());
    assert.equal(spawned, 0);

    const assertFileInvalid = async (mutate, restore, options = {}) => {
      await mutate();
      let calls = 0;
      try {
        await assert.rejects(
          () => module.createApiOnlyAcceptedComposeValidationBridge({
            ...options,
            spawn() { calls += 1; throw new Error("UNEXPECTED_SPAWN"); }
          }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
          /API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID/u
        );
        assert.equal(calls, 0);
      } finally {
        await restore();
      }
    };

    const hashPath = composePaths[2];
    await assertFileInvalid(
      () => writeFile(hashPath, "changed-secret=must-not-leak\n", { mode: 0o600 }),
      () => writeFile(hashPath, fixture.bytes["backend.env"], { mode: 0o600 })
    );

    const modePath = composePaths[3];
    await assertFileInvalid(
      () => chmod(modePath, 0o644),
      () => chmod(modePath, 0o600)
    );

    const linkedPath = composePaths[1];
    const hardlink = join(fixture.repositoryRoot, "accepted-override-hardlink");
    await assertFileInvalid(
      () => link(linkedPath, hardlink),
      () => rm(hardlink)
    );

    await assert.rejects(
      () => module.createApiOnlyAcceptedComposeValidationBridge({
        realpath: async (path) => path === composePaths[0] ? `${path}.alias` : await nativeRealpath(path)
      }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID/u
    );
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted Compose validation accepts only the exact canonical no-build terminal base model", async () => {
  const module = await import("./container-runtime.mjs");
  const valid = await acceptedResourceProjectionFixture();
  const invalidFixtures = await Promise.all([
    acceptedResourceProjectionFixture({ adjustComposeBase(base) { base.services.backend.build = { context: ".." }; } }),
    acceptedResourceProjectionFixture({ adjustComposeBase(base) { base.services.gateway.image = "nginx:latest"; } }),
    acceptedResourceProjectionFixture({ adjustComposeBase(base) { base.services.backend.environment.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED = "false"; } }),
    acceptedResourceProjectionFixture({ adjustComposeBase(base) { base.services.mysql.labels["io.shensi.api.runtime-nonce"] = "caller"; } }),
    acceptedResourceProjectionFixture({ adjustComposeBase(base) { base.include = ["current-source.yaml"]; } }),
    acceptedResourceProjectionFixture({ serializeComposeBase(base) { return `${JSON.stringify(base, null, 2)}\n`; } })
  ]);
  try {
    const observed = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(valid).request
    }).inspectAcceptedResourceSet(valid.runtime, valid.projection);
    let spawned = 0;
    await assert.rejects(
      () => module.createApiOnlyAcceptedComposeValidationBridge({
        spawn() { spawned += 1; throw new Error("BASE_VALIDATION_SPAWN_FORBIDDEN"); }
      }).validateAcceptedComposeInputs(valid.runtime, valid.projection, observed),
      /API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED/u
    );
    assert.equal(spawned, 0);

    for (const [index, fixture] of invalidFixtures.entries()) {
      const observation = await module.createApiOnlyResourceInspectionBridge({
        request: acceptedResourceEngineFixture(fixture).request
      }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
      let calls = 0;
      await assert.rejects(
        () => module.createApiOnlyAcceptedComposeValidationBridge({
          spawn() { calls += 1; throw new Error("INVALID_BASE_SPAWNED"); }
        }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
        /API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID/u,
        `invalid base ${index}`
      );
      assert.equal(calls, 0, `invalid base ${index}`);
    }
  } finally {
    await rm(valid.repositoryRoot, { recursive: true, force: true });
    await Promise.all(invalidFixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("accepted Compose validation accepts only the B2-bound immutable Backend override with pull policy never", async () => {
  const module = await import("./container-runtime.mjs");
  const invalidFixtures = await Promise.all([
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { value.services.backend.image = "backend:latest"; } }),
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { value.services.backend.pull_policy = "always"; } }),
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { delete value.services.backend.pull_policy; } }),
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { value.services.backend.build = { context: "." }; } }),
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { value.services.gateway = { image: "nginx:latest" }; } }),
    acceptedResourceProjectionFixture({ adjustBackendOverride(value) { value.services.backend.image = "${CALLER_IMAGE}"; } }),
    acceptedResourceProjectionFixture({ serializeBackendOverride(value) { return `${JSON.stringify(value, null, 2)}\n`; } })
  ]);
  try {
    for (const [index, fixture] of invalidFixtures.entries()) {
      const observation = await module.createApiOnlyResourceInspectionBridge({
        request: acceptedResourceEngineFixture(fixture).request
      }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
      let spawned = 0;
      await assert.rejects(
        () => module.createApiOnlyAcceptedComposeValidationBridge({
          spawn() { spawned += 1; throw new Error("INVALID_OVERRIDE_SPAWNED"); }
        }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
        /API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID/u,
        `invalid override ${index}`
      );
      assert.equal(spawned, 0, `invalid override ${index}`);
    }
  } finally {
    await Promise.all(invalidFixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("accepted Compose validation derives private inputs and rejects malformed env or unsafe secrets without leakage", async () => {
  const module = await import("./container-runtime.mjs");
  const valid = await acceptedResourceProjectionFixture({
    backendEnvironmentText: "# sealed environment\n\nDATABASE_URL=mysql://shensi_app:private@mysql:3306/shensi\nEMPTY=\nTOKEN_VALUE=cycle-six-secret\n"
  });
  const invalidFixtures = await Promise.all([
    acceptedResourceProjectionFixture({ backendEnvironmentText: "A=one\nA=two\n" }),
    acceptedResourceProjectionFixture({ backendEnvironmentText: "NOT-AN-ENV=value\n" }),
    acceptedResourceProjectionFixture({ backendEnvironmentText: " leading=value\n" }),
    acceptedResourceProjectionFixture({ backendEnvironmentText: "\uFEFFAPI_KEY=secret-bom-canary\n" }),
    acceptedResourceProjectionFixture({ backendEnvironmentText: "API_KEY=secret-nul-canary\0tail\n" })
  ]);
  try {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(valid).request
    }).inspectAcceptedResourceSet(valid.runtime, valid.projection);
    await assert.rejects(
      () => module.createApiOnlyAcceptedComposeValidationBridge().validateAcceptedComposeInputs(valid.runtime, valid.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED/u
    );

    for (const [index, fixture] of invalidFixtures.entries()) {
      const observed = await module.createApiOnlyResourceInspectionBridge({
        request: acceptedResourceEngineFixture(fixture).request
      }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
      let thrown;
      try {
        await module.createApiOnlyAcceptedComposeValidationBridge().validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observed);
      } catch (caught) {
        thrown = caught;
      }
      assert.equal(thrown?.message, "API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID", `invalid env ${index}`);
      for (const canary of ["secret-bom-canary", "secret-nul-canary", "NOT-AN-ENV"]) assert.equal(String(thrown).includes(canary), false);
    }

    const secretPath = join(valid.repositoryRoot, ".runtime", "api-only", "secrets", "mysql_app_password");
    await chmod(secretPath, 0o644);
    await assert.rejects(
      () => module.createApiOnlyAcceptedComposeValidationBridge().validateAcceptedComposeInputs(valid.runtime, valid.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID/u
    );
    await chmod(secretPath, 0o600);
  } finally {
    await rm(valid.repositoryRoot, { recursive: true, force: true });
    await Promise.all(invalidFixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("accepted Compose validation runs only selected config and returns a closed frozen one-use brand", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const processOptions = processFixture({
      close: [0, null],
      output: [["stderr", "successful warning with accepted-compose-secret-canary"]]
    });
    let executableChecks = 0;
    let daemonChecks = 0;
    const result = await module.createApiOnlyAcceptedComposeValidationBridge({
      spawn: processOptions.spawn,
      revalidateExecutable: async (path, runtime) => {
        executableChecks += 1;
        assert.equal(path, fixture.runtime.argvPrefix[0]);
        assert.equal(runtime, fixture.runtime);
        return true;
      },
      probeDaemonIdentity: async (runtime) => {
        daemonChecks += 1;
        assert.equal(runtime, fixture.runtime);
        return runtime.daemon.identity;
      }
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);

    assert.equal(executableChecks, 1);
    assert.equal(daemonChecks, 1);
    assert.deepEqual(processFixture.lastChild.call.args, [
      ...fixture.runtime.argvPrefix.slice(1),
      "-f", fixture.projection.artifacts.acceptedComposeBase.path,
      "-f", fixture.projection.artifacts.backendImageOverride.path,
      "--project-name", fixture.projection.expectedResources.project,
      "config", "--quiet"
    ]);
    assert.equal(processFixture.lastChild.call.command, fixture.runtime.argvPrefix[0]);
    assert.equal(processFixture.lastChild.call.options.cwd, fixture.versionRoot);
    assert.equal(processFixture.lastChild.call.options.shell, false);
    assert.deepEqual(processFixture.lastChild.call.options.stdio, ["ignore", "pipe", "pipe"]);
    const childEnvironment = processFixture.lastChild.call.options.env;
    assert.equal(childEnvironment.HOME, fixture.runtime.environment.HOME);
    assert.equal(childEnvironment.DOCKER_HOST, `unix://${fixture.runtime.socket.canonicalPath}`);
    assert.equal(childEnvironment.DOCKER_CONFIG, childEnvironment.SHENSI_API_RUNTIME_ROOT);
    assert.equal(childEnvironment.SHENSI_API_HTTP_PORT, "5608");
    assert.equal(childEnvironment.SHENSI_API_MYSQL_HOST_PORT, "3311");
    assert.equal(childEnvironment.SHENSI_API_BACKEND_ENV_FILE, fixture.projection.artifacts.backendEnvironment.path);
    assert.equal(childEnvironment.SHENSI_API_GATEWAY_CONFIG_FILE, fixture.projection.artifacts.gatewayConfig.path);
    assert.equal(childEnvironment.COMPOSE_FILE, undefined);
    assert.equal(childEnvironment.LEAKED_SECRET, undefined);

    assert.deepEqual(Object.keys(result), [
      "schema", "version", "authorityKind", "versionId", "projectName", "socketIdentity",
      "daemonIdentity", "runtimeNonce", "base", "backendOverride", "backendEnvironment",
      "gatewayConfig", "acceptedResources", "secretRoles", "inputsSha256"
    ]);
    assert.equal(result.schema, "shensi.api-only-validated-version-compose-inputs");
    assert.equal(result.version, 1);
    assert.equal(result.authorityKind, "accepted");
    assert.equal(result.versionId, fixture.projection.pointer.versionId);
    assert.equal(result.projectName, fixture.projection.expectedResources.project);
    assert.deepEqual(result.base, fixture.projection.artifacts.acceptedComposeBase);
    assert.deepEqual(result.backendOverride, {
      ...fixture.projection.artifacts.backendImageOverride,
      imageIdDigest: fixture.projection.expectedResources.backend.imageIdDigest,
      composeImageReference: fixture.projection.expectedResources.backend.composeImageReference
    });
    assert.deepEqual(result.backendEnvironment, fixture.projection.artifacts.backendEnvironment);
    assert.deepEqual(result.gatewayConfig, fixture.projection.artifacts.gatewayConfig);
    assert.deepEqual(result.acceptedResources, fixture.projection.artifacts.acceptedResources);
    assert.deepEqual(result.secretRoles, ["mysql_app_password", "mysql_root_password"]);
    assert.match(result.inputsSha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(result), true);
    for (const nested of Object.values(result)) if (nested && typeof nested === "object") assert.equal(Object.isFrozen(nested), true);
    assert.equal(JSON.stringify(result).includes("accepted-compose-secret-canary"), false);
    assert.equal(Object.hasOwn(result, "output"), false);

    const assertUnsupported = async (options) => {
      let thrown;
      try {
        await module.createApiOnlyAcceptedComposeValidationBridge(options)
          .validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
      } catch (caught) {
        thrown = caught;
      }
      assert.equal(thrown?.message, "API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED");
      assert.equal(String(thrown).includes("process-secret-canary"), false);
    };
    await assertUnsupported({ ...pickAcceptedComposeProcessOptions(processFixture({ syncThrow: "API_KEY=process-secret-canary" })) });
    await assertUnsupported({ ...pickAcceptedComposeProcessOptions(processFixture({ close: [7, null], output: [["stderr", "API_KEY=process-secret-canary"]] })) });
    await assertUnsupported({ ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null], output: [["stdout", Buffer.alloc(9_000, 0x61)]] })) });
    await assertUnsupported({ revalidateExecutable: async () => false });
    await assertUnsupported({ revalidateExecutable: async () => true, probeDaemonIdentity: async () => resourceHex("f") });

    let statCalls = 0;
    let driftSpawned = 0;
    const driftProcess = processFixture({ close: [0, null] });
    await assert.rejects(
      () => module.createApiOnlyAcceptedComposeValidationBridge({
        ...pickAcceptedComposeProcessOptions(driftProcess),
        open: async (path, flags, mode) => {
          const handle = await nativeOpen(path, flags, mode);
          if (path !== fixture.projection.artifacts.acceptedComposeBase.path) return handle;
          return {
            async stat(...args) {
              statCalls += 1;
              const info = await handle.stat(...args);
              if (statCalls >= 4) return new Proxy(info, { get(target, property) { return property === "ino" ? target.ino + 1 : Reflect.get(target, property, target); } });
              return info;
            },
            read: (...args) => handle.read(...args),
            close: (...args) => handle.close(...args)
          };
        },
        spawn(...args) { driftSpawned += 1; return driftProcess.spawn(...args); }
      }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation),
      /API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID/u
    );
    assert.equal(driftSpawned, 1);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted lifecycle bridge exposes one closed method and authenticates matching Task 1 B2 B3-R and one-use B3-C authority before effects", async () => {
  const module = await import("./container-runtime.mjs");
  assert.equal(typeof module.createApiOnlyAcceptedLifecycleExecutionBridge, "function");
  assert.throws(
    () => module.createApiOnlyAcceptedLifecycleExecutionBridge({ unknown: () => undefined }),
    /API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID/u
  );
  assert.throws(
    () => module.createApiOnlyAcceptedLifecycleExecutionBridge({ request: "not-a-function" }),
    /API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID/u
  );
  const fixture = await acceptedResourceProjectionFixture();
  try {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const render = processFixture({ close: [0, null] });
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(render),
      revalidateExecutable: async () => true,
      probeDaemonIdentity: async () => fixture.runtime.daemon.identity
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    let effects = 0;
    const forbidden = async () => { effects += 1; throw new Error("LIFECYCLE_EFFECT_FORBIDDEN"); };
    const bridge = module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: forbidden,
      execFile: forbidden,
      lstat: forbidden,
      realpath: forbidden,
      readlink: forbidden,
      access: forbidden,
      open: forbidden,
      mkdir: forbidden,
      chmod: forbidden,
      rename: forbidden,
      unlink: forbidden,
      getuid: forbidden,
      spawn: forbidden,
      setTimeout: forbidden,
      clearTimeout: forbidden,
      revalidateExecutable: forbidden,
      probeDaemonIdentity: forbidden,
      monotonicNow: forbidden,
      now: forbidden
    });
    assert.deepEqual(Object.keys(bridge), ["runAcceptedLifecycleOperation"]);
    assert.equal(typeof bridge.runAcceptedLifecycleOperation, "function");

    await assert.rejects(
      () => bridge.runAcceptedLifecycleOperation({}, fixture.projection, observation, validatedInputs, "status"),
      /COMPOSE_RUNTIME_UNTRUSTED/u
    );
    await assert.rejects(
      () => bridge.runAcceptedLifecycleOperation(fixture.runtime, {}, observation, validatedInputs, "status"),
      /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u
    );
    await assert.rejects(
      () => bridge.runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, structuredClone(observation), validatedInputs, "status"),
      /API_ONLY_ACCEPTED_LIFECYCLE_AUTHORITY_REQUIRED/u
    );
    await assert.rejects(
      () => bridge.runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, structuredClone(validatedInputs), "status"),
      /API_ONLY_ACCEPTED_LIFECYCLE_AUTHORITY_REQUIRED/u
    );
    await assert.rejects(
      () => bridge.runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, validatedInputs, "destroy"),
      /API_ONLY_ACCEPTED_LIFECYCLE_OPERATION_INVALID/u
    );
    assert.equal(effects, 0);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted status runs only the fixed selected ps read and returns bounded identity-bound normalized services without raw output", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const createAuthority = async () => {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const render = processFixture({ close: [0, null] });
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(render),
      revalidateExecutable: async () => true,
      probeDaemonIdentity: async () => fixture.runtime.daemon.identity
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    return { observation, validatedInputs };
  };
  try {
    const rows = [
      { ID: fixture.projection.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy", Unknown: "discard" },
      { ID: resourceHex("d"), Service: "backend", State: "running", Health: "healthy" },
      { ID: resourceHex("e"), Service: "gateway", State: "running", Health: "" }
    ];
    const statusProcess = processFixture({ close: [0, null], output: [["stdout", JSON.stringify(rows)]] });
    const postEngine = acceptedResourceEngineFixture(fixture);
    const { observation, validatedInputs } = await createAuthority();
    const result = await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: postEngine.request,
      ...pickAcceptedComposeProcessOptions(statusProcess)
    }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, validatedInputs, "status");

    assert.deepEqual(processFixture.lastChild.call.args, [
      ...fixture.runtime.argvPrefix.slice(1),
      "-f", fixture.projection.artifacts.acceptedComposeBase.path,
      "-f", fixture.projection.artifacts.backendImageOverride.path,
      "--project-name", fixture.projection.expectedResources.project,
      "ps", "--format", "json"
    ]);
    assert.equal(processFixture.lastChild.call.command, fixture.runtime.argvPrefix[0]);
    assert.equal(processFixture.lastChild.call.options.cwd, fixture.versionRoot);
    assert.deepEqual(Object.keys(result), ["operation", "outcome", "services", "observation"]);
    assert.deepEqual(result.services, [
      { service: "mysql", state: "running", health: "healthy" },
      { service: "backend", state: "running", health: "healthy" },
      { service: "gateway", state: "running", health: "none" }
    ]);
    assert.equal(result.operation, "status");
    assert.equal(result.outcome, "observed");
    assert.equal(result.observation.matched, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.services), true);
    assert.equal(Object.hasOwn(result, "output"), false);
    assert.equal(JSON.stringify(result).includes("discard"), false);

    for (const invalidRows of [
      [{ ...rows[0], ID: resourceHex("f") }, rows[1], rows[2]],
      [rows[0], rows[0]],
      [{ ...rows[0], Service: "foreign" }]
    ]) {
      const authority = await createAuthority();
      const invalidProcess = processFixture({ close: [0, null], output: [["stdout", JSON.stringify(invalidRows)]] });
      await assert.rejects(
        () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
          request: acceptedResourceEngineFixture(fixture).request,
          ...pickAcceptedComposeProcessOptions(invalidProcess)
        }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, authority.observation, authority.validatedInputs, "status"),
        /API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID/u
      );
    }

    const oversized = await createAuthority();
    const oversizedProcess = processFixture({ close: [0, null], output: [["stdout", Buffer.alloc(9_000, 0x61)]] });
    await assert.rejects(
      () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: acceptedResourceEngineFixture(fixture).request,
        ...pickAcceptedComposeProcessOptions(oversizedProcess)
      }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, oversized.observation, oversized.validatedInputs, "status"),
      /API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID/u
    );
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted mutation derives the exact B1 claim and permits only start mysql up no-build backend gateway or stop", async () => {
  const module = await import("./container-runtime.mjs");
  const fixtures = await Promise.all([
    acceptedResourceProjectionFixture(),
    acceptedResourceProjectionFixture(),
    acceptedResourceProjectionFixture()
  ]);
  const stopped = (container) => {
    container.State = { Status: "exited", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  const created = (container) => {
    container.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  const cases = [
    {
      fixture: fixtures[0],
      operation: "start-mysql",
      adjustPre(exact) { created(exact.mysql); },
      expectedTail: ["start", "mysql"]
    },
    {
      fixture: fixtures[1],
      operation: "start-runtime",
      adjustPre(exact) { stopped(exact.backend); stopped(exact.gateway); },
      expectedTail: ["up", "-d", "--no-build", "--no-deps", "backend", "gateway"]
    },
    {
      fixture: fixtures[2],
      operation: "stop",
      adjustPre() {},
      adjustPost(exact) { stopped(exact.mysql); stopped(exact.backend); stopped(exact.gateway); },
      expectedTail: ["stop"]
    }
  ];
  try {
    for (const item of cases) {
      const preEngine = acceptedResourceEngineFixture(item.fixture, { adjustExact: item.adjustPre });
      const observation = await module.createApiOnlyResourceInspectionBridge({ request: preEngine.request })
        .inspectAcceptedResourceSet(item.fixture.runtime, item.fixture.projection);
      const render = processFixture({ close: [0, null] });
      const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
        ...pickAcceptedComposeProcessOptions(render)
      }).validateAcceptedComposeInputs(item.fixture.runtime, item.fixture.projection, observation);
      const lifecycleEngine = acceptedLifecycleRequestFixture(item.fixture, {
        adjustPreExact: item.adjustPre,
        adjustPostExact: item.adjustPost
      });
      const route = routeInspectionFixture({
        output: [
          "Routing tables", "", "Internet:",
          "Destination        Gateway            Flags               Netif Expire",
          "default            192.168.50.1       UGScg                 en0", ""
        ].join("\n")
      });
      const process = processFixture({ close: [0, null] });
      const result = await module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: lifecycleEngine.request,
        ...acceptedLifecycleRouteSeams(route),
        ...pickAcceptedComposeProcessOptions(process)
      }).runAcceptedLifecycleOperation(item.fixture.runtime, item.fixture.projection, observation, validatedInputs, item.operation);

      assert.deepEqual(processFixture.lastChild.call.args, [
        ...item.fixture.runtime.argvPrefix.slice(1),
        "-f", item.fixture.projection.artifacts.acceptedComposeBase.path,
        "-f", item.fixture.projection.artifacts.backendImageOverride.path,
        "--project-name", item.fixture.projection.expectedResources.project,
        ...item.expectedTail
      ]);
      assert.equal(processFixture.lastChild.call.command, item.fixture.runtime.argvPrefix[0]);
      assert.equal(processFixture.lastChild.call.options.cwd, item.fixture.versionRoot);
      assert.deepEqual(Object.keys(result), ["operation", "outcome", "observation"]);
      assert.equal(result.operation, item.operation);
      assert.equal(result.outcome, "applied");
      assert.equal(result.observation.matched, true);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(processFixture.lastChild.call.options.env.SHENSI_API_INTERNAL_SUBNET, item.fixture.projection.expectedResources.networks.internal.subnet);
      assert.equal(processFixture.lastChild.call.options.env.SHENSI_API_IPAM_GATEWAY, item.fixture.projection.expectedResources.networks.internal.ipamGatewayIp);
      assert.equal(processFixture.lastChild.call.options.env.SHENSI_API_GATEWAY_IP, item.fixture.projection.expectedResources.networks.internal.gatewayServiceIp);
      assert.equal(processFixture.lastChild.call.options.env.SHENSI_API_RUNTIME_NONCE, item.fixture.projection.expectedResources.runtimeNonce);
      assert.equal(processFixture.lastChild.call.options.env.SHENSI_API_DAEMON_IDENTITY, item.fixture.runtime.daemon.identity);
      assert.equal(route.calls.length, 4);
      assert.equal(lifecycleEngine.networks.calls.length, 4);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("accepted mutation atomically persists and reads back the bounded exact intent before any child spawn", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const createdAt = "2026-09-04T01:02:03.000Z";
  const createMysql = (exact) => {
    exact.mysql.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  try {
    const preEngine = acceptedResourceEngineFixture(fixture, { adjustExact: createMysql });
    const observation = await module.createApiOnlyResourceInspectionBridge({ request: preEngine.request })
      .inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const render = processFixture({ close: [0, null] });
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(render)
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    const lifecycleEngine = acceptedLifecycleRequestFixture(fixture, { adjustPreExact: createMysql });
    const route = routeInspectionFixture({
      output: [
        "Routing tables", "", "Internet:",
        "Destination        Gateway            Flags               Netif Expire",
        "default            192.168.50.1       UGScg                 en0", ""
      ].join("\n")
    });
    const statePath = join(
      dirname(dirname(fixture.versionRoot)),
      "evidence", "accepted-compose-mutations",
      fixture.projection.pointer.versionId,
      fixture.projection.pointer.recordSha256,
      "state-v1.json"
    );
    const pendingPath = join(dirname(statePath), ".pending-state-v1.json");
    let snapshotAtSpawn = null;
    const process = processFixture({ close: [0, null] });
    const spawn = process.spawn;
    process.spawn = (...args) => {
      const bytes = readFileSync(statePath);
      snapshotAtSpawn = { bytes, value: JSON.parse(bytes.toString("utf8")) };
      assert.equal(readFileSync(statePath, "utf8"), `${JSON.stringify(snapshotAtSpawn.value)}\n`);
      assert.throws(() => readFileSync(pendingPath), /ENOENT/u);
      return spawn(...args);
    };

    await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: lifecycleEngine.request,
      ...acceptedLifecycleRouteSeams(route),
      ...pickAcceptedComposeProcessOptions(process),
      now: () => createdAt
    }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, validatedInputs, "start-mysql");

    assert.ok(snapshotAtSpawn);
    assert.ok(snapshotAtSpawn.bytes.length > 0 && snapshotAtSpawn.bytes.length <= 65_536);
    assert.deepEqual(Object.keys(snapshotAtSpawn.value), ["schema", "version", "authority", "revision", "nextSequence", "active", "settlement"]);
    assert.equal(snapshotAtSpawn.value.schema, "shensi.api-only.accepted-operation-state");
    assert.equal(snapshotAtSpawn.value.version, 1);
    assert.deepEqual(snapshotAtSpawn.value.authority, {
      versionId: fixture.projection.pointer.versionId,
      recordSha256: fixture.projection.pointer.recordSha256,
      projectName: fixture.projection.expectedResources.project,
      runtimeNonce: fixture.projection.expectedResources.runtimeNonce,
      inputsSha256: validatedInputs.inputsSha256
    });
    assert.equal(snapshotAtSpawn.value.revision, 1);
    assert.equal(snapshotAtSpawn.value.nextSequence, 2);
    assert.equal(snapshotAtSpawn.value.settlement, null);
    assert.deepEqual(Object.keys(snapshotAtSpawn.value.active), [
      "sequence", "operationId", "operation", "inputSha256",
      "preIdentitySha256", "preStateSha256", "createdAt"
    ]);
    assert.equal(snapshotAtSpawn.value.active.sequence, 1);
    assert.match(snapshotAtSpawn.value.active.operationId, /^[a-f0-9]{64}$/u);
    assert.equal(snapshotAtSpawn.value.active.operation, "start-mysql");
    assert.equal(snapshotAtSpawn.value.active.inputSha256, validatedInputs.inputsSha256);
    assert.equal(snapshotAtSpawn.value.active.preIdentitySha256, observation.identitySha256);
    assert.equal(snapshotAtSpawn.value.active.preStateSha256, observation.stateSha256);
    assert.equal(snapshotAtSpawn.value.active.createdAt, createdAt);
    const stat = await lstat(statePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted operation recovery rejects a syntactically valid but impossible next transition", async () => {
  const module = await import("./container-runtime.mjs");
  const fixture = await acceptedResourceProjectionFixture();
  const createdMysql = (exact) => {
    exact.mysql.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  try {
    const initialObservation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture, { adjustExact: createdMysql }).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const initialInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] }))
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, initialObservation);
    const route = routeInspectionFixture({
      output: ["Routing tables", "", "Internet:", "Destination Gateway Flags Netif", "default 192.168.1.1 UGScg en0", ""].join("\n")
    });
    await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: acceptedLifecycleRequestFixture(fixture, { adjustPreExact: createdMysql }).request,
      ...acceptedLifecycleRouteSeams(route),
      ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] })),
      now: () => "2026-09-04T01:10:00.000Z"
    }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, initialObservation, initialInputs, "start-mysql");

    const statePath = join(
      dirname(dirname(fixture.versionRoot)), "evidence", "accepted-compose-mutations",
      fixture.projection.pointer.versionId, fixture.projection.pointer.recordSha256, "state-v1.json"
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.active, null);
    const impossible = { ...state, revision: state.revision + 1 };
    await writeFile(join(dirname(statePath), ".pending-state-v1.json"), `${JSON.stringify(impossible)}\n`, { mode: 0o600 });

    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] }))
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    let lifecycleSpawns = 0;
    const statusRows = [
      { ID: fixture.projection.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy" },
      { ID: resourceHex("d"), Service: "backend", State: "running", Health: "healthy" },
      { ID: resourceHex("e"), Service: "gateway", State: "running", Health: "" }
    ];
    const statusProcess = processFixture({ close: [0, null], output: [["stdout", JSON.stringify(statusRows)]] });
    await assert.rejects(
      () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: acceptedLifecycleRequestFixture(fixture).request,
        ...pickAcceptedComposeProcessOptions(statusProcess),
        spawn(...args) { lifecycleSpawns += 1; return statusProcess.spawn(...args); }
      }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, validatedInputs, "status"),
      /API_ONLY_ACCEPTED_OPERATION_STATE_INVALID/u
    );
    assert.equal(lifecycleSpawns, 0);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("accepted operation recovery rejects impossible visible history and settlement combinations", async () => {
  const module = await import("./container-runtime.mjs");
  const createdMysql = (exact) => {
    exact.mysql.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  const cases = [
    (state) => ({ ...state, revision: state.revision + 20 }),
    (state) => ({ ...state, settlement: { ...state.settlement, disposition: "retry_safe" } })
  ];
  for (const corrupt of cases) {
    const fixture = await acceptedResourceProjectionFixture();
    try {
      const initialObservation = await module.createApiOnlyResourceInspectionBridge({
        request: acceptedResourceEngineFixture(fixture, { adjustExact: createdMysql }).request
      }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
      const initialInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
        ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] }))
      }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, initialObservation);
      const route = routeInspectionFixture({
        output: ["Routing tables", "", "Internet:", "Destination Gateway Flags Netif", "default 192.168.1.1 UGScg en0", ""].join("\n")
      });
      await module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: acceptedLifecycleRequestFixture(fixture, { adjustPreExact: createdMysql }).request,
        ...acceptedLifecycleRouteSeams(route),
        ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] })),
        now: () => "2026-09-04T01:11:00.000Z"
      }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, initialObservation, initialInputs, "start-mysql");

      const statePath = join(
        dirname(dirname(fixture.versionRoot)), "evidence", "accepted-compose-mutations",
        fixture.projection.pointer.versionId, fixture.projection.pointer.recordSha256, "state-v1.json"
      );
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, `${JSON.stringify(corrupt(state))}\n`, { mode: 0o600 });

      const observation = await module.createApiOnlyResourceInspectionBridge({
        request: acceptedResourceEngineFixture(fixture).request
      }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
      const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
        ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] }))
      }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
      let lifecycleSpawns = 0;
      const statusRows = [
        { ID: fixture.projection.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy" },
        { ID: resourceHex("d"), Service: "backend", State: "running", Health: "healthy" },
        { ID: resourceHex("e"), Service: "gateway", State: "running", Health: "" }
      ];
      const statusProcess = processFixture({ close: [0, null], output: [["stdout", JSON.stringify(statusRows)]] });
      await assert.rejects(
        () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
          request: acceptedLifecycleRequestFixture(fixture).request,
          ...pickAcceptedComposeProcessOptions(statusProcess),
          spawn(...args) { lifecycleSpawns += 1; return statusProcess.spawn(...args); }
        }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, observation, validatedInputs, "status"),
        /API_ONLY_ACCEPTED_OPERATION_STATE_INVALID/u
      );
      assert.equal(lifecycleSpawns, 0);
    } finally {
      await rm(fixture.repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("accepted lifecycle reconciles an exact outstanding target without spawn and blocks every unresolved non-target intent", async () => {
  const module = await import("./container-runtime.mjs");
  const fixtures = await Promise.all([
    acceptedResourceProjectionFixture(), acceptedResourceProjectionFixture(), acceptedResourceProjectionFixture()
  ]);
  const createdMysql = (exact) => {
    exact.mysql.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  const routeOutput = [
    "Routing tables", "", "Internet:",
    "Destination        Gateway            Flags               Netif Expire",
    "default            192.168.50.1       UGScg                 en0", ""
  ].join("\n");
  const authority = async (fixture, adjustExact) => {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture, { adjustExact }).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const render = processFixture({ close: [0, null] });
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(render)
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    return { observation, validatedInputs };
  };
  const leaveOutstandingIntent = async (fixture) => {
    const initial = await authority(fixture, createdMysql);
    const engine = acceptedLifecycleRequestFixture(fixture, {
      adjustPreExact: createdMysql,
      adjustPostInventories(inventories) {
        inventories.containers.push({ Id: resourceHex("f"), Labels: { "com.docker.compose.project": fixture.projection.expectedResources.project } });
      }
    });
    const route = routeInspectionFixture({ output: routeOutput });
    const process = processFixture({ close: [0, null] });
    await assert.rejects(
      () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: engine.request,
        ...acceptedLifecycleRouteSeams(route),
        ...pickAcceptedComposeProcessOptions(process),
        now: () => "2026-09-04T01:02:03.000Z"
      }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, initial.observation, initial.validatedInputs, "start-mysql"),
      /API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED/u
    );
  };
  try {
    await leaveOutstandingIntent(fixtures[0]);
    const target = await authority(fixtures[0]);
    let spawned = 0;
    const targetEngine = acceptedLifecycleRequestFixture(fixtures[0]);
    const targetRoute = routeInspectionFixture({ output: routeOutput });
    const reconciled = await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: targetEngine.request,
      ...acceptedLifecycleRouteSeams(targetRoute),
      ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] })),
      spawn() { spawned += 1; throw new Error("RECONCILIATION_SPAWN_FORBIDDEN"); },
      revalidateExecutable: async () => true,
      probeDaemonIdentity: async (runtime) => runtime.daemon.identity,
      monotonicNow: () => 0,
      now: () => "2026-09-04T01:03:00.000Z"
    }).runAcceptedLifecycleOperation(fixtures[0].runtime, fixtures[0].projection, target.observation, target.validatedInputs, "start-mysql");
    assert.equal(spawned, 0);
    assert.equal(reconciled.outcome, "reconciled_target");
    const reconciledPath = join(
      dirname(dirname(fixtures[0].versionRoot)), "evidence", "accepted-compose-mutations",
      fixtures[0].projection.pointer.versionId, fixtures[0].projection.pointer.recordSha256, "state-v1.json"
    );
    const reconciledState = JSON.parse(await readFile(reconciledPath, "utf8"));
    assert.equal(reconciledState.active, null);
    assert.equal(reconciledState.settlement.outcome, "reconciled_target");
    assert.equal(reconciledState.settlement.disposition, "complete");
    assert.equal(reconciledState.settlement.postIdentitySha256, target.observation.identitySha256);
    assert.equal(reconciledState.settlement.postStateSha256, target.observation.stateSha256);

    await leaveOutstandingIntent(fixtures[1]);
    const stillCreated = await authority(fixtures[1], createdMysql);
    let blockedSpawn = 0;
    const blockedEngine = acceptedLifecycleRequestFixture(fixtures[1], { adjustPreExact: createdMysql, adjustPostExact: createdMysql });
    const blockedRoute = routeInspectionFixture({ output: routeOutput });
    await assert.rejects(
      () => module.createApiOnlyAcceptedLifecycleExecutionBridge({
        request: blockedEngine.request,
        ...acceptedLifecycleRouteSeams(blockedRoute),
        ...pickAcceptedComposeProcessOptions(processFixture({ close: [0, null] })),
        spawn() { blockedSpawn += 1; throw new Error("BLOCKED_SPAWN_FORBIDDEN"); }
      }).runAcceptedLifecycleOperation(fixtures[1].runtime, fixtures[1].projection, stillCreated.observation, stillCreated.validatedInputs, "start-mysql"),
      /API_ONLY_ACCEPTED_OPERATION_RECONCILIATION_REQUIRED/u
    );
    assert.equal(blockedSpawn, 0);

    await leaveOutstandingIntent(fixtures[2]);
    const statusTarget = await authority(fixtures[2]);
    const statusRows = [
      { ID: fixtures[2].projection.expectedResources.mysql.containerId, Service: "mysql", State: "running", Health: "healthy" },
      { ID: resourceHex("d"), Service: "backend", State: "running", Health: "healthy" },
      { ID: resourceHex("e"), Service: "gateway", State: "running", Health: "" }
    ];
    const statusProcess = processFixture({ close: [0, null], output: [["stdout", JSON.stringify(statusRows)]] });
    const statusEngine = acceptedLifecycleRequestFixture(fixtures[2]);
    const statusResult = await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: statusEngine.request,
      ...pickAcceptedComposeProcessOptions(statusProcess),
      now: () => "2026-09-04T01:04:00.000Z"
    }).runAcceptedLifecycleOperation(
      fixtures[2].runtime, fixtures[2].projection, statusTarget.observation, statusTarget.validatedInputs, "status"
    );
    assert.equal(statusResult.outcome, "observed");
    assert.deepEqual(processFixture.lastChild.call.args.slice(-3), ["ps", "--format", "json"]);
    const statusStatePath = join(
      dirname(dirname(fixtures[2].versionRoot)), "evidence", "accepted-compose-mutations",
      fixtures[2].projection.pointer.versionId, fixtures[2].projection.pointer.recordSha256, "state-v1.json"
    );
    const statusState = JSON.parse(await readFile(statusStatePath, "utf8"));
    assert.equal(statusState.active, null);
    assert.equal(statusState.settlement.outcome, "reconciled_target");
    assert.equal(statusState.settlement.disposition, "complete");
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("accepted mutation records complete retry-safe or fail-closed settlement without leaking child or secret data", async () => {
  const module = await import("./container-runtime.mjs");
  const fixtures = await Promise.all([
    acceptedResourceProjectionFixture(),
    acceptedResourceProjectionFixture(),
    acceptedResourceProjectionFixture()
  ]);
  const createdMysql = (exact) => {
    exact.mysql.State = { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0 };
  };
  const unhealthyMysql = (exact) => {
    exact.mysql.State = { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0, Health: { Status: "unhealthy" } };
  };
  const routeOutput = [
    "Routing tables", "", "Internet:",
    "Destination        Gateway            Flags               Netif Expire",
    "default            192.168.50.1       UGScg                 en0", ""
  ].join("\n");
  const authority = async (fixture) => {
    const observation = await module.createApiOnlyResourceInspectionBridge({
      request: acceptedResourceEngineFixture(fixture, { adjustExact: createdMysql }).request
    }).inspectAcceptedResourceSet(fixture.runtime, fixture.projection);
    const render = processFixture({ close: [0, null] });
    const validatedInputs = await module.createApiOnlyAcceptedComposeValidationBridge({
      ...pickAcceptedComposeProcessOptions(render)
    }).validateAcceptedComposeInputs(fixture.runtime, fixture.projection, observation);
    return { observation, validatedInputs };
  };
  const statePath = (fixture) => join(
    dirname(dirname(fixture.versionRoot)), "evidence", "accepted-compose-mutations",
    fixture.projection.pointer.versionId, fixture.projection.pointer.recordSha256, "state-v1.json"
  );
  const run = async (fixture, input, { adjustPost, process, now }) => {
    const engine = acceptedLifecycleRequestFixture(fixture, { adjustPreExact: createdMysql, adjustPostExact: adjustPost });
    const route = routeInspectionFixture({ output: routeOutput });
    return await module.createApiOnlyAcceptedLifecycleExecutionBridge({
      request: engine.request,
      ...acceptedLifecycleRouteSeams(route),
      ...pickAcceptedComposeProcessOptions(process),
      now: () => now
    }).runAcceptedLifecycleOperation(fixture.runtime, fixture.projection, input.observation, input.validatedInputs, "start-mysql");
  };
  try {
    const appliedInput = await authority(fixtures[0]);
    const applied = await run(fixtures[0], appliedInput, {
      process: processFixture({ close: [0, null], output: [["stdout", "accepted-compose-secret-canary"]] }),
      now: "2026-09-04T02:00:00.000Z"
    });
    assert.equal(applied.outcome, "applied");
    const appliedText = await readFile(statePath(fixtures[0]), "utf8");
    const appliedState = JSON.parse(appliedText);
    assert.equal(appliedState.active, null);
    assert.equal(appliedState.settlement.outcome, "applied");
    assert.equal(appliedState.settlement.disposition, "complete");
    assert.equal(appliedText.includes("accepted-compose-secret-canary"), false);
    assert.equal(appliedText.includes("stdout"), false);
    assert.equal(appliedText.includes(fixtures[0].repositoryRoot), false);

    const retryInput = await authority(fixtures[1]);
    await assert.rejects(
      () => run(fixtures[1], retryInput, {
        adjustPost: createdMysql,
        process: processFixture({ close: [7, null], output: [["stderr", "accepted-compose-secret-canary raw-child-detail"]] }),
        now: "2026-09-04T02:01:00.000Z"
      }),
      (error) => error?.message === "API_ONLY_ACCEPTED_OPERATION_RETRY_SAFE"
    );
    const retryText = await readFile(statePath(fixtures[1]), "utf8");
    const retryState = JSON.parse(retryText);
    assert.equal(retryState.active, null);
    assert.equal(retryState.settlement.outcome, "no_effect");
    assert.equal(retryState.settlement.disposition, "retry_safe");
    assert.equal(retryText.includes("accepted-compose-secret-canary"), false);
    assert.equal(retryText.includes("raw-child-detail"), false);

    const unsafeInput = await authority(fixtures[2]);
    await assert.rejects(
      () => run(fixtures[2], unsafeInput, {
        adjustPost: unhealthyMysql,
        process: processFixture({ close: [0, null], output: [["stdout", "accepted-compose-secret-canary raw-child-detail"]] }),
        now: "2026-09-04T02:02:00.000Z"
      }),
      (error) => error?.message === "API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED"
    );
    const unsafeText = await readFile(statePath(fixtures[2]), "utf8");
    const unsafeState = JSON.parse(unsafeText);
    assert.equal(unsafeState.active, null);
    assert.equal(unsafeState.settlement.outcome, "unsafe");
    assert.equal(unsafeState.settlement.disposition, "fail_closed");
    assert.equal(unsafeText.includes("accepted-compose-secret-canary"), false);
    assert.equal(unsafeText.includes("raw-child-detail"), false);
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture.repositoryRoot, { recursive: true, force: true })));
  }
});

test("metadata-first discovery trusts os.userInfo, ignores ambient HOME/DOCKER_HOST, and uses Docker Desktop context", async () => {
  const fixture = discoveryFixture(); const runtime = await runtimeFrom(fixture);
  assert.deepEqual(runtime.socket, { canonicalPath: "/Users/alice/.docker/run/docker.sock", identity: runtime.socket.identity, provider: "docker-desktop", profile: "desktop-linux" });
  assert.deepEqual(runtime.argvPrefix, ["/Applications/Docker.app/Contents/Resources/bin/docker", "compose"]);
  assert.deepEqual(Object.keys(fixture.calls.find(({ type }) => type === "compose-version").options.env).sort(), ["DOCKER_HOST", "HOME", "PATH"]);
  assert.equal(runtime.environment.HOME, "/Users/alice"); assert.equal(runtime.environment.LEAKED_SECRET, undefined);
  assert.equal(fixture.calls.some(({ command, args = [] }) => /(?:open|colima)$/u.test(command ?? "") || args.join(" ").includes("context use")), false);
});

test("only SHENSI_DOCKER_HOST overrides metadata; stale metadata falls back to a unique arbitrary Colima profile", async () => {
  const profileSocket = "/Users/alice/.colima/work/docker.sock";
  assert.equal((await runtimeFrom(discoveryFixture({ profiles: ["work"], healthy: [profileSocket], explicit: `unix://${profileSocket}` }))).socket.provider, "explicit");
  await assert.rejects(() => runtimeFrom(discoveryFixture({ explicit: "tcp://127.0.0.1:2375" })), /DOCKER_HOST_UNIX_SOCKET_REQUIRED/u);
  await assert.rejects(() => runtimeFrom(discoveryFixture({ explicit: "unix:///Users/alice/.colima/work/../work/docker.sock" })), /DOCKER_HOST_UNIX_SOCKET_REQUIRED/u);
  const unique = await runtimeFrom(discoveryFixture({ contextHost: "unix:///Users/alice/.docker/run/missing.sock", profiles: ["work", "other"], healthy: [profileSocket] }));
  assert.equal(unique.socket.profile, "work");
  await assert.rejects(() => runtimeFrom(discoveryFixture({ contextHost: "unix:///Users/alice/.docker/run/missing.sock", profiles: ["work", "other"], healthy: [profileSocket, "/Users/alice/.colima/other/docker.sock"] })), /DOCKER_SOCKET_AMBIGUOUS/u);
  const oversized = discoveryFixture({ contextHost: "unix:///Users/alice/.docker/run/missing.sock", profiles: ["work"], healthy: [profileSocket] });
  oversized.nodes.get("/Users/alice/.colima/work/colima.yaml").bytes = Buffer.alloc(70_000, 0x61);
  await assert.rejects(() => runtimeFrom(oversized), /DOCKER_SOCKET_REQUIRED/u);
});

test("safe root-owned executable symlink chains work; broken links fall back; writable ancestors fail", async () => {
  assert.equal((await runtimeFrom()).compose.kind, "docker-compose-plugin");
  assert.equal((await runtimeFrom(discoveryFixture({ dockerBroken: true }))).compose.kind, "standalone");
  await assert.rejects(() => runtimeFrom(discoveryFixture({ unsafeBinaryParent: true })), /COMPOSE_EXECUTABLE_REQUIRED/u);
});

test("system socket fallback bounds and validates the complete root-owned symlink chain", async () => {
  const fixture = discoveryFixture({ explicit: "unix:///var/run/docker.sock", healthy: ["/Users/alice/.docker/run/docker.sock"] });
  fixture.add("/var", entry("dir", { uid: 0, mode: 0o755 }));
  fixture.add("/var/run", entry("dir", { uid: 0, mode: 0o755 }));
  fixture.add("/var/run/docker.sock", entry("link", { uid: 0, mode: 0o777, target: "/Users/alice/.docker/run/docker.sock" }));
  assert.equal((await runtimeFrom(fixture)).socket.canonicalPath, "/Users/alice/.docker/run/docker.sock");
  fixture.nodes.get("/var/run").mode = 0o777;
  await assert.rejects(() => runtimeFrom(fixture), /DOCKER_SOCKET_REQUIRED/u);
});

test("socket/daemon identities are stable across engine software upgrades and unsafe metadata/socket/daemon fail closed", async () => {
  const first = await runtimeFrom(); const secondFixture = discoveryFixture(); const original = secondFixture.daemonRequest;
  secondFixture.daemonRequest = async (path, socket, options) => path === "/info" ? { ...(await original(path, socket, options)), ServerVersion: "99" } : original(path, socket, options);
  const second = await runtimeFrom(secondFixture); assert.equal(second.socket.identity, first.socket.identity); assert.equal(second.daemon.identity, first.daemon.identity);
  const badMetadata = discoveryFixture(); badMetadata.nodes.get("/Users/alice/.docker/config.json").mode = 0o666;
  await assert.rejects(() => runtimeFrom(badMetadata), /DOCKER_METADATA_INVALID/u);
  const badSocket = discoveryFixture(); badSocket.nodes.get("/Users/alice/.docker/run/docker.sock").mode = 0o660;
  await assert.rejects(() => runtimeFrom(badSocket), /DOCKER_SOCKET_REQUIRED/u);
  await assert.rejects(() => runtimeFrom(discoveryFixture({ healthy: [] })), /DOCKER_SOCKET_REQUIRED/u);
});

async function recordFixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".task1-runtime-record-")); await chmod(root, 0o700); t.after(async () => rm(root, { recursive: true, force: true }));
  const runtime = await runtimeFrom();
  const claim = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [], issuedAt: "2026-09-04T00:00:00.000Z" }).claim;
  return { root, runtime, ownership: { projectName: "shensi-api", networkClaim: claim } };
}

test("selection record is fixed-path canonical JSON with exact deeply frozen schema", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t); const written = await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" });
  assert.equal(runtimeSelectionPath(root), join(root, "container-runtime-selection.json"));
  assert.equal(await readFile(runtimeSelectionPath(root), "utf8"), `${JSON.stringify(written)}\n`);
  assert.deepEqual(Object.keys(written), ["schema", "version", "createdAt", "runtime", "ownership"]); assert.equal((await lstat(runtimeSelectionPath(root))).mode & 0o777, 0o600);
  const checked = await assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }); assert.equal(checked.toolchainChanged, false); assert.equal(Object.isFrozen(checked.record.ownership.networkClaim.expectedLabels), true);
  const invalidDate = { ...written, createdAt: "9999-99-99T99:99:99.999Z" };
  await writeFile(runtimeSelectionPath(root), `${JSON.stringify(invalidDate)}\n`, { mode: 0o600 });
  await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
});

test("selection record rejects extra/duplicate fields, wrong mode/hard links/ancestor symlinks", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t); await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" }); const path = runtimeSelectionPath(root); const valid = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify({ ...valid, extra: true })}\n`, { mode: 0o600 }); await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  await writeFile(path, `{"schema":"shensi.container-runtime-selection","schema":"duplicate"}\n`, { mode: 0o600 }); await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  await writeFile(path, `${JSON.stringify(valid)}\n`); await chmod(path, 0o644); await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  await chmod(path, 0o600); await link(path, join(root, "hard.json")); await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  const parent = await mkdtemp(join(process.cwd(), ".task1-runtime-link-")); t.after(async () => rm(parent, { recursive: true, force: true })); const actual = join(parent, "actual"); await mkdir(actual, { mode: 0o700 }); await symlink(actual, join(parent, "linked"));
  await assert.rejects(() => writeRuntimeSelection(join(parent, "linked"), runtime, ownership), /RUNTIME_SELECTION_ROOT_INVALID/u);
});

test("record crash behavior preserves old pre-rename and recovers valid visible post-rename data", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t); await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" }); const old = await readFile(runtimeSelectionPath(root), "utf8");
  await assert.rejects(() => writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:01.000Z", beforeRename() { throw new Error("PROCESS_CRASH"); } }), /PROCESS_CRASH/u); assert.equal(await readFile(runtimeSelectionPath(root), "utf8"), old);
  await assert.rejects(() => writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:02.000Z", afterRename() { throw new Error("OS_CRASH_WINDOW"); } }), /OS_CRASH_WINDOW/u);
  assert.equal((await assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE })).record.createdAt, "2026-09-04T00:00:02.000Z");
});

test("record file-sync failure preserves the old record and never promotes its orphan temporary", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t);
  await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" });
  const old = await readFile(runtimeSelectionPath(root), "utf8");
  await assert.rejects(() => writeRuntimeSelection(root, runtime, ownership, {
    createdAt: "2026-09-04T00:00:01.000Z",
    async open(path, flags, mode) {
      const handle = await nativeOpen(path, flags, mode);
      if (String(path).endsWith(".tmp")) handle.sync = async () => { throw new Error("FILE_SYNC_FAILED"); };
      return handle;
    }
  }), /FILE_SYNC_FAILED/u);
  assert.equal(await readFile(runtimeSelectionPath(root), "utf8"), old);
});

test("record rejects engine drift and reports Compose-only drift separately", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t); await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" });
  const upgradedFixture = discoveryFixture(); upgradedFixture.composeVersion = async () => "v9.9.9"; assert.equal((await assertRuntimeSelection(root, await runtimeFrom(upgradedFixture), { projectName: "shensi-api", runtimeNonce: NONCE })).toolchainChanged, true);
  const changed = discoveryFixture(); const original = changed.daemonRequest; changed.daemonRequest = async (path, socket, options) => path === "/info" ? { ...(await original(path, socket, options)), ID: "different" } : original(path, socket, options);
  const changedRuntime = await runtimeFrom(changed);
  await assert.rejects(() => assertRuntimeSelection(root, changedRuntime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_ENGINE_IDENTITY_MISMATCH/u);
});

test("record rejects a valid claim minted for another runtime and noncanonical or unbounded argv", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t);
  const otherFixture = discoveryFixture();
  const request = otherFixture.daemonRequest;
  otherFixture.daemonRequest = async (path, socket, options) => path === "/info" ? { ...(await request(path, socket, options)), ID: "different-daemon" } : request(path, socket, options);
  const otherRuntime = await runtimeFrom(otherFixture);
  const otherClaim = allocateApiOnlyNetwork({ runtime: otherRuntime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.251.0/24"], daemonNetworks: [], hostRoutes: [] }).claim;
  await assert.rejects(() => writeRuntimeSelection(root, runtime, { ...ownership, networkClaim: otherClaim }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  const written = await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" });
  for (const executable of ["/usr/../usr/local/bin/docker", `/usr/local/bin/${"x".repeat(4_097)}`, "/usr/local/bin/docker\0hidden"]) {
    const invalid = structuredClone(written);
    invalid.runtime.compose.argvPrefix[0] = executable;
    await writeFile(runtimeSelectionPath(root), `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
    await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }), /RUNTIME_SELECTION_RECORD_INVALID/u);
  }
});

test("record rejects post-open chmod, chown, link-count, and size changes on descriptor or pathname", async (t) => {
  const { root, runtime, ownership } = await recordFixture(t);
  const path = runtimeSelectionPath(root);
  const mutations = {
    mode(stat) { stat.mode = (stat.mode & ~0o777) | 0o644; },
    uid(stat) { stat.uid += 1; },
    nlink(stat) { stat.nlink += 1; },
    size(stat) { stat.size += 1; }
  };
  for (const [name, mutate] of Object.entries(mutations)) for (const surface of ["descriptor", "pathname"]) {
    await writeRuntimeSelection(root, runtime, ownership, { createdAt: "2026-09-04T00:00:00.000Z" });
    const dependencies = surface === "descriptor" ? {
      async open(openPath, flags, mode) {
        const handle = await nativeOpen(openPath, flags, mode); let stats = 0;
        return {
          async stat() { const stat = await handle.stat(); stats += 1; if (stats > 1) mutate(stat); return stat; },
          async readFile() { return await handle.readFile(); },
          async close() { await handle.close(); }
        };
      }
    } : {
      async lstat(statPath) { const stat = await lstat(statPath); if (statPath === path) mutate(stat); return stat; }
    };
    await assert.rejects(() => assertRuntimeSelection(root, runtime, { projectName: "shensi-api", runtimeNonce: NONCE }, dependencies), /RUNTIME_SELECTION_RECORD_INVALID/u, `${surface}:${name}`);
  }
});

test("network allocation enforces brand/entropy/canonical address/protected range/all inventories", async () => {
  const runtime = await runtimeFrom(); assert.throws(() => allocateApiOnlyNetwork({ runtime: {}, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }), /COMPOSE_RUNTIME_UNTRUSTED/u);
  assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: "short", candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }), /API_NETWORK_OWNERSHIP_REQUIRED/u);
  for (const candidate of ["172.30.0.0/23", "172.30.0.0/24", "198.18.250.1/24"]) assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: [candidate], daemonNetworks: [], hostRoutes: [] }));
  for (const gatewayServiceIp of ["198.18.250.0", "198.18.250.255", "198.18.251.2", "198.018.250.2", "198.18.250.1"]) assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, gatewayServiceIp, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }), /API_NETWORK_GATEWAY_INVALID/u);
  for (const ipamGatewayIp of ["198.18.250.0", "198.18.250.255", "198.18.251.1", "198.018.250.1", "198.18.250.254"]) assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, ipamGatewayIp, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }), /API_NETWORK_GATEWAY_INVALID/u);
  assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [{ cidr: "198.18.250.0/25" }] }), /API_NETWORK_SUBNET_UNAVAILABLE/u);
  assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [{ id: "n", name: "foreign", subnets: [{ subnet: "10.0.0.0/24" }, { subnet: "198.18.250.0/24" }], labels: {} }], hostRoutes: [] }), /API_NETWORK_SUBNET_UNAVAILABLE/u);
});

test("complete macOS VPN split-default routes do not exhaust API-only benchmark candidates", async () => {
  const runtime = await runtimeFrom();
  const splitDefaultRoutes = [
    "1.0.0.0/8", "2.0.0.0/7", "4.0.0.0/6", "8.0.0.0/5",
    "16.0.0.0/4", "32.0.0.0/3", "64.0.0.0/2", "128.0.0.0/1"
  ].map((cidr) => ({ cidr }));
  const input = {
    runtime,
    projectName: "shensi-api",
    runtimeNonce: NONCE,
    candidates: ["198.18.250.0/24"],
    daemonNetworks: [],
    hostRoutes: splitDefaultRoutes
  };

  const allocation = allocateApiOnlyNetwork(input);
  assert.equal(allocation.subnet, "198.18.250.0/24");
  await assert.doesNotReject(() => revalidateApiOnlyNetworkClaim({
    runtime,
    claim: allocation.claim,
    expectedProjectName: "shensi-api",
    expectedRuntimeNonce: NONCE,
    inspectDaemonNetworks: async () => [],
    readHostIpv4Routes: async () => splitDefaultRoutes
  }));

  const specificConflict = [...splitDefaultRoutes, { cidr: "198.18.250.0/25" }];
  assert.throws(() => allocateApiOnlyNetwork({ ...input, hostRoutes: specificConflict }), /API_NETWORK_SUBNET_UNAVAILABLE/u);
  await assert.rejects(() => revalidateApiOnlyNetworkClaim({
    runtime,
    claim: allocation.claim,
    expectedProjectName: "shensi-api",
    expectedRuntimeNonce: NONCE,
    inspectDaemonNetworks: async () => [],
    readHostIpv4Routes: async () => specificConflict
  }), /API_NETWORK_CLAIM_CONFLICT/u);

  assert.throws(() => allocateApiOnlyNetwork({ ...input, hostRoutes: [{ cidr: "128.0.0.0/1" }] }), /API_NETWORK_SUBNET_UNAVAILABLE/u);
});

test("claim exact schema binds labels and existing network ID/name; revalidation is fresh and fail-closed", async () => {
  const runtime = await runtimeFrom(); const labels = { "com.docker.compose.project": "shensi-api", "com.docker.compose.network": "shensi_internal", "io.shensi.api.runtime-nonce": NONCE, "io.shensi.api.daemon-identity": runtime.daemon.identity, "com.docker.compose.version": "2.31.0" };
  const owned = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [{ id: "network-id", name: "shensi-api_shensi_internal", subnets: [{ subnet: "198.18.250.0/24", gateway: "198.18.250.1" }], labels }], hostRoutes: [] }).claim;
  assert.deepEqual(owned.existingNetwork, { id: "network-id", name: "shensi-api_shensi_internal" }); assert.deepEqual(Object.keys(owned), ["schema", "version", "issuedAt", "socketIdentity", "daemonIdentity", "projectName", "networkName", "runtimeNonce", "subnet", "ipamGatewayIp", "gatewayServiceIp", "expectedLabels", "existingNetwork"]);
  const fresh = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.251.0/24"], daemonNetworks: [], hostRoutes: [] }).claim;
  await assert.rejects(() => revalidateApiOnlyNetworkClaim({ runtime, claim: fresh, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => null, readHostIpv4Routes: async () => [] }), /API_NETWORK_INVENTORY_INVALID/u);
  await assert.rejects(() => revalidateApiOnlyNetworkClaim({ runtime, claim: fresh, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [{ id: "foreign", name: "foreign", subnets: [{ subnet: fresh.subnet }], labels: {} }], readHostIpv4Routes: async () => [] }), /API_NETWORK_CLAIM_CONFLICT/u);
  assert.throws(() => allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [{ id: "network-id", name: "shensi-api_shensi_internal", subnets: [{ subnet: "198.18.250.0/24", gateway: "198.18.250.3" }], labels }], hostRoutes: [] }), /API_NETWORK_SUBNET_UNAVAILABLE/u);
});

test("reusable network claims require the exact derived physical network name", async () => {
  const runtime = await runtimeFrom();
  const labels = {
    "com.docker.compose.project": "shensi-api",
    "com.docker.compose.network": "shensi_internal",
    "io.shensi.api.runtime-nonce": NONCE,
    "io.shensi.api.daemon-identity": runtime.daemon.identity
  };
  const wrongNetwork = {
    id: "network-id",
    name: "renamed_shensi_internal",
    subnets: [{ subnet: "198.18.250.0/24", gateway: "198.18.250.1" }],
    labels
  };
  const valid = allocateApiOnlyNetwork({
    runtime,
    projectName: "shensi-api",
    runtimeNonce: NONCE,
    candidates: ["198.18.250.0/24"],
    daemonNetworks: [{ ...wrongNetwork, name: "shensi-api_shensi_internal" }],
    hostRoutes: []
  }).claim;
  const tampered = structuredClone(valid);
  tampered.existingNetwork.name = wrongNetwork.name;
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => allocateApiOnlyNetwork({
      runtime,
      projectName: "shensi-api",
      runtimeNonce: NONCE,
      candidates: ["198.18.250.0/24"],
      daemonNetworks: [wrongNetwork],
      hostRoutes: []
    })),
    revalidateApiOnlyNetworkClaim({
      runtime,
      claim: tampered,
      expectedProjectName: "shensi-api",
      expectedRuntimeNonce: NONCE,
      inspectDaemonNetworks: async () => [wrongNetwork],
      readHostIpv4Routes: async () => []
    })
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status === "rejected" ? outcome.reason.message : "fulfilled"), [
    "API_NETWORK_SUBNET_UNAVAILABLE",
    "API_NETWORK_CLAIM_INVALID"
  ]);
});

test("network claim keeps the Gateway service on the last usable address, away from Docker dynamic allocation", async () => {
  const runtime = await runtimeFrom();
  const labels = { "com.docker.compose.project": "shensi-api", "com.docker.compose.network": "shensi_internal", "io.shensi.api.runtime-nonce": NONCE, "io.shensi.api.daemon-identity": runtime.daemon.identity };
  const allocation = allocateApiOnlyNetwork({
    runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"],
    daemonNetworks: [{ id: "network-id", name: "shensi-api_shensi_internal", subnets: [{ subnet: "198.18.250.0/24", gateway: "198.18.250.1" }], labels }], hostRoutes: []
  });
  assert.equal(allocation.claim.ipamGatewayIp, "198.18.250.1");
  assert.equal(allocation.claim.gatewayServiceIp, "198.18.250.254");
  assert.notEqual(allocation.claim.ipamGatewayIp, allocation.claim.gatewayServiceIp);
  assert.deepEqual(allocation.claim.existingNetwork, { id: "network-id", name: "shensi-api_shensi_internal" });
});

function processFixture({ authorization, now = () => 0, close, signalResults = {}, output = [], spawnError, syncThrow } = {}) {
  return { timeoutMs: 100, termGraceMs: 10, closeGraceMs: 10, networkAuthorization: authorization, monotonicNow: now, revalidateExecutable: async () => true, probeDaemonIdentity: async (runtime) => runtime.daemon.identity,
    spawn(command, args, options) { if (syncThrow) throw new Error(syncThrow); const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = (signal) => signalResults[signal] ?? true; child.call = { command, args, options }; processFixture.lastChild = child; queueMicrotask(() => { for (const [stream, value] of output) child[stream].write(value); if (spawnError) child.emit("error", new Error(spawnError)); if (close) child.emit("close", ...close); }); return child; }
  };
}

function pickAcceptedComposeProcessOptions(options) {
  return {
    spawn: options.spawn,
    revalidateExecutable: options.revalidateExecutable,
    probeDaemonIdentity: options.probeDaemonIdentity,
    monotonicNow: options.monotonicNow
  };
}

async function privateComposeInputs(t, runtime, claim) {
  const root = await mkdtemp(join(process.cwd(), ".task1-compose-env-"));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(["backend.env", "mysql-app", "mysql-root", "gateway.conf"].map((name) => [name, join(root, name)]));
  for (const path of Object.values(paths)) await writeFile(path, "private", { mode: 0o600 });
  const input = {
    SHENSI_API_BACKEND_ENV_FILE: paths["backend.env"],
    SHENSI_API_MYSQL_APP_PASSWORD_FILE: paths["mysql-app"],
    SHENSI_API_MYSQL_ROOT_PASSWORD_FILE: paths["mysql-root"],
    SHENSI_API_GATEWAY_CONFIG_FILE: paths["gateway.conf"],
    SHENSI_API_RUNTIME_ROOT: root,
    SHENSI_API_HTTP_PORT: "5628",
    SHENSI_API_MYSQL_HOST_PORT: "3312",
    SHENSI_API_INTERNAL_SUBNET: claim.subnet,
    SHENSI_API_IPAM_GATEWAY: claim.ipamGatewayIp,
    SHENSI_API_GATEWAY_IP: claim.gatewayServiceIp,
    SHENSI_API_RUNTIME_NONCE: claim.runtimeNonce,
    SHENSI_API_DAEMON_IDENTITY: claim.daemonIdentity
  };
  return { root, paths, input };
}

test("claim-derived mutation environment is exact, socket-pinned, private-input-bound, and rechecked", async (t) => {
  const runtime = await runtimeFrom();
  const claim = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }).claim;
  const auth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => 0 });
  const { root, paths, input } = await privateComposeInputs(t, runtime, claim);
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, {}, root), /API_ONLY_COMPOSE_INPUT_INVALID/u);
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, { ...input, DOCKER_HOST: "unix:///other/docker.sock" }, root), /API_ONLY_COMPOSE_INPUT_INVALID/u);
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, { ...input, PARENT_SECRET: "leak" }, root), /API_ONLY_COMPOSE_INPUT_INVALID/u);
  const validated = await validateApiOnlyComposeInputs(runtime, input, root);
  assert.throws(() => composeEnvironmentForNetworkClaim(runtime, auth, input), /API_ONLY_COMPOSE_INPUT_REQUIRED/u);
  const environment = composeEnvironmentForNetworkClaim(runtime, auth, validated);
  assert.equal(environment.DOCKER_HOST, `unix://${runtime.socket.canonicalPath}`);
  assert.equal(environment.DOCKER_CONFIG, root);
  assert.equal(environment.PARENT_SECRET, undefined);
  assert.deepEqual(Object.keys(environment).sort(), ["DOCKER_CONFIG", "DOCKER_HOST", "HOME", "PATH", ...Object.keys(input)].sort());
  await chmod(paths["mysql-app"], 0o644);
  await assert.rejects(() => runResolvedCompose(runtime, ["up"], { ...processFixture({ authorization: auth, close: [0, null] }), environment }), /API_ONLY_PRIVATE_FILE_INVALID/u);
});

test("authorization is short-lived/one-use, derives environment, and post-create inspector is exact", async (t) => {
  const runtime = await runtimeFrom(); const claim = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }).claim; let now = 100;
  const { root, input } = await privateComposeInputs(t, runtime, claim); const validated = await validateApiOnlyComposeInputs(runtime, input, root);
  const auth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => now });
  assert.match(auth.bindingHash, /^[a-f0-9]{64}$/u);
  const env = composeEnvironmentForNetworkClaim(runtime, auth, validated); assert.equal(env.SHENSI_API_INTERNAL_SUBNET, claim.subnet); assert.equal(env.SHENSI_API_RUNTIME_NONCE, NONCE);
  now = 10_000; await assert.rejects(() => runResolvedCompose(runtime, ["up"], processFixture({ authorization: auth, now: () => now })), /API_NETWORK_AUTHORIZATION_EXPIRED/u);
  now = 101;
  const missingEnvAuth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => now });
  await assert.rejects(() => runResolvedCompose(runtime, ["up"], processFixture({ authorization: missingEnvAuth, now: () => now, close: [0, null] })), /API_NETWORK_ENVIRONMENT_REQUIRED/u);
  const fresh = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => now });
  const options = { ...processFixture({ authorization: fresh, now: () => now, close: [0, null] }), environment: composeEnvironmentForNetworkClaim(runtime, fresh, validated) };
  await runResolvedCompose(runtime, ["up"], options); await assert.rejects(() => runResolvedCompose(runtime, ["up"], options), /API_NETWORK_AUTHORIZATION_USED/u);
  const inspectGatewayService = async () => ({ networkName: "shensi-api_shensi_internal", ipv4Address: claim.gatewayServiceIp });
  assert.deepEqual(await verifyApiOnlyNetworkAfterCreate({ runtime, authorization: fresh, inspectNetwork: async () => ({ id: "created", name: "shensi-api_shensi_internal", subnets: [{ subnet: claim.subnet, gateway: claim.ipamGatewayIp }], labels: claim.expectedLabels }), inspectGatewayService }), { id: "created", name: "shensi-api_shensi_internal" });
  await assert.rejects(() => verifyApiOnlyNetworkAfterCreate({ runtime, authorization: fresh, inspectNetwork: async () => ({ id: "wrong", name: "wrong", subnets: [{ subnet: claim.subnet, gateway: claim.ipamGatewayIp }], labels: {} }), inspectGatewayService }), /API_NETWORK_POST_CREATE_MISMATCH/u);
});

test("post-create inspection independently verifies IPAM router and Gateway service addresses", async (t) => {
  const runtime = await runtimeFrom();
  const claim = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }).claim;
  const auth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => 0 });
  const { root, input } = await privateComposeInputs(t, runtime, claim); const validated = await validateApiOnlyComposeInputs(runtime, input, root);
  await runResolvedCompose(runtime, ["up"], { ...processFixture({ authorization: auth, close: [0, null] }), environment: composeEnvironmentForNetworkClaim(runtime, auth, validated) });
  const inspectNetwork = async () => ({ id: "created", name: "shensi-api_shensi_internal", subnets: [{ subnet: claim.subnet, gateway: claim.ipamGatewayIp }], labels: claim.expectedLabels });
  await assert.rejects(() => verifyApiOnlyNetworkAfterCreate({ runtime, authorization: auth, inspectNetwork, inspectGatewayService: async () => ({ networkName: "shensi-api_shensi_internal", ipv4Address: claim.ipamGatewayIp }) }), /API_NETWORK_POST_CREATE_MISMATCH/u);
  await assert.doesNotReject(() => verifyApiOnlyNetworkAfterCreate({ runtime, authorization: auth, inspectNetwork, inspectGatewayService: async () => ({ networkName: "shensi-api_shensi_internal", ipv4Address: claim.gatewayServiceIp }) }));
});

function fakeTimers() {
  let now = 0; let nextId = 1; let clears = 0; const queue = new Map();
  return {
    setTimeout(fn, delay) { const id = nextId++; queue.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { clears += 1; queue.delete(id); },
    advance(delta) { const end = now + delta; while (true) { const due = [...queue].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; queue.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; },
    now: () => now,
    pending: () => queue.size,
    clears: () => clears
  };
}

test("injected timers prove TERM then KILL then authoritative close ordering", async () => {
  const runtime = await runtimeFrom(); const timers = fakeTimers(); const signals = [];
  const options = processFixture();
  options.setTimeout = timers.setTimeout; options.clearTimeout = timers.clearTimeout; options.monotonicNow = timers.now;
  options.spawn = (command, args, spawnOptions) => {
    const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { signals.push(signal); if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; };
    child.call = { command, args, options: spawnOptions }; return child;
  };
  const pending = runResolvedCompose(runtime, ["config"], options);
  await Promise.resolve(); await Promise.resolve();
  timers.advance(100); assert.deepEqual(signals, ["SIGTERM"]);
  timers.advance(10); assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(pending, /COMPOSE_COMMAND_TIMEOUT/u);
});

test("process boundary enforces argv, stdin, environment, and an independently proven byte cap", async () => {
  const runtime = await runtimeFrom(); await assert.rejects(() => runResolvedCompose(runtime, ["config", "bad\0arg"], processFixture()), /COMPOSE_ARGUMENT_INVALID/u); await assert.rejects(() => runResolvedCompose(runtime, Array.from({ length: 300 }, () => "x"), processFixture()), /COMPOSE_ARGUMENT_INVALID/u);
  const result = await runResolvedCompose(runtime, ["config", "--quiet"], processFixture({ close: [0, null], output: [["stdout", Buffer.alloc(9_000, 0x61)]] }));
  assert.deepEqual(processFixture.lastChild.call.args, ["compose", "config", "--quiet"]); assert.deepEqual(processFixture.lastChild.call.options.stdio, ["ignore", "pipe", "pipe"]); assert.equal(processFixture.lastChild.call.options.shell, false); assert.equal(Buffer.byteLength(result.output) <= 8_192, true); assert.equal(result.truncated, true);
});

test("process redaction removes retained inline, YAML block, multiline, and exact sensitive values", async () => {
  const runtime = await runtimeFrom();
  const raw = [
    "Bearer bearer-value",
    "https://user:uri-pass@example.test",
    "API_KEY: 'inline-secret'",
    "PASSWORD: |",
    "  multiline-secret-one",
    "  multiline-secret-two",
    "TOKEN: >-",
    "  folded-secret",
    "safe: visible",
    "exact opaque value"
  ].join("\n");
  const result = await runResolvedCompose(runtime, ["config", "--quiet"], { ...processFixture({ close: [0, null], output: [["stderr", raw]] }), sensitiveValues: ["exact opaque value"] });
  assert.equal(result.truncated, false);
  assert.match(result.output, /safe: visible/u);
  for (const secret of ["bearer-value", "uri-pass", "inline-secret", "multiline-secret-one", "multiline-secret-two", "folded-secret", "exact opaque value"])
    assert.doesNotMatch(result.output, new RegExp(secret, "u"));
});

test("YAML block redaction handles comments and indent/chomp indicators without swallowing safe siblings", async () => {
  const runtime = await runtimeFrom();
  const raw = [
    "PASSWORD: | # generated by Compose",
    "  literal-comment-secret-one",
    "  literal-comment-secret-two",
    "safe_top: visible-top",
    "nested:",
    "  TOKEN: >- # folded secret",
    "    folded-comment-secret-one",
    "    folded-comment-secret-two",
    "  safe_nested: visible-nested",
    "API_KEY: |2- # explicit indentation then chomp",
    "    explicit-indent-secret",
    "safe_after_indent: visible-after-indent",
    "CREDENTIAL: >+2 # chomp then indentation",
    "    explicit-chomp-secret",
    "safe_after_chomp: visible-after-chomp"
  ].join("\n");
  const result = await runResolvedCompose(runtime, ["config", "--quiet"], processFixture({ close: [0, null], output: [["stderr", raw]] }));
  for (const secret of ["literal-comment-secret-one", "literal-comment-secret-two", "folded-comment-secret-one", "folded-comment-secret-two", "explicit-indent-secret", "explicit-chomp-secret"])
    assert.doesNotMatch(result.output, new RegExp(secret, "u"));
  for (const safe of ["safe_top: visible-top", "safe_nested: visible-nested", "safe_after_indent: visible-after-indent", "safe_after_chomp: visible-after-chomp"])
    assert.match(result.output, new RegExp(safe, "u"));
});

test("YAML block redaction accepts tab-separated comments without allowing tab indentation", async () => {
  const runtime = await runtimeFrom();
  const raw = [
    "PASSWORD: |2-\t# literal indent then chomp",
    "    literal-forward-secret",
    "safe_literal_forward: visible",
    "SECRET: |-2\t# literal chomp then indent",
    "    literal-reverse-secret",
    "safe_literal_reverse: visible",
    "nested:",
    "  TOKEN: >2+\t# folded indent then chomp",
    "      folded-forward-secret",
    "  safe_folded_forward: visible",
    "  CREDENTIAL: >+2\t# folded chomp then indent",
    "      folded-reverse-secret",
    "  safe_folded_reverse: visible"
  ].join("\n");
  const result = await runResolvedCompose(runtime, ["config", "--quiet"], processFixture({ close: [0, null], output: [["stderr", raw]] }));
  for (const secret of ["literal-forward-secret", "literal-reverse-secret", "folded-forward-secret", "folded-reverse-secret"])
    assert.doesNotMatch(result.output, new RegExp(secret, "u"));
  for (const safe of ["safe_literal_forward: visible", "safe_literal_reverse: visible", "safe_folded_forward: visible", "safe_folded_reverse: visible"])
    assert.match(result.output, new RegExp(safe, "u"));
});

test("process event ordering waits for close and bounds TERM/KILL/indeterminate paths", async () => {
  const runtime = await runtimeFrom(); await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture({ syncThrow: "API_KEY=sync-secret" })), (error) => /COMPOSE_COMMAND_SPAWN_FAILED/u.test(error.message) && !error.message.includes("sync-secret"));
  await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture({ spawnError: "late error", close: [1, null] })), /COMPOSE_COMMAND_FAILED/u); await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture({ close: [7, null] })), /COMPOSE_COMMAND_FAILED:7/u);
  await assert.rejects(() => runResolvedCompose(runtime, ["config"], { ...processFixture(), timeoutMs: 99 }), /COMPOSE_TIMEOUT_INVALID/u); await assert.rejects(() => runResolvedCompose(runtime, ["config"], { ...processFixture(), timeoutMs: 700_000 }), /COMPOSE_TIMEOUT_INVALID/u);
  await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture({ signalResults: { SIGTERM: false } })), /COMPOSE_COMMAND_INDETERMINATE:TERM_FAILED/u); await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture({ signalResults: { SIGKILL: false } })), /COMPOSE_COMMAND_INDETERMINATE:KILL_FAILED/u); await assert.rejects(() => runResolvedCompose(runtime, ["config"], processFixture()), /COMPOSE_COMMAND_CLOSE_UNCONFIRMED/u);
});

test("mutation requires fresh executable/daemon checks and private authorization; CLI is render-only", async (t) => {
  const runtime = await runtimeFrom(); await assert.rejects(() => runResolvedCompose(runtime, ["up"], processFixture({ close: [0, null] })), /API_NETWORK_AUTHORIZATION_REQUIRED/u);
  const claim = allocateApiOnlyNetwork({ runtime, projectName: "shensi-api", runtimeNonce: NONCE, candidates: ["198.18.250.0/24"], daemonNetworks: [], hostRoutes: [] }).claim;
  const { root, input } = await privateComposeInputs(t, runtime, claim); const validated = await validateApiOnlyComposeInputs(runtime, input, root);
  let auth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => 0 }); await assert.rejects(() => runResolvedCompose(runtime, ["up"], { ...processFixture({ authorization: auth, close: [0, null] }), environment: composeEnvironmentForNetworkClaim(runtime, auth, validated), revalidateExecutable: async () => false }), /COMPOSE_EXECUTABLE_CHANGED/u);
  auth = await revalidateApiOnlyNetworkClaim({ runtime, claim, expectedProjectName: "shensi-api", expectedRuntimeNonce: NONCE, inspectDaemonNetworks: async () => [], readHostIpv4Routes: async () => [], monotonicNow: () => 0 }); await assert.rejects(() => runResolvedCompose(runtime, ["up"], { ...processFixture({ authorization: auth, close: [0, null] }), environment: composeEnvironmentForNetworkClaim(runtime, auth, validated), probeDaemonIdentity: async () => "different" }), /RUNTIME_ENGINE_IDENTITY_MISMATCH/u);
  assert.doesNotThrow(() => assertRenderOnlyComposeArgs(["-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api-contract", "config", "--quiet"]));
  for (const verb of ["up", "create", "start", "restart", "stop", "down", "rm", "kill", "pause", "unpause", "run", "exec", "pull", "push", "build"]) assert.throws(() => assertRenderOnlyComposeArgs([verb]), /CONTAINER_RUNTIME_MUTATION_FORBIDDEN/u);
});

test("render-only grammar locates the actual subcommand and permits only reviewed config syntax", () => {
  assert.doesNotThrow(() => assertRenderOnlyComposeArgs(["-f", "deploy/compose.api-only.yaml", "--project-name", "shensi-api-contract", "config", "--quiet"]));
  for (const args of [
    ["--project-name", "config", "watch"],
    ["--project-name=config", "scale", "backend=1"],
    ["-f", "config", "commit", "backend"],
    ["config", "--quiet", "watch"],
    ["config", "--profiles"],
    ["--ansi", "config", "config"]
  ]) assert.throws(() => assertRenderOnlyComposeArgs(args), /CONTAINER_RUNTIME_MUTATION_FORBIDDEN/u, args.join(" "));
  for (const command of ["attach", "build", "commit", "cp", "create", "down", "events", "exec", "export", "images", "kill", "logs", "ls", "pause", "port", "ps", "publish", "pull", "push", "restart", "rm", "run", "scale", "start", "stats", "stop", "top", "unpause", "up", "version", "wait", "watch"])
    assert.throws(() => assertRenderOnlyComposeArgs([command]), /CONTAINER_RUNTIME_MUTATION_FORBIDDEN/u, command);
});

test("private Compose inputs include 0600 gateway snapshot beneath exact 0700 runtime root", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".task1-compose-inputs-")); await chmod(root, 0o700); t.after(async () => rm(root, { recursive: true, force: true })); const names = ["backend.env", "mysql-app", "mysql-root", "gateway.conf"]; for (const name of names) await writeFile(join(root, name), "non-secret", { mode: 0o600 }); const runtime = await runtimeFrom();
  const environment = { SHENSI_API_BACKEND_ENV_FILE: join(root, names[0]), SHENSI_API_MYSQL_APP_PASSWORD_FILE: join(root, names[1]), SHENSI_API_MYSQL_ROOT_PASSWORD_FILE: join(root, names[2]), SHENSI_API_GATEWAY_CONFIG_FILE: join(root, names[3]), SHENSI_API_RUNTIME_ROOT: root, SHENSI_API_HTTP_PORT: "5628", SHENSI_API_MYSQL_HOST_PORT: "3312", SHENSI_API_INTERNAL_SUBNET: "198.18.250.0/24", SHENSI_API_IPAM_GATEWAY: "198.18.250.1", SHENSI_API_GATEWAY_IP: "198.18.250.2", SHENSI_API_RUNTIME_NONCE: NONCE, SHENSI_API_DAEMON_IDENTITY: runtime.daemon.identity };
  await assert.doesNotReject(() => validateApiOnlyComposeInputs(runtime, environment, root)); await chmod(join(root, names[1]), 0o644); await assert.rejects(() => validateApiOnlyComposeInputs(runtime, environment, root), /API_ONLY_PRIVATE_FILE_INVALID/u);
  await chmod(join(root, names[1]), 0o600); await symlink(names[1], join(root, "linked-password"));
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, { ...environment, SHENSI_API_MYSQL_APP_PASSWORD_FILE: join(root, "linked-password") }, root), /API_ONLY_PRIVATE_FILE_INVALID/u);
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, { ...environment, SHENSI_API_MYSQL_APP_PASSWORD_FILE: "relative-password" }, root), /API_ONLY_PRIVATE_PATH_REQUIRED/u);
  await assert.rejects(() => validateApiOnlyComposeInputs(runtime, { ...environment, SHENSI_API_MYSQL_APP_PASSWORD_FILE: join(root, "missing") }, root), /API_ONLY_PRIVATE_FILE_INVALID/u);
});

test("doctor output is safely separated toolchain/socket/daemon evidence", async () => { const summary = doctorSummary(await runtimeFrom()); assert.match(summary, /compose=docker-compose-plugin@v2\.31\.0 socket=docker\.sock profile=docker-desktop:desktop-linux engine=[a-f0-9]{64}/u); assert.doesNotMatch(summary, /Users|DOCKER_HOST|id:|LEAKED/u); });

const BRIDGE_ENGINE_INFO = {
  ID: "id:/Users/alice/.docker/run/docker.sock",
  Name: "engine",
  Driver: "overlay2",
  OSType: "linux",
  Architecture: "aarch64"
};

function engineRequestFixture(responses = {}) {
  const calls = [];
  const resources = [];
  const queues = new Map(Object.entries(responses).map(([path, value]) => [path, Array.isArray(value) ? [...value] : [value]]));
  const nextResponse = (path) => {
    const queued = queues.get(path);
    if (queued?.length) return queued.shift();
    if (path === "/info") return { body: BRIDGE_ENGINE_INFO };
    return { requestError: `unexpected Engine endpoint: ${path}` };
  };
  const request = (options, onResponse) => {
    calls.push(options);
    const outgoing = new EventEmitter();
    const resource = { options, requestDestroyCount: 0, responseDestroyCount: 0, response: null };
    resources.push(resource);
    outgoing.destroy = (error) => { resource.requestDestroyCount += 1; if (error) queueMicrotask(() => outgoing.emit("error", error)); return outgoing; };
    outgoing.end = () => queueMicrotask(() => {
      const spec = nextResponse(options.path) ?? {};
      if (spec.timeout) { outgoing.emit("timeout"); return; }
      if (spec.requestError) { outgoing.emit("error", new Error(spec.requestError)); return; }
      const response = new EventEmitter();
      const body = spec.body === undefined ? "" : typeof spec.body === "string" || Buffer.isBuffer(spec.body) ? spec.body : JSON.stringify(spec.body);
      const chunks = spec.chunks ?? [body];
      const byteLength = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
      response.statusCode = spec.statusCode ?? 200;
      response.headers = {
        "content-type": spec.contentType ?? "application/json; charset=utf-8",
        "content-length": String(spec.contentLength ?? byteLength),
        ...(spec.headers ?? {})
      };
      response.headersDistinct = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value : [value]]));
      response.complete = spec.complete ?? true;
      response.destroy = () => { resource.responseDestroyCount += 1; return response; };
      resource.response = response;
      onResponse(response);
      if (spec.aborted) { response.emit("aborted"); return; }
      for (const chunk of chunks) response.emit("data", chunk);
      if (spec.keepOpen) return;
      response.emit("end");
    });
    return outgoing;
  };
  return { calls, request, resources };
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function rawNetwork({
  id = "1".repeat(64),
  name = "foreign_network",
  config = [{ Subnet: "10.20.0.0/16", Gateway: "10.20.0.1" }],
  labels = { owner: "foreign" }
} = {}) {
  return { Id: id, Name: name, IPAM: { Driver: "default", Options: null, Config: config }, Labels: labels };
}

function rawBuiltinNetworks() {
  return [
    rawNetwork({ id: "b".repeat(64), name: "bridge", config: [{ Subnet: "172.17.0.0/16", Gateway: "172.17.0.1" }], labels: {} }),
    rawNetwork({ id: "c".repeat(64), name: "host", config: null, labels: null }),
    rawNetwork({ id: "d".repeat(64), name: "none", config: [], labels: {} })
  ];
}

function routeInspectionFixture({ mode = 0o755, output, execute } = {}) {
  const fs = virtualFs();
  fs.add("/", entry("dir", { uid: 0, mode: 0o755 }));
  fs.add("/usr", entry("dir", { uid: 0, mode: 0o755 }));
  fs.add("/usr/sbin", entry("dir", { uid: 0, mode }));
  fs.add("/usr/sbin/netstat", entry("file", { uid: 0, mode: 0o755 }));
  const calls = [];
  return {
    ...fs,
    calls,
    async execFile(command, args, options) {
      calls.push({ command, args, options });
      if (execute) return await execute(command, args, options);
      return { stdout: output, stderr: "" };
    }
  };
}

function claimFor(runtime, { existing = false } = {}) {
  const labels = {
    "com.docker.compose.project": "shensi-api",
    "com.docker.compose.network": "shensi_internal",
    "io.shensi.api.runtime-nonce": NONCE,
    "io.shensi.api.daemon-identity": runtime.daemon.identity
  };
  const daemonNetworks = existing ? [{
    id: "2".repeat(64),
    name: "shensi-api_shensi_internal",
    subnets: [{ subnet: "198.18.250.0/24", gateway: "198.18.250.1" }],
    labels
  }] : [];
  return allocateApiOnlyNetwork({
    runtime,
    projectName: "shensi-api",
    runtimeNonce: NONCE,
    candidates: ["198.18.250.0/24"],
    daemonNetworks,
    hostRoutes: [],
    issuedAt: "2026-09-04T00:00:00.000Z"
  }).claim;
}

test("network inspection bridge is frozen and rejects runtime lookalikes", async () => {
  const bridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture().request });
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ["inspectDaemonNetworks", "readHostIpv4Routes", "inspectNetwork", "inspectGatewayService"]);
  await assert.rejects(() => bridge.inspectDaemonNetworks({}), /COMPOSE_RUNTIME_UNTRUSTED/u);
});

test("daemon discovery and bridge reads disable cross-operation HTTP Agent reuse", async () => {
  const fixture = discoveryFixture();
  const runtime = await runtimeFrom(fixture);
  const http = engineRequestFixture({ "/networks": { body: rawBuiltinNetworks() } });
  await createApiOnlyNetworkInspectionBridge({ request: http.request }).inspectDaemonNetworks(runtime);
  assert.deepEqual([
    ...fixture.calls.filter(({ type }) => type === "daemon").map(({ options }) => options.agent),
    ...http.calls.map(({ agent }) => agent)
  ], [false, false, false, false]);

  const pooledOldPeer = engineRequestFixture({ "/networks": { body: rawBuiltinNetworks() } });
  const replacementPeer = engineRequestFixture({ "/info": { body: { ...BRIDGE_ENGINE_INFO, ID: "replacement-engine" } } });
  const fakeAgentRequest = (options, onResponse) => (
    options.agent === false ? replacementPeer : pooledOldPeer
  ).request(options, onResponse);
  await assert.rejects(
    () => createApiOnlyNetworkInspectionBridge({ request: fakeAgentRequest }).inspectDaemonNetworks(runtime),
    /RUNTIME_ENGINE_IDENTITY_MISMATCH/u
  );
  assert.deepEqual(replacementPeer.calls.map(({ path }) => path), ["/info"]);
  assert.deepEqual(pooledOldPeer.calls, []);
});

test("daemon network inspection pins bounded read-only Engine requests and preserves every IPv4 IPAM entry and label", async () => {
  const runtime = await runtimeFrom();
  const expected = [{
    id: "1".repeat(64),
    name: "foreign_network",
    subnets: [
      { subnet: "10.20.0.0/16", gateway: "10.20.0.1" },
      { subnet: "198.18.240.0/20" }
    ],
    labels: { "com.docker.compose.project": "foreign", purpose: "vpn-collision" }
  }];
  const http = engineRequestFixture({
    "/networks": { body: [...rawBuiltinNetworks(), rawNetwork({
      config: [
        { Subnet: "10.20.0.0/16", Gateway: "10.20.0.1" },
        { Subnet: "2001:db8::/64", Gateway: "2001:db8::1" },
        { Subnet: "198.18.240.0/20", Gateway: "" }
      ],
      labels: expected[0].labels
    })] }
  });
  const bridge = createApiOnlyNetworkInspectionBridge({ request: http.request });
  const actual = await bridge.inspectDaemonNetworks(runtime);
  assert.deepEqual(actual.at(-1), expected[0]);
  assert.equal(actual.length, 4);
  assert.equal(Object.isFrozen(actual.at(-1).subnets[0]), true);
  assert.deepEqual(http.calls.map(({ socketPath, path, method }) => ({ socketPath, path, method })), [
    { socketPath: runtime.socket.canonicalPath, path: "/info", method: "GET" },
    { socketPath: runtime.socket.canonicalPath, path: "/networks", method: "GET" }
  ]);
  for (const call of http.calls) {
    assert.equal(Number.isSafeInteger(call.timeout) && call.timeout > 0, true);
    assert.equal(call.hostname, undefined);
  }
});

test("Engine reader fails closed on timeout, status, content type, JSON, partial body, and response overflow", async () => {
  const runtime = await runtimeFrom();
  const failures = [
    { label: "timeout", response: { timeout: true } },
    { label: "status", response: { statusCode: 500, body: { message: "no" } } },
    { label: "content type", response: { contentType: "text/plain", body: "[]" } },
    { label: "JSON", response: { body: "{" } },
    { label: "partial", response: { body: "[]", contentLength: 8, complete: false } },
    { label: "overflow", response: { body: `\"${"x".repeat(1_100_000)}\"` } }
  ];
  for (const { label, response } of failures) {
    const http = engineRequestFixture({ "/networks": response });
    const bridge = createApiOnlyNetworkInspectionBridge({ request: http.request });
    await assert.rejects(() => bridge.inspectDaemonNetworks(runtime), /API_NETWORK_ENGINE_RESPONSE_INVALID/u, label);
  }
});

test("Engine read total deadline rejects a drip-fed open response and destroys both active resources exactly once", async () => {
  const runtime = await runtimeFrom();
  const timers = fakeTimers();
  const http = engineRequestFixture({ "/networks": { body: "[", keepOpen: true } });
  const pending = createApiOnlyNetworkInspectionBridge({ request: http.request, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }).inspectDaemonNetworks(runtime);
  let outcome;
  pending.then((value) => { outcome = value; }, (error) => { outcome = error; });
  await flushMicrotasks();
  const active = http.resources.find(({ options }) => options.path === "/networks");
  assert.ok(active?.response);
  for (let elapsed = 500; elapsed < 3_000; elapsed += 500) {
    timers.advance(500);
    active.response.emit("data", " ");
    await flushMicrotasks(2);
    assert.equal(outcome, undefined);
  }
  timers.advance(500);
  await flushMicrotasks();
  assert.match(outcome?.message ?? "", /API_NETWORK_ENGINE_RESPONSE_INVALID/u);
  assert.equal(active.requestDestroyCount, 1);
  assert.equal(active.responseDestroyCount, 1);
  assert.equal(timers.pending(), 0);
  assert.equal(timers.clears(), 2);
});

test("Engine response-header rejection clears its deadline and destroys the open request and response exactly once", async () => {
  const runtime = await runtimeFrom();
  const timers = fakeTimers();
  const http = engineRequestFixture({ "/networks": { body: "[]", contentType: "text/plain", keepOpen: true } });
  const bridge = createApiOnlyNetworkInspectionBridge({ request: http.request, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await assert.rejects(() => bridge.inspectDaemonNetworks(runtime), /API_NETWORK_ENGINE_RESPONSE_INVALID/u);
  await flushMicrotasks();
  const active = http.resources.find(({ options }) => options.path === "/networks");
  assert.equal(active.requestDestroyCount, 1);
  assert.equal(active.responseDestroyCount, 1);
  assert.equal(timers.pending(), 0);
  assert.equal(timers.clears(), 2);
});

test("daemon network inspection rejects partial, duplicate, noncanonical, and invalid-gateway inventories plus daemon drift", async () => {
  const runtime = await runtimeFrom();
  const duplicateId = "3".repeat(64);
  const invalidBodies = [
    [{ ...rawNetwork(), IPAM: { Driver: "default", Options: null } }],
    [{ Id: "4".repeat(64), Name: "missing-ipam", Labels: {} }],
    [rawNetwork({ config: [{ Subnet: "10.20.1.1/16", Gateway: "10.20.0.1" }] })],
    [rawNetwork({ config: [{ Subnet: "10.20.0.0/16", Gateway: "10.21.0.1" }] })],
    [rawNetwork({ id: duplicateId, name: "one" }), rawNetwork({ id: duplicateId, name: "two" })],
    [rawNetwork({ id: "5".repeat(64), name: "same" }), rawNetwork({ id: "6".repeat(64), name: "same" })],
    [rawNetwork({ config: [{ Subnet: "10.20.0.0/16" }, { Subnet: "10.20.0.0/16" }] })],
    [rawNetwork({ labels: { owner: 7 } })]
  ];
  for (const body of invalidBodies) {
    const bridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture({ "/networks": { body: [...rawBuiltinNetworks(), ...body] } }).request });
    await assert.rejects(() => bridge.inspectDaemonNetworks(runtime), /API_NETWORK_INVENTORY_INVALID/u);
  }
  const drift = engineRequestFixture({ "/info": { body: { ...BRIDGE_ENGINE_INFO, ID: "other-engine" } }, "/networks": { body: [] } });
  await assert.rejects(() => createApiOnlyNetworkInspectionBridge({ request: drift.request }).inspectDaemonNetworks(runtime), /RUNTIME_ENGINE_IDENTITY_MISMATCH/u);
  assert.deepEqual(drift.calls.map(({ path }) => path), ["/info"]);
});

test("unfiltered daemon inventory requires and accepts the complete Linux built-in network baseline", async () => {
  const runtime = await runtimeFrom();
  for (const body of [[], rawBuiltinNetworks().slice(0, 2)]) {
    const bridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture({ "/networks": { body } }).request });
    await assert.rejects(() => bridge.inspectDaemonNetworks(runtime), /API_NETWORK_INVENTORY_INVALID/u);
  }
  const bridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture({ "/networks": { body: rawBuiltinNetworks() } }).request });
  assert.deepEqual((await bridge.inspectDaemonNetworks(runtime)).map(({ name }) => name), ["bridge", "host", "none"]);
});

test("IPv6 IPAM is strictly validated before omission from the IPv4 collision inventory", async () => {
  const runtime = await runtimeFrom();
  const valid = rawNetwork({
    name: "dual_stack",
    config: [
      { Subnet: "2001:db8::/64", Gateway: "2001:db8::1" },
      { Subnet: "2001:db8:1::/64" },
      { Subnet: "10.20.0.0/16", Gateway: "10.20.0.1" }
    ]
  });
  const inspected = await createApiOnlyNetworkInspectionBridge({
    request: engineRequestFixture({ "/networks": { body: [...rawBuiltinNetworks(), valid] } }).request
  }).inspectDaemonNetworks(runtime);
  assert.deepEqual(inspected.find(({ name }) => name === "dual_stack")?.subnets, [
    { subnet: "10.20.0.0/16", gateway: "10.20.0.1" }
  ]);

  const invalidConfigs = [
    [{ Subnet: "2001:db8::1/64", Gateway: "2001:db8::2" }],
    [{ Subnet: "2001:DB8::/64", Gateway: "2001:db8::1" }],
    [{ Subnet: "2001:db8::/64", Gateway: "2001:db9::1" }],
    [{ Subnet: "2001:db8::/64", Gateway: "2001:0db8::1" }],
    [{ Subnet: "2001:db8::/64", Gateway: "2001:db8::" }],
    [
      { Subnet: "2001:db8::/64", Gateway: "2001:db8::1" },
      { Subnet: "2001:db8::/64", Gateway: "2001:db8::2" }
    ]
  ];
  for (const config of invalidConfigs) {
    const bridge = createApiOnlyNetworkInspectionBridge({
      request: engineRequestFixture({ "/networks": { body: [...rawBuiltinNetworks(), rawNetwork({ config })] } }).request
    });
    await assert.rejects(() => bridge.inspectDaemonNetworks(runtime), /API_NETWORK_INVENTORY_INVALID/u);
  }
});

test("host IPv4 route inspection uses a validated fixed executable and retains VPN, direct, masked, and host routes while excluding defaults", async () => {
  const output = [
    "Routing tables",
    "",
    "Internet:",
    "Destination        Gateway            Flags               Netif Expire",
    "default            192.168.50.1       UGScg                 en0",
    "0.0.0.0/0          192.168.50.1       UGScg                 en0",
    "10.20/16           10.20.0.2          UGSc                utun4",
    "192.168.50         link#6             UCS                   en0",
    "198.18.250.128/255.255.255.128 link#6 UCS                   en0",
    "203.0.113.9        192.168.50.1       UGH                   en0",
    ""
  ].join("\n");
  const route = routeInspectionFixture({ output });
  const bridge = createApiOnlyNetworkInspectionBridge(route);
  assert.deepEqual(await bridge.readHostIpv4Routes(), [
    { cidr: "10.20.0.0/16" },
    { cidr: "192.168.50.0/24" },
    { cidr: "198.18.250.128/25" },
    { cidr: "203.0.113.9/32" }
  ]);
  assert.equal(route.calls.length, 1);
  const call = route.calls[0];
  assert.equal(call.command, "/usr/sbin/netstat");
  assert.deepEqual(call.args, ["-rn", "-f", "inet"]);
  assert.equal(call.options.shell, false);
  assert.equal(Number.isSafeInteger(call.options.timeout) && call.options.timeout > 0, true);
  assert.equal(Number.isSafeInteger(call.options.maxBuffer) && call.options.maxBuffer > 0, true);
  assert.deepEqual(call.options.env, { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
});

test("scoped duplicate macOS routes are all validated and deduplicated in collision inventory", async () => {
  const output = [
    "Routing tables",
    "",
    "Internet:",
    "Destination Gateway Flags Netif",
    "224.0.0/4 link#6 UmCSI en0",
    "224.0.0/4 link#14 UmCSI utun4",
    ""
  ].join("\n");
  const bridge = createApiOnlyNetworkInspectionBridge(routeInspectionFixture({ output }));
  assert.deepEqual(await bridge.readHostIpv4Routes(), [{ cidr: "224.0.0.0/4" }]);
});

test("host route inspection rejects unsafe executables, failed or truncated execution, and malformed or ambiguous tables", async () => {
  const validHeader = "Routing tables\n\nInternet:\nDestination Gateway Flags Netif\n";
  const fixtures = [
    routeInspectionFixture({ mode: 0o777, output: `${validHeader}10/8 link#1 UCS en0\n` }),
    routeInspectionFixture({ execute: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } }),
    routeInspectionFixture({ execute: async () => ({ stdout: `${validHeader}10/8 link#1 UCS en0\n`, stderr: "", truncated: true }) }),
    routeInspectionFixture({ output: "not a route table\n" }),
    routeInspectionFixture({ output: `${validHeader}10.20.30.40 link#1 UCS en0\n` }),
    routeInspectionFixture({ output: `${validHeader}10.20.0.0/255.0.255.0 link#1 UCS en0\n` }),
    routeInspectionFixture({ output: `${validHeader}10/8 link#1 UCS en0` })
  ];
  for (const fixture of fixtures) {
    await assert.rejects(() => createApiOnlyNetworkInspectionBridge(fixture).readHostIpv4Routes(), /API_NETWORK_ROUTE_INSPECTION_INVALID/u);
  }
  assert.equal(fixtures[0].calls.length, 0);
});

test("post-create network inspection binds the exact claim name, existing ID, labels, and complete IPAM", async () => {
  const runtime = await runtimeFrom();
  const claim = claimFor(runtime, { existing: true });
  const path = "/networks/shensi-api_shensi_internal";
  const body = rawNetwork({ id: claim.existingNetwork.id, name: "shensi-api_shensi_internal", config: [{ Subnet: claim.subnet, Gateway: claim.ipamGatewayIp }], labels: { ...claim.expectedLabels, "com.docker.compose.version": "2.31.0" } });
  const http = engineRequestFixture({ [path]: { body } });
  const network = await createApiOnlyNetworkInspectionBridge({ request: http.request }).inspectNetwork(runtime, claim);
  assert.deepEqual(network, { id: claim.existingNetwork.id, name: "shensi-api_shensi_internal", subnets: [{ subnet: claim.subnet, gateway: claim.ipamGatewayIp }], labels: body.Labels });
  assert.equal(Object.isFrozen(network.labels), true);
  assert.deepEqual(http.calls.map(({ path: calledPath }) => calledPath), ["/info", path]);
  for (const invalid of [
    { ...body, Name: "shensi-api_other" },
    { ...body, Id: "7".repeat(64) },
    { ...body, Labels: { ...body.Labels, "io.shensi.api.runtime-nonce": "c".repeat(64) } },
    { ...body, IPAM: { ...body.IPAM, Config: [{ Subnet: claim.subnet, Gateway: claim.gatewayServiceIp }] } },
    { ...body, IPAM: { ...body.IPAM, Config: [...body.IPAM.Config, { Subnet: "10.0.0.0/8", Gateway: "10.0.0.1" }] } }
  ]) {
    const bridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture({ [path]: { body: invalid } }).request });
    await assert.rejects(() => bridge.inspectNetwork(runtime, claim), /API_NETWORK_POST_CREATE_MISMATCH/u);
  }
});

test("Gateway inspection requires one exact project service container on the internal and loopback-host networks", async () => {
  const runtime = await runtimeFrom();
  const claim = claimFor(runtime);
  const networkName = "shensi-api_shensi_internal";
  const hostNetworkName = "shensi-api_shensi_host";
  const networkPath = `/networks/${networkName}`;
  const network = rawNetwork({ id: "9".repeat(64), name: networkName, config: [{ Subnet: claim.subnet, Gateway: claim.ipamGatewayIp }], labels: claim.expectedLabels });
  const container = {
    Id: "8".repeat(64),
    Names: ["/shensi-api-gateway-1"],
    Labels: { "com.docker.compose.project": claim.projectName, "com.docker.compose.service": "gateway" },
    NetworkSettings: { Networks: {
      [networkName]: { IPAddress: claim.gatewayServiceIp, IPPrefixLen: 24, NetworkID: "9".repeat(64) },
      [hostNetworkName]: { IPAddress: "172.31.242.2", IPPrefixLen: 24, NetworkID: "7".repeat(64) }
    } }
  };
  const containerPath = `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${claim.projectName}`, "com.docker.compose.service=gateway"] }))}`;
  const http = engineRequestFixture({ [networkPath]: { body: network }, [containerPath]: { body: [container] } });
  const bridge = createApiOnlyNetworkInspectionBridge({ request: http.request });
  assert.deepEqual(await bridge.inspectGatewayService(runtime, claim), { networkName, ipv4Address: claim.gatewayServiceIp });
  assert.deepEqual(http.calls.map(({ path }) => path), ["/info", networkPath, containerPath]);
  const invalidLists = [
    [],
    [container, { ...container, Id: "a".repeat(64) }],
    [{ ...container, Labels: { ...container.Labels, "com.docker.compose.project": "shensi-api-other" } }],
    [{ ...container, Labels: { ...container.Labels, "com.docker.compose.service": "backend" } }],
    [{ ...container, NetworkSettings: { Networks: { wrong: container.NetworkSettings.Networks[networkName] } } }],
    [{ ...container, NetworkSettings: { Networks: { [networkName]: container.NetworkSettings.Networks[networkName] } } }],
    [{ ...container, NetworkSettings: { Networks: { ...container.NetworkSettings.Networks, [networkName]: { ...container.NetworkSettings.Networks[networkName], IPAddress: claim.ipamGatewayIp } } } }],
    [{ ...container, NetworkSettings: { Networks: { ...container.NetworkSettings.Networks, [hostNetworkName]: { ...container.NetworkSettings.Networks[hostNetworkName], NetworkID: "invalid" } } } }],
    [{ ...container, NetworkSettings: { Networks: { ...container.NetworkSettings.Networks, extra: { IPAddress: "10.0.0.2", IPPrefixLen: 24, NetworkID: "a".repeat(64) } } } }]
  ];
  for (const body of invalidLists) {
    const invalidBridge = createApiOnlyNetworkInspectionBridge({ request: engineRequestFixture({ [networkPath]: { body: network }, [containerPath]: { body } }).request });
    await assert.rejects(() => invalidBridge.inspectGatewayService(runtime, claim), /API_NETWORK_GATEWAY_INSPECTION_INVALID/u);
  }
  await assert.rejects(() => bridge.inspectGatewayService({}, claim), /COMPOSE_RUNTIME_UNTRUSTED/u);
});

test("fresh Gateway inspection binds its attachment ID to the currently inspected project network", async () => {
  const runtime = await runtimeFrom();
  const claim = claimFor(runtime);
  const networkName = "shensi-api_shensi_internal";
  const hostNetworkName = "shensi-api_shensi_host";
  const networkPath = `/networks/${networkName}`;
  const containerPath = `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${claim.projectName}`, "com.docker.compose.service=gateway"] }))}`;
  const networkId = "9".repeat(64);
  const network = rawNetwork({ id: networkId, name: networkName, config: [{ Subnet: claim.subnet, Gateway: claim.ipamGatewayIp }], labels: claim.expectedLabels });
  const container = {
    Id: "8".repeat(64),
    Names: ["/shensi-api-gateway-1"],
    Labels: { "com.docker.compose.project": claim.projectName, "com.docker.compose.service": "gateway" },
    NetworkSettings: { Networks: {
      [networkName]: { IPAddress: claim.gatewayServiceIp, IPPrefixLen: 24, NetworkID: "a".repeat(64) },
      [hostNetworkName]: { IPAddress: "172.31.242.2", IPPrefixLen: 24, NetworkID: "7".repeat(64) }
    } }
  };
  const wrong = engineRequestFixture({ [networkPath]: { body: network }, [containerPath]: { body: [container] } });
  await assert.rejects(
    () => createApiOnlyNetworkInspectionBridge({ request: wrong.request }).inspectGatewayService(runtime, claim),
    /API_NETWORK_GATEWAY_INSPECTION_INVALID/u
  );
  const correct = engineRequestFixture({
    [networkPath]: { body: network },
    [containerPath]: { body: [{ ...container, NetworkSettings: { Networks: { ...container.NetworkSettings.Networks, [networkName]: { ...container.NetworkSettings.Networks[networkName], NetworkID: networkId } } } }] }
  });
  assert.deepEqual(
    await createApiOnlyNetworkInspectionBridge({ request: correct.request }).inspectGatewayService(runtime, claim),
    { networkName, ipv4Address: claim.gatewayServiceIp }
  );
});
