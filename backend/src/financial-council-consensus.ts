import type { FinancialCouncilAuditGraph } from
  "./financial-council-audit.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilCanonicalJson,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type { FinancialCouncilFindingDisposition } from
  "./financial-council-repository.js";
import type {
  ConsensusReport,
  FinancialCouncilDataGap,
  FinancialCouncilFinding
} from "./growth-contract-types.js";

export interface BuildFinancialCouncilConsensusInput {
  readonly graph: FinancialCouncilAuditGraph;
  readonly findings: readonly FinancialCouncilFinding[];
  readonly dispositions: readonly FinancialCouncilFindingDisposition[];
  readonly dataGaps: readonly FinancialCouncilDataGap[];
  readonly createdAt: string;
}

export function buildConsensus(
  rawInput: BuildFinancialCouncilConsensusInput
): ConsensusReport {
  try {
    const input = immutableFinancialCouncilInput(rawInput);
    const { graph } = input;
    if (!Array.isArray(input.findings) || input.findings.length === 0
      || !Array.isArray(input.dispositions)
      || !Array.isArray(input.dataGaps)
      || !Number.isFinite(Date.parse(input.createdAt))) invalid();
    const findings = [...input.findings].sort((left, right) =>
      compare(left.findingId, right.findingId));
    const dispositions = [...input.dispositions].sort((left, right) =>
      compare(left.findingId, right.findingId));
    if (new Set(findings.map((item) => item.findingId)).size
        !== findings.length
      || new Set(dispositions.map((item) => item.findingId)).size
        !== dispositions.length
      || findings.length !== dispositions.length
      || findings.some((finding, index) => {
        const disposition = dispositions[index];
        return !disposition
          || finding.findingId !== disposition.findingId
          || finding.runId !== graph.runId
          || finding.snapshotId !== graph.snapshotId
          || disposition.workspaceId !== graph.workspaceId
          || disposition.runId !== graph.runId
          || disposition.snapshotId !== graph.snapshotId
          || disposition.snapshotHash !== graph.snapshotHash
          || disposition.graphId !== graph.graphId
          || disposition.role !== finding.agentRole;
      })) invalid();

    const edgeById = new Map(graph.edges.map((edge) => [edge.edgeId, edge]));
    const accepted: FinancialCouncilFinding[] = [];
    const minority: FinancialCouncilFinding[] = [];
    const rejected: FinancialCouncilFinding[] = [];
    const criticalEdgeIds = new Set<string>();
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index]!;
      const disposition = dispositions[index]!;
      const blockers = disposition.blockingConflictIds.map(
        (id: `sha256:${string}`) => {
        const edge = edgeById.get(id);
        if (!edge || !edge.findingIds.includes(finding.findingId)
          || edge.status !== "unresolved") invalid();
        return edge;
        }
      );
      if (disposition.status === "withdrawn") {
        if (blockers.length !== 0) invalid();
        rejected.push(finding);
        continue;
      }
      const critical = blockers.filter((edge: FinancialCouncilAuditGraph["edges"][number]) =>
        edge.kind !== "risk_preference");
      if (critical.length > 0) {
        for (const edge of critical) criticalEdgeIds.add(edge.edgeId);
      } else if (blockers.length > 0) {
        minority.push(finding);
      } else {
        accepted.push(finding);
      }
    }

    const unresolvedConflicts = graph.edges.filter((edge) =>
      criticalEdgeIds.has(edge.edgeId)).map((edge) => ({
      conflictId: edge.edgeId,
      type: edge.kind,
      findingIds: [...edge.findingIds].sort(compare),
      status: "unresolved" as const
    })).sort((left, right) => compare(left.conflictId, right.conflictId));
    const gaps = new Map<string, FinancialCouncilDataGap>();
    for (const gap of [
      ...input.dataGaps,
      ...findings.flatMap((finding) => finding.missingData)
    ]) gaps.set(financialCouncilCanonicalJson(gap), gap);
    const dataGaps = [...gaps.values()].sort((left, right) =>
      compare(left.source, right.source)
      || compare(left.sourceId ?? "", right.sourceId ?? "")
      || compare(left.code, right.code)
      || compare(left.description, right.description));
    const citedIds = [
      ...accepted.map((item) => item.findingId),
      ...minority.map((item) => item.findingId),
      ...unresolvedConflicts.flatMap((item) => item.findingIds)
    ];
    const overallDiagnosis = citedIds.length === 0
      ? "服务端已保留审计分区，未产生可叙述结论。"
      : `服务端已保留审计分区：${[...new Set(citedIds)]
        .sort(compare).map((id) => `[${id}]`).join("、")}。`;
    const preimage = {
      runId: graph.runId,
      snapshotId: graph.snapshotId,
      acceptedFindings: accepted,
      minorityFindings: minority,
      rejectedFindings: rejected,
      unresolvedConflicts,
      dataGaps,
      overallDiagnosis,
      inputVersionHash: graph.graphHash,
      createdAt: input.createdAt
    };
    return immutableFinancialCouncilValue({
      reportId: financialCouncilCanonicalHash(preimage),
      ...preimage
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_council_consensus_invalid") throw error;
    return invalid();
  }
}

function invalid(): never {
  throw financialCouncilError("financial_council_consensus_invalid");
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
