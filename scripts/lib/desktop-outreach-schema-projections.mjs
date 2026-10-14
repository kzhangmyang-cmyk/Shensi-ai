import { createHash } from "node:crypto";
const OWNER = "acquisition_desktop_outreach_schema_upgrade_steps";

const col = (type, nullable = false, defaultValue = null, ascii = false) =>
  ({ type, nullable, defaultValue, ascii });
const v = (n = 255, nullable = false) => col(`varchar(${n})`, nullable);
const a = (n = 255, nullable = false) => col(`varchar(${n})`, nullable, null, true);
const h = (n = 71, nullable = false) => col(`char(${n})`, nullable, null, true);
const d = (nullable = false) => col("datetime(3)", nullable);
const i = (nullable = false, defaultValue = null) => col("int", nullable, defaultValue);
const b = (nullable = false, defaultValue = null) => col("bigint", nullable, defaultValue);
const json = (nullable = false) => col("json", nullable);
const idx = (columns, unique = false) => ({ columns: columns.split(","), unique });
const check = (clause, atoms) => ({ clause, atoms });
const shape = (columns, indexes, checks = {}, foreignKeys = {}) =>
  ({ columns, indexes, checks, foreignKeys });
const extend = (base, columns = {}, indexes = {}, checks = {}) => shape(
  { ...base.columns, ...columns }, { ...base.indexes, ...indexes },
  { ...base.checks, ...checks }, base.foreignKeys);

// Closed descriptors mirror the repository's three schema guards and the v1
// DDL. They are data, not a parser for arbitrary CREATE/ALTER statements.
const owner = shape({
  schema_version: a(64), manifest_sha256: h(64), step_ordinal: col("smallint unsigned"),
  step_id: a(96), step_sha256: h(64), state: a(16), migration_attempt_id: h(12),
  target_server_uuid_sha256: h(64), completed_at: d()
}, { PRIMARY: idx("schema_version,step_ordinal", true),
  acquisition_desktop_outreach_schema_upgrade_step_id: idx("schema_version,step_id", true)
}, {
  acquisition_desktop_outreach_schema_upgrade_hashes: check(
    "manifest_sha256 REGEXP '^[0-9a-f]{64}$' AND step_sha256 REGEXP '^[0-9a-f]{64}$' AND target_server_uuid_sha256 REGEXP '^[0-9a-f]{64}$'",
    ["manifest_sha256 REGEXP '^[0-9a-f]{64}$'", "step_sha256 REGEXP '^[0-9a-f]{64}$'", "target_server_uuid_sha256 REGEXP '^[0-9a-f]{64}$'"]),
  acquisition_desktop_outreach_schema_upgrade_state: check("state IN ('completed','sealed')", [])
});
const enrollment = shape({
  workspace_id: v(), user_id: v(), team_id: v(), device_id_hash: h(),
  protocol_version: col("tinyint unsigned"), enrollment_token_hash: h(),
  idempotency_key_hash: h(64), request_hash: h(64), expires_at: d(), consumed_at: d(true),
  registration_idempotency_key_hash: h(64, true), registration_request_hash: h(64, true),
  created_at: d()
}, { PRIMARY: idx("workspace_id,idempotency_key_hash", true),
  acquisition_desktop_enrollment_token: idx("enrollment_token_hash", true),
  acquisition_desktop_enrollment_workspace_device: idx("workspace_id,device_id_hash"),
  acquisition_desktop_enrollment_expiry: idx("expires_at")
}, { acquisition_desktop_enrollment_protocol: check("protocol_version=1", []) });
const installation = shape({
  workspace_id: v(), user_id: v(), team_id: v(), device_id_hash: h(), device_credential_hash: h(),
  protocol_version: col("tinyint unsigned"), state: a(16), created_at: d(), updated_at: d(), revoked_at: d(true)
}, { PRIMARY: idx("workspace_id,device_id_hash", true),
  acquisition_desktop_installation_workspace_credential: idx("workspace_id,device_credential_hash", true),
  acquisition_desktop_installation_state: idx("workspace_id,state"),
  acquisition_desktop_installation_device_credential: idx("device_id_hash,device_credential_hash,protocol_version,state")
}, { acquisition_desktop_installation_protocol: check("protocol_version=1", []),
  acquisition_desktop_installation_state_check: check("state IN ('active','revoked')", []) });
