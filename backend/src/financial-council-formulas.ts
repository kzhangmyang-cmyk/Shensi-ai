import {
  analyzeCashflow,
  analyzeCost,
  analyzeCustomerProfit,
  analyzeFinancialIndicators,
  analyzeProductProfit,
  analyzeTaxRisk
} from "./business-advisor/analysis.js";
import {
  canonicalBusinessReportInput,
  normalizeBusinessReport,
  type BusinessReportInput
} from "./business-advisor/domain.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import {
  validateFinancialSnapshot,
  type FinancialSnapshot
} from "./financial-council-snapshot.js";
import {
  roundHalfUpDiv,
  safeMinor,
  safeSignedInteger
} from "./growth-money.js";
import type {
  FinancialCouncilDataGap,
  FinancialCouncilEvidenceRef
} from "./growth-contract-types.js";

export type FinancialFormulaUnit =
  | "bps"
  | "count"
  | "minor"
  | "structured";

export type FinancialFormulaId =
  | "cash_shortfall"
  | "cashflow_forecast"
  | "cost_analysis"
  | "customer_true_profit"
  | "eligible_overdue_receivable"
  | "financial_data_gaps"
  | "financial_indicators"
  | "loss_product_pricing_gap"
  | "product_true_profit"
  | "tax_risk"
  | "verified_avoidable_cost";

export interface FinancialFormulaResult<Value = unknown> {
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly currency: string;
  readonly inputHash: `sha256:${string}`;
  readonly resultHash: `sha256:${string}`;
  readonly value: Value;
  readonly unit: FinancialFormulaUnit;
  readonly evidenceRefs: readonly FinancialCouncilEvidenceRef[];
}

export interface FinancialFormulaDataGap {
  readonly formulaId: FinancialFormulaId;
  readonly formulaVersion: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly currency: string;
  readonly dataGap: FinancialCouncilDataGap;
}

export interface FinancialFormulaCatalogPolicy {
  readonly formulaPolicyVersion: "financial-council-formula-policy.v1";
  readonly minimumProductMarginBps: number;
  readonly minimumCashReserveMinor: number;
}

export interface FinancialFormulaCatalog {
  readonly formulaResults: readonly FinancialFormulaResult[];
  readonly dataGaps: readonly FinancialFormulaDataGap[];
}

interface CreateFinancialFormulaResultInput {
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly currency: string;
  readonly input: unknown;
  readonly value: unknown;
  readonly unit: FinancialFormulaUnit;
  readonly evidenceRefs: readonly FinancialCouncilEvidenceRef[];
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
// P1 allows six independent authority slices of at most 99 rows, plus the
// business-report and aggregate CRM refs.
const MAX_FORMULA_EVIDENCE_REFS = 596;
const FORMULA_TEXT = /^[a-z0-9][a-z0-9._-]{0,190}$/u;
const EVIDENCE_SOURCES = new Set<FinancialCouncilEvidenceRef["source"]>([
  "acquisition_cost", "business_report", "crm", "financial_fact", "quote",
  "roi"
]);
const UNITS = new Set<FinancialFormulaUnit>([
  "bps", "count", "minor", "structured"
]);
const CATALOG_FORMULA_PROVENANCE = new WeakSet<object>();

const FORMULA_VERSIONS = Object.freeze({
  cash_shortfall: "cash-shortfall.v1",
  cashflow_forecast: "cashflow-forecast.v1",
  cost_analysis: "cost-analysis.v1",
  customer_true_profit: "customer-true-profit.v1",
  eligible_overdue_receivable: "eligible-overdue-receivable.v1",
  financial_data_gaps: "financial-data-gaps.v1",
  financial_indicators: "financial-indicators.v1",
  loss_product_pricing_gap: "loss-product-pricing-gap.v1",
  product_true_profit: "product-true-profit.v1",
  tax_risk: "tax-risk.v1",
  verified_avoidable_cost: "verified-avoidable-cost.v1"
} as const satisfies Readonly<Record<FinancialFormulaId, string>>);

function formulaError(): never {
  throw financialCouncilError("financial_formula_input_invalid");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort(compare);
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort(compare)[index]);
}

