import assert from "node:assert/strict";
import type {
  FinancialStatementPackageRepository
} from "./financial-statement-package-repository.js";
import {
  financialCouncilCanonicalHash
} from "./financial-council-domain.js";
import {
  canonicalFinancialCashForecastSupplement,
  financialStatementPackageHash,
  type FinancialCashForecastSupplement,
  type FinancialStatementPackage,
  type FinancialStatementPackagePreview
} from "./financial-statement-package.js";

const HASH = `sha256:${"1".repeat(64)}` as const;
const CHANGED_HASH = `sha256:${"2".repeat(64)}` as const;

export function forecastRecordFixture(): FinancialCashForecastSupplement {
  return canonicalFinancialCashForecastSupplement({
    forecastAsOf: "2026-08-23T12:10:00.000Z",
    expectedInflowsNext30DaysMinor: 100_000,
    expectedOutflowsNext30DaysMinor: 500_000,
    expectedInflowsNext31To90DaysMinor: 800_000,
    expectedOutflowsNext31To90DaysMinor: 300_000,
    receivables: [
      { customer: "客户 B", amountMinor: 300_000, daysOutstanding: 30 },
      { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 }
    ],
    attestation: { accepted: true,
      noticeVersion: "financial-cash-forecast.v1" }
  }, { currency: "CNY", acceptedBy: "actor-a",
    acceptedAt: "2026-08-23T12:11:00.000Z", period: "2026-08-23" });
}

export function commitFixture(overrides: Partial<{
  readonly packageId: string;
  readonly idempotencyKeyHash: `sha256:${string}`;
  readonly requestHash: `sha256:${string}`;
  readonly cashForecast: FinancialCashForecastSupplement | null;
}> = {}) {
  return {
    workspaceId: "workspace-a", previewId: "preview-1",
    packageId: overrides.packageId ?? "package-1",
    consent: { accepted: true as const,
      noticeVersion: "financial-model-data.v1" as const,
      acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z" },
    cashForecast: overrides.cashForecast ?? null,
    idempotencyKeyHash: overrides.idempotencyKeyHash ?? HASH,
    requestHash: overrides.requestHash ?? HASH,
    createdAt: "2026-08-23T12:11:00.000Z"
  };
}

export function previewFixture(): FinancialStatementPackagePreview {
  const businessReport = Object.freeze({
    currency: "CNY" as const,
    companyName: "示例公司",
    period: "2026-Q2",
    balanceSheet: Object.freeze({ period: "2026-Q2", cashMinor: 1_075_000,
      receivablesMinor: 200_000, inventoryMinor: 100_000,
      otherCurrentAssetsMinor: 100_000, nonCurrentAssetsMinor: 525_000,
      currentLiabilitiesMinor: 300_000, nonCurrentLiabilitiesMinor: 100_000,
      accountsPayableMinor: 100_000 }),
    incomeStatement: Object.freeze({ period: "2026-Q2",
      revenueMinor: 1_000_000, costOfGoodsSoldMinor: 600_000,
      operatingExpensesMinor: 150_000, interestExpenseMinor: 10_000,
      taxExpenseMinor: 40_000 }),
    cashFlow: Object.freeze({ period: "2026-Q2", openingCashMinor: 1_000_000,
      operatingInflowMinor: 500_000, operatingOutflowMinor: 410_000,
      investingNetMinor: -20_000, financingNetMinor: 5_000,
      forecast: Object.freeze({ status: "not_computable" as const,
        reason: "source_statements_do_not_provide_forecast" as const }) })
  });
  const source = (kind: "balance_sheet" | "income_statement"
    | "cash_flow_statement", index: number) => Object.freeze({ kind,
      fileName: `${kind}.xlsx`, fileHash: (`sha256:${String(index).repeat(64)}` as `sha256:${string}`),
      mediaType: ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const),
      sheetNames: Object.freeze(["Sheet1"]) });
  const value = {
    previewId: "preview-1", workspaceId: "workspace-a", status: "preview" as const,
    expiresAt: "2026-08-23T13:10:00.000Z", companyName: "示例公司",
    currency: "CNY" as const, period: "2026-Q2",
    sourceFiles: (Object.freeze([source("balance_sheet", 1),
      source("income_statement", 2), source("cash_flow_statement", 3)]) as FinancialStatementPackagePreview["sourceFiles"]),
    parserVersion: "financial-statements.v2" as const, businessReport,
    reportInputHash: financialCouncilCanonicalHash(businessReport),
    warnings: Object.freeze([]), createdAt: "2026-08-23T12:10:00.000Z"
  };
  return Object.freeze({ ...value,
    previewHash: financialCouncilCanonicalHash(value) });
}

