import assert from "node:assert/strict";
import test from "node:test";
import mysql from "../backend/node_modules/mysql2/promise.js";
import * as showcase from "./real-trial-showcase.mjs";

const { buildIndependentShowcaseSnapshot } = showcase;

const source = {
  plans: [{
    id: "plan-source", owner_id: "user-source", team_id: "workspace-source",
    revision: 2, payload_json: {
      id: "plan-source", ownerId: "user-source", teamId: "workspace-source",
      currentVersionId: "version-source", approvedVersionId: "version-source"
    }, created_at: new Date("2026-08-01T00:00:00.000Z"), updated_at: "2026-08-01T00:01:00.000Z"
  }],
  planVersions: [{
    id: "version-source", plan_id: "plan-source", owner_id: "user-source",
    team_id: "workspace-source", version_no: 1,
    payload_json: { id: "version-source", planId: "plan-source", ownerId: "user-source", teamId: "workspace-source" },
    created_at: "2026-08-01T00:00:00.000Z"
  }],
  planEvents: [{
    id: "plan-event-source", plan_id: "plan-source", owner_id: "user-source",
    team_id: "workspace-source", revision: 1,
    payload_json: { id: "plan-event-source", planId: "plan-source", actorId: "user-source", ownerId: "user-source", teamId: "workspace-source" },
    occurred_at: "2026-08-01T00:00:00.000Z"
  }],
  runs: [{
    id: "run-source", plan_id: "plan-source", plan_version_id: "version-source",
    owner_id: "user-source", team_id: "workspace-source", revision: 3,
    plan_snapshot_hash: "a".repeat(64), budget_snapshot_hash: "b".repeat(64),
    payload_json: { id: "run-source", planId: "plan-source", planVersionId: "version-source", ownerId: "user-source", teamId: "workspace-source" },
    created_at: "2026-08-01T00:02:00.000Z", updated_at: "2026-08-01T00:03:00.000Z", completed_at: "2026-08-01T00:03:00.000Z"
  }],
  runEvents: [{
    id: "run-event-source", run_id: "run-source", shard_id: null,
    owner_id: "user-source", team_id: "workspace-source", revision: 1,
    payload_json: { id: "run-event-source", runId: "run-source", actorId: "user-source", ownerId: "user-source", teamId: "workspace-source", data: { candidateId: "candidate-source" } },
    occurred_at: "2026-08-01T00:02:30.000Z"
  }],
  candidates: [{
    id: "candidate-source", owner_id: "user-source", team_id: "workspace-source",
    version: 1, payload_json: {
      id: "candidate-source", ownerId: "user-source", teamId: "workspace-source",
      evidenceIds: ["evidence-source"]
    }, created_at: "2026-08-01T00:02:20.000Z", updated_at: "2026-08-01T00:02:20.000Z"
  }],
  candidateAliases: [{
    owner_id: "user-source", team_id: "workspace-source",
    dedupe_key_hash: "c".repeat(64), candidate_id: "candidate-source",
    party_type: "individual", basis: "provider_public_actor",
    created_at: "2026-08-01T00:02:20.000Z"
  }],
  evidence: [{
    id: "evidence-source", owner_id: "user-source", team_id: "workspace-source",
    payload_json: { id: "evidence-source", ownerId: "user-source", teamId: "workspace-source", supersedesEvidenceId: null },
    created_at: "2026-08-01T00:02:10.000Z"
  }]
};

