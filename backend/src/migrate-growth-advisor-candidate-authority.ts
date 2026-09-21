import mysql from "mysql2/promise";
import {
  MysqlAdvisorCandidateAuthorityRepository,
  ensureAdvisorCandidateAuthorityMysqlSchema
} from "./growth-advisor-candidate-authority-mysql-repository.js";
import {
  backfillGrowthAdvisorCandidateAuthority,
  type AdvisorAuthorityBackfillCursorState,
  type AdvisorAuthorityBackfillPage,
  type AdvisorAuthorityBackfillQualificationRow,
  type AdvisorAuthorityBackfillSource
} from "./growth-advisor-candidate-authority-backfill.js";
import {
  MysqlGrowthTemporalTransactionRunner,
  MysqlGrowthTemporalBarrier
} from "./growth-temporal-barrier-mysql-repository.js";
import { createMysqlStore } from "./mysql-store.js";
import { createGrowthAcquisitionWorkspaceResolver } from "./growth-workspace-context.js";

type MysqlRow = Record<string, unknown>;

class MysqlAdvisorAuthorityBackfillCursorStore {
  constructor(private readonly pool: mysql.Pool) {}

  async load(): Promise<AdvisorAuthorityBackfillCursorState | null> {
    const [rows] = await this.pool.query(
      `SELECT run_hash, cursor_value
       FROM advisor_candidate_authority_backfill_runs
       WHERE run_key = 'candidate-authority'`
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) return null;
    return {
      runHash: String(row.run_hash) as `sha256:${string}`,
      cursor: row.cursor_value === null ? null : String(row.cursor_value)
    };
  }