export async function runFinancialStatementPackageRepositoryContract(
  create: () => Promise<FinancialStatementPackageRepository>
): Promise<void> {
  const repository = await create();
  const preview = previewFixture();
  await repository.appendPreview(preview);
  assert.equal(await repository.getVerified("workspace-a", "package-1"), null,
    "preview must not create a verified package");
  const committed = await repository.commitPreview(commitFixture());
  assert.equal(committed.replayed, false);
  assert.equal(committed.value.status, "verified");
  assert.equal(committed.value.forecastStatus, "not_computable");
  assert.equal(committed.value.cashForecast, null);
  assert.equal(JSON.stringify(committed.value).includes("contentBase64"), false);
  assert.equal(JSON.stringify(committed.value).includes("raw"), false);
  const replay = await repository.commitPreview(commitFixture());
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, committed.value);
  await assert.rejects(repository.commitPreview(commitFixture({
    requestHash: CHANGED_HASH })),
  (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_idempotency_conflict");
  assert.equal(await repository.getVerified("workspace-b", "package-1"), null);
  assert.equal((await repository.getLatestVerified("workspace-a",
    Object.freeze({ limit: 1 })))?.packageId, "package-1");
  assert.equal(await repository.getLatestVerified("workspace-b",
    Object.freeze({ limit: 1 })), null);
  for (const invalid of [{}, { limit: 2 }, { limit: 1, workspaceId: "workspace-b" }]) {
    await assert.rejects(repository.getLatestVerified("workspace-a",
      invalid as never), (error: unknown) => (error as { code?: string }).code
        === "financial_statement_input_invalid");
  }

  const forecastRepository = await create();
  await forecastRepository.appendPreview(previewFixture());
  const forecast = forecastRecordFixture();
  const first = await forecastRepository.commitPreview(commitFixture({
    packageId: "package-forecast", cashForecast: forecast
  }));
  const forecastReplay = await forecastRepository.commitPreview(commitFixture({
    packageId: "package-forecast", cashForecast: forecast
  }));
  assert.equal(first.value.forecastStatus, "computed");
  assert.equal(first.value.cashForecast?.acceptedBy, "actor-a");
  assert.equal(first.value.businessReport.cashFlow?.forecast, undefined);
  assert.equal(forecastReplay.replayed, true);
  assert.equal(forecastReplay.value.packageHash, first.value.packageHash);
  await assert.rejects(forecastRepository.commitPreview(commitFixture({
    packageId: "package-forecast", requestHash: CHANGED_HASH,
    cashForecast: canonicalFinancialCashForecastSupplement({
      forecastAsOf: "2026-08-23T12:10:00.000Z",
      expectedInflowsNext30DaysMinor: 100_001,
      expectedOutflowsNext30DaysMinor: 500_000,
      expectedInflowsNext31To90DaysMinor: 800_000,
      expectedOutflowsNext31To90DaysMinor: 300_000,
      receivables: [], attestation: { accepted: true,
        noticeVersion: "financial-cash-forecast.v1" }
    }, { currency: "CNY", acceptedBy: "actor-a",
      acceptedAt: "2026-08-23T12:11:00.000Z", period: "2026-08-23" })
  })), (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_idempotency_conflict");
}

function resignForecast(value: FinancialCashForecastSupplement) {
  const { forecastHash: _forecastHash, ...preimage } = value;
  return { ...preimage, forecastHash: financialCouncilCanonicalHash(preimage) };
}

function resignPackage(value: FinancialStatementPackage): FinancialStatementPackage {
  const { packageHash: _packageHash, ...preimage } = value;
  return { ...preimage,
    packageHash: financialStatementPackageHash(preimage) };
}

export async function runFinancialStatementPackageTamperContract(
  create: () => Promise<{
    readonly repository: FinancialStatementPackageRepository;
    tamper(value: FinancialStatementPackage): Promise<void> | void;
  }>
): Promise<void> {
  const cases: readonly {
    readonly name: string;
    mutate(value: FinancialStatementPackage): FinancialStatementPackage;
  }[] = [
    { name: "changed forecast hash", mutate: (value) => resignPackage({
      ...value, cashForecast: { ...value.cashForecast!,
        forecastHash: CHANGED_HASH }
    }) },
    { name: "changed forecast amount with a re-signed package", mutate: (value) =>
      resignPackage({ ...value, cashForecast: { ...value.cashForecast!,
        expectedInflowsNext30DaysMinor: 100_001 } }) },
    { name: "changed accepted authority", mutate: (value) => {
      const cashForecast = resignForecast({ ...value.cashForecast!,
        acceptedBy: "attacker" }) as FinancialCashForecastSupplement;
      return resignPackage({ ...value, cashForecast });
    } },
    { name: "duplicate forecast receivable", mutate: (value) => {
      const duplicate = structuredClone(value.cashForecast!.receivables[0]!);
      const receivables = [...value.cashForecast!.receivables, duplicate];
      const cashForecast = resignForecast({ ...value.cashForecast!, receivables }) as
        FinancialCashForecastSupplement;
      const businessReport = structuredClone(value.businessReport);
      businessReport.cashFlow!.receivables = receivables;
      const reportInputHash = financialCouncilCanonicalHash(businessReport);
      return resignPackage({ ...value, cashForecast, businessReport,
        reportInputHash });
    } },
    { name: "mismatched report input hash", mutate: (value) => resignPackage({
      ...value, reportInputHash: CHANGED_HASH
    }) }
  ];
  for (const testCase of cases) {
    const harness = await create();
    await harness.repository.appendPreview(previewFixture());
    const committed = await harness.repository.commitPreview(commitFixture({
      packageId: "package-forecast", cashForecast: forecastRecordFixture()
    }));
    await harness.tamper(testCase.mutate(structuredClone(committed.value)));
    await assert.rejects(
      harness.repository.getVerified("workspace-a", "package-forecast"),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        return code === "financial_statement_package_tampered"
          || code === "financial_statement_package_integrity";
      }, testCase.name
    );
  }
}