const socialLegacy = shape({
  id: v(), workspace_id: v(), platform: v(32), account_handle: v(512, true), upstream_session_id: v(512, true),
  display_name: v(512, true), state: v(32), login_state_version: b(true),
  login_state_version_high_water: col("bigint unsigned", false, "0"), revision: b(), etag: v(64),
  last_validated_at: v(40, true), created_at: v(40), updated_at: v(40)
}, { PRIMARY: idx("id", true), acquisition_social_accounts_workspace_platform: idx("workspace_id,platform", true) });
const socialStage = extend(socialLegacy, {
  executor_mode: a(16, true), executor_device_id_hash: h(71, true),
  executor_binding_generation: col("bigint unsigned", false, "0"), executor_lease_expires_at: v(40, true)
});
const socialAtoms = ["executor_mode IS NULL", "executor_mode='server'", "executor_device_id_hash IS NULL",
  "executor_binding_generation=0", "executor_lease_expires_at IS NULL", "executor_mode='desktop'",
  "executor_device_id_hash IS NOT NULL", "executor_binding_generation>0", "executor_lease_expires_at IS NOT NULL"];
const socialFinal = extend(socialStage, {}, {
  acquisition_social_accounts_executor_lookup: idx("workspace_id,executor_mode,executor_device_id_hash,executor_lease_expires_at")
}, { acquisition_social_accounts_executor_binding: check(
  "((executor_mode IS NULL OR executor_mode='server') AND executor_device_id_hash IS NULL AND executor_binding_generation=0 AND executor_lease_expires_at IS NULL) OR (executor_mode='desktop' AND executor_device_id_hash IS NOT NULL AND executor_binding_generation>0 AND executor_lease_expires_at IS NOT NULL)", socialAtoms) });
const openings = shape({ workspace_id: v(), session_id: v(255, true), lease_owner: v(128, true),
  lease_expires_at: v(40, true), fencing_token: col("bigint unsigned", false, "0"), updated_at: v(40)
}, { PRIMARY: idx("workspace_id", true) });
const batches = shape({ id: a(), workspace_id: a(), run_id: a(160), revision: i(), state: v(40),
  account_id: v(), local_date: col("date"), daily_candidate_limit: i(), etag: v(),
  batch_hash: col("char(71)"), payload_json: json(), created_at: d()
}, { PRIMARY: idx("id,revision", true),
  uk_acquisition_outreach_batch_revision: idx("workspace_id,id,revision", true),
  ix_acquisition_outreach_batch_head: idx("workspace_id,id,revision"),
  ix_acquisition_outreach_batch_run_page: idx("workspace_id,run_id,created_at,id,revision") });
const actionsLegacy = shape({
  id: a(), workspace_id: a(), batch_id: a(), batch_revision: i(), candidate_id: a(), account_id: a(),
  local_date: col("date"), kind: a(40), sequence: i(), status: v(40), predecessor_action_id: v(255, true),
  target_public_url: v(2000), content_text: col("text"), content_hash: col("char(71)"), approval_hash: col("char(71)"),
  authorization_version: col("tinyint", true), approved_by: v(255, true), approved_at: d(true),
  direct_message_daily_limit: i(true), direct_message_daily_ordinal: i(true), payload_json: json(),
  created_at: d(), attempt_count: i(false, "0"), lease_owner: v(255, true), lease_token: h(64, true),
  fencing_token: b(false, "0"), lease_expires_at: d(true), claimed_at: d(true),
  platform_receipt_reference: v(255, true), occurred_at: d(true), failure_code: a(80, true)
}, { PRIMARY: idx("id", true),
  uk_acquisition_outreach_action_sequence: idx("batch_id,batch_revision,candidate_id,sequence", true),
  uk_acquisition_outreach_daily_candidate: idx("workspace_id,account_id,local_date,candidate_id,kind", true),
  uk_acquisition_outreach_direct_message_ordinal: idx("workspace_id,account_id,local_date,kind,direct_message_daily_ordinal", true),
  ix_acquisition_outreach_action_claim: idx("status,created_at,id")
}, {}, { fk_acquisition_outreach_action_batch: { columns: ["batch_id", "batch_revision"],
  table: "acquisition_outreach_batches", referencedColumns: ["id", "revision"] } });
