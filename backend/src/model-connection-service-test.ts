import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activateModelConnection,
  createModelCredentialVersion,
  deleteModelConnection,
  selectLegacyActiveConnectionIds,
  toPublicModelConnection
} from "./model-providers/connection-service.js";
import {
  appendStoredAiJobModelSnapshot,
  createAiJobModelSnapshot
} from "./model-providers/job-snapshot.js";
import type {
  ModelConnection,
  ModelConnectionActivationEvent,
  ModelCredentialVersion,
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

function connection(
  id: string,
  ownerId: string,
  provider: ModelConnection["provider"],
  active: boolean,
  teamId = "team-1"
): ModelConnection {
  return {
    id,
    ownerId,
    teamId,
    provider,
    model: `${provider}-model`,
    baseUrlFingerprint: `sha256:${provider}`,
    credentialVersion: 1,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: true,
      parallelToolCalling: false,
      streaming: true,
      modelListing: false
    },
    status: active ? "active" : "inactive",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z"
  };
}

test("activation is owner-and-team scoped and existing job snapshots remain immutable", async () => {
  const first = connection("conn-first", "owner-1", "moonshot", true);
  const second = connection("conn-second", "owner-1", "zhipu", false);
  const otherOwner = connection("conn-other", "owner-2", "openai", true);
  const sameOwnerOtherTeam = connection(
    "conn-other-team",
    "owner-1",
    "minimax",
    true,
    "team-2"
  );
  const activationEvents: ModelConnectionActivationEvent[] = [];
  const pendingActivationEvents: ModelConnectionActivationEvent[] = [];
  const store = {
    connections: [first, second, otherOwner, sameOwnerOtherTeam],
    activationEvents,
    pendingActivationEvents,
    async persist() {}
  };

  await activateModelConnection(
    store,
    { ownerId: "owner-1", teamId: "team-1" },
    second.id,
    "owner-1",
    "switch"
  );
  assert.deepEqual(
    store.connections
      .filter(
        (item) => item.ownerId === "owner-1"
          && item.teamId === "team-1"
          && item.status === "active"
      )
      .map((item) => item.id),
    [second.id]
  );
  assert.equal(otherOwner.status, "active");
  assert.equal(sameOwnerOtherTeam.status, "active");
  await assert.rejects(
    activateModelConnection(
      store,
      { ownerId: "owner-1", teamId: "team-1" },
      otherOwner.id,
      "owner-1",
      "cross-owner attempt"
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "connection_not_found"
      );
      return true;
    }
  );
  assert.deepEqual(activationEvents[0], {
    id: activationEvents[0].id,
    ownerId: "owner-1",
    teamId: "team-1",
    actorId: "owner-1",
    previousConnectionId: "conn-first",
    connectionId: "conn-second",
    reason: "switch",
    createdAt: activationEvents[0].createdAt
  });
  assert.equal(pendingActivationEvents[0], activationEvents[0]);

  const snapshot = createAiJobModelSnapshot(second, 3, {
    promptVersion: "lead-plan.v1",
    schemaVersion: "acquisition-plan.v1"
  });
  await activateModelConnection(
    store,
    { ownerId: "owner-1", teamId: "team-1" },
    first.id,
    "owner-1",
    "switch back"
  );
  second.model = "changed-after-job-creation";
  second.capabilitySnapshot.toolCalling = false;

  assert.equal(snapshot.connectionId, "conn-second");
  assert.equal(snapshot.credentialVersion, 3);
  assert.equal(snapshot.model, "zhipu-model");
  assert.equal(snapshot.capabilitySnapshot.toolCalling, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.capabilitySnapshot), true);
});

