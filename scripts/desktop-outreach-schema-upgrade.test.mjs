import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DESKTOP_OUTREACH_SCHEMA_PROJECTION, DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256 }
  from "./lib/desktop-outreach-schema-projections.mjs";

import {
  DESKTOP_OUTREACH_SCHEMA_LOCK_NAME,
  DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
  DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE,
  DESKTOP_OUTREACH_SCHEMA_STEPS,
  DESKTOP_OUTREACH_SCHEMA_VERSION,
  runDesktopOutreachSchemaUpgrade
} from "./desktop-outreach-schema-upgrade.mjs";

const fixtureUrl = new URL("../contracts/fixtures/desktop-outreach-legacy-rows.v1.json",
  import.meta.url);
const schemaFixtureUrl = new URL(
  "../contracts/fixtures/desktop-outreach-legacy-schema.v1.sql", import.meta.url);

const ATTEMPT_ID = "012345abcdef";
const ENGINE_HASH = "a".repeat(64);
const SERVER_UUID = "00000000-1111-2222-3333-444444444444";
const SERVER_UUID_HASH = "d16fe322fd5b8ed6a57156e84401aedb251297941f3f339408bc78186903a8ed";

function validInput() {
  return {
    attemptId: ATTEMPT_ID,
    project: `shensi-api-migration-${ATTEMPT_ID}`,
    target: {
      kind: "restored_migration_target",
      database: "shensi",
      host: "127.0.0.1",
      port: 3311,
      username: "shensi_app"
    },
    ownerWitness: {
      phase: "source_frozen",
      attemptId: ATTEMPT_ID,
      project: `shensi-api-migration-${ATTEMPT_ID}`,
      runtimeKind: "migration_target",
      writersStopped: true,
      engineIdHash: ENGINE_HASH,
      ownerLockNonce: "b".repeat(32)
    }
  };
}

function makeAdapter({ initialAfter = [], partial = [], replayRows = {},
  initialLedger = [], ownerTableState } = {}) {
  const states = new Map(DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) =>
    [ordinal, initialAfter.includes(ordinal) ? "after" :
      partial.includes(ordinal) ? "partial" : "before"]));
  const ledger = structuredClone(initialLedger);
  const applied = new Map();
  const recorded = new Map();
  const calls = { open: 0, close: 0, acquire: 0, release: 0, authority: 0 };
  const state = { states, ledger, applied, recorded, calls };
  const adapter = {
    state,
    async openSession() {
      calls.open += 1;
      return {
        async readIdentity() {
          return {
            database: "shensi",
            host: "127.0.0.1",
            port: 3311,
            serverPort: 3306,
            authenticatedUser: "shensi_app@%",
            serverUuid: SERVER_UUID
          };
        },
        async assertAuthority() {
          calls.authority += 1;
          return this.readIdentity();
        },
        async acquireNamedLock(name) {
          calls.acquire += 1;
          assert.equal(name, DESKTOP_OUTREACH_SCHEMA_LOCK_NAME);
          return true;
        },
        async releaseNamedLock(name) {
          calls.release += 1;
          assert.equal(name, DESKTOP_OUTREACH_SCHEMA_LOCK_NAME);
        },
        async readLedger() {
          const tableState = ownerTableState ??
            (states.get(10) === "before" ? "absent" :
              states.get(10) === "partial" ? "partial" : "exact");
          return { ownerTableState: tableState, rows: structuredClone(ledger) };
        },
        async inspectStep(step) {
          return {
            state: states.get(step.ordinal),
            preservationOk: states.get(step.ordinal) !== "partial",
            rowCount: replayRows[step.ordinal] ?? 0
          };
        },
        async applyStep(step) {
          applied.set(step.ordinal, (applied.get(step.ordinal) ?? 0) + 1);
          states.set(step.ordinal, "after");
        },
        async recordStep(row) {
          recorded.set(row.stepOrdinal,
            (recorded.get(row.stepOrdinal) ?? 0) + 1);
          ledger.push(structuredClone(row));
        },
        async close() {
          calls.close += 1;
        }
      };
    }
  };
  return adapter;
}

