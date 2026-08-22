import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTRACT_NAME = "growth-advisor-quote-roi";

export function assertSameGrowthContract(producer, consumer) {
  if (producer.name !== CONTRACT_NAME || consumer.name !== CONTRACT_NAME) {
    throw new Error("contract name mismatch");
  }
  if (producer.contractVersion !== consumer.contractVersion) {
    throw new Error("contractVersion mismatch");
  }
  if (producer.contractHash !== consumer.contractHash) {
    throw new Error("contractHash mismatch");
  }
}

export function assertRequiredExecutionMarker(command, execution) {
  const marker = execution?.executionMarker ?? null;
  if (!command.requiredOutputMarkerPattern) return marker;
  if (typeof marker !== "string"
    || !new RegExp(command.requiredOutputMarkerPattern).test(marker)) {
    throw new Error("mandatory execution marker missing");
  }
  return marker;
}

export function expectedGrowthReleaseCommands() {
  const backend = [
    "backend:npm run test:contracts",
    "backend:npm run test:contract-drift --workspace backend",
    "backend:npm run test:acquisition-openapi --workspace backend",
    "backend:npm run test:security --workspace backend",
    "backend:npm run test:growth-foundation --workspace backend",
    "backend:npm run test:growth-foundation:mysql --workspace backend",
    "backend:npm run test:growth-catalog --workspace backend",
    "backend:npm run test:growth-quotes --workspace backend",
    "backend:npm run test:growth-finance:mysql --workspace backend",
    "backend:npm run test:growth-roi:mysql --workspace backend",
    "backend:npm run test:growth-advisor --workspace backend",
    "backend:npm run test:growth-advisor:mysql --workspace backend",
    "backend:npm run test:acquisition --workspace backend",
    "backend:npm run test:growth:closed-loop --workspace backend",
    "backend:npm run test:growth:closed-loop:mysql --workspace backend",
    "backend:npm run build --workspace backend"
  ];
  const frontend = [
    "frontend:pnpm run contract:check",
    "frontend:pnpm run test:types",
    "frontend:pnpm test",
    "frontend:pnpm run test:growth:fixture",
    "frontend:pnpm test:e2e",
    "frontend:pnpm run test:e2e:real:guard",
    "frontend:pnpm run test:e2e:real",
    "frontend:pnpm build"
  ];
  return [...backend, ...frontend];
}

export async function readProducerManifestForConsumer({
  backendRoot,
  consumerManifest
}) {
  const version = consumerManifest.contractVersion;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("invalid contractVersion");
  }
  const manifestPath = path.join(
    backendRoot,
    "contracts",
    "releases",
    CONTRACT_NAME,
    version,
    "manifest.json"
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertSameGrowthContract(manifest, consumerManifest);
  return manifest;
}

