import type mysql from "mysql2/promise";
import { growthMysqlDate } from "./growth-temporal-barrier-mysql-repository.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type {
  AdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import type {
  AdvisorCandidateEvidenceAsOfReader,
  AdvisorCandidateEvidenceAsOfSnapshot,
  AdvisorVisibilityResolver,
  CandidateDisplayNameSource,
  CohortBindingVisibilityRow,
  CohortBindingVisibilitySource,
  PriorityCandidateReader,
  PriorityCustomerView,
  QuoteBindingVisibilityRow,
  QuoteBindingVisibilitySource
} from "./growth-advisor-query.js";
import {
  DefaultAdvisorVisibilityResolver,
  DefaultPriorityCandidateReader
} from "./growth-advisor-query.js";

type MysqlRow = Record<string, unknown>;

export class MysqlQuoteBindingVisibilitySource
implements QuoteBindingVisibilitySource {
  constructor(private readonly pool: mysql.Pool) {}

  async listVisibleBindings(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<readonly QuoteBindingVisibilityRow[]> {
    if (cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const [rows] = await this.pool.query(
      `SELECT qv.id AS quote_version_id,
              cbs.candidate_id, cbs.customer_id, cbs.deal_id,
              qv.created_by AS sales_owner_actor_id,
              qv.workspace_id AS team_id
       FROM quote_versions qv
       INNER JOIN commercial_binding_snapshots cbs
         ON cbs.workspace_id = qv.workspace_id
        AND cbs.quote_case_id = qv.quote_case_id
       WHERE qv.workspace_id = ?
         AND qv.version_kind = 'formal'
         AND qv.recorded_at <= ?`,
      [context.workspaceId, growthMysqlDate(cutoff.effectiveAsOf)]
    );
    return Object.freeze((rows as MysqlRow[]).map((row) =>
      Object.freeze({
        quoteVersionId: String(row.quote_version_id),
        candidateId: String(row.candidate_id),
        customerId: String(row.customer_id),
        dealId: String(row.deal_id),
        salesOwnerActorId: String(row.sales_owner_actor_id),
        teamId: String(row.team_id)
      })));
  }
}

export class MysqlCohortBindingVisibilitySource
implements CohortBindingVisibilitySource {
  constructor(private readonly pool: mysql.Pool) {}

  async listVisibleCohorts(
    context: ActiveWorkspaceContext,
    _cutoff: GrowthSealedReadCutoff,
    candidateIds: readonly string[]
  ): Promise<readonly CohortBindingVisibilityRow[]> {
    if (candidateIds.length === 0) return Object.freeze([]);
    const placeholders = candidateIds.map(() => "?").join(", ");
    const [rows] = await this.pool.query(
      `SELECT mv.cohort_id, mv.candidate_id,
              mv.workspace_id AS team_id
       FROM acquisition_cohort_membership_versions mv
       INNER JOIN acquisition_cohort_membership_heads h
         ON h.workspace_id = mv.workspace_id
        AND h.platform = mv.platform
        AND h.subject_stable_key = mv.subject_stable_key
        AND h.head_version_id = mv.id
       WHERE mv.workspace_id = ?
         AND mv.candidate_id IN (${placeholders})`,
      [context.workspaceId, ...candidateIds]
    );
    const byCohort = new Map<string, CohortBindingVisibilityRow>();
    for (const row of rows as MysqlRow[]) {
      const cohortId = String(row.cohort_id);
      const mutable = byCohort.get(cohortId) ?? {
        cohortId,
        candidateIds: Object.freeze([]) as readonly string[],
        dealIds: Object.freeze([]) as readonly string[],
        customerIds: Object.freeze([]) as readonly string[],
        teamId: String(row.team_id)
      };
      const candidateId = String(row.candidate_id);
      const candidateIds = [...mutable.candidateIds];
      if (!candidateIds.includes(candidateId)) {
        candidateIds.push(candidateId);
      }
      byCohort.set(cohortId, {
        cohortId,
        candidateIds: Object.freeze(candidateIds),
        dealIds: mutable.dealIds,
        customerIds: mutable.customerIds,
        teamId: mutable.teamId
      });
    }
    return Object.freeze([...byCohort.values()].map((row) =>
      Object.freeze({
        cohortId: row.cohortId,
        candidateIds: Object.freeze([...row.candidateIds].sort()),
        dealIds: Object.freeze([...row.dealIds].sort()),
        customerIds: Object.freeze([...row.customerIds].sort()),
        teamId: row.teamId
      })));
  }
}

export class MysqlCandidateDisplayNameSource
implements CandidateDisplayNameSource {
  constructor(private readonly pool: mysql.Pool) {}

  async listDisplayNames(
    workspaceId: string,
    candidateIds: readonly string[]
  ): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    if (candidateIds.length === 0) return names;
    const placeholders = candidateIds.map(() => "?").join(", ");
    const [rows] = await this.pool.query(
      `SELECT id, payload_json
       FROM acquisition_candidates
       WHERE id IN (${placeholders})`,
      [...candidateIds]
    );
    for (const row of rows as MysqlRow[]) {
      const payload = JSON.parse(String(row.payload_json)) as {
        profile?: { name?: string };
      };
      names.set(
        String(row.id),
        payload.profile?.name?.trim() || String(row.id)
      );
    }
    return names;
  }
}

export interface MysqlAdvisorQueryPorts {
  readonly pool: mysql.Pool;
  readonly candidateAuthority: AdvisorCandidateAuthorityRepository;
}

export function createMysqlAdvisorVisibilityResolver(
  ports: MysqlAdvisorQueryPorts
): AdvisorVisibilityResolver {
  return new DefaultAdvisorVisibilityResolver({
    candidateAuthority: ports.candidateAuthority,
    quoteBindings: new MysqlQuoteBindingVisibilitySource(ports.pool),
    cohortBindings: new MysqlCohortBindingVisibilitySource(ports.pool)
  });
}

export interface MysqlAdvisorCandidateReaders {
  readonly priorityCandidates: PriorityCandidateReader;
  readonly candidateEvidence: AdvisorCandidateEvidenceAsOfReader;
}

export function createMysqlAdvisorCandidateReaders(
  ports: MysqlAdvisorQueryPorts
): MysqlAdvisorCandidateReaders {
  const reader = new DefaultPriorityCandidateReader({
    candidateAuthority: ports.candidateAuthority,
    quoteBindings: new MysqlQuoteBindingVisibilitySource(ports.pool),
    displayNames: new MysqlCandidateDisplayNameSource(ports.pool)
  });
  return Object.freeze({
    priorityCandidates: reader,
    candidateEvidence: reader
  });
}

export type MysqlAdvisorEvidenceSnapshot = AdvisorCandidateEvidenceAsOfSnapshot;
export type MysqlAdvisorPriorityCustomerView = PriorityCustomerView;
