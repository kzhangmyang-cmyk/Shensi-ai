import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceFinancialCouncilToApproval,
  createFinancialCouncilIntegrationFixture,
  completeFinancialCouncilIntegrationReport,
  financialCouncilIntegrationCommand,
  FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
  financialCouncilIntegrationWorkspace
} from "./financial-council-integration-fixtures.js";
import { projectFinancialCouncilCollaboration, type FinancialCouncilCollaborationInput } from "./financial-council-collaboration.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import { createFinancialCouncilReportPresentation } from "./financial-council-report-presentation.js";
import Ajv2020 from "ajv/dist/2020.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";

async function createPending(fixture: Awaited<ReturnType<typeof createFinancialCouncilIntegrationFixture>>) {
  const policy = await fixture.service.getPolicy(financialCouncilIntegrationWorkspace());
  return (await fixture.service.createRun(financialCouncilIntegrationCommand("collaboration-create", null), {
    currency: "CNY", dataAsOf: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
    businessReport: completeFinancialCouncilIntegrationReport(), policyVersionId: policy.policyVersionId
  })).value;
}

async function reportInput(fixture: Awaited<ReturnType<typeof createFinancialCouncilIntegrationFixture>>,
  runId: string): Promise<FinancialCouncilCollaborationInput> {
  const context = financialCouncilIntegrationWorkspace();
  return { ...(await fixture.repository.getVerifiedRunSnapshot(context, runId))!,
    events: await fixture.repository.listCollaborationEvents(context, runId),
    runEvents: await fixture.repository.listEvents(context, runId),
    results: await fixture.repository.listSpecialistResults(context, runId),
    attempts: await fixture.repository.listRebuttalAttempts(context, runId),
    dispositions: await fixture.repository.listFindingDispositions(context, runId),
    graph: await fixture.repository.getAuditGraph(context, runId),
    consensus: await fixture.repository.getConsensus(context, runId),
    gaps: [], control: null, now: "2026-08-16T08:10:00.000Z" };
}

test("evidence aliases resolve to one short citation without losing either original identifier", () => {
  const presentation = createFinancialCouncilReportPresentation();
  presentation.define("report-source-id", "报表资料", "report-source-id; version=1");
  presentation.define("report-source-id", "报表资料", "report-source-id", ["evidence-alias-id"]);
  assert.equal(presentation.reference("report-source-id"), presentation.reference("evidence-alias-id"));
  assert.equal(presentation.appendix().length, 1);
  assert.ok(presentation.appendix()[0]!.value.includes("report-source-id"));
  assert.ok(presentation.appendix()[0]!.value.includes("evidence-alias-id"));
});

test("isolated report sample can supply Chinese review prose without changing production translation rules", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture({
    rebutExplanation: "风险偏好对方案选择仍有重要影响。"
  });
  try {
    const run = await advanceFinancialCouncilToApproval(fixture);
    const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
    assert.match(view.reviews[0]!.summary, /风险偏好对方案选择仍有重要影响。/);
    assert.match(JSON.stringify(view.report.sections[4]), /风险偏好对方案选择仍有重要影响。/);
  } finally { await fixture.close(); }
});

