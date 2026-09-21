import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import {
  lstat as nativeLstat,
  open as nativeOpen,
  readdir as nativeReaddir,
  realpath as nativeRealpath
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

const ALLOWED_DEPENDENCIES = new Set(["getuid", "lstat", "open", "readdir", "realpath"]);
const authorityErrors = new WeakSet();
function error(code) {
  const value = Object.assign(new Error(code), { code });
  value.stack = code;
  Object.freeze(value);
  authorityErrors.add(value);
  return value;
}
const isAuthorityError = (value) => value !== null && typeof value === "object" && authorityErrors.has(value);
function stableCall(code, callback) {
  try {
    return callback();
  } catch (caught) {
    if (isAuthorityError(caught) && caught.code === code) throw caught;
    throw error(code);
  }
}
const HASH = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ATTEMPT_ID = /^[a-f0-9]{12}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_:-]{0,127}$/u;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const journalBrands = new WeakMap();
const witnessBrands = new WeakMap();
const lifecycleBrands = new WeakMap();
const projectionBrands = new WeakMap();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function recursivelyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every((key) => recursivelyFrozen(value[key], seen));
}

function projectionDigest(value) {
  return sha256(
    Buffer.from("shensi.api-only.accepted-resource-projection/v1\0", "utf8"),
    Buffer.from(JSON.stringify(value), "utf8")
  );
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plain(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key, index) => {
    if (typeof key !== "string" || key !== keys[index]) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function matchesExact(pattern, value) {
  if (typeof value !== "string") return false;
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function ipv4Integer(value) {
  if (typeof value !== "string") return null;
  const pieces = value.split(".");
  if (pieces.length !== 4 || pieces.some((piece) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(piece) || Number(piece) > 255)) return null;
  return pieces.reduce((number, piece) => ((number << 8) | Number(piece)) >>> 0, 0);
}

function canonicalSubnet(value) {
  if (typeof value !== "string") return null;
  const pieces = value.split("/");
  if (pieces.length !== 2 || !matchesExact(/^(?:[0-9]|[12][0-9]|3[0-2])$/u, pieces[1])) return null;
  const address = ipv4Integer(pieces[0]);
  const prefix = Number(pieces[1]);
  if (address === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((address & mask) >>> 0 !== address) return null;
  return { address, prefix, mask };
}

function addressInsideSubnet(value, subnet) {
  const address = ipv4Integer(value);
  if (address === null || ((address & subnet.mask) >>> 0) !== subnet.address) return false;
  if (subnet.prefix <= 30) {
    const broadcast = (subnet.address | (~subnet.mask >>> 0)) >>> 0;
    if (address === subnet.address || address === broadcast) return false;
  }
  return true;
}

function validComposeImageReference(value, imageIdDigest) {
  if (!exactKeys(value, ["kind", "value"])) return false;
  if (value.kind === "engine-image-id") return value.value === imageIdDigest && matchesExact(DIGEST, value.value);
  if (value.kind !== "repository-digest" || typeof value.value !== "string") return false;
  if (Buffer.byteLength(value.value, "utf8") > 512 || Buffer.byteLength(value.value, "utf8") < 1) return false;
  if (!matchesExact(/^[\x21-\x7e]+$/u, value.value) || value.value.includes("://") || value.value.includes("\\")) return false;
  const marker = value.value.lastIndexOf("@sha256:");
  if (marker <= 0 || marker !== value.value.indexOf("@") || !matchesExact(DIGEST, value.value.slice(marker + 1))) return false;
  const component = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*";
  const domainPart = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const domain = `${domainPart}(?:\\.${domainPart})*(?::(?:0|[1-9][0-9]{0,4}))?`;
  return matchesExact(new RegExp(`^(?:${domain}/)?${component}(?:/${component})*$`, "u"), value.value.slice(0, marker));
}

function validateInitialBinding(value) {
  const invalid = () => { throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"); };
  if (!exactKeys(value, ["migrationAttemptId", "project", "ports", "runtimeNonce", "engine", "networks", "mysql", "backend", "artifacts", "acceptedLiveSchemaHash", "apiContractHash", "desktopClientAdmission"])) invalid();
  if (!matchesExact(ATTEMPT_ID, value.migrationAttemptId) || value.project !== `shensi-api-migration-${value.migrationAttemptId}`) invalid();
  if (!exactKeys(value.ports, ["gateway", "mysql"]) || value.ports.gateway !== 5608 || value.ports.mysql !== 3311) invalid();
  if (!matchesExact(HASH, value.runtimeNonce) || !exactKeys(value.engine, ["socketIdentity", "daemonIdentity"]) || !matchesExact(HASH, value.engine.socketIdentity) || !matchesExact(HASH, value.engine.daemonIdentity)) invalid();
  if (!exactKeys(value.networks, ["internal", "egress", "host"])) invalid();
  const internal = value.networks.internal;
  const egress = value.networks.egress;
  const host = value.networks.host;
  if (!exactKeys(internal, ["id", "name", "identitySha256", "subnet", "ipamGatewayIp", "gatewayServiceIp"]) || !matchesExact(HASH, internal.id) || internal.name !== `${value.project}_shensi_internal` || !matchesExact(HASH, internal.identitySha256)) invalid();
  const subnet = canonicalSubnet(internal.subnet);
  if (!subnet || !addressInsideSubnet(internal.ipamGatewayIp, subnet) || !addressInsideSubnet(internal.gatewayServiceIp, subnet) || internal.ipamGatewayIp === internal.gatewayServiceIp) invalid();
  if (!exactKeys(egress, ["id", "name", "identitySha256"]) || !matchesExact(HASH, egress.id) || egress.name !== `${value.project}_shensi_egress` || !matchesExact(HASH, egress.identitySha256)) invalid();
  if (!exactKeys(host, ["id", "name", "identitySha256"]) || !matchesExact(HASH, host.id) || host.name !== `${value.project}_shensi_host` || !matchesExact(HASH, host.identitySha256)) invalid();
  if (!exactKeys(value.mysql, ["containerId", "volumeName", "volumeIdentitySha256", "imageIdDigest"]) || !matchesExact(HASH, value.mysql.containerId) || value.mysql.volumeName !== `${value.project}_mysql_data` || !matchesExact(HASH, value.mysql.volumeIdentitySha256) || !matchesExact(DIGEST, value.mysql.imageIdDigest)) invalid();
  if (!exactKeys(value.backend, ["imageIdDigest", "composeImageReference"]) || !matchesExact(DIGEST, value.backend.imageIdDigest) || !validComposeImageReference(value.backend.composeImageReference, value.backend.imageIdDigest)) invalid();
  if (!exactKeys(value.artifacts, ["containerRuntimeSelectionSha256", "acceptedComposeBaseSha256", "backendEnvironmentSha256", "backendImageOverrideSha256", "gatewayConfigSha256", "acceptedResourcesSha256", "task5RecoverySeedCandidateReceiptSha256"]) || Object.values(value.artifacts).some((hash) => !matchesExact(HASH, hash))) invalid();
  if (!matchesExact(HASH, value.acceptedLiveSchemaHash) || !matchesExact(HASH, value.apiContractHash)) invalid();
  if (!exactKeys(value.desktopClientAdmission, ["mode", "admittedBuildManifestSha256"]) || value.desktopClientAdmission.mode !== "migration_locked" || value.desktopClientAdmission.admittedBuildManifestSha256 !== null) invalid();
  return {
    migrationAttemptId: value.migrationAttemptId,
    project: value.project,
    ports: { gateway: value.ports.gateway, mysql: value.ports.mysql },
    runtimeNonce: value.runtimeNonce,
    engine: { socketIdentity: value.engine.socketIdentity, daemonIdentity: value.engine.daemonIdentity },
    networks: {
      internal: {
        id: internal.id,
        name: internal.name,
        identitySha256: internal.identitySha256,
        subnet: internal.subnet,
        ipamGatewayIp: internal.ipamGatewayIp,
        gatewayServiceIp: internal.gatewayServiceIp
      },
      egress: { id: egress.id, name: egress.name, identitySha256: egress.identitySha256 },
      host: { id: host.id, name: host.name, identitySha256: host.identitySha256 }
    },
    mysql: {
      containerId: value.mysql.containerId,
      volumeName: value.mysql.volumeName,
      volumeIdentitySha256: value.mysql.volumeIdentitySha256,
      imageIdDigest: value.mysql.imageIdDigest
    },
    backend: {
      imageIdDigest: value.backend.imageIdDigest,
      composeImageReference: {
        kind: value.backend.composeImageReference.kind,
        value: value.backend.composeImageReference.value
      }
    },
    artifacts: {
      containerRuntimeSelectionSha256: value.artifacts.containerRuntimeSelectionSha256,
      acceptedComposeBaseSha256: value.artifacts.acceptedComposeBaseSha256,
      backendEnvironmentSha256: value.artifacts.backendEnvironmentSha256,
      backendImageOverrideSha256: value.artifacts.backendImageOverrideSha256,
      gatewayConfigSha256: value.artifacts.gatewayConfigSha256,
      acceptedResourcesSha256: value.artifacts.acceptedResourcesSha256,
      task5RecoverySeedCandidateReceiptSha256: value.artifacts.task5RecoverySeedCandidateReceiptSha256
    },
    acceptedLiveSchemaHash: value.acceptedLiveSchemaHash,
    apiContractHash: value.apiContractHash,
    desktopClientAdmission: {
      mode: value.desktopClientAdmission.mode,
      admittedBuildManifestSha256: value.desktopClientAdmission.admittedBuildManifestSha256
    }
  };
}

function buildInitialAcceptedVersion(binding) {
  return stableCall("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID", () => {
    const validatedBinding = validateInitialBinding(binding);
    const versionId = sha256(
      Buffer.from("shensi.api-only.accepted-version/v1\0", "utf8"),
      Buffer.from(JSON.stringify(validatedBinding), "utf8")
    );
    const record = {
      schema: "shensi.api-only.accepted-version",
      version: 1,
      kind: "initial_acceptance",
      versionId,
      binding: validatedBinding
    };
    const canonicalText = `${JSON.stringify(record)}\n`;
    return deepFreeze({ versionId, record, canonicalText, recordSha256: sha256(Buffer.from(canonicalText, "utf8")) });
  });
}

const TRANSITION_KEYS = [
  "attemptId", "project", "source", "target", "state", "activeRuntime",
  "rollbackClosedAt", "desktopClientAdmission", "transitionedAt",
  "evidenceManifest", "failure", "recoveryEvidence", "writeActivation",
  "acceptedVersion"
];
const JOURNAL_STATES = new Set([
  "prepared", "source_frozen", "target_restored", "cutover_read_only",
  "recovery_pending", "failed_recovered", "rolled_back",
  "write_activation_pending", "accepted"
]);
const JOURNAL_EDGES = new Map([
  ["prepared", new Set(["source_frozen"])],
  ["source_frozen", new Set(["target_restored", "recovery_pending"])],
  ["target_restored", new Set(["cutover_read_only", "recovery_pending"])],
  ["cutover_read_only", new Set(["rolled_back", "recovery_pending", "write_activation_pending"])],
  ["recovery_pending", new Set(["failed_recovered"])],
  ["failed_recovered", new Set(["prepared"])],
  ["rolled_back", new Set(["prepared"])],
  ["write_activation_pending", new Set(["accepted"])],
  ["accepted", new Set()]
]);

function validTimestamp(value) {
  if (!matchesExact(CANONICAL_TIME, value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}

function validEvidenceDescriptor(value) {
  return exactKeys(value, ["basename", "sha256"])
    && matchesExact(HASH, value.sha256)
    && value.basename === `${value.sha256}.json`;
}

function validateAdmission(value) {
  return exactKeys(value, ["mode", "admittedBuildManifestSha256"])
    && value.mode === "migration_locked"
    && value.admittedBuildManifestSha256 === null;
}

function validateTransitionShape(value) {
  const invalid = () => { throw error("API_ONLY_MIGRATION_JOURNAL_INVALID"); };
  if (!exactKeys(value, TRANSITION_KEYS)) invalid();
  if (!matchesExact(ATTEMPT_ID, value.attemptId) || value.project !== `shensi-api-migration-${value.attemptId}`) invalid();
  if (!exactKeys(value.source, ["database", "port", "commit"]) || value.source.database !== "shensi_trial" || value.source.port !== 3310 || !matchesExact(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, value.source.commit)) invalid();
  if (!exactKeys(value.target, ["database", "port", "commit"]) || value.target.database !== "shensi" || value.target.port !== 3311 || !matchesExact(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, value.target.commit)) invalid();
  if (!validTimestamp(value.transitionedAt) || !validEvidenceDescriptor(value.evidenceManifest) || !validateAdmission(value.desktopClientAdmission)) invalid();
  if (!JOURNAL_STATES.has(value.state)) invalid();
  if (value.rollbackClosedAt !== null && !validTimestamp(value.rollbackClosedAt)) invalid();
  if (value.failure !== null && (!exactKeys(value.failure, ["code", "evidence"]) || !matchesExact(FAILURE_CODE, value.failure.code) || !validEvidenceDescriptor(value.failure.evidence))) invalid();
  if (value.recoveryEvidence !== null && !validEvidenceDescriptor(value.recoveryEvidence)) invalid();
  if (value.writeActivation !== null && (!exactKeys(value.writeActivation, ["confirmationSha256", "resumeBinding"]) || !matchesExact(HASH, value.writeActivation.confirmationSha256) || !validEvidenceDescriptor(value.writeActivation.resumeBinding))) invalid();
  if (value.acceptedVersion !== null && (!exactKeys(value.acceptedVersion, ["versionId", "recordSha256"]) || !matchesExact(HASH, value.acceptedVersion.versionId) || !matchesExact(HASH, value.acceptedVersion.recordSha256))) invalid();
  const evidence = (descriptor) => descriptor === null ? null : { basename: descriptor.basename, sha256: descriptor.sha256 };
  return {
    attemptId: value.attemptId,
    project: value.project,
    source: { database: value.source.database, port: value.source.port, commit: value.source.commit },
    target: { database: value.target.database, port: value.target.port, commit: value.target.commit },
    state: value.state,
    activeRuntime: value.activeRuntime,
    rollbackClosedAt: value.rollbackClosedAt,
    desktopClientAdmission: {
      mode: value.desktopClientAdmission.mode,
      admittedBuildManifestSha256: value.desktopClientAdmission.admittedBuildManifestSha256
    },
    transitionedAt: value.transitionedAt,
    evidenceManifest: evidence(value.evidenceManifest),
    failure: value.failure === null ? null : { code: value.failure.code, evidence: evidence(value.failure.evidence) },
    recoveryEvidence: evidence(value.recoveryEvidence),
    writeActivation: value.writeActivation === null ? null : {
      confirmationSha256: value.writeActivation.confirmationSha256,
      resumeBinding: evidence(value.writeActivation.resumeBinding)
    },
    acceptedVersion: value.acceptedVersion === null ? null : {
      versionId: value.acceptedVersion.versionId,
      recordSha256: value.acceptedVersion.recordSha256
    }
  };
}

function validateTransitionState(transition, prior) {
  const invalid = () => { throw error("API_ONLY_MIGRATION_JOURNAL_INVALID"); };
  const expectedRuntime = {
    prepared: "trial",
    source_frozen: null,
    target_restored: null,
    cutover_read_only: "target",
    recovery_pending: null,
    failed_recovered: "trial",
    rolled_back: "trial",
    write_activation_pending: "target",
    accepted: "target"
  }[transition.state];
  if (transition.activeRuntime !== expectedRuntime) invalid();

  const allNull = (...names) => names.every((name) => transition[name] === null);
  if (["prepared", "source_frozen", "target_restored", "cutover_read_only"].includes(transition.state)) {
    if (!allNull("failure", "recoveryEvidence", "writeActivation", "acceptedVersion") || transition.rollbackClosedAt !== null) invalid();
  } else if (transition.state === "recovery_pending") {
    if (transition.failure === null || !allNull("recoveryEvidence", "writeActivation", "acceptedVersion") || transition.rollbackClosedAt !== null) invalid();
  } else if (transition.state === "failed_recovered") {
    if (transition.failure === null || transition.recoveryEvidence === null || !allNull("writeActivation", "acceptedVersion") || transition.rollbackClosedAt !== null) invalid();
    if (!prior || JSON.stringify(transition.failure) !== JSON.stringify(prior.failure)) invalid();
  } else if (transition.state === "rolled_back") {
    if (transition.failure !== null || transition.recoveryEvidence === null || !allNull("writeActivation", "acceptedVersion") || transition.rollbackClosedAt !== null) invalid();
  } else if (transition.state === "write_activation_pending") {
    if (transition.rollbackClosedAt !== transition.transitionedAt || transition.writeActivation === null || !allNull("failure", "recoveryEvidence", "acceptedVersion")) invalid();
  } else if (transition.state === "accepted") {
    if (!prior || transition.rollbackClosedAt !== prior.rollbackClosedAt || transition.rollbackClosedAt === null || transition.writeActivation === null || transition.acceptedVersion === null || !allNull("failure", "recoveryEvidence")) invalid();
    if (JSON.stringify(transition.writeActivation) !== JSON.stringify(prior.writeActivation)) invalid();
  }
}

function createJournal(summaries) {
  const head = summaries.at(-1);
  const journal = {
    schema: "shensi.api-only.migration-journal",
    version: 1,
    revision: summaries.length,
    state: head.state,
    activeRuntime: head.activeRuntime,
    activeAttemptId: head.attemptId,
    rollbackClosedAt: head.rollbackClosedAt,
    desktopClientAdmission: head.desktopClientAdmission,
    headSummarySha256: head.summarySha256,
    attemptSummaries: summaries
  };
  const canonicalText = `${JSON.stringify(journal)}\n`;
  deepFreeze(journal);
  journalBrands.set(journal, { canonicalText, snapshot: null });
  return deepFreeze({ journal, canonicalText });
}

function buildNextMigrationJournal(priorJournal, nextTransition) {
  return stableCall("API_ONLY_MIGRATION_JOURNAL_INVALID", () => {
    const invalid = () => { throw error("API_ONLY_MIGRATION_JOURNAL_INVALID"); };
    const transition = validateTransitionShape(nextTransition);
    let priorSummaries = [];
    let previousSummarySha256 = null;
    if (priorJournal === null) {
      if (transition.state !== "prepared") invalid();
    } else {
      const metadata = journalBrands.get(priorJournal);
      if (!metadata || !Object.isFrozen(priorJournal) || `${JSON.stringify(priorJournal)}\n` !== metadata.canonicalText) invalid();
      if (!JOURNAL_EDGES.get(priorJournal.state)?.has(transition.state)) invalid();
      priorSummaries = priorJournal.attemptSummaries;
      const prior = priorSummaries.at(-1);
      previousSummarySha256 = prior.summarySha256;
      const newAttempt = transition.state === "prepared";
      if (newAttempt) {
        if (!["failed_recovered", "rolled_back"].includes(prior.state)) invalid();
        if (priorSummaries.some((summary) => summary.attemptId === transition.attemptId)) invalid();
      } else if (transition.attemptId !== prior.attemptId
        || transition.project !== prior.project
        || JSON.stringify(transition.source) !== JSON.stringify(prior.source)
        || JSON.stringify(transition.target) !== JSON.stringify(prior.target)) invalid();
      if (prior.rollbackClosedAt !== null && transition.rollbackClosedAt !== prior.rollbackClosedAt) invalid();
    }
    validateTransitionState(transition, priorSummaries.at(-1) ?? null);
    const summaryCore = { sequence: priorSummaries.length + 1, ...transition, previousSummarySha256 };
    const summary = {
      ...summaryCore,
      summarySha256: sha256(Buffer.from("shensi.api-only.migration-summary/v1\0", "utf8"), Buffer.from(JSON.stringify(summaryCore), "utf8"))
    };
    const summaries = [...priorSummaries, summary];
    if (summaries.length > 1024) invalid();
    const built = createJournal(summaries);
    if (Buffer.byteLength(built.canonicalText, "utf8") > 1024 * 1024) invalid();
    return built;
  });
}

function modeOf(info) {
  return Number(info.mode) & 0o777;
}

function identityOf(info) {
  const nanoseconds = (name, milliseconds) => info[name] === undefined
    ? String(BigInt(Math.trunc(Number(info[milliseconds]) * 1e6)))
    : String(info[name]);
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    uid: Number(info.uid),
    mode: modeOf(info),
    nlink: Number(info.nlink),
    mtimeNs: nanoseconds("mtimeNs", "mtimeMs"),
    ctimeNs: nanoseconds("ctimeNs", "ctimeMs")
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePathIdentity(left, right) {
  return ["dev", "ino", "size", "uid", "mode", "nlink"].every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  return ["dev", "ino", "uid", "mode", "nlink"].every((key) => left[key] === right[key]);
}

function validateOwnedDirectory(info, uid, exactMode, code) {
  if (info.isSymbolicLink?.() || !info.isDirectory?.() || Number(info.uid) !== uid) throw error(code);
  const mode = modeOf(info);
  if (exactMode === null ? (mode & 0o022) !== 0 : mode !== exactMode) throw error(code);
}

async function readDirectoryTransaction(filesystem, repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.includes("\0") || !isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  }
  const uid = Number(filesystem.getuid());
  if (!Number.isInteger(uid) || uid < 0) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  const paths = [repositoryRoot, join(repositoryRoot, ".runtime"), join(repositoryRoot, ".runtime", "api-only")];
  const identities = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    let info;
    try { info = await filesystem.lstat(path); } catch (caught) {
      if (caught?.code === "ENOENT" && index > 0) return { uid, paths, identities, absentIndex: index };
      throw caught;
    }
    validateOwnedDirectory(info, uid, index === 2 ? 0o700 : null, "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    if (await filesystem.realpath(path) !== path) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    identities.push(identityOf(info));
  }
  return { uid, paths, identities, absentIndex: null };
}

async function revalidateDirectoryTransaction(filesystem, snapshot, code) {
  for (let index = 0; index < snapshot.paths.length; index += 1) {
    const path = snapshot.paths[index];
    if (snapshot.absentIndex !== null && index >= snapshot.absentIndex) {
      try {
        await filesystem.lstat(path);
        throw error(code);
      } catch (caught) {
        if (caught?.code !== "ENOENT") throw caught;
      }
      break;
    }
    const info = await filesystem.lstat(path);
    validateOwnedDirectory(info, snapshot.uid, index === 2 ? 0o700 : null, code);
    if (await filesystem.realpath(path) !== path || !sameIdentity(identityOf(info), snapshot.identities[index])) throw error(code);
  }
}

function validateOwnedRegularFile(info, uid, minBytes, maxBytes, code) {
  if (info.isSymbolicLink?.() || !info.isFile?.() || Number(info.uid) !== uid || modeOf(info) !== 0o600 || Number(info.nlink) !== 1) throw error(code);
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < minBytes || size > maxBytes) throw error(code);
}

async function readBounded(handle, maxBytes, code, retainBytes) {
  const chunks = retainBytes ? [] : null;
  const digest = createHash("sha256");
  let position = 0;
  while (position <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - position));
    const result = await handle.read(buffer, 0, buffer.length, position);
    const bytesRead = Number(result?.bytesRead);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) throw error(code);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    if (chunks) chunks.push(chunk);
    position += bytesRead;
    if (position > maxBytes) throw error(code);
  }
  return {
    bytes: chunks ? Buffer.concat(chunks, position) : null,
    byteLength: position,
    contentSha256: digest.digest("hex")
  };
}

async function openStableFile(filesystem, path, { uid, minBytes = 1, maxBytes, invalidCode, changedCode, allowAbsent = false, retainBytes = true }) {
  let pathnameInfo;
  try { pathnameInfo = await filesystem.lstat(path); } catch (caught) {
    if (allowAbsent && caught?.code === "ENOENT") {
      try {
        await filesystem.lstat(path);
        throw error(changedCode);
      } catch (second) {
        if (second?.code === "ENOENT") return null;
        if (isAuthorityError(second)) throw second;
        throw error(invalidCode);
      }
    }
    if (caught?.code === "ENOENT") throw error(invalidCode);
    if (isAuthorityError(caught)) throw caught;
    throw error(invalidCode);
  }
  validateOwnedRegularFile(pathnameInfo, uid, minBytes, maxBytes, invalidCode);
  let handle;
  try {
    handle = await filesystem.open(path, FS.O_RDONLY | filesystem.noFollow, 0);
    const before = await handle.stat({ bigint: true });
    validateOwnedRegularFile(before, uid, minBytes, maxBytes, invalidCode);
    if (!samePathIdentity(identityOf(pathnameInfo), identityOf(before))) throw error(changedCode);
    const content = await readBounded(handle, maxBytes, changedCode, retainBytes);
    if (content.byteLength < minBytes || content.byteLength > maxBytes || content.byteLength !== Number(before.size)) throw error(changedCode);
    const after = await handle.stat({ bigint: true });
    const current = await filesystem.lstat(path);
    validateOwnedRegularFile(after, uid, minBytes, maxBytes, invalidCode);
    validateOwnedRegularFile(current, uid, minBytes, maxBytes, invalidCode);
    const identity = identityOf(before);
    if (!sameIdentity(identity, identityOf(after)) || !samePathIdentity(identity, identityOf(current))) throw error(changedCode);
    return { path, handle, ...content, identity, closeCode: invalidCode };
  } catch (caught) {
    if (handle) await closeSilently(handle);
    if (isAuthorityError(caught)) throw caught;
    throw error(changedCode);
  }
}

async function closeSilently(handle) {
  try {
    await handle.close();
  } catch {
    // Cleanup is best-effort when a more specific validation error is already active.
  }
}

async function closeFiles(files) {
  const present = files.filter(Boolean);
  const results = await Promise.allSettled(present.map(async (file) => file.handle.close()));
  const failedIndex = results.findIndex((result) => result.status === "rejected");
  if (failedIndex !== -1) throw error(present[failedIndex].closeCode ?? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
}

async function revalidateOpenFile(filesystem, original, options) {
  const reopened = await openStableFile(filesystem, original.path, options);
  if (!reopened) throw error(options.changedCode);
  try {
    const finalOriginal = await original.handle.stat({ bigint: true });
    if (!sameIdentity(original.identity, identityOf(finalOriginal))
      || !sameIdentity(original.identity, reopened.identity)
      || original.byteLength !== reopened.byteLength
      || original.contentSha256 !== reopened.contentSha256
      || (original.bytes !== null && reopened.bytes !== null && !original.bytes.equals(reopened.bytes))) throw error(options.changedCode);
    return reopened;
  } catch (caught) {
    await closeSilently(reopened.handle);
    if (isAuthorityError(caught)) throw caught;
    throw error(options.changedCode);
  }
}

async function assertRetainedFileUnchanged(file, code) {
  try {
    const info = await file.handle.stat({ bigint: true });
    if (!sameIdentity(file.identity, identityOf(info))) throw error(code);
  } catch (caught) {
    if (isAuthorityError(caught)) throw caught;
    throw error(code);
  }
}

const JOURNAL_KEYS = ["schema", "version", "revision", "state", "activeRuntime", "activeAttemptId", "rollbackClosedAt", "desktopClientAdmission", "headSummarySha256", "attemptSummaries"];
const SUMMARY_KEYS = ["sequence", ...TRANSITION_KEYS, "previousSummarySha256", "summarySha256"];

function decodeCanonicalJournal(bytes) {
  let text;
  try { text = utf8.decode(bytes); } catch { throw error("API_ONLY_MIGRATION_JOURNAL_INVALID"); }
  if (text.startsWith("\uFEFF") || text.includes("\0")) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  let value;
  try { value = JSON.parse(text); } catch { throw error("API_ONLY_MIGRATION_JOURNAL_INVALID"); }
  if (!exactKeys(value, JOURNAL_KEYS) || value.schema !== "shensi.api-only.migration-journal" || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.attemptSummaries) || value.attemptSummaries.length !== value.revision || value.attemptSummaries.length > 1024) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  let built = null;
  for (let index = 0; index < value.attemptSummaries.length; index += 1) {
    const summary = value.attemptSummaries[index];
    if (!exactKeys(summary, SUMMARY_KEYS) || summary.sequence !== index + 1) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
    const transition = Object.fromEntries(TRANSITION_KEYS.map((key) => [key, summary[key]]));
    built = buildNextMigrationJournal(built?.journal ?? null, transition);
    const expected = built.journal.attemptSummaries.at(-1);
    if (JSON.stringify(expected) !== JSON.stringify(summary)) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  }
  if (JSON.stringify(built.journal) !== JSON.stringify(value) || built.canonicalText !== text) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  return built.journal;
}

function selectorSnapshot(directories, file) {
  return deepFreeze({
    directories: {
      paths: [...directories.paths],
      identities: directories.identities.map((identity) => ({ ...identity })),
      absentIndex: directories.absentIndex
    },
    file: file === null ? null : {
      path: file.path,
      identity: { ...file.identity },
      sha256: file.contentSha256
    }
  });
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readMigrationJournalTransaction(filesystem, repositoryRoot, { retain = false } = {}) {
  const files = [];
  try {
    const directories = await readDirectoryTransaction(filesystem, repositoryRoot);
    if (directories.absentIndex !== null) {
      await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
      return { value: null, snapshot: selectorSnapshot(directories, null), retainedFiles: [] };
    }
    const path = join(repositoryRoot, ".runtime", "api-only", "migration-state.json");
    const journalFile = await openStableFile(filesystem, path, {
      uid: directories.uid,
      maxBytes: 1024 * 1024,
      invalidCode: "API_ONLY_MIGRATION_JOURNAL_INVALID",
      changedCode: "API_ONLY_MIGRATION_JOURNAL_CHANGED",
      allowAbsent: true
    });
    if (!journalFile) {
      await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
      return { value: null, snapshot: selectorSnapshot(directories, null), retainedFiles: [] };
    }
    files.push(journalFile);
    const journal = decodeCanonicalJournal(journalFile.bytes);
    files.push(await revalidateOpenFile(filesystem, journalFile, {
      uid: directories.uid,
      maxBytes: 1024 * 1024,
      invalidCode: "API_ONLY_MIGRATION_JOURNAL_INVALID",
      changedCode: "API_ONLY_MIGRATION_JOURNAL_CHANGED"
    }));
    await assertRetainedFileUnchanged(journalFile, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
    await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
    const snapshot = selectorSnapshot(directories, journalFile);
    const journalMetadata = journalBrands.get(journal);
    journalBrands.set(journal, { ...journalMetadata, snapshot });
    const retainedFiles = retain ? files.splice(0) : [];
    return { value: journal, snapshot, retainedFiles };
  } catch (caught) {
    if (isAuthorityError(caught)) throw caught;
    throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  } finally {
    await closeFiles(files);
  }
}

async function readMigrationJournal(filesystem, repositoryRoot) {
  return (await readMigrationJournalTransaction(filesystem, repositoryRoot)).value;
}

function decodeCanonicalPointer(bytes) {
  let text;
  try { text = utf8.decode(bytes); } catch { throw error("API_ONLY_ACTIVE_VERSION_POINTER_INVALID"); }
  if (text.startsWith("\uFEFF") || text.includes("\0")) throw error("API_ONLY_ACTIVE_VERSION_POINTER_INVALID");
  let value;
  try { value = JSON.parse(text); } catch { throw error("API_ONLY_ACTIVE_VERSION_POINTER_INVALID"); }
  if (!exactKeys(value, ["schema", "version", "versionId", "recordSha256"])
    || value.schema !== "shensi.api-only.active-version-pointer"
    || value.version !== 1
    || !matchesExact(HASH, value.versionId)
    || !matchesExact(HASH, value.recordSha256)
    || `${JSON.stringify(value)}\n` !== text) throw error("API_ONLY_ACTIVE_VERSION_POINTER_INVALID");
  return deepFreeze(value);
}

async function readActivePointerTransaction(filesystem, repositoryRoot, { retain = false } = {}) {
  const files = [];
  try {
    const directories = await readDirectoryTransaction(filesystem, repositoryRoot);
    if (directories.absentIndex !== null) {
      await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
      return { value: null, snapshot: selectorSnapshot(directories, null), retainedFiles: [] };
    }
    const path = join(repositoryRoot, ".runtime", "api-only", "active-version.json");
    const pointerFile = await openStableFile(filesystem, path, {
      uid: directories.uid,
      maxBytes: 4096,
      invalidCode: "API_ONLY_ACTIVE_VERSION_POINTER_INVALID",
      changedCode: "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED",
      allowAbsent: true
    });
    if (!pointerFile) {
      await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
      return { value: null, snapshot: selectorSnapshot(directories, null), retainedFiles: [] };
    }
    files.push(pointerFile);
    const pointer = decodeCanonicalPointer(pointerFile.bytes);
    files.push(await revalidateOpenFile(filesystem, pointerFile, {
      uid: directories.uid,
      maxBytes: 4096,
      invalidCode: "API_ONLY_ACTIVE_VERSION_POINTER_INVALID",
      changedCode: "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED"
    }));
    await assertRetainedFileUnchanged(pointerFile, "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
    await revalidateDirectoryTransaction(filesystem, directories, "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
    const retainedFiles = retain ? files.splice(0) : [];
    return { value: pointer, snapshot: selectorSnapshot(directories, pointerFile), retainedFiles };
  } catch (caught) {
    if (isAuthorityError(caught)) throw caught;
    throw error("API_ONLY_ACTIVE_VERSION_POINTER_INVALID");
  } finally {
    await closeFiles(files);
  }
}

const VERSION_FILES = [
  ["containerRuntimeSelection", "container-runtime-selection.json", "containerRuntimeSelectionSha256"],
  ["acceptedComposeBase", "accepted-compose-base.json", "acceptedComposeBaseSha256"],
  ["backendEnvironment", "backend.env", "backendEnvironmentSha256"],
  ["backendImageOverride", "backend-image-override.json", "backendImageOverrideSha256"],
  ["gatewayConfig", "gateway.conf", "gatewayConfigSha256"],
  ["acceptedResources", "accepted-resources.json", "acceptedResourcesSha256"],
  ["task5RecoverySeedCandidateReceipt", "task5-recovery-seed-candidate-receipt.json", "task5RecoverySeedCandidateReceiptSha256"]
];
const VERSION_ENTRY_SET = ["accepted-version.json", ...VERSION_FILES.map(([, basename]) => basename)].sort();

function validateVersionEntries(entries) {
  if (!entries.includes("accepted-version.json")) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  if (VERSION_FILES.some(([, basename]) => !entries.includes(basename))) throw error("API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID");
  if (JSON.stringify(entries) !== JSON.stringify(VERSION_ENTRY_SET)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
}

async function pinExactDirectory(filesystem, path, uid, code) {
  let handle;
  try {
    const info = await filesystem.lstat(path);
    validateOwnedDirectory(info, uid, 0o700, code);
    if (await filesystem.realpath(path) !== path) throw error(code);
    handle = await filesystem.open(path, FS.O_RDONLY | filesystem.noFollow, 0);
    const descriptorInfo = await handle.stat({ bigint: true });
    validateOwnedDirectory(descriptorInfo, uid, 0o700, code);
    const identity = identityOf(descriptorInfo);
    if (!samePathIdentity(identityOf(info), identity)) throw error(code);
    return { path, identity, handle, closeCode: code };
  } catch (caught) {
    if (handle) await closeSilently(handle);
    if (isAuthorityError(caught)) throw caught;
    throw error(code);
  }
}

async function revalidatePinnedDirectory(filesystem, pinned, uid, code) {
  const reopened = await pinExactDirectory(filesystem, pinned.path, uid, code);
  try {
    const originalInfo = await pinned.handle.stat({ bigint: true });
    if (!sameIdentity(identityOf(originalInfo), pinned.identity) || !sameIdentity(reopened.identity, pinned.identity)) throw error(code);
    return reopened;
  } catch (caught) {
    await closeSilently(reopened.handle);
    throw caught;
  }
}

function decodeAcceptedRecord(bytes, pointer) {
  let text;
  try { text = utf8.decode(bytes); } catch { throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"); }
  if (text.startsWith("\uFEFF") || text.includes("\0")) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  let value;
  try { value = JSON.parse(text); } catch { throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"); }
  if (!exactKeys(value, ["schema", "version", "kind", "versionId", "binding"])
    || value.schema !== "shensi.api-only.accepted-version"
    || value.version !== 1
    || value.kind !== "initial_acceptance"
    || !matchesExact(HASH, value.versionId)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  const built = buildInitialAcceptedVersion(value.binding);
  if (built.versionId !== value.versionId
    || built.versionId !== pointer.versionId
    || built.recordSha256 !== pointer.recordSha256
    || sha256(bytes) !== pointer.recordSha256
    || built.canonicalText !== text
    || JSON.stringify(built.record) !== JSON.stringify(value)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  return built;
}

async function readAcceptedVersion(filesystem, repositoryRoot, pointer, pointerSnapshot, { retain = false } = {}) {
  const files = [];
  const directoryHandles = [];
  try {
    const base = await readDirectoryTransaction(filesystem, repositoryRoot);
    if (base.absentIndex !== null) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    const runtimeRoot = join(repositoryRoot, ".runtime", "api-only");
    const versionsRoot = join(runtimeRoot, "versions");
    const versionRoot = join(versionsRoot, pointer.versionId);
    const directories = [];
    for (const path of [runtimeRoot, versionsRoot, versionRoot]) {
      const directory = await pinExactDirectory(filesystem, path, base.uid, "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
      directories.push(directory);
      directoryHandles.push(directory);
    }
    if (!sameDirectoryIdentity(directories[0].identity, base.identities[2])) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    const firstRead = await filesystem.readdir(versionRoot);
    if (!Array.isArray(firstRead) || firstRead.some((name) => typeof name !== "string")) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    const firstEntries = [...firstRead].sort();
    validateVersionEntries(firstEntries);

    const recordPath = join(versionRoot, "accepted-version.json");
    const recordFile = await openStableFile(filesystem, recordPath, {
      uid: base.uid,
      maxBytes: 65536,
      invalidCode: "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID",
      changedCode: "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"
    });
    files.push(recordFile);
    const built = decodeAcceptedRecord(recordFile.bytes, pointer);
    const artifacts = {};
    let aggregateSize = 0;
    for (const [name, basename, field] of VERSION_FILES) {
      const path = join(versionRoot, basename);
      const remaining = 32 * 1024 * 1024 - aggregateSize;
      const artifact = await openStableFile(filesystem, path, {
        uid: base.uid,
        minBytes: 0,
        maxBytes: Math.min(8 * 1024 * 1024, remaining),
        invalidCode: "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID",
        changedCode: "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID",
        retainBytes: false
      });
      files.push(artifact);
      aggregateSize += artifact.byteLength;
      if (aggregateSize > 32 * 1024 * 1024 || artifact.contentSha256 !== built.record.binding.artifacts[field]) throw error("API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID");
      artifacts[name] = { path, sha256: built.record.binding.artifacts[field] };
    }

    const secondRead = await filesystem.readdir(versionRoot);
    if (!Array.isArray(secondRead) || secondRead.some((name) => typeof name !== "string")) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    const secondEntries = [...secondRead].sort();
    validateVersionEntries(secondEntries);
    if (JSON.stringify(firstEntries) !== JSON.stringify(secondEntries)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    const originals = [...files];
    for (const file of originals) {
      const isRecord = file === recordFile;
      files.push(await revalidateOpenFile(filesystem, file, {
        uid: base.uid,
        minBytes: isRecord ? 1 : 0,
        maxBytes: isRecord ? 65536 : 8 * 1024 * 1024,
        invalidCode: isRecord ? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID" : "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID",
        changedCode: isRecord ? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID" : "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID",
        retainBytes: isRecord
      }));
    }
    for (const file of files) await assertRetainedFileUnchanged(file, file.path === recordPath ? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID" : "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID");
    const pointerAgain = await readActivePointerTransaction(filesystem, repositoryRoot);
    if (!pointerAgain.value
      || JSON.stringify(pointerAgain.value) !== JSON.stringify(pointer)
      || !sameSnapshot(pointerAgain.snapshot, pointerSnapshot)) throw error("API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
    for (const directory of directories) directoryHandles.push(await revalidatePinnedDirectory(filesystem, directory, base.uid, "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"));
    for (const directory of directoryHandles) {
      const finalInfo = await directory.handle.stat({ bigint: true });
      if (!sameIdentity(identityOf(finalInfo), directory.identity)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    }
    await revalidateDirectoryTransaction(filesystem, base, "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");

    const value = deepFreeze({
      runtimeRoot,
      versionRoot,
      pointerPath: join(runtimeRoot, "active-version.json"),
      recordPath,
      pointer,
      record: built.record,
      artifacts
    });
    const snapshot = deepFreeze({
      pointer,
      files: files.map((file) => ({ path: file.path, identity: file.identity, sha256: file.contentSha256 })),
      entries: [...firstEntries],
      directories: [...base.identities, ...directories.map((directory) => directory.identity)]
    });
    const retainedFiles = retain ? files.splice(0) : [];
    const retainedDirectories = retain ? directoryHandles.splice(0) : [];
    return {
      value,
      snapshot,
      retainedFiles,
      retainedDirectories
    };
  } catch (caught) {
    if (isAuthorityError(caught)) throw caught;
    throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  } finally {
    await closeFiles([...files, ...directoryHandles]);
  }
}

function projectMigrationWitness(brandedJournal) {
  if (!journalBrands.has(brandedJournal) || !Object.isFrozen(brandedJournal)) throw error("API_ONLY_MIGRATION_JOURNAL_INVALID");
  const head = brandedJournal.attemptSummaries.at(-1);
  const witness = deepFreeze({
    revision: brandedJournal.revision,
    state: head.state,
    activeRuntime: head.activeRuntime,
    activeAttemptId: head.attemptId,
    rollbackClosedAt: head.rollbackClosedAt,
    desktopClientAdmission: head.desktopClientAdmission,
    headSummarySha256: head.summarySha256,
    writeActivation: head.writeActivation,
    acceptedVersion: head.acceptedVersion
  });
  witnessBrands.set(witness, { journal: brandedJournal });
  return witness;
}

function brandLifecycle(authority, metadata) {
  deepFreeze(authority);
  lifecycleBrands.set(authority, {
    ...metadata,
    authorityDigest: sha256(
      Buffer.from("shensi.api-only.lifecycle-authority/v1\0", "utf8"),
      Buffer.from(JSON.stringify(authority), "utf8")
    ),
    stale: false
  });
  return authority;
}

function projectAcceptedResources(lifecycleAuthority) {
  const lifecycleMetadata = lifecycleBrands.get(lifecycleAuthority);
  if (!lifecycleMetadata
    || !recursivelyFrozen(lifecycleAuthority)
    || lifecycleMetadata.stale === true
    || !["write_activation_pending", "accepted"].includes(lifecycleAuthority.phase)
    || lifecycleAuthority.acceptedVersion === null
    || !lifecycleMetadata.acceptedSnapshot) {
    throw error("API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID");
  }
  const { pointer, record, artifacts } = lifecycleAuthority.acceptedVersion;
  const binding = record.binding;
  const projection = deepFreeze({
    schema: "shensi.api-only.accepted-resource-projection",
    version: 1,
    lifecyclePhase: lifecycleAuthority.phase,
    pointer: { versionId: pointer.versionId, recordSha256: pointer.recordSha256 },
    expectedResources: {
      migrationAttemptId: binding.migrationAttemptId,
      project: binding.project,
      ports: binding.ports,
      runtimeNonce: binding.runtimeNonce,
      engine: binding.engine,
      networks: binding.networks,
      mysql: binding.mysql,
      backend: binding.backend,
      acceptedLiveSchemaHash: binding.acceptedLiveSchemaHash,
      apiContractHash: binding.apiContractHash,
      desktopClientAdmission: binding.desktopClientAdmission
    },
    artifacts
  });
  projectionBrands.set(projection, {
    phase: lifecycleAuthority.phase,
    source: lifecycleAuthority,
    snapshot: lifecycleMetadata.acceptedSnapshot,
    digest: projectionDigest(projection)
  });
  return projection;
}

async function readAcceptedWithStableJournal(filesystem, repositoryRoot, pointerRead, journalRead, retained) {
  try {
    const accepted = await readAcceptedVersion(filesystem, repositoryRoot, pointerRead.value, pointerRead.snapshot);
    const journalAgain = await readMigrationJournalTransaction(filesystem, repositoryRoot);
    if (!journalAgain.value
      || JSON.stringify(journalAgain.value) !== JSON.stringify(journalRead.value)
      || !sameSnapshot(journalAgain.snapshot, journalRead.snapshot)) throw error("API_ONLY_MIGRATION_JOURNAL_CHANGED");
    const acceptedAgain = await readAcceptedVersion(filesystem, repositoryRoot, pointerRead.value, pointerRead.snapshot, { retain: true });
    retained.push(...acceptedAgain.retainedFiles.map((file) => ({
      file,
      code: file.path === acceptedAgain.value.recordPath
        ? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"
        : "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID"
    })));
    retained.push(...acceptedAgain.retainedDirectories.map((file) => ({
      file,
      code: "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"
    })));
    if (JSON.stringify(acceptedAgain.value) !== JSON.stringify(accepted.value)) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
    for (let index = 0; index < accepted.snapshot.files.length; index += 1) {
      if (!sameSnapshot(accepted.snapshot.files[index], acceptedAgain.snapshot.files[index])) {
        const code = accepted.snapshot.files[index].path === accepted.value.recordPath
          ? "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"
          : "API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID";
        throw error(code);
      }
    }
    if (!sameSnapshot(accepted.snapshot.entries, acceptedAgain.snapshot.entries)
      || !sameSnapshot(accepted.snapshot.directories, acceptedAgain.snapshot.directories)) {
      throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    }
    return acceptedAgain;
  } catch (caught) {
    if (isAuthorityError(caught)
      && (caught.code === "API_ONLY_MIGRATION_JOURNAL_INVALID" || caught.code === "API_ONLY_MIGRATION_JOURNAL_CHANGED")) throw caught;
    let journalAgain;
    try { journalAgain = await readMigrationJournalTransaction(filesystem, repositoryRoot); } catch (journalError) {
      if (isAuthorityError(journalError) && journalError.code.startsWith("API_ONLY_MIGRATION_JOURNAL_")) throw journalError;
      throw caught;
    }
    if (!journalAgain.value
      || JSON.stringify(journalAgain.value) !== JSON.stringify(journalRead.value)
      || !sameFileSnapshot(journalAgain.snapshot.file, journalRead.snapshot.file)) throw error("API_ONLY_MIGRATION_JOURNAL_CHANGED");
    throw caught;
  }
}

async function requireStableSelectors(filesystem, repositoryRoot, journalRead, pointerRead) {
  const journalAgain = await readMigrationJournalTransaction(filesystem, repositoryRoot);
  if (JSON.stringify(journalAgain.value) !== JSON.stringify(journalRead.value)
    || !sameSnapshot(journalAgain.snapshot, journalRead.snapshot)) throw error("API_ONLY_MIGRATION_JOURNAL_CHANGED");
  const pointerAgain = await readActivePointerTransaction(filesystem, repositoryRoot);
  if (JSON.stringify(pointerAgain.value) !== JSON.stringify(pointerRead.value)
    || !sameSnapshot(pointerAgain.snapshot, pointerRead.snapshot)) throw error("API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
}

async function readLifecycleAuthority(filesystem, repositoryRoot) {
  const retained = [];
  try {
    const journalRead = await readMigrationJournalTransaction(filesystem, repositoryRoot, { retain: true });
    retained.push(...journalRead.retainedFiles.map((file) => ({ file, code: "API_ONLY_MIGRATION_JOURNAL_CHANGED" })));
    const pointerRead = await readActivePointerTransaction(filesystem, repositoryRoot, { retain: true });
    retained.push(...pointerRead.retainedFiles.map((file) => ({ file, code: "API_ONLY_ACTIVE_VERSION_POINTER_CHANGED" })));
    const journal = journalRead.value;
    const pointer = pointerRead.value;
    const migration = journal === null ? null : projectMigrationWitness(journal);
    const metadata = (acceptedSnapshot = null) => ({
      filesystem,
      repositoryRoot,
      journalSnapshot: journalRead.snapshot,
      pointerSnapshot: pointerRead.snapshot,
      acceptedSnapshot
    });
    const finish = async (authority, acceptedSnapshot = null) => {
      for (const item of retained) await assertRetainedFileUnchanged(item.file, item.code);
      return brandLifecycle(authority, metadata(acceptedSnapshot));
    };
    if (journal === null && pointer === null) {
      await requireStableSelectors(filesystem, repositoryRoot, journalRead, pointerRead);
      return await finish({ phase: "bootstrap", migration: null, acceptedVersion: null });
    }
    if (journal !== null && !["write_activation_pending", "accepted"].includes(journal.state)) {
      if (pointer !== null) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
      await requireStableSelectors(filesystem, repositoryRoot, journalRead, pointerRead);
      return await finish({ phase: "migration", migration, acceptedVersion: null });
    }
    if (journal === null && pointer !== null) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
    if (journal.state === "write_activation_pending") {
      if (pointer === null) {
        await requireStableSelectors(filesystem, repositoryRoot, journalRead, pointerRead);
        return await finish({ phase: "write_activation_pending", migration, acceptedVersion: null });
      }
      const accepted = await readAcceptedWithStableJournal(filesystem, repositoryRoot, pointerRead, journalRead, retained);
      if (accepted.value.record.binding.migrationAttemptId !== journal.activeAttemptId
        || JSON.stringify(accepted.value.record.binding.desktopClientAdmission) !== JSON.stringify(journal.desktopClientAdmission)) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
      return await finish({ phase: "write_activation_pending", migration, acceptedVersion: accepted.value }, accepted.snapshot);
    }
    if (journal.state === "accepted") {
      if (pointer === null) throw error("API_ONLY_ACCEPTED_VERSION_REQUIRED");
      const accepted = await readAcceptedWithStableJournal(filesystem, repositoryRoot, pointerRead, journalRead, retained);
      if (JSON.stringify(journal.attemptSummaries.at(-1).acceptedVersion) !== JSON.stringify({ versionId: pointer.versionId, recordSha256: pointer.recordSha256 })
        || accepted.value.record.binding.migrationAttemptId !== journal.activeAttemptId
        || JSON.stringify(accepted.value.record.binding.desktopClientAdmission) !== JSON.stringify(journal.desktopClientAdmission)) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
      return await finish({ phase: "accepted", migration, acceptedVersion: accepted.value }, accepted.snapshot);
    }
    throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
  } finally {
    await closeFiles(retained.map(({ file }) => file));
  }
}

function sameFileSnapshot(left, right) {
  return left === null && right === null
    || left !== null && right !== null && sameSnapshot(left, right);
}

function classifyPointOfUseChange(previous, fresh) {
  if (!sameFileSnapshot(previous.journalSnapshot.file, fresh.journalSnapshot.file)) {
    throw error("API_ONLY_MIGRATION_JOURNAL_CHANGED");
  }
  if (!sameFileSnapshot(previous.pointerSnapshot.file, fresh.pointerSnapshot.file)) {
    throw error("API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
  }
  if (previous.acceptedSnapshot || fresh.acceptedSnapshot) {
    if (!previous.acceptedSnapshot || !fresh.acceptedSnapshot) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
    const previousFiles = previous.acceptedSnapshot.files;
    const freshFiles = fresh.acceptedSnapshot.files;
    if (!sameSnapshot(previousFiles[0], freshFiles[0])) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
    if (!sameSnapshot(previousFiles.slice(1), freshFiles.slice(1))) throw error("API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID");
    if (!sameSnapshot(previous.acceptedSnapshot, fresh.acceptedSnapshot)) throw error("API_ONLY_ACCEPTED_VERSION_RECORD_INVALID");
  }
  if (!sameSnapshot(previous.journalSnapshot, fresh.journalSnapshot)) throw error("API_ONLY_MIGRATION_JOURNAL_CHANGED");
  if (!sameSnapshot(previous.pointerSnapshot, fresh.pointerSnapshot)) throw error("API_ONLY_ACTIVE_VERSION_POINTER_CHANGED");
}

async function revalidateLifecycleAuthorityAtPointOfUse(lifecycleAuthority) {
  const metadata = lifecycleBrands.get(lifecycleAuthority);
  if (!metadata
    || metadata.stale
    || !recursivelyFrozen(lifecycleAuthority)
    || metadata.authorityDigest !== sha256(
      Buffer.from("shensi.api-only.lifecycle-authority/v1\0", "utf8"),
      Buffer.from(JSON.stringify(lifecycleAuthority), "utf8")
    )) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
  metadata.stale = true;
  const freshAuthority = await readLifecycleAuthority(metadata.filesystem, metadata.repositoryRoot);
  const freshMetadata = lifecycleBrands.get(freshAuthority);
  classifyPointOfUseChange(metadata, freshMetadata);
  if (JSON.stringify(lifecycleAuthority) !== JSON.stringify(freshAuthority)) throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
  return freshAuthority;
}

export function createApiOnlyAuthorityResolver(dependencies = {}) {
  const provided = stableCall("API_ONLY_AUTHORITY_DEPENDENCY_INVALID", () => {
    if (!plain(dependencies)) {
      throw error("API_ONLY_AUTHORITY_DEPENDENCY_INVALID");
    }
    const values = Object.create(null);
    for (const key of Reflect.ownKeys(dependencies)) {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(dependencies, key) : null;
      if (typeof key !== "string"
        || !ALLOWED_DEPENDENCIES.has(key)
        || descriptor?.enumerable !== true
        || !Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "function") {
        throw error("API_ONLY_AUTHORITY_DEPENDENCY_INVALID");
      }
      values[key] = descriptor.value;
    }
    return values;
  });

  const filesystem = Object.freeze({
    lstat: provided.lstat ?? ((path) => nativeLstat(path, { bigint: true })),
    realpath: provided.realpath ?? nativeRealpath,
    readdir: provided.readdir ?? nativeReaddir,
    open: provided.open ?? nativeOpen,
    getuid: provided.getuid ?? (() => process.getuid?.() ?? 0),
    noFollow: FS.O_NOFOLLOW ?? 0
  });

  return Object.freeze({
    readMigrationJournal: (repositoryRoot) => readMigrationJournal(filesystem, repositoryRoot),
    projectMigrationWitness,
    readLifecycleAuthority: (repositoryRoot) => readLifecycleAuthority(filesystem, repositoryRoot),
    revalidateLifecycleAuthorityAtPointOfUse,
    projectAcceptedResources,
    buildInitialAcceptedVersion,
    buildNextMigrationJournal
  });
}

export function assertApiOnlyAcceptedResourceProjection(value, requiredPhase) {
  const metadata = projectionBrands.get(value);
  const lifecycleMetadata = metadata && lifecycleBrands.get(metadata.source);
  if (!metadata
    || !lifecycleMetadata
    || lifecycleMetadata.stale === true
    || !["write_activation_pending", "accepted"].includes(requiredPhase)
    || metadata.phase !== requiredPhase
    || value.lifecyclePhase !== requiredPhase
    || !recursivelyFrozen(value)
    || projectionDigest(value) !== metadata.digest) {
    throw error("API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID");
  }
  return value;
}
