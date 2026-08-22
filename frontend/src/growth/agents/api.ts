import type { GrowthHttpClient } from "../http";

export interface BusinessAdvisorAgentInfo {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly focus: readonly string[];
  readonly knowledgeBase: readonly {
    readonly category: string;
    readonly title: string;
  }[];
}

export interface BusinessReportInput {
  readonly currency: "CNY" | "USD";
  readonly companyName: string;
  readonly period: string;
  readonly balanceSheet: {
    readonly period: string;
    readonly cashMinor: number;
    readonly receivablesMinor: number;
    readonly inventoryMinor: number;
    readonly otherCurrentAssetsMinor: number;
    readonly nonCurrentAssetsMinor: number;
    readonly currentLiabilitiesMinor: number;
    readonly nonCurrentLiabilitiesMinor: number;
    readonly accountsPayableMinor: number;
  };
  readonly incomeStatement: {
    readonly period: string;
    readonly revenueMinor: number;
    readonly costOfGoodsSoldMinor: number;
    readonly operatingExpensesMinor: number;
    readonly interestExpenseMinor: number;
    readonly taxExpenseMinor: number;
    readonly productLines?: readonly {
      readonly name: string;
      readonly revenueMinor: number;
      readonly costOfGoodsSoldMinor: number;
      readonly afterSalesCostMinor: number;
      readonly shippingCostMinor: number;
      readonly sellingExpenseMinor: number;
      readonly allocatedOverheadMinor: number;
    }[];
    readonly customers?: readonly {
      readonly name: string;
      readonly revenueMinor: number;
      readonly grossProfitMinor: number;
      readonly serviceCostMinor: number;
      readonly paymentDays: number;
      readonly outstandingReceivableMinor: number;
    }[];
  };
  readonly cashFlow: {
    readonly period: string;
    readonly openingCashMinor: number;
    readonly operatingInflowMinor: number;
    readonly operatingOutflowMinor: number;
    readonly investingNetMinor: number;
    readonly financingNetMinor: number;
    readonly receivables?: readonly {
      readonly customer: string;
      readonly amountMinor: number;
      readonly daysOutstanding: number;
    }[];
    readonly expectedInflowsNext30DaysMinor: number;
    readonly expectedOutflowsNext30DaysMinor: number;
    readonly expectedInflowsNext31To90DaysMinor: number;
    readonly expectedOutflowsNext31To90DaysMinor: number;
  };
  readonly costDetail?: {
    readonly materialCostRateBps: number;
    readonly previousMaterialCostRateBps?: number;
    readonly laborCostMinor: number;
    readonly rawMaterialCostMinor: number;
    readonly salesCommissionRateBps: number;
    readonly fixedOverheadMinor: number;
  };
  readonly taxRisk?: {
    readonly invoiceIssues: readonly string[];
    readonly revenueRecognitionIssues: readonly string[];
    readonly costAuthenticityIssues: readonly string[];
    readonly payrollIssues: readonly string[];
    readonly equityIssues: readonly string[];
  };
}

export interface DiagnosisReport {
  readonly companyName: string;
  readonly period: string;
  readonly healthScoreBps: number;
  readonly summary: string;
  readonly issues: readonly {
    readonly category: string;
    readonly level: "red" | "yellow";
    readonly title: string;
    readonly reason: string;
    readonly risk: string;
    readonly suggestion: string;
    readonly evidence: readonly string[];
  }[];
  readonly actionPlan90Days: readonly {
    readonly month: 1 | 2 | 3;
    readonly action: string;
  }[];
  readonly evidence: readonly string[];
}

export interface StatementTable {
  readonly rows: readonly (readonly (string | number | null)[])[];
}

export interface StatementSheet extends StatementTable {
  readonly name?: string;
}

export interface ParsedStatementsResult {
  readonly companyName: string;
  readonly period: string;
  readonly warnings: readonly string[];
  readonly input: BusinessReportInput;
}

export interface ParsedCompanyResult {
  readonly companyName: string;
  readonly period: string;
  readonly warnings: readonly string[];
  readonly input?: BusinessReportInput;
  readonly report?: DiagnosisReport;
  readonly error?: string;
  readonly errorCode?: string;
}

export interface StatementImportResult {
  readonly companies: readonly ParsedCompanyResult[];
  readonly imported: number;
  readonly failed: number;
}

export interface BusinessAdvisorApi {
  getAgents(): Promise<BusinessAdvisorAgentInfo[]>;
  analyze(input: BusinessReportInput): Promise<unknown>;
  diagnose(input: BusinessReportInput): Promise<DiagnosisReport>;
  parseStatements(
    balanceSheet: StatementTable,
    incomeStatement: StatementTable
  ): Promise<ParsedStatementsResult>;
  diagnoseStatements(
    balanceSheet: StatementTable,
    incomeStatement: StatementTable
  ): Promise<ParsedStatementsResult & { readonly report: DiagnosisReport }>;
  importStatements(
    sheets: readonly StatementSheet[]
  ): Promise<StatementImportResult>;
}

export function createBusinessAdvisorApi(
  http: GrowthHttpClient
): BusinessAdvisorApi {
  const api: BusinessAdvisorApi = {
    async getAgents() {
      const response = await http.request<{ items: BusinessAdvisorAgentInfo[] }>(
        "/api/v1/business-advisor/agents"
      );
      return response.body.items ?? [];
    },
    async analyze(input) {
      const response = await http.request<{ result: unknown }>(
        "/api/v1/business-advisor/analyze",
        { method: "POST", body: input }
      );
      return response.body.result;
    },
    async diagnose(input) {
      const response = await http.request<{ report: DiagnosisReport }>(
        "/api/v1/business-advisor/diagnose",
        { method: "POST", body: input }
      );
      return response.body.report;
    },
    async parseStatements(balanceSheet, incomeStatement) {
      const response = await http.request<ParsedStatementsResult>(
        "/api/v1/business-advisor/statements/parse",
        {
          method: "POST",
          body: { balanceSheet, incomeStatement }
        }
      );
      return response.body;
    },
    async diagnoseStatements(balanceSheet, incomeStatement) {
      const response = await http.request<
        ParsedStatementsResult & { readonly report: DiagnosisReport }
      >(
        "/api/v1/business-advisor/statements/diagnose",
        {
          method: "POST",
          body: { balanceSheet, incomeStatement }
        }
      );
      return response.body;
    },
    async importStatements(sheets) {
      const response = await http.request<StatementImportResult>(
        "/api/v1/business-advisor/statements/import",
        {
          method: "POST",
          body: { sheets }
        }
      );
      return response.body;
    }
  };
  return Object.freeze(api);
}

export function yuanToMinor(yuan: number): number {
  return Math.round(yuan * 100);
}
