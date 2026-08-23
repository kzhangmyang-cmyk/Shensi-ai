import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import { InMemoryFinancialStatementPackageRepository } from
  "./financial-statement-package-repository.js";
import { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";

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
