import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import { InMemoryFinancialStatementPackageRepository } from
  "./financial-statement-package-repository.js";
import type { CommitFinancialStatementPackageInput } from
  "./financial-statement-package-repository.js";
import { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";
import { previewFixture } from
  "./financial-statement-package-repository-contract-test.js";
import {
  createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationCommand,
  financialCouncilIntegrationPolicyInput,
  financialCouncilIntegrationWorkspace
} from "./financial-council-integration-fixtures.js";
import { validateFinancialSnapshotForRun } from
  "./financial-council-snapshot.js";
import { buildFinancialFormulaCatalog } from
  "./financial-council-formulas.js";

function upload(kind: "balance_sheet" | "income_statement"
  | "cash_flow_statement", rows: readonly (readonly unknown[])[]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,
    XLSX.utils.aoa_to_sheet(rows as unknown[][]), "报表");
  return { kind, fileName: `${kind}.xlsx`,
    mediaType: ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const),
    contentBase64: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
      .toString("base64") };
}

function uploads() {
  const metadata = ["编制单位：示例公司", "2026年第2季度", "币种：CNY"];
  return [
    upload("balance_sheet", [
      ["编制单位：示例公司", "2026-06-30", "币种：CNY"],
      ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益", "行次", "期末余额", "年初余额"],
      ["货币资金", 1, 10750, 10000, "应付账款", 1, 1000, 1000],
      ["应收账款", 2, 2000, 2000, "流动负债合计", 2, 3000, 3000],
      ["存货", 3, 1000, 1000, "非流动负债合计", 3, 1000, 1000],
      ["流动资产合计", 4, 14750, 14000, "负债合计", 4, 4000, 4000],
      ["非流动资产合计", 5, 5250, 6000, "所有者权益合计", 5, 16000, 16000],
      ["资产合计", 6, 20000, 20000]
    ]),
    upload("income_statement", [metadata,
      ["项目", "行次", "本年累计金额"], ["营业收入", 1, 10000],
      ["营业成本", 2, 6000], ["财务费用", 3, 100],
      ["所得税费用", 4, 400], ["净利润", 5, 2500]]),
    upload("cash_flow_statement", [metadata,
      ["项目", "行次", "本年累计金额"],
      ["期初现金及现金等价物余额", 1, 10000],
      ["经营活动现金流入小计", 2, 5000],
      ["经营活动现金流出小计", 3, 4100],
      ["投资活动产生的现金流量净额", 4, -200],
      ["筹资活动产生的现金流量净额", 5, 50],
      ["期末现金及现金等价物余额", 6, 10750]])
  ] as const;
}

const command = { workspaceId: "workspace-a", actorId: "actor-a",
  idempotencyKey: "key-1", requestHash: `sha256:${"1".repeat(64)}` as const };

const cashForecast = {
  forecastAsOf: "2026-08-23T12:10:00.000Z",
  expectedInflowsNext30DaysMinor: 100_000,
  expectedOutflowsNext30DaysMinor: 500_000,
  expectedInflowsNext31To90DaysMinor: 800_000,
  expectedOutflowsNext31To90DaysMinor: 300_000,
  receivables: [
    { customer: "客户 B", amountMinor: 300_000, daysOutstanding: 30 },
    { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 }
  ],
  attestation: { accepted: true as const,
    noticeVersion: "financial-cash-forecast.v1" as const }
};