function canonicalRow(step, overrides = {}) {
  return {
    schemaVersion: DESKTOP_OUTREACH_SCHEMA_VERSION,
    manifestSha256: DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
    stepOrdinal: step.ordinal,
    stepId: step.id,
    stepSha256: step.stepSha256,
    state: step.ordinal === 190 ? "sealed" : "completed",
    migrationAttemptId: ATTEMPT_ID,
    targetServerUuidSha256: SERVER_UUID_HASH,
    completedAt: "2026-09-05T00:00:00.000Z",
    ...overrides
  };
}

// Unlike the independent step-state fake, a real ALTER replaces a table's
// previous shape. A final NOT NULL shape cannot still be the nullable stage.
function makeTablePhaseAdapter() {
  const adapter = makeAdapter();
  const groups = [[40, 50, 60], [80, 90, 100], [110, 120, 130]];
  const phases = new Map(groups.map((group) => [group[0],
    DESKTOP_OUTREACH_SCHEMA_STEPS.find((step) => step.ordinal === group[0])
      .beforeProjection]));
  const originalOpen = adapter.openSession;
  adapter.openSession = async (...args) => {
    const session = await originalOpen(...args);
    const originalInspect = session.inspectStep;
    const originalApply = session.applyStep;
    session.inspectStep = async (step, context) => {
      assert.deepEqual(context.completedStepOrdinals,
        adapter.state.ledger.map((row) => row.stepOrdinal));
      assert.deepEqual(context.acceptedAfterProjections,
        step.acceptedAfterProjections);
      const group = groups.find((candidate) => candidate.includes(step.ordinal));
      if (group) {
        const phase = phases.get(group[0]);
        return {
          state: context.acceptedAfterProjections.includes(phase) ? "after" :
            phase === step.beforeProjection || (step.ordinal === 60 &&
              phase === "social-executor:four-staged-columns-exact") ? "before" : "partial",
          preservationOk: true,
          rowCount: 5
        };
      }
      if (step.ordinal === 190) {
        // Final verification runs before its own sealed ledger row exists.
        return {
          state: adapter.state.ledger.length >= 18 ? "after" : "before",
          preservationOk: true,
          rowCount: 0
        };
      }
      return originalInspect(step, context);
    };
    session.applyStep = async (step) => {
      await originalApply(step);
      const group = groups.find((candidate) => candidate.includes(step.ordinal));
      if (group) phases.set(group[0], step.afterProjection);
    };
    return session;
  };
  return adapter;
}

test("completed final ALTER shapes satisfy prior stages on interrupted and sealed reentry", async () => {
  for (const ordinal of [90, 100, 120, 130]) {
    for (const boundary of ["after-statement", "after-verification", "after-ledger-insert"]) {
      const adapter = makeTablePhaseAdapter();
      await assert.rejects(runDesktopOutreachSchemaUpgrade(validInput(), {
        adapter,
        checkpoint(value) {
          if (value.step.ordinal === ordinal && value.boundary === boundary) {
            throw new Error("interrupted");
          }
        }
      }), { code: "DESKTOP_OUTREACH_SCHEMA_INTERRUPTED" });
      await runDesktopOutreachSchemaUpgrade(validInput(), { adapter });
      const repeated = await runDesktopOutreachSchemaUpgrade(validInput(), { adapter });
      assert.equal(adapter.state.ledger.length, 19);
      assert.deepEqual(repeated.preservationReport.appliedStepOrdinals, []);
      assert.equal([...adapter.state.applied.values()].every((count) => count === 1), true);
    }
  }
});

test("database server port and forwarded transport port are separate identity facts", async () => {
  for (const mutate of [
    (identity) => { identity.port = 3306; },
    (identity) => { identity.serverPort = 3311; }
  ]) {
    const adapter = makeAdapter();
    const originalOpen = adapter.openSession;
    adapter.openSession = async (...args) => {
      const session = await originalOpen(...args);
      const originalIdentity = session.readIdentity;
      session.readIdentity = async () => {
        const identity = await originalIdentity();
        mutate(identity);
        return identity;
      };
      return session;
    };
    await assert.rejects(runDesktopOutreachSchemaUpgrade(validInput(), { adapter }),
      { code: "DESKTOP_OUTREACH_SCHEMA_IDENTITY_MISMATCH" });
    assert.equal(adapter.state.applied.size, 0);
    assert.equal(adapter.state.calls.close, 1);
  }
});

