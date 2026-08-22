import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type mysql from "mysql2/promise";
import type {
  AcquisitionCandidate,
  AcquisitionCandidateIdentityAlias
} from "./acquisition-domain.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionActionExecutionPort,
  AcquisitionActionExecutionReceipt,
  AcquisitionCandidateDirectoryPort,
  AcquisitionCandidateIndexEntry,
  AcquisitionPriorityCandidatePort,
  AcquisitionPriorityCandidateRow,
  AcquisitionReviewTask,
  AcquisitionReviewTaskPort,
  AcquisitionToolResultLedgerPort
} from "./acquisition-tool-executor.js";
import {
  AcquisitionToolIdempotencyConflictError
} from "./acquisition-tool-executor.js";
import {
  releaseAcquisitionMysqlConnection,
  releaseAcquisitionMysqlNamedLocks
} from "./acquisition-mysql-named-lock.js";
import {
  ACQUISITION_AGENT_TOOL_NAMES,
  type AcquisitionToolAuditLedger,
  type AcquisitionToolAuditRecord,
  type AcquisitionToolAuditScope
} from "./acquisition-pi-tools.js";

type MysqlRow = Record<string, unknown>;
type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

export const ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_candidate_directory (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    dedupe_key_hash CHAR(64) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    party_type VARCHAR(20) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    indexed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, dedupe_key_hash),
    UNIQUE KEY uk_acquisition_candidate_directory_candidate
      (owner_id, team_id, candidate_id),
    KEY idx_acquisition_candidate_directory_tenant
      (owner_id, team_id, indexed_at, candidate_id),
    CONSTRAINT fk_acquisition_candidate_directory_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_candidate_directory_party_type
      CHECK (party_type IN ('organization','individual'))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_review_tasks (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(200) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    proposed_action VARCHAR(40) NOT NULL,
    rationale TEXT NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_review_task_idempotency
      (owner_id, team_id, idempotency_key_hash),
    UNIQUE KEY uk_acquisition_review_task_scope
      (owner_id, team_id, id),
    KEY idx_acquisition_review_task_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_review_task_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_review_task_action CHECK (
      proposed_action IN (
        'public_reply','private_domain_invitation','phone_call',
        'email','meeting','convert'
      )
    ),
    CONSTRAINT chk_acquisition_review_task_status
      CHECK (status IN ('pending','approved','rejected','executed'))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_action_execution_receipts (
    execution_id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    review_task_id VARCHAR(160) NOT NULL,
    proposed_action VARCHAR(40) NOT NULL,
    executed_at DATETIME(3) NOT NULL,
    credential_issuer VARCHAR(255) NOT NULL,
    credential_id VARCHAR(255) NOT NULL,
    proof_hash VARCHAR(71) NOT NULL,
    UNIQUE KEY uk_acquisition_action_receipt_review
      (owner_id, team_id, review_task_id),
    KEY idx_acquisition_action_receipt_candidate
      (owner_id, team_id, candidate_id, executed_at, execution_id),
    CONSTRAINT fk_acquisition_action_receipt_review
      FOREIGN KEY (owner_id, team_id, review_task_id)
      REFERENCES acquisition_review_tasks (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_acquisition_action_receipt_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_action_receipt_action CHECK (
      proposed_action IN (
        'public_reply','private_domain_invitation','phone_call',
        'email','meeting','convert'
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_tool_results (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(200) NOT NULL,
    request_hash VARCHAR(80) NOT NULL,
    state VARCHAR(20) NOT NULL,
    result_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    PRIMARY KEY (
      owner_id, team_id, tool_name, idempotency_key_hash
    ),
    KEY idx_acquisition_tool_result_session
      (owner_id, team_id, session_id, completed_at, tool_name),
    CONSTRAINT chk_acquisition_tool_result_state
      CHECK (state IN ('pending','succeeded')),
    CONSTRAINT chk_acquisition_tool_result_completion CHECK (
      (state = 'pending' AND result_json IS NULL AND completed_at IS NULL)
      OR
      (state = 'succeeded' AND result_json IS NOT NULL
        AND completed_at IS NOT NULL)
    )
  ) ENGINE=InnoDB`,
  `ALTER TABLE acquisition_tool_results
     ADD COLUMN claim_token_hash CHAR(64) NULL AFTER request_hash`,
  `ALTER TABLE acquisition_tool_results
     ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER claim_token_hash`,
  `ALTER TABLE acquisition_tool_results
     ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0
       AFTER lease_expires_at`,
  `CREATE TABLE IF NOT EXISTS acquisition_tool_audit (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(200) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    tool_call_id_hash CHAR(64) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    parameter_hash CHAR(64) NOT NULL,
    result_hash CHAR(64) NULL,
    status VARCHAR(20) NOT NULL,
    error_code VARCHAR(100) NULL,
    started_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NOT NULL,
    KEY idx_acquisition_tool_audit_scope
      (owner_id, team_id, session_id, started_at, id),
    CONSTRAINT chk_acquisition_tool_audit_status
      CHECK (status IN ('succeeded','failed','aborted'))
  ) ENGINE=InnoDB`
] as const;

export async function ensureAcquisitionToolSupportMysqlSchema(pool: mysql.Pool) {
  for (const statement of ACQUISITION_TOOL_SUPPORT_MYSQL_SCHEMA_STATEMENTS) {
    try {
      await pool.query(statement);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (statement.startsWith("ALTER TABLE acquisition_tool_results")
        && code === "ER_DUP_FIELDNAME") {
        continue;
      }
      throw error;
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(value: string, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string up to ${maximum}`);
  }
}

function requireScope(scope: { ownerId: string; teamId: string }) {
  requireText(scope.ownerId, "ownerId", 100);
  requireText(scope.teamId, "teamId", 100);
}

function mysqlDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ACQUISITION_TOOL_SUPPORT_INVALID_DATE");
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function isoDate(value: unknown, resource: string) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:${resource}:date`
    );
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    value
  )
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(
      `ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:${resource}:date`
    );
  }
  return date.toISOString();
}

async function rows(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
): Promise<MysqlRow[]> {
  const [result] = await source.query(sql, values);
  return Array.isArray(result) ? result as MysqlRow[] : [];
}

function validateCandidate(
  input: {
    ownerId: string;
    teamId: string;
    partyType: "organization" | "individual";
  },
  candidate: AcquisitionCandidate
) {
  if (candidate.ownerId !== input.ownerId
    || candidate.teamId !== input.teamId
    || candidate.partyType !== input.partyType) {
    throw new Error("ACQUISITION_CANDIDATE_DIRECTORY_SCOPE_MISMATCH");
  }
  requireText(candidate.id, "candidate.id", 120);
}

function validateDirectoryInput(input: {
  ownerId: string;
  teamId: string;
  dedupeKey: string;
  partyType: "organization" | "individual";
  idempotencyKey: string;
}) {
  requireScope(input);
  requireText(input.dedupeKey, "dedupeKey", 4_000);
  requireText(input.idempotencyKey, "idempotencyKey", 1_000);
  if (input.partyType !== "organization" && input.partyType !== "individual") {
    throw new TypeError("partyType is invalid");
  }
}

function directoryScopeKey(input: {
  ownerId: string;
  teamId: string;
  dedupeKey: string;
}) {
  return [
    input.ownerId,
    input.teamId,
    sha256(input.dedupeKey)
  ].join("\u0000");
}

export interface AcquisitionCandidateDirectoryOptions {
  now?: () => string;
  identityAliases?: {
    findCandidateIdentityAlias(
      scope: { ownerId: string; teamId: string },
      dedupeKey: string
    ): Promise<AcquisitionCandidateIdentityAlias | null>;
  };
}

export class InMemoryAcquisitionCandidateDirectory
implements AcquisitionCandidateDirectoryPort {
  readonly #entries = new Map<string, AcquisitionCandidateIndexEntry>();
  readonly #inFlight = new Map<
    string,
    Promise<{ entry: AcquisitionCandidateIndexEntry; created: boolean }>
  >();
  readonly #now: () => string;
  readonly #identityAliases:
    AcquisitionCandidateDirectoryOptions["identityAliases"];
  readonly #transactionContext = new AsyncLocalStorage<boolean>();
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(options: AcquisitionCandidateDirectoryOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#identityAliases = options.identityAliases;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.#transactionContext.getStore()) return work();
    let release!: () => void;
    const previous = this.#transactionTail;
    this.#transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const entries = clone([...this.#entries.entries()]);
    try {
      return await this.#transactionContext.run(true, work);
    } catch (error) {
      this.#entries.clear();
      for (const [key, value] of entries) this.#entries.set(key, value);
      throw error;
    } finally {
      release();
    }
  }

  async upsertCandidate(input: {
    ownerId: string;
    teamId: string;
    dedupeKey: string;
    partyType: "organization" | "individual";
    idempotencyKey: string;
    createCandidate: () => Promise<AcquisitionCandidate>;
  }): ReturnType<AcquisitionCandidateDirectoryPort["upsertCandidate"]> {
    validateDirectoryInput(input);
    if (!this.#transactionContext.getStore()) {
      return this.transaction(() => this.upsertCandidate(input));
    }
    const alias = await this.#identityAliases?.findCandidateIdentityAlias(
      input,
      input.dedupeKey
    );
    if (alias) {
      if (alias.partyType !== input.partyType) {
        throw new Error(
          "ACQUISITION_CANDIDATE_DIRECTORY_PARTY_TYPE_CONFLICT"
        );
      }
      return {
        entry: {
          ownerId: alias.ownerId,
          teamId: alias.teamId,
          candidateId: alias.candidateId,
          dedupeKey: input.dedupeKey,
          partyType: alias.partyType,
          indexedAt: alias.createdAt
        },
        created: false
      };
    }
    const key = directoryScopeKey(input);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.partyType !== input.partyType) {
        throw new Error(
          "ACQUISITION_CANDIDATE_DIRECTORY_PARTY_TYPE_CONFLICT"
        );
      }
      return { entry: clone(existing), created: false };
    }
    const pending = this.#inFlight.get(key);
    if (pending) {
      const result = await pending;
      return { entry: clone(result.entry), created: false };
    }

    const operation = Promise.resolve().then(async () => {
      const candidate = await input.createCandidate();
      validateCandidate(input, candidate);
      const entry: AcquisitionCandidateIndexEntry = {
        ownerId: input.ownerId,
        teamId: input.teamId,
        candidateId: candidate.id,
        dedupeKey: input.dedupeKey,
        partyType: input.partyType,
        indexedAt: new Date(this.#now()).toISOString()
      };
      this.#entries.set(key, clone(entry));
      return { entry, created: true };
    });
    this.#inFlight.set(key, operation);
    try {
      return clone(await operation);
    } finally {
      this.#inFlight.delete(key);
    }
  }
}

export interface MysqlAcquisitionCandidateDirectoryOptions
extends AcquisitionCandidateDirectoryOptions {
  lockTimeoutSeconds?: number;
}

export class MysqlAcquisitionCandidateDirectory
implements AcquisitionCandidateDirectoryPort {
  readonly #now: () => string;
  readonly #lockTimeoutSeconds: number;
  readonly #identityAliases:
    AcquisitionCandidateDirectoryOptions["identityAliases"];
  readonly #transactionContext = new AsyncLocalStorage<{
    connection: mysql.PoolConnection;
    lockNames: Set<string>;
  }>();

  constructor(
    private readonly pool: mysql.Pool,
    options: MysqlAcquisitionCandidateDirectoryOptions = {}
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#identityAliases = options.identityAliases;
    this.#lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
    if (!Number.isInteger(this.#lockTimeoutSeconds)
      || this.#lockTimeoutSeconds < 0
      || this.#lockTimeoutSeconds > 300) {
      throw new TypeError("lockTimeoutSeconds must be from 0 to 300");
    }
  }

  async withTransactionConnection<T>(
    connection: mysql.PoolConnection,
    work: () => Promise<T>
  ) {
    if (this.#transactionContext.getStore()) return work();
    const context = { connection, lockNames: new Set<string>() };
    try {
      return await this.#transactionContext.run(context, work);
    } finally {
      await releaseAcquisitionMysqlNamedLocks(connection, context.lockNames);
    }
  }

  async upsertCandidate(input: {
    ownerId: string;
    teamId: string;
    dedupeKey: string;
    partyType: "organization" | "individual";
    idempotencyKey: string;
    createCandidate: () => Promise<AcquisitionCandidate>;
  }) {
    validateDirectoryInput(input);
    const dedupeKeyHash = sha256(input.dedupeKey);
    const idempotencyKeyHash = sha256(input.idempotencyKey);
    const lockName = `acq-candidate:${sha256([
      input.ownerId,
      input.teamId,
      dedupeKeyHash
    ].join("\u0000")).slice(0, 50)}`;
    const externalContext = this.#transactionContext.getStore();
    const connection = externalContext?.connection ?? await this.pool.getConnection();
    let locked = false;
    try {
      if (externalContext?.lockNames.has(lockName)) {
        locked = true;
      } else {
        const lockRows = await rows(
          connection,
          "SELECT GET_LOCK(?, ?) AS lock_acquired",
          [lockName, this.#lockTimeoutSeconds]
        );
        if (Number(lockRows[0]?.lock_acquired) !== 1) {
          throw new Error("ACQUISITION_CANDIDATE_DIRECTORY_LOCK_TIMEOUT");
        }
        locked = true;
        externalContext?.lockNames.add(lockName);
      }
      const aliasRows = this.#identityAliases
        ? await rows(
            connection,
            `SELECT candidate_id, party_type, basis, created_at
             FROM acquisition_candidate_identity_aliases
             WHERE owner_id = ? AND team_id = ? AND dedupe_key_hash = ?
             LIMIT 1`,
            [input.ownerId, input.teamId, dedupeKeyHash]
          )
        : [];
      const aliasRow = aliasRows[0];
      const alias = aliasRow
        ? {
            ownerId: input.ownerId,
            teamId: input.teamId,
            candidateId: String(aliasRow.candidate_id),
            dedupeKey: input.dedupeKey,
            partyType: String(aliasRow.party_type) as
              AcquisitionCandidateIdentityAlias["partyType"],
            basis: String(aliasRow.basis) as
              AcquisitionCandidateIdentityAlias["basis"],
            createdAt: isoDate(
              aliasRow.created_at,
              "candidate_identity_alias"
            )
          }
        : null;
      if (alias) {
        if (alias.partyType !== input.partyType) {
          throw new Error(
            "ACQUISITION_CANDIDATE_DIRECTORY_PARTY_TYPE_CONFLICT"
          );
        }
        return {
          entry: {
            ownerId: alias.ownerId,
            teamId: alias.teamId,
            candidateId: alias.candidateId,
            dedupeKey: input.dedupeKey,
            partyType: alias.partyType,
            indexedAt: alias.createdAt
          },
          created: false
        };
      }
      const found = await rows(
        connection,
        `SELECT candidate_id, party_type, indexed_at
         FROM acquisition_candidate_directory
         WHERE owner_id = ? AND team_id = ? AND dedupe_key_hash = ?
         LIMIT 1`,
        [input.ownerId, input.teamId, dedupeKeyHash]
      );
      const existing = found[0];
      if (existing) {
        if (existing.party_type !== input.partyType) {
          throw new Error(
            "ACQUISITION_CANDIDATE_DIRECTORY_PARTY_TYPE_CONFLICT"
          );
        }
        return {
          entry: {
            ownerId: input.ownerId,
            teamId: input.teamId,
            candidateId: String(existing.candidate_id),
            dedupeKey: input.dedupeKey,
            partyType: input.partyType,
            indexedAt: isoDate(existing.indexed_at, "candidate_directory")
          },
          created: false
        };
      }

      const candidate = await input.createCandidate();
      validateCandidate(input, candidate);
      const indexedAt = new Date(this.#now()).toISOString();
      await connection.query(
        `INSERT INTO acquisition_candidate_directory
         (owner_id, team_id, dedupe_key_hash, candidate_id, party_type,
          idempotency_key_hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.ownerId,
          input.teamId,
          dedupeKeyHash,
          candidate.id,
          input.partyType,
          idempotencyKeyHash,
          mysqlDate(indexedAt)
        ]
      );
      return {
        entry: {
          ownerId: input.ownerId,
          teamId: input.teamId,
          candidateId: candidate.id,
          dedupeKey: input.dedupeKey,
          partyType: input.partyType,
          indexedAt
        },
        created: true
      };
    } finally {
      try {
        if (locked && !externalContext) {
          await releaseAcquisitionMysqlNamedLocks(connection, [lockName]);
        }
      } finally {
        if (!externalContext) releaseAcquisitionMysqlConnection(connection);
      }
    }
  }
}