  async save(state: AdvisorAuthorityBackfillCursorState): Promise<void> {
    await this.pool.query(
      `INSERT INTO advisor_candidate_authority_backfill_runs
       (run_key, run_hash, cursor_value, updated_at)
       VALUES ('candidate-authority', ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         run_hash = VALUES(run_hash),
         cursor_value = VALUES(cursor_value),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [state.runHash, state.cursor]
    );
  }
}

class MysqlAdvisorAuthorityBackfillSource
implements AdvisorAuthorityBackfillSource {
  constructor(private readonly pool: mysql.Pool) {}

  async listQualificationBundles(
    cursor: string | null,
    limit: number
  ): Promise<AdvisorAuthorityBackfillPage> {
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("advisor_backfill_cursor_invalid");
    }
    const [decisionRows] = await this.pool.query(
      `SELECT q.id AS qualification_id, q.owner_id, q.team_id,
              q.candidate_id, q.payload_json AS qualification_payload,
              f.payload_json AS financial_payload
       FROM acquisition_qualification_decisions q
       INNER JOIN acquisition_financial_values f
         ON f.candidate_id = q.candidate_id
        AND f.owner_id = q.owner_id
        AND f.team_id = q.team_id
        AND f.qualification_decision_id = q.id
       ORDER BY q.owner_id, q.team_id, q.candidate_id,
                q.created_at, q.id
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const rows: AdvisorAuthorityBackfillQualificationRow[] = [];
    const evidenceIds = new Map<string, { ownerId: string; teamId: string }>();
    for (const decisionRow of decisionRows as MysqlRow[]) {
      const payload = JSON.parse(String(decisionRow.qualification_payload)) as {
        id: string;
        candidateId: string;
        decisionVersion: string;
        grade: string;
        score: number;
        snapshotHash: string;
        evidence: Array<{ evidenceId: string }>;
      };
      const financial = JSON.parse(String(decisionRow.financial_payload)) as {
        id: string;
        version: string;
        inputSnapshotHash: string;
      };
      const ownerId = String(decisionRow.owner_id);
      const teamId = String(decisionRow.team_id);
      for (const reference of payload.evidence) {
        evidenceIds.set(`${ownerId}\u0000${teamId}\u0000${reference.evidenceId}`, {
          ownerId,
          teamId
        });
      }
      rows.push({
        ownerId,
        teamId,
        candidateId: payload.candidateId,
        qualificationDecisionId: payload.id,
        qualificationDecisionVersion: payload.decisionVersion,
        qualificationSnapshotHash: payload.snapshotHash,
        financialValueDecisionId: financial.id,
        financialValueDecisionVersion: financial.version,
        financialValueInputSnapshotHash: financial.inputSnapshotHash,
        grade: payload.grade,
        score: payload.score,
        evidence: [],
        createdAt: String(decisionRow.created_at)
      });
    }
    const evidence = await this.loadEvidence(evidenceIds);
    for (const row of rows) {
      const payload = JSON.parse(
        String(
          (decisionRows as MysqlRow[])
            .find((item) =>
              String(item.qualification_id) === row.qualificationDecisionId
              && String(item.candidate_id) === row.candidateId)
            ?.qualification_payload
        )
      ) as { evidence: Array<{ evidenceId: string }> };
      row.evidence = Object.freeze(payload.evidence.map((reference) => {
        const found = evidence.get(
          `${row.ownerId}\u0000${row.teamId}\u0000${reference.evidenceId}`
        );
        return Object.freeze({
          evidenceId: reference.evidenceId,
          contentHash: found?.contentHash ?? "",
          fetchedAt: found?.fetchedAt ?? ""
        });
      }));
    }
    return {
      rows,
      nextCursor: (decisionRows as MysqlRow[]).length === limit
        ? String(offset + limit)
        : null
    };
  }

  private async loadEvidence(
    ids: Map<string, { ownerId: string; teamId: string }>
  ): Promise<Map<string, { contentHash: string; fetchedAt: string }>> {
    const result = new Map<string, { contentHash: string; fetchedAt: string }>();
    const byScope = new Map<string, string[]>();
    for (const [key, scope] of ids) {
      const scopeKey = `${scope.ownerId}\u0000${scope.teamId}`;
      const evidenceId = key.split("\u0000")[2]!;
      const list = byScope.get(scopeKey) ?? [];
      list.push(evidenceId);
      byScope.set(scopeKey, list);
    }
    for (const [scopeKey, evidenceIdList] of byScope) {
      const [ownerId, teamId] = scopeKey.split("\u0000");
      const placeholders = evidenceIdList.map(() => "?").join(", ");
      const [rows] = await this.pool.query(
        `SELECT id, payload_json, created_at
         FROM acquisition_discovery_evidence
         WHERE owner_id = ? AND team_id = ?
           AND id IN (${placeholders})`,
        [ownerId, teamId, ...evidenceIdList]
      );
      for (const row of rows as MysqlRow[]) {
        const payload = JSON.parse(String(row.payload_json)) as {
          contentHash?: string;
          fetchedAt?: string;
        };
        result.set(`${ownerId}\u0000${teamId}\u0000${String(row.id)}`, {
          contentHash: payload.contentHash ?? "",
          fetchedAt: payload.fetchedAt ?? String(row.created_at)
        });
      }
    }
    return result;
  }

  async countPending(): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS total
       FROM acquisition_qualification_decisions q
       INNER JOIN acquisition_financial_values f
         ON f.candidate_id = q.candidate_id
        AND f.owner_id = q.owner_id
        AND f.team_id = q.team_id
        AND f.qualification_decision_id = q.id`
    );
    return Number((rows as MysqlRow[])[0]?.total ?? 0);
  }
}

function databaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim()
    || process.env.MYSQL_URL?.trim();
  if (!configured) {
    throw new Error(
      "advisor authority backfill requires DATABASE_URL or MYSQL_URL"
    );
  }
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("database URL must use mysql protocol");
  }
  return configured;
}

async function main(): Promise<void> {
  const pool = mysql.createPool({
    uri: databaseUrl(),
    connectionLimit: 3,
    namedPlaceholders: true,
    timezone: "Z",
    dateStrings: true
  });
  const store = await createMysqlStore({ processRole: "api" });
  try {
    await ensureAdvisorCandidateAuthorityMysqlSchema(pool);
    const transactions = new MysqlGrowthTemporalTransactionRunner(pool);
    const barrier = new MysqlGrowthTemporalBarrier(transactions);
    const authority = new MysqlAdvisorCandidateAuthorityRepository(
      pool, barrier
    );
    const resolver = createGrowthAcquisitionWorkspaceResolver({
      async resolve(scope) {
        const user = store.users.find((candidate) =>
          candidate.status === "active"
          && candidate.id === scope.ownerId
          && candidate.teamId === scope.teamId);
        if (!user || scope.teamId === "all") return null;
        return {
          workspaceId: scope.teamId,
          kind: "team" as const,
          bindingRevision: `crm-user-auth:${user.authVersion ?? 1}`
        };
      }
    });
    const source = new MysqlAdvisorAuthorityBackfillSource(pool);
    const result = await backfillGrowthAdvisorCandidateAuthority({
      source,
      target: {
        async appendAuthorityIfMissing(input) {
          const existing = await authority.getAt(
            input.workspaceId,
            input.candidateId,
            await barrier.sealReadCutoff(
              Object.freeze({
                workspaceId: input.workspaceId,
                kind: "team",
                actorId: "migration",
                role: "admin",
                teamId: input.workspaceId,
                capabilities: Object.freeze([]),
                capabilityRegistryVersion: "growth-capabilities.v1"
              }),
              new Date().toISOString()
            )
          );
          if (existing
            && existing.qualificationSnapshotHash
              === input.qualificationSnapshotHash) {
            return { appended: false };
          }
          await authority.append(input);
          return { appended: true };
        }
      },
      cursors: new MysqlAdvisorAuthorityBackfillCursorStore(pool),
      resolveWorkspace: async (row) => {
        const resolved = await resolver.resolve({
          ownerId: row.ownerId,
          teamId: row.teamId
        });
        if (!resolved) return null;
        return {
          workspaceId: resolved.workspaceId,
          bindingRevision: resolved.bindingRevision
        };
      }
    });
    console.log(JSON.stringify({
      appended: result.appended,
      skipped: result.skipped,
      unresolved: result.unresolved,
      completed: result.completed,
      runHash: result.runHash
    }));
  } finally {
    await store.close?.().catch(() => undefined);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
