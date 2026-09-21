const PHASES = new Set(["authority", "connect", "create_database", "social_schema",
  "installation_schema", "outreach_schema", "seed", "assertions", "cleanup"]);
const CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND",
  "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR",
  "ER_PARSE_ERROR", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_FIELDNAME",
  "ER_DUP_ENTRY", "ER_CANT_CREATE_TABLE", "ER_FK_DUP_NAME", "ER_CHECK_CONSTRAINT_VIOLATED",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ERR_ASSERTION", "unknown",
  "SCHEMA_COLUMN_INVALID", "SCHEMA_GROUP_INVALID", "SCHEMA_INDEX_INVALID",
  "SCHEMA_CHECK_INVALID", "SCHEMA_ENGINE_INVALID", "SCHEMA_MIGRATION_REQUIRED"]);
const SUITES = new Set(["installation", "binding", "actions", "all", "bridge-mysql", "outreach-schema"]);
const PROCESS_CODES = new Set(["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]);
// Static schema identifiers, never database names or row values. These are the
// objects checked by ensureAcquisitionOutreachBatchMysqlSchema.
const TABLES = new Set(["batches", "batch_candidates", "batch_command_replays", "actions",
  "action_accounts", "action_attempts", "account_recoveries"].map((name) => `acquisition_outreach_${name}`)
  .concat(["claim_replays", "completion_replays", "recovery_replays", "human_reconciliations"]
    .map((name) => `acquisition_desktop_outreach_${name}`)));
const GROUPS = new Set(["base", "authorization", "desktop", "evidence", "recovery", "dependency"]);
const COLUMNS = new Set(`target_public_url attempt_count lease_owner lease_token fencing_token
  lease_expires_at claimed_at platform_receipt_reference occurred_at failure_code authorization_version
  approved_by approved_at direct_message_daily_limit direct_message_daily_ordinal execution_target
  platform_write_attempt_count desktop_device_id_hash desktop_process_instance_id_hash
  desktop_executor_binding_generation desktop_task_request_hash desktop_task_token_hash desktop_action_deadline_at
  action_id worker_id completed_at outcome device_id_hash process_instance_id_hash executor_binding_generation
  task_request_hash task_token_hash account_handle predecessor_receipt action_deadline_at started_at
  started_request_hash started_response_json receipt_hash receipt_request_hash receipt_json receipt_response_json
  reconciliation_generation recovery_process_instance_id_hash recovery_task_token_hash recovery_lease_expires_at
  workspace_id idempotency_key_hash claim_request_hash response_kind server_time retry_after_ms created_at
  operation_name request_hash response_json original_fencing_token batch_id batch_revision approval_hash
  content_hash requested_by_user_id requested_at expected_execution_lease_version`.trim().split(/\s+/u));
const INDEXES = new Set(["PRIMARY", "ix_acquisition_outreach_batch_run_page", "ix_acquisition_outreach_candidate_page",
  "ix_acquisition_outreach_action_claim", "ix_acquisition_outreach_action_desktop_claim",
  "uk_acquisition_outreach_direct_message_ordinal", "uk_acquisition_outreach_action_attempt_fence",
  "ix_acquisition_desktop_outreach_human_reconciliation_action"]);
const CHECKS = new Set(["acquisition_outreach_action_execution_target",
  "acquisition_desktop_outreach_claim_replay_kind", "acquisition_desktop_outreach_completion_replay_operation",
  "acquisition_desktop_outreach_recovery_replay_kind", "acquisition_desktop_outreach_human_reconciliation_operation"]);
// Diagnostic expectations mirror the five fixed preflight predicates, not row
// data. Only comparisons against these values leave the test child.
const CHECK_EXPECTATIONS = [
  ["acquisition_outreach_actions", "acquisition_outreach_action_execution_target",
    "execution_targetin'server','desktop'"],
  ["acquisition_desktop_outreach_claim_replays", "acquisition_desktop_outreach_claim_replay_kind",
    "response_kind='pending'andaction_idisnullandretry_after_msisnullorresponse_kind='claimed'andaction_idisnotnullandretry_after_msisnullorresponse_kind='empty'andaction_idisnullandretry_after_msbetween3000and5000"],
  ["acquisition_desktop_outreach_completion_replays", "acquisition_desktop_outreach_completion_replay_operation",
    "operation_namein'started','receipt','reconciliation_receipt'"],
  ["acquisition_desktop_outreach_recovery_replays", "acquisition_desktop_outreach_recovery_replay_kind",
    "response_kind='pending'andresponse_jsonisnullorresponse_kindin'waiting','released','terminal','reconcile'andresponse_jsonisnotnull"],
  ["acquisition_desktop_outreach_human_reconciliations", "acquisition_desktop_outreach_human_reconciliation_operation",
    "operation_name='request_desktop_action_reconciliation'"]
];
const safeCode = (code) => CODES.has(code) || /^MYSQL_ERRNO_[1-9][0-9]{3}$/u.test(code ?? "");
const safeStatement = (value) => Number.isInteger(value) && value >= 1 && value <= 512;

export function mysqlCheckMetadataDiagnostic(rows) {
  const normalize = (text) => text.toLowerCase()
    .replace(/_[a-z0-9]+(?='[^']*')/gu, "").replace(/[`()\s]/gu, "");
  return CHECK_EXPECTATIONS.map(([table, name, expected]) => {
    const matches = Array.isArray(rows) ? rows.filter((row) => row?.table_name === table
      && row?.constraint_name === name) : [];
    const row = matches.length === 1 ? matches[0] : undefined;
    const clause = row ? String(row.check_clause ?? "") : "";
    return { object: `${table}:${name}`, count: matches.length === 0 ? "none"
      : matches.length === 1 ? "one" : "multiple",
    enforced: ["YES", "NO"].includes(row?.enforced) ? row.enforced : "unknown",
    escapedQuotes: clause.includes("\\'"), plainMatches: normalize(clause) === expected,
    unescapedMatches: normalize(clause.replace(/\\'/gu, "'")) === expected };
  });
}

function parseCheckMetadata(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value) || value.length !== CHECK_EXPECTATIONS.length) return null;
  const keys = ["object", "count", "enforced", "escapedQuotes", "plainMatches", "unescapedMatches"];
  if (!value.every((item, index) => item && !Array.isArray(item)
    && Object.keys(item).length === keys.length && keys.every((key) => Object.hasOwn(item, key))
    && item.object === CHECK_EXPECTATIONS[index].slice(0, 2).join(":")
    && ["none", "one", "multiple"].includes(item.count)
    && ["YES", "NO", "unknown"].includes(item.enforced)
    && ["escapedQuotes", "plainMatches", "unescapedMatches"].every((key) => typeof item[key] === "boolean"))) return null;
  return value;
}

function safeSchemaObject(code, object) {
  if (typeof object !== "string") return false;
  const [table, ...parts] = object.split(":");
  if (!TABLES.has(table)) return false;
  if (code === "SCHEMA_ENGINE_INVALID") return parts.length === 0;
  if (code === "SCHEMA_GROUP_INVALID") return parts.length <= 1 && (!parts.length || GROUPS.has(parts[0]));
  if (code === "SCHEMA_COLUMN_INVALID") return (parts.length === 1 && COLUMNS.has(parts[0]))
    || (parts.length === 2 && GROUPS.has(parts[0]) && COLUMNS.has(parts[1]));
  if (code === "SCHEMA_INDEX_INVALID") return parts.length === 1 && INDEXES.has(parts[0]);
  if (code === "SCHEMA_CHECK_INVALID") return parts.length === 1 && CHECKS.has(parts[0]);
  return false;
}

function parsePhaseMessage(message) {
  const match = typeof message === "string" && message.match(
    /^DESKTOP_ACTION_MYSQL_PHASE:([a-z_]+):([A-Za-z_0-9]+)(?::([A-Za-z_0-9:]+))?(?:@([0-9]+))?$/u);
  if (!match || !PHASES.has(match[1]) || !safeCode(match[2])
    || (match[3] && !safeSchemaObject(match[2], match[3]))
    || (match[4] && !safeStatement(Number(match[4])))) return null;
  return { phase: match[1], code: match[2], ...(match[3] ? { object: match[3] } : {}),
    ...(match[4] ? { statement: Number(match[4]) } : {}) };
}

// Shared by the disposable test fixture and its parent runner. Never retain
// driver messages, SQL, assertion payloads or raw errors in this projection.
export function mysqlTestPhaseFailure(phase, caught, context = {}) {
  const safePhase = PHASES.has(phase) ? phase : "unknown";
  let code = CODES.has(caught?.code) ? caught.code : "unknown";
  let object;
  if (code === "unknown" && Number.isInteger(caught?.errno) && caught.errno >= 1000 && caught.errno <= 9999) {
    code = `MYSQL_ERRNO_${caught.errno}`;
  }
  if (safePhase === "outreach_schema") {
    const schema = typeof caught?.message === "string" && caught.message.match(
      /^acquisition_outreach_schema_(column|group|index|check|engine)_invalid:([A-Za-z_0-9:]+)$/u);
    if (schema) {
      const category = `SCHEMA_${schema[1].toUpperCase()}_INVALID`;
      if (safeSchemaObject(category, schema[2])) { code = category; object = schema[2]; }
    } else if (caught?.message === "outreach_action_target_migration_required") code = "SCHEMA_MIGRATION_REQUIRED";
  }
  return new Error(`DESKTOP_ACTION_MYSQL_PHASE:${safePhase}:${code}${object ? `:${object}` : ""}`
    + (safeStatement(context.statement) ? `@${context.statement}` : ""));
}

export function summarizeMysqlTestFailure(suite, caught) {
  const text = [caught?.stdout, caught?.stderr].filter((value) => typeof value === "string")
    .map((value) => value.slice(0, 2 * 1024 * 1024)).join("\n");
  const failures = [];
  const failedTests = [];
  let checks;
  const add = (failure) => {
    if (failures.length < 20 && !failures.some((item) => JSON.stringify(item) === JSON.stringify(failure))) {
      failures.push(failure);
    }
  };
  for (const line of text.split(/\r?\n/u)) {
    const metadata = line.match(/^(?:# )?DESKTOP_ACTION_MYSQL_CHECKS (.{1,4096})$/u);
    if (metadata && suite === "outreach-schema") checks ??= parseCheckMetadata(metadata[1]) ?? undefined;
    const phase = line.match(/^\s*(?:# )?(?:error: ['"]?)?(DESKTOP_ACTION_MYSQL_PHASE:[A-Za-z_0-9:@]+)['"]?\s*$/u);
    const parsed = phase && parsePhaseMessage(phase[1]);
    if (parsed) add(parsed);
    if (/^\s*error: ['"]?DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID['"]?\s*$/u.test(line)) {
      add({ phase: "authority", code: "DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID" });
    }
    if (/^\s*code: ['"]?ERR_ASSERTION['"]?\s*$/u.test(line)) add({ phase: "assertions", code: "ERR_ASSERTION" });
  }
  // Only top-level TAP records on stdout are test identifiers. Indented YAML
  // assertion values and arbitrary stderr text are not test metadata.
  const stdout = typeof caught?.stdout === "string" ? caught.stdout.slice(0, 2 * 1024 * 1024) : "";
  for (const line of stdout.split(/\r?\n/u)) {
    const failedTest = line.match(/^not ok ([1-9][0-9]{0,5}) - /u);
    if (failedTest && failedTests.length < 20 && !failedTests.includes(Number(failedTest[1]))) {
      failedTests.push(Number(failedTest[1]));
    }
  }
  return Object.freeze({ suite: SUITES.has(suite) ? suite : "unknown",
    exitCode: Number.isSafeInteger(caught?.code) && caught.code >= 0 && caught.code <= 255 ? caught.code : null,
    signal: SIGNALS.has(caught?.signal) ? caught.signal : null,
    processCode: PROCESS_CODES.has(caught?.code) ? caught.code : null,
    failures, failedTests, ...(checks ? { checks } : {}) });
}