test("preview is non-authoritative and commit requires consent", async () => {
  const repository = new InMemoryFinancialStatementPackageRepository();
  const service = new FinancialStatementPackageService({ repository,
    now: () => "2026-08-23T12:10:00.000Z", ids: { next: () => "preview-1" } });
  const preview = await service.preview(command, { uploads: uploads() });
  assert.equal(preview.status, "preview");
  assert.equal(await repository.getVerified("workspace-a", "preview-1"), null);
  await assert.rejects(service.commit(command, { previewId: preview.previewId,
    consent: null }), (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_consent_required");
  await assert.rejects(service.commit(command, { previewId: preview.previewId,
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z",
      extra: true } as never }),
  (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_consent_required");
  const committed = await service.commit(command, { previewId: preview.previewId,
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z" } });
  assert.equal(committed.value.businessReport.cashFlow?.forecast.status,
    "not_computable");
  assert.equal(committed.value.forecastStatus, "not_computable");
  assert.equal(committed.value.cashForecast, null);
});

test("commit stamps and forwards one canonical forecast with preview authority",
  async () => {
  const repository = new InMemoryFinancialStatementPackageRepository();
  await repository.appendPreview(previewFixture());
  let commits = 0;
  let recorded: CommitFinancialStatementPackageInput | undefined;
  const realCommit = repository.commitPreview.bind(repository);
  repository.commitPreview = async (input) => {
    commits += 1;
    recorded = input;
    return realCommit(input);
  };
  const service = new FinancialStatementPackageService({ repository,
    now: () => "2026-08-23T12:11:00.000Z" });
  const result = await service.commit(command, {
    previewId: "preview-1",
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:10:30.000Z" },
    cashForecast
  });
  assert.equal(commits, 1);
  assert.equal(recorded?.cashForecast?.acceptedBy, "actor-a");
  assert.equal(recorded?.cashForecast?.acceptedAt,
    "2026-08-23T12:11:00.000Z");
  assert.equal(recorded?.cashForecast?.currency, "CNY");
  assert.equal(recorded?.cashForecast?.forecastAsOf.slice(0, 10),
    "2026-08-23");
  assert.deepEqual(recorded?.cashForecast?.receivables.map((row) => row.customer),
    ["客户 A", "客户 B"]);
  assert.equal(result.value.forecastStatus, "computed");
  assert.equal(result.value.cashForecast?.forecastHash,
    recorded?.cashForecast?.forecastHash);
  assert.equal((await repository.getVerified("workspace-a",
    result.value.packageId))?.cashForecast?.acceptedAt,
  "2026-08-23T12:11:00.000Z");
});

test("invalid forecast input causes zero repository writes", async () => {
  const repository = new InMemoryFinancialStatementPackageRepository();
  await repository.appendPreview(previewFixture());
  let commits = 0;
  const realCommit = repository.commitPreview.bind(repository);
  repository.commitPreview = async (input) => {
    commits += 1;
    return realCommit(input);
  };
  const service = new FinancialStatementPackageService({ repository,
    now: () => "2026-08-23T12:11:00.000Z" });
  await assert.rejects(service.commit(command, {
    previewId: "preview-1",
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z" },
    cashForecast: { ...cashForecast, acceptedBy: "attacker" } as never
  }), (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_input_invalid");
  assert.equal(commits, 0);
  assert.equal(await repository.getVerified("workspace-a", "package-1"), null);
});

test("secure upload parser rejects formulas", async () => {
  const files = uploads();
  const workbook = XLSX.read(Buffer.from(files[1].contentBase64, "base64"));
  workbook.Sheets[workbook.SheetNames[0]!]!.C3 = { t: "n", v: 10000,
    f: "1+1" };
  const formula = { ...files[1], contentBase64: XLSX.write(workbook,
    { type: "buffer", bookType: "xlsx" }).toString("base64") };
  const service = new FinancialStatementPackageService({
    repository: new InMemoryFinancialStatementPackageRepository() });
  await assert.rejects(service.preview(command,
    { uploads: [files[0], formula, files[2]] }),
  (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_formula_forbidden");
});

test("three-statement package reaches explicit not-computable council state",
  async () => {
  const repository = new InMemoryFinancialStatementPackageRepository();
  const service = new FinancialStatementPackageService({ repository,
    now: () => "2026-08-16T08:09:00.000Z",
    ids: { next: () => "three-statement-preview" } });
  const context = { workspaceId: "council-e2e", actorId: "council-admin",
    idempotencyKey: "three-statement-preview-key",
    requestHash: `sha256:${"7".repeat(64)}` as const };
  const preview = await service.preview(context, { uploads: uploads() });
  const committed = await service.commit({ ...context,
    idempotencyKey: "three-statement-commit-key",
    requestHash: `sha256:${"8".repeat(64)}` }, {
    previewId: preview.previewId,
    consent: { accepted: true, noticeVersion: "financial-model-data.v1",
      acceptedBy: context.actorId, acceptedAt: "2026-08-16T08:09:00.000Z" }
  });
  assert.deepEqual(committed.value.businessReport.cashFlow?.forecast,
    { status: "not_computable",
      reason: "source_statements_do_not_provide_forecast" });
  const fixture = await createFinancialCouncilIntegrationFixture({
    statementPackageRepository: service
  });
  try {
    const initial = await fixture.service.getPolicy(
      financialCouncilIntegrationWorkspace()
    );
    const policy = await fixture.service.updatePolicy(
      financialCouncilIntegrationCommand("three-statement-policy",
        initial.revision), financialCouncilIntegrationPolicyInput()
    );
    const created = await fixture.service.createRunFromStatementPackage(
      financialCouncilIntegrationCommand("three-statement-run", null), {
        statementPackageId: committed.value.packageId,
        policyVersionId: policy.value.policyVersionId
      }
    );
    const verified = await fixture.repository.getVerifiedRunSnapshot(
      financialCouncilIntegrationWorkspace(), created.value.runId
    );
    assert.ok(verified);
    const snapshot = validateFinancialSnapshotForRun(
      verified.snapshot, verified.run
    );
    assert.deepEqual(snapshot.formulaInputs.cashflow,
      { status: "not_computable", reason: "cash_flow_missing" });
    const catalog = buildFinancialFormulaCatalog({ snapshot,
      businessReport: verified.run.businessReport,
      policy: { formulaPolicyVersion: "financial-council-formula-policy.v1",
        minimumProductMarginBps: 1_000,
        minimumCashReserveMinor: 900_000 } });
    assert.ok(catalog.dataGaps.some((gap) =>
      gap.formulaId === "cashflow_forecast"));
    await fixture.pipeline.wake(created.value);
    assert.equal((await fixture.service.getRun(
      financialCouncilIntegrationWorkspace(), created.value.runId
    )).status, "not_computable");
  } finally {
    await fixture.close();
  }
});