type Grade = NonNullable<AcquisitionPriorityCandidateRow["qualificationGrade"]>;

const GRADE_RANK: Readonly<Record<Grade, number>> = Object.freeze({
  S: 1,
  A: 2,
  B: 3,
  C: 4,
  D: 5
});

function nullableFiniteNumber(value: unknown, resource: string) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(
      `ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:${resource}:number`
    );
  }
  return number;
}

export class MysqlAcquisitionPriorityCandidateRepository
implements AcquisitionPriorityCandidatePort {
  constructor(private readonly pool: mysql.Pool) {}

  async listPriorityCandidates(input: {
    ownerId: string;
    teamId: string;
    subjectKinds?: Array<"organization" | "individual">;
    minimumGrade?: Grade;
    limit: number;
    sort: "qualification_and_financial_desc";
  }) {
    requireScope(input);
    if (!Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 100) {
      throw new TypeError("limit must be an integer from 1 to 100");
    }
    if (input.sort !== "qualification_and_financial_desc") {
      throw new TypeError("sort is invalid");
    }
    if (input.minimumGrade && !(input.minimumGrade in GRADE_RANK)) {
      throw new TypeError("minimumGrade is invalid");
    }
    if (input.subjectKinds) {
      if (input.subjectKinds.length < 1
        || input.subjectKinds.length > 2
        || new Set(input.subjectKinds).size !== input.subjectKinds.length
        || input.subjectKinds.some((kind) =>
          kind !== "organization" && kind !== "individual"
        )) {
        throw new TypeError("subjectKinds must contain unique valid kinds");
      }
    }

    const innerWhere = [
      "c.owner_id = ?",
      "c.team_id = ?",
      "d.owner_id = c.owner_id",
      "d.team_id = c.team_id",
      "d.candidate_id = c.id"
    ];
    const values: unknown[] = [input.ownerId, input.teamId];
    if (input.subjectKinds) {
      innerWhere.push(
        `JSON_UNQUOTE(JSON_EXTRACT(c.payload_json, '$.partyType'))
          IN (${input.subjectKinds.map(() => "?").join(", ")})`
      );
      values.push(...input.subjectKinds);
    }
    const outerWhere: string[] = [];
    if (input.minimumGrade) {
      outerWhere.push(
        `(qualification_grade IS NOT NULL
          AND CASE qualification_grade
            WHEN 'S' THEN 1
            WHEN 'A' THEN 2
            WHEN 'B' THEN 3
            WHEN 'C' THEN 4
            WHEN 'D' THEN 5
            ELSE 6
          END <= ?)`
      );
      values.push(GRADE_RANK[input.minimumGrade]);
    }
    values.push(input.limit);

    const result = await rows(
      this.pool,
      `SELECT candidate_id, qualification_grade, qualification_score,
              financial_score, updated_at
       FROM (
         SELECT c.id AS candidate_id,
                JSON_UNQUOTE(
                  JSON_EXTRACT(q.payload_json, '$.grade')
                ) AS qualification_grade,
                CAST(JSON_UNQUOTE(
                  JSON_EXTRACT(q.payload_json, '$.score')
                ) AS DECIMAL(20, 6)) AS qualification_score,
                CAST(JSON_UNQUOTE(
                  JSON_EXTRACT(f.payload_json, '$.score')
                ) AS DECIMAL(20, 6)) AS financial_score,
                c.updated_at AS updated_at
         FROM acquisition_candidates c
         JOIN acquisition_candidate_directory d
           ON d.candidate_id = c.id
          AND d.owner_id = c.owner_id
          AND d.team_id = c.team_id
         LEFT JOIN acquisition_qualification_decisions q
           ON q.id = (
             SELECT q2.id
             FROM acquisition_qualification_decisions q2
             WHERE q2.owner_id = c.owner_id
               AND q2.team_id = c.team_id
               AND q2.candidate_id = c.id
             ORDER BY q2.created_at DESC, q2.id DESC
             LIMIT 1
           )
         LEFT JOIN acquisition_financial_values f
           ON f.id = (
             SELECT f2.id
             FROM acquisition_financial_values f2
             WHERE f2.owner_id = c.owner_id
               AND f2.team_id = c.team_id
               AND f2.candidate_id = c.id
             ORDER BY f2.created_at DESC, f2.id DESC
             LIMIT 1
           )
         WHERE ${innerWhere.join(" AND ")}
       ) priority_candidates
       ${outerWhere.length > 0 ? `WHERE ${outerWhere.join(" AND ")}` : ""}
       ORDER BY CASE qualification_grade
                  WHEN 'S' THEN 1
                  WHEN 'A' THEN 2
                  WHEN 'B' THEN 3
                  WHEN 'C' THEN 4
                  WHEN 'D' THEN 5
                  ELSE 6
                END ASC,
                qualification_score DESC,
                financial_score DESC,
                updated_at DESC,
                candidate_id ASC
       LIMIT ?`,
      values
    );
    return result.map((row): AcquisitionPriorityCandidateRow => {
      const grade = row.qualification_grade === null
        || row.qualification_grade === undefined
        ? null
        : String(row.qualification_grade) as Grade;
      if (grade !== null && !(grade in GRADE_RANK)) {
        throw new Error(
          "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:priority:grade"
        );
      }
      const candidateId = String(row.candidate_id ?? "");
      requireText(candidateId, "candidateId", 120);
      return {
        candidateId,
        qualificationGrade: grade,
        qualificationScore: nullableFiniteNumber(
          row.qualification_score,
          "priority_qualification"
        ),
        financialScore: nullableFiniteNumber(
          row.financial_score,
          "priority_financial"
        ),
        updatedAt: isoDate(row.updated_at, "priority_candidate")
      };
    });
  }
}

