import {
  canonicalBusinessReportInput,
  normalizeBusinessReport,
  type NormalizedBusinessReport
} from "./business-advisor/domain.js";
import type {
  BusinessAdvisorService,
  BusinessAnalysisResult
} from "./business-advisor/service.js";
import { createBusinessAdvisorService } from "./business-advisor/service.js";
import {
  validateFinancialCouncilAuthoritySnapshot,
  type FinancialCouncilAuthorityReader,
  type FinancialCouncilAuthoritySnapshot
} from "./financial-council-authority-reader.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import { assertGrowthAsOfNotFuture } from "./growth-as-of.js";
import type {
  FinancialCouncilCreateInput,
  FinancialCouncilDataGap
} from "./growth-contract-types.js";
import type { GrowthAdvisorSealedQueryService } from "./growth-advisor-query.js";
import type { CommandContext } from "./growth-command-context.js";

export type FinancialCouncilSourceKind =
  | "acquisition_cost"
  | "business_report"
  | "crm"
  | "financial_fact"
  | "quote"
  | "roi";

export interface FinancialCouncilSourceRef {
  readonly kind: FinancialCouncilSourceKind;
  readonly sourceId: string;
  readonly version: string | number;
  readonly contentHash: `sha256:${string}`;
}

export interface FinancialSnapshot {
  readonly snapshotId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly dataAsOf: string;
  readonly currency: string;
  readonly report: NormalizedBusinessReport;
  readonly reportInputHash: `sha256:${string}`;
  readonly authority: FinancialCouncilAuthoritySnapshot;
  readonly formulaInputs: FinancialCouncilFormulaInputs;
  readonly dataGaps: readonly FinancialCouncilDataGap[];
  readonly sourceRefs: readonly FinancialCouncilSourceRef[];
  readonly snapshotHash: `sha256:${string}`;
}

type ClosedFormulaSection<Computed extends object, Reason extends string> =
  | ({ readonly status: "computed" } & Computed)
  | { readonly status: "not_computable"; readonly reason: Reason };

export interface FinancialCouncilFormulaInputs {
  readonly indicators: BusinessAnalysisResult["indicators"];
  readonly products: BusinessAnalysisResult["products"];
  readonly customers: BusinessAnalysisResult["customers"];
  readonly cashflow: ClosedFormulaSection<
    BusinessAnalysisResult["cashflow"], "cash_flow_missing"
  >;
  readonly cost: ClosedFormulaSection<
    BusinessAnalysisResult["cost"], "cost_detail_missing"
  >;
  readonly tax: ClosedFormulaSection<
    BusinessAnalysisResult["tax"], "tax_risk_missing"
  >;
}

export interface FinancialSnapshotBuilderDependencies {
  readonly cutoffIssuer: Pick<GrowthAdvisorSealedQueryService, "sealTodayCutoff">;
  readonly authority: Pick<FinancialCouncilAuthorityReader, "readAt">;
  readonly businessAdvisor: Pick<BusinessAdvisorService, "analyze">;
  readonly now?: () => string;
}