function assertSafeNumbers(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      formulaError();
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertSafeNumbers(nested);
  }
}

function canonicalEvidenceRefs(
  value: readonly FinancialCouncilEvidenceRef[]
): readonly FinancialCouncilEvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0
    || value.length > MAX_FORMULA_EVIDENCE_REFS) {
    return formulaError();
  }
  const rows = value.map((candidate) => {
    const row = immutableFinancialCouncilInput(candidate) as unknown;
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !exactKeys(row as Record<string, unknown>, [
        "source", "sourceId", "contentHash"
      ])) return formulaError();
    const record = row as Record<string, unknown>;
    if (!EVIDENCE_SOURCES.has(
      record.source as FinancialCouncilEvidenceRef["source"]
    ) || typeof record.sourceId !== "string" || record.sourceId.trim() === ""
      || record.sourceId.length > 255
      || typeof record.contentHash !== "string"
      || !HASH.test(record.contentHash)) return formulaError();
    return Object.freeze({
      source: record.source as FinancialCouncilEvidenceRef["source"],
      sourceId: record.sourceId,
      contentHash: record.contentHash as `sha256:${string}`
    });
  }).sort((left, right) => compare(left.source, right.source)
    || compare(left.sourceId, right.sourceId)
    || compare(left.contentHash, right.contentHash));
  for (let index = 1; index < rows.length; index += 1) {
    const left = rows[index - 1]!;
    const right = rows[index]!;
    if (left.source === right.source && left.sourceId === right.sourceId) {
      return formulaError();
    }
  }
  return Object.freeze(rows);
}

function resultPreimage(
  result: Omit<FinancialFormulaResult, "resultHash">
): Omit<FinancialFormulaResult, "resultHash"> {
  return result;
}

/** Internal constructor; external formula records are never trusted by hash alone. */
function createFinancialFormulaResult(
  raw: CreateFinancialFormulaResultInput
): FinancialFormulaResult {
  try {
    const stable = immutableFinancialCouncilInput(raw) as unknown;
    if (!stable || typeof stable !== "object" || Array.isArray(stable)
      || !exactKeys(stable as Record<string, unknown>, [
        "formulaId", "formulaVersion", "snapshotId", "snapshotHash",
        "currency", "input", "value", "unit", "evidenceRefs"
      ])) return formulaError();
    const input = stable as unknown as CreateFinancialFormulaResultInput;
    if (typeof input.formulaId !== "string"
      || !FORMULA_TEXT.test(input.formulaId)
      || typeof input.formulaVersion !== "string"
      || !FORMULA_TEXT.test(input.formulaVersion)
      || typeof input.snapshotId !== "string" || input.snapshotId.trim() === ""
      || input.snapshotId.length > 255
      || typeof input.snapshotHash !== "string" || !HASH.test(input.snapshotHash)
      || (input.currency !== "CNY" && input.currency !== "USD")
      || !UNITS.has(input.unit)) return formulaError();
    assertSafeNumbers(input.input);
    assertSafeNumbers(input.value);
    const evidenceRefs = canonicalEvidenceRefs(input.evidenceRefs);
    const inputHash = financialCouncilCanonicalHash({
      formulaId: input.formulaId,
      formulaVersion: input.formulaVersion,
      snapshotId: input.snapshotId,
      snapshotHash: input.snapshotHash,
      currency: input.currency,
      input: input.input,
      evidenceRefs
    });
    const preimage = resultPreimage({
      formulaId: input.formulaId,
      formulaVersion: input.formulaVersion,
      snapshotId: input.snapshotId,
      snapshotHash: input.snapshotHash,
      currency: input.currency,
      inputHash,
      value: input.value,
      unit: input.unit,
      evidenceRefs
    });
    return immutableFinancialCouncilValue({
      ...preimage,
      resultHash: financialCouncilCanonicalHash(preimage)
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_formula_input_invalid") {
      throw error;
    }
    return formulaError();
  }
}

/** Validates closed shape and replay integrity; policy establishes authority. */
export function validateFinancialFormulaResult(
  raw: unknown
): FinancialFormulaResult {
  try {
    const stable = immutableFinancialCouncilInput(raw) as unknown;
    if (!stable || typeof stable !== "object" || Array.isArray(stable)
      || !exactKeys(stable as Record<string, unknown>, [
        "formulaId", "formulaVersion", "snapshotId", "snapshotHash",
        "currency", "inputHash", "resultHash", "value", "unit",
        "evidenceRefs"
      ])) return formulaError();
    const result = stable as unknown as FinancialFormulaResult;
    if (typeof result.formulaId !== "string" || !FORMULA_TEXT.test(result.formulaId)
      || typeof result.formulaVersion !== "string"
      || !FORMULA_TEXT.test(result.formulaVersion)
      || typeof result.snapshotId !== "string" || result.snapshotId.trim() === ""
      || result.snapshotId.length > 255
      || typeof result.snapshotHash !== "string" || !HASH.test(result.snapshotHash)
      || typeof result.inputHash !== "string" || !HASH.test(result.inputHash)
      || typeof result.resultHash !== "string" || !HASH.test(result.resultHash)
      || (result.currency !== "CNY" && result.currency !== "USD")
      || !UNITS.has(result.unit)) return formulaError();
    assertSafeNumbers(result.value);
    const evidenceRefs = canonicalEvidenceRefs(result.evidenceRefs);
    const preimage = resultPreimage({
      formulaId: result.formulaId,
      formulaVersion: result.formulaVersion,
      snapshotId: result.snapshotId,
      snapshotHash: result.snapshotHash,
      currency: result.currency,
      inputHash: result.inputHash,
      value: result.value,
      unit: result.unit,
      evidenceRefs
    });
    if (financialCouncilCanonicalHash(preimage) !== result.resultHash) {
      return formulaError();
    }
    return immutableFinancialCouncilValue({ ...preimage,
      resultHash: result.resultHash });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_formula_input_invalid") {
      throw error;
    }
    return formulaError();
  }
}

