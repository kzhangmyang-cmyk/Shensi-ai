import assert from "node:assert/strict";
import type {
  FinancialStatementPackageRepository
} from "./financial-statement-package-repository.js";
import {
  financialCouncilCanonicalHash
} from "./financial-council-domain.js";
import type {
  FinancialStatementPackagePreview
} from "./financial-statement-package.js";

const HASH = `sha256:${"1".repeat(64)}` as const;

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
  const consent = Object.freeze({ accepted: true as const,
    noticeVersion: "financial-model-data.v1" as const,
    acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z" });
  const committed = await repository.commitPreview({ workspaceId: "workspace-a",
    previewId: preview.previewId, packageId: "package-1", consent,
    idempotencyKeyHash: HASH, requestHash: HASH,
    createdAt: "2026-08-23T12:11:00.000Z" });
  assert.equal(committed.replayed, false);
  assert.equal(committed.value.status, "verified");
  assert.equal(JSON.stringify(committed.value).includes("contentBase64"), false);
  assert.equal(JSON.stringify(committed.value).includes("raw"), false);
  const replay = await repository.commitPreview({ workspaceId: "workspace-a",
    previewId: preview.previewId, packageId: "package-1", consent,
    idempotencyKeyHash: HASH, requestHash: HASH,
    createdAt: "2026-08-23T12:11:00.000Z" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, committed.value);
  await assert.rejects(repository.commitPreview({ workspaceId: "workspace-a",
    previewId: preview.previewId, packageId: "package-1", consent,
    idempotencyKeyHash: HASH,
    requestHash: `sha256:${"2".repeat(64)}`,
    createdAt: "2026-08-23T12:11:00.000Z" }),
  (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_idempotency_conflict");
  assert.equal(await repository.getVerified("workspace-b", "package-1"), null);
}