function snapshotError(code = "financial_council_input_invalid"): never {
  throw financialCouncilError(code);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactCreateInput(value: unknown): FinancialCouncilCreateInput {
  const immutable = immutableFinancialCouncilInput(value) as unknown;
  if (!immutable || typeof immutable !== "object"
    || Object.getPrototypeOf(immutable) !== Object.prototype) {
    return snapshotError();
  }
  const record = immutable as Record<string, unknown>;
  const keys = Object.keys(record).sort(compare);
  if (keys.join("\u0000") !== [
    "businessReport", "currency", "dataAsOf", "policyVersionId"
  ].sort(compare).join("\u0000")
    || typeof record.currency !== "string"
    || typeof record.dataAsOf !== "string"
    || typeof record.policyVersionId !== "string"
    || record.policyVersionId.trim() === ""
    || [...record.policyVersionId].length > 255) {
    return snapshotError();
  }
  const businessReport = canonicalBusinessReportInput(
    record.businessReport as FinancialCouncilCreateInput["businessReport"]
  );
  if (record.currency !== businessReport.currency) return snapshotError();
  return Object.freeze({
    currency: record.currency as FinancialCouncilCreateInput["currency"],
    dataAsOf: record.dataAsOf,
    businessReport,
    policyVersionId: record.policyVersionId
  });
}

function projectFormulaInputs(
  result: BusinessAnalysisResult,
  report: FinancialCouncilCreateInput["businessReport"]
): FinancialCouncilFormulaInputs {
  const indicators = Object.freeze({
    grossMarginBps: result.indicators.grossMarginBps,
    netMarginBps: result.indicators.netMarginBps,
    roeBps: result.indicators.roeBps,
    roaBps: result.indicators.roaBps,
    debtRatioBps: result.indicators.debtRatioBps,
    currentRatioBps: result.indicators.currentRatioBps,
    quickRatioBps: result.indicators.quickRatioBps,
    receivableTurnover: result.indicators.receivableTurnover,
    inventoryTurnover: result.indicators.inventoryTurnover,
    interestCoverage: result.indicators.interestCoverage,
    receivableDays: result.indicators.receivableDays,
    cashCoverageMonths: result.indicators.cashCoverageMonths,
    cashCollectionRatioBps: result.indicators.cashCollectionRatioBps,
    cashProfitRatioBps: result.indicators.cashProfitRatioBps,
    revenueMinor: result.indicators.revenueMinor,
    netProfitMinor: result.indicators.netProfitMinor
  });
  const products = result.products.map((row) => Object.freeze({
    name: row.name,
    revenueMinor: row.revenueMinor,
    grossMarginBps: row.grossMarginBps,
    trueProfitMinor: row.trueProfitMinor,
    trueMarginBps: row.trueMarginBps,
    isFakeProfit: row.isFakeProfit
  })).sort((left, right) => compare(left.name, right.name));
  const customers = result.customers.map((row) => Object.freeze({
    name: row.name,
    revenueMinor: row.revenueMinor,
    trueProfitMinor: row.trueProfitMinor,
    trueMarginBps: row.trueMarginBps,
    paymentDays: row.paymentDays,
    grade: row.grade
  })).sort((left, right) => compare(left.name, right.name));
  const cashflow = report.cashFlow ? Object.freeze({
    status: "computed" as const,
    next30DaysNetMinor: result.cashflow.next30DaysNetMinor,
    next90DaysNetMinor: result.cashflow.next90DaysNetMinor,
    projectedClosingCash30DaysMinor:
      result.cashflow.projectedClosingCash30DaysMinor,
    projectedClosingCash90DaysMinor:
      result.cashflow.projectedClosingCash90DaysMinor,
    warning: Object.freeze([...result.cashflow.warning].sort(compare))
  }) : Object.freeze({
    status: "not_computable" as const,
    reason: "cash_flow_missing" as const
  });
  const cost = report.costDetail ? Object.freeze({
    status: "computed" as const,
    materialCostRateBps: result.cost.materialCostRateBps,
    previousMaterialCostRateBps: result.cost.previousMaterialCostRateBps,
    materialRateChangeBps: result.cost.materialRateChangeBps,
    anomaly: Object.freeze([...result.cost.anomaly].sort(compare)),
    laborShareBps: result.cost.laborShareBps,
    variableShareBps: result.cost.variableShareBps,
    fixedShareBps: result.cost.fixedShareBps
  }) : Object.freeze({
    status: "not_computable" as const,
    reason: "cost_detail_missing" as const
  });
  const tax = report.taxRisk ? Object.freeze({
    status: "computed" as const,
    redCount: result.tax.redCount,
    yellowCount: result.tax.yellowCount,
    greenCount: result.tax.greenCount,
    level: result.tax.level,
    findings: Object.freeze(result.tax.findings.map((row) => Object.freeze({
      category: row.category,
      issue: row.issue.slice(0, 4_000),
      level: row.level
    })).sort((left, right) => compare(left.category, right.category)
      || compare(left.issue, right.issue)))
  }) : Object.freeze({
    status: "not_computable" as const,
    reason: "tax_risk_missing" as const
  });
  return immutableFinancialCouncilValue({
    indicators, products, customers, cashflow, cost, tax
  });
}

function gapSource(
  sourceType: FinancialCouncilAuthoritySnapshot["dataGaps"][number]["sourceType"]
): FinancialCouncilDataGap["source"] {
  if (sourceType === "cost_entry") return "acquisition_cost";
  if (sourceType === "commercial_binding") return "quote";
  return "financial_fact";
}

function snapshotGaps(
  report: FinancialCouncilCreateInput["businessReport"],
  authority: FinancialCouncilAuthoritySnapshot
): readonly FinancialCouncilDataGap[] {
  const gaps: FinancialCouncilDataGap[] = authority.dataGaps.map((gap) => ({
    code: gap.code,
    source: gapSource(gap.sourceType),
    sourceId: gap.sourceId,
    description: `authority:${gap.code}`
  }));
  if (!report.cashFlow) {
    gaps.push({
      code: "import_requires_review",
      source: "business_report",
      sourceId: null,
      description: "cash_flow_missing"
    });
  }
  if (authority.expectedRoi.length === 0) {
    gaps.push({
      code: "import_requires_review", source: "roi", sourceId: null,
      description: "expected_roi_missing"
    });
  } else {
    for (const row of authority.expectedRoi) {
      if (row.status === "not_computable") {
        gaps.push({
          code: "import_requires_review", source: "roi",
          sourceId: `expected:${row.cohortId}:${row.planId ?? "all"}:${row.currency}`,
          description: `expected_roi_not_computable:${row.reason}`
        });
      }
    }
  }
  if (authority.actualRoi.length === 0) {
    gaps.push({
      code: "import_requires_review", source: "roi", sourceId: null,
      description: "actual_roi_missing"
    });
  } else {
    for (const row of authority.actualRoi) {
      if (row.status === "not_computable") {
        gaps.push({
          code: "import_requires_review", source: "roi",
          sourceId: `actual:${row.cohortId}:${row.planId ?? "all"}:${row.currency}`,
          description: `actual_roi_not_computable:${row.reason}`
        });
      }
    }
  }
  return immutableFinancialCouncilValue(gaps.sort((left, right) =>
    compare(left.source, right.source)
    || compare(left.sourceId ?? "", right.sourceId ?? "")
    || compare(left.code, right.code)
    || compare(left.description, right.description)));
}

function sourceRefs(
  reportInputHash: `sha256:${string}`,
  authority: FinancialCouncilAuthoritySnapshot
): readonly FinancialCouncilSourceRef[] {
  const refs: FinancialCouncilSourceRef[] = [{
    kind: "business_report", sourceId: "business-report", version: 1,
    contentHash: reportInputHash
  }, {
    kind: "crm", sourceId: "growth-advisor-today", version: 1,
    contentHash: authority.sourceSnapshotHash
  }];
  for (const row of authority.priorityCustomers) refs.push({
    kind: "crm", sourceId: row.candidateId,
    version: row.qualificationDecisionVersion,
    contentHash: row.inputSnapshotHash
  });
  for (const row of authority.pendingQuoteApprovals) refs.push({
    kind: "quote", sourceId: row.quoteVersionId,
    version: row.quoteVersionRevision,
    contentHash: financialCouncilCanonicalHash(row)
  });
  for (const row of authority.verifiedFinancialFacts) refs.push({
    kind: "financial_fact", sourceId: row.entryId,
    version: row.sourceVersion, contentHash: row.snapshotHash
  });
  for (const [kind, rows] of [
    ["expected", authority.expectedRoi],
    ["actual", authority.actualRoi]
  ] as const) {
    for (const row of rows) refs.push({
      kind: "roi",
      sourceId: `${kind}:${row.cohortId}:${row.planId ?? "all"}:${row.currency}`,
      version: row.formulaVersion,
      contentHash: financialCouncilCanonicalHash(row)
    });
  }
  for (const gap of authority.dataGaps) refs.push({
    kind: gapSource(gap.sourceType), sourceId: gap.sourceId,
    version: 1, contentHash: gap.sourceSnapshotHash
  });
  refs.sort((left, right) => compare(left.kind, right.kind)
    || compare(left.sourceId, right.sourceId));
  const unique: FinancialCouncilSourceRef[] = [];
  for (const ref of refs) {
    const previous = unique.at(-1);
    if (previous?.kind === ref.kind && previous.sourceId === ref.sourceId) {
      return snapshotError();
    }
    unique.push(Object.freeze({ ...ref }));
  }
  return Object.freeze(unique);
}

function exactSnapshotObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) snapshotError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => typeof key === "string"
      && !required.includes(key) && !optional.includes(key))) snapshotError();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) snapshotError();
  }
}