test("report body explains known codes and uses lossless short evidence references", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const run = await advanceFinancialCouncilToApproval(fixture);
    const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
    const body = JSON.stringify(view.report.sections.slice(0, 7));
    assert.doesNotMatch(body, /risk_hypothesis|collect_receivable_hypothesis|reduce_cost_anomaly_hypothesis|cash_reserve|capacity|upheld|completed|sha256:[a-f0-9]{64}|formula:/);
    assert.match(body, /待核实的风险判断/);
    assert.match(body, /现金流分析.*逾期应收款/);
    assert.match(body, /维持原意见/);
    assert.match(body, /最低现金储备/);
    assert.match(body, /执行资源容量/);
    assert.match(body, /已选择综合目标排序更高的可行方案/);
    assert.match(body, /情景估算/);
    assert.match(body, /未记录额外判断假设/);
    assert.match(body, /CNY.*3,000\.00/);
    assert.equal(view.report.sections.find(section => section.id === "metrics")!.items
      .find(item => item.label === "营业收入")!.evidenceRefs.length, 1,
    "report-derived metrics cite the report, not unrelated CRM/quote/ROI sources in the snapshot");
    const appendix = view.report.sections[7]!;
    const references = appendix.items.filter(item => /^\[依据\d+\]/u.test(item.label));
    assert.ok(references.length > 0);
    for (const id of view.reviews.flatMap(review => review.summary.match(/evidence:sha256:[a-f0-9]{64}/gu) ?? [])) {
      assert.ok(JSON.stringify(appendix).includes(id), "full review evidence aliases must survive in the appendix");
    }
    for (const finding of view.roles.flatMap(role => role.findings)) {
      assert.equal(references.filter(item => item.value === finding.findingId).length, 1);
      assert.ok(JSON.stringify(appendix).includes(finding.formulaRef!.inputHash));
    }
    for (const ref of new Set(body.match(/\[依据\d+\]/gu))) {
      assert.equal(references.filter(item => item.label.startsWith(`${ref} `)).length, 1,
        `each short reference resolves once: ${ref}`);
    }
    assert.equal(view.roles[1]!.findings[0]!.conclusion, "risk_hypothesis",
      "presentation must not overwrite persisted model or finding DTOs");
    assert.match(view.reviews[0]!.summary, /risk preference remains material/);
    assert.match(body, /risk preference remains material/,
      "free model prose is not a technical enum and must remain verbatim");
  } finally { await fixture.close(); }
});

test("report retains free prose, resolves known gap assumptions and explains unknown codes without inventing facts", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const run = await advanceFinancialCouncilToApproval(fixture);
    const input = await reportInput(fixture, run.runId);
    const gap = { code: "missing_cogs" as const, source: "business_report" as const,
      sourceId: null, description: "该产品缺少已确认的成本明细" };
    const gapId = `gap:${financialCouncilCanonicalHash({ snapshotId: input.snapshot.snapshotId,
      snapshotHash: input.snapshot.snapshotHash, gap })}`;
    const prose = "Margin remains uncertain; EBITDA口径需人工确认，不应改写。";
    const results = input.results.map(result => ({ ...result, findings: result.findings.map((finding, index) => ({
      ...finding, conclusion: result.role === "finance" ? prose : finding.conclusion,
      assumptions: result.role === "finance" ? [gapId, "gap:unknown-input"] : finding.assumptions,
      missingData: result.role === "finance" ? [gap] : finding.missingData,
      ...(result.role === "cashflow" && index === 0 ? { conclusion: "future_risk_code" } : {})
    })) }));
    const view = projectFinancialCouncilCollaboration({ ...input, results,
      events: input.events.map(event => event.narrative ? { ...event,
        narrative: { ...event.narrative, overallDiagnosis: "budget", riskNotes: ["capacity"] } } : event),
      attempts: input.attempts.map(attempt => ({ ...attempt, result: attempt.result ? { ...attempt.result,
        value: { ...attempt.result.value, explanation: "customer_contract_pending" } } : null })),
      run: { ...input.run, portfolios: input.run.portfolios.map(portfolio => ({ ...portfolio,
        actions: portfolio.actions.map(action => ({ ...action, subjectRef: "acme_corp",
          explanation: "budget" })),
        hardConstraints: portfolio.hardConstraints.map((constraint, index) => index === 0
          ? { ...constraint, satisfied: false, reason: "minimum_cash_reserve_not_met" } : constraint)
      })) } });
    const body = JSON.stringify(view.report.sections.slice(0, 7));
    assert.ok(body.includes(prose));
    assert.equal(view.report.sections[0]!.paragraphs[0], "budget");
    assert.ok(view.report.sections[4]!.paragraphs.includes("capacity"));
    assert.match(body, /customer_contract_pending/);
    assert.match(body, /budget；对象：acme_corp/);
    assert.match(body, /该产品缺少已确认的成本明细/);
    assert.match(body, /假设所引用的资料说明缺失/);
    assert.match(body, /未达到最低现金储备要求/);
    assert.doesNotMatch(body, /future_risk_code|gap:unknown-input/);
    assert.match(body, /尚无可读说明/);
    assert.ok(JSON.stringify(view.report.sections[7]).includes("future_risk_code"));
    assert.ok(JSON.stringify(view.report.sections[7]).includes("gap:unknown-input"));
  } finally { await fixture.close(); }
});