test("v1 freezes the owned outreach bridge projection and seven legacy semantics", async () => {
  assert.equal(DESKTOP_OUTREACH_SCHEMA_VERSION,
    "desktop-outreach-action-bridge-v1");
  assert.equal(DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE,
    "acquisition_desktop_outreach_schema_upgrade_steps");
  assert.equal(DESKTOP_OUTREACH_SCHEMA_LOCK_NAME, "shensi:doab:v1");
  assert.equal(DESKTOP_OUTREACH_SCHEMA_STEPS.length, 19);
  assert.deepEqual(DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal, id }) =>
    `${ordinal}/${id}`), [
    "10/create-upgrade-owner-table",
    "20/create-desktop-enrollments",
    "30/create-desktop-installations",
    "40/add-social-executor-columns",
    "50/backfill-social-executor-authority",
    "60/add-social-executor-index-check",
    "70/create-social-login-openings",
    "80/add-action-desktop-columns-stage",
    "90/backfill-action-target-and-count",
    "100/finalize-action-desktop-schema",
    "110/add-attempt-desktop-columns-stage",
    "120/backfill-attempt-target-and-count",
    "130/finalize-attempt-desktop-schema",
    "140/create-desktop-claim-replays",
    "150/create-desktop-completion-replays",
    "160/create-desktop-recovery-replays",
    "170/create-desktop-human-reconciliations",
    "180/create-outreach-account-recoveries",
    "190/verify-and-seal-v1"
  ]);
  assert.match(DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256, /^[a-f0-9]{64}$/u);
  assert.equal(DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
    "d98c9df6f9b8b5d55c774abcc6b6d294c7aac4ac6dbfd2185c23b722c9fd5bd1");
  assert.equal(Object.isFrozen(DESKTOP_OUTREACH_SCHEMA_STEPS), true);
  assert.equal(DESKTOP_OUTREACH_SCHEMA_STEPS.every(Object.isFrozen), true);
  const serialized = JSON.stringify(DESKTOP_OUTREACH_SCHEMA_STEPS);
  assert.equal(serialized.includes("interaction_surface"), false);
  assert.equal(serialized.includes("crawler"), false);

  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.semanticRows.map(({ category }) => category), [
    "tenant", "social_account", "queued", "blocked", "executing",
    "terminal_comment", "terminal_private_message"
  ]);
  const legacySchema = await readFile(schemaFixtureUrl, "utf8");
  for (const table of ["users", "acquisition_social_accounts",
    "acquisition_outreach_batches", "acquisition_outreach_actions",
    "acquisition_outreach_action_accounts",
    "acquisition_outreach_action_attempts"]) {
    assert.match(legacySchema, new RegExp(`CREATE TABLE ${table}\\b`, "u"));
  }
  for (const excluded of [DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE,
    "acquisition_desktop_outreach_claim_replays", "interaction_surface",
    "crawler", "execution_target", "platform_write_attempt_count"]) {
    assert.equal(legacySchema.includes(excluded), false);
  }
});

test("canonical step and manifest hashes use exact ordered UTF-8/LF projections", () => {
  const digest = (domain, value) => createHash("sha256")
    .update(Buffer.from(`${domain}\0`, "utf8"))
    .update(Buffer.from(JSON.stringify(value), "utf8"))
    .digest("hex");
  for (const [index, step] of DESKTOP_OUTREACH_SCHEMA_STEPS.entries()) {
    const projection = {
      ordinal: step.ordinal,
      id: step.id,
      dependsOn: [...step.dependsOn],
      statementKind: step.statementKind,
      statementUtf8Lf: step.statementUtf8Lf,
      beforeProjection: step.beforeProjection,
      afterProjection: step.afterProjection,
      acceptedAfterProjections: [...step.acceptedAfterProjections],
      schemaProjectionSha256: step.schemaProjectionSha256,
      dataInvariant: step.dataInvariant
    };
    assert.equal(step.stepSha256,
      digest("shensi.desktop-outreach-schema-step/v1", projection));
    assert.equal(step.statementUtf8Lf.endsWith("\n"), true);
    assert.equal(step.statementUtf8Lf.includes("\r"), false);
    assert.equal(/ +\n/u.test(step.statementUtf8Lf), false);
    assert.equal(step.dependsOn.every((ordinal) =>
      DESKTOP_OUTREACH_SCHEMA_STEPS.slice(0, index)
        .some((candidate) => candidate.ordinal === ordinal)), true);
  }
  const projection = {
    version: DESKTOP_OUTREACH_SCHEMA_VERSION,
    steps: DESKTOP_OUTREACH_SCHEMA_STEPS.map((step) => ({
      ordinal: step.ordinal,
      id: step.id,
      dependsOn: [...step.dependsOn],
      stepSha256: step.stepSha256
    }))
  };
  assert.equal(DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
    digest("shensi.desktop-outreach-schema-manifest/v1", projection));
});

