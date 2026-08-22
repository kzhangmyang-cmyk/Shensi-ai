import {
  moneyYuanToMinor,
  type BusinessReportInput
} from "./domain.js";

export type StatementCell = string | number | null | undefined;
export type StatementRow = readonly StatementCell[];

export interface StatementTable {
  readonly name?: string;
  readonly rows: readonly StatementRow[];
}

export interface ParsedStatements {
  readonly input: BusinessReportInput;
  readonly companyName: string;
  readonly period: string;
  readonly warnings: readonly string[];
}

export interface ParsedCompanyResult {
  readonly companyName: string;
  readonly period: string;
  readonly warnings: readonly string[];
  readonly input?: BusinessReportInput;
  readonly report?: unknown;
  readonly error?: string;
  readonly errorCode?: string;
}

export function statementImportError(
  code: string,
  message = code
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function cellText(cell: StatementCell): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function normalizeLabel(raw: string): string {
  return raw
    .replace(/[\s\u3000]+/gu, "")
    .replace(/^减[:：]/u, "")
    .replace(/^其中[:：]/u, "")
    .replace(/^加[:：]/u, "");
}

function toNumber(raw: string): number | null {
  if (!raw) return 0;
  const value = Number(raw.replace(/[,\s\u3000]/gu, ""));
  return Number.isFinite(value) ? value : null;
}

function requireRow(
  table: readonly StatementRow[],
  header: readonly string[],
  kind: "balanceSheet" | "incomeStatement"
): void {
  if (table.length === 0) {
    throw statementImportError("statement_empty", `${kind} 报表内容为空`);
  }
  const joined = table.join("\n");
  const expected = kind === "balanceSheet"
    ? ["流动资产合计", "负债合计"]
    : ["营业收入", "净利润"];
  const missing = expected.filter((label) => !joined.includes(label));
  if (missing.length > 0) {
    throw statementImportError(
      "statement_unsupported",
      `未能识别${kind === "balanceSheet" ? "资产负债表" : "利润表"}，缺少关键行：${missing.join("、")}。请确认上传的是标准企业报表（资产负债表/利润表）。`
    );
  }
  if (!header.includes(kind === "balanceSheet" ? "期末余额" : "行次")) {
    throw statementImportError(
      "statement_unsupported",
      `未能识别${kind === "balanceSheet" ? "资产负债表" : "利润表"}表头，请确认上传标准报表。`
    );
  }
}

interface SheetLayout {
  readonly headerRow: number;
  readonly valueCol: number;
  readonly previousCol: number;
  readonly rightLabelCol?: number;
  readonly rightValueCol?: number;
  readonly rightPreviousCol?: number;
}

function findBalanceSheetLayout(
  rows: readonly StatementRow[]
): SheetLayout {
  for (let i = 0; i < rows.length; i += 1) {
    const cells = rows[i].map(cellText);
    if (!cells.includes("资产") || !cells.includes("行次")) continue;
    const valueCol = cells.findIndex((cell) => cell.includes("期末余额"));
    const previousCol = cells.findIndex(
      (cell) => cell.includes("年初余额") || cell.includes("上年年末余额")
    );
    if (valueCol < 0) continue;
    const rightValueCol = cells.findIndex(
      (cell, index) => index > valueCol && cell.includes("期末余额")
    );
    const rightPreviousCol = cells.findIndex(
      (cell, index) =>
        index > previousCol
        && (cell.includes("年初余额") || cell.includes("上年年末余额"))
    );
    const rightLabelCol = cells.findIndex(
      (cell, index) => index > 0 && cell.includes("负债")
    );
    return {
      headerRow: i,
      valueCol,
      previousCol,
      rightLabelCol: rightLabelCol >= 0 ? rightLabelCol : 4,
      rightValueCol: rightValueCol >= 0 ? rightValueCol : undefined,
      rightPreviousCol: rightPreviousCol >= 0 ? rightPreviousCol : undefined
    };
  }
  throw statementImportError(
    "statement_unsupported",
    "未能识别资产负债表表头（资产/行次/期末余额）。"
  );
}

function findIncomeStatementLayout(
  rows: readonly StatementRow[]
): SheetLayout {
  for (let i = 0; i < rows.length; i += 1) {
    const cells = rows[i].map(cellText);
    if (!cells.includes("项目") || !cells.includes("行次")) continue;
    const cumulative = cells.findIndex(
      (cell) => cell.includes("本年累计金额")
    );
    const current = cells.findIndex((cell) => cell.includes("本期金额"));
    const valueCol = cumulative >= 0 ? cumulative : current;
    if (valueCol < 0) continue;
    return { headerRow: i, valueCol, previousCol: -1 };
  }
  throw statementImportError(
    "statement_unsupported",
    "未能识别利润表表头（项目/行次/本年累计金额）。"
  );
}

interface LabeledValues {
  readonly current: number | null;
  readonly previous: number | null;
}

function pick(
  left: number | null,
  right: number | null,
  prefer: "current" | "previous"
): number | null {
  if (prefer === "current") return left ?? right ?? null;
  return right ?? left ?? null;
}

function labelValue(
  label: string,
  values: ReadonlyMap<string, LabeledValues>,
  prefer: "current" | "previous"
): number | null {
  const normalized = normalizeLabel(label);
  const hit = values.get(normalized);
  if (hit) return pick(hit.current, hit.previous, prefer);
  let endsWithHit: LabeledValues | null = null;
  let totalHit: LabeledValues | null = null;
  let containsHit: LabeledValues | null = null;
  for (const [key, hitValue] of values) {
    if (key.endsWith(normalized)) {
      endsWithHit = hitValue;
      break;
    }
    if (key.includes(normalized) && key.includes("合计") && !totalHit) {
      totalHit = hitValue;
    } else if (key.includes(normalized) && !containsHit) {
      containsHit = hitValue;
    }
  }
  const best = endsWithHit ?? totalHit ?? containsHit;
  return best ? pick(best.current, best.previous, prefer) : null;
}

function findCompanyName(rows: readonly StatementRow[]): string {
  for (const row of rows) {
    for (const cell of row) {
      const text = cellText(cell);
      if (text.startsWith("编制单位：")) {
        return text.slice("编制单位：".length).trim();
      }
    }
  }
  return "";
}

function findPeriod(
  rows: readonly StatementRow[],
  incomeRows: readonly StatementRow[]
): string {
  for (const row of rows) {
    for (const cell of row) {
      const match = /(\d{4})-(\d{2})-\d{2}/u.exec(cellText(cell));
      if (match) return `${match[1]}-${match[2]}`;
    }
  }
  for (const row of incomeRows) {
    const joined = row.map(cellText).join("|");
    const match = /(\d{4})年第(\d)季度/u.exec(joined);
    if (match) return `${match[1]}-Q${match[2]}`;
  }
  return "unknown-period";
}

function classifySheet(
  table: StatementTable
): "balanceSheet" | "incomeStatement" | "unknown" {
  const joined = table.rows.map((row) => row.map(cellText).join("|")).join("\n");
  if (joined.includes("流动资产合计") && joined.includes("期末余额")) {
    return "balanceSheet";
  }
  if (joined.includes("营业收入") && joined.includes("行次")) {
    return "incomeStatement";
  }
  return "unknown";
}

export function companyNameFromSheetName(raw: string): string {
  return raw
    .replace(/^[\d\s_]*/u, "")
    .replace(
      /(资产负债表|利润表季报|利润表|现金流量表|_[0-9]+|[0-9]{4}年(第[一二三四1-4]季度)?|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}年[0-9]{1,2}月)/gu,
      ""
    )
    .replace(/[_\-\s]+$/u, "")
    .trim();
}

