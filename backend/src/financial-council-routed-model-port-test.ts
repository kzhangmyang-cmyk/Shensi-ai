import assert from "node:assert/strict";
import test from "node:test";
import {
  RoutedFinancialCouncilModelPort
} from "./financial-council-routed-model-port.js";
import {
  FinancialCouncilModelError,
  type FinancialCouncilAnalyzeInput,
  type FinancialCouncilModelFailureCode,
  type FinancialCouncilModelResult
} from "./financial-council-model-port.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const HASH = `sha256:${"a".repeat(64)}` as const;
const workspace = Object.freeze({
  workspaceId: "team-route", kind: "team" as const, actorId: "owner-route",
  role: "admin" as const, teamId: "team-route", capabilities: Object.freeze([]),
  capabilityRegistryVersion: "growth-capabilities.v1"
}) satisfies ActiveWorkspaceContext;

function input(): FinancialCouncilAnalyzeInput {
  return {
    ownerId: workspace.actorId, teamId: workspace.teamId, runId: "run-route",
    snapshotId: "snapshot-route", snapshotHash: HASH, role: "finance",
    attempt: 1, allowlist: { evidenceRefIds: ["evidence:1"],
      formulaRefIds: ["formula:1"], findingIds: ["finding:1"],
      subjectRefs: [], dataGapRefs: [] }, businessData: {}
  };
}

function result(attempt: number, connectionId: string):
FinancialCouncilModelResult<never> {
  return Object.freeze({
    value: Object.freeze({ findingDrafts: [], actionHypotheses: [] }) as never,
    binding: Object.freeze({
      jobId: `financial-council:run-route:finance:analyze:${attempt}`,
      runId: "run-route", snapshotId: "snapshot-route", snapshotHash: HASH,
      role: "finance" as const, phase: "analyze" as const, attempt,
      connectionId, credentialVersion: 1, provider: "openai" as const,
      model: "model", capabilitySnapshotHash: HASH,
      baseUrlFingerprint: HASH, promptVersion: "prompt.v1",
      schemaVersion: "schema.v1", contentHash: HASH, promptHash: HASH,
      schemaHash: HASH, routingPolicyVersionId: "routing-v1",
      routeReasonCodes: Object.freeze(["structured_output_certified"])
    }),
    repaired: false, providerRequestId: null
  });
}

function failure(code: FinancialCouncilModelFailureCode, retryable: boolean) {
  return new FinancialCouncilModelError(code, retryable);
}

test("retryable primary failure uses one frozen fallback attempt", async () => {
  const calls: Array<{ connectionId: string; attempt: number }> = [];
  const port = new RoutedFinancialCouncilModelPort({
    selection: { async resolve() { return {
      routingPolicyVersionId: "routing-v1", role: "finance" as const,
      phase: "analyze" as const,
      orderedConnectionIds: ["primary-a", "fallback-b", "fallback-b"],
      reasonCodes: ["structured_output_certified"]
    }; } },
    delegate: {
      async analyze(value, route) {
        calls.push({ connectionId: route.connectionId, attempt: value.attempt });
        if (value.attempt === 1) throw failure(
          "financial_council_model_timeout", true
        );
        return result(value.attempt, route.connectionId);
      },
      rebut: async () => { throw new Error("not called"); },
      synthesize: async () => { throw new Error("not called"); }
    },
    fence: { async assertCurrent() {} }
  });
  const value = await port.analyze(input(), workspace);
  assert.equal(value.binding.connectionId, "fallback-b");
  assert.equal(value.binding.attempt, 2);
  assert.deepEqual(calls, [
    { connectionId: "primary-a", attempt: 1 },
    { connectionId: "fallback-b", attempt: 2 }
  ]);
});