test("the manifest seals complete metadata descriptors and fixed data predicates", () => {
  const digest = (value) => createHash("sha256")
    .update("shensi.desktop-outreach-schema-projection/v1\0", "utf8")
    .update(JSON.stringify(value), "utf8").digest("hex");
  assert.equal(digest(DESKTOP_OUTREACH_SCHEMA_PROJECTION), DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256);
  assert.equal(DESKTOP_OUTREACH_SCHEMA_STEPS.every((step) =>
    step.schemaProjectionSha256 === DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256), true);
  for (const mutate of [
    (value) => { value.tables.actionsFinal.columns.execution_target.defaultValue = "desktop"; },
    (value) => { value.tables.actionsFinal.indexes.ix_acquisition_outreach_action_desktop_claim.columns.reverse(); },
    (value) => { value.tables.socialFinal.checks.acquisition_social_accounts_executor_binding.clause = "TRUE"; },
    (value) => { value.predicates.attempts.stageInvalid = "FALSE"; }
  ]) {
    const changed = structuredClone(DESKTOP_OUTREACH_SCHEMA_PROJECTION); mutate(changed);
    assert.notEqual(digest(changed), DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256);
  }
});

test("legacy fixture preserves real blocked status and same-candidate predecessor authority", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const actions = fixture.rows.acquisition_outreach_actions;
  for (const semantic of fixture.semanticRows) {
    assert.equal(fixture.rows[semantic.table].filter((row) => row.id === semantic.id).length, 1);
  }
  const blocked = actions.find((row) => row.id === "action-blocked-dm");
  assert.equal(blocked.status, "blocked_by_predecessor");
  for (const action of actions.filter((row) => row.kind === "direct_message")) {
    const predecessor = actions.find((row) => row.id === action.predecessor_action_id);
    assert.equal(predecessor?.kind, "comment");
    for (const key of ["workspace_id", "batch_id", "batch_revision", "candidate_id",
      "account_id", "local_date"]) {
      assert.equal(action[key], predecessor[key], `${action.id}:${key}`);
    }
    assert.equal(action.sequence, predecessor.sequence + 1);
    assert.equal(action.authorization_version, 2);
  }
  for (const attempt of fixture.rows.acquisition_outreach_action_attempts) {
    const action = actions.find((row) => row.id === attempt.action_id);
    assert.equal(action.fencing_token, attempt.fencing_token);
    assert.equal(action.platform_receipt_reference, attempt.platform_receipt_reference);
    if (action.status === "executing") {
      assert.equal(action.lease_token, attempt.lease_token);
      assert.equal(action.lease_owner, attempt.worker_id);
      assert.equal(attempt.completed_at, null);
    } else {
      assert.equal(attempt.outcome, action.status);
      assert.equal(attempt.completed_at, action.occurred_at);
    }
  }
});