const REVIEW_ACTIONS = new Set<AcquisitionReviewTask["proposedAction"]>([
  "public_reply",
  "private_domain_invitation",
  "phone_call",
  "email",
  "meeting",
  "convert"
]);

function validateReviewInput(
  input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">
) {
  requireScope(input);
  requireText(input.actorId, "actorId", 100);
  requireText(input.sessionId, "sessionId", 200);
  requireText(input.candidateId, "candidateId", 120);
  requireText(input.rationale, "rationale", 8_000);
  requireText(input.idempotencyKey, "idempotencyKey", 1_000);
  if (!REVIEW_ACTIONS.has(input.proposedAction)) {
    throw new TypeError("proposedAction is invalid");
  }
}

function reviewRequestHash(
  input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">
) {
  return sha256(canonicalJsonStringify({
    ownerId: input.ownerId,
    teamId: input.teamId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    candidateId: input.candidateId,
    proposedAction: input.proposedAction,
    rationale: input.rationale
  }));
}

function reviewScopeKey(
  scope: { ownerId: string; teamId: string },
  value: string
) {
  return [scope.ownerId, scope.teamId, value].join("\u0000");
}

export interface AcquisitionReviewTaskRepositoryOptions {
  now?: () => string;
  idFactory?: () => string;
}

