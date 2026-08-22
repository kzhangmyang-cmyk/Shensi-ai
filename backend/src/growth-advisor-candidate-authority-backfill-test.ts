import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillGrowthAdvisorCandidateAuthority,
  type AdvisorAuthorityBackfillCursorState,
  type AdvisorAuthorityBackfillPage,
  type AdvisorAuthorityBackfillQualificationRow,
  type AdvisorAuthorityBackfillSource,
  type AdvisorAuthorityBackfillTarget
} from "./growth-advisor-candidate-authority-backfill.js";
import type { AdvisorCandidateAuthorityProjectionInput } from
  "./growth-advisor-candidate-authority-projection.js";

function legacyRow(
  overrides: Partial<AdvisorAuthorityBackfillQualificationRow> = {}
): AdvisorAuthorityBackfillQualificationRow {
  return {
    ownerId: "owner-1",
    teamId: "team-1",
    candidateId: "candidate-1",
    qualificationDecisionId: "qualification-1",
    qualificationDecisionVersion: "qualification-v1",
    qualificationSnapshotHash: `sha256:${"a".repeat(64)}`,
    financialValueDecisionId: "financial-value-1",
    financialValueDecisionVersion: "financial-value-v1",
    financialValueInputSnapshotHash: `sha256:${"b".repeat(64)}`,
    grade: "A",
    score: 78,
    evidence: Object.freeze([{
      evidenceId: "evidence-1",
      contentHash: `sha256:${"c".repeat(64)}`,
      fetchedAt: "2026-07-20T08:00:00.000Z"
    }]),
    createdAt: "2026-07-20T08:00:00.000Z",
    ...overrides
  };
}

function sourceFixture(
  rows: readonly AdvisorAuthorityBackfillQualificationRow[],
  pageSize = 2
): AdvisorAuthorityBackfillSource {
  return {
    async listQualificationBundles(cursor, limit) {
      const start = cursor === null ? 0 : Number(cursor);
      const page: AdvisorAuthorityBackfillPage = {
        rows: rows.slice(start, start + Math.min(limit, pageSize)),
        nextCursor: start + Math.min(limit, pageSize) < rows.length
          ? String(start + Math.min(limit, pageSize))
          : null
      };
      return page;
    },
    async countPending() {
      return rows.length;
    }
  };
}

function memoryTarget() {
  const appended: AdvisorCandidateAuthorityProjectionInput[] = [];
  const target: AdvisorAuthorityBackfillTarget = {
    async appendAuthorityIfMissing(input) {
      const duplicate = appended.some((row) =>
        row.workspaceId === input.workspaceId
        && row.candidateId === input.candidateId
        && row.qualificationSnapshotHash
          === input.qualificationSnapshotHash);
      if (duplicate) return { appended: false };
      appended.push(structuredClone(input));
      return { appended: true };
    }
  };
  return { appended, target };
}

function memoryCursors() {
  let state: AdvisorAuthorityBackfillCursorState | null = null;
  return {
    cursors: {
      async load() {
        return state ? { ...state } : null;
      },
      async save(next) {
        state = { ...next };
      }
    },
    get state() {
      return state;
    }
  };
}

test("backfill pages legacy rows in stable order and allocates deployment-time authority", async () => {
  const rows = [
    legacyRow({ candidateId: "candidate-1" }),
    legacyRow({ candidateId: "candidate-2" }),
    legacyRow({ candidateId: "candidate-3" })
  ];
  const source = sourceFixture(rows, 2);
  const { appended, target } = memoryTarget();
  const { cursors } = memoryCursors();
  const result = await backfillGrowthAdvisorCandidateAuthority({
    source,
    target,
    cursors,
    resolveWorkspace: async (row) => ({
      workspaceId: row.teamId,
      bindingRevision: `legacy:${row.teamId}`
    }),
    now: () => "2026-08-12T00:00:00.000Z"
  });
  assert.equal(result.appended, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.unresolved, 0);
  assert.equal(result.completed, true);
  assert.match(result.runHash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(
    appended.map((row) => row.candidateId),
    ["candidate-1", "candidate-2", "candidate-3"]
  );
  assert.equal(appended[0]?.workspaceBindingRevision, "legacy:team-1");
  assert.equal(appended[0]?.qualificationSnapshotHash,
    `sha256:${"a".repeat(64)}`);
});

test("backfill is resumable, idempotent and skips unresolved workspaces", async () => {
  const rows = [
    legacyRow({ candidateId: "candidate-1" }),
    legacyRow({ candidateId: "candidate-2" }),
    legacyRow({ ownerId: "owner-unmapped", teamId: "team-unmapped",
      candidateId: "candidate-3" })
  ];
  const source = sourceFixture(rows, 1);
  const { appended, target } = memoryTarget();
  const { cursors, state } = memoryCursors();
  const resolveWorkspace = async (row: AdvisorAuthorityBackfillQualificationRow) =>
    row.teamId === "team-unmapped" ? null : {
      workspaceId: row.teamId,
      bindingRevision: `legacy:${row.teamId}`
    };
  let pageCalls = 0;
  const interruptingSource: AdvisorAuthorityBackfillSource = {
    async listQualificationBundles(cursor, limit) {
      pageCalls += 1;
      if (pageCalls === 2) {
        throw new Error("simulated-interruption");
      }
      return source.listQualificationBundles(cursor, limit);
    },
    async countPending() {
      return rows.length;
    }
  };
  await assert.rejects(
    backfillGrowthAdvisorCandidateAuthority({
      source: interruptingSource,
      target, cursors,
      resolveWorkspace,
      limit: 1,
      now: () => "2026-08-12T00:00:00.000Z"
    }),
    /simulated-interruption/u
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.candidateId, "candidate-1");
  assert.notEqual(state?.cursor, null);
  const resumed = await backfillGrowthAdvisorCandidateAuthority({
    source, target, cursors,
    resolveWorkspace,
    limit: 1,
    now: () => "2026-08-12T00:00:01.000Z"
  });
  assert.equal(resumed.appended, 1);
  assert.equal(resumed.unresolved, 1);
  assert.equal(resumed.completed, true);
  assert.equal(appended.length, 2);
  assert.deepEqual(
    appended.map((row) => row.candidateId),
    ["candidate-1", "candidate-2"]
  );
});

test("backfill never fabricates source-time authority recording timestamps", async () => {
  const row = legacyRow({ createdAt: "2026-07-20T08:00:00.000Z" });
  const { appended, target } = memoryTarget();
  const { cursors } = memoryCursors();
  await backfillGrowthAdvisorCandidateAuthority({
    source: sourceFixture([row], 1),
    target,
    cursors,
    resolveWorkspace: async () => ({
      workspaceId: "team-1",
      bindingRevision: "legacy:team-1"
    }),
    now: () => "2026-08-12T00:00:00.000Z"
  });
  assert.equal(appended.length, 1);
  // The authority projection input carries only the immutable decision and
  // evidence metadata; source qualification createdAt never becomes a
  // recordedAt/temporalSequence field of the authority event.
  assert.equal("recordedAt" in (appended[0] ?? {}), false);
  assert.equal("temporalSequence" in (appended[0] ?? {}), false);
  assert.deepEqual(appended[0]?.evidence, [{
    evidenceId: "evidence-1",
    contentHash: `sha256:${"c".repeat(64)}`,
    fetchedAt: "2026-07-20T08:00:00.000Z"
  }]);
});
