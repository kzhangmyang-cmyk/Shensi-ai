import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  AdvisorEntityRef,
  AdvisorEvidenceRef,
  AdvisorMetricRef,
  AdvisorRecommendedAction,
  CandidateAction,
  ConsensusReport,
  FinancialDataGapCode,
  FinancialDataGapSourceType,
  FinancialCouncilActionKind,
  FinancialCouncilFinding,
  FinancialCouncilRun,
  FinancialCouncilRunStatus,
  FinancialSnapshotView,
  GrowthRoiSliceKey
} from "./growth-contract-types.js";

const hash = `sha256:${"a".repeat(64)}` as const;

const fixtures = {
  action: {
    kind: "create_quote_approval_task",
    quoteVersionId: "quote-version-1",
    quoteVersionRevision: 2
  } satisfies AdvisorRecommendedAction,
  metric: {
    kind: "financial_data_gap",
    gapCode: "missing_cogs",
    sourceType: "financial_fact",
    sourceId: "fact-1",
    sourceSnapshotHash: hash,
    cohortId: null,
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z"
  } satisfies AdvisorMetricRef,
  evidence: {
    kind: "roi_snapshot",
    closureVersionId: "closure-1",
    version: 1,
    sliceKey: "plan:plan-1",
    calculationHash: hash
  } satisfies AdvisorEvidenceRef,
  entity: {
    kind: "deal",
    id: "deal-1",
    quoteVersionId: "quote-version-1",
    dealContentHash: hash,
    bindingHashSchemaVersion: "commercial-binding.v1",
    dealAuthorityRevision: null
  } satisfies AdvisorEntityRef,
  sliceKey: "all" satisfies GrowthRoiSliceKey,
  gapCode: "missing_cogs" satisfies FinancialDataGapCode,
  sourceType: "financial_fact" satisfies FinancialDataGapSourceType,
  financialCouncilAction: {
    actionId: "action-1",
    kind: "collect_receivable",
    sourceFindingIds: ["finding-1"],
    ownerRole: "cashflow",
    subjectRef: null,
    explanation: "Collect an overdue receivable.",
    durationDays: 7,
    prerequisites: [],
    mutuallyExclusiveWith: [],
    cashImpact: { conservative: 100, base: 200, optimistic: 300 },
    profitImpact: { conservative: 0, base: 0, optimistic: 0 },
    riskReductionBps: { conservative: -100, base: 0, optimistic: 100 },
    budgetCostMinor: 0,
    capacityUnits: 1,
    confidenceBps: 9000,
    requiredCapabilities: ["finance.council.approve"],
    requiresHumanApproval: true
  } satisfies CandidateAction,
  financialCouncilActionKind: "collect_receivable" satisfies FinancialCouncilActionKind,
  financialCouncilRunStatus: "awaiting_approval" satisfies FinancialCouncilRunStatus
};

// These compile-time-only fixtures prove the aliases stay closed.
// @ts-expect-error unrelated slice prefixes are outside the frozen alias
const invalidSlice: GrowthRoiSliceKey = "cohort:cohort-1";
// @ts-expect-error unknown gap codes are not part of the frozen union
const invalidGapCode: FinancialDataGapCode = "missing_verified_cost";
// @ts-expect-error generic entity refs are deliberately forbidden
const invalidEntity: AdvisorEntityRef = { kind: "candidate", id: "candidate-1" };
// @ts-expect-error arbitrary tools are deliberately outside the frozen action shape
const invalidFinancialCouncilAction: CandidateAction = { ...fixtures.financialCouncilAction, execute: "payment" };
// @ts-expect-error automated execution is never a valid candidate action
const invalidApproval: CandidateAction = { ...fixtures.financialCouncilAction, requiresHumanApproval: false };
const financialCouncilRun = {} as FinancialCouncilRun;
const financialCouncilFinding = {} as FinancialCouncilFinding;
const financialSnapshot = {} as FinancialSnapshotView;
const financialConsensus = {} as ConsensusReport;
// @ts-expect-error consensus reports cannot be untyped public values
const invalidConsensusInRun: FinancialCouncilRun = { ...financialCouncilRun, consensusReport: "opaque" };
// @ts-expect-error evidence sources are a closed public union
const invalidEvidenceSource: FinancialCouncilFinding = { ...financialCouncilFinding, evidenceRefs: [{ source: "tool", sourceId: "source-1", contentHash: hash }] };
// @ts-expect-error snapshot sources are a closed public union
const invalidSnapshotSource: FinancialSnapshotView = { ...financialSnapshot, sourceVersions: [{ source: "tool", sourceId: "source-1", version: 1, contentHash: hash }] };
// @ts-expect-error conflict kinds are a closed public union
const invalidConflictKind: ConsensusReport = { ...financialConsensus, unresolvedConflicts: [{ conflictId: "conflict-1", type: "tool", findingIds: ["finding-1"], status: "unresolved" }] };
void [invalidSlice, invalidGapCode, invalidEntity, invalidFinancialCouncilAction, invalidApproval, invalidConsensusInRun, invalidEvidenceSource, invalidSnapshotSource, invalidConflictKind];

test("canonical Growth union fixtures compile with closed negative branches", () => {
  execFileSync(fileURLToPath(new URL(
    "../../node_modules/.bin/tsc",
    import.meta.url
  )), [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--allowSyntheticDefaultImports",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--target", "ES2022",
    fileURLToPath(import.meta.url)
  ], { stdio: "pipe" });
});

test("canonical Growth union fixtures conform to their released JSON Schema branches", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/advisor-recommendation.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaRoot = new URL("../../contracts/json-schema/", import.meta.url);
  for (const filename of await readdir(schemaRoot)) {
    if (!filename.endsWith(".json")) continue;
    const document = JSON.parse(await readFile(new URL(filename, schemaRoot), "utf8"));
    ajv.addSchema(document);
  }
  for (const [fixtureName, definitionName] of [
    ["action", "AdvisorRecommendedAction"],
    ["metric", "AdvisorMetricRef"],
    ["evidence", "AdvisorEvidenceRef"],
    ["entity", "AdvisorEntityRef"]
  ] as const) {
    const validate = ajv.compile({
      $ref: `${schema.$id}#/$defs/${definitionName}`
    });
    assert.equal(validate(fixtures[fixtureName]), true, JSON.stringify(validate.errors));
  }
});

test("canonical scalar aliases match the released closed values", () => {
  assert.deepEqual(
    [fixtures.sliceKey, fixtures.gapCode, fixtures.sourceType, fixtures.financialCouncilActionKind, fixtures.financialCouncilRunStatus],
    ["all", "missing_cogs", "financial_fact", "collect_receivable", "awaiting_approval"]
  );
});