interface StoredReviewTask {
  task: AcquisitionReviewTask;
  requestHash: string;
}

export class InMemoryAcquisitionReviewTaskRepository
implements AcquisitionReviewTaskPort {
  readonly #byIdempotency = new Map<string, StoredReviewTask>();
  readonly #byId = new Map<string, StoredReviewTask>();
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(options: AcquisitionReviewTaskRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async create(
    input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">
  ) {
    validateReviewInput(input);
    const keyHash = sha256(input.idempotencyKey);
    const key = reviewScopeKey(input, keyHash);
    const requestHash = reviewRequestHash(input);
    const existing = this.#byIdempotency.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AcquisitionToolIdempotencyConflictError();
      }
      return {
        ...clone(existing.task),
        idempotencyKey: input.idempotencyKey
      };
    }
    const id = this.#idFactory();
    requireText(id, "reviewTask.id", 160);
    const task: AcquisitionReviewTask = {
      ...clone(input),
      id,
      idempotencyKey: `sha256:${keyHash}`,
      status: "pending",
      createdAt: new Date(this.#now()).toISOString()
    };
    const stored = { task: clone(task), requestHash };
    this.#byIdempotency.set(key, stored);
    this.#byId.set(reviewScopeKey(task, task.id), stored);
    return { ...clone(task), idempotencyKey: input.idempotencyKey };
  }

  async get(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ) {
    requireScope(scope);
    requireText(reviewTaskId, "reviewTaskId", 160);
    return clone(
      this.#byId.get(reviewScopeKey(scope, reviewTaskId))?.task ?? null
    );
  }
}

