import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as authorityModule from "./api-only-authority.mjs";

const hex = (character) => character.repeat(64);
const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

function makeInitialBinding(overrides = {}) {
  const attemptId = overrides.migrationAttemptId ?? "0123456789ab";
  const project = overrides.project ?? `shensi-api-migration-${attemptId}`;
  return {
    migrationAttemptId: attemptId,
    project,
    ports: overrides.ports ?? { gateway: 5608, mysql: 3311 },
    runtimeNonce: overrides.runtimeNonce ?? hex("1"),
    engine: overrides.engine ?? { socketIdentity: hex("2"), daemonIdentity: hex("3") },
    networks: overrides.networks ?? {
      internal: {
        id: hex("4"),
        name: `${project}_shensi_internal`,
        identitySha256: hex("5"),
        subnet: "172.31.240.0/24",
        ipamGatewayIp: "172.31.240.1",
        gatewayServiceIp: "172.31.240.2"
      },
      egress: { id: hex("6"), name: `${project}_shensi_egress`, identitySha256: hex("7") },
      host: { id: hex("0"), name: `${project}_shensi_host`, identitySha256: hex("a") }
    },
    mysql: overrides.mysql ?? {
      containerId: hex("8"),
      volumeName: `${project}_mysql_data`,
      volumeIdentitySha256: hex("9"),
      imageIdDigest: `sha256:${hex("a")}`
    },
    backend: overrides.backend ?? {
      imageIdDigest: `sha256:${hex("b")}`,
      composeImageReference: { kind: "engine-image-id", value: `sha256:${hex("b")}` }
    },
    artifacts: overrides.artifacts ?? {
      containerRuntimeSelectionSha256: hex("c"),
      acceptedComposeBaseSha256: hex("d"),
      backendEnvironmentSha256: hex("e"),
      backendImageOverrideSha256: hex("f"),
      gatewayConfigSha256: hex("0"),
      acceptedResourcesSha256: hex("1"),
      task5RecoverySeedCandidateReceiptSha256: hex("2")
    },
    acceptedLiveSchemaHash: overrides.acceptedLiveSchemaHash ?? hex("3"),
    apiContractHash: overrides.apiContractHash ?? hex("4"),
    desktopClientAdmission: overrides.desktopClientAdmission ?? {
      mode: "migration_locked",
      admittedBuildManifestSha256: null
    }
  };
}

function assertDeepFrozen(value) {
  if (value && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
}

function withStatOverrides(info, overrides) {
  return new Proxy(info, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function evidenceDescriptor(character = "5") {
  const digest = hex(character);
  return { basename: `${digest}.json`, sha256: digest };
}

function makeTransition(state = "prepared", overrides = {}) {
  const attemptId = overrides.attemptId ?? "0123456789ab";
  return {
    attemptId,
    project: overrides.project ?? `shensi-api-migration-${attemptId}`,
    source: overrides.source ?? { database: "shensi_trial", port: 3310, commit: "a".repeat(40) },
    target: overrides.target ?? { database: "shensi", port: 3311, commit: "b".repeat(40) },
    state,
    activeRuntime: overrides.activeRuntime ?? (state === "prepared" ? "trial" : null),
    rollbackClosedAt: overrides.rollbackClosedAt ?? null,
    desktopClientAdmission: overrides.desktopClientAdmission ?? { mode: "migration_locked", admittedBuildManifestSha256: null },
    transitionedAt: overrides.transitionedAt ?? "2026-09-04T00:00:00.000Z",
    evidenceManifest: overrides.evidenceManifest ?? evidenceDescriptor("5"),
    failure: overrides.failure ?? null,
    recoveryEvidence: overrides.recoveryEvidence ?? null,
    writeActivation: overrides.writeActivation ?? null,
    acceptedVersion: overrides.acceptedVersion ?? null
  };
}

const JOURNAL_STATES = [
  "prepared", "source_frozen", "target_restored", "cutover_read_only",
  "recovery_pending", "failed_recovered", "rolled_back",
  "write_activation_pending", "accepted"
];

const LEGAL_EDGES = new Map([
  ["prepared", ["source_frozen"]],
  ["source_frozen", ["target_restored", "recovery_pending"]],
  ["target_restored", ["cutover_read_only", "recovery_pending"]],
  ["cutover_read_only", ["rolled_back", "recovery_pending", "write_activation_pending"]],
  ["recovery_pending", ["failed_recovered"]],
  ["failed_recovered", ["prepared"]],
  ["rolled_back", ["prepared"]],
  ["write_activation_pending", ["accepted"]],
  ["accepted", []]
]);

function transitionForState(state, priorBuilt = null, overrides = {}) {
  const prior = priorBuilt?.journal?.attemptSummaries?.at(-1) ?? null;
  const newAttempt = state === "prepared" && prior !== null;
  const attemptId = overrides.attemptId ?? (newAttempt ? "abcdef012345" : prior?.attemptId ?? "0123456789ab");
  const identity = newAttempt ? {} : {
    project: prior?.project,
    source: prior?.source,
    target: prior?.target
  };
  const sequence = (priorBuilt?.journal?.revision ?? 0) + 1;
  const transitionedAt = overrides.transitionedAt ?? `2026-09-${String(4 + Math.floor(sequence / 24)).padStart(2, "0")}T${String(sequence % 24).padStart(2, "0")}:00:00.000Z`;
  const matrix = {
    prepared: { activeRuntime: "trial" },
    source_frozen: { activeRuntime: null },
    target_restored: { activeRuntime: null },
    cutover_read_only: { activeRuntime: "target" },
    recovery_pending: {
      activeRuntime: null,
      failure: { code: "MIGRATION_FAILED", evidence: evidenceDescriptor("6") }
    },
    failed_recovered: {
      activeRuntime: "trial",
      failure: prior?.failure,
      recoveryEvidence: evidenceDescriptor("7")
    },
    rolled_back: { activeRuntime: "trial", recoveryEvidence: evidenceDescriptor("8") },
    write_activation_pending: {
      activeRuntime: "target",
      rollbackClosedAt: transitionedAt,
      writeActivation: { confirmationSha256: hex("9"), resumeBinding: evidenceDescriptor("a") }
    },
    accepted: {
      activeRuntime: "target",
      rollbackClosedAt: prior?.rollbackClosedAt,
      writeActivation: prior?.writeActivation,
      acceptedVersion: { versionId: hex("b"), recordSha256: hex("c") }
    }
  }[state] ?? {};
  return makeTransition(state, { attemptId, ...identity, transitionedAt, ...matrix, ...overrides });
}

function buildJournalPath(resolver, states) {
  let built = null;
  for (const state of states) built = resolver.buildNextMigrationJournal(built?.journal ?? null, transitionForState(state, built));
  return built;
}

async function makeAuthorityRepository() {
  const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), "shensi-authority-test-")));
  await chmod(repositoryRoot, 0o700);
  return repositoryRoot;
}

async function ensureAuthorityRoot(repositoryRoot) {
  const runtimeRoot = join(repositoryRoot, ".runtime", "api-only");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(join(repositoryRoot, ".runtime"), 0o700);
  await chmod(runtimeRoot, 0o700);
  return runtimeRoot;
}

async function snapshotTree(path) {
  const rows = [];
  async function visit(current, relative = ".") {
    let info;
    try { info = await lstat(current); } catch (caught) {
      if (caught?.code === "ENOENT") { rows.push([relative, "absent"]); return; }
      throw caught;
    }
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      const names = (await readdir(current)).sort();
      rows.push([relative, "directory", mode, names]);
      for (const name of names) await visit(join(current, name), relative === "." ? name : `${relative}/${name}`);
    } else if (info.isFile()) {
      rows.push([relative, "file", mode, sha256(await readFile(current))]);
    } else if (info.isSymbolicLink()) {
      rows.push([relative, "symlink", mode]);
    } else rows.push([relative, "other", mode]);
  }
  await visit(path);
  return rows;
}

async function writeCanonicalJournal(repositoryRoot, states = ["prepared"]) {
  const runtimeRoot = await ensureAuthorityRoot(repositoryRoot);
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const built = buildJournalPath(resolver, states);
  const path = join(runtimeRoot, "migration-state.json");
  await writeFile(path, built.canonicalText, { mode: 0o600 });
  await chmod(path, 0o600);
  return { runtimeRoot, path, built };
}

async function writePointer(repositoryRoot, pointer = { versionId: hex("a"), recordSha256: hex("b") }) {
  const runtimeRoot = await ensureAuthorityRoot(repositoryRoot);
  const value = {
    schema: "shensi.api-only.active-version-pointer",
    version: 1,
    versionId: pointer.versionId,
    recordSha256: pointer.recordSha256
  };
  const path = join(runtimeRoot, "active-version.json");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, value };
}

const VERSION_ARTIFACTS = [
  ["containerRuntimeSelection", "container-runtime-selection.json", "containerRuntimeSelectionSha256"],
  ["acceptedComposeBase", "accepted-compose-base.json", "acceptedComposeBaseSha256"],
  ["backendEnvironment", "backend.env", "backendEnvironmentSha256"],
  ["backendImageOverride", "backend-image-override.json", "backendImageOverrideSha256"],
  ["gatewayConfig", "gateway.conf", "gatewayConfigSha256"],
  ["acceptedResources", "accepted-resources.json", "acceptedResourcesSha256"],
  ["task5RecoverySeedCandidateReceipt", "task5-recovery-seed-candidate-receipt.json", "task5RecoverySeedCandidateReceiptSha256"]
];

