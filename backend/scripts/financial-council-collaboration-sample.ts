/** Isolated acceptance artifact: in-memory sample/model only, never the app DB. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { advanceFinancialCouncilToApproval, createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationWorkspace } from "../src/financial-council-integration-fixtures.js";
import { renderReportHtml } from "../../frontend/src/growth/council/report.ts";

const fixture = await createFinancialCouncilIntegrationFixture({
  rebutExplanation: "风险偏好对方案选择仍有重要影响。"
});
try {
  const before = fixture.authorityReadHash();
  const run = await advanceFinancialCouncilToApproval(fixture);
  const view = await fixture.service.getCollaboration(financialCouncilIntegrationWorkspace(), run.runId);
  assert.equal(view.report.complete, true);
  assert.equal(fixture.authorityReadHash(), before);
  assert.equal((await fixture.service.listDispatches(financialCouncilIntegrationWorkspace(), run.runId)).length, 0);
  const directory = new URL("../../outputs/financial-council-collaboration-sample/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const sample = view;
  // A JSON boundary matches the HTTP transport and removes readonly-only TS shapes.
  const html = renderReportHtml(JSON.parse(JSON.stringify(sample.report)))
    .replace("<body>", "<body><p>隔离验收样本 · 非真实公司 · 确定性测试模型；未写入应用数据库。</p>");
  await writeFile(new URL("collaboration.json", directory), `${JSON.stringify(sample, null, 2)}\n`);
  await writeFile(new URL("report.html", directory), html);
  console.log(JSON.stringify({ status: "passed", fixture: "isolated-in-memory-deterministic-model",
    roles: sample.roles.map(role => ({ role: role.role, state: role.state })),
    events: sample.events.length, reviews: sample.reviews.length, chapters: sample.report.sections.length,
    reportId: sample.report.reportId, directory: fileURLToPath(directory) }));
} finally { await fixture.close(); }
