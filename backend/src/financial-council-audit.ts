import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type {
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction,
  FinancialCouncilConflictKind,
  FinancialCouncilFinding
} from "./growth-contract-types.js";
import {
  assertFinancialCouncilSpecialistResultAuthorized,
  type AuthorizedFinancialCouncilSpecialistResult
} from "./financial-council-finding-validator.js";

export const FINANCIAL_COUNCIL_CONFLICT_KINDS = Object.freeze([
  "formula", "evidence", "definition", "action_exclusivity",
  "resource_competition", "risk_preference"
] as const satisfies readonly FinancialCouncilConflictKind[]);

const PRECEDENCE = new Map<FinancialCouncilConflictKind, number>(
  FINANCIAL_COUNCIL_CONFLICT_KINDS.map((kind, index) => [kind, index])
);

export interface FinancialCouncilAuditFact {
  readonly finding: FinancialCouncilFinding;
  readonly actions: readonly FinancialCouncilCandidateAction[];
}

export interface FinancialCouncilConflictEdge {
  readonly edgeId: `sha256:${string}`;
  readonly kind: FinancialCouncilConflictKind;
  readonly findingIds: readonly [string, string];
  readonly sharedRefs: readonly string[];
  readonly status: "unresolved" | "resolved" | "withdrawn";
  readonly validatorReason: string;
}

export interface FinancialCouncilAuditGraph {
  readonly graphId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly edges: readonly FinancialCouncilConflictEdge[];
  readonly graphHash: `sha256:${string}`;
}

export interface BuildFinancialCouncilAuditGraphInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  /** Results have already passed Task 3 semantic reauthorization. */
  readonly facts: readonly FinancialCouncilAuditFact[];
}

export interface FinancialCouncilRebuttalTarget {
  readonly role: FinancialCouncilAgentRole;
  readonly round: 1;
  readonly edgeId: `sha256:${string}`;
  readonly kind: FinancialCouncilConflictKind;
  readonly findingId: string;
  readonly peerFindingId: string;
  readonly sharedRefs: readonly string[];
  readonly validatorReason: string;
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pair(left: string, right: string): readonly [string, string] {
  return compare(left, right) <= 0 ? [left, right] : [right, left];
}

function actionFindingPairs(
  left: FinancialCouncilCandidateAction,
  right: FinancialCouncilCandidateAction
): readonly (readonly [string, string])[] {
  const result: Array<readonly [string, string]> = [];
  for (const leftId of left.sourceFindingIds) {
    for (const rightId of right.sourceFindingIds) {
      if (leftId !== rightId) result.push(pair(leftId, rightId));
    }
  }
  return result;
}

function resourceSignatures(action: FinancialCouncilCandidateAction): string[] {
  if (action.capacityUnits <= 0) return [];
  return [
    ...(action.subjectRef === null ? [] : [`subject:${action.subjectRef}`]),
    ...action.requiredCapabilities.map((item) => `capability:${item}`)
  ].sort(compare);
}

function edge(
  identity: Omit<BuildFinancialCouncilAuditGraphInput, "facts">,
  kind: FinancialCouncilConflictKind,
  findingIds: readonly [string, string],
  sharedRefs: readonly string[],
  validatorReason: string
): FinancialCouncilConflictEdge {
  const stable = {
    workspaceId: identity.workspaceId,
    runId: identity.runId,
    snapshotId: identity.snapshotId,
    snapshotHash: identity.snapshotHash,
    kind,
    findingIds: [...findingIds].sort(compare),
    sharedRefs: [...new Set(sharedRefs)].sort(compare)
  };
  return immutableFinancialCouncilValue({
    edgeId: financialCouncilCanonicalHash(stable),
    kind,
    findingIds: stable.findingIds,
    sharedRefs: stable.sharedRefs,
    status: "unresolved",
    validatorReason
  }) as unknown as FinancialCouncilConflictEdge;
}

export function buildCanonicalFinancialCouncilAuditGraph(
  raw: BuildFinancialCouncilAuditGraphInput
): FinancialCouncilAuditGraph {
  const input = immutableFinancialCouncilInput(raw);
  const identity = {
    workspaceId: input.workspaceId,
    runId: input.runId,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash
  };
  const facts = [...input.facts].sort((left, right) =>
    compare(left.finding.findingId, right.finding.findingId));
  if (facts.some((item) => item.finding.runId !== input.runId
    || item.finding.snapshotId !== input.snapshotId
    || item.actions.some((action) => action.ownerRole
      !== item.finding.agentRole
      || !action.sourceFindingIds.includes(item.finding.findingId)))) {
    throw financialCouncilError("financial_council_audit_invalid");
  }
  const candidates: FinancialCouncilConflictEdge[] = [];

  for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < facts.length;
      rightIndex += 1) {
      const left = facts[leftIndex]!;
      const right = facts[rightIndex]!;
      const ids = pair(left.finding.findingId, right.finding.findingId);
      const leftFormula = left.finding.formulaRef;
      const rightFormula = right.finding.formulaRef;
      if (leftFormula && rightFormula
        && leftFormula.formulaVersion === rightFormula.formulaVersion
        && leftFormula.inputHash === rightFormula.inputHash
        && leftFormula.resultHash !== rightFormula.resultHash) {
        candidates.push(edge(identity, "formula", ids,
          [`formula-input:${leftFormula.inputHash}`], "formula_result_mismatch"));
      }
      if (leftFormula && rightFormula
        && leftFormula.formulaVersion !== rightFormula.formulaVersion
        && leftFormula.inputHash === rightFormula.inputHash) {
        candidates.push(edge(identity, "definition", ids,
          [`formula-definition:${leftFormula.formulaVersion}`,
            `formula-definition:${rightFormula.formulaVersion}`],
          "formula_definition_mismatch"));
      }
      const leftEvidence = new Map(left.finding.evidenceRefs.map((item) =>
        [`${item.source}:${item.sourceId}`, item.contentHash]));
      for (const item of right.finding.evidenceRefs) {
        const ref = `${item.source}:${item.sourceId}`;
        const contentHash = leftEvidence.get(ref);
        if (contentHash && contentHash !== item.contentHash) {
          candidates.push(edge(identity, "evidence", ids, [ref],
            "evidence_content_mismatch"));
        }
      }
    }
  }

  const actions = facts.flatMap((item) => item.actions)
    .sort((left, right) => compare(left.actionId, right.actionId));
  for (let leftIndex = 0; leftIndex < actions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < actions.length;
      rightIndex += 1) {
      const left = actions[leftIndex]!;
      const right = actions[rightIndex]!;
      const actionIds = pair(left.actionId, right.actionId);
      const exclusive = left.mutuallyExclusiveWith.includes(right.actionId)
        || right.mutuallyExclusiveWith.includes(left.actionId);
      const sharedResources = resourceSignatures(left).filter((signature) =>
        resourceSignatures(right).includes(signature));
      const sharedRiskSubject = !exclusive && sharedResources.length === 0
        && left.kind !== right.kind
        && left.subjectRef === right.subjectRef
        ? left.subjectRef !== null
          ? [`subject:${left.subjectRef}`]
          : left.ownerRole === right.ownerRole
            ? [`role:${left.ownerRole}`]
            : []
        : [];
      for (const findingIds of actionFindingPairs(left, right)) {
        if (exclusive) candidates.push(edge(identity, "action_exclusivity",
          findingIds, [`actions:${actionIds.join("|")}`],
          "actions_are_mutually_exclusive"));
        if (sharedResources.length > 0) candidates.push(edge(identity,
          "resource_competition", findingIds, sharedResources,
          "actions_share_structural_resource"));
        if (sharedRiskSubject.length > 0) candidates.push(edge(identity,
          "risk_preference", findingIds, sharedRiskSubject,
          "actions_express_different_risk_preferences"));
      }
    }
  }

  const unique = new Map(candidates.map((item) => [item.edgeId, item]));
  const edges = [...unique.values()].sort((left, right) =>
    (PRECEDENCE.get(left.kind)! - PRECEDENCE.get(right.kind)!)
      || compare(left.edgeId, right.edgeId));
  const preimage = { ...identity, edges };
  const graphHash = financialCouncilCanonicalHash(preimage);
  return immutableFinancialCouncilValue({
    graphId: graphHash,
    ...preimage,
    graphHash
  }) as unknown as FinancialCouncilAuditGraph;
}

