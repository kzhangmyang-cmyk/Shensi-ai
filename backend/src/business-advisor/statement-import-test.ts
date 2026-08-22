import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStatementSheets,
  parseStatements,
  type StatementRow
} from "./statement-import.js";
import {
  createBusinessAdvisorService
} from "./service.js";
import {
  normalizeBusinessReport,
  type BusinessReportInput
} from "./domain.js";

function rows(lines: string[][]): readonly StatementRow[] {
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

function smallEnterpriseBalanceSheet(company: string, date: string): readonly StatementRow[] {
  return rows([
    ["资产负债表", "资产负债表", "资产负债表", "资产负债表", "资产负债表", "资产负债表", "资产负债表", "资产负债表"],
    ["会小企01表", "会小企01表", "会小企01表", "会小企01表", "会小企01表", "会小企01表", "会小企01表", "会小企01表"],
    [`编制单位：${company}`, `编制单位：${company}`, `编制单位：${company}`, date, date, "单位：元", "单位：元", "单位：元"],
    ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益", "行次", "期末余额", "年初余额"],
    ["流动资产", "0", "0", "0", "流动负债", "0", "0", "0"],
    ["货币资金", "1", "50773.11", "56773.11", "短期借款", "31", "0", "0"],
    ["应收票据", "3", "0", "0", "应付账款", "33", "108000", "108000"],
    ["应收账款", "4", "1435340.91", "1435340.91", "预收账款", "34", "824530.11", "824530.11"],
    ["预付账款", "5", "150000", "150000", "应付职工薪酬", "35", "1000", "1000"],
    ["其他应收款", "8", "860418.64", "860418.64", "其他应付款", "39", "1001072.14", "1001072.14"],
    ["存货", "9", "0", "0", "", "40", "0", "0"],
    ["其他流动资产", "14", "0", "0", "其他流动负债", "40", "0", "0"],
    ["流动资产合计", "15", "2496532.66", "2502532.66", "流动负债合计", "41", "1934602.25", "1934602.25"],
    ["非流动资产", "0", "0", "0", "非流动负债", "0", "0", "0"],
    ["长期股权投资", "17", "550000", "550000", "递延收益", "44", "1000000", "1000000"],
    ["固定资产账面价值", "20", "9503", "9503", "非流动负债合计", "46", "1000000", "1000000"],
    ["非流动资产合计", "29", "559503", "559503", "负债合计", "47", "2934602.25", "2934602.25"],
    ["资产合计", "30", "3056035.66", "3062035.66", "所有者权益（或股东权益）合计", "52", "121433.41", "127433.41"]
  ]);
}

function smallEnterpriseIncomeStatement(company: string, quarter: string): readonly StatementRow[] {
  return rows([
    ["利润表季报", "利润表季报", "利润表季报", "利润表季报"],
    [`编制单位：${company}`, quarter, quarter, "单位：元"],
    ["项目", "行次", "本年累计金额", "本季金额"],
    ["一、营业收入", "1", "580000", "300000"],
    ["减：营业成本", "2", "300000", "150000"],
    ["税金及附加", "3", "6000", "3000"],
    ["销售费用", "11", "20000", "10000"],
    ["管理费用", "14", "120000", "60000"],
    ["财务费用", "18", "10000", "5000"],
    ["其中：利息费用（收入以“-”号填列）", "19", "9000", "4500"],
    ["二、营业利润（亏损以“-”号填列）", "21", "124000", "72000"],
    ["加：营业外收入", "22", "0", "0"],
    ["减：营业外支出", "24", "0", "0"],
    ["三、利润总额（亏损总额以“-”号填列）", "30", "124000", "72000"],
    ["减：所得税费用", "31", "31000", "18000"],
    ["四、净利润（净亏损以“-”号填列）", "32", "93000", "54000"]
  ]);
}

function generalEnterpriseBalanceSheet(): readonly StatementRow[] {
  return rows([
    ["资产负债表"],
    ["编制单位：郑州乐水科技有限公司", "", "", "", "46203", "单位：元"],
    ["资产", "行次", "期末余额", "上年年末余额", "负债和所有者(或股东)权益", "行次", "期末余额", "上年年末余额"],
    ["流动资产：", "", "", "", "流动负债：", "", "", ""],
    ["货币资金", "1", "185237.27", "108317.09", "短期借款", "35", "0", "0"],
    ["应收票据", "4", "-118320", "65500", "应付账款", "39", "1130904", "1130904"],
    ["应收账款", "5", "742539", "728857", "预收款项", "40", "73100", "73100"],
    ["预付款项", "7", "954045.55", "589045.55", "应付职工薪酬", "42", "-52080.83", "120154.64"],
    ["其他应收款", "8", "923405.07", "896096.73", "应交税费", "43", "39322.21", "-1003.11"],
    ["存货", "9", "76190.31", "76190.31", "其他应付款", "44", "102207.57", "553581.62"],
    ["其他流动资产", "13", "1708.9", "1708.9", "其他流动负债", "47", "0", "0"],
    ["流动资产合计", "14", "2764806.1", "2465715.58", "流动负债合计", "48", "1293452.95", "1876737.15"],
    ["非流动资产：", "", "0", "0", "非流动负债：", "", "0", "0"],
    ["固定资产", "22", "130387.29", "130387.29", "长期借款", "49", "1631049.68", "1480793.03"],
    ["非流动资产合计", "33", "130387.29", "130387.29", "非流动负债合计", "59", "1631049.68", "1480793.03"],
    ["资产总计", "72", "2895193.39", "2596102.87", "负债合计", "60", "2924502.63", "3357530.18"],
    ["", "", "0", "0", "所有者权益（或股东权益）合计", "71", "-29309.2399999998", "-761427.31"]
  ]);
}

function generalEnterpriseIncomeStatement(): readonly StatementRow[] {
  return rows([
    ["利润表"],
    ["编制单位：郑州乐水科技有限公司", "2026年第2季度", "", "单位：元"],
    ["项目", "行次", "本期金额", "本年累计金额"],
    ["一、营业收入", "1", "892360.54", "2656287.79"],
    ["减：营业成本", "2", "146282.4", "1015713.04"],
    ["税金及附加", "3", "238.85", "2284.59"],
    ["销售费用", "4", "", ""],
    ["管理费用", "5", "220047.37", "869288.53"],
    ["研发费用", "6", "", ""],
    ["财务费用", "7", "9411.66", "19075.48"],
    ["其中：利息费用", "8", "9284.18", "18455.81"],
    ["利息收入", "9", "-16.15", "-50.96"],
    ["二、营业利润（亏损以“-”号填列）", "19", "516380.26", "749926.15"],
    ["加：营业外收入", "20", "84.8", "3465.92"],
    ["减：营业外支出", "21", "21264.29", "21274"],
    ["三、利润总额（亏损总额以“-”号填列）", "22", "495200.77", "732118.07"],
    ["减：所得税费用", "23", "", ""],
    ["四、净利润（净亏损以“-”号填列）", "24", "495200.77", "732118.07"],
    ["（一）持续经营净利润（净亏损以“-”号填列）", "25", "495200.77", "732118.07"],
    ["（二）终止经营净利润（净亏损以“-”号填列）", "26", "", ""]
  ]);
}

test("parses small-enterprise statements into a runnable engine input", () => {
  const parsed = parseStatements(
    { rows: smallEnterpriseBalanceSheet("中原影视孵化器有限公司", "2026-06-30") },
    { rows: smallEnterpriseIncomeStatement("中原影视孵化器有限公司", "2026年第2季度") }
  );
  assert.equal(parsed.companyName, "中原影视孵化器有限公司");
  assert.equal(parsed.period, "2026-06");
  assert.equal(parsed.input.currency, "CNY");
  assert.equal(parsed.input.balanceSheet.cashMinor, 5_077_311);
  assert.equal(parsed.input.balanceSheet.receivablesMinor, 143_534_091);
  assert.equal(parsed.input.balanceSheet.inventoryMinor, 0);
  assert.equal(parsed.input.balanceSheet.otherCurrentAssetsMinor, 101_041_864);
  assert.equal(parsed.input.balanceSheet.nonCurrentAssetsMinor, 55_950_300);
  assert.equal(parsed.input.balanceSheet.currentLiabilitiesMinor, 193_460_225);
  assert.equal(parsed.input.balanceSheet.nonCurrentLiabilitiesMinor, 100_000_000);
  assert.equal(parsed.input.balanceSheet.accountsPayableMinor, 10_800_000);
  assert.equal(parsed.input.incomeStatement.revenueMinor, 58_000_000);
  assert.equal(parsed.input.incomeStatement.costOfGoodsSoldMinor, 30_000_000);
  assert.equal(parsed.input.incomeStatement.interestExpenseMinor, 1_000_000);
  assert.equal(parsed.input.incomeStatement.taxExpenseMinor, 3_100_000);
  // 期间费用由报表自身勾稽倒推，保证净利润口径一致
  assert.equal(parsed.input.incomeStatement.operatingExpensesMinor, 14_600_000);
  assert.equal(parsed.input.cashFlow, undefined);
  assert.equal(parsed.warnings.length, 2);

  const normalized = normalizeBusinessReport(parsed.input);
  assert.equal(normalized.netProfitMinor, 9_300_000);
  const report = createBusinessAdvisorService().diagnose(parsed.input);
  assert.equal(report.companyName, "中原影视孵化器有限公司");
  assert.ok(report.healthScoreBps >= 0 && report.healthScoreBps <= 10_000);
});

test("parses general-enterprise statements with negative equity without error", () => {
  const parsed = parseStatements(
    { rows: generalEnterpriseBalanceSheet() },
    { rows: generalEnterpriseIncomeStatement() }
  );
  assert.equal(parsed.companyName, "郑州乐水科技有限公司");
  assert.equal(parsed.input.balanceSheet.cashMinor, 18_523_727);
  assert.equal(parsed.input.balanceSheet.nonCurrentLiabilitiesMinor, 163_104_968);
  assert.equal(parsed.input.incomeStatement.revenueMinor, 265_628_779);
  assert.equal(parsed.input.incomeStatement.taxExpenseMinor, 0);
  const normalized = normalizeBusinessReport(parsed.input);
  assert.equal(normalized.netProfitMinor, 73_211_807);
  assert.equal(normalized.equityMinor, -2_930_924);
});

test("unbalanced balance sheet fails loudly", () => {
  const bs = smallEnterpriseBalanceSheet("示例公司", "2026-06-30");
  const broken = bs.map((row) => {
    if (String(row[0]).includes("流动资产合计")) {
      const copy = [...row];
      copy[2] = "2000000";
      return Object.freeze(copy);
    }
    return row;
  });
  assert.throws(
    () => parseStatements(
      { rows: broken },
      { rows: smallEnterpriseIncomeStatement("示例公司", "2026年第2季度") }
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "statement_unbalanced"
  );
});

test("unsupported tables are rejected with a clear message", () => {
  assert.throws(
    () => parseStatements({ rows: [] }, { rows: [] }),
    (error: unknown) => (error as { code?: string }).code === "statement_empty"
  );
  assert.throws(
    () => parseStatements(
      { rows: [["a", "b"]] },
      { rows: generalEnterpriseIncomeStatement() }
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "statement_unsupported"
  );
});

test("parsed input without cash flow produces a diagnosis with cash warnings absent", () => {
  const parsed = parseStatements(
    { rows: smallEnterpriseBalanceSheet("中原影视孵化器有限公司", "2026-06-30") },
    { rows: smallEnterpriseIncomeStatement("中原影视孵化器有限公司", "2026年第2季度") }
  );
  const input = parsed.input as BusinessReportInput;
  assert.equal(input.cashFlow, undefined);
  const service = createBusinessAdvisorService();
  const analysis = service.analyze(input);
  assert.equal(analysis.cashflow.warning.length, 0);
  assert.equal(analysis.indicators.cashProfitRatioBps, 0);
  assert.equal(analysis.indicators.cashCollectionRatioBps, 0);
  const report = service.diagnose(input);
  assert.ok(!report.issues.some((item) => item.title === "利润与现金背离"));
});

test("multiple companies in one workbook are grouped and parsed independently", () => {
  const firstBs = smallEnterpriseBalanceSheet("甲公司", "2026-06-30");
  const firstIs = smallEnterpriseIncomeStatement("甲公司", "2026年第2季度");
  const secondBs = smallEnterpriseBalanceSheet("乙公司", "2026-06-30");
  const secondIs = smallEnterpriseIncomeStatement("乙公司", "2026年第2季度");
  const companies = parseStatementSheets([
    { name: "甲公司资产负债表", rows: firstBs },
    { name: "甲公司利润表", rows: firstIs },
    { name: "乙公司资产负债表", rows: secondBs },
    { name: "乙公司利润表", rows: secondIs }
  ]);
  assert.equal(companies.length, 2);
  assert.deepEqual(
    companies.map((company) => company.companyName),
    ["甲公司", "乙公司"]
  );
  for (const company of companies) {
    assert.ok(company.input);
    assert.equal(company.error, undefined);
    assert.equal(company.input!.incomeStatement.revenueMinor, 58_000_000);
  }
});

test("a broken company does not block the rest of the group import", () => {
  const goodBs = smallEnterpriseBalanceSheet("好公司", "2026-06-30");
  const goodIs = smallEnterpriseIncomeStatement("好公司", "2026年第2季度");
  const badBs = smallEnterpriseBalanceSheet("坏公司", "2026-06-30").map((row) => {
    if (String(row[0]).includes("流动资产合计")) {
      const copy = [...row];
      copy[2] = "2000000";
      return Object.freeze(copy);
    }
    return row;
  });
  const badIs = smallEnterpriseIncomeStatement("坏公司", "2026年第2季度");
  const companies = parseStatementSheets([
    { name: "好公司资产负债表", rows: goodBs },
    { name: "好公司利润表", rows: goodIs },
    { name: "坏公司资产负债表", rows: badBs },
    { name: "坏公司利润表", rows: badIs }
  ]);
  const good = companies.find((company) => company.companyName === "好公司");
  const bad = companies.find((company) => company.companyName === "坏公司");
  assert.ok(good?.input);
  assert.equal(good?.error, undefined);
  assert.equal(bad?.input, undefined);
  assert.equal(bad?.errorCode, "statement_unbalanced");
});

test("sheet name is used as the company fallback when 编制单位 is missing", () => {
  const bs = smallEnterpriseBalanceSheet("中原影视孵化器有限公司", "2026-06-30")
    .map((row) => Object.freeze(
      row.map((cell) =>
        String(cell).startsWith("编制单位：") ? "" : cell)
    ));
  const is = smallEnterpriseIncomeStatement("中原影视孵化器有限公司", "2026年第2季度")
    .map((row) => Object.freeze(
      row.map((cell) =>
        String(cell).startsWith("编制单位：") ? "" : cell)
    ));
  const companies = parseStatementSheets([
    { name: "中原影视孵化器有限公司资产负债表", rows: bs },
    { name: "中原影视孵化器有限公司利润表", rows: is }
  ]);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].companyName, "中原影视孵化器有限公司");
  assert.ok(companies[0].input);
});

test("a company missing one statement is reported instead of silently dropped", () => {
  const companies = parseStatementSheets([
    {
      name: "缺利润表公司",
      rows: smallEnterpriseBalanceSheet("缺利润表公司", "2026-06-30")
    }
  ]);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].errorCode, "statement_pair_missing");
  assert.ok(companies[0].error?.includes("利润表"));
});
