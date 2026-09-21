import { DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE as OWNER,
  DESKTOP_OUTREACH_SCHEMA_STEPS as STEPS } from "../desktop-outreach-schema-upgrade.mjs";

import { DESKTOP_OUTREACH_INSPECTION_SHAPES, DESKTOP_OUTREACH_DATA_PREDICATES as PREDICATES,
  DESKTOP_OUTREACH_SCHEMA_CREATED_TABLES } from "./desktop-outreach-schema-projections.mjs";
export { DESKTOP_OUTREACH_INSPECTION_SHAPES } from "./desktop-outreach-schema-projections.mjs";
const { owner, socialLegacy, socialStage, socialFinal, batches, actionsLegacy, actionsStage, actionsFinal,
  accounts, attemptsLegacy, attemptsStage, attemptsFinal } = DESKTOP_OUTREACH_INSPECTION_SHAPES;
const createSteps = new Map(DESKTOP_OUTREACH_SCHEMA_CREATED_TABLES);
const error = () => new Error("DESKTOP_OUTREACH_SCHEMA_INSPECTION_FAILED");
const text = (value) => value == null ? null : String(value);
function count(value) {
  if (!/^(0|[1-9]\d*)$/u.test(String(value))) throw error();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw error();
  return number;
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// MySQL adds quoting, character-set introducers, redundant predicate wrappers
// and rewrites REGEXP to regexp_like(). Normalize only the known check atoms;
// never discard boolean grouping or lowercase quoted, case-sensitive literals.
function compactClause(value) {
  const chunks = String(value ?? "").match(/'(?:''|[^'])*'|[^']+/gu) ?? [];
  let result = chunks.map((chunk) => chunk.startsWith("'") ? chunk :
    chunk.toLowerCase().replace(/`/gu, "")).join("");
  result = result.replace(/_(?:ascii|utf8mb4)(?=')/gu, "");
  result = result.replace(/\b([a-z_][a-z_0-9]*)\s+regexp\s*('[^']*')/gu, "regexp_like($1,$2)");
  return (result.match(/'(?:''|[^'])*'|[^']+/gu) ?? [])
    .map((chunk) => chunk.startsWith("'") ? chunk : chunk.replace(/\s/gu, "")).join("");
}
function stripOuter(value) {
  for (;;) {
    if (!value.startsWith("(") || !value.endsWith(")")) return value;
    let depth = 0; let quoted = false; let wraps = true;
    for (let index = 0; index < value.length; index++) {
      if (value[index] === "'") { quoted = !quoted; continue; }
      if (quoted) continue;
      if (value[index] === "(") depth++;
      if (value[index] === ")" && --depth === 0 && index < value.length - 1) { wraps = false; break; }
    }
    if (!wraps || depth !== 0) return value;
    value = value.slice(1, -1);
  }
}
function checkMatches(actual, definition) {
  const normalize = (clause) => {
    let value = compactClause(clause);
    for (;;) {
      const before = value;
      for (const atom of definition.atoms) {
        const pattern = `(${compactClause(atom)})`;
        value = value.split(pattern).join(compactClause(atom));
      }
      value = stripOuter(value);
      if (before === value) return value;
    }
  };
  return normalize(actual) === normalize(definition.clause);
}

async function metadata(read, table) {
  const tables = await read.query(`SELECT TABLE_TYPE AS type,ENGINE AS engine,TABLE_COLLATION AS collation
    FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [table]);
  if (tables.length === 0) return null;
  const defaults = await read.query(`SELECT SCHEMA_NAME AS name,DEFAULT_CHARACTER_SET_NAME AS charset,
    DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()`);
  if (tables.length !== 1 || defaults.length !== 1 || tables[0].type !== "BASE TABLE"
    || tables[0].engine !== "InnoDB" || tables[0].collation !== defaults[0].collation) return { invalid: true };
  const columns = await read.query(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
    COLUMN_DEFAULT AS defaultValue,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,
    EXTRA AS extra,GENERATION_EXPRESSION AS generated FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [table]);
  const indexes = await read.query(`SELECT INDEX_NAME AS name,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,
    COLUMN_NAME AS columnName,SUB_PART AS subPart,INDEX_TYPE AS type,COLLATION AS ordering,
    IS_VISIBLE AS visible,EXPRESSION AS expression FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [table]);
  const constraints = await read.query(`SELECT tc.CONSTRAINT_NAME AS name,tc.CONSTRAINT_TYPE AS type,
    tc.ENFORCED AS enforced,cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
    LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
      AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME=?`, [table]);
  const keys = await read.query(`SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS columnName,k.ORDINAL_POSITION AS position,
    k.REFERENCED_TABLE_SCHEMA AS referencedSchema,k.REFERENCED_TABLE_NAME AS referencedTable,
    k.REFERENCED_COLUMN_NAME AS referencedColumn,k.POSITION_IN_UNIQUE_CONSTRAINT AS referencedPosition,
    rc.UPDATE_RULE AS updateRule,rc.DELETE_RULE AS deleteRule
    FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME=k.CONSTRAINT_NAME
      AND rc.TABLE_NAME=k.TABLE_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [table]);
  return { defaults: defaults[0], columns, indexes, constraints, keys };
}

