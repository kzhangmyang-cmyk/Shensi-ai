import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalFinancialCouncilAuditGraph,
  selectFinancialCouncilRebuttalTargets
} from "./financial-council-audit.js";
import {
  FinancialCouncilRebuttalCoordinator
} from "./financial-council-rebuttal.js";
import { InMemoryFinancialCouncilRepository } from
  "./financial-council-repository.js";
import type {
  FinancialCouncilModelPort,
  FinancialCouncilRebutInput,
  FinancialCouncilRebutOutput
} from "./financial-council-model-port.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import {
  command, repositoryRunFixture, snapshotFixture, workspace
} from "./financial-council-repository-contract-test.js";

const SHA = (value: string) => `sha256:${value.repeat(64)}` as const;

function setupGraph() {
  const finding = (findingId: string, role: "finance" | "profit",
    resultHash: `sha256:${string}`) => ({ finding: {
    findingId, runId: "council-run-1", snapshotId: "snapshot-placeholder",
    agentRole: role, conclusion: "risk_hypothesis",
    evidenceRefs: [{ source: "business_report" as const,
      sourceId: "business-report", contentHash: SHA("a") }],
    formulaRef: { formulaVersion: "ratio.v1", inputHash: SHA("b"), resultHash },
    confidenceBps: 8_000, severity: "warning" as const, assumptions: [],
    missingData: [], candidateActionIds: []
  }, actions: [] });
  return { finding, facts: [
    finding("finding-finance", "finance", SHA("c")),
    finding("finding-profit", "profit", SHA("d"))
  ] };
}

async function fixture() {
  const repository = new InMemoryFinancialCouncilRepository();
  const aggregate = repositoryRunFixture();
  const snapshot = snapshotFixture(aggregate);
  const run = (await repository.createAndFreezeRun(command("rebuttal"), {
    aggregate, snapshot, occurredAt: snapshot.createdAt
  })).value;
  const { facts } = setupGraph();
  const boundFacts = facts.map((item) => ({ ...item, finding: {
    ...item.finding, runId: run.runId, snapshotId: snapshot.snapshotId
  }}));
  const graph = buildCanonicalFinancialCouncilAuditGraph({
    workspaceId: run.workspaceId, runId: run.runId,
    snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    facts: boundFacts
  });
  const targets = selectFinancialCouncilRebuttalTargets(graph,
    boundFacts.map((item) => ({ findingId: item.finding.findingId,
      role: item.finding.agentRole })));
  await repository.storeAuditGraph(workspace(), graph, boundFacts.map((item) => ({
    findingId: item.finding.findingId, role: item.finding.agentRole,
    status: "unresolved" as const,
    blockingConflictIds: graph.edges.map((edge) => edge.edgeId)
      .filter((edgeId) => graph.edges.find((edge) => edge.edgeId === edgeId)!
        .findingIds.includes(item.finding.findingId))
  })));
  return { repository, run, snapshot, graph, target: targets[0]!, boundFacts };
}

function baseInput(targetFindingId: string, snapshotId: string,
  snapshotHash: `sha256:${string}`): FinancialCouncilRebutInput {
  return {
    ownerId: "owner-1", teamId: "ws-1", runId: "council-run-1",
    snapshotId, snapshotHash, role: "finance", attempt: 1,
    allowlist: { evidenceRefIds: ["evidence-1"], formulaRefIds: ["formula-1"],
      findingIds: [targetFindingId], subjectRefs: [], dataGapRefs: [] },
    businessData: { original: targetFindingId }, targetFindingId,
    conflictData: {}
  };
}

function result(input: FinancialCouncilRebutInput,
  output: FinancialCouncilRebutOutput) {
  const content = buildFinancialCouncilModelContent("rebut", input);
  return { value: output, repaired: false, providerRequestId: null,
    binding: {
      jobId: content.jobId,
      runId: input.runId, snapshotId: input.snapshotId,
      snapshotHash: input.snapshotHash, role: input.role,
      phase: "rebut" as const, attempt: 1, connectionId: "connection-1",
      credentialVersion: 1, provider: "openai" as const, model: "gpt-test",
      capabilitySnapshotHash: SHA("a"), baseUrlFingerprint: "official",
      promptVersion: `financial-council-${input.role}-rebut.v1`,
      schemaVersion: "financial-council-specialist-output.v1",
      contentHash: content.contentHash, promptHash: content.promptHash,
      schemaHash: content.schemaHash
    }
  };
}