const actionsStage = extend(actionsLegacy, {
  execution_target: a(16, true), platform_write_attempt_count: i(true),
  desktop_device_id_hash: h(71, true), desktop_process_instance_id_hash: h(71, true),
  desktop_executor_binding_generation: b(true), desktop_task_request_hash: h(64, true),
  desktop_task_token_hash: h(71, true), desktop_action_deadline_at: d(true)
});
const actionsFinal = extend(actionsStage, {
  execution_target: col("varchar(16)", false, "server", true), platform_write_attempt_count: i(false, "0")
}, { ix_acquisition_outreach_action_desktop_claim: idx("execution_target,status,created_at,id")
}, { acquisition_outreach_action_execution_target: check("execution_target IN ('server','desktop')", []) });
const accounts = shape({ workspace_id: a(), account_id: a(), next_eligible_at: d(true),
  consecutive_failures: i(false, "0"), risk_paused: col("tinyint(1)", false, "0"), updated_at: d()
}, { PRIMARY: idx("workspace_id,account_id", true) });
const attemptsLegacy = shape({ action_id: a(), fencing_token: b(), lease_token: h(64), worker_id: a(),
  claimed_at: d(), lease_expires_at: d(), completed_at: d(true), outcome: a(40, true),
  failure_code: a(80, true), platform_receipt_reference: v(255, true)
}, { uk_acquisition_outreach_action_attempt_fence: idx("action_id,fencing_token", true)
}, {}, { fk_acquisition_outreach_action_attempt: { columns: ["action_id"],
  table: "acquisition_outreach_actions", referencedColumns: ["id"] } });
const attemptsStage = extend(attemptsLegacy, {
  execution_target: a(16, true), device_id_hash: h(71, true), process_instance_id_hash: h(71, true),
  executor_binding_generation: b(true), task_request_hash: h(64, true), task_token_hash: h(71, true),
  account_handle: h(71, true), predecessor_receipt: v(255, true), action_deadline_at: d(true),
  platform_write_attempt_count: i(true), started_at: d(true), started_request_hash: h(64, true),
  started_response_json: json(true), receipt_hash: h(64, true), receipt_request_hash: h(64, true),
  receipt_json: json(true), receipt_response_json: json(true), reconciliation_generation: b(true),
  recovery_process_instance_id_hash: h(71, true), recovery_task_token_hash: h(71, true), recovery_lease_expires_at: d(true)
});
const attemptsFinal = extend(attemptsStage, { execution_target: col("varchar(16)", false, "server", true),
  platform_write_attempt_count: i(false, "0"), reconciliation_generation: b(false, "0") });
const claims = shape({ workspace_id: a(), device_id_hash: h(), idempotency_key_hash: h(64),
  claim_request_hash: h(64), response_kind: a(16), action_id: a(255, true), server_time: d(), retry_after_ms: i(true), created_at: d()
}, { PRIMARY: idx("workspace_id,idempotency_key_hash", true) }, {
  acquisition_desktop_outreach_claim_replay_kind: check(
    "(response_kind='pending' AND action_id IS NULL AND retry_after_ms IS NULL) OR (response_kind='claimed' AND action_id IS NOT NULL AND retry_after_ms IS NULL) OR (response_kind='empty' AND action_id IS NULL AND retry_after_ms BETWEEN 3000 AND 5000)",
    ["response_kind='pending'", "action_id IS NULL", "retry_after_ms IS NULL", "response_kind='claimed'", "action_id IS NOT NULL", "response_kind='empty'", "retry_after_ms BETWEEN 3000 AND 5000"])
});
const completions = shape({ workspace_id: a(), operation_name: a(32), idempotency_key_hash: h(64),
  request_hash: h(64), action_id: a(), fencing_token: b(), response_json: json(true), created_at: d()
}, { PRIMARY: idx("workspace_id,operation_name,idempotency_key_hash", true) }, {
  acquisition_desktop_outreach_completion_replay_operation: check("operation_name IN ('started','receipt','reconciliation_receipt')", [])
});
const recoveryReplays = shape({ workspace_id: a(), idempotency_key_hash: h(64), request_hash: h(64),
  action_id: a(), original_fencing_token: b(), response_kind: a(16), response_json: json(true), created_at: d()
}, { PRIMARY: idx("workspace_id,idempotency_key_hash", true) }, {
  acquisition_desktop_outreach_recovery_replay_kind: check(
    "(response_kind='pending' AND response_json IS NULL) OR (response_kind IN ('waiting','released','terminal','reconcile') AND response_json IS NOT NULL)",
    ["response_kind='pending'", "response_json IS NULL", "response_kind IN ('waiting','released','terminal','reconcile')", "response_json IS NOT NULL"])
});
const human = shape({ workspace_id: a(), operation_name: a(48), idempotency_key_hash: h(64), request_hash: h(),
  batch_id: a(), action_id: a(), batch_revision: i(), approval_hash: h(), content_hash: h(),
  requested_by_user_id: a(), requested_at: d(), expected_execution_lease_version: b(), response_json: json(), created_at: d()
}, { PRIMARY: idx("workspace_id,operation_name,idempotency_key_hash", true),
  ix_acquisition_desktop_outreach_human_reconciliation_action: idx("workspace_id,batch_id,action_id,requested_at")
}, { acquisition_desktop_outreach_human_reconciliation_operation: check("operation_name='request_desktop_action_reconciliation'", []) });
const recoveries = shape({ workspace_id: a(), batch_id: a(), account_id: a(), account_login_state_version: i(),
  idempotency_key_hash: h(64), request_hash: col("char(71)"), actor_id: a(), reason_text: col("text"),
  enabled_action_ids_json: json(), acknowledged_uncertain_action_ids_json: json(), recovered_at: d()
}, { PRIMARY: idx("workspace_id,batch_id,idempotency_key_hash", true),
  ix_acquisition_outreach_account_recovery: idx("workspace_id,account_id,recovered_at") });