function snapshotString(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string") snapshotError();
}

const SNAPSHOT_HASH = /^sha256:[0-9a-f]{64}$/u;
const SNAPSHOT_SOURCE_KINDS = new Set<FinancialCouncilSourceKind>([
  "acquisition_cost", "business_report", "crm", "financial_fact", "quote",
  "roi"
]);
const SNAPSHOT_GAP_CODES = new Set<FinancialCouncilDataGap["code"]>([
  "unverified_cost", "unverified_financial_fact", "missing_cogs",
  "unmatched_payment", "missing_commercial_binding", "import_requires_review"
]);
const SNAPSHOT_GAP_SOURCES = new Set<FinancialCouncilDataGap["source"]>([
  "crm", "quote", "financial_fact", "acquisition_cost", "roi",
  "business_report"
]);

function snapshotNonemptyString(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) snapshotError();
}

function assertSnapshotHash(value: unknown): void {
  if (typeof value !== "string" || !SNAPSHOT_HASH.test(value)) snapshotError();
}

function snapshotInteger(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value)) snapshotError();
}

function snapshotNumber(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER) snapshotError();
}

function snapshotStringArray(value: unknown): void {
  if (!Array.isArray(value)) snapshotError();
  for (const item of value) snapshotString(item);
}

function snapshotRows(
  value: unknown,
  validate: (row: unknown) => void
): void {
  if (!Array.isArray(value)) snapshotError();
  for (const row of value) validate(row);
}