/** Requires a live result issued by this module's validated catalog builder. */
export function validateCatalogFinancialFormulaResult(
  raw: unknown
): FinancialFormulaResult {
  if (!raw || typeof raw !== "object"
    || !CATALOG_FORMULA_PROVENANCE.has(raw)) return formulaError();
  return validateFinancialFormulaResult(raw);
}

function validatePolicy(raw: unknown): FinancialFormulaCatalogPolicy {
  const stable = immutableFinancialCouncilInput(raw) as unknown;
  if (!stable || typeof stable !== "object" || Array.isArray(stable)
    || !exactKeys(stable as Record<string, unknown>, [
      "formulaPolicyVersion", "minimumProductMarginBps",
      "minimumCashReserveMinor"
    ])) return formulaError();
  const policy = stable as unknown as FinancialFormulaCatalogPolicy;
  if (policy.formulaPolicyVersion !== "financial-council-formula-policy.v1"
    || !Number.isSafeInteger(policy.minimumProductMarginBps)
    || policy.minimumProductMarginBps < 0
    || policy.minimumProductMarginBps > 10_000
    || !Number.isSafeInteger(policy.minimumCashReserveMinor)
    || policy.minimumCashReserveMinor < 0) return formulaError();
  return Object.freeze(policy);
}

function businessReportEvidence(
  snapshot: FinancialSnapshot
): readonly FinancialCouncilEvidenceRef[] {
  const source = snapshot.sourceRefs.find((ref) =>
    ref.kind === "business_report" && ref.sourceId === "business-report");
  if (!source || source.contentHash !== snapshot.reportInputHash) {
    return formulaError();
  }
  return Object.freeze([Object.freeze({
    source: "business_report" as const,
    sourceId: source.sourceId,
    contentHash: source.contentHash
  })]);
}

function allEvidence(
  snapshot: FinancialSnapshot
): readonly FinancialCouncilEvidenceRef[] {
  return Object.freeze(snapshot.sourceRefs.map((ref) => Object.freeze({
    source: ref.kind,
    sourceId: ref.sourceId,
    contentHash: ref.contentHash
  })));
}

function formulaGap(
  snapshot: FinancialSnapshot,
  formulaId: FinancialFormulaId,
  dataGap: FinancialCouncilDataGap
): FinancialFormulaDataGap {
  return immutableFinancialCouncilValue({
    formulaId,
    formulaVersion: FORMULA_VERSIONS[formulaId],
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    currency: snapshot.currency,
    dataGap
  });
}

