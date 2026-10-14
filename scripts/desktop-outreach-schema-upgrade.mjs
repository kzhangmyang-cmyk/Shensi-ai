import { createHash } from "node:crypto";
import { DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256 }
  from "./lib/desktop-outreach-schema-projections.mjs";

export const DESKTOP_OUTREACH_SCHEMA_VERSION =
  "desktop-outreach-action-bridge-v1";
export const DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE =
  "acquisition_desktop_outreach_schema_upgrade_steps";
export const DESKTOP_OUTREACH_SCHEMA_LOCK_NAME = "shensi:doab:v1";

const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const sql = (value) => `${value.trimEnd()}\n`;

const definitions = [
  {
    ordinal: 10,
    id: "create-upgrade-owner-table",
    dependsOn: [],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_outreach_schema_upgrade_steps (
  schema_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  step_ordinal SMALLINT UNSIGNED NOT NULL,
  step_id VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  step_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_attempt_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_server_uuid_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  completed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (schema_version,step_ordinal),
  UNIQUE KEY acquisition_desktop_outreach_schema_upgrade_step_id
    (schema_version,step_id),
  CONSTRAINT acquisition_desktop_outreach_schema_upgrade_hashes CHECK (
    manifest_sha256 REGEXP '^[0-9a-f]{64}$'
    AND step_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_server_uuid_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT acquisition_desktop_outreach_schema_upgrade_state CHECK (
    state IN ('completed','sealed'))
) ENGINE=InnoDB`),
    beforeProjection: "owner-table:absent",
    afterProjection: "owner-table:v1-exact-empty-or-canonical-ledger",
    dataInvariant: "ledger contains only the exact ordered v1 prefix"
  },
  {
    ordinal: 20,
    id: "create-desktop-enrollments",
    dependsOn: [10],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_installation_enrollments (
  workspace_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol_version TINYINT UNSIGNED NOT NULL,
  enrollment_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  registration_idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  registration_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  UNIQUE KEY acquisition_desktop_enrollment_token (enrollment_token_hash),
  INDEX acquisition_desktop_enrollment_workspace_device (workspace_id,device_id_hash),
  INDEX acquisition_desktop_enrollment_expiry (expires_at),
  CONSTRAINT acquisition_desktop_enrollment_protocol CHECK (protocol_version=1)
) ENGINE=InnoDB`),
    beforeProjection: "desktop-enrollments:absent",
    afterProjection: "desktop-enrollments:v1-exact",
    dataInvariant: "adopt canonical rows without mutation"
  },
  {
    ordinal: 30,
    id: "create-desktop-installations",
    dependsOn: [20],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_installations (
  workspace_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_credential_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol_version TINYINT UNSIGNED NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (workspace_id,device_id_hash),
  UNIQUE KEY acquisition_desktop_installation_workspace_credential
    (workspace_id,device_credential_hash),
  INDEX acquisition_desktop_installation_state (workspace_id,state),
  INDEX acquisition_desktop_installation_device_credential
    (device_id_hash,device_credential_hash,protocol_version,state),
  CONSTRAINT acquisition_desktop_installation_protocol CHECK (protocol_version=1),
  CONSTRAINT acquisition_desktop_installation_state_check CHECK (state IN ('active','revoked'))
) ENGINE=InnoDB`),
    beforeProjection: "desktop-installations:absent",
    afterProjection: "desktop-installations:v1-exact",
    dataInvariant: "adopt canonical rows without mutation"
  },
  {
    ordinal: 40,
    id: "add-social-executor-columns",
    dependsOn: [10],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_social_accounts
  ADD COLUMN executor_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER login_state_version_high_water,
  ADD COLUMN executor_device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER executor_mode,
  ADD COLUMN executor_binding_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER executor_device_id_hash,
  ADD COLUMN executor_lease_expires_at VARCHAR(40) NULL AFTER executor_binding_generation`),
    beforeProjection: "social-executor:all-four-columns-absent",
    afterProjection: "social-executor:four-staged-columns-exact",
    dataInvariant: "legacy account fields remain byte stable"
  },
  {
    ordinal: 50,
    id: "backfill-social-executor-authority",
    dependsOn: [40],
    statementKind: "verify",
    statementUtf8Lf: sql("-- verify legacy social executor fields remain NULL,NULL,0,NULL"),
    beforeProjection: "social-executor:four-staged-columns-exact",
    afterProjection: "social-executor:four-staged-columns-exact",
    dataInvariant: "legacy executor tuple is NULL,NULL,0,NULL; never erase an owned binding"
  },
  {
    ordinal: 60,
    id: "add-social-executor-index-check",
    dependsOn: [50],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_social_accounts
  ADD INDEX acquisition_social_accounts_executor_lookup
    (workspace_id,executor_mode,executor_device_id_hash,executor_lease_expires_at),
  ADD CONSTRAINT acquisition_social_accounts_executor_binding CHECK (
    ((executor_mode IS NULL OR executor_mode='server') AND executor_device_id_hash IS NULL
      AND executor_binding_generation=0 AND executor_lease_expires_at IS NULL)
    OR (executor_mode='desktop' AND executor_device_id_hash IS NOT NULL
      AND executor_binding_generation>0 AND executor_lease_expires_at IS NOT NULL))`),
    beforeProjection: "social-executor:columns-exact-index-check-absent",
    afterProjection: "social-executor:v1-exact",
    dataInvariant: "legacy account fields and executor tuple remain byte stable"
  },
  {
    ordinal: 70,
    id: "create-social-login-openings",
    dependsOn: [10],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_social_account_login_openings (
  workspace_id VARCHAR(255) NOT NULL PRIMARY KEY,
  session_id VARCHAR(255) NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at VARCHAR(40) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB`),
    beforeProjection: "social-login-openings:absent",
    afterProjection: "social-login-openings:v1-exact",
    dataInvariant: "adopt canonical rows without mutation"
  },
  {
    ordinal: 80,
    id: "add-action-desktop-columns-stage",
    dependsOn: [10],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_outreach_actions
  ADD COLUMN execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER status,
  ADD COLUMN platform_write_attempt_count INT NULL DEFAULT NULL AFTER attempt_count,
  ADD COLUMN desktop_device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER claimed_at,
  ADD COLUMN desktop_process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_device_id_hash,
  ADD COLUMN desktop_executor_binding_generation BIGINT NULL AFTER desktop_process_instance_id_hash,
  ADD COLUMN desktop_task_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_executor_binding_generation,
  ADD COLUMN desktop_task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_task_request_hash,
  ADD COLUMN desktop_action_deadline_at DATETIME(3) NULL AFTER desktop_task_token_hash`),
    beforeProjection: "outreach-actions:desktop-columns-all-absent",
    afterProjection: "outreach-actions:desktop-columns-staged-exact",
    dataInvariant: "all legacy action fields remain byte stable"
  },
  {
    ordinal: 90,
    id: "backfill-action-target-and-count",
    dependsOn: [80],
    statementKind: "dml",
    statementUtf8Lf: sql(`UPDATE acquisition_outreach_actions
SET execution_target=COALESCE(execution_target,'server'),
    platform_write_attempt_count=COALESCE(platform_write_attempt_count,0)
WHERE execution_target IS NULL OR platform_write_attempt_count IS NULL`),
    beforeProjection: "outreach-actions:desktop-columns-staged-exact",
    afterProjection: "outreach-actions:legacy-target-count-populated",
    dataInvariant: "only NULL target/count become server/0; status and authority bytes unchanged"
  },
  {
    ordinal: 100,
    id: "finalize-action-desktop-schema",
    dependsOn: [90],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_outreach_actions
  MODIFY COLUMN execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server',
  MODIFY COLUMN platform_write_attempt_count INT NOT NULL DEFAULT 0,
  ADD KEY ix_acquisition_outreach_action_desktop_claim (execution_target,status,created_at,id),
  ADD CONSTRAINT acquisition_outreach_action_execution_target
    CHECK (execution_target IN ('server','desktop'))`),
    beforeProjection: "outreach-actions:legacy-target-count-populated",
    afterProjection: "outreach-actions:v1-exact",
    dataInvariant: "all action rows and statuses remain byte stable outside new fields"
  },
  {
    ordinal: 110,
    id: "add-attempt-desktop-columns-stage",
    dependsOn: [100],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_outreach_action_attempts
  ADD COLUMN execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER platform_receipt_reference,
  ADD COLUMN device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER execution_target,
  ADD COLUMN process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER device_id_hash,
  ADD COLUMN executor_binding_generation BIGINT NULL AFTER process_instance_id_hash,
  ADD COLUMN task_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER executor_binding_generation,
  ADD COLUMN task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER task_request_hash,
  ADD COLUMN account_handle CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER task_token_hash,
  ADD COLUMN predecessor_receipt VARCHAR(255) NULL AFTER account_handle,
  ADD COLUMN action_deadline_at DATETIME(3) NULL AFTER predecessor_receipt,
  ADD COLUMN platform_write_attempt_count INT NULL DEFAULT NULL AFTER action_deadline_at,
  ADD COLUMN started_at DATETIME(3) NULL AFTER platform_write_attempt_count,
  ADD COLUMN started_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER started_at,
  ADD COLUMN started_response_json JSON NULL AFTER started_request_hash,
  ADD COLUMN receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER started_response_json,
  ADD COLUMN receipt_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER receipt_hash,
  ADD COLUMN receipt_json JSON NULL AFTER receipt_request_hash,
  ADD COLUMN receipt_response_json JSON NULL AFTER receipt_json,
  ADD COLUMN reconciliation_generation BIGINT NULL DEFAULT NULL AFTER receipt_response_json,
  ADD COLUMN recovery_process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER reconciliation_generation,
  ADD COLUMN recovery_task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER recovery_process_instance_id_hash,
  ADD COLUMN recovery_lease_expires_at DATETIME(3) NULL AFTER recovery_task_token_hash`),
    beforeProjection: "outreach-attempts:desktop-columns-all-absent",
    afterProjection: "outreach-attempts:desktop-columns-staged-exact",
    dataInvariant: "all legacy attempt fields remain byte stable"
  },
  {
    ordinal: 120,
    id: "backfill-attempt-target-and-count",
    dependsOn: [110],
    statementKind: "dml",
    statementUtf8Lf: sql(`UPDATE acquisition_outreach_action_attempts
SET execution_target=COALESCE(execution_target,'server'),
    platform_write_attempt_count=COALESCE(platform_write_attempt_count,0),
    reconciliation_generation=COALESCE(reconciliation_generation,0)
WHERE execution_target IS NULL OR platform_write_attempt_count IS NULL
   OR reconciliation_generation IS NULL`),
    beforeProjection: "outreach-attempts:desktop-columns-staged-exact",
    afterProjection: "outreach-attempts:legacy-target-count-generation-populated",
    dataInvariant: "only NULL target/count/generation become server/0/0; legacy bytes unchanged"
  },
  {
    ordinal: 130,
    id: "finalize-attempt-desktop-schema",
    dependsOn: [120],
    statementKind: "ddl",
    statementUtf8Lf: sql(`ALTER TABLE acquisition_outreach_action_attempts
  MODIFY COLUMN execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server',
  MODIFY COLUMN platform_write_attempt_count INT NOT NULL DEFAULT 0,
  MODIFY COLUMN reconciliation_generation BIGINT NOT NULL DEFAULT 0`),
    beforeProjection: "outreach-attempts:legacy-target-count-generation-populated",
    afterProjection: "outreach-attempts:v1-exact",
    dataInvariant: "unique action/fence and action foreign key remain exact"
  },
  {
    ordinal: 140,
    id: "create-desktop-claim-replays",
    dependsOn: [100, 130],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_outreach_claim_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  server_time DATETIME(3) NOT NULL,
  retry_after_ms INT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_claim_replay_kind CHECK (
    (response_kind='pending' AND action_id IS NULL AND retry_after_ms IS NULL)
    OR (response_kind='claimed' AND action_id IS NOT NULL AND retry_after_ms IS NULL)
    OR (response_kind='empty' AND action_id IS NULL AND retry_after_ms BETWEEN 3000 AND 5000))
) ENGINE=InnoDB`),
    beforeProjection: "desktop-claim-replays:absent",
    afterProjection: "desktop-claim-replays:v1-exact-empty",
    dataInvariant: "table must be empty throughout upgrade"
  },
  {
    ordinal: 150,
    id: "create-desktop-completion-replays",
    dependsOn: [130],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_outreach_completion_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fencing_token BIGINT NOT NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_completion_replay_operation CHECK (
    operation_name IN ('started','receipt','reconciliation_receipt'))
) ENGINE=InnoDB`),
    beforeProjection: "desktop-completion-replays:absent",
    afterProjection: "desktop-completion-replays:v1-exact-empty",
    dataInvariant: "table must be empty throughout upgrade"
  },
  {
    ordinal: 160,
    id: "create-desktop-recovery-replays",
    dependsOn: [130],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_outreach_recovery_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_fencing_token BIGINT NOT NULL,
  response_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_recovery_replay_kind CHECK (
    (response_kind='pending' AND response_json IS NULL)
    OR (response_kind IN ('waiting','released','terminal','reconcile') AND response_json IS NOT NULL))
) ENGINE=InnoDB`),
    beforeProjection: "desktop-recovery-replays:absent",
    afterProjection: "desktop-recovery-replays:v1-exact-empty",
    dataInvariant: "table must be empty throughout upgrade"
  },
  {
    ordinal: 170,
    id: "create-desktop-human-reconciliations",
    dependsOn: [100],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_desktop_outreach_human_reconciliations (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_revision INT NOT NULL,
  approval_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by_user_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  expected_execution_lease_version BIGINT NOT NULL,
  response_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash),
  KEY ix_acquisition_desktop_outreach_human_reconciliation_action
    (workspace_id,batch_id,action_id,requested_at),
  CONSTRAINT acquisition_desktop_outreach_human_reconciliation_operation CHECK (
    operation_name='request_desktop_action_reconciliation')
) ENGINE=InnoDB`),
    beforeProjection: "desktop-human-reconciliations:absent",
    afterProjection: "desktop-human-reconciliations:v1-exact",
    dataInvariant: "adopt canonical rows without mutation"
  },
  {
    ordinal: 180,
    id: "create-outreach-account-recoveries",
    dependsOn: [100],
    statementKind: "ddl",
    statementUtf8Lf: sql(`CREATE TABLE acquisition_outreach_account_recoveries (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_login_state_version INT NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) NOT NULL,
  actor_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_text TEXT NOT NULL,
  enabled_action_ids_json JSON NOT NULL,
  acknowledged_uncertain_action_ids_json JSON NOT NULL,
  recovered_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,batch_id,idempotency_key_hash),
  KEY ix_acquisition_outreach_account_recovery (workspace_id,account_id,recovered_at)
) ENGINE=InnoDB`),
    beforeProjection: "outreach-account-recoveries:absent",
    afterProjection: "outreach-account-recoveries:v1-exact",
    dataInvariant: "adopt canonical rows without mutation"
  },
  {
    ordinal: 190,
    id: "verify-and-seal-v1",
    dependsOn: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
      140, 150, 160, 170, 180],
    statementKind: "verify",
    statementUtf8Lf: sql("-- verify owned v1 projection, preservation evidence, and empty replay tables"),
    beforeProjection: "desktop-outreach-bridge:v1-all-steps-exact-unsealed",
    afterProjection: "desktop-outreach-bridge:v1-all-steps-exact-preserved",
    dataInvariant: "legacy row counts and stable hashes match; new replay tables are empty"
  }
];

// An atomic final ALTER replaces the earlier nullable stage. Each accepted
// successor is a complete canonical projection, never merely a ledger marker.
// The adapter must still prove this step's preservation invariant against it.
const successorAfterProjections = {
  40: ["social-executor:v1-exact"],
  50: ["social-executor:v1-exact"],
  80: ["outreach-actions:legacy-target-count-populated", "outreach-actions:v1-exact"],
  90: ["outreach-actions:v1-exact"],
  110: ["outreach-attempts:legacy-target-count-generation-populated", "outreach-attempts:v1-exact"],
  120: ["outreach-attempts:v1-exact"]
};

function stepProjection(value) {
  return {
    ordinal: value.ordinal,
    id: value.id,
    dependsOn: [...value.dependsOn],
    statementKind: value.statementKind,
    statementUtf8Lf: value.statementUtf8Lf,
    beforeProjection: value.beforeProjection,
    afterProjection: value.afterProjection,
    acceptedAfterProjections: [value.afterProjection,
      ...(successorAfterProjections[value.ordinal] ?? [])],
    schemaProjectionSha256: DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256,
    dataInvariant: value.dataInvariant
  };
}

export const DESKTOP_OUTREACH_SCHEMA_STEPS = deepFreeze(definitions.map((value) => {
  const projection = stepProjection(value);
  return {
    ...projection,
    stepSha256: sha256(
      Buffer.from("shensi.desktop-outreach-schema-step/v1\0", "utf8"),
      Buffer.from(JSON.stringify(projection), "utf8")
    )
  };
}));

const manifestProjection = {
  version: DESKTOP_OUTREACH_SCHEMA_VERSION,
  steps: DESKTOP_OUTREACH_SCHEMA_STEPS.map(({ ordinal, id, dependsOn,
    stepSha256 }) => ({ ordinal, id, dependsOn: [...dependsOn], stepSha256 }))
};

export const DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256 = sha256(
  Buffer.from("shensi.desktop-outreach-schema-manifest/v1\0", "utf8"),
  Buffer.from(JSON.stringify(manifestProjection), "utf8")
);

const REPLAY_STEP_ORDINALS = new Set([140, 150, 160]);
const LEDGER_ROW_KEYS = [
  "schemaVersion", "manifestSha256", "stepOrdinal", "stepId", "stepSha256",
  "state", "migrationAttemptId", "targetServerUuidSha256", "completedAt"
];

class DesktopOutreachSchemaUpgradeError extends Error {
  constructor(code) {
    super(code);
    this.name = "DesktopOutreachSchemaUpgradeError";
    this.code = code;
  }
}

const fail = (code) => new DesktopOutreachSchemaUpgradeError(code);

function hasExactKeys(value, keys) {
  const actual = value !== null && typeof value === "object" &&
    !Array.isArray(value) ? Object.keys(value) : [];
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function validateUpgradeInput(input) {
  const deny = () => {
    throw fail("DESKTOP_OUTREACH_SCHEMA_TARGET_DENIED");
  };
  if (!hasExactKeys(input, ["attemptId", "project", "target", "ownerWitness"])) {
    deny();
  }
  if (!/^[0-9a-f]{12}$/u.test(input.attemptId) ||
      input.project !== `shensi-api-migration-${input.attemptId}`) {
    deny();
  }
  if (!hasExactKeys(input.target,
    ["kind", "database", "host", "port", "username"]) ||
      input.target.kind !== "restored_migration_target" ||
      input.target.database !== "shensi" ||
      input.target.host !== "127.0.0.1" || input.target.port !== 3311 ||
      input.target.username !== "shensi_app") {
    deny();
  }
  const witness = input.ownerWitness;
  if (!hasExactKeys(witness, ["phase", "attemptId", "project", "runtimeKind",
    "writersStopped", "engineIdHash", "ownerLockNonce"]) ||
      witness.phase !== "source_frozen" || witness.attemptId !== input.attemptId ||
      witness.project !== input.project || witness.runtimeKind !== "migration_target" ||
      witness.writersStopped !== true ||
      !/^[0-9a-f]{64}$/u.test(witness.engineIdHash) ||
      !/^[0-9a-f]{32}$/u.test(witness.ownerLockNonce)) {
    deny();
  }
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" ||
      typeof adapter.openSession !== "function") {
    throw fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
  }
}

function validateSession(session) {
  const methods = ["readIdentity", "assertAuthority", "acquireNamedLock",
    "releaseNamedLock", "readLedger", "inspectStep", "applyStep",
    "recordStep", "close"];
  if (!session || typeof session !== "object" ||
      !methods.every((name) => typeof session[name] === "function")) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
  }
}

function validateIdentity(identity, target, expectedHash) {
  if (!hasExactKeys(identity,
    ["database", "host", "port", "serverPort", "authenticatedUser", "serverUuid"]) ||
      identity.database !== target.database || identity.host !== target.host ||
      identity.port !== target.port || identity.serverPort !== 3306 ||
      typeof identity.authenticatedUser !== "string" ||
      identity.authenticatedUser.split("@", 1)[0] !== target.username ||
      typeof identity.serverUuid !== "string" || identity.serverUuid.length < 1 ||
      identity.serverUuid.length > 128) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_IDENTITY_MISMATCH");
  }
  const actualHash = sha256(Buffer.from(identity.serverUuid, "utf8"));
  if (expectedHash && actualHash !== expectedHash) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_IDENTITY_MISMATCH");
  }
  return actualHash;
}

function validateLedgerRow(row, step, targetServerUuidSha256) {
  const state = step.ordinal === 190 ? "sealed" : "completed";
  if (!hasExactKeys(row, LEDGER_ROW_KEYS) ||
      row.schemaVersion !== DESKTOP_OUTREACH_SCHEMA_VERSION ||
      row.manifestSha256 !== DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256 ||
      row.stepOrdinal !== step.ordinal || row.stepId !== step.id ||
      row.stepSha256 !== step.stepSha256 || row.state !== state ||
      !/^[0-9a-f]{12}$/u.test(row.migrationAttemptId) ||
      row.targetServerUuidSha256 !== targetServerUuidSha256 ||
      typeof row.completedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.completedAt)) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
  }
}

function validateLedger(snapshot, targetServerUuidSha256) {
  if (!hasExactKeys(snapshot, ["ownerTableState", "rows"]) ||
      !["absent", "exact", "partial"].includes(snapshot.ownerTableState) ||
      !Array.isArray(snapshot.rows)) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
  }
  if (snapshot.ownerTableState === "partial") {
    throw fail("DESKTOP_OUTREACH_SCHEMA_PARTIAL");
  }
  if (snapshot.ownerTableState === "absent") {
    if (snapshot.rows.length !== 0) {
      throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
    }
    return [];
  }
  if (snapshot.rows.length > DESKTOP_OUTREACH_SCHEMA_STEPS.length) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
  }
  snapshot.rows.forEach((row, index) => validateLedgerRow(row,
    DESKTOP_OUTREACH_SCHEMA_STEPS[index], targetServerUuidSha256));
  return snapshot.rows;
}

function validateInspection(step, inspection) {
  if (!hasExactKeys(inspection, ["state", "preservationOk", "rowCount"]) ||
      !["before", "after", "partial"].includes(inspection.state) ||
      inspection.preservationOk !== true || !Number.isSafeInteger(inspection.rowCount) ||
      inspection.rowCount < 0 || inspection.state === "partial") {
    throw fail("DESKTOP_OUTREACH_SCHEMA_PARTIAL");
  }
  if (REPLAY_STEP_ORDINALS.has(step.ordinal) && inspection.rowCount !== 0) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_REPLAY_NOT_EMPTY");
  }
  return inspection;
}

async function checkpointSafely(checkpoint, boundary, step) {
  if (!checkpoint) return;
  try {
    await checkpoint({ boundary, step });
  } catch {
    throw fail("DESKTOP_OUTREACH_SCHEMA_INTERRUPTED");
  }
}

function normalizeFailure(error) {
  return error instanceof DesktopOutreachSchemaUpgradeError ? error :
    fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
}

/**
 * Execute the immutable v1 upgrade using only an injected target, owner witness,
 * and adapter. This core has no CLI and deliberately reads no environment.
 */
export async function runDesktopOutreachSchemaUpgrade(input, dependencies) {
  validateUpgradeInput(input);
  if (!dependencies || typeof dependencies !== "object" ||
      Array.isArray(dependencies)) {
    throw fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
  }
  const { adapter, checkpoint, now = () => new Date().toISOString() } = dependencies;
  validateAdapter(adapter);
  if ((checkpoint !== undefined && typeof checkpoint !== "function") ||
      typeof now !== "function") {
    throw fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
  }

  let session;
  let namedLockHeld = false;
  let result;
  let failure;
  const appliedStepOrdinals = [];
  const adoptedStepOrdinals = [];
  let targetServerUuidSha256;
  try {
    session = await adapter.openSession({
      target: structuredClone(input.target),
      ownerWitness: structuredClone(input.ownerWitness)
    });
    validateSession(session);
    targetServerUuidSha256 = validateIdentity(await session.readIdentity(),
      input.target);
    namedLockHeld = await session.acquireNamedLock(
      DESKTOP_OUTREACH_SCHEMA_LOCK_NAME) === true;
    if (!namedLockHeld) {
      throw fail("DESKTOP_OUTREACH_SCHEMA_LOCK_UNAVAILABLE");
    }

    for (let index = 0; index < DESKTOP_OUTREACH_SCHEMA_STEPS.length; index += 1) {
      const step = DESKTOP_OUTREACH_SCHEMA_STEPS[index];
      const authorityIdentity = await session.assertAuthority({
        target: structuredClone(input.target),
        ownerWitness: structuredClone(input.ownerWitness),
        targetServerUuidSha256
      });
      validateIdentity(authorityIdentity, input.target, targetServerUuidSha256);
      const snapshot = await session.readLedger();
      const ledger = validateLedger(snapshot, targetServerUuidSha256);
      if (ledger.length < index) {
        throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
      }
      const inspectionContext = {
        completedStepOrdinals: ledger.map((row) => row.stepOrdinal),
        acceptedAfterProjections: [...step.acceptedAfterProjections]
      };
      if (ledger.length > index) {
        const completed = validateInspection(step,
          await session.inspectStep(step, inspectionContext));
        if (completed.state !== "after") {
          throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
        }
        continue;
      }

      const before = validateInspection(step,
        await session.inspectStep(step, inspectionContext));
      if (step.ordinal === 10 &&
          ((snapshot.ownerTableState === "absent" && before.state !== "before") ||
           (snapshot.ownerTableState === "exact" && before.state !== "after"))) {
        throw fail("DESKTOP_OUTREACH_SCHEMA_PARTIAL");
      }
      await checkpointSafely(checkpoint, "before-statement", step);
      if (before.state === "before") {
        await session.applyStep(step);
        appliedStepOrdinals.push(step.ordinal);
      } else {
        adoptedStepOrdinals.push(step.ordinal);
      }
      await checkpointSafely(checkpoint, "after-statement", step);
      const after = validateInspection(step,
        await session.inspectStep(step, inspectionContext));
      if (after.state !== "after") {
        throw fail("DESKTOP_OUTREACH_SCHEMA_PARTIAL");
      }
      await checkpointSafely(checkpoint, "after-verification", step);
      const completedAt = now();
      if (typeof completedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(completedAt)) {
        throw fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
      }
      await session.recordStep({
        schemaVersion: DESKTOP_OUTREACH_SCHEMA_VERSION,
        manifestSha256: DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
        stepOrdinal: step.ordinal,
        stepId: step.id,
        stepSha256: step.stepSha256,
        state: step.ordinal === 190 ? "sealed" : "completed",
        migrationAttemptId: input.attemptId,
        targetServerUuidSha256,
        completedAt
      });
      await checkpointSafely(checkpoint, "after-ledger-insert", step);
    }

    const finalIdentity = await session.assertAuthority({
      target: structuredClone(input.target),
      ownerWitness: structuredClone(input.ownerWitness),
      targetServerUuidSha256
    });
    validateIdentity(finalIdentity, input.target, targetServerUuidSha256);
    if (validateLedger(await session.readLedger(), targetServerUuidSha256).length !==
        DESKTOP_OUTREACH_SCHEMA_STEPS.length) {
      throw fail("DESKTOP_OUTREACH_SCHEMA_LEDGER_CONFLICT");
    }
    result = {
      version: DESKTOP_OUTREACH_SCHEMA_VERSION,
      sha256: DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
      preservationReport: {
        result: "passed",
        targetServerUuidSha256,
        appliedStepOrdinals,
        adoptedStepOrdinals
      }
    };
  } catch (error) {
    failure = normalizeFailure(error);
  }
  if (session && namedLockHeld) {
    try {
      await session.releaseNamedLock(DESKTOP_OUTREACH_SCHEMA_LOCK_NAME);
    } catch {
      failure ??= fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
    }
  }
  if (session) {
    try {
      await session.close();
    } catch {
      failure ??= fail("DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED");
    }
  }
  if (failure) throw failure;
  return result;
}
