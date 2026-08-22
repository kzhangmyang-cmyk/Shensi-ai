import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRequiredExecutionMarker,
  assertSameGrowthContract,
  expectedGrowthReleaseCommands,
  runGrowthReleaseGate
} from "./growth-dual-repo-release-gate.mjs";

const manifest = {
  name: "growth-advisor-quote-roi",
  contractVersion: "1.0.3",
  contractHash: `sha256:${"a".repeat(64)}`,
  openapiVersion: "3.1.0"
};

test("coordinated gate rejects any producer/consumer identity mismatch", () => {
  assert.throws(
    () => assertSameGrowthContract(
      manifest,
      { ...manifest, contractVersion: "2.0.0" }
    ),
    /contractVersion mismatch/u
  );
  assert.throws(
    () => assertSameGrowthContract(
      manifest,
      { ...manifest, contractHash: `sha256:${"b".repeat(64)}` }
    ),
    /contractHash mismatch/u
  );
});

test("Foundation and Advisor real-MySQL commands require positive two-connection markers", () => {
  for (const suite of ["foundation", "advisor"]) {
    const command = {
      requiredOutputMarkerPattern:
        `GROWTH_REAL_MYSQL ${suite} connections=2 tests=[1-9][0-9]*`
    };
    assert.throws(
      () => assertRequiredExecutionMarker(command, { executionMarker: null }),
      /mandatory execution marker missing/u
    );
    assert.throws(
      () => assertRequiredExecutionMarker(command, {
        executionMarker: `GROWTH_REAL_MYSQL ${suite} connections=2 tests=0`
      }),
      /mandatory execution marker missing/u
    );
    const marker = `GROWTH_REAL_MYSQL ${suite} connections=2 tests=7`;
    assert.equal(
      assertRequiredExecutionMarker(command, { executionMarker: marker }),
      marker
    );
  }
});

test("expected release matrix covers every required producer and consumer suite", () => {
  const commands = expectedGrowthReleaseCommands();
  const required = [
    "backend:npm run test:growth-foundation --workspace backend",
    "backend:npm run test:growth-foundation:mysql --workspace backend",
    "backend:npm run test:growth-catalog --workspace backend",
    "backend:npm run test:growth-quotes --workspace backend",
    "backend:npm run test:growth-finance:mysql --workspace backend",
    "backend:npm run test:growth-roi:mysql --workspace backend",
    "backend:npm run test:growth-advisor --workspace backend",
    "backend:npm run test:growth-advisor:mysql --workspace backend",
    "backend:npm run test:contracts",
    "frontend:pnpm run test:growth:fixture",
    "frontend:pnpm run test:e2e:real:guard"
  ];
  for (const suite of required) {
    assert.equal(commands.includes(suite), true, suite);
  }
});

test("coordinated gate runs the fixed matrix and records both commits and rollback refs", async () => {
  const calls = [];
  const rollbackResolutions = [];
  const snapshots = new Map([
    ["/repo/backend", {
      headBytes: Buffer.from(`${"1".repeat(40)}\n`),
      statusBytes: Buffer.alloc(0),
      commit: "1".repeat(40)
    }],
    ["/repo/frontend", {
      headBytes: Buffer.from(`${"2".repeat(40)}\n`),
      statusBytes: Buffer.alloc(0),
      commit: "2".repeat(40)
    }]
  ]);
  const record = await runGrowthReleaseGate({
    backendRoot: "/repo/backend",
    frontendRoot: "/repo/frontend",
    backendCommit: "1".repeat(40),
    frontendCommit: "2".repeat(40),
    backendRollbackRef: "3".repeat(40),
    frontendRollbackRef: "4".repeat(40),
    producerManifest: manifest,
    consumerManifest: manifest,
    environment: { MYSQL_TEST_ADMIN_URL: "mysql://root:test@127.0.0.1:3306" },
    now: () => "2026-08-09T08:00:00.000Z",
    readProducerManifest: async () => manifest,
    readConsumerManifest: async () => manifest,
    readRepositorySnapshot: async (repositoryRoot) =>
      (() => {
        const snapshot = snapshots.get(repositoryRoot);
        return {
          headBytes: Buffer.from(snapshot.headBytes),
          statusBytes: Buffer.from(snapshot.statusBytes),
          commit: snapshot.commit
        };
      })(),
    resolveRollbackCommit: async (input) => {
      rollbackResolutions.push(input);
      return input.suppliedSha;
    },
    run: async (command) => {
      calls.push(command);
      if (!command.requiredOutputMarkerPattern) {
        return { executionMarker: null };
      }
      const marker = command.args.join(" ").includes("foundation")
        ? "GROWTH_REAL_MYSQL foundation connections=2 tests=7"
        : command.args.join(" ").includes("advisor")
          ? "GROWTH_REAL_MYSQL advisor connections=2 tests=7"
          : "GROWTH_REAL_MYSQL closed-loop connections=2 tests=7";
      return { executionMarker: marker };
    }
  });
  assert.equal(record.contractHash, manifest.contractHash);
  assert.equal(record.backendCommit, "1".repeat(40));
  assert.equal(record.frontendCommit, "2".repeat(40));
  assert.deepEqual(rollbackResolutions, [
    {
      repositoryRoot: "/repo/backend",
      suppliedSha: "3".repeat(40),
      releaseSha: "1".repeat(40)
    },
    {
      repositoryRoot: "/repo/frontend",
      suppliedSha: "4".repeat(40),
      releaseSha: "2".repeat(40)
    }
  ]);
  assert.deepEqual(
    calls.map((call) =>
      `${call.repository}:${call.executable} ${call.args.join(" ")}`),
    expectedGrowthReleaseCommands()
  );
  assert.equal(
    calls.every((call) => call.environment.GROWTH_RELEASE_REQUIRE_MYSQL === "1"),
    true
  );
  assert.equal(
    calls.every((call) =>
      call.environment.MYSQL_TEST_ADMIN_URL.includes("127.0.0.1")),
    true
  );
  for (const command of [
    "npm run test:growth-foundation:mysql --workspace backend",
    "npm run test:growth-catalog --workspace backend",
    "npm run test:growth-quotes --workspace backend",
    "npm run test:growth-finance:mysql --workspace backend",
    "npm run test:growth-roi:mysql --workspace backend",
    "npm run test:growth-advisor:mysql --workspace backend",
    "npm run test:growth:closed-loop:mysql --workspace backend",
    "pnpm run test:e2e:real"
  ]) {
    const entry = record.commands.find((item) => item.command === command);
    assert.equal(entry?.executionMode, "real_mysql", command);
  }
  assert.equal(
    record.commands.find((item) =>
      item.command === "npm run test:growth-foundation --workspace backend")
      ?.executionMode,
    "standard"
  );
  assert.equal(record.verifiedAt, "2026-08-09T08:00:00.000Z");
});