test("reservation is durable before model call and restart reuses immutable input", async () => {
  const { repository, graph, target, snapshot, boundFacts } = await fixture();
  const calls: FinancialCouncilRebutInput[] = [];
  const timeout = Object.assign(new Error("timeout"), {
    code: "financial_council_model_timeout"
  });
  const model: FinancialCouncilModelPort = {
    async analyze() { throw new Error("unused"); },
    async rebut(input) { calls.push(input); throw timeout; }
  };
  const coordinator = new FinancialCouncilRebuttalCoordinator({
    repository, model, now: () => "2026-08-16T08:03:00.000Z",
    validateOutput: (_role, output) => output
  });
  const input = baseInput(target.findingId, snapshot.snapshotId,
    snapshot.snapshotHash);

  await assert.rejects(coordinator.run({ context: workspace(), graph, target,
    originalFinding: boundFacts[0]!.finding,
    peerFinding: boundFacts[1]!.finding, baseInput: input }), timeout);
  const reserved = await repository.getRebuttalAttempt(workspace(),
    graph.runId, target.role, 1);
  assert.equal(reserved?.status, "reserved");
  assert.deepEqual(reserved?.input, calls[0]);

  await assert.rejects(coordinator.run({ context: workspace(), graph, target,
    originalFinding: boundFacts[0]!.finding,
    peerFinding: boundFacts[1]!.finding, baseInput: input }), timeout);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal((await repository.listRebuttalAttempts(
    workspace(), graph.runId)).length, 1);
});

test("crash recovery completes exact result once and never creates round two", async () => {
  const { repository, graph, target, snapshot, boundFacts } = await fixture();
  const output: FinancialCouncilRebutOutput = {
    decision: "withdraw", findingId: target.findingId,
    evidenceRefs: [], replacement: null, explanation: "finding_rebuttal"
  };
  let calls = 0;
  const model: FinancialCouncilModelPort = {
    async analyze() { throw new Error("unused"); },
    async rebut(input) { calls += 1; return result(input, output); }
  };
  const coordinator = new FinancialCouncilRebuttalCoordinator({
    repository, model, now: () => "2026-08-16T08:03:00.000Z",
    validateOutput: (_role, value) => value
  });
  const request = { context: workspace(), graph, target,
    originalFinding: boundFacts[0]!.finding,
    peerFinding: boundFacts[1]!.finding,
    baseInput: baseInput(target.findingId, snapshot.snapshotId,
      snapshot.snapshotHash) };

  const first = await coordinator.run(request);
  const replay = await coordinator.run(request);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.equal((await repository.listFindingDispositions(
    workspace(), graph.runId)).find((item) =>
    item.findingId === target.findingId)?.status, "withdrawn");
  await assert.rejects(repository.reserveRebuttalAttempt(workspace(), {
    ...first.value, round: 2 as never
  }), (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_rebuttal_invalid");
});

test("lease fencing uses actual rebuttal completion time after the model call", async () => {
  const { repository, run, graph, target, snapshot, boundFacts } =
    await fixture();
  const lease = (await repository.claimAnalysisRun({
    workspaceId: run.workspaceId,
    runId: run.runId,
    workerId: "worker-a",
    leaseToken: "7".repeat(64),
    claimedAt: "2026-08-16T08:00:00.000Z",
    leaseExpiresAt: "2026-08-16T08:01:00.000Z"
  }))!;
  const output: FinancialCouncilRebutOutput = {
    decision: "withdraw", findingId: target.findingId,
    evidenceRefs: [], replacement: null, explanation: "finding_rebuttal"
  };
  const model: FinancialCouncilModelPort = {
    async analyze() { throw new Error("unused"); },
    async rebut(input) { return result(input, output); }
  };
  const times = [
    "2026-08-16T08:00:00.000Z",
    "2026-08-16T08:00:00.000Z",
    "2026-08-16T08:01:00.000Z"
  ];
  const coordinator = new FinancialCouncilRebuttalCoordinator({
    repository, model, now: () => times.shift()!,
    validateOutput: (_role, value) => value
  });
  await assert.rejects(coordinator.run({
    context: workspace(), graph, target,
    originalFinding: boundFacts[0]!.finding,
    peerFinding: boundFacts[1]!.finding,
    baseInput: baseInput(target.findingId, snapshot.snapshotId,
      snapshot.snapshotHash)
  }, { lease, completedAt: "2026-08-16T08:00:00.000Z" }),
  (error: unknown) => (error as { code?: unknown }).code
    === "financial_council_lease_stale");
});