const freeze = (value) => {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};
export const DESKTOP_OUTREACH_INSPECTION_SHAPES = freeze({
  owner, enrollment, installation, socialLegacy, socialStage, socialFinal, openings,
  batches, actionsLegacy, actionsStage, actionsFinal, accounts,
  attemptsLegacy, attemptsStage, attemptsFinal, claims, completions, recoveryReplays, human, recoveries
});

const createSteps = new Map([
  [10, [OWNER, owner]], [20, ["acquisition_desktop_installation_enrollments", enrollment]],
  [30, ["acquisition_desktop_installations", installation]], [70, ["acquisition_social_account_login_openings", openings]],
  [140, ["acquisition_desktop_outreach_claim_replays", claims]], [150, ["acquisition_desktop_outreach_completion_replays", completions]],
  [160, ["acquisition_desktop_outreach_recovery_replays", recoveryReplays]], [170, ["acquisition_desktop_outreach_human_reconciliations", human]],
  [180, ["acquisition_outreach_account_recoveries", recoveries]]
]);

function canonicalCreatedRows(table, ordinal) {
  const hex = (name, prefixed = false) => `${name} REGEXP '^${prefixed ? "sha256:" : ""}[0-9a-f]{64}$'`;
  const tenant = (userColumn) => `EXISTS (SELECT 1 FROM users u WHERE u.team_id=${table}.workspace_id${
    userColumn ? ` AND u.id=${table}.${userColumn}` : ""})`;
  const fixed = {
    10: "TRUE",
    20: `${tenant("user_id")} AND workspace_id=team_id AND protocol_version=1
      AND ${hex("device_id_hash", true)} AND ${hex("enrollment_token_hash", true)}
      AND ${hex("idempotency_key_hash")} AND ${hex("request_hash")}
      AND expires_at>created_at AND (consumed_at IS NULL OR consumed_at>=created_at)
      AND ((registration_idempotency_key_hash IS NULL AND registration_request_hash IS NULL)
        OR (consumed_at IS NOT NULL AND ${hex("registration_idempotency_key_hash")} AND ${hex("registration_request_hash")}))`,
    30: `${tenant("user_id")} AND workspace_id=team_id AND protocol_version=1
      AND ${hex("device_id_hash", true)} AND ${hex("device_credential_hash", true)}
      AND ((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
      AND updated_at>=created_at`,
    70: `${tenant()} AND fencing_token>=0
      AND ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))`,
    170: `${tenant("requested_by_user_id")} AND ${hex("idempotency_key_hash")}
      AND ${hex("request_hash", true)} AND ${hex("approval_hash", true)} AND ${hex("content_hash", true)}
      AND operation_name='request_desktop_action_reconciliation' AND expected_execution_lease_version>=0
      AND EXISTS (SELECT 1 FROM acquisition_outreach_actions a WHERE a.id=${table}.action_id
        AND a.workspace_id=${table}.workspace_id AND a.batch_id=${table}.batch_id
        AND a.batch_revision=${table}.batch_revision)`,
    180: `${tenant("actor_id")} AND ${hex("idempotency_key_hash")} AND ${hex("request_hash", true)}
      AND account_login_state_version>0 AND JSON_TYPE(enabled_action_ids_json)='ARRAY'
      AND JSON_TYPE(acknowledged_uncertain_action_ids_json)='ARRAY'
      AND EXISTS (SELECT 1 FROM acquisition_outreach_batches b WHERE b.id=${table}.batch_id
        AND b.workspace_id=${table}.workspace_id AND b.account_id=${table}.account_id)`
  };
  return fixed[ordinal] ?? "TRUE";
}


