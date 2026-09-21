// Shared synthetic three-statement package; never imported into a user workspace.
// CNY minor units: income 10000 - 6000 - 1000 - 100 - 400 = 2500 yuan;
// operating cash 4000 - 5000 = -1000; opening 10000 -> closing 9000 yuan.
export function financialSkillFixture() {
  return { packageId: 'package-example', companyName: '示例公司', period: '2026-Q2', currency: 'CNY',
    provenance: { parserVersion: 'financial-statements.v2', packageHash: `sha256:${'a'.repeat(64)}`,
      createdAt: '2026-07-01T00:00:00Z', unit: 'minor',
      sourceFiles: [{ kind: 'balance_sheet', fileHash: 'balance-hash' },
        { kind: 'income_statement', fileHash: 'income-hash' }, { kind: 'cash_flow', fileHash: 'cash-hash' }], warnings: [] },
    businessReport: { companyName: '示例公司', period: '2026-Q2', currency: 'CNY',
      balanceSheet: { period: '2026-Q2', cashMinor: 900000, receivablesMinor: 200000,
        inventoryMinor: 100000, otherCurrentAssetsMinor: 0, nonCurrentAssetsMinor: 800000,
        currentLiabilitiesMinor: 300000, nonCurrentLiabilitiesMinor: 100000, accountsPayableMinor: 100000 },
      incomeStatement: { period: '2026-Q2', revenueMinor: 1000000, costOfGoodsSoldMinor: 600000,
        operatingExpensesMinor: 100000, interestExpenseMinor: 10000, taxExpenseMinor: 40000 },
      cashFlow: { period: '2026-Q2', openingCashMinor: 1000000, operatingInflowMinor: 400000,
        operatingOutflowMinor: 500000, investingNetMinor: 0, financingNetMinor: 0,
        forecast: { status: 'not_computable', reason: 'source_statements_do_not_provide_forecast' } } } };
}