test("builds an independent tenant snapshot with every nested identity rebound", () => {
  const result = buildIndependentShowcaseSnapshot(source, {
    sourceOwnerId: "user-source",
    sourceTeamId: "workspace-source",
    targetOwnerId: "user-target",
    targetTeamId: "workspace-target"
  });

  assert.equal(result.plans.length, 1);
  assert.equal(result.runs.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.evidence.length, 1);

  const plan = result.plans[0];
  const version = result.planVersions[0];
  const run = result.runs[0];
  const event = result.runEvents[0];
  const candidate = result.candidates[0];
  const evidence = result.evidence[0];
  const alias = result.candidateAliases[0];

  assert.notEqual(plan.id, "plan-source");
  assert.notEqual(candidate.id, "candidate-source");
  assert.equal(plan.owner_id, "user-target");
  assert.equal(plan.team_id, "workspace-target");
  assert.equal(plan.payload_json.ownerId, "user-target");
  assert.equal(plan.payload_json.teamId, "workspace-target");
  assert.equal(plan.payload_json.currentVersionId, version.id);
  assert.equal(plan.created_at.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(version.plan_id, plan.id);
  assert.equal(run.plan_id, plan.id);
  assert.equal(run.plan_version_id, version.id);
  assert.equal(event.run_id, run.id);
  assert.equal(event.payload_json.data.candidateId, candidate.id);
  assert.deepEqual(candidate.payload_json.evidenceIds, [evidence.id]);
  assert.equal(alias.candidate_id, candidate.id);
  assert.equal(alias.owner_id, "user-target");
  assert.equal(alias.team_id, "workspace-target");
  assert.equal(evidence.payload_json.ownerId, "user-target");
  assert.equal(evidence.payload_json.teamId, "workspace-target");

  const repeated = buildIndependentShowcaseSnapshot(source, {
    sourceOwnerId: "user-source",
    sourceTeamId: "workspace-source",
    targetOwnerId: "user-target",
    targetTeamId: "workspace-target"
  });
  assert.equal(repeated.plans[0].id, plan.id);
  assert.equal(repeated.candidates[0].id, candidate.id);
  assert.equal(source.plans[0].id, "plan-source");
  assert.equal(source.candidates[0].payload_json.evidenceIds[0], "evidence-source");
});

test("copies only the safe showcase graph and replays without duplicates", {
  skip: !process.env.TRIAL_SHOWCASE_TEST_DATABASE_URL
}, async () => {
  const connection = await mysql.createConnection(process.env.TRIAL_SHOWCASE_TEST_DATABASE_URL);
  const suffix = `${process.pid}-${Date.now()}`;
  const targetOwnerId = `showcase-test-owner-${suffix}`;
  const targetTeamId = `showcase-test-team-${suffix}`;
  await connection.beginTransaction();
  try {
    const [sourceUsers] = await connection.query(
      "SELECT id, team_id FROM users WHERE email = ?",
      ["test@shensi.local"]
    );
    assert.equal(sourceUsers.length, 1);
    const sourceUser = sourceUsers[0];
    const first = await showcase.copyIndependentTrialShowcase(connection, {
      sourceOwnerId: sourceUser.id,
      sourceTeamId: sourceUser.team_id,
      targetOwnerId,
      targetTeamId
    });
    assert.equal(first.replayed, false);
    assert.equal(first.counts.plans, 1);
    assert.equal(first.counts.runs, 1);
    assert.equal(first.counts.runEvents, 16);
    assert.equal(first.counts.candidates, 40);
    assert.equal(first.counts.evidence, 136);

    const [planRows] = await connection.query(
      "SELECT payload_json FROM acquisition_plans WHERE owner_id = ? AND team_id = ?",
      [targetOwnerId, targetTeamId]
    );
    assert.equal(planRows.length, 1);
    assert.equal(planRows[0].payload_json.status, "archived");
    assert.equal(planRows[0].payload_json.approvedVersionId, null);

    const [candidateRows] = await connection.query(
      "SELECT id, payload_json FROM acquisition_candidates WHERE owner_id = ? AND team_id = ?",
      [targetOwnerId, targetTeamId]
    );
    assert.equal(candidateRows.length, 40);
    const candidatePayload = candidateRows[0].payload_json;
    assert.equal(candidatePayload.ownerId, targetOwnerId);
    assert.equal(candidatePayload.teamId, targetTeamId);
    const [linkedEvidence] = await connection.query(
      "SELECT COUNT(*) count FROM acquisition_discovery_evidence WHERE owner_id = ? AND team_id = ? AND id IN (?)",
      [targetOwnerId, targetTeamId, candidatePayload.evidenceIds]
    );
    assert.equal(Number(linkedEvidence[0].count), candidatePayload.evidenceIds.length);

    for (const table of [
      "acquisition_social_accounts",
      "acquisition_outreach_actions",
      "provider_connections",
      "ai_model_configs"
    ]) {
      const scopeColumn = table.startsWith("acquisition_social")
        || table === "acquisition_outreach_actions" ? "workspace_id" : "team_id";
      const scope = scopeColumn === "workspace_id" ? targetTeamId : targetTeamId;
      const [rows] = await connection.query(
        `SELECT COUNT(*) count FROM \`${table}\` WHERE \`${scopeColumn}\` = ?`,
        [scope]
      );
      assert.equal(Number(rows[0].count), 0, `${table} must not be cloned`);
    }

    const replay = await showcase.copyIndependentTrialShowcase(connection, {
      sourceOwnerId: sourceUser.id,
      sourceTeamId: sourceUser.team_id,
      targetOwnerId,
      targetTeamId
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.counts, first.counts);
  } finally {
    await connection.rollback();
    await connection.end();
  }
});