export function parseStatementSheets(
  sheets: readonly StatementTable[]
): readonly ParsedCompanyResult[] {
  interface CompanyAccumulator {
    readonly companyName: string;
    readonly balanceSheets: StatementTable[];
    readonly incomeStatements: StatementTable[];
  }
  const groups = new Map<string, CompanyAccumulator>();
  for (const sheet of sheets) {
    const kind = classifySheet(sheet);
    if (kind === "unknown") continue;
    const companyName = findCompanyName(sheet.rows)
      || (sheet.name ? companyNameFromSheetName(sheet.name) : "")
      || "未命名企业";
    const group = groups.get(companyName) ?? {
      companyName,
      balanceSheets: [],
      incomeStatements: []
    };
    if (kind === "balanceSheet") group.balanceSheets.push(sheet);
    else group.incomeStatements.push(sheet);
    groups.set(companyName, group);
  }

  const results: ParsedCompanyResult[] = [];
  for (const group of [...groups.values()].sort(
    (a, b) => a.companyName.localeCompare(b.companyName, "zh-CN")
  )) {
    const balanceSheet = group.balanceSheets[0];
    const incomeStatement = group.incomeStatements[0];
    if (!balanceSheet || !incomeStatement) {
      results.push(Object.freeze({
        companyName: group.companyName,
        period: "unknown-period",
        warnings: Object.freeze([]),
        error: `缺少${balanceSheet ? "利润表" : "资产负债表"}，无法生成诊断`,
        errorCode: "statement_pair_missing"
      }));
      continue;
    }
    try {
      const parsed = parseStatements(
        balanceSheet,
        incomeStatement,
        group.companyName
      );
      results.push(Object.freeze({
        companyName: parsed.companyName,
        period: parsed.period,
        warnings: parsed.warnings,
        input: parsed.input
      }));
    } catch (error) {
      const e = error as { code?: string; message?: string };
      results.push(Object.freeze({
        companyName: group.companyName,
        period: "unknown-period",
        warnings: Object.freeze([]),
        error: e.message ?? String(error),
        errorCode: e.code ?? "statement_parse_failed"
      }));
    }
  }
  return Object.freeze(results);
}

