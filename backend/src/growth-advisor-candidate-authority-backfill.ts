import { createHash } from "node:crypto";
import type {
  AdvisorCandidateAuthorityProjectionInput
} from "./growth-advisor-candidate-authority-projection.js";

export interface AdvisorAuthorityBackfillEvidenceReference {
  evidenceId: string;
  contentHash: string;
  fetchedAt: string;
}

export interface AdvisorAuthorityBackfillQualificationRow {
  ownerId: string;
  teamId: string;
  candidateId: string;
  qualificationDecisionId: string;
  qualificationDecisionVersion: string;
  qualificationSnapshotHash: string;
  financialValueDecisionId: string;
  financialValueDecisionVersion: string;
  financialValueInputSnapshotHash: string;
  grade: string;
  score: number;
  evidence: readonly AdvisorAuthorityBackfillEvidenceReference[];
  createdAt: string;
}

export interface AdvisorAuthorityBackfillPage {
  rows: readonly AdvisorAuthorityBackfillQualificationRow[];
  nextCursor: string | null;
}

export interface AdvisorAuthorityBackfillSource {
  listQualificationBundles(
    cursor: string | null,
    limit: number
  ): Promise<AdvisorAuthorityBackfillPage>;
  countPending(): Promise<number>;
}

export interface AdvisorAuthorityBackfillTarget {
  /** Appends one deployment-time authority event unless an identical
   *  qualification snapshot hash already exists for the workspace/candidate. */
  appendAuthorityIfMissing(
    input: AdvisorCandidateAuthorityProjectionInput
  ): Promise<{ appended: boolean }>;
}

export interface AdvisorAuthorityBackfillCursorState {
  runHash: string;
  cursor: string | null;
}

export interface AdvisorAuthorityBackfillCursorStore {
  load(): Promise<AdvisorAuthorityBackfillCursorState | null>;
  save(state: AdvisorAuthorityBackfillCursorState): Promise<void>;
}

export interface AdvisorAuthorityBackfillResult {
  appended: number;
  skipped: number;
  unresolved: number;
  runHash: string;
  cursor: string | null;
  completed: boolean;
}

function rowIdentity(row: AdvisorAuthorityBackfillQualificationRow): string {
  return JSON.stringify([
    row.ownerId,
    row.teamId,
    row.candidateId,
    row.qualificationDecisionId,
    row.qualificationDecisionVersion,
    row.qualificationSnapshotHash
  ]);
}

/** Explicit, resumable deployment backfill. Legacy qualification rows get
 *  deployment-time authority stamps from the shared workspace temporal
 *  barrier; source qualification timestamps are never treated as authority
 *  recording time. The cursor and a stable run hash are persisted after every
 *  page, so an interrupted run resumes without re-appending. */
export async function backfillGrowthAdvisorCandidateAuthority(input: {
  source: AdvisorAuthorityBackfillSource;
  target: AdvisorAuthorityBackfillTarget;
  cursors: AdvisorAuthorityBackfillCursorStore;
  resolveWorkspace(
    row: AdvisorAuthorityBackfillQualificationRow
  ): Promise<{ workspaceId: string; bindingRevision: string } | null>;
  limit?: number;
  now?: () => string;
}): Promise<AdvisorAuthorityBackfillResult> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const startedAt = (input.now ?? (() => new Date().toISOString()))();
  const previous = await input.cursors.load();
  let cursor: string | null = previous?.cursor ?? null;
  let appended = 0;
  let skipped = 0;
  let unresolved = 0;
  let pageCount = 0;
  const digest = createHash("sha256");
  digest.update(JSON.stringify({ startedAt, previousRunHash: previous?.runHash ?? null }));
  while (pageCount < 10_000) {
    pageCount += 1;
    const page = await input.source.listQualificationBundles(cursor, limit);
    const rows = page.rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      digest.update(rowIdentity(row));
      const workspace = await input.resolveWorkspace(row);
      if (!workspace || workspace.workspaceId === "all") {
        unresolved += 1;
        continue;
      }
      const result = await input.target.appendAuthorityIfMissing({
        workspaceId: workspace.workspaceId,
        workspaceBindingRevision: workspace.bindingRevision,
        candidateId: row.candidateId,
        ownerId: row.ownerId,
        teamId: row.teamId,
        qualificationDecisionId: row.qualificationDecisionId,
        qualificationDecisionVersion: row.qualificationDecisionVersion,
        qualificationSnapshotHash: row.qualificationSnapshotHash,
        financialValueDecisionId: row.financialValueDecisionId,
        financialValueDecisionVersion: row.financialValueDecisionVersion,
        financialValueInputSnapshotHash:
          row.financialValueInputSnapshotHash,
        grade: row.grade,
        score: row.score,
        evidence: Object.freeze(row.evidence.map((item) =>
          Object.freeze({ ...item })))
      });
      if (result.appended) appended += 1;
      else skipped += 1;
    }
    cursor = page.nextCursor;
    await input.cursors.save({
      runHash: `sha256:${digest.copy().digest("hex")}`,
      cursor
    });
    if (cursor === null) break;
  }
  const runHash = `sha256:${digest.digest("hex")}`;
  return {
    appended,
    skipped,
    unresolved,
    runHash,
    cursor,
    completed: cursor === null
  };
}

export function advisorAuthorityBackfillRunHash(
  rows: readonly AdvisorAuthorityBackfillQualificationRow[]
): string {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(rowIdentity(row));
  return `sha256:${digest.digest("hex")}`;
}

export function advisorAuthorityWorkspaceBindingRevisionForLegacy(
  bindingRevision: string
): string {
  return bindingRevision;
}