function validateFormulaInputs(value: unknown): void {
  exactSnapshotObject(value, ["indicators", "products", "customers",
    "cashflow", "cost", "tax"]);
  exactSnapshotObject(value.indicators, ["grossMarginBps", "netMarginBps",
    "roeBps", "roaBps", "debtRatioBps", "currentRatioBps", "quickRatioBps",
    "receivableTurnover", "inventoryTurnover", "interestCoverage",
    "receivableDays", "cashCoverageMonths", "cashCollectionRatioBps",
    "cashProfitRatioBps", "revenueMinor", "netProfitMinor"]);
  for (const item of Object.values(value.indicators)) snapshotNumber(item);
  snapshotRows(value.products, (row) => {
    exactSnapshotObject(row, ["name", "revenueMinor", "grossMarginBps",
      "trueProfitMinor", "trueMarginBps", "isFakeProfit"]);
    snapshotString(row.name);
    for (const key of ["revenueMinor", "grossMarginBps", "trueProfitMinor",
      "trueMarginBps"] as const) snapshotInteger(row[key]);
    if (typeof row.isFakeProfit !== "boolean") snapshotError();
  });
  snapshotRows(value.customers, (row) => {
    exactSnapshotObject(row, ["name", "revenueMinor", "trueProfitMinor",
      "trueMarginBps", "paymentDays", "grade"]);
    snapshotString(row.name);
    for (const key of ["revenueMinor", "trueProfitMinor", "trueMarginBps",
      "paymentDays"] as const) snapshotInteger(row[key]);
    if (row.grade !== "A" && row.grade !== "B" && row.grade !== "C") snapshotError();
  });
  if (!value.cashflow || typeof value.cashflow !== "object") snapshotError();
  if ((value.cashflow as Record<string, unknown>).status === "computed") {
    exactSnapshotObject(value.cashflow, ["status", "next30DaysNetMinor",
      "next90DaysNetMinor", "projectedClosingCash30DaysMinor",
      "projectedClosingCash90DaysMinor", "warning"]);
    for (const key of ["next30DaysNetMinor", "next90DaysNetMinor",
      "projectedClosingCash30DaysMinor", "projectedClosingCash90DaysMinor"] as const) {
      snapshotInteger(value.cashflow[key]);
    }
    snapshotStringArray(value.cashflow.warning);
  } else {
    exactSnapshotObject(value.cashflow, ["status", "reason"]);
    if (value.cashflow.status !== "not_computable"
      || value.cashflow.reason !== "cash_flow_missing") snapshotError();
  }
  if (!value.cost || typeof value.cost !== "object") snapshotError();
  if ((value.cost as Record<string, unknown>).status === "computed") {
    exactSnapshotObject(value.cost, ["status", "materialCostRateBps",
      "previousMaterialCostRateBps", "materialRateChangeBps", "anomaly",
      "laborShareBps", "variableShareBps", "fixedShareBps"]);
    for (const key of ["materialCostRateBps", "materialRateChangeBps",
      "laborShareBps", "variableShareBps", "fixedShareBps"] as const) {
      snapshotInteger(value.cost[key]);
    }
    snapshotInteger(value.cost.previousMaterialCostRateBps, true);
    snapshotStringArray(value.cost.anomaly);
  } else {
    exactSnapshotObject(value.cost, ["status", "reason"]);
    if (value.cost.status !== "not_computable"
      || value.cost.reason !== "cost_detail_missing") snapshotError();
  }
  if (!value.tax || typeof value.tax !== "object") snapshotError();
  if ((value.tax as Record<string, unknown>).status === "computed") {
    exactSnapshotObject(value.tax, ["status", "redCount", "yellowCount",
      "greenCount", "level", "findings"]);
    for (const key of ["redCount", "yellowCount", "greenCount"] as const) {
      snapshotInteger(value.tax[key]);
    }
    if (value.tax.level !== "red" && value.tax.level !== "yellow"
      && value.tax.level !== "green") snapshotError();
    snapshotRows(value.tax.findings, (row) => {
      exactSnapshotObject(row, ["category", "issue", "level"]);
      snapshotString(row.category);
      snapshotString(row.issue);
      if (row.level !== "red" && row.level !== "yellow" && row.level !== "green") {
        snapshotError();
      }
    });
  } else {
    exactSnapshotObject(value.tax, ["status", "reason"]);
    if (value.tax.status !== "not_computable"
      || value.tax.reason !== "tax_risk_missing") snapshotError();
  }
}

