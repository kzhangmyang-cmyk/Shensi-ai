import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import mysql from "../backend/node_modules/mysql2/promise.js";

const SNAPSHOT_COLLECTIONS = [
  ["plans", "plan"],
  ["planVersions", "plan_version"],
  ["planEvents", "plan_event"],
  ["runs", "run"],
  ["runEvents", "run_event"],
  ["candidates", "candidate"],
  ["evidence", "evidence"]
];

const SAFE_TABLES = [
  ["plans", "acquisition_plans"],
  ["planVersions", "acquisition_plan_versions"],
  ["planEvents", "acquisition_plan_events"],
  ["runs", "acquisition_runs"],
  ["runEvents", "acquisition_run_events"],
  ["candidates", "acquisition_candidates"],
  ["candidateAliases", "acquisition_candidate_identity_aliases"],
  ["evidence", "acquisition_discovery_evidence"]
];

function snapshotId(kind, sourceId, targetTeamId) {
  const digest = createHash("sha256")
    .update(`${targetTeamId}\0${kind}\0${sourceId}`)
    .digest("hex")
    .slice(0, 40);
  return `showcase_${kind}_${digest}`;
}

function rewriteValue(value, replacements) {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (value instanceof Date) return new Date(value);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      rewriteValue(item, replacements)
    ]));
  }
  return value;
}

function scopedRow(row, scope, replacements, idFields = []) {
  if (row.owner_id !== scope.sourceOwnerId || row.team_id !== scope.sourceTeamId) {
    throw new Error("TRIAL_SHOWCASE_SOURCE_SCOPE_MISMATCH");
  }
  const result = rewriteValue(row, replacements);
  result.owner_id = scope.targetOwnerId;
  result.team_id = scope.targetTeamId;
  for (const field of idFields) {
    if (typeof row[field] === "string" && row[field]) {
      result[field] = replacements.get(row[field]) ?? row[field];
    }
  }
  return result;
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function withParsedPayload(rows) {
  return rows.map((row) => ({ ...row, payload_json: parseJson(row.payload_json) }));
}

async function readSourceGraph(connection, scope) {
  const parameters = [scope.sourceOwnerId, scope.sourceTeamId];
  const query = async (sql, additionalParameters = []) => {
    const [rows] = await connection.query(sql, [...parameters, ...additionalParameters]);
    return withParsedPayload(rows);
  };
  const plans = await query(
      `SELECT id, owner_id, team_id, revision, payload_json, created_at, updated_at
       FROM acquisition_plans
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at, id`
    );
  const planVersions = await query(
      `SELECT id, plan_id, owner_id, team_id, version_no, payload_json, created_at
       FROM acquisition_plan_versions
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at, id`
    );
  const planEvents = await query(
      `SELECT id, plan_id, owner_id, team_id, revision, payload_json, occurred_at
       FROM acquisition_plan_events
       WHERE owner_id = ? AND team_id = ?
       ORDER BY occurred_at, id`
    );
  const runs = await query(
      `SELECT id, plan_id, plan_version_id, owner_id, team_id, revision,
              plan_snapshot_hash, budget_snapshot_hash, payload_json,
              created_at, updated_at, completed_at
       FROM acquisition_runs
       WHERE owner_id = ? AND team_id = ? AND completed_at IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    );
  const runEvents = runs[0] ? await query(
      `SELECT id, run_id, shard_id, owner_id, team_id, revision,
              payload_json, occurred_at
       FROM acquisition_run_events
       WHERE owner_id = ? AND team_id = ? AND run_id = ?
       ORDER BY occurred_at, id`,
      [runs[0].id]
    ) : [];
  const candidates = await query(
      `SELECT id, owner_id, team_id, version, payload_json, created_at, updated_at
       FROM acquisition_candidates
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at, id`
    );
  const candidateAliases = await query(
      `SELECT owner_id, team_id, dedupe_key_hash, candidate_id,
              party_type, basis, created_at
       FROM acquisition_candidate_identity_aliases
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at, dedupe_key_hash`
    );
  const evidence = await query(
      `SELECT id, owner_id, team_id, payload_json, created_at
       FROM acquisition_discovery_evidence
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at, id`
    );
  return {
    plans, planVersions, planEvents, runs, runEvents,
    candidates, candidateAliases, evidence
  };
}

async function targetCounts(connection, scope) {
  const result = {};
  for (const [collection, table] of SAFE_TABLES) {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS count FROM \`${table}\` WHERE owner_id = ? AND team_id = ?`,
      [scope.targetOwnerId, scope.targetTeamId]
    );
    result[collection] = Number(rows[0].count);
  }
  return result;
}