test("credential updates append encrypted versions and public responses stay masked", () => {
  process.env.JWT_SECRET = "task-three-test-secret-at-least-32-characters";
  const modelConnection = connection(
    "conn-credential",
    "owner-1",
    "deepseek",
    true
  );
  const credentials: ModelCredentialVersion[] = [];
  const pendingCredentials: ModelCredentialVersion[] = [];
  const secretV1 = "sk-private-version-one-1234";
  const secretV2 = "sk-private-version-two-5678";

  const first = createModelCredentialVersion(
    credentials,
    modelConnection,
    secretV1,
    "owner-1",
    undefined,
    pendingCredentials
  );
  const snapshotAtV1 = createAiJobModelSnapshot(modelConnection, first.version, {
    promptVersion: "lead-plan.v1",
    schemaVersion: "acquisition-plan.v1"
  });
  const second = createModelCredentialVersion(
    credentials,
    modelConnection,
    secretV2,
    "owner-1",
    undefined,
    pendingCredentials
  );
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(first.provider, "deepseek");
  assert.equal(second.provider, "deepseek");
  assert.equal(credentials.length, 2);
  assert.deepEqual(pendingCredentials, credentials);
  assert.equal(modelConnection.credentialVersion, 2);
  assert.equal(snapshotAtV1.credentialVersion, 1);
  assert.ok(first.apiKeyEncrypted.startsWith("ai-v1."));
  assert.ok(second.apiKeyEncrypted.startsWith("ai-v1."));

  const serializedCredentials = JSON.stringify(credentials);
  assert.equal(serializedCredentials.includes(secretV1), false);
  assert.equal(serializedCredentials.includes(secretV2), false);
  const response = toPublicModelConnection(modelConnection, second);
  assert.equal(response.hasKey, true);
  assert.equal(response.apiKey, "****5678");
  assert.equal(JSON.stringify(response).includes(secretV2), false);
});

test("stored job snapshots are tracked as pending appends", () => {
  const modelConnection = connection(
    "conn-job",
    "owner-1",
    "openai",
    true
  );
  const snapshot: StoredAiJobModelSnapshot = {
    ...createAiJobModelSnapshot(modelConnection, 1, {
      promptVersion: "lead-plan.v1",
      schemaVersion: "acquisition-plan.v1"
    }),
    jobId: "job-pending",
    ownerId: "owner-1",
    teamId: "team-1",
    baseUrl: "https://api.openai.com/v1",
    baseUrlFingerprint: modelConnection.baseUrlFingerprint || "sha256:test",
    promptHash: "sha256:prompt",
    schemaHash: "sha256:schema",
    createdAt: "2026-07-23T10:30:00.000Z"
  };
  const history: StoredAiJobModelSnapshot[] = [];
  const pending: StoredAiJobModelSnapshot[] = [];
  appendStoredAiJobModelSnapshot(history, pending, snapshot);
  assert.deepEqual(history, [snapshot]);
  assert.deepEqual(pending, [snapshot]);
});

test("connections referenced by immutable job snapshots cannot be deleted", async () => {
  const modelConnection = connection(
    "conn-in-use",
    "owner-1",
    "qwen",
    false
  );
  const snapshots: StoredAiJobModelSnapshot[] = [{
    ...createAiJobModelSnapshot(modelConnection, 1, {
      promptVersion: "lead-plan.v1",
      schemaVersion: "acquisition-plan.v1"
    }),
    jobId: "job-1",
    ownerId: "owner-1",
    teamId: "team-1",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    baseUrlFingerprint: modelConnection.baseUrlFingerprint || "sha256:test",
    promptHash: "sha256:prompt",
    schemaHash: "sha256:schema",
    createdAt: "2026-07-23T11:00:00.000Z"
  }];
  const store = {
    connections: [modelConnection],
    jobSnapshots: snapshots,
    async persist() {}
  };

  await assert.rejects(
    deleteModelConnection(
      store,
      { ownerId: "owner-1", teamId: "team-1" },
      modelConnection.id
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "connection_in_use"
      );
      assert.equal((error as { status?: number }).status, 409);
      return true;
    }
  );
  assert.equal(store.connections.length, 1);
});

