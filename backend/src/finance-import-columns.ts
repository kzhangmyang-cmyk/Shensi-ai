import { GrowthHttpError } from "./growth-command-context.js";
import type { FinanceImportKind } from "./finance-import-repository.js";

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  externalId: ["外部ID", "外部编号", "流水号"], category: ["费用类别", "费用类型"],
  factType: ["事实类型", "财务事实类型", "业务类型"], amount: ["金额"],
  currency: ["币种", "货币"], businessOccurredAt: ["业务发生时间", "发生时间", "业务日期", "日期"],
  provenance: ["来源"], status: ["状态"], revenue: ["收入", "营业收入"], grossProfit: ["毛利"],
  candidateId: ["候选客户ID"], customerId: ["客户ID"], dealId: ["商机ID"]
};
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

/** Closed, exact aliases only: no fuzzy matching and no silent first-column wins. */
export function financeImportColumnIndexes(headers: readonly string[], mapping: Readonly<Record<string, string>>,
  kind: FinanceImportKind): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  const normalizedHeaders = headers.map(normalize);
  const automatic = Object.keys(mapping).length === 0;
  const fields = automatic ? Object.keys(ALIASES).filter(field => kind === "financial_fact"
    ? !["category", "candidateId", "customerId", "dealId"].includes(field)
    : !["factType", "revenue", "grossProfit", "candidateId", "customerId", "dealId"].includes(field)) : Object.keys(mapping);
  const assigned = new Set<number>();
  for (const field of fields) {
    if (!Object.hasOwn(ALIASES, field)) throw new GrowthHttpError(422, "invalid_finance_import_mapping");
    const aliases = automatic ? [field, ...ALIASES[field]!, ...ALIASES[field]!.map(label => `${field}(${label})`)].map(normalize)
      : [normalize(mapping[field]!)];
    const matches = normalizedHeaders.flatMap((header, index) => aliases.includes(header) ? [index] : []);
    if (matches.length > 1 || (matches.length === 1 && assigned.has(matches[0]!))) {
      throw new GrowthHttpError(422, "invalid_finance_import_mapping");
    }
    const index = matches[0] ?? -1;
    indexes.set(field, index);
    if (index >= 0) assigned.add(index);
  }
  return indexes;
}

const VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: { "接口费用": "api", "API费用": "api", "API 调用": "api", "API调用": "api", "媒体费用": "media", "媒体投放": "media",
    "内容费用": "content", "内容制作": "content", "代理费用": "agency", "代理服务": "agency", "运营费用": "operation", "运营支出": "operation" },
  factType: { "合同成交": "contract_won", "合同赢单": "contract_won", "已收款": "payment_received", "收款": "payment_received", "回款": "payment_received",
    "确认收入": "revenue_recognized", "收入确认": "revenue_recognized", "确认销售成本": "cogs_recognized", "成本确认": "cogs_recognized", "销售成本确认": "cogs_recognized",
    "退款": "refund", "坏账核销": "bad_debt_written_off" },
  currency: { "人民币": "CNY", "RMB": "CNY", "美元": "USD", "欧元": "EUR", "港币": "HKD", "港元": "HKD", "日元": "JPY", "英镑": "GBP" },
  status: { "待核验": "pending", "待确认": "pending", "待核对": "pending" }
};

export function financeImportFieldValue(field: string, value: string): string {
  const trimmed = value.trim();
  return Object.hasOwn(VALUES[field] ?? {}, trimmed) ? VALUES[field]![trimmed]! : trimmed;
}