function missingBusinessGap(description: string): FinancialCouncilDataGap {
  return Object.freeze({
    code: "import_requires_review" as const,
    source: "business_report" as const,
    sourceId: null,
    description
  });
}

function addResult(
  results: FinancialFormulaResult[],
  snapshot: FinancialSnapshot,
  formulaId: FinancialFormulaId,
  value: unknown,
  unit: FinancialFormulaUnit,
  input: unknown,
  evidenceRefs: readonly FinancialCouncilEvidenceRef[]
): void {
  results.push(createFinancialFormulaResult({
    formulaId,
    formulaVersion: FORMULA_VERSIONS[formulaId],
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    currency: snapshot.currency,
    input,
    value,
    unit,
    evidenceRefs
  }));
}

function canonicalFormulaInputs(
  report: BusinessReportInput
): FinancialSnapshot["formulaInputs"] {
  const normalized = normalizeBusinessReport(report);
  const indicators = analyzeFinancialIndicators(report, normalized);
  const products = [...analyzeProductProfit(report)]
    .sort((left, right) => compare(left.name, right.name));
  const customers = [...analyzeCustomerProfit(report)]
    .sort((left, right) => compare(left.name, right.name));
  const cashflowAnalysis = analyzeCashflow(report, normalized.closingCashMinor);
  const cashflow = report.cashFlow
    ? { status: "computed" as const,
        ...cashflowAnalysis,
        warning: Object.freeze([...cashflowAnalysis.warning].sort(compare)) }
    : { status: "not_computable" as const,
        reason: "cash_flow_missing" as const };
  const costAnalysis = analyzeCost(report);
  const cost = report.costDetail
    ? { status: "computed" as const,
        ...costAnalysis,
        anomaly: Object.freeze([...costAnalysis.anomaly].sort(compare)) }
    : { status: "not_computable" as const,
        reason: "cost_detail_missing" as const };
  const taxAnalysis = analyzeTaxRisk(report);
  const tax = report.taxRisk
    ? { status: "computed" as const,
        ...taxAnalysis,
        findings: Object.freeze(taxAnalysis.findings.map((row) => ({
          category: row.category,
          issue: row.issue.slice(0, 4_000),
          level: row.level
        })).sort((left, right) => compare(left.category, right.category)
          || compare(left.issue, right.issue))) }
    : { status: "not_computable" as const,
        reason: "tax_risk_missing" as const };
  return immutableFinancialCouncilValue({
    indicators, products, customers, cashflow, cost, tax
  });
}

function safeSum(values: readonly number[], field: string): number {
  return safeMinor(values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) return formulaError();
    return sum + BigInt(value);
  }, 0n), field);
}

function overdueBasis(report: BusinessReportInput) {
  const grouped = new Map<string, number[]>();
  for (const row of report.cashFlow?.receivables ?? []) {
    if (row.daysOutstanding <= 90) continue;
    const values = grouped.get(row.customer) ?? [];
    values.push(row.amountMinor);
    grouped.set(row.customer, values);
  }
  const bySubject = [...grouped].map(([subjectRef, values]) => Object.freeze({
    subjectRef,
    amountMinor: safeSum(values, "overdue receivable")
  })).sort((left, right) => compare(left.subjectRef, right.subjectRef));
  return Object.freeze({
    totalMinor: safeSum(bySubject.map((row) => row.amountMinor),
      "overdue receivable total"),
    bySubject: Object.freeze(bySubject)
  });
}