test("the currently active connection must be switched away before deletion", async () => {
  const active = connection("conn-active", "owner-1", "doubao", true);
  const store = {
    connections: [active],
    jobSnapshots: [] as StoredAiJobModelSnapshot[],
    async persist() {}
  };
  await assert.rejects(
    deleteModelConnection(
      store,
      { ownerId: "owner-1", teamId: "team-1" },
      active.id
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "connection_in_use"
      );
      assert.equal((error as { status?: number }).status, 409);
      return true;
    }
  );
});

test("activation audit retention blocks deletion only until its exact expiry", async () => {
  const retained = connection(
    "conn-audit-retained",
    "owner-1",
    "minimax",
    false
  );
  const activationEvents: ModelConnectionActivationEvent[] = [{
    id: "event-retained",
    ownerId: "owner-1",
    teamId: "team-1",
    actorId: "owner-1",
    previousConnectionId: retained.id,
    connectionId: "conn-replacement",
    reason: "switch away",
    createdAt: "2026-07-23T10:00:00.000Z"
  }];
  const store = {
    connections: [retained],
    jobSnapshots: [] as StoredAiJobModelSnapshot[],
    activationEvents,
    async persist() {}
  };
  let now = new Date("2026-07-23T11:59:59.999Z");
  const options = {
    now: () => now,
    activationAuditRetentionMs: 2 * 60 * 60 * 1_000
  };

  await assert.rejects(
    deleteModelConnection(
      store,
      { ownerId: "owner-1", teamId: "team-1" },
      retained.id,
      options
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "connection_in_use"
      );
      return true;
    }
  );
  assert.equal(store.connections.length, 1);

  now = new Date("2026-07-23T12:00:00.000Z");
  await deleteModelConnection(
    store,
    { ownerId: "owner-1", teamId: "team-1" },
    retained.id,
    options
  );
  assert.equal(store.connections.length, 0);
});