function publicCounts(snapshot) {
  return Object.fromEntries(SAFE_TABLES.map(([collection]) => [
    collection,
    snapshot[collection].length
  ]));
}

async function targetMatchesSnapshot(connection, scope, snapshot, counts) {
  const expectedCounts = publicCounts(snapshot);
  if (!SAFE_TABLES.every(([collection]) => counts[collection] === expectedCounts[collection])) {
    return false;
  }
  for (const [collection, table] of SAFE_TABLES) {
    if (collection === "candidateAliases") {
      const [rows] = await connection.query(
        `SELECT dedupe_key_hash, candidate_id
         FROM \`${table}\`
         WHERE owner_id = ? AND team_id = ?`,
        [scope.targetOwnerId, scope.targetTeamId]
      );
      const actual = rows.map((row) => `${row.dedupe_key_hash}:${row.candidate_id}`).sort();
      const expected = snapshot.candidateAliases
        .map((row) => `${row.dedupe_key_hash}:${row.candidate_id}`)
        .sort();
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        return false;
      }
      continue;
    }
    const [rows] = await connection.query(
      `SELECT id FROM \`${table}\` WHERE owner_id = ? AND team_id = ?`,
      [scope.targetOwnerId, scope.targetTeamId]
    );
    const actual = rows.map((row) => row.id).sort();
    const expected = snapshot[collection].map((row) => row.id).sort();
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      return false;
    }
  }
  return true;
}

async function insertSnapshot(connection, snapshot) {
  for (const row of snapshot.plans) {
    await connection.query(
      `INSERT INTO acquisition_plans
       (id, owner_id, team_id, revision, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.owner_id, row.team_id, row.revision, json(row.payload_json), row.created_at, row.updated_at]
    );
  }
  for (const row of snapshot.planVersions) {
    await connection.query(
      `INSERT INTO acquisition_plan_versions
       (id, plan_id, owner_id, team_id, version_no, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.plan_id, row.owner_id, row.team_id, row.version_no, json(row.payload_json), row.created_at]
    );
  }
  for (const row of snapshot.planEvents) {
    await connection.query(
      `INSERT INTO acquisition_plan_events
       (id, plan_id, owner_id, team_id, revision, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.plan_id, row.owner_id, row.team_id, row.revision, json(row.payload_json), row.occurred_at]
    );
  }
  for (const row of snapshot.runs) {
    await connection.query(
      `INSERT INTO acquisition_runs
       (id, plan_id, plan_version_id, owner_id, team_id, revision,
        plan_snapshot_hash, budget_snapshot_hash, payload_json,
        created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.plan_id, row.plan_version_id, row.owner_id, row.team_id,
        row.revision, row.plan_snapshot_hash, row.budget_snapshot_hash,
        json(row.payload_json), row.created_at, row.updated_at, row.completed_at
      ]
    );
  }
  for (const row of snapshot.runEvents) {
    await connection.query(
      `INSERT INTO acquisition_run_events
       (id, run_id, shard_id, owner_id, team_id, revision, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.run_id, row.shard_id, row.owner_id, row.team_id,
        row.revision, json(row.payload_json), row.occurred_at
      ]
    );
  }
  for (const row of snapshot.evidence) {
    await connection.query(
      `INSERT INTO acquisition_discovery_evidence
       (id, owner_id, team_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.owner_id, row.team_id, json(row.payload_json), row.created_at]
    );
  }
  for (const row of snapshot.candidates) {
    await connection.query(
      `INSERT INTO acquisition_candidates
       (id, owner_id, team_id, version, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.owner_id, row.team_id, row.version,
        json(row.payload_json), row.created_at, row.updated_at
      ]
    );
  }
  for (const row of snapshot.candidateAliases) {
    await connection.query(
      `INSERT INTO acquisition_candidate_identity_aliases
       (owner_id, team_id, dedupe_key_hash, candidate_id, party_type, basis, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.owner_id, row.team_id, row.dedupe_key_hash, row.candidate_id,
        row.party_type, row.basis, row.created_at
      ]
    );
  }
}