/** Validates and closes a persisted snapshot before its hash is trusted. */
export function validateFinancialSnapshot(value: unknown): FinancialSnapshot {
  const stable = immutableFinancialCouncilInput(value) as unknown;
  exactSnapshotObject(stable, ["snapshotId", "runId", "workspaceId",
    "dataAsOf", "currency", "report", "reportInputHash", "authority",
    "formulaInputs", "dataGaps", "sourceRefs", "snapshotHash"]);
  for (const key of ["snapshotId", "runId", "workspaceId", "dataAsOf",
  ] as const) snapshotNonemptyString(stable[key]);
  assertSnapshotHash(stable.reportInputHash);
  assertSnapshotHash(stable.snapshotHash);
  if (stable.currency !== "CNY" && stable.currency !== "USD") snapshotError();
  exactSnapshotObject(stable.report, ["currency", "companyName", "period",
    "totalAssetsMinor", "totalLiabilitiesMinor", "equityMinor",
    "grossProfitMinor", "netProfitMinor", "closingCashMinor"]);
  if (stable.report.currency !== stable.currency) snapshotError();
  snapshotString(stable.report.companyName);
  snapshotString(stable.report.period);
  for (const key of ["totalAssetsMinor", "totalLiabilitiesMinor", "equityMinor",
    "grossProfitMinor", "netProfitMinor", "closingCashMinor"] as const) {
    snapshotInteger(stable.report[key]);
  }
  let authority: FinancialCouncilAuthoritySnapshot;
  try {
    authority = validateFinancialCouncilAuthoritySnapshot(stable.authority);
  } catch {
    return snapshotError();
  }
  if (authority.workspaceId !== stable.workspaceId
    || authority.currency !== stable.currency
    || authority.dataAsOf !== stable.dataAsOf) snapshotError();
  validateFormulaInputs(stable.formulaInputs);
  snapshotRows(stable.dataGaps, (row) => {
    exactSnapshotObject(row, ["code", "source", "sourceId", "description"]);
    if (!SNAPSHOT_GAP_CODES.has(row.code as FinancialCouncilDataGap["code"])
      || !SNAPSHOT_GAP_SOURCES.has(
        row.source as FinancialCouncilDataGap["source"]
      )) snapshotError();
    snapshotNonemptyString(row.sourceId, true);
    snapshotNonemptyString(row.description);
  });
  const persistedGaps = stable.dataGaps as unknown as FinancialCouncilDataGap[];
  for (let index = 1; index < persistedGaps.length; index += 1) {
    const left = persistedGaps[index - 1]!;
    const right = persistedGaps[index]!;
    const order = compare(left.source, right.source)
      || compare(left.sourceId ?? "", right.sourceId ?? "")
      || compare(left.code, right.code)
      || compare(left.description, right.description);
    if (order >= 0) snapshotError();
  }
  snapshotRows(stable.sourceRefs, (row) => {
    exactSnapshotObject(row, ["kind", "sourceId", "version", "contentHash"]);
    if (!SNAPSHOT_SOURCE_KINDS.has(row.kind as FinancialCouncilSourceKind)) {
      snapshotError();
    }
    snapshotNonemptyString(row.sourceId);
    if ((typeof row.version !== "string" || row.version.length === 0)
      && (!Number.isSafeInteger(row.version) || Number(row.version) < 1)) {
      snapshotError();
    }
    assertSnapshotHash(row.contentHash);
  });
  const expectedRefs = sourceRefs(
    stable.reportInputHash as `sha256:${string}`, authority
  );
  if (financialCouncilCanonicalHash(stable.sourceRefs)
    !== financialCouncilCanonicalHash(expectedRefs)) snapshotError();
  const { snapshotHash, ...preimage } = stable;
  if (financialCouncilCanonicalHash(preimage) !== snapshotHash) snapshotError();
  return immutableFinancialCouncilValue(stable as unknown as FinancialSnapshot);
}