test("legacy activation migration selects updated_at DESC then id ASC per owner and team", () => {
  const selected = selectLegacyActiveConnectionIds([
    {
      id: "conn-z",
      ownerId: "owner-1",
      teamId: "team-1",
      enabled: true,
      updatedAt: "2026-07-23T12:00:00.000Z"
    },
    {
      id: "conn-a",
      ownerId: "owner-1",
      teamId: "team-1",
      enabled: true,
      updatedAt: "2026-07-23T12:00:00.000Z"
    },
    {
      id: "conn-team-2",
      ownerId: "owner-1",
      teamId: "team-2",
      enabled: true,
      updatedAt: "2026-07-23T09:00:00.000Z"
    },
    {
      id: "conn-newer",
      ownerId: "owner-2",
      teamId: "team-1",
      enabled: true,
      updatedAt: "2026-07-23T13:00:00.000Z"
    },
    {
      id: "conn-older",
      ownerId: "owner-2",
      teamId: "team-1",
      enabled: true,
      updatedAt: "2026-07-23T11:00:00.000Z"
    },
    {
      id: "conn-disabled",
      ownerId: "owner-3",
      teamId: "team-1",
      enabled: false,
      updatedAt: "2026-07-23T14:00:00.000Z"
    }
  ]);

  assert.deepEqual(
    [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [
      ['["owner-1","team-1"]', "conn-a"],
      ['["owner-1","team-2"]', "conn-team-2"],
      ['["owner-2","team-1"]', "conn-newer"]
    ]
  );
});

test("MySQL enforces one active connection per owner and team and activation is transactionally audited", () => {
  const installSchema = readFileSync(
    new URL("../schema.mysql.sql", import.meta.url),
    "utf8"
  );
  const fullInstallSchema = readFileSync(
    new URL("../goodjob_crm.full.sql", import.meta.url),
    "utf8"
  );
  const mysqlStore = readFileSync(
    new URL("./mysql-store.ts", import.meta.url),
    "utf8"
  );
  for (const schema of [installSchema, fullInstallSchema]) {
    assert.match(
      schema,
      /active_owner_team_key VARCHAR\(191\) GENERATED ALWAYS AS/
    );
    assert.match(
      schema,
      /UNIQUE KEY uniq_ai_model_active_owner_team\(active_owner_team_key\)/
    );
    assert.match(schema, /CREATE TABLE ai_model_credential_versions/);
    assert.match(schema, /CREATE TABLE ai_job_model_snapshots/);
    assert.match(
      schema,
      /CREATE TABLE ai_model_connection_idempotency[\s\S]+PRIMARY KEY\(owner_id, team_id, idempotency_key_hash\)/
    );
    assert.match(schema, /endpoint_profile_id VARCHAR\(80\)/);
    assert.match(schema, /capability_certification_hash VARCHAR\(80\)/);
  }
  assert.match(
    mysqlStore,
    /CREATE TABLE IF NOT EXISTS ai_model_connection_idempotency[\s\S]+PRIMARY KEY\(owner_id, team_id, idempotency_key_hash\)[\s\S]+ensurePrimaryKey\([\s\S]+ai_model_connection_idempotency[\s\S]+\["owner_id", "team_id", "idempotency_key_hash"\]/
  );
  assert.match(
    mysqlStore,
    /const activateModelConnection =[\s\S]+beginTransaction\(\)[\s\S]+SET enabled = FALSE[\s\S]+WHERE owner_id = \? AND team_id = \?[\s\S]+SET enabled = TRUE[\s\S]+WHERE id = \? AND owner_id = \? AND team_id = \?[\s\S]+INSERT INTO ai_model_connection_activation_events[\s\S]+commit\(\)/
  );
  assert.match(
    mysqlStore,
    /SELECT \* FROM ai_model_configs[\s\S]+WHERE owner_id = \? AND team_id = \?[\s\S]+ORDER BY id[\s\S]+FOR UPDATE[\s\S]+scopedRows[\s\S]+item\.id === connectionId/
  );
  assert.match(
    mysqlStore,
    /selectLegacyActiveConnectionIds[\s\S]+WHERE id = \? AND owner_id = \? AND team_id = \?[\s\S]+system_migration[\s\S]+ai_model_credential_versions/
  );
  const activeScopeColumnPosition = mysqlStore.indexOf(
    '"active_owner_team_key"'
  );
  const legacyIndexDropPosition = mysqlStore.indexOf(
    '"uniq_ai_model_active_owner"',
    activeScopeColumnPosition
  );
  const migrationPosition = mysqlStore.indexOf(
    "await migrateLegacyAiModelConnections(pool)",
    legacyIndexDropPosition
  );
  const activeScopeIndexPosition = mysqlStore.indexOf(
    '"uniq_ai_model_active_owner_team"',
    migrationPosition
  );
  assert.ok(
    activeScopeColumnPosition >= 0
      && legacyIndexDropPosition > activeScopeColumnPosition
      && migrationPosition > legacyIndexDropPosition
      && activeScopeIndexPosition > migrationPosition,
    "schema upgrade must drop the legacy owner-only invariant, normalize each owner/team scope, then install the scoped unique invariant"
  );
  assert.match(
    mysqlStore,
    /FROM ai_model_connection_activation_events[\s\S]+previous_connection_id = \?[\s\S]+created_at > \?/
  );
  assert.match(
    mysqlStore,
    /DEFAULT_MODEL_CONNECTION_ACTIVATION_AUDIT_RETENTION_MS/
  );
  assert.match(
    mysqlStore,
    /endpointProfileId: row\.endpoint_profile_id[\s\S]+capabilityCertificationHash:[\s\S]+row\.capability_certification_hash/
  );
  assert.match(
    mysqlStore,
    /endpoint_profile_id,endpoint_region,endpoint_workspace_id,adapter_version[\s\S]+capability_certification_hash/
  );
});