export async function readRepositoryReleaseSnapshot(repositoryRoot) {
  const { stdout: headBytes } = await execFileAsync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }
  );
  const { stdout: statusBytes } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  const { stdout: shallow } = await execFileAsync(
    "git", ["rev-parse", "--is-shallow-repository"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  if (shallow.trim() === "true") {
    throw new Error("shallow repository rejected");
  }
  return Object.freeze({
    headBytes: Buffer.from(headBytes),
    statusBytes: Buffer.from(statusBytes),
    commit: headBytes.trim()
  });
}

export async function assertRepositoryReleaseSnapshotUnchanged(before, after) {
  if (!before.headBytes.equals(after.headBytes)) {
    throw new Error("repository HEAD changed during release");
  }
  if (!before.statusBytes.equals(after.statusBytes)) {
    throw new Error("repository worktree changed during release");
  }
}

export async function resolveImmutableRollbackCommit({
  repositoryRoot,
  suppliedSha,
  releaseSha
}) {
  if (!/^[0-9a-f]{40}$/u.test(suppliedSha) || suppliedSha === releaseSha) {
    throw new Error("invalid rollback commit");
  }
  await execFileAsync(
    "git",
    ["merge-base", "--is-ancestor", suppliedSha, releaseSha],
    { cwd: repositoryRoot }
  );
  return suppliedSha;
}

function mysqlSuites() {
  const names = [
    "test:growth-foundation:mysql",
    "test:growth-catalog",
    "test:growth-quotes",
    "test:growth-finance:mysql",
    "test:growth-roi:mysql",
    "test:growth-advisor:mysql",
    "test:growth:closed-loop:mysql"
  ];
  const generic = /GROWTH_REAL_MYSQL .*connections=2 tests=[1-9][0-9]*/u;
  const specific = /GROWTH_REAL_MYSQL (?:foundation|advisor|roi|finance|catalog|quotes|closed-loop) connections=2 tests=[1-9][0-9]*/u;
  return new Map(names.map((name) => [
    name,
    name.includes("mysql") ? specific : generic
  ]));
}

const FRONTEND_REAL_SUITE_PATTERN =
  /GROWTH_REAL_MYSQL .*connections=2 tests=[1-9][0-9]*/u;

export async function runGrowthReleaseGate(options) {
  const {
    backendRoot,
    frontendRoot,
    backendCommit,
    frontendCommit,
    backendRollbackRef,
    frontendRollbackRef,
    producerManifest,
    consumerManifest,
    environment = {},
    now = () => new Date().toISOString(),
    readProducerManifest = readProducerManifestForConsumer,
    readConsumerManifest = async ({ frontendRoot }) =>
      JSON.parse(await readFile(
        path.join(
          frontendRoot,
          "contracts",
          "pinned",
          `${CONTRACT_NAME}.manifest.json`
        ),
        "utf8"
      )),
    readRepositorySnapshot = readRepositoryReleaseSnapshot,
    resolveRollbackCommit = resolveImmutableRollbackCommit,
    run = defaultRun
  } = options;
  assertSameGrowthContract(producerManifest, consumerManifest);
  if (!/^[0-9a-f]{40}$/u.test(backendCommit)
    || !/^[0-9a-f]{40}$/u.test(frontendCommit)) {
    throw new Error("invalid release commit");
  }
  const backendBefore = await readRepositorySnapshot(backendRoot);
  const frontendBefore = await readRepositorySnapshot(frontendRoot);
  const rollbackBackend = await resolveRollbackCommit({
    repositoryRoot: backendRoot,
    suppliedSha: backendRollbackRef,
    releaseSha: backendCommit
  });
  const rollbackFrontend = await resolveRollbackCommit({
    repositoryRoot: frontendRoot,
    suppliedSha: frontendRollbackRef,
    releaseSha: frontendCommit
  });
  const commands = [];
  const mysqlPatterns = mysqlSuites();
  for (const suite of expectedGrowthReleaseCommands()) {
    const separator = suite.indexOf(":");
    const repository = suite.slice(0, separator);
    const raw = suite.slice(separator + 1);
    const [executable, ...args] = raw.split(" ");
    const command = `${executable} ${args.join(" ")}`;
    let requiredOutputMarkerPattern = repository === "backend"
      ? mysqlPatterns.get(command.split(" ").find((part) =>
          part.startsWith("test:")) ?? "") ?? null
      : null;
    if (repository === "frontend" && command === "pnpm run test:e2e:real") {
      requiredOutputMarkerPattern = FRONTEND_REAL_SUITE_PATTERN;
    }
    const execution = await run({
      repository,
      executable,
      args,
      environment: {
        ...environment,
        GROWTH_RELEASE_REQUIRE_MYSQL: "1"
      },
      requiredOutputMarkerPattern
    });
    const executionMarker = assertRequiredExecutionMarker(
      { requiredOutputMarkerPattern },
      execution
    );
    commands.push({
      command,
      repository,
      executionMode: requiredOutputMarkerPattern ? "real_mysql" : "standard",
      executionMarker
    });
  }
  await assertRepositoryReleaseSnapshotUnchanged(backendBefore, await readRepositorySnapshot(backendRoot));
  await assertRepositoryReleaseSnapshotUnchanged(frontendBefore, await readRepositorySnapshot(frontendRoot));
  return Object.freeze({
    name: CONTRACT_NAME,
    contractVersion: producerManifest.contractVersion,
    contractHash: producerManifest.contractHash,
    backendCommit,
    frontendCommit,
    backendRollbackRef: rollbackBackend,
    frontendRollbackRef: rollbackFrontend,
    verifiedAt: now(),
    commands
  });
}

async function defaultRun({ repository, executable, args, environment }) {
  const cwd = repository === "backend"
    ? process.cwd() : process.env.GOODJOB_FRONTEND_ROOT;
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8"
  });
  return { executionMarker: stdout };
}

export async function runGrowthReleaseCli(options) {
  const record = await runGrowthReleaseGate(options);
  const recordPath = path.join(
    options.backendRoot,
    "growth-release-record.json"
  );
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined
    && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main() {
  const required = [
    "GOODJOB_BACKEND_ROOT",
    "GOODJOB_FRONTEND_ROOT",
    "GROWTH_BACKEND_COMMIT",
    "GROWTH_FRONTEND_COMMIT",
    "GROWTH_BACKEND_ROLLBACK",
    "GROWTH_FRONTEND_ROLLBACK",
    "MYSQL_TEST_ADMIN_URL"
  ];
  for (const name of required) {
    if (!process.env[name]?.trim()) {
      throw new Error(`release:growth requires ${name}`);
    }
  }
  const record = await runGrowthReleaseCli({
    backendRoot: process.env.GOODJOB_BACKEND_ROOT,
    frontendRoot: process.env.GOODJOB_FRONTEND_ROOT,
    backendCommit: process.env.GROWTH_BACKEND_COMMIT,
    frontendCommit: process.env.GROWTH_FRONTEND_COMMIT,
    backendRollbackRef: process.env.GROWTH_BACKEND_ROLLBACK,
    frontendRollbackRef: process.env.GROWTH_FRONTEND_ROLLBACK,
    environment: { MYSQL_TEST_ADMIN_URL: process.env.MYSQL_TEST_ADMIN_URL }
  });
  process.stdout.write(`${JSON.stringify({
    contractVersion: record.contractVersion,
    contractHash: record.contractHash,
    backendCommit: record.backendCommit,
    frontendCommit: record.frontendCommit,
    verifiedAt: record.verifiedAt,
    commandCount: record.commands.length
  }, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
