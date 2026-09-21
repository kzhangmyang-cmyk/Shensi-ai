import { createHash } from "node:crypto";

const VERSION = 1;
const PAGE_SIZE = 1000;
const FAILURE = "DESKTOP_OUTREACH_PRESERVATION_FAILED";
const fail = () => new Error(FAILURE);

function definition(table, columns, order, index = "PRIMARY") {
  return Object.freeze({ table, columns: Object.freeze(columns.split(" ")),
    order: Object.freeze(order.split(" ")), index });
}

// The complete existing columns of desktop-outreach-legacy-schema.v1.sql.
// New bridge fields deliberately do not enter the legacy preservation digest.
export const DESKTOP_OUTREACH_PRESERVATION_TABLES = Object.freeze([
  definition("users", "id name email password_hash role team_id status auth_version created_at", "id"),
  definition("acquisition_social_accounts", "id workspace_id platform account_handle upstream_session_id display_name state login_state_version login_state_version_high_water revision etag last_validated_at created_at updated_at", "id"),
  definition("acquisition_outreach_batches", "id workspace_id run_id revision state account_id local_date daily_candidate_limit etag batch_hash payload_json created_at", "id revision"),
  definition("acquisition_outreach_actions", "id workspace_id batch_id batch_revision candidate_id account_id local_date kind sequence status predecessor_action_id target_public_url content_text content_hash approval_hash authorization_version approved_by approved_at direct_message_daily_limit direct_message_daily_ordinal payload_json created_at attempt_count lease_owner lease_token fencing_token lease_expires_at claimed_at platform_receipt_reference occurred_at failure_code", "id"),
  definition("acquisition_outreach_action_accounts", "workspace_id account_id next_eligible_at consecutive_failures risk_paused updated_at", "workspace_id account_id"),
  // This legacy table has no PRIMARY KEY; its complete non-null unique key is
  // the stable row identity, including every attempt for one action.
  definition("acquisition_outreach_action_attempts", "action_id fencing_token lease_token worker_id claimed_at lease_expires_at completed_at outcome failure_code platform_receipt_reference", "action_id fencing_token", "uk_acquisition_outreach_action_attempt_fence")
]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function frame(hash, value) {
  if (value === null) { hash.update(Buffer.from([0])); return; }
  if (!Buffer.isBuffer(value)) throw fail();
  const header = Buffer.alloc(9);
  header[0] = 1;
  header.writeBigUInt64BE(BigInt(value.length), 1);
  hash.update(header).update(value);
}

function projection({ table, columns }) {
  return columns.map((column) => {
    // users.created_at is TIMESTAMP. Hash its stored instant independently of
    // session time_zone; all legacy DATETIME and string fields retain their bytes.
    const expression = table === "users" && column === "created_at"
      ? "UNIX_TIMESTAMP(`created_at`)" : `\`${column}\``;
    return `CAST(${expression} AS BINARY) AS \`${column}\``;
  }).join(", ");
}

async function assertTables(read) {
  const names = DESKTOP_OUTREACH_PRESERVATION_TABLES.map(({ table }) => table);
  const rows = await read.query(`SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(", ")})`, names);
  if (!Array.isArray(rows) || rows.length !== names.length) throw fail();
  const seen = new Set();
  for (const row of rows) {
    if (!exactKeys(row, ["tableName", "tableType"]) || !names.includes(row.tableName)
      || seen.has(row.tableName) || row.tableType !== "BASE TABLE") throw fail();
    seen.add(row.tableName);
  }
}

async function assertColumnsAndOrder(read, definition) {
  const rows = await read.query(`SELECT COLUMN_NAME AS columnName, IS_NULLABLE AS nullable
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [definition.table]);
  if (!Array.isArray(rows)) throw fail();
  const columns = new Map();
  for (const row of rows) {
    if (!exactKeys(row, ["columnName", "nullable"]) || typeof row.columnName !== "string"
      || !["YES", "NO"].includes(row.nullable) || columns.has(row.columnName)) throw fail();
    columns.set(row.columnName, row.nullable);
  }
  if (definition.columns.some((column) => !columns.has(column))
    || definition.order.some((column) => columns.get(column) !== "NO")) throw fail();
  const key = await read.query(`SELECT COLUMN_NAME AS columnName, SEQ_IN_INDEX AS sequence,
      NON_UNIQUE AS nonUnique, SUB_PART AS prefixLength
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
    ORDER BY SEQ_IN_INDEX`, [definition.table, definition.index]);
  if (!Array.isArray(key) || key.length !== definition.order.length
    || key.some((row, index) => !exactKeys(row, ["columnName", "sequence", "nonUnique", "prefixLength"])
      || row.columnName !== definition.order[index] || Number(row.sequence) !== index + 1
      || Number(row.nonUnique) !== 0 || row.prefixLength !== null)) throw fail();
}

/**
 * Read-only capture on an already-owned, writer-free migration target.
 * read.query(sql, values) returns rows, as provided by the schema MySQL adapter.
 * No connection, environment, transaction, logging, or persistence is owned here.
 */
export async function captureDesktopOutreachPreservation(read) {
  try {
    if (!read || typeof read.query !== "function") throw fail();
    await assertTables(read);
    const tables = [];
    for (const definition of DESKTOP_OUTREACH_PRESERVATION_TABLES) {
      await assertColumnsAndOrder(read, definition);
      const hash = createHash("sha256");
      frame(hash, Buffer.from("shensi-desktop-outreach-legacy-preservation-v1"));
      frame(hash, Buffer.from(definition.table));
      for (const column of definition.columns) frame(hash, Buffer.from(column));
      let rowCount = 0;
      for (;;) {
        const rows = await read.query(`SELECT ${projection(definition)}
          FROM \`${definition.table}\`
          ORDER BY ${definition.order.map((column) => `\`${column}\` ASC`).join(", ")}
          LIMIT ? OFFSET ?`, [PAGE_SIZE, rowCount]);
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw fail();
        for (const row of rows) {
          if (!exactKeys(row, definition.columns)
            || definition.order.some((column) => row[column] === null)) throw fail();
          hash.update(Buffer.from([0x52]));
          for (const column of definition.columns) frame(hash, row[column]);
          rowCount += 1;
          if (!Number.isSafeInteger(rowCount)) throw fail();
        }
        if (rows.length < PAGE_SIZE) break;
      }
      tables.push(Object.freeze({ table: definition.table,
        columns: definition.columns, rowCount, sha256: hash.digest("hex") }));
    }
    return Object.freeze({ version: VERSION, tables: Object.freeze(tables) });
  } catch {
    // Driver errors may contain SQL, row contents, URLs or credentials.
    throw fail();
  }
}

function validatedSnapshot(snapshot) {
  if (!exactKeys(snapshot, ["version", "tables"]) || snapshot.version !== VERSION
    || !Array.isArray(snapshot.tables)
    || snapshot.tables.length !== DESKTOP_OUTREACH_PRESERVATION_TABLES.length) throw fail();
  const tables = new Map();
  for (const row of snapshot.tables) {
    if (!exactKeys(row, ["table", "columns", "rowCount", "sha256"])) throw fail();
    const definition = DESKTOP_OUTREACH_PRESERVATION_TABLES.find(({ table }) => table === row.table);
    if (!definition || tables.has(row.table) || !Array.isArray(row.columns)
      || row.columns.length !== definition.columns.length
      || row.columns.some((column, index) => column !== definition.columns[index])
      || !Number.isSafeInteger(row.rowCount) || row.rowCount < 0
      || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) throw fail();
    tables.set(row.table, row);
  }
  return tables;
}

export function compareDesktopOutreachPreservation(before, after) {
  try {
    const previous = validatedSnapshot(before);
    const current = validatedSnapshot(after);
    return DESKTOP_OUTREACH_PRESERVATION_TABLES.every(({ table }) =>
      previous.get(table).rowCount === current.get(table).rowCount
      && previous.get(table).sha256 === current.get(table).sha256);
  } catch { throw fail(); }
}