function reviewTaskFromRow(
  row: MysqlRow,
  idempotencyKey: string
): AcquisitionReviewTask {
  const proposedAction = String(
    row.proposed_action ?? ""
  ) as AcquisitionReviewTask["proposedAction"];
  const status = String(row.status ?? "") as AcquisitionReviewTask["status"];
  if (!REVIEW_ACTIONS.has(proposedAction)) {
    throw new Error(
      "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:review_task:action"
    );
  }
  if (!["pending", "approved", "rejected", "executed"].includes(status)) {
    throw new Error(
      "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:review_task:status"
    );
  }
  const task: AcquisitionReviewTask = {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    teamId: String(row.team_id ?? ""),
    actorId: String(row.actor_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    candidateId: String(row.candidate_id ?? ""),
    proposedAction,
    rationale: String(row.rationale ?? ""),
    idempotencyKey,
    status,
    createdAt: isoDate(row.created_at, "review_task")
  };
  requireScope(task);
  requireText(task.id, "reviewTask.id", 160);
  requireText(task.actorId, "reviewTask.actorId", 100);
  requireText(task.sessionId, "reviewTask.sessionId", 200);
  requireText(task.candidateId, "reviewTask.candidateId", 120);
  requireText(task.rationale, "reviewTask.rationale", 8_000);
  return task;
}

export class MysqlAcquisitionReviewTaskRepository
implements AcquisitionReviewTaskPort {
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(
    private readonly pool: mysql.Pool,
    options: AcquisitionReviewTaskRepositoryOptions = {}
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async create(
    input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">
  ) {
    validateReviewInput(input);
    const id = this.#idFactory();
    requireText(id, "reviewTask.id", 160);
    const keyHash = sha256(input.idempotencyKey);
    const requestHash = reviewRequestHash(input);
    const createdAt = new Date(this.#now()).toISOString();
    await this.pool.query(
      `INSERT INTO acquisition_review_tasks
       (id, owner_id, team_id, actor_id, session_id, candidate_id,
        proposed_action, rationale, idempotency_key_hash, request_hash,
        status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        id,
        input.ownerId,
        input.teamId,
        input.actorId,
        input.sessionId,
        input.candidateId,
        input.proposedAction,
        input.rationale,
        keyHash,
        requestHash,
        mysqlDate(createdAt)
      ]
    );
    const found = await rows(
      this.pool,
      `SELECT id, owner_id, team_id, actor_id, session_id, candidate_id,
              proposed_action, rationale, idempotency_key_hash, request_hash,
              status, created_at
       FROM acquisition_review_tasks
       WHERE owner_id = ? AND team_id = ? AND idempotency_key_hash = ?
       LIMIT 1`,
      [input.ownerId, input.teamId, keyHash]
    );
    const row = found[0];
    if (!row) {
      throw new Error("ACQUISITION_REVIEW_TASK_WRITE_LOST");
    }
    if (String(row.request_hash ?? "") !== requestHash) {
      throw new AcquisitionToolIdempotencyConflictError();
    }
    if (String(row.owner_id ?? "") !== input.ownerId
      || String(row.team_id ?? "") !== input.teamId
      || String(row.idempotency_key_hash ?? "") !== keyHash) {
      throw new Error(
        "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:review_task:scope"
      );
    }
    return reviewTaskFromRow(row, input.idempotencyKey);
  }

  async get(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ) {
    requireScope(scope);
    requireText(reviewTaskId, "reviewTaskId", 160);
    const found = await rows(
      this.pool,
      `SELECT id, owner_id, team_id, actor_id, session_id, candidate_id,
              proposed_action, rationale, idempotency_key_hash, request_hash,
              status, created_at
       FROM acquisition_review_tasks
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [reviewTaskId, scope.ownerId, scope.teamId]
    );
    const row = found[0];
    if (!row) return null;
    if (String(row.owner_id ?? "") !== scope.ownerId
      || String(row.team_id ?? "") !== scope.teamId) {
      throw new Error(
        "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:review_task:scope"
      );
    }
    const keyHash = String(row.idempotency_key_hash ?? "");
    if (!/^[a-f0-9]{64}$/i.test(keyHash)) {
      throw new Error(
        "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:review_task:idempotency"
      );
    }
    return reviewTaskFromRow(row, `sha256:${keyHash.toLowerCase()}`);
  }
}

const RECEIPT_ACTIONS = REVIEW_ACTIONS;

function validateProofSecret(secret: string) {
  if (typeof secret !== "string"
    || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("proofSecret must contain at least 32 bytes");
  }
}

function receiptProofHash(
  secret: string,
  receipt: Omit<AcquisitionActionExecutionReceipt["credential"], "proofHash">
    & Record<never, never>,
  context: Omit<AcquisitionActionExecutionReceipt, "credential">
) {
  return `sha256:${createHmac("sha256", secret)
    .update(canonicalJsonStringify({
      ...context,
      credential: receipt
    }))
    .digest("hex")}`;
}

function equalProof(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function validateReceiptBase(input: {
  executionId: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  reviewTaskId: string;
  proposedAction: AcquisitionReviewTask["proposedAction"];
  executedAt: string;
  credential: {
    issuer: string;
    credentialId: string;
  };
}) {
  requireScope(input);
  requireText(input.executionId, "executionId", 160);
  requireText(input.candidateId, "candidateId", 120);
  requireText(input.reviewTaskId, "reviewTaskId", 160);
  requireText(input.credential.issuer, "credential.issuer", 255);
  requireText(input.credential.credentialId, "credential.credentialId", 255);
  if (!RECEIPT_ACTIONS.has(input.proposedAction)) {
    throw new TypeError("proposedAction is invalid");
  }
  const executedAt = new Date(input.executedAt);
  if (!Number.isFinite(executedAt.getTime())) {
    throw new TypeError("executedAt is invalid");
  }
}

export interface TrustedAcquisitionActionExecutionInput {
  executionId?: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  reviewTaskId: string;
  proposedAction: AcquisitionReviewTask["proposedAction"];
  executedAt?: string;
  credential: {
    issuer: string;
    credentialId: string;
  };
}

export interface AcquisitionActionExecutionRepositoryOptions {
  proofSecret: string;
}

export interface TrustedAcquisitionActionExecutionWriterOptions
extends AcquisitionActionExecutionRepositoryOptions {
  now?: () => string;
  idFactory?: () => string;
}

/**
 * Trusted action-worker capability. Do not place this object in agent tool
 * dependencies; the agent-facing repository below exposes only verified reads.
 */
export class TrustedMysqlAcquisitionActionExecutionWriter {
  readonly #proofSecret: string;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(
    private readonly pool: mysql.Pool,
    options: TrustedAcquisitionActionExecutionWriterOptions
  ) {
    validateProofSecret(options.proofSecret);
    this.#proofSecret = options.proofSecret;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async recordExecution(
    input: TrustedAcquisitionActionExecutionInput
  ): Promise<AcquisitionActionExecutionReceipt> {
    const context = {
      executionId: input.executionId ?? this.#idFactory(),
      ownerId: input.ownerId,
      teamId: input.teamId,
      candidateId: input.candidateId,
      reviewTaskId: input.reviewTaskId,
      proposedAction: input.proposedAction,
      executedAt: new Date(input.executedAt ?? this.#now()).toISOString()
    };
    validateReceiptBase({ ...context, credential: input.credential });
    const receipt: AcquisitionActionExecutionReceipt = {
      ...context,
      credential: {
        ...clone(input.credential),
        proofHash: receiptProofHash(
          this.#proofSecret,
          input.credential,
          context
        )
      }
    };
    await this.pool.query(
      `INSERT INTO acquisition_action_execution_receipts
       (execution_id, owner_id, team_id, candidate_id, review_task_id,
        proposed_action, executed_at, credential_issuer, credential_id,
        proof_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receipt.executionId,
        receipt.ownerId,
        receipt.teamId,
        receipt.candidateId,
        receipt.reviewTaskId,
        receipt.proposedAction,
        mysqlDate(receipt.executedAt),
        receipt.credential.issuer,
        receipt.credential.credentialId,
        receipt.credential.proofHash
      ]
    );
    return clone(receipt);
  }
}

export class MysqlAcquisitionActionExecutionRepository
implements AcquisitionActionExecutionPort {
  readonly #proofSecret: string;

  constructor(
    private readonly pool: mysql.Pool,
    options: AcquisitionActionExecutionRepositoryOptions
  ) {
    validateProofSecret(options.proofSecret);
    this.#proofSecret = options.proofSecret;
  }

  async getVerifiedExecution(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ) {
    requireScope(scope);
    requireText(reviewTaskId, "reviewTaskId", 160);
    const found = await rows(
      this.pool,
      `SELECT execution_id, owner_id, team_id, candidate_id, review_task_id,
              proposed_action, executed_at, credential_issuer, credential_id,
              proof_hash
       FROM acquisition_action_execution_receipts
       WHERE owner_id = ? AND team_id = ? AND review_task_id = ?
       LIMIT 1`,
      [scope.ownerId, scope.teamId, reviewTaskId]
    );
    const row = found[0];
    if (!row) return null;
    const proposedAction = String(
      row.proposed_action ?? ""
    ) as AcquisitionReviewTask["proposedAction"];
    const context = {
      executionId: String(row.execution_id ?? ""),
      ownerId: String(row.owner_id ?? ""),
      teamId: String(row.team_id ?? ""),
      candidateId: String(row.candidate_id ?? ""),
      reviewTaskId: String(row.review_task_id ?? ""),
      proposedAction,
      executedAt: isoDate(row.executed_at, "action_execution")
    };
    const credential = {
      issuer: String(row.credential_issuer ?? ""),
      credentialId: String(row.credential_id ?? "")
    };
    validateReceiptBase({ ...context, credential });
    if (context.ownerId !== scope.ownerId
      || context.teamId !== scope.teamId
      || context.reviewTaskId !== reviewTaskId) {
      throw new Error(
        "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:action_execution:scope"
      );
    }
    const proofHash = String(row.proof_hash ?? "");
    const expected = receiptProofHash(this.#proofSecret, credential, context);
    if (!/^sha256:[a-f0-9]{64}$/i.test(proofHash)
      || !equalProof(proofHash.toLowerCase(), expected)) {
      return null;
    }
    return {
      ...context,
      credential: {
        ...credential,
        proofHash: proofHash.toLowerCase()
      }
    };
  }
}

const SENSITIVE_KEY =
  /(?:password|authorization|(?:api|secret|private)[_-]?key|(?:access|refresh|bearer)[_-]?token|client[_-]?secret|credential[_-]?plaintext)$/i;

function redactedHash(value: string) {
  return /^sha256:[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : `sha256:${sha256(value)}`;
}

function sanitizedJsonValue(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("ACQUISITION_TOOL_RESULT_NOT_JSON_SERIALIZABLE");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("ACQUISITION_TOOL_RESULT_NOT_JSON_SERIALIZABLE");
  }
  if (seen.has(value)) {
    throw new Error("ACQUISITION_TOOL_RESULT_NOT_JSON_SERIALIZABLE");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizedJsonValue(entry, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) {
      throw new Error("ACQUISITION_TOOL_RESULT_NOT_JSON_SERIALIZABLE");
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (entry === undefined) continue;
      if (SENSITIVE_KEY.test(key) && entry !== null && entry !== "") {
        throw new Error("ACQUISITION_PLAINTEXT_SECRET_REJECTED");
      }
      if ((key === "idempotencyKey" || key === "scopeKey")
        && typeof entry === "string") {
        result[key] = redactedHash(entry);
      } else {
        result[key] = sanitizedJsonValue(entry, seen);
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

interface ToolResultExecutionInput {
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  toolName: string;
  idempotencyKey: string;
  requestHash: string;
}

function validateToolResultInput(input: ToolResultExecutionInput) {
  requireScope(input);
  requireText(input.actorId, "actorId", 100);
  requireText(input.sessionId, "sessionId", 200);
  requireText(input.toolName, "toolName", 100);
  requireText(input.idempotencyKey, "idempotencyKey", 1_000);
  requireText(input.requestHash, "requestHash", 80);
}

function toolResultScopeKey(
  input: Pick<
    ToolResultExecutionInput,
    "ownerId" | "teamId" | "toolName" | "idempotencyKey"
  >
) {
  return [
    input.ownerId,
    input.teamId,
    input.toolName,
    sha256(input.idempotencyKey)
  ].join("\u0000");
}

interface StoredToolResult {
  requestHash: string;
  result: unknown;
}

interface PendingToolResult {
  requestHash: string;
  promise: Promise<unknown>;
}

export class InMemoryAcquisitionToolResultLedger
implements AcquisitionToolResultLedgerPort {
  readonly #records = new Map<string, StoredToolResult>();
  readonly #inFlight = new Map<string, PendingToolResult>();

  async executeOnce<T>(
    input: ToolResultExecutionInput,
    operation: () => Promise<T>
  ): Promise<T> {
    validateToolResultInput(input);
    const key = toolResultScopeKey(input);
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new AcquisitionToolIdempotencyConflictError();
      }
      return clone(existing.result) as T;
    }
    const pending = this.#inFlight.get(key);
    if (pending) {
      if (pending.requestHash !== input.requestHash) {
        throw new AcquisitionToolIdempotencyConflictError();
      }
      return clone(await pending.promise) as T;
    }
    const promise = Promise.resolve().then(async () =>
      sanitizedJsonValue(await operation())
    );
    this.#inFlight.set(key, {
      requestHash: input.requestHash,
      promise
    });
    try {
      const result = await promise;
      this.#records.set(key, {
        requestHash: input.requestHash,
        result: clone(result)
      });
      return clone(result) as T;
    } finally {
      this.#inFlight.delete(key);
    }
  }
}

export interface MysqlAcquisitionToolResultLedgerOptions {
  lockTimeoutSeconds?: number;
  claimLeaseSeconds?: number;
  pendingWaitTimeoutMs?: number;
  pendingPollIntervalMs?: number;
  now?: () => string;
  claimTokenFactory?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

function parseStoredResult(value: unknown) {
  try {
    const parsed = Buffer.isBuffer(value)
      ? JSON.parse(value.toString("utf8"))
      : typeof value === "string"
        ? JSON.parse(value)
        : value;
    const envelope = sanitizedJsonValue(parsed);
    if (!envelope
      || typeof envelope !== "object"
      || Array.isArray(envelope)
      || !Object.hasOwn(envelope, "value")) {
      throw new Error("invalid result envelope");
    }
    return (envelope as { value: unknown }).value;
  } catch (error) {
    if (error instanceof Error
      && error.message === "ACQUISITION_PLAINTEXT_SECRET_REJECTED") {
      throw error;
    }
    throw new Error(
      "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:tool_result:json"
    );
  }
}

export class MysqlAcquisitionToolResultLedger
implements AcquisitionToolResultLedgerPort {
  readonly #lockTimeoutSeconds: number;
  readonly #claimLeaseSeconds: number;
  readonly #pendingWaitTimeoutMs: number;
  readonly #pendingPollIntervalMs: number;
  readonly #now: () => string;
  readonly #claimTokenFactory: () => string;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly pool: mysql.Pool,
    options: MysqlAcquisitionToolResultLedgerOptions = {}
  ) {
    this.#lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
    this.#claimLeaseSeconds = options.claimLeaseSeconds ?? 300;
    this.#pendingWaitTimeoutMs = options.pendingWaitTimeoutMs
      ?? this.#lockTimeoutSeconds * 1_000;
    this.#pendingPollIntervalMs = options.pendingPollIntervalMs ?? 50;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#claimTokenFactory = options.claimTokenFactory ?? randomUUID;
    this.#sleep = options.sleep ?? (milliseconds =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    );
    if (!Number.isInteger(this.#lockTimeoutSeconds)
      || this.#lockTimeoutSeconds < 0
      || this.#lockTimeoutSeconds > 300) {
      throw new TypeError("lockTimeoutSeconds must be from 0 to 300");
    }
    if (!Number.isInteger(this.#claimLeaseSeconds)
      || this.#claimLeaseSeconds < 1
      || this.#claimLeaseSeconds > 3_600) {
      throw new TypeError("claimLeaseSeconds must be from 1 to 3600");
    }
    if (!Number.isInteger(this.#pendingWaitTimeoutMs)
      || this.#pendingWaitTimeoutMs < 0
      || this.#pendingWaitTimeoutMs > 300_000) {
      throw new TypeError("pendingWaitTimeoutMs must be from 0 to 300000");
    }
    if (!Number.isInteger(this.#pendingPollIntervalMs)
      || this.#pendingPollIntervalMs < 1
      || this.#pendingPollIntervalMs > 10_000) {
      throw new TypeError(
        "pendingPollIntervalMs must be from 1 to 10000"
      );
    }
  }

  async executeOnce<T>(
    input: ToolResultExecutionInput,
    operation: () => Promise<T>
  ): Promise<T> {
    validateToolResultInput(input);
    const keyHash = sha256(input.idempotencyKey);
    const lockName = `acq-tool-result:${sha256([
      input.ownerId,
      input.teamId,
      input.toolName,
      keyHash
    ].join("\u0000")).slice(0, 48)}`;
    const waitDeadline = Date.now() + this.#pendingWaitTimeoutMs;
    let claimTokenHash: string | null = null;
    for (;;) {
      const claim = await this.#claimOrRead(
        input,
        keyHash,
        lockName
      );
      if (claim.kind === "succeeded") {
        return clone(claim.result) as T;
      }
      if (claim.kind === "claimed") {
        claimTokenHash = claim.claimTokenHash;
        break;
      }
      const remaining = waitDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error("ACQUISITION_TOOL_RESULT_PENDING_TIMEOUT");
      }
      await this.#sleep(Math.min(this.#pendingPollIntervalMs, remaining));
    }

    try {
      const result = sanitizedJsonValue(await operation());
      const serialized = JSON.stringify({ value: result });
      if (serialized === undefined) {
        throw new Error("ACQUISITION_TOOL_RESULT_NOT_JSON_SERIALIZABLE");
      }
      const completedAt = new Date(this.#now()).toISOString();
      const [updated] = await this.pool.query(
        `UPDATE acquisition_tool_results
         SET state = 'succeeded', result_json = ?, completed_at = ?,
             claim_token_hash = NULL, lease_expires_at = NULL
         WHERE owner_id = ? AND team_id = ? AND tool_name = ?
           AND idempotency_key_hash = ? AND state = 'pending'
           AND request_hash = ? AND claim_token_hash = ?`,
        [
          serialized,
          mysqlDate(completedAt),
          input.ownerId,
          input.teamId,
          input.toolName,
          keyHash,
          input.requestHash,
          claimTokenHash
        ]
      );
      if (Number((updated as mysql.ResultSetHeader).affectedRows || 0) !== 1) {
        throw new Error("ACQUISITION_TOOL_RESULT_CLAIM_LOST");
      }
      return clone(result) as T;
    } catch (error) {
      if (claimTokenHash !== null) {
        try {
          await this.pool.query(
            `DELETE FROM acquisition_tool_results
             WHERE owner_id = ? AND team_id = ? AND tool_name = ?
               AND idempotency_key_hash = ? AND state = 'pending'
               AND request_hash = ? AND claim_token_hash = ?`,
            [
              input.ownerId,
              input.teamId,
              input.toolName,
              keyHash,
              input.requestHash,
              claimTokenHash
            ]
          );
        } catch {
          throw new Error("ACQUISITION_TOOL_RESULT_CLAIM_CLEANUP_FAILED");
        }
      }
      throw error;
    }
  }

  async #claimOrRead(
    input: ToolResultExecutionInput,
    keyHash: string,
    lockName: string
  ): Promise<
    | { kind: "claimed"; claimTokenHash: string }
    | { kind: "pending" }
    | { kind: "succeeded"; result: unknown }
  > {
    const connection = await this.pool.getConnection();
    let locked = false;
    let transaction = false;
    try {
      const lockRows = await rows(
        connection,
        "SELECT GET_LOCK(?, ?) AS lock_acquired",
        [lockName, this.#lockTimeoutSeconds]
      );
      if (Number(lockRows[0]?.lock_acquired) !== 1) {
        throw new Error("ACQUISITION_TOOL_RESULT_LOCK_TIMEOUT");
      }
      locked = true;
      await connection.beginTransaction();
      transaction = true;
      const found = await rows(
        connection,
        `SELECT request_hash, state, result_json, claim_token_hash,
                lease_expires_at, attempt_count
         FROM acquisition_tool_results
         WHERE owner_id = ? AND team_id = ? AND tool_name = ?
           AND idempotency_key_hash = ?
         LIMIT 1
         FOR UPDATE`,
        [input.ownerId, input.teamId, input.toolName, keyHash]
      );
      const existing = found[0];
      const now = new Date(this.#now());
      if (!Number.isFinite(now.getTime())) {
        throw new Error("ACQUISITION_TOOL_SUPPORT_INVALID_DATE");
      }
      if (existing) {
        if (String(existing.request_hash ?? "") !== input.requestHash) {
          throw new AcquisitionToolIdempotencyConflictError();
        }
        const state = String(existing.state ?? "");
        if (state === "succeeded") {
          if (existing.result_json === null
            || existing.result_json === undefined) {
            throw new Error(
              "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:tool_result:state"
            );
          }
          const stored = parseStoredResult(existing.result_json);
          await connection.commit();
          transaction = false;
          return { kind: "succeeded", result: stored };
        }
        if (state !== "pending") {
          throw new Error(
            "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:tool_result:state"
          );
        }
        const leaseExpiresAt = existing.lease_expires_at === null
          || existing.lease_expires_at === undefined
          ? null
          : new Date(isoDate(
            existing.lease_expires_at,
            "tool_result_lease"
          ));
        if (leaseExpiresAt !== null
          && leaseExpiresAt.getTime() > now.getTime()) {
          await connection.commit();
          transaction = false;
          return { kind: "pending" };
        }
        const claimTokenHash = sha256(this.#claimTokenFactory());
        const nextLease = new Date(
          now.getTime() + this.#claimLeaseSeconds * 1_000
        ).toISOString();
        const [reclaimed] = await connection.query(
          `UPDATE acquisition_tool_results
           SET actor_id = ?, session_id = ?, claim_token_hash = ?,
               lease_expires_at = ?, attempt_count = attempt_count + 1
           WHERE owner_id = ? AND team_id = ? AND tool_name = ?
             AND idempotency_key_hash = ? AND state = 'pending'
             AND request_hash = ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          [
            input.actorId,
            input.sessionId,
            claimTokenHash,
            mysqlDate(nextLease),
            input.ownerId,
            input.teamId,
            input.toolName,
            keyHash,
            input.requestHash,
            mysqlDate(now.toISOString())
          ]
        );
        if (Number(
          (reclaimed as mysql.ResultSetHeader).affectedRows || 0
        ) !== 1) {
          throw new Error("ACQUISITION_TOOL_RESULT_CLAIM_LOST");
        }
        await connection.commit();
        transaction = false;
        return { kind: "claimed", claimTokenHash };
      }

      const claimTokenHash = sha256(this.#claimTokenFactory());
      const leaseExpiresAt = new Date(
        now.getTime() + this.#claimLeaseSeconds * 1_000
      ).toISOString();
      await connection.query(
        `INSERT INTO acquisition_tool_results
         (owner_id, team_id, tool_name, idempotency_key_hash, actor_id,
          session_id, request_hash, claim_token_hash, lease_expires_at,
          attempt_count, state, result_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)`,
        [
          input.ownerId,
          input.teamId,
          input.toolName,
          keyHash,
          input.actorId,
          input.sessionId,
          input.requestHash,
          claimTokenHash,
          mysqlDate(leaseExpiresAt),
          null,
          mysqlDate(now.toISOString()),
          null
        ]
      );
      await connection.commit();
      transaction = false;
      return { kind: "claimed", claimTokenHash };
    } catch (error) {
      if (transaction) {
        await connection.rollback();
        transaction = false;
      }
      throw error;
    } finally {
      try {
        if (locked) {
          await connection.query(
            "SELECT RELEASE_LOCK(?) AS lock_released",
            [lockName]
          );
        }
      } finally {
        connection.release();
      }
    }
  }
}

const TOOL_NAMES = new Set<string>(ACQUISITION_AGENT_TOOL_NAMES);

function validateAuditRecord(record: AcquisitionToolAuditRecord) {
  requireScope(record);
  requireText(record.id, "audit.id", 160);
  requireText(record.actorId, "audit.actorId", 100);
  requireText(record.sessionId, "audit.sessionId", 200);
  if (!TOOL_NAMES.has(record.toolName)) {
    throw new TypeError("audit.toolName is invalid");
  }
  for (const [name, value] of [
    ["toolCallIdHash", record.toolCallIdHash],
    ["idempotencyKeyHash", record.idempotencyKeyHash],
    ["parameterHash", record.parameterHash]
  ] as const) {
    if (!/^[a-f0-9]{64}$/i.test(value)) {
      throw new TypeError(`audit.${name} is invalid`);
    }
  }
  if (record.resultHash !== null
    && !/^[a-f0-9]{64}$/i.test(record.resultHash)) {
    throw new TypeError("audit.resultHash is invalid");
  }
  if (!["succeeded", "failed", "aborted"].includes(record.status)) {
    throw new TypeError("audit.status is invalid");
  }
  if (record.status === "succeeded") {
    if (record.resultHash === null || record.errorCode !== null) {
      throw new TypeError("audit successful result is invalid");
    }
  } else if (record.resultHash !== null
    || typeof record.errorCode !== "string"
    || !record.errorCode.trim()) {
    throw new TypeError("audit failed result is invalid");
  }
  const startedAt = new Date(record.startedAt).getTime();
  const completedAt = new Date(record.completedAt).getTime();
  if (!Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt) {
    throw new TypeError("audit timestamps are invalid");
  }
}

export class InMemoryAcquisitionToolAuditLedgerAdapter
implements AcquisitionToolAuditLedger {
  readonly #records: AcquisitionToolAuditRecord[] = [];

  async append(record: AcquisitionToolAuditRecord) {
    validateAuditRecord(record);
    this.#records.push(clone(record));
  }

  async list(scope: AcquisitionToolAuditScope) {
    requireScope(scope);
    requireText(scope.sessionId, "sessionId", 200);
    return this.#records
      .filter((record) =>
        record.ownerId === scope.ownerId
        && record.teamId === scope.teamId
        && record.sessionId === scope.sessionId
      )
      .map(clone);
  }
}

function auditRecordFromRow(row: MysqlRow): AcquisitionToolAuditRecord {
  const resultHash = row.result_hash === null
    || row.result_hash === undefined
    ? null
    : String(row.result_hash);
  const errorCode = row.error_code === null
    || row.error_code === undefined
    ? null
    : String(row.error_code);
  const record: AcquisitionToolAuditRecord = {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    teamId: String(row.team_id ?? ""),
    actorId: String(row.actor_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    toolName: String(
      row.tool_name ?? ""
    ) as AcquisitionToolAuditRecord["toolName"],
    toolCallIdHash: String(row.tool_call_id_hash ?? ""),
    idempotencyKeyHash: String(row.idempotency_key_hash ?? ""),
    parameterHash: String(row.parameter_hash ?? ""),
    resultHash,
    status: String(row.status ?? "") as AcquisitionToolAuditRecord["status"],
    errorCode,
    startedAt: isoDate(row.started_at, "tool_audit_started"),
    completedAt: isoDate(row.completed_at, "tool_audit_completed")
  };
  validateAuditRecord(record);
  return record;
}

export class MysqlAcquisitionToolAuditStore
implements AcquisitionToolAuditLedger {
  constructor(private readonly pool: mysql.Pool) {}

  async append(record: AcquisitionToolAuditRecord) {
    validateAuditRecord(record);
    await this.pool.query(
      `INSERT INTO acquisition_tool_audit
       (id, owner_id, team_id, actor_id, session_id, tool_name,
        tool_call_id_hash, idempotency_key_hash, parameter_hash, result_hash,
        status, error_code, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.actorId,
        record.sessionId,
        record.toolName,
        record.toolCallIdHash,
        record.idempotencyKeyHash,
        record.parameterHash,
        record.resultHash,
        record.status,
        record.errorCode,
        mysqlDate(record.startedAt),
        mysqlDate(record.completedAt)
      ]
    );
  }

  async list(scope: AcquisitionToolAuditScope) {
    requireScope(scope);
    requireText(scope.sessionId, "sessionId", 200);
    const result = await rows(
      this.pool,
      `SELECT id, owner_id, team_id, actor_id, session_id, tool_name,
              tool_call_id_hash, idempotency_key_hash, parameter_hash,
              result_hash, status, error_code, started_at, completed_at
       FROM acquisition_tool_audit
       WHERE owner_id = ? AND team_id = ? AND session_id = ?
       ORDER BY started_at, id`,
      [scope.ownerId, scope.teamId, scope.sessionId]
    );
    return result.map((row) => {
      const record = auditRecordFromRow(row);
      if (record.ownerId !== scope.ownerId
        || record.teamId !== scope.teamId
        || record.sessionId !== scope.sessionId) {
        throw new Error(
          "ACQUISITION_TOOL_SUPPORT_MYSQL_INTEGRITY:tool_audit:scope"
        );
      }
      return record;
    });
  }
}

export {
  InMemoryAcquisitionCandidateDirectory as InMemoryAcquisitionCandidateDirectoryRepository,
  MysqlAcquisitionCandidateDirectory as MysqlAcquisitionCandidateDirectoryRepository,
  MysqlAcquisitionPriorityCandidateRepository as MysqlAcquisitionPriorityCandidatePortAdapter,
  InMemoryAcquisitionReviewTaskRepository as InMemoryAcquisitionReviewTaskPortAdapter,
  MysqlAcquisitionReviewTaskRepository as MysqlAcquisitionReviewTaskPortAdapter,
  MysqlAcquisitionActionExecutionRepository as MysqlAcquisitionActionExecutionPortAdapter,
  InMemoryAcquisitionToolResultLedger as InMemoryAcquisitionToolResultLedgerRepository,
  MysqlAcquisitionToolResultLedger as MysqlAcquisitionToolResultLedgerRepository
};