test("fresh legacy projection upgrades all 19 steps and is idempotent", async () => {
  const adapter = makeAdapter();
  const first = await runDesktopOutreachSchemaUpgrade(validInput(), {
    adapter,
    now: () => "2026-09-05T00:00:00.000Z"
  });
  assert.deepEqual(first, {
    version: DESKTOP_OUTREACH_SCHEMA_VERSION,
    sha256: DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
    preservationReport: {
      result: "passed",
      targetServerUuidSha256: SERVER_UUID_HASH,
      appliedStepOrdinals: DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) => ordinal),
      adoptedStepOrdinals: []
    }
  });
  assert.equal(adapter.state.ledger.length, 19);
  assert.equal(adapter.state.ledger.at(-1).state, "sealed");
  assert.equal([...adapter.state.applied.values()].reduce((a, b) => a + b, 0), 19);

  const second = await runDesktopOutreachSchemaUpgrade(validInput(), {
    adapter,
    now: () => "2026-09-05T00:00:00.000Z"
  });
  assert.equal(adapter.state.ledger.length, 19);
  assert.equal([...adapter.state.applied.values()].reduce((a, b) => a + b, 0), 19);
  assert.deepEqual(second.preservationReport.appliedStepOrdinals, []);
  assert.deepEqual(second.preservationReport.adoptedStepOrdinals, []);
  assert.equal(adapter.state.calls.acquire, 2);
  assert.equal(adapter.state.calls.release, 2);
  assert.equal(adapter.state.calls.close, 2);
});

test("canonical after-state without ledger is adopted, except nonempty replay tables", async () => {
  const adopter = makeAdapter({
    initialAfter: DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) => ordinal)
  });
  const result = await runDesktopOutreachSchemaUpgrade(validInput(), {
    adapter: adopter,
    now: () => "2026-09-05T00:00:00.000Z"
  });
  assert.deepEqual(result.preservationReport.appliedStepOrdinals, []);
  assert.deepEqual(result.preservationReport.adoptedStepOrdinals,
    DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) => ordinal));
  assert.equal(adopter.state.applied.size, 0);

  const nonemptyReplay = makeAdapter({
    initialAfter: DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) => ordinal),
    replayRows: { 140: 1 }
  });
  await assert.rejects(
    runDesktopOutreachSchemaUpgrade(validInput(), { adapter: nonemptyReplay }),
    ({ code, message }) => code === "DESKTOP_OUTREACH_SCHEMA_REPLAY_NOT_EMPTY" &&
      message === code
  );
});

test("partial schema and unknown, gapped, or conflicting ledger fail closed", async () => {
  const partial = makeAdapter({ partial: [80] });
  await assert.rejects(
    runDesktopOutreachSchemaUpgrade(validInput(), { adapter: partial }),
    ({ code }) => code === "DESKTOP_OUTREACH_SCHEMA_PARTIAL"
  );

  for (const row of [
    canonicalRow({ ordinal: 999, id: "unknown", stepSha256: "f".repeat(64) }),
    canonicalRow(DESKTOP_OUTREACH_SCHEMA_STEPS[0], { manifestSha256: "f".repeat(64) }),
    canonicalRow(DESKTOP_OUTREACH_SCHEMA_STEPS[1])
  ]) {
    const adapter = makeAdapter({ initialAfter: [10], initialLedger: [row],
      ownerTableState: "exact" });
    await assert.rejects(
      runDesktopOutreachSchemaUpgrade(validInput(), { adapter }),
      ({ code }) => code === "DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT"
    );
    assert.equal(adapter.state.applied.size, 0);
  }

  const duplicate = canonicalRow(DESKTOP_OUTREACH_SCHEMA_STEPS[0]);
  const duplicateLedger = makeAdapter({ initialAfter: [10],
    initialLedger: [duplicate, duplicate], ownerTableState: "exact" });
  await assert.rejects(
    runDesktopOutreachSchemaUpgrade(validInput(), { adapter: duplicateLedger }),
    ({ code }) => code === "DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT"
  );

  const failedInvariant = makeAdapter();
  const originalOpen = failedInvariant.openSession;
  failedInvariant.openSession = async (...args) => {
    const session = await originalOpen(...args);
    const inspectStep = session.inspectStep;
    session.inspectStep = async (step) => step.ordinal === 80 ? {
      state: "after", preservationOk: false, rowCount: 0
    } : inspectStep(step);
    return session;
  };
  await assert.rejects(
    runDesktopOutreachSchemaUpgrade(validInput(), { adapter: failedInvariant }),
    ({ code }) => code === "DESKTOP_OUTREACH_SCHEMA_PARTIAL"
  );
});