function artifactFixtureBytes() {
  return Object.fromEntries(VERSION_ARTIFACTS.map(([, basename]) => [basename, Buffer.from(`sealed:${basename}\n`, "utf8")]));
}

async function materializeInitialAcceptedVersion(repositoryRoot, bindingOverrides = {}, journalState = "accepted", byteOverrides = {}) {
  const runtimeRoot = await ensureAuthorityRoot(repositoryRoot);
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const bytes = { ...artifactFixtureBytes(), ...byteOverrides };
  const artifacts = Object.fromEntries(VERSION_ARTIFACTS.map(([, basename, field]) => [field, sha256(bytes[basename])]));
  const binding = makeInitialBinding({ ...bindingOverrides, artifacts });
  const built = resolver.buildInitialAcceptedVersion(binding);
  const expectedVersionId = sha256(
    Buffer.from("shensi.api-only.accepted-version/v1\0", "utf8"),
    Buffer.from(JSON.stringify(binding), "utf8")
  );
  const expectedRecord = {
    schema: "shensi.api-only.accepted-version",
    version: 1,
    kind: "initial_acceptance",
    versionId: expectedVersionId,
    binding
  };
  const expectedRecordBytes = Buffer.from(`${JSON.stringify(expectedRecord)}\n`, "utf8");
  assert.equal(built.versionId, expectedVersionId);
  assert.equal(built.recordSha256, sha256(expectedRecordBytes));
  assert.equal(built.canonicalText, expectedRecordBytes.toString("utf8"));
  const versionsRoot = join(runtimeRoot, "versions");
  const versionRoot = join(versionsRoot, built.versionId);
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await chmod(versionsRoot, 0o700);
  await chmod(versionRoot, 0o700);
  const recordPath = join(versionRoot, "accepted-version.json");
  await writeFile(recordPath, built.canonicalText, { mode: 0o600 });
  await chmod(recordPath, 0o600);
  for (const [, basename] of VERSION_ARTIFACTS) {
    const path = join(versionRoot, basename);
    await writeFile(path, bytes[basename], { mode: 0o600 });
    await chmod(path, 0o600);
  }
  const pointer = await writePointer(repositoryRoot, { versionId: built.versionId, recordSha256: built.recordSha256 });

  let journal = buildJournalPath(resolver, ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending"]);
  if (journalState === "accepted") {
    journal = resolver.buildNextMigrationJournal(journal.journal, transitionForState("accepted", journal, {
      acceptedVersion: { versionId: built.versionId, recordSha256: built.recordSha256 }
    }));
  } else if (journalState !== "write_activation_pending") {
    journal = buildJournalPath(resolver, PATH_TO_STATE[journalState]);
  }
  const journalPath = join(runtimeRoot, "migration-state.json");
  await writeFile(journalPath, journal.canonicalText, { mode: 0o600 });
  await chmod(journalPath, 0o600);
  return { runtimeRoot, versionsRoot, versionRoot, recordPath, pointerPath: pointer.path, pointer: pointer.value, journalPath, journal, built, binding, bytes };
}

async function replaceFileWithSameBytes(path) {
  const replacement = `${path}.replacement`;
  await writeFile(replacement, await readFile(path), { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, path);
}

async function replaceVersionDirectoryWithSameBytes(fixture) {
  const replaced = `${fixture.versionRoot}.replaced`;
  await rename(fixture.versionRoot, replaced);
  await mkdir(fixture.versionRoot, { mode: 0o700 });
  await chmod(fixture.versionRoot, 0o700);
  for (const basename of ["accepted-version.json", ...VERSION_ARTIFACTS.map(([, name]) => name)]) {
    const path = join(fixture.versionRoot, basename);
    await writeFile(path, await readFile(join(replaced, basename)), { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

const PATH_TO_STATE = {
  prepared: ["prepared"],
  source_frozen: ["prepared", "source_frozen"],
  target_restored: ["prepared", "source_frozen", "target_restored"],
  cutover_read_only: ["prepared", "source_frozen", "target_restored", "cutover_read_only"],
  recovery_pending: ["prepared", "source_frozen", "recovery_pending"],
  failed_recovered: ["prepared", "source_frozen", "recovery_pending", "failed_recovered"],
  rolled_back: ["prepared", "source_frozen", "target_restored", "cutover_read_only", "rolled_back"],
  write_activation_pending: ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending"],
  accepted: ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending", "accepted"]
};

test("authority resolver exposes only the closed B2 API", () => {
  assert.deepEqual(Object.keys(authorityModule).sort(), [
    "assertApiOnlyAcceptedResourceProjection",
    "createApiOnlyAuthorityResolver"
  ]);

  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  assert.equal(Object.isFrozen(resolver), true);
  assert.deepEqual(Object.keys(resolver).sort(), [
    "buildInitialAcceptedVersion",
    "buildNextMigrationJournal",
    "projectAcceptedResources",
    "projectMigrationWitness",
    "readLifecycleAuthority",
    "readMigrationJournal",
    "revalidateLifecycleAuthorityAtPointOfUse"
  ]);
  for (const method of Object.values(resolver)) assert.equal(typeof method, "function");

  for (const key of ["lstat", "realpath", "readdir", "open", "getuid"]) {
    const partial = authorityModule.createApiOnlyAuthorityResolver({ [key]: () => undefined });
    assert.equal(Object.isFrozen(partial), true);
  }
  assert.throws(() => authorityModule.createApiOnlyAuthorityResolver({ readFile: () => undefined }), /API_ONLY_AUTHORITY_DEPENDENCY_INVALID/u);
  assert.throws(() => authorityModule.createApiOnlyAuthorityResolver({ open: true }), /API_ONLY_AUTHORITY_DEPENDENCY_INVALID/u);
  const accessorDependency = {};
  Object.defineProperty(accessorDependency, "open", {
    enumerable: true,
    get() { throw new Error("DEPENDENCY_ACCESSOR_MUST_NOT_RUN"); }
  });
  assert.throws(() => authorityModule.createApiOnlyAuthorityResolver(accessorDependency), /API_ONLY_AUTHORITY_DEPENDENCY_INVALID/u);
  assert.throws(
    () => authorityModule.createApiOnlyAuthorityResolver(Object.create({ getuid: () => (process.getuid?.() ?? 0) + 1 })),
    /API_ONLY_AUTHORITY_DEPENDENCY_INVALID/u
  );
  const hostileDependencies = new Proxy({}, {
    getPrototypeOf() { throw new Error("SECRET:/Users/private/dependencies"); }
  });
  assert.throws(
    () => authorityModule.createApiOnlyAuthorityResolver(hostileDependencies),
    (caught) => caught?.message === "API_ONLY_AUTHORITY_DEPENDENCY_INVALID"
  );
});

test("initial accepted version builder produces canonical mutually-bound bytes", () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const binding = makeInitialBinding();
  const versionId = sha256(
    Buffer.from("shensi.api-only.accepted-version/v1\0", "utf8"),
    Buffer.from(JSON.stringify(binding), "utf8")
  );
  const record = {
    schema: "shensi.api-only.accepted-version",
    version: 1,
    kind: "initial_acceptance",
    versionId,
    binding
  };
  const canonicalText = `${JSON.stringify(record)}\n`;
  const built = resolver.buildInitialAcceptedVersion(binding);
  assert.deepEqual(built, {
    versionId,
    record,
    canonicalText,
    recordSha256: sha256(Buffer.from(canonicalText, "utf8"))
  });
  assertDeepFrozen(built);

  const repositoryDigestBinding = makeInitialBinding({
    backend: {
      ...binding.backend,
      composeImageReference: {
        kind: "repository-digest",
        value: `registry.example:5000/shensi/backend@sha256:${hex("c")}`
      }
    }
  });
  assert.equal(resolver.buildInitialAcceptedVersion(repositoryDigestBinding).record.binding.backend.composeImageReference.kind, "repository-digest");

  const symbolExtra = makeInitialBinding();
  symbolExtra[Symbol("extra")] = true;
  const hiddenExtra = makeInitialBinding();
  Object.defineProperty(hiddenExtra, "hidden", { value: true });
  const accessor = makeInitialBinding();
  Object.defineProperty(accessor, "runtimeNonce", {
    enumerable: true,
    get() { throw new Error("ACCESSOR_MUST_NOT_RUN"); }
  });

  const invalid = [
    { ...binding, extra: true },
    { project: binding.project, migrationAttemptId: binding.migrationAttemptId, ...Object.fromEntries(Object.entries(binding).slice(2)) },
    makeInitialBinding({ migrationAttemptId: "ABC" }),
    makeInitialBinding({ migrationAttemptId: "0123456789ab\n", project: "shensi-api-migration-0123456789ab\n" }),
    makeInitialBinding({ project: "shensi-api" }),
    makeInitialBinding({ ports: { gateway: 5609, mysql: 3311 } }),
    makeInitialBinding({ ports: { mysql: 3311, gateway: 5608 } }),
    makeInitialBinding({ networks: { ...binding.networks, internal: { ...binding.networks.internal, subnet: "172.31.240.1/24" } } }),
    makeInitialBinding({ networks: { ...binding.networks, internal: { ...binding.networks.internal, gatewayServiceIp: "172.31.241.2" } } }),
    makeInitialBinding({ networks: { ...binding.networks, internal: { ...binding.networks.internal, name: "wrong" } } }),
    makeInitialBinding({ mysql: { ...binding.mysql, volumeName: "wrong" } }),
    makeInitialBinding({ backend: { ...binding.backend, composeImageReference: { kind: "engine-image-id", value: `sha256:${hex("c")}` } } }),
    makeInitialBinding({ backend: { ...binding.backend, composeImageReference: { kind: "repository-digest", value: "https://registry.example/image@sha256:" + hex("c") } } }),
    makeInitialBinding({ backend: { ...binding.backend, composeImageReference: { kind: "repository-digest", value: "NOT[OCI]?@sha256:" + hex("c") } } }),
    makeInitialBinding({ runtimeNonce: { toString: () => hex("1") } }),
    makeInitialBinding({ desktopClientAdmission: { mode: "exact", admittedBuildManifestSha256: null } }),
    makeInitialBinding({ desktopClientAdmission: { mode: "migration_locked", admittedBuildManifestSha256: hex("a") } }),
    makeInitialBinding({ desktopClientAdmission: { admittedBuildManifestSha256: null, mode: "migration_locked" } }),
    symbolExtra,
    hiddenExtra,
    accessor
  ];
  for (const value of invalid) {
    assert.throws(() => resolver.buildInitialAcceptedVersion(value), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  }
  const hostileBinding = new Proxy({}, {
    getPrototypeOf() { throw new Error("SECRET:/Users/private/binding"); }
  });
  assert.throws(
    () => resolver.buildInitialAcceptedVersion(hostileBinding),
    (caught) => caught?.message === "API_ONLY_ACCEPTED_VERSION_RECORD_INVALID"
  );
});

test("migration journal builds one canonical initial prepared summary", () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const transition = makeTransition();
  const summaryCore = {
    sequence: 1,
    ...transition,
    previousSummarySha256: null
  };
  const summarySha256 = sha256(
    Buffer.from("shensi.api-only.migration-summary/v1\0", "utf8"),
    Buffer.from(JSON.stringify(summaryCore), "utf8")
  );
  const summary = { ...summaryCore, summarySha256 };
  const journal = {
    schema: "shensi.api-only.migration-journal",
    version: 1,
    revision: 1,
    state: "prepared",
    activeRuntime: "trial",
    activeAttemptId: transition.attemptId,
    rollbackClosedAt: null,
    desktopClientAdmission: transition.desktopClientAdmission,
    headSummarySha256: summarySha256,
    attemptSummaries: [summary]
  };
  const built = resolver.buildNextMigrationJournal(null, transition);
  assert.deepEqual(built, { journal, canonicalText: `${JSON.stringify(journal)}\n` });
  assertDeepFrozen(built);

  for (const invalid of [
    makeTransition("source_frozen"),
    [transition],
    makeTransition("bootstrap"),
    makeTransition("prepared", { transitionedAt: "2026-09-04T00:00:00Z" }),
    makeTransition("prepared", { evidenceManifest: { basename: "../secret", sha256: hex("5") } }),
    makeTransition("prepared", { failure: { code: "dynamic message", evidence: evidenceDescriptor("6") } }),
    makeTransition("prepared", { attemptId: "0123456789ab\n", project: "shensi-api-migration-0123456789ab\n" }),
    makeTransition("prepared", { source: { database: "shensi_trial", port: 3310, commit: `${"a".repeat(40)}\n` } }),
    makeTransition("prepared", { failure: { code: "FAILURE\n", evidence: evidenceDescriptor("6") } }),
    { project: transition.project, attemptId: transition.attemptId, ...Object.fromEntries(Object.entries(transition).slice(2)) }
  ]) {
    assert.throws(() => resolver.buildNextMigrationJournal(null, invalid), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  }
  const hostileTransition = new Proxy({}, {
    getPrototypeOf() { throw new Error("SECRET:/Users/private/transition"); }
  });
  assert.throws(
    () => resolver.buildNextMigrationJournal(null, hostileTransition),
    (caught) => caught?.message === "API_ONLY_MIGRATION_JOURNAL_INVALID"
  );
});

test("migration journal accepts only the exact append-only transition graph", () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();

  for (const [from, allowed] of LEGAL_EDGES) {
    for (const to of allowed) {
      const prior = buildJournalPath(resolver, PATH_TO_STATE[from]);
      const next = transitionForState(to, prior);
      const beforePrefix = JSON.stringify(prior.journal.attemptSummaries);
      const result = resolver.buildNextMigrationJournal(prior.journal, next);
      assert.equal(result.journal.state, to);
      assert.equal(result.journal.revision, prior.journal.revision + 1);
      assert.equal(JSON.stringify(result.journal.attemptSummaries.slice(0, -1)), beforePrefix);
      assert.equal(result.journal.headSummarySha256, result.journal.attemptSummaries.at(-1).summarySha256);
      assertDeepFrozen(result);
    }
  }

  for (const from of JOURNAL_STATES) {
    const prior = buildJournalPath(resolver, PATH_TO_STATE[from]);
    for (const to of JOURNAL_STATES.filter((candidate) => !LEGAL_EDGES.get(from).includes(candidate))) {
      assert.throws(
        () => resolver.buildNextMigrationJournal(prior.journal, transitionForState(to, prior)),
        /API_ONLY_MIGRATION_JOURNAL_INVALID/u,
        `${from} -> ${to}`
      );
    }
  }

  const frozen = buildJournalPath(resolver, PATH_TO_STATE.source_frozen);
  assert.throws(() => resolver.buildNextMigrationJournal(frozen.journal, transitionForState("target_restored", frozen, { activeRuntime: "trial" })), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  assert.throws(() => resolver.buildNextMigrationJournal(frozen.journal, transitionForState("target_restored", frozen, { project: "shensi-api-migration-abcdef012345" })), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);

  const recovered = buildJournalPath(resolver, PATH_TO_STATE.failed_recovered);
  assert.throws(() => resolver.buildNextMigrationJournal(recovered.journal, transitionForState("prepared", recovered, { attemptId: recovered.journal.activeAttemptId })), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  const retry = resolver.buildNextMigrationJournal(recovered.journal, transitionForState("prepared", recovered));
  assert.equal(retry.journal.activeAttemptId, "abcdef012345");
  assert.equal(retry.journal.attemptSummaries.at(-1).failure, null);

  const pending = buildJournalPath(resolver, PATH_TO_STATE.write_activation_pending);
  assert.throws(() => resolver.buildNextMigrationJournal(pending.journal, transitionForState("accepted", pending, { rollbackClosedAt: "2026-09-10T00:00:00.000Z" })), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  assert.throws(() => resolver.buildNextMigrationJournal(pending.journal, transitionForState("accepted", pending, { writeActivation: { confirmationSha256: hex("d"), resumeBinding: evidenceDescriptor("a") } })), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);

  const accepted = buildJournalPath(resolver, PATH_TO_STATE.accepted);
  assert.throws(() => resolver.buildNextMigrationJournal(accepted.journal, transitionForState("prepared", accepted)), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  assert.throws(() => resolver.buildNextMigrationJournal({}, transitionForState("prepared")), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  assert.throws(() => resolver.buildNextMigrationJournal(null, [transitionForState("prepared")]), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);

  let bounded = buildJournalPath(resolver, PATH_TO_STATE.rolled_back);
  let hitBound = false;
  for (let index = 0; index < 1100 && !hitBound; index += 1) {
    try {
      bounded = resolver.buildNextMigrationJournal(bounded.journal, transitionForState("prepared", bounded, { attemptId: index.toString(16).padStart(12, "0") }));
      bounded = resolver.buildNextMigrationJournal(bounded.journal, transitionForState("source_frozen", bounded));
      bounded = resolver.buildNextMigrationJournal(bounded.journal, transitionForState("target_restored", bounded));
      bounded = resolver.buildNextMigrationJournal(bounded.journal, transitionForState("cutover_read_only", bounded));
      bounded = resolver.buildNextMigrationJournal(bounded.journal, transitionForState("rolled_back", bounded));
    } catch (caught) {
      assert.match(caught.message, /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
      hitBound = true;
    }
  }
  assert.equal(hitBound, true);
});

test("migration journal reader is canonical descriptor-safe and side-effect free", async () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const absentRoot = await makeAuthorityRepository();
  try {
    const before = await snapshotTree(absentRoot);
    assert.equal(await resolver.readMigrationJournal(absentRoot), null);
    assert.deepEqual(await snapshotTree(absentRoot), before);
  } finally { await rm(absentRoot, { recursive: true, force: true }); }

  const validRoot = await makeAuthorityRepository();
  try {
    const { built } = await writeCanonicalJournal(validRoot, ["prepared", "source_frozen"]);
    const before = await snapshotTree(validRoot);
    const journal = await resolver.readMigrationJournal(validRoot);
    assert.deepEqual(journal, built.journal);
    assertDeepFrozen(journal);
    const advanced = resolver.buildNextMigrationJournal(journal, transitionForState("target_restored", { journal }));
    assert.equal(advanced.journal.state, "target_restored");
    assert.deepEqual(await snapshotTree(validRoot), before);
  } finally { await rm(validRoot, { recursive: true, force: true }); }

  const byteMutations = [
    (text) => `\uFEFF${text}`,
    (text) => text.slice(0, -1),
    (text) => `${text}\n`,
    (text) => text.replace("migration-journal", "migration-journal\0"),
    () => Buffer.from([0xff, 0xfe, 0xfd]),
    (text) => text.slice(0, -1) + " \n",
    (text) => text.replace("shensi.api-only.migration-journal", "shensi.api-only.other-journal"),
    (text) => text.replace(/"summarySha256":"[a-f0-9]{64}"/u, `"summarySha256":"${hex("f")}"`),
    (text) => text.replace('"schema":"shensi.api-only.migration-journal","version":1', '"version":1,"schema":"shensi.api-only.migration-journal"'),
    (text) => text.slice(0, Math.floor(text.length / 2))
  ];
  for (const mutate of byteMutations) {
    const root = await makeAuthorityRepository();
    try {
      const { path, built } = await writeCanonicalJournal(root);
      await writeFile(path, mutate(built.canonicalText), { mode: 0o600 });
      await assert.rejects(resolver.readMigrationJournal(root), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  for (const kind of ["mode", "hardlink", "symlink", "zero", "oversized", "directory"]) {
    const root = await makeAuthorityRepository();
    try {
      const { path, built } = await writeCanonicalJournal(root);
      if (kind === "mode") await chmod(path, 0o644);
      if (kind === "hardlink") await link(path, join(root, "journal-link"));
      if (kind === "symlink") {
        const target = join(root, "journal-target");
        await writeFile(target, built.canonicalText, { mode: 0o600 });
        await rm(path);
        await symlink(target, path);
      }
      if (kind === "zero") await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
      if (kind === "oversized") await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
      if (kind === "directory") {
        await rm(path);
        await mkdir(path, { mode: 0o700 });
      }
      await assert.rejects(resolver.readMigrationJournal(root), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  const wrongOwnerRoot = await makeAuthorityRepository();
  try {
    const { path } = await writeCanonicalJournal(wrongOwnerRoot);
    const wrongOwner = authorityModule.createApiOnlyAuthorityResolver({
      lstat: async (candidate) => {
        const info = await lstat(candidate);
        return candidate === path ? withStatOverrides(info, { uid: Number(info.uid) + 1 }) : info;
      }
    });
    await assert.rejects(wrongOwner.readMigrationJournal(wrongOwnerRoot), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  } finally { await rm(wrongOwnerRoot, { recursive: true, force: true }); }

  const raceRoot = await makeAuthorityRepository();
  try {
    const { path, built } = await writeCanonicalJournal(raceRoot);
    let replaced = false;
    const racing = authorityModule.createApiOnlyAuthorityResolver({
      open: async (candidate, flags, mode) => {
        const handle = await open(candidate, flags, mode);
        if (!replaced && candidate === path) {
          replaced = true;
          const replacement = `${path}.replacement`;
          await writeFile(replacement, built.canonicalText, { mode: 0o600 });
          await rename(replacement, path);
        }
        return handle;
      }
    });
    await assert.rejects(racing.readMigrationJournal(raceRoot), /API_ONLY_MIGRATION_JOURNAL_(?:INVALID|CHANGED)/u);
  } finally { await rm(raceRoot, { recursive: true, force: true }); }

  const openRaceRoot = await makeAuthorityRepository();
  try {
    const { path, built } = await writeCanonicalJournal(openRaceRoot);
    let replaced = false;
    const racing = authorityModule.createApiOnlyAuthorityResolver({
      open: async (candidate, flags, mode) => {
        if (!replaced && candidate === path) {
          replaced = true;
          const replacement = join(openRaceRoot, "journal-replacement");
          await writeFile(replacement, built.canonicalText, { mode: 0o600 });
          await rename(replacement, path);
        }
        return open(candidate, flags, mode);
      }
    });
    await assert.rejects(racing.readMigrationJournal(openRaceRoot), /API_ONLY_MIGRATION_JOURNAL_CHANGED/u);
  } finally { await rm(openRaceRoot, { recursive: true, force: true }); }

  const synchronousCloseRoot = await makeAuthorityRepository();
  const nativeHandles = [];
  try {
    await writeCanonicalJournal(synchronousCloseRoot);
    let closeCalls = 0;
    const resolverWithSynchronousCloseFault = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        nativeHandles.push(handle);
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => handle.read(...args),
          close: () => {
            closeCalls += 1;
            if (closeCalls === 1) throw new Error("SECRET:/Users/private/authority");
            return handle.close();
          }
        };
      }
    });
    const failure = await resolverWithSynchronousCloseFault.readMigrationJournal(synchronousCloseRoot).then(() => null, (caught) => caught);
    assert.equal(failure?.message, "API_ONLY_MIGRATION_JOURNAL_INVALID");
    assert.equal((failure?.message ?? "").includes("SECRET"), false);
    assert.equal(closeCalls, 2);
  } finally {
    await Promise.allSettled(nativeHandles.map((handle) => handle.close()));
    await rm(synchronousCloseRoot, { recursive: true, force: true });
  }

  const finalStatRoot = await makeAuthorityRepository();
  try {
    await writeCanonicalJournal(finalStatRoot);
    const tracked = [];
    let statCalls = 0;
    const resolverWithFault = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const state = { closed: false };
        tracked.push(state);
        const isJournal = path.endsWith("migration-state.json");
        return {
          stat: (...args) => {
            if (isJournal && ++statCalls === 5) throw new Error("SECRET:/tmp/private");
            return handle.stat(...args);
          },
          read: (...args) => handle.read(...args),
          close: async () => { state.closed = true; return handle.close(); }
        };
      }
    });
    const failure = await resolverWithFault.readLifecycleAuthority(finalStatRoot).then(() => null, (caught) => caught);
    assert.equal(failure?.message, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
    assert.equal((failure?.message ?? "").includes("SECRET"), false);
    assert.equal(tracked.every(({ closed }) => closed), true);
  } finally { await rm(finalStatRoot, { recursive: true, force: true }); }

  const retainedStatRoot = await makeAuthorityRepository();
  try {
    await writeCanonicalJournal(retainedStatRoot);
    let journalHandles = 0;
    const tracked = [];
    const resolverWithFault = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const state = { closed: false };
        tracked.push(state);
        const selected = path.endsWith("migration-state.json") && ++journalHandles === 1;
        let selectedStatCalls = 0;
        return {
          stat: (...args) => {
            if (selected && ++selectedStatCalls === 5) throw new Error("SECRET:/tmp/retained");
            return handle.stat(...args);
          },
          read: (...args) => handle.read(...args),
          close: async () => { state.closed = true; return handle.close(); }
        };
      }
    });
    const failure = await resolverWithFault.readLifecycleAuthority(retainedStatRoot).then(() => null, (caught) => caught);
    assert.equal(failure?.message, "API_ONLY_MIGRATION_JOURNAL_CHANGED");
    assert.equal((failure?.message ?? "").includes("SECRET"), false);
    assert.equal(tracked.every(({ closed }) => closed), true);
  } finally { await rm(retainedStatRoot, { recursive: true, force: true }); }

  const namespaceCollisionRoot = await makeAuthorityRepository();
  try {
    const resolverWithSpoofedError = authorityModule.createApiOnlyAuthorityResolver({
      lstat: async () => {
        throw Object.assign(new Error("SECRET:/Users/private/repository"), {
          code: "API_ONLY_MIGRATION_JOURNAL_CHANGED"
        });
      }
    });
    const failure = await resolverWithSpoofedError.readMigrationJournal(namespaceCollisionRoot).then(() => null, (caught) => caught);
    assert.equal(failure?.message, "API_ONLY_MIGRATION_JOURNAL_INVALID");
    assert.equal(failure?.code, "API_ONLY_MIGRATION_JOURNAL_INVALID");
    assert.equal((failure?.message ?? "").includes("SECRET"), false);
  } finally { await rm(namespaceCollisionRoot, { recursive: true, force: true }); }

  const replayRoot = await makeAuthorityRepository();
  try {
    const replayed = (() => {
      try {
        resolver.buildInitialAcceptedVersion({});
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert.equal(Object.isFrozen(replayed), true);
    assert.equal(Reflect.set(replayed, "code", "API_ONLY_MIGRATION_JOURNAL_CHANGED"), false);
    assert.equal(Reflect.set(replayed, "message", "SECRET:/Users/private/repository"), false);
    const resolverWithReplayedError = authorityModule.createApiOnlyAuthorityResolver({
      lstat: async () => { throw replayed; }
    });
    const failure = await resolverWithReplayedError.readMigrationJournal(replayRoot).then(() => null, (caught) => caught);
    assert.equal((failure?.message ?? "").includes("SECRET"), false);
    assert.match(failure?.code ?? "", /^API_ONLY_/u);
  } finally { await rm(replayRoot, { recursive: true, force: true }); }

  const appearanceRoot = await makeAuthorityRepository();
  try {
    const runtimeRoot = await ensureAuthorityRoot(appearanceRoot);
    const path = join(runtimeRoot, "migration-state.json");
    const built = buildJournalPath(resolver, ["prepared"]);
    let appeared = false;
    const racing = authorityModule.createApiOnlyAuthorityResolver({
      lstat: async (candidate) => {
        try { return await lstat(candidate); } catch (caught) {
          if (!appeared && candidate === path && caught?.code === "ENOENT") {
            appeared = true;
            await writeFile(path, built.canonicalText, { mode: 0o600 });
          }
          throw caught;
        }
      }
    });
    await assert.rejects(racing.readMigrationJournal(appearanceRoot), /API_ONLY_MIGRATION_JOURNAL_CHANGED/u);
  } finally { await rm(appearanceRoot, { recursive: true, force: true }); }
});

test("lifecycle authority distinguishes bootstrap and migration without selecting bytes", async () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();
  const bootstrapRoot = await makeAuthorityRepository();
  try {
    const authority = await resolver.readLifecycleAuthority(bootstrapRoot);
    assert.deepEqual(authority, { phase: "bootstrap", migration: null, acceptedVersion: null });
    assertDeepFrozen(authority);
  } finally { await rm(bootstrapRoot, { recursive: true, force: true }); }

  const migrationRoot = await makeAuthorityRepository();
  try {
    const { built } = await writeCanonicalJournal(migrationRoot, ["prepared", "source_frozen", "target_restored"]);
    const authority = await resolver.readLifecycleAuthority(migrationRoot);
    const head = built.journal.attemptSummaries.at(-1);
    assert.deepEqual(authority, {
      phase: "migration",
      migration: {
        revision: 3,
        state: "target_restored",
        activeRuntime: null,
        activeAttemptId: head.attemptId,
        rollbackClosedAt: null,
        desktopClientAdmission: head.desktopClientAdmission,
        headSummarySha256: head.summarySha256,
        writeActivation: null,
        acceptedVersion: null
      },
      acceptedVersion: null
    });
    assertDeepFrozen(authority);
  } finally { await rm(migrationRoot, { recursive: true, force: true }); }

  const malformedRoot = await makeAuthorityRepository();
  try {
    const { path } = await writeCanonicalJournal(malformedRoot);
    await writeFile(path, '{"state":"bootstrap"}\n', { mode: 0o600 });
    await assert.rejects(resolver.readLifecycleAuthority(malformedRoot), /API_ONLY_MIGRATION_JOURNAL_INVALID/u);
  } finally { await rm(malformedRoot, { recursive: true, force: true }); }

  const conflictRoot = await makeAuthorityRepository();
  try {
    await writeCanonicalJournal(conflictRoot, ["prepared", "source_frozen"]);
    await writePointer(conflictRoot);
    await assert.rejects(resolver.readLifecycleAuthority(conflictRoot), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(conflictRoot, { recursive: true, force: true }); }
});

test("accepted authority reads one canonical mutually-bound version", async () => {
  const root = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(root);
    const before = await snapshotTree(root);
    const resolver = authorityModule.createApiOnlyAuthorityResolver();
    const authority = await resolver.readLifecycleAuthority(root);
    const expectedArtifacts = Object.fromEntries(VERSION_ARTIFACTS.map(([name, basename, field]) => [name, {
      path: join(fixture.versionRoot, basename),
      sha256: fixture.binding.artifacts[field]
    }]));
    const head = fixture.journal.journal.attemptSummaries.at(-1);
    assert.deepEqual(authority, {
      phase: "accepted",
      migration: {
        revision: fixture.journal.journal.revision,
        state: "accepted",
        activeRuntime: "target",
        activeAttemptId: fixture.binding.migrationAttemptId,
        rollbackClosedAt: head.rollbackClosedAt,
        desktopClientAdmission: fixture.binding.desktopClientAdmission,
        headSummarySha256: head.summarySha256,
        writeActivation: head.writeActivation,
        acceptedVersion: { versionId: fixture.built.versionId, recordSha256: fixture.built.recordSha256 }
      },
      acceptedVersion: {
        runtimeRoot: fixture.runtimeRoot,
        versionRoot: fixture.versionRoot,
        pointerPath: fixture.pointerPath,
        recordPath: fixture.recordPath,
        pointer: fixture.pointer,
        record: fixture.built.record,
        artifacts: expectedArtifacts
      }
    });
    assert.equal(authority.acceptedVersion.record.binding.project, "shensi-api-migration-0123456789ab");
    assert.equal(authority.acceptedVersion.versionRoot.endsWith(fixture.built.versionId), true);
    assert.equal(JSON.stringify(authority).includes("sealed:backend.env"), false);
    assertDeepFrozen(authority);
    assert.deepEqual(await readdir(fixture.versionRoot), [
      "accepted-compose-base.json",
      "accepted-resources.json",
      "accepted-version.json",
      "backend-image-override.json",
      "backend.env",
      "container-runtime-selection.json",
      "gateway.conf",
      "task5-recovery-seed-candidate-receipt.json"
    ]);
    assert.deepEqual(await snapshotTree(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepted authority rejects every pointer or record substitution", async () => {
  const mutateFixture = async (mutate, expected = /API_ONLY_(?:ACTIVE_VERSION_POINTER|ACCEPTED_VERSION_RECORD)_(?:INVALID|CHANGED)/u) => {
    const root = await makeAuthorityRepository();
    try {
      const fixture = await materializeInitialAcceptedVersion(root);
      await mutate(fixture, root);
      await assert.rejects(authorityModule.createApiOnlyAuthorityResolver().readLifecycleAuthority(root), expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  };

  await mutateFixture(async ({ recordPath }) => rm(recordPath), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ versionRoot, recordPath }) => {
    const wrong = join(versionRoot, "..", hex("f"));
    await mkdir(wrong, { mode: 0o700 });
    await rename(recordPath, join(wrong, "accepted-version.json"));
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ built, pointerPath }) => {
    await writeFile(pointerPath, `${JSON.stringify({ schema: "shensi.api-only.active-version-pointer", version: 1, versionId: built.versionId, recordSha256: hex("f") })}\n`, { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ built, recordPath }) => {
    const record = { ...built.record, versionId: hex("f") };
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ built, recordPath, pointerPath }) => {
    const record = { ...built.record, binding: { ...built.record.binding, runtimeNonce: hex("f") } };
    const text = `${JSON.stringify(record)}\n`;
    await writeFile(recordPath, text, { mode: 0o600 });
    await writeFile(pointerPath, `${JSON.stringify({ schema: "shensi.api-only.active-version-pointer", version: 1, versionId: built.versionId, recordSha256: sha256(Buffer.from(text)) })}\n`, { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ pointerPath, pointer }) => {
    await writeFile(pointerPath, `{"version":1,"schema":"shensi.api-only.active-version-pointer","versionId":"${pointer.versionId}","recordSha256":"${pointer.recordSha256}"}\n`, { mode: 0o600 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath, pointer }) => {
    await writeFile(pointerPath, `{"schema":"shensi.api-only.active-version-pointer","version":1,"versionId":"${pointer.versionId}","versionId":"${pointer.versionId}","recordSha256":"${pointer.recordSha256}"}\n`, { mode: 0o600 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => {
    await writeFile(pointerPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(pointerPath)]), { mode: 0o600 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => {
    const bytes = await readFile(pointerPath);
    await writeFile(pointerPath, bytes.subarray(0, bytes.length - 1), { mode: 0o600 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => {
    await writeFile(pointerPath, Buffer.concat([await readFile(pointerPath), Buffer.from("\n")]), { mode: 0o600 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => writeFile(pointerPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 }), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => writeFile(pointerPath, Buffer.alloc(0), { mode: 0o600 }), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => chmod(pointerPath, 0o644), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }, root) => link(pointerPath, join(root, "pointer-link")), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }, root) => {
    const target = join(root, "pointer-target");
    await writeFile(target, await readFile(pointerPath), { mode: 0o600 });
    await rm(pointerPath);
    await symlink(target, pointerPath);
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ pointerPath }) => {
    await rm(pointerPath);
    await mkdir(pointerPath, { mode: 0o700 });
  }, /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await mutateFixture(async ({ recordPath }) => {
    await writeFile(recordPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(recordPath)]), { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ recordPath }) => {
    const bytes = await readFile(recordPath);
    await writeFile(recordPath, bytes.subarray(0, bytes.length - 1), { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ recordPath }) => {
    await writeFile(recordPath, Buffer.concat([await readFile(recordPath), Buffer.from("\n")]), { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ recordPath }) => {
    await writeFile(recordPath, Buffer.alloc(65537, 0x61), { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  await mutateFixture(async ({ built, recordPath, pointerPath }) => {
    const record = { ...built.record, extra: true };
    const text = `${JSON.stringify(record)}\n`;
    await writeFile(recordPath, text, { mode: 0o600 });
    await writeFile(pointerPath, `${JSON.stringify({ schema: "shensi.api-only.active-version-pointer", version: 1, versionId: built.versionId, recordSha256: sha256(Buffer.from(text)) })}\n`, { mode: 0o600 });
  }, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);

  const raceRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(raceRoot);
    let replaced = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!replaced && path === fixture.recordPath) {
          replaced = true;
          const replacement = `${fixture.pointerPath}.replacement`;
          await writeFile(replacement, `${JSON.stringify(fixture.pointer)}\n`, { mode: 0o600 });
          await rename(replacement, fixture.pointerPath);
        }
        return handle;
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(raceRoot), /API_ONLY_ACTIVE_VERSION_POINTER_CHANGED/u);
  } finally { await rm(raceRoot, { recursive: true, force: true }); }

  const recordOpenRaceRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(recordOpenRaceRoot);
    let replaced = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        if (!replaced && path === fixture.recordPath) {
          replaced = true;
          const replacement = join(recordOpenRaceRoot, "record-replacement");
          await writeFile(replacement, await readFile(fixture.recordPath), { mode: 0o600 });
          await rename(replacement, fixture.recordPath);
        }
        return open(path, flags, mode);
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(recordOpenRaceRoot), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  } finally { await rm(recordOpenRaceRoot, { recursive: true, force: true }); }

  const pointerOpenRaceRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(pointerOpenRaceRoot);
    let replaced = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        if (!replaced && path === fixture.pointerPath) {
          replaced = true;
          const replacement = join(pointerOpenRaceRoot, "pointer-replacement");
          await writeFile(replacement, `${JSON.stringify(fixture.pointer)}\n`, { mode: 0o600 });
          await rename(replacement, fixture.pointerPath);
        }
        return open(path, flags, mode);
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(pointerOpenRaceRoot), /API_ONLY_ACTIVE_VERSION_POINTER_CHANGED/u);
  } finally { await rm(pointerOpenRaceRoot, { recursive: true, force: true }); }

  const pointerAppearanceRoot = await makeAuthorityRepository();
  try {
    const runtimeRoot = await ensureAuthorityRoot(pointerAppearanceRoot);
    const pointerPath = join(runtimeRoot, "active-version.json");
    let appeared = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      lstat: async (candidate) => {
        try { return await lstat(candidate); } catch (caught) {
          if (!appeared && candidate === pointerPath && caught?.code === "ENOENT") {
            appeared = true;
            await writeFile(pointerPath, "appeared\n", { mode: 0o600 });
          }
          throw caught;
        }
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(pointerAppearanceRoot), /API_ONLY_ACTIVE_VERSION_POINTER_CHANGED/u);
  } finally { await rm(pointerAppearanceRoot, { recursive: true, force: true }); }
});

test("accepted authority rejects unsafe filesystem identities", async () => {
  const pathResolver = authorityModule.createApiOnlyAuthorityResolver();
  for (const repositoryRoot of ["relative/repository", "/tmp/../tmp", "/tmp/authority\0suffix"]) {
    await assert.rejects(pathResolver.readLifecycleAuthority(repositoryRoot), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  }

  const emptyRoot = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(emptyRoot, {}, "accepted", { "accepted-resources.json": Buffer.alloc(0) });
    const authority = await authorityModule.createApiOnlyAuthorityResolver().readLifecycleAuthority(emptyRoot);
    assert.equal(authority.phase, "accepted");
  } finally { await rm(emptyRoot, { recursive: true, force: true }); }

  const unsafe = async (mutate, expected = /API_ONLY_ACCEPTED_VERSION_(?:RECORD|ARTIFACT)_INVALID/u, resolverFactory = () => authorityModule.createApiOnlyAuthorityResolver()) => {
    const root = await makeAuthorityRepository();
    try {
      const fixture = await materializeInitialAcceptedVersion(root);
      await mutate(fixture, root);
      await assert.rejects(resolverFactory(fixture, root).readLifecycleAuthority(root), expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  };

  await unsafe(async ({ versionRoot }) => chmod(versionRoot, 0o755));
  await unsafe(async ({ versionsRoot }) => chmod(versionsRoot, 0o755));
  await unsafe(async ({ runtimeRoot }) => chmod(runtimeRoot, 0o755));
  await unsafe(async (_fixture, root) => chmod(root, 0o775));
  await unsafe(async (_fixture, root) => chmod(join(root, ".runtime"), 0o775));
  await unsafe(async (_fixture, root) => {
    const runtimeParent = join(root, ".runtime");
    const target = join(root, "runtime-parent-target");
    await rename(runtimeParent, target);
    await symlink(target, runtimeParent);
  });
  await unsafe(async (_fixture, root) => {
    await rm(join(root, ".runtime"), { recursive: true, force: true });
    await writeFile(join(root, ".runtime"), "not-a-directory", { mode: 0o600 });
  });
  await unsafe(async ({ runtimeRoot }, root) => {
    const target = join(root, "api-only-target");
    await rename(runtimeRoot, target);
    await symlink(target, runtimeRoot);
  });
  for (const directoryName of ["runtimeRoot", "versionsRoot", "versionRoot"]) {
    await unsafe(async () => undefined, /API_ONLY_(?:ACCEPTED_VERSION_RECORD_INVALID|MIGRATION_JOURNAL_CHANGED|ACTIVE_VERSION_POINTER_CHANGED)/u, (fixture, root) => {
      const target = fixture[directoryName];
      let replaced = false;
      return authorityModule.createApiOnlyAuthorityResolver({
        open: async (path, flags, mode) => {
          if (!replaced && path === target) {
            replaced = true;
            await rename(target, join(root, `replaced-${directoryName}`));
            await mkdir(target, { mode: 0o700 });
          }
          return open(path, flags, mode);
        }
      });
    });
  }
  await unsafe(async ({ versionsRoot }) => {
    await rm(versionsRoot, { recursive: true, force: true });
    await writeFile(versionsRoot, "not-a-directory", { mode: 0o600 });
  });
  await unsafe(async ({ versionRoot }) => writeFile(join(versionRoot, ".pending-unknown"), "x", { mode: 0o600 }));
  await unsafe(async ({ recordPath }) => chmod(recordPath, 0o644));
  await unsafe(async ({ recordPath }, root) => link(recordPath, join(root, "record-link")));
  await unsafe(async ({ recordPath }, root) => {
    const target = join(root, "record-target");
    await writeFile(target, await readFile(recordPath), { mode: 0o600 });
    await rm(recordPath);
    await symlink(target, recordPath);
  });
  await unsafe(async ({ recordPath }) => {
    await rm(recordPath);
    await mkdir(recordPath, { mode: 0o700 });
  });
  await unsafe(async ({ recordPath }) => writeFile(recordPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 }));
  await unsafe(async ({ versionRoot }) => rm(join(versionRoot, "gateway.conf")), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  await unsafe(async ({ pointerPath }) => writeFile(pointerPath, Buffer.alloc(4097, 0x61), { mode: 0o600 }), /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u);
  await unsafe(async ({ versionRoot }) => writeFile(join(versionRoot, "gateway.conf"), Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 }), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  await unsafe(async () => undefined, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u, () => authorityModule.createApiOnlyAuthorityResolver({ getuid: () => (process.getuid?.() ?? 0) + 1 }));
  for (const [field, expected] of [
    ["pointerPath", /API_ONLY_ACTIVE_VERSION_POINTER_INVALID/u],
    ["recordPath", /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u]
  ]) {
    await unsafe(async () => undefined, expected, (fixture) => {
      const target = fixture[field];
      return authorityModule.createApiOnlyAuthorityResolver({
        lstat: async (path) => {
          const info = await lstat(path);
          return path === target ? withStatOverrides(info, { uid: Number(info.uid) + 1 }) : info;
        }
      });
    });
  }
  await unsafe(async () => undefined, /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u, (fixture) => {
    const target = join(fixture.versionRoot, "gateway.conf");
    return authorityModule.createApiOnlyAuthorityResolver({
      lstat: async (path) => {
        const info = await lstat(path);
        return path === target ? withStatOverrides(info, { uid: Number(info.uid) + 1 }) : info;
      }
    });
  });

  for (const [, basename] of VERSION_ARTIFACTS) {
    await unsafe(async ({ versionRoot }) => writeFile(join(versionRoot, basename), `tampered:${basename}\n`, { mode: 0o600 }), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    await unsafe(async ({ versionRoot }) => rm(join(versionRoot, basename)), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    await unsafe(async ({ versionRoot }) => chmod(join(versionRoot, basename), 0o640), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    await unsafe(async ({ versionRoot }, root) => link(join(versionRoot, basename), join(root, `linked-${basename}`)), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    await unsafe(async ({ versionRoot }, root) => {
      const path = join(versionRoot, basename);
      const target = join(root, `target-${basename}`);
      await writeFile(target, await readFile(path), { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
    }, /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    await unsafe(async ({ versionRoot }) => {
      const path = join(versionRoot, basename);
      await rm(path);
      await mkdir(path, { mode: 0o700 });
    }, /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  }

  const exactAggregateRoot = await makeAuthorityRepository();
  try {
    const aggregateBytes = Object.fromEntries(VERSION_ARTIFACTS.map(([, basename], index) => [
      basename,
      index < 4 ? Buffer.alloc(8 * 1024 * 1024, 0x61 + index) : Buffer.alloc(0)
    ]));
    await materializeInitialAcceptedVersion(exactAggregateRoot, {}, "accepted", aggregateBytes);
    assert.equal((await authorityModule.createApiOnlyAuthorityResolver().readLifecycleAuthority(exactAggregateRoot)).phase, "accepted");
  } finally { await rm(exactAggregateRoot, { recursive: true, force: true }); }

  const excessiveAggregateRoot = await makeAuthorityRepository();
  try {
    const aggregateBytes = Object.fromEntries(VERSION_ARTIFACTS.map(([, basename], index) => [
      basename,
      index < 4 ? Buffer.alloc(8 * 1024 * 1024, 0x61 + index) : index === 4 ? Buffer.from("x") : Buffer.alloc(0)
    ]));
    await materializeInitialAcceptedVersion(excessiveAggregateRoot, {}, "accepted", aggregateBytes);
    await assert.rejects(authorityModule.createApiOnlyAuthorityResolver().readLifecycleAuthority(excessiveAggregateRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  } finally { await rm(excessiveAggregateRoot, { recursive: true, force: true }); }

  const growthRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(growthRoot);
    let firstStat = true;
    let largestRead = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== fixture.pointerPath) return handle;
        return {
          stat: async (...args) => {
            const info = await handle.stat(...args);
            if (firstStat) {
              firstStat = false;
              await writeFile(path, Buffer.alloc(8192, 0x61), { mode: 0o600 });
            }
            return info;
          },
          read: async (buffer, ...args) => {
            largestRead = Math.max(largestRead, buffer.length);
            return handle.read(buffer, ...args);
          },
          close: () => handle.close()
        };
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(growthRoot), /API_ONLY_ACTIVE_VERSION_POINTER_CHANGED/u);
    assert.ok(largestRead <= 4097);
  } finally { await rm(growthRoot, { recursive: true, force: true }); }

  const insertionRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(insertionRoot);
    let reads = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      readdir: async (path, options) => {
        const names = await readdir(path, options);
        if (path === fixture.versionRoot && ++reads === 2) {
          await writeFile(join(path, "inserted"), "x", { mode: 0o600 });
          return readdir(path, options);
        }
        return names;
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(insertionRoot), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
  } finally { await rm(insertionRoot, { recursive: true, force: true }); }

  const removalRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(removalRoot);
    let reads = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      readdir: async (path, options) => {
        if (path === fixture.versionRoot && ++reads === 2) await rm(join(path, "gateway.conf"));
        return readdir(path, options);
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(removalRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  } finally { await rm(removalRoot, { recursive: true, force: true }); }

  const orderRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(orderRoot);
    let reads = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      readdir: async (path, options) => {
        const names = await readdir(path, options);
        if (path === fixture.versionRoot && ++reads === 2) return [...names].reverse();
        return names;
      }
    });
    assert.equal((await resolver.readLifecycleAuthority(orderRoot)).phase, "accepted");
  } finally { await rm(orderRoot, { recursive: true, force: true }); }

  const boundedRoot = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(boundedRoot);
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => handle.read(...args),
          readFile: async () => { throw new Error("UNBOUNDED_READ_MUST_NOT_RUN"); },
          close: () => handle.close()
        };
      }
    });
    assert.equal((await resolver.readLifecycleAuthority(boundedRoot)).phase, "accepted");
  } finally { await rm(boundedRoot, { recursive: true, force: true }); }

  const finalSweepRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(finalSweepRoot);
    const firstArtifact = join(fixture.versionRoot, "container-runtime-selection.json");
    const laterArtifact = join(fixture.versionRoot, "accepted-compose-base.json");
    const counts = new Map();
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const count = (counts.get(path) ?? 0) + 1;
        counts.set(path, count);
        if (path === laterArtifact && count === 2) {
          const original = await readFile(firstArtifact);
          await writeFile(firstArtifact, Buffer.alloc(original.length, 0x78), { mode: 0o600 });
        }
        return handle;
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(finalSweepRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  } finally { await rm(finalSweepRoot, { recursive: true, force: true }); }

  const crossJournalSweepRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(crossJournalSweepRoot);
    const firstArtifact = join(fixture.versionRoot, "container-runtime-selection.json");
    let journalOpens = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        if (path === fixture.journalPath && ++journalOpens === 3) {
          const original = await readFile(firstArtifact);
          await writeFile(firstArtifact, Buffer.alloc(original.length, 0x78), { mode: 0o600 });
        }
        return open(path, flags, mode);
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(crossJournalSweepRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  } finally { await rm(crossJournalSweepRoot, { recursive: true, force: true }); }

  const retainedFinalSweepRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(retainedFinalSweepRoot);
    const firstArtifact = join(fixture.versionRoot, "container-runtime-selection.json");
    let journalHandles = 0;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const selected = path === fixture.journalPath && ++journalHandles === 1;
        let selectedStatCalls = 0;
        return {
          stat: async (...args) => {
            if (selected && ++selectedStatCalls === 5) {
              const original = await readFile(firstArtifact);
              await writeFile(firstArtifact, Buffer.alloc(original.length, 0x79), { mode: 0o600 });
            }
            return handle.stat(...args);
          },
          read: (...args) => handle.read(...args),
          close: () => handle.close()
        };
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(retainedFinalSweepRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
  } finally { await rm(retainedFinalSweepRoot, { recursive: true, force: true }); }

  const retainedSelectorRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(retainedSelectorRoot);
    const openHandles = new Map();
    let selectorsRetainedAtRecordRead = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const tracked = { closed: false };
        const handles = openHandles.get(path) ?? [];
        handles.push(tracked);
        openHandles.set(path, handles);
        if (path === fixture.recordPath && handles.length === 1) {
          selectorsRetainedAtRecordRead = [fixture.pointerPath, fixture.journalPath]
            .every((selector) => (openHandles.get(selector) ?? []).some((entry) => !entry.closed));
        }
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => handle.read(...args),
          close: async () => { tracked.closed = true; return handle.close(); }
        };
      }
    });
    assert.equal((await resolver.readLifecycleAuthority(retainedSelectorRoot)).phase, "accepted");
    assert.equal(selectorsRetainedAtRecordRead, true);
    assert.equal([...openHandles.values()].flat().every(({ closed }) => closed), true);
  } finally { await rm(retainedSelectorRoot, { recursive: true, force: true }); }

  const errorCloseRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(errorCloseRoot);
    const tracked = [];
    let injected = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const state = { closed: false };
        tracked.push(state);
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => {
            if (!injected && path === join(fixture.versionRoot, "accepted-compose-base.json")) {
              injected = true;
              throw new Error("INJECTED_READ_FAILURE");
            }
            return handle.read(...args);
          },
          close: async () => { state.closed = true; return handle.close(); }
        };
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(errorCloseRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    assert.equal(tracked.length > 0, true);
    assert.equal(tracked.every(({ closed }) => closed), true);
  } finally { await rm(errorCloseRoot, { recursive: true, force: true }); }

  const closeFailureRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(closeFailureRoot);
    let closeFailed = false;
    const resolver = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          stat: (...args) => handle.stat(...args),
          read: (...args) => handle.read(...args),
          close: async () => {
            await handle.close();
            if (!closeFailed && path === join(fixture.versionRoot, "gateway.conf")) {
              closeFailed = true;
              throw new Error("INJECTED_CLOSE_FAILURE");
            }
          }
        };
      }
    });
    await assert.rejects(resolver.readLifecycleAuthority(closeFailureRoot), /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u);
    assert.equal(closeFailed, true);
  } finally { await rm(closeFailureRoot, { recursive: true, force: true }); }

  for (const stage of ["lstat", "realpath", "readdir", "open", "stat"]) {
    const faultRoot = await makeAuthorityRepository();
    try {
      const fixture = await materializeInitialAcceptedVersion(faultRoot);
      const before = await snapshotTree(faultRoot);
      const gatewayPath = join(fixture.versionRoot, "gateway.conf");
      let injected = false;
      const fail = () => Object.assign(new Error(`INJECTED_${stage.toUpperCase()}_FAILURE`), { code: "EACCES" });
      const dependencies = stage === "lstat" ? {
        lstat: async (path) => {
          if (!injected && path === gatewayPath) { injected = true; throw fail(); }
          return lstat(path);
        }
      } : stage === "realpath" ? {
        realpath: async (path) => {
          if (!injected && path === fixture.versionRoot) { injected = true; throw fail(); }
          return realpath(path);
        }
      } : stage === "readdir" ? {
        readdir: async (path, options) => {
          if (!injected && path === fixture.versionRoot) { injected = true; throw fail(); }
          return readdir(path, options);
        }
      } : {
        open: async (path, flags, mode) => {
          if (stage === "open" && !injected && path === fixture.recordPath) { injected = true; throw fail(); }
          const handle = await open(path, flags, mode);
          if (stage !== "stat" || path !== gatewayPath) return handle;
          return {
            stat: (...args) => {
              if (!injected) { injected = true; throw fail(); }
              return handle.stat(...args);
            },
            read: (...args) => handle.read(...args),
            close: () => handle.close()
          };
        }
      };
      const expected = ["lstat", "stat"].includes(stage)
        ? /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u
        : /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u;
      await assert.rejects(authorityModule.createApiOnlyAuthorityResolver(dependencies).readLifecycleAuthority(faultRoot), expected, stage);
      assert.equal(injected, true, stage);
      assert.deepEqual(await snapshotTree(faultRoot), before, stage);
    } finally { await rm(faultRoot, { recursive: true, force: true }); }
  }

  const aliasRoot = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(aliasRoot);
    const alias = `${aliasRoot}-alias`;
    await symlink(aliasRoot, alias);
    await assert.rejects(authorityModule.createApiOnlyAuthorityResolver().readLifecycleAuthority(alias), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u);
    await rm(alias);
  } finally { await rm(aliasRoot, { recursive: true, force: true }); }
});

test("migration journal witnesses state but never selects accepted bytes", async () => {
  const resolver = authorityModule.createApiOnlyAuthorityResolver();

  for (const state of ["prepared", "source_frozen", "target_restored", "cutover_read_only", "recovery_pending", "failed_recovered", "rolled_back"]) {
    const root = await makeAuthorityRepository();
    try {
      await writeCanonicalJournal(root, PATH_TO_STATE[state]);
      const authority = await resolver.readLifecycleAuthority(root);
      assert.equal(authority.phase, "migration");
      assert.equal(Object.hasOwn(authority.migration, "project"), false);
      assert.equal(Object.hasOwn(authority.migration, "path"), false);
      assert.equal(authority.acceptedVersion, null);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  const pendingNoPointer = await makeAuthorityRepository();
  try {
    await writeCanonicalJournal(pendingNoPointer, PATH_TO_STATE.write_activation_pending);
    assert.deepEqual((await resolver.readLifecycleAuthority(pendingNoPointer)).phase, "write_activation_pending");
  } finally { await rm(pendingNoPointer, { recursive: true, force: true }); }

  const pendingPointer = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(pendingPointer, {}, "write_activation_pending");
    const authority = await resolver.readLifecycleAuthority(pendingPointer);
    assert.equal(authority.phase, "write_activation_pending");
    assert.notEqual(authority.acceptedVersion, null);
  } finally { await rm(pendingPointer, { recursive: true, force: true }); }

  const wrongAttempt = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(wrongAttempt, { migrationAttemptId: "abcdef012345", project: "shensi-api-migration-abcdef012345" }, "write_activation_pending");
    await assert.rejects(resolver.readLifecycleAuthority(wrongAttempt), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(wrongAttempt, { recursive: true, force: true }); }

  const missingPointer = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(missingPointer);
    await rm(fixture.pointerPath);
    await assert.rejects(resolver.readLifecycleAuthority(missingPointer), /API_ONLY_ACCEPTED_VERSION_REQUIRED/u);
  } finally { await rm(missingPointer, { recursive: true, force: true }); }

  const wrongWitness = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(wrongWitness);
    let journal = buildJournalPath(resolver, PATH_TO_STATE.write_activation_pending);
    journal = resolver.buildNextMigrationJournal(journal.journal, transitionForState("accepted", journal, { acceptedVersion: { versionId: hex("e"), recordSha256: hex("f") } }));
    await writeFile(fixture.journalPath, journal.canonicalText, { mode: 0o600 });
    await assert.rejects(resolver.readLifecycleAuthority(wrongWitness), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(wrongWitness, { recursive: true, force: true }); }

  const pointerWithoutJournal = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(pointerWithoutJournal);
    await rm(fixture.journalPath);
    await assert.rejects(resolver.readLifecycleAuthority(pointerWithoutJournal), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(pointerWithoutJournal, { recursive: true, force: true }); }

  const recoveredPointer = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(recoveredPointer);
    const recovered = buildJournalPath(resolver, PATH_TO_STATE.rolled_back);
    await writeFile(fixture.journalPath, recovered.canonicalText, { mode: 0o600 });
    await assert.rejects(resolver.readLifecycleAuthority(recoveredPointer), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(recoveredPointer, { recursive: true, force: true }); }

  const failedRecoveredPointer = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(failedRecoveredPointer);
    const recovered = buildJournalPath(resolver, PATH_TO_STATE.failed_recovered);
    await writeFile(fixture.journalPath, recovered.canonicalText, { mode: 0o600 });
    await assert.rejects(resolver.readLifecycleAuthority(failedRecoveredPointer), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(failedRecoveredPointer, { recursive: true, force: true }); }

  const injected = await makeAuthorityRepository();
  try {
    const { path, built } = await writeCanonicalJournal(injected);
    for (const field of ["project", "image", "config", "resource", "path"]) {
      const value = { ...built.journal, [field]: "forbidden-selector" };
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await assert.rejects(resolver.readLifecycleAuthority(injected), /API_ONLY_MIGRATION_JOURNAL_INVALID/u, field);
    }
  } finally { await rm(injected, { recursive: true, force: true }); }

  const raceRoot = await makeAuthorityRepository();
  try {
    const fixture = await materializeInitialAcceptedVersion(raceRoot);
    let replacement = buildJournalPath(resolver, ["prepared", "source_frozen", "target_restored", "cutover_read_only", "write_activation_pending"]);
    replacement = resolver.buildNextMigrationJournal(replacement.journal, transitionForState("accepted", replacement, {
      evidenceManifest: evidenceDescriptor("d"),
      acceptedVersion: { versionId: fixture.built.versionId, recordSha256: fixture.built.recordSha256 }
    }));
    let replaced = false;
    const racing = authorityModule.createApiOnlyAuthorityResolver({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!replaced && path === fixture.recordPath) {
          replaced = true;
          const pending = `${fixture.journalPath}.replacement`;
          await writeFile(pending, replacement.canonicalText, { mode: 0o600 });
          await rename(pending, fixture.journalPath);
        }
        return handle;
      }
    });
    await assert.rejects(racing.readLifecycleAuthority(raceRoot), /API_ONLY_MIGRATION_JOURNAL_CHANGED/u);
  } finally { await rm(raceRoot, { recursive: true, force: true }); }
});

test("neutral brand survives the B2 to B3 boundary without becoming forgeable", async () => {
  for (const phase of ["write_activation_pending", "accepted"]) {
    const root = await makeAuthorityRepository();
    try {
      const fixture = await materializeInitialAcceptedVersion(root, {}, phase);
      const resolver = authorityModule.createApiOnlyAuthorityResolver();
      const authority = await resolver.readLifecycleAuthority(root);
      const projection = resolver.projectAcceptedResources(authority);
      const binding = fixture.binding;
      assert.deepEqual(projection, {
        schema: "shensi.api-only.accepted-resource-projection",
        version: 1,
        lifecyclePhase: phase,
        pointer: { versionId: fixture.built.versionId, recordSha256: fixture.built.recordSha256 },
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
        artifacts: authority.acceptedVersion.artifacts
      });
      assertDeepFrozen(projection);
      assert.equal(authorityModule.assertApiOnlyAcceptedResourceProjection(projection, phase), projection);
      assert.throws(() => authorityModule.assertApiOnlyAcceptedResourceProjection(projection, phase === "accepted" ? "write_activation_pending" : "accepted"), /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u);
      for (const forged of [
        { ...projection },
        structuredClone(projection),
        JSON.parse(JSON.stringify(projection)),
        { expectedResources: projection.expectedResources, artifacts: projection.artifacts },
        { ...projection, lifecyclePhase: "accepted" },
        projection.expectedResources,
        projection.artifacts
      ]) assert.throws(() => authorityModule.assertApiOnlyAcceptedResourceProjection(forged, phase), /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u);
      assert.throws(() => resolver.projectAcceptedResources({ ...authority }), /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("point-of-use validation covers every authority consumer", async () => {
  const unchangedRoot = await makeAuthorityRepository();
  try {
    await materializeInitialAcceptedVersion(unchangedRoot);
    const resolver = authorityModule.createApiOnlyAuthorityResolver();
    const authority = await resolver.readLifecycleAuthority(unchangedRoot);
    const oldProjection = resolver.projectAcceptedResources(authority);
    const fresh = await resolver.revalidateLifecycleAuthorityAtPointOfUse(authority);
    assert.notEqual(fresh, authority);
    assert.deepEqual(fresh, authority);
    const freshProjection = resolver.projectAcceptedResources(fresh);
    assert.notEqual(freshProjection, oldProjection);
    assert.equal(authorityModule.assertApiOnlyAcceptedResourceProjection(freshProjection, "accepted"), freshProjection);
    assert.throws(() => authorityModule.assertApiOnlyAcceptedResourceProjection(oldProjection, "accepted"), /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u);
    await assert.rejects(resolver.revalidateLifecycleAuthorityAtPointOfUse({ ...fresh }), /API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT/u);
  } finally { await rm(unchangedRoot, { recursive: true, force: true }); }

  const mutations = [
    ["journal replacement", (fixture) => replaceFileWithSameBytes(fixture.journalPath), /API_ONLY_MIGRATION_JOURNAL_CHANGED/u],
    ["pointer replacement", (fixture) => replaceFileWithSameBytes(fixture.pointerPath), /API_ONLY_ACTIVE_VERSION_POINTER_CHANGED/u],
    ["record replacement", (fixture) => replaceFileWithSameBytes(fixture.recordPath), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u],
    ...VERSION_ARTIFACTS.map(([, basename]) => [
      `${basename} replacement`,
      (fixture) => replaceFileWithSameBytes(join(fixture.versionRoot, basename)),
      /API_ONLY_ACCEPTED_VERSION_ARTIFACT_INVALID/u
    ]),
    ["entry-set replacement", (fixture) => writeFile(join(fixture.versionRoot, "unknown-entry"), "x", { mode: 0o600 }), /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u],
    ["pinned-directory replacement", replaceVersionDirectoryWithSameBytes, /API_ONLY_ACCEPTED_VERSION_RECORD_INVALID/u]
  ];

  for (const [name, mutate, expected] of mutations) {
    const root = await makeAuthorityRepository();
    try {
      const fixture = await materializeInitialAcceptedVersion(root);
      const resolver = authorityModule.createApiOnlyAuthorityResolver();
      const authority = await resolver.readLifecycleAuthority(root);
      const projection = resolver.projectAcceptedResources(authority);
      await mutate(fixture);
      await assert.rejects(resolver.revalidateLifecycleAuthorityAtPointOfUse(authority), expected, name);
      assert.throws(() => authorityModule.assertApiOnlyAcceptedResourceProjection(projection, "accepted"), /API_ONLY_ACCEPTED_RESOURCE_PROJECTION_INVALID/u, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