test("only timeout, 429 and unavailable provider failures cross providers",
  async (context) => {
    const cases: Array<[string, FinancialCouncilModelFailureCode, boolean]> = [
      ["invalid output", "financial_council_model_output_invalid", false],
      ["auth", "not_computable:model_credential_unavailable", false],
      ["snapshot", "financial_council_model_snapshot_persistence_failed", true],
      ["ledger", "financial_council_model_ledger_persistence_failed", true]
    ];
    for (const [name, code, retryable] of cases) {
      await context.test(name, async () => {
        let calls = 0;
        const port = new RoutedFinancialCouncilModelPort({
          selection: { async resolve() { return {
            routingPolicyVersionId: "routing-v1", role: "finance" as const,
            phase: "analyze" as const,
            orderedConnectionIds: ["primary", "fallback"], reasonCodes: []
          }; } },
          delegate: {
            async analyze() { calls += 1; throw failure(code, retryable); },
            rebut: async () => { throw new Error("not called"); },
            synthesize: async () => { throw new Error("not called"); }
          },
          fence: { async assertCurrent() {} }
        });
        await assert.rejects(port.analyze(input(), workspace),
          (error: unknown) => (error as { code?: unknown }).code === code);
        assert.equal(calls, 1);
      });
    }
  });

test("all three phases share the primary plus two fallback budget", async () => {
  const seen: Array<{ phase: string; attempt: number }> = [];
  const selection = { async resolve(value: { phase: string }) { return {
    routingPolicyVersionId: "routing-v1", role: value.phase === "synthesize"
      ? "cfo" as const : "finance" as const, phase: value.phase as never,
    orderedConnectionIds: ["a", "b", "c", "d"], reasonCodes: []
  }; } };
  const delegate = {
    async analyze(value: FinancialCouncilAnalyzeInput) {
      seen.push({ phase: "analyze", attempt: value.attempt });
      throw failure("financial_council_model_provider_failed", true);
    },
    async rebut(value: FinancialCouncilAnalyzeInput) {
      seen.push({ phase: "rebut", attempt: value.attempt });
      throw failure("financial_council_model_provider_failed", true);
    },
    async synthesize(value: { attempt: number }) {
      seen.push({ phase: "synthesize", attempt: value.attempt });
      throw failure("financial_council_model_provider_failed", true);
    }
  };
  const port = new RoutedFinancialCouncilModelPort({ selection, delegate,
    fence: { async assertCurrent() {} } });
  await assert.rejects(port.analyze(input(), workspace));
  await assert.rejects(port.rebut({ ...input(), targetFindingId: "finding:1",
    conflictData: {} }, workspace));
  await assert.rejects(port.synthesize({ ownerId: workspace.actorId,
    teamId: workspace.teamId, runId: "run-route", snapshotId: "snapshot-route",
    snapshotHash: HASH, auditHash: HASH, attempt: 1, acceptedFindings: [],
    minorityFindings: [], rejectedFindingIds: [], unresolvedConflicts: [],
    dataGapRefs: [] }, workspace));
  assert.deepEqual(seen, [
    { phase: "analyze", attempt: 1 }, { phase: "analyze", attempt: 2 },
    { phase: "analyze", attempt: 3 }, { phase: "rebut", attempt: 1 },
    { phase: "rebut", attempt: 2 }, { phase: "rebut", attempt: 3 },
    { phase: "synthesize", attempt: 1 },
    { phase: "synthesize", attempt: 2 },
    { phase: "synthesize", attempt: 3 }
  ]);
});

test("a completion is authorized again after provider await", async () => {
  let current = true;
  const port = new RoutedFinancialCouncilModelPort({
    selection: { async resolve() { return {
      routingPolicyVersionId: "routing-v1", role: "finance" as const,
      phase: "analyze" as const, orderedConnectionIds: ["primary"],
      reasonCodes: []
    }; } },
    delegate: { async analyze() { current = false; return result(1, "primary"); },
      rebut: async () => { throw new Error("not called"); },
      synthesize: async () => { throw new Error("not called"); } },
    fence: { async assertCurrent() {
      if (!current) throw failure("financial_council_model_snapshot_mismatch", false);
    } }
  });
  await assert.rejects(port.analyze(input(), workspace),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_model_snapshot_mismatch");
});