test("fresh upgrade and exact legacy adoption converge on one sealed ledger", async () => {
  const fresh = makeAdapter();
  const adopted = makeAdapter({
    initialAfter: DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal }) => ordinal)
  });
  const dependencies = { now: () => "2026-09-05T00:00:00.000Z" };
  await runDesktopOutreachSchemaUpgrade(validInput(), { ...dependencies, adapter: fresh });
  await runDesktopOutreachSchemaUpgrade(validInput(), { ...dependencies, adapter: adopted });
  assert.deepEqual(fresh.state.ledger, adopted.state.ledger);
  assert.equal(fresh.state.ledger.at(-1).state, "sealed");
});

test("every step boundary can be interrupted, retried, and run twice", async () => {
  const boundaries = ["before-statement", "after-statement",
    "after-verification", "after-ledger-insert"];
  for (const targetStep of DESKTOP_OUTREACH_SCHEMA_STEPS) {
    for (const targetBoundary of boundaries) {
      const adapter = makeAdapter();
      let interrupted = false;
      await assert.rejects(runDesktopOutreachSchemaUpgrade(validInput(), {
        adapter,
        checkpoint({ boundary, step }) {
          if (!interrupted && boundary === targetBoundary &&
              step.ordinal === targetStep.ordinal) {
            interrupted = true;
            throw new Error("do-not-leak-checkpoint-secret");
          }
        },
        now: () => "2026-09-05T00:00:00.000Z"
      }), ({ code, message }) =>
        code === "DESKTOP_OUTREACH_SCHEMA_INTERRUPTED" && message === code);
      assert.equal(interrupted, true);
      await runDesktopOutreachSchemaUpgrade(validInput(), { adapter });
      await runDesktopOutreachSchemaUpgrade(validInput(), { adapter });
      assert.equal(adapter.state.ledger.length, 19);
      assert.equal([...adapter.state.recorded.values()].every((n) => n === 1), true);
      assert.equal([...adapter.state.applied.values()].every((n) => n === 1), true);
    }
  }
});

test("Trial, retained, arbitrary targets and secret-bearing inputs are denied pre-socket", async () => {
  const cases = [
    (input) => { input.target.database = "shensi_trial"; },
    (input) => { input.target.port = 3310; },
    (input) => { input.target.port = 3312; },
    (input) => { input.target.host = "db.example.test"; },
    (input) => { input.target.username = "root"; },
    (input) => { input.target.kind = "retained_target"; },
    (input) => { input.project = "shensi-api-only"; },
    (input) => { input.ownerWitness.runtimeKind = "accepted_runtime"; },
    (input) => { input.ownerWitness.writersStopped = false; },
    (input) => { input.databaseUrl = "mysql://secret@example.test/shensi"; },
    (input) => { input.target.password = "do-not-leak-target-secret"; }
  ];
  for (const mutate of cases) {
    const input = validInput();
    mutate(input);
    const adapter = makeAdapter();
    await assert.rejects(
      runDesktopOutreachSchemaUpgrade(input, { adapter }),
      ({ code, message, stack }) => {
        const rendered = `${message}\n${stack}`;
        return code === "DESKTOP_OUTREACH_SCHEMA_TARGET_DENIED" &&
          message === code && !rendered.includes("do-not-leak") &&
          !rendered.includes("mysql://");
      }
    );
    assert.equal(adapter.state.calls.open, 0);
  }
});

test("adapter failures are redacted and still release ownership", async () => {
  const adapter = makeAdapter();
  const originalOpen = adapter.openSession;
  adapter.openSession = async (...args) => {
    const session = await originalOpen(...args);
    session.applyStep = async () => {
      throw new Error("mysql://root:super-secret@127.0.0.1/shensi");
    };
    return session;
  };
  await assert.rejects(
    runDesktopOutreachSchemaUpgrade(validInput(), { adapter }),
    ({ code, message, stack }) => code === "DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED" &&
      message === code && !`${message}\n${stack}`.includes("super-secret")
  );
  assert.equal(adapter.state.calls.release, 1);
  assert.equal(adapter.state.calls.close, 1);
});