function lossProductBasis(
  products: FinancialSnapshot["formulaInputs"]["products"],
  minimumMarginBps: number
) {
  const grouped = new Map<string, { revenue: bigint; trueProfit: bigint }>();
  for (const row of products) {
    const current = grouped.get(row.name) ?? { revenue: 0n, trueProfit: 0n };
    current.revenue += BigInt(row.revenueMinor);
    current.trueProfit += BigInt(row.trueProfitMinor);
    grouped.set(row.name, current);
  }
  const bySubject = [...grouped].map(([subjectRef, totals]) => {
    const revenueMinor = safeMinor(totals.revenue, "product revenue");
    const currentTrueProfitMinor = safeSignedInteger(
      totals.trueProfit, "product true profit"
    );
    const targetProfitMinor = safeMinor(roundHalfUpDiv(
      BigInt(revenueMinor) * BigInt(minimumMarginBps), 10_000n
    ), "target product profit");
    const gap = BigInt(targetProfitMinor) - BigInt(currentTrueProfitMinor);
    return Object.freeze({
      subjectRef,
      revenueMinor,
      currentTrueProfitMinor,
      targetProfitMinor,
      gapMinor: gap > 0n ? safeMinor(gap, "product profit gap") : 0
    });
  }).filter((row) => row.gapMinor > 0)
    .sort((left, right) => compare(left.subjectRef, right.subjectRef));
  return Object.freeze({
    totalMinor: safeSum(bySubject.map((row) => row.gapMinor),
      "product profit gap total"),
    minimumMarginBps,
    bySubject: Object.freeze(bySubject)
  });
}