export function buildFinancialCouncilAuditGraph(
  results: readonly AuthorizedFinancialCouncilSpecialistResult[]
): FinancialCouncilAuditGraph {
  const roles = new Set<FinancialCouncilAgentRole>();
  for (const result of results) {
    assertFinancialCouncilSpecialistResultAuthorized(result);
    roles.add(result.role);
  }
  const first = results[0];
  if (!first || results.length !== 5 || roles.size !== 5
    || results.some((result) => result.workspaceId !== first.workspaceId
      || result.runId !== first.runId || result.snapshotId !== first.snapshotId
      || result.snapshotHash !== first.snapshotHash
      || result.phase !== "analyze")) {
    throw financialCouncilError("financial_council_audit_invalid");
  }
  return buildCanonicalFinancialCouncilAuditGraph({
    workspaceId: first.workspaceId,
    runId: first.runId,
    snapshotId: first.snapshotId,
    snapshotHash: first.snapshotHash,
    facts: results.flatMap((result) => result.findings.map((finding) => ({
      finding,
      actions: result.actions.filter((action) =>
        action.sourceFindingIds.includes(finding.findingId))
    })))
  });
}

export function selectFinancialCouncilRebuttalTargets(
  graph: FinancialCouncilAuditGraph,
  findings: readonly { findingId: string; role: FinancialCouncilAgentRole }[]
): readonly FinancialCouncilRebuttalTarget[] {
  const roleByFinding = new Map(findings.map((item) =>
    [item.findingId, item.role]));
  const candidates: FinancialCouncilRebuttalTarget[] = [];
  for (const item of graph.edges) {
    if (item.status !== "unresolved") continue;
    for (const findingId of item.findingIds) {
      const role = roleByFinding.get(findingId);
      if (!role) continue;
      candidates.push({ role, round: 1, edgeId: item.edgeId, kind: item.kind,
        findingId, peerFindingId: item.findingIds.find((id) => id !== findingId)!,
        sharedRefs: item.sharedRefs, validatorReason: item.validatorReason });
    }
  }
  candidates.sort((left, right) =>
    (PRECEDENCE.get(left.kind)! - PRECEDENCE.get(right.kind)!)
      || compare(left.edgeId, right.edgeId)
      || compare(left.findingId, right.findingId));
  const selected = new Map<FinancialCouncilAgentRole,
  FinancialCouncilRebuttalTarget>();
  for (const target of candidates) {
    if (!selected.has(target.role)) selected.set(target.role, target);
  }
  return immutableFinancialCouncilValue([...selected.values()].sort(
    (left, right) => compare(left.role, right.role)
  ));
}