export function extractBalanceSheet(
  rows: readonly StatementRow[]
): {
  readonly cashMinor: number;
  readonly receivablesMinor: number;
  readonly inventoryMinor: number;
  readonly otherCurrentAssetsMinor: number;
  readonly nonCurrentAssetsMinor: number;
  readonly currentLiabilitiesMinor: number;
  readonly nonCurrentLiabilitiesMinor: number;
  readonly accountsPayableMinor: number;
} {
  const layout = findBalanceSheetLayout(rows);
  const leftValues = new Map<string, LabeledValues>();
  const rightValues = new Map<string, LabeledValues>();
  for (let i = layout.headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const leftLabel = normalizeLabel(cellText(row[0]));
    const rightLabel = layout.rightValueCol === undefined
      ? ""
      : normalizeLabel(cellText(row[layout.rightLabelCol ?? 4]));
    if (leftLabel) {
      leftValues.set(leftLabel, {
        current: toNumber(cellText(row[layout.valueCol])),
        previous: layout.previousCol >= 0
          ? toNumber(cellText(row[layout.previousCol]))
          : null
      });
    }
    if (rightLabel && layout.rightValueCol !== undefined) {
      rightValues.set(rightLabel, {
        current: toNumber(cellText(row[layout.rightValueCol])),
        previous: layout.rightPreviousCol === undefined
          ? null
          : toNumber(cellText(row[layout.rightPreviousCol]))
      });
    }
  }

  const required = (
    label: string,
    side: "left" | "right"
  ): number => {
    const value = labelValue(
      label,
      side === "left" ? leftValues : rightValues,
      "current"
    );
    if (value === null) {
      throw statementImportError(
        "statement_missing_row",
        `资产负债表缺少关键行：${label}`
      );
    }
    return moneyYuanToMinor(value);
  };

  const currentAssetsTotal = required("流动资产合计", "left");
  const totalAssets = (() => {
    const direct = labelValue("资产总计", leftValues, "current")
      ?? labelValue("资产合计", leftValues, "current");
    if (direct !== null) return moneyYuanToMinor(direct);
    const current = labelValue("流动资产合计", leftValues, "current")!;
    const nonCurrent = labelValue("非流动资产合计", leftValues, "current");
    if (nonCurrent !== null) {
      return moneyYuanToMinor(current + nonCurrent);
    }
    throw statementImportError(
      "statement_missing_row",
      "资产负债表缺少资产合计行"
    );
  })();
  const cashMinor = required("货币资金", "left");
  const receivablesMinor = required("应收账款", "left");
  const inventoryMinor = required("存货", "left");
  const accountsPayableMinor = required("应付账款", "right");
  const currentLiabilitiesMinor = required("流动负债合计", "right");
  const totalLiabilities = required("负债合计", "right");
  const nonCurrentAssetsStatement = labelValue(
    "非流动资产合计",
    leftValues,
    "current"
  );
  const nonCurrentLiabilitiesStatement = labelValue(
    "非流动负债合计",
    rightValues,
    "current"
  );
  const equityTotalStatement = labelValue(
    "所有者权益",
    rightValues,
    "current"
  );

  const otherCurrentAssetsMinor = Math.max(
    0,
    currentAssetsTotal - cashMinor - receivablesMinor - inventoryMinor
  );
  const nonCurrentAssetsMinor = nonCurrentAssetsStatement === null
    ? Math.max(0, totalAssets - currentAssetsTotal)
    : moneyYuanToMinor(nonCurrentAssetsStatement);
  const nonCurrentLiabilitiesMinor = nonCurrentLiabilitiesStatement === null
    ? Math.max(0, totalLiabilities - currentLiabilitiesMinor)
    : moneyYuanToMinor(nonCurrentLiabilitiesStatement);

  const assetFootDiff = Math.abs(
    totalAssets - currentAssetsTotal - nonCurrentAssetsMinor
  );
  const liabilityFootDiff = Math.abs(
    totalLiabilities - currentLiabilitiesMinor - nonCurrentLiabilitiesMinor
  );
  const equityFootDiff = equityTotalStatement === null
    ? 0
    : Math.abs(
        totalAssets - totalLiabilities - moneyYuanToMinor(equityTotalStatement)
      );
  if (assetFootDiff > 100 || liabilityFootDiff > 100 || equityFootDiff > 100) {
    throw statementImportError(
      "statement_unbalanced",
      "资产负债表勾稽不平（资产合计≠流动资产+非流动资产，或负债合计≠流动+非流动负债，或资产≠负债+权益），请核对报表后重试"
    );
  }

  return Object.freeze({
    cashMinor,
    receivablesMinor,
    inventoryMinor,
    otherCurrentAssetsMinor,
    nonCurrentAssetsMinor,
    currentLiabilitiesMinor,
    nonCurrentLiabilitiesMinor,
    accountsPayableMinor
  });
}