function matches(actual, expected) {
  if (!actual || actual.invalid || actual.columns.length !== Object.keys(expected.columns).length) return false;
  const names = new Set();
  for (const row of actual.columns) {
    const definition = expected.columns[row.name];
    if (!definition || names.has(row.name)) return false;
    names.add(row.name);
    const textual = /^(?:varchar|char|text)/u.test(definition.type);
    const charset = textual ? definition.ascii ? "ascii" : actual.defaults.charset : null;
    const collation = textual ? definition.ascii ? "ascii_bin" : actual.defaults.collation : null;
    if (String(row.type).toLowerCase() !== definition.type || row.nullable !== (definition.nullable ? "YES" : "NO")
      || text(row.defaultValue) !== definition.defaultValue || text(row.charset) !== charset
      || text(row.collation) !== collation || !["", "DEFAULT_GENERATED"].includes(row.extra ?? "")
      || (row.extra === "DEFAULT_GENERATED" && definition.defaultValue === null) || (row.generated ?? "") !== "") return false;
  }
  const indexes = new Map();
  for (const row of actual.indexes) {
    const definition = expected.indexes[row.name];
    const list = indexes.get(row.name) ?? [];
    if (!definition || Number(row.position) !== list.length + 1 || Number(row.nonUnique) !== (definition.unique ? 0 : 1)
      || row.subPart != null || row.expression != null || row.type !== "BTREE" || row.visible !== "YES" || row.ordering !== "A") return false;
    list.push(row.columnName); indexes.set(row.name, list);
  }
  if (indexes.size !== Object.keys(expected.indexes).length
    || Object.entries(expected.indexes).some(([name, definition]) => !same(indexes.get(name), definition.columns))) return false;
  const expectedConstraints = { ...Object.fromEntries(Object.entries(expected.indexes).filter(([, value]) => value.unique)
    .map(([name]) => [name, name === "PRIMARY" ? "PRIMARY KEY" : "UNIQUE"])),
  ...Object.fromEntries(Object.keys(expected.checks).map((name) => [name, "CHECK"])),
  ...Object.fromEntries(Object.keys(expected.foreignKeys).map((name) => [name, "FOREIGN KEY"])) };
  const constraintNames = new Set();
  for (const row of actual.constraints) {
    if (constraintNames.has(row.name) || expectedConstraints[row.name] !== row.type) return false;
    constraintNames.add(row.name);
    if (row.type === "CHECK" && (row.enforced !== "YES" || !checkMatches(row.clause, expected.checks[row.name]))) return false;
  }
  if (constraintNames.size !== Object.keys(expectedConstraints).length) return false;
  const keyGroups = new Map();
  for (const row of actual.keys) {
    const list = keyGroups.get(row.name) ?? [];
    if (Number(row.position) !== list.length + 1) return false;
    list.push(row); keyGroups.set(row.name, list);
  }
  const keyNames = Object.keys(expectedConstraints).filter((name) => expectedConstraints[name] !== "CHECK");
  if (keyGroups.size !== keyNames.length) return false;
  for (const name of keyNames) {
    const rows = keyGroups.get(name); const fk = expected.foreignKeys[name];
    if (!rows || !same(rows.map((row) => row.columnName), (fk ?? expected.indexes[name]).columns)) return false;
    if (fk) {
      if (rows.some((row, index) => row.referencedSchema !== actual.defaults.name || row.referencedTable !== fk.table
        || row.referencedColumn !== fk.referencedColumns[index] || Number(row.referencedPosition) !== index + 1
        || !["RESTRICT", "NO ACTION"].includes(row.updateRule) || !["RESTRICT", "NO ACTION"].includes(row.deleteRule))) return false;
    } else if (rows.some((row) => row.referencedTable != null || row.referencedColumn != null)) return false;
  }
  return true;
}

