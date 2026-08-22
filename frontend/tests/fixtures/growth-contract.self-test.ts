import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  financialCouncilFixture,
  growthContractScenario
} from "./growth-contract";

const pinnedManifest = JSON.parse(await readFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "contracts",
    "pinned",
    "growth-advisor-quote-roi.manifest.json"
  ),
  "utf8"
)) as { contractVersion: string; contractHash: string };

test("financial council fixtures pin immutable release 1.0.10", () => {
  assert.equal(pinnedManifest.contractVersion, "1.0.10");
});

test("financial council fixtures cover every required public state", () => {
  const fixture = financialCouncilFixture;
  assert.deepEqual(Object.keys(fixture), [
    "analyzing",
    "auditing",
    "awaitingApproval",
    "approved",
    "notComputable",
    "stale",
    "unresolvedConflict",
    "emptyFeasiblePortfolios",
    "partialDispatch"
  ]);
  assert.equal(fixture.analyzing.status, "analyzing");
  assert.equal(fixture.auditing.status, "auditing");
  assert.deepEqual(
    fixture.awaitingApproval.portfolios.map((portfolio) => portfolio.kind),
    ["balanced", "cash_first", "growth_first"]
  );
  assert.equal(fixture.approved.status, "approved");
  assert.equal(fixture.notComputable.status, "not_computable");
  assert.equal(fixture.stale.status, "stale");
  assert.equal(
    fixture.unresolvedConflict.consensusReport.unresolvedConflicts[0].status,
    "unresolved"
  );
  assert.equal(
    fixture.emptyFeasiblePortfolios.portfolios.every(
      (portfolio) => portfolio.actions.length === 0
    ),
    true
  );
  assert.deepEqual(
    fixture.partialDispatch.dispatches.items.map(
      (dispatch) => dispatch.status
    ),
    ["queued", "running", "retry", "succeeded", "failed"]
  );
});

test("ready bootstrap grants the three closed financial council capabilities", () => {
  const capabilities = growthContractScenario("happy_path").bootstrap.capabilities;
  assert.deepEqual(
    capabilities.filter((capability): capability is string =>
      typeof capability === "string"
      && capability.startsWith("finance.council.")),
    [
      "finance.council.run",
      "finance.council.approve",
      "finance.council.policy.manage"
    ]
  );
});

test("every named growth scenario carries the pinned bootstrap identity", () => {
  const names = [
    "happy_path",
    "workspace_selection_required",
    "contract_mismatch",
    "sales_redacted",
    "quote_conflict",
    "finance_partial_import",
    "roi_not_computable",
    "advisor_model_failed"
  ] as const;
  for (const name of names) {
    const scenario = growthContractScenario(name);
    if (name !== "contract_mismatch") {
      assert.equal(
        scenario.bootstrap.contractVersion,
        pinnedManifest.contractVersion
      );
      assert.equal(
        scenario.bootstrap.contractHash,
        pinnedManifest.contractHash
      );
    }
    assert.equal(
      JSON.stringify(scenario).includes('"workspaceId":"all"'),
      false
    );
  }
});

test("financial and actual ROI fixtures never promote estimates", () => {
  const scenario = growthContractScenario("happy_path");
  const actual = scenario.performance.actualRoiByCurrency.find(
    (item) => item.currency === "CNY"
  );
  assert.equal(
    scenario.costEntries.every((entry) => entry.status === "verified"),
    true
  );
  assert.equal(actual?.status, "computed");
  assert.equal(actual?.closureVersionId, "closure-cny-v1");

  const incomplete = growthContractScenario("roi_not_computable");
  const incompleteActual = incomplete.performance.actualRoiByCurrency.find(
    (item) => item.currency === "CNY"
  );
  assert.equal(incompleteActual?.status, "not_computable");
  assert.equal(
    incompleteActual?.reason,
    "cohort_not_closed"
  );
});

test("the typed fixture owns actual Copilot session, message and task traffic without escape", async () => {
  const scenario = growthContractScenario("happy_path");
  assert.equal(scenario.copilotSessionOperation.kind, "copilot_session_creation");
  assert.equal(scenario.copilotSession.id, "advisor-session-1");
  assert.equal(
    scenario.copilotMessages.items.every(
      (item) => item.sessionId === "advisor-session-1"
    ),
    true
  );
  assert.equal(scenario.copilotQueuedTask.status, "queued");
  assert.equal(scenario.copilotCompletedTask.status, "succeeded");
  for (const key of [
    "POST /api/v1/acquisition/copilot/sessions",
    "GET /api/v1/acquisition/copilot/sessions/advisor-session-1",
    "GET /api/v1/acquisition/copilot/sessions/advisor-session-1/messages",
    "POST /api/v1/acquisition/copilot/sessions/advisor-session-1/messages",
    "GET /api/v1/acquisition/copilot/tasks/advisor-task-1"
  ]) {
    assert.ok(scenario.responses[key], key);
  }

  const failed = growthContractScenario("advisor_model_failed");
  assert.equal(failed.copilotCompletedTask.status, "failed");
  assert.equal(
    failed.copilotCompletedTask.errorCode,
    "AI_EXPLANATION_UNAVAILABLE"
  );

  const source = await readFile(
    new URL("./growth-contract.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /\*\*\/api\/v1\/acquisition\/copilot\/\*\*/u);
  assert.doesNotMatch(source, /route\.continue\s*\(/u);
  assert.doesNotMatch(source, /\bas\s+any\b|\bas\s+unknown\s+as\b/u);
});