test("reading across a worker transition returns one coherent run revision", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const run = await createPending(fixture);
    const original = fixture.repository.listCollaborationEvents.bind(fixture.repository);
    let interleaved = false;
    fixture.repository.listCollaborationEvents = async (...args) => {
      if (!interleaved) { interleaved = true; await fixture.pipeline.wake(run); }
      return original(...args);
    };
    const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
    const current = await fixture.service.getRun(financialCouncilIntegrationWorkspace(), run.runId);
    assert.equal(view.revision, current.revision);
    assert.equal(view.report.complete, current.portfolios.length > 0);
  } finally { await fixture.close(); }
});

test("mixed role states are real persisted worker milestones, not the global run state", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const observed = new Promise<void>(resolve => { started = resolve; });
  const original = fixture.repository.appendCollaborationEvent.bind(fixture.repository);
  fixture.repository.appendCollaborationEvent = async (lease, event) => {
    await original(lease, event);
    if (event.role === "profit" && event.phase === "analysis" && event.state === "running") {
      started(); await barrier;
    }
  };
  let running: Promise<void> | undefined;
  try {
    const run = await createPending(fixture);
    running = fixture.pipeline.wake(run);
    await observed;
    const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
    assert.equal(view.roles.find(role => role.role === "finance")!.state, "completed");
    assert.equal(view.roles.find(role => role.role === "profit")!.state, "running");
    assert.equal(view.roles.find(role => role.role === "cost")!.state, "waiting");
    assert.equal(view.report.complete, false);
  } finally { release(); await running; await fixture.close(); }
});

test("revised review preserves both original and corrected public conclusions with review evidence", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const run = await advanceFinancialCouncilToApproval(fixture);
    const context = financialCouncilIntegrationWorkspace();
    const verified = (await fixture.repository.getVerifiedRunSnapshot(context, run.runId))!;
    const attempts = await fixture.repository.listRebuttalAttempts(context, run.runId);
    const first = attempts[0]!;
    const results = await fixture.repository.listSpecialistResults(context, run.runId);
    const finding = results.flatMap(result => result.findings).find(row => row.findingId === first.targetFindingId)!;
    const view = projectFinancialCouncilCollaboration({ ...verified,
      events: await fixture.repository.listCollaborationEvents(context, run.runId),
      runEvents: await fixture.repository.listEvents(context, run.runId), results,
      gaps: [], control: null, now: "2026-08-16T08:10:00.000Z",
      graph: await fixture.repository.getAuditGraph(context, run.runId),
      consensus: await fixture.repository.getConsensus(context, run.runId),
      dispositions: (await fixture.repository.listFindingDispositions(context, run.runId)).map(row =>
        row.findingId === finding.findingId ? { ...row, status: "revised" } : row),
      attempts: [{ ...first, result: { ...first.result!, value: { ...first.result!.value,
        decision: "revise", replacement: { findingId: finding.findingId, conclusion: "修订后的公开结论",
          evidenceRefs: ["review-evidence-ref"], formulaRef: null, confidenceBps: 7000,
          severity: "warning", assumptions: [], missingDataRefs: [] } } } }]
    });
    const review = view.report.sections.find(section => section.id === "review")!;
    assert.ok(JSON.stringify(review).includes("修订后的公开结论"));
    assert.ok(JSON.stringify(view.report.sections[7]).includes("review-evidence-ref"));
    assert.ok(JSON.stringify(review).includes("待核实的风险判断"));
    assert.ok(view.reviews[0]!.summary.includes(finding.conclusion));
  } finally { await fixture.close(); }
});