async function counts(read, table, invalid = "FALSE", pending = "FALSE") {
  const rows = await read.query(`SELECT COUNT(*) AS rowCount,
    COALESCE(SUM(CASE WHEN ${invalid} THEN 1 ELSE 0 END),0) AS invalidCount,
    COALESCE(SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END),0) AS pendingCount FROM ${table}`);
  if (rows.length !== 1) throw error();
  return { rowCount: count(rows[0].rowCount), invalid: count(rows[0].invalidCount), pending: count(rows[0].pendingCount) };
}

export function createDesktopOutreachSchemaInspector({ assertPreservation } = {}) {
  if (typeof assertPreservation !== "function") throw error();
  const partial = () => ({ state: "partial", preservationOk: false, rowCount: 0 });
  const inspectOwnerTable = async (read) => {
    const actual = await metadata(read, OWNER);
    return actual === null ? "absent" : matches(actual, owner) ? "exact" : "partial";
  };
  async function inspectStep(read, supplied, context) {
    const step = STEPS.find((item) => item.ordinal === supplied?.ordinal);
    if (!step || !same(step, supplied) || !context || !same(context.acceptedAfterProjections, step.acceptedAfterProjections)
      || !Array.isArray(context.completedStepOrdinals)) throw error();
    let projection; let rowCount = 0;
    if (createSteps.has(step.ordinal)) {
      const [table, expected] = createSteps.get(step.ordinal);
      const actual = await metadata(read, table);
      if (actual === null) projection = step.beforeProjection;
      else if (!matches(actual, expected)) return partial();
      else {
        projection = step.afterProjection;
        const data = await counts(read, table, PREDICATES.created[step.ordinal].invalid);
        if (data.invalid) return partial(); rowCount = data.rowCount;
      }
    } else if ([40, 50, 60].includes(step.ordinal)) {
      const table = "acquisition_social_accounts";
      const actual = await metadata(read, table);
      if (matches(actual, socialLegacy)) projection = STEPS.find((value) => value.ordinal === 40).beforeProjection;
      else if (matches(actual, socialStage) || matches(actual, socialFinal)) {
        const final = matches(actual, socialFinal);
        const data = await counts(read, table, final ? PREDICATES.social.finalInvalid : PREDICATES.social.stageInvalid);
        if (data.invalid) return partial(); rowCount = data.rowCount;
        projection = final ? "social-executor:v1-exact" : step.ordinal === 60 ?
          "social-executor:columns-exact-index-check-absent" : "social-executor:four-staged-columns-exact";
      } else return partial();
    } else if ([80, 90, 100, 110, 120, 130].includes(step.ordinal)) {
      const attempt = step.ordinal >= 110;
      const table = attempt ? "acquisition_outreach_action_attempts" : "acquisition_outreach_actions";
      if (!matches(await metadata(read, "acquisition_outreach_batches"), batches)
        || !matches(await metadata(read, "acquisition_outreach_action_accounts"), accounts)) return partial();
      if (attempt && !matches(await metadata(read, "acquisition_outreach_actions"), actionsFinal)) return partial();
      const actual = await metadata(read, table);
      const prefix = attempt ? "outreach-attempts" : "outreach-actions";
      if (matches(actual, attempt ? attemptsLegacy : actionsLegacy)) projection = `${prefix}:desktop-columns-all-absent`;
      else if (matches(actual, attempt ? attemptsStage : actionsStage) || matches(actual, attempt ? attemptsFinal : actionsFinal)) {
        const final = matches(actual, attempt ? attemptsFinal : actionsFinal);
        const predicate = attempt ? PREDICATES.attempts : PREDICATES.actions;
        const data = await counts(read, table, final ? predicate.finalInvalid : predicate.stageInvalid, predicate.pending);
        if (data.invalid || (final && data.pending)) return partial(); rowCount = data.rowCount;
        projection = final ? `${prefix}:v1-exact` : data.pending > 0 ? `${prefix}:desktop-columns-staged-exact`
          : attempt ? "outreach-attempts:legacy-target-count-generation-populated" : "outreach-actions:legacy-target-count-populated";
      } else return partial();
    } else if (step.ordinal === 190) {
      for (const prior of STEPS.slice(0, -1)) {
        const result = await inspectStep(read, prior, { ...context, acceptedAfterProjections: prior.acceptedAfterProjections });
        if (result.state !== "after" || !result.preservationOk || ([140, 150, 160].includes(prior.ordinal) && result.rowCount !== 0)) return partial();
      }
      projection = step.afterProjection;
    } else throw error();
    const state = step.acceptedAfterProjections.includes(projection) ? "after" : projection === step.beforeProjection ? "before" : "partial";
    if (state === "partial") return partial();
    const preservationOk = await assertPreservation(read, { step, projection }) === true;
    return { state, preservationOk, rowCount };
  }
  return { inspectOwnerTable, inspectStep };
}