const socialStageValid = "executor_mode IS NULL AND executor_device_id_hash IS NULL AND executor_binding_generation=0 AND executor_lease_expires_at IS NULL";
const socialFinalValid = "((executor_mode IS NULL OR executor_mode='server') AND executor_device_id_hash IS NULL AND executor_binding_generation=0 AND executor_lease_expires_at IS NULL) OR (executor_mode='desktop' AND executor_device_id_hash REGEXP '^sha256:[0-9a-f]{64}$' AND executor_binding_generation>0 AND executor_lease_expires_at IS NOT NULL)";
const actionStageInvalid = "(execution_target IS NOT NULL AND execution_target<>'server') OR (platform_write_attempt_count IS NOT NULL AND platform_write_attempt_count<>0)";
const actionFinalInvalid = "(execution_target IS NOT NULL AND execution_target NOT IN ('server','desktop')) OR platform_write_attempt_count<0";
const actionPending = "execution_target IS NULL OR platform_write_attempt_count IS NULL";

export const DESKTOP_OUTREACH_DATA_PREDICATES = freeze({
  created: Object.fromEntries([...createSteps].map(([ordinal, [table]]) => [ordinal, {
    table, invalid: `NOT COALESCE((${canonicalCreatedRows(table, ordinal)}),FALSE)`, pending: "FALSE"
  }])),
  social: { stageInvalid: `NOT COALESCE((${socialStageValid}),FALSE)`,
    finalInvalid: `NOT COALESCE((${socialFinalValid}),FALSE)`, pending: "FALSE" },
  actions: { stageInvalid: actionStageInvalid, finalInvalid: actionFinalInvalid, pending: actionPending },
  attempts: { stageInvalid: `${actionStageInvalid} OR (reconciliation_generation IS NOT NULL AND reconciliation_generation<>0)`,
    finalInvalid: `${actionFinalInvalid} OR reconciliation_generation<0`,
    pending: `${actionPending} OR reconciliation_generation IS NULL` }
});
export const DESKTOP_OUTREACH_SCHEMA_CREATED_TABLES = freeze([...createSteps]);
export const DESKTOP_OUTREACH_SCHEMA_PROJECTION = freeze({
  metadataPolicy: {
    engine: "InnoDB", tableType: "BASE TABLE", inheritedText: "database-default-charset-and-collation",
    columns: "exact-name-type-nullability-default-charset-collation-no-generated-or-extra",
    indexes: "exact-name-ordered-columns-unique-visible-ascending-BTREE-no-prefix-or-expression",
    checks: "exact-known-predicates-enforced-case-sensitive-literals-boolean-grouping-preserved",
    foreignKeys: "exact-same-database-column-order-RESTRICT-or-NO-ACTION",
    canonicalRows: "table-specific-zero-invalid-count-and-required-preservation-proof",
    replayTables: "empty",
    backfill: "nullable-stage-only-null-or-server-zero; final-preserves-existing-canonical-values"
  },
  tables: DESKTOP_OUTREACH_INSPECTION_SHAPES,
  predicates: DESKTOP_OUTREACH_DATA_PREDICATES
});
export const DESKTOP_OUTREACH_SCHEMA_PROJECTION_SHA256 = createHash("sha256")
  .update("shensi.desktop-outreach-schema-projection/v1\0", "utf8")
  .update(JSON.stringify(DESKTOP_OUTREACH_SCHEMA_PROJECTION), "utf8").digest("hex");