export function extractIncomeStatement(
  rows: readonly StatementRow[]
): {
  readonly revenueMinor: number;
  readonly costOfGoodsSoldMinor: number;
  readonly operatingExpensesMinor: number;
  readonly interestExpenseMinor: number;
  readonly taxExpenseMinor: number;
} {
  const layout = findIncomeStatementLayout(rows);
  const values = new Map<string, LabeledValues>();
  for (let i = layout.headerRow + 1; i < rows.length; i += 1) {
    const label = normalizeLabel(cellText(rows[i][0]));
    if (!label) continue;
    values.set(label, {
      current: toNumber(cellText(rows[i][layout.valueCol])),
      previous: null
    });
  }

  const required = (label: string): number => {
    const value = labelValue(label, values, "current");
    if (value === null) {
      throw statementImportError(
        "statement_missing_row",
        `利润表缺少关键行：${label}`
      );
    }
    return moneyYuanToMinor(value);
  };

  const revenueMinor = required("营业收入");
  const costOfGoodsSoldMinor = required("营业成本");
  const netProfitMinor = required("净利润");
  const taxExpenseMinor = required("所得税费用");
  const interestExpenseMinor = required("财务费用");
  const operatingExpensesMinor =
    revenueMinor
    - costOfGoodsSoldMinor
    - netProfitMinor
    - interestExpenseMinor
    - taxExpenseMinor;
  if (operatingExpensesMinor < 0) {
    throw statementImportError(
      "statement_unbalanced",
      "利润表科目无法勾稽（收入-成本-净利润-财务费用-所得税费用 为负），请核对报表后重试"
    );
  }
  return Object.freeze({
    revenueMinor,
    costOfGoodsSoldMinor,
    operatingExpensesMinor,
    interestExpenseMinor,
    taxExpenseMinor
  });
}

export function parseStatements(
  balanceSheetTable: StatementTable,
  incomeStatementTable: StatementTable,
  companyNameHint?: string
): ParsedStatements {
  const bsRows = balanceSheetTable.rows;
  const isRows = incomeStatementTable.rows;
  requireRow(bsRows, ["资产", "行次", "期末余额"], "balanceSheet");
  requireRow(isRows, ["项目", "行次", "本年累计金额"], "incomeStatement");

  const balanceSheet = extractBalanceSheet(bsRows);
  const incomeStatement = extractIncomeStatement(isRows);
  const companyName = companyNameHint
    || findCompanyName(bsRows)
    || findCompanyName(isRows);
  const period = findPeriod(bsRows, isRows);

  const input: BusinessReportInput = Object.freeze({
    currency: "CNY",
    companyName: companyName || "未命名企业",
    period,
    balanceSheet: Object.freeze({
      period,
      ...balanceSheet
    }),
    incomeStatement: Object.freeze({
      period,
      ...incomeStatement
    })
  });

  const warnings = Object.freeze([
    "未提供现金流量表，现金流预测与资金预警暂不可用（收现比/净现比不参与评分）",
    "未提供成本明细与税务风险数据，成本异常与税务体检暂不可用"
  ]);

  return Object.freeze({
    input,
    companyName: input.companyName,
    period,
    warnings
  });
}