test("isolated council run exposes persisted six-role collaboration and stable detailed report", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const authorityBefore = fixture.authorityReadHash();
    const run = await advanceFinancialCouncilToApproval(fixture);
    const context = financialCouncilIntegrationWorkspace();
    const view = await fixture.service.getCollaboration(context, run.runId);
    assert.equal(view.executionMode, "sequential");
    assert.equal(view.reviewRoundLimit, 1);
    assert.equal(view.roles.length, 6);
    assert.equal(view.roles.filter(role => role.role !== "cfo"
      && role.findings.length > 0).length, 5);
    assert.ok(view.events.some(event => event.phase === "analysis"
      && event.state === "running"));
    assert.ok(view.events.some(event => event.phase === "review"));
    assert.equal(view.reviews.length, 1);
    assert.equal(view.reviews[0]!.role, "cashflow");
    assert.notEqual(view.reviews[0]!.state, "pending");
    assert.ok(view.narrative);
    assert.equal(view.narrative.narrativeStatus, "model_valid");
    assert.equal(view.roles.find(role => role.role === "cfo")!.state, "completed");
    assert.ok(Array.isArray(view.narrative.priorityFindingIds));
    assert.ok(Array.isArray(view.narrative.riskNotes));
    assert.equal(view.report.complete, true);
    assert.deepEqual(view.report.sections.map(section => section.id), [
      "executive-summary", "sources", "metrics", "specialists", "review",
      "options", "actions", "appendix"
    ]);
    assert.ok(view.report.sections.find(section => section.id === "appendix")!
      .items.some(item => item.value.includes(run.snapshotHash!)));
    assert.ok(view.report.sections.find(section => section.id === "metrics")!
      .items.some(item => item.label === "营业收入" && item.value.includes("50,000")));
    assert.deepEqual(await fixture.service.getCollaboration(context, run.runId), view,
      "refresh does not fabricate another report timestamp or version");
    const history = await fixture.service.listRunHistory(context, { limit: 20 });
    assert.equal(history.items[0]!.runId, run.runId);
    assert.equal(history.hasMore, false);
    await assert.rejects(fixture.service.getCollaboration({ ...context,
      workspaceId: "isolated-other-workspace" }, run.runId),
    /financial_council_run_not_found/);
    assert.equal(fixture.authorityReadHash(), authorityBefore);
    assert.deepEqual(await fixture.service.listDispatches(context, run.runId), []);
    const components = structuredClone(loadGrowthContractRelease().document.components);
    for (const schema of Object.values(components.schemas) as Record<string, unknown>[]) delete schema.$id;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", value => Number.isFinite(Date.parse(value)));
    const validate = ajv.compile({ components, $ref: "#/components/schemas/FinancialCouncilCollaboration" });
    assert.equal(validate(view), true, JSON.stringify(validate.errors));
    assert.equal(JSON.stringify(view).includes("providerRequestId"), false);
    assert.equal(JSON.stringify(view).includes("modelBinding"), false);
  } finally { await fixture.close(); }
});

test("missing confirmed cashflow stays incomplete and does not become a zero cash forecast", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const context = financialCouncilIntegrationWorkspace();
    const policy = await fixture.service.getPolicy(context);
    const { cashFlow: _missing, ...businessReport } = completeFinancialCouncilIntegrationReport();
    const run = (await fixture.service.createRun(financialCouncilIntegrationCommand("missing-cashflow", null), {
      currency: "CNY", dataAsOf: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
      businessReport, policyVersionId: policy.policyVersionId
    })).value;
    await fixture.pipeline.wake(run);
    const current = await fixture.service.getRun(context, run.runId);
    const view = await fixture.service.getCollaboration(context, run.runId);
    assert.equal(current.status, "not_computable");
    assert.equal(view.report.complete, false);
    assert.equal(view.roles.find(role => role.role === "cashflow")!.state, "missing_data");
    assert.equal(view.roles.find(role => role.role === "cfo")!.state, "waiting");
    assert.equal(view.report.sections.find(section => section.id === "metrics")!.items
      .find(item => item.label === "现金流预测")!.value, "暂不可计算（缺少现金流输入）");
    assert.match(view.report.sections[0]!.paragraphs[0]!, /未生成完整汇总/);
  } finally { await fixture.close(); }
});

test("unavailable CFO remains explicitly degraded while deterministic report remains readable", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture({ cfoNarrativePort: {
    async synthesize() { throw new Error("isolated model unavailable"); }
  } });
  try {
    const run = await advanceFinancialCouncilToApproval(fixture);
    const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
    assert.equal(view.narrative?.narrativeStatus, "model_unavailable");
    assert.equal(view.roles.find(role => role.role === "cfo")!.state, "degraded");
    assert.equal(view.report.complete, true);
    assert.ok(view.report.sections[0]!.paragraphs.some(text => text.includes("降级")));
    assert.equal(view.events.some(event => event.role === "cfo" && event.state === "completed"), false);
  } finally { await fixture.close(); }
});