export function buildIndependentShowcaseSnapshot(source, scope) {
  if (!scope.sourceOwnerId || !scope.sourceTeamId || !scope.targetOwnerId || !scope.targetTeamId
    || scope.sourceOwnerId === scope.targetOwnerId || scope.sourceTeamId === scope.targetTeamId) {
    throw new Error("TRIAL_SHOWCASE_SCOPE_INVALID");
  }
  const replacements = new Map([
    [scope.sourceOwnerId, scope.targetOwnerId],
    [scope.sourceTeamId, scope.targetTeamId]
  ]);
  for (const [collection, kind] of SNAPSHOT_COLLECTIONS) {
    for (const row of source[collection] ?? []) {
      replacements.set(row.id, snapshotId(kind, row.id, scope.targetTeamId));
    }
  }

  return {
    plans: (source.plans ?? []).map((row) => scopedRow(row, scope, replacements, ["id"])),
    planVersions: (source.planVersions ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id", "plan_id"])),
    planEvents: (source.planEvents ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id", "plan_id"])),
    runs: (source.runs ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id", "plan_id", "plan_version_id"])),
    runEvents: (source.runEvents ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id", "run_id", "shard_id"])),
    candidates: (source.candidates ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id"])),
    candidateAliases: (source.candidateAliases ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["candidate_id"])),
    evidence: (source.evidence ?? []).map((row) =>
      scopedRow(row, scope, replacements, ["id"]))
  };
}

function makeSnapshotReadOnly(snapshot) {
  return {
    ...snapshot,
    plans: snapshot.plans.map((row) => ({
      ...row,
      payload_json: {
        ...row.payload_json,
        status: "archived",
        approvedVersionId: null
      }
    }))
  };
}

export async function copyIndependentTrialShowcase(connection, scope) {
  const source = await readSourceGraph(connection, scope);
  if (source.plans.length !== 1 || source.planVersions.length === 0
    || source.runs.length !== 1 || source.candidates.length === 0
    || source.evidence.length === 0) {
    throw new Error("TRIAL_SHOWCASE_SOURCE_INCOMPLETE");
  }
  if (source.runEvents.some((row) => row.shard_id !== null)) {
    throw new Error("TRIAL_SHOWCASE_OPERATION_SHARDS_UNSUPPORTED");
  }
  const snapshot = makeSnapshotReadOnly(buildIndependentShowcaseSnapshot(source, scope));
  const counts = publicCounts(snapshot);
  const existing = await targetCounts(connection, scope);
  const hasExisting = Object.values(existing).some((count) => count > 0);
  if (hasExisting) {
    if (await targetMatchesSnapshot(connection, scope, snapshot, existing)) {
      return { replayed: true, dryRun: Boolean(scope.dryRun), counts };
    }
    throw new Error("TRIAL_SHOWCASE_TARGET_NOT_EMPTY");
  }
  if (scope.dryRun) {
    return { replayed: false, dryRun: true, counts };
  }
  await insertSnapshot(connection, snapshot);
  const inserted = await targetCounts(connection, scope);
  if (!(await targetMatchesSnapshot(connection, scope, snapshot, inserted))) {
    throw new Error("TRIAL_SHOWCASE_WRITE_VERIFICATION_FAILED");
  }
  return { replayed: false, dryRun: false, counts };
}

function trialDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const contents = readFileSync(
    new URL("../.runtime/real-trial/trial.env", import.meta.url),
    "utf8"
  );
  const line = contents.split(/\r?\n/u).find((value) => value.startsWith("DATABASE_URL="));
  if (!line) throw new Error("TRIAL_SHOWCASE_DATABASE_URL_MISSING");
  return line.slice("DATABASE_URL=".length);
}

async function accountScope(connection, email) {
  const [rows] = await connection.query(
    "SELECT id, team_id, role FROM users WHERE email = ? LIMIT 2",
    [email]
  );
  if (rows.length !== 1 || rows[0].role !== "admin") {
    throw new Error("TRIAL_SHOWCASE_ACCOUNT_INVALID");
  }
  return { ownerId: rows[0].id, teamId: rows[0].team_id };
}

async function runCli() {
  const connection = await mysql.createConnection(trialDatabaseUrl());
  const dryRun = process.argv.includes("--dry-run");
  try {
    const source = await accountScope(
      connection,
      process.env.TRIAL_SHOWCASE_SOURCE_EMAIL ?? "test@shensi.local"
    );
    const target = await accountScope(
      connection,
      process.env.TRIAL_SHOWCASE_TARGET_EMAIL ?? "test2@shensi.local"
    );
    await connection.beginTransaction();
    const result = await copyIndependentTrialShowcase(connection, {
      sourceOwnerId: source.ownerId,
      sourceTeamId: source.teamId,
      targetOwnerId: target.ownerId,
      targetTeamId: target.teamId,
      dryRun
    });
    if (dryRun) await connection.rollback();
    else await connection.commit();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // The original failure is more actionable than a rollback failure.
    }
    throw error;
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "TRIAL_SHOWCASE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