const SNAPSHOT_PROVENANCE_ADVISOR = createBusinessAdvisorService();

/** Rebuilds every deterministic snapshot field from its owning run. */
export function validateFinancialSnapshotForRun(
  value: unknown,
  run: Pick<FinancialCouncilRun, "runId" | "workspaceId" | "dataAsOf"
    | "currency" | "businessReport" | "snapshotId" | "snapshotHash">
): FinancialSnapshot {
  const snapshot = validateFinancialSnapshot(value);
  let businessReport: FinancialCouncilCreateInput["businessReport"];
  try {
    businessReport = canonicalBusinessReportInput(run.businessReport);
  } catch {
    return snapshotError();
  }
  const reportInputHash = financialCouncilCanonicalHash(businessReport);
  const report = immutableFinancialCouncilValue(
    normalizeBusinessReport(businessReport)
  );
  const formulaInputs = projectFormulaInputs(
    SNAPSHOT_PROVENANCE_ADVISOR.analyze(businessReport), businessReport
  );
  const dataGaps = snapshotGaps(businessReport, snapshot.authority);
  const refs = sourceRefs(reportInputHash, snapshot.authority);
  const identity = {
    runId: run.runId,
    workspaceId: run.workspaceId,
    dataAsOf: run.dataAsOf,
    currency: run.currency,
    report,
    reportInputHash,
    authority: snapshot.authority,
    formulaInputs,
    dataGaps,
    sourceRefs: refs
  };
  const snapshotId = financialCouncilCanonicalHash(identity);
  const preimage = { snapshotId, ...identity };
  const expected = { ...preimage,
    snapshotHash: financialCouncilCanonicalHash(preimage) };
  if (financialCouncilCanonicalHash(snapshot)
      !== financialCouncilCanonicalHash(expected)
    || (run.snapshotId !== null && run.snapshotId !== expected.snapshotId)
    || (run.snapshotHash !== null && run.snapshotHash !== expected.snapshotHash)) {
    return snapshotError();
  }
  return snapshot;
}