/** Builds the deterministic catalog from one validated frozen snapshot. */
export function buildFinancialFormulaCatalog(raw: {
  readonly snapshot: FinancialSnapshot;
  readonly businessReport: BusinessReportInput;
  readonly policy: FinancialFormulaCatalogPolicy;
}): FinancialFormulaCatalog {
  try {
    const snapshot = validateFinancialSnapshot(raw.snapshot);
    const policy = validatePolicy(raw.policy);
    const report = canonicalBusinessReportInput(raw.businessReport);
    if (report.currency !== snapshot.currency
      || financialCouncilCanonicalHash(report) !== snapshot.reportInputHash) {
      return formulaError();
    }
    const recomputed = canonicalFormulaInputs(report);
    if (financialCouncilCanonicalHash(recomputed)
      !== financialCouncilCanonicalHash(snapshot.formulaInputs)) {
      return formulaError();
    }

    const results: FinancialFormulaResult[] = [];
    const dataGaps: FinancialFormulaDataGap[] = [];
    const reportEvidence = businessReportEvidence(snapshot);
    addResult(results, snapshot, "financial_indicators",
      recomputed.indicators, "structured", recomputed.indicators, reportEvidence);

    if (report.incomeStatement.productLines === undefined) {
      const gap = missingBusinessGap("product_lines_missing");
      dataGaps.push(formulaGap(snapshot, "product_true_profit", gap));
      dataGaps.push(formulaGap(snapshot, "loss_product_pricing_gap", gap));
    } else {
      addResult(results, snapshot, "product_true_profit", recomputed.products,
        "structured", report.incomeStatement.productLines, reportEvidence);
      const basis = lossProductBasis(
        recomputed.products, policy.minimumProductMarginBps
      );
      addResult(results, snapshot, "loss_product_pricing_gap", basis,
        "structured", {
          products: recomputed.products,
          minimumProductMarginBps: policy.minimumProductMarginBps,
          formulaPolicyVersion: policy.formulaPolicyVersion
        }, reportEvidence);
    }

    if (report.incomeStatement.customers === undefined) {
      dataGaps.push(formulaGap(snapshot, "customer_true_profit",
        missingBusinessGap("customers_missing")));
    } else {
      addResult(results, snapshot, "customer_true_profit", recomputed.customers,
        "structured", report.incomeStatement.customers, reportEvidence);
    }

    if (recomputed.cashflow.status === "not_computable"
      || !report.cashFlow) {
      const gap = missingBusinessGap("cash_flow_missing");
      for (const formulaId of ["cashflow_forecast",
        "eligible_overdue_receivable", "cash_shortfall"] as const) {
        dataGaps.push(formulaGap(snapshot, formulaId, gap));
      }
    } else {
      addResult(results, snapshot, "cashflow_forecast", recomputed.cashflow,
        "structured", report.cashFlow, reportEvidence);
      if (report.cashFlow.receivables === undefined) {
        dataGaps.push(formulaGap(snapshot, "eligible_overdue_receivable",
          missingBusinessGap("receivable_aging_missing")));
      } else {
        addResult(results, snapshot, "eligible_overdue_receivable",
          overdueBasis(report), "structured", report.cashFlow.receivables,
          reportEvidence);
      }
      const cashShortfall = Object.freeze({
        next30DaysMinor: Math.max(0, policy.minimumCashReserveMinor
          - recomputed.cashflow.projectedClosingCash30DaysMinor),
        next90DaysMinor: Math.max(0, policy.minimumCashReserveMinor
          - recomputed.cashflow.projectedClosingCash90DaysMinor)
      });
      assertSafeNumbers(cashShortfall);
      addResult(results, snapshot, "cash_shortfall", cashShortfall,
        "structured", {
          minimumCashReserveMinor: policy.minimumCashReserveMinor,
          formulaPolicyVersion: policy.formulaPolicyVersion,
          projectedClosingCash30DaysMinor:
            recomputed.cashflow.projectedClosingCash30DaysMinor,
          projectedClosingCash90DaysMinor:
            recomputed.cashflow.projectedClosingCash90DaysMinor
        }, reportEvidence);
    }

    if (recomputed.cost.status === "not_computable" || !report.costDetail) {
      const gap = missingBusinessGap("cost_detail_missing");
      dataGaps.push(formulaGap(snapshot, "cost_analysis", gap));
      dataGaps.push(formulaGap(snapshot, "verified_avoidable_cost", gap));
    } else {
      addResult(results, snapshot, "cost_analysis", recomputed.cost,
        "structured", report.costDetail, reportEvidence);
      const unverified = snapshot.dataGaps.find((gap) =>
        gap.code === "unverified_cost");
      if (unverified) {
        dataGaps.push(formulaGap(snapshot, "verified_avoidable_cost", unverified));
      } else if (recomputed.cost.previousMaterialCostRateBps === null) {
        dataGaps.push(formulaGap(snapshot, "verified_avoidable_cost",
          missingBusinessGap("previous_material_cost_rate_missing")));
      } else {
        const changeBps = recomputed.cost.materialRateChangeBps;
        const basisMinor = changeBps > 500
          ? safeMinor(roundHalfUpDiv(
              BigInt(report.incomeStatement.revenueMinor)
                * BigInt(changeBps),
              10_000n
            ), "avoidable cost basis")
          : 0;
        const basis = Object.freeze({
          basisMinor, materialRateChangeBps: changeBps
        });
        addResult(results, snapshot, "verified_avoidable_cost", basis,
          "structured", {
            revenueMinor: report.incomeStatement.revenueMinor,
            materialRateChangeBps: changeBps,
            costGapRefs: snapshot.dataGaps.filter((gap) =>
              gap.code === "unverified_cost")
          }, reportEvidence);
      }
    }

    if (recomputed.tax.status === "not_computable" || !report.taxRisk) {
      dataGaps.push(formulaGap(snapshot, "tax_risk",
        missingBusinessGap("tax_risk_missing")));
    } else {
      addResult(results, snapshot, "tax_risk", recomputed.tax,
        "structured", report.taxRisk, reportEvidence);
    }

    const uniqueDataGaps = new Map<string, FinancialCouncilDataGap>();
    for (const gap of [
      ...snapshot.dataGaps,
      ...dataGaps.map((formulaDataGap) => formulaDataGap.dataGap)
    ]) {
      uniqueDataGaps.set(financialCouncilCanonicalHash(gap), gap);
    }
    const effectiveDataGaps = [...uniqueDataGaps.values()].sort((left, right) =>
      compare(left.source, right.source)
      || compare(left.sourceId ?? "", right.sourceId ?? "")
      || compare(left.code, right.code)
      || compare(left.description, right.description));
    addResult(results, snapshot, "financial_data_gaps",
      Object.freeze({ count: effectiveDataGaps.length }), "structured",
      { dataGaps: effectiveDataGaps }, allEvidence(snapshot));
    results.sort((left, right) => compare(left.formulaId, right.formulaId));
    dataGaps.sort((left, right) => compare(left.formulaId, right.formulaId));
    const catalog = immutableFinancialCouncilValue({
      formulaResults: results,
      dataGaps
    });
    for (const formulaResult of catalog.formulaResults) {
      CATALOG_FORMULA_PROVENANCE.add(formulaResult);
    }
    return catalog;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_formula_input_invalid") {
      throw error;
    }
    return formulaError();
  }
}
