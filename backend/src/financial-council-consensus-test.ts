import assert from "node:assert/strict";
import test from "node:test";
import { buildConsensus } from "./financial-council-consensus.js";
import {
  financialCouncilCanonicalHash
} from "./financial-council-domain.js";
import type { FinancialCouncilAuditGraph } from
  "./financial-council-audit.js";
import type { FinancialCouncilFindingDisposition } from
  "./financial-council-repository.js";
import type {
  FinancialCouncilDataGap,
  FinancialCouncilFinding
} from "./growth-contract-types.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;
const CREATED_AT = "2026-08-16T10:00:00.000Z";

function finding(
  findingId: string,
  severity: FinancialCouncilFinding["severity"],
  missingData: readonly FinancialCouncilDataGap[] = []
): FinancialCouncilFinding {
  return Object.freeze({
    findingId,
    runId: "run-consensus",
    snapshotId: "snapshot-consensus",
    agentRole: "finance",
    conclusion: "risk_hypothesis",
    evidenceRefs: Object.freeze([{
      source: "business_report",
      sourceId: `evidence-${findingId}`,
      contentHash: HASH_A
    }]),
    formulaRef: null,
    confidenceBps: 7_500,
    severity,
    assumptions: Object.freeze([]),
    missingData: Object.freeze([...missingData]),
    candidateActionIds: Object.freeze([])
  });
}

function auditFixture() {
  const findings = [
    finding("finding-accepted", "warning"),
    finding("finding-minority", "critical", [{
      code: "missing_cogs",
      source: "business_report",
      sourceId: null,
      description: "cogs evidence missing"
    }]),
    finding("finding-rejected", "warning"),
    finding("finding-unresolved-a", "critical"),
    finding("finding-unresolved-b", "critical")
  ] as const;
  const riskEdge = {
    edgeId: HASH_A,
    kind: "risk_preference" as const,
    findingIds: ["finding-accepted", "finding-minority"] as const,
    sharedRefs: ["subject:cash"],
    status: "unresolved" as const,
    validatorReason: "different risk preference"
  };
  const formulaEdge = {
    edgeId: HASH_B,
    kind: "formula" as const,
    findingIds: ["finding-unresolved-a", "finding-unresolved-b"] as const,
    sharedRefs: ["formula-input:one"],
    status: "unresolved" as const,
    validatorReason: "formula result mismatch"
  };
  const graphPreimage = {
    workspaceId: "ws-1",
    runId: "run-consensus",
    snapshotId: "snapshot-consensus",
    snapshotHash: HASH_C,
    edges: [formulaEdge, riskEdge]
  };
  const graphHash = financialCouncilCanonicalHash(graphPreimage);
  const graph: FinancialCouncilAuditGraph = Object.freeze({
    graphId: graphHash,
    ...graphPreimage,
    edges: Object.freeze(graphPreimage.edges),
    graphHash
  });
  const disposition = (
    findingId: string,
    status: FinancialCouncilFindingDisposition["status"],
    blockingConflictIds: readonly `sha256:${string}`[]
  ): FinancialCouncilFindingDisposition => {
    const base = {
      workspaceId: "ws-1",
      runId: graph.runId,
      snapshotId: graph.snapshotId,
      snapshotHash: graph.snapshotHash,
      graphId: graph.graphId,
      findingId,
      role: "finance" as const,
      status,
      blockingConflictIds: Object.freeze([...blockingConflictIds]),
      updatedAt: CREATED_AT
    };
    return Object.freeze({
      ...base,
      dispositionHash: financialCouncilCanonicalHash(base)
    });
  };
  const dispositions = [
    disposition("finding-accepted", "upheld", []),
    disposition("finding-minority", "upheld", [riskEdge.edgeId]),
    disposition("finding-rejected", "withdrawn", []),
    disposition("finding-unresolved-a", "upheld", [formulaEdge.edgeId]),
    disposition("finding-unresolved-b", "unresolved", [formulaEdge.edgeId])
  ];
  return {
    graph,
    findings,
    dispositions,
    dataGaps: [{
      code: "import_requires_review" as const,
      source: "roi" as const,
      sourceId: null,
      description: "actual roi missing"
    }, {
      code: "missing_cogs" as const,
      source: "business_report" as const,
      sourceId: null,
      description: "cogs evidence missing"
    }],
    createdAt: CREATED_AT
  };
}

test("every audited finding is partitioned exactly once without losing critical conflicts", () => {
  const fixture = auditFixture();
  const report = buildConsensus(fixture);
  const unresolvedIds = new Set(report.unresolvedConflicts.flatMap(
    (conflict) => conflict.findingIds
  ));
  const memberships = new Map<string, number>();
  for (const id of [
    ...report.acceptedFindings.map((row) => row.findingId),
    ...report.minorityFindings.map((row) => row.findingId),
    ...report.rejectedFindings.map((row) => row.findingId),
    ...unresolvedIds
  ]) memberships.set(id, (memberships.get(id) ?? 0) + 1);

  assert.deepEqual([...memberships.entries()].sort(), [
    ["finding-accepted", 1],
    ["finding-minority", 1],
    ["finding-rejected", 1],
    ["finding-unresolved-a", 1],
    ["finding-unresolved-b", 1]
  ]);
  assert.deepEqual(report.acceptedFindings.map((row) => row.findingId),
    ["finding-accepted"]);
  assert.deepEqual(report.minorityFindings.map((row) => row.findingId),
    ["finding-minority"]);
  assert.deepEqual(report.rejectedFindings.map((row) => row.findingId),
    ["finding-rejected"]);
  assert.deepEqual(report.unresolvedConflicts, [{
    conflictId: HASH_B,
    type: "formula",
    findingIds: ["finding-unresolved-a", "finding-unresolved-b"],
    status: "unresolved"
  }]);
  assert.equal(report.inputVersionHash, fixture.graph.graphHash);
});

test("consensus aggregation is canonical under reordered inputs and deduplicates every data gap", () => {
  const fixture = auditFixture();
  const first = buildConsensus(fixture);
  const reordered = buildConsensus({
    ...fixture,
    findings: [...fixture.findings].reverse(),
    dispositions: [...fixture.dispositions].reverse(),
    dataGaps: [...fixture.dataGaps].reverse()
  });

  assert.deepEqual(reordered, first);
  assert.deepEqual(first.dataGaps, [{
    code: "missing_cogs",
    source: "business_report",
    sourceId: null,
    description: "cogs evidence missing"
  }, {
    code: "import_requires_review",
    source: "roi",
    sourceId: null,
    description: "actual roi missing"
  }]);
  assert.match(first.overallDiagnosis, /finding-accepted/u);
});

test("consensus fails closed for incomplete or cross-audit disposition inputs", () => {
  const fixture = auditFixture();
  assert.throws(() => buildConsensus({
    ...fixture,
    dispositions: fixture.dispositions.slice(1)
  }), /financial_council_consensus_invalid/u);
  assert.throws(() => buildConsensus({
    ...fixture,
    dispositions: fixture.dispositions.map((item, index) => index === 0
      ? { ...item, graphId: HASH_C }
      : item)
  }), /financial_council_consensus_invalid/u);
});