export class FinancialSnapshotBuilder {
  private readonly now: () => string;

  constructor(
    private readonly dependencies: FinancialSnapshotBuilderDependencies
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async freeze(
    command: CommandContext,
    runId: string,
    rawInput: FinancialCouncilCreateInput
  ): Promise<FinancialSnapshot> {
    const input = exactCreateInput(rawInput);
    const workspaceId = command?.workspace?.workspaceId?.trim();
    if (!workspaceId || workspaceId === "all"
      || typeof runId !== "string" || !runId.trim()
      || runId.trim() !== runId || runId.length > 255) return snapshotError();
    const effectiveAsOf = assertGrowthAsOfNotFuture(
      input.dataAsOf, this.now(), 1_000
    );
    const reportInputHash = financialCouncilCanonicalHash(
      input.businessReport
    );
    const report = immutableFinancialCouncilValue(
      normalizeBusinessReport(input.businessReport)
    );
    const formulaInputs = projectFormulaInputs(
      this.dependencies.businessAdvisor.analyze(input.businessReport),
      input.businessReport
    );
    const cutoff = await this.dependencies.cutoffIssuer.sealTodayCutoff(
      command.workspace, effectiveAsOf
    );
    const authority = validateFinancialCouncilAuthoritySnapshot(
      await this.dependencies.authority.readAt(
        command.workspace, { currency: input.currency, cutoff }
      )
    );
    if (authority.workspaceId !== workspaceId
      || authority.currency !== input.currency
      || authority.dataAsOf !== cutoff.effectiveAsOf) {
      return snapshotError("financial_council_authority_workspace_mismatch");
    }
    const dataGaps = snapshotGaps(input.businessReport, authority);
    const refs = sourceRefs(reportInputHash, authority);
    const identity = {
      runId,
      workspaceId,
      dataAsOf: cutoff.effectiveAsOf,
      currency: input.currency,
      report,
      reportInputHash,
      authority,
      formulaInputs,
      dataGaps,
      sourceRefs: refs
    };
    const snapshotId = financialCouncilCanonicalHash(identity);
    const preimage = {
      snapshotId, ...identity
    };
    const snapshotHash = financialCouncilCanonicalHash(preimage);
    return immutableFinancialCouncilValue({
      ...preimage,
      snapshotHash
    });
  }
}
