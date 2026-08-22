import assert from "node:assert/strict";
import test from "node:test";
import {
  synthesizeFinancialCfoNarrative,
  type FinancialCfoNarrativePort
} from "./financial-council-cfo.js";
import type {
  FinancialCfoNarrativeInput,
  FinancialCfoNarrativeOutput
} from "./financial-council-model-port.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function input(): FinancialCfoNarrativeInput {
  return Object.freeze({
    ownerId: "owner-1",
    teamId: "team-1",
    runId: "run-cfo",
    snapshotId: "snapshot-cfo",
    snapshotHash: HASH,
    auditHash: HASH,
    attempt: 1,
    acceptedFindings: Object.freeze([{
      findingId: "finding-accepted",
      agentRole: "finance",
      conclusion: "risk_hypothesis",
      severity: "warning",
      evidenceRefIds: Object.freeze(["business_report:evidence-a"]),
      formulaRefId: null
    }]),
    minorityFindings: Object.freeze([{
      findingId: "finding-critical-minority",
      agentRole: "cashflow",
      conclusion: "risk_hypothesis",
      severity: "critical",
      evidenceRefIds: Object.freeze(["business_report:evidence-b"]),
      formulaRefId: null
    }]),
    rejectedFindingIds: Object.freeze(["finding-rejected"]),
    unresolvedConflicts: Object.freeze([{
      conflictId: HASH,
      type: "formula",
      findingIds: Object.freeze(["finding-unresolved"]),
      status: "unresolved"
    }]),
    dataGapRefs: Object.freeze(["business_report:null:missing_cogs"])
  });
}

function port(output: FinancialCfoNarrativeOutput | Error):
FinancialCfoNarrativePort {
  return {
    async synthesize() {
      if (output instanceof Error) throw output;
      return output;
    }
  };
}

function validOutput(
  overrides: Partial<FinancialCfoNarrativeOutput> = {}
): FinancialCfoNarrativeOutput {
  return {
    overallDiagnosis:
      "已审计结论需要优先关注 [finding-accepted]\n\n少数意见仍须保留 [finding-critical-minority]",
    priorityFindingIds: ["finding-accepted"],
    minorityFindingIds: ["finding-critical-minority"],
    riskNotes: ["关键冲突尚未解决 [finding-unresolved]"],
    ...overrides
  };
}

test("CFO accepts only fully referenced structured narrative", async () => {
  const result = await synthesizeFinancialCfoNarrative(
    port(validOutput()), input()
  );

  assert.equal(result.narrativeStatus, "model_valid");
  assert.deepEqual(result.priorityFindingIds, ["finding-accepted"]);
  assert.deepEqual(result.minorityFindingIds,
    ["finding-critical-minority"]);
});

test("CFO invalid output uses a server template and never blocks consensus", async () => {
  const invalidCases: Array<[string, FinancialCfoNarrativeOutput]> = [
    ["critical minority omitted", validOutput({ minorityFindingIds: [] })],
    ["rejected cited as accepted", validOutput({
      priorityFindingIds: ["finding-rejected"]
    })],
    ["new amount", validOutput({
      overallDiagnosis: "预计增加 100 元 [finding-accepted]"
    })],
    ["spelled English amount", validOutput({
      overallDiagnosis:
        "Receivables total ten million [finding-accepted]"
    })],
    ["spelled Chinese amount", validOutput({
      overallDiagnosis: "应收账款共壹仟万 [finding-accepted]"
    })],
    ["quantity synonym", validOutput({
      overallDiagnosis: "Receivables total a grand [finding-accepted]"
    })],
    ["ratio without digits", validOutput({
      overallDiagnosis: "Receivables doubled [finding-accepted]"
    })],
    ["new bps", validOutput({
      overallDiagnosis: "风险下降 25 BPS [finding-accepted]"
    })],
    ["compliance claim", validOutput({
      overallDiagnosis: "企业已经税务合规 [finding-accepted]"
    })],
    ["action mutation", validOutput({
      overallDiagnosis: "立即执行收款动作 [finding-accepted]"
    })],
    ["chain of thought", validOutput({
      overallDiagnosis: "推理过程如下 [finding-accepted]"
    })],
    ["unreferenced paragraph", validOutput({
      overallDiagnosis:
        "已审计结论 [finding-accepted]\n\n这一段没有任何引用"
    })]
  ];

  for (const [label, output] of invalidCases) {
    const result = await synthesizeFinancialCfoNarrative(port(output), input());
    assert.equal(result.narrativeStatus, "model_invalid", label);
    assert.match(result.overallDiagnosis, /finding-accepted/u, label);
    assert.equal(result.overallDiagnosis.includes("100"), false, label);
    assert.equal(result.overallDiagnosis.includes("BPS"), false, label);
    assert.equal(result.overallDiagnosis.includes("合规"), false, label);
  }
});

test("CFO model unavailability uses the same bounded template", async () => {
  const unavailable = Object.assign(new Error("provider offline"), {
    code: "financial_council_model_provider_failed"
  });
  const result = await synthesizeFinancialCfoNarrative(
    port(unavailable), input()
  );

  assert.equal(result.narrativeStatus, "model_unavailable");
  assert.deepEqual(result.minorityFindingIds,
    ["finding-critical-minority"]);
  assert.match(result.overallDiagnosis, /finding-critical-minority/u);
});
